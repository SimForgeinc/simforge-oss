//! Unix (Linux, macOS) implementation; see the table in `platform/mod.rs`.
//! This is the behaviour the qualified Linux x86_64 runtime has always had.

use std::fs::{self, File};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::io::AsRawFd;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, Ordering};

/// Name of the termination request in error messages.
pub const TERMINATION_REQUEST: &str = "SIGTERM";

fn flock(file: &File, operation: libc::c_int) -> std::io::Result<()> {
    // SAFETY: `file` is an open descriptor for the duration of the call.
    let status = unsafe { libc::flock(file.as_raw_fd(), operation) };
    if status == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

/// `Ok(true)` when this process now holds the exclusive lock, `Ok(false)`
/// when another process holds it.
pub fn try_lock_exclusive(file: &File) -> std::io::Result<bool> {
    match flock(file, libc::LOCK_EX | libc::LOCK_NB) {
        Ok(()) => Ok(true),
        Err(source) if source.raw_os_error() == Some(libc::EWOULDBLOCK) => Ok(false),
        Err(source) => Err(source),
    }
}

pub fn unlock(file: &File) -> std::io::Result<()> {
    flock(file, libc::LOCK_UN)
}

/// Runs the child in a new session so it survives the launching terminal or
/// UI going away; stdio is the caller's responsibility.
pub fn detach_command(command: &mut Command) {
    // SAFETY: setsid is async-signal-safe and only detaches the child from
    // the parent's session/controlling terminal.
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

/// Prepares a provider child so [`request_child_termination`] can address
/// it. SIGTERM addresses a pid directly; nothing to configure here.
pub fn prepare_terminable_child(_command: &mut Command) {}

/// Asks the runner process `pid` to stop at its next safe boundary.
pub fn request_termination(pid: u32) -> std::io::Result<()> {
    // SAFETY: kill with SIGTERM on a pid the caller observed holding a lock;
    // a stale pid at worst signals nothing or fails with ESRCH.
    let status = unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) };
    if status == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

/// Asks a provider child we spawned to checkpoint and exit 130.
pub fn request_child_termination(child: &Child) -> std::io::Result<()> {
    request_termination(child.id())
}

static TERMINATED: AtomicBool = AtomicBool::new(false);

extern "C" fn on_signal(_signal: libc::c_int) {
    TERMINATED.store(true, Ordering::SeqCst);
}

/// SIGTERM/SIGINT mark termination; SIGHUP is ignored so a detached job
/// survives its launching terminal or UI going away. Idempotent.
pub fn install_termination_handlers() -> std::io::Result<()> {
    static INSTALL: std::sync::Once = std::sync::Once::new();
    INSTALL.call_once(|| {
        // SAFETY: sigaction with a plain async-signal-safe handler that only
        // stores to an atomic.
        unsafe {
            let mut action: libc::sigaction = std::mem::zeroed();
            action.sa_sigaction = on_signal as extern "C" fn(libc::c_int) as usize;
            libc::sigemptyset(&mut action.sa_mask);
            action.sa_flags = libc::SA_RESTART;
            libc::sigaction(libc::SIGTERM, &action, std::ptr::null_mut());
            libc::sigaction(libc::SIGINT, &action, std::ptr::null_mut());
            libc::signal(libc::SIGHUP, libc::SIG_IGN);
        }
    });
    Ok(())
}

/// Whether a termination request has been delivered to this process.
pub fn termination_requested() -> bool {
    TERMINATED.load(Ordering::SeqCst)
}

/// Makes a published file read-only for everyone (`0444`).
pub fn set_read_only(path: &Path) -> std::io::Result<()> {
    fs::set_permissions(path, fs::Permissions::from_mode(0o444))
}

/// Removes a file regardless of its read-only mode (unlink only needs
/// directory write permission on Unix).
pub fn remove_file_force(path: &Path) -> std::io::Result<()> {
    fs::remove_file(path)
}

/// fsyncs a file by path; works on read-only files because fsync needs no
/// write access on Unix.
pub fn sync_file(path: &Path) -> std::io::Result<()> {
    File::open(path)?.sync_all()
}

/// fsyncs a directory so a completed rename/link inside it is durable.
pub fn sync_dir(dir: &Path) -> std::io::Result<()> {
    File::open(dir)?.sync_all()
}

/// Atomically replaces the file `to` with `from` (same filesystem).
pub fn rename_file_replace(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::rename(from, to)
}

/// Renames the directory `from` to `to`; fails if `to` is non-empty.
pub fn rename_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::rename(from, to)
}

/// Makes `target` exist with the bytes of `temp`, failing with
/// `AlreadyExists` if `target` is present: `link(2)` refuses to overwrite, so
/// two racing publishers cannot both win. `temp` remains and the caller
/// removes it.
pub fn publish_file_exclusive(temp: &Path, target: &Path) -> std::io::Result<()> {
    fs::hard_link(temp, target)
}

pub fn physical_memory_bytes() -> u64 {
    // SAFETY: sysconf has no preconditions; negative results mean "unknown".
    let pages = unsafe { libc::sysconf(libc::_SC_PHYS_PAGES) };
    let page_size = unsafe { libc::sysconf(libc::_SC_PAGE_SIZE) };
    if pages <= 0 || page_size <= 0 {
        return 0;
    }
    (pages as u64).saturating_mul(page_size as u64)
}

/// Bytes available to this user on the filesystem holding `dir`.
pub fn free_bytes(dir: &Path) -> u64 {
    let Ok(c_path) = std::ffi::CString::new(dir.as_os_str().as_encoded_bytes()) else {
        return 0;
    };
    // SAFETY: `stats` is a plain C struct fully written by statvfs on success.
    let mut stats: libc::statvfs = unsafe { std::mem::zeroed() };
    let status = unsafe { libc::statvfs(c_path.as_ptr(), &mut stats) };
    if status != 0 {
        return 0;
    }
    (stats.f_bavail as u64).saturating_mul(stats.f_frsize as u64)
}

/// Default writable worker state when no root is configured:
/// `${XDG_STATE_HOME:-~/.local/state}/simforge/native-runtime` on Linux,
/// `~/Library/Application Support/simforge/native-runtime-state` on macOS.
/// `None` when neither variable is available.
pub fn default_state_root() -> Option<PathBuf> {
    let non_empty = |key: &str| std::env::var_os(key).filter(|value| !value.is_empty());
    if cfg!(target_os = "macos") {
        return non_empty("HOME").map(|home| {
            PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join("simforge")
                .join("native-runtime-state")
        });
    }
    let state_home = match non_empty("XDG_STATE_HOME") {
        Some(dir) => PathBuf::from(dir),
        None => PathBuf::from(non_empty("HOME")?).join(".local").join("state"),
    };
    Some(state_home.join("simforge").join("native-runtime"))
}

/// Environment variables consulted by [`default_state_root`], for messages.
pub const STATE_ROOT_ENV_HINT: &str = "XDG_STATE_HOME or HOME";
