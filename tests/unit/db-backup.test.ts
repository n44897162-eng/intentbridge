import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AppDatabase } from '@intentbridge/web-shell';
import { hashJson, type Flow } from '@intentbridge/action-ir';

const ROOT = resolve(__dirname, '../..');
const golden = JSON.parse(
  readFileSync(resolve(ROOT, 'fixtures/flows/web-basic.flow.json'), 'utf8'),
) as Flow;

describe('database backup and restore', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ib-db-backup-'));

  afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

  it('restores a backup without losing the last good revision', () => {
    let db = AppDatabase.open(dataDir);
    const first = { ...golden, flow_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
    db.createFlow(first, hashJson(first), 'test');
    const backup = db.backup('unit-test');
    const second = { ...golden, flow_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
    db.createFlow(second, hashJson(second), 'test');
    expect(db.listFlows()).toHaveLength(2);
    db.close();

    db = AppDatabase.open(dataDir);
    db.restoreFrom(backup);

    db = AppDatabase.open(dataDir);
    expect(db.listFlows().map((flow) => flow.id)).toEqual([first.flow_id]);
    expect(db.getFlow(first.flow_id)?.flow.name).toBe(first.name);
    db.close();
  });
});
