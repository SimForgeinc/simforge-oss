//! `catalog verify`: machine verification of authorship, breadth, identity,
//! provenance and evidence, then the live exact-matcher closure.
//!
//! The manifest is read with the order-preserving parser and checked exactly
//! as the TypeScript verifier checks a `JSON.parse`d document (JavaScript
//! equality, `String()` conversions, key order in every digest), so both
//! implementations accept and reject the same files with the same issues.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};
use simforge_compiler::sites::{match_on_map, SiteMatchOptions};
use simforge_compiler::CompileError;
use simforge_core::hash::{sha256, sha256_bytes};

use super::closure::matcher_site_closes_location;
use super::js::{is_integer, is_str, object, strict_eq, to_js_string, truthy, Js};
use super::taxonomy::taxonomy;
use super::{
    catalog_identity, catalog_seed, design_digest, digest_payload, is_safe_map_id, progress_for,
    templates, SeedMap, ALL_EVIDENCE, CATALOG_GENERATOR_VERSION, CATALOG_KIND,
    CATALOG_MIN_INCIDENT_TYPES_PER_MAP, CATALOG_SLOTS_PER_MAP, CATALOG_VERSION,
};
use crate::maps::MapRoot;
use crate::paths::resolve;

const SLOTS: f64 = CATALOG_SLOTS_PER_MAP as f64;
const STATUSES: [&str; 6] = ["authored", "generated", "simulated", "rendered", "visually-accepted", "rejected"];

fn required_evidence(status: &str) -> &'static [&'static str] {
    match status {
        "authored" => &[],
        "generated" => &["instance"],
        "simulated" => &["instance", "trace", "result"],
        "rendered" => &["instance", "trace", "result", "renderManifest", "frame", "video"],
        "visually-accepted" => &ALL_EVIDENCE,
        "rejected" => &["instance", "result"],
        _ => &[],
    }
}

/// One verification issue: `{code, path, reason, expected?, actual?}`.
#[derive(Debug, Clone)]
pub struct Issue {
    pub code: &'static str,
    pub path: String,
    pub reason: String,
    pub expected: Option<Value>,
    pub actual: Option<Value>,
}

impl Issue {
    pub fn to_value(&self) -> Value {
        let mut out = Map::new();
        out.insert("code".into(), Value::String(self.code.into()));
        out.insert("path".into(), Value::String(self.path.clone()));
        out.insert("reason".into(), Value::String(self.reason.clone()));
        if let Some(e) = &self.expected {
            out.insert("expected".into(), e.clone());
        }
        if let Some(a) = &self.actual {
            out.insert("actual".into(), a.clone());
        }
        Value::Object(out)
    }
}

struct Issues(Vec<Issue>);

impl Issues {
    fn push(&mut self, code: &'static str, path: impl Into<String>, reason: impl Into<String>) {
        self.with(code, path, reason, None, None);
    }

    fn with(
        &mut self,
        code: &'static str,
        path: impl Into<String>,
        reason: impl Into<String>,
        expected: Option<Value>,
        actual: Option<Value>,
    ) {
        self.0.push(Issue { code, path: path.into(), reason: reason.into(), expected, actual });
    }
}

fn val(v: Option<&Js>) -> Option<Value> {
    v.map(Js::to_value)
}

/// `/^[0-9a-f]{n}$/.test(String(value))`.
fn is_hex(value: Option<&Js>, n: usize) -> bool {
    let text = to_js_string(value);
    text.len() == n && text.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// `isSafeEvidencePath`.
fn is_safe_evidence_path(value: Option<&Js>, evidence_root: &str) -> bool {
    let Some(value) = value.and_then(Js::as_str) else { return false };
    if value.is_empty() || value.contains('\\') || value.starts_with('/') || value.split('/').any(|p| p == "..") {
        return false;
    }
    value == evidence_root || value.starts_with(&format!("{evidence_root}/"))
}

/// Options for [`validate_catalog`].
#[derive(Debug, Clone, Default)]
pub struct VerifyOptions {
    /// The manifest file; evidence paths are relative to its directory.
    pub manifest_file: Option<PathBuf>,
    /// Physical evidence-root override.
    pub evidence_root_override: Option<PathBuf>,
    /// Require every evidence path, not only those implied by status.
    pub require_evidence: bool,
    /// A catalog that does not cover every taxonomy mechanism fails
    /// (`insufficient_taxonomy_breadth` at `slots`). Off by default: the gap
    /// is reported as `coverage.missing` (what `catalog create` writes when
    /// no selected map can host some mechanism). Every other check is hard.
    pub require_full_coverage: bool,
}

/// The static report.
pub struct Report {
    pub ok: bool,
    pub catalog_digest: Option<String>,
    pub slots: usize,
    pub maps: Map<String, Value>,
    pub statuses: Map<String, Value>,
    pub incident_types_by_map: Map<String, Value>,
    pub domains_by_map: Map<String, Value>,
    pub progress: Js,
    pub evidence_checked: bool,
    pub issues: Vec<Issue>,
    /// `{missing: [incidentId...]}` when mechanisms are uncovered (a warning
    /// unless `require_full_coverage`).
    pub coverage: Option<Value>,
}

impl Report {
    fn empty(issues: Vec<Issue>) -> Self {
        Self {
            ok: false,
            catalog_digest: None,
            slots: 0,
            maps: Map::new(),
            statuses: Map::new(),
            incident_types_by_map: Map::new(),
            domains_by_map: Map::new(),
            progress: object([
                ("target", 0usize.into()),
                ("planned", 0usize.into()),
                ("authored", 0usize.into()),
                ("generated", 0usize.into()),
                ("simulated", 0usize.into()),
                ("rendered", 0usize.into()),
                ("visuallyAccepted", 0usize.into()),
                ("rejected", 0usize.into()),
            ]),
            evidence_checked: false,
            issues,
            coverage: None,
        }
    }

    pub fn to_value(&self) -> Value {
        let mut out = json!({
            "ok": self.ok,
            "kind": "simforge-catalog-validation",
            "version": 2,
            "catalogDigest": self.catalog_digest,
            "slots": self.slots,
            "maps": self.maps,
            "statuses": self.statuses,
            "incidentTypesByMap": self.incident_types_by_map,
            "domainsByMap": self.domains_by_map,
            "progress": self.progress.to_value(),
            "evidenceChecked": self.evidence_checked,
            "issues": self.issues.iter().map(Issue::to_value).collect::<Vec<_>>(),
        });
        if let Some(coverage) = &self.coverage {
            out["coverage"] = coverage.clone();
        }
        out
    }
}

/// `Map<string, number>` counter in insertion order (a JavaScript record;
/// result documents are compared without key order).
fn bump(map: &mut Map<String, Value>, key: &str) {
    let next = map.get(key).and_then(Value::as_u64).unwrap_or(0) + 1;
    map.insert(key.to_owned(), json!(next));
}

/// Insertion-ordered set.
#[derive(Default)]
struct OrderedSet(Vec<String>);

impl OrderedSet {
    fn add(&mut self, v: &str) {
        if !self.0.iter().any(|x| x == v) {
            self.0.push(v.to_owned());
        }
    }
    fn has(&self, v: &str) -> bool {
        self.0.iter().any(|x| x == v)
    }
    fn len(&self) -> usize {
        self.0.len()
    }
}

/// `path.posix.relative(from, to)` for the evidence override.
fn posix_relative(from: &str, to: &str) -> String {
    let from = resolve(Path::new(from));
    let to = resolve(Path::new(to));
    let a: Vec<_> = from.components().collect();
    let b: Vec<_> = to.components().collect();
    let common = a.iter().zip(&b).take_while(|(x, y)| x == y).count();
    let mut parts: Vec<String> = std::iter::repeat_n("..".to_owned(), a.len() - common).collect();
    parts.extend(b[common..].iter().map(|c| c.as_os_str().to_string_lossy().into_owned()));
    parts.join("/")
}

/// `path.join(a, b)`: joined and normalised.
fn node_join(a: &Path, b: &str) -> PathBuf {
    let joined = format!("{}/{b}", a.display());
    PathBuf::from(super::posix_normalize(&joined))
}

/// Machine verification for authorship, breadth, identity, provenance and
/// evidence (no map access). `Err` only where the reference throws.
pub fn validate_catalog(value: &Js, options: &VerifyOptions) -> Result<Report, CompileError> {
    let mut issues = Issues(Vec::new());
    if !value.is_record() {
        issues.push("invalid_catalog", "$", "catalog must be a JSON object");
        return Ok(Report::empty(issues.0));
    }
    let tax = taxonomy();
    let empty = Js::Object(Vec::new());
    let record = |v: Option<&Js>| -> Js { v.filter(|x| x.is_record()).cloned().unwrap_or(Js::Object(Vec::new())) };
    let slots: Vec<Js> = value.get("slots").and_then(Js::as_array).cloned().unwrap_or_default();
    let evidence_root = value.get("evidenceRoot").and_then(Js::as_str).unwrap_or("").to_owned();

    let version_ok = matches!(value.get("version"), Some(Js::Number(n)) if *n == CATALOG_VERSION);
    if !is_str(value.get("kind"), CATALOG_KIND) || !version_ok {
        issues.push("invalid_catalog", "$", format!("kind/version must be {CATALOG_KIND}@2"));
    }
    let contract = record(value.get("contract"));
    let supported_rows: Vec<Js> = contract.get("supportedMaps").and_then(Js::as_array).cloned().unwrap_or_default();
    let supported: Vec<String> = supported_rows
        .iter()
        .filter_map(Js::as_str)
        .filter(|s| is_safe_map_id(s))
        .map(str::to_owned)
        .collect();
    let supported_set: HashSet<&String> = supported.iter().collect();
    if supported.is_empty() || supported.len() != supported_rows.len() || supported_set.len() != supported.len() {
        issues.push(
            "wrong_map_inventory",
            "contract.supportedMaps",
            "supportedMaps must declare at least one unique safe map name",
        );
    }
    let expected_total = supported.len() as f64 * SLOTS;
    let num_is = |v: Option<&Js>, n: f64| matches!(v, Some(Js::Number(x)) if *x == n);
    if !num_is(contract.get("slotsPerMap"), SLOTS) || !num_is(contract.get("totalSlots"), expected_total) {
        issues.with(
            "wrong_slot_count",
            "contract",
            format!("contract must declare exactly {CATALOG_SLOTS_PER_MAP} slots per supported map"),
            Some(super::js::number_value(expected_total)),
            val(contract.get("totalSlots")),
        );
    }
    if !num_is(contract.get("minimumIncidentTypesPerMap"), CATALOG_MIN_INCIDENT_TYPES_PER_MAP as f64)
        || !num_is(contract.get("minimumDomainsPerMap"), 0.0)
    {
        issues.push(
            "insufficient_taxonomy_breadth",
            "contract",
            format!("catalog breadth gates must require at least {CATALOG_MIN_INCIDENT_TYPES_PER_MAP} incident types per map and no domain quota"),
        );
    }
    if value.get("evidenceRoot").and_then(Js::as_str).is_none()
        || !is_safe_evidence_path(Some(&Js::from(format!("{evidence_root}/probe"))), &evidence_root)
    {
        issues.push("invalid_evidence_path", "evidenceRoot", "evidenceRoot must be a safe relative path");
    }

    let taxonomy_rows: Vec<Js> = value.get("taxonomy").and_then(Js::as_array).cloned().unwrap_or_default();
    let mut incident_by_id: HashMap<String, &Js> = HashMap::new();
    for row in &taxonomy_rows {
        if let (true, Some(id)) = (row.is_record(), row.get("id").and_then(Js::as_str)) {
            incident_by_id.insert(id.to_owned(), row);
        }
    }
    let source_rows: Vec<Js> = value.get("researchSources").and_then(Js::as_array).cloned().unwrap_or_default();
    let source_ids: HashSet<String> = source_rows
        .iter()
        .filter(|r| r.is_record())
        .filter_map(|r| r.get("id").and_then(Js::as_str).map(str::to_owned))
        .collect();
    let taxonomy_hash = sha256(
        &object([
            ("sources", Js::Array(source_rows.clone())),
            ("incidents", Js::Array(taxonomy_rows.clone())),
            ("variants", tax.variants.clone()),
        ])
        .stringify(),
    );
    let domain_count = taxonomy_rows
        .iter()
        .filter(|r| r.is_record())
        .filter_map(|r| r.get("domain").and_then(Js::as_str))
        .collect::<HashSet<_>>()
        .len();
    if taxonomy_rows.len() < 30 || domain_count < tax.domains.len() {
        issues.push(
            "insufficient_taxonomy_breadth",
            "taxonomy",
            "taxonomy must cover at least 30 incident mechanisms across all eight domains",
        );
    }
    let template_rows: Vec<Js> = value.get("templates").and_then(Js::as_array).cloned().unwrap_or_default();
    let mut template_by_registry_id: HashMap<String, &Js> = HashMap::new();
    for (index, row) in template_rows.iter().enumerate() {
        let complete = row.is_record()
            && row.get("id").and_then(Js::as_str).is_some()
            && row.get("runtimeTemplateId").and_then(Js::as_str).is_some_and(|s| !s.is_empty())
            && row.get("source").and_then(Js::as_str).is_some()
            && is_hex(row.get("digest"), 64);
        if !complete {
            issues.push(
                "invalid_provenance",
                format!("templates[{index}]"),
                "template registry, canonical runtime identity, source, and digest must be complete",
            );
            continue;
        }
        template_by_registry_id.insert(row.get("id").and_then(Js::as_str).unwrap_or_default().to_owned(), row);
    }
    let top = record(value.get("provenance"));
    if !is_str(top.get("taxonomyDigest"), &taxonomy_hash) || !is_str(top.get("generatorVersion"), CATALOG_GENERATOR_VERSION) {
        issues.push("invalid_provenance", "provenance", "top-level taxonomy/generator provenance is stale");
    }

    let map_rows: Vec<Js> = value.get("maps").and_then(Js::as_array).cloned().unwrap_or_default();
    let mut map_order: Vec<String> = Vec::new();
    let mut map_by_id: HashMap<String, &Js> = HashMap::new();
    let mut map_row_ids: Vec<String> = Vec::new();
    for row in &map_rows {
        if let (true, Some(id)) = (row.is_record(), row.get("mapId").and_then(Js::as_str).filter(|s| is_safe_map_id(s))) {
            map_row_ids.push(id.to_owned());
            if !map_by_id.contains_key(id) {
                map_order.push(id.to_owned());
            }
            map_by_id.insert(id.to_owned(), row);
        }
    }
    let unique_rows: HashSet<&String> = map_row_ids.iter().collect();
    if map_rows.len() != supported.len()
        || map_row_ids.len() != map_rows.len()
        || unique_rows.len() != map_row_ids.len()
        || supported.iter().any(|m| !map_by_id.contains_key(m))
        || map_row_ids.iter().any(|m| !supported_set.contains(m))
    {
        issues.push("wrong_map_inventory", "maps", "maps[] must contain each declared supported map exactly once");
    }
    for map_id in &map_order {
        let map = map_by_id[map_id];
        if !num_is(map.get("slots"), SLOTS) {
            issues.with(
                "wrong_slot_count",
                format!("maps(map={map_id}).slots"),
                format!("map provenance must declare {CATALOG_SLOTS_PER_MAP} slots"),
                Some(json!(CATALOG_SLOTS_PER_MAP)),
                val(map.get("slots")),
            );
        }
        if !is_hex(map.get("matcherIndexDigest"), 64)
            || !is_hex(map.get("engineGraphDigest"), 64)
            || !is_hex(map.get("locationCatalogDigest"), 64)
            || strict_eq(map.get("matcherIndexDigest"), map.get("engineGraphDigest"))
        {
            issues.push(
                "invalid_provenance",
                format!("maps(map={map_id})"),
                "matcher, engine, and location provenance must be independent digest domains",
            );
        }
    }

    let mut identities: HashSet<String> = HashSet::new();
    let mut seeds: HashSet<String> = HashSet::new();
    let mut map_ordinals: HashMap<String, HashSet<u64>> = HashMap::new();
    let mut status_counts = Map::new();
    let mut map_counts = Map::new();
    let mut map_incidents: HashMap<String, OrderedSet> = HashMap::new();
    let mut map_domains: HashMap<String, OrderedSet> = HashMap::new();
    let physical_root = match &options.evidence_root_override {
        Some(dir) => resolve(dir),
        None => resolve(options.manifest_file.as_deref().unwrap_or(Path::new("catalog.json")))
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("/")),
    };
    let mut evidence_checked = false;
    let variant_ids: Vec<&str> = tax.variant_ids().collect();

    for (index, raw) in slots.iter().enumerate() {
        let base = format!("slots[{index}]");
        if !raw.is_record() {
            issues.push("invalid_catalog", base, "slot must be an object");
            continue;
        }
        let identity = raw.get("identity");
        let seed = raw.get("seed");
        let map_id = raw.get("mapId");
        let ordinal = raw.get("ordinal");
        let provenance = record(raw.get("provenance"));
        let scenario = record(raw.get("scenario"));
        let site = record(raw.get("site"));
        let variant = record(raw.get("variant"));
        let brief = record(raw.get("brief"));
        let implementation = record(raw.get("implementation"));
        let acceptance = record(raw.get("acceptance"));
        let status = raw.get("status");
        let paths = record(raw.get("evidencePaths"));

        match identity.and_then(Js::as_str) {
            None => issues.push("invalid_identity", format!("{base}.identity"), "identity must be a string"),
            Some(id) if identities.contains(id) => {
                issues.push("duplicate_identity", format!("{base}.identity"), format!("duplicate identity {id}"))
            }
            Some(id) => {
                identities.insert(id.to_owned());
            }
        }
        match seed.and_then(Js::as_str).filter(|_| is_hex(seed, 64)) {
            None => issues.push("invalid_seed", format!("{base}.seed"), "seed must be 64 lowercase hexadecimal characters"),
            Some(s) if seeds.contains(s) => issues.push("duplicate_seed", format!("{base}.seed"), format!("duplicate seed {s}")),
            Some(s) => {
                seeds.insert(s.to_owned());
            }
        }

        let incident_id = scenario.get("incidentId").and_then(Js::as_str);
        if let Some(map_id) = map_id.and_then(Js::as_str) {
            bump(&mut map_counts, map_id);
            if let Some(n) = is_integer(ordinal) {
                map_ordinals.entry(map_id.to_owned()).or_default().insert((n + 0.0).to_bits());
            }
            if let Some(id) = incident_id {
                map_incidents.entry(map_id.to_owned()).or_default().add(id);
            }
            if let Some(domain) = scenario.get("domain").and_then(Js::as_str) {
                map_domains.entry(map_id.to_owned()).or_default().add(domain);
            }
        }
        if let Some(s) = status.and_then(Js::as_str) {
            bump(&mut status_counts, s);
        }

        let map = map_id.and_then(Js::as_str).and_then(|id| map_by_id.get(id).copied());
        let incident = incident_id.and_then(|id| incident_by_id.get(id).copied());
        let ordinal_n = is_integer(ordinal).filter(|n| *n >= 0.0 && *n < SLOTS);
        let provenance_ok = |map: &Js| {
            provenance.get("namespace").and_then(Js::as_str).is_some()
                && is_str(provenance.get("generatorVersion"), CATALOG_GENERATOR_VERSION)
                && strict_eq(provenance.get("mapCatalogRevision"), map.get("catalogRevision"))
                && strict_eq(provenance.get("matcherIndexDigest"), map.get("matcherIndexDigest"))
                && strict_eq(provenance.get("engineGraphDigest"), map.get("engineGraphDigest"))
                && strict_eq(provenance.get("locationCatalogDigest"), map.get("locationCatalogDigest"))
                && is_str(provenance.get("taxonomyDigest"), &taxonomy_hash)
        };
        match (map, incident, ordinal_n) {
            (Some(map), Some(incident), Some(ordinal)) if provenance_ok(map) => {
                let variant_id = variant.get("id").and_then(Js::as_str);
                if site.get("locationId").and_then(Js::as_str).is_none()
                    || site.get("sourceDigest").and_then(Js::as_str).is_none()
                    || variant_id.is_none_or(|v| !variant_ids.contains(&v))
                {
                    issues.push(
                        "invalid_site_binding",
                        format!("{base}.site"),
                        "site binding and operational variant must be complete",
                    );
                } else {
                    check_slot(
                        &mut issues,
                        &base,
                        map,
                        incident,
                        ordinal,
                        identity,
                        seed,
                        &provenance,
                        &scenario,
                        &site,
                        &variant,
                        &brief,
                        &implementation,
                        &source_ids,
                        &template_by_registry_id,
                        &taxonomy_hash,
                    );
                }
            }
            _ => issues.push(
                "invalid_provenance",
                base.clone(),
                "slot map, ordinal, incident, or provenance is incomplete/stale",
            ),
        }

        let checks: Vec<Js> = acceptance.get("checks").and_then(Js::as_array).cloned().unwrap_or_default();
        let check_ids: HashSet<&str> = checks
            .iter()
            .filter(|c| c.is_record())
            .filter_map(|c| c.get("id").and_then(Js::as_str))
            .collect();
        let all_ids = ["schema", "site-grounding", "determinism", "kinematics", "render-integrity", "visual-realism"];
        if checks.len() != 6
            || all_ids.iter().any(|id| !check_ids.contains(id))
            || (is_str(status, "visually-accepted")
                && (!is_str(acceptance.get("state"), "accepted")
                    || !acceptance.get("reviewer").is_some_and(Js::is_record)
                    || checks.iter().any(|c| !c.is_record() || !is_str(c.get("state"), "passed"))))
        {
            issues.push(
                "invalid_acceptance_manifest",
                format!("{base}.acceptance"),
                "acceptance requires all six gates; visual acceptance additionally requires a reviewer and all checks passed",
            );
        }

        for key in ALL_EVIDENCE {
            if !is_safe_evidence_path(paths.get(key), &evidence_root) {
                issues.push(
                    "invalid_evidence_path",
                    format!("{base}.evidencePaths.{key}"),
                    "evidence path must stay under evidenceRoot",
                );
            }
        }
        let known_status = status.and_then(Js::as_str).filter(|s| STATUSES.contains(s));
        let required: &[&str] = if options.require_evidence {
            &ALL_EVIDENCE
        } else {
            known_status.map_or(&[], required_evidence)
        };
        if known_status.is_none() {
            issues.push("invalid_catalog", format!("{base}.status"), "unknown slot status");
        }
        for key in required {
            let Some(relative) = paths.get(key).and_then(Js::as_str) else { continue };
            evidence_checked = true;
            let physical = if options.evidence_root_override.is_some() {
                node_join(&physical_root, &posix_relative(&evidence_root, relative))
            } else {
                node_join(&physical_root, relative)
            };
            if !physical.exists() {
                issues.push(
                    "missing_evidence",
                    format!("{base}.evidencePaths.{key}"),
                    format!("required evidence does not exist: {}", physical.display()),
                );
            }
        }

        match raw.get("designDigest") {
            Some(Js::String(digest)) => {
                let expected = design_digest(raw);
                if *digest != expected {
                    issues.with(
                        "invalid_provenance",
                        format!("{base}.designDigest"),
                        "authored design content does not match its digest",
                        Some(Value::String(expected)),
                        Some(Value::String(digest.clone())),
                    );
                }
            }
            _ => issues.push("invalid_provenance", format!("{base}.designDigest"), "design digest is required"),
        }
    }

    if slots.len() as f64 != expected_total {
        issues.with(
            "wrong_slot_count",
            "slots",
            format!("catalog must contain exactly {CATALOG_SLOTS_PER_MAP} slots per declared supported map"),
            Some(super::js::number_value(expected_total)),
            Some(json!(slots.len())),
        );
    }
    let template_backed = slots
        .iter()
        .filter(|s| is_str(s.get("implementation").filter(|i| i.is_record()).and_then(|i| i.get("state")), "template-backed"))
        .count();
    if template_backed != slots.len() {
        issues.with(
            "invalid_provenance",
            "slots",
            "every delivery catalog slot must be template-backed and executable",
            Some(json!(slots.len())),
            Some(json!(template_backed)),
        );
    }
    let mut covered = OrderedSet::default();
    for slot in &slots {
        if let Some(id) = slot
            .get("scenario")
            .filter(|s| s.is_record())
            .and_then(|s| s.get("incidentId"))
            .and_then(Js::as_str)
        {
            covered.add(id);
        }
    }
    let missing: Vec<&String> = tax.incidents.iter().map(|i| &i.id).filter(|id| !covered.has(id)).collect();
    // A warning by default; with `require_full_coverage` the issue replaces it.
    let coverage = (!missing.is_empty() && !options.require_full_coverage).then(|| json!({ "missing": missing }));
    if !missing.is_empty() && options.require_full_coverage {
        issues.with(
            "insufficient_taxonomy_breadth",
            "slots",
            "catalog must cover every intended mechanism",
            Some(json!(tax.incidents.iter().map(|i| &i.id).collect::<Vec<_>>())),
            Some(json!(covered.0)),
        );
    }
    for map_id in &supported {
        let ordinals = map_ordinals.get(map_id).map_or(0, HashSet::len);
        let count = map_counts.get(map_id).and_then(Value::as_u64);
        if count != Some(CATALOG_SLOTS_PER_MAP as u64) || ordinals != CATALOG_SLOTS_PER_MAP {
            issues.with(
                "wrong_slot_count",
                format!("slots(map={map_id})"),
                "map must contain each ordinal 0..99 exactly once",
                Some(json!(CATALOG_SLOTS_PER_MAP)),
                Some(json!(count.unwrap_or(0))),
            );
        }
        if map_incidents.get(map_id).map_or(0, OrderedSet::len) < CATALOG_MIN_INCIDENT_TYPES_PER_MAP {
            issues.push(
                "insufficient_taxonomy_breadth",
                format!("slots(map={map_id})"),
                format!("map must contain at least {CATALOG_MIN_INCIDENT_TYPES_PER_MAP} incident mechanisms"),
            );
        }
    }

    let calculated = progress_for(&slots, expected_total)?;
    let stated = value.get("progress");
    if stated.map(Js::stringify) != Some(calculated.stringify()) {
        issues.with(
            "invalid_progress_counts",
            "progress",
            "planned/authored/generated/simulated/rendered/accepted counts must be derived from slot states",
            Some(calculated.to_value()),
            val(stated),
        );
    }
    match value.get("catalogDigest") {
        Some(Js::String(digest)) => {
            let expected = digest_payload(&value.without(&["catalogDigest"]));
            if *digest != expected {
                issues.with(
                    "catalog_digest_mismatch",
                    "catalogDigest",
                    "catalog content does not match its digest",
                    Some(Value::String(expected)),
                    Some(Value::String(digest.clone())),
                );
            }
        }
        _ => issues.push("catalog_digest_mismatch", "catalogDigest", "catalogDigest is required"),
    }

    let _ = empty;
    let size = |sets: &HashMap<String, OrderedSet>, id: &str| json!(sets.get(id).map_or(0, OrderedSet::len));
    Ok(Report {
        ok: issues.0.is_empty(),
        catalog_digest: value.get("catalogDigest").and_then(Js::as_str).map(str::to_owned),
        slots: slots.len(),
        maps: map_counts,
        statuses: status_counts,
        incident_types_by_map: supported.iter().map(|m| (m.clone(), size(&map_incidents, m))).collect(),
        domains_by_map: supported.iter().map(|m| (m.clone(), size(&map_domains, m))).collect(),
        progress: calculated,
        evidence_checked,
        issues: issues.0,
        coverage,
    })
}

#[allow(clippy::too_many_arguments)]
fn check_slot(
    issues: &mut Issues,
    base: &str,
    map: &Js,
    incident: &Js,
    ordinal: f64,
    identity: Option<&Js>,
    seed: Option<&Js>,
    provenance: &Js,
    scenario: &Js,
    site: &Js,
    variant: &Js,
    brief: &Js,
    implementation: &Js,
    source_ids: &HashSet<String>,
    template_by_registry_id: &HashMap<String, &Js>,
    taxonomy_hash: &str,
) {
    let incident_id = incident.get("id").and_then(Js::as_str).unwrap_or_default();
    let expected_seed = catalog_seed(
        provenance.get("namespace"),
        &SeedMap::of(map),
        ordinal,
        incident_id,
        site.get("locationId"),
        site.get("sourceDigest"),
        variant.get("id"),
        taxonomy_hash,
    );
    if !is_str(seed, &expected_seed) {
        issues.with(
            "invalid_seed",
            format!("{base}.seed"),
            "seed does not match deterministic authored coordinates",
            Some(Value::String(expected_seed.clone())),
            val(seed),
        );
    }
    let map_id = to_js_string(map.get("mapId"));
    let expected_identity = catalog_identity(&map_id, ordinal, incident_id, &expected_seed);
    if !is_str(identity, &expected_identity) {
        issues.with(
            "invalid_identity",
            format!("{base}.identity"),
            "identity does not match deterministic authored coordinates",
            Some(Value::String(expected_identity)),
            val(identity),
        );
    }
    let includes = |list: Option<&Js>, needle: &Js| -> bool {
        list.and_then(Js::as_array)
            .is_some_and(|items| items.iter().any(|i| strict_eq(Some(i), Some(needle))))
    };
    let site_type = Js::from(to_js_string(site.get("type")));
    if !includes(incident.get("siteTypes"), &site_type) {
        issues.push("invalid_site_binding", format!("{base}.site.type"), "site type is not applicable to incident");
    }
    let affordances = site.get("affordances").filter(|a| a.as_array().is_some()).cloned().unwrap_or(Js::Array(Vec::new()));
    let required = incident.get("requiredAffordances").and_then(Js::as_array).cloned().unwrap_or_default();
    if required.iter().any(|entry| !includes(Some(&affordances), entry)) {
        issues.push(
            "invalid_site_binding",
            format!("{base}.site.affordances"),
            "site lacks an incident-required affordance",
        );
    }
    let incident_sources = incident.get("sourceIds").and_then(Js::as_array).cloned().unwrap_or_default();
    if incident_sources
        .iter()
        .any(|s| s.as_str().is_none_or(|id| !source_ids.contains(id)))
    {
        issues.push(
            "invalid_provenance",
            format!("{base}.scenario.sourceIds"),
            "incident references an unknown research source",
        );
    }
    let len_at_least = |v: Option<&Js>, n: usize| v.and_then(Js::as_array).is_some_and(|a| a.len() >= n);
    if !strict_eq(scenario.get("title"), incident.get("title"))
        || !strict_eq(scenario.get("domain"), incident.get("domain"))
        || !len_at_least(brief.get("actors"), 2)
        || !len_at_least(brief.get("eventSequence"), 3)
        || !len_at_least(brief.get("criticality"), 3)
        || !len_at_least(brief.get("acceptanceCriteria"), 5)
    {
        issues.push(
            "invalid_catalog",
            format!("{base}.brief"),
            "authored brief must retain complete incident actors, sequence, observables, and acceptance criteria",
        );
    }
    let has = |k: &str| implementation.get(k).is_some();
    let authored_only = !is_str(implementation.get("state"), "authored-design") || has("matcherSiteId") || has("matchedLocationId");
    if truthy(incident.get("implementationTemplateId")) {
        if is_str(implementation.get("state"), "template-backed") {
            let registered = incident
                .get("implementationTemplateId")
                .and_then(Js::as_str)
                .and_then(|id| template_by_registry_id.get(id).copied());
            let registry_ok = registered.is_some_and(|row| {
                strict_eq(implementation.get("templateId"), row.get("runtimeTemplateId"))
                    && strict_eq(implementation.get("templateSource"), row.get("source"))
                    && strict_eq(provenance.get("templateDigest"), row.get("digest"))
            });
            if !registry_ok {
                issues.push(
                    "invalid_provenance",
                    format!("{base}.implementation"),
                    "template-backed incident lost registry-to-runtime identity provenance",
                );
            }
            let has_binding = has("matcherSiteId") || has("matchedLocationId");
            let site_id_ok = implementation
                .get("matcherSiteId")
                .and_then(Js::as_str)
                .is_some_and(|id| is_hex(Some(&Js::from(id)), 16));
            if has_binding && (!site_id_ok || !strict_eq(implementation.get("matchedLocationId"), site.get("locationId"))) {
                issues.push(
                    "invalid_site_binding",
                    format!("{base}.implementation"),
                    "template-backed incident must persist one exact matcher-site/catalog-location pair",
                );
            }
            if has_binding && !strict_eq(implementation.get("materializedVariantId"), variant.get("id")) {
                issues.with(
                    "invalid_site_binding",
                    format!("{base}.implementation.materializedVariantId"),
                    "template-backed execution must apply the exact operational variant reserved by the slot",
                    val(variant.get("id")),
                    val(implementation.get("materializedVariantId")),
                );
            }
            if !has_binding {
                issues.push(
                    "invalid_site_binding",
                    format!("{base}.implementation"),
                    "delivery catalog slots require an exact persisted matcher-site/catalog-location pair",
                );
            }
        } else if authored_only {
            issues.push(
                "invalid_provenance",
                format!("{base}.implementation"),
                "unmatched catalog location must remain an authored-only design",
            );
        }
    } else if authored_only {
        issues.push(
            "invalid_provenance",
            format!("{base}.implementation"),
            "authored-only incident must not claim executable matcher provenance",
        );
    }
}

/// Prove every persisted reservation still exists under the live exact
/// matcher: the embedded executable's digest, then the persisted matcher site
/// closing against its catalog location on the installed map.
pub fn validate_live_closure(manifest: &Js, root: &MapRoot) -> Vec<Issue> {
    let mut issues = Issues(Vec::new());
    let slots: Vec<Js> = manifest.get("slots").and_then(Js::as_array).cloned().unwrap_or_default();
    // (source, mapId) -> [(index, slot)], in first-seen order.
    let mut groups: Vec<((String, String), Vec<(usize, &Js)>)> = Vec::new();
    for (index, slot) in slots.iter().enumerate() {
        let implementation = slot.get("implementation");
        let source = implementation.and_then(|i| i.get("templateSource"));
        let site_id = implementation.and_then(|i| i.get("matcherSiteId"));
        if !is_str(implementation.and_then(|i| i.get("state")), "template-backed") || !truthy(source) || !truthy(site_id) {
            continue;
        }
        let key = (to_js_string(source), to_js_string(slot.get("mapId")));
        match groups.iter_mut().find(|(k, _)| *k == key) {
            Some((_, group)) => group.push((index, slot)),
            None => groups.push((key, vec![(index, slot)])),
        }
    }
    let options = SiteMatchOptions { min_score: None, max_sites: None, exact_catalog_site_resolution: true };
    for ((source, map_id), group) in &groups {
        let result = (|| -> Result<(), String> {
            let bytes = templates::template_bytes(source)
                .ok_or_else(|| format!("catalog template {source} is not embedded in this simforge binary"))?;
            let digest = sha256_bytes(bytes);
            for (index, slot) in group {
                let stated = slot.get("provenance").and_then(|p| p.get("templateDigest"));
                if !is_str(stated, &digest) {
                    issues.with(
                        "invalid_provenance",
                        format!("slots[{index}].provenance.templateDigest"),
                        format!("catalog template digest does not match the live executable {source}"),
                        Some(Value::String(digest.clone())),
                        val(stated),
                    );
                }
            }
            let document: Value = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
            let template = crate::template::parse_template_issues(&document)
                .map_err(|_| "the document is not a valid v2 scenario template".to_owned())?;
            let asset = root.load(map_id).map_err(|e| error_message(&e))?;
            let matched = match_on_map(&template, asset.bundle(), &options).map_err(|e| e.to_string())?;
            let locations = read_locations(root, map_id)?;
            for (index, slot) in group {
                let site_id = slot.get("implementation").and_then(|i| i.get("matcherSiteId"));
                let location_id = slot.get("site").and_then(|s| s.get("locationId"));
                let site = matched.report.sites.iter().find(|s| is_str(site_id, &s.site_id));
                let location = locations.iter().find(|l| {
                    l.get("id").is_some_and(|id| strict_eq(Some(id), location_id))
                });
                let closes = matches!((site, location), (Some(s), Some(l)) if matcher_site_closes_location(s, l, asset.bundle().index()));
                if !closes {
                    issues.push(
                        "invalid_site_binding",
                        format!("slots[{index}].implementation.matcherSiteId"),
                        format!(
                            "persisted matcher site {} no longer closes against catalog location {} under the live exact matcher",
                            to_js_string(site_id),
                            to_js_string(location_id)
                        ),
                    );
                }
            }
            Ok(())
        })();
        if let Err(message) = result {
            for (index, _) in group {
                issues.push(
                    "invalid_site_binding",
                    format!("slots[{index}].implementation.matcherSiteId"),
                    format!("could not execute the live exact matcher: {message}"),
                );
            }
        }
    }
    issues.0
}

/// `error.message` as the reference sees it: map-root errors are plain
/// (their reason), compiler errors come through N-API as `<code> at <path>: <reason>`.
fn error_message(error: &CompileError) -> String {
    match error.code.as_str() {
        "unknown_map" | "map_not_present" => error.reason.clone(),
        _ => error.to_string(),
    }
}

fn read_locations(root: &MapRoot, map_id: &str) -> Result<Vec<Js>, String> {
    let file = root.dir.join(map_id).join(crate::maps::LOCATIONS_FILE);
    let bytes = std::fs::read(&file).map_err(|e| e.to_string())?;
    let plain = super::unzip(bytes).map_err(|e| e.to_string())?;
    let catalog = Js::parse(&String::from_utf8_lossy(&plain))?;
    Ok(catalog.get("locations").and_then(Js::as_array).cloned().unwrap_or_default())
}

/// `catalog verify`: the static report plus the live closure (only when the
/// static checks pass). Returns the result document and whether it is ok.
pub fn catalog_verify(root: &MapRoot, file: &Path, options: &VerifyOptions) -> Result<(Value, bool), CompileError> {
    let bytes = std::fs::read(file).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            CompileError::at("file_not_found", file.display().to_string(), format!("cannot read {}", file.display()))
        } else {
            CompileError::at("invalid_json", file.display().to_string(), e.to_string())
        }
    })?;
    let value = Js::parse(&String::from_utf8_lossy(&bytes))
        .map_err(|e| CompileError::at("invalid_json", file.display().to_string(), e))?;
    let options = VerifyOptions { manifest_file: Some(file.to_path_buf()), ..options.clone() };
    let mut report = validate_catalog(&value, &options)?;
    if report.ok {
        let live = validate_live_closure(&value, root);
        if !live.is_empty() {
            report.ok = false;
            report.issues.extend(live);
        }
    }
    let mut payload = report.to_value();
    payload["manifest"] = Value::String(resolve(file).display().to_string());
    Ok((payload, report.ok))
}
