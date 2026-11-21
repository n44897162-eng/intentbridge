/**
 * TypeScript mirror of flow-1.0.0.schema.json. Kept structurally identical to
 * the JSON Schema; the conformance test suite asserts both accept the same
 * corpus. Platform-private objects never appear here.
 */

export const FLOW_SCHEMA_VERSION = '1.0.0' as const;

export type Platform = 'web' | 'windows' | 'android';
export type Risk = 'normal' | 'sensitive' | 'irreversible';
export type Permission =
  | 'read-ui'
  | 'read-screen'
  | 'click'
  | 'type'
  | 'select'
  | 'scroll'
  | 'launch'
  | 'navigate'
  | 'upload'
  | 'download'
  | 'clipboard-read';

export const PERMISSIONS: readonly Permission[] = [
  'read-ui',
  'read-screen',
  'click',
  'type',
  'select',
  'scroll',
  'launch',
  'navigate',
  'upload',
  'download',
  'clipboard-read',
];

export type AppScope =
  | {
      kind: 'web-origin';
      value: string;
      window_title?: string;
      process_name?: string;
      activity_hint?: string;
    }
  | {
      kind: 'windows-app';
      value: string;
      window_title?: string;
      process_name?: string;
      activity_hint?: string;
    }
  | {
      kind: 'android-package';
      value: string;
      window_title?: string;
      process_name?: string;
      activity_hint?: string;
    };

export type VariableType = 'string' | 'number' | 'boolean' | 'date';

export interface FlowVariable {
  name: string;
  type: VariableType;
  required?: boolean;
  sensitive?: boolean;
  description?: string;
  default?: string | number | boolean;
  pattern?: string;
  min_length?: number;
  max_length?: number;
}

export type StepAction =
  | 'launch'
  | 'activate'
  | 'wait'
  | 'click'
  | 'input'
  | 'select'
  | 'scroll'
  | 'read-text'
  | 'assert'
  | 'set-variable'
  | 'branch'
  | 'compensate'
  | 'end';

export const STEP_ACTIONS: readonly StepAction[] = [
  'launch',
  'activate',
  'wait',
  'click',
  'input',
  'select',
  'scroll',
  'read-text',
  'assert',
  'set-variable',
  'branch',
  'compensate',
  'end',
];

/** Actions that can change external state and therefore need postconditions. */
export const MUTATING_ACTIONS: readonly StepAction[] = [
  'click',
  'input',
  'select',
  'scroll',
  'launch',
];

export interface Matcher {
  type: 'equals' | 'contains' | 'regex' | 'glob';
  value: string;
  case_sensitive?: boolean;
}

export type Condition =
  | { kind: 'element-present'; target: Target }
  | { kind: 'element-absent'; target: Target }
  | { kind: 'text-matches'; target: Target; matcher: Matcher }
  | { kind: 'window-stable'; min_stable_ms?: number }
  | {
      kind: 'variable-compare';
      variable: string;
      operator: 'equals' | 'not-equals' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte' | 'matches';
      value: string | number | boolean | null;
    }
  | { kind: 'url-matches'; pattern: string; match_type?: 'equals' | 'contains' | 'regex' }
  | { kind: 'app-in-foreground'; value: string };

export type ConditionKind = Condition['kind'];

export interface SemanticAnchor {
  role?: string;
  name?: string;
  label?: string;
  placeholder?: string;
  test_id?: string;
  control_type?: string;
  text?: string;
}

export interface StructureAnchor {
  path?: string[];
  parent?: string;
  container?: string;
  sibling_index?: number;
  sibling_count?: number;
}

export type NativeIdentityKind =
  | 'web-dom-id'
  | 'web-test-id'
  | 'uia-automation-id'
  | 'android-resource-id'
  | 'android-content-desc';

export interface NativeIdentity {
  kind: NativeIdentityKind;
  value: string;
}

export interface NormRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface VisualAnchor {
  dhash?: string;
  template_hash?: string;
  norm_rect?: NormRect;
  viewport?: { w: number; h: number };
  device_scale?: number;
  style_signature?: string;
}

export interface ConfidencePolicy {
  mode?: 'strict' | 'balanced';
  min_score?: number;
  ambiguity_margin?: number;
  visual_only_requires_confirmation?: boolean;
}

export interface Target {
  anchors: {
    semantic?: SemanticAnchor;
    structure?: StructureAnchor;
    native_identity?: NativeIdentity;
    visual?: VisualAnchor;
  };
  fallback_bounds?: { x: number; y: number; w: number; h: number };
  confidence?: ConfidencePolicy;
}

export interface RetryPolicy {
  max_attempts?: number;
  backoff_ms?: number;
  max_backoff_ms?: number;
  jitter_ratio?: number;
  idempotency_key?: string;
}

export interface EvidencePolicy {
  capture?: 'none' | 'target' | 'viewport';
  save_on?: 'failure' | 'always' | 'never';
  retention_days?: number;
  mask_selectors?: string[];
  mask_text?: boolean;
}

export type OnFailure =
  'stop' | 'ask-user' | { mode: 'stop' | 'ask-user' | 'goto-step'; goto_step_id?: string };

export interface StepParamsMap {
  launch: { app_id: string; url?: string; arguments?: string[]; wait_ready?: boolean };
  activate: { url_pattern?: string; window_title?: string; process_name?: string };
  wait: { condition: Condition; poll_interval_ms?: number };
  click: {
    button?: 'left' | 'right' | 'middle';
    click_count?: 1 | 2;
    modifiers?: Array<'ctrl' | 'alt' | 'shift' | 'meta'>;
    verify_enabled?: boolean;
  };
  input: { value: string; clear_first?: boolean; submit?: boolean; typing_delay_ms?: number };
  select: { value: string; by?: 'value' | 'label' | 'index' };
  scroll: {
    direction: 'up' | 'down' | 'left' | 'right';
    amount?: number;
    max_attempts?: number;
    boundary_condition?: Condition;
  };
  'read-text': { output_variable: string; max_chars?: number; sensitive?: boolean };
  assert: { condition: Condition; message?: string };
  'set-variable': { name: string; value: string | number | boolean; sensitive?: boolean };
  branch: { condition: Condition; goto_step_id: string; else_step_id?: string };
  compensate: { compensation_step_id: string; reason?: string };
  end: { status: 'success' | 'failed'; message?: string };
}

export interface Step<A extends StepAction = StepAction> {
  id: string;
  action: A;
  name?: string;
  description?: string;
  target?: Target | null;
  preconditions?: Condition[];
  postconditions?: Condition[];
  timeout_ms?: number;
  retry?: RetryPolicy;
  on_failure?: OnFailure;
  risk?: Risk;
  evidence_policy?: EvidencePolicy;
  compensation_step_id?: string;
  params?: StepParamsMap[A];
}

export interface FlowDefaults {
  timeout_ms?: number;
  retry?: RetryPolicy;
  evidence_policy?: EvidencePolicy;
}

export interface Flow {
  schema_version: typeof FLOW_SCHEMA_VERSION;
  flow_id: string;
  name: string;
  description?: string;
  platform: Platform;
  app_scope: AppScope;
  variables: FlowVariable[];
  permissions: Permission[];
  steps: Step[];
  created_by: string;
  revision: number;
  created_at?: string;
  updated_at?: string;
  labels?: Record<string, string>;
  notes?: string;
  defaults?: FlowDefaults;
}

export interface Diagnostic {
  severity: 'error' | 'warning';
  /** Unified protocol error code for fatal diagnostics. */
  code: 'INVALID_IR' | 'UNSAFE_FLOW' | 'UNSUPPORTED_CAPABILITY' | 'MIGRATION_FAILED';
  /** Stable machine-readable rule id, e.g. "step.missing-postcondition". */
  rule: string;
  /** JSON pointer-ish path: /steps/2/target/anchors. */
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: Diagnostic[];
  warnings: Diagnostic[];
}

/** Immutable flow revision as stored in flow_revisions. */
export interface FlowRevision {
  flow_id: string;
  revision: number;
  schema_version: string;
  hash: string;
  flow: Flow;
  created_at: string;
  created_by: string;
  signature?: { algorithm: string; key_id: string; value: string } | null;
}
