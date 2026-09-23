//! CPU-parallel kernel Episodes. NEXT_STEP reset is part of the kernel call,
//! not a second host-side stepping loop. Cameras and realtime are deliberately
//! excluded: batch scheduling is not an inference deadline or renderer owner.
use rayon::prelude::*;
use rayon::{ThreadPool, ThreadPoolBuilder};
use super::*;
use crate::{EnvCheckpoint, FlatBatch};

#[derive(Serialize, Deserialize)]
struct WorldCheckpoint {
    options: EpisodeOptions,
    env: EnvCheckpoint,
    executor: PolicyExecutor,
    last_applied: Option<EpisodeAction>,
    decisions: u32,
    warmup_done: u32,
    policy_start_s: f64,
    executor_frame: Option<ExecutorFrame>,
    trace: String,
    digest: String,
    wall_s: f64,
}

/// Complete batch continuation, including pending NEXT_STEP resets and traces.
#[derive(Serialize, Deserialize)]
pub struct EpisodeBatchCheckpoint {
    version: u32,
    worlds: Vec<WorldCheckpoint>,
    autoreset: Vec<bool>,
    reset_view: bool,
}

pub struct EpisodeBatch {
    specs: Vec<EpisodeSpec>,
    episodes: Vec<Episode>,
    flat: FlatBatch,
    pool: Option<ThreadPool>,
    outcomes: Vec<Option<SessionError>>,
    autoreset: Vec<bool>,
    reset_view: bool,
}

impl EpisodeBatch {
    pub fn new(specs: Vec<EpisodeSpec>, max_objects: usize, threads: usize) -> Result<Self> {
        if specs.is_empty() || max_objects == 0 {
            return Err(SessionError::Config("EpisodeBatch requires worlds and positive max_objects".into()));
        }
        for spec in &specs {
            if spec.options.mode != EpisodeMode::OfflineSimtime {
                return Err(SessionError::Config("EpisodeBatch requires offline-simtime".into()));
            }
            if spec.options.observation.channels.iter().any(|c| matches!(c, ObservationChannel::Cameras { .. })) {
                return Err(SessionError::Config("EpisodeBatch does not support cameras; use individual Episodes".into()));
            }
            if spec.options.observation != specs[0].options.observation || spec.options.decision_hz != specs[0].options.decision_hz {
                return Err(SessionError::Config("EpisodeBatch observation channels and decisionHz must be uniform".into()));
            }
        }
        let episodes = specs.iter().cloned().map(Episode::new).collect::<Result<Vec<_>>>()?;
        let n = episodes.len();
        let mut flat = FlatBatch::default();
        flat.resize_for(n, max_objects, episodes[0].env.config());
        let workers = if threads == 0 { std::thread::available_parallelism().map_or(1, |n| n.get()) } else { threads }.min(n);
        let pool = (workers > 1).then(|| ThreadPoolBuilder::new().num_threads(workers)
            .thread_name(|i| format!("simforge-episode-{i}")).build()).transpose()
            .map_err(|e| SessionError::Config(format!("worker pool: {e}")))?;
        Ok(Self { specs, episodes, flat, pool, outcomes: (0..n).map(|_| None).collect(), autoreset: vec![false; n], reset_view: true })
    }

    pub fn len(&self) -> usize { self.episodes.len() }
    pub fn is_empty(&self) -> bool { self.episodes.is_empty() }
    pub fn flat(&self) -> &FlatBatch { &self.flat }
    pub fn episodes(&self) -> &[Episode] { &self.episodes }
    pub fn env(&self, world: usize) -> Option<&EnvSession> { self.episodes.get(world).map(|e| &e.env) }
    pub fn autoreset(&self) -> &[bool] { &self.autoreset }
    pub fn reset_view(&self) -> bool { self.reset_view }
    pub fn decision_hz(&self) -> u32 { self.specs[0].options.decision_hz }

    /// Scalar seeding is expanded in the kernel, checked rather than wrapped.
    pub fn reset_seed(&mut self, seed: u64) -> Result<()> {
        let seeds = (0..self.len()).map(|i| seed.checked_add(i as u64)
            .ok_or_else(|| SessionError::Config("batch seed expansion overflows u64".into())))
            .collect::<Result<Vec<_>>>()?;
        self.reset_all(Some(&seeds))
    }

    /// Explicit seeds replace each Episode identity. Subsequent NEXT_STEP resets
    /// replay those seeds, just as calling reset() on sequential Episodes does.
    pub fn reset_all(&mut self, seeds: Option<&[u64]>) -> Result<()> {
        if seeds.is_some_and(|seeds| seeds.len() != self.len()) {
            return Err(SessionError::Config("seed count must equal EpisodeBatch size".into()));
        }
        // Changing identity rebuilds once, not at every auto-reset. The same
        // constructor is used by standalone Episode, including its input hash.
        if let Some(seeds) = seeds {
            for (i, &seed) in seeds.iter().enumerate() {
                if self.episodes[i].options.seed != seed {
                    let mut spec = self.specs[i].clone();
                    spec.options.seed = seed;
                    self.episodes[i] = Episode::new(spec)?;
                }
            }
        }
        self.for_each(|_, episode| episode.reset().map(|_| ()))?;
        self.autoreset.fill(false);
        self.refresh(true);
        Ok(())
    }

    /// Exactly one policy barrier per active world. An ended world resets here,
    /// ignores its submitted action and returns reward=0 with cleared flags.
    pub fn step_all(&mut self, actions: &[EpisodeAction]) -> Result<()> {
        if actions.len() != self.len() {
            return Err(SessionError::Config("action count must equal EpisodeBatch size".into()));
        }
        // Refuse a malformed batch before any world advances.
        for (episode, action) in self.episodes.iter().zip(actions) {
            if episode.started.is_none() { return Err(SessionError::NotReset); }
            if !episode.ended() { action.validate()?; }
        }
        for (flag, episode) in self.autoreset.iter_mut().zip(&self.episodes) { *flag = episode.ended(); }
        self.for_each(|i, episode| {
            if episode.ended() { episode.reset().map(|_| ()) }
            else { episode.step(actions[i].clone()).map(|_| ()) }
        })?;
        self.refresh(false);
        Ok(())
    }

    pub fn checkpoint(&self) -> Result<EpisodeBatchCheckpoint> {
        let worlds = self.episodes.iter().map(|e| Ok(WorldCheckpoint {
            options: e.options.clone(), env: e.env.checkpoint()?, executor: e.executor.clone(),
            last_applied: e.last_applied.clone(), decisions: e.decisions, warmup_done: e.warmup_done,
            policy_start_s: e.policy_start_s, executor_frame: e.executor_frame,
            trace: e.trace.clone(), digest: e.digest.clone(),
            wall_s: e.started.ok_or(SessionError::NotReset)?.elapsed().as_secs_f64(),
        })).collect::<Result<Vec<_>>>()?;
        Ok(EpisodeBatchCheckpoint { version: 1, worlds, autoreset: self.autoreset.clone(), reset_view: self.reset_view })
    }

    /// Build and validate replacements before committing, so a wrong world or
    /// configuration cannot leave a half-restored batch.
    pub fn restore(&mut self, checkpoint: &EpisodeBatchCheckpoint) -> Result<()> {
        if checkpoint.version != 1 || checkpoint.worlds.len() != self.len() || checkpoint.autoreset.len() != self.len() {
            return Err(SessionError::Checkpoint("EpisodeBatch version or size differs".into()));
        }
        let replacements = checkpoint.worlds.iter().zip(&self.specs).map(|(saved, base)| {
            let mut spec = base.clone();
            spec.options.seed = saved.options.seed;
            if spec.options != saved.options {
                return Err(SessionError::Checkpoint("Episode options / observation channels differ".into()));
            }
            let mut e = Episode::new(spec)?;
            e.env.restore(&saved.env)?;
            e.executor = saved.executor.clone();
            e.last_applied = saved.last_applied.clone();
            e.decisions = saved.decisions;
            e.warmup_done = saved.warmup_done;
            e.policy_start_s = saved.policy_start_s;
            e.executor_frame = saved.executor_frame;
            e.trace = saved.trace.clone();
            e.digest = saved.digest.clone();
            if !saved.wall_s.is_finite() || saved.wall_s < 0.0 {
                return Err(SessionError::Checkpoint("invalid elapsed wall time".into()));
            }
            e.started = Some(Instant::now().checked_sub(std::time::Duration::try_from_secs_f64(saved.wall_s)
                .map_err(|_| SessionError::Checkpoint("invalid elapsed wall time".into()))?)
                .ok_or_else(|| SessionError::Checkpoint("elapsed wall time out of range".into()))?);
            e.measure_envelope();
            e.observation_delivered();
            Ok(e)
        }).collect::<Result<Vec<_>>>()?;
        self.episodes = replacements;
        self.autoreset.clone_from(&checkpoint.autoreset);
        self.refresh(checkpoint.reset_view);
        Ok(())
    }

    fn refresh(&mut self, reset: bool) {
        self.reset_view = reset;
        for (i, e) in self.episodes.iter().enumerate() {
            self.flat.write(i, e.env.last_result());
            if !e.include_objects {
                let width = self.flat.max_objects * crate::OBJECT_FEATURES;
                self.flat.objects[i * width..(i + 1) * width].fill(0.0);
                self.flat.object_counts[i] = 0;
            }
            self.flat.truncated[i] = u8::from(e.last_step().truncated);
            if reset || self.autoreset[i] {
                self.flat.rewards[i] = 0.0;
                self.flat.terminated[i] = 0;
                self.flat.truncated[i] = 0;
            }
        }
    }

    fn for_each<F>(&mut self, op: F) -> Result<()>
    where F: Fn(usize, &mut Episode) -> Result<()> + Send + Sync {
        let Some(pool) = &self.pool else {
            for (i, e) in self.episodes.iter_mut().enumerate() { op(i, e)?; }
            return Ok(());
        };
        let chunk = self.len().div_ceil(pool.current_num_threads()).max(1);
        let episodes = &mut self.episodes;
        let outcomes = &mut self.outcomes;
        pool.install(|| episodes.par_chunks_mut(chunk).zip(outcomes.par_chunks_mut(chunk)).enumerate()
            .for_each(|(c, (worlds, slots))| for (k, (e, slot)) in worlds.iter_mut().zip(slots).enumerate() {
                *slot = op(c * chunk + k, e).err();
            }));
        outcomes.iter_mut().find_map(Option::take).map_or(Ok(()), Err)
    }
}
