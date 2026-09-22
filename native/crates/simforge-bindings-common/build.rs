//! Build provenance for `engine_build()`.
//!
//! These values say WHICH build produced a trace. They are provenance only:
//! no cache key, digest or compatibility check reads them, because every
//! rebuild would then miss every cache. Trace compatibility is
//! `ENGINE_SEM_VER`, bumped by hand and enforced by the golden-trace corpus.

use std::path::Path;
use std::process::Command;

fn run(cmd: &str, args: &[&str], dir: &Path) -> Option<String> {
    let out = Command::new(cmd).args(args).current_dir(dir).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8(out.stdout).ok()?.trim().to_owned();
    (!text.is_empty()).then_some(text)
}

fn main() {
    let manifest = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default();
    let dir = Path::new(&manifest);
    println!("cargo:rerun-if-env-changed=SIMFORGE_SOURCE_REVISION");
    println!("cargo:rerun-if-changed=build.rs");

    // Explicit revision (CI, packaged builds without .git) wins over git.
    let revision = std::env::var("SIMFORGE_SOURCE_REVISION")
        .ok()
        .filter(|v| !v.is_empty())
        .or_else(|| {
            let head = run("git", &["rev-parse", "HEAD"], dir)?;
            // Re-run when HEAD moves (branch switch or new commit).
            for path in ["HEAD", "index"] {
                if let Some(p) = run("git", &["rev-parse", "--git-path", path], dir) {
                    let p = Path::new(&p);
                    let abs = if p.is_absolute() { p.to_path_buf() } else { dir.join(p) };
                    println!("cargo:rerun-if-changed={}", abs.display());
                }
            }
            if let Some(reference) = run("git", &["symbolic-ref", "-q", "HEAD"], dir) {
                if let Some(p) = run("git", &["rev-parse", "--git-path", &reference], dir) {
                    let p = Path::new(&p);
                    let abs = if p.is_absolute() { p.to_path_buf() } else { dir.join(p) };
                    println!("cargo:rerun-if-changed={}", abs.display());
                }
            }
            let dirty = run("git", &["status", "--porcelain", "--untracked-files=no", "--", "../../"], dir)
                .map(|s| !s.is_empty())
                .unwrap_or(false);
            Some(if dirty { format!("{head}-dirty") } else { head })
        })
        .unwrap_or_else(|| "unknown".to_owned());

    let rustc = std::env::var("RUSTC").unwrap_or_else(|_| "rustc".to_owned());
    let rustc_version = run(&rustc, &["-V"], dir).unwrap_or_else(|| "unknown".to_owned());
    let profile = std::env::var("PROFILE").unwrap_or_else(|_| "unknown".to_owned());
    let target = std::env::var("TARGET").unwrap_or_else(|_| "unknown".to_owned());

    println!("cargo:rustc-env=SIMFORGE_BUILD_SOURCE_REVISION={revision}");
    println!("cargo:rustc-env=SIMFORGE_BUILD_RUSTC={rustc_version}");
    println!("cargo:rustc-env=SIMFORGE_BUILD_PROFILE={profile}");
    println!("cargo:rustc-env=SIMFORGE_BUILD_TARGET={target}");
}
