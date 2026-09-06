//! `WorldSession` — a multi-client, command-driven world over the fixed-step
//! engine.
//!
//! Clip sessions preserve the authored finite-trace behaviour and rebuild
//! after structural commands. Live sessions use the engine's incremental actor
//! mutation surface: incumbent runtime state is untouched, the clip never
//! ends, and per-tick trace history is not retained. In either mode the
//! canonical input and ordered command log remain the deterministic replay
//! artifact.
//!
//! Engine entry points used (never forked): `ActorKind::default_dims`,
//! `LaneGraph::nearest_lane / sample_directed / nominal_reversed`,
//! `check_feasibility` (route/lane guards) plus `obb_overlap` against the
//! *current* world snapshot, and `Simulation` with a fixed action set per
//! advance segment.
//!
//! Digest: every engine tick with `t >= 0` is hashed (chained SHA-256 over
//! canonical sorted actor rows). Replaying the same mode and command log
//! reproduces the same frame sequence and digest.

use std::collections::{BTreeMap, VecDeque};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use simforge_core::engine::signals::{SignalBook, SignalSnapshot};
use simforge_core::engine::{
    ActionOverride, ActorAction, ActorSnapshot, GuardMode, RunOptions, SessionMode, Simulation,
    SimulationCheckpoint, SimulationSnapshot, TickObservation,
};
use simforge_core::error::SimIssue;
use simforge_core::hash::{js_number_to_string, sha256};
use simforge_core::map::{DirectedLane, LaneGraph, NearestLaneQuery};
use simforge_core::math::{
    local_from_scene, obb_overlap, scene_heading, to_scene_xz, Obb, SceneXZ, Vec2,
};
use simforge_core::solve::guards::check_feasibility;
use simforge_core::trace::events::SimEvent;
use simforge_core::trace::scene_state::{
    actor_class_of, ActorClass, LiveActorSample, SceneFrame, SceneStateStream,
};
use simforge_core::types::{
    ActorBehavior, ActorInitial, ActorKind, ActorRules, Dims, ExistState, ExistTarget, Interaction,
    LaneRef, Pose, RouteSpec, ScenePoint, SimActor, SimScenarioInput, Trigger, Verb,
};

use crate::error::{Result, SessionError};

/// Version tag of the session-log artifact; bumped on any breaking change.
pub const WORLD_SESSION_LOG_VERSION: u32 = 2;

const EPS_S: f64 = 1e-9;
/// Ground-snap search radius; matches `LaneGraph::nearest_lane`'s default.
const SNAP_MAX_DIST_M: f64 = 25.0;
/// Default bounded frame count for one truth subscriber.
pub const WORLD_TRUTH_QUEUE_CAPACITY: usize = 256;
const SPAWNED_TAG: &str = "world-session:spawned";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorldMode {
    #[default]
    Clip,
    Live,
}

/* ------------------------------------------------------------- commands */

/// A runtime spawn request. Everything beyond `kind` and `pose` has an
/// engine-derived default: dims from the kind, lane placement from the nearest
/// drivable lane (road kinds), heading from the snapped lane tangent, and a
/// `follow` route from the snapped lane (road kinds) or a zero-length
/// `polyline` hold (everything else).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnRequest {
    /// Explicit actor id; must be globally unused. Omitted = allocated (`ws:NNNN`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub kind: ActorKind,
    /// Scene-frame ground pose. `heading_rad` optional when lane-snapped.
    pub pose: SpawnPose,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speed_mps: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dims: Option<Dims>,
    /// Explicit route; overrides the snap-derived default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub route: Option<RouteSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cruise_speed_mps: Option<f64>,
    /// Snap pose to the nearest drivable lane. Default: `kind.is_road_actor()`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snap_to_lane: Option<bool>,
    #[serde(default, rename = "static", skip_serializing_if = "Option::is_none")]
    pub is_static: Option<bool>,
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnPose {
    pub x: f64,
    pub z: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub heading_rad: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum BatchOp {
    Spawn {
        spawn: SpawnRequest,
    },
    #[serde(rename_all = "camelCase")]
    Despawn {
        actor_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum WorldCommand {
    Spawn {
        spawn: SpawnRequest,
    },
    #[serde(rename_all = "camelCase")]
    Despawn {
        actor_id: String,
    },
    /// Atomic: every op applies, or none does and the world is untouched.
    Batch {
        ops: Vec<BatchOp>,
    },
    /// Zero-order-hold action override for one actor; `None` releases it.
    #[serde(rename_all = "camelCase")]
    Act {
        actor_id: String,
        action: Option<ActionOverride>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandOutcome {
    pub ok: bool,
    /// Actor ids allocated/affected by spawn ops, in op order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub actor_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl CommandOutcome {
    fn reject(error: impl Into<String>) -> Self {
        Self {
            ok: false,
            actor_ids: Vec::new(),
            error: Some(error.into()),
        }
    }
}

/* ------------------------------------------------------------ session log */

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum WorldLogEntry {
    #[serde(rename_all = "camelCase")]
    Command {
        client_id: String,
        seq: u64,
        command: WorldCommand,
        ok: bool,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        actor_ids: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    Advance {
        ticks: usize,
    },
}

/// The session log artifact: everything needed to replay the world exactly.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorldSessionLog {
    pub version: u32,
    /// Content hash of the normalized base input the session was built from.
    pub base_input_hash: String,
    pub mode: WorldMode,
    pub horizon_seconds: f64,
    pub entries: Vec<WorldLogEntry>,
    /// Chained frame digest at export time.
    pub digest: String,
}

/* -------------------------------------------------------------- snapshots */

/// Scene-frame actor row exposed to clients.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorldActorState {
    pub id: String,
    pub kind: ActorKind,
    pub x: f64,
    pub z: f64,
    pub heading_rad: f64,
    pub speed_mps: f64,
    pub present: bool,
    pub s: f64,
    pub lane_rsl: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorldSnapshot {
    pub t_s: f64,
    pub tick: usize,
    pub done: bool,
    pub actors: Vec<WorldActorState>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdvanceResult {
    pub t_s: f64,
    pub tick: usize,
    pub done: bool,
    pub events: Vec<SimEvent>,
    pub actors: Vec<WorldActorState>,
}

#[derive(Clone)]
pub struct WorldSessionOptions {
    /// Graph, static colliders and arrival options; `guards`, `mode` and trace
    /// capture are owned by the session.
    pub run_options: RunOptions,
    /// Finite horizon in clip mode (default 120 s). Ignored in live mode.
    pub horizon_seconds: Option<f64>,
    pub mode: WorldMode,
}

/* ------------------------------------------------------------- truth */

/// Static actor identity carried beside the frozen scene-state frame.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TruthActor {
    pub id: String,
    pub class: ActorClass,
    pub dims: Dims,
    /// XODR-local world-plane acceleration in m/s².
    pub accel: TruthAccel,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct TruthAccel {
    pub ax: f64,
    pub ay: f64,
}

/// Frozen world-session truth contract: one complete value per committed
/// tick. Bindings encode it (msgpack/JSON) at the transport boundary.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TruthFrame {
    pub tick: u64,
    pub time_sec: f64,
    pub scene: SceneFrame,
    pub signals: Vec<SignalSnapshot>,
    pub actors: Vec<TruthActor>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct TruthSubscriptionStats {
    pub queued: usize,
    /// Cumulative frames discarded from this subscription by drop-oldest.
    pub dropped: u64,
}

#[derive(Debug, Default)]
struct TruthQueue {
    pending: VecDeque<Arc<TruthFrame>>,
    dropped: u64,
    active: bool,
}

/// One pull-based subscriber. Publishing only enqueues an already-built
/// shared frame; it never invokes consumer code on the engine tick path, and
/// a full queue drops the OLDEST frame so a slow consumer can never stall
/// world advancement.
#[derive(Debug, Clone)]
pub struct TruthSubscription {
    capacity: usize,
    queue: Arc<Mutex<TruthQueue>>,
}

impl TruthSubscription {
    #[inline]
    pub fn capacity(&self) -> usize {
        self.capacity
    }

    /// Pull the oldest complete frame, or `None` when caught up.
    pub fn read(&self) -> Option<Arc<TruthFrame>> {
        self.queue
            .lock()
            .expect("truth queue poisoned")
            .pending
            .pop_front()
    }

    /// Pull every currently queued frame in tick order, appending to `out`.
    pub fn drain_into(&self, out: &mut Vec<Arc<TruthFrame>>) {
        let mut q = self.queue.lock().expect("truth queue poisoned");
        out.extend(q.pending.drain(..));
    }

    pub fn stats(&self) -> TruthSubscriptionStats {
        let q = self.queue.lock().expect("truth queue poisoned");
        TruthSubscriptionStats {
            queued: q.pending.len(),
            dropped: q.dropped,
        }
    }

    pub fn is_active(&self) -> bool {
        self.queue.lock().expect("truth queue poisoned").active
    }

    pub fn unsubscribe(&self) {
        let mut q = self.queue.lock().expect("truth queue poisoned");
        q.active = false;
        q.pending.clear();
    }
}

/// Per-world fan-out. A tick is composed once, then the same immutable frame
/// is enqueued for every subscriber.
struct WorldTruthPublisher {
    subscribers: Vec<TruthSubscription>,
    stream: SceneStateStream,
    dt_s: f64,
}

impl WorldTruthPublisher {
    fn new(dt_s: f64) -> Self {
        Self {
            subscribers: Vec::new(),
            stream: SceneStateStream::new(dt_s),
            dt_s,
        }
    }

    fn subscribe(&mut self, capacity: usize) -> Result<TruthSubscription> {
        if capacity == 0 {
            return Err(SessionError::World(
                "truth subscription capacity must be a positive integer".into(),
            ));
        }
        self.prune();
        if self.subscribers.is_empty() {
            self.stream = SceneStateStream::new(self.dt_s);
        }
        let sub = TruthSubscription {
            capacity,
            queue: Arc::new(Mutex::new(TruthQueue {
                pending: VecDeque::with_capacity(capacity),
                dropped: 0,
                active: true,
            })),
        };
        self.subscribers.push(sub.clone());
        Ok(sub)
    }

    fn prune(&mut self) {
        self.subscribers.retain(TruthSubscription::is_active);
    }

    fn subscriber_count(&mut self) -> usize {
        self.prune();
        self.subscribers.len()
    }

    /// `ids[ActorIndex::index()]` and `book` are captured before the advance so
    /// the tick callback never borrows the simulation it observes.
    fn publish(
        &mut self,
        obs: &TickObservation<'_>,
        ids: &[String],
        book: &SignalBook,
        catalog: &BTreeMap<String, (ActorKind, Dims)>,
    ) -> Result<()> {
        self.prune();
        if self.subscribers.is_empty() {
            return Ok(());
        }
        let scene = self.stream.frame(
            obs.tick_index,
            obs.t_s,
            obs.actors.iter().map(|a| LiveActorSample {
                id: ids[a.index.index()].as_str(),
                present: a.present,
                position: Vec2 { x: a.x, y: a.y },
                heading_rad: a.heading_rad,
                speed_mps: a.speed_mps,
            }),
        );
        let mut actors = Vec::with_capacity(scene.actors.len());
        for tick in &scene.actors {
            let (kind, dims) = catalog.get(&tick.id).ok_or_else(|| {
                SessionError::World(format!(
                    "truth stream has no actor catalog entry for {}",
                    tick.id
                ))
            })?;
            actors.push(TruthActor {
                id: tick.id.clone(),
                class: actor_class_of(*kind),
                dims: *dims,
                // Scene acceleration is [ax, 0, -ay] in the y-up frame.
                accel: TruthAccel {
                    ax: tick.acceleration[0],
                    ay: -tick.acceleration[2],
                },
            });
        }
        let frame = Arc::new(TruthFrame {
            tick: obs.tick_index,
            time_sec: scene.t,
            signals: book.snapshots_at(obs.t_s, Some(self.dt_s)),
            scene,
            actors,
        });
        for sub in &self.subscribers {
            let mut q = sub.queue.lock().expect("truth queue poisoned");
            if !q.active {
                continue;
            }
            if q.pending.len() >= sub.capacity {
                q.pending.pop_front();
                q.dropped += 1;
            }
            q.pending.push_back(Arc::clone(&frame));
        }
        Ok(())
    }
}

/* ------------------------------------------------------------ the session */

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActionEpoch {
    from_t_s: f64,
    actor_id: String,
    action: Option<ActionOverride>,
}

/// Complete continuation state of a world session. The world-owned canonical
/// input includes live structural edits that do not rebuild the engine input.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorldCheckpoint {
    pub base_input_hash: String,
    pub input: serde_json::Value,
    pub mode: WorldMode,
    pub horizon_seconds: f64,
    pub simulation: SimulationCheckpoint,
    pub tick_count: usize,
    pub actor_counter: u32,
    pub exist_counter: u32,
    timeline: Vec<ActionEpoch>,
    pub pending_events: Vec<SimEvent>,
    pub entries: Vec<WorldLogEntry>,
    pub digest: String,
}

pub struct WorldSession {
    graph: Arc<LaneGraph>,
    run_options: RunOptions,
    horizon_seconds: f64,
    mode: WorldMode,
    /// Canonical, normalized current input; swapped atomically on commit.
    input: SimScenarioInput,
    base_input_hash: String,
    sim: Simulation,

    /// Ticks requested past t = 0; live mode never clamps.
    tick_count: usize,
    actor_counter: u32,
    exist_counter: u32,
    /// Append-only, time-ordered zero-order-hold action timeline.
    timeline: Vec<ActionEpoch>,
    /// Spawn/despawn events surfaced by clip-mode rebuild catch-up.
    pending_events: Vec<SimEvent>,
    entries: Vec<WorldLogEntry>,
    digest_hex: String,
    truth: WorldTruthPublisher,
    catalog: BTreeMap<String, (ActorKind, Dims)>,
    /// Canonical id per `ActorIndex::index()`; refreshed on every structural commit.
    ids: Vec<String>,

    // Reused buffers.
    snapshot: SimulationSnapshot,
    actions: Vec<ActorAction>,
    digest_buf: String,
}

fn pad(n: u32, width: usize) -> String {
    format!("{n:0width$}")
}

/// Does a feasibility-issue path refer to one of `ids`? Paths are dotted (`actors.<id>.…`).
fn path_touches(path: &str, ids: &[String]) -> bool {
    ids.iter().any(|id| {
        path == format!("actors.{id}")
            || path.starts_with(&format!("actors.{id}."))
            || path == format!("interactions.{id}")
            || path.starts_with(&format!("interactions.{id}."))
            || path.contains(&format!(".{id}."))
            || path.ends_with(&format!(".{id}"))
    })
}

struct ResolvedPlacement {
    pose: Pose,
    lane_ref: Option<LaneRef>,
    route: RouteSpec,
}

impl WorldSession {
    pub fn new(input: SimScenarioInput, options: WorldSessionOptions) -> Result<Self> {
        let mode = options.mode;
        let horizon_seconds = options.horizon_seconds.unwrap_or(120.0);
        if !(horizon_seconds > 0.0) {
            return Err(SessionError::Config(format!(
                "horizonSeconds must be positive, got {horizon_seconds}"
            )));
        }
        let mut input = input;
        if mode == WorldMode::Clip {
            input.clip_seconds = horizon_seconds;
        }
        let input = input.normalized();
        let base_input_hash = input.content_hash()?;
        let mut run_options = options.run_options;
        // Guards are Skip: the constructor and every structural commit run
        // check_feasibility explicitly, so construction must never re-litigate.
        run_options.guards = GuardMode::Skip;
        run_options.mode = match mode {
            WorldMode::Clip => SessionMode::Clip,
            WorldMode::Live => SessionMode::Live,
        };
        run_options.capture_trace = false;

        let errors: Vec<SimIssue> = check_feasibility(&input, &run_options.graph)
            .into_iter()
            .filter(SimIssue::is_error)
            .collect();
        if !errors.is_empty() {
            let list: Vec<String> = errors
                .iter()
                .map(|i| format!("{}@{}", i.code.as_str(), i.path))
                .collect();
            return Err(SessionError::World(format!(
                "base input fails feasibility: {}",
                list.join(", ")
            )));
        }
        let digest_hex = sha256(&format!(
            "world-session.v{WORLD_SESSION_LOG_VERSION}:{base_input_hash}:{}",
            mode_str(mode)
        ));
        let dt = input.dt;
        let mut sim = Simulation::new(input.clone(), run_options.clone())?;
        Self::consume_warmup(&mut sim)?;
        let snapshot = sim.peek();
        let mut session = Self {
            graph: run_options.graph.clone(),
            run_options,
            horizon_seconds,
            mode,
            input,
            base_input_hash,
            sim,
            tick_count: 0,
            actor_counter: 0,
            exist_counter: 0,
            timeline: Vec::new(),
            pending_events: Vec::new(),
            entries: Vec::new(),
            digest_hex,
            truth: WorldTruthPublisher::new(dt),
            catalog: BTreeMap::new(),
            ids: Vec::new(),
            snapshot,
            actions: Vec::new(),
            digest_buf: String::new(),
        };
        session.refresh_catalog();
        Ok(session)
    }

    /// The engine records state *at* t before stepping, so consuming exactly
    /// warmupTicks leaves the snapshot at t = -dt; one more tick parks the
    /// world at t = 0 (same convention as `EnvSession`).
    fn consume_warmup(sim: &mut Simulation) -> Result<()> {
        let warmup_ticks = sim.input().warmup_ticks() as usize + 1;
        sim.advance(warmup_ticks, &[])?;
        Ok(())
    }

    fn refresh_catalog(&mut self) {
        self.catalog.clear();
        self.ids.clear();
        for a in &self.input.actors {
            self.catalog.insert(a.id.clone(), (a.kind, a.dims));
            if let Some(idx) = self.sim.actor_index(&a.id) {
                if self.ids.len() <= idx.index() {
                    self.ids.resize(idx.index() + 1, String::new());
                }
                self.ids[idx.index()] = a.id.clone();
            }
        }
    }

    /* ---------------------------------------------------------- read side */

    #[inline]
    pub fn mode(&self) -> WorldMode {
        self.mode
    }

    #[inline]
    pub fn base_input_hash(&self) -> &str {
        &self.base_input_hash
    }

    /// The canonical current input (base plus every committed structural op).
    #[inline]
    pub fn input(&self) -> &SimScenarioInput {
        &self.input
    }

    #[inline]
    pub fn simulation(&self) -> &Simulation {
        &self.sim
    }

    pub fn time(&self) -> f64 {
        self.sim.t_s()
    }

    #[inline]
    pub fn tick(&self) -> usize {
        self.tick_count
    }

    #[inline]
    pub fn digest(&self) -> &str {
        &self.digest_hex
    }

    /// Subscribe to future committed ticks. The pull queue is bounded and uses
    /// drop-oldest, so a consumer can never stall world advancement.
    pub fn subscribe_truth(&mut self, capacity: Option<usize>) -> Result<TruthSubscription> {
        self.truth
            .subscribe(capacity.unwrap_or(WORLD_TRUTH_QUEUE_CAPACITY))
    }

    pub fn truth_subscriber_count(&mut self) -> usize {
        self.truth.subscriber_count()
    }

    fn actor_rows(&self, snap: &SimulationSnapshot, out: &mut Vec<WorldActorState>) {
        out.clear();
        out.reserve(snap.actors.len());
        for a in &snap.actors {
            let id = self.sim.actor_id(a.index);
            let scene = to_scene_xz(Vec2 { x: a.x, y: a.y });
            out.push(WorldActorState {
                id: id.to_owned(),
                kind: self.catalog.get(id).map_or(ActorKind::Vehicle, |c| c.0),
                x: scene.x,
                z: scene.z,
                heading_rad: scene_heading(a.heading_rad),
                speed_mps: a.speed_mps,
                present: a.present,
                s: a.s,
                lane_rsl: a.lane.map(|l| self.graph.rsl(l).to_owned()),
            });
        }
    }

    pub fn snapshot(&mut self) -> WorldSnapshot {
        self.sim.peek_into(&mut self.snapshot);
        let mut actors = Vec::new();
        self.actor_rows(&self.snapshot, &mut actors);
        WorldSnapshot {
            t_s: self.snapshot.t_s,
            tick: self.tick_count,
            done: self.snapshot.done,
            actors,
        }
    }

    pub fn export_log(&self) -> WorldSessionLog {
        WorldSessionLog {
            version: WORLD_SESSION_LOG_VERSION,
            base_input_hash: self.base_input_hash.clone(),
            mode: self.mode,
            horizon_seconds: self.horizon_seconds,
            entries: self.entries.clone(),
            digest: self.digest_hex.clone(),
        }
    }

    /* --------------------------------------------------------- write side */

    /// Apply one command at the current tick boundary and record it in the
    /// log. Ordering across clients is the caller's contract (a registry sorts
    /// queued commands by client id, then seq, before applying).
    pub fn apply_command(
        &mut self,
        client_id: &str,
        seq: u64,
        command: &WorldCommand,
    ) -> Result<CommandOutcome> {
        let outcome = self.execute(command)?;
        self.entries.push(WorldLogEntry::Command {
            client_id: client_id.to_owned(),
            seq,
            command: command.clone(),
            ok: outcome.ok,
            actor_ids: outcome.actor_ids.clone(),
            error: outcome.error.clone(),
        });
        Ok(outcome)
    }

    /// Advance the engine by `ticks`, hashing every frame into the digest and
    /// publishing every committed tick to truth subscribers.
    pub fn advance(&mut self, ticks: usize) -> Result<AdvanceResult> {
        if ticks == 0 {
            return Err(SessionError::World(
                "ticks must be a positive integer".into(),
            ));
        }
        self.load_current_actions();
        let Self {
            sim,
            truth,
            catalog,
            digest_hex,
            digest_buf,
            actions,
            ids,
            ..
        } = self;
        // Overrides only change at command boundaries, so one copy of the
        // signal law is exact for the whole advance; skipped without subscribers.
        let book = (truth.subscriber_count() > 0).then(|| sim.signal_book().clone());
        let mut publish_error: Option<SessionError> = None;
        sim.advance_observed(ticks, actions, &mut |obs: &TickObservation<'_>| {
            if obs.t_s < -EPS_S {
                return;
            }
            chain_digest(digest_hex, digest_buf, ids, obs);
            if let (Some(book), None) = (&book, &publish_error) {
                if let Err(e) = truth.publish(obs, ids, book, catalog) {
                    publish_error = Some(e);
                }
            }
        })?;
        if let Some(e) = publish_error {
            return Err(e);
        }
        self.tick_count += ticks;
        let mut events = std::mem::take(&mut self.pending_events);
        self.sim.drain_events_into(&mut events);
        self.entries.push(WorldLogEntry::Advance { ticks });
        let snap = self.snapshot();
        Ok(AdvanceResult {
            t_s: snap.t_s,
            tick: snap.tick,
            done: snap.done,
            events,
            actors: snap.actors,
        })
    }

    /// Rebuild the fixed action set from the latest epoch per actor at or
    /// before the current time (zero-order hold).
    fn load_current_actions(&mut self) {
        let now = self.sim.t_s();
        actions_at(&self.timeline, now, &self.sim, &mut self.actions);
    }

    fn execute(&mut self, command: &WorldCommand) -> Result<CommandOutcome> {
        match command {
            WorldCommand::Spawn { spawn } => {
                self.apply_structural(std::slice::from_ref(&BatchOp::Spawn {
                    spawn: spawn.clone(),
                }))
            }
            WorldCommand::Despawn { actor_id } => self.apply_structural(&[BatchOp::Despawn {
                actor_id: actor_id.clone(),
            }]),
            WorldCommand::Batch { ops } => {
                if ops.is_empty() {
                    return Ok(CommandOutcome::reject("batch must contain at least one op"));
                }
                self.apply_structural(ops)
            }
            WorldCommand::Act { actor_id, action } => Ok(self.apply_act(actor_id, *action)),
        }
    }

    fn apply_act(&mut self, actor_id: &str, action: Option<ActionOverride>) -> CommandOutcome {
        if !self.input.actors.iter().any(|a| a.id == actor_id) {
            return CommandOutcome::reject(format!("act: unknown actor {actor_id}"));
        }
        self.timeline.push(ActionEpoch {
            from_t_s: self.sim.t_s(),
            actor_id: actor_id.to_owned(),
            action,
        });
        CommandOutcome {
            ok: true,
            ..CommandOutcome::default()
        }
    }

    /// Atomic structural mutation: resolve and validate every op against a
    /// candidate input. Live mode commits through incremental engine mutation;
    /// clip mode retains deterministic rebuild semantics. Any rejection leaves
    /// the world untouched.
    fn apply_structural(&mut self, ops: &[BatchOp]) -> Result<CommandOutcome> {
        self.sim.peek_into(&mut self.snapshot);
        let boundary_t_s = self.snapshot.t_s;

        let world_obbs: Vec<(String, Obb)> = self
            .snapshot
            .actors
            .iter()
            .filter(|a| a.present)
            .map(|a| {
                let id = self.sim.actor_id(a.index);
                let dims = self
                    .catalog
                    .get(id)
                    .map_or_else(|| ActorKind::Vehicle.default_dims(), |c| c.1);
                (id.to_owned(), obb_of(a, &dims))
            })
            .collect();

        let mut used_ids: Vec<&str> = self.input.actors.iter().map(|a| a.id.as_str()).collect();
        let present_now: Vec<&str> = self
            .snapshot
            .actors
            .iter()
            .filter(|a| a.present)
            .map(|a| self.sim.actor_id(a.index))
            .collect();
        let mut batch_spawned: Vec<String> = Vec::new();
        let mut batch_despawned: Vec<String> = Vec::new();
        let mut batch_obbs: Vec<(String, Obb)> = Vec::new();

        let mut new_actors: Vec<SimActor> = Vec::new();
        let mut new_interactions: Vec<Interaction> = Vec::new();
        let mut spawned_ids: Vec<String> = Vec::new();
        let mut actor_counter = self.actor_counter;
        let mut exist_counter = self.exist_counter;
        let mut allocated: Vec<String> = Vec::new();

        for op in ops {
            match op {
                BatchOp::Spawn { spawn: req } => {
                    if self.mode == WorldMode::Live && req.tags.iter().any(|t| t == "ambient") {
                        return Ok(CommandOutcome::reject(
                            "spawn: live ambient actors are not supported",
                        ));
                    }
                    let id: String = match &req.id {
                        Some(id) => {
                            if used_ids.contains(&id.as_str()) {
                                return Ok(CommandOutcome::reject(format!(
                                    "spawn: actor id {id} already in use"
                                )));
                            }
                            id.clone()
                        }
                        None => loop {
                            actor_counter += 1;
                            let candidate = format!("ws:{}", pad(actor_counter, 4));
                            if !used_ids.contains(&candidate.as_str()) {
                                break candidate;
                            }
                        },
                    };
                    let placement = match self.resolve_spawn_placement(req) {
                        Ok(p) => p,
                        Err(e) => return Ok(CommandOutcome::reject(format!("spawn {id}: {e}"))),
                    };
                    let dims = req.dims.unwrap_or_else(|| req.kind.default_dims());
                    let obb = Obb {
                        center: local_from_scene(SceneXZ {
                            x: placement.pose.x,
                            z: placement.pose.z,
                        }),
                        length_m: dims.l,
                        width_m: dims.w,
                        heading_rad: placement.pose.heading_rad,
                    };
                    let hit = world_obbs
                        .iter()
                        .chain(batch_obbs.iter())
                        .find(|(oid, other)| {
                            !batch_despawned.contains(oid) && obb_overlap(&obb, other)
                        });
                    if let Some((hit, _)) = hit {
                        return Ok(CommandOutcome::reject(format!(
                            "spawn {id}: footprint overlaps {hit} at the current tick"
                        )));
                    }
                    allocated.push(id.clone());
                    batch_spawned.push(id.clone());
                    batch_obbs.push((id.clone(), obb));
                    spawned_ids.push(id.clone());
                    let mut tags = req.tags.clone();
                    tags.push(SPAWNED_TAG.to_owned());
                    let is_static =
                        req.kind == ActorKind::StaticObject || req.is_static.unwrap_or(false);
                    new_actors.push(SimActor {
                        id: id.clone(),
                        kind: req.kind,
                        dims,
                        initial: ActorInitial {
                            lane_ref: placement.lane_ref,
                            pose: placement.pose,
                            speed_mps: req.speed_mps.unwrap_or(0.0),
                        },
                        behavior: ActorBehavior {
                            rules: ActorRules::default(),
                            route: placement.route,
                            driving_profile: None,
                            cruise_speed_mps: req.cruise_speed_mps,
                        },
                        present_at_start: false,
                        is_static,
                        tags,
                        sensors: None,
                    });
                    exist_counter += 1;
                    new_interactions.push(exist_interaction(
                        exist_counter,
                        &id,
                        boundary_t_s,
                        ExistState::Present,
                    ));
                }
                BatchOp::Despawn { actor_id } => {
                    let alive = (present_now.contains(&actor_id.as_str())
                        || batch_spawned.contains(actor_id))
                        && !batch_despawned.contains(actor_id);
                    if !alive {
                        return Ok(CommandOutcome::reject(format!(
                            "despawn: actor {actor_id} is not present at the current tick"
                        )));
                    }
                    batch_despawned.push(actor_id.clone());
                    exist_counter += 1;
                    new_interactions.push(exist_interaction(
                        exist_counter,
                        actor_id,
                        boundary_t_s,
                        ExistState::Absent,
                    ));
                }
            }
            // Allocated ids are reserved for the rest of the batch.
            used_ids = self
                .input
                .actors
                .iter()
                .map(|a| a.id.as_str())
                .chain(allocated.iter().map(String::as_str))
                .collect();
        }

        let mut candidate = self.input.clone();
        candidate.actors.extend(new_actors);
        candidate.interactions.extend(new_interactions);
        let candidate = candidate.normalized();

        // Feasibility gate, scoped to what this batch introduced: pre-existing
        // issues in the base input are not this batch's fault and never block it.
        let mut touched = spawned_ids.clone();
        touched.extend(batch_despawned.iter().cloned());
        let issues = check_feasibility(&candidate, &self.run_options.graph);
        if let Some(bad) = issues
            .iter()
            .find(|i| i.is_error() && path_touches(&i.path, &touched))
        {
            return Ok(CommandOutcome::reject(format!(
                "batch rejected by feasibility: {} at {}",
                bad.code.as_str(),
                bad.path
            )));
        }

        // Commit. A live engine accepts the same normalized actor specs
        // directly and never replays elapsed ticks; clip mode rebuilds. Both
        // paths are validated above, so an engine error here is a contract
        // failure and propagates as such.
        match self.mode {
            WorldMode::Live => {
                let mut spawned = spawned_ids.iter();
                for op in ops {
                    match op {
                        BatchOp::Spawn { .. } => {
                            let id = spawned.next().expect("one id per spawn op");
                            let actor = candidate
                                .actor(id)
                                .expect("spawned actor in candidate")
                                .clone();
                            self.sim.add_actor(actor)?;
                        }
                        BatchOp::Despawn { actor_id } => {
                            let idx = self.sim.actor_index(actor_id).ok_or_else(|| {
                                SessionError::World(format!("despawn: {actor_id} vanished"))
                            })?;
                            self.sim.set_actor_presence(idx, false)?;
                        }
                    }
                }
                self.input = candidate;
            }
            WorldMode::Clip => {
                let sim = self.rebuild(&candidate, &touched, boundary_t_s)?;
                self.sim = sim;
                self.input = candidate;
            }
        }
        self.refresh_catalog();
        self.actor_counter = actor_counter;
        self.exist_counter = exist_counter;
        Ok(CommandOutcome {
            ok: true,
            actor_ids: spawned_ids,
            error: None,
        })
    }

    /// Rebuild the engine from the (new) canonical input and re-advance to the
    /// current tick through the recorded action timeline. Deterministic engine
    /// ⇒ pre-existing actors reproduce their exact state; frames are NOT
    /// re-hashed. Spawn/despawn events for actors touched by this rebuild that
    /// fire exactly at the boundary are kept for the next advance's report.
    fn rebuild(
        &mut self,
        input: &SimScenarioInput,
        touched: &[String],
        boundary_t_s: f64,
    ) -> Result<Simulation> {
        let mut sim = Simulation::new(input.clone(), self.run_options.clone())?;
        Self::consume_warmup(&mut sim)?;
        replay_timeline(&mut sim, &self.timeline, self.tick_count, &mut self.actions)?;
        let mut replayed = Vec::new();
        sim.drain_events_into(&mut replayed);
        for event in replayed {
            let keep = match &event {
                SimEvent::Spawn { t, actor_id } | SimEvent::Despawn { t, actor_id, .. } => {
                    *t >= boundary_t_s - EPS_S && touched.contains(actor_id)
                }
                _ => false,
            };
            if keep {
                self.pending_events.push(event);
            }
        }
        Ok(sim)
    }

    /// Ground snap + defaults for one spawn request, via the lane graph:
    /// nearest drivable lane, its legal traversal direction, and the lane
    /// tangent as the default heading. Non-road kinds (and `snap_to_lane:
    /// false`) keep the authored pose and hold position on a zero-length
    /// polyline route unless an explicit route is given.
    fn resolve_spawn_placement(
        &self,
        req: &SpawnRequest,
    ) -> std::result::Result<ResolvedPlacement, String> {
        let snap = req.snap_to_lane.unwrap_or_else(|| req.kind.is_road_actor());
        if !snap {
            let pose = Pose {
                x: req.pose.x,
                z: req.pose.z,
                heading_rad: req.pose.heading_rad.unwrap_or(0.0),
            };
            let route = req.route.clone().unwrap_or(RouteSpec::Polyline {
                points: vec![ScenePoint {
                    x: pose.x,
                    z: pose.z,
                }],
            });
            return Ok(ResolvedPlacement {
                pose,
                lane_ref: None,
                route,
            });
        }
        let local = local_from_scene(SceneXZ {
            x: req.pose.x,
            z: req.pose.z,
        });
        let nearest = self
            .graph
            .nearest_lane(
                local,
                NearestLaneQuery {
                    max_dist_m: SNAP_MAX_DIST_M,
                    ..NearestLaneQuery::default()
                },
            )
            .ok_or_else(|| {
                format!(
                    "no drivable lane within {SNAP_MAX_DIST_M} m of ({}, {})",
                    req.pose.x, req.pose.z
                )
            })?;
        let reversed = self.graph.nominal_reversed(nearest.lane).unwrap_or(false);
        let length_m = self.graph.length_of(nearest.lane);
        let directed_s = if reversed {
            length_m - nearest.s
        } else {
            nearest.s
        };
        let sample = self.graph.sample_directed(
            DirectedLane {
                lane: nearest.lane,
                reversed,
            },
            directed_s,
        );
        let scene = to_scene_xz(sample.point);
        let rsl = self.graph.rsl(nearest.lane).to_owned();
        let pose = Pose {
            x: scene.x,
            z: scene.z,
            heading_rad: req
                .pose
                .heading_rad
                .unwrap_or(scene_heading(sample.heading_rad)),
        };
        let route = req.route.clone().unwrap_or(RouteSpec::Follow {
            start_rsl: rsl.clone(),
            turns: Vec::new(),
            max_length_m: 2000.0,
        });
        Ok(ResolvedPlacement {
            pose,
            lane_ref: Some(LaneRef {
                rsl,
                s: nearest.s,
                t_frac: 0.0,
            }),
            route,
        })
    }

    /* ---------------------------------------------------- checkpointing */

    pub fn checkpoint(&self) -> Result<WorldCheckpoint> {
        Ok(WorldCheckpoint {
            base_input_hash: self.base_input_hash.clone(),
            input: serde_json::to_value(&self.input)
                .map_err(|error| SessionError::Checkpoint(error.to_string()))?,
            mode: self.mode,
            horizon_seconds: self.horizon_seconds,
            simulation: self.sim.checkpoint()?,
            tick_count: self.tick_count,
            actor_counter: self.actor_counter,
            exist_counter: self.exist_counter,
            timeline: self.timeline.clone(),
            pending_events: self.pending_events.clone(),
            entries: self.entries.clone(),
            digest: self.digest_hex.clone(),
        })
    }

    /// Resume a world from a checkpoint. `run_options` supplies the graph and
    /// static resources (digest-verified by the engine); truth subscribers are
    /// not carried across processes.
    pub fn restore(checkpoint: &WorldCheckpoint, run_options: RunOptions) -> Result<Self> {
        let mut run_options = run_options;
        run_options.guards = GuardMode::Skip;
        run_options.mode = match checkpoint.mode {
            WorldMode::Clip => SessionMode::Clip,
            WorldMode::Live => SessionMode::Live,
        };
        run_options.capture_trace = false;
        let sim = Simulation::restore(&checkpoint.simulation, run_options.clone())?;
        let snapshot = sim.peek();
        let input = simforge_core::types::parse_scenario_input_value(&checkpoint.input)
            .map_err(|error| SessionError::Checkpoint(error.to_string()))?;
        let dt = input.dt;
        let mut session = Self {
            graph: run_options.graph.clone(),
            run_options,
            horizon_seconds: checkpoint.horizon_seconds,
            mode: checkpoint.mode,
            input,
            base_input_hash: checkpoint.base_input_hash.clone(),
            sim,
            tick_count: checkpoint.tick_count,
            actor_counter: checkpoint.actor_counter,
            exist_counter: checkpoint.exist_counter,
            timeline: checkpoint.timeline.clone(),
            pending_events: checkpoint.pending_events.clone(),
            entries: checkpoint.entries.clone(),
            digest_hex: checkpoint.digest.clone(),
            truth: WorldTruthPublisher::new(dt),
            catalog: BTreeMap::new(),
            ids: Vec::new(),
            snapshot,
            actions: Vec::new(),
            digest_buf: String::new(),
        };
        session.refresh_catalog();
        Ok(session)
    }
}

fn mode_str(mode: WorldMode) -> &'static str {
    match mode {
        WorldMode::Clip => "clip",
        WorldMode::Live => "live",
    }
}

fn obb_of(a: &ActorSnapshot, dims: &Dims) -> Obb {
    Obb {
        center: Vec2 { x: a.x, y: a.y },
        length_m: dims.l,
        width_m: dims.w,
        heading_rad: a.heading_rad,
    }
}

fn exist_interaction(counter: u32, actor_id: &str, t: f64, state: ExistState) -> Interaction {
    Interaction {
        id: format!("ws:exist:{}", pad(counter, 6)),
        actor_id: actor_id.to_owned(),
        trigger: Trigger::At { t },
        window: None,
        until: None,
        verb: Verb::Exist {
            target: ExistTarget { state },
        },
    }
}

/// Latest epoch per actor at or before `now` → fixed action set for one
/// advance segment. Actors whose latest epoch released the override are
/// omitted. `out` is reused.
fn actions_at(timeline: &[ActionEpoch], now: f64, sim: &Simulation, out: &mut Vec<ActorAction>) {
    out.clear();
    // Later epochs win: walk backwards and take the first hit per actor.
    let mut seen: Vec<&str> = Vec::new();
    for epoch in timeline.iter().rev() {
        if epoch.from_t_s > now + EPS_S || seen.contains(&epoch.actor_id.as_str()) {
            continue;
        }
        seen.push(&epoch.actor_id);
        if let (Some(action), Some(actor)) = (epoch.action, sim.actor_index(&epoch.actor_id)) {
            out.push(ActorAction { actor, action });
        }
    }
    // Engine order independence: sort by actor handle.
    out.sort_by_key(|a| a.actor);
}

/// Re-advance a rebuilt (warm-up consumed, t = 0) simulation through
/// `tick_count` ticks, switching the fixed action set at every epoch boundary
/// so the hold semantics match the original run exactly.
fn replay_timeline(
    sim: &mut Simulation,
    timeline: &[ActionEpoch],
    tick_count: usize,
    actions: &mut Vec<ActorAction>,
) -> Result<()> {
    let dt = sim.dt_s();
    let mut done = 0usize;
    let mut boundaries: Vec<usize> = timeline
        .iter()
        .map(|e| ((e.from_t_s / dt) + 0.5).floor() as usize)
        .filter(|&t| t > 0 && t < tick_count)
        .collect();
    boundaries.sort_unstable();
    boundaries.dedup();
    for boundary in boundaries.into_iter().chain(std::iter::once(tick_count)) {
        let ticks = boundary - done;
        if ticks == 0 {
            continue;
        }
        actions_at(timeline, sim.t_s(), sim, actions);
        sim.advance(ticks, actions)?;
        done = boundary;
    }
    Ok(())
}

/// `digest = sha256(digest + canonical_json([tick, t, rows]))` with rows
/// `[id, x, y, heading, speed, present, s]` in id order. Written directly with
/// ECMAScript number formatting so it matches the canonical-JSON reference
/// byte-for-byte without building a `Value` per tick.
fn chain_digest(digest: &mut String, buf: &mut String, ids: &[String], obs: &TickObservation<'_>) {
    buf.clear();
    buf.push_str(digest);
    buf.push('[');
    buf.push_str(&js_number_to_string(obs.tick_index as f64));
    buf.push(',');
    buf.push_str(&js_number_to_string(obs.t_s));
    buf.push_str(",[");
    for (i, a) in obs.actors.iter().enumerate() {
        if i > 0 {
            buf.push(',');
        }
        buf.push('[');
        buf.push_str(&serde_json::to_string(&ids[a.index.index()]).expect("string serialises"));
        for v in [
            a.x,
            a.y,
            a.heading_rad,
            a.speed_mps,
            if a.present { 1.0 } else { 0.0 },
            a.s,
        ] {
            buf.push(',');
            buf.push_str(&js_number_to_string(v));
        }
        buf.push(']');
    }
    buf.push_str("]]");
    *digest = sha256(buf);
}

/* ----------------------------------------------------------------- replay */

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayResult {
    pub digest: String,
    /// True when every log entry reproduced its recorded outcome.
    pub outcomes_match: bool,
    /// First divergent entry index, when any.
    pub diverged_at: Option<usize>,
}

/// Replay a session log against the same base input + graph. Determinism
/// contract: the returned digest equals `log.digest` and every command
/// reproduces its recorded outcome (including rejections).
pub fn replay_world_session_log(
    log: &WorldSessionLog,
    input: SimScenarioInput,
    run_options: RunOptions,
) -> Result<ReplayResult> {
    if log.version != WORLD_SESSION_LOG_VERSION {
        return Err(SessionError::World(format!(
            "unsupported world-session log version {}",
            log.version
        )));
    }
    let mut world = WorldSession::new(
        input,
        WorldSessionOptions {
            run_options,
            horizon_seconds: Some(log.horizon_seconds),
            mode: log.mode,
        },
    )?;
    if world.base_input_hash != log.base_input_hash {
        return Err(SessionError::World(format!(
            "base input mismatch: log built from {}, replay input is {}",
            log.base_input_hash, world.base_input_hash
        )));
    }
    let mut diverged_at = None;
    for (i, entry) in log.entries.iter().enumerate() {
        match entry {
            WorldLogEntry::Advance { ticks } => {
                world.advance(*ticks)?;
            }
            WorldLogEntry::Command {
                client_id,
                seq,
                command,
                ok,
                actor_ids,
                ..
            } => {
                let outcome = world.apply_command(client_id, *seq, command)?;
                if diverged_at.is_none() && (outcome.ok != *ok || outcome.actor_ids != *actor_ids) {
                    diverged_at = Some(i);
                }
            }
        }
    }
    Ok(ReplayResult {
        digest: world.digest_hex,
        outcomes_match: diverged_at.is_none(),
        diverged_at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn live_spawn_checkpoint_retains_catalog_and_replay() {
        let topology = simforge_core::map::TopologyIndex::from_json_slice(
            br#"{"mapName":"checkpoint-world","lanes":{},"gates":[],"junctions":{}}"#,
        )
        .unwrap();
        let graph = Arc::new(LaneGraph::new(topology));
        let input = simforge_core::types::parse_scenario_input(
            r#"{"mapId":"checkpoint-world","actors":[],"warmupSeconds":0,"clipSeconds":2}"#,
        )
        .unwrap();
        let mut world = WorldSession::new(
            input.clone(),
            WorldSessionOptions {
                run_options: RunOptions::new(graph.clone()),
                horizon_seconds: Some(2.0),
                mode: WorldMode::Live,
            },
        )
        .unwrap();
        let spawn = |id: Option<&str>, x| WorldCommand::Spawn {
            spawn: SpawnRequest {
                id: id.map(str::to_owned),
                kind: ActorKind::StaticObject,
                pose: SpawnPose {
                    x,
                    z: 0.0,
                    heading_rad: Some(0.0),
                },
                speed_mps: None,
                dims: None,
                route: None,
                cruise_speed_mps: None,
                snap_to_lane: Some(false),
                is_static: Some(true),
                tags: Vec::new(),
            },
        };
        assert!(
            world
                .apply_command("test", 0, &spawn(Some("z-prop"), 0.0))
                .unwrap()
                .ok
        );
        assert!(
            world
                .apply_command("test", 1, &spawn(Some("a-prop"), 10.0))
                .unwrap()
                .ok
        );
        world.advance(3).unwrap();
        let bytes = simforge_core::checkpoint::encode(&world.checkpoint().unwrap()).unwrap();
        let checkpoint = simforge_core::checkpoint::decode(&bytes).unwrap();
        let mut restored =
            WorldSession::restore(&checkpoint, RunOptions::new(graph.clone())).unwrap();
        for (sequence, command) in [
            WorldCommand::Despawn {
                actor_id: "z-prop".into(),
            },
            spawn(None, 20.0),
        ]
        .iter()
        .enumerate()
        {
            let expected = world
                .apply_command("test", sequence as u64 + 2, command)
                .unwrap();
            assert!(expected.ok);
            assert_eq!(
                restored
                    .apply_command("test", sequence as u64 + 2, command)
                    .unwrap(),
                expected
            );
        }
        world.advance(5).unwrap();
        restored.advance(5).unwrap();
        assert_eq!(
            serde_json::to_value(restored.snapshot()).unwrap(),
            serde_json::to_value(world.snapshot()).unwrap()
        );
        assert_eq!(restored.digest(), world.digest());
        let replay =
            replay_world_session_log(&restored.export_log(), input, RunOptions::new(graph))
                .unwrap();
        assert!(replay.outcomes_match);
        assert_eq!(replay.diverged_at, None);
        assert_eq!(replay.digest, restored.digest());
    }
}
