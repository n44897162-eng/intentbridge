import { cp, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
await mkdir(resolve(root, 'core/action-ir/dist/schema'), { recursive: true });
await cp(
  resolve(root, 'core/action-ir/schema/flow-1.0.0.schema.json'),
  resolve(root, 'core/action-ir/dist/schema/flow-1.0.0.schema.json'),
);
console.log('copied flow schema to dist');
