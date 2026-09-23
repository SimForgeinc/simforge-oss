//! Trace upgrader chain: every trace format SimForge ever released stays
//! readable.
//!
//! Stored trace bytes are immutable and never rewritten. A reader that meets
//! an older document upgrades it **in memory**, one step at a time, to the
//! current in-memory model ([`super::SimTrace`]) and records what it did in
//! [`TraceUpgrade`]:
//!
//! - `sourceTraceVersion` / `sourceShape`: what was stored;
//! - identity ([`super::SimTrace::digest`]): an upgraded trace can't recompute
//!   the digest its writer recorded (the writer hashed its own struct, on its
//!   own quantization grid). Where the identity was recorded next to the
//!   stored bytes (a `sim_results.trace_sha256`, verified against the stored
//!   object's own sha256 by the caller), the caller binds it with
//!   [`super::SimTrace::bind_recorded_identity`] and it stays the identity, so
//!   the result, its timelines and its render jobs keep pointing at the same
//!   trace across format bumps. Otherwise the identity is `sourceDigest` =
//!   `sha256(canonicalJson(stored document))`, stable for as long as the
//!   stored bytes exist;
//! - `steps`: the ordered upgrade steps applied;
//! - `unrecorded`: sections the source never recorded. The upgrade does not
//!   invent them: consumers that need one ([`TraceUpgrade::require_recorded`])
//!   fail loudly. Motion channels (`x`, `y`, `headingRad`, `speedMps`,
//!   `present`, signal phases) are copied exactly and are never on this list.
//!
//! Adding a format version: bump [`super::TRACE_FORMAT_VERSION`], add exactly
//! one `vN_to_vN+1` step to [`upgrade_to_current`], and extend the archive
//! fixtures test (`tests/archive_traces.rs`) so every committed historical
//! trace still reads, keeps its identity and replays the same motion.
//!
//! Released shapes (all read by this module):
//!
//! | shape            | `traceVersion` | recorded by            | differs from current                                   |
//! |------------------|----------------|------------------------|--------------------------------------------------------|
//! | `v1`             | 1              | TS engine, ≤ Aug 20    | no `header.physics`, `lateralOffsetM`, `metrics.criticalitySamples`, ledger or `ego` |
//! | `v3`             | 3              | TS engine, Aug 9–30    | no `lateralOffsetM` on some actors, no ledger, no `ego` |
//! | `v4-pre-ledger`  | 4              | TS/native, Aug 20–Sep 5| no `header.ego`, no `semanticLedger`                   |
//! | `v4`             | 4              | native, ≤ engine 0.10  | no ground contact (`header.groundDigest`, `contact`)   |
//! | `v5`             | 5              | native, engine 0.11+   | none (current)                                         |

use serde::de::IgnoredAny;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::{TraceError, TRACE_FORMAT_VERSION};

/// Schema tag of [`TraceUpgrade`].
pub const TRACE_UPGRADE_SCHEMA: &str = "simforge.trace-upgrade/v1";

/// Oldest `traceVersion` this reader upgrades. There was never a released v2.
pub const OLDEST_READABLE_TRACE_VERSION: u32 = 1;

/// What an in-memory upgrade did to a stored trace. Absent on traces that
/// were read in the current format.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceUpgrade {
    pub schema: String,
    pub source_trace_version: u32,
    pub source_shape: String,
    /// `sha256(canonicalJson(stored document))`: the identity of a trace that
    /// was never registered with a recorded digest.
    pub source_digest: String,
    /// The digest recorded when the stored trace was registered (e.g.
    /// `sim_results.trace_sha256`), bound by the caller that verified the
    /// stored bytes. Takes precedence over `sourceDigest`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recorded_digest: Option<String>,
    pub source_engine_version: String,
    pub steps: Vec<String>,
    /// JSON paths (actor ids as `*`) the source never recorded. Their
    /// in-memory values are placeholders that no consumer may read.
    pub unrecorded: Vec<String>,
}

impl TraceUpgrade {
    /// The identity [`super::SimTrace::digest`] reports for this trace.
    pub fn identity(&self) -> &str {
        self.recorded_digest
            .as_deref()
            .unwrap_or(&self.source_digest)
    }

    /// Fail when `section` (or anything under it) was not recorded by the
    /// source trace. Consumers call this before reading an upgraded section
    /// whose placeholder would otherwise pass for data.
    pub fn require_recorded(&self, section: &str) -> Result<(), TraceError> {
        match self
            .unrecorded
            .iter()
            .find(|path| path.starts_with(section) || section.starts_with(path.as_str()))
        {
            Some(path) => Err(TraceError::Unrecorded {
                section: path.clone(),
                source_version: self.source_trace_version,
                source_shape: self.source_shape.clone(),
            }),
            None => Ok(()),
        }
    }
}

/// Cheap first pass: the version and the two sections whose absence marks a
/// pre-ledger v4 document, without building a DOM.
#[derive(Deserialize)]
struct Peek {
    header: Option<PeekHeader>,
    #[serde(rename = "semanticLedger")]
    semantic_ledger: Option<IgnoredAny>,
}

#[derive(Deserialize)]
struct PeekHeader {
    #[serde(rename = "traceVersion")]
    trace_version: Option<Value>,
    ego: Option<IgnoredAny>,
}

/// How a stored document must be read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StoredShape {
    /// Current format: deserialize directly, no upgrade.
    Current,
    /// Older format: [`upgrade_to_current`] first.
    Legacy { version: u32 },
}

/// Classify stored trace bytes. Unknown and future versions fail closed.
pub fn stored_shape(bytes: &[u8]) -> Result<StoredShape, TraceError> {
    let peek: Peek = serde_json::from_slice(bytes)?;
    let header = peek
        .header
        .ok_or_else(|| TraceError::Json("missing field `header`".to_owned()))?;
    let version = version_of(header.trace_version.as_ref())?;
    if version == TRACE_FORMAT_VERSION && header.ego.is_some() && peek.semantic_ledger.is_some() {
        Ok(StoredShape::Current)
    } else {
        Ok(StoredShape::Legacy { version })
    }
}

fn version_of(value: Option<&Value>) -> Result<u32, TraceError> {
    let found = value
        .and_then(Value::as_u64)
        .and_then(|v| u32::try_from(v).ok())
        .ok_or_else(|| {
            TraceError::Json("header.traceVersion is missing or not an integer".to_owned())
        })?;
    if found > TRACE_FORMAT_VERSION || found < OLDEST_READABLE_TRACE_VERSION || found == 2 {
        return Err(TraceError::UnsupportedVersion {
            found,
            expected: TRACE_FORMAT_VERSION,
        });
    }
    Ok(found)
}

/// Upgrade one stored document, in memory, to the current format. Returns
/// the upgraded document and the record of what was done. The input is the
/// stored document exactly as parsed; its canonical digest becomes the
/// trace's identity.
pub fn upgrade_to_current(mut doc: Value) -> Result<(Value, TraceUpgrade), TraceError> {
    let source_digest =
        crate::hash::content_hash(&doc).map_err(|e| TraceError::Json(e.to_string()))?;
    let header = doc
        .get("header")
        .and_then(Value::as_object)
        .ok_or_else(|| TraceError::Json("missing field `header`".to_owned()))?;
    let version = version_of(header.get("traceVersion"))?;
    let source_engine_version = header
        .get("engineVersion")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let mut report = Report::default();
    let shape = match version {
        1 => "v1",
        3 => "v3",
        _ if header.contains_key("ego") && doc.get("semanticLedger").is_some() => "v4",
        _ => "v4-pre-ledger",
    };
    if version == 1 {
        v1_to_v3(&mut doc, &mut report)?;
    }
    if version <= 3 {
        v3_to_v4(&mut doc, &mut report)?;
    }
    if version <= 4 {
        v4_pre_ledger_to_v4(&mut doc, &mut report)?;
    }
    if version <= 4 {
        v4_to_v5(&mut doc, &mut report)?;
    }
    set_version(&mut doc, TRACE_FORMAT_VERSION)?;
    report.unrecorded.sort();
    report.unrecorded.dedup();
    Ok((
        doc,
        TraceUpgrade {
            schema: TRACE_UPGRADE_SCHEMA.to_owned(),
            source_trace_version: version,
            source_shape: shape.to_owned(),
            source_digest,
            recorded_digest: None,
            source_engine_version,
            steps: report.steps,
            unrecorded: report.unrecorded,
        },
    ))
}

#[derive(Default)]
struct Report {
    steps: Vec<String>,
    unrecorded: Vec<String>,
}

impl Report {
    fn step(&mut self, name: &str) {
        self.steps.push(name.to_owned());
    }
    fn unrecorded(&mut self, path: &str) {
        self.unrecorded.push(path.to_owned());
    }
}

/* ------------------------------------------------------------ helpers */

fn obj<'a>(v: &'a mut Value, path: &str) -> Result<&'a mut Map<String, Value>, TraceError> {
    v.as_object_mut()
        .ok_or_else(|| TraceError::Json(format!("{path} must be an object")))
}

fn child<'a>(
    v: &'a mut Value,
    key: &str,
    path: &str,
) -> Result<&'a mut Map<String, Value>, TraceError> {
    obj(v, path)?
        .get_mut(key)
        .ok_or_else(|| TraceError::Json(format!("missing field `{key}` in {path}")))
        .and_then(|c| obj(c, &format!("{path}.{key}")))
}

fn set_version(doc: &mut Value, version: u32) -> Result<(), TraceError> {
    child(doc, "header", "trace")?.insert("traceVersion".to_owned(), Value::from(version));
    Ok(())
}

fn tick_count(doc: &mut Value) -> Result<usize, TraceError> {
    child(doc, "ticks", "trace")?
        .get("t")
        .and_then(Value::as_array)
        .map(Vec::len)
        .ok_or_else(|| TraceError::Json("ticks.t must be an array".to_owned()))
}

/// Insert a placeholder for a section the source never recorded, and record it.
fn placeholder(
    map: &mut Map<String, Value>,
    key: &str,
    value: Value,
    path: &str,
    report: &mut Report,
) {
    if !map.contains_key(key) {
        map.insert(key.to_owned(), value);
        report.unrecorded(path);
    }
}

/* -------------------------------------------------------------- steps */

/// v1 → v3: v3 introduced the physics provenance block. Every v1 trace was
/// recorded by the choreography backend, which trace v4 still names
/// `kinematic-v1`; the per-actor backend rows are derived from the actor
/// metadata exactly as that backend assigned them.
fn v1_to_v3(doc: &mut Value, report: &mut Report) -> Result<(), TraceError> {
    report.step("v1_to_v3");
    let header = child(doc, "header", "trace")?;
    if !header.contains_key("physics") {
        let dt = header.get("dt").cloned().unwrap_or(Value::Null);
        let mut backends = Map::new();
        if let Some(meta) = header.get("actorMetadata").and_then(Value::as_object) {
            for (id, m) in meta {
                let is_static = m.get("static").and_then(Value::as_bool).unwrap_or(false);
                let kind = m.get("kind").cloned().unwrap_or(Value::Null);
                backends.insert(
                    id.clone(),
                    serde_json::json!({
                        "mode": "kinematic-v1",
                        "reason": if is_static { "static-actor" } else { "selected" },
                        "profile": if is_static { Value::from("fixed-static") } else { kind },
                    }),
                );
            }
        }
        let engine_version = header.get("engineVersion").cloned().unwrap_or(Value::Null);
        header.insert(
            "physics".to_owned(),
            serde_json::json!({
                "mode": "kinematic-v1",
                "solver": "uniscenarios-sim-engine",
                "solverVersion": engine_version,
                "substepS": dt,
                "vehicleProfileDigest": null,
                "resolvedProfileDigest": "",
                "actorBackends": backends,
                "crashes": {},
            }),
        );
        report.unrecorded("header.physics.resolvedProfileDigest");
        report.unrecorded("header.physics.crashes");
    }
    // v3 added the per-tick criticality series behind the episode minima.
    let metrics = child(doc, "metrics", "trace")?;
    placeholder(
        metrics,
        "criticalitySamples",
        serde_json::json!({ "ttc": [], "pathTTC": [], "pet": [] }),
        "metrics.criticalitySamples",
        report,
    );
    Ok(())
}

/// v3 → v4: v4 made the lane-relative lateral-offset channel mandatory.
/// Tracks recorded without it keep it unrecorded (the world pose is exact
/// either way; only lane-relative maneuver evaluation needs it).
fn v3_to_v4(doc: &mut Value, report: &mut Report) -> Result<(), TraceError> {
    report.step("v3_to_v4");
    let n = tick_count(doc)?;
    let actors = child(doc, "ticks", "trace")?
        .get_mut("actors")
        .ok_or_else(|| TraceError::Json("missing field `actors` in ticks".to_owned()))?;
    for (id, track) in obj(actors, "ticks.actors")?.iter_mut() {
        let track = obj(track, &format!("ticks.actors.{id}"))?;
        placeholder(
            track,
            "lateralOffsetM",
            Value::Array(vec![Value::from(0.0); n]),
            "ticks.actors.*.lateralOffsetM",
            report,
        );
    }
    Ok(())
}

/// v4 (pre-ledger) → v4: the ego provenance block and the semantic ledger
/// were added without a version bump. Neither is recoverable from the
/// recorded channels, so both stay unrecorded.
/// v4 -> v5. v5 only adds the optional ground-contact channels
/// (`header.groundDigest`, `ticks.actors.*.contact`). A v4 trace has none and
/// none are invented: it upgrades with them absent, and a consumer that needs
/// contact derives it from the map ground surface explicitly (render timeline
/// `contactOrigin: derived-at-timeline-build`).
fn v4_to_v5(_doc: &mut Value, report: &mut Report) -> Result<(), TraceError> {
    report.step("v4_to_v5");
    Ok(())
}

fn v4_pre_ledger_to_v4(doc: &mut Value, report: &mut Report) -> Result<(), TraceError> {
    let header = child(doc, "header", "trace")?;
    let missing_ego = !header.contains_key("ego");
    let missing_ledger = obj(doc, "trace")?.get("semanticLedger").is_none();
    if !missing_ego && !missing_ledger {
        return Ok(());
    }
    report.step("v4_pre_ledger_to_v4");
    if missing_ego {
        let header = child(doc, "header", "trace")?;
        placeholder(
            header,
            "ego",
            serde_json::json!({ "controllerProfile": "sensor-limited" }),
            "header.ego",
            report,
        );
    }
    if missing_ledger {
        let ledger = unrecorded_ledger(child(doc, "header", "trace")?);
        let root = obj(doc, "trace")?;
        placeholder(root, "semanticLedger", ledger, "semanticLedger", report);
    }
    Ok(())
}

/// A ledger that says so: `source.complete = false`, producer
/// `trace-upgrade`, and no recorded rows. Listed as unrecorded, so the
/// intent evaluator refuses it rather than grading an empty ledger.
fn unrecorded_ledger(header: &Map<String, Value>) -> Value {
    let get = |k: &str| header.get(k).cloned().unwrap_or(Value::Null);
    serde_json::json!({
        "schema": super::ledger::SEMANTIC_LEDGER_SCHEMA,
        "version": super::ledger::SEMANTIC_LEDGER_VERSION,
        "source": {
            "inputHash": get("inputHash"),
            "producer": "trace-upgrade",
            "producerVersion": get("engineVersion"),
            "mapId": get("mapId"),
            "frame": "xodr-local",
            "dt": get("dt"),
            "clipSeconds": get("clipSeconds"),
            "motionAuthority": "simforge-physics",
            "complete": false,
        },
        "actors": {},
        "triggers": [],
        "actions": [],
        "events": [],
        "signals": {},
        "collisions": [],
        "discreteState": [],
        "environment": { "operationalConditions": null, "surfacePatches": [], "perception": null },
        "sensors": { "declarations": {}, "channels": null, "mapDivergence": null },
        "invariants": [],
    })
}
