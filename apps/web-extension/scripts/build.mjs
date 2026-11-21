import { build } from 'esbuild';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const repo = resolve(root, '..', '..');
const dist = resolve(root, 'dist');
await mkdir(dist, { recursive: true });

const common = {
  bundle: true,
  target: ['chrome116'],
  minify: false,
  sourcemap: false,
  logLevel: 'warning',
  platform: 'browser',
  external: ['node:fs', 'node:fs/promises'],
  loader: { '.css': 'css' },
};

await build({
  ...common,
  entryPoints: [resolve(root, 'src/background.ts')],
  outfile: resolve(dist, 'background.js'),
  format: 'esm',
});
await build({
  ...common,
  entryPoints: [resolve(root, 'src/content.ts')],
  outfile: resolve(dist, 'content.js'),
  format: 'iife',
});
await build({
  ...common,
  entryPoints: [resolve(root, 'src/popup.ts')],
  outfile: resolve(dist, 'popup.js'),
  format: 'esm',
});

await copyFile(resolve(root, 'manifest.json'), resolve(dist, 'manifest.json'));
await copyFile(resolve(root, 'popup.html'), resolve(dist, 'popup.html'));
await copyFile(resolve(root, 'popup.css'), resolve(dist, 'popup.css'));
await copyFile(
  resolve(repo, 'packages/engine-wasm/wasm/ib_runtime.wasm'),
  resolve(dist, 'ib_runtime.wasm'),
);
// Keep the packaged manifest honest about the exact bundled version.
const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
await writeFile(resolve(dist, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log('extension bundled to', dist);
