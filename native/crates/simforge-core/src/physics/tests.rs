//! Reference maneuver, contact and convergence cases for `dynamic-v1`,
//! mirroring the TypeScript backend's contract suite.

use super::*;
use crate::math::{Obb, Vec2};
use crate::types::{ActorKind, VehiclePhysicsProfile};

const TICK_S: f64 = 0.05;

fn straight() -> MotionIntent {
    MotionIntent {
        motion_direction: MotionDirection::Forward,
        target_speed_mps: 20.0,
        target_acceleration_mps2: 2.5,
        preview_point: Vec2 { x: 1_000.0, y: 0.0 },
        preview_heading_rad: 0.0,
        downed: false,
        control: None,
    }
}

fn car(
    x: f64,
    y: f64,
    yaw_rad: f64,
    u: f64,
    profile: Option<VehiclePhysicsProfile>,
) -> MotionActorInitialization {
    MotionActorInitialization {
        actor_id: "car".into(),
        kind: ActorKind::Car,
        dimensions: None,
        motion_direction: MotionDirection::Forward,
        state: MotionInitialState::at_rest(x, y, yaw_rad, u),
        profile,
    }
}

fn backend(substep_s: f64, tire_mu: f64) -> (DynamicV1Backend, BodyIndex) {
    let mut value = DynamicV1Backend::new(substep_s).unwrap();
    let body = value
        .register(&car(
            0.0,
            0.0,
            0.0,
            0.0,
            Some(VehiclePhysicsProfile {
                tire_mu: Some(tire_mu),
                ..Default::default()
            }),
        ))
        .unwrap();
    (value, body)
}

fn advance(
    value: &mut DynamicV1Backend,
    body: BodyIndex,
    seconds: f64,
    friction_scale: f64,
    mut intent: impl FnMut(Option<&MotionStepResult>) -> MotionIntent,
) -> MotionStepResult {
    let mut result: Option<MotionStepResult> = None;
    let mut t = 0.0;
    while t < seconds - 1e-12 {
        let next = intent(result.as_ref());
        result = Some(value.step(body, &next, TICK_S, friction_scale).unwrap());
        t += TICK_S;
    }
    result.unwrap()
}

#[test]
fn accelerates_coasts_under_resistance_and_brakes_deterministically() {
    let (mut value, body) = backend(DYNAMIC_V1_DEFAULT_SUBSTEP_S, 1.0);
    let launched = advance(&mut value, body, 5.0, 1.0, |_| straight());
    assert!(launched.state.longitudinal_velocity_mps > 11.0);
    assert!(
        launched.telemetry.front_normal_force_n
            < GENERIC_PASSENGER_CAR_PROFILE.mass_kg * STANDARD_GRAVITY_MPS2 * 0.6
    );

    let coast_speed = launched.state.longitudinal_velocity_mps;
    let p = GENERIC_PASSENGER_CAR_PROFILE;
    let resistance_accel = -(p.drag_coefficient_n_per_mps2 * coast_speed * coast_speed
        + p.rolling_resistance_coefficient * p.mass_kg * STANDARD_GRAVITY_MPS2)
        / p.mass_kg;
    let coasted = advance(&mut value, body, 2.0, 1.0, |_| MotionIntent {
        target_speed_mps: coast_speed,
        target_acceleration_mps2: resistance_accel,
        ..straight()
    });
    assert!(coasted.state.longitudinal_velocity_mps < coast_speed);

    let stopped = advance(&mut value, body, 3.0, 1.0, |_| MotionIntent {
        target_speed_mps: 0.0,
        target_acceleration_mps2: -8.0,
        ..straight()
    });
    assert!(stopped.state.longitudinal_velocity_mps < 0.1);
    assert!(stopped.state.wheel_angular_speed_radps < 0.2);
    assert!(stopped.telemetry.front_normal_force_n > stopped.telemetry.rear_normal_force_n);
}

#[derive(Debug, PartialEq)]
struct TurnOutcome {
    result: MotionStepResult,
    max_yaw_rate: f64,
    max_steer_step: f64,
    max_heading_step: f64,
    max_lateral_accel: f64,
}

fn run_turn() -> TurnOutcome {
    let radius_m = 30.0;
    let mut value = DynamicV1Backend::with_default_substep();
    let body = value
        .register(&car(radius_m, 0.0, std::f64::consts::FRAC_PI_2, 10.0, None))
        .unwrap();
    let mut max_yaw_rate: f64 = 0.0;
    let mut max_steer_step: f64 = 0.0;
    let mut max_heading_step: f64 = 0.0;
    let mut max_lateral_accel: f64 = 0.0;
    let mut prior = value.state(body).unwrap();
    let result = advance(&mut value, body, 8.0, 1.0, |previous| {
        let state = previous.map(|r| r.state).unwrap_or(prior);
        max_yaw_rate = max_yaw_rate.max(state.yaw_rate_radps.abs());
        max_steer_step = max_steer_step.max((state.steer_rad - prior.steer_rad).abs());
        let heading_delta = (state.yaw_rad - prior.yaw_rad)
            .sin()
            .atan2((state.yaw_rad - prior.yaw_rad).cos());
        max_heading_step = max_heading_step.max(heading_delta.abs());
        max_lateral_accel =
            max_lateral_accel.max((state.longitudinal_velocity_mps * state.yaw_rate_radps).abs());
        prior = state;
        let theta = state.y.atan2(state.x);
        let preview_theta = theta + 0.22;
        MotionIntent {
            target_speed_mps: 10.0,
            target_acceleration_mps2: 0.0,
            preview_point: Vec2 {
                x: radius_m * preview_theta.cos(),
                y: radius_m * preview_theta.sin(),
            },
            preview_heading_rad: preview_theta + std::f64::consts::FRAC_PI_2,
            ..straight()
        }
    });
    TurnOutcome {
        result,
        max_yaw_rate,
        max_steer_step,
        max_heading_step,
        max_lateral_accel,
    }
}

#[test]
fn tracks_a_constant_radius_path_and_develops_yaw_rate_after_a_steering_step() {
    let first = run_turn();
    let second = run_turn();
    assert_eq!(second, first);
    assert!(first.max_yaw_rate > 0.15);
    assert!((first.result.state.x.hypot(first.result.state.y) - 30.0).abs() < 4.0);
    assert!(first.result.state.steer_rad.abs() > 0.03);
    assert!(
        first.max_steer_step <= GENERIC_PASSENGER_CAR_PROFILE.steer_rate_rad_per_s * TICK_S + 1e-9
    );
    assert!(first.max_heading_step < 0.1);
    assert!(first.max_lateral_accel < 9.81);
}

fn run_friction(friction_scale: f64) -> MotionStepResult {
    let mut value = DynamicV1Backend::with_default_substep();
    let body = value
        .register(&car(18.0, 0.0, std::f64::consts::FRAC_PI_2, 16.0, None))
        .unwrap();
    let initial = value.state(body).unwrap();
    advance(&mut value, body, 4.0, friction_scale, |previous| {
        let state = previous.map(|r| r.state).unwrap_or(initial);
        let p = state.y.atan2(state.x) + 0.28;
        MotionIntent {
            target_speed_mps: 16.0,
            target_acceleration_mps2: 0.0,
            preview_point: Vec2 {
                x: 18.0 * p.cos(),
                y: 18.0 * p.sin(),
            },
            preview_heading_rad: p + std::f64::consts::FRAC_PI_2,
            ..straight()
        }
    })
}

#[test]
fn saturates_combined_tyre_force_and_responds_to_surface_friction() {
    let dry = run_friction(1.0);
    let slick = run_friction(0.35);
    assert!(dry.telemetry.tire_utilization <= 1.000_001);
    assert!(slick.telemetry.tire_utilization <= 1.000_001);
    assert!(slick.state.yaw_rate_radps.abs() < dry.state.yaw_rate_radps.abs());
}

#[test]
fn converges_between_5ms_and_2_5ms_substeps() {
    let run = |substep_s: f64| {
        let (mut value, body) = backend(substep_s, 1.0);
        advance(&mut value, body, 8.0, 1.0, |_| straight())
    };
    let coarse = run(0.005);
    let fine = run(0.0025);
    assert!((coarse.state.x - fine.state.x).abs() < 0.02);
    assert!(
        (coarse.state.longitudinal_velocity_mps - fine.state.longitudinal_velocity_mps).abs()
            < 0.03
    );
}

#[test]
fn partitions_a_tick_into_substeps_and_reports_them() {
    let (mut value, body) = backend(0.005, 1.0);
    let result = value.step(body, &straight(), TICK_S, 1.0).unwrap();
    assert_eq!(result.telemetry.substeps, 10);
    assert!((result.telemetry.substep_s - 0.005).abs() < 1e-15);
    let odd = value.step(body, &straight(), 0.012, 1.0).unwrap();
    assert_eq!(odd.telemetry.substeps, 3);
    assert!((odd.telemetry.substep_s - 0.004).abs() < 1e-15);
}

#[test]
fn reverse_gear_steers_toward_the_preview_point() {
    let mut value = DynamicV1Backend::with_default_substep();
    let init = MotionActorInitialization {
        motion_direction: MotionDirection::Reverse,
        state: MotionInitialState::at_rest(0.0, 0.0, 0.0, 0.0),
        ..car(0.0, 0.0, 0.0, 0.0, None)
    };
    let body = value.register(&init).unwrap();
    // Backing up along -x while the preview point drifts to +y.
    let result = advance(&mut value, body, 6.0, 1.0, |_| MotionIntent {
        motion_direction: MotionDirection::Reverse,
        target_speed_mps: 3.0,
        target_acceleration_mps2: 0.5,
        preview_point: Vec2 { x: -40.0, y: 6.0 },
        preview_heading_rad: std::f64::consts::PI - 0.15,
        ..straight()
    });
    assert!(result.state.longitudinal_velocity_mps < 0.0);
    assert!(result.state.x < -8.0);
    assert!(
        result.state.y > 0.5,
        "reverse steering must move the body toward the preview side, got y={}",
        result.state.y
    );
    assert!(result.state.steer_rad.abs() < GENERIC_PASSENGER_CAR_PROFILE.max_steer_rad - 1e-6);
}

#[test]
fn raw_control_stays_inside_the_jerk_and_steer_envelope() {
    let (mut value, body) = backend(DYNAMIC_V1_DEFAULT_SUBSTEP_S, 1.0);
    let intent = MotionIntent {
        control: Some(VehicleControl {
            throttle: 1.0,
            brake: 0.0,
            steer: 1.0,
            handbrake: false,
        }),
        ..straight()
    };
    let first = value.step(body, &intent, TICK_S, 1.0).unwrap();
    // Jerk-limited: 8 m/s³ over 50 ms allows at most 0.4 m/s² of commanded acceleration.
    assert!(first.telemetry.control.throttle < 0.2);
    assert!(
        first.state.steer_rad <= GENERIC_PASSENGER_CAR_PROFILE.steer_rate_rad_per_s * TICK_S + 1e-9
    );
    let later = advance(&mut value, body, 3.0, 1.0, |_| intent);
    assert!(later.state.steer_rad <= GENERIC_PASSENGER_CAR_PROFILE.max_steer_rad + 1e-12);
    assert!(later.state.longitudinal_velocity_mps > 0.0);
}

#[test]
fn recorded_state_placement_resets_the_swept_origin_and_command() {
    let (mut value, body) = backend(DYNAMIC_V1_DEFAULT_SUBSTEP_S, 1.0);
    advance(&mut value, body, 1.0, 1.0, |_| straight());
    let placed = VehicleMotionState {
        x: 250.0,
        y: 3.0,
        yaw_rad: 0.1,
        longitudinal_velocity_mps: 7.0,
        lateral_velocity_mps: 0.0,
        yaw_rate_radps: 0.0,
        steer_rad: 0.02,
        wheel_angular_speed_radps: 20.0,
        longitudinal_acceleration_mps2: 1.5,
    };
    value.set_state(body, placed).unwrap();
    assert_eq!(value.state(body).unwrap(), placed);
    let previous = value.previous_pose(body).unwrap();
    assert_eq!(
        (previous.x, previous.y, previous.yaw_rad),
        (250.0, 3.0, 0.1)
    );
    // A wall far behind the placed pose must not be swept through by the jump.
    let wall = WorldStaticCollider::fixed(
        "map:wall",
        Obb {
            center: Vec2 { x: 100.0, y: 0.0 },
            length_m: 0.2,
            width_m: 20.0,
            heading_rad: 0.0,
        },
    );
    let impulses = value.step_world(&[body], &[wall], TICK_S).unwrap();
    assert!(impulses.is_empty());
    let after = value.state(body).unwrap();
    assert_eq!(
        (after.x, after.y, after.yaw_rad),
        (placed.x, placed.y, placed.yaw_rad)
    );
    assert!((after.longitudinal_velocity_mps - placed.longitudinal_velocity_mps).abs() < 1e-12);
    assert!(after.lateral_velocity_mps.abs() < 1e-12);
}

#[test]
fn downed_walker_slides_passively_and_comes_to_rest() {
    let mut value = DynamicV1Backend::with_default_substep();
    let body = value
        .register(&MotionActorInitialization {
            actor_id: "walker".into(),
            kind: ActorKind::Pedestrian,
            dimensions: None,
            motion_direction: MotionDirection::Forward,
            state: MotionInitialState {
                lateral_velocity_mps: Some(4.0),
                ..MotionInitialState::at_rest(0.0, 0.0, 0.0, 3.0)
            },
            profile: None,
        })
        .unwrap();
    let intent = MotionIntent {
        downed: true,
        target_speed_mps: 1.4,
        ..straight()
    };
    let first = value.step(body, &intent, TICK_S, 1.0).unwrap();
    assert!(first.state.lateral_velocity_mps > 0.0 && first.state.lateral_velocity_mps < 4.0);
    assert_eq!(first.state.yaw_rad, 0.0);
    assert_eq!(first.telemetry.control, VehicleControl::ZERO);
    // Sliding at 0.55 g from 5 m/s stops in under a second.
    let rested = advance(&mut value, body, 1.5, 1.0, |_| intent);
    assert_eq!(rested.state.planar_speed_mps(), 0.0);
    assert!(
        rested.state.y > 0.5,
        "lateral component must carry the body sideways"
    );
    assert!(rested.state.x > 0.5);
}

#[test]
fn walker_agent_turns_toward_the_preview_point_and_holds_speed() {
    let mut value = DynamicV1Backend::with_default_substep();
    let body = value
        .register(&MotionActorInitialization {
            actor_id: "walker".into(),
            kind: ActorKind::Pedestrian,
            dimensions: None,
            motion_direction: MotionDirection::Forward,
            state: MotionInitialState::at_rest(0.0, 0.0, 0.0, 0.0),
            profile: None,
        })
        .unwrap();
    let result = advance(&mut value, body, 4.0, 1.0, |_| MotionIntent {
        target_speed_mps: 1.4,
        target_acceleration_mps2: 0.0,
        preview_point: Vec2 { x: 0.0, y: 50.0 },
        preview_heading_rad: std::f64::consts::FRAC_PI_2,
        ..straight()
    });
    assert!((result.state.longitudinal_velocity_mps - 1.4).abs() < 0.05);
    assert!((result.state.yaw_rad - std::f64::consts::FRAC_PI_2).abs() < 0.05);
    assert_eq!(result.state.steer_rad, 0.0);
    assert!(result.state.y > 3.0);
}

fn contact_body(rank: u32, x: f64, previous_x: f64, vx: f64, y: f64) -> PlanarCollisionBody {
    PlanarCollisionBody {
        rank,
        length_m: 4.0,
        width_m: 2.0,
        inverse_mass: 1.0 / 1_500.0,
        inverse_inertia: 1.0 / 2_500.0,
        previous: ContactPose {
            x: previous_x,
            y,
            yaw_rad: 0.0,
        },
        x,
        y,
        yaw_rad: 0.0,
        vx,
        vy: 0.0,
        angular_velocity: 0.0,
    }
}

fn solve(
    bodies: &mut [PlanarCollisionBody],
    statics: &[PlanarStaticCollider],
) -> Vec<CollisionImpulse> {
    let mut solver = PlanarContactSolver::new();
    solver
        .solve(
            bodies,
            statics,
            TICK_S,
            DEFAULT_CONTACT_RESTITUTION,
            DEFAULT_CONTACT_FRICTION,
        )
        .to_vec()
}

#[test]
fn swept_contact_prevents_a_high_speed_vehicle_tunneling_through_a_wall() {
    let mut bodies = [contact_body(0, 10.0, 0.0, 200.0, 0.0)];
    let wall = PlanarStaticCollider::fixed(
        1,
        Obb {
            center: Vec2 { x: 5.0, y: 0.0 },
            length_m: 0.2,
            width_m: 20.0,
            heading_rad: 0.0,
        },
    );
    let impulses = solve(&mut bodies, &[wall]);
    assert!(bodies[0].x < 2.92);
    assert!(bodies[0].vx <= 0.0);
    assert!(impulses[0].normal_impulse_ns > 200_000.0);
    assert_eq!(
        (impulses[0].a, impulses[0].b),
        (ContactRef::Dynamic(0), ContactRef::Static(0))
    );
}

#[test]
fn preserves_bounded_momentum_and_energy_for_equal_vehicle_impacts() {
    let mut bodies = [
        contact_body(0, 0.2, -0.3, 10.0, 0.0),
        contact_body(1, 3.8, 4.3, -10.0, 0.0),
    ];
    let before_momentum = 1_500.0 * (bodies[0].vx + bodies[1].vx);
    let before_energy = 0.5 * 1_500.0 * (bodies[0].vx.powi(2) + bodies[1].vx.powi(2));
    solve(&mut bodies, &[]);
    let after_momentum = 1_500.0 * (bodies[0].vx + bodies[1].vx);
    let after_energy = 0.5 * 1_500.0 * (bodies[0].vx.powi(2) + bodies[1].vx.powi(2));
    assert!((after_momentum - before_momentum).abs() < 1e-6);
    assert!(after_energy <= before_energy * 1.01);
}

#[test]
fn is_declaration_order_deterministic_and_depenetrates_resting_contacts() {
    let run = |reverse: bool| {
        let a = contact_body(0, 0.0, 0.0, 0.0, 0.0);
        let b = contact_body(1, 3.5, 3.5, 0.0, 0.0);
        let mut bodies = if reverse { [b, a] } else { [a, b] };
        solve(&mut bodies, &[]);
        let (a, b) = if reverse {
            (bodies[1], bodies[0])
        } else {
            (bodies[0], bodies[1])
        };
        ((a.x, a.vx), (b.x, b.vx))
    };
    let normal = run(false);
    let reversed = run(true);
    assert_eq!(reversed, normal);
    let remaining_penetration = 4.0 - (normal.1 .0 - normal.0 .0);
    assert!(remaining_penetration < 0.02);
}

#[test]
fn adds_angular_response_and_friction_for_a_glancing_impact() {
    let mut bodies = [contact_body(0, 3.0, 2.6, 8.0, 1.5)];
    bodies[0].vy = -3.0;
    let barrier = PlanarStaticCollider::fixed(
        1,
        Obb {
            center: Vec2 { x: 5.0, y: 0.0 },
            length_m: 0.3,
            width_m: 10.0,
            heading_rad: 0.0,
        },
    );
    solve(&mut bodies, &[barrier]);
    assert!(bodies[0].angular_velocity.abs() > 0.01);
    assert!(bodies[0].vx.hypot(bodies[0].vy) < 8.0f64.hypot(-3.0));
}

#[test]
fn broadphase_skips_far_pairs_without_changing_near_contacts() {
    // One touching pair among many far-separated bodies. The result must be
    // identical to solving the touching pair alone.
    let mut lone = [
        contact_body(0, 0.0, 0.0, 0.0, 0.0),
        contact_body(1, 3.5, 3.5, 0.0, 0.0),
    ];
    let lone_impulses = solve(&mut lone, &[]);
    let mut crowd: Vec<PlanarCollisionBody> = (0..64)
        .map(|i| {
            contact_body(
                i + 2,
                100.0 + 20.0 * f64::from(i),
                100.0 + 20.0 * f64::from(i),
                0.0,
                50.0,
            )
        })
        .collect();
    crowd.insert(0, contact_body(0, 0.0, 0.0, 0.0, 0.0));
    crowd.insert(1, contact_body(1, 3.5, 3.5, 0.0, 0.0));
    let mut solver = PlanarContactSolver::new();
    let impulses = solver.solve(
        &mut crowd,
        &[],
        TICK_S,
        DEFAULT_CONTACT_RESTITUTION,
        DEFAULT_CONTACT_FRICTION,
    );
    assert_eq!(impulses, lone_impulses.as_slice());
    assert_eq!((crowd[0].x, crowd[1].x), (lone[0].x, lone[1].x));
    for (i, body) in crowd[2..].iter().enumerate() {
        assert_eq!(
            body.x,
            100.0 + 20.0 * i as f64,
            "far body must be untouched"
        );
    }
    // Scratch is retained: a second solve on the same solver is identical.
    let mut again = [
        contact_body(0, 0.0, 0.0, 0.0, 0.0),
        contact_body(1, 3.5, 3.5, 0.0, 0.0),
    ];
    let second = solver.solve(
        &mut again,
        &[],
        TICK_S,
        DEFAULT_CONTACT_RESTITUTION,
        DEFAULT_CONTACT_FRICTION,
    );
    assert_eq!(second, lone_impulses.as_slice());
    assert_eq!(again[0].x, lone[0].x);
}

#[test]
fn unsorted_static_ids_are_canonicalised_by_id_rank() {
    let mut value = DynamicV1Backend::with_default_substep();
    let body = value.register(&car(10.0, 0.0, 0.0, 0.0, None)).unwrap();
    let wall = Obb {
        center: Vec2 { x: 12.4, y: 0.0 },
        length_m: 0.2,
        width_m: 20.0,
        heading_rad: 0.0,
    };
    let far = Obb {
        center: Vec2 { x: 500.0, y: 0.0 },
        length_m: 1.0,
        width_m: 1.0,
        heading_rad: 0.0,
    };
    // "zeta" sorts after "car", "alpha" before; slot order deliberately reversed.
    let statics = [
        WorldStaticCollider::fixed("zeta", wall),
        WorldStaticCollider::fixed("alpha", far),
    ];
    let contacts = value.step_world(&[body], &statics, TICK_S).unwrap();
    assert_eq!(contacts.len(), 1);
    assert_eq!(
        (contacts[0].a, contacts[0].b),
        (WorldContactRef::Body(body), WorldContactRef::Static(0))
    );
    assert!(contacts[0].normal_impulse_ns > 0.0);
}

#[test]
fn rotating_footprints_use_conservative_advancement() {
    let a0 = Obb {
        center: Vec2 { x: 0.0, y: 0.0 },
        length_m: 4.0,
        width_m: 2.0,
        heading_rad: 0.0,
    };
    let a1 = Obb {
        center: Vec2 { x: 0.0, y: 0.0 },
        length_m: 4.0,
        width_m: 2.0,
        heading_rad: std::f64::consts::FRAC_PI_2,
    };
    // A thin post just outside the box's width but inside its length: only the
    // rotation brings the corner onto it.
    let post = Obb {
        center: Vec2 { x: 0.0, y: 1.6 },
        length_m: 0.2,
        width_m: 0.2,
        heading_rad: 0.0,
    };
    let toi = swept_obb_time_of_impact(&a0, &a1, &post, &post)
        .expect("rotation must sweep into the post");
    assert!(toi > 0.0 && toi < 1.0, "toi={toi}");
    let still = Obb {
        center: Vec2 { x: 0.0, y: 3.0 },
        length_m: 0.2,
        width_m: 0.2,
        heading_rad: 0.0,
    };
    assert_eq!(swept_obb_time_of_impact(&a0, &a1, &still, &still), None);
}

#[test]
fn step_world_couples_bodies_and_records_contact_telemetry() {
    let mut value = DynamicV1Backend::with_default_substep();
    let mover = value
        .register(&MotionActorInitialization {
            actor_id: "mover".into(),
            ..car(0.0, 0.0, 0.0, 14.0, None)
        })
        .unwrap();
    let parked = value
        .register(&MotionActorInitialization {
            actor_id: "parked".into(),
            ..car(30.0, 0.0, 0.0, 0.0, None)
        })
        .unwrap();
    let hold = MotionIntent {
        target_speed_mps: 0.0,
        target_acceleration_mps2: 0.0,
        ..straight()
    };
    let mut contact_tick = None;
    for tick in 0..80 {
        value.step(mover, &straight(), TICK_S, 1.0).unwrap();
        value.step(parked, &hold, TICK_S, 1.0).unwrap();
        let impulses = value.step_world(&[parked, mover], &[], TICK_S).unwrap();
        if !impulses.is_empty() {
            contact_tick = Some(tick);
            assert_eq!(
                (impulses[0].a, impulses[0].b),
                (WorldContactRef::Body(mover), WorldContactRef::Body(parked))
            );
            break;
        }
    }
    assert!(
        contact_tick.is_some(),
        "the mover must reach the parked car"
    );
    let mover_telemetry = value.telemetry(mover).unwrap();
    let parked_telemetry = value.telemetry(parked).unwrap();
    assert!(mover_telemetry.collision_impulse_ns > 0.0);
    assert_eq!(mover_telemetry.collision_count, 1);
    assert_eq!(
        parked_telemetry.collision_impulse_ns,
        mover_telemetry.collision_impulse_ns
    );
    assert!(
        value.state(parked).unwrap().longitudinal_velocity_mps > 3.0,
        "the parked car must be shoved forward"
    );
    assert!(value.contacts().len() == 1);
    // Footprints never end a world step overlapping by more than the slop.
    let a = value.obb(mover).unwrap();
    let b = value.obb(parked).unwrap();
    assert!(b.center.x - a.center.x > 4.8 - 0.02);
}

#[test]
fn fixed_actors_have_infinite_mass_and_shove_dynamic_bodies() {
    let mut value = DynamicV1Backend::with_default_substep();
    let bike = value
        .register(&MotionActorInitialization {
            actor_id: "bike".into(),
            kind: ActorKind::Bicycle,
            dimensions: Some(ActorKind::Bicycle.default_dims()),
            ..car(5.0, 0.0, std::f64::consts::FRAC_PI_2, 0.0, None)
        })
        .unwrap();
    // A kinematic bus surface moving +x at 5 m/s, already touching the bike.
    let bus = WorldStaticCollider {
        id: "bus",
        obb: Obb {
            center: Vec2 { x: -1.2, y: 0.0 },
            length_m: 12.0,
            width_m: 2.55,
            heading_rad: 0.0,
        },
        velocity: Vec2 { x: 5.0, y: 0.0 },
        angular_velocity: 0.0,
    };
    let before = value.state(bike).unwrap().planar_speed_mps();
    value.step_world(&[bike], &[bus], TICK_S).unwrap();
    let after = value.state(bike).unwrap();
    assert!(after.planar_speed_mps() - before >= BALANCE_RECOVERY_DELTA_V_MPS);
    assert!(after.world_velocity().x > 0.0);
    assert!(value.telemetry(bike).unwrap().collision_count == 1);
}

#[test]
fn snapshot_round_trip_steps_identically() {
    let mut value = DynamicV1Backend::with_default_substep();
    let body = value.register(&car(0.0, 0.0, 0.0, 5.0, None)).unwrap();
    advance(&mut value, body, 1.0, 1.0, |_| straight());
    let json = serde_json::to_string(&value).unwrap();
    let mut restored: DynamicV1Backend = serde_json::from_str(&json).unwrap();
    assert_eq!(restored, value);
    let original = advance(&mut value, body, 1.0, 1.0, |_| straight());
    let replayed = advance(&mut restored, body, 1.0, 1.0, |_| straight());
    assert_eq!(replayed, original);
    assert_eq!(restored.body("car"), Some(body));
    assert_eq!(restored.actor_id(body), Some("car"));
}

#[test]
fn rejects_static_actors_and_invalid_axle_geometry() {
    let mut value = DynamicV1Backend::with_default_substep();
    let err = value
        .register(&MotionActorInitialization {
            kind: ActorKind::StaticObject,
            ..car(0.0, 0.0, 0.0, 0.0, None)
        })
        .unwrap_err();
    assert!(matches!(err, PhysicsError::StaticActor { .. }));
    let err = resolve_actor_physics_profile(
        ActorKind::Car,
        Some(&VehiclePhysicsProfile {
            cg_to_front_m: Some(3.0),
            ..Default::default()
        }),
    )
    .unwrap_err();
    assert!(matches!(err, PhysicsError::InvalidAxleGeometry { .. }));
    assert!(matches!(
        DynamicV1Backend::new(0.0),
        Err(PhysicsError::InvalidSubstep(_))
    ));
    assert!(matches!(
        value.step(BodyIndex(9), &straight(), TICK_S, 1.0),
        Err(PhysicsError::UnknownBody(9))
    ));
}

#[test]
fn every_moving_kind_has_a_plant_and_re_registration_keeps_the_index() {
    let mut value = DynamicV1Backend::with_default_substep();
    let kinds = [
        ActorKind::Vehicle,
        ActorKind::Car,
        ActorKind::Truck,
        ActorKind::Bus,
        ActorKind::Van,
        ActorKind::Motorcycle,
        ActorKind::Bicycle,
        ActorKind::Pedestrian,
        ActorKind::Scooter,
        ActorKind::SidewalkRobot,
        ActorKind::Drone,
        ActorKind::Animal,
    ];
    assert_eq!(actor_physics_profiles().len(), kinds.len());
    for (i, kind) in kinds.iter().enumerate() {
        let body = value
            .register(&MotionActorInitialization {
                actor_id: kind.as_str().to_owned(),
                kind: *kind,
                ..car(0.0, 4.0 * i as f64, 0.0, 2.0, None)
            })
            .unwrap();
        assert_eq!(body, BodyIndex(i as u32));
        assert_eq!(value.profile(body).unwrap().kind, *kind);
        value.step(body, &straight(), TICK_S, 1.0).unwrap();
    }
    let again = value
        .register(&MotionActorInitialization {
            actor_id: "truck".into(),
            kind: ActorKind::Truck,
            motion_direction: MotionDirection::Reverse,
            ..car(1.0, 1.0, 0.0, 3.0, None)
        })
        .unwrap();
    assert_eq!(again, BodyIndex(2));
    assert_eq!(value.len(), kinds.len());
    assert_eq!(value.state(again).unwrap().longitudinal_velocity_mps, -3.0);
    let ids: Vec<&str> = value.bodies().map(|(_, id)| id).collect();
    let mut sorted = ids.clone();
    sorted.sort_unstable();
    assert_eq!(ids, sorted);
}

/* ----------------------------------------------- golden maneuver parity */

/// Straight-line full-throttle run: seconds from rest to 100 km/h, and the
/// gears it passed through.
fn zero_to_100_kmh() -> (f64, Vec<i32>) {
    let mut value = DynamicV1Backend::new(DYNAMIC_V1_DEFAULT_SUBSTEP_S).unwrap();
    let body = value.register(&car(0.0, 0.0, 0.0, 0.0, None)).unwrap();
    let dt = 0.02;
    let mut t = 0.0;
    let mut gears = Vec::new();
    while t < 30.0 {
        let result = value
            .step(body, &FULL_THROTTLE, dt, 1.0)
            .expect("full-throttle step");
        t += dt;
        if gears.last() != Some(&result.telemetry.gear) {
            gears.push(result.telemetry.gear);
        }
        if result.state.longitudinal_velocity_mps >= 100.0 / 3.6 {
            return (t, gears);
        }
    }
    panic!("never reached 100 km/h");
}

/// Full-throttle maneuver intent: an unreachable speed target so the
/// controller keeps the pedal down for the whole run.
const FULL_THROTTLE: MotionIntent = MotionIntent {
    motion_direction: MotionDirection::Forward,
    target_speed_mps: 200.0,
    target_acceleration_mps2: 50.0,
    preview_point: Vec2 {
        x: 100_000.0,
        y: 0.0,
    },
    preview_heading_rad: 0.0,
    downed: false,
    control: None,
};

/// The published parity bands from `fixtures/physics/golden-maneuvers.v2.json`
/// and the table in `docs/engineering/physics-provenance.md`. Both reference
/// rows of a maneuver are asserted, so the effective band is their
/// intersection. These numbers are external measurements (CARLA 0.9.16) and
/// published figures — never fitted from this engine — so the gearbox has to
/// come to them rather than the other way round.
#[test]
fn golden_maneuvers_stay_inside_the_published_parity_bands() {
    let (zero_to_100_s, gears) = zero_to_100_kmh();
    // measured-carla 7.3 s ±12% and published 8.5 s ±10%.
    assert!(
        (7.3 * 0.88..=7.3 * 1.12).contains(&zero_to_100_s),
        "0-100 km/h {zero_to_100_s} s outside the CARLA band"
    );
    assert!(
        (8.5 * 0.90..=8.5 * 1.10).contains(&zero_to_100_s),
        "0-100 km/h {zero_to_100_s} s outside the published band"
    );
    // The run is a real gearbox run, not a single-ratio one: first gear is
    // engaged on the tick the throttle opens, and it reaches 100 km/h in third.
    assert_eq!(gears, vec![1, 2, 3], "gears traversed during the run");

    // Coastdown at 80 km/h, pedals released: SAE J1263 ≈ 0.25 m/s² ±15%.
    let mut value = DynamicV1Backend::new(DYNAMIC_V1_DEFAULT_SUBSTEP_S).unwrap();
    let body = value
        .register(&car(0.0, 0.0, 0.0, 80.0 / 3.6, None))
        .unwrap();
    let coast = MotionIntent {
        target_speed_mps: 0.0,
        target_acceleration_mps2: 0.0,
        control: Some(VehicleControl::ZERO),
        ..FULL_THROTTLE
    };
    let before = value.state(body).unwrap().longitudinal_velocity_mps;
    let coasted = value.step(body, &coast, 0.02, 1.0).unwrap();
    let coastdown = (before - coasted.state.longitudinal_velocity_mps) / 0.02;
    assert!(
        (0.25 * 0.85..=0.25 * 1.15).contains(&coastdown),
        "coastdown {coastdown} m/s2 outside the published band"
    );

    // Braking 100 -> 0: measured-carla 54.1 m ±15%, published 48.2 m ±10%,
    // FMVSS 135 ceiling 70.1 m.
    let mut value = DynamicV1Backend::new(DYNAMIC_V1_DEFAULT_SUBSTEP_S).unwrap();
    let body = value
        .register(&car(0.0, 0.0, 0.0, 100.0 / 3.6, None))
        .unwrap();
    let brake = MotionIntent {
        target_speed_mps: 0.0,
        target_acceleration_mps2: -20.0,
        ..FULL_THROTTLE
    };
    let mut t = 0.0;
    while t < 20.0 {
        let result = value.step(body, &brake, 0.02, 1.0).unwrap();
        t += 0.02;
        if result.state.longitudinal_velocity_mps <= 1e-6 {
            break;
        }
    }
    let distance = value.state(body).unwrap().x;
    assert!(
        (54.1 * 0.85..=54.1 * 1.15).contains(&distance),
        "stopping distance {distance} m outside the CARLA band"
    );
    assert!(
        (48.2 * 0.90..=48.2 * 1.10).contains(&distance),
        "stopping distance {distance} m outside the published band"
    );
    assert!(distance <= 70.1, "over the FMVSS 135 ceiling");
}

/// The handbrake is a rear-axle brake, not a pedal: it stops a coasting car
/// without any brake pedal input, and it locks the rear wheels doing it.
#[test]
fn handbrake_locks_the_rear_axle_and_stops_a_coasting_car() {
    let mut value = DynamicV1Backend::new(DYNAMIC_V1_DEFAULT_SUBSTEP_S).unwrap();
    let body = value.register(&car(0.0, 0.0, 0.0, 15.0, None)).unwrap();
    let pulled = MotionIntent {
        target_speed_mps: 15.0,
        target_acceleration_mps2: 0.0,
        control: Some(VehicleControl {
            handbrake: true,
            ..VehicleControl::ZERO
        }),
        ..FULL_THROTTLE
    };
    let mut t = 0.0;
    while t < 20.0 && value.state(body).unwrap().longitudinal_velocity_mps > 0.05 {
        value.step(body, &pulled, 0.02, 1.0).unwrap();
        t += 0.02;
    }
    assert!(t < 12.0, "handbrake took {t} s to stop a 15 m/s coast");
    let rear = value.telemetry(body).unwrap().wheel_speeds_radps;
    assert!(
        rear[2].abs() < 1.0 && rear[3].abs() < 1.0,
        "rear wheels should be stopped, got {rear:?}"
    );
}

/// Per-corner wheel speeds are a rigid-body reconstruction: straight ahead
/// all four match the rolling speed, and in a turn the outside wheels turn
/// faster than the inside ones.
#[test]
fn corner_wheel_speeds_split_across_the_track_in_a_turn() {
    let mut value = DynamicV1Backend::new(DYNAMIC_V1_DEFAULT_SUBSTEP_S).unwrap();
    let body = value.register(&car(0.0, 0.0, 0.0, 12.0, None)).unwrap();
    let straight_ahead = MotionIntent {
        target_speed_mps: 12.0,
        target_acceleration_mps2: 0.0,
        ..FULL_THROTTLE
    };
    let rolled = value.step(body, &straight_ahead, 0.05, 1.0).unwrap();
    let w = rolled.telemetry.wheel_speeds_radps;
    let rolling = 12.0 / GENERIC_PASSENGER_CAR_PROFILE.wheel_radius_m;
    for speed in w {
        assert!((speed - rolling).abs() < 1.0, "{w:?} vs rolling {rolling}");
    }

    let turning = MotionIntent {
        target_speed_mps: 12.0,
        target_acceleration_mps2: 0.0,
        preview_point: Vec2 { x: 30.0, y: 30.0 },
        ..FULL_THROTTLE
    };
    let mut turned = rolled;
    for _ in 0..40 {
        turned = value.step(body, &turning, 0.05, 1.0).unwrap();
    }
    let w = turned.telemetry.wheel_speeds_radps;
    assert!(turned.state.yaw_rate_radps > 0.05, "should be turning left");
    // Turning left: the right-hand wheels are on the outside of the arc.
    assert!(w[1] > w[0] && w[3] > w[2], "outside wheels lead: {w:?}");
}

/* ------------------------------------------------------- driver commands */

/// A live driver's command: an intent whose pedals are held by the caller.
/// The preview point is far ahead so the steer channel is the only thing the
/// command controls.
fn driven(throttle: f64, brake: f64, steer: f64, handbrake: bool) -> MotionIntent {
    MotionIntent {
        control: Some(VehicleControl {
            throttle,
            brake,
            steer,
            handbrake,
        }),
        ..FULL_THROTTLE
    }
}

fn drive_for(
    value: &mut DynamicV1Backend,
    body: BodyIndex,
    intent: &MotionIntent,
    seconds: f64,
) -> MotionStepResult {
    let dt = 0.02;
    let mut result = value.step(body, intent, dt, 1.0).expect("driven step");
    let mut t = dt;
    while t < seconds {
        result = value.step(body, intent, dt, 1.0).expect("driven step");
        t += dt;
    }
    result
}

/// The command contract a driving client relies on: the throttle accelerates
/// and runs up through the gears, the brake brings the body to a stop, and
/// the published telemetry says so.
#[test]
fn a_held_driver_command_accelerates_through_the_gears_and_stops_on_the_brake() {
    let mut value = DynamicV1Backend::new(DYNAMIC_V1_DEFAULT_SUBSTEP_S).unwrap();
    let body = value.register(&car(0.0, 0.0, 0.0, 0.0, None)).unwrap();

    let launched = drive_for(&mut value, body, &driven(1.0, 0.0, 0.0, false), 0.2);
    assert_eq!(launched.telemetry.gear, 1, "a launch engages first gear");

    let accelerated = drive_for(&mut value, body, &driven(1.0, 0.0, 0.0, false), 8.0);
    assert!(
        accelerated.state.longitudinal_velocity_mps > 25.0,
        "8 s of throttle should pass 25 m/s, got {}",
        accelerated.state.longitudinal_velocity_mps
    );
    assert!(
        accelerated.telemetry.gear > 1,
        "should have upshifted, still in {}",
        accelerated.telemetry.gear
    );
    assert!(
        accelerated.telemetry.engine_rpm > 1_000.0,
        "engine speed should follow the wheels: {}",
        accelerated.telemetry.engine_rpm
    );

    // The brake decelerates to a standstill and stops there: the body must
    // not be dragged through zero into the other direction by a pedal.
    let brake = driven(0.0, 1.0, 0.0, false);
    let mut t = 0.0;
    let entry_speed = accelerated.state.longitudinal_velocity_mps;
    while t < 10.0 {
        let result = value.step(body, &brake, 0.02, 1.0).unwrap();
        t += 0.02;
        assert!(
            result.state.longitudinal_velocity_mps >= 0.0,
            "braking must not push the body backwards while it is still \
             rolling forwards: {} m/s at t={t}",
            result.state.longitudinal_velocity_mps
        );
        if result.state.longitudinal_velocity_mps == 0.0 {
            break;
        }
    }
    assert!(
        t < entry_speed / 5.0,
        "stopping from {entry_speed} m/s took {t} s"
    );
}

/// A driving client sends pedals, not a gear lever. Reverse is reached the
/// way an automatic reaches it — stopped, on the brake — and the throttle
/// takes drive again from a standstill.
#[test]
fn pedals_alone_reverse_the_body_and_take_drive_again() {
    let mut value = DynamicV1Backend::new(DYNAMIC_V1_DEFAULT_SUBSTEP_S).unwrap();
    let body = value.register(&car(0.0, 0.0, 0.0, 0.0, None)).unwrap();

    let reversing = drive_for(&mut value, body, &driven(0.0, 1.0, 0.0, false), 2.0);
    assert_eq!(reversing.telemetry.gear, GEAR_REVERSE);
    assert!(
        reversing.state.longitudinal_velocity_mps < -1.0,
        "holding the brake from rest should back the body up, got {}",
        reversing.state.longitudinal_velocity_mps
    );
    assert!(
        reversing.state.x < -0.5,
        "should have moved back: {}",
        reversing.state.x
    );

    // The throttle is the service brake while reversing, and once stopped it
    // is the request to pull away forwards again.
    let forward = drive_for(&mut value, body, &driven(1.0, 0.0, 0.0, false), 3.0);
    assert!(forward.telemetry.gear > 0, "gear {}", forward.telemetry.gear);
    assert!(
        forward.state.longitudinal_velocity_mps > 1.0,
        "should be driving forwards, got {}",
        forward.state.longitudinal_velocity_mps
    );
}

/// The handbrake is the way a driver parks: pedals released, it holds a
/// stopped body still instead of letting the brake pedal take reverse. It is
/// a 40% rear-axle brake, so it does not pretend to beat a full throttle.
#[test]
fn the_handbrake_parks_a_stopped_body_with_the_pedals_released() {
    let mut value = DynamicV1Backend::new(DYNAMIC_V1_DEFAULT_SUBSTEP_S).unwrap();
    let body = value.register(&car(0.0, 0.0, 0.0, 0.0, None)).unwrap();
    let held = drive_for(&mut value, body, &driven(0.0, 0.0, 0.0, true), 6.0);
    assert_eq!(
        held.state.longitudinal_velocity_mps, 0.0,
        "the parking brake should hold it at rest"
    );
    assert!(
        held.state.x.abs() < 1e-9,
        "should not have crept: {}",
        held.state.x
    );
    assert_eq!(held.telemetry.gear, GEAR_NEUTRAL, "parked, so no gear");
}
