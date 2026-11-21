//! Condition evaluation. The engine (not the host) decides whether a condition
//! holds, so the same Action IR has identical semantics on every platform.

use crate::ir::Condition;
use ib_anchor::{rank, AnchorConfig, Candidate};
use regex::Regex;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Facts {
    pub now_mono_ms: Option<f64>,
    pub app_scope: Option<String>,
    pub url: Option<String>,
    pub window_title: Option<String>,
    pub window_stable_ms: Option<f64>,
    pub elements: Option<Vec<Candidate>>,
    pub variable_values: Option<BTreeMap<String, Value>>,
    pub text: Option<String>,
    pub foreground: Option<bool>,
    pub evidence_ref: Option<String>,
}

pub struct EvalContext<'a> {
    pub facts: &'a Facts,
    pub variables: &'a BTreeMap<String, Value>,
    pub anchor: &'a AnchorConfig,
    pub scope: Option<&'a str>,
}

#[derive(Debug, Clone)]
pub struct EvalOutcome {
    pub satisfied: bool,
    pub detail: Value,
}

fn norm(text: &str, case_sensitive: bool) -> String {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if case_sensitive {
        collapsed
    } else {
        collapsed.to_lowercase()
    }
}

fn glob_to_regex(pattern: &str) -> String {
    let mut out = String::from("^");
    for ch in pattern.chars() {
        match ch {
            '*' => out.push_str(".*"),
            '?' => out.push('.'),
            other => out.push_str(&regex::escape(&other.to_string())),
        }
    }
    out.push('$');
    out
}

pub fn text_matches(
    observed: &str,
    matcher_type: &str,
    pattern: &str,
    case_sensitive: bool,
) -> bool {
    let observed_n = norm(observed, case_sensitive);
    let pattern_n = norm(pattern, case_sensitive);
    match matcher_type {
        "equals" => observed_n == pattern_n,
        "contains" => !pattern_n.is_empty() && observed_n.contains(&pattern_n),
        "regex" => Regex::new(pattern)
            .map(|re| re.is_match(observed))
            .unwrap_or(false),
        "glob" => Regex::new(&glob_to_regex(&pattern_n))
            .map(|re| re.is_match(&observed_n))
            .unwrap_or(false),
        _ => false,
    }
}

fn candidate_text(candidate: &Candidate) -> Option<&str> {
    candidate
        .text
        .as_deref()
        .or_else(|| {
            candidate
                .semantic
                .as_ref()
                .and_then(|semantic| semantic.text.as_deref())
        })
        .or_else(|| {
            candidate
                .semantic
                .as_ref()
                .and_then(|semantic| semantic.name.as_deref())
        })
        .or_else(|| {
            candidate
                .semantic
                .as_ref()
                .and_then(|semantic| semantic.label.as_deref())
        })
}

pub fn evaluate(condition: &Condition, ctx: &EvalContext<'_>) -> EvalOutcome {
    let elements = ctx.facts.elements.clone().unwrap_or_default();
    match condition {
        Condition::ElementPresent { target } => {
            let ranking = rank(target, ctx.anchor, ctx.scope, &elements);
            let eligible = ranking.ranked.iter().filter(|item| item.eligible).count();
            EvalOutcome {
                satisfied: eligible > 0,
                detail: json!({ "kind": "element-present", "eligible": eligible }),
            }
        }
        Condition::ElementAbsent { target } => {
            let ranking = rank(target, ctx.anchor, ctx.scope, &elements);
            let eligible = ranking.ranked.iter().filter(|item| item.eligible).count();
            EvalOutcome {
                satisfied: eligible == 0,
                detail: json!({ "kind": "element-absent", "eligible": eligible }),
            }
        }
        Condition::TextMatches { target, matcher } => {
            let ranking = rank(target, ctx.anchor, ctx.scope, &elements);
            let case_sensitive = matcher.case_sensitive.unwrap_or(false);
            let mut matched_candidate = Value::Null;
            let mut satisfied = false;
            for item in ranking.ranked.iter().filter(|item| item.eligible) {
                if let Some(text) = candidate_text(&item.candidate) {
                    if text_matches(text, &matcher.matcher_type, &matcher.value, case_sensitive) {
                        satisfied = true;
                        matched_candidate = Value::String(item.candidate.candidate_id.clone());
                        break;
                    }
                }
            }
            EvalOutcome {
                satisfied,
                detail: json!({
                    "kind": "text-matches",
                    "matched_candidate": matched_candidate,
                    "eligible": ranking.ranked.iter().filter(|item| item.eligible).count(),
                }),
            }
        }
        Condition::WindowStable { min_stable_ms } => {
            let required = min_stable_ms.unwrap_or(300) as f64;
            let stable = ctx.facts.window_stable_ms.unwrap_or(0.0);
            EvalOutcome {
                satisfied: stable + 0.001 >= required,
                detail: json!({ "kind": "window-stable", "stable_ms": stable, "required_ms": required }),
            }
        }
        Condition::VariableCompare {
            variable,
            operator,
            value,
        } => {
            let observed = ctx
                .facts
                .variable_values
                .as_ref()
                .and_then(|values| values.get(variable))
                .or_else(|| ctx.variables.get(variable))
                .cloned();
            let satisfied = match (&observed, operator.as_str(), value) {
                (Some(observed), "equals", expected) => json_equal(observed, expected),
                (Some(observed), "not-equals", expected) => !json_equal(observed, expected),
                (Some(observed), "contains", Value::String(expected)) => observed
                    .as_str()
                    .map(|text| text.contains(expected))
                    .unwrap_or(false),
                (Some(observed), "matches", Value::String(pattern)) => observed
                    .as_str()
                    .map(|text| {
                        Regex::new(pattern)
                            .map(|re| re.is_match(text))
                            .unwrap_or(false)
                    })
                    .unwrap_or(false),
                (Some(observed), op @ ("gt" | "gte" | "lt" | "lte"), expected) => {
                    match (as_f64(observed), as_f64(expected)) {
                        (Some(a), Some(b)) => match op {
                            "gt" => a > b,
                            "gte" => a >= b,
                            "lt" => a < b,
                            "lte" => a <= b,
                            _ => false,
                        },
                        _ => false,
                    }
                }
                _ => false,
            };
            EvalOutcome {
                satisfied,
                detail: json!({
                    "kind": "variable-compare",
                    "variable": variable,
                    "observed_type": observed.as_ref().map(value_type_name),
                    "operator": operator,
                }),
            }
        }
        Condition::UrlMatches {
            pattern,
            match_type,
        } => {
            let url = ctx.facts.url.clone().unwrap_or_default();
            let satisfied = text_matches(
                &url,
                match_type.as_deref().unwrap_or("contains"),
                pattern,
                false,
            );
            EvalOutcome {
                satisfied,
                detail: json!({ "kind": "url-matches", "matched": satisfied }),
            }
        }
        Condition::AppInForeground { value } => {
            let observed = ctx
                .facts
                .app_scope
                .clone()
                .or_else(|| ctx.facts.window_title.clone())
                .unwrap_or_default();
            let satisfied = observed
                .trim_end_matches('/')
                .eq_ignore_ascii_case(value.trim_end_matches('/'));
            EvalOutcome {
                satisfied,
                detail: json!({ "kind": "app-in-foreground", "matched": satisfied }),
            }
        }
    }
}

fn value_type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn json_equal(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::String(a), Value::String(b)) => norm(a, false) == norm(b, false),
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        _ => left == right,
    }
}

fn as_f64(value: &Value) -> Option<f64> {
    match value {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.trim().parse::<f64>().ok(),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn matcher_variants() {
        assert!(text_matches("Hello World", "equals", "hello world", false));
        assert!(!text_matches("Hello World", "equals", "hello world", true));
        assert!(text_matches("Hello World", "contains", "world", false));
        assert!(text_matches("order-42", "regex", r"order-\d+", false));
        assert!(text_matches("order-42", "glob", "order-*", false));
    }

    #[test]
    fn variable_comparison() {
        let variables = BTreeMap::from([("count".to_string(), json!(3))]);
        let facts = Facts::default();
        let ctx = EvalContext {
            facts: &facts,
            variables: &variables,
            anchor: &AnchorConfig::default(),
            scope: None,
        };
        let outcome = evaluate(
            &Condition::VariableCompare {
                variable: "count".into(),
                operator: "gte".into(),
                value: json!(3),
            },
            &ctx,
        );
        assert!(outcome.satisfied);
    }
}
