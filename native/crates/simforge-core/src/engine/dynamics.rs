//! The uniform `dynamics = {shape, constraint, value}` descriptor, turned into
//! a scalar transition profile.
//!
//! | shape        | `f(p)` for `p ∈ [0,1]`                          |
//! |--------------|-------------------------------------------------|
//! | `step`       | `p > 0 ? 1 : 0`                                 |
//! | `linear`     | `p`                                             |
//! | `sinusoidal` | `(1 - cos(πp)) / 2`                             |
//! | `cubic`      | `3p² − 2p³` (smoothstep: zero rate at both ends)|
//!
//! The duration comes from the constraint: `rate` is `|Δ| / value` scaled by
//! the shape's peak factor so `rate` means *peak* rate (R157's reading of
//! lateral velocity); `time` is `value`; `distance` is `value / max(v, 0.1)`.

use crate::math::{clamp, cos};
use crate::types::{Dynamics, DynamicsConstraint, DynamicsShape};

/// Minimum transition duration, seconds. Below this a transition is a step.
pub const MIN_TRANSITION_S: f64 = 1e-6;

#[inline]
pub fn shape_value(shape: DynamicsShape, p: f64) -> f64 {
    let q = clamp(p, 0.0, 1.0);
    match shape {
        DynamicsShape::Step => {
            if q > 0.0 {
                1.0
            } else {
                0.0
            }
        }
        DynamicsShape::Linear => q,
        DynamicsShape::Sinusoidal => (1.0 - cos(std::f64::consts::PI * q)) / 2.0,
        DynamicsShape::Cubic => q * q * (3.0 - 2.0 * q),
    }
}

/// Peak of `df/dp` over `[0,1]` — 1 for linear, π/2 sinusoidal, 3/2 cubic.
#[inline]
pub fn shape_peak_factor(shape: DynamicsShape) -> f64 {
    match shape {
        DynamicsShape::Step | DynamicsShape::Linear => 1.0,
        DynamicsShape::Sinusoidal => std::f64::consts::FRAC_PI_2,
        DynamicsShape::Cubic => 1.5,
    }
}

/// Duration of a transition of magnitude `delta` under `dyn`.
pub fn transition_duration(dynamics: &Dynamics, delta: f64, reference_speed_mps: f64) -> f64 {
    let mag = delta.abs();
    if dynamics.shape == DynamicsShape::Step {
        return MIN_TRANSITION_S;
    }
    match dynamics.constraint {
        DynamicsConstraint::Rate => {
            if mag < 1e-9 {
                MIN_TRANSITION_S
            } else {
                (mag / dynamics.value) * shape_peak_factor(dynamics.shape)
            }
        }
        DynamicsConstraint::Time => dynamics.value.max(MIN_TRANSITION_S),
        DynamicsConstraint::Distance => {
            (dynamics.value / reference_speed_mps.max(0.1)).max(MIN_TRANSITION_S)
        }
    }
}

/// Value of a transition from `from` to `to` at elapsed time `elapsed`.
#[inline]
pub fn transition_value(
    dynamics: &Dynamics,
    from: f64,
    to: f64,
    elapsed: f64,
    duration_s: f64,
) -> f64 {
    let p = if duration_s <= MIN_TRANSITION_S {
        1.0
    } else {
        clamp(elapsed / duration_s, 0.0, 1.0)
    };
    from + (to - from) * shape_value(dynamics.shape, p)
}
