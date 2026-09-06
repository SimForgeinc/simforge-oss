//! Verify an authored near-miss goal from exact sampled actor footprints.
//! Any collision fails.

use serde::{Deserialize, Serialize};

use crate::math::{obb_separation, Obb, Vec2};
use crate::trace::SimTrace;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NearMissStatus {
    Verified,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NearMissVerification {
    pub status: NearMissStatus,
    pub pedestrian_id: String,
    pub target_id: String,
    pub requested_clearance_m: f64,
    pub realized_clearance_m: Option<f64>,
    pub closest_approach_time_s: Option<f64>,
    pub collision: bool,
    pub reason: String,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NearMissOptions<'a> {
    pub pedestrian_id: &'a str,
    pub target_id: &'a str,
    pub requested_clearance_m: f64,
    /// Defaults to 0.15 m.
    pub tolerance_m: Option<f64>,
}

pub fn verify_near_miss_outcome(
    trace: &SimTrace,
    options: NearMissOptions<'_>,
) -> NearMissVerification {
    let NearMissOptions {
        pedestrian_id,
        target_id,
        requested_clearance_m,
        tolerance_m,
    } = options;
    let collision = trace.metrics.collisions.iter().any(|c| {
        (c.a == pedestrian_id && c.b == target_id) || (c.a == target_id && c.b == pedestrian_id)
    });
    let failed = |reason: &str, realized: Option<f64>, t: Option<f64>| NearMissVerification {
        status: NearMissStatus::Failed,
        pedestrian_id: pedestrian_id.to_owned(),
        target_id: target_id.to_owned(),
        requested_clearance_m,
        realized_clearance_m: realized,
        closest_approach_time_s: t,
        collision,
        reason: reason.to_owned(),
    };
    let (Some(ped), Some(target), Some(ped_dims), Some(target_dims)) = (
        trace.ticks.actors.get(pedestrian_id),
        trace.ticks.actors.get(target_id),
        trace.actor_dims(pedestrian_id),
        trace.actor_dims(target_id),
    ) else {
        return failed(
            "near-miss actors or footprint metadata are missing from the trace",
            None,
            None,
        );
    };
    let mut minimum = f64::INFINITY;
    let mut minimum_t = None;
    for i in 0..trace.ticks.t.len() {
        if !ped.is_present(i) || !target.is_present(i) {
            continue;
        }
        let separation = obb_separation(
            &Obb {
                center: Vec2::new(ped.x[i], ped.y[i]),
                length_m: ped_dims.l,
                width_m: ped_dims.w,
                heading_rad: ped.heading_rad[i],
            },
            &Obb {
                center: Vec2::new(target.x[i], target.y[i]),
                length_m: target_dims.l,
                width_m: target_dims.w,
                heading_rad: target.heading_rad[i],
            },
        );
        if separation < minimum {
            minimum = separation;
            minimum_t = Some(trace.ticks.t[i]);
        }
    }
    let realized = minimum.is_finite().then_some(minimum);
    let within =
        realized.is_some_and(|r| (r - requested_clearance_m).abs() <= tolerance_m.unwrap_or(0.15));
    let verified = !collision && within && realized.is_some_and(|r| r > 0.0);
    let reason = if collision {
        "collision occurred; a near miss must remain contact-free"
    } else if within {
        "realized footprint clearance matches the requested near miss"
    } else {
        "realized footprint clearance is outside tolerance"
    };
    NearMissVerification {
        status: if verified {
            NearMissStatus::Verified
        } else {
            NearMissStatus::Failed
        },
        pedestrian_id: pedestrian_id.to_owned(),
        target_id: target_id.to_owned(),
        requested_clearance_m,
        realized_clearance_m: realized,
        closest_approach_time_s: minimum_t,
        collision,
        reason: reason.to_owned(),
    }
}
