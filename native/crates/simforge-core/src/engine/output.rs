//! Trace assembly and checkpoint / restore.
//!
//! A checkpoint is the complete semantic world state: every actor's runtime
//! (routes as snapshots, commands, state keys, control memory), trigger
//! progress, events, recorder, metrics, physics bodies and perception latch.
//! Per-tick scratch is never persisted; it is rebuilt empty on restore.

use std::collections::BTreeMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::error::{SimEngineError, SimIssue};
use crate::hash::content_hash_of;
use crate::map::{LaneGraph, Route, RouteSnapshot, TimedRoute};
use crate::math::Vec2;
use crate::physics::{
    actor_physics_profiles, child_pedestrian_physics_profile, BodyIndex, DynamicV1Backend,
    MotionBackend, MotionDirection, PhysicsTelemetrySample,
};
use crate::trace::ledger::{
    build_semantic_ledger, BuildSemanticLedgerOptions, TriggerStatus as LedgerTriggerStatus,
    TriggerTruthTransition, TriggerView,
};
use crate::trace::metrics::MetricAccumulator;
use crate::trace::perception::PerceptionAccumulator;
use crate::trace::{
    ActorBackendMode, ActorBackendProfile, ActorBackendReason, ActorCrashRecord,
    ActorPhysicsBackendProvenance, CrashReason, EgoProvenance, PhysicsTraceProvenance, SimEvent,
    SimTrace, TraceActorMetadata, TraceFrame, TraceHeader, TraceRecorder, TraceSolver,
};
use crate::types::{
    parse_scenario_input_value, ActorKind, ActorRules, Dynamics, SetValue,
    SimActor, TurnRelation,
};

use super::actor::{
    AxisId, CrashLatch, DriverBehaviorProfile, InteractionIndex, LaneChangeSide, LateralCommand,
    LateralKind, LongitudinalCommand, PendingRetarget, RoadControlRuntimeState,
};
use super::doors::DoorRuntime;
use super::route_ref::RouteRefTable;
use super::triggers::{CollisionParty, TriggerProgress, TriggerStatus};
use super::world::{
    AmbientReactivity, CollisionSnapshot, EngineResult, GuardMode, RunOptions, SessionMode,
    Simulation, EGO_CONTROLLER_PROFILE,
};

/* ------------------------------------------------------------------ trace */

impl Simulation {
    /// Snapshot recorded trace data without advancing or finalizing the world.
    /// The semantic ledger remains incomplete until the simulation finishes.
    pub fn build_trace(&self) -> EngineResult<SimTrace> {
        if !self.capture {
            return Err(SimEngineError::new(
                "trace capture is disabled for this session",
                Vec::new(),
            ));
        }
        let input = &self.input;
        let actor_metadata: BTreeMap<String, TraceActorMetadata> = self
            .actors
            .iter()
            .map(|a| {
                (
                    a.id.clone(),
                    TraceActorMetadata {
                        kind: a.kind,
                        dims: a.dims,
                        is_static: a.is_static,
                        tags: a.tags.clone(),
                    },
                )
            })
            .collect();
        let prop_metadata = input
            .props
            .iter()
            .map(|p| (p.id.clone(), p.clone()))
            .collect();
        let actor_backends: BTreeMap<String, ActorPhysicsBackendProvenance> = self
            .actors
            .iter()
            .map(|a| {
                let provenance = if a.is_static || a.kind == ActorKind::StaticObject {
                    ActorPhysicsBackendProvenance {
                        mode: ActorBackendMode::FixedStaticV1,
                        reason: ActorBackendReason::StaticActor,
                        profile: ActorBackendProfile::FixedStatic,
                    }
                } else {
                    ActorPhysicsBackendProvenance {
                        mode: self.physics_config.mode.into(),
                        reason: ActorBackendReason::Selected,
                        profile: ActorBackendProfile::Kind(a.kind),
                    }
                };
                (a.id.clone(), provenance)
            })
            .collect();
        let crashes: BTreeMap<String, ActorCrashRecord> = self
            .actors
            .iter()
            .filter_map(|a| {
                a.crash.as_ref().map(|c| {
                    (
                        a.id.clone(),
                        ActorCrashRecord {
                            t: c.at_s,
                            other_id: c.other_id.clone(),
                            reason: CrashReason::MaterialCollision,
                        },
                    )
                })
            })
            .collect();
        let resolved_profile_digest = content_hash_of(&ResolvedProfileDigest {
            version: 2,
            profiles: actor_physics_profiles(),
            catalog_profiles: BTreeMap::from([(
                "pedestrian.child".to_owned(),
                child_pedestrian_physics_profile(),
            )]),
            overrides: self
                .physics_config
                .vehicle_profiles
                .clone()
                .unwrap_or_default(),
        })
        .map_err(|e| SimEngineError::new(e.to_string(), Vec::new()))?;
        let header = TraceHeader {
            trace_version: crate::trace::TRACE_FORMAT_VERSION,
            engine_version: crate::ENGINE_VERSION.to_owned(),
            input_hash: content_hash_of(input)
                .map_err(|e| SimEngineError::new(e.to_string(), Vec::new()))?,
            source: None,
            source_xosc_sha256: None,
            materialized_traffic_digest: None,
            seed: input.seed.clone(),
            map_id: input.map_id.clone(),
            engine_graph_digest: self.graph.topology_digest().to_owned(),
            dt: self.dt,
            clip_seconds: input.clip_seconds,
            warmup_seconds: input.warmup_seconds,
            frame: TraceFrame::XodrLocal,
            actor_ids: Vec::new(),
            actor_metadata,
            prop_metadata,
            ambient_actor_ids: if self.ambient_actor_ids.is_empty() {
                None
            } else {
                Some(self.ambient_actor_ids.clone())
            },
            catalog_slot: None,
            metric_subject: input.metric_subject.clone(),
            ego: EgoProvenance {
                controller_profile: EGO_CONTROLLER_PROFILE,
            },
            operational_conditions: input.operational_conditions.clone(),
            physics: PhysicsTraceProvenance {
                mode: self.physics_config.mode.into(),
                solver: TraceSolver::UniscenariosSimEngine,
                solver_version: crate::ENGINE_VERSION.to_owned(),
                substep_s: self.physics.substep_s(),
                vehicle_profile_digest: match &self.physics_config.vehicle_profiles {
                    Some(p) => Some(
                        content_hash_of(p)
                            .map_err(|e| SimEngineError::new(e.to_string(), Vec::new()))?,
                    ),
                    None => None,
                },
                resolved_profile_digest,
                actor_backends,
                crashes,
            },
        };
        let mut metrics = self.metrics.clone();
        for a in &self.actors {
            metrics.record_required_decel(&a.id, a.required_decel_max);
        }
        let perception_metrics = self.perception.as_ref().map(|p| p.accumulator.metrics());
        let episode = metrics.compute(input.clip_seconds, perception_metrics);
        let sensors = self
            .perception
            .as_ref()
            .map(|p| p.accumulator.sensor_tracks())
            .filter(|m| !m.is_empty());
        let map_divergence = self
            .perception
            .as_ref()
            .map(|p| p.accumulator.divergence_tracks())
            .filter(|m| !m.is_empty());
        let transitions: Vec<Vec<TriggerTruthTransition>> = self
            .truth_transitions
            .iter()
            .map(|tt| {
                tt.iter()
                    .map(|(t, value)| TriggerTruthTransition {
                        t: *t,
                        value: *value,
                    })
                    .collect()
            })
            .collect();
        let triggers: Vec<TriggerView<'_>> = self
            .triggers
            .iter()
            .enumerate()
            .map(|(i, tr)| TriggerView {
                interaction_id: &self.interactions[i].id,
                status: match tr.status {
                    TriggerStatus::Pending => LedgerTriggerStatus::Pending,
                    TriggerStatus::Fired => LedgerTriggerStatus::Fired,
                    TriggerStatus::Skipped => LedgerTriggerStatus::Skipped,
                },
                forced: tr.forced,
                fired_at: tr.fired_at,
                ended_at: tr.ended_at,
                truth_transitions: &transitions[i],
            })
            .collect();
        let initial_route_refs: BTreeMap<String, String> = self
            .actors
            .iter()
            .map(|a| {
                (
                    a.id.clone(),
                    self.route_refs
                        .get(self.initial_route_ref[a.index.index()])
                        .to_owned(),
                )
            })
            .collect();
        let downed = self.downed_since();
        let complete = self.finished;
        self.recorder
            .clone()
            .finish(
                header,
                self.events.clone(),
                episode,
                &downed,
                sensors,
                map_divergence,
                |header, ticks, events, metrics, route_refs| {
                    build_semantic_ledger(&BuildSemanticLedgerOptions {
                        header,
                        ticks,
                        events,
                        metrics,
                        input,
                        triggers: &triggers,
                        initial_route_refs: &initial_route_refs,
                        route_refs,
                        producer: "simforge-core",
                        complete,
                    })
                },
            )
            .map_err(|e| SimEngineError::new(e.to_string(), Vec::new()))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ResolvedProfileDigest<'a> {
    version: u32,
    profiles: &'a [crate::physics::ResolvedVehiclePhysicsProfile],
    catalog_profiles: BTreeMap<String, crate::types::VehiclePhysicsProfile>,
    overrides: BTreeMap<String, crate::types::VehiclePhysicsProfile>,
}

/* ------------------------------------------------------------- checkpoint */

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointOptions {
    pub guards: GuardMode,
    pub resolve_arrival: bool,
    pub include_warmup_trace: bool,
    pub ambient_reactivity: AmbientReactivity,
    pub mode: SessionMode,
    pub capture_trace: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LateralCommandState {
    pub kind: LateralKind,
    pub interaction: InteractionIndex,
    pub fired_at: f64,
    pub dynamics: Dynamics,
    pub from: f64,
    pub to: f64,
    pub duration: f64,
    pub pending: Option<PendingRetargetState>,
    pub side: Option<LaneChangeSide>,
    pub done: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingRetargetState {
    pub route: RouteSnapshot,
    pub s: f64,
    pub separation_m: f64,
    pub target_lane_rsl: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActorState {
    pub id: String,
    pub kind: ActorKind,
    pub dims: crate::types::Dims,
    pub tags: Vec<String>,
    pub is_static: bool,
    pub is_ambient: bool,
    pub rules: ActorRules,
    pub driver: DriverBehaviorProfile,
    pub cruise_speed_mps: f64,
    pub cruise_override_mps: Option<f64>,
    pub route: RouteSnapshot,
    pub route_s: f64,
    pub timed_route: Option<TimedRoute>,
    pub best_effort_world_path: bool,
    pub remaining_turns: Vec<TurnRelation>,
    pub speed_mps: f64,
    pub accel_mps2: f64,
    pub lateral_offset_m: f64,
    pub lateral_reference_offset_m: f64,
    pub lateral_reference_rate_mps: f64,
    pub lateral_reference_accel_mps2: f64,
    pub lateral_rest_offset_m: f64,
    pub lateral_rate_mps: f64,
    pub lateral_accel_mps2: f64,
    pub position: Vec2,
    pub heading_rad: f64,
    pub present: bool,
    pub retired: bool,
    pub long_cmd: Option<LongitudinalCommand>,
    pub lat_cmd: Option<LateralCommandState>,
    /// `(axis, interaction)`; the condition is the interaction's `until`.
    pub until_by_axis: Vec<(AxisId, InteractionIndex)>,
    pub state_keys: BTreeMap<String, SetValue>,
    pub road_control_states: BTreeMap<u32, RoadControlRuntimeState>,
    pub motion_direction: MotionDirection,
    pub has_moved: bool,
    pub pending_motion_direction: Option<MotionDirection>,
    pub standstill_since_s: Option<f64>,
    pub required_decel_max: f64,
    pub crash: Option<CrashLatch>,
    pub downed_at_s: Option<f64>,
    pub downed_by_actor_id: Option<String>,
    pub body: Option<BodyIndex>,
    pub freeform_lane_binding: Option<(Vec2, Option<String>)>,
    pub route_ref: u32,
}

/// Complete world state at a tick boundary. Self-contained: the executed
/// normalised input is embedded; `restore` needs only the graph and static
/// colliders (digest-verified).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SimulationCheckpoint {
    pub engine_version: String,
    pub graph_digest: String,
    pub options: CheckpointOptions,
    pub input: serde_json::Value,
    pub t_s: f64,
    pub next_tick: u64,
    pub finished: bool,
    pub actors: Vec<ActorState>,
    pub triggers: Vec<TriggerProgress>,
    pub truth_transitions: Vec<Vec<(f64, bool)>>,
    pub released_windows: Vec<bool>,
    pub lateral_clamp_diagnostics: Vec<bool>,
    pub events: Vec<SimEvent>,
    pub drained_event_count: usize,
    pub issues: Vec<SimIssue>,
    pub recorder: TraceRecorder,
    pub route_refs: Vec<String>,
    pub initial_route_ref: Vec<u32>,
    pub metrics: MetricAccumulator,
    pub physics: DynamicV1Backend,
    pub telemetry: Vec<Option<PhysicsTelemetrySample>>,
    pub perception: Option<PerceptionAccumulator>,
    pub signal_overrides: Vec<Option<crate::types::ControlIndication>>,
    pub active_collisions: Vec<(CollisionParty, CollisionParty)>,
    pub(super) collision_snapshots: Vec<CollisionSnapshot>,
    pub previous_collision_t: Option<f64>,
    pub doors: Vec<DoorRuntime>,
    pub arrival: Vec<crate::solve::arrival::ArrivalSolution>,
    /// Ids of live-mode spawns in registration order; their specs are part
    /// of `input.actors` and are re-registered after the document's actors.
    pub spawned_ids: Vec<String>,
}

impl Simulation {
    pub fn checkpoint(&self) -> EngineResult<SimulationCheckpoint> {
        let graph = &self.graph;
        let actors = self
            .actors
            .iter()
            .map(|a| ActorState {
                id: a.id.clone(),
                kind: a.kind,
                dims: a.dims,
                tags: a.tags.clone(),
                is_static: a.is_static,
                is_ambient: a.is_ambient,
                rules: a.rules,
                driver: a.driver,
                cruise_speed_mps: a.cruise_speed_mps,
                cruise_override_mps: a.cruise_override_mps,
                route: a.route.snapshot(),
                route_s: a.route_s,
                timed_route: a.timed_route.clone(),
                best_effort_world_path: a.best_effort_world_path,
                remaining_turns: a.remaining_turns.clone(),
                speed_mps: a.speed_mps,
                accel_mps2: a.accel_mps2,
                lateral_offset_m: a.lateral_offset_m,
                lateral_reference_offset_m: a.lateral_reference_offset_m,
                lateral_reference_rate_mps: a.lateral_reference_rate_mps,
                lateral_reference_accel_mps2: a.lateral_reference_accel_mps2,
                lateral_rest_offset_m: a.lateral_rest_offset_m,
                lateral_rate_mps: a.lateral_rate_mps,
                lateral_accel_mps2: a.lateral_accel_mps2,
                position: a.position,
                heading_rad: a.heading_rad,
                present: a.present,
                retired: a.retired,
                long_cmd: a.long_cmd.clone(),
                lat_cmd: a.lat_cmd.as_ref().map(|c| LateralCommandState {
                    kind: c.kind,
                    interaction: c.interaction,
                    fired_at: c.fired_at,
                    dynamics: c.dynamics,
                    from: c.from,
                    to: c.to,
                    duration: c.duration,
                    pending: c.pending.as_ref().map(|p| PendingRetargetState {
                        route: p.route.snapshot(),
                        s: p.s,
                        separation_m: p.separation_m,
                        target_lane_rsl: p.target_lane.map(|l| graph.rsl(l).to_owned()),
                    }),
                    side: c.side,
                    done: c.done,
                }),
                until_by_axis: a
                    .until_by_axis
                    .iter()
                    .map(|e| (e.axis.clone(), e.interaction))
                    .collect(),
                state_keys: a.state_keys.clone(),
                road_control_states: a.road_control_states.clone(),
                motion_direction: a.motion_direction,
                has_moved: a.has_moved,
                pending_motion_direction: a.pending_motion_direction,
                standstill_since_s: a.standstill_since_s,
                required_decel_max: a.required_decel_max,
                crash: a.crash.clone(),
                downed_at_s: a.downed_at_s,
                downed_by_actor_id: a.downed_by_actor_id.clone(),
                body: a.body,
                freeform_lane_binding: a
                    .freeform_lane_binding
                    .map(|(at, lane)| (at, lane.map(|l| graph.rsl(l).to_owned()))),
                route_ref: a.route_ref,
            })
            .collect();
        Ok(SimulationCheckpoint {
            engine_version: crate::ENGINE_VERSION.to_owned(),
            graph_digest: self.graph.topology_digest().to_owned(),
            options: CheckpointOptions {
                guards: self.options.guards,
                resolve_arrival: self.options.resolve_arrival,
                include_warmup_trace: self.options.include_warmup_trace,
                ambient_reactivity: self.options.ambient_reactivity,
                mode: self.options.mode,
                capture_trace: self.options.capture_trace,
            },
            input: {
                let mut doc = self.input.clone();
                doc.actors.extend(self.spawned.iter().cloned());
                serde_json::to_value(&doc)
                    .map_err(|e| SimEngineError::new(e.to_string(), Vec::new()))?
            },
            t_s: self.t,
            next_tick: self.next_tick,
            finished: self.finished,
            actors,
            triggers: self.triggers.iter().map(|t| t.progress()).collect(),
            truth_transitions: self.truth_transitions.clone(),
            released_windows: self.released_windows.clone(),
            lateral_clamp_diagnostics: self.lateral_clamp_diagnostics.clone(),
            events: self.events.clone(),
            drained_event_count: self.drained_event_count,
            issues: self.issues.clone(),
            recorder: self.recorder.clone(),
            route_refs: self.route_refs.entries().to_vec(),
            initial_route_ref: self.initial_route_ref.clone(),
            metrics: self.metrics.clone(),
            physics: self.physics.clone(),
            telemetry: self.telemetry.clone(),
            perception: self.perception.as_ref().map(|p| p.accumulator.clone()),
            signal_overrides: self.signals.overrides().to_vec(),
            active_collisions: self.active_collisions.clone(),
            collision_snapshots: self.collision_snapshots.clone(),
            previous_collision_t: self.previous_collision_t,
            doors: self.doors.clone(),
            arrival: self.arrival.clone(),
            spawned_ids: self.spawned.iter().map(|a| a.id.clone()).collect(),
        })
    }

    /// Rebuild a world from a checkpoint. `options.graph` must carry the
    /// checkpoint's topology digest; construction-time resolution (arrival,
    /// control binding, guards) is not re-run — the embedded input is the
    /// already-resolved one.
    pub fn restore(
        ckpt: &SimulationCheckpoint,
        mut options: RunOptions,
    ) -> EngineResult<Simulation> {
        if ckpt.graph_digest != options.graph.topology_digest() {
            return Err(SimEngineError::new(
                format!(
                    "checkpoint graph digest {} does not match the supplied graph {}",
                    ckpt.graph_digest,
                    options.graph.topology_digest()
                ),
                Vec::new(),
            ));
        }
        if ckpt.engine_version != crate::ENGINE_VERSION {
            return Err(SimEngineError::new(
                format!(
                    "checkpoint engine version {} does not match {}",
                    ckpt.engine_version,
                    crate::ENGINE_VERSION
                ),
                Vec::new(),
            ));
        }
        options.guards = GuardMode::Skip;
        options.resolve_arrival = false;
        options.include_warmup_trace = ckpt.options.include_warmup_trace;
        options.ambient_reactivity = ckpt.options.ambient_reactivity;
        options.mode = ckpt.options.mode;
        options.capture_trace = ckpt.options.capture_trace;
        let mut input = parse_scenario_input_value(&ckpt.input)
            .map_err(|e| SimEngineError::new(e.to_string(), Vec::new()))?;
        // Live-mode spawns were appended to the embedded document; split them
        // back out so registration order matches the checkpoint.
        let mut spawned: Vec<SimActor> = Vec::with_capacity(ckpt.spawned_ids.len());
        for id in &ckpt.spawned_ids {
            let Some(at) = input.actors.iter().position(|a| &a.id == id) else {
                return Err(SimEngineError::new(
                    format!("checkpoint spawned actor {id} is missing from the embedded input"),
                    Vec::new(),
                ));
            };
            spawned.push(input.actors.remove(at));
        }
        let mut sim = Simulation::new(input, options)?;
        for actor in spawned {
            sim.add_actor(actor)?;
        }
        let graph: Arc<LaneGraph> = Arc::clone(&sim.graph);
        if ckpt.actors.len() != sim.actors.len() {
            return Err(SimEngineError::new(
                format!(
                    "checkpoint carries {} actors but the embedded input constructs {}",
                    ckpt.actors.len(),
                    sim.actors.len()
                ),
                Vec::new(),
            ));
        }
        sim.options.guards = ckpt.options.guards;
        sim.options.resolve_arrival = ckpt.options.resolve_arrival;
        let lane_of = |rsl: &Option<String>| rsl.as_deref().and_then(|r| graph.lane_id(r));
        for (i, state) in ckpt.actors.iter().enumerate() {
            let a = &mut sim.actors[i];
            if a.id != state.id {
                return Err(SimEngineError::new(
                    format!(
                        "checkpoint actor order mismatch at {}: {} vs {}",
                        i, a.id, state.id
                    ),
                    Vec::new(),
                ));
            }
            a.rules = state.rules;
            a.driver = state.driver;
            a.cruise_speed_mps = state.cruise_speed_mps;
            a.cruise_override_mps = state.cruise_override_mps;
            a.route = Route::restore(&graph, &state.route).map_err(|e| {
                SimEngineError::new(
                    e.reason.clone(),
                    vec![e.into_issue(format!("checkpoint.actors.{}.route", state.id))],
                )
            })?;
            a.route_s = state.route_s;
            a.timed_route = state.timed_route.clone();
            a.best_effort_world_path = state.best_effort_world_path;
            a.remaining_turns = state.remaining_turns.clone();
            a.speed_mps = state.speed_mps;
            a.accel_mps2 = state.accel_mps2;
            a.lateral_offset_m = state.lateral_offset_m;
            a.lateral_reference_offset_m = state.lateral_reference_offset_m;
            a.lateral_reference_rate_mps = state.lateral_reference_rate_mps;
            a.lateral_reference_accel_mps2 = state.lateral_reference_accel_mps2;
            a.lateral_rest_offset_m = state.lateral_rest_offset_m;
            a.lateral_rate_mps = state.lateral_rate_mps;
            a.lateral_accel_mps2 = state.lateral_accel_mps2;
            a.position = state.position;
            a.heading_rad = state.heading_rad;
            a.present = state.present;
            a.retired = state.retired;
            a.long_cmd = state.long_cmd.clone();
            a.lat_cmd = match &state.lat_cmd {
                None => None,
                Some(c) => Some(LateralCommand {
                    kind: c.kind,
                    interaction: c.interaction,
                    fired_at: c.fired_at,
                    dynamics: c.dynamics,
                    from: c.from,
                    to: c.to,
                    duration: c.duration,
                    pending: match &c.pending {
                        None => None,
                        Some(p) => Some(PendingRetarget {
                            route: Route::restore(&graph, &p.route)
                                .map_err(|e| SimEngineError::new(e.reason.clone(), Vec::new()))?,
                            s: p.s,
                            separation_m: p.separation_m,
                            target_lane: lane_of(&p.target_lane_rsl),
                        }),
                    },
                    side: c.side,
                    done: c.done,
                }),
            };
            a.until_by_axis.clear();
            for (axis, interaction) in &state.until_by_axis {
                let Some(condition) = sim
                    .interactions
                    .get(interaction.index())
                    .and_then(|it| it.until.clone())
                else {
                    return Err(SimEngineError::new(format!("checkpoint until entry references interaction {} without an until clause", interaction.0), Vec::new()));
                };
                a.set_until(axis.clone(), *interaction, condition);
            }
            a.state_keys = state.state_keys.clone();
            a.road_control_states = state.road_control_states.clone();
            a.motion_direction = state.motion_direction;
            a.has_moved = state.has_moved;
            a.pending_motion_direction = state.pending_motion_direction;
            a.standstill_since_s = state.standstill_since_s;
            a.required_decel_max = state.required_decel_max;
            a.crash = state.crash.clone();
            a.downed_at_s = state.downed_at_s;
            a.downed_by_actor_id = state.downed_by_actor_id.clone();
            a.body = state.body;
            a.freeform_lane_binding = state
                .freeform_lane_binding
                .as_ref()
                .map(|(at, lane)| (*at, lane_of(lane)));
            a.route_ref = state.route_ref;
        }
        if ckpt.triggers.len() != sim.triggers.len() {
            return Err(SimEngineError::new(
                "checkpoint trigger count does not match the embedded input",
                Vec::new(),
            ));
        }
        for (tr, p) in sim.triggers.iter_mut().zip(&ckpt.triggers) {
            tr.restore_progress(p);
        }
        sim.truth_transitions = ckpt.truth_transitions.clone();
        sim.released_windows = ckpt.released_windows.clone();
        sim.lateral_clamp_diagnostics = ckpt.lateral_clamp_diagnostics.clone();
        sim.events = ckpt.events.clone();
        sim.drained_event_count = ckpt.drained_event_count;
        sim.issues = ckpt.issues.clone();
        sim.recorder = ckpt.recorder.clone();
        sim.route_refs = RouteRefTable::from_entries(ckpt.route_refs.clone());
        sim.initial_route_ref = ckpt.initial_route_ref.clone();
        sim.metrics = ckpt.metrics.clone();
        sim.physics = ckpt.physics.clone();
        sim.physics.reserve(
            sim.actors.len(),
            sim.statics.shapes().len() + sim.actors.len(),
        );
        sim.telemetry = ckpt.telemetry.clone();
        if let (Some(p), Some(acc)) = (&mut sim.perception, &ckpt.perception) {
            p.accumulator = acc.clone();
        }
        sim.signals.restore_overrides(&ckpt.signal_overrides);
        sim.active_collisions = ckpt.active_collisions.clone();
        sim.collision_snapshots = ckpt.collision_snapshots.clone();
        sim.previous_collision_t = ckpt.previous_collision_t;
        sim.doors = ckpt.doors.clone();
        sim.arrival = ckpt.arrival.clone();
        sim.t = ckpt.t_s;
        sim.next_tick = ckpt.next_tick;
        sim.finished = ckpt.finished;
        Ok(sim)
    }
}
