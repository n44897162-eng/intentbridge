import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type AppInstance } from '@intentbridge/web-shell';
import { launchBrowser, type BrowserSession } from '@intentbridge/web-runner';
import type { Flow } from '@intentbridge/action-ir';

const ROOT = resolve(__dirname, '../..');
const APP = 'http://127.0.0.1:4317';
const golden = JSON.parse(
  readFileSync(resolve(ROOT, 'fixtures/flows/web-basic.flow.json'), 'utf8'),
) as Flow;
const semantic = JSON.parse(
  readFileSync(resolve(ROOT, 'fixtures/flows/web-drift-semantic.flow.json'), 'utf8'),
) as Flow;

let app: AppInstance;
let session: BrowserSession;
let fixture: ChildProcess | null = null;
let dataDir: string;

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${app.port}${path}`, {
    method,
    headers: {
      'x-ib-token': app.token,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function ensureFixture(): Promise<void> {
  try {
    if ((await fetch(`${APP}/__health`)).ok) return;
  } catch {
    /* spawn below */
  }
  fixture = spawn(process.execPath, [resolve(ROOT, 'fixtures/web-fixture/server.mjs')], {
    stdio: 'ignore',
  });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      if ((await fetch(`${APP}/__health`)).ok) return;
    } catch {
      /* retry */
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
  }
  throw new Error('fixture server did not start');
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'ib-shell-ui-'));
  app = await createApp({ dataDir, port: 0, token: 'ui-token-0123456789' });
  await ensureFixture();
  session = await launchBrowser({ headless: true });
});

afterAll(async () => {
  await session?.close();
  await app.close();
  fixture?.kill('SIGTERM');
  rmSync(dataDir, { recursive: true, force: true });
});

describe('management UI end-to-end', () => {
  it('opens a flow, edits JSON, saves a revision and runs it', async () => {
    await fetch(`${APP}/__reset`, { method: 'POST' });
    const imported = await call('POST', '/api/flows/import', { document: golden });
    expect(imported.status).toBe(201);
    const page = await session.context.newPage();
    page.on('pageerror', (error) => console.log('PAGEERROR', error.message));
    await page.goto(`${app.url}#/flows`, { waitUntil: 'domcontentloaded' });
    await page.getByText('Web 搜索并读取结果').first().click();
    await page.getByRole('button', { name: 'JSON', exact: true }).click();
    const editor = page.locator('textarea').first();
    const parsed = JSON.parse(await editor.inputValue()) as Flow;
    parsed.name = 'UI 修改流程';
    await editor.fill(JSON.stringify(parsed, null, 2));
    await page.getByRole('button', { name: '应用 JSON' }).click();
    await page.getByText('已保存为 r2').waitFor({ timeout: 10_000 });
    const record = (await (await call('GET', `/api/flows/${golden.flow_id}`)).json()) as {
      revision: number;
      flow: Flow;
    };
    expect(record.revision).toBe(2);
    expect(record.flow.name).toBe('UI 修改流程');

    await page.getByRole('button', { name: '运行记录' }).click();
    await page.locator('.field input').first().fill('季度');
    await page.getByRole('button', { name: '开始运行' }).click();
    await page.waitForURL(/#\/runs\/run-/, { timeout: 10_000 });
    await page.waitForFunction(() => document.body.innerText.includes('SUCCEEDED'), null, {
      timeout: 45_000,
    });
    expect(await page.locator('.timeline').innerText()).toContain('StepSucceeded');
    expect(await page.locator('.timeline').innerText()).toContain('RunFinished');

    // The target inspector must show the real ranked candidates of the latest run.
    await page.goto(`${app.url}#/flows/${golden.flow_id}`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: '目标检查器' }).click();
    await page.getByText('最近一次候选评分').waitFor({ timeout: 10_000 });
    await page.locator('.table tbody tr').first().waitFor({ timeout: 10_000 });
    expect(await page.locator('.table tbody tr').count()).toBeGreaterThan(0);
    await page.close();
  }, 90_000);

  it('pauses for disambiguation, shows candidates, resumes and stores evidence', async () => {
    await fetch(`${APP}/__reset`, { method: 'POST' });
    await fetch(`${APP}/__config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ variant: 'relabeled' }),
    });
    const flow = JSON.parse(JSON.stringify(semantic)) as Flow;
    flow.flow_id = crypto.randomUUID();
    const imported = await call('POST', '/api/flows/import', { document: flow });
    expect(imported.status).toBe(201);
    const start = await call('POST', `/api/flows/${flow.flow_id}/runs`, {
      variables: { keyword: '报告' },
      auto_approve: false,
      trigger: 'trial',
    });
    expect(start.status).toBe(202);
    const runId = ((await start.json()) as { run_id: string }).run_id;
    let pending: string | null = null;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const detail = (await (await call('GET', `/api/runs/${runId}`)).json()) as {
        run: { status: string; pending: { kind: string } | null };
      };
      if (detail.run.pending?.kind === 'disambiguation') {
        pending = 'disambiguation';
        break;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
    expect(pending).toBe('disambiguation');

    const page = await session.context.newPage();
    await page.goto(`${app.url}#/runs/${runId}`, { waitUntil: 'domcontentloaded' });
    await page.getByText('需要确认目标').waitFor({ timeout: 10_000 });
    const candidates = page.locator('button.candidate');
    expect(await candidates.count()).toBeGreaterThanOrEqual(1);
    // One decision goes through the UI; the rest are driven through the same API.
    await candidates.first().click();
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
      const detail = (await (await call('GET', `/api/runs/${runId}`)).json()) as {
        run: {
          status: string;
          pending: {
            kind: string;
            payload: { candidates?: Array<{ candidate: { candidate_id: string } }> };
          } | null;
        };
      };
      if (['succeeded', 'failed', 'cancelled'].includes(detail.run.status)) break;
      const pendingNext = detail.run.pending;
      if (pendingNext?.kind === 'disambiguation') {
        const pick = pendingNext.payload.candidates?.[0]?.candidate.candidate_id;
        if (pick)
          await call('POST', `/api/runs/${runId}/decision`, {
            kind: 'disambiguation',
            value: pick,
          });
      } else if (pendingNext?.kind === 'approval') {
        await call('POST', `/api/runs/${runId}/decision`, { kind: 'approval', value: true });
      } else if (pendingNext?.kind === 'outcome') {
        await call('POST', `/api/runs/${runId}/decision`, { kind: 'outcome', value: 'failed' });
      } else if (pendingNext?.kind === 'recovery') {
        await call('POST', `/api/runs/${runId}/decision`, { kind: 'recovery', value: 'stop' });
      }
    }
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body.innerText.includes('SUCCEEDED'), null, {
      timeout: 30_000,
    });
    const evidence = (await (await call('GET', `/api/runs/${runId}/evidence`)).json()) as {
      evidence: Array<{ id: string }>;
    };
    expect(evidence.evidence.length).toBeGreaterThanOrEqual(1);
    const image = page.locator('.evidence-grid img').first();
    await image.waitFor({ timeout: 10_000 });
    expect(
      await image.evaluate((element) => (element as HTMLImageElement).naturalWidth),
    ).toBeGreaterThan(0);
    await page.close();
  }, 90_000);

  it('opens a 1000-step flow in under two seconds', async () => {
    const flow = JSON.parse(JSON.stringify(golden)) as Flow;
    flow.flow_id = crypto.randomUUID();
    flow.name = '千步流程';
    flow.steps = Array.from({ length: 999 }, (_, index) => ({
      id: `wait-${index}`,
      action: 'wait' as const,
      params: { condition: { kind: 'window-stable', min_stable_ms: 10 } },
    }));
    flow.steps.push({ id: 'done', action: 'end', params: { status: 'success' } });
    const imported = await call('POST', '/api/flows/import', { document: flow });
    expect(imported.status).toBe(201);
    const page = await session.context.newPage();
    const started = Date.now();
    await page.goto(`${app.url}#/flows/${flow.flow_id}`, { waitUntil: 'domcontentloaded' });
    await page.locator('.step-row').nth(999).waitFor({ timeout: 10_000 });
    const elapsed = Date.now() - started;
    console.log(JSON.stringify({ metric: 'editor_open_1000_steps_ms', elapsed }));
    expect(await page.locator('.step-row').count()).toBe(1000);
    expect(elapsed).toBeLessThan(2000);
    await page.close();
  }, 60_000);
});
