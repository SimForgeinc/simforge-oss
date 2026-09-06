//! Logical anchor → ranked concrete sites.
//!
//! The matcher is a **pure function of `(anchor, derived index)`**: no clock,
//! no RNG, sorted iteration at every fan-out, so a `site_id` produced today is
//! the same one produced on another machine next month, provided the map
//! digest and the match-semantics version are unchanged.
//!
//! [`adapt`] turns the authored v2 template into the matcher's evaluation
//! vocabulary (closed ranges, numeric poses at parameter defaults, per-kind
//! feature predicates). Where the authored document says something the
//! matcher cannot evaluate, the clause is dropped and a note recorded: never
//! silently, because a dropped `required` clause is a scenario testing
//! something it no longer tests.

pub mod adapt;
pub mod bind;
pub mod clauses;
pub mod degrade;
pub mod frame;
pub mod matcher;
pub mod scoring;

use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::Value;

use crate::geometry::Point2;
use crate::template::{
    ApproachRelation, CrossingPlacement, Essentiality, JunctionControl, OnMissing,
    ParkingOrientation, Side, TurnDirection,
};

/// Version of the *match semantics*: bump whenever candidate generation, frame
/// construction or the site-id tuple would make cached site ids point at
/// different structure. Not bumped for scoring/weight tuning.
pub const MATCH_SEMANTICS_VERSION: &str = "1.0.0";

/// Sentinel for an open range end: unreachable on any map, keeps slack finite.
pub const OPEN_END_M: f64 = 1e9;

/// Closed `[min, max]`.
pub type MRange = (f64, f64);

/// `{value, essentiality, weight?}` in the matcher's evaluation vocabulary.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MClause<T> {
    pub value: T,
    pub essentiality: Essentiality,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub weight: Option<f64>,
}

impl<T> MClause<T> {
    pub fn new(value: T, essentiality: Essentiality, weight: Option<f64>) -> Self {
        Self {
            value,
            essentiality,
            weight,
        }
    }

    /// Effective weight: explicit, else `required 1 / preferred 1 / cosmetic 0.25`.
    pub fn weight(&self) -> f64 {
        self.weight.unwrap_or(match self.essentiality {
            Essentiality::Required | Essentiality::Preferred => 1.0,
            Essentiality::Cosmetic => 0.25,
        })
    }

    pub fn map<U>(&self, f: impl FnOnce(&T) -> U) -> MClause<U> {
        MClause {
            value: f(&self.value),
            essentiality: self.essentiality,
            weight: self.weight,
        }
    }
}

/// Adjacent kinds the matcher can evaluate at a cross-section.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MAdjacentKind {
    Parking,
    Biking,
    Sidewalk,
    Shoulder,
    Median,
    Opposing,
}

impl MAdjacentKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Parking => "parking",
            Self::Biking => "biking",
            Self::Sidewalk => "sidewalk",
            Self::Shoulder => "shoulder",
            Self::Median => "median",
            Self::Opposing => "opposing",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MLaneChangeLegal {
    pub side: Side,
    pub s_range: MRange,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MCorridor {
    pub through_lanes_same_dir: Option<MClause<MRange>>,
    pub through_lanes_opposing: Option<MClause<MRange>>,
    pub lane_width_m: Option<MClause<MRange>>,
    pub speed_limit_kph: Option<MClause<MRange>>,
    /// Minimum drivable metres upstream of the origin feature.
    pub runway_upstream_m: Option<MClause<f64>>,
    pub runway_downstream_m: Option<MClause<f64>>,
    pub curvature_deg_per10m: Option<MClause<MRange>>,
    pub grade_pct: Option<MClause<MRange>>,
    pub requires_adjacent: Option<MClause<Vec<MAdjacentKind>>>,
    pub forbids_adjacent: Option<MClause<Vec<MAdjacentKind>>>,
    pub lane_change_legal: Option<MClause<MLaneChangeLegal>>,
}

impl MCorridor {
    pub fn is_empty(&self) -> bool {
        self.through_lanes_same_dir.is_none()
            && self.through_lanes_opposing.is_none()
            && self.lane_width_m.is_none()
            && self.speed_limit_kph.is_none()
            && self.runway_upstream_m.is_none()
            && self.runway_downstream_m.is_none()
            && self.curvature_deg_per10m.is_none()
            && self.grade_pct.is_none()
            && self.requires_adjacent.is_none()
            && self.forbids_adjacent.is_none()
            && self.lane_change_legal.is_none()
    }
}

/// Kinds of structural feature the matcher can look for along a reference path.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MFeatureKind {
    Junction,
    Crossing,
    Merge,
    LaneDrop,
    ParkingZone,
    BusStop,
    Driveway,
    SchoolZone,
    WorkZoneSuitable,
    OcclusionZone,
    Crest,
}

impl MFeatureKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Junction => "junction",
            Self::Crossing => "crossing",
            Self::Merge => "merge",
            Self::LaneDrop => "lane_drop",
            Self::ParkingZone => "parking_zone",
            Self::BusStop => "bus_stop",
            Self::Driveway => "driveway",
            Self::SchoolZone => "school_zone",
            Self::WorkZoneSuitable => "work_zone_suitable",
            Self::OcclusionZone => "occlusion_zone",
            Self::Crest => "crest",
        }
    }

    pub fn point_kind(self) -> Option<crate::map_index::PointFeatureKind> {
        use crate::map_index::PointFeatureKind as P;
        Some(match self {
            Self::Crossing => P::Crossing,
            Self::ParkingZone => P::ParkingZone,
            Self::BusStop => P::BusStop,
            Self::Driveway => P::Driveway,
            Self::SchoolZone => P::SchoolZone,
            Self::WorkZoneSuitable => P::WorkZoneSuitable,
            Self::OcclusionZone => P::OcclusionZone,
            Self::Crest => P::Crest,
            Self::Junction | Self::Merge | Self::LaneDrop => return None,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MConflictingApproach {
    pub from: ApproachRelation,
    pub turn: TurnDirection,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub crossing_angle_deg: Option<MRange>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MJunctionPredicate {
    pub arms: Option<MClause<MRange>>,
    pub control: Option<MClause<Vec<JunctionControl>>>,
    pub ego_turn: Option<MClause<TurnDirection>>,
    pub conflicting_approach: Option<MClause<MConflictingApproach>>,
    pub size_m: Option<MClause<MRange>>,
    pub has_crossing_on_leg: Option<MClause<bool>>,
}

impl MJunctionPredicate {
    pub fn is_empty(&self) -> bool {
        self.arms.is_none()
            && self.control.is_none()
            && self.ego_turn.is_none()
            && self.conflicting_approach.is_none()
            && self.size_m.is_none()
            && self.has_crossing_on_leg.is_none()
    }
}

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MParkingPredicate {
    pub orientation: Option<MClause<ParkingOrientation>>,
    pub capacity: Option<MClause<MRange>>,
    pub occupancy: Option<MClause<MRange>>,
    pub length_m: Option<MClause<MRange>>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MCrossingPredicate {
    pub marked: Option<MClause<bool>>,
    pub controlled: Option<MClause<bool>>,
    pub length_m: Option<MClause<MRange>>,
    pub placement: Option<MClause<CrossingPlacement>>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MFeature {
    pub id: String,
    pub kind: MFeatureKind,
    pub at_m: MClause<MRange>,
    pub lateral_distance_m: Option<MClause<MRange>>,
    pub same_road: Option<MClause<bool>>,
    pub side: Option<MClause<Side>>,
    pub supports_scenario: Option<MClause<Vec<String>>>,
    pub junction: Option<MJunctionPredicate>,
    pub crossing: Option<MCrossingPredicate>,
    pub parking: Option<MParkingPredicate>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MDiversity {
    Junction,
    RoadDirection,
    None,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MPolicy {
    pub allow_mirror: bool,
    pub max_sites_per_map: usize,
    pub diversity: MDiversity,
    pub min_score: f64,
}

impl Default for MPolicy {
    fn default() -> Self {
        Self {
            allow_mirror: false,
            max_sites_per_map: 10,
            diversity: MDiversity::Junction,
            min_score: 0.5,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MPin {
    pub map_id: String,
    pub site_id: String,
}

/// The matcher's anchor: closed ranges, one ego turn, nested predicates.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MAnchor {
    pub id: String,
    pub corridor: Option<MCorridor>,
    pub features: Vec<MFeature>,
    pub policy: MPolicy,
    pub pin: Option<MPin>,
}

impl MAnchor {
    /// The feature that establishes the frame origin (`features[0]`).
    pub fn origin_feature(&self) -> Option<&MFeature> {
        self.features.first()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MCrossingDirection {
    LeftToRight,
    RightToLeft,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MLaneDropLane {
    Terminating,
    ContinuingSibling,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MParkingSide {
    Left,
    Right,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MHeadingRelation {
    pub role: String,
    pub relation: crate::template::HeadingRelationKind,
    pub max_error_deg: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MArrival {
    pub relative_to: String,
    pub delta_t: f64,
}

/// Role binding request in the matcher vocabulary: the structural pass only.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MRoleKind {
    #[serde(rename_all = "camelCase")]
    OnReference { ds_m: f64, t_frac: f64 },
    #[serde(rename_all = "camelCase")]
    LaneOffset {
        k: i32,
        on_missing: OnMissing,
        ds_m: f64,
        t_frac: f64,
    },
    #[serde(rename_all = "camelCase")]
    AtLaneDrop {
        feature: String,
        lane: MLaneDropLane,
        ds_m: f64,
        t_frac: f64,
    },
    #[serde(rename_all = "camelCase")]
    Opposing {
        index: usize,
        ds_m: f64,
        t_frac: f64,
    },
    #[serde(rename_all = "camelCase")]
    ConflictingGate {
        feature: String,
        from: ApproachRelation,
        turn: TurnDirection,
        template_crossing_angle_deg: Option<f64>,
        arrive_at_conflict: Option<MArrival>,
        min_upstream_runway_m: Option<f64>,
    },
    #[serde(rename_all = "camelCase")]
    OnCrossing {
        feature: String,
        start_frac: f64,
        direction: MCrossingDirection,
    },
    #[serde(rename_all = "camelCase")]
    InParkingZone {
        feature: String,
        side: MParkingSide,
        slot_index: u32,
    },
    #[serde(rename_all = "camelCase")]
    RelativeTo {
        r#ref: String,
        d_lane: i32,
        on_missing: OnMissing,
        ds_m: f64,
        t_frac: Option<f64>,
    },
}

impl MRoleKind {
    pub fn name(&self) -> &'static str {
        match self {
            Self::OnReference { .. } => "on_reference",
            Self::LaneOffset { .. } => "lane_offset",
            Self::AtLaneDrop { .. } => "at_lane_drop",
            Self::Opposing { .. } => "opposing",
            Self::ConflictingGate { .. } => "conflicting_gate",
            Self::OnCrossing { .. } => "on_crossing",
            Self::InParkingZone { .. } => "in_parking_zone",
            Self::RelativeTo { .. } => "relative_to",
        }
    }

    pub fn on_missing(&self) -> Option<OnMissing> {
        match self {
            Self::LaneOffset { on_missing, .. } | Self::RelativeTo { on_missing, .. } => {
                Some(*on_missing)
            }
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MRole {
    pub role: String,
    pub essentiality: Essentiality,
    pub required_same_segment_as: Option<String>,
    pub required_same_road_section_as: Option<String>,
    pub required_heading_relation: Option<MHeadingRelation>,
    #[serde(flatten)]
    pub kind: MRoleKind,
}

/* ----------------------------------------------------------------- sites */

/// A pose in the anchor frame. Never world space.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SitePose {
    pub k: i32,
    pub s: f64,
    pub t_frac: f64,
    pub heading_offset_rad: f64,
}

/// One lane's slice of the reference path.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceSpan {
    pub lane_rsl: String,
    pub s_start: f64,
    pub s_end: f64,
    pub length_m: f64,
    pub is_junction: bool,
    pub contiguous: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OriginKind {
    Junction,
    Corridor,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameOrigin {
    pub anchor_feature_id: String,
    pub kind: OriginKind,
    /// Concrete map feature id, e.g. `junction:115`. Part of the site id.
    pub map_feature_id: String,
}

/// The coordinate system the whole scenario is expressed in.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnchorFrame {
    pub origin: FrameOrigin,
    pub entry_lane_rsl: String,
    pub reference_path: Vec<ReferenceSpan>,
    pub s_of_lane: BTreeMap<String, f64>,
    pub s_range: (f64, f64),
    /// Same-direction lanes at the origin cross-section, by signed k.
    pub lateral_lanes: BTreeMap<i32, String>,
    /// Opposing driving lanes at the origin cross-section, innermost first.
    pub opposing_lanes: Vec<String>,
    pub handedness: crate::map_index::Handedness,
    pub mirrored: bool,
    pub ego_gate_id: Option<String>,
    pub ego_turn: Option<TurnDirection>,
    pub runway_upstream_m: f64,
    pub runway_downstream_m: f64,
}

impl AnchorFrame {
    pub fn origin_junction_id(&self) -> Option<&str> {
        self.origin.map_feature_id.strip_prefix("junction:")
    }

    /// Lane occupying arc length `s` on the reference path, with the local offset.
    pub fn lane_at_s(&self, s: f64) -> Option<(&ReferenceSpan, f64)> {
        self.reference_path
            .iter()
            .find(|span| s >= span.s_start && s <= span.s_end)
            .map(|span| (span, s - span.s_start))
    }

    pub fn lateral_rsl(&self, k: i32) -> Option<&str> {
        self.lateral_lanes.get(&k).map(String::as_str)
    }
}

/// One evaluated clause — the unit of explainability.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClauseResult {
    pub path: String,
    pub essentiality: Essentiality,
    pub required: Value,
    pub actual: Value,
    pub score: f64,
    pub slack: f64,
    pub weight: f64,
    pub supported: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worst_at_s: Option<f64>,
    pub reason: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BindingStatus {
    Bound,
    Clamped,
    Dropped,
    Failed,
}

impl BindingStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Bound => "bound",
            Self::Clamped => "clamped",
            Self::Dropped => "dropped",
            Self::Failed => "failed",
        }
    }

    pub fn is_placed(self) -> bool {
        matches!(self, Self::Bound | Self::Clamped)
    }
}

/// Conflict geometry handed to the arrival solver.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictBinding {
    pub gate_id: String,
    pub ego_gate_id: String,
    pub point: Point2,
    pub s_on_ego: f64,
    pub s_on_actor: f64,
    pub crossing_angle_deg: f64,
    pub relation: ApproachRelation,
    pub angle_error_deg: f64,
}

/// Structural binding of one role at one site.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeatureBinding {
    pub role: String,
    pub kind: String,
    pub status: BindingStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pose: Option<SitePose>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lane_rsl: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub route_lane_chain: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conflict: Option<ConflictBinding>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arrival: Option<MArrival>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub on_missing: Option<OnMissing>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_k: Option<i32>,
    pub notes: Vec<String>,
}

impl FeatureBinding {
    pub fn new(role: &str, kind: &str) -> Self {
        Self {
            role: role.to_owned(),
            kind: kind.to_owned(),
            status: BindingStatus::Failed,
            pose: None,
            lane_rsl: None,
            route_lane_chain: None,
            conflict: None,
            arrival: None,
            on_missing: None,
            requested_k: None,
            notes: Vec::new(),
        }
    }
}

/// A relaxation the matcher applied to make a site work.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Repair {
    #[serde(rename_all = "camelCase")]
    SpeedClamp {
        path: String,
        requested_kph: (f64, f64),
        applied_kph: f64,
        touches_required: bool,
        note: String,
    },
    #[serde(rename_all = "camelCase")]
    RunwayShorten {
        path: String,
        requested_m: f64,
        available_m: f64,
        touches_required: bool,
        note: String,
    },
    #[serde(rename_all = "camelCase")]
    FeatureDistanceRelax {
        path: String,
        requested_m: (f64, f64),
        actual_m: f64,
        slack_m: f64,
        touches_required: bool,
        note: String,
    },
    #[serde(rename_all = "camelCase")]
    LaneOffsetClamp {
        role: String,
        requested_k: i32,
        applied_k: i32,
        touches_required: bool,
        note: String,
    },
    #[serde(rename_all = "camelCase")]
    JunctionClassSubstitute {
        path: String,
        requested: Vec<String>,
        actual: String,
        near_miss_score: f64,
        touches_required: bool,
        note: String,
    },
    #[serde(rename_all = "camelCase")]
    ActorDrop {
        role: String,
        reason: String,
        touches_required: bool,
        note: String,
    },
}

impl Repair {
    pub fn touches_required(&self) -> bool {
        match self {
            Self::SpeedClamp {
                touches_required, ..
            }
            | Self::RunwayShorten {
                touches_required, ..
            }
            | Self::FeatureDistanceRelax {
                touches_required, ..
            }
            | Self::LaneOffsetClamp {
                touches_required, ..
            }
            | Self::JunctionClassSubstitute {
                touches_required, ..
            }
            | Self::ActorDrop {
                touches_required, ..
            } => *touches_required,
        }
    }

    pub fn note(&self) -> &str {
        match self {
            Self::SpeedClamp { note, .. }
            | Self::RunwayShorten { note, .. }
            | Self::FeatureDistanceRelax { note, .. }
            | Self::LaneOffsetClamp { note, .. }
            | Self::JunctionClassSubstitute { note, .. }
            | Self::ActorDrop { note, .. } => note,
        }
    }

    /// The serde tag, for compact summaries.
    pub fn kind_name(&self) -> &'static str {
        match self {
            Self::SpeedClamp { .. } => "speed_clamp",
            Self::RunwayShorten { .. } => "runway_shorten",
            Self::FeatureDistanceRelax { .. } => "feature_distance_relax",
            Self::LaneOffsetClamp { .. } => "lane_offset_clamp",
            Self::JunctionClassSubstitute { .. } => "junction_class_substitute",
            Self::ActorDrop { .. } => "actor_drop",
        }
    }

    pub fn penalty(&self) -> f64 {
        match self {
            Self::SpeedClamp { .. } => 0.97,
            Self::RunwayShorten { .. }
            | Self::FeatureDistanceRelax { .. }
            | Self::JunctionClassSubstitute { .. } => 1.0,
            Self::LaneOffsetClamp { .. } => 0.95,
            Self::ActorDrop { .. } => 0.85,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Verdict {
    Exact,
    Degraded,
    Infeasible,
}

impl Verdict {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Exact => "exact",
            Self::Degraded => "degraded",
            Self::Infeasible => "infeasible",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DegradationReport {
    pub verdict: Verdict,
    pub score: f64,
    pub repairs: Vec<Repair>,
    pub failed_required_clauses: Vec<String>,
    pub summary: String,
    pub intent_preserved: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeatureMatch {
    pub map_feature_id: String,
    pub s: f64,
    pub kind: MFeatureKind,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchedSite {
    pub site_id: String,
    pub map_id: String,
    pub topology_digest: String,
    pub match_semantics_version: String,
    pub anchor_id: String,
    pub score: f64,
    pub frame: AnchorFrame,
    pub clauses: Vec<ClauseResult>,
    pub bindings: Vec<FeatureBinding>,
    pub feature_matches: BTreeMap<String, FeatureMatch>,
    pub degradation: DegradationReport,
    pub matched_reasons: Vec<String>,
    pub alternate_frames: usize,
}

impl MatchedSite {
    pub fn binding(&self, role: &str) -> Option<&FeatureBinding> {
        self.bindings.iter().find(|b| b.role == role)
    }

    pub fn origin_junction_id(&self) -> Option<&str> {
        self.frame.origin_junction_id()
    }

    pub fn feature_junction_id(&self, feature_id: &str) -> Option<&str> {
        self.feature_matches
            .get(feature_id)
            .and_then(|m| m.map_feature_id.strip_prefix("junction:"))
    }
}

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchStats {
    pub candidates_considered: usize,
    pub frames_built: usize,
    pub sites_scored: usize,
    pub sites_infeasible: usize,
    pub sites_below_min_score: usize,
    pub sites_dropped_by_diversity: usize,
    pub selectivity_order: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchReport {
    pub sites: Vec<MatchedSite>,
    pub rejected: Vec<MatchedSite>,
    pub stats: MatchStats,
    pub failure_summary: String,
    pub warnings: Vec<String>,
}

/// Quantization of the origin arc length for the site id, metres.
pub const S_QUANTUM_M: f64 = 0.5;

pub fn quantize_s(s: f64) -> String {
    let q = simforge_core::math::js_round(s / S_QUANTUM_M) * S_QUANTUM_M;
    let q = if q == 0.0 { 0.0 } else { q };
    format!("{q:.1}")
}

/// `sha256(anchorId|semantics|mapId|digest|originFeatureId|entryLaneRsl|quantize(s))[0..16]`.
pub fn compute_site_id(
    anchor_id: &str,
    map_id: &str,
    topology_digest: &str,
    origin_feature_id: &str,
    entry_lane_rsl: &str,
    origin_s: f64,
) -> String {
    let tuple = format!("{anchor_id}|{MATCH_SEMANTICS_VERSION}|{map_id}|{topology_digest}|{origin_feature_id}|{entry_lane_rsl}|{}", quantize_s(origin_s));
    simforge_core::hash::sha256(&tuple)[..16].to_owned()
}

/* ---------------------------------------------------------------- mirror */

pub fn flip_turn(t: TurnDirection) -> TurnDirection {
    match t {
        TurnDirection::Left => TurnDirection::Right,
        TurnDirection::Right => TurnDirection::Left,
        other => other,
    }
}

pub fn flip_side(s: Side) -> Side {
    match s {
        Side::Left => Side::Right,
        Side::Right => Side::Left,
        other => other,
    }
}

pub fn flip_relation(r: ApproachRelation) -> ApproachRelation {
    match r {
        ApproachRelation::FromLeft => ApproachRelation::FromRight,
        ApproachRelation::FromRight => ApproachRelation::FromLeft,
        other => other,
    }
}

/// Left/right-swapped copy of an anchor. Idempotent when applied twice.
pub fn mirror_anchor(anchor: &MAnchor) -> MAnchor {
    let mut out = anchor.clone();
    if let Some(c) = &mut out.corridor {
        if let Some(lc) = &mut c.lane_change_legal {
            lc.value.side = flip_side(lc.value.side);
        }
    }
    for f in &mut out.features {
        if let Some(side) = &mut f.side {
            side.value = flip_side(side.value);
        }
        if let Some(j) = &mut f.junction {
            if let Some(t) = &mut j.ego_turn {
                t.value = flip_turn(t.value);
            }
            if let Some(ca) = &mut j.conflicting_approach {
                ca.value.from = flip_relation(ca.value.from);
                ca.value.turn = flip_turn(ca.value.turn);
                ca.value.crossing_angle_deg = None;
            }
        }
    }
    out
}

/// Left/right-swapped copy of a role list (lane indices included).
pub fn mirror_roles(roles: &[MRole]) -> Vec<MRole> {
    roles
        .iter()
        .map(|r| {
            let mut out = r.clone();
            match &mut out.kind {
                MRoleKind::LaneOffset { k, .. } => *k = -*k,
                MRoleKind::RelativeTo { d_lane, .. } => *d_lane = -*d_lane,
                MRoleKind::ConflictingGate { from, turn, .. } => {
                    *from = flip_relation(*from);
                    *turn = flip_turn(*turn);
                }
                MRoleKind::OnCrossing { direction, .. } => {
                    *direction = match direction {
                        MCrossingDirection::LeftToRight => MCrossingDirection::RightToLeft,
                        MCrossingDirection::RightToLeft => MCrossingDirection::LeftToRight,
                    }
                }
                MRoleKind::InParkingZone { side, .. } => {
                    *side = match side {
                        MParkingSide::Left => MParkingSide::Right,
                        MParkingSide::Right => MParkingSide::Left,
                    }
                }
                MRoleKind::OnReference { .. }
                | MRoleKind::AtLaneDrop { .. }
                | MRoleKind::Opposing { .. } => {}
            }
            out
        })
        .collect()
}

pub fn round2(v: f64) -> f64 {
    simforge_core::math::js_round(v * 100.0) / 100.0
}
