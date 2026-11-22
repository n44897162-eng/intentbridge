import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WasmEngine } from '@intentbridge/engine-wasm';
import { loadFlow, validateFlowForExecution, type Flow } from '@intentbridge/action-ir';
import { runFlow } from '@intentbridge/web-core';
import { PlaywrightDriver } from '@intentbridge/web-runner';
import { preparePage, recordFlow } from '@intentbridge/web-runner';
import { launchBrowser, type BrowserSession } from '@intentbridge/web-runner';

const ROOT = resolve(__dirname, '../..');
const APP = 'http://127.0.0.1:4317';
const WASM = resolve(ROOT, 'target/wasm32-unknown-unknown/release/ib_runtime.wasm');
const golden = JSON.parse(
  readFileSync(resolve(ROOT, 'fixtures/flows/web-basic.flow.json'), 'utf8'),
) as Flow;

let fixture: ChildProcess | null = null;
let session: BrowserSession;

async function healthy(): Promise<boolean> {
  try {
    const response = await fetch(`${APP}/__health`);
    return response.ok;
  } catch {
    return false;
  }
}

async function configure(variant: string): Promise<void> {
  await fetch(`${APP}/__config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ variant }),
  });
}

async function resetFixture(): Promise<void> {
  await fetch(`${APP}/__reset`, { method: 'POST' });
}

async function stats(): Promise<Record<string, number>> {
  const response = await fetch(`${APP}/__stats`);
  return (await response.json()) as Record<string, number>;
}

function cloneFlow(mutator?: (flow: Flow) => void): Flow {
  const flow = JSON.parse(JSON.stringify(golden)) as Flow;
  flow.flow_id = crypto.randomUUID();
  mutator?.(flow);
  return flow;
}

function engine(): Promise<WasmEngine> {
  return WasmEngine.fromFile(WASM);
}

async function runOnPage(
  flow: Flow,
  options: {
    variables?: Record<string, unknown>;
    hooks?: Parameters<typeof runFlow>[0]['hooks'];
  } = {},
) {
  const page = await session.context.newPage();
  const driver = new PlaywrightDriver(page, { appScope: flow.app_scope.value });
  await driver.prepare();
  const wasm = await engine();
  const result = await runFlow({
    engine: wasm,
    driver,
    flow,
    variables: options.variables ?? { keyword: '报告' },
    hooks: options.hooks ?? { approve: () => true },
  });
  wasm.dispose();
  await page.close();
  return result;
}

beforeAll(async () => {
  if (!(await healthy())) {
    fixture = spawn(process.execPath, [resolve(ROOT, 'fixtures/web-fixture/server.mjs')], {
      stdio: 'ignore',
      detached: false,
    });
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (await healthy()) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
    }
  }
  session = await launchBrowser({ headless: true });
});

afterAll(async () => {
  await session?.close();
  fixture?.kill('SIGTERM');
});

beforeEach(async () => {
  await resetFixture();
  await configure('baseline');
});

describe('web golden replay (real Chrome)', () => {
  it('replays the recorded golden flow and observes real side effects', async () => {
    const result = await runOnPage(cloneFlow());
    expect(result.error).toBeNull();
    expect(result.state).toBe('SUCCEEDED');
    expect(result.status).toBe('succeeded');
    expect(result.actionLog.map((entry) => entry.action)).toEqual([
      'launch',
      'input',
      'click',
      'read-text',
    ]);
    const fixtureStats = await stats();
    expect(fixtureStats.submits).toBe(1);
    expect(fixtureStats.searches).toBeGreaterThanOrEqual(1);
    expect(result.events.filter((event) => event.type === 'StepSucceeded')).toHaveLength(6);
    expect(result.events.filter((event) => event.type === 'StepFailed')).toHaveLength(0);
    // Planner overhead must stay well below the 100ms budget.
    expect(result.metrics.planner_p95_ms).toBeLessThan(100);
    mkdirSync(resolve(ROOT, 'artifacts'), { recursive: true });
    writeFileSync(
      resolve(ROOT, 'artifacts/web-perf.json'),
      JSON.stringify(
        {
          generated_at: new Date().toISOString(),
          planner_p95_ms: result.metrics.planner_p95_ms,
          planner_samples: result.metrics.planner_samples_ms.length,
          total_elapsed_ms: result.metrics.total_elapsed_ms,
          actions: result.actionLog.length,
        },
        null,
        2,
      ),
    );
    // Event log is gap-free and starts at RunStarted.
    expect(result.events[0]?.type).toBe('RunStarted');
    expect(result.events.at(-1)?.type).toBe('RunFinished');
    result.events.forEach((event, index) => expect(event.seq).toBe(index + 1));
  });

  it('can be replayed 10 times without drift', async () => {
    for (let run = 0; run < 10; run += 1) {
      const result = await runOnPage(cloneFlow());
      expect(result.state).toBe('SUCCEEDED');
    }
    expect((await stats()).submits).toBe(10);
  });

  it('records a user flow in Chrome and replays it', async () => {
    const page = await session.context.newPage();
    await preparePage(page);
    await page.goto(`${APP}/`, { waitUntil: 'domcontentloaded' });
    const { flow, warnings } = await recordFlow(page, async () => {
      await page.getByTestId('keyword-input').fill('季度');
      await page.getByTestId('search-submit').click();
      await page.waitForSelector('[data-testid="results-summary"]');
      await page.getByTestId('report-type').selectOption('portrait');
    });
    await page.close();
    expect(warnings.some((warning) => warning.includes('password'))).toBe(false);
    const validation = validateFlowForExecution(flow);
    expect(validation.errors).toEqual([]);
    expect(flow.steps.length).toBeGreaterThanOrEqual(4);
    const inputStep = flow.steps.find((step) => step.action === 'input');
    expect(inputStep).toBeTruthy();
    expect((inputStep?.params as { value: string }).value).toBe('季度');
    const clickStep = flow.steps.find((step) => step.action === 'click');
    expect(clickStep?.target?.anchors.native_identity?.value).toBe('search-submit');
    const selectStep = flow.steps.find((step) => step.action === 'select');
    expect(selectStep?.target?.anchors.native_identity?.value).toBe('report-type');

    await resetFixture();
    const result = await runOnPage(flow, { variables: {} });
    expect(result.error).toBeNull();
    expect(result.state).toBe('SUCCEEDED');
    expect((await stats()).submits).toBe(1);
  });

  it('keeps recording across a same-origin navigation', async () => {
    const page = await session.context.newPage();
    await preparePage(page);
    await page.goto(`${APP}/`, { waitUntil: 'domcontentloaded' });
    const { flow } = await recordFlow(page, async () => {
      await page.getByTestId('keyword-input').fill('第一段');
      await page.getByTestId('search-submit').click();
      await page.waitForSelector('[data-testid="results-summary"]');
      await page.goto(`${APP}/?navigation=1`, { waitUntil: 'domcontentloaded' });
      await page.getByTestId('keyword-input').fill('导航之后');
    });
    await page.close();
    const inputs = flow.steps.filter((step) => step.action === 'input');
    expect(inputs.length).toBeGreaterThanOrEqual(2);
    expect(validateFlowForExecution(flow).errors).toEqual([]);
  });

  it('pauses when the page leaves the flow origin', async () => {
    const flow = cloneFlow((candidate) => {
      candidate.steps.splice(2, 0, {
        id: 'go-external',
        action: 'click',
        name: '前往外部站点',
        risk: 'normal',
        target: {
          anchors: {
            semantic: { role: 'link', name: '前往外部站点', test_id: 'external-link' },
            native_identity: { kind: 'web-test-id', value: 'external-link' },
          },
        },
        postconditions: [{ kind: 'window-stable', min_stable_ms: 100 }],
        params: { button: 'left', click_count: 1 },
      });
    });
    await configure('external');
    const result = await runOnPage(flow, {
      variables: { keyword: '报告' },
      hooks: { approve: () => true, recover: () => 'stop' },
    });
    expect(['PAUSED_FOR_OUTCOME', 'PAUSED_FOR_RECOVERY', 'CANCELLED']).toContain(result.state);
    expect(result.error?.code).toBe('APP_SCOPE_VIOLATION');
    const paused = result.events.filter((event) => event.type === 'RunPaused');
    expect(
      paused.some(
        (event) =>
          (event.payload as { reason?: string }).reason === 'outcome_unknown' &&
          (event.payload as { error?: { code?: string } }).error?.code === 'APP_SCOPE_VIOLATION',
      ),
    ).toBe(true);
    // No search submission happened on the foreign origin.
    expect((await stats()).submits).toBe(0);
  });
});
