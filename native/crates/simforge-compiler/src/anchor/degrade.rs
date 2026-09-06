//! Degradation semantics: **degradation may relax presentation, never intent.**
//!
//! Repairs are attempted in order: speed-clamp / runway-shorten,
//! feature-distance relax, lane-offset clamp (non-required roles),
//! junction-class substitute (near-miss table, preferred only), actor drop
//! (cosmetic only), otherwise `infeasible`. Any repair that would touch a
//! `required` clause or role makes the site infeasible.

use std::collections::BTreeSet;

use serde_json::Value;

use super::scoring::passes_required;
use super::{
    BindingStatus, ClauseResult, DegradationReport, FeatureBinding, MRole, Repair, Verdict,
};
use crate::template::{Essentiality, OnMissing};

pub struct DegradeInput<'a> {
    pub roles: &'a [MRole],
    pub clauses: &'a [ClauseResult],
    pub bindings: &'a [FeatureBinding],
    /// Weighted soft-clause score from `aggregate_score`.
    pub soft_score: f64,
    pub failed_required_clauses: &'a [String],
}

fn fmt(v: &Value) -> String {
    match v {
        Value::Number(n) => {
            simforge_core::hash::js_number_to_string(super::round2(n.as_f64().unwrap_or(0.0)))
        }
        Value::Array(items) => items.iter().map(fmt).collect::<Vec<_>>().join("|"),
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        Value::Null => "null".to_owned(),
        Value::Object(_) => v.to_string(),
    }
}

fn pair(v: &Value) -> (f64, f64) {
    match v {
        Value::Array(items) if items.len() >= 2 => (
            items[0].as_f64().unwrap_or(0.0),
            items[1].as_f64().unwrap_or(0.0),
        ),
        _ => (0.0, 0.0),
    }
}

fn on_missing_of(binding: &FeatureBinding, role: Option<&MRole>) -> Option<OnMissing> {
    binding
        .on_missing
        .or_else(|| role.and_then(|r| r.kind.on_missing()))
}

/// Apply the ordered repair attempts and produce the report and final score.
pub fn degrade(input: &DegradeInput<'_>) -> (DegradationReport, f64) {
    let clauses = input.clauses;
    let mut repairs: Vec<Repair> = Vec::new();
    let mut failed_required: Vec<String> = input.failed_required_clauses.to_vec();
    let role_by_name = |name: &str| input.roles.iter().find(|r| r.role == name);
    let clause_by_path = |path: &str| clauses.iter().find(|c| c.path == path);

    // 1a. speed clamp
    if let Some(speed) = clause_by_path("corridor.speedLimitKph") {
        if speed.supported && !passes_required(speed.score) {
            repairs.push(Repair::SpeedClamp {
                path: speed.path.clone(),
                requested_kph: pair(&speed.required),
                applied_kph: speed.actual.as_f64().unwrap_or(0.0),
                touches_required: speed.essentiality == Essentiality::Required,
                note: format!("speeds clamped to the site limit {} kph (arrival invariants re-solved over the speed parameter)", fmt(&speed.actual)),
            });
        }
    }
    // 1b. runway shorten
    for path in ["corridor.runwayUpstreamM", "corridor.runwayDownstreamM"] {
        let Some(runway) = clause_by_path(path) else {
            continue;
        };
        if !runway.supported || passes_required(runway.score) {
            continue;
        }
        repairs.push(Repair::RunwayShorten {
            path: path.to_owned(),
            requested_m: runway.required.as_f64().unwrap_or(0.0),
            available_m: runway.actual.as_f64().unwrap_or(0.0),
            touches_required: runway.essentiality == Essentiality::Required,
            note: format!(
                "run-up shortened to the {} m available",
                fmt(&runway.actual)
            ),
        });
    }
    // 2. feature-distance relax
    for clause in clauses {
        if !clause.path.starts_with("features.") || !clause.path.ends_with(".atM") {
            continue;
        }
        if !clause.supported || passes_required(clause.score) || clause.score <= 0.0 {
            continue;
        }
        repairs.push(Repair::FeatureDistanceRelax {
            path: clause.path.clone(),
            requested_m: pair(&clause.required),
            actual_m: clause.actual.as_f64().unwrap_or(0.0),
            slack_m: clause.slack,
            touches_required: clause.essentiality == Essentiality::Required,
            note: format!(
                "feature sits {} m outside the requested window, inside tolerance",
                fmt(&Value::from(clause.slack))
            ),
        });
    }
    // 3. lane-offset clamp: an author-sanctioned `clamp` does not touch intent.
    for binding in input.bindings {
        if binding.status != BindingStatus::Clamped {
            continue;
        }
        let role = role_by_name(&binding.role);
        let sanctioned = on_missing_of(binding, role) == Some(OnMissing::Clamp);
        let requested_k = binding.requested_k.or_else(|| match role.map(|r| &r.kind) {
            Some(super::MRoleKind::LaneOffset { k, .. }) => Some(*k),
            _ => binding.pose.map(|p| p.k),
        });
        let requested_k = requested_k.unwrap_or(0);
        let applied_k = binding.pose.map_or(0, |p| p.k);
        repairs.push(Repair::LaneOffsetClamp {
            role: binding.role.clone(),
            requested_k,
            applied_k,
            touches_required: !sanctioned
                && role.is_some_and(|r| r.essentiality == Essentiality::Required),
            note: format!(
                "{} moved from lane k={requested_k} to k={applied_k}{}",
                binding.role,
                if sanctioned {
                    " (onMissing: clamp)"
                } else {
                    ""
                }
            ),
        });
    }
    // 4. junction-class substitute
    for clause in clauses {
        if !clause.path.ends_with("junction.control")
            || !clause.supported
            || passes_required(clause.score)
            || clause.score <= 0.0
        {
            continue;
        }
        let requested: Vec<String> = match &clause.required {
            Value::Array(items) => items.iter().map(fmt).collect(),
            other => vec![fmt(other)],
        };
        repairs.push(Repair::JunctionClassSubstitute {
            path: clause.path.clone(),
            requested,
            actual: fmt(&clause.actual),
            near_miss_score: clause.score,
            touches_required: clause.essentiality == Essentiality::Required,
            note: format!(
                "{} junction substituted for {} (near-miss {})",
                fmt(&clause.actual),
                fmt(&clause.required),
                clause.score
            ),
        });
    }
    // 5. actor drop
    for binding in input.bindings {
        if !matches!(
            binding.status,
            BindingStatus::Dropped | BindingStatus::Failed
        ) {
            continue;
        }
        let role = role_by_name(&binding.role);
        let essentiality = role.map_or(Essentiality::Required, |r| r.essentiality);
        let sanctioned_drop = binding.status == BindingStatus::Dropped
            && on_missing_of(binding, role) == Some(OnMissing::Drop);
        let touches_required = !sanctioned_drop && essentiality != Essentiality::Cosmetic;
        repairs.push(Repair::ActorDrop {
            role: binding.role.clone(),
            reason: binding
                .notes
                .first()
                .cloned()
                .unwrap_or_else(|| "role could not be bound".to_owned()),
            touches_required,
            note: if sanctioned_drop {
                format!("{} dropped (onMissing: drop)", binding.role)
            } else if essentiality == Essentiality::Cosmetic {
                format!("{} dropped (cosmetic)", binding.role)
            } else {
                format!("{} could not be bound and is not cosmetic", binding.role)
            },
        });
        if touches_required {
            failed_required.push(format!("roles.{}", binding.role));
        }
    }

    let touched_required = repairs.iter().any(Repair::touches_required);
    let unsupported_required: Vec<&str> = clauses
        .iter()
        .filter(|c| c.essentiality == Essentiality::Required && !c.supported)
        .map(|c| c.path.as_str())
        .collect();
    let mut score = input.soft_score;
    for repair in &repairs {
        score *= repair.penalty();
    }
    score = score.clamp(0.0, 1.0);
    let unique_failed: Vec<String> = failed_required
        .into_iter()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let infeasible = !unique_failed.is_empty() || touched_required;
    let all_exact = repairs.is_empty()
        && clauses
            .iter()
            .all(|c| !c.supported || passes_required(c.score))
        && input
            .bindings
            .iter()
            .all(|b| b.status == BindingStatus::Bound);
    let verdict = if infeasible {
        Verdict::Infeasible
    } else if all_exact {
        Verdict::Exact
    } else {
        Verdict::Degraded
    };
    let mut parts: Vec<String> = Vec::new();
    match verdict {
        Verdict::Exact => {
            parts.push("Exact match: every clause and role bound without relaxation.".to_owned())
        }
        Verdict::Degraded => {
            parts.push(format!("Degraded match (score {score:.2})."));
            for repair in &repairs {
                parts.push(format!("{}.", repair.note()));
            }
            for clause in clauses
                .iter()
                .filter(|c| {
                    c.supported && c.score < 1.0 && c.essentiality != Essentiality::Required
                })
                .take(3)
            {
                parts.push(format!("{}.", clause.reason));
            }
            parts.push(
                "Presentation was relaxed; the scenario still tests what it was written to test."
                    .to_owned(),
            );
        }
        Verdict::Infeasible => {
            parts.push("Infeasible at this site.".to_owned());
            for path in &unique_failed {
                match clause_by_path(path) {
                    Some(c) => parts.push(format!("{}.", c.reason)),
                    None => parts.push(format!("{path} could not be satisfied.")),
                }
            }
            for repair in repairs.iter().filter(|r| r.touches_required()) {
                parts.push(format!(
                    "Would have required relaxing a required clause: {}.",
                    repair.note()
                ));
            }
            if !unsupported_required.is_empty() {
                parts.push(format!(
                    "Required clauses this map index cannot answer: {}.",
                    unsupported_required.join(", ")
                ));
            }
        }
    }
    let final_score = if verdict == Verdict::Infeasible {
        0.0
    } else {
        score
    };
    (
        DegradationReport {
            verdict,
            score: final_score,
            repairs,
            failed_required_clauses: unique_failed,
            summary: parts.join(" "),
            intent_preserved: !infeasible,
        },
        final_score,
    )
}
