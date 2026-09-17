use std::collections::BTreeMap;

use serde_json::json;
use simforge_core::map::TopologyIndex;

use crate::anchor::frame::{build_corridor_frame, CorridorFrameOptions};
use crate::anchor::{
    AnchorFrame, DegradationReport, MatchedSite, Verdict, MATCH_SEMANTICS_VERSION,
};
use crate::map_index::{
    derive_map_index, DeriveOptions, DerivedMapIndex, Handedness, RawTopology,
};

pub fn topology() -> TopologyIndex {
    serde_json::from_value(json!({
        "schemaVersion": 1,
        "mapName": "anchor-characterization",
        "source": { "xodrSha256": "fixture-digest" },
        "lanes": {
            "main": lane("main", 1, -1, 0.0, vec![], vec!["next"]),
            "left": lane("left", 1, -2, 4.0, vec![], vec!["next-left"]),
            "opposing": lane("opposing", 1, 1, -4.0, vec![], vec![]),
            "next": lane("next", 2, -1, 0.0, vec!["main"], vec![]),
            "next-left": lane("next-left", 2, -2, 4.0, vec!["left"], vec![])
        },
        "gates": [],
        "junctions": {}
    })).expect("synthetic topology")
}

fn lane(
    rsl: &str,
    road_id: i64,
    lane_id: i64,
    y: f64,
    predecessors: Vec<&str>,
    successors: Vec<&str>,
) -> serde_json::Value {
    let x0 = if road_id == 1 { 0.0 } else { 100.0 };
    let x1 = if road_id == 1 { 100.0 } else { 180.0 };
    json!({
        "rsl": rsl,
        "roadId": road_id,
        "section": 0,
        "laneId": lane_id,
        "laneType": "driving",
        "predecessors": predecessors,
        "successors": successors,
        "speedLimitKph": 50.0,
        "representativeWidthM": 3.5,
        "polyline": [[x0, y], [x1, y]]
    })
}

pub fn index(handedness: Handedness) -> DerivedMapIndex {
    let topology = topology();
    derive_map_index(
        &RawTopology::from_topology(&topology),
        &DeriveOptions {
            map_id: "anchor-characterization".into(),
            handedness: Some(handedness),
            topology_digest: Some("fixture-digest".into()),
            ..Default::default()
        },
    )
}

pub fn frame(index: &DerivedMapIndex) -> AnchorFrame {
    let segment_id = index
        .segments
        .iter()
        .find(|segment| segment.lane_rsls.first().is_some_and(|lane| lane == "main"))
        .expect("main segment")
        .id
        .clone();
    build_corridor_frame(
        index,
        &segment_id,
        &CorridorFrameOptions {
            anchor_feature_id: "origin".into(),
            runway_downstream_m: Some(150.0),
            mirrored: false,
        },
    )
    .expect("corridor frame")
}

pub fn site(index: &DerivedMapIndex) -> MatchedSite {
    MatchedSite {
        site_id: "fixture-site".into(),
        map_id: index.map_id.clone(),
        topology_digest: index.topology_digest.clone(),
        match_semantics_version: MATCH_SEMANTICS_VERSION.into(),
        anchor_id: "fixture-anchor".into(),
        score: 1.0,
        frame: frame(index),
        clauses: vec![],
        bindings: vec![],
        feature_matches: BTreeMap::new(),
        degradation: DegradationReport {
            verdict: Verdict::Exact,
            score: 1.0,
            repairs: vec![],
            failed_required_clauses: vec![],
            summary: "fixture".into(),
            intent_preserved: true,
        },
        matched_reasons: vec![],
        alternate_frames: 0,
    }
}
