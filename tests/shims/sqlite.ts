// Vite does not yet know node:sqlite as a builtin. Keep the module native.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
export type StatementSync = import('node:sqlite').StatementSync;
