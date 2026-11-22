/**
 * Local SQLite storage. Append-only run events plus immutable flow revisions.
 *
 * The data directory is user-local; no network access is involved. Schema
 * migrations always back up the database before changing it.
 */
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { hashJson, type Flow } from '@intentbridge/action-ir';

export const DB_SCHEMA_VERSION = 1;

export interface FlowSummary {
  id: string;
  name: string;
  platform: string;
  app_scope: string;
  current_revision: number;
  updated_at: string;
  last_status: string | null;
  last_run_at: string | null;
}

export interface FlowRecord {
  flow: Flow;
  revision: number;
  hash: string;
  created_at: string;
  created_by: string;
  signature: unknown | null;
}

export interface RunRecord {
  id: string;
  flow_id: string;
  flow_revision: number;
  trigger: string;
  status: string;
  state: string | null;
  started_at: string;
  finished_at: string | null;
  error: unknown | null;
  pending: unknown | null;
  metrics: unknown | null;
  variables: unknown | null;
  action_log: unknown | null;
  last_seq: number;
}

export interface EvidenceRecord {
  id: string;
  run_id: string;
  step_id: string;
  path: string;
  sha256: string;
  sensitive: number;
  width: number | null;
  height: number | null;
  created_at: string;
  expires_at: string;
}

export interface RecordingRecord {
  id: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  flow_id: string | null;
  warnings: string[];
  events: unknown[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export class AppDatabase {
  readonly raw: DatabaseSync;
  readonly dataDir: string;
  readonly dbPath: string;

  private constructor(dataDir: string) {
    this.dataDir = resolve(dataDir);
    mkdirSync(this.dataDir, { recursive: true });
    mkdirSync(join(this.dataDir, 'evidence'), { recursive: true });
    mkdirSync(join(this.dataDir, 'backups'), { recursive: true });
    this.dbPath = join(this.dataDir, 'intentbridge.sqlite');
    this.raw = new DatabaseSync(this.dbPath);
    this.raw.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.migrate();
  }

  static open(dataDir: string): AppDatabase {
    return new AppDatabase(dataDir);
  }

  close(): void {
    try {
      this.raw.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch {
      /* best effort */
    }
    this.raw.close();
  }

  private readonly prepared = new Map<string, StatementSync>();

  private stmt(sql: string): StatementSync {
    let statement = this.prepared.get(sql);
    if (!statement) {
      statement = this.raw.prepare(sql);
      this.prepared.set(sql, statement);
    }
    return statement;
  }

  private schemaVersion(): number {
    this.raw.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
    const row = this.stmt('SELECT value FROM meta WHERE key = ?').get('schema_version') as
      { value?: string } | undefined;
    return row?.value ? Number(row.value) : 0;
  }

  private migrate(): void {
    const current = this.schemaVersion();
    if (current === DB_SCHEMA_VERSION) return;
    if (current > DB_SCHEMA_VERSION) {
      throw new Error(`database schema ${current} is newer than this build (${DB_SCHEMA_VERSION})`);
    }
    if (current > 0) this.backup(`before-migration-${current}-to-${DB_SCHEMA_VERSION}`);
    this.raw.exec('BEGIN IMMEDIATE;');
    try {
      this.raw.exec(`
        CREATE TABLE IF NOT EXISTS flows (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          platform TEXT NOT NULL,
          app_scope TEXT NOT NULL,
          current_revision INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          archived INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS flow_revisions (
          flow_id TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
          revision INTEGER NOT NULL,
          schema_version TEXT NOT NULL,
          hash TEXT NOT NULL,
          json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          created_by TEXT NOT NULL,
          signature_json TEXT,
          PRIMARY KEY (flow_id, revision)
        );
        CREATE TABLE IF NOT EXISTS runs (
          id TEXT PRIMARY KEY,
          flow_id TEXT NOT NULL,
          flow_revision INTEGER NOT NULL,
          trigger TEXT NOT NULL,
          status TEXT NOT NULL,
          state TEXT,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          error_json TEXT,
          pending_json TEXT,
          metrics_json TEXT,
          variables_json TEXT,
          action_log_json TEXT,
          last_seq INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS runs_by_flow ON runs(flow_id, started_at DESC);
        CREATE TABLE IF NOT EXISTS run_events (
          run_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          json TEXT NOT NULL,
          PRIMARY KEY (run_id, seq)
        );
        CREATE TABLE IF NOT EXISTS evidence (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          step_id TEXT NOT NULL,
          path TEXT NOT NULL,
          sha256 TEXT NOT NULL,
          sensitive INTEGER NOT NULL DEFAULT 0,
          width INTEGER,
          height INTEGER,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS evidence_by_run ON evidence(run_id);
        CREATE TABLE IF NOT EXISTS secrets (
          alias TEXT PRIMARY KEY,
          cipher TEXT NOT NULL,
          iv TEXT NOT NULL,
          tag TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS recordings (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          flow_id TEXT,
          warnings_json TEXT NOT NULL DEFAULT '[]',
          events_json TEXT NOT NULL DEFAULT '[]'
        );
      `);
      this.stmt(
        'INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ).run('schema_version', String(DB_SCHEMA_VERSION));
      this.raw.exec('COMMIT;');
    } catch (error) {
      this.raw.exec('ROLLBACK;');
      throw error;
    }
  }

  backup(reason: string): string {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safe = reason.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 50);
    const target = join(this.dataDir, 'backups', `${stamp}-${safe}.sqlite`);
    mkdirSync(dirname(target), { recursive: true });
    // VACUUM INTO produces a transactionally consistent snapshot including WAL
    // content. A raw file copy can silently miss committed WAL frames.
    this.raw.exec(`VACUUM INTO '${target.replace(/'/g, "''")}';`);
    return target;
  }

  /** Restores a backup file into place. The caller must reopen the database. */
  restoreFrom(backupPath: string): void {
    const resolved = resolve(backupPath);
    const backups = join(this.dataDir, 'backups');
    if (!resolved.startsWith(backups + '/') || !existsSync(resolved)) {
      throw new Error('backup path is outside the backups directory');
    }
    this.close();
    copyFileSync(resolved, this.dbPath);
    for (const suffix of ['-wal', '-shm']) {
      try {
        unlinkSync(`${this.dbPath}${suffix}`);
      } catch {
        /* absent */
      }
    }
  }

  // ---------------------------------------------------------------- flows

  listFlows(): FlowSummary[] {
    const rows = this.raw
      .prepare(
        `SELECT f.id, f.name, f.platform, f.app_scope, f.current_revision, f.updated_at,
                (SELECT r.status FROM runs r WHERE r.flow_id = f.id ORDER BY r.started_at DESC LIMIT 1) AS last_status,
                (SELECT r.started_at FROM runs r WHERE r.flow_id = f.id ORDER BY r.started_at DESC LIMIT 1) AS last_run_at
         FROM flows f WHERE f.archived = 0 ORDER BY f.updated_at DESC`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      platform: String(row.platform),
      app_scope: String(row.app_scope),
      current_revision: Number(row.current_revision),
      updated_at: String(row.updated_at),
      last_status: row.last_status === null ? null : String(row.last_status),
      last_run_at: row.last_run_at === null ? null : String(row.last_run_at),
    }));
  }

  getFlow(flowId: string): FlowRecord | null {
    const meta = this.stmt('SELECT current_revision FROM flows WHERE id = ? AND archived = 0').get(
      flowId,
    ) as { current_revision?: number } | undefined;
    if (!meta?.current_revision) return null;
    const revision = this.getRevision(flowId, Number(meta.current_revision));
    return revision;
  }

  getRevision(flowId: string, revision: number): FlowRecord | null {
    const row = this.stmt(
      'SELECT revision, hash, json, created_at, created_by, signature_json FROM flow_revisions WHERE flow_id = ? AND revision = ?',
    ).get(flowId, revision) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      flow: parseJson<Flow>(row.json, null as unknown as Flow),
      revision: Number(row.revision),
      hash: String(row.hash),
      created_at: String(row.created_at),
      created_by: String(row.created_by),
      signature: row.signature_json ? parseJson(row.signature_json, null) : null,
    };
  }

  listRevisions(
    flowId: string,
  ): Array<{ revision: number; hash: string; created_at: string; created_by: string }> {
    return (
      this.stmt(
        'SELECT revision, hash, created_at, created_by FROM flow_revisions WHERE flow_id = ? ORDER BY revision DESC',
      ).all(flowId) as Array<Record<string, unknown>>
    ).map((row) => ({
      revision: Number(row.revision),
      hash: String(row.hash),
      created_at: String(row.created_at),
      created_by: String(row.created_by),
    }));
  }

  createFlow(flow: Flow, hash: string, createdBy: string): number {
    const existing = this.stmt('SELECT id FROM flows WHERE id = ?').get(flow.flow_id);
    if (existing) throw new Error('FLOW_EXISTS');
    const timestamp = nowIso();
    this.raw.exec('BEGIN IMMEDIATE;');
    try {
      this.stmt(
        'INSERT INTO flows(id, name, platform, app_scope, current_revision, created_at, updated_at, archived) VALUES(?,?,?,?,?,?,?,0)',
      ).run(flow.flow_id, flow.name, flow.platform, flow.app_scope.value, 1, timestamp, timestamp);
      this.stmt(
        'INSERT INTO flow_revisions(flow_id, revision, schema_version, hash, json, created_at, created_by, signature_json) VALUES(?,?,?,?,?,?,?,NULL)',
      ).run(flow.flow_id, 1, flow.schema_version, hash, JSON.stringify(flow), timestamp, createdBy);
      this.raw.exec('COMMIT;');
      return 1;
    } catch (error) {
      this.raw.exec('ROLLBACK;');
      throw error;
    }
  }

  saveFlow(
    flow: Flow,
    createdBy: string,
    baseRevision?: number,
  ): { revision: number; hash: string } {
    this.raw.exec('BEGIN IMMEDIATE;');
    try {
      const meta = this.stmt('SELECT current_revision, archived FROM flows WHERE id = ?').get(
        flow.flow_id,
      ) as { current_revision?: number; archived?: number } | undefined;
      if (!meta?.current_revision) throw new Error('FLOW_NOT_FOUND');
      if (Number(meta.archived) === 1) throw new Error('FLOW_ARCHIVED');
      const current = Number(meta.current_revision);
      if (baseRevision !== undefined && baseRevision !== current) {
        throw new Error('REVISION_CONFLICT');
      }
      const next = current + 1;
      const timestamp = nowIso();
      // The hash must commit to the exact immutable bytes stored in the revision.
      const stored: Flow = { ...flow, revision: next, updated_at: timestamp };
      const hash = hashJson(stored);
      this.stmt(
        'INSERT INTO flow_revisions(flow_id, revision, schema_version, hash, json, created_at, created_by, signature_json) VALUES(?,?,?,?,?,?,?,NULL)',
      ).run(
        flow.flow_id,
        next,
        stored.schema_version,
        hash,
        JSON.stringify(stored),
        timestamp,
        createdBy,
      );
      this.stmt(
        'UPDATE flows SET current_revision = ?, name = ?, app_scope = ?, updated_at = ? WHERE id = ?',
      ).run(next, stored.name, stored.app_scope.value, timestamp, flow.flow_id);
      this.raw.exec('COMMIT;');
      return { revision: next, hash };
    } catch (error) {
      this.raw.exec('ROLLBACK;');
      throw error;
    }
  }

  archiveFlow(flowId: string): void {
    this.stmt('UPDATE flows SET archived = 1, updated_at = ? WHERE id = ?').run(nowIso(), flowId);
  }

  // ----------------------------------------------------------------- runs

  createRun(input: {
    id: string;
    flowId: string;
    flowRevision: number;
    trigger: string;
    variables: unknown;
  }): void {
    this.stmt(
      `INSERT INTO runs(id, flow_id, flow_revision, trigger, status, started_at, variables_json)
       VALUES(?,?,?,?,?,?,?)`,
    ).run(
      input.id,
      input.flowId,
      input.flowRevision,
      input.trigger,
      'running',
      nowIso(),
      JSON.stringify(input.variables ?? {}),
    );
  }

  updateRun(
    runId: string,
    patch: {
      status?: string;
      state?: string | null;
      finished_at?: string | null;
      error?: unknown;
      pending?: unknown;
      metrics?: unknown;
      action_log?: unknown;
    },
  ): void {
    const current = this.stmt('SELECT * FROM runs WHERE id = ?').get(runId) as
      Record<string, unknown> | undefined;
    if (!current) throw new Error('RUN_NOT_FOUND');
    this.stmt(
      `UPDATE runs SET status = ?, state = ?, finished_at = ?, error_json = ?, pending_json = ?, metrics_json = ?, action_log_json = ? WHERE id = ?`,
    ).run(
      patch.status ?? String(current.status),
      patch.state === undefined ? (current.state as string | null) : patch.state,
      patch.finished_at === undefined ? (current.finished_at as string | null) : patch.finished_at,
      patch.error === undefined
        ? (current.error_json as string | null)
        : JSON.stringify(patch.error),
      patch.pending === undefined
        ? (current.pending_json as string | null)
        : JSON.stringify(patch.pending),
      patch.metrics === undefined
        ? (current.metrics_json as string | null)
        : JSON.stringify(patch.metrics),
      patch.action_log === undefined
        ? (current.action_log_json as string | null)
        : JSON.stringify(patch.action_log),
      runId,
    );
  }

  appendEvents(runId: string, events: Array<{ seq: number } & Record<string, unknown>>): void {
    if (events.length === 0) return;
    this.raw.exec('BEGIN IMMEDIATE;');
    try {
      const insert = this.stmt('INSERT OR IGNORE INTO run_events(run_id, seq, json) VALUES(?,?,?)');
      let lastSeq = 0;
      for (const event of events) {
        insert.run(runId, event.seq, JSON.stringify(event));
        lastSeq = Math.max(lastSeq, event.seq);
      }
      this.stmt('UPDATE runs SET last_seq = MAX(last_seq, ?) WHERE id = ?').run(lastSeq, runId);
      this.raw.exec('COMMIT;');
    } catch (error) {
      this.raw.exec('ROLLBACK;');
      throw error;
    }
  }

  listEvents(runId: string, after = 0, limit = 1000): unknown[] {
    return (
      this.stmt(
        'SELECT json FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?',
      ).all(runId, after, limit) as Array<{ json: string }>
    ).map((row) => parseJson(row.json, {}));
  }

  getRun(runId: string): RunRecord | null {
    const row = this.stmt('SELECT * FROM runs WHERE id = ?').get(runId) as
      Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      flow_id: String(row.flow_id),
      flow_revision: Number(row.flow_revision),
      trigger: String(row.trigger),
      status: String(row.status),
      state: row.state === null ? null : String(row.state),
      started_at: String(row.started_at),
      finished_at: row.finished_at === null ? null : String(row.finished_at),
      error: row.error_json ? parseJson(row.error_json, null) : null,
      pending: row.pending_json ? parseJson(row.pending_json, null) : null,
      metrics: row.metrics_json ? parseJson(row.metrics_json, null) : null,
      variables: row.variables_json ? parseJson(row.variables_json, null) : null,
      action_log: row.action_log_json ? parseJson(row.action_log_json, null) : null,
      last_seq: Number(row.last_seq),
    };
  }

  listRuns(flowId?: string): RunRecord[] {
    const rows = (
      flowId
        ? this.stmt('SELECT * FROM runs WHERE flow_id = ? ORDER BY started_at DESC LIMIT 200').all(
            flowId,
          )
        : this.stmt('SELECT * FROM runs ORDER BY started_at DESC LIMIT 200').all()
    ) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      flow_id: String(row.flow_id),
      flow_revision: Number(row.flow_revision),
      trigger: String(row.trigger),
      status: String(row.status),
      state: row.state === null ? null : String(row.state),
      started_at: String(row.started_at),
      finished_at: row.finished_at === null ? null : String(row.finished_at),
      error: row.error_json ? parseJson(row.error_json, null) : null,
      pending: row.pending_json ? parseJson(row.pending_json, null) : null,
      metrics: row.metrics_json ? parseJson(row.metrics_json, null) : null,
      variables: row.variables_json ? parseJson(row.variables_json, null) : null,
      action_log: row.action_log_json ? parseJson(row.action_log_json, null) : null,
      last_seq: Number(row.last_seq),
    }));
  }

  // ------------------------------------------------------------- evidence

  addEvidence(record: EvidenceRecord): void {
    this.stmt(
      `INSERT INTO evidence(id, run_id, step_id, path, sha256, sensitive, width, height, created_at, expires_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      record.id,
      record.run_id,
      record.step_id,
      record.path,
      record.sha256,
      record.sensitive,
      record.width,
      record.height,
      record.created_at,
      record.expires_at,
    );
  }

  listEvidence(runId: string): EvidenceRecord[] {
    return (
      this.stmt('SELECT * FROM evidence WHERE run_id = ? ORDER BY created_at').all(runId) as Array<
        Record<string, unknown>
      >
    ).map((row) => ({
      id: String(row.id),
      run_id: String(row.run_id),
      step_id: String(row.step_id),
      path: String(row.path),
      sha256: String(row.sha256),
      sensitive: Number(row.sensitive),
      width: row.width === null ? null : Number(row.width),
      height: row.height === null ? null : Number(row.height),
      created_at: String(row.created_at),
      expires_at: String(row.expires_at),
    }));
  }

  getEvidence(id: string): EvidenceRecord | null {
    const row = this.stmt('SELECT * FROM evidence WHERE id = ?').get(id) as
      Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      run_id: String(row.run_id),
      step_id: String(row.step_id),
      path: String(row.path),
      sha256: String(row.sha256),
      sensitive: Number(row.sensitive),
      width: row.width === null ? null : Number(row.width),
      height: row.height === null ? null : Number(row.height),
      created_at: String(row.created_at),
      expires_at: String(row.expires_at),
    };
  }

  deleteExpiredEvidence(): Array<{ id: string; path: string }> {
    const rows = this.stmt('SELECT id, path FROM evidence WHERE expires_at < ?').all(
      nowIso(),
    ) as Array<{
      id: string;
      path: string;
    }>;
    if (rows.length > 0) {
      this.stmt('DELETE FROM evidence WHERE expires_at < ?').run(nowIso());
    }
    return rows.map((row) => ({ id: String(row.id), path: String(row.path) }));
  }

  evidenceBytes(): number {
    let total = 0;
    try {
      for (const name of readdirSync(join(this.dataDir, 'evidence'))) {
        try {
          total += statSync(join(this.dataDir, 'evidence', name)).size;
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
    return total;
  }

  // -------------------------------------------------------------- secrets

  setSecret(alias: string, cipher: string, iv: string, tag: string): void {
    this.stmt(
      `INSERT INTO secrets(alias, cipher, iv, tag, created_at) VALUES(?,?,?,?,?)
       ON CONFLICT(alias) DO UPDATE SET cipher = excluded.cipher, iv = excluded.iv, tag = excluded.tag, created_at = excluded.created_at`,
    ).run(alias, cipher, iv, tag, nowIso());
  }

  getSecret(alias: string): { cipher: string; iv: string; tag: string } | null {
    const row = this.stmt('SELECT cipher, iv, tag FROM secrets WHERE alias = ?').get(alias) as
      { cipher: string; iv: string; tag: string } | undefined;
    return row ? { cipher: row.cipher, iv: row.iv, tag: row.tag } : null;
  }

  listSecrets(): Array<{ alias: string; created_at: string }> {
    return this.stmt('SELECT alias, created_at FROM secrets ORDER BY alias').all() as Array<{
      alias: string;
      created_at: string;
    }>;
  }

  deleteSecret(alias: string): boolean {
    const result = this.stmt('DELETE FROM secrets WHERE alias = ?').run(alias);
    return Number(result.changes) > 0;
  }

  // ------------------------------------------------------------- settings

  getSettings(): Record<string, unknown> {
    const rows = this.stmt('SELECT key, value FROM settings').all() as Array<{
      key: string;
      value: string;
    }>;
    const output: Record<string, unknown> = {};
    for (const row of rows) output[row.key] = parseJson(row.value, row.value);
    return output;
  }

  setSetting(key: string, value: unknown): void {
    this.stmt(
      'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(key, JSON.stringify(value));
  }

  // ------------------------------------------------------------ recordings

  createRecording(id: string): void {
    this.stmt('INSERT INTO recordings(id, status, started_at) VALUES(?,?,?)').run(
      id,
      'recording',
      nowIso(),
    );
  }

  appendRecordingEvents(id: string, events: unknown[]): void {
    const row = this.stmt('SELECT events_json FROM recordings WHERE id = ?').get(id) as
      { events_json: string } | undefined;
    if (!row) throw new Error('RECORDING_NOT_FOUND');
    const existing = parseJson<unknown[]>(row.events_json, []);
    this.stmt('UPDATE recordings SET events_json = ? WHERE id = ?').run(
      JSON.stringify(existing.concat(events)),
      id,
    );
  }

  finishRecording(id: string, flowId: string | null, warnings: string[], events: unknown[]): void {
    this.stmt(
      'UPDATE recordings SET status = ?, finished_at = ?, flow_id = ?, warnings_json = ?, events_json = ? WHERE id = ?',
    ).run('finished', nowIso(), flowId, JSON.stringify(warnings), JSON.stringify(events), id);
  }

  getRecording(id: string): RecordingRecord | null {
    const row = this.stmt('SELECT * FROM recordings WHERE id = ?').get(id) as
      Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      status: String(row.status),
      started_at: String(row.started_at),
      finished_at: row.finished_at === null ? null : String(row.finished_at),
      flow_id: row.flow_id === null ? null : String(row.flow_id),
      warnings: parseJson<string[]>(row.warnings_json, []),
      events: parseJson<unknown[]>(row.events_json, []),
    };
  }

  listRecordings(): RecordingRecord[] {
    return (
      this.stmt('SELECT id FROM recordings ORDER BY started_at DESC LIMIT 50').all() as Array<{
        id: string;
      }>
    ).map((row) => this.getRecording(String(row.id)) as RecordingRecord);
  }

  stats(): Record<string, unknown> {
    const flows = this.stmt('SELECT COUNT(*) AS count FROM flows WHERE archived = 0').get() as {
      count: number;
    };
    const runs = this.stmt('SELECT COUNT(*) AS count FROM runs').get() as { count: number };
    const events = this.stmt('SELECT COUNT(*) AS count FROM run_events').get() as { count: number };
    const evidence = this.stmt('SELECT COUNT(*) AS count FROM evidence').get() as { count: number };
    return {
      flows: Number(flows.count),
      runs: Number(runs.count),
      run_events: Number(events.count),
      evidence: Number(evidence.count),
      evidence_bytes: this.evidenceBytes(),
      data_dir: this.dataDir,
      schema_version: DB_SCHEMA_VERSION,
    };
  }
}
