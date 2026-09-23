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
//! lateral velocity); `time` is `value`; `distance` is `value / max(v, 0.1)`
//! as a nominal duration only.
//!
//! A `distance` constraint is a function of travelled distance, not of time
//! (ASAM OpenSCENARIO XML `DynamicsShape`: "change … over time or distance";
//! docs/engineering/openscenario-conformance.md D-02): progress is
//! `p = s / value` where `s` is the distance travelled since the transition
//! started. [`SpeedProfile`] integrates that exactly for speed changes.

use crate::math::{clamp, cos, sin};
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

/// `df/dp` of the shape at `p` (0 outside `[0,1]` and for `step`).
#[inline]
pub fn shape_derivative(shape: DynamicsShape, p: f64) -> f64 {
    if !(0.0..=1.0).contains(&p) {
        return 0.0;
    }
    match shape {
        DynamicsShape::Step => 0.0,
        DynamicsShape::Linear => 1.0,
        DynamicsShape::Sinusoidal => std::f64::consts::FRAC_PI_2 * sin(std::f64::consts::PI * p),
        DynamicsShape::Cubic => 6.0 * p * (1.0 - p),
    }
}

/// `d²f/dp²` of the shape at `p` (0 outside `[0,1]`, for `step` and `linear`).
#[inline]
pub fn shape_second_derivative(shape: DynamicsShape, p: f64) -> f64 {
    if !(0.0..=1.0).contains(&p) {
        return 0.0;
    }
    match shape {
        DynamicsShape::Step | DynamicsShape::Linear => 0.0,
        DynamicsShape::Sinusoidal => {
            std::f64::consts::PI * std::f64::consts::FRAC_PI_2 * cos(std::f64::consts::PI * p)
        }
        DynamicsShape::Cubic => 6.0 - 12.0 * p,
    }
}

/// One tick of a prescribed speed transition (an OpenSCENARIO SpeedAction
/// with a fixed target): the speed at the end of the tick, the distance the
/// profile covers during it, and the new travelled-distance progress.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SpeedProfileStep {
    pub speed_mps: f64,
    pub distance_m: f64,
    pub progress_m: f64,
    /// The transition has reached its target by the end of this tick.
    pub done: bool,
    /// Instantaneous acceleration at the end of the tick (0 once done): what
    /// a body re-seated on the profile carries into the next step.
    pub accel_mps2: f64,
}

/// Exact evaluation of a speed transition from `v0` to `target`.
///
/// - time and rate constraints: `v(τ) = v0 + Δ f(τ / T)`; the covered
///   distance is the Simpson integral of `v` over the tick (exact for linear
///   and cubic shapes, 1e-7 relative for sinusoidal at 20 ms);
/// - distance constraint: `v(s) = v0 + Δ f(s / D)`; `ds/dt = v(s)` is
///   integrated with four RK4 substeps;
/// - step: the target holds from the start of the tick that starts the
///   transition ("does not consume simulation time").
pub struct SpeedProfile<'a> {
    pub dynamics: &'a Dynamics,
    pub v0: f64,
    pub target: f64,
    pub duration_s: f64,
}

impl SpeedProfile<'_> {
    #[inline]
    fn at_time(&self, elapsed: f64) -> f64 {
        if self.dynamics.shape == DynamicsShape::Step {
            return if elapsed > 1e-12 { self.target } else { self.v0 };
        }
        transition_value(self.dynamics, self.v0, self.target, elapsed, self.duration_s)
    }

    #[inline]
    fn at_distance(&self, s: f64) -> f64 {
        let d = self.dynamics.value.max(1e-9);
        self.v0 + (self.target - self.v0) * shape_value(self.dynamics.shape, s / d)
    }

    /// Advance over `[elapsed, elapsed + dt]` from travelled progress `progress_m`.
    pub fn step(&self, elapsed: f64, dt: f64, progress_m: f64) -> SpeedProfileStep {
        if self.dynamics.shape == DynamicsShape::Step || self.dynamics.constraint != DynamicsConstraint::Distance {
            let v_start = self.at_time(elapsed);
            let v_end = self.at_time(elapsed + dt);
            let distance = if self.dynamics.shape == DynamicsShape::Step {
                // The step lands at the start of the tick.
                self.target.max(0.0) * dt
            } else {
                let v_mid = self.at_time(elapsed + dt / 2.0);
                (v_start + 4.0 * v_mid + v_end) * dt / 6.0
            };
            let done = self.dynamics.shape == DynamicsShape::Step
                || elapsed + dt >= self.duration_s - 1e-9;
            let accel = if done || self.duration_s <= MIN_TRANSITION_S {
                0.0
            } else {
                (self.target - self.v0)
                    * shape_derivative(self.dynamics.shape, (elapsed + dt) / self.duration_s)
                    / self.duration_s
            };
            return SpeedProfileStep {
                speed_mps: if done { self.target } else { v_end },
                distance_m: distance.max(0.0),
                progress_m: progress_m + distance.max(0.0),
                done,
                accel_mps2: accel,
            };
        }
        let d_total = self.dynamics.value;
        let h = dt / 4.0;
        let mut s = progress_m;
        let rate = |s: f64| self.at_distance(s.min(d_total)).max(0.0);
        for _ in 0..4 {
            if s >= d_total {
                s += self.target.max(0.0) * h;
                continue;
            }
            let k1 = rate(s);
            let k2 = rate(s + h / 2.0 * k1);
            let k3 = rate(s + h / 2.0 * k2);
            let k4 = rate(s + h * k3);
            s += h / 6.0 * (k1 + 2.0 * k2 + 2.0 * k3 + k4);
        }
        let done = s >= d_total - 1e-9;
        let speed = if done { self.target } else { self.at_distance(s) };
        // dv/dt = dv/ds · ds/dt = Δ f'(s/D) / D · v
        let accel = if done {
            0.0
        } else {
            (self.target - self.v0) * shape_derivative(self.dynamics.shape, s / d_total) / d_total
                * speed
        };
        SpeedProfileStep {
            speed_mps: speed,
            distance_m: s - progress_m,
            progress_m: s,
            done,
            accel_mps2: accel,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dynamics(shape: DynamicsShape, constraint: DynamicsConstraint, value: f64) -> Dynamics {
        Dynamics { shape, constraint, value }
    }

    #[test]
    fn linear_time_profile_integrates_exactly() {
        let d = dynamics(DynamicsShape::Linear, DynamicsConstraint::Time, 2.5);
        let p = SpeedProfile { dynamics: &d, v0: 20.0, target: 10.0, duration_s: 2.5 };
        let (mut elapsed, mut progress) = (0.0, 0.0);
        let mut last = p.step(0.0, 0.02, 0.0);
        while !last.done {
            last = p.step(elapsed, 0.02, progress);
            progress = last.progress_m;
            elapsed += 0.02;
        }
        assert!((progress - 37.5).abs() < 1e-9, "{progress}");
        assert_eq!(last.speed_mps, 10.0);
    }

    #[test]
    fn distance_profile_follows_travelled_distance() {
        // v(s) = 20 − s/3 over 30 m: s(t) = 60(1 − e^{−t/3}), done at 3 ln 2.
        let d = dynamics(DynamicsShape::Linear, DynamicsConstraint::Distance, 30.0);
        let p = SpeedProfile { dynamics: &d, v0: 20.0, target: 10.0, duration_s: 1.5 };
        let (mut elapsed, mut progress, mut done_at) = (0.0, 0.0, None);
        while elapsed < 4.0 {
            let st = p.step(elapsed, 0.02, progress);
            progress = st.progress_m;
            elapsed += 0.02;
            if st.done && done_at.is_none() {
                done_at = Some(elapsed);
            }
            if (elapsed - 2.0).abs() < 1e-9 {
                assert!((progress - 60.0 * (1.0 - (-2.0f64 / 3.0).exp())).abs() < 1e-6, "{progress}");
            }
        }
        let expected = 3.0 * 2.0f64.ln();
        assert!((done_at.unwrap() - expected).abs() <= 0.02 + 1e-9, "{done_at:?}");
    }

    #[test]
    fn shape_derivatives_match_the_values() {
        for shape in [DynamicsShape::Linear, DynamicsShape::Cubic, DynamicsShape::Sinusoidal] {
            for i in 1..10 {
                let p = f64::from(i) / 10.0;
                let numeric = (shape_value(shape, p + 1e-6) - shape_value(shape, p - 1e-6)) / 2e-6;
                assert!((numeric - shape_derivative(shape, p)).abs() < 1e-6);
                let numeric2 = (shape_derivative(shape, p + 1e-6) - shape_derivative(shape, p - 1e-6)) / 2e-6;
                assert!((numeric2 - shape_second_derivative(shape, p)).abs() < 1e-4);
            }
        }
    }
}
