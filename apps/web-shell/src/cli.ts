#!/usr/bin/env node
import { createApp } from './server.js';

const port = Number(process.env.IB_SHELL_PORT ?? 4319);
const dataDir = process.env.IB_DATA_DIR ?? '.data';

const app = await createApp({ port, dataDir });
console.log(`[intentbridge] shell listening on ${app.url}`);
console.log('[intentbridge] data dir:', app.db.dataDir);

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await app.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
