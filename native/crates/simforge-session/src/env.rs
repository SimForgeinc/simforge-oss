//! `EnvSession` — the Gymnasium-semantics environment over the fixed-step
//! engine.
//!
//! - `reset(seed)` rebuilds the simulation and consumes the warm-up prologue so
//!   no policy-visible tick is ever negative.
//! - `step(action)` holds the action for `ENGINE_HZ / decision_hz` engine ticks
//!   (zero-order hold through the engine's fixed action set), then returns
//!   observation, reward, `terminated` (collision or goal), `truncated`
//!   (horizon or clip end), and an info bag with the drained engine events,
//!   running metric minima, and this decision's causal ground-truth frame.
//!
//! Determinism: the session never reads wall time; seeds flow into the
//! engine's own RNG; actor iteration is in canonical id order everywhere.
//! Every per-decision buffer is owned by the session and reused.

use serde::{Deserialize, Serialize};
use simforge_core::engine::visibility::build_occluders;
use simforge_core::engine::{
    ActionOverride, ActorAction, ActorIndex, ActorSnapshot, PairMinima, RunOptions, Simulation,
    SimulationCheckpoint, SimulationSnapshot,
};
use simforge_core::hash::cmp_utf16;
use simforge_core::rng::Seed;
use simforge_core::trace::events::SimEvent;
use simforge_core::types::{ActorKind, Dims, SimScenarioInput};

use crate::causal::{CausalChannel, CausalChannelCollector, CausalFrame};
use crate::episode::{EpisodeConfig, ResolvedEpisode};
use crate::error::{Result, SessionError};
use crate::observation::{Observation, ObservationBuilders, ObservationContext};
use crate::reward::{assemble_reward, RewardContext, RewardTerms};
use crate::trajectory::TrackedPose;

const EPS_S: f64 = 1e-9;

/// Per-decision facts beside the observation.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepInfo {
    pub t_s: f64,
    /// Engine events recorded during this decision interval, in record order.
    pub events: Vec<SimEvent>,
    /// Running episode minima for every monitored pair.
    pub minima: Vec<PairMinima>,
    /// This decision's causal frame; all frames accumulate into the channel.
    pub causal: CausalFrame,
    pub reward_terms: RewardTerms,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepResult {
    pub observation: Observation,
    pub reward: f64,
    pub terminated: bool,
    pub truncated: bool,
    pub info: StepInfo,
}

/// Complete continuation state of one episode: the engine checkpoint plus
/// every session-side accumulator. Restoring reproduces the exact `StepResult`
/// the checkpointed decision returned and lets stepping continue bit-identically.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvCheckpoint {
    pub base_input_hash: String,
    pub episode: ResolvedEpisode,
    pub ego_id: String,
    pub simulation: SimulationCheckpoint,
    pub causal: CausalChannelCollector,
    pub range_memory: Vec<f64>,
    pub decision_count: u32,
    pub prev_ego_s: Option<f64>,
    pub ended: bool,
    pub last_result: StepResult,
}

/// The metric-subject actor all actions apply to: `metricSubject`, else the
/// lowest-id actor of kind `vehicle`.
pub fn resolve_ego_id(input: &SimScenarioInput) -> Result<String> {
    if let Some(subject) = &input.metric_subject {
        return Ok(subject.clone());
    }
    input
        .actors
        .iter()
        .filter(|a| a.kind == ActorKind::Vehicle)
        .map(|a| a.id.as_str())
        .min_by(|a, b| cmp_utf16(a, b))
        .map(str::to_owned)
        .ok_or_else(|| {
            SessionError::Config("scenario has no vehicle actor to act as the ego".into())
        })
}

pub struct EnvSession {
    base_input: SimScenarioInput,
    base_input_hash: String,
    run_options: RunOptions,
    config: EpisodeConfig,
    episode: ResolvedEpisode,
    ego_id: String,

    sim: Option<Simulation>,
    ctx: Option<ObservationContext>,
    builders: ObservationBuilders,
    causal: Option<CausalChannelCollector>,
    snapshot: SimulationSnapshot,
    actions: [ActorAction; 1],
    result: StepResult,
    decision_count: u32,
    prev_ego_s: Option<f64>,
    ended: bool,
}

impl EnvSession {
    /// `run_options.graph` must be the graph `input` was authored against.
    /// The session owns the action channel; `run_options` carries guards,
    /// static colliders, arrival resolution and trace capture.
    pub fn new(
        input: SimScenarioInput,
        run_options: RunOptions,
        config: EpisodeConfig,
    ) -> Result<Self> {
        let episode = ResolvedEpisode::resolve(&config, input.clip_seconds, input.dt)?;
        let mut base_input = input;
        if base_input.clip_seconds != episode.clip_seconds {
            base_input.clip_seconds = episode.clip_seconds;
        }
        let base_input = base_input.normalized();
        let base_input_hash = base_input.content_hash()?;
        let ego_id = resolve_ego_id(&base_input)?;
        let result = StepResult {
            observation: Observation::new(&config.observation),
            reward: 0.0,
            terminated: false,
            truncated: false,
            info: StepInfo::default(),
        };
        Ok(Self {
            base_input,
            base_input_hash,
            run_options,
            config,
            episode,
            ego_id,
            sim: None,
            ctx: None,
            builders: ObservationBuilders::default(),
            causal: None,
            snapshot: SimulationSnapshot {
                t_s: 0.0,
                done: false,
                actors: Vec::new(),
                minima: Vec::new(),
            },
            actions: [ActorAction {
                actor: ActorIndex(0),
                action: ActionOverride::default(),
            }],
            result,
            decision_count: 0,
            prev_ego_s: None,
            ended: false,
        })
    }

    /// The metric-subject actor all actions apply to.
    #[inline]
    pub fn ego(&self) -> &str {
        &self.ego_id
    }

    #[inline]
    pub fn episode(&self) -> &ResolvedEpisode {
        &self.episode
    }

    #[inline]
    pub fn config(&self) -> &EpisodeConfig {
        &self.config
    }

    /// Content hash of the normalized base input (clip override applied).
    #[inline]
    pub fn base_input_hash(&self) -> &str {
        &self.base_input_hash
    }

    #[inline]
    pub fn base_input(&self) -> &SimScenarioInput {
        &self.base_input
    }

    /// The live engine; `None` before `reset()`.
    #[inline]
    pub fn simulation(&self) -> Option<&Simulation> {
        self.sim.as_ref()
    }

    /// The most recent `reset`/`step` result.
    #[inline]
    pub fn last_result(&self) -> &StepResult {
        &self.result
    }

    #[inline]
    pub fn ended(&self) -> bool {
        self.ended
    }

    #[inline]
    pub fn decision_count(&self) -> u32 {
        self.decision_count
    }

    /// Canonical id of an actor handle from the current episode.
    pub fn actor_id(&self, actor: ActorIndex) -> Result<&str> {
        Ok(self.require_sim()?.actor_id(actor))
    }

    /// Handles of every actor in canonical id order; empty before `reset()`.
    pub fn actor_order(&self) -> &[ActorIndex] {
        self.ctx.as_ref().map_or(&[], |c| c.sorted.as_slice())
    }

    fn require_sim(&self) -> Result<&Simulation> {
        self.sim.as_ref().ok_or(SessionError::NotReset)
    }

    /// Rebuild the episode. The optional seed replaces the input's authored
    /// seed; everything else about the scenario is preserved byte-for-byte.
    pub fn reset(&mut self, seed: Option<&Seed>) -> Result<&StepResult> {
        let mut input = self.base_input.clone();
        if let Some(seed) = seed {
            input.seed = seed.clone();
        }
        let input = input.normalized();
        self.ego_id = resolve_ego_id(&input)?;
        let sim = Simulation::new(input, self.run_options.clone())?;
        self.install(sim)?;
        self.causal = Some(CausalChannelCollector::new(
            &self.ego_id,
            self.episode.decision_hz,
            &self.sim.as_ref().expect("installed").input().interactions,
        ));
        self.decision_count = 0;
        self.prev_ego_s = None;
        self.ended = false;

        // The engine records state *at* t before stepping, so consuming exactly
        // warmupTicks leaves the snapshot at t=-dt; one more tick parks the
        // world exactly at t=0, the first policy-visible instant.
        if self.episode.warmup_excluded {
            let sim = self.sim.as_mut().expect("installed");
            let warmup_ticks = sim.input().warmup_ticks() as usize + 1;
            sim.advance(warmup_ticks, &[])?;
        }
        self.refresh_snapshot();
        let ctx = self.ctx.as_ref().expect("installed");
        let snap = &self.snapshot;
        self.builders.observe(
            ctx,
            &snap.actors,
            snap.t_s,
            0.0,
            &mut self.result.observation,
        )?;
        self.result.reward = 0.0;
        self.result.terminated = false;
        self.result.truncated = false;
        self.result.info.t_s = snap.t_s;
        self.result.info.events.clear();
        self.result.info.minima.clear();
        self.result.info.minima.extend_from_slice(&snap.minima);
        self.result.info.causal = CausalFrame {
            t_s: snap.t_s,
            ..CausalFrame::default()
        };
        self.result.info.reward_terms = RewardTerms::default();
        Ok(&self.result)
    }

    /// Bind a freshly built simulation: ego handle, canonical order, dims,
    /// occluders and sensor apertures. Shared by `reset` and `restore`.
    fn install(&mut self, sim: Simulation) -> Result<()> {
        let ego = sim
            .actor_index(&self.ego_id)
            .ok_or_else(|| SessionError::MissingEgo(self.ego_id.clone()))?;
        self.snapshot = sim.peek();
        let input = sim.input();
        let sorted: Vec<ActorIndex> = self.snapshot.actors.iter().map(|a| a.index).collect();
        let handles = sorted.iter().map(|i| i.index() + 1).max().unwrap_or(0);
        let mut slots = vec![usize::MAX; handles];
        for (row, idx) in sorted.iter().enumerate() {
            slots[idx.index()] = row;
        }
        let mut dims: Vec<Dims> = vec![
            Dims {
                l: 0.0,
                w: 0.0,
                h: 0.0
            };
            handles
        ];
        for actor in &input.actors {
            if let Some(idx) = sim.actor_index(&actor.id) {
                dims[idx.index()] = actor.dims;
            }
        }
        let sensor_apertures = input
            .actor(&self.ego_id)
            .map(|a| {
                a.sensors()
                    .iter()
                    .filter(|s| s.enabled)
                    .map(|s| (s.aperture.horizontal_fov_deg, s.aperture.far_m))
                    .collect()
            })
            .unwrap_or_default();
        let ctx = ObservationContext {
            graph: self.run_options.graph.clone(),
            ego,
            config: self.config.observation,
            sorted,
            slots,
            dims,
            static_occluders: build_occluders(&input.occluders),
            sensor_apertures,
        };
        self.actions[0].actor = ego;
        self.builders.reset(handles);
        self.ctx = Some(ctx);
        self.sim = Some(sim);
        Ok(())
    }

    #[inline]
    fn refresh_snapshot(&mut self) {
        self.sim
            .as_ref()
            .expect("installed")
            .peek_into(&mut self.snapshot);
    }

    /// Apply one policy decision. `None` = scripted: the authored choreography
    /// drives the ego for this interval. Errors after termination/truncation —
    /// Gymnasium semantics leave post-episode stepping undefined.
    pub fn step(&mut self, action: Option<ActionOverride>) -> Result<&StepResult> {
        if self.sim.is_none() || self.ctx.is_none() || self.causal.is_none() {
            return Err(SessionError::NotReset);
        }
        if self.ended {
            return Err(SessionError::Finished);
        }
        let decision_ticks = self.episode.decision_ticks;
        {
            let sim = self.sim.as_mut().expect("checked");
            // Actions never apply during warm-up (t < 0): advance those ticks
            // scripted, then hold the action over the remainder.
            let mut remaining = decision_ticks;
            let t = sim.t_s();
            if t < -EPS_S {
                let dt = sim.dt_s();
                let negative = ((-t) / dt).ceil() as usize;
                let scripted = negative.min(remaining);
                sim.advance(scripted, &[])?;
                remaining -= scripted;
            }
            if remaining > 0 {
                match action {
                    Some(a) => {
                        self.actions[0].action = a;
                        sim.advance(remaining, &self.actions)?;
                    }
                    None => {
                        sim.advance(remaining, &[])?;
                    }
                }
            }
            self.result.info.events.clear();
            sim.drain_events_into(&mut self.result.info.events);
        }
        self.refresh_snapshot();
        self.decision_count += 1;

        let ctx = self.ctx.as_ref().expect("checked");
        let snap = &self.snapshot;
        let dt_s = self.episode.dt_decision_s;
        self.builders.observe(
            ctx,
            &snap.actors,
            snap.t_s,
            dt_s,
            &mut self.result.observation,
        )?;

        let reward = assemble_reward(&RewardContext {
            config: &self.config.reward,
            ego: ctx.ego,
            ego_id: &self.ego_id,
            actors: &snap.actors,
            sorted: &ctx.sorted,
            slots: &ctx.slots,
            events: &self.result.info.events,
            goal: self.episode.goal.as_ref(),
            dt_s,
            prev_ego_s: self.prev_ego_s,
        });
        // Stored only after assembly: progress is measured against the previous decision.
        self.prev_ego_s = Some(ctx.actor(&snap.actors, ctx.ego).s);

        let sim = self.sim.as_ref().expect("checked");
        let causal = self.causal.as_mut().expect("checked");
        causal.observe(
            snap.t_s,
            |idx| sim.actor_id(idx),
            self.builders.last_los(),
            &self.result.info.events,
            &snap.minima,
        );
        self.result.info.causal = causal.last_frame().cloned().unwrap_or_default();

        let terminated = reward.collision || reward.goal;
        let clip_over = snap.t_s >= self.episode.clip_seconds - EPS_S;
        let horizon_over = self
            .episode
            .max_decisions
            .is_some_and(|max| self.decision_count >= max);
        let truncated = !terminated && (clip_over || horizon_over || snap.done);
        self.ended = terminated || truncated;

        self.result.reward = reward.total;
        self.result.terminated = terminated;
        self.result.truncated = truncated;
        self.result.info.t_s = snap.t_s;
        self.result.info.minima.clear();
        self.result.info.minima.extend_from_slice(&snap.minima);
        self.result.info.reward_terms = reward.terms;
        Ok(&self.result)
    }

    /// Planar ego pose + travel speed at the current engine snapshot — the
    /// observation instant the next `step()` action responds to, with its sim
    /// time. `None` before `reset()`.
    pub fn ego_pose(&self) -> Option<(TrackedPose, f64)> {
        let ctx = self.ctx.as_ref()?;
        self.sim.as_ref()?;
        let ego = ctx.actor(&self.snapshot.actors, ctx.ego);
        Some((
            TrackedPose {
                x: ego.x,
                y: ego.y,
                yaw_rad: ego.heading_rad,
                speed_mps: ego.speed_mps,
            },
            self.snapshot.t_s,
        ))
    }

    /// Every actor's state at the current observation instant, in sorted-id
    /// order (`ActorSnapshot::index` is the engine handle for id/kind/dims
    /// lookups on [`Self::simulation`]). The same snapshot `ego_pose` reads;
    /// no stepping, no recomputation. Errors before `reset()`.
    pub fn actor_snapshots(&self) -> Result<&[ActorSnapshot]> {
        self.require_sim()?;
        Ok(&self.snapshot.actors)
    }

    /// Absolute engine tick index of the current snapshot; `None` before `reset()`.
    pub fn tick_index(&self) -> Option<u64> {
        self.sim.as_ref().map(Simulation::tick_index)
    }

    /// Every causal frame recorded this episode.
    pub fn causal_channel(&self) -> Result<CausalChannel> {
        self.causal
            .as_ref()
            .map(CausalChannelCollector::channel)
            .ok_or(SessionError::NotReset)
    }

    /// Complete continuation state; errors before `reset()`.
    pub fn checkpoint(&self) -> Result<EnvCheckpoint> {
        let sim = self.require_sim()?;
        let causal = self.causal.as_ref().ok_or(SessionError::NotReset)?;
        Ok(EnvCheckpoint {
            base_input_hash: self.base_input_hash.clone(),
            episode: self.episode.clone(),
            ego_id: self.ego_id.clone(),
            simulation: sim.checkpoint()?,
            causal: causal.clone(),
            range_memory: self.builders.range_memory().to_vec(),
            decision_count: self.decision_count,
            prev_ego_s: self.prev_ego_s,
            ended: self.ended,
            last_result: self.result.clone(),
        })
    }

    /// Continue from a checkpoint taken by a session built over the same
    /// scenario and episode configuration. Returns the checkpointed decision's
    /// result.
    pub fn restore(&mut self, checkpoint: &EnvCheckpoint) -> Result<&StepResult> {
        if checkpoint.base_input_hash != self.base_input_hash {
            return Err(SessionError::Checkpoint(format!(
                "checkpoint built from input {} but this session runs {}",
                checkpoint.base_input_hash, self.base_input_hash
            )));
        }
        if checkpoint.episode != self.episode {
            return Err(SessionError::Checkpoint(
                "episode configuration differs from the checkpoint's".into(),
            ));
        }
        let sim = Simulation::restore(&checkpoint.simulation, self.run_options.clone())?;
        self.ego_id = checkpoint.ego_id.clone();
        self.install(sim)?;
        self.builders.restore_range_memory(&checkpoint.range_memory);
        self.causal = Some(checkpoint.causal.clone());
        self.decision_count = checkpoint.decision_count;
        self.prev_ego_s = checkpoint.prev_ego_s;
        self.ended = checkpoint.ended;
        self.result = checkpoint.last_result.clone();
        Ok(&self.result)
    }
}
