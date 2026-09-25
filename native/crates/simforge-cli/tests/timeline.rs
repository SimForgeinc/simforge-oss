//! `simforge timeline build` over the archive corpus (oss/fixtures/archive-corpus):
//! every archived trace either builds a timeline that names its identity, or
//! is refused for the documented reason, through the CLI contract.
//!
//! Map-backed builds need the public map's OpenDRIVE and topology (about
//! 2.4 MB, not in git). `richmond_*` tests are `#[ignore]`d and run with
//! `SIMFORGE_CLI_TEST_RICHMOND=<dir holding map.xodr + topology-index.json.gz>`:
//! `cargo test -p simforge --test timeline -- --ignored`.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::{json, Value};
use simforge_core::trace::timeline::RenderTimeline;

fn corpus() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/archive-corpus")
}

fn simforge(home: &Path) -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_simforge"));
    cmd.env_remove("SIMFORGE_MAPS_CACHE_ROOT")
        .env_remove("XDG_DATA_HOME")
        .env("HOME", home);
    cmd
}

fn run(cmd: &mut Command) -> (i32, Value, Value) {
    let out = cmd.output().expect("run simforge");
    let parse = |bytes: &[u8]| -> Value {
        let text = String::from_utf8_lossy(bytes);
        let line = text.lines().last().unwrap_or("");
        if line.is_empty() {
            Value::Null
        } else {
            serde_json::from_str(line).unwrap_or_else(|e| panic!("not JSON ({e}): {text}"))
        }
    };
    (
        out.status.code().unwrap(),
        parse(&out.stdout),
        parse(&out.stderr),
    )
}

/// A corpus trace as a plain trace file (unwrapping the legacy editor
/// preview envelope some entries are stored in).
fn trace_file(entry: &Value, dir: &Path) -> PathBuf {
    let path = corpus().join(entry["path"].as_str().unwrap());
    if entry["container"] != "browser-preview" {
        return path;
    }
    let bytes = std::fs::read(&path).unwrap();
    let plain = simforge_core::trace::timeline::maybe_gunzip(&bytes).unwrap();
    let envelope: Value = serde_json::from_slice(&plain).unwrap();
    let out = dir.join(format!("{}.trace.json", entry["id"].as_str().unwrap()));
    std::fs::write(&out, serde_json::to_vec(&envelope["trace"]).unwrap()).unwrap();
    out
}

fn trace_entries() -> Vec<Value> {
    let index: Value =
        serde_json::from_slice(&std::fs::read(corpus().join("corpus.json")).unwrap()).unwrap();
    index["entries"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["kind"] == "trace")
        .cloned()
        .collect()
}

#[test]
fn every_archived_trace_builds_or_is_refused_for_its_documented_reason() {
    let home = tempfile::tempdir().unwrap();
    let entries = trace_entries();
    assert!(entries.len() >= 10, "the corpus shrank?");
    for entry in &entries {
        let id = entry["id"].as_str().unwrap();
        let expect = &entry["expect"];
        let trace = trace_file(entry, home.path());
        let out = home.path().join(format!("{id}.timeline.json"));
        let mut cmd = simforge(home.path());
        cmd.args(["timeline", "build", "--height", "flat", "--trace"])
            .arg(&trace)
            .arg("--out")
            .arg(&out);
        if let Some(recorded) = expect["recordedTraceSha256"].as_str() {
            cmd.args(["--recorded-trace-sha256", recorded]);
        }
        let (code, doc, err) = run(&mut cmd);
        match expect["timeline"].as_str().unwrap() {
            "builds" => {
                assert_eq!(code, 0, "{id}: {err}");
                if let Some(identity) = expect["identity"].as_str() {
                    assert_eq!(doc["traceSha256"], identity, "{id}");
                }
                assert_eq!(doc["mapId"], expect["mapId"], "{id}");
                assert_eq!(doc["ticks"], expect["ticks"], "{id}");
                assert_eq!(doc["heightSource"]["kind"], "flat/v1");
                let bytes = std::fs::read(&out).unwrap();
                assert_eq!(bytes.len() as u64, doc["byteLength"].as_u64().unwrap());
                let timeline = RenderTimeline::from_json_slice(&bytes).unwrap();
                assert_eq!(
                    timeline.sha256().unwrap(),
                    doc["timelineSha256"].as_str().unwrap()
                );
                assert_eq!(
                    timeline.identity.timeline_key,
                    doc["timelineKey"].as_str().unwrap()
                );
            }
            "refused-unsupported-dt" => {
                assert_eq!(code, 2, "{id}: {doc}");
                assert_eq!(err["code"], "timeline_rejected", "{id}");
                assert!(
                    err["reason"].as_str().unwrap().contains("dt"),
                    "{id}: {err}"
                );
                assert!(
                    !out.exists(),
                    "{id}: nothing is written for a refused trace"
                );
            }
            other => panic!("{id}: unknown expectation {other}"),
        }
    }
}

#[test]
fn builds_are_deterministic_and_gzip_output_is_the_same_document() {
    let home = tempfile::tempdir().unwrap();
    let trace = corpus().join("traces/rc73-engine090-richmond-small.trace.json.gz");
    let build = |out: &Path| {
        run(simforge(home.path())
            .args([
                "timeline", "build", "--height", "flat", "--flat-z", "12.5", "--trace",
            ])
            .arg(&trace)
            .arg("--out")
            .arg(out))
    };
    let (a, doc_a, _) = build(&home.path().join("a.json"));
    let (b, doc_b, _) = build(&home.path().join("b.json.gz"));
    assert_eq!((a, b), (0, 0));
    assert_eq!(doc_a["timelineSha256"], doc_b["timelineSha256"]);
    assert_eq!(doc_a["heightSource"]["flatZM"], 12.5);
    let plain = std::fs::read(home.path().join("a.json")).unwrap();
    let gz = std::fs::read(home.path().join("b.json.gz")).unwrap();
    assert_ne!(plain, gz);
    assert_eq!(
        RenderTimeline::from_json_slice(&gz).unwrap(),
        RenderTimeline::from_json_slice(&plain).unwrap()
    );
}

#[test]
fn a_map_backed_build_without_the_map_fails_loudly_and_never_goes_flat() {
    let home = tempfile::tempdir().unwrap();
    let trace = corpus().join("traces/rc73-engine090-richmond-small.trace.json.gz");
    for height in ["auto", "xodr", "ground"] {
        let (code, doc, err) = run(simforge(home.path())
            .args(["timeline", "build", "--height", height, "--trace"])
            .arg(&trace));
        assert_eq!(code, 1, "{height}: {doc}");
        assert_eq!(err["code"], "map_not_installed", "{height}: {err}");
        assert_eq!(
            err["detail"]["xodrSha256"],
            "5b08367524edbc0c46cfb2f4cd77ef6a204f263bb14cf7e8f90a1fffde1c14d6"
        );
    }
    // An explicit map directory with another OpenDRIVE is a mismatch, not a substitute.
    let other = home.path().join("other");
    std::fs::create_dir_all(&other).unwrap();
    std::fs::write(other.join("map.xodr"), "<OpenDRIVE/>").unwrap();
    let (code, _, err) = run(simforge(home.path())
        .args(["timeline", "build", "--trace"])
        .arg(&trace)
        .arg("--map-dir")
        .arg(&other));
    assert_eq!(code, 2);
    assert_eq!(err["code"], "map_mismatch");
    // --flat-z without --height flat is a flag error.
    let (code, _, err) = run(simforge(home.path())
        .args(["timeline", "build", "--flat-z", "1", "--trace"])
        .arg(&trace));
    assert_eq!(code, 1);
    assert_eq!(err["path"], "--flat-z");
}

/// A workspace with the given packaged timelines around a corpus trace.
fn workspace(dir: &Path, trace_sha: &str, timelines: Value) -> PathBuf {
    let ws = dir.join("ws");
    std::fs::create_dir_all(ws.join("simulation")).unwrap();
    std::fs::copy(
        corpus().join("traces/rc73-engine090-richmond-small.trace.json.gz"),
        ws.join("simulation/trace.json.gz"),
    )
    .unwrap();
    let manifest = json!({
        "schema": "simforge.scenario-package/v1",
        "simulation": { "traceSha256": trace_sha },
        "map": {
            "xodrSha256": "5b08367524edbc0c46cfb2f4cd77ef6a204f263bb14cf7e8f90a1fffde1c14d6",
            "heightSourceDigest": "682c159171f948b4bf5955ba8ec33fbcbc80777b3b47cb27cb1f47edb2d3e0c0",
            "sourceMapId": "richmond-field-station",
        },
        "timelines": timelines,
    });
    std::fs::write(
        ws.join("manifest.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    ws
}

const SMALL_TRACE_SHA: &str = "a49b1f18d221ebab7c35358487e09cd85f7abde4f409cb617a27812fa5fed88a";

#[test]
fn workspace_errors_are_structured() {
    let home = tempfile::tempdir().unwrap();
    let (code, _, err) = run(simforge(home.path())
        .args(["timeline", "build"])
        .arg(home.path()));
    assert_eq!(
        (code, err["code"].as_str()),
        (1, Some("workspace_not_found"))
    );

    std::fs::write(
        home.path().join("manifest.json"),
        r#"{"schema":"something/v9"}"#,
    )
    .unwrap();
    let (code, _, err) = run(simforge(home.path())
        .args(["timeline", "build"])
        .arg(home.path()));
    assert_eq!((code, err["code"].as_str()), (2, Some("workspace_invalid")));

    // A workspace without timelines is invalid.
    let ws = workspace(home.path(), SMALL_TRACE_SHA, json!([]));
    let (code, _, err) = run(simforge(home.path()).args(["timeline", "build"]).arg(&ws));
    assert_eq!(
        (code, err["code"].as_str()),
        (2, Some("workspace_invalid")),
        "{err}"
    );

    // An archived (upgraded) trace adopts the identity the manifest records;
    // `package import` has verified the stored bytes against it.
    std::fs::remove_dir_all(&ws).unwrap();
    let ws = workspace(
        home.path(),
        &"0".repeat(64),
        json!([{ "timelineSha256": "x", "timelineKey": "k", "samplerVersion": "s", "heightFieldDigest": "h" }]),
    );
    let (code, doc, err) = run(simforge(home.path())
        .args(["timeline", "build", "--height", "flat"])
        .arg(&ws));
    assert_eq!(code, 0, "{err}");
    assert_eq!(doc["traceSha256"], "0".repeat(64));
    assert_eq!(doc["packaged"][0]["sameKey"], false);
}

#[test]
fn a_workspace_timeline_that_does_not_reproduce_is_a_finding() {
    let home = tempfile::tempdir().unwrap();
    // First learn the key this build derives on a flat surface.
    let (code, probe, _) = run(simforge(home.path())
        .args(["timeline", "build", "--height", "flat", "--trace"])
        .arg(corpus().join("traces/rc73-engine090-richmond-small.trace.json.gz"))
        .args(["--recorded-trace-sha256", SMALL_TRACE_SHA]));
    assert_eq!(code, 0);
    let entry = |sha: &str| {
        json!([{
            "timelineSha256": sha,
            "timelineKey": probe["timelineKey"],
            "samplerVersion": probe["samplerVersion"],
            "heightFieldDigest": probe["heightFieldDigest"],
            "catalogDigest": null,
        }])
    };
    let good = workspace(
        home.path(),
        SMALL_TRACE_SHA,
        entry(probe["timelineSha256"].as_str().unwrap()),
    );
    let (code, doc, err) = run(simforge(home.path())
        .args(["timeline", "build", "--height", "flat"])
        .arg(&good));
    assert_eq!(code, 0, "{err}");
    assert_eq!(doc["packaged"][0]["reproduces"], true);
    let written = good.join(format!(
        "timeline/{}.json",
        probe["timelineSha256"].as_str().unwrap()
    ));
    assert!(written.is_file());

    std::fs::remove_dir_all(&good).unwrap();
    let bad = workspace(home.path(), SMALL_TRACE_SHA, entry(&"f".repeat(64)));
    let (code, doc, _) = run(simforge(home.path())
        .args(["timeline", "build", "--height", "flat"])
        .arg(&bad));
    assert_eq!(code, 2);
    assert_eq!(doc["reproduces"], false);
    assert_eq!(doc["packaged"][0]["reproduces"], false);
    assert!(
        !bad.join("timeline").exists(),
        "a timeline that does not reproduce is not written"
    );
}

fn richmond() -> PathBuf {
    let dir = std::env::var_os("SIMFORGE_CLI_TEST_RICHMOND")
        .expect("set SIMFORGE_CLI_TEST_RICHMOND to a dir with richmond-field-station's map.xodr + topology-index.json.gz");
    PathBuf::from(dir)
}

#[test]
#[ignore = "needs the public richmond-field-station OpenDRIVE (SIMFORGE_CLI_TEST_RICHMOND)"]
fn richmond_archived_timelines_keep_their_height_source_and_motion() {
    let home = tempfile::tempdir().unwrap();
    let map = richmond();
    for entry in trace_entries()
        .iter()
        .filter(|e| e["expect"]["mapId"] == "richmond-field-station")
    {
        let id = entry["id"].as_str().unwrap();
        let expect = &entry["expect"];
        let mut cmd = simforge(home.path());
        cmd.args(["timeline", "build", "--height", "xodr", "--trace"])
            .arg(corpus().join(entry["path"].as_str().unwrap()))
            .arg("--map-dir")
            .arg(&map);
        if let Some(recorded) = expect["recordedTraceSha256"].as_str() {
            cmd.args(["--recorded-trace-sha256", recorded]);
        }
        let (code, doc, err) = run(&mut cmd);
        assert_eq!(code, 0, "{id}: {err}");
        if let Some(archived) = entry.get("timeline").filter(|t| t.is_object()) {
            // The archived (older sampler) timeline was baked on the same height source.
            assert_eq!(
                doc["heightFieldDigest"], archived["heightFieldDigest"],
                "{id}"
            );
        }
    }
    // Found by content in a maps cache, with no --map-dir.
    let cache = home.path().join("maps/dev-assets/richmond-field-station");
    std::fs::create_dir_all(&cache).unwrap();
    for f in ["map.xodr", "topology-index.json.gz"] {
        std::fs::copy(map.join(f), cache.join(f)).unwrap();
    }
    let (code, doc, err) = run(simforge(home.path())
        .args(["timeline", "build", "--trace"])
        .arg(corpus().join("traces/rc73-engine090-richmond-small.trace.json.gz"))
        .env("SIMFORGE_MAPS_CACHE_ROOT", home.path().join("maps")));
    assert_eq!(code, 0, "{err}");
    assert_eq!(doc["map"]["profile"], "dev-assets");
    assert_eq!(doc["heightSource"]["kind"], "xodr-elevation/v1");

    // A workspace pins the height source by digest; auto reproduces it.
    let ws = workspace(
        home.path(),
        SMALL_TRACE_SHA,
        json!([{
            "timelineSha256": "0".repeat(64), "timelineKey": "k", "samplerVersion": "simforge.timeline-sampler/1",
            "heightFieldDigest": "682c159171f948b4bf5955ba8ec33fbcbc80777b3b47cb27cb1f47edb2d3e0c0", "catalogDigest": null,
        }]),
    );
    let (code, doc, err) = run(simforge(home.path())
        .args(["timeline", "build"])
        .arg(&ws)
        .env("SIMFORGE_MAPS_CACHE_ROOT", home.path().join("maps")));
    assert_eq!(code, 0, "{err}");
    assert_eq!(doc["packaged"][0]["sameKey"], false);
    assert!(doc["heightSelection"]
        .as_str()
        .unwrap()
        .contains("heightSourceDigest"));
}
