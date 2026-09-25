//! `simforge assets pull` against a synthetic, hermetic asset store: over
//! `file://` (a closure root) and over a local HTTP origin
//! (`<origin>/actor-assets/...`). Nothing here touches the network.

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

fn sha(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// A closure root (`closures/`, `blobs/sha256/..`) built from `members`.
/// Returns the store directory and the closure digest.
fn store(dir: &Path, members: &[(&str, Vec<u8>)]) -> String {
    let mut listing = serde_json::Map::new();
    for (path, bytes) in members {
        let digest = sha(bytes);
        let blob = dir.join("blobs/sha256").join(&digest[..2]).join(&digest);
        std::fs::create_dir_all(blob.parent().unwrap()).unwrap();
        std::fs::write(&blob, bytes).unwrap();
        listing.insert(
            (*path).to_owned(),
            json!({ "bytes": bytes.len(), "sha256": digest }),
        );
    }
    let doc = serde_json::to_vec(
        &json!({ "members": listing, "schema": "simforge.actor-assets-closure/v1" }),
    )
    .unwrap();
    let digest = sha(&doc);
    std::fs::create_dir_all(dir.join("closures")).unwrap();
    std::fs::write(dir.join("closures").join(format!("{digest}.json")), &doc).unwrap();
    digest
}

fn catalog(entries: Value) -> Vec<u8> {
    serde_json::to_vec(&entries).unwrap()
}

/// The render-closure shape: catalog-models.json with attributed entries.
fn render_closure() -> Vec<(&'static str, Vec<u8>)> {
    vec![
        (
            "catalog-models.json",
            catalog(json!({
                "vehicle.sedan": { "model": { "glbPath": "models/vehicle.sedan/model.glb",
                    "attribution": "\"Sedan\" vehicle model © CARLA Simulator contributors (carla.org), licensed CC BY 4.0", "source": "carla-0.10.0-ue5" },
                    "tintable": true, "scaleToDims": true },
                "pedestrian.adult": { "model": { "glbPath": "models/pedestrian.adult/model.glb",
                    "attribution": "Generated with Meshy for SimForge", "source": "meshy-refined" },
                    "tintable": false, "scaleToDims": false,
                    "animations": { "walk": { "glbPath": "models/shared/walk.glb", "clip": "walk" } } },
            })),
        ),
        ("models/vehicle.sedan/model.glb", b"glTF sedan".to_vec()),
        ("models/pedestrian.adult/model.glb", b"glTF adult".to_vec()),
        // Unbound, but under an attributed entry's directory.
        (
            "models/pedestrian.adult/animations/idle.glb",
            b"glTF idle".to_vec(),
        ),
        ("models/shared/walk.glb", b"glTF walk".to_vec()),
        // Same bytes as another member: one blob.
        ("models/vehicle.sedan/copy.glb", b"glTF sedan".to_vec()),
    ]
}

fn simforge(home: &Path) -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_simforge"));
    cmd.env_remove("SIMFORGE_ACTOR_ASSETS_ROOT")
        .env_remove("SIMFORGE_ACTOR_ASSETS_BASE_URL")
        .env_remove("XDG_DATA_HOME")
        .env("HOME", home);
    cmd
}

fn run(cmd: &mut Command) -> (i32, Value, Value) {
    let out = cmd.output().unwrap();
    let parse = |b: &[u8]| {
        let s = String::from_utf8_lossy(b);
        let line = s.lines().last().unwrap_or("").to_owned();
        if line.is_empty() {
            Value::Null
        } else {
            serde_json::from_str(&line).unwrap_or_else(|e| panic!("not JSON ({e}): {s}"))
        }
    };
    (
        out.status.code().unwrap(),
        parse(&out.stdout),
        parse(&out.stderr),
    )
}

fn file_url(p: &Path) -> String {
    format!("file://{}", p.display())
}

/// Serves `<dir>` under `/actor-assets/` until the test process exits.
fn http_origin(dir: PathBuf) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let dir = dir.clone();
            std::thread::spawn(move || {
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut request = String::new();
                if reader.read_line(&mut request).is_err() {
                    return;
                }
                loop {
                    let mut header = String::new();
                    if reader.read_line(&mut header).unwrap_or(0) == 0 || header == "\r\n" {
                        break;
                    }
                }
                let path = request.split_whitespace().nth(1).unwrap_or("/");
                let body = path
                    .strip_prefix("/actor-assets/")
                    .and_then(|rel| std::fs::read(dir.join(rel)).ok());
                let _ = match body {
                    Some(body) => {
                        let _ = write!(
                            stream,
                            "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                            body.len()
                        );
                        stream.write_all(&body)
                    }
                    None => write!(
                        stream,
                        "HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
                    ),
                };
            });
        }
    });
    format!("http://{addr}")
}

fn installed_files(root: &Path) -> Vec<String> {
    fn walk(dir: &Path, root: &Path, out: &mut Vec<String>) {
        for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let p = entry.path();
            if p.is_dir() {
                walk(&p, root, out);
            } else {
                out.push(p.strip_prefix(root).unwrap().display().to_string());
            }
        }
    }
    let mut out = Vec::new();
    walk(root, root, &mut out);
    out.sort();
    out
}

#[test]
fn pulls_verifies_and_installs_the_render_layout_then_reuses_everything() {
    let tmp = tempfile::tempdir().unwrap();
    let origin = tmp.path().join("store");
    let digest = store(&origin, &render_closure());
    let root = tmp.path().join("root");

    let (code, out, err) = run(simforge(tmp.path())
        .args([
            "assets",
            "pull",
            "--closure",
            &digest,
            "--base-url",
            &file_url(&origin),
            "--root",
        ])
        .arg(&root));
    assert_eq!(code, 0, "{err}");
    assert_eq!(out["closure"]["digest"], digest.as_str());
    assert_eq!(out["baseUrl"]["source"], "flag:--base-url");
    assert_eq!(out["members"]["count"], 6);
    assert_eq!(out["blobs"]["distinct"], 5);
    assert_eq!(out["blobs"]["downloaded"]["count"], 5);
    assert_eq!(out["blobs"]["reused"]["count"], 0);
    assert_eq!(out["attribution"]["source"], "derived:catalog-models.json");
    assert_eq!(
        out["attribution"]["licenses"],
        json!({ "CC-BY-4.0": 1, "unstated": 1 })
    );

    // The layout local-runtime.ts reads, with the closure document byte-identical.
    let doc = std::fs::read(root.join("closures").join(format!("{digest}.json"))).unwrap();
    assert_eq!(sha(&doc), digest);
    for (_, bytes) in render_closure() {
        let d = sha(&bytes);
        assert_eq!(
            std::fs::read(root.join("blobs/sha256").join(&d[..2]).join(&d)).unwrap(),
            bytes
        );
    }
    let attribution: Value = serde_json::from_slice(
        &std::fs::read(
            root.join("closures")
                .join(format!("{digest}.ATTRIBUTION.json")),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        attribution["schema"],
        "simforge.actor-assets-attribution/v1"
    );
    let adult = &attribution["entries"]["pedestrian.adult"];
    assert_eq!(
        adult["members"],
        json!([
            "models/pedestrian.adult/animations/idle.glb",
            "models/pedestrian.adult/model.glb",
            "models/shared/walk.glb"
        ])
    );
    assert!(!installed_files(&root)
        .iter()
        .any(|f| f.starts_with(".staging")));

    // Re-pull over HTTP, root from the environment: nothing downloaded.
    let (code, out, err) = run(simforge(tmp.path())
        .args(["assets", "pull", "--closure", &digest])
        .env(
            "SIMFORGE_ACTOR_ASSETS_BASE_URL",
            http_origin(origin.clone()),
        )
        .env("SIMFORGE_ACTOR_ASSETS_ROOT", &root));
    assert_eq!(code, 0, "{err}");
    assert_eq!(
        out["baseUrl"]["source"],
        "env:SIMFORGE_ACTOR_ASSETS_BASE_URL"
    );
    assert_eq!(out["root"]["source"], "env:SIMFORGE_ACTOR_ASSETS_ROOT");
    assert_eq!(out["closure"]["reused"], true);
    assert_eq!(out["blobs"]["downloaded"]["count"], 0);
    assert_eq!(out["blobs"]["reused"]["count"], 5);

    // A corrupt installed blob is replaced, not trusted.
    let d = sha(b"glTF walk");
    let blob = root.join("blobs/sha256").join(&d[..2]).join(&d);
    std::fs::write(&blob, b"bit rot").unwrap();
    let (code, out, err) = run(simforge(tmp.path())
        .args([
            "assets",
            "pull",
            "--closure",
            &digest,
            "--base-url",
            &file_url(&origin),
            "--root",
        ])
        .arg(&root));
    assert_eq!(code, 0, "{err}");
    assert_eq!(out["blobs"]["repaired"], 1);
    assert_eq!(out["blobs"]["downloaded"]["count"], 1);
    assert_eq!(std::fs::read(&blob).unwrap(), b"glTF walk");
}

#[test]
fn over_http_from_a_fresh_root() {
    let tmp = tempfile::tempdir().unwrap();
    let origin = tmp.path().join("store");
    let digest = store(&origin, &render_closure());
    let base = format!("{}/actor-assets/", http_origin(origin)); // the /actor-assets spelling folds away
    let (code, out, err) = run(simforge(tmp.path()).args([
        "assets",
        "pull",
        "--closure",
        &digest,
        "--base-url",
        &base,
    ]));
    assert_eq!(code, 0, "{err}");
    assert_eq!(out["root"]["source"], "home");
    let root = tmp.path().join(".local/share/simforge/actor-assets");
    assert_eq!(out["root"]["path"], root.to_str().unwrap());
    assert!(root
        .join("closures")
        .join(format!("{digest}.json"))
        .is_file());
}

#[test]
fn a_tampered_blob_is_exit_2_and_installs_nothing() {
    let tmp = tempfile::tempdir().unwrap();
    let origin = tmp.path().join("store");
    let digest = store(&origin, &render_closure());
    let d = sha(b"glTF adult");
    std::fs::write(
        origin.join("blobs/sha256").join(&d[..2]).join(&d),
        b"glTF adulX",
    )
    .unwrap();
    let root = tmp.path().join("root");
    for base in [file_url(&origin), http_origin(origin.clone())] {
        let (code, out, err) = run(simforge(tmp.path())
            .args([
                "assets",
                "pull",
                "--closure",
                &digest,
                "--base-url",
                &base,
                "--root",
            ])
            .arg(&root));
        assert_eq!(code, 2, "{err}");
        assert_eq!(out, Value::Null);
        assert_eq!(err["code"], "blob_mismatch");
        assert_eq!(
            err["detail"]["mismatches"][0]["member"],
            "models/pedestrian.adult/model.glb"
        );
        assert_eq!(
            installed_files(&root),
            Vec::<String>::new(),
            "nothing is installed"
        );
    }
}

#[test]
fn a_document_that_does_not_hash_to_its_digest_is_exit_2() {
    let tmp = tempfile::tempdir().unwrap();
    let origin = tmp.path().join("store");
    let digest = store(&origin, &render_closure());
    let wrong = "0".repeat(64);
    std::fs::copy(
        origin.join("closures").join(format!("{digest}.json")),
        origin.join("closures").join(format!("{wrong}.json")),
    )
    .unwrap();
    let root = tmp.path().join("root");
    let (code, _, err) = run(simforge(tmp.path())
        .args([
            "assets",
            "pull",
            "--closure",
            &wrong,
            "--base-url",
            &file_url(&origin),
            "--root",
        ])
        .arg(&root));
    assert_eq!(code, 2);
    assert_eq!(err["code"], "closure_digest_mismatch");
    assert_eq!(err["detail"]["actual"], digest.as_str());
    assert_eq!(installed_files(&root), Vec::<String>::new());
}

#[test]
fn an_unknown_digest_or_bad_arguments_are_exit_1() {
    let tmp = tempfile::tempdir().unwrap();
    let origin = tmp.path().join("store");
    store(&origin, &render_closure());
    let unknown = "1".repeat(64);
    for base in [file_url(&origin), http_origin(origin.clone())] {
        let (code, _, err) = run(simforge(tmp.path()).args([
            "assets",
            "pull",
            "--closure",
            &unknown,
            "--base-url",
            &base,
        ]));
        assert_eq!(code, 1);
        assert_eq!(err["code"], "unknown_closure", "{err}");
    }
    let (code, _, err) =
        run(simforge(tmp.path()).args(["assets", "pull", "--closure", "218209f5"]));
    assert_eq!((code, err["code"].as_str()), (1, Some("bad_value")));
    let (code, _, err) =
        run(simforge(tmp.path()).args(["assets", "pull", "--base-url", "s3://bucket"]));
    assert_eq!((code, err["code"].as_str()), (1, Some("bad_value")));
    // Unreachable origin: could not run.
    let (code, _, err) = run(simforge(tmp.path()).args([
        "assets",
        "pull",
        "--closure",
        &unknown,
        "--base-url",
        "http://127.0.0.1:9",
        "--timeout",
        "2",
    ]));
    assert_eq!(
        (code, err["code"].as_str()),
        (1, Some("registry_unreachable"))
    );
}

#[test]
fn missing_attribution_is_refused() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("root");

    // No ATTRIBUTION.json and no catalog: nothing can attribute the models.
    let origin = tmp.path().join("bare");
    let digest = store(&origin, &[("models/x/model.glb", b"x".to_vec())]);
    let (code, _, err) = run(simforge(tmp.path())
        .args([
            "assets",
            "pull",
            "--closure",
            &digest,
            "--base-url",
            &file_url(&origin),
            "--root",
        ])
        .arg(&root));
    assert_eq!(
        (code, err["code"].as_str()),
        (2, Some("attribution_missing"))
    );
    assert_eq!(installed_files(&root), Vec::<String>::new());

    // A catalog entry without attribution, and a member no entry covers.
    let origin = tmp.path().join("gaps");
    let digest = store(
        &origin,
        &[
            (
                "catalog-models.json",
                catalog(
                    json!({ "version": 1, "vehicle.van": { "model": { "glbPath": "models/vehicle.van/model.glb" } } }),
                ),
            ),
            ("models/vehicle.van/model.glb", b"van".to_vec()),
            ("models/orphan.glb", b"orphan".to_vec()),
        ],
    );
    let (code, _, err) = run(simforge(tmp.path())
        .args([
            "assets",
            "pull",
            "--closure",
            &digest,
            "--base-url",
            &file_url(&origin),
            "--root",
        ])
        .arg(&root));
    assert_eq!(
        (code, err["code"].as_str()),
        (2, Some("attribution_incomplete"))
    );
    assert_eq!(err["detail"]["unattributedEntries"], json!(["vehicle.van"]));
    assert_eq!(
        err["detail"]["uncoveredMembers"],
        json!(["models/orphan.glb", "models/vehicle.van/model.glb"])
    );
    assert_eq!(installed_files(&root), Vec::<String>::new());
}

#[test]
fn a_pack_closure_is_attributed_by_its_attribution_member() {
    let tmp = tempfile::tempdir().unwrap();
    let origin = tmp.path().join("store");
    let attribution = serde_json::to_vec(&json!({
        "license": "CC-BY-4.0",
        "assets": { "vehicle_van": { "license": "CC-BY-4.0", "attribution": "\"Van\" © CARLA" } },
    }))
    .unwrap();
    let digest = store(
        &origin,
        &[
            ("ATTRIBUTION.json", attribution.clone()),
            ("models/vehicle_van.glb", b"van".to_vec()),
        ],
    );
    let root = tmp.path().join("root");
    let (code, out, err) = run(simforge(tmp.path())
        .args([
            "assets",
            "pull",
            "--closure",
            &digest,
            "--base-url",
            &file_url(&origin),
            "--root",
        ])
        .arg(&root));
    assert_eq!(code, 0, "{err}");
    assert_eq!(out["attribution"]["source"], "member:ATTRIBUTION.json");
    assert_eq!(out["attribution"]["licenses"], json!({ "CC-BY-4.0": 1 }));
    assert_eq!(
        std::fs::read(
            root.join("closures")
                .join(format!("{digest}.ATTRIBUTION.json"))
        )
        .unwrap(),
        attribution
    );
}

#[test]
fn help_lists_the_command_as_available() {
    let tmp = tempfile::tempdir().unwrap();
    let (code, doc, _) = run(simforge(tmp.path()).args(["assets", "pull", "--help"]));
    assert_eq!(code, 0);
    assert_eq!(doc["status"], "available");
}
