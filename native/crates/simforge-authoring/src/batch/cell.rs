//! One batch cell, start to finish: materialise -> simulate -> evaluate.
//!
//! `batch` and `catalog batch` both run cells through [`run_cell`], inline or
//! on a worker thread, so a cell's files are the same whichever path ran it.
//! A cell never fails its batch: a failure is recorded as a cell whose
//! `status` is `error`, with the structured error that stopped it.
//!
//! Files, per cell (`cell_paths`): `<out>/<mapId>/<siteId>/draw-NNN.instance.json`,
//! `.trace.json.gz` (the quantised trace) and `.result.json` ([`CellResult`]).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use simforge_compiler::expr::ExprScope;
use simforge_compiler::invariants::{
    check_invariants, InvariantContext, InvariantResidualReport, InvariantStatus,
};
use simforge_compiler::materialize::{CatalogVariantApplication, InstanceManifest};
use simforge_compiler::{AmbientTrafficProfile, AmbientTrafficProvenance, CompileError};
use simforge_core::evaluation::evaluate_trace;
use simforge_core::trace::SimTrace;
use simforge_core::types::{ActorKind, SimScenarioInput};

use crate::engine::{quantized_json, reparse_trace, simulate, write_trace_gz};
use crate::evaluate::{code_str, criticality_band, filters_for, verdict_str, FilterMode};
use crate::evidence::{verify_evidence_hashes, EvidenceHashReport, TraceView};
use crate::instance::compile_at;
use crate::json::write_json_file;
use crate::jsvalue::JsValue;
use crate::maps::MapRoot;
use crate::metrics::{metrics_summary, MetricsSummary};
use crate::paths;
use crate::sites::find_site;
use crate::template::TemplateFile;

/// Ambient vehicles within this distance of the metric subject at `t = 0`
/// count as traffic the subject can see.
pub const AMBIENT_NEAR_SUBJECT_RADIUS_M: f64 = 60.0;
const AMBIENT_STANDSTILL_MPS: f64 = 0.5;

/// `CatalogArtifactProvenance.variant`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogVariant {
    pub id: String,
    pub title: String,
    pub weather: String,
    pub time_of_day: String,
    pub traffic: String,
    pub visibility: String,
}

/// `CatalogArtifactProvenance.provenance`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogProvenance {
    pub namespace: String,
    pub generator_version: String,
    pub map_catalog_revision: String,
    pub matcher_index_digest: String,
    pub engine_graph_digest: String,
    pub location_catalog_digest: String,
    pub taxonomy_digest: String,
    pub template_digest: String,
}

/// The catalog slot a catalog cell carries in its instance, trace header and
/// result (`CatalogArtifactProvenance`), in its field order.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogSlot {
    pub identity: String,
    pub seed: String,
    pub attempt_seed: String,
    pub design_digest: String,
    pub map_id: String,
    pub incident_id: String,
    pub selected_location_id: String,
    pub selected_matcher_site_id: String,
    pub variant: CatalogVariant,
    pub provenance: CatalogProvenance,
    pub template_id: String,
}

/// A catalog cell's eligibility rule for collisions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CollisionPolicy {
    Reject,
    Allow,
}

/// Where a cell's three files go.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CellPaths {
    pub instance: String,
    pub trace: String,
    pub result: String,
}

/// `cellPaths(outDir, coords)`: `<out>/<mapId>/<siteId>/draw-NNN.*` (the path
/// as `path.join` builds it: normalised, relative when `out_dir` is).
pub fn cell_paths(out_dir: &str, map_id: &str, site_id: &str, draw_index: i64) -> CellPaths {
    let dir = paths::join(&[out_dir, map_id, site_id]);
    let stem = format!("draw-{draw_index:0>3}");
    CellPaths {
        instance: paths::join(&[&dir, &format!("{stem}.instance.json")]),
        trace: paths::join(&[&dir, &format!("{stem}.trace.json.gz")]),
        result: paths::join(&[&dir, &format!("{stem}.result.json")]),
    }
}

/// One cell to run.
#[derive(Debug, Clone)]
pub struct CellOptions {
    pub map_id: String,
    pub site_id: String,
    pub draw_index: i64,
    pub out_dir: String,
    pub write_trace: bool,
    pub filter: FilterMode,
    pub trivial_ttc_s: Option<f64>,
    /// Overrides the coordinate-derived seed (catalog reservations).
    pub seed: Option<String>,
    /// Reserved catalog paths instead of the template-batch layout.
    pub artifact_paths: Option<CellPaths>,
    /// Stable external identity (a catalog slot); default `<siteId>#<draw>`.
    pub instance_id: Option<String>,
    /// Provenance closure carried by the instance, the trace and the result.
    pub catalog_slot: Option<CatalogSlot>,
    /// Resolve the persisted site id under the catalog's exact-site policy.
    pub exact_catalog_site_resolution: bool,
    /// Catalog eligibility rule; a template batch leaves it unset (`allow`).
    pub collision_policy: Option<CollisionPolicy>,
    /// Generated background road users.
    pub ambient: Option<AmbientTrafficProfile>,
    /// Seconds of ambient-only warm-up before `t = 0`.
    pub ambient_settle_seconds: Option<f64>,
}

impl CellOptions {
    pub fn new(map_id: &str, site_id: &str, draw_index: i64, out_dir: &str) -> Self {
        Self {
            map_id: map_id.to_owned(),
            site_id: site_id.to_owned(),
            draw_index,
            out_dir: out_dir.to_owned(),
            write_trace: true,
            filter: FilterMode::Critical,
            trivial_ttc_s: None,
            seed: None,
            artifact_paths: None,
            instance_id: None,
            catalog_slot: None,
            exact_catalog_site_resolution: false,
            collision_policy: None,
            ambient: None,
            ambient_settle_seconds: None,
        }
    }

    pub fn paths(&self) -> CellPaths {
        self.artifact_paths.clone().unwrap_or_else(|| {
            cell_paths(&self.out_dir, &self.map_id, &self.site_id, self.draw_index)
        })
    }

    fn policy(&self) -> CollisionPolicy {
        self.collision_policy.unwrap_or(CollisionPolicy::Allow)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CellFinding {
    pub code: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CellIssue {
    pub code: Value,
    pub severity: Value,
    pub reason: String,
}

/// The structured error that stopped a cell (`{code, path?, reason, detail?}`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CellError {
    pub code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<Value>,
}

impl From<&CompileError> for CellError {
    fn from(e: &CompileError) -> Self {
        Self {
            code: e.code.clone(),
            path: e.path.clone(),
            reason: e.reason.clone(),
            detail: e.detail.clone().map(Value::Object),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Eligibility {
    pub collision_policy: CollisionPolicy,
    pub eligible: bool,
    pub hard_failure_codes: Vec<String>,
}

/// Background traffic actually on the road in this cell, read from the trace.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AmbientCellReport {
    pub actor_count: usize,
    pub profile_hash: String,
    pub eligible_lane_km: f64,
    pub rejected_spawn_count: u32,
    pub authored_corridor_rejects: u32,
    /// Ambient vehicles inside 60 m of the metric subject at `t = 0`.
    pub near_subject_at_t0: u32,
    /// Ambient road users at a standstill (< 0.5 m/s) at `t = 0`.
    pub stopped_at_t0: u32,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactHashes {
    pub instance_sha256: Option<String>,
    pub trace_sha256: Option<String>,
}

/// `draw-NNN.result.json`, field for field (`CellResult`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CellResult {
    pub map_id: String,
    pub site_id: String,
    pub draw_index: i64,
    pub instance_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub catalog_slot: Option<CatalogSlot>,
    /// `ok` or `error`.
    pub status: &'static str,
    pub feasible: bool,
    pub verdict: Option<&'static str>,
    pub band: Option<String>,
    pub tags: Vec<String>,
    pub findings: Vec<CellFinding>,
    pub invariants: Vec<InvariantResidualReport>,
    pub evidence: EvidenceHashReport,
    pub metrics: Option<MetricsSummary>,
    pub site_score: f64,
    pub site_verdict: Value,
    pub param_seed: String,
    pub params: BTreeMap<String, f64>,
    pub input_hash: Option<String>,
    pub trace_digest: Option<String>,
    pub instance_file: Option<String>,
    pub trace_file: Option<String>,
    pub issues: Vec<CellIssue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<CellError>,
    pub eligibility: Eligibility,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ambient: Option<AmbientCellReport>,
    /// Set by `catalog batch` when it seals a promoted attempt.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifact_hashes: Option<ArtifactHashes>,
}

impl CellResult {
    /// The record of a cell that failed before it produced evidence.
    pub fn failed(options: &CellOptions, error: CellError, param_seed: &str) -> Self {
        let code = error.code.clone();
        Self {
            map_id: options.map_id.clone(),
            site_id: options.site_id.clone(),
            draw_index: options.draw_index,
            instance_id: instance_id(options),
            catalog_slot: options.catalog_slot.clone(),
            status: "error",
            feasible: false,
            verdict: None,
            band: Some("infeasible".to_owned()),
            tags: Vec::new(),
            findings: Vec::new(),
            invariants: Vec::new(),
            evidence: EvidenceHashReport::empty(&options.map_id),
            metrics: None,
            site_score: 0.0,
            site_verdict: Value::String("infeasible".to_owned()),
            param_seed: param_seed.to_owned(),
            params: BTreeMap::new(),
            input_hash: None,
            trace_digest: None,
            instance_file: None,
            trace_file: None,
            issues: Vec::new(),
            error: Some(error),
            eligibility: Eligibility {
                collision_policy: options.policy(),
                eligible: false,
                hard_failure_codes: vec![code],
            },
            ambient: None,
            artifact_hashes: None,
        }
    }
}

fn instance_id(options: &CellOptions) -> String {
    options
        .instance_id
        .clone()
        .unwrap_or_else(|| format!("{}#{}", options.site_id, options.draw_index))
}

/// The instance file of a cell (`scenario-instance` v1, catalog slot typed).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CellInstance<'a> {
    kind: &'static str,
    version: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    catalog_slot: Option<&'a CatalogSlot>,
    manifest: &'a InstanceManifest,
    input: &'a SimScenarioInput,
}

/// `hardInvariantFailures`: required invariants that did not hold.
pub fn hard_invariant_failures(
    invariants: &[InvariantResidualReport],
) -> Vec<&InvariantResidualReport> {
    invariants
        .iter()
        .filter(|r| r.essentiality == "required" && r.status != InvariantStatus::Held)
        .collect()
}

fn invariant_code(r: &InvariantResidualReport) -> &'static str {
    if r.status == InvariantStatus::Unchecked {
        "invariant_unchecked"
    } else {
        "invariant_violated"
    }
}

fn to_value<T: Serialize>(v: &T) -> Value {
    serde_json::to_value(v).unwrap_or(Value::Null)
}

/// Run one cell. Never fails: an error becomes a recorded `status: error` cell
/// (its result file is written when possible).
pub fn run_cell(root: &MapRoot, template: &TemplateFile, options: &CellOptions) -> CellResult {
    let paths = options.paths();
    match try_run_cell(root, template, options, &paths) {
        Ok(result) => result,
        Err(error) => {
            let result = CellResult::failed(options, CellError::from(&error), "");
            let _ = write_json_file(std::path::Path::new(&paths.result), &result);
            result
        }
    }
}

fn try_run_cell(
    root: &MapRoot,
    template: &TemplateFile,
    options: &CellOptions,
    paths: &CellPaths,
) -> Result<CellResult, CompileError> {
    let map = root.load(&options.map_id)?;
    let site = find_site(
        &template.template,
        map.bundle(),
        &options.site_id,
        options.exact_catalog_site_resolution,
    )?;
    let mut materialize = simforge_compiler::MaterializeOptions::new();
    materialize.draw_index = options.draw_index;
    materialize.seed = options.seed.clone();
    materialize.variant = options
        .catalog_slot
        .as_ref()
        .map(|slot| CatalogVariantApplication {
            id: slot.variant.id.clone(),
            title: slot.variant.title.clone(),
            weather: slot.variant.weather.clone(),
            time_of_day: slot.variant.time_of_day.clone(),
            traffic: slot.variant.traffic.clone(),
            visibility: slot.variant.visibility.clone(),
        });
    materialize.ambient = options.ambient.clone();
    if let Some(settle) = options.ambient_settle_seconds {
        materialize.ambient_settle_seconds = settle;
    }
    let compiled = compile_at(
        &template.document,
        map.bundle(),
        &site.site_id,
        &materialize,
    )?;
    let manifest = &compiled.manifest;
    let instance = CellInstance {
        kind: "scenario-instance",
        version: 1,
        catalog_slot: options.catalog_slot.as_ref(),
        manifest,
        input: &compiled.input,
    };
    write_json_file(std::path::Path::new(&paths.instance), &instance)?;

    let run = simulate(&compiled.input, &map)?;
    let mut trace = run.trace;
    if let Some(slot) = &options.catalog_slot {
        trace.header.catalog_slot = Some(to_value(slot));
    }
    // One read of the trace, as a host hands it over: evaluation, invariants
    // and the digest all use it.
    let handle = reparse_trace(&trace)?;
    if options.write_trace {
        write_trace_gz(
            std::path::Path::new(&paths.trace),
            &quantized_json(&handle)?,
        )?;
    }

    let mode = if template.template.meta.negative_control {
        FilterMode::NegativeControl
    } else {
        options.filter
    };
    let evaluation = evaluate_trace(
        &handle,
        &filters_for(
            mode,
            options.trivial_ttc_s,
            options.collision_policy == Some(CollisionPolicy::Reject),
        ),
    );
    let speed_limit_kph = map
        .bundle()
        .index()
        .lane(&site.frame.entry_lane_rsl)
        .map(|lane| lane.speed_limit_kph);
    let scope = ExprScope {
        lane_speed_limit_kph: speed_limit_kph,
        lane_width_m: None,
        junction_size_m: None,
        clip_seconds: Some(trace.header.clip_seconds),
        params: manifest.params.values.clone(),
    };
    let invariants = check_invariants(&InvariantContext {
        template: &template.template,
        trace: &handle,
        scope: &scope,
        arrival: &manifest.arrival,
        speed_limit_kph,
    });
    let required_failures = hard_invariant_failures(&invariants);

    let instance_js = JsValue::from_serialize(&instance)?;
    let mut header_js = JsValue::from_serialize(&trace.header)?;
    if let Some(slot) = &options.catalog_slot {
        // `{...header, catalogSlot}`: the slot object itself, in its own order.
        header_js.set("catalogSlot", JsValue::from_serialize(slot)?);
    }
    let physics_mode = to_value(&compiled.input.physics_mode());
    let evidence = verify_evidence_hashes(
        &instance_js,
        &TraceView {
            header: &header_js,
            track_ids: trace.ticks.actors.keys().cloned().collect(),
        },
        physics_mode.as_str().unwrap_or_default(),
    );

    let mut findings: Vec<CellFinding> = evaluation
        .findings
        .iter()
        .map(|f| CellFinding {
            code: code_str(f.code),
            reason: f.reason.clone(),
        })
        .collect();
    if !evidence.ok {
        findings.extend(evidence.issues.iter().map(|i| CellFinding {
            code: i.code.to_owned(),
            reason: i.reason.to_owned(),
        }));
    }
    findings.extend(required_failures.iter().map(|r| CellFinding {
        code: invariant_code(r).to_owned(),
        reason: format!("{}: {}", r.id, r.reason),
    }));
    if !manifest.feasible {
        findings.push(CellFinding {
            code: "materialization_infeasible".to_owned(),
            reason: "materializer could not satisfy the concrete scenario constraints".to_owned(),
        });
    }
    let verdict = if !manifest.feasible || !required_failures.is_empty() || !evidence.ok {
        "reject"
    } else {
        verdict_str(evaluation.verdict)
    };
    let mut hard_failure_codes: Vec<String> =
        evidence.issues.iter().map(|i| i.code.to_owned()).collect();
    hard_failure_codes.extend(
        required_failures
            .iter()
            .map(|r| invariant_code(r).to_owned()),
    );
    // A negative control may accept with an informational `trivially_safe`
    // finding; only findings that made evaluation reject are hard failures.
    if verdict_str(evaluation.verdict) == "reject" {
        hard_failure_codes.extend(evaluation.findings.iter().map(|f| code_str(f.code)));
    }
    if !manifest.feasible {
        hard_failure_codes.push("materialization_infeasible".to_owned());
    }
    let band = if !evidence.ok {
        "evidence-mismatch"
    } else if !manifest.feasible {
        "infeasible"
    } else if !required_failures.is_empty() {
        "invariant"
    } else {
        criticality_band(evaluation.verdict, &evaluation.findings)
    };
    let mut tags = evaluation.tags.clone();
    if !evidence.ok {
        tags.push("evidence_mismatch".to_owned());
    }
    if required_failures
        .iter()
        .any(|r| r.status == InvariantStatus::Violated)
    {
        tags.push("invariant_violated".to_owned());
    }
    if required_failures
        .iter()
        .any(|r| r.status == InvariantStatus::Unchecked)
    {
        tags.push("invariant_unchecked".to_owned());
    }
    let issues = manifest
        .issues
        .iter()
        .chain(run.issues.iter())
        .map(|i| CellIssue {
            code: to_value(&i.code),
            severity: to_value(&i.severity),
            reason: i.reason.clone(),
        })
        .collect();
    let ambient = manifest
        .ambient
        .as_ref()
        .map(|p| ambient_cell_report(p, &trace));
    let result = CellResult {
        map_id: options.map_id.clone(),
        site_id: options.site_id.clone(),
        draw_index: options.draw_index,
        instance_id: instance_id(options),
        catalog_slot: options.catalog_slot.clone(),
        status: "ok",
        feasible: manifest.feasible,
        verdict: Some(verdict),
        band: Some(band.to_owned()),
        tags,
        findings,
        metrics: Some(metrics_summary(&trace.metrics)),
        invariants,
        evidence,
        site_score: site.score,
        site_verdict: to_value(&site.degradation.verdict),
        param_seed: manifest.replay_key.param_seed.clone(),
        params: manifest.params.values.clone(),
        input_hash: Some(manifest.input_hash.clone()),
        trace_digest: Some(
            handle
                .digest()
                .map_err(|e| CompileError::internal(format!("trace digest: {e}")))?,
        ),
        instance_file: Some(paths.instance.clone()),
        trace_file: options.write_trace.then(|| paths.trace.clone()),
        issues,
        error: None,
        eligibility: Eligibility {
            collision_policy: options.policy(),
            eligible: verdict == "accept",
            hard_failure_codes,
        },
        ambient,
        artifact_hashes: None,
    };
    write_json_file(std::path::Path::new(&paths.result), &result)?;
    Ok(result)
}

/// Measure the delivered background population from the trace, not from the
/// request: "we asked for 8" is not evidence that 8 cars are on the road at
/// `t = 0` within sight of the subject.
fn ambient_cell_report(
    provenance: &AmbientTrafficProvenance,
    trace: &SimTrace,
) -> AmbientCellReport {
    let ambient_ids: &[String] = trace.header.ambient_actor_ids.as_deref().unwrap_or(&[]);
    let t0 = trace.ticks.t.iter().position(|&t| t >= 0.0);
    let subject_id = trace.header.metric_subject.as_deref().unwrap_or("ego");
    let subject = trace.ticks.actors.get(subject_id);
    let mut near = 0u32;
    let mut stopped = 0u32;
    if let Some(t0) = t0 {
        for id in ambient_ids {
            let Some(track) = trace.ticks.actors.get(id) else {
                continue;
            };
            if track.present.get(t0).copied().unwrap_or(0) == 0 {
                continue;
            }
            let kind = trace.header.actor_metadata.get(id).map(|m| m.kind);
            let is_vehicle = !matches!(
                kind,
                Some(ActorKind::Pedestrian) | Some(ActorKind::Bicycle) | Some(ActorKind::Animal)
            );
            if track.speed_mps.get(t0).copied().unwrap_or(0.0) < AMBIENT_STANDSTILL_MPS {
                stopped += 1;
            }
            let Some(subject) = subject else { continue };
            if subject.present.get(t0).copied().unwrap_or(0) == 0 || !is_vehicle {
                continue;
            }
            let dx =
                track.x.get(t0).copied().unwrap_or(0.0) - subject.x.get(t0).copied().unwrap_or(0.0);
            let dy =
                track.y.get(t0).copied().unwrap_or(0.0) - subject.y.get(t0).copied().unwrap_or(0.0);
            if dx.hypot(dy) <= AMBIENT_NEAR_SUBJECT_RADIUS_M {
                near += 1;
            }
        }
    }
    AmbientCellReport {
        actor_count: ambient_ids.len(),
        profile_hash: provenance.profile_hash.clone(),
        eligible_lane_km: provenance.eligible_lane_km,
        rejected_spawn_count: provenance.rejected_spawn_count,
        authored_corridor_rejects: provenance.authored_corridor_rejects,
        near_subject_at_t0: near,
        stopped_at_t0: stopped,
        warnings: provenance.warnings.clone(),
    }
}
