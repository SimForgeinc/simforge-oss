//! Physical-plausibility audit of a recorded trace.
//!
//! The engine's motion is supposed to be physical, so a trace is checked for
//! motion no vehicle can perform, tick by tick, from what the trace itself
//! publishes (pose, speed and the contact channel):
//!
//! | code | fails when |
//! |---|---|
//! | `rotation_at_rest` | a wheeled body's heading changes while its speed is zero |
//! | `yaw_rate_exceeds_rolling_envelope` | a wheeled body turns faster than rolling allows, `|dpsi/dt| > |v| tan(max steer) / wheelbase` |
//! | `displacement_exceeds_speed` | a body moves farther in a tick than its speed covers (a teleport or a slide at rest) |
//! | `speed_step_exceeds_tyre_limit` | speed changes faster than tyres can change it (1.5 g) |
//! | `lateral_acceleration_exceeds_tyre_limit` | `|v dpsi/dt|` above what tyres can hold (1.5 g) |
//! | `jerk_exceeds_limit` | acceleration changes by more than 1.5 g inside one tick |
//!
//! Point agents (walkers, animals, sidewalk robots, drones) may turn on the
//! spot, so only the displacement and tyre-limit checks apply to them.
//!
//! Contact is physical and exempt: on a tick that carried a contact impulse
//! nothing is checked, and a spin a contact gave a body may continue past the
//! rolling envelope only while it decays — the same rule `dynamic-v1`
//! integrates by. From a body's first material impact
//! (`header.physics.crashes`) on, it is a wreck driven by contact and sliding
//! friction rather than by its tyres and controller, and is not checked.
//!
//! A finding on the tick an explicit engine guard stopped the body — today the
//! generated-traffic `road_departure_prevented` hold — is reported with
//! `explained_by` naming that event. It is still implausible motion, but it is
//! already surfaced by its own event, so it is not an unexplained regression.
//!
//! The wheelbase and steering lock are the class defaults for the actor's
//! kind; the trace does not carry per-actor profile overrides.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::math::{angle_delta, hypot};
use crate::physics::{actor_physics_profile, ResolvedVehiclePhysicsProfile, STANDARD_GRAVITY_MPS2};
use crate::types::ActorKind;

use super::{precision, SimEvent, SimTrace};

/// No rubber tyre on a road produces this much longitudinal or lateral
/// acceleration; a trace that shows more has placed the body, not driven it.
pub const TYRE_ACCELERATION_CEILING_MPS2: f64 = 1.5 * STANDARD_GRAVITY_MPS2;

/// Largest change of acceleration inside one tick. A stop releases the brake
/// reaction at once (a real, felt jolt), which is well inside this; a pose
/// snap is far outside it.
pub const JERK_CEILING_MPS2_PER_TICK: f64 = 1.5 * STANDARD_GRAVITY_MPS2;

/// Trace channels are quantised before they are published; the audit allows
/// one quantum of rounding at each end of a tick.
const HEADING_QUANTUM_RAD: f64 = 1e-6;
const SPEED_QUANTUM_MPS: f64 = 1e-4;
const POSITION_QUANTUM_M: f64 = 1e-4;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MotionFindingCode {
    RotationAtRest,
    YawRateExceedsRollingEnvelope,
    DisplacementExceedsSpeed,
    SpeedStepExceedsTyreLimit,
    LateralAccelerationExceedsTyreLimit,
    JerkExceedsLimit,
}

impl MotionFindingCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::RotationAtRest => "rotation_at_rest",
            Self::YawRateExceedsRollingEnvelope => "yaw_rate_exceeds_rolling_envelope",
            Self::DisplacementExceedsSpeed => "displacement_exceeds_speed",
            Self::SpeedStepExceedsTyreLimit => "speed_step_exceeds_tyre_limit",
            Self::LateralAccelerationExceedsTyreLimit => "lateral_acceleration_exceeds_tyre_limit",
            Self::JerkExceedsLimit => "jerk_exceeds_limit",
        }
    }
}

/// One implausible tick transition `(t - dt, t]` of one actor.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MotionFinding {
    pub actor_id: String,
    pub code: MotionFindingCode,
    /// End of the offending tick.
    pub t: f64,
    /// What the trace shows, in the check's unit (rad, rad/s, m, m/s², m/s² per tick).
    pub measured: f64,
    /// The largest value the check allows on that tick.
    pub limit: f64,
    pub ambient: bool,
    /// The engine event that already reports this stop, when one does.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub explained_by: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MotionAudit {
    /// Tick transitions that were checked (present at both ends, no contact).
    pub checked_transitions: usize,
    pub findings: Vec<MotionFinding>,
}

impl MotionAudit {
    /// Findings no engine event already accounts for.
    pub fn unexplained(&self) -> impl Iterator<Item = &MotionFinding> {
        self.findings.iter().filter(|f| f.explained_by.is_none())
    }

    pub fn is_plausible(&self) -> bool {
        self.unexplained().next().is_none()
    }
}

/// Audit `trace` with each actor's class-default profile.
pub fn audit_motion(trace: &SimTrace) -> MotionAudit {
    audit_motion_with(trace, |_, kind| actor_physics_profile(kind).copied())
}

/// Audit `trace` with a caller-supplied profile per actor (the engine passes
/// the exact resolved profiles it integrated with). `None` skips the
/// profile-dependent yaw checks for that actor.
pub fn audit_motion_with(
    trace: &SimTrace,
    profile_of: impl Fn(&str, ActorKind) -> Option<ResolvedVehiclePhysicsProfile>,
) -> MotionAudit {
    let t = &trace.ticks.t;
    let ambient: BTreeSet<&str> = trace
        .header
        .ambient_actor_ids
        .iter()
        .flatten()
        .map(String::as_str)
        .collect();
    let mut guard_stops: BTreeMap<&str, Vec<f64>> = BTreeMap::new();
    let mut prescribed: BTreeMap<&str, Vec<(f64, f64)>> = BTreeMap::new();
    for event in &trace.events {
        match event {
            SimEvent::RoadDeparturePrevented { t, actor_id, .. } => {
                guard_stops.entry(actor_id.as_str()).or_default().push(*t);
            }
            SimEvent::PrescribedMotion { t, actor_id, until_t, .. } => {
                prescribed.entry(actor_id.as_str()).or_default().push((*t, *until_t));
            }
            _ => {}
        }
    }
    let dt_nominal = trace.header.dt;
    let mut audit = MotionAudit::default();
    for (id, track) in &trace.ticks.actors {
        let Some(meta) = trace.header.actor_metadata.get(id) else {
            continue;
        };
        if meta.is_static || meta.kind == ActorKind::StaticObject {
            continue;
        }
        let profile = profile_of(id, meta.kind);
        let crashed_at = trace.header.physics.crashes.get(id).map(|c| c.t);
        let is_ambient = ambient.contains(id.as_str());
        let explained = |at: f64| -> Option<String> {
            guard_stops
                .get(id.as_str())
                .and_then(|stops| {
                    stops
                        .iter()
                        // The guard decides at `s`, publishes the held pose one
                        // tick later, and the acceleration it zeroes shows up as
                        // jerk the tick after that.
                        .any(|&s| at >= s - 1e-9 && at <= s + 2.5 * dt_nominal)
                        .then(|| "road_departure_prevented".to_owned())
                })
                .or_else(|| {
                    // An authored transition executes its shape exactly, steps
                    // included; the motion it prescribes is explained by it (its
                    // first effect shows one tick after it fires, and a jump's
                    // jerk the tick after that).
                    prescribed.get(id.as_str()).and_then(|windows| {
                        windows
                            .iter()
                            .any(|&(from, until)| at >= from - 1e-9 && at <= until + 2.5 * dt_nominal)
                            .then(|| "prescribed_motion".to_owned())
                    })
                })
        };
        let contact = |i: usize| -> bool {
            track
                .physics
                .as_ref()
                .is_some_and(|p| p.collision_count.get(i).is_some_and(|c| *c > 0.0))
        };
        let planar_speed = |i: usize| -> f64 {
            let lateral = track
                .physics
                .as_ref()
                .and_then(|p| p.vy_body_mps.get(i).copied())
                .unwrap_or(0.0);
            hypot(track.speed_mps[i], lateral)
        };
        let mut findings: Vec<MotionFinding> = Vec::new();
        let mut checked = 0usize;
        let mut push = |code: MotionFindingCode, at: f64, measured: f64, limit: f64| {
            findings.push(MotionFinding {
                actor_id: id.clone(),
                code,
                t: at,
                measured,
                limit,
                ambient: is_ambient,
                explained_by: explained(at),
            });
        };
        // Yaw a contact imparted beyond the envelope; may only decay.
        let mut contact_spin = 0.0f64;
        let mut previous_accel: Option<f64> = None;
        for i in 1..t.len() {
            if !track.is_present(i) || !track.is_present(i - 1) {
                contact_spin = 0.0;
                previous_accel = None;
                continue;
            }
            let dt = t[i] - t[i - 1];
            if !(dt > 0.0) {
                continue;
            }
            let yaw_step = angle_delta(track.heading_rad[i - 1], track.heading_rad[i]);
            if contact(i) {
                contact_spin = contact_spin.max(yaw_step.abs() / dt);
                previous_accel = None;
                continue;
            }
            let at = t[i];
            if crashed_at.is_some_and(|c| c <= at + 1e-9) {
                break;
            }
            checked += 1;
            let v0 = track.speed_mps[i - 1];
            let v1 = track.speed_mps[i];
            let v_max = v0.abs().max(v1.abs());

            let accel = (v1 - v0) / dt;
            let accel_slack = 2.0 * SPEED_QUANTUM_MPS / dt;
            if accel.abs() > TYRE_ACCELERATION_CEILING_MPS2 + accel_slack {
                push(
                    MotionFindingCode::SpeedStepExceedsTyreLimit,
                    at,
                    accel.abs(),
                    TYRE_ACCELERATION_CEILING_MPS2,
                );
            }
            if let Some(previous) = previous_accel {
                let change = (accel - previous).abs();
                if change > JERK_CEILING_MPS2_PER_TICK + 2.0 * accel_slack {
                    push(
                        MotionFindingCode::JerkExceedsLimit,
                        at,
                        change,
                        JERK_CEILING_MPS2_PER_TICK,
                    );
                }
            }
            previous_accel = Some(accel);

            let moved = hypot(track.x[i] - track.x[i - 1], track.y[i] - track.y[i - 1]);
            let reach = planar_speed(i).max(planar_speed(i - 1)) * dt * 1.05
                + 2.0 * POSITION_QUANTUM_M
                + SPEED_QUANTUM_MPS * dt;
            if moved > reach {
                push(
                    MotionFindingCode::DisplacementExceedsSpeed,
                    at,
                    moved,
                    reach,
                );
            }

            let yaw_rate = yaw_step.abs() / dt;
            let lateral = 0.5 * (v0.abs() + v1.abs()) * yaw_rate;
            if lateral > TYRE_ACCELERATION_CEILING_MPS2 {
                push(
                    MotionFindingCode::LateralAccelerationExceedsTyreLimit,
                    at,
                    lateral,
                    TYRE_ACCELERATION_CEILING_MPS2,
                );
            }

            let Some(profile) = profile.as_ref() else {
                continue;
            };
            let Some(envelope) = profile.rolling_yaw_rate_limit_radps(v_max + SPEED_QUANTUM_MPS)
            else {
                continue;
            };
            // Trapezoidal integration inside a tick can put the mean rate a
            // hair above the endpoint envelope while the speed changes.
            let allowed = envelope * 1.02 + 2.0 * HEADING_QUANTUM_RAD / dt;
            if yaw_rate <= allowed {
                contact_spin = 0.0;
                continue;
            }
            if contact_spin > 0.0 && yaw_rate <= contact_spin + 2.0 * HEADING_QUANTUM_RAD / dt {
                contact_spin = yaw_rate;
                continue;
            }
            contact_spin = 0.0;
            if v0 == 0.0 && v1 == 0.0 {
                push(
                    MotionFindingCode::RotationAtRest,
                    at,
                    yaw_step.abs(),
                    2.0 * HEADING_QUANTUM_RAD,
                );
            } else {
                push(
                    MotionFindingCode::YawRateExceedsRollingEnvelope,
                    at,
                    yaw_rate,
                    allowed,
                );
            }
        }
        audit.checked_transitions += checked;
        audit.findings.append(&mut findings);
    }
    audit
}

/// Keep precision constants honest: the audit's quanta must be the ones the
/// trace is published at.
const _: () = {
    assert!(precision::HEADING == 6);
    assert!(precision::SPEED == 4);
    assert!(precision::POSITION == 4);
};

#[cfg(test)]
mod tests {
    use super::*;

    fn wheeled() -> ResolvedVehiclePhysicsProfile {
        *actor_physics_profile(ActorKind::Car).unwrap()
    }

    #[test]
    fn envelope_is_zero_at_rest_and_linear_in_speed() {
        let p = wheeled();
        assert_eq!(p.rolling_yaw_rate_limit_radps(0.0), Some(0.0));
        let at_two = p.rolling_yaw_rate_limit_radps(2.0).unwrap();
        let at_four = p.rolling_yaw_rate_limit_radps(-4.0).unwrap();
        assert!((at_four - 2.0 * at_two).abs() < 1e-12);
        assert_eq!(
            actor_physics_profile(ActorKind::Pedestrian)
                .unwrap()
                .rolling_yaw_rate_limit_radps(1.0),
            None
        );
    }
}
