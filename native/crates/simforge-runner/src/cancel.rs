//! Cooperative cancellation. Engines poll the token at safe boundaries (tick,
//! episode, checkpoint); the token trips on a `cancel.request` document in
//! the job directory, on a termination request delivered to the owning
//! process (SIGTERM/SIGINT on Unix; the runner's named event or a console
//! control event on Windows, see [`platform`]), or when the attempt's
//! wall-clock budget elapses.

use std::cell::{Cell, RefCell};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::clock::now_rfc3339;
use crate::error::{Result, RunnerError};
use crate::fsatomic::{read_json, write_json_atomic};
use crate::platform;

pub const CANCEL_REQUEST_FILE: &str = "cancel.request";
const FILE_POLL_INTERVAL: Duration = Duration::from_millis(250);

/// Installs the OS termination-request handlers for this process so a
/// `cancel` from another process trips every token at its next poll.
pub fn install_signal_handlers() -> Result<()> {
    platform::install_termination_handlers().map_err(|source| RunnerError::Supervisor {
        reason: format!("cannot receive termination requests: {source}"),
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelRequest {
    pub reason: String,
    pub requested_at: String,
    pub requested_by_pid: u32,
}

impl CancelRequest {
    pub fn path(job_dir: &Path) -> PathBuf {
        job_dir.join(CANCEL_REQUEST_FILE)
    }

    pub fn write(job_dir: &Path, reason: &str) -> Result<Self> {
        let request = CancelRequest {
            reason: reason.to_owned(),
            requested_at: now_rfc3339(),
            requested_by_pid: std::process::id(),
        };
        write_json_atomic(&Self::path(job_dir), &request)?;
        Ok(request)
    }

    pub fn read(job_dir: &Path) -> Result<Option<Self>> {
        let path = Self::path(job_dir);
        if !path.exists() {
            return Ok(None);
        }
        read_json(&path).map(Some)
    }
}

/// Polled by the engine. Not `Sync`: one token per attempt, on the thread
/// that steps the job. Engines that step on worker threads check it from the
/// coordinating thread at their own batch boundaries.
#[derive(Debug)]
pub struct CancelToken {
    request_path: PathBuf,
    deadline: Option<Instant>,
    started: Instant,
    last_file_poll: Cell<Option<Instant>>,
    tripped: RefCell<Option<CancelReason>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CancelReason {
    Requested {
        reason: String,
        requested_at: String,
    },
    Signal,
    WallClockExceeded {
        budget_seconds: u64,
    },
}

impl CancelReason {
    pub fn message(&self) -> String {
        match self {
            CancelReason::Requested { reason, .. } => reason.clone(),
            CancelReason::Signal => "owning process received a termination request".into(),
            CancelReason::WallClockExceeded { budget_seconds } => {
                format!("wall clock budget of {budget_seconds}s exceeded")
            }
        }
    }
}

impl CancelToken {
    pub fn new(job_dir: &Path, wall_clock_seconds: Option<u64>) -> Self {
        let started = Instant::now();
        CancelToken {
            request_path: CancelRequest::path(job_dir),
            deadline: wall_clock_seconds.map(|seconds| started + Duration::from_secs(seconds)),
            started,
            last_file_poll: Cell::new(None),
            tripped: RefCell::new(None),
        }
    }

    /// Returns the reason once the token has tripped. Cheap: the request
    /// file is consulted at most every 250 ms.
    pub fn reason(&self) -> Option<CancelReason> {
        if let Some(reason) = self.tripped.borrow().as_ref() {
            return Some(reason.clone());
        }
        if platform::termination_requested() {
            return self.trip(CancelReason::Signal);
        }
        if let Some(deadline) = self.deadline {
            if Instant::now() >= deadline {
                let budget_seconds = (deadline - self.started).as_secs();
                return self.trip(CancelReason::WallClockExceeded { budget_seconds });
            }
        }
        let now = Instant::now();
        let due = self
            .last_file_poll
            .get()
            .map_or(true, |last| now - last >= FILE_POLL_INTERVAL);
        if due {
            self.last_file_poll.set(Some(now));
            if self.request_path.exists() {
                if let Ok(request) = read_json::<CancelRequest>(&self.request_path) {
                    return self.trip(CancelReason::Requested {
                        reason: request.reason,
                        requested_at: request.requested_at,
                    });
                }
            }
        }
        None
    }

    fn trip(&self, reason: CancelReason) -> Option<CancelReason> {
        *self.tripped.borrow_mut() = Some(reason.clone());
        Some(reason)
    }

    pub fn is_canceled(&self) -> bool {
        self.reason().is_some()
    }

    /// The engine-facing form: `Err(RunnerError::Canceled)` once tripped.
    pub fn check(&self) -> Result<()> {
        match self.reason() {
            Some(reason) => Err(RunnerError::Canceled {
                reason: reason.message(),
            }),
            None => Ok(()),
        }
    }
}
