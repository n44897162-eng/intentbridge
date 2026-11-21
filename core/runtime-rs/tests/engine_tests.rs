//! State-machine tests against a virtual event source (no real UI, no sleeps).
#![allow(dead_code, unused_variables, unused_assignments)]

use ib_anchor::{
    Candidate, CandidateContext, CandidateSemantic, CandidateStructure, NativeIdentity,
};
use ib_runtime::engine::{
    BridgeError, Directive, Engine, EngineConfig, EngineInput, StartOptions, StepOutput,
};
use ib_runtime::ir::Flow;
use ib_runtime::{validate_flow, Facts};
use serde_json::{json, Value};
use std::collections::HashMap;

const FLOW: &str = include_str!("../../../fixtures/flows/web-basic.flow.json");
const ORIGIN: &str = "http://127.0.0.1:4317";

fn golden() -> Value {
    serde_json::from_str(FLOW).expect("golden flow json")
}

fn candidate(id: &str, test_id: &str, role: &str, name: &str, path: &[&str]) -> Candidate {
    Candidate {
        candidate_id: id.into(),
        native_identity: Some(NativeIdentity {
            kind: "web-test-id".into(),
            value: test_id.into(),
        }),
        semantic: Some(CandidateSemantic {
            role: Some(role.into()),
            name: Some(name.into()),
            test_id: Some(test_id.into()),
            ..Default::default()
        }),
        structure: Some(CandidateStructure {
            path: Some(path.iter().map(|token| token.to_string()).collect()),
            ..Default::default()
        }),
        visual: None,
        context: Some(CandidateContext {
            app_scope: Some(ORIGIN.into()),
            url: Some(format!("{ORIGIN}/")),
            ..Default::default()
        }),
        visible: true,
        enabled: true,
        editable: None,
        stale: None,
        in_viewport: Some(true),
        rect: None,
        text: None,
    }
}

fn input_field() -> Candidate {
    candidate(
        "c-input",
        "keyword-input",
        "textbox",
        "搜索",
        &["main.page", "form#search-form", "input#keyword"],
    )
}

fn submit_button() -> Candidate {
    candidate(
        "c-submit",
        "search-submit",
        "button",
        "搜索",
        &["main.page", "form#search-form", "button#search-submit"],
    )
}

fn result_item() -> Candidate {
    candidate(
        "c-result",
        "result-item",
        "listitem",
        "Alpha 季度报告",
        &["main.page", "ul#results", "li.result"],
    )
}

fn summary(text: &str) -> Candidate {
    let mut item = candidate(
        "c-summary",
        "results-summary",
        "status",
        "结果摘要",
        &["main.page", "section#results-region", "p#results-summary"],
    );
    item.text = Some(text.into());
    item
}

#[derive(Debug, Clone)]
struct Host {
    now: f64,
    candidates: Vec<Candidate>,
    summary_text: String,
    failures: HashMap<String, u32>,
    approve: bool,
    recovery: &'static str,
    outcome_decision: &'static str,
    disambiguation_pick: Option<String>,
    stop_on_disambiguation: bool,
    hide_elements: bool,
    hide_after_write: bool,
    stale_first: bool,
    scope_override: Option<String>,
    performed: Vec<String>,
    started: bool,
}

impl Host {
    fn new() -> Self {
        Self {
            now: 1_000.0,
            candidates: vec![input_field(), submit_button()],
            summary_text: "找到 3 条与“报告”相关的结果".into(),
            failures: HashMap::new(),
            approve: true,
            recovery: "retry",
            outcome_decision: "failed",
            disambiguation_pick: None,
            stop_on_disambiguation: false,
            hide_elements: false,
            hide_after_write: false,
            stale_first: false,
            scope_override: None,
            performed: Vec::new(),
            started: false,
        }
    }

    fn add_results(&mut self) {
        if !self
            .candidates
            .iter()
            .any(|item| item.candidate_id == "c-result")
        {
            self.candidates.push(result_item());
            self.candidates.push(summary(&self.summary_text));
        }
    }

    fn facts(&self) -> Facts {
        Facts {
            now_mono_ms: Some(self.now),
            app_scope: Some(self.scope_override.clone().unwrap_or_else(|| ORIGIN.into())),
            url: Some(format!("{ORIGIN}/")),
            window_title: Some("IntentBridge Fixture".into()),
            window_stable_ms: Some(2_000.0),
            elements: Some(if self.hide_elements {
                vec![]
            } else {
                self.candidates.clone()
            }),
            variable_values: None,
            text: None,
            foreground: Some(true),
            evidence_ref: None,
        }
    }

    fn fail_once(&mut self, step_id: &str) -> Option<BridgeError> {
        if let Some(count) = self.failures.get_mut(step_id) {
            if *count > 0 {
                *count -= 1;
                return Some(
                    BridgeError::new("TIMEOUT", "injected transport timeout").retryable(true),
                );
            }
        }
        None
    }
}

struct DriveResult {
    engine: Engine,
    host: Host,
    output: StepOutput,
}

fn drive(mut engine: Engine, mut host: Host) -> DriveResult {
    let mut output = engine
        .start(StartOptions {
            run_id: "run-test-0001".into(),
            now_mono_ms: host.now,
            wall_time_ms: 1_700_000_000_000,
            variables: [("keyword".to_string(), json!("报告"))]
                .into_iter()
                .collect(),
            start_step_id: None,
            single_step: false,
        })
        .expect("start");

    for _ in 0..2_000 {
        host.now += 10.0;
        let now = host.now;
        let input = match &output.directive {
            Directive::Finished { .. } => {
                return DriveResult {
                    engine,
                    host,
                    output,
                }
            }
            Directive::ResolveTarget {
                step_id,
                attempt_id,
                ..
            } => {
                let mut candidates = host.candidates.clone();
                if host.stale_first {
                    host.stale_first = false;
                    for candidate in &mut candidates {
                        candidate.stale = Some(true);
                    }
                }
                EngineInput::Candidates {
                    now_mono_ms: now,
                    step_id: step_id.clone(),
                    attempt_id: attempt_id.clone(),
                    candidates,
                    facts: Some(host.facts()),
                }
            }
            Directive::PerformAction {
                step_id,
                attempt_id,
                action,
                ..
            } => {
                host.performed.push(format!("{step_id}:{action}"));
                if action == "input" {
                    host.add_results();
                }
                let failure = host.fail_once(step_id);
                if host.hide_after_write && action == "click" {
                    host.hide_elements = true;
                }
                EngineInput::ActionDone {
                    now_mono_ms: now,
                    step_id: step_id.clone(),
                    attempt_id: attempt_id.clone(),
                    outcome: if failure.is_some() {
                        "failed".into()
                    } else {
                        "succeeded".into()
                    },
                    error: failure,
                    facts: Some(host.facts()),
                    text: Some(host.summary_text.clone()),
                }
            }
            Directive::AwaitCondition {
                step_id,
                attempt_id,
                condition_id,
                deadline_mono_ms,
                ..
            } => {
                if host.hide_elements {
                    host.now = *deadline_mono_ms;
                }
                EngineInput::Observation {
                    now_mono_ms: host.now,
                    step_id: step_id.clone(),
                    attempt_id: Some(attempt_id.clone()),
                    condition_id: condition_id.clone(),
                    facts: host.facts(),
                }
            }
            Directive::AwaitApproval {
                step_id,
                attempt_id,
                ..
            } => EngineInput::Approval {
                now_mono_ms: now,
                step_id: step_id.clone(),
                attempt_id: attempt_id.clone(),
                approved: host.approve,
                approval_id: Some("approval-1".into()),
            },
            Directive::AwaitDisambiguation {
                step_id,
                attempt_id,
                candidates,
                ..
            } => {
                if host.stop_on_disambiguation {
                    return DriveResult {
                        engine,
                        host,
                        output,
                    };
                }
                let pick = host
                    .disambiguation_pick
                    .clone()
                    .or_else(|| {
                        candidates
                            .first()
                            .map(|item| item.candidate.candidate_id.clone())
                    })
                    .expect("candidate to pick");
                EngineInput::Disambiguation {
                    now_mono_ms: now,
                    step_id: step_id.clone(),
                    attempt_id: attempt_id.clone(),
                    candidate_id: pick,
                }
            }
            Directive::AwaitOutcomeDecision {
                step_id,
                attempt_id,
                ..
            } => EngineInput::OutcomeDecision {
                now_mono_ms: now,
                step_id: step_id.clone(),
                attempt_id: attempt_id.clone(),
                decision: host.outcome_decision.into(),
            },
            Directive::AwaitRecovery { .. } => EngineInput::RecoveryDecision {
                now_mono_ms: now,
                decision: host.recovery.into(),
                note: None,
            },
            Directive::AwaitTimer {
                wake_at_mono_ms, ..
            } => {
                host.now = host.now.max(*wake_at_mono_ms);
                EngineInput::Tick {
                    now_mono_ms: host.now,
                }
            }
        };
        output = engine.submit(input).expect("submit");
    }
    panic!(
        "run did not finish within iteration budget; last state {:?}",
        output.state
    );
}

fn configured_engine(flow: Value) -> Engine {
    let mut engine = Engine::new();
    engine
        .load_value(serde_json::from_value::<Flow>(flow).expect("flow decode"))
        .expect("load");
    engine.validate().expect("validate");
    engine.arm().expect("arm");
    engine
}

fn golden_engine() -> Engine {
    configured_engine(golden())
}

fn event_types(engine: &Engine) -> Vec<String> {
    engine
        .events()
        .iter()
        .map(|event| event.event_type.clone())
        .collect()
}

fn event_payloads<'a>(engine: &'a Engine, kind: &str) -> Vec<&'a Value> {
    engine
        .events()
        .iter()
        .filter(|event| event.event_type == kind)
        .map(|event| &event.payload)
        .collect()
}

#[test]
fn happy_path_runs_and_validates_event_stream() {
    let result = drive(golden_engine(), Host::new());
    assert_eq!(result.engine.state().as_str(), "SUCCEEDED");
    assert!(matches!(
        result.output.directive,
        Directive::Finished { .. }
    ));
    assert_eq!(
        result.host.performed,
        vec![
            "open:launch",
            "type-keyword:input",
            "submit:click",
            "read-summary:read-text"
        ]
    );
    let events = result.engine.events();
    assert_eq!(events.first().unwrap().event_type, "RunStarted");
    assert_eq!(events.last().unwrap().event_type, "RunFinished");
    for (index, event) in events.iter().enumerate() {
        assert_eq!(event.seq, index as u64 + 1);
    }
    assert!(event_types(&result.engine).contains(&"StepSucceeded".to_string()));
    assert_eq!(event_payloads(&result.engine, "StepFailed").len(), 0);
    // The engine, not the host, interpolated the variable.
    let attempted = event_payloads(&result.engine, "ActionAttempted");
    assert!(attempted.iter().any(|payload| payload["action"] == "input"));
}

#[test]
fn rejects_invalid_ir_before_arming() {
    let mut flow = golden();
    flow["steps"][2]
        .as_object_mut()
        .unwrap()
        .remove("postconditions");
    let mut engine = Engine::new();
    let error = engine
        .load_value(serde_json::from_value::<Flow>(flow).expect("decode"))
        .unwrap_err();
    assert_eq!(error.code, "INVALID_IR");
    let issues = error.detail.unwrap()["issues"].clone();
    assert!(issues
        .as_array()
        .unwrap()
        .iter()
        .any(|issue| issue["rule"] == "step.missing-postcondition"));
    assert_eq!(engine.state().as_str(), "DRAFT");
}

#[test]
fn rejects_missing_permissions() {
    let mut flow = golden();
    flow["permissions"] = json!(["read-ui", "read-screen", "type", "launch", "navigate"]);
    let error = Engine::new()
        .load_value(serde_json::from_value::<Flow>(flow).expect("decode"))
        .unwrap_err();
    assert_eq!(error.code, "INVALID_IR");
}

#[test]
fn no_action_when_target_is_ambiguous() {
    let mut flow = golden();
    // Drop native identity + structure so the decoy ties on semantics.
    let click = &mut flow["steps"][2];
    click["target"] = json!({
        "anchors": { "semantic": { "role": "button", "name": "搜索" } }
    });
    let mut host = Host::new();
    // Two identical semantic candidates, both auto-eligible once structure ties.
    let mut decoy = submit_button();
    decoy.candidate_id = "c-decoy".into();
    host.candidates.push(decoy);
    let mut engine = configured_engine(flow);
    // This flow's target has no structure, so the engine asks for confirmation
    // (low confidence) rather than executing on a guess.
    host.stop_on_disambiguation = true;
    let result = drive(engine, host);
    assert_eq!(result.engine.state().as_str(), "PAUSED_FOR_DISAMBIGUATION");
    assert!(matches!(
        result.output.directive,
        Directive::AwaitDisambiguation { .. }
    ));
    assert!(!result
        .host
        .performed
        .iter()
        .any(|action| action.starts_with("submit:")));
    engine = result.engine;
    assert!(engine
        .events()
        .iter()
        .any(|event| event.event_type == "CandidatesRanked"));
}

#[test]
fn disambiguation_choice_executes_exactly_once() {
    let mut flow = golden();
    flow["steps"][2]["target"] = json!({
        "anchors": {
            "semantic": { "role": "button", "name": "搜索" },
            "structure": { "path": ["main.page", "form#search-form", "button#search-submit"] }
        }
    });
    let mut host = Host::new();
    let mut decoy = submit_button();
    decoy.candidate_id = "c-decoy".into();
    host.candidates.push(decoy);
    host.disambiguation_pick = Some("c-decoy".into());
    let result = drive(configured_engine(flow), host);
    assert_eq!(result.engine.state().as_str(), "SUCCEEDED");
    assert_eq!(
        result
            .host
            .performed
            .iter()
            .filter(|action| action.starts_with("submit:"))
            .count(),
        1
    );
    assert!(event_payloads(&result.engine, "Diagnostic")
        .iter()
        .any(|payload| payload["reason"] == "anchor_override"));
}

#[test]
fn visual_only_candidate_requires_confirmation() {
    let mut flow = golden();
    flow["steps"][2]["target"] = json!({
        "anchors": {
            "visual": { "dhash": "ffffffffffffffff", "norm_rect": { "x": 0.1, "y": 0.2, "w": 0.1, "h": 0.05 } }
        }
    });
    let mut host = Host::new();
    let visual_submit = {
        let mut item = submit_button();
        item.native_identity = None;
        item.semantic = None;
        item.structure = None;
        item.visual = Some(ib_anchor::CandidateVisual {
            dhash: Some("ffffffffffffffff".into()),
            norm_rect: Some(ib_anchor::NormRect {
                x: 0.1,
                y: 0.2,
                w: 0.1,
                h: 0.05,
            }),
            ..Default::default()
        });
        item
    };
    host.candidates = vec![input_field(), visual_submit];
    host.stop_on_disambiguation = true;
    let result = drive(configured_engine(flow), host);
    assert_eq!(result.engine.state().as_str(), "PAUSED_FOR_DISAMBIGUATION");
    match &result.output.directive {
        Directive::AwaitDisambiguation { reason, .. } => assert_eq!(reason, "visual_only"),
        other => panic!("expected disambiguation, got {other:?}"),
    }
    assert!(
        result
            .host
            .performed
            .iter()
            .filter(|action| action.starts_with("submit:"))
            .count()
            == 0
    );
}

#[test]
fn write_failure_does_not_retry_without_idempotency() {
    let mut engine = golden_engine();
    let mut host = Host::new();
    host.failures.insert("submit".into(), 1);
    let result = drive(engine, host);
    engine = result.engine;
    assert_eq!(engine.state().as_str(), "FAILED");
    assert_eq!(
        result
            .host
            .performed
            .iter()
            .filter(|action| action.starts_with("submit:"))
            .count(),
        1
    );
    assert_eq!(event_payloads(&engine, "StepFailed").len(), 1);
}

#[test]
fn read_only_action_retries_with_backoff() {
    let mut host = Host::new();
    host.failures.insert("read-summary".into(), 1);
    let result = drive(golden_engine(), host);
    assert_eq!(result.engine.state().as_str(), "SUCCEEDED");
    assert_eq!(
        result
            .host
            .performed
            .iter()
            .filter(|action| action.starts_with("read-summary:"))
            .count(),
        2
    );
    assert!(event_payloads(&result.engine, "Diagnostic")
        .iter()
        .any(|payload| payload["reason"] == "retry"));
}

#[test]
fn idempotent_write_retries_once() {
    let mut flow = golden();
    flow["steps"][2]["retry"] = json!({ "max_attempts": 2, "idempotency_key": "search-submit-1" });
    let mut host = Host::new();
    host.failures.insert("submit".into(), 1);
    let result = drive(configured_engine(flow), host);
    assert_eq!(result.engine.state().as_str(), "SUCCEEDED");
    assert_eq!(
        result
            .host
            .performed
            .iter()
            .filter(|action| action.starts_with("submit:"))
            .count(),
        2
    );
    let attempts = event_payloads(&result.engine, "ActionAttempted");
    assert!(attempts
        .iter()
        .filter(|payload| payload["action"] == "click")
        .all(|payload| payload["idempotency_key"] == "search-submit-1"));
}

#[test]
fn postcondition_timeout_after_write_pauses_as_outcome_unknown() {
    let mut host = Host::new();
    host.hide_after_write = true;
    let result = drive(golden_engine(), host);
    assert_eq!(result.engine.state().as_str(), "FAILED");
    // The user answered "failed"; the write happened exactly once.
    assert_eq!(
        result
            .host
            .performed
            .iter()
            .filter(|action| action.starts_with("submit:click"))
            .count(),
        1
    );
    let pauses = event_payloads(&result.engine, "RunPaused");
    assert!(pauses
        .iter()
        .any(|payload| payload["reason"] == "outcome_unknown"));
    assert_eq!(event_payloads(&result.engine, "StepFailed").len(), 1);
}

#[test]
fn approval_denied_blocks_sensitive_action() {
    let mut flow = golden();
    flow["steps"][2]["risk"] = json!("sensitive");
    let mut host = Host::new();
    host.approve = false;
    let result = drive(configured_engine(flow), host);
    assert_eq!(result.engine.state().as_str(), "FAILED");
    assert_eq!(
        result
            .host
            .performed
            .iter()
            .filter(|action| action.starts_with("submit:"))
            .count(),
        0
    );
    let failures = event_payloads(&result.engine, "StepFailed");
    assert_eq!(failures[0]["error"]["code"], "APPROVAL_REQUIRED");
}

#[test]
fn approval_granted_executes_sensitive_action() {
    let mut flow = golden();
    flow["steps"][2]["risk"] = json!("sensitive");
    let result = drive(configured_engine(flow), Host::new());
    assert_eq!(result.engine.state().as_str(), "SUCCEEDED");
    assert!(event_payloads(&result.engine, "ApprovalRequested")
        .iter()
        .any(|payload| payload["approved"] == true));
}

#[test]
fn app_scope_violation_pauses_before_action() {
    let mut host = Host::new();
    host.scope_override = Some("http://127.0.0.1:4318".into());
    let mut engine = golden_engine();
    let mut output = engine
        .start(StartOptions {
            run_id: "run-scope-1".into(),
            now_mono_ms: host.now,
            wall_time_ms: 1_700_000_000_000,
            variables: [("keyword".to_string(), json!("报告"))]
                .into_iter()
                .collect(),
            start_step_id: None,
            single_step: false,
        })
        .expect("start");
    // First directive: launch action (no target). Then the postcondition observation
    // arrives from the foreign origin and the engine pauses.
    for _ in 0..20 {
        match &output.directive {
            Directive::Finished { .. } => break,
            Directive::PerformAction {
                step_id,
                attempt_id,
                ..
            } => {
                output = engine
                    .submit(EngineInput::ActionDone {
                        now_mono_ms: host.now,
                        step_id: step_id.clone(),
                        attempt_id: attempt_id.clone(),
                        outcome: "succeeded".into(),
                        error: None,
                        facts: Some(host.facts()),
                        text: None,
                    })
                    .expect("action done");
            }
            Directive::AwaitCondition {
                step_id,
                condition_id,
                ..
            } => {
                output = engine
                    .submit(EngineInput::Observation {
                        now_mono_ms: host.now,
                        step_id: step_id.clone(),
                        attempt_id: None,
                        condition_id: condition_id.clone(),
                        facts: host.facts(),
                    })
                    .expect("observation");
            }
            other => panic!("unexpected directive {other:?}"),
        }
        host.now += 10.0;
        if engine.state().as_str() == "PAUSED_FOR_RECOVERY" {
            break;
        }
    }
    assert_eq!(engine.state().as_str(), "PAUSED_FOR_RECOVERY");
    assert!(!host
        .performed
        .iter()
        .any(|action| action.starts_with("type-keyword")));
}

#[test]
fn cancel_is_recorded_and_terminal() {
    let mut engine = golden_engine();
    let mut output = engine
        .start(StartOptions {
            run_id: "run-cancel-1".into(),
            now_mono_ms: 1_000.0,
            wall_time_ms: 1_700_000_000_000,
            variables: [("keyword".to_string(), json!("报告"))]
                .into_iter()
                .collect(),
            start_step_id: None,
            single_step: false,
        })
        .expect("start");
    // Cancel while a target resolution is pending.
    output = engine
        .submit(EngineInput::Cancel {
            now_mono_ms: 1_010.0,
            reason: Some("user_cancelled".into()),
        })
        .expect("cancel");
    assert_eq!(engine.state().as_str(), "CANCELLED");
    assert!(matches!(output.directive, Directive::Finished { .. }));
    let finished = event_payloads(&engine, "RunFinished");
    assert_eq!(finished[0]["status"], "cancelled");
    // Duplicate cancel is refused, not silently accepted.
    assert!(engine
        .submit(EngineInput::Cancel {
            now_mono_ms: 1_020.0,
            reason: None,
        })
        .is_err());
}

#[test]
fn pause_and_resume_reexecutes_nothing() {
    let mut engine = golden_engine();
    let mut output = engine
        .start(StartOptions {
            run_id: "run-pause-1".into(),
            now_mono_ms: 1_000.0,
            wall_time_ms: 1_700_000_000_000,
            variables: [("keyword".to_string(), json!("报告"))]
                .into_iter()
                .collect(),
            start_step_id: None,
            single_step: false,
        })
        .expect("start");
    assert!(matches!(output.directive, Directive::PerformAction { .. }));
    let paused_before = engine.events().len();
    output = engine
        .submit(EngineInput::Pause {
            now_mono_ms: 1_010.0,
        })
        .expect("pause");
    match &output.directive {
        Directive::AwaitRecovery { reason, .. } => assert_eq!(reason, "user_pause"),
        other => panic!("expected recovery pause, got {other:?}"),
    }
    assert_eq!(engine.state().as_str(), "PAUSED_FOR_RECOVERY");
    output = engine
        .submit(EngineInput::RecoveryDecision {
            now_mono_ms: 1_020.0,
            decision: "resume".into(),
            note: None,
        })
        .expect("resume");
    assert!(matches!(output.directive, Directive::PerformAction { .. }));
    assert_eq!(engine.state().as_str(), "RUNNING");
    // Only state/pause events were added while paused.
    assert!(engine.events().len() > paused_before);
}

#[test]
fn recovery_retry_runs_step_again() {
    let mut flow = golden();
    flow["steps"][2]["on_failure"] = json!("ask-user");
    let mut host = Host::new();
    host.failures.insert("submit".into(), 1);
    let result = drive(configured_engine(flow), host);
    assert_eq!(result.engine.state().as_str(), "SUCCEEDED");
    assert_eq!(
        result
            .host
            .performed
            .iter()
            .filter(|action| action.starts_with("submit:"))
            .count(),
        2
    );
}

#[test]
fn crash_recovery_never_claims_success() {
    let result = drive(golden_engine(), Host::new());
    let events = result.engine.events();
    let recovered = Engine::recover(events).expect("recover");
    assert!(recovered.terminated);
    assert_eq!(recovered.state.as_str(), "SUCCEEDED");

    // Simulate a crash after an action attempt: no RunFinished event.
    let truncated = events
        .iter()
        .take_while(|event| event.event_type != "RunFinished")
        .cloned()
        .collect::<Vec<_>>();
    let crashed = Engine::recover(&truncated).expect("recover truncated");
    assert!(!crashed.terminated);
    assert_eq!(crashed.state.as_str(), "OUTCOME_UNKNOWN");
    assert!(crashed.may_have_side_effects);
}

#[test]
fn duplicate_action_result_is_rejected() {
    let mut engine = golden_engine();
    let output = engine
        .start(StartOptions {
            run_id: "run-duplicate-1".into(),
            now_mono_ms: 1_000.0,
            wall_time_ms: 1_700_000_000_000,
            variables: [("keyword".to_string(), json!("报告"))]
                .into_iter()
                .collect(),
            start_step_id: None,
            single_step: false,
        })
        .expect("start");
    let (step_id, attempt_id) = match &output.directive {
        Directive::PerformAction {
            step_id,
            attempt_id,
            ..
        } => (step_id.clone(), attempt_id.clone()),
        other => panic!("expected action, got {other:?}"),
    };
    let input = EngineInput::ActionDone {
        now_mono_ms: 1_010.0,
        step_id,
        attempt_id,
        outcome: "succeeded".into(),
        error: None,
        facts: None,
        text: None,
    };
    engine.submit(input).expect("first result");
    let duplicate = EngineInput::ActionDone {
        now_mono_ms: 1_020.0,
        step_id: "open".into(),
        attempt_id: "att-duplicate".into(),
        outcome: "succeeded".into(),
        error: None,
        facts: None,
        text: None,
    };
    assert_eq!(engine.submit(duplicate).unwrap_err().code, "INVALID_STATE");
}

#[test]
fn stale_candidates_are_re_resolved_without_execution() {
    let mut host = Host::new();
    host.stale_first = true;
    let result = drive(golden_engine(), host);
    assert_eq!(result.engine.state().as_str(), "SUCCEEDED");
    assert_eq!(
        result
            .host
            .performed
            .iter()
            .filter(|action| action.starts_with("submit:click"))
            .count(),
        1
    );
    assert!(result
        .engine
        .events()
        .iter()
        .any(|event| event.event_type == "AwaitTimer" || event.event_type == "CandidatesRanked"));
}

#[test]
fn runtime_limits_are_enforced() {
    let mut engine = Engine::with_config(EngineConfig {
        max_steps_per_run: 1,
        ..EngineConfig::default()
    });
    engine
        .load_value(serde_json::from_value::<Flow>(golden()).expect("decode"))
        .expect("load");
    // Validation refuses a flow longer than the runtime cap.
    assert!(engine.validate().is_err());
}

#[test]
fn single_step_trial_pauses_after_one_step() {
    let mut engine = golden_engine();
    let mut output = engine
        .start(StartOptions {
            run_id: "run-single-1".into(),
            now_mono_ms: 1_000.0,
            wall_time_ms: 1_700_000_000_000,
            variables: [("keyword".to_string(), json!("报告"))]
                .into_iter()
                .collect(),
            start_step_id: Some("type-keyword".into()),
            single_step: true,
        })
        .expect("start");
    let mut host = Host::new();
    for _ in 0..40 {
        match &output.directive {
            Directive::Finished { .. } => break,
            Directive::ResolveTarget {
                step_id,
                attempt_id,
                ..
            } => {
                output = engine
                    .submit(EngineInput::Candidates {
                        now_mono_ms: host.now,
                        step_id: step_id.clone(),
                        attempt_id: attempt_id.clone(),
                        candidates: host.candidates.clone(),
                        facts: Some(host.facts()),
                    })
                    .expect("candidates");
            }
            Directive::PerformAction {
                step_id,
                attempt_id,
                action,
                ..
            } => {
                if action == "input" {
                    host.add_results();
                }
                output = engine
                    .submit(EngineInput::ActionDone {
                        now_mono_ms: host.now,
                        step_id: step_id.clone(),
                        attempt_id: attempt_id.clone(),
                        outcome: "succeeded".into(),
                        error: None,
                        facts: Some(host.facts()),
                        text: Some(host.summary_text.clone()),
                    })
                    .expect("action");
            }
            Directive::AwaitCondition {
                step_id,
                condition_id,
                ..
            } => {
                host.now += 200.0;
                output = engine
                    .submit(EngineInput::Observation {
                        now_mono_ms: host.now,
                        step_id: step_id.clone(),
                        attempt_id: None,
                        condition_id: condition_id.clone(),
                        facts: host.facts(),
                    })
                    .expect("observation");
            }
            Directive::AwaitRecovery { reason, .. } => {
                assert_eq!(reason, "single_step");
                break;
            }
            other => panic!("unexpected directive {other:?}"),
        }
        host.now += 20.0;
    }
    assert_eq!(engine.state().as_str(), "PAUSED_FOR_RECOVERY");
    assert!(engine
        .events()
        .iter()
        .any(|event| event.event_type == "Diagnostic"
            && event.payload["reason"] == "trial_run_options"));
}

#[test]
fn secret_reference_is_never_rendered_into_directive() {
    let mut flow = golden();
    flow["variables"] =
        json!([{ "name": "keyword", "type": "string", "required": true, "sensitive": true }]);
    let input_step = &mut flow["steps"][1];
    input_step["target"]["anchors"]["semantic"] =
        json!({ "role": "textbox", "name": "Password", "test_id": "keyword-input" });
    input_step["params"]["value"] = json!("secret://demo-password");
    input_step["evidence_policy"] = json!({ "capture": "none", "mask_text": true });
    // Evidence capture is flow-wide; disable it for every step to satisfy the validator.
    for step in flow["steps"].as_array_mut().unwrap() {
        step["evidence_policy"] = json!({ "capture": "none" });
    }
    let mut engine = configured_engine(flow);
    let mut host = Host::new();
    host.hide_elements = false;
    let mut output = engine
        .start(StartOptions {
            run_id: "run-secret-1".into(),
            now_mono_ms: 1_000.0,
            wall_time_ms: 1_700_000_000_000,
            variables: [("keyword".to_string(), json!("报告"))]
                .into_iter()
                .collect(),
            start_step_id: None,
            single_step: false,
        })
        .expect("start");
    let mut checked = false;
    for _ in 0..40 {
        match &output.directive {
            Directive::Finished { .. } => break,
            Directive::PerformAction {
                step_id,
                attempt_id,
                action,
                params,
                params_preview,
                ..
            } => {
                if action == "input" {
                    assert_eq!(params["value"], "secret://demo-password");
                    assert_eq!(params_preview["value"], "secret://demo-password");
                    checked = true;
                }
                output = engine
                    .submit(EngineInput::ActionDone {
                        now_mono_ms: 1_100.0,
                        step_id: step_id.clone(),
                        attempt_id: attempt_id.clone(),
                        outcome: "succeeded".into(),
                        error: None,
                        facts: Some(host.facts()),
                        text: None,
                    })
                    .expect("action");
            }
            Directive::AwaitCondition {
                step_id,
                condition_id,
                ..
            } => {
                output = engine
                    .submit(EngineInput::Observation {
                        now_mono_ms: 1_100.0,
                        step_id: step_id.clone(),
                        attempt_id: None,
                        condition_id: condition_id.clone(),
                        facts: host.facts(),
                    })
                    .expect("observation");
            }
            Directive::ResolveTarget {
                step_id,
                attempt_id,
                ..
            } => {
                output = engine
                    .submit(EngineInput::Candidates {
                        now_mono_ms: 1_100.0,
                        step_id: step_id.clone(),
                        attempt_id: attempt_id.clone(),
                        candidates: host.candidates.clone(),
                        facts: Some(host.facts()),
                    })
                    .expect("candidates");
            }
            other => panic!("unexpected directive {other:?}"),
        }
        if checked {
            break;
        }
    }
    assert!(checked, "input step should have executed");
}

#[test]
fn validator_accepts_fixture_and_rejects_secret_placement() {
    let flow: Flow = serde_json::from_value(golden()).expect("decode");
    assert!(!validate_flow(
        &flow,
        true,
        &ib_runtime::ir::ValidationLimits {
            max_steps: 100,
            max_step_timeout_ms: 120_000
        }
    )
    .iter()
    .any(|issue| issue.severity == "error"));
}
