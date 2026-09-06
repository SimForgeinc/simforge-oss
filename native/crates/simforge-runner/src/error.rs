//! Runner errors carry a stable machine code and an exit class matching the
//! SIMFORGE CLI contract: exit `1` means the command could not run, exit `2`
//! means it ran and rejected the input (manifest, hashes, job state).

use std::path::PathBuf;

use serde::Serialize;

/// Exit class per the CLI contract (`0` ok, `1` cannot run, `2` input rejected).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitClass {
    CannotRun = 1,
    Rejected = 2,
}

#[derive(Debug, thiserror::Error)]
pub enum RunnerError {
    #[error("{reason}")]
    Usage { reason: String },
    #[error("io error at {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("invalid JSON at {path}: {source}")]
    Json {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
    #[error("invalid job manifest: {reason}")]
    Manifest { reason: String },
    #[error("runtime manifest {path}: {reason}")]
    Runtime { path: PathBuf, reason: String },
    #[error("job {job_id}: {reason}")]
    JobState { job_id: String, reason: String },
    #[error("job {job_id} not found under {root}")]
    JobNotFound { job_id: String, root: PathBuf },
    #[error("job {job_id} is owned by pid {pid}")]
    JobOwned { job_id: String, pid: u32 },
    #[error("content {sha256} ({reason})")]
    Content { sha256: String, reason: String },
    #[error("integrity mismatch for {path}: expected {expected_sha256}/{expected_size}, got {actual_sha256}/{actual_size}")]
    Integrity {
        path: PathBuf,
        expected_sha256: String,
        expected_size: u64,
        actual_sha256: String,
        actual_size: u64,
    },
    #[error("resource admission refused: {reason}")]
    Admission { reason: String },
    #[error("engine {workload}: {reason}")]
    Engine { workload: String, reason: String },
    #[error("no engine registered for workload {workload}; available: {available:?}")]
    EngineUnavailable {
        workload: String,
        available: Vec<String>,
    },
    #[error("artifact contract violated: {reason}")]
    Artifact { reason: String },
    #[error("canceled: {reason}")]
    Canceled { reason: String },
    #[error("supervisor: {reason}")]
    Supervisor { reason: String },
}

impl RunnerError {
    pub fn io(path: impl Into<PathBuf>, source: std::io::Error) -> Self {
        Self::Io {
            path: path.into(),
            source,
        }
    }

    pub fn code(&self) -> &'static str {
        match self {
            Self::Usage { .. } => "runner.usage",
            Self::Io { .. } => "runner.io",
            Self::Json { .. } => "runner.invalid_json",
            Self::Manifest { .. } => "job.invalid_manifest",
            Self::Runtime { .. } => "runtime.manifest_invalid",
            Self::JobState { .. } => "job.invalid_state",
            Self::JobNotFound { .. } => "job.not_found",
            Self::JobOwned { .. } => "job.owned_by_other_process",
            Self::Content { .. } => "content.unresolved",
            Self::Integrity { .. } => "content.integrity_mismatch",
            Self::Admission { .. } => "resources.admission_refused",
            Self::Engine { .. } => "engine.failed",
            Self::EngineUnavailable { .. } => "engine.unavailable",
            Self::Artifact { .. } => "artifact.contract_violated",
            Self::Canceled { .. } => "job.canceled",
            Self::Supervisor { .. } => "supervisor.failed",
        }
    }

    pub fn exit_class(&self) -> ExitClass {
        match self {
            Self::Manifest { .. }
            | Self::JobState { .. }
            | Self::Integrity { .. }
            | Self::Artifact { .. }
            | Self::Admission { .. }
            | Self::Content { .. } => ExitClass::Rejected,
            _ => ExitClass::CannotRun,
        }
    }

    /// Whether an attempt that failed with this error may be retried by a new
    /// attempt against the same immutable inputs (after the operator fixes
    /// the worker: missing content, capacity, I/O).
    pub fn retryable(&self) -> bool {
        matches!(
            self,
            Self::Io { .. }
                | Self::Engine { .. }
                | Self::Admission { .. }
                | Self::Supervisor { .. }
                | Self::Content { .. }
                | Self::Integrity { .. }
        )
    }

    pub fn path(&self) -> Option<&std::path::Path> {
        match self {
            Self::Io { path, .. }
            | Self::Json { path, .. }
            | Self::Runtime { path, .. }
            | Self::Integrity { path, .. } => Some(path),
            _ => None,
        }
    }

    /// The structured stderr document: `{code, path?, reason, detail?}`.
    pub fn report(&self) -> ErrorReport {
        let detail = std::error::Error::source(self).map(|source| source.to_string());
        ErrorReport {
            code: self.code(),
            path: self.path().map(|path| path.display().to_string()),
            reason: self.to_string(),
            detail,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorReport {
    pub code: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

pub type Result<T, E = RunnerError> = std::result::Result<T, E>;
