//! Evidence integrity: is this trace the run of this instance?
//!
//! A batch result is admissible evidence only when the concrete instance and
//! the trace came from the same `SimScenarioInput`. The join key is the engine
//! input hash: `sha256(canonicalJson(input))` in the instance manifest must
//! equal `trace.header.inputHash`, and the map, actor set, engine graph,
//! catalog closure, operational conditions and physics mode must agree too.
//!
//! The check reads both documents the way JavaScript holds them
//! ([`JsValue`]): a field that is missing or of the wrong type is reported,
//! never assumed.

use serde::Serialize;
use simforge_core::hash::cmp_utf16;

use crate::json::to_compact_js;
use crate::jsvalue::{content_hash, JsValue};

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct EvidenceHashIssue {
    pub code: &'static str,
    pub reason: &'static str,
    /// Absent when the expected value was `JSON.stringify(undefined)`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected: Option<JsValue>,
    pub actual: JsValue,
}

fn text(value: impl Into<String>) -> Option<JsValue> {
    Some(JsValue::String(value.into()))
}

/// `EvidenceHashReport`, field for field.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceHashReport {
    pub ok: bool,
    pub recomputed_input_hash: String,
    pub manifest_input_hash: JsValue,
    pub trace_input_hash: JsValue,
    pub input_actor_ids: Vec<String>,
    pub trace_actor_ids: Vec<String>,
    pub trace_track_actor_ids: Vec<String>,
    pub actor_ids: Vec<String>,
    pub actor_count: usize,
    pub input_map_id: JsValue,
    pub manifest_map_id: Option<String>,
    pub trace_map_id: Option<String>,
    pub matcher_index_digest: Option<String>,
    pub manifest_engine_graph_digest: Option<String>,
    pub trace_engine_graph_digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub physics_mode: Option<JsValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub physics_provenance: Option<&'static str>,
    pub issues: Vec<EvidenceHashIssue>,
}

impl EvidenceHashReport {
    /// The report a cell carries when it failed before any evidence existed.
    pub fn empty(map_id: &str) -> Self {
        Self {
            ok: false,
            recomputed_input_hash: String::new(),
            manifest_input_hash: JsValue::Null,
            trace_input_hash: JsValue::Null,
            input_actor_ids: Vec::new(),
            trace_actor_ids: Vec::new(),
            trace_track_actor_ids: Vec::new(),
            actor_ids: Vec::new(),
            actor_count: 0,
            input_map_id: JsValue::String(map_id.to_owned()),
            manifest_map_id: None,
            trace_map_id: None,
            matcher_index_digest: None,
            manifest_engine_graph_digest: None,
            trace_engine_graph_digest: None,
            physics_mode: None,
            physics_provenance: None,
            issues: Vec::new(),
        }
    }
}

/// The trace as the check reads it: its header and the ids of its actor tracks.
pub struct TraceView<'a> {
    pub header: &'a JsValue,
    pub track_ids: Vec<String>,
}

fn string_or_null(value: Option<&JsValue>) -> Option<String> {
    match value {
        Some(JsValue::String(s)) if !s.is_empty() => Some(s.clone()),
        _ => None,
    }
}

fn js_sort(mut values: Vec<String>) -> Vec<String> {
    values.sort_by(|a, b| cmp_utf16(a, b));
    values
}

/// `sortedUniqueStrings`: the string entries of an array, sorted.
fn sorted_strings(value: Option<&JsValue>) -> Vec<String> {
    match value {
        Some(JsValue::Array(items)) => js_sort(
            items
                .iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect(),
        ),
        _ => Vec::new(),
    }
}

/// `x ?? null`: missing becomes `null`.
fn or_null(value: Option<&JsValue>) -> JsValue {
    value.cloned().unwrap_or(JsValue::Null)
}

fn is_string(value: &JsValue, expected: &str) -> bool {
    value.as_str() == Some(expected)
}

/// `contentHash(a) === contentHash(b)`, `undefined` hashing as `null`.
fn same_canonical(a: Option<&JsValue>, b: Option<&JsValue>) -> bool {
    let null = JsValue::Null;
    content_hash(a.unwrap_or(&null)) == content_hash(b.unwrap_or(&null))
}

/// `JSON.stringify(value)`; `None` is `undefined`.
fn stringify(value: Option<&JsValue>) -> Option<String> {
    value.map(|v| to_compact_js(v).unwrap_or_default())
}

fn stringify_or_null(value: Option<&JsValue>) -> String {
    stringify(value).unwrap_or_else(|| "null".to_owned())
}

fn hex64(value: Option<&JsValue>) -> bool {
    value.and_then(JsValue::as_str).is_some_and(|s| {
        s.len() == 64
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}

/// `a !== b` for two JavaScript values (`None` is `undefined`); objects and
/// arrays are never strictly equal to a value read separately.
fn js_ne(a: Option<&JsValue>, b: Option<&JsValue>) -> bool {
    let same = match (a, b) {
        (None, None) => true,
        (Some(JsValue::Null), Some(JsValue::Null)) => true,
        (Some(JsValue::Bool(x)), Some(JsValue::Bool(y))) => x == y,
        (Some(JsValue::Number(x)), Some(JsValue::Number(y))) => x == y,
        (Some(JsValue::String(x)), Some(JsValue::String(y))) => x == y,
        _ => false,
    };
    !same
}

fn nonempty(value: Option<&JsValue>) -> bool {
    match value {
        Some(JsValue::String(s)) => !s.is_empty(),
        Some(JsValue::Array(items)) => !items.is_empty(),
        _ => false,
    }
}

/// `verifyEvidenceHashes(instance, trace)`. `expected_physics_mode` is the
/// input's physics selection, or the current default when it makes none.
pub fn verify_evidence_hashes(
    instance: &JsValue,
    trace: &TraceView<'_>,
    expected_physics_mode: &str,
) -> EvidenceHashReport {
    let null = JsValue::Null;
    let input = instance.get("input").unwrap_or(&null);
    let manifest = instance.get("manifest");
    let header = trace.header;
    let recomputed_input_hash = content_hash(input);
    let manifest_input_hash = or_null(manifest.and_then(|m| m.get("inputHash")));
    let trace_input_hash = or_null(header.get("inputHash"));
    let input_actor_ids = js_sort(
        input
            .get("actors")
            .and_then(JsValue::as_array)
            .unwrap_or(&[])
            .iter()
            .map(|a| {
                a.get("id")
                    .and_then(JsValue::as_str)
                    .unwrap_or("undefined")
                    .to_owned()
            })
            .collect(),
    );
    let replay_key = manifest.and_then(|m| m.get("replayKey"));
    let manifest_actor_ids = match manifest.and_then(|m| m.get("actors")) {
        Some(JsValue::Array(actors)) => js_sort(
            actors
                .iter()
                .filter_map(|a| a.get("id").and_then(JsValue::as_str).map(str::to_owned))
                .collect(),
        ),
        _ => Vec::new(),
    };
    let actor_ids = sorted_strings(header.get("actorIds"));
    let mut trace_track_actor_ids = trace.track_ids.clone();
    trace_track_actor_ids.sort_by(|a, b| cmp_utf16(a, b));
    let input_map_id = or_null(input.get("mapId"));
    let manifest_map_id = string_or_null(replay_key.and_then(|k| k.get("mapId")));
    let trace_map_id = string_or_null(header.get("mapId"));
    let matcher_index_digest = string_or_null(replay_key.and_then(|k| k.get("matcherIndexDigest")));
    let manifest_engine_graph_digest =
        string_or_null(replay_key.and_then(|k| k.get("engineGraphDigest")));
    let trace_engine_graph_digest = string_or_null(header.get("engineGraphDigest"));
    let instance_catalog_slot = instance.get("catalogSlot");
    let trace_catalog_slot = header.get("catalogSlot");
    let operational_variant = manifest.and_then(|m| m.get("operationalVariant"));
    let manifest_concrete = operational_variant.and_then(|v| v.get("concrete"));
    let input_conditions = input.get("operationalConditions");
    let trace_conditions = header.get("operationalConditions");
    let physics_mode = or_null(header.at(&["physics", "mode"]));
    let physics_matched = is_string(&physics_mode, expected_physics_mode);
    let mut issues = Vec::new();

    if !physics_matched {
        issues.push(EvidenceHashIssue {
            code: "physics_mode_mismatch",
            reason: "trace physics mode must match the input selection/current default",
            expected: text(expected_physics_mode),
            actual: physics_mode.clone(),
        });
    }
    if !is_string(&manifest_input_hash, &recomputed_input_hash) {
        issues.push(EvidenceHashIssue {
            code: "instance_input_hash_mismatch",
            reason:
                "instance manifest inputHash does not match sha256(canonicalJson(instance.input))",
            expected: text(recomputed_input_hash.clone()),
            actual: manifest_input_hash.clone(),
        });
    }
    if !is_string(&trace_input_hash, &recomputed_input_hash) {
        issues.push(EvidenceHashIssue {
            code: "trace_input_hash_mismatch",
            reason: "trace header inputHash does not match sha256(canonicalJson(instance.input))",
            expected: text(recomputed_input_hash.clone()),
            actual: trace_input_hash.clone(),
        });
    }
    let map_matches = |id: &Option<String>| !js_ne(Some(&opt(id)), input.get("mapId"));
    if !map_matches(&manifest_map_id) {
        issues.push(EvidenceHashIssue {
            code: "instance_map_id_mismatch",
            reason: "instance manifest replayKey.mapId must exactly match instance input.mapId",
            expected: input.get("mapId").cloned(),
            actual: opt(&manifest_map_id),
        });
    }
    if !map_matches(&trace_map_id) {
        issues.push(EvidenceHashIssue {
            code: "trace_map_id_mismatch",
            reason: "trace header mapId must exactly match instance input.mapId",
            expected: input.get("mapId").cloned(),
            actual: opt(&trace_map_id),
        });
    }
    if manifest_actor_ids != input_actor_ids {
        issues.push(EvidenceHashIssue {
            code: "instance_actor_ids_mismatch",
            reason:
                "instance manifest actor ids must exactly match sorted instance input actor ids",
            expected: text(input_actor_ids.join(",")),
            actual: JsValue::String(manifest_actor_ids.join(",")),
        });
    }
    if actor_ids != input_actor_ids {
        issues.push(EvidenceHashIssue {
            code: "trace_actor_ids_mismatch",
            reason: "trace header actorIds must exactly match sorted instance input actor ids",
            expected: text(input_actor_ids.join(",")),
            actual: JsValue::String(actor_ids.join(",")),
        });
    }
    if trace_track_actor_ids != input_actor_ids {
        issues.push(EvidenceHashIssue {
            code: "trace_actor_tracks_mismatch",
            reason: "trace tick actor tracks must exactly match sorted instance input actor ids",
            expected: text(input_actor_ids.join(",")),
            actual: JsValue::String(trace_track_actor_ids.join(",")),
        });
    }
    // Matcher/map-intel and engine topology are separate provenance domains:
    // only the engine digest joins a trace; the matcher digest must be present
    // on its own rather than substituted.
    if matcher_index_digest.is_none() {
        issues.push(EvidenceHashIssue {
            code: "matcher_index_digest_missing",
            reason: "instance replay key must declare matcherIndexDigest separately from engine topology",
            expected: text("non-empty matcher/map-intel digest"),
            actual: JsValue::Null,
        });
    }
    if manifest_engine_graph_digest.is_none() {
        issues.push(EvidenceHashIssue {
            code: "engine_graph_digest_missing",
            reason: "instance replay key must declare the engineGraphDigest used for simulation",
            expected: text("non-empty engine graph digest"),
            actual: JsValue::Null,
        });
    }
    if trace_engine_graph_digest != manifest_engine_graph_digest {
        issues.push(EvidenceHashIssue {
            code: "trace_engine_graph_digest_mismatch",
            reason: "trace engineGraphDigest must match the instance replay key engineGraphDigest",
            expected: text(manifest_engine_graph_digest.clone().unwrap_or_default()),
            actual: opt(&trace_engine_graph_digest),
        });
    }
    if stringify(trace_catalog_slot) != stringify(instance_catalog_slot) {
        issues.push(EvidenceHashIssue {
            code: "catalog_provenance_mismatch",
            reason: "trace header catalogSlot must exactly match the instance catalogSlot closure",
            expected: text(stringify_or_null(instance_catalog_slot)),
            actual: JsValue::String(stringify_or_null(trace_catalog_slot)),
        });
    }
    if let Some(slot) = instance_catalog_slot {
        let key = |name: &str| opt(&string_or_null(replay_key.and_then(|k| k.get(name))));
        let input_map = input.get("mapId");
        let invalid = js_ne(slot.get("mapId"), input_map)
            || js_ne(slot.get("selectedMatcherSiteId"), Some(&key("siteId")))
            || js_ne(slot.get("attemptSeed"), Some(&key("paramSeed")))
            || js_ne(slot.get("templateId"), Some(&key("templateId")))
            || js_ne(
                slot.at(&["provenance", "matcherIndexDigest"]),
                Some(&opt(&matcher_index_digest)),
            )
            || js_ne(
                slot.at(&["provenance", "engineGraphDigest"]),
                Some(&opt(&manifest_engine_graph_digest)),
            )
            || !nonempty(slot.get("selectedLocationId"))
            || !nonempty(slot.at(&["variant", "id"]))
            || !nonempty(slot.get("identity"))
            || !hex64(slot.get("seed"))
            || !hex64(slot.get("attemptSeed"))
            || !hex64(slot.get("designDigest"));
        if invalid {
            let expected = object(vec![
                ("mapId", input_map.cloned()),
                ("siteId", Some(key("siteId"))),
                ("paramSeed", Some(key("paramSeed"))),
                ("templateId", Some(key("templateId"))),
                ("matcherIndexDigest", Some(opt(&matcher_index_digest))),
                (
                    "engineGraphDigest",
                    Some(opt(&manifest_engine_graph_digest)),
                ),
            ]);
            issues.push(EvidenceHashIssue {
                code: "catalog_provenance_invalid",
                reason: "catalog closure must agree with the concrete replay key, map, selected matcher site, template, and deterministic seeds",
                expected: text(to_compact_js(&expected).unwrap_or_default()),
                actual: JsValue::String(stringify_or_null(Some(slot))),
            });
        }
        let manifest_variant = match operational_variant {
            Some(JsValue::Object(entries)) => JsValue::Object(
                entries
                    .iter()
                    .filter(|(k, _)| k != "concrete")
                    .cloned()
                    .collect(),
            ),
            _ => JsValue::Object(Vec::new()),
        };
        let close = same_canonical(Some(&manifest_variant), slot.get("variant"))
            && same_canonical(manifest_concrete, input_conditions)
            && same_canonical(trace_conditions, input_conditions);
        if !close {
            let expected = object(vec![
                ("variant", slot.get("variant").cloned()),
                ("concrete", input_conditions.cloned()),
            ]);
            let actual = object(vec![
                ("manifest", Some(or_null(operational_variant))),
                ("trace", Some(or_null(trace_conditions))),
            ]);
            issues.push(EvidenceHashIssue {
                code: "operational_conditions_mismatch",
                reason: "catalog variant source fields and applied concrete conditions must close exactly through manifest, input, and trace",
                expected: text(to_compact_js(&expected).unwrap_or_default()),
                actual: JsValue::String(to_compact_js(&actual).unwrap_or_default()),
            });
        }
    } else if !same_canonical(trace_conditions, input_conditions) {
        issues.push(EvidenceHashIssue {
            code: "operational_conditions_mismatch",
            reason:
                "trace operational conditions must exactly match the hash-covered input conditions",
            // `JSON.stringify(undefined)` is undefined: the field is then absent.
            expected: stringify(input_conditions).map(JsValue::String),
            actual: JsValue::String(stringify_or_null(trace_conditions)),
        });
    }

    EvidenceHashReport {
        ok: issues.is_empty(),
        recomputed_input_hash,
        manifest_input_hash,
        trace_input_hash,
        input_actor_ids,
        trace_actor_ids: actor_ids.clone(),
        trace_track_actor_ids,
        actor_count: actor_ids.len(),
        actor_ids,
        input_map_id,
        manifest_map_id,
        trace_map_id,
        matcher_index_digest,
        manifest_engine_graph_digest,
        trace_engine_graph_digest,
        physics_mode: Some(physics_mode),
        physics_provenance: Some(if physics_matched {
            "matched"
        } else {
            "mismatch"
        }),
        issues,
    }
}

fn opt(value: &Option<String>) -> JsValue {
    value.clone().map_or(JsValue::Null, JsValue::String)
}

/// An object literal; a `None` value is an undefined property, which
/// `JSON.stringify` leaves out.
fn object(entries: Vec<(&str, Option<JsValue>)>) -> JsValue {
    JsValue::Object(
        entries
            .into_iter()
            .filter_map(|(k, v)| v.map(|v| (k.to_owned(), v)))
            .collect(),
    )
}
