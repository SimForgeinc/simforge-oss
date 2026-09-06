//! Post-hoc evaluation of a finished trace.
//!
//! - [`evaluate_trace`] / [`evaluate_metrics`]: the reject filters every
//!   generated concrete passes through.
//! - [`min_clearance`]: exact minimum oriented-footprint separation.
//! - [`realized_pet`]: textbook post-encroachment time from the trajectories
//!   the episode actually produced.
//! - [`near_miss`]: verification of an authored near-miss goal.
//! - [`intent`]: authored-intent rubric evaluation and blind-review packets.
//!
//! Everything here is deterministic and side-effect free over a [`SimTrace`].

pub mod intent;
pub mod min_clearance;
pub mod near_miss;
pub mod realized_pet;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::math::Vec2;
use crate::trace::metrics::{
    criticality_window, CollisionRecord, EpisodeMetrics, MinPathTtcRecord, MinPetRecord,
    MinTtcRecord,
};
use crate::trace::SimTrace;

pub use intent::{
    create_blind_review_packet, evaluate_intent_rubric, parse_intent_rubric, summarize_behavior,
    validate_intent_rubric, BehaviorSummary, BehaviorSummaryLimits, BlindReviewPacket,
    CriterionStatus, CriterionVerdict, IntentCriterion, IntentEvaluation, IntentRubric,
    TraceEvidence,
};
pub use min_clearance::{compute_min_clearance, MinClearanceResult};
pub use near_miss::{
    verify_near_miss_outcome, NearMissOptions, NearMissStatus, NearMissVerification,
};
pub use realized_pet::{compute_realized_pet, RealizedPetResult, RealizedPetStatus};

pub const DEFAULT_TRIVIAL_TTC_S: f64 = 3.0;
pub const DEFAULT_TRIVIAL_PET_S: f64 = 1.5;
pub const DEFAULT_MAX_DECEL_MPS2: f64 = 0.8 * 9.81;

/// | filter | rejects when |
/// |---|---|
/// | `trivially_safe` | criticality above the triviality threshold (negative-control tag) |
/// | `physically_unavoidable` | required decel exceeds the friction ceiling |
/// | `never_fired` | any (required) trigger never fired |
/// | `out_of_window` | no finite criticality inside the edge-safe window |
/// | `collision` | opt-in |
/// | `occlusion_unproven` | a declared occlusion never produced a reveal before conflict |
/// | `no_interaction` | no pair produced any finite criticality |
///
/// Wire form is the TS `EvaluateFilters` object: camelCase, unknown keys
/// rejected, every field optional (`null`/absent = default), `window` as a
/// two-element array.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct EvaluateFilters {
    pub trivial_ttc_s: Option<f64>,
    pub trivial_pet_s: Option<f64>,
    /// Road-friction decel ceiling, m/s².
    pub max_achievable_decel_mps2: Option<f64>,
    /// Criticality window; defaults to the proportional edge-safe window.
    pub window: Option<[f64; 2]>,
    pub reject_collisions: bool,
    /// Skip `trivially_safe`; the scenario is a deliberate negative control.
    pub negative_control: bool,
    /// Only apply the never-fired filter to these interaction ids.
    pub required_triggers: Option<Vec<String>>,
    /// Generated background road users, excluded from the
    /// `physically_unavoidable` scan. `evaluate_trace` fills this from the
    /// header when unset.
    pub ambient_actor_ids: Option<Vec<String>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RejectCode {
    TriviallySafe,
    PhysicallyUnavoidable,
    NeverFired,
    OutOfWindow,
    Collision,
    OcclusionUnproven,
    NoInteraction,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RejectFinding {
    pub code: RejectCode,
    pub reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Verdict {
    Accept,
    Reject,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CriticalityKind {
    Ttc,
    PathTtc,
    Pet,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvaluationSummary {
    #[serde(rename = "minTTC")]
    pub min_ttc: Option<f64>,
    #[serde(rename = "minTTCt")]
    pub min_ttc_t: Option<f64>,
    /// Mechanism-aware minimum selected from circle TTC, crossing path-TTC and PET.
    pub criticality_kind: Option<CriticalityKind>,
    pub criticality: Option<f64>,
    pub criticality_t: Option<f64>,
    pub required_decel_max: f64,
    pub collisions: usize,
    pub never_fired: usize,
    pub occlusion_unproven: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TraceEvaluation {
    pub verdict: Verdict,
    pub findings: Vec<RejectFinding>,
    pub tags: Vec<String>,
    pub summary: EvaluationSummary,
}

pub struct WindowMetrics {
    pub min_ttc: Option<MinTtcRecord>,
    pub min_path_ttc: Option<MinPathTtcRecord>,
    pub min_pet: Option<MinPetRecord>,
}

fn pair_matches(actual: &[String; 2], expected: Option<&[String; 2]>) -> bool {
    match expected {
        None => true,
        Some(e) => {
            (actual[0] == e[0] && actual[1] == e[1]) || (actual[0] == e[1] && actual[1] == e[0])
        }
    }
}

/// Select metric minima from retained samples inside `[lo, hi]` without
/// changing the global summaries. Ties resolve to the earliest sample.
pub fn criticality_metrics_in_window(
    metrics: &EpisodeMetrics,
    window: (f64, f64),
    pair: Option<&[String; 2]>,
) -> WindowMetrics {
    let (lo, hi) = window;
    let samples = &metrics.criticality_samples;
    let mut min_ttc: Option<MinTtcRecord> = None;
    for item in samples.ttc.iter().filter(|i| pair_matches(&i.pair, pair)) {
        for (t, value) in item.t.iter().zip(&item.value) {
            if *t < lo || *t > hi {
                continue;
            }
            if min_ttc
                .as_ref()
                .is_none_or(|b| *value < b.value || (*value == b.value && *t < b.t))
            {
                min_ttc = Some(MinTtcRecord {
                    value: *value,
                    t: *t,
                    pair: item.pair.clone(),
                });
            }
        }
    }
    let mut min_path_ttc: Option<MinPathTtcRecord> = None;
    for item in samples
        .path_ttc
        .iter()
        .filter(|i| pair_matches(&i.pair, pair))
    {
        for i in 0..item.t.len() {
            let (t, value) = (item.t[i], item.value[i]);
            if t < lo || t > hi {
                continue;
            }
            if min_path_ttc
                .as_ref()
                .is_none_or(|b| value < b.value || (value == b.value && t < b.t))
            {
                min_path_ttc = Some(MinPathTtcRecord {
                    value,
                    t,
                    pair: item.pair.clone(),
                    conflict_point: Vec2::new(item.conflict_x[i], item.conflict_y[i]),
                });
            }
        }
    }
    let mut min_pet: Option<MinPetRecord> = None;
    for item in samples.pet.iter().filter(|i| pair_matches(&i.pair, pair)) {
        for i in 0..item.t.len() {
            let (t, value) = (item.t[i], item.value[i]);
            if t < lo || t > hi {
                continue;
            }
            // PET is only defined for separated conflict-zone occupancy; the
            // overlap sentinel 0 belongs to path-TTC.
            if !value.is_finite() || value <= 0.0 {
                continue;
            }
            if min_pet
                .as_ref()
                .is_none_or(|b| value < b.value || (value == b.value && t < b.t))
            {
                min_pet = Some(MinPetRecord {
                    value,
                    t,
                    pair: item.pair.clone(),
                    conflict_point: Vec2::new(item.conflict_x[i], item.conflict_y[i]),
                    first_actor: item.first_actor[i].clone(),
                    second_actor: item.second_actor[i].clone(),
                });
            }
        }
    }
    WindowMetrics {
        min_ttc,
        min_path_ttc,
        min_pet,
    }
}

struct Criticality<'a> {
    value: f64,
    t: f64,
    pair: &'a [String; 2],
}

pub fn evaluate_metrics(
    metrics: &EpisodeMetrics,
    clip_seconds: f64,
    filters: &EvaluateFilters,
) -> TraceEvaluation {
    let mut findings = Vec::new();
    let mut tags = Vec::new();
    let trivial_ttc = filters.trivial_ttc_s.unwrap_or(DEFAULT_TRIVIAL_TTC_S);
    let trivial_pet = filters.trivial_pet_s.unwrap_or(DEFAULT_TRIVIAL_PET_S);
    let max_decel = filters
        .max_achievable_decel_mps2
        .unwrap_or(DEFAULT_MAX_DECEL_MPS2);
    let (lo, hi) = filters
        .window
        .map_or_else(|| criticality_window(clip_seconds), |[lo, hi]| (lo, hi));

    // Current traces always carry the sample series, so the window-selected
    // minima are authoritative; the global records only prove interaction.
    let window = criticality_metrics_in_window(metrics, (lo, hi), None);
    let min_ttc = window.min_ttc.as_ref().map(|r| Criticality {
        value: r.value,
        t: r.t,
        pair: &r.pair,
    });
    let min_path_ttc = window.min_path_ttc.as_ref().map(|r| Criticality {
        value: r.value,
        t: r.t,
        pair: &r.pair,
    });
    let path_wins = match (&min_path_ttc, &min_ttc) {
        (Some(p), Some(t)) => p.value < t.value || (p.value == t.value && p.t < t.t),
        (Some(_), None) => true,
        _ => false,
    };
    let ttc_criticality = if path_wins {
        min_path_ttc.as_ref()
    } else {
        min_ttc.as_ref()
    };
    let min_pet = window.min_pet.as_ref().map(|r| Criticality {
        value: r.value,
        t: r.t,
        pair: &r.pair,
    });
    // PET is the faithful severity measure for a separated crossing; PET=0 is
    // overlapping occupancy and stays with finite path-TTC.
    let pet_wins = min_pet.as_ref().is_some_and(|p| p.value > 0.0)
        && ttc_criticality.is_none_or(|c| c.value > trivial_ttc);
    let criticality = if pet_wins {
        min_pet.as_ref()
    } else {
        ttc_criticality
    };
    let criticality_kind = criticality.map(|_| {
        if pet_wins {
            CriticalityKind::Pet
        } else if path_wins {
            CriticalityKind::PathTtc
        } else {
            CriticalityKind::Ttc
        }
    });
    let trivial_threshold = if criticality_kind == Some(CriticalityKind::Pet) {
        trivial_pet
    } else {
        trivial_ttc
    };
    let global_has_interaction =
        metrics.min_ttc.is_some() || metrics.min_path_ttc.is_some() || metrics.min_pet.is_some();
    match criticality {
        None if global_has_interaction => findings.push(RejectFinding {
            code: RejectCode::OutOfWindow,
            reason: format!("no finite criticality observation falls inside [{lo}, {hi}] s"),
            detail: Some(json!({ "window": [lo, hi] })),
        }),
        None => findings.push(RejectFinding {
            code: RejectCode::NoInteraction,
            reason: "no pair produced finite TTC or crossing path-TTC — the episode has no interaction at all".to_owned(),
            detail: None,
        }),
        Some(c) if c.value > trivial_threshold => {
            tags.push("negative-control".to_owned());
            findings.push(RejectFinding {
                code: RejectCode::TriviallySafe,
                reason: format!(
                    "min {} {:.2} s exceeds the {} s triviality threshold",
                    kind_name(criticality_kind),
                    c.value,
                    trivial_threshold
                ),
                detail: Some(json!({ "criticality": c.value, "kind": kind_name(criticality_kind), "pair": c.pair })),
            });
        }
        Some(_) => {}
    }

    let mut worst_decel = 0.0_f64;
    let mut worst_actor = "";
    let ambient = filters.ambient_actor_ids.as_deref().unwrap_or(&[]);
    for (id, v) in &metrics.required_decel_max {
        if ambient.iter().any(|a| a == id) {
            continue;
        }
        if *v > worst_decel {
            worst_decel = *v;
            worst_actor = id;
        }
    }
    if worst_decel > max_decel {
        findings.push(RejectFinding {
            code: RejectCode::PhysicallyUnavoidable,
            reason: format!("{worst_actor} needed {worst_decel:.2} m/s², above the {max_decel:.2} m/s² friction ceiling"),
            detail: Some(json!({ "actorId": worst_actor, "requiredDecel": worst_decel, "ceiling": max_decel })),
        });
    }

    let never_fired: Vec<&String> = match &filters.required_triggers {
        Some(required) => metrics
            .trigger_never_fired
            .iter()
            .filter(|id| required.contains(*id))
            .collect(),
        None => metrics.trigger_never_fired.iter().collect(),
    };
    if !never_fired.is_empty() {
        let ids: Vec<&str> = never_fired.iter().map(|s| s.as_str()).collect();
        findings.push(RejectFinding {
            code: RejectCode::NeverFired,
            reason: format!("trigger(s) never fired: {}", ids.join(", ")),
            detail: Some(json!({ "interactionIds": ids })),
        });
    }

    if !metrics.collisions.is_empty() {
        tags.push("collision".to_owned());
        if filters.reject_collisions {
            findings.push(RejectFinding {
                code: RejectCode::Collision,
                reason: format!("{} collision(s) occurred", metrics.collisions.len()),
                detail: Some(json!({ "collisions": metrics.collisions.iter().map(collision_value).collect::<Vec<_>>() })),
            });
        }
    }

    let occlusion_unproven: Vec<_> = metrics
        .declared_occlusion
        .iter()
        .filter(|e| e.status != crate::trace::DeclaredOcclusionStatus::RevealedBeforeConflict)
        .collect();
    if !occlusion_unproven.is_empty() {
        findings.push(RejectFinding {
            code: RejectCode::OcclusionUnproven,
            reason: format!(
                "{} declared occlusion relation(s) did not produce a blocked-to-clear reveal before conflict",
                occlusion_unproven.len()
            ),
            detail: Some(json!({
                "declarations": occlusion_unproven.iter().map(|e| json!({
                    "observer": e.observer,
                    "target": e.target,
                    "occluderId": e.occluder_id,
                    "status": e.status,
                })).collect::<Vec<_>>()
            })),
        });
    }

    let blocking = findings
        .iter()
        .filter(|f| !(f.code == RejectCode::TriviallySafe && filters.negative_control))
        .count();
    TraceEvaluation {
        verdict: if blocking == 0 {
            Verdict::Accept
        } else {
            Verdict::Reject
        },
        summary: EvaluationSummary {
            min_ttc: min_ttc.as_ref().map(|c| c.value),
            min_ttc_t: min_ttc.as_ref().map(|c| c.t),
            criticality_kind,
            criticality: criticality.map(|c| c.value),
            criticality_t: criticality.map(|c| c.t),
            required_decel_max: worst_decel,
            collisions: metrics.collisions.len(),
            never_fired: never_fired.len(),
            occlusion_unproven: occlusion_unproven.len(),
        },
        findings,
        tags,
    }
}

fn kind_name(kind: Option<CriticalityKind>) -> &'static str {
    match kind {
        Some(CriticalityKind::Ttc) => "ttc",
        Some(CriticalityKind::PathTtc) => "path-ttc",
        Some(CriticalityKind::Pet) => "pet",
        None => "none",
    }
}

fn collision_value(c: &CollisionRecord) -> Value {
    serde_json::to_value(c).unwrap_or(Value::Null)
}

/// Apply the reject filters to a trace, scaling the decel ceiling by the
/// executed friction and excluding the header's ambient actors.
pub fn evaluate_trace(trace: &SimTrace, filters: &EvaluateFilters) -> TraceEvaluation {
    let friction_scale = trace.header.operational_conditions.effects.friction_scale;
    let resolved = EvaluateFilters {
        ambient_actor_ids: filters
            .ambient_actor_ids
            .clone()
            .or_else(|| trace.header.ambient_actor_ids.clone())
            .or_else(|| Some(Vec::new())),
        max_achievable_decel_mps2: Some(
            filters
                .max_achievable_decel_mps2
                .unwrap_or(DEFAULT_MAX_DECEL_MPS2 * friction_scale),
        ),
        trivial_ttc_s: filters.trivial_ttc_s,
        trivial_pet_s: filters.trivial_pet_s,
        window: filters.window,
        reject_collisions: filters.reject_collisions,
        negative_control: filters.negative_control,
        required_triggers: filters.required_triggers.clone(),
    };
    evaluate_metrics(&trace.metrics, trace.header.clip_seconds, &resolved)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::trace::metrics::{CriticalitySamples, PetSeries};

    #[test]
    fn window_pet_ignores_overlap_sentinel_and_out_of_window_samples() {
        let pair = ["a".to_owned(), "b".to_owned()];
        let samples = CriticalitySamples {
            ttc: vec![],
            path_ttc: vec![],
            pet: vec![PetSeries {
                pair: pair.clone(),
                t: vec![1.0, 5.0, 6.0],
                value: vec![0.2, 0.0, 0.9],
                conflict_x: vec![0.0; 3],
                conflict_y: vec![0.0; 3],
                first_actor: vec!["a".to_owned(); 3],
                second_actor: vec!["b".to_owned(); 3],
            }],
        };
        let metrics = EpisodeMetrics {
            min_ttc: None,
            min_path_ttc: None,
            min_pet: None,
            criticality_samples: samples,
            min_distance: vec![],
            required_decel_max: Default::default(),
            invariant_residuals: None,
            reveal_to_conflict: None,
            declared_occlusion: vec![],
            occluder_ineffective: vec![],
            collisions: vec![],
            trigger_never_fired: vec![],
            clipped_criticality: false,
            ticks_simulated: 0,
            perception: None,
        };
        let w = criticality_metrics_in_window(&metrics, criticality_window(20.0), None);
        assert_eq!(w.min_pet.map(|p| (p.value, p.t)), Some((0.9, 6.0)));
    }
}
