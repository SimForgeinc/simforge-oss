//! `simforge.simulate/v1`: one canonical scenario against one decoded map
//! topology through `simforge_core::engine::Simulation`, stepped in tick
//! batches so cancellation and continuation checkpoints land on real engine
//! boundaries. Output is the current trace format (gzipped JSON), the exact
//! normalized executed input and the engine's issues/arrival solutions.
//!
//! Inputs (by `inputId`):
//! - `scenario.input`   canonical `SimScenarioInput` JSON (required)
//! - `map.topology`     decoded topology index JSON, plain or gzip (required)
//! - `map.colliders`    JSON array of `StaticMapCollider` (optional)
//!
//! Outputs (by `outputId`, each optional unless the manifest requires it):
//! - `trace`    `application/gzip`  gzipped current `SimTrace` JSON
//! - `input`    `application/json`  normalized executed `SimScenarioInput`
//! - `result`   `application/json`  `{issues, arrival, ticks, tS}`
//!
//! Params (`manifest.params`, parsed once):
//! `{ batchTicks?: usize=50, checkpointEveryTicks?: u64=0,
//!    includeWarmupTrace?: bool=false, resolveArrival?: bool=true }`

use std::fs;
use std::io::Write;
use std::path::Path;
use std::sync::Arc;

use flate2::write::GzEncoder;
use flate2::Compression;
use serde::{Deserialize, Serialize};
use simforge_core::engine::{
    ActorAction, RunOptions, SimResult, Simulation, SimulationCheckpoint, StaticMapCollider,
};
use simforge_core::map::{LaneGraph, TopologyIndex};
use simforge_core::types::SimScenarioInput;

use crate::engine::{
    AdmissionContext, AdmissionReport, EngineCapabilities, ExecutionContext, ExecutionOutcome,
    JobEngine, ProducedArtifact, ResolvedInput,
};
use crate::error::{Result, RunnerError};
use crate::hash::{hash_file, sha256_hex};

pub const WORKLOAD: &str = "simforge.simulate/v1";
pub const INPUT_SCENARIO: &str = "scenario.input";
pub const INPUT_TOPOLOGY: &str = "map.topology";
pub const INPUT_COLLIDERS: &str = "map.colliders";
pub const OUTPUT_TRACE: &str = "trace";
pub const OUTPUT_INPUT: &str = "input";
pub const OUTPUT_RESULT: &str = "result";
const CHECKPOINT_FILE: &str = "simulation.checkpoint.msgpack";
const NO_ACTIONS: &[ActorAction] = &[];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct SimulateParams {
    /// Ticks advanced between cancellation checks and progress events.
    pub batch_ticks: usize,
    /// Publish a continuation checkpoint every N ticks; 0 disables.
    pub checkpoint_every_ticks: u64,
    pub include_warmup_trace: bool,
    pub resolve_arrival: bool,
}

impl Default for SimulateParams {
    fn default() -> Self {
        SimulateParams {
            batch_ticks: 50,
            checkpoint_every_ticks: 0,
            include_warmup_trace: false,
            resolve_arrival: true,
        }
    }
}

fn engine_error(reason: impl std::fmt::Display) -> RunnerError {
    RunnerError::Engine {
        workload: WORKLOAD.into(),
        reason: reason.to_string(),
    }
}

fn parse_params(value: &serde_json::Value) -> Result<SimulateParams> {
    if value.is_null() {
        return Ok(SimulateParams::default());
    }
    let params: SimulateParams = serde_json::from_value(value.clone())
        .map_err(|error| engine_error(format!("params: {error}")))?;
    if params.batch_ticks == 0 {
        return Err(engine_error("params.batchTicks must be at least 1"));
    }
    Ok(params)
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
    params: SimulateParams,
}

fn load(inputs: &[ResolvedInput], params: &serde_json::Value) -> Result<Loaded> {
    let params = parse_params(params)?;
    let scenario_bytes = read_input(required_input(inputs, INPUT_SCENARIO)?)?;
    let input = simforge_core::load_scenario(&scenario_bytes)
        .map_err(|error| engine_error(format!("{INPUT_SCENARIO}: {error}")))?;
    let topology_bytes = read_input(required_input(inputs, INPUT_TOPOLOGY)?)?;
    let index = TopologyIndex::decode(&topology_bytes)
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
    Ok(Loaded {
        input,
        graph,
        colliders,
        params,
    })
}

impl Loaded {
    fn run_options(&self) -> RunOptions {
        let mut options = RunOptions::new(Arc::clone(&self.graph));
        options.static_colliders = self.colliders.clone();
        options.include_warmup_trace = self.params.include_warmup_trace;
        options.resolve_arrival = self.params.resolve_arrival;
        options
    }
}

fn write_gzip_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let file = fs::File::create(path).map_err(|source| RunnerError::io(path, source))?;
    let mut encoder = GzEncoder::new(file, Compression::default());
    serde_json::to_writer(&mut encoder, value).map_err(|source| RunnerError::Json {
        path: path.to_path_buf(),
        source,
    })?;
    let mut file = encoder
        .finish()
        .map_err(|source| RunnerError::io(path, source))?;
    file.flush().map_err(|source| RunnerError::io(path, source))
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

pub struct SimulateEngine;

impl JobEngine for SimulateEngine {
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
        if ctx.manifest.output(OUTPUT_TRACE).is_none() {
            return Err(engine_error(format!(
                "manifest must declare output {OUTPUT_TRACE}"
            )));
        }
        let input_hash = simforge_core::hash::content_hash_of(&loaded.input)
            .map_err(|error| engine_error(error))?;
        let params_hash = crate::hash::canonical_sha256(&loaded.params)?;
        let colliders_hash = crate::hash::canonical_sha256(&loaded.colliders)?;
        let execution_identity = sha256_hex(
            format!(
                "{WORKLOAD}\n{input_hash}\n{}\n{colliders_hash}\n{params_hash}",
                loaded.graph.topology_digest()
            )
            .as_bytes(),
        );
        Ok(AdmissionReport {
            execution_identity,
            summary: serde_json::json!({
                "scenarioInputHash": input_hash,
                "topologyDigest": loaded.graph.topology_digest(),
                "staticColliders": loaded.colliders.len(),
                "params": loaded.params,
            }),
        })
    }

    fn execute(&self, ctx: &mut ExecutionContext<'_>) -> Result<ExecutionOutcome> {
        let loaded = load(ctx.inputs, &ctx.manifest.params)?;
        let mut simulation = match ctx.resume {
            Some(point) => {
                let path = point.dir.join(CHECKPOINT_FILE);
                let bytes = fs::read(&path).map_err(|source| RunnerError::io(&path, source))?;
                let checkpoint: SimulationCheckpoint = simforge_core::checkpoint::decode(&bytes)
                    .map_err(|error| engine_error(format!("{}: {error}", path.display())))?;
                Simulation::restore(&checkpoint, loaded.run_options())
                    .map_err(|error| engine_error(format!("restore checkpoint: {error}")))?
            }
            None => Simulation::new(loaded.input.clone(), loaded.run_options())
                .map_err(|error| engine_error(error))?,
        };

        let mut ticks_total: u64 = ctx
            .resume
            .and_then(|point| point.manifest.metadata["ticks"].as_u64())
            .unwrap_or(0);
        let mut ticks_since_checkpoint: u64 = 0;
        loop {
            ctx.cancel.check()?;
            let progress = simulation
                .advance(loaded.params.batch_ticks, NO_ACTIONS)
                .map_err(|error| engine_error(error))?;
            ticks_total += progress.ticks_advanced as u64;
            ticks_since_checkpoint += progress.ticks_advanced as u64;
            ctx.progress(serde_json::json!({ "ticks": ticks_total, "tS": progress.t_s, "done": progress.done }))?;
            if progress.done {
                break;
            }
            if loaded.params.checkpoint_every_ticks > 0
                && ticks_since_checkpoint >= loaded.params.checkpoint_every_ticks
            {
                let checkpoint = simulation
                    .checkpoint()
                    .map_err(|error| engine_error(error))?;
                let bytes = simforge_core::checkpoint::encode(&checkpoint)
                    .map_err(|error| engine_error(error))?;
                ctx.checkpoint(
                    serde_json::json!({ "ticks": ticks_total, "tS": progress.t_s }),
                    |dir| {
                        let path = dir.join(CHECKPOINT_FILE);
                        fs::write(&path, &bytes).map_err(|source| RunnerError::io(path, source))
                    },
                )?;
                ticks_since_checkpoint = 0;
            }
        }

        let mut result: SimResult = simulation
            .into_result()
            .map_err(|error| engine_error(error))?;
        // Quantise before writing: the persisted trace is what gets hashed,
        // compared and read by `SimTrace::from_json_slice`.
        result.trace.quantize();
        let mut artifacts = Vec::with_capacity(3);
        let trace_path = ctx.output_dir.join(
            &ctx.manifest
                .output(OUTPUT_TRACE)
                .expect("checked at admission")
                .relative_path,
        );
        write_gzip_json(&trace_path, &result.trace)?;
        artifacts.push(artifact(ctx, OUTPUT_TRACE, &trace_path)?);
        if let Some(contract) = ctx.manifest.output(OUTPUT_INPUT) {
            let path = ctx.output_dir.join(&contract.relative_path);
            write_json(&path, &result.input)?;
            artifacts.push(artifact(ctx, OUTPUT_INPUT, &path)?);
        }
        if let Some(contract) = ctx.manifest.output(OUTPUT_RESULT) {
            let path = ctx.output_dir.join(&contract.relative_path);
            write_json(
                &path,
                &serde_json::json!({ "issues": result.issues, "arrival": result.arrival, "ticks": ticks_total }),
            )?;
            artifacts.push(artifact(ctx, OUTPUT_RESULT, &path)?);
        }
        Ok(ExecutionOutcome {
            artifacts,
            summary: serde_json::json!({ "ticks": ticks_total, "issues": result.issues.len(), "arrivalSolutions": result.arrival.len() }),
        })
    }
}
