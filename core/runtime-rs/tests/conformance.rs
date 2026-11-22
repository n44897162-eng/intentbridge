//! Cross-platform conformance: the same IR action sequence must produce the
//! same state transitions, event classes and error codes on every host.
//! Hosts here are virtual providers (no OS automation); real Windows/Android
//! providers are reported separately as NOT_RUN.

use ib_anchor::{Candidate, CandidateContext, CandidateSemantic, CandidateStructure};
use ib_runtime::engine::{BridgeError, Directive, Engine, EngineInput, StartOptions, StepOutput};
use ib_runtime::ir::Flow;
use ib_runtime::Facts;
use serde_json::{json, Value};
use std::collections::BTreeMap;

const WEB: &str = include_str!("../../../fixtures/flows/web-basic.flow.json");
const WINDOWS: &str = include_str!("../../../fixtures/flows/windows-basic.flow.json");
const ANDROID: &str = include_str!("../../../fixtures/flows/android-basic.flow.json");

fn flow(value: &str) -> Flow {
    serde_json::from_str(value).expect("flow json")
}

fn scope_of(flow: &Flow) -> String {
    flow.app_scope.value.clone()
}

fn candidate_for_target(target: &ib_anchor::Target, index: usize, scope: &str) -> Candidate {
    let native = target.anchors.native_identity.clone();
    let semantic = target
        .anchors
        .semantic
        .clone()
        .map(|semantic| CandidateSemantic {
            role: semantic.role,
            name: semantic.name,
            label: semantic.label,
            placeholder: semantic.placeholder,
            test_id: semantic.test_id,
            control_type: semantic.control_type,
            text: semantic.text,
        });
    let structure = target
        .anchors
        .structure
        .clone()
        .map(|structure| CandidateStructure {
            path: structure.path,
            parent: structure.parent,
            container: structure.container,
            sibling_index: structure.sibling_index,
            sibling_count: structure.sibling_count,
        });
    Candidate {
        candidate_id: format!("c-{index}"),
        native_identity: native,
        semantic,
        structure,
        visual: None,
        context: Some(CandidateContext {
            app_scope: Some(scope.to_string()),
            window_title: Some("fixture".into()),
            url: Some(scope.to_string()),
        }),
        visible: true,
        enabled: true,
        editable: Some(true),
        stale: None,
        in_viewport: Some(true),
        rect: None,
        text: Some("报告 找到结果".into()),
    }
}

fn condition_target(condition: &ib_runtime::ir::Condition) -> Option<&ib_anchor::Target> {
    match condition {
        ib_runtime::ir::Condition::ElementPresent { target }
        | ib_runtime::ir::Condition::ElementAbsent { target }
        | ib_runtime::ir::Condition::TextMatches { target, .. } => Some(target),
        _ => None,
    }
}

fn all_targets(flow: &Flow) -> Vec<ib_anchor::Target> {
    let mut targets = Vec::new();
    for step in &flow.steps {
        if let Some(target) = &step.target {
            targets.push(target.clone());
        }
        for condition in step.preconditions.iter().chain(step.postconditions.iter()) {
            if let Some(target) = condition_target(condition) {
                targets.push(target.clone());
            }
        }
        if let Some(params) = &step.params {
            for key in ["condition", "boundary_condition"] {
                if let Some(value) = params.get(key) {
                    if let Ok(condition) =
                        serde_json::from_value::<ib_runtime::ir::Condition>(value.clone())
                    {
                        if let Some(target) = condition_target(&condition) {
                            targets.push(target.clone());
                        }
                    }
                }
            }
        }
    }
    targets
}

fn candidates(flow: &Flow) -> Vec<Candidate> {
    let scope = scope_of(flow);
    let mut unique: BTreeMap<String, Candidate> = BTreeMap::new();
    for (index, target) in all_targets(flow).iter().enumerate() {
        let candidate = candidate_for_target(target, index, &scope);
        let key = candidate
            .native_identity
            .as_ref()
            .map(|native| format!("{}:{}", native.kind, native.value))
            .unwrap_or_else(|| {
                format!(
                    "{}|{:?}|{:?}",
                    candidate
                        .semantic
                        .as_ref()
                        .and_then(|s| s.test_id.clone())
                        .unwrap_or_default(),
                    candidate.semantic.as_ref().and_then(|s| s.name.clone()),
                    candidate.structure.as_ref().and_then(|s| s.path.clone()),
                )
            });
        unique.entry(key).or_insert(candidate);
    }
    unique.into_values().collect()
}

struct Host {
    now: f64,
    scope: String,
    candidates: Vec<Candidate>,
    performed: Vec<String>,
}

impl Host {
    fn new(flow: &Flow) -> Self {
        Self {
            now: 1_000.0,
            scope: scope_of(flow),
            candidates: candidates(flow),
            performed: Vec::new(),
        }
    }

    fn facts(&self) -> Facts {
        Facts {
            now_mono_ms: Some(self.now),
            app_scope: Some(self.scope.clone()),
            url: Some(self.scope.clone()),
            window_title: Some("fixture".into()),
            window_stable_ms: Some(5_000.0),
            elements: Some(self.candidates.clone()),
            variable_values: None,
            text: None,
            foreground: Some(true),
            evidence_ref: None,
        }
    }
}

fn drive(
    mut engine: Engine,
    mut host: Host,
    start_step: Option<&str>,
) -> (Engine, Host, StepOutput) {
    let mut output = engine
        .start(StartOptions {
            run_id: "run-conformance-1".into(),
            now_mono_ms: host.now,
            wall_time_ms: 1_700_000_000_000,
            variables: [("keyword".to_string(), json!("报告"))]
                .into_iter()
                .collect(),
            start_step_id: start_step.map(|step| step.to_string()),
            single_step: false,
        })
        .expect("start");
    for _ in 0..1_000 {
        let now = host.now;
        let input = match &output.directive {
            Directive::Finished { .. } => return (engine, host, output),
            Directive::ResolveTarget {
                step_id,
                attempt_id,
                ..
            } => EngineInput::Candidates {
                now_mono_ms: now,
                step_id: step_id.clone(),
                attempt_id: attempt_id.clone(),
                candidates: host.candidates.clone(),
                facts: Some(host.facts()),
            },
            Directive::PerformAction {
                step_id,
                attempt_id,
                action,
                ..
            } => {
                host.performed.push(action.to_string());
                let mut facts = host.facts();
                if action == "input" {
                    for candidate in &mut host.candidates {
                        if candidate
                            .semantic
                            .as_ref()
                            .and_then(|semantic| semantic.control_type.as_deref())
                            .map(|kind| kind.contains("Edit") || kind.contains("Text"))
                            .unwrap_or(false)
                        {
                            candidate.text = Some("报告".into());
                        }
                    }
                    facts.elements = Some(host.candidates.clone());
                }
                EngineInput::ActionDone {
                    now_mono_ms: now,
                    step_id: step_id.clone(),
                    attempt_id: attempt_id.clone(),
                    outcome: "succeeded".into(),
                    error: None,
                    facts: Some(facts),
                    text: Some("找到 报告 结果".into()),
                }
            }
            Directive::AwaitCondition {
                step_id,
                attempt_id,
                condition_id,
                deadline_mono_ms,
                ..
            } => {
                host.now = host.now.max(*deadline_mono_ms);
                EngineInput::Observation {
                    now_mono_ms: host.now,
                    step_id: step_id.clone(),
                    attempt_id: Some(attempt_id.clone()),
                    condition_id: condition_id.clone(),
                    facts: host.facts(),
                }
            }
            Directive::AwaitTimer {
                wake_at_mono_ms, ..
            } => {
                host.now = host.now.max(*wake_at_mono_ms);
                EngineInput::Tick {
                    now_mono_ms: host.now,
                }
            }
            Directive::AwaitApproval { .. } => panic!("unexpected approval"),
            Directive::AwaitDisambiguation { .. } => panic!("unexpected disambiguation"),
            Directive::AwaitOutcomeDecision { error, step_id, .. } => {
                let tail: Vec<String> = engine
                    .events()
                    .iter()
                    .rev()
                    .take(8)
                    .map(|event| format!("{}:{}", event.event_type, event.payload))
                    .collect();
                panic!("unexpected outcome decision step={step_id} error={error:?} tail={tail:#?}");
            }
            Directive::AwaitRecovery { .. } => panic!("unexpected recovery"),
        };
        host.now += 10.0;
        output = engine.submit(input).expect("submit");
    }
    panic!("run did not finish");
}

fn configured(value: &str) -> Engine {
    let mut engine = Engine::new();
    engine.load_value(flow(value)).expect("load");
    engine.validate().expect("validate");
    engine.arm().expect("arm");
    engine
}

fn action_sequence(value: &str) -> Vec<String> {
    flow(value)
        .steps
        .iter()
        .filter(|step| {
            matches!(
                step.action,
                ib_runtime::ir::Action::Launch
                    | ib_runtime::ir::Action::Input
                    | ib_runtime::ir::Action::Click
                    | ib_runtime::ir::Action::ReadText
            )
        })
        .map(|step| step.action.as_str().to_string())
        .collect()
}

#[test]
fn same_ir_semantics_for_web_windows_and_android() {
    for (name, value) in [("web", WEB), ("windows", WINDOWS), ("android", ANDROID)] {
        let flow = flow(value);
        let (engine, host, output) = drive(configured(value), Host::new(&flow), None);
        assert_eq!(engine.state().as_str(), "SUCCEEDED", "{name}");
        assert!(matches!(output.directive, Directive::Finished { .. }));
        assert_eq!(
            host.performed,
            action_sequence(value),
            "{name} action order"
        );
        let succeeded = engine
            .events()
            .iter()
            .filter(|event| event.event_type == "StepSucceeded")
            .count();
        assert_eq!(succeeded, flow.steps.len(), "{name} step count");
        let started = engine.events().first().expect("run started");
        assert_eq!(
            started.payload["platform"],
            json!(flow.platform),
            "{name} platform"
        );
        for (index, event) in engine.events().iter().enumerate() {
            assert_eq!(event.seq, index as u64 + 1);
        }
    }
}

#[test]
fn missing_permission_is_rejected_identically() {
    for (name, value) in [("web", WEB), ("windows", WINDOWS), ("android", ANDROID)] {
        let mut document: Value = serde_json::from_str(value).expect("json");
        document["permissions"] = json!(["read-ui", "read-screen", "launch"]);
        let mut engine = Engine::new();
        let error = engine
            .load_value(serde_json::from_value(document).expect("flow"))
            .expect_err(name);
        assert_eq!(error.code, "INVALID_IR", "{name}");
    }
}

#[test]
fn missing_target_reports_target_not_found_identically() {
    for (name, value) in [("web", WEB), ("windows", WINDOWS), ("android", ANDROID)] {
        let mut document: Value = serde_json::from_str(value).expect("json");
        for step in document["steps"].as_array_mut().expect("steps") {
            step["preconditions"] = json!([]);
        }
        let mut engine = Engine::new();
        engine
            .load_value(serde_json::from_value(document).expect("flow"))
            .expect("load");
        engine.validate().expect("validate");
        engine.arm().expect("arm");
        let mut host = Host::new(&flow(value));
        host.candidates.clear();
        let (engine, _host, output) = drive(engine, host, Some("type-keyword"));
        assert_eq!(engine.state().as_str(), "FAILED", "{name}");
        let failure = match output.directive {
            Directive::Finished { error, .. } => error,
            other => panic!("{name}: expected finished, got {other:?}"),
        };
        assert_eq!(
            failure.map(|error: BridgeError| error.code),
            Some("TARGET_NOT_FOUND".into()),
            "{name}"
        );
    }
}

#[test]
fn app_scope_violation_pauses_on_every_platform() {
    for (name, value) in [("web", WEB), ("windows", WINDOWS), ("android", ANDROID)] {
        let flow = flow(value);
        let mut engine = configured(value);
        let mut host = Host::new(&flow);
        host.scope = "single-spa|unrelated".into();
        // Launch is allowed to navigate into scope; the postcondition observation
        // then arrives from a foreign app and must pause.
        let mut output = engine
            .start(StartOptions {
                run_id: "run-scope-conformance".into(),
                now_mono_ms: 1_000.0,
                wall_time_ms: 1_700_000_000_000,
                variables: [("keyword".to_string(), json!("报告"))]
                    .into_iter()
                    .collect(),
                start_step_id: None,
                single_step: false,
            })
            .expect("start");
        let mut paused = false;
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
                        .expect("action");
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
                Directive::AwaitOutcomeDecision { error, .. } => {
                    assert_eq!(error.code, "APP_SCOPE_VIOLATION");
                    paused = true;
                    break;
                }
                other => panic!("{name}: unexpected {other:?}"),
            }
            if engine.state().as_str() == "PAUSED_FOR_RECOVERY" {
                paused = true;
                break;
            }
            host.now += 100.0;
        }
        assert!(paused, "{name} should pause on scope violation");
        assert_eq!(engine.state().as_str(), "PAUSED_FOR_OUTCOME");
    }
}

#[test]
fn read_text_is_platform_neutral() {
    // The web flow exercises read-text; Android/Windows flows do not, so this
    // guards against the action existing only in a web-specific branch.
    let (engine, _host, _output) = drive(configured(WEB), Host::new(&flow(WEB)), None);
    assert_eq!(engine.state().as_str(), "SUCCEEDED");
    assert!(engine
        .events()
        .iter()
        .any(|event| event.event_type == "VariableSet" && event.payload["name"] == "summary"));
}
