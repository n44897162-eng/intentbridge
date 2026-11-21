//! Deterministic evidence fusion. Pure functions: no clocks, no I/O, no model.

use crate::types::*;

pub const W_NATIVE: f64 = 0.50;
pub const W_SEMANTIC: f64 = 0.28;
pub const W_STRUCTURE: f64 = 0.14;
pub const W_VISUAL: f64 = 0.08;

/// Auto execution requires this much semantic evidence even with a native id:
/// an AutomationId alone can be recycled by a new control.
pub const MIN_SEMANTIC_FOR_NATIVE_AUTO: f64 = 0.60;
pub const MIN_SEMANTIC_STRENGTH: f64 = 1.5;

fn norm(value: &str) -> String {
    value
        .trim()
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn text_match(expected: &str, observed: &str) -> f64 {
    let expected = norm(expected);
    let observed = norm(observed);
    if expected.is_empty() || observed.is_empty() {
        return 0.0;
    }
    if expected == observed {
        return 1.0;
    }
    if expected.len() >= 3 && observed.contains(&expected) {
        return 0.8;
    }
    if observed.len() >= 3 && expected.contains(&observed) {
        return 0.6;
    }
    0.0
}

fn field_score(
    expected: &Option<String>,
    observed: &Option<String>,
    weight: f64,
    out: &mut f64,
    declared: &mut f64,
) {
    if let Some(expected) = expected {
        *declared += weight;
        if let Some(observed) = observed {
            *out += weight * text_match(expected, observed);
        }
    }
}

fn semantic_score(anchor: &SemanticAnchor, candidate: &CandidateSemantic) -> (f64, f64) {
    let mut matched = 0.0;
    let mut declared = 0.0;
    field_score(
        &anchor.test_id,
        &candidate.test_id,
        3.0,
        &mut matched,
        &mut declared,
    );
    field_score(
        &anchor.name,
        &candidate.name,
        2.5,
        &mut matched,
        &mut declared,
    );
    field_score(
        &anchor.placeholder,
        &candidate.placeholder,
        1.5,
        &mut matched,
        &mut declared,
    );
    field_score(
        &anchor.label,
        &candidate.label,
        1.5,
        &mut matched,
        &mut declared,
    );
    field_score(
        &anchor.control_type,
        &candidate.control_type,
        1.5,
        &mut matched,
        &mut declared,
    );
    field_score(
        &anchor.role,
        &candidate.role,
        1.0,
        &mut matched,
        &mut declared,
    );
    field_score(
        &anchor.text,
        &candidate.text,
        1.0,
        &mut matched,
        &mut declared,
    );
    if declared == 0.0 {
        (0.0, 0.0)
    } else {
        (matched / declared, declared)
    }
}

fn path_similarity(expected: &[String], observed: &[String]) -> f64 {
    if expected.is_empty() || observed.is_empty() {
        return 0.0;
    }
    let exp: Vec<String> = expected.iter().map(|s| norm(s)).collect();
    let obs: Vec<String> = observed.iter().map(|s| norm(s)).collect();
    if exp == obs {
        return 1.0;
    }
    let mut common_suffix = 0usize;
    while common_suffix < exp.len().min(obs.len())
        && exp[exp.len() - 1 - common_suffix] == obs[obs.len() - 1 - common_suffix]
    {
        common_suffix += 1;
    }
    let suffix_ratio = common_suffix as f64 / exp.len().max(obs.len()) as f64;
    let mut intersection = 0usize;
    let mut remaining = obs.clone();
    for token in &exp {
        if let Some(pos) = remaining.iter().position(|item| item == token) {
            intersection += 1;
            remaining.remove(pos);
        }
    }
    let union = exp.len() + obs.len() - intersection;
    let jaccard = if union == 0 {
        0.0
    } else {
        intersection as f64 / union as f64
    };
    0.7 * suffix_ratio + 0.3 * jaccard
}

fn structure_score(anchor: &StructureAnchor, candidate: &CandidateStructure) -> f64 {
    let mut matched = 0.0;
    let mut declared = 0.0;
    if let Some(path) = &anchor.path {
        declared += 3.0;
        if let Some(observed) = &candidate.path {
            matched += 3.0 * path_similarity(path, observed);
        }
    }
    for (expected, observed, weight) in [
        (&anchor.parent, &candidate.parent, 1.0),
        (&anchor.container, &candidate.container, 1.0),
    ] {
        if let Some(expected) = expected {
            declared += weight;
            if let Some(observed) = observed {
                matched += weight * text_match(expected, observed);
            }
        }
    }
    if let Some(index) = anchor.sibling_index {
        declared += 1.0;
        if let Some(observed) = candidate.sibling_index {
            let diff = (index as f64 - observed as f64).abs();
            matched += 1.0 * (1.0 / (1.0 + diff));
        }
    }
    if let Some(count) = anchor.sibling_count {
        declared += 0.5;
        if let Some(observed) = candidate.sibling_count {
            let diff = (count as f64 - observed as f64).abs();
            matched += 0.5 * (1.0 / (1.0 + diff));
        }
    }
    if declared == 0.0 {
        0.0
    } else {
        matched / declared
    }
}

fn hamming_similarity(expected: &str, observed: &str) -> Option<f64> {
    if expected.len() != observed.len() || expected.is_empty() {
        return None;
    }
    if expected.len() == 16 {
        if let (Ok(a), Ok(b)) = (
            u64::from_str_radix(expected, 16),
            u64::from_str_radix(observed, 16),
        ) {
            let bits = (a ^ b).count_ones() as f64;
            return Some(1.0 - bits / 64.0);
        }
    }
    let mut equal = 0usize;
    for (a, b) in expected.chars().zip(observed.chars()) {
        if a == b {
            equal += 1;
        }
    }
    Some(equal as f64 / expected.len() as f64)
}

fn rect_similarity(expected: &NormRect, observed: &NormRect) -> f64 {
    let ecx = expected.x + expected.w / 2.0;
    let ecy = expected.y + expected.h / 2.0;
    let ocx = observed.x + observed.w / 2.0;
    let ocy = observed.y + observed.h / 2.0;
    let center = ((ecx - ocx).powi(2) + (ecy - ocy).powi(2)).sqrt();
    let size = ((expected.w - observed.w).powi(2) + (expected.h - observed.h).powi(2)).sqrt();
    let distance = center + 0.5 * size;
    (1.0 - (distance / 0.45)).clamp(0.0, 1.0)
}

fn visual_score(anchor: &VisualAnchor, candidate: &CandidateVisual) -> f64 {
    let mut matched = 0.0;
    let mut declared = 0.0;
    if let Some(dhash) = &anchor.dhash {
        declared += 3.0;
        if let Some(observed) = &candidate.dhash {
            if let Some(similarity) = hamming_similarity(dhash, observed) {
                matched += 3.0 * similarity;
            }
        }
    }
    if let Some(rect) = &anchor.norm_rect {
        declared += 1.5;
        if let Some(observed) = &candidate.norm_rect {
            matched += 1.5 * rect_similarity(rect, observed);
        }
    }
    if let Some(signature) = &anchor.style_signature {
        declared += 1.0;
        if let Some(observed) = &candidate.style_signature {
            if norm(signature) == norm(observed) {
                matched += 1.0;
            }
        }
    }
    if declared == 0.0 {
        0.0
    } else {
        matched / declared
    }
}

fn candidate_scope(candidate: &Candidate) -> Option<String> {
    if let Some(context) = &candidate.context {
        if let Some(scope) = &context.app_scope {
            return Some(normalize_scope(scope));
        }
        if let Some(url) = &context.url {
            if let Some(origin) = origin_of(url) {
                return Some(origin);
            }
            return Some(normalize_scope(url));
        }
    }
    None
}

fn normalize_scope(scope: &str) -> String {
    scope.trim().trim_end_matches('/').to_lowercase()
}

fn origin_of(url: &str) -> Option<String> {
    let scheme_end = url.find("://")?;
    let rest = &url[scheme_end + 3..];
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let host = &rest[..end];
    if host.is_empty() {
        return None;
    }
    Some(format!("{}://{}", &url[..scheme_end], host).to_lowercase())
}

fn context_status(expected: Option<&str>, candidate: &Candidate) -> (f64, bool) {
    let Some(expected) = expected else {
        return (0.5, true);
    };
    let expected = normalize_scope(expected);
    match candidate_scope(candidate) {
        None => (0.5, true),
        Some(observed) => {
            let ok = observed == expected
                || observed.starts_with(&format!("{expected}/"))
                || expected.starts_with(&format!("{observed}/"));
            (if ok { 1.0 } else { 0.0 }, ok)
        }
    }
}

fn auto_gate(evidence: &Evidence, config: &AnchorConfig) -> Result<(), ConfirmReason> {
    let visual_only = evidence.native == 0.0 && evidence.semantic < 0.15;
    if visual_only && !config.allow_visual_only_auto {
        return Err(ConfirmReason::VisualOnly);
    }
    if config.strict {
        if evidence.native > 0.0
            && evidence.semantic >= config.min_semantic_for_native_auto
            && evidence.structure >= 0.0
        {
            return Ok(());
        }
        return Err(ConfirmReason::LowConfidence);
    }
    if evidence.native > 0.0 && evidence.semantic >= config.min_semantic_for_native_auto {
        return Ok(());
    }
    if evidence.semantic >= 0.70 && evidence.structure >= 0.60 {
        return Ok(());
    }
    if evidence.semantic >= 0.80 && evidence.structure >= 0.40 && evidence.visual >= 0.70 {
        return Ok(());
    }
    if evidence.native > 0.0 && evidence.semantic < config.min_semantic_for_native_auto {
        return Err(ConfirmReason::NativeOnly);
    }
    Err(ConfirmReason::LowConfidence)
}

/// Scores all candidates, filters unsafe ones, and decides whether a unique
/// candidate may auto-execute. Wrong-scope candidates are hard-rejected.
pub fn rank(
    target: &Target,
    config: &AnchorConfig,
    expected_scope: Option<&str>,
    candidates: &[Candidate],
) -> Ranking {
    let config = effective_config(target, config);
    let mut ranked: Vec<RankedCandidate> = candidates
        .iter()
        .map(|candidate| {
            let mut reasons: Vec<String> = Vec::new();
            let mut eligible = true;
            let (context_score, context_ok) = context_status(expected_scope, candidate);
            if !context_ok {
                eligible = false;
                reasons.push("rejected:scope_mismatch".into());
            }
            if !candidate.visible {
                eligible = false;
                reasons.push("rejected:hidden".into());
            }
            if !candidate.enabled {
                eligible = false;
                reasons.push("rejected:disabled".into());
            }
            if candidate.stale == Some(true) {
                eligible = false;
                reasons.push("rejected:stale".into());
            }

            let mut evidence = Evidence {
                context: context_score,
                ..Evidence::default()
            };
            let mut total_weight = 0.0;
            let mut weighted = 0.0;

            if let Some(native) = &target.anchors.native_identity {
                total_weight += W_NATIVE;
                let matched = candidate
                    .native_identity
                    .as_ref()
                    .map(|observed| observed.kind == native.kind && observed.value == native.value)
                    .unwrap_or(false);
                if matched {
                    evidence.native = 1.0;
                    weighted += W_NATIVE;
                    reasons.push("native:exact".into());
                } else {
                    reasons.push("native:miss".into());
                }
            }
            if let Some(anchor) = &target.anchors.semantic {
                let candidate_semantic = candidate.semantic.clone().unwrap_or_default();
                let (score, strength) = {
                    let mut merged = candidate_semantic.clone();
                    if merged.text.is_none() {
                        merged.text = candidate.text.clone();
                    }
                    semantic_score(anchor, &merged)
                };
                if strength > 0.0 {
                    total_weight += W_SEMANTIC;
                    weighted += W_SEMANTIC * score;
                    evidence.semantic = score;
                    reasons.push(format!("semantic:{score:.2}"));
                    if strength < MIN_SEMANTIC_STRENGTH {
                        reasons.push("semantic:weak_anchor".into());
                    }
                }
            }
            if let Some(anchor) = &target.anchors.structure {
                let score = candidate
                    .structure
                    .as_ref()
                    .map(|observed| structure_score(anchor, observed))
                    .unwrap_or(0.0);
                total_weight += W_STRUCTURE;
                weighted += W_STRUCTURE * score;
                evidence.structure = score;
                reasons.push(format!("structure:{score:.2}"));
            }
            if let Some(anchor) = &target.anchors.visual {
                let score = candidate
                    .visual
                    .as_ref()
                    .map(|observed| visual_score(anchor, observed))
                    .unwrap_or(0.0);
                total_weight += W_VISUAL;
                weighted += W_VISUAL * score;
                evidence.visual = score;
                reasons.push(format!("visual:{score:.2}"));
            }

            let total = if total_weight == 0.0 {
                0.0
            } else {
                weighted / total_weight
            };
            if total_weight == 0.0 {
                eligible = false;
                reasons.push("rejected:no_anchor".into());
            } else if total < config.min_score {
                eligible = false;
                reasons.push(format!("rejected:below_min_score({total:.2})"));
            }
            let strength_gate = evidence.native > 0.0
                || evidence.semantic >= 0.20
                || (evidence.structure >= 0.60 && evidence.visual >= 0.30)
                || evidence.visual >= 0.85;
            if eligible && !strength_gate {
                eligible = false;
                reasons.push("rejected:weak_evidence".into());
            }

            let auto_eligible = eligible && auto_gate(&evidence, &config).is_ok();
            if eligible {
                match auto_gate(&evidence, &config) {
                    Ok(()) => reasons.push("auto:eligible".into()),
                    Err(reason) => reasons.push(format!("confirm:{}", reason.as_str())),
                }
            }

            RankedCandidate {
                candidate: candidate.clone(),
                total,
                evidence,
                reasons,
                eligible,
                auto_eligible,
            }
        })
        .collect();

    ranked.sort_by(|a, b| {
        b.total
            .partial_cmp(&a.total)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.candidate.candidate_id.cmp(&b.candidate.candidate_id))
    });

    let eligible: Vec<&RankedCandidate> = ranked.iter().filter(|item| item.eligible).collect();
    let decision = if eligible.is_empty() {
        let all_stale = !candidates.is_empty()
            && candidates
                .iter()
                .all(|candidate| candidate.stale == Some(true));
        if all_stale {
            Decision::Confirm(ConfirmReason::Stale)
        } else {
            Decision::NotFound
        }
    } else {
        let top = eligible[0];
        if !top.auto_eligible {
            let reason = auto_gate(&top.evidence, &config).unwrap_err();
            Decision::Confirm(reason)
        } else if let Some(second) = eligible.get(1) {
            if top.total - second.total < config.ambiguity_margin {
                Decision::Confirm(ConfirmReason::Ambiguous)
            } else {
                Decision::Auto
            }
        } else {
            Decision::Auto
        }
    };

    Ranking { ranked, decision }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target_semantic_only() -> Target {
        Target {
            anchors: Anchors {
                semantic: Some(SemanticAnchor {
                    role: Some("button".into()),
                    name: Some("提交".into()),
                    test_id: Some("submit-btn".into()),
                    ..Default::default()
                }),
                structure: Some(StructureAnchor {
                    path: Some(vec!["form#f".into(), "button:nth-of-type(1)".into()]),
                    ..Default::default()
                }),
                ..Default::default()
            },
            fallback_bounds: None,
            confidence: None,
        }
    }

    fn candidate(id: &str, name: &str, test_id: &str) -> Candidate {
        Candidate {
            candidate_id: id.into(),
            native_identity: None,
            semantic: Some(CandidateSemantic {
                role: Some("button".into()),
                name: Some(name.into()),
                test_id: Some(test_id.into()),
                ..Default::default()
            }),
            structure: Some(CandidateStructure {
                path: Some(vec!["form#f".into(), "button:nth-of-type(1)".into()]),
                ..Default::default()
            }),
            visual: None,
            context: Some(CandidateContext {
                app_scope: Some("https://app.example.test".into()),
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

    #[test]
    fn semantic_and_structure_auto_execute() {
        let ranking = rank(
            &target_semantic_only(),
            &AnchorConfig::default(),
            Some("https://app.example.test"),
            &[candidate("c1", "提交", "submit-btn")],
        );
        assert_eq!(ranking.decision, Decision::Auto);
        assert!(ranking.ranked[0].eligible);
        assert!(ranking.ranked[0].auto_eligible);
    }

    #[test]
    fn visual_only_never_auto() {
        let mut target = target_semantic_only();
        target.anchors.semantic = None;
        target.anchors.structure = None;
        target.anchors.visual = Some(VisualAnchor {
            dhash: Some("ffffffffffffffff".into()),
            ..Default::default()
        });
        let mut cand = candidate("c1", "提交", "submit-btn");
        cand.semantic = None;
        cand.structure = None;
        cand.visual = Some(CandidateVisual {
            dhash: Some("ffffffffffffffff".into()),
            ..Default::default()
        });
        let ranking = rank(
            &target,
            &AnchorConfig::default(),
            Some("https://app.example.test"),
            &[cand],
        );
        assert_eq!(
            ranking.decision,
            Decision::Confirm(ConfirmReason::VisualOnly)
        );
    }

    #[test]
    fn wrong_scope_is_rejected() {
        let mut cand = candidate("c1", "提交", "submit-btn");
        cand.context = Some(CandidateContext {
            app_scope: Some("https://evil.example.test".into()),
            ..Default::default()
        });
        let ranking = rank(
            &target_semantic_only(),
            &AnchorConfig::default(),
            Some("https://app.example.test"),
            &[cand],
        );
        assert_eq!(ranking.decision, Decision::NotFound);
        assert!(ranking.ranked[0]
            .reasons
            .contains(&"rejected:scope_mismatch".to_string()));
    }

    #[test]
    fn near_tie_requires_disambiguation() {
        let mut second = candidate("c2", "提交", "submit-btn");
        second.structure = Some(CandidateStructure {
            path: Some(vec!["form#f".into(), "button:nth-of-type(1)".into()]),
            ..Default::default()
        });
        let ranking = rank(
            &target_semantic_only(),
            &AnchorConfig::default(),
            Some("https://app.example.test"),
            &[candidate("c1", "提交", "submit-btn"), second],
        );
        assert_eq!(
            ranking.decision,
            Decision::Confirm(ConfirmReason::Ambiguous)
        );
    }

    #[test]
    fn moved_button_with_same_semantics_is_eligible_but_needs_confirmation() {
        let mut target = target_semantic_only();
        target.anchors.structure = None;
        let mut moved = candidate("c1", "提交", "submit-btn");
        moved.structure = Some(CandidateStructure {
            path: Some(vec![
                "main".into(),
                "div:nth-of-type(3)".into(),
                "button".into(),
            ]),
            ..Default::default()
        });
        let ranking = rank(
            &target,
            &AnchorConfig::default(),
            Some("https://app.example.test"),
            &[moved],
        );
        assert!(ranking.ranked[0].eligible);
        assert_eq!(
            ranking.decision,
            Decision::Confirm(ConfirmReason::LowConfidence)
        );
    }
}
