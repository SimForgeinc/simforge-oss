//! The render contact gate: every wheel of every body in a timeline stands on
//! the map's rendered ground surface (docs/engineering/ground-height.md).
//!
//! Renderers apply timeline poses verbatim, so checking the timeline against
//! the same ground mesh the renderer draws checks what the cameras see. A
//! render job runs this before rendering and fails when any supported contact
//! is off the surface by more than the tolerance (3 cm).

use serde::Serialize;

use crate::engine::contact::ContactGeometry;
use crate::map::ground::GroundSurface;
use crate::math::tan;

use super::RenderTimeline;

/// Default tolerance: |wheel bottom − surface| per contact.
pub const CONTACT_GATE_TOLERANCE_M: f64 = 0.03;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactGateFailure {
    pub actor_id: String,
    pub tick: u32,
    /// `FL`, `FR`, `RL`, `RR`, or `centre`.
    pub contact: &'static str,
    pub x: f64,
    pub y: f64,
    /// Wheel bottom minus surface: positive floats, negative sinks.
    pub gap_m: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactGateReport {
    pub schema: &'static str,
    pub ground_sha256: String,
    pub tolerance_m: f64,
    pub pass: bool,
    /// Contacts checked (present ticks × contacts per body).
    pub checked: u64,
    pub max_abs_gap_m: f64,
    /// Contacts over a hole in the rendered map (no surface at all): the
    /// engine rests the body on its other wheels and reports it.
    pub unsupported: u64,
    /// Worst first, at most 50.
    pub failures: Vec<ContactGateFailure>,
    pub failure_count: u64,
}

pub fn check_contact(
    timeline: &RenderTimeline,
    ground: &GroundSurface,
    tolerance_m: f64,
) -> ContactGateReport {
    const NAMES: [&str; 4] = ["FL", "FR", "RL", "RR"];
    let mut checked = 0u64;
    let mut unsupported = 0u64;
    let mut max_abs = 0.0f64;
    let mut failures: Vec<ContactGateFailure> = Vec::new();
    let mut failure_count = 0u64;
    for actor in &timeline.actors {
        let wheelbase =
            crate::physics::actor_physics_profile(actor.kind).map(|p| p.wheelbase_m);
        let geometry = ContactGeometry::for_actor(actor.kind, &actor.dims, wheelbase);
        let (a, b, point) = match geometry {
            ContactGeometry::FourWheel {
                half_wheelbase_m,
                half_track_m,
            } => (half_wheelbase_m, half_track_m, false),
            ContactGeometry::TwoWheel { half_wheelbase_m } => (half_wheelbase_m, 0.0, false),
            ContactGeometry::Point => (0.0, 0.0, true),
        };
        let layout = [(a, b), (a, -b), (-a, b), (-a, -b)];
        let tr = &actor.track;
        for i in 0..tr.present.len() {
            if tr.present[i] != 1 {
                continue;
            }
            let probes = geometry.probes(tr.x[i], tr.y[i], tr.heading_rad[i]);
            let (tp, trr) = (tan(tr.road_pitch_rad[i]), tan(tr.road_roll_rad[i]));
            let drop = tr.wheel_drop_m.as_ref().map(|d| d[i]).unwrap_or([0.0; 4]);
            let contacts = if point { 1 } else { 4 };
            for k in 0..contacts {
                let (u, v) = layout[k];
                let wheel = tr.z[i] - u * tp + v * trr + drop[k];
                let (px, py) = probes[k];
                checked += 1;
                let Ok(surfaces) = ground.surfaces_at(px, py) else {
                    unsupported += 1;
                    continue;
                };
                let Some(nearest) = surfaces
                    .iter()
                    .map(|s| wheel - s.z)
                    .min_by(|x, y| x.abs().total_cmp(&y.abs()))
                else {
                    unsupported += 1;
                    continue;
                };
                max_abs = max_abs.max(nearest.abs());
                if nearest.abs() > tolerance_m {
                    failure_count += 1;
                    failures.push(ContactGateFailure {
                        actor_id: actor.id.clone(),
                        tick: i as u32,
                        contact: if point { "centre" } else { NAMES[k] },
                        x: px,
                        y: py,
                        gap_m: nearest,
                    });
                }
            }
        }
    }
    failures.sort_by(|x, y| {
        y.gap_m
            .abs()
            .total_cmp(&x.gap_m.abs())
            .then(x.actor_id.cmp(&y.actor_id))
            .then(x.tick.cmp(&y.tick))
    });
    failures.truncate(50);
    ContactGateReport {
        schema: "simforge.render-contact-gate/v1",
        ground_sha256: ground.digest().to_owned(),
        tolerance_m,
        pass: failure_count == 0,
        checked,
        max_abs_gap_m: max_abs,
        unsupported,
        failures,
        failure_count,
    }
}
