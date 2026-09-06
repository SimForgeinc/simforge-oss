//! The engine's arc-length model over the topology index.
//!
//! ## Why orientation has to be derived
//!
//! The sidecar stores lane polylines in **geometric `s` order** and its
//! `predecessors` / `successors` lists are effectively *undirected*: many lanes
//! list the same neighbour in both arrays and a naive "my last point is your
//! first point" test fails for a large share of links. OpenDRIVE's own rule is
//! that a lane with a negative id travels along `+s` and a positive id against
//! it, but junction connecting roads are emitted in whichever direction their
//! connecting road ran.
//!
//! So the graph works with **directed lanes** ([`DirectedLane`]) and derives
//! successors *geometrically*: a neighbour is a successor only if one of its
//! two orientations has an entry endpoint within [`ENDPOINT_TOL_M`] of our exit
//! endpoint. Non-junction lanes are additionally pinned to their sign-implied
//! direction so a walker cannot drive the wrong way down a one-way lane;
//! junction connecting lanes are free (their storage order is unreliable).
//!
//! Lane ids are interned to [`LaneId`] (the lane's position in rsl-sorted
//! order) so every per-tick query is an index, not a string lookup. Everything
//! fans out in sorted order so route walks are reproducible. The graph is
//! immutable after construction and safe to share across worlds; successor
//! lists for both orientations of every lane are precomputed so no query
//! allocates.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::math::{atan2, clamp, dist, hypot, point_segment, Vec2};
use crate::types::TurnRelation;

use super::topology::{LaneSide, TopologyGate, TopologyIndex, TopologyJunction, TopologyLane};

/// Endpoints closer than this are the same node. Also the guard tolerance for
/// `route_disconnected` (geometrically-verified adjacency).
pub const ENDPOINT_TOL_M: f64 = 0.5;

/// 30 mph, used when the index has no speed limit for a lane.
pub const DEFAULT_SPEED_LIMIT_MPS: f64 = 13.4;
pub const DEFAULT_LANE_WIDTH_M: f64 = 3.5;

/// Vertices closer than this collapse into one: they would make headings NaN.
const DUPLICATE_VERTEX_M: f64 = 1e-9;

/// Interned lane handle: the lane's index in rsl-sorted order within one
/// [`LaneGraph`]. Ordering by `LaneId` is ordering by rsl.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct LaneId(u32);

impl LaneId {
    #[inline]
    pub const fn index(self) -> usize {
        self.0 as usize
    }
}

/// Interned gate handle: the gate's index in id-sorted order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct GateId(u32);

impl GateId {
    #[inline]
    pub const fn index(self) -> usize {
        self.0 as usize
    }
}

/// A lane traversed in a definite direction. Orders forward before reversed,
/// matching the `rsl#f` / `rsl#r` ordering of the reference implementation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct DirectedLane {
    pub lane: LaneId,
    /// `true` = travel from the last polyline point to the first.
    pub reversed: bool,
}

impl DirectedLane {
    #[inline]
    pub const fn new(lane: LaneId, reversed: bool) -> Self {
        Self { lane, reversed }
    }

    #[inline]
    pub const fn flipped(self) -> Self {
        Self {
            lane: self.lane,
            reversed: !self.reversed,
        }
    }

    /// Dense key over `2 * lanes` slots, used for visited sets and caches.
    #[inline]
    pub const fn slot(self) -> usize {
        self.lane.index() * 2 + self.reversed as usize
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PathSample {
    pub point: Vec2,
    pub heading_rad: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Endpoints {
    pub entry: Vec2,
    pub exit: Vec2,
}

/// Nearest point on a polyline: arc length in storage order and distance.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PolylineProjection {
    pub s: f64,
    pub d: f64,
}

/// An arc-length parameterised polyline with cached cumulative lengths and
/// per-segment headings (the last heading repeats the previous one).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Polyline {
    points: Vec<Vec2>,
    cum: Vec<f64>,
    headings: Vec<f64>,
}

impl Polyline {
    /// Build from vertices, dropping consecutive duplicates.
    pub fn new(points: impl IntoIterator<Item = Vec2>) -> Self {
        let mut pts: Vec<Vec2> = Vec::new();
        for p in points {
            if let Some(prev) = pts.last() {
                if dist(*prev, p) < DUPLICATE_VERTEX_M {
                    continue;
                }
            }
            pts.push(p);
        }
        let mut cum = Vec::with_capacity(pts.len());
        let mut headings = Vec::with_capacity(pts.len());
        if !pts.is_empty() {
            cum.push(0.0);
        }
        for i in 1..pts.len() {
            let a = pts[i - 1];
            let b = pts[i];
            cum.push(cum[i - 1] + dist(a, b));
            headings.push(atan2(b.y - a.y, b.x - a.x));
        }
        if !pts.is_empty() {
            headings.push(headings.last().copied().unwrap_or(0.0));
        }
        Self {
            points: pts,
            cum,
            headings,
        }
    }

    #[inline]
    pub fn points(&self) -> &[Vec2] {
        &self.points
    }

    /// Cumulative arc length at each vertex; `cum[0] == 0`.
    #[inline]
    pub fn cum(&self) -> &[f64] {
        &self.cum
    }

    /// Per-vertex heading in storage direction (last repeats the previous).
    #[inline]
    pub fn headings(&self) -> &[f64] {
        &self.headings
    }

    #[inline]
    pub fn len(&self) -> usize {
        self.points.len()
    }

    #[inline]
    pub fn is_empty(&self) -> bool {
        self.points.is_empty()
    }

    #[inline]
    pub fn length_m(&self) -> f64 {
        self.cum.last().copied().unwrap_or(0.0)
    }

    #[inline]
    pub fn first(&self) -> Option<Vec2> {
        self.points.first().copied()
    }

    #[inline]
    pub fn last(&self) -> Option<Vec2> {
        self.points.last().copied()
    }

    /// Index of the segment containing arc length `q` (already clamped).
    #[inline]
    fn segment_at(&self, q: f64) -> usize {
        // Binary search, not a scan: this is the engine's hottest function.
        let mut lo = 0usize;
        let mut hi = self.cum.len() - 1;
        while hi - lo > 1 {
            let mid = (lo + hi) >> 1;
            if self.cum[mid] <= q {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        lo
    }

    /// Pose at arc length `s` in storage order; `s` is clamped. An empty
    /// polyline samples to the origin with heading `0`.
    pub fn sample(&self, s: f64) -> PathSample {
        if self.points.is_empty() {
            return PathSample {
                point: Vec2::ZERO,
                heading_rad: 0.0,
            };
        }
        if self.points.len() == 1 {
            return PathSample {
                point: self.points[0],
                heading_rad: self.headings[0],
            };
        }
        let q = clamp(s, 0.0, self.length_m());
        let lo = self.segment_at(q);
        let hi = lo + 1;
        let a = self.points[lo];
        let b = self.points[hi];
        let span = self.cum[hi] - self.cum[lo];
        let t = if span > 1e-9 {
            (q - self.cum[lo]) / span
        } else {
            0.0
        };
        PathSample {
            point: Vec2 {
                x: a.x + (b.x - a.x) * t,
                y: a.y + (b.y - a.y) * t,
            },
            heading_rad: self.headings[lo],
        }
    }

    /// Nearest point on the polyline to `p`, in storage arc length. `None` for
    /// an empty polyline.
    pub fn project(&self, p: Vec2) -> Option<PolylineProjection> {
        let first = *self.points.first()?;
        if self.points.len() == 1 {
            return Some(PolylineProjection {
                s: 0.0,
                d: dist(first, p),
            });
        }
        let mut best_s = 0.0;
        let mut best_d2 = f64::INFINITY;
        for i in 1..self.points.len() {
            let r = point_segment(p, self.points[i - 1], self.points[i]);
            if r.d2 < best_d2 {
                best_d2 = r.d2;
                best_s = self.cum[i - 1] + r.t * (self.cum[i] - self.cum[i - 1]);
            }
        }
        Some(PolylineProjection {
            s: best_s,
            d: best_d2.sqrt(),
        })
    }

    /// Closest approach between a point and the polyline, metres.
    pub fn distance_to(&self, p: Vec2) -> f64 {
        self.project(p).map_or(f64::INFINITY, |r| r.d)
    }

    /// The same vertices in the opposite order.
    pub fn reversed(&self) -> Self {
        Self::new(self.points.iter().rev().copied())
    }

    fn bounds(&self) -> Bounds {
        let mut b = Bounds {
            min: Vec2::new(f64::INFINITY, f64::INFINITY),
            max: Vec2::new(f64::NEG_INFINITY, f64::NEG_INFINITY),
        };
        for p in &self.points {
            b.min.x = b.min.x.min(p.x);
            b.min.y = b.min.y.min(p.y);
            b.max.x = b.max.x.max(p.x);
            b.max.y = b.max.y.max(p.y);
        }
        b
    }
}

#[derive(Debug, Clone, Copy)]
struct Bounds {
    min: Vec2,
    max: Vec2,
}

impl Bounds {
    /// Lower bound on the distance from `p` to anything inside the box.
    #[inline]
    fn distance_lower_bound(&self, p: Vec2) -> f64 {
        let dx = (self.min.x - p.x).max(0.0).max(p.x - self.max.x);
        let dy = (self.min.y - p.y).max(0.0).max(p.y - self.max.y);
        hypot(dx, dy)
    }
}

/// Derived geometry of one lane in storage order, xodr-local metres.
#[derive(Debug, Clone, PartialEq)]
pub struct LaneGeometry {
    pub path: Polyline,
    pub speed_limit_mps: f64,
    /// Representative width; see [`LaneGraph::width_at`] for the sampled width.
    pub width_m: f64,
}

impl LaneGeometry {
    #[inline]
    pub fn length_m(&self) -> f64 {
        self.path.length_m()
    }
}

/// A junction movement with its lanes resolved to graph handles. Lanes named
/// by the gate but absent from the graph (no usable polyline) are dropped from
/// `exits` and reported as `None` for `approach` / `connecting`.
#[derive(Debug, Clone, PartialEq)]
pub struct Gate {
    pub spec: TopologyGate,
    pub approach: Option<LaneId>,
    pub connecting: Option<LaneId>,
    pub exits: Vec<LaneId>,
}

impl Gate {
    #[inline]
    pub fn turn_relation(&self) -> TurnRelation {
        self.spec.turn_relation
    }

    #[inline]
    pub fn heading_change_rad(&self) -> f64 {
        self.spec.heading_change_rad
    }

    #[inline]
    pub fn id(&self) -> &str {
        &self.spec.id
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LateralNeighbour {
    pub lane: LaneId,
    pub legal: bool,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NearestLane {
    pub lane: LaneId,
    /// Storage arc length of the nearest point.
    pub s: f64,
    pub d: f64,
}

/// Filter for [`LaneGraph::nearest_lane`]. Defaults to driving lanes within 25 m.
#[derive(Debug, Clone, Copy)]
pub struct NearestLaneQuery<'a> {
    pub lane_types: &'a [&'a str],
    pub max_dist_m: f64,
}

impl Default for NearestLaneQuery<'static> {
    fn default() -> Self {
        Self {
            lane_types: &["driving"],
            max_dist_m: 25.0,
        }
    }
}

/// Read-only, immutable view of one map's drivable geometry. Building it is
/// O(lanes + links); callers build once and share across runs and worlds.
#[derive(Debug)]
pub struct LaneGraph {
    map_name: String,
    topology_digest: String,
    schema_version: Option<u32>,
    /// Sorted; index == `LaneId`.
    rsls: Vec<Box<str>>,
    lanes: Vec<TopologyLane>,
    geom: Vec<LaneGeometry>,
    bounds: Vec<Bounds>,
    /// `succ[succ_offsets[slot]..succ_offsets[slot + 1]]` are the directed
    /// successors of the directed lane with that [`DirectedLane::slot`].
    succ_offsets: Vec<u32>,
    succ: Vec<DirectedLane>,
    /// Sorted by gate id.
    gates: Vec<Gate>,
    gates_by_approach: Vec<Vec<GateId>>,
    gates_by_connecting: Vec<Vec<GateId>>,
    junctions: BTreeMap<String, TopologyJunction>,
}

impl LaneGraph {
    /// Build a graph from a decoded topology index. Lanes with fewer than two
    /// distinct polyline vertices have no usable geometry and are not interned.
    pub fn new(index: TopologyIndex) -> Self {
        let TopologyIndex {
            schema_version,
            map_name,
            source,
            lanes,
            gates,
            junctions,
        } = index;
        let topology_digest = source.and_then(|s| s.xodr_sha256).unwrap_or_default();

        let mut rsls: Vec<Box<str>> = Vec::with_capacity(lanes.len());
        let mut kept: Vec<TopologyLane> = Vec::with_capacity(lanes.len());
        let mut geom: Vec<LaneGeometry> = Vec::with_capacity(lanes.len());
        let mut bounds: Vec<Bounds> = Vec::with_capacity(lanes.len());
        // `BTreeMap` iterates in sorted key order.
        for (rsl, lane) in lanes {
            let path = Polyline::new(lane.polyline.iter().copied());
            if path.len() < 2 {
                continue;
            }
            let speed_limit_mps = match lane.speed_limit_kph {
                Some(kph) if kph > 0.0 => kph / 3.6,
                _ => DEFAULT_SPEED_LIMIT_MPS,
            };
            let width_m = match lane.representative_width_m {
                Some(w) if w > 0.0 => w,
                _ => DEFAULT_LANE_WIDTH_M,
            };
            bounds.push(path.bounds());
            geom.push(LaneGeometry {
                path,
                speed_limit_mps,
                width_m,
            });
            rsls.push(rsl.into_boxed_str());
            kept.push(lane);
        }

        let mut graph = Self {
            map_name: map_name.unwrap_or_else(|| "unknown".to_owned()),
            topology_digest,
            schema_version,
            rsls,
            lanes: kept,
            geom,
            bounds,
            succ_offsets: Vec::new(),
            succ: Vec::new(),
            gates: Vec::new(),
            gates_by_approach: Vec::new(),
            gates_by_connecting: Vec::new(),
            junctions,
        };

        let mut sorted_gates = gates;
        sorted_gates.sort_by(|a, b| a.id.cmp(&b.id));
        graph.gates_by_approach = vec![Vec::new(); graph.lanes.len()];
        graph.gates_by_connecting = vec![Vec::new(); graph.lanes.len()];
        graph.gates.reserve(sorted_gates.len());
        for (i, spec) in sorted_gates.into_iter().enumerate() {
            let id = GateId(i as u32);
            let approach = graph.lane_id(&spec.approach_lane_rsl);
            let connecting = graph.lane_id(&spec.connecting_lane_rsl);
            let exits = spec
                .exit_lane_rsls
                .iter()
                .filter_map(|r| graph.lane_id(r))
                .collect();
            if let Some(a) = approach {
                graph.gates_by_approach[a.index()].push(id);
            }
            if let Some(c) = connecting {
                graph.gates_by_connecting[c.index()].push(id);
            }
            graph.gates.push(Gate {
                spec,
                approach,
                connecting,
                exits,
            });
        }

        graph.build_successors();
        graph
    }

    fn build_successors(&mut self) {
        let n = self.lanes.len();
        let mut offsets = Vec::with_capacity(2 * n + 1);
        let mut succ: Vec<DirectedLane> = Vec::new();
        let mut candidates: Vec<LaneId> = Vec::new();
        offsets.push(0u32);
        for i in 0..n {
            let lane = LaneId(i as u32);
            candidates.clear();
            for rsl in self.lanes[i]
                .successors
                .iter()
                .chain(self.lanes[i].predecessors.iter())
            {
                if let Some(id) = self.lane_id(rsl) {
                    if id != lane {
                        candidates.push(id);
                    }
                }
            }
            candidates.sort_unstable();
            candidates.dedup();
            for reversed in [false, true] {
                let exit = self.endpoints(DirectedLane { lane, reversed }).exit;
                for &c in &candidates {
                    if let Some(oriented) = self.orient_toward(c, exit, ENDPOINT_TOL_M) {
                        succ.push(oriented);
                    }
                }
                offsets.push(succ.len() as u32);
            }
        }
        self.succ_offsets = offsets;
        self.succ = succ;
    }

    /* -------------------------------------------------------------- identity */

    pub fn map_name(&self) -> &str {
        &self.map_name
    }

    pub fn topology_digest(&self) -> &str {
        &self.topology_digest
    }

    pub fn schema_version(&self) -> Option<u32> {
        self.schema_version
    }

    #[inline]
    pub fn lane_count(&self) -> usize {
        self.lanes.len()
    }

    /// Every interned lane, in rsl order.
    pub fn lane_ids(&self) -> impl ExactSizeIterator<Item = LaneId> + '_ {
        (0..self.lanes.len() as u32).map(LaneId)
    }

    /// Every lane rsl with usable geometry, sorted.
    pub fn lane_rsls(&self) -> impl ExactSizeIterator<Item = &str> + '_ {
        self.rsls.iter().map(|s| s.as_ref())
    }

    /// Resolve a canonical rsl to its handle. `None` when the lane is not in
    /// the topology or has no usable polyline.
    pub fn lane_id(&self, rsl: &str) -> Option<LaneId> {
        self.rsls
            .binary_search_by(|probe| probe.as_ref().cmp(rsl))
            .ok()
            .map(|i| LaneId(i as u32))
    }

    #[inline]
    pub fn rsl(&self, lane: LaneId) -> &str {
        &self.rsls[lane.index()]
    }

    #[inline]
    pub fn lane(&self, lane: LaneId) -> &TopologyLane {
        &self.lanes[lane.index()]
    }

    #[inline]
    pub fn geometry(&self, lane: LaneId) -> &LaneGeometry {
        &self.geom[lane.index()]
    }

    #[inline]
    pub fn length_of(&self, lane: LaneId) -> f64 {
        self.geom[lane.index()].path.length_m()
    }

    #[inline]
    pub fn is_driving(&self, lane: LaneId) -> bool {
        self.lanes[lane.index()].lane_type == "driving"
    }

    pub fn junctions(&self) -> &BTreeMap<String, TopologyJunction> {
        &self.junctions
    }

    /* -------------------------------------------------------------- geometry */

    /// Lane width at storage arc length `s`, interpolated from `widthSamples`.
    pub fn width_at(&self, lane: LaneId, s: f64) -> f64 {
        let g = &self.geom[lane.index()];
        let samples = &self.lanes[lane.index()].width_samples;
        match samples.len() {
            0 => return g.width_m,
            1 => return samples[0].width_m,
            _ => {}
        }
        let q = clamp(s, 0.0, g.length_m());
        if q <= samples[0].s {
            return samples[0].width_m;
        }
        for i in 1..samples.len() {
            let a = samples[i - 1];
            let b = samples[i];
            if q <= b.s {
                let span = b.s - a.s;
                let t = if span > 1e-9 { (q - a.s) / span } else { 0.0 };
                return a.width_m + (b.width_m - a.width_m) * t;
            }
        }
        samples[samples.len() - 1].width_m
    }

    /// Pose at arc length `s` measured **in the traversal direction** of `d`.
    /// `s` is clamped to the lane.
    pub fn sample_directed(&self, d: DirectedLane, s: f64) -> PathSample {
        let g = &self.geom[d.lane.index()];
        let storage_s = if d.reversed { g.length_m() - s } else { s };
        let sample = g.path.sample(storage_s);
        if d.reversed {
            PathSample {
                point: sample.point,
                heading_rad: sample.heading_rad + std::f64::consts::PI,
            }
        } else {
            sample
        }
    }

    /// Pose at arc length `s` in **storage** order.
    #[inline]
    pub fn sample_storage(&self, lane: LaneId, s: f64) -> PathSample {
        self.geom[lane.index()].path.sample(s)
    }

    /// Entry / exit endpoints of a directed lane.
    pub fn endpoints(&self, d: DirectedLane) -> Endpoints {
        let path = &self.geom[d.lane.index()].path;
        let first = path.points()[0];
        let last = path.points()[path.len() - 1];
        if d.reversed {
            Endpoints {
                entry: last,
                exit: first,
            }
        } else {
            Endpoints {
                entry: first,
                exit: last,
            }
        }
    }

    /// The orientation OpenDRIVE implies for a lane travelled legally: negative
    /// lane ids run along `+s`, positive ids against it. Junction connecting
    /// lanes return `None`: their storage direction is not reliable, so the
    /// caller resolves them geometrically.
    #[inline]
    pub fn nominal_reversed(&self, lane: LaneId) -> Option<bool> {
        let l = &self.lanes[lane.index()];
        if l.is_junction {
            None
        } else {
            Some(l.lane_id > 0)
        }
    }

    /// The orientations a lane may legally be traversed in: its nominal one, or
    /// both for junction connectors.
    #[inline]
    pub fn admissible_orientations(&self, lane: LaneId) -> impl Iterator<Item = bool> {
        match self.nominal_reversed(lane) {
            Some(r) => [Some(r), None].into_iter().flatten(),
            None => [Some(false), Some(true)].into_iter().flatten(),
        }
    }

    /// Orientation to use when a lane is entered from `from_point`.
    pub fn orient_toward(&self, lane: LaneId, from_point: Vec2, tol: f64) -> Option<DirectedLane> {
        let mut best: Option<(bool, f64)> = None;
        for reversed in self.admissible_orientations(lane) {
            let d = dist(
                self.endpoints(DirectedLane { lane, reversed }).entry,
                from_point,
            );
            if d <= tol && best.is_none_or(|(_, bd)| d < bd) {
                best = Some((reversed, d));
            }
        }
        best.map(|(reversed, _)| DirectedLane { lane, reversed })
    }

    /// Directed successors, sorted by rsl then orientation. A neighbour counts
    /// when one of its admissible orientations starts within [`ENDPOINT_TOL_M`]
    /// of our exit point.
    #[inline]
    pub fn successors(&self, d: DirectedLane) -> &[DirectedLane] {
        let slot = d.slot();
        let lo = self.succ_offsets[slot] as usize;
        let hi = self.succ_offsets[slot + 1] as usize;
        &self.succ[lo..hi]
    }

    /* ----------------------------------------------------------------- gates */

    #[inline]
    pub fn gate(&self, id: GateId) -> &Gate {
        &self.gates[id.index()]
    }

    /// All gates, sorted by id.
    pub fn gates(&self) -> &[Gate] {
        &self.gates
    }

    /// Gates leaving an approach lane, sorted by gate id.
    pub fn gates_from(
        &self,
        approach: LaneId,
    ) -> impl ExactSizeIterator<Item = &Gate> + Clone + '_ {
        self.gates_by_approach[approach.index()]
            .iter()
            .map(move |g| &self.gates[g.index()])
    }

    /// Gates whose connecting lane is `connecting` (used to name a turn in progress).
    pub fn gates_via(
        &self,
        connecting: LaneId,
    ) -> impl ExactSizeIterator<Item = &Gate> + Clone + '_ {
        self.gates_by_connecting[connecting.index()]
            .iter()
            .map(move |g| &self.gates[g.index()])
    }

    /// Turn relation of the first gate (by id) that uses `connecting`, if any.
    pub fn turn_relation_of(&self, connecting: LaneId) -> Option<TurnRelation> {
        self.gates_via(connecting).next().map(Gate::turn_relation)
    }

    /* ---------------------------------------------------------------- lateral */

    /// Same-direction lateral neighbour, if a lane change to `side` (in
    /// **storage** orientation) is possible at storage arc length `s`.
    /// `legal_only` consults `laneChangePermissions`.
    pub fn lateral_neighbour(
        &self,
        lane: LaneId,
        side: LaneSide,
        s: f64,
        legal_only: bool,
    ) -> Option<LateralNeighbour> {
        let l = &self.lanes[lane.index()];
        let adj = l.adjacent(side)?;
        if !adj.same_direction {
            return None;
        }
        let neighbour = self.lane_id(adj.lane_rsl.as_deref()?)?;
        let perms = &l.lane_change_permissions;
        // No data ⇒ permissive, matching the index's own default.
        let mut legal = perms.is_empty();
        for id in &adj.permission_ids {
            let Some(p) = perms.iter().find(|q| q.id == *id) else {
                continue;
            };
            if s >= p.start_s - 1e-6 && s <= p.end_s + 1e-6 {
                legal = p.allowed;
            }
        }
        if legal_only && !legal {
            return None;
        }
        Some(LateralNeighbour {
            lane: neighbour,
            legal,
        })
    }

    /* ----------------------------------------------------------------- search */

    /// Nearest point on a lane to `p`, in storage arc length.
    #[inline]
    pub fn project_onto(&self, lane: LaneId, p: Vec2) -> PolylineProjection {
        // Interned lanes always have ≥ 2 vertices.
        self.geom[lane.index()]
            .path
            .project(p)
            .unwrap_or(PolylineProjection {
                s: 0.0,
                d: f64::INFINITY,
            })
    }

    /// Nearest lane of an admitted type to a point, searched in rsl order so
    /// ties break deterministically (first lane wins within `1e-9`).
    pub fn nearest_lane(&self, p: Vec2, query: NearestLaneQuery<'_>) -> Option<NearestLane> {
        let mut best: Option<NearestLane> = None;
        for i in 0..self.lanes.len() {
            if !query.lane_types.contains(&self.lanes[i].lane_type.as_str()) {
                continue;
            }
            let bound = self.bounds[i].distance_lower_bound(p);
            if bound > query.max_dist_m || best.is_some_and(|b| bound >= b.d - 1e-9) {
                continue;
            }
            let proj = self.project_onto(LaneId(i as u32), p);
            if proj.d > query.max_dist_m {
                continue;
            }
            if best.is_none_or(|b| proj.d < b.d - 1e-9) {
                best = Some(NearestLane {
                    lane: LaneId(i as u32),
                    s: proj.s,
                    d: proj.d,
                });
            }
        }
        best
    }
}
