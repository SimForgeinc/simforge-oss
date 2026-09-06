//! Routes: a single arc-length parameterisation an actor drives along.
//!
//! A route is either a **lane chain** (ordered directed lanes, connected within
//! [`ENDPOINT_TOL_M`]) or a **freeform polyline** (pedestrian crossings,
//! jaywalk diagonals). Both expose the same [`Route::pose_at`] so controllers
//! never branch on actor kind for geometry.
//!
//! Lateral position is *not* part of the route: actors carry a signed offset in
//! metres (positive = left of the centreline) that the lateral controller
//! animates. Completing a lane change re-bases the route onto the neighbour
//! lane ([`retarget_to_neighbour`]) and subtracts the lane separation from the
//! offset, so the offset stays small and a follower's "same lane?" test stays
//! meaningful.
//!
//! Routes are immutable and hold an `Arc` to their graph, so they are cheap to
//! share between worlds and between the engine and its snapshots. The
//! serialisable form is [`RouteSnapshot`]: the chosen lane chain (or polyline)
//! only, with every arc-length quantity recomputed from the graph on restore.

use std::cmp::Ordering;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::error::{SimIssue, SimIssueCode};
use crate::math::{clamp, dist, local_from_scene, normalize_angle, sin_cos, SceneXZ, Vec2};
use crate::types::{RouteSpec, TurnRelation};

use super::lane_graph::{DirectedLane, Gate, LaneGraph, LaneId, Polyline, ENDPOINT_TOL_M};
use super::topology::LaneSide;

/// Coarse sampling step for [`Route::project_point`].
const PROJECT_STEP_M: f64 = 2.0;
/// Preview horizon used when a lane change rebuilds the route.
const RETARGET_HORIZON_M: f64 = 2000.0;

const TURN_FALLBACK_ORDER: [TurnRelation; 5] = [
    TurnRelation::Straight,
    TurnRelation::Right,
    TurnRelation::Left,
    TurnRelation::UTurnRight,
    TurnRelation::UTurnLeft,
];

#[inline]
fn turn_slot(t: TurnRelation) -> usize {
    match t {
        TurnRelation::Straight => 0,
        TurnRelation::Left => 1,
        TurnRelation::Right => 2,
        TurnRelation::UTurnLeft => 3,
        TurnRelation::UTurnRight => 4,
    }
}

const TURN_SLOTS: [TurnRelation; 5] = [
    TurnRelation::Straight,
    TurnRelation::Left,
    TurnRelation::Right,
    TurnRelation::UTurnLeft,
    TurnRelation::UTurnRight,
];

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RouteLeg {
    pub lane: LaneId,
    pub reversed: bool,
    /// Route arc length at the leg's entry.
    pub s_start: f64,
    pub length_m: f64,
    /// Turn taken to enter this leg, when it is a junction connecting lane.
    pub turn_relation: Option<TurnRelation>,
}

impl RouteLeg {
    #[inline]
    pub const fn directed(&self) -> DirectedLane {
        DirectedLane {
            lane: self.lane,
            reversed: self.reversed,
        }
    }

    #[inline]
    pub fn s_end(&self) -> f64 {
        self.s_start + self.length_m
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RoutePose {
    pub point: Vec2,
    /// Normalised to `(-PI, PI]`.
    pub heading_rad: f64,
    /// `None` on a freeform route.
    pub lane: Option<LaneId>,
    /// Arc length within the lane, in traversal direction.
    pub lane_s: f64,
    /// Arc length within the lane in the index's **storage** direction. This
    /// is the `s` that `laneRef`, `widthSamples` and signal stop lines speak,
    /// so it is the only lane-local `s` that crosses the package boundary.
    pub storage_s: f64,
    pub reversed: bool,
    /// `None` on a freeform route.
    pub leg_index: Option<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RouteProjection {
    pub s: f64,
    pub d: f64,
}

/// Structured detail attached to a [`RouteBuildError`]; serialises to the same
/// camelCase object the TypeScript engine reports.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum RouteBuildDetail {
    #[serde(rename_all = "camelCase")]
    Lane { rsl: String },
    #[serde(rename_all = "camelCase")]
    Disconnected {
        from: String,
        to: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        gap_m: Option<f64>,
    },
    #[serde(rename_all = "camelCase")]
    Placement {
        start_rsl: String,
        required_downstream_m: f64,
        max_legs: usize,
    },
    #[serde(rename_all = "camelCase")]
    Turn {
        rsl: String,
        requested_turn: TurnRelation,
        available_turns: Vec<TurnRelation>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RouteBuildError {
    /// One of `RouteLaneMissing`, `RouteDisconnected`, `RouteEmpty`,
    /// `RouteOrientationAmbiguous`, `RouteTurnUnavailable`.
    pub code: SimIssueCode,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<RouteBuildDetail>,
}

impl RouteBuildError {
    fn new(code: SimIssueCode, reason: String, detail: Option<RouteBuildDetail>) -> Self {
        Self {
            code,
            reason,
            detail,
        }
    }

    fn lane_missing(rsl: &str) -> Self {
        Self::new(
            SimIssueCode::RouteLaneMissing,
            format!("lane {rsl} not in topology"),
            Some(RouteBuildDetail::Lane {
                rsl: rsl.to_owned(),
            }),
        )
    }

    /// Report as an engine issue at `path`.
    pub fn into_issue(self, path: impl Into<String>) -> SimIssue {
        let issue = SimIssue::error(self.code, path, self.reason);
        match self.detail.and_then(|d| serde_json::to_value(d).ok()) {
            Some(serde_json::Value::Object(map)) => issue.with_detail(map),
            _ => issue,
        }
    }
}

impl std::fmt::Display for RouteBuildError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.code, self.reason)
    }
}

impl std::error::Error for RouteBuildError {}

pub type RouteResult = Result<Route, RouteBuildError>;

/// Persisted form of a route binding. Lane chains store the chosen directed
/// lanes and authored turns only; `s_start`/lengths are recomputed from the
/// graph on restore so a restored route answers every query identically.
/// Polyline points are xodr-local metres (engine frame).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RouteSnapshot {
    LaneChain { legs: Vec<RouteLegSnapshot> },
    Polyline { points: Vec<Vec2> },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteLegSnapshot {
    pub rsl: String,
    pub reversed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_relation: Option<TurnRelation>,
}

#[derive(Debug, Clone)]
enum RouteBody {
    Lanes {
        graph: Arc<LaneGraph>,
        legs: Vec<RouteLeg>,
        /// `(lane, first leg index visiting it)`, sorted by lane.
        lane_index: Vec<(LaneId, u32)>,
    },
    Freeform(Polyline),
}

#[derive(Debug, Clone)]
pub struct Route {
    body: RouteBody,
    length_m: f64,
}

impl Route {
    /// A lane-chain route. An empty leg list is a zero-length freeform route.
    pub fn from_legs(graph: Arc<LaneGraph>, legs: Vec<RouteLeg>) -> Self {
        let Some(last) = legs.last() else {
            return Self::from_polyline(std::iter::empty::<Vec2>());
        };
        let length_m = last.s_end();
        let mut lane_index: Vec<(LaneId, u32)> = legs
            .iter()
            .enumerate()
            .map(|(i, l)| (l.lane, i as u32))
            .collect();
        // Ties (a lane visited twice) resolve to the first visit, which keeps
        // the reading monotone for a follower.
        lane_index.sort_by_key(|&(lane, i)| (lane, i));
        lane_index.dedup_by_key(|e| e.0);
        Self {
            body: RouteBody::Lanes {
                graph,
                legs,
                lane_index,
            },
            length_m,
        }
    }

    /// A freeform route through `points` (xodr-local). A single point is a
    /// zero-length route: the actor stays where it is.
    pub fn from_polyline(points: impl IntoIterator<Item = Vec2>) -> Self {
        let path = Polyline::new(points);
        let length_m = path.length_m();
        Self {
            body: RouteBody::Freeform(path),
            length_m,
        }
    }

    #[inline]
    pub fn length_m(&self) -> f64 {
        self.length_m
    }

    #[inline]
    pub fn is_freeform(&self) -> bool {
        matches!(self.body, RouteBody::Freeform(_))
    }

    /// Lane legs, empty for a freeform route.
    #[inline]
    pub fn legs(&self) -> &[RouteLeg] {
        match &self.body {
            RouteBody::Lanes { legs, .. } => legs,
            RouteBody::Freeform(_) => &[],
        }
    }

    /// Freeform vertices, `None` for a lane chain.
    pub fn polyline(&self) -> Option<&Polyline> {
        match &self.body {
            RouteBody::Freeform(p) => Some(p),
            RouteBody::Lanes { .. } => None,
        }
    }

    /// The graph a lane chain is bound to; `None` for a freeform route.
    pub fn graph(&self) -> Option<&Arc<LaneGraph>> {
        match &self.body {
            RouteBody::Lanes { graph, .. } => Some(graph),
            RouteBody::Freeform(_) => None,
        }
    }

    /// Index of the leg containing route arc length `s`; `None` when freeform.
    pub fn leg_index_at(&self, s: f64) -> Option<usize> {
        let legs = self.legs();
        if legs.is_empty() {
            return None;
        }
        let q = clamp(s, 0.0, self.length_m);
        let mut lo = 0usize;
        let mut hi = legs.len() - 1;
        while lo < hi {
            let mid = (lo + hi + 1) >> 1;
            if legs[mid].s_start <= q {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
        Some(lo)
    }

    pub fn pose_at(&self, s: f64) -> RoutePose {
        let q = clamp(s, 0.0, self.length_m);
        match &self.body {
            RouteBody::Freeform(path) => {
                let sample = path.sample(q);
                RoutePose {
                    point: sample.point,
                    heading_rad: sample.heading_rad,
                    lane: None,
                    lane_s: q,
                    storage_s: q,
                    reversed: false,
                    leg_index: None,
                }
            }
            RouteBody::Lanes { graph, legs, .. } => {
                let i = self.leg_index_at(q).unwrap_or(0);
                let leg = &legs[i];
                let lane_s = clamp(q - leg.s_start, 0.0, leg.length_m);
                let sample = graph.sample_directed(leg.directed(), lane_s);
                RoutePose {
                    point: sample.point,
                    heading_rad: normalize_angle(sample.heading_rad),
                    lane: Some(leg.lane),
                    lane_s,
                    storage_s: if leg.reversed {
                        leg.length_m - lane_s
                    } else {
                        lane_s
                    },
                    reversed: leg.reversed,
                    leg_index: Some(i),
                }
            }
        }
    }

    /// Lane width at route arc length `s` (3.5 m on a freeform route).
    pub fn width_at(&self, s: f64) -> f64 {
        match &self.body {
            RouteBody::Freeform(_) => super::lane_graph::DEFAULT_LANE_WIDTH_M,
            RouteBody::Lanes { graph, legs, .. } => {
                let leg = &legs[self.leg_index_at(s).unwrap_or(0)];
                let lane_s = clamp(s - leg.s_start, 0.0, leg.length_m);
                let storage_s = if leg.reversed {
                    leg.length_m - lane_s
                } else {
                    lane_s
                };
                graph.width_at(leg.lane, storage_s)
            }
        }
    }

    /// Point offset laterally from the centreline; `+` is left of travel.
    pub fn point_with_offset(&self, s: f64, lateral_m: f64) -> Vec2 {
        let pose = self.pose_at(s);
        if lateral_m == 0.0 {
            return pose.point;
        }
        let (sn, cs) = sin_cos(pose.heading_rad);
        Vec2 {
            x: pose.point.x - sn * lateral_m,
            y: pose.point.y + cs * lateral_m,
        }
    }

    /// Route arc length of a lane-local **storage** `s`, or `None` when the
    /// route never traverses that lane. A lane visited twice resolves to the
    /// first visit.
    pub fn s_of_lane_storage(&self, lane: LaneId, storage_s: f64) -> Option<f64> {
        let RouteBody::Lanes {
            legs, lane_index, ..
        } = &self.body
        else {
            return None;
        };
        let i = lane_index.binary_search_by_key(&lane, |e| e.0).ok()?;
        let leg = &legs[lane_index[i].1 as usize];
        let travel = if leg.reversed {
            leg.length_m - storage_s
        } else {
            storage_s
        };
        Some(leg.s_start + clamp(travel, 0.0, leg.length_m))
    }

    /// Whether the route ever traverses `lane`.
    pub fn includes_lane(&self, lane: LaneId) -> bool {
        match &self.body {
            RouteBody::Lanes { lane_index, .. } => {
                lane_index.binary_search_by_key(&lane, |e| e.0).is_ok()
            }
            RouteBody::Freeform(_) => false,
        }
    }

    /// Nearest route arc length to a point: a 2 m coarse scan followed by a
    /// ternary refine over `±2 m`. Clamps to the route ends.
    #[inline]
    pub fn project_point(&self, p: Vec2) -> RouteProjection {
        self.project_point_with_step(p, PROJECT_STEP_M)
    }

    /// [`Route::project_point`] with an explicit coarse step (signal stop-line
    /// binding uses 0.5 m). `step_m` must be positive and finite.
    pub fn project_point_with_step(&self, p: Vec2, step_m: f64) -> RouteProjection {
        let step = step_m;
        let mut best = RouteProjection {
            s: 0.0,
            d: f64::INFINITY,
        };
        let n = ((self.length_m / step).ceil() as usize + 1).max(2);
        for i in 0..n {
            let s = self.length_m * i as f64 / (n - 1) as f64;
            let d = dist(self.pose_at(s).point, p);
            if d < best.d {
                best = RouteProjection { s, d };
            }
        }
        let mut lo = (best.s - step).max(0.0);
        let mut hi = (best.s + step).min(self.length_m);
        for _ in 0..24 {
            let m1 = lo + (hi - lo) / 3.0;
            let m2 = hi - (hi - lo) / 3.0;
            let d1 = dist(self.pose_at(m1).point, p);
            let d2 = dist(self.pose_at(m2).point, p);
            if d1 < d2 {
                hi = m2;
            } else {
                lo = m1;
            }
        }
        let s = (lo + hi) / 2.0;
        RouteProjection {
            s,
            d: dist(self.pose_at(s).point, p),
        }
    }

    /// The same path traversed the other way, from the far end back to the
    /// start. This is what selecting reverse gear means geometrically: a shift
    /// does not rotate the body; what inverts is the direction of travel.
    /// Re-basing `route_s` to `length_m - s` expresses that with no
    /// discontinuity. The lane chain is flipped rather than degraded to a
    /// polyline so lane identity, width, leader search and corridor guards
    /// keep working while the actor reverses. A junction connector traversed
    /// backwards is not the authored turn, so `turn_relation` is cleared.
    pub fn reversed_route(&self) -> Route {
        match &self.body {
            RouteBody::Freeform(path) => Self::from_polyline(path.points().iter().rev().copied()),
            RouteBody::Lanes { graph, legs, .. } => {
                let mut out = Vec::with_capacity(legs.len());
                let mut s_start = 0.0;
                for leg in legs.iter().rev() {
                    out.push(RouteLeg {
                        lane: leg.lane,
                        reversed: !leg.reversed,
                        s_start,
                        length_m: leg.length_m,
                        turn_relation: None,
                    });
                    s_start += leg.length_m;
                }
                Self::from_legs(Arc::clone(graph), out)
            }
        }
    }

    /// Signed lateral offset of `p` from the centreline at `s` (`+` = left).
    pub fn lateral_offset_at(&self, s: f64, p: Vec2) -> f64 {
        let pose = self.pose_at(s);
        let dx = p.x - pose.point.x;
        let dy = p.y - pose.point.y;
        let (sn, cs) = sin_cos(pose.heading_rad);
        -sn * dx + cs * dy
    }

    /* -------------------------------------------------------------- snapshot */

    pub fn snapshot(&self) -> RouteSnapshot {
        match &self.body {
            RouteBody::Freeform(path) => RouteSnapshot::Polyline {
                points: path.points().to_vec(),
            },
            RouteBody::Lanes { graph, legs, .. } => RouteSnapshot::LaneChain {
                legs: legs
                    .iter()
                    .map(|l| RouteLegSnapshot {
                        rsl: graph.rsl(l.lane).to_owned(),
                        reversed: l.reversed,
                        turn_relation: l.turn_relation,
                    })
                    .collect(),
            },
        }
    }

    /// Rebuild a route from its snapshot against `graph`. Lengths are taken
    /// from the graph; adjacent legs must still connect within
    /// [`ENDPOINT_TOL_M`], so a snapshot taken on a different map fails loudly
    /// instead of yielding a route with silently wrong stationing.
    pub fn restore(graph: &Arc<LaneGraph>, snapshot: &RouteSnapshot) -> RouteResult {
        match snapshot {
            RouteSnapshot::Polyline { points } => Ok(Self::from_polyline(points.iter().copied())),
            RouteSnapshot::LaneChain { legs } => {
                if legs.is_empty() {
                    return Err(RouteBuildError::new(
                        SimIssueCode::RouteEmpty,
                        "no lanes".to_owned(),
                        None,
                    ));
                }
                let mut out: Vec<RouteLeg> = Vec::with_capacity(legs.len());
                for snap in legs {
                    let lane = graph
                        .lane_id(&snap.rsl)
                        .ok_or_else(|| RouteBuildError::lane_missing(&snap.rsl))?;
                    let d = DirectedLane {
                        lane,
                        reversed: snap.reversed,
                    };
                    let s_start = out.last().map_or(0.0, RouteLeg::s_end);
                    if let Some(prev) = out.last() {
                        let gap = dist(
                            graph.endpoints(prev.directed()).exit,
                            graph.endpoints(d).entry,
                        );
                        if gap > ENDPOINT_TOL_M {
                            return Err(disconnected(graph, prev.lane, lane, gap));
                        }
                    }
                    out.push(RouteLeg {
                        lane,
                        reversed: snap.reversed,
                        s_start,
                        length_m: graph.length_of(lane),
                        turn_relation: snap.turn_relation,
                    });
                }
                Ok(Self::from_legs(Arc::clone(graph), out))
            }
        }
    }
}

/* -------------------------------------------------------------- building */

fn disconnected(graph: &LaneGraph, from: LaneId, to: LaneId, gap_m: f64) -> RouteBuildError {
    RouteBuildError::new(
        SimIssueCode::RouteDisconnected,
        format!(
            "lane {} does not connect to {} (gap {gap_m:.2} m > {ENDPOINT_TOL_M} m)",
            graph.rsl(from),
            graph.rsl(to)
        ),
        Some(RouteBuildDetail::Disconnected {
            from: graph.rsl(from).to_owned(),
            to: graph.rsl(to).to_owned(),
            gap_m: Some(gap_m),
        }),
    )
}

/// Smallest entry gap over both orientations of `to`.
fn entry_gap(graph: &LaneGraph, exit: Vec2, to: LaneId) -> f64 {
    dist(exit, graph.endpoints(DirectedLane::new(to, false)).entry).min(dist(
        exit,
        graph.endpoints(DirectedLane::new(to, true)).entry,
    ))
}

/// A leg whose turn is the authored gate relation when the lane is a junction
/// connector.
fn leg_from(graph: &LaneGraph, d: DirectedLane, s_start: f64) -> RouteLeg {
    let turn = if graph.lane(d.lane).is_junction {
        graph.turn_relation_of(d.lane)
    } else {
        None
    };
    leg_with_turn(graph, d, s_start, turn)
}

fn leg_with_turn(
    graph: &LaneGraph,
    d: DirectedLane,
    s_start: f64,
    turn_relation: Option<TurnRelation>,
) -> RouteLeg {
    RouteLeg {
        lane: d.lane,
        reversed: d.reversed,
        s_start,
        length_m: graph.length_of(d.lane),
        turn_relation,
    }
}

/// Build a route from an explicit ordered lane chain.
///
/// The first lane prefers its nominal direction, but if a second lane exists
/// takes whichever orientation actually connects to it. Every later lane is
/// oriented toward the previous exit within [`ENDPOINT_TOL_M`].
pub fn build_lane_path_route(graph: &Arc<LaneGraph>, lanes: &[LaneId]) -> RouteResult {
    let Some(&first) = lanes.first() else {
        return Err(RouteBuildError::new(
            SimIssueCode::RouteEmpty,
            "no lanes".to_owned(),
            None,
        ));
    };
    let mut first_reversed = graph.nominal_reversed(first).unwrap_or(false);
    if let Some(&next) = lanes.get(1) {
        let mut matched = false;
        for reversed in [first_reversed, !first_reversed] {
            let exit = graph.endpoints(DirectedLane::new(first, reversed)).exit;
            if graph.orient_toward(next, exit, ENDPOINT_TOL_M).is_some() {
                first_reversed = reversed;
                matched = true;
                break;
            }
        }
        if !matched {
            return Err(RouteBuildError::new(
                SimIssueCode::RouteDisconnected,
                format!(
                    "lane {} does not connect to {} within {ENDPOINT_TOL_M} m",
                    graph.rsl(first),
                    graph.rsl(next)
                ),
                Some(RouteBuildDetail::Disconnected {
                    from: graph.rsl(first).to_owned(),
                    to: graph.rsl(next).to_owned(),
                    gap_m: None,
                }),
            ));
        }
    }

    let mut legs: Vec<RouteLeg> = Vec::with_capacity(lanes.len());
    legs.push(leg_from(
        graph,
        DirectedLane::new(first, first_reversed),
        0.0,
    ));
    for &lane in &lanes[1..] {
        let prev = legs[legs.len() - 1];
        let exit = graph.endpoints(prev.directed()).exit;
        let Some(oriented) = graph.orient_toward(lane, exit, ENDPOINT_TOL_M) else {
            return Err(disconnected(
                graph,
                prev.lane,
                lane,
                entry_gap(graph, exit, lane),
            ));
        };
        legs.push(leg_from(graph, oriented, prev.s_end()));
    }
    Ok(Route::from_legs(Arc::clone(graph), legs))
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PlacementRouteOptions {
    pub start: LaneId,
    /// Lane-local s in topology storage direction.
    pub start_storage_s: f64,
    pub required_downstream_m: f64,
    /// Defaults to 64, capped at 128.
    pub max_legs: Option<usize>,
}

#[derive(Debug, Clone)]
pub struct PlacementRoute {
    pub route: Route,
    /// Runway from the spawn station to the route end.
    pub downstream_m: f64,
}

/// Choose a connected, legal-direction lane path for a newly placed road actor.
///
/// The chosen lane chain is intended to be persisted ([`Route::snapshot`]). At
/// every branch we prefer a topology-labelled `Straight` movement, then the
/// geometrically straightest continuation. Turns are therefore a fallback
/// rather than an implicit random behaviour; an authored route interaction
/// remains the only way to request a different movement.
pub fn build_default_placement_route(
    graph: &Arc<LaneGraph>,
    options: &PlacementRouteOptions,
) -> Result<PlacementRoute, RouteBuildError> {
    let start = options.start;
    if !graph.is_driving(start) {
        return Err(RouteBuildError::new(
            SimIssueCode::RouteLaneMissing,
            format!("no driving lane {} in topology", graph.rsl(start)),
            Some(RouteBuildDetail::Lane {
                rsl: graph.rsl(start).to_owned(),
            }),
        ));
    }
    let length_m = graph.length_of(start);
    let required = options.required_downstream_m.max(1.0);
    let max_legs = options.max_legs.unwrap_or(64).clamp(1, 128);
    let mut visited = vec![false; graph.lane_count() * 2];
    let mut lanes: Vec<LaneId> = Vec::new();
    let mut candidates: Vec<DirectedLane> = Vec::new();

    for reversed in graph.admissible_orientations(start) {
        let start_directed = DirectedLane::new(start, reversed);
        let clamped_s = clamp(options.start_storage_s, 0.0, length_m);
        let start_ahead = if reversed {
            clamped_s
        } else {
            (length_m - clamped_s).max(0.0)
        };
        lanes.clear();
        lanes.push(start);
        visited.fill(false);
        visited[start_directed.slot()] = true;
        let mut current = start_directed;
        let mut downstream_m = start_ahead;

        while lanes.len() < max_legs {
            candidates.clear();
            candidates.extend(
                graph
                    .successors(current)
                    .iter()
                    .copied()
                    .filter(|c| graph.is_driving(c.lane) && !visited[c.slot()]),
            );
            sort_continuations(graph, current, &mut candidates);
            // Persist one meaningful continuation even if the starting lane
            // alone is long enough. After that, the requested distance is only
            // a preview length; it never justifies replacing an available
            // straight movement with a turn that happens to have more runway.
            if downstream_m >= required && (lanes.len() > 1 || candidates.is_empty()) {
                break;
            }
            let Some(&next) = candidates.first() else {
                break;
            };
            lanes.push(next.lane);
            visited[next.slot()] = true;
            downstream_m += graph.length_of(next.lane);
            current = next;
        }

        let Ok(route) = build_lane_path_route(graph, &lanes) else {
            continue;
        };
        let Some(spawn_s) = route.s_of_lane_storage(start, options.start_storage_s) else {
            continue;
        };
        let downstream_m = (route.length_m() - spawn_s).max(0.0);
        return Ok(PlacementRoute {
            route,
            downstream_m,
        });
    }
    Err(RouteBuildError::new(
        SimIssueCode::RouteDisconnected,
        format!(
            "no connected driving route from {} provides {required:.1} m downstream",
            graph.rsl(start)
        ),
        Some(RouteBuildDetail::Placement {
            start_rsl: graph.rsl(start).to_owned(),
            required_downstream_m: required,
            max_legs,
        }),
    ))
}

/// `Straight`-labelled gate movements first, then by absolute heading
/// deflection, then by directed lane order.
fn continuation_score(graph: &LaneGraph, current: DirectedLane, candidate: DirectedLane) -> f64 {
    let straight = graph
        .gates_from(current.lane)
        .find(|g| g.connecting == Some(candidate.lane))
        .is_some_and(|g| g.turn_relation() == TurnRelation::Straight);
    if straight {
        return -1.0;
    }
    let from = graph
        .sample_directed(current, graph.length_of(current.lane))
        .heading_rad;
    let to = graph.sample_directed(candidate, 0.0).heading_rad;
    normalize_angle(to - from).abs()
}

/// The reference breaks continuation ties with
/// `` `${rsl}${reversed ? '#r' : '#f'}`.localeCompare(...) ``: ICU root
/// order, where `:` precedes the digits, so `LaneId` (code-unit rsl order)
/// is not a substitute once a road id is a prefix of another.
fn cmp_directed_locale(graph: &LaneGraph, a: DirectedLane, b: DirectedLane) -> Ordering {
    let key = |d: DirectedLane| {
        graph
            .rsl(d.lane)
            .bytes()
            .chain(if d.reversed { *b"#r" } else { *b"#f" })
    };
    crate::hash::cmp_locale_bytes(key(a), key(b))
}

fn sort_continuations(graph: &LaneGraph, current: DirectedLane, candidates: &mut [DirectedLane]) {
    candidates.sort_by(|&a, &b| {
        let sa = continuation_score(graph, current, a);
        let sb = continuation_score(graph, current, b);
        sa.partial_cmp(&sb)
            .unwrap_or(Ordering::Equal)
            .then_with(|| cmp_directed_locale(graph, a, b))
    });
}

#[derive(Debug, Clone, Copy)]
pub struct FollowRouteOptions<'a> {
    pub start: LaneId,
    pub turns: &'a [TurnRelation],
    /// Preview runway bound for ordinary continuation.
    pub max_length_m: f64,
    /// `None` = the lane's nominal direction (forward for junction connectors).
    pub start_reversed: Option<bool>,
    /// Fail with `RouteTurnUnavailable` instead of falling back when a
    /// requested turn is not offered.
    pub strict_turns: bool,
}

impl<'a> FollowRouteOptions<'a> {
    pub fn new(start: LaneId, turns: &'a [TurnRelation], max_length_m: f64) -> Self {
        Self {
            start,
            turns,
            max_length_m,
            start_reversed: None,
            strict_turns: false,
        }
    }
}

/// Exit lanes of `gate` that connect to `connector` and share its lane type.
fn connected_gate_exits<'g>(
    graph: &'g LaneGraph,
    gate: &'g Gate,
    connector: DirectedLane,
) -> impl Iterator<Item = DirectedLane> + 'g {
    let exit_point = graph.endpoints(connector).exit;
    let connector_type = graph.lane(connector.lane).lane_type.as_str();
    gate.exits
        .iter()
        .filter_map(move |&lane| graph.orient_toward(lane, exit_point, ENDPOINT_TOL_M))
        .filter(move |c| graph.lane(c.lane).lane_type == connector_type)
}

/// Smallest `|exit laneId − approach laneId|` over the gate's resolved exits.
fn gate_lineage_delta(graph: &LaneGraph, gate: &Gate) -> f64 {
    let Some(approach) = gate.approach else {
        return f64::INFINITY;
    };
    let approach_lane_id = graph.lane(approach).lane_id;
    gate.exits
        .iter()
        .map(|&e| (graph.lane(e).lane_id - approach_lane_id).abs() as f64)
        .fold(f64::INFINITY, f64::min)
}

fn compare_gate_exit(graph: &LaneGraph, gate: &Gate, a: DirectedLane, b: DirectedLane) -> Ordering {
    let approach_lane_id = gate.approach.map_or(0, |l| graph.lane(l).lane_id);
    let delta = |c: DirectedLane| (graph.lane(c.lane).lane_id - approach_lane_id).abs();
    delta(a)
        .cmp(&delta(b))
        .then_with(|| cmp_directed_locale(graph, a, b))
}

/// Walk successors from `start`, consuming `turns` at each junction.
///
/// Choice rule (deterministic): the requested turn if a complete, connected
/// gate movement offers it, else the first available relation in `Straight,
/// Right, Left, UTurnRight, UTurnLeft`, else the straightest successor. Ties
/// within a relation prefer the smallest heading deflection, closest exit-lane
/// lineage and then stable topology ids. A chosen gate is completed atomically
/// through its exit lane even when the preview bound falls inside the junction.
pub fn build_follow_route(graph: &Arc<LaneGraph>, options: &FollowRouteOptions<'_>) -> RouteResult {
    let start = options.start;
    let reversed = options
        .start_reversed
        .or_else(|| graph.nominal_reversed(start))
        .unwrap_or(false);
    let mut legs: Vec<RouteLeg> = vec![leg_from(graph, DirectedLane::new(start, reversed), 0.0)];
    let mut visited = vec![false; graph.lane_count() * 2];
    visited[DirectedLane::new(start, reversed).slot()] = true;
    let mut turn_idx = 0usize;
    let mut succ: Vec<DirectedLane> = Vec::new();
    let mut by_relation: [Vec<(DirectedLane, &Gate)>; 5] = Default::default();
    let mut exits: Vec<DirectedLane> = Vec::new();

    loop {
        let current = legs[legs.len() - 1];
        let route_end_m = current.s_end();
        let gates = graph.gates_from(current.lane);
        let want = options.turns.get(turn_idx).copied();
        // `max_length_m` limits ordinary route preview runway. It must not
        // suppress an explicit movement merely because the approach lane
        // itself is longer than the preview. In that case include the
        // requested connector, then let the next iteration apply the bound.
        let requested_movement_is_here =
            want.is_some_and(|w| gates.clone().any(|g| g.turn_relation() == w));
        if route_end_m >= options.max_length_m && !requested_movement_is_here {
            break;
        }
        succ.clear();
        succ.extend(
            graph
                .successors(current.directed())
                .iter()
                .copied()
                .filter(|d| !visited[d.slot()]),
        );
        sort_continuations(graph, current.directed(), &mut succ);
        let Some(&first) = succ.first() else { break };

        let mut chosen = first;
        let mut chosen_gate: Option<&Gate> = None;
        if gates.len() > 0 {
            for bucket in by_relation.iter_mut() {
                bucket.clear();
            }
            for gate in gates {
                let Some(&matched) = succ.iter().find(|d| Some(d.lane) == gate.connecting) else {
                    continue;
                };
                // A gate is only addressable when its complete movement chain
                // is geometrically traversable. This prevents a stale or
                // disconnected gate alternative from shadowing a valid
                // movement with the same relation.
                if connected_gate_exits(graph, gate, matched).next().is_none() {
                    continue;
                }
                // Keep duplicate connector alternatives until after ranking:
                // their exit lineage or heading metadata can differ even when
                // the connector lane is the same.
                by_relation[turn_slot(gate.turn_relation())].push((matched, gate));
            }
            for bucket in by_relation.iter_mut() {
                bucket.sort_by(|a, b| {
                    a.1.heading_change_rad()
                        .abs()
                        .partial_cmp(&b.1.heading_change_rad().abs())
                        .unwrap_or(Ordering::Equal)
                        .then_with(|| {
                            gate_lineage_delta(graph, a.1)
                                .partial_cmp(&gate_lineage_delta(graph, b.1))
                                .unwrap_or(Ordering::Equal)
                        })
                        .then_with(|| cmp_directed_locale(graph, a.0, b.0))
                        .then_with(|| crate::hash::cmp_locale(a.1.id(), b.1.id()))
                });
            }
            if let Some(w) = want {
                if options.strict_turns && by_relation[turn_slot(w)].is_empty() {
                    let available: Vec<TurnRelation> = {
                        let mut v: Vec<TurnRelation> = TURN_SLOTS
                            .iter()
                            .copied()
                            .filter(|&t| !by_relation[turn_slot(t)].is_empty())
                            .collect();
                        v.sort_by(|a, b| a.as_str().cmp(b.as_str()));
                        v
                    };
                    return Err(RouteBuildError::new(
                        SimIssueCode::RouteTurnUnavailable,
                        format!(
                            "{} is not a legal movement at the next junction from lane {}",
                            w.as_str(),
                            graph.rsl(current.lane)
                        ),
                        Some(RouteBuildDetail::Turn {
                            rsl: graph.rsl(current.lane).to_owned(),
                            requested_turn: w,
                            available_turns: available,
                        }),
                    ));
                }
            }
            let pick = want
                .and_then(|w| by_relation[turn_slot(w)].first())
                .or_else(|| {
                    TURN_FALLBACK_ORDER
                        .iter()
                        .find_map(|&r| by_relation[turn_slot(r)].first())
                })
                .copied();
            if let Some((lane, gate)) = pick {
                chosen = lane;
                chosen_gate = Some(gate);
                if want == Some(gate.turn_relation()) {
                    turn_idx += 1;
                }
            }
        }
        visited[chosen.slot()] = true;
        let connector_leg = match chosen_gate {
            Some(gate) => leg_with_turn(graph, chosen, route_end_m, Some(gate.turn_relation())),
            None => leg_from(graph, chosen, route_end_m),
        };
        legs.push(connector_leg);
        if let Some(gate) = chosen_gate {
            // A selected gate is an atomic approach -> connector -> exit
            // movement. Finish it even when the preview length ends inside the
            // junction; this leaves a stable road-lane lineage for retargeting
            // and replay.
            exits.clear();
            exits.extend(connected_gate_exits(graph, gate, chosen).filter(|c| !visited[c.slot()]));
            exits.sort_by(|&a, &b| compare_gate_exit(graph, gate, a, b));
            if let Some(&exit) = exits.first() {
                visited[exit.slot()] = true;
                legs.push(leg_from(graph, exit, connector_leg.s_end()));
            }
        }
    }
    if options.strict_turns && turn_idx < options.turns.len() {
        let want = options.turns[turn_idx];
        return Err(RouteBuildError::new(
            SimIssueCode::RouteTurnUnavailable,
            format!(
                "no junction offering {} is reachable from lane {} within the route horizon",
                want.as_str(),
                graph.rsl(start)
            ),
            Some(RouteBuildDetail::Turn {
                rsl: graph.rsl(start).to_owned(),
                requested_turn: want,
                available_turns: Vec::new(),
            }),
        ));
    }
    Ok(Route::from_legs(Arc::clone(graph), legs))
}

/// Resolve a `RouteSpec` from the input document. Scene-frame polyline points
/// are flipped into the engine frame here; a `timedPolyline` yields the
/// geometric path through its keyframes (time ownership lives in
/// [`super::timed::TimedRoute`]).
pub fn build_route(graph: &Arc<LaneGraph>, spec: &RouteSpec) -> RouteResult {
    match spec {
        RouteSpec::LanePath { lanes } => {
            let mut ids = Vec::with_capacity(lanes.len());
            for rsl in lanes {
                ids.push(
                    graph
                        .lane_id(rsl)
                        .ok_or_else(|| RouteBuildError::lane_missing(rsl))?,
                );
            }
            build_lane_path_route(graph, &ids)
        }
        RouteSpec::Follow {
            start_rsl,
            turns,
            max_length_m,
        } => {
            let start = graph
                .lane_id(start_rsl)
                .ok_or_else(|| RouteBuildError::lane_missing(start_rsl))?;
            build_follow_route(graph, &FollowRouteOptions::new(start, turns, *max_length_m))
        }
        RouteSpec::Polyline { points } => Ok(Route::from_polyline(
            points
                .iter()
                .map(|p| local_from_scene(SceneXZ { x: p.x, z: p.z })),
        )),
        RouteSpec::TimedPolyline { points } => Ok(Route::from_polyline(
            points
                .iter()
                .map(|p| local_from_scene(SceneXZ { x: p.x, z: p.z })),
        )),
    }
}

/* ------------------------------------------------------------ retargeting */

#[derive(Debug, Clone, Copy, Default)]
pub struct RetargetOptions<'a> {
    /// Only accept a neighbour when the lane change is legal at the current
    /// station ([`retarget_to_neighbour`] only).
    pub legal_only: bool,
    /// Explicit remaining turn intent; empty keeps the route's authored turns.
    pub remaining_turns: &'a [TurnRelation],
    /// Preview horizon for the rebuilt route; defaults to 2000 m.
    pub max_length_m: Option<f64>,
}

#[derive(Debug, Clone)]
pub struct NeighbourRetarget {
    pub route: Route,
    /// Arc length on the new route corresponding to the actor's position.
    pub s: f64,
    /// Lane separation to subtract from the lateral offset (signed: `+` when
    /// moving left).
    pub separation_m: f64,
    pub legal: bool,
    pub target: LaneId,
}

#[derive(Debug, Clone)]
pub struct LaneRetarget {
    pub route: Route,
    pub s: f64,
    pub separation_m: f64,
}

/// Re-base a route onto the lateral neighbour at the actor's current position.
/// `side` is the driver's side; a reversed leg swaps storage left/right.
pub fn retarget_to_neighbour(
    route: &Route,
    s_now: f64,
    side: LaneSide,
    opts: &RetargetOptions<'_>,
) -> Option<NeighbourRetarget> {
    let graph = route.graph()?;
    let pose = route.pose_at(s_now);
    let lane = pose.lane?;
    let leg = &route.legs()[pose.leg_index?];
    let neighbour = graph.lateral_neighbour(
        lane,
        side.to_storage(leg.reversed),
        pose.storage_s,
        opts.legal_only,
    )?;
    let turns = retained_turns(route, s_now, opts.remaining_turns);
    let built = build_follow_route(
        graph,
        &FollowRouteOptions {
            start: neighbour.lane,
            turns: &turns,
            max_length_m: opts.max_length_m.unwrap_or(RETARGET_HORIZON_M),
            start_reversed: Some(leg.reversed),
            strict_turns: false,
        },
    )
    .ok()?;
    let proj = built.project_point(pose.point);
    let separation = (route.width_at(s_now) + built.width_at(proj.s)) / 2.0;
    Some(NeighbourRetarget {
        route: built,
        s: proj.s,
        separation_m: if side == LaneSide::Left {
            separation
        } else {
            -separation
        },
        legal: neighbour.legal,
        target: neighbour.lane,
    })
}

/// Build a route that starts on `target` near the actor's current position
/// (an explicit lane-change target).
pub fn retarget_to_lane(
    route: &Route,
    s_now: f64,
    target: LaneId,
    opts: &RetargetOptions<'_>,
) -> Option<LaneRetarget> {
    let graph = route.graph()?;
    let pose = route.pose_at(s_now);
    let leg = pose.leg_index.map(|i| &route.legs()[i]);
    let turns = retained_turns(route, s_now, opts.remaining_turns);
    let built = build_follow_route(
        graph,
        &FollowRouteOptions {
            start: target,
            turns: &turns,
            max_length_m: opts.max_length_m.unwrap_or(RETARGET_HORIZON_M),
            start_reversed: leg.map(|l| l.reversed),
            strict_turns: false,
        },
    )
    .ok()?;
    let proj = built.project_point(pose.point);
    let lateral = built.lateral_offset_at(proj.s, pose.point);
    Some(LaneRetarget {
        route: built,
        s: proj.s,
        separation_m: -lateral,
    })
}

/// Preserve the route's already-authored junction intent across a lateral lane
/// change. A lane change changes lateral position, not the next turn.
fn retained_turns(route: &Route, s_now: f64, explicit: &[TurnRelation]) -> Vec<TurnRelation> {
    if !explicit.is_empty() {
        return explicit.to_vec();
    }
    let from = route.leg_index_at(s_now).map_or(0, |i| i + 1);
    route
        .legs()
        .iter()
        .skip(from)
        .filter_map(|leg| leg.turn_relation)
        .collect()
}

/// Closest approach between a point and a polyline, used by region tests.
pub fn point_to_polyline(p: Vec2, poly: &[Vec2]) -> f64 {
    let mut best = f64::INFINITY;
    for i in 1..poly.len() {
        let r = crate::math::point_segment(p, poly[i - 1], poly[i]);
        if r.d2 < best {
            best = r.d2;
        }
    }
    best.sqrt()
}
