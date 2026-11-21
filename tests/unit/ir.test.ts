import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  canonicalJson,
  hashJson,
  loadFlow,
  validateFlow,
  validateFlowForExecution,
  type Flow,
} from '@intentbridge/action-ir';

const base = (): Flow =>
  JSON.parse(
    readFileSync(resolve(__dirname, '../../fixtures/flows/web-basic.flow.json'), 'utf8'),
  ) as Flow;

const rules = (flow: unknown): string[] => validateFlow(flow).errors.map((error) => error.rule);

describe('Action IR schema + semantics', () => {
  it('accepts the golden web flow', () => {
    const result = validateFlow(base());
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('requires an observable postcondition for mutating actions', () => {
    const flow = base();
    delete flow.steps[2]!.postconditions;
    expect(rules(flow)).toContain('step.missing-postcondition');
  });

  it('rejects missing permissions', () => {
    const flow = base();
    flow.permissions = flow.permissions.filter((permission) => permission !== 'click');
    expect(rules(flow)).toContain('step.permission-missing');
  });

  it('rejects plaintext passwords for password-like targets', () => {
    const flow = base();
    flow.steps[1]!.target!.anchors.semantic = {
      role: 'textbox',
      name: 'Password',
      test_id: 'keyword-input',
    };
    (flow.steps[1]!.params as { value: string }).value = 'hunter2';
    expect(rules(flow)).toContain('input.plaintext-password');
  });

  it('rejects undeclared template variables', () => {
    const flow = base();
    (flow.steps[1]!.params as { value: string }).value = '${missing}';
    expect(rules(flow)).toContain('template.unknown-variable');
  });

  it('rejects duplicate step ids', () => {
    const flow = base();
    flow.steps[1]!.id = 'open';
    expect(rules(flow)).toContain('step.duplicate-id');
  });

  it('rejects wrong app scope kind', () => {
    const flow = base();
    flow.app_scope = { kind: 'android-package', value: 'com.example.app' };
    expect(rules(flow)).toContain('app-scope.kind-mismatch');
  });

  it('rejects scroll without boundary condition', () => {
    const flow = base();
    flow.steps.splice(3, 0, {
      id: 'scroll',
      action: 'scroll',
      target: null,
      postconditions: [{ kind: 'window-stable', min_stable_ms: 100 }],
      params: { direction: 'down', amount: 400, max_attempts: 3 },
    } as never);
    expect(rules(flow)).toContain('step.scroll-boundary');
  });

  it('rejects unknown properties instead of guessing', () => {
    const flow = base() as unknown as Record<string, unknown>;
    flow['surprise'] = true;
    expect(rules(flow).some((rule) => rule.startsWith('schema.'))).toBe(true);
  });

  it('rejects a flow without an end step for execution', () => {
    const flow = base();
    flow.steps = flow.steps.filter((step) => step.action !== 'end');
    const result = validateFlowForExecution(flow);
    expect(result.errors.map((error) => error.rule)).toContain('flow.missing-end');
  });

  it('detects plaintext secrets anywhere in the document', () => {
    const flow = base();
    flow.notes = 'token AKIAIOSFODNN7EXAMPLE';
    expect(rules(flow)).toContain('flow.plaintext-secret');
  });
});

describe('migration pipeline', () => {
  const legacy080 = {
    schemaVersion: '0.8.0',
    flowId: '22222222-2222-4222-8222-222222222222',
    name: '旧版流程',
    platform: 'web',
    appScope: { type: 'origin', target: 'http://127.0.0.1:4317' },
    vars: [{ key: 'keyword', kind: 'text', required: true }],
    permissions: ['read-ui', 'read-screen', 'click', 'type', 'launch'],
    actions: [
      { kind: 'press', selector: '#search-submit' },
      { kind: 'type', selector: '#keyword', text: '${keyword}' },
      { kind: 'finish' },
    ],
  };

  it('migrates 0.8.0 through 0.9.0 to 1.0.0 and reports safety gaps', () => {
    const result = loadFlow(legacy080);
    expect(result.report.applied).toEqual(['0.8.0->0.9.0', '0.9.0->1.0.0']);
    const raw = result.raw as Flow;
    expect(raw.schema_version).toBe('1.0.0');
    expect(raw.steps.map((step) => step.action)).toEqual(['click', 'input', 'end']);
    // Migration does not invent postconditions: the legacy flow is refused.
    expect(result.flow).toBeNull();
    expect(result.report.diagnostics.map((item) => item.rule)).toContain(
      'step.missing-postcondition',
    );
  });

  it('refuses future versions', () => {
    const result = loadFlow({ ...base(), schema_version: '2.0.0' });
    expect(result.flow).toBeNull();
    expect(result.report.diagnostics.some((item) => item.rule === 'migration.future-version')).toBe(
      true,
    );
  });

  it('never mutates the input document', () => {
    const input = JSON.parse(JSON.stringify(legacy080));
    loadFlow(input);
    expect(input).toEqual(legacy080);
  });

  it('reports dropped fields instead of silently guessing', () => {
    const result = loadFlow({ ...legacy080, magic: 42 });
    expect(result.report.diagnostics.some((item) => item.rule === 'migration.dropped-field')).toBe(
      true,
    );
  });
});

describe('canonicalisation', () => {
  it('is key-order independent and round-trips', () => {
    const flow = base();
    const reordered = JSON.parse(
      JSON.stringify(
        flow,
        Object.keys(flow)
          .sort()
          .reduce((acc, key) => ({ ...acc, [key]: undefined }), {}),
      ),
    );
    expect(hashJson(flow)).toBe(hashJson(JSON.parse(JSON.stringify(flow))));
    expect(JSON.parse(canonicalJson(flow))).toEqual(JSON.parse(JSON.stringify(flow)));
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    void reordered;
  });

  it('rejects cyclic documents', () => {
    const value: Record<string, unknown> = {};
    value['self'] = value;
    expect(() => canonicalJson(value)).toThrow(/cycles/);
  });
});

describe('property tests', () => {
  it('never throws on arbitrary JSON', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        expect(() => validateFlow(value)).not.toThrow();
        expect(() => validateFlowForExecution(value)).not.toThrow();
        expect(() => loadFlow(value)).not.toThrow();
      }),
      { numRuns: 250 },
    );
  });

  it('accepts every mutation of the golden flow without crashing', () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.constantFrom('value', 'name', 'id', 'notes', 'description'),
        (text, key) => {
          const flow = base() as unknown as Record<string, unknown>;
          flow[key] = text;
          expect(() => validateFlow(flow)).not.toThrow();
        },
      ),
      { numRuns: 100 },
    );
  });
});
