import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WasmEngine } from '@intentbridge/engine-wasm';
import { validateFlow, validateFlowForExecution, type Flow } from '@intentbridge/action-ir';

const ROOT = resolve(__dirname, '../..');
const WASM = resolve(ROOT, 'target/wasm32-unknown-unknown/release/ib_runtime.wasm');
const web = JSON.parse(
  readFileSync(resolve(ROOT, 'fixtures/flows/web-basic.flow.json'), 'utf8'),
) as Flow;
const windows = JSON.parse(
  readFileSync(resolve(ROOT, 'fixtures/flows/windows-basic.flow.json'), 'utf8'),
) as Flow;
const android = JSON.parse(
  readFileSync(resolve(ROOT, 'fixtures/flows/android-basic.flow.json'), 'utf8'),
) as Flow;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function rustVerdict(flow: unknown, execution = false): Promise<'ok' | 'reject'> {
  const engine = await WasmEngine.fromBytes(readFileSync(WASM));
  const loaded = engine.load(flow);
  if (!loaded.ok) {
    engine.dispose();
    return 'reject';
  }
  if (!execution) {
    engine.dispose();
    return 'ok';
  }
  const validated = engine.validate();
  engine.dispose();
  return validated.ok ? 'ok' : 'reject';
}

function tsVerdict(flow: unknown, execution = false): 'ok' | 'reject' {
  return (execution ? validateFlowForExecution(flow) : validateFlow(flow)).ok ? 'ok' : 'reject';
}

describe('TS and Rust IR validation parity', () => {
  it('accepts the three platform golden flows on both sides', async () => {
    for (const flow of [web, windows, android]) {
      expect(tsVerdict(flow)).toBe('ok');
      expect(await rustVerdict(flow)).toBe('ok');
      expect(tsVerdict(flow, true)).toBe('ok');
      expect(await rustVerdict(flow, true)).toBe('ok');
    }
  });

  it('rejects the same invalid corpus on both sides', async () => {
    const cases: Array<{ name: string; flow: unknown; execution?: boolean }> = [];
    const noPostcondition = clone(web);
    delete (noPostcondition.steps[2] as { postconditions?: unknown }).postconditions;
    cases.push({ name: 'missing postcondition', flow: noPostcondition });

    const noPermission = clone(web);
    noPermission.permissions = ['read-ui', 'read-screen', 'launch'];
    cases.push({ name: 'missing permission', flow: noPermission });

    const duplicate = clone(web);
    duplicate.steps[1]!.id = duplicate.steps[0]!.id;
    cases.push({ name: 'duplicate step id', flow: duplicate });

    const unknown = clone(web) as unknown as Record<string, unknown>;
    unknown['surprise'] = true;
    cases.push({ name: 'unknown field', flow: unknown });

    const password = clone(web);
    password.steps[1]!.target!.anchors.semantic = {
      role: 'textbox',
      name: 'Password',
      test_id: 'keyword-input',
    };
    (password.steps[1]!.params as { value: string }).value = 'hunter2';
    password.steps.forEach((step) => {
      step.evidence_policy = { capture: 'none' };
    });
    cases.push({ name: 'plaintext password', flow: password });

    const template = clone(web);
    (template.steps[1]!.params as { value: string }).value = '${missing}';
    cases.push({ name: 'undeclared template', flow: template });

    const scope = clone(web);
    scope.app_scope = { kind: 'android-package', value: 'com.example.app' };
    cases.push({ name: 'wrong scope kind', flow: scope });

    const secretPlacement = clone(web);
    (secretPlacement.steps[2]!.params as Record<string, unknown>)['value'] = 'secret://alias';
    cases.push({ name: 'secret placement', flow: secretPlacement });

    const noEnd = clone(web);
    noEnd.steps = noEnd.steps.filter((step) => step.action !== 'end');
    cases.push({ name: 'missing end', flow: noEnd, execution: true });

    for (const testCase of cases) {
      const ts = tsVerdict(testCase.flow, testCase.execution === true);
      const rust = await rustVerdict(testCase.flow, testCase.execution === true);
      expect(ts, `${testCase.name} (ts)`).toBe('reject');
      expect(rust, `${testCase.name} (rust)`).toBe('reject');
    }
  });

  it('rejects a flow above the execution step cap on both sides', async () => {
    const flow = clone(web);
    flow.steps = Array.from({ length: 101 }, (_, index) => ({
      id: `wait-${index}`,
      action: 'wait' as const,
      params: { condition: { kind: 'window-stable', min_stable_ms: 10 } },
    }));
    flow.steps.push({ id: 'done', action: 'end', params: { status: 'success' } });
    // Schema allows up to 1000 steps, the runtime cap is 100.
    expect(tsVerdict(flow)).toBe('ok');
    expect(await rustVerdict(flow)).toBe('ok');
    expect(tsVerdict(flow, true)).toBe('reject');
    expect(await rustVerdict(flow, true)).toBe('reject');
  });
});
