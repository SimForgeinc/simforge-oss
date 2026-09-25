//! The metrics block every authoring command that runs the engine prints
//! (`metricsSummary`): the episode metrics rounded to millimetres and
//! milliseconds, the sample series left out.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use simforge_core::trace::metrics::{CollisionRecord, EpisodeMetrics};

use crate::json::round3;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MinTtcSummary {
    pub value: f64,
    pub t: f64,
    pub pair: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MinDistanceSummary {
    pub pair: Vec<String>,
    pub min_distance_m: f64,
    pub t: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevealToConflictSummary {
    pub observer: String,
    pub target: String,
    pub value: f64,
    pub first_blocked_t: f64,
    pub los_open_t: f64,
    pub conflict_t: f64,
    pub pair: Vec<String>,
    pub occluder_id: Option<String>,
    pub relevant_occluder_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeclaredOcclusionSummary {
    pub observer: String,
    pub target: String,
    pub pair: Vec<String>,
    pub occluder_id: Option<String>,
    pub relevant_occluder_ids: Vec<String>,
    pub status: Value,
    pub first_blocked_t: Option<f64>,
    pub los_open_t: Option<f64>,
    pub conflict_t: Option<f64>,
    pub reveal_to_conflict_s: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OccluderIneffectiveSummary {
    pub observer: String,
    pub target: String,
    pub pair: Vec<String>,
    pub conflict_t: f64,
    pub first_blocked_t: Option<f64>,
    pub occluder_id: Option<String>,
    pub relevant_occluder_ids: Vec<String>,
    pub reason: Value,
}

/// `metricsSummary(trace)`, field for field.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricsSummary {
    #[serde(rename = "minTTC")]
    pub min_ttc: Option<MinTtcSummary>,
    pub min_distance: Vec<MinDistanceSummary>,
    pub required_decel_max: BTreeMap<String, f64>,
    pub reveal_to_conflict: Option<RevealToConflictSummary>,
    pub declared_occlusion: Vec<DeclaredOcclusionSummary>,
    pub occluder_ineffective: Vec<OccluderIneffectiveSummary>,
    pub collisions: Vec<CollisionRecord>,
    pub trigger_never_fired: Vec<String>,
    pub clipped_criticality: bool,
    pub ticks_simulated: u64,
}

fn to_value<T: Serialize>(v: &T) -> Value {
    serde_json::to_value(v).unwrap_or(Value::Null)
}

pub fn metrics_summary(m: &EpisodeMetrics) -> MetricsSummary {
    MetricsSummary {
        min_ttc: m.min_ttc.as_ref().map(|r| MinTtcSummary {
            value: round3(r.value),
            t: round3(r.t),
            pair: r.pair.to_vec(),
        }),
        min_distance: m
            .min_distance
            .iter()
            .map(|d| MinDistanceSummary {
                pair: d.pair.to_vec(),
                min_distance_m: round3(d.min_distance_m),
                t: round3(d.t),
            })
            .collect(),
        required_decel_max: m
            .required_decel_max
            .iter()
            .map(|(k, v)| (k.clone(), round3(*v)))
            .collect(),
        reveal_to_conflict: m
            .reveal_to_conflict
            .as_ref()
            .map(|r| RevealToConflictSummary {
                observer: r.observer.clone(),
                target: r.target.clone(),
                value: round3(r.value),
                first_blocked_t: round3(r.first_blocked_t),
                los_open_t: round3(r.los_open_t),
                conflict_t: round3(r.conflict_t),
                pair: r.pair.to_vec(),
                occluder_id: r.occluder_id.clone(),
                relevant_occluder_ids: r.relevant_occluder_ids.clone(),
            }),
        declared_occlusion: m
            .declared_occlusion
            .iter()
            .map(|e| DeclaredOcclusionSummary {
                observer: e.observer.clone(),
                target: e.target.clone(),
                pair: e.pair.to_vec(),
                occluder_id: e.occluder_id.clone(),
                relevant_occluder_ids: e.relevant_occluder_ids.clone(),
                status: to_value(&e.status),
                first_blocked_t: e.first_blocked_t.map(round3),
                los_open_t: e.los_open_t.map(round3),
                conflict_t: e.conflict_t.map(round3),
                reveal_to_conflict_s: e.reveal_to_conflict_s.map(round3),
            })
            .collect(),
        occluder_ineffective: m
            .occluder_ineffective
            .iter()
            .map(|e| OccluderIneffectiveSummary {
                observer: e.observer.clone(),
                target: e.target.clone(),
                pair: e.pair.to_vec(),
                conflict_t: round3(e.conflict_t),
                first_blocked_t: e.first_blocked_t.map(round3),
                occluder_id: e.occluder_id.clone(),
                relevant_occluder_ids: e.relevant_occluder_ids.clone(),
                reason: to_value(&e.reason),
            })
            .collect(),
        collisions: m.collisions.clone(),
        trigger_never_fired: m.trigger_never_fired.clone(),
        clipped_criticality: m.clipped_criticality,
        ticks_simulated: m.ticks_simulated,
    }
}
