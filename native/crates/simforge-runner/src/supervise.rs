//! Detached execution. `job start --detach` re-executes this binary as
//! `job run <jobId>` detached from the launcher ([`platform::detach_command`]:
//! a new session via `setsid` on Unix, a new process group without a console
//! window on Windows) with stdio redirected to the job's log directory. The
//! child is therefore immune to the launching UI or terminal exiting, and its
//! liveness is visible to everyone through the owner lock, not through the
//! parent.

use std::fs::OpenOptions;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::error::{Result, RunnerError};
use crate::fsatomic::ensure_dir;
use crate::platform;
use crate::runtime::{VerifiedRuntime, RUNTIME_MANIFEST_ENV};
use crate::state::{JobDir, JobStatus};

const OWNERSHIP_TIMEOUT: Duration = Duration::from_secs(15);
const OWNERSHIP_POLL: Duration = Duration::from_millis(50);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetachReport {
    pub pid: u32,
    pub stdout_log: String,
    pub stderr_log: String,
}

/// Spawns the supervised child and waits until it owns the job (or exits
/// early, in which case its stderr is surfaced).
pub fn spawn_detached(
    root: &Path,
    runtime: &VerifiedRuntime,
    dir: &JobDir,
    restart: bool,
) -> Result<DetachReport> {
    let executable = crate::runtime::current_executable()?;
    let logs = dir.logs_dir();
    ensure_dir(&logs)?;
    let stdout_path = logs.join("stdout.log");
    let stderr_path = logs.join("stderr.log");
    let stdout = OpenOptions::new()
        .append(true)
        .create(true)
        .open(&stdout_path)
        .map_err(|source| RunnerError::io(&stdout_path, source))?;
    let stderr = OpenOptions::new()
        .append(true)
        .create(true)
        .open(&stderr_path)
        .map_err(|source| RunnerError::io(&stderr_path, source))?;

    let mut command = Command::new(&executable);
    command
        .arg("--root")
        .arg(root)
        .arg("job")
        .arg("run")
        .arg(&dir.job_id)
        .env(RUNTIME_MANIFEST_ENV, &runtime.manifest_path)
        .stdin(Stdio::null())
        .stdout(stdout)
        .stderr(stderr);
    if restart {
        command.arg("--restart");
    }
    platform::detach_command(&mut command);
    let mut child = command.spawn().map_err(|source| RunnerError::Supervisor {
        reason: format!("spawn {}: {source}", executable.display()),
    })?;
    let pid = child.id();

    let deadline = Instant::now() + OWNERSHIP_TIMEOUT;
    loop {
        if let Some(status) = child.try_wait().map_err(|source| RunnerError::Supervisor {
            reason: format!("wait for pid {pid}: {source}"),
        })? {
            // A child that exits this quickly either finished a trivial job or
            // refused it; the persisted state distinguishes the two.
            let state = dir.load_state()?;
            if state.status.is_terminal() && state.status != JobStatus::Failed {
                break;
            }
            let stderr_tail = std::fs::read_to_string(&stderr_path).unwrap_or_default();
            let last_line = stderr_tail
                .lines()
                .rev()
                .find(|line| !line.trim().is_empty())
                .unwrap_or("")
                .to_owned();
            return Err(RunnerError::Supervisor {
                reason: format!("detached attempt for {} exited with {status} before owning the job: {last_line}", dir.job_id),
            });
        }
        if dir.live_owner()?.is_some_and(|owner| owner.pid == pid) {
            break;
        }
        if Instant::now() >= deadline {
            return Err(RunnerError::Supervisor {
                reason: format!(
                    "pid {pid} did not take ownership of {} within {OWNERSHIP_TIMEOUT:?}",
                    dir.job_id
                ),
            });
        }
        std::thread::sleep(OWNERSHIP_POLL);
    }
    Ok(DetachReport {
        pid,
        stdout_log: stdout_path.display().to_string(),
        stderr_log: stderr_path.display().to_string(),
    })
}
