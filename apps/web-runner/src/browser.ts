import { existsSync } from 'node:fs';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

export interface LaunchOptions {
  headless?: boolean;
  viewport?: { width: number; height: number };
}

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  close: () => Promise<void>;
}

function chromeExecutable(): string | undefined {
  const candidates = [
    process.env.IB_CHROME,
    process.env.CHROME_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter((value): value is string => Boolean(value));
  return candidates.find((candidate) => existsSync(candidate));
}

/** Launches the system Chrome (no downloaded browser is required). */
export async function launchBrowser(options: LaunchOptions = {}): Promise<BrowserSession> {
  const executablePath = chromeExecutable();
  const browser = await chromium.launch({
    headless: options.headless ?? true,
    ...(executablePath ? { executablePath } : { channel: 'chrome' }),
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  const context = await browser.newContext({
    viewport: options.viewport ?? { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    locale: 'zh-CN',
  });
  const page = await context.newPage();
  return {
    browser,
    context,
    page,
    close: async () => {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    },
  };
}
