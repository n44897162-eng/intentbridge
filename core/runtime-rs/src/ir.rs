//! Action IR (v1.0.0) typed model + defense-in-depth semantic validation.
//!
//! The TypeScript validator is the authoritative JSON Schema gate at import
//! time. This validator re-checks every safety-critical rule at the engine
//! boundary so a compromised or stale producer cannot bypass safety.

use ib_anchor::Target;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

pub const FLOW_SCHEMA_VERSION: &str = "1.0.0";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Flow {
    pub schema_version: String,
    pub flow_id: String,
    pub name: String,
    pub description: Option<String>,
    pub platform: String,
    pub app_scope: AppScope,
    pub variables: Vec<Variable>,
    pub permissions: Vec<String>,
    pub steps: Vec<Step>,
    pub created_by: String,
    pub revision: u64,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub labels: Option<BTreeMap<String, String>>,
    pub notes: Option<String>,
    pub defaults: Option<Defaults>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AppScope {
    pub kind: String,
    pub value: String,
    pub window_title: Option<String>,
    pub process_name: Option<String>,
    pub activity_hint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Variable {
    pub name: String,
    #[serde(rename = "type")]
    pub var_type: String,
    pub required: Option<bool>,
    pub sensitive: Option<bool>,
    pub description: Option<String>,
    pub default: Option<Value>,
    pub pattern: Option<String>,
    pub min_length: Option<u64>,
    pub max_length: Option<u64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Defaults {
    pub timeout_ms: Option<u64>,
    pub retry: Option<RetryPolicy>,
    pub evidence_policy: Option<EvidencePolicy>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RetryPolicy {
    pub max_attempts: Option<u64>,
    pub backoff_ms: Option<u64>,
    pub max_backoff_ms: Option<u64>,
    pub jitter_ratio: Option<f64>,
    pub idempotency_key: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EvidencePolicy {
    pub capture: Option<String>,
    pub save_on: Option<String>,
    pub retention_days: Option<u64>,
    pub mask_selectors: Option<Vec<String>>,
    pub mask_text: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum OnFailure {
    Mode(String),
    Detailed {
        mode: String,
        goto_step_id: Option<String>,
    },
}

impl OnFailure {
    pub fn mode(&self) -> &str {
        match self {
            Self::Mode(mode) => mode,
            Self::Detailed { mode, .. } => mode,
        }
    }
    pub fn goto(&self) -> Option<&str> {
        match self {
            Self::Mode(_) => None,
            Self::Detailed { goto_step_id, .. } => goto_step_id.as_deref(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Step {
    pub id: String,
    pub action: Action,
    pub name: Option<String>,
    pub description: Option<String>,
    pub target: Option<Target>,
    #[serde(default)]
    pub preconditions: Vec<Condition>,
    #[serde(default)]
    pub postconditions: Vec<Condition>,
    pub timeout_ms: Option<u64>,
    pub retry: Option<RetryPolicy>,
    pub on_failure: Option<OnFailure>,
    pub risk: Option<String>,
    pub evidence_policy: Option<EvidencePolicy>,
    pub compensation_step_id: Option<String>,
    pub params: Option<Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Action {
    Launch,
    Activate,
    Wait,
    Click,
    Input,
    Select,
    Scroll,
    ReadText,
    Assert,
    SetVariable,
    Branch,
    Compensate,
    End,
}

impl Action {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Launch => "launch",
            Self::Activate => "activate",
            Self::Wait => "wait",
            Self::Click => "click",
            Self::Input => "input",
            Self::Select => "select",
            Self::Scroll => "scroll",
            Self::ReadText => "read-text",
            Self::Assert => "assert",
            Self::SetVariable => "set-variable",
            Self::Branch => "branch",
            Self::Compensate => "compensate",
            Self::End => "end",
        }
    }

    pub fn is_mutating(&self) -> bool {
        matches!(
            self,
            Self::Click | Self::Input | Self::Select | Self::Scroll | Self::Launch
        )
    }

    pub fn is_read_only(&self) -> bool {
        matches!(
            self,
            Self::Wait | Self::ReadText | Self::Assert | Self::Activate
        )
    }

    pub fn required_permissions(&self) -> &'static [&'static str] {
        match self {
            Self::Launch => &["launch"],
            Self::Activate | Self::Wait | Self::ReadText | Self::Assert => &["read-ui"],
            Self::Click => &["click"],
            Self::Input => &["type"],
            Self::Select => &["select"],
            Self::Scroll => &["scroll"],
            Self::SetVariable | Self::Branch | Self::Compensate | Self::End => &[],
        }
    }

    pub fn needs_target(&self) -> bool {
        matches!(
            self,
            Self::Click | Self::Input | Self::Select | Self::ReadText
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Matcher {
    #[serde(rename = "type")]
    pub matcher_type: String,
    pub value: String,
    pub case_sensitive: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Condition {
    ElementPresent {
        target: Target,
    },
    ElementAbsent {
        target: Target,
    },
    TextMatches {
        target: Target,
        matcher: Matcher,
    },
    WindowStable {
        min_stable_ms: Option<u64>,
    },
    VariableCompare {
        variable: String,
        operator: String,
        value: Value,
    },
    UrlMatches {
        pattern: String,
        match_type: Option<String>,
    },
    AppInForeground {
        value: String,
    },
}

impl Condition {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::ElementPresent { .. } => "element-present",
            Self::ElementAbsent { .. } => "element-absent",
            Self::TextMatches { .. } => "text-matches",
            Self::WindowStable { .. } => "window-stable",
            Self::VariableCompare { .. } => "variable-compare",
            Self::UrlMatches { .. } => "url-matches",
            Self::AppInForeground { .. } => "app-in-foreground",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ValidationIssue {
    pub severity: String,
    pub code: String,
    pub rule: String,
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone)]
pub struct ValidationLimits {
    pub max_steps: usize,
    pub max_step_timeout_ms: u64,
}

impl Default for ValidationLimits {
    fn default() -> Self {
        Self {
            max_steps: 100,
            max_step_timeout_ms: 120_000,
        }
    }
}

pub fn secret_ref(value: &str) -> Option<&str> {
    let rest = value.strip_prefix("secret://")?;
    let mut chars = rest.chars();
    let first = chars.next()?;
    if !first.is_ascii_lowercase() {
        return None;
    }
    if !rest
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-'))
    {
        return None;
    }
    if rest.len() > 64 {
        return None;
    }
    Some(rest)
}

pub fn template_refs(text: &str) -> Vec<String> {
    let mut refs = Vec::new();
    let bytes = text.as_bytes();
    let mut index = 0;
    while index + 2 < bytes.len() {
        if bytes[index] == b'$' && bytes[index + 1] == b'{' {
            let start = index + 2;
            let mut end = start;
            while end < bytes.len() && bytes[end] != b'}' {
                end += 1;
            }
            if end < bytes.len() && end > start {
                let name = &text[start..end];
                if name.chars().enumerate().all(|(i, c)| {
                    (i == 0 && c.is_ascii_alphabetic())
                        || (i > 0 && (c.is_ascii_alphanumeric() || c == '_'))
                }) {
                    refs.push(name.to_string());
                }
            }
            index = end;
        }
        index += 1;
    }
    refs
}

fn walk_strings<'a>(value: &'a Value, path: &str, out: &mut Vec<(String, &'a str)>) {
    match value {
        Value::String(text) => out.push((path.to_string(), text)),
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                walk_strings(item, &format!("{path}/{index}"), out);
            }
        }
        Value::Object(map) => {
            for (key, item) in map {
                walk_strings(item, &format!("{path}/{key}"), out);
            }
        }
        _ => {}
    }
}

fn allowed_param_keys(action: Action) -> &'static [&'static str] {
    match action {
        Action::Launch => &["app_id", "url", "arguments", "wait_ready"],
        Action::Activate => &["url_pattern", "window_title", "process_name"],
        Action::Wait => &["condition", "poll_interval_ms"],
        Action::Click => &["button", "click_count", "modifiers", "verify_enabled"],
        Action::Input => &["value", "clear_first", "submit", "typing_delay_ms"],
        Action::Select => &["value", "by"],
        Action::Scroll => &["direction", "amount", "max_attempts", "boundary_condition"],
        Action::ReadText => &["output_variable", "max_chars", "sensitive"],
        Action::Assert => &["condition", "message"],
        Action::SetVariable => &["name", "value", "sensitive"],
        Action::Branch => &["condition", "goto_step_id", "else_step_id"],
        Action::Compensate => &["compensation_step_id", "reason"],
        Action::End => &["status", "message"],
    }
}

fn diag(
    out: &mut Vec<ValidationIssue>,
    severity: &str,
    code: &str,
    rule: &str,
    path: &str,
    message: String,
) {
    out.push(ValidationIssue {
        severity: severity.to_string(),
        code: code.to_string(),
        rule: rule.to_string(),
        path: path.to_string(),
        message,
    });
}

fn is_valid_uuid(value: &str) -> bool {
    let parts: Vec<&str> = value.split('-').collect();
    if parts.len() != 5 {
        return false;
    }
    let lens = [8usize, 4, 4, 4, 12];
    parts
        .iter()
        .zip(lens)
        .all(|(part, len)| part.len() == len && part.chars().all(|c| c.is_ascii_hexdigit()))
}

fn is_android_package(value: &str) -> bool {
    let parts: Vec<&str> = value.split('.').collect();
    parts.len() >= 2
        && parts.iter().all(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) if first.is_ascii_alphabetic() || first == '_' => {
                    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
                }
                _ => false,
            }
        })
}

pub fn parse_origin(url: &str) -> Option<String> {
    let scheme_end = url.find("://")?;
    let scheme = &url[..scheme_end];
    if scheme != "http" && scheme != "https" {
        return None;
    }
    let rest = &url[scheme_end + 3..];
    if rest.is_empty() {
        return None;
    }
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let host = &rest[..end];
    if host.is_empty() || host.contains('@') {
        return None;
    }
    Some(format!("{}://{}", scheme, host).to_lowercase())
}

fn password_hint(text: &str) -> bool {
    let lower = text.to_lowercase();
    lower.contains("password")
        || lower.contains("passwd")
        || lower.contains("pin")
        || lower.contains("otp")
        || lower.contains("密码")
        || lower.contains("口令")
        || lower.contains("验证码")
}

fn looks_like_plaintext_secret(text: &str) -> bool {
    text.contains("-----BEGIN ") || text.contains("AKIA") || text.contains("Bearer ")
}

/// Defense-in-depth validation. Returns every issue; execution is allowed only
/// when no issue has severity "error".
pub fn validate_flow(
    flow: &Flow,
    for_execution: bool,
    limits: &ValidationLimits,
) -> Vec<ValidationIssue> {
    let mut issues = Vec::new();
    if flow.schema_version != FLOW_SCHEMA_VERSION {
        diag(
            &mut issues,
            "error",
            "INVALID_IR",
            "flow.schema-version",
            "/schema_version",
            format!("unsupported schema_version {}", flow.schema_version),
        );
    }
    if !is_valid_uuid(&flow.flow_id) {
        diag(
            &mut issues,
            "error",
            "INVALID_IR",
            "flow.flow-id",
            "/flow_id",
            "flow_id must be a UUID".into(),
        );
    }
    if flow.revision == 0 {
        diag(
            &mut issues,
            "error",
            "INVALID_IR",
            "flow.revision",
            "/revision",
            "revision must be >= 1".into(),
        );
    }
    let expected_kind = match flow.platform.as_str() {
        "web" => "web-origin",
        "windows" => "windows-app",
        "android" => "android-package",
        other => {
            diag(
                &mut issues,
                "error",
                "INVALID_IR",
                "flow.platform",
                "/platform",
                format!("unsupported platform {other}"),
            );
            ""
        }
    };
    if flow.app_scope.kind != expected_kind {
        diag(
            &mut issues,
            "error",
            "INVALID_IR",
            "app-scope.kind-mismatch",
            "/app_scope/kind",
            format!(
                "platform {} requires app_scope.kind={expected_kind}",
                flow.platform
            ),
        );
    }
    match flow.platform.as_str() {
        "web" => match parse_origin(&flow.app_scope.value) {
            Some(origin) => {
                if origin != flow.app_scope.value.trim_end_matches('/').to_lowercase() {
                    diag(
                        &mut issues,
                        "error",
                        "INVALID_IR",
                        "app-scope.not-an-origin",
                        "/app_scope/value",
                        "web app_scope must be a bare origin".into(),
                    );
                }
                if origin.starts_with("http://")
                    && !origin.contains("127.0.0.1")
                    && !origin.contains("localhost")
                    && !origin.contains("[::1]")
                {
                    diag(
                        &mut issues,
                        "error",
                        "UNSAFE_FLOW",
                        "app-scope.insecure-origin",
                        "/app_scope/value",
                        "plain http only for loopback".into(),
                    );
                }
            }
            None => diag(
                &mut issues,
                "error",
                "INVALID_IR",
                "app-scope.invalid-url",
                "/app_scope/value",
                "invalid web origin".into(),
            ),
        },
        "windows" => {
            if flow
                .app_scope
                .process_name
                .as_deref()
                .unwrap_or("")
                .is_empty()
            {
                diag(
                    &mut issues,
                    "error",
                    "INVALID_IR",
                    "app-scope.windows-process",
                    "/app_scope/process_name",
                    "windows flows must pin process_name".into(),
                );
            }
        }
        "android" => {
            if !is_android_package(&flow.app_scope.value) {
                diag(
                    &mut issues,
                    "error",
                    "INVALID_IR",
                    "app-scope.android-package",
                    "/app_scope/value",
                    "invalid android package".into(),
                );
            }
        }
        _ => {}
    }

    let mut variable_names: BTreeSet<String> = BTreeSet::new();
    for (index, variable) in flow.variables.iter().enumerate() {
        let path = format!("/variables/{index}");
        if !variable_names.insert(variable.name.clone()) {
            diag(
                &mut issues,
                "error",
                "INVALID_IR",
                "variable.duplicate",
                &format!("{path}/name"),
                "duplicate variable".into(),
            );
        }
        if !matches!(
            variable.var_type.as_str(),
            "string" | "number" | "boolean" | "date"
        ) {
            diag(
                &mut issues,
                "error",
                "INVALID_IR",
                "variable.type",
                &format!("{path}/type"),
                "unsupported variable type".into(),
            );
        }
        if variable.sensitive.unwrap_or(false) && variable.default.is_some() {
            diag(
                &mut issues,
                "error",
                "UNSAFE_FLOW",
                "variable.sensitive-default",
                &format!("{path}/default"),
                "sensitive variable must not have a default".into(),
            );
        }
        if let (Some(min), Some(max)) = (variable.min_length, variable.max_length) {
            if min > max {
                diag(
                    &mut issues,
                    "error",
                    "INVALID_IR",
                    "variable.length-range",
                    &path,
                    "min_length > max_length".into(),
                );
            }
        }
    }

    let permissions: BTreeSet<&str> = flow.permissions.iter().map(String::as_str).collect();
    let captures = flow.steps.iter().any(|step| {
        step.evidence_policy
            .as_ref()
            .and_then(|policy| policy.capture.as_deref())
            .or_else(|| {
                flow.defaults
                    .as_ref()
                    .and_then(|defaults| defaults.evidence_policy.as_ref())
                    .and_then(|policy| policy.capture.as_deref())
            })
            .unwrap_or("target")
            != "none"
    });
    if captures && !permissions.contains("read-screen") {
        diag(
            &mut issues,
            "error",
            "INVALID_IR",
            "flow.permission-read-screen",
            "/permissions",
            "read-screen required for evidence capture".into(),
        );
    }
    if flow.steps.iter().any(|step| step.target.is_some()) && !permissions.contains("read-ui") {
        diag(
            &mut issues,
            "error",
            "INVALID_IR",
            "flow.permission-read-ui",
            "/permissions",
            "read-ui required to observe UI".into(),
        );
    }

    let mut step_ids: BTreeSet<String> = BTreeSet::new();
    for (index, step) in flow.steps.iter().enumerate() {
        let base = format!("/steps/{index}");
        if !step_ids.insert(step.id.clone()) {
            diag(
                &mut issues,
                "error",
                "INVALID_IR",
                "step.duplicate-id",
                &format!("{base}/id"),
                "duplicate step id".into(),
            );
        }
        for permission in step.action.required_permissions() {
            if !permissions.contains(*permission) {
                diag(
                    &mut issues,
                    "error",
                    "INVALID_IR",
                    "step.permission-missing",
                    &format!("{base}/action"),
                    format!(
                        "action {} requires permission {}",
                        step.action.as_str(),
                        permission
                    ),
                );
            }
        }
        if step.action.needs_target() && step.target.is_none() {
            diag(
                &mut issues,
                "error",
                "INVALID_IR",
                "step.target-required",
                &format!("{base}/target"),
                format!("{} needs a target", step.action.as_str()),
            );
        }
        if step.action.is_mutating() && step.postconditions.is_empty() {
            diag(
                &mut issues,
                "error",
                "INVALID_IR",
                "step.missing-postcondition",
                &format!("{base}/postconditions"),
                format!(
                    "{} must declare an observable postcondition",
                    step.action.as_str()
                ),
            );
        }
        if step
            .timeout_ms
            .or(flow
                .defaults
                .as_ref()
                .and_then(|defaults| defaults.timeout_ms))
            .unwrap_or(30_000)
            > limits.max_step_timeout_ms
        {
            diag(
                &mut issues,
                "error",
                "INVALID_IR",
                "step.timeout-exceeds-cap",
                &format!("{base}/timeout_ms"),
                "step timeout exceeds cap".into(),
            );
        }
        if let Some(retry) = &step.retry {
            if let Some(max) = retry.max_attempts {
                if !(1..=3).contains(&max) {
                    diag(
                        &mut issues,
                        "error",
                        "INVALID_IR",
                        "step.retry-range",
                        &format!("{base}/retry/max_attempts"),
                        "max_attempts must be 1..=3".into(),
                    );
                }
            }
        }
        if let Some(on_failure) = &step.on_failure {
            if !matches!(on_failure.mode(), "stop" | "ask-user" | "goto-step") {
                diag(
                    &mut issues,
                    "error",
                    "INVALID_IR",
                    "step.on-failure-mode",
                    &format!("{base}/on_failure"),
                    "invalid on_failure mode".into(),
                );
            }
            if on_failure.mode() == "goto-step" && on_failure.goto().is_none() {
                diag(
                    &mut issues,
                    "error",
                    "INVALID_IR",
                    "step.goto-missing",
                    &format!("{base}/on_failure"),
                    "goto-step needs goto_step_id".into(),
                );
            }
        }
        if step.compensation_step_id.as_deref() == Some(step.id.as_str()) {
            diag(
                &mut issues,
                "error",
                "INVALID_IR",
                "step.compensation-self",
                &format!("{base}/compensation_step_id"),
                "a step cannot compensate itself".into(),
            );
        }

        // Params: per-action allowed keys, required fields and simple types.
        if let Some(params) = &step.params {
            if !params.is_object() {
                diag(
                    &mut issues,
                    "error",
                    "INVALID_IR",
                    "params.not-object",
                    &format!("{base}/params"),
                    "params must be an object".into(),
                );
            } else {
                let allowed = allowed_param_keys(step.action);
                if let Some(object) = params.as_object() {
                    for key in object.keys() {
                        if !allowed.contains(&key.as_str()) {
                            diag(
                                &mut issues,
                                "error",
                                "INVALID_IR",
                                "params.unknown-key",
                                &format!("{base}/params/{key}"),
                                format!(
                                    "parameter {key} is not valid for {}",
                                    step.action.as_str()
                                ),
                            );
                        }
                    }
                }
                let requirement: &[&str] = match step.action {
                    Action::Launch => &["app_id"],
                    Action::Wait => &["condition"],
                    Action::Input => &["value"],
                    Action::Select => &["value"],
                    Action::Scroll => &["direction", "boundary_condition"],
                    Action::ReadText => &["output_variable"],
                    Action::Assert => &["condition"],
                    Action::SetVariable => &["name", "value"],
                    Action::Branch => &["condition", "goto_step_id"],
                    Action::Compensate => &["compensation_step_id"],
                    Action::End => &["status"],
                    _ => &[],
                };
                for required in requirement {
                    if params.get(*required).is_none() {
                        diag(
                            &mut issues,
                            "error",
                            "INVALID_IR",
                            "params.missing-field",
                            &format!("{base}/params"),
                            format!("missing required parameter {required}"),
                        );
                    }
                }
                match step.action {
                    Action::Input => {
                        if let Some(value) = params.get("value") {
                            if !value.is_string() {
                                diag(
                                    &mut issues,
                                    "error",
                                    "INVALID_IR",
                                    "params.type",
                                    &format!("{base}/params/value"),
                                    "input value must be a string".into(),
                                );
                            }
                        }
                    }
                    Action::ReadText => {
                        if let Some(value) = params.get("output_variable") {
                            if !value.is_string() {
                                diag(
                                    &mut issues,
                                    "error",
                                    "INVALID_IR",
                                    "params.type",
                                    &format!("{base}/params/output_variable"),
                                    "output_variable must be a string".into(),
                                );
                            }
                        }
                    }
                    Action::End => {
                        if !matches!(
                            params.get("status").and_then(Value::as_str),
                            Some("success") | Some("failed")
                        ) {
                            diag(
                                &mut issues,
                                "error",
                                "INVALID_IR",
                                "params.type",
                                &format!("{base}/params/status"),
                                "end status must be success or failed".into(),
                            );
                        }
                    }
                    Action::Scroll => {
                        if !matches!(
                            params.get("direction").and_then(Value::as_str),
                            Some("up") | Some("down") | Some("left") | Some("right")
                        ) {
                            diag(
                                &mut issues,
                                "error",
                                "INVALID_IR",
                                "params.type",
                                &format!("{base}/params/direction"),
                                "invalid scroll direction".into(),
                            );
                        }
                        let attempts = params
                            .get("max_attempts")
                            .and_then(Value::as_u64)
                            .unwrap_or(5);
                        if !(1..=20).contains(&attempts) {
                            diag(
                                &mut issues,
                                "error",
                                "INVALID_IR",
                                "step.scroll-attempts",
                                &format!("{base}/params/max_attempts"),
                                "max_attempts must be 1..=20".into(),
                            );
                        }
                    }
                    Action::Branch => {
                        for key in ["goto_step_id", "else_step_id"] {
                            if let Some(value) = params.get(key) {
                                if !value.is_string() {
                                    diag(
                                        &mut issues,
                                        "error",
                                        "INVALID_IR",
                                        "params.type",
                                        &format!("{base}/params/{key}"),
                                        format!("{key} must be a string"),
                                    );
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
        } else if !matches!(step.action, Action::Click | Action::Activate) {
            diag(
                &mut issues,
                "error",
                "INVALID_IR",
                "params.missing",
                &format!("{base}/params"),
                "action requires params".into(),
            );
        }

        if let Some(risk) = &step.risk {
            if !matches!(risk.as_str(), "normal" | "sensitive" | "irreversible") {
                diag(
                    &mut issues,
                    "error",
                    "INVALID_IR",
                    "step.risk",
                    &format!("{base}/risk"),
                    "invalid risk level".into(),
                );
            }
        }
        if let Some(policy) = &step.evidence_policy {
            if let Some(capture) = &policy.capture {
                if !matches!(capture.as_str(), "none" | "target" | "viewport") {
                    diag(
                        &mut issues,
                        "error",
                        "INVALID_IR",
                        "evidence.capture",
                        &format!("{base}/evidence_policy/capture"),
                        "invalid capture policy".into(),
                    );
                }
            }
            if let Some(save_on) = &policy.save_on {
                if !matches!(save_on.as_str(), "failure" | "always" | "never") {
                    diag(
                        &mut issues,
                        "error",
                        "INVALID_IR",
                        "evidence.save-on",
                        &format!("{base}/evidence_policy/save_on"),
                        "invalid save_on policy".into(),
                    );
                }
            }
        }

        // Password / secret heuristics.
        let hint_text = step
            .target
            .as_ref()
            .and_then(|target| target.anchors.semantic.as_ref())
            .map(|semantic| {
                [
                    semantic.name.as_deref(),
                    semantic.label.as_deref(),
                    semantic.placeholder.as_deref(),
                ]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join(" ")
            })
            .unwrap_or_default();
        if step.action == Action::Input {
            let value = step
                .params
                .as_ref()
                .and_then(|params| params.get("value"))
                .and_then(Value::as_str)
                .unwrap_or("");
            if password_hint(&hint_text) && secret_ref(value).is_none() {
                let valid_template = value.starts_with("${")
                    && value.ends_with('}')
                    && !value[2..value.len().saturating_sub(1)].contains('}');
                let variable_name = if valid_template {
                    &value[2..value.len() - 1]
                } else {
                    ""
                };
                let sensitive_variable = flow
                    .variables
                    .iter()
                    .find(|variable| variable.name == variable_name)
                    .and_then(|variable| variable.sensitive)
                    .unwrap_or(false);
                if !sensitive_variable {
                    diag(
                        &mut issues,
                        "error",
                        "UNSAFE_FLOW",
                        "input.plaintext-password",
                        &format!("{base}/params/value"),
                        "password-like input must use secret://alias or a sensitive variable"
                            .into(),
                    );
                }
            }
        }
        let capture = step
            .evidence_policy
            .as_ref()
            .and_then(|policy| policy.capture.as_deref())
            .unwrap_or("target");
        let mask_text = step
            .evidence_policy
            .as_ref()
            .and_then(|policy| policy.mask_text)
            .unwrap_or(true);
        let sensitive_step = step
            .risk
            .as_deref()
            .map(|risk| risk != "normal")
            .unwrap_or(false)
            || password_hint(&hint_text);
        if sensitive_step && capture != "none" && !mask_text {
            diag(
                &mut issues,
                "error",
                "UNSAFE_FLOW",
                "step.evidence-leaks-sensitive",
                &format!("{base}/evidence_policy"),
                "sensitive step must mask or disable capture".into(),
            );
        }

        // Conditions: variable references.
        let mut conditions: Vec<Condition> = step
            .preconditions
            .iter()
            .chain(step.postconditions.iter())
            .cloned()
            .collect();
        if let Some(params) = &step.params {
            for key in ["condition", "boundary_condition"] {
                if let Some(condition) = params.get(key) {
                    if let Ok(condition) = serde_json::from_value::<Condition>(condition.clone()) {
                        conditions.push(condition);
                    }
                }
            }
        }
        for condition in &conditions {
            if let Condition::VariableCompare { variable, .. } = condition {
                if !variable_names.contains(variable) {
                    diag(
                        &mut issues,
                        "error",
                        "INVALID_IR",
                        "condition.unknown-variable",
                        &base,
                        format!("condition references undeclared variable {variable}"),
                    );
                }
            }
        }
    }

    // Cross-step references.
    for (index, step) in flow.steps.iter().enumerate() {
        let base = format!("/steps/{index}");
        let mut refs: Vec<(&str, String)> = Vec::new();
        if let Some(id) = &step.compensation_step_id {
            refs.push(("step.compensation-missing", id.clone()));
        }
        if let Some(on_failure) = &step.on_failure {
            if let Some(id) = on_failure.goto() {
                refs.push(("step.goto-missing-target", id.to_string()));
            }
        }
        if let Some(params) = &step.params {
            if let Some(id) = params.get("goto_step_id").and_then(Value::as_str) {
                refs.push(("branch.goto-missing-target", id.to_string()));
            }
            if let Some(id) = params.get("else_step_id").and_then(Value::as_str) {
                refs.push(("branch.else-missing-target", id.to_string()));
            }
            if let Some(id) = params.get("compensation_step_id").and_then(Value::as_str) {
                refs.push(("compensate.missing-target", id.to_string()));
            }
        }
        for (rule, id) in refs {
            if !step_ids.contains(&id) {
                diag(
                    &mut issues,
                    "error",
                    "INVALID_IR",
                    rule,
                    &base,
                    format!("referenced step {id} does not exist"),
                );
            }
        }
    }

    // Templates, secret placement and plaintext secret patterns.
    let flow_value = serde_json::to_value(flow).unwrap_or(Value::Null);
    let mut strings: Vec<(String, &str)> = Vec::new();
    walk_strings(&flow_value, "", &mut strings);
    for (path, text) in &strings {
        for name in template_refs(text) {
            if !variable_names.contains(&name) {
                diag(
                    &mut issues,
                    "error",
                    "INVALID_IR",
                    "template.unknown-variable",
                    path,
                    format!("template references undeclared variable {name}"),
                );
            }
        }
        if secret_ref(text).is_none() && looks_like_plaintext_secret(text) {
            diag(
                &mut issues,
                "error",
                "UNSAFE_FLOW",
                "flow.plaintext-secret",
                path,
                "possible plaintext secret detected".into(),
            );
        }
    }
    for (index, step) in flow.steps.iter().enumerate() {
        if let Ok(value) = serde_json::to_value(step) {
            let mut local = Vec::new();
            walk_strings(&value, "", &mut local);
            let has_secret = local.iter().any(|(_, text)| secret_ref(text).is_some());
            if has_secret && !matches!(step.action, Action::Input | Action::Select) {
                diag(
                    &mut issues,
                    "error",
                    "UNSAFE_FLOW",
                    "secret.invalid-placement",
                    &format!("/steps/{index}"),
                    "secret references only allowed in input/select values".into(),
                );
            }
        }
    }

    if for_execution {
        if flow.steps.is_empty() {
            diag(
                &mut issues,
                "error",
                "INVALID_IR",
                "flow.empty",
                "/steps",
                "runnable flow needs at least one step".into(),
            );
        }
        if flow.steps.len() > limits.max_steps {
            diag(
                &mut issues,
                "error",
                "INVALID_IR",
                "flow.too-many-steps",
                "/steps",
                "flow exceeds runtime step cap".into(),
            );
        }
        if !flow.steps.iter().any(|step| step.action == Action::End) {
            diag(
                &mut issues,
                "error",
                "INVALID_IR",
                "flow.missing-end",
                "/steps",
                "runnable flow needs an explicit end step".into(),
            );
        }
    }

    issues
}
