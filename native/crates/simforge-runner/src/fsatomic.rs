//! Crash-safe filesystem primitives. Every persisted runner document is
//! written to a sibling temporary file, fsynced, renamed over the target and
//! the directory is flushed, so a reader never observes a torn document. The
//! rename/link/flush calls come from [`platform`] (POSIX rename + directory
//! fsync on Unix; `MoveFileExW` write-through + directory flush on Windows).

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::error::{Result, RunnerError};
use crate::platform;

fn temp_sibling(target: &Path) -> PathBuf {
    let name = target
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0);
    target.with_file_name(format!(
        ".{name}.{pid}.{nanos}.part",
        pid = std::process::id()
    ))
}

pub fn fsync_dir(dir: &Path) -> Result<()> {
    platform::sync_dir(dir).map_err(|source| RunnerError::io(dir, source))
}

/// Atomically replaces `target` with `bytes`.
pub fn write_atomic(target: &Path, bytes: &[u8]) -> Result<()> {
    let parent = target.parent().ok_or_else(|| RunnerError::Usage {
        reason: format!("{} has no parent", target.display()),
    })?;
    let temp = temp_sibling(target);
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|source| RunnerError::io(&temp, source))?;
        file.write_all(bytes)
            .map_err(|source| RunnerError::io(&temp, source))?;
        file.sync_all()
            .map_err(|source| RunnerError::io(&temp, source))?;
        platform::rename_file_replace(&temp, target)
            .map_err(|source| RunnerError::io(target, source))?;
        fsync_dir(parent)
    })();
    if result.is_err() {
        let _ = platform::remove_file_force(&temp);
    }
    result
}

/// Atomically creates `target`; fails with `AlreadyExists` if it is present.
/// Two racing creators cannot both win: the publication primitive refuses an
/// existing target (`link(2)` on Unix, a non-replacing move on Windows).
pub fn create_exclusive(target: &Path, bytes: &[u8]) -> Result<()> {
    let parent = target.parent().ok_or_else(|| RunnerError::Usage {
        reason: format!("{} has no parent", target.display()),
    })?;
    let temp = temp_sibling(target);
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|source| RunnerError::io(&temp, source))?;
        file.write_all(bytes)
            .map_err(|source| RunnerError::io(&temp, source))?;
        file.sync_all()
            .map_err(|source| RunnerError::io(&temp, source))?;
        platform::publish_file_exclusive(&temp, target)
            .map_err(|source| RunnerError::io(target, source))?;
        fsync_dir(parent)
    })();
    let _ = platform::remove_file_force(&temp);
    result
}

pub fn write_json_atomic<T: Serialize>(target: &Path, value: &T) -> Result<()> {
    let mut bytes = serde_json::to_vec_pretty(value).map_err(|source| RunnerError::Json {
        path: target.to_path_buf(),
        source,
    })?;
    bytes.push(b'\n');
    write_atomic(target, &bytes)
}

pub fn read_json<T: DeserializeOwned>(path: &Path) -> Result<T> {
    let bytes = fs::read(path).map_err(|source| RunnerError::io(path, source))?;
    serde_json::from_slice(&bytes).map_err(|source| RunnerError::Json {
        path: path.to_path_buf(),
        source,
    })
}

/// Appends one line and fsyncs; used for the append-only event log.
pub fn append_line(path: &Path, line: &[u8]) -> Result<()> {
    let mut file = OpenOptions::new()
        .append(true)
        .create(true)
        .open(path)
        .map_err(|source| RunnerError::io(path, source))?;
    file.write_all(line)
        .map_err(|source| RunnerError::io(path, source))?;
    file.write_all(b"\n")
        .map_err(|source| RunnerError::io(path, source))?;
    file.sync_data()
        .map_err(|source| RunnerError::io(path, source))
}

/// Publishes a fully written staging directory at `target` by rename. The
/// rename fails if `target` already exists, so a publication is exactly-once.
pub fn publish_dir(staging: &Path, target: &Path) -> Result<()> {
    let parent = target.parent().ok_or_else(|| RunnerError::Usage {
        reason: format!("{} has no parent", target.display()),
    })?;
    if target.exists() {
        return Err(RunnerError::io(
            target,
            std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                "publication target exists",
            ),
        ));
    }
    fsync_tree(staging)?;
    platform::rename_dir(staging, target).map_err(|source| RunnerError::io(target, source))?;
    fsync_dir(parent)
}

/// fsyncs every file and directory under `root` (used before publishing a
/// staging tree written by an engine that may not have synced its files).
pub fn fsync_tree(root: &Path) -> Result<()> {
    for entry in fs::read_dir(root).map_err(|source| RunnerError::io(root, source))? {
        let entry = entry.map_err(|source| RunnerError::io(root, source))?;
        let path = entry.path();
        let kind = entry
            .file_type()
            .map_err(|source| RunnerError::io(&path, source))?;
        if kind.is_dir() {
            fsync_tree(&path)?;
        } else if kind.is_file() {
            platform::sync_file(&path).map_err(|source| RunnerError::io(&path, source))?;
        }
    }
    fsync_dir(root)
}

pub fn ensure_dir(path: &Path) -> Result<()> {
    fs::create_dir_all(path).map_err(|source| RunnerError::io(path, source))
}

pub fn remove_dir_if_present(path: &Path) -> Result<()> {
    match fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(source) => Err(RunnerError::io(path, source)),
    }
}

/// Removes a file whether or not it is read-only; absent is not an error.
pub fn remove_file_if_present(path: &Path) -> Result<()> {
    match platform::remove_file_force(path) {
        Ok(()) => Ok(()),
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(source) => Err(RunnerError::io(path, source)),
    }
}
