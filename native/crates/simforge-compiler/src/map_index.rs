//! `DerivedMapIndex` — the matcher's view of a map.
//!
//! Derived straight from the decoded topology index (lanes flipped into travel
//! order, links re-verified geometrically, junction descriptors with conflict
//! pairs, corridor segments with sampled profiles, an inverted fact index),
//! then enriched with the layers map-intel publishes in
//! `derived/topology-derived.json` (junction control, arm counts, conflict
//! pairs, segments) and `derived/locations.json` (crossings, parking zones,
//! bus stops, occlusion zones, crests). The matcher runs identically on both;
//! only `provenance.source` differs.

use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;
use serde_json::Value;
use simforge_core::hash::sha256;
use simforge_core::map::TopologyIndex;
use simforge_core::math::{dist, hypot, Vec2};
use simforge_core::types::TurnRelation;

use crate::geometry::{
    adjacent_kinds, angle_diff, bbox, bbox_overlaps, cross_section_at, curvature_deg_per_10m_at,
    heading_at_s, point_at_s, polyline_intersection, polyline_length, project_point, to_deg,
    LaneGrid, Point2,
};
use crate::template::{ApproachRelation, JunctionControl, TurnDirection};

/// Version of the derived-index contract this crate normalizes onto.
pub const DERIVED_INDEX_CONTRACT_VERSION: &str = "1.0.0";
/// Metres within which two lane ends count as physically contiguous.
pub const LINK_TOLERANCE_M: f64 = 2.0;
/// Profile sampling stride along a segment.
pub const PROFILE_STRIDE_M: f64 = 10.0;

pub type LaneTable = BTreeMap<String, DerivedLane>;

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WidthSample {
    pub s: f64,
    pub width_m: f64,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdjacentLaneRef {
    pub lane_rsl: Option<String>,
    pub same_direction: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LaneSideName {
    Left,
    Right,
}

impl LaneSideName {
    pub fn flipped(self) -> Self {
        match self {
            Self::Left => Self::Right,
            Self::Right => Self::Left,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaneChangePermission {
    pub side: LaneSideName,
    pub start_s: f64,
    pub end_s: f64,
    pub allowed: bool,
}

/// A lane in **travel-direction order**: index 0 is where a vehicle enters.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DerivedLane {
    pub rsl: String,
    pub road_id: i64,
    pub section: i64,
    pub lane_id: i64,
    pub lane_type: String,
    pub is_junction: bool,
    pub junction_id: Option<String>,
    pub polyline: Vec<Point2>,
    pub length_m: f64,
    pub speed_limit_kph: f64,
    pub representative_width_m: f64,
    pub width_samples: Vec<WidthSample>,
    pub adjacent_left: AdjacentLaneRef,
    pub adjacent_right: AdjacentLaneRef,
    pub lane_change_permissions: Vec<LaneChangePermission>,
    /// Travel-direction predecessors/successors, geometry-verified.
    pub predecessors: Vec<String>,
    pub successors: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DerivedGate {
    pub id: String,
    pub junction_id: String,
    pub turn_relation: TurnDirection,
    pub heading_change_rad: f64,
    pub approach_lane_rsl: String,
    pub connecting_lane_rsl: String,
    pub exit_lane_rsls: Vec<String>,
}

/// A precomputed crossing between two junction gates.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictPair {
    pub gate_a: String,
    pub gate_b: String,
    pub point: Point2,
    pub s_on_a: f64,
    pub s_on_b: f64,
    pub crossing_angle_deg: f64,
    /// Where B comes from, seen from A's approach.
    pub relation: ApproachRelation,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JunctionApproach {
    /// `<junctionId>#<roadId>:<section>`.
    pub id: String,
    pub lane_rsls: Vec<String>,
    pub bearing_deg: f64,
    pub turn_options: Vec<TurnDirection>,
    pub gate_ids: Vec<String>,
    pub through_lanes: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JunctionDescriptor {
    pub junction_id: String,
    pub arms: usize,
    pub approaches: Vec<JunctionApproach>,
    /// `None` = unknown.
    pub control: Option<JunctionControl>,
    pub size_m: f64,
    pub conflict_pairs: Vec<ConflictPair>,
    /// Crossing ids per approach id; `*` = whole junction.
    pub crossings_by_approach: BTreeMap<String, Vec<String>>,
    pub gate_ids: Vec<String>,
    pub internal_lane_rsls: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentProfileSample {
    pub s: f64,
    pub lane_rsl: String,
    pub through_lanes_same_dir: usize,
    pub through_lanes_opposing: usize,
    pub lane_width_m: f64,
    pub speed_limit_kph: f64,
    pub curvature_deg_per10m: f64,
    pub adjacent_kinds: Vec<String>,
}

/// A maximal lane chain between junctions.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    pub id: String,
    pub lane_rsls: Vec<String>,
    pub length_m: f64,
    pub profile: Vec<SegmentProfileSample>,
    pub entry_junction_id: Option<String>,
    pub exit_junction_id: Option<String>,
    pub min_through_lanes_same_dir: usize,
    pub max_through_lanes_same_dir: usize,
    pub min_speed_limit_kph: f64,
    pub max_speed_limit_kph: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PointFeatureKind {
    Crossing,
    ParkingZone,
    BusStop,
    Driveway,
    SchoolZone,
    WorkZoneSuitable,
    OcclusionZone,
    Crest,
}

impl PointFeatureKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Crossing => "crossing",
            Self::ParkingZone => "parking_zone",
            Self::BusStop => "bus_stop",
            Self::Driveway => "driveway",
            Self::SchoolZone => "school_zone",
            Self::WorkZoneSuitable => "work_zone_suitable",
            Self::OcclusionZone => "occlusion_zone",
            Self::Crest => "crest",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        Some(match s {
            "crossing" => Self::Crossing,
            "parking_zone" => Self::ParkingZone,
            "bus_stop" => Self::BusStop,
            "driveway" => Self::Driveway,
            "school_zone" => Self::SchoolZone,
            "work_zone_suitable" => Self::WorkZoneSuitable,
            "occlusion_zone" => Self::OcclusionZone,
            "crest" => Self::Crest,
            _ => return None,
        })
    }
}

/// A fact a clause can evaluate: scalars and string arrays.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum Fact {
    Text(String),
    Number(f64),
    Bool(bool),
    Texts(Vec<String>),
}

impl Fact {
    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Self::Number(n) => Some(*n),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Self::Bool(b) => Some(*b),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Self::Text(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_texts(&self) -> Option<&[String]> {
        match self {
            Self::Texts(v) => Some(v),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PointFeature {
    pub id: String,
    pub kind: PointFeatureKind,
    pub lane_rsl: String,
    pub s: f64,
    pub point: Option<Point2>,
    /// `left` / `right` / `both`.
    pub side: Option<String>,
    pub junction_id: Option<String>,
    pub facts: BTreeMap<String, Fact>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FactIndex {
    pub junctions_by_control: BTreeMap<String, Vec<String>>,
    pub junctions_by_arms: BTreeMap<String, Vec<String>>,
    pub junctions_by_turn_option: BTreeMap<String, Vec<String>>,
    pub segments_by_lane_count: BTreeMap<String, Vec<String>>,
    pub segment_ids_by_lane: BTreeMap<String, String>,
    pub point_features_by_kind: BTreeMap<String, Vec<String>>,
    pub total_junctions: usize,
    pub total_segments: usize,
    pub total_lanes: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexCapabilities {
    pub grade: bool,
    pub crossings: bool,
    pub parking_zones: bool,
    pub work_zones: bool,
    pub occlusion_zones: bool,
    pub junction_control: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum IndexSource {
    MapIntel,
    SelfDerived,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexProvenance {
    pub source: IndexSource,
    pub contract_version: String,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Handedness {
    Right,
    Left,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JunctionSpine {
    pub junction_id: String,
    pub gate_ids: Vec<String>,
    pub internal_lane_rsls: Vec<String>,
    pub approach_lane_rsls: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DerivedMapIndex {
    pub map_id: String,
    pub topology_digest: String,
    pub handedness: Handedness,
    pub lanes: LaneTable,
    pub gates: Vec<DerivedGate>,
    pub junctions: BTreeMap<String, JunctionSpine>,
    pub segments: Vec<Segment>,
    pub junction_descriptors: BTreeMap<String, JunctionDescriptor>,
    pub point_features: Vec<PointFeature>,
    pub fact_index: FactIndex,
    pub capabilities: IndexCapabilities,
    pub provenance: IndexProvenance,
    /// Spatial grid over lane vertices for cross-section queries.
    #[serde(skip)]
    pub grid: LaneGrid,
}

impl DerivedMapIndex {
    pub fn lane(&self, rsl: &str) -> Option<&DerivedLane> {
        self.lanes.get(rsl)
    }

    pub fn gate(&self, id: &str) -> Option<&DerivedGate> {
        self.gates.iter().find(|g| g.id == id)
    }

    pub fn cross_section(&self, rsl: &str, s: f64) -> Option<crate::geometry::CrossSection> {
        cross_section_at(&self.lanes, &self.grid, rsl, s)
    }

    pub fn point_feature(&self, id: &str) -> Option<&PointFeature> {
        self.point_features.iter().find(|p| p.id == id)
    }
}

/* ---------------------------------------------------------------- derive */

pub fn normalize_turn(raw: &str) -> TurnDirection {
    TurnDirection::from_str(raw).unwrap_or(TurnDirection::Straight)
}

pub fn turn_relation_to_direction(t: TurnRelation) -> TurnDirection {
    match t {
        TurnRelation::Straight => TurnDirection::Straight,
        TurnRelation::Left => TurnDirection::Left,
        TurnRelation::Right => TurnDirection::Right,
        TurnRelation::UTurnLeft | TurnRelation::UTurnRight => TurnDirection::Uturn,
    }
}

/// Raw topology facts in the shape the derivation consumes; built from the
/// decoded core topology index or from an external derived file.
#[derive(Debug, Clone)]
pub struct RawLane {
    pub rsl: String,
    pub road_id: i64,
    pub section: i64,
    pub lane_id: i64,
    pub lane_type: String,
    pub is_junction: bool,
    pub junction_id: Option<String>,
    pub predecessors: Vec<String>,
    pub successors: Vec<String>,
    pub speed_limit_kph: f64,
    pub representative_width_m: f64,
    pub width_samples: Vec<WidthSample>,
    pub adjacent_left: AdjacentLaneRef,
    pub adjacent_right: AdjacentLaneRef,
    pub lane_change_permissions: Vec<LaneChangePermission>,
    /// Storage (OpenDRIVE `s`) order.
    pub polyline: Vec<Point2>,
}

#[derive(Debug, Clone)]
pub struct RawGate {
    pub id: String,
    pub junction_id: String,
    pub turn_relation: TurnDirection,
    pub heading_change_rad: f64,
    pub connecting_lane_rsl: String,
    pub approach_lane_rsl: String,
    pub exit_lane_rsls: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct RawTopology {
    pub schema_version: u32,
    pub xodr_sha256: Option<String>,
    pub lanes: BTreeMap<String, RawLane>,
    pub gates: Vec<RawGate>,
    pub junctions: BTreeMap<String, JunctionSpine>,
}

impl RawTopology {
    pub fn from_topology(index: &TopologyIndex) -> Self {
        let lanes = index
            .lanes
            .iter()
            .map(|(rsl, lane)| {
                let adj = |side: simforge_core::map::LaneSide| -> AdjacentLaneRef {
                    lane.adjacent(side)
                        .map(|a| AdjacentLaneRef {
                            lane_rsl: a.lane_rsl.clone(),
                            same_direction: a.same_direction,
                        })
                        .unwrap_or_default()
                };
                (
                    rsl.clone(),
                    RawLane {
                        rsl: rsl.clone(),
                        road_id: lane.road_id,
                        section: lane.section,
                        lane_id: lane.lane_id,
                        lane_type: lane.lane_type.clone(),
                        is_junction: lane.is_junction || lane.junction_id.is_some(),
                        junction_id: lane.junction_id.clone(),
                        predecessors: lane.predecessors.clone(),
                        successors: lane.successors.clone(),
                        speed_limit_kph: lane
                            .speed_limit_kph
                            .filter(|v| v.is_finite())
                            .unwrap_or(50.0),
                        representative_width_m: lane
                            .representative_width_m
                            .filter(|v| v.is_finite())
                            .unwrap_or(3.5),
                        width_samples: lane
                            .width_samples
                            .iter()
                            .map(|w| WidthSample {
                                s: w.s,
                                width_m: w.width_m,
                            })
                            .collect(),
                        adjacent_left: adj(simforge_core::map::LaneSide::Left),
                        adjacent_right: adj(simforge_core::map::LaneSide::Right),
                        lane_change_permissions: lane
                            .lane_change_permissions
                            .iter()
                            .map(|p| LaneChangePermission {
                                side: match p.side {
                                    simforge_core::map::LaneSide::Left => LaneSideName::Left,
                                    simforge_core::map::LaneSide::Right => LaneSideName::Right,
                                },
                                start_s: p.start_s,
                                end_s: p.end_s,
                                allowed: p.allowed,
                            })
                            .collect(),
                        polyline: lane.polyline.clone(),
                    },
                )
            })
            .collect();
        let gates = index
            .gates
            .iter()
            .map(|g| RawGate {
                id: g.id.clone(),
                junction_id: g.junction_id.clone(),
                turn_relation: turn_relation_to_direction(g.turn_relation),
                heading_change_rad: g.heading_change_rad,
                connecting_lane_rsl: g.connecting_lane_rsl.clone(),
                approach_lane_rsl: g.approach_lane_rsl.clone(),
                exit_lane_rsls: g.exit_lane_rsls.clone(),
            })
            .collect();
        let junctions = index
            .junctions
            .iter()
            .map(|(id, j)| {
                (
                    id.clone(),
                    JunctionSpine {
                        junction_id: j.junction_id.clone(),
                        gate_ids: j.gate_ids.clone(),
                        internal_lane_rsls: j.internal_lane_rsls.clone(),
                        approach_lane_rsls: j.approach_lane_rsls.clone(),
                    },
                )
            })
            .collect();
        Self {
            schema_version: index.schema_version.unwrap_or(0),
            xodr_sha256: index.source.as_ref().and_then(|s| s.xodr_sha256.clone()),
            lanes,
            gates,
            junctions,
        }
    }
}

/// Which orientation the raw polylines are stored in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PolylineOrder {
    Odr,
    Travel,
}

/// Sniff whether lane polylines are stored in OpenDRIVE `s` order or already
/// in travel order.
pub fn detect_polyline_order(
    lanes: &BTreeMap<String, RawLane>,
    gates: &[RawGate],
) -> PolylineOrder {
    let mut odr_score = 0;
    let mut travel_score = 0;
    for gate in gates {
        let (Some(a), Some(b)) = (
            lanes.get(&gate.approach_lane_rsl),
            lanes.get(&gate.connecting_lane_rsl),
        ) else {
            continue;
        };
        if a.polyline.len() < 2 || b.polyline.len() < 2 {
            continue;
        }
        if a.lane_id <= 0 && b.lane_id <= 0 {
            continue;
        }
        let odr_a_end = if a.lane_id > 0 {
            a.polyline[0]
        } else {
            a.polyline[a.polyline.len() - 1]
        };
        let odr_b_start = if b.lane_id > 0 {
            b.polyline[b.polyline.len() - 1]
        } else {
            b.polyline[0]
        };
        let odr_gap = dist(odr_a_end, odr_b_start);
        let travel_gap = dist(a.polyline[a.polyline.len() - 1], b.polyline[0]);
        if odr_gap < travel_gap {
            odr_score += 1;
        } else if travel_gap < odr_gap {
            travel_score += 1;
        }
    }
    if travel_score > odr_score {
        PolylineOrder::Travel
    } else {
        PolylineOrder::Odr
    }
}

fn travel_polyline(lane: &RawLane) -> Vec<Point2> {
    if lane.lane_id > 0 {
        lane.polyline.iter().rev().copied().collect()
    } else {
        lane.polyline.clone()
    }
}

fn travel_end(poly: &[Point2]) -> Point2 {
    poly.last().copied().unwrap_or(Vec2::ZERO)
}

fn sort_samples(samples: &mut [WidthSample]) {
    samples.sort_by(|a, b| a.s.partial_cmp(&b.s).unwrap_or(std::cmp::Ordering::Equal));
}

fn normalize_width_samples(lane: &RawLane, length_m: f64) -> Vec<WidthSample> {
    let mut out: Vec<WidthSample> = if lane.lane_id <= 0 {
        lane.width_samples.clone()
    } else {
        lane.width_samples
            .iter()
            .map(|w| WidthSample {
                s: (length_m - w.s).max(0.0),
                width_m: w.width_m,
            })
            .collect()
    };
    sort_samples(&mut out);
    out
}

fn normalize_permissions(lane: &RawLane, length_m: f64) -> Vec<LaneChangePermission> {
    if lane.lane_id <= 0 {
        return lane.lane_change_permissions.clone();
    }
    lane.lane_change_permissions
        .iter()
        .map(|p| LaneChangePermission {
            side: p.side.flipped(),
            start_s: (length_m - p.end_s).max(0.0),
            end_s: (length_m - p.start_s).max(0.0),
            allowed: p.allowed,
        })
        .collect()
}

fn reverse_lane_in_place(lane: &mut DerivedLane) {
    lane.polyline.reverse();
    let length = lane.length_m;
    for w in &mut lane.width_samples {
        w.s = (length - w.s).max(0.0);
    }
    sort_samples(&mut lane.width_samples);
    for p in &mut lane.lane_change_permissions {
        let (start, end) = ((length - p.end_s).max(0.0), (length - p.start_s).max(0.0));
        p.side = p.side.flipped();
        p.start_s = start;
        p.end_s = end;
    }
}

/// Resolve junction-internal lane direction from the approach: a gate declares
/// which approach feeds which connecting lane, so the approach's travel end
/// decides the orientation. Returns how many connecting lanes were flipped.
fn align_junction_lanes_to_gates(lanes: &mut LaneTable, gates: &[RawGate]) -> usize {
    let mut flipped = 0;
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut sorted: Vec<&RawGate> = gates.iter().collect();
    sorted.sort_by(|a, b| a.id.cmp(&b.id));
    for gate in sorted {
        let Some(approach_end) = lanes
            .get(&gate.approach_lane_rsl)
            .map(|a| travel_end(&a.polyline))
        else {
            continue;
        };
        let Some(connecting) = lanes.get(&gate.connecting_lane_rsl) else {
            continue;
        };
        if connecting.polyline.len() < 2
            || !connecting.is_junction
            || seen.contains(&connecting.rsl)
        {
            continue;
        }
        seen.insert(connecting.rsl.clone());
        let to_start = dist(approach_end, connecting.polyline[0]);
        let to_end = dist(approach_end, travel_end(&connecting.polyline));
        if to_end < to_start && to_end <= LINK_TOLERANCE_M {
            let key = gate.connecting_lane_rsl.clone();
            if let Some(lane) = lanes.get_mut(&key) {
                reverse_lane_in_place(lane);
                flipped += 1;
            }
        }
    }
    flipped
}

/// Directed, geometry-verified lane links.
fn build_directed_links(lanes: &mut LaneTable, raw: &RawTopology) {
    let mut candidates: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut add = |a: &str, b: &str| {
        if a == b || !lanes.contains_key(a) || !lanes.contains_key(b) {
            return;
        }
        candidates
            .entry(a.to_owned())
            .or_default()
            .insert(b.to_owned());
    };
    for (rsl, lane) in &raw.lanes {
        for other in lane.predecessors.iter().chain(lane.successors.iter()) {
            add(rsl, other);
            add(other, rsl);
        }
    }
    for gate in &raw.gates {
        add(&gate.approach_lane_rsl, &gate.connecting_lane_rsl);
        add(&gate.connecting_lane_rsl, &gate.approach_lane_rsl);
        for exit in &gate.exit_lane_rsls {
            add(&gate.connecting_lane_rsl, exit);
            add(exit, &gate.connecting_lane_rsl);
        }
    }

    let mut links: Vec<(String, Vec<String>, Vec<String>)> = Vec::new();
    for (rsl, others) in &candidates {
        let Some(lane) = lanes.get(rsl) else { continue };
        if lane.polyline.len() < 2 {
            continue;
        }
        let a_end = travel_end(&lane.polyline);
        let a_start = lane.polyline[0];
        let heading_out = heading_at_s(&lane.polyline, lane.length_m);
        let mut succ: BTreeSet<String> = BTreeSet::new();
        let mut pred: BTreeSet<String> = BTreeSet::new();
        for other_rsl in others {
            let Some(other) = lanes.get(other_rsl) else {
                continue;
            };
            if other.polyline.len() < 2 {
                continue;
            }
            let b_start = other.polyline[0];
            let b_end = travel_end(&other.polyline);
            let heading_in = heading_at_s(&other.polyline, 0.0);
            let continuous =
                angle_diff(heading_in, heading_out).abs() < 2.0 * std::f64::consts::PI / 3.0;
            if dist(a_end, b_start) <= LINK_TOLERANCE_M && continuous {
                succ.insert(other_rsl.clone());
            }
            if dist(b_end, a_start) <= LINK_TOLERANCE_M {
                pred.insert(other_rsl.clone());
            }
        }
        links.push((
            rsl.clone(),
            succ.into_iter().collect(),
            pred.into_iter().collect(),
        ));
    }
    for (rsl, succ, pred) in links {
        if let Some(lane) = lanes.get_mut(&rsl) {
            lane.successors = succ;
            lane.predecessors = pred;
        }
    }
}

fn approach_id_of(junction_id: &str, lane: &DerivedLane) -> String {
    format!("{junction_id}#{}:{}", lane.road_id, lane.section)
}

/// Where B comes from, seen from A's approach heading.
pub fn relation_from_headings(ego_heading_rad: f64, other_heading_rad: f64) -> ApproachRelation {
    let d = to_deg(angle_diff(other_heading_rad, ego_heading_rad));
    let abs = d.abs();
    if abs >= 135.0 {
        ApproachRelation::Opposing
    } else if abs <= 25.0 {
        ApproachRelation::Merge
    } else if d < 0.0 {
        ApproachRelation::FromLeft
    } else {
        ApproachRelation::FromRight
    }
}

fn control_from_search_index(junction_id: &str, search: Option<&Value>) -> Option<JunctionControl> {
    let facts = search?
        .get("objects")?
        .get(format!("junction:{junction_id}"))?
        .get("facts")?;
    let control = facts
        .get("control_type")
        .and_then(Value::as_str)
        .unwrap_or("");
    if control == "traffic_light" || facts.get("has_signal").and_then(Value::as_bool) == Some(true)
    {
        return Some(JunctionControl::Signalized);
    }
    match control {
        "roundabout" => Some(JunctionControl::Roundabout),
        "stop" => Some(
            if facts.get("is_all_way_stop").and_then(Value::as_bool) == Some(true) {
                JunctionControl::AllWayStop
            } else {
                JunctionControl::MinorStop
            },
        ),
        "yield" => Some(JunctionControl::Yield),
        "uncontrolled" => Some(JunctionControl::Uncontrolled),
        _ => None,
    }
}

fn build_junction_descriptor(
    junction_id: &str,
    raw: &RawTopology,
    lanes: &LaneTable,
    grid: &LaneGrid,
    gates_by_id: &BTreeMap<String, DerivedGate>,
    search: Option<&Value>,
) -> JunctionDescriptor {
    let spine = raw.junctions.get(junction_id);
    let mut gate_ids: Vec<String> = spine.map(|j| j.gate_ids.clone()).unwrap_or_default();
    gate_ids.sort();
    let mut internal: Vec<String> = spine
        .map(|j| j.internal_lane_rsls.clone())
        .unwrap_or_default();
    internal.sort();

    struct ApproachAcc {
        lanes: BTreeSet<String>,
        gates: BTreeSet<String>,
        turns: BTreeSet<TurnDirection>,
    }
    let mut by_approach: BTreeMap<String, ApproachAcc> = BTreeMap::new();
    for gate_id in &gate_ids {
        let Some(gate) = gates_by_id.get(gate_id) else {
            continue;
        };
        let Some(lane) = lanes.get(&gate.approach_lane_rsl) else {
            continue;
        };
        let entry = by_approach
            .entry(approach_id_of(junction_id, lane))
            .or_insert_with(|| ApproachAcc {
                lanes: BTreeSet::new(),
                gates: BTreeSet::new(),
                turns: BTreeSet::new(),
            });
        entry.lanes.insert(gate.approach_lane_rsl.clone());
        entry.gates.insert(gate_id.clone());
        entry.turns.insert(gate.turn_relation);
    }
    let approaches: Vec<JunctionApproach> = by_approach
        .into_iter()
        .map(|(id, entry)| {
            let lane_rsls: Vec<String> = entry.lanes.into_iter().collect();
            let first = lanes.get(&lane_rsls[0]);
            let bearing_deg = first.map_or(0.0, |f| to_deg(heading_at_s(&f.polyline, f.length_m)));
            let cs = first
                .and_then(|f| cross_section_at(lanes, grid, &f.rsl, (f.length_m - 0.5).max(0.0)));
            JunctionApproach {
                id,
                through_lanes: cs
                    .as_ref()
                    .map_or(lane_rsls.len(), |c| c.same_dir_driving.len()),
                lane_rsls,
                bearing_deg,
                turn_options: entry.turns.into_iter().collect(),
                gate_ids: entry.gates.into_iter().collect(),
            }
        })
        .collect();

    let mut internal_points: Vec<Point2> = Vec::new();
    for rsl in &internal {
        if let Some(lane) = lanes.get(rsl) {
            internal_points.extend(lane.polyline.iter().copied());
        }
    }
    // Arms are counted from outward leg directions, clustered by bearing.
    let mut leg_directions: Vec<f64> = Vec::new();
    let mut approach_rsls: Vec<String> = spine
        .map(|j| j.approach_lane_rsls.clone())
        .unwrap_or_default();
    approach_rsls.sort();
    for rsl in &approach_rsls {
        let Some(lane) = lanes.get(rsl) else { continue };
        if lane.lane_type != "driving" {
            continue;
        }
        leg_directions.push(heading_at_s(&lane.polyline, lane.length_m) + std::f64::consts::PI);
    }
    for gate_id in &gate_ids {
        let Some(gate) = gates_by_id.get(gate_id) else {
            continue;
        };
        for exit_rsl in &gate.exit_lane_rsls {
            let Some(lane) = lanes.get(exit_rsl) else {
                continue;
            };
            if lane.lane_type != "driving" {
                continue;
            }
            leg_directions.push(heading_at_s(&lane.polyline, 0.0));
        }
    }
    leg_directions.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let mut clusters: Vec<f64> = Vec::new();
    for b in leg_directions {
        if !clusters
            .iter()
            .any(|c| to_deg(angle_diff(b, *c)).abs() < 45.0)
        {
            clusters.push(b);
        }
    }
    let arms = clusters
        .len()
        .max(if approaches.is_empty() { 0 } else { 2 });

    let size_m = if internal_points.len() > 1 {
        let b = bbox(&internal_points);
        hypot(b.max_x - b.min_x, b.max_y - b.min_y)
    } else {
        0.0
    };

    let mut conflict_pairs: Vec<ConflictPair> = Vec::new();
    for i in 0..gate_ids.len() {
        let Some(gate_a) = gates_by_id.get(&gate_ids[i]) else {
            continue;
        };
        let (Some(lane_a), Some(approach_a)) = (
            lanes.get(&gate_a.connecting_lane_rsl),
            lanes.get(&gate_a.approach_lane_rsl),
        ) else {
            continue;
        };
        if lane_a.polyline.len() < 2 {
            continue;
        }
        let box_a = bbox(&lane_a.polyline);
        for gate_id_b in gate_ids.iter().skip(i + 1) {
            let Some(gate_b) = gates_by_id.get(gate_id_b) else {
                continue;
            };
            let (Some(lane_b), Some(approach_b)) = (
                lanes.get(&gate_b.connecting_lane_rsl),
                lanes.get(&gate_b.approach_lane_rsl),
            ) else {
                continue;
            };
            if lane_b.polyline.len() < 2 || gate_a.approach_lane_rsl == gate_b.approach_lane_rsl {
                continue;
            }
            if !bbox_overlaps(&box_a, &bbox(&lane_b.polyline), 1.0) {
                continue;
            }
            let Some(crossing) = polyline_intersection(&lane_a.polyline, &lane_b.polyline) else {
                continue;
            };
            let heading_a = heading_at_s(&approach_a.polyline, approach_a.length_m);
            let heading_b = heading_at_s(&approach_b.polyline, approach_b.length_m);
            let relation = if crossing.angle_deg <= 30.0 {
                ApproachRelation::Merge
            } else {
                relation_from_headings(heading_a, heading_b)
            };
            conflict_pairs.push(ConflictPair {
                gate_a: gate_a.id.clone(),
                gate_b: gate_b.id.clone(),
                point: crossing.point,
                s_on_a: crossing.s_on_a,
                s_on_b: crossing.s_on_b,
                crossing_angle_deg: crossing.angle_deg,
                relation,
            });
        }
    }
    conflict_pairs.sort_by(|a, b| {
        a.gate_a
            .cmp(&b.gate_a)
            .then_with(|| a.gate_b.cmp(&b.gate_b))
    });

    JunctionDescriptor {
        junction_id: junction_id.to_owned(),
        arms,
        approaches,
        control: control_from_search_index(junction_id, search),
        size_m,
        conflict_pairs,
        crossings_by_approach: BTreeMap::new(),
        gate_ids,
        internal_lane_rsls: internal,
    }
}

fn is_corridor_lane(lanes: &LaneTable, rsl: &str) -> bool {
    lanes
        .get(rsl)
        .is_some_and(|l| l.lane_type == "driving" && !l.is_junction)
}

fn build_segments(lanes: &LaneTable, grid: &LaneGrid) -> Vec<Segment> {
    let mut consumed: BTreeSet<String> = BTreeSet::new();
    let mut segments: Vec<Segment> = Vec::new();

    for (rsl, lane) in lanes {
        if !is_corridor_lane(lanes, rsl) || consumed.contains(rsl) {
            continue;
        }
        let corridor_preds: Vec<&String> = lane
            .predecessors
            .iter()
            .filter(|p| is_corridor_lane(lanes, p))
            .collect();
        if corridor_preds.len() == 1 {
            if let Some(pred) = lanes.get(corridor_preds[0]) {
                if pred
                    .successors
                    .iter()
                    .filter(|s| is_corridor_lane(lanes, s))
                    .count()
                    == 1
                {
                    continue;
                }
            }
        }

        let mut chain: Vec<String> = Vec::new();
        let mut cursor: Option<&DerivedLane> = Some(lane);
        while let Some(current) = cursor {
            if !is_corridor_lane(lanes, &current.rsl) || consumed.contains(&current.rsl) {
                break;
            }
            chain.push(current.rsl.clone());
            consumed.insert(current.rsl.clone());
            let succ: Vec<&String> = current
                .successors
                .iter()
                .filter(|s| is_corridor_lane(lanes, s))
                .collect();
            if succ.len() != 1 {
                break;
            }
            let Some(next) = lanes.get(succ[0]) else {
                break;
            };
            if next
                .predecessors
                .iter()
                .filter(|p| is_corridor_lane(lanes, p))
                .count()
                != 1
            {
                break;
            }
            cursor = Some(next);
        }

        let mut profile: Vec<SegmentProfileSample> = Vec::new();
        let mut acc = 0.0;
        let mut min_same = usize::MAX;
        let mut max_same = 0usize;
        let mut min_speed = f64::INFINITY;
        let mut max_speed = 0.0f64;
        for chain_rsl in &chain {
            let Some(chain_lane) = lanes.get(chain_rsl) else {
                continue;
            };
            let mut s = 0.0;
            while s <= chain_lane.length_m {
                if let Some(cs) = cross_section_at(lanes, grid, chain_rsl, s) {
                    let sample = SegmentProfileSample {
                        s: acc + s,
                        lane_rsl: chain_rsl.clone(),
                        through_lanes_same_dir: cs.same_dir_driving.len(),
                        through_lanes_opposing: cs.opposing_driving.len(),
                        lane_width_m: cs.lane_width_m,
                        speed_limit_kph: cs.speed_limit_kph,
                        curvature_deg_per10m: curvature_deg_per_10m_at(
                            &chain_lane.polyline,
                            s,
                            10.0,
                        ),
                        adjacent_kinds: adjacent_kinds(&cs),
                    };
                    min_same = min_same.min(sample.through_lanes_same_dir);
                    max_same = max_same.max(sample.through_lanes_same_dir);
                    min_speed = min_speed.min(sample.speed_limit_kph);
                    max_speed = max_speed.max(sample.speed_limit_kph);
                    profile.push(sample);
                }
                s += PROFILE_STRIDE_M;
            }
            acc += chain_lane.length_m;
        }

        let head = lanes.get(&chain[0]);
        let tail = lanes.get(&chain[chain.len() - 1]);
        let entry_junction_id = head.and_then(|h| {
            h.predecessors
                .iter()
                .find_map(|p| lanes.get(p).and_then(|l| l.junction_id.clone()))
        });
        let exit_junction_id = tail.and_then(|t| {
            t.successors
                .iter()
                .find_map(|s| lanes.get(s).and_then(|l| l.junction_id.clone()))
        });

        segments.push(Segment {
            id: format!("seg:{}", chain[0]),
            lane_rsls: chain,
            length_m: acc,
            profile,
            entry_junction_id,
            exit_junction_id,
            min_through_lanes_same_dir: if min_same == usize::MAX { 0 } else { min_same },
            max_through_lanes_same_dir: max_same,
            min_speed_limit_kph: if min_speed.is_finite() {
                min_speed
            } else {
                0.0
            },
            max_speed_limit_kph: max_speed,
        });
    }

    segments.sort_by(|a, b| a.id.cmp(&b.id));
    segments
}

pub fn build_fact_index(
    lanes: &LaneTable,
    descriptors: &BTreeMap<String, JunctionDescriptor>,
    segments: &[Segment],
) -> FactIndex {
    let mut junctions_by_control: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut junctions_by_arms: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut junctions_by_turn_option: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (id, d) in descriptors {
        let control = d.control.map_or("unknown", JunctionControl::as_str);
        junctions_by_control
            .entry(control.to_owned())
            .or_default()
            .push(id.clone());
        junctions_by_arms
            .entry(d.arms.to_string())
            .or_default()
            .push(id.clone());
        let mut turns: BTreeSet<TurnDirection> = BTreeSet::new();
        for a in &d.approaches {
            turns.extend(a.turn_options.iter().copied());
        }
        for t in turns {
            junctions_by_turn_option
                .entry(t.as_str().to_owned())
                .or_default()
                .push(id.clone());
        }
    }
    let mut segments_by_lane_count: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut segment_ids_by_lane: BTreeMap<String, String> = BTreeMap::new();
    for seg in segments {
        for n in seg.min_through_lanes_same_dir..=seg.max_through_lanes_same_dir {
            segments_by_lane_count
                .entry(n.to_string())
                .or_default()
                .push(seg.id.clone());
        }
        for rsl in &seg.lane_rsls {
            segment_ids_by_lane.insert(rsl.clone(), seg.id.clone());
        }
    }
    for list in segments_by_lane_count.values_mut() {
        list.sort();
    }
    FactIndex {
        junctions_by_control,
        junctions_by_arms,
        junctions_by_turn_option,
        segments_by_lane_count,
        segment_ids_by_lane,
        point_features_by_kind: BTreeMap::new(),
        total_junctions: descriptors.len(),
        total_segments: segments.len(),
        total_lanes: lanes.len(),
    }
}

#[derive(Debug, Clone, Default)]
pub struct DeriveOptions<'a> {
    pub map_id: String,
    pub search_index: Option<&'a Value>,
    pub handedness: Option<Handedness>,
    pub topology_digest: Option<String>,
}

/// Build a [`DerivedMapIndex`] from the raw topology facts.
pub fn derive_map_index(raw: &RawTopology, options: &DeriveOptions<'_>) -> DerivedMapIndex {
    let mut lanes: LaneTable = BTreeMap::new();
    for (rsl, raw_lane) in &raw.lanes {
        let polyline = travel_polyline(raw_lane);
        let length_m = polyline_length(&polyline);
        lanes.insert(
            rsl.clone(),
            DerivedLane {
                rsl: rsl.clone(),
                road_id: raw_lane.road_id,
                section: raw_lane.section,
                lane_id: raw_lane.lane_id,
                lane_type: raw_lane.lane_type.clone(),
                is_junction: raw_lane.is_junction,
                junction_id: raw_lane.junction_id.clone(),
                polyline,
                length_m,
                speed_limit_kph: raw_lane.speed_limit_kph,
                representative_width_m: raw_lane.representative_width_m,
                width_samples: normalize_width_samples(raw_lane, length_m),
                adjacent_left: raw_lane.adjacent_left.clone(),
                adjacent_right: raw_lane.adjacent_right.clone(),
                lane_change_permissions: normalize_permissions(raw_lane, length_m),
                predecessors: Vec::new(),
                successors: Vec::new(),
            },
        );
    }
    let flipped = align_junction_lanes_to_gates(&mut lanes, &raw.gates);
    build_directed_links(&mut lanes, raw);
    let grid = LaneGrid::build(&lanes);

    let mut gates: Vec<DerivedGate> = raw
        .gates
        .iter()
        .map(|g| {
            let mut exits = g.exit_lane_rsls.clone();
            exits.sort();
            DerivedGate {
                id: g.id.clone(),
                junction_id: g.junction_id.clone(),
                turn_relation: g.turn_relation,
                heading_change_rad: g.heading_change_rad,
                approach_lane_rsl: g.approach_lane_rsl.clone(),
                connecting_lane_rsl: g.connecting_lane_rsl.clone(),
                exit_lane_rsls: exits,
            }
        })
        .collect();
    gates.sort_by(|a, b| a.id.cmp(&b.id));
    let gates_by_id: BTreeMap<String, DerivedGate> =
        gates.iter().map(|g| (g.id.clone(), g.clone())).collect();

    let mut junctions: BTreeMap<String, JunctionSpine> = BTreeMap::new();
    let mut descriptors: BTreeMap<String, JunctionDescriptor> = BTreeMap::new();
    for (id, spine) in &raw.junctions {
        let mut gate_ids = spine.gate_ids.clone();
        gate_ids.sort();
        let mut internal = spine.internal_lane_rsls.clone();
        internal.sort();
        let mut approach = spine.approach_lane_rsls.clone();
        approach.sort();
        junctions.insert(
            id.clone(),
            JunctionSpine {
                junction_id: id.clone(),
                gate_ids,
                internal_lane_rsls: internal,
                approach_lane_rsls: approach,
            },
        );
        descriptors.insert(
            id.clone(),
            build_junction_descriptor(id, raw, &lanes, &grid, &gates_by_id, options.search_index),
        );
    }

    let segments = build_segments(&lanes, &grid);
    let fact_index = build_fact_index(&lanes, &descriptors, &segments);
    let digest = options.topology_digest.clone().unwrap_or_else(|| {
        let tuple = format!(
            "{}|{}|{}|{}|{}",
            raw.xodr_sha256.as_deref().unwrap_or("unknown"),
            raw.schema_version,
            lanes.len(),
            gates.len(),
            junctions.len()
        );
        sha256(&tuple)[..32].to_owned()
    });
    let has_control = descriptors.values().any(|d| d.control.is_some());

    DerivedMapIndex {
        map_id: options.map_id.clone(),
        topology_digest: digest,
        handedness: options.handedness.unwrap_or(Handedness::Right),
        lanes,
        gates,
        junctions,
        segments,
        junction_descriptors: descriptors,
        point_features: Vec::new(),
        fact_index,
        capabilities: IndexCapabilities {
            grade: false,
            crossings: false,
            parking_zones: false,
            work_zones: false,
            occlusion_zones: false,
            junction_control: has_control,
        },
        provenance: IndexProvenance {
            source: IndexSource::SelfDerived,
            contract_version: DERIVED_INDEX_CONTRACT_VERSION.to_owned(),
            notes: vec![
                "derived from topology-index".to_owned(),
                if options.search_index.is_some() {
                    "junction control from search-index facts".to_owned()
                } else {
                    "no junction control source".to_owned()
                },
                format!("{flipped} junction lane(s) re-oriented from their gate approach"),
            ],
        },
        grid,
    }
}

/* ------------------------------------------------------------- normalize */

fn num(value: Option<&Value>, fallback: f64) -> f64 {
    value
        .and_then(Value::as_f64)
        .filter(|v| v.is_finite())
        .unwrap_or(fallback)
}

fn text<'a>(value: Option<&'a Value>, fallback: &'a str) -> &'a str {
    value.and_then(Value::as_str).unwrap_or(fallback)
}

fn as_array(value: Option<&Value>) -> Vec<&Value> {
    match value {
        Some(Value::Array(a)) => a.iter().collect(),
        Some(Value::Object(o)) => o.values().collect(),
        _ => Vec::new(),
    }
}

fn string_list(value: Option<&Value>) -> Vec<String> {
    as_array(value)
        .into_iter()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

/// Junction control vocabulary aliases from external producers.
pub fn normalize_control(value: Option<&Value>) -> Option<JunctionControl> {
    let s = value?.as_str()?;
    Some(match s {
        "signalized" | "signal" | "traffic_light" | "trafficLight" => JunctionControl::Signalized,
        "all_way_stop" | "allWayStop" | "four_way_stop" => JunctionControl::AllWayStop,
        "minor_stop" | "stop" | "two_way_stop" => JunctionControl::MinorStop,
        "yield" | "give_way" => JunctionControl::Yield,
        "uncontrolled" | "none" => JunctionControl::Uncontrolled,
        "roundabout" => JunctionControl::Roundabout,
        _ => return None,
    })
}

fn adopt_conflict_pairs(value: Option<&Value>) -> Option<Vec<ConflictPair>> {
    let Some(Value::Array(arr)) = value else {
        return None;
    };
    let mut out = Vec::new();
    for item in arr {
        let Some(obj) = item.as_object() else {
            continue;
        };
        let gate_a = text(
            obj.get("gateA").or(obj.get("a")).or(obj.get("fromGate")),
            "",
        );
        let gate_b = text(obj.get("gateB").or(obj.get("b")).or(obj.get("toGate")), "");
        if gate_a.is_empty() || gate_b.is_empty() {
            continue;
        }
        let point = match obj.get("pointXY").and_then(Value::as_array) {
            Some(xy) => Vec2 {
                x: num(xy.first(), 0.0),
                y: num(xy.get(1), 0.0),
            },
            None => {
                let pt = obj.get("point");
                Vec2 {
                    x: num(pt.and_then(|p| p.get("x")), 0.0),
                    y: num(pt.and_then(|p| p.get("y")), 0.0),
                }
            }
        };
        let angle_deg = match obj.get("crossingAngleRad").and_then(Value::as_f64) {
            Some(rad) => to_deg(rad),
            None => num(obj.get("crossingAngleDeg").or(obj.get("angleDeg")), 90.0),
        };
        let relation = match text(obj.get("relation"), "merge") {
            "opposing" => ApproachRelation::Opposing,
            "from_left" | "left" => ApproachRelation::FromLeft,
            "from_right" | "right" => ApproachRelation::FromRight,
            _ => ApproachRelation::Merge,
        };
        out.push(ConflictPair {
            gate_a: gate_a.to_owned(),
            gate_b: gate_b.to_owned(),
            point,
            s_on_a: num(obj.get("sOnA"), 0.0),
            s_on_b: num(obj.get("sOnB"), 0.0),
            crossing_angle_deg: angle_deg,
            relation,
        });
    }
    out.sort_by(|a, b| {
        a.gate_a
            .cmp(&b.gate_a)
            .then_with(|| a.gate_b.cmp(&b.gate_b))
    });
    Some(out)
}

fn looks_like_descriptor(value: &Value) -> bool {
    value.as_object().is_some_and(|o| {
        o.contains_key("conflictPairs")
            || o.contains_key("control")
            || o.contains_key("armCount")
            || o.contains_key("approaches")
    })
}

/// Keep the facts a clause can evaluate: scalars and string arrays.
pub fn normalize_facts(input: Option<&Value>) -> BTreeMap<String, Fact> {
    let mut out = BTreeMap::new();
    let Some(Value::Object(obj)) = input else {
        return out;
    };
    for (key, value) in obj {
        match value {
            Value::String(s) => {
                out.insert(key.clone(), Fact::Text(s.clone()));
            }
            Value::Number(n) => {
                if let Some(v) = n.as_f64() {
                    out.insert(key.clone(), Fact::Number(v));
                }
            }
            Value::Bool(b) => {
                out.insert(key.clone(), Fact::Bool(*b));
            }
            Value::Array(a) if !a.is_empty() && a.iter().all(Value::is_string) => {
                out.insert(
                    key.clone(),
                    Fact::Texts(
                        a.iter()
                            .filter_map(Value::as_str)
                            .map(str::to_owned)
                            .collect(),
                    ),
                );
            }
            _ => {}
        }
    }
    out
}

fn location_kind(type_name: &str, facts: &BTreeMap<String, Fact>) -> Option<PointFeatureKind> {
    Some(match type_name {
        "crosswalk" | "crossing" => PointFeatureKind::Crossing,
        "parking_space" | "parking_area" | "parking_lane" => PointFeatureKind::ParkingZone,
        "bus_stop" => PointFeatureKind::BusStop,
        "driveway" => PointFeatureKind::Driveway,
        "school_zone" => PointFeatureKind::SchoolZone,
        "work_zone_suitable" => PointFeatureKind::WorkZoneSuitable,
        "occlusion_zone" => PointFeatureKind::OcclusionZone,
        "driving_corridor" if facts.get("crest_present").and_then(Fact::as_bool) == Some(true) => {
            PointFeatureKind::Crest
        }
        _ => return None,
    })
}

fn scene_anchor_point(item: &Value) -> Option<Point2> {
    let scene = item.get("anchor")?.get("scene")?;
    let x = scene.get("x")?.as_f64()?;
    let z = scene.get("z")?.as_f64()?;
    (x.is_finite() && z.is_finite()).then_some(Vec2 { x, y: -z })
}

/// Adapt `locations.json` into point features (crossings, parking, ...).
pub fn point_features_from_locations(locations: &Value) -> Vec<PointFeature> {
    let list = match locations.get("locations") {
        Some(inner) => as_array(Some(inner)),
        None => as_array(Some(locations)),
    };
    let mut out = Vec::new();
    for item in list {
        let Some(obj) = item.as_object() else {
            continue;
        };
        let mut facts = normalize_facts(obj.get("facts"));
        let type_name = text(obj.get("type"), "");
        let Some(kind) = location_kind(type_name, &facts) else {
            continue;
        };
        let road = obj.get("anchor").and_then(|a| a.get("road"));
        let lane_rsl = text(road.and_then(|r| r.get("rsl")), "");
        if lane_rsl.is_empty() {
            continue;
        }
        let offset = num(road.and_then(|r| r.get("offsetM")), 0.0);
        let radius_m = num(obj.get("extent").and_then(|e| e.get("radiusM")), f64::NAN);
        if kind == PointFeatureKind::Crossing
            && radius_m.is_finite()
            && radius_m > 0.0
            && !facts.contains_key("crossing_length_m")
        {
            facts.insert("crossing_length_m".to_owned(), Fact::Number(radius_m * 2.0));
        }
        if kind == PointFeatureKind::ParkingZone
            && radius_m.is_finite()
            && radius_m > 0.0
            && !facts.contains_key("parking_length_m")
            && !facts.contains_key("length_m")
        {
            facts.insert(
                "parking_extent_length_m".to_owned(),
                Fact::Number(radius_m * 2.0),
            );
        }
        if kind == PointFeatureKind::ParkingZone && !facts.contains_key("parking_orientation") {
            if let Some(subtype) = obj.get("subtype").and_then(Value::as_str) {
                facts.insert(
                    "parking_orientation".to_owned(),
                    Fact::Text(subtype.to_owned()),
                );
            }
        }
        out.push(PointFeature {
            id: obj
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| format!("{}:{lane_rsl}", kind.as_str())),
            kind,
            lane_rsl: lane_rsl.to_owned(),
            s: num(road.and_then(|r| r.get("s")), 0.0),
            point: scene_anchor_point(item),
            side: Some(
                if offset > 0.0 {
                    "left"
                } else if offset < 0.0 {
                    "right"
                } else {
                    "both"
                }
                .to_owned(),
            ),
            junction_id: road
                .and_then(|r| r.get("junctionId"))
                .and_then(Value::as_str)
                .map(str::to_owned),
            facts,
        });
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

fn point_from_record(item: &Value) -> Option<Point2> {
    let point = item.get("point").filter(|p| p.is_object()).unwrap_or(item);
    let x = point.get("x")?.as_f64()?;
    let y = point.get("y")?.as_f64()?;
    (x.is_finite() && y.is_finite()).then_some(Vec2 { x, y })
}

fn adopt_point_features(input: &Value) -> Vec<PointFeature> {
    let mut out = Vec::new();
    let mut push = |kind: PointFeatureKind, items: Vec<&Value>| {
        for item in items {
            let Some(obj) = item.as_object() else {
                continue;
            };
            let lane_rsl = text(obj.get("laneRsl").or(obj.get("rsl")), "");
            if lane_rsl.is_empty() {
                continue;
            }
            let s = num(obj.get("s"), 0.0);
            let side = obj
                .get("side")
                .and_then(Value::as_str)
                .filter(|s| matches!(*s, "left" | "right" | "both"))
                .map(str::to_owned);
            out.push(PointFeature {
                id: obj
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .unwrap_or_else(|| format!("{}:{lane_rsl}@{s:.1}", kind.as_str())),
                kind,
                lane_rsl: lane_rsl.to_owned(),
                s,
                point: point_from_record(item),
                side,
                junction_id: obj
                    .get("junctionId")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                facts: normalize_facts(obj.get("facts")),
            });
        }
    };
    push(PointFeatureKind::Crossing, as_array(input.get("crossings")));
    push(
        PointFeatureKind::ParkingZone,
        as_array(input.get("parkingZones").or(input.get("parking_zones"))),
    );
    push(
        PointFeatureKind::BusStop,
        as_array(input.get("busStops").or(input.get("bus_stops"))),
    );
    push(PointFeatureKind::Driveway, as_array(input.get("driveways")));
    push(
        PointFeatureKind::SchoolZone,
        as_array(input.get("schoolZones").or(input.get("school_zones"))),
    );
    push(
        PointFeatureKind::WorkZoneSuitable,
        as_array(input.get("workZones").or(input.get("work_zones"))),
    );
    push(
        PointFeatureKind::OcclusionZone,
        as_array(input.get("occlusionZones").or(input.get("occlusion_zones"))),
    );
    push(PointFeatureKind::Crest, as_array(input.get("crests")));
    for item in as_array(input.get("pointFeatures")) {
        if let Some(kind) = item
            .get("kind")
            .and_then(Value::as_str)
            .and_then(PointFeatureKind::from_str)
        {
            push(kind, vec![item]);
        }
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

#[derive(Debug, Clone, Default)]
pub struct NormalizeOptions<'a> {
    pub map_id: Option<String>,
    pub search_index: Option<&'a Value>,
    pub handedness: Option<Handedness>,
    /// `locations.json`.
    pub locations: Option<&'a Value>,
}

/// Adapt map-intel's derived index over the topology spine onto
/// [`DerivedMapIndex`]. Never fails on unknown extra keys.
pub fn normalize_derived_map_index(
    input: &Value,
    topology: &TopologyIndex,
    options: &NormalizeOptions<'_>,
) -> DerivedMapIndex {
    let mut raw = RawTopology::from_topology(topology);
    // A producer that carries its own lane/gate tables wins over the spine.
    if let Some(Value::Object(lanes_in)) = input.get("lanes") {
        raw.lanes = lanes_in
            .iter()
            .filter_map(|(rsl, lane)| {
                let obj = lane.as_object()?;
                let mut parts = rsl.split(':');
                let road_default: i64 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
                let section_default: i64 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
                let lane_default: i64 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
                let adj = |key: &str| -> AdjacentLaneRef {
                    let r = obj.get("adjacentLanes").and_then(|a| a.get(key));
                    AdjacentLaneRef {
                        lane_rsl: r
                            .and_then(|x| x.get("laneRsl"))
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                        same_direction: r
                            .and_then(|x| x.get("sameDirection"))
                            .and_then(Value::as_bool)
                            == Some(true),
                    }
                };
                let polyline = as_array(obj.get("polyline").or(obj.get("centerline")))
                    .into_iter()
                    .filter_map(|p| match p {
                        Value::Array(xy) => Some(Vec2 {
                            x: xy.first()?.as_f64()?,
                            y: xy.get(1)?.as_f64()?,
                        }),
                        Value::Object(o) => Some(Vec2 {
                            x: o.get("x")?.as_f64()?,
                            y: o.get("y")?.as_f64()?,
                        }),
                        _ => None,
                    })
                    .collect();
                Some((
                    rsl.clone(),
                    RawLane {
                        rsl: rsl.clone(),
                        road_id: num(obj.get("roadId"), road_default as f64) as i64,
                        section: num(obj.get("section"), section_default as f64) as i64,
                        lane_id: num(obj.get("laneId"), lane_default as f64) as i64,
                        lane_type: text(obj.get("laneType"), "driving").to_owned(),
                        is_junction: obj.get("isJunction").and_then(Value::as_bool) == Some(true)
                            || obj.get("junctionId").is_some_and(Value::is_string),
                        junction_id: obj
                            .get("junctionId")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                        predecessors: string_list(obj.get("predecessors")),
                        successors: string_list(obj.get("successors")),
                        speed_limit_kph: num(obj.get("speedLimitKph"), 50.0),
                        representative_width_m: num(
                            obj.get("representativeWidthM").or(obj.get("widthM")),
                            3.5,
                        ),
                        width_samples: as_array(obj.get("widthSamples"))
                            .into_iter()
                            .filter(|w| w.is_object())
                            .map(|w| WidthSample {
                                s: num(w.get("s"), 0.0),
                                width_m: num(w.get("widthM").or(w.get("width")), 3.5),
                            })
                            .collect(),
                        adjacent_left: adj("left"),
                        adjacent_right: adj("right"),
                        lane_change_permissions: as_array(obj.get("laneChangePermissions"))
                            .into_iter()
                            .filter(|p| p.is_object())
                            .map(|p| LaneChangePermission {
                                side: if text(p.get("side"), "right") == "left" {
                                    LaneSideName::Left
                                } else {
                                    LaneSideName::Right
                                },
                                start_s: num(p.get("startS"), 0.0),
                                end_s: num(p.get("endS"), 0.0),
                                allowed: p.get("allowed").and_then(Value::as_bool) != Some(false),
                            })
                            .collect(),
                        polyline,
                    },
                ))
            })
            .collect();
    }
    if let Some(Value::Array(gates_in)) = input.get("gates") {
        raw.gates = gates_in
            .iter()
            .filter_map(|g| {
                let obj = g.as_object()?;
                let approach = text(obj.get("approachLaneRsl").or(obj.get("approachLane")), "");
                let connecting = text(
                    obj.get("connectingLaneRsl").or(obj.get("connectingLane")),
                    "",
                );
                if approach.is_empty() || connecting.is_empty() {
                    return None;
                }
                Some(RawGate {
                    id: obj
                        .get("id")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                        .unwrap_or_else(|| format!("{approach}->{connecting}")),
                    junction_id: text(obj.get("junctionId"), "").to_owned(),
                    turn_relation: normalize_turn(text(
                        obj.get("turnRelation").or(obj.get("turn")),
                        "Straight",
                    )),
                    heading_change_rad: num(obj.get("headingChangeRad"), 0.0),
                    connecting_lane_rsl: connecting.to_owned(),
                    approach_lane_rsl: approach.to_owned(),
                    exit_lane_rsls: string_list(obj.get("exitLaneRsls").or(obj.get("exitLanes"))),
                })
            })
            .collect();
    }
    let junctions_field = input.get("junctions");
    let junctions_are_descriptors = match junctions_field {
        Some(Value::Array(_)) => true,
        Some(Value::Object(o)) => o.values().any(looks_like_descriptor),
        _ => false,
    };
    if let (false, Some(Value::Object(spine))) = (junctions_are_descriptors, junctions_field) {
        raw.junctions = spine
            .iter()
            .filter_map(|(id, j)| {
                j.as_object()?;
                Some((
                    id.clone(),
                    JunctionSpine {
                        junction_id: text(j.get("junctionId"), id).to_owned(),
                        gate_ids: string_list(j.get("gateIds")),
                        internal_lane_rsls: string_list(
                            j.get("internalLaneRsls").or(j.get("internalLanes")),
                        ),
                        approach_lane_rsls: string_list(
                            j.get("approachLaneRsls").or(j.get("approachLanes")),
                        ),
                    },
                ))
            })
            .collect();
    }
    let order = detect_polyline_order(&raw.lanes, &raw.gates);
    if order == PolylineOrder::Travel {
        for lane in raw.lanes.values_mut() {
            if lane.lane_id > 0 {
                lane.polyline.reverse();
            }
        }
    }
    if raw.junctions.is_empty() {
        for gate in &raw.gates {
            if gate.junction_id.is_empty() {
                continue;
            }
            let entry = raw
                .junctions
                .entry(gate.junction_id.clone())
                .or_insert_with(|| JunctionSpine {
                    junction_id: gate.junction_id.clone(),
                    gate_ids: Vec::new(),
                    internal_lane_rsls: Vec::new(),
                    approach_lane_rsls: Vec::new(),
                });
            entry.gate_ids.push(gate.id.clone());
            entry
                .internal_lane_rsls
                .push(gate.connecting_lane_rsl.clone());
            entry
                .approach_lane_rsls
                .push(gate.approach_lane_rsl.clone());
        }
    }
    if let Some(v) = input.get("schemaVersion").and_then(Value::as_u64) {
        raw.schema_version = v as u32;
    }
    if let Some(s) = input
        .get("source")
        .and_then(|s| s.get("xodrSha256"))
        .and_then(Value::as_str)
    {
        raw.xodr_sha256 = Some(s.to_owned());
    }

    let map_id = options.map_id.clone().unwrap_or_else(|| {
        text(input.get("mapId").or(input.get("mapName")), "unknown-map").to_owned()
    });
    let mut base = derive_map_index(
        &raw,
        &DeriveOptions {
            map_id,
            search_index: options.search_index,
            handedness: options.handedness,
            topology_digest: input
                .get("topologyDigest")
                .and_then(Value::as_str)
                .map(str::to_owned),
        },
    );

    let mut notes = base.provenance.notes.clone();
    let mut adopted = false;
    let mut junction_crossing_layer = false;
    let mut arm_disagreements = 0usize;
    let mut relation_disagreements = 0usize;
    let mut arc_checks = 0usize;
    let mut arc_disagreements = 0usize;
    let mut pairs_adopted = 0usize;
    let gate_by_id: BTreeMap<String, DerivedGate> = base
        .gates
        .iter()
        .map(|g| (g.id.clone(), g.clone()))
        .collect();

    let descriptors_in = input
        .get("junctionDescriptors")
        .or(if junctions_are_descriptors {
            junctions_field
        } else {
            None
        });
    let descriptor_list: Vec<&Value> = match descriptors_in {
        Some(Value::Array(a)) => a.iter().collect(),
        Some(Value::Object(o)) => o.values().collect(),
        _ => Vec::new(),
    };
    for d in descriptor_list {
        let Some(obj) = d.as_object() else { continue };
        let id = text(obj.get("junctionId").or(obj.get("id")), "").to_owned();
        let Some(existing) = base.junction_descriptors.get_mut(&id) else {
            continue;
        };
        adopted = true;
        if let Some(control) = normalize_control(obj.get("control").or(obj.get("controlType"))) {
            existing.control = Some(control);
        }
        if let Some(arms) = obj.get("armCount").and_then(Value::as_f64) {
            let arms = arms.max(0.0) as usize;
            if arms != existing.arms {
                arm_disagreements += 1;
            }
            existing.arms = arms;
        }
        if let Some(pairs) = adopt_conflict_pairs(obj.get("conflictPairs").or(obj.get("conflicts")))
        {
            if !pairs.is_empty() {
                pairs_adopted += pairs.len();
                for (i, pair) in pairs.iter().enumerate() {
                    let approach_a = gate_by_id
                        .get(&pair.gate_a)
                        .and_then(|g| base.lanes.get(&g.approach_lane_rsl));
                    let approach_b = gate_by_id
                        .get(&pair.gate_b)
                        .and_then(|g| base.lanes.get(&g.approach_lane_rsl));
                    if let (Some(a), Some(b)) = (approach_a, approach_b) {
                        let expected = relation_from_headings(
                            heading_at_s(&a.polyline, a.length_m),
                            heading_at_s(&b.polyline, b.length_m),
                        );
                        if expected != pair.relation {
                            relation_disagreements += 1;
                        }
                    }
                    if i % 16 == 0 {
                        for (gate_id, s) in
                            [(&pair.gate_a, pair.s_on_a), (&pair.gate_b, pair.s_on_b)]
                        {
                            let Some(lane) = gate_by_id
                                .get(gate_id)
                                .and_then(|g| base.lanes.get(&g.connecting_lane_rsl))
                            else {
                                continue;
                            };
                            if lane.polyline.len() < 2 {
                                continue;
                            }
                            arc_checks += 1;
                            if (project_point(&lane.polyline, pair.point).s - s).abs() > 1.0 {
                                arc_disagreements += 1;
                            }
                        }
                    }
                }
                existing.conflict_pairs = pairs;
            }
        }
        if let Some(Value::Object(crossings)) = obj.get("crossingsByApproach") {
            existing.crossings_by_approach = crossings
                .iter()
                .map(|(k, v)| (k.clone(), string_list(Some(v))))
                .collect();
        } else if let Some(Value::Array(_)) = obj.get("crossingLocationIds") {
            junction_crossing_layer = true;
            let ids = string_list(obj.get("crossingLocationIds"));
            existing.crossings_by_approach = if ids.is_empty() {
                BTreeMap::new()
            } else {
                BTreeMap::from([("*".to_owned(), ids)])
            };
        }
    }
    if adopted {
        notes.push("adopted junctionDescriptors from the external index".to_owned());
    }
    if pairs_adopted > 0 {
        notes.push(format!(
            "adopted {pairs_adopted} conflict pair(s); {relation_disagreements} relation label(s) and {arc_disagreements}/{arc_checks} sampled arc length(s) disagreed with the local derivation"
        ));
    }
    if relation_disagreements as f64 > 0.05 * pairs_adopted.max(1) as f64 {
        notes.push(format!(
            "WARNING: {:.1} % of adopted conflict relations disagree with this package's geometry — the producers have drifted on the approach-relation convention",
            100.0 * relation_disagreements as f64 / pairs_adopted.max(1) as f64
        ));
    }
    if arc_disagreements > 0 {
        notes.push(format!("WARNING: {arc_disagreements} sampled conflict arc length(s) are more than 1 m from their reprojection — the producers may have drifted on polyline ordering"));
    }
    if arm_disagreements > 0 {
        notes.push(format!("adopted the external arm count at {arm_disagreements} junction(s) where the local derivation disagreed"));
    }

    let mut adopted_segments: Vec<Segment> = Vec::new();
    for s in as_array(input.get("segments")) {
        let Some(obj) = s.as_object() else { continue };
        let lane_rsls = string_list(obj.get("laneRsls").or(obj.get("laneRefs")));
        if lane_rsls.is_empty() {
            continue;
        }
        let id = obj
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| format!("seg:{}", lane_rsls[0]));
        let mut adjacent: Vec<String> = Vec::new();
        for (key, kind) in [
            ("hasParkingAdjacent", "parking"),
            ("hasBikeAdjacent", "biking"),
            ("hasSidewalkAdjacent", "sidewalk"),
            ("hasShoulderAdjacent", "shoulder"),
            ("hasMedianAdjacent", "median"),
        ] {
            if obj.get(key).and_then(Value::as_bool) == Some(true) {
                adjacent.push(kind.to_owned());
            }
        }
        if obj.get("isOneWay").and_then(Value::as_bool) == Some(false) {
            adjacent.push("opposing".to_owned());
        }
        adjacent.sort();
        let profile: Vec<SegmentProfileSample> = as_array(obj.get("profile"))
            .into_iter()
            .filter(|p| p.is_object())
            .map(|p| SegmentProfileSample {
                s: num(p.get("s"), 0.0),
                lane_rsl: text(p.get("laneRsl"), &lane_rsls[0]).to_owned(),
                through_lanes_same_dir: num(
                    p.get("throughLanesSameDir").or(p.get("lanesSameDir")),
                    1.0,
                )
                .max(0.0) as usize,
                through_lanes_opposing: num(
                    p.get("throughLanesOpposing").or(p.get("lanesOpposing")),
                    0.0,
                )
                .max(0.0) as usize,
                lane_width_m: num(p.get("laneWidthM"), 3.5),
                speed_limit_kph: num(p.get("speedLimitKph"), 50.0),
                curvature_deg_per10m: num(p.get("curvatureDegPer10m"), 0.0),
                adjacent_kinds: adjacent.clone(),
            })
            .collect();
        let counts: Vec<usize> = profile.iter().map(|p| p.through_lanes_same_dir).collect();
        let speeds: Vec<f64> = profile.iter().map(|p| p.speed_limit_kph).collect();
        let min_c = counts.iter().copied().min().unwrap_or(1);
        let max_c = counts.iter().copied().max().unwrap_or(1);
        let min_sp = speeds.iter().copied().fold(f64::INFINITY, f64::min);
        let max_sp = speeds.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        adopted_segments.push(Segment {
            id,
            lane_rsls,
            length_m: num(obj.get("lengthM"), 0.0),
            profile,
            entry_junction_id: obj
                .get("entryJunctionId")
                .and_then(Value::as_str)
                .map(str::to_owned),
            exit_junction_id: obj
                .get("exitJunctionId")
                .and_then(Value::as_str)
                .map(str::to_owned),
            min_through_lanes_same_dir: num(
                obj.get("minThroughLanesSameDir")
                    .or(obj.get("minLanesSameDir")),
                min_c as f64,
            )
            .max(0.0) as usize,
            max_through_lanes_same_dir: num(
                obj.get("maxThroughLanesSameDir")
                    .or(obj.get("maxLanesSameDir")),
                max_c as f64,
            )
            .max(0.0) as usize,
            min_speed_limit_kph: num(
                obj.get("minSpeedLimitKph"),
                if speeds.is_empty() { 0.0 } else { min_sp },
            ),
            max_speed_limit_kph: num(
                obj.get("maxSpeedLimitKph"),
                if speeds.is_empty() { 0.0 } else { max_sp },
            ),
        });
    }
    adopted_segments.sort_by(|a, b| a.id.cmp(&b.id));
    if !adopted_segments.is_empty() {
        adopted = true;
        notes.push(format!(
            "adopted {} segments from the external index",
            adopted_segments.len()
        ));
        base.segments = adopted_segments;
    }

    let mut point_features = adopt_point_features(input);
    if let Some(locations) = options.locations {
        point_features.extend(point_features_from_locations(locations));
    }
    point_features.sort_by(|a, b| a.id.cmp(&b.id));
    let mut by_kind: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for pf in &point_features {
        by_kind
            .entry(pf.kind.as_str().to_owned())
            .or_default()
            .push(pf.id.clone());
    }
    let has_crossings = point_features
        .iter()
        .any(|p| p.kind == PointFeatureKind::Crossing)
        || junction_crossing_layer
        || base
            .junction_descriptors
            .values()
            .any(|d| !d.crossings_by_approach.is_empty());

    let mut fact_index = build_fact_index(&base.lanes, &base.junction_descriptors, &base.segments);
    fact_index.point_features_by_kind = by_kind;
    base.fact_index = fact_index;
    base.capabilities.crossings = has_crossings;
    base.capabilities.parking_zones = point_features
        .iter()
        .any(|p| p.kind == PointFeatureKind::ParkingZone);
    base.capabilities.work_zones = point_features
        .iter()
        .any(|p| p.kind == PointFeatureKind::WorkZoneSuitable);
    base.capabilities.occlusion_zones = point_features
        .iter()
        .any(|p| p.kind == PointFeatureKind::OcclusionZone);
    base.capabilities.junction_control = base
        .junction_descriptors
        .values()
        .any(|d| d.control.is_some());
    base.point_features = point_features;
    notes.push(format!(
        "polyline order detected: {}",
        if order == PolylineOrder::Travel {
            "travel"
        } else {
            "odr"
        }
    ));
    base.provenance = IndexProvenance {
        source: if adopted {
            IndexSource::MapIntel
        } else {
            IndexSource::SelfDerived
        },
        contract_version: DERIVED_INDEX_CONTRACT_VERSION.to_owned(),
        notes,
    };
    base
}

/// Point at travel arc length `s` on a derived lane.
pub fn lane_point_at(lane: &DerivedLane, s: f64) -> Point2 {
    point_at_s(&lane.polyline, s)
}
