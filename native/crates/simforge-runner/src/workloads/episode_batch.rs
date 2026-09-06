//! `simforge.episode-batch/v1`: N seeded finite episodes of one scenario
//! through `simforge_session::SessionBatch`, with the ego driven either by
//! the authored choreography (`scripted`) or by a recorded per-decision
//! `PolicyAction` schedule executed through the real `PolicyExecutor`
//! (deadline/fallback/pure-pursuit semantics, no second plant). This is the
//! headless rollout/evaluation workload; a live learner uses the bindings.
//!
//! Inputs (by `inputId`):
//! - `scenario.input`  canonical `SimScenarioInput` JSON (required)
//! - `map.topology`    decoded topology index JSON, plain or gzip (required)
//! - `map.colliders`   JSON array of `StaticMapCollider` (optional)
//! - `policy.actions`  recorded schedule (required when `policy.kind == recorded`):
//!                     `{"schema":"simforge.policy-action-schedule/v1","decisions":[PolicyAction, ...]}`
//!                     applied by decision index to every world; a shorter
//!                     schedule falls back to scripted for the remainder.
//!
//! Outputs (by `outputId`):
//! - `episodes`  `application/json`  per-seed summary (required)
//! - `rollouts`  `application/gzip`  gzipped per-world per-decision `StepResult`s
//! - `causal`    `application/gzip`  gzipped per-world causal channels
//!
//! Params: `{ seeds: [number|string, ...], episode: EpisodeConfig,
//!            policy: {kind: "scripted"} | {kind: "recorded", executor?: PolicyExecutorConfig},
//!            maxObjects?: usize=32, threads?: usize=0, checkpointEveryDecisions?: u32=0 }`

use std::fs;
use std::io::Write;
use std::path::Path;
use std::sync::Arc;

use flate2::write::GzEncoder;
use flate2::Compression;
use serde::{Deserialize, Serialize};
use simforge_core::engine::{ActionOverride, RunOptions, StaticMapCollider};
use simforge_core::map::{LaneGraph, TopologyIndex};
use simforge_core::rng::Seed;
use simforge_core::types::SimScenarioInput;
use simforge_session::batch::SessionBatch;
use simforge_session::causal::CausalChannel;
use simforge_session::env::{EnvCheckpoint, StepResult};
use simforge_session::episode::EpisodeConfig;
use simforge_session::policy::{PolicyAction, PolicyExecutor, PolicyExecutorConfig};

use crate::engine::{
    AdmissionContext, AdmissionReport, EngineCapabilities, ExecutionContext, ExecutionOutcome,
    JobEngine, ProducedArtifact, ResolvedInput,
};
use crate::error::{Result, RunnerError};
use crate::hash::{canonical_sha256, hash_file, sha256_hex};

pub const WORKLOAD: &str = "simforge.episode-batch/v1";
pub const INPUT_SCENARIO: &str = "scenario.input";
pub const INPUT_TOPOLOGY: &str = "map.topology";
pub const INPUT_COLLIDERS: &str = "map.colliders";
pub const INPUT_ACTIONS: &str = "policy.actions";
pub const OUTPUT_EPISODES: &str = "episodes";
pub const OUTPUT_ROLLOUTS: &str = "rollouts";
pub const OUTPUT_CAUSAL: &str = "causal";
pub const ACTION_SCHEDULE_SCHEMA: &str = "simforge.policy-action-schedule/v1";
const CHECKPOINT_FILE: &str = "batch.checkpoint.msgpack";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum PolicyParams {
    Scripted,
    Recorded {
        #[serde(default)]
        executor: PolicyExecutorConfig,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EpisodeBatchParams {
    pub seeds: Vec<Seed>,
    #[serde(default)]
    pub episode: EpisodeConfig,
    pub policy: PolicyParams,
    #[serde(default = "default_max_objects")]
    pub max_objects: usize,
    #[serde(default)]
    pub threads: usize,
    #[serde(default)]
    pub checkpoint_every_decisions: u32,
}

fn default_max_objects() -> usize {
    32
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ActionSchedule {
    schema: String,
    decisions: Vec<PolicyAction>,
}

/// Complete continuation state of the batch at a decision boundary.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BatchCheckpoint {
    decision: u32,
    sessions: Vec<EnvCheckpoint>,
    executors: Vec<PolicyExecutor>,
    returns: Vec<f64>,
    lengths: Vec<u32>,
    rollouts: Vec<Vec<StepResult>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct EpisodeSummary {
    world: usize,
    seed: Seed,
    decisions: u32,
    episode_return: f64,
    terminated: bool,
    truncated: bool,
    final_t_s: f64,
    minima: Vec<simforge_core::engine::PairMinima>,
}

fn engine_error(reason: impl std::fmt::Display) -> RunnerError {
    RunnerError::Engine {
        workload: WORKLOAD.into(),
        reason: reason.to_string(),
    }
}

fn required_input<'a>(inputs: &'a [ResolvedInput], input_id: &str) -> Result<&'a ResolvedInput> {
    inputs
        .iter()
        .find(|input| input.input_id == input_id)
        .ok_or_else(|| engine_error(format!("missing required input {input_id}")))
}

fn read_input(input: &ResolvedInput) -> Result<Vec<u8>> {
    fs::read(&input.path).map_err(|source| RunnerError::io(&input.path, source))
}

struct Loaded {
    input: SimScenarioInput,
    graph: Arc<LaneGraph>,
    colliders: Vec<StaticMapCollider>,
    params: EpisodeBatchParams,
    schedule: Vec<PolicyAction>,
}

fn load(inputs: &[ResolvedInput], params: &serde_json::Value) -> Result<Loaded> {
    let params: EpisodeBatchParams = serde_json::from_value(params.clone())
        .map_err(|error| engine_error(format!("params: {error}")))?;
    if params.seeds.is_empty() {
        return Err(engine_error("params.seeds must list at least one seed"));
    }
    if params.max_objects == 0 {
        return Err(engine_error("params.maxObjects must be at least 1"));
    }
    let input = simforge_core::load_scenario(&read_input(required_input(inputs, INPUT_SCENARIO)?)?)
        .map_err(|error| engine_error(format!("{INPUT_SCENARIO}: {error}")))?;
    let index = TopologyIndex::decode(&read_input(required_input(inputs, INPUT_TOPOLOGY)?)?)
        .map_err(|error| engine_error(format!("{INPUT_TOPOLOGY}: {error}")))?;
    let graph = Arc::new(LaneGraph::new(index));
    let colliders = match inputs
        .iter()
        .find(|input| input.input_id == INPUT_COLLIDERS)
    {
        Some(input) => serde_json::from_slice(&read_input(input)?)
            .map_err(|error| engine_error(format!("{INPUT_COLLIDERS}: {error}")))?,
        None => Vec::new(),
    };
    let schedule = match &params.policy {
        PolicyParams::Scripted => {
            if inputs.iter().any(|input| input.input_id == INPUT_ACTIONS) {
                return Err(engine_error(format!(
                    "{INPUT_ACTIONS} given but params.policy.kind is scripted"
                )));
            }
            Vec::new()
        }
        PolicyParams::Recorded { .. } => {
            let schedule: ActionSchedule =
                serde_json::from_slice(&read_input(required_input(inputs, INPUT_ACTIONS)?)?)
                    .map_err(|error| engine_error(format!("{INPUT_ACTIONS}: {error}")))?;
            if schedule.schema != ACTION_SCHEDULE_SCHEMA {
                return Err(engine_error(format!(
                    "{INPUT_ACTIONS} schema must be {ACTION_SCHEDULE_SCHEMA}"
                )));
            }
            if schedule.decisions.is_empty() {
                return Err(engine_error(format!("{INPUT_ACTIONS} lists no decisions")));
            }
            schedule.decisions
        }
    };
    Ok(Loaded {
        input,
        graph,
        colliders,
        params,
        schedule,
    })
}

impl Loaded {
    fn run_options(&self) -> RunOptions {
        let mut options = RunOptions::new(Arc::clone(&self.graph));
        options.static_colliders = self.colliders.clone();
        options
    }

    fn executors(&self) -> Result<Vec<PolicyExecutor>> {
        match &self.params.policy {
            PolicyParams::Scripted => Ok(Vec::new()),
            PolicyParams::Recorded { executor } => (0..self.params.seeds.len())
                .map(|_| PolicyExecutor::new(*executor).map_err(engine_error))
                .collect(),
        }
    }
}

fn write_gzip_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let file = fs::File::create(path).map_err(|source| RunnerError::io(path, source))?;
    let mut encoder = GzEncoder::new(file, Compression::default());
    serde_json::to_writer(&mut encoder, value).map_err(|source| RunnerError::Json {
        path: path.to_path_buf(),
        source,
    })?;
    encoder
        .finish()
        .and_then(|mut file| file.flush())
        .map_err(|source| RunnerError::io(path, source))
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let bytes = serde_json::to_vec(value).map_err(|source| RunnerError::Json {
        path: path.to_path_buf(),
        source,
    })?;
    fs::write(path, bytes).map_err(|source| RunnerError::io(path, source))
}

fn artifact(ctx: &ExecutionContext<'_>, output_id: &str, path: &Path) -> Result<ProducedArtifact> {
    let contract = ctx
        .manifest
        .output(output_id)
        .expect("caller checked the contract exists");
    let digest = hash_file(path)?;
    Ok(ProducedArtifact {
        output_id: output_id.to_owned(),
        relative_path: contract.relative_path.clone(),
        sha256: digest.sha256,
        size_bytes: digest.size_bytes,
        media_type: contract.media_type.clone(),
    })
}

pub struct EpisodeBatchEngine;

impl JobEngine for EpisodeBatchEngine {
    fn capabilities(&self) -> EngineCapabilities {
        EngineCapabilities {
            workload: WORKLOAD.into(),
            requires_gpu: false,
            supports_continuation: true,
            backend_profiles: vec!["cpu-reference".into()],
        }
    }

    fn admit(&self, ctx: &AdmissionContext<'_>) -> Result<AdmissionReport> {
        let loaded = load(ctx.inputs, &ctx.manifest.params)?;
        if ctx.manifest.output(OUTPUT_EPISODES).is_none() {
            return Err(engine_error(format!(
                "manifest must declare output {OUTPUT_EPISODES}"
            )));
        }
        // Build one session to validate the episode configuration against
        // the scenario exactly as execution will.
        let probe = simforge_session::env::EnvSession::new(
            loaded.input.clone(),
            loaded.run_options(),
            loaded.params.episode.clone(),
        )
        .map_err(engine_error)?;
        let input_hash = probe.base_input_hash().to_owned();
        let params_hash = canonical_sha256(&loaded.params)?;
        let colliders_hash = canonical_sha256(&loaded.colliders)?;
        let schedule_hash = canonical_sha256(&loaded.schedule)?;
        let execution_identity = sha256_hex(
            format!(
                "{WORKLOAD}\n{input_hash}\n{}\n{colliders_hash}\n{params_hash}\n{schedule_hash}",
                loaded.graph.topology_digest()
            )
            .as_bytes(),
        );
        Ok(AdmissionReport {
            execution_identity,
            summary: serde_json::json!({
                "baseInputHash": input_hash,
                "topologyDigest": loaded.graph.topology_digest(),
                "worlds": loaded.params.seeds.len(),
                "ego": probe.ego(),
                "episode": probe.episode(),
                "policy": loaded.params.policy,
                "scheduledDecisions": loaded.schedule.len(),
            }),
        })
    }

    fn execute(&self, ctx: &mut ExecutionContext<'_>) -> Result<ExecutionOutcome> {
        let loaded = load(ctx.inputs, &ctx.manifest.params)?;
        let worlds = loaded.params.seeds.len();
        let mut batch = SessionBatch::replicate(
            &loaded.input,
            &loaded.run_options(),
            &loaded.params.episode,
            worlds,
            loaded.params.max_objects,
            loaded.params.threads,
        )
        .map_err(engine_error)?;
        let want_rollouts = ctx.manifest.output(OUTPUT_ROLLOUTS).is_some();

        let mut decision: u32;
        let mut executors: Vec<PolicyExecutor>;
        let mut returns: Vec<f64>;
        let mut lengths: Vec<u32>;
        let mut rollouts: Vec<Vec<StepResult>>;
        match ctx.resume {
            Some(point) => {
                let path = point.dir.join(CHECKPOINT_FILE);
                let bytes = fs::read(&path).map_err(|source| RunnerError::io(&path, source))?;
                let checkpoint: BatchCheckpoint = simforge_core::checkpoint::decode(&bytes)
                    .map_err(|error| engine_error(format!("{}: {error}", path.display())))?;
                if checkpoint.sessions.len() != worlds {
                    return Err(engine_error(format!(
                        "checkpoint holds {} worlds but params declare {worlds}",
                        checkpoint.sessions.len()
                    )));
                }
                for (i, session_checkpoint) in checkpoint.sessions.iter().enumerate() {
                    batch
                        .session_mut(i)
                        .expect("world index in range")
                        .restore(session_checkpoint)
                        .map_err(engine_error)?;
                }
                decision = checkpoint.decision;
                executors = checkpoint.executors;
                returns = checkpoint.returns;
                lengths = checkpoint.lengths;
                rollouts = checkpoint.rollouts;
            }
            None => {
                batch
                    .reset_all(Some(&loaded.params.seeds))
                    .map_err(engine_error)?;
                decision = 0;
                executors = loaded.executors()?;
                returns = vec![0.0; worlds];
                lengths = vec![0; worlds];
                rollouts = if want_rollouts {
                    batch.results().map(|result| vec![result.clone()]).collect()
                } else {
                    Vec::new()
                };
            }
        }

        let mut actions: Vec<Option<ActionOverride>> = vec![None; worlds];
        let mut decisions_since_checkpoint = 0u32;
        loop {
            ctx.cancel.check()?;
            let active: Vec<usize> = (0..worlds)
                .filter(|&i| !batch.session(i).expect("world index in range").ended())
                .collect();
            if active.is_empty() {
                break;
            }
            // Resolve this decision's action per world from the recorded
            // schedule through the real executor; scripted worlds pass None.
            for &i in &active {
                actions[i] = match (
                    &loaded.params.policy,
                    loaded.schedule.get(decision as usize),
                ) {
                    (PolicyParams::Recorded { .. }, Some(action)) => {
                        let session = batch.session(i).expect("world index in range");
                        let (pose, t_s) = session
                            .ego_pose()
                            .ok_or_else(|| engine_error("ego pose unavailable after reset"))?;
                        executors[i]
                            .decide(action, None, None, &pose, t_s)
                            .map_err(engine_error)?
                            .override_action
                    }
                    _ => None,
                };
            }
            // Finished worlds must not be stepped; step them one by one.
            if active.len() == worlds {
                batch.step_batch(&actions).map_err(engine_error)?;
            } else {
                for &i in &active {
                    batch
                        .session_mut(i)
                        .expect("world index in range")
                        .step(actions[i])
                        .map_err(engine_error)?;
                }
            }
            for &i in &active {
                let result = batch
                    .session(i)
                    .expect("world index in range")
                    .last_result();
                returns[i] += result.reward;
                lengths[i] += 1;
                if want_rollouts {
                    rollouts[i].push(result.clone());
                }
            }
            decision += 1;
            decisions_since_checkpoint += 1;
            ctx.progress(serde_json::json!({ "decision": decision, "activeWorlds": active.len(), "worlds": worlds }))?;

            if loaded.params.checkpoint_every_decisions > 0
                && decisions_since_checkpoint >= loaded.params.checkpoint_every_decisions
            {
                let sessions = batch
                    .sessions()
                    .iter()
                    .map(|session| session.checkpoint().map_err(engine_error))
                    .collect::<Result<Vec<_>>>()?;
                let checkpoint = BatchCheckpoint {
                    decision,
                    sessions,
                    executors: executors.clone(),
                    returns: returns.clone(),
                    lengths: lengths.clone(),
                    rollouts: rollouts.clone(),
                };
                let bytes = simforge_core::checkpoint::encode(&checkpoint).map_err(engine_error)?;
                ctx.checkpoint(
                    serde_json::json!({ "decision": decision, "activeWorlds": active.len() }),
                    |dir| {
                        let path = dir.join(CHECKPOINT_FILE);
                        fs::write(&path, &bytes).map_err(|source| RunnerError::io(path, source))
                    },
                )?;
                decisions_since_checkpoint = 0;
            }
        }

        let summaries: Vec<EpisodeSummary> = (0..worlds)
            .map(|i| {
                let result = batch
                    .session(i)
                    .expect("world index in range")
                    .last_result();
                EpisodeSummary {
                    world: i,
                    seed: loaded.params.seeds[i].clone(),
                    decisions: lengths[i],
                    episode_return: returns[i],
                    terminated: result.terminated,
                    truncated: result.truncated,
                    final_t_s: result.info.t_s,
                    minima: result.info.minima.clone(),
                }
            })
            .collect();
        let terminated = summaries
            .iter()
            .filter(|summary| summary.terminated)
            .count();

        let mut artifacts = Vec::with_capacity(3);
        let episodes_path = ctx.output_dir.join(
            &ctx.manifest
                .output(OUTPUT_EPISODES)
                .expect("checked at admission")
                .relative_path,
        );
        write_json(
            &episodes_path,
            &serde_json::json!({ "schema": "simforge.episode-batch-summary/v1", "episode": batch.config(), "policy": loaded.params.policy, "episodes": summaries }),
        )?;
        artifacts.push(artifact(ctx, OUTPUT_EPISODES, &episodes_path)?);
        if let Some(contract) = ctx.manifest.output(OUTPUT_ROLLOUTS) {
            let path = ctx.output_dir.join(&contract.relative_path);
            write_gzip_json(&path, &rollouts)?;
            artifacts.push(artifact(ctx, OUTPUT_ROLLOUTS, &path)?);
        }
        if let Some(contract) = ctx.manifest.output(OUTPUT_CAUSAL) {
            let channels = batch
                .sessions()
                .iter()
                .map(|session| session.causal_channel().map_err(engine_error))
                .collect::<Result<Vec<CausalChannel>>>()?;
            let path = ctx.output_dir.join(&contract.relative_path);
            write_gzip_json(&path, &channels)?;
            artifacts.push(artifact(ctx, OUTPUT_CAUSAL, &path)?);
        }
        Ok(ExecutionOutcome {
            artifacts,
            summary: serde_json::json!({ "worlds": worlds, "decisions": decision, "terminated": terminated }),
        })
    }
}
