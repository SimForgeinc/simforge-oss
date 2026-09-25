//! `batch`: the sites x draws matrix of one template.
//!
//! ```text
//! for each map:   sites = match(anchor, map)
//! for each site:  for draw in 0..N-1:  instantiate -> simulate -> evaluate
//! ```
//!
//! - **Resumable.** A cell whose `result.json` carries the expected parameter
//!   seed and whose instance carries the expected template digest, matcher and
//!   solver versions, map digests and ambient profile is reused; change any of
//!   those and the cell runs again.
//! - **Order-independent.** A cell's seed is a hash of its coordinates, so the
//!   thread that runs it cannot change its result; the summary is sorted.
//! - **Parallel.** A pool of OS threads (the engine is synchronous CPU work),
//!   each taking the next cell when it finishes one.

pub mod cell;

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Instant;

use serde::Serialize;
use serde_json::Value;
use simforge_compiler::sites::{match_on_map, SiteMatchOptions};
use simforge_compiler::{
    cell_seed, params_version, resolve_ambient_traffic_profile, AmbientTrafficProfile, CompileError,
    ResolvedAmbientTrafficProfile, MATCH_SEMANTICS_VERSION,
};
use simforge_core::hash::{cmp_utf16, content_hash_of, js_number_to_string};

use self::cell::{run_cell, CellOptions};
use crate::evaluate::FilterMode;
use crate::json::{round3, to_compact_js, write_json_file};
use crate::jsvalue::JsValue;
use crate::maps::MapRoot;
use crate::paths;
use crate::template::{read_template, TemplateFile};

/// Seconds of ambient-only warm-up when `--ambient` is given without
/// `--ambient-settle`: roughly two signal phases, enough for standing queues.
pub const DEFAULT_AMBIENT_SETTLE_S: f64 = 20.0;

/// The ambient presets `--ambient` accepts.
pub const AMBIENT_PRESETS: [&str; 5] = ["off", "light", "moderate", "city", "heavy"];

#[derive(Debug, Clone)]
pub struct BatchOptions {
    pub map_ids: Vec<String>,
    pub draws: i64,
    /// The output directory as given (cell paths are built from it).
    pub out_dir: String,
    pub min_score: Option<f64>,
    pub max_sites: Option<usize>,
    pub concurrency: Option<i64>,
    pub write_trace: bool,
    pub filter: FilterMode,
    pub trivial_ttc_s: Option<f64>,
    pub force: bool,
    /// Generated background road users; `None` leaves the roads empty.
    pub ambient: Option<AmbientTrafficProfile>,
    pub ambient_settle_seconds: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MapSites {
    map_id: String,
    sites: usize,
    matcher_index_digest: String,
    engine_graph_digest: String,
}

#[derive(Debug, Clone, Serialize)]
struct Spread {
    min: f64,
    median: f64,
    max: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AmbientSummary {
    profile: ResolvedAmbientTrafficProfile,
    profile_hash: String,
    cells_with_ambient: usize,
    actors_per_cell: Option<Spread>,
    near_subject_at_t0: Option<Spread>,
}

#[derive(Debug, Clone, Serialize)]
struct TtcSpread {
    min: f64,
    median: f64,
    max: f64,
    n: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Criticality {
    accepted: usize,
    rejected: usize,
    infeasible: usize,
    bands: JsValue,
    #[serde(rename = "minTTC")]
    min_ttc: Option<TtcSpread>,
}

/// `batch-summary.json` (`scenario-batch-summary` v1).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BatchSummary {
    kind: &'static str,
    version: u32,
    template: String,
    template_id: String,
    template_digest: String,
    params_version: String,
    matcher_version: &'static str,
    solver_version: &'static str,
    archetype: Option<String>,
    negative_control: bool,
    maps: Vec<MapSites>,
    draws: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    ambient: Option<AmbientSummary>,
    cells: usize,
    resumed: usize,
    concurrency: usize,
    elapsed_ms: u64,
    criticality: Criticality,
    results: Vec<JsValue>,
}

struct PlannedCell {
    options: CellOptions,
    expected_seed: String,
}

struct ResumeKey<'a> {
    template_digest: &'a str,
    matcher_index_digest: &'a str,
    engine_graph_digest: &'a str,
    ambient_profile_hash: &'a str,
}

fn median(values: &[f64]) -> f64 {
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.total_cmp(b));
    let mid = sorted.len() >> 1;
    if sorted.len() % 2 == 1 {
        sorted[mid]
    } else {
        (sorted[mid - 1] + sorted[mid]) / 2.0
    }
}

fn spread(values: &[f64]) -> Option<Spread> {
    (!values.is_empty()).then(|| Spread {
        min: values.iter().copied().fold(f64::INFINITY, f64::min),
        median: median(values),
        max: values.iter().copied().fold(f64::NEG_INFINITY, f64::max),
    })
}

fn hash_error(e: impl std::fmt::Display) -> CompileError {
    CompileError::internal(format!("content hash: {e}"))
}

/// `resumeKey`: reuse a previous cell only when every part of its replay key
/// still holds. The seed alone is not enough: it does not move when the
/// matcher or the engine changes.
fn try_resume(cell: &PlannedCell, expect: &ResumeKey<'_>) -> Option<JsValue> {
    let paths = cell.options.paths();
    let exists = |p: &str| Path::new(p).exists();
    if !exists(&paths.result) || !exists(&paths.instance) {
        return None;
    }
    let result = JsValue::parse(&std::fs::read_to_string(&paths.result).ok()?).ok()?;
    if result.get("status").and_then(JsValue::as_str) != Some("ok")
        || result.get("paramSeed").and_then(JsValue::as_str) != Some(cell.expected_seed.as_str())
    {
        return None;
    }
    let instance = JsValue::parse(&std::fs::read_to_string(&paths.instance).ok()?).ok()?;
    let key = instance.at(&["manifest", "replayKey"])?;
    if !key.truthy() {
        return None;
    }
    let is = |name: &str, expected: &str| key.get(name).and_then(JsValue::as_str) == Some(expected);
    if !is("templateDigest", expect.template_digest)
        || !is("matcherVersion", MATCH_SEMANTICS_VERSION)
        || !is("solverVersion", simforge_bindings_common::ENGINE_SEM_VER)
        || !is("matcherIndexDigest", expect.matcher_index_digest)
        || !is("engineGraphDigest", expect.engine_graph_digest)
        || !is("paramSeed", &cell.expected_seed)
    {
        return None;
    }
    // A cell simulated on an empty road does not answer the same question as
    // one in traffic; an instance without the field recorded no population.
    let ambient = match key.get("ambientProfileHash") {
        None | Some(JsValue::Null) => Some("none"),
        Some(JsValue::String(s)) => Some(s.as_str()),
        Some(_) => None,
    };
    if ambient != Some(expect.ambient_profile_hash) {
        return None;
    }
    if cell.options.write_trace && !exists(&paths.trace) {
        return None;
    }
    Some(result)
}

/// Run `cells` over `concurrency` threads; results by cell index.
fn run_pool(
    root: &MapRoot,
    template: &TemplateFile,
    cells: &[&PlannedCell],
    concurrency: usize,
) -> Vec<JsValue> {
    let next = AtomicUsize::new(0);
    let out: Mutex<Vec<Option<JsValue>>> = Mutex::new(vec![None; cells.len()]);
    std::thread::scope(|scope| {
        for _ in 0..concurrency {
            scope.spawn(|| loop {
                let i = next.fetch_add(1, Ordering::SeqCst);
                let Some(cell) = cells.get(i) else { break };
                let result = run_cell(root, template, &cell.options);
                let value = JsValue::from_serialize(&result).unwrap_or(JsValue::Null);
                out.lock().expect("batch results")[i] = Some(value);
            });
        }
    });
    out.into_inner()
        .expect("batch results")
        .into_iter()
        .map(|v| v.unwrap_or(JsValue::Null))
        .collect()
}

/// The default worker count: `min(4, cpus - 1)`, at least 1.
fn default_concurrency() -> i64 {
    let cpus = std::thread::available_parallelism().map_or(1, |n| n.get()) as i64;
    4.min((cpus - 1).max(1))
}

/// The `batch` document (stdout) and whether any cell ran. Writes the cells
/// and `<out>/batch-summary.json`.
pub fn run_batch(root: &MapRoot, file: &Path, options: &BatchOptions) -> Result<(Value, bool), CompileError> {
    let started = Instant::now();
    let template = read_template(file)?;
    let typed = &template.template;
    let match_options = SiteMatchOptions {
        min_score: options.min_score,
        max_sites: options.max_sites,
        exact_catalog_site_resolution: false,
    };
    let mut matches = Vec::with_capacity(options.map_ids.len());
    for map_id in &options.map_ids {
        let map = root.load(map_id)?;
        let matched = match_on_map(typed, map.bundle(), &match_options)?;
        matches.push((map, matched));
    }

    let tid = typed.template_id().to_owned();
    let pv = params_version(typed);
    let template_digest = content_hash_of(typed).map_err(hash_error)?[..16].to_owned();

    // One resolved profile for every cell and the replay key.
    let settle = match &options.ambient {
        None => 0.0,
        Some(_) => options.ambient_settle_seconds.unwrap_or(0.0),
    };
    let resolved = options
        .ambient
        .as_ref()
        .map(resolve_ambient_traffic_profile)
        .transpose()?;
    let ambient_profile_hash = match &resolved {
        None => "none".to_owned(),
        Some(r) if serde_json::to_value(r.preset).ok() == Some(Value::String("off".into())) => "none".to_owned(),
        Some(r) => {
            let hash = content_hash_of(r).map_err(hash_error)?;
            if settle > 0.0 {
                format!("{hash}+settle{}", js_number_to_string(settle))
            } else {
                hash
            }
        }
    };

    let mut per_map = Vec::with_capacity(matches.len());
    let mut planned: Vec<PlannedCell> = Vec::new();
    let seed_root = typed.simulation.as_ref().map_or(tid.as_str(), |s| s.seed.as_str());
    for (map, matched) in &matches {
        per_map.push(MapSites {
            map_id: matched.map_id.clone(),
            sites: matched.report.sites.len(),
            matcher_index_digest: map.bundle().index().topology_digest.clone(),
            engine_graph_digest: map.graph().topology_digest().to_owned(),
        });
        for site in &matched.report.sites {
            for draw in 0..options.draws.max(0) {
                let mut cell = CellOptions::new(&matched.map_id, &site.site_id, draw, &options.out_dir);
                cell.write_trace = options.write_trace;
                cell.filter = options.filter;
                cell.trivial_ttc_s = options.trivial_ttc_s;
                cell.ambient = options.ambient.clone();
                cell.ambient_settle_seconds = (settle > 0.0).then_some(settle);
                planned.push(PlannedCell {
                    options: cell,
                    // The compiler seeds from the pinned `simulation.seed`, else the template id.
                    expected_seed: cell_seed(seed_root, &pv, &site.site_id, draw),
                });
            }
        }
    }
    // Sorted plan -> sorted summary, whatever order the pool finishes in.
    planned.sort_by(|a, b| {
        cmp_utf16(&a.options.map_id, &b.options.map_id)
            .then_with(|| cmp_utf16(&a.options.site_id, &b.options.site_id))
            .then_with(|| a.options.draw_index.cmp(&b.options.draw_index))
    });

    let digests: HashMap<&str, (&str, &str)> = matches
        .iter()
        .map(|(map, matched)| {
            (
                matched.map_id.as_str(),
                (map.bundle().index().topology_digest.as_str(), map.graph().topology_digest()),
            )
        })
        .collect();
    let mut results: Vec<Option<JsValue>> = vec![None; planned.len()];
    let mut todo: Vec<usize> = Vec::new();
    let mut resumed = 0usize;
    for (i, cell) in planned.iter().enumerate() {
        if !options.force {
            let (matcher_index_digest, engine_graph_digest) =
                digests.get(cell.options.map_id.as_str()).copied().unwrap_or(("", ""));
            let expect = ResumeKey {
                template_digest: &template_digest,
                matcher_index_digest,
                engine_graph_digest,
                ambient_profile_hash: &ambient_profile_hash,
            };
            if let Some(reused) = try_resume(cell, &expect) {
                results[i] = Some(reused);
                resumed += 1;
                continue;
            }
        }
        todo.push(i);
    }

    let requested = options.concurrency.unwrap_or_else(default_concurrency);
    let concurrency = requested.min(todo.len().max(1) as i64).max(1) as usize;
    let cells: Vec<&PlannedCell> = todo.iter().map(|&i| &planned[i]).collect();
    let fresh = run_pool(root, &template, &cells, concurrency);
    for (&i, value) in todo.iter().zip(fresh) {
        results[i] = Some(value);
    }
    let ordered: Vec<JsValue> = results.into_iter().flatten().collect();

    let mut bands: Vec<(String, JsValue)> = Vec::new();
    for r in &ordered {
        let band = match r.get("band") {
            Some(JsValue::String(s)) => s.clone(),
            Some(JsValue::Null) | None => "unknown".to_owned(),
            Some(other) => to_compact_js(other).unwrap_or_default(),
        };
        match bands.iter_mut().find(|(k, _)| *k == band) {
            Some((_, JsValue::Number(n))) => *n += 1.0,
            _ => bands.push((band, JsValue::Number(1.0))),
        }
    }
    let accepted = ordered
        .iter()
        .filter(|r| r.get("verdict").and_then(JsValue::as_str) == Some("accept"))
        .count();
    let infeasible = ordered
        .iter()
        .filter(|r| {
            !r.get("feasible").is_some_and(JsValue::truthy)
                || r.get("status").and_then(JsValue::as_str) == Some("error")
        })
        .count();
    let numbers = |path: &[&str]| -> Vec<f64> {
        ordered.iter().filter_map(|r| r.at(path).and_then(JsValue::as_f64)).collect()
    };
    let ttcs = numbers(&["metrics", "minTTC", "value"]);
    let ambient_counts = numbers(&["ambient", "actorCount"]);
    let ambient_near = numbers(&["ambient", "nearSubjectAtT0"]);

    let summary_file = paths::join(&[&options.out_dir, "batch-summary.json"]);
    let summary = BatchSummary {
        kind: "scenario-batch-summary",
        version: 1,
        template: paths::resolve(file).display().to_string(),
        template_id: tid,
        template_digest,
        params_version: pv,
        matcher_version: MATCH_SEMANTICS_VERSION,
        solver_version: simforge_bindings_common::ENGINE_SEM_VER,
        archetype: typed.meta.archetype.clone(),
        negative_control: typed.meta.negative_control,
        maps: per_map,
        draws: options.draws,
        ambient: resolved.map(|profile| AmbientSummary {
            profile,
            profile_hash: ambient_profile_hash.clone(),
            cells_with_ambient: ambient_counts.iter().filter(|&&v| v > 0.0).count(),
            actors_per_cell: spread(&ambient_counts),
            near_subject_at_t0: spread(&ambient_near),
        }),
        cells: ordered.len(),
        resumed,
        concurrency,
        elapsed_ms: started.elapsed().as_millis() as u64,
        criticality: Criticality {
            accepted,
            rejected: ordered.len() - accepted,
            infeasible,
            bands: JsValue::object(bands),
            min_ttc: (!ttcs.is_empty()).then(|| TtcSpread {
                min: round3(ttcs.iter().copied().fold(f64::INFINITY, f64::min)),
                median: round3(median(&ttcs)),
                max: round3(ttcs.iter().copied().fold(f64::NEG_INFINITY, f64::max)),
                n: ttcs.len(),
            }),
        },
        results: ordered,
    };
    write_json_file(Path::new(&summary_file), &summary)?;

    let mut payload = JsValue::from_serialize(&summary)?;
    payload.set(
        "summaryFile",
        JsValue::String(paths::resolve(Path::new(&summary_file)).display().to_string()),
    );
    let any = summary.cells > 0;
    Ok((payload.to_value(), any))
}
