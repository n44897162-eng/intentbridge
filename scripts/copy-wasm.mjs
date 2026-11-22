import { copyFile, mkdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const source = resolve(root, 'target/wasm32-unknown-unknown/release/ib_runtime.wasm');
const target = resolve(root, 'packages/engine-wasm/wasm/ib_runtime.wasm');
await mkdir(dirname(target), { recursive: true });
try {
  await stat(source);
} catch {
  try {
    await stat(target);
    console.warn('target wasm missing; keeping the checked-in runtime package');
    process.exit(0);
  } catch {
    console.error(
      'wasm artifact missing; run: cargo build -p ib-runtime --lib --release --target wasm32-unknown-unknown',
    );
    process.exit(1);
  }
}
await copyFile(source, target);
console.log('copied ib_runtime.wasm');
