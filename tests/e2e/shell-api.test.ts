import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type AppInstance } from '@intentbridge/web-shell';
import type { Flow } from '@intentbridge/action-ir';

const ROOT = resolve(__dirname, '../..');
const golden = JSON.parse(
  readFileSync(resolve(ROOT, 'fixtures/flows/web-basic.flow.json'), 'utf8'),
) as Flow;

let app: AppInstance;
let dataDir: string;

async function call(
  method: string,
  path: string,
  body?: unknown,
  token = app.token,
): Promise<Response> {
  return fetch(`http://127.0.0.1:${app.port}${path}`, {
    method,
    headers: {
      ...(token ? { 'x-ib-token': token } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'ib-shell-test-'));
  app = await createApp({ dataDir, port: 0, token: 'test-token-0123456789' });
});

afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('shell API contract', () => {
  it('rejects requests without the session token', async () => {
    const response = await fetch(`http://127.0.0.1:${app.port}/api/flows`);
    expect(response.status).toBe(401);
  });

  it('reports health without a token', async () => {
    const response = await fetch(`http://127.0.0.1:${app.port}/api/health`);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { ok: boolean }).ok).toBe(true);
  });

  it('imports, versions and exports a validated flow', async () => {
    const imported = await call('POST', '/api/flows/import', { document: golden });
    expect(imported.status).toBe(201);

    const list = (await (await call('GET', '/api/flows')).json()) as {
      flows: Array<{ id: string }>;
    };
    expect(list.flows.map((flow) => flow.id)).toEqual([golden.flow_id]);

    const loaded = (await (await call('GET', `/api/flows/${golden.flow_id}`)).json()) as {
      flow: Flow;
      revision: number;
      signature_status: string;
    };
    expect(loaded.revision).toBe(1);
    expect(loaded.signature_status).toBe('unsigned');
    expect(loaded.flow.steps).toHaveLength(6);

    const broken = JSON.parse(JSON.stringify(golden)) as Flow;
    delete (broken.steps[2] as { postconditions?: unknown }).postconditions;
    const invalid = await call('PUT', `/api/flows/${golden.flow_id}`, { flow: broken });
    expect(invalid.status).toBe(422);
    const invalidBody = (await invalid.json()) as { detail: { errors: Array<{ rule: string }> } };
    expect(
      invalidBody.detail.errors.some((error) => error.rule === 'step.missing-postcondition'),
    ).toBe(true);

    const renamed = { ...golden, name: '重命名流程', updated_at: new Date().toISOString() };
    const saved = await call('PUT', `/api/flows/${golden.flow_id}`, { flow: renamed });
    expect(saved.status).toBe(200);
    const savedBody = (await saved.json()) as { revision: number };
    expect(savedBody.revision).toBe(2);

    const revisions = (await (
      await call('GET', `/api/flows/${golden.flow_id}/revisions`)
    ).json()) as {
      revisions: Array<{ revision: number }>;
    };
    expect(revisions.revisions.map((item) => item.revision)).toEqual([2, 1]);

    const exportResponse = await call('GET', `/api/flows/${golden.flow_id}/export`);
    expect(exportResponse.status).toBe(200);
    expect(((await exportResponse.json()) as Flow).name).toBe('重命名流程');

    const duplicate = await call('POST', `/api/flows/${golden.flow_id}/duplicate`);
    expect(duplicate.status).toBe(201);
    const duplicateBody = (await duplicate.json()) as { flow: Flow };
    expect(duplicateBody.flow.flow_id).not.toBe(golden.flow_id);
    const total = (await (await call('GET', '/api/flows')).json()) as { flows: unknown[] };
    expect(total.flows).toHaveLength(2);
  });

  it('encrypts exports and refuses wrong passphrases', async () => {
    const exported = await call('POST', `/api/flows/${golden.flow_id}/export/encrypted`, {
      passphrase: 'correct horse battery',
    });
    expect(exported.status).toBe(200);
    const pkg = (await exported.json()) as Record<string, unknown>;
    expect(pkg.format).toBe('intentbridge.flow');
    expect(JSON.stringify(pkg)).not.toContain('重命名流程');

    const wrong = await call('POST', '/api/flows/import', {
      document: pkg,
      passphrase: 'wrong passphrase',
    });
    expect(wrong.status).toBe(422);

    const right = await call('POST', '/api/flows/import', {
      document: pkg,
      passphrase: 'correct horse battery',
      new_id: true,
    });
    expect(right.status).toBe(201);
    const rightBody = (await right.json()) as { flow: Flow };
    expect(rightBody.flow.name).toBe('重命名流程');
    expect(rightBody.flow.flow_id).not.toBe(golden.flow_id);
  });

  it('stores secrets encrypted and only exposes aliases', async () => {
    const stored = await call('PUT', '/api/secrets/bank-pin', { value: 'super-secret-value' });
    expect(stored.status).toBe(200);
    const list = (await (await call('GET', '/api/secrets')).json()) as {
      aliases: Array<{ alias: string }>;
    };
    expect(list.aliases.map((item) => item.alias)).toEqual(['bank-pin']);
    const diagnostics = await (await call('GET', '/api/diagnostics')).text();
    expect(diagnostics).not.toContain('super-secret-value');
    expect(diagnostics).toContain('bank-pin');
    const storedDb = app.db.getSecret('bank-pin');
    expect(storedDb?.cipher).toBeTruthy();
    expect(JSON.stringify(storedDb)).not.toContain('super-secret-value');
    const invalid = await call('PUT', '/api/secrets/Bad Alias', { value: 'x' });
    expect(invalid.status).toBe(422);
    expect((await call('DELETE', '/api/secrets/bank-pin')).status).toBe(200);
  });

  it('validates settings and keeps model adapters disabled', async () => {
    const updated = await call('PUT', '/api/settings', {
      evidence_retention_days: 3,
      storage_limit_mb: 128,
      headless: true,
      log_level: 'warn',
    });
    expect(updated.status).toBe(200);
    const settings = (await (await call('GET', '/api/settings')).json()) as {
      settings: { evidence_retention_days: number; log_level: string };
    };
    expect(settings.settings.evidence_retention_days).toBe(3);
    expect(settings.settings.log_level).toBe('warn');
    expect((await call('PUT', '/api/settings', { evidence_retention_days: 9999 })).status).toBe(
      422,
    );
    expect((await call('PUT', '/api/settings', { model_adapter_enabled: true })).status).toBe(422);
  });

  it('refuses evidence paths outside the data directory', async () => {
    app.db.addEvidence({
      id: 'ev-trap',
      run_id: 'run-x',
      step_id: 'step-1',
      path: '/etc/passwd',
      sha256: '0'.repeat(64),
      sensitive: 0,
      width: null,
      height: null,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    const response = await call('GET', '/api/evidence/ev-trap');
    expect(response.status).toBe(403);
  });

  it('records sessions and refuses to finalize an empty recording', async () => {
    const created = (await (await call('POST', '/api/recordings', {})).json()) as { id: string };
    const events = await call('POST', `/api/recordings/${created.id}/events`, { events: [] });
    expect(events.status).toBe(200);
    const finish = await call('POST', `/api/recordings/${created.id}/finish`, { name: 'empty' });
    expect(finish.status).toBe(422);
  });

  it('backs up the database and reports storage stats', async () => {
    const backup = (await (await call('POST', '/api/maintenance/backup', {})).json()) as {
      path: string;
    };
    expect(existsSync(backup.path)).toBe(true);
    const stats = (await (await call('GET', '/api/stats')).json()) as Record<string, unknown>;
    expect(stats['schema_version']).toBe(1);
    expect(stats['flows']).toBeGreaterThan(0);
  });

  it('requires execution-level validation before starting a run', async () => {
    const huge = JSON.parse(JSON.stringify(golden)) as Flow;
    huge.flow_id = '44444444-4444-4444-8444-444444444444';
    huge.steps = Array.from({ length: 1000 }, (_, index) => ({
      id: `step-${index}`,
      action: 'wait' as const,
      params: { condition: { kind: 'window-stable', min_stable_ms: 10 } },
    }));
    huge.steps.push({ id: 'done', action: 'end', params: { status: 'success' } });
    // 1001 steps exceeds the 1000-step schema cap: use 999 + end = 1000.
    huge.steps = huge.steps.slice(1);
    const imported = await call('POST', '/api/flows/import', { document: huge, new_id: true });
    expect(imported.status).toBe(201);
    const flowId = ((await imported.json()) as { flow: Flow }).flow.flow_id;
    const run = await call('POST', `/api/flows/${flowId}/runs`, { variables: {} });
    expect(run.status).toBe(422);
  });
});
