//! Engine ground contact on the committed Richmond Field Station closure
//! (docs/engineering/ground-height.md): every present body in the trace
//! stands on the rendered road surface, the trace carries the contact, and
//! the render timeline copies it (or derives the same values for a trace
//! recorded without contact).

use std::io::Read;
use std::path::PathBuf;
use std::sync::Arc;

use simforge_core::engine::{ContactGeometry, GroundContext, RunOptions, Simulation};
use simforge_core::map::ground::GroundSurface;
use simforge_core::map::{LaneGraph, TopologyIndex};
use simforge_core::trace::timeline::{
    build_render_timeline, ContactOrigin, HeightField, TimelineError,
};
use simforge_core::trace::SimTrace;

fn fixture(path: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .join(path)
}

fn read(path: &str) -> Vec<u8> {
    std::fs::read(fixture(path)).unwrap_or_else(|e| panic!("{path}: {e}"))
}

fn gunzip(bytes: &[u8]) -> Vec<u8> {
    if bytes.starts_with(&[0x1f, 0x8b]) {
        let mut out = Vec::new();
        flate2::read::GzDecoder::new(bytes)
            .read_to_end(&mut out)
            .unwrap();
        out
    } else {
        bytes.to_vec()
    }
}

const MAP: &str = "fixtures/golden-traces/maps/richmond-field-station";

fn richmond() -> (Arc<LaneGraph>, Arc<GroundContext>, TopologyIndex) {
    let topology = TopologyIndex::decode(&read(&format!("{MAP}/topology-index.json.gz"))).unwrap();
    let graph = Arc::new(LaneGraph::new(topology.clone()));
    let xodr = gunzip(&read(&format!("{MAP}/map.xodr.gz")));
    let ground = GroundContext::from_bytes(
        &read(&format!("{MAP}/derived/ground/ground-mesh.bin")),
        Some((&xodr, &topology)),
    )
    .unwrap();
    (graph, Arc::new(ground), topology)
}

fn run(input: &str, ground: Option<Arc<GroundContext>>, graph: &Arc<LaneGraph>) -> SimTrace {
    let input = simforge_core::parse_scenario_input_bytes(&gunzip(&read(input))).unwrap();
    let mut options = RunOptions::new(Arc::clone(graph));
    options.ground = ground;
    Simulation::new(input.normalized(), options)
        .unwrap()
        .run()
        .unwrap()
        .trace
}

#[test]
fn every_present_body_stands_on_the_rendered_surface() {
    let (graph, ground, _) = richmond();
    let surface: &GroundSurface = ground.surface();
    for input in [
        "fixtures/golden-traces/inputs/rfs-stop-and-go.input.json",
        "fixtures/golden-traces/inputs/rfs-uturn-van.input.json",
        "fixtures/golden-traces/inputs/rfs-walkers-crossing.input.json",
    ] {
        let trace = run(input, Some(Arc::clone(&ground)), &graph);
        assert_eq!(trace.header.ground_digest.as_deref(), Some(ground.digest()));
        let mut checked = 0;
        for (id, track) in &trace.ticks.actors {
            let contact = track.contact.as_ref().expect("contact channels");
            let meta = &trace.header.actor_metadata[id];
            let wheelbase =
                simforge_core::physics::actor_physics_profile(meta.kind).map(|p| p.wheelbase_m);
            let geometry = ContactGeometry::for_actor(meta.kind, &meta.dims, wheelbase);
            let layout = match geometry {
                ContactGeometry::FourWheel {
                    half_wheelbase_m: a,
                    half_track_m: b,
                } => [(a, b), (a, -b), (-a, b), (-a, -b)],
                ContactGeometry::TwoWheel {
                    half_wheelbase_m: a,
                } => [(a, 0.0), (a, 0.0), (-a, 0.0), (-a, 0.0)],
                ContactGeometry::Point => [(0.0, 0.0); 4],
            };
            for i in 0..trace.ticks.t.len() {
                if track.present[i] != 1 {
                    continue;
                }
                // Every wheel stands on the rendered surface: the body plane
                // plus that wheel's drop is the surface under the wheel.
                let probes = geometry.probes(track.x[i], track.y[i], track.heading_rad[i]);
                let (tp, tr) = (contact.pitch_rad[i].tan(), contact.roll_rad[i].tan());
                for (k, ((px, py), (u, v))) in probes.iter().zip(layout).enumerate() {
                    let wheel = contact.z[i] - u * tp + v * tr + contact.wheel_drop_m[i][k];
                    let under = surface
                        .contact(*px, *py, wheel, 0.35, None)
                        .unwrap_or_else(|e| panic!("{id} tick {i} wheel {k}: {e}"));
                    assert!(
                        (under.z - wheel).abs() < 0.003,
                        "{id} tick {i} wheel {k}: wheel bottom {wheel} vs surface {}",
                        under.z
                    );
                }
                assert!(contact.pitch_rad[i].abs() < 0.2 && contact.roll_rad[i].abs() < 0.2);
                checked += 1;
            }
        }
        assert!(checked > 500, "{input}: {checked}");
        // The trace round-trips through its own validation.
        let json = serde_json::to_vec(&trace).unwrap();
        assert_eq!(
            SimTrace::from_json_slice(&json)
                .unwrap()
                .header
                .ground_digest,
            trace.header.ground_digest
        );
    }
}

#[test]
fn contact_is_deterministic() {
    let (graph, ground, _) = richmond();
    let input = "fixtures/golden-traces/inputs/rfs-stop-and-go.input.json";
    let a = run(input, Some(Arc::clone(&ground)), &graph);
    let b = run(input, Some(Arc::clone(&ground)), &graph);
    assert_eq!(a.digest().unwrap(), b.digest().unwrap());
}

#[test]
fn a_trace_without_contact_gets_the_same_contact_derived_at_timeline_build() {
    let (graph, ground, _) = richmond();
    let input = "fixtures/golden-traces/inputs/rfs-stop-and-go.input.json";
    let grounded = run(input, Some(Arc::clone(&ground)), &graph);
    let bare = run(input, None, &graph);
    assert!(bare.header.ground_digest.is_none());
    assert!(bare.ticks.actors.values().all(|t| t.contact.is_none()));
    let height = HeightField::ground(Arc::clone(&ground));
    let from_trace = build_render_timeline(&grounded, &height, None).unwrap();
    let derived = build_render_timeline(&bare, &height, None).unwrap();
    assert_eq!(from_trace.contact_origin, Some(ContactOrigin::Trace));
    assert_eq!(
        derived.contact_origin,
        Some(ContactOrigin::DerivedAtTimelineBuild)
    );
    assert_eq!(from_trace.height_source.kind, "ground-contact/v1");
    assert_eq!(
        from_trace.height_source.ground_sha256.as_deref(),
        Some(ground.digest())
    );
    // Same poses, same solver: identical contact.
    for (a, b) in from_trace.actors.iter().zip(&derived.actors) {
        assert_eq!(a.id, b.id);
        assert_eq!(a.track.z, b.track.z, "{}", a.id);
        assert_eq!(a.track.road_pitch_rad, b.track.road_pitch_rad, "{}", a.id);
        assert_eq!(a.track.road_roll_rad, b.track.road_roll_rad, "{}", a.id);
    }
    // The render contact gate: every wheel of both timelines is on the
    // rendered surface within 3 cm.
    for timeline in [&from_trace, &derived] {
        let gate = simforge_core::trace::timeline::contact_gate::check_contact(
            timeline,
            ground.surface(),
            simforge_core::trace::timeline::contact_gate::CONTACT_GATE_TOLERANCE_M,
        );
        assert!(gate.pass, "{:?}", gate.failures.first());
        assert!(gate.checked > 1000);
    }
    // A trace without contact on a map version without a ground derivative
    // is baked on the retired OpenDRIVE resolver, and says so.
    let xodr = gunzip(&read(&format!("{MAP}/map.xodr.gz")));
    let topology = read(&format!("{MAP}/topology-index.json.gz"));
    let legacy = build_render_timeline(&bare, &HeightField::from_xodr(&xodr, &topology).unwrap(), None).unwrap();
    assert_eq!(legacy.contact_origin, Some(ContactOrigin::LegacyXodrElevation));
    // Bodies drawn at the wrong height fail the gate by name (a flat ground
    // at 0 m under a map whose road is at ~7 m).
    let flat = build_render_timeline(&bare, &HeightField::flat(0.0), None).unwrap();
    let gate = simforge_core::trace::timeline::contact_gate::check_contact(&flat, ground.surface(), 0.03);
    assert!(!gate.pass && gate.failure_count > 100 && gate.failures[0].gap_m < -1.0, "{gate:?}");
    // A grounded trace cannot be baked against a synthetic surface.
    assert!(matches!(
        build_render_timeline(&grounded, &HeightField::flat(0.0), None),
        Err(TimelineError::GroundedTraceNeedsGround(_))
    ));
}

#[test]
fn checkpoints_carry_contact_and_refuse_another_ground() {
    let (graph, ground, _) = richmond();
    let input = simforge_core::parse_scenario_input_bytes(&read(
        "fixtures/golden-traces/inputs/rfs-stop-and-go.input.json",
    ))
    .unwrap()
    .normalized();
    let mut options = RunOptions::new(Arc::clone(&graph));
    options.ground = Some(Arc::clone(&ground));
    let mut sim = Simulation::new(input.clone(), options.clone()).unwrap();
    sim.advance(200, &[]).unwrap();
    let checkpoint = sim.checkpoint().unwrap();
    let mut resumed = Simulation::restore(&checkpoint, options.clone()).unwrap();
    sim.advance(usize::MAX, &[]).unwrap();
    resumed.advance(usize::MAX, &[]).unwrap();
    assert_eq!(
        sim.build_trace().unwrap().digest().unwrap(),
        resumed.build_trace().unwrap().digest().unwrap()
    );
    let mut no_ground = options;
    no_ground.ground = None;
    assert!(Simulation::restore(&checkpoint, no_ground).is_err());
}

/// Richmond's only U-turn connecting road (51 -> 104 -> 70) sweeps an 8.5 m
/// truck's left wheels over a hole in the rendered world at about
/// (8.2, 358.7): no mesh of any kind covers it. The engine refuses the
/// simulation by name instead of inventing ground (the ingest report flags
/// the hole as `surface-holes`).
#[test]
fn a_truck_whose_wheels_leave_the_rendered_map_fails_by_name() {
    let (graph, ground, _) = richmond();
    let mut doc: serde_json::Value = serde_json::from_slice(&read(
        "fixtures/golden-traces/inputs/rfs-uturn-van.input.json",
    ))
    .unwrap();
    doc["actors"][0]["id"] = serde_json::json!("truck");
    doc["actors"][0]["kind"] = serde_json::json!("truck");
    doc["actors"][0]["dims"] = serde_json::json!({"l": 8.5, "w": 2.5, "h": 3.3});
    let input = simforge_core::parse_scenario_input_value(&doc).unwrap();
    let mut options = RunOptions::new(Arc::clone(&graph));
    options.ground = Some(Arc::clone(&ground));
    let error = Simulation::new(input.normalized(), options)
        .and_then(|s| s.run())
        .unwrap_err();
    assert!(
        error
            .message
            .starts_with("actor truck has no ground under it at t=15.4"),
        "{}",
        error.message
    );
    assert!(
        error.message.contains("2 of 3 contacts have ground"),
        "{}",
        error.message
    );
    // Without the ground the same scenario still runs (planar only).
    let mut planar = RunOptions::new(Arc::clone(&graph));
    planar.ground = None;
    let input = simforge_core::parse_scenario_input_value(&doc).unwrap();
    assert!(Simulation::new(input.normalized(), planar)
        .unwrap()
        .run()
        .is_ok());
}
