//! Contact ownership handoff between an externally simulated traffic
//! population and the native contact solver.
//!
//! An external provider (the browser SUMO bridge) owns its road users until an
//! authored vehicle, or a body this world already owns, strikes one hard
//! enough. From that contact on the struck vehicle is a driverless planar
//! rigid body of the [`PlanarContactSolver`]: it coasts under rolling
//! resistance and drag, collides with every other released body and with the
//! map's static colliders, and the host mirrors it back to the provider as
//! occupancy. The authored striker leaves its trace at the same instant and
//! becomes a body too, so later trace commands never drag it through the
//! wreck. Ownership is monotonic until [`TrafficHandoffWorld::clear`].
//!
//! Frame: the scene ground plane `(x, z)` the provider bridge samples, mapped
//! onto the solver's `(x, y)` as `y = z` with headings `(cos h, sin h)`. That
//! is a mirror image of the xodr-local frame; planar contact physics is
//! mirror-symmetric, so nothing here depends on the handedness.

use std::collections::HashMap;

use crate::math::{clamp, exp, hypot, lerp, normalize_angle, obb_overlap, sin_cos, Obb, Vec2};

use super::collision::{
    swept_obb_time_of_impact, ContactPose, PlanarCollisionBody, PlanarContactSolver,
    PlanarStaticCollider, DEFAULT_CONTACT_FRICTION,
};

/// Closing speed below which a contact never transfers ownership, m/s. Slower
/// touches are car-following noise the provider keeps resolving itself.
pub const HANDOFF_MIN_IMPACT_SPEED_MPS: f64 = 1.25;
/// Restitution between released bodies, other traffic and map geometry.
pub const HANDOFF_RESTITUTION: f64 = 0.18;
const LINEAR_DRAG_PER_SECOND: f64 = 0.7;
const ROLLING_DECELERATION_MPS2: f64 = 2.8;
const ANGULAR_DRAG_PER_SECOND: f64 = 2.8;
const MAX_KNOCKBACK_SPEED_MPS: f64 = 32.0;
const MAX_ANGULAR_SPEED_RAD_S: f64 = 1.8;
const SUBSTEP_S: f64 = 1.0 / 60.0;
/// A host may hand over an arbitrarily long catch-up interval; released bodies
/// are integrated for at most this long per step.
const MAX_INTEGRATED_SECONDS: f64 = 1.0;
const STOP_SPEED_MPS: f64 = 0.03;
const STOP_ANGULAR_SPEED_RAD_S: f64 = 0.01;
/// Slack added to the released bodies' envelope when selecting the static
/// colliders a step can touch, beyond travel and footprint.
const STATIC_QUERY_MARGIN_M: f64 = 2.0;

/// Which population a released body left.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum HandoffOrigin {
    /// Provider-owned traffic struck into physics.
    Traffic,
    /// An authored road user whose trace stopped commanding it at contact.
    Authored,
}

/// One road user sampled in the scene ground plane for a handoff step.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HandoffActor<'a> {
    pub id: &'a str,
    /// Actor kind name (`car`, `bus`, …): selects the mass class and, for
    /// authored actors, whether the actor may initiate a handoff at all.
    pub kind: &'a str,
    pub x: f64,
    pub z: f64,
    pub heading_rad: f64,
    pub speed_mps: f64,
    pub length_m: f64,
    pub width_m: f64,
    /// Absent actors never initiate a handoff.
    pub present: bool,
    /// Fixed objects and parked actors never initiate a handoff.
    pub is_static: bool,
}

impl HandoffActor<'_> {
    #[inline]
    fn obb(&self) -> Obb {
        Obb {
            center: Vec2 {
                x: self.x,
                y: self.z,
            },
            length_m: self.length_m,
            width_m: self.width_m,
            heading_rad: self.heading_rad,
        }
    }

    #[inline]
    fn velocity(&self) -> Vec2 {
        Vec2::from_heading(self.heading_rad) * self.speed_mps
    }
}

/// A road user released from its owner into the contact solver.
#[derive(Debug, Clone, PartialEq)]
pub struct HandoffBody {
    pub id: String,
    pub origin: HandoffOrigin,
    pub length_m: f64,
    pub width_m: f64,
    pub mass_kg: f64,
    pub x: f64,
    pub z: f64,
    pub heading_rad: f64,
    pub vx: f64,
    pub vz: f64,
    pub angular_velocity_rad_s: f64,
}

impl HandoffBody {
    #[inline]
    pub fn speed_mps(&self) -> f64 {
        hypot(self.vx, self.vz)
    }

    #[inline]
    fn obb(&self) -> Obb {
        Obb {
            center: Vec2 {
                x: self.x,
                y: self.z,
            },
            length_m: self.length_m,
            width_m: self.width_m,
            heading_rad: self.heading_rad,
        }
    }

    #[inline]
    fn velocity(&self) -> Vec2 {
        Vec2 {
            x: self.vx,
            y: self.vz,
        }
    }

    #[inline]
    fn yaw_inertia_kg_m2(&self) -> f64 {
        self.mass_kg * (self.length_m * self.length_m + self.width_m * self.width_m) / 12.0
    }

    fn limit(&mut self) {
        let speed = self.speed_mps();
        if speed > MAX_KNOCKBACK_SPEED_MPS {
            let scale = MAX_KNOCKBACK_SPEED_MPS / speed;
            self.vx *= scale;
            self.vz *= scale;
        }
        self.angular_velocity_rad_s = clamp(
            self.angular_velocity_rad_s,
            -MAX_ANGULAR_SPEED_RAD_S,
            MAX_ANGULAR_SPEED_RAD_S,
        );
    }
}

/// Pose at the start of the interval a body sweeps through.
#[derive(Debug, Clone, Copy, PartialEq)]
struct SweepOrigin {
    x: f64,
    z: f64,
    heading_rad: f64,
}

#[derive(Debug, Clone, Copy)]
struct PriorSample {
    x: f64,
    z: f64,
    heading_rad: f64,
    stamp: u64,
}

/// Deterministic ownership handoff world. Construct once per provider run,
/// call [`TrafficHandoffWorld::step`] after every provider interval, and read
/// [`TrafficHandoffWorld::bodies`] for presentation and occupancy feedback.
/// Steady-state steps perform no heap allocation once the working set has
/// grown; only a newly seen actor id allocates.
#[derive(Debug, Default)]
pub struct TrafficHandoffWorld {
    /// Released bodies in promotion order; the order is the solver's canonical
    /// rank, so it is part of the deterministic state.
    bodies: Vec<HandoffBody>,
    origins: Vec<SweepOrigin>,
    traffic_slots: HashMap<String, usize>,
    authored_slots: HashMap<String, usize>,
    previous_authored: HashMap<String, PriorSample>,
    previous_traffic: HashMap<String, PriorSample>,
    stamp: u64,
    statics: Vec<PlanarStaticCollider>,
    /// Static colliders within reach of the released bodies for this step.
    near_statics: Vec<PlanarStaticCollider>,
    solver: PlanarContactSolver,
    scratch: Vec<PlanarCollisionBody>,
}

impl TrafficHandoffWorld {
    pub fn new() -> Self {
        Self::default()
    }

    /// Replace the map geometry released bodies collide with. `obbs` are in
    /// this world's ground plane (`center.y` is scene `z`). Retained across
    /// [`Self::clear`].
    pub fn set_static_colliders(&mut self, obbs: &[Obb]) {
        self.statics.clear();
        self.statics.extend(
            obbs.iter()
                .enumerate()
                .map(|(rank, obb)| PlanarStaticCollider::fixed(rank as u32, *obb)),
        );
    }

    /// Released bodies in promotion order.
    pub fn bodies(&self) -> &[HandoffBody] {
        &self.bodies
    }

    /// Provider actors currently owned by physics.
    pub fn traffic_body_count(&self) -> usize {
        self.traffic_slots.len()
    }

    /// Return every actor to its owner (a provider reset or a timeline rewind).
    pub fn clear(&mut self) {
        self.bodies.clear();
        self.origins.clear();
        self.traffic_slots.clear();
        self.authored_slots.clear();
        self.previous_authored.clear();
        self.previous_traffic.clear();
    }

    /// Advance released bodies by `dt_s`, then transfer ownership for every
    /// new contact between an authored vehicle or released body and a
    /// provider-owned actor. `authored` and `traffic` are this interval's
    /// samples in host order; an actor already released is matched by id and
    /// its sample ignored. Returns the number of provider actors released
    /// during this step. Non-positive or non-finite intervals are ignored.
    pub fn step(
        &mut self,
        dt_s: f64,
        authored: &[HandoffActor<'_>],
        traffic: &[HandoffActor<'_>],
    ) -> usize {
        if !dt_s.is_finite() || dt_s <= 0.0 {
            return 0;
        }
        let traffic_before = self.traffic_slots.len();
        self.select_near_statics(dt_s.min(MAX_INTEGRATED_SECONDS));
        self.integrate(dt_s);
        let bodies_before = self.bodies.len();
        self.detect_authored_contacts(dt_s, authored, traffic);
        self.detect_pile_ups(bodies_before, traffic);
        if self.bodies.len() > bodies_before {
            self.select_near_statics(dt_s.min(MAX_INTEGRATED_SECONDS));
            self.solve(dt_s.min(MAX_INTEGRATED_SECONDS));
        }
        self.remember(authored, traffic);
        self.traffic_slots.len() - traffic_before
    }

    fn detect_authored_contacts(
        &mut self,
        dt_s: f64,
        authored: &[HandoffActor<'_>],
        traffic: &[HandoffActor<'_>],
    ) {
        for source in authored {
            if !source.present
                || source.is_static
                || !initiates_handoff(source.kind)
                || source.speed_mps < HANDOFF_MIN_IMPACT_SPEED_MPS
                || self.authored_slots.contains_key(source.id)
            {
                continue;
            }
            let prior_source = prior_pose(&self.previous_authored, source, dt_s);
            let source_obb = source.obb();
            let prior_source_obb = obb_at(&source_obb, prior_source);
            for target in traffic {
                if self.traffic_slots.contains_key(target.id) {
                    continue;
                }
                let prior_target = prior_pose(&self.previous_traffic, target, dt_s);
                let target_obb = target.obb();
                let toi = swept_obb_time_of_impact(
                    &prior_source_obb,
                    &source_obb,
                    &obb_at(&target_obb, prior_target),
                    &target_obb,
                );
                if toi.is_none() && !obb_overlap(&source_obb, &target_obb) {
                    continue;
                }
                if self.handoff(
                    source,
                    prior_source,
                    target,
                    prior_target,
                    toi.unwrap_or(1.0),
                ) {
                    break;
                }
            }
        }
    }

    /// Ownership transfer for a first authored contact. The impact normal is
    /// taken between the two centres at the time of impact, so the gate sees
    /// the true closing speed even when the boxes already overlap.
    fn handoff(
        &mut self,
        source: &HandoffActor<'_>,
        prior_source: SweepOrigin,
        target: &HandoffActor<'_>,
        prior_target: SweepOrigin,
        toi: f64,
    ) -> bool {
        let impact_source = Vec2 {
            x: lerp(prior_source.x, source.x, toi),
            y: lerp(prior_source.z, source.z, toi),
        };
        let impact_target = Vec2 {
            x: lerp(prior_target.x, target.x, toi),
            y: lerp(prior_target.z, target.z, toi),
        };
        let normal = contact_normal(impact_target - impact_source, source.heading_rad);
        let closing = (source.velocity() - target.velocity()).dot(normal);
        if closing < HANDOFF_MIN_IMPACT_SPEED_MPS {
            return false;
        }
        self.release(target, HandoffOrigin::Traffic, prior_target);
        self.release(source, HandoffOrigin::Authored, prior_source);
        true
    }

    /// A body already released can strike provider traffic itself, producing
    /// deterministic pile-ups without promoting the rest of the population.
    /// Only bodies that existed before this step's detection chain; a body
    /// released just now waits for the next interval.
    fn detect_pile_ups(&mut self, body_count: usize, traffic: &[HandoffActor<'_>]) {
        for slot in 0..body_count {
            let body_obb = self.bodies[slot].obb();
            for target in traffic {
                if self.traffic_slots.contains_key(target.id) {
                    continue;
                }
                if !obb_overlap(&body_obb, &target.obb()) {
                    continue;
                }
                if self.handoff_from_body(slot, target) {
                    break;
                }
            }
        }
    }

    fn handoff_from_body(&mut self, slot: usize, target: &HandoffActor<'_>) -> bool {
        let body = &self.bodies[slot];
        let normal = contact_normal(
            Vec2 {
                x: target.x - body.x,
                y: target.z - body.z,
            },
            body.heading_rad,
        );
        let closing = (body.velocity() - target.velocity()).dot(normal);
        if closing < HANDOFF_MIN_IMPACT_SPEED_MPS {
            return false;
        }
        let origin = SweepOrigin {
            x: target.x,
            z: target.z,
            heading_rad: target.heading_rad,
        };
        self.release(target, HandoffOrigin::Traffic, origin);
        true
    }

    fn release(&mut self, actor: &HandoffActor<'_>, origin: HandoffOrigin, sweep: SweepOrigin) {
        let slot = self.bodies.len();
        let velocity = actor.velocity();
        self.bodies.push(HandoffBody {
            id: actor.id.to_owned(),
            origin,
            length_m: actor.length_m,
            width_m: actor.width_m,
            mass_kg: vehicle_mass_kg(actor.kind, actor.length_m, actor.width_m),
            x: actor.x,
            z: actor.z,
            heading_rad: actor.heading_rad,
            vx: velocity.x,
            vz: velocity.y,
            angular_velocity_rad_s: 0.0,
        });
        self.origins.push(sweep);
        let slots = match origin {
            HandoffOrigin::Traffic => &mut self.traffic_slots,
            HandoffOrigin::Authored => &mut self.authored_slots,
        };
        slots.insert(actor.id.to_owned(), slot);
    }

    /// Coast every released body through fixed substeps: rolling resistance,
    /// aerodynamic-style drag and yaw damping, with the contact solver
    /// resolving body/body and body/map contacts after each substep.
    fn integrate(&mut self, dt_s: f64) {
        if self.bodies.is_empty() {
            return;
        }
        let mut remaining = dt_s.min(MAX_INTEGRATED_SECONDS);
        while remaining > 1e-9 {
            let h = remaining.min(SUBSTEP_S);
            for (body, origin) in self.bodies.iter_mut().zip(self.origins.iter_mut()) {
                *origin = SweepOrigin {
                    x: body.x,
                    z: body.z,
                    heading_rad: body.heading_rad,
                };
                body.x += body.vx * h;
                body.z += body.vz * h;
                body.heading_rad =
                    normalize_angle(body.heading_rad + body.angular_velocity_rad_s * h);
                let speed = body.speed_mps();
                let next_speed = ((speed - ROLLING_DECELERATION_MPS2 * h)
                    * exp(-LINEAR_DRAG_PER_SECOND * h))
                .max(0.0);
                if speed > 1e-9 {
                    let scale = next_speed / speed;
                    body.vx *= scale;
                    body.vz *= scale;
                }
                body.angular_velocity_rad_s *= exp(-ANGULAR_DRAG_PER_SECOND * h);
            }
            self.solve(h);
            for body in &mut self.bodies {
                if body.speed_mps() < STOP_SPEED_MPS {
                    body.vx = 0.0;
                    body.vz = 0.0;
                }
                if body.angular_velocity_rad_s.abs() < STOP_ANGULAR_SPEED_RAD_S {
                    body.angular_velocity_rad_s = 0.0;
                }
            }
            remaining -= h;
        }
    }

    /// One contact solve over every released body and the nearby map
    /// geometry. Each body sweeps from its `origins` pose to its current pose.
    fn solve(&mut self, dt_s: f64) {
        let base = self.statics.len() as u32;
        self.scratch.clear();
        for (slot, (body, origin)) in self.bodies.iter().zip(&self.origins).enumerate() {
            self.scratch.push(PlanarCollisionBody {
                rank: base + slot as u32,
                length_m: body.length_m,
                width_m: body.width_m,
                inverse_mass: 1.0 / body.mass_kg,
                inverse_inertia: 1.0 / body.yaw_inertia_kg_m2(),
                previous: ContactPose {
                    x: origin.x,
                    y: origin.z,
                    yaw_rad: origin.heading_rad,
                },
                x: body.x,
                y: body.z,
                yaw_rad: body.heading_rad,
                vx: body.vx,
                vy: body.vz,
                angular_velocity: body.angular_velocity_rad_s,
            });
        }
        self.solver.solve(
            &mut self.scratch,
            &self.near_statics,
            dt_s,
            HANDOFF_RESTITUTION,
            DEFAULT_CONTACT_FRICTION,
        );
        for (body, solved) in self.bodies.iter_mut().zip(&self.scratch) {
            body.x = solved.x;
            body.z = solved.y;
            body.heading_rad = solved.yaw_rad;
            body.vx = solved.vx;
            body.vz = solved.vy;
            body.angular_velocity_rad_s = solved.angular_velocity;
            body.limit();
        }
    }

    /// Keep only the static colliders whose footprint can meet a released body
    /// within `horizon_s`, so a city-scale collider set costs nothing per
    /// substep. Order (and therefore rank) is preserved.
    fn select_near_statics(&mut self, horizon_s: f64) {
        self.near_statics.clear();
        if self.bodies.is_empty() || self.statics.is_empty() {
            return;
        }
        let mut min_x = f64::INFINITY;
        let mut max_x = f64::NEG_INFINITY;
        let mut min_z = f64::INFINITY;
        let mut max_z = f64::NEG_INFINITY;
        let mut reach: f64 = 0.0;
        for body in &self.bodies {
            min_x = min_x.min(body.x);
            max_x = max_x.max(body.x);
            min_z = min_z.min(body.z);
            max_z = max_z.max(body.z);
            reach = reach.max(hypot(body.length_m, body.width_m) / 2.0);
        }
        reach += MAX_KNOCKBACK_SPEED_MPS * horizon_s + STATIC_QUERY_MARGIN_M;
        self.near_statics
            .extend(self.statics.iter().filter(|collider| {
                let half = hypot(collider.obb.length_m, collider.obb.width_m) / 2.0 + reach;
                collider.obb.center.x + half >= min_x
                    && collider.obb.center.x - half <= max_x
                    && collider.obb.center.y + half >= min_z
                    && collider.obb.center.y - half <= max_z
            }));
    }

    fn remember(&mut self, authored: &[HandoffActor<'_>], traffic: &[HandoffActor<'_>]) {
        self.stamp += 1;
        remember_samples(&mut self.previous_authored, authored, self.stamp);
        remember_samples(&mut self.previous_traffic, traffic, self.stamp);
    }
}

fn remember_samples(
    previous: &mut HashMap<String, PriorSample>,
    actors: &[HandoffActor<'_>],
    stamp: u64,
) {
    for actor in actors {
        let sample = PriorSample {
            x: actor.x,
            z: actor.z,
            heading_rad: actor.heading_rad,
            stamp,
        };
        match previous.get_mut(actor.id) {
            Some(slot) => *slot = sample,
            None => {
                previous.insert(actor.id.to_owned(), sample);
            }
        }
    }
    previous.retain(|_, sample| sample.stamp == stamp);
}

/// The pose an actor swept from: its previous sample, or for an actor first
/// seen this interval, its current velocity projected backwards.
fn prior_pose(
    previous: &HashMap<String, PriorSample>,
    actor: &HandoffActor<'_>,
    dt_s: f64,
) -> SweepOrigin {
    match previous.get(actor.id) {
        Some(sample) => SweepOrigin {
            x: sample.x,
            z: sample.z,
            heading_rad: sample.heading_rad,
        },
        None => {
            let (s, c) = sin_cos(actor.heading_rad);
            SweepOrigin {
                x: actor.x - c * actor.speed_mps * dt_s,
                z: actor.z - s * actor.speed_mps * dt_s,
                heading_rad: actor.heading_rad,
            }
        }
    }
}

#[inline]
fn obb_at(obb: &Obb, pose: SweepOrigin) -> Obb {
    Obb {
        center: Vec2 {
            x: pose.x,
            y: pose.z,
        },
        length_m: obb.length_m,
        width_m: obb.width_m,
        heading_rad: pose.heading_rad,
    }
}

/// Unit impact normal from the striker toward the struck actor; coincident
/// centres fall back to the striker's heading.
#[inline]
fn contact_normal(delta: Vec2, fallback_heading_rad: f64) -> Vec2 {
    let length = delta.length();
    if length < 1e-6 {
        Vec2::from_heading(fallback_heading_rad)
    } else {
        delta * (1.0 / length)
    }
}

/// Authored road users that can knock provider traffic out of its control.
/// Vulnerable road users and fixed objects never initiate; they may still be
/// struck by a released body.
#[inline]
fn initiates_handoff(kind: &str) -> bool {
    matches!(
        kind,
        "vehicle" | "car" | "truck" | "bus" | "van" | "motorcycle"
    )
}

/// Footprint-scaled mass with a class multiplier, bounded to road-user range.
fn vehicle_mass_kg(kind: &str, length_m: f64, width_m: f64) -> f64 {
    let class_scale = match kind {
        "bus" => 3.8,
        "truck" => 2.8,
        "van" => 1.35,
        "motorcycle" | "bicycle" => 0.18,
        _ => 1.0,
    };
    clamp(length_m * width_m * 180.0 * class_scale, 220.0, 18_000.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn authored(
        id: &'static str,
        x: f64,
        z: f64,
        heading_rad: f64,
        speed_mps: f64,
    ) -> HandoffActor<'static> {
        HandoffActor {
            id,
            kind: "car",
            x,
            z,
            heading_rad,
            speed_mps,
            length_m: 4.8,
            width_m: 1.9,
            present: true,
            is_static: false,
        }
    }

    fn traffic(id: &'static str, x: f64, z: f64, speed_mps: f64) -> HandoffActor<'static> {
        HandoffActor {
            id,
            kind: "car",
            x,
            z,
            heading_rad: 0.0,
            speed_mps,
            length_m: 4.55,
            width_m: 1.82,
            present: true,
            is_static: false,
        }
    }

    fn body<'a>(
        world: &'a TrafficHandoffWorld,
        id: &str,
        origin: HandoffOrigin,
    ) -> &'a HandoffBody {
        world
            .bodies()
            .iter()
            .find(|b| b.id == id && b.origin == origin)
            .expect("released body")
    }

    #[test]
    fn rear_impact_releases_both_vehicles_with_momentum_exchange() {
        let mut world = TrafficHandoffWorld::new();
        let released = world.step(
            0.05,
            &[authored("ego", 2.0, 0.0, 0.0, 12.0)],
            &[traffic("t1", 6.0, 0.0, 2.0)],
        );
        assert_eq!(released, 1);
        assert_eq!(world.traffic_body_count(), 1);
        let struck = body(&world, "t1", HandoffOrigin::Traffic);
        assert!(
            struck.speed_mps() > 2.0,
            "struck car must gain speed: {}",
            struck.speed_mps()
        );
        assert!(struck.vx > 0.0);
        let striker = body(&world, "ego", HandoffOrigin::Authored);
        assert!(
            striker.speed_mps() < 12.0,
            "striker must lose speed: {}",
            striker.speed_mps()
        );
        assert!(striker.x < struck.x);
    }

    #[test]
    fn released_authored_body_ignores_later_trace_commands() {
        let mut world = TrafficHandoffWorld::new();
        world.step(
            0.05,
            &[authored("ego", 2.0, 0.0, 0.0, 12.0)],
            &[traffic("t1", 6.0, 0.0, 2.0)],
        );
        let before = body(&world, "ego", HandoffOrigin::Authored).clone();
        world.step(
            0.25,
            &[authored("ego", 100.0, 40.0, 0.0, 30.0)],
            &[traffic("t1", 7.0, 0.0, 2.0)],
        );
        let after = body(&world, "ego", HandoffOrigin::Authored);
        assert!(
            after.x < 10.0,
            "trace teleport must not move the released body: {}",
            after.x
        );
        assert!(after.x > before.x);
        assert!(after.speed_mps() < before.speed_mps());
        assert_eq!(world.bodies().len(), 2);
    }

    #[test]
    fn stationary_overlap_and_creeping_contact_keep_provider_ownership() {
        let mut world = TrafficHandoffWorld::new();
        assert_eq!(
            world.step(
                0.05,
                &[authored("ego", 2.0, 0.0, 0.0, 0.0)],
                &[traffic("t1", 6.0, 0.0, 0.0)]
            ),
            0
        );
        assert!(world.bodies().is_empty());

        let mut creeping = TrafficHandoffWorld::new();
        let mut x = 40.0;
        for _ in 0..400 {
            x += 1.2 * 0.05;
            creeping.step(
                0.05,
                &[authored("ego", x, 0.0, 0.0, 1.2)],
                &[traffic("t1", 50.0, 0.0, 0.0)],
            );
        }
        assert!(
            creeping.bodies().is_empty(),
            "1.2 m/s is under the impact floor"
        );
    }

    #[test]
    fn swept_detection_catches_fast_approach_between_samples() {
        let mut world = TrafficHandoffWorld::new();
        let mut x = 0.0;
        let mut contact_step = None;
        for step in 0..200 {
            x += 13.4 * 0.05;
            world.step(
                0.05,
                &[authored("ego", x, 0.0, 0.0, 13.4)],
                &[traffic("t1", 50.0, 0.0, 0.0)],
            );
            if contact_step.is_none() && world.traffic_body_count() > 0 {
                contact_step = Some(step);
            }
        }
        assert!(
            contact_step.is_some(),
            "the authored car drove through the traffic"
        );
        assert!(body(&world, "t1", HandoffOrigin::Traffic).x > 50.0);
    }

    #[test]
    fn static_authored_absent_and_non_vehicle_actors_never_initiate() {
        let mut world = TrafficHandoffWorld::new();
        let fixed = HandoffActor {
            is_static: true,
            ..authored("parked", 5.0, 0.0, 0.0, 13.4)
        };
        let absent = HandoffActor {
            present: false,
            ..authored("gone", 5.0, 0.0, 0.0, 13.4)
        };
        let walker = HandoffActor {
            kind: "pedestrian",
            ..authored("walker", 5.0, 0.0, 0.0, 13.4)
        };
        for _ in 0..20 {
            world.step(
                0.05,
                &[fixed, absent, walker],
                &[traffic("t1", 6.0, 0.0, 0.0)],
            );
        }
        assert!(world.bodies().is_empty());
    }

    #[test]
    fn non_advancing_intervals_never_release() {
        for dt in [0.0, -0.05, f64::NAN, f64::INFINITY] {
            let mut world = TrafficHandoffWorld::new();
            for _ in 0..50 {
                world.step(
                    dt,
                    &[authored("ego", 50.0, 0.0, 0.0, 13.4)],
                    &[traffic("t1", 50.0, 0.0, 0.0)],
                );
            }
            assert!(world.bodies().is_empty(), "dt {dt} released a body");
        }
    }

    #[test]
    fn coasting_is_deterministic_and_slows() {
        let run = || {
            let mut world = TrafficHandoffWorld::new();
            world.step(
                0.05,
                &[authored("ego", 2.0, 0.0, 0.0, 12.0)],
                &[traffic("t1", 6.0, 0.0, 2.0)],
            );
            let before = body(&world, "t1", HandoffOrigin::Traffic).clone();
            world.step(0.5, &[], &[traffic("t1", 7.0, 0.0, 2.0)]);
            let after = body(&world, "t1", HandoffOrigin::Traffic).clone();
            (before, after)
        };
        let (first_before, first_after) = run();
        let (second_before, second_after) = run();
        assert!(first_after.x > first_before.x);
        assert!(first_after.speed_mps() < first_before.speed_mps());
        assert_eq!(first_before, second_before);
        assert_eq!(first_after, second_after);
    }

    #[test]
    fn off_centre_side_impact_turns_the_struck_vehicle() {
        let mut world = TrafficHandoffWorld::new();
        let target = traffic("t1", 0.0, 0.0, 0.0);
        world.step(
            0.05,
            &[authored(
                "ego",
                0.7,
                -3.0,
                std::f64::consts::FRAC_PI_2,
                12.0,
            )],
            &[target],
        );
        assert_eq!(world.traffic_body_count(), 1);
        let before = body(&world, "t1", HandoffOrigin::Traffic).heading_rad;
        world.step(0.2, &[], &[target]);
        let after = body(&world, "t1", HandoffOrigin::Traffic).heading_rad;
        assert!(
            (after - before).abs() > 0.01,
            "heading unchanged: {before} -> {after}"
        );
    }

    #[test]
    fn released_body_promotes_traffic_it_runs_into() {
        let mut world = TrafficHandoffWorld::new();
        let first = traffic("t1", 6.0, 0.0, 2.0);
        let second = traffic("t2", 11.0, 0.0, 0.0);
        world.step(
            0.05,
            &[authored("ego", 2.0, 0.0, 0.0, 12.0)],
            &[first, second],
        );
        let mut steps = 0;
        while world.traffic_body_count() < 2 && steps < 20 {
            world.step(0.1, &[], &[first, second]);
            steps += 1;
        }
        assert_eq!(world.traffic_body_count(), 2);
        let ids: Vec<&str> = world
            .bodies()
            .iter()
            .filter(|b| b.origin == HandoffOrigin::Traffic)
            .map(|b| b.id.as_str())
            .collect();
        assert_eq!(ids, ["t1", "t2"]);
        assert!(body(&world, "t2", HandoffOrigin::Traffic).speed_mps() > 0.0);
    }

    #[test]
    fn map_geometry_stops_released_bodies() {
        let mut world = TrafficHandoffWorld::new();
        world.set_static_colliders(&[Obb {
            center: Vec2 { x: 10.0, y: 0.0 },
            length_m: 0.4,
            width_m: 8.0,
            heading_rad: 0.0,
        }]);
        world.step(
            0.05,
            &[authored("ego", 2.0, 0.0, 0.0, 12.0)],
            &[traffic("t1", 6.0, 0.0, 2.0)],
        );
        for _ in 0..30 {
            world.step(0.1, &[], &[traffic("t1", 6.0, 0.0, 2.0)]);
        }
        let struck = body(&world, "t1", HandoffOrigin::Traffic);
        assert!(
            struck.x + struck.length_m / 2.0 <= 10.0 + 0.05,
            "drove through the barrier: {}",
            struck.x
        );
        assert!(
            struck.speed_mps() < 1.0,
            "still moving at {}",
            struck.speed_mps()
        );
    }

    #[test]
    fn deep_single_frame_overlap_releases_without_a_swept_hit() {
        let mut world = TrafficHandoffWorld::new();
        world.step(
            0.05,
            &[authored("ego", 50.0, 0.0, 0.0, 13.4)],
            &[traffic("t1", 50.0, 0.0, 0.0)],
        );
        assert_eq!(world.traffic_body_count(), 1);
    }

    #[test]
    fn clear_restores_provider_ownership_but_keeps_map_geometry() {
        let mut world = TrafficHandoffWorld::new();
        world.set_static_colliders(&[Obb {
            center: Vec2 { x: 10.0, y: 0.0 },
            length_m: 0.4,
            width_m: 8.0,
            heading_rad: 0.0,
        }]);
        world.step(
            0.05,
            &[authored("ego", 2.0, 0.0, 0.0, 12.0)],
            &[traffic("t1", 6.0, 0.0, 2.0)],
        );
        world.clear();
        assert!(world.bodies().is_empty());
        assert_eq!(world.traffic_body_count(), 0);
        assert_eq!(world.statics.len(), 1);
        // The same contact releases again after a clear.
        world.step(
            0.05,
            &[authored("ego", 2.0, 0.0, 0.0, 12.0)],
            &[traffic("t1", 6.0, 0.0, 2.0)],
        );
        assert_eq!(world.traffic_body_count(), 1);
    }
}
