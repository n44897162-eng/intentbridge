import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WasmEngine } from '@intentbridge/engine-wasm';

const wasmPath = resolve(__dirname, '../../target/wasm32-unknown-unknown/release/ib_runtime.wasm');
const flowJson = readFileSync(
  resolve(__dirname, '../../fixtures/flows/web-basic.flow.json'),
  'utf8',
);

describe('WASM engine binding', () => {
  it('runs the same protocol as the native engine', async () => {
    const engine = await WasmEngine.fromBytes(readFileSync(wasmPath));
    expect(engine.loadJson(flowJson).ok).toBe(true);
    expect(engine.validate().ok).toBe(true);
    expect(engine.arm().ok).toBe(true);
    const started = engine.start({
      run_id: 'run-wasm-0001',
      now_mono_ms: 1000,
      wall_time_ms: 1_700_000_000_000,
      variables: { keyword: '报告' },
    });
    expect(started.ok).toBe(true);
    const output = started.result as { kind: string; state: string };
    expect(output.kind).toBe('PerformAction');
    expect(output.state).toBe('RUNNING');
    const cancelled = engine.submit({ kind: 'Cancel', now_mono_ms: 1010, reason: 'test' });
    expect(cancelled.ok).toBe(true);
    expect((cancelled.result as { kind: string }).kind).toBe('Finished');
    engine.dispose();
  });

  it('rejects invalid flows without panicking', async () => {
    const engine = await WasmEngine.fromBytes(readFileSync(wasmPath));
    const bad = JSON.parse(flowJson);
    bad.steps[2].postconditions = [];
    const response = engine.load(bad);
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('INVALID_IR');
    engine.dispose();
  });
});
