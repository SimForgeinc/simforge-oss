//! Deterministic sequential-impulse OBB contact solver with swept
//! time-of-impact rewind. Bodies carry an integer `rank` (the caller's
//! canonical id order); pair processing is canonicalised by rank so actor
//! declaration order cannot alter the result. Infinite-mass bodies
//! (`inverse_mass == 0`) are the explicit kinematic/static policy.
//!
//! The solver owns reusable numeric scratch: every `solve` call clears and
//! refills the same buffers, so a steady-state world step performs no heap
//! allocation once capacities have grown to the working set.

use serde::{Deserialize, Serialize};

use crate::math::{
    angle_delta, hypot, lerp, lerp_angle, obb_corners, obb_overlap, sin_cos, Obb, Vec2,
};

const CONTACT_SLOP_M: f64 = 0.002;
const MAX_POSITION_CORRECTION_M: f64 = 0.25;
const VELOCITY_ITERATIONS: usize = 8;
const POSITION_ITERATIONS: usize = 4;
const EPSILON: f64 = 1e-9;
/// Upper bound on the position-of-impact carry after a swept rewind, seconds.
const POST_IMPACT_CARRY_S: f64 = 0.001;
const SWEEP_CONTACT_EPSILON_M: f64 = 1e-9;
const SWEEP_MAX_ITERATIONS: usize = 256;
/// Every displacement the solve can apply beyond the swept envelope: the
/// positional correction budget plus contact tolerance. Envelopes expanded by
/// this (plus the carry) make the broadphase conservative.
const BROADPHASE_MARGIN_M: f64 =
    MAX_POSITION_CORRECTION_M * POSITION_ITERATIONS as f64 + CONTACT_SLOP_M;

/// Restitution applied to genuine impacts (closing faster than 1 m/s).
pub const DEFAULT_CONTACT_RESTITUTION: f64 = 0.08;
/// Coulomb friction coefficient between contacting footprints.
pub const DEFAULT_CONTACT_FRICTION: f64 = 0.65;

/// Pose at the start of the interval, the origin of a body's sweep.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactPose {
    pub x: f64,
    pub y: f64,
    pub yaw_rad: f64,
}

/// A dynamic planar body as seen by the solver. Velocities are world-frame.
/// The solver mutates pose and velocity in place. `rank` is the body's
/// position in the caller's canonical order across dynamic and static bodies
/// and must be unique.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PlanarCollisionBody {
    pub rank: u32,
    pub length_m: f64,
    pub width_m: f64,
    pub inverse_mass: f64,
    pub inverse_inertia: f64,
    pub previous: ContactPose,
    pub x: f64,
    pub y: f64,
    pub yaw_rad: f64,
    pub vx: f64,
    pub vy: f64,
    pub angular_velocity: f64,
}

/// Infinite-mass collider: map geometry, props, fixed actors, or a
/// kinematically driven actor whose surface velocity is supplied.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PlanarStaticCollider {
    pub rank: u32,
    pub obb: Obb,
    /// Kinematic surface velocity. Static props/map geometry leave this zero.
    pub velocity: Vec2,
    pub angular_velocity: f64,
}

impl PlanarStaticCollider {
    pub fn fixed(rank: u32, obb: Obb) -> Self {
        Self {
            rank,
            obb,
            velocity: Vec2::ZERO,
            angular_velocity: 0.0,
        }
    }
}

/// Which caller slice a contact participant came from, and its slot there.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "slot")]
pub enum ContactRef {
    Dynamic(u32),
    Static(u32),
}

/// Accumulated impulse between one contact pair over one solve. `a` has the
/// lower rank.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollisionImpulse {
    pub a: ContactRef,
    pub b: ContactRef,
    pub normal_impulse_ns: f64,
    pub tangent_impulse_ns: f64,
}

#[derive(Debug, Clone, Copy)]
struct SolverBody {
    origin: ContactRef,
    rank: u32,
    length_m: f64,
    width_m: f64,
    inverse_mass: f64,
    inverse_inertia: f64,
    previous: ContactPose,
    x: f64,
    y: f64,
    yaw_rad: f64,
    vx: f64,
    vy: f64,
    angular_velocity: f64,
}

#[derive(Debug, Clone, Copy)]
struct Envelope {
    min_x: f64,
    max_x: f64,
    min_y: f64,
    max_y: f64,
}

struct Manifold {
    /// Always points from A toward B.
    normal: Vec2,
    point: Vec2,
    penetration_m: f64,
}

#[derive(Debug, Clone, Copy)]
struct PairTotal {
    a: u32,
    b: u32,
    normal: f64,
    tangent: f64,
}

#[inline]
fn obb_of(body: &SolverBody) -> Obb {
    Obb {
        center: Vec2 {
            x: body.x,
            y: body.y,
        },
        length_m: body.length_m,
        width_m: body.width_m,
        heading_rad: body.yaw_rad,
    }
}

#[inline]
fn previous_obb_of(body: &SolverBody) -> Obb {
    Obb {
        center: Vec2 {
            x: body.previous.x,
            y: body.previous.y,
        },
        length_m: body.length_m,
        width_m: body.width_m,
        heading_rad: body.previous.yaw_rad,
    }
}

#[inline]
fn axes(obb: &Obb) -> [Vec2; 2] {
    let (s, c) = sin_cos(obb.heading_rad);
    [Vec2 { x: c, y: s }, Vec2 { x: -s, y: c }]
}

#[inline]
fn radius_on(obb: &Obb, axis: Vec2) -> f64 {
    let basis = axes(obb);
    axis.dot(basis[0]).abs() * obb.length_m / 2.0 + axis.dot(basis[1]).abs() * obb.width_m / 2.0
}

/// SAT manifold. The normal always points from A toward B.
fn manifold(a: &Obb, b: &Obb, tolerance_m: f64) -> Option<Manifold> {
    let delta = b.center - a.center;
    let mut minimum = f64::INFINITY;
    let mut normal = Vec2 { x: 1.0, y: 0.0 };
    let [a0, a1] = axes(a);
    let [b0, b1] = axes(b);
    for axis in [a0, a1, b0, b1] {
        let signed_distance = delta.dot(axis);
        let overlap = radius_on(a, axis) + radius_on(b, axis) - signed_distance.abs();
        if overlap < -tolerance_m {
            return None;
        }
        if overlap < minimum {
            minimum = overlap;
            let sign = if signed_distance < 0.0 { -1.0 } else { 1.0 };
            normal = axis * sign;
        }
    }
    let ra = radius_on(a, normal);
    let rb = radius_on(b, normal);
    let point_a = a.center + normal * ra;
    let point_b = b.center - normal * rb;
    Some(Manifold {
        normal,
        point: (point_a + point_b) * 0.5,
        penetration_m: minimum.max(0.0),
    })
}

#[inline]
fn velocity_at(body: &SolverBody, point: Vec2) -> Vec2 {
    let rx = point.x - body.x;
    let ry = point.y - body.y;
    Vec2 {
        x: body.vx - body.angular_velocity * ry,
        y: body.vy + body.angular_velocity * rx,
    }
}

#[inline]
fn apply_impulse(body: &mut SolverBody, impulse: Vec2, point: Vec2, sign: f64) {
    body.vx += sign * impulse.x * body.inverse_mass;
    body.vy += sign * impulse.y * body.inverse_mass;
    let arm = Vec2 {
        x: point.x - body.x,
        y: point.y - body.y,
    };
    body.angular_velocity += sign * arm.cross(impulse) * body.inverse_inertia;
}

#[inline]
fn effective_mass(a: &SolverBody, b: &SolverBody, point: Vec2, axis: Vec2) -> f64 {
    let ra = Vec2 {
        x: point.x - a.x,
        y: point.y - a.y,
    };
    let rb = Vec2 {
        x: point.x - b.x,
        y: point.y - b.y,
    };
    let ca = ra.cross(axis);
    let cb = rb.cross(axis);
    a.inverse_mass + b.inverse_mass + ca * ca * a.inverse_inertia + cb * cb * b.inverse_inertia
}

#[inline]
fn contact_for_pair(a: &SolverBody, b: &SolverBody) -> Option<Manifold> {
    manifold(&obb_of(a), &obb_of(b), CONTACT_SLOP_M)
}

#[inline]
fn pair_mut(bodies: &mut [SolverBody], i: usize, j: usize) -> (&mut SolverBody, &mut SolverBody) {
    debug_assert!(i < j);
    let (head, tail) = bodies.split_at_mut(j);
    (&mut head[i], &mut tail[0])
}

/// Axis-aligned envelope of everything the body can occupy during this solve:
/// its footprint at the previous and current pose, the post-impact carry, and
/// the positional-correction budget.
fn envelope_of(body: &SolverBody) -> Envelope {
    let half = hypot(body.length_m, body.width_m) / 2.0;
    let carry = hypot(body.vx, body.vy) * POST_IMPACT_CARRY_S;
    let reach = half
        + carry
        + if body.inverse_mass > 0.0 {
            BROADPHASE_MARGIN_M
        } else {
            CONTACT_SLOP_M
        };
    Envelope {
        min_x: body.x.min(body.previous.x) - reach,
        max_x: body.x.max(body.previous.x) + reach,
        min_y: body.y.min(body.previous.y) - reach,
        max_y: body.y.max(body.previous.y) + reach,
    }
}

fn rewind_swept_contact(a: &mut SolverBody, b: &mut SolverBody, dt_s: f64) {
    if manifold(&obb_of(a), &obb_of(b), 0.0).is_some() {
        return;
    }
    let Some(toi) = swept_obb_time_of_impact(
        &previous_obb_of(a),
        &obb_of(a),
        &previous_obb_of(b),
        &obb_of(b),
    ) else {
        return;
    };
    if toi >= 1.0 {
        return;
    }
    let remaining = (1.0 - toi).max(0.0) * dt_s;
    let carry = remaining.min(POST_IMPACT_CARRY_S);
    if a.inverse_mass > 0.0 {
        a.x = lerp(a.previous.x, a.x, toi) + a.vx * carry;
        a.y = lerp(a.previous.y, a.y, toi) + a.vy * carry;
        a.yaw_rad = lerp_angle(a.previous.yaw_rad, a.yaw_rad, toi);
    }
    if b.inverse_mass > 0.0 {
        b.x = lerp(b.previous.x, b.x, toi) + b.vx * carry;
        b.y = lerp(b.previous.y, b.y, toi) + b.vy * carry;
        b.yaw_rad = lerp_angle(b.previous.yaw_rad, b.yaw_rad, toi);
    }
}

/// Reusable contact solver. Construct once per world and call
/// [`PlanarContactSolver::solve`] every step; all scratch is retained.
#[derive(Debug, Default)]
pub struct PlanarContactSolver {
    /// Dynamic then static bodies, sorted by rank.
    bodies: Vec<SolverBody>,
    envelopes: Vec<Envelope>,
    /// Body indices sorted by envelope `min_x` for sweep-and-prune.
    sweep: Vec<u32>,
    /// Candidate pairs `(i, j)` with `i < j`, in canonical order.
    pairs: Vec<(u32, u32)>,
    totals: Vec<PairTotal>,
    impulses: Vec<CollisionImpulse>,
}

impl PlanarContactSolver {
    pub fn new() -> Self {
        Self::default()
    }

    /// Reserve scratch for `dynamic + statics` bodies so steady-state solves
    /// do not grow buffers.
    pub fn reserve(&mut self, bodies: usize) {
        self.bodies.reserve(bodies);
        self.envelopes.reserve(bodies);
        self.sweep.reserve(bodies);
    }

    /// Impulses from the most recent solve, canonical `(a, b)` rank order.
    pub fn impulses(&self) -> &[CollisionImpulse] {
        &self.impulses
    }

    /// Resolve every dynamic/dynamic and dynamic/static contact for one
    /// interval. `dynamic` bodies are updated in place (pose after swept
    /// rewind and positional correction, velocity after the impulse
    /// iterations). Returns the per-pair accumulated impulses referencing
    /// caller slots.
    pub fn solve(
        &mut self,
        dynamic: &mut [PlanarCollisionBody],
        statics: &[PlanarStaticCollider],
        dt_s: f64,
        restitution: f64,
        friction: f64,
    ) -> &[CollisionImpulse] {
        self.bodies.clear();
        for (slot, body) in dynamic.iter().enumerate() {
            self.bodies.push(SolverBody {
                origin: ContactRef::Dynamic(slot as u32),
                rank: body.rank,
                length_m: body.length_m,
                width_m: body.width_m,
                inverse_mass: body.inverse_mass,
                inverse_inertia: body.inverse_inertia,
                previous: body.previous,
                x: body.x,
                y: body.y,
                yaw_rad: body.yaw_rad,
                vx: body.vx,
                vy: body.vy,
                angular_velocity: body.angular_velocity,
            });
        }
        for (slot, collider) in statics.iter().enumerate() {
            self.bodies.push(SolverBody {
                origin: ContactRef::Static(slot as u32),
                rank: collider.rank,
                length_m: collider.obb.length_m,
                width_m: collider.obb.width_m,
                inverse_mass: 0.0,
                inverse_inertia: 0.0,
                previous: ContactPose {
                    x: collider.obb.center.x,
                    y: collider.obb.center.y,
                    yaw_rad: collider.obb.heading_rad,
                },
                x: collider.obb.center.x,
                y: collider.obb.center.y,
                yaw_rad: collider.obb.heading_rad,
                vx: collider.velocity.x,
                vy: collider.velocity.y,
                angular_velocity: collider.angular_velocity,
            });
        }
        // Ranks are unique, so an unstable sort is deterministic.
        self.bodies.sort_unstable_by_key(|b| b.rank);

        // Conservative swept broadphase: only pairs whose envelopes overlap
        // can ever produce a manifold during this solve, so skipping the rest
        // leaves the sequential-impulse sequence unchanged.
        self.envelopes.clear();
        self.envelopes.extend(self.bodies.iter().map(envelope_of));
        self.sweep.clear();
        self.sweep.extend(0..self.bodies.len() as u32);
        let envelopes = &self.envelopes;
        self.sweep.sort_unstable_by(|&i, &j| {
            envelopes[i as usize]
                .min_x
                .partial_cmp(&envelopes[j as usize].min_x)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(i.cmp(&j))
        });
        self.pairs.clear();
        for (s, &i) in self.sweep.iter().enumerate() {
            let ei = envelopes[i as usize];
            let dynamic_i = self.bodies[i as usize].inverse_mass > 0.0;
            for &j in &self.sweep[s + 1..] {
                let ej = envelopes[j as usize];
                if ej.min_x > ei.max_x {
                    break;
                }
                if ej.min_y > ei.max_y || ej.max_y < ei.min_y {
                    continue;
                }
                if !dynamic_i && self.bodies[j as usize].inverse_mass <= 0.0 {
                    continue;
                }
                self.pairs.push(if i < j { (i, j) } else { (j, i) });
            }
        }
        self.pairs.sort_unstable();

        let bodies = &mut self.bodies;
        for &(i, j) in &self.pairs {
            let (a, b) = pair_mut(bodies, i as usize, j as usize);
            rewind_swept_contact(a, b, dt_s);
        }

        self.totals.clear();
        for _ in 0..VELOCITY_ITERATIONS {
            for &(i, j) in &self.pairs {
                let (a, b) = pair_mut(bodies, i as usize, j as usize);
                let Some(contact) = contact_for_pair(a, b) else {
                    continue;
                };
                let va = velocity_at(a, contact.point);
                let vb = velocity_at(b, contact.point);
                let closing = (vb - va).dot(contact.normal);
                let normal_mass = effective_mass(a, b, contact.point, contact.normal);
                if normal_mass <= EPSILON {
                    continue;
                }
                // Restitution is only applied to genuine impacts. Persistent/
                // resting contacts use zero bounce, preventing energy injection
                // and chatter.
                let bounce = if closing < -1.0 { restitution } else { 0.0 };
                let bias = if contact.penetration_m > CONTACT_SLOP_M {
                    (0.15 * (contact.penetration_m - CONTACT_SLOP_M) / dt_s.max(EPSILON)).min(2.0)
                } else {
                    0.0
                };
                let normal_impulse = ((-(1.0 + bounce) * closing + bias) / normal_mass).max(0.0);
                if normal_impulse <= EPSILON {
                    continue;
                }
                let impulse = contact.normal * normal_impulse;
                apply_impulse(a, impulse, contact.point, -1.0);
                apply_impulse(b, impulse, contact.point, 1.0);

                let tangent = Vec2 {
                    x: -contact.normal.y,
                    y: contact.normal.x,
                };
                let va2 = velocity_at(a, contact.point);
                let vb2 = velocity_at(b, contact.point);
                let tangent_speed = (vb2 - va2).dot(tangent);
                let tangent_mass = effective_mass(a, b, contact.point, tangent);
                let raw_tangent = if tangent_mass > EPSILON {
                    -tangent_speed / tangent_mass
                } else {
                    0.0
                };
                let tangent_impulse = raw_tangent
                    .min(friction * normal_impulse)
                    .max(-friction * normal_impulse);
                let friction_impulse = tangent * tangent_impulse;
                apply_impulse(a, friction_impulse, contact.point, -1.0);
                apply_impulse(b, friction_impulse, contact.point, 1.0);

                match self.totals.iter_mut().find(|t| t.a == i && t.b == j) {
                    Some(total) => {
                        total.normal += normal_impulse;
                        total.tangent += tangent_impulse.abs();
                    }
                    None => self.totals.push(PairTotal {
                        a: i,
                        b: j,
                        normal: normal_impulse,
                        tangent: tangent_impulse.abs(),
                    }),
                }
            }
        }

        for _ in 0..POSITION_ITERATIONS {
            for &(i, j) in &self.pairs {
                let (a, b) = pair_mut(bodies, i as usize, j as usize);
                let Some(contact) = contact_for_pair(a, b) else {
                    continue;
                };
                if contact.penetration_m <= CONTACT_SLOP_M {
                    continue;
                }
                let inverse_mass = a.inverse_mass + b.inverse_mass;
                if inverse_mass <= EPSILON {
                    continue;
                }
                let correction =
                    (0.8 * (contact.penetration_m - CONTACT_SLOP_M)).min(MAX_POSITION_CORRECTION_M);
                let share_a = correction * a.inverse_mass / inverse_mass;
                let share_b = correction * b.inverse_mass / inverse_mass;
                a.x -= contact.normal.x * share_a;
                a.y -= contact.normal.y * share_a;
                b.x += contact.normal.x * share_b;
                b.y += contact.normal.y * share_b;
            }
        }

        for body in bodies.iter() {
            if let ContactRef::Dynamic(slot) = body.origin {
                let target = &mut dynamic[slot as usize];
                target.x = body.x;
                target.y = body.y;
                target.yaw_rad = body.yaw_rad;
                target.vx = body.vx;
                target.vy = body.vy;
                target.angular_velocity = body.angular_velocity;
            }
        }

        // Bodies are rank-sorted and i < j, so (i, j) order is canonical
        // regardless of which velocity iteration first touched a pair.
        self.totals.sort_unstable_by_key(|t| (t.a, t.b));
        self.impulses.clear();
        self.impulses
            .extend(self.totals.iter().map(|t| CollisionImpulse {
                a: bodies[t.a as usize].origin,
                b: bodies[t.b as usize].origin,
                normal_impulse_ns: t.normal,
                tangent_impulse_ns: t.tangent,
            }));
        &self.impulses
    }
}

#[inline]
fn projection_radius(obb: &Obb, ax: f64, ay: f64) -> f64 {
    let (s, c) = sin_cos(obb.heading_rad);
    (c * ax + s * ay).abs() * (obb.length_m / 2.0) + (-s * ax + c * ay).abs() * (obb.width_m / 2.0)
}

fn fixed_orientation_sweep(a0: &Obb, a1: &Obb, b0: &Obb, b1: &Obb) -> Option<f64> {
    let mut enter = 0.0f64;
    let mut leave = 1.0f64;
    let (sa, ca) = sin_cos(a0.heading_rad);
    let (sb, cb) = sin_cos(b0.heading_rad);
    let axes = [(ca, sa), (-sa, ca), (cb, sb), (-sb, cb)];
    let rel0 = b0.center - a0.center;
    let rel_delta = (b1.center - b0.center) - (a1.center - a0.center);
    for (ax, ay) in axes {
        let radius = projection_radius(a0, ax, ay) + projection_radius(b0, ax, ay);
        let p = rel0.x * ax + rel0.y * ay;
        let v = rel_delta.x * ax + rel_delta.y * ay;
        if v.abs() < 1e-15 {
            if p.abs() > radius {
                return None;
            }
            continue;
        }
        let t0 = (-radius - p) / v;
        let t1 = (radius - p) / v;
        enter = enter.max(t0.min(t1));
        leave = leave.min(t0.max(t1));
        if enter > leave {
            return None;
        }
    }
    if enter <= 1.0 && leave >= 0.0 {
        Some(enter.max(0.0))
    } else {
        None
    }
}

#[inline]
fn obb_at(from: &Obb, to: &Obb, t: f64) -> Obb {
    Obb {
        center: Vec2 {
            x: lerp(from.center.x, to.center.x, t),
            y: lerp(from.center.y, to.center.y, t),
        },
        length_m: lerp(from.length_m, to.length_m, t),
        width_m: lerp(from.width_m, to.width_m, t),
        heading_rad: lerp_angle(from.heading_rad, to.heading_rad, t),
    }
}

/// Maximum separating-axis gap. Non-positive means the OBBs overlap. This is
/// a lower bound on the true surface distance, which is what conservative
/// advancement needs.
fn sat_separation(a: &Obb, b: &Obb) -> f64 {
    let ca = obb_corners(a);
    let cb = obb_corners(b);
    let (sa, cosa) = sin_cos(a.heading_rad);
    let (sb, cosb) = sin_cos(b.heading_rad);
    let axes = [(cosa, sa), (-sa, cosa), (cosb, sb), (-sb, cosb)];
    let mut separation = f64::NEG_INFINITY;
    for (ax, ay) in axes {
        let mut alo = f64::INFINITY;
        let mut ahi = f64::NEG_INFINITY;
        let mut blo = f64::INFINITY;
        let mut bhi = f64::NEG_INFINITY;
        for p in ca {
            let v = p.x * ax + p.y * ay;
            alo = alo.min(v);
            ahi = ahi.max(v);
        }
        for p in cb {
            let v = p.x * ax + p.y * ay;
            blo = blo.min(v);
            bhi = bhi.max(v);
        }
        separation = separation.max((blo - ahi).max(alo - bhi));
    }
    separation
}

/// Continuous OBB collision over one integration interval; returns the first
/// contact as a fraction of the interval, or `None` when the boxes never meet.
///
/// Translation with fixed headings uses an exact swept SAT. Rotating boxes use
/// deterministic conservative advancement with a bound on corner velocity, so
/// an overlap cannot be stepped over. The returned value is stable for the same
/// IEEE-754 inputs and does not depend on wall-clock iteration budgets.
pub fn swept_obb_time_of_impact(a0: &Obb, a1: &Obb, b0: &Obb, b1: &Obb) -> Option<f64> {
    if obb_overlap(a0, b0) {
        return Some(0.0);
    }
    let da = angle_delta(a0.heading_rad, a1.heading_rad);
    let db = angle_delta(b0.heading_rad, b1.heading_rad);
    let dimensions_stable = (a1.length_m - a0.length_m).abs() < 1e-12
        && (a1.width_m - a0.width_m).abs() < 1e-12
        && (b1.length_m - b0.length_m).abs() < 1e-12
        && (b1.width_m - b0.width_m).abs() < 1e-12;
    if da.abs() < 1e-12 && db.abs() < 1e-12 && dimensions_stable {
        return fixed_orientation_sweep(a0, a1, b0, b1);
    }

    let relative_travel = hypot(
        (b1.center.x - b0.center.x) - (a1.center.x - a0.center.x),
        (b1.center.y - b0.center.y) - (a1.center.y - a0.center.y),
    );
    let speed_bound = relative_travel
        + da.abs() * hypot(a0.length_m, a0.width_m) / 2.0
        + db.abs() * hypot(b0.length_m, b0.width_m) / 2.0
        + hypot(a1.length_m - a0.length_m, a1.width_m - a0.width_m) / 2.0
        + hypot(b1.length_m - b0.length_m, b1.width_m - b0.width_m) / 2.0;
    if speed_bound <= 0.0 {
        return None;
    }

    let mut t = 0.0f64;
    let mut iteration = 0;
    while iteration < SWEEP_MAX_ITERATIONS && t <= 1.0 {
        let a = obb_at(a0, a1, t);
        let b = obb_at(b0, b1, t);
        let separation = sat_separation(&a, &b);
        if separation <= SWEEP_CONTACT_EPSILON_M || obb_overlap(&a, &b) {
            return Some(t);
        }
        let step = separation / speed_bound;
        if step <= 1e-14 {
            return Some(t);
        }
        t += step;
        iteration += 1;
    }
    if t <= 1.0 && obb_overlap(&obb_at(a0, a1, t), &obb_at(b0, b1, t)) {
        return Some(t);
    }
    None
}
