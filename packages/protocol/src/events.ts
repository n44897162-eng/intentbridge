/**
 * Append-only run event protocol (task book §8.3).
 *
 * Consumers must be idempotent per (run_id, seq). Events are the only source of
 * truth for reconstructing a run after a crash.
 */
export const RUN_EVENT_TYPES = [
  'RunStarted',
  'StepPlanned',
  'CandidatesRanked',
  'ApprovalRequested',
  'ActionAttempted',
  'ObservationRecorded',
  'StepSucceeded',
  'StepFailed',
  'RunPaused',
  'RunFinished',
  'RunCancelled',
  'StateChanged',
  'VariableSet',
  'CompensationRecorded',
  'Diagnostic',
] as const;

export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

export const RUN_EVENT_SCHEMA_VERSION = '1.0.0' as const;

export interface RunEvent {
  schema_version: typeof RUN_EVENT_SCHEMA_VERSION;
  event_id: string;
  run_id: string;
  /** Strictly increasing, gap-free, starting at 1. */
  seq: number;
  type: RunEventType;
  /** Wall clock ISO-8601; informational only. */
  ts: string;
  /** Monotonic milliseconds supplied by the host clock. */
  mono_ms: number;
  step_id?: string | null;
  attempt_id?: string | null;
  payload: Record<string, unknown>;
}

export interface RunEventInput {
  type: RunEventType;
  mono_ms: number;
  step_id?: string | null;
  attempt_id?: string | null;
  payload?: Record<string, unknown>;
}

/** Minimal structural validation used at every IPC/event-file boundary. */
export function validateRunEvent(value: unknown, expectedRunId?: string): string[] {
  const errors: string[] = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return ['event must be an object'];
  }
  const e = value as Record<string, unknown>;
  if (e.schema_version !== RUN_EVENT_SCHEMA_VERSION) errors.push('schema_version must be 1.0.0');
  if (typeof e.event_id !== 'string' || e.event_id.length < 8) errors.push('event_id invalid');
  if (typeof e.run_id !== 'string' || e.run_id.length < 8) errors.push('run_id invalid');
  if (expectedRunId !== undefined && e.run_id !== expectedRunId) errors.push('run_id mismatch');
  if (!Number.isInteger(e.seq) || (e.seq as number) < 1) errors.push('seq must be >= 1');
  if (typeof e.type !== 'string' || !(RUN_EVENT_TYPES as readonly string[]).includes(e.type)) {
    errors.push('unknown event type');
  }
  if (typeof e.ts !== 'string' || Number.isNaN(Date.parse(e.ts))) errors.push('ts invalid');
  if (!Number.isFinite(e.mono_ms)) errors.push('mono_ms invalid');
  if (e.step_id !== undefined && e.step_id !== null && typeof e.step_id !== 'string') {
    errors.push('step_id invalid');
  }
  if (e.attempt_id !== undefined && e.attempt_id !== null && typeof e.attempt_id !== 'string') {
    errors.push('attempt_id invalid');
  }
  if (typeof e.payload !== 'object' || e.payload === null || Array.isArray(e.payload)) {
    errors.push('payload must be an object');
  }
  return errors;
}

/** Validates ordering/integrity of a whole persisted event stream. */
export function validateRunEventStream(events: readonly RunEvent[], runId: string): string[] {
  const errors: string[] = [];
  let lastSeq = 0;
  const seen = new Set<string>();
  for (const event of events) {
    errors.push(...validateRunEvent(event, runId).map((m) => `seq ${event?.seq}: ${m}`));
    if (event.seq !== lastSeq + 1)
      errors.push(`seq gap: expected ${lastSeq + 1}, got ${event.seq}`);
    if (seen.has(event.event_id)) errors.push(`duplicate event_id ${event.event_id}`);
    seen.add(event.event_id);
    lastSeq = event.seq;
  }
  return errors;
}
