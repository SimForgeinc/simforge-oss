//! Job lifecycle orchestration on one worker root.
//!
//! ```text
//! queued ──start──▶ preparing ──▶ running ──▶ completed
//!   │                  │            │  └────▶ failed (retryable → start again)
//!   │                  │            └───────▶ canceled
//!   │                  └── owner died ──────▶ interrupted ──start──▶ preparing …
//!   └──cancel─────────────────────────────▶ canceled
//! ```
//!
//! Only the process holding `owner.lock` may move a job through
//! preparing/running; every other process observes, cancels or reconciles.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;

use crate::artifacts::{verify_and_publish, verify_published, Publication, VerifiedArtifacts};
use crate::cancel::{install_signal_handlers, CancelRequest, CancelToken};
use crate::cas::ContentStore;
use crate::checkpoint::{CheckpointStore, ResumePoint};
use crate::clock::now_rfc3339;
use crate::engine::{AdmissionContext, EngineRegistry, ExecutionContext, ResolvedInput};
use crate::error::{Result, RunnerError};
use crate::fsatomic::{ensure_dir, read_json, remove_dir_if_present, remove_file_if_present};
use crate::lockfile::{FileLock, LockAttempt, LockOwner};
use crate::manifest::{InputSource, JobManifest};
use crate::resources::{ResourceUsage, WorkerCapacity};
use crate::runtime::VerifiedRuntime;
use crate::state::{list_job_dirs, Failure, JobDir, JobEvent, JobState, JobStatus};

pub const ROOT_ENV: &str = "SIMFORGE_NATIVE_RUNTIME_ROOT";
const ATTACH_POLL: Duration = Duration::from_millis(200);

/// Default worker root: `${XDG_DATA_HOME:-~/.local/share}/simforge/native-runtime`.
pub fn default_root() -> Result<PathBuf> {
    if let Some(root) = std::env::var_os(ROOT_ENV).filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(root));
    }
    let data_home = match std::env::var_os("XDG_DATA_HOME").filter(|value| !value.is_empty()) {
        Some(dir) => PathBuf::from(dir),
        None => {
            let home = std::env::var_os("HOME").filter(|value| !value.is_empty()).ok_or_else(|| RunnerError::Usage {
                reason: format!("cannot locate the worker root: set --root, {ROOT_ENV}, XDG_DATA_HOME or HOME"),
            })?;
            PathBuf::from(home).join(".local").join("share")
        }
    };
    Ok(data_home.join("simforge").join("native-runtime"))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusReport {
    #[serde(flatten)]
    pub state: JobState,
    /// Whether a live process holds the owner lock right now.
    pub owner_alive: bool,
    pub job_dir: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitReport {
    pub job_id: String,
    pub manifest_sha256: String,
    /// `false` when the identical manifest was already submitted.
    pub created: bool,
    pub ingested_inputs: usize,
    pub status: JobStatus,
    pub job_dir: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileReport {
    pub interrupted: Vec<String>,
    pub active: Vec<String>,
    pub removed_temp_files: usize,
}

pub struct Worker {
    root: PathBuf,
    cas: ContentStore,
}

impl Worker {
    pub fn open(root: &Path) -> Result<Self> {
        ensure_dir(root)?;
        let cas = ContentStore::open(root)?;
        ensure_dir(&root.join("jobs"))?;
        ensure_dir(&root.join("worker"))?;
        Ok(Worker {
            root: root.to_path_buf(),
            cas,
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }
    pub fn jobs_root(&self) -> PathBuf {
        self.root.join("jobs")
    }
    pub fn worker_dir(&self) -> PathBuf {
        self.root.join("worker")
    }
    pub fn cas(&self) -> &ContentStore {
        &self.cas
    }

    pub fn job_dir(&self, job_id: &str) -> Result<JobDir> {
        let dir = JobDir::new(&self.jobs_root(), job_id)?;
        if !dir.exists() {
            return Err(RunnerError::JobNotFound {
                job_id: job_id.to_owned(),
                root: self.root.clone(),
            });
        }
        Ok(dir)
    }

    pub fn capacity(&self) -> Result<WorkerCapacity> {
        WorkerCapacity::load(&self.worker_dir())
    }

    /// Sum of grants held by jobs whose owner lock is currently held,
    /// excluding `except`.
    pub fn resources_in_use(&self, except: Option<&str>) -> Result<ResourceUsage> {
        let mut usage = ResourceUsage::default();
        for dir in list_job_dirs(&self.jobs_root())? {
            if Some(dir.job_id.as_str()) == except {
                continue;
            }
            let Ok(state) = dir.load_state() else {
                continue;
            };
            if !state.status.is_active() || dir.live_owner()?.is_none() {
                continue;
            }
            if let Some(grant) = &state.grant {
                usage.cpu_threads = usage.cpu_threads.saturating_add(grant.cpu_threads);
                usage.memory_bytes = usage.memory_bytes.saturating_add(grant.memory_bytes);
                usage.scratch_bytes = usage.scratch_bytes.saturating_add(grant.scratch_bytes);
            }
        }
        Ok(usage)
    }

    fn report(&self, dir: &JobDir) -> Result<StatusReport> {
        let state = dir.load_state()?;
        let owner_alive = dir.live_owner()?.is_some();
        Ok(StatusReport {
            state,
            owner_alive,
            job_dir: dir.path.display().to_string(),
        })
    }

    pub fn status(&self, job_id: &str) -> Result<StatusReport> {
        self.report(&self.job_dir(job_id)?)
    }

    pub fn list(&self) -> Result<Vec<StatusReport>> {
        list_job_dirs(&self.jobs_root())?
            .iter()
            .map(|dir| self.report(dir))
            .collect()
    }

    /// Validates a manifest, ingests its file inputs into the store, checks
    /// that every store input is present, and creates the job.
    pub fn submit(&self, manifest_path: &Path) -> Result<SubmitReport> {
        let manifest: JobManifest = read_json(manifest_path)?;
        manifest.validate()?;
        let base = manifest_path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."));
        let mut ingested = 0usize;
        for input in &manifest.inputs {
            let digest = input.digest();
            match &input.source {
                InputSource::Cas => {
                    if !self.cas.has(&digest) {
                        return Err(RunnerError::Content {
                            sha256: digest.sha256,
                            reason: format!(
                                "input {} declares source cas but the store has no such blob",
                                input.input_id
                            ),
                        });
                    }
                }
                InputSource::File { path } => {
                    let source = if Path::new(path).is_absolute() {
                        PathBuf::from(path)
                    } else {
                        base.join(path)
                    };
                    let (_, already_present) = self.cas.ingest_file(&source, Some(&digest))?;
                    if !already_present {
                        ingested += 1;
                    }
                }
            }
        }
        let manifest_sha256 = manifest.sha256()?;
        let dir = JobDir::new(&self.jobs_root(), &manifest.job_id)?;
        let created = dir.create(&manifest, &manifest_sha256)?;
        let state = dir.load_state()?;
        Ok(SubmitReport {
            job_id: manifest.job_id,
            manifest_sha256,
            created,
            ingested_inputs: ingested,
            status: state.status,
            job_dir: dir.path.display().to_string(),
        })
    }

    /// Requests cancellation. Queued and interrupted jobs are canceled
    /// immediately; an owned attempt gets a `cancel.request` plus SIGTERM
    /// and records the outcome itself at its next safe boundary.
    pub fn cancel(&self, job_id: &str, reason: &str) -> Result<StatusReport> {
        let dir = self.job_dir(job_id)?;
        let mut state = dir.load_state()?;
        if state.status.is_terminal() {
            return Err(RunnerError::JobState {
                job_id: job_id.to_owned(),
                reason: format!("already {}", state.status.as_str()),
            });
        }
        let request = CancelRequest::write(&dir.path, reason)?;
        let owner = dir.live_owner()?;
        match (state.status, owner) {
            (JobStatus::Preparing | JobStatus::Running, Some(owner)) => {
                dir.append_event(
                    &mut state,
                    "job.cancel_requested",
                    None,
                    serde_json::json!({ "reason": reason, "ownerPid": owner.pid }),
                )?;
                // SAFETY: kill with SIGTERM on a pid we just observed holding
                // the lock; a stale pid at worst signals nothing.
                unsafe {
                    libc::kill(owner.pid as libc::pid_t, libc::SIGTERM);
                }
            }
            _ => {
                state.cancel = Some(request.clone());
                state.owner = None;
                state.grant = None;
                dir.append_event(
                    &mut state,
                    "job.canceled",
                    Some(JobStatus::Canceled),
                    serde_json::json!({ "reason": reason, "hadOwner": false }),
                )?;
            }
        }
        self.report(&dir)
    }

    /// Marks every active job whose owner lock is not held as interrupted and
    /// removes stale store temporaries. Never touches blobs, source assets,
    /// checkpoints or published outputs.
    pub fn reconcile(&self) -> Result<ReconcileReport> {
        let mut report = ReconcileReport {
            interrupted: Vec::new(),
            active: Vec::new(),
            removed_temp_files: 0,
        };
        for dir in list_job_dirs(&self.jobs_root())? {
            let mut state = dir.load_state()?;
            if !state.status.is_active() {
                continue;
            }
            if dir.live_owner()?.is_some() {
                report.active.push(dir.job_id.clone());
                continue;
            }
            let dead = state.owner.take();
            state.grant = None;
            let checkpoint = state
                .checkpoint
                .as_ref()
                .map(|checkpoint| checkpoint.sequence);
            dir.append_event(
                &mut state,
                "job.interrupted",
                Some(JobStatus::Interrupted),
                serde_json::json!({ "reason": "owner lock not held", "previousOwner": dead, "checkpoint": checkpoint }),
            )?;
            report.interrupted.push(dir.job_id.clone());
        }
        let tmp = self.root.join("cas").join("tmp");
        if let Ok(entries) = std::fs::read_dir(&tmp) {
            let cutoff = std::time::SystemTime::now() - Duration::from_secs(3600);
            for entry in entries.flatten() {
                let stale = entry
                    .metadata()
                    .and_then(|meta| meta.modified())
                    .map(|modified| modified < cutoff)
                    .unwrap_or(false);
                if stale && std::fs::remove_file(entry.path()).is_ok() {
                    report.removed_temp_files += 1;
                }
            }
        }
        Ok(report)
    }

    pub fn artifacts(&self, job_id: &str) -> Result<VerifiedArtifacts> {
        let dir = self.job_dir(job_id)?;
        let state = dir.load_state()?;
        if state.status != JobStatus::Completed {
            return Err(RunnerError::JobState {
                job_id: job_id.to_owned(),
                reason: format!(
                    "status is {}; artifacts exist only for completed jobs",
                    state.status.as_str()
                ),
            });
        }
        verify_published(&dir)
    }

    /// Streams events with sequence greater than `after` to `sink` until the
    /// job reaches a terminal state or an active attempt's owner disappears
    /// (the caller then runs `reconcile`). Queued and interrupted jobs are
    /// followed until someone starts them.
    pub fn attach(
        &self,
        job_id: &str,
        after: u64,
        mut sink: impl FnMut(&JobEvent) -> Result<()>,
    ) -> Result<StatusReport> {
        let dir = self.job_dir(job_id)?;
        let mut cursor = after;
        loop {
            let report = self.report(&dir)?;
            // Read the state before the log: any event appended after the
            // state load is seen on the next iteration or the final drain.
            for event in dir.read_events(cursor)? {
                cursor = event.sequence;
                sink(&event)?;
            }
            if report.state.status.is_terminal()
                || (report.state.status.is_active() && !report.owner_alive)
            {
                for event in dir.read_events(cursor)? {
                    sink(&event)?;
                }
                return Ok(report);
            }
            std::thread::sleep(ATTACH_POLL);
        }
    }

    /// Executes one attempt in this process. Requires the verified runtime and
    /// the engines linked into this binary.
    pub fn run(
        &self,
        job_id: &str,
        runtime: &VerifiedRuntime,
        engines: &EngineRegistry,
        restart: bool,
    ) -> Result<StatusReport> {
        let dir = self.job_dir(job_id)?;
        let manifest = dir.load_manifest()?;
        let manifest_sha256 = manifest.sha256()?;
        let lock = match FileLock::try_acquire(&dir.owner_lock_path(), "job")? {
            LockAttempt::Acquired(lock) => lock,
            LockAttempt::Held(owner) => {
                return Err(RunnerError::JobOwned {
                    job_id: job_id.to_owned(),
                    pid: owner.map_or(0, |owner| owner.pid),
                })
            }
        };
        let mut state = dir.load_state()?;
        if state.manifest_sha256 != manifest_sha256 {
            return Err(RunnerError::JobState {
                job_id: job_id.to_owned(),
                reason: "manifest.json no longer matches the recorded manifestSha256".into(),
            });
        }
        match state.status {
            JobStatus::Queued | JobStatus::Interrupted => {}
            JobStatus::Failed
                if state
                    .failure
                    .as_ref()
                    .is_some_and(|failure| failure.retryable) => {}
            other => {
                return Err(RunnerError::JobState {
                    job_id: job_id.to_owned(),
                    reason: format!(
                        "cannot start from status {}{}",
                        other.as_str(),
                        if other == JobStatus::Failed {
                            " (failure is not retryable)"
                        } else {
                            ""
                        }
                    ),
                });
            }
        }
        if let Some(request) = CancelRequest::read(&dir.path)? {
            state.cancel = Some(request.clone());
            state.owner = None;
            state.grant = None;
            dir.append_event(
                &mut state,
                "job.canceled",
                Some(JobStatus::Canceled),
                serde_json::json!({ "reason": request.reason, "hadOwner": false }),
            )?;
            return self.report(&dir);
        }
        if let Some(pin) = &manifest.runtime {
            if pin.runtime_id != runtime.runtime_id {
                return Err(RunnerError::JobState {
                    job_id: job_id.to_owned(),
                    reason: format!(
                        "pinned to runtime {} but this runtime is {}",
                        pin.runtime_id, runtime.runtime_id
                    ),
                });
            }
        }
        let engine = engines.find(&manifest.workload)?;
        let capabilities = engine.capabilities();
        let identity = runtime.identity();

        state.attempt += 1;
        state.owner = Some(LockOwner {
            pid: std::process::id(),
            started_at: now_rfc3339(),
            purpose: "job".into(),
        });
        state.runtime = Some(identity.clone());
        state.failure = None;
        state.grant = None;
        let attempt = state.attempt;
        dir.append_event(
            &mut state,
            "job.started",
            Some(JobStatus::Preparing),
            serde_json::json!({ "attempt": attempt, "runtimeId": identity.runtime_id }),
        )?;

        let outcome = self.run_prepared(
            &dir,
            &manifest,
            &manifest_sha256,
            &mut state,
            runtime,
            engine,
            capabilities.supports_continuation,
            restart,
        );
        let cancel_request = CancelRequest::read(&dir.path).ok().flatten();
        match outcome {
            Ok(()) => {}
            Err(RunnerError::Canceled { reason }) => {
                state.cancel = Some(cancel_request.unwrap_or(CancelRequest {
                    reason: reason.clone(),
                    requested_at: now_rfc3339(),
                    requested_by_pid: std::process::id(),
                }));
                state.owner = None;
                state.grant = None;
                dir.append_event(
                    &mut state,
                    "job.canceled",
                    Some(JobStatus::Canceled),
                    serde_json::json!({ "reason": reason, "attempt": attempt, "hadOwner": true }),
                )?;
            }
            Err(error) => {
                let failure = Failure::from_error(&error);
                state.failure = Some(failure.clone());
                state.owner = None;
                state.grant = None;
                dir.append_event(
                    &mut state,
                    "job.failed",
                    Some(JobStatus::Failed),
                    serde_json::json!({ "attempt": attempt, "failure": failure }),
                )?;
            }
        }
        remove_file_if_present(&CancelRequest::path(&dir.path))?;
        drop(lock);
        self.report(&dir)
    }

    #[allow(clippy::too_many_arguments)]
    fn run_prepared(
        &self,
        dir: &JobDir,
        manifest: &JobManifest,
        manifest_sha256: &str,
        state: &mut JobState,
        runtime: &VerifiedRuntime,
        engine: &dyn crate::engine::JobEngine,
        supports_continuation: bool,
        restart: bool,
    ) -> Result<()> {
        let identity = runtime.identity();
        let checkpoints = CheckpointStore::new(dir.checkpoints_dir());

        // Continuation decision from the store's own latest reference (state
        // may lag by one publication if the owner died mid-append).
        let resume: Option<ResumePoint> = match (
            checkpoints.latest()?,
            restart,
            supports_continuation,
        ) {
            (Some(reference), false, true) => {
                if reference.runtime_id != identity.runtime_id {
                    return Err(RunnerError::JobState {
                        job_id: dir.job_id.clone(),
                        reason: format!(
                            "checkpoint {} was written by runtime {}; this runtime is {}. Restart with --restart to discard it",
                            reference.sequence, reference.runtime_id, identity.runtime_id
                        ),
                    });
                }
                let point = checkpoints
                    .resume_point(&reference)
                    .map_err(|error| match error {
                        RunnerError::JobState { reason, .. } => RunnerError::JobState {
                            job_id: dir.job_id.clone(),
                            reason,
                        },
                        other => other,
                    })?;
                dir.append_event(state, "job.resuming", None, serde_json::json!({ "checkpoint": reference.sequence, "metadata": reference.metadata }))?;
                Some(point)
            }
            (Some(reference), _, _) => {
                let why = if restart {
                    "restart requested"
                } else {
                    "engine has no continuation support"
                };
                checkpoints.clear()?;
                state.checkpoint = None;
                dir.append_event(
                    state,
                    "job.checkpoints_discarded",
                    None,
                    serde_json::json!({ "reason": why, "discardedThrough": reference.sequence }),
                )?;
                None
            }
            (None, _, _) => None,
        };

        // Fresh attempt-local directories; inputs come from the store.
        remove_dir_if_present(&dir.workspace_dir())?;
        remove_dir_if_present(&dir.staging_dir())?;
        ensure_dir(&dir.workspace_dir())?;
        ensure_dir(&dir.staging_dir())?;
        let mut inputs = Vec::with_capacity(manifest.inputs.len());
        for input in &manifest.inputs {
            let digest = input.digest();
            let path = dir.workspace_dir().join(input.workspace_path());
            self.cas.materialize(&digest, &path)?;
            inputs.push(ResolvedInput {
                input_id: input.input_id.clone(),
                path,
                digest,
            });
        }

        let capacity = self.capacity()?;
        let in_use = self.resources_in_use(Some(&dir.job_id))?;
        let admission = capacity.admit(&self.worker_dir(), &manifest.resources, &in_use)?;
        state.grant = Some(admission.grant.clone());
        let report = engine.admit(&AdmissionContext {
            root: &self.root,
            manifest,
            inputs: &inputs,
            runtime: &identity,
        })?;
        if let Some(previous) = &state.execution_identity {
            if *previous != report.execution_identity {
                return Err(RunnerError::JobState {
                    job_id: dir.job_id.clone(),
                    reason: format!("execution identity changed from {previous} to {} between attempts on identical inputs", report.execution_identity),
                });
            }
        }
        state.execution_identity = Some(report.execution_identity.clone());
        dir.append_event(
            state,
            "job.admitted",
            None,
            serde_json::json!({ "grant": admission.grant, "executionIdentity": report.execution_identity, "summary": report.summary }),
        )?;
        dir.append_event(
            state,
            "job.running",
            Some(JobStatus::Running),
            serde_json::json!({ "resumed": resume.is_some() }),
        )?;

        install_signal_handlers();
        let cancel = CancelToken::new(&dir.path, manifest.resources.wall_clock_seconds);
        let attempt = state.attempt;
        let workspace = dir.workspace_dir();
        let staging = dir.staging_dir();
        let execution = {
            // Progress and checkpoint events go through the same durable log;
            // a checkpoint publication also refreshes the state's reference
            // so an interruption right after it resumes from it.
            let mut progress = |event: &str, data: serde_json::Value| -> Result<u64> {
                if event == "job.checkpoint" {
                    state.checkpoint = checkpoints.latest()?;
                }
                dir.append_event(state, event, None, data)
            };
            let mut ctx = ExecutionContext::new(
                &self.root,
                manifest,
                attempt,
                &inputs,
                &workspace,
                &staging,
                &admission.grant,
                &identity,
                resume.as_ref(),
                &cancel,
                &checkpoints,
                &mut progress,
            );
            engine.execute(&mut ctx)
        };
        state.checkpoint = checkpoints.latest()?;
        let outcome = execution?;

        let (artifact_manifest, reference) = verify_and_publish(
            &Publication {
                job_dir: dir,
                manifest,
                manifest_sha256,
                execution_identity: state.execution_identity.as_deref().unwrap_or_default(),
                runtime: &identity,
                attempt: state.attempt,
                cas: &self.cas,
            },
            outcome,
        )?;
        state.artifacts = Some(reference.clone());
        state.owner = None;
        state.grant = None;
        remove_dir_if_present(&dir.workspace_dir())?;
        dir.append_event(
            state,
            "job.completed",
            Some(JobStatus::Completed),
            serde_json::json!({
                "artifactsSha256": reference.sha256,
                "artifactCount": reference.count,
                "artifacts": artifact_manifest.artifacts,
                "summary": artifact_manifest.summary,
            }),
        )?;
        drop(admission);
        Ok(())
    }
}
