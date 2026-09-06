//! Realized post-encroachment time from the trajectories the episode
//! actually produced.
//!
//! `EpisodeMetrics.minPET` is a *predicted* PET: at every tick the pair
//! readout extrapolates both actors along their future paths. For an
//! arrival-solved near miss that prediction reads ~0 at some tick by
//! construction. This module implements the textbook definition instead: PET
//! is the gap between the first actor *clearing* the conflict area and the
//! second actor *entering* it, and is undefined (an encroachment) when both
//! occupy it simultaneously — path-TTC, not PET, describes that case.

use serde::{Deserialize, Serialize};

use crate::math::Vec2;
use crate::trace::SimTrace;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RealizedPetResult {
    /// Seconds between the first actor clearing the area and the second entering.
    pub value: f64,
    pub pair: [String; 2],
    pub conflict_point: Vec2,
    /// Actor that cleared the conflict area first.
    pub first_actor: String,
    pub second_actor: String,
    pub first_exit_t: f64,
    pub second_entry_t: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RealizedPetStatus {
    Ok {
        result: RealizedPetResult,
    },
    /// Both actors were inside the conflict area at once: PET is undefined.
    #[serde(rename_all = "camelCase")]
    Encroachment {
        overlap_seconds: f64,
    },
    /// At least one actor never reached the conflict area.
    #[serde(rename_all = "camelCase")]
    NotReached {
        missing_actor: String,
    },
    Unavailable {
        reason: String,
    },
}

fn inside_footprint(
    p: Vec2,
    x: f64,
    y: f64,
    heading_rad: f64,
    length_m: f64,
    width_m: f64,
) -> bool {
    let d = Vec2::new(p.x - x, p.y - y).rotated(-heading_rad);
    d.x.abs() <= length_m / 2.0 && d.y.abs() <= width_m / 2.0
}

fn occupancy_of(trace: &SimTrace, actor_id: &str, point: Vec2) -> Option<(f64, f64)> {
    let track = trace.ticks.actors.get(actor_id)?;
    let dims = trace.actor_dims(actor_id)?;
    let mut entry: Option<f64> = None;
    let mut exit: Option<f64> = None;
    for i in 0..trace.ticks.t.len() {
        if !track.is_present(i)
            || !inside_footprint(
                point,
                track.x[i],
                track.y[i],
                track.heading_rad[i],
                dims.l,
                dims.w,
            )
        {
            continue;
        }
        let t = trace.ticks.t[i];
        entry.get_or_insert(t);
        exit = Some(t);
    }
    Some((entry?, exit?))
}

/// Measure realized PET for a pair over `conflict_point` (defaulting to the
/// engine's predicted PET / path-TTC conflict point).
pub fn compute_realized_pet(
    trace: &SimTrace,
    a: &str,
    b: &str,
    conflict_point: Option<Vec2>,
) -> RealizedPetStatus {
    let Some(point) = conflict_point
        .or_else(|| trace.metrics.min_pet.as_ref().map(|m| m.conflict_point))
        .or_else(|| {
            trace
                .metrics
                .min_path_ttc
                .as_ref()
                .map(|m| m.conflict_point)
        })
    else {
        return RealizedPetStatus::Unavailable {
            reason: "no conflict point was recorded for this episode".to_owned(),
        };
    };
    let Some((entry_a, exit_a)) = occupancy_of(trace, a, point) else {
        return RealizedPetStatus::NotReached {
            missing_actor: a.to_owned(),
        };
    };
    let Some((entry_b, exit_b)) = occupancy_of(trace, b, point) else {
        return RealizedPetStatus::NotReached {
            missing_actor: b.to_owned(),
        };
    };
    let overlap = exit_a.min(exit_b) - entry_a.max(entry_b);
    if overlap >= 0.0 {
        return RealizedPetStatus::Encroachment {
            overlap_seconds: overlap,
        };
    }
    let a_first = exit_a <= entry_b;
    let (first_exit_t, second_entry_t) = if a_first {
        (exit_a, entry_b)
    } else {
        (exit_b, entry_a)
    };
    let (first_actor, second_actor) = if a_first { (a, b) } else { (b, a) };
    RealizedPetStatus::Ok {
        result: RealizedPetResult {
            value: second_entry_t - first_exit_t,
            pair: [a.to_owned(), b.to_owned()],
            conflict_point: point,
            first_actor: first_actor.to_owned(),
            second_actor: second_actor.to_owned(),
            first_exit_t,
            second_entry_t,
        },
    }
}
