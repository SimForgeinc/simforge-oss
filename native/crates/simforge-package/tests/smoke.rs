//! The release smoke package: `fixtures/scenario-package/smoke/richmond-public.scenario.zip`.
//!
//! A thin package whose closures resolve from the PUBLIC stores: its
//! `map/closure.json` and `map/web-closure.json` are the public registry's
//! Richmond Field Station release (`richmond-field-station@v5`) canonical and
//! web closures, byte for byte as the registry serves them (every member is
//! served by digest from the public blob origin), and its actor closure is the
//! pinned public, attributed `793ec86c…`. The scenario is the SDK's own
//! edge case 06 (wrong-way vehicle, blind approach), instantiated with the `simforge`
//! CLI on that release (site and draw in `smoke.json`) and simulated there
//! (trace format 5, on the release's ground surface); the resolution record
//! carries the engine-resolved input, so the package re-simulates to its own trace.
//! The timeline is derived from the trace on the release's ground under the
//! current sampler, keyed by the actor closure.
//!
//! The render expectation is the golden-harness scene `package-smoke-richmond`
//! (its frames are recorded on lavapipe like every golden; until recorded the
//! scene is explicitly `unrecorded`, which fails loudly).
//!
//! Regenerate (needs the public documents and members, fetched by digest; see
//! fixtures/scenario-package/README.md):
//! `SIMFORGE_SMOKE_INPUTS=<dir> cargo test -p simforge-package --test smoke -- --ignored`

mod support;

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{json, Value};
use simforge_core::engine::GroundContext;
use simforge_core::map::TopologyIndex;
use simforge_core::trace::timeline::{build_render_timeline, HeightField, SAMPLER_VERSION};
use simforge_core::trace::SimTrace;
use simforge_package::closure::{pin_closure_sha256, ActorClosure, MapClosure, GROUND_MEMBER};
use simforge_package::{verify_bytes, Form, PackageBuilder, ReceiptInput, VerifyOptions};
use support::*;

const TEMPLATE: &str =
    "examples/edge-cases/06-wrong-way-vehicle-blind-approach/scenario.template.json";
const REGISTRY: &str = "https://da3tufozhdsvl.cloudfront.net";
const RELEASE: &str = "richmond-field-station@v5";
const PUBLIC_ACTOR_CLOSURE: &str =
    "793ec86ceda7734f1f5f7c0b260a396c11c970a471ab4418987e4d531f33daa4";
const GOLDEN_SCENE: &str = "package-smoke-richmond";

fn smoke_dir() -> PathBuf {
    fixtures_root().join("scenario-package/smoke")
}

fn repo_file(rel: &str) -> Vec<u8> {
    let path = fixtures_root().parent().unwrap().join(rel);
    std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

#[test]
#[ignore = "regenerates the committed smoke package from downloaded public inputs"]
fn generate_smoke_package() {
    let inputs =
        PathBuf::from(std::env::var("SIMFORGE_SMOKE_INPUTS").expect("SIMFORGE_SMOKE_INPUTS"));
    let input = |p: &str| std::fs::read(inputs.join(p)).unwrap_or_else(|e| panic!("{p}: {e}"));
    let release_bytes = input("release.json");
    let release: Value = serde_json::from_slice(&release_bytes).unwrap();
    let canonical_doc = input("canonical-closure.json");
    let web_doc = input("web-closure.json");
    // Exactly the registry's documents: canonical JSON with the release's digests.
    assert_eq!(canonicalize(&canonical_doc), canonical_doc);
    assert_eq!(canonicalize(&web_doc), web_doc);
    assert_eq!(
        sha(&canonical_doc),
        release["canonical"]["digest"].as_str().unwrap()
    );
    assert_eq!(sha(&web_doc), release["web"]["digest"].as_str().unwrap());
    let release_digest = sha(&canonicalize(&release_bytes));
    let canonical = MapClosure::parse(&canonical_doc, "canonical", "map/closure.json").unwrap();
    let web = MapClosure::parse(&web_doc, "web", "map/web-closure.json").unwrap();
    let member = |p: &str| {
        let bytes = input(&format!("map/{p}"));
        let listed = canonical.member(p).or_else(|| web.member(p)).unwrap();
        assert_eq!(
            sha(&bytes),
            listed.sha256,
            "{p} is not the published member"
        );
        bytes
    };
    let xodr = member("map.xodr");
    let topology_bytes = gunzip(&member("topology-index.json.gz"));
    let mesh = member(GROUND_MEMBER);
    let actors_closure = input("actor-closure.json");
    assert_eq!(sha(&actors_closure), PUBLIC_ACTOR_CLOSURE);
    let catalog_models = input("catalog-models.json");

    // The trace the CLI simulated on this release, and the instance it ran.
    let trace_gz = input("trace.json.gz");
    let trace = SimTrace::from_json_slice(&gunzip(&trace_gz)).unwrap();
    assert!(trace.upgrade.is_none(), "the smoke trace is current-format");
    let header = &trace.header;
    assert_eq!(header.engine_graph_digest, sha(&xodr));
    assert_eq!(header.ground_digest.as_deref(), Some(sha(&mesh).as_str()));
    let trace_sha = trace.digest().unwrap();
    let instance: Value = serde_json::from_slice(&input("instance.json")).unwrap();
    // The input the engine ran (and hashed into the trace header): normalized,
    // control lanes resolved on the release's lane graph, arrival triggers solved.
    let graph = Arc::new(simforge_core::map::LaneGraph::new(
        TopologyIndex::decode(&topology_bytes).unwrap(),
    ));
    let normalized =
        simforge_core::parse_scenario_input_bytes(&serde_json::to_vec(&instance["input"]).unwrap())
            .unwrap()
            .normalized();
    let (controlled, _) =
        simforge_core::engine::signals::resolve_overlapping_control_lanes(normalized, &graph);
    let arrived =
        simforge_core::solve::arrival::resolve_arrival_triggers(&controlled, &graph).input;
    let resolved = serde_json::to_value(&arrived).unwrap();
    assert_eq!(
        simforge_core::hash::content_hash(&resolved).unwrap(),
        header.input_hash,
        "the engine-resolved instance input is the trace's input"
    );

    // Timeline on the release's ground, keyed by the actor closure.
    let topology = TopologyIndex::decode(&topology_bytes).unwrap();
    let ground = GroundContext::from_bytes(&mesh, Some((&xodr, &topology))).unwrap();
    let height = HeightField::ground(Arc::new(ground));
    let tl = build_render_timeline(&trace, &height, Some(PUBLIC_ACTOR_CLOSURE)).unwrap();
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
        reach.len() > catalog_ids.len(),
        "catalogIds {catalog_ids:?} must each reach a public model"
    );

    let document = canonicalize(&repo_file(TEMPLATE));
    let sim_key = sha(format!("smoke fixture sim key {trace_sha}").as_bytes());
    let resolution = gzip(&canonical_bytes(&json!({
        "contract": "simforge.sim-resolution/v1",
        "simKey": sim_key,
        "resolvedInputDigest": header.input_hash,
        "resolvedInput": resolved,
        "trafficProvider": "native",
    })));
    let catalog_entries = canonical_bytes(&json!(catalog_ids
        .iter()
        .map(|id| json!({ "id": id }))
        .collect::<Vec<_>>()));
    let (name, version) = RELEASE.split_once('@').unwrap();
    let draft = json!({
        "schema": "simforge.scenario-package/v1",
        "producer": { "app": "simforge-fixtures", "appVersion": "0.2.0", "minCli": "0.2.0-rc.0" },
        "scenario": {
            "title": "Smoke: wrong-way vehicle, blind approach, Richmond Field Station (public registry v5)",
            "documentSchema": "simforge.scenario.v2",
            "scenarioVersion": 2,
            "contentSha256": sha(&document),
            "simContentSha256": sha(format!("smoke fixture sim content {trace_sha}").as_bytes())
        },
        "engine": {
            "engineSemVer": header.engine_version,
            "solverVersion": header.engine_version,
            "pipelineRevision": 2,
            "build": { "engineVersion": header.engine_version },
            "release": "0.2.0"
        },
        "simulation": {
            "simKey": sim_key,
            "traceFormat": header.trace_version,
            "traceSchema": format!("simforge.trace/v{}", header.trace_version),
            "traceSha256": trace_sha,
            "traceGzipSha256": sha(&trace_gz),
            "authoredTraceSha256": trace_sha,
            "resolvedInputDigest": header.input_hash,
            "resolutionSha256": sha(&resolution),
            "trafficProvider": "native",
            "trafficStepKey": null,
            "trafficSha256": null,
            "sumo": null,
            "groundDigest": header.ground_digest,
            "producerKind": "cli",
            "simulatedAt": "2026-09-25T00:00:00Z"
        },
        "timelines": [{
            "version": tl.version,
            "samplerVersion": tl.identity.sampler_version,
            "timelineKey": tl.identity.timeline_key,
            "timelineSha256": sha(&timeline),
            "heightFieldDigest": tl.identity.height_field_digest,
            "catalogDigest": PUBLIC_ACTOR_CLOSURE
        }],
        "executionPackage": null,
        "map": {
            "mapVersionId": format!("{name}-{version}"),
            "sourceMapId": name,
            "label": "Richmond Field Station",
            "xodrSha256": sha(&xodr),
            "coordinateSystemSha256": String::from_utf8(input("coordinate-system-sha256.txt")).unwrap().trim(),
            "mapClosureDigest": String::from_utf8(input("map-closure-digest.txt")).unwrap().trim(),
            "pinClosureSha256": pin_closure_sha256(&canonical, Some(&web)),
            "canonicalClosureSha256": sha(&canonical_doc),
            "webClosureSha256": sha(&web_doc),
            "registryReleaseDigest": release_digest,
            "heightSourceDigest": tl.identity.height_field_digest,
            "groundDigest": header.ground_digest,
            "closure": { "memberCount": canonical.members.len(), "bytes": canonical.total_bytes() }
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
    b.member("map/closure.json", canonical_doc.clone()).unwrap();
    b.member("map/web-closure.json", web_doc.clone()).unwrap();
    b.member("actors/closure.json", actors_closure).unwrap();
    b.member("catalog/entries.json", catalog_entries).unwrap();
    b.receipt(ReceiptInput {
        exported_at: "2026-09-25T00:00:00Z".into(),
        exporter_release: "0.2.0-fixture".into(),
        texture_tier: None,
    });
    let (outcome, bytes) = b.to_bytes().unwrap();
    let dir = smoke_dir();
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("richmond-public.scenario.zip"), &bytes).unwrap();
    let authoring: Value = serde_json::from_slice(&input("authoring.json")).unwrap();
    let meta = json!({
        "schema": "simforge.scenario-package-smoke/v1",
        "package": "richmond-public.scenario.zip",
        "packageId": outcome.package_id,
        "packageSha256": sha(&bytes),
        "form": "thin",
        "readerCli": CLI,
        "map": {
            "release": RELEASE,
            "registry": REGISTRY,
            "registryReleaseDigest": release_digest,
            "canonicalClosureSha256": sha(&canonical_doc),
            "webClosureSha256": sha(&web_doc),
            "xodrSha256": sha(&xodr),
            "groundDigest": header.ground_digest,
            "blobOrigin": format!("{REGISTRY}/blobs/sha256/<aa>/<sha256>")
        },
        "actors": {
            "closureDigest": PUBLIC_ACTOR_CLOSURE,
            "closureUrl": format!("{REGISTRY}/actor-assets/closures/{PUBLIC_ACTOR_CLOSURE}.json"),
            "catalogIds": outcome.manifest.catalog.catalog_ids,
        },
        "scenario": { "template": TEMPLATE, "authoring": authoring },
        "trace": { "traceSha256": trace_sha, "engineSemVer": header.engine_version, "traceFormat": header.trace_version },
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
        "placeholders": ["scenario.simContentSha256", "simulation.simKey"],
    });
    let mut text = serde_json::to_string_pretty(&meta).unwrap();
    text.push('\n');
    std::fs::write(dir.join("smoke.json"), text).unwrap();
}

/// The release smoke package is read by the release candidates of its first
/// release as well as the release: `producer.minCli` is `0.2.0-rc.0`, and
/// `minCli > reader` is semver precedence (a pre-release orders before its
/// release), so 0.2.0-rc.0, 0.2.0-rc.1 and 0.2.0 read it and 0.1.x does not.
#[test]
fn the_smoke_package_is_readable_by_the_release_candidates() {
    let dir = smoke_dir();
    let meta: Value =
        serde_json::from_slice(&std::fs::read(dir.join("smoke.json")).unwrap()).unwrap();
    let bytes = std::fs::read(dir.join(meta["package"].as_str().unwrap())).unwrap();
    for reader in ["0.2.0-rc.0", "0.2.0-rc.1", "0.2.0", "0.2.1"] {
        let v = verify_bytes(&bytes, &VerifyOptions::new(Some(reader)).unwrap())
            .unwrap_or_else(|e| panic!("simforge {reader} must read the smoke package: {e}"));
        assert_eq!(v.manifest().producer.min_cli, "0.2.0-rc.0");
    }
    for reader in ["0.1.9", "0.2.0-alpha.1"] {
        let err = verify_bytes(&bytes, &VerifyOptions::new(Some(reader)).unwrap())
            .expect_err("an older reader must refuse the smoke package");
        assert_eq!(err.rule, "version_ahead", "simforge {reader}: {err}");
    }
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
    assert_eq!(
        m.map.canonical_closure_sha256,
        meta["map"]["canonicalClosureSha256"].as_str().unwrap()
    );
    assert_eq!(
        m.map.web_closure_sha256.as_deref(),
        meta["map"]["webClosureSha256"].as_str()
    );
    assert_eq!(
        m.map.registry_release_digest.as_deref(),
        meta["map"]["registryReleaseDigest"].as_str()
    );
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
