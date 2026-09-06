//! The deterministic fixed-step simulation loop.
//!
//! ## Tick order (this *is* the determinism contract)
//!
//! 1. Advance door transitions; detect OBB overlaps → the tick's collision set.
//! 2. Perception pass (same frozen snapshot, same guard as recording).
//! 3. `t ≥ 0`: window ends, triggers in **sorted interaction order**, `until`
//!    conditions, window ends again.
//! 4. Retry pending gear changes.
//! 5. Record the state *at* `t` (tracks, signals, metrics).
//! 6. **Plan** every actor from the same frozen snapshot (registration order,
//!    which is sorted actor-id order for authored actors); **apply** all plans;
//!    resolve physical contacts; knockdowns.
//! 7. On the terminal tick: skip never-fired triggers, abort open lateral
//!    clips, finish.
//!
//! Time is `(i - warmup_ticks) * dt` from an integer index, so `t = 0` is
//! exact and floating-point drift cannot shift a trigger by a tick.

use std::collections::BTreeMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::error::{SimEngineError, SimIssue, SimIssueCode};
use crate::map::{build_route, LaneGraph, LaneId, TimedRoute};
use crate::math::{
    angle_delta, atan2, hypot, normalize_angle, obb_corners, obb_overlap, sin_cos, Obb, Vec2,
};
use crate::physics::{
    swept_obb_time_of_impact, DynamicV1Backend, MotionActorInitialization, MotionBackend,
    MotionDirection, MotionInitialState, PhysicsTelemetrySample, VehicleControl,
    DYNAMIC_V1_DEFAULT_SUBSTEP_S,
};
use crate::rng::Rng;
use crate::trace::metrics::{CollisionRecord, MetricAccumulator};
use crate::trace::perception::PerceptionAccumulator;
use crate::trace::{SimEvent, SimTrace, TraceCapture, TraceRecorder};
use crate::types::{
    ActorKind, Condition, ControlIndication, Interaction, MotionPhysicsMode, PhysicsConfig,
    PropAttachment, RouteSpec, SetValue, SimActor, SimScenarioInput, VehiclePhysicsProfile,
};

use super::actor::{ActorIndex, ActorRuntime, DriverBehaviorProfile, InteractionIndex};
use super::controllers::cruise_speed;
use super::doors::{articulated_door_obb_for, DoorName, DoorRuntime};
use super::gear::{
    gear_of_motion_direction, initial_motion_direction, MOTION_GEAR_ENGAGED_KEY, MOTION_GEAR_KEY,
    REVERSE_SPAWN_HEADING_TOL_RAD,
};
use super::perception::PerceptionPass;
use super::route_ref::RouteRefTable;
use super::signals::{resolve_overlapping_control_lanes, SignalBook};
use super::spatial::{candidate_pairs, SpatialBounds, SpatialScratch};
use super::static_colliders::{StaticCollisionResources, StaticMapCollider, COLLISION_GRID_CELL_M};
use super::surface::SurfaceField;
use super::triggers::{
    evaluate_condition, CollisionParty, ConditionContext, PerceptionQuery, ReferenceTables,
    ResolvedCondition, TriggerRuntime,
};
use super::visibility::{
    build_occluders, collect_tick_occluders, ActorOccluderKeys, OccluderShape, StaticOccluder,
};
use crate::solve::arrival::{resolve_arrival_triggers, ArrivalSolution};
use crate::solve::guards::check_feasibility;
use crate::solve::guards::timed_route_feasibility_issues;

/// Ego-control provenance recorded in every trace header.
pub const EGO_CONTROLLER_PROFILE: crate::trace::EgoControllerProfile =
    crate::trace::EgoControllerProfile::SensorLimited;
/// Deterministic forward perception envelope used by the safety governor.
pub const EGO_SENSOR_RANGE_M: f64 = 80.0;
pub const EGO_SENSOR_HALF_ANGLE_RAD: f64 = std::f64::consts::FRAC_PI_3;

/// Moving actors this close to the end are clamped to the terminal pose.
pub(super) const ROUTE_END_SLACK_M: f64 = 0.01;
/// How far a freeform-routed body must move before its lane binding is re-solved.
pub(super) const FREEFORM_LANE_REBIND_M: f64 = 1.0;
/// Lookahead used for the stop-line search and the crossing-conflict scan.
pub(super) const LOOKAHEAD_M: f64 = 80.0;
pub(super) const REACTIVE_SCAN_RADIUS_M: f64 = LOOKAHEAD_M + 40.0;
pub(super) const REACTIVE_GRID_CELL_M: f64 = 40.0;
pub(super) const REACTIVE_MAX_RANGE_M2: f64 = REACTIVE_SCAN_RADIUS_M * REACTIVE_SCAN_RADIUS_M;
pub(super) const CONFLICT_SAMPLES: usize = 14;
pub(super) const CONFLICT_STEP_M: f64 = 5.0;
pub(super) const CONFLICT_RADIUS_M: f64 = 2.5;
pub(super) const CONFLICT_WINDOW_S: f64 = 2.5;
pub(super) const CONFLICT_MIN_ANGLE_RAD: f64 = 0.4;
pub(super) const CONFLICT_GRID_CELL_M: f64 = 40.0;
pub(super) const DYNAMIC_LATERAL_SETTLE_POSITION_M: f64 = 0.05;
pub(super) const DYNAMIC_LATERAL_SETTLE_RATE_MPS: f64 = 0.1;
pub(super) const DYNAMIC_LATERAL_SETTLE_HEADING_RAD: f64 = 2.0 * std::f64::consts::PI / 180.0;

/* ------------------------------------------------------------------ options */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GuardMode {
    /// Abort on any error-severity feasibility issue (default).
    Throw,
    /// Run anyway and return the issues.
    Collect,
    /// Do not check.
    Skip,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AmbientReactivity {
    /// Ambient actors plan against the full actor list.
    Scripted,
    /// Ambient actors re-evaluate control over a spatially pruned nearby set.
    Reactive,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionMode {
    /// Authored finite episode: clip stop, trace/metric retention.
    Clip,
    /// Unbounded world: no clip stop, no trace history, incremental presence.
    Live,
}

#[derive(Debug, Clone)]
pub struct RunOptions {
    pub graph: Arc<LaneGraph>,
    /// Deterministic low-complexity collision proxies extracted from the map.
    pub static_colliders: Vec<StaticMapCollider>,
    pub guards: GuardMode,
    /// Pre-solve `arrival` triggers into fixed times + spawn-s offsets.
    pub resolve_arrival: bool,
    /// Include negative warm-up samples in trace tracks (interchange replay).
    pub include_warmup_trace: bool,
    pub ambient_reactivity: AmbientReactivity,
    pub mode: SessionMode,
    /// Retain per-tick tracks/metrics so `build_trace` is available. Forced
    /// off in `Live` mode.
    pub capture_trace: bool,
}

impl RunOptions {
    pub fn new(graph: Arc<LaneGraph>) -> Self {
        Self {
            graph,
            static_colliders: Vec::new(),
            guards: GuardMode::Throw,
            resolve_arrival: true,
            include_warmup_trace: false,
            ambient_reactivity: AmbientReactivity::Scripted,
            mode: SessionMode::Clip,
            capture_trace: true,
        }
    }
}

/// Caller-supplied override of the choreography intent for one actor over the
/// ticks of one `advance` batch. Present fields replace the engine-computed
/// setpoints just before the motion backend steps.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionOverride {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub motion_direction: Option<MotionDirection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_speed_mps: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_acceleration_mps2: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview_point: Option<Vec2>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview_heading_rad: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub control: Option<VehicleControl>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActorAction {
    pub actor: ActorIndex,
    pub action: ActionOverride,
}

/* ---------------------------------------------------------------- snapshots */

/// Read-only per-actor state, safe to inspect between batches.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActorSnapshot {
    pub index: ActorIndex,
    pub x: f64,
    pub y: f64,
    pub heading_rad: f64,
    pub speed_mps: f64,
    pub accel_mps2: f64,
    /// Whether the actor exists in the world at this instant.
    pub present: bool,
    /// Lane-relative lateral offset, metres (positive = left).
    pub lateral_offset_m: f64,
    pub lateral_rate_mps: f64,
    /// Route arc length, metres.
    pub s: f64,
    /// Lane the current route station resolves to; `None` when freeform.
    #[serde(skip)]
    pub lane: Option<LaneId>,
}

/// Running episode minima for one monitored pair.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairMinima {
    pub a: ActorIndex,
    pub b: ActorIndex,
    pub min_distance_m: f64,
    pub min_ttc_s: f64,
    pub min_path_ttc_s: f64,
    pub min_pet_s: f64,
}

/// Read-only world snapshot; never builds a trace and never mutates state.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SimulationSnapshot {
    pub t_s: f64,
    pub done: bool,
    /// Sorted by actor id.
    pub actors: Vec<ActorSnapshot>,
    pub minima: Vec<PairMinima>,
}

/// Post-tick observation handed to `advance_observed`.
pub struct TickObservation<'a> {
    pub t_s: f64,
    pub tick_index: u64,
    /// Sorted by actor id.
    pub actors: &'a [ActorSnapshot],
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SimulationProgress {
    pub done: bool,
    pub ticks_advanced: usize,
    /// Simulation time of the last completed tick.
    pub t_s: f64,
    pub recorded_until: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SimResult {
    /// Exact canonical input executed after normalisation and control /
    /// arrival resolution; `content_hash` of it is `trace.header.input_hash`.
    pub input: SimScenarioInput,
    pub trace: SimTrace,
    pub issues: Vec<SimIssue>,
    pub arrival: Vec<ArrivalSolution>,
}

/* -------------------------------------------------------- internal records */

/// Collision shape label inside one actor's shape set.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum ShapeLabel {
    Body,
    Door(DoorName),
    /// Attached prop by slot in the actor's attached-prop list.
    Prop(u32),
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub(super) struct Shape {
    pub label: ShapeLabel,
    pub obb: Obb,
}

/// Per-actor collision shape snapshot from the previous tick.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub(super) struct CollisionSnapshot {
    pub shapes: Vec<Shape>,
    pub live: bool,
}

#[derive(Debug, Clone)]
pub(super) struct AttachedProp {
    pub prop_index: u32,
    pub attachment: PropAttachment,
    pub length_m: f64,
    pub width_m: f64,
    pub height_m: f64,
    pub collidable: bool,
    pub occludes: bool,
}

/// Per-tick perception pass plus the accumulator that owns the latch/record.
pub(super) struct PerceptionRuntime {
    pub pass: PerceptionPass,
    pub accumulator: PerceptionAccumulator,
}

/* ----------------------------------------------------------------- the sim */

pub struct Simulation {
    pub(super) graph: Arc<LaneGraph>,
    pub(super) options: RunOptions,
    pub(super) input: SimScenarioInput,
    pub(super) dt: f64,
    pub(super) warmup_ticks: u64,
    pub(super) clip_ticks: u64,
    pub(super) live: bool,
    pub(super) capture: bool,

    pub(super) actors: Vec<ActorRuntime>,
    pub(super) actor_index: BTreeMap<String, ActorIndex>,
    /// Actor indices sorted by id.
    pub(super) sorted_actors: Vec<ActorIndex>,
    pub(super) interactions: Vec<Interaction>,
    pub(super) interaction_index: BTreeMap<String, InteractionIndex>,
    pub(super) triggers: Vec<TriggerRuntime>,
    pub(super) signals: SignalBook,
    pub(super) surface: SurfaceField,
    pub(super) occluders: Vec<StaticOccluder>,
    pub(super) occluder_keys: ActorOccluderKeys,
    pub(super) statics: StaticCollisionResources,
    pub(super) attached: Vec<Vec<AttachedProp>>,
    pub(super) attached_occluder_ids: Vec<String>,
    pub(super) events: Vec<SimEvent>,
    pub(super) drained_event_count: usize,
    /// Predicate edge evidence per interaction: `(t, value)` transitions.
    pub(super) truth_transitions: Vec<Vec<(f64, bool)>>,
    pub(super) released_windows: Vec<bool>,
    pub(super) lateral_clamp_diagnostics: Vec<bool>,
    pub(super) issues: Vec<SimIssue>,

    pub(super) recorder: TraceRecorder,
    pub(super) route_refs: RouteRefTable,
    pub(super) initial_route_ref: Vec<u32>,
    pub(super) metrics: MetricAccumulator,
    pub(super) rng: Rng,
    pub(super) physics_config: PhysicsConfig,
    pub(super) physics: Option<DynamicV1Backend>,
    pub(super) telemetry: Vec<Option<PhysicsTelemetrySample>>,
    pub(super) arrival: Vec<ArrivalSolution>,
    /// Live-mode actors added after construction, in registration order.
    pub(super) spawned: Vec<SimActor>,
    pub(super) perception: Option<PerceptionRuntime>,
    pub(super) ego: Option<ActorIndex>,
    pub(super) has_ambient: bool,
    pub(super) ambient_reactive: bool,
    pub(super) ambient_actor_ids: Vec<String>,

    pub(super) t: f64,
    pub(super) next_tick: u64,
    pub(super) finished: bool,
    pub(super) active_collisions: Vec<(CollisionParty, CollisionParty)>,
    pub(super) collision_snapshots: Vec<CollisionSnapshot>,
    pub(super) previous_collision_t: Option<f64>,
    /// Sorted by `(actor, name)`.
    pub(super) doors: Vec<DoorRuntime>,

    // Per-tick scratch, never semantic state.
    pub(super) scratch: Scratch,
}

#[derive(Default)]
pub(super) struct Scratch {
    pub current_shapes: Vec<Vec<Shape>>,
    pub live_actors: Vec<ActorIndex>,
    pub bounds: Vec<SpatialBounds>,
    pub spatial: SpatialScratch,
    pub pairs: Vec<(u32, u32)>,
    pub static_candidates: Vec<u32>,
    pub contacts: Vec<ContactRecord>,
    pub overlapping_now: Vec<(CollisionParty, CollisionParty)>,
    pub detected: Vec<(CollisionParty, CollisionParty)>,
    /// Attached occluding props for this tick: `(prop index, obb, height, corners)`.
    pub prop_occluders: Vec<(u32, Obb, f64, [Vec2; 4])>,
    pub conflict_points: Vec<Vec2>,
    pub conflict_ranges: Vec<(u32, u32)>,
    pub conflict_candidates: Vec<(u32, u32)>,
    pub reactive_grid: Vec<(i32, i32, ActorIndex)>,
    pub nearby: Vec<ActorIndex>,
    pub leader_projection_cache: Vec<Vec<(u32, f64, f64, f64)>>,
    pub plans: Vec<super::motion::Plan>,
    pub actions: Vec<Option<ActionOverride>>,
    pub snapshot_actors: Vec<ActorSnapshot>,
    pub signal_frames: Vec<crate::trace::SignalFrame>,
    pub stop_states: Vec<(u32, Option<f64>, bool)>,
    pub stop_ids: Vec<u32>,
}

#[derive(Debug, Clone, PartialEq)]
pub(super) struct ContactRecord {
    pub t: f64,
    pub a: CollisionParty,
    pub b: CollisionParty,
    pub collider_a: ColliderName,
    pub collider_b: ColliderName,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ColliderName {
    Body,
    Door(DoorName),
    Prop(ActorIndex, u32),
    Static,
}

pub type EngineResult<T> = Result<T, SimEngineError>;

fn engine_error(message: impl Into<String>) -> SimEngineError {
    SimEngineError::new(message, Vec::new())
}

impl Simulation {
    /* ------------------------------------------------------- construction */

    pub fn new(raw_input: SimScenarioInput, options: RunOptions) -> EngineResult<Simulation> {
        let graph = options.graph.clone();
        let live = options.mode == SessionMode::Live;
        let capture = options.capture_trace && !live;

        let tagged_ego = raw_input
            .actors
            .iter()
            .filter(|a| a.has_tag("role:ego"))
            .map(|a| a.id.as_str())
            .min()
            .map(str::to_owned);
        let ego_id: Option<String> = tagged_ego.or_else(|| {
            if raw_input.actors.iter().any(|a| a.id == "ego") {
                Some("ego".to_owned())
            } else {
                raw_input.metric_subject.clone()
            }
        });

        let normalized = raw_input.normalized();
        let (control_resolved, repairs) = resolve_overlapping_control_lanes(normalized, &graph);
        let mut issues: Vec<SimIssue> = Vec::new();
        let (input, arrival) = if options.resolve_arrival {
            let resolution = resolve_arrival_triggers(&control_resolved, &graph);
            issues.extend(resolution.issues);
            (resolution.input, resolution.solutions)
        } else {
            (control_resolved, Vec::new())
        };
        for repair in &repairs {
            let mut detail = serde_json::Map::new();
            detail.insert(
                "source".into(),
                serde_json::to_value(&repair.source).unwrap_or(serde_json::Value::Null),
            );
            detail.insert("controlId".into(), repair.control_id.clone().into());
            detail.insert("sourceRsl".into(), repair.source_rsl.clone().into());
            detail.insert("routeRsl".into(), repair.route_rsl.clone().into());
            detail.insert("distanceM".into(), repair.distance_m.into());
            issues.push(
                SimIssue::warning(
                    SimIssueCode::TrafficControlBindingRepaired,
                    format!("{}.{}", match repair.source { super::signals::ControlSource::SignalPrograms => "signalPrograms", super::signals::ControlSource::RoadControls => "roadControls" }, repair.control_id),
                    format!(
                        "A coincident OpenDRIVE lane was bound to {} so this route can obey the physical control. Choose an unambiguous lane when portability matters.",
                        repair.route_rsl
                    ),
                )
                .with_detail(detail),
            );
        }
        for actor in &input.actors {
            if !actor.is_static
                && actor.behavior.rules.obey_signals
                && matches!(actor.behavior.route, RouteSpec::Polyline { .. })
            {
                let mut detail = serde_json::Map::new();
                detail.insert("actorId".into(), actor.id.clone().into());
                issues.push(
                    SimIssue::warning(
                        SimIssueCode::TrafficControlRouteUnbound,
                        format!("actors.{}.behavior.route", actor.id),
                        "This vehicle has a freeform route, so map stop signs and traffic signals cannot be applied. Move it onto a lane or choose an explicit violator profile.",
                    )
                    .with_detail(detail),
                );
            }
        }

        let dt = input.dt;
        let warmup_ticks = input.warmup_ticks();
        let clip_ticks = input.clip_ticks();
        let rng = Rng::new(&input.seed);
        let signals = SignalBook::new(
            &input.signal_programs,
            input.warmup_seconds,
            &input.road_controls,
            &graph,
        );
        let surface = SurfaceField::new(
            input.operational_conditions.effects.friction_scale,
            &input.surface_patches,
            |rsl| graph.lane_id(rsl),
        );
        let physics_config = input.resolved_physics();
        let physics = match physics_config.mode {
            MotionPhysicsMode::DynamicV1 => Some(
                DynamicV1Backend::new(
                    physics_config
                        .substep_s
                        .unwrap_or(DYNAMIC_V1_DEFAULT_SUBSTEP_S),
                )
                .map_err(|e| engine_error(e.to_string()))?,
            ),
            MotionPhysicsMode::KinematicV1 => None,
        };
        let attached_occluder_ids: Vec<String> = input
            .props
            .iter()
            .filter(|p| p.attachment.is_some() && input.occluders.iter().any(|o| o.id == p.id))
            .map(|p| p.id.clone())
            .collect();
        let occluders = build_occluders(
            input
                .occluders
                .iter()
                .filter(|o| !attached_occluder_ids.contains(&o.id)),
        );
        let statics = StaticCollisionResources::build(&input.props, &options.static_colliders);

        if options.guards != GuardMode::Skip {
            let found = check_feasibility(&input, &graph);
            if options.guards == GuardMode::Throw {
                let errors: Vec<SimIssue> =
                    found.iter().filter(|i| i.is_error()).cloned().collect();
                if !errors.is_empty() {
                    let codes: Vec<&str> = errors.iter().map(|e| e.code.as_str()).collect();
                    return Err(SimEngineError::new(
                        format!("scenario is infeasible: {}", codes.join(", ")),
                        errors,
                    ));
                }
            }
            issues.extend(found);
        }

        let mut ambient_actor_ids: Vec<String> = input
            .actors
            .iter()
            .filter(|a| a.has_tag("ambient"))
            .map(|a| a.id.clone())
            .collect();
        ambient_actor_ids.sort();
        let has_ambient = !ambient_actor_ids.is_empty();
        let ambient_reactive =
            has_ambient && options.ambient_reactivity == AmbientReactivity::Reactive;

        let metrics = MetricAccumulator::new(
            input.actors.iter().map(|a| a.id.as_str()),
            &input.occlusion_pairs,
            input.metric_subject.as_deref(),
            ambient_actor_ids.iter().map(String::as_str),
        );

        let physics_actor_ids: Vec<&str> = if physics.is_some() {
            input
                .actors
                .iter()
                .filter(|a| !a.is_static && a.kind != ActorKind::StaticObject)
                .map(|a| a.id.as_str())
                .collect()
        } else {
            Vec::new()
        };
        let recorder = TraceRecorder::new(
            input.actors.iter().map(|a| a.id.as_str()),
            signals.ids(),
            &physics_actor_ids,
            if capture {
                TraceCapture::Full
            } else {
                TraceCapture::Streaming
            },
            if capture {
                (clip_ticks + 1) as usize
            } else {
                0
            },
        );
        let mut sim = Simulation {
            graph: graph.clone(),
            options,
            dt,
            warmup_ticks,
            clip_ticks,
            live,
            capture,
            actors: Vec::with_capacity(input.actors.len()),
            actor_index: BTreeMap::new(),
            sorted_actors: Vec::with_capacity(input.actors.len()),
            interactions: Vec::new(),
            interaction_index: BTreeMap::new(),
            triggers: Vec::new(),
            signals,
            surface,
            occluders,
            occluder_keys: ActorOccluderKeys::default(),
            statics,
            attached: Vec::new(),
            attached_occluder_ids,
            events: Vec::new(),
            drained_event_count: 0,
            truth_transitions: Vec::new(),
            released_windows: Vec::new(),
            lateral_clamp_diagnostics: Vec::new(),
            issues,
            recorder,
            route_refs: RouteRefTable::default(),
            initial_route_ref: Vec::new(),
            metrics,
            rng,
            physics_config,
            physics,
            telemetry: Vec::new(),
            arrival,
            spawned: Vec::new(),
            perception: None,
            ego: None,
            has_ambient,
            ambient_reactive,
            ambient_actor_ids,
            t: -input.warmup_seconds,
            next_tick: 0,
            finished: false,
            active_collisions: Vec::new(),
            collision_snapshots: Vec::new(),
            previous_collision_t: None,
            doors: Vec::new(),
            scratch: Scratch::default(),
            input,
        };
        // Actors are registered in sorted-id order (the input is normalised),
        // so registration order == sorted order for authored documents.
        let specs: Vec<SimActor> = sim.input.actors.clone();
        for spec in &specs {
            sim.register_actor(spec)?;
        }
        sim.ego = ego_id
            .as_deref()
            .and_then(|id| sim.actor_index.get(id).copied());

        let interactions: Vec<Interaction> = sim.input.interactions.clone();
        sim.interaction_index = interactions
            .iter()
            .enumerate()
            .map(|(i, it)| (it.id.clone(), InteractionIndex(i as u32)))
            .collect();
        {
            let statics_index: BTreeMap<String, u32> = sim
                .statics
                .shapes()
                .iter()
                .enumerate()
                .map(|(i, s)| (s.id.clone(), i as u32))
                .collect();
            let tables = ReferenceTables {
                actors: &sim.actor_index,
                statics: &statics_index,
                signals: &sim.signals,
                graph: &sim.graph,
            };
            for (i, it) in interactions.iter().enumerate() {
                sim.triggers.push(TriggerRuntime::new(
                    InteractionIndex(i as u32),
                    it,
                    &tables,
                    &sim.interaction_index,
                ));
            }
        }
        sim.interactions = interactions;
        sim.truth_transitions = vec![Vec::new(); sim.triggers.len()];
        sim.released_windows = vec![false; sim.triggers.len()];
        sim.lateral_clamp_diagnostics = vec![false; sim.triggers.len()];

        let config = sim.input.effective_perception().into_owned();
        let observers: Vec<(ActorIndex, &[crate::types::SimSensor])> = sim
            .input
            .actors
            .iter()
            .filter(|a| !a.sensors().is_empty())
            .map(|a| (sim.actor_index[&a.id], a.sensors()))
            .collect();
        if !observers.is_empty() || !config.map_divergences.is_empty() {
            let observer_refs: Vec<(&str, &[crate::types::SimSensor])> = observers
                .iter()
                .map(|(index, suite)| (sim.actors[index.index()].id.as_str(), *suite))
                .collect();
            let target_ids: Vec<&str> = sim.actors.iter().map(|a| a.id.as_str()).collect();
            let accumulator = PerceptionAccumulator::new(
                &observer_refs,
                &target_ids,
                &config.map_divergences,
                dt,
                capture,
            );
            let pass = PerceptionPass::new(&config, &observers, &sim.actors);
            sim.perception = Some(PerceptionRuntime { pass, accumulator });
        }
        if let Some(backend) = &mut sim.physics {
            backend.reserve(
                sim.actors.len(),
                sim.statics.shapes().len() + sim.actors.len(),
            );
        }
        Ok(sim)
    }

    fn physics_profile_for_spec(
        &self,
        actor_id: &str,
        tags: &[String],
    ) -> Option<VehiclePhysicsProfile> {
        let authored = self.physics_config.profile(actor_id).cloned();
        if !tags.iter().any(|t| t == "catalog:pedestrian.child") {
            return authored;
        }
        let base = crate::physics::child_pedestrian_physics_profile();
        Some(match authored {
            None => base,
            Some(over) => super::interactions::overlay_profile(&base, &over),
        })
    }

    pub(super) fn register_actor(&mut self, spec: &SimActor) -> EngineResult<ActorIndex> {
        let index = ActorIndex(self.actors.len() as u32);
        let mut rt = self.build_actor(spec, index)?;
        if self.physics.is_some() && !rt.is_static && rt.kind != ActorKind::StaticObject {
            let init = MotionActorInitialization {
                actor_id: rt.id.clone(),
                kind: rt.kind,
                dimensions: Some(rt.dims),
                motion_direction: rt.motion_direction,
                state: MotionInitialState::at_rest(
                    rt.position.x,
                    rt.position.y,
                    rt.heading_rad,
                    rt.speed_mps,
                ),
                profile: self.physics_profile_for_spec(&rt.id, &rt.tags),
            };
            let body = self
                .physics
                .as_mut()
                .expect("backend")
                .register(&init)
                .map_err(|e| engine_error(e.to_string()))?;
            rt.body = Some(body);
        }
        let route_ref = self.route_refs.intern(&rt.route);
        rt.route_ref = route_ref;
        if !self.recorder.actor_ids().iter().any(|id| id == &rt.id) {
            self.recorder.add_actor(&rt.id, rt.body.is_some());
        }
        self.initial_route_ref.push(route_ref);
        self.telemetry.push(None);
        self.collision_snapshots.push(CollisionSnapshot::default());
        self.attached.push(self.attached_props_for(&rt.id));
        self.occluder_keys.add(&rt, &self.input.occlusion_pairs);
        self.actor_index.insert(rt.id.clone(), index);
        let insert_at = self.sorted_actors.partition_point(|&i| {
            crate::hash::cmp_utf16(&self.actors[i.index()].id, &rt.id) == std::cmp::Ordering::Less
        });
        self.sorted_actors.insert(insert_at, index);
        self.actors.push(rt);
        Ok(index)
    }

    fn attached_props_for(&self, actor_id: &str) -> Vec<AttachedProp> {
        let mut out: Vec<(String, AttachedProp)> = self
            .input
            .props
            .iter()
            .enumerate()
            .filter_map(|(i, p)| {
                let attachment = p.attachment.as_ref()?;
                if attachment.actor_id != actor_id {
                    return None;
                }
                Some((
                    p.id.clone(),
                    AttachedProp {
                        prop_index: i as u32,
                        attachment: attachment.clone(),
                        length_m: p.dims.l * p.scale,
                        width_m: p.dims.w * p.scale,
                        height_m: p.dims.h * p.scale,
                        collidable: p.collidable,
                        occludes: self.attached_occluder_ids.contains(&p.id),
                    },
                ))
            })
            .collect();
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out.into_iter().map(|(_, p)| p).collect()
    }

    fn build_actor(&mut self, spec: &SimActor, index: ActorIndex) -> EngineResult<ActorRuntime> {
        let route = build_route(&self.graph, &spec.behavior.route).map_err(|e| {
            let reason = e.reason.clone();
            SimEngineError::new(
                reason,
                vec![e.into_issue(format!("actors.{}.behavior.route", spec.id))],
            )
        })?;
        let pose_point = spec.initial.pose.position_local();
        let projected = route.project_point(pose_point);
        let route_s = projected.s;
        let lateral = route.lateral_offset_at(projected.s, pose_point);
        if let Some(lane_ref) = &spec.initial.lane_ref {
            match self
                .graph
                .lane_id(&lane_ref.rsl)
                .and_then(|lane| route.s_of_lane_storage(lane, lane_ref.s))
            {
                None => {
                    let mut detail = serde_json::Map::new();
                    detail.insert("rsl".into(), lane_ref.rsl.clone().into());
                    self.issues.push(
                        SimIssue::warning(
                            SimIssueCode::SpawnLaneNotOnRoute,
                            format!("actors.{}.initial.laneRef", spec.id),
                            format!("lane {} is not on the actor's route; falling back to projecting the pose", lane_ref.rsl),
                        )
                        .with_detail(detail),
                    );
                }
                Some(s) => {
                    let declared = route.point_with_offset(s, lane_ref.t_frac * route.width_at(s));
                    let mismatch_m = hypot(declared.x - pose_point.x, declared.y - pose_point.y);
                    if mismatch_m > 0.25 {
                        let mut detail = serde_json::Map::new();
                        detail.insert("rsl".into(), lane_ref.rsl.clone().into());
                        detail.insert("authoredS".into(), lane_ref.s.into());
                        detail.insert("projectedS".into(), route_s.into());
                        detail.insert("mismatchM".into(), mismatch_m.into());
                        self.issues.push(
                            SimIssue::warning(
                                SimIssueCode::SpawnLanePoseMismatch,
                                format!("actors.{}.initial", spec.id),
                                format!("authored pose and lane station differ by {mismatch_m:.2} m; the authored pose is preserved and lane progress is reprojected"),
                            )
                            .with_detail(detail),
                        );
                    }
                }
            }
        }

        let motion_direction = initial_motion_direction(&spec.tags);
        let mut spawn_heading = normalize_angle(spec.initial.pose.heading_rad);
        if motion_direction.is_reverse() {
            let travel_heading =
                normalize_angle(route.pose_at(route_s).heading_rad + std::f64::consts::PI);
            let error = angle_delta(travel_heading, spawn_heading).abs();
            if error > REVERSE_SPAWN_HEADING_TOL_RAD {
                let mut detail = serde_json::Map::new();
                detail.insert("authoredRad".into(), spawn_heading.into());
                detail.insert("correctedRad".into(), travel_heading.into());
                detail.insert("errorRad".into(), error.into());
                self.issues.push(
                    SimIssue::warning(
                        SimIssueCode::ReverseSpawnHeadingAdjusted,
                        format!("actors.{}.initial.pose.headingRad", spec.id),
                        format!(
                            "actor spawns in reverse gear, so its heading is the route tangent + PI; the authored heading differed by {:.1}° and was corrected",
                            error * 180.0 / std::f64::consts::PI
                        ),
                    )
                    .with_detail(detail),
                );
            }
            spawn_heading = travel_heading;
        }

        let rules = spec.behavior.rules;
        let driver = self.driver_profile(spec, rules.aggression);
        let timed_route = match &spec.behavior.route {
            RouteSpec::TimedPolyline { points } => Some(TimedRoute::from_scene_points(points)),
            _ => None,
        };
        let remaining_turns = match &spec.behavior.route {
            RouteSpec::Follow { turns, .. } => turns.clone(),
            _ => Vec::new(),
        };
        let traffic_speed_factor = self
            .input
            .operational_conditions
            .effects
            .traffic_speed_factor;
        let mut rt = ActorRuntime {
            index,
            id: spec.id.clone(),
            kind: spec.kind,
            dims: spec.dims,
            tags: spec.tags.clone(),
            is_static: spec.is_static,
            is_ambient: spec.has_tag("ambient"),
            rules,
            driver,
            cruise_speed_mps: 0.0,
            cruise_override_mps: spec
                .behavior
                .cruise_speed_mps
                .map(|v| v * traffic_speed_factor),
            route,
            route_s,
            timed_route,
            best_effort_world_path: false,
            remaining_turns,
            speed_mps: if spec.is_static {
                0.0
            } else {
                spec.initial.speed_mps
            },
            accel_mps2: 0.0,
            lateral_offset_m: lateral,
            lateral_reference_offset_m: lateral,
            lateral_reference_rate_mps: 0.0,
            lateral_reference_accel_mps2: 0.0,
            lateral_rest_offset_m: lateral,
            lateral_rate_mps: 0.0,
            lateral_accel_mps2: 0.0,
            position: pose_point,
            heading_rad: spawn_heading,
            present: spec.present_at_start,
            retired: false,
            long_cmd: None,
            lat_cmd: None,
            until_by_axis: Vec::new(),
            state_keys: BTreeMap::new(),
            road_control_states: BTreeMap::new(),
            motion_direction,
            has_moved: false,
            pending_motion_direction: None,
            standstill_since_s: None,
            required_decel_max: 0.0,
            crash: None,
            downed_at_s: None,
            downed_by_actor_id: None,
            body: None,
            freeform_lane_binding: None,
            route_ref: 0,
        };
        rt.cruise_speed_mps = if spec.is_static {
            0.0
        } else {
            cruise_speed(&rt, self.speed_limit_at(&rt))
        };
        let path = format!("actors.{}.behavior.route", spec.id);
        timed_route_feasibility_issues(&rt, &path, &mut self.issues);
        let gear = gear_of_motion_direction(motion_direction);
        rt.set_state_key_str(MOTION_GEAR_KEY, SetValue::Text(gear.to_owned()));
        rt.set_state_key_str(MOTION_GEAR_ENGAGED_KEY, SetValue::Text(gear.to_owned()));
        Ok(rt)
    }

    /// Seeded, actor-local variation used by the lightweight preview driver.
    fn driver_profile(&self, spec: &SimActor, aggression: f64) -> DriverBehaviorProfile {
        let (comfort_lat, comfort_decel) = match &spec.behavior.driving_profile {
            Some(p) => (
                p.comfortable_lateral_acceleration_mps2,
                p.comfortable_deceleration_mps2,
            ),
            None => (2.2, 2.5),
        };
        if !spec.kind.is_road_actor() || !self.has_ambient {
            return DriverBehaviorProfile {
                naturalistic: false,
                desired_speed_factor: 1.0,
                time_headway_s: 1.0,
                minimum_gap_m: 1.0,
                accel_scale: 1.0,
                comfort_brake_scale: 1.0,
                reaction_time_s: 0.0,
                start_delay_s: 0.0,
                comfortable_lateral_acceleration_mps2: comfort_lat,
                comfortable_deceleration_mps2: comfort_decel,
            };
        }
        let mut random = self.rng.fork(&format!("driver:{}", spec.id));
        DriverBehaviorProfile {
            naturalistic: true,
            desired_speed_factor: random.range(0.9, 1.02) + aggression * 0.06,
            time_headway_s: random.range(1.15, 1.75) - aggression * 0.35,
            minimum_gap_m: random.range(2.0, 3.0),
            accel_scale: random.range(0.75, 1.05) + aggression * 0.1,
            comfort_brake_scale: random.range(0.85, 1.1),
            reaction_time_s: (random.range(0.4, 0.8) - aggression * 0.1).max(0.25),
            start_delay_s: random.range(0.25, 0.65),
            comfortable_lateral_acceleration_mps2: comfort_lat,
            comfortable_deceleration_mps2: comfort_decel,
        }
    }

    pub(super) fn speed_limit_at(&self, a: &ActorRuntime) -> f64 {
        let pose = a.route.pose_at(a.route_s);
        let factor = self
            .input
            .operational_conditions
            .effects
            .traffic_speed_factor;
        match pose.lane {
            None => {
                (if a.kind.is_pedestrian_like() {
                    1.4
                } else {
                    13.4
                }) * factor
            }
            Some(lane) => self.graph.geometry(lane).speed_limit_mps * factor,
        }
    }

    /* ---------------------------------------------------------- accessors */

    #[inline]
    pub fn done(&self) -> bool {
        self.finished
    }
    #[inline]
    pub fn t_s(&self) -> f64 {
        self.t
    }
    #[inline]
    pub fn tick_index(&self) -> u64 {
        self.next_tick
    }
    #[inline]
    pub fn dt_s(&self) -> f64 {
        self.dt
    }
    #[inline]
    pub fn warmup_ticks(&self) -> u64 {
        self.warmup_ticks
    }
    #[inline]
    pub fn clip_ticks(&self) -> u64 {
        self.clip_ticks
    }
    #[inline]
    pub fn graph(&self) -> &Arc<LaneGraph> {
        &self.graph
    }
    #[inline]
    pub fn input(&self) -> &SimScenarioInput {
        &self.input
    }
    #[inline]
    pub fn issues(&self) -> &[SimIssue] {
        &self.issues
    }
    #[inline]
    pub fn arrival_solutions(&self) -> &[ArrivalSolution] {
        &self.arrival
    }
    #[inline]
    pub fn signal_book(&self) -> &SignalBook {
        &self.signals
    }
    #[inline]
    pub fn actor_count(&self) -> usize {
        self.actors.len()
    }
    pub fn actor_index(&self, id: &str) -> Option<ActorIndex> {
        self.actor_index.get(id).copied()
    }
    pub fn actor_id(&self, index: ActorIndex) -> &str {
        &self.actors[index.index()].id
    }
    pub fn actor_kind(&self, index: ActorIndex) -> ActorKind {
        self.actors[index.index()].kind
    }
    pub fn actor_dims(&self, index: ActorIndex) -> crate::types::Dims {
        self.actors[index.index()].dims
    }
    /// Actor indices in sorted-id order.
    #[inline]
    pub fn sorted_actor_indices(&self) -> &[ActorIndex] {
        &self.sorted_actors
    }
    pub fn interaction_index(&self, id: &str) -> Option<InteractionIndex> {
        self.interaction_index.get(id).copied()
    }
    pub fn interaction_id(&self, index: InteractionIndex) -> &str {
        &self.interactions[index.index()].id
    }
    pub fn ego(&self) -> Option<ActorIndex> {
        self.ego
    }
    pub fn ambient_actor_ids(&self) -> &[String] {
        &self.ambient_actor_ids
    }

    /// Force a world signal phase (`None` clears the override).
    pub fn set_signal_override(
        &mut self,
        signal_id: &str,
        phase: Option<ControlIndication>,
    ) -> bool {
        self.signals.set_override(signal_id, phase)
    }

    pub fn actor_snapshot(&self, index: ActorIndex) -> ActorSnapshot {
        let a = &self.actors[index.index()];
        ActorSnapshot {
            index,
            x: a.position.x,
            y: a.position.y,
            heading_rad: a.heading_rad,
            speed_mps: a.speed_mps,
            accel_mps2: a.accel_mps2,
            present: a.present,
            lateral_offset_m: a.lateral_offset_m,
            lateral_rate_mps: a.lateral_rate_mps,
            s: a.route_s,
            lane: a.route.pose_at(a.route_s).lane,
        }
    }

    fn fill_actor_snapshots(&self, out: &mut Vec<ActorSnapshot>) {
        out.clear();
        for &index in &self.sorted_actors {
            out.push(self.actor_snapshot(index));
        }
    }

    /// Read-only world snapshot, reusing the caller's buffers.
    pub fn peek_into(&self, out: &mut SimulationSnapshot) {
        out.t_s = self.t;
        out.done = self.finished;
        self.fill_actor_snapshots(&mut out.actors);
        out.minima.clear();
        for m in self.metrics.pair_minima() {
            let (Some(a), Some(b)) = (
                self.actor_index.get(m.a).copied(),
                self.actor_index.get(m.b).copied(),
            ) else {
                continue;
            };
            out.minima.push(PairMinima {
                a,
                b,
                min_distance_m: m.min_distance_m,
                min_ttc_s: m.min_ttc_s,
                min_path_ttc_s: m.min_path_ttc_s,
                min_pet_s: m.min_pet_s,
            });
        }
    }

    pub fn peek(&self) -> SimulationSnapshot {
        let mut out = SimulationSnapshot::default();
        self.peek_into(&mut out);
        out
    }

    /// Events recorded since the previous call, in record order.
    pub fn drain_events_into(&mut self, out: &mut Vec<SimEvent>) {
        if self.live {
            out.extend(self.events.drain(..));
            return;
        }
        out.extend_from_slice(&self.events[self.drained_event_count..]);
        self.drained_event_count = self.events.len();
    }

    pub fn drain_events(&mut self) -> Vec<SimEvent> {
        let mut out = Vec::new();
        self.drain_events_into(&mut out);
        out
    }

    /// Trace-aligned facts at the current time boundary (state recorded at
    /// `t`, before this tick's integration). Conditions are resolved on every
    /// call; hold a resolved set via [`Simulation::resolve_conditions`] for a
    /// hot loop.
    pub fn evaluate_conditions(&mut self, conditions: &[Condition], out: &mut Vec<bool>) {
        let resolved = self.resolve_conditions(conditions);
        self.evaluate_resolved_conditions(&resolved, out);
    }

    pub fn resolve_conditions(&self, conditions: &[Condition]) -> Vec<ResolvedCondition> {
        let statics_index: BTreeMap<String, u32> = self
            .statics
            .shapes()
            .iter()
            .enumerate()
            .map(|(i, s)| (s.id.clone(), i as u32))
            .collect();
        let tables = ReferenceTables {
            actors: &self.actor_index,
            statics: &statics_index,
            signals: &self.signals,
            graph: &self.graph,
        };
        conditions.iter().map(|c| tables.resolve(c)).collect()
    }

    pub fn evaluate_resolved_conditions(
        &mut self,
        conditions: &[ResolvedCondition],
        out: &mut Vec<bool>,
    ) {
        out.clear();
        let t = self.t;
        self.rebuild_prop_occluders();
        let occluders = self.tick_occluders();
        let view = self
            .perception
            .as_ref()
            .map(|p| p.pass.view(&p.accumulator, &self.actors));
        let ctx = ConditionContext {
            t,
            actors: &self.actors,
            signals: &self.signals,
            occluders: &occluders,
            visibility_range_m: self.input.operational_conditions.effects.visibility_range_m,
            collisions: &self.scratch.detected,
            perception: view.as_ref().map(|v| v as &dyn PerceptionQuery),
        };
        for c in conditions {
            out.push(evaluate_condition(&ctx, c));
        }
    }

    /* ------------------------------------------------------ live mutation */

    /// Add a normalised non-ambient actor at the current live tick boundary.
    pub fn add_actor(&mut self, mut actor: SimActor) -> EngineResult<ActorIndex> {
        if !self.live {
            return Err(engine_error(
                "incremental actor mutation requires live mode",
            ));
        }
        if self.actor_index.contains_key(&actor.id) {
            return Err(engine_error(format!("actor {} already exists", actor.id)));
        }
        if actor.has_tag("ambient") {
            return Err(engine_error("incremental ambient actors are not supported"));
        }
        if !actor.sensors().is_empty() {
            return Err(engine_error(
                "incremental sensor observers are not supported",
            ));
        }
        actor.present_at_start = true;
        let index = self.register_actor(&actor)?;
        self.metrics.add_actor(&actor.id);
        if let Some(perception) = &mut self.perception {
            perception.accumulator.add_target(&actor.id);
            perception.pass.add_target(&self.actors[index.index()]);
        }
        self.spawned.push(actor);
        self.events.push(SimEvent::Spawn {
            t: self.t,
            actor_id: self.actors[index.index()].id.clone(),
        });
        Ok(index)
    }

    /// Toggle an existing actor's presence at the current live tick boundary.
    pub fn set_actor_presence(&mut self, index: ActorIndex, present: bool) -> EngineResult<()> {
        if !self.live {
            return Err(engine_error(
                "incremental actor mutation requires live mode",
            ));
        }
        let Some(actor) = self.actors.get_mut(index.index()) else {
            return Err(engine_error(format!("unknown actor index {}", index.0)));
        };
        if actor.present == present {
            return Ok(());
        }
        actor.present = present;
        let id = actor.id.clone();
        if !present {
            let party = CollisionParty::Actor(index);
            self.active_collisions
                .retain(|(a, b)| *a != party && *b != party);
            self.collision_snapshots[index.index()] = CollisionSnapshot::default();
            self.events.push(SimEvent::Despawn {
                t: self.t,
                actor_id: id,
                reason: crate::trace::DespawnReason::Interaction,
            });
        } else {
            self.events.push(SimEvent::Spawn {
                t: self.t,
                actor_id: id,
            });
        }
        Ok(())
    }

    /* ---------------------------------------------------------- main loop */

    pub fn run(mut self) -> EngineResult<SimResult> {
        if self.live {
            return Err(engine_error(
                "run() is unavailable in live mode; call advance() with a finite tick budget",
            ));
        }
        self.advance(usize::MAX, &[])?;
        self.into_result()
    }

    /// Final result after completion (`Clip` mode).
    pub fn into_result(self) -> EngineResult<SimResult> {
        if !self.finished {
            return Err(engine_error(
                "simulation has not completed; advance until done",
            ));
        }
        let trace = self.build_trace()?;
        Ok(SimResult {
            input: self.input,
            trace,
            issues: self.issues,
            arrival: self.arrival,
        })
    }

    pub fn advance(
        &mut self,
        max_ticks: usize,
        actions: &[ActorAction],
    ) -> EngineResult<SimulationProgress> {
        self.advance_inner(max_ticks, actions, None)
    }

    pub fn advance_observed(
        &mut self,
        max_ticks: usize,
        actions: &[ActorAction],
        on_tick: &mut dyn FnMut(&TickObservation<'_>),
    ) -> EngineResult<SimulationProgress> {
        self.advance_inner(max_ticks, actions, Some(on_tick))
    }

    fn advance_inner(
        &mut self,
        max_ticks: usize,
        actions: &[ActorAction],
        mut on_tick: Option<&mut dyn FnMut(&TickObservation<'_>)>,
    ) -> EngineResult<SimulationProgress> {
        if self.live && max_ticks == usize::MAX {
            return Err(engine_error(
                "live mode requires a finite advance tick budget",
            ));
        }
        self.stage_actions(actions)?;
        let total = if self.live {
            u64::MAX
        } else {
            self.warmup_ticks + self.clip_ticks
        };
        let mut advanced = 0usize;
        while !self.finished && self.next_tick <= total && advanced < max_ticks {
            let i = self.next_tick;
            self.next_tick += 1;
            let t = (i as f64 - self.warmup_ticks as f64) * self.dt;
            self.t = t;
            self.update_door_transitions(t);
            self.detect_collisions(t);
            if self.perception.is_some() && (t >= 0.0 || self.options.include_warmup_trace) {
                self.observe_perception(t);
            }
            if t >= 0.0 {
                self.evaluate_window_ends(t);
                self.evaluate_triggers(t);
                self.evaluate_until(t);
                self.evaluate_window_ends(t);
            }
            for index in 0..self.actors.len() {
                if self.actors[index].pending_motion_direction.is_some() {
                    self.engage_pending_gear(ActorIndex(index as u32), t)?;
                }
            }
            if self.capture && (t >= 0.0 || self.options.include_warmup_trace) {
                self.record_tracks(t)?;
            }
            if t >= 0.0 && (self.capture || self.live) {
                self.observe_metrics(t);
            }
            if i < total {
                self.plan_all(t)?;
                self.apply_all(t)?;
            } else {
                self.finish_never_fired();
                self.finished = true;
            }
            advanced += 1;
            if let Some(observer) = on_tick.as_mut() {
                let mut snapshots = std::mem::take(&mut self.scratch.snapshot_actors);
                self.fill_actor_snapshots(&mut snapshots);
                observer(&TickObservation {
                    t_s: t,
                    tick_index: i,
                    actors: &snapshots,
                });
                self.scratch.snapshot_actors = snapshots;
            }
        }
        Ok(SimulationProgress {
            done: self.finished,
            ticks_advanced: advanced,
            t_s: self.t,
            recorded_until: self.recorder.recorded_until(),
        })
    }

    fn stage_actions(&mut self, actions: &[ActorAction]) -> EngineResult<()> {
        let n = self.actors.len();
        let staged = &mut self.scratch.actions;
        staged.clear();
        staged.resize(n, None);
        for action in actions {
            if action.actor.index() >= n {
                return Err(engine_error(format!(
                    "action targets unknown actor index {}",
                    action.actor.0
                )));
            }
            staged[action.actor.index()] = Some(action.action);
        }
        Ok(())
    }

    /* ---------------------------------------------------------- collisions */

    pub(super) fn obb_of(a: &ActorRuntime) -> Obb {
        a.obb()
    }

    pub(super) fn door_at(&self, actor: ActorIndex, name: DoorName) -> Option<&DoorRuntime> {
        self.doors
            .binary_search_by(|d| (d.actor, d.name).cmp(&(actor, name)))
            .ok()
            .map(|i| &self.doors[i])
    }

    pub(super) fn attached_prop_obb(a: &ActorRuntime, prop: &AttachedProp) -> Obb {
        let (sin, cos) = sin_cos(a.heading_rad);
        let att = &prop.attachment;
        Obb {
            center: Vec2 {
                x: a.position.x + cos * att.longitudinal_m - sin * att.lateral_m,
                y: a.position.y + sin * att.longitudinal_m + cos * att.lateral_m,
            },
            length_m: prop.length_m,
            width_m: prop.width_m,
            heading_rad: normalize_angle(a.heading_rad + att.heading_offset_rad),
        }
    }

    /// Body, articulated doors and attached collidable props of one actor.
    pub(super) fn collision_shapes_into(&self, index: ActorIndex, t: f64, out: &mut Vec<Shape>) {
        let a = &self.actors[index.index()];
        out.clear();
        out.push(Shape {
            label: ShapeLabel::Body,
            obb: Self::obb_of(a),
        });
        for name in DoorName::ALL {
            let Some(door) = self.door_at(index, name) else {
                continue;
            };
            let openness = door.openness(t);
            if openness <= 1e-9 && !door.transitioning {
                continue;
            }
            out.push(Shape {
                label: ShapeLabel::Door(name),
                obb: articulated_door_obb_for(a, name, openness),
            });
        }
        for (slot, prop) in self.attached[index.index()].iter().enumerate() {
            if !prop.collidable {
                continue;
            }
            out.push(Shape {
                label: ShapeLabel::Prop(slot as u32),
                obb: Self::attached_prop_obb(a, prop),
            });
        }
    }

    fn update_door_transitions(&mut self, t: f64) {
        for i in 0..self.doors.len() {
            let door = self.doors[i];
            if !door.transitioning || t < door.started_t + door.duration_s {
                continue;
            }
            self.doors[i].from = door.target;
            self.doors[i].transitioning = false;
            let value =
                SetValue::Text(if door.target > 0.0 { "open" } else { "closed" }.to_owned());
            let actor = &mut self.actors[door.actor.index()];
            actor.set_state_key_str(door.name.state_key(), value.clone());
            if t >= 0.0 {
                self.events.push(SimEvent::StateSet {
                    t,
                    actor_id: actor.id.clone(),
                    key: door.name.state_key().to_owned(),
                    value,
                });
            }
        }
    }

    /// Attached occluding props for this tick, sorted by carrier id then
    /// prop id (the attached list is already id-sorted per carrier).
    pub(super) fn rebuild_prop_occluders(&mut self) {
        let shapes = &mut self.scratch.prop_occluders;
        shapes.clear();
        for &index in &self.sorted_actors {
            let a = &self.actors[index.index()];
            if !a.is_live() {
                continue;
            }
            for prop in &self.attached[index.index()] {
                if !prop.occludes {
                    continue;
                }
                let obb = Self::attached_prop_obb(a, prop);
                shapes.push((prop.prop_index, obb, prop.height_m, obb_corners(&obb)));
            }
        }
    }

    /// This tick's full occluder set: authored boxes, declared live bodies,
    /// then attached occluding props. Call [`Self::rebuild_prop_occluders`]
    /// first. One vector per tick, never per actor.
    pub(super) fn tick_occluders(&self) -> Vec<OccluderShape<'_>> {
        collect_world_occluders(
            &self.occluders,
            &self.actors,
            &self.occluder_keys,
            &self.scratch.prop_occluders,
            &self.input.props,
        )
    }

    /// Complete coarse visibility geometry for ego control: every live actor
    /// except the endpoints, every collidable prop/map proxy, authored LOS
    /// boxes and attached blockers.
    fn ego_can_perceive(&self, observer: &ActorRuntime, target: ActorIndex) -> bool {
        if Some(observer.index) != self.ego {
            return true;
        }
        let target_actor = &self.actors[target.index()];
        if !target_actor.is_live() {
            return false;
        }
        let dx = target_actor.position.x - observer.position.x;
        let dy = target_actor.position.y - observer.position.y;
        let range_m = hypot(dx, dy);
        let max_range_m =
            EGO_SENSOR_RANGE_M.min(self.input.operational_conditions.effects.visibility_range_m);
        if range_m > max_range_m {
            return false;
        }
        let bearing = atan2(dy, dx);
        if normalize_angle(bearing - observer.heading_rad).abs() > EGO_SENSOR_HALF_ANGLE_RAD {
            return false;
        }
        let from = observer.position;
        let to = target_actor.position;
        if hypot(to.x - from.x, to.y - from.y) > max_range_m {
            return false;
        }
        let blocked_by = |corners: &[Vec2; 4]| -> bool {
            (0..4).any(|i| {
                crate::math::segment_intersection(from, to, corners[i], corners[(i + 1) % 4])
                    .is_some()
            })
        };
        for occ in &self.occluders {
            if blocked_by(&occ.corners) {
                return false;
            }
        }
        for a in &self.actors {
            if a.index == observer.index || a.index == target || !a.is_live() {
                continue;
            }
            if blocked_by(&obb_corners(&Self::obb_of(a))) {
                return false;
            }
        }
        for shape in self.statics.shapes() {
            if blocked_by(&shape.corners) {
                return false;
            }
        }
        for &index in &self.sorted_actors {
            let carrier = &self.actors[index.index()];
            if !carrier.is_live() {
                continue;
            }
            for prop in &self.attached[index.index()] {
                if prop.occludes
                    && blocked_by(&obb_corners(&Self::attached_prop_obb(carrier, prop)))
                {
                    return false;
                }
            }
        }
        true
    }

    pub(super) fn ego_perceives(&self, observer: ActorIndex, target: ActorIndex) -> bool {
        self.ego_can_perceive(&self.actors[observer.index()], target)
    }

    fn swept_bounds(id: u32, current: &[Shape], previous: Option<&[Shape]>) -> SpatialBounds {
        let mut b = SpatialBounds {
            id,
            min_x: f64::INFINITY,
            min_y: f64::INFINITY,
            max_x: f64::NEG_INFINITY,
            max_y: f64::NEG_INFINITY,
        };
        let mut fold = |shapes: &[Shape]| {
            for shape in shapes {
                // A rotating OBB never leaves its circumscribed circle.
                let radius = hypot(shape.obb.length_m, shape.obb.width_m) / 2.0;
                b.min_x = b.min_x.min(shape.obb.center.x - radius);
                b.min_y = b.min_y.min(shape.obb.center.y - radius);
                b.max_x = b.max_x.max(shape.obb.center.x + radius);
                b.max_y = b.max_y.max(shape.obb.center.y + radius);
            }
        };
        fold(current);
        if let Some(previous) = previous {
            fold(previous);
        }
        b
    }

    fn detect_collisions(&mut self, t: f64) {
        let n = self.actors.len();
        let mut scratch = std::mem::take(&mut self.scratch);
        scratch.current_shapes.resize_with(n, Vec::new);
        scratch.live_actors.clear();
        for index in 0..n {
            let mut shapes = std::mem::take(&mut scratch.current_shapes[index]);
            self.collision_shapes_into(ActorIndex(index as u32), t, &mut shapes);
            scratch.current_shapes[index] = shapes;
            if self.actors[index].is_live() {
                scratch.live_actors.push(ActorIndex(index as u32));
            }
        }
        scratch.detected.clear();
        scratch.overlapping_now.clear();
        scratch.contacts.clear();

        // Candidate actor pairs: broadphase with ambient traffic, all pairs otherwise.
        scratch.pairs.clear();
        if self.has_ambient {
            scratch.bounds.clear();
            for &index in &scratch.live_actors {
                let previous = &self.collision_snapshots[index.index()];
                scratch.bounds.push(Self::swept_bounds(
                    index.0,
                    &scratch.current_shapes[index.index()],
                    if previous.live {
                        Some(&previous.shapes)
                    } else {
                        None
                    },
                ));
            }
            let mut pairs = std::mem::take(&mut scratch.pairs);
            candidate_pairs(
                &scratch.bounds,
                COLLISION_GRID_CELL_M,
                &mut scratch.spatial,
                &mut pairs,
            );
            scratch.pairs = pairs;
        } else {
            for i in 0..scratch.live_actors.len() {
                for j in (i + 1)..scratch.live_actors.len() {
                    scratch
                        .pairs
                        .push((scratch.live_actors[i].0, scratch.live_actors[j].0));
                }
            }
        }

        for &(ia, ib) in &scratch.pairs {
            let a = ActorIndex(ia);
            let b = ActorIndex(ib);
            let shapes_a = &scratch.current_shapes[a.index()];
            let shapes_b = &scratch.current_shapes[b.index()];
            let mut current_overlap = false;
            let mut contact_t: Option<f64> = None;
            let mut collider_a = ShapeLabel::Body;
            let mut collider_b = ShapeLabel::Body;
            for sa in shapes_a {
                for sb in shapes_b {
                    if obb_overlap(&sa.obb, &sb.obb) {
                        current_overlap = true;
                        contact_t = Some(t);
                        collider_a = sa.label;
                        collider_b = sb.label;
                    }
                }
            }
            let key = ordered(CollisionParty::Actor(a), CollisionParty::Actor(b));
            if current_overlap {
                scratch.overlapping_now.push(key);
            }
            let prev_a = &self.collision_snapshots[a.index()];
            let prev_b = &self.collision_snapshots[b.index()];
            if let Some(prev_t) = self.previous_collision_t {
                if prev_a.live && prev_b.live {
                    for sa in shapes_a {
                        let Some(pa) = prev_a.shapes.iter().find(|s| s.label == sa.label) else {
                            continue;
                        };
                        for sb in shapes_b {
                            let Some(pb) = prev_b.shapes.iter().find(|s| s.label == sb.label)
                            else {
                                continue;
                            };
                            let Some(toi) =
                                swept_obb_time_of_impact(&pa.obb, &sa.obb, &pb.obb, &sb.obb)
                            else {
                                continue;
                            };
                            let swept_t = prev_t + (t - prev_t) * toi;
                            if contact_t.map_or(true, |c| swept_t < c) {
                                contact_t = Some(swept_t);
                                collider_a = sa.label;
                                collider_b = sb.label;
                            }
                        }
                    }
                }
            }
            // A swept contact wholly inside the warm-up must not satisfy a
            // collision trigger at t=0. A box still overlapping at t=0 does.
            if current_overlap || contact_t.map_or(false, |c| t < 0.0 || c >= 0.0) {
                scratch.detected.push(key);
            }
            if let Some(c) = contact_t {
                if c >= 0.0 && self.active_collisions.binary_search(&key).is_err() {
                    let a_first = crate::hash::cmp_utf16(
                        &self.actors[a.index()].id,
                        &self.actors[b.index()].id,
                    ) == std::cmp::Ordering::Less;
                    let (lo, hi, ca, cb) = if a_first {
                        (a, b, collider_a, collider_b)
                    } else {
                        (b, a, collider_b, collider_a)
                    };
                    scratch.contacts.push(ContactRecord {
                        t: c,
                        a: CollisionParty::Actor(lo),
                        b: CollisionParty::Actor(hi),
                        collider_a: self.collider_name(lo, ca),
                        collider_b: self.collider_name(hi, cb),
                    });
                }
            }
        }

        // Fixed props/map proxies participate in the same continuous pipeline.
        for &index in &scratch.live_actors {
            let shapes = &scratch.current_shapes[index.index()];
            let previous = &self.collision_snapshots[index.index()];
            let bounds = Self::swept_bounds(
                index.0,
                shapes,
                if previous.live {
                    Some(&previous.shapes)
                } else {
                    None
                },
            );
            self.statics.candidates(
                bounds.min_x,
                bounds.min_y,
                bounds.max_x,
                bounds.max_y,
                &mut scratch.static_candidates,
            );
            for &slot in &scratch.static_candidates {
                let shape = self.statics.shape(slot);
                let key = ordered(CollisionParty::Actor(index), CollisionParty::Static(slot));
                let mut current_overlap = false;
                let mut contact_t: Option<f64> = None;
                let mut collider_actor = ShapeLabel::Body;
                for s in shapes {
                    if obb_overlap(&s.obb, &shape.obb) {
                        current_overlap = true;
                        contact_t = Some(t);
                        collider_actor = s.label;
                    }
                    let Some(prev_t) = self.previous_collision_t else {
                        continue;
                    };
                    if !previous.live {
                        continue;
                    }
                    let Some(prior) = previous.shapes.iter().find(|p| p.label == s.label) else {
                        continue;
                    };
                    let Some(toi) =
                        swept_obb_time_of_impact(&prior.obb, &s.obb, &shape.obb, &shape.obb)
                    else {
                        continue;
                    };
                    let swept_t = prev_t + (t - prev_t) * toi;
                    if contact_t.map_or(true, |c| swept_t < c) {
                        contact_t = Some(swept_t);
                        collider_actor = s.label;
                    }
                }
                if current_overlap {
                    scratch.overlapping_now.push(key);
                }
                if current_overlap || contact_t.map_or(false, |c| t < 0.0 || c >= 0.0) {
                    scratch.detected.push(key);
                }
                if let Some(c) = contact_t {
                    if c >= 0.0 && self.active_collisions.binary_search(&key).is_err() {
                        let actor_first =
                            crate::hash::cmp_utf16(&self.actors[index.index()].id, &shape.id)
                                == std::cmp::Ordering::Less;
                        let (pa, pb, ca, cb) = if actor_first {
                            (
                                CollisionParty::Actor(index),
                                CollisionParty::Static(slot),
                                self.collider_name(index, collider_actor),
                                ColliderName::Static,
                            )
                        } else {
                            (
                                CollisionParty::Static(slot),
                                CollisionParty::Actor(index),
                                ColliderName::Static,
                                self.collider_name(index, collider_actor),
                            )
                        };
                        scratch.contacts.push(ContactRecord {
                            t: c,
                            a: pa,
                            b: pb,
                            collider_a: ca,
                            collider_b: cb,
                        });
                    }
                }
            }
        }

        scratch.detected.sort_unstable();
        scratch.detected.dedup();
        // Sub-tick contact times can differ within one interval; sort them so
        // event order is independent of actor declaration.
        {
            let actors = &self.actors;
            let statics = &self.statics;
            let name_of = |p: CollisionParty| -> &str {
                match p {
                    CollisionParty::Actor(i) => &actors[i.index()].id,
                    CollisionParty::Static(s) => &statics.shape(s).id,
                }
            };
            scratch.contacts.sort_by(|x, y| {
                x.t.partial_cmp(&y.t)
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then_with(|| {
                        crate::hash::cmp_utf16(name_of(x.a), name_of(y.a))
                            .then_with(|| crate::hash::cmp_utf16(name_of(x.b), name_of(y.b)))
                    })
            });
        }
        for contact in &scratch.contacts {
            let a_id = self.party_id(contact.a).to_owned();
            let b_id = self.party_id(contact.b).to_owned();
            let (collider_a, collider_b) = if contact.collider_a == ColliderName::Body
                && contact.collider_b == ColliderName::Body
            {
                (None, None)
            } else {
                (
                    Some(self.collider_string(contact.collider_a)),
                    Some(self.collider_string(contact.collider_b)),
                )
            };
            self.events.push(SimEvent::Collision {
                t: contact.t,
                a: a_id.clone(),
                b: b_id.clone(),
                collider_a: collider_a.clone(),
                collider_b: collider_b.clone(),
            });
            if self.capture || self.live {
                self.metrics.record_collision(CollisionRecord {
                    t: contact.t,
                    a: a_id.clone(),
                    b: b_id.clone(),
                    collider_a,
                    collider_b,
                });
            }
            for (party, other) in [(contact.a, contact.b), (contact.b, contact.a)] {
                let CollisionParty::Actor(index) = party else {
                    continue;
                };
                let other_id = self.party_id(other).to_owned();
                let actor = &mut self.actors[index.index()];
                if actor.is_static || actor.crash.is_some() {
                    continue;
                }
                actor.crash = Some(super::actor::CrashLatch {
                    at_s: contact.t,
                    other_id: other_id.clone(),
                });
                actor.timed_route = None;
                let lat = actor.lat_cmd.take().map(|c| c.interaction);
                actor.long_cmd = None;
                actor.lateral_accel_mps2 = 0.0;
                actor.until_by_axis.clear();
                let actor_id = actor.id.clone();
                if let Some(interaction) = lat {
                    self.abort_lateral(
                        interaction,
                        index,
                        contact.t,
                        crate::trace::AbortReason::Collision,
                    );
                }
                self.events.push(SimEvent::CrashDisabled {
                    t: contact.t,
                    actor_id,
                    other_id,
                    reason: crate::trace::CrashReason::MaterialCollision,
                });
            }
        }

        scratch.overlapping_now.sort_unstable();
        scratch.overlapping_now.dedup();
        self.active_collisions.clear();
        self.active_collisions
            .extend_from_slice(&scratch.overlapping_now);
        for index in 0..n {
            let snapshot = &mut self.collision_snapshots[index];
            snapshot.shapes.clear();
            snapshot
                .shapes
                .extend_from_slice(&scratch.current_shapes[index]);
            snapshot.live = self.actors[index].is_live();
        }
        self.previous_collision_t = Some(t);
        self.scratch = scratch;
    }

    pub(super) fn party_id(&self, party: CollisionParty) -> &str {
        match party {
            CollisionParty::Actor(i) => &self.actors[i.index()].id,
            CollisionParty::Static(s) => &self.statics.shape(s).id,
        }
    }

    fn collider_name(&self, actor: ActorIndex, label: ShapeLabel) -> ColliderName {
        match label {
            ShapeLabel::Body => ColliderName::Body,
            ShapeLabel::Door(name) => ColliderName::Door(name),
            ShapeLabel::Prop(slot) => ColliderName::Prop(actor, slot),
        }
    }

    fn collider_string(&self, name: ColliderName) -> String {
        match name {
            ColliderName::Body => "body".to_owned(),
            ColliderName::Door(d) => d.collider_label().to_owned(),
            ColliderName::Prop(actor, slot) => {
                format!(
                    "prop:{}",
                    self.input.props
                        [self.attached[actor.index()][slot as usize].prop_index as usize]
                        .id
                )
            }
            ColliderName::Static => "static".to_owned(),
        }
    }

    /* ---------------------------------------------------------- perception */

    fn observe_perception(&mut self, t: f64) {
        self.rebuild_prop_occluders();
        let Some(mut perception) = self.perception.take() else {
            return;
        };
        {
            let occluders = self.tick_occluders();
            perception.pass.observe_tick(
                t,
                &self.actors,
                &self.graph,
                &occluders,
                &mut perception.accumulator,
            );
        }
        self.perception = Some(perception);
    }
}

/// Field-disjoint form of [`Simulation::tick_occluders`] so callers can hold
/// the result while mutating unrelated world fields.
pub(super) fn collect_world_occluders<'a>(
    statics: &'a [StaticOccluder],
    actors: &'a [ActorRuntime],
    keys: &'a ActorOccluderKeys,
    prop_occluders: &'a [(u32, Obb, f64, [Vec2; 4])],
    props: &'a [crate::types::StaticProp],
) -> Vec<OccluderShape<'a>> {
    let mut out = Vec::with_capacity(statics.len() + keys.declared().len() + prop_occluders.len());
    collect_tick_occluders(statics, actors, keys, &mut out);
    for (prop_index, obb, height_m, corners) in prop_occluders {
        out.push(OccluderShape {
            id: &props[*prop_index as usize].id,
            group_id: None,
            actor: None,
            obb: *obb,
            height_m: *height_m,
            corners: *corners,
        });
    }
    out
}

#[inline]
pub(super) fn ordered(a: CollisionParty, b: CollisionParty) -> (CollisionParty, CollisionParty) {
    if a <= b {
        (a, b)
    } else {
        (b, a)
    }
}

/// `run_simulation(input, options)`: construct, run to completion and return
/// the executed input, trace, issues and arrival solutions.
pub fn run_simulation(input: SimScenarioInput, options: RunOptions) -> EngineResult<SimResult> {
    Simulation::new(input, options)?.run()
}
