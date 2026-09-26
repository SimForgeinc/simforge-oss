//! A real render under a low open-file limit: the release smoke package
//! (Richmond Field Station v5) rendered with RLIMIT_NOFILE soft AND hard at
//! 256, below the files a Richmond render opens in total. It passes only
//! because the renderer bounds the asset files it holds open
//! (render_core::texture_residency::MAX_OPEN_FILES); before that, this render
//! failed with "Too many open files" (os error 24) holding 244 texture
//! objects open. The CLI's startup raise cannot help: the hard limit is 256.
//!
//! `#[ignore]`d like the other lavapipe renders: it needs the installed map
//! release and closures (offline import) and the sky plates:
//!
//! ```sh
//! SIMFORGE_CLI_TEST_MAPS=<cache with richmond-field-station@v5> \
//! SIMFORGE_CLI_TEST_ASSETS=<assets root holding closure 793ec86c> \
//! SIMFORGE_SKY_ASSETS=<dir with the two .skytex plates> \
//!   cargo test -p simforge --test open_files_render -- --ignored
//! ```
#![cfg(unix)]

use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::{json, Value};

const LAVAPIPE_ICD: &str = "/usr/share/vulkan/icd.d/lvp_icd.json";
const LIMIT: libc::rlim_t = 256;

fn env_dir(name: &str) -> PathBuf {
    PathBuf::from(
        std::env::var_os(name).unwrap_or_else(|| panic!("set {name} (see the module docs)")),
    )
}

fn smoke_package() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../fixtures/scenario-package/smoke/richmond-public.scenario.zip")
}

fn simforge(home: &Path, limit: bool) -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_simforge"));
    cmd.env("HOME", home)
        .env("XDG_CACHE_HOME", home.join("cache"))
        .env("XDG_DATA_HOME", home.join("data"))
        .env(
            "SIMFORGE_MAPS_CACHE_ROOT",
            env_dir("SIMFORGE_CLI_TEST_MAPS"),
        )
        .env(
            "SIMFORGE_ACTOR_ASSETS_ROOT",
            env_dir("SIMFORGE_CLI_TEST_ASSETS"),
        )
        .env("SIMFORGE_SKY_ASSETS", env_dir("SIMFORGE_SKY_ASSETS"))
        .env("VK_DRIVER_FILES", LAVAPIPE_ICD)
        .env("VK_ICD_FILENAMES", LAVAPIPE_ICD);
    if limit {
        // SAFETY: only setrlimit (async-signal-safe) runs in the child.
        unsafe {
            cmd.pre_exec(|| {
                let lim = libc::rlimit {
                    rlim_cur: LIMIT,
                    rlim_max: LIMIT,
                };
                if libc::setrlimit(libc::RLIMIT_NOFILE, &lim) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    cmd
}

fn run(cmd: &mut Command) -> (i32, Value, String) {
    let out = cmd.output().unwrap();
    let stdout: Value = serde_json::from_slice(&out.stdout).unwrap_or(Value::Null);
    (
        out.status.code().unwrap_or(-1),
        stdout,
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}

#[test]
#[ignore = "renders on lavapipe with the installed Richmond v5 release and closures (see module docs)"]
fn a_richmond_render_under_an_open_file_limit_of_256_succeeds() {
    assert!(
        Path::new(LAVAPIPE_ICD).exists(),
        "lavapipe is required ({LAVAPIPE_ICD})"
    );
    let home = tempfile::tempdir().unwrap();
    let ws = home.path().join("ws");
    let (code, doc, err) = run(simforge(home.path(), false)
        .args(["package", "import"])
        .arg(smoke_package())
        .arg("--into")
        .arg(&ws)
        .arg("--offline"));
    assert_eq!(code, 0, "import: {err} {doc}");

    // A chase camera on the focus vehicle over the first second (24 frames).
    let rig = home.path().join("chase.rig.json");
    std::fs::write(&rig, serde_json::to_vec(&json!({
        "schema": "simforge.render-rig/v1",
        "sources": [{
            "actorId": "focus-vehicle", "sensorId": "chase", "sensorLabel": "Chase camera",
            "outputName": "focus-vehicle-chase-rgb", "modality": "rgb",
            "transform": { "position": { "x": -9, "y": 3, "z": 0 }, "rotation": { "yawRad": 0, "pitchRad": -0.2, "rollRad": 0 } },
            "attributes": { "width": 320, "height": 180, "fps": 24, "horizontalFovDeg": 58, "nearM": 0.05, "farM": 1000 }
        }],
        "clip": { "startSeconds": 0, "endSeconds": 0.25 },
        "video": { "width": 320, "height": 180, "fps": 24, "container": "mp4", "codec": "h264", "quality": "standard" }
    })).unwrap()).unwrap();

    let out = home.path().join("out");
    let (code, doc, err) = run(simforge(home.path(), true)
        .arg("render")
        .arg(&ws)
        .args(["--preset", "training", "--rig"])
        .arg(&rig)
        .arg("--out")
        .arg(&out)
        .args(["--allow-software-adapter", "--video", "off"]));
    assert!(
        !err.contains("os error 24"),
        "ran out of file handles: {err}"
    );
    assert_eq!(code, 0, "render: {err} {doc}");
    let files = &doc["limits"]["openFiles"];
    assert_eq!(files["hard"], LIMIT as u64, "{files}");
    assert_eq!(files["softAfter"], LIMIT as u64, "{files}");
    assert_eq!(doc["gates"]["parity"]["pass"], true, "{}", doc["gates"]);
}
