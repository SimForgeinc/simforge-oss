//! `variation fork` and `variation transfer`: one executable child of a
//! template, with its lineage.
//!
//! A fork binds an already portable template to a site. A transfer first lifts
//! a map-bound template (its `scene_absolute` roles) into portable roles on its
//! source map, then binds that to a site on the target map. Neither touches the
//! source. Each writes `instance.json`, `trace.json.gz` (canonical trace JSON,
//! gzipped) and `variation.json` (`scenario-variation` v1); a transfer also
//! writes the lifted `portable.template.json`.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Value};
use simforge_compiler::template::RoleKind;
use simforge_compiler::{
    lift_map_bound_template, CompileError, PortableLiftIssue, PortableLiftOptions, ScenarioTemplate,
};
use simforge_core::hash::content_hash_of;

use crate::engine::{canonical_json, simulate, write_trace_gz};
use crate::instance::{compile_at, materialize_options, Compiled};
use crate::json::write_json_file;
use crate::maps::MapRoot;
use crate::paths::resolve;
use crate::sites::find_site;
use crate::template::read_template;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Lineage {
    pub source_template: String,
    pub source_template_digest: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_map_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_topology_digest: Option<String>,
    pub target_map_id: String,
    pub target_site_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_topology_digest: Option<String>,
    pub param_seed: String,
    pub draw_index: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lift_issues: Option<Vec<PortableLiftIssue>>,
}

/// `{kind: "scenario-variation", version: 1, lineage, instance, trace}`.
#[derive(Debug, Clone, Serialize)]
pub struct VariationFile {
    pub kind: &'static str,
    pub version: u32,
    pub lineage: Lineage,
    pub instance: &'static str,
    pub trace: &'static str,
}

#[derive(Debug, Clone, Default)]
pub struct VariationOptions {
    pub seed: Option<String>,
    pub draw: Option<i64>,
}

fn template_digest(template: &ScenarioTemplate) -> Result<String, CompileError> {
    content_hash_of(template).map_err(|e| CompileError::internal(format!("template digest: {e}")))
}

/// The `scene_absolute` role ids of a template, in role order.
pub fn scene_absolute_roles(template: &ScenarioTemplate) -> Vec<String> {
    template
        .roles
        .iter()
        .filter(|role| matches!(role.kind, RoleKind::SceneAbsolute { .. }))
        .map(|role| role.id().to_owned())
        .collect()
}

fn infeasible(compiled: &Compiled, site_id: &str, reason: &str) -> CompileError {
    CompileError::at("variation_infeasible", site_id, reason)
        .detail_entry("issues", json!(compiled.manifest.issues))
        .as_findings()
}

/// Write the variation directory (`writeVariation`).
fn write_variation(
    out: &Path,
    variation: &VariationFile,
    compiled: &Compiled,
    trace: &simforge_core::trace::SimTrace,
) -> Result<(), CompileError> {
    write_json_file(&out.join("instance.json"), &compiled.file(None))?;
    write_trace_gz(&out.join("trace.json.gz"), &canonical_json(trace)?)?;
    write_json_file(&out.join("variation.json"), variation)
}

fn payload(variation: &VariationFile, out: &Path, input_hash: &str) -> Result<Value, CompileError> {
    let mut value = serde_json::to_value(variation)
        .map_err(|e| CompileError::internal(format!("serialise variation: {e}")))?;
    value["out"] = Value::String(out.display().to_string());
    value["feasible"] = Value::Bool(true);
    value["inputHash"] = Value::String(input_hash.to_owned());
    Ok(value)
}

/// `variation fork`: a portable template at one site.
pub fn fork(
    root: &MapRoot,
    file: &Path,
    map_id: &str,
    site_id: &str,
    out: &Path,
    options: &VariationOptions,
) -> Result<Value, CompileError> {
    let template = read_template(file)?;
    let bound = scene_absolute_roles(&template.template);
    if !bound.is_empty() {
        return Err(CompileError::at(
            "variation_source_map_bound",
            "roles",
            "variation fork requires portable roles; map-bound scene_absolute roles need variation transfer",
        )
        .detail_entry("sceneAbsoluteRoles", json!(bound))
        .as_findings());
    }
    let map = root.load(map_id)?;
    let site = find_site(&template.template, map.bundle(), site_id, false)?;
    let compiled = compile_at(
        &template.document,
        map.bundle(),
        &site.site_id,
        &materialize_options(options.seed.clone(), options.draw),
    )?;
    if !compiled.manifest.feasible {
        return Err(infeasible(&compiled, site_id, "target variation did not materialize feasibly"));
    }
    let run = simulate(&compiled.input, &map)?;
    let variation = VariationFile {
        kind: "scenario-variation",
        version: 1,
        lineage: Lineage {
            source_template: resolve(file).display().to_string(),
            source_template_digest: template_digest(&template.template)?,
            source_map_id: None,
            source_topology_digest: None,
            target_map_id: map_id.to_owned(),
            target_site_id: site_id.to_owned(),
            target_topology_digest: None,
            param_seed: compiled.manifest.replay_key.param_seed.clone(),
            draw_index: compiled.manifest.replay_key.draw_index,
            lift_issues: None,
        },
        instance: "instance.json",
        trace: "trace.json.gz",
    };
    let out_dir: PathBuf = resolve(out);
    write_variation(&out_dir, &variation, &compiled, &run.trace)?;
    payload(&variation, &out_dir, &compiled.manifest.input_hash)
}

/// `variation transfer`: lift on the source map, bind on the target map.
#[allow(clippy::too_many_arguments)]
pub fn transfer(
    root: &MapRoot,
    file: &Path,
    source_map_id: &str,
    target_map_id: &str,
    site_id: &str,
    out: &Path,
    options: &VariationOptions,
) -> Result<Value, CompileError> {
    let source = read_template(file)?;
    let source_map = root.load(source_map_id)?;
    let lifted = lift_map_bound_template(
        &source.template,
        source_map.bundle().index(),
        &PortableLiftOptions::default(),
    );
    let Some(portable) = lifted.template else {
        return Err(CompileError::at(
            "variation_lift_failed",
            file.display().to_string(),
            "source scenario could not be lifted into a portable representation",
        )
        .detail_entry("issues", json!(lifted.issues))
        .as_findings());
    };
    let map = root.load(target_map_id)?;
    let site = find_site(&portable, map.bundle(), site_id, false)?;
    let document = serde_json::to_value(&portable)
        .map_err(|e| CompileError::internal(format!("serialise portable template: {e}")))?;
    let compiled = compile_at(
        &document,
        map.bundle(),
        &site.site_id,
        &materialize_options(options.seed.clone(), options.draw),
    )?;
    if !compiled.manifest.feasible {
        return Err(infeasible(&compiled, site_id, "transferred scenario did not materialize feasibly"));
    }
    let run = simulate(&compiled.input, &map)?;
    let variation = VariationFile {
        kind: "scenario-variation",
        version: 1,
        lineage: Lineage {
            source_template: resolve(file).display().to_string(),
            source_template_digest: template_digest(&source.template)?,
            source_map_id: Some(source_map_id.to_owned()),
            source_topology_digest: Some(source_map.digest().to_owned()),
            target_map_id: target_map_id.to_owned(),
            target_site_id: site_id.to_owned(),
            target_topology_digest: Some(map.digest().to_owned()),
            param_seed: compiled.manifest.replay_key.param_seed.clone(),
            draw_index: compiled.manifest.replay_key.draw_index,
            lift_issues: Some(lifted.issues),
        },
        instance: "instance.json",
        trace: "trace.json.gz",
    };
    let out_dir = resolve(out);
    write_json_file(&out_dir.join("portable.template.json"), &portable)?;
    write_variation(&out_dir, &variation, &compiled, &run.trace)?;
    payload(&variation, &out_dir, &compiled.manifest.input_hash)
}
