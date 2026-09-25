//! The CLI contract, end to end through the built binary: JSON on stdout,
//! structured errors on stderr, exit 0/1/2, `--help` as data, and `doctor`
//! reporting every check without silently degrading.
//!
//! GPU: every test that enumerates adapters pins the Vulkan loader to
//! lavapipe (`VK_ICD_FILENAMES`), so no test ever opens the real GPU.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use serde_json::Value;

const LAVAPIPE_ICD: &str = "/usr/share/vulkan/icd.d/lvp_icd.json";

/// The binary with a scrubbed, hermetic environment: no inherited registry,
/// cache or GPU selection, HOME/XDG inside `home`.
fn simforge(home: &Path) -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_simforge"));
    for var in [
        "SIMFORGE_MAPS_REGISTRY",
        "SIMFORGE_MAPS_PUBLIC_URL",
        "SIMFORGE_MAPS_CACHE_ROOT",
        "SIMFORGE_ACTOR_ASSETS_ROOT",
        "SIMFORGE_FFMPEG_BINARY",
        "SIMFORGE_SKY_ASSETS",
        "SIMFORGE_NATIVE_RUNTIME_ROOT",
        "SIMFORGE_NATIVE_ALLOW_SOFTWARE_ADAPTER",
        "WGPU_BACKEND",
        "WGPU_ADAPTER_NAME",
        "VK_DRIVER_FILES",
        "XDG_DATA_HOME",
    ] {
        cmd.env_remove(var);
    }
    cmd.env("HOME", home).env("VK_ICD_FILENAMES", LAVAPIPE_ICD);
    cmd
}

fn run(cmd: &mut Command) -> (i32, Value, String, Output) {
    let out = cmd.output().expect("run simforge");
    let stdout = String::from_utf8(out.stdout.clone()).expect("utf8 stdout");
    let stderr = String::from_utf8(out.stderr.clone()).expect("utf8 stderr");
    let value = if stdout.trim().is_empty() {
        Value::Null
    } else {
        serde_json::from_str(&stdout)
            .unwrap_or_else(|e| panic!("stdout is not one JSON document ({e}): {stdout}"))
    };
    (out.status.code().expect("exit code"), value, stderr, out)
}

fn stderr_error(stderr: &str) -> Value {
    let line = stderr
        .lines()
        .last()
        .unwrap_or_else(|| panic!("no structured error on stderr"));
    let value: Value =
        serde_json::from_str(line).unwrap_or_else(|e| panic!("stderr is not JSON ({e}): {stderr}"));
    assert!(
        value["code"].is_string() && value["reason"].is_string(),
        "{value}"
    );
    value
}

fn home() -> tempfile::TempDir {
    tempfile::tempdir().expect("tempdir")
}

#[test]
fn bare_invocation_and_help_print_the_surface_as_json() {
    let home = home();
    for args in [&[][..], &["--help"], &["help"], &["-h"]] {
        let (code, doc, stderr, _) = run(simforge(home.path()).args(args));
        assert_eq!(code, 0, "{args:?}: {stderr}");
        assert!(stderr.is_empty(), "{args:?}: {stderr}");
        assert_eq!(doc["bin"], "simforge");
        assert_eq!(
            doc["exitCodes"]["2"]
                .as_str()
                .map(|s| s.starts_with("findings")),
            Some(true)
        );
        let names: Vec<&str> = doc["commands"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["name"].as_str().unwrap())
            .collect();
        for expected in [
            "doctor",
            "maps pull",
            "assets pull",
            "timeline build",
            "render",
            "simulate",
            "env serve",
            "package inspect",
            "package verify",
            "package import",
        ] {
            assert!(
                names.contains(&expected),
                "{expected} missing from {names:?}"
            );
        }
        let doctor = doc["commands"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["name"] == "doctor")
            .unwrap();
        assert_eq!(doctor["status"], "available");
    }
}

#[test]
fn every_command_has_a_json_help_and_a_text_help() {
    let home = home();
    let (_, root, _, _) = run(simforge(home.path()).arg("--help"));
    for entry in root["commands"].as_array().unwrap() {
        let name = entry["name"].as_str().unwrap();
        let words: Vec<&str> = name.split(' ').collect();
        let (code, doc, stderr, _) = run(simforge(home.path()).args(&words).arg("--help"));
        assert_eq!(code, 0, "{name}: {stderr}");
        assert_eq!(doc["command"], name);
        assert!(
            doc["usage"]
                .as_str()
                .unwrap()
                .starts_with(&format!("simforge {name}")),
            "{doc}"
        );
        assert!(doc["flags"].is_array() && doc["arguments"].is_array());
        assert!(
            doc["flags"]
                .as_array()
                .unwrap()
                .iter()
                .all(|f| f["name"] != "--pretty"),
            "--pretty is a global flag"
        );

        let out = simforge(home.path())
            .args(&words)
            .args(["--help", "--pretty"])
            .output()
            .unwrap();
        assert_eq!(out.status.code(), Some(0));
        let text = String::from_utf8(out.stdout).unwrap();
        assert!(text.contains(&format!("Usage: simforge {name}")), "{text}");
    }
    // A group's help lists its commands; positional values do not confuse the lookup.
    let (code, doc, _, _) = run(simforge(home.path()).args(["package", "--help"]));
    assert_eq!(code, 0);
    assert_eq!(doc["commands"].as_array().unwrap().len(), 3);
    let (code, doc, _, _) = run(simforge(home.path()).args(["render", "some/workspace", "--help"]));
    assert_eq!(code, 0);
    assert_eq!(doc["command"], "render");
    let preset = doc["flags"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["name"] == "--preset")
        .unwrap();
    assert_eq!(
        preset["possibleValues"],
        serde_json::json!(["training", "showcase"])
    );
}

#[test]
fn version_is_json() {
    let home = home();
    let (code, doc, _, _) = run(simforge(home.path()).arg("--version"));
    assert_eq!(code, 0);
    assert_eq!(doc["version"], env!("CARGO_PKG_VERSION"));
}

#[test]
fn argument_errors_are_structured_exit_1_with_nothing_on_stdout() {
    let home = home();
    let cases: &[(&[&str], &str, Option<&str>)] = &[
        (&["--limt", "5"], "unknown_flag", Some("--limt")),
        (&["doctor", "--ofline"], "unknown_flag", Some("--ofline")),
        (&["frobnicate"], "unknown_command", Some("frobnicate")),
        (
            &["frobnicate", "--help"],
            "unknown_command",
            Some("frobnicate"),
        ),
        (&["maps", "pul", "x"], "unknown_command", Some("pul")),
        (&["maps"], "missing_command", None),
        (
            &["maps", "pull"],
            "missing_argument",
            Some("<NAME@VERSION>"),
        ),
        (
            &[
                "render", "ws", "--preset", "fast", "--rig", "r.json", "--out", "o",
            ],
            "bad_value",
            Some("--preset"),
        ),
        (
            &["doctor", "--timeout", "soon"],
            "bad_value",
            Some("--timeout"),
        ),
        (
            &["doctor", "--timeout", "0"],
            "bad_value",
            Some("--timeout"),
        ),
    ];
    for (args, code, path) in cases {
        let (exit, stdout, stderr, _) = run(simforge(home.path()).args(*args));
        assert_eq!(exit, 1, "{args:?}: {stderr}");
        assert_eq!(stdout, Value::Null, "{args:?} wrote to stdout");
        let error = stderr_error(&stderr);
        assert_eq!(error["code"], *code, "{args:?}: {error}");
        if let Some(path) = path {
            assert_eq!(error["path"], *path, "{args:?}: {error}");
        }
    }
    let (_, _, stderr, _) = run(simforge(home.path()).args(["maps", "pul", "x"]));
    assert_eq!(stderr_error(&stderr)["detail"]["didYouMean"], "pull");
}

/// The smallest argument list each planned command parses with.
fn minimal_args(command: &str) -> Vec<&'static str> {
    match command {
        "render" => vec![
            "render", "ws", "--preset", "training", "--rig", "rig.json", "--out", "out",
        ],
        "env serve" => vec!["env", "serve", "ws", "--socket", "env.sock"],
        other => panic!("add minimal arguments for the planned command {other:?}"),
    }
}

#[test]
fn planned_commands_fail_loudly() {
    let home = home();
    for command in simforge_cli::commands::PLANNED {
        let (exit, stdout, stderr, _) = run(simforge(home.path()).args(minimal_args(command)));
        assert_eq!(exit, 1, "{command}");
        assert_eq!(stdout, Value::Null, "{command}");
        let error = stderr_error(&stderr);
        assert_eq!(error["code"], "not_implemented", "{command}");
        assert_eq!(error["path"], *command);
        let (_, doc, _, _) = run(simforge(home.path()).args(command.split(' ')).arg("--help"));
        assert_eq!(doc["status"], "planned", "{command}");
    }
}

/// A one-shot HTTP server answering every request with `body` (status 200) or 404.
fn serve(status: u16, body: &'static str) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    std::thread::spawn(move || {
        for stream in listener.incoming().take(4) {
            let mut stream = stream.unwrap();
            let mut buf = [0u8; 4096];
            let _ = stream.read(&mut buf);
            let reason = if status == 200 { "OK" } else { "Not Found" };
            let _ = write!(
                stream,
                "HTTP/1.1 {status} {reason}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
        }
    });
    format!("http://{addr}")
}

fn check<'a>(doc: &'a Value, id: &str) -> &'a Value {
    doc["checks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == id)
        .unwrap_or_else(|| panic!("no {id} check in {doc}"))
}

/// Every check the report must carry, whatever their status.
const CHECK_IDS: &[&str] = &[
    "gpu",
    "ffmpeg",
    "sky",
    "maps-cache",
    "maps-disk",
    "assets-cache",
    "assets-disk",
    "registry",
];

#[test]
fn doctor_offline_reports_the_registry_as_skipped_never_ok() {
    let home = home();
    let (exit, doc, stderr, _) = run(simforge(home.path())
        .args(["doctor", "--offline"])
        .env("SIMFORGE_NATIVE_ALLOW_SOFTWARE_ADAPTER", "1"));
    assert!(exit == 0 || exit == 2, "{stderr}");
    assert_eq!(doc["schema"], "simforge.doctor/v1");
    for id in CHECK_IDS {
        check(&doc, id);
    }
    assert_eq!(check(&doc, "registry")["status"], "skipped");
    assert_eq!(check(&doc, "registry")["detail"]["source"], "default");
    // Roots come from HOME when XDG_DATA_HOME is unset, and say so.
    let maps = check(&doc, "maps-cache");
    assert_eq!(maps["detail"]["source"], "home");
    assert_eq!(
        maps["detail"]["path"],
        home.path()
            .join(".local/share/simforge/maps")
            .to_str()
            .unwrap()
    );
    assert_eq!(maps["status"], "ok", "{maps}");
    assert_eq!(exit, if doc["summary"]["fail"] == 0 { 0 } else { 2 });
}

#[test]
fn doctor_on_lavapipe_warns_with_opt_in_and_fails_without() {
    assert!(
        Path::new(LAVAPIPE_ICD).exists(),
        "lavapipe is required for the render tests ({LAVAPIPE_ICD})"
    );
    let home = home();
    let (_, doc, _, _) = run(simforge(home.path())
        .args(["doctor", "--offline"])
        .env("SIMFORGE_NATIVE_ALLOW_SOFTWARE_ADAPTER", "1"));
    let gpu = check(&doc, "gpu");
    assert_eq!(gpu["status"], "warn", "{gpu}");
    assert_eq!(gpu["detail"]["adapters"][0]["software"], true);

    let (exit, doc, _, _) = run(simforge(home.path()).args(["doctor", "--offline"]));
    let gpu = check(&doc, "gpu");
    assert_eq!(gpu["status"], "fail", "{gpu}");
    assert!(gpu["fix"]
        .as_str()
        .unwrap()
        .contains("SIMFORGE_NATIVE_ALLOW_SOFTWARE_ADAPTER"));
    assert_eq!(exit, 2);
    assert_eq!(doc["ok"], false);
}

#[test]
fn doctor_with_no_adapter_fails_loudly() {
    let home = home();
    let (exit, doc, _, _) = run(simforge(home.path())
        .args(["doctor", "--offline"])
        .env("VK_ICD_FILENAMES", home.path().join("no-such-icd.json")));
    assert_eq!(exit, 2);
    let gpu = check(&doc, "gpu");
    assert_eq!(gpu["status"], "fail", "{gpu}");
    assert_eq!(gpu["detail"]["adapters"], serde_json::json!([]));
}

#[test]
fn doctor_probes_the_registry_and_fails_when_unreachable() {
    let home = home();
    let registry = serve(
        200,
        r#"{"richmond-field-station":{"latest":"v2","versions":["v1","v2"]}}"#,
    );
    let (_, doc, _, _) = run(simforge(home.path()).args(["doctor", "--registry", &registry]));
    let reg = check(&doc, "registry");
    assert_eq!(reg["status"], "ok", "{reg}");
    assert_eq!(
        reg["detail"]["maps"],
        serde_json::json!(["richmond-field-station"])
    );
    assert_eq!(reg["detail"]["source"], "flag:--registry");

    // The environment variable is honoured and reported as the source.
    let (_, doc, _, _) = run(simforge(home.path())
        .arg("doctor")
        .env("SIMFORGE_MAPS_REGISTRY", &registry));
    assert_eq!(
        check(&doc, "registry")["detail"]["source"],
        "env:SIMFORGE_MAPS_REGISTRY"
    );

    let missing = serve(404, "");
    let (exit, doc, _, _) = run(simforge(home.path()).args(["doctor", "--registry", &missing]));
    assert_eq!(check(&doc, "registry")["status"], "fail");
    assert_eq!(exit, 2);

    // Nothing listens on port 9 of localhost: unreachable, not ok, not skipped.
    let (exit, doc, _, _) = run(simforge(home.path()).args([
        "doctor",
        "--registry",
        "http://127.0.0.1:9",
        "--timeout",
        "2",
    ]));
    assert_eq!(check(&doc, "registry")["status"], "fail");
    assert_eq!(exit, 2);

    // A file:// registry is read from disk.
    let local = home.path().join("registry");
    std::fs::create_dir_all(&local).unwrap();
    std::fs::write(local.join("index.json"), "{}").unwrap();
    let (_, doc, _, _) = run(simforge(home.path()).args([
        "doctor",
        "--registry",
        &format!("file://{}", local.display()),
    ]));
    assert_eq!(check(&doc, "registry")["status"], "ok");
}

#[test]
fn doctor_reports_unwritable_and_misplaced_roots() {
    let home = home();
    let file_root: PathBuf = home.path().join("not-a-dir");
    std::fs::write(&file_root, "x").unwrap();
    let (exit, doc, _, _) = run(simforge(home.path())
        .args(["doctor", "--offline"])
        .env("SIMFORGE_MAPS_CACHE_ROOT", &file_root)
        .env("SIMFORGE_NATIVE_ALLOW_SOFTWARE_ADAPTER", "1"));
    let maps = check(&doc, "maps-cache");
    assert_eq!(maps["status"], "fail", "{maps}");
    assert_eq!(maps["detail"]["source"], "env:SIMFORGE_MAPS_CACHE_ROOT");
    assert_eq!(check(&doc, "maps-disk")["status"], "skipped");
    assert_eq!(exit, 2);

    // XDG_DATA_HOME wins over HOME for the default roots.
    let xdg = home.path().join("xdg");
    std::fs::create_dir_all(&xdg).unwrap();
    let (_, doc, _, _) = run(simforge(home.path())
        .args(["doctor", "--offline"])
        .env("XDG_DATA_HOME", &xdg));
    let assets = check(&doc, "assets-cache");
    assert_eq!(assets["detail"]["source"], "xdg");
    assert_eq!(
        assets["detail"]["path"],
        xdg.join("simforge/actor-assets").to_str().unwrap()
    );
}

#[test]
fn doctor_reports_a_broken_explicit_ffmpeg_as_a_failure() {
    let home = home();
    let (exit, doc, _, _) = run(simforge(home.path())
        .args(["doctor", "--offline"])
        .env("SIMFORGE_FFMPEG_BINARY", home.path().join("no-ffmpeg")));
    let ffmpeg = check(&doc, "ffmpeg");
    assert_eq!(ffmpeg["status"], "fail", "{ffmpeg}");
    assert_eq!(ffmpeg["detail"]["source"], "env:SIMFORGE_FFMPEG_BINARY");
    assert_eq!(exit, 2);

    // No ffmpeg anywhere: a warning (renders record the video as skipped), not a pass.
    let (_, doc, _, _) = run(simforge(home.path())
        .args(["doctor", "--offline"])
        .env("PATH", home.path()));
    assert_eq!(check(&doc, "ffmpeg")["status"], "warn");
}

#[test]
fn pretty_is_the_same_document_indented() {
    let home = home();
    let compact = simforge(home.path())
        .arg("--version")
        .output()
        .unwrap()
        .stdout;
    let pretty = simforge(home.path())
        .args(["--version", "--pretty"])
        .output()
        .unwrap()
        .stdout;
    let compact: Value = serde_json::from_slice(&compact).unwrap();
    let pretty_text = String::from_utf8(pretty).unwrap();
    assert!(pretty_text.contains("\n  \""), "{pretty_text}");
    assert_eq!(
        serde_json::from_str::<Value>(&pretty_text).unwrap(),
        compact
    );
}

#[test]
fn doctor_reports_missing_sky_plates_as_a_failure() {
    let home = home();
    let (exit, doc, _, _) = run(simforge(home.path())
        .args(["doctor", "--offline"])
        .env("SIMFORGE_SKY_ASSETS", home.path().join("no-sky")));
    let sky = check(&doc, "sky");
    assert_eq!(sky["status"], "fail", "{sky}");
    assert!(sky["fix"].as_str().unwrap().contains("SIMFORGE_SKY_ASSETS"));
    assert_eq!(exit, 2);
}
