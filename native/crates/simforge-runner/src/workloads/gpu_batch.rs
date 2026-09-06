//! `simforge.gpu-batch-rollout/v1`: N-world device rollout of an admitted
//! scenario on the `roadway-dynamic-gpu-v1` profile (`adapters/gpu`,
//! Warp/CUDA), executed by the `simforge_oss_gpu` provider under the job
//! protocol in [`crate::provider`]. Admission of the document happens in the
//! provider (every unsupported feature is listed, nothing approximated); the
//! runner pins inputs, params and the capabilities report in the identity.
//!
//! Inputs (by `inputId`):
//! - `scenario.input`  canonical `SimScenarioInput` JSON
//! - `map.topology`    decoded topology index JSON, plain or gzip
//! - `policy.actions`  optional JSON array of `EnvAction` per decision (cycled)
//!
//! Params (`inputPath`/`topologyPath` and the actions path are set by the
//! runner from the materialized inputs; do not declare them):
//! `{ numWorlds, decisions, episode?, actions?: "hold", device?: "cuda:0",
//!    seeds?: [numWorlds ints], checkpointEveryDecisions?, leaseSlots? }`
//!
//! Outputs: `rollout.json` (required) and `decisions.jsonl.gz`.

use serde::Deserialize;

use crate::engine::{
    AdmissionContext, AdmissionReport, EngineCapabilities, ExecutionContext, ExecutionOutcome,
    JobEngine, ResolvedInput,
};
use crate::error::{Result, RunnerError};
use crate::hash::{canonical_sha256, sha256_hex};
use crate::provider::{self, ProviderJob};

pub const WORKLOAD: &str = "simforge.gpu-batch-rollout/v1";
pub const MODULE: &str = "simforge_oss_gpu";
pub const INPUT_SCENARIO: &str = "scenario.input";
pub const INPUT_TOPOLOGY: &str = "map.topology";
pub const INPUT_ACTIONS: &str = "policy.actions";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Params {
    num_worlds: u64,
    decisions: u64,
    #[serde(default)]
    episode: Option<serde_json::Value>,
    #[serde(default)]
    actions: Option<String>,
    #[serde(default)]
    device: Option<String>,
    #[serde(default)]
    seeds: Option<Vec<i64>>,
    #[serde(default)]
    checkpoint_every_decisions: Option<u64>,
    #[serde(default)]
    lease_slots: Option<u64>,
}

fn engine_error(reason: impl std::fmt::Display) -> RunnerError {
    RunnerError::Engine {
        workload: WORKLOAD.into(),
        reason: reason.to_string(),
    }
}

fn parse_params(value: &serde_json::Value, has_actions_input: bool) -> Result<Params> {
    let params: Params = serde_json::from_value(value.clone())
        .map_err(|error| engine_error(format!("params: {error}")))?;
    if params.num_worlds == 0 || params.decisions == 0 {
        return Err(engine_error(
            "params.numWorlds and params.decisions must be positive",
        ));
    }
    if let Some(seeds) = &params.seeds {
        if seeds.len() as u64 != params.num_worlds {
            return Err(engine_error(format!(
                "params.seeds lists {} seeds for {} worlds",
                seeds.len(),
                params.num_worlds
            )));
        }
    }
    match (params.actions.as_deref(), has_actions_input) {
        (Some("hold") | None, false) => {}
        (None, true) => {}
        (Some("hold"), true) => return Err(engine_error(format!("{INPUT_ACTIONS} given but params.actions is \"hold\""))),
        (Some(other), _) => return Err(engine_error(format!("params.actions must be \"hold\" or omitted (recorded actions come from input {INPUT_ACTIONS}), got {other:?}"))),
    }
    if params
        .episode
        .as_ref()
        .is_some_and(|episode| !episode.is_object())
    {
        return Err(engine_error(
            "params.episode must be an EpisodeConfig object",
        ));
    }
    if params.lease_slots == Some(0) {
        return Err(engine_error(
            "params.leaseSlots must be positive when present",
        ));
    }
    if params
        .device
        .as_deref()
        .is_some_and(|device| device.is_empty())
    {
        return Err(engine_error(
            "params.device must be a non-empty device string such as cuda:0",
        ));
    }
    Ok(params)
}

fn required_input<'a>(inputs: &'a [ResolvedInput], input_id: &str) -> Result<&'a ResolvedInput> {
    inputs
        .iter()
        .find(|input| input.input_id == input_id)
        .ok_or_else(|| engine_error(format!("missing required input {input_id}")))
}

fn provider_params(
    ctx_params: &serde_json::Value,
    inputs: &[ResolvedInput],
) -> Result<serde_json::Value> {
    let scenario = required_input(inputs, INPUT_SCENARIO)?;
    let topology = required_input(inputs, INPUT_TOPOLOGY)?;
    let mut params = ctx_params.clone();
    let object = params
        .as_object_mut()
        .ok_or_else(|| engine_error("params must be an object"))?;
    object.insert(
        "inputPath".into(),
        scenario.path.display().to_string().into(),
    );
    object.insert(
        "topologyPath".into(),
        topology.path.display().to_string().into(),
    );
    match inputs.iter().find(|input| input.input_id == INPUT_ACTIONS) {
        Some(actions) => object.insert("actions".into(), actions.path.display().to_string().into()),
        None => object.insert("actions".into(), "hold".into()),
    };
    Ok(params)
}

pub struct GpuBatchEngine;

impl JobEngine for GpuBatchEngine {
    fn capabilities(&self) -> EngineCapabilities {
        EngineCapabilities {
            workload: WORKLOAD.into(),
            requires_gpu: true,
            supports_continuation: true,
            backend_profiles: vec!["roadway-dynamic-gpu-v1".into()],
        }
    }

    fn admit(&self, ctx: &AdmissionContext<'_>) -> Result<AdmissionReport> {
        let has_actions = ctx.input(INPUT_ACTIONS).is_some();
        let params = parse_params(&ctx.manifest.params, has_actions)?;
        let scenario = required_input(ctx.inputs, INPUT_SCENARIO)?;
        let topology = required_input(ctx.inputs, INPUT_TOPOLOGY)?;
        if ctx.manifest.resources.gpus.is_empty() {
            return Err(engine_error(
                "device batches require at least one declared gpu in resources",
            ));
        }
        if ctx.manifest.output_for_path("rollout.json").is_none() {
            return Err(engine_error(
                "manifest must declare an output contract for rollout.json",
            ));
        }
        let report = provider::capabilities(ctx.root, MODULE, &["--no-probe"])?;
        let actions_hash = ctx
            .input(INPUT_ACTIONS)
            .map(|input| input.digest.sha256.clone())
            .unwrap_or_else(|| "hold".into());
        let params_hash = canonical_sha256(&ctx.manifest.params)?;
        let report_hash = canonical_sha256(&report)?;
        Ok(AdmissionReport {
            execution_identity: sha256_hex(
                format!(
                    "{WORKLOAD}\n{}\n{}\n{actions_hash}\n{params_hash}\n{report_hash}",
                    scenario.digest.sha256, topology.digest.sha256
                )
                .as_bytes(),
            ),
            summary: serde_json::json!({
                "numWorlds": params.num_worlds,
                "decisions": params.decisions,
                "device": params.device,
                "checkpointEveryDecisions": params.checkpoint_every_decisions,
                "profile": report.get("profile").or_else(|| report.get("profileId")),
                "numerics": report.get("numerics"),
                "reproducibility": report.get("reproducibility"),
            }),
        })
    }

    fn execute(&self, ctx: &mut ExecutionContext<'_>) -> Result<ExecutionOutcome> {
        parse_params(&ctx.manifest.params, ctx.input(INPUT_ACTIONS).is_some())?;
        let params = provider_params(&ctx.manifest.params, ctx.inputs)?;
        let visible: Vec<String> = ctx
            .grant
            .gpus
            .iter()
            .map(|gpu| gpu.index.to_string())
            .collect();
        let env = [("CUDA_VISIBLE_DEVICES", visible.join(","))];
        provider::run(
            &ProviderJob {
                root: ctx.root,
                module: MODULE,
                params: &params,
                env: &env,
            },
            ctx,
        )
    }
}
