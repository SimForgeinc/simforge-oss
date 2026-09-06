//! Exact minimum footprint clearance from the trajectories the episode
//! actually produced.
//!
//! `EpisodeMetrics.minDistance` is the circumscribed-circle gap: a correct
//! collision broad phase, but for a car against a pedestrian it reports 0 m
//! for every encounter closer than three metres while the episode records no
//! collision. This measures the real separation between the two oriented
//! footprints instead.

use serde::{Deserialize, Serialize};

use crate::math::{hypot, obb_separation, Obb, Vec2};
use crate::trace::SimTrace;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MinClearanceResult {
    /// Minimum separation between the two oriented footprints, metres. 0 = touching.
    pub min_clearance_m: f64,
    pub t: f64,
    pub pair: [String; 2],
}

/// Deterministic, side-effect free. `None` when the pair never coexists or
/// either actor is unknown to the trace.
pub fn compute_min_clearance(trace: &SimTrace, a: &str, b: &str) -> Option<MinClearanceResult> {
    let ta = trace.ticks.actors.get(a)?;
    let tb = trace.ticks.actors.get(b)?;
    let da = *trace.actor_dims(a)?;
    let db = *trace.actor_dims(b)?;
    // Any footprint pair is separated by at least this much when centres are further apart.
    let broad_phase_m = hypot(da.l, da.w) / 2.0 + hypot(db.l, db.w) / 2.0;
    let mut best: Option<(f64, f64)> = None;
    for i in 0..trace.ticks.t.len() {
        if !ta.is_present(i) || !tb.is_present(i) {
            continue;
        }
        let centre = hypot(ta.x[i] - tb.x[i], ta.y[i] - tb.y[i]);
        if best.is_some_and(|(best_m, _)| centre - broad_phase_m > best_m) {
            continue;
        }
        let distance = obb_separation(
            &Obb {
                center: Vec2::new(ta.x[i], ta.y[i]),
                length_m: da.l,
                width_m: da.w,
                heading_rad: ta.heading_rad[i],
            },
            &Obb {
                center: Vec2::new(tb.x[i], tb.y[i]),
                length_m: db.l,
                width_m: db.w,
                heading_rad: tb.heading_rad[i],
            },
        );
        if best.is_none_or(|(best_m, _)| distance < best_m) {
            best = Some((distance, trace.ticks.t[i]));
        }
    }
    best.map(|(min_clearance_m, t)| MinClearanceResult {
        min_clearance_m,
        t,
        pair: [a.to_owned(), b.to_owned()],
    })
}
