#!/usr/bin/env node
/**
 * Single quality gate. Every step is fail-closed; no "rerun until green".
 * NOT_RUN platform builds are explicitly excluded and reported in docs.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const env = { ...process.env };
const path = env.PATH ?? '';
if (existsSync(resolve(env.HOME ?? '/root', '.cargo/bin'))) {
  env.PATH = `${resolve(env.HOME ?? '/root', '.cargo/bin')}:${path}`;
}
if (!env.DISPLAY && existsSync('/tmp/.X11-unix/X1')) {
  env.DISPLAY = ':1';
  env.XAUTHORITY = env.XAUTHORITY ?? resolve(env.HOME ?? '/root', '.Xauthority');
}

const steps = [
  ['lockfile', 'pnpm', ['install', '--frozen-lockfile']],
  ['typecheck', 'node', ['scripts/typecheck.mjs']],
  ['rust format', 'cargo', ['fmt', '--all', '--', '--check']],
  ['rust clippy', 'cargo', ['clippy', '--workspace', '--all-targets', '--', '-D', 'warnings']],
  ['rust tests', 'cargo', ['test', '--workspace']],
  ['rust release', 'cargo', ['build', '--workspace', '--release']],
  [
    'wasm release',
    'cargo',
    ['build', '-p', 'ib-runtime', '--lib', '--release', '--target', 'wasm32-unknown-unknown'],
  ],
  ['js build', 'pnpm', ['-r', '--if-present', 'run', 'build']],
  ['tests (unit + e2e + drift + soak)', 'pnpm', ['exec', 'vitest', 'run']],
  ['lint', 'node', ['scripts/lint.mjs']],
  ['format check', 'pnpm', ['exec', 'prettier', '--check', '.']],
  ['sbom', 'node', ['scripts/sbom.mjs']],
];

const results = [];
for (const [name, command, args] of steps) {
  const started = Date.now();
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit' });
  const duration = ((Date.now() - started) / 1000).toFixed(1);
  results.push({ name, status: result.status, duration });
  if (result.status !== 0) {
    console.error(`\nGATE FAILED at: ${name} (${duration}s)`);
    process.exit(result.status ?? 1);
  }
  console.log(`\n✓ ${name} (${duration}s)`);
}
console.log('\nGATE PASSED');
for (const result of results) console.log(`  ${result.name}: ${result.duration}s`);
