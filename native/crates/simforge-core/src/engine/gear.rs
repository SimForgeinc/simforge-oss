//! Reverse gear.
//!
//! Direction of travel is a *discrete state* on the `set` axis
//! (`state:motion.gear`), never a negative speed: `speed_mps` is a magnitude
//! everywhere downstream (TTC, min-clearance, required-decel, exporters).
//!
//! **The route is the path the body travels.** A reversing body traverses that
//! same path rear-first: `route_s` still advances and the body heading is
//! `route_tangent + PI`.

use crate::physics::MotionDirection;
use crate::types::SetValue;

/// The `set` key that selects the gear.
pub const MOTION_GEAR_KEY: &str = "motion.gear";
/// Read-only companion key reporting the gear the gearbox actually engaged.
pub const MOTION_GEAR_ENGAGED_KEY: &str = "motion.gearEngaged";
/// Hard ceiling on reverse speed, m/s (≈ 25 km/h): one reverse ratio.
pub const REVERSE_MAX_SPEED_MPS: f64 = 6.94;
/// Speed at or below which a gear change engages, m/s.
pub const GEAR_ENGAGE_SPEED_MPS: f64 = 0.3;
/// Tolerance before a corrected reverse spawn heading is reported (≈ 5°).
pub const REVERSE_SPAWN_HEADING_TOL_RAD: f64 = 0.087;

/// Parse a `motion.gear` `set` value. `None` for anything else.
pub fn motion_direction_of_gear(value: &SetValue) -> Option<MotionDirection> {
    match value {
        SetValue::Text(s) if s == "forward" => Some(MotionDirection::Forward),
        SetValue::Text(s) if s == "reverse" => Some(MotionDirection::Reverse),
        _ => None,
    }
}

/// The gear name for a direction, for trace/state readback.
#[inline]
pub const fn gear_of_motion_direction(direction: MotionDirection) -> &'static str {
    match direction {
        MotionDirection::Reverse => "reverse",
        MotionDirection::Forward => "forward",
    }
}

/// Spawn-time gear: `motion:reverse` is an initial condition only.
pub fn initial_motion_direction(tags: &[String]) -> MotionDirection {
    if tags.iter().any(|t| t == "motion:reverse") {
        MotionDirection::Reverse
    } else {
        MotionDirection::Forward
    }
}

/// Govern a commanded speed magnitude against the selected gear.
#[inline]
pub fn govern_speed_for_gear(target_mps: f64, direction: MotionDirection) -> f64 {
    match direction {
        MotionDirection::Forward => target_mps,
        MotionDirection::Reverse => target_mps.min(REVERSE_MAX_SPEED_MPS),
    }
}
