#!/usr/bin/env node
/**
 * Headless web runner used by the editor's trial run and by CI.
 *
 *   ib-web run   --flow flow.json [--variables k=v] [--out result.json]
 *   ib-web record --url http://127.0.0.1:4317/ --out flow.json [--seconds 20]
 *   ib-web probe --url http://127.0.0.1:4317/
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import {
  loadFlow,
  validateFlowForExecution,
  type Flow,
  type Permission,
} from '@intentbridge/action-ir';
import { WasmEngine } from '@intentbridge/engine-wasm';
import { runFlow, type RunHooks } from '@intentbridge/web-core';
import { launchBrowser } from './browser.js';
import { preparePage, startRecording, stopRecording } from './recorder.js';
import { PlaywrightDriver } from './driver.js';

const here = dirname(fileURLToPath(import.meta.url));

function wasmPath(): string {
  return process.env.IB_WASM ?? resolve(here, '../../../packages/engine-wasm/wasm/ib_runtime.wasm');
}

interface Arguments {
  command: string;
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Arguments {
  const [command = 'help', ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index] as string;
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = rest[index + 1];
    if (next && !next.startsWith('--')) {
      flags[key] = next;
      index += 1;
    } else {
      flags[key] = true;
    }
  }
  return { command, flags };
}

function parseVariables(raw: string | boolean | undefined): Record<string, unknown> {
  if (typeof raw !== 'string' || !raw.trim()) return {};
  const output: Record<string, unknown> = {};
  for (const pair of raw.split(',')) {
    const [key, ...rest] = pair.split('=');
    if (!key || rest.length === 0) continue;
    const value = rest.join('=');
    if (value === 'true') output[key.trim()] = true;
    else if (value === 'false') output[key.trim()] = false;
    else if (/^-?\d+(\.\d+)?$/.test(value)) output[key.trim()] = Number(value);
    else output[key.trim()] = value;
  }
  return output;
}

function pickHook(flag: string | boolean | undefined) {
  return (
    candidates: Array<{
      candidate: { candidate_id: string; semantic?: { test_id?: string; name?: string } | null };
    }>,
  ): string | null => {
    if (typeof flag !== 'string' || flag.length === 0) return null;
    if (flag === 'first') return candidates[0]?.candidate.candidate_id ?? null;
    if (flag.startsWith('testid:')) {
      const testId = flag.slice('testid:'.length);
      return (
        candidates.find((item) => item.candidate.semantic?.test_id === testId)?.candidate
          .candidate_id ?? null
      );
    }
    if (flag.startsWith('name:')) {
      const name = flag.slice('name:'.length);
      return (
        candidates.find((item) => item.candidate.semantic?.name === name)?.candidate.candidate_id ??
        null
      );
    }
    return (
      candidates.find((item) => item.candidate.candidate_id === flag)?.candidate.candidate_id ??
      null
    );
  };
}

async function commandRun(flags: Record<string, string | boolean>): Promise<number> {
  if (typeof flags.flow !== 'string') throw new Error('--flow is required');
  const raw = JSON.parse(await readFile(resolve(flags.flow), 'utf8')) as unknown;
  const loaded = loadFlow(raw, { forExecution: true });
  if (!loaded.flow) {
    console.error(
      JSON.stringify(
        {
          status: 'failed',
          error: { code: 'INVALID_IR', message: 'flow validation failed' },
          diagnostics: loaded.report.diagnostics,
        },
        null,
        2,
      ),
    );
    return 2;
  }
  const flow: Flow = loaded.flow;
  const variables = parseVariables(flags.variables);
  const evidenceDir = typeof flags.evidence === 'string' ? resolve(flags.evidence) : undefined;
  if (evidenceDir) await mkdir(evidenceDir, { recursive: true });
  const session = await launchBrowser({ headless: flags.headless !== false });
  const driver = new PlaywrightDriver(session.page, {
    appScope: flow.app_scope.value,
    ...(evidenceDir ? { evidenceDir } : {}),
    ...(typeof flags.url === 'string' ? {} : {}),
  });
  await preparePage(session.page);
  if (typeof flags.url === 'string') {
    await session.page.goto(flags.url, { waitUntil: 'domcontentloaded' });
  }

  const hooks: RunHooks = {
    ...(flags.approve ? { approve: () => true } : {}),
    disambiguate: pickHook(flags.pick) as RunHooks['disambiguate'],
    ...(typeof flags.outcome === 'string'
      ? { decideOutcome: () => flags.outcome as 'succeeded' | 'failed' | 'retry' }
      : {}),
    ...(typeof flags.recovery === 'string' ? { recover: () => flags.recovery as string } : {}),
    onPause: async (directive) => {
      if (!evidenceDir) return;
      const candidateId =
        (directive as { candidates?: Array<{ candidate: { candidate_id: string } }> })
          .candidates?.[0]?.candidate.candidate_id ??
        driver.lastSnapshot?.candidates.find((candidate) => candidate.in_viewport)?.candidate_id;
      const candidate = driver.lastSnapshot?.candidates.find(
        (item) => item.candidate_id === candidateId,
      );
      if (candidate?.rect) {
        await driver.captureEvidence({
          stepId: String((directive as { step_id?: string }).step_id ?? 'pause'),
          rect: candidate.rect,
          label: 'paused',
        });
      }
    },
  };

  const engine = await WasmEngine.fromFile(wasmPath());
  const result = await runFlow({ engine, driver, flow, variables, hooks });
  await session.close();

  const runDirectory = evidenceDir ? dirname(resolve(evidenceDir, 'run.json')) : undefined;
  const summary = {
    status: result.status,
    state: result.state,
    error: result.error,
    pending: result.pending ? { kind: (result.pending as { kind?: string }).kind } : null,
    events: result.events.length,
    action_log: result.actionLog,
    metrics: {
      planner_p95_ms: result.metrics.planner_p95_ms,
      total_elapsed_ms: result.metrics.total_elapsed_ms,
    },
    flow_id: flow.flow_id,
  };
  if (runDirectory) {
    await writeFile(resolve(runDirectory, 'events.json'), JSON.stringify(result.events, null, 2));
  }
  if (typeof flags.out === 'string') {
    await writeFile(resolve(flags.out), JSON.stringify({ summary, result }, null, 2));
  }
  console.log(JSON.stringify(summary, null, 2));
  return result.status === 'succeeded' ? 0 : 2;
}

async function commandRecord(flags: Record<string, string | boolean>): Promise<number> {
  if (typeof flags.url !== 'string') throw new Error('--url is required');
  const out = typeof flags.out === 'string' ? resolve(flags.out) : resolve('recorded.flow.json');
  const session = await launchBrowser({ headless: false });
  await preparePage(session.page);
  await session.page.goto(flags.url, { waitUntil: 'domcontentloaded' });
  await startRecording(session.page);
  console.log('Recording. Interact with the page, then press Enter to stop.');
  if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin });
    await new Promise<void>((resolvePromise) => rl.question('', () => resolvePromise()));
    rl.close();
  } else {
    const seconds = Number(flags.seconds ?? 20);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, seconds * 1000));
  }
  const recording = await stopRecording(session.page);
  const { buildFlowFromRecording } = await import('@intentbridge/web-core');
  const built = buildFlowFromRecording(recording, {
    name: typeof flags.name === 'string' ? flags.name : undefined,
  });
  const validation = validateFlowForExecution(built.flow);
  await session.close();
  await writeFile(out, JSON.stringify(built.flow, null, 2));
  console.log(
    JSON.stringify(
      {
        out,
        steps: built.flow.steps.length,
        warnings: built.warnings,
        valid: validation.ok,
        errors: validation.errors,
      },
      null,
      2,
    ),
  );
  return validation.ok ? 0 : 2;
}

async function commandProbe(flags: Record<string, string | boolean>): Promise<number> {
  if (typeof flags.url !== 'string') throw new Error('--url is required');
  const session = await launchBrowser({ headless: flags.headless !== false });
  const driver = new PlaywrightDriver(session.page, { appScope: flags.url });
  await driver.prepare();
  await session.page.goto(flags.url, { waitUntil: 'domcontentloaded' });
  const snapshot = await driver.snapshot();
  await session.close();
  const summary = snapshot.candidates.slice(0, 30).map((candidate) => ({
    id: candidate.candidate_id,
    role: candidate.semantic?.role,
    name: candidate.semantic?.name,
    test_id: candidate.semantic?.test_id,
    path: candidate.structure?.path,
    visible: candidate.visible,
    enabled: candidate.enabled,
  }));
  const payload = { url: snapshot.url, title: snapshot.title, candidates: summary };
  if (typeof flags.out === 'string')
    await writeFile(resolve(flags.out), JSON.stringify(payload, null, 2));
  console.log(JSON.stringify(payload, null, 2));
  return 0;
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  let code = 0;
  if (command === 'run') code = await commandRun(flags);
  else if (command === 'record') code = await commandRecord(flags);
  else if (command === 'probe') code = await commandProbe(flags);
  else {
    console.log('usage: ib-web run|record|probe [flags]');
    code = command === 'help' ? 0 : 1;
  }
  process.exitCode = code;
}

main().catch((error) => {
  console.error(JSON.stringify({ status: 'failed', error: String(error) }));
  process.exitCode = 3;
});
