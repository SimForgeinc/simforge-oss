//! Legacy OpenDRIVE heights (map versions without a ground derivative) where
//! two lanes tie: the crossing of Richmond Field Station roads 112 and 113,
//! where a SUMO vehicle on dev failed its render timeline with
//! `xodr_elevation_ambiguous:…:112:0:1:113:0:-1`. A tie takes the surface
//! nearest the same probe's elevation on the neighbouring tick; a body with
//! no neighbouring resolved tick still fails by name.

use std::io::Read;
use std::path::PathBuf;
use std::sync::Arc;

use simforge_core::engine::{ContactGeometry, RunOptions, Simulation};
use simforge_core::map::{LaneGraph, TopologyIndex};
use simforge_core::math::Vec2;
use simforge_core::trace::timeline::{
    build_render_timeline, ContactOrigin, HeightError, HeightField, HeightQuery, TimelineError,
};

const MAP: &str = "fixtures/golden-traces/maps/richmond-field-station";

fn read(path: &str) -> Vec<u8> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..").join(path);
    let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    if bytes.starts_with(&[0x1f, 0x8b]) {
        let mut out = Vec::new();
        flate2::read::GzDecoder::new(&bytes[..]).read_to_end(&mut out).unwrap();
        out
    } else {
        bytes
    }
}

fn sub(a: Vec2, b: Vec2) -> Vec2 {
    Vec2 { x: a.x - b.x, y: a.y - b.y }
}

fn unit(v: Vec2) -> Vec2 {
    let n = v.x.hypot(v.y);
    Vec2 { x: v.x / n, y: v.y / n }
}

/// Where the centrelines of lanes `a` and `b` cross, with their directions.
fn crossing(topology: &TopologyIndex, a: &str, b: &str) -> (Vec2, Vec2, Vec2) {
    let (pa, pb) = (&topology.lanes[a].polyline, &topology.lanes[b].polyline);
    for sa in pa.windows(2) {
        for sb in pb.windows(2) {
            let (r, s) = (sub(sa[1], sa[0]), sub(sb[1], sb[0]));
            let den = r.x * s.y - r.y * s.x;
            if den.abs() < 1e-12 {
                continue;
            }
            let q = sub(sb[0], sa[0]);
            let (t, u) = ((q.x * s.y - q.y * s.x) / den, (q.x * r.y - q.y * r.x) / den);
            if (0.0..=1.0).contains(&t) && (0.0..=1.0).contains(&u) {
                let p = Vec2 { x: sa[0].x + t * r.x, y: sa[0].y + t * r.y };
                return (p, unit(r), unit(s));
            }
        }
    }
    panic!("{a} and {b} do not cross");
}

fn query(label: &str, continuity_z: Option<f64>) -> HeightQuery<'_> {
    HeightQuery { preferred_road: None, label: Some(label), continuity_z }
}

struct Fixture {
    height: HeightField,
    /// A point where 112:0:1 and 113:0:-1 tie.
    tie: Vec2,
    /// Direction of lane 112:0:1 there.
    along: Vec2,
}

fn fixture() -> Fixture {
    let topology = TopologyIndex::decode(&read(&format!("{MAP}/topology-index.json.gz"))).unwrap();
    let height = HeightField::from_xodr_topology(&read(&format!("{MAP}/map.xodr.gz")), &topology).unwrap();
    let (p, a, b) = crossing(&topology, "112:0:1", "113:0:-1");
    // Points on either bisector of the two centrelines are equidistant from
    // both: the resolver's tie.
    let bisectors = [unit(Vec2 { x: a.x + b.x, y: a.y + b.y }), unit(Vec2 { x: a.x - b.x, y: a.y - b.y })];
    for bisector in bisectors {
        for step in 1..=12 {
            for sign in [1.0, -1.0] {
                let t = sign * 0.125 * f64::from(step);
                let q = Vec2 { x: p.x + t * bisector.x, y: p.y + t * bisector.y };
                if let Err(HeightError::Ambiguous { best, other, .. }) = height.elevation(q.x, q.y, query("probe", None)) {
                    let mut pair = [best, other];
                    pair.sort();
                    assert_eq!(pair, ["112:0:1".to_owned(), "113:0:-1".to_owned()]);
                    return Fixture { height, tie: q, along: a };
                }
            }
        }
    }
    panic!("no tie between 112:0:1 and 113:0:-1 near their crossing at {p:?}");
}

#[test]
fn a_tie_takes_the_surface_nearest_the_neighbouring_tick() {
    let Fixture { height, tie, .. } = fixture();
    let high = height.elevation(tie.x, tie.y, query("probe", Some(1.0e3))).unwrap();
    let low = height.elevation(tie.x, tie.y, query("probe", Some(-1.0e3))).unwrap();
    assert!(high - low > 0.05, "the two lanes are distinct surfaces: {high} vs {low}");
    assert_eq!(height.elevation(tie.x, tie.y, query("probe", Some(high + 0.2))).unwrap(), high);
    assert_eq!(height.elevation(tie.x, tie.y, query("probe", Some(low - 0.2))).unwrap(), low);
    // Equally near both: still ambiguous, never a guess.
    assert!(matches!(
        height.elevation(tie.x, tie.y, query("probe", Some((high + low) / 2.0))),
        Err(HeightError::Ambiguous { .. })
    ));
    // A point that resolves on its own ignores the continuity hint.
    let (x, y) = (tie.x + 40.0, tie.y);
    if let Ok(alone) = height.elevation(x, y, query("probe", None)) {
        assert_eq!(height.elevation(x, y, query("probe", Some(alone + 50.0))).unwrap(), alone);
    }
}

#[test]
fn a_traffic_body_crossing_the_tie_keeps_its_surface_and_an_isolated_tie_fails() {
    let Fixture { height, tie, along } = fixture();
    // A walker from the Richmond corpus, re-routed (SUMO-style: no lane)
    // along lane 112:0:1 through the tie. Walkers stand on one probe, so the
    // tie is hit exactly.
    let topology = TopologyIndex::decode(&read(&format!("{MAP}/topology-index.json.gz"))).unwrap();
    let graph = Arc::new(LaneGraph::new(topology));
    let input = simforge_core::parse_scenario_input_bytes(&read(
        "fixtures/golden-traces/inputs/rfs-walkers-crossing.input.json",
    ))
    .unwrap();
    let mut trace = Simulation::new(input.normalized(), RunOptions::new(graph)).unwrap().run().unwrap().trace;
    let id = trace
        .header
        .actor_metadata
        .iter()
        .find(|(_, meta)| {
            let wheelbase = simforge_core::physics::actor_physics_profile(meta.kind).map(|p| p.wheelbase_m);
            ContactGeometry::for_actor(meta.kind, &meta.dims, wheelbase) == ContactGeometry::Point
        })
        .map(|(id, _)| id.clone())
        .expect("a walker");
    let ticks = trace.ticks.t.len();
    let (start, len) = (10usize, 21usize);
    assert!(ticks > start + len);
    let centre = start + len / 2;
    let heading = along.y.atan2(along.x);
    {
        let track = trace.ticks.actors.get_mut(&id).unwrap();
        for i in 0..ticks {
            track.present[i] = u8::from((start..start + len).contains(&i));
            let k = i as f64 - centre as f64;
            track.x[i] = tie.x + 0.25 * k * along.x;
            track.y[i] = tie.y + 0.25 * k * along.y;
            track.heading_rad[i] = heading;
            track.lane_rsl[i] = None;
        }
    }
    let timeline = build_render_timeline(&trace, &height, None).expect("the tie resolves by continuity");
    assert_eq!(timeline.contact_origin, Some(ContactOrigin::LegacyXodrElevation));
    let actor = timeline.actors.iter().find(|a| a.id == id).unwrap();
    let at = |i: usize| (trace.ticks.actors[&id].x[i], trace.ticks.actors[&id].y[i]);
    let (x, y) = at(centre);
    let high = height.elevation(x, y, query(&id, Some(1.0e3))).unwrap();
    let low = height.elevation(x, y, query(&id, Some(-1.0e3))).unwrap();
    // A walker's timeline z is its single probe's surface.
    let previous = actor.track.z[centre - 1];
    let (kept, other) = if (high - previous).abs() < (low - previous).abs() { (high, low) } else { (low, high) };
    let drawn = actor.track.z[centre];
    assert!((drawn - kept).abs() < 0.01, "the tie keeps the surface it came from: {drawn} vs {kept}");
    assert!((drawn - other).abs() > 0.1, "and never jumps to the other deck ({other})");

    // A presence run that is nothing but the tie has no neighbour to follow.
    {
        let track = trace.ticks.actors.get_mut(&id).unwrap();
        for i in 0..ticks {
            track.present[i] = u8::from(i == centre);
        }
    }
    match build_render_timeline(&trace, &height, None) {
        Err(TimelineError::Height { actor_id, tick, error: HeightError::Ambiguous { .. } }) => {
            assert_eq!((actor_id.as_str(), tick), (id.as_str(), centre));
        }
        other => panic!("expected the isolated tie to fail by name, got {other:?}"),
    }
}
