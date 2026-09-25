//! Opening the user's browser for `simforge login`, and deciding up front
//! whether there is one to open. Every decision carries its reason, which
//! `login` states; nothing switches flows silently.

use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// A command that opens a URL (`BROWSER` convention: the URL is its last argument).
pub const BROWSER_ENV: &str = "BROWSER";

fn env_nonempty(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())
}

/// Why no browser can be used on this machine, or `None` when one can.
pub fn unavailable_reason() -> Option<String> {
    if env_nonempty(BROWSER_ENV).is_some() {
        return None;
    }
    for var in ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"] {
        if env_nonempty(var).is_some() {
            return Some(format!("this is an SSH session ({var} is set)"));
        }
    }
    if cfg!(all(unix, not(target_os = "macos")))
        && env_nonempty("DISPLAY").is_none()
        && env_nonempty("WAYLAND_DISPLAY").is_none()
    {
        return Some(
            "there is no graphical session (DISPLAY and WAYLAND_DISPLAY are unset)".into(),
        );
    }
    None
}

fn launcher(url: &str) -> Command {
    if let Some(browser) = env_nonempty(BROWSER_ENV) {
        let mut parts = browser.split_whitespace();
        let mut command = Command::new(parts.next().expect("BROWSER is non-empty"));
        command.args(parts).arg(url);
        return command;
    }
    if cfg!(target_os = "macos") {
        let mut command = Command::new("open");
        command.arg(url);
        command
    } else if cfg!(windows) {
        let mut command = Command::new("rundll32");
        command.arg("url.dll,FileProtocolHandler").arg(url);
        command
    } else {
        let mut command = Command::new("xdg-open");
        command.arg(url);
        command
    }
}

/// Launch the browser at `url`. `Ok(launcher)` once the launcher accepted it,
/// `Err(reason)` otherwise. The launcher's output never reaches stdout.
pub fn open(url: &str) -> Result<String, String> {
    let mut command = launcher(url);
    let name = command.get_program().to_string_lossy().into_owned();
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("{name} could not be started: {e}"))?;
    // Launchers hand the URL to a running browser and exit; one that is
    // still running after a few seconds is the browser itself (fine).
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(name),
            Ok(Some(status)) => return Err(format!("{name} exited with {status}")),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            Ok(None) => return Ok(name),
            Err(e) => return Err(format!("{name}: {e}")),
        }
    }
}
