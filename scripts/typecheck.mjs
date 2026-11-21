import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const projects = [
  'packages/protocol',
  'packages/engine-wasm',
  'core/action-ir',
  'packages/web-core',
  'apps/web-runner',
  'apps/web-shell',
  'packages/editor-ui',
  'apps/web-extension',
];
let failed = false;
for (const project of projects) {
  const config = resolve(root, project, 'tsconfig.json');
  if (!existsSync(config)) continue;
  const result = spawnSync(resolve(root, 'node_modules/.bin/tsc'), ['-p', config, '--noEmit'], {
    cwd: root,
    stdio: 'inherit',
  });
  console.log(`${result.status === 0 ? 'ok  ' : 'FAIL'} typecheck ${project}`);
  if (result.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
