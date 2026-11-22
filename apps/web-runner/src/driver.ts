/**
 * Playwright implementation of the browser driver. It performs OS-level input
 * through the real browser, never by evaluating page scripts to "click".
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { FrameLocator, Locator, Page } from 'playwright';
import { PNG } from 'pngjs';
import type {
  BrowserDriver,
  DriverActResult,
  DriverFacts,
  ActionRequest,
} from '@intentbridge/web-core';
import { dhashFromRgba, installHelpersInPage, type SnapshotResult } from '@intentbridge/web-core';
import type { Target } from '@intentbridge/action-ir';

export interface PlaywrightDriverOptions {
  appScope: string;
  evidenceDir?: string;
  secrets?: Record<string, string>;
  actionTimeoutMs?: number;
  onEvidence?: (info: {
    stepId: string;
    path: string;
    sha256: string;
    width: number;
    height: number;
  }) => void;
}

function errorResult(code: string, message: string): DriverActResult {
  return { error: { code, message } };
}

export class PlaywrightDriver implements BrowserDriver {
  private readonly page: Page;
  private readonly options: PlaywrightDriverOptions;
  private readonly startedAt = performance.now();
  lastSnapshot: SnapshotResult | null = null;

  constructor(page: Page, options: PlaywrightDriverOptions) {
    this.page = page;
    this.options = options;
  }

  now(): number {
    return performance.now() - this.startedAt;
  }

  wallTime(): number {
    return Date.now();
  }

  async prepare(): Promise<void> {
    await this.page.addInitScript(installHelpersInPage);
    try {
      await this.page.evaluate(installHelpersInPage);
    } catch {
      /* about:blank may reject init scripts; navigation will install them */
    }
  }

  async snapshot(): Promise<SnapshotResult> {
    const result = await this.page.evaluate(() => {
      const helpers = (window as unknown as Record<string, any>).__ibHelpers;
      if (!helpers) return null;
      return helpers.snapshot({ max: 400 });
    });
    if (!result) {
      await this.prepare();
      const retry = await this.page.evaluate(() => {
        const helpers = (window as unknown as Record<string, any>).__ibHelpers;
        return helpers?.snapshot({ max: 400 }) ?? null;
      });
      if (!retry) throw new Error('snapshot helpers are unavailable on this page');
      this.lastSnapshot = retry as SnapshotResult;
      return this.lastSnapshot;
    }
    this.lastSnapshot = result as SnapshotResult;
    return this.lastSnapshot;
  }

  async facts(): Promise<DriverFacts> {
    return this.page.evaluate(() => {
      const helpers = (window as unknown as Record<string, any>).__ibHelpers;
      return {
        url: location.href,
        origin: location.origin,
        title: document.title,
        window_stable_ms: helpers?.stableMs?.() ?? 0,
      };
    });
  }

  private locate(request: ActionRequest): Locator | FrameLocator {
    let target: Page | FrameLocator = this.page;
    for (const frameSelector of request.frame_path) {
      target = (target as FrameLocator).frameLocator(frameSelector);
    }
    const selector = request.selector ?? `[data-ib-candidate="${request.candidate_id ?? ''}"]`;
    return (target as Page).locator(selector);
  }

  private async resolveLocator(request: ActionRequest): Promise<Locator> {
    if (!request.candidate_id) return this.locate(request) as Locator;
    const locator = this.locate(request) as Locator;
    const count = await locator.count();
    if (count === 0) throw new StaleCandidateError();
    if (count > 1) throw new AmbiguousCandidateError();
    return locator.first();
  }

  async act(request: ActionRequest): Promise<DriverActResult> {
    const timeout = this.options.actionTimeoutMs ?? 10_000;
    try {
      switch (request.action) {
        case 'launch': {
          const url = String(request.params.url ?? this.options.appScope);
          await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
          await this.page.waitForLoadState('load', { timeout: 20_000 }).catch(() => {});
          await this.page.evaluate(installHelpersInPage).catch(() => {});
          return {};
        }
        case 'activate': {
          await this.page.bringToFront();
          return {};
        }
        case 'click': {
          const locator = await this.resolveLocator(request);
          await locator.click({
            button: (request.params.button as 'left' | 'right' | 'middle') ?? 'left',
            clickCount: Number(request.params.click_count ?? 1),
            timeout,
            force: false,
          });
          return {};
        }
        case 'input': {
          const locator = await this.resolveLocator(request);
          const value = String(request.params.value ?? '');
          const editable = await locator.evaluate((element) => {
            const node = element as HTMLInputElement | HTMLTextAreaElement;
            if (node.isContentEditable) return true;
            if ('readOnly' in node && node.readOnly) return false;
            if ('disabled' in node && node.disabled) return false;
            return true;
          });
          if (!editable) return errorResult('PRECONDITION_FAILED', 'target is not editable');
          if (Number(request.params.typing_delay_ms ?? 0) > 0) {
            await locator.fill('');
            await locator.pressSequentially(value, {
              delay: Number(request.params.typing_delay_ms),
              timeout,
            });
          } else {
            await locator.fill(value, { timeout });
          }
          if (request.params.submit === true) await locator.press('Enter', { timeout });
          return {};
        }
        case 'select': {
          const locator = await this.resolveLocator(request);
          const by = String(request.params.by ?? 'value');
          const value = String(request.params.value ?? '');
          if (by === 'label') await locator.selectOption({ label: value }, { timeout });
          else if (by === 'index')
            await locator.selectOption({ index: Number(value) }, { timeout });
          else await locator.selectOption({ value }, { timeout });
          return {};
        }
        case 'scroll': {
          const direction = String(request.params.direction ?? 'down');
          const amount = Number(request.params.amount ?? 600);
          const signed = direction === 'up' || direction === 'left' ? -amount : amount;
          if (request.candidate_id) {
            const locator = await this.resolveLocator(request);
            await locator.hover({ timeout });
          }
          if (direction === 'left' || direction === 'right') {
            await this.page.mouse.wheel(signed, 0);
          } else {
            await this.page.mouse.wheel(0, signed);
          }
          return {};
        }
        case 'read-text': {
          const locator = await this.resolveLocator(request);
          const text = await locator.evaluate((element) => {
            const node = element as HTMLInputElement | HTMLTextAreaElement;
            if ('value' in node && typeof node.value === 'string' && node.tagName !== 'BUTTON') {
              return node.value;
            }
            return (element as HTMLElement).innerText ?? element.textContent ?? '';
          });
          const max = Number(request.params.max_chars ?? 10_000);
          return { text: String(text).slice(0, max) };
        }
        case 'wait':
        case 'assert':
        case 'branch':
        case 'set-variable':
        case 'compensate':
        case 'end':
          return errorResult(
            'INVALID_STATE',
            `action ${request.action} must not reach the browser driver`,
          );
        default:
          return errorResult('UNSUPPORTED_CAPABILITY', `unsupported web action ${request.action}`);
      }
    } catch (error) {
      if (error instanceof StaleCandidateError) {
        return errorResult('STALE_TARGET', 'resolved element is detached or was replaced');
      }
      if (error instanceof AmbiguousCandidateError) {
        return errorResult('TARGET_AMBIGUOUS', 'multiple elements match the resolved candidate');
      }
      const message = (error as Error).message ?? String(error);
      if (/timeout/i.test(message)) return errorResult('TIMEOUT', message.slice(0, 300));
      if (/not visible|not attached|detached|element is not/i.test(message)) {
        return errorResult('STALE_TARGET', message.slice(0, 300));
      }
      return errorResult('INTERNAL_ERROR', message.slice(0, 300));
    }
  }

  /** Computes dHash evidence for candidates when the flow uses a visual anchor. */
  async enrichVisuals(snapshot: SnapshotResult, target: Target | null): Promise<void> {
    if (!target?.anchors.visual?.dhash) return;
    let png: PNG;
    try {
      png = PNG.sync.read(await this.page.screenshot({ type: 'png' }));
    } catch {
      return;
    }
    const scaleX = png.width / Math.max(1, snapshot.viewport.w);
    const scaleY = png.height / Math.max(1, snapshot.viewport.h);
    for (const candidate of snapshot.candidates) {
      const rect = candidate.rect;
      if (!rect || rect.w < 2 || rect.h < 2) continue;
      const x = Math.max(0, Math.min(png.width - 1, Math.round(rect.x * scaleX)));
      const y = Math.max(0, Math.min(png.height - 1, Math.round(rect.y * scaleY)));
      const w = Math.max(1, Math.min(png.width - x, Math.round(rect.w * scaleX)));
      const h = Math.max(1, Math.min(png.height - y, Math.round(rect.h * scaleY)));
      const crop = new Uint8ClampedArray(w * h * 4);
      for (let row = 0; row < h; row += 1) {
        const sourceStart = ((y + row) * png.width + x) * 4;
        crop.set(png.data.subarray(sourceStart, sourceStart + w * 4), row * w * 4);
      }
      try {
        candidate.visual = { ...(candidate.visual ?? {}), dhash: dhashFromRgba(crop, w, h) };
      } catch {
        /* ignore malformed crops */
      }
    }
  }

  async sleep(ms: number): Promise<void> {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
  }

  async secret(alias: string): Promise<string> {
    const fromMap = this.options.secrets?.[alias];
    if (fromMap) return fromMap;
    const envKey = `IB_SECRET_${alias.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
    const fromEnv = process.env[envKey];
    if (fromEnv) return fromEnv;
    throw new Error(`SECRET_NOT_FOUND: ${alias}`);
  }

  /** Saves a cropped, optionally masked screenshot for a failed step. */
  async captureEvidence(options: {
    stepId: string;
    rect: { x: number; y: number; w: number; h: number };
    maskSelectors?: string[];
    label?: string;
    framePath?: string[];
  }): Promise<{ path: string; sha256: string; width: number; height: number } | null> {
    if (!this.options.evidenceDir) return null;
    if (options.framePath && options.framePath.length > 0) {
      // Frame-relative rects cannot be mapped to a page clip reliably.
      return null;
    }
    const viewport = await this.page.evaluate(() => ({
      w: window.innerWidth,
      h: window.innerHeight,
      x: window.scrollX,
      y: window.scrollY,
    }));
    const padding = 32;
    const x = Math.max(0, Math.floor(options.rect.x + viewport.x - padding));
    const y = Math.max(0, Math.floor(options.rect.y + viewport.y - padding));
    const width = Math.min(viewport.w, Math.ceil(options.rect.w + padding * 2));
    const height = Math.min(viewport.h, Math.ceil(options.rect.h + padding * 2));
    if (width < 2 || height < 2) return null;
    const masks = [...(options.maskSelectors ?? []), 'input[type="password"]']
      .map((selector) => this.page.locator(selector))
      .slice(0, 8);
    const buffer = await this.page.screenshot({
      type: 'png',
      clip: { x, y, width, height },
      mask: masks.length > 0 ? masks : undefined,
    });
    const directory = resolve(this.options.evidenceDir);
    await mkdir(directory, { recursive: true });
    const safeLabel = (options.label ?? options.stepId)
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .slice(0, 60);
    const path = resolve(directory, `${Date.now()}-${safeLabel}.png`);
    await writeFile(path, buffer);
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    this.options.onEvidence?.({ stepId: options.stepId, path, sha256, width, height });
    return { path, sha256, width, height };
  }
}

class StaleCandidateError extends Error {}
class AmbiguousCandidateError extends Error {}
