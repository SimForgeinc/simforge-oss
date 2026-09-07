//! Operating-system primitives behind one portable surface.
//!
//! Everything the runner needs from the kernel that `std` does not expose
//! uniformly lives here: process-ownership locks, detached execution,
//! termination requests, durable renames, read-only publication and capacity
//! probes. Each function has one implementation per family with identical
//! semantics; nothing is cfg-disabled into a no-op.
//!
//! | need                       | Unix (Linux, macOS)              | Windows                                              |
//! |----------------------------|----------------------------------|------------------------------------------------------|
//! | ownership lock             | `flock(LOCK_EX\|LOCK_NB)`        | `LockFileEx` on one byte past any record             |
//! | detach from launcher       | `setsid()` before exec           | `CREATE_NEW_PROCESS_GROUP \| CREATE_NO_WINDOW`      |
//! | ask a runner to stop       | `kill(pid, SIGTERM)`             | set the runner's named event `Local\…Terminate.<pid>`|
//! | ask a provider child to stop | `kill(pid, SIGTERM)`           | `GenerateConsoleCtrlEvent(CTRL_BREAK, group)`        |
//! | receive a stop request     | `sigaction(SIGTERM/SIGINT)`, `SIGHUP` ignored | console ctrl handler + named-event waiter |
//! | durable rename             | `rename(2)` + directory fsync    | `MoveFileExW(MOVEFILE_WRITE_THROUGH)` + dir flush    |
//! | exclusive publish          | `link(2)`                        | `MoveFileExW` without `REPLACE_EXISTING`             |
//! | read-only blob             | `chmod 0444`                     | `FILE_ATTRIBUTE_READONLY`                            |
//! | memory / free space        | `sysconf`, `statvfs`             | `GlobalMemoryStatusEx`, `GetDiskFreeSpaceExW`        |
//!
//! The Windows lock is a byte-range lock one byte long at
//! `LOCK_BYTE_OFFSET`, far beyond any owner record, because a
//! Windows exclusive range lock also blocks *reads* of the locked bytes by
//! other processes; the owner record itself must stay readable so `holder`
//! can report who has the job. The kernel releases either kind of lock when
//! the owning process ends, which is the liveness property the runner relies
//! on.

#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;

#[cfg(unix)]
pub use unix::*;
#[cfg(windows)]
pub use windows::*;

use std::path::{Path, PathBuf};

/// Interpreter inside a Python virtual environment created by `python -m venv`
/// (`bin/python` on Unix, `Scripts\python.exe` on Windows).
pub fn venv_python(venv_dir: &Path) -> PathBuf {
    if cfg!(windows) {
        venv_dir.join("Scripts").join("python.exe")
    } else {
        venv_dir.join("bin").join("python")
    }
}
