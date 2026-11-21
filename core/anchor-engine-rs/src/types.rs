//! Anchor scoring types shared with the runtime IR.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct NormRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Viewport {
    pub w: f64,
    pub h: f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SemanticAnchor {
    pub role: Option<String>,
    pub name: Option<String>,
    pub label: Option<String>,
    pub placeholder: Option<String>,
    pub test_id: Option<String>,
    pub control_type: Option<String>,
    pub text: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct StructureAnchor {
    pub path: Option<Vec<String>>,
    pub parent: Option<String>,
    pub container: Option<String>,
    pub sibling_index: Option<u32>,
    pub sibling_count: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct NativeIdentity {
    pub kind: String,
    pub value: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct VisualAnchor {
    pub dhash: Option<String>,
    pub template_hash: Option<String>,
    pub norm_rect: Option<NormRect>,
    pub viewport: Option<Viewport>,
    pub device_scale: Option<f64>,
    pub style_signature: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Anchors {
    pub semantic: Option<SemanticAnchor>,
    pub structure: Option<StructureAnchor>,
    pub native_identity: Option<NativeIdentity>,
    pub visual: Option<VisualAnchor>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ConfidencePolicy {
    pub mode: Option<String>,
    pub min_score: Option<f64>,
    pub ambiguity_margin: Option<f64>,
    pub visual_only_requires_confirmation: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Target {
    pub anchors: Anchors,
    pub fallback_bounds: Option<Rect>,
    pub confidence: Option<ConfidencePolicy>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CandidateSemantic {
    pub role: Option<String>,
    pub name: Option<String>,
    pub label: Option<String>,
    pub placeholder: Option<String>,
    pub test_id: Option<String>,
    pub control_type: Option<String>,
    pub text: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CandidateStructure {
    pub path: Option<Vec<String>>,
    pub parent: Option<String>,
    pub container: Option<String>,
    pub sibling_index: Option<u32>,
    pub sibling_count: Option<u32>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CandidateVisual {
    pub dhash: Option<String>,
    pub norm_rect: Option<NormRect>,
    pub viewport: Option<Viewport>,
    pub device_scale: Option<f64>,
    pub style_signature: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CandidateContext {
    pub app_scope: Option<String>,
    pub window_title: Option<String>,
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Candidate {
    pub candidate_id: String,
    pub native_identity: Option<NativeIdentity>,
    pub semantic: Option<CandidateSemantic>,
    pub structure: Option<CandidateStructure>,
    pub visual: Option<CandidateVisual>,
    pub context: Option<CandidateContext>,
    #[serde(default)]
    pub visible: bool,
    #[serde(default)]
    pub enabled: bool,
    pub editable: Option<bool>,
    pub stale: Option<bool>,
    pub in_viewport: Option<bool>,
    pub rect: Option<Rect>,
    pub text: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Evidence {
    pub native: f64,
    pub semantic: f64,
    pub structure: f64,
    pub visual: f64,
    pub context: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RankedCandidate {
    pub candidate: Candidate,
    pub total: f64,
    pub evidence: Evidence,
    pub reasons: Vec<String>,
    pub eligible: bool,
    pub auto_eligible: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConfirmReason {
    Ambiguous,
    LowConfidence,
    VisualOnly,
    NativeOnly,
    BoundsOnly,
    Stale,
}

impl ConfirmReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Ambiguous => "ambiguous",
            Self::LowConfidence => "low_confidence",
            Self::VisualOnly => "visual_only",
            Self::NativeOnly => "native_only",
            Self::BoundsOnly => "bounds_only",
            Self::Stale => "stale",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Decision {
    /// A unique, sufficiently evidenced candidate may execute without asking.
    Auto,
    /// A candidate exists but requires human confirmation.
    Confirm(ConfirmReason),
    NotFound,
}

#[derive(Debug, Clone)]
pub struct AnchorConfig {
    pub min_score: f64,
    pub ambiguity_margin: f64,
    pub min_semantic_score: f64,
    /// Semantic evidence required to auto-execute when a native id matches.
    pub min_semantic_for_native_auto: f64,
    pub allow_visual_only_auto: bool,
    pub strict: bool,
}

impl Default for AnchorConfig {
    fn default() -> Self {
        Self {
            min_score: 0.72,
            ambiguity_margin: 0.08,
            min_semantic_score: 0.15,
            min_semantic_for_native_auto: 0.60,
            allow_visual_only_auto: false,
            strict: false,
        }
    }
}

#[derive(Debug, Clone)]
pub struct Ranking {
    /// Sorted by total descending; rejected candidates keep eligible=false.
    pub ranked: Vec<RankedCandidate>,
    pub decision: Decision,
}

pub fn effective_config(target: &Target, base: &AnchorConfig) -> AnchorConfig {
    let mut config = base.clone();
    if let Some(policy) = &target.confidence {
        if let Some(min) = policy.min_score {
            config.min_score = min.clamp(0.0, 1.0);
        }
        if let Some(margin) = policy.ambiguity_margin {
            config.ambiguity_margin = margin.clamp(0.0, 1.0);
        }
        if let Some(mode) = &policy.mode {
            config.strict = mode == "strict";
        }
        if let Some(visual) = policy.visual_only_requires_confirmation {
            config.allow_visual_only_auto = !visual;
        }
    }
    config
}
