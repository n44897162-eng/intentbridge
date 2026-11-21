import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const errors = [];
const warnings = [];
const skip = new Set(['node_modules', 'dist', 'target', '.data', 'artifacts', '.git', 'build']);
const sourceExtensions = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.rs',
  '.kt',
  '.cs',
  '.xaml',
  '.json',
  '.xml',
  '.md',
  '.yml',
  '.yaml',
]);

function walk(directory) {
  for (const name of readdirSync(directory)) {
    if (skip.has(name)) continue;
    const path = join(directory, name);
    const stats = statSync(path);
    if (stats.isDirectory()) {
      walk(path);
      continue;
    }
    const extension = name.slice(name.lastIndexOf('.'));
    if (!sourceExtensions.has(extension)) continue;
    check(path, name);
  }
}

function check(path, name) {
  const text = readFileSync(path, 'utf8');
  const relative = path.slice(root.length + 1);
  if (
    /TODO|FIXME/.test(text) &&
    !relative.startsWith('docs/') &&
    !relative.startsWith('scripts/')
  ) {
    const matches = text.match(/TODO|FIXME/g) ?? [];
    warnings.push(`${relative}: ${matches.length} TODO/FIXME marker(s) (must not replace P0 work)`);
  }
  if (name === 'manifest.json' && text.includes('<all_urls>')) {
    errors.push(`${relative}: extension must not request <all_urls>`);
  }
  if (relative.startsWith('apps/web-extension/') && name === 'manifest.json') {
    const manifest = JSON.parse(text);
    if (manifest.host_permissions) errors.push(`${relative}: host_permissions must be optional`);
    if (manifest.content_scripts)
      errors.push(`${relative}: content scripts must be user-triggered`);
  }
  if ((relative.startsWith('packages/') || relative.startsWith('core/')) && /\.ts$/.test(name)) {
    if (/\beval\s*\(/.test(text)) errors.push(`${relative}: eval() is forbidden in core/src`);
    if (/console\.log\(/.test(text) && !relative.includes('/src/cli')) {
      warnings.push(`${relative}: console.log in a library module`);
    }
  }
  if (
    relative.startsWith('apps/web-shell/src/') &&
    /password/i.test(text) &&
    /JSON\.stringify\([^)]*password/.test(text)
  ) {
    errors.push(`${relative}: possible password serialization`);
  }
}

walk(root);
for (const warning of warnings) console.warn('warning:', warning);
for (const error of errors) console.error('error:', error);
console.log(`lint: ${errors.length} error(s), ${warnings.length} warning(s)`);
process.exit(errors.length > 0 ? 1 : 0);
