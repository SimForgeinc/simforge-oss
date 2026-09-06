//! `simforge.render-bundle-nurec/v1`: NuRec reconstructed-world sensor
//! rendering of a scene-state stream through the `simforge_splat` provider
//! (`renderer/splat/python`) under the job protocol in [`crate::provider`].
//! All external prerequisites (CUDA torch, 3DGRUT, Kaolin, pinned `.usdz`
//! packages, scene bundles, catalogs, hood profile) are the provider's
//! probed `capabilities` verdict; the runner pins that report in the
//! identity, which is therefore host-specific by design (3DGRUT root, device).
//!
//! Inputs (by `inputId`):
//! - `scene-state`  scene-state.v1 stream (list or single document)
//!
//! Params (`sceneStatePath` is set by the runner; everything else exactly as
//! the provider requires, absolute paths):
//! `{ scenesRoot, catalog: [..], hoodDir | "none", sourcePackages: [{sha256, path}],
//!    scene, rig, passes: [rgb|depth|id], ticks, checkpointEveryTicks }`
//!
//! Outputs: glob `frames/*/*/tick-*.<png|npy>`, `bundles.jsonl`, `results.json`.

use serde::Deserialize;

use crate::engine::{
    AdmissionContext, AdmissionReport, EngineCapabilities, ExecutionContext, ExecutionOutcome,
    JobEngine,
};
use crate::error::{Result, RunnerError};
use crate::hash::{canonical_sha256, is_sha256_hex, sha256_hex};
use crate::provider::{self, ProviderJob};

pub const WORKLOAD: &str = "simforge.render-bundle-nurec/v1";
pub const MODULE: &str = "simforge_splat";
pub const INPUT_SCENE_STATE: &str = "scene-state";
const PASSES: [&str; 3] = ["rgb", "depth", "id"];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Params {
    scenes_root: String,
    catalog: Vec<String>,
    hood_dir: String,
    source_packages: Vec<SourcePackage>,
    scene: String,
    rig: serde_json::Value,
    passes: Vec<String>,
    ticks: u64,
    checkpoint_every_ticks: u64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SourcePackage {
    sha256: String,
    path: String,
}

fn engine_error(reason: impl std::fmt::Display) -> RunnerError {
    RunnerError::Engine {
        workload: WORKLOAD.into(),
        reason: reason.to_string(),
    }
}

fn is_absolute(path: &str) -> bool {
    std::path::Path::new(path).is_absolute()
}

fn parse_params(value: &serde_json::Value) -> Result<Params> {
    let params: Params = serde_json::from_value(value.clone())
        .map_err(|error| engine_error(format!("params: {error}")))?;
    if !is_absolute(&params.scenes_root) {
        return Err(engine_error("params.scenesRoot must be an absolute path"));
    }
    if params.catalog.is_empty() || params.catalog.iter().any(|root| !is_absolute(root)) {
        return Err(engine_error(
            "params.catalog must list absolute catalog roots",
        ));
    }
    if params.hood_dir != "none" && !is_absolute(&params.hood_dir) {
        return Err(engine_error(
            "params.hoodDir must be an absolute path or \"none\"",
        ));
    }
    for package in &params.source_packages {
        if !is_sha256_hex(&package.sha256) || !is_absolute(&package.path) {
            return Err(engine_error(format!(
                "params.sourcePackages entry {:?} needs a sha256 and an absolute path",
                package.path
            )));
        }
    }
    if params.scene.is_empty() {
        return Err(engine_error("params.scene must name a map id"));
    }
    if !(params.rig.is_array() || params.rig.as_str().is_some_and(is_absolute)) {
        return Err(engine_error(
            "params.rig must be a list of camera documents or an absolute path",
        ));
    }
    if params.passes.is_empty()
        || params
            .passes
            .iter()
            .any(|pass| !PASSES.contains(&pass.as_str()))
    {
        return Err(engine_error(format!(
            "params.passes must be a non-empty subset of {PASSES:?}"
        )));
    }
    if params.ticks == 0 {
        return Err(engine_error("params.ticks must be at least 1"));
    }
    Ok(params)
}

pub struct NurecRenderBundleEngine;

impl JobEngine for NurecRenderBundleEngine {
    fn capabilities(&self) -> EngineCapabilities {
        EngineCapabilities {
            workload: WORKLOAD.into(),
            requires_gpu: true,
            supports_continuation: true,
            backend_profiles: vec!["nurec-3dgrut".into()],
        }
    }

    fn admit(&self, ctx: &AdmissionContext<'_>) -> Result<AdmissionReport> {
        let params = parse_params(&ctx.manifest.params)?;
        let scene_state = ctx
            .input(INPUT_SCENE_STATE)
            .ok_or_else(|| engine_error(format!("missing required input {INPUT_SCENE_STATE}")))?;
        if params.checkpoint_every_ticks > params.ticks {
            return Err(engine_error(
                "params.checkpointEveryTicks exceeds params.ticks",
            ));
        }
        if ctx.manifest.resources.gpus.is_empty() {
            return Err(engine_error(
                "NuRec rendering requires at least one declared gpu in resources",
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
        // Probing form: `--no-probe` reports `available: null`, which cannot admit.
        let report = provider::capabilities(ctx.root, MODULE, &[])?;
        if report.get("available") != Some(&serde_json::Value::Bool(true)) {
            return Err(engine_error(format!(
                "provider reports unavailable: {}",
                report
                    .get("reason")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("no reason given")
            )));
        }
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
                "scene": params.scene,
                "ticks": params.ticks,
                "sourcePackages": params.source_packages.len(),
                "provider": report.get("version"),
                "requires": report.get("requires"),
                "available": report.get("available"),
            }),
        })
    }

    fn execute(&self, ctx: &mut ExecutionContext<'_>) -> Result<ExecutionOutcome> {
        parse_params(&ctx.manifest.params)?;
        let scene_state = ctx
            .input(INPUT_SCENE_STATE)
            .ok_or_else(|| engine_error(format!("missing required input {INPUT_SCENE_STATE}")))?;
        let mut params = ctx.manifest.params.clone();
        params
            .as_object_mut()
            .ok_or_else(|| engine_error("params must be an object"))?
            .insert(
                "sceneStatePath".into(),
                scene_state.path.display().to_string().into(),
            );
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
