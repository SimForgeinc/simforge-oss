//! `SessionBatch` — N independent `EnvSession`s stepped together.
//!
//! CPU parallelism is over independent worlds: each session is a
//! self-contained deterministic engine, so the thread a world happens to run
//! on never changes its result. Results are exposed both as typed per-world
//! `StepResult`s and as flat N-major buffers ready to hand to a tensor
//! framework without per-step object construction.

use rayon::prelude::*;
use rayon::{ThreadPool, ThreadPoolBuilder};

use simforge_core::engine::{ActionOverride, RunOptions};
use simforge_core::rng::Seed;
use simforge_core::types::SimScenarioInput;

use crate::env::{EnvSession, StepResult};
use crate::episode::EpisodeConfig;
use crate::error::{Result, SessionError};
use crate::observation::{BEV_CHANNELS, STATE_VECTOR_SIZE};

/// Perceived-object feature layout: `[range_m, bearing_rad, range_rate_mps, los, valid]`.
pub const OBJECT_FEATURES: usize = 5;

/// Flat, N-major observation/result buffers for one batch step.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct FlatBatch {
    pub worlds: usize,
    pub max_objects: usize,
    /// `(N, STATE_VECTOR_SIZE)`; empty when the state vector is disabled.
    pub state: Vec<f64>,
    /// `(N, max_objects, OBJECT_FEATURES)`; entries past `object_counts[i]` are zero.
    pub objects: Vec<f64>,
    /// Objects materialised per world (capped at `max_objects`).
    pub object_counts: Vec<u32>,
    /// `(N, height, width, BEV_CHANNELS)`; empty when BEV is disabled.
    pub bev: Vec<f32>,
    pub bev_height: usize,
    pub bev_width: usize,
    pub rewards: Vec<f64>,
    pub terminated: Vec<u8>,
    pub truncated: Vec<u8>,
    pub t_s: Vec<f64>,
}

impl FlatBatch {
    fn resize_for(&mut self, worlds: usize, max_objects: usize, config: &EpisodeConfig) {
        self.worlds = worlds;
        self.max_objects = max_objects;
        self.state.clear();
        self.state.resize(
            if config.observation.state_vector {
                worlds * STATE_VECTOR_SIZE
            } else {
                0
            },
            0.0,
        );
        self.objects.clear();
        self.objects
            .resize(worlds * max_objects * OBJECT_FEATURES, 0.0);
        self.object_counts.clear();
        self.object_counts.resize(worlds, 0);
        match &config.observation.bev {
            Some(bev) => {
                self.bev_height = bev.height();
                self.bev_width = bev.width();
                self.bev.clear();
                self.bev.resize(
                    worlds * self.bev_height * self.bev_width * BEV_CHANNELS,
                    0.0,
                );
            }
            None => {
                self.bev_height = 0;
                self.bev_width = 0;
                self.bev.clear();
            }
        }
        self.rewards.clear();
        self.rewards.resize(worlds, 0.0);
        self.terminated.clear();
        self.terminated.resize(worlds, 0);
        self.truncated.clear();
        self.truncated.resize(worlds, 0);
        self.t_s.clear();
        self.t_s.resize(worlds, 0.0);
    }

    fn write(&mut self, i: usize, result: &StepResult) {
        let obs = &result.observation;
        if let Some(sv) = &obs.state_vector {
            self.state[i * STATE_VECTOR_SIZE..(i + 1) * STATE_VECTOR_SIZE].copy_from_slice(sv);
        }
        let base = i * self.max_objects * OBJECT_FEATURES;
        let slab = &mut self.objects[base..base + self.max_objects * OBJECT_FEATURES];
        slab.fill(0.0);
        let n = obs.objects.len().min(self.max_objects);
        for (k, o) in obs.objects.iter().take(n).enumerate() {
            let row = &mut slab[k * OBJECT_FEATURES..(k + 1) * OBJECT_FEATURES];
            row[0] = o.range_m;
            row[1] = o.bearing_rad;
            row[2] = o.range_rate_mps;
            row[3] = if o.line_of_sight { 1.0 } else { 0.0 };
            row[4] = 1.0;
        }
        self.object_counts[i] = n as u32;
        if let Some(bev) = &obs.bev {
            let len = self.bev_height * self.bev_width * BEV_CHANNELS;
            if bev.data.len() == len {
                self.bev[i * len..(i + 1) * len].copy_from_slice(&bev.data);
            }
        }
        self.rewards[i] = result.reward;
        self.terminated[i] = u8::from(result.terminated);
        self.truncated[i] = u8::from(result.truncated);
        self.t_s[i] = obs.t_s;
    }
}

pub struct SessionBatch {
    sessions: Vec<EnvSession>,
    config: EpisodeConfig,
    flat: FlatBatch,
    /// Bounded worker pool, built once; `None` = single worker, serial path.
    pool: Option<ThreadPool>,
    /// Per-world outcome scratch reused across steps.
    outcomes: Vec<Option<SessionError>>,
}

impl SessionBatch {
    /// Own `sessions`; all must share one `EpisodeConfig` so the flat layout
    /// is uniform. `max_objects` caps the padded object slab per world;
    /// `threads = 0` uses the available hardware parallelism.
    pub fn new(sessions: Vec<EnvSession>, max_objects: usize, threads: usize) -> Result<Self> {
        let Some(first) = sessions.first() else {
            return Err(SessionError::Config(
                "a SessionBatch needs at least one session".into(),
            ));
        };
        let config = first.config().clone();
        if let Some(bad) = sessions.iter().position(|s| s.config() != &config) {
            return Err(SessionError::Config(format!(
                "session {bad} has a different EpisodeConfig from session 0"
            )));
        }
        let mut flat = FlatBatch::default();
        flat.resize_for(sessions.len(), max_objects, &config);
        let threads = if threads == 0 {
            std::thread::available_parallelism().map_or(1, |n| n.get())
        } else {
            threads
        };
        let workers = threads.min(sessions.len());
        let pool = (workers > 1)
            .then(|| {
                ThreadPoolBuilder::new()
                    .num_threads(workers)
                    .thread_name(|i| format!("simforge-world-{i}"))
                    .build()
            })
            .transpose()
            .map_err(|e| SessionError::Config(format!("worker pool: {e}")))?;
        Ok(Self {
            sessions,
            config,
            flat,
            pool,
            outcomes: Vec::new(),
        })
    }

    /// `n` sessions over the same scenario/config/graph (the env-server layout).
    pub fn replicate(
        input: &SimScenarioInput,
        run_options: &RunOptions,
        config: &EpisodeConfig,
        n: usize,
        max_objects: usize,
        threads: usize,
    ) -> Result<Self> {
        let sessions = (0..n)
            .map(|_| EnvSession::new(input.clone(), run_options.clone(), config.clone()))
            .collect::<Result<Vec<_>>>()?;
        Self::new(sessions, max_objects, threads)
    }

    #[inline]
    pub fn len(&self) -> usize {
        self.sessions.len()
    }

    #[inline]
    pub fn is_empty(&self) -> bool {
        self.sessions.is_empty()
    }

    #[inline]
    pub fn config(&self) -> &EpisodeConfig {
        &self.config
    }

    #[inline]
    pub fn session(&self, i: usize) -> Option<&EnvSession> {
        self.sessions.get(i)
    }

    #[inline]
    pub fn session_mut(&mut self, i: usize) -> Option<&mut EnvSession> {
        self.sessions.get_mut(i)
    }

    #[inline]
    pub fn sessions(&self) -> &[EnvSession] {
        &self.sessions
    }

    /// Typed per-world results of the last `reset_all`/`step_batch`.
    pub fn results(&self) -> impl ExactSizeIterator<Item = &StepResult> + '_ {
        self.sessions.iter().map(EnvSession::last_result)
    }

    /// Flat N-major buffers of the last `reset_all`/`step_batch`.
    #[inline]
    pub fn flat(&self) -> &FlatBatch {
        &self.flat
    }

    /// Reset every world; `seeds[i]` (when given) replaces world `i`'s authored seed.
    pub fn reset_all(&mut self, seeds: Option<&[Seed]>) -> Result<()> {
        if let Some(seeds) = seeds {
            if seeds.len() != self.sessions.len() {
                return Err(SessionError::Config(format!(
                    "{} seeds for {} sessions",
                    seeds.len(),
                    self.sessions.len()
                )));
            }
        }
        self.for_each_world(|i, s| s.reset(seeds.map(|v| &v[i])).map(|_| ()))?;
        self.refresh_flat();
        Ok(())
    }

    /// Step every world with its own action (`None` = scripted). A finished
    /// world errors (`SessionError::Finished`); callers reset it first.
    pub fn step_batch(&mut self, actions: &[Option<ActionOverride>]) -> Result<()> {
        if actions.len() != self.sessions.len() {
            return Err(SessionError::Config(format!(
                "{} actions for {} sessions",
                actions.len(),
                self.sessions.len()
            )));
        }
        self.for_each_world(|i, s| s.step(actions[i]).map(|_| ()))?;
        self.refresh_flat();
        Ok(())
    }

    /// Step only worlds with `active[i]`, in parallel; inactive worlds keep
    /// their state and last result (NEXT_STEP autoreset: finished worlds are
    /// skipped in the same call the others advance). Flat buffers refresh for
    /// every world.
    pub fn step_masked(
        &mut self,
        actions: &[Option<ActionOverride>],
        active: &[bool],
    ) -> Result<()> {
        if actions.len() != self.sessions.len() || active.len() != self.sessions.len() {
            return Err(SessionError::Config(format!(
                "{} actions / {} mask entries for {} sessions",
                actions.len(),
                active.len(),
                self.sessions.len()
            )));
        }
        self.for_each_world(|i, s| {
            if active[i] {
                s.step(actions[i]).map(|_| ())
            } else {
                Ok(())
            }
        })?;
        self.refresh_flat();
        Ok(())
    }

    /// Reset only the listed worlds (e.g. those that just ended), leaving the
    /// others' state and last results untouched.
    pub fn reset_some(&mut self, worlds: &[(usize, Option<Seed>)]) -> Result<()> {
        for (i, seed) in worlds {
            let s = self
                .sessions
                .get_mut(*i)
                .ok_or_else(|| SessionError::Config(format!("no session {i}")))?;
            s.reset(seed.as_ref())?;
        }
        self.refresh_flat();
        Ok(())
    }

    fn refresh_flat(&mut self) {
        for (i, s) in self.sessions.iter().enumerate() {
            self.flat.write(i, s.last_result());
        }
    }

    /// Run `op` over every world: serially with one worker, otherwise on the
    /// batch's owned worker pool (threads started once in `new`, never per
    /// step). Each world writes its outcome into a fixed slot of a reused
    /// scratch vector, so the reported error is always the lowest failing
    /// index regardless of scheduling.
    fn for_each_world<F>(&mut self, op: F) -> Result<()>
    where
        F: Fn(usize, &mut EnvSession) -> Result<()> + Send + Sync,
    {
        let Some(pool) = &self.pool else {
            for (i, s) in self.sessions.iter_mut().enumerate() {
                op(i, s)?;
            }
            return Ok(());
        };
        let n = self.sessions.len();
        let outcomes = &mut self.outcomes;
        outcomes.clear();
        outcomes.resize_with(n, || None);
        let chunk = n.div_ceil(pool.current_num_threads()).max(1);
        let sessions = &mut self.sessions;
        pool.install(|| {
            sessions
                .par_chunks_mut(chunk)
                .zip(outcomes.par_chunks_mut(chunk))
                .enumerate()
                .for_each(|(c, (worlds, slots))| {
                    for (k, (s, slot)) in worlds.iter_mut().zip(slots.iter_mut()).enumerate() {
                        *slot = op(c * chunk + k, s).err();
                    }
                });
        });
        outcomes
            .iter_mut()
            .find_map(Option::take)
            .map_or(Ok(()), Err)
    }
}
