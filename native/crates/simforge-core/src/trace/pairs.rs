//! Pairwise kinematic readouts — the numbers both trigger conditions and the
//! episode metrics are built from, computed once per tick per pair.
//!
//! The simplifications, stated plainly:
//!
//! - **Clearance** uses each actor's circumscribed radius (`hypot(l, w) / 2`),
//!   not the OBB, so `minDistance` is slightly conservative for non-square
//!   footprints. Collision detection uses the real OBBs, so a "distance 0"
//!   reading never disagrees with a collision flag by more than corner slack.
//!   The exact footprint clearance is available after the fact from
//!   [`crate::evaluation::min_clearance`].
//! - **TTC** is the constant-velocity time at which the actors' *oriented
//!   footprints* first touch, gated by a circumscribed-circle broad phase.
//! - **Path conflict** samples the actors' actual future routes and intersects
//!   the resulting chords: path-TTC when their conflict-zone occupancy windows
//!   overlap, predicted PET when they do not.
//! - **Along-lane distance** is measured on the *first* actor's route; `None`
//!   when the other actor is not on that route.
//!
//! Everything is generic over [`PairActor`], the read-only view the engine's
//! runtime actor implements, so no engine type is named here.

use crate::map::route::Route;
use crate::math::{angle_delta, dist, hypot, lerp, segment_intersection, sin, Obb, Vec2};
use crate::physics::{swept_obb_time_of_impact, MotionDirection};
use crate::types::{ActorKind, Dims};

const VELOCITY_EPSILON_MPS: f64 = 1e-6;
/// Five metres matches the controller's conflict scan and preserves the exact
/// intersections of each sampled chord while keeping per-tick pair work small.
const PATH_SAMPLE_STEP_M: f64 = 5.0;
pub const PATH_HORIZON_S: f64 = 12.0;
const TTC_HORIZON_S: f64 = 30.0;
const PATH_MIN_CROSSING_ANGLE_RAD: f64 = 0.15;

pub const DOOR_OPEN_DURATION_S: f64 = 1.0;
pub const DOOR_MAX_OPEN_ANGLE_RAD: f64 = std::f64::consts::PI * 0.39;

/// The read-only actor view every pair readout consumes.
pub trait PairActor {
    fn id(&self) -> &str;
    fn kind(&self) -> ActorKind;
    fn dims(&self) -> Dims;
    fn is_static(&self) -> bool;
    /// Exists in the world on this tick.
    fn is_present(&self) -> bool;
    /// Motion/interaction has finished; retired bodies leave the metric set.
    fn is_retired(&self) -> bool;
    fn position(&self) -> Vec2;
    fn heading_rad(&self) -> f64;
    fn speed_mps(&self) -> f64;
    fn motion_direction(&self) -> MotionDirection;
    fn route(&self) -> &Route;
    fn route_s(&self) -> f64;
    fn lateral_offset_m(&self) -> f64;
    /// Lateral coordinate `future_s` seconds ahead on the current route,
    /// following the active lateral command's profile (or constant when none).
    fn predicted_lateral_offset_m(&self, now_s: f64, future_s: f64) -> f64;
}

/// Circumscribed radius used by the coarse pair metrics (TTC, min distance).
#[inline]
pub fn actor_radius(dims: Dims) -> f64 {
    hypot(dims.l, dims.w) / 2.0
}

#[inline]
pub fn velocity_of<A: PairActor + ?Sized>(a: &A) -> Vec2 {
    Vec2::from_heading(a.heading_rad()) * (a.speed_mps() * a.motion_direction().sign())
}

#[inline]
pub fn footprint_obb<A: PairActor + ?Sized>(a: &A) -> Obb {
    let dims = a.dims();
    Obb {
        center: a.position(),
        length_m: dims.l,
        width_m: dims.w,
        heading_rad: a.heading_rad(),
    }
}

/// Canonical unordered pair key `lo|hi`.
pub fn pair_key(a: &str, b: &str) -> String {
    let (lo, hi) = ordered_pair(a, b);
    format!("{lo}|{hi}")
}

#[inline]
pub fn ordered_pair<'a>(a: &'a str, b: &'a str) -> (&'a str, &'a str) {
    if a < b {
        (a, b)
    } else {
        (b, a)
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PairReadout {
    /// Surface-to-surface separation in metres (never negative).
    pub gap_m: f64,
    /// Centre-to-centre distance.
    pub center_dist_m: f64,
    /// Closing speed along the line of centres, m/s (negative = separating).
    pub closing_mps: f64,
    /// Constant-velocity seconds to footprint contact, `INFINITY` on a miss.
    pub ttc_s: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PathConflictReadout {
    /// Time until both footprints occupy the route conflict zone.
    pub path_ttc_s: f64,
    /// Predicted post-encroachment time; zero means occupancy overlaps.
    pub pet_s: f64,
    /// Route intersection in xodr-local metres.
    pub conflict_point: Vec2,
    /// Centre arrival times at the route intersection.
    pub arrival_a_s: f64,
    pub arrival_b_s: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StaticPathConflict {
    pub path_ttc_s: f64,
    pub conflict_point: Vec2,
}

pub fn read_pair<A: PairActor + ?Sized, B: PairActor + ?Sized>(a: &A, b: &B) -> PairReadout {
    let pa = a.position();
    let pb = b.position();
    let center_dist = dist(pa, pb);
    let clearance = actor_radius(a.dims()) + actor_radius(b.dims());
    let gap = (center_dist - clearance).max(0.0);
    if center_dist < 1e-9 {
        return PairReadout {
            gap_m: 0.0,
            center_dist_m: 0.0,
            closing_mps: 0.0,
            ttc_s: 0.0,
        };
    }
    let ux = (pb.x - pa.x) / center_dist;
    let uy = (pb.y - pa.y) / center_dist;
    let va = velocity_of(a);
    let vb = velocity_of(b);
    let closing = (va.x - vb.x) * ux + (va.y - vb.y) * uy;
    // Circumscribed circles are a cheap conservative broad phase: an OBB hit is
    // impossible when the circles never meet.
    let rvx = vb.x - va.x;
    let rvy = vb.y - va.y;
    let px = pb.x - pa.x;
    let py = pb.y - pa.y;
    let qa = rvx * rvx + rvy * rvy;
    let qb = 2.0 * (px * rvx + py * rvy);
    let qc = px * px + py * py - clearance * clearance;
    let mut circle_can_hit = qc <= 0.0;
    if !circle_can_hit && qa > VELOCITY_EPSILON_MPS * VELOCITY_EPSILON_MPS {
        let discriminant = qb * qb - 4.0 * qa * qc;
        if discriminant >= 0.0 {
            let first = (-qb - discriminant.sqrt()) / (2.0 * qa);
            circle_can_hit = first >= 0.0 && first <= TTC_HORIZON_S;
        }
    }
    if !circle_can_hit {
        return PairReadout {
            gap_m: gap,
            center_dist_m: center_dist,
            closing_mps: closing,
            ttc_s: f64::INFINITY,
        };
    }
    // TTC must agree with the physical footprints: circumscribed-circle TTC
    // turns legal opposing traffic in adjacent lanes into an immediate contact.
    let a0 = footprint_obb(a);
    let b0 = footprint_obb(b);
    let a1 = Obb {
        center: pa + va * TTC_HORIZON_S,
        ..a0
    };
    let b1 = Obb {
        center: pb + vb * TTC_HORIZON_S,
        ..b0
    };
    let ttc = swept_obb_time_of_impact(&a0, &a1, &b0, &b1)
        .map_or(f64::INFINITY, |toi| toi * TTC_HORIZON_S);
    PairReadout {
        gap_m: gap,
        center_dist_m: center_dist,
        closing_mps: closing,
        ttc_s: ttc,
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PathSample {
    pub point: Vec2,
    pub distance_m: f64,
}

/// Reusable sample buffers so per-tick path prediction never allocates.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct PathScratch {
    a: Vec<PathSample>,
    b: Vec<PathSample>,
}

impl PathScratch {
    pub fn new() -> Self {
        Self {
            a: Vec::with_capacity(64),
            b: Vec::with_capacity(64),
        }
    }
}

fn future_path<A: PairActor + ?Sized>(
    a: &A,
    horizon_s: f64,
    now_s: f64,
    out: &mut Vec<PathSample>,
) {
    out.clear();
    let position = a.position();
    let speed = a.speed_mps();
    let max_distance = (a.route().length_m() - a.route_s()).min(speed * horizon_s);
    out.push(PathSample {
        point: position,
        distance_m: 0.0,
    });
    if max_distance <= 0.0 {
        return;
    }
    let route = a.route();
    let route_s = a.route_s();
    let speed_floor = speed.max(VELOCITY_EPSILON_MPS);
    let mut d = PATH_SAMPLE_STEP_M;
    while d < max_distance {
        out.push(PathSample {
            point: route.point_with_offset(
                route_s + d,
                a.predicted_lateral_offset_m(now_s, d / speed_floor),
            ),
            distance_m: d,
        });
        d += PATH_SAMPLE_STEP_M;
    }
    out.push(PathSample {
        point: route.point_with_offset(
            route_s + max_distance,
            a.predicted_lateral_offset_m(now_s, max_distance / speed_floor),
        ),
        distance_m: max_distance,
    });
}

fn path_bounds(path: &[PathSample]) -> (Vec2, Vec2) {
    let mut lo = Vec2::new(f64::INFINITY, f64::INFINITY);
    let mut hi = Vec2::new(f64::NEG_INFINITY, f64::NEG_INFINITY);
    for s in path {
        lo.x = lo.x.min(s.point.x);
        lo.y = lo.y.min(s.point.y);
        hi.x = hi.x.max(s.point.x);
        hi.y = hi.y.max(s.point.y);
    }
    (lo, hi)
}

/// Predict the nearest crossing of the actors' sampled future routes.
///
/// Each footprint occupies the intersection during
/// `arrival ± circumscribedRadius / speed`. Overlapping windows produce a
/// finite path-TTC; disjoint windows produce a positive predicted PET.
/// Parallel following paths return `None` because [`read_pair`] owns
/// rear-end and head-on conflicts.
pub fn read_path_conflict<A: PairActor + ?Sized, B: PairActor + ?Sized>(
    a: &A,
    b: &B,
    horizon_s: f64,
    now_s: f64,
    scratch: &mut PathScratch,
) -> Option<PathConflictReadout> {
    let speed_a = a.speed_mps();
    let speed_b = b.speed_mps();
    if speed_a <= VELOCITY_EPSILON_MPS || speed_b <= VELOCITY_EPSILON_MPS {
        return None;
    }
    future_path(a, horizon_s, now_s, &mut scratch.a);
    future_path(b, horizon_s, now_s, &mut scratch.b);
    let aa = &scratch.a;
    let bb = &scratch.b;
    let (alo, ahi) = path_bounds(aa);
    let (blo, bhi) = path_bounds(bb);
    if ahi.x < blo.x || bhi.x < alo.x || ahi.y < blo.y || bhi.y < alo.y {
        return None;
    }
    let radius_a = actor_radius(a.dims());
    let radius_b = actor_radius(b.dims());
    let mut best: Option<PathConflictReadout> = None;
    let mut best_criticality = f64::INFINITY;
    for i in 0..aa.len().saturating_sub(1) {
        let a0 = aa[i];
        let a1 = aa[i + 1];
        let ad = a1.point - a0.point;
        let ah = ad.heading();
        for j in 0..bb.len().saturating_sub(1) {
            let b0 = bb[j];
            let b1 = bb[j + 1];
            if a0.point.x.max(a1.point.x) < b0.point.x.min(b1.point.x)
                || b0.point.x.max(b1.point.x) < a0.point.x.min(a1.point.x)
                || a0.point.y.max(a1.point.y) < b0.point.y.min(b1.point.y)
                || b0.point.y.max(b1.point.y) < a0.point.y.min(a1.point.y)
            {
                continue;
            }
            let bh = (b1.point - b0.point).heading();
            let crossing = angle_delta(ah, bh).abs();
            if crossing < PATH_MIN_CROSSING_ANGLE_RAD
                || (std::f64::consts::PI - crossing).abs() < PATH_MIN_CROSSING_ANGLE_RAD
            {
                continue;
            }
            let Some(ta) = segment_intersection(a0.point, a1.point, b0.point, b1.point) else {
                continue;
            };
            let Some(tb) = segment_intersection(b0.point, b1.point, a0.point, a1.point) else {
                continue;
            };
            let distance_a = lerp(a0.distance_m, a1.distance_m, ta);
            let distance_b = lerp(b0.distance_m, b1.distance_m, tb);
            let arrival_a = distance_a / speed_a;
            let arrival_b = distance_b / speed_b;
            if arrival_a > horizon_s || arrival_b > horizon_s {
                continue;
            }
            let occupancy_a = radius_a / speed_a;
            let occupancy_b = radius_b / speed_b;
            let entry_a = (arrival_a - occupancy_a).max(0.0);
            let exit_a = arrival_a + occupancy_a;
            let entry_b = (arrival_b - occupancy_b).max(0.0);
            let exit_b = arrival_b + occupancy_b;
            let overlap = exit_a.min(exit_b) >= entry_a.max(entry_b);
            let path_ttc_s = if overlap {
                entry_a.max(entry_b)
            } else {
                f64::INFINITY
            };
            let pet_s = if overlap {
                0.0
            } else if entry_a > exit_b {
                entry_a - exit_b
            } else {
                entry_b - exit_a
            };
            let criticality = arrival_a.max(arrival_b);
            if criticality < best_criticality {
                best_criticality = criticality;
                best = Some(PathConflictReadout {
                    path_ttc_s,
                    pet_s,
                    conflict_point: Vec2::new(
                        lerp(a0.point.x, a1.point.x, ta),
                        lerp(a0.point.y, a1.point.y, ta),
                    ),
                    arrival_a_s: arrival_a,
                    arrival_b_s: arrival_b,
                });
            }
        }
    }
    best
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DoorName {
    Left,
    Right,
    Rear,
}

impl DoorName {
    pub const fn as_str(self) -> &'static str {
        match self {
            DoorName::Left => "left",
            DoorName::Right => "right",
            DoorName::Rear => "rear",
        }
    }

    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "left" => Some(DoorName::Left),
            "right" => Some(DoorName::Right),
            "rear" => Some(DoorName::Rear),
            _ => None,
        }
    }

    /// Collider name as recorded in collision events: `door:<name>`.
    pub const fn collider_name(self) -> &'static str {
        match self {
            DoorName::Left => "door:left",
            DoorName::Right => "door:right",
            DoorName::Rear => "door:rear",
        }
    }
}

/// Ground-plane OBB for a vehicle door at a normalized opening fraction.
pub fn articulated_door_obb(
    position: Vec2,
    heading_rad: f64,
    kind: ActorKind,
    dims: Dims,
    name: DoorName,
    openness: f64,
) -> Obb {
    let open = openness.clamp(0.0, 1.0);
    let forward = Vec2::from_heading(heading_rad);
    let left = forward.perp_left();
    if name == DoorName::Rear {
        let panel_width = dims.w * 0.82;
        let extension = (dims.h * 0.62 * sin(open * DOOR_MAX_OPEN_ANGLE_RAD)).max(0.025);
        return Obb {
            center: position - forward * (dims.l / 2.0 + extension / 2.0),
            length_m: panel_width,
            width_m: extension,
            heading_rad: heading_rad + std::f64::consts::FRAC_PI_2,
        };
    }
    let side = if name == DoorName::Left { 1.0 } else { -1.0 };
    if kind == ActorKind::Bus {
        // Transit entrance doors fold/slide in the body envelope; a thin
        // longitudinal panel flush with the side slides rearward as it opens.
        let length = (dims.l * 0.14).min(1.35);
        let thickness = (dims.w * 0.012).max(0.025);
        let longitudinal = dims.l * 0.3 - open * length * 0.8;
        return Obb {
            center: position
                + forward * longitudinal
                + left * (side * (dims.w / 2.0 + thickness / 2.0)),
            length_m: length,
            width_m: thickness,
            heading_rad,
        };
    }
    let length = dims.l * 0.34;
    let thickness = (dims.w * 0.018).max(0.025);
    let door_heading = heading_rad - side * open * DOOR_MAX_OPEN_ANGLE_RAD;
    let door_forward = Vec2::from_heading(door_heading);
    let hinge =
        position + forward * (dims.l * 0.16) + left * (side * (dims.w / 2.0 + thickness / 2.0));
    Obb {
        center: hinge - door_forward * (length / 2.0),
        length_m: length,
        width_m: thickness,
        heading_rad: door_heading,
    }
}

/// Route-aware OBB TTC from one moving actor to one static collidable actor.
pub fn read_static_path_conflict<M: PairActor + ?Sized, F: PairActor + ?Sized>(
    moving: &M,
    fixed: &F,
    horizon_s: f64,
    now_s: f64,
    scratch: &mut PathScratch,
) -> Option<StaticPathConflict> {
    read_static_obb_path_conflict(moving, &footprint_obb(fixed), horizon_s, now_s, scratch)
}

/// Route-aware OBB TTC from one moving actor to a fixed collision shape.
pub fn read_static_obb_path_conflict<M: PairActor + ?Sized>(
    moving: &M,
    fixed_obb: &Obb,
    horizon_s: f64,
    now_s: f64,
    scratch: &mut PathScratch,
) -> Option<StaticPathConflict> {
    let speed = moving.speed_mps();
    if speed <= VELOCITY_EPSILON_MPS {
        return None;
    }
    future_path(moving, horizon_s, now_s, &mut scratch.a);
    let path = &scratch.a;
    let dims = moving.dims();
    let route = moving.route();
    let route_s = moving.route_s();
    for i in 0..path.len().saturating_sub(1) {
        let from = path[i];
        let to = path[i + 1];
        let moving_from = Obb {
            center: from.point,
            length_m: dims.l,
            width_m: dims.w,
            heading_rad: route.pose_at(route_s + from.distance_m).heading_rad,
        };
        let moving_to = Obb {
            center: to.point,
            length_m: dims.l,
            width_m: dims.w,
            heading_rad: route.pose_at(route_s + to.distance_m).heading_rad,
        };
        let Some(toi) = swept_obb_time_of_impact(&moving_from, &moving_to, fixed_obb, fixed_obb)
        else {
            continue;
        };
        let distance_m = lerp(from.distance_m, to.distance_m, toi);
        return Some(StaticPathConflict {
            path_ttc_s: distance_m / speed,
            conflict_point: Vec2::new(
                lerp(from.point.x, to.point.x, toi),
                lerp(from.point.y, to.point.y, toi),
            ),
        });
    }
    None
}

/// Signed along-route distance from `observer` to `other`, measured on the
/// observer's route. Positive = ahead. `None` when `other` is not on the route.
pub fn along_route_distance<A: PairActor + ?Sized, B: PairActor + ?Sized>(
    observer: &A,
    other: &B,
) -> Option<f64> {
    let route = observer.route();
    if route.is_freeform() {
        return None;
    }
    let other_pose = other.route().pose_at(other.route_s());
    let lane = other_pose.lane?;
    let s = route.s_of_lane_storage(lane, other_pose.storage_s)?;
    Some(s - observer.route_s())
}

/// Bumper-to-bumper along-route gap, or `None`.
pub fn along_route_gap_m<A: PairActor + ?Sized, B: PairActor + ?Sized>(
    observer: &A,
    other: &B,
) -> Option<f64> {
    let d = along_route_distance(observer, other)?;
    let halves = observer.dims().l / 2.0 + other.dims().l / 2.0;
    let sign = if d == 0.0 { 1.0 } else { d.signum() };
    Some(d - sign * halves)
}

/// Time headway `gap / v` from `observer` to `other`, or `None`.
pub fn headway_s<A: PairActor + ?Sized, B: PairActor + ?Sized>(
    observer: &A,
    other: &B,
) -> Option<f64> {
    let gap = along_route_gap_m(observer, other)?;
    if observer.speed_mps() < 1e-3 {
        return Some(if gap <= 0.0 { 0.0 } else { f64::INFINITY });
    }
    Some(gap / observer.speed_mps())
}

/// Lateral separation between two actors measured on the observer's route —
/// "is this actor in my lane?" without a lane-identity join.
pub fn lateral_separation_m<A: PairActor + ?Sized, B: PairActor + ?Sized>(
    observer: &A,
    other: &B,
) -> Option<f64> {
    let d = along_route_distance(observer, other)?;
    let s = observer.route_s() + d;
    Some(observer.route().lateral_offset_at(s, other.position()) - observer.lateral_offset_m())
}
