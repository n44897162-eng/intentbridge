import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Flow } from '@intentbridge/action-ir';
import { WasmEngine } from '@intentbridge/engine-wasm';
import { runFlow, type BrowserDriver } from '@intentbridge/web-core';

const ROOT = resolve(__dirname, '../..');

describe('host cancellation', () => {
  it('returns cancelled instead of submitting Cancel twice', async () => {
    const flow = JSON.parse(
      readFileSync(resolve(ROOT, 'fixtures/flows/web-basic.flow.json'), 'utf8'),
    ) as Flow;
    const driver = {
      now: () => 0,
      wallTime: () => Date.now(),
      sleep: async () => undefined,
      prepare: async () => undefined,
      snapshot: async () => ({
        url: 'http://127.0.0.1:4317/',
        origin: 'http://127.0.0.1:4317',
        title: 'fixture',
        viewport: { w: 1280, h: 800 },
        device_scale: 1,
        candidates: [],
        stable_ms: 1000,
        index: {},
      }),
      facts: async () => ({
        url: 'http://127.0.0.1:4317/',
        origin: 'http://127.0.0.1:4317',
        title: 'fixture',
        window_stable_ms: 1000,
      }),
      act: async () => ({ ok: true }),
      enrichVisuals: async () => undefined,
      secret: () => {
        throw new Error('no secrets');
      },
    } as unknown as BrowserDriver;
    const engine = await WasmEngine.fromFile(
      resolve(ROOT, 'target/wasm32-unknown-unknown/release/ib_runtime.wasm'),
    );
    const result = await runFlow({
      engine,
      driver,
      flow,
      variables: { keyword: '报告' },
      hooks: { shouldCancel: () => true },
    });
    engine.dispose();
    expect(result.status).toBe('cancelled');
    expect(result.state).toBe('CANCELLED');
    expect(result.events.filter((event) => event.type === 'RunCancelled')).toHaveLength(1);
    expect(result.events.at(-1)?.type).toBe('RunFinished');
  });
});
