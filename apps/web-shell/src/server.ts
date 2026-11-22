/**
 * IntentBridge local management service.
 *
 * Loopback only, one-time session token, strict CSP, no external network calls.
 * All flow semantics come from the Rust engine; this server stores, validates
 * and orchestrates but never "simulates success".
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqualString, redact } from '@intentbridge/protocol';
import {
  canonicalJson,
  hashJson,
  loadFlow,
  validateFlow,
  validateFlowForExecution,
  type Flow,
  type ValidationResult,
} from '@intentbridge/action-ir';
import { buildFlowFromRecording, type Recording } from '@intentbridge/web-core';
import { assertLoopback, createSessionToken } from '@intentbridge/protocol';
import { AppDatabase } from './db.js';
import { LocalSecretStore } from './secrets.js';
import { RunManager, defaultSettings, type ShellSettings } from './runs.js';
import { decryptFlowPackage, encryptFlowPackage, isEncryptedPackage } from './package.js';

const here = dirname(fileURLToPath(import.meta.url));

export interface AppOptions {
  dataDir?: string;
  port?: number;
  token?: string;
  host?: string;
  /** Static UI directory; defaults to the built shell. */
  uiDir?: string;
}

export interface AppInstance {
  server: Server;
  port: number;
  token: string;
  url: string;
  db: AppDatabase;
  secrets: LocalSecretStore;
  runs: RunManager;
  close: () => Promise<void>;
}

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail?: unknown;

  constructor(status: number, code: string, message: string, detail?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

function json(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

function text(
  res: ServerResponse,
  status: number,
  value: string,
  contentType = 'text/plain; charset=utf-8',
): void {
  res.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(value);
}

async function readBody(req: IncomingMessage, limit = 2 * 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, 'BODY_TOO_LARGE', 'request body is too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'request body must be JSON');
  }
}

function validateSettings(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  if (input['evidence_retention_days'] !== undefined) {
    const value = Number(input['evidence_retention_days']);
    if (!Number.isInteger(value) || value < 0 || value > 365) {
      throw new HttpError(422, 'INVALID_SETTING', 'evidence_retention_days must be 0..365');
    }
    output['evidence_retention_days'] = value;
  }
  if (input['storage_limit_mb'] !== undefined) {
    const value = Number(input['storage_limit_mb']);
    if (!Number.isFinite(value) || value < 32 || value > 4096) {
      throw new HttpError(422, 'INVALID_SETTING', 'storage_limit_mb must be 32..4096');
    }
    output['storage_limit_mb'] = value;
  }
  if (input['headless'] !== undefined) output['headless'] = Boolean(input['headless']);
  if (input['log_level'] !== undefined) {
    if (!['debug', 'info', 'warn', 'error'].includes(String(input['log_level']))) {
      throw new HttpError(422, 'INVALID_SETTING', 'invalid log_level');
    }
    output['log_level'] = String(input['log_level']);
  }
  if (input['model_adapter_enabled'] !== undefined) {
    if (Boolean(input['model_adapter_enabled'])) {
      throw new HttpError(
        422,
        'MODEL_ADAPTER_DISABLED',
        'model adapters are not part of v1 and cannot be enabled',
      );
    }
    output['model_adapter_enabled'] = false;
  }
  return output;
}

function validationPayload(result: ValidationResult): unknown {
  return {
    ok: result.ok,
    errors: result.errors,
    warnings: result.warnings,
  };
}

export async function createApp(options: AppOptions = {}): Promise<AppInstance> {
  const dataDir = resolve(options.dataDir ?? process.env.IB_DATA_DIR ?? '.data');
  const host = options.host ?? '127.0.0.1';
  assertLoopback(host);
  const db = AppDatabase.open(dataDir);
  const secrets = new LocalSecretStore(dataDir, db);
  const runs = new RunManager({ db, secrets, dataDir });
  runs.cleanupEvidence();
  const token = options.token ?? createSessionToken();
  const uiDir = options.uiDir ?? resolve(here, '..', 'dist');

  const authorize = (req: IncomingMessage, url: URL): boolean => {
    const header = req.headers['x-ib-token'];
    const provided =
      (Array.isArray(header) ? header[0] : header) ?? url.searchParams.get('token') ?? '';
    return (
      typeof provided === 'string' && provided.length > 0 && timingSafeEqualString(provided, token)
    );
  };

  const rejectCrossSite = (req: IncomingMessage, port: number): void => {
    const origin = req.headers.origin;
    if (typeof origin === 'string' && origin.length > 0) {
      const allowed = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
      if (!allowed.has(origin))
        throw new HttpError(403, 'IPC_UNAUTHORIZED', 'cross-origin request rejected');
    }
    const site = req.headers['sec-fetch-site'];
    if (typeof site === 'string' && site === 'cross-site') {
      throw new HttpError(403, 'IPC_UNAUTHORIZED', 'cross-site request rejected');
    }
  };

  const currentFlow = (flowId: string) => {
    const record = db.getFlow(flowId);
    if (!record) throw new HttpError(404, 'FLOW_NOT_FOUND', 'flow not found');
    return record;
  };

  const importFlow = (document: unknown, passphrase?: string, forceNewId = false): Flow => {
    let flowDocument = document;
    if (isEncryptedPackage(flowDocument)) {
      if (!passphrase)
        throw new HttpError(422, 'PASSPHRASE_REQUIRED', 'encrypted package needs a passphrase');
      try {
        flowDocument = decryptFlowPackage(flowDocument, passphrase);
      } catch {
        throw new HttpError(422, 'DECRYPT_FAILED', 'package could not be decrypted');
      }
    }
    const loaded = loadFlow(flowDocument);
    if (!loaded.flow) {
      throw new HttpError(422, 'INVALID_IR', 'flow validation failed', {
        diagnostics: loaded.report.diagnostics,
        applied_migrations: loaded.report.applied,
      });
    }
    let flow = loaded.flow;
    if (forceNewId) {
      flow = { ...flow, flow_id: randomUUID(), revision: 1, updated_at: new Date().toISOString() };
      flow.created_at = flow.created_at ?? new Date().toISOString();
    }
    const existing = db.getFlow(flow.flow_id);
    if (existing) throw new HttpError(409, 'FLOW_EXISTS', 'a flow with this id already exists');
    const hash = hashJson(flow);
    db.createFlow(flow, hash, flow.created_by);
    return flow;
  };

  const api = async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    port: number,
  ): Promise<boolean> => {
    if (!url.pathname.startsWith('/api/')) return false;
    if (url.pathname === '/api/health') {
      json(res, 200, {
        ok: true,
        service: 'intentbridge-shell',
        version: '0.1.0',
        schema_version: 1,
        now: new Date().toISOString(),
      });
      return true;
    }
    rejectCrossSite(req, port);
    if (!authorize(req, url)) {
      throw new HttpError(401, 'IPC_UNAUTHORIZED', 'missing or invalid session token');
    }
    const method = req.method ?? 'GET';
    const segments = url.pathname.split('/').filter(Boolean);

    // ------------------------------------------------------------- flows
    if (segments[1] === 'flows' && segments.length === 2 && method === 'GET') {
      json(res, 200, { flows: db.listFlows() });
      return true;
    }
    if (segments[1] === 'flows' && segments[2] === 'import' && method === 'POST') {
      const body = (await readBody(req)) as {
        document?: unknown;
        passphrase?: string;
        new_id?: boolean;
      };
      if (!body.document) throw new HttpError(400, 'INVALID_BODY', 'document is required');
      const flow = importFlow(body.document, body.passphrase, body.new_id === true);
      json(res, 201, { flow, revision: 1, hash: hashJson(flow) });
      return true;
    }
    if (segments[1] === 'flows' && segments.length === 2 && method === 'POST') {
      const body = (await readBody(req)) as { document?: unknown; passphrase?: string };
      if (!body.document) throw new HttpError(400, 'INVALID_BODY', 'document is required');
      const flow = importFlow(body.document, body.passphrase, false);
      json(res, 201, { flow, revision: 1, hash: hashJson(flow) });
      return true;
    }
    if (segments[1] === 'flows' && segments.length === 3) {
      const flowId = segments[2] as string;
      if (method === 'GET') {
        const record = currentFlow(flowId);
        json(res, 200, {
          flow: record.flow,
          revision: record.revision,
          hash: record.hash,
          created_at: record.created_at,
          created_by: record.created_by,
          signature: record.signature,
          signature_status: record.signature ? 'signed' : 'unsigned',
        });
        return true;
      }
      if (method === 'PUT') {
        const body = (await readBody(req)) as { flow?: Flow; created_by?: string };
        if (!body.flow || typeof body.flow !== 'object')
          throw new HttpError(400, 'INVALID_BODY', 'flow is required');
        if (body.flow.flow_id !== flowId)
          throw new HttpError(409, 'FLOW_ID_MISMATCH', 'flow_id mismatch');
        const validation = validateFlow(body.flow);
        if (!validation.ok)
          throw new HttpError(
            422,
            'INVALID_IR',
            'flow validation failed',
            validationPayload(validation),
          );
        const hash = hashJson(body.flow);
        const revision = db.saveFlow(
          { ...body.flow, updated_at: new Date().toISOString() },
          hash,
          body.created_by ?? 'shell',
        );
        json(res, 200, { revision, hash, warnings: validation.warnings });
        return true;
      }
      if (method === 'DELETE') {
        currentFlow(flowId);
        db.archiveFlow(flowId);
        json(res, 200, { archived: true });
        return true;
      }
    }
    if (segments[1] === 'flows' && segments[3] === 'revisions' && method === 'GET') {
      const flowId = segments[2] as string;
      if (segments.length === 5) {
        const revision = Number(segments[4]);
        const record = db.getRevision(flowId, revision);
        if (!record) throw new HttpError(404, 'REVISION_NOT_FOUND', 'revision not found');
        json(res, 200, record);
      } else {
        currentFlow(flowId);
        json(res, 200, { revisions: db.listRevisions(flowId) });
      }
      return true;
    }
    if (segments[1] === 'flows' && segments[3] === 'duplicate' && method === 'POST') {
      const record = currentFlow(segments[2] as string);
      const duplicate: Flow = {
        ...record.flow,
        flow_id: randomUUID(),
        name: `${record.flow.name} (副本)`,
        revision: 1,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      db.createFlow(duplicate, hashJson(duplicate), 'shell');
      json(res, 201, { flow: duplicate, revision: 1 });
      return true;
    }
    if (segments[1] === 'flows' && segments[3] === 'export' && method === 'GET') {
      const record = currentFlow(segments[2] as string);
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="${record.flow.flow_id}.json"`,
        'cache-control': 'no-store',
      });
      res.end(JSON.stringify(record.flow, null, 2));
      return true;
    }
    if (
      segments[1] === 'flows' &&
      segments[3] === 'export' &&
      segments[4] === 'encrypted' &&
      method === 'POST'
    ) {
      const record = currentFlow(segments[2] as string);
      const body = (await readBody(req)) as { passphrase?: string };
      if (typeof body.passphrase !== 'string' || body.passphrase.length < 8) {
        throw new HttpError(
          422,
          'PASSPHRASE_TOO_SHORT',
          'passphrase must be at least 8 characters',
        );
      }
      const pkg = encryptFlowPackage(record.flow, body.passphrase);
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="${record.flow.flow_id}.ibflow"`,
        'cache-control': 'no-store',
      });
      res.end(JSON.stringify(pkg, null, 2));
      return true;
    }
    if (segments[1] === 'flows' && segments[3] === 'runs') {
      const flowId = segments[2] as string;
      const record = currentFlow(flowId);
      if (method === 'GET') {
        json(res, 200, { runs: db.listRuns(flowId) });
        return true;
      }
      if (method === 'POST') {
        const body = (await readBody(req)) as {
          variables?: Record<string, unknown>;
          trigger?: string;
          auto_approve?: boolean;
          pick?: 'first' | 'none';
          start_step_id?: string;
          single_step?: boolean;
        };
        const execution = validateFlowForExecution(record.flow);
        if (!execution.ok) {
          throw new HttpError(
            422,
            'INVALID_IR',
            'flow is not runnable',
            validationPayload(execution),
          );
        }
        let runId: string;
        try {
          runId = runs.start(record.flow, {
            variables: body.variables ?? {},
            trigger: body.trigger ?? 'manual',
            autoApprove: body.auto_approve === true,
            pickFirst: body.pick === 'first',
            ...(body.start_step_id ? { startStepId: body.start_step_id } : {}),
            singleStep: body.single_step === true,
          });
        } catch (error) {
          if (String((error as Error).message).includes('TOO_MANY_ACTIVE_RUNS')) {
            throw new HttpError(
              429,
              'TOO_MANY_ACTIVE_RUNS',
              '最多同时运行 2 个流程，请等待或取消其中一个',
            );
          }
          throw error;
        }
        json(res, 202, { run_id: runId, flow_id: flowId, revision: record.revision });
        return true;
      }
    }
    // -------------------------------------------------------------- runs
    if (segments[1] === 'runs' && segments.length === 2 && method === 'GET') {
      json(res, 200, { runs: db.listRuns() });
      return true;
    }
    if (segments[1] === 'runs' && segments.length === 3 && method === 'GET') {
      const runId = segments[2] as string;
      const run = db.getRun(runId);
      if (!run) throw new HttpError(404, 'RUN_NOT_FOUND', 'run not found');
      const after = Number(url.searchParams.get('after') ?? 0);
      json(res, 200, {
        run,
        events: db.listEvents(runId, Number.isFinite(after) ? after : 0, 2000),
        evidence: db.listEvidence(runId),
        active: runs.isActive(runId),
      });
      return true;
    }
    if (segments[1] === 'runs' && segments[3] === 'decision' && method === 'POST') {
      const runId = segments[2] as string;
      const body = (await readBody(req)) as { kind?: string; value?: unknown };
      if (!body.kind) throw new HttpError(400, 'INVALID_BODY', 'kind is required');
      const applied = runs.decide(runId, body.kind as never, body.value);
      json(res, applied ? 200 : 409, { applied });
      return true;
    }
    if (segments[1] === 'runs' && segments[3] === 'cancel' && method === 'POST') {
      const runId = segments[2] as string;
      const applied = runs.cancel(runId);
      json(res, applied ? 200 : 409, { cancelled: applied });
      return true;
    }
    if (segments[1] === 'runs' && segments[3] === 'evidence' && method === 'GET') {
      const runId = segments[2] as string;
      json(res, 200, { evidence: db.listEvidence(runId) });
      return true;
    }
    if (segments[1] === 'runs' && segments[3] === 'diagnostics' && method === 'GET') {
      const runId = segments[2] as string;
      const run = db.getRun(runId);
      if (!run) throw new HttpError(404, 'RUN_NOT_FOUND', 'run not found');
      const flowRecord = db.getFlow(run.flow_id);
      const bundle = redact(
        {
          generated_at: new Date().toISOString(),
          service: { name: 'intentbridge-shell', version: '0.1.0', schema_version: 1 },
          run,
          flow: flowRecord?.flow ?? null,
          events: db.listEvents(runId, 0, 5000),
          evidence: db.listEvidence(runId).map((item) => ({ ...item, path: '«local file»' })),
          settings: { ...runs.settings() },
          aliases: secrets.list().map((item) => item.alias),
        } as unknown as import('@intentbridge/protocol').JsonValue,
        { extraKeys: ['variables', 'password', 'token', 'secret', 'value'] },
      ) as Record<string, unknown>;
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="diagnostics-${runId}.json"`,
        'cache-control': 'no-store',
      });
      res.end(JSON.stringify(bundle, null, 2));
      return true;
    }
    // ---------------------------------------------------------- evidence
    if (segments[1] === 'evidence' && segments.length === 3 && method === 'GET') {
      const record = db.getEvidence(segments[2] as string);
      if (!record) throw new HttpError(404, 'EVIDENCE_NOT_FOUND', 'evidence not found');
      const evidenceRoot = resolve(dataDir, 'evidence');
      const filePath = resolve(record.path);
      if (!filePath.startsWith(evidenceRoot + '/')) {
        throw new HttpError(403, 'FORBIDDEN', 'evidence path escapes the data directory');
      }
      if (!existsSync(filePath))
        throw new HttpError(404, 'EVIDENCE_NOT_FOUND', 'evidence file is gone');
      res.writeHead(200, {
        'content-type': 'image/png',
        'content-length': statSync(filePath).size,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      createReadStream(filePath).pipe(res);
      return true;
    }
    // ---------------------------------------------------------- settings
    if (segments[1] === 'settings' && segments.length === 2) {
      if (method === 'GET') {
        json(res, 200, {
          settings: runs.settings(),
          defaults: defaultSettings(),
          data_dir: dataDir,
        });
        return true;
      }
      if (method === 'PUT') {
        const body = (await readBody(req)) as Record<string, unknown>;
        const values = validateSettings(body);
        for (const [key, value] of Object.entries(values)) db.setSetting(key, value);
        json(res, 200, { settings: runs.settings() });
        return true;
      }
    }
    // ----------------------------------------------------------- secrets
    if (segments[1] === 'secrets') {
      if (segments.length === 2 && method === 'GET') {
        json(res, 200, { aliases: secrets.list() });
        return true;
      }
      if (segments.length === 3 && method === 'PUT') {
        const alias = segments[2] as string;
        const body = (await readBody(req)) as { value?: string };
        if (typeof body.value !== 'string')
          throw new HttpError(400, 'INVALID_BODY', 'value is required');
        try {
          secrets.set(alias, body.value);
        } catch (error) {
          throw new HttpError(422, 'INVALID_ALIAS', String((error as Error).message));
        }
        json(res, 200, { alias, stored: true });
        return true;
      }
      if (segments.length === 3 && method === 'DELETE') {
        json(res, 200, { deleted: secrets.delete(segments[2] as string) });
        return true;
      }
    }
    // -------------------------------------------------------- recordings
    if (segments[1] === 'recordings') {
      if (segments.length === 2 && method === 'GET') {
        json(res, 200, { recordings: db.listRecordings() });
        return true;
      }
      if (segments.length === 2 && method === 'POST') {
        const id = `rec-${randomUUID()}`;
        db.createRecording(id);
        json(res, 201, { id, status: 'recording' });
        return true;
      }
      if (segments.length === 3 && method === 'GET') {
        const recording = db.getRecording(segments[2] as string);
        if (!recording) throw new HttpError(404, 'RECORDING_NOT_FOUND', 'recording not found');
        json(res, 200, recording);
        return true;
      }
      if (segments.length === 4 && segments[3] === 'events' && method === 'POST') {
        const body = (await readBody(req)) as { events?: unknown[] };
        if (!Array.isArray(body.events))
          throw new HttpError(400, 'INVALID_BODY', 'events must be an array');
        db.appendRecordingEvents(segments[2] as string, body.events.slice(0, 500));
        json(res, 200, { appended: body.events.length });
        return true;
      }
      if (segments.length === 4 && segments[3] === 'finish' && method === 'POST') {
        const recordingId = segments[2] as string;
        const recording = db.getRecording(recordingId);
        if (!recording) throw new HttpError(404, 'RECORDING_NOT_FOUND', 'recording not found');
        const body = (await readBody(req)) as { name?: string };
        let built: ReturnType<typeof buildFlowFromRecording>;
        try {
          built = buildFlowFromRecording(
            {
              events: recording.events as Recording['events'],
              warnings: recording.warnings,
              started_at: Date.parse(recording.started_at),
              stopped_at: recording.finished_at ? Date.parse(recording.finished_at) : Date.now(),
            },
            { name: body.name ?? '录制的 Web 流程' },
          );
        } catch (error) {
          throw new HttpError(422, 'EMPTY_RECORDING', String((error as Error).message));
        }
        const validation = validateFlowForExecution(built.flow);
        if (!validation.ok) {
          throw new HttpError(
            422,
            'INVALID_IR',
            'recorded flow failed validation',
            validationPayload(validation),
          );
        }
        const exists = db.getFlow(built.flow.flow_id);
        const flow = exists ? { ...built.flow, flow_id: randomUUID() } : built.flow;
        db.createFlow(flow, hashJson(flow), 'web-recorder');
        db.finishRecording(recordingId, flow.flow_id, built.warnings, recording.events);
        json(res, 201, {
          flow,
          warnings: built.warnings,
          validation: validationPayload(validation),
        });
        return true;
      }
      if (segments.length === 4 && segments[3] === 'cancel' && method === 'POST') {
        const recording = db.getRecording(segments[2] as string);
        if (!recording) throw new HttpError(404, 'RECORDING_NOT_FOUND', 'recording not found');
        db.finishRecording(
          recording.id,
          null,
          recording.warnings.concat('cancelled by user'),
          recording.events,
        );
        json(res, 200, { cancelled: true });
        return true;
      }
    }
    if (segments[1] === 'stats' && method === 'GET') {
      json(res, 200, db.stats());
      return true;
    }
    if (segments[1] === 'maintenance' && segments[2] === 'cleanup' && method === 'POST') {
      runs.cleanupEvidence();
      json(res, 200, { ok: true, stats: db.stats() });
      return true;
    }
    if (segments[1] === 'maintenance' && segments[2] === 'backup' && method === 'POST') {
      const path = db.backup('manual');
      json(res, 200, { path });
      return true;
    }
    if (segments[1] === 'diagnostics' && method === 'GET') {
      const bundle = redact(
        {
          generated_at: new Date().toISOString(),
          stats: db.stats(),
          settings: runs.settings(),
          flows: db.listFlows(),
          runs: db.listRuns().slice(0, 50),
          aliases: secrets.list().map((item) => item.alias),
        } as unknown as import('@intentbridge/protocol').JsonValue,
        { extraKeys: ['variables', 'password', 'token', 'secret', 'value'] },
      );
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': 'attachment; filename="intentbridge-diagnostics.json"',
        'cache-control': 'no-store',
      });
      res.end(JSON.stringify(bundle, null, 2));
      return true;
    }
    throw new HttpError(404, 'NOT_FOUND', 'unknown API endpoint');
  };

  const staticFile = async (res: ServerResponse, pathname: string): Promise<boolean> => {
    const normalized = pathname === '/' ? '/index.html' : pathname;
    if (!/^\/(index\.html|ui\.js|ui\.css|favicon\.ico)$/.test(normalized)) return false;
    const filePath = join(uiDir, normalized);
    if (!filePath.startsWith(resolve(uiDir))) return false;
    if (!existsSync(filePath)) {
      if (normalized === '/index.html') {
        text(
          res,
          503,
          'IntentBridge UI has not been built. Run: pnpm --filter @intentbridge/web-shell build',
        );
        return true;
      }
      return false;
    }
    const types: Record<string, string> = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.ico': 'image/x-icon',
    };
    const headers: Record<string, string> = {
      'content-type': types[extname(filePath)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy':
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    };
    res.writeHead(200, headers);
    createReadStream(filePath).pipe(res);
    return true;
  };

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      const port = (server.address() as { port?: number } | null)?.port ?? 0;
      try {
        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }
        if (await api(req, res, url, port)) return;
        if (req.method === 'GET' && (await staticFile(res, url.pathname))) return;
        throw new HttpError(404, 'NOT_FOUND', 'not found');
      } catch (error) {
        if (res.headersSent) {
          res.end();
          return;
        }
        if (error instanceof HttpError) {
          json(res, error.status, {
            error: { code: error.code, message: error.message },
            ...(error.detail !== undefined ? { detail: error.detail } : {}),
          });
        } else {
          json(res, 500, {
            error: {
              code: 'INTERNAL_ERROR',
              message: String((error as Error).message ?? error),
            },
          });
        }
      }
    })();
  });

  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? Number(process.env.IB_SHELL_PORT ?? 4319), host, () =>
      resolvePromise(),
    );
  });
  const address = server.address() as { port: number };
  const url = `http://${host}:${address.port}/?token=${encodeURIComponent(token)}`;

  return {
    server,
    port: address.port,
    token,
    url,
    db,
    secrets,
    runs,
    close: async () => {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
      db.close();
    },
  };
}

export function currentSchemaFingerprint(): string {
  return hashJson({ service: 'intentbridge-shell', version: 1 });
}
