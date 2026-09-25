//! Maps installed in the local cache, found by content.
//!
//! A scenario names its map by the sha256 of the OpenDRIVE it was simulated
//! on (the trace's `engineGraphDigest`, a package's `map.xodrSha256`), never
//! by name alone: two installations can give one publication different names,
//! and one name can hold several versions. This module finds the installed
//! map directory whose `map.xodr` has that digest.
//!
//! Layouts searched under the maps root (see `simforge maps pull`):
//! `dev-assets/<map>` (the semantic profile the compiler reads) and
//! `.corpus/<map>` (the native render profile). The `.map-release.json`
//! receipt names each member's digest; a directory without a receipt is
//! hashed directly.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::contract::CliError;

/// Map sidecars the CPU steps read.
pub const XODR: &str = "map.xodr";
pub const TOPOLOGY: &str = "topology-index.json.gz";
pub const GROUND_MESH: &str = "derived/ground/ground-mesh.bin";

/// Profile directories under the maps root, in search order.
pub const PROFILES: &[&str] = &["dev-assets", ".corpus"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledMap {
    pub name: String,
    pub dir: PathBuf,
    pub profile: String,
    pub xodr_sha256: String,
    /// `name@version` from the receipt, when there is one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub release: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub release_digest: Option<String>,
}

impl InstalledMap {
    pub fn file(&self, member: &str) -> PathBuf {
        member
            .split('/')
            .fold(self.dir.clone(), |p, part| p.join(part))
    }

    pub fn has(&self, member: &str) -> bool {
        self.file(member).is_file()
    }
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(64);
    for b in Sha256::digest(bytes) {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

fn receipt(dir: &Path) -> Option<Value> {
    let bytes = std::fs::read(dir.join(".map-release.json")).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Describe one map directory, or `None` when it has no `map.xodr`.
pub fn describe(dir: &Path, profile: &str) -> Option<InstalledMap> {
    let xodr = dir.join(XODR);
    if !xodr.is_file() {
        return None;
    }
    let name = dir.file_name()?.to_string_lossy().into_owned();
    let receipt = receipt(dir);
    let from_receipt = receipt
        .as_ref()
        .and_then(|r| r["members"][XODR]["sha256"].as_str().map(str::to_owned));
    let xodr_sha256 = match from_receipt {
        Some(digest) => digest,
        None => sha256_hex(&std::fs::read(&xodr).ok()?),
    };
    let release = receipt.as_ref().and_then(|r| {
        Some(format!(
            "{}@{}",
            r["name"].as_str()?,
            r["version"].as_str()?
        ))
    });
    let release_digest = receipt
        .as_ref()
        .and_then(|r| r["releaseDigest"].as_str().map(str::to_owned));
    Some(InstalledMap {
        name,
        dir: dir.to_path_buf(),
        profile: profile.to_owned(),
        xodr_sha256,
        release,
        release_digest,
    })
}

/// Every installed map under `root`, in search order.
pub fn list(root: &Path) -> Vec<InstalledMap> {
    let mut out = Vec::new();
    for profile in PROFILES {
        let Ok(entries) = std::fs::read_dir(root.join(profile)) else {
            continue;
        };
        let mut dirs: Vec<PathBuf> = entries
            .filter_map(Result::ok)
            .map(|e| e.path())
            .filter(|p| p.is_dir())
            .collect();
        dirs.sort();
        out.extend(dirs.iter().filter_map(|d| describe(d, profile)));
    }
    out
}

/// The installed map whose `map.xodr` has `xodr_sha256`. `name_hint` (the
/// trace's `mapId`) only orders the search and the error message; it never
/// selects a map whose content differs.
pub fn find_by_xodr(
    root: &Path,
    xodr_sha256: &str,
    name_hint: Option<&str>,
) -> Result<InstalledMap, CliError> {
    let installed = list(root);
    let mut matches: Vec<&InstalledMap> = installed
        .iter()
        .filter(|m| m.xodr_sha256 == xodr_sha256)
        .collect();
    // Prefer the hinted name, then the search order (semantic before native).
    matches.sort_by_key(|m| Some(m.name.as_str()) != name_hint);
    if let Some(found) = matches.first() {
        return Ok((*found).clone());
    }
    let same_name: Vec<Value> = installed
        .iter()
        .filter(|m| Some(m.name.as_str()) == name_hint)
        .map(|m| json!({ "dir": m.dir, "xodrSha256": m.xodr_sha256, "release": m.release }))
        .collect();
    let hint = match name_hint {
        Some(name) => format!("pull the map version this scenario was simulated on (`simforge maps pull {name}@<version>`) or pass --map-dir"),
        None => "pull the map this scenario was simulated on, or pass --map-dir".to_owned(),
    };
    Err(CliError::new(
        "map_not_installed",
        format!("no installed map has an OpenDRIVE with sha256 {xodr_sha256}"),
    )
    .with_detail(json!({
        "xodrSha256": xodr_sha256,
        "mapId": name_hint,
        "mapsRoot": root,
        "installedWithSameName": same_name,
        "hint": hint,
    })))
}
