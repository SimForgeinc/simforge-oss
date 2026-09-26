//! Process limits the CLI adjusts at startup.
//!
//! **Open files.** A render opens map textures, derivatives and actor models
//! by the thousand; the stock Linux soft limit (`RLIMIT_NOFILE`, 1024) is
//! far below what a large map needs, while the hard limit is not. At startup
//! the CLI raises the soft limit to the hard one (the standard practice for
//! tools that open many files; it never touches the hard limit, which needs
//! privileges). The before and after values are reported by `simforge doctor`
//! (check `open-files`) and in `render`'s result (`limits.openFiles`). A raise
//! that fails is reported there too, never hidden. The renderer additionally
//! bounds how many asset files it holds open at once
//! (`render_core::texture_residency::MAX_OPEN_FILES`), so a render does not
//! depend on a high limit.

use std::sync::OnceLock;

use serde_json::{json, Value};

/// What startup did to the open-file limit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenFiles {
    /// Soft limit when the process started.
    pub soft_before: u64,
    /// Soft limit after the raise (equal to `soft_before` when unchanged).
    pub soft_after: u64,
    /// Hard limit (never changed).
    pub hard: u64,
    /// Why the raise failed, if it did.
    pub error: Option<String>,
}

impl OpenFiles {
    pub fn to_json(&self) -> Value {
        json!({
            "softBefore": self.soft_before,
            "softAfter": self.soft_after,
            "hard": self.hard,
            "raised": self.soft_after > self.soft_before,
            "error": self.error,
        })
    }
}

static OPEN_FILES: OnceLock<Option<OpenFiles>> = OnceLock::new();

/// Raise the soft open-file limit to the hard limit, once per process, and
/// remember what happened. `None` where the platform has no such limit
/// (Windows).
pub fn raise_open_files() -> Option<&'static OpenFiles> {
    OPEN_FILES.get_or_init(raise).as_ref()
}

/// `limits` for JSON results: `{"openFiles": {...}}`, or `{"openFiles": null}`
/// on a platform without the limit.
pub fn report() -> Value {
    json!({ "openFiles": raise_open_files().map(OpenFiles::to_json) })
}

#[cfg(unix)]
fn raise() -> Option<OpenFiles> {
    // SAFETY: getrlimit/setrlimit write to / read from a plain struct we own.
    let mut lim = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut lim) } != 0 {
        let error = std::io::Error::last_os_error().to_string();
        return Some(OpenFiles {
            soft_before: 0,
            soft_after: 0,
            hard: 0,
            error: Some(format!("getrlimit(RLIMIT_NOFILE): {error}")),
        });
    }
    let before = lim.rlim_cur;
    let hard = lim.rlim_max;
    let target = target_soft(hard);
    let mut error = None;
    let mut after = before;
    if target > before {
        let raised = libc::rlimit {
            rlim_cur: target,
            rlim_max: hard,
        };
        if unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &raised) } == 0 {
            after = target;
        } else {
            error = Some(format!(
                "setrlimit(RLIMIT_NOFILE, soft {target}): {}",
                std::io::Error::last_os_error()
            ));
        }
    }
    let n = |v: libc::rlim_t| {
        if v == libc::RLIM_INFINITY {
            u64::MAX
        } else {
            v as u64
        }
    };
    Some(OpenFiles {
        soft_before: n(before),
        soft_after: n(after),
        hard: n(hard),
        error,
    })
}

/// The soft limit to ask for: the hard limit, except where the kernel caps a
/// process below an unlimited hard limit (macOS: OPEN_MAX; Linux: nr_open).
#[cfg(unix)]
fn target_soft(hard: libc::rlim_t) -> libc::rlim_t {
    if cfg!(target_os = "macos") {
        // setrlimit refuses a soft limit above OPEN_MAX (10240) on macOS.
        return hard.min(10_240);
    }
    if hard == libc::RLIM_INFINITY {
        let nr_open = std::fs::read_to_string("/proc/sys/fs/nr_open")
            .ok()
            .and_then(|s| s.trim().parse::<u64>().ok())
            .unwrap_or(1_048_576);
        return nr_open as libc::rlim_t;
    }
    hard
}

#[cfg(not(unix))]
fn raise() -> Option<OpenFiles> {
    None
}
