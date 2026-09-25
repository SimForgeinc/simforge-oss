//! `export`: a concrete instance as an ASAM OpenSCENARIO document.
//!
//! - `xosc-1.4`: OpenSCENARIO XML 1.4.0, trajectory replay: the instance is
//!   simulated once (warm-up included) and every actor follows its timed
//!   trace; appearance cues, despawns and signal-head states are scheduled at
//!   the times the run produced them.
//! - `xosc-1.3-esmini`: the same document lowered structurally to 1.3.1 for
//!   esmini (1.4-only elements removed, categories mapped).
//! - `osc-2.2`: OpenSCENARIO DSL 2.2.0, editable actions for the statically
//!   schedulable subset, checked by the profile's own syntax gate.
//!
//! Every document carries a capability report: what happened to each input
//! field and each authored construct. Unsupported content is refused with
//! structured issues (`asam_export_unsupported`, exit 2), never dropped.
//!
//! The instance is read the way JavaScript holds it ([`JsValue`]) so the
//! embedded JSON properties and numbers print exactly as they always have.

mod dsl;
mod dsl_syntax;
mod xml;

use std::path::Path;

use serde::Serialize;
use simforge_bindings_common::runtime::{Graph, RouteHandle};
use simforge_bindings_common::BindingError;
use simforge_compiler::CompileError;
use simforge_core::hash::js_number_to_string;
use simforge_core::math::js_round;

use crate::jsvalue::JsValue;
use crate::maps::MapRoot;
use crate::readers::read_instance;

pub use dsl_syntax::validate_dsl22_profile_syntax;

/// The three output formats.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AsamFormat {
    Xosc14,
    Xosc13Esmini,
    Osc22,
}

impl AsamFormat {
    pub const KNOWN: [&'static str; 3] = ["xosc-1.4", "xosc-1.3-esmini", "osc-2.2"];

    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "xosc-1.4" => Some(Self::Xosc14),
            "xosc-1.3-esmini" => Some(Self::Xosc13Esmini),
            "osc-2.2" => Some(Self::Osc22),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Xosc14 => "xosc-1.4",
            Self::Xosc13Esmini => "xosc-1.3-esmini",
            Self::Osc22 => "osc-2.2",
        }
    }
}

/// One refused feature.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AsamIssue {
    pub code: String,
    pub path: String,
    pub reason: String,
}

pub type AsamWarning = AsamIssue;

pub(crate) fn issue(code: &str, path: impl Into<String>, reason: impl Into<String>) -> AsamIssue {
    AsamIssue {
        code: code.to_owned(),
        path: path.into(),
        reason: reason.into(),
    }
}

/// Why an export stopped.
#[derive(Debug)]
pub enum ExportFailure {
    /// `AsamExportError`: unsupported or invalid features.
    Unsupported(Vec<AsamIssue>),
    /// Anything else (reported as the error it is).
    Error(CompileError),
}

impl From<CompileError> for ExportFailure {
    fn from(e: CompileError) -> Self {
        ExportFailure::Error(e)
    }
}

pub type ExportResult<T> = Result<T, ExportFailure>;

#[derive(Debug, Clone, Default)]
pub struct ExportOptions {
    pub road_file: Option<String>,
    pub author: Option<String>,
    pub description: Option<String>,
    pub route_sample_m: Option<f64>,
    /// Instance-manifest fields carried into the document, in any order
    /// (emitted sorted by key).
    pub provenance: Option<Vec<(String, JsValue)>>,
}

/* ------------------------------------------------------------ capability */

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Profile {
    Xml14Replay,
    Xml13EsminiReplay,
    Dsl22Actions,
}

impl Profile {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Profile::Xml14Replay => "xml-1.4-trajectory-replay",
            Profile::Xml13EsminiReplay => "xml-1.3-esmini-trajectory-replay",
            Profile::Dsl22Actions => "dsl-2.2-actions",
        }
    }
    fn replay(self) -> bool {
        matches!(self, Profile::Xml14Replay | Profile::Xml13EsminiReplay)
    }
    fn xml(self) -> bool {
        self.replay()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CapabilityEntry {
    pub path: &'static str,
    pub disposition: &'static str,
    pub fidelity: &'static str,
    pub reason: &'static str,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConstructEntry {
    pub source_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    pub kind: &'static str,
    pub disposition: &'static str,
    pub fidelity: &'static str,
    pub representation: &'static str,
    pub reason: &'static str,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CapabilitySummary {
    pub preserved: u32,
    pub derived: u32,
    pub extension: u32,
    pub omitted: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityReport {
    pub profile: &'static str,
    pub intent: &'static str,
    pub round_trip: &'static str,
    pub fields: Vec<CapabilityEntry>,
    pub constructs: Vec<ConstructEntry>,
    pub summary: CapabilitySummary,
    pub external_simulator_validation: &'static str,
}

fn d(
    path: &'static str,
    disposition: &'static str,
    fidelity: &'static str,
    reason: &'static str,
) -> CapabilityEntry {
    CapabilityEntry {
        path,
        disposition,
        fidelity,
        reason,
    }
}

/// Every top-level input field's disposition under `profile`.
fn capability_decisions(profile: Profile) -> Vec<CapabilityEntry> {
    let replay = profile.replay();
    vec![
        d("schemaVersion", "extension", "metadata-only", "recorded as SimForge provenance, not an ASAM schema version"),
        d("mapId", "preserved", "exact", "represented by the referenced road-network file"),
        d("clipSeconds", "preserved", "exact", "represented by the storyboard/scenario duration"),
        d("warmupSeconds", "preserved", "exact", "represented by shifting the ASAM clock origin"),
        if replay {
            d("dt", "extension", "metadata-only", "recorded as replay sampling provenance; vertices use this sampling interval")
        } else {
            d("dt", "omitted", "none", "engine integration timestep has no editable ASAM action equivalent")
        },
        if replay {
            d("seed", "extension", "metadata-only", "recorded as replay provenance; stochastic outcomes are baked into the trace")
        } else {
            d("seed", "omitted", "none", "engine random seed has no portable editable ASAM action equivalent")
        },
        d("physics", "extension", "metadata-only", "motion/physics mode and solver provenance are retained in SimForge Properties; editable ASAM behavior is not claimed to preserve the selected solver"),
        if replay {
            d("operationalConditions", "derived", "approximate", "weather, time, visibility and scene friction use standard Environment fields plus exact extension metadata; traffic effects are baked into sampled motion")
        } else {
            d("operationalConditions", "omitted", "none", "this profile does not emit environment/weather/traffic declarations")
        },
        if replay {
            d("surfacePatches", "derived", "approximate", "reduced-grip regions are baked into sampled motion and retained as exact extension metadata; localized grip is not a standard OpenSCENARIO road condition")
        } else {
            d("surfacePatches", "omitted", "none", "ASAM road conditions are scene-wide; a bounded low-grip region has no portable equivalent and promoting it to the whole scene would alter the scenario")
        },
        d("metricSubject", "omitted", "none", "SimForge metric evaluation is outside the exported execution model"),
        if replay {
            d("actors", "derived", "approximate", "identity and geometry are preserved; motion is a sampled simulation trace")
        } else {
            d("actors", "preserved", "approximate", "entities, initial state, route, and supported controller behavior are mapped to standard constructs")
        },
        if replay {
            d("interactions", "derived", "approximate", "outcomes are baked into trajectories; causal triggers and authoring intent are flattened")
        } else {
            d("interactions", "preserved", "approximate", "supported actions and triggers are mapped; unsupported variants reject export")
        },
        if replay {
            d("signalPrograms", "derived", "approximate", "sampled signal-head states are replayed; authored cycle semantics are flattened")
        } else {
            d("signalPrograms", "omitted", "none", "the concrete DSL profile has no traffic-light program mapping")
        },
        if replay {
            d("roadControls", "derived", "approximate", "stop/yield responses are baked into sampled actor motion; portable lane-control declarations are flattened")
        } else {
            d("roadControls", "omitted", "none", "road-control declarations are not emitted by the current actions profiles")
        },
        d("props", "omitted", "none", "render-catalog props are not emitted by the current profiles"),
        d("occluders", "preserved", "approximate", "exported as stationary bounding-box objects without catalog appearance"),
        d("occlusionPairs", "omitted", "none", "line-of-sight evaluation pairs are not an ASAM execution concept"),
        d("nearMissCriteria", "extension", "metadata-only", "executable triggers/trajectories are standard; exact OBB-clearance acceptance is retained in SimForge Properties"),
        if replay {
            d("perception", "derived", "approximate", "sensor-driven reactions are baked into the sampled trajectories; the detection channel and its causes are retained only as SimForge provenance")
        } else {
            d("perception", "extension", "metadata-only", "sensor mounts, detection thresholds and declared map/percept divergence are retained in SimForge Properties; ASAM has no portable sensor-detection execution model")
        },
    ]
}

fn array_len(input: &JsValue, key: &str) -> usize {
    input
        .get(key)
        .and_then(JsValue::as_array)
        .map_or(0, <[JsValue]>::len)
}

fn field_has_material_value(input: &JsValue, path: &str) -> bool {
    match path {
        "physics" | "metricSubject" | "perception" => input.get(path).is_some(),
        "interactions" | "signalPrograms" | "roadControls" | "props" | "occluders"
        | "occlusionPairs" | "nearMissCriteria" => array_len(input, path) > 0,
        _ => true,
    }
}

pub(crate) fn items<'a>(input: &'a JsValue, key: &str) -> &'a [JsValue] {
    input.get(key).and_then(JsValue::as_array).unwrap_or(&[])
}

pub(crate) fn text<'a>(value: &'a JsValue, key: &str) -> &'a str {
    value.get(key).and_then(JsValue::as_str).unwrap_or("")
}

pub(crate) fn num(value: &JsValue, path: &[&str]) -> f64 {
    value.at(path).and_then(JsValue::as_f64).unwrap_or(f64::NAN)
}

pub(crate) fn flag(value: &JsValue, path: &[&str]) -> bool {
    value.at(path).is_some_and(JsValue::truthy)
}

fn construct(
    source_path: String,
    source_id: Option<String>,
    kind: &'static str,
    disposition: &'static str,
    fidelity: &'static str,
    representation: &'static str,
    reason: &'static str,
) -> ConstructEntry {
    ConstructEntry {
        source_path,
        source_id,
        kind,
        disposition,
        fidelity,
        representation,
        reason,
    }
}

fn id_of(value: &JsValue) -> Option<String> {
    value.get("id").and_then(JsValue::as_str).map(str::to_owned)
}

fn construct_capabilities(input: &JsValue, profile: Profile) -> Vec<ConstructEntry> {
    let replay = profile.replay();
    let xml = profile.xml();
    let mut out = Vec::new();
    for (i, actor) in items(input, "actors").iter().enumerate() {
        out.push(construct(
            format!("actors.{i}"),
            id_of(actor),
            "actor",
            if replay { "derived" } else { "preserved" },
            "approximate",
            if replay { "standard-trajectory" } else { "standard-entity" },
            if replay {
                "exact actor identity and sampled signed motion are emitted; controller intent is replaced by the authoritative simulation outcome"
            } else {
                "identity, dimensions, initial state and supported controller semantics are emitted as standard OpenSCENARIO constructs"
            },
        ));
    }
    for (i, interaction) in items(input, "interactions").iter().enumerate() {
        out.push(construct(
            format!("interactions.{i}"),
            id_of(interaction),
            "interaction",
            if replay { "derived" } else { "preserved" },
            "approximate",
            if replay { "simulated-outcome" } else { "profile-action" },
            if replay {
                "the interaction id, actor, verb and exact trace events are retained while its physical result is represented by sampled trajectories"
            } else {
                "the supported action and trigger are lowered to the selected editable profile"
            },
        ));
    }
    for (i, program) in items(input, "signalPrograms").iter().enumerate() {
        out.push(construct(
            format!("signalPrograms.{i}"),
            id_of(program),
            "signal-program",
            if replay { "derived" } else { "preserved" },
            "approximate",
            if replay { "standard-signal-state" } else { "profile-signal-controller" },
            if replay {
                "exact logical indications and physical-head state transitions are retained; authored cycle causality is flattened"
            } else {
                "the authored cycle is represented by standard traffic-signal controller phases after validation"
            },
        ));
    }
    let env = replay && xml;
    out.push(construct(
        "operationalConditions".into(),
        None,
        "environment",
        if env { "derived" } else { "extension" },
        if env { "approximate" } else { "metadata-only" },
        if env { "standard-environment" } else { "simforge-property" },
        if env {
            "weather, time of day, visibility and scene friction are emitted as standard Environment fields and exact SimForge metadata; traffic density effects remain baked into motion"
        } else {
            "environment intent is retained only as SimForge metadata in this profile"
        },
    ));
    for (i, patch) in items(input, "surfacePatches").iter().enumerate() {
        out.push(construct(
            format!("surfacePatches.{i}"),
            id_of(patch),
            "surface-patch",
            if replay { "derived" } else { "extension" },
            if replay { "approximate" } else { "metadata-only" },
            if replay { "simulated-outcome" } else { "simforge-property" },
            if replay {
                "localized grip effects are baked into sampled motion and the exact authored patch is retained as metadata because OpenSCENARIO has only scene-wide road friction"
            } else {
                "the exact authored patch is metadata-only because OpenSCENARIO has no localized road-friction field"
            },
        ));
    }
    for (i, occluder) in items(input, "occluders").iter().enumerate() {
        out.push(construct(
            format!("occluders.{i}"),
            id_of(occluder),
            "occluder",
            "preserved",
            "approximate",
            "standard-entity",
            "identity, pose and collision dimensions are emitted; catalog appearance is not portable",
        ));
    }
    if input.get("perception").is_some_and(JsValue::truthy) {
        out.push(construct(
            "perception".into(),
            None,
            "perception",
            if replay { "derived" } else { "extension" },
            if replay { "approximate" } else { "metadata-only" },
            if replay { "simulated-outcome" } else { "simforge-property" },
            if replay {
                "perception-driven reactions are baked into trajectories and the authored configuration is retained as exact metadata"
            } else {
                "OpenSCENARIO has no portable sensor-detection execution model; the authored configuration is retained as metadata"
            },
        ));
    }
    out.push(construct(
        "physics".into(),
        None,
        "physics",
        "extension",
        "metadata-only",
        "simforge-property",
        "the selected SimForge solver and resolved backend provenance are retained without claiming equivalent external-simulator physics",
    ));
    out
}

/// `analyzeAsamCapabilities(input, profile)`.
pub(crate) fn analyze_capabilities(
    input: &JsValue,
    profile: Profile,
) -> (CapabilityReport, Vec<AsamWarning>) {
    let fields = capability_decisions(profile);
    let mut summary = CapabilitySummary {
        preserved: 0,
        derived: 0,
        extension: 0,
        omitted: 0,
    };
    for f in &fields {
        match f.disposition {
            "preserved" => summary.preserved += 1,
            "derived" => summary.derived += 1,
            "extension" => summary.extension += 1,
            _ => summary.omitted += 1,
        }
    }
    let replay = profile.replay();
    let constructs = construct_capabilities(input, profile);
    let mut warnings: Vec<AsamWarning> = fields
        .iter()
        .filter(|f| field_has_material_value(input, f.path))
        .filter_map(|f| match f.disposition {
            "omitted" => Some(issue("field_omitted", f.path, f.reason)),
            "derived" => Some(issue("semantic_intent_flattened", f.path, f.reason)),
            _ => None,
        })
        .collect();
    if !replay {
        for (i, actor) in items(input, "actors").iter().enumerate() {
            if actor
                .at(&["initial", "laneRef"])
                .is_some_and(JsValue::truthy)
            {
                warnings.push(issue(
                    "lane_reference_flattened",
                    format!("actors.{i}.initial.laneRef"),
                    "the resolved world pose/route is exported, but the engine lane reference is not editable in this ASAM profile",
                ));
            }
            if profile == Profile::Dsl22Actions && !items(actor, "tags").is_empty() {
                warnings.push(issue(
                    "actor_tags_omitted",
                    format!("actors.{i}.tags"),
                    "free-form SimForge actor tags have no field in the concrete DSL entity declaration profile",
                ));
            }
        }
    }
    for (i, actor) in items(input, "actors").iter().enumerate() {
        if let Some(tag) = items(actor, "tags")
            .iter()
            .filter_map(JsValue::as_str)
            .find(|t| t.starts_with("catalog:"))
        {
            warnings.push(issue(
                "catalog_appearance_approximate",
                format!("actors.{i}.tags"),
                format!(
                    "{} is exported with semantic class and dimensions, but its procedural Studio appearance is not portable OpenSCENARIO catalog geometry",
                    &tag["catalog:".len()..]
                ),
            ));
        }
    }
    for interaction in items(input, "interactions") {
        if text(interaction, "verb") != "set" {
            continue;
        }
        let key = interaction
            .at(&["target", "key"])
            .and_then(JsValue::as_str)
            .unwrap_or("");
        if key == "lights.emergency" || key == "audio.horn" {
            warnings.push(issue(
                "nonportable_emergency_cue",
                format!("interactions.{}.target.key", text(interaction, "id")),
                format!("{key} is retained as a user-defined XML appearance cue where supported; external simulators are not required to render light, siren, or horn output"),
            ));
        }
    }
    let report = CapabilityReport {
        profile: profile.as_str(),
        intent: if replay {
            "trajectory-replay"
        } else {
            "editable-semantic"
        },
        round_trip: "not-supported",
        fields,
        constructs,
        summary,
        external_simulator_validation: "not-verified",
    };
    (report, warnings)
}

/// `mergeAsamWarnings`: concatenated, first occurrence of each warning kept.
pub(crate) fn merge_warnings(groups: &[&[AsamWarning]]) -> Vec<AsamWarning> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for group in groups {
        for w in *group {
            if seen.insert((w.code.clone(), w.path.clone(), w.reason.clone())) {
                out.push(w.clone());
            }
        }
    }
    out
}

/* --------------------------------------------------------------- helpers */

const DSL_KEYWORDS: &[&str] = &[
    "action",
    "actor",
    "and",
    "as",
    "bool",
    "call",
    "cover",
    "default",
    "def",
    "do",
    "else",
    "emit",
    "enum",
    "event",
    "extend",
    "false",
    "float",
    "hard",
    "if",
    "import",
    "in",
    "inherits",
    "int",
    "is",
    "it",
    "keep",
    "list",
    "modifier",
    "not",
    "of",
    "on",
    "one_of",
    "or",
    "parallel",
    "range",
    "record",
    "remove_default",
    "scenario",
    "serial",
    "string",
    "struct",
    "true",
    "uint",
    "until",
    "var",
    "wait",
    "with",
];

/// `identifier(prefix, raw)`: a name every output grammar accepts.
pub(crate) fn identifier(prefix: &str, raw: &str) -> String {
    let mut stem = String::with_capacity(raw.len());
    for ch in raw.chars() {
        let c = if ch.is_ascii_alphanumeric() || ch == '_' {
            ch
        } else {
            '_'
        };
        if c == '_' && stem.ends_with('_') {
            continue;
        }
        stem.push(c);
    }
    let stem = stem.trim_matches('_').to_owned();
    let stem = if stem.is_empty()
        || stem.starts_with(|c: char| c.is_ascii_digit())
        || DSL_KEYWORDS.contains(&stem.as_str())
    {
        format!("id_{}", if stem.is_empty() { "unnamed" } else { &stem })
    } else {
        stem
    };
    format!("{prefix}_{stem}")
}

/// `finite(value)`: rounded to 1e-9, printed as JavaScript prints numbers.
pub(crate) fn finite(value: f64) -> String {
    if !value.is_finite() {
        return "NaN".to_owned();
    }
    js_number_to_string(js_round(value * 1e9) / 1e9)
}

/// JavaScript `String(number)`.
pub(crate) fn js_num(value: f64) -> String {
    js_number_to_string(value)
}

/// XML attribute/text escape.
pub(crate) fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// JavaScript `String(value)` of a JSON value.
pub(crate) fn js_string(value: &JsValue) -> String {
    match value {
        JsValue::Null => "null".into(),
        JsValue::Bool(b) => b.to_string(),
        JsValue::Number(n) => js_num(*n),
        JsValue::String(s) => s.clone(),
        JsValue::Array(items) => items
            .iter()
            .map(|v| {
                if matches!(v, JsValue::Null) {
                    String::new()
                } else {
                    js_string(v)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        JsValue::Object(_) => "[object Object]".into(),
    }
}

/// `JSON.stringify(value)`.
pub(crate) fn stringify(value: &JsValue) -> String {
    crate::json::to_compact_js(value).unwrap_or_default()
}

/// Build a route for an authored spec; an engine refusal is an issue at `path`.
pub(crate) fn build_route(
    graph: &Graph,
    spec: &JsValue,
    path: &str,
) -> ExportResult<Result<RouteHandle, AsamIssue>> {
    match graph.route(&stringify(spec)) {
        Ok(route) => Ok(Ok(route)),
        Err(BindingError::Argument(message)) => {
            let parsed: Option<serde_json::Value> = serde_json::from_str(&message).ok();
            let field = |k: &str| {
                parsed
                    .as_ref()
                    .and_then(|p| p.get(k))
                    .and_then(|v| v.as_str())
                    .map(str::to_owned)
            };
            Ok(Err(AsamIssue {
                code: field("code").unwrap_or_else(|| "route_build_failed".into()),
                path: path.to_owned(),
                reason: field("reason").unwrap_or(message),
            }))
        }
        Err(other) => Err(ExportFailure::Error(crate::engine::engine_error(other))),
    }
}

/// A scene-frame pose (`x`, `z = -y`, heading).
#[derive(Debug, Clone, Copy)]
pub(crate) struct Pose {
    pub x: f64,
    pub z: f64,
    pub heading_rad: f64,
}

/// Sample a route at about `sample_m` spacing, both ends included.
pub(crate) fn route_points(route: &RouteHandle, sample_m: f64) -> Vec<Pose> {
    let length = route.length_m();
    let count = ((length / sample_m).ceil() as i64 + 1).max(2) as usize;
    (0..count)
        .map(|i| {
            let [x, y, heading_rad] = route.pose_at(length * i as f64 / (count - 1) as f64);
            Pose {
                x,
                z: -y,
                heading_rad,
            }
        })
        .collect()
}

pub(crate) struct ResolvedActor<'a> {
    pub actor: &'a JsValue,
    pub name: String,
    pub route_name: String,
    pub points: Vec<Pose>,
}

pub(crate) struct ResolvedInteraction<'a> {
    pub interaction: &'a JsValue,
    pub name: String,
    pub start_time_s: Option<f64>,
}

pub(crate) struct Resolved<'a> {
    pub actors: Vec<ResolvedActor<'a>>,
    pub interactions: Vec<ResolvedInteraction<'a>>,
    pub actor_names: std::collections::HashMap<String, String>,
}

fn dynamics_duration(interaction: &JsValue) -> Option<f64> {
    let Some(dynamics) = interaction.get("dynamics") else {
        return Some(0.0);
    };
    if text(dynamics, "shape") == "step" {
        return Some(0.0);
    }
    if text(dynamics, "constraint") == "time" {
        Some(num(dynamics, &["value"]))
    } else {
        None
    }
}

/// `resolveStaticStartTimes`: `at`/`after` triggers to absolute time.
fn resolve_static_start_times(
    interactions: &[JsValue],
    offset_s: f64,
) -> (std::collections::HashMap<String, f64>, Vec<AsamIssue>) {
    use std::collections::{HashMap, HashSet};
    struct Walk<'a> {
        by_id: HashMap<&'a str, &'a JsValue>,
        times: HashMap<String, f64>,
        visiting: HashSet<String>,
        issues: Vec<AsamIssue>,
        offset: f64,
    }
    impl<'a> Walk<'a> {
        fn visit(&mut self, interaction: &'a JsValue) -> Option<f64> {
            let id = text(interaction, "id").to_owned();
            if let Some(t) = self.times.get(&id) {
                return Some(*t);
            }
            let path = format!("interactions.{id}.trigger");
            if self.visiting.contains(&id) {
                self.issues.push(issue(
                    "trigger_cycle",
                    path,
                    "after() dependency cycle is not exportable",
                ));
                return None;
            }
            self.visiting.insert(id.clone());
            let trigger = interaction.get("trigger").cloned().unwrap_or(JsValue::Null);
            let kind = text(&trigger, "kind").to_owned();
            let mut value = None;
            if kind == "at" {
                value = Some(self.offset + num(&trigger, &["t"]).max(0.0));
            } else if kind == "after" {
                let parent_id = text(&trigger, "interactionId").to_owned();
                match self.by_id.get(parent_id.as_str()).copied() {
                    None => self.issues.push(issue(
                        "unknown_interaction",
                        path.clone(),
                        format!("unknown interaction {parent_id}"),
                    )),
                    Some(parent) => {
                        let parent_start = self.visit(parent);
                        match dynamics_duration(parent) {
                            None => {
                                let constraint = parent
                                    .get("dynamics")
                                    .map(|d| text(d, "constraint").to_owned())
                                    .unwrap_or_else(|| "runtime state".into());
                                self.issues.push(issue(
                                    "non_static_after",
                                    path.clone(),
                                    format!(
                                        "after({}) depends on a {} action whose duration is constrained by {constraint}",
                                        text(parent, "id"),
                                        text(parent, "verb")
                                    ),
                                ));
                            }
                            Some(duration) => {
                                if let Some(start) = parent_start {
                                    value = Some(start + duration + num(&trigger, &["delayS"]));
                                }
                            }
                        }
                    }
                }
            } else {
                self.issues.push(issue(
                    "unsupported_trigger",
                    path,
                    format!("{kind} triggers are not in the concrete DSL 2.2 export profile"),
                ));
            }
            self.visiting.remove(&id);
            if let Some(v) = value {
                self.times.insert(id, v);
            }
            value
        }
    }
    let mut walk = Walk {
        by_id: interactions.iter().map(|i| (text(i, "id"), i)).collect(),
        times: HashMap::new(),
        visiting: HashSet::new(),
        issues: Vec::new(),
        offset: offset_s,
    };
    for interaction in interactions {
        walk.visit(interaction);
    }
    (walk.times, walk.issues)
}

/// `resolveScenario`: names, routes and (DSL) static start times; refuses
/// identifier collisions, unbuildable or degenerate routes.
pub(crate) fn resolve_scenario<'a>(
    input: &'a JsValue,
    graph: &Graph,
    options: &ExportOptions,
    include_static_times: bool,
) -> ExportResult<Resolved<'a>> {
    let mut issues = Vec::new();
    let mut actor_names = std::collections::HashMap::new();
    let mut interaction_names = std::collections::HashMap::new();
    let mut all = std::collections::HashSet::new();
    for (i, actor) in items(input, "actors").iter().enumerate() {
        let id = text(actor, "id");
        let name = identifier("actor", id);
        if !all.insert(name.clone()) {
            issues.push(issue(
                "identifier_collision",
                format!("actors.{i}.id"),
                format!("{id} normalizes to duplicate {name}"),
            ));
        }
        actor_names.insert(id.to_owned(), name);
    }
    for (i, interaction) in items(input, "interactions").iter().enumerate() {
        let id = text(interaction, "id");
        let name = identifier("event", id);
        if !all.insert(name.clone()) {
            issues.push(issue(
                "identifier_collision",
                format!("interactions.{i}.id"),
                format!("{id} normalizes to duplicate {name}"),
            ));
        }
        interaction_names.insert(id.to_owned(), name);
    }
    let mut actors = Vec::new();
    for (i, actor) in items(input, "actors").iter().enumerate() {
        let path = format!("actors.{i}.behavior.route");
        let spec = actor
            .at(&["behavior", "route"])
            .cloned()
            .unwrap_or(JsValue::Null);
        let route = match build_route(graph, &spec, &path)? {
            Ok(route) => route,
            Err(found) => {
                issues.push(found);
                continue;
            }
        };
        if route.length_m() <= 1e-6 {
            issues.push(issue(
                "route_too_short",
                path,
                "ASAM routes require at least two distinct world positions",
            ));
            continue;
        }
        let step = options.route_sample_m.unwrap_or(20.0);
        if !step.is_finite() || step <= 0.0 {
            issues.push(issue(
                "bad_route_sample",
                "routeSampleM",
                "route sample distance must be positive",
            ));
            continue;
        }
        let id = text(actor, "id");
        actors.push(ResolvedActor {
            actor,
            name: actor_names[id].clone(),
            route_name: identifier("route", id),
            points: route_points(&route, step),
        });
    }
    let mut static_times = std::collections::HashMap::new();
    if include_static_times {
        // ASAM execution begins at the unrecorded warm-up origin: the recorded
        // t = 0 happens at ASAM t = warmupSeconds.
        let (times, found) = resolve_static_start_times(
            items(input, "interactions"),
            num(input, &["warmupSeconds"]),
        );
        static_times = times;
        issues.extend(found);
    }
    let interactions = items(input, "interactions")
        .iter()
        .map(|interaction| {
            let id = text(interaction, "id");
            ResolvedInteraction {
                interaction,
                name: interaction_names[id].clone(),
                start_time_s: static_times.get(id).copied(),
            }
        })
        .collect();
    if !issues.is_empty() {
        return Err(ExportFailure::Unsupported(issues));
    }
    Ok(Resolved {
        actors,
        interactions,
        actor_names,
    })
}

/// `assertDefaultControllerRules`: an actor exports with the default
/// controller's meaning only when its cruise target is its initial speed;
/// reactive rules export with a warning.
pub(crate) fn assert_default_controller_rules(input: &JsValue) -> ExportResult<Vec<AsamWarning>> {
    let mut issues = Vec::new();
    let mut warnings = Vec::new();
    for (i, actor) in items(input, "actors").iter().enumerate() {
        if flag(actor, &["static"]) {
            continue;
        }
        let reactive: Vec<&str> = [
            "obeySignals",
            "yieldToVehicles",
            "yieldToPedestrians",
            "collisionAvoidance",
        ]
        .into_iter()
        .filter(|rule| flag(actor, &["behavior", "rules", rule]))
        .collect();
        if !reactive.is_empty() {
            warnings.push(issue(
                "reactive_controller_not_portable",
                format!("actors.{i}.behavior.rules"),
                format!(
                    "{} {} SimForge controller reactions; the OpenSCENARIO default controller keeps lane and speed and will not reproduce them",
                    reactive.join(", "),
                    if reactive.len() == 1 { "is" } else { "are" }
                ),
            ));
        }
        let cruise = actor
            .at(&["behavior", "cruiseSpeedMps"])
            .and_then(JsValue::as_f64);
        let initial = num(actor, &["initial", "speedMps"]);
        let differs = match cruise {
            None => true,
            // `!(|d| <= 1e-9)`, NaN included, as in the TS.
            Some(c) => !matches!(
                (c - initial).abs().partial_cmp(&1e-9),
                Some(std::cmp::Ordering::Less | std::cmp::Ordering::Equal)
            ),
        };
        if differs {
            issues.push(issue(
                "unsupported_cruise_controller",
                format!("actors.{i}.behavior.cruiseSpeedMps"),
                if cruise.is_none() {
                    "an omitted cruise target makes the actor cruise at the lane speed limit; the OpenSCENARIO default controller keeps the initial speed"
                } else {
                    "a cruise target different from the initial speed needs an implementation-specific controller"
                },
            ));
        }
    }
    if !issues.is_empty() {
        return Err(ExportFailure::Unsupported(issues));
    }
    Ok(warnings)
}

/// `physics.mode` and `physics.substepS` of the input (defaults applied).
pub(crate) fn physics_of(input: &JsValue, typed_mode: &str) -> (String, f64) {
    let mode = input
        .at(&["physics", "mode"])
        .and_then(JsValue::as_str)
        .map_or_else(|| typed_mode.to_owned(), str::to_owned);
    let substep = input
        .at(&["physics", "substepS"])
        .and_then(JsValue::as_f64)
        .unwrap_or(0.005);
    (mode, substep)
}

/// `actorPhysicsBackends(actors)`, sorted by actor id, as the header prints it.
pub(crate) fn actor_backends(input: &JsValue) -> String {
    let mut rows: Vec<(String, String)> = items(input, "actors")
        .iter()
        .map(|a| {
            let kind = text(a, "kind");
            let row = if flag(a, &["static"]) || kind == "static_object" {
                "fixed-static-v1:static-actor:fixed-static".to_owned()
            } else {
                format!("dynamic-v1:selected:{kind}")
            };
            (text(a, "id").to_owned(), row)
        })
        .collect();
    rows.sort_by(|a, b| simforge_core::hash::cmp_locale(&a.0, &b.0));
    rows.into_iter()
        .map(|(id, row)| format!("{id}:{row}"))
        .collect::<Vec<_>>()
        .join(",")
}

/// A finished document.
#[derive(Debug, Clone)]
pub struct ExportDocument {
    pub format: AsamFormat,
    pub standard: &'static str,
    pub media_type: &'static str,
    pub content: String,
    pub warnings: Vec<AsamWarning>,
    pub capability_report: CapabilityReport,
}

/// `simforge export <instance> --format --out`: the document and the
/// result payload.
pub fn run_export(
    root: &MapRoot,
    file: &Path,
    file_arg: &str,
    format: AsamFormat,
    out: &Path,
    options: &ExportOptions,
) -> Result<JsValue, CompileError> {
    let instance = read_instance(file)?;
    let map = root.load(&instance.input.map_id)?;
    let mut options = options.clone();
    if let Some(manifest) = instance.document.get("manifest") {
        if let Some(JsValue::Object(key)) = manifest.get("replayKey") {
            let mut provenance = key.clone();
            let mut set =
                |k: &str, v: JsValue| match provenance.iter_mut().find(|(name, _)| name == k) {
                    Some(slot) => slot.1 = v,
                    None => provenance.push((k.to_owned(), v)),
                };
            set(
                "instanceId",
                manifest.get("instanceId").cloned().unwrap_or(JsValue::Null),
            );
            set(
                "inputHash",
                manifest.get("inputHash").cloned().unwrap_or(JsValue::Null),
            );
            options.provenance = Some(provenance);
        }
    }
    let input = instance
        .document
        .get("input")
        .cloned()
        .unwrap_or(JsValue::Null);
    let result = match format {
        AsamFormat::Xosc14 => xml::export_xml14(&input, &instance.input, &map, &options),
        AsamFormat::Xosc13Esmini => {
            xml::export_xml13_esmini(&input, &instance.input, &map, &options)
        }
        AsamFormat::Osc22 => dsl::export_dsl22(&input, &instance.input, &map, &options),
    };
    let document = match result {
        Ok(document) => document,
        Err(ExportFailure::Unsupported(issues)) => {
            return Err(CompileError::at(
                "asam_export_unsupported",
                file_arg,
                format!(
                    "ASAM export rejected {} unsupported or invalid feature{}",
                    issues.len(),
                    if issues.len() == 1 { "" } else { "s" }
                ),
            )
            .detail_entry("format", serde_json::Value::String(format.as_str().into()))
            .detail_entry("issues", serde_json::json!(issues))
            .as_findings());
        }
        Err(ExportFailure::Error(e)) => return Err(e),
    };
    let absolute = crate::paths::resolve(out);
    if let Some(parent) = absolute.parent() {
        std::fs::create_dir_all(parent).map_err(|e| crate::json::io_error(parent, e))?;
    }
    std::fs::write(&absolute, &document.content)
        .map_err(|e| crate::json::io_error(&absolute, e))?;
    let report = &document.capability_report;
    let payload = JsValue::object(vec![
        ("ok".into(), JsValue::Bool(true)),
        (
            "format".into(),
            JsValue::String(document.format.as_str().into()),
        ),
        ("standard".into(), JsValue::String(document.standard.into())),
        ("profile".into(), JsValue::String(report.profile.into())),
        ("intent".into(), JsValue::String(report.intent.into())),
        (
            "roundTrip".into(),
            JsValue::String(report.round_trip.into()),
        ),
        (
            "externalSimulatorValidation".into(),
            JsValue::String(report.external_simulator_validation.into()),
        ),
        ("capabilityReport".into(), JsValue::from_serialize(report)?),
        (
            "mediaType".into(),
            JsValue::String(document.media_type.into()),
        ),
        (
            "out".into(),
            JsValue::String(absolute.display().to_string()),
        ),
        (
            "bytes".into(),
            JsValue::Number(document.content.len() as f64),
        ),
        (
            "warnings".into(),
            JsValue::from_serialize(&document.warnings)?,
        ),
    ]);
    Ok(payload)
}
