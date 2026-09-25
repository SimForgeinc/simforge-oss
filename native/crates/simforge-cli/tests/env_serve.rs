//! `simforge env serve` (`simforge.env-serve/v1`), end to end through the
//! built binary and its Unix socket.
//!
//! The workspace is built from the golden-trace corpus (`rfs-uturn-car` on
//! the committed Richmond Field Station world), the way `package import`
//! lays one out: the resolution records the input the engine resolved.
//! Parity: the socket's observations equal an in-process
//! `simforge_bindings_common::runtime::Env` (the Python `_native` session's
//! glue) byte for byte for the same seed and actions.
//!
//! `lavapipe_*` renders on Mesa lavapipe (never the GPU) and is `#[ignore]`d:
//! it needs the installed public map and actor closure (see tests/render.rs):
//!
//! ```sh
//! SIMFORGE_CLI_TEST_MAPS=~/.local/share/simforge/maps \
//! SIMFORGE_CLI_TEST_ASSETS=<simforge assets pull root> \
//! SIMFORGE_SKY_ASSETS=<dir with the two .skytex plates> \
//!   cargo test -p simforge --test env_serve -- --ignored
//! ```

use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdout, Command, Stdio};

use serde_json::{json, Value};
use simforge_bindings_common::runtime::{Env, MapAsset, Scenario};
use simforge_cli::env_serve::wire;

const LAVAPIPE_ICD: &str = "/usr/share/vulkan/icd.d/lvp_icd.json";
const ACTOR_CLOSURE: &str = "218209f5109d8a25d9967de1cca4b202555dc12f53289463aa40a6812d79854f";
const XODR: &str = "5b08367524edbc0c46cfb2f4cd77ef6a204f263bb14cf7e8f90a1fffde1c14d6";

fn oss() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

fn golden_map() -> PathBuf {
    oss().join("fixtures/golden-traces/maps/richmond-field-station")
}

fn gunzip(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    flate2::read::GzDecoder::new(bytes)
        .read_to_end(&mut out)
        .unwrap();
    out
}

fn gzip(bytes: &[u8]) -> Vec<u8> {
    let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    e.write_all(bytes).unwrap();
    e.finish().unwrap()
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

/// The committed golden world with `map.xodr` also plain; `grounded` keeps
/// its ground derivative (the public release has none, so a rendered
/// episode on the installed public map needs the ungrounded world).
fn world(dir: &Path, grounded: bool) -> PathBuf {
    let world = dir
        .join(if grounded { "grounded" } else { "ungrounded" })
        .join("richmond-field-station");
    for entry in walk(&golden_map()) {
        let rel = entry.strip_prefix(golden_map()).unwrap();
        if !grounded && rel.starts_with("derived/ground") {
            continue;
        }
        let target = world.join(rel);
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::copy(&entry, &target).unwrap();
    }
    std::fs::write(
        world.join("map.xodr"),
        gunzip(&std::fs::read(golden_map().join("map.xodr.gz")).unwrap()),
    )
    .unwrap();
    world
}

/// The input the engine resolves the golden case to (what a host records).
fn resolved_input(world: &Path) -> Value {
    let path = oss().join("fixtures/golden-traces/inputs/rfs-uturn-car.input.json");
    let mut authored: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    // An episode acts on its metric subject (the ego); the golden case names none.
    authored["metricSubject"] = json!("ego");
    let world = simforge_cli::commands::simulate::load_world(world).unwrap();
    let input = simforge_core::types::parse_scenario_input_value(&authored)
        .unwrap()
        .normalized();
    let result = simforge_core::engine::run_simulation(input, world.options).unwrap();
    serde_json::to_value(&result.input).unwrap()
}

fn workspace(dir: &Path, input: &Value) -> PathBuf {
    let ws = dir.join("ws");
    std::fs::create_dir_all(ws.join("simulation")).unwrap();
    let digest = simforge_core::hash::content_hash(input).unwrap();
    let resolution = json!({
        "contract": "simforge.sim-resolution/v1",
        "simKey": "0".repeat(64),
        "resolvedInputDigest": digest,
        "resolvedInput": input,
        "trafficProvider": "native",
    });
    std::fs::write(
        ws.join("simulation/resolution.json.gz"),
        gzip(&serde_json::to_vec(&resolution).unwrap()),
    )
    .unwrap();
    std::fs::write(
        ws.join("document.json"),
        serde_json::to_vec(&json!({ "scenarioVersion": 2, "environment": { "weather": "clear", "timeOfDay": "noon" } })).unwrap(),
    )
    .unwrap();
    let manifest = json!({
        "schema": "simforge.scenario-package/v1",
        "simulation": { "traceSha256": "0".repeat(64), "resolvedInputDigest": digest },
        "map": { "xodrSha256": XODR, "sourceMapId": "richmond-field-station" },
        "timelines": [],
        "catalog": { "actorClosureDigest": ACTOR_CLOSURE },
    });
    std::fs::write(
        ws.join("manifest.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    ws
}

struct Fixture {
    _home: tempfile::TempDir,
    home: PathBuf,
    world: PathBuf,
    ws: PathBuf,
    input: Value,
}

fn fixture(grounded: bool) -> Fixture {
    let home = tempfile::tempdir().unwrap();
    let dir = home.path().to_path_buf();
    let world = world(&dir, grounded);
    let input = resolved_input(&world);
    let ws = workspace(&dir, &input);
    Fixture {
        _home: home,
        home: dir,
        world,
        ws,
        input,
    }
}

fn simforge(home: &Path) -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_simforge"));
    for var in [
        "SIMFORGE_MAPS_CACHE_ROOT",
        "SIMFORGE_ACTOR_ASSETS_ROOT",
        "XDG_DATA_HOME",
        "SIMFORGE_NATIVE_ALLOW_SOFTWARE_ADAPTER",
    ] {
        cmd.env_remove(var);
    }
    cmd.env("HOME", home).env("VK_ICD_FILENAMES", LAVAPIPE_ICD);
    cmd
}

struct Served {
    child: Child,
    ready: Value,
    socket: PathBuf,
    _stdout: BufReader<ChildStdout>,
}

impl Drop for Served {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn start(cmd: &mut Command, socket: &Path) -> Served {
    let mut child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let mut line = String::new();
    stdout.read_line(&mut line).unwrap();
    if line.is_empty() {
        let mut err = String::new();
        child
            .stderr
            .take()
            .unwrap()
            .read_to_string(&mut err)
            .unwrap();
        panic!("env serve exited before listening: {err}");
    }
    let ready: Value = serde_json::from_str(&line)
        .unwrap_or_else(|e| panic!("ready line is not JSON ({e}): {line}"));
    Served {
        child,
        ready,
        socket: socket.to_path_buf(),
        _stdout: stdout,
    }
}

fn serve_no_sensors(f: &Fixture, socket: &Path) -> Served {
    start(
        simforge(&f.home)
            .args(["env", "serve"])
            .arg(&f.ws)
            .arg("--socket")
            .arg(socket)
            .arg("--no-sensors")
            .arg("--map-dir")
            .arg(&f.world),
        socket,
    )
}

struct Client {
    stream: UnixStream,
    i: u64,
}

impl Client {
    fn connect(socket: &Path) -> Self {
        Self {
            stream: UnixStream::connect(socket).unwrap(),
            i: 0,
        }
    }

    fn call_with(&mut self, mut header: Value, tail: &[u8]) -> wire::Message {
        self.i += 1;
        header["i"] = json!(self.i);
        wire::write_message(&mut self.stream, &header, tail).unwrap();
        let message = wire::read_message(&mut self.stream)
            .unwrap()
            .expect("a response");
        assert_eq!(message.header["i"], json!(self.i));
        message
    }

    fn call(&mut self, header: Value) -> wire::Message {
        self.call_with(header, &[])
    }
}

fn f64s(message: &wire::Message, reference: &Value) -> Vec<f64> {
    assert_eq!(reference["dtype"], "<f8");
    wire::slice(&message.tail, reference)
        .unwrap()
        .chunks_exact(8)
        .map(|c| f64::from_le_bytes(c.try_into().unwrap()))
        .collect()
}

fn f32s(message: &wire::Message, reference: &Value) -> Vec<f32> {
    assert_eq!(reference["dtype"], "<f4");
    wire::slice(&message.tail, reference)
        .unwrap()
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes(c.try_into().unwrap()))
        .collect()
}

/// A setpoint action row: target speed / acceleration, the rest unset (NaN).
fn setpoint(speed: f64, accel: f64) -> Vec<f64> {
    let fields = simforge_bindings_common::action::ACTION_FIELD_NAMES;
    let mut row = vec![f64::NAN; fields.len()];
    row[fields
        .iter()
        .position(|f| *f == "target_speed_mps")
        .unwrap()] = speed;
    row[fields
        .iter()
        .position(|f| *f == "target_acceleration_mps2")
        .unwrap()] = accel;
    row
}

fn wire_row(row: &[f64]) -> Value {
    json!(row
        .iter()
        .map(|v| if v.is_nan() { Value::Null } else { json!(v) })
        .collect::<Vec<_>>())
}

#[test]
fn episodes_over_the_socket_equal_the_native_session() {
    let f = fixture(true);
    let socket = f.home.join("env.sock");
    let served = serve_no_sensors(&f, &socket);
    assert_eq!(served.ready["schema"], "simforge.env-serve-ready/v1");
    assert_eq!(served.ready["protocol"], "simforge.env-serve/v1");
    assert_eq!(served.ready["socket"], json!(socket));
    assert_eq!(served.ready["sensors"], false);
    assert_eq!(served.ready["pid"], json!(served.child.id()));

    // The same episode in process, through the Python binding's glue.
    let asset = MapAsset::load(&f.world).unwrap();
    let scenario = Scenario::parse(f.input.to_string().as_bytes()).unwrap();
    let mut native = Env::new(
        &scenario,
        asset.graph(),
        None,
        simforge_bindings_common::DEFAULT_MAX_OBJECTS,
    )
    .unwrap();

    let mut client = Client::connect(&socket);
    let hello = client.call(json!({ "op": "hello" }));
    assert_eq!(hello.header["ok"], true, "{}", hello.header);
    assert_eq!(hello.header["ego"], native.ego());
    assert_eq!(
        hello.header["actionWidth"],
        simforge_bindings_common::action::ACTION_WIDTH
    );
    assert_eq!(hello.header["decisionHz"], native.decision_hz());
    assert_eq!(hello.header["sensors"], json!([]));

    // Stepping before a reset is refused, and the connection stays usable.
    let early = client.call(json!({ "op": "step", "action": null }));
    assert_eq!(early.header["ok"], false);
    assert_eq!(early.header["code"], "episode_not_reset");

    let reset = client.call(json!({ "op": "reset", "seed": 7 }));
    assert_eq!(reset.header["ok"], true, "{}", reset.header);
    let view = native
        .reset(Some(simforge_core::rng::Seed::Number(7.0)))
        .unwrap();
    assert_eq!(
        f64s(&reset, &reset.header["observation"]["state_vector"]),
        view.state_vector()
    );
    assert_eq!(
        f32s(&reset, &reset.header["observation"]["objects"]),
        view.objects()
    );
    assert_eq!(reset.header["info"]["ego"], native.ego());

    let mut checkpoint = None;
    for step in 0..12 {
        let row = if step % 3 == 0 {
            None
        } else {
            Some(setpoint(6.0 + step as f64, 0.5))
        };
        let response = client.call(json!({ "op": "step", "action": row.as_deref().map(wire_row) }));
        assert_eq!(response.header["ok"], true, "{}", response.header);
        let view = native.step(row.as_deref()).unwrap();
        assert_eq!(
            f64s(&response, &response.header["observation"]["state_vector"]),
            view.state_vector(),
            "step {step}"
        );
        assert_eq!(
            f32s(&response, &response.header["observation"]["objects"]),
            view.objects(),
            "step {step}"
        );
        assert_eq!(response.header["reward"], json!(view.reward()));
        assert_eq!(response.header["terminated"], view.terminated());
        assert_eq!(response.header["truncated"], view.truncated());
        let info: Value = serde_json::from_str(&view.info_json().unwrap()).unwrap();
        assert_eq!(
            response.header["info"]["events"], info["events"],
            "step {step}"
        );
        if step == 5 {
            let saved = client.call(json!({ "op": "checkpoint" }));
            assert_eq!(saved.header["ok"], true);
            checkpoint = Some(
                wire::slice(&saved.tail, &saved.header["checkpoint"])
                    .unwrap()
                    .to_vec(),
            );
            assert_eq!(
                checkpoint.as_deref(),
                Some(native.checkpoint().unwrap().as_slice())
            );
        }
    }
    // observe repeats the current observation without stepping.
    let observed = client.call(json!({ "op": "observe" }));
    assert_eq!(
        f64s(&observed, &observed.header["observation"]["state_vector"]),
        native.view().state_vector()
    );

    // restore returns to the checkpointed decision; stepping continues identically.
    let bytes = checkpoint.unwrap();
    let mut tail = wire::Tail::default();
    let reference = tail.raw(&bytes);
    let restored = client.call_with(
        json!({ "op": "restore", "checkpoint": reference }),
        &tail.bytes,
    );
    assert_eq!(restored.header["ok"], true, "{}", restored.header);
    let view = native.restore(&bytes).unwrap();
    assert_eq!(
        f64s(&restored, &restored.header["observation"]["state_vector"]),
        view.state_vector()
    );

    // Errors are structured and recoverable.
    let bad = client.call(json!({ "op": "step", "action": [1.0, 2.0] }));
    assert_eq!(
        (bad.header["ok"].clone(), bad.header["code"].clone()),
        (json!(false), json!("episode_error")),
        "{}",
        bad.header
    );
    let unknown = client.call(json!({ "op": "frobnicate" }));
    assert_eq!(unknown.header["code"], "unknown_op");
    let bad_seed = client.call(json!({ "op": "reset", "seed": [1] }));
    assert_eq!(bad_seed.header["code"], "bad_value");

    let closed = client.call(json!({ "op": "close" }));
    assert_eq!(closed.header["ok"], true);
    let mut served = served;
    let status = served.child.wait().unwrap();
    assert_eq!(status.code(), Some(0));
    assert!(!served.socket.exists(), "the socket is removed on close");
}

#[test]
fn a_live_socket_is_refused_and_signals_clean_up() {
    let f = fixture(true);
    let socket = f.home.join("env.sock");
    let mut served = serve_no_sensors(&f, &socket);

    // A second server on the live socket refuses to start.
    let out = simforge(&f.home)
        .args(["env", "serve"])
        .arg(&f.ws)
        .arg("--socket")
        .arg(&socket)
        .arg("--no-sensors")
        .arg("--map-dir")
        .arg(&f.world)
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
    let err: Value =
        serde_json::from_slice(out.stderr.split(|b| *b == b'\n').next().unwrap()).unwrap();
    assert_eq!(err["code"], "socket_in_use");
    assert!(out.stdout.is_empty());

    // SIGTERM: exit 0, socket removed.
    unsafe { libc::kill(served.child.id() as i32, libc::SIGTERM) };
    assert_eq!(served.child.wait().unwrap().code(), Some(0));
    assert!(!socket.exists());

    // A stale socket file (no listener) is replaced.
    std::fs::write(&socket, b"").unwrap();
    let served = serve_no_sensors(&f, &socket);
    let mut client = Client::connect(&served.socket);
    assert_eq!(client.call(json!({ "op": "hello" })).header["ok"], true);
}

#[test]
fn startup_refusals_are_structured() {
    let f = fixture(true);
    let socket = f.home.join("env.sock");
    let run = |extra: &[&str]| {
        simforge(&f.home)
            .args(["env", "serve"])
            .arg(&f.ws)
            .arg("--socket")
            .arg(&socket)
            .args(extra)
            .output()
            .unwrap()
    };
    let error = |out: &std::process::Output| -> Value {
        serde_json::from_slice(out.stderr.split(|b| *b == b'\n').next().unwrap()).unwrap()
    };
    // Sensors are a choice, never a silent default.
    let out = run(&[]);
    assert_eq!(
        (out.status.code(), error(&out)["code"].clone()),
        (Some(1), json!("missing_argument"))
    );
    let out = run(&["--no-sensors", "--rig", "r.json"]);
    assert_eq!(error(&out)["code"], "conflicting_arguments");
    // No installed map: named, never substituted.
    let out = run(&["--no-sensors"]);
    assert_eq!(
        (out.status.code(), error(&out)["code"].clone()),
        (Some(1), json!("map_not_installed"))
    );
    // A tampered resolution is refused.
    let path = f.ws.join("simulation/resolution.json.gz");
    let mut resolution: Value =
        serde_json::from_slice(&gunzip(&std::fs::read(&path).unwrap())).unwrap();
    resolution["resolvedInputDigest"] = json!("f".repeat(64));
    std::fs::write(&path, gzip(&serde_json::to_vec(&resolution).unwrap())).unwrap();
    let out = run(&["--no-sensors", "--map-dir", f.world.to_str().unwrap()]);
    assert_eq!(
        (out.status.code(), error(&out)["code"].clone()),
        (Some(2), json!("resolution_invalid"))
    );
    assert!(!socket.exists());
}

fn env_dir(name: &str) -> PathBuf {
    PathBuf::from(
        std::env::var_os(name).unwrap_or_else(|| panic!("set {name} (see the module docs)")),
    )
}

#[test]
#[ignore = "renders on lavapipe with the installed richmond map and actor closure (see module docs)"]
fn lavapipe_rendered_episodes_are_deterministic() {
    assert!(
        Path::new(LAVAPIPE_ICD).exists(),
        "lavapipe is required ({LAVAPIPE_ICD})"
    );
    let f = fixture(false);
    let rig = f.home.join("rig.json");
    std::fs::write(
        &rig,
        serde_json::to_vec(&json!({
            "schema": "simforge.render-rig/v1",
            "sources": [{
                "actorId": "ego", "sensorId": "front-camera", "sensorLabel": "Front camera",
                "outputName": "ego-front-camera-rgb", "modality": "rgb",
                "transform": { "position": { "x": 1.6, "y": 1.45, "z": 0 }, "rotation": { "yawRad": 0, "pitchRad": 0, "rollRad": 0 } },
                "attributes": { "width": 320, "height": 180, "fps": 10, "horizontalFovDeg": 90, "nearM": 0.05, "farM": 1000 },
            }],
        }))
        .unwrap(),
    )
    .unwrap();
    let socket = f.home.join("env.sock");
    let served = start(
        simforge(&f.home)
            .args(["env", "serve"])
            .arg(&f.ws)
            .arg("--socket")
            .arg(&socket)
            .arg("--rig")
            .arg(&rig)
            .args([
                "--passes",
                "rgb,depth",
                "--allow-software-adapter",
                "--decision-hz",
                "10",
            ])
            .env(
                "SIMFORGE_MAPS_CACHE_ROOT",
                env_dir("SIMFORGE_CLI_TEST_MAPS"),
            )
            .env(
                "SIMFORGE_ACTOR_ASSETS_ROOT",
                env_dir("SIMFORGE_CLI_TEST_ASSETS"),
            )
            .env("SIMFORGE_SKY_ASSETS", env_dir("SIMFORGE_SKY_ASSETS")),
        &socket,
    );
    assert_eq!(served.ready["sensors"], true);
    let mut client = Client::connect(&socket);
    let hello = client.call(json!({ "op": "hello" }));
    assert_eq!(
        hello.header["sensors"][0]["sourceId"],
        "ego-front-camera-rgb"
    );

    let episode = |client: &mut Client| -> (Vec<Vec<u8>>, Vec<f64>) {
        let mut frames = Vec::new();
        let mut times = Vec::new();
        let reset = client.call(json!({ "op": "reset", "seed": 3 }));
        assert_eq!(reset.header["ok"], true, "{}", reset.header);
        let mut take = |m: &wire::Message| {
            let rgb = &m.header["sensors"]["ego-front-camera-rgb"]["rgb"];
            assert_eq!(rgb["shape"], json!([180, 320, 4]), "{}", m.header);
            assert_eq!(
                m.header["sensors"]["ego-front-camera-rgb"]["depth"]["dtype"],
                "<f4"
            );
            frames.push(wire::slice(&m.tail, rgb).unwrap().to_vec());
            times.push(m.header["renderMs"].as_f64().unwrap());
        };
        take(&reset);
        for _ in 0..5 {
            let step = client.call(json!({ "op": "step", "action": null }));
            assert_eq!(step.header["ok"], true, "{}", step.header);
            take(&step);
        }
        (frames, times)
    };
    let (a, times) = episode(&mut client);
    let (b, _) = episode(&mut client);
    assert_eq!(a, b, "a reset with the same seed renders the same frames");
    assert_ne!(a[0], a[5], "the ego moves");
    eprintln!("lavapipe per-observation render ms: {times:?}");
    client.call(json!({ "op": "close" }));
}

/// The Python socket client (adapters/gym/tests/test_socket_env.py) against
/// this binary and a fixture workspace. Needs `uv` (gymnasium, numpy and
/// pytest are resolved into an ephemeral environment).
#[test]
#[ignore = "runs the Python socket-client suite through uv"]
fn python_socket_client_suite() {
    let f = fixture(true);
    let gym = oss().join("adapters/gym");
    let status = Command::new("uv")
        .args([
            "run",
            "--no-project",
            "--with",
            "gymnasium>=1.1",
            "--with",
            "numpy>=1.24",
            "--with",
            "pytest",
            "--",
            "python",
            "-m",
            "pytest",
            "-q",
        ])
        .arg(gym.join("tests/test_socket_env.py"))
        .current_dir(&gym)
        .env("PYTHONPATH", &gym)
        .env("SIMFORGE_BIN", env!("CARGO_BIN_EXE_simforge"))
        .env("SIMFORGE_ENV_TEST_WORKSPACE", &f.ws)
        .env("SIMFORGE_ENV_TEST_MAP_DIR", &f.world)
        .env("HOME", &f.home)
        .status()
        .unwrap();
    assert!(status.success());
}
