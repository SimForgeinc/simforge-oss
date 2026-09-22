//! Non-holonomic invariants for wheeled bodies near and at standstill.
//!
//! A car's heading can only change by rolling: the rear axle cannot slide
//! sideways and the body turns about a point on the rear-axle line, so
//! `|yaw rate| <= |v| * tan(steer) / wheelbase`, and at `v = 0` the heading is
//! frozen however far the wheels are turned. These tests drive `dynamic-v1`
//! through the manoeuvres that used to break that (a stop with the steering
//! wound on, a preview point that ends up beside or behind the stopped body,
//! a sequence of seeded random stops) and assert the invariant tick by tick.

use super::*;
use crate::math::{angle_delta, Vec2};
use crate::types::ActorKind;

const TICK_S: f64 = 0.05;

fn register(kind: ActorKind, u: f64) -> (DynamicV1Backend, BodyIndex) {
    let mut value = DynamicV1Backend::with_default_substep();
    let body = value
        .register(&MotionActorInitialization {
            actor_id: "car".into(),
            kind,
            dimensions: None,
            motion_direction: MotionDirection::Forward,
            state: MotionInitialState::at_rest(0.0, 0.0, 0.0, u),
            profile: None,
        })
        .unwrap();
    (value, body)
}

fn stop_toward(preview: Vec2, preview_heading_rad: f64) -> MotionIntent {
    MotionIntent {
        motion_direction: MotionDirection::Forward,
        target_speed_mps: 0.0,
        target_acceleration_mps2: -4.0,
        preview_point: preview,
        preview_heading_rad,
        downed: false,
        control: None,
    }
}

/// Worst per-tick violation of the kinematic envelope, plus the total heading
/// change accumulated on ticks that began and ended at rest.
#[derive(Debug, Default)]
struct Audit {
    max_excess_yaw_rate: f64,
    stationary_turn_rad: f64,
    max_lateral_slide_at_rest_m: f64,
    min_longitudinal_velocity: f64,
    /// Path length and absolute heading change over the whole run: the
    /// integral form of the envelope, `|dpsi| <= ds * tan(max steer) / L`.
    distance_m: f64,
    heading_travel_rad: f64,
}

fn audit_step(
    audit: &mut Audit,
    profile: &ResolvedVehiclePhysicsProfile,
    before: &VehicleMotionState,
    after: &VehicleMotionState,
    dt: f64,
) {
    let yaw_step = angle_delta(before.yaw_rad, after.yaw_rad);
    let speed = before.planar_speed_mps().max(after.planar_speed_mps());
    let envelope = speed * profile.max_steer_rad.tan() / profile.wheelbase_m;
    audit.max_excess_yaw_rate = audit
        .max_excess_yaw_rate
        .max(yaw_step.abs() / dt - envelope);
    audit.min_longitudinal_velocity = audit
        .min_longitudinal_velocity
        .min(after.longitudinal_velocity_mps);
    audit.distance_m += (after.x - before.x).hypot(after.y - before.y);
    audit.heading_travel_rad += yaw_step.abs();
    if speed < 1e-9 {
        audit.stationary_turn_rad += yaw_step.abs();
        audit.max_lateral_slide_at_rest_m = audit
            .max_lateral_slide_at_rest_m
            .max((after.x - before.x).hypot(after.y - before.y));
    }
}

fn assert_non_holonomic(audit: &Audit, profile: &ResolvedVehiclePhysicsProfile, context: &str) {
    let turn_budget = audit.distance_m * profile.max_steer_rad.tan() / profile.wheelbase_m;
    assert!(
        audit.heading_travel_rad <= turn_budget + 1e-9,
        "{context}: turned {} rad over {} m, more than rolling allows ({} rad)",
        audit.heading_travel_rad,
        audit.distance_m,
        turn_budget
    );
    assert!(
        audit.max_excess_yaw_rate <= 1e-9,
        "{context}: yaw rate exceeded the rolling envelope by {} rad/s",
        audit.max_excess_yaw_rate
    );
    assert!(
        audit.stationary_turn_rad <= 1e-12,
        "{context}: heading turned {} rad while at rest",
        audit.stationary_turn_rad
    );
    assert!(
        audit.max_lateral_slide_at_rest_m <= 1e-9,
        "{context}: a body at rest moved {} m",
        audit.max_lateral_slide_at_rest_m
    );
    assert!(
        audit.min_longitudinal_velocity >= 0.0,
        "{context}: a forward-commanded body reversed at {} m/s",
        audit.min_longitudinal_velocity
    );
}

/// Minimal repro: brake to a stop while the steering is wound on toward a
/// preview point beside the lane, then keep holding the stop. Before the fix
/// the stopped car kept yawing at ~0.75·tan(δ)/L and slid sideways, because
/// the front tyre produced a lateral force from the steer angle alone.
#[test]
fn a_stopped_car_with_the_wheels_turned_does_not_rotate() {
    let (mut value, body) = register(ActorKind::Car, 6.0);
    let profile = *value.profile(body).unwrap();
    let mut audit = Audit::default();
    let mut before = value.state(body).unwrap();
    let mut t = 0.0;
    while t < 20.0 {
        // The preview point sits 4 m ahead and 2 m to the left of wherever the
        // body currently is, so the controller asks for left lock throughout.
        let (s, c) = before.yaw_rad.sin_cos();
        let preview = Vec2 {
            x: before.x + 4.0 * c - 2.0 * s,
            y: before.y + 4.0 * s + 2.0 * c,
        };
        let step = value
            .step(
                body,
                &stop_toward(preview, before.yaw_rad + 0.6),
                TICK_S,
                1.0,
            )
            .unwrap();
        audit_step(&mut audit, &profile, &before, &step.state, TICK_S);
        before = step.state;
        t += TICK_S;
    }
    assert!(
        before.steer_rad.abs() > 0.2,
        "the wheels should stay turned"
    );
    assert_eq!(before.longitudinal_velocity_mps, 0.0);
    assert_non_holonomic(&audit, &profile, "stop with steering wound on");
}

/// A preview point behind the body (it stopped past the end of its route)
/// saturates pure pursuit. The steering may go to full lock; the body may not
/// pirouette.
#[test]
fn a_preview_point_behind_a_stopped_car_cannot_spin_it() {
    let (mut value, body) = register(ActorKind::Car, 3.0);
    let profile = *value.profile(body).unwrap();
    let mut audit = Audit::default();
    let mut before = value.state(body).unwrap();
    for _ in 0..400 {
        let intent = stop_toward(Vec2 { x: -5.0, y: 0.4 }, std::f64::consts::PI);
        let step = value.step(body, &intent, TICK_S, 1.0).unwrap();
        audit_step(&mut audit, &profile, &before, &step.state, TICK_S);
        before = step.state;
    }
    assert_non_holonomic(&audit, &profile, "preview behind a stopped body");
    assert_eq!(before.longitudinal_velocity_mps, 0.0);
    assert_eq!(before.yaw_rate_radps, 0.0, "a stopped body has no yaw rate");
}

/// Every wheeled class, many seeded stops: random entry speed, braking
/// demand, preview geometry (ahead, beside, behind) and surface friction,
/// followed by a long hold at rest. The envelope must hold on every tick.
#[test]
fn seeded_stop_manoeuvres_respect_the_rolling_envelope_for_every_wheeled_class() {
    let mut rng = 0x5eed_5eed_u64;
    let mut next = move || {
        // xorshift64*: deterministic, dependency-free.
        rng ^= rng >> 12;
        rng ^= rng << 25;
        rng ^= rng >> 27;
        (rng.wrapping_mul(0x2545_f491_4f6c_dd1d) >> 11) as f64 / (1u64 << 53) as f64
    };
    let classes = [
        ActorKind::Car,
        ActorKind::Vehicle,
        ActorKind::Van,
        ActorKind::Truck,
        ActorKind::Bus,
        ActorKind::Motorcycle,
        ActorKind::Bicycle,
    ];
    for case in 0..280 {
        let kind = classes[case % classes.len()];
        let entry_speed = 0.2 + 14.0 * next();
        let (mut value, body) = register(kind, entry_speed);
        let profile = *value.profile(body).unwrap();
        let decel = 0.5 + 7.5 * next();
        let bearing = (next() * 2.0 - 1.0) * std::f64::consts::PI;
        let distance = 0.5 + 8.0 * next();
        let preview_heading = (next() * 2.0 - 1.0) * std::f64::consts::PI;
        let friction = 0.3 + 0.7 * next();
        let hold_ticks = 60 + (next() * 200.0) as usize;
        let mut audit = Audit::default();
        let mut before = value.state(body).unwrap();
        for tick in 0..(200 + hold_ticks) {
            let (s, c) = (before.yaw_rad + bearing).sin_cos();
            let intent = MotionIntent {
                target_acceleration_mps2: -decel,
                ..stop_toward(
                    Vec2 {
                        x: before.x + distance * c,
                        y: before.y + distance * s,
                    },
                    preview_heading,
                )
            };
            let step = value.step(body, &intent, TICK_S, friction).unwrap();
            audit_step(&mut audit, &profile, &before, &step.state, TICK_S);
            before = step.state;
            let _ = tick;
        }
        assert_eq!(
            before.longitudinal_velocity_mps, 0.0,
            "case {case} ({kind:?}) did not come to rest"
        );
        assert_non_holonomic(
            &audit,
            &profile,
            &format!(
                "case {case} ({kind:?}, v0={entry_speed:.2}, decel={decel:.2}, \
                 bearing={bearing:.2}, d={distance:.2}, mu={friction:.2})"
            ),
        );
    }
}
