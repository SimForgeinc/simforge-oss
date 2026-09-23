//! Closed-loop tick ownership, policy barrier, evidence and completion.

use std::time::Instant;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use simforge_core::engine::{ActionOverride, RunOptions};
use simforge_core::hash::{canonical_json, canonical_json_of, sha256};
use simforge_core::physics::{MotionDirection, VehicleControl};
use simforge_core::rng::Seed;
use simforge_core::trace::events::SimEvent;
use simforge_core::types::SimScenarioInput;
use super::{BevConfig, EpisodeConfig, GoalSpec, ObservationConfig, RewardConfig};
use crate::env::EnvSession;
use crate::error::{Result, SessionError};
use crate::observation::{BevRaster, ObservedSignal, PerceivedObject, STATE_VECTOR_SIZE};
use crate::policy::{ExecutorFrame, PolicyAction, PolicyExecutor, PolicyExecutorConfig, TrajectoryExecution, TrajectoryPoint};
use crate::reward::RewardTerms;
use super::cameras::{Cameras, FrameRef};
use super::camera_types::{CameraBackend, CameraEnhance, CameraObservation, CameraPass, ResidentCameraRig};
use simforge_core::math::Vec2;

pub const EPISODE_TRACE_SCHEMA: &str = "simforge.episode-trace/v2";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EpisodeFallback {
    ZeroControl,
    /// Repeat the last applied action, retaining a trajectory's original anchor.
    /// Before the first action this uses the authored controller.
    HoldLast,
    Scripted,
}

#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum EpisodeMode {
    #[default]
    OfflineSimtime,
    Realtime {
        #[serde(rename = "deadlineMs")]
        deadline_ms: f64,
        fallback: EpisodeFallback,
    },
}


#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum ObservationChannel {
    State,
    Objects,
    Visible,
    Signals,
    /// Square cells, 80% of rows ahead of ego, 20% behind.
    Bev {
        h: u32,
        w: u32,
        #[serde(default = "default_cell_size", rename = "resolutionM")]
        resolution_m: f64,
    },
    Cameras {
        rig: ResidentCameraRig, passes: Vec<CameraPass>, backend: CameraBackend,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        enhance: Option<CameraEnhance>,
    },
}

fn default_cell_size() -> f64 { 0.25 }

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct EpisodeObservationConfig {
    pub channels: Vec<ObservationChannel>,
    pub object_list_range_m: f64,
}

impl Default for EpisodeObservationConfig {
    fn default() -> Self {
        Self { channels: vec![ObservationChannel::State], object_list_range_m: 60.0 }
    }
}

/// Resolved replay-context validity contract. Bundle loading/digest verification
/// is an asset concern; admission and per-decision enforcement live here.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EpisodeReplayContext {
    pub scene_id: String,
    pub digest: String,
    pub qualified: bool,
    pub stock_replay_passed: Option<bool>,
    pub lateral_m: f64,
    pub longitudinal_s: f64,
    pub heading_rad: f64,
    /// [simulation seconds, x, y, heading radians], strictly increasing times.
    pub recorded_path: Vec<[f64; 4]>,
    /// G5 stock replay measures an unqualified envelope without enforcing it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub measure_only: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct EpisodeOptions {
    pub seed: u64,
    pub decision_hz: u32,
    pub mode: EpisodeMode,
    pub warmup_decisions: u32,
    /// Optional precomputed reference-policy schedule, executed inside reset.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warmup_actions: Vec<EpisodeAction>,
    #[serde(skip_serializing_if = "is_scripted_warmup")]
    pub warmup_policy: String,
    #[serde(skip_serializing_if = "is_pure_pursuit")]
    pub execution: TrajectoryExecution,
    /// Policy decisions only: warm-up never consumes this budget.
    pub max_decisions: Option<u32>,
    pub observation: EpisodeObservationConfig,
    pub replay_context: Option<EpisodeReplayContext>,
    pub reward: RewardConfig,
    pub goal: Option<GoalSpec>,
}

impl Default for EpisodeOptions {
    fn default() -> Self {
        Self {
            seed: 0, decision_hz: 10, mode: EpisodeMode::OfflineSimtime,
            warmup_decisions: 0, max_decisions: None,
            warmup_actions: Vec::new(), warmup_policy: "scripted".into(),
            execution: TrajectoryExecution::PurePursuit,
            observation: EpisodeObservationConfig::default(),
            replay_context: None, reward: RewardConfig::default(), goal: EpisodeConfig::default().goal,
        }
    }
}

fn is_scripted_warmup(policy: &str) -> bool { policy == "scripted" }
fn is_pure_pursuit(execution: &TrajectoryExecution) -> bool { *execution == TrajectoryExecution::PurePursuit }

/// Topology/map is resolved once by the host's existing asset loader. All world
/// advancement after construction belongs exclusively to `Episode`.
#[derive(Clone)]
pub struct EpisodeSpec {
    pub scenario: SimScenarioInput,
    pub topology: RunOptions,
    pub options: EpisodeOptions,
}

/// Compact policy-step actions. The setpoint arm extends v1 without changing its
/// control or trajectory wire. Negative speed selects reverse motion.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "k", deny_unknown_fields)]
pub enum EpisodeAction {
    #[serde(rename = "c")]
    Control { c: [f64; 3] },
    #[serde(rename = "t")]
    Trajectory { p: Vec<[f64; 5]> },
    #[serde(rename = "s")]
    Setpoint {
        #[serde(rename = "speedMps", default, skip_serializing_if = "Option::is_none")]
        speed_mps: Option<f64>,
        #[serde(rename = "accelerationMps2", default, skip_serializing_if = "Option::is_none")]
        acceleration_mps2: Option<f64>,
        #[serde(rename = "previewPoint", default, skip_serializing_if = "Option::is_none")]
        preview_point: Option<Vec2>,
        #[serde(rename = "previewHeadingRad", default, skip_serializing_if = "Option::is_none")]
        preview_heading_rad: Option<f64>,
        #[serde(rename = "motionDirection", default, skip_serializing_if = "Option::is_none")]
        motion_direction: Option<MotionDirection>,
    },
}

impl EpisodeAction {
    pub(crate) fn validate(&self) -> Result<()> {
        let valid = match self {
            Self::Control { c } => c.iter().all(|v| v.is_finite())
                && (0.0..=1.0).contains(&c[0]) && (0.0..=1.0).contains(&c[1])
                && (-1.0..=1.0).contains(&c[2]),
            Self::Setpoint { speed_mps, acceleration_mps2, preview_point, preview_heading_rad, motion_direction } =>
                speed_mps.iter().chain(acceleration_mps2.iter()).chain(preview_heading_rad.iter()).all(|v| v.is_finite())
                && preview_point.is_none_or(|p| p.x.is_finite() && p.y.is_finite())
                && (speed_mps.is_some() || acceleration_mps2.is_some() || preview_point.is_some()
                    || preview_heading_rad.is_some() || motion_direction.is_some()),
            Self::Trajectory { p } => p.len() >= 2
                && p.iter().all(|point| point.iter().all(|v| v.is_finite()) && point[4] > 0.0)
                && p.windows(2).all(|pair| pair[1][4] > pair[0][4]),
        };
        if valid { Ok(()) } else { Err(SessionError::Policy("invalid episode action".into())) }
    }
}

/// Borrowed, explicitly selected policy surface. Unrequested channels are absent,
/// not ground-truth substitutes. `snapshot()` is a separate adapter API.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpisodeObservation<'a> {
    pub t_s: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state_vector: Option<&'a [f64; STATE_VECTOR_SIZE]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub objects: Option<&'a [PerceivedObject]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bev: Option<&'a BevRaster>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signals: Option<&'a [ObservedSignal]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cameras: Option<&'a [CameraObservation]>,
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct EpisodeDeadline {
    pub lim: Option<f64>,
    pub el: Option<f64>,
    pub miss: u8,
    pub ap: &'static str,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvelopeMeasurement {
    pub inside: bool,
    pub breached: Vec<&'static str>,
    pub lateral_m: f64,
    pub longitudinal_s: f64,
    pub heading_rad: f64,
    #[serde(rename = "closestTS")]
    pub closest_t_s: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpisodeStep<'a> {
    pub obs: EpisodeObservation<'a>,
    pub reward: f64,
    pub reward_terms: &'a RewardTerms,
    pub terminated: bool,
    pub truncated: bool,
    pub term_reason: Option<&'static str>,
    pub events: &'a [SimEvent],
    pub dl: EpisodeDeadline,
    pub ex: Option<ExecutorFrame>,
    /// Actual final-substep actuator input; null for non-physical actors.
    pub applied_control: Option<VehicleControl>,
    pub envelope: Option<&'a EnvelopeMeasurement>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpisodeTiming {
    pub wall_ms: f64,
    pub simulation_s: f64,
    pub policy_simulation_s: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultCore {
    pub schema: &'static str,
    pub status: &'static str,
    pub truncation: Option<&'static str>,
    pub term_reason: Option<&'static str>,
    pub mode: &'static str,
    pub timing: EpisodeTiming,
    pub decisions: u32,
    pub warmup_decisions: u32,
    pub deadline_misses: u32,
    pub episode_digest: String,
    /// The adapter must supply model-health evidence before promotion.
    pub model_health: Option<Value>,
}

/// Single tick owner. Offline calls never use a clock to select dynamics;
/// realtime measures observation delivery to `step`, including host inference.
pub struct Episode {
    env: EnvSession,
    options: EpisodeOptions,
    executor: PolicyExecutor,
    points: Vec<TrajectoryPoint>,
    last_applied: Option<EpisodeAction>,
    include_objects: bool,
    decisions: u32,
    warmup_done: u32,
    deadline_misses: u32,
    started: Option<Instant>,
    delivered: Option<Instant>,
    policy_start_s: f64,
    deadline: EpisodeDeadline,
    executor_frame: Option<ExecutorFrame>,
    envelope: Option<EnvelopeMeasurement>,
    term_reason: Option<&'static str>,
    trace: String,
    digest: String,
    finished: Option<ResultCore>,
    cameras: Option<Cameras>,
    render_ms: f64,
}

impl Episode {
    pub fn new(spec: EpisodeSpec) -> Result<Self> {
        let options = spec.options;
        if let EpisodeMode::Realtime { deadline_ms, .. } = options.mode {
            if !deadline_ms.is_finite() || deadline_ms <= 0.0 {
                return Err(SessionError::Config("realtime requires a positive finite deadlineMs".into()));
            }
        }
        if options.max_decisions == Some(0) {
            return Err(SessionError::Config("maxDecisions must be positive".into()));
        }
        if !options.warmup_actions.is_empty() && options.warmup_actions.len() != options.warmup_decisions as usize {
            return Err(SessionError::Config("warmupActions must match warmupDecisions".into()));
        }
        for action in &options.warmup_actions { action.validate()?; }
        if let Some(context) = &options.replay_context { context.validate()?; }
        let mut observation = ObservationConfig {
            state_vector: false, object_list_range_m: options.observation.object_list_range_m,
            bev: None, ..ObservationConfig::default()
        };
        let mut include_objects = false;
        let mut seen = [false; 6];
        for channel in &options.observation.channels {
            let slot = match channel {
                ObservationChannel::State => { observation.state_vector = true; 0 }
                ObservationChannel::Objects => { include_objects = true; 1 }
                ObservationChannel::Visible => {
                    observation.state_vector = true;
                    observation.visible = true;
                    observation.signals = true;
                    include_objects = true;
                    2
                }
                ObservationChannel::Signals => { observation.signals = true; 3 }
                ObservationChannel::Bev { h, w, resolution_m } => {
                    if *h == 0 || *w == 0 || *h > 4096 || *w > 4096
                        || !resolution_m.is_finite() || *resolution_m <= 0.0 {
                        return Err(SessionError::Config("BEV dimensions must be 1..4096 with positive finite resolutionM".into()));
                    }
                    observation.bev = Some(BevConfig {
                        resolution_m: *resolution_m,
                        forward_m: f64::from(*h) * resolution_m * 0.8,
                        backward_m: f64::from(*h) * resolution_m * 0.2,
                        half_width_m: f64::from(*w) * resolution_m * 0.5,
                        ..BevConfig::default()
                    });
                    4
                }
                ObservationChannel::Cameras { .. } => 5,
            };
            if seen[slot] { return Err(SessionError::Config("duplicate observation channel".into())); }
            seen[slot] = true;
        }
        if seen[2] && (seen[0] || seen[1] || seen[4]) {
            return Err(SessionError::Config("visible cannot be mixed with privileged state, objects or BEV channels".into()));
        }
        let config = EpisodeConfig {
            decision_hz: options.decision_hz,
            max_decisions: options.max_decisions.map(|max| max.checked_add(options.warmup_decisions)
                .ok_or_else(|| SessionError::Config("decision budget overflows u32".into()))).transpose()?,
            observation, reward: options.reward, goal: options.goal.clone(),
            ..EpisodeConfig::default()
        };
        // Numeric engine seeds are modulo 2^32; avoid losing u64 low bits via f64.
        let mut scenario = spec.scenario;
        scenario.seed = Seed::from(options.seed as u32);
        let cameras = options.observation.channels.iter().find_map(|channel| match channel {
            ObservationChannel::Cameras { rig, passes, backend, enhance } =>
                Some(Cameras::new(rig.clone(), passes.clone(), backend.clone(), enhance.clone(), &scenario, options.decision_hz)),
            _ => None,
        }).transpose()?;
        let env = EnvSession::new(scenario, spec.topology, config)?;
        let executor = PolicyExecutor::new(PolicyExecutorConfig { execution: options.execution, ..PolicyExecutorConfig::default() })?;
        Ok(Self {
            env, options, executor,
            points: Vec::new(), last_applied: None, include_objects,
            decisions: 0, warmup_done: 0, deadline_misses: 0,
            started: None, delivered: None, policy_start_s: 0.0,
            deadline: EpisodeDeadline { lim: None, el: None, miss: 0, ap: "policy" },
            executor_frame: None, envelope: None, term_reason: None,
            trace: String::new(), digest: String::new(), finished: None,
            cameras, render_ms: 0.0,
        })
    }

    pub fn reset(&mut self) -> Result<EpisodeObservation<'_>> {
        self.reset_with(|_, _| Ok(()), false)
    }

    /// The callback observes real initial/warmup frames at the kernel barrier.
    /// It must release claimed camera leases before the next advance.
    pub fn reset_with<F>(&mut self, mut callback: F, observe: bool) -> Result<EpisodeObservation<'_>>
    where F: FnMut(&Self, &'static str) -> Result<()> {
        if let Some(cameras) = &mut self.cameras { cameras.reset()?; }
        self.started = Some(Instant::now());
        self.delivered = None;
        self.finished = None;
        self.executor.reset();
        self.last_applied = None;
        self.decisions = 0;
        self.warmup_done = 0;
        self.deadline_misses = 0;
        self.deadline = EpisodeDeadline { lim: None, el: None, miss: 0, ap: "policy" };
        self.executor_frame = None;
        self.envelope = None;
        self.term_reason = None;
        self.trace.clear();
        self.digest.clear();
        self.env.reset(None)?;
        self.measure_envelope();
        self.render_cameras()?;
        self.append_record(json!({"reset": {
            "schema": EPISODE_TRACE_SCHEMA, "inputHash": self.env.base_input_hash(),
            "seed": self.options.seed, "mode": self.mode_name(),
            "deadline_ms": self.limit_ms(), "fallback": self.fallback_name(),
            "decision_hz": self.options.decision_hz,
            "warmup_steps": self.options.warmup_decisions,
            "options": self.options, "t": self.env.last_result().info.t_s,
            "observation": self.observation(), "env": self.envelope,
        }}))?;
        if observe { callback(self, "reset")?; }
        // Move, rather than clone, potentially large trajectory schedules while
        // permitting the shared executor to mutate its retained plan.
        let warmup_actions = std::mem::take(&mut self.options.warmup_actions);
        let warmup_result: Result<()> = (|| {
            for index in 0..self.options.warmup_decisions {
                if self.ended() { break; }
                if let Some(cameras) = &self.cameras { cameras.ensure_released()?; }
                let action = warmup_actions.get(index as usize);
                self.advance_action(action)?;
                self.warmup_done += 1;
                self.measure_envelope();
                self.render_cameras()?;
                self.record_step(action, true)?;
                if observe { callback(self, "warmup")?; }
            }
            Ok(())
        })();
        self.options.warmup_actions = warmup_actions;
        warmup_result?;
        // A reference warm-up action really drove the world: hold-last on the
        // first policy deadline must retain it and its trajectory anchor.
        self.last_applied = self.warmup_done.checked_sub(1)
            .and_then(|index| self.options.warmup_actions.get(index as usize)).cloned();
        if observe { if let Some(cameras) = &mut self.cameras { cameras.renew()?; } }
        self.policy_start_s = self.env.last_result().info.t_s;
        self.observation_delivered();
        Ok(self.observation())
    }

    /// Bindings call this after serialising so encoding is not inference time.
    pub fn observation_delivered(&mut self) { self.delivered = Some(Instant::now()); }

    pub fn step(&mut self, action: EpisodeAction) -> Result<EpisodeStep<'_>> {
        let delivered = self.delivered.ok_or(SessionError::NotReset)?;
        let elapsed = match self.options.mode {
            EpisodeMode::OfflineSimtime => None,
            EpisodeMode::Realtime { .. } => Some(delivered.elapsed().as_secs_f64() * 1000.0 + self.render_ms),
        };
        self.step_at_latency(action, elapsed)?;
        self.observation_delivered();
        Ok(self.last_step())
    }

    fn step_at_latency(&mut self, action: EpisodeAction, elapsed: Option<f64>) -> Result<()> {
        if self.started.is_none() { return Err(SessionError::NotReset); }
        if self.ended() || self.finished.is_some() { return Err(SessionError::Finished); }
        action.validate()?;
        if let Some(cameras) = &self.cameras { cameras.ensure_released()?; }
        let limit = self.limit_ms();
        let miss = matches!((elapsed, limit), (Some(el), Some(lim)) if el > lim);
        let (applied, source) = if miss {
            match self.options.mode {
                EpisodeMode::Realtime { fallback: EpisodeFallback::ZeroControl, .. } =>
                    (Some(EpisodeAction::Control { c: [0.0; 3] }), "zero-control"),
                EpisodeMode::Realtime { fallback: EpisodeFallback::Scripted, .. } => (None, "scripted"),
                _ => (self.last_applied.clone(), if self.last_applied.is_some() { "repeat-last" } else { "scripted" }),
            }
        } else { (Some(action.clone()), "policy") };
        self.advance_action(applied.as_ref())?;
        self.last_applied = applied;
        self.decisions += 1;
        self.deadline_misses += u32::from(miss);
        self.deadline = EpisodeDeadline { lim: limit, el: elapsed, miss: u8::from(miss), ap: source };
        self.measure_envelope();
        self.render_cameras()?;
        self.record_step(Some(&action), false)?;
        Ok(())
    }

    fn advance_action(&mut self, action: Option<&EpisodeAction>) -> Result<()> {
        let (override_action, executor_frame) = match action {
            None => (None, None),
            Some(EpisodeAction::Control { c }) => (Some(ActionOverride {
                control: Some(VehicleControl { throttle: c[0], brake: c[1], steer: c[2], handbrake: false }),
                ..ActionOverride::default()
            }), None),
            Some(EpisodeAction::Setpoint { speed_mps, acceleration_mps2, preview_point, preview_heading_rad, motion_direction }) => (Some(ActionOverride {
                target_speed_mps: speed_mps.map(f64::abs),
                target_acceleration_mps2: *acceleration_mps2,
                preview_point: *preview_point,
                preview_heading_rad: *preview_heading_rad,
                motion_direction: motion_direction.or_else(|| speed_mps.map(|v| if v < 0.0 { MotionDirection::Reverse } else { MotionDirection::Forward })),
                ..ActionOverride::default()
            }), None),
            Some(EpisodeAction::Trajectory { p }) => {
                self.points.clear();
                self.points.extend(p.iter().map(|p| TrajectoryPoint { x: p[0], y: p[1], heading: p[2], speed: p[3], t: p[4] }));
                let plan = PolicyAction::Trajectory { points: std::mem::take(&mut self.points) };
                let (pose, time) = self.env.ego_pose().ok_or(SessionError::NotReset)?;
                let command = self.executor.decide(&plan, None, None, &pose, time);
                let PolicyAction::Trajectory { points } = plan else { unreachable!() };
                self.points = points;
                let command = command?;
                (command.override_action, command.executor)
            }
        };
        self.env.step(override_action)?;
        self.executor_frame = executor_frame;
        Ok(())
    }

    fn observation(&self) -> EpisodeObservation<'_> {
        let obs = &self.env.last_result().observation;
        EpisodeObservation {
            t_s: obs.t_s, state_vector: obs.state_vector.as_ref(),
            objects: self.include_objects.then_some(obs.objects.as_slice()),
            bev: obs.bev.as_ref(), signals: obs.signals.as_deref(),
            cameras: self.cameras.as_ref().map(Cameras::observations),
        }
    }

    pub fn last_step(&self) -> EpisodeStep<'_> {
        let result = self.env.last_result();
        let applied_control = self.env.simulation()
            .and_then(|sim| sim.actor_index(self.env.ego()).and_then(|ego| sim.applied_control(ego)));
        EpisodeStep {
            obs: self.observation(), reward: result.reward, reward_terms: &result.info.reward_terms,
            terminated: result.terminated,
            truncated: result.truncated || self.term_reason == Some("envelope_exceeded"),
            term_reason: self.term_reason, events: &result.info.events,
            dl: self.deadline, ex: self.executor_frame, envelope: self.envelope.as_ref(),
            applied_control,
        }
    }

    pub fn ended(&self) -> bool {
        self.finished.is_some() || self.env.ended() || self.term_reason == Some("envelope_exceeded")
    }
    pub fn ego(&self) -> &str { self.env.ego() }
    pub fn trace_digest(&self) -> &str { &self.digest }
    pub fn trace_json(&self) -> &str { &self.trace }
    pub fn frame(&self, id: u32) -> Result<FrameRef> {
        self.cameras.as_ref().ok_or_else(|| SessionError::Camera("cameras channel not selected".into()))?.frame(id)
    }
    pub fn frames(&self) -> Result<Vec<FrameRef>> {
        self.cameras.as_ref().map(Cameras::frames).transpose().map(Option::unwrap_or_default)
    }
    pub fn scene_state_json(&self) -> Option<&str> { self.cameras.as_ref().map(Cameras::scene_json) }
    pub fn close(&mut self) {
        if let Some(cameras) = &mut self.cameras { cameras.close(); }
    }
    fn render_cameras(&mut self) -> Result<()> {
        if let Some(cameras) = &mut self.cameras {
            let start = Instant::now();
            cameras.render(&self.env)?;
            self.render_ms = start.elapsed().as_secs_f64() * 1000.0;
        }
        Ok(())
    }

    /// Adapter/ground-truth surface; never included implicitly in observations.
    pub fn snapshot(&self) -> Result<Value> {
        let sim = self.env.simulation().ok_or(SessionError::NotReset)?;
        let actors: Vec<Value> = self.env.actor_snapshots()?.iter().map(|actor| json!({
            "id": sim.actor_id(actor.index), "kind": sim.actor_kind(actor.index).as_str(),
            "dims": sim.actor_dims(actor.index), "state": actor,
        })).collect();
        Ok(json!({"tS": self.env.last_result().info.t_s, "done": self.ended(),
            "egoId": self.ego(), "actors": actors}))
    }

    fn mode_name(&self) -> &'static str {
        match self.options.mode { EpisodeMode::OfflineSimtime => "offline-simtime", _ => "realtime" }
    }
    fn limit_ms(&self) -> Option<f64> {
        match self.options.mode { EpisodeMode::Realtime { deadline_ms, .. } => Some(deadline_ms), _ => None }
    }
    fn fallback_name(&self) -> Option<&'static str> {
        match self.options.mode {
            EpisodeMode::OfflineSimtime => None,
            EpisodeMode::Realtime { fallback: EpisodeFallback::ZeroControl, .. } => Some("zero-control"),
            EpisodeMode::Realtime { fallback: EpisodeFallback::Scripted, .. } => Some("scripted"),
            _ => Some("repeat-last"),
        }
    }

    fn measure_envelope(&mut self) {
        self.term_reason = self.env.last_result().term_reason();
        if let (Some(context), Some((pose, t_s))) = (&self.options.replay_context, self.env.ego_pose()) {
            let measure = context.measure(t_s, pose.x, pose.y, pose.yaw_rad);
            if !measure.inside && !context.measure_only { self.term_reason = Some("envelope_exceeded"); }
            self.envelope = Some(measure);
        }
    }

    fn record_step(&mut self, action: Option<&EpisodeAction>, warmup: bool) -> Result<()> {
        let step = self.last_step();
        let obs = &self.env.last_result().observation;
        let objects = if self.include_objects {
            obs.objects.iter().map(|o| Ok(json!({
                "id": self.env.actor_id(o.actor)?, "rangeM": o.range_m,
                "bearingRad": o.bearing_rad, "rangeRateMps": o.range_rate_mps,
                "lineOfSight": o.line_of_sight,
            }))).collect::<Result<Vec<_>>>()?
        } else { Vec::new() };
        let terms = step.reward_terms;
        let mut row = json!({
            "step": self.decisions + self.warmup_done - 1,
            "phase": if warmup { "warmup" } else { "policy" },
            "pol": if warmup { format!("warmup:{}", self.options.warmup_policy) } else { "policy".into() },
            "t": obs.t_s, "a": action, "rw": step.reward,
            "term": u8::from(step.terminated), "trunc": u8::from(step.truncated),
            "term_reason": step.term_reason, "sv": obs.state_vector, "objs": objects,
            "terms": [terms.progress, terms.proximity, terms.comfort],
            "reward_terms": terms, "events": step.events,
            "dl": { "lim": if warmup { None } else { self.deadline.lim }, "el": null,
                "miss": if warmup { 0 } else { self.deadline.miss },
                "ap": if warmup { "scripted" } else { self.deadline.ap } },
            "miss": if warmup { 0 } else { self.deadline.miss },
            "applied": if warmup { "scripted" } else { self.deadline.ap },
            "ex": self.executor_frame, "env": self.envelope,
            "appliedControl": step.applied_control,
        });
        if let Some(bev) = &obs.bev { row["bev_digest"] = json!(sha256(&canonical_json_of(bev)?)); }
        if let Some(signals) = &obs.signals { row["sig"] = json!(signals); }
        if let Some(collision) = &self.env.last_result().info.collision { row["collision"] = json!(collision); }
        if let Some(cameras) = &self.cameras { row["cameras"] = cameras.evidence(); }
        self.append_record(row)?;
        Ok(())
    }

    fn append_record(&mut self, mut row: Value) -> Result<()> {
        if row.get("reset").is_some() {
            if let Some(cameras) = &self.cameras {
                // Transport addresses, offsets and lease ids are not scene identity.
                row["reset"]["observation"]["cameras"] = cameras.evidence();
                if let Some(channels) = row["reset"]["options"]["observation"]["channels"].as_array_mut() {
                    for channel in channels {
                        if channel["kind"] == "cameras" {
                            if let Some(enhance) = channel.get_mut("enhance").and_then(Value::as_object_mut) {
                                enhance.remove("socket");
                            }
                            if let Some(backend) = channel["backend"].as_object_mut() {
                                backend.remove("socket");
                                backend.remove("library");
                                backend.remove("shmSizeBytes");
                            }
                        }
                    }
                }
            }
        }
        let bytes = canonical_json(&row)?;
        let mut chain = Sha256::new();
        chain.update(self.digest.as_bytes());
        chain.update(bytes.as_bytes());
        self.digest = format!("{:x}", chain.finalize());
        row["digest"] = json!(self.digest);
        // Latency is evidence, not deterministic identity.
        if row.get("step").is_some() && self.deadline.el.is_some() {
            row["timing"] = json!({"infer_ms": self.deadline.el});
            row["dl"]["el"] = json!(self.deadline.el);
        }
        self.trace.push_str(&canonical_json(&row)?);
        self.trace.push('\n');
        Ok(())
    }

    /// Early completion is explicitly partial; repeated finish is idempotent.
    pub fn finish(&mut self) -> Result<&ResultCore> {
        let started = self.started.ok_or(SessionError::NotReset)?;
        if self.finished.is_none() {
            let warmup_terminated = self.ended() && self.decisions == 0 && self.warmup_done > 0;
            let partial = !self.ended() || self.term_reason == Some("envelope_exceeded")
                || warmup_terminated || self.warmup_done < self.options.warmup_decisions;
            let truncation = if self.term_reason == Some("envelope_exceeded") { self.term_reason }
                else if !self.ended() { Some("caller_finished") }
                else if warmup_terminated || self.warmup_done < self.options.warmup_decisions { Some("warmup_terminated") }
                else if self.env.last_result().truncated { Some("horizon") } else { None };
            let t_s = self.env.last_result().info.t_s;
            let result = ResultCore {
                schema: "simforge.episode-result-core/v1",
                status: if partial { "partial" } else { "succeeded" },
                truncation, term_reason: self.term_reason, mode: self.mode_name(),
                timing: EpisodeTiming { wall_ms: started.elapsed().as_secs_f64() * 1000.0,
                    simulation_s: t_s, policy_simulation_s: t_s - self.policy_start_s },
                decisions: self.decisions, warmup_decisions: self.warmup_done,
                deadline_misses: self.deadline_misses,
                episode_digest: self.digest.clone(), model_health: None,
            };
            self.trace.push_str(&canonical_json(&json!({"episode_digest": self.digest, "summary": result}))?);
            self.trace.push('\n');
            self.finished = Some(result);
        }
        Ok(self.finished.as_ref().expect("sealed"))
    }
}

impl EpisodeReplayContext {
    fn validate(&self) -> Result<()> {
        if !self.measure_only && (!self.qualified || self.stock_replay_passed == Some(false)) {
            return Err(SessionError::Config("replay_context_unqualified".into()));
        }
        if self.recorded_path.len() < 2
            || ![self.lateral_m, self.longitudinal_s, self.heading_rad].iter().all(|x| x.is_finite() && *x >= 0.0)
            || !self.recorded_path.iter().all(|p| p.iter().all(|x| x.is_finite()))
            || !self.recorded_path.windows(2).all(|p| p[1][0] > p[0][0]) {
            return Err(SessionError::Config("invalid replay-context envelope or recordedPath".into()));
        }
        Ok(())
    }

    fn measure(&self, t: f64, x: f64, y: f64, heading: f64) -> EnvelopeMeasurement {
        use simforge_core::math::{atan2, cos, hypot, sin};
        let first = self.recorded_path[0];
        let mut best = (f64::INFINITY, first[0], first[3]);
        for pair in self.recorded_path.windows(2) {
            let [t0, x0, y0, h0] = pair[0];
            let [t1, x1, y1, h1] = pair[1];
            let (dx, dy) = (x1 - x0, y1 - y0);
            let l2 = dx * dx + dy * dy;
            if l2 <= 1e-12 { continue; }
            let u = (((x - x0) * dx + (y - y0) * dy) / l2).clamp(0.0, 1.0);
            let lateral = hypot(x - x0 - u * dx, y - y0 - u * dy);
            if lateral < best.0 {
                best = (lateral, t0 + u * (t1 - t0), if l2 > 1e-6 { atan2(dy, dx) } else { h0 + u * (h1 - h0) });
            }
        }
        if !best.0.is_finite() { best.0 = hypot(x - first[1], y - first[2]); }
        let longitudinal_s = t - best.1;
        let heading_rad = atan2(sin(heading - best.2), cos(heading - best.2)).abs();
        let mut breached = Vec::new();
        if best.0 > self.lateral_m { breached.push("lateral"); }
        if longitudinal_s.abs() > self.longitudinal_s { breached.push("longitudinal"); }
        if heading_rad > self.heading_rad { breached.push("heading"); }
        if t > self.recorded_path.last().expect("validated")[0] + 1e-9 { breached.push("time-support"); }
        EnvelopeMeasurement { inside: breached.is_empty(), breached, lateral_m: best.0,
            longitudinal_s, heading_rad, closest_t_s: best.1 }
    }
}

#[cfg(test)]
#[path = "closed_loop_tests.rs"]
mod tests;

#[path = "batch.rs"]
mod batch;
pub use batch::{EpisodeBatch, EpisodeBatchCheckpoint};
