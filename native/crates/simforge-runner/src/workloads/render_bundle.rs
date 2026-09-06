//! `simforge.render-bundle/v1`: resident native (Bevy) sensor rendering of a
//! scene-state stream into a sensor bundle, executed by the `simforge_native`
//! provider (`renderer/service/python`) under the job protocol in
//! [`crate::provider`]. The provider owns frame identity, passes and the
//! GPU-interop path; the runner owns durability and artifact truth.
//!
//! Inputs (by `inputId`):
//! - `scene-state`  scene-state.v1 stream (single document or array)
//!
//! Params (forwarded to the provider with `sceneStatePath` resolved to the
//! materialized input):
//! `{ scene: SceneSpec {glbs[], profile, lighting?, nearM, farM, warmupFrames},
//!    rig: {cameras[], lidars?, radars?}, passes: ["rgb","id","depth","semantic"],
//!    ticks: {start, count} | null, shmSizeBytes?, checkpointEveryTicks? }`
//!
//! Outputs: `frames/<sensorId>/<pass>/tick-<06d>.<ext>` (declare as a glob
//! contract), `bundles.jsonl`, `results.json`.

use serde::Deserialize;

use crate::engine::{
    AdmissionContext, AdmissionReport, EngineCapabilities, ExecutionContext, ExecutionOutcome,
    JobEngine,
};
use crate::error::{Result, RunnerError};
use crate::hash::{canonical_sha256, sha256_hex};
use crate::provider::{self, ProviderJob};

pub const WORKLOAD: &str = "simforge.render-bundle/v1";
pub const MODULE: &str = "simforge_native";
pub const INPUT_SCENE_STATE: &str = "scene-state";
const PASSES: [&str; 4] = ["rgb", "id", "depth", "semantic"];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Params {
    scene: serde_json::Value,
    rig: serde_json::Value,
    passes: Vec<String>,
    #[serde(default)]
    ticks: Option<serde_json::Value>,
    #[serde(default)]
    shm_size_bytes: Option<u64>,
    #[serde(default)]
    checkpoint_every_ticks: Option<u64>,
    #[serde(default)]
    scene_state_path: Option<String>,
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
    if params.scene_state_path.is_some() {
        return Err(engine_error("params.sceneStatePath is set by the runner from the scene-state input; do not declare it"));
    }
    if !params.scene.is_object() || !params.rig.is_object() {
        return Err(engine_error("params.scene and params.rig must be objects"));
    }
    if params.passes.is_empty() {
        return Err(engine_error("params.passes must list at least one pass"));
    }
    if let Some(pass) = params
        .passes
        .iter()
        .find(|pass| !PASSES.contains(&pass.as_str()))
    {
        return Err(engine_error(format!(
            "params.passes contains unsupported pass {pass:?}; supported: {PASSES:?}"
        )));
    }
    if params.shm_size_bytes == Some(0) || params.checkpoint_every_ticks == Some(0) {
        return Err(engine_error(
            "shmSizeBytes and checkpointEveryTicks must be positive when present",
        ));
    }
    if params
        .ticks
        .as_ref()
        .is_some_and(|ticks| !ticks.is_null() && !ticks.is_object())
    {
        return Err(engine_error("params.ticks must be {start, count} or null"));
    }
    Ok(params)
}

fn provider_params(
    ctx_params: &serde_json::Value,
    scene_state_path: &std::path::Path,
) -> serde_json::Value {
    let mut params = ctx_params.clone();
    if let Some(object) = params.as_object_mut() {
        object.insert(
            "sceneStatePath".into(),
            serde_json::Value::String(scene_state_path.display().to_string()),
        );
    }
    params
}

pub struct RenderBundleEngine;

impl JobEngine for RenderBundleEngine {
    fn capabilities(&self) -> EngineCapabilities {
        EngineCapabilities {
            workload: WORKLOAD.into(),
            requires_gpu: true,
            supports_continuation: true,
            backend_profiles: vec!["bevy-host".into(), "bevy-gpu-interop".into()],
        }
    }

    fn admit(&self, ctx: &AdmissionContext<'_>) -> Result<AdmissionReport> {
        parse_params(&ctx.manifest.params)?;
        let scene_state = ctx
            .input(INPUT_SCENE_STATE)
            .ok_or_else(|| engine_error(format!("missing required input {INPUT_SCENE_STATE}")))?;
        if ctx.manifest.resources.gpus.is_empty() {
            return Err(engine_error(
                "resident rendering requires at least one declared gpu in resources",
            ));
        }
        for required in ["bundles.jsonl", "results.json"] {
            if ctx.manifest.output_for_path(required).is_none() {
                return Err(engine_error(format!(
                    "manifest must declare an output contract for {required}"
                )));
            }
        }
        if !ctx
            .manifest
            .outputs
            .iter()
            .any(|output| output.glob && output.relative_path.starts_with("frames/"))
        {
            return Err(engine_error("manifest must declare a glob output contract under frames/ (e.g. frames/*/*/tick-*.png)"));
        }
        let report = provider::capabilities(ctx.root, MODULE, &["--no-probe"])?;
        let params_hash = canonical_sha256(&ctx.manifest.params)?;
        let report_hash = canonical_sha256(&report)?;
        Ok(AdmissionReport {
            execution_identity: sha256_hex(
                format!(
                    "{WORKLOAD}\n{}\n{params_hash}\n{report_hash}",
                    scene_state.digest.sha256
                )
                .as_bytes(),
            ),
            summary: serde_json::json!({
                "sceneStateSha256": scene_state.digest.sha256,
                "protocol": report.get("protocol"),
                "gpuInterop": report.get("gpuInterop"),
                "library": report.get("library"),
            }),
        })
    }

    fn execute(&self, ctx: &mut ExecutionContext<'_>) -> Result<ExecutionOutcome> {
        parse_params(&ctx.manifest.params)?;
        let scene_state = ctx
            .input(INPUT_SCENE_STATE)
            .ok_or_else(|| engine_error(format!("missing required input {INPUT_SCENE_STATE}")))?;
        let params = provider_params(&ctx.manifest.params, &scene_state.path);
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
