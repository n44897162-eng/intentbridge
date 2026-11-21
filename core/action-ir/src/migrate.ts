/**
 * Versioned migration pipeline. Every schema change is a pure step
 * `from -> to`; unknown versions are rejected, never guessed.
 */
import type { Diagnostic, Flow } from './types.js';
import { FLOW_SCHEMA_VERSION } from './types.js';
import { validateFlow } from './validate.js';

export interface MigrationReport {
  from_version: string;
  to_version: string;
  applied: string[];
  diagnostics: Diagnostic[];
}

export interface MigrationResult {
  flow: Flow | null;
  report: MigrationReport;
  /** The migrated document before validation, useful for editor recovery. */
  raw: unknown;
}

type Json = Record<string, unknown>;

interface Migration {
  from: string;
  to: string;
  describe: string;
  migrate(doc: Json, diagnostics: Diagnostic[]): Json;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function warn(diagnostics: Diagnostic[], rule: string, path: string, message: string): void {
  diagnostics.push({ severity: 'warning', code: 'MIGRATION_FAILED', rule, path, message });
}

function error(diagnostics: Diagnostic[], rule: string, path: string, message: string): void {
  diagnostics.push({ severity: 'error', code: 'MIGRATION_FAILED', rule, path, message });
}

function asArray(value: unknown): Json[] {
  return Array.isArray(value) ? (value as Json[]) : [];
}

/** 0.8.0: flat `actions` with imperative selectors. */
const migrate080to090: Migration = {
  from: '0.8.0',
  to: '0.9.0',
  describe: 'actions[] -> steps[], kind -> type, appScope normalization',
  migrate(doc, diagnostics) {
    const out: Json = {
      schemaVersion: '0.9.0',
      flowId: doc.flowId ?? doc.flow_id,
      name: doc.name ?? 'Migrated flow',
      platform: doc.platform ?? 'web',
      createdBy: doc.createdBy ?? doc.created_by ?? 'migration',
      revision: typeof doc.revision === 'number' ? doc.revision : 1,
    };
    const scope = (doc.appScope ?? doc.app_scope) as Json | undefined;
    if (scope && typeof scope === 'object') {
      const kind = typeof scope.type === 'string' ? scope.type : scope.kind;
      const value = scope.target ?? scope.value;
      out.appScope = {
        kind:
          kind === 'origin' || kind === 'web-origin'
            ? 'web-origin'
            : kind === 'process' || kind === 'windows-app'
              ? 'windows-app'
              : kind === 'package' || kind === 'android-package'
                ? 'android-package'
                : kind,
        value,
        ...(scope.process ? { process_name: scope.process } : {}),
        ...(scope.title ? { window_title: scope.title } : {}),
      };
    } else {
      error(
        diagnostics,
        'migration.missing-app-scope',
        '/app_scope',
        '0.8.0 document has no app scope',
      );
    }
    const vars = asArray(doc.vars ?? doc.variables).map((item) => ({
      name: item.key ?? item.name,
      type:
        item.kind === 'text'
          ? 'string'
          : item.kind === 'number'
            ? 'number'
            : item.kind === 'bool'
              ? 'boolean'
              : (item.type ?? 'string'),
      required: item.required ?? false,
      sensitive: item.secret ?? item.sensitive ?? false,
    }));
    out.variables = vars;
    out.permissions = Array.isArray(doc.permissions)
      ? doc.permissions
      : ['read-ui', 'click', 'type'];
    const steps: Json[] = [];
    asArray(doc.actions).forEach((action, index) => {
      const id = typeof action.id === 'string' ? action.id : `s${index + 1}`;
      const kind = String(action.kind ?? 'noop');
      const selector = action.selector;
      const step: Json = {
        id,
        type:
          kind === 'press'
            ? 'click'
            : kind === 'type'
              ? 'input'
              : kind === 'finish'
                ? 'end'
                : kind === 'navigate'
                  ? 'launch'
                  : kind,
      };
      if (selector) step.selector = selector;
      if (action.text !== undefined) step.value = action.text;
      if (action.url !== undefined) step.url = action.url;
      steps.push(step);
    });
    out.steps = steps;
    for (const key of Object.keys(doc)) {
      if (
        ![
          'schemaVersion',
          'flowId',
          'flow_id',
          'name',
          'platform',
          'appScope',
          'app_scope',
          'createdBy',
          'created_by',
          'revision',
          'vars',
          'variables',
          'permissions',
          'actions',
        ].includes(key)
      ) {
        warn(
          diagnostics,
          'migration.dropped-field',
          `/${key}`,
          `0.8.0 field ${key} has no 1.0.0 mapping`,
        );
      }
    }
    return out;
  },
};

/** 0.9.0: camelCase document, steps with `type` + `selector`. */
const migrate090to100: Migration = {
  from: '0.9.0',
  to: '1.0.0',
  describe: 'snake_case, type->action, selector->anchors, retry/timeout normalization',
  migrate(doc, diagnostics) {
    const out: Json = {};

    const copy = (from: string, to: string, transform?: (value: unknown) => unknown) => {
      if (doc[from] !== undefined) out[to] = transform ? transform(doc[from]) : doc[from];
    };
    copy('schemaVersion', 'schema_version');
    copy('schema_version', 'schema_version');
    copy('flowId', 'flow_id');
    copy('flow_id', 'flow_id');
    copy('name', 'name');
    copy('description', 'description');
    copy('platform', 'platform');
    copy('createdBy', 'created_by');
    copy('created_by', 'created_by');
    copy('revision', 'revision');
    copy('labels', 'labels');
    copy('notes', 'notes');

    const scope = (doc.appScope ?? doc.app_scope) as Json | undefined;
    if (scope) {
      out.app_scope = {
        kind: scope.kind,
        value: scope.value,
        ...(scope.process_name ? { process_name: scope.process_name } : {}),
        ...(scope.window_title ? { window_title: scope.window_title } : {}),
        ...(scope.activity_hint ? { activity_hint: scope.activity_hint } : {}),
      };
    }
    out.variables = asArray(doc.variables).map((item) => {
      const mapped: Json = {
        name: item.name,
        type: item.type ?? 'string',
        required: item.required ?? false,
      };
      if (item.sensitive !== undefined) mapped.sensitive = item.sensitive;
      if (item.description !== undefined) mapped.description = item.description;
      if (item.default !== undefined) mapped.default = item.default;
      if (item.pattern !== undefined) mapped.pattern = item.pattern;
      if (item.min_length !== undefined) mapped.min_length = item.min_length;
      if (item.max_length !== undefined) mapped.max_length = item.max_length;
      return mapped;
    });
    out.permissions = Array.isArray(doc.permissions) ? doc.permissions : [];

    out.steps = asArray(doc.steps).map((step, index) => {
      const mapped: Json = {
        id: step.id ?? `strange-step-${index + 1}`,
        action: step.action ?? step.type,
      };
      for (const key of ['name', 'description'] as const) {
        if (step[key] !== undefined) mapped[key] = step[key];
      }
      const selector =
        (typeof step.selector === 'string' && step.selector) ||
        (typeof step.css === 'string' && step.css) ||
        undefined;
      if (step.target && typeof step.target === 'object') {
        mapped.target = step.target;
      } else if (selector) {
        mapped.target = selectorToTarget(selector, step.nativeId ?? step.native_id);
      }
      if (step.value !== undefined)
        mapped.params = { ...(mapped.params as Json), value: step.value };
      if (step.url !== undefined)
        mapped.params = { ...(mapped.params as Json), app_id: scope?.value, url: step.url };
      if (step.condition !== undefined)
        mapped.params = { ...(mapped.params as Json), condition: step.condition };
      if (step.outputVariable !== undefined) {
        mapped.params = { ...(mapped.params as Json), output_variable: step.outputVariable };
      }
      if (step.preconditions !== undefined) mapped.preconditions = step.preconditions;
      if (step.postcondition !== undefined) mapped.postconditions = [step.postcondition];
      if (step.postconditions !== undefined) mapped.postconditions = step.postconditions;
      const timeout = step.timeout_ms ?? step.timeout;
      if (timeout !== undefined) mapped.timeout_ms = timeout;
      const retry = (step.retry as Json | undefined) ?? undefined;
      if (retry) mapped.retry = retry;
      const retries = step.retryCount ?? step.retry_count;
      if (retries !== undefined)
        mapped.retry = { ...(mapped.retry as Json), max_attempts: Number(retries) + 1 };
      if (step.onFailure !== undefined) mapped.on_failure = step.onFailure;
      if (step.on_failure !== undefined) mapped.on_failure = step.on_failure;
      const risk = step.risk;
      if (risk === 'high') mapped.risk = 'irreversible';
      else if (risk === 'medium') mapped.risk = 'sensitive';
      else if (risk !== undefined) mapped.risk = risk;
      if (step.evidence_policy !== undefined) mapped.evidence_policy = step.evidence_policy;
      if (step.compensation_step_id !== undefined)
        mapped.compensation_step_id = step.compensation_step_id;
      if (mapped.params === undefined && typeof step.params === 'object' && step.params !== null) {
        mapped.params = step.params;
      }
      if (mapped.params === undefined) {
        if (mapped.action === 'click' || mapped.action === 'activate') mapped.params = {};
        if (mapped.action === 'end') mapped.params = { status: 'success' };
        if (mapped.action === 'launch') {
          mapped.params = {
            app_id: scope?.value,
            ...(step.url !== undefined ? { url: step.url } : {}),
          };
        }
      }
      return mapped;
    });

    const known = new Set([
      'schemaVersion',
      'flowId',
      'flow_id',
      'name',
      'description',
      'platform',
      'appScope',
      'app_scope',
      'createdBy',
      'created_by',
      'revision',
      'labels',
      'notes',
      'variables',
      'permissions',
      'steps',
      'schema_version',
    ]);
    for (const key of Object.keys(doc)) {
      if (!known.has(key))
        warn(
          diagnostics,
          'migration.dropped-field',
          `/${key}`,
          `0.9.0 field ${key} has no 1.0.0 mapping`,
        );
    }
    return out;
  },
};

function selectorToTarget(selector: string, nativeId?: unknown): Record<string, unknown> {
  const anchors: Record<string, unknown> = {};
  if (typeof nativeId === 'string' && nativeId.length > 0) {
    anchors.native_identity = { kind: 'web-dom-id', value: nativeId };
  } else if (/^#[A-Za-z][\w:-]*$/.test(selector)) {
    anchors.native_identity = { kind: 'web-dom-id', value: selector.slice(1) };
  } else {
    anchors.structure = { path: [selector.slice(0, 200)] };
  }
  return { anchors };
}

export const MIGRATIONS: readonly Migration[] = [migrate080to090, migrate090to100];

export function detectVersion(doc: unknown): string | null {
  if (typeof doc !== 'object' || doc === null) return null;
  const record = doc as Json;
  const version = record.schema_version ?? record.schemaVersion;
  return typeof version === 'string' ? version : null;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Loads any supported version. Refuses future/unknown versions and never
 * mutates the input document.
 */
export function loadFlow(
  input: unknown,
  options: { forExecution?: boolean } = {},
): MigrationResult {
  const diagnostics: Diagnostic[] = [];
  const report: MigrationReport = {
    from_version: detectVersion(input) ?? 'unknown',
    to_version: FLOW_SCHEMA_VERSION,
    applied: [],
    diagnostics,
  };
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    error(diagnostics, 'migration.not-object', '/', 'flow document must be an object');
    return { flow: null, report, raw: input };
  }

  let doc = clone(input as Json);
  let version = detectVersion(doc);
  if (version === null) {
    error(
      diagnostics,
      'migration.missing-version',
      '/schema_version',
      'document has no schema version',
    );
    return { flow: null, report, raw: doc };
  }
  if (compareVersions(version, FLOW_SCHEMA_VERSION) > 0) {
    error(
      diagnostics,
      'migration.future-version',
      '/schema_version',
      `document version ${version} is newer than supported ${FLOW_SCHEMA_VERSION}`,
    );
    return { flow: null, report, raw: doc };
  }
  if (!['0.8.0', '0.9.0', FLOW_SCHEMA_VERSION].includes(version)) {
    error(
      diagnostics,
      'migration.unknown-version',
      '/schema_version',
      `no migration path from ${version} to ${FLOW_SCHEMA_VERSION}`,
    );
    return { flow: null, report, raw: doc };
  }

  let guard = 0;
  while (version !== FLOW_SCHEMA_VERSION) {
    const migration = MIGRATIONS.find((item) => item.from === version);
    if (!migration) {
      error(diagnostics, 'migration.no-path', '/schema_version', `no migration from ${version}`);
      return { flow: null, report, raw: doc };
    }
    doc = migration.migrate(doc, diagnostics);
    report.applied.push(`${migration.from}->${migration.to}`);
    version = migration.to;
    doc.schema_version = version;
    guard += 1;
    if (guard > 16) {
      error(diagnostics, 'migration.loop', '/schema_version', 'migration loop detected');
      return { flow: null, report, raw: doc };
    }
  }
  if (doc.schemaVersion !== undefined) delete doc.schemaVersion;

  const validation = validateFlow(doc, options);
  diagnostics.push(...validation.errors, ...validation.warnings);
  if (!validation.ok) {
    return { flow: null, report, raw: doc };
  }
  return { flow: doc as unknown as Flow, report, raw: doc };
}
