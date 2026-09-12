//! The runtime-neutral semantic ledger (`uniscenarios.semantic-ledger/v1`):
//! behavioral evidence for browser/OpenSCENARIO/CARLA parity, built from the
//! finished trace plus the trigger runtime's own status.
//!
//! The builder takes neutral views ([`TriggerView`], [`ActionAxis`]) rather
//! than engine types, so the engine passes what it has without this module
//! naming its runtime structures.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::hash::content_hash_of;
use crate::map::Route;
use crate::math::{quantize, sin_cos};
use crate::physics::MotionDirection;
use crate::types::{Interaction, SimScenarioInput, Trigger, Verb};

use super::RecordedPhysicsMode;

use super::events::SimEvent;
use super::metrics::{CollisionRecord, EpisodeMetrics};
use super::{precision, quantize_value, TraceHeader, TraceTicks};

pub const SEMANTIC_LEDGER_SCHEMA: &str = "uniscenarios.semantic-ledger/v1";
pub const SEMANTIC_LEDGER_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LedgerFrame {
    XodrLocal,
    Scene,
    CarlaWorld,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MotionAuthority {
    KinematicReplay,
    SimforgePhysics,
    CarlaPhysics,
    ExternalPhysics,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerSource {
    pub input_hash: String,
    pub producer: String,
    pub producer_version: String,
    pub map_id: String,
    pub frame: LedgerFrame,
    pub dt: f64,
    pub clip_seconds: f64,
    pub motion_authority: MotionAuthority,
    pub complete: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum LedgerScalar {
    Bool(bool),
    Number(f64),
    Text(String),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerActorTrack {
    pub kind: String,
    pub initial_route_ref: String,
    pub initial_state: BTreeMap<String, LedgerScalar>,
    pub t: Vec<f64>,
    pub x: Vec<f64>,
    pub y: Vec<f64>,
    pub heading_rad: Vec<f64>,
    pub velocity_x_mps: Vec<f64>,
    pub velocity_y_mps: Vec<f64>,
    pub speed_mps: Vec<f64>,
    pub motion_direction: Vec<MotionDirection>,
    pub lane_rsl: Vec<Option<String>>,
    pub route_s: Vec<f64>,
    pub route_ref: Vec<String>,
    pub present: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TriggerKind {
    At,
    After,
    When,
    Arrival,
}

impl TriggerKind {
    pub fn of(trigger: &Trigger) -> Self {
        match trigger {
            Trigger::At { .. } => Self::At,
            Trigger::After { .. } => Self::After,
            Trigger::When { .. } => Self::When,
            Trigger::Arrival { .. } => Self::Arrival,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TriggerStatus {
    Pending,
    Fired,
    Skipped,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct TriggerTruthTransition {
    pub t: f64,
    pub value: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerTrigger {
    pub interaction_id: String,
    pub actor_id: String,
    pub kind: TriggerKind,
    pub status: TriggerStatus,
    pub forced: bool,
    pub fired_at: Option<f64>,
    pub ended_at: Option<f64>,
    pub skip_reason: Option<String>,
    pub truth_transitions: Vec<TriggerTruthTransition>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ActionStatus {
    Pending,
    Skipped,
    Active,
    Completed,
    Released,
    Preempted,
    Aborted,
    Rejected,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerAction {
    pub interaction_id: String,
    pub actor_id: String,
    pub verb: String,
    pub axis: String,
    pub status: ActionStatus,
    pub start_t: Option<f64>,
    pub end_t: Option<f64>,
    pub forced: bool,
    pub reason: Option<String>,
    pub preempted_by_interaction_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerEvent {
    pub t: f64,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interaction_id: Option<String>,
    pub payload: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SignalTransition {
    pub t: f64,
    pub phase: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LedgerSignalTrack {
    pub phase: Vec<String>,
    pub transitions: Vec<SignalTransition>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerCollision {
    pub t: f64,
    pub a: String,
    pub b: String,
    pub collider_a: Option<String>,
    pub collider_b: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerDiscreteState {
    pub t: f64,
    pub actor_id: String,
    pub key: String,
    pub value: LedgerScalar,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerEnvironment {
    pub operational_conditions: Value,
    pub surface_patches: Vec<Value>,
    pub perception: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerSensors {
    pub declarations: BTreeMap<String, Vec<Value>>,
    pub channels: Value,
    pub map_divergence: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LedgerInvariant {
    pub id: String,
    pub kind: String,
    pub target: f64,
    pub achieved: f64,
    pub residual: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticLedger {
    pub schema: String,
    pub version: u32,
    pub source: LedgerSource,
    pub actors: BTreeMap<String, LedgerActorTrack>,
    pub triggers: Vec<LedgerTrigger>,
    pub actions: Vec<LedgerAction>,
    pub events: Vec<LedgerEvent>,
    pub signals: BTreeMap<String, LedgerSignalTrack>,
    pub collisions: Vec<LedgerCollision>,
    pub discrete_state: Vec<LedgerDiscreteState>,
    pub environment: LedgerEnvironment,
    pub sensors: LedgerSensors,
    pub invariants: Vec<LedgerInvariant>,
}

impl SemanticLedger {
    pub(crate) fn quantize(&mut self) {
        let p = precision::METRIC;
        let q = |v: &mut Vec<f64>| v.iter_mut().for_each(|x| *x = quantize(*x, p));
        self.source.dt = quantize(self.source.dt, p);
        self.source.clip_seconds = quantize(self.source.clip_seconds, p);
        for a in self.actors.values_mut() {
            q(&mut a.t);
            q(&mut a.x);
            q(&mut a.y);
            q(&mut a.heading_rad);
            q(&mut a.velocity_x_mps);
            q(&mut a.velocity_y_mps);
            q(&mut a.speed_mps);
            q(&mut a.route_s);
            for v in a.initial_state.values_mut() {
                if let LedgerScalar::Number(n) = v {
                    *n = quantize(*n, p);
                }
            }
        }
        for t in &mut self.triggers {
            super::quantize_opt(&mut t.fired_at, p);
            super::quantize_opt(&mut t.ended_at, p);
            for tr in &mut t.truth_transitions {
                tr.t = quantize(tr.t, p);
            }
        }
        for a in &mut self.actions {
            super::quantize_opt(&mut a.start_t, p);
            super::quantize_opt(&mut a.end_t, p);
        }
        for e in &mut self.events {
            e.t = quantize(e.t, p);
            for v in e.payload.values_mut() {
                quantize_value(v, p);
            }
        }
        for s in self.signals.values_mut() {
            for tr in &mut s.transitions {
                tr.t = quantize(tr.t, p);
            }
        }
        for c in &mut self.collisions {
            c.t = quantize(c.t, p);
        }
        for d in &mut self.discrete_state {
            d.t = quantize(d.t, p);
            if let LedgerScalar::Number(n) = &mut d.value {
                *n = quantize(*n, p);
            }
        }
        quantize_value(&mut self.environment.operational_conditions, p);
        self.environment
            .surface_patches
            .iter_mut()
            .for_each(|v| quantize_value(v, p));
        quantize_value(&mut self.environment.perception, p);
        self.sensors
            .declarations
            .values_mut()
            .flatten()
            .for_each(|v| quantize_value(v, p));
        quantize_value(&mut self.sensors.channels, p);
        quantize_value(&mut self.sensors.map_divergence, p);
        for i in &mut self.invariants {
            i.target = quantize(i.target, p);
            i.achieved = quantize(i.achieved, p);
            i.residual = quantize(i.residual, p);
        }
    }
}

/* ------------------------------------------------------------ route refs */

/// `route:<sha256(canonical json)>` of any route signature.
pub fn semantic_route_ref<T: Serialize + ?Sized>(route: &T) -> String {
    format!(
        "route:{}",
        content_hash_of(route).expect("route signature has no non-finite numbers")
    )
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FreeformSignature {
    kind: &'static str,
    length_m: f64,
    samples: Vec<SignatureSample>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SignatureSample {
    x: f64,
    y: f64,
    heading_rad: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LaneSignature {
    kind: &'static str,
    legs: Vec<LaneLegSignature>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LaneLegSignature {
    rsl: String,
    reversed: bool,
    s_start: f64,
    length_m: f64,
    turn_relation: Option<crate::types::TurnRelation>,
}

/// Identity of the concrete path the engine actually owns, after map binding.
pub fn semantic_resolved_route_ref(route: &Route) -> String {
    match route.graph() {
        None => {
            let length_m = route.length_m();
            let samples = (0..17)
                .map(|index| {
                    let pose = route.pose_at(length_m * f64::from(index) / 16.0);
                    SignatureSample {
                        x: pose.point.x,
                        y: pose.point.y,
                        heading_rad: pose.heading_rad,
                    }
                })
                .collect();
            semantic_route_ref(&FreeformSignature {
                kind: "freeform",
                length_m,
                samples,
            })
        }
        Some(graph) => semantic_route_ref(&LaneSignature {
            kind: "lane-route",
            legs: route
                .legs()
                .iter()
                .map(|leg| LaneLegSignature {
                    rsl: graph.rsl(leg.lane).to_owned(),
                    reversed: leg.reversed,
                    s_start: leg.s_start,
                    length_m: leg.length_m,
                    turn_relation: leg.turn_relation,
                })
                .collect(),
        }),
    }
}

/* ----------------------------------------------------------------- views */

/// The trigger runtime's own status for one interaction.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TriggerView<'a> {
    pub interaction_id: &'a str,
    pub status: TriggerStatus,
    pub forced: bool,
    pub fired_at: Option<f64>,
    pub ended_at: Option<f64>,
    pub truth_transitions: &'a [TriggerTruthTransition],
}

/// Command axis an interaction occupies: `set` owns one axis per key so two
/// `set`s of different keys coexist.
pub fn action_axis(verb: &Verb) -> String {
    match verb {
        Verb::Speed { .. } | Verb::Gap { .. } => "longitudinal".to_owned(),
        Verb::ChangeLane { .. } | Verb::LaneOffset { .. } => "lateral".to_owned(),
        Verb::Route { .. } => "route".to_owned(),
        Verb::Exist { .. } => "existence".to_owned(),
        Verb::Set { target } => format!("state:{}", target.key),
    }
}

pub fn verb_name(verb: &Verb) -> &'static str {
    match verb {
        Verb::Speed { .. } => "speed",
        Verb::Gap { .. } => "gap",
        Verb::ChangeLane { .. } => "changeLane",
        Verb::LaneOffset { .. } => "laneOffset",
        Verb::Route { .. } => "route",
        Verb::Exist { .. } => "exist",
        Verb::Set { .. } => "set",
    }
}

pub struct BuildSemanticLedgerOptions<'a> {
    pub header: &'a TraceHeader,
    pub ticks: &'a TraceTicks,
    pub events: &'a [SimEvent],
    pub metrics: &'a EpisodeMetrics,
    pub input: &'a SimScenarioInput,
    /// One per input interaction, any order.
    pub triggers: &'a [TriggerView<'a>],
    /// `route:<hash>` of each actor's initially bound route.
    pub initial_route_refs: &'a BTreeMap<String, String>,
    /// Per-tick route ref per actor (the recorder's route-ref channel).
    pub route_refs: &'a BTreeMap<&'a str, &'a [String]>,
    /// Producer identity recorded in `source.producer`.
    pub producer: &'a str,
    pub complete: bool,
}

/// Which interaction's `verb` and `axis` a semantic action reports.
fn action_for(
    interaction: &Interaction,
    trigger: TriggerView<'_>,
    events: &[SimEvent],
) -> LedgerAction {
    let id = interaction.id.as_str();
    let fired = events.iter().find(
        |e| matches!(e, SimEvent::TriggerFired { interaction_id, .. } if interaction_id == id),
    );
    let last = |pred: &dyn Fn(&SimEvent) -> bool| events.iter().rev().find(|e| pred(e));
    let skipped = last(
        &|e| matches!(e, SimEvent::TriggerSkipped { interaction_id, .. } if interaction_id == id),
    );
    let rejected = last(
        &|e| matches!(e, SimEvent::LaneChangeRejected { interaction_id, .. } | SimEvent::RouteChangeRejected { interaction_id, .. } if interaction_id == id),
    );
    let aborted = last(
        &|e| matches!(e, SimEvent::InteractionAborted { interaction_id, .. } if interaction_id == id),
    );
    let preempted = last(
        &|e| matches!(e, SimEvent::Preemption { preempted_interaction_id, .. } if preempted_interaction_id == id),
    );
    let released =
        last(&|e| matches!(e, SimEvent::Released { interaction_id, .. } if interaction_id == id));
    let completed = last(
        &|e| matches!(e, SimEvent::InteractionCompleted { interaction_id, .. } if interaction_id == id),
    );

    let mut status = match trigger.status {
        TriggerStatus::Pending => ActionStatus::Pending,
        TriggerStatus::Skipped => ActionStatus::Skipped,
        TriggerStatus::Fired => ActionStatus::Active,
    };
    let mut end_t = trigger.ended_at;
    let mut reason: Option<String> = match skipped {
        Some(SimEvent::TriggerSkipped { reason, .. }) => Some(reason.clone()),
        _ => None,
    };
    let mut preempted_by = None;

    if fired.is_some()
        && matches!(
            interaction.verb,
            Verb::Route { .. } | Verb::Exist { .. } | Verb::Set { .. }
        )
    {
        status = ActionStatus::Completed;
    }
    if let Some(SimEvent::InteractionCompleted { t, .. }) = completed {
        status = ActionStatus::Completed;
        end_t = Some(*t);
        reason = Some("complete".to_owned());
    }
    if let Some(SimEvent::Released { t, reason: r, .. }) = released {
        status = if *r == super::events::ReleasedReason::Complete {
            ActionStatus::Completed
        } else {
            ActionStatus::Released
        };
        end_t = Some(*t);
        reason = Some(r.as_str().to_owned());
    }
    if let Some(SimEvent::Preemption {
        t,
        by_interaction_id,
        ..
    }) = preempted
    {
        status = ActionStatus::Preempted;
        end_t = Some(*t);
        reason = Some("preempted".to_owned());
        preempted_by = Some(by_interaction_id.clone());
    }
    if let Some(SimEvent::InteractionAborted { t, reason: r, .. }) = aborted {
        status = ActionStatus::Aborted;
        end_t = Some(*t);
        reason = Some(r.as_str().to_owned());
    }
    match rejected {
        Some(SimEvent::LaneChangeRejected { t, reason: r, .. })
        | Some(SimEvent::RouteChangeRejected { t, reason: r, .. }) => {
            status = ActionStatus::Rejected;
            end_t = Some(*t);
            reason = Some(r.clone());
        }
        _ => {}
    }

    LedgerAction {
        interaction_id: interaction.id.clone(),
        actor_id: interaction.actor_id.clone(),
        verb: verb_name(&interaction.verb).to_owned(),
        axis: action_axis(&interaction.verb),
        status,
        start_t: fired.map(SimEvent::t),
        end_t,
        forced: trigger.forced,
        reason,
        preempted_by_interaction_id: preempted_by,
    }
}

fn ledger_event(event: &SimEvent) -> LedgerEvent {
    let mut payload = match serde_json::to_value(event) {
        Ok(Value::Object(map)) => map,
        _ => Map::new(),
    };
    payload.remove("t");
    payload.remove("kind");
    payload.remove("actorId");
    payload.remove("interactionId");
    LedgerEvent {
        t: event.t(),
        kind: event.kind().to_owned(),
        actor_id: event.actor_id().map(str::to_owned),
        interaction_id: event.interaction_id().map(str::to_owned),
        payload,
    }
}

fn initial_motion_direction(tags: &[String]) -> MotionDirection {
    if tags.iter().any(|t| t == "motion:reverse") {
        MotionDirection::Reverse
    } else {
        MotionDirection::Forward
    }
}

fn gear_of(direction: MotionDirection) -> &'static str {
    match direction {
        MotionDirection::Forward => "forward",
        MotionDirection::Reverse => "reverse",
    }
}

/// Build the runtime-neutral semantic surface without changing simulation.
pub fn build_semantic_ledger(options: &BuildSemanticLedgerOptions<'_>) -> SemanticLedger {
    let header = options.header;
    let ticks = options.ticks;
    let input = options.input;
    let events = options.events;

    let mut actors = BTreeMap::new();
    for actor in &input.actors {
        let Some(track) = ticks.actors.get(&actor.id) else {
            continue;
        };
        let n = track.speed_mps.len();
        let mut velocity_x = Vec::with_capacity(n);
        let mut velocity_y = Vec::with_capacity(n);
        for i in 0..n {
            let heading = track.heading_rad[i];
            let (longitudinal, lateral) = match &track.physics {
                Some(p) => (p.vx_body_mps[i], p.vy_body_mps[i]),
                None => (track.speed_mps[i] * track.motion_direction[i].sign(), 0.0),
            };
            let (s, c) = sin_cos(heading);
            velocity_x.push(longitudinal * c - lateral * s);
            velocity_y.push(longitudinal * s + lateral * c);
        }
        let authored_ref = semantic_route_ref(&actor.behavior.route);
        let route_ref = match options.route_refs.get(actor.id.as_str()) {
            Some(refs) => refs.to_vec(),
            None => vec![authored_ref.clone(); n],
        };
        let direction = initial_motion_direction(&actor.tags);
        let rules = &actor.behavior.rules;
        let initial_state = BTreeMap::from([
            (
                "rules.obeySignals".to_owned(),
                LedgerScalar::Bool(rules.obey_signals),
            ),
            (
                "rules.yieldToVehicles".to_owned(),
                LedgerScalar::Bool(rules.yield_to_vehicles),
            ),
            (
                "rules.yieldToPedestrians".to_owned(),
                LedgerScalar::Bool(rules.yield_to_pedestrians),
            ),
            (
                "rules.collisionAvoidance".to_owned(),
                LedgerScalar::Bool(rules.collision_avoidance),
            ),
            (
                "rules.aggression".to_owned(),
                LedgerScalar::Number(rules.aggression),
            ),
            (
                "rules.speedFactor".to_owned(),
                LedgerScalar::Number(rules.speed_factor),
            ),
            (
                "motion.gear".to_owned(),
                LedgerScalar::Text(gear_of(direction).to_owned()),
            ),
            (
                "motion.gearEngaged".to_owned(),
                LedgerScalar::Text(gear_of(direction).to_owned()),
            ),
        ]);
        actors.insert(
            actor.id.clone(),
            LedgerActorTrack {
                kind: actor.kind.as_str().to_owned(),
                initial_route_ref: options
                    .initial_route_refs
                    .get(&actor.id)
                    .cloned()
                    .unwrap_or(authored_ref),
                initial_state,
                t: ticks.t.clone(),
                x: track.x.clone(),
                y: track.y.clone(),
                heading_rad: track.heading_rad.clone(),
                velocity_x_mps: velocity_x,
                velocity_y_mps: velocity_y,
                speed_mps: track.speed_mps.clone(),
                motion_direction: track.motion_direction.clone(),
                lane_rsl: track.lane_rsl.clone(),
                route_s: track.s.clone(),
                route_ref,
                present: track.present.iter().map(|p| u8::from(*p != 0)).collect(),
            },
        );
    }

    let signals = ticks
        .signals
        .iter()
        .map(|(id, track)| {
            let phase: Vec<String> = track.phase.iter().map(|p| p.as_str().to_owned()).collect();
            let mut transitions = Vec::new();
            for (i, p) in phase.iter().enumerate() {
                if i == 0 || *p != phase[i - 1] {
                    transitions.push(SignalTransition {
                        t: ticks.t[i],
                        phase: p.clone(),
                    });
                }
            }
            (id.clone(), LedgerSignalTrack { phase, transitions })
        })
        .collect();

    let triggers = input
        .interactions
        .iter()
        .map(|interaction| {
            let view = options
                .triggers
                .iter()
                .find(|t| t.interaction_id == interaction.id)
                .copied()
                .unwrap_or(TriggerView {
                    interaction_id: &interaction.id,
                    status: TriggerStatus::Pending,
                    forced: false,
                    fired_at: None,
                    ended_at: None,
                    truth_transitions: &[],
                });
            let skip_reason = events.iter().rev().find_map(|e| match e {
                SimEvent::TriggerSkipped {
                    interaction_id,
                    reason,
                    ..
                } if *interaction_id == interaction.id => Some(reason.clone()),
                _ => None,
            });
            LedgerTrigger {
                interaction_id: interaction.id.clone(),
                actor_id: interaction.actor_id.clone(),
                kind: TriggerKind::of(&interaction.trigger),
                status: view.status,
                forced: view.forced,
                fired_at: view.fired_at,
                ended_at: view.ended_at,
                skip_reason,
                truth_transitions: view.truth_transitions.to_vec(),
            }
        })
        .collect();

    let actions = input
        .interactions
        .iter()
        .map(|interaction| {
            let view = options
                .triggers
                .iter()
                .find(|t| t.interaction_id == interaction.id)
                .copied()
                .unwrap_or(TriggerView {
                    interaction_id: &interaction.id,
                    status: TriggerStatus::Pending,
                    forced: false,
                    fired_at: None,
                    ended_at: None,
                    truth_transitions: &[],
                });
            action_for(interaction, view, events)
        })
        .collect();

    let declarations = input
        .actors
        .iter()
        .filter(|a| !a.sensors().is_empty())
        .map(|a| {
            (
                a.id.clone(),
                a.sensors()
                    .iter()
                    .map(|s| serde_json::to_value(s).unwrap_or(Value::Null))
                    .collect(),
            )
        })
        .collect();

    SemanticLedger {
        schema: SEMANTIC_LEDGER_SCHEMA.to_owned(),
        version: SEMANTIC_LEDGER_VERSION,
        source: LedgerSource {
            input_hash: header.input_hash.clone(),
            producer: options.producer.to_owned(),
            producer_version: header.engine_version.clone(),
            map_id: header.map_id.clone(),
            frame: LedgerFrame::XodrLocal,
            dt: header.dt,
            clip_seconds: header.clip_seconds,
            motion_authority: match header.physics.mode {
                RecordedPhysicsMode::DynamicV1 => MotionAuthority::SimforgePhysics,
                RecordedPhysicsMode::KinematicV1 => MotionAuthority::KinematicReplay,
            },
            complete: options.complete,
        },
        actors,
        triggers,
        actions,
        events: events.iter().map(ledger_event).collect(),
        signals,
        collisions: options
            .metrics
            .collisions
            .iter()
            .map(|c: &CollisionRecord| LedgerCollision {
                t: c.t,
                a: c.a.clone(),
                b: c.b.clone(),
                collider_a: c.collider_a.clone(),
                collider_b: c.collider_b.clone(),
            })
            .collect(),
        discrete_state: events
            .iter()
            .filter_map(|e| match e {
                SimEvent::StateSet {
                    t,
                    actor_id,
                    key,
                    value,
                } => Some(LedgerDiscreteState {
                    t: *t,
                    actor_id: actor_id.clone(),
                    key: key.clone(),
                    value: match value {
                        crate::types::SetValue::Bool(b) => LedgerScalar::Bool(*b),
                        crate::types::SetValue::Number(n) => LedgerScalar::Number(*n),
                        crate::types::SetValue::Text(s) => LedgerScalar::Text(s.clone()),
                    },
                }),
                _ => None,
            })
            .collect(),
        environment: LedgerEnvironment {
            operational_conditions: serde_json::to_value(input.operational_conditions)
                .unwrap_or(Value::Null),
            surface_patches: input
                .surface_patches
                .iter()
                .map(|p| serde_json::to_value(p).unwrap_or(Value::Null))
                .collect(),
            perception: input.perception.as_ref().map_or(Value::Null, |p| {
                serde_json::to_value(p).unwrap_or(Value::Null)
            }),
        },
        sensors: LedgerSensors {
            declarations,
            channels: ticks.sensors.as_ref().map_or_else(
                || Value::Object(Map::new()),
                |s| serde_json::to_value(s).unwrap_or(Value::Null),
            ),
            map_divergence: ticks.map_divergence.as_ref().map_or_else(
                || Value::Object(Map::new()),
                |d| serde_json::to_value(d).unwrap_or(Value::Null),
            ),
        },
        invariants: options
            .metrics
            .invariant_residuals
            .iter()
            .flatten()
            .map(|r| LedgerInvariant {
                id: r.id.clone(),
                kind: r.kind.clone(),
                target: r.target,
                achieved: r.achieved,
                residual: r.residual,
            })
            .collect(),
    }
}
