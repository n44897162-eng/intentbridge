//! Deterministic execution state machine.
//!
//! Invariants:
//! * No real clocks, RNG or threads. Time and observations are injected.
//! * Only ARMED flows can start; validated IR is mandatory.
//! * External writes are never retried unless the step declares idempotency.
//! * An action call is not success: postconditions decide.
//! * A write with an unobservable result pauses as OUTCOME_UNKNOWN.
//! * Every transition and observation is appended to the event log.

use crate::conditions::{evaluate, EvalContext, Facts};
use crate::events::{make_event, validate_event_sequence, RunEvent};
use crate::ir::{
    parse_origin, secret_ref, template_refs, validate_flow, Action, Condition, Flow, Step,
    ValidationIssue, ValidationLimits,
};
use ib_anchor::{rank, Candidate, Evidence, RankedCandidate};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};

pub const ENGINE_PROTOCOL_VERSION: &str = "1.0.0";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum EngineState {
    Draft,
    Validated,
    Armed,
    Running,
    WaitingCondition,
    PausedForApproval,
    PausedForDisambiguation,
    PausedForOutcome,
    PausedForRecovery,
    Succeeded,
    Failed,
    Cancelled,
    OutcomeUnknown,
}

impl EngineState {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Draft => "DRAFT",
            Self::Validated => "VALIDATED",
            Self::Armed => "ARMED",
            Self::Running => "RUNNING",
            Self::WaitingCondition => "WAITING_CONDITION",
            Self::PausedForApproval => "PAUSED_FOR_APPROVAL",
            Self::PausedForDisambiguation => "PAUSED_FOR_DISAMBIGUATION",
            Self::PausedForOutcome => "PAUSED_FOR_OUTCOME",
            Self::PausedForRecovery => "PAUSED_FOR_RECOVERY",
            Self::Succeeded => "SUCCEEDED",
            Self::Failed => "FAILED",
            Self::Cancelled => "CANCELLED",
            Self::OutcomeUnknown => "OUTCOME_UNKNOWN",
        }
    }

    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            Self::Succeeded | Self::Failed | Self::Cancelled | Self::OutcomeUnknown
        )
    }
}

#[derive(Debug, Clone)]
pub struct BridgeError {
    pub code: String,
    pub message: String,
    pub detail: Option<Value>,
    pub platform_detail: Option<String>,
    pub retryable: Option<bool>,
}

impl BridgeError {
    pub fn new(code: &str, message: &str) -> Self {
        Self {
            code: code.to_string(),
            message: message.to_string(),
            detail: None,
            platform_detail: None,
            retryable: None,
        }
    }

    pub fn with_detail(mut self, detail: Value) -> Self {
        self.detail = Some(detail);
        self
    }

    pub fn retryable(mut self, retryable: bool) -> Self {
        self.retryable = Some(retryable);
        self
    }
}

impl Serialize for BridgeError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut state = serializer.serialize_struct("BridgeError", 5)?;
        state.serialize_field("code", &self.code)?;
        state.serialize_field("message", &self.message)?;
        if let Some(detail) = &self.detail {
            state.serialize_field("detail", detail)?;
        }
        if let Some(platform_detail) = &self.platform_detail {
            state.serialize_field("platform_detail", platform_detail)?;
        }
        if let Some(retryable) = &self.retryable {
            state.serialize_field("retryable", retryable)?;
        }
        state.end()
    }
}

impl<'de> Deserialize<'de> for BridgeError {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        struct Raw {
            code: String,
            #[serde(default)]
            message: String,
            #[serde(default)]
            detail: Option<Value>,
            #[serde(default)]
            platform_detail: Option<String>,
            #[serde(default)]
            retryable: Option<bool>,
        }
        let raw = Raw::deserialize(deserializer)?;
        Ok(Self {
            code: raw.code,
            message: raw.message,
            detail: raw.detail,
            platform_detail: raw.platform_detail,
            retryable: raw.retryable,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct EngineConfig {
    pub max_steps_per_run: usize,
    pub max_runtime_ms: f64,
    pub max_retries: u32,
    pub max_branch_jumps: u32,
    pub default_timeout_ms: f64,
    pub require_approval_for: Vec<String>,
    pub allow_visual_only_auto: bool,
    pub min_auto_score: f64,
    pub ambiguity_margin: f64,
    pub min_semantic_score: f64,
    pub retry_backoff_ms: f64,
    pub retry_max_backoff_ms: f64,
    pub retry_jitter_ratio: f64,
}

impl Default for EngineConfig {
    fn default() -> Self {
        Self {
            max_steps_per_run: 100,
            max_runtime_ms: 15.0 * 60.0 * 1000.0,
            max_retries: 2,
            max_branch_jumps: 100,
            default_timeout_ms: 30_000.0,
            require_approval_for: vec!["sensitive".into(), "irreversible".into()],
            allow_visual_only_auto: false,
            min_auto_score: 0.72,
            ambiguity_margin: 0.08,
            min_semantic_score: 0.6,
            retry_backoff_ms: 250.0,
            retry_max_backoff_ms: 4000.0,
            retry_jitter_ratio: 0.2,
        }
    }
}

impl EngineConfig {
    fn anchor(&self) -> ib_anchor::AnchorConfig {
        ib_anchor::AnchorConfig {
            min_score: self.min_auto_score,
            ambiguity_margin: self.ambiguity_margin,
            min_semantic_score: self.min_semantic_score,
            min_semantic_for_native_auto: self.min_semantic_score,
            allow_visual_only_auto: self.allow_visual_only_auto,
            strict: false,
        }
    }

    fn validation_limits(&self) -> ValidationLimits {
        ValidationLimits {
            max_steps: self.max_steps_per_run,
            max_step_timeout_ms: 120_000,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApprovalSummary {
    pub action: String,
    pub risk: String,
    pub step_name: Option<String>,
    pub target_label: Option<String>,
    pub params_preview: Value,
    pub reasons: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TargetPolicy {
    pub mode: String,
    pub min_score: f64,
    pub ambiguity_margin: f64,
    pub visual_only_requires_confirmation: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResolvedTarget {
    pub candidate_id: String,
    pub score: f64,
    pub evidence: Evidence,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind")]
pub enum Directive {
    ResolveTarget {
        step_id: String,
        attempt_id: String,
        target: Value,
        risk: String,
    },
    PerformAction {
        step_id: String,
        attempt_id: String,
        action: String,
        params: Value,
        target: Option<Value>,
        risk: String,
        idempotency_key: Option<String>,
        resolved: Option<ResolvedTarget>,
        params_preview: Value,
    },
    AwaitCondition {
        step_id: String,
        attempt_id: String,
        condition_id: String,
        condition: Value,
        purpose: String,
        deadline_mono_ms: f64,
        poll_after_ms: f64,
    },
    AwaitApproval {
        step_id: String,
        attempt_id: String,
        summary: ApprovalSummary,
    },
    AwaitDisambiguation {
        step_id: String,
        attempt_id: String,
        reason: String,
        candidates: Vec<RankedCandidate>,
        policy: TargetPolicy,
    },
    AwaitOutcomeDecision {
        step_id: String,
        attempt_id: String,
        error: BridgeError,
        last_known_state: String,
    },
    AwaitRecovery {
        step_id: Option<String>,
        reason: String,
        options: Vec<String>,
        error: Option<BridgeError>,
    },
    AwaitTimer {
        step_id: Option<String>,
        wake_at_mono_ms: f64,
        reason: String,
    },
    Finished {
        status: String,
        error: Option<BridgeError>,
    },
}

#[derive(Debug, Clone)]
pub struct StepOutput {
    pub schema_version: String,
    pub state: EngineState,
    pub events: Vec<RunEvent>,
    pub directive: Directive,
}

impl StepOutput {
    pub fn to_value(&self) -> Value {
        let mut map = match serde_json::to_value(&self.directive) {
            Ok(Value::Object(map)) => map,
            _ => Map::new(),
        };
        map.insert("schema_version".into(), json!(self.schema_version));
        map.insert("state".into(), json!(self.state.as_str()));
        map.insert("events".into(), json!(self.events));
        Value::Object(map)
    }
}

#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    Pre,
    Resolve,
    Approval,
    Action,
    Post,
    RetryWait,
    Complete,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Purpose {
    Pre,
    Post,
    Wait,
    Branch,
    Assert,
    ScrollBoundary,
}

impl Purpose {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Pre => "precondition",
            Self::Post => "postcondition",
            Self::Wait => "wait",
            Self::Branch => "wait",
            Self::Assert => "postcondition",
            Self::ScrollBoundary => "boundary",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
enum Pending {
    Idle,
    Resolve {
        step_id: String,
        attempt_id: String,
    },
    Action {
        step_id: String,
        attempt_id: String,
    },
    Condition {
        step_id: String,
        condition_id: String,
        purpose: Purpose,
        deadline: f64,
        round: u32,
    },
    Approval {
        step_id: String,
        attempt_id: String,
    },
    Disambiguation {
        step_id: String,
        attempt_id: String,
        ids: Vec<String>,
    },
    Outcome {
        step_id: String,
        attempt_id: String,
    },
    Recovery {
        reason: String,
        options: Vec<String>,
    },
    Timer {
        wake_at: f64,
    },
    Finished,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind")]
pub enum EngineInput {
    Candidates {
        now_mono_ms: f64,
        step_id: String,
        attempt_id: String,
        candidates: Vec<Candidate>,
        facts: Option<Facts>,
    },
    ActionDone {
        now_mono_ms: f64,
        step_id: String,
        attempt_id: String,
        outcome: String,
        error: Option<BridgeError>,
        facts: Option<Facts>,
        text: Option<String>,
    },
    Observation {
        now_mono_ms: f64,
        step_id: String,
        attempt_id: Option<String>,
        condition_id: String,
        facts: Facts,
    },
    Approval {
        now_mono_ms: f64,
        step_id: String,
        attempt_id: String,
        approved: bool,
        approval_id: Option<String>,
    },
    Disambiguation {
        now_mono_ms: f64,
        step_id: String,
        attempt_id: String,
        candidate_id: String,
    },
    OutcomeDecision {
        now_mono_ms: f64,
        step_id: String,
        attempt_id: String,
        decision: String,
    },
    Pause {
        now_mono_ms: f64,
    },
    RecoveryDecision {
        now_mono_ms: f64,
        decision: String,
        note: Option<String>,
    },
    Cancel {
        now_mono_ms: f64,
        reason: Option<String>,
    },
    Tick {
        now_mono_ms: f64,
    },
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct StartOptions {
    pub run_id: String,
    pub now_mono_ms: f64,
    pub wall_time_ms: i64,
    pub variables: BTreeMap<String, Value>,
    /// Optional step id to start from (trial runs). Recorded as a diagnostic.
    pub start_step_id: Option<String>,
    /// Stop after one step and wait for an explicit resume.
    pub single_step: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct RecoveredRun {
    pub run_id: String,
    pub state: EngineState,
    pub last_event_seq: u64,
    pub last_step_id: Option<String>,
    pub terminated: bool,
    pub may_have_side_effects: bool,
    pub errors: Vec<String>,
}

pub struct Engine {
    config: EngineConfig,
    flow: Option<Flow>,
    state: EngineState,
    issues: Vec<ValidationIssue>,
    run_id: String,
    seq: u64,
    events: Vec<RunEvent>,
    pending_events: Vec<RunEvent>,
    variables: BTreeMap<String, Value>,
    sensitive_variables: BTreeSet<String>,
    step_index: usize,
    steps_executed: u64,
    branch_jumps: u64,
    started_mono: f64,
    now: f64,
    wall_base_ms: i64,
    last_now: f64,
    phase: Phase,
    pre_index: usize,
    post_index: usize,
    step_deadline: f64,
    attempt: u32,
    attempt_id: String,
    resolved: Option<ResolvedTarget>,
    manual_override: bool,
    last_error: Option<BridgeError>,
    last_ranking: Vec<RankedCandidate>,
    pending: Pending,
    last_directive: Option<Directive>,
    resume_directive: Option<Directive>,
    pause_resume_pending: Option<Pending>,
    recovery_step: Option<usize>,
    compensation: Option<CompensationContext>,
    side_effect_pending: bool,
    attempted_writes: u64,
    confirmed_writes: u64,
    finished_output: bool,
    approval_granted_for: Option<String>,
    single_step: bool,
    recovery_reason: Option<String>,
}

#[derive(Debug, Clone)]
struct CompensationContext {
    resume_index: Option<usize>,
    finish_error: Option<BridgeError>,
    source_step: String,
}

fn err(code: &str, message: &str) -> BridgeError {
    BridgeError::new(code, message)
}

fn sensitive_key(key: &str) -> bool {
    let lower = key.to_lowercase();
    [
        "password",
        "passwd",
        "secret",
        "token",
        "otp",
        "pin",
        "card",
        "cvv",
        "credential",
        "api_key",
        "apikey",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

pub fn preview_params(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut out = Map::new();
            for (key, item) in map {
                if sensitive_key(key) {
                    if let Value::String(text) = item {
                        if secret_ref(text).is_some() {
                            out.insert(key.clone(), item.clone());
                            continue;
                        }
                    }
                    out.insert(key.clone(), json!("«redacted»"));
                } else {
                    out.insert(key.clone(), preview_params(item));
                }
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.iter().map(preview_params).collect()),
        Value::String(text) => {
            if secret_ref(text).is_some() {
                Value::String(text.clone())
            } else if text.len() > 200 {
                Value::String(format!("{}…", &text[..200]))
            } else {
                Value::String(text.clone())
            }
        }
        other => other.clone(),
    }
}

impl Engine {
    pub fn new() -> Self {
        Self::with_config(EngineConfig::default())
    }

    pub fn with_config(config: EngineConfig) -> Self {
        Self {
            config,
            flow: None,
            state: EngineState::Draft,
            issues: Vec::new(),
            run_id: String::new(),
            seq: 0,
            events: Vec::new(),
            pending_events: Vec::new(),
            variables: BTreeMap::new(),
            sensitive_variables: BTreeSet::new(),
            step_index: 0,
            steps_executed: 0,
            branch_jumps: 0,
            started_mono: 0.0,
            now: 0.0,
            wall_base_ms: 0,
            last_now: 0.0,
            phase: Phase::Pre,
            pre_index: 0,
            post_index: 0,
            step_deadline: 0.0,
            attempt: 0,
            attempt_id: String::new(),
            resolved: None,
            manual_override: false,
            last_error: None,
            last_ranking: Vec::new(),
            pending: Pending::Idle,
            last_directive: None,
            resume_directive: None,
            pause_resume_pending: None,
            recovery_step: None,
            compensation: None,
            side_effect_pending: false,
            attempted_writes: 0,
            confirmed_writes: 0,
            finished_output: false,
            approval_granted_for: None,
            single_step: false,
            recovery_reason: None,
        }
    }

    pub fn state(&self) -> EngineState {
        self.state
    }

    pub fn events(&self) -> &[RunEvent] {
        &self.events
    }

    pub fn issues(&self) -> &[ValidationIssue] {
        &self.issues
    }

    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    pub fn load_value(&mut self, flow: Flow) -> Result<Vec<ValidationIssue>, BridgeError> {
        let issues = validate_flow(&flow, false, &self.config.validation_limits());
        self.issues = issues.clone();
        if issues.iter().any(|issue| issue.severity == "error") {
            self.flow = Some(flow);
            self.state = EngineState::Draft;
            return Err(err("INVALID_IR", "flow failed semantic validation")
                .with_detail(json!({ "issues": issues })));
        }
        self.flow = Some(flow);
        self.state = EngineState::Draft;
        Ok(issues)
    }

    pub fn load_json(&mut self, json_text: &str) -> Result<Vec<ValidationIssue>, BridgeError> {
        let flow: Flow = serde_json::from_str(json_text).map_err(|error| {
            err("INVALID_IR", "flow is not structurally valid")
                .with_detail(json!({ "parse_error": error.to_string() }))
        })?;
        self.load_value(flow)
    }

    pub fn validate(&mut self) -> Result<Vec<ValidationIssue>, BridgeError> {
        if self.state != EngineState::Draft {
            return Err(err("INVALID_STATE", "validate requires DRAFT"));
        }
        let flow = self
            .flow
            .as_ref()
            .ok_or_else(|| err("INVALID_STATE", "no flow loaded"))?;
        let issues = validate_flow(flow, true, &self.config.validation_limits());
        self.issues = issues.clone();
        if issues.iter().any(|issue| issue.severity == "error") {
            return Err(err("INVALID_IR", "flow failed execution validation")
                .with_detail(json!({ "issues": issues })));
        }
        self.state = EngineState::Validated;
        Ok(issues)
    }

    pub fn arm(&mut self) -> Result<(), BridgeError> {
        if self.state != EngineState::Validated {
            return Err(err("INVALID_STATE", "arm requires VALIDATED"));
        }
        self.state = EngineState::Armed;
        Ok(())
    }

    pub fn start(&mut self, options: StartOptions) -> Result<StepOutput, BridgeError> {
        if self.state != EngineState::Armed {
            return Err(err("INVALID_STATE", "start requires ARMED"));
        }
        if options.run_id.trim().is_empty() {
            return Err(err("INVALID_IR", "run_id is required"));
        }
        let flow = self
            .flow
            .as_ref()
            .ok_or_else(|| err("INVALID_STATE", "no flow loaded"))?
            .clone();
        self.run_id = options.run_id;
        self.seq = 0;
        self.events.clear();
        self.pending_events.clear();
        self.now = options.now_mono_ms;
        self.last_now = options.now_mono_ms;
        self.started_mono = options.now_mono_ms;
        self.wall_base_ms = options.wall_time_ms;
        self.steps_executed = 0;
        self.branch_jumps = 0;
        self.variables.clear();
        self.sensitive_variables.clear();
        for variable in &flow.variables {
            if let Some(default) = &variable.default {
                self.variables
                    .insert(variable.name.clone(), default.clone());
            }
            if variable.sensitive.unwrap_or(false) {
                self.sensitive_variables.insert(variable.name.clone());
            }
        }
        for (name, value) in options.variables {
            let sensitive = flow
                .variables
                .iter()
                .find(|variable| variable.name == name)
                .map(|variable| variable.sensitive.unwrap_or(false))
                .unwrap_or(false);
            if sensitive {
                self.sensitive_variables.insert(name.clone());
            }
            self.variables.insert(name, value);
        }
        for variable in &flow.variables {
            if variable.required.unwrap_or(false) && !self.variables.contains_key(&variable.name) {
                return Err(err("INVALID_IR", "required variable is missing")
                    .with_detail(json!({ "variable": variable.name })));
            }
        }
        self.state = EngineState::Running;
        self.single_step = options.single_step;
        let start_index = if let Some(step_id) = &options.start_step_id {
            match flow.steps.iter().position(|step| &step.id == step_id) {
                Some(index) => index,
                None => {
                    return Err(err("INVALID_IR", "start_step_id does not exist")
                        .with_detail(json!({ "step_id": step_id })));
                }
            }
        } else {
            0
        };
        self.emit(
            "RunStarted",
            None,
            None,
            json!({
                "flow_id": flow.flow_id,
                "revision": flow.revision,
                "platform": flow.platform,
                "app_scope": flow.app_scope.value,
            }),
        );
        if options.start_step_id.is_some() || options.single_step {
            self.emit(
                "Diagnostic",
                None,
                None,
                json!({
                    "reason": "trial_run_options",
                    "start_step_id": options.start_step_id,
                    "single_step": options.single_step,
                }),
            );
        }
        self.begin_step(start_index)
    }

    fn flow(&self) -> Result<Flow, BridgeError> {
        self.flow
            .clone()
            .ok_or_else(|| err("INVALID_STATE", "no flow loaded"))
    }

    fn wall(&self) -> i64 {
        self.wall_base_ms + (self.now - self.started_mono).round() as i64
    }

    fn emit(
        &mut self,
        event_type: &str,
        step_id: Option<String>,
        attempt_id: Option<String>,
        payload: Value,
    ) {
        self.seq += 1;
        let event = make_event(
            &self.run_id,
            self.seq,
            self.now,
            self.wall(),
            step_id.as_deref(),
            attempt_id.as_deref(),
            event_type,
            payload,
        );
        self.events.push(event.clone());
        self.pending_events.push(event);
    }

    fn set_state(&mut self, to: EngineState) {
        if self.state == to {
            return;
        }
        let from = self.state.as_str().to_string();
        self.emit(
            "StateChanged",
            None,
            None,
            json!({ "from": from, "to": to.as_str() }),
        );
        self.state = to;
    }

    fn output(&mut self, directive: Directive) -> StepOutput {
        self.last_directive = Some(directive.clone());
        StepOutput {
            schema_version: ENGINE_PROTOCOL_VERSION.to_string(),
            state: self.state,
            events: std::mem::take(&mut self.pending_events),
            directive,
        }
    }

    fn now_from(&mut self, now: f64) -> Result<f64, BridgeError> {
        if !now.is_finite() {
            return Err(err("INVALID_STATE", "now_mono_ms must be finite"));
        }
        if now + 1e-6 < self.last_now {
            return Err(err("INVALID_STATE", "now_mono_ms moved backwards"));
        }
        self.now = now;
        self.last_now = now;
        Ok(now)
    }

    fn step(&self) -> Result<Step, BridgeError> {
        let flow = self.flow()?;
        flow.steps
            .get(self.step_index)
            .cloned()
            .ok_or_else(|| err("INVALID_STATE", "no current step"))
    }

    fn permission_ok(&self, step: &Step) -> bool {
        let Ok(flow) = self.flow() else { return false };
        step.action
            .required_permissions()
            .iter()
            .all(|permission| flow.permissions.iter().any(|item| item == permission))
    }

    fn risk(&self, step: &Step) -> String {
        step.risk.clone().unwrap_or_else(|| "normal".into())
    }

    fn approval_required(&self, step: &Step) -> bool {
        let risk = self.risk(step);
        risk != "normal"
            && self
                .config
                .require_approval_for
                .iter()
                .any(|item| item == &risk)
    }

    fn idempotency_key(&self, step: &Step) -> Option<String> {
        step.retry
            .as_ref()
            .and_then(|retry| retry.idempotency_key.clone())
    }

    fn max_attempts(&self, step: &Step) -> u32 {
        let default_attempts = self.config.max_retries + 1;
        let configured = step
            .retry
            .as_ref()
            .and_then(|retry| retry.max_attempts)
            .unwrap_or(default_attempts as u64) as u32;
        configured.min(default_attempts).max(1)
    }

    fn retryable_failure(&self, step: &Step, error: &BridgeError) -> bool {
        if error.code == "OUTCOME_UNKNOWN" || error.code == "APP_SCOPE_VIOLATION" {
            return false;
        }
        if error.retryable == Some(false) {
            return false;
        }
        if step.action.is_read_only() {
            return true;
        }
        self.idempotency_key(step).is_some()
    }

    fn backoff(&self, round: u32, base: f64) -> f64 {
        let exponential = base * 2f64.powi(round.min(6) as i32);
        let capped = exponential.min(self.config.retry_max_backoff_ms.max(base));
        let hash = crate::events::event_id(&self.run_id, self.seq + 1 + round as u64);
        let noise =
            (hash.bytes().fold(0u32, |acc, b| acc.wrapping_add(b as u32)) % 100) as f64 / 100.0;
        let jitter = 1.0 + noise * self.config.retry_jitter_ratio;
        (capped * jitter).round()
    }

    fn begin_step(&mut self, index: usize) -> Result<StepOutput, BridgeError> {
        let flow = self.flow()?;
        if index >= flow.steps.len() {
            return self.finish_succeeded();
        }
        if self.now - self.started_mono > self.config.max_runtime_ms {
            return self
                .finish_failed(err("TIMEOUT", "run exceeded max_runtime_ms").retryable(false));
        }
        self.steps_executed += 1;
        if self.steps_executed > self.config.max_steps_per_run as u64 {
            return self.finish_failed(
                err("RUNTIME_LIMIT_EXCEEDED", "run exceeded max_steps_per_run").retryable(false),
            );
        }
        let step = flow.steps[index].clone();
        self.step_index = index;
        self.phase = Phase::Pre;
        self.pre_index = 0;
        self.post_index = 0;
        self.attempt = 0;
        self.attempt_id.clear();
        self.resolved = None;
        self.manual_override = false;
        self.last_error = None;
        self.approval_granted_for = None;
        self.step_deadline = self.now
            + step
                .timeout_ms
                .map(|value| value as f64)
                .unwrap_or(self.config.default_timeout_ms);
        self.set_state(EngineState::Running);
        self.emit(
            "StepPlanned",
            Some(step.id.clone()),
            None,
            json!({
                "index": index,
                "action": step.action.as_str(),
                "risk": self.risk(&step),
            }),
        );
        if !self.permission_ok(&step) {
            let error = err(
                "PERMISSION_DENIED",
                "flow lacks the permission required by this step",
            );
            return self.fail_step(error);
        }
        if step.action == Action::End {
            let status = step
                .params
                .as_ref()
                .and_then(|params| params.get("status"))
                .and_then(Value::as_str)
                .unwrap_or("success");
            self.attempt_id = format!("{}-s{}-end", self.run_id_short(), index);
            if status == "success" {
                self.emit(
                    "StepSucceeded",
                    Some(step.id.clone()),
                    Some(self.attempt_id.clone()),
                    json!({ "action": "end" }),
                );
                return self.finish_succeeded();
            }
            let message = step
                .params
                .as_ref()
                .and_then(|params| params.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("flow ended with failure");
            return self.finish_failed(err("POSTCONDITION_FAILED", message));
        }
        if step.preconditions.is_empty() {
            return self.after_preconditions();
        }
        self.request_condition(Purpose::Pre, 0)
    }

    fn run_id_short(&self) -> String {
        self.run_id.chars().take(8).collect()
    }

    fn after_preconditions(&mut self) -> Result<StepOutput, BridgeError> {
        let step = self.step()?;
        match step.action {
            Action::Wait => self.request_condition(Purpose::Wait, 0),
            Action::Assert => self.request_condition(Purpose::Assert, 0),
            Action::Branch => self.request_condition(Purpose::Branch, 0),
            Action::SetVariable => {
                let params = step.params.clone().unwrap_or_else(|| json!({}));
                let name = params
                    .get("name")
                    .and_then(Value::as_str)
                    .ok_or_else(|| err("INVALID_IR", "set-variable requires name"))?
                    .to_string();
                let raw = params
                    .get("value")
                    .cloned()
                    .ok_or_else(|| err("INVALID_IR", "set-variable requires value"))?;
                let value = self.resolve_value(&raw)?;
                let sensitive = params
                    .get("sensitive")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                self.variables.insert(name.clone(), value);
                if sensitive {
                    self.sensitive_variables.insert(name.clone());
                }
                self.emit(
                    "VariableSet",
                    Some(step.id.clone()),
                    None,
                    json!({ "name": name, "sensitive": sensitive }),
                );
                self.complete_step_success()
            }
            Action::Compensate => {
                let params = step.params.clone().unwrap_or_else(|| json!({}));
                let target_id = params
                    .get("compensation_step_id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| err("INVALID_IR", "compensate requires compensation_step_id"))?;
                self.jump_to_compensation(target_id, None)
            }
            _ => {
                if step.target.is_some() {
                    self.begin_resolve()
                } else {
                    self.perform_action()
                }
            }
        }
    }

    fn condition_at(&self, purpose: Purpose, index: usize) -> Result<Condition, BridgeError> {
        let step = self.step()?;
        let condition = match purpose {
            Purpose::Pre => step.preconditions.get(index).cloned(),
            Purpose::Post => step.postconditions.get(index).cloned(),
            Purpose::Wait | Purpose::Assert => step
                .params
                .as_ref()
                .and_then(|params| params.get("condition"))
                .cloned()
                .and_then(|value| serde_json::from_value::<Condition>(value).ok()),
            Purpose::Branch => step
                .params
                .as_ref()
                .and_then(|params| params.get("condition"))
                .cloned()
                .and_then(|value| serde_json::from_value::<Condition>(value).ok()),
            Purpose::ScrollBoundary => step
                .params
                .as_ref()
                .and_then(|params| params.get("boundary_condition"))
                .cloned()
                .and_then(|value| serde_json::from_value::<Condition>(value).ok()),
        };
        let condition =
            condition.ok_or_else(|| err("INVALID_IR", "condition is missing or invalid"))?;
        self.resolve_condition(condition)
    }

    fn resolve_text(&self, text: &str) -> Result<String, BridgeError> {
        match self.resolve_value(&Value::String(text.to_string()))? {
            Value::String(value) => Ok(value),
            other => Ok(other.to_string()),
        }
    }

    /// Conditions may reference variables (e.g. expected text). Interpolation is
    /// done by the engine so every platform compares the same resolved value.
    fn resolve_condition(&self, mut condition: Condition) -> Result<Condition, BridgeError> {
        match &mut condition {
            Condition::TextMatches { matcher, .. } => {
                matcher.value = self.resolve_text(&matcher.value)?;
            }
            Condition::VariableCompare {
                value: Value::String(text),
                ..
            } => {
                *text = self.resolve_text(text)?;
            }
            Condition::UrlMatches { pattern, .. } => {
                *pattern = self.resolve_text(pattern)?;
            }
            Condition::AppInForeground { value } => {
                *value = self.resolve_text(value)?;
            }
            _ => {}
        }
        Ok(condition)
    }

    fn request_condition(
        &mut self,
        purpose: Purpose,
        index: usize,
    ) -> Result<StepOutput, BridgeError> {
        let step = self.step()?;
        let condition = self.condition_at(purpose, index)?;
        let deadline = if purpose == Purpose::Branch {
            (self.now + 5_000.0).min(self.step_deadline)
        } else {
            self.step_deadline
        };
        let condition_id = format!(
            "{}-{}-{}",
            if self.attempt_id.is_empty() {
                format!("s{}", self.step_index)
            } else {
                self.attempt_id.clone()
            },
            purpose.as_str(),
            index
        );
        let poll = if purpose == Purpose::Branch {
            0.0
        } else {
            50.0
        };
        self.pending = Pending::Condition {
            step_id: step.id.clone(),
            condition_id: condition_id.clone(),
            purpose,
            deadline,
            round: 0,
        };
        self.set_state(EngineState::WaitingCondition);
        Ok(self.output(Directive::AwaitCondition {
            step_id: step.id,
            attempt_id: self.attempt_id.clone(),
            condition_id,
            condition: serde_json::to_value(&condition).unwrap_or(Value::Null),
            purpose: purpose.as_str().to_string(),
            deadline_mono_ms: deadline,
            poll_after_ms: poll,
        }))
    }

    fn begin_resolve(&mut self) -> Result<StepOutput, BridgeError> {
        let step = self.step()?;
        let target = step
            .target
            .clone()
            .ok_or_else(|| err("INVALID_STATE", "resolve requires a target"))?;
        self.phase = Phase::Resolve;
        if self.attempt_id.is_empty() {
            self.attempt_id = format!("{}-s{}", self.run_id_short(), self.step_index);
        }
        let risk = self.risk(&step);
        self.pending = Pending::Resolve {
            step_id: step.id.clone(),
            attempt_id: self.attempt_id.clone(),
        };
        self.set_state(EngineState::Running);
        Ok(self.output(Directive::ResolveTarget {
            step_id: step.id,
            attempt_id: self.attempt_id.clone(),
            target: serde_json::to_value(&target).unwrap_or(Value::Null),
            risk,
        }))
    }

    fn scope_matches(&self, observed: Option<&str>) -> bool {
        let Some(observed) = observed else {
            return true;
        };
        let Ok(flow) = self.flow() else { return false };
        let expected = flow
            .app_scope
            .value
            .trim()
            .trim_end_matches('/')
            .to_lowercase();
        let observed = observed.trim().trim_end_matches('/').to_lowercase();
        if observed.is_empty() {
            return true;
        }
        match flow.platform.as_str() {
            "web" => match (parse_origin(&observed), parse_origin(&expected)) {
                (Some(a), Some(b)) => a == b,
                _ => observed == expected,
            },
            _ => observed == expected,
        }
    }

    fn pause_for_scope(&mut self, observed: Option<&str>) -> StepOutput {
        let expected = self
            .flow
            .as_ref()
            .map(|flow| flow.app_scope.value.clone())
            .unwrap_or_default();
        let error = err(
            "APP_SCOPE_VIOLATION",
            "foreground app left the flow app scope",
        )
        .with_detail(json!({ "expected_scope": expected, "observed_scope": observed }));
        self.emit(
            "RunPaused",
            None,
            None,
            json!({ "reason": "app_scope_violation" }),
        );
        self.set_state(EngineState::PausedForRecovery);
        self.resume_directive = self.last_directive.clone();
        self.pause_resume_pending = Some(self.pending.clone());
        self.pending = Pending::Recovery {
            reason: "app_scope_violation".into(),
            options: vec!["resume".into(), "stop".into()],
        };
        self.recovery_step = Some(self.step_index);
        self.output(Directive::AwaitRecovery {
            step_id: Some(self.step().map(|step| step.id).unwrap_or_default()),
            reason: "app_scope_violation".into(),
            options: vec!["resume".into(), "stop".into()],
            error: Some(error),
        })
    }

    fn on_candidates(
        &mut self,
        step_id: &str,
        attempt_id: &str,
        candidates: Vec<Candidate>,
        facts: Option<Facts>,
    ) -> Result<StepOutput, BridgeError> {
        let step = self.step()?;
        if step.id != step_id || self.attempt_id != attempt_id {
            return Err(err(
                "INVALID_STATE",
                "candidates do not match the pending resolution",
            ));
        }
        if let Some(facts) = &facts {
            if !self.scope_matches(facts.app_scope.as_deref()) {
                return Ok(self.pause_for_scope(facts.app_scope.as_deref()));
            }
        }
        let target = step
            .target
            .clone()
            .ok_or_else(|| err("INVALID_STATE", "no target for resolution"))?;
        let expected_scope = self
            .flow
            .as_ref()
            .map(|flow| flow.app_scope.value.clone())
            .unwrap_or_default();
        let ranking = rank(
            &target,
            &self.config.anchor(),
            Some(&expected_scope),
            &candidates,
        );
        let top: Vec<Value> = ranking
            .ranked
            .iter()
            .take(20)
            .map(|item| {
                json!({
                    "candidate_id": item.candidate.candidate_id,
                    "total": (item.total * 1000.0).round() / 1000.0,
                    "evidence": item.evidence,
                    "eligible": item.eligible,
                    "auto_eligible": item.auto_eligible,
                    "reasons": item.reasons,
                })
            })
            .collect();
        self.emit(
            "CandidatesRanked",
            Some(step.id.clone()),
            Some(attempt_id.to_string()),
            json!({
                "decision": format!("{:?}", ranking.decision),
                "candidates": top,
                "scope": expected_scope,
            }),
        );
        self.last_ranking = ranking.ranked.clone();
        match ranking.decision {
            ib_anchor::Decision::Auto => {
                let best = ranking
                    .ranked
                    .iter()
                    .find(|item| item.auto_eligible)
                    .ok_or_else(|| err("INTERNAL_ERROR", "auto decision without candidate"))?;
                self.resolved = Some(ResolvedTarget {
                    candidate_id: best.candidate.candidate_id.clone(),
                    score: best.total,
                    evidence: best.evidence,
                });
                self.after_resolution()
            }
            ib_anchor::Decision::Confirm(reason) if reason.as_str() == "stale" => {
                if self.now >= self.step_deadline {
                    return self.fail_step(err("STALE_TARGET", "all candidates remained stale"));
                }
                let wake = self.now + self.backoff(0, self.config.retry_backoff_ms);
                self.pending = Pending::Timer { wake_at: wake };
                self.phase = Phase::Resolve;
                self.set_state(EngineState::WaitingCondition);
                Ok(self.output(Directive::AwaitTimer {
                    step_id: Some(step.id),
                    wake_at_mono_ms: wake,
                    reason: "stale_re_resolve".into(),
                }))
            }
            ib_anchor::Decision::Confirm(reason) => {
                let eligible: Vec<RankedCandidate> = ranking
                    .ranked
                    .iter()
                    .filter(|item| item.eligible)
                    .take(20)
                    .cloned()
                    .collect();
                let ids: Vec<String> = eligible
                    .iter()
                    .map(|item| item.candidate.candidate_id.clone())
                    .collect();
                self.pending = Pending::Disambiguation {
                    step_id: step.id.clone(),
                    attempt_id: attempt_id.to_string(),
                    ids,
                };
                self.set_state(EngineState::PausedForDisambiguation);
                self.emit(
                    "RunPaused",
                    Some(step.id.clone()),
                    Some(attempt_id.to_string()),
                    json!({ "reason": "disambiguation", "reasons": [reason.as_str()] }),
                );
                let policy_target = target.confidence.clone().unwrap_or_default();
                Ok(self.output(Directive::AwaitDisambiguation {
                    step_id: step.id,
                    attempt_id: attempt_id.to_string(),
                    reason: reason.as_str().to_string(),
                    candidates: eligible,
                    policy: TargetPolicy {
                        mode: policy_target.mode.unwrap_or_else(|| "balanced".into()),
                        min_score: policy_target
                            .min_score
                            .unwrap_or(self.config.min_auto_score),
                        ambiguity_margin: policy_target
                            .ambiguity_margin
                            .unwrap_or(self.config.ambiguity_margin),
                        visual_only_requires_confirmation: policy_target
                            .visual_only_requires_confirmation
                            .unwrap_or(true),
                    },
                }))
            }
            ib_anchor::Decision::NotFound => {
                if self.now >= self.step_deadline {
                    let all_stale = !candidates.is_empty()
                        && candidates
                            .iter()
                            .all(|candidate| candidate.stale == Some(true));
                    let error = if all_stale {
                        err("STALE_TARGET", "all candidates were stale")
                    } else {
                        err(
                            "TARGET_NOT_FOUND",
                            "no candidate satisfied the evidence threshold",
                        )
                    };
                    return self.fail_step(error);
                }
                let wake = self.now + self.backoff(0, self.config.retry_backoff_ms);
                self.pending = Pending::Timer { wake_at: wake };
                self.phase = Phase::Resolve;
                self.set_state(EngineState::WaitingCondition);
                Ok(self.output(Directive::AwaitTimer {
                    step_id: Some(step.id),
                    wake_at_mono_ms: wake,
                    reason: "resolve_retry".into(),
                }))
            }
        }
    }

    fn after_resolution(&mut self) -> Result<StepOutput, BridgeError> {
        let step = self.step()?;
        if self.approval_required(&step)
            && self.approval_granted_for.as_deref() != Some(self.attempt_id.as_str())
        {
            let summary = ApprovalSummary {
                action: step.action.as_str().to_string(),
                risk: self.risk(&step),
                step_name: step.name.clone(),
                target_label: self.target_label(),
                params_preview: preview_params(&step.params.clone().unwrap_or_else(|| json!({}))),
                reasons: self
                    .last_ranking
                    .iter()
                    .find(|item| {
                        self.resolved
                            .as_ref()
                            .map(|resolved| resolved.candidate_id == item.candidate.candidate_id)
                            .unwrap_or(false)
                    })
                    .map(|item| item.reasons.clone())
                    .unwrap_or_default(),
            };
            self.pending = Pending::Approval {
                step_id: step.id.clone(),
                attempt_id: self.attempt_id.clone(),
            };
            self.set_state(EngineState::PausedForApproval);
            self.emit(
                "ApprovalRequested",
                Some(step.id.clone()),
                Some(self.attempt_id.clone()),
                json!({ "risk": summary.risk, "action": summary.action }),
            );
            self.emit(
                "RunPaused",
                Some(step.id.clone()),
                Some(self.attempt_id.clone()),
                json!({ "reason": "approval" }),
            );
            return Ok(self.output(Directive::AwaitApproval {
                step_id: step.id,
                attempt_id: self.attempt_id.clone(),
                summary,
            }));
        }
        self.perform_action()
    }

    fn target_label(&self) -> Option<String> {
        self.resolved.as_ref().and_then(|resolved| {
            self.last_ranking
                .iter()
                .find(|item| item.candidate.candidate_id == resolved.candidate_id)
                .and_then(|item| {
                    item.candidate
                        .semantic
                        .as_ref()
                        .and_then(|semantic| semantic.name.clone())
                        .or_else(|| item.candidate.text.clone())
                })
        })
    }

    fn resolve_value(&self, value: &Value) -> Result<Value, BridgeError> {
        match value {
            Value::String(text) => {
                if secret_ref(text).is_some() {
                    return Ok(value.clone());
                }
                let refs = template_refs(text);
                if refs.is_empty() {
                    return Ok(value.clone());
                }
                let mut output = text.clone();
                for name in refs {
                    let Some(replacement) = self.variables.get(&name) else {
                        return Err(err("INVALID_IR", "template references a missing variable")
                            .with_detail(json!({ "variable": name })));
                    };
                    let replacement = match replacement {
                        Value::String(text) => text.clone(),
                        other => other.to_string(),
                    };
                    output = output.replace(&format!("${{{name}}}"), &replacement);
                }
                Ok(Value::String(output))
            }
            Value::Array(items) => Ok(Value::Array(
                items
                    .iter()
                    .map(|item| self.resolve_value(item))
                    .collect::<Result<Vec<_>, _>>()?,
            )),
            Value::Object(map) => {
                let mut out = Map::new();
                for (key, item) in map {
                    out.insert(key.clone(), self.resolve_value(item)?);
                }
                Ok(Value::Object(out))
            }
            other => Ok(other.clone()),
        }
    }

    fn perform_action(&mut self) -> Result<StepOutput, BridgeError> {
        let step = self.step()?;
        self.attempt += 1;
        self.attempt_id = format!(
            "{}-s{}-a{}",
            self.run_id_short(),
            self.step_index,
            self.attempt
        );
        self.phase = Phase::Action;
        let params = step.params.clone().unwrap_or_else(|| json!({})).clone();
        let resolved_params = self.resolve_value(&params)?;
        let preview = preview_params(&resolved_params);
        let idempotency = self.idempotency_key(&step);
        if step.action.is_mutating() {
            self.attempted_writes += 1;
            self.side_effect_pending = true;
        }
        self.emit(
            "ActionAttempted",
            Some(step.id.clone()),
            Some(self.attempt_id.clone()),
            json!({
                "action": step.action.as_str(),
                "attempt": self.attempt,
                "resolved": self.resolved,
                "manual_override": self.manual_override,
                "params_preview": preview,
                "idempotency_key": idempotency,
                "risk": self.risk(&step),
            }),
        );
        let risk = self.risk(&step);
        let target_json = step
            .target
            .as_ref()
            .map(|target| serde_json::to_value(target).unwrap_or(Value::Null));
        self.pending = Pending::Action {
            step_id: step.id.clone(),
            attempt_id: self.attempt_id.clone(),
        };
        self.set_state(EngineState::Running);
        Ok(self.output(Directive::PerformAction {
            step_id: step.id,
            attempt_id: self.attempt_id.clone(),
            action: step.action.as_str().to_string(),
            params: resolved_params,
            target: target_json,
            risk,
            idempotency_key: idempotency,
            resolved: self.resolved.clone(),
            params_preview: preview,
        }))
    }

    fn on_action_done(
        &mut self,
        step_id: &str,
        attempt_id: &str,
        outcome: &str,
        error: Option<BridgeError>,
        facts: Option<Facts>,
        text: Option<String>,
    ) -> Result<StepOutput, BridgeError> {
        let step = self.step()?;
        if step.id != step_id || self.attempt_id != attempt_id {
            return Err(err(
                "INVALID_STATE",
                "action result does not match the pending action",
            ));
        }
        if let Some(facts) = &facts {
            if !self.scope_matches(facts.app_scope.as_deref()) {
                return Ok(self.pause_for_scope(facts.app_scope.as_deref()));
            }
        }
        match outcome {
            "unknown" => {
                let mut bridge =
                    error.unwrap_or_else(|| err("OUTCOME_UNKNOWN", "action outcome is unknown"));
                bridge.code = "OUTCOME_UNKNOWN".into();
                return self.pause_outcome(bridge, "attempted");
            }
            "failed" => {
                let bridge = error
                    .unwrap_or_else(|| err("INTERNAL_ERROR", "action failed without an error"));
                self.side_effect_pending = false;
                return self.handle_action_failure(bridge);
            }
            "succeeded" => {}
            other => {
                return Err(err("INVALID_STATE", "unknown action outcome")
                    .with_detail(json!({ "outcome": other })));
            }
        }
        if step.action.is_mutating() {
            self.confirmed_writes += 1;
        }
        self.side_effect_pending = false;
        if step.action == Action::ReadText {
            let params = step.params.clone().unwrap_or_else(|| json!({}));
            let name = params
                .get("output_variable")
                .and_then(Value::as_str)
                .ok_or_else(|| err("INVALID_IR", "read-text requires output_variable"))?
                .to_string();
            let sensitive = params
                .get("sensitive")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let value = text
                .or_else(|| facts.and_then(|facts| facts.text))
                .unwrap_or_default();
            let truncated = params
                .get("max_chars")
                .and_then(Value::as_u64)
                .map(|max| value.chars().take(max as usize).collect::<String>())
                .unwrap_or(value);
            self.variables
                .insert(name.clone(), Value::String(truncated));
            if sensitive {
                self.sensitive_variables.insert(name.clone());
            }
            self.emit(
                "VariableSet",
                Some(step.id.clone()),
                Some(attempt_id.to_string()),
                json!({ "name": name, "sensitive": sensitive }),
            );
        }
        if step.postconditions.is_empty() {
            return self.complete_step_success();
        }
        self.phase = Phase::Post;
        self.post_index = 0;
        self.request_condition(Purpose::Post, 0)
    }

    fn handle_action_failure(&mut self, error: BridgeError) -> Result<StepOutput, BridgeError> {
        let step = self.step()?;
        self.last_error = Some(error.clone());
        if self.attempt < self.max_attempts(&step) && self.retryable_failure(&step, &error) {
            self.emit(
                "Diagnostic",
                Some(step.id.clone()),
                Some(self.attempt_id.clone()),
                json!({ "reason": "retry", "attempt": self.attempt, "error": error }),
            );
            let wake = self.now + self.backoff(self.attempt, self.config.retry_backoff_ms);
            self.phase = Phase::Resolve;
            self.pending = Pending::Timer { wake_at: wake };
            self.set_state(EngineState::WaitingCondition);
            return Ok(self.output(Directive::AwaitTimer {
                step_id: Some(step.id),
                wake_at_mono_ms: wake,
                reason: "action_retry".into(),
            }));
        }
        self.fail_step(error)
    }

    fn pause_outcome(
        &mut self,
        error: BridgeError,
        last_known: &str,
    ) -> Result<StepOutput, BridgeError> {
        let step = self.step()?;
        self.emit(
            "RunPaused",
            Some(step.id.clone()),
            Some(self.attempt_id.clone()),
            json!({ "reason": "outcome_unknown" }),
        );
        self.set_state(EngineState::PausedForOutcome);
        self.pending = Pending::Outcome {
            step_id: step.id.clone(),
            attempt_id: self.attempt_id.clone(),
        };
        Ok(self.output(Directive::AwaitOutcomeDecision {
            step_id: step.id,
            attempt_id: self.attempt_id.clone(),
            error,
            last_known_state: last_known.to_string(),
        }))
    }

    fn on_observation(
        &mut self,
        condition_id: &str,
        facts: Facts,
    ) -> Result<StepOutput, BridgeError> {
        let step = self.step()?;
        let (pending_step, pending_condition, purpose, deadline, round) = match &self.pending {
            Pending::Condition {
                step_id,
                condition_id,
                purpose,
                deadline,
                round,
            } => (
                step_id.clone(),
                condition_id.clone(),
                *purpose,
                *deadline,
                *round,
            ),
            _ => return Err(err("INVALID_STATE", "no condition is pending")),
        };
        if pending_step != step.id || pending_condition != condition_id {
            return Err(err(
                "INVALID_STATE",
                "observation does not match the pending condition",
            ));
        }
        if !self.scope_matches(facts.app_scope.as_deref()) {
            return Ok(self.pause_for_scope(facts.app_scope.as_deref()));
        }
        let condition = self.condition_at(
            purpose,
            if purpose == Purpose::Post {
                self.post_index
            } else {
                self.pre_index
            },
        )?;
        let expected_scope = self
            .flow
            .as_ref()
            .map(|flow| flow.app_scope.value.clone())
            .unwrap_or_default();
        let anchor = self.config.anchor();
        let outcome = evaluate(
            &condition,
            &EvalContext {
                facts: &facts,
                variables: &self.variables,
                anchor: &anchor,
                scope: Some(&expected_scope),
            },
        );
        self.emit(
            "ObservationRecorded",
            Some(step.id.clone()),
            Some(self.attempt_id.clone()).filter(|id| !id.is_empty()),
            json!({
                "condition_id": condition_id,
                "kind": condition.kind(),
                "purpose": purpose.as_str(),
                "satisfied": outcome.satisfied,
                "detail": outcome.detail,
                "round": round,
            }),
        );
        if purpose == Purpose::Branch {
            return self.branch_decision(outcome.satisfied);
        }
        if outcome.satisfied {
            self.set_state(EngineState::Running);
            match purpose {
                Purpose::Pre => {
                    self.pre_index += 1;
                    let total = step.preconditions.len();
                    if self.pre_index < total {
                        return self.request_condition(Purpose::Pre, self.pre_index);
                    }
                    self.after_preconditions()
                }
                Purpose::Post => {
                    self.post_index += 1;
                    let total = step.postconditions.len();
                    if self.post_index < total {
                        return self.request_condition(Purpose::Post, self.post_index);
                    }
                    self.complete_step_success()
                }
                Purpose::Wait | Purpose::Assert | Purpose::ScrollBoundary => {
                    self.complete_step_success()
                }
                Purpose::Branch => self.branch_decision(true),
            }
        } else if self.now >= deadline {
            self.condition_timeout(purpose, round)
        } else {
            let poll = self.backoff(round, 50.0);
            self.pending = Pending::Condition {
                step_id: step.id.clone(),
                condition_id: condition_id.to_string(),
                purpose,
                deadline,
                round: round + 1,
            };
            Ok(self.output(Directive::AwaitCondition {
                step_id: step.id,
                attempt_id: self.attempt_id.clone(),
                condition_id: condition_id.to_string(),
                condition: serde_json::to_value(&condition).unwrap_or(Value::Null),
                purpose: purpose.as_str().to_string(),
                deadline_mono_ms: deadline,
                poll_after_ms: poll,
            }))
        }
    }

    fn condition_timeout(
        &mut self,
        purpose: Purpose,
        _round: u32,
    ) -> Result<StepOutput, BridgeError> {
        match purpose {
            Purpose::Pre => self.fail_step(err(
                "PRECONDITION_FAILED",
                "precondition did not hold before timeout",
            )),
            Purpose::Wait => self.fail_step(err("TIMEOUT", "wait condition timed out")),
            Purpose::Assert => self
                .fail_step(err("POSTCONDITION_FAILED", "assertion did not hold").retryable(true)),
            Purpose::Post => self.postcondition_failed("postcondition_timeout"),
            Purpose::ScrollBoundary => {
                self.fail_step(err("TIMEOUT", "scroll boundary condition timed out"))
            }
            Purpose::Branch => self.branch_decision(false),
        }
    }

    fn postcondition_failed(&mut self, last_known: &str) -> Result<StepOutput, BridgeError> {
        let step = self.step()?;
        if step.action.is_mutating() {
            return self.pause_outcome(
                err(
                    "POSTCONDITION_FAILED",
                    "action completed but its postcondition did not hold",
                ),
                last_known,
            );
        }
        if self.attempt < self.max_attempts(&step) {
            let wake = self.now + self.backoff(self.attempt, self.config.retry_backoff_ms);
            self.phase = Phase::Resolve;
            self.pending = Pending::Timer { wake_at: wake };
            self.set_state(EngineState::WaitingCondition);
            return Ok(self.output(Directive::AwaitTimer {
                step_id: Some(step.id),
                wake_at_mono_ms: wake,
                reason: "postcondition_retry".into(),
            }));
        }
        self.fail_step(err(
            "POSTCONDITION_FAILED",
            "postcondition did not hold after read-only action",
        ))
    }

    fn branch_decision(&mut self, matched: bool) -> Result<StepOutput, BridgeError> {
        let step = self.step()?;
        let params = step.params.clone().unwrap_or_else(|| json!({}));
        let next_id = if matched {
            params.get("goto_step_id").and_then(Value::as_str)
        } else {
            params.get("else_step_id").and_then(Value::as_str)
        };
        match next_id {
            Some(id) => self.jump_to_step(id),
            None => {
                let next = self.step_index + 1;
                self.begin_step(next)
            }
        }
    }

    fn jump_to_step(&mut self, step_id: &str) -> Result<StepOutput, BridgeError> {
        let flow = self.flow()?;
        let index = flow
            .steps
            .iter()
            .position(|step| step.id == step_id)
            .ok_or_else(|| {
                err("INVALID_IR", "jump target does not exist")
                    .with_detail(json!({ "step_id": step_id }))
            })?;
        self.branch_jumps += 1;
        if self.branch_jumps > self.config.max_branch_jumps as u64 {
            return self.finish_failed(
                err("RUNTIME_LIMIT_EXCEEDED", "max branch jumps exceeded").retryable(false),
            );
        }
        self.begin_step(index)
    }

    fn complete_step_success(&mut self) -> Result<StepOutput, BridgeError> {
        let step = self.step()?;
        self.emit(
            "StepSucceeded",
            Some(step.id.clone()),
            Some(self.attempt_id.clone()).filter(|id| !id.is_empty()),
            json!({
                "action": step.action.as_str(),
                "resolved": self.resolved,
                "manual_override": self.manual_override,
            }),
        );
        self.phase = Phase::Complete;
        if self.single_step {
            self.single_step = false;
            self.emit(
                "RunPaused",
                Some(step.id.clone()),
                Some(self.attempt_id.clone()).filter(|id: &String| !id.is_empty()),
                json!({ "reason": "single_step" }),
            );
            self.set_state(EngineState::PausedForRecovery);
            self.pending = Pending::Recovery {
                reason: "single_step".into(),
                options: vec!["resume".into(), "stop".into()],
            };
            self.recovery_reason = Some("single_step".into());
            self.recovery_step = Some(self.step_index + 1);
            return Ok(self.output(Directive::AwaitRecovery {
                step_id: Some(step.id),
                reason: "single_step".into(),
                options: vec!["resume".into(), "stop".into()],
                error: None,
            }));
        }
        if let Some(compensation) = self.compensation.take() {
            self.emit(
                "CompensationRecorded",
                Some(compensation.source_step.clone()),
                None,
                json!({ "compensation_step": step.id, "best_effort": true }),
            );
            if let Some(error) = compensation.finish_error {
                return self.finish_failed(error);
            }
            if let Some(resume) = compensation.resume_index {
                return self.begin_step(resume);
            }
            return self.finish_succeeded();
        }
        let next = self.step_index + 1;
        self.begin_step(next)
    }

    fn jump_to_compensation(
        &mut self,
        step_id: &str,
        finish_error: Option<BridgeError>,
    ) -> Result<StepOutput, BridgeError> {
        if self.compensation.is_some() {
            return Err(err("UNSAFE_FLOW", "nested compensation is not supported"));
        }
        let flow = self.flow()?;
        let index = flow
            .steps
            .iter()
            .position(|step| step.id == step_id)
            .ok_or_else(|| err("INVALID_IR", "compensation step does not exist"))?;
        let source = self.step()?.id;
        self.compensation = Some(CompensationContext {
            resume_index: if finish_error.is_some() {
                None
            } else {
                Some(self.step_index + 1)
            },
            finish_error,
            source_step: source,
        });
        self.begin_step(index)
    }

    fn fail_step(&mut self, error: BridgeError) -> Result<StepOutput, BridgeError> {
        let step = self.step()?;
        self.last_error = Some(error.clone());
        self.emit(
            "StepFailed",
            Some(step.id.clone()),
            Some(self.attempt_id.clone()).filter(|id| !id.is_empty()),
            json!({ "error": error, "attempt": self.attempt }),
        );
        match step
            .on_failure
            .as_ref()
            .map(|value| value.mode().to_string())
        {
            Some(mode) if mode == "ask-user" => {
                let mut options = vec!["skip".to_string(), "stop".to_string()];
                if self.attempt < self.max_attempts(&step) || step.action.is_read_only() {
                    options.insert(0, "retry".to_string());
                }
                if step.compensation_step_id.is_some() {
                    options.push("compensate".to_string());
                }
                self.emit(
                    "RunPaused",
                    Some(step.id.clone()),
                    None,
                    json!({ "reason": "step_failed" }),
                );
                self.set_state(EngineState::PausedForRecovery);
                self.pending = Pending::Recovery {
                    reason: "step_failed".into(),
                    options: options.clone(),
                };
                self.recovery_step = Some(self.step_index);
                Ok(self.output(Directive::AwaitRecovery {
                    step_id: Some(step.id),
                    reason: "step_failed".into(),
                    options,
                    error: Some(error),
                }))
            }
            Some(mode) if mode == "goto-step" => {
                if let Some(target) = step.on_failure.as_ref().and_then(|value| value.goto()) {
                    self.jump_to_step(target)
                } else {
                    self.finish_failed(error)
                }
            }
            _ => self.finish_failed(error),
        }
    }

    fn finish_succeeded(&mut self) -> Result<StepOutput, BridgeError> {
        self.set_state(EngineState::Succeeded);
        self.emit("RunFinished", None, None, json!({ "status": "succeeded" }));
        self.pending = Pending::Finished;
        self.finished_output = true;
        Ok(self.output(Directive::Finished {
            status: "succeeded".into(),
            error: None,
        }))
    }

    fn finish_failed(&mut self, error: BridgeError) -> Result<StepOutput, BridgeError> {
        self.set_state(EngineState::Failed);
        self.emit(
            "RunFinished",
            None,
            None,
            json!({ "status": "failed", "error": error }),
        );
        self.pending = Pending::Finished;
        self.finished_output = true;
        Ok(self.output(Directive::Finished {
            status: "failed".into(),
            error: Some(error),
        }))
    }

    fn finish_cancelled(&mut self, reason: &str) -> Result<StepOutput, BridgeError> {
        self.set_state(EngineState::Cancelled);
        self.emit(
            "RunCancelled",
            None,
            None,
            json!({
                "reason": reason,
                "attempted_writes": self.attempted_writes,
                "confirmed_writes": self.confirmed_writes,
                "may_have_side_effects": self.side_effect_pending,
            }),
        );
        self.emit(
            "RunFinished",
            None,
            None,
            json!({ "status": "cancelled", "may_have_side_effects": self.side_effect_pending }),
        );
        self.pending = Pending::Finished;
        self.finished_output = true;
        Ok(self.output(Directive::Finished {
            status: "cancelled".into(),
            error: None,
        }))
    }

    /// Entry point for host responses. Every input is validated against the
    /// pending directive before it can change state.
    pub fn submit(&mut self, input: EngineInput) -> Result<StepOutput, BridgeError> {
        let now = match &input {
            EngineInput::Candidates { now_mono_ms, .. }
            | EngineInput::ActionDone { now_mono_ms, .. }
            | EngineInput::Observation { now_mono_ms, .. }
            | EngineInput::Approval { now_mono_ms, .. }
            | EngineInput::Disambiguation { now_mono_ms, .. }
            | EngineInput::OutcomeDecision { now_mono_ms, .. }
            | EngineInput::Pause { now_mono_ms }
            | EngineInput::RecoveryDecision { now_mono_ms, .. }
            | EngineInput::Cancel { now_mono_ms, .. }
            | EngineInput::Tick { now_mono_ms } => *now_mono_ms,
        };
        self.now_from(now)?;
        match input {
            EngineInput::Candidates {
                step_id,
                attempt_id,
                candidates,
                facts,
                ..
            } => {
                if !matches!(self.pending, Pending::Resolve { .. }) {
                    return Err(err("INVALID_STATE", "candidates are not pending"));
                }
                self.on_candidates(&step_id, &attempt_id, candidates, facts)
            }
            EngineInput::ActionDone {
                step_id,
                attempt_id,
                outcome,
                error,
                facts,
                text,
                ..
            } => {
                if !matches!(self.pending, Pending::Action { .. }) {
                    return Err(err("INVALID_STATE", "no action is pending"));
                }
                self.on_action_done(&step_id, &attempt_id, &outcome, error, facts, text)
            }
            EngineInput::Observation {
                step_id,
                condition_id,
                facts,
                ..
            } => {
                let step = self.step()?;
                if step.id != step_id {
                    return Err(err("INVALID_STATE", "observation step mismatch"));
                }
                self.on_observation(&condition_id, facts)
            }
            EngineInput::Approval {
                step_id,
                attempt_id,
                approved,
                approval_id,
                ..
            } => {
                if let Pending::Approval {
                    step_id: pending_step,
                    attempt_id: pending_attempt,
                } = &self.pending
                {
                    if *pending_step != step_id || *pending_attempt != attempt_id {
                        return Err(err(
                            "INVALID_STATE",
                            "approval does not match the pending request",
                        ));
                    }
                } else {
                    return Err(err("INVALID_STATE", "no approval is pending"));
                }
                if approved {
                    let step = self.step()?;
                    self.approval_granted_for = Some(attempt_id.clone());
                    self.set_state(EngineState::Running);
                    self.emit(
                        "ApprovalRequested",
                        Some(step.id.clone()),
                        Some(attempt_id.clone()),
                        json!({ "risk": self.risk(&step), "approved": true, "approval_id": approval_id }),
                    );
                    self.perform_action()
                } else {
                    self.set_state(EngineState::Running);
                    self.fail_step(err("APPROVAL_REQUIRED", "approval was denied"))
                }
            }
            EngineInput::Disambiguation {
                step_id,
                attempt_id,
                candidate_id,
                ..
            } => {
                let ids = match &self.pending {
                    Pending::Disambiguation {
                        step_id: pending_step,
                        attempt_id: pending_attempt,
                        ids,
                    } => {
                        if *pending_step != step_id || *pending_attempt != attempt_id {
                            return Err(err(
                                "INVALID_STATE",
                                "disambiguation does not match the pending request",
                            ));
                        }
                        ids.clone()
                    }
                    _ => return Err(err("INVALID_STATE", "no disambiguation is pending")),
                };
                if !ids.contains(&candidate_id) {
                    return Err(err(
                        "TARGET_AMBIGUOUS",
                        "selected candidate is not eligible",
                    ));
                }
                let chosen = self
                    .last_ranking
                    .iter()
                    .find(|item| item.candidate.candidate_id == candidate_id)
                    .cloned()
                    .ok_or_else(|| err("TARGET_AMBIGUOUS", "selected candidate is unknown"))?;
                self.resolved = Some(ResolvedTarget {
                    candidate_id,
                    score: chosen.total,
                    evidence: chosen.evidence,
                });
                self.manual_override = true;
                self.set_state(EngineState::Running);
                self.emit(
                    "Diagnostic",
                    Some(step_id.clone()),
                    Some(attempt_id.clone()),
                    json!({
                        "reason": "anchor_override",
                        "candidate_id": chosen.candidate.candidate_id,
                        "score": chosen.total,
                        "evidence": chosen.evidence,
                    }),
                );
                self.after_resolution()
            }
            EngineInput::OutcomeDecision {
                step_id,
                attempt_id,
                decision,
                ..
            } => {
                match &self.pending {
                    Pending::Outcome {
                        step_id: pending_step,
                        attempt_id: pending_attempt,
                    } => {
                        if *pending_step != step_id || *pending_attempt != attempt_id {
                            return Err(err("INVALID_STATE", "outcome decision does not match"));
                        }
                    }
                    _ => return Err(err("INVALID_STATE", "no outcome decision is pending")),
                }
                self.set_state(EngineState::Running);
                match decision.as_str() {
                    "succeeded" => {
                        self.emit(
                            "Diagnostic",
                            Some(step_id.clone()),
                            Some(attempt_id.clone()),
                            json!({ "reason": "outcome_confirmed_succeeded" }),
                        );
                        self.complete_step_success()
                    }
                    "failed" => {
                        self.emit(
                            "Diagnostic",
                            Some(step_id.clone()),
                            Some(attempt_id.clone()),
                            json!({ "reason": "outcome_confirmed_failed" }),
                        );
                        self.fail_step(
                            err(
                                "POSTCONDITION_FAILED",
                                "side effect reported as failed by the user",
                            )
                            .retryable(false),
                        )
                    }
                    "retry" => {
                        let step = self.step()?;
                        self.emit(
                            "Diagnostic",
                            Some(step_id.clone()),
                            Some(attempt_id.clone()),
                            json!({ "reason": "manual_retry", "idempotency_key": self.idempotency_key(&step) }),
                        );
                        self.attempt = self.attempt.saturating_sub(1);
                        if step.target.is_some() {
                            self.begin_resolve()
                        } else {
                            self.perform_action()
                        }
                    }
                    other => Err(err("INVALID_STATE", "unknown outcome decision")
                        .with_detail(json!({ "decision": other }))),
                }
            }
            EngineInput::Pause { .. } => {
                if self.state.is_terminal() {
                    return Err(err("INVALID_STATE", "run already finished"));
                }
                if matches!(self.pending, Pending::Recovery { .. }) {
                    return Err(err("INVALID_STATE", "run is already paused"));
                }
                let step_id = self.step().ok().map(|step| step.id);
                self.emit(
                    "RunPaused",
                    step_id.clone(),
                    None,
                    json!({ "reason": "user_pause" }),
                );
                self.set_state(EngineState::PausedForRecovery);
                self.resume_directive = self.last_directive.clone();
                self.pause_resume_pending = Some(self.pending.clone());
                self.pending = Pending::Recovery {
                    reason: "user_pause".into(),
                    options: vec!["resume".into(), "stop".into()],
                };
                Ok(self.output(Directive::AwaitRecovery {
                    step_id,
                    reason: "user_pause".into(),
                    options: vec!["resume".into(), "stop".into()],
                    error: None,
                }))
            }
            EngineInput::RecoveryDecision { decision, .. } => {
                let (reason, options) = match &self.pending {
                    Pending::Recovery { reason, options } => (reason.clone(), options.clone()),
                    _ => return Err(err("INVALID_STATE", "no recovery decision is pending")),
                };
                if !options.contains(&decision) {
                    return Err(err("INVALID_STATE", "recovery option is not offered")
                        .with_detail(json!({ "options": options, "decision": decision })));
                }
                match decision.as_str() {
                    "resume" if reason == "single_step" => {
                        let index = self.recovery_step.unwrap_or(self.step_index + 1);
                        self.set_state(EngineState::Running);
                        self.begin_step(index)
                    }
                    "resume" => {
                        let directive = self
                            .resume_directive
                            .take()
                            .ok_or_else(|| err("INVALID_STATE", "nothing to resume"))?;
                        if let Some(pending) = self.pause_resume_pending.take() {
                            self.pending = pending;
                        }
                        self.set_state(state_for_directive(&directive));
                        Ok(self.output(directive))
                    }
                    "retry" => {
                        let index = self.recovery_step.unwrap_or(self.step_index);
                        self.attempt = 0;
                        self.set_state(EngineState::Running);
                        self.begin_step(index)
                    }
                    "skip" => {
                        let index = self.step_index + 1;
                        self.set_state(EngineState::Running);
                        self.begin_step(index)
                    }
                    "compensate" => {
                        let step = self.step()?;
                        let target = step
                            .compensation_step_id
                            .clone()
                            .ok_or_else(|| err("INVALID_STATE", "step has no compensation step"))?;
                        let error = self.last_error.clone().unwrap_or_else(|| {
                            err("POSTCONDITION_FAILED", "step failed before compensation")
                        });
                        self.set_state(EngineState::Running);
                        self.jump_to_compensation(&target, Some(error))
                    }
                    "stop" => {
                        let error = self
                            .last_error
                            .clone()
                            .unwrap_or_else(|| err("USER_CANCELLED", "user stopped after pause"));
                        if reason == "user_pause"
                            || reason == "app_scope_violation"
                            || reason == "single_step"
                        {
                            self.finish_cancelled(&reason)
                        } else {
                            self.finish_failed(error)
                        }
                    }
                    other => Err(err("INVALID_STATE", "unknown recovery decision")
                        .with_detail(json!({ "decision": other }))),
                }
            }
            EngineInput::Tick { .. } => self.on_tick(),
            EngineInput::Cancel { reason, .. } => {
                if self.state.is_terminal() {
                    return Err(err("INVALID_STATE", "run already finished"));
                }
                let reason = reason.unwrap_or_else(|| "user_cancelled".into());
                self.finish_cancelled(&reason)
            }
        }
    }

    fn on_tick(&mut self) -> Result<StepOutput, BridgeError> {
        match self.pending.clone() {
            Pending::Timer { wake_at } => {
                if self.now + 1e-6 >= wake_at {
                    self.begin_resolve()
                } else {
                    let step_id = self.step().ok().map(|step| step.id);
                    Ok(self.output(Directive::AwaitTimer {
                        step_id,
                        wake_at_mono_ms: wake_at,
                        reason: "wait".into(),
                    }))
                }
            }
            Pending::Condition {
                step_id,
                condition_id,
                purpose,
                deadline,
                round,
            } => {
                if self.now + 1e-6 >= deadline {
                    self.condition_timeout(purpose, round)
                } else {
                    let condition = self.condition_at(
                        purpose,
                        if purpose == Purpose::Post {
                            self.post_index
                        } else {
                            self.pre_index
                        },
                    )?;
                    Ok(self.output(Directive::AwaitCondition {
                        step_id,
                        attempt_id: self.attempt_id.clone(),
                        condition_id,
                        condition: serde_json::to_value(&condition).unwrap_or(Value::Null),
                        purpose: purpose.as_str().to_string(),
                        deadline_mono_ms: deadline,
                        poll_after_ms: self.backoff(round, 50.0),
                    }))
                }
            }
            _ => Err(err(
                "INVALID_STATE",
                "tick is not valid in the current state",
            )),
        }
    }

    pub fn snapshot(&self) -> Value {
        json!({
            "state": self.state.as_str(),
            "run_id": self.run_id,
            "seq": self.seq,
            "step_index": self.step_index,
            "steps_executed": self.steps_executed,
            "attempt": self.attempt,
            "attempt_id": self.attempt_id,
            "variables": self.variables.iter().map(|(name, value)| {
                if self.sensitive_variables.contains(name) {
                    (name.clone(), json!("«redacted»"))
                } else {
                    (name.clone(), value.clone())
                }
            }).collect::<Map<String, Value>>(),
            "sensitive_variables": self.sensitive_variables,
            "events": self.events,
        })
    }

    pub fn recover(events: &[RunEvent]) -> Result<RecoveredRun, Vec<String>> {
        let mut errors = Vec::new();
        if events.is_empty() {
            return Err(vec!["event log is empty".into()]);
        }
        let run_id = events[0].run_id.clone();
        errors.extend(validate_event_sequence(events, &run_id));
        if !errors.is_empty() {
            return Err(errors);
        }
        let mut state = EngineState::Running;
        let mut terminated = false;
        let mut last_step_id: Option<String> = None;
        let mut may_have_side_effects = false;
        let mut final_state: Option<EngineState> = None;
        for event in events {
            if let Some(step_id) = &event.step_id {
                last_step_id = Some(step_id.clone());
            }
            match event.event_type.as_str() {
                "StateChanged" => {
                    if let Some(to) = event.payload.get("to").and_then(Value::as_str) {
                        state = match to {
                            "DRAFT" => EngineState::Draft,
                            "VALIDATED" => EngineState::Validated,
                            "ARMED" => EngineState::Armed,
                            "RUNNING" => EngineState::Running,
                            "WAITING_CONDITION" => EngineState::WaitingCondition,
                            "PAUSED_FOR_APPROVAL" => EngineState::PausedForApproval,
                            "PAUSED_FOR_DISAMBIGUATION" => EngineState::PausedForDisambiguation,
                            "PAUSED_FOR_OUTCOME" => EngineState::PausedForOutcome,
                            "PAUSED_FOR_RECOVERY" => EngineState::PausedForRecovery,
                            "SUCCEEDED" => EngineState::Succeeded,
                            "FAILED" => EngineState::Failed,
                            "CANCELLED" => EngineState::Cancelled,
                            "OUTCOME_UNKNOWN" => EngineState::OutcomeUnknown,
                            _ => state,
                        };
                    }
                }
                "ActionAttempted" => {
                    may_have_side_effects = true;
                }
                "StepSucceeded" => {
                    if event
                        .payload
                        .get("action")
                        .and_then(Value::as_str)
                        .map(|action| {
                            matches!(action, "click" | "input" | "select" | "scroll" | "launch")
                        })
                        .unwrap_or(false)
                    {
                        may_have_side_effects = false;
                    }
                }
                "RunFinished" => {
                    terminated = true;
                    final_state = Some(match event.payload.get("status").and_then(Value::as_str) {
                        Some("succeeded") => EngineState::Succeeded,
                        Some("failed") => EngineState::Failed,
                        Some("cancelled") => EngineState::Cancelled,
                        _ => EngineState::OutcomeUnknown,
                    });
                }
                _ => {}
            }
        }
        let resulting_state = final_state.unwrap_or(if terminated {
            state
        } else {
            EngineState::OutcomeUnknown
        });
        Ok(RecoveredRun {
            run_id,
            state: resulting_state,
            last_event_seq: events.last().map(|event| event.seq).unwrap_or(0),
            last_step_id,
            terminated,
            may_have_side_effects,
            errors,
        })
    }

    pub fn reset_run(&mut self) {
        self.run_id.clear();
        self.seq = 0;
        self.events.clear();
        self.pending_events.clear();
        self.state = EngineState::Armed;
        self.finished_output = false;
        self.pending = Pending::Idle;
        self.last_directive = None;
        self.resume_directive = None;
        self.pause_resume_pending = None;
        self.attempted_writes = 0;
        self.confirmed_writes = 0;
        self.side_effect_pending = false;
    }
}

impl Default for Engine {
    fn default() -> Self {
        Self::new()
    }
}

fn state_for_directive(directive: &Directive) -> EngineState {
    match directive {
        Directive::ResolveTarget { .. } | Directive::PerformAction { .. } => EngineState::Running,
        Directive::AwaitCondition { .. } | Directive::AwaitTimer { .. } => {
            EngineState::WaitingCondition
        }
        Directive::AwaitApproval { .. } => EngineState::PausedForApproval,
        Directive::AwaitDisambiguation { .. } => EngineState::PausedForDisambiguation,
        Directive::AwaitOutcomeDecision { .. } => EngineState::PausedForOutcome,
        Directive::AwaitRecovery { .. } => EngineState::PausedForRecovery,
        Directive::Finished { .. } => EngineState::OutcomeUnknown,
    }
}
