#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const out = resolve(root, 'artifacts');
mkdirSync(resolve(out, 'android'), { recursive: true });
mkdirSync(resolve(out, 'windows'), { recursive: true });
const hashes = [];
let missing = 0;

function copy(source, destination) {
  if (!existsSync(source)) {
    console.log('MISSING', source);
    missing += 1;
    return;
  }
  copyFileSync(source, destination);
  hash(destination);
  console.log('packaged', destination.slice(root.length + 1));
}

function hash(path) {
  const bytes = readFileSync(path);
  hashes.push(
    `${createHash('sha256').update(bytes).digest('hex')}  ${path.slice(root.length + 1)}`,
  );
}

copy(
  resolve(root, 'apps/android-app/app/build/outputs/apk/debug/app-debug.apk'),
  resolve(out, 'android/IntentBridge-0.1.0-debug.apk'),
);
copy(
  resolve(root, 'fixtures/android-fixture/app/build/outputs/apk/debug/app-debug.apk'),
  resolve(out, 'android/IntentBridgeFixture-0.1.0-debug.apk'),
);
for (const name of [
  'IntentBridge.Executor.dll',
  'IntentBridge.Executor.deps.json',
  'IntentBridge.Executor.runtimeconfig.json',
]) {
  copy(
    resolve(root, 'apps/windows-executor/bin/Release/net8.0-windows', name),
    resolve(out, 'windows', name),
  );
}
for (const name of [
  'IntentBridge.Fixture.dll',
  'IntentBridge.Fixture.deps.json',
  'IntentBridge.Fixture.runtimeconfig.json',
]) {
  copy(
    resolve(root, 'fixtures/windows-fixture/bin/Release/net8.0-windows', name),
    resolve(out, 'windows', name),
  );
}

const extensionZip = resolve(out, 'intentbridge-extension-0.1.0.zip');
if (existsSync(resolve(root, 'apps/web-extension/dist/manifest.json'))) {
  spawnSync('zip', ['-qr', extensionZip, '.'], {
    cwd: resolve(root, 'apps/web-extension/dist'),
  });
  hash(extensionZip);
  console.log('packaged', extensionZip.slice(root.length + 1));
}

const sourceTar = resolve(out, 'intentbridge-0.1.0-source.tar.gz');
spawnSync(
  'tar',
  [
    '--exclude=node_modules',
    '--exclude=target',
    '--exclude=.git',
    '--exclude=.data',
    '--exclude=artifacts',
    '--exclude=*/build',
    '--exclude=*/bin',
    '--exclude=*/obj',
    '--exclude=.gradle',
    '--exclude=**/.kotlin',
    '--exclude=**/jniLibs',
    '--exclude=apps/web-extension/dist',
    '--exclude=pnpm-debug.log',
    '-czf',
    sourceTar,
    '.',
  ],
  { cwd: root },
);
hash(sourceTar);
console.log('packaged', sourceTar.slice(root.length + 1));

writeFileSync(resolve(out, 'SHA256SUMS'), `${hashes.join('\n')}\n`);
console.log(`wrote ${basename(resolve(out, 'SHA256SUMS'))} (${hashes.length} files)`);
if (missing > 0) {
  console.error(`PACKAGE FAILED: ${missing} required artifact(s) missing`);
  process.exit(1);
}
