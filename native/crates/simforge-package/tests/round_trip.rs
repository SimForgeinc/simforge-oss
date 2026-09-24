//! Round trips on real artifacts: every archive-corpus trace that was
//! archived with its render timeline (all on Richmond Field Station), and
//! every archived document, packaged thin and full on the committed Richmond
//! closure, written, read back and verified. Plus the API paths the CLI and
//! the hosted exporter use (files, extraction, file-backed blobs) and the
//! rules that need a full package to exercise.

mod support;

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde_json::{json, Value};
use simforge_package::zip::Limits;
use simforge_package::{
    verify_bytes, verify_file, Form, PackageBuilder, PackageReader, VerifyOptions,
};
use support::*;

fn options() -> VerifyOptions {
    VerifyOptions::new(Some(CLI)).unwrap()
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "simforge-package-{name}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn corpus_entries(kind: &str) -> Vec<Value> {
    let corpus: Value = serde_json::from_slice(&read("archive-corpus/corpus.json")).unwrap();
    corpus["entries"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["kind"] == kind)
        .cloned()
        .collect()
}

#[test]
fn archive_corpus_traces_round_trip_thin_and_full() {
    let richmond = richmond_files();
    let with_timeline: Vec<Value> = corpus_entries("trace")
        .into_iter()
        .filter(|e| e.get("timeline").is_some())
        .collect();
    assert!(
        with_timeline.len() >= 3,
        "the corpus lost its archived timelines"
    );
    let document = corpus_entries("document")[0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    for entry in with_timeline {
        let id = entry["id"].as_str().unwrap();
        let case = Case::from_corpus(id, &document, richmond.clone());
        let (thin, thin_bytes) = case.builder(false).to_bytes().unwrap();
        let (full, full_bytes) = case.builder(true).to_bytes().unwrap();
        // Determinism: the same inputs give the same container bytes.
        assert_eq!(
            case.builder(false).to_bytes().unwrap().1,
            thin_bytes,
            "{id}"
        );
        assert_eq!(case.builder(true).to_bytes().unwrap().1, full_bytes, "{id}");
        // One revision, one id.
        assert_eq!(thin.package_id, full.package_id, "{id}");
        let v_thin =
            verify_bytes(&thin_bytes, &options()).unwrap_or_else(|e| panic!("{id} thin: {e}"));
        let v_full =
            verify_bytes(&full_bytes, &options()).unwrap_or_else(|e| panic!("{id} full: {e}"));
        assert_eq!(v_thin.form(), Form::Thin);
        assert_eq!(v_full.form(), Form::Full);
        assert_eq!(v_thin.package_id(), thin.package_id);
        // Replay identity: the archived trace bytes and identity survive.
        assert_eq!(
            v_full.content.trace.trace_sha256,
            entry["expect"]["identity"].as_str().unwrap()
        );
        assert_eq!(
            v_full.content.timelines[0].timeline_key,
            entry["timeline"]["timelineKey"].as_str().unwrap()
        );
        let mut reader =
            PackageReader::open(std::io::Cursor::new(&full_bytes), &options()).unwrap();
        assert_eq!(
            reader.read_member("simulation/trace.json.gz").unwrap(),
            case.trace_gz,
            "{id}"
        );
        let timeline_path = format!("timeline/{}.json", sha(&case.timeline));
        assert_eq!(
            reader.read_member(&timeline_path).unwrap(),
            case.timeline,
            "{id}"
        );
        // Every Richmond file comes back byte for byte from the full form.
        for (path, bytes) in &richmond {
            let mut out = Vec::new();
            reader.copy_blob(&sha(bytes), &mut out).unwrap();
            assert_eq!(&out, bytes, "{id}: {path}");
        }
        assert_eq!(
            v_full.content.embedded_blobs.count as usize,
            full.embedded_blobs.count as usize
        );
    }
}

#[test]
fn archive_corpus_documents_round_trip() {
    let case = Case::fixture();
    for entry in corpus_entries("document") {
        let doc_id = entry["id"].as_str().unwrap();
        let mut c = Case::from_corpus(
            "rc73-engine090-richmond-small",
            doc_id,
            case.map_files.clone(),
        );
        c.title = format!("document {doc_id}");
        let (outcome, bytes) = c.builder(false).to_bytes().unwrap();
        let v = verify_bytes(&bytes, &options()).unwrap_or_else(|e| panic!("{doc_id}: {e}"));
        assert_eq!(v.package_id(), outcome.package_id);
        // The package's document digest is the archive's canonical document digest.
        assert_eq!(
            v.manifest().scenario.content_sha256,
            entry["expect"]["documentSha256"].as_str().unwrap(),
            "{doc_id}"
        );
    }
}

#[test]
fn file_paths_extraction_and_file_blobs() {
    let dir = scratch("files");
    let case = Case::fixture();
    // Full package whose blobs come from files, written to disk.
    let blob_dir = dir.join("blob-sources");
    std::fs::create_dir_all(&blob_dir).unwrap();
    let mut b = case.builder(false);
    for (path, bytes) in &case.map_files {
        if map_role(path) != "texture" {
            let file = blob_dir.join(sha(bytes));
            std::fs::write(&file, bytes).unwrap();
            b.blob_file(&sha(bytes), &file).unwrap();
        }
    }
    for p in [
        "catalog-models.json",
        "models/hazard.cardboard_box/model.glb",
    ] {
        let bytes = &case.actor_blobs[p];
        let file = blob_dir.join(sha(bytes));
        std::fs::write(&file, bytes).unwrap();
        b.blob_file(&sha(bytes), &file).unwrap();
    }
    b.receipt(simforge_package::ReceiptInput {
        exported_at: "2026-09-24T00:00:00Z".into(),
        exporter_release: "0.2.0-fixture".into(),
        texture_tier: Some("256-uastc".into()),
    });
    let out = dir.join("pkg.scenario.zip");
    let outcome = b.write_file(&out).unwrap();
    assert_eq!(outcome.form, Form::Full);
    // Same bytes as the in-memory full fixture: blob source does not matter.
    assert_eq!(
        std::fs::read(&out).unwrap(),
        case.builder(true).to_bytes().unwrap().1
    );
    let v = verify_file(&out, &options()).unwrap();
    assert_eq!(v.package_id(), outcome.package_id);
    // Extraction writes exactly the members and blobs, re-proven.
    let into = dir.join("extracted");
    let mut reader = PackageReader::open_file(&out, &options()).unwrap();
    reader.extract_to(&into).unwrap();
    assert_eq!(
        std::fs::read(into.join("manifest.json")).unwrap(),
        outcome.manifest_bytes
    );
    let xodr = &case.map_files["map.xodr"];
    let h = sha(xodr);
    assert_eq!(
        &std::fs::read(into.join(format!("blobs/sha256/{}/{h}", &h[..2]))).unwrap(),
        xodr
    );
    assert_eq!(
        std::fs::read(into.join("document.json")).unwrap(),
        case.document
    );
    // A non-empty target is refused.
    let mut again = PackageReader::open_file(&out, &options()).unwrap();
    assert_eq!(again.extract_to(&into).unwrap_err().rule, "extract_dir");
    // A blob file that does not hash to its declared digest fails the write.
    let liar = blob_dir.join("liar");
    std::fs::write(&liar, b"not the bytes").unwrap();
    let mut b = case.builder(false);
    b.blob_file(&sha(&case.map_files["map.xodr"]), &liar)
        .unwrap();
    let err = b.write_file(&dir.join("never.scenario.zip")).unwrap_err();
    assert!(!dir.join("never.scenario.zip").exists());
    assert!(matches!(err.rule, "blob_size" | "blob_digest"), "{err}");
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn the_writer_refuses_what_the_reader_would() {
    let case = Case::fixture();
    // Members[] is computed, never supplied.
    let mut draft = case.build().draft;
    draft["members"] = json!([]);
    assert_eq!(
        PackageBuilder::new(draft).unwrap_err().rule,
        "draft_members"
    );
    // A document whose scenarioVersion disagrees with the manifest.
    let mut c = case.clone();
    let mut doc: Value = serde_json::from_slice(&c.document).unwrap();
    doc["scenarioVersion"] = json!(1);
    c.document = canonical_bytes(&doc);
    assert_eq!(
        c.builder(false).to_bytes().unwrap_err().rule,
        "document_version"
    );
    // An unknown member path.
    let mut b = case.builder(false);
    assert_eq!(
        b.member("simulation/extra.json", b"{}".to_vec())
            .unwrap_err()
            .rule,
        "member_path"
    );
    // A thin package over the configured limit.
    let mut b = case.builder(false);
    b.limits(Limits {
        max_thin_bytes: 1024,
        ..Limits::default()
    });
    assert_eq!(b.to_bytes().unwrap_err().code.as_str(), "package_too_large");
}

#[test]
fn full_form_rules() {
    let case = Case::fixture();
    // referencedActorBlobs must be what catalogIds reach.
    let built = case.build();
    let mut draft = built.draft.clone();
    draft["catalog"]["referencedActorBlobs"]["count"] = json!(3);
    let mut b = PackageBuilder::new(draft.clone()).unwrap();
    for (p, bytes) in &built.members {
        b.member(p, bytes.clone()).unwrap();
    }
    // Thin: not verifiable, and said so.
    let (thin, _) = b.to_bytes().unwrap();
    assert!(thin.content.not_verifiable[0].starts_with("catalog.referencedActorBlobs"));
    // Full: refused.
    for (path, bytes) in &case.map_files {
        if map_role(path) != "texture" {
            b.blob(bytes.clone());
        }
    }
    b.blob(case.actor_blobs["catalog-models.json"].clone());
    b.blob(case.actor_blobs["models/hazard.cardboard_box/model.glb"].clone());
    assert_eq!(b.to_bytes().unwrap_err().rule, "referenced_actor_blobs");

    // A reachable actor blob left out: incomplete.
    let mut b = case.builder(false);
    for (path, bytes) in &case.map_files {
        if map_role(path) != "texture" {
            b.blob(bytes.clone());
        }
    }
    b.blob(case.actor_blobs["catalog-models.json"].clone());
    let err = b.to_bytes().unwrap_err();
    assert_eq!(
        (err.code.as_str(), err.rule),
        ("package_form_incomplete", "blob_missing")
    );
    assert_eq!(
        err.path.as_deref(),
        Some("actors/models/hazard.cardboard_box/model.glb")
    );

    // Blobs nothing reaches but a closure lists (the unbound sedan, the texture) are allowed.
    let mut b = case.builder(true);
    b.blob(case.actor_blobs["models/vehicle.sedan/model.glb"].clone());
    let tex = case
        .map_files
        .iter()
        .find(|(p, _)| map_role(p) == "texture")
        .unwrap()
        .1
        .clone();
    b.blob(tex);
    let (outcome, bytes) = b.to_bytes().unwrap();
    assert_eq!(outcome.content.embedded_texture_members, 1);
    verify_bytes(&bytes, &options()).unwrap();

    // The same blob supplied twice is one entry.
    let mut b = case.builder(true);
    let before = b.to_bytes().unwrap().1;
    b.blob(case.map_files["map.xodr"].clone());
    assert_eq!(b.to_bytes().unwrap().1, before);
}

#[test]
fn reader_limits() {
    let (_, thin) = Case::fixture().builder(false).to_bytes().unwrap();
    let limited = |limits: Limits| {
        let opts = VerifyOptions {
            limits,
            ..options()
        };
        verify_bytes(&thin, &opts).unwrap_err()
    };
    let e = limited(Limits {
        max_thin_bytes: 1000,
        ..Limits::default()
    });
    assert_eq!(
        (e.code.as_str(), e.rule),
        ("package_too_large", "container_size")
    );
    let e = limited(Limits {
        max_full_bytes: 1000,
        ..Limits::default()
    });
    assert_eq!(
        (e.code.as_str(), e.rule),
        ("package_too_large", "container_size")
    );
    let e = limited(Limits {
        max_entries: 3,
        ..Limits::default()
    });
    assert_eq!(
        (e.code.as_str(), e.rule),
        ("package_limit_exceeded", "entry_count")
    );
    let e = limited(Limits {
        max_manifest_bytes: 100,
        ..Limits::default()
    });
    assert_eq!(
        (e.code.as_str(), e.rule),
        ("package_limit_exceeded", "member_size")
    );
    let e = limited(Limits {
        max_member_bytes: 1000,
        ..Limits::default()
    });
    assert_eq!(
        (e.code.as_str(), e.rule),
        ("package_limit_exceeded", "member_size")
    );
}

#[test]
fn inspection_and_names() {
    let case = Case::fixture();
    let (outcome, bytes) = case.builder(false).to_bytes().unwrap();
    let i = simforge_package::inspect_bytes(&bytes, &options()).unwrap();
    assert_eq!(i.package_id, outcome.package_id);
    assert_eq!(i.display_id, format!("pkg_{}", &outcome.package_id[..12]));
    assert_eq!(i.cli_check, "passed");
    assert_eq!(
        simforge_package::file_name(&case.title, &outcome.package_id),
        format!(
            "fixture-cardboard-box-on-the-richmond-field-station-loop.{}.scenario.zip",
            &outcome.package_id[..12]
        )
    );
    // The JSON report the CLI prints carries the manifest and the content report.
    let v = verify_bytes(&bytes, &options()).unwrap();
    let report: BTreeMap<String, Value> =
        serde_json::from_value(serde_json::to_value(&v).unwrap()).unwrap();
    for key in [
        "packageId",
        "displayId",
        "form",
        "manifest",
        "content",
        "cliCheck",
    ] {
        assert!(report.contains_key(key), "{key}");
    }
}
