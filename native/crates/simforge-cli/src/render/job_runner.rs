//! Run one `simforge.render-job/v2` in process, through render_service's
//! job path (`simforge-render job`: `load_scene_state`, then one
//! `render_bundle` per tick, exactly the request path the render service
//! serves).
//!
//! The renderer reports progress and diagnostics on stderr (adapter,
//! config, per-tick timings). The CLI contract keeps stderr for the one
//! structured error, so the renderer's stderr is captured into
//! `<out>/render.log` for the duration of the job and restored afterwards.
//! The log path is part of the result, so nothing it says is lost.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::contract::CliError;

/// The renderer's `results.json` (`simforge.render-job-results/v2`) and
/// where its diagnostics went.
pub struct JobOutput {
    pub results: Value,
    pub results_path: PathBuf,
    pub log_path: PathBuf,
}

/// Redirect this process's stderr (fd 2) into `log` until dropped.
#[cfg(unix)]
struct StderrCapture {
    saved: i32,
}

#[cfg(unix)]
impl StderrCapture {
    fn start(log: &Path) -> std::io::Result<Self> {
        use std::io::Write;
        use std::os::fd::AsRawFd;
        let file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log)?;
        let _ = std::io::stderr().flush();
        // SAFETY: plain descriptor duplication; `saved` is restored on drop.
        let saved = unsafe { libc::dup(2) };
        if saved < 0 {
            return Err(std::io::Error::last_os_error());
        }
        if unsafe { libc::dup2(file.as_raw_fd(), 2) } < 0 {
            let error = std::io::Error::last_os_error();
            unsafe { libc::close(saved) };
            return Err(error);
        }
        Ok(Self { saved })
    }
}

#[cfg(unix)]
impl Drop for StderrCapture {
    fn drop(&mut self) {
        use std::io::Write;
        let _ = std::io::stderr().flush();
        // SAFETY: restores the descriptor saved in `start`.
        unsafe {
            libc::dup2(self.saved, 2);
            libc::close(self.saved);
        }
    }
}

/// On Windows the renderer's diagnostics stay on stderr (documented gap).
#[cfg(not(unix))]
struct StderrCapture;

#[cfg(not(unix))]
impl StderrCapture {
    fn start(_log: &Path) -> std::io::Result<Self> {
        Ok(Self)
    }
}

/// Run `job` (a `simforge.render-job/v2` file whose `outDir` is `out_dir`;
/// its scene names the preset) with dotted `--set` overrides.
pub fn run_job(job: &Path, out_dir: &Path, sets: &[String]) -> Result<JobOutput, CliError> {
    let results_path = out_dir.join("results.json");
    let log_path = out_dir.join("render.log");
    let mut argv = vec!["--job".to_owned(), job.display().to_string()];
    for set in sets {
        argv.push("--set".to_owned());
        argv.push(set.clone());
    }
    let capture = StderrCapture::start(&log_path).map_err(|e| {
        CliError::new(
            "write_failed",
            format!("cannot open {}: {e}", log_path.display()),
        )
    })?;
    // A panic inside the renderer must not unwind through the restored-stderr
    // guard silently: catch it and report it as a render failure.
    let outcome = std::panic::catch_unwind(|| render_service::cli::job::run(argv));
    drop(capture);
    let tail = log_tail(&log_path, 40);
    match outcome {
        Ok(Ok(())) => {}
        Ok(Err(error)) => {
            return Err(CliError::new("render_failed", format!("{error:#}"))
                .with_detail(json!({ "log": log_path, "logTail": tail })));
        }
        Err(panic) => {
            let message = panic
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| panic.downcast_ref::<&str>().map(|s| (*s).to_owned()))
                .unwrap_or_else(|| "the renderer panicked".to_owned());
            return Err(CliError::new("render_failed", message)
                .with_detail(json!({ "log": log_path, "logTail": tail })));
        }
    }
    let bytes = std::fs::read(&results_path).map_err(|e| {
        CliError::new(
            "render_failed",
            format!("the renderer wrote no {}: {e}", results_path.display()),
        )
        .with_detail(json!({ "log": log_path, "logTail": tail }))
    })?;
    let results: Value = serde_json::from_slice(&bytes).map_err(|e| {
        CliError::new(
            "render_failed",
            format!("{} is not JSON: {e}", results_path.display()),
        )
    })?;
    Ok(JobOutput {
        results,
        results_path,
        log_path,
    })
}

/// The last `lines` lines of the renderer log, for error details.
pub fn log_tail(path: &Path, lines: usize) -> Vec<String> {
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let all: Vec<&str> = text.lines().collect();
    all[all.len().saturating_sub(lines)..]
        .iter()
        .map(|s| (*s).to_owned())
        .collect()
}
