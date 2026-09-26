//! The CLI raises its soft open-file limit to the hard limit at startup and
//! reports both values (`simforge doctor`, check `open-files`).
#![cfg(unix)]

use std::os::unix::process::CommandExt;
use std::process::Command;

use serde_json::Value;

/// `simforge doctor --offline` in a child whose RLIMIT_NOFILE starts at
/// (`soft`, `hard`); returns the `open-files` check.
fn doctor_open_files(soft: u64, hard: Option<u64>) -> Value {
    let home = tempfile::tempdir().unwrap();
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_simforge"));
    cmd.args(["doctor", "--offline"])
        .env("HOME", home.path())
        .env("XDG_CACHE_HOME", home.path().join("cache"))
        .env("XDG_DATA_HOME", home.path().join("data"));
    // SAFETY: only async-signal-safe calls (getrlimit/setrlimit) in the child.
    unsafe {
        cmd.pre_exec(move || {
            let mut lim = libc::rlimit {
                rlim_cur: 0,
                rlim_max: 0,
            };
            libc::getrlimit(libc::RLIMIT_NOFILE, &mut lim);
            lim.rlim_cur = soft as libc::rlim_t;
            if let Some(h) = hard {
                lim.rlim_max = h as libc::rlim_t;
            }
            if libc::setrlimit(libc::RLIMIT_NOFILE, &lim) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let out = cmd.output().unwrap();
    let doc: Value = serde_json::from_slice(&out.stdout).unwrap_or_else(|e| {
        panic!(
            "doctor printed no JSON ({e}): {}",
            String::from_utf8_lossy(&out.stderr)
        )
    });
    doc["checks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == "open-files")
        .cloned()
        .expect("doctor has an open-files check")
}

#[test]
fn startup_raises_the_soft_limit_to_the_hard_limit_and_reports_it() {
    let check = doctor_open_files(256, None);
    let d = &check["detail"];
    assert_eq!(d["softBefore"], 256, "{check}");
    assert_eq!(d["softAfter"], d["hard"], "{check}");
    assert_eq!(d["error"], Value::Null, "{check}");
    if d["hard"].as_u64().unwrap() > 256 {
        assert_eq!(d["raised"], true, "{check}");
    }
}

#[test]
fn a_hard_limit_it_cannot_exceed_is_reported_not_hidden() {
    let check = doctor_open_files(256, Some(256));
    let d = &check["detail"];
    assert_eq!(d["softBefore"], 256, "{check}");
    assert_eq!(d["softAfter"], 256, "{check}");
    assert_eq!(d["hard"], 256, "{check}");
    assert_eq!(d["raised"], false, "{check}");
    assert_eq!(check["status"], "warn", "{check}");
    assert!(
        check["fix"].as_str().unwrap().contains("LimitNOFILE"),
        "{check}"
    );
}
