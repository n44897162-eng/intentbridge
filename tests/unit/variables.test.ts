import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Flow } from '@intentbridge/action-ir';
import { coerceFlowVariables } from '@intentbridge/web-shell';

const golden = JSON.parse(
  readFileSync(resolve(__dirname, '../../fixtures/flows/web-basic.flow.json'), 'utf8'),
) as Flow;

function flowWithVariables(): Flow {
  return {
    ...golden,
    variables: [
      { name: 'keyword', type: 'string', required: true, min_length: 2 },
      { name: 'count', type: 'number', required: true },
      { name: 'enabled', type: 'boolean' },
      { name: 'day', type: 'date' },
    ],
  };
}

describe('run variable coercion', () => {
  it('coerces declared types and rejects unknown/required errors', () => {
    const flow = flowWithVariables();
    const ok = coerceFlowVariables(flow, {
      keyword: '报告',
      count: '3',
      enabled: 'false',
      day: '2026-01-02',
    });
    expect(ok.errors).toEqual([]);
    expect(ok.variables).toEqual({
      keyword: '报告',
      count: 3,
      enabled: false,
      day: '2026-01-02',
    });
    const missing = coerceFlowVariables(flow, { keyword: '报告' });
    expect(missing.errors).toContain('missing required variable: count');
    const typo = coerceFlowVariables(flow, { keyword: '报告', count: 1, extra: 'x' });
    expect(typo.errors).toContain('unknown variable: extra');
    const bad = coerceFlowVariables(flow, { keyword: 'a', count: 'abc', enabled: 'yes' });
    expect(bad.errors).toEqual(
      expect.arrayContaining([
        'variable keyword is shorter than 2',
        'variable count is not a number',
        'variable enabled is not a boolean',
      ]),
    );
  });
});
