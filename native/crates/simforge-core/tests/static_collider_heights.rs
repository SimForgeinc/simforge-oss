//! Map colliders with a vertical extent (`simforge.static-map-colliders/v2`)
//! against grounded bodies, on the committed Richmond Field Station closure.
//!
//! A body meets a map collider only where their vertical spans overlap: its
//! span runs from its ground contact to its roof. So a car passes under a
//! signal mast arm and under a bridge, still strikes the pole at road level,
//! and a tall body strikes a low overhang a car clears. A v1 collider (no
//! extent) stays a full-height prism, and without a ground surface the
//! extents cannot be used and the run says so.

use std::io::Read;
use std::path::PathBuf;
use std::sync::Arc;

use simforge_core::engine::{
    ColliderVertical, GroundContext, RunOptions, SceneObb, Simulation, StaticColliderClass,
    StaticMapCollider,
};
use simforge_core::map::{LaneGraph, TopologyIndex};
use simforge_core::math::SceneXZ;
use simforge_core::trace::SimTrace;
use simforge_core::SimIssue;

const MAP: &str = "fixtures/golden-traces/maps/richmond-field-station";
const INPUT: &str = "fixtures/golden-traces/inputs/rfs-stop-and-go.input.json";

fn read(path: &str) -> Vec<u8> {
    let full = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .join(path);
    std::fs::read(&full).unwrap_or_else(|e| panic!("{path}: {e}"))
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

struct Richmond {
    graph: Arc<LaneGraph>,
    ground: Arc<GroundContext>,
}

fn richmond() -> Richmond {
    let topology = TopologyIndex::decode(&read(&format!("{MAP}/topology-index.json.gz"))).unwrap();
    let graph = Arc::new(LaneGraph::new(topology.clone()));
    let xodr = gunzip(&read(&format!("{MAP}/map.xodr.gz")));
    let ground = GroundContext::from_bytes(
        &read(&format!("{MAP}/derived/ground/ground-mesh.bin")),
        Some((&xodr, &topology)),
    )
    .unwrap();
    Richmond {
        graph,
        ground: Arc::new(ground),
    }
}

fn run(
    map: &Richmond,
    ground: bool,
    colliders: Vec<StaticMapCollider>,
    ego_height_m: Option<f64>,
) -> (SimTrace, Vec<SimIssue>) {
    let mut doc: serde_json::Value = serde_json::from_slice(&read(INPUT)).unwrap();
    if let Some(h) = ego_height_m {
        doc["actors"][0]["dims"]["h"] = serde_json::json!(h);
    }
    let input = simforge_core::parse_scenario_input_value(&doc).unwrap();
    let mut options = RunOptions::new(Arc::clone(&map.graph));
    options.ground = ground.then(|| Arc::clone(&map.ground));
    options.static_colliders = colliders;
    let result = Simulation::new(input.normalized(), options)
        .unwrap()
        .run()
        .unwrap();
    (result.trace, result.issues)
}

/// Where the ego is, mid-route, while moving: a collider centred there lies
/// on its path. Returns the local `(x, y)` and the road surface height.
fn on_the_path(map: &Richmond, baseline: &SimTrace) -> (f64, f64, f64) {
    let track = &baseline.ticks.actors["ego"];
    let n = baseline.ticks.t.len();
    let (mut best, mut best_speed) = (n / 2, 0.0);
    for i in n / 3..(2 * n / 3) {
        if track.present[i] == 1 && track.speed_mps[i] > best_speed {
            best = i;
            best_speed = track.speed_mps[i];
        }
    }
    assert!(
        best_speed > 3.0,
        "the ego must be moving where the collider stands"
    );
    let (x, y) = (track.x[best], track.y[best]);
    let road = map.ground.surface().top(x, y, None).unwrap().z;
    (x, y, road)
}

/// A square collider centred at local `(x, y)`; `vertical` is metres above
/// the road there (`None`: a v1 collider).
fn collider(
    id: &str,
    at: (f64, f64, f64),
    side_m: f64,
    vertical: Option<(f64, f64)>,
) -> StaticMapCollider {
    let (x, y, road) = at;
    StaticMapCollider {
        id: id.to_owned(),
        class: StaticColliderClass::Prop,
        obb: SceneObb {
            center: SceneXZ { x, z: -y },
            length_m: side_m,
            width_m: side_m,
            heading_rad: 0.0,
        },
        vertical: vertical.map(|(bottom, top)| ColliderVertical {
            min_y: road + bottom,
            max_y: road + top,
        }),
    }
}

fn map_collisions(trace: &SimTrace) -> Vec<String> {
    trace
        .metrics
        .collisions
        .iter()
        .flat_map(|c| [c.a.clone(), c.b.clone()])
        .filter(|id| id.starts_with("map:"))
        .collect()
}

#[test]
fn a_car_passes_under_a_mast_arm_and_a_bridge_and_strikes_the_pole() {
    let map = richmond();
    let (baseline, _) = run(&map, true, Vec::new(), None);
    let at = on_the_path(&map, &baseline);

    // A signal mast arm with its head (6.0-6.4 m up) and a bridge deck's
    // girders (5.1-6.3 m up, 14 m wide) straight over the ego's lane.
    let overhead = vec![
        collider("mast-arm", at, 2.5, Some((6.0, 6.4))),
        collider("bridge-girders", at, 14.0, Some((5.1, 6.3))),
    ];
    let (under, issues) = run(&map, true, overhead, None);
    assert!(
        map_collisions(&under).is_empty(),
        "{:?}",
        under.metrics.collisions
    );
    assert!(issues
        .iter()
        .all(|i| i.code.as_str() != "static_collider_heights_unused"));
    // Passing under changes nothing at all: same motion as the empty map.
    assert_eq!(under.ticks.actors["ego"].x, baseline.ticks.actors["ego"].x);
    assert_eq!(under.ticks.actors["ego"].y, baseline.ticks.actors["ego"].y);

    // The pole the arm hangs from, standing on the road: struck.
    let (hit, _) = run(
        &map,
        true,
        vec![collider("pole", at, 0.4, Some((-0.1, 7.0)))],
        None,
    );
    assert_eq!(map_collisions(&hit), vec!["map:pole".to_owned()]);
}

#[test]
fn a_tall_body_strikes_an_overhang_a_car_clears() {
    let map = richmond();
    let (baseline, _) = run(&map, true, Vec::new(), None);
    let at = on_the_path(&map, &baseline);
    // A canopy 2.4-2.8 m over the road: the 1.5 m car passes, a 3.2 m box does not.
    let canopy = || vec![collider("canopy", at, 3.0, Some((2.4, 2.8)))];
    let (car, _) = run(&map, true, canopy(), None);
    assert!(
        map_collisions(&car).is_empty(),
        "{:?}",
        car.metrics.collisions
    );
    let (tall, _) = run(&map, true, canopy(), Some(3.2));
    assert_eq!(map_collisions(&tall), vec!["map:canopy".to_owned()]);
}

#[test]
fn a_collider_without_extent_and_a_run_without_ground_keep_full_height() {
    let map = richmond();
    let (baseline, _) = run(&map, true, Vec::new(), None);
    let at = on_the_path(&map, &baseline);
    // v1: no vertical extent, a full-height prism, exactly as before.
    let (v1, _) = run(&map, true, vec![collider("v1-arm", at, 2.5, None)], None);
    assert_eq!(map_collisions(&v1), vec!["map:v1-arm".to_owned()]);
    // v2 extents with no ground surface: no body has a height, so the arm
    // stands at full height, and the run reports it.
    let (planar, issues) = run(
        &map,
        false,
        vec![collider("arm", at, 2.5, Some((6.0, 6.4)))],
        None,
    );
    assert_eq!(map_collisions(&planar), vec!["map:arm".to_owned()]);
    assert!(
        issues
            .iter()
            .any(|i| i.code.as_str() == "static_collider_heights_unused"),
        "{issues:?}"
    );
}
