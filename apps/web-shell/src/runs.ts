/**
 * In-process run manager. Runs execute in a real Chrome instance; the engine
 * remains the only authority for flow semantics, and every event is persisted
 * before the UI can read it.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectSecretRefs } from '@intentbridge/protocol';
import type { Flow, Step } from '@intentbridge/action-ir';
import { WasmEngine } from '@intentbridge/engine-wasm';
import {
  launchBrowser,
  PlaywrightDriver,
  preparePage,
  type BrowserSession,
} from '@intentbridge/web-runner';
import {
  runFlow,
  type ActionLogEntry,
  type RunHooks,
  type RunResult,
} from '@intentbridge/web-core';
import type { AppDatabase } from './db.js';
import type { LocalSecretStore } from './secrets.js';

const here = dirname(fileURLToPath(import.meta.url));

export interface RunOptions {
  variables: Record<string, unknown>;
  trigger?: string;
  autoApprove?: boolean;
  pickFirst?: boolean;
  startStepId?: string;
  singleStep?: boolean;
}

export interface PendingDecision {
  kind: 'approval' | 'disambiguation' | 'outcome' | 'recovery';
  payload: unknown;
  requested_at: string;
}

interface ActiveRun {
  id: string;
  flow: Flow;
  cancelRequested: boolean;
  session?: BrowserSession;
  driver?: PlaywrightDriver;
  lastStepId?: string;
  decision?: {
    kind: PendingDecision['kind'];
    resolve: (value: unknown) => void;
    timer: NodeJS.Timeout;
    payload: unknown;
  };
}

export interface ShellSettings {
  evidence_retention_days: number;
  storage_limit_mb: number;
  headless: boolean;
  log_level: string;
  model_adapter_enabled: boolean;
}

export function defaultSettings(): ShellSettings {
  return {
    evidence_retention_days: 7,
    storage_limit_mb: 512,
    headless: true,
    log_level: 'info',
    model_adapter_enabled: false,
  };
}

export class RunManager {
  private readonly db: AppDatabase;
  private readonly secrets: LocalSecretStore;
  private readonly dataDir: string;
  private readonly wasmPath: string;
  private readonly active = new Map<string, ActiveRun>();
  private modulePromise: Promise<WebAssembly.Module> | null = null;

  constructor(options: {
    db: AppDatabase;
    secrets: LocalSecretStore;
    dataDir: string;
    wasmPath?: string;
  }) {
    this.db = options.db;
    this.secrets = options.secrets;
    this.dataDir = options.dataDir;
    this.wasmPath =
      options.wasmPath ??
      process.env.IB_WASM ??
      resolve(here, '../../../packages/engine-wasm/wasm/ib_runtime.wasm');
  }

  settings(): ShellSettings {
    const stored = this.db.getSettings();
    const defaults = defaultSettings();
    return {
      evidence_retention_days: Number(
        stored['evidence_retention_days'] ?? defaults.evidence_retention_days,
      ),
      storage_limit_mb: Number(stored['storage_limit_mb'] ?? defaults.storage_limit_mb),
      headless: Boolean(stored['headless'] ?? defaults.headless),
      log_level: String(stored['log_level'] ?? defaults.log_level),
      model_adapter_enabled: Boolean(stored['model_adapter_enabled'] ?? false),
    };
  }

  isActive(runId: string): boolean {
    return this.active.has(runId);
  }

  start(flow: Flow, options: RunOptions): string {
    if (this.active.size >= 2) {
      throw new Error('TOO_MANY_ACTIVE_RUNS');
    }
    const runId = `run-${randomUUID()}`;
    const variables = this.redactVariables(flow, options.variables ?? {});
    this.db.createRun({
      id: runId,
      flowId: flow.flow_id,
      flowRevision: flow.revision,
      trigger: options.trigger ?? 'manual',
      variables,
    });
    const state: ActiveRun = { id: runId, flow, cancelRequested: false };
    this.active.set(runId, state);
    void this.execute(state, options);
    return runId;
  }

  cancel(runId: string): boolean {
    const active = this.active.get(runId);
    if (!active) return false;
    active.cancelRequested = true;
    if (active.decision) {
      const { kind, resolve } = active.decision;
      delete active.decision;
      const value =
        kind === 'approval'
          ? false
          : kind === 'disambiguation'
            ? null
            : kind === 'outcome'
              ? 'failed'
              : 'stop';
      resolve(value);
    }
    return true;
  }

  decide(runId: string, kind: PendingDecision['kind'], value: unknown): boolean {
    const active = this.active.get(runId);
    if (!active?.decision || active.decision.kind !== kind) return false;
    const { resolve, timer } = active.decision;
    delete active.decision;
    clearTimeout(timer);
    this.db.updateRun(runId, { status: 'running', pending: null });
    resolve(value);
    return true;
  }

  private redactVariables(flow: Flow, variables: Record<string, unknown>): Record<string, unknown> {
    const sensitive = new Set(
      flow.variables.filter((item) => item.sensitive).map((item) => item.name),
    );
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(variables)) {
      output[key] = sensitive.has(key) ? '«redacted»' : value;
    }
    return output;
  }

  private waitDecision(
    active: ActiveRun,
    kind: PendingDecision['kind'],
    payload: unknown,
    timeoutMs = 10 * 60 * 1000,
  ): Promise<unknown> {
    if (active.cancelRequested) {
      return Promise.resolve(
        kind === 'approval'
          ? false
          : kind === 'outcome'
            ? 'failed'
            : kind === 'recovery'
              ? 'stop'
              : null,
      );
    }
    if (active.decision) {
      return Promise.reject(new Error('RUN_ALREADY_WAITING'));
    }
    return new Promise((resolvePromise) => {
      const timer = setTimeout(() => {
        if (active.decision?.timer === timer) {
          delete active.decision;
          this.db.updateRun(active.id, { status: 'paused', pending: null });
          resolvePromise(
            kind === 'approval'
              ? false
              : kind === 'outcome'
                ? 'failed'
                : kind === 'recovery'
                  ? 'stop'
                  : null,
          );
        }
      }, timeoutMs);
      timer.unref?.();
      active.decision = { kind, resolve: resolvePromise, timer, payload };
      const pending: PendingDecision = { kind, payload, requested_at: new Date().toISOString() };
      this.db.updateRun(active.id, { status: 'paused', pending });
      if (active.driver) void this.captureDecisionEvidence(active, active.driver);
    });
  }

  private async compiledModule(): Promise<WebAssembly.Module> {
    if (!this.modulePromise) {
      this.modulePromise = (async () => {
        const { readFile } = await import('node:fs/promises');
        return WebAssembly.compile(await readFile(this.wasmPath));
      })();
    }
    return this.modulePromise;
  }

  private async execute(active: ActiveRun, options: RunOptions): Promise<void> {
    const { id: runId, flow } = active;
    const settings = this.settings();
    const evidenceDir = join(this.dataDir, 'evidence');
    mkdirSync(evidenceDir, { recursive: true });
    let session: BrowserSession | undefined;
    let engine: WasmEngine | undefined;
    try {
      if (!existsSync(this.wasmPath)) throw new Error(`engine wasm missing at ${this.wasmPath}`);
      const secrets: Record<string, string> = {};
      for (const alias of collectSecretRefs(
        flow as unknown as import('@intentbridge/protocol').JsonValue,
      )) {
        try {
          secrets[alias] = this.secrets.get(alias);
        } catch {
          // Missing secrets surface as SECRET_NOT_FOUND at action time.
        }
      }
      session = await launchBrowser({ headless: settings.headless });
      active.session = session;
      const driver = new PlaywrightDriver(session.page, {
        appScope: flow.app_scope.value,
        evidenceDir,
        secrets,
        onEvidence: (info) =>
          this.recordEvidence(runId, info.stepId, info.path, info.sha256, info.width, info.height),
      });
      await preparePage(session.page);
      active.driver = driver;
      engine = await WasmEngine.fromModule(await this.compiledModule());
      const hooks: RunHooks = {
        approve: async (summary) => {
          if (options.autoApprove) return true;
          return (await this.waitDecision(active, 'approval', summary)) === true;
        },
        disambiguate: async (candidates, reason) => {
          if (options.pickFirst) return candidates[0]?.candidate.candidate_id ?? null;
          return (await this.waitDecision(active, 'disambiguation', {
            reason,
            candidates: candidates.slice(0, 20),
          })) as string | null;
        },
        decideOutcome: async (error) => {
          return (await this.waitDecision(active, 'outcome', error)) as
            'succeeded' | 'failed' | 'retry';
        },
        recover: async (reason, offered, error) => {
          return (await this.waitDecision(active, 'recovery', {
            reason,
            options: offered,
            error,
          })) as string;
        },
        shouldCancel: () => active.cancelRequested,
        onEvent: (event) => {
          if (event.step_id) active.lastStepId = event.step_id;
          this.db.appendEvents(runId, [
            event as unknown as { seq: number } & Record<string, unknown>,
          ]);
        },
        onPause: async (directive) => {
          this.db.updateRun(runId, { status: 'paused', pending: directive });
          await this.capturePauseEvidence(active, driver, directive);
        },
        onAction: (entry: ActionLogEntry) => {
          // Action log is stored at the end; this hook is kept for future streaming.
          void entry;
        },
      };
      const result = await runFlow({
        engine,
        driver,
        flow,
        variables: options.variables ?? {},
        hooks,
        startStepId: options.startStepId,
        singleStep: options.singleStep,
      });
      let finalResult: RunResult = result;
      if (active.cancelRequested && result.status === 'paused') {
        const cancel = engine.submit({
          kind: 'Cancel',
          now_mono_ms: Date.now(),
          reason: 'user_cancelled',
        });
        const events = (
          cancel.result as { events?: Array<{ seq: number } & Record<string, unknown>> } | undefined
        )?.events;
        if (Array.isArray(events)) this.db.appendEvents(runId, events);
        finalResult = { ...result, status: 'cancelled', state: 'CANCELLED', error: null };
      }
      await this.captureFailureEvidence(active, driver, finalResult);
      this.db.updateRun(runId, {
        status: finalResult.status === 'paused' ? 'paused' : finalResult.status,
        state: finalResult.state,
        finished_at: new Date().toISOString(),
        error: finalResult.error,
        pending: finalResult.status === 'paused' ? finalResult.pending : null,
        metrics: finalResult.metrics,
        action_log: finalResult.actionLog,
      });
    } catch (error) {
      this.db.updateRun(runId, {
        status: 'failed',
        state: 'FAILED',
        finished_at: new Date().toISOString(),
        error: { code: 'INTERNAL_ERROR', message: String((error as Error).message ?? error) },
      });
    } finally {
      try {
        await session?.close();
      } catch {
        /* ignore */
      }
      engine?.dispose();
      this.active.delete(runId);
      this.cleanupEvidence();
    }
  }

  private recordEvidence(
    runId: string,
    stepId: string,
    path: string,
    sha256: string,
    width: number,
    height: number,
  ): void {
    const settings = this.settings();
    if (this.db.evidenceBytes() > settings.storage_limit_mb * 1024 * 1024) return;
    const retention = Math.max(0, settings.evidence_retention_days);
    const expires = new Date(Date.now() + retention * 24 * 60 * 60 * 1000).toISOString();
    this.db.addEvidence({
      id: `ev-${randomUUID()}`,
      run_id: runId,
      step_id: stepId,
      path,
      sha256,
      sensitive: 0,
      width,
      height,
      created_at: new Date().toISOString(),
      expires_at: expires,
    });
  }

  private stepOf(flow: Flow, stepId: string): Step | undefined {
    return flow.steps.find((step) => step.id === stepId);
  }

  private async captureDecisionEvidence(
    active: ActiveRun,
    driver: PlaywrightDriver,
  ): Promise<void> {
    const snapshot = driver.lastSnapshot;
    if (!snapshot) return;
    const candidate = snapshot.candidates.find((item) => item.in_viewport);
    if (!candidate?.rect) return;
    const stepId = active.lastStepId ?? 'pause';
    const step = this.stepOf(active.flow, stepId);
    try {
      await driver.captureEvidence({
        stepId,
        rect: candidate.rect,
        label: 'decision',
        maskSelectors: step?.evidence_policy?.mask_selectors ?? [],
      });
    } catch {
      /* evidence failure must not fail the run */
    }
  }

  private async capturePauseEvidence(
    active: ActiveRun,
    driver: PlaywrightDriver,
    directive: Record<string, unknown>,
  ): Promise<void> {
    const snapshot = driver.lastSnapshot;
    if (!snapshot) return;
    const stepId = String(directive['step_id'] ?? 'pause');
    const candidates = directive['candidates'] as
      Array<{ candidate: { candidate_id: string } }> | undefined;
    const candidateId =
      candidates?.[0]?.candidate.candidate_id ??
      snapshot.candidates.find((candidate) => candidate.in_viewport)?.candidate_id;
    const candidate = snapshot.candidates.find((item) => item.candidate_id === candidateId);
    if (!candidate?.rect) return;
    const step = this.stepOf(active.flow, stepId);
    await driver.captureEvidence({
      stepId,
      rect: candidate.rect,
      label: 'paused',
      maskSelectors: step?.evidence_policy?.mask_selectors ?? [],
    });
  }

  private async captureFailureEvidence(
    active: ActiveRun,
    driver: PlaywrightDriver,
    result: RunResult,
  ): Promise<void> {
    if (result.status === 'succeeded') return;
    const snapshot = driver.lastSnapshot;
    if (!snapshot) return;
    const lastAction = [...result.actionLog].reverse().find((entry) => entry.candidate_id);
    const candidate = snapshot.candidates.find(
      (item) => item.candidate_id === lastAction?.candidate_id,
    );
    if (!candidate?.rect) return;
    const step = lastAction ? this.stepOf(active.flow, lastAction.step_id) : undefined;
    await driver.captureEvidence({
      stepId: lastAction?.step_id ?? 'run',
      rect: candidate.rect,
      label: 'failure',
      maskSelectors: step?.evidence_policy?.mask_selectors ?? [],
    });
  }

  cleanupEvidence(): void {
    const expired = this.db.deleteExpiredEvidence();
    for (const item of expired) {
      try {
        const resolved = resolve(item.path);
        if (resolved.startsWith(resolve(this.dataDir, 'evidence'))) {
          unlinkSync(resolved);
        }
      } catch {
        /* file already gone */
      }
    }
  }
}
