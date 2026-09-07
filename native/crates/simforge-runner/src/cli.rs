//! Command surface of the `simforge-runner` binary.
//!
//! Contract (shared with the TypeScript `simforge` CLI): stdout is one JSON
//! document (`--pretty` to indent), stderr carries structured errors
//! `{code, path?, reason, detail?}`, exit `0` ok / `1` could not run / `2`
//! input rejected. `--help` prints the surface as JSON. Unknown flags are
//! errors. `job attach` is the one streaming command: it writes JSON lines.

use std::io::Write;
use std::path::PathBuf;

use serde::Serialize;

use crate::engine::EngineRegistry;
use crate::error::{Result, RunnerError};
use crate::job::{default_root, Worker, ROOT_ENV};
use crate::runtime::{self, VerifiedRuntime, RUNTIME_MANIFEST_ENV};
use crate::supervise::spawn_detached;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    Help,
    RuntimeShow,
    JobSubmit {
        manifest: PathBuf,
    },
    JobStart {
        job_id: String,
        detach: bool,
        restart: bool,
    },
    JobRun {
        job_id: String,
        restart: bool,
    },
    JobStatus {
        job_id: String,
    },
    JobList,
    JobCancel {
        job_id: String,
        reason: String,
    },
    JobAttach {
        job_id: String,
        from_sequence: u64,
    },
    JobArtifacts {
        job_id: String,
    },
    WorkerReconcile,
    WorkerCapacity,
    CasIngest {
        path: PathBuf,
    },
    CasVerify {
        sha256: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invocation {
    pub root: Option<PathBuf>,
    pub pretty: bool,
    pub command: Command,
}

fn usage(reason: impl Into<String>) -> RunnerError {
    RunnerError::Usage {
        reason: reason.into(),
    }
}

fn take_value(
    args: &mut std::iter::Peekable<std::vec::IntoIter<String>>,
    flag: &str,
) -> Result<String> {
    args.next()
        .ok_or_else(|| usage(format!("{flag} requires a value")))
}

/// Parses `argv[1..]`.
pub fn parse(args: Vec<String>) -> Result<Invocation> {
    let mut args = args.into_iter().peekable();
    let mut root = None;
    let mut pretty = false;
    let mut positional: Vec<String> = Vec::new();
    let mut detach = false;
    let mut restart = false;
    let mut reason: Option<String> = None;
    let mut from_sequence: Option<u64> = None;
    let mut help = false;

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--help" | "-h" => help = true,
            "--pretty" => pretty = true,
            "--root" => root = Some(PathBuf::from(take_value(&mut args, "--root")?)),
            "--detach" => detach = true,
            "--restart" => restart = true,
            "--reason" => reason = Some(take_value(&mut args, "--reason")?),
            "--from-sequence" => {
                let value = take_value(&mut args, "--from-sequence")?;
                from_sequence = Some(value.parse().map_err(|_| {
                    usage(format!("--from-sequence expects an integer, got {value:?}"))
                })?);
            }
            other if other.starts_with('-') => return Err(usage(format!("unknown flag {other}"))),
            _ => positional.push(arg),
        }
    }
    if help || positional.is_empty() {
        return Ok(Invocation {
            root,
            pretty,
            command: Command::Help,
        });
    }

    let mut positional = positional.into_iter();
    let group = positional.next().unwrap_or_default();
    let name = positional.next();
    let mut rest = positional;
    let mut require_arg = |what: &str| {
        rest.next().ok_or_else(|| {
            usage(format!(
                "{group} {} requires <{what}>",
                name.clone().unwrap_or_default()
            ))
        })
    };

    let command = match (group.as_str(), name.as_deref()) {
        ("runtime", Some("show")) => Command::RuntimeShow,
        ("job", Some("submit")) => Command::JobSubmit {
            manifest: PathBuf::from(require_arg("manifest.json")?),
        },
        ("job", Some("start")) => Command::JobStart {
            job_id: require_arg("jobId")?,
            detach,
            restart,
        },
        ("job", Some("run")) => Command::JobRun {
            job_id: require_arg("jobId")?,
            restart,
        },
        ("job", Some("status")) => Command::JobStatus {
            job_id: require_arg("jobId")?,
        },
        ("job", Some("list")) => Command::JobList,
        ("job", Some("cancel")) => Command::JobCancel {
            job_id: require_arg("jobId")?,
            reason: reason
                .take()
                .unwrap_or_else(|| "canceled by operator".into()),
        },
        ("job", Some("attach")) => Command::JobAttach {
            job_id: require_arg("jobId")?,
            from_sequence: from_sequence.unwrap_or(0),
        },
        ("job", Some("artifacts")) => Command::JobArtifacts {
            job_id: require_arg("jobId")?,
        },
        ("worker", Some("reconcile")) => Command::WorkerReconcile,
        ("worker", Some("capacity")) => Command::WorkerCapacity,
        ("cas", Some("ingest")) => Command::CasIngest {
            path: PathBuf::from(require_arg("path")?),
        },
        ("cas", Some("verify")) => Command::CasVerify {
            sha256: require_arg("sha256")?,
        },
        (group, name) => {
            return Err(usage(format!(
                "unknown command {group} {}",
                name.unwrap_or("")
            )))
        }
    };
    if let Some(extra) = rest.next() {
        return Err(usage(format!("unexpected argument {extra:?}")));
    }
    let flag_scope_ok = match &command {
        Command::JobStart { .. } => reason.is_none() && from_sequence.is_none(),
        Command::JobRun { .. } => !detach && reason.is_none() && from_sequence.is_none(),
        Command::JobCancel { .. } => !detach && !restart && from_sequence.is_none(),
        Command::JobAttach { .. } => !detach && !restart && reason.is_none(),
        _ => !detach && !restart && reason.is_none() && from_sequence.is_none(),
    };
    if !flag_scope_ok {
        return Err(usage("flag not valid for this command (--detach/--restart: job start; --restart: job run; --reason: job cancel; --from-sequence: job attach)"));
    }
    Ok(Invocation {
        root,
        pretty,
        command,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HelpSurface {
    binary: &'static str,
    version: &'static str,
    contract: &'static str,
    global_flags: Vec<&'static str>,
    environment: Vec<&'static str>,
    commands: Vec<HelpCommand>,
}

#[derive(Serialize)]
struct HelpCommand {
    command: &'static str,
    description: &'static str,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    flags: Vec<&'static str>,
}

pub fn help_surface() -> serde_json::Value {
    let surface = HelpSurface {
        binary: "simforge-runner",
        version: runtime::RUNNER_VERSION,
        contract: "stdout: one JSON document; stderr: {code,path?,reason,detail?}; exit 0 ok, 1 cannot run, 2 input rejected; `job attach` streams JSON lines",
        global_flags: vec!["--root <dir>", "--pretty", "--help"],
        environment: vec![
            "SIMFORGE_NATIVE_RUNTIME_STATE_ROOT: writable worker root (default ${XDG_STATE_HOME:-~/.local/state}/simforge/native-runtime)",
            "SIMFORGE_RUNTIME_MANIFEST: runtime manifest path (default runtime-manifest.json beside the binary)",
        ],
        commands: vec![
            HelpCommand { command: "runtime show", description: "verified runtime identity, engines and support tiers", flags: vec![] },
            HelpCommand { command: "job submit <manifest.json>", description: "validate simforge.native-job/v1, ingest file inputs into the content store, create the job (idempotent for an identical manifest)", flags: vec![] },
            HelpCommand { command: "job start <jobId>", description: "run the next attempt of a queued, interrupted or retryable-failed job", flags: vec!["--detach: supervised setsid child that survives the caller", "--restart: discard checkpoints and restart from immutable inputs"] },
            HelpCommand { command: "job run <jobId>", description: "execute an attempt in this process (what --detach spawns)", flags: vec!["--restart"] },
            HelpCommand { command: "job status <jobId>", description: "persisted state plus live ownership", flags: vec![] },
            HelpCommand { command: "job list", description: "every job under the root", flags: vec![] },
            HelpCommand { command: "job cancel <jobId>", description: "cancel immediately when unowned, otherwise request cancellation at the owner's next safe boundary", flags: vec!["--reason <text>"] },
            HelpCommand { command: "job attach <jobId>", description: "stream events as JSON lines until terminal or the owner disappears", flags: vec!["--from-sequence <n>"] },
            HelpCommand { command: "job artifacts <jobId>", description: "published artifact manifest with every file re-hashed", flags: vec![] },
            HelpCommand { command: "worker reconcile", description: "mark orphaned active jobs interrupted; remove stale store temporaries; never touches blobs, sources or outputs", flags: vec![] },
            HelpCommand { command: "worker capacity", description: "declared or probed capacity and resources in use", flags: vec![] },
            HelpCommand { command: "cas ingest <path>", description: "copy a file into the content store and report its digest", flags: vec![] },
            HelpCommand { command: "cas verify <sha256>", description: "re-hash one stored blob", flags: vec![] },
        ],
    };
    serde_json::to_value(surface).expect("help surface serializes")
}

fn load_runtime() -> Result<VerifiedRuntime> {
    let executable = runtime::current_executable()?;
    runtime::load_verified(&runtime::default_manifest_path(&executable), &executable)
}

/// Components with their install-time presence and digest check, so a
/// fresh install reports exactly what is usable.
fn installed_components(runtime: &VerifiedRuntime) -> Vec<serde_json::Value> {
    let root = runtime
        .manifest_path
        .parent()
        .and_then(std::path::Path::parent);
    runtime
        .manifest
        .components
        .iter()
        .map(|component| {
            let path = root.map(|root| root.join(&component.install));
            let verified = path
                .as_ref()
                .and_then(|path| crate::hash::hash_file(path).ok())
                .is_some_and(|digest| {
                    digest.sha256 == component.sha256 && digest.size_bytes == component.size_bytes
                });
            serde_json::json!({
                "kind": component.kind,
                "name": component.name,
                "version": component.version,
                "module": component.module,
                "tier": component.tier,
                "install": component.install,
                "sha256": component.sha256,
                "installed": verified,
            })
        })
        .collect()
}

fn runtime_document(
    runtime: &VerifiedRuntime,
    engines: &EngineRegistry,
) -> Result<serde_json::Value> {
    // Reported, not required: the CPU baseline ships no provider environment,
    // so a consumer learns whether provider workloads can spawn at all.
    let provider_python = crate::provider::python()?;
    let provider_python_installed = provider_python.is_file();
    Ok(serde_json::json!({
        "schema": runtime::RUNTIME_MANIFEST_SCHEMA,
        "runtimeId": runtime.runtime_id,
        "version": runtime.manifest.version,
        "revision": runtime.manifest.revision,
        "target": runtime.manifest.target,
        "builtAt": runtime.manifest.built_at,
        "binary": runtime.manifest.binary,
        "crates": runtime.manifest.crates,
        "manifestPath": runtime.manifest_path,
        "engines": engines.capabilities(),
        "supportTiers": runtime.manifest.support_tiers,
        "components": installed_components(runtime),
        "providerPython": provider_python,
        "providerPythonInstalled": provider_python_installed,
        "environment": { ROOT_ENV: std::env::var(ROOT_ENV).ok(), RUNTIME_MANIFEST_ENV: std::env::var(RUNTIME_MANIFEST_ENV).ok() },
    }))
}

/// Runs one invocation, writing the result document (or event stream) to
/// `out`. Returns nothing on success; the caller maps errors to exit codes.
pub fn execute(
    invocation: Invocation,
    engines: &EngineRegistry,
    out: &mut dyn Write,
) -> Result<()> {
    let Invocation {
        root,
        pretty,
        command,
    } = invocation;
    let emit = |out: &mut dyn Write, value: &serde_json::Value| -> Result<()> {
        let text = if pretty {
            serde_json::to_string_pretty(value)
        } else {
            serde_json::to_string(value)
        }
        .map_err(|source| RunnerError::Json {
            path: "<stdout>".into(),
            source,
        })?;
        writeln!(out, "{text}").map_err(|source| RunnerError::io("<stdout>", source))
    };
    if command == Command::Help {
        return emit(out, &help_surface());
    }
    if command == Command::RuntimeShow {
        let runtime = load_runtime()?;
        return emit(out, &runtime_document(&runtime, engines)?);
    }
    let root = match root {
        Some(root) => root,
        None => default_root()?,
    };
    let worker = Worker::open(&root)?;

    match command {
        Command::Help | Command::RuntimeShow => unreachable!("handled above"),
        Command::JobSubmit { manifest } => emit(out, &to_value(worker.submit(&manifest)?)?),
        Command::JobStart {
            job_id,
            detach,
            restart,
        } => {
            let runtime = load_runtime()?;
            if detach {
                let dir = worker.job_dir(&job_id)?;
                let detached = spawn_detached(&root, &runtime, &dir, restart)?;
                let status = worker.status(&job_id)?;
                emit(
                    out,
                    &serde_json::json!({ "detached": detached, "status": status }),
                )
            } else {
                emit(
                    out,
                    &to_value(worker.run(&job_id, &runtime, engines, restart)?)?,
                )
            }
        }
        Command::JobRun { job_id, restart } => {
            let runtime = load_runtime()?;
            emit(
                out,
                &to_value(worker.run(&job_id, &runtime, engines, restart)?)?,
            )
        }
        Command::JobStatus { job_id } => emit(out, &to_value(worker.status(&job_id)?)?),
        Command::JobList => emit(out, &to_value(worker.list()?)?),
        Command::JobCancel { job_id, reason } => {
            emit(out, &to_value(worker.cancel(&job_id, &reason)?)?)
        }
        Command::JobAttach {
            job_id,
            from_sequence,
        } => {
            let final_status = worker.attach(&job_id, from_sequence, |event| {
                let line = serde_json::to_string(event).map_err(|source| RunnerError::Json {
                    path: "<stdout>".into(),
                    source,
                })?;
                writeln!(out, "{line}").map_err(|source| RunnerError::io("<stdout>", source))
            })?;
            emit(
                out,
                &serde_json::json!({ "schema": "simforge.native-job-attach-end/v1", "status": final_status }),
            )
        }
        Command::JobArtifacts { job_id } => emit(out, &to_value(worker.artifacts(&job_id)?)?),
        Command::WorkerReconcile => emit(out, &to_value(worker.reconcile()?)?),
        Command::WorkerCapacity => {
            let capacity = worker.capacity()?;
            let in_use = worker.resources_in_use(None)?;
            emit(
                out,
                &serde_json::json!({ "root": root, "capacity": capacity, "inUse": in_use }),
            )
        }
        Command::CasIngest { path } => {
            let (digest, already_present) = worker.cas().ingest_file(&path, None)?;
            emit(
                out,
                &serde_json::json!({
                    "sha256": digest.sha256,
                    "sizeBytes": digest.size_bytes,
                    "path": worker.cas().blob_path(&digest.sha256),
                    "alreadyPresent": already_present,
                }),
            )
        }
        Command::CasVerify { sha256 } => {
            let digest = worker.cas().verify(&sha256)?;
            emit(
                out,
                &serde_json::json!({ "sha256": digest.sha256, "sizeBytes": digest.size_bytes, "verified": true }),
            )
        }
    }
}

fn to_value<T: Serialize>(value: T) -> Result<serde_json::Value> {
    serde_json::to_value(value).map_err(|source| RunnerError::Json {
        path: "<memory>".into(),
        source,
    })
}
