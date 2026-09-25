//! `simforge render`.
//!
//! Hermetic tests cover the refusals that happen before any GPU work. The
//! `lavapipe_*` tests render for real on Mesa lavapipe (the golden adapter
//! of record; never the GPU) and are `#[ignore]`d because they need the
//! installed public map and actor closure:
//!
//! ```sh
//! SIMFORGE_CLI_TEST_MAPS=~/.local/share/simforge/maps \
//! SIMFORGE_CLI_TEST_ASSETS=<simforge assets pull root> \
//! SIMFORGE_SKY_ASSETS=<dir with the two .skytex plates> \
//!   cargo test -p simforge --test render -- --ignored
//! ```
//!
//! The workspace is built from the golden-trace corpus (`rfs-uturn-car` on
//! Richmond Field Station): the committed input is simulated by the engine,
//! and its trace is packaged the way `package import` lays a workspace out.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::{json, Value};
use simforge_cli::commands::simulate::load_world;

const LAVAPIPE_ICD: &str = "/usr/share/vulkan/icd.d/lvp_icd.json";
/// The render pin of the actor closure (`simforge assets pull` default).
const ACTOR_CLOSURE: &str = "218209f5109d8a25d9967de1cca4b202555dc12f53289463aa40a6812d79854f";

fn oss() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

fn golden_map() -> PathBuf {
    oss().join("fixtures/golden-traces/maps/richmond-field-station")
}

fn gzip(bytes: &[u8]) -> Vec<u8> {
    let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    e.write_all(bytes).unwrap();
    e.finish().unwrap()
}

fn simforge(home: &Path) -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_simforge"));
    for var in [
        "SIMFORGE_MAPS_CACHE_ROOT",
        "SIMFORGE_ACTOR_ASSETS_ROOT",
        "XDG_DATA_HOME",
        "SIMFORGE_NATIVE_ALLOW_SOFTWARE_ADAPTER",
        "WGPU_BACKEND",
        "WGPU_ADAPTER_NAME",
    ] {
        cmd.env_remove(var);
    }
    cmd.env("HOME", home).env("VK_ICD_FILENAMES", LAVAPIPE_ICD);
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

/// The committed golden world without its ground derivative: the public
/// `richmond-field-station@v2` release carries none, so a render against the
/// installed public map needs a trace simulated (and a timeline baked) on
/// the OpenDRIVE elevation. Holds `map.xodr` plain for the timeline step too.
fn ungrounded_world(dir: &Path) -> PathBuf {
    let world = dir.join("world/richmond-field-station");
    for entry in walk(&golden_map()) {
        let rel = entry.strip_prefix(golden_map()).unwrap();
        if rel.starts_with("derived/ground") {
            continue;
        }
        let target = world.join(rel);
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::copy(&entry, &target).unwrap();
    }
    let mut xodr = Vec::new();
    flate2::read::GzDecoder::new(std::fs::File::open(golden_map().join("map.xodr.gz")).unwrap())
        .read_to_end(&mut xodr)
        .unwrap();
    std::fs::write(world.join("map.xodr"), xodr).unwrap();
    world
}

fn walk(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            out.extend(walk(&path));
        } else {
            out.push(path);
        }
    }
    out
}

/// The engine's trace of a golden-corpus input on `world`.
fn golden_trace(case: &str, world: &Path) -> (Vec<u8>, String) {
    let path = oss().join(format!("fixtures/golden-traces/inputs/{case}.input.json"));
    let authored: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let world = load_world(world).unwrap();
    assert!(
        world.options.ground.is_none(),
        "the test world must be ungrounded"
    );
    let input = simforge_core::types::parse_scenario_input_value(&authored)
        .unwrap()
        .normalized();
    let result = simforge_core::engine::run_simulation(input, world.options).unwrap();
    let sha = result.trace.digest().unwrap();
    (serde_json::to_vec(&result.trace).unwrap(), sha)
}

/// A workspace around `trace` whose packaged timeline is `timeline` (an
/// identity from `timeline build`), binding the actor closure `closure`.
fn workspace(
    dir: &Path,
    trace: &[u8],
    trace_sha: &str,
    timeline: &Value,
    closure: &str,
) -> PathBuf {
    let ws = dir.join("ws");
    std::fs::create_dir_all(ws.join("simulation")).unwrap();
    std::fs::write(ws.join("simulation/trace.json.gz"), gzip(trace)).unwrap();
    std::fs::write(
        ws.join("document.json"),
        serde_json::to_vec(&json!({
            "scenarioVersion": 2,
            "environment": { "weather": "clear", "timeOfDay": "noon" },
        }))
        .unwrap(),
    )
    .unwrap();
    let manifest = json!({
        "schema": "simforge.scenario-package/v1",
        "simulation": { "traceSha256": trace_sha },
        "map": {
            "xodrSha256": "5b08367524edbc0c46cfb2f4cd77ef6a204f263bb14cf7e8f90a1fffde1c14d6",
            "heightSourceDigest": timeline["heightFieldDigest"],
            "sourceMapId": "richmond-field-station",
        },
        "timelines": [{
            "timelineSha256": timeline["timelineSha256"],
            "timelineKey": timeline["timelineKey"],
            "samplerVersion": timeline["samplerVersion"],
            "heightFieldDigest": timeline["heightFieldDigest"],
            "catalogDigest": null,
        }],
        "catalog": { "actorClosureDigest": closure },
    });
    std::fs::write(
        ws.join("manifest.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    ws
}

/// A small rig: one camera on the ego, 1 s at 10 fps, 320x180.
fn rig(dir: &Path, extra: &[Value]) -> PathBuf {
    let mut sources = vec![json!({
        "actorId": "ego", "sensorId": "front-camera", "sensorLabel": "Front camera",
        "outputName": "ego-front-camera-rgb", "modality": "rgb",
        "transform": { "position": { "x": 1.6, "y": 1.45, "z": 0 }, "rotation": { "yawRad": 0, "pitchRad": 0, "rollRad": 0 } },
        "attributes": { "width": 320, "height": 180, "fps": 10, "horizontalFovDeg": 90, "nearM": 0.05, "farM": 1000 },
    })];
    sources.extend(extra.iter().cloned());
    let path = dir.join("rig.json");
    let doc = json!({
        "schema": "simforge.render-rig/v1",
        "sources": sources,
        "clip": { "startSeconds": 2.0, "endSeconds": 3.0 },
        "video": { "width": 320, "height": 180, "fps": 10, "container": "mp4", "codec": "h264", "quality": "standard" },
    });
    std::fs::write(&path, serde_json::to_vec_pretty(&doc).unwrap()).unwrap();
    path
}

/// The timeline identity of `trace` on the golden world's OpenDRIVE.
fn timeline_identity(home: &Path, trace: &Path, map: &Path) -> Value {
    let (code, doc, err) = run(simforge(home)
        .args(["timeline", "build", "--height", "xodr", "--trace"])
        .arg(trace)
        .arg("--map-dir")
        .arg(map));
    assert_eq!(code, 0, "{err}");
    doc
}

struct Fixture {
    _home: tempfile::TempDir,
    home: PathBuf,
    ws: PathBuf,
}

fn fixture() -> Fixture {
    let home = tempfile::tempdir().unwrap();
    let dir = home.path().to_path_buf();
    let world = ungrounded_world(&dir);
    let (trace, sha) = golden_trace("rfs-uturn-car", &world);
    let trace_path = dir.join("trace.json");
    std::fs::write(&trace_path, &trace).unwrap();
    let identity = timeline_identity(&dir, &trace_path, &world);
    let ws = workspace(&dir, &trace, &sha, &identity, ACTOR_CLOSURE);
    Fixture {
        _home: home,
        home: dir,
        ws,
    }
}

#[test]
fn refusals_happen_before_any_render() {
    let f = fixture();
    let rig_path = rig(&f.home, &[]);
    let render = |extra: &[&str], out: &Path| {
        run(simforge(&f.home)
            .args(["render"])
            .arg(&f.ws)
            .args(["--preset", "training", "--rig"])
            .arg(&rig_path)
            .arg("--out")
            .arg(out)
            .args(extra))
    };

    // An output directory with anything in it is never overwritten.
    let used = f.home.join("used");
    std::fs::create_dir_all(&used).unwrap();
    std::fs::write(used.join("x"), "x").unwrap();
    let (code, _, err) = render(&[], &used);
    assert_eq!(
        (code, err["code"].as_str()),
        (1, Some("out_not_empty")),
        "{err}"
    );

    // No native install of the map: named, with the pull hint, never substituted.
    let (code, _, err) = render(&[], &f.home.join("out1"));
    assert_eq!(
        (code, err["code"].as_str()),
        (1, Some("map_not_installed")),
        "{err}"
    );

    // A map directory with another OpenDRIVE is a mismatch.
    let other = f.home.join("other");
    std::fs::create_dir_all(&other).unwrap();
    std::fs::write(other.join("map.xodr"), "<OpenDRIVE/>").unwrap();
    let (code, _, err) = render(
        &["--map-dir", other.to_str().unwrap()],
        &f.home.join("out2"),
    );
    assert_eq!(
        (code, err["code"].as_str()),
        (2, Some("map_mismatch")),
        "{err}"
    );

    // Flag errors are flag errors.
    let (code, _, err) = render(&["--passes", "rgb,normals"], &f.home.join("out3"));
    assert_eq!(
        (code, err["code"].as_str()),
        (1, Some("bad_value")),
        "{err}"
    );
}

fn env_dir(name: &str) -> PathBuf {
    PathBuf::from(
        std::env::var_os(name).unwrap_or_else(|| panic!("set {name} (see the module docs)")),
    )
}

fn lavapipe_render(
    f: &Fixture,
    rig_path: &Path,
    out: &Path,
    extra: &[&str],
) -> (i32, Value, Value) {
    assert!(
        Path::new(LAVAPIPE_ICD).exists(),
        "lavapipe is required ({LAVAPIPE_ICD})"
    );
    run(simforge(&f.home)
        .arg("render")
        .arg(&f.ws)
        .args(["--preset", "training", "--rig"])
        .arg(rig_path)
        .arg("--out")
        .arg(out)
        .arg("--allow-software-adapter")
        .args(extra)
        .env(
            "SIMFORGE_MAPS_CACHE_ROOT",
            env_dir("SIMFORGE_CLI_TEST_MAPS"),
        )
        .env(
            "SIMFORGE_ACTOR_ASSETS_ROOT",
            env_dir("SIMFORGE_CLI_TEST_ASSETS"),
        )
        .env("SIMFORGE_SKY_ASSETS", env_dir("SIMFORGE_SKY_ASSETS")))
}

fn artifact_hashes(out: &Path) -> Value {
    let results: Value =
        serde_json::from_slice(&std::fs::read(out.join("results.json")).unwrap()).unwrap();
    let mut map = serde_json::Map::new();
    for a in results["artifacts"].as_array().unwrap() {
        map.insert(a["path"].as_str().unwrap().to_owned(), a["sha256"].clone());
    }
    Value::Object(map)
}

#[test]
#[ignore = "renders on lavapipe with the installed richmond map and actor closure (see module docs)"]
fn lavapipe_render_writes_frames_passes_videos_and_passes_its_gates() {
    let f = fixture();
    let lidar = json!({
        "actorId": "ego", "sensorId": "roof-lidar", "sensorLabel": "Roof lidar",
        "outputName": "ego-roof-lidar-lidar", "modality": "lidar",
        "transform": { "position": { "x": 0, "y": 1.9, "z": 0 }, "rotation": { "yawRad": 0, "pitchRad": 0, "rollRad": 0 } },
        "attributes": { "channels": 32, "rangeM": 100, "pointsPerSecond": 320000, "rotationFrequencyHz": 10, "upperFovDeg": 10, "lowerFovDeg": -10, "horizontalFovDeg": 360 },
    });
    let radar = json!({
        "actorId": "ego", "sensorId": "front-radar", "sensorLabel": "Front radar",
        "outputName": "ego-front-radar-radar", "modality": "radar",
        "transform": { "position": { "x": 2.2, "y": 0.6, "z": 0 }, "rotation": { "yawRad": 0, "pitchRad": 0, "rollRad": 0 } },
        "attributes": { "horizontalFovDeg": 60, "verticalFovDeg": 10, "rangeM": 150, "pointsPerSecond": 1500 },
    });
    let rig_path = rig(&f.home, &[lidar, radar]);
    let out = f.home.join("out");
    let (code, doc, err) =
        lavapipe_render(&f, &rig_path, &out, &["--passes", "rgb,id,depth,semantic"]);
    assert_eq!(code, 0, "{err} {doc}");
    assert_eq!(doc["schema"], "simforge.cli-render/v1");
    assert_eq!(doc["softwareAdapter"], true);
    assert_eq!(doc["frames"], 10);
    assert_eq!(doc["gates"]["parity"]["pass"], true, "{}", doc["gates"]);
    assert_eq!(doc["gates"]["nonFinitePixels"], 0);
    for pass in ["rgb.png", "id.png", "depth.f32.bin", "semantic.png"] {
        assert!(
            out.join(format!("ego-front-camera-rgb/00000000.{pass}"))
                .is_file(),
            "{pass}"
        );
    }
    assert!(out.join("ego-roof-lidar-lidar/00000000.ply").is_file());
    assert!(out.join("ego-front-radar-radar/00000000.csv").is_file());
    let videos = doc["videos"].as_array().unwrap();
    assert_eq!(videos.len(), 3);
    for v in videos {
        assert_eq!(v["status"], "encoded", "{v}");
        assert!(Path::new(v["path"].as_str().unwrap()).is_file());
    }
    assert_eq!(videos[0]["frames"], 10);
    // stderr carries nothing on success: the renderer's diagnostics are in render.log.
    assert_eq!(err, Value::Null);
    assert!(out.join("render.log").is_file());

    // Deterministic on lavapipe: a second render has identical artifacts.
    let rig_only = rig(&f.home, &[]);
    let a = f.home.join("a");
    let b = f.home.join("b");
    for dir in [&a, &b] {
        let (code, _, err) = lavapipe_render(
            &f,
            &rig_only,
            dir,
            &["--passes", "rgb,id", "--video", "off"],
        );
        assert_eq!(code, 0, "{err}");
    }
    assert_eq!(artifact_hashes(&a), artifact_hashes(&b));

    // And equal to the committed lavapipe golden for this adapter fingerprint.
    check_golden("rfs-uturn-car-front-camera", &artifact_hashes(&a));
}

/// The golden-harness fingerprint (qualification/golden-harness/lib/fingerprint.mjs):
/// the first 16 hex of sha256(JSON.stringify({adapter: {deviceName, driverInfo},
/// cpuModel, arch})) over the lavapipe adapter and this CPU.
fn lavapipe_fingerprint(home: &Path) -> String {
    let (_, doc, _) = run(simforge(home)
        .args(["doctor", "--offline"])
        .env("SIMFORGE_NATIVE_ALLOW_SOFTWARE_ADAPTER", "1"));
    let gpu = doc["checks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == "gpu")
        .unwrap();
    let adapter = &gpu["detail"]["adapters"][0];
    let cpuinfo = std::fs::read_to_string("/proc/cpuinfo").unwrap();
    let cpu_model = cpuinfo
        .lines()
        .find_map(|l| {
            l.strip_prefix("model name")
                .map(|r| r.trim_start_matches([' ', '\t', ':']).trim().to_owned())
        })
        .unwrap();
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    };
    let s = |v: &str| serde_json::to_string(v).unwrap();
    let source = format!(
        "{{\"adapter\":{{\"deviceName\":{},\"driverInfo\":{}}},\"cpuModel\":{},\"arch\":{}}}",
        s(adapter["name"].as_str().unwrap()),
        s(adapter["driverInfo"].as_str().unwrap()),
        s(&cpu_model),
        s(arch)
    );
    use sha2::Digest;
    let digest = sha2::Sha256::digest(source.as_bytes());
    digest
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>()[..16]
        .to_owned()
}

/// Compare `hashes` with `tests/goldens/render/<fingerprint>/<scene>.json`;
/// `SIMFORGE_CLI_RECORD_GOLDEN=1` writes it instead. A missing golden is a
/// failure: goldens are per adapter, never universal.
fn check_golden(scene: &str, hashes: &Value) {
    let home = tempfile::tempdir().unwrap();
    let fp = lavapipe_fingerprint(home.path());
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/goldens/render")
        .join(&fp)
        .join(format!("{scene}.json"));
    if std::env::var("SIMFORGE_CLI_RECORD_GOLDEN").as_deref() == Ok("1") {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, serde_json::to_vec_pretty(hashes).unwrap()).unwrap();
        eprintln!("recorded {}", path.display());
        return;
    }
    let golden: Value = serde_json::from_slice(&std::fs::read(&path).unwrap_or_else(|_| {
        panic!("no golden for lavapipe fingerprint {fp} ({}); record with SIMFORGE_CLI_RECORD_GOLDEN=1", path.display())
    }))
    .unwrap();
    assert_eq!(
        hashes,
        &golden,
        "render drifted from the lavapipe golden {}",
        path.display()
    );
}
