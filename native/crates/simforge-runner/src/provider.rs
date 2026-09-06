//! Foreign provider supervision. The Rust runner is the only durable host;
//! Python providers (MuJoCo physics, Warp GPU batch, policy episodes, the
//! resident Bevy/NuRec renderers) are foreign components executed one child
//! per attempt under a single job protocol:
//!
//! ```text
//! <python> -m <module> job --params <params.json> --out-dir <dir> [--resume <checkpoint.json>]
//! stdout JSONL: {"event":"progress",...}
//!               {"event":"checkpoint","path":"<file written by the provider>"}
//!               {"event":"done","artifacts":[{"relativePath","sha256","sizeBytes"},...]}
//!               {"event":"canceled"}
//! stderr:       {"event":"error","code","message"}
//! exit:         0 done | 1 bad params | 2 backend/capacity failure | 130 canceled after SIGTERM
//! <python> -m <module> capabilities [flags...]              -> JSON report
//! ```
//!
//! The runner never trusts the child's artifact claims: every listed file is
//! re-hashed here and again at publication. Checkpoints announced by the
//! child are copied into the runner's atomic checkpoint store and handed
//! back with `--resume` on continuation. Cancellation is SIGTERM at the
//! child's decision boundary; a child that ignores it is killed and the
//! attempt fails (not canceled).
//!
//! Provider Python resolves to `$SIMFORGE_PROVIDER_PYTHON`, else
//! the activated environment's physical `<runtime root>/venvs/<generation>/bin/python`.
//! A missing installed environment is an explicit spawn error, never a fallback
//! to an unrelated global Python installation.

use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant};

use serde::Deserialize;

use crate::engine::{ExecutionContext, ExecutionOutcome, ProducedArtifact};
use crate::error::{Result, RunnerError};
use crate::hash::{hash_file, ContentDigest};

pub const PYTHON_ENV: &str = "SIMFORGE_PROVIDER_PYTHON";
pub const CHECKPOINT_FILE: &str = "provider.checkpoint.json";
const POLL: Duration = Duration::from_millis(100);
const TERM_GRACE: Duration = Duration::from_secs(120);

#[derive(Debug, Deserialize)]
#[serde(tag = "event", rename_all = "camelCase")]
enum ChildEvent {
    Progress(serde_json::Value),
    Checkpoint {
        path: String,
    },
    Done {
        artifacts: Vec<ChildArtifact>,
    },
    Canceled,
    #[serde(other)]
    Other,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChildArtifact {
    relative_path: String,
    sha256: String,
    size_bytes: u64,
}

#[derive(Debug, Deserialize)]
struct ChildError {
    code: String,
    message: String,
}

/// Python interpreter for providers. `root` is the worker root.
pub fn python(root: &Path) -> PathBuf {
    if let Some(explicit) = std::env::var_os(PYTHON_ENV).filter(|value| !value.is_empty()) {
        return PathBuf::from(explicit);
    }
    let activated = root.join("venv");
    // Resolve the environment directory, not the Python executable symlink:
    // resolving the latter would bypass pyvenv.cfg and select system Python.
    // Pin imports to this generation even if another install activates later.
    let generation = activated.canonicalize().unwrap_or(activated);
    generation.join("bin").join("python")
}

fn provider_error(module: &str, reason: impl std::fmt::Display) -> RunnerError {
    RunnerError::Engine {
        workload: module.to_owned(),
        reason: reason.to_string(),
    }
}

/// Runs `capabilities <flags>` and returns the JSON report. Callers pass
/// `--no-probe` when a dependency-only report is enough; providers whose
/// availability is only known by probing (NuRec) are called without it.
pub fn capabilities(root: &Path, module: &str, flags: &[&str]) -> Result<serde_json::Value> {
    let interpreter = python(root);
    let output = Command::new(&interpreter)
        .env(crate::job::ROOT_ENV, root)
        .arg("-m")
        .arg(module)
        .arg("capabilities")
        .args(flags)
        .stdin(Stdio::null())
        .output()
        .map_err(|error| {
            provider_error(
                module,
                format!("spawn {} -m {module}: {error}", interpreter.display()),
            )
        })?;
    if !output.status.success() {
        return Err(provider_error(
            module,
            format!(
                "capabilities exited {} using {}: {}",
                output.status,
                interpreter.display(),
                String::from_utf8_lossy(&output.stderr).trim()
            ),
        ));
    }
    serde_json::from_slice(&output.stdout).map_err(|error| {
        provider_error(module, format!("capabilities report is not JSON: {error}"))
    })
}

/// Everything a provider job run needs beyond the execution context.
pub struct ProviderJob<'a> {
    pub root: &'a Path,
    pub module: &'a str,
    /// Exact params document forwarded to the child.
    pub params: &'a serde_json::Value,
    /// Extra environment for the child (device visibility, map roots).
    pub env: &'a [(&'a str, String)],
}

/// Supervises one provider child for the attempt described by `ctx`.
pub fn run(job: &ProviderJob<'_>, ctx: &mut ExecutionContext<'_>) -> Result<ExecutionOutcome> {
    let module = job.module;
    let params_path = ctx.workspace.join("provider-params.json");
    let params_bytes = serde_json::to_vec(job.params).map_err(|source| RunnerError::Json {
        path: params_path.clone(),
        source,
    })?;
    fs::write(&params_path, params_bytes)
        .map_err(|source| RunnerError::io(&params_path, source))?;

    let interpreter = python(job.root);
    let mut command = Command::new(&interpreter);
    command
        .arg("-m")
        .arg(module)
        .arg("job")
        .arg("--params")
        .arg(&params_path)
        .arg("--out-dir")
        .arg(ctx.output_dir);
    if let Some(point) = ctx.resume {
        command.arg("--resume").arg(point.dir.join(CHECKPOINT_FILE));
    }
    command.env(crate::job::ROOT_ENV, job.root);
    for (key, value) in job.env {
        command.env(key, value);
    }
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            provider_error(
                module,
                format!("spawn {} -m {module} job: {error}", interpreter.display()),
            )
        })?;
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");

    let (sender, receiver) = mpsc::channel::<String>();
    let stdout_reader = std::thread::spawn(move || {
        for line in BufReader::new(stdout)
            .lines()
            .map_while(std::result::Result::ok)
        {
            if sender.send(line).is_err() {
                break;
            }
        }
    });
    let stderr_reader = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = BufReader::new(stderr).read_to_string(&mut text);
        text
    });

    let mut done: Option<Vec<ChildArtifact>> = None;
    let mut canceled_by_child = false;
    let mut status = None;
    let mut term_sent_at: Option<Instant> = None;
    loop {
        match receiver.recv_timeout(POLL) {
            Ok(line) => {
                let Ok(event) = serde_json::from_str::<ChildEvent>(&line) else {
                    continue;
                };
                match event {
                    ChildEvent::Progress(data) => {
                        ctx.progress(data)?;
                    }
                    ChildEvent::Checkpoint { path } => {
                        let source = PathBuf::from(&path);
                        if !source.is_file() {
                            let _ = child.kill();
                            return Err(provider_error(
                                module,
                                format!("announced checkpoint {path} does not exist"),
                            ));
                        }
                        let digest = hash_file(&source)?;
                        ctx.checkpoint(serde_json::json!({ "providerCheckpoint": path, "sha256": digest.sha256 }), |dir| {
                            fs::copy(&source, dir.join(CHECKPOINT_FILE)).map(|_| ()).map_err(|error| RunnerError::io(dir.join(CHECKPOINT_FILE), error))
                        })?;
                    }
                    ChildEvent::Done { artifacts } => done = Some(artifacts),
                    ChildEvent::Canceled => canceled_by_child = true,
                    ChildEvent::Other => {}
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
        if status.is_none() {
            if let Some(exit) = child
                .try_wait()
                .map_err(|error| provider_error(module, format!("wait: {error}")))?
            {
                status = Some(exit);
            } else if term_sent_at.is_none() && ctx.cancel.is_canceled() {
                signal_term(&child);
                term_sent_at = Some(Instant::now());
            } else if term_sent_at.is_some_and(|sent| sent.elapsed() > TERM_GRACE) {
                let _ = child.kill();
                let _ = child.wait();
                return Err(provider_error(
                    module,
                    format!("child ignored SIGTERM for {TERM_GRACE:?}; killed"),
                ));
            }
        }
    }
    let _ = stdout_reader.join();
    let stderr_text = stderr_reader.join().unwrap_or_default();
    let status = match status {
        Some(status) => status,
        None => {
            if term_sent_at.is_none() && ctx.cancel.is_canceled() {
                signal_term(&child);
            }
            child
                .wait()
                .map_err(|error| provider_error(module, format!("wait: {error}")))?
        }
    };

    if canceled_by_child || status.code() == Some(130) {
        ctx.cancel.check()?;
        return Err(RunnerError::Canceled {
            reason: format!("{module} exited 130 at a decision boundary"),
        });
    }
    if !status.success() {
        let detail = stderr_text
            .lines()
            .rev()
            .find_map(|line| serde_json::from_str::<ChildError>(line).ok())
            .map(|error| format!("{}: {}", error.code, error.message))
            .unwrap_or_else(|| stderr_text.trim().to_owned());
        return Err(provider_error(
            module,
            format!("job exited {status}: {detail}"),
        ));
    }
    let artifacts = done.ok_or_else(|| provider_error(module, "exited 0 without a done event"))?;

    let mut produced = Vec::with_capacity(artifacts.len());
    for artifact in artifacts {
        if !crate::manifest::is_safe_relative(&artifact.relative_path) {
            return Err(provider_error(
                module,
                format!("produced unsafe artifact path {:?}", artifact.relative_path),
            ));
        }
        let contract = ctx
            .manifest
            .output_for_path(&artifact.relative_path)
            .ok_or_else(|| {
                provider_error(
                    module,
                    format!(
                        "produced {} which no output contract declares",
                        artifact.relative_path
                    ),
                )
            })?;
        let path = ctx.output_dir.join(&artifact.relative_path);
        let claimed = ContentDigest {
            sha256: artifact.sha256,
            size_bytes: artifact.size_bytes,
        };
        let actual = hash_file(&path)?;
        if actual != claimed {
            return Err(provider_error(
                module,
                format!(
                    "claimed {}/{} for {} but bytes are {}/{}",
                    claimed.sha256,
                    claimed.size_bytes,
                    artifact.relative_path,
                    actual.sha256,
                    actual.size_bytes
                ),
            ));
        }
        produced.push(ProducedArtifact {
            output_id: contract.output_id.clone(),
            relative_path: artifact.relative_path,
            sha256: actual.sha256,
            size_bytes: actual.size_bytes,
            media_type: contract.media_type.clone(),
        });
    }
    let summary = serde_json::json!({ "provider": module, "artifacts": produced.len() });
    Ok(ExecutionOutcome {
        artifacts: produced,
        summary,
    })
}

fn signal_term(child: &Child) {
    // SAFETY: SIGTERM to a child we spawned; the protocol makes it checkpoint
    // and exit 130.
    unsafe {
        libc::kill(child.id() as libc::pid_t, libc::SIGTERM);
    }
}
