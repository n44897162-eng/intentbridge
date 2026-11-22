/**
 * Platform-neutral host loop. The Rust/WASM engine owns all flow semantics;
 * this loop only resolves targets, performs browser actions and reports facts.
 */
import {
  mapPlatformError,
  type BridgeError,
  type ObservedFacts,
  type RankedCandidate,
  type RunEvent,
  type Directive,
} from '@intentbridge/protocol/browser';
import type { Flow, StepAction, Target } from '@intentbridge/action-ir';
import type { WasmEngine } from '@intentbridge/engine-wasm';
import type { SnapshotResult } from './dom-snapshot.js';

export interface DriverFacts {
  url: string;
  origin: string;
  title: string;
  window_stable_ms: number;
}

export interface ActionRequest {
  step_id: string;
  attempt_id: string;
  action: StepAction;
  candidate_id: string | null;
  frame_path: string[];
  selector: string | null;
  params: Record<string, unknown>;
  target: Target | null;
  risk: string;
  idempotency_key: string | null;
  app_scope?: string;
}

export interface DriverActResult {
  text?: string;
  error?: { code?: string; message?: string };
}

export interface BrowserDriver {
  /** Monotonic milliseconds. Must never move backwards. */
  now(): number;
  wallTime(): number;
  snapshot(): Promise<SnapshotResult>;
  facts(): Promise<DriverFacts>;
  act(request: ActionRequest): Promise<DriverActResult>;
  /** Adds dHash/fingerprint evidence to candidates before ranking. */
  enrichVisuals?(snapshot: SnapshotResult, target: Target | null): Promise<void>;
  sleep(ms: number): Promise<void>;
  secret?(alias: string): Promise<string>;
}

export interface RunHooks {
  approve?: (summary: unknown) => Promise<boolean> | boolean;
  beforeApproval?: (summary: unknown) => Promise<void> | void;
  disambiguate?: (
    candidates: RankedCandidate[],
    reason: string,
  ) => Promise<string | null> | string | null;
  decideOutcome?: (
    error: BridgeError,
  ) => Promise<'succeeded' | 'failed' | 'retry'> | 'succeeded' | 'failed' | 'retry';
  recover?: (
    reason: string,
    options: string[],
    error: BridgeError | null,
  ) => Promise<string> | string;
  onEvent?: (event: RunEvent) => void;
  onPause?: (directive: Record<string, unknown>) => Promise<void> | void;
  /** Polled at safe points; a true value submits Cancel to the engine. */
  shouldCancel?: () => boolean;
  onAction?: (entry: ActionLogEntry) => void;
}

export interface ActionLogEntry {
  step_id: string;
  attempt_id: string;
  action: string;
  candidate_id: string | null;
  started_at: number;
  duration_ms: number;
  ok: boolean;
  error_code: string | null;
  candidate_test_id: string | null;
  candidate_name: string | null;
  params_preview: unknown;
}

export interface RunResult {
  state: string;
  status: 'succeeded' | 'failed' | 'cancelled' | 'outcome_unknown' | 'paused';
  error: BridgeError | null;
  events: RunEvent[];
  actionLog: ActionLogEntry[];
  pending: Record<string, unknown> | null;
  metrics: { planner_samples_ms: number[]; planner_p95_ms: number; total_elapsed_ms: number };
  diagnostics?: unknown;
}

function bridgeError(error: unknown, fallbackCode: BridgeError['code']): BridgeError {
  const raw = (error ?? {}) as {
    code?: string;
    message?: string;
    detail?: BridgeError['detail'];
    platform_detail?: string;
    retryable?: boolean;
  };
  return {
    code: (raw.code ?? fallbackCode) as BridgeError['code'],
    message: raw.message ?? 'engine error',
    ...(raw.detail ? { detail: raw.detail } : {}),
    ...(raw.platform_detail ? { platform_detail: raw.platform_detail } : {}),
    ...(raw.retryable !== undefined ? { retryable: raw.retryable } : {}),
  };
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(ratio * sorted.length) - 1));
  return sorted[index] as number;
}

const SECRET_REF = /^secret:\/\/[a-z][a-z0-9._-]{0,63}$/;

function stripFramePath<T extends { frame_path?: unknown }>(candidate: T): Omit<T, 'frame_path'> {
  const { frame_path: _ignored, ...rest } = candidate;
  return rest;
}

function candidatesForEngine(snapshot: SnapshotResult): unknown[] {
  return snapshot.candidates.map((candidate) => stripFramePath(candidate));
}

function factsForEngine(snapshot: SnapshotResult, now: number): ObservedFacts {
  return {
    now_mono_ms: now,
    app_scope: snapshot.origin,
    url: snapshot.url,
    window_title: snapshot.title,
    window_stable_ms: snapshot.window_stable_ms,
    elements: candidatesForEngine(snapshot) as ObservedFacts['elements'],
  };
}

async function resolveSecrets(
  value: unknown,
  driver: BrowserDriver,
  used: Set<string>,
): Promise<unknown> {
  if (typeof value === 'string') {
    if (SECRET_REF.test(value)) {
      const alias = value.slice('secret://'.length);
      if (!driver.secret) {
        throw new Error(`SECRET_NOT_FOUND: no secret store for ${alias}`);
      }
      used.add(alias);
      return driver.secret(alias);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return Promise.all(value.map((item) => resolveSecrets(item, driver, used)));
  }
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      output[key] = await resolveSecrets(item, driver, used);
    }
    return output;
  }
  return value;
}

/**
 * Executes one flow. Returns when the run is terminal or paused waiting for a
 * human decision that no hook supplied.
 */
export async function runFlow(options: {
  engine: WasmEngine;
  driver: BrowserDriver;
  flow: Flow;
  variables?: Record<string, unknown>;
  hooks?: RunHooks;
  runId?: string;
  maxIterations?: number;
  startStepId?: string;
  singleStep?: boolean;
}): Promise<RunResult> {
  const { engine, driver, flow, hooks = {} } = options;
  const wallStart = driver.wallTime();
  const started = driver.now();
  const events: RunEvent[] = [];
  const actionLog: ActionLogEntry[] = [];
  const plannerSamples: number[] = [];
  let pending: Record<string, unknown> | null = null;

  const collect = (payload: unknown): void => {
    const list = (payload as { events?: RunEvent[] })?.events;
    if (Array.isArray(list)) {
      for (const event of list) {
        events.push(event);
        hooks.onEvent?.(event);
      }
    }
  };

  const finish = (
    state: string,
    status: RunResult['status'],
    error: BridgeError | null,
  ): RunResult => {
    const finalEvents = new Map<number, RunEvent>();
    for (const event of events) finalEvents.set(event.seq, event);
    const eventsCommand = engine.events();
    const full = (eventsCommand.result as { events?: RunEvent[] } | undefined)?.events;
    if (Array.isArray(full)) for (const event of full) finalEvents.set(event.seq, event);
    const sorted = [...finalEvents.values()].sort((a, b) => a.seq - b.seq);
    return {
      state,
      status,
      error,
      events: sorted,
      actionLog,
      pending,
      metrics: {
        planner_samples_ms: plannerSamples,
        planner_p95_ms: percentile(plannerSamples, 0.95),
        total_elapsed_ms: driver.now() - started,
      },
    };
  };

  const load = engine.loadJson(JSON.stringify(flow));
  if (!load.ok) {
    return finish('DRAFT', 'failed', bridgeError(load.error, 'INVALID_IR'));
  }
  const validation = engine.validate();
  if (!validation.ok) {
    return finish('DRAFT', 'failed', bridgeError(validation.error, 'INVALID_IR'));
  }
  const armed = engine.arm();
  if (!armed.ok) {
    return finish('VALIDATED', 'failed', bridgeError(armed.error, 'INVALID_STATE'));
  }

  const runId = options.runId ?? `run-${crypto.randomUUID()}`;
  let response = engine.start({
    run_id: runId,
    now_mono_ms: driver.now(),
    wall_time_ms: wallStart,
    variables: options.variables ?? {},
    ...(options.startStepId ? { start_step_id: options.startStepId } : {}),
    single_step: options.singleStep === true,
  });
  if (!response.ok) {
    return finish('ARMED', 'failed', bridgeError(response.error, 'INTERNAL_ERROR'));
  }

  let iterations = 0;
  let cancelRequested = false;
  const maxIterations = options.maxIterations ?? 500;
  while (iterations < maxIterations) {
    iterations += 1;
    const output = response.result as
      (Directive & { events?: RunEvent[]; state: string }) | undefined;
    if (!output)
      return finish('FAILED', 'failed', { code: 'INTERNAL_ERROR', message: 'empty engine output' });
    collect(output);
    pending = output as unknown as Record<string, unknown>;
    if (output.kind === 'Finished') {
      return finish(output.state, output.status, output.error ?? null);
    }
    if (!cancelRequested && hooks.shouldCancel?.()) {
      cancelRequested = true;
      response = timedSubmit(engine, plannerSamples, {
        kind: 'Cancel',
        now_mono_ms: driver.now(),
        reason: 'user_cancelled',
      });
      if (!response.ok) {
        return finish('CANCELLED', 'cancelled', null);
      }
      continue;
    }
    const now = driver.now();

    try {
      switch (output.kind) {
        case 'ResolveTarget': {
          const snapshot = await driver.snapshot();
          await driver.enrichVisuals?.(snapshot, output.target as unknown as Target);
          response = timedSubmit(engine, plannerSamples, {
            kind: 'Candidates',
            now_mono_ms: now,
            step_id: output.step_id,
            attempt_id: output.attempt_id,
            candidates: candidatesForEngine(snapshot),
            facts: factsForEngine(snapshot, now),
          });
          break;
        }
        case 'PerformAction': {
          const facts = await safeFacts(driver);
          if (!facts) {
            response = timedSubmit(engine, plannerSamples, {
              kind: 'ActionDone',
              now_mono_ms: driver.now(),
              step_id: output.step_id,
              attempt_id: output.attempt_id,
              outcome: 'unknown',
              error: { code: 'PLATFORM_NAVIGATION', message: 'page facts are unavailable' },
            });
            break;
          }
          if (
            output.action !== 'launch' &&
            flow.app_scope.kind === 'web-origin' &&
            facts.origin.toLowerCase() !== flow.app_scope.value.toLowerCase()
          ) {
            response = timedSubmit(engine, plannerSamples, {
              kind: 'ActionDone',
              now_mono_ms: now,
              step_id: output.step_id,
              attempt_id: output.attempt_id,
              outcome: 'failed',
              error: {
                code: 'APP_SCOPE_VIOLATION',
                message: 'page left the flow origin before the action',
                detail: { expected: flow.app_scope.value, observed: facts.origin },
              },
              facts: {
                now_mono_ms: now,
                app_scope: facts.origin,
                url: facts.url,
                window_title: facts.title,
                window_stable_ms: facts.window_stable_ms,
              },
            });
            break;
          }
          const snapshot = await driver.snapshot();
          const location = output.resolved
            ? snapshot.index[output.resolved.candidate_id]
            : undefined;
          const usedSecrets = new Set<string>();
          let params: Record<string, unknown>;
          try {
            params = (await resolveSecrets(output.params, driver, usedSecrets)) as Record<
              string,
              unknown
            >;
          } catch (error) {
            response = timedSubmit(engine, plannerSamples, {
              kind: 'ActionDone',
              now_mono_ms: now,
              step_id: output.step_id,
              attempt_id: output.attempt_id,
              outcome: 'failed',
              error: { code: 'SECRET_NOT_FOUND', message: 'secret alias could not be resolved' },
            });
            break;
          }
          const resolvedCandidate = output.resolved
            ? snapshot.candidates.find(
                (candidate) => candidate.candidate_id === output.resolved?.candidate_id,
              )
            : undefined;
          const resolvedMeta = {
            candidate_test_id: resolvedCandidate?.semantic?.test_id ?? null,
            candidate_name: resolvedCandidate?.semantic?.name ?? null,
          };
          const actionStart = driver.now();
          const actionResult = await driver.act({
            step_id: output.step_id,
            attempt_id: output.attempt_id,
            action: output.action as StepAction,
            candidate_id: output.resolved?.candidate_id ?? null,
            frame_path: location?.frame_path ?? [],
            selector: location?.selector ?? null,
            params,
            target: (output.target as unknown as Target | null) ?? null,
            risk: output.risk,
            idempotency_key: output.idempotency_key ?? null,
            app_scope: flow.app_scope.value,
          });
          const duration = driver.now() - actionStart;
          if (actionResult.error) {
            const mapped = mapPlatformError('web', actionResult.error);
            actionLog.push({
              step_id: output.step_id,
              attempt_id: output.attempt_id,
              action: output.action,
              candidate_id: output.resolved?.candidate_id ?? null,
              started_at: actionStart,
              duration_ms: duration,
              ok: false,
              error_code: mapped.code,
              ...resolvedMeta,
              params_preview: output.params_preview,
            });
            const after = await safeFacts(driver);
            response = timedSubmit(engine, plannerSamples, {
              kind: 'ActionDone',
              now_mono_ms: driver.now(),
              step_id: output.step_id,
              attempt_id: output.attempt_id,
              outcome: 'failed',
              error: mapped,
              ...(after
                ? {
                    facts: {
                      now_mono_ms: driver.now(),
                      app_scope: after.origin,
                      url: after.url,
                      window_title: after.title,
                      window_stable_ms: after.window_stable_ms,
                    },
                  }
                : {}),
            });
            break;
          }
          actionLog.push({
            step_id: output.step_id,
            attempt_id: output.attempt_id,
            action: output.action,
            candidate_id: output.resolved?.candidate_id ?? null,
            started_at: actionStart,
            duration_ms: duration,
            ok: true,
            error_code: null,
            ...resolvedMeta,
            params_preview: output.params_preview,
          });
          const after = await safeFacts(driver);
          response = timedSubmit(engine, plannerSamples, {
            kind: 'ActionDone',
            now_mono_ms: driver.now(),
            step_id: output.step_id,
            attempt_id: output.attempt_id,
            outcome: after ? 'succeeded' : 'unknown',
            ...(after
              ? {
                  facts: {
                    now_mono_ms: driver.now(),
                    app_scope: after.origin,
                    url: after.url,
                    window_title: after.title,
                    window_stable_ms: after.window_stable_ms,
                  },
                }
              : {
                  error: {
                    code: 'PLATFORM_NAVIGATION',
                    message: 'page changed during the action; outcome is unknown',
                  },
                }),
            ...(actionResult.text !== undefined ? { text: actionResult.text } : {}),
          });
          break;
        }
        case 'AwaitCondition': {
          // Honour the engine's backoff instead of busy-polling the DOM.
          if (typeof output.poll_after_ms === 'number' && output.poll_after_ms > 0) {
            await driver.sleep(Math.min(output.poll_after_ms, 4_000));
          }
          const snapshot = await driver.snapshot();
          await driver.enrichVisuals?.(snapshot, null);
          response = timedSubmit(engine, plannerSamples, {
            kind: 'Observation',
            now_mono_ms: driver.now(),
            step_id: output.step_id,
            attempt_id: output.attempt_id,
            condition_id: output.condition_id,
            facts: factsForEngine(snapshot, driver.now()),
          });
          break;
        }
        case 'AwaitApproval': {
          const decide = hooks.approve;
          if (!decide) {
            await hooks.onPause?.(output as unknown as Record<string, unknown>);
            return finish('PAUSED_FOR_APPROVAL', 'paused', null);
          }
          try {
            await hooks.beforeApproval?.(output.summary);
          } catch (error) {
            return finish('FAILED', 'failed', {
              code: 'EVIDENCE_WRITE_FAILED',
              message: (error as Error).message,
            });
          }
          const approved = await decide(output.summary);
          response = timedSubmit(engine, plannerSamples, {
            kind: 'Approval',
            now_mono_ms: driver.now(),
            step_id: output.step_id,
            attempt_id: output.attempt_id,
            approved,
          });
          break;
        }
        case 'AwaitDisambiguation': {
          const decide = hooks.disambiguate;
          const choice = decide ? await decide(output.candidates, output.reason) : null;
          if (!choice) {
            await hooks.onPause?.(output as unknown as Record<string, unknown>);
            return finish('PAUSED_FOR_DISAMBIGUATION', 'paused', null);
          }
          response = timedSubmit(engine, plannerSamples, {
            kind: 'Disambiguation',
            now_mono_ms: driver.now(),
            step_id: output.step_id,
            attempt_id: output.attempt_id,
            candidate_id: choice,
          });
          break;
        }
        case 'AwaitOutcomeDecision': {
          const decide = hooks.decideOutcome;
          if (!decide) {
            await hooks.onPause?.(output as unknown as Record<string, unknown>);
            return finish('PAUSED_FOR_OUTCOME', 'paused', output.error);
          }
          const decision = await decide(output.error);
          response = timedSubmit(engine, plannerSamples, {
            kind: 'OutcomeDecision',
            now_mono_ms: driver.now(),
            step_id: output.step_id,
            attempt_id: output.attempt_id,
            decision,
          });
          break;
        }
        case 'AwaitRecovery': {
          const decide = hooks.recover;
          const decision = decide
            ? await decide(output.reason, output.options, output.error ?? null)
            : 'stop';
          response = timedSubmit(engine, plannerSamples, {
            kind: 'RecoveryDecision',
            now_mono_ms: driver.now(),
            decision,
          });
          break;
        }
        case 'AwaitTimer': {
          const delay = Math.max(0, output.wake_at_mono_ms - driver.now());
          if (delay > 0) await driver.sleep(delay);
          response = timedSubmit(engine, plannerSamples, {
            kind: 'Tick',
            now_mono_ms: driver.now(),
          });
          break;
        }
        default: {
          return finish((output as { state?: string }).state ?? 'FAILED', 'failed', {
            code: 'INTERNAL_ERROR',
            message: `unknown directive ${String((output as { kind?: string }).kind)}`,
          });
        }
      }
    } catch (error) {
      return finish('FAILED', 'failed', {
        code: 'INTERNAL_ERROR',
        message: `host failure: ${(error as Error).message}`,
      });
    }
    if (!response.ok) {
      return finish('FAILED', 'failed', bridgeError(response.error, 'INTERNAL_ERROR'));
    }
  }
  return finish('PAUSED_FOR_RECOVERY', 'paused', {
    code: 'RUNTIME_LIMIT_EXCEEDED',
    message: 'host loop iteration cap reached',
  });
}

async function safeFacts(
  driver: BrowserDriver,
): Promise<Awaited<ReturnType<BrowserDriver['facts']>> | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await driver.facts();
    } catch {
      await driver.sleep(150);
    }
  }
  return null;
}

function timedSubmit(engine: WasmEngine, samples: number[], input: Record<string, unknown>) {
  const startedAt = performance.now();
  const response = engine.submit(input);
  samples.push(performance.now() - startedAt);
  return response;
}
