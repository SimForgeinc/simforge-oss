//! `simforge simulate` against the golden-trace corpus
//! (oss/fixtures/golden-traces): the CI lock on engine semantics, with its
//! committed Richmond Field Station simulation closure.
//!
//! Each case becomes a workspace the way a package export writes one: the
//! resolution record holds the input the engine resolved (`SimResult.input`,
//! what the hosts store as `resolvedInput`), and the manifest records the
//! golden `traceSha256` under the golden `engineSemVer`. Re-simulating it
//! through the CLI must reproduce the golden digest, which the TypeScript
//! host (native addon) and the WASM editor produce as well.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::{json, Value};
use simforge_cli::commands::simulate::load_world;

fn oss() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

fn golden() -> PathBuf {
    oss().join("fixtures/golden-traces")
}

fn map_dir() -> PathBuf {
    golden().join("maps/richmond-field-station")
}

fn plain(bytes: Vec<u8>) -> Vec<u8> {
    if !bytes.starts_with(&[0x1f, 0x8b]) {
        return bytes;
    }
    let mut out = Vec::new();
    flate2::read::GzDecoder::new(bytes.as_slice())
        .read_to_end(&mut out)
        .unwrap();
    out
}

fn gzip(bytes: &[u8]) -> Vec<u8> {
    let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    e.write_all(bytes).unwrap();
    e.finish().unwrap()
}

fn read_json(path: &Path) -> Value {
    serde_json::from_slice(&plain(std::fs::read(path).unwrap())).unwrap()
}

struct Case {
    id: String,
    expected: Value,
    engine: String,
    input: Value,
}

fn ci_cases() -> Vec<Case> {
    let corpus = read_json(&golden().join("corpus.json"));
    let manifest = read_json(&golden().join("manifest.json"));
    corpus["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["tier"] == "ci")
        .map(|c| {
            let id = c["id"].as_str().unwrap().to_owned();
            let path = if c["source"]["kind"] == "input" {
                oss().join(c["source"]["path"].as_str().unwrap())
            } else {
                golden().join(format!("inputs/{id}.input.json.gz"))
            };
            let mut input = read_json(&path);
            if input.get("input").is_some() && input.get("manifest").is_some() {
                input = input["input"].clone();
            }
            Case {
                expected: manifest["cases"][&id].clone(),
                engine: manifest["engineSemVer"].as_str().unwrap().to_owned(),
                id,
                input,
            }
        })
        .collect()
}

/// The input the engine resolves `authored` to: what a host records.
fn resolved_input(authored: &Value) -> Value {
    let world = load_world(&map_dir()).unwrap();
    let input = simforge_core::types::parse_scenario_input_value(authored)
        .unwrap()
        .normalized();
    let result = simforge_core::engine::run_simulation(input, world.options).unwrap();
    serde_json::to_value(&result.input).unwrap()
}

/// A workspace for one case, as `package import` lays it out.
fn workspace(
    dir: &Path,
    case: &Case,
    resolved: &Value,
    manifest_patch: impl FnOnce(&mut Value),
) -> PathBuf {
    let ws = dir.join(&case.id);
    std::fs::create_dir_all(ws.join("simulation")).unwrap();
    let digest = simforge_core::hash::content_hash(resolved).unwrap();
    let resolution = json!({
        "contract": "simforge.sim-resolution/v1",
        "simKey": "0".repeat(64),
        "resolvedInputDigest": digest,
        "resolvedInput": resolved,
        "trafficProvider": "native",
    });
    std::fs::write(
        ws.join("simulation/resolution.json.gz"),
        gzip(&serde_json::to_vec(&resolution).unwrap()),
    )
    .unwrap();
    let mut manifest = json!({
        "schema": "simforge.scenario-package/v1",
        "engine": { "engineSemVer": case.engine },
        "simulation": {
            "traceSha256": case.expected["traceSha256"],
            "authoredTraceSha256": case.expected["traceSha256"],
            "resolvedInputDigest": digest,
        },
        "map": {
            "xodrSha256": "5b08367524edbc0c46cfb2f4cd77ef6a204f263bb14cf7e8f90a1fffde1c14d6",
            "mapClosureDigest": case.expected["mapClosureDigest"],
            "sourceMapId": "richmond-field-station",
        },
        "timelines": [],
    });
    manifest_patch(&mut manifest);
    std::fs::write(
        ws.join("manifest.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    ws
}

fn simforge(home: &Path) -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_simforge"));
    cmd.env_remove("SIMFORGE_MAPS_CACHE_ROOT")
        .env_remove("XDG_DATA_HOME")
        .env("HOME", home);
    cmd
}

fn run(cmd: &mut Command) -> (i32, Value, Value) {
    let out = cmd.output().unwrap();
    let parse = |bytes: &[u8]| -> Value {
        let text = String::from_utf8_lossy(bytes);
        match text.lines().last() {
            Some(line) if !line.is_empty() => {
                serde_json::from_str(line).unwrap_or_else(|e| panic!("not JSON ({e}): {text}"))
            }
            _ => Value::Null,
        }
    };
    (
        out.status.code().unwrap(),
        parse(&out.stdout),
        parse(&out.stderr),
    )
}

fn simulate(home: &Path, ws: &Path, extra: &[&str]) -> (i32, Value, Value) {
    run(simforge(home)
        .arg("simulate")
        .arg(ws)
        .arg("--map-dir")
        .arg(map_dir())
        .args(extra))
}

#[test]
fn the_committed_closure_is_the_golden_simulation_world() {
    let world = load_world(&map_dir()).unwrap();
    let manifest = read_json(&golden().join("manifest.json"));
    let expected = manifest["cases"]["rfs-stop-and-go"]["mapClosureDigest"]
        .as_str()
        .unwrap();
    assert_eq!(world.closure_digest, expected);
    assert!(world.ground_digest.is_some());
    assert!(world.colliders > 0);
}

#[test]
fn every_ci_golden_case_re_simulates_to_its_golden_trace() {
    let home = tempfile::tempdir().unwrap();
    let cases = ci_cases();
    assert!(cases.len() >= 10);
    // One thread per case: the heavy-ambient cases dominate the wall time.
    std::thread::scope(|scope| {
        for case in &cases {
            let home = home.path();
            scope.spawn(move || check_case(home, case));
        }
    });
}

fn check_case(home: &Path, case: &Case) {
    let resolved = resolved_input(&case.input);
    let ws = workspace(home, case, &resolved, |_| {});
    let (code, doc, err) = simulate(home, &ws, &[]);
    assert_eq!(code, 0, "{}: {doc} {err}", case.id);
    assert_eq!(doc["label"], "re-simulated");
    assert_eq!(
        doc["traceSha256"], case.expected["traceSha256"],
        "{}",
        case.id
    );
    assert_eq!(doc["inputHash"], case.expected["inputHash"], "{}", case.id);
    assert_eq!(doc["ticks"], case.expected["ticks"], "{}", case.id);
    assert_eq!(doc["actors"], case.expected["actors"], "{}", case.id);
    assert_eq!(doc["deterministicMatch"], true, "{}", case.id);
    let out = PathBuf::from(doc["out"].as_str().unwrap());
    assert_eq!(
        out,
        ws.join(format!(
            "simulation/resimulated/{}.trace.json.gz",
            case.expected["traceSha256"].as_str().unwrap()
        ))
    );
    // The written trace reads back to the same identity.
    let trace =
        simforge_core::trace::SimTrace::from_json_slice(&plain(std::fs::read(&out).unwrap()))
            .unwrap();
    assert_eq!(
        trace.digest().unwrap(),
        case.expected["traceSha256"].as_str().unwrap()
    );
}

fn one_case() -> (Case, Value) {
    let case = ci_cases()
        .into_iter()
        .find(|c| c.id == "rfs-stop-and-go")
        .unwrap();
    let resolved = resolved_input(&case.input);
    (case, resolved)
}

#[test]
fn a_different_trace_under_the_same_engine_is_a_determinism_violation() {
    let home = tempfile::tempdir().unwrap();
    let (case, resolved) = one_case();
    let ws = workspace(home.path(), &case, &resolved, |m| {
        m["simulation"]["traceSha256"] = json!("f".repeat(64));
    });
    let (code, doc, _) = simulate(home.path(), &ws, &[]);
    assert_eq!(code, 2, "{doc}");
    assert_eq!(doc["deterministicMatch"], false);
    assert_eq!(doc["findings"][0]["code"], "determinism_violation");
    // The packaged trace is never touched; the re-simulated one is written for the record.
    assert!(PathBuf::from(doc["out"].as_str().unwrap()).is_file());
}

#[test]
fn another_engine_or_a_seed_override_expects_a_different_trace() {
    let home = tempfile::tempdir().unwrap();
    let (case, resolved) = one_case();
    let ws = workspace(home.path(), &case, &resolved, |m| {
        m["engine"]["engineSemVer"] = json!("0.0.1");
        m["simulation"]["traceSha256"] = json!("f".repeat(64));
    });
    let (code, doc, _) = simulate(home.path(), &ws, &[]);
    assert_eq!(code, 0, "{doc}");
    assert_eq!(doc["deterministicMatch"], Value::Null);
    assert_eq!(doc["matchesPackaged"], false);

    std::fs::remove_dir_all(&ws).unwrap();
    let ws = workspace(home.path(), &case, &resolved, |_| {});
    let out = home.path().join("seeded.trace.json.gz");
    let (code, doc, _) = simulate(
        home.path(),
        &ws,
        &["--seed", "another-seed", "--out", out.to_str().unwrap()],
    );
    assert_eq!(code, 0, "{doc}");
    assert_eq!(doc["seed"]["overridden"], true);
    assert_eq!(doc["seed"]["value"], "another-seed");
    assert_eq!(doc["deterministicMatch"], Value::Null);
    assert!(out.is_file());
    assert!(!ws.join("simulation/resimulated").exists());
}

#[test]
fn a_record_that_does_not_name_its_input_or_another_world_is_refused() {
    let home = tempfile::tempdir().unwrap();
    let (case, resolved) = one_case();
    // Tampered input: the recorded digest no longer names it.
    let ws = workspace(home.path(), &case, &resolved, |_| {});
    let path = ws.join("simulation/resolution.json.gz");
    let mut record = read_json(&path);
    record["resolvedInput"]["clipSeconds"] = json!(3);
    std::fs::write(&path, gzip(&serde_json::to_vec(&record).unwrap())).unwrap();
    let (code, _, err) = simulate(home.path(), &ws, &[]);
    assert_eq!(
        (code, err["code"].as_str()),
        (2, Some("resolution_invalid")),
        "{err}"
    );

    // Another simulation world than the package's.
    std::fs::remove_dir_all(&ws).unwrap();
    let ws = workspace(home.path(), &case, &resolved, |m| {
        m["map"]["mapClosureDigest"] = json!("0".repeat(64));
    });
    let (code, _, err) = simulate(home.path(), &ws, &[]);
    assert_eq!(
        (code, err["code"].as_str()),
        (2, Some("map_closure_mismatch")),
        "{err}"
    );

    // No installed map with the package's OpenDRIVE: loud, never substituted.
    let (code, _, err) = run(simforge(home.path()).arg("simulate").arg(&ws));
    assert_eq!(
        (code, err["code"].as_str()),
        (1, Some("map_not_installed")),
        "{err}"
    );

    // A wrong resolution contract.
    record["contract"] = json!("simforge.sim-resolution/v9");
    std::fs::write(&path, gzip(&serde_json::to_vec(&record).unwrap())).ok();
    std::fs::write(
        ws.join("simulation/resolution.json.gz"),
        gzip(&serde_json::to_vec(&record).unwrap()),
    )
    .unwrap();
    let (code, _, err) = simulate(home.path(), &ws, &[]);
    assert_eq!(
        (code, err["code"].as_str()),
        (2, Some("resolution_invalid")),
        "{err}"
    );
}

/// A maps cache laid out as `maps pull` installs a release: the semantic
/// profile without the collider derivative, the web profile with it, both
/// stamped with the release receipt (`releaseDigest`).
fn pulled_layout(root: &Path, web_release: &str) -> PathBuf {
    let src = map_dir();
    let semantic = root.join("dev-assets/richmond-field-station");
    let web = root.join("map-bundles/richmond-field-station");
    fn copy_tree(from: &Path, to: &Path, skip_variants: bool) {
        for entry in std::fs::read_dir(from).unwrap() {
            let entry = entry.unwrap();
            let path = entry.path();
            let name = entry.file_name();
            if skip_variants && name == "variants" {
                continue;
            }
            let target = to.join(&name);
            if path.is_dir() {
                std::fs::create_dir_all(&target).unwrap();
                copy_tree(&path, &target, skip_variants);
            } else {
                std::fs::create_dir_all(to).unwrap();
                std::fs::copy(&path, &target).unwrap();
            }
        }
    }
    copy_tree(&src, &semantic, true);
    std::fs::create_dir_all(web.join("3d")).unwrap();
    copy_tree(&src.join("3d"), &web.join("3d"), false);
    // installed_maps finds the map by its plain map.xodr.
    std::fs::write(
        semantic.join("map.xodr"),
        plain(std::fs::read(src.join("map.xodr.gz")).unwrap()),
    )
    .unwrap();
    let receipt = |release: &str| {
        json!({ "schema": "simforge.map-installation.v1", "name": "richmond-field-station", "version": "v9", "releaseDigest": release }).to_string()
    };
    std::fs::write(semantic.join(".map-release.json"), receipt(&"a".repeat(64))).unwrap();
    std::fs::write(web.join(".map-release.json"), receipt(web_release)).unwrap();
    assert!(!semantic.join("3d/variants").exists());
    semantic
}

#[test]
fn colliders_come_from_the_web_install_of_the_same_release() {
    let home = tempfile::tempdir().unwrap();
    let (case, resolved) = one_case();
    let ws = workspace(home.path(), &case, &resolved, |_| {});
    let maps = home.path().join("maps");
    pulled_layout(&maps, &"a".repeat(64));
    let (code, doc, err) = run(simforge(home.path())
        .arg("simulate")
        .arg(&ws)
        .env("SIMFORGE_MAPS_CACHE_ROOT", &maps));
    assert_eq!(code, 0, "{err}");
    assert!(doc["map"]["staticColliders"].as_u64().unwrap() > 0, "{doc}");
    assert_eq!(
        doc["map"]["colliderSource"]["from"],
        "the web install of the same release"
    );
    assert_eq!(doc["deterministicMatch"], true, "{doc}");
}

#[test]
fn a_map_without_colliders_is_refused_unless_explicitly_allowed() {
    let home = tempfile::tempdir().unwrap();
    let (case, resolved) = one_case();
    // The web install is of another release: its colliders are not used.
    let ws = workspace(home.path(), &case, &resolved, |m| {
        m["map"]["mapClosureDigest"] = Value::Null;
    });
    let maps = home.path().join("maps");
    pulled_layout(&maps, &"b".repeat(64));
    let (code, _, err) = run(simforge(home.path())
        .arg("simulate")
        .arg(&ws)
        .env("SIMFORGE_MAPS_CACHE_ROOT", &maps));
    assert_eq!(code, 2);
    assert_eq!(err["code"], "static_colliders_missing", "{err}");
    let (code, doc, err) = run(simforge(home.path())
        .args(["simulate", "--allow-no-colliders"])
        .arg(&ws)
        .env("SIMFORGE_MAPS_CACHE_ROOT", &maps));
    assert_eq!(code, 0, "{err}");
    assert_eq!(doc["map"]["staticColliders"], 0);
    assert_eq!(
        doc["map"]["colliderSource"]["from"],
        "none (--allow-no-colliders)"
    );
}

/// Set to a maps cache where `simforge maps pull richmond-field-station@v2`
/// ran (dev-assets/, .corpus/ and map-bundles/ of the public release).
fn pulled_richmond() -> PathBuf {
    PathBuf::from(std::env::var_os("SIMFORGE_CLI_TEST_PULLED_MAPS").expect(
        "set SIMFORGE_CLI_TEST_PULLED_MAPS to a maps cache holding `simforge maps pull richmond-field-station@v2`",
    ))
}

#[test]
#[ignore = "needs a maps cache with the public richmond-field-station pulled (SIMFORGE_CLI_TEST_PULLED_MAPS)"]
fn a_pulled_richmond_simulates_with_its_colliders_without_map_dir() {
    let home = tempfile::tempdir().unwrap();
    let (case, resolved) = one_case();
    // The public release is another world than the committed golden one
    // (other collider build, no ground surface): its closure and trace
    // differ, so neither is pinned (another engine label: no match expected).
    let ws = workspace(home.path(), &case, &resolved, |m| {
        m["map"]["mapClosureDigest"] = Value::Null;
        m["engine"]["engineSemVer"] = json!("0.0.0-public-world");
    });
    let maps = pulled_richmond();
    let semantic = maps.join("dev-assets/richmond-field-station");
    // The semantic install carries no collider derivative of its own.
    let own = simforge_compiler::bundle::load_static_colliders(&semantic).1;
    assert_eq!(
        own.status,
        simforge_compiler::bundle::StaticColliderStatus::Unavailable
    );
    let (code, doc, err) = run(simforge(home.path())
        .arg("simulate")
        .arg(&ws)
        .env("SIMFORGE_MAPS_CACHE_ROOT", &maps));
    assert_eq!(code, 0, "{err}");
    assert!(doc["map"]["staticColliders"].as_u64().unwrap() > 0, "{doc}");
    assert_eq!(
        doc["map"]["colliderSource"]["dir"],
        maps.join("map-bundles/richmond-field-station")
            .to_str()
            .unwrap()
    );
}
