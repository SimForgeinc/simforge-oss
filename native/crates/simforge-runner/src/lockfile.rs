//! Process-ownership locks. A lock is an exclusive, non-blocking kernel lock
//! ([`platform::try_lock_exclusive`]: `flock` on Unix, a byte-range
//! `LockFileEx` on Windows) on a file whose content names the owner. The
//! kernel releases the lock when the owner process dies for any reason, so
//! liveness is determined by the lock itself, never by parsing a pid that may
//! have been reused.

use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::clock::now_rfc3339;
use crate::error::{Result, RunnerError};
use crate::platform;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LockOwner {
    pub pid: u32,
    pub started_at: String,
    pub purpose: String,
}

/// An exclusive lock held for the lifetime of the value.
#[derive(Debug)]
pub struct FileLock {
    file: File,
    path: PathBuf,
}

pub enum LockAttempt {
    Acquired(FileLock),
    Held(Option<LockOwner>),
}

impl FileLock {
    /// Tries to take the lock without blocking. On success the owner record is
    /// written; on contention the current owner record (if readable) is
    /// returned.
    pub fn try_acquire(path: &Path, purpose: &str) -> Result<LockAttempt> {
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)
            .map_err(|source| RunnerError::io(path, source))?;
        if !platform::try_lock_exclusive(&file).map_err(|source| RunnerError::io(path, source))? {
            return Ok(LockAttempt::Held(read_owner(&mut file)));
        }
        let owner = LockOwner {
            pid: std::process::id(),
            started_at: now_rfc3339(),
            purpose: purpose.to_owned(),
        };
        let bytes = serde_json::to_vec(&owner).map_err(|source| RunnerError::Json {
            path: path.to_path_buf(),
            source,
        })?;
        file.set_len(0)
            .map_err(|source| RunnerError::io(path, source))?;
        file.seek(SeekFrom::Start(0))
            .map_err(|source| RunnerError::io(path, source))?;
        file.write_all(&bytes)
            .map_err(|source| RunnerError::io(path, source))?;
        file.sync_all()
            .map_err(|source| RunnerError::io(path, source))?;
        Ok(LockAttempt::Acquired(FileLock {
            file,
            path: path.to_path_buf(),
        }))
    }

    /// Reports the current holder of `path` without acquiring it. `None`
    /// means nobody holds the lock.
    pub fn holder(path: &Path) -> Result<Option<LockOwner>> {
        let mut file = match OpenOptions::new().read(true).write(true).open(path) {
            Ok(file) => file,
            Err(source) if source.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(source) => return Err(RunnerError::io(path, source)),
        };
        if platform::try_lock_exclusive(&file).map_err(|source| RunnerError::io(path, source))? {
            let _ = platform::unlock(&file);
            return Ok(None);
        }
        Ok(Some(read_owner(&mut file).unwrap_or(LockOwner {
            pid: 0,
            started_at: String::new(),
            purpose: "unreadable owner record".into(),
        })))
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for FileLock {
    fn drop(&mut self) {
        // Clearing the record before unlocking keeps `holder` from reporting a
        // dead owner between unlock and the next acquisition.
        let _ = self.file.set_len(0);
        let _ = platform::unlock(&self.file);
    }
}

fn read_owner(file: &mut File) -> Option<LockOwner> {
    let mut bytes = Vec::new();
    file.seek(SeekFrom::Start(0)).ok()?;
    file.read_to_end(&mut bytes).ok()?;
    serde_json::from_slice(&bytes).ok()
}
