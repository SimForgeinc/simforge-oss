//! The deterministic, map-grounded authoring catalog (`catalog create`,
//! `catalog verify`).
//!
//! A slot is not a claim that a scenario was simulated or visually accepted.
//! `authored` means the incident mechanism, actors, event sequence, real map
//! site, operational variant, provenance and acceptance contract exist;
//! evidence states advance only when their artifacts exist.
//!
//! Every digest here is `sha256(JSON.stringify(value))` with the key order
//! the TypeScript catalog used, so catalogs created by either implementation
//! verify under both. Values are built as [`js::Js`] objects in literal key
//! order, and files are read back with the order-preserving parser.

pub mod closure;
pub mod js;
pub mod taxonomy;
pub mod templates;
pub mod verify;

use std::collections::{BTreeSet, HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{json, Map, Value};
use simforge_bindings_common::runtime::MapAsset;
use simforge_compiler::anchor::MatchedSite;
use simforge_compiler::materialize::CatalogVariantApplication;
use simforge_compiler::sites::{match_on_map, SiteMatchOptions};
use simforge_compiler::{instantiate, CompileError, MaterializeOptions, SiteSelection};
use simforge_core::hash::{cmp_locale, cmp_utf16, sha256, sha256_bytes};

use crate::maps::{MapRoot, DERIVED_FILE, LOCATIONS_FILE};
use crate::paths::resolve;
use closure::matcher_site_closes_location;
use js::{is_str, number_to_string, object, strings, to_js_string, truthy, Js};
use taxonomy::{taxonomy, Incident};

/// Historical kind retained for stored-data compatibility.
pub const CATALOG_KIND: &str = "uniscenarios-scenario-catalog";
pub const CATALOG_VERSION: f64 = 2.0;
pub const CATALOG_GENERATOR_VERSION: &str = "2.0.0";
pub const CATALOG_SLOTS_PER_MAP: usize = 100;
pub const CATALOG_MIN_INCIDENT_TYPES_PER_MAP: usize = 3;
pub const DEFAULT_CATALOG_NAMESPACE: &str = "simforge-active-maps-v3";
pub const CATALOG_GENERATOR: &str = "@simforge-oss/cli catalog create";

/// Materialisation findings that make one exact location/site pair
/// ineligible (the mechanism itself stays eligible).
const CANDIDATE_MATERIALIZATION_FINDINGS: [&str; 12] = [
    "arrival_conflict_unclosed",
    "arrival_unconverged",
    "map_control_missing",
    "movement_priority_missing",
    "movement_stop_missing",
    "no_actors",
    "reference_route_unbuildable",
    "role_unbound",
    "route_turn_mismatch",
    "route_turn_unbindable",
    "route_unbuildable",
    "signal_unbindable",
];

/// The codes `simforge-compiler` raises as findings (`.as_findings()`, exit
/// 2): a materialisation that fails with one of them rules out that exact
/// pair, not the catalog. Built from
/// `grep -rn "as_findings()" native/crates/simforge-compiler/src`; the
/// `compiler_finding_codes_are_complete` test re-derives it from the source
/// so the two cannot drift. The TypeScript catalog carries the same list
/// (`COMPILER_FINDING_CODES` in packages/cli/src/catalog.ts), because the
/// N-API error it sees has lost the findings flag.
pub const COMPILER_FINDING_CODES: [&str; 45] = [
    "actor_catalog_class_mismatch",
    "actor_unknown",
    "arrival_conflict_unclosed",
    "arrival_unconverged",
    "bylatest_required",
    "control_feature_unbound",
    "control_lane_unbound",
    "control_stop_line_unprojectable",
    "control_unbound",
    "delivery_geometry_unclosed",
    "dynamics_required",
    "invalid_data",
    "lane_offset_unavailable",
    "lane_offset_unroutable",
    "near_miss_actor_unavailable",
    "near_miss_clearance_unresolved",
    "near_miss_infeasible_speed",
    "near_miss_invalid_trajectory",
    "near_miss_invalid_window",
    "near_miss_trigger_unresolved",
    "near_miss_unsolvable",
    "near_miss_would_collide",
    "no_actors",
    "observation_unresolved",
    "observation_unsupported",
    "preserved_entity_changed",
    "reference_unknown",
    "revision_overflow",
    "role_binding_dropped",
    "role_binding_missing",
    "role_reference_cycle",
    "role_reference_unmaterialized",
    "role_semantic_projection_failed",
    "role_unbound",
    "route_unbuildable",
    "sensor_actor_unavailable",
    "situation_invalid",
    "stale_digest",
    "stale_revision",
    "surface_patch_feature_unbound",
    "surface_patch_unplaceable",
    "template_invalid",
    "template_operation_failed",
    "terminating_lane_merge_unclosed",
    "too_small",
];

/// Whether a failed materialisation of one exact pair only rules out that
/// pair. Anything else aborts catalog creation.
pub fn is_candidate_failure(error: &CompileError) -> bool {
    let code = error.code.as_str();
    CANDIDATE_MATERIALIZATION_FINDINGS.contains(&code) || COMPILER_FINDING_CODES.contains(&code)
}

pub const ALL_EVIDENCE: [&str; 7] = [
    "instance",
    "trace",
    "result",
    "renderManifest",
    "frame",
    "video",
    "visualInspection",
];

pub(crate) fn findings(code: &str, path: impl Into<String>, reason: impl Into<String>) -> CompileError {
    CompileError::at(code, path, reason).as_findings()
}

fn detail(error: CompileError, entries: Value) -> CompileError {
    let mut error = error;
    if let Value::Object(map) = entries {
        for (k, v) in map {
            error = error.detail_entry(&k, v);
        }
    }
    error
}

/// `/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/`.
pub fn is_safe_map_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    let edge = |b: u8| b.is_ascii_lowercase() || b.is_ascii_digit();
    match bytes.len() {
        0 => false,
        1 => edge(bytes[0]),
        n => {
            n <= 64
                && edge(bytes[0])
                && edge(bytes[n - 1])
                && bytes[1..n - 1].iter().all(|b| edge(*b) || *b == b'-')
        }
    }
}

/* ------------------------------------------------------------ derivations */

/// `catalogDesignDigest(slot)`: the authored coordinates, without lifecycle
/// and review state.
pub fn design_digest(slot: &Js) -> String {
    sha256(&slot.without(&["designDigest", "status", "acceptance"]).stringify())
}

/// `sha256(JSON.stringify(manifestWithoutDigest))`.
pub fn digest_payload(without_digest: &Js) -> String {
    sha256(&without_digest.stringify())
}

/// `sha256(JSON.stringify({id, handle, type, tags, affordances, anchor, quality}))`
/// over the location's own values (absent members are omitted, as
/// `JSON.stringify` omits `undefined`).
fn stable_location_digest(location: &Js) -> String {
    let entries = ["id", "handle", "type", "tags", "affordances", "anchor", "quality"]
        .into_iter()
        .filter_map(|k| location.get(k).map(|v| (k.to_owned(), v.clone())))
        .collect();
    sha256(&Js::Object(entries).stringify())
}

/// The map provenance a seed depends on.
#[derive(Debug, Clone)]
pub struct SeedMap<'a> {
    pub map_id: Option<&'a Js>,
    pub catalog_revision: Option<&'a Js>,
    pub matcher_index_digest: Option<&'a Js>,
    pub engine_graph_digest: Option<&'a Js>,
    pub location_catalog_digest: Option<&'a Js>,
}

impl<'a> SeedMap<'a> {
    pub fn of(map: &'a Js) -> Self {
        Self {
            map_id: map.get("mapId"),
            catalog_revision: map.get("catalogRevision"),
            matcher_index_digest: map.get("matcherIndexDigest"),
            engine_graph_digest: map.get("engineGraphDigest"),
            location_catalog_digest: map.get("locationCatalogDigest"),
        }
    }
}

/// `Array.prototype.join` element conversion: `null`/`undefined` -> `""`.
fn join_part(value: Option<&Js>) -> String {
    match value {
        None | Some(Js::Null) => String::new(),
        other => to_js_string(other),
    }
}

/// `sha256([generator, namespace, map..., ordinal, incident, site, variant, taxonomy].join('\0'))`.
#[allow(clippy::too_many_arguments)]
pub fn catalog_seed(
    namespace: Option<&Js>,
    map: &SeedMap<'_>,
    ordinal: f64,
    incident_id: &str,
    location_id: Option<&Js>,
    source_digest: Option<&Js>,
    variant_id: Option<&Js>,
    taxonomy_hash: &str,
) -> String {
    let parts = [
        CATALOG_GENERATOR_VERSION.to_owned(),
        join_part(namespace),
        join_part(map.map_id),
        join_part(map.catalog_revision),
        join_part(map.matcher_index_digest),
        join_part(map.engine_graph_digest),
        join_part(map.location_catalog_digest),
        number_to_string(ordinal),
        incident_id.to_owned(),
        join_part(location_id),
        join_part(source_digest),
        join_part(variant_id),
        taxonomy_hash.to_owned(),
    ];
    sha256(&parts.join("\0"))
}

/// `<map>-<ordinal+1, 3 digits>-<mechanism>-<seed[0..12]>`.
pub fn catalog_identity(map_id: &str, ordinal: f64, incident_id: &str, seed: &str) -> String {
    let last = incident_id.rsplit('.').next().unwrap_or("scenario");
    let mut mechanism = String::with_capacity(last.len());
    let mut in_run = false;
    for c in last.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            mechanism.push(c);
            in_run = false;
        } else if !in_run {
            mechanism.push('-');
            in_run = true;
        }
    }
    let number = number_to_string(ordinal + 1.0);
    let padded = if number.chars().count() < 3 {
        format!("{}{number}", "0".repeat(3 - number.chars().count()))
    } else {
        number
    };
    let prefix: String = seed.chars().take(12).collect();
    format!("{map_id}-{padded}-{mechanism}-{prefix}")
}

/// `path.posix.normalize` for relative paths without `..` escaping the root.
pub(crate) fn posix_normalize(path: &str) -> String {
    let absolute = path.starts_with('/');
    let mut out: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if out.last().is_some_and(|p| *p != "..") {
                    out.pop();
                } else if !absolute {
                    out.push("..");
                }
            }
            other => out.push(other),
        }
    }
    let joined = out.join("/");
    match (absolute, joined.is_empty()) {
        (true, _) => format!("/{joined}"),
        (false, true) => ".".to_owned(),
        (false, false) => joined,
    }
}

fn evidence_paths(evidence_root: &str, map_id: &str, identity: &str) -> Js {
    let base = posix_normalize(&format!("{evidence_root}/{map_id}/{identity}"));
    object([
        ("instance", format!("{base}/instance.json").into()),
        ("trace", format!("{base}/trace.json.gz").into()),
        ("result", format!("{base}/result.json").into()),
        ("renderManifest", format!("{base}/render/manifest.json").into()),
        ("frame", format!("{base}/render/frame.png").into()),
        ("video", format!("{base}/render/video.mp4").into()),
        ("visualInspection", format!("{base}/render/visual-inspection.json").into()),
    ])
}

fn assert_relative_root(value: &str) -> Result<String, CompileError> {
    let replaced = value.replace('\\', "/");
    let normalized = replaced.trim_end_matches('/').to_owned();
    let drive = normalized.len() >= 3
        && normalized.as_bytes()[0].is_ascii_alphabetic()
        && &normalized[1..3] == ":/";
    if normalized.is_empty()
        || normalized == "."
        || normalized.starts_with('/')
        || drive
        || normalized.split('/').any(|p| p == "..")
    {
        return Err(CompileError::at(
            "bad_value",
            "--evidence-root",
            "--evidence-root must be a non-empty relative path without ..",
        ));
    }
    Ok(normalized)
}

fn acceptance_checks() -> Js {
    let check = |id: &str, kind: &str, criterion: &str, key: &str| {
        object([
            ("id", id.into()),
            ("kind", kind.into()),
            ("criterion", criterion.into()),
            ("state", "pending".into()),
            ("evidenceKey", key.into()),
        ])
    };
    Js::Array(vec![
        check("schema", "automated", "Concrete instance passes the versioned scenario schema.", "instance"),
        check("site-grounding", "automated", "Map, matcher index, engine graph, location ID, road anchor, and source digests remain exact.", "catalog"),
        check("determinism", "automated", "Repeated generation and simulation produce identical normalized output for the recorded seed.", "trace"),
        check("kinematics", "automated", "Actor speeds, accelerations, paths, clearances, trigger ordering, and conflict timing pass incident-specific plausibility limits.", "result"),
        check("render-integrity", "automated", "Rendered frames use the pinned map and actors, cover pre-reveal through aftermath, and contain no missing/off-map/overlapping assets.", "renderManifest"),
        check("visual-realism", "manual", "A named reviewer inspects stills and video in Studio and accepts site fit, actor intent, occlusion, timing, motion, continuity, and real-world plausibility.", "visualInspection"),
    ])
}

fn acceptance_criteria(incident: &Incident) -> Js {
    strings(&[
        format!("The authored sequence is visibly present: {}", incident.event_sequence.join(" \u{2192} ")),
        format!("Critical observables are measured: {}.", incident.criticality.join(", ")),
        "Every dynamic actor follows a continuous, lane/site-compatible path with plausible speed, acceleration, and response timing.".to_owned(),
        "The conflict is challenging but not created by teleportation, impossible overlap, wrong-way geometry, or an unavoidable initial state.".to_owned(),
        "Pre-reveal, reveal, conflict, and aftermath are visible in the evidence bundle and pass named Studio review.".to_owned(),
    ])
}

/// `progressFor(slots, target)`: counts derived from slot states. A slot
/// that is not an object has no status; `null` throws, as in the reference.
pub fn progress_for(slots: &[Js], target: f64) -> Result<Js, CompileError> {
    let mut statuses: Vec<Option<&str>> = Vec::with_capacity(slots.len());
    for slot in slots {
        if matches!(slot, Js::Null) {
            return Err(CompileError::new(
                "internal_error",
                "TypeError: Cannot read properties of null (reading 'status')",
            ));
        }
        statuses.push(slot.get("status").and_then(Js::as_str));
    }
    let at_least = |set: &[&str]| statuses.iter().filter(|s| s.is_some_and(|s| set.contains(&s))).count();
    Ok(object([
        ("target", target.into()),
        ("planned", 0usize.into()),
        ("authored", slots.len().into()),
        ("generated", at_least(&["generated", "simulated", "rendered", "visually-accepted"]).into()),
        ("simulated", at_least(&["simulated", "rendered", "visually-accepted"]).into()),
        ("rendered", at_least(&["rendered", "visually-accepted"]).into()),
        ("visuallyAccepted", at_least(&["visually-accepted"]).into()),
        ("rejected", at_least(&["rejected"]).into()),
    ]))
}

/// Recompute every derived field after lifecycle changes (`status`):
/// per-slot design digests, progress counts and the catalog digest.
pub fn refresh_catalog(catalog: &Js, slots: Vec<Js>) -> Result<Js, CompileError> {
    let refreshed: Vec<Js> = slots
        .into_iter()
        .map(|slot| {
            let digest = design_digest(&slot);
            let mut out = slot.without(&["designDigest"]);
            out.set("designDigest", digest.into());
            out
        })
        .collect();
    let target = catalog
        .get("contract")
        .and_then(|c| c.get("totalSlots"))
        .and_then(Js::as_f64)
        .unwrap_or(f64::NAN);
    let progress = progress_for(&refreshed, target)?;
    let mut rest = catalog.without(&["catalogDigest", "slots", "progress"]);
    rest.set("slots", Js::Array(refreshed));
    rest.set("progress", progress);
    let digest = digest_payload(&rest);
    rest.set("catalogDigest", digest.into());
    Ok(rest)
}

/* ------------------------------------------------------------------ create */

#[derive(Debug, Clone, Default)]
pub struct CreateOptions {
    /// Installed maps to include; `None` = every complete installed map.
    pub map_ids: Option<Vec<String>>,
    pub namespace: Option<String>,
    /// Relative to the catalog file.
    pub evidence_root: Option<String>,
    /// Fail (`incomplete_mechanism_coverage`, exit 2) when the selected maps
    /// cannot cover every taxonomy mechanism. Off by default: the catalog is
    /// written and the gap reported as `coverage` (no installed map set
    /// covers the whole taxonomy today).
    pub require_full_coverage: bool,
}

/// A created catalog and, when it does not cover every taxonomy mechanism,
/// the gap: `{missing: [incidentId...], materializationFailures: {id: [...]}}`.
#[derive(Debug, Clone)]
pub struct Created {
    pub catalog: Js,
    pub coverage: Option<Value>,
}

/// One executable registry template.
struct Executable {
    provenance: Js,
    runtime_template_id: String,
    source: String,
    digest: String,
    document: Value,
    template: simforge_compiler::ScenarioTemplate,
}

fn read_executable_templates() -> Result<Vec<Executable>, CompileError> {
    taxonomy()
        .templates
        .iter()
        .map(|entry| {
            let bytes = templates::template_bytes(&entry.source).ok_or_else(|| {
                CompileError::at(
                    "file_not_found",
                    entry.source.clone(),
                    format!("cannot read catalog template {}", entry.source),
                )
            })?;
            let document: Value = serde_json::from_slice(bytes).map_err(|e| {
                CompileError::at("invalid_json", entry.source.clone(), e.to_string())
            })?;
            let template = crate::template::parse_template_issues(&document).map_err(|issues| {
                findings(
                    "template_invalid",
                    entry.source.clone(),
                    "the document is not a valid v2 scenario template",
                )
                .detail_entry("issues", json!(issues))
            })?;
            let digest = sha256_bytes(bytes);
            let runtime_template_id = template.template_id().to_owned();
            Ok(Executable {
                provenance: object([
                    ("id", entry.id.clone().into()),
                    ("runtimeTemplateId", runtime_template_id.clone().into()),
                    ("source", entry.source.clone().into()),
                    ("digest", digest.clone().into()),
                ]),
                runtime_template_id,
                source: entry.source.clone(),
                digest,
                document,
                template,
            })
        })
        .collect()
}

pub(crate) fn unzip(bytes: Vec<u8>) -> std::io::Result<Vec<u8>> {
    if bytes.len() >= 2 && bytes[0] == 0x1f && bytes[1] == 0x8b {
        let mut out = Vec::with_capacity(bytes.len() * 4);
        flate2::read::MultiGzDecoder::new(&bytes[..]).read_to_end(&mut out)?;
        Ok(out)
    } else {
        Ok(bytes)
    }
}

/// A map's catalog provenance plus its raw locations.
struct MapContext {
    map_id: String,
    provenance: Js,
    locations: Vec<Js>,
    asset: Arc<MapAsset>,
}

fn read_map_context(dev_assets: &Path, map_id: &str, asset: Arc<MapAsset>) -> Result<MapContext, CompileError> {
    let dir = dev_assets.join(map_id);
    let dir_text = dir.display().to_string();
    let (derived_bytes, location_bytes) = match (
        std::fs::read(dir.join(DERIVED_FILE)),
        std::fs::read(dir.join(LOCATIONS_FILE)),
    ) {
        (Ok(d), Ok(l)) => (d, l),
        _ => {
            return Err(CompileError::at(
                "missing_map_provenance",
                dir_text,
                format!("cannot read complete map provenance for {map_id}"),
            )
            .detail_entry(
                "hint",
                Value::String("run `pnpm --filter @simforge-oss/maps build:map -- --all`".into()),
            ))
        }
    };
    let invalid = |reason: String| CompileError::at("invalid_map_provenance", dir_text.clone(), reason);
    let parse = |bytes: Vec<u8>| -> Result<(Js, Vec<u8>), CompileError> {
        let plain = unzip(bytes).map_err(|e| invalid(e.to_string()))?;
        let text = String::from_utf8_lossy(&plain).into_owned();
        let value = Js::parse(&text).map_err(invalid)?;
        Ok((value, plain))
    };
    let (derived, _) = parse(derived_bytes)?;
    let (catalog, location_plain) = parse(location_bytes)?;
    let catalog_map_asset = catalog.get("mapAssetId");
    let valid = is_str(derived.get("mapId"), map_id)
        && is_str(catalog.get("mapId"), map_id)
        && catalog_map_asset.and_then(Js::as_str).is_some()
        && catalog.get("catalogRevision").and_then(Js::as_str).is_some()
        && catalog.get("locations").and_then(Js::as_array).is_some();
    if !valid {
        return Err(invalid(format!("{map_id} is missing stable map/location provenance"))
            .detail_entry("expectedMapId", Value::String(map_id.to_owned())));
    }
    if let Some(derived_asset) = derived.get("mapAssetId") {
        if !js::strict_eq(Some(derived_asset), catalog_map_asset) {
            return Err(invalid(format!("{map_id} map asset IDs disagree across provenance domains")));
        }
    }
    let matcher_index_digest = asset.bundle().index().topology_digest.clone();
    let engine_graph_digest = asset.bundle().graph().topology_digest().to_owned();
    if matcher_index_digest.is_empty() || engine_graph_digest.is_empty() {
        return Err(invalid(format!("{map_id} lacks concrete matcher/engine replay digests")));
    }
    let provenance = object([
        ("mapId", map_id.into()),
        ("mapAssetId", catalog_map_asset.cloned().into()),
        ("catalogRevision", catalog.get("catalogRevision").cloned().into()),
        ("matcherIndexDigest", matcher_index_digest.into()),
        ("engineGraphDigest", engine_graph_digest.into()),
        ("locationCatalogDigest", sha256_bytes(&location_plain).into()),
        ("slots", CATALOG_SLOTS_PER_MAP.into()),
    ]);
    let locations = catalog
        .get("locations")
        .and_then(Js::as_array)
        .cloned()
        .unwrap_or_default();
    Ok(MapContext {
        map_id: map_id.to_owned(),
        provenance,
        locations,
        asset,
    })
}

fn string_list(value: Option<&Js>) -> Vec<&Js> {
    value.and_then(Js::as_array).map(|a| a.iter().collect()).unwrap_or_default()
}

fn includes_str(values: &[&Js], needle: &str) -> bool {
    values.iter().any(|v| is_str(Some(v), needle))
}

fn location_matches(location: &Js, incident: &Incident) -> bool {
    let road = location
        .get("anchor")
        .and_then(|a| a.get("road"))
        .filter(|r| truthy(Some(r)));
    let is_num = |k: &str| road.and_then(|r| r.get(k)).and_then(Js::as_f64).is_some();
    let ok = location.get("id").and_then(Js::as_str).is_some()
        && location.get("handle").and_then(Js::as_str).is_some()
        && location.get("name").and_then(Js::as_str).is_some()
        && location
            .get("type")
            .and_then(Js::as_str)
            .is_some_and(|t| incident.site_types.iter().any(|s| s == t))
        && road.and_then(|r| r.get("rsl")).and_then(Js::as_str).is_some()
        && is_num("s")
        && is_num("offsetM")
        && is_num("headingRad");
    if !ok {
        return false;
    }
    let affordances = string_list(location.get("affordances"));
    incident
        .required_affordances
        .iter()
        .all(|a| includes_str(&affordances, a))
}

fn string_items(value: Option<&Js>) -> Js {
    Js::Array(
        value
            .and_then(Js::as_array)
            .map(|a| a.iter().filter(|v| matches!(v, Js::String(_))).cloned().collect())
            .unwrap_or_default(),
    )
}

fn bind_site(location: &Js) -> Js {
    let road = location.get("anchor").and_then(|a| a.get("road"));
    let quality = location.get("quality");
    let anchor_quality = match quality.and_then(|q| q.get("anchor")) {
        None | Some(Js::Null) => "unknown".to_owned(),
        other => to_js_string(other),
    };
    let confidence = quality
        .and_then(|q| q.get("confidence"))
        .and_then(Js::as_f64)
        .unwrap_or(0.0);
    let num = |k: &str| road.and_then(|r| r.get(k)).and_then(Js::as_f64).unwrap_or(f64::NAN);
    object([
        ("locationId", to_js_string(location.get("id")).into()),
        ("handle", to_js_string(location.get("handle")).into()),
        ("name", to_js_string(location.get("name")).into()),
        ("type", to_js_string(location.get("type")).into()),
        ("tags", string_items(location.get("tags"))),
        ("affordances", string_items(location.get("affordances"))),
        ("anchorQuality", anchor_quality.into()),
        ("confidence", confidence.into()),
        (
            "roadAnchor",
            object([
                ("rsl", to_js_string(road.and_then(|r| r.get("rsl"))).into()),
                ("s", num("s").into()),
                ("offsetM", num("offsetM").into()),
                ("headingRad", num("headingRad").into()),
            ]),
        ),
        ("sourceDigest", stable_location_digest(location).into()),
    ])
}

fn site_score(location: &Js, incident: &Incident) -> f64 {
    let tags = string_list(location.get("tags"));
    let preferred = incident
        .preferred_tags
        .iter()
        .filter(|tag| includes_str(&tags, tag))
        .count() as f64;
    let quality = location.get("quality");
    let exact = if is_str(quality.and_then(|q| q.get("anchor")), "exact") { 2.0 } else { 0.0 };
    let confidence = quality
        .and_then(|q| q.get("confidence"))
        .and_then(Js::as_f64)
        .unwrap_or(0.0);
    preferred * 10.0 + exact + confidence
}

/// `b - a` as a sort key: descending by score, NaN compares equal (as a
/// JavaScript comparator returning NaN does).
fn desc(a: f64, b: f64) -> std::cmp::Ordering {
    let d = b - a;
    if d > 0.0 {
        std::cmp::Ordering::Greater
    } else if d < 0.0 {
        std::cmp::Ordering::Less
    } else {
        std::cmp::Ordering::Equal
    }
}

struct Candidate<'a> {
    location: &'a Js,
    site: MatchedSite,
}

struct Eligible<'a> {
    incident: &'a Incident,
    candidates: Vec<Candidate<'a>>,
}

fn variant_application(variant: &Js) -> CatalogVariantApplication {
    let s = |k: &str| to_js_string(variant.get(k));
    CatalogVariantApplication {
        id: s("id"),
        title: s("title"),
        weather: s("weather"),
        time_of_day: s("timeOfDay"),
        traffic: s("traffic"),
        visibility: s("visibility"),
    }
}

/// Exact location/matcher-site pairs per incident on one map.
fn eligible_on_map<'a>(
    context: &'a MapContext,
    executables: &'a HashMap<String, &'a Executable>,
) -> Result<Vec<Eligible<'a>>, CompileError> {
    let incidents: Vec<&Incident> = taxonomy()
        .incidents
        .iter()
        .filter(|incident| {
            incident.map_ids.as_ref().is_none_or(|ids| ids.contains(&context.map_id))
                && incident
                    .implementation_template_id
                    .as_ref()
                    .is_some_and(|id| executables.contains_key(id))
        })
        .collect();
    let bundle = context.asset.bundle();
    let options = SiteMatchOptions {
        min_score: None,
        max_sites: None,
        exact_catalog_site_resolution: true,
    };
    let index = bundle.index();
    let work = |incident: &'a Incident| -> Result<Option<Eligible<'a>>, CompileError> {
        let mut locations: Vec<&Js> = context
            .locations
            .iter()
            .filter(|l| location_matches(l, incident))
            .collect();
        locations.sort_by(|l, r| {
            desc(site_score(l, incident), site_score(r, incident)).then_with(|| {
                cmp_locale(&to_js_string(l.get("id")), &to_js_string(r.get("id")))
            })
        });
        let executable = executables[incident.implementation_template_id.as_ref().expect("filtered")];
        let matched = match_on_map(&executable.template, bundle, &options)?.report.sites;
        let mut candidates: Vec<Candidate<'a>> = Vec::new();
        for location in &locations {
            for site in &matched {
                if matcher_site_closes_location(site, location, index) {
                    candidates.push(Candidate { location, site: site.clone() });
                }
            }
        }
        candidates.sort_by(|l, r| {
            desc(
                site_score(l.location, incident) + l.site.score,
                site_score(r.location, incident) + r.site.score,
            )
            .then_with(|| cmp_locale(&to_js_string(l.location.get("id")), &to_js_string(r.location.get("id"))))
            .then_with(|| cmp_locale(&l.site.site_id, &r.site.site_id))
        });
        Ok((!candidates.is_empty()).then_some(Eligible { incident, candidates }))
    };
    let results = parallel_map(&incidents, |incident| work(incident));
    let mut out = Vec::new();
    for result in results {
        if let Some(entry) = result? {
            out.push(entry);
        }
    }
    Ok(out)
}

/// Map `f` over `items` on a few threads; results in input order.
fn parallel_map<T: Sync, R: Send>(items: &[T], f: impl Fn(&T) -> R + Sync) -> Vec<R> {
    let threads = std::thread::available_parallelism()
        .map_or(4, |n| n.get())
        .clamp(1, 8)
        .min(items.len().max(1));
    let next = std::sync::atomic::AtomicUsize::new(0);
    let slots: Vec<std::sync::Mutex<Option<R>>> = items.iter().map(|_| std::sync::Mutex::new(None)).collect();
    std::thread::scope(|scope| {
        for _ in 0..threads {
            scope.spawn(|| loop {
                let i = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                if i >= items.len() {
                    break;
                }
                let r = f(&items[i]);
                *slots[i].lock().expect("slot") = Some(r);
            });
        }
    });
    slots
        .into_iter()
        .map(|s| s.into_inner().expect("slot").expect("computed"))
        .collect()
}

/// Build exactly 100 deterministic, authored, map-grounded incident briefs
/// per map. `dev_assets_arg` is the maps root as the user gave it (error
/// paths quote it).
pub fn create_catalog(root: &MapRoot, dev_assets_arg: &str, options: &CreateOptions) -> Result<Created, CompileError> {
    let installed = root.available();
    let map_ids: Vec<String> = options.map_ids.clone().unwrap_or_else(|| installed.clone());
    let invalid: Vec<&String> = map_ids
        .iter()
        .enumerate()
        .filter(|(i, id)| {
            !is_safe_map_id(id)
                || map_ids.iter().position(|other| other == *id) != Some(*i)
                || !installed.contains(id)
        })
        .map(|(_, id)| id)
        .collect();
    if map_ids.is_empty() || !invalid.is_empty() {
        let reason = if map_ids.is_empty() {
            "catalog creation requires at least one installed map"
        } else {
            "catalog maps must be unique, safe, installed map names"
        };
        return Err(CompileError::at("bad_value", "--map", reason)
            .detail_entry("invalid", json!(invalid))
            .detail_entry("available", json!(installed)));
    }
    let namespace = options
        .namespace
        .clone()
        .unwrap_or_else(|| DEFAULT_CATALOG_NAMESPACE.to_owned());
    let evidence_root = assert_relative_root(options.evidence_root.as_deref().unwrap_or("evidence"))?;
    if namespace.trim().is_empty() {
        return Err(CompileError::at("bad_value", "--namespace", "--namespace must not be empty"));
    }

    let assets: Vec<Arc<MapAsset>> = parallel_map(&map_ids, |id| root.load(id))
        .into_iter()
        .collect::<Result<_, _>>()?;
    let executables = read_executable_templates()?;
    let contexts: Vec<MapContext> = map_ids
        .iter()
        .zip(assets)
        .map(|(id, asset)| read_map_context(&root.dir, id, asset))
        .collect::<Result<_, _>>()?;

    let by_registry: HashMap<String, &Executable> = taxonomy()
        .templates
        .iter()
        .zip(executables.iter())
        .map(|(entry, exe)| (entry.id.clone(), exe))
        .collect();
    let tax = taxonomy();
    let taxonomy_hash = tax.digest.as_str();
    let variant = tax.baseline_variant();
    let variant_id = variant.get("id").and_then(Js::as_str).unwrap_or_default().to_owned();
    let variant_apply = variant_application(variant);
    let namespace_js = Js::from(namespace.as_str());

    let mut slots: Vec<Js> = Vec::with_capacity(map_ids.len() * CATALOG_SLOTS_PER_MAP);
    let mut coverage: HashSet<String> = HashSet::new();
    // incident id -> failure strings, in first-insertion order.
    let mut failures_by_mechanism: HashMap<String, Vec<String>> = HashMap::new();
    let mut eligibility_by_map: Vec<Value> = Vec::new();
    let mut eligibility_counts: Vec<usize> = Vec::new();
    let mut breadth_failures: Vec<Value> = Vec::new();

    for context in &contexts {
        let map = &context.provenance;
        let seed_map = SeedMap::of(map);
        let eligible = eligible_on_map(context, &by_registry)?;
        let mut domains: Vec<&str> = Vec::new();
        for entry in &eligible {
            if !domains.contains(&entry.incident.domain.as_str()) {
                domains.push(&entry.incident.domain);
            }
        }
        eligibility_by_map.push(json!({
            "mapId": context.map_id,
            "incidentIds": eligible.iter().map(|e| &e.incident.id).collect::<Vec<_>>(),
            "domains": domains,
        }));
        eligibility_counts.push(eligible.len());

        // Insertion-ordered set of the mechanisms selected on this map.
        let mut selected_on_map: Vec<String> = Vec::new();
        for ordinal in 0..CATALOG_SLOTS_PER_MAP {
            let mut order: Vec<(usize, usize)> = (0..eligible.len())
                .map(|offset| ((ordinal + offset) % eligible.len(), offset))
                .collect();
            let breadth_pending = selected_on_map.len() < CATALOG_MIN_INCIDENT_TYPES_PER_MAP;
            order.sort_by(|(li, lo), (ri, ro)| {
                let l = &eligible[*li].incident.id;
                let r = &eligible[*ri].incident.id;
                coverage
                    .contains(l)
                    .cmp(&coverage.contains(r))
                    .then_with(|| {
                        if breadth_pending {
                            selected_on_map.contains(l).cmp(&selected_on_map.contains(r))
                        } else {
                            std::cmp::Ordering::Equal
                        }
                    })
                    .then_with(|| lo.cmp(ro))
            });
            let mut candidate_failures: Vec<Value> = Vec::new();
            let mut selected: Option<(&Eligible, &Candidate, Js, String)> = None;
            'selection: for (index, _) in &order {
                let entry = &eligible[*index];
                let executable = by_registry[entry.incident.implementation_template_id.as_ref().expect("eligible")];
                for candidate in &entry.candidates {
                    let site = bind_site(candidate.location);
                    let seed = catalog_seed(
                        Some(&namespace_js),
                        &seed_map,
                        ordinal as f64,
                        &entry.incident.id,
                        site.get("locationId"),
                        site.get("sourceDigest"),
                        Some(&Js::from(variant_id.as_str())),
                        taxonomy_hash,
                    );
                    let mut materialize = MaterializeOptions::new();
                    materialize.draw_index = 0;
                    materialize.seed = Some(seed.clone());
                    materialize.variant = Some(variant_apply.clone());
                    let site_id = candidate.site.site_id.as_str();
                    let failures = failures_by_mechanism.entry(entry.incident.id.clone()).or_default();
                    let mut record = |code: &str, text: String| {
                        candidate_failures.push(json!({ "siteId": site_id, "code": code }));
                        if !failures.contains(&text) {
                            failures.push(text);
                        }
                    };
                    match instantiate(
                        &executable.document,
                        context.asset.bundle(),
                        SiteSelection::Id(site_id),
                        &materialize,
                    ) {
                        Ok(result) if !result.manifest.feasible => {
                            let summary = result
                                .manifest
                                .issues
                                .iter()
                                .filter(|i| i.severity == simforge_core::error::SimIssueSeverity::Error)
                                .map(|i| format!("{}[{}]:{}", i.code, i.path, i.reason))
                                .collect::<Vec<_>>()
                                .join("|");
                            record(
                                "manifest_infeasible",
                                format!("{}:{site_id}:manifest_infeasible:{summary}", context.map_id),
                            );
                        }
                        Ok(_) => {
                            selected = Some((entry, candidate, site, seed));
                            break 'selection;
                        }
                        Err(error) if is_candidate_failure(&error) => {
                            record(&error.code, format!("{}:{site_id}:{}", context.map_id, error.code));
                        }
                        Err(error) => return Err(error),
                    }
                }
            }
            let Some((entry, candidate, site, seed)) = selected else {
                return Err(findings(
                    "no_materializable_catalog_pair",
                    format!("{}:{ordinal}", context.map_id),
                    "no exact location/matcher pair can materialize the reserved mechanism and variant",
                )
                .detail_entry("candidateFailures", Value::Array(candidate_failures)));
            };
            let incident = entry.incident;
            if !selected_on_map.contains(&incident.id) {
                selected_on_map.push(incident.id.clone());
            }
            coverage.insert(incident.id.clone());
            let identity = catalog_identity(&context.map_id, ordinal as f64, &incident.id, &seed);
            let executable = by_registry[incident.implementation_template_id.as_ref().expect("eligible")];
            let slot = object([
                ("identity", identity.clone().into()),
                ("ordinal", ordinal.into()),
                ("seed", seed.into()),
                ("mapId", context.map_id.clone().into()),
                ("status", "authored".into()),
                (
                    "provenance",
                    object([
                        ("namespace", namespace_js.clone()),
                        ("generatorVersion", CATALOG_GENERATOR_VERSION.into()),
                        ("mapCatalogRevision", map.get("catalogRevision").cloned().into()),
                        ("matcherIndexDigest", map.get("matcherIndexDigest").cloned().into()),
                        ("engineGraphDigest", map.get("engineGraphDigest").cloned().into()),
                        ("locationCatalogDigest", map.get("locationCatalogDigest").cloned().into()),
                        ("taxonomyDigest", taxonomy_hash.into()),
                        ("templateDigest", executable.digest.clone().into()),
                    ]),
                ),
                (
                    "scenario",
                    object([
                        ("incidentId", incident.id.clone().into()),
                        ("title", incident.title.clone().into()),
                        ("domain", incident.domain.clone().into()),
                        ("summary", incident.summary.clone().into()),
                        ("sourceIds", strings(&incident.source_ids)),
                    ]),
                ),
                ("site", site),
                ("variant", variant.clone()),
                (
                    "brief",
                    object([
                        ("actors", incident.row.get("actors").cloned().into()),
                        ("eventSequence", strings(&incident.event_sequence)),
                        ("criticality", strings(&incident.criticality)),
                        ("acceptanceCriteria", acceptance_criteria(incident)),
                    ]),
                ),
                (
                    "implementation",
                    object([
                        ("state", "template-backed".into()),
                        ("templateId", executable.runtime_template_id.clone().into()),
                        ("templateSource", executable.source.clone().into()),
                        ("matcherSiteId", candidate.site.site_id.clone().into()),
                        ("matchedLocationId", to_js_string(candidate.location.get("id")).into()),
                        ("materializedVariantId", variant_id.clone().into()),
                    ]),
                ),
                (
                    "acceptance",
                    object([
                        ("state", "pending".into()),
                        ("checks", acceptance_checks()),
                        ("reviewer", Js::Null),
                    ]),
                ),
                ("evidencePaths", evidence_paths(&evidence_root, &context.map_id, &identity)),
            ]);
            let digest = design_digest(&slot);
            let mut slot = slot;
            slot.set("designDigest", digest.into());
            slots.push(slot);
        }
        if selected_on_map.len() < CATALOG_MIN_INCIDENT_TYPES_PER_MAP {
            let unselected: Vec<&String> = eligible
                .iter()
                .map(|e| &e.incident.id)
                .filter(|id| !selected_on_map.contains(id))
                .collect();
            let mut sorted = selected_on_map.clone();
            sorted.sort_by(|a, b| cmp_utf16(a, b));
            let prefix = format!("{}:", context.map_id);
            let mut failures = Map::new();
            for id in &unselected {
                let list: Vec<&String> = failures_by_mechanism
                    .get(*id)
                    .map(|f| f.iter().filter(|s| s.starts_with(&prefix)).collect())
                    .unwrap_or_default();
                failures.insert((*id).clone(), json!(list));
            }
            breadth_failures.push(json!({
                "mapId": context.map_id,
                "selectedMechanisms": sorted,
                "unselectedMechanisms": unselected,
                "materializationFailures": failures,
            }));
        }
    }

    if !breadth_failures.is_empty() {
        return Err(findings(
            "insufficient_map_authorability",
            dev_assets_arg,
            "one or more maps cannot materialize the required exact-pair mechanism breadth",
        )
        .detail_entry("maps", Value::Array(breadth_failures)));
    }
    if eligibility_counts.iter().any(|n| *n < CATALOG_MIN_INCIDENT_TYPES_PER_MAP) {
        return Err(findings(
            "insufficient_map_authorability",
            dev_assets_arg,
            "one or more maps cannot support the required exact-pair breadth",
        )
        .detail_entry("maps", Value::Array(eligibility_by_map)));
    }
    let missing: Vec<&Incident> = tax.incidents.iter().filter(|i| !coverage.contains(&i.id)).collect();
    let mut coverage = None;
    if !missing.is_empty() {
        let mut failures = Map::new();
        for incident in &missing {
            failures.insert(
                incident.id.clone(),
                json!(failures_by_mechanism.get(&incident.id).cloned().unwrap_or_default()),
            );
        }
        let missing_ids: Vec<&String> = missing.iter().map(|i| &i.id).collect();
        if options.require_full_coverage {
            return Err(detail(
                findings(
                    "incomplete_mechanism_coverage",
                    "slots",
                    "exact-pair catalog does not cover every intended mechanism",
                ),
                json!({ "missingMechanisms": missing_ids, "materializationFailures": failures }),
            ));
        }
        coverage = Some(json!({ "missing": missing_ids, "materializationFailures": failures }));
    }

    let total = (map_ids.len() * CATALOG_SLOTS_PER_MAP) as f64;
    let progress = progress_for(&slots, total)?;
    let manifest = object([
        ("kind", CATALOG_KIND.into()),
        ("version", CATALOG_VERSION.into()),
        (
            "contract",
            object([
                ("supportedMaps", strings(&map_ids)),
                ("slotsPerMap", CATALOG_SLOTS_PER_MAP.into()),
                ("totalSlots", total.into()),
                ("minimumIncidentTypesPerMap", CATALOG_MIN_INCIDENT_TYPES_PER_MAP.into()),
                ("minimumDomainsPerMap", 0usize.into()),
            ]),
        ),
        (
            "provenance",
            object([
                ("generator", CATALOG_GENERATOR.into()),
                ("generatorVersion", CATALOG_GENERATOR_VERSION.into()),
                ("namespace", namespace_js.clone()),
                ("taxonomyDigest", taxonomy_hash.into()),
            ]),
        ),
        ("evidenceRoot", evidence_root.into()),
        ("maps", Js::Array(contexts.iter().map(|c| c.provenance.clone()).collect())),
        ("researchSources", tax.sources.clone()),
        ("taxonomy", tax.incidents_js.clone()),
        ("templates", Js::Array(executables.iter().map(|e| e.provenance.clone()).collect())),
        ("slots", Js::Array(slots)),
        ("progress", progress),
    ]);
    let digest = digest_payload(&manifest);
    let mut manifest = manifest;
    manifest.set("catalogDigest", digest.into());
    Ok(Created { catalog: manifest, coverage })
}

/// The `catalog create` result document.
pub fn catalog_summary(catalog: &Js, manifest_path: &Path) -> Value {
    let get = |k: &str| catalog.get(k).map(Js::to_value).unwrap_or(Value::Null);
    let supported: Vec<String> = catalog
        .get("contract")
        .and_then(|c| c.get("supportedMaps"))
        .and_then(Js::as_array)
        .map(|a| a.iter().map(|v| to_js_string(Some(v))).collect())
        .unwrap_or_default();
    let slots = catalog.get("slots").and_then(Js::as_array).cloned().unwrap_or_default();
    let on = |map_id: &str| -> Vec<&Js> { slots.iter().filter(|s| is_str(s.get("mapId"), map_id)).collect() };
    let mut per_map = Map::new();
    let mut incidents_by_map = Map::new();
    for map_id in &supported {
        per_map.insert(map_id.clone(), json!(on(map_id).len()));
        let incidents: BTreeSet<String> = on(map_id)
            .into_iter()
            .filter_map(|s| s.get("scenario").and_then(|x| x.get("incidentId")).map(|v| to_js_string(Some(v))))
            .collect();
        incidents_by_map.insert(map_id.clone(), json!(incidents.len()));
    }
    let taxonomy_rows = catalog.get("taxonomy").and_then(Js::as_array).cloned().unwrap_or_default();
    let domains: BTreeSet<String> = taxonomy_rows
        .iter()
        .map(|row| to_js_string(row.get("domain")))
        .collect();
    let contract = catalog.get("contract");
    json!({
        "kind": get("kind"),
        "version": get("version"),
        "catalogDigest": get("catalogDigest"),
        "namespace": catalog.get("provenance").and_then(|p| p.get("namespace")).map(Js::to_value),
        "slotsPerMap": contract.and_then(|c| c.get("slotsPerMap")).map(Js::to_value),
        "totalSlots": contract.and_then(|c| c.get("totalSlots")).map(Js::to_value),
        "maps": per_map,
        "templates": get("templates"),
        "taxonomy": {
            "incidentTypes": taxonomy_rows.len(),
            "domains": domains.len(),
            "incidentTypesByMap": incidents_by_map,
        },
        "progress": get("progress"),
        "status": { "authored": slots.len() },
        "manifest": manifest_path.display().to_string(),
    })
}

/// `catalog create`: build, write `out` (`JSON.stringify(catalog, null, 2)`
/// plus a newline) and return the summary, with `coverage` when some taxonomy
/// mechanism has no slot (a warning unless `require_full_coverage`).
pub fn catalog_create(
    root: &MapRoot,
    dev_assets_arg: &str,
    out: &Path,
    options: &CreateOptions,
) -> Result<Value, CompileError> {
    let created = create_catalog(root, dev_assets_arg, options)?;
    write_js_file(out, &created.catalog)?;
    let mut summary = catalog_summary(&created.catalog, &resolve(out));
    if let Some(coverage) = created.coverage {
        summary["coverage"] = coverage;
    }
    Ok(summary)
}

/// Write `JSON.stringify(value, null, 2) + "\n"`, creating parent directories.
pub fn write_js_file(file: &Path, value: &Js) -> Result<(), CompileError> {
    let absolute: PathBuf = resolve(file);
    if let Some(parent) = absolute.parent() {
        std::fs::create_dir_all(parent).map_err(|e| crate::json::io_error(parent, e))?;
    }
    std::fs::write(file, format!("{}\n", value.stringify_pretty())).map_err(|e| crate::json::io_error(file, e))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every code `simforge-compiler` raises with `.as_findings()` (read from
    /// its source) is in [`COMPILER_FINDING_CODES`].
    #[test]
    fn compiler_finding_codes_are_complete() {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("../simforge-compiler/src");
        let mut files = Vec::new();
        let mut stack = vec![src];
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(&dir).expect("compiler src") {
                let path = entry.expect("entry").path();
                if path.is_dir() {
                    stack.push(path);
                } else if path.extension().is_some_and(|e| e == "rs") {
                    files.push(path);
                }
            }
        }
        // Sites whose code is not a literal at the constructor, by file:
        // builder.rs raises the arrival-trigger issue codes (`arrival_unsolvable`
        // reported as `arrival_unconverged`, `actor_unknown` as itself) and the
        // pedestrian near-miss solver's codes; situation.rs raises
        // `tx_fail(path, "<code>", ..)` codes, scanned below.
        use simforge_core::solve::pedestrian::PedestrianNearMissIssueCode as NearMiss;
        let near_miss_variants = [
            NearMiss::NearMissInvalidTrajectory,
            NearMiss::NearMissInvalidWindow,
            NearMiss::NearMissInfeasibleSpeed,
            NearMiss::NearMissClearanceUnresolved,
            NearMiss::NearMissWouldCollide,
        ];
        // A new variant must be added above (this match stops compiling).
        for code in near_miss_variants {
            match code {
                NearMiss::NearMissInvalidTrajectory
                | NearMiss::NearMissInvalidWindow
                | NearMiss::NearMissInfeasibleSpeed
                | NearMiss::NearMissClearanceUnresolved
                | NearMiss::NearMissWouldCollide => {}
            }
        }
        let mut builder_codes: Vec<String> = vec!["arrival_unconverged".into(), "actor_unknown".into(), "near_miss_unsolvable".into()];
        builder_codes.extend(near_miss_variants.iter().map(|c| {
            serde_json::to_value(c).expect("code").as_str().expect("string").to_owned()
        }));
        let dynamic: Vec<(&str, Vec<String>)> = vec![("builder.rs", builder_codes), ("situation.rs", Vec::new())];
        let literal = |text: &str| -> Option<String> {
            let t = text.trim_start();
            let rest = t.strip_prefix('"')?;
            Some(rest[..rest.find('"')?].to_owned())
        };
        let mut codes: Vec<String> = Vec::new();
        let mut dynamic_sites = 0;
        for file in &files {
            let text = std::fs::read_to_string(file).expect("read");
            let name = file.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_owned();
            for (at, _) in text.match_indices(".as_findings()") {
                let before = &text[..at];
                let ctor = ["CompileError::at(", "CompileError::new("]
                    .iter()
                    .filter_map(|c| before.rfind(c).map(|i| i + c.len()))
                    .max();
                let Some(start) = ctor else { continue };
                match literal(&text[start..]) {
                    Some(code) => codes.push(code),
                    None => {
                        dynamic_sites += 1;
                        let listed = dynamic.iter().find(|(f, _)| *f == name);
                        assert!(listed.is_some(), "{name}: .as_findings() on a non-literal code; list it in `dynamic`");
                        codes.extend(listed.unwrap().1.iter().cloned());
                    }
                }
            }
            for (at, _) in text.match_indices("tx_fail(") {
                let args = &text[at + "tx_fail(".len()..];
                if let Some(second) = args.split_once(',').map(|(_, rest)| rest) {
                    if let Some(code) = literal(second) {
                        codes.push(code);
                    }
                }
            }
        }
        assert_eq!(dynamic_sites, 3, "a new non-literal .as_findings() site appeared; list its codes");
        codes.sort();
        codes.dedup();
        let missing: Vec<&String> = codes.iter().filter(|c| !COMPILER_FINDING_CODES.contains(&c.as_str())).collect();
        let extra: Vec<&&str> = COMPILER_FINDING_CODES.iter().filter(|c| !codes.iter().any(|k| k == *c)).collect();
        assert!(missing.is_empty() && extra.is_empty(), "missing {missing:?}, stale {extra:?}; all: {codes:?}");
    }

    #[test]
    fn identities_and_paths() {
        assert_eq!(
            catalog_identity("yale-street", 6.0, "intersection.left-turn-across-opposing-through", "0123456789abcdef"),
            "yale-street-007-left-turn-across-opposing-through-0123456789ab"
        );
        assert_eq!(catalog_identity("m", 99.0, "a.b_c.D x", "s"), "m-100--x-s");
        assert_eq!(posix_normalize("./ev/./a//b"), "ev/a/b");
        assert!(assert_relative_root("../x").is_err());
        assert!(assert_relative_root("C:\\x").is_err());
        assert_eq!(assert_relative_root("ev\\a//").unwrap(), "ev/a");
        assert!(is_safe_map_id("a--b"));
        assert!(!is_safe_map_id("-a"));
    }
}
