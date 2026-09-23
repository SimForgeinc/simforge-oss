//! Archive corpus: artifacts from past releases must keep playing.
//!
//! `fixtures/archive-corpus/corpus.json` lists real stored traces (bytes
//! verbatim) from every release era with expectations computed from the
//! stored bytes alone (`scripts/archive-corpus/archive-corpus.ts`). Every
//! trace must:
//!
//! 1. still be the same stored bytes;
//! 2. read through the current reader (upgraded in memory when older), as
//!    the expected shape, listing exactly the sections its source never
//!    recorded;
//! 3. keep its identity (the recorded `traceSha256` where one exists, else
//!    the stored-document digest for upgraded traces);
//! 4. replay the same motion: the upgraded trace, the render timeline built
//!    from it (CPU, no GPU) and the shared sampler at every tick all equal
//!    the stored track on the trace grid;
//! 5. when a stored timeline is archived with it, that timeline carries the
//!    same motion as the timeline re-derived under the current sampler.
//!
//! Adding to this corpus is a release step (see the corpus README).

use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use simforge_core::hash::content_hash;
use simforge_core::math::quantize;
use simforge_core::trace::timeline::{
    build_render_timeline, maybe_gunzip, sampler, HeightField, RenderTimeline, SAMPLER_VERSION,
};
use simforge_core::trace::{SimTrace, TRACE_FORMAT_VERSION};

const MOTION_SCHEMA: &str = "simforge.archive-motion/v1";

fn corpus_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/archive-corpus")
}

fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn num(v: f64) -> Value {
    json!(v + 0.0)
}

/// The motion document of `scripts/archive-corpus/motion.ts`, from a trace.
fn trace_motion(trace: &SimTrace) -> Value {
    let mut actors = Map::new();
    for (id, track) in &trace.ticks.actors {
        let present = |i: usize| track.present[i] == 1;
        let at = |values: &[f64], d: i32| -> Vec<Value> {
            values
                .iter()
                .enumerate()
                .map(|(i, v)| {
                    if present(i) {
                        num(quantize(*v, d))
                    } else {
                        Value::Null
                    }
                })
                .collect()
        };
        actors.insert(
            id.clone(),
            json!({
                "present": track.present.iter().map(|p| u8::from(*p == 1)).collect::<Vec<_>>(),
                "x": at(&track.x, 4),
                "y": at(&track.y, 4),
                "headingRad": at(&track.heading_rad, 6),
            }),
        );
    }
    json!({
        "schema": MOTION_SCHEMA,
        "t": trace.ticks.t.iter().map(|t| num(quantize(*t, 6))).collect::<Vec<_>>(),
        "actors": actors,
    })
}

/// The same motion document, from a render timeline.
fn timeline_motion(timeline: &RenderTimeline) -> Value {
    let mut actors = Map::new();
    for actor in &timeline.actors {
        let tr = &actor.track;
        let at = |values: &[f64]| -> Vec<Value> {
            values
                .iter()
                .enumerate()
                .map(|(i, v)| {
                    if tr.present[i] == 1 {
                        num(*v)
                    } else {
                        Value::Null
                    }
                })
                .collect()
        };
        actors.insert(
            actor.id.clone(),
            json!({
                "present": tr.present.iter().map(|p| u8::from(*p == 1)).collect::<Vec<_>>(),
                "x": at(&tr.x),
                "y": at(&tr.y),
                "headingRad": at(&tr.heading_rad),
            }),
        );
    }
    json!({
        "schema": MOTION_SCHEMA,
        "t": timeline.t.iter().map(|t| num(*t)).collect::<Vec<_>>(),
        "actors": actors,
    })
}

fn motion_sha(motion: &Value) -> String {
    content_hash(motion).unwrap()
}

fn str_of<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or_else(|| panic!("{key} missing"))
}

#[test]
fn every_archived_trace_still_plays() {
    let dir = corpus_dir();
    let corpus: Value =
        serde_json::from_slice(&std::fs::read(dir.join("corpus.json")).unwrap()).unwrap();
    assert_eq!(corpus["schema"], "simforge.archive-corpus/v1");
    let entries = corpus["entries"].as_array().unwrap();
    let traces: Vec<&Value> = entries.iter().filter(|e| e["kind"] == "trace").collect();
    assert!(!traces.is_empty(), "archive corpus has no traces");
    let mut failures: Vec<String> = Vec::new();
    for entry in traces {
        let id = str_of(entry, "id");
        if let Err(problem) = check_trace(&dir, entry) {
            failures.push(format!("{id}: {problem}"));
        }
    }
    assert!(
        failures.is_empty(),
        "archived traces no longer play:\n{}",
        failures.join("\n")
    );
}

fn check_trace(dir: &Path, entry: &Value) -> Result<(), String> {
    let expect = &entry["expect"];
    let bytes = std::fs::read(dir.join(str_of(entry, "path"))).map_err(|e| e.to_string())?;
    if sha256(&bytes) != str_of(entry, "storedSha256") {
        return Err("stored bytes changed (the corpus is append-only)".into());
    }
    let mut plain = maybe_gunzip(&bytes).map_err(|e| e.to_string())?.into_owned();
    if entry["container"] == "browser-preview" {
        // A legacy editor preview envelope: the trace is its `trace` member.
        let envelope: Value = serde_json::from_slice(&plain).map_err(|e| e.to_string())?;
        plain = serde_json::to_vec(&envelope["trace"]).map_err(|e| e.to_string())?;
    }
    let mut trace = SimTrace::from_json_slice(&plain).map_err(|e| format!("read: {e}"))?;

    // Shape and unrecorded sections.
    let shape = str_of(expect, "shape");
    let version = expect["traceVersion"].as_u64().unwrap() as u32;
    let unrecorded: Vec<String> = expect["unrecorded"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_owned())
        .collect();
    match &trace.upgrade {
        Some(upgrade) => {
            if upgrade.source_shape != shape || upgrade.source_trace_version != version {
                return Err(format!(
                    "read as {} v{}, expected {shape} v{version}",
                    upgrade.source_shape, upgrade.source_trace_version
                ));
            }
            if upgrade.unrecorded != unrecorded {
                return Err(format!(
                    "unrecorded {:?}, expected {unrecorded:?}",
                    upgrade.unrecorded
                ));
            }
        }
        None => {
            if !(shape == "v4" && version == TRACE_FORMAT_VERSION) || !unrecorded.is_empty() {
                return Err(format!("{shape} v{version} was read without an upgrade"));
            }
        }
    }
    if trace.header.trace_version != TRACE_FORMAT_VERSION {
        return Err("upgraded trace is not in the current format".into());
    }
    for (key, got) in [
        ("engineVersion", trace.header.engine_version.as_str()),
        ("mapId", trace.header.map_id.as_str()),
        (
            "engineGraphDigest",
            trace.header.engine_graph_digest.as_str(),
        ),
    ] {
        if got != str_of(expect, key) {
            return Err(format!(
                "header.{key} {got}, expected {}",
                str_of(expect, key)
            ));
        }
    }
    if trace.ticks.actors.len() as u64 != expect["actors"].as_u64().unwrap()
        || trace.ticks.t.len() as u64 != expect["ticks"].as_u64().unwrap()
    {
        return Err("actor or tick count changed".into());
    }
    // An evaluator must refuse what was never recorded.
    for section in &unrecorded {
        if trace.require_recorded(section).is_ok() {
            return Err(format!(
                "{section} is unrecorded but require_recorded accepted it"
            ));
        }
    }

    // Identity.
    if let Some(recorded) = expect["recordedTraceSha256"].as_str() {
        trace
            .bind_recorded_identity(recorded)
            .map_err(|e| format!("recorded identity: {e}"))?;
    }
    let digest = trace.digest().map_err(|e| e.to_string())?;
    if let Some(identity) = expect["identity"].as_str() {
        if digest != identity {
            return Err(format!("identity {digest}, expected {identity}"));
        }
    }

    // Motion: the upgraded trace, the timeline built from it, the sampler.
    let expected_motion = str_of(expect, "motionSha256");
    let got = motion_sha(&trace_motion(&trace));
    if got != expected_motion {
        return Err(format!(
            "upgraded trace motion {got}, expected {expected_motion}"
        ));
    }
    if expect["timeline"] == "refused-unsupported-dt" {
        // The render timeline runs at the one fixed step; a trace at another
        // dt is refused loudly, never resampled.
        return match build_render_timeline(&trace, &HeightField::flat(0.0), None) {
            Err(simforge_core::trace::timeline::TimelineError::UnsupportedDt { .. }) => Ok(()),
            Err(e) => Err(format!("timeline refused for the wrong reason: {e}")),
            Ok(_) => Err("timeline built from a trace off the fixed step".into()),
        };
    }
    if expect["timeline"] != "builds" {
        return Err(format!("unknown timeline expectation {}", expect["timeline"]));
    }
    let height = match entry.get("height").filter(|v| v.is_object()) {
        Some(h) => {
            let repo = dir.join("../..");
            let read = |key: &str| -> Result<Vec<u8>, String> {
                let bytes = std::fs::read(repo.join(str_of(h, key))).map_err(|e| format!("height {key}: {e}"))?;
                Ok(maybe_gunzip(&bytes).map_err(|e| e.to_string())?.into_owned())
            };
            HeightField::from_xodr(&read("xodr")?, &read("topology")?).map_err(|e| format!("height: {e}"))?
        }
        None => HeightField::flat(0.0),
    };
    let timeline = build_render_timeline(&trace, &height, None).map_err(|e| format!("timeline: {e}"))?;
    if timeline.trace.trace_sha256 != digest {
        return Err("timeline does not name the trace's identity".into());
    }
    let upgraded_from = trace.upgrade.as_ref().map(|u| u.source_trace_version);
    if timeline.trace.upgraded_from_trace_version != upgraded_from {
        return Err("timeline does not record the trace upgrade".into());
    }
    let got = motion_sha(&timeline_motion(&timeline));
    if got != expected_motion {
        return Err(format!("timeline motion {got}, expected {expected_motion}"));
    }
    let bytes = timeline.to_canonical_json().map_err(|e| e.to_string())?;
    let reread = RenderTimeline::from_json_slice(bytes.as_bytes())
        .map_err(|e| format!("timeline re-read: {e}"))?;
    for (id, track) in &trace.ticks.actors {
        for (i, t) in timeline.t.iter().enumerate() {
            let pose =
                sampler::pose(&reread, id, *t).map_err(|e| format!("sample {id}@{i}: {e}"))?;
            if pose.present != (track.present[i] == 1) {
                return Err(format!("sampler presence of {id} at tick {i}"));
            }
            if !pose.present {
                continue;
            }
            let dx = (pose.x - quantize(track.x[i], 4)).abs();
            let dy = (pose.y - quantize(track.y[i], 4)).abs();
            let dh = (pose.heading_rad - quantize(track.heading_rad[i], 6)).abs();
            if dx > 1e-9 || dy > 1e-9 || dh > 1e-9 {
                return Err(format!(
                    "sampler pose of {id} at tick {i} is off the trace by ({dx:e}, {dy:e}, {dh:e})"
                ));
            }
        }
    }

    // A stored timeline archived with the trace: same motion as re-derived.
    if let Some(stored) = entry.get("timeline").filter(|v| v.is_object()) {
        let tl_bytes =
            std::fs::read(dir.join(str_of(stored, "path"))).map_err(|e| e.to_string())?;
        if sha256(&tl_bytes) != str_of(stored, "storedSha256") {
            return Err("stored timeline bytes changed".into());
        }
        let archived = RenderTimeline::inspect_json_slice(&tl_bytes)
            .map_err(|e| format!("stored timeline: {e}"))?;
        if archived.trace.trace_sha256 != digest {
            return Err(format!(
                "stored timeline names trace {}, the trace's identity is {digest}",
                archived.trace.trace_sha256
            ));
        }
        let got = motion_sha(&timeline_motion(&archived));
        if got != str_of(stored, "motionSha256") || got != expected_motion {
            return Err(format!(
                "stored timeline motion {got} differs from the trace's"
            ));
        }
        if archived.identity.sampler_version == SAMPLER_VERSION {
            RenderTimeline::from_json_slice(&tl_bytes)
                .map_err(|e| format!("stored timeline under its own sampler: {e}"))?;
            // Same sampler and the real height source: the re-derived
            // timeline is the stored one, byte for byte.
            if entry.get("height").is_some_and(|v| v.is_object()) {
                let rebuilt = timeline.sha256().map_err(|e| e.to_string())?;
                let stored = archived.sha256().map_err(|e| e.to_string())?;
                if rebuilt != stored || rebuilt != sha256(&tl_bytes) {
                    return Err(format!("re-derived timeline {rebuilt} differs from the stored {stored}"));
                }
            }
        }
    }
    Ok(())
}

fn fixture_doc(id: &str) -> Value {
    let dir = corpus_dir();
    let corpus: Value =
        serde_json::from_slice(&std::fs::read(dir.join("corpus.json")).unwrap()).unwrap();
    let entry = corpus["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["id"] == id)
        .unwrap_or_else(|| panic!("fixture {id}"));
    let bytes = std::fs::read(dir.join(str_of(entry, "path"))).unwrap();
    serde_json::from_slice(&maybe_gunzip(&bytes).unwrap()).unwrap()
}

#[test]
fn unknown_and_future_trace_versions_fail_closed() {
    let mut doc = fixture_doc("rc43-v4pre-worker-intrusion");
    for version in [0, 2, TRACE_FORMAT_VERSION + 1] {
        doc["header"]["traceVersion"] = json!(version);
        let err = SimTrace::from_json_slice(&serde_json::to_vec(&doc).unwrap()).unwrap_err();
        assert!(
            err.to_string().contains("traceVersion"),
            "v{version}: unexpected error {err}"
        );
    }
    doc["header"]["traceVersion"] = json!("4");
    assert!(SimTrace::from_json_slice(&serde_json::to_vec(&doc).unwrap()).is_err());
}

#[test]
fn unrecorded_sections_are_refused_not_backfilled() {
    let doc = fixture_doc("rc12-v1-belmont-queue-tail");
    let trace = SimTrace::from_json_slice(&serde_json::to_vec(&doc).unwrap()).unwrap();
    let err = trace
        .require_recorded("semanticLedger")
        .unwrap_err()
        .to_string();
    assert!(
        err.contains("semanticLedger") && err.contains("traceVersion 1"),
        "{err}"
    );
    assert!(trace
        .require_recorded("ticks.actors.*.lateralOffsetM")
        .is_err());
    // Recorded motion is never on the list.
    for section in [
        "ticks.actors.*.x",
        "ticks.actors.*.headingRad",
        "ticks.t",
        "ticks.signals",
    ] {
        trace.require_recorded(section).unwrap();
    }
    // The upgrade record survives a re-serialisation, so a re-read copy is
    // still refused and keeps its identity.
    let reread = SimTrace::from_json_slice(&serde_json::to_vec(&trace).unwrap()).unwrap();
    assert_eq!(reread.upgrade, trace.upgrade);
    assert_eq!(reread.digest().unwrap(), trace.digest().unwrap());
    assert!(reread.require_recorded("semanticLedger").is_err());
}

#[test]
fn recorded_identity_binds_upgraded_traces_and_checks_current_ones() {
    let mut upgraded = SimTrace::from_json_slice(
        &serde_json::to_vec(&fixture_doc("rc12-v3-cyclist-occlusion")).unwrap(),
    )
    .unwrap();
    let recorded = "ab".repeat(32);
    upgraded.bind_recorded_identity(&recorded).unwrap();
    assert_eq!(upgraded.digest().unwrap(), recorded);
    let tl = build_render_timeline(&upgraded, &HeightField::flat(0.0), None).unwrap();
    assert_eq!(tl.trace.trace_sha256, recorded);
    assert_eq!(tl.trace.upgraded_from_trace_version, Some(3));

    // A current-format (v5) document: v5 differs from v4 only by the optional
    // ground-contact channels, so a v4 document restamped as v5 is current.
    let mut current_doc = fixture_doc("rc65-v4-geometry-proxy");
    current_doc["header"]["traceVersion"] = serde_json::json!(5);
    let mut current =
        SimTrace::from_json_slice(&serde_json::to_vec(&current_doc).unwrap()).unwrap();
    assert!(current.upgrade.is_none());
    let own = current.digest().unwrap();
    current.bind_recorded_identity(&own).unwrap();
    let err = current
        .bind_recorded_identity(&recorded)
        .unwrap_err()
        .to_string();
    assert!(err.contains("recorded identity"), "{err}");
}

#[test]
fn a_changed_track_changes_the_motion_digest() {
    // The motion check has teeth: one moved sample is detected.
    let doc = fixture_doc("rc43-v4pre-worker-intrusion");
    let before = motion_sha(&trace_motion(
        &SimTrace::from_json_slice(&serde_json::to_vec(&doc).unwrap()).unwrap(),
    ));
    let mut moved = doc.clone();
    let actors = moved["ticks"]["actors"].as_object_mut().unwrap();
    let (_, track) = actors.iter_mut().next().unwrap();
    let present = track["present"]
        .as_array()
        .unwrap()
        .iter()
        .position(|p| p == 1)
        .unwrap();
    let x = track["x"][present].as_f64().unwrap();
    track["x"][present] = json!(x + 0.001);
    let after = motion_sha(&trace_motion(
        &SimTrace::from_json_slice(&serde_json::to_vec(&moved).unwrap()).unwrap(),
    ));
    assert_ne!(before, after);
}
