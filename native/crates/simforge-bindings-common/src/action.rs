//! Flat numeric action layout shared by every host.
//!
//! A host passes one `f64[ACTION_WIDTH]` row per world instead of a
//! per-actor object graph. `NaN` marks a field the policy does not set, so an
//! all-NaN row means "keep the authored choreography" (the engine's default
//! [`ActionOverride`]). Field groups are all-or-none: a control triple or a
//! preview point with only some members set is an argument error, never a
//! silent partial override.

use simforge_core::engine::ActionOverride;
use simforge_core::math::Vec2;
use simforge_core::physics::{MotionDirection, VehicleControl};

use crate::error::{BindingError, Result};

/// Number of `f64` slots in one flat action row.
pub const ACTION_WIDTH: usize = 9;

pub const TARGET_SPEED_MPS: usize = 0;
pub const TARGET_ACCELERATION_MPS2: usize = 1;
/// `+1` forward, `-1` reverse; any other finite value is rejected.
pub const MOTION_DIRECTION: usize = 2;
pub const THROTTLE: usize = 3;
pub const BRAKE: usize = 4;
pub const STEER: usize = 5;
pub const PREVIEW_X: usize = 6;
pub const PREVIEW_Y: usize = 7;
pub const PREVIEW_HEADING_RAD: usize = 8;

/// Host-facing field names in slot order (used by stubs/docs and error text).
pub const ACTION_FIELD_NAMES: [&str; ACTION_WIDTH] = [
    "target_speed_mps",
    "target_acceleration_mps2",
    "motion_direction",
    "throttle",
    "brake",
    "steer",
    "preview_x",
    "preview_y",
    "preview_heading_rad",
];

#[inline]
fn set(v: f64) -> Option<f64> {
    if v.is_nan() {
        None
    } else {
        Some(v)
    }
}

/// Decode one flat row. `row.len()` must equal [`ACTION_WIDTH`].
pub fn decode_action(row: &[f64]) -> Result<ActionOverride> {
    if row.len() != ACTION_WIDTH {
        return Err(BindingError::argument(format!(
            "action row must have {ACTION_WIDTH} values, got {}",
            row.len()
        )));
    }
    for (i, v) in row.iter().enumerate() {
        if v.is_infinite() {
            return Err(BindingError::argument(format!(
                "action field {} is infinite",
                ACTION_FIELD_NAMES[i]
            )));
        }
    }

    let motion_direction = match set(row[MOTION_DIRECTION]) {
        None => None,
        Some(v) if v == 1.0 => Some(MotionDirection::Forward),
        Some(v) if v == -1.0 => Some(MotionDirection::Reverse),
        Some(v) => {
            return Err(BindingError::argument(format!(
                "motion_direction must be 1 or -1, got {v}"
            )))
        }
    };

    let control = match (set(row[THROTTLE]), set(row[BRAKE]), set(row[STEER])) {
        (None, None, None) => None,
        (Some(throttle), Some(brake), Some(steer)) => {
            if !(0.0..=1.0).contains(&throttle)
                || !(0.0..=1.0).contains(&brake)
                || !(-1.0..=1.0).contains(&steer)
            {
                return Err(BindingError::argument(format!(
                    "control out of range: throttle {throttle} and brake {brake} must be in [0, 1], steer {steer} in [-1, 1]"
                )));
            }
            Some(VehicleControl {
                throttle,
                brake,
                steer,
                // The batched action row has no handbrake column; a driver
                // command carries it through its own entry point.
                handbrake: false,
            })
        }
        _ => {
            return Err(BindingError::argument(
                "control requires throttle, brake and steer together",
            ))
        }
    };

    let preview_point = match (set(row[PREVIEW_X]), set(row[PREVIEW_Y])) {
        (None, None) => None,
        (Some(x), Some(y)) => Some(Vec2 { x, y }),
        _ => {
            return Err(BindingError::argument(
                "preview point requires preview_x and preview_y together",
            ))
        }
    };
    let preview_heading_rad = set(row[PREVIEW_HEADING_RAD]);
    if preview_heading_rad.is_some() && preview_point.is_none() {
        return Err(BindingError::argument(
            "preview_heading_rad requires a preview point",
        ));
    }

    if let Some(speed) = set(row[TARGET_SPEED_MPS]) {
        if speed < 0.0 {
            return Err(BindingError::argument(format!(
                "target_speed_mps must be >= 0, got {speed}"
            )));
        }
    }

    Ok(ActionOverride {
        motion_direction,
        target_speed_mps: set(row[TARGET_SPEED_MPS]),
        target_acceleration_mps2: set(row[TARGET_ACCELERATION_MPS2]),
        preview_point,
        preview_heading_rad,
        control,
    })
}

/// Inverse of [`decode_action`]; unset fields become `NaN`.
pub fn encode_action(action: &ActionOverride, row: &mut [f64]) {
    assert_eq!(row.len(), ACTION_WIDTH, "action row width");
    row.fill(f64::NAN);
    if let Some(v) = action.target_speed_mps {
        row[TARGET_SPEED_MPS] = v;
    }
    if let Some(v) = action.target_acceleration_mps2 {
        row[TARGET_ACCELERATION_MPS2] = v;
    }
    if let Some(d) = action.motion_direction {
        row[MOTION_DIRECTION] = d.sign();
    }
    if let Some(c) = action.control {
        row[THROTTLE] = c.throttle;
        row[BRAKE] = c.brake;
        row[STEER] = c.steer;
    }
    if let Some(p) = action.preview_point {
        row[PREVIEW_X] = p.x;
        row[PREVIEW_Y] = p.y;
    }
    if let Some(h) = action.preview_heading_rad {
        row[PREVIEW_HEADING_RAD] = h;
    }
}

/// Decode an `(N, ACTION_WIDTH)` row-major matrix into `out` (cleared first).
pub fn decode_action_rows(
    flat: &[f64],
    worlds: usize,
    out: &mut Vec<ActionOverride>,
) -> Result<()> {
    if flat.len() != worlds * ACTION_WIDTH {
        return Err(BindingError::argument(format!(
            "actions must be a ({worlds}, {ACTION_WIDTH}) row-major f64 matrix ({} values), got {} values",
            worlds * ACTION_WIDTH,
            flat.len()
        )));
    }
    out.clear();
    out.reserve(worlds);
    for row in flat.chunks_exact(ACTION_WIDTH) {
        out.push(decode_action(row)?);
    }
    Ok(())
}

/// Decode the JSON object form `{targetSpeedMps?, targetAccelerationMps2?,
/// motionDirection?, control?: {throttle, brake, steer}, previewPoint?: {x, y},
/// previewHeadingRad?}` used at command/metadata boundaries (world commands,
/// policy sessions). Not for the batched hot loop.
pub fn decode_action_json(value: &serde_json::Value) -> Result<ActionOverride> {
    if value.is_null() {
        return Ok(ActionOverride::default());
    }
    let action: ActionOverride = serde_json::from_value(value.clone())
        .map_err(|e| BindingError::argument(format!("invalid action object: {e}")))?;
    let mut row = [0.0; ACTION_WIDTH];
    encode_action(&action, &mut row);
    // Re-run the range/all-or-none rules so both boundaries agree.
    decode_action(&row)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_nan_is_default() {
        let row = [f64::NAN; ACTION_WIDTH];
        let a = decode_action(&row).unwrap();
        assert!(
            a.target_speed_mps.is_none()
                && a.target_acceleration_mps2.is_none()
                && a.motion_direction.is_none()
        );
        assert!(
            a.control.is_none() && a.preview_point.is_none() && a.preview_heading_rad.is_none()
        );
    }

    #[test]
    fn partial_control_rejected() {
        let mut row = [f64::NAN; ACTION_WIDTH];
        row[THROTTLE] = 0.5;
        assert!(decode_action(&row).is_err());
    }

    #[test]
    fn round_trip() {
        let mut row = [f64::NAN; ACTION_WIDTH];
        row[TARGET_SPEED_MPS] = 9.0;
        row[MOTION_DIRECTION] = -1.0;
        row[THROTTLE] = 0.2;
        row[BRAKE] = 0.0;
        row[STEER] = -0.3;
        let a = decode_action(&row).unwrap();
        let mut back = [0.0; ACTION_WIDTH];
        encode_action(&a, &mut back);
        for i in 0..ACTION_WIDTH {
            assert!(
                row[i].is_nan() && back[i].is_nan() || row[i] == back[i],
                "slot {i}"
            );
        }
    }
}
