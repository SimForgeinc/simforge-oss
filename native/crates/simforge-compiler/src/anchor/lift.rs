//! Reverse materialization: map-bound scene roles and routes into portable v2 intent.
//!
//! The lift deliberately keeps concrete source facts in [`MatchedSite`].  The
//! returned template contains only frame-relative/relational placement and its
//! anchor clauses rank, rather than reproduce, the source cross-section.

use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;

use super::frame::{build_corridor_frame, build_junction_frames, CorridorFrameOptions, JunctionFrameOptions};
use super::{
    compute_site_id, AnchorFrame, BindingStatus, DegradationReport, FeatureBinding, FeatureMatch,
    MFeatureKind, MatchedSite, OriginKind, SitePose, Verdict, MATCH_SEMANTICS_VERSION,
};
use crate::expr::NumberOrExpr;
use crate::geometry::{angle_diff, heading_at_s, project_point};
use crate::map_index::DerivedMapIndex;
use crate::template::{
    AnchorFeature, AnchorPolicy, Clause, Corridor, Diversity, Essentiality, FeatureBase, FeatureKind,
    FramePose, LogicalAnchor, OnMissing, PortablePolylinePoint, Range, RigidOffsetM, RoleBinding,
    RoleKind, RouteTarget, ScenarioTemplate, TFrac, Verb,
};

const MIN_FRAME_REACH_M: f64 = 150.0;
const MAX_FRAME_REACH_M: f64 = 1200.0;
const ROUTE_CONVERSION_EXACT_M: f64 = 0.5;
const CONTENT_RUNWAY_MARGIN_M: f64 = 20.0;
const STRUCTURAL_COUNT_WEIGHT: f64 = 0.4;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PortableLiftIssueCode {
    ReferenceRoleMissing,
    ReferenceLaneAnchorMissing,
    ReferenceLaneMissing,
    SourceFrameUnbuildable,
    InternalLaneAmbiguous,
    TerminalLaneUnconnected,
    RoleLaneAnchorMissing,
    RoleLaneMissing,
    RoleProjectionTooFar,
    RoleBindingAmbiguous,
    SpatialExtensionRemoved,
    RouteProjectionError,
    CandidateNotEquivalent,
    SignalPlanTransferRequired,
}

impl PortableLiftIssueCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ReferenceRoleMissing => "reference_role_missing",
            Self::ReferenceLaneAnchorMissing => "reference_lane_anchor_missing",
            Self::ReferenceLaneMissing => "reference_lane_missing",
            Self::SourceFrameUnbuildable => "source_frame_unbuildable",
            Self::InternalLaneAmbiguous => "internal_lane_ambiguous",
            Self::TerminalLaneUnconnected => "terminal_lane_unconnected",
            Self::RoleLaneAnchorMissing => "role_lane_anchor_missing",
            Self::RoleLaneMissing => "role_lane_missing",
            Self::RoleProjectionTooFar => "role_projection_too_far",
            Self::RoleBindingAmbiguous => "role_binding_ambiguous",
            Self::SpatialExtensionRemoved => "spatial_extension_removed",
            Self::RouteProjectionError => "route_projection_error",
            Self::CandidateNotEquivalent => "candidate_not_equivalent",
            Self::SignalPlanTransferRequired => "signal_plan_transfer_required",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PortableLiftSeverity { Error, Warning, Info }

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableLiftIssue {
    pub code: PortableLiftIssueCode,
    pub severity: PortableLiftSeverity,
    pub path: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dependency: Option<String>,
    pub retryable: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum LiftOrigin { #[default] Auto, Junction, Corridor }

#[derive(Debug, Clone)]
pub struct PortableLiftOptions {
    pub reference_role_id: Option<String>,
    pub origin: LiftOrigin,
    pub allow_mirror: bool,
    pub max_projection_distance_m: f64,
    pub corridor_extent_m: Option<f64>,
    pub max_route_projection_error_m: Option<f64>,
}

impl Default for PortableLiftOptions {
    fn default() -> Self {
        Self {
            reference_role_id: None,
            origin: LiftOrigin::Auto,
            allow_mirror: true,
            max_projection_distance_m: 20.0,
            corridor_extent_m: None,
            max_route_projection_error_m: None,
        }
    }
}

/// Informational source evidence. It is never fed back into candidate rejection.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableSourceSignature {
    pub through_lanes_same_dir: usize,
    pub through_lanes_opposing: usize,
    pub origin_kind: OriginKind,
    pub ego_turn: Option<crate::template::TurnDirection>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableLiftResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub template: Option<ScenarioTemplate>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_site: Option<MatchedSite>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_signature: Option<PortableSourceSignature>,
    pub issues: Vec<PortableLiftIssue>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoundVariation {
    pub template: ScenarioTemplate,
    pub site: MatchedSite,
    pub issues: Vec<PortableLiftIssue>,
}

fn issue(code: PortableLiftIssueCode, severity: PortableLiftSeverity, path: impl Into<String>, message: impl Into<String>, dependency: impl Into<String>, retryable: bool) -> PortableLiftIssue {
    PortableLiftIssue { code, severity, path: path.into(), message: message.into(), dependency: Some(dependency.into()), retryable }
}

fn failed(issues: Vec<PortableLiftIssue>) -> PortableLiftResult {
    PortableLiftResult { ok: false, template: None, source_site: None, source_signature: None, issues }
}

fn round(value: f64, places: i32) -> f64 {
    let scale = 10_f64.powi(places);
    (value * scale).round() / scale
}
const SPATIAL_EXTENSION_KEYS: &[&str] = &[
    "position", "scenePosition", "worldPosition", "laneRef", "roadId", "laneId",
    "rsl", "routeLaneChain", "mapFeatureId", "siteId", "topologyDigest",
];

fn sanitize_extensions(value: &mut serde_json::Map<String, serde_json::Value>) {
    value.retain(|key, _| !SPATIAL_EXTENSION_KEYS.contains(&key.as_str()));
    for child in value.values_mut() {
        match child {
            serde_json::Value::Object(object) => sanitize_extensions(object),
            serde_json::Value::Array(items) => {
                for item in items {
                    if let serde_json::Value::Object(object) = item {
                        sanitize_extensions(object);
                    }
                }
            }
            _ => {}
        }
    }
}


fn scene_role(role: &RoleBinding) -> Option<(&crate::template::ScenePose, Option<&crate::template::V1LaneRef>)> {
    match &role.kind { RoleKind::SceneAbsolute { pose, lane_ref, .. } => Some((pose, lane_ref.as_ref())), _ => None }
}

fn scene_xy(role: &RoleBinding) -> Option<crate::geometry::Point2> {
    let (pose, _) = scene_role(role)?;
    Some(crate::geometry::Point2 { x: pose.position.x, y: -pose.position.z })
}

fn rsl(role: &RoleBinding) -> Option<String> { scene_role(role)?.1.map(|lane| lane.rsl()) }

#[derive(Debug, Clone, Copy)]
struct Projection { s: f64, lateral_m: f64, lane_width_m: f64, heading_rad: f64, distance_m: f64 }

fn project_to_frame(point: crate::geometry::Point2, frame: &AnchorFrame, index: &DerivedMapIndex) -> Option<Projection> {
    let mut best: Option<Projection> = None;
    for span in &frame.reference_path {
        let Some(lane) = index.lane(&span.lane_rsl) else { continue };
        let p = project_point(&lane.polyline, point);
        let candidate = Projection {
            s: span.s_start + p.s,
            lateral_m: f64::from(p.side) * p.distance,
            lane_width_m: if lane.representative_width_m > 0.0 { lane.representative_width_m } else { 3.5 },
            heading_rad: heading_at_s(&lane.polyline, p.s),
            distance_m: p.distance,
        };
        if best.is_none_or(|old| candidate.distance_m < old.distance_m) { best = Some(candidate); }
    }
    best
}

fn frame_pose(role: &RoleBinding, projection: Projection) -> FramePose {
    let heading = scene_role(role).map_or(0.0, |(pose, _)| pose.heading_rad);
    FramePose {
        lane_offset: 0,
        s: NumberOrExpr::Number(round(projection.s, 6)),
        t_frac: TFrac::Number(round((projection.lateral_m / projection.lane_width_m).clamp(-1.0, 1.0), 6)),
        heading_offset_rad: round(angle_diff(heading, projection.heading_rad), 6),
    }
}

fn route_points(template: &ScenarioTemplate, actor: &str) -> Vec<crate::geometry::Point2> {
    let mut out = Vec::new();
    for it in &template.choreography.interactions {
        if it.base.actor != actor { continue; }
        let Verb::Route { target } = &it.verb else { continue };
        match target {
            RouteTarget::CustomRoute { points } => out.extend(points.iter().map(|p| crate::geometry::Point2 { x: p.x, y: -p.z })),
            RouteTarget::CustomTimedRoute { points } => out.extend(points.iter().map(|p| crate::geometry::Point2 { x: p.x, y: -p.z })),
            _ => {}
        }
    }
    out
}
fn authored_route_turn(template: &ScenarioTemplate, actor: &str) -> Option<crate::template::TurnDirection> {
    for interaction in &template.choreography.interactions {
        if interaction.base.actor != actor {
            continue;
        }
        let Verb::Route { target } = &interaction.verb else { continue };
        match target {
            RouteTarget::Turn { turn, .. } => return Some(*turn),
            RouteTarget::NextJunction { turn } => return Some(match turn {
                crate::template::NextJunctionTurn::Straight => crate::template::TurnDirection::Straight,
                crate::template::NextJunctionTurn::Left => crate::template::TurnDirection::Left,
                crate::template::NextJunctionTurn::Right => crate::template::TurnDirection::Right,
            }),
            _ => {}
        }
    }
    None
}


fn frame_reach(template: &ScenarioTemplate, reference: &RoleBinding) -> f64 {
    let Some(origin) = scene_xy(reference) else { return MIN_FRAME_REACH_M };
    let mut furthest: f64 = 0.0;
    for role in &template.roles { if let Some(p) = scene_xy(role) { furthest = furthest.max((p - origin).length()); } }
    for it in &template.choreography.interactions {
        if let Verb::Route { target } = &it.verb {
            match target {
                RouteTarget::CustomRoute { points } => for p in points { furthest = furthest.max((crate::geometry::Point2 { x: p.x, y: -p.z } - origin).length()); },
                RouteTarget::CustomTimedRoute { points } => for p in points { furthest = furthest.max((crate::geometry::Point2 { x: p.x, y: -p.z } - origin).length()); },
                _ => {}
            }
        }
    }
    (furthest * 1.25 + 30.0).clamp(MIN_FRAME_REACH_M, MAX_FRAME_REACH_M)
}

enum ApproachResolution { Resolved(String, Option<crate::template::TurnDirection>), Ambiguous(Vec<String>), Unconnected }

fn resolve_approach(source: &str, index: &DerivedMapIndex) -> ApproachResolution {
    if index.fact_index.segment_ids_by_lane.contains_key(source) || index.gates.iter().any(|g| g.approach_lane_rsl == source) {
        return ApproachResolution::Resolved(source.to_owned(), None);
    }
    let mut internal: Vec<_> = index.gates.iter().filter(|g| g.connecting_lane_rsl == source || g.exit_lane_rsls.iter().any(|r| r == source)).collect();
    internal.sort_by(|a,b| a.approach_lane_rsl.cmp(&b.approach_lane_rsl).then(a.turn_relation.cmp(&b.turn_relation)));
    internal.dedup_by(|a,b| a.approach_lane_rsl == b.approach_lane_rsl && a.turn_relation == b.turn_relation);
    if internal.len() == 1 { return ApproachResolution::Resolved(internal[0].approach_lane_rsl.clone(), Some(internal[0].turn_relation)); }
    if internal.len() > 1 { return ApproachResolution::Ambiguous(internal.iter().map(|g| format!("{} ({})", g.approach_lane_rsl, g.turn_relation.as_str())).collect()); }
    let mut frontier = vec![source.to_owned()];
    let mut seen = BTreeSet::from([source.to_owned()]);
    for _ in 0..12 {
        let mut next = BTreeSet::new();
        let mut matches = BTreeSet::new();
        for lane_rsl in &frontier {
            let Some(lane) = index.lane(lane_rsl) else { continue };
            for neighbor in lane.predecessors.iter().chain(&lane.successors) {
                if !seen.insert(neighbor.clone()) { continue; }
                next.insert(neighbor.clone());
                if index.fact_index.segment_ids_by_lane.contains_key(neighbor) || index.gates.iter().any(|g| g.approach_lane_rsl == *neighbor) { matches.insert(neighbor.clone()); }
            }
        }
        if matches.len() == 1 { return ApproachResolution::Resolved(matches.into_iter().next().unwrap(), None); }
        if matches.len() > 1 { return ApproachResolution::Ambiguous(matches.into_iter().collect()); }
        frontier = next.into_iter().collect();
        if frontier.is_empty() { break; }
    }
    ApproachResolution::Unconnected
}

fn find_frame(template: &ScenarioTemplate, reference: &RoleBinding, index: &DerivedMapIndex, options: &PortableLiftOptions, issues: &mut Vec<PortableLiftIssue>) -> Option<AnchorFrame> {
    let source = rsl(reference)?;
    let (approach, inferred_turn) = match resolve_approach(&source, index) {
        ApproachResolution::Resolved(r, t) => (r, t),
        ApproachResolution::Ambiguous(candidates) => {
            issues.push(issue(PortableLiftIssueCode::InternalLaneAmbiguous, PortableLiftSeverity::Error, format!("roles.{}.laneRef", reference.id()), format!("lane {source} reaches multiple structural approaches: {}", candidates.join(", ")), "move the reference actor onto an unambiguous approach lane or author an explicit turn", true));
            return None;
        }
        ApproachResolution::Unconnected => {
            issues.push(issue(PortableLiftIssueCode::TerminalLaneUnconnected, PortableLiftSeverity::Error, format!("roles.{}.laneRef", reference.id()), format!("lane {source} has no deterministically connected corridor or junction approach"), "extend topology connectivity or re-snap the actor to a connected driving lane", true));
            return None;
        }
    };
    let reach = options.corridor_extent_m.unwrap_or_else(|| frame_reach(template, reference));
    if options.origin != LiftOrigin::Corridor {
        let mut junctions: Vec<String> = index.gates.iter().filter(|g| g.approach_lane_rsl == approach).map(|g| g.junction_id.clone()).collect();
        junctions.sort(); junctions.dedup();
        let authored = route_points(template, reference.id());
        let mut best: Option<(AnchorFrame, bool, f64)> = None;
        for junction in junctions {
            let frames = build_junction_frames(index, &junction, &approach, &JunctionFrameOptions {
                ego_turn: authored_route_turn(template, reference.id()).or(inferred_turn),
                runway_upstream_m: Some(reach), runway_downstream_m: Some(reach),
                anchor_feature_id: "transferOrigin".into(), mirrored: false,
                prefer_path: authored.clone(),
            });
            for frame in frames {
                let contains = frame.reference_path.iter().any(|s| s.lane_rsl == source);
                let misfit = authored.iter().filter_map(|p| project_to_frame(*p, &frame, index)).map(|p| p.distance_m).fold(0.0, f64::max);
                if best.as_ref().is_none_or(|(_, old_contains, old_misfit)| (contains && !*old_contains) || (contains == *old_contains && misfit < *old_misfit)) { best = Some((frame, contains, misfit)); }
            }
        }
        if let Some((frame, _, _)) = best { return Some(frame); }
        if options.origin == LiftOrigin::Junction { return None; }
    }
    let segment = index.fact_index.segment_ids_by_lane.get(&approach)?;
    build_corridor_frame(index, segment, &CorridorFrameOptions { anchor_feature_id: "transferOrigin".into(), runway_downstream_m: Some(reach.max(240.0)), mirrored: false })
}

fn preferred_range(value: Range, floor: f64, open_high: bool) -> Clause<Range> {
    Clause { value: Range(Some((value.0.unwrap_or(0.0) - 1.0).max(floor)), if open_high { None } else { Some(value.1.unwrap_or(0.0) + 1.0) }), essentiality: Essentiality::Preferred, weight: Some(STRUCTURAL_COUNT_WEIGHT) }
}

fn source_anchor(frame: &AnchorFrame, extent: (f64, f64), options: &PortableLiftOptions) -> LogicalAnchor {
    let same = frame.lateral_lanes.len().max(1) as f64;
    let opposing = frame.opposing_lanes.len() as f64;
    let corridor = Corridor {
        through_lanes_same_dir: Some(preferred_range(Range(Some(same), Some(same)), 1.0, true)),
        through_lanes_opposing: Some(preferred_range(Range(Some(opposing), Some(opposing)), 0.0, false)),
        runway_upstream_m: Some(Clause { value: Range(Some(extent.0), None), essentiality: Essentiality::Preferred, weight: None }),
        runway_downstream_m: Some(Clause { value: Range(Some(extent.1), None), essentiality: Essentiality::Preferred, weight: None }),
        ..Default::default()
    };
    let features = if frame.origin.kind == OriginKind::Junction {
        vec![AnchorFeature {
            base: FeatureBase { id: "transferOrigin".into(), at_m: Some(Clause { value: Range(Some(0.0), Some(0.0)), essentiality: Essentiality::Required, weight: None }), lateral_distance_m: None, same_road: None, side: None, essentiality: Essentiality::Required, weight: None, label: None },
            kind: FeatureKind::Junction { arms: None, control: None, ego_turn: frame.ego_turn.map(|turn| Clause { value: vec![turn], essentiality: Essentiality::Required, weight: None }), conflicting_approach: None, size_m: None, has_crossing_on_leg: None },
            simple_kind: None, length_m: None, supports_scenario: None,
        }]
    } else { Vec::new() };
    LogicalAnchor { id: Some("transfer".into()), corridor: Some(corridor), features, policy: AnchorPolicy { allow_mirror: options.allow_mirror, max_sites_per_map: 10, diversity: Diversity::Strict, min_score: 0.5 }, pin: None }
}

fn convert_routes(template: &mut ScenarioTemplate, source_roles: &BTreeMap<String, (crate::geometry::Point2, f64)>, frame: &AnchorFrame, index: &DerivedMapIndex, ceiling: Option<f64>, issues: &mut Vec<PortableLiftIssue>) -> Vec<f64> {
    let mut stations = Vec::new();
    for (i, interaction) in template.choreography.interactions.iter_mut().enumerate() {
        let Verb::Route { target } = &mut interaction.verb else { continue };
        let (raw, timed): (Vec<(f64,f64,Option<f64>)>, bool) = match target {
            RouteTarget::CustomRoute { points } => (points.iter().map(|p| (p.x,p.z,None)).collect(), false),
            RouteTarget::CustomTimedRoute { points } => (points.iter().map(|p| (p.x,p.z,Some(p.time_s))).collect(), true),
            RouteTarget::LanePath { lanes } => {
                issues.push(issue(
                    PortableLiftIssueCode::SpatialExtensionRemoved,
                    PortableLiftSeverity::Error,
                    format!("choreography.interactions.{i}.target"),
                    format!("concrete lane path {} cannot be carried to another map", lanes.join(">")),
                    "re-author this route as turn intent or a portable polyline",
                    true,
                ));
                continue;
            }
            _ => continue,
        };
        let Some((origin, heading)) = source_roles.get(&interaction.base.actor).copied() else {
            issues.push(issue(PortableLiftIssueCode::SpatialExtensionRemoved, PortableLiftSeverity::Error, format!("choreography.interactions.{i}.target"), format!("world-space custom route has no scene-posed actor \"{}\" to anchor its shape to", interaction.base.actor), "re-author this route as an actor-relative polyline before transferring", true));
            continue;
        };
        let forward = crate::geometry::Point2 { x: heading.cos(), y: heading.sin() };
        let mut offsets = Vec::with_capacity(raw.len());
        let mut corridor_max: f64 = 0.0;
        let mut worst = 0;
        let mut sum = 0.0;
        let mut anchor_error: f64 = 0.0;
        for (j, (x,z,time_s)) in raw.iter().copied().enumerate() {
            let scene = crate::geometry::Point2 { x, y: -z };
            let Some(projected) = project_to_frame(scene, frame, index) else { continue };
            stations.push(projected.s);
            if projected.distance_m > corridor_max { corridor_max = projected.distance_m; worst = j; }
            sum += projected.distance_m;
            let delta = scene - origin;
            let along = round(delta.x * forward.x + delta.y * forward.y, 4);
            let across = round(-delta.x * forward.y + delta.y * forward.x, 4);
            let reconstructed = origin + crate::geometry::Point2 { x: forward.x * along - forward.y * across, y: forward.y * along + forward.x * across };
            anchor_error = anchor_error.max((reconstructed - scene).length());
            offsets.push(PortablePolylinePoint { along_m: along, across_m: across, time_s });
        }
        if offsets.len() != raw.len() || offsets.is_empty() || ceiling.is_some_and(|limit| corridor_max > limit) {
            issues.push(issue(PortableLiftIssueCode::SpatialExtensionRemoved, PortableLiftSeverity::Error, format!("choreography.interactions.{i}.target"), if let Some(limit) = ceiling { format!("world-space custom route point {worst} lies {} m off the anchor frame's reference path (limit {limit} m)", round(corridor_max,3)) } else { "world-space custom route could not be projected onto the source anchor frame".into() }, "re-author this route as an actor-relative polyline before transferring", true));
            continue;
        }
        if anchor_error > ROUTE_CONVERSION_EXACT_M {
            issues.push(issue(PortableLiftIssueCode::RouteProjectionError, PortableLiftSeverity::Error, format!("choreography.interactions.{i}.target"), format!("actor-anchored route conversion is not rigid: worst vertex moved {} m", round(anchor_error,4)), "report this as a defect in the actor-anchored route conversion", false));
        } else if corridor_max > ROUTE_CONVERSION_EXACT_M {
            issues.push(issue(PortableLiftIssueCode::RouteProjectionError, PortableLiftSeverity::Warning, format!("choreography.interactions.{i}.target"), format!("world-space custom route carried rigidly; vertices run up to {} m off the anchor frame (mean {} m, worst point {worst})", round(corridor_max,3), round(sum / raw.len() as f64,3)), "accept the reported off-corridor distance, or redraw this route closer to the reference corridor", true));
        }
        *target = RouteTarget::ActorPolyline { points: offsets, join_from_current_pose: (!timed && raw.len() > 1).then_some(true), best_effort_world_path: Some(true) };
    }
    stations
}

/// Lift a parsed map-bound v2 document into a portable structural template.
pub fn lift_map_bound_template(template: &ScenarioTemplate, index: &DerivedMapIndex, options: &PortableLiftOptions) -> PortableLiftResult {
    let mut issues = Vec::new();
    let absolute: Vec<&RoleBinding> = template.roles.iter().filter(|r| matches!(r.kind, RoleKind::SceneAbsolute { .. })).collect();
    let reference_id = options.reference_role_id.as_deref().or(template.metric_subject.as_deref()).or_else(|| absolute.first().map(|r| r.id()));
    let Some(reference_id) = reference_id else {
        issues.push(issue(
            PortableLiftIssueCode::ReferenceRoleMissing,
            PortableLiftSeverity::Error,
            "roles",
            "the document has no scene_absolute role to lift from, so there is nothing to anchor the portable frame to",
            "choose a scene_absolute reference actor",
            true,
        ));
        return failed(issues);
    };
    let Some(reference) = absolute.iter().copied().find(|role| role.id() == reference_id) else {
        let message = if template.role(reference_id).is_some() {
            format!("reference role \"{reference_id}\" is already portable, not scene_absolute")
        } else {
            format!("reference role \"{reference_id}\" is absent")
        };
        issues.push(issue(
            PortableLiftIssueCode::ReferenceRoleMissing,
            PortableLiftSeverity::Error,
            "roles",
            message,
            "choose a scene_absolute reference actor",
            true,
        ));
        return failed(issues);
    };
    let Some(reference_rsl) = rsl(reference) else {
        issues.push(issue(PortableLiftIssueCode::ReferenceLaneAnchorMissing, PortableLiftSeverity::Error, format!("roles.{}.laneRef", reference.id()), "reference actor has no lane anchor", "snap the reference actor to a driving lane and save its laneRef", true));
        return failed(issues);
    };
    if index.lane(&reference_rsl).is_none() {
        issues.push(issue(PortableLiftIssueCode::ReferenceLaneMissing, PortableLiftSeverity::Error, format!("roles.{}.laneRef", reference.id()), format!("lane {reference_rsl} is absent from the current topology"), "reload the matching map topology or re-snap the actor", true));
        return failed(issues);
    }
    let Some(frame) = find_frame(template, reference, index, options, &mut issues) else {
        if !issues.iter().any(|i| matches!(i.code, PortableLiftIssueCode::InternalLaneAmbiguous | PortableLiftIssueCode::TerminalLaneUnconnected)) {
            issues.push(issue(PortableLiftIssueCode::SourceFrameUnbuildable, PortableLiftSeverity::Error, "anchor", "no connected corridor or junction frame could be built from the reference approach", "derive connected segments/gates for the reference lane or choose another reference actor", true));
        }
        return failed(issues);
    };
    let reference_projection = project_to_frame(scene_xy(reference).unwrap(), &frame, index).expect("frame has source lane");
    let mut lifted_roles = Vec::with_capacity(template.roles.len());
    let mut bindings = Vec::new();
    let mut source_roles = BTreeMap::new();
    for role in &template.roles {
        let Some((scene_pose, lane_ref)) = scene_role(role) else { lifted_roles.push(role.clone()); continue };
        let Some(point) = scene_xy(role) else { continue };
        source_roles.insert(role.id().to_owned(), (point, scene_pose.heading_rad));
        let Some(projection) = project_to_frame(point, &frame, index) else {
            issues.push(issue(PortableLiftIssueCode::RoleProjectionTooFar, PortableLiftSeverity::Error, format!("roles.{}.pose", role.id()), "actor could not be projected into the source anchor frame", "extend the source frame route or choose a closer reference actor", true));
            continue;
        };
        if projection.distance_m > options.max_projection_distance_m {
            issues.push(issue(PortableLiftIssueCode::RoleProjectionTooFar, PortableLiftSeverity::Warning, format!("roles.{}.pose", role.id()), format!("actor is {} m from the reference path; using a semantic relative binding", round(projection.distance_m,2)), "provide a semantic feature binding for a stronger transfer", true));
        }
        let role_rsl = lane_ref.map(|l| l.rsl());
        if role_rsl.is_none() {
            issues.push(issue(PortableLiftIssueCode::RoleLaneAnchorMissing, PortableLiftSeverity::Warning, format!("roles.{}.laneRef", role.id()), "actor has no lane anchor; inferred relative to the reference actor", "snap this actor to a lane for a topology-aware transfer", true));
        } else if index.lane(role_rsl.as_deref().unwrap()).is_none() {
            issues.push(issue(PortableLiftIssueCode::RoleLaneMissing, PortableLiftSeverity::Warning, format!("roles.{}.laneRef", role.id()), format!("lane {} is absent; inferred relative to the reference actor", role_rsl.as_deref().unwrap()), "re-snap this actor against the current topology", true));
        }
        let pose = frame_pose(role, projection);
        let kind = if role.id() == reference.id() || role_rsl.as_ref().is_some_and(|r| frame.reference_path.iter().any(|s| &s.lane_rsl == r)) {
            RoleKind::OnReference { pose: pose.clone() }
        } else if let Some((k, _)) = role_rsl.as_ref().and_then(|r| frame.lateral_lanes.iter().find(|(_, lane)| *lane == r)) {
            RoleKind::LaneOffset { k: *k, on_missing: if role.base.essentiality == Essentiality::Required { OnMissing::Fail } else { OnMissing::Clamp }, pose: FramePose { lane_offset: *k, ..pose.clone() } }
        } else if let Some(k) = role_rsl.as_ref().and_then(|r| frame.opposing_lanes.iter().position(|lane| lane == r)) {
            RoleKind::Opposing { k: k as i32, pose: pose.clone() }
        } else {
            let reference_point = scene_xy(reference).unwrap();
            let forward = crate::geometry::Point2 { x: scene_role(reference).unwrap().0.heading_rad.cos(), y: scene_role(reference).unwrap().0.heading_rad.sin() };
            let delta = point - reference_point;
            let relative_s = projection.s - reference_projection.s;
            let relative_t = projection.lateral_m / projection.lane_width_m - reference_projection.lateral_m / reference_projection.lane_width_m;
            // `rigidOffsetM` owns placement, so `tFrac` is informational here; it is
            // still clamped to the schema's ±1 bound (as `frame_pose` does) so the
            // portable template parses. The raw fraction can be several lanes wide.
            issues.push(issue(PortableLiftIssueCode::RoleBindingAmbiguous, PortableLiftSeverity::Warning, format!("roles.{}", role.id()), "actor is outside the source frame cross-section; its formation is carried as a rigid pair", "add a semantic crossing, parking-zone, or junction movement association", true));
            RoleKind::RelativeTo { r#ref: reference.id().to_owned(), d_lane: relative_t.round().clamp(-8.0,8.0) as i32, ds_m: NumberOrExpr::Number(round(relative_s,6)), t_frac: round((projection.lateral_m / projection.lane_width_m).clamp(-1.0, 1.0),6), heading_offset_rad: round(angle_diff(scene_pose.heading_rad, scene_role(reference).unwrap().0.heading_rad),6), rigid_offset_m: Some(RigidOffsetM { along_m: round(delta.x * forward.x + delta.y * forward.y,4), across_m: round(-delta.x * forward.y + delta.y * forward.x,4) }) }
        };
        let mut binding = FeatureBinding::new(role.id(), kind.name());
        binding.status = BindingStatus::Bound;
        binding.pose = Some(SitePose { k: pose.lane_offset, s: projection.s, t_frac: projection.lateral_m / projection.lane_width_m, heading_offset_rad: pose.heading_offset_rad });
        binding.lane_rsl = role_rsl.filter(|r| index.lane(r).is_some());
        bindings.push(binding);
        let mut base = role.base.clone();
        if let Some(extensions) = &mut base.extensions {
            sanitize_extensions(extensions);
        }
        lifted_roles.push(RoleBinding { base, kind });
    }
    if issues.iter().any(|i| i.severity == PortableLiftSeverity::Error) { return failed(issues); }
    if let Some(root) = lifted_roles.iter().position(|r| r.id() == reference.id()) { lifted_roles.rotate_left(root); }
    let mut lifted = template.clone();
    lifted.roles = lifted_roles;
    lifted.anchor.pin = None;
    if let Some(extensions) = &mut lifted.extensions {
        sanitize_extensions(extensions);
    }
    for role in &mut lifted.roles {
        if let Some(extensions) = &mut role.base.extensions {
            sanitize_extensions(extensions);
        }
    }
    if !lifted.map_signal_plans.is_empty() {
        let count = lifted.map_signal_plans.len();
        lifted.map_signal_plans.clear();
        issues.push(issue(
            PortableLiftIssueCode::SignalPlanTransferRequired,
            PortableLiftSeverity::Warning,
            "mapSignalPlans",
            format!("{count} source map signal plan(s) cannot be carried verbatim to another map and were removed from the portable template"),
            "compute a target-junction proposal outside the compiler, then record a human signalPlanDecision of remove or accept-proposal",
            true,
        ));
    }
    let route_stations = convert_routes(&mut lifted, &source_roles, &frame, index, options.max_route_projection_error_m, &mut issues);
    let mut stations = vec![0.0];
    stations.extend(route_stations);
    for role in &lifted.roles { if let Some(pose) = role.pose() { if let NumberOrExpr::Number(s) = pose.s { stations.push(s); } } }
    let upstream = round(stations.iter().copied().fold(0.0, f64::min).abs() + CONTENT_RUNWAY_MARGIN_M,2);
    let downstream = round(stations.iter().copied().fold(0.0, f64::max) + CONTENT_RUNWAY_MARGIN_M,2);
    lifted.anchor = source_anchor(&frame, (upstream, downstream), options);
    if issues.iter().any(|i| i.severity == PortableLiftSeverity::Error) {
        return PortableLiftResult { ok: false, template: None, source_site: None, source_signature: None, issues };
    }
    let anchor_id = lifted.anchor.id.as_deref().unwrap_or("transfer");
    let mut feature_matches = BTreeMap::new();
    if frame.origin.kind == OriginKind::Junction { feature_matches.insert("transferOrigin".into(), FeatureMatch { map_feature_id: frame.origin.map_feature_id.clone(), s: 0.0, kind: MFeatureKind::Junction }); }
    let source_site = MatchedSite {
        site_id: compute_site_id(anchor_id, &index.map_id, &index.topology_digest, &frame.origin.map_feature_id, &frame.entry_lane_rsl, 0.0),
        map_id: index.map_id.clone(), topology_digest: index.topology_digest.clone(), match_semantics_version: MATCH_SEMANTICS_VERSION.into(), anchor_id: anchor_id.into(), score: 1.0,
        frame: frame.clone(), clauses: vec![], bindings, feature_matches,
        degradation: DegradationReport { verdict: Verdict::Exact, score: 1.0, repairs: vec![], failed_required_clauses: vec![], summary: "source authoring site lifted exactly".into(), intent_preserved: true },
        matched_reasons: vec!["lifted from scene_absolute lane anchors".into()], alternate_frames: 0,
    };
    let source_signature = PortableSourceSignature { through_lanes_same_dir: frame.lateral_lanes.len().max(1), through_lanes_opposing: frame.opposing_lanes.len(), origin_kind: frame.origin.kind, ego_turn: frame.ego_turn };
    PortableLiftResult { ok: true, template: Some(lifted), source_site: Some(source_site), source_signature: Some(source_signature), issues }
}

/// Pair a portable canonical template with one destination candidate.
pub fn bind_portable_variation(template: &ScenarioTemplate, site: &MatchedSite) -> Result<BoundVariation, PortableLiftIssue> {
    if !template.is_portable() {
        return Err(issue(PortableLiftIssueCode::CandidateNotEquivalent, PortableLiftSeverity::Error, "roles", "bind_portable_variation requires a lifted portable template", "lift the map-bound template before binding a destination", false));
    }
    if !site.degradation.intent_preserved || site.degradation.verdict == Verdict::Infeasible {
        return Err(issue(PortableLiftIssueCode::CandidateNotEquivalent, PortableLiftSeverity::Error, "site", format!("candidate {} does not preserve required scenario intent", site.site_id), "choose a candidate whose required clauses and roles are preserved", true));
    }
    let mut canonical = template.clone();
    canonical.anchor.pin = None;
    Ok(BoundVariation { template: canonical, site: site.clone(), issues: Vec::new() })
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use simforge_core::map::TopologyIndex;

    use super::*;
    use crate::anchor::adapt::adapt_template;
    use crate::anchor::matcher::{match_anchor, MatchOptions};
    use crate::map_index::{derive_map_index, DeriveOptions, Handedness, RawTopology};

    fn lane(rsl: &str, road_id: i64, lane_id: i64, _y: f64, polyline: serde_json::Value) -> serde_json::Value {
        json!({
            "rsl": rsl, "roadId": road_id, "section": 0, "laneId": lane_id,
            "laneType": "driving", "predecessors": [], "successors": [],
            "speedLimitKph": 50, "representativeWidthM": 3.5,
            "polyline": polyline, "isJunction": false
        })
    }

    fn index_with_lanes(lanes: serde_json::Map<String, serde_json::Value>) -> DerivedMapIndex {
        let topology: TopologyIndex = serde_json::from_value(json!({
            "schemaVersion": 1, "mapName": "lift-test", "source": { "xodrSha256": "lift-digest" },
            "lanes": lanes, "gates": [], "junctions": {}
        })).unwrap();
        derive_map_index(&RawTopology::from_topology(&topology), &DeriveOptions {
            map_id: "lift-test".into(), handedness: Some(Handedness::Right),
            topology_digest: Some("lift-digest".into()), ..Default::default()
        })
    }

    fn straight_index() -> DerivedMapIndex {
        let mut lanes = serde_json::Map::new();
        lanes.insert("1:0:-1".into(), lane("1:0:-1", 1, -1, 0.0, json!([[0,0],[200,0]])));
        index_with_lanes(lanes)
    }

    fn template(roles: serde_json::Value, interactions: serde_json::Value) -> ScenarioTemplate {
        let mut value: serde_json::Value = serde_json::from_str(include_str!("../../../../../examples/ltap-opposing.template.json")).unwrap();
        value["roles"] = roles;
        value["metricSubject"] = json!("ego");
        value["choreography"]["interactions"] = interactions;
        value["anchor"]["pin"] = json!({"mapId":"lift-test"});
        serde_json::from_value(value).unwrap()
    }

    fn scene_role(id: &str, x: f64, z: f64, heading: f64, lane_ref: Option<serde_json::Value>) -> serde_json::Value {
        let mut role = json!({
            "id": id, "kind": "scene_absolute", "actor": {"class":"car"},
            "essentiality": "required", "pose": {"position":{"x":x,"y":0,"z":z},"headingRad":heading}
        });
        if let Some(lane_ref) = lane_ref { role["laneRef"] = lane_ref; }
        role
    }

    fn main_lane_ref() -> serde_json::Value { json!({"roadId":"1","section":0,"laneId":-1,"s":10}) }

    #[test]
    fn map_bound_template_lifts_without_dropping_required_actor() {
        let source = template(json!([scene_role("ego", 10.0, 0.0, 0.0, Some(main_lane_ref()))]), json!([]));
        let result = lift_map_bound_template(&source, &straight_index(), &PortableLiftOptions::default());
        assert!(result.ok, "{:?}", result.issues);
        let lifted = result.template.unwrap();
        assert!(lifted.is_portable());
        assert_eq!(lifted.roles.len(), 1);
        assert!(matches!(lifted.roles[0].kind, RoleKind::OnReference { .. }));
        assert!(lifted.anchor.pin.is_none());
        assert_eq!(result.source_site.unwrap().bindings.len(), 1);
    }

    #[test]
    fn straight_world_route_becomes_actor_polyline_with_left_positive_across() {
        let source = template(
            json!([scene_role("ego", 10.0, 0.0, 0.0, Some(main_lane_ref()))]),
            json!([{"id":"route","actor":"ego","trigger":{"kind":"at","t":0},"verb":"route","target":{"mode":"customRoute","points":[{"x":20,"z":-5},{"x":30,"z":5}]}}]),
        );
        let result = lift_map_bound_template(&source, &straight_index(), &PortableLiftOptions::default());
        assert!(result.ok, "{:?}", result.issues);
        let Verb::Route { target: RouteTarget::ActorPolyline { points, join_from_current_pose, best_effort_world_path } } = &result.template.unwrap().choreography.interactions[0].verb else { panic!("route was not converted") };
        assert_eq!((points[0].along_m, points[0].across_m), (10.0, 5.0));
        assert_eq!((points[1].along_m, points[1].across_m), (20.0, -5.0));
        assert_eq!(*join_from_current_pose, Some(true));
        assert_eq!(*best_effort_world_path, Some(true));
    }

    #[test]
    fn curved_world_route_uses_actor_heading_not_corridor_normal() {
        let mut lanes = serde_json::Map::new();
        lanes.insert("1:0:-1".into(), lane("1:0:-1", 1, -1, 0.0, json!([[0,0],[20,0],[40,20],[80,60]])));
        let index = index_with_lanes(lanes);
        let heading = std::f64::consts::FRAC_PI_4;
        let along = 10.0;
        let across = 3.0;
        let x = 20.0 + heading.cos() * along - heading.sin() * across;
        let internal_y = heading.sin() * along + heading.cos() * across;
        let source = template(
            json!([scene_role("ego", 20.0, 0.0, heading, Some(main_lane_ref()))]),
            json!([{"id":"route","actor":"ego","trigger":{"kind":"at","t":0},"verb":"route","target":{"mode":"customTimedRoute","points":[{"x":x,"z":-internal_y,"timeS":2}]}}]),
        );
        let result = lift_map_bound_template(&source, &index, &PortableLiftOptions::default());
        assert!(result.ok, "{:?}", result.issues);
        let Verb::Route { target: RouteTarget::ActorPolyline { points, join_from_current_pose, .. } } = &result.template.unwrap().choreography.interactions[0].verb else { panic!("route was not converted") };
        assert!((points[0].along_m - along).abs() < 1e-4);
        assert!((points[0].across_m - across).abs() < 1e-4);
        assert_eq!(points[0].time_s, Some(2.0));
        assert_eq!(*join_from_current_pose, None);
    }

    #[test]
    fn source_signature_is_evidence_not_a_target_cross_section_requirement() {
        let mut source_lanes = serde_json::Map::new();
        source_lanes.insert("1:0:-1".into(), lane("1:0:-1", 1, -1, 0.0, json!([[0,0],[200,0]])));
        source_lanes.insert("1:0:-2".into(), lane("1:0:-2", 1, -2, 4.0, json!([[0,4],[200,4]])));
        source_lanes.insert("1:0:-3".into(), lane("1:0:-3", 1, -3, 8.0, json!([[0,8],[200,8]])));
        let source_index = index_with_lanes(source_lanes);
        let source = template(json!([scene_role("ego", 10.0, 0.0, 0.0, Some(main_lane_ref()))]), json!([]));
        let result = lift_map_bound_template(&source, &source_index, &PortableLiftOptions::default());
        assert!(result.ok, "{:?}", result.issues);
        let signature = result.source_signature.unwrap();
        assert!(signature.through_lanes_same_dir >= 2);
        let lifted = result.template.unwrap();
        let clause = lifted.anchor.corridor.as_ref().unwrap().through_lanes_same_dir.as_ref().unwrap();
        assert_eq!(clause.essentiality, Essentiality::Preferred);
        assert_eq!(clause.value.1, None, "source lane count must not impose an upper bound");
        let adapted = adapt_template(&lifted);
        let sites = match_anchor(&adapted.anchor, &straight_index(), &MatchOptions::default());
        assert!(!sites.is_empty(), "a narrower target must remain eligible");
    }

    #[test]
    fn structured_early_refusals_are_distinct() {
        let mut no_roles = template(json!([]), json!([]));
        no_roles.metric_subject = None;
        let no_roles_result = lift_map_bound_template(&no_roles, &straight_index(), &PortableLiftOptions::default());
        let no_roles_issue = &no_roles_result.issues[0];
        assert_eq!(no_roles_issue.code, PortableLiftIssueCode::ReferenceRoleMissing);
        assert_eq!(
            no_roles_issue.message,
            "the document has no scene_absolute role to lift from, so there is nothing to anchor the portable frame to"
        );
        assert!(!no_roles_issue.message.contains("\"\""));
        let absent_options = PortableLiftOptions {
            reference_role_id: Some("missing".into()),
            ..Default::default()
        };
        let absent_result = lift_map_bound_template(&no_roles, &straight_index(), &absent_options);
        let absent_issue = &absent_result.issues[0];
        assert_eq!(absent_issue.message, "reference role \"missing\" is absent");
        let mut portable = template(json!([{
            "id": "ego",
            "kind": "on_reference",
            "actor": {"class": "car"},
            "essentiality": "required",
            "pose": {"laneOffset": 0, "s": 10, "tFrac": 0, "headingOffsetRad": 0}
        }]), json!([]));
        portable.metric_subject = Some("ego".into());
        let portable_result = lift_map_bound_template(&portable, &straight_index(), &PortableLiftOptions::default());
        let portable_issue = &portable_result.issues[0];
        assert_eq!(portable_issue.message, "reference role \"ego\" is already portable, not scene_absolute");
        let no_anchor = template(json!([scene_role("ego", 10.0, 0.0, 0.0, None)]), json!([]));
        assert_eq!(lift_map_bound_template(&no_anchor, &straight_index(), &PortableLiftOptions::default()).issues[0].code, PortableLiftIssueCode::ReferenceLaneAnchorMissing);
        let missing = template(json!([scene_role("ego", 10.0, 0.0, 0.0, Some(json!({"roadId":"9","section":0,"laneId":-1,"s":10})))]), json!([]));
        assert_eq!(lift_map_bound_template(&missing, &straight_index(), &PortableLiftOptions::default()).issues[0].code, PortableLiftIssueCode::ReferenceLaneMissing);
        let corridor_only = template(json!([scene_role("ego", 10.0, 0.0, 0.0, Some(main_lane_ref()))]), json!([]));
        let options = PortableLiftOptions { origin: LiftOrigin::Junction, ..Default::default() };
        assert_eq!(lift_map_bound_template(&corridor_only, &straight_index(), &options).issues[0].code, PortableLiftIssueCode::SourceFrameUnbuildable);
    }

    #[test]
    fn role_and_route_refusals_remain_structured() {
        let source = template(
            json!([
                scene_role("ego", 10.0, 0.0, 0.0, Some(main_lane_ref())),
                scene_role("other", 10.0, -40.0, 0.0, None)
            ]),
            json!([{"id":"route","actor":"ghost","trigger":{"kind":"at","t":0},"verb":"route","target":{"mode":"customRoute","points":[{"x":20,"z":0}]}}]),
        );
        let result = lift_map_bound_template(&source, &straight_index(), &PortableLiftOptions::default());
        let codes: Vec<_> = result.issues.iter().map(|i| i.code).collect();
        assert!(codes.contains(&PortableLiftIssueCode::RoleProjectionTooFar));
        assert!(codes.contains(&PortableLiftIssueCode::RoleLaneAnchorMissing));
        assert!(codes.contains(&PortableLiftIssueCode::RoleBindingAmbiguous));
        assert!(codes.contains(&PortableLiftIssueCode::SpatialExtensionRemoved));
        assert!(!result.ok);
    }

    fn parallel_roads_topology(roads: i64) -> TopologyIndex {
        let mut lanes = serde_json::Map::new();
        for road in 1..=roads {
            let y = (road - 1) as f64 * 50.0;
            let rsl = format!("{road}:0:-1");
            lanes.insert(rsl.clone(), lane(&rsl, road, -1, y, json!([[0, y], [200, y]])));
        }
        serde_json::from_value(json!({
            "schemaVersion": 1, "mapName": "lift-test", "source": { "xodrSha256": "lift-digest" },
            "lanes": lanes, "gates": [], "junctions": {}
        })).unwrap()
    }

    fn parallel_roads_portable() -> (ScenarioTemplate, crate::bundle::MapBundle) {
        let bundle = crate::bundle::MapBundle::from_topology("lift-test", parallel_roads_topology(4)).unwrap();
        let source = template(json!([scene_role("ego", 10.0, 0.0, 0.0, Some(main_lane_ref()))]), json!([]));
        let lifted = lift_map_bound_template(&source, bundle.index(), &PortableLiftOptions::default());
        assert!(lifted.ok, "{:?}", lifted.issues);
        (lifted.template.unwrap(), bundle)
    }

    #[test]
    fn pinned_match_scores_only_the_pinned_site_and_yields_the_identical_site() {
        let (portable, bundle) = parallel_roads_portable();
        let adapted = adapt_template(&portable);
        let options = MatchOptions { roles: adapted.roles.clone(), ..Default::default() };
        let full = crate::anchor::matcher::match_anchor_report(&adapted.anchor, bundle.index(), &options);
        assert!(full.sites.len() >= 3, "fixture must offer several sites: {:?}", full.sites.len());
        let wanted = full.sites.last().unwrap().clone();

        let mut pinned_anchor = adapted.anchor.clone();
        pinned_anchor.pin = Some(crate::anchor::MPin { map_id: bundle.index().map_id.clone(), site_id: wanted.site_id.clone() });
        let pinned = crate::anchor::matcher::match_anchor_report(&pinned_anchor, bundle.index(), &options);
        assert_eq!(pinned.sites, vec![wanted.clone()]);
        assert_eq!(pinned.stats.frames_built, full.stats.frames_built, "frames are still built and capped as in a full match");
        assert!(pinned.stats.sites_scored < full.stats.sites_scored, "{} vs {}", pinned.stats.sites_scored, full.stats.sites_scored);

        let scoped = crate::anchor::matcher::match_anchor_report(
            &adapted.anchor,
            bundle.index(),
            &MatchOptions { only_site_id: Some(wanted.site_id.clone()), ..options.clone() },
        );
        assert!(scoped.sites.iter().chain(&scoped.rejected).all(|site| site.site_id == wanted.site_id));
        assert_eq!(scoped.sites, vec![wanted]);
    }

    #[test]
    fn find_site_by_id_and_compile_at_a_resolved_site_match_the_full_path() {
        use crate::materialize::{instantiate, instantiate_at_site, MaterializeOptions, SiteSelection};
        let (portable, bundle) = parallel_roads_portable();
        let full = crate::sites::match_on_map(&portable, &bundle, &crate::sites::SiteMatchOptions::default()).unwrap();
        let wanted = full.report.sites.last().unwrap().clone();

        let found = crate::sites::find_site(&portable, &bundle, SiteSelection::Id(&wanted.site_id)).unwrap();
        assert_eq!(found, wanted);

        let document = portable.to_value();
        let options = MaterializeOptions::new();
        let by_id = instantiate(&document, &bundle, SiteSelection::Id(&wanted.site_id), &options);
        let at_site = instantiate_at_site(&document, &bundle, &found, &options);
        match (by_id, at_site) {
            (Ok(a), Ok(b)) => {
                assert_eq!(serde_json::to_value(&a.manifest).unwrap(), serde_json::to_value(&b.manifest).unwrap());
                assert_eq!(serde_json::to_value(&a.input).unwrap(), serde_json::to_value(&b.input).unwrap());
            }
            (Err(a), Err(b)) => assert_eq!(a.code, b.code),
            (a, b) => panic!("paths disagree: by id ok={}, at site ok={}", a.is_ok(), b.is_ok()),
        }

        let mut foreign = found.clone();
        foreign.anchor_id = "another-template".into();
        assert_eq!(instantiate_at_site(&document, &bundle, &foreign, &options).unwrap_err().code, "site_mismatch");
        let mut pinned = portable.to_value();
        pinned["anchor"]["pin"] = json!({ "mapId": "lift-test", "siteId": full.report.sites[0].site_id });
        if full.report.sites[0].site_id != found.site_id {
            assert_eq!(instantiate_at_site(&pinned, &bundle, &found, &options).unwrap_err().code, "site_mismatch");
        }

        let unknown = crate::sites::find_site(&portable, &bundle, SiteSelection::Id("0000000000000000")).unwrap_err();
        assert_eq!(unknown.code, "unknown_site");
        let available = unknown.detail.as_ref().and_then(|d| d.get("available")).and_then(|v| v.as_array()).map_or(0, Vec::len);
        assert_eq!(available, full.report.sites.len().min(10), "the refusal still names the available sites");
    }

    #[test]
    fn rigid_pair_lateral_fraction_is_clamped_and_offset_keeps_the_true_distance() {
        // 12 m left of a 3.5 m lane: the raw fraction is ~3.4 lanes, outside the
        // schema's ±1 bound; the rigid offset keeps the exact lateral distance.
        let source = template(json!([
            scene_role("ego", 10.0, 0.0, 0.0, Some(main_lane_ref())),
            scene_role("other", 18.0, -12.0, 0.0, None)
        ]), json!([]));
        let result = lift_map_bound_template(&source, &straight_index(), &PortableLiftOptions::default());
        assert!(result.ok, "{:?}", result.issues);
        let lifted = result.template.unwrap();
        let other = lifted.roles.iter().find(|r| r.id() == "other").unwrap();
        let RoleKind::RelativeTo { t_frac, rigid_offset_m: Some(offset), .. } = &other.kind else { panic!("expected a rigid pair, got {:?}", other.kind.name()) };
        assert_eq!(*t_frac, 1.0);
        assert_eq!((offset.along_m, offset.across_m), (8.0, 12.0));
        let json = serde_json::to_value(&lifted).unwrap();
        let back: ScenarioTemplate = serde_json::from_value(json).unwrap();
        assert_eq!(back.roles.len(), 2);
    }

    #[test]
    fn role_lane_missing_is_warning_and_required_role_still_lifts() {
        let source = template(json!([
            scene_role("ego", 10.0, 0.0, 0.0, Some(main_lane_ref())),
            scene_role("other", 20.0, -4.0, 0.0, Some(json!({"roadId":"8","section":0,"laneId":-1,"s":20})))
        ]), json!([]));
        let result = lift_map_bound_template(&source, &straight_index(), &PortableLiftOptions::default());
        assert!(result.ok, "{:?}", result.issues);
        assert!(result.issues.iter().any(|i| i.code == PortableLiftIssueCode::RoleLaneMissing));
        assert_eq!(result.template.unwrap().roles.len(), 2);
    }

    #[test]
    fn ambiguous_and_unconnected_approaches_have_dedicated_codes() {
        let mut index = straight_index();
        index.fact_index.segment_ids_by_lane.remove("1:0:-1");
        index.gates = vec![
            crate::map_index::DerivedGate { id:"a".into(), junction_id:"j".into(), turn_relation:crate::template::TurnDirection::Left, heading_change_rad:0.0, approach_lane_rsl:"approach-a".into(), connecting_lane_rsl:"1:0:-1".into(), exit_lane_rsls:vec![] },
            crate::map_index::DerivedGate { id:"b".into(), junction_id:"j".into(), turn_relation:crate::template::TurnDirection::Right, heading_change_rad:0.0, approach_lane_rsl:"approach-b".into(), connecting_lane_rsl:"1:0:-1".into(), exit_lane_rsls:vec![] },
        ];
        let source = template(json!([scene_role("ego", 10.0, 0.0, 0.0, Some(main_lane_ref()))]), json!([]));
        assert_eq!(lift_map_bound_template(&source, &index, &PortableLiftOptions::default()).issues[0].code, PortableLiftIssueCode::InternalLaneAmbiguous);
        index.gates.clear();
        assert_eq!(lift_map_bound_template(&source, &index, &PortableLiftOptions::default()).issues[0].code, PortableLiftIssueCode::TerminalLaneUnconnected);
    }

    #[test]
    fn refusal_vocabulary_and_candidate_binding_are_complete() {
        let all = [
            (PortableLiftIssueCode::ReferenceRoleMissing,"reference_role_missing"),
            (PortableLiftIssueCode::ReferenceLaneAnchorMissing,"reference_lane_anchor_missing"),
            (PortableLiftIssueCode::ReferenceLaneMissing,"reference_lane_missing"),
            (PortableLiftIssueCode::SourceFrameUnbuildable,"source_frame_unbuildable"),
            (PortableLiftIssueCode::InternalLaneAmbiguous,"internal_lane_ambiguous"),
            (PortableLiftIssueCode::TerminalLaneUnconnected,"terminal_lane_unconnected"),
            (PortableLiftIssueCode::RoleLaneAnchorMissing,"role_lane_anchor_missing"),
            (PortableLiftIssueCode::RoleLaneMissing,"role_lane_missing"),
            (PortableLiftIssueCode::RoleProjectionTooFar,"role_projection_too_far"),
            (PortableLiftIssueCode::SignalPlanTransferRequired,"signal_plan_transfer_required"),
            (PortableLiftIssueCode::RoleBindingAmbiguous,"role_binding_ambiguous"),
            (PortableLiftIssueCode::SpatialExtensionRemoved,"spatial_extension_removed"),
            (PortableLiftIssueCode::RouteProjectionError,"route_projection_error"),
            (PortableLiftIssueCode::CandidateNotEquivalent,"candidate_not_equivalent"),
        ];
        for (code, literal) in all { assert_eq!(code.as_str(), literal); }
        let source = template(json!([scene_role("ego", 10.0, 0.0, 0.0, Some(main_lane_ref()))]), json!([]));

        let lifted = lift_map_bound_template(&source, &straight_index(), &PortableLiftOptions::default());
        let mut bad_site = lifted.source_site.unwrap();
        bad_site.degradation.intent_preserved = false;
        assert_eq!(bind_portable_variation(&lifted.template.unwrap(), &bad_site).unwrap_err().code, PortableLiftIssueCode::CandidateNotEquivalent);
    }
    #[test]
    fn map_signal_plan_is_removed_with_explicit_review_issue() {
        let mut source = template(
            json!([scene_role("ego", 10.0, 0.0, 0.0, Some(main_lane_ref()))]),
            json!([]),
        );
        source.map_signal_plans.push(crate::template::MapSignalPlan {
            id: "source-signals".into(),
            version: 1,
            binding: crate::template::MapSignalPlanBinding {
                map_id: "lift-test".into(),
                junction_id: "source-junction".into(),
                control_digest: "source-control".into(),
            },
            clips: vec![],
            display_baselines: vec![],
            route_signals: vec![],
        });
        let result = lift_map_bound_template(&source, &straight_index(), &PortableLiftOptions::default());
        assert!(result.ok, "{:?}", result.issues);
        let warning = result
            .issues
            .iter()
            .find(|issue| issue.code == PortableLiftIssueCode::SignalPlanTransferRequired)
            .expect("signal plan review issue");
        assert_eq!(warning.severity, PortableLiftSeverity::Warning);
        assert!(warning.message.contains("cannot be carried verbatim"));
        assert!(result.template.unwrap().map_signal_plans.is_empty());
    }
}
