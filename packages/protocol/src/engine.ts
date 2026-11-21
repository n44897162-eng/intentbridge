/**
 * Host <-> runtime engine protocol (v1.0.0).
 *
 * The Rust state machine is the only authority for flow semantics. Hosts
 * (Web, Windows, Android) only resolve targets, perform platform actions and
 * supply observations. All documents in this file cross an FFI/IPC boundary and
 * are therefore validated on both sides.
 */
import type { BridgeError } from './error-codes.js';

export const ENGINE_PROTOCOL_VERSION = '1.0.0' as const;

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export type Risk = 'normal' | 'sensitive' | 'irreversible';

export type EngineState =
  | 'DRAFT'
  | 'VALIDATED'
  | 'ARMED'
  | 'RUNNING'
  | 'WAITING_CONDITION'
  | 'PAUSED_FOR_APPROVAL'
  | 'PAUSED_FOR_DISAMBIGUATION'
  | 'PAUSED_FOR_OUTCOME'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED'
  | 'OUTCOME_UNKNOWN';

export const TERMINAL_STATES: readonly EngineState[] = [
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'OUTCOME_UNKNOWN',
];

export interface EngineConfig {
  max_steps_per_run: number;
  max_runtime_ms: number;
  max_retries: number;
  max_branch_jumps: number;
  default_timeout_ms: number;
  /** Risks that always require an explicit approval per attempt. */
  require_approval_for: Risk[];
  /** Visual-only candidates can never auto-execute when false. */
  allow_visual_only_auto: boolean;
  min_auto_score: number;
  ambiguity_margin: number;
  /** Minimum structure/semantic evidence for auto execution. */
  min_semantic_score: number;
  retry_backoff_ms: number;
  retry_max_backoff_ms: number;
  retry_jitter_ratio: number;
}

export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  max_steps_per_run: 100,
  max_runtime_ms: 15 * 60 * 1000,
  max_retries: 2,
  max_branch_jumps: 100,
  default_timeout_ms: 30_000,
  require_approval_for: ['sensitive', 'irreversible'],
  allow_visual_only_auto: false,
  min_auto_score: 0.72,
  ambiguity_margin: 0.08,
  min_semantic_score: 0.6,
  retry_backoff_ms: 250,
  retry_max_backoff_ms: 4000,
  retry_jitter_ratio: 0.2,
};

/** A platform-observed element, normalized by the host adapter. */
export interface Candidate {
  candidate_id: string;
  native_identity?: { kind: string; value: string } | null;
  semantic?: {
    role?: string;
    name?: string;
    label?: string;
    placeholder?: string;
    test_id?: string;
    control_type?: string;
    text?: string;
  } | null;
  structure?: {
    path?: string[];
    parent?: string;
    container?: string;
    sibling_index?: number;
    sibling_count?: number;
  } | null;
  visual?: {
    dhash?: string;
    norm_rect?: { x: number; y: number; w: number; h: number };
    viewport?: { w: number; h: number };
    device_scale?: number;
    style_signature?: string;
  } | null;
  context?: { app_scope?: string; window_title?: string; url?: string } | null;
  visible: boolean;
  enabled: boolean;
  editable?: boolean;
  stale?: boolean;
  in_viewport?: boolean;
  rect?: { x: number; y: number; w: number; h: number } | null;
  text?: string | null;
}

export interface CandidateEvidence {
  native: number;
  semantic: number;
  structure: number;
  visual: number;
  context: number;
}

export interface RankedCandidate {
  candidate: Candidate;
  total: number;
  evidence: CandidateEvidence;
  reasons: string[];
  /** Passed the minimum evidence gates (may still need confirmation). */
  eligible: boolean;
  /** Allowed to execute with no human confirmation. */
  auto_eligible: boolean;
}

export interface TargetPolicy {
  mode: 'strict' | 'balanced';
  min_score: number;
  ambiguity_margin: number;
  visual_only_requires_confirmation: boolean;
}

export interface ObservedFacts {
  now_mono_ms: number;
  app_scope?: string;
  url?: string;
  window_title?: string;
  window_stable_ms?: number;
  elements?: Candidate[];
  variable_values?: Record<string, string | number | boolean | null>;
  text?: string;
  foreground?: boolean;
  /** Host-computed evidence pointer, never raw screen bytes. */
  evidence_ref?: string;
}

export interface ResolvedTarget {
  candidate_id: string;
  score: number;
  evidence: CandidateEvidence;
}

interface DirectiveBase {
  schema_version: typeof ENGINE_PROTOCOL_VERSION;
  /** Events produced while computing this directive, monotonic per run. */
  events: unknown[];
  state: EngineState;
}

export interface ResolveTargetDirective extends DirectiveBase {
  kind: 'ResolveTarget';
  step_id: string;
  attempt_id: string;
  target: JsonObject;
  risk: Risk;
}

export interface PerformActionDirective extends DirectiveBase {
  kind: 'PerformAction';
  step_id: string;
  attempt_id: string;
  action: string;
  params: JsonObject;
  target: JsonObject | null;
  risk: Risk;
  idempotency_key: string | null;
  resolved: ResolvedTarget | null;
  /** Params with secrets replaced by alias; safe for logs/UI. */
  params_preview: JsonObject;
}

export type ConditionPurpose = 'precondition' | 'postcondition' | 'wait' | 'boundary';

export interface AwaitConditionDirective extends DirectiveBase {
  kind: 'AwaitCondition';
  step_id: string;
  attempt_id: string;
  condition_id: string;
  condition: JsonObject;
  purpose: ConditionPurpose;
  deadline_mono_ms: number;
  poll_after_ms: number;
}

export interface ApprovalSummary {
  action: string;
  risk: Risk;
  step_name: string | null;
  target_label: string | null;
  params_preview: JsonObject;
  reasons: string[];
}

export interface AwaitApprovalDirective extends DirectiveBase {
  kind: 'AwaitApproval';
  step_id: string;
  attempt_id: string;
  summary: ApprovalSummary;
}

export interface AwaitDisambiguationDirective extends DirectiveBase {
  kind: 'AwaitDisambiguation';
  step_id: string;
  attempt_id: string;
  reason: 'ambiguous' | 'low_confidence' | 'visual_only' | 'stale';
  candidates: RankedCandidate[];
  policy: TargetPolicy;
}

export interface AwaitOutcomeDecisionDirective extends DirectiveBase {
  kind: 'AwaitOutcomeDecision';
  step_id: string;
  attempt_id: string;
  error: BridgeError;
  last_known_state: 'attempted' | 'postcondition_failed' | 'postcondition_timeout';
}

export interface AwaitRecoveryDirective extends DirectiveBase {
  kind: 'AwaitRecovery';
  step_id: string | null;
  reason: string;
  options: string[];
  error: BridgeError | null;
}

export interface AwaitTimerDirective extends DirectiveBase {
  kind: 'AwaitTimer';
  step_id: string | null;
  wake_at_mono_ms: number;
  reason: string;
}

export interface FinishedDirective extends DirectiveBase {
  kind: 'Finished';
  status: 'succeeded' | 'failed' | 'cancelled' | 'outcome_unknown';
  error: BridgeError | null;
}

export type Directive =
  | ResolveTargetDirective
  | PerformActionDirective
  | AwaitConditionDirective
  | AwaitApprovalDirective
  | AwaitDisambiguationDirective
  | AwaitOutcomeDecisionDirective
  | AwaitRecoveryDirective
  | AwaitTimerDirective
  | FinishedDirective;

interface InputBase {
  kind: string;
  now_mono_ms: number;
}

export interface CandidatesInput extends InputBase {
  kind: 'Candidates';
  step_id: string;
  attempt_id: string;
  candidates: Candidate[];
  facts?: ObservedFacts;
}

export interface ActionDoneInput extends InputBase {
  kind: 'ActionDone';
  step_id: string;
  attempt_id: string;
  outcome: 'succeeded' | 'failed' | 'unknown';
  error?: BridgeError;
  facts?: ObservedFacts;
  /** Output for read-text actions. */
  text?: string;
}

export interface ObservationInput extends InputBase {
  kind: 'Observation';
  step_id: string;
  attempt_id?: string;
  condition_id: string;
  facts: ObservedFacts;
}

export interface ApprovalInput extends InputBase {
  kind: 'Approval';
  step_id: string;
  attempt_id: string;
  approved: boolean;
  approval_id?: string;
}

export interface DisambiguationInput extends InputBase {
  kind: 'Disambiguation';
  step_id: string;
  attempt_id: string;
  candidate_id: string;
}

export interface OutcomeDecisionInput extends InputBase {
  kind: 'OutcomeDecision';
  step_id: string;
  attempt_id: string;
  decision: 'succeeded' | 'failed' | 'retry';
}

export interface CancelInput extends InputBase {
  kind: 'Cancel';
  reason?: string;
}

export interface TickInput extends InputBase {
  kind: 'Tick';
}

export type EngineInput =
  | CandidatesInput
  | ActionDoneInput
  | ObservationInput
  | ApprovalInput
  | DisambiguationInput
  | OutcomeDecisionInput
  | CancelInput
  | TickInput;

const DIRECTIVE_KINDS = [
  'ResolveTarget',
  'PerformAction',
  'AwaitCondition',
  'AwaitApproval',
  'AwaitDisambiguation',
  'AwaitOutcomeDecision',
  'AwaitRecovery',
  'AwaitTimer',
  'Finished',
] as const;

const INPUT_KINDS = [
  'Candidates',
  'ActionDone',
  'Observation',
  'Approval',
  'Disambiguation',
  'OutcomeDecision',
  'Cancel',
  'Tick',
] as const;

export function isDirective(value: unknown): value is Directive {
  return (
    typeof value === 'object' &&
    value !== null &&
    (DIRECTIVE_KINDS as readonly string[]).includes((value as { kind?: string }).kind ?? '')
  );
}

export function isEngineInput(value: unknown): value is EngineInput {
  return (
    typeof value === 'object' &&
    value !== null &&
    (INPUT_KINDS as readonly string[]).includes((value as { kind?: string }).kind ?? '')
  );
}

/** Boundary validation. Returns human-readable problems; empty means valid. */
export function validateEngineInput(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) return ['input must be an object'];
  const input = value as Record<string, unknown>;
  const errors: string[] = [];
  if (!INPUT_KINDS.includes(input.kind as (typeof INPUT_KINDS)[number])) {
    return [`unknown input kind: ${String(input.kind)}`];
  }
  if (!Number.isFinite(input.now_mono_ms)) errors.push('now_mono_ms must be a finite number');
  const kind = input.kind as string;
  if (kind !== 'Cancel' && kind !== 'Tick') {
    if (typeof input.step_id !== 'string' || input.step_id.length === 0) {
      errors.push('step_id required');
    }
  }
  if (
    ['Candidates', 'ActionDone', 'Approval', 'Disambiguation', 'OutcomeDecision'].includes(kind)
  ) {
    if (typeof input.attempt_id !== 'string' || input.attempt_id.length === 0) {
      errors.push('attempt_id required');
    }
  }
  if (kind === 'Candidates' && !Array.isArray(input.candidates)) errors.push('candidates required');
  if (
    kind === 'ActionDone' &&
    !['succeeded', 'failed', 'unknown'].includes(String(input.outcome))
  ) {
    errors.push('invalid ActionDone outcome');
  }
  if (kind === 'Observation') {
    if (typeof input.condition_id !== 'string') errors.push('condition_id required');
    if (typeof input.facts !== 'object' || input.facts === null) errors.push('facts required');
  }
  if (kind === 'Approval' && typeof input.approved !== 'boolean') errors.push('approved required');
  if (kind === 'Disambiguation' && typeof input.candidate_id !== 'string') {
    errors.push('candidate_id required');
  }
  if (
    kind === 'OutcomeDecision' &&
    !['succeeded', 'failed', 'retry'].includes(String(input.decision))
  ) {
    errors.push('invalid outcome decision');
  }
  return errors;
}

export function validateDirective(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) return ['directive must be an object'];
  const directive = value as Record<string, unknown>;
  if (!DIRECTIVE_KINDS.includes(directive.kind as (typeof DIRECTIVE_KINDS)[number])) {
    return [`unknown directive kind: ${String(directive.kind)}`];
  }
  const errors: string[] = [];
  if (directive.schema_version !== ENGINE_PROTOCOL_VERSION) errors.push('schema_version mismatch');
  if (typeof directive.state !== 'string') errors.push('state missing');
  if (!Array.isArray(directive.events)) errors.push('events must be an array');
  if (directive.kind !== 'Finished' && typeof directive.step_id !== 'string') {
    errors.push('step_id required');
  }
  if (directive.kind === 'AwaitCondition') {
    const deadline = directive.deadline_mono_ms;
    const poll = directive.poll_after_ms;
    if (!Number.isFinite(deadline)) errors.push('deadline_mono_ms required');
    if (!Number.isFinite(poll) || (poll as number) < 0) errors.push('poll_after_ms invalid');
  }
  if (directive.kind === 'Finished') {
    if (
      !['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(String(directive.status))
    ) {
      errors.push('invalid finished status');
    }
  }
  return errors;
}
