import { describe, expect, it } from 'vitest';
import { isOrphanedSession, reconciledStatus } from '../../apps/web-extension/src/lifecycle.js';

describe('extension session reconciliation', () => {
  it('only fails a persisted session with no live owner', () => {
    expect(isOrphanedSession('running', false, false)).toBe(true);
    expect(isOrphanedSession('paused', false, false)).toBe(true);
    expect(isOrphanedSession('recording', false, false)).toBe(true);
    expect(isOrphanedSession('running', true, false)).toBe(false);
    expect(isOrphanedSession('recording', false, true)).toBe(false);
    expect(isOrphanedSession('finished', false, false)).toBe(false);
    expect(isOrphanedSession('idle', false, false)).toBe(false);
    expect(reconciledStatus('recording')).toBe('idle');
    expect(reconciledStatus('paused')).toBe('failed');
  });
});
