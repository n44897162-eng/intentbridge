import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const components = [];

function add(component) {
  components.push({ type: 'library', ...component });
}

try {
  const npm = JSON.parse(
    execFileSync('pnpm', ['list', '-r', '--depth', 'Infinity', '--json'], {
      cwd: root,
      encoding: 'utf8',
    }),
  );
  const seen = new Set();
  const walk = (node) => {
    for (const item of node) {
      for (const [name, info] of Object.entries(item.dependencies ?? {})) {
        const version = info.version ?? 'unknown';
        const key = `npm:${name}@${version}`;
        if (!seen.has(key)) {
          seen.add(key);
          add({ name, version, purl: `pkg:npm/${name}@${version}`, scope: 'runtime-or-dev' });
        }
      }
    }
  };
  walk(npm);
} catch (error) {
  console.warn('npm SBOM failed:', error.message);
}

try {
  const lock = readFileSync(join(root, 'Cargo.lock'), 'utf8');
  for (const block of lock.split('[[package]]').slice(1)) {
    const name = /name = "([^"]+)"/.exec(block)?.[1];
    const version = /version = "([^"]+)"/.exec(block)?.[1];
    if (name && version)
      add({ name, version, purl: `pkg:cargo/${name}@${version}`, scope: 'runtime' });
  }
} catch (error) {
  console.warn('cargo SBOM failed:', error.message);
}

const artifacts = [];
for (const path of [
  'target/wasm32-unknown-unknown/release/ib_runtime.wasm',
  'apps/web-extension/dist/ib_runtime.wasm',
  'apps/web-extension/dist/background.js',
  'apps/web-extension/dist/content.js',
  'apps/web-shell/dist/ui.js',
]) {
  const absolute = join(root, path);
  if (!existsSync(absolute)) continue;
  const bytes = readFileSync(absolute);
  artifacts.push({
    type: 'file',
    name: path,
    hashes: [{ alg: 'SHA-256', content: createHash('sha256').update(bytes).digest('hex') }],
    size: bytes.length,
  });
}

const document = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  serialNumber: `urn:uuid:${crypto.randomUUID()}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    tools: [{ vendor: 'IntentBridge', name: 'scripts/sbom.mjs', version: '0.1.0' }],
    component: { type: 'application', name: 'intentbridge', version: '0.1.0' },
  },
  components: components.sort((a, b) => a.purl.localeCompare(b.purl)),
  artifacts,
};
mkdirSync(join(root, 'sbom'), { recursive: true });
writeFileSync(join(root, 'sbom', 'intentbridge-sbom.json'), JSON.stringify(document, null, 2));
console.log(`SBOM written: ${components.length} components, ${artifacts.length} artifacts`);
