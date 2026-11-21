import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WasmEngine } from '@intentbridge/engine-wasm';
import type { Flow } from '@intentbridge/action-ir';
import { runFlow, type RunHooks } from '@intentbridge/web-core';
import { launchBrowser, PlaywrightDriver, type BrowserSession } from '@intentbridge/web-runner';

const ROOT = resolve(__dirname, '../..');
const APP = 'http://127.0.0.1:4317';
const WASM = resolve(ROOT, 'target/wasm32-unknown-unknown/release/ib_runtime.wasm');
const corpus = JSON.parse(readFileSync(resolve(__dirname, 'corpus.json'), 'utf8')) as {
  cases: Array<{
    id: string;
    variant: string;
    flow: 'golden' | 'semantic';
    expect: 'auto_success' | 'manual_success' | 'no_execution';
    expected_button_test_id?: string;
    expected_input_test_id?: string;
    expected_button_name?: string;
    expected_input_name?: string;
  }>;
};
const golden = JSON.parse(
  readFileSync(resolve(ROOT, 'fixtures/flows/web-basic.flow.json'), 'utf8'),
) as Flow;
const semantic = JSON.parse(
  readFileSync(resolve(ROOT, 'fixtures/flows/web-drift-semantic.flow.json'), 'utf8'),
) as Flow;

let fixture: ChildProcess | null = null;
let session: BrowserSession;

async function healthy(): Promise<boolean> {
  try {
    return (await fetch(`${APP}/__health`)).ok;
  } catch {
    return false;
  }
}

async function request(path: string, method = 'GET'): Promise<unknown> {
  const response = await fetch(`${APP}${path}`, { method });
  return response.json();
}

function clone(flow: Flow, timeout: number): Flow {
  const copy = JSON.parse(JSON.stringify(flow)) as Flow;
  copy.flow_id = crypto.randomUUID();
  for (const step of copy.steps) {
    step.timeout_ms = timeout;
  }
  return copy;
}

beforeAll(async () => {
  if (!(await healthy())) {
    fixture = spawn(process.execPath, [resolve(ROOT, 'fixtures/web-fixture/server.mjs')], {
      stdio: 'ignore',
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

describe('drift re-anchoring acceptance', () => {
  it('re-anchors safely and never executes on a wrong target', async () => {
    const results: Array<Record<string, unknown>> = [];
    let manualCount = 0;
    let misExecutions = 0;
    let recoverable = 0;
    let recovered = 0;

    for (const testCase of corpus.cases) {
      await request('/__reset', 'POST');
      await fetch(`${APP}/__config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ variant: testCase.variant }),
      });
      const flow = clone(testCase.flow === 'golden' ? golden : semantic, 3500);
      let manual = false;
      const hooks: RunHooks = {
        approve: () => true,
        disambiguate: (candidates) => {
          const pickCandidate = (role: string, testId?: string, name?: string) => {
            const match = candidates.find((item) => {
              const semantic = item.candidate.semantic;
              if (!semantic) return false;
              if (testId && semantic.test_id === testId) return true;
              if (name && semantic.name === name && (!role || semantic.role === role)) return true;
              return false;
            });
            if (match) {
              manual = true;
              return match.candidate.candidate_id;
            }
            return null;
          };
          const exact =
            pickCandidate(
              'button',
              testCase.expected_button_test_id,
              testCase.expected_button_name,
            ) ??
            pickCandidate('textbox', testCase.expected_input_test_id, testCase.expected_input_name);
          if (exact) return exact;
          // A human can always disambiguate the obvious field by its role.
          const fallback = candidates.find((item) => item.candidate.semantic?.role === 'textbox');
          if (fallback) {
            manual = true;
            return fallback.candidate.candidate_id;
          }
          return null;
        },
        recover: () => 'stop',
      };
      const page = await session.context.newPage();
      const driver = new PlaywrightDriver(page, { appScope: flow.app_scope.value });
      await driver.prepare();
      const engine = await WasmEngine.fromFile(WASM);
      const result = await runFlow({
        engine,
        driver,
        flow,
        variables: { keyword: '报告' },
        hooks,
      });
      engine.dispose();
      await page.close();
      if (manual) manualCount += 1;

      const executed = result.actionLog.filter(
        (entry) => entry.action === 'click' || entry.action === 'input',
      );
      for (const entry of executed) {
        const expectedTestId =
          entry.action === 'click'
            ? testCase.expected_button_test_id
            : testCase.expected_input_test_id;
        const expectedName =
          entry.action === 'click' ? testCase.expected_button_name : testCase.expected_input_name;
        const ok =
          (expectedTestId ? entry.candidate_test_id === expectedTestId : true) &&
          (expectedName ? entry.candidate_name === expectedName : true);
        if (!ok) misExecutions += 1;
      }

      const succeeded = result.state === 'SUCCEEDED';
      const classified =
        succeeded && manual
          ? 'manual_success'
          : succeeded
            ? 'auto_success'
            : executed.length === 0
              ? 'no_execution'
              : 'refused_after_action';
      if (classified !== testCase.expect) {
        console.log(
          'DEBUG',
          testCase.id,
          result.state,
          result.error?.code,
          (result.pending as any)?.kind,
        );
        console.log(
          executed.map((e) => `${e.action}:${e.candidate_test_id}:${e.candidate_name}`).join(', '),
        );
        console.log(
          result.events
            .slice(-12)
            .map((e) => `${e.type}:${JSON.stringify(e.payload).slice(0, 240)}`)
            .join('\n'),
        );
      }
      if (testCase.expect !== 'no_execution') {
        recoverable += 1;
        if (testCase.expect === classified) recovered += 1;
      }
      results.push({
        id: testCase.id,
        variant: testCase.variant,
        expect: testCase.expect,
        classified,
        manual,
        state: result.state,
        executed_actions: executed.map((entry) => ({
          action: entry.action,
          candidate_test_id: entry.candidate_test_id,
          candidate_name: entry.candidate_name,
        })),
        error: result.error?.code ?? null,
      });
      expect(classified, `${testCase.id} (${testCase.variant})`).toBe(testCase.expect);
    }

    const successRate = recoverable === 0 ? 0 : recovered / recoverable;
    const report = {
      generated_at: new Date().toISOString(),
      cases: results,
      metrics: {
        total_cases: corpus.cases.length,
        recoverable_cases: recoverable,
        recovered_cases: recovered,
        manual_confirmations: manualCount,
        success_rate: Number(successRate.toFixed(3)),
        mis_executions: misExecutions,
      },
    };
    mkdirSync(resolve(ROOT, 'artifacts'), { recursive: true });
    writeFileSync(resolve(ROOT, 'artifacts/drift-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report.metrics));
    expect(misExecutions).toBe(0);
    expect(successRate).toBeGreaterThanOrEqual(0.85);
  }, 120_000);
});
