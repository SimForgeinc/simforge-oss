//! Process-ownership locks. A lock is an `flock(LOCK_EX | LOCK_NB)` on a file
//! whose content names the owner. The kernel releases the lock when the owner
//! process dies for any reason, so liveness is determined by the lock itself,
//! never by parsing a pid that may have been reused.

use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::clock::now_rfc3339;
use crate::error::{Result, RunnerError};

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

fn flock(file: &File, operation: libc::c_int) -> std::io::Result<()> {
    // SAFETY: `file` is an open descriptor for the duration of the call.
    let status = unsafe { libc::flock(file.as_raw_fd(), operation) };
    if status == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
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
        match flock(&file, libc::LOCK_EX | libc::LOCK_NB) {
            Ok(()) => {}
            Err(source) if source.raw_os_error() == Some(libc::EWOULDBLOCK) => {
                return Ok(LockAttempt::Held(read_owner(&mut file)));
            }
            Err(source) => return Err(RunnerError::io(path, source)),
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
        match flock(&file, libc::LOCK_EX | libc::LOCK_NB) {
            Ok(()) => {
                let _ = flock(&file, libc::LOCK_UN);
                Ok(None)
            }
            Err(source) if source.raw_os_error() == Some(libc::EWOULDBLOCK) => {
                Ok(Some(read_owner(&mut file).unwrap_or(LockOwner {
                    pid: 0,
                    started_at: String::new(),
                    purpose: "unreadable owner record".into(),
                })))
            }
            Err(source) => Err(RunnerError::io(path, source)),
        }
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
        let _ = flock(&self.file, libc::LOCK_UN);
    }
}

fn read_owner(file: &mut File) -> Option<LockOwner> {
    let mut bytes = Vec::new();
    file.seek(SeekFrom::Start(0)).ok()?;
    file.read_to_end(&mut bytes).ok()?;
    serde_json::from_slice(&bytes).ok()
}
