import { describe, expect, it } from 'vitest';
import {
  ERROR_SPECS,
  collectSecretRefs,
  mapPlatformError,
  previewParams,
  redact,
  validateEngineInput,
  validateRunEvent,
  validateRunEventStream,
} from '@intentbridge/protocol';

describe('error mapping', () => {
  it('maps stale DOM errors to STALE_TARGET', () => {
    expect(mapPlatformError('web', { code: 'NodeDetached', message: 'stale element' }).code).toBe(
      'STALE_TARGET',
    );
  });

  it('maps foreign origins to APP_SCOPE_VIOLATION', () => {
    expect(mapPlatformError('web', { message: 'navigated to foreign origin' }).code).toBe(
      'APP_SCOPE_VIOLATION',
    );
  });

  it('keeps unknown diagnostics internal without leaking text', () => {
    const error = mapPlatformError('android', { message: 'password=abc123' });
    expect(error.code).toBe('INTERNAL_ERROR');
    expect(error.message).not.toContain('abc123');
  });

  it('declares retryability for every code', () => {
    for (const spec of Object.values(ERROR_SPECS)) {
      expect(typeof spec.retryable).toBe('boolean');
    }
  });
});

describe('redaction', () => {
  it('redacts sensitive keys but keeps secret aliases', () => {
    const output = redact({
      username: 'alice',
      password: 'hunter2',
      nested: { apiKey: 'abc', value: 'secret://db-password' },
    });
    expect(JSON.stringify(output)).not.toContain('hunter2');
    expect(JSON.stringify(output)).not.toContain('abc');
    expect(output.nested.value).toBe('secret://db-password');
  });

  it('previews params without leaking secrets', () => {
    const preview = previewParams({ value: 'secret://bank-pin', token: 'xxx', note: 'hello' });
    expect(preview.value).toBe('secret://bank-pin');
    expect(preview.token).toBe('«redacted»');
  });

  it('collects secret references', () => {
    expect([...collectSecretRefs({ a: 'secret://one', b: ['secret://two'] })]).toEqual([
      'one',
      'two',
    ]);
  });
});

describe('engine input validation', () => {
  it('requires ids for candidate submissions', () => {
    expect(validateEngineInput({ kind: 'Candidates', now_mono_ms: 1, candidates: [] })).toContain(
      'step_id required',
    );
  });

  it('accepts a well-formed observation', () => {
    expect(
      validateEngineInput({
        kind: 'Observation',
        now_mono_ms: 10,
        step_id: 's1',
        condition_id: 'c1',
        facts: { now_mono_ms: 10 },
      }),
    ).toEqual([]);
  });
});

describe('run event envelope', () => {
  const event = {
    schema_version: '1.0.0',
    event_id: 'evt-0123456789abcdef',
    run_id: 'run-00000001',
    seq: 1,
    type: 'RunStarted',
    ts: '2026-01-01T00:00:00.000Z',
    mono_ms: 0,
    payload: {},
  };

  it('validates a canonical event', () => {
    expect(validateRunEvent(event, 'run-00000001')).toEqual([]);
  });

  it('detects gaps and duplicates', () => {
    expect(
      validateRunEventStream(
        [{ ...event, seq: 1 } as never, { ...event, seq: 3, event_id: 'evt-other' } as never],
        'run-00000001',
      ).some((error) => error.includes('gap')),
    ).toBe(true);
    expect(
      validateRunEventStream(
        [{ ...event, seq: 1 } as never, { ...event, seq: 2 } as never],
        'run-00000001',
      ).some((error) => error.includes('duplicate')),
    ).toBe(true);
  });
});
