/** Programmatic recording helpers shared by the CLI and the e2e tests. */
import type { Page } from 'playwright';
import {
  buildFlowFromRecording,
  installHelpersInPage,
  installRecorderInPage,
  stopRecorderInPage,
  type BuildOptions,
  type Recording,
  type SnapshotResult,
} from '@intentbridge/web-core';

export async function preparePage(page: Page): Promise<void> {
  // addInitScript serialises the function, so a second function reference would
  // be lost. Inline both so a navigated document can restore the recorder state.
  const init = `(${installHelpersInPage.toString()})();\n(function(){try{if(window.sessionStorage.getItem('__ibRecorderState')){(${installRecorderInPage.toString()})();}}catch(e){}})();`;
  await page.addInitScript({ content: init });
  try {
    await page.evaluate(installHelpersInPage);
  } catch {
    /* about:blank */
  }
}

export interface RecordingSession {
  initialTestIds: string[];
  initialUrl: string;
}

export async function startRecording(page: Page): Promise<RecordingSession> {
  await preparePage(page);
  const snapshot = (await page.evaluate(() => {
    const helpers = (window as unknown as Record<string, any>).__ibHelpers;
    return helpers?.snapshot({ max: 400 }) ?? null;
  })) as SnapshotResult | null;
  const initialTestIds = (snapshot?.candidates ?? [])
    .map((candidate) => candidate.semantic?.test_id)
    .filter((value): value is string => Boolean(value));
  await page.evaluate(installRecorderInPage, { reset: true });
  return { initialTestIds, initialUrl: page.url() };
}

export async function stopRecording(page: Page): Promise<Recording> {
  return (await page.evaluate(stopRecorderInPage)) as Recording;
}

export async function recordFlow(
  page: Page,
  perform: () => Promise<void>,
  options: BuildOptions = {},
): Promise<{
  recording: Recording;
  flow: ReturnType<typeof buildFlowFromRecording>['flow'];
  warnings: string[];
}> {
  const session = await startRecording(page);
  await perform();
  await page.waitForTimeout(450);
  const recording = await stopRecording(page);
  const built = buildFlowFromRecording(recording, {
    ...options,
    initialTestIds: options.initialTestIds ?? session.initialTestIds,
  });
  return { recording, flow: built.flow, warnings: built.warnings };
}
