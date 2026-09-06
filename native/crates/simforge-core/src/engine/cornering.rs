//! Actor-profile-aware corner-speed planner shared by kinematic and dynamic
//! motion. Curvature is measured over a road-scale chord instead of adjacent
//! polyline vertices, so a tessellation seam cannot masquerade as a hairpin.

use crate::map::Route;
use crate::math::{angle_delta, clamp};

const CURVATURE_WINDOW_M: f64 = 12.0;
const CURVATURE_SAMPLE_STEP_M: f64 = 2.0;
const MIN_CURVATURE_PER_M: f64 = (2.0 * std::f64::consts::PI / 180.0) / CURVATURE_WINDOW_M;
const ENVELOPE_RESPONSE_S: f64 = 1.0;

#[derive(Debug, Clone, Copy)]
pub struct CornerSpeedInput<'a> {
    pub route: &'a Route,
    pub route_s: f64,
    pub current_speed_mps: f64,
    pub desired_speed_mps: f64,
    pub comfortable_lateral_acceleration_mps2: f64,
    pub comfortable_deceleration_mps2: f64,
    pub physical_lateral_acceleration_mps2: f64,
    pub physical_deceleration_mps2: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CorneringPlan {
    pub speed_limit_mps: f64,
    /// Maximum longitudinal acceleration that still follows the speed envelope.
    pub acceleration_cap_mps2: f64,
}

impl CorneringPlan {
    pub const UNBOUNDED: CorneringPlan = CorneringPlan {
        speed_limit_mps: f64::INFINITY,
        acceleration_cap_mps2: f64::INFINITY,
    };
}

pub fn cornering_plan(input: &CornerSpeedInput<'_>) -> CorneringPlan {
    let desired = input.desired_speed_mps.max(0.0);
    if desired == 0.0 || input.route.length_m() <= 0.0 {
        return CorneringPlan {
            speed_limit_mps: desired,
            acceleration_cap_mps2: (desired - input.current_speed_mps) / ENVELOPE_RESPONSE_S,
        };
    }

    let lateral_budget = input
        .comfortable_lateral_acceleration_mps2
        .min(input.physical_lateral_acceleration_mps2 * 0.8)
        .max(0.5);
    let braking_budget = input
        .comfortable_deceleration_mps2
        .min(input.physical_deceleration_mps2 * 0.8)
        .max(0.5);
    let braking_distance_m =
        input.current_speed_mps * input.current_speed_mps / (2.0 * braking_budget);
    let horizon_m = clamp(braking_distance_m + 18.0, 25.0, 80.0);
    let length = input.route.length_m();
    let end_s = length.min(input.route_s + horizon_m);
    let mut cap_mps = desired;

    let mut center_s = end_s.min(input.route_s + CURVATURE_SAMPLE_STEP_M);
    loop {
        if center_s > end_s + 1e-9 {
            break;
        }
        let before_s = (center_s - CURVATURE_WINDOW_M / 2.0).max(0.0);
        let after_s = (center_s + CURVATURE_WINDOW_M / 2.0).min(length);
        let span_m = after_s - before_s;
        if span_m > 1e-6 {
            let before_heading = input.route.pose_at(before_s).heading_rad;
            let after_heading = input.route.pose_at(after_s).heading_rad;
            let curvature_per_m = angle_delta(before_heading, after_heading).abs() / span_m;
            if curvature_per_m >= MIN_CURVATURE_PER_M {
                let turn_speed = (lateral_budget / curvature_per_m).sqrt();
                let distance_to_curve = (before_s - input.route_s).max(0.0);
                let approach_speed =
                    (turn_speed * turn_speed + 2.0 * braking_budget * distance_to_curve).sqrt();
                cap_mps = cap_mps.min(approach_speed);
            }
        }
        if center_s >= end_s {
            break;
        }
        center_s = end_s.min(center_s + CURVATURE_SAMPLE_STEP_M);
    }

    let speed_limit_mps = clamp(cap_mps, 0.0, desired);
    CorneringPlan {
        speed_limit_mps,
        // A cap, not a second cruise convergence law: unbounded when there is
        // no upcoming curve, gradual once a curve lowers the envelope.
        acceleration_cap_mps2: if speed_limit_mps < desired {
            (speed_limit_mps - input.current_speed_mps) / ENVELOPE_RESPONSE_S
        } else {
            f64::INFINITY
        },
    }
}

/// Convenience for diagnostics and callers that only need the speed envelope.
pub fn corner_speed_limit_mps(input: &CornerSpeedInput<'_>) -> f64 {
    cornering_plan(input).speed_limit_mps
}
