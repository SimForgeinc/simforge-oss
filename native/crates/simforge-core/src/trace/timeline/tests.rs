use std::io::Read;

use super::sampler::{self, flash_on, lights_at, locate, scene_yup, signals_at};
use super::*;

fn example(name: &str) -> SimTrace {
    let path = format!(
        "{}/../../../examples/edge-cases/{name}/scenario.trace.json.gz",
        env!("CARGO_MANIFEST_DIR")
    );
    let gz = std::fs::read(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
    let mut json = Vec::new();
    flate2::read::GzDecoder::new(&gz[..])
        .read_to_end(&mut json)
        .unwrap();
    SimTrace::from_json_slice(&json).unwrap()
}

const EXAMPLES: [&str; 4] = [
    "01-construction-chicane-reversing-truck",
    "03-red-light-ambulance-preemption",
    "04-child-emerging-behind-bus",
    "09-stalled-vehicle-beyond-sight",
];

fn build(name: &str) -> RenderTimeline {
    build_render_timeline(&example(name), &HeightField::flat(0.0), None).unwrap()
}

#[test]
fn build_is_deterministic_and_keyed() {
    let trace = example(EXAMPLES[0]);
    let flat = HeightField::flat(0.0);
    let a = build_render_timeline(&trace, &flat, Some("cat")).unwrap();
    let b = build_render_timeline(&trace, &flat, Some("cat")).unwrap();
    assert_eq!(a.sha256().unwrap(), b.sha256().unwrap());
    assert_eq!(a.identity.trace_sha256, trace.digest().unwrap());
    assert_eq!(
        a.identity.timeline_key,
        timeline_key(&a.identity.trace_sha256, &flat.source().digest, Some("cat"))
    );
    // Every key input moves the key.
    let other_catalog = build_render_timeline(&trace, &flat, None).unwrap();
    assert_ne!(other_catalog.identity.timeline_key, a.identity.timeline_key);
    let other_height = build_render_timeline(&trace, &HeightField::flat(1.0), Some("cat")).unwrap();
    assert_ne!(other_height.identity.timeline_key, a.identity.timeline_key);
    assert_eq!(a.time.time_origin_s, 0.0);
    assert_eq!(a.time.warmup_s, trace.header.warmup_seconds);
    assert_eq!(a.time.xosc_time_offset_s, trace.header.warmup_seconds);
    assert_eq!(a.time.clip_end_s, *a.t.last().unwrap());
}

#[test]
fn json_round_trip_preserves_the_content_digest() {
    for name in EXAMPLES {
        let tl = build(name);
        let json = tl.to_json().unwrap();
        let back = RenderTimeline::from_json_slice(json.as_bytes()).unwrap();
        assert_eq!(back, tl, "{name}");
        assert_eq!(back.sha256().unwrap(), tl.sha256().unwrap());
    }
}

#[test]
fn rejects_other_dt_and_other_maps() {
    let mut trace = example(EXAMPLES[0]);
    trace.header.dt = 0.05;
    assert!(matches!(
        build_render_timeline(&trace, &HeightField::flat(0.0), None),
        Err(TimelineError::UnsupportedDt { .. })
    ));
}

#[test]
fn sampler_is_exact_at_ticks_and_linear_between() {
    for name in EXAMPLES {
        let tl = build(name);
        for actor in &tl.actors {
            let tr = &actor.track;
            for i in (0..tl.t.len()).step_by(7) {
                let p = sampler::pose(&tl, &actor.id, tl.t[i]).unwrap();
                assert_eq!(p.present, tr.present[i] == 1);
                if !p.present {
                    continue;
                }
                assert_eq!(p.tick as usize, i);
                assert_eq!(p.x, tr.x[i]);
                assert_eq!(p.y, tr.y[i]);
                assert_eq!(p.z, tr.z[i]);
                assert_eq!(p.heading_rad, tr.heading_rad[i]);
                assert_eq!(p.pitch_rad, tr.pitch_rad[i]);
                assert_eq!(p.roll_rad, tr.roll_rad[i]);
                assert_eq!(p.speed_mps, tr.speed_mps[i]);
                if i + 1 < tl.t.len() && tr.present[i + 1] == 1 {
                    let mid = (tl.t[i] + tl.t[i + 1]) / 2.0;
                    let m = sampler::pose(&tl, &actor.id, mid).unwrap();
                    assert!((m.x - (tr.x[i] + tr.x[i + 1]) / 2.0).abs() < 1e-9);
                    assert!((m.z - (tr.z[i] + tr.z[i + 1]) / 2.0).abs() < 1e-9);
                    let d = wrap_pi(tr.heading_rad[i + 1] - tr.heading_rad[i]);
                    assert!((m.heading_rad - (tr.heading_rad[i] + d / 2.0)).abs() < 1e-12);
                }
            }
        }
    }
}

#[test]
fn heading_interpolates_along_the_shortest_arc() {
    let mut tl = build(EXAMPLES[0]);
    let actor = &mut tl.actors[0];
    actor.track.present[10] = 1;
    actor.track.present[11] = 1;
    actor.track.heading_rad[10] = 3.1;
    actor.track.heading_rad[11] = -3.1;
    let id = actor.id.clone();
    let mid = (tl.t[10] + tl.t[11]) / 2.0;
    let p = sampler::pose(&tl, &id, mid).unwrap();
    // Crosses +π rather than sweeping through 0.
    assert!((p.heading_rad - (3.1 + (2.0 * std::f64::consts::PI - 6.2) / 2.0)).abs() < 1e-12);
}

#[test]
fn lifecycle_edges_are_absent_before_spawn_and_at_despawn() {
    let tl = build("03-red-light-ambulance-preemption");
    let ambulance = tl.actor("ambulance").unwrap();
    assert_eq!(ambulance.lifecycle.len(), 1);
    let interval = ambulance.lifecycle[0];
    let despawn = interval.despawn_tick.expect("ambulance leaves") as usize;
    let last = despawn - 1;
    // Held (not interpolated toward the despawned sample) right before despawn.
    let before = (tl.t[last] + tl.t[despawn]) / 2.0;
    let held = sampler::pose(&tl, "ambulance", before).unwrap();
    assert!(held.present);
    assert_eq!(held.x, ambulance.track.x[last]);
    assert_eq!(held.heading_rad, ambulance.track.heading_rad[last]);
    assert!(
        !sampler::pose(&tl, "ambulance", tl.t[despawn])
            .unwrap()
            .present
    );

    // Synthetic late spawn: absent strictly before the spawn tick.
    let mut tl = tl;
    let a = &mut tl.actors[0];
    for p in &mut a.track.present[..20] {
        *p = 0;
    }
    a.lifecycle = lifecycle_of(&a.track.present);
    let id = a.id.clone();
    assert!(!sampler::pose(&tl, &id, tl.t[19] + 0.01).unwrap().present);
    assert!(sampler::pose(&tl, &id, tl.t[20]).unwrap().present);
    assert_eq!(tl.actor(&id).unwrap().lifecycle[0].spawn_tick, 20);
}

#[test]
fn sampling_domain_is_the_clip() {
    let tl = build(EXAMPLES[0]);
    let id = tl.actors[0].id.clone();
    assert!(sampler::pose(&tl, &id, -1e-3).is_err());
    assert!(sampler::pose(&tl, &id, tl.time.clip_end_s + 1e-3).is_err());
    assert!(sampler::pose(&tl, &id, -1e-10).unwrap().present);
    let (i, f) = locate(&tl, tl.time.clip_end_s).unwrap();
    assert_eq!((i, f), (tl.t.len() - 1, 0.0));
    assert!(sampler::pose(&tl, "nobody", 0.0).is_err());
}

#[test]
fn velocity_follows_speed_and_heading_and_reversing_is_signed() {
    let mut trace = example(EXAMPLES[0]);
    let src = trace.ticks.actors.get_mut("reversing-truck").unwrap();
    for i in 100..300 {
        src.motion_direction[i] = crate::physics::MotionDirection::Reverse;
    }
    let moving = (100..300)
        .find(|i| src.speed_mps[*i] > 0.1)
        .expect("truck moves");
    let tl = build_render_timeline(&trace, &HeightField::flat(0.0), None).unwrap();
    let truck = tl.actor("reversing-truck").unwrap();
    assert!(
        truck.track.speed_mps[moving] < 0.0,
        "reverse speed is signed"
    );
    assert!(lights_at(&tl, &truck.id, tl.t[150]).unwrap().reverse);
    assert!(!lights_at(&tl, &truck.id, tl.t[350]).unwrap().reverse);
    let reverse_on = truck
        .lights
        .iter()
        .any(|c| c.light == LightKind::Reverse && c.mode == LightMode::On);
    assert!(reverse_on);
    for i in (0..tl.t.len()).step_by(50) {
        let p = sampler::pose(&tl, &truck.id, tl.t[i]).unwrap();
        let v = p.speed_mps;
        assert!((p.velocity[0] - v * crate::math::cos(p.heading_rad)).abs() < 1e-12);
        assert!((p.velocity[1] - v * crate::math::sin(p.heading_rad)).abs() < 1e-12);
    }
}

#[test]
fn light_cues_become_timeline_lights() {
    let tl = build(EXAMPLES[0]);
    let truck = tl.actor("reversing-truck").unwrap();
    let change = truck
        .lights
        .iter()
        .find(|c| c.light == LightKind::IndicatorRight)
        .expect("indicator cue");
    assert_eq!(change.mode, LightMode::Flashing);
    let t_on = tl.t[change.tick as usize];
    let whole = t_on.ceil();
    assert!(lights_at(&tl, &truck.id, whole).unwrap().indicator_right);
    assert!(
        !lights_at(&tl, &truck.id, whole + 0.6)
            .unwrap()
            .indicator_right
    );

    let tl = build("09-stalled-vehicle-beyond-sight");
    let stalled = tl.actor("stalled-vehicle").unwrap();
    assert!(lights_at(&tl, &stalled.id, 10.0).unwrap().indicator_left);
    assert!(lights_at(&tl, &stalled.id, 10.0).unwrap().indicator_right);

    let tl = build("04-child-emerging-behind-bus");
    assert!(lights_at(&tl, "focus-vehicle", 18.0).unwrap().brake);
}

#[test]
fn signals_hold_from_their_change_tick() {
    let trace = example("04-child-emerging-behind-bus");
    let tl = build_render_timeline(&trace, &HeightField::flat(0.0), None).unwrap();
    assert!(!trace.ticks.signals.is_empty());
    assert_eq!(tl.signals.len(), trace.ticks.signals.len());
    for (id, track) in &trace.ticks.signals {
        for i in (0..tl.t.len()).step_by(13) {
            let at = signals_at(&tl, tl.t[i] + 0.001).unwrap();
            assert_eq!(at[id], track.phase[i], "{id} tick {i}");
        }
    }
}

#[test]
fn flash_phase_is_on_at_zero_half_duty() {
    assert!(flash_on(0.0));
    assert!(flash_on(0.49));
    assert!(!flash_on(0.5));
    assert!(!flash_on(0.99));
    assert!(flash_on(1.0));
    assert!(flash_on(7.25));
}

#[test]
fn body_attitude_signs_follow_openscenario() {
    let tl = build("04-child-emerging-behind-bus");
    // Braking (speed falling) must pitch the nose down: positive pitch.
    let car = tl.actor("focus-vehicle").unwrap();
    let tr = &car.track;
    let mut saw = false;
    for i in 5..tl.t.len() {
        let decel = (tr.speed_mps[i - 5] - tr.speed_mps[i]) / (5.0 * TIMELINE_DT_S);
        if tr.present[i] == 1 && decel > 2.0 {
            assert!(
                tr.body_pitch_rad[i] > 0.0,
                "tick {i}: braking must be nose down"
            );
            saw = true;
        }
        assert!(tr.body_pitch_rad[i].abs() <= body::MAX_RAD + 1e-9);
        assert!(tr.body_roll_rad[i].abs() <= body::MAX_RAD + 1e-9);
        // sampler/2: the actor transform carries road attitude only; body
        // attitude is for the model's `body` node.
        assert_eq!(tr.pitch_rad[i], tr.road_pitch_rad[i]);
        assert_eq!(tr.roll_rad[i], tr.road_roll_rad[i]);
    }
    assert!(saw, "fixture brakes hard at least once");
    // Pedestrians carry no attitude and no wheels.
    let child = tl.actor("child").unwrap();
    assert!(child.track.pitch_rad.iter().all(|v| *v == 0.0));
    assert!(child.track.wheel_spin_rad.is_none());
}

#[test]
fn scene_yup_projection_matches_scene_state_conventions() {
    let tl = build(EXAMPLES[0]);
    let p = sampler::pose(&tl, "focus-vehicle", 3.0).unwrap();
    let (pos, q) = scene_yup(&p, true);
    assert_eq!(pos, [p.x, p.z, -p.y]);
    let expect = super::super::scene_state::yaw_to_quaternion(p.heading_rad);
    for k in 0..4 {
        assert!((q[k] - expect[k]).abs() < 1e-15);
    }
    // Nose down (OSC p > 0) at yaw 0 rotates body +X toward scene -Y.
    let mut level = p;
    level.heading_rad = 0.0;
    level.roll_rad = 0.0;
    level.pitch_rad = 0.1;
    let (_, q) = scene_yup(&level, false);
    let fwd = rotate(q, [1.0, 0.0, 0.0]);
    assert!(fwd[1] < -0.09);
    // Right side down (OSC r > 0) at yaw 0: body +Z (right) toward scene -Y.
    level.pitch_rad = 0.0;
    level.roll_rad = 0.1;
    let (_, q) = scene_yup(&level, false);
    let right = rotate(q, [0.0, 0.0, 1.0]);
    assert!(right[1] < -0.09);
}

fn rotate(q: [f64; 4], v: [f64; 3]) -> [f64; 3] {
    let [x, y, z, w] = q;
    let u = [x, y, z];
    let cross = |a: [f64; 3], b: [f64; 3]| {
        [
            a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0],
        ]
    };
    let t = cross(u, v).map(|c| 2.0 * c);
    let c2 = cross(u, t);
    [
        v[0] + w * t[0] + c2[0],
        v[1] + w * t[1] + c2[1],
        v[2] + w * t[2] + c2[2],
    ]
}

#[test]
fn stored_validation_rejects_tampered_lifecycle() {
    let mut tl = build(EXAMPLES[0]);
    tl.actors[0].lifecycle.clear();
    let json = tl.to_json().unwrap();
    assert!(matches!(
        RenderTimeline::from_json_slice(json.as_bytes()),
        Err(TimelineError::Malformed(_))
    ));
}

#[test]
fn origin_follows_tags_and_ambient_ids() {
    let t = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    assert_eq!(actor_origin(&t(&["sumo:abc"]), false), ActorOrigin::Sumo);
    assert_eq!(actor_origin(&t(&["sumo"]), true), ActorOrigin::Sumo);
    assert_eq!(
        actor_origin(&t(&["ambient:city"]), false),
        ActorOrigin::NativeAmbient
    );
    assert_eq!(
        actor_origin(&t(&["catalog:x"]), true),
        ActorOrigin::NativeAmbient
    );
    assert_eq!(
        actor_origin(&t(&["sumoish", "ambiently"]), false),
        ActorOrigin::Authored
    );
}

#[test]
fn road_attitude_on_an_incline_follows_openscenario_signs() {
    // z rises 10 % toward +x: a body heading +x climbs (nose up, p < 0);
    // heading -x descends (nose down, p > 0).
    let trace = example(EXAMPLES[0]);
    let tl = build_render_timeline(&trace, &HeightField::plane(5.0, 0.1, 0.0), None).unwrap();
    let mut checked = 0;
    for actor in tl.actors.iter().filter(|a| four_wheeled(a.kind)) {
        let tr = &actor.track;
        for i in 0..tl.t.len() {
            if tr.present[i] != 1 {
                continue;
            }
            assert!((tr.z[i] - (5.0 + 0.1 * tr.x[i])).abs() < 1e-4);
            let c = crate::math::cos(tr.heading_rad[i]);
            if c.abs() > 0.5 {
                assert_eq!(tr.road_pitch_rad[i] < 0.0, c > 0.0, "{} tick {i}", actor.id);
                checked += 1;
            }
            // Roll on a slope along x: heading +y has the right side at +x
            // (higher), so the right side is up: r < 0.
            let s = crate::math::sin(tr.heading_rad[i]);
            if s.abs() > 0.5 {
                assert_eq!(tr.road_roll_rad[i] < 0.0, s > 0.0, "{} tick {i}", actor.id);
            }
        }
    }
    assert!(checked > 100);
}

#[test]
fn knockdown_is_a_monotonic_downed_flag() {
    let mut trace = example(EXAMPLES[1]);
    trace
        .ticks
        .actors
        .get_mut("pedestrian")
        .unwrap()
        .down_since_s = Some(4.011);
    let tl = build_render_timeline(&trace, &HeightField::flat(0.0), None).unwrap();
    let ped = tl.actor("pedestrian").unwrap();
    assert_eq!(ped.downed_since_tick, Some(201));
    assert!(!sampler::pose(&tl, "pedestrian", 4.0).unwrap().downed);
    assert!(sampler::pose(&tl, "pedestrian", 4.02).unwrap().downed);
    assert!(sampler::pose(&tl, "pedestrian", 19.0).unwrap().downed);
    let canonical = tl.to_canonical_json().unwrap();
    assert_eq!(crate::hash::sha256(&canonical), tl.sha256().unwrap());
}

#[test]
fn scene_state_document_projects_the_sampler() {
    let tl = build_render_timeline(
        &example(EXAMPLES[1]),
        &HeightField::plane(3.0, 0.01, 0.02),
        None,
    )
    .unwrap();
    let times: Vec<f64> = (0..240)
        .map(|k| k as f64 / 12.0)
        .filter(|t| *t <= 20.0)
        .collect();
    let doc = sampler::scene_state_document(&tl, &times, false).unwrap();
    assert_eq!(doc.frames.len(), times.len());
    assert!((doc.dt - 1.0 / 12.0).abs() < 1e-12);
    for (frame, t) in doc.frames.iter().zip(&times) {
        for rec in &frame.actors {
            let p = sampler::pose(&tl, &rec.id, *t).unwrap();
            if !p.present {
                assert_eq!(rec.kind, crate::trace::scene_state::ActorTickKind::Despawn);
                continue;
            }
            assert_eq!(rec.position, [p.x, p.z, -p.y]);
        }
    }
    let ambulance: Vec<_> = doc
        .frames
        .iter()
        .filter_map(|f| {
            f.actors
                .iter()
                .find(|a| a.id == "ambulance")
                .map(|a| a.kind)
        })
        .collect();
    assert_eq!(
        ambulance.first(),
        Some(&crate::trace::scene_state::ActorTickKind::Spawn)
    );
    assert_eq!(
        ambulance.last(),
        Some(&crate::trace::scene_state::ActorTickKind::Despawn)
    );
}

#[test]
fn header_origin_wins_over_the_tag_rule() {
    let mut trace = example(EXAMPLES[0]);
    trace
        .header
        .actor_metadata
        .get_mut("worker")
        .unwrap()
        .origin = Some(ActorOrigin::Sumo);
    let tl = build_render_timeline(&trace, &HeightField::flat(0.0), None).unwrap();
    assert_eq!(tl.actor("worker").unwrap().origin, ActorOrigin::Sumo);
    assert_eq!(
        tl.actor("focus-vehicle").unwrap().origin,
        ActorOrigin::Authored
    );
}

/// The authored paint travels as the compiler's `studio:body-color:` tag;
/// the timeline and the scene-state projection bind it to `color`, which
/// renderers apply to the model's paint slot.
#[test]
fn studio_body_color_tag_binds_actor_color() {
    let mut trace = example(EXAMPLES[0]);
    trace
        .header
        .actor_metadata
        .get_mut("focus-vehicle")
        .unwrap()
        .tags
        .push("studio:body-color:#8c2f2f".into());
    let tl = build_render_timeline(&trace, &HeightField::flat(0.0), None).unwrap();
    assert_eq!(
        tl.actor("focus-vehicle").unwrap().color.as_deref(),
        Some("#8c2f2f")
    );
    assert_eq!(tl.actor("worker").unwrap().color, None);
    let doc = sampler::scene_state_document(&tl, &[0.0], false).unwrap();
    let desc = doc.actors.iter().find(|a| a.id == "focus-vehicle").unwrap();
    assert_eq!(desc.color.as_deref(), Some("#8c2f2f"));
}
