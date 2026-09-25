//! The native map closure a render reads (`map-closure.ts`).
//!
//! On a worker the closure arrives as job inputs whose ids derive from their
//! paths. In the CLI it is an installed map directory (`.corpus/<map>`, the
//! native profile `simforge maps pull` writes) whose `.map-release.json`
//! receipt lists every member with its sha256 and byte count. [`MapClosure::open`]
//! proves the directory is that closure: safe unique paths, a `master.gltf`,
//! and every listed member present at its recorded size.
//! [`MapClosure::verify_digests`] re-hashes every member (the deep check).

use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::error::{PlanError, PlanResult};

pub const MASTER_INPUT_ID: &str = "map.tile.000000";
pub const MASTER_PATH: &str = "master.gltf";
/// `RENDER_INTENT_MAX_ASSETS - 3` (OpenDRIVE, catalog, actor closure).
pub const MAX_MEMBERS: usize = 65_536 - 3;
pub const RECEIPT: &str = ".map-release.json";

/// `nativeMapMemberInputId`.
pub fn member_input_id(relative_path: &str) -> String {
    if relative_path == MASTER_PATH {
        return MASTER_INPUT_ID.to_owned();
    }
    format!("map.resource.{}", sha256_hex(relative_path.as_bytes()))
}

/// `isNativeMapMemberInputId`.
pub fn is_member_input_id(input_id: &str) -> bool {
    input_id == MASTER_INPUT_ID
        || input_id.strip_prefix("map.resource.").is_some_and(|hex| {
            hex.len() == 64
                && hex
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
}

/// `assertSafeNativeMapMemberPath`.
pub fn assert_safe_member_path(relative_path: &str) -> PlanResult<()> {
    let unsafe_char = relative_path
        .chars()
        .any(|c| matches!(c, '\\' | ':' | '%' | '?' | '#') || (c as u32) < 0x20);
    if unsafe_char
        || relative_path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(PlanError::message(
            "invalid_unsafe_native_map_member_path",
            format!("invalid unsafe native map member path: {relative_path}"),
        ));
    }
    Ok(())
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// sha256 and byte count of a file, streamed.
pub fn hash_file(path: &Path) -> std::io::Result<(String, u64)> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    let mut size = 0u64;
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        size += n as u64;
    }
    Ok((hex(&hasher.finalize()), size))
}

/// One closure member on disk.
#[derive(Debug, Clone, PartialEq)]
pub struct Member {
    pub path: PathBuf,
    pub sha256: String,
    pub size: u64,
}

/// Reads a closure's member digests and small members: what the planners
/// (`NativeTextureMemberSource`) need before any texture is touched.
pub trait MemberSource {
    fn sha256(&self, uri: &str) -> Option<&str>;
    fn read_text(&self, uri: &str) -> PlanResult<String>;
}

#[derive(Debug, Clone)]
pub struct MapClosure {
    pub root: PathBuf,
    /// Every member including `master.gltf`, keyed by closure-relative path.
    pub members: BTreeMap<String, Member>,
    /// The installation receipt (`simforge.map-installation.v1`), when the
    /// closure came from one.
    pub receipt: Option<Value>,
}

fn member_file(root: &Path, relative: &str) -> PathBuf {
    relative
        .split('/')
        .fold(root.to_path_buf(), |p, part| p.join(part))
}

impl MapClosure {
    /// The closure an installed map directory's receipt describes. Every
    /// listed member must exist at its recorded size; digests are trusted
    /// from the receipt (pull verified them) until [`Self::verify_digests`].
    pub fn open(root: &Path) -> PlanResult<Self> {
        let receipt_path = root.join(RECEIPT);
        let bytes = std::fs::read(&receipt_path).map_err(|e| {
            PlanError::new("native_map_receipt_missing", format!("{}: {e}", receipt_path.display()))
                .with_detail(json!({ "hint": "install the map with `simforge maps pull`, or stage a closure with its receipt" }))
        })?;
        let receipt: Value = serde_json::from_slice(&bytes).map_err(|e| {
            PlanError::new(
                "native_map_receipt_invalid",
                format!("{}: {e}", receipt_path.display()),
            )
        })?;
        let listed = receipt["members"].as_object().ok_or_else(|| {
            PlanError::new(
                "native_map_receipt_invalid",
                format!("{} has no members", receipt_path.display()),
            )
        })?;
        let mut members = BTreeMap::new();
        for (relative, entry) in listed {
            assert_safe_member_path(relative)?;
            let sha256 = entry["sha256"]
                .as_str()
                .filter(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
                .ok_or_else(|| {
                    PlanError::new(
                        "native_map_receipt_invalid",
                        format!("member {relative} has no sha256"),
                    )
                })?;
            let size = entry["bytes"].as_u64().ok_or_else(|| {
                PlanError::new(
                    "native_map_receipt_invalid",
                    format!("member {relative} has no byte count"),
                )
            })?;
            let path = member_file(root, relative);
            let actual = std::fs::metadata(&path)
                .map_err(|e| {
                    PlanError::new(
                        "native_map_member_missing",
                        format!("{relative} ({}): {e}", path.display()),
                    )
                })?
                .len();
            if actual != size {
                return Err(PlanError::new(
                    "native_map_member_size_mismatch",
                    format!("{relative} is {actual} bytes, the receipt says {size}"),
                ));
            }
            members.insert(
                relative.clone(),
                Member {
                    path,
                    sha256: sha256.to_owned(),
                    size,
                },
            );
        }
        let closure = Self {
            root: root.to_path_buf(),
            members,
            receipt: Some(receipt),
        };
        closure.assert_well_formed()?;
        Ok(closure)
    }

    /// A closure from explicit members (tests, job inputs).
    pub fn from_members(root: &Path, members: BTreeMap<String, Member>) -> PlanResult<Self> {
        for relative in members.keys() {
            assert_safe_member_path(relative)?;
        }
        let closure = Self {
            root: root.to_path_buf(),
            members,
            receipt: None,
        };
        closure.assert_well_formed()?;
        Ok(closure)
    }

    /// Every file under `root` hashed (a directory without a receipt).
    pub fn hash_directory(root: &Path) -> PlanResult<Self> {
        let mut members = BTreeMap::new();
        let mut stack = vec![root.to_path_buf()];
        while let Some(dir) = stack.pop() {
            let entries = std::fs::read_dir(&dir).map_err(|e| {
                PlanError::new(
                    "native_map_member_missing",
                    format!("{}: {e}", dir.display()),
                )
            })?;
            for entry in entries {
                let entry = entry.map_err(|e| PlanError::new("native_map_member_missing", e))?;
                let path = entry.path();
                let kind = entry
                    .file_type()
                    .map_err(|e| PlanError::new("native_map_member_missing", e))?;
                let relative = path
                    .strip_prefix(root)
                    .expect("walked under root")
                    .components()
                    .map(|c| c.as_os_str().to_string_lossy().into_owned())
                    .collect::<Vec<_>>()
                    .join("/");
                if kind.is_dir() {
                    stack.push(path);
                } else if relative != RECEIPT && !relative.starts_with('.') {
                    let (sha256, size) = hash_file(&path).map_err(|e| {
                        PlanError::new("native_map_member_missing", format!("{relative}: {e}"))
                    })?;
                    members.insert(relative, Member { path, sha256, size });
                }
            }
        }
        Self::from_members(root, members)
    }

    fn assert_well_formed(&self) -> PlanResult<()> {
        if self.members.len() > MAX_MEMBERS {
            return Err(PlanError::new(
                "native_map_asset_set_too_large",
                format!("{} members exceeds limit {MAX_MEMBERS}", self.members.len()),
            ));
        }
        if !self.members.contains_key(MASTER_PATH) {
            return Err(PlanError::message(
                "invalid_missing_native_map_member",
                format!("invalid missing native map member {MASTER_INPUT_ID} ({MASTER_PATH})"),
            ));
        }
        Ok(())
    }

    pub fn member(&self, uri: &str) -> Option<&Member> {
        self.members.get(uri)
    }

    pub fn path(&self, uri: &str) -> Option<&Path> {
        self.members.get(uri).map(|m| m.path.as_path())
    }

    /// Re-hash every member against the receipt. Returns the mismatches
    /// (empty when the closure verifies).
    pub fn verify_digests(&self) -> PlanResult<Vec<Value>> {
        let mut mismatches = Vec::new();
        for (relative, member) in &self.members {
            let (sha256, size) = hash_file(&member.path).map_err(|e| {
                PlanError::new("native_map_member_missing", format!("{relative}: {e}"))
            })?;
            if sha256 != member.sha256 || size != member.size {
                mismatches.push(json!({
                    "path": relative, "expected": { "sha256": member.sha256, "bytes": member.size },
                    "actual": { "sha256": sha256, "bytes": size },
                }));
            }
        }
        Ok(mismatches)
    }
}

impl MemberSource for MapClosure {
    fn sha256(&self, uri: &str) -> Option<&str> {
        self.members.get(uri).map(|m| m.sha256.as_str())
    }

    fn read_text(&self, uri: &str) -> PlanResult<String> {
        let member = self
            .members
            .get(uri)
            .ok_or_else(|| PlanError::new("native_render_member_missing", uri))?;
        std::fs::read_to_string(&member.path)
            .map_err(|e| PlanError::new("native_render_member_unreadable", format!("{uri}: {e}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn member_ids_derive_from_paths() {
        assert_eq!(member_input_id("master.gltf"), "map.tile.000000");
        // sha256("geometry.bin")
        assert_eq!(
            member_input_id("geometry.bin"),
            format!("map.resource.{}", sha256_hex(b"geometry.bin"))
        );
        assert!(is_member_input_id(&member_input_id("images/a.ktx2")));
        assert!(!is_member_input_id("scenario.xosc"));
        assert!(!is_member_input_id("map.resource.ABC"));
    }

    #[test]
    fn unsafe_paths_are_refused() {
        for bad in [
            "", "/abs", "a//b", "a/./b", "../x", "a\\b", "c:x", "a%20", "a?b", "a#b", "a\u{1}b",
            "a/",
        ] {
            assert!(assert_safe_member_path(bad).is_err(), "{bad:?}");
        }
        for good in [
            "master.gltf",
            "3d/variants/objects/x.ktx2",
            "derived/geometry-lod/lod.gltf",
            "a..b",
        ] {
            assert!(assert_safe_member_path(good).is_ok(), "{good:?}");
        }
    }

    fn write(root: &Path, rel: &str, bytes: &[u8]) -> (String, Value) {
        let path = member_file(root, rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, bytes).unwrap();
        (
            rel.to_owned(),
            json!({ "sha256": sha256_hex(bytes), "bytes": bytes.len() }),
        )
    }

    #[test]
    fn opens_an_installed_directory_and_refuses_damage() {
        let dir = tempfile::tempdir().unwrap();
        let members: serde_json::Map<String, Value> = [
            write(dir.path(), "master.gltf", b"{}"),
            write(dir.path(), "geometry.bin", &[0; 16]),
        ]
        .into_iter()
        .collect();
        let receipt = json!({ "schema": "simforge.map-installation.v1", "members": members });
        std::fs::write(dir.path().join(RECEIPT), receipt.to_string()).unwrap();
        let closure = MapClosure::open(dir.path()).unwrap();
        assert_eq!(closure.members.len(), 2);
        assert_eq!(
            closure.sha256("geometry.bin"),
            Some(sha256_hex(&[0; 16]).as_str())
        );
        assert!(closure.verify_digests().unwrap().is_empty());

        // Same size, other bytes: only the deep check sees it.
        std::fs::write(dir.path().join("geometry.bin"), [1u8; 16]).unwrap();
        assert!(MapClosure::open(dir.path()).is_ok());
        assert_eq!(
            MapClosure::open(dir.path())
                .unwrap()
                .verify_digests()
                .unwrap()
                .len(),
            1
        );
        std::fs::write(dir.path().join("geometry.bin"), [1u8; 3]).unwrap();
        assert_eq!(
            MapClosure::open(dir.path()).unwrap_err().code,
            "native_map_member_size_mismatch"
        );
        std::fs::remove_file(dir.path().join("geometry.bin")).unwrap();
        assert_eq!(
            MapClosure::open(dir.path()).unwrap_err().code,
            "native_map_member_missing"
        );
    }

    #[test]
    fn a_closure_needs_its_master() {
        let dir = tempfile::tempdir().unwrap();
        let members = BTreeMap::from([(
            "geometry.bin".to_owned(),
            Member {
                path: dir.path().join("geometry.bin"),
                sha256: "0".repeat(64),
                size: 0,
            },
        )]);
        let error = MapClosure::from_members(dir.path(), members).unwrap_err();
        assert_eq!(
            error.message,
            "invalid missing native map member map.tile.000000 (master.gltf)"
        );
    }
}
