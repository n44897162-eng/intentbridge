export type SessionStatus = 'idle' | 'recording' | 'running' | 'paused' | 'finished' | 'failed';

/** A persisted session is orphaned when no in-memory owner exists. */
export function isOrphanedSession(
  status: string,
  hasActiveRun: boolean,
  isRecording: boolean,
): boolean {
  if (hasActiveRun || isRecording) return false;
  return status === 'running' || status === 'paused' || status === 'recording';
}

export function reconciledStatus(status: string): 'idle' | 'failed' {
  return status === 'recording' ? 'idle' : 'failed';
}
