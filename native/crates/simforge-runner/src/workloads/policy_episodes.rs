//! `simforge.policy-episodes/v1`: seeded policy episodes with digest-chained
//! traces through the `simforge_oss_gym` provider (the Python SDK over the
//! PyO3 native runtime; `adapters/gym/simforge_oss_gym/tools/job.py`) under
//! the job protocol in [`crate::provider`].
//!
//! Inputs (by `inputId`):
//! - `episode.spec`  episode spec JSON (the policy runner's `--spec`)
//!
//! Params (`specPath` and `mapsDir` are set by the runner from the input and
//! the maps cache; every other key is required, `null` where optional):
//! `{ session, policy: "scripted"|"trajectory"|"torch", policySeed, seeds: [int|str],
//!    steps, deadlineMs, fallback: "repeat-last"|"zero-control"|"scripted",
//!    execution: "pure-pursuit"|"speed-setpoint", forceMissAt: [int], decisionHz,
//!    checkpointEveryDecisions }`
//!
//! Outputs: `episodes.json` (required) and `trace.<index 4-digit>.jsonl` per
//! seed (declare as a glob contract `trace.*.jsonl`).

use serde::Deserialize;

use crate::engine::{
    AdmissionContext, AdmissionReport, EngineCapabilities, ExecutionContext, ExecutionOutcome,
    JobEngine, ResolvedInput,
};
use crate::error::{Result, RunnerError};
use crate::hash::{canonical_sha256, sha256_hex};
use crate::provider::{self, ProviderJob};
use crate::workloads::compile::maps_cache_root;

pub const WORKLOAD: &str = "simforge.policy-episodes/v1";
pub const MODULE: &str = "simforge_oss_gym";
pub const INPUT_SPEC: &str = "episode.spec";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Params {
    session: u64,
    policy: String,
    policy_seed: i64,
    seeds: Vec<serde_json::Value>,
    steps: u64,
    deadline_ms: Option<f64>,
    fallback: String,
    execution: String,
    force_miss_at: Vec<u64>,
    decision_hz: Option<u32>,
    checkpoint_every_decisions: u64,
}

fn engine_error(reason: impl std::fmt::Display) -> RunnerError {
    RunnerError::Engine {
        workload: WORKLOAD.into(),
        reason: reason.to_string(),
    }
}

fn parse_params(value: &serde_json::Value) -> Result<Params> {
    let params: Params = serde_json::from_value(value.clone())
        .map_err(|error| engine_error(format!("params: {error}")))?;
    if !matches!(params.policy.as_str(), "scripted" | "trajectory" | "torch") {
        return Err(engine_error(format!(
            "params.policy {:?} is not scripted, trajectory or torch",
            params.policy
        )));
    }
    if !matches!(
        params.fallback.as_str(),
        "repeat-last" | "zero-control" | "scripted"
    ) {
        return Err(engine_error(format!(
            "params.fallback {:?} is not repeat-last, zero-control or scripted",
            params.fallback
        )));
    }
    if !matches!(params.execution.as_str(), "pure-pursuit" | "speed-setpoint") {
        return Err(engine_error(format!(
            "params.execution {:?} is not pure-pursuit or speed-setpoint",
            params.execution
        )));
    }
    if params.seeds.is_empty()
        || params
            .seeds
            .iter()
            .any(|seed| !(seed.is_i64() || seed.is_string()))
    {
        return Err(engine_error(
            "params.seeds must be a non-empty list of integers or strings",
        ));
    }
    if params.steps == 0 {
        return Err(engine_error("params.steps must be positive"));
    }
    if params
        .deadline_ms
        .is_some_and(|ms| !(ms > 0.0) || !ms.is_finite())
    {
        return Err(engine_error(
            "params.deadlineMs must be a positive finite number or null",
        ));
    }
    if params.decision_hz == Some(0) {
        return Err(engine_error("params.decisionHz must be positive or null"));
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
    spec: &ResolvedInput,
) -> Result<serde_json::Value> {
    let mut params = ctx_params.clone();
    let object = params
        .as_object_mut()
        .ok_or_else(|| engine_error("params must be an object"))?;
    object.insert("specPath".into(), spec.path.display().to_string().into());
    object.insert(
        "mapsDir".into(),
        maps_cache_root()?.display().to_string().into(),
    );
    Ok(params)
}

pub struct PolicyEpisodesEngine;

impl JobEngine for PolicyEpisodesEngine {
    fn capabilities(&self) -> EngineCapabilities {
        EngineCapabilities {
            workload: WORKLOAD.into(),
            requires_gpu: false,
            supports_continuation: true,
            backend_profiles: vec!["cpu-reference".into()],
        }
    }

    fn admit(&self, ctx: &AdmissionContext<'_>) -> Result<AdmissionReport> {
        let params = parse_params(&ctx.manifest.params)?;
        let spec = required_input(ctx.inputs, INPUT_SPEC)?;
        if ctx.manifest.output_for_path("episodes.json").is_none() {
            return Err(engine_error(
                "manifest must declare an output contract for episodes.json",
            ));
        }
        if ctx.manifest.output_for_path("trace.0000.jsonl").is_none() {
            return Err(engine_error("manifest must declare an output contract matching trace.<index>.jsonl (e.g. glob trace.*.jsonl)"));
        }
        let report = provider::capabilities(ctx.root, MODULE, &["--no-probe"])?;
        let params_hash = canonical_sha256(&ctx.manifest.params)?;
        let report_hash = canonical_sha256(&report)?;
        Ok(AdmissionReport {
            execution_identity: sha256_hex(
                format!(
                    "{WORKLOAD}\n{}\n{params_hash}\n{report_hash}",
                    spec.digest.sha256
                )
                .as_bytes(),
            ),
            summary: serde_json::json!({
                "specSha256": spec.digest.sha256,
                "policy": params.policy,
                "session": params.session,
                "seeds": params.seeds.len(),
                "steps": params.steps,
                "checkpointEveryDecisions": params.checkpoint_every_decisions,
                "native": report.get("native"),
                "version": report.get("version"),
            }),
        })
    }

    fn execute(&self, ctx: &mut ExecutionContext<'_>) -> Result<ExecutionOutcome> {
        parse_params(&ctx.manifest.params)?;
        let spec = required_input(ctx.inputs, INPUT_SPEC)?;
        let params = provider_params(&ctx.manifest.params, spec)?;
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
