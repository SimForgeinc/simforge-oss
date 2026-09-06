//! Persisted job records.
//!
//! ```text
//! <root>/jobs/<jobId>/
//!   manifest.json     immutable, created exactly once
//!   state.json        current lifecycle record, replaced atomically
//!   events.jsonl      append-only, monotonically sequenced lifecycle/progress log
//!   owner.lock        flock held by the process executing the current attempt
//!   cancel.request    written by `job cancel`, consumed by the cancel token
//!   workspace/        materialized inputs (rebuilt per attempt)
//!   staging/          attempt-local output staging
//!   outputs/          published outputs (exists only for completed jobs)
//!   artifacts.json    published, verified artifact manifest
//!   checkpoints/      atomically published continuation checkpoints
//!   logs/             stdout/stderr of detached attempts
//! ```

use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::cancel::CancelRequest;
use crate::checkpoint::CheckpointRef;
use crate::clock::now_rfc3339;
use crate::error::{Result, RunnerError};
use crate::fsatomic::{append_line, create_exclusive, ensure_dir, read_json, write_json_atomic};
use crate::lockfile::{FileLock, LockOwner};
use crate::manifest::{is_valid_job_id, JobManifest, LeasePassthrough};
use crate::resources::ResourceGrant;
use crate::runtime::RuntimeIdentity;

pub const JOB_STATE_SCHEMA: &str = "simforge.native-job-state/v1";
pub const JOB_EVENT_SCHEMA: &str = "simforge.native-job-event/v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JobStatus {
    Queued,
    Preparing,
    Running,
    Completed,
    Failed,
    Canceled,
    /// The owning process died without recording an outcome.
    Interrupted,
}

impl JobStatus {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            JobStatus::Completed | JobStatus::Canceled | JobStatus::Failed
        )
    }

    /// States in which a process may be executing the job.
    pub fn is_active(self) -> bool {
        matches!(self, JobStatus::Preparing | JobStatus::Running)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            JobStatus::Queued => "queued",
            JobStatus::Preparing => "preparing",
            JobStatus::Running => "running",
            JobStatus::Completed => "completed",
            JobStatus::Failed => "failed",
            JobStatus::Canceled => "canceled",
            JobStatus::Interrupted => "interrupted",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

impl Failure {
    pub fn from_error(error: &RunnerError) -> Self {
        Failure {
            code: error.code().to_owned(),
            message: error.to_string(),
            retryable: error.retryable(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactSetRef {
    pub sha256: String,
    pub count: usize,
    pub published_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobState {
    pub schema: String,
    pub job_id: String,
    pub manifest_sha256: String,
    pub workload: String,
    pub status: JobStatus,
    /// Number of attempts started so far; `0` until the first start.
    pub attempt: u32,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<RuntimeIdentity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<LockOwner>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grant: Option<ResourceGrant>,
    /// Engine-declared execution identity (compiled inputs + profile), set at
    /// admission.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_identity: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkpoint: Option<CheckpointRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure: Option<Failure>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cancel: Option<CancelRequest>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifacts: Option<ArtifactSetRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lease: Option<LeasePassthrough>,
    pub last_event_sequence: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobEvent {
    pub schema: String,
    pub sequence: u64,
    pub timestamp: String,
    pub job_id: String,
    pub attempt: u32,
    pub event: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<JobStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lease: Option<LeasePassthrough>,
    #[serde(default, skip_serializing_if = "serde_json::Value::is_null")]
    pub data: serde_json::Value,
}

#[derive(Debug, Clone)]
pub struct JobDir {
    pub job_id: String,
    pub path: PathBuf,
}

impl JobDir {
    pub fn new(jobs_root: &Path, job_id: &str) -> Result<Self> {
        if !is_valid_job_id(job_id) {
            return Err(RunnerError::Manifest {
                reason: format!("invalid jobId {job_id:?}"),
            });
        }
        Ok(JobDir {
            job_id: job_id.to_owned(),
            path: jobs_root.join(job_id),
        })
    }

    pub fn manifest_path(&self) -> PathBuf {
        self.path.join("manifest.json")
    }
    pub fn state_path(&self) -> PathBuf {
        self.path.join("state.json")
    }
    pub fn events_path(&self) -> PathBuf {
        self.path.join("events.jsonl")
    }
    pub fn owner_lock_path(&self) -> PathBuf {
        self.path.join("owner.lock")
    }
    pub fn workspace_dir(&self) -> PathBuf {
        self.path.join("workspace")
    }
    pub fn staging_dir(&self) -> PathBuf {
        self.path.join("staging")
    }
    pub fn outputs_dir(&self) -> PathBuf {
        self.path.join("outputs")
    }
    pub fn artifacts_path(&self) -> PathBuf {
        self.path.join("artifacts.json")
    }
    pub fn checkpoints_dir(&self) -> PathBuf {
        self.path.join("checkpoints")
    }
    pub fn logs_dir(&self) -> PathBuf {
        self.path.join("logs")
    }

    pub fn exists(&self) -> bool {
        self.manifest_path().is_file()
    }

    pub fn load_manifest(&self) -> Result<JobManifest> {
        read_json(&self.manifest_path())
    }

    pub fn load_state(&self) -> Result<JobState> {
        let state: JobState = read_json(&self.state_path())?;
        if state.schema != JOB_STATE_SCHEMA || state.job_id != self.job_id {
            return Err(RunnerError::JobState {
                job_id: self.job_id.clone(),
                reason: "state.json schema/jobId mismatch".into(),
            });
        }
        Ok(state)
    }

    pub fn save_state(&self, state: &mut JobState) -> Result<()> {
        state.updated_at = now_rfc3339();
        write_json_atomic(&self.state_path(), state)
    }

    /// Who currently executes this job, from the kernel lock (never a stale
    /// pid).
    pub fn live_owner(&self) -> Result<Option<LockOwner>> {
        FileLock::holder(&self.owner_lock_path())
    }

    /// Creates the job directory with its immutable manifest. Returns
    /// `Ok(false)` if the identical manifest was already submitted, and an
    /// error if a different manifest holds the same jobId.
    pub fn create(&self, manifest: &JobManifest, manifest_sha256: &str) -> Result<bool> {
        ensure_dir(&self.path)?;
        let bytes = {
            let mut bytes =
                serde_json::to_vec_pretty(manifest).map_err(|source| RunnerError::Json {
                    path: self.manifest_path(),
                    source,
                })?;
            bytes.push(b'\n');
            bytes
        };
        match create_exclusive(&self.manifest_path(), &bytes) {
            Ok(()) => {}
            Err(RunnerError::Io { source, .. })
                if source.kind() == std::io::ErrorKind::AlreadyExists =>
            {
                let existing: JobManifest = self.load_manifest()?;
                let existing_sha256 = existing.sha256()?;
                if existing_sha256 != manifest_sha256 {
                    return Err(RunnerError::Manifest {
                        reason: format!(
                            "jobId {} already holds manifest {existing_sha256}; submitted manifest is {manifest_sha256}",
                            self.job_id
                        ),
                    });
                }
                return Ok(false);
            }
            Err(error) => return Err(error),
        }
        let now = now_rfc3339();
        let mut state = JobState {
            schema: JOB_STATE_SCHEMA.to_owned(),
            job_id: self.job_id.clone(),
            manifest_sha256: manifest_sha256.to_owned(),
            workload: manifest.workload.clone(),
            status: JobStatus::Queued,
            attempt: 0,
            created_at: now.clone(),
            updated_at: now,
            runtime: None,
            owner: None,
            grant: None,
            execution_identity: None,
            checkpoint: None,
            failure: None,
            cancel: None,
            artifacts: None,
            lease: manifest.lease.clone(),
            last_event_sequence: 0,
        };
        self.append_event(
            &mut state,
            "job.submitted",
            Some(JobStatus::Queued),
            serde_json::json!({ "manifestSha256": manifest_sha256 }),
        )?;
        Ok(true)
    }

    /// Appends one event and persists the state that references it. The
    /// event line is durable before state.json points at it; a crash between
    /// the two is repaired by reading the log's actual tail on next append.
    pub fn append_event(
        &self,
        state: &mut JobState,
        event: &str,
        status: Option<JobStatus>,
        data: serde_json::Value,
    ) -> Result<u64> {
        let events_path = self.events_path();
        let sequence = last_sequence(&events_path)?.max(state.last_event_sequence) + 1;
        let record = JobEvent {
            schema: JOB_EVENT_SCHEMA.to_owned(),
            sequence,
            timestamp: now_rfc3339(),
            job_id: self.job_id.clone(),
            attempt: state.attempt,
            event: event.to_owned(),
            status,
            lease: state.lease.clone(),
            data,
        };
        let line = serde_json::to_vec(&record).map_err(|source| RunnerError::Json {
            path: events_path.clone(),
            source,
        })?;
        append_line(&events_path, &line)?;
        state.last_event_sequence = sequence;
        if let Some(status) = status {
            state.status = status;
        }
        self.save_state(state)?;
        Ok(sequence)
    }

    /// Reads events with `sequence > after`.
    pub fn read_events(&self, after: u64) -> Result<Vec<JobEvent>> {
        let path = self.events_path();
        let text = match fs::read_to_string(&path) {
            Ok(text) => text,
            Err(source) if source.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(source) => return Err(RunnerError::io(&path, source)),
        };
        let mut events = Vec::new();
        for line in text.lines() {
            if line.is_empty() {
                continue;
            }
            let event: JobEvent =
                serde_json::from_str(line).map_err(|source| RunnerError::Json {
                    path: path.clone(),
                    source,
                })?;
            if event.sequence > after {
                events.push(event);
            }
        }
        Ok(events)
    }
}

/// Sequence of the last complete line in the event log (0 when empty).
fn last_sequence(path: &Path) -> Result<u64> {
    let mut file = match fs::File::open(path) {
        Ok(file) => file,
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(source) => return Err(RunnerError::io(path, source)),
    };
    let len = file
        .metadata()
        .map_err(|source| RunnerError::io(path, source))?
        .len();
    if len == 0 {
        return Ok(0);
    }
    let window = len.min(64 * 1024);
    file.seek(SeekFrom::Start(len - window))
        .map_err(|source| RunnerError::io(path, source))?;
    let mut tail = Vec::with_capacity(window as usize);
    file.read_to_end(&mut tail)
        .map_err(|source| RunnerError::io(path, source))?;
    let tail = String::from_utf8_lossy(&tail);
    for line in tail.lines().rev() {
        if line.is_empty() {
            continue;
        }
        if let Ok(event) = serde_json::from_str::<JobEvent>(line) {
            return Ok(event.sequence);
        }
        // A torn final line (crash mid-append) is skipped; the previous
        // complete line carries the authoritative sequence.
    }
    Ok(0)
}

/// Lists job directories under `jobs_root`, newest first by state update.
pub fn list_job_dirs(jobs_root: &Path) -> Result<Vec<JobDir>> {
    ensure_dir(jobs_root)?;
    let mut dirs = Vec::new();
    for entry in fs::read_dir(jobs_root).map_err(|source| RunnerError::io(jobs_root, source))? {
        let entry = entry.map_err(|source| RunnerError::io(jobs_root, source))?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !is_valid_job_id(name) {
            continue;
        }
        let dir = JobDir {
            job_id: name.to_owned(),
            path: entry.path(),
        };
        if dir.exists() {
            dirs.push(dir);
        }
    }
    dirs.sort_by(|a, b| a.job_id.cmp(&b.job_id));
    Ok(dirs)
}
