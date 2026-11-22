/**
 * MV3 service worker: owns the WASM engine, drives the active tab through the
 * content script, and keeps flow/runtime state in local browser storage.
 * No page content or screenshot leaves the device.
 */
import type { Flow, Target } from '@intentbridge/action-ir';
import { WasmEngine } from '@intentbridge/engine-wasm';
import {
  buildFlowFromRecording,
  dhashFromRgba,
  runFlow,
  type ActionRequest,
  type BrowserDriver,
  type DriverActResult,
  type DriverFacts,
  type RecorderEvent,
  type SnapshotResult,
} from '@intentbridge/web-core';

interface StoredFlow {
  flow: Flow;
  updated_at: string;
}

interface RuntimeState {
  status: 'idle' | 'recording' | 'running' | 'paused' | 'finished' | 'failed';
  flow_id?: string;
  run_id?: string;
  state?: string;
  error?: { code?: string; message?: string } | null;
  pending?: { kind: string; payload: unknown } | null;
  events?: number;
  action_log?: unknown[];
  summary?: { status: string; state: string };
  updated_at: string;
}

const STORAGE_FLOWS = 'flows';
const STORAGE_RUNTIME = 'runtime';

let runtime: RuntimeState = { status: 'idle', updated_at: new Date().toISOString() };
let recording: { tabId: number; initialTestIds: string[] } | null = null;
let activeRun: {
  cancelled: boolean;
  waiters: Map<string, (value: unknown) => void>;
} | null = null;
let currentTabId: number | null = null;
let lastEventPersist = 0;
const DECISION_ALARM = 'ib-decision-timeout';
const HEARTBEAT_ALARM = 'ib-run-heartbeat';

let runtimeQueue: Promise<void> = Promise.resolve();

async function saveRuntime(patch: Partial<RuntimeState>): Promise<void> {
  runtime = { ...runtime, ...patch, updated_at: new Date().toISOString() };
  const snapshot = { ...runtime };
  // Serialise storage writes so a late event update cannot overwrite a newer
  // pending/status transition (the popup would otherwise lose its buttons).
  runtimeQueue = runtimeQueue
    .catch(() => undefined)
    .then(() => chrome.storage.local.set({ [STORAGE_RUNTIME]: snapshot }));
  await runtimeQueue;
}

async function getRuntime(): Promise<RuntimeState> {
  const stored = await chrome.storage.local.get(STORAGE_RUNTIME);
  const value = stored[STORAGE_RUNTIME] as RuntimeState | undefined;
  if (value) runtime = value;
  return runtime;
}

async function getFlows(): Promise<Record<string, StoredFlow>> {
  const stored = await chrome.storage.local.get(STORAGE_FLOWS);
  return (stored[STORAGE_FLOWS] as Record<string, StoredFlow> | undefined) ?? {};
}

async function saveFlow(flow: Flow): Promise<void> {
  const flows = await getFlows();
  flows[flow.flow_id] = { flow, updated_at: new Date().toISOString() };
  await chrome.storage.local.set({ [STORAGE_FLOWS]: flows });
}

async function deleteFlow(flowId: string): Promise<void> {
  const flows = await getFlows();
  delete flows[flowId];
  await chrome.storage.local.set({ [STORAGE_FLOWS]: flows });
}

async function ensureInjected(tabId: number): Promise<void> {
  try {
    const pong = (await chrome.tabs.sendMessage(tabId, { type: 'ib:ping' })) as
      { ok?: boolean } | undefined;
    if (pong?.ok) return;
  } catch {
    /* not injected yet */
  }
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const pong = (await chrome.tabs.sendMessage(tabId, { type: 'ib:ping' })) as
        { ok?: boolean } | undefined;
      if (pong?.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error('content script did not respond');
}

async function tabMessage<T>(tabId: number, message: Record<string, unknown>): Promise<T> {
  await ensureInjected(tabId);
  const reply = (await chrome.tabs.sendMessage(tabId, message)) as
    | { ok?: boolean; error?: string; snapshot?: T; facts?: T; recording?: T; result?: T }
    | undefined;
  if (!reply) throw new Error('empty content-script response');
  if (reply.ok === false) throw new Error(reply.error ?? 'content-script failure');
  return (reply.snapshot ?? reply.facts ?? reply.recording ?? reply.result) as T;
}

function waitForNavigation(tabId: number, expectedUrl: string, timeoutMs = 20_000): Promise<void> {
  const normalize = (value: string): string => value.replace(/#.*$/, '').replace(/\/$/, '');
  const expected = normalize(expectedUrl);
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('tab did not finish loading the requested url'));
    }, timeoutMs);
    const listener = (
      updatedTabId: number,
      change: chrome.tabs.TabChangeInfo,
      tab: chrome.tabs.Tab,
    ): void => {
      if (updatedTabId !== tabId || change.status !== 'complete') return;
      if (normalize(tab.url ?? '') !== expected) return;
      cleanup();
      resolve();
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

class ExtensionDriver implements BrowserDriver {
  private readonly tabId: number;
  private readonly startedAt = performance.now();

  constructor(tabId: number) {
    this.tabId = tabId;
  }

  now(): number {
    return performance.now() - this.startedAt;
  }

  wallTime(): number {
    return Date.now();
  }

  async snapshot(): Promise<SnapshotResult> {
    const snapshot = await tabMessage<SnapshotResult>(this.tabId, { type: 'ib:snapshot' });
    if (!snapshot) throw new Error('no snapshot');
    return snapshot;
  }

  async facts(): Promise<DriverFacts> {
    const facts = await tabMessage<DriverFacts>(this.tabId, { type: 'ib:facts' });
    if (!facts) throw new Error('no facts');
    return facts;
  }

  async act(request: ActionRequest): Promise<DriverActResult> {
    if (request.action === 'launch') {
      const url = String(request.params['url'] ?? '');
      if (!url) return { error: { code: 'INVALID_IR', message: 'launch url missing' } };
      const loaded = waitForNavigation(this.tabId, url);
      await chrome.tabs.update(this.tabId, { url });
      await loaded;
      await ensureInjected(this.tabId);
      return {};
    }
    if (request.action === 'activate') {
      await chrome.tabs.update(this.tabId, { active: true });
      return {};
    }
    const result = await tabMessage<DriverActResult>(this.tabId, { type: 'ib:act', request });
    return result ?? {};
  }

  async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  async secret(alias: string): Promise<string> {
    const key = `secret:${alias}`;
    const stored = await chrome.storage.session.get(key);
    const value = stored[key];
    if (typeof value !== 'string') throw new Error(`SECRET_NOT_FOUND: ${alias}`);
    return value;
  }
}

function requestDecision(kind: string, payload: unknown): Promise<unknown> {
  if (!activeRun) return Promise.resolve(null);
  void chrome.alarms.create(DECISION_ALARM, { delayInMinutes: 10 });
  return new Promise((resolve) => {
    activeRun?.waiters.set(kind, resolve);
    void saveRuntime({ status: 'paused', pending: { kind, payload } });
  });
}

function resolveDecision(kind: string, value: unknown): boolean {
  const waiter = activeRun?.waiters.get(kind);
  if (!waiter) return false;
  activeRun?.waiters.delete(kind);
  void chrome.alarms.clear(DECISION_ALARM);
  void saveRuntime({ status: 'running', pending: null });
  waiter(value);
  return true;
}

let compiledModule: Promise<WebAssembly.Module> | null = null;

async function createEngine(): Promise<WasmEngine> {
  if (!compiledModule) {
    compiledModule = (async () => {
      const bytes = await (await fetch(chrome.runtime.getURL('ib_runtime.wasm'))).arrayBuffer();
      return WebAssembly.compile(bytes);
    })();
  }
  return WasmEngine.fromModule(await compiledModule);
}

async function validateWithEngine(flow: Flow): Promise<void> {
  const engine = await createEngine();
  try {
    const loaded = engine.load(flow);
    if (!loaded.ok) {
      throw new Error(
        `flow validation failed: ${JSON.stringify(loaded.error?.detail ?? loaded.error)}`,
      );
    }
    const validated = engine.validate();
    if (!validated.ok) {
      throw new Error(
        `flow is not runnable: ${JSON.stringify(validated.error?.detail ?? validated.error)}`,
      );
    }
  } finally {
    engine.dispose();
  }
}

async function startRun(
  flowId: string,
  variables: Record<string, unknown>,
  tabId: number,
  autoApprove: boolean,
): Promise<string> {
  if (activeRun) throw new Error('a run is already active');
  const flows = await getFlows();
  const stored = flows[flowId];
  if (!stored) throw new Error('flow not found');
  await validateWithEngine(stored.flow);
  const runId = `run-${crypto.randomUUID()}`;
  const engine = await createEngine();
  const driver = new ExtensionDriver(tabId);
  activeRun = { cancelled: false, waiters: new Map() };
  currentTabId = tabId;
  void chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 1 });
  await saveRuntime({
    status: 'running',
    flow_id: flowId,
    run_id: runId,
    state: 'RUNNING',
    events: 0,
    pending: null,
    error: null,
    action_log: [],
  });
  void (async () => {
    try {
      const result = await runFlow({
        engine,
        driver,
        flow: stored.flow,
        variables,
        hooks: {
          approve: async (summary) => {
            if (autoApprove) return true;
            return (await requestDecision('approval', summary)) === true;
          },
          disambiguate: async (candidates, reason) => {
            return (await requestDecision('disambiguation', {
              candidates: candidates.slice(0, 20),
              reason,
            })) as string | null;
          },
          decideOutcome: async (error) => {
            return (
              ((await requestDecision('outcome', error)) as 'succeeded' | 'failed' | 'retry') ??
              'failed'
            );
          },
          recover: async (reason, options) => {
            return ((await requestDecision('recovery', { reason, options })) as string) ?? 'stop';
          },
          shouldCancel: () => activeRun?.cancelled === true,
          onEvent: () => {
            runtime.events = (runtime.events ?? 0) + 1;
            const now = Date.now();
            if (now - lastEventPersist > 400) {
              lastEventPersist = now;
              void saveRuntime({ events: runtime.events });
            }
          },
          onPause: async (directive) => {
            await saveRuntime({
              status: 'paused',
              pending: directive as unknown as RuntimeState['pending'],
            });
          },
        },
      });
      await saveRuntime({
        status: 'finished',
        state: result.state,
        error: result.error,
        pending: null,
        summary: { status: result.status, state: result.state },
        action_log: result.actionLog,
      });
    } catch (error) {
      await saveRuntime({
        status: 'finished',
        state: 'FAILED',
        error: { code: 'INTERNAL_ERROR', message: String((error as Error).message) },
        pending: null,
      });
    } finally {
      engine.dispose();
      activeRun = null;
      currentTabId = null;
      void chrome.alarms.clear(DECISION_ALARM);
      void chrome.alarms.clear(HEARTBEAT_ALARM);
    }
  })();
  return runId;
}

async function startRecording(tabId: number): Promise<void> {
  if (recording) throw new Error('recording already active');
  if (activeRun) throw new Error('stop the active run first');
  await ensureInjected(tabId);
  const snapshot = await tabMessage<SnapshotResult>(tabId, { type: 'ib:snapshot' });
  const initialTestIds = (snapshot?.candidates ?? [])
    .map((candidate) => candidate.semantic?.test_id)
    .filter((value): value is string => Boolean(value));
  await tabMessage(tabId, { type: 'ib:start-recording' });
  recording = { tabId, initialTestIds };
  void chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 1 });
  await saveRuntime({
    status: 'recording',
    flow_id: undefined,
    run_id: undefined,
    error: null,
    pending: null,
  });
}

async function stopRecording(): Promise<{ flow: Flow; warnings: string[] }> {
  if (!recording) throw new Error('no active recording');
  const session = recording;
  recording = null;
  const payload = await tabMessage<{ events: RecorderEvent[]; warnings: string[] }>(session.tabId, {
    type: 'ib:stop-recording',
  });
  const built = buildFlowFromRecording(
    {
      events: payload?.events ?? [],
      warnings: payload?.warnings ?? [],
      started_at: Date.now(),
      stopped_at: Date.now(),
    },
    { initialTestIds: session.initialTestIds },
  );
  await validateWithEngine(built.flow);
  await saveFlow(built.flow);
  void chrome.alarms.clear(HEARTBEAT_ALARM);
  await saveRuntime({ status: 'idle', pending: null });
  return { flow: built.flow, warnings: built.warnings };
}

async function reconcileRuntime(reason: string): Promise<void> {
  const state = await getRuntime();
  if (activeRun || recording) return;
  if (!['running', 'paused', 'recording'].includes(state.status)) return;
  await saveRuntime({
    status: state.status === 'recording' ? 'idle' : 'failed',
    pending: null,
    error: {
      code: 'EXTENSION_RESTARTED',
      message: `${reason}: the service worker restarted before this session finished`,
    },
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === DECISION_ALARM) {
    const run = activeRun;
    if (run) {
      run.cancelled = true;
      for (const resolve of run.waiters.values()) resolve(null);
      run.waiters.clear();
      void saveRuntime({
        status: 'failed',
        pending: null,
        error: { code: 'DECISION_TIMEOUT', message: 'human decision timed out' },
      });
    } else {
      void reconcileRuntime('decision timeout');
    }
  } else if (alarm.name === HEARTBEAT_ALARM) {
    void reconcileRuntime('heartbeat');
  }
});

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === 'complete' && recording?.tabId === tabId) {
    void ensureInjected(tabId).catch(() => undefined);
  }
});

chrome.runtime.onStartup.addListener(() => void reconcileRuntime('browser startup'));
chrome.runtime.onInstalled.addListener(() => void reconcileRuntime('extension update'));

chrome.runtime.onMessage.addListener((message: Record<string, unknown>, _sender, sendResponse) => {
  const type = String(message['type'] ?? '');
  if (!type.startsWith('ib:')) return false;
  void (async () => {
    try {
      switch (type) {
        case 'ib:get-runtime':
          sendResponse({ ok: true, runtime: await getRuntime() });
          return;
        case 'ib:list-flows': {
          const flows = Object.values(await getFlows());
          sendResponse({ ok: true, flows });
          return;
        }
        case 'ib:start-recording':
          await startRecording(Number(message['tabId']));
          sendResponse({ ok: true });
          return;
        case 'ib:stop-recording':
          sendResponse({ ok: true, ...(await stopRecording()) });
          return;
        case 'ib:run-flow': {
          const runId = await startRun(
            String(message['flowId']),
            (message['variables'] as Record<string, unknown>) ?? {},
            Number(message['tabId']),
            message['autoApprove'] === true,
          );
          sendResponse({ ok: true, runId });
          return;
        }
        case 'ib:decision': {
          const applied = resolveDecision(String(message['kind']), message['value']);
          sendResponse({ ok: applied });
          return;
        }
        case 'ib:cancel': {
          if (activeRun) {
            activeRun.cancelled = true;
            resolveDecision('approval', false);
            resolveDecision('disambiguation', null);
            resolveDecision('outcome', 'failed');
            resolveDecision('recovery', 'stop');
          }
          sendResponse({ ok: true });
          return;
        }
        case 'ib:delete-flow':
          await deleteFlow(String(message['flowId']));
          sendResponse({ ok: true });
          return;
        case 'ib:set-secret': {
          const alias = String(message['alias'] ?? '');
          const value = String(message['value'] ?? '');
          if (!/^[a-z][a-z0-9._-]{0,63}$/.test(alias) || value.length === 0)
            throw new Error('invalid secret');
          await chrome.storage.session.set({ [`secret:${alias}`]: value });
          sendResponse({ ok: true });
          return;
        }
        case 'ib:ping-background':
          sendResponse({ ok: true, runtime: await getRuntime() });
          return;
        default:
          sendResponse({ ok: false, error: `unknown message ${type}` });
      }
    } catch (error) {
      sendResponse({ ok: false, error: String((error as Error).message) });
    }
  })();
  return true;
});

void getRuntime();

void reconcileRuntime('service worker load');
