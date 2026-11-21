//! 500-run soak on the virtual event source. This exercises engine allocation,
//! event sequencing and terminal states without a real UI; real Chrome soak is
//! measured separately in tests/soak.
#![allow(dead_code, unused_variables, unused_assignments, unused_mut)]

use ib_anchor::{Candidate, CandidateContext, CandidateSemantic, NativeIdentity};
use ib_runtime::engine::{Directive, Engine, EngineInput, StartOptions};
use ib_runtime::ir::Flow;
use ib_runtime::Facts;

const FLOW: &str = r#"{
  "schema_version": "1.0.0",
  "flow_id": "77777777-7777-4777-8777-777777777777",
  "name": "soak",
  "platform": "web",
  "app_scope": { "kind": "web-origin", "value": "http://127.0.0.1:4317" },
  "variables": [],
  "permissions": ["read-ui", "read-screen", "launch"],
  "steps": [
    {
      "id": "open",
      "action": "launch",
      "postconditions": [
        {
          "kind": "element-present",
          "target": {
            "anchors": {
              "semantic": { "role": "main", "test_id": "app" },
              "native_identity": { "kind": "web-test-id", "value": "app" }
            }
          }
        }
      ],
      "params": { "app_id": "http://127.0.0.1:4317", "url": "http://127.0.0.1:4317/" }
    },
    { "id": "done", "action": "end", "params": { "status": "success" } }
  ],
  "created_by": "soak",
  "revision": 1
}"#;

fn candidate() -> Candidate {
    Candidate {
        candidate_id: "c-app".into(),
        native_identity: Some(NativeIdentity {
            kind: "web-test-id".into(),
            value: "app".into(),
        }),
        semantic: Some(CandidateSemantic {
            role: Some("main".into()),
            test_id: Some("app".into()),
            ..Default::default()
        }),
        structure: None,
        visual: None,
        context: Some(CandidateContext {
            app_scope: Some("http://127.0.0.1:4317".into()),
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

fn facts(now: f64) -> Facts {
    Facts {
        now_mono_ms: Some(now),
        app_scope: Some("http://127.0.0.1:4317".into()),
        url: Some("http://127.0.0.1:4317/".into()),
        window_title: Some("soak".into()),
        window_stable_ms: Some(5_000.0),
        elements: Some(vec![candidate()]),
        ..Facts::default()
    }
}

fn rss_kb() -> u64 {
    let statm = std::fs::read_to_string("/proc/self/statm").unwrap_or_default();
    let resident: u64 = statm
        .split_whitespace()
        .nth(1)
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    resident * 4
}

fn one_run(index: u64) {
    let mut engine = Engine::new();
    engine
        .load_value(serde_json::from_str::<Flow>(FLOW).expect("flow"))
        .expect("load");
    engine.validate().expect("validate");
    engine.arm().expect("arm");
    let mut now = 1_000.0;
    let mut output = engine
        .start(StartOptions {
            run_id: format!("run-soak-{index:06}"),
            now_mono_ms: now,
            wall_time_ms: 1_700_000_000_000,
            variables: Default::default(),
            start_step_id: None,
            single_step: false,
        })
        .expect("start");
    for _ in 0..40 {
        now += 10.0;
        let input = match &output.directive {
            Directive::Finished { .. } => break,
            Directive::PerformAction {
                step_id,
                attempt_id,
                ..
            } => EngineInput::ActionDone {
                now_mono_ms: now,
                step_id: step_id.clone(),
                attempt_id: attempt_id.clone(),
                outcome: "succeeded".into(),
                error: None,
                facts: Some(facts(now)),
                text: None,
            },
            Directive::AwaitCondition {
                step_id,
                condition_id,
                ..
            } => EngineInput::Observation {
                now_mono_ms: now,
                step_id: step_id.clone(),
                attempt_id: None,
                condition_id: condition_id.clone(),
                facts: facts(now),
            },
            other => panic!("unexpected directive {other:?}"),
        };
        output = engine.submit(input).expect("submit");
    }
    assert_eq!(engine.state().as_str(), "SUCCEEDED");
    let events = engine.events();
    for (index, event) in events.iter().enumerate() {
        assert_eq!(event.seq, index as u64 + 1);
    }
    assert_eq!(events.last().unwrap().event_type, "RunFinished");
}

#[test]
fn five_hundred_runs_are_stable() {
    for index in 0..50 {
        one_run(index);
    }
    let before = rss_kb();
    for index in 50..550 {
        one_run(index);
    }
    let after = rss_kb();
    let growth = after.saturating_sub(before);
    println!("soak rss_before_kb={before} rss_after_kb={after} growth_kb={growth}");
    assert!(growth < 100 * 1024, "resident memory grew by {growth} KiB");
}
