import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      'node:sqlite': resolve(__dirname, 'tests/shims/sqlite.ts'),
      '@intentbridge/protocol/browser': resolve(__dirname, 'packages/protocol/src/browser.ts'),
      '@intentbridge/protocol': resolve(__dirname, 'packages/protocol/src/index.ts'),
      '@intentbridge/action-ir': resolve(__dirname, 'core/action-ir/src/index.ts'),
      '@intentbridge/engine-wasm': resolve(__dirname, 'packages/engine-wasm/src/index.ts'),
      '@intentbridge/web-core': resolve(__dirname, 'packages/web-core/src/index.ts'),
      '@intentbridge/web-runner': resolve(__dirname, 'apps/web-runner/src/index.ts'),
      '@intentbridge/web-shell': resolve(__dirname, 'apps/web-shell/src/index.ts'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true, execArgv: ['--expose-gc'] } },
    reporters: 'default',
  },
});
