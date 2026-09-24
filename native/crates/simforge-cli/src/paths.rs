//! Where things live on disk and which registry is asked. Every resolved
//! location carries its `source` so `doctor` and every command's JSON can say
//! *why* a path was chosen; nothing is picked silently.
//!
//! The conventions match the TypeScript CLI and the compiler
//! (`SIMFORGE_MAPS_CACHE_ROOT`, else `${XDG_DATA_HOME:-~/.local/share}/simforge/maps`),
//! so a map pulled by either is found by both.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::contract::CliError;

/// The public map registry (CloudFront in front of `simforge-maps-public`).
/// Only `richmond-field-station` is published there.
pub const PUBLIC_REGISTRY_URL: &str = "https://da3tufozhdsvl.cloudfront.net";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Resolved<T> {
    pub value: T,
    /// `flag:--x`, `env:NAME`, `xdg`, `home` or `default`.
    pub source: String,
}

fn env_nonempty(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())
}

/// `$XDG_DATA_HOME` when set and absolute (the XDG spec says to ignore a
/// relative one), else `$HOME/.local/share`.
pub fn data_home() -> Result<Resolved<PathBuf>, CliError> {
    if let Some(xdg) = env_nonempty("XDG_DATA_HOME") {
        let path = PathBuf::from(xdg);
        if path.is_absolute() {
            return Ok(Resolved {
                value: path,
                source: "env:XDG_DATA_HOME".into(),
            });
        }
    }
    let home = env_nonempty("HOME")
        .or_else(|| env_nonempty("USERPROFILE"))
        .ok_or_else(|| {
            CliError::new(
                "no_home",
                "neither XDG_DATA_HOME nor HOME is set, so there is no data directory to use",
            )
            .with_detail(
                serde_json::json!({ "hint": "set XDG_DATA_HOME, or pass the root explicitly" }),
            )
        })?;
    Ok(Resolved {
        value: Path::new(&home).join(".local").join("share"),
        source: "home".into(),
    })
}

fn root(
    flag: Option<&Path>,
    flag_name: &str,
    env: &str,
    leaf: &str,
) -> Result<Resolved<PathBuf>, CliError> {
    if let Some(path) = flag {
        return Ok(Resolved {
            value: absolutize(path),
            source: format!("flag:{flag_name}"),
        });
    }
    if let Some(value) = env_nonempty(env) {
        return Ok(Resolved {
            value: absolutize(Path::new(&value)),
            source: format!("env:{env}"),
        });
    }
    let base = data_home()?;
    let source = if base.source == "home" { "home" } else { "xdg" };
    Ok(Resolved {
        value: base.value.join("simforge").join(leaf),
        source: source.into(),
    })
}

/// The map cache: `--cache-root`, `SIMFORGE_MAPS_CACHE_ROOT`, then the data home.
pub fn maps_root(flag: Option<&Path>) -> Result<Resolved<PathBuf>, CliError> {
    root(flag, "--cache-root", "SIMFORGE_MAPS_CACHE_ROOT", "maps")
}

/// The actor-asset store: `--root`, `SIMFORGE_ACTOR_ASSETS_ROOT`, then the data home.
pub fn assets_root(flag: Option<&Path>) -> Result<Resolved<PathBuf>, CliError> {
    root(flag, "--root", "SIMFORGE_ACTOR_ASSETS_ROOT", "actor-assets")
}

/// The map registry: `--registry`, `SIMFORGE_MAPS_REGISTRY`, `SIMFORGE_MAPS_PUBLIC_URL`,
/// then the public registry.
pub fn registry_url(flag: Option<&str>) -> Resolved<String> {
    if let Some(url) = flag {
        return Resolved {
            value: url.trim_end_matches('/').to_owned(),
            source: "flag:--registry".into(),
        };
    }
    for env in ["SIMFORGE_MAPS_REGISTRY", "SIMFORGE_MAPS_PUBLIC_URL"] {
        if let Some(url) = env_nonempty(env) {
            return Resolved {
                value: url.trim_end_matches('/').to_owned(),
                source: format!("env:{env}"),
            };
        }
    }
    Resolved {
        value: PUBLIC_REGISTRY_URL.to_owned(),
        source: "default".into(),
    }
}

/// A path made absolute against the current directory (no symlink resolution,
/// so the reported path is the one the user wrote).
pub fn absolutize(path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map(|cwd| cwd.join(path))
            .unwrap_or_else(|_| path.to_path_buf())
    }
}
