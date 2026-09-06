//! Route construction helpers shared by the materializer: lane chains that
//! must reach an authored station, forward runway extension, upstream run-up
//! for the arrival solver, and the geometric proof that a matcher-declared
//! conflict survived route materialization.

use std::collections::BTreeSet;
use std::sync::Arc;

use simforge_core::error::SimIssueCode;
use simforge_core::map::{
    build_lane_path_route, DirectedLane, LaneGraph, LaneId, Route, RouteBuildDetail,
    RouteBuildError,
};
use simforge_core::math::{atan2, cos, hypot, sin, to_scene_xz, Vec2};
use simforge_core::types::ScenePoint;

use crate::bundle::MapBundle;
use crate::map_index::DerivedMapIndex;

use super::{Note, Notes};

const MAX_BACKWARD_STEPS: usize = 12;
/// A projection this close to either end of a route is a clamp, not a hit.
pub const ENDPOINT_CLAMP_M: f64 = 1.0;
pub const LOCAL_ROLE_PROJECTION_MAX_DISTANCE_M: f64 = 12.0;
/// A point geometrically on a matched lane endpoint is an authored station,
/// not the ambiguous far-away clamp that the endpoint guard rejects.
const CONSTRAINED_ENDPOINT_EXACT_HIT_M: f64 = 0.25;

#[inline]
pub fn angle_abs(a: f64, b: f64) -> f64 {
    let d = a - b;
    atan2(sin(d), cos(d)).abs()
}

pub fn lane_ids(graph: &LaneGraph, rsls: &[String]) -> Option<Vec<LaneId>> {
    rsls.iter().map(|r| graph.lane_id(r)).collect()
}

pub fn rsls_of(graph: &LaneGraph, route: &Route) -> Vec<String> {
    route
        .legs()
        .iter()
        .map(|leg| graph.rsl(leg.lane).to_owned())
        .collect()
}

pub fn build_lanes(graph: &Arc<LaneGraph>, rsls: &[String]) -> Result<Route, RouteBuildError> {
    match lane_ids(graph, rsls) {
        Some(ids) => build_lane_path_route(graph, &ids),
        None => {
            let missing = rsls
                .iter()
                .find(|r| graph.lane_id(r).is_none())
                .cloned()
                .unwrap_or_default();
            Err(RouteBuildError {
                code: SimIssueCode::RouteLaneMissing,
                reason: format!("lane {missing} is not in the lane graph"),
                detail: Some(RouteBuildDetail::Lane { rsl: missing }),
            })
        }
    }
}

/// Build an engine route from a matcher lane chain. The two passes verify
/// adjacency with different tolerances, so a chain the matcher accepted can
/// fail here; keep the longest connectable run that still contains
/// `must_include` and report the shortfall as a note.
pub fn route_from_chain(
    graph: &Arc<LaneGraph>,
    lanes: &[String],
    must_include: Option<&str>,
    notes: &mut Notes,
    path: &str,
) -> Option<Route> {
    if lanes.is_empty() {
        return None;
    }
    let full = build_lanes(graph, lanes);
    let error = match full {
        Ok(route) => return Some(route),
        Err(e) => e,
    };
    let pivot = must_include
        .and_then(|m| lanes.iter().position(|l| l == m))
        .unwrap_or(0);
    let mut best: Option<Route> = None;
    let mut best_len = 0.0;
    for from in 0..=pivot {
        for to in ((pivot + 1)..=lanes.len()).rev() {
            let slice = &lanes[from..to];
            if slice.is_empty() {
                continue;
            }
            if let Ok(route) = build_lanes(graph, slice) {
                if route.length_m() > best_len {
                    best_len = route.length_m();
                    best = Some(route);
                }
            }
        }
    }
    match best {
        Some(route) => {
            notes.push(Note::loss(path, format!("lane chain was not connectable end to end for the engine; kept the longest connectable run ({best_len:.1} m of {} lanes)", lanes.len())));
            Some(route)
        }
        None => {
            notes.push(Note::loss(
                path,
                format!("no connectable lane chain: {}", error.reason),
            ));
            None
        }
    }
}

/// Directed predecessors of the route's first leg, straightest first. Uses
/// both storage-direction link lists because legal travel on a positive-id
/// lane reverses OpenDRIVE's own predecessor/successor sense.
fn predecessor_candidates(
    graph: &LaneGraph,
    first: DirectedLane,
    exclude: &BTreeSet<LaneId>,
) -> Vec<(DirectedLane, f64)> {
    let spec = graph.lane(first.lane);
    let mut neighbours: Vec<LaneId> = spec
        .predecessors
        .iter()
        .chain(spec.successors.iter())
        .filter_map(|r| graph.lane_id(r))
        .filter(|l| !exclude.contains(l))
        .collect();
    neighbours.sort();
    neighbours.dedup();
    let entry_heading = graph.sample_directed(first, 0.0).heading_rad;
    let mut out = Vec::new();
    for lane in neighbours {
        let orientations: Vec<bool> = match graph.nominal_reversed(lane) {
            Some(r) => vec![r],
            None => vec![false, true],
        };
        for reversed in orientations {
            let directed = DirectedLane::new(lane, reversed);
            if !graph.successors(directed).iter().any(|n| *n == first) {
                continue;
            }
            let exit_heading = graph
                .sample_directed(directed, graph.length_of(lane))
                .heading_rad;
            out.push((directed, angle_abs(entry_heading, exit_heading)));
        }
    }
    out.sort_by(|a, b| {
        a.1.total_cmp(&b.1)
            .then_with(|| graph.rsl(a.0.lane).cmp(graph.rsl(b.0.lane)))
            .then_with(|| a.0.reversed.cmp(&b.0.reversed))
    });
    out
}

pub struct Coverage {
    pub lanes: Vec<String>,
    pub route: Route,
    pub constrained_projection: Option<ConstrainedProjection>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ConstrainedProjection {
    pub route_s: f64,
    pub lane: LaneId,
    pub storage_s: f64,
    pub distance_m: f64,
}

/// Extend a lane chain backwards until the route actually contains `target`.
/// The matcher's chain starts at the *statically* evaluated `s`, which is 0
/// whenever the spawn is a site-dependent expression; placing the actor at
/// the real `s` would then clamp to the route start and spawn it past the
/// junction it was supposed to approach.
pub fn cover_target(bundle: &MapBundle, lanes: &[String], target: Vec2) -> Option<Coverage> {
    let graph = bundle.graph();
    let mut current: Vec<String> = lanes.to_vec();
    let mut route: Option<Route> = None;
    for _ in 0..=MAX_BACKWARD_STEPS {
        let Ok(built) = build_lanes(graph, &current) else {
            break;
        };
        let projection = built.project_point(target);
        let length = built.length_m();
        route = Some(built);
        if projection.d <= 12.0
            && projection.s > ENDPOINT_CLAMP_M
            && projection.s < length - ENDPOINT_CLAMP_M
        {
            return Some(Coverage {
                lanes: current,
                route: route.unwrap(),
                constrained_projection: None,
            });
        }
        let Some(first) = route.as_ref().unwrap().legs().first().map(|l| l.directed()) else {
            break;
        };
        let exclude: BTreeSet<LaneId> = current.iter().filter_map(|r| graph.lane_id(r)).collect();
        let Some((chosen, _)) = predecessor_candidates(graph, first, &exclude)
            .into_iter()
            .next()
        else {
            break;
        };
        let mut candidate = vec![graph.rsl(chosen.lane).to_owned()];
        candidate.extend(current.iter().cloned());
        if build_lanes(graph, &candidate).is_err() {
            break;
        }
        current = candidate;
    }
    route.map(|route| Coverage {
        lanes: current,
        route,
        constrained_projection: None,
    })
}

pub struct SemanticRequirements {
    pub preserve_segment: bool,
    pub preserve_road_section: bool,
    pub allow_local_sibling_selection: bool,
    pub expected_heading_rad: Option<f64>,
    pub max_heading_error_rad: Option<f64>,
}

/// Project a structurally constrained role onto the same local lane the
/// matcher used: compare every lane in the bound chain, pick the nearest, then
/// translate the winning lane-local storage station into route arc length.
pub fn project_constrained_role(
    graph: &LaneGraph,
    route: &Route,
    lanes: &[LaneId],
    target: Vec2,
    allowed: impl Fn(LaneId, f64) -> bool,
) -> Option<ConstrainedProjection> {
    let mut best: Option<ConstrainedProjection> = None;
    for &lane in lanes {
        if !route.includes_lane(lane) {
            continue;
        }
        let projection = graph.project_onto(lane, target);
        let Some(route_s) = route.s_of_lane_storage(lane, projection.s) else {
            continue;
        };
        if !allowed(lane, route_s) {
            continue;
        }
        if best.map_or(true, |b| projection.d < b.distance_m) {
            best = Some(ConstrainedProjection {
                route_s,
                lane,
                storage_s: projection.s,
                distance_m: projection.d,
            });
        }
    }
    best
}

struct Candidate {
    lanes: Vec<LaneId>,
    route: Route,
    projection: ConstrainedProjection,
}

fn interior_or_exact(c: &Candidate) -> bool {
    (c.projection.route_s > ENDPOINT_CLAMP_M
        && c.projection.route_s < c.route.length_m() - ENDPOINT_CLAMP_M)
        || c.projection.distance_m <= CONSTRAINED_ENDPOINT_EXACT_HIT_M
}

fn rank(graph: &LaneGraph, a: &Candidate, b: &Candidate) -> std::cmp::Ordering {
    let a_end = a
        .projection
        .route_s
        .min(a.route.length_m() - a.projection.route_s);
    let b_end = b
        .projection
        .route_s
        .min(b.route.length_m() - b.projection.route_s);
    a.projection
        .distance_m
        .total_cmp(&b.projection.distance_m)
        .then_with(|| b_end.total_cmp(&a_end))
        .then_with(|| {
            let ka: Vec<&str> = a.lanes.iter().map(|l| graph.rsl(*l)).collect();
            let kb: Vec<&str> = b.lanes.iter().map(|l| graph.rsl(*l)).collect();
            ka.cmp(&kb)
        })
}

/// Cover a constrained role's frame point without ever leaving its matched
/// movement: a bounded deterministic beam over directed continuations within
/// 45°, so a nearby perpendicular lane can never satisfy the projection guard.
pub fn cover_constrained_target(
    bundle: &MapBundle,
    lanes: &[String],
    target: Vec2,
    req: &SemanticRequirements,
) -> Option<Coverage> {
    let graph = bundle.graph();
    let index = bundle.index();
    let initial_ids = lane_ids(graph, lanes)?;
    let initial_built = build_lane_path_route(graph, &initial_ids).ok()?;
    let raw_initial =
        project_constrained_role(graph, &initial_built, &initial_ids, target, |_, _| true)?;
    let heading_compatible = |route: &Route, route_s: f64| -> bool {
        match (req.expected_heading_rad, req.max_heading_error_rad) {
            (Some(expected), Some(max_err)) => {
                angle_abs(route.pose_at(route_s).heading_rad, expected) <= max_err + 1e-9
            }
            _ => true,
        }
    };
    let initial_projection =
        project_constrained_role(graph, &initial_built, &initial_ids, target, |_, s| {
            heading_compatible(&initial_built, s)
        })
        .unwrap_or(raw_initial);
    let semantic_rsl = graph.rsl(initial_projection.lane).to_owned();
    let semantic_lane = index.lanes.get(&semantic_rsl);
    let semantic_segment = index
        .fact_index
        .segment_ids_by_lane
        .get(&semantic_rsl)
        .cloned();
    // A heading relation describes a movement, so route-connected continuation
    // across OpenDRIVE road records is valid while its local direction still
    // satisfies that relation. Without one, retain exact segment/road identity.
    let preserve_topology_identity = req.expected_heading_rad.is_none();
    let lane_allowed = |lane: LaneId| -> bool {
        let rsl = graph.rsl(lane);
        let Some(derived) = index.lanes.get(rsl) else {
            return false;
        };
        if let Some(seg) = &semantic_segment {
            if index.fact_index.segment_ids_by_lane.get(rsl) != Some(seg) {
                return false;
            }
        }
        if preserve_topology_identity && req.preserve_road_section {
            if let Some(sl) = semantic_lane {
                if derived.road_id != sl.road_id || derived.section != sl.section {
                    return false;
                }
            }
        }
        true
    };
    let projection_allowed = |route: &Route, lane: LaneId, route_s: f64| {
        lane_allowed(lane) && heading_compatible(route, route_s)
    };
    let make_candidate = |chain: Vec<LaneId>| -> Option<Candidate> {
        let built = build_lane_path_route(graph, &chain).ok()?;
        let projection = project_constrained_role(graph, &built, &chain, target, |lane, s| {
            projection_allowed(&built, lane, s)
        })
        .or_else(|| project_constrained_role(graph, &built, &chain, target, |_, _| true))?;
        Some(Candidate {
            lanes: chain,
            route: built,
            projection,
        })
    };
    let identity_gate =
        preserve_topology_identity && (req.preserve_road_section || req.preserve_segment);
    let extensions = |c: &Candidate| -> Vec<Vec<LaneId>> {
        let mut out = Vec::new();
        if let Some(first) = c.route.legs().first().map(|l| l.directed()) {
            let exclude: BTreeSet<LaneId> = c.lanes.iter().copied().collect();
            for (directed, turn) in predecessor_candidates(graph, first, &exclude) {
                if identity_gate && !lane_allowed(directed.lane) {
                    continue;
                }
                if turn <= std::f64::consts::FRAC_PI_4 {
                    let mut chain = vec![directed.lane];
                    chain.extend(c.lanes.iter().copied());
                    out.push(chain);
                }
            }
        }
        if let Some(last) = c.route.legs().last().map(|l| l.directed()) {
            let exit_heading = graph
                .sample_directed(last, graph.length_of(last.lane))
                .heading_rad;
            for next in graph.successors(last) {
                if c.lanes.contains(&next.lane) || (identity_gate && !lane_allowed(next.lane)) {
                    continue;
                }
                let entry_heading = graph.sample_directed(*next, 0.0).heading_rad;
                if angle_abs(entry_heading, exit_heading) <= std::f64::consts::FRAC_PI_4 {
                    let mut chain = c.lanes.clone();
                    chain.push(next.lane);
                    out.push(chain);
                }
            }
        }
        out
    };
    let is_covered = |c: &Candidate| {
        projection_allowed(&c.route, c.projection.lane, c.projection.route_s)
            && c.projection.distance_m <= LOCAL_ROLE_PROJECTION_MAX_DISTANCE_M
            && interior_or_exact(c)
    };
    let to_coverage = |c: Candidate| Coverage {
        lanes: c.lanes.iter().map(|l| graph.rsl(*l).to_owned()).collect(),
        route: c.route,
        constrained_projection: Some(c.projection),
    };

    let initial = make_candidate(initial_ids)?;
    let mut seen: BTreeSet<Vec<LaneId>> = BTreeSet::new();
    seen.insert(initial.lanes.clone());
    let mut frontier = vec![initial];
    for _ in 0..=MAX_BACKWARD_STEPS {
        let mut covered: Vec<Candidate> = Vec::new();
        let mut rest: Vec<Candidate> = Vec::new();
        for c in frontier {
            if is_covered(&c) {
                covered.push(c);
            } else {
                rest.push(c);
            }
        }
        if !covered.is_empty() {
            covered.sort_by(|a, b| rank(graph, a, b));
            return Some(to_coverage(covered.swap_remove(0)));
        }
        let mut next: Vec<Candidate> = Vec::new();
        for c in &rest {
            for chain in extensions(c) {
                if !seen.insert(chain.clone()) {
                    continue;
                }
                if let Some(built) = make_candidate(chain) {
                    next.push(built);
                }
            }
        }
        // Real junctions fan out; a bounded beam keeps the search cheap.
        next.sort_by(|a, b| rank(graph, a, b));
        next.truncate(24);
        if next.is_empty() {
            break;
        }
        frontier = next;
    }

    // Recover only the exact sibling carriageway at the authored station:
    // identify the road section geometrically containing the frame point,
    // then consider lanes on that same road/section whose directed heading
    // satisfies the authored relation. Never a generic nearest-lane fallback.
    if req.allow_local_sibling_selection
        && req.expected_heading_rad.is_some()
        && req.max_heading_error_rad.is_some()
    {
        let reference = sibling_reference(graph, index, target)?;
        let mut siblings: Vec<Candidate> = Vec::new();
        for (rsl, lane) in &index.lanes {
            if lane.road_id != reference.road_id || lane.section != reference.section {
                continue;
            }
            let Some(id) = graph.lane_id(rsl) else {
                continue;
            };
            let Ok(built) = build_lane_path_route(graph, &[id]) else {
                continue;
            };
            let Some(projection) =
                project_constrained_role(graph, &built, &[id], target, |_, _| true)
            else {
                continue;
            };
            if projection.distance_m > LOCAL_ROLE_PROJECTION_MAX_DISTANCE_M
                || !heading_compatible(&built, projection.route_s)
            {
                continue;
            }
            siblings.push(Candidate {
                lanes: vec![id],
                route: built,
                projection,
            });
        }
        siblings.retain(interior_or_exact);
        siblings.sort_by(|a, b| rank(graph, a, b));
        if !siblings.is_empty() {
            return Some(to_coverage(siblings.swap_remove(0)));
        }
    }
    None
}

fn sibling_reference<'i>(
    graph: &LaneGraph,
    index: &'i DerivedMapIndex,
    target: Vec2,
) -> Option<&'i crate::map_index::DerivedLane> {
    let mut best: Option<(&str, f64)> = None;
    for rsl in index.lanes.keys() {
        let Some(lane) = graph.lane_id(rsl) else {
            continue;
        };
        let d = graph.project_onto(lane, target).d;
        if best.map_or(true, |(_, bd)| d < bd) {
            best = Some((rsl, d));
        }
    }
    index.lanes.get(best?.0)
}

/// Walk successors until `need_m` metres of route exist past `from_s`
/// (deterministically: straightest continuation, ties broken by rsl). The
/// matcher stops at its own run-up constant; only this layer knows both the
/// clip length and the actor's speed.
pub fn extend_chain_forward(
    graph: &LaneGraph,
    route: &Route,
    from_s: f64,
    need_m: f64,
) -> Vec<String> {
    let mut out = rsls_of(graph, route);
    let mut have = route.length_m() - from_s;
    let Some(mut current) = route.legs().last().map(|l| l.directed()) else {
        return out;
    };
    if have >= need_m {
        return out;
    }
    let mut seen: BTreeSet<LaneId> = route.legs().iter().map(|l| l.lane).collect();
    for _ in 0..64 {
        if have >= need_m {
            break;
        }
        let exit_heading = graph
            .sample_directed(current, graph.length_of(current.lane))
            .heading_rad;
        let mut options: Vec<(DirectedLane, f64)> = graph
            .successors(current)
            .iter()
            .filter(|n| !seen.contains(&n.lane))
            .map(|n| {
                (
                    *n,
                    angle_abs(graph.sample_directed(*n, 0.0).heading_rad, exit_heading),
                )
            })
            .collect();
        if options.is_empty() {
            break;
        }
        options.sort_by(|a, b| {
            a.1.total_cmp(&b.1)
                .then_with(|| graph.rsl(a.0.lane).cmp(graph.rsl(b.0.lane)))
        });
        let next = options[0].0;
        out.push(graph.rsl(next.lane).to_owned());
        seen.insert(next.lane);
        have += graph.length_of(next.lane);
        current = next;
    }
    out
}

/// Prepend legal, geometrically connected predecessors until an
/// arrival-solved actor has `need_m` of route before its conflict point.
pub fn extend_chain_backward(
    graph: &Arc<LaneGraph>,
    lanes: &[String],
    conflict_point: Vec2,
    need_m: f64,
) -> Vec<String> {
    let mut out: Vec<String> = lanes.to_vec();
    let mut seen: BTreeSet<LaneId> = lanes.iter().filter_map(|r| graph.lane_id(r)).collect();
    for _ in 0..64 {
        let Ok(built) = build_lanes(graph, &out) else {
            break;
        };
        if built.project_point(conflict_point).s >= need_m || built.legs().is_empty() {
            break;
        }
        let first = built.legs()[0].directed();
        let Some((chosen, _)) = predecessor_candidates(graph, first, &seen)
            .into_iter()
            .next()
        else {
            break;
        };
        let mut candidate = vec![graph.rsl(chosen.lane).to_owned()];
        candidate.extend(out.iter().cloned());
        if build_lanes(graph, &candidate).is_err() {
            break;
        }
        out = candidate;
        seen.insert(chosen.lane);
    }
    out
}

fn point_segment_distance(p: Vec2, a: Vec2, b: Vec2) -> f64 {
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let len2 = dx * dx + dy * dy;
    if len2 <= 1e-12 {
        return hypot(p.x - a.x, p.y - a.y);
    }
    let t = (((p.x - a.x) * dx + (p.y - a.y) * dy) / len2).clamp(0.0, 1.0);
    hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

fn segment_distance(a: Vec2, b: Vec2, c: Vec2, d: Vec2) -> f64 {
    let cross = |p: Vec2, q: Vec2, r: Vec2| (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    let (ab_c, ab_d, cd_a, cd_b) = (
        cross(a, b, c),
        cross(a, b, d),
        cross(c, d, a),
        cross(c, d, b),
    );
    if ((ab_c <= 0.0 && ab_d >= 0.0) || (ab_c >= 0.0 && ab_d <= 0.0))
        && ((cd_a <= 0.0 && cd_b >= 0.0) || (cd_a >= 0.0 && cd_b <= 0.0))
    {
        return 0.0;
    }
    point_segment_distance(a, c, d)
        .min(point_segment_distance(b, c, d))
        .min(point_segment_distance(c, a, b))
        .min(point_segment_distance(d, a, b))
}

pub fn polyline_distance(a: &[Vec2], b: &[Vec2]) -> f64 {
    let mut best = f64::INFINITY;
    for i in 1..a.len() {
        for j in 1..b.len() {
            best = best.min(segment_distance(a[i - 1], a[i], b[j - 1], b[j]));
        }
    }
    best
}

fn sample_route(route: &Route, step_m: f64) -> Vec<Vec2> {
    let mut points = Vec::new();
    let mut s = 0.0;
    while s < route.length_m() {
        points.push(route.pose_at(s).point);
        s += step_m;
    }
    points.push(route.pose_at(route.length_m()).point);
    points
}

/// The crossing of two routes nearest `near`, or `None` when they never cross.
pub fn route_intersection_near(a: &Route, b: &Route, near: Vec2) -> Option<Vec2> {
    let aa = sample_route(a, 1.0);
    let bb = sample_route(b, 1.0);
    let mut best: Option<(Vec2, f64)> = None;
    for i in 0..aa.len().saturating_sub(1) {
        let (p, p2) = (aa[i], aa[i + 1]);
        let (rx, ry) = (p2.x - p.x, p2.y - p.y);
        for j in 0..bb.len().saturating_sub(1) {
            let (q, q2) = (bb[j], bb[j + 1]);
            let (sx, sy) = (q2.x - q.x, q2.y - q.y);
            let denom = rx * sy - ry * sx;
            if denom.abs() < 1e-9 {
                continue;
            }
            let (qpx, qpy) = (q.x - p.x, q.y - p.y);
            let ta = (qpx * sy - qpy * sx) / denom;
            let tb = (qpx * ry - qpy * rx) / denom;
            if !(0.0..=1.0).contains(&ta) || !(0.0..=1.0).contains(&tb) {
                continue;
            }
            let point = Vec2 {
                x: p.x + ta * rx,
                y: p.y + ta * ry,
            };
            let (ex, ey) = (point.x - near.x, point.y - near.y);
            let d2 = ex * ex + ey * ey;
            if best.map_or(true, |(_, bd)| d2 < bd) {
                best = Some((point, d2));
            }
        }
    }
    best.map(|(p, _)| p)
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ArrivalClosure {
    pub closed: bool,
    pub tolerance_m: f64,
    pub a_distance_m: f64,
    pub b_distance_m: f64,
    pub path_separation_m: f64,
    pub point: Vec2,
}

/// Prove that a matcher-declared conflict survived route materialization.
/// The tolerance is footprint-aware — centre paths may be separated by the two
/// half widths and still describe the same occupied conflict region — and it
/// is deliberately not a road-search radius.
pub fn close_arrival_conflict(
    declared: Vec2,
    a: &Route,
    b: &Route,
    a_width_m: f64,
    b_width_m: f64,
) -> ArrivalClosure {
    let a_projection = a.project_point(declared);
    let b_projection = b.project_point(declared);
    let a_point = a.pose_at(a_projection.s).point;
    let b_point = b.pose_at(b_projection.s).point;
    let tolerance_m = ((a_width_m + b_width_m) / 2.0 + 0.05).max(0.25);
    let path_separation_m = hypot(a_point.x - b_point.x, a_point.y - b_point.y);
    let point = route_intersection_near(a, b, declared).unwrap_or(Vec2 {
        x: (a_point.x + b_point.x) / 2.0,
        y: (a_point.y + b_point.y) / 2.0,
    });
    ArrivalClosure {
        closed: a_projection.d <= tolerance_m
            && b_projection.d <= tolerance_m
            && path_separation_m <= tolerance_m,
        tolerance_m,
        a_distance_m: a_projection.d,
        b_distance_m: b_projection.d,
        path_separation_m,
        point,
    }
}

/// A freeform route over distinct points; `None` when fewer than two remain.
pub fn build_route_from_points(points: &[Vec2]) -> Option<Route> {
    let mut distinct: Vec<Vec2> = Vec::with_capacity(points.len());
    for p in points {
        if distinct
            .last()
            .map_or(true, |prev| hypot(p.x - prev.x, p.y - prev.y) > 1e-6)
        {
            distinct.push(*p);
        }
    }
    if distinct.len() < 2 {
        return None;
    }
    Some(Route::from_polyline(distinct))
}

/// Resample a route into scene-frame vertices one metre apart.
pub fn polyline_points_of(route: &Route) -> Vec<ScenePoint> {
    let n = (route.length_m().ceil() as usize).max(2);
    (0..=n)
        .map(|i| {
            let scene = to_scene_xz(route.pose_at(route.length_m() * i as f64 / n as f64).point);
            ScenePoint {
                x: scene.x,
                z: scene.z,
            }
        })
        .collect()
}
