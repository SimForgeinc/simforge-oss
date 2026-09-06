//! `simforge.articulated-mujoco/v1`: the separately versioned articulated
//! physical profile (`adapters/physics`, MuJoCo CPU / MuJoCo Warp), executed
//! by the `simforge_oss_physics` provider under the job protocol in
//! [`crate::provider`].
//!
//! Params (forwarded verbatim after admission checks):
//! `{backend: "mujoco-cpu"|"mujoco-warp", seeds: [int..], start: "approach"|"ramp"|"plateau",
//!   decisions: int, torqueNm: number, checkpointEveryDecisions: int}`.
//! Outputs: the provider lists `episodes.json` and `scene-state.<seed>.json`;
//! each must match a declared output contract by `relativePath`.

use serde::Deserialize;

use crate::engine::{
    AdmissionContext, AdmissionReport, EngineCapabilities, ExecutionContext, ExecutionOutcome,
    JobEngine,
};
use crate::error::{Result, RunnerError};
use crate::hash::{canonical_sha256, sha256_hex};
use crate::provider::{self, ProviderJob};

pub const WORKLOAD: &str = "simforge.articulated-mujoco/v1";
pub const MODULE: &str = "simforge_oss_physics";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Params {
    backend: String,
    seeds: Vec<i64>,
    start: String,
    decisions: u64,
    torque_nm: f64,
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
    if !matches!(params.backend.as_str(), "mujoco-cpu" | "mujoco-warp") {
        return Err(engine_error(format!(
            "params.backend {:?} is not mujoco-cpu or mujoco-warp",
            params.backend
        )));
    }
    if params.seeds.is_empty() {
        return Err(engine_error("params.seeds must list at least one seed"));
    }
    if !matches!(params.start.as_str(), "approach" | "ramp" | "plateau") {
        return Err(engine_error(format!(
            "params.start {:?} is not approach, ramp or plateau",
            params.start
        )));
    }
    if params.decisions == 0 {
        return Err(engine_error("params.decisions must be positive"));
    }
    if !params.torque_nm.is_finite() {
        return Err(engine_error("params.torqueNm must be finite"));
    }
    Ok(params)
}

pub struct ArticulatedEngine;

impl JobEngine for ArticulatedEngine {
    fn capabilities(&self) -> EngineCapabilities {
        EngineCapabilities {
            workload: WORKLOAD.into(),
            requires_gpu: false,
            supports_continuation: true,
            backend_profiles: vec!["mujoco-cpu".into(), "mujoco-warp".into()],
        }
    }

    fn admit(&self, ctx: &AdmissionContext<'_>) -> Result<AdmissionReport> {
        let params = parse_params(&ctx.manifest.params)?;
        if params.backend == "mujoco-warp" && ctx.manifest.resources.gpus.is_empty() {
            return Err(engine_error(
                "backend mujoco-warp requires at least one declared gpu in resources",
            ));
        }
        if !ctx
            .manifest
            .outputs
            .iter()
            .any(|output| output.relative_path == "episodes.json")
        {
            return Err(engine_error(
                "manifest must declare an output with relativePath episodes.json",
            ));
        }
        let flags: &[&str] = if params.backend == "mujoco-warp" {
            &["--no-probe", "--warp"]
        } else {
            &["--no-probe"]
        };
        let report = provider::capabilities(ctx.root, MODULE, flags)?;
        let key = if params.backend == "mujoco-warp" {
            "warp"
        } else {
            "cpu"
        };
        let backend_report = report
            .get(key)
            .ok_or_else(|| engine_error(format!("capabilities report has no {key} section")))?;
        let params_hash = canonical_sha256(&ctx.manifest.params)?;
        let report_hash = canonical_sha256(backend_report)?;
        Ok(AdmissionReport {
            execution_identity: sha256_hex(
                format!("{WORKLOAD}\n{params_hash}\n{report_hash}").as_bytes(),
            ),
            summary: serde_json::json!({
                "backend": params.backend,
                "seeds": params.seeds.len(),
                "decisions": params.decisions,
                "checkpointEveryDecisions": params.checkpoint_every_decisions,
                "workload": backend_report.get("workload"),
                "mujocoVersion": backend_report.get("mujoco_version"),
                "reproducibility": backend_report.get("reproducibility"),
            }),
        })
    }

    fn execute(&self, ctx: &mut ExecutionContext<'_>) -> Result<ExecutionOutcome> {
        parse_params(&ctx.manifest.params)?;
        let mut env = Vec::new();
        if !ctx.grant.gpus.is_empty() {
            let visible: Vec<String> = ctx
                .grant
                .gpus
                .iter()
                .map(|gpu| gpu.index.to_string())
                .collect();
            env.push(("CUDA_VISIBLE_DEVICES", visible.join(",")));
        }
        let params = ctx.manifest.params.clone();
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
