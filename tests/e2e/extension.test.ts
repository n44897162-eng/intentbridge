import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type BrowserContext, type Page, type Worker } from 'playwright';

const ROOT = resolve(__dirname, '../..');
const EXTENSION = resolve(ROOT, 'apps/web-extension/dist');
const APP = 'http://127.0.0.1:4317';
const hasDisplay = existsSync('/tmp/.X11-unix/X1') || Boolean(process.env.DISPLAY);

let context: BrowserContext | null = null;
let worker: Worker;
let extensionId = '';
let userDataDir = '';
let fixture: ChildProcess | null = null;

async function ensureFixture(): Promise<void> {
  try {
    if ((await fetch(`${APP}/__health`)).ok) {
      await fetch(`${APP}/__reset`, { method: 'POST' });
      return;
    }
  } catch {
    /* spawn */
  }
  fixture = spawn(process.execPath, [resolve(ROOT, 'fixtures/web-fixture/server.mjs')], {
    stdio: 'ignore',
  });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      if ((await fetch(`${APP}/__health`)).ok) {
        await fetch(`${APP}/__reset`, { method: 'POST' });
        return;
      }
    } catch {
      /* retry */
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
  }
  throw new Error('fixture did not start');
}

beforeAll(async () => {
  if (!hasDisplay) return;
  userDataDir = mkdtempSync(join(tmpdir(), 'ib-ext-'));
  context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    env: {
      ...process.env,
      DISPLAY: process.env.DISPLAY ?? ':1',
      XAUTHORITY: process.env.XAUTHORITY ?? '/root/.Xauthority',
    },
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      `--disable-extensions-except=${EXTENSION}`,
      `--load-extension=${EXTENSION}`,
    ],
    viewport: { width: 1280, height: 900 },
  });
  worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent('serviceworker', { timeout: 30_000 }));
  extensionId = new URL(worker.url()).host;
  await ensureFixture();
}, 60_000);

afterAll(async () => {
  await context?.close();
  fixture?.kill('SIGTERM');
  if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
});

describe.skipIf(!hasDisplay)('MV3 extension (real Chromium)', () => {
  it('declares a least-privilege manifest', () => {
    const manifest = JSON.parse(readFileSync(join(EXTENSION, 'manifest.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(manifest['manifest_version']).toBe(3);
    expect(manifest['host_permissions']).toBeUndefined();
    const optional = (manifest['optional_host_permissions'] as string[]) ?? [];
    expect(optional).not.toContain('<all_urls>');
    expect(manifest['content_scripts']).toBeUndefined();
    const csp = (manifest['content_security_policy'] as Record<string, string>)['extension_pages'];
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("'wasm-unsafe-eval'");
  });

  it('starts the service worker and packages the WASM engine', async () => {
    expect(extensionId).toMatch(/^[a-p]{32}$/);
    const wasmStatus = await worker.evaluate(async () => {
      const response = await fetch(chrome.runtime.getURL('ib_runtime.wasm'));
      return { status: response.status, bytes: (await response.arrayBuffer()).byteLength };
    });
    expect(wasmStatus.status).toBe(200);
    expect(wasmStatus.bytes).toBeGreaterThan(100_000);
  });

  it('renders the popup with record and run controls', async () => {
    const page = await context!.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`, {
      waitUntil: 'domcontentloaded',
    });
    await page.getByText('IntentBridge').waitFor({ timeout: 10_000 });
    expect(await page.getByRole('button', { name: '开始录制' }).count()).toBe(1);
    await page.getByText('还没有流程').waitFor({ timeout: 10_000 });
    expect(await page.getByText('授权当前站点').count()).toBe(1);
    await page.close();
  });

  it('observes, records and performs DOM actions through the content script', async () => {
    const page: Page = await context!.newPage();
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>)['__ibTestMessages'] = [];
      (window as unknown as Record<string, unknown>)['chrome'] = {
        runtime: {
          onMessage: {
            addListener: (listener: unknown) => {
              (window as unknown as Record<string, unknown>)['__ibTestListener'] = listener;
            },
          },
        },
      };
    });
    await page.goto(`${APP}/`, { waitUntil: 'domcontentloaded' });
    await page.addScriptTag({ path: join(EXTENSION, 'content.js') });
    const ping = await page.evaluate(
      () =>
        new Promise((resolvePromise) => {
          const listener = (window as unknown as Record<string, unknown>)['__ibTestListener'] as (
            message: unknown,
            sender: unknown,
            send: (value: unknown) => void,
          ) => boolean;
          listener({ type: 'ib:ping' }, null, (value) => resolvePromise(value));
        }),
    );
    expect((ping as { ok: boolean; url: string }).ok).toBe(true);
    expect((ping as { url: string }).url).toContain('127.0.0.1:4317');

    const snapshot = await page.evaluate(
      () =>
        new Promise((resolvePromise) => {
          const listener = (window as unknown as Record<string, unknown>)['__ibTestListener'] as (
            message: unknown,
            sender: unknown,
            send: (value: unknown) => void,
          ) => boolean;
          listener({ type: 'ib:snapshot' }, null, (value) => resolvePromise(value));
        }),
    );
    const candidates =
      (
        snapshot as {
          snapshot: {
            candidates: Array<{ candidate_id: string; semantic?: { test_id?: string } }>;
          };
        }
      ).snapshot?.candidates ?? [];
    const input = candidates.find((candidate) => candidate.semantic?.test_id === 'keyword-input');
    expect(input).toBeTruthy();

    await page.evaluate(
      (request) =>
        new Promise((resolvePromise) => {
          const listener = (window as unknown as Record<string, unknown>)['__ibTestListener'] as (
            message: unknown,
            sender: unknown,
            send: (value: unknown) => void,
          ) => boolean;
          listener({ type: 'ib:act', request }, null, (value) => resolvePromise(value));
        }),
      {
        step_id: 'type-keyword',
        attempt_id: 'attempt-1',
        action: 'input',
        candidate_id: input?.candidate_id,
        frame_path: [],
        selector: null,
        params: { value: '组件测试', clear_first: true },
        target: null,
        risk: 'normal',
        idempotency_key: null,
      },
    );
    expect(await page.locator('[data-testid="keyword-input"]').inputValue()).toBe('组件测试');
    await page.close();
  }, 60_000);
});
