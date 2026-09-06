//! Trigger evaluation.
//!
//! Every interaction fires **at most once** and is **edge triggered**: a
//! `when` already true at `t = 0` fires on the first tick. `by_latest` is
//! mandatory on `when`; past it an unfired trigger resolves per `if_never`.
//! Triggers are only evaluated for `t ≥ 0`.
//!
//! Conditions are resolved once into [`ResolvedCondition`] (actor indices,
//! engine-frame regions, lane handles, signal slots) so per-tick evaluation
//! never touches a string.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::map::{LaneGraph, LaneId};
use crate::math::{hypot, point_in_polygon, Vec2};
use crate::trace::pairs::{along_route_gap_m, headway_s, read_pair};
use crate::types::{
    Comparison, Condition, ControlIndication, DistanceMode, IfNever, Interaction, InteractionEvent,
    LeafCondition, Region, Trigger,
};

use super::actor::{ActorIndex, ActorRuntime, InteractionIndex};
use super::signals::SignalBook;
use super::visibility::{has_line_of_sight, OccluderShape};

/// An unordered collision pair key. Actors are `Actor(index)`; static
/// colliders (`prop:`/`map:`) are `Static(slot)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CollisionParty {
    Actor(ActorIndex),
    Static(u32),
}

/// Perception read-back needed by the `detected` condition.
pub trait PerceptionQuery {
    fn detects(&self, observer: ActorIndex, target: ActorIndex, sensor: Option<&str>) -> bool;
    fn has_sensor(&self, observer: ActorIndex, sensor: Option<&str>) -> bool;
}

/// Everything a condition can read on one tick.
pub struct ConditionContext<'a> {
    pub t: f64,
    pub actors: &'a [ActorRuntime],
    pub signals: &'a SignalBook,
    pub occluders: &'a [OccluderShape<'a>],
    pub visibility_range_m: f64,
    /// Pair keys colliding on this tick, sorted.
    pub collisions: &'a [(CollisionParty, CollisionParty)],
    pub perception: Option<&'a dyn PerceptionQuery>,
}

impl<'a> ConditionContext<'a> {
    #[inline]
    fn live(&self, index: Option<ActorIndex>) -> Option<&'a ActorRuntime> {
        let a = &self.actors[index?.index()];
        if a.is_live() {
            Some(a)
        } else {
            None
        }
    }

    #[inline]
    fn collides(&self, a: CollisionParty, b: CollisionParty) -> bool {
        let key = if a <= b { (a, b) } else { (b, a) };
        self.collisions.binary_search(&key).is_ok()
    }

    #[inline]
    fn involved(&self, a: CollisionParty) -> bool {
        self.collisions.iter().any(|(x, y)| *x == a || *y == a)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum ResolvedRegion {
    Circle {
        center: Vec2,
        radius_m: f64,
    },
    Polygon {
        points: Vec<Vec2>,
    },
    LaneWindow {
        lane: Option<LaneId>,
        s_min: f64,
        s_max: f64,
    },
}

impl ResolvedRegion {
    pub fn resolve(region: &Region, graph: &LaneGraph) -> Self {
        match region {
            Region::Circle { center, radius_m } => ResolvedRegion::Circle {
                center: center.to_local(),
                radius_m: *radius_m,
            },
            Region::Polygon { points } => ResolvedRegion::Polygon {
                points: points.iter().map(|p| p.to_local()).collect(),
            },
            Region::LaneWindow { rsl, s_min, s_max } => ResolvedRegion::LaneWindow {
                lane: graph.lane_id(rsl),
                s_min: *s_min,
                s_max: *s_max,
            },
        }
    }

    pub fn contains(&self, a: &ActorRuntime) -> bool {
        match self {
            ResolvedRegion::Circle { center, radius_m } => {
                hypot(a.position.x - center.x, a.position.y - center.y) <= *radius_m
            }
            ResolvedRegion::Polygon { points } => point_in_polygon(a.position, points),
            ResolvedRegion::LaneWindow { lane, s_min, s_max } => {
                let pose = a.route.pose_at(a.route_s);
                match (pose.lane, lane) {
                    (Some(l), Some(w)) if l == *w => pose.lane_s >= *s_min && pose.lane_s <= *s_max,
                    _ => false,
                }
            }
        }
    }
}

/// A leaf condition with every reference resolved. Unknown actor ids resolve
/// to `None` and evaluate as absent (the TS engine's `byId.get` behaviour).
#[derive(Debug, Clone, PartialEq)]
pub enum ResolvedLeaf {
    Distance {
        a: Option<ActorIndex>,
        b: Option<ActorIndex>,
        mode: DistanceMode,
        cmp: Comparison,
        value: f64,
        hysteresis: f64,
    },
    Ttc {
        a: Option<ActorIndex>,
        b: Option<ActorIndex>,
        cmp: Comparison,
        value: f64,
    },
    Headway {
        a: Option<ActorIndex>,
        b: Option<ActorIndex>,
        cmp: Comparison,
        value: f64,
    },
    Reaches {
        actor: Option<ActorIndex>,
        region: ResolvedRegion,
    },
    Speed {
        actor: Option<ActorIndex>,
        cmp: Comparison,
        value: f64,
    },
    Standstill {
        actor: Option<ActorIndex>,
        duration_s: f64,
    },
    Signal {
        signal: Option<u32>,
        phase: ControlIndication,
    },
    /// `None` party = unknown id (never collides); both absent = any collision.
    Collision {
        a: Option<Option<CollisionParty>>,
        b: Option<Option<CollisionParty>>,
    },
    Visible {
        a: Option<ActorIndex>,
        to: Option<ActorIndex>,
        value: bool,
    },
    Detected {
        a: Option<ActorIndex>,
        by: Option<ActorIndex>,
        sensor: Option<String>,
        value: bool,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub enum ResolvedCondition {
    Leaf(ResolvedLeaf),
    And(Vec<ResolvedLeaf>),
    Or(Vec<ResolvedLeaf>),
    Not(ResolvedLeaf),
}

/// Name → handle tables used to resolve authored references.
pub struct ReferenceTables<'a> {
    pub actors: &'a BTreeMap<String, ActorIndex>,
    pub statics: &'a BTreeMap<String, u32>,
    pub signals: &'a SignalBook,
    pub graph: &'a LaneGraph,
}

impl<'a> ReferenceTables<'a> {
    #[inline]
    pub fn actor(&self, id: &str) -> Option<ActorIndex> {
        self.actors.get(id).copied()
    }

    #[inline]
    fn party(&self, id: &str) -> Option<CollisionParty> {
        if let Some(a) = self.actors.get(id) {
            return Some(CollisionParty::Actor(*a));
        }
        self.statics.get(id).map(|s| CollisionParty::Static(*s))
    }

    pub fn resolve_leaf(&self, leaf: &LeafCondition) -> ResolvedLeaf {
        match leaf {
            LeafCondition::Distance {
                a,
                b,
                mode,
                cmp,
                value,
                hysteresis,
            } => ResolvedLeaf::Distance {
                a: self.actor(a),
                b: self.actor(b),
                mode: *mode,
                cmp: *cmp,
                value: *value,
                hysteresis: hysteresis.unwrap_or(0.0),
            },
            LeafCondition::Ttc { a, b, cmp, value } => ResolvedLeaf::Ttc {
                a: self.actor(a),
                b: self.actor(b),
                cmp: *cmp,
                value: *value,
            },
            LeafCondition::Headway { a, b, cmp, value } => ResolvedLeaf::Headway {
                a: self.actor(a),
                b: self.actor(b),
                cmp: *cmp,
                value: *value,
            },
            LeafCondition::Reaches { actor_id, region } => ResolvedLeaf::Reaches {
                actor: self.actor(actor_id),
                region: ResolvedRegion::resolve(region, self.graph),
            },
            LeafCondition::Speed {
                actor_id,
                cmp,
                value,
            } => ResolvedLeaf::Speed {
                actor: self.actor(actor_id),
                cmp: *cmp,
                value: *value,
            },
            LeafCondition::Standstill {
                actor_id,
                duration_s,
            } => ResolvedLeaf::Standstill {
                actor: self.actor(actor_id),
                duration_s: *duration_s,
            },
            LeafCondition::Signal { signal_id, phase } => ResolvedLeaf::Signal {
                signal: self.signals.program_index(signal_id),
                phase: *phase,
            },
            LeafCondition::Collision { a, b } => ResolvedLeaf::Collision {
                a: a.as_deref().map(|id| self.party(id)),
                b: b.as_deref().map(|id| self.party(id)),
            },
            LeafCondition::Visible { a, to, value } => ResolvedLeaf::Visible {
                a: self.actor(a),
                to: self.actor(to),
                value: *value,
            },
            LeafCondition::Detected {
                a,
                by,
                sensor,
                value,
            } => ResolvedLeaf::Detected {
                a: self.actor(a),
                by: self.actor(by),
                sensor: sensor.clone(),
                value: *value,
            },
        }
    }

    pub fn resolve(&self, condition: &Condition) -> ResolvedCondition {
        match condition {
            Condition::Leaf(l) => ResolvedCondition::Leaf(self.resolve_leaf(l)),
            Condition::And(of) => {
                ResolvedCondition::And(of.iter().map(|l| self.resolve_leaf(l)).collect())
            }
            Condition::Or(of) => {
                ResolvedCondition::Or(of.iter().map(|l| self.resolve_leaf(l)).collect())
            }
            Condition::Not(l) => ResolvedCondition::Not(self.resolve_leaf(l)),
        }
    }
}

pub fn evaluate_leaf(ctx: &ConditionContext<'_>, leaf: &ResolvedLeaf) -> bool {
    match leaf {
        ResolvedLeaf::Distance {
            a,
            b,
            mode,
            cmp,
            value,
            hysteresis,
        } => {
            let (Some(a), Some(b)) = (ctx.live(*a), ctx.live(*b)) else {
                return false;
            };
            let threshold = if cmp.is_upper_bound() {
                (value - hysteresis).max(0.0)
            } else {
                value + hysteresis
            };
            match mode {
                DistanceMode::Euclidean => cmp.holds(read_pair(a, b).gap_m, threshold),
                DistanceMode::AlongLane => match along_route_gap_m(a, b) {
                    Some(gap) => cmp.holds(gap.abs(), threshold),
                    None => false,
                },
            }
        }
        ResolvedLeaf::Ttc { a, b, cmp, value } => {
            let (Some(a), Some(b)) = (ctx.live(*a), ctx.live(*b)) else {
                return false;
            };
            let ttc = read_pair(a, b).ttc_s;
            // Fail closed: an undefined/infinite TTC never becomes a command.
            if !ttc.is_finite() {
                return false;
            }
            cmp.holds(ttc, *value)
        }
        ResolvedLeaf::Headway { a, b, cmp, value } => {
            let (Some(a), Some(b)) = (ctx.live(*a), ctx.live(*b)) else {
                return false;
            };
            match headway_s(a, b) {
                None => false,
                Some(h) if !h.is_finite() => matches!(cmp, Comparison::Gt | Comparison::Gte),
                Some(h) => cmp.holds(h, *value),
            }
        }
        ResolvedLeaf::Reaches { actor, region } => {
            ctx.live(*actor).map_or(false, |a| region.contains(a))
        }
        ResolvedLeaf::Speed { actor, cmp, value } => ctx
            .live(*actor)
            .map_or(false, |a| cmp.holds(a.speed_mps, *value)),
        ResolvedLeaf::Standstill { actor, duration_s } => match ctx.live(*actor) {
            Some(a) => match a.standstill_since_s {
                Some(since) => ctx.t - since >= *duration_s,
                None => false,
            },
            None => false,
        },
        ResolvedLeaf::Signal { signal, phase } => {
            signal.map_or(false, |s| ctx.signals.phase_at_index(s, ctx.t) == *phase)
        }
        ResolvedLeaf::Collision { a, b } => match (a, b) {
            (Some(a), Some(b)) => match (a, b) {
                (Some(a), Some(b)) => ctx.collides(*a, *b),
                _ => false,
            },
            (None, None) => !ctx.collisions.is_empty(),
            (Some(only), None) | (None, Some(only)) => only.map_or(false, |p| ctx.involved(p)),
        },
        ResolvedLeaf::Visible { a, to, value } => {
            let (Some(a), Some(b)) = (ctx.live(*a), ctx.live(*to)) else {
                return false;
            };
            let los = has_line_of_sight(
                b.position,
                a.position,
                ctx.occluders.iter().copied(),
                ctx.visibility_range_m,
            );
            los == *value
        }
        ResolvedLeaf::Detected {
            a,
            by,
            sensor,
            value,
        } => {
            // Fail closed without a perception pass: no evidence either way.
            let Some(perception) = ctx.perception else {
                return false;
            };
            let Some(observer) = ctx.live(*by) else {
                return false;
            };
            // The target is checked for presence only: `retired` means motion
            // finished, not that the body left the world.
            let Some(target_index) = *a else { return false };
            let target = &ctx.actors[target_index.index()];
            if !target.present {
                return false;
            }
            if !perception.has_sensor(observer.index, sensor.as_deref()) {
                return false;
            }
            perception.detects(observer.index, target_index, sensor.as_deref()) == *value
        }
    }
}

pub fn evaluate_condition(ctx: &ConditionContext<'_>, cond: &ResolvedCondition) -> bool {
    match cond {
        ResolvedCondition::Leaf(l) => evaluate_leaf(ctx, l),
        ResolvedCondition::And(of) => of.iter().all(|l| evaluate_leaf(ctx, l)),
        ResolvedCondition::Or(of) => of.iter().any(|l| evaluate_leaf(ctx, l)),
        ResolvedCondition::Not(l) => !evaluate_leaf(ctx, l),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TriggerStatus {
    Pending,
    Fired,
    Skipped,
}

/// The resolved trigger clause.
#[derive(Debug, Clone, PartialEq)]
pub enum ResolvedTrigger {
    /// `at` and pre-solved `arrival` (an unresolved arrival has `None`).
    Fixed(Option<f64>),
    After {
        reference: Option<InteractionIndex>,
        event: InteractionEvent,
        delay_s: f64,
    },
    When {
        condition: ResolvedCondition,
        by_latest: f64,
        if_never: IfNever,
    },
}

#[derive(Debug, Clone)]
pub struct TriggerRuntime {
    pub index: InteractionIndex,
    /// The actor the interaction commands (`None` if the id is unknown).
    pub actor: Option<ActorIndex>,
    pub trigger: ResolvedTrigger,
    pub until: Option<ResolvedCondition>,
    pub status: TriggerStatus,
    /// Simulation time the interaction fired.
    pub fired_at: Option<f64>,
    /// Simulation time the declared clip/command completed.
    pub ended_at: Option<f64>,
    /// `true` when `if_never: fire` forced it at `by_latest`.
    pub forced: bool,
}

/// Serialisable trigger progress for checkpoints.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggerProgress {
    pub status: TriggerStatus,
    pub fired_at: Option<f64>,
    pub ended_at: Option<f64>,
    pub forced: bool,
}

impl TriggerRuntime {
    pub fn new(
        index: InteractionIndex,
        interaction: &Interaction,
        tables: &ReferenceTables<'_>,
        interaction_index: &BTreeMap<String, InteractionIndex>,
    ) -> Self {
        let trigger = match &interaction.trigger {
            Trigger::At { t } => ResolvedTrigger::Fixed(Some(*t)),
            Trigger::Arrival { .. } => ResolvedTrigger::Fixed(None),
            Trigger::After {
                interaction_id,
                event,
                delay_s,
            } => ResolvedTrigger::After {
                reference: interaction_index.get(interaction_id).copied(),
                event: event.unwrap_or(InteractionEvent::Start),
                delay_s: *delay_s,
            },
            Trigger::When {
                condition,
                by_latest,
                if_never,
            } => ResolvedTrigger::When {
                condition: tables.resolve(condition),
                by_latest: *by_latest,
                if_never: *if_never,
            },
        };
        Self {
            index,
            actor: tables.actor(&interaction.actor_id),
            trigger,
            until: interaction.until.as_ref().map(|c| tables.resolve(c)),
            status: TriggerStatus::Pending,
            fired_at: None,
            ended_at: None,
            forced: false,
        }
    }

    pub fn progress(&self) -> TriggerProgress {
        TriggerProgress {
            status: self.status,
            fired_at: self.fired_at,
            ended_at: self.ended_at,
            forced: self.forced,
        }
    }

    pub fn restore_progress(&mut self, p: &TriggerProgress) {
        self.status = p.status;
        self.fired_at = p.fired_at;
        self.ended_at = p.ended_at;
        self.forced = p.forced;
    }

    /// Resolved absolute time for `at` / solved `arrival` triggers.
    pub fn fixed_time(&self) -> Option<f64> {
        match self.trigger {
            ResolvedTrigger::Fixed(t) => t,
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FireVerdict {
    pub fire: bool,
    pub forced: bool,
    pub skip: bool,
}

const NO_FIRE: FireVerdict = FireVerdict {
    fire: false,
    forced: false,
    skip: false,
};

fn reference_time(reference: &TriggerRuntime, event: InteractionEvent) -> Option<f64> {
    match event {
        InteractionEvent::End => reference.ended_at,
        InteractionEvent::Start => reference.fired_at,
    }
}

/// Truth value of the authored trigger predicate at this tick, independent of
/// eligibility windows, forced deadlines and route-commit delays.
pub fn trigger_predicate_value(
    ctx: &ConditionContext<'_>,
    tr: &TriggerRuntime,
    all: &[TriggerRuntime],
) -> bool {
    match &tr.trigger {
        ResolvedTrigger::Fixed(fixed) => fixed.map_or(false, |t| ctx.t >= t - 1e-9),
        ResolvedTrigger::After {
            reference,
            event,
            delay_s,
        } => {
            let Some(reference) = reference else {
                return false;
            };
            let r = &all[reference.index()];
            if r.status == TriggerStatus::Skipped {
                return false;
            }
            reference_time(r, *event).map_or(false, |rt| ctx.t >= rt + delay_s - 1e-9)
        }
        ResolvedTrigger::When { condition, .. } => evaluate_condition(ctx, condition),
    }
}

/// Decide whether a pending trigger fires on this tick.
pub fn should_fire(
    ctx: &ConditionContext<'_>,
    tr: &TriggerRuntime,
    all: &[TriggerRuntime],
) -> FireVerdict {
    match &tr.trigger {
        ResolvedTrigger::Fixed(fixed) => match fixed {
            // `t + 1e-9` absorbs the float error in `(i - warmupTicks) * dt`.
            Some(t) => FireVerdict {
                fire: ctx.t >= t - 1e-9,
                forced: false,
                skip: false,
            },
            None => NO_FIRE,
        },
        ResolvedTrigger::After {
            reference,
            event,
            delay_s,
        } => {
            let Some(reference) = reference else {
                return NO_FIRE;
            };
            let r = &all[reference.index()];
            if r.status == TriggerStatus::Skipped {
                return FireVerdict {
                    fire: false,
                    forced: false,
                    skip: true,
                };
            }
            match reference_time(r, *event) {
                None => NO_FIRE,
                Some(rt) => FireVerdict {
                    fire: ctx.t >= rt + delay_s - 1e-9,
                    forced: false,
                    skip: false,
                },
            }
        }
        ResolvedTrigger::When {
            condition,
            by_latest,
            if_never,
        } => {
            if evaluate_condition(ctx, condition) {
                return FireVerdict {
                    fire: true,
                    forced: false,
                    skip: false,
                };
            }
            if ctx.t >= *by_latest {
                return match if_never {
                    IfNever::Fire => FireVerdict {
                        fire: true,
                        forced: true,
                        skip: false,
                    },
                    IfNever::Skip => FireVerdict {
                        fire: false,
                        forced: false,
                        skip: true,
                    },
                };
            }
            NO_FIRE
        }
    }
}
