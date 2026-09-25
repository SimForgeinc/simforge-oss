//! `catalog batch`: deterministic, resumable execution of an authored catalog.
//!
//! The catalog is the lifecycle manifest; execution also keeps a separate
//! attempt ledger. A failed simulation is evidence of an attempt, not
//! evidence that a slot reached `simulated`.
//!
//! Per selected slot: resolve the one matcher site the slot reserved (never a
//! fallback), run bounded attempts through the batch cell runner
//! (`attempt 0` uses the slot seed, later ones a derived replacement seed),
//! promote the eligible attempt (or the last generated one, as a rejection)
//! into the slot's evidence paths, and advance the slot status in the
//! catalog with every derived digest recomputed. The ledger and the catalog
//! are rewritten atomically after every step, so an interrupted run resumes
//! with the same attempt numbers and seeds; promoted evidence is re-verified
//! against the ledger before it is trusted on resume.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use serde_json::{json, Value};
use simforge_compiler::sites::{match_on_map, SiteMatchOptions};
use simforge_compiler::{CompileError, MATCH_SEMANTICS_VERSION};
use simforge_core::hash::{sha256, sha256_bytes};

use super::closure::matcher_site_closes_location;
use super::js::{is_str, object, strict_eq, to_js_string, truthy, Js};
use super::verify::{validate_catalog, VerifyOptions};
use super::{design_digest, refresh_catalog, templates};
use crate::batch::cell::{
    run_cell, CatalogProvenance, CatalogSlot, CatalogVariant, CellError, CellOptions, CellPaths, CellResult,
    CollisionPolicy,
};
use crate::evaluate::FilterMode;
use crate::maps::MapRoot;
use crate::paths::resolve;
use crate::template::TemplateFile;

pub const CATALOG_EXECUTOR_VERSION: &str = "1.0.1";
const LEDGER_KIND: &str = "uniscenarios-catalog-execution-ledger";

#[derive(Debug, Clone)]
pub struct CatalogBatchOptions {
    /// The catalog as given on the command line.
    pub file: PathBuf,
    pub ledger: Option<PathBuf>,
    pub slot_ids: Vec<String>,
    pub map_ids: Vec<String>,
    pub mechanism_ids: Vec<String>,
    pub max_attempts: f64,
    pub concurrency: Option<f64>,
    pub force: bool,
    pub filter: FilterMode,
    pub trivial_ttc_s: Option<f64>,
    pub collision_policy: CollisionPolicy,
    /// Refuse a catalog that does not cover every taxonomy mechanism (as
    /// `catalog verify --require-full-coverage` does). Off by default: a
    /// verify-clean partial catalog runs and the gap is reported as `coverage`.
    pub require_full_coverage: bool,
}

fn policy_str(policy: CollisionPolicy) -> &'static str {
    match policy {
        CollisionPolicy::Reject => "reject",
        CollisionPolicy::Allow => "allow",
    }
}

fn structured(code: &str, path: Option<&str>, reason: &str) -> Js {
    let mut entries = vec![("code".to_owned(), Js::from(code))];
    if let Some(path) = path {
        entries.push(("path".to_owned(), Js::from(path)));
    }
    entries.push(("reason".to_owned(), Js::from(reason)));
    Js::Object(entries)
}

/// `toStructuredError` of a compiler/CLI error: `{code, path?, reason, detail?}`.
fn structured_error(error: &CompileError) -> Js {
    let mut out = structured(&error.code, error.path.as_deref(), &error.reason);
    if let Some(detail) = &error.detail {
        out.set("detail", Js::from_value(&Value::Object(detail.clone())));
    }
    out
}

fn cell_error_js(error: &CellError) -> Js {
    let mut out = structured(&error.code, error.path.as_deref(), &error.reason);
    if let Some(detail) = &error.detail {
        out.set("detail", Js::from_value(detail));
    }
    out
}

/// `sha256("<seed>\0replacement\0<attempt>")` after the first attempt.
pub fn catalog_attempt_seed(seed: &str, attempt: usize) -> String {
    if attempt == 0 {
        seed.to_owned()
    } else {
        sha256(&format!("{seed}\0replacement\0{attempt}"))
    }
}

/// `CatalogArtifactProvenance` as the TypeScript object literal builds it.
fn artifact_provenance(slot: &Js, attempt_seed: &str, matcher_site_id: &str) -> Js {
    let mut provenance = slot.get("provenance").cloned().unwrap_or(Js::Object(Vec::new()));
    provenance.set("templateDigest", slot.get("provenance").and_then(|p| p.get("templateDigest")).cloned().into());
    object([
        ("identity", slot.get("identity").cloned().into()),
        ("seed", slot.get("seed").cloned().into()),
        ("attemptSeed", attempt_seed.into()),
        ("designDigest", design_digest(slot).into()),
        ("mapId", slot.get("mapId").cloned().into()),
        ("incidentId", slot.get("scenario").and_then(|s| s.get("incidentId")).cloned().into()),
        ("selectedLocationId", slot.get("site").and_then(|s| s.get("locationId")).cloned().into()),
        ("selectedMatcherSiteId", matcher_site_id.into()),
        ("variant", slot.get("variant").cloned().into()),
        ("provenance", provenance),
        ("templateId", slot.get("implementation").and_then(|i| i.get("templateId")).cloned().into()),
    ])
}

/// The same provenance, typed for the cell runner.
fn typed_provenance(js: &Js) -> CatalogSlot {
    let s = |v: &Js, k: &str| to_js_string(v.get(k));
    let empty = Js::Object(Vec::new());
    let variant = js.get("variant").unwrap_or(&empty);
    let provenance = js.get("provenance").unwrap_or(&empty);
    CatalogSlot {
        identity: s(js, "identity"),
        seed: s(js, "seed"),
        attempt_seed: s(js, "attemptSeed"),
        design_digest: s(js, "designDigest"),
        map_id: s(js, "mapId"),
        incident_id: s(js, "incidentId"),
        selected_location_id: s(js, "selectedLocationId"),
        selected_matcher_site_id: s(js, "selectedMatcherSiteId"),
        variant: CatalogVariant {
            id: s(variant, "id"),
            title: s(variant, "title"),
            weather: s(variant, "weather"),
            time_of_day: s(variant, "timeOfDay"),
            traffic: s(variant, "traffic"),
            visibility: s(variant, "visibility"),
        },
        provenance: CatalogProvenance {
            namespace: s(provenance, "namespace"),
            generator_version: s(provenance, "generatorVersion"),
            map_catalog_revision: s(provenance, "mapCatalogRevision"),
            matcher_index_digest: s(provenance, "matcherIndexDigest"),
            engine_graph_digest: s(provenance, "engineGraphDigest"),
            location_catalog_digest: s(provenance, "locationCatalogDigest"),
            taxonomy_digest: s(provenance, "taxonomyDigest"),
            template_digest: s(provenance, "templateDigest"),
        },
        template_id: s(js, "templateId"),
    }
}

fn slots_of(catalog: &Js) -> Vec<Js> {
    catalog.get("slots").and_then(Js::as_array).cloned().unwrap_or_default()
}

fn sget<'a>(v: &'a Js, path: &[&str]) -> Option<&'a Js> {
    path.iter().try_fold(v, |v, k| v.get(k))
}

fn identity_of(slot: &Js) -> String {
    to_js_string(slot.get("identity"))
}

/* ------------------------------------------------------------------ ledger */

fn count_where(slots: &[Js], f: impl Fn(&Js) -> bool) -> usize {
    slots.iter().filter(|s| f(s)).count()
}

fn state_is(record: &Js, state: &str) -> bool {
    is_str(record.get("state"), state)
}

fn attempts(record: &Js) -> Vec<Js> {
    record.get("attempts").and_then(Js::as_array).cloned().unwrap_or_default()
}

/// `deriveCatalogExecutionCounts`.
fn derive_counts(slots: &[Js]) -> Js {
    // `templateId !== null`: an absent member counts as template-backed.
    let template_backed = |s: &Js| !matches!(s.get("templateId"), Some(Js::Null));
    let any_attempt = |s: &Js, key: &str| attempts(s).iter().any(|a| truthy(a.get(key)));
    object([
        ("total", slots.len().into()),
        ("templateBacked", count_where(slots, template_backed).into()),
        ("supported", count_where(slots, |s| template_backed(s) && !state_is(s, "unsupported")).into()),
        ("unsupported", count_where(slots, |s| state_is(s, "unsupported")).into()),
        ("pending", count_where(slots, |s| state_is(s, "pending")).into()),
        ("running", count_where(slots, |s| state_is(s, "running")).into()),
        ("attempted", count_where(slots, |s| !attempts(s).is_empty()).into()),
        ("generated", count_where(slots, |s| any_attempt(s, "generated")).into()),
        ("simulated", count_where(slots, |s| any_attempt(s, "simulated")).into()),
        ("accepted", count_where(slots, |s| state_is(s, "simulated")).into()),
        ("rejected", count_where(slots, |s| state_is(s, "rejected")).into()),
        ("failed", count_where(slots, |s| state_is(s, "failed")).into()),
        ("resumed", count_where(slots, |s| truthy(s.get("resumed"))).into()),
    ])
}

/// `reconcileInterruptedExecutionSlot`: a `running` record has no committed
/// attempt; move it back to `pending`, keeping the attempt history.
fn reconcile_interrupted(prior: &Js) -> Js {
    let interrupted = state_is(prior, "running");
    let mut out = prior.clone();
    let resumed = interrupted
        || ["unsupported", "simulated", "rejected", "failed"].iter().any(|s| state_is(prior, s));
    if interrupted {
        out.set("state", "pending".into());
    } else {
        out.set("state", prior.get("state").cloned().into());
    }
    out.set("resumed", resumed.into());
    if interrupted {
        out.remove("error");
    }
    out
}

fn invalidate_stale_resume(record: &mut Js, error: Js) {
    record.set("state", "pending".into());
    record.set("resumed", true.into());
    record.set("error", error);
}

/* ---------------------------------------------------------------- planning */

struct Plan {
    slot: Js,
    template: Option<std::sync::Arc<TemplateFile>>,
    site_id: Option<String>,
    planning_error: Option<Js>,
    unsupported_error: Option<Js>,
}

fn template_file(source: &str) -> Result<TemplateFile, CompileError> {
    let bytes = templates::template_bytes(source).ok_or_else(|| {
        CompileError::new(
            "internal_error",
            format!("Error: catalog template {source} is not embedded in this simforge binary"),
        )
    })?;
    let document: Value = serde_json::from_slice(bytes)
        .map_err(|e| CompileError::at("invalid_json", source.to_owned(), e.to_string()))?;
    let template = crate::template::parse_template_issues(&document).map_err(|issues| {
        CompileError::at("template_invalid", source.to_owned(), "the document is not a valid v2 scenario template")
            .detail_entry("issues", json!(issues))
            .as_findings()
    })?;
    Ok(TemplateFile { document, template })
}

fn read_locations(root: &MapRoot, map_id: &str) -> Result<Vec<Js>, CompileError> {
    let file = root.dir.join(map_id).join(crate::maps::LOCATIONS_FILE);
    let bytes = std::fs::read(&file).map_err(|e| crate::json::io_error(&file, e))?;
    let plain = super::unzip(bytes).map_err(|e| crate::json::io_error(&file, e))?;
    let catalog = Js::parse(&String::from_utf8_lossy(&plain))
        .map_err(|e| CompileError::at("invalid_json", file.display().to_string(), e))?;
    Ok(catalog.get("locations").and_then(Js::as_array).cloned().unwrap_or_default())
}

/// `planSupportedSlots`: group by (template, map), prove each slot's
/// persisted site under the exact catalog matcher.
fn plan_slots(root: &MapRoot, slots: &[Js]) -> Vec<Plan> {
    let mut plans: HashMap<String, Plan> = HashMap::new();
    let mut groups: Vec<((String, String), Vec<&Js>)> = Vec::new();
    for slot in slots {
        let id = identity_of(slot);
        let implementation = slot.get("implementation");
        let unsupported = |code: &str, reason: String| Plan {
            slot: slot.clone(),
            template: None,
            site_id: None,
            planning_error: None,
            unsupported_error: Some(structured(code, Some(&id), &reason)),
        };
        let source = implementation.and_then(|i| i.get("templateSource"));
        if !is_str(implementation.and_then(|i| i.get("state")), "template-backed") || !truthy(source) {
            let incident = to_js_string(sget(slot, &["scenario", "incidentId"]));
            plans.insert(
                id.clone(),
                unsupported("unsupported_catalog_mechanism", format!("incident {incident} has no executable template")),
            );
            continue;
        }
        if !truthy(implementation.and_then(|i| i.get("matcherSiteId")))
            || !strict_eq(implementation.and_then(|i| i.get("matchedLocationId")), sget(slot, &["site", "locationId"]))
        {
            plans.insert(
                id.clone(),
                unsupported(
                    "unsupported_catalog_site_binding",
                    "template provenance exists, but the reserved catalog location has no persisted exact matcher site binding".to_owned(),
                ),
            );
            continue;
        }
        if !strict_eq(implementation.and_then(|i| i.get("materializedVariantId")), sget(slot, &["variant", "id"])) {
            let variant = to_js_string(sget(slot, &["variant", "id"]));
            plans.insert(
                id.clone(),
                unsupported(
                    "unsupported_catalog_variant",
                    format!("operational variant {variant} is catalog metadata but is not applied by the materializer/engine"),
                ),
            );
            continue;
        }
        let key = (to_js_string(source), to_js_string(slot.get("mapId")));
        match groups.iter_mut().find(|(k, _)| *k == key) {
            Some((_, group)) => group.push(slot),
            None => groups.push((key, vec![slot])),
        }
    }

    let options = SiteMatchOptions { min_score: None, max_sites: None, exact_catalog_site_resolution: true };
    for ((source, map_id), group) in &groups {
        let failed = |plans: &mut HashMap<String, Plan>, slot: &Js, error: Js| {
            plans.insert(
                identity_of(slot),
                Plan { slot: slot.clone(), template: None, site_id: None, planning_error: Some(error), unsupported_error: None },
            );
        };
        let outcome = (|| -> Result<(), CompileError> {
            let bytes = templates::template_bytes(source);
            if let Some(bytes) = bytes {
                if !is_str(sget(group[0], &["provenance", "templateDigest"]), &sha256_bytes(bytes)) {
                    return Err(CompileError::at(
                        "template_digest_mismatch",
                        source.clone(),
                        "catalog template provenance does not match the executable file",
                    )
                    .as_findings());
                }
            }
            let template = std::sync::Arc::new(template_file(source)?);
            let map = root.load(map_id)?;
            let matched = match_on_map(&template.template, map.bundle(), &options)?;
            let index = map.bundle().index();
            let matcher_digest = index.topology_digest.clone();
            let engine_digest = map.bundle().graph().topology_digest().to_owned();
            for slot in group {
                if !is_str(sget(slot, &["provenance", "matcherIndexDigest"]), &matcher_digest)
                    || !is_str(sget(slot, &["provenance", "engineGraphDigest"]), &engine_digest)
                {
                    let id = identity_of(slot);
                    failed(
                        &mut plans,
                        slot,
                        structured(
                            "stale_catalog_topology_provenance",
                            Some(&id),
                            "catalog matcher/engine digests do not match the concrete runtime map bundle; regenerate the catalog before execution",
                        ),
                    );
                }
            }
            if matched.report.sites.is_empty() {
                return Err(CompileError::at("no_matching_site", map_id.clone(), format!("template has no executable site on {map_id}"))
                    .detail_entry("failureSummary", Value::String(matched.report.failure_summary.clone()))
                    .as_findings());
            }
            let locations = read_locations(root, map_id)?;
            for slot in group {
                let id = identity_of(slot);
                if plans.contains_key(&id) {
                    continue;
                }
                let site_id = sget(slot, &["implementation", "matcherSiteId"]);
                let location_id = sget(slot, &["site", "locationId"]);
                let error = if !truthy(site_id) || !strict_eq(sget(slot, &["implementation", "matchedLocationId"]), location_id) {
                    Some(structured(
                        "unsupported_catalog_site_binding",
                        Some(&id),
                        "catalog slot lacks a closed persisted matcher-site/catalog-location binding",
                    ))
                } else {
                    match matched.report.sites.iter().find(|s| is_str(site_id, &s.site_id)) {
                        None => Some(structured(
                            "catalog_site_not_matchable",
                            Some(&id),
                            &format!(
                                "persisted matcher site {} is not executable under the current exact catalog matcher",
                                to_js_string(site_id)
                            ),
                        )),
                        Some(site) => {
                            let location = locations
                                .iter()
                                .find(|l| l.get("id").is_some_and(|v| strict_eq(Some(v), location_id)));
                            if location.is_some_and(|l| matcher_site_closes_location(site, l, index)) {
                                plans.insert(
                                    id.clone(),
                                    Plan {
                                        slot: (*slot).clone(),
                                        template: Some(template.clone()),
                                        site_id: Some(site.site_id.clone()),
                                        planning_error: None,
                                        unsupported_error: None,
                                    },
                                );
                                None
                            } else {
                                Some(structured(
                                    "catalog_site_binding_mismatch",
                                    Some(&id),
                                    &format!(
                                        "persisted matcher site {} does not close against catalog location {}",
                                        site.site_id,
                                        to_js_string(location_id)
                                    ),
                                ))
                            }
                        }
                    }
                };
                if let Some(error) = error {
                    failed(&mut plans, slot, error);
                }
            }
            Ok(())
        })();
        if let Err(error) = outcome {
            for slot in group {
                failed(&mut plans, slot, structured_error(&error));
            }
        }
    }
    slots
        .iter()
        .map(|slot| {
            plans.remove(&identity_of(slot)).unwrap_or_else(|| Plan {
                slot: slot.clone(),
                template: None,
                site_id: None,
                planning_error: Some(object([
                    ("code", "cancelled".into()),
                    ("reason", "planning cancelled before this slot was reached".into()),
                ])),
                unsupported_error: None,
            })
        })
        .collect()
}

/* --------------------------------------------------------------- execution */

fn node_join(parts: &[&str]) -> String {
    super::posix_normalize(&parts.join("/"))
}

fn attempt_paths(work_root: &str, identity: &str, attempt: usize) -> CellPaths {
    let dir = node_join(&[work_root, identity, &format!("attempt-{attempt:0>3}")]);
    CellPaths {
        instance: node_join(&[&dir, "instance.json"]),
        trace: node_join(&[&dir, "trace.json.gz"]),
        result: node_join(&[&dir, "result.json"]),
    }
}

fn clear_attempt(paths: &CellPaths) {
    for file in [&paths.instance, &paths.trace, &paths.result] {
        let _ = std::fs::remove_file(file);
    }
}

fn evidence_paths(root: &str, slot: &Js) -> CellPaths {
    let p = |k: &str| node_join(&[root, &to_js_string(sget(slot, &["evidencePaths", k]))]);
    CellPaths { instance: p("instance"), trace: p("trace"), result: p("result") }
}

fn atomic_write(file: &Path, bytes: &[u8]) -> Result<(), CompileError> {
    let absolute = resolve(file);
    if let Some(parent) = absolute.parent() {
        std::fs::create_dir_all(parent).map_err(|e| crate::json::io_error(parent, e))?;
    }
    static COUNTER: AtomicUsize = AtomicUsize::new(0);
    let nonce = COUNTER.fetch_add(1, Ordering::Relaxed);
    let tmp = PathBuf::from(format!("{}.{}.{nonce}.tmp", absolute.display(), std::process::id()));
    std::fs::write(&tmp, bytes).map_err(|e| crate::json::io_error(&tmp, e))?;
    std::fs::rename(&tmp, &absolute).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        crate::json::io_error(&absolute, e)
    })
}

/// Copy the attempt's instance and trace into the slot's evidence paths and
/// seal the result with their hashes.
fn promote_attempt(source: &CellPaths, target: &CellPaths, result: &CellResult) -> Result<(), CompileError> {
    let has_instance = Path::new(&source.instance).exists();
    let has_trace = Path::new(&source.trace).exists();
    let copy = |from: &str, to: &str| -> Result<String, CompileError> {
        let bytes = std::fs::read(from).map_err(|e| crate::json::io_error(Path::new(from), e))?;
        atomic_write(Path::new(to), &bytes)?;
        Ok(sha256_bytes(&bytes))
    };
    let instance_sha = if has_instance {
        Some(copy(&source.instance, &target.instance)?)
    } else {
        let _ = std::fs::remove_file(&target.instance);
        None
    };
    let trace_sha = if has_trace {
        Some(copy(&source.trace, &target.trace)?)
    } else {
        let _ = std::fs::remove_file(&target.trace);
        None
    };
    let mut sealed = result.clone();
    sealed.instance_file = has_instance.then(|| target.instance.clone());
    sealed.trace_file = has_trace.then(|| target.trace.clone());
    sealed.artifact_hashes = Some(crate::batch::cell::ArtifactHashes {
        instance_sha256: instance_sha,
        trace_sha256: trace_sha,
    });
    let text = crate::json::to_pretty_js(&sealed)?;
    atomic_write(Path::new(&target.result), format!("{text}\n").as_bytes())
}

/// `hasResumableAcceptedEligibility` over a result document.
fn resumable_accepted(result: &Js, policy: CollisionPolicy, collisions: usize) -> bool {
    let eligibility = result.get("eligibility");
    is_str(result.get("status"), "ok")
        && matches!(result.get("feasible"), Some(Js::Bool(true)))
        && is_str(result.get("verdict"), "accept")
        && matches!(eligibility.and_then(|e| e.get("eligible")), Some(Js::Bool(true)))
        && is_str(eligibility.and_then(|e| e.get("collisionPolicy")), policy_str(policy))
        && eligibility
            .and_then(|e| e.get("hardFailureCodes"))
            .and_then(Js::as_array)
            .is_some_and(|c| c.is_empty())
        && (policy == CollisionPolicy::Allow || collisions == 0)
}

fn result_js(result: &CellResult) -> Js {
    serde_json::to_value(result).map(|v| Js::from_value(&v)).unwrap_or(Js::Null)
}

fn hard_eligible(result: &CellResult, policy: CollisionPolicy) -> bool {
    let collisions = result.metrics.as_ref().map_or(0, |m| m.collisions.len());
    resumable_accepted(&result_js(result), policy, collisions)
}

/// Shared mutable run state; every change is checkpointed to disk.
struct State {
    ledger: Js,
    records: Vec<Js>,
    catalog: Js,
}

struct Runner<'a> {
    root: &'a MapRoot,
    options: &'a CatalogBatchOptions,
    ledger_file: PathBuf,
    catalog_file: PathBuf,
    work_root: String,
    out_dir: String,
    evidence_root: String,
    state: Mutex<State>,
    index: HashMap<String, usize>,
}

impl Runner<'_> {
    fn checkpoint_locked(&self, state: &mut State) -> Result<(), CompileError> {
        let counts = derive_counts(&state.records);
        state.ledger.set("counts", counts);
        state.ledger.set("slots", Js::Array(state.records.clone()));
        atomic_write(&self.ledger_file, format!("{}\n", state.ledger.stringify_pretty()).as_bytes())?;
        atomic_write(&self.catalog_file, format!("{}\n", state.catalog.stringify_pretty()).as_bytes())
    }

    fn checkpoint(&self) -> Result<(), CompileError> {
        let mut state = self.state.lock().expect("state");
        self.checkpoint_locked(&mut state)
    }

    fn with_record<R>(&self, identity: &str, f: impl FnOnce(&mut Js) -> R) -> R {
        let mut state = self.state.lock().expect("state");
        let i = self.index[identity];
        f(&mut state.records[i])
    }

    fn set_status(&self, state: &mut State, identity: &str, status: &str) -> Result<(), CompileError> {
        let slots: Vec<Js> = slots_of(&state.catalog)
            .into_iter()
            .map(|mut slot| {
                if is_str(slot.get("identity"), identity) {
                    slot.set("status", status.into());
                }
                slot
            })
            .collect();
        state.catalog = refresh_catalog(&state.catalog, slots)?;
        Ok(())
    }

    /// Record the slot's lifecycle status in the catalog and checkpoint.
    fn finish(&self, identity: &str, status: &str) -> Result<(), CompileError> {
        let mut state = self.state.lock().expect("state");
        self.set_status(&mut state, identity, status)?;
        self.checkpoint_locked(&mut state)
    }

    fn execute(&self, plan: &Plan) -> Result<(), CompileError> {
        let slot = &plan.slot;
        let identity = identity_of(slot);
        let template = plan.template.as_ref().expect("runnable plan has a template");
        let site_id = plan.site_id.as_deref().expect("runnable plan has a site");
        let slot_seed = to_js_string(slot.get("seed"));
        // A slot that ends without new evidence keeps the status it was
        // selected with (`finish(slot.status)` in the reference).
        let planned_status = to_js_string(slot.get("status"));
        let first = self.with_record(&identity, |r| attempts(r).len());
        let max = self.options.max_attempts as usize;
        let mut final_result: Option<(CellResult, CellPaths)> = None;
        let mut last_generated: Option<(CellResult, CellPaths)> = None;
        for attempt in first..max {
            let paths = attempt_paths(&self.work_root, &identity, attempt);
            clear_attempt(&paths);
            let seed = catalog_attempt_seed(&slot_seed, attempt);
            let provenance = artifact_provenance(slot, &seed, site_id);
            let mut cell = CellOptions::new(&to_js_string(slot.get("mapId")), site_id, attempt as i64, &self.out_dir);
            cell.write_trace = true;
            cell.filter = self.options.filter;
            cell.trivial_ttc_s = self.options.trivial_ttc_s;
            cell.seed = Some(seed.clone());
            cell.artifact_paths = Some(paths.clone());
            cell.instance_id = Some(identity.clone());
            cell.catalog_slot = Some(typed_provenance(&provenance));
            cell.exact_catalog_site_resolution = true;
            cell.collision_policy = Some(self.options.collision_policy);
            let result = run_cell(self.root, template, &cell);
            let generated = Path::new(&paths.instance).exists();
            let simulated = Path::new(&paths.trace).exists() && result.trace_digest.is_some();
            let mut record = vec![
                ("attempt".to_owned(), Js::from(attempt)),
                ("seed".to_owned(), Js::from(seed.as_str())),
                ("siteId".to_owned(), Js::from(site_id)),
                ("siteBinding".to_owned(), Js::from("catalog-site")),
                ("status".to_owned(), Js::from(result.status)),
                ("feasible".to_owned(), Js::from(result.feasible)),
                ("verdict".to_owned(), result.verdict.map_or(Js::Null, Js::from)),
                ("generated".to_owned(), Js::from(generated)),
                ("simulated".to_owned(), Js::from(simulated)),
                ("inputHash".to_owned(), result.input_hash.clone().map_or(Js::Null, Js::from)),
                ("traceDigest".to_owned(), result.trace_digest.clone().map_or(Js::Null, Js::from)),
            ];
            if let Some(error) = &result.error {
                record.push(("error".to_owned(), cell_error_js(error)));
            }
            {
                let mut state = self.state.lock().expect("state");
                let i = self.index[&identity];
                let mut list = attempts(&state.records[i]);
                list.push(Js::Object(record));
                state.records[i].set("attempts", Js::Array(list));
                self.checkpoint_locked(&mut state)?;
            }
            let eligible = hard_eligible(&result, self.options.collision_policy);
            if generated {
                last_generated = Some((result.clone(), paths.clone()));
            }
            final_result = Some((result, paths));
            if eligible {
                break;
            }
        }
        let Some((final_result, final_paths)) = final_result else {
            self.with_record(&identity, |r| {
                r.set("state", "failed".into());
                r.set(
                    "error",
                    object([("code", "attempts_exhausted".into()), ("reason", "no catalog attempt was executed".into())]),
                );
            });
            return self.finish(&identity, &planned_status);
        };
        let evidence = evidence_paths(&self.evidence_root, slot);
        if hard_eligible(&final_result, self.options.collision_policy) {
            promote_attempt(&final_paths, &evidence, &final_result)?;
            self.with_record(&identity, |r| r.set("state", "simulated".into()));
            self.finish(&identity, "simulated")
        } else if let Some((generated, paths)) = last_generated {
            promote_attempt(&paths, &evidence, &generated)?;
            self.with_record(&identity, |r| {
                r.set("state", "rejected".into());
                match &final_result.error {
                    Some(error) => r.set("error", cell_error_js(error)),
                    None => r.remove("error"),
                }
            });
            self.finish(&identity, "rejected")
        } else {
            self.with_record(&identity, |r| {
                r.set("state", "failed".into());
                r.set(
                    "error",
                    final_result.error.as_ref().map_or_else(
                        || {
                            object([
                                ("code", "generation_failed".into()),
                                ("reason", "all bounded attempts failed before materialization".into()),
                            ])
                        },
                        cell_error_js,
                    ),
                );
            });
            self.finish(&identity, &planned_status)
        }
    }
}

/* ------------------------------------------------------------------ resume */

fn read_js(file: &str) -> Option<Js> {
    let bytes = std::fs::read(file).ok()?;
    Js::parse(&String::from_utf8_lossy(&bytes)).ok()
}

fn read_trace(file: &str) -> Option<simforge_core::trace::SimTrace> {
    use std::io::Read;
    let bytes = std::fs::read(file).ok()?;
    let plain = if bytes.starts_with(&[0x1f, 0x8b]) {
        let mut out = Vec::new();
        flate2::read::MultiGzDecoder::new(&bytes[..]).read_to_end(&mut out).ok()?;
        out
    } else {
        bytes
    };
    simforge_core::trace::SimTrace::from_json_slice(&plain).ok()
}

fn file_sha(file: &str) -> Option<String> {
    std::fs::read(file).ok().map(|b| sha256_bytes(&b))
}

fn last_attempt<'a>(record: &'a [Js], f: impl Fn(&Js) -> bool) -> Option<&'a Js> {
    record.iter().rev().find(|a| f(a))
}

/// `validSimulatedResume`: the promoted evidence still closes the ledger's
/// accepted attempt (hashes, provenance, eligibility, trace digest).
fn valid_simulated_resume(record: &Js, slot: &Js, evidence_root: &str, policy: CollisionPolicy) -> bool {
    let list = attempts(record);
    let Some(last) = last_attempt(&list, |a| is_str(a.get("verdict"), "accept")) else { return false };
    let (Some(input_hash), Some(trace_digest)) = (
        last.get("inputHash").and_then(Js::as_str).filter(|s| !s.is_empty()),
        last.get("traceDigest").and_then(Js::as_str).filter(|s| !s.is_empty()),
    ) else {
        return false;
    };
    let paths = evidence_paths(evidence_root, slot);
    if !Path::new(&paths.instance).exists() || !Path::new(&paths.trace).exists() || !Path::new(&paths.result).exists() {
        return false;
    }
    (|| -> Option<bool> {
        let instance = read_js(&paths.instance)?;
        let result = read_js(&paths.result)?;
        let trace = read_trace(&paths.trace)?;
        let expected = artifact_provenance(slot, &to_js_string(last.get("seed")), &to_js_string(last.get("siteId"))).stringify();
        let header = Js::from_value(&serde_json::to_value(&trace.header).ok()?);
        let evidence_ok = evidence_ok(&paths.instance, &trace)?;
        let collisions = trace.metrics.collisions.len();
        let stringify = |v: Option<&Js>| v.map(Js::stringify);
        let seed = to_js_string(last.get("seed"));
        Some(
            evidence_ok
                && stringify(instance.get("catalogSlot")).as_deref() == Some(expected.as_str())
                && is_str(sget(&instance, &["manifest", "inputHash"]), input_hash)
                && is_str(sget(&instance, &["manifest", "replayKey", "paramSeed"]), &seed)
                && stringify(header.get("catalogSlot")).as_deref() == Some(expected.as_str())
                && stringify(result.get("catalogSlot")).as_deref() == Some(expected.as_str())
                && resumable_accepted(&result, policy, collisions)
                && is_str(result.get("inputHash"), input_hash)
                && is_str(result.get("traceDigest"), trace_digest)
                && file_sha(&paths.instance).is_some_and(|h| is_str(sget(&result, &["artifactHashes", "instanceSha256"]), &h))
                && file_sha(&paths.trace).is_some_and(|h| is_str(sget(&result, &["artifactHashes", "traceSha256"]), &h))
                && trace.header.input_hash == input_hash
                && trace.digest().ok().as_deref() == Some(trace_digest),
        )
    })()
    .unwrap_or(false)
}

/// `verifyEvidenceHashes(instance, trace).ok` over the promoted files.
fn evidence_ok(instance_file: &str, trace: &simforge_core::trace::SimTrace) -> Option<bool> {
    use crate::jsvalue::JsValue;
    let text = std::fs::read_to_string(instance_file).ok()?;
    let instance = JsValue::parse(&text).ok()?;
    let header = JsValue::from_serialize(&trace.header).ok()?;
    // `resolvePhysicsConfig(instance.input).mode`, through the scenario parser.
    let input = serde_json::from_str::<Value>(&text).ok()?.get("input").cloned()?;
    let scenario = simforge_bindings_common::runtime::Scenario::parse(&serde_json::to_vec(&input).ok()?).ok()?;
    let mode = serde_json::to_value(scenario.input().physics_mode()).ok()?;
    let report = crate::evidence::verify_evidence_hashes(
        &instance,
        &crate::evidence::TraceView { header: &header, track_ids: trace.ticks.actors.keys().cloned().collect() },
        mode.as_str().unwrap_or_default(),
    );
    Some(report.ok)
}

/// `validRejectedResume`: the promoted rejection still closes the ledger's
/// last generated attempt.
fn valid_rejected_resume(record: &Js, slot: &Js, evidence_root: &str, policy: CollisionPolicy) -> bool {
    let list = attempts(record);
    let Some(last) = last_attempt(&list, |a| truthy(a.get("generated"))) else { return false };
    let paths = evidence_paths(evidence_root, slot);
    if !Path::new(&paths.instance).exists() || !Path::new(&paths.result).exists() {
        return false;
    }
    (|| -> Option<bool> {
        let instance = read_js(&paths.instance)?;
        let result = read_js(&paths.result)?;
        let expected = artifact_provenance(slot, &to_js_string(last.get("seed")), &to_js_string(last.get("siteId"))).stringify();
        let instance_hash = file_sha(&paths.instance)?;
        let has_trace = Path::new(&paths.trace).exists();
        let trace_hash = if has_trace { file_sha(&paths.trace) } else { None };
        let trace_closes = if has_trace {
            let trace = read_trace(&paths.trace)?;
            let header = Js::from_value(&serde_json::to_value(&trace.header).ok()?);
            truthy(last.get("simulated"))
                && !matches!(last.get("traceDigest"), None | Some(Js::Null))
                && header.get("catalogSlot").map(Js::stringify).as_deref() == Some(expected.as_str())
                && trace.digest().ok().is_some_and(|d| is_str(last.get("traceDigest"), &d))
        } else {
            !truthy(last.get("simulated")) && matches!(last.get("traceDigest"), Some(Js::Null))
        };
        let stringify = |v: Option<&Js>| v.map(Js::stringify);
        let eligibility = result.get("eligibility");
        let hash_matches = |key: &str, hash: Option<&String>| match hash {
            Some(h) => is_str(sget(&result, &["artifactHashes", key]), h),
            None => matches!(sget(&result, &["artifactHashes", key]), Some(Js::Null)),
        };
        Some(
            stringify(instance.get("catalogSlot")).as_deref() == Some(expected.as_str())
                && stringify(result.get("catalogSlot")).as_deref() == Some(expected.as_str())
                && strict_eq(sget(&instance, &["manifest", "inputHash"]), last.get("inputHash"))
                && strict_eq(sget(&instance, &["manifest", "replayKey", "paramSeed"]), last.get("seed"))
                && strict_eq(result.get("status"), last.get("status"))
                && strict_eq(result.get("feasible"), last.get("feasible"))
                && strict_eq(result.get("verdict"), last.get("verdict"))
                && strict_eq(result.get("siteId"), last.get("siteId"))
                && strict_eq(result.get("drawIndex"), last.get("attempt"))
                && strict_eq(result.get("inputHash"), last.get("inputHash"))
                && strict_eq(result.get("traceDigest"), last.get("traceDigest"))
                && !is_str(result.get("verdict"), "accept")
                && matches!(eligibility.and_then(|e| e.get("eligible")), Some(Js::Bool(false)))
                && is_str(eligibility.and_then(|e| e.get("collisionPolicy")), policy_str(policy))
                && is_str(sget(&result, &["artifactHashes", "instanceSha256"]), &instance_hash)
                && hash_matches("traceSha256", trace_hash.as_ref())
                && trace_closes,
        )
    })()
    .unwrap_or(false)
}

/* --------------------------------------------------------------------- run */

/// `executionPlanDigest`.
fn plan_digest(catalog: &Js, slots: &[Js], options: &CatalogBatchOptions) -> String {
    let rows: Vec<Js> = slots
        .iter()
        .map(|slot| {
            object([
                ("identity", slot.get("identity").cloned().into()),
                ("seed", slot.get("seed").cloned().into()),
                ("mapId", slot.get("mapId").cloned().into()),
                ("incidentId", sget(slot, &["scenario", "incidentId"]).cloned().into()),
                ("implementation", slot.get("implementation").cloned().into()),
                ("provenance", slot.get("provenance").cloned().into()),
                ("site", slot.get("site").cloned().into()),
                ("variant", slot.get("variant").cloned().into()),
                ("evidencePaths", slot.get("evidencePaths").cloned().into()),
            ])
        })
        .collect();
    let body = object([
        ("namespace", sget(catalog, &["provenance", "namespace"]).cloned().into()),
        ("taxonomyDigest", sget(catalog, &["provenance", "taxonomyDigest"]).cloned().into()),
        ("executorVersion", CATALOG_EXECUTOR_VERSION.into()),
        ("matcherVersion", MATCH_SEMANTICS_VERSION.into()),
        ("solverVersion", simforge_bindings_common::ENGINE_SEM_VER.into()),
        ("filter", options.filter.as_str().into()),
        ("collisionPolicy", policy_str(options.collision_policy).into()),
        ("trivialTtcS", options.trivial_ttc_s.map_or(Js::Null, Js::from)),
        ("slots", Js::Array(rows)),
    ]);
    sha256(&body.stringify())
}

/// Run `catalog batch`; returns the result document and the exit status.
pub fn catalog_batch(root: &MapRoot, options: &CatalogBatchOptions) -> Result<(Value, bool), CompileError> {
    let max = options.max_attempts;
    if !(max.fract() == 0.0 && (1.0..=100.0).contains(&max)) {
        return Err(CompileError::at("bad_value", "--attempts", "--attempts must be an integer from 1 to 100"));
    }
    if let Some(c) = options.concurrency {
        if !(c.fract() == 0.0 && (1.0..=32.0).contains(&c)) {
            return Err(CompileError::at("bad_value", "--concurrency", "--concurrency must be an integer from 1 to 32"));
        }
    }
    let catalog_file = resolve(&options.file);
    let file_arg = options.file.display().to_string();
    let catalog = match std::fs::read(&catalog_file) {
        Ok(bytes) => Js::parse(&String::from_utf8_lossy(&bytes))
            .map_err(|e| CompileError::at("invalid_catalog", file_arg.clone(), e))?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(CompileError::at(
                "invalid_catalog",
                file_arg,
                format!("ENOENT: no such file or directory, open '{}'", catalog_file.display()),
            ))
        }
        Err(e) => return Err(CompileError::at("invalid_catalog", file_arg, e.to_string())),
    };
    let validation = validate_catalog(
        &catalog,
        &VerifyOptions {
            manifest_file: Some(catalog_file.clone()),
            require_full_coverage: options.require_full_coverage,
            ..VerifyOptions::default()
        },
    )?;
    if !validation.ok && validation.issues.iter().any(|i| i.code != "missing_evidence") {
        return Err(CompileError::at("invalid_catalog", file_arg, "catalog verification failed before execution")
            .detail_entry("issues", Value::Array(validation.issues.iter().map(|i| i.to_value()).collect()))
            .as_findings());
    }

    let coverage = validation.coverage.clone();
    let slots = slots_of(&catalog);
    let wanted = |list: &[String], v: Option<&Js>| list.is_empty() || v.and_then(Js::as_str).is_some_and(|s| list.iter().any(|x| x == s));
    let selected: Vec<Js> = slots
        .iter()
        .filter(|s| {
            wanted(&options.slot_ids, s.get("identity"))
                && wanted(&options.map_ids, s.get("mapId"))
                && wanted(&options.mechanism_ids, sget(s, &["scenario", "incidentId"]))
        })
        .cloned()
        .collect();
    if selected.is_empty() {
        return Err(CompileError::at("empty_selection", file_arg, "catalog filters selected no slots").as_findings());
    }
    let cpus = std::thread::available_parallelism().map_or(1, |n| n.get());
    let concurrency = options
        .concurrency
        .map_or(cpus.min(4), |c| c as usize)
        .min(32)
        .min(selected.len())
        .max(1);
    let digest = plan_digest(&catalog, &selected, options);
    let catalog_dir = catalog_file.parent().map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from("/"));
    let ledger_file = resolve(
        &options
            .ledger
            .clone()
            .unwrap_or_else(|| catalog_dir.join("catalog-execution-ledger.json")),
    );
    let work_root = format!("{}.work", ledger_file.display());
    let existing = if options.force {
        None
    } else {
        std::fs::read(&ledger_file).ok().and_then(|b| Js::parse(&String::from_utf8_lossy(&b)).ok())
    };
    let reusable = existing
        .as_ref()
        .is_some_and(|e| is_str(e.get("kind"), LEDGER_KIND) && is_str(e.get("planDigest"), &digest));
    let previous: Vec<Js> = if reusable {
        existing.as_ref().and_then(|e| e.get("slots")).and_then(Js::as_array).cloned().unwrap_or_default()
    } else {
        Vec::new()
    };
    let records: Vec<Js> = selected
        .iter()
        .map(|slot| {
            let id = identity_of(slot);
            // `new Map(entries)`: the last record for an identity wins.
            match previous.iter().rev().find(|p| p.get("identity").is_some_and(|v| to_js_string(Some(v)) == id)) {
                Some(prior) => reconcile_interrupted(prior),
                None => object([
                    ("identity", slot.get("identity").cloned().into()),
                    ("mapId", slot.get("mapId").cloned().into()),
                    ("incidentId", sget(slot, &["scenario", "incidentId"]).cloned().into()),
                    ("templateId", sget(slot, &["implementation", "templateId"]).cloned().unwrap_or(Js::Null)),
                    ("state", "pending".into()),
                    ("attempts", Js::Array(Vec::new())),
                    ("resumed", false.into()),
                ]),
            }
        })
        .collect();
    let ledger = object([
        ("kind", LEDGER_KIND.into()),
        ("version", 1usize.into()),
        ("catalog", catalog_file.display().to_string().into()),
        ("namespace", sget(&catalog, &["provenance", "namespace"]).cloned().into()),
        ("planDigest", digest.into()),
        ("executorVersion", CATALOG_EXECUTOR_VERSION.into()),
        ("matcherVersion", MATCH_SEMANTICS_VERSION.into()),
        ("solverVersion", simforge_bindings_common::ENGINE_SEM_VER.into()),
        (
            "options",
            object([
                ("maxAttempts", max.into()),
                ("concurrency", concurrency.into()),
                ("filter", options.filter.as_str().into()),
                ("collisionPolicy", policy_str(options.collision_policy).into()),
            ]),
        ),
        ("status", "running".into()),
        ("counts", derive_counts(&records)),
        ("slots", Js::Array(records.clone())),
    ]);
    let index: HashMap<String, usize> = records.iter().enumerate().map(|(i, r)| (identity_of(r), i)).collect();
    let evidence_root = catalog_dir.display().to_string();
    let runner = Runner {
        root,
        options,
        out_dir: ledger_file.parent().map_or_else(|| "/".to_owned(), |p| p.display().to_string()),
        ledger_file: ledger_file.clone(),
        catalog_file: catalog_file.clone(),
        work_root,
        evidence_root: evidence_root.clone(),
        state: Mutex::new(State { ledger, records, catalog: catalog.clone() }),
        index,
    };
    runner.checkpoint()?;
    let plans = plan_slots(root, &selected);

    {
        let mut state = runner.state.lock().expect("state");
        for slot in &selected {
            let id = identity_of(slot);
            let i = runner.index[&id];
            let record = state.records[i].clone();
            if state_is(&record, "simulated") {
                if valid_simulated_resume(&record, slot, &evidence_root, options.collision_policy) {
                    if !is_str(slot.get("status"), "simulated") {
                        runner.set_status(&mut state, &id, "simulated")?;
                    }
                } else {
                    invalidate_stale_resume(
                        &mut state.records[i],
                        structured(
                            "stale_resume_artifact",
                            Some(&id),
                            "recorded simulation artifacts are missing or no longer match their ledger hashes",
                        ),
                    );
                    runner.set_status(&mut state, &id, "authored")?;
                }
            } else if state_is(&record, "rejected") {
                if valid_rejected_resume(&record, slot, &evidence_root, options.collision_policy) {
                    if !is_str(slot.get("status"), "rejected") {
                        runner.set_status(&mut state, &id, "rejected")?;
                    }
                } else {
                    invalidate_stale_resume(
                        &mut state.records[i],
                        structured("stale_resume_artifact", Some(&id), "recorded rejection artifacts are missing"),
                    );
                    runner.set_status(&mut state, &id, "authored")?;
                }
            }
        }
        for plan in &plans {
            let i = runner.index[&identity_of(&plan.slot)];
            if let Some(error) = &plan.unsupported_error {
                state.records[i].set("state", "unsupported".into());
                state.records[i].set("error", error.clone());
            } else if let Some(error) = &plan.planning_error {
                state.records[i].set("state", "failed".into());
                state.records[i].set("error", error.clone());
            }
        }
        runner.checkpoint_locked(&mut state)?;
    }

    let runnable: Vec<&Plan> = {
        let mut state = runner.state.lock().expect("state");
        plans
            .iter()
            .filter(|plan| {
                let record = &mut state.records[runner.index[&identity_of(&plan.slot)]];
                if state_is(record, "unsupported") || plan.planning_error.is_some() || state_is(record, "simulated") {
                    return false;
                }
                let tried = attempts(record).len() as f64;
                if (state_is(record, "rejected") || state_is(record, "failed")) && tried >= max {
                    record.set("resumed", true.into());
                    return false;
                }
                if state_is(record, "pending") && tried >= max {
                    let id = identity_of(record);
                    record.set("state", "failed".into());
                    if matches!(record.get("error"), None | Some(Js::Null)) {
                        record.set(
                            "error",
                            structured(
                                "attempts_exhausted",
                                Some(&id),
                                "preserved attempt history already exhausts the configured retry budget",
                            ),
                        );
                    }
                    return false;
                }
                record.set("state", "pending".into());
                true
            })
            .collect()
    };

    let next = AtomicUsize::new(0);
    let failure: Mutex<Option<CompileError>> = Mutex::new(None);
    std::thread::scope(|scope| {
        for _ in 0..concurrency.min(runnable.len()) {
            scope.spawn(|| loop {
                let i = next.fetch_add(1, Ordering::Relaxed);
                let Some(plan) = runnable.get(i) else { break };
                if failure.lock().expect("failure").is_some() {
                    break;
                }
                let id = identity_of(&plan.slot);
                let step = (|| {
                    {
                        let mut state = runner.state.lock().expect("state");
                        let record = &mut state.records[runner.index[&id]];
                        record.set("state", "running".into());
                        record.remove("error");
                        runner.checkpoint_locked(&mut state)?;
                    }
                    runner.execute(plan)
                })();
                if let Err(error) = step {
                    failure.lock().expect("failure").get_or_insert(error);
                    break;
                }
            });
        }
    });
    if let Some(error) = failure.into_inner().expect("failure") {
        return Err(error);
    }

    let mut state = runner.state.lock().expect("state");
    state.ledger.set("status", "completed".into());
    runner.checkpoint_locked(&mut state)?;
    let counts = state.ledger.get("counts").cloned().unwrap_or(Js::Null);
    let n = |k: &str| counts.get(k).and_then(Js::as_f64).unwrap_or(0.0);
    let ok = n("unsupported") == 0.0 && n("failed") == 0.0 && n("rejected") == 0.0;
    let mut payload = state.ledger.clone();
    payload.set("ledger", ledger_file.display().to_string().into());
    payload.set("catalog", catalog_file.display().to_string().into());
    let mut payload = payload.to_value();
    if let Some(coverage) = coverage {
        payload["coverage"] = coverage;
    }
    Ok((payload, ok))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attempt_seeds() {
        assert_eq!(catalog_attempt_seed("abc", 0), "abc");
        assert_eq!(catalog_attempt_seed("abc", 2), sha256("abc\0replacement\x002"));
    }
}
