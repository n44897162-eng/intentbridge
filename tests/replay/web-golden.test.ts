import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WasmEngine } from '@intentbridge/engine-wasm';
import type { Flow } from '@intentbridge/action-ir';
import { runFlow } from '@intentbridge/web-core';
import { launchBrowser, PlaywrightDriver, type BrowserSession } from '@intentbridge/web-runner';

const ROOT = resolve(__dirname, '../..');
const APP = 'http://127.0.0.1:4317';
const WASM = resolve(ROOT, 'target/wasm32-unknown-unknown/release/ib_runtime.wasm');
const corpus = JSON.parse(readFileSync(resolve(ROOT, 'tests/replay/web-golden.json'), 'utf8')) as {
  flows: Array<{
    id: string;
    file: string;
    variant: string;
    variables: Record<string, string>;
    name: string;
  }>;
};

let fixture: ChildProcess | null = null;
let session: BrowserSession;

async function configure(variant: string): Promise<void> {
  await fetch(`${APP}/__config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ variant }),
  });
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

describe('Web golden flow corpus (real Chrome)', () => {
  it('replays every flow with observable success', async () => {
    expect(corpus.flows.length).toBeGreaterThanOrEqual(20);
    const results: Array<Record<string, unknown>> = [];
    for (const entry of corpus.flows) {
      await fetch(`${APP}/__reset`, { method: 'POST' });
      await configure(entry.variant);
      const flow = JSON.parse(readFileSync(resolve(ROOT, entry.file), 'utf8')) as Flow;
      const page = await session.context.newPage();
      const driver = new PlaywrightDriver(page, { appScope: flow.app_scope.value });
      await driver.prepare();
      const engine = await WasmEngine.fromFile(WASM);
      const result = await runFlow({
        engine,
        driver,
        flow,
        variables: entry.variables,
        hooks: {
          approve: () => true,
          disambiguate: (candidates) => candidates[0]?.candidate.candidate_id ?? null,
          recover: () => 'stop',
        },
      });
      engine.dispose();
      await page.close();
      results.push({
        id: entry.id,
        name: entry.name,
        variant: entry.variant,
        status: result.status,
        state: result.state,
        error: result.error?.code ?? null,
        actions: result.actionLog.length,
      });
      expect(result.status, `${entry.id} ${entry.name}: ${JSON.stringify(result.error)}`).toBe(
        'succeeded',
      );
      expect(result.events.filter((event) => event.type === 'StepFailed')).toHaveLength(0);
    }
    mkdirSync(resolve(ROOT, 'artifacts'), { recursive: true });
    writeFileSync(
      resolve(ROOT, 'artifacts/web-golden-report.json'),
      JSON.stringify(
        {
          generated_at: new Date().toISOString(),
          flows: corpus.flows.length,
          succeeded: results.filter((item) => item.status === 'succeeded').length,
          results,
        },
        null,
        2,
      ),
    );
  }, 180_000);
});
