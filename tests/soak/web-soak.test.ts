import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WasmEngine } from '@intentbridge/engine-wasm';
import type { Flow } from '@intentbridge/action-ir';
import { runFlow } from '@intentbridge/web-core';
import { launchBrowser, PlaywrightDriver, type BrowserSession } from '@intentbridge/web-runner';

const ROOT = resolve(__dirname, '../..');
const APP = 'http://127.0.0.1:4317';
const WASM = resolve(ROOT, 'target/wasm32-unknown-unknown/release/ib_runtime.wasm');
const golden = JSON.parse(
  readFileSync(resolve(ROOT, 'fixtures/flows/web-basic.flow.json'), 'utf8'),
) as Flow;
const RUNS = 30;

let fixture: ChildProcess | null = null;
let session: BrowserSession;

function memory(): Record<string, number> {
  const usage = process.memoryUsage();
  const mb = (value: number) => Math.round((value / (1024 * 1024)) * 10) / 10;
  return {
    rss: mb(usage.rss),
    heap_total: mb(usage.heapTotal),
    heap_used: mb(usage.heapUsed),
    external: mb(usage.external),
    array_buffers: mb(usage.arrayBuffers),
  };
}

async function collectGarbage(): Promise<void> {
  const gc = (globalThis as unknown as { gc?: () => void }).gc;
  gc?.();
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  gc?.();
}

beforeAll(async () => {
  try {
    if (!(await fetch(`${APP}/__health`)).ok) throw new Error('down');
  } catch {
    fixture = spawn(process.execPath, [resolve(ROOT, 'fixtures/web-fixture/server.mjs')], {
      stdio: 'ignore',
    });
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        if ((await fetch(`${APP}/__health`)).ok) break;
      } catch {
        /* retry */
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
    }
  }
  await fetch(`${APP}/__reset`, { method: 'POST' });
  session = await launchBrowser({ headless: true });
});

afterAll(async () => {
  await session?.close();
  fixture?.kill('SIGTERM');
});

describe('web soak', () => {
  it(`replays the golden flow ${RUNS} times with stable memory`, async () => {
    const module = await WebAssembly.compile(readFileSync(WASM));
    await collectGarbage();
    const before = memory();
    const durations: number[] = [];
    for (let run = 0; run < RUNS; run += 1) {
      const flow = JSON.parse(JSON.stringify(golden)) as Flow;
      flow.flow_id = crypto.randomUUID();
      const page = await session.context.newPage();
      const driver = new PlaywrightDriver(page, { appScope: flow.app_scope.value });
      await driver.prepare();
      const engine = await WasmEngine.fromModule(module);
      const result = await runFlow({
        engine,
        driver,
        flow,
        variables: { keyword: '报告' },
        hooks: { approve: () => true },
      });
      engine.dispose();
      await page.close();
      expect(result.state, `run ${run}`).toBe('SUCCEEDED');
      durations.push(result.metrics.total_elapsed_ms);
    }
    await collectGarbage();
    const after = memory();
    const stats = (await (await fetch(`${APP}/__stats`)).json()) as { submits: number };
    expect(stats.submits).toBe(RUNS);
    const sorted = [...durations].sort((a, b) => a - b);
    const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] as number;
    const report = {
      generated_at: new Date().toISOString(),
      runs: RUNS,
      succeeded: RUNS,
      memory_before: before,
      memory_after: after,
      node_rss_growth_mb: Math.round(((after.rss ?? 0) - (before.rss ?? 0)) * 10) / 10,
      p95_total_ms: Math.round(p95 * 10) / 10,
      submits: stats.submits,
    };
    mkdirSync(resolve(ROOT, 'artifacts'), { recursive: true });
    writeFileSync(resolve(ROOT, 'artifacts/web-soak.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    // V8 reserves heap pages (RSS grows) while live heap stays flat; a leak
    // would grow heap_used across runs.
    expect((after.heap_used ?? 0) - (before.heap_used ?? 0)).toBeLessThan(20);
  }, 180_000);
});
