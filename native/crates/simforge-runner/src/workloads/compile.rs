//! `simforge.compile/v1`: template x site x draw -> normalized executable
//! `SimScenarioInput` through `simforge_compiler::instantiate` over an
//! installed immutable map bundle. Compilation runs the engine (arrival
//! solving, ambient settling), so it is a real job, not a file transform.
//!
//! Inputs (by `inputId`):
//! - `template`  authoring document JSON (template or map-bound situation)
//!
//! The map is not a single file: it is an installed immutable release under
//! `${SIMFORGE_MAPS_CACHE_ROOT:-${XDG_DATA_HOME:-~/.local/share}/simforge/maps}/dev-assets/<mapId>`
//! selected by `params.mapId`; the bundle's topology and static-collider
//! digests are pinned in the execution identity.
//!
//! Outputs (by `outputId`):
//! - `instance`  `application/json`  normalized `SimScenarioInput` (required)
//! - `manifest`  `application/json`  compiler `InstanceManifest` (replay key, site, params, issues)
//!
//! Params: `{ mapId: string, site?: string ("auto" or a site id; default auto),
//!            drawIndex?: i64=0, seed?: string, ambientSettleSeconds?: f64 }`

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use simforge_compiler::{
    instantiate, MapBundle, MaterializeOptions, MaterializeResult, SiteSelection,
};

use crate::engine::{
    AdmissionContext, AdmissionReport, EngineCapabilities, ExecutionContext, ExecutionOutcome,
    JobEngine, ProducedArtifact, ResolvedInput,
};
use crate::error::{Result, RunnerError};
use crate::hash::{canonical_sha256, hash_file, sha256_hex};

pub const WORKLOAD: &str = "simforge.compile/v1";
pub const INPUT_TEMPLATE: &str = "template";
pub const OUTPUT_INSTANCE: &str = "instance";
pub const OUTPUT_MANIFEST: &str = "manifest";
pub const MAPS_CACHE_ENV: &str = "SIMFORGE_MAPS_CACHE_ROOT";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompileParams {
    pub map_id: String,
    #[serde(default = "default_site")]
    pub site: String,
    #[serde(default)]
    pub draw_index: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seed: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ambient_settle_seconds: Option<f64>,
}

fn default_site() -> String {
    "auto".into()
}

fn engine_error(reason: impl std::fmt::Display) -> RunnerError {
    RunnerError::Engine {
        workload: WORKLOAD.into(),
        reason: reason.to_string(),
    }
}

/// `${SIMFORGE_MAPS_CACHE_ROOT:-${XDG_DATA_HOME:-~/.local/share}/simforge/maps}`,
/// the same resolution the CLI, compiler and Studio use.
pub fn maps_cache_root() -> Result<PathBuf> {
    if let Some(root) = std::env::var_os(MAPS_CACHE_ENV).filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(root));
    }
    let data_home = match std::env::var_os("XDG_DATA_HOME").filter(|value| !value.is_empty()) {
        Some(dir) => PathBuf::from(dir),
        None => {
            let home = std::env::var_os("HOME")
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    engine_error(format!(
                        "cannot locate the maps cache: set {MAPS_CACHE_ENV}, XDG_DATA_HOME or HOME"
                    ))
                })?;
            PathBuf::from(home).join(".local").join("share")
        }
    };
    Ok(data_home.join("simforge").join("maps"))
}

fn is_valid_map_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        && !value.starts_with('.')
}

fn parse_params(value: &serde_json::Value) -> Result<CompileParams> {
    let params: CompileParams = serde_json::from_value(value.clone())
        .map_err(|error| engine_error(format!("params: {error}")))?;
    if !is_valid_map_id(&params.map_id) {
        return Err(engine_error(format!(
            "params.mapId {:?} is not a map id",
            params.map_id
        )));
    }
    if params.site.is_empty() {
        return Err(engine_error("params.site must be \"auto\" or a site id"));
    }
    if params
        .ambient_settle_seconds
        .is_some_and(|seconds| !(seconds >= 0.0) || !seconds.is_finite())
    {
        return Err(engine_error(
            "params.ambientSettleSeconds must be a finite non-negative number",
        ));
    }
    Ok(params)
}

struct Loaded {
    params: CompileParams,
    document: serde_json::Value,
    bundle: MapBundle,
}

fn load(inputs: &[ResolvedInput], params: &serde_json::Value) -> Result<Loaded> {
    let params = parse_params(params)?;
    let input = inputs
        .iter()
        .find(|input| input.input_id == INPUT_TEMPLATE)
        .ok_or_else(|| engine_error(format!("missing required input {INPUT_TEMPLATE}")))?;
    let bytes = fs::read(&input.path).map_err(|source| RunnerError::io(&input.path, source))?;
    let document: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|source| RunnerError::Json {
            path: input.path.clone(),
            source,
        })?;
    let dir = maps_cache_root()?.join("dev-assets").join(&params.map_id);
    let bundle = MapBundle::load_as(&dir, &params.map_id)
        .map_err(|error| engine_error(format!("map {}: {error}", params.map_id)))?;
    Ok(Loaded {
        params,
        document,
        bundle,
    })
}

impl Loaded {
    fn options(&self) -> MaterializeOptions {
        let mut options = MaterializeOptions::default();
        options.draw_index = self.params.draw_index;
        options.seed = self.params.seed.clone();
        if let Some(seconds) = self.params.ambient_settle_seconds {
            options.ambient_settle_seconds = seconds;
        }
        options
    }

    fn site(&self) -> SiteSelection<'_> {
        if self.params.site == "auto" {
            SiteSelection::Auto
        } else {
            SiteSelection::Id(&self.params.site)
        }
    }
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

pub struct CompileEngine;

impl JobEngine for CompileEngine {
    fn capabilities(&self) -> EngineCapabilities {
        EngineCapabilities {
            workload: WORKLOAD.into(),
            requires_gpu: false,
            supports_continuation: false,
            backend_profiles: vec!["cpu-reference".into()],
        }
    }

    fn admit(&self, ctx: &AdmissionContext<'_>) -> Result<AdmissionReport> {
        let loaded = load(ctx.inputs, &ctx.manifest.params)?;
        if ctx.manifest.output(OUTPUT_INSTANCE).is_none() {
            return Err(engine_error(format!(
                "manifest must declare output {OUTPUT_INSTANCE}"
            )));
        }
        let template = ctx
            .inputs
            .iter()
            .find(|input| input.input_id == INPUT_TEMPLATE)
            .expect("checked in load");
        let params_hash = canonical_sha256(&loaded.params)?;
        let colliders = loaded.bundle.static_collider_diagnostics();
        let execution_identity = sha256_hex(
            format!(
                "{WORKLOAD}\n{}\n{}\n{}\n{}\n{params_hash}",
                template.digest.sha256,
                loaded.bundle.map_id(),
                loaded.bundle.topology_digest(),
                colliders.digest
            )
            .as_bytes(),
        );
        Ok(AdmissionReport {
            execution_identity,
            summary: serde_json::json!({
                "mapId": loaded.bundle.map_id(),
                "mapDir": loaded.bundle.dir(),
                "topologyDigest": loaded.bundle.topology_digest(),
                "staticColliders": colliders,
                "site": loaded.params.site,
                "drawIndex": loaded.params.draw_index,
            }),
        })
    }

    fn execute(&self, ctx: &mut ExecutionContext<'_>) -> Result<ExecutionOutcome> {
        let loaded = load(ctx.inputs, &ctx.manifest.params)?;
        ctx.cancel.check()?;
        let result: MaterializeResult = instantiate(
            &loaded.document,
            &loaded.bundle,
            loaded.site(),
            &loaded.options(),
        )
        .map_err(engine_error)?;
        ctx.cancel.check()?;

        let mut artifacts = Vec::with_capacity(2);
        let instance_path = ctx.output_dir.join(
            &ctx.manifest
                .output(OUTPUT_INSTANCE)
                .expect("checked at admission")
                .relative_path,
        );
        write_json(&instance_path, &result.input)?;
        artifacts.push(artifact(ctx, OUTPUT_INSTANCE, &instance_path)?);
        if let Some(contract) = ctx.manifest.output(OUTPUT_MANIFEST) {
            let path = ctx.output_dir.join(&contract.relative_path);
            write_json(&path, &result.manifest)?;
            artifacts.push(artifact(ctx, OUTPUT_MANIFEST, &path)?);
        }
        let manifest =
            serde_json::to_value(&result.manifest).map_err(|source| RunnerError::Json {
                path: instance_path,
                source,
            })?;
        Ok(ExecutionOutcome {
            artifacts,
            summary: serde_json::json!({
                "instanceId": manifest.get("instanceId"),
                "inputHash": manifest.get("inputHash"),
                "feasible": manifest.get("feasible"),
                "site": manifest.get("site").and_then(|site| site.get("siteId")),
                "issues": manifest.get("issues").and_then(|issues| issues.as_array()).map_or(0, Vec::len),
                "observations": result.observations.len(),
            }),
        })
    }
}
