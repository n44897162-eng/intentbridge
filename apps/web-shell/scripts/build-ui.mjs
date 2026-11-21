import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const shellRoot = resolve(here, '..');
const repoRoot = resolve(shellRoot, '..', '..');
await mkdir(resolve(shellRoot, 'dist'), { recursive: true });
await build({
  entryPoints: [resolve(repoRoot, 'packages/editor-ui/src/main.ts')],
  bundle: true,
  format: 'esm',
  target: ['chrome120', 'firefox120', 'safari17'],
  outfile: resolve(shellRoot, 'dist/ui.js'),
  loader: { '.css': 'css' },
  logLevel: 'warning',
});
await copyFile(resolve(shellRoot, 'public/index.html'), resolve(shellRoot, 'dist/index.html'));
console.log('editor UI bundled');
