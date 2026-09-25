//! The release smoke package: `fixtures/scenario-package/smoke/richmond-public.scenario.zip`.
//!
//! A thin package whose closures resolve from the PUBLIC registry: its
//! `map/closure.json` is the published Richmond Field Station browser asset
//! set (registry version 11, closure `f08173b8…`), every member of which is
//! served by digest from the public blob origin, and its actor closure is the
//! pinned public `793ec86c… (attributed: per-member licences)`. The motion is a real archived trace
//! (`rc72-engine070-richmond-commit`: one ambulance, 20 s) with a timeline
//! derived under the current sampler from the public OpenDRIVE and topology.
//! The document and resolution record are fixture placeholders: the smoke
//! covers import, timeline and render, not re-simulation.
//!
//! The render expectation is the golden-harness scene `package-smoke-richmond`
//! (its frames are recorded on lavapipe like every golden; until recorded the
//! scene is explicitly `unrecorded`, which fails loudly).
//!
//! Regenerate (needs the public members, fetched by digest; see fixtures/scenario-package/README.md):
//! `SIMFORGE_SMOKE_INPUTS=<dir> cargo test -p simforge-package --test smoke -- --ignored`

mod support;

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde_json::{json, Value};
use simforge_core::trace::timeline::{build_render_timeline, HeightField, SAMPLER_VERSION};
use simforge_core::trace::SimTrace;
use simforge_package::closure::ActorClosure;
use simforge_package::{verify_bytes, Form, PackageBuilder, ReceiptInput, VerifyOptions};
use support::*;

const TRACE_ID: &str = "rc72-engine070-richmond-commit";
const DOCUMENT_ID: &str = "rc73-doc-child-reveal";
const PUBLIC_BROWSER_CLOSURE: &str =
    "f08173b844b41b34e12e44fabafaaface1672174fb6be0352def8330b8bb5d03";
const PUBLIC_ACTOR_CLOSURE: &str =
    "793ec86ceda7734f1f5f7c0b260a396c11c970a471ab4418987e4d531f33daa4";
const PUBLIC_MAP_VERSION: &str = "usmap_caa8ecb111be3a4ab63513d773e7e62f";
const GOLDEN_SCENE: &str = "package-smoke-richmond";

fn smoke_dir() -> PathBuf {
    fixtures_root().join("scenario-package/smoke")
}

/// `closure.ts` `role()` + `required`, over the published plan's `[path, sha, bytes, mediaType?]` rows.
fn browser_closure(plan: &Value) -> Vec<u8> {
    let mut rows: Vec<&Value> = plan["assets"].as_array().unwrap().iter().collect();
    rows.sort_by(|a, b| a[0].as_str().cmp(&b[0].as_str()));
    let members: Vec<Value> = rows
        .iter()
        .map(|r| {
            let path = r[0].as_str().unwrap();
            let collider = path.split('/').any(|s| {
                s == "collider"
                    || s == "colliders"
                    || s == "static-collider"
                    || s.starts_with("collider.")
                    || s.starts_with("colliders.")
                    || s.starts_with("static-collider.")
            });
            json!({
                "relativePath": path,
                "sha256": r[1],
                "byteLength": r[2],
                "mediaType": r.get(3).cloned().unwrap_or(json!("application/octet-stream")),
                "role": map_role(path),
                "required": !collider,
            })
        })
        .collect();
    canonical_bytes(
        &json!({ "contractVersion": "uniscenario.browser-asset-set/v1", "members": members }),
    )
}

#[test]
#[ignore = "regenerates the committed smoke package from downloaded public inputs"]
fn generate_smoke_package() {
    let inputs =
        PathBuf::from(std::env::var("SIMFORGE_SMOKE_INPUTS").expect("SIMFORGE_SMOKE_INPUTS"));
    let input = |p: &str| std::fs::read(inputs.join(p)).unwrap_or_else(|e| panic!("{p}: {e}"));
    let plan: Value = serde_json::from_slice(&input("browser-plan.json")).unwrap();
    let descriptor: Value = serde_json::from_slice(&input("descriptor.json")).unwrap();
    let map_closure = browser_closure(&plan);
    assert_eq!(
        sha(&map_closure),
        PUBLIC_BROWSER_CLOSURE,
        "the published listing no longer reproduces"
    );
    let listed: BTreeMap<String, String> = plan["assets"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| {
            (
                r[0].as_str().unwrap().to_owned(),
                r[1].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    let member = |p: &str| {
        let bytes = input(&format!("map/{p}"));
        assert_eq!(sha(&bytes), listed[p], "{p} is not the published member");
        bytes
    };
    let xodr = member("map.xodr");
    let topology = member("topology-index.json.gz");
    let actors_closure = input("actor-closure.json");
    assert_eq!(sha(&actors_closure), PUBLIC_ACTOR_CLOSURE);
    let catalog_models = input("catalog-models.json");

    // The archived trace and a current-sampler timeline on the public height source.
    let corpus: Value = serde_json::from_slice(&read("archive-corpus/corpus.json")).unwrap();
    let entry = corpus["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["id"] == TRACE_ID)
        .unwrap()
        .clone();
    let trace_gz = read(&format!(
        "archive-corpus/{}",
        entry["path"].as_str().unwrap()
    ));
    let identity = entry["expect"]["identity"].as_str().unwrap().to_owned();
    let mut trace = SimTrace::from_json_slice(&gunzip(&trace_gz)).unwrap();
    trace.bind_recorded_identity(&identity).unwrap();
    let height = HeightField::from_xodr(&xodr, &gunzip(&topology)).unwrap();
    let tl = build_render_timeline(&trace, &height, None).unwrap();
    assert_eq!(tl.identity.sampler_version, SAMPLER_VERSION);
    let timeline = tl.to_canonical_json().unwrap().into_bytes();
    let catalog_ids: Vec<String> = {
        let mut ids: Vec<String> = tl
            .actors
            .iter()
            .map(|a| a.catalog_id.clone())
            .chain(tl.props.iter().map(|p| p.catalog_id.clone()))
            .collect();
        ids.sort();
        ids.dedup();
        ids
    };
    let closure = ActorClosure::parse(&actors_closure).unwrap();
    assert_eq!(
        sha(&catalog_models),
        closure.members["catalog-models.json"].sha256
    );
    let reach = closure.reachable(&catalog_models, &catalog_ids).unwrap();
    let distinct: BTreeMap<&str, u64> = reach
        .iter()
        .map(|p| (closure.members[p].sha256.as_str(), closure.members[p].bytes))
        .collect();
    assert!(
        reach.len() > 1,
        "catalogIds {catalog_ids:?} reach no public model"
    );

    let document = canonicalize(&read(&format!(
        "archive-corpus/documents/{DOCUMENT_ID}.json"
    )));
    let header = &trace.header;
    let stored_format = trace
        .upgrade
        .as_ref()
        .map_or(header.trace_version, |u| u.source_trace_version);
    let sim_key = sha(format!("smoke fixture sim key {identity}").as_bytes());
    let resolution = gzip(&canonical_bytes(&json!({
        "contract": "simforge.sim-resolution/v1",
        "simKey": sim_key,
        "resolvedInputDigest": header.input_hash,
        "trafficProvider": "native",
        "fixture": "placeholder: the smoke package is not a re-simulation target"
    })));
    let catalog_entries = canonical_bytes(&json!(catalog_ids
        .iter()
        .map(|id| json!({ "id": id }))
        .collect::<Vec<_>>()));
    let rows = plan["assets"].as_array().unwrap();
    let mut pin_files = BTreeMap::new();
    for r in rows {
        pin_files.insert(
            r[0].as_str().unwrap().to_owned(),
            r[1].as_str().unwrap().to_owned(),
        );
    }
    let pin = {
        let mut text = String::new();
        for (p, h) in &pin_files {
            if simforge_package::closure::is_simulation_member(p) {
                text.push_str(&format!("{p} {h}\n"));
            }
        }
        sha(text.as_bytes())
    };
    let draft = json!({
        "schema": "simforge.scenario-package/v1",
        "producer": { "app": "simforge-fixtures", "appVersion": "0.2.0", "minCli": "0.2.0" },
        "scenario": {
            "title": "Smoke: ambulance on Richmond Field Station (public release 11)",
            "documentSchema": "simforge.scenario.v2",
            "scenarioVersion": 2,
            "contentSha256": sha(&document),
            "simContentSha256": sha(format!("smoke fixture sim content {identity}").as_bytes())
        },
        "engine": {
            "engineSemVer": header.engine_version,
            "solverVersion": header.engine_version,
            "pipelineRevision": 2,
            "build": { "engineVersion": header.engine_version },
            "release": entry["release"].as_str().unwrap().trim_start_matches('v')
        },
        "simulation": {
            "simKey": sim_key,
            "traceFormat": stored_format,
            "traceSchema": format!("simforge.trace/v{stored_format}"),
            "traceSha256": identity,
            "traceGzipSha256": sha(&trace_gz),
            "authoredTraceSha256": identity,
            "resolvedInputDigest": header.input_hash,
            "resolutionSha256": sha(&resolution),
            "trafficProvider": "native",
            "trafficStepKey": null,
            "trafficSha256": null,
            "sumo": null,
            "groundDigest": null,
            "producerKind": "runner",
            "simulatedAt": format!("{}T00:00:00Z", entry["recorded"].as_str().unwrap())
        },
        "timelines": [{
            "version": tl.version,
            "samplerVersion": tl.identity.sampler_version,
            "timelineKey": tl.identity.timeline_key,
            "timelineSha256": sha(&timeline),
            "heightFieldDigest": tl.identity.height_field_digest,
            "catalogDigest": null
        }],
        "executionPackage": null,
        "map": {
            "mapVersionId": PUBLIC_MAP_VERSION,
            "sourceMapId": "richmond-field-station",
            "label": descriptor["label"],
            "xodrSha256": sha(&xodr),
            "coordinateSystemSha256": String::from_utf8(input("coordinate-system-sha256.txt")).unwrap().trim(),
            "mapClosureDigest": String::from_utf8(input("map-closure-digest.txt")).unwrap().trim(),
            "pinClosureSha256": pin,
            "browserClosureSha256": PUBLIC_BROWSER_CLOSURE,
            "heightSourceDigest": tl.identity.height_field_digest,
            "groundDigest": null,
            "closure": { "memberCount": rows.len(), "bytes": rows.iter().map(|r| r[2].as_u64().unwrap()).sum::<u64>() }
        },
        "catalog": {
            "assetCatalogVersionId": null,
            "catalogSha256": sha(&catalog_entries),
            "actorClosureDigest": PUBLIC_ACTOR_CLOSURE,
            "actorClosureSchema": "simforge.actor-assets-closure/v1",
            "catalogIds": catalog_ids,
            "referencedActorBlobs": { "count": distinct.len(), "bytes": distinct.values().sum::<u64>() }
        },
        "render": null,
        "provenance": { "installationKind": "cli", "installationId": "00000000-0000-4000-8000-000000000002", "authorDisplayName": null },
        "extensions": {}
    });
    let mut b = PackageBuilder::new(draft).unwrap();
    b.member("document.json", document).unwrap();
    b.member("simulation/trace.json.gz", trace_gz).unwrap();
    b.member("simulation/resolution.json.gz", resolution)
        .unwrap();
    b.member(
        &format!("timeline/{}.json", sha(&timeline)),
        timeline.clone(),
    )
    .unwrap();
    b.member("map/closure.json", map_closure).unwrap();
    b.member("actors/closure.json", actors_closure).unwrap();
    b.member("catalog/entries.json", catalog_entries).unwrap();
    b.receipt(ReceiptInput {
        exported_at: "2026-09-24T00:00:00Z".into(),
        exporter_release: "0.2.0-fixture".into(),
        texture_tier: None,
    });
    let (outcome, bytes) = b.to_bytes().unwrap();
    let dir = smoke_dir();
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("richmond-public.scenario.zip"), &bytes).unwrap();
    let meta = json!({
        "schema": "simforge.scenario-package-smoke/v1",
        "package": "richmond-public.scenario.zip",
        "packageId": outcome.package_id,
        "form": "thin",
        "readerCli": CLI,
        "map": {
            "mapVersionId": PUBLIC_MAP_VERSION,
            "registryVersion": descriptor["registryVersion"],
            "registryReleaseDigest": descriptor["registryReleaseDigest"],
            "browserClosureSha256": PUBLIC_BROWSER_CLOSURE,
            "nativeClosureSha256": descriptor["canonicalDigest"],
            "blobOrigin": "https://da3tufozhdsvl.cloudfront.net/blobs/sha256/<aa>/<sha256>"
        },
        "actors": {
            "closureDigest": PUBLIC_ACTOR_CLOSURE,
            "closureUrl": format!("https://da3tufozhdsvl.cloudfront.net/actor-assets/closures/{PUBLIC_ACTOR_CLOSURE}.json"),
            "catalogIds": catalog_ids_of(&outcome.manifest),
        },
        "timeline": {
            "timelineSha256": tl.sha256().unwrap(),
            "timelineKey": tl.identity.timeline_key,
            "samplerVersion": tl.identity.sampler_version,
            "actorIds": tl.actors.iter().map(|a| a.id.clone()).collect::<Vec<_>>(),
        },
        "render": {
            "goldenScene": GOLDEN_SCENE,
            "note": "Frame hashes live in the golden store (qualification/golden-harness/goldens/<fingerprint>/package-smoke-richmond.json), keyed by renderer sha. Until recorded the scene declares recording: unrecorded and golden.mjs verify fails with exit 10."
        },
        "trace": { "archiveCorpusId": TRACE_ID, "traceSha256": identity },
        "placeholders": ["document.json (archive-corpus rc73-doc-child-reveal, not this trace's scenario)", "simulation/resolution.json.gz", "scenario.simContentSha256", "simulation.simKey"],
    });
    let mut text = serde_json::to_string_pretty(&meta).unwrap();
    text.push('\n');
    std::fs::write(dir.join("smoke.json"), text).unwrap();
}

fn catalog_ids_of(m: &simforge_package::Manifest) -> Vec<String> {
    m.catalog.catalog_ids.clone()
}

#[test]
fn the_smoke_package_verifies_and_names_public_closures() {
    let dir = smoke_dir();
    let meta: Value =
        serde_json::from_slice(&std::fs::read(dir.join("smoke.json")).unwrap()).unwrap();
    let bytes = std::fs::read(dir.join(meta["package"].as_str().unwrap())).unwrap();
    let v = verify_bytes(&bytes, &VerifyOptions::new(Some(CLI)).unwrap()).unwrap();
    assert_eq!(v.package_id(), meta["packageId"].as_str().unwrap());
    assert_eq!(v.form(), Form::Thin);
    let m = v.manifest();
    assert_eq!(m.map.browser_closure_sha256, PUBLIC_BROWSER_CLOSURE);
    assert_eq!(m.map.map_version_id, PUBLIC_MAP_VERSION);
    assert_eq!(m.catalog.actor_closure_digest, PUBLIC_ACTOR_CLOSURE);
    // The timeline is under the reader's current sampler: renderable as is.
    assert!(
        v.content.timelines.iter().all(|t| t.current_sampler),
        "{:?}",
        v.content.timelines
    );
    assert_eq!(
        v.content.timelines[0].timeline_key,
        meta["timeline"]["timelineKey"].as_str().unwrap()
    );
    // The golden scene renders exactly this timeline.
    let scene_path = fixtures_root()
        .parent()
        .unwrap()
        .join("qualification/golden-harness/scenes")
        .join(format!("{GOLDEN_SCENE}.json"));
    let scene: Value = serde_json::from_slice(&std::fs::read(&scene_path).unwrap()).unwrap();
    assert_eq!(scene["package"]["packageId"], meta["packageId"]);
    assert_eq!(
        scene["package"]["timelineSha256"],
        meta["timeline"]["timelineSha256"]
    );
}
