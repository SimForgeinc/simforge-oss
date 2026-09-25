//! `instantiate`: template x site x draw -> one concrete instance file.
//!
//! The instance carries its own replay key (template digest, map digests,
//! site, seed, draw, solver and matcher versions), so nothing downstream is
//! ever told separately which inputs produced it.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;
use simforge_compiler::materialize::{
    instantiate, InstanceManifest, MaterializeOptions, SiteSelection,
};
use simforge_compiler::{CompileError, MaterializeResult};
use simforge_core::types::SimScenarioInput;

use crate::json::write_json_file;
use crate::maps::MapRoot;
use crate::sites::find_site;
use crate::template::read_template;

/// `{kind: "scenario-instance", version: 1, catalogSlot?, manifest, input}`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceFile<'a> {
    pub kind: &'static str,
    pub version: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub catalog_slot: Option<&'a Value>,
    pub manifest: &'a InstanceManifest,
    pub input: &'a SimScenarioInput,
}

/// A compiled cell: the normalised engine input and its manifest.
#[derive(Debug, Clone)]
pub struct Compiled {
    pub input: SimScenarioInput,
    pub manifest: InstanceManifest,
}

impl Compiled {
    pub fn from_result(result: MaterializeResult) -> Self {
        Self {
            // The engine's canonical input form, exactly as every host holds it.
            input: result.input.normalized(),
            manifest: result.manifest,
        }
    }

    pub fn file<'a>(&'a self, catalog_slot: Option<&'a Value>) -> InstanceFile<'a> {
        InstanceFile {
            kind: "scenario-instance",
            version: 1,
            catalog_slot,
            manifest: &self.manifest,
            input: &self.input,
        }
    }
}

/// Compile `document` at `site_id` (already resolved) with `options`.
pub fn compile_at(
    document: &Value,
    bundle: &simforge_compiler::MapBundle,
    site_id: &str,
    options: &MaterializeOptions,
) -> Result<Compiled, CompileError> {
    instantiate(document, bundle, SiteSelection::Id(site_id), options).map(Compiled::from_result)
}

#[derive(Debug, Clone, Default)]
pub struct InstantiateOptions {
    pub seed: Option<String>,
    pub draw: Option<i64>,
    pub out: Option<PathBuf>,
}

pub fn materialize_options(seed: Option<String>, draw: Option<i64>) -> MaterializeOptions {
    let mut options = MaterializeOptions::new();
    if let Some(draw) = draw {
        options.draw_index = draw;
    }
    options.seed = seed;
    options
}

/// The `instantiate` document and whether the instance is feasible.
pub fn run_instantiate(
    root: &MapRoot,
    file: &Path,
    map_id: &str,
    site_id: &str,
    options: &InstantiateOptions,
) -> Result<(Value, bool), CompileError> {
    let template = read_template(file)?;
    let map = root.load(map_id)?;
    let site = find_site(&template.template, map.bundle(), site_id, false)?;
    let compiled = compile_at(
        &template.document,
        map.bundle(),
        &site.site_id,
        &materialize_options(options.seed.clone(), options.draw),
    )?;
    let instance = compiled.file(None);
    let out = match &options.out {
        Some(out) => {
            write_json_file(out, &instance)?;
            Some(absolute(out))
        }
        None => None,
    };
    let mut payload = serde_json::to_value(&instance)
        .map_err(|e| CompileError::internal(format!("serialise instance: {e}")))?;
    payload["out"] = out.map_or(Value::Null, |p| Value::String(p.display().to_string()));
    Ok((payload, compiled.manifest.feasible))
}

pub use crate::paths::resolve as absolute;
