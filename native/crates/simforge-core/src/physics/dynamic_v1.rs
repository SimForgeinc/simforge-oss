//! `dynamic-v1`: deterministic planar force-based roadway backend.
//!
//! Vehicles run a single-track model with load transfer, tyre friction
//! ellipses, a rear-drive / 60-40 brake split, steer clamp + rate + lag, and a
//! jerk-limited setpoint (or raw actuator) controller. Walkers, animals,
//! sidewalk robots and drones run a bounded point agent; a walker that has
//! been knocked down becomes a passive sliding body. After every engine tick
//! [`DynamicV1Backend::step_world`] resolves all bodies together with the
//! sequential-impulse contact solver.

use std::cmp::Ordering;
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::collision::{
    ContactPose, ContactRef, PlanarCollisionBody, PlanarContactSolver, PlanarStaticCollider,
    DEFAULT_CONTACT_FRICTION, DEFAULT_CONTACT_RESTITUTION,
};
use super::gearbox::{gearbox_for, GearDemand, GEAR_NEUTRAL, GEAR_REVERSE};
use super::motion::{
    BodyIndex, MotionActorInitialization, MotionBackend, MotionIntent, MotionStepResult,
    PhysicsError, PhysicsTelemetrySample, VehicleControl, VehicleMotionState,
};
use super::profile::{resolve_actor_physics_profile, DynamicsModel, ResolvedVehiclePhysicsProfile};
use crate::hash::cmp_locale;
use crate::math::{
    angle_delta, atan2, clamp, cos, hypot, normalize_angle, sin, sin_cos, tanh, Obb, Vec2,
};
use crate::types::ActorKind;

pub const DYNAMIC_V1_ID: &str = "dynamic-v1";
pub const DYNAMIC_V1_VERSION: u32 = 1;
pub const DYNAMIC_V1_DEFAULT_SUBSTEP_S: f64 = 0.005;
pub const STANDARD_GRAVITY_MPS2: f64 = 9.80665;
const G: f64 = STANDARD_GRAVITY_MPS2;

/// Clothed body sliding on asphalt. Chosen to be recognisably slower than a
/// braking tyre and faster than ice; it governs how far a struck body travels
/// after the impulse, not any injury or damage claim.
pub const SLIDING_FRICTION_COEFFICIENT: f64 = 0.55;

/// The sideways velocity a walker can still catch itself from, in m/s. A
/// contact that *adds* more than this takes the body down.
///
/// Human balance recovery, not a crash-load threshold: a stumble is
/// recoverable, being hit by a car at any real speed is not. It is measured
/// against the velocity the contact added rather than the impulse it carried,
/// so a walker who strides into a parked car — same order of impulse, but only
/// their own momentum being arrested — keeps their feet. The outer engine
/// applies this against [`VehicleMotionState::planar_speed_mps`] before and
/// after [`DynamicV1Backend::step_world`].
pub const BALANCE_RECOVERY_DELTA_V_MPS: f64 = 0.6;

const DEFAULT_FOOTPRINT_LENGTH_M: f64 = 4.8;
const DEFAULT_FOOTPRINT_WIDTH_M: f64 = 1.9;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VehicleEntry {
    profile: ResolvedVehiclePhysicsProfile,
    state: VehicleMotionState,
    /// Pose at the start of the current tick: origin of the swept contact.
    previous: ContactPose,
    telemetry: PhysicsTelemetrySample,
    commanded_acceleration_mps2: f64,
    /// Engaged gear: `0` neutral, `1..=n` forward, `-1` reverse.
    #[serde(default)]
    gear: i32,
    /// Remaining torque cut of the shift in progress, seconds.
    #[serde(default)]
    shift_cut_remaining_s: f64,
    length_m: f64,
    width_m: f64,
}

#[inline]
fn zero_telemetry(substep_s: f64) -> PhysicsTelemetrySample {
    PhysicsTelemetrySample {
        substep_s,
        ..PhysicsTelemetrySample::default()
    }
}

/// Setpoint controller: speed/acceleration tracking plus pure-pursuit steering
/// toward the preview point with a heading correction. `drive_capacity_n` is
/// the tractive force a fully open throttle delivers in the engaged gear, so
/// the pedal the controller asks for means the same force the integrator will
/// produce.
fn control_for(
    state: &VehicleMotionState,
    profile: &ResolvedVehiclePhysicsProfile,
    intent: &MotionIntent,
    drive_capacity_n: f64,
) -> VehicleControl {
    let direction = intent.motion_direction.sign();
    let travel_speed = direction * state.longitudinal_velocity_mps;
    let speed_error = intent.target_speed_mps - travel_speed;
    let desired_accel = clamp(
        intent.target_acceleration_mps2 + 1.25 * speed_error,
        -profile.max_longitudinal_decel_mps2,
        profile.max_longitudinal_accel_mps2,
    );
    // `drag * v ** 2` in the reference squares first; keep that association.
    let resistance = profile.drag_coefficient_n_per_mps2 * (travel_speed * travel_speed)
        + profile.rolling_resistance_coefficient * profile.mass_kg * G;
    let requested_force = profile.mass_kg * desired_accel + resistance;
    let throttle = clamp(requested_force / drive_capacity_n, 0.0, 1.0);
    let brake = clamp(-requested_force / profile.max_brake_force_n, 0.0, 1.0);

    let dx = intent.preview_point.x - state.x;
    let dy = intent.preview_point.y - state.y;
    let preview_distance = hypot(dx, dy).max(1.0);
    let bearing = atan2(dy, dx);
    let tracking_yaw = normalize_angle(
        state.yaw_rad
            + if direction < 0.0 {
                std::f64::consts::PI
            } else {
                0.0
            },
    );
    let alpha = angle_delta(tracking_yaw, bearing);
    let pure_pursuit = atan2(2.0 * profile.wheelbase_m * sin(alpha), preview_distance);
    let heading_correction = 0.35 * angle_delta(tracking_yaw, intent.preview_heading_rad);
    let steer_rad = clamp(
        direction * (pure_pursuit + heading_correction),
        -profile.max_steer_rad,
        profile.max_steer_rad,
    );
    VehicleControl {
        throttle,
        brake,
        steer: steer_rad / profile.max_steer_rad,
        handbrake: false,
    }
}

struct EllipseLateral {
    force: f64,
    utilization: f64,
}

#[inline]
fn friction_ellipse_lateral(desired_fy: f64, fx: f64, normal_n: f64, mu: f64) -> EllipseLateral {
    let capacity = (mu * normal_n).max(1.0);
    let remaining = (capacity * capacity - fx * fx).max(0.0).sqrt();
    let force = clamp(desired_fy, -remaining, remaining);
    EllipseLateral {
        force,
        utilization: hypot(fx, force) / capacity,
    }
}

/// Jerk-limit the requested longitudinal acceleration against the body's
/// commanded value and return the intent with the bounded target.
fn bounded_intent(entry: &mut VehicleEntry, intent: &MotionIntent, h: f64) -> MotionIntent {
    let p = &entry.profile;
    let requested = clamp(
        intent.target_acceleration_mps2,
        -p.max_longitudinal_decel_mps2,
        p.max_longitudinal_accel_mps2,
    );
    let delta = clamp(
        requested - entry.commanded_acceleration_mps2,
        -p.max_jerk_mps3 * h,
        p.max_jerk_mps3 * h,
    );
    entry.commanded_acceleration_mps2 += delta;
    MotionIntent {
        target_acceleration_mps2: entry.commanded_acceleration_mps2,
        ..*intent
    }
}

/// Clamp a raw actuator request into the profile envelope. Throttle/brake are
/// folded into one longitudinal force request, rate-limited by the same jerk
/// budget the setpoint path uses, then split back into unit-range pedals;
/// steer is clamped to the unit range (the integrate step applies the profile
/// clamp plus rate/lag on top). The handbrake is deliberately *not* folded
/// in: it is a mechanical rear-axle brake, not a pedal request, and passes
/// through unrate-limited.
fn bounded_control(
    entry: &mut VehicleEntry,
    control: &VehicleControl,
    h: f64,
    drive_capacity_n: f64,
) -> VehicleControl {
    let p = &entry.profile;
    let throttle = clamp(control.throttle, 0.0, 1.0);
    let brake = clamp(control.brake, 0.0, 1.0);
    let steer = clamp(control.steer, -1.0, 1.0);
    let requested_ax = (throttle * drive_capacity_n - brake * p.max_brake_force_n) / p.mass_kg;
    let bounded_ax = clamp(
        requested_ax,
        -p.max_longitudinal_decel_mps2,
        p.max_longitudinal_accel_mps2,
    );
    let delta = clamp(
        bounded_ax - entry.commanded_acceleration_mps2,
        -p.max_jerk_mps3 * h,
        p.max_jerk_mps3 * h,
    );
    entry.commanded_acceleration_mps2 += delta;
    let force_n = entry.commanded_acceleration_mps2 * p.mass_kg;
    if force_n >= 0.0 {
        VehicleControl {
            throttle: clamp(force_n / drive_capacity_n, 0.0, 1.0),
            brake: 0.0,
            steer,
            handbrake: control.handbrake,
        }
    } else {
        VehicleControl {
            throttle: 0.0,
            brake: clamp(-force_n / p.max_brake_force_n, 0.0, 1.0),
            steer,
            handbrake: control.handbrake,
        }
    }
}

/// Drivetrain state for one substep: the engaged gear, its engine speed, the
/// tractive force a fully open throttle delivers through it, and whether a
/// shift is currently cutting torque.
struct Driveline {
    gear: i32,
    rpm: f64,
    drive_capacity_n: f64,
    cutting: bool,
}

/// Run the automatic's shift schedule for one *tick*.
///
/// Deliberately per tick rather than per substep: a transmission controller
/// runs at the control rate, and tying the shift instant to the integrator's
/// substep would make a discrete event move with the substep size, so two
/// substep resolutions of the same scenario would diverge at every shift.
fn engage_gear(entry: &mut VehicleEntry, intent: &MotionIntent, dt_s: f64) {
    let Some(gearbox) = gearbox_for(entry.profile.kind) else {
        return;
    };
    entry.shift_cut_remaining_s = (entry.shift_cut_remaining_s - dt_s).max(0.0);
    // The pedals this tick, not last tick's: a body launching from rest must
    // engage first gear on the tick the throttle opens, not one tick later.
    let demand = match &intent.control {
        Some(raw) => GearDemand::Pedals {
            throttle: clamp(raw.throttle, 0.0, 1.0),
            brake: clamp(raw.brake, 0.0, 1.0),
        },
        None => {
            let travel = intent.motion_direction.sign() * entry.state.longitudinal_velocity_mps;
            let wants_drive = intent.target_speed_mps > travel + 1e-9
                || intent.target_acceleration_mps2 > 0.0;
            GearDemand::Authored {
                reverse: intent.motion_direction.sign() < 0.0,
                throttle: if wants_drive { 1.0 } else { 0.0 },
            }
        }
    };
    let (gear, shifted) = gearbox.select(
        entry.gear,
        entry.state.longitudinal_velocity_mps,
        entry.state.wheel_angular_speed_radps,
        demand,
    );
    if shifted && gear != entry.gear {
        entry.shift_cut_remaining_s = gearbox.shift_time_s;
        // The pedal envelope rate-limits acceleration *in the engaged gear*.
        // Taking reverse (or leaving it) reverses what that number means, so
        // carrying it across would spend the jerk budget unwinding the old
        // direction — a car that just engaged drive would sit there braking.
        // The drivetrain is disconnected for the torque cut anyway: there is
        // no acceleration in progress to ramp from.
        if (gear < GEAR_NEUTRAL) != (entry.gear < GEAR_NEUTRAL) {
            entry.commanded_acceleration_mps2 = 0.0;
        }
    }
    entry.gear = gear;
}

/// Engine speed and available tractive force in the engaged gear. Continuous
/// in the body's wheel speed, so it is safe to evaluate every substep.
fn driveline(entry: &VehicleEntry) -> Driveline {
    let Some(gearbox) = gearbox_for(entry.profile.kind) else {
        return Driveline {
            gear: GEAR_NEUTRAL,
            rpm: 0.0,
            drive_capacity_n: entry.profile.max_drive_force_n,
            cutting: false,
        };
    };
    let gear = entry.gear;
    let rpm = gearbox.engine_rpm(gear, entry.state.wheel_angular_speed_radps);
    // Neutral has no drive path, but the pedal maps divide by this value;
    // quote the lowest gear's capacity so a pedal keeps its meaning, and let
    // `cutting` be what actually withholds the force.
    let force_gear = if gear == GEAR_NEUTRAL { 1 } else { gear };
    Driveline {
        gear,
        rpm,
        drive_capacity_n: entry.profile.max_drive_force_n
            * gearbox.drive_force_factor(force_gear, rpm),
        cutting: entry.shift_cut_remaining_s > 0.0 || gear == GEAR_NEUTRAL,
    }
}

fn integrate(
    entry: &mut VehicleEntry,
    intent: &MotionIntent,
    h: f64,
    friction_scale: f64,
) -> PhysicsTelemetrySample {
    if entry.profile.dynamics_model == DynamicsModel::PedestrianAgent {
        return if intent.downed {
            integrate_downed(entry, h, friction_scale)
        } else {
            integrate_pedestrian(entry, intent, h, friction_scale)
        };
    }
    let drive = driveline(entry);
    // Which way the drivetrain is allowed to push. An authored actor states
    // its travel direction outright and its gear mirrors it. A pedal-driven
    // body takes it from the engaged gear: the command carries no gear lever,
    // so reverse is reached the way an automatic reaches it — stopped, on the
    // brake — and the gear is then what makes the car actually go backwards.
    let travel_sign = match &intent.control {
        Some(_) if drive.gear == GEAR_REVERSE => -1.0,
        Some(_) => 1.0,
        None => intent.motion_direction.sign(),
    };
    // A raw actuator request bypasses the setpoint controller but not the
    // physical envelope: steer still passes through the clamp/rate/lag block
    // below, and the implied longitudinal acceleration is jerk-limited so a
    // passthrough caller cannot step the drivetrain harder than a setpoint
    // caller could.
    let control = match &intent.control {
        Some(raw) => {
            // In reverse the two pedals swap roles: the brake pedal is the
            // one asking the car to move, and the throttle is the service
            // brake. Normalising here means everything downstream — the jerk
            // envelope, the force split, the telemetry — reads one pair,
            // (drive demand, braking demand) in the engaged gear.
            let demand = if travel_sign < 0.0 {
                VehicleControl {
                    throttle: raw.brake,
                    brake: raw.throttle,
                    ..*raw
                }
            } else {
                *raw
            };
            bounded_control(entry, &demand, h, drive.drive_capacity_n)
        }
        None => {
            let bounded = bounded_intent(entry, intent, h);
            control_for(
                &entry.state,
                &entry.profile,
                &bounded,
                drive.drive_capacity_n,
            )
        }
    };
    let p = entry.profile;
    let width_m = entry.width_m;
    let s = &mut entry.state;

    let steer_target = control.steer * p.max_steer_rad;
    let steer_derivative = clamp(
        (steer_target - s.steer_rad) / p.steer_time_constant_s,
        -p.steer_rate_rad_per_s,
        p.steer_rate_rad_per_s,
    );
    s.steer_rad = clamp(
        s.steer_rad + steer_derivative * h,
        -p.max_steer_rad,
        p.max_steer_rad,
    );

    // A clutch-less shift cuts torque for the duration of the change, which
    // is what makes an upshift a felt event rather than a number swap.
    let drive_n = if drive.cutting {
        0.0
    } else {
        travel_sign * control.throttle * drive.drive_capacity_n
    };
    let brake_n = control.brake * p.max_brake_force_n;
    // The rear axle carries 40% of the service-brake capacity, so that is
    // what a rear-only parking brake can apply.
    let handbrake_n = if control.handbrake {
        p.max_brake_force_n * 0.4
    } else {
        0.0
    };
    let direction = if s.longitudinal_velocity_mps.abs() > 0.05 {
        s.longitudinal_velocity_mps.signum()
    } else {
        travel_sign
    };
    let drag_n = p.drag_coefficient_n_per_mps2
        * s.longitudinal_velocity_mps
        * s.longitudinal_velocity_mps.abs();
    let rolling_n =
        p.rolling_resistance_coefficient * p.mass_kg * G * tanh(s.longitudinal_velocity_mps / 0.1);
    let requested_fx = drive_n - direction * (brake_n + handbrake_n) - drag_n - rolling_n;
    let requested_ax = requested_fx / p.mass_kg;

    let lf = p.cg_to_front_m;
    let lr = p.wheelbase_m - lf;
    let front_normal = clamp(
        (p.mass_kg * G * lr - p.mass_kg * requested_ax * p.cg_height_m) / p.wheelbase_m,
        0.1 * p.mass_kg * G,
        0.9 * p.mass_kg * G,
    );
    let rear_normal = p.mass_kg * G - front_normal;
    let mu = (p.tire_mu * friction_scale).max(0.05);

    // Rear-wheel drive and a 60/40 front/rear brake balance. The longitudinal
    // allocations share the same friction circles as lateral tyre forces.
    let front_fx_request = if control.brake > 0.0 {
        -direction * brake_n * 0.6
    } else {
        0.0
    };
    let rear_fx_request = requested_fx - front_fx_request;
    let front_fx = clamp(front_fx_request, -mu * front_normal, mu * front_normal);
    let rear_fx = clamp(rear_fx_request, -mu * rear_normal, mu * rear_normal);

    let speed_for_slip = s.longitudinal_velocity_mps.abs().max(0.75);
    // The steer contribution to front-tyre slip is signed by the direction of
    // travel: a tyre is symmetric, so the lateral slip velocity it sees from a
    // steer angle `d` is `-u * sin(d)`, which changes sign with `u`. Dropping
    // that sign makes a reversing car respond to steering the wrong way — the
    // controller's correction becomes positive feedback, the steer saturates,
    // and the body peels off its path. The yaw-rate and sideslip terms enter
    // through `atan2(.., |u|)`, whose sign is carried by the numerator.
    let front_slip = atan2(
        s.lateral_velocity_mps + lf * s.yaw_rate_radps,
        speed_for_slip,
    ) - direction * s.steer_rad;
    let rear_slip = atan2(
        s.lateral_velocity_mps - lr * s.yaw_rate_radps,
        speed_for_slip,
    );
    let front = friction_ellipse_lateral(
        -p.cornering_stiffness_front_n_per_rad * front_slip,
        front_fx,
        front_normal,
        mu,
    );
    let rear = friction_ellipse_lateral(
        -p.cornering_stiffness_rear_n_per_rad * rear_slip,
        rear_fx,
        rear_normal,
        mu,
    );

    let raw_lateral_n = rear.force + front.force * cos(s.steer_rad);
    let lateral_limit_n = p.mass_kg * p.max_lateral_acceleration_mps2;
    let lateral_scale = if raw_lateral_n.abs() > lateral_limit_n {
        lateral_limit_n / raw_lateral_n.abs()
    } else {
        1.0
    };
    let front_fy = front.force * lateral_scale;
    let rear_fy = rear.force * lateral_scale;

    let (sin_steer, cos_steer) = sin_cos(s.steer_rad);
    let total_fx = rear_fx + front_fx * cos_steer - front_fy * sin_steer;
    let u_dot = total_fx / p.mass_kg + s.lateral_velocity_mps * s.yaw_rate_radps;
    let v_dot = (rear_fy + front_fy * cos_steer + front_fx * sin_steer) / p.mass_kg
        - s.longitudinal_velocity_mps * s.yaw_rate_radps;
    let yaw_dot =
        (lf * (front_fy * cos_steer + front_fx * sin_steer) - lr * rear_fy) / p.yaw_inertia_kg_m2;

    let old_u = s.longitudinal_velocity_mps;
    let old_v = s.lateral_velocity_mps;
    let old_yaw_rate = s.yaw_rate_radps;
    let old_yaw = s.yaw_rad;
    s.longitudinal_velocity_mps += u_dot * h;
    // Braking stops the body; it never drags it through zero into the other
    // direction. Reversing is a gear change, not a negative brake.
    if travel_sign * s.longitudinal_velocity_mps < 0.0 {
        s.longitudinal_velocity_mps = 0.0;
    }
    s.lateral_velocity_mps += v_dot * h;
    s.yaw_rate_radps = clamp(
        s.yaw_rate_radps + yaw_dot * h,
        -p.max_yaw_rate_radps,
        p.max_yaw_rate_radps,
    );
    s.yaw_rad = normalize_angle(old_yaw + 0.5 * (old_yaw_rate + s.yaw_rate_radps) * h);
    let (old_sin, old_cos) = sin_cos(old_yaw);
    let (new_sin, new_cos) = sin_cos(s.yaw_rad);
    let old_world_x = old_u * old_cos - old_v * old_sin;
    let old_world_y = old_u * old_sin + old_v * old_cos;
    let new_world_x = s.longitudinal_velocity_mps * new_cos - s.lateral_velocity_mps * new_sin;
    let new_world_y = s.longitudinal_velocity_mps * new_sin + s.lateral_velocity_mps * new_cos;
    s.x += 0.5 * (old_world_x + new_world_x) * h;
    s.y += 0.5 * (old_world_y + new_world_y) * h;
    s.longitudinal_acceleration_mps2 = u_dot;

    // Wheel state is an aggregate driven-wheel speed. A short tyre relaxation
    // time captures launch/braking lag without introducing a stiff slip solver.
    let rolling_omega = s.longitudinal_velocity_mps / p.wheel_radius_m;
    let wheel_tau_s = if control.brake > 0.0 { 0.035 } else { 0.08 };
    s.wheel_angular_speed_radps +=
        (rolling_omega - s.wheel_angular_speed_radps) * (h / wheel_tau_s);
    if s.longitudinal_velocity_mps == 0.0 && (control.brake > 0.0 || control.handbrake) {
        s.wheel_angular_speed_radps = 0.0;
    }

    PhysicsTelemetrySample {
        control,
        longitudinal_force_n: total_fx,
        front_lateral_force_n: front_fy,
        rear_lateral_force_n: rear_fy,
        front_normal_force_n: front_normal,
        rear_normal_force_n: rear_normal,
        tire_utilization: front.utilization.max(rear.utilization),
        front_tire_utilization: front.utilization,
        rear_tire_utilization: rear.utilization,
        engine_rpm: drive.rpm,
        gear: drive.gear,
        wheel_speeds_radps: corner_wheel_speeds(s, &p, width_m),
        lateral_acceleration_mps2: (rear_fy + front_fy * cos_steer + front_fx * sin_steer)
            / p.mass_kg,
        substeps: 1,
        substep_s: h,
        collision_impulse_ns: 0.0,
        collision_count: 0,
    }
}

/// Per-corner wheel angular speeds `[fl, fr, rl, rr]` for a single-track
/// body. The model carries one driven-wheel speed, so the corners are the
/// rigid-body reconstruction of it: the yaw rate spreads left from right
/// across the track, and the steered front wheels roll along their own plane
/// rather than the body's. Renderers spin wheels from these; nothing in the
/// solver reads them back.
fn corner_wheel_speeds(
    s: &VehicleMotionState,
    p: &ResolvedVehiclePhysicsProfile,
    width_m: f64,
) -> [f64; 4] {
    // Track is inset from the body's widest point by the tyre and bodywork.
    let half_track = (width_m * 0.85 / 2.0).max(0.05);
    let lf = p.cg_to_front_m;
    let (sin_steer, cos_steer) = sin_cos(s.steer_rad);
    // Driven (rear) wheels carry the relaxed wheel speed, which is what
    // spins up under wheelspin and locks under braking.
    let rear = s.wheel_angular_speed_radps;
    let rear_bias = s.yaw_rate_radps * half_track / p.wheel_radius_m;
    let front_long = s.longitudinal_velocity_mps;
    let front_lat = s.lateral_velocity_mps + lf * s.yaw_rate_radps;
    let front_plane = |long: f64| (long * cos_steer + front_lat * sin_steer) / p.wheel_radius_m;
    [
        front_plane(front_long - s.yaw_rate_radps * half_track),
        front_plane(front_long + s.yaw_rate_radps * half_track),
        rear - rear_bias,
        rear + rear_bias,
    ]
}

/// A body that is off its feet. It has no gait and no route: whatever the
/// contact impulse gave it is carried in the plane and rubbed off by sliding
/// friction against the ground, in body axes so the solver's lateral
/// component survives. Yaw is held — a planar state has no roll axis to fall
/// about, so the pose stays the one it was struck in and renderers lay the
/// model down from the knockdown time.
fn integrate_downed(
    entry: &mut VehicleEntry,
    h: f64,
    friction_scale: f64,
) -> PhysicsTelemetrySample {
    let p = entry.profile;
    let s = &mut entry.state;
    let start_speed = hypot(s.longitudinal_velocity_mps, s.lateral_velocity_mps);
    // Sliding body against asphalt, not a shoe pushing off it.
    let decel = SLIDING_FRICTION_COEFFICIENT * G * friction_scale.max(0.05);
    let end_speed = (start_speed - decel * h).max(0.0);
    let scale = if start_speed > 1e-9 {
        end_speed / start_speed
    } else {
        0.0
    };
    // Midpoint of the interval, so coming to rest does not overshoot.
    let average_scale = if start_speed > 1e-9 {
        0.5 * (1.0 + scale)
    } else {
        0.0
    };
    let vx_body = s.longitudinal_velocity_mps * average_scale;
    let vy_body = s.lateral_velocity_mps * average_scale;
    let (sin, cos) = sin_cos(s.yaw_rad);
    s.x += (vx_body * cos - vy_body * sin) * h;
    s.y += (vx_body * sin + vy_body * cos) * h;
    s.longitudinal_velocity_mps *= scale;
    s.lateral_velocity_mps *= scale;
    s.longitudinal_acceleration_mps2 = (end_speed - start_speed) / h;
    s.yaw_rate_radps = 0.0;
    s.steer_rad = 0.0;
    s.wheel_angular_speed_radps = 0.0;
    PhysicsTelemetrySample {
        control: VehicleControl::ZERO,
        longitudinal_force_n: s.longitudinal_acceleration_mps2 * p.mass_kg,
        front_lateral_force_n: 0.0,
        rear_lateral_force_n: 0.0,
        front_normal_force_n: p.mass_kg * G,
        rear_normal_force_n: 0.0,
        // A body on the ground has no axles, no driveline and no corners:
        // every wheel/gear channel stays at its zero.
        tire_utilization: 0.0,
        substeps: 1,
        substep_s: h,
        ..PhysicsTelemetrySample::default()
    }
}

/// Bounded social-force-style point agent for walkers and animals. It owns
/// continuous velocity/heading state but intentionally has no wheel or tyre
/// semantics.
fn integrate_pedestrian(
    entry: &mut VehicleEntry,
    intent: &MotionIntent,
    h: f64,
    friction_scale: f64,
) -> PhysicsTelemetrySample {
    let bounded = bounded_intent(entry, intent, h);
    let p = entry.profile;
    let s = &mut entry.state;
    let speed_error =
        bounded.target_speed_mps - bounded.motion_direction.sign() * s.longitudinal_velocity_mps;
    let accel = clamp(
        bounded.target_acceleration_mps2 + 1.5 * speed_error,
        -p.max_longitudinal_decel_mps2 * friction_scale,
        p.max_longitudinal_accel_mps2 * friction_scale,
    );
    let desired_heading = atan2(bounded.preview_point.y - s.y, bounded.preview_point.x - s.x);
    let yaw_rate = clamp(
        angle_delta(s.yaw_rad, desired_heading) / 0.22,
        -p.max_yaw_rate_radps,
        p.max_yaw_rate_radps,
    );
    let old_speed = s.longitudinal_velocity_mps;
    s.longitudinal_velocity_mps = (old_speed + accel * h).max(0.0);
    s.longitudinal_acceleration_mps2 = accel;
    s.yaw_rate_radps = yaw_rate;
    s.yaw_rad = normalize_angle(s.yaw_rad + yaw_rate * h);
    s.lateral_velocity_mps = 0.0;
    s.steer_rad = 0.0;
    s.wheel_angular_speed_radps = 0.0;
    let average_speed = 0.5 * (old_speed + s.longitudinal_velocity_mps);
    let (sin, cos) = sin_cos(s.yaw_rad);
    s.x += cos * average_speed * h;
    s.y += sin * average_speed * h;
    PhysicsTelemetrySample {
        control: VehicleControl {
            throttle: if accel > 0.0 {
                accel / p.max_longitudinal_accel_mps2
            } else {
                0.0
            },
            brake: if accel < 0.0 {
                -accel / p.max_longitudinal_decel_mps2
            } else {
                0.0
            },
            steer: yaw_rate / p.max_yaw_rate_radps,
            handbrake: false,
        },
        longitudinal_force_n: accel * p.mass_kg,
        front_lateral_force_n: 0.0,
        rear_lateral_force_n: 0.0,
        front_normal_force_n: p.mass_kg * G,
        rear_normal_force_n: 0.0,
        // A walker has no axles, driveline or wheels to report.
        tire_utilization: 0.0,
        substeps: 1,
        substep_s: h,
        ..PhysicsTelemetrySample::default()
    }
}

/// Participant of a world contact as the engine names it: a registered body
/// or a slot into the `static_colliders` slice passed to
/// [`DynamicV1Backend::step_world`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "index")]
pub enum WorldContactRef {
    Body(BodyIndex),
    Static(u32),
}

/// Accumulated impulse between one pair over the last world step. `a`
/// precedes `b` in canonical id order.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorldContact {
    pub a: WorldContactRef,
    pub b: WorldContactRef,
    pub normal_impulse_ns: f64,
    pub tangent_impulse_ns: f64,
}

/// Infinite-mass collider handed to [`DynamicV1Backend::step_world`]: map
/// proxy, prop, fixed actor, or kinematically driven actor with surface
/// velocity. `id` is the canonical contact id (borrowed from the engine for
/// the duration of the call only) and orders the collider among the bodies.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WorldStaticCollider<'a> {
    pub id: &'a str,
    pub obb: Obb,
    pub velocity: Vec2,
    pub angular_velocity: f64,
}

impl<'a> WorldStaticCollider<'a> {
    pub fn fixed(id: &'a str, obb: Obb) -> Self {
        Self {
            id,
            obb,
            velocity: Vec2::ZERO,
            angular_velocity: 0.0,
        }
    }
}

/// Per-world numeric scratch. Never part of the semantic state: excluded
/// from serialization and equality, rebuilt empty on clone/restore.
#[derive(Debug, Default)]
struct WorldScratch {
    solver: PlanarContactSolver,
    /// Registered bodies in reference contact order (`localeCompare` on id);
    /// rebuilt when the registered set grows.
    rank_order: Vec<BodyIndex>,
    /// `BodyIndex -> rank among registered bodies` (id order).
    body_rank: Vec<u32>,
    /// Active bodies sorted by id.
    active: Vec<BodyIndex>,
    /// Static collider slots sorted by id.
    static_order: Vec<u32>,
    bodies: Vec<PlanarCollisionBody>,
    statics: Vec<PlanarStaticCollider>,
}

/// Deterministic planar solver owning every registered body's continuous
/// state. The whole backend is its own snapshot: it is `Clone` and serde
/// round-trips, so a world can be forked or restored and stepped identically.
/// Solver scratch buffers are retained across steps but are not state.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DynamicV1Backend {
    substep_s: f64,
    /// `BodyIndex -> actor id`.
    ids: Vec<String>,
    /// Canonical id order; iteration yields bodies sorted by id.
    index: BTreeMap<String, BodyIndex>,
    entries: Vec<VehicleEntry>,
    /// Impulses from the most recent [`DynamicV1Backend::step_world`].
    contacts: Vec<WorldContact>,
    #[serde(skip)]
    scratch: WorldScratch,
}

impl Clone for DynamicV1Backend {
    fn clone(&self) -> Self {
        Self {
            substep_s: self.substep_s,
            ids: self.ids.clone(),
            index: self.index.clone(),
            entries: self.entries.clone(),
            contacts: self.contacts.clone(),
            scratch: WorldScratch::default(),
        }
    }
}

impl PartialEq for DynamicV1Backend {
    fn eq(&self, other: &Self) -> bool {
        self.substep_s == other.substep_s
            && self.ids == other.ids
            && self.index == other.index
            && self.entries == other.entries
            && self.contacts == other.contacts
    }
}

impl DynamicV1Backend {
    pub fn new(substep_s: f64) -> Result<Self, PhysicsError> {
        if !(substep_s > 0.0) || !substep_s.is_finite() {
            return Err(PhysicsError::InvalidSubstep(substep_s));
        }
        Ok(Self {
            substep_s,
            ids: Vec::new(),
            index: BTreeMap::new(),
            entries: Vec::new(),
            contacts: Vec::new(),
            scratch: WorldScratch::default(),
        })
    }

    /// Pre-size scratch for a world of `bodies` dynamic bodies and up to
    /// `statics` colliders per step so steady-state stepping never grows a
    /// buffer.
    pub fn reserve(&mut self, bodies: usize, statics: usize) {
        self.ids.reserve(bodies);
        self.entries.reserve(bodies);
        let s = &mut self.scratch;
        s.body_rank.reserve(bodies);
        s.active.reserve(bodies);
        s.bodies.reserve(bodies);
        s.static_order.reserve(statics);
        s.statics.reserve(statics);
        s.solver.reserve(bodies + statics);
    }

    pub fn with_default_substep() -> Self {
        Self::new(DYNAMIC_V1_DEFAULT_SUBSTEP_S).expect("default substep is positive")
    }

    #[inline]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    #[inline]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Registered bodies in canonical id order.
    pub fn bodies(&self) -> impl Iterator<Item = (BodyIndex, &str)> + '_ {
        self.index.iter().map(|(id, &body)| (body, id.as_str()))
    }

    #[inline]
    fn entry(&self, body: BodyIndex) -> Option<&VehicleEntry> {
        self.entries.get(body.index())
    }

    #[inline]
    fn entry_mut(&mut self, body: BodyIndex) -> Result<&mut VehicleEntry, PhysicsError> {
        self.entries
            .get_mut(body.index())
            .ok_or(PhysicsError::UnknownBody(body.0))
    }

    pub fn profile(&self, body: BodyIndex) -> Option<&ResolvedVehiclePhysicsProfile> {
        self.entry(body).map(|e| &e.profile)
    }

    /// Collision footprint `(length_m, width_m)`.
    pub fn footprint(&self, body: BodyIndex) -> Option<(f64, f64)> {
        self.entry(body).map(|e| (e.length_m, e.width_m))
    }

    /// Replace the collision footprint of a registered body.
    pub fn set_footprint(
        &mut self,
        body: BodyIndex,
        length_m: f64,
        width_m: f64,
    ) -> Result<(), PhysicsError> {
        let entry = self.entry_mut(body)?;
        entry.length_m = length_m;
        entry.width_m = width_m;
        Ok(())
    }

    /// Current footprint OBB.
    pub fn obb(&self, body: BodyIndex) -> Option<Obb> {
        self.entry(body).map(|e| Obb {
            center: e.state.position(),
            length_m: e.length_m,
            width_m: e.width_m,
            heading_rad: e.state.yaw_rad,
        })
    }

    /// Pose at the start of the current tick (swept-contact origin).
    pub fn previous_pose(&self, body: BodyIndex) -> Option<ContactPose> {
        self.entry(body).map(|e| e.previous)
    }

    /// Footprint OBB at the start of the current tick.
    pub fn previous_obb(&self, body: BodyIndex) -> Option<Obb> {
        self.entry(body).map(|e| Obb {
            center: Vec2 {
                x: e.previous.x,
                y: e.previous.y,
            },
            length_m: e.length_m,
            width_m: e.width_m,
            heading_rad: e.previous.yaw_rad,
        })
    }

    /// Impulses applied by the most recent [`DynamicV1Backend::step_world`],
    /// in canonical `(a, b)` id order.
    pub fn contacts(&self) -> &[WorldContact] {
        &self.contacts
    }

    /// Resolve actor/actor and actor/static contacts after every synchronized
    /// engine tick. `active` names the bodies that are present this tick
    /// (order-insensitive: processing is canonicalised by id); every other
    /// registered body is left untouched and excluded from contact.
    /// `static_colliders` carry map proxies, props and fixed/kinematic actors
    /// with infinite mass; their `id`s must be unique and distinct from body
    /// ids. Each active body's telemetry receives its summed normal impulse
    /// and contact-pair count (zero when untouched). Steady-state calls do not
    /// allocate: all working buffers are retained scratch.
    pub fn step_world(
        &mut self,
        active: &[BodyIndex],
        static_colliders: &[WorldStaticCollider<'_>],
        dt_s: f64,
    ) -> Result<&[WorldContact], PhysicsError> {
        if !(dt_s > 0.0) {
            return Err(PhysicsError::InvalidTimestep(dt_s));
        }
        for &body in active {
            if body.index() >= self.entries.len() {
                return Err(PhysicsError::UnknownBody(body.0));
            }
        }
        let ids = &self.ids;
        let entries = &mut self.entries;
        let scratch = &mut self.scratch;

        // Rank every registered body by id (the reference sorts every solver
        // participant with `localeCompare`), then order the active set by
        // rank. The order only changes when a body is registered.
        if scratch.rank_order.len() != entries.len() {
            scratch.rank_order.clear();
            scratch
                .rank_order
                .extend((0..entries.len() as u32).map(BodyIndex));
            scratch
                .rank_order
                .sort_by(|a, b| cmp_locale(&ids[a.index()], &ids[b.index()]));
        }
        scratch.body_rank.clear();
        scratch.body_rank.resize(entries.len(), 0);
        for (rank, &body) in scratch.rank_order.iter().enumerate() {
            scratch.body_rank[body.index()] = rank as u32;
        }
        let body_rank = &scratch.body_rank;
        scratch.active.clear();
        scratch.active.extend_from_slice(active);
        scratch
            .active
            .sort_unstable_by_key(|b| body_rank[b.index()]);
        scratch.active.dedup();

        // Statics arrive id-sorted from the engine; the sort is O(m) then and
        // only does real work if a caller breaks that convention.
        scratch.static_order.clear();
        scratch
            .static_order
            .extend(0..static_colliders.len() as u32);
        scratch.static_order.sort_by(|&i, &j| {
            cmp_locale(
                static_colliders[i as usize].id,
                static_colliders[j as usize].id,
            )
        });

        // Merge the two id-sorted sequences into one canonical rank order,
        // exactly the order a single id sort over all participants yields.
        scratch.bodies.clear();
        scratch.statics.clear();
        let (mut bi, mut si, mut rank) = (0usize, 0usize, 0u32);
        while bi < scratch.active.len() || si < scratch.static_order.len() {
            let take_body = match (scratch.active.get(bi), scratch.static_order.get(si)) {
                (Some(&body), Some(&slot)) => {
                    cmp_locale(
                        ids[body.index()].as_str(),
                        static_colliders[slot as usize].id,
                    ) != Ordering::Greater
                }
                (Some(_), None) => true,
                (None, _) => false,
            };
            if take_body {
                let e = &entries[scratch.active[bi].index()];
                let s = &e.state;
                let velocity = s.world_velocity();
                scratch.bodies.push(PlanarCollisionBody {
                    rank,
                    length_m: e.length_m,
                    width_m: e.width_m,
                    inverse_mass: 1.0 / e.profile.mass_kg,
                    inverse_inertia: 1.0 / e.profile.yaw_inertia_kg_m2,
                    previous: e.previous,
                    x: s.x,
                    y: s.y,
                    yaw_rad: s.yaw_rad,
                    vx: velocity.x,
                    vy: velocity.y,
                    angular_velocity: s.yaw_rate_radps,
                });
                bi += 1;
            } else {
                let c = &static_colliders[scratch.static_order[si] as usize];
                scratch.statics.push(PlanarStaticCollider {
                    rank,
                    obb: c.obb,
                    velocity: c.velocity,
                    angular_velocity: c.angular_velocity,
                });
                si += 1;
            }
            rank += 1;
        }

        let impulses = scratch.solver.solve(
            &mut scratch.bodies,
            &scratch.statics,
            dt_s,
            DEFAULT_CONTACT_RESTITUTION,
            DEFAULT_CONTACT_FRICTION,
        );

        for (slot, &body) in scratch.active.iter().enumerate() {
            let resolved = &scratch.bodies[slot];
            let e = &mut entries[body.index()];
            let s = &mut e.state;
            s.x = resolved.x;
            s.y = resolved.y;
            s.yaw_rad = normalize_angle(resolved.yaw_rad);
            let (sin, cos) = sin_cos(s.yaw_rad);
            s.longitudinal_velocity_mps = resolved.vx * cos + resolved.vy * sin;
            s.lateral_velocity_mps = -resolved.vx * sin + resolved.vy * cos;
            s.yaw_rate_radps = resolved.angular_velocity;
            e.telemetry.collision_impulse_ns = 0.0;
            e.telemetry.collision_count = 0;
        }

        // Solver slots map back through the active/static orderings.
        let to_world = |r: ContactRef| match r {
            ContactRef::Dynamic(slot) => WorldContactRef::Body(scratch.active[slot as usize]),
            ContactRef::Static(slot) => {
                WorldContactRef::Static(scratch.static_order[slot as usize])
            }
        };
        self.contacts.clear();
        for impulse in impulses {
            let contact = WorldContact {
                a: to_world(impulse.a),
                b: to_world(impulse.b),
                normal_impulse_ns: impulse.normal_impulse_ns,
                tangent_impulse_ns: impulse.tangent_impulse_ns,
            };
            for party in [contact.a, contact.b] {
                if let WorldContactRef::Body(body) = party {
                    let telemetry = &mut entries[body.index()].telemetry;
                    telemetry.collision_impulse_ns += contact.normal_impulse_ns;
                    telemetry.collision_count += 1;
                }
            }
            self.contacts.push(contact);
        }
        Ok(&self.contacts)
    }
}

impl MotionBackend for DynamicV1Backend {
    fn id(&self) -> &'static str {
        DYNAMIC_V1_ID
    }

    fn version(&self) -> u32 {
        DYNAMIC_V1_VERSION
    }

    fn substep_s(&self) -> f64 {
        self.substep_s
    }

    fn register(&mut self, input: &MotionActorInitialization) -> Result<BodyIndex, PhysicsError> {
        if input.kind == ActorKind::StaticObject {
            return Err(PhysicsError::StaticActor {
                actor_id: input.actor_id.clone(),
            });
        }
        let profile = resolve_actor_physics_profile(input.kind, input.profile.as_ref())?;
        let init = &input.state;
        let u = input.motion_direction.sign() * init.longitudinal_velocity_mps.abs();
        let (length_m, width_m) = match &input.dimensions {
            Some(d) => (d.l, d.w),
            None => (DEFAULT_FOOTPRINT_LENGTH_M, DEFAULT_FOOTPRINT_WIDTH_M),
        };
        let entry = VehicleEntry {
            profile,
            state: VehicleMotionState {
                x: init.x,
                y: init.y,
                yaw_rad: init.yaw_rad,
                longitudinal_velocity_mps: u,
                lateral_velocity_mps: init.lateral_velocity_mps.unwrap_or(0.0),
                yaw_rate_radps: init.yaw_rate_radps.unwrap_or(0.0),
                steer_rad: init.steer_rad.unwrap_or(0.0),
                wheel_angular_speed_radps: init
                    .wheel_angular_speed_radps
                    .unwrap_or(u / profile.wheel_radius_m),
                longitudinal_acceleration_mps2: init.longitudinal_acceleration_mps2.unwrap_or(0.0),
            },
            previous: ContactPose {
                x: init.x,
                y: init.y,
                yaw_rad: init.yaw_rad,
            },
            telemetry: zero_telemetry(self.substep_s),
            commanded_acceleration_mps2: init.longitudinal_acceleration_mps2.unwrap_or(0.0),
            // A body registered already moving is in whichever gear its wheel
            // speed puts it in; the schedule settles it on the first substep.
            gear: if u == 0.0 {
                GEAR_NEUTRAL
            } else if u < 0.0 {
                GEAR_REVERSE
            } else {
                1
            },
            shift_cut_remaining_s: 0.0,
            length_m,
            width_m,
        };
        if let Some(&body) = self.index.get(input.actor_id.as_str()) {
            self.entries[body.index()] = entry;
            return Ok(body);
        }
        let body = BodyIndex(self.entries.len() as u32);
        self.ids.push(input.actor_id.clone());
        self.index.insert(input.actor_id.clone(), body);
        self.entries.push(entry);
        Ok(body)
    }

    fn body(&self, actor_id: &str) -> Option<BodyIndex> {
        self.index.get(actor_id).copied()
    }

    fn actor_id(&self, body: BodyIndex) -> Option<&str> {
        self.ids.get(body.index()).map(String::as_str)
    }

    fn set_state(
        &mut self,
        body: BodyIndex,
        state: VehicleMotionState,
    ) -> Result<(), PhysicsError> {
        let entry = self.entry_mut(body)?;
        entry.previous = ContactPose {
            x: state.x,
            y: state.y,
            yaw_rad: state.yaw_rad,
        };
        entry.state = state;
        entry.commanded_acceleration_mps2 = state.longitudinal_acceleration_mps2;
        Ok(())
    }

    fn step(
        &mut self,
        body: BodyIndex,
        intent: &MotionIntent,
        dt_s: f64,
        friction_scale: f64,
    ) -> Result<MotionStepResult, PhysicsError> {
        if !(dt_s > 0.0) {
            return Err(PhysicsError::InvalidTimestep(dt_s));
        }
        let substep_s = self.substep_s;
        let entry = self.entry_mut(body)?;
        let count = ((dt_s / substep_s - 1e-12).ceil() as u32).max(1);
        let h = dt_s / f64::from(count);
        entry.previous = ContactPose {
            x: entry.state.x,
            y: entry.state.y,
            yaw_rad: entry.state.yaw_rad,
        };
        engage_gear(entry, intent, dt_s);
        let mut telemetry = zero_telemetry(h);
        for _ in 0..count {
            telemetry = integrate(entry, intent, h, friction_scale);
        }
        telemetry.substeps = count;
        telemetry.substep_s = h;
        entry.telemetry = telemetry;
        Ok(MotionStepResult {
            state: entry.state,
            telemetry,
        })
    }

    fn state(&self, body: BodyIndex) -> Option<VehicleMotionState> {
        self.entry(body).map(|e| e.state)
    }

    fn telemetry(&self, body: BodyIndex) -> Option<PhysicsTelemetrySample> {
        self.entry(body).map(|e| e.telemetry)
    }
}
