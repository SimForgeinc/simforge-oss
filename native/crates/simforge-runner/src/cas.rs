//! Worker-local content-addressed store.
//!
//! Layout: `<root>/cas/sha256/<hex>` immutable read-only blobs, `<root>/cas/tmp`
//! for in-flight writes. Ingestion copies the source (never links it, so a
//! later in-place edit of the user's file cannot corrupt the store) and the
//! source is never modified or deleted. Workspaces hard-link blobs where the
//! filesystem allows and copy otherwise; either way the engine sees a
//! read-only file whose digest was verified on the way in.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::{Result, RunnerError};
use crate::fsatomic::{ensure_dir, fsync_dir};
use crate::hash::{hash_file, is_sha256_hex, verify_file, ContentDigest};

#[derive(Debug, Clone)]
pub struct ContentStore {
    blobs: PathBuf,
    tmp: PathBuf,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestReport {
    pub sha256: String,
    pub size_bytes: u64,
    pub path: String,
    pub already_present: bool,
}

impl ContentStore {
    pub fn open(root: &Path) -> Result<Self> {
        let store = ContentStore {
            blobs: root.join("cas").join("sha256"),
            tmp: root.join("cas").join("tmp"),
        };
        ensure_dir(&store.blobs)?;
        ensure_dir(&store.tmp)?;
        Ok(store)
    }

    pub fn blob_path(&self, sha256: &str) -> PathBuf {
        self.blobs.join(sha256)
    }

    /// Cheap presence check: blob exists with the declared length. Full
    /// rehash is `verify`.
    pub fn has(&self, digest: &ContentDigest) -> bool {
        fs::metadata(self.blob_path(&digest.sha256))
            .map(|meta| meta.is_file() && meta.len() == digest.size_bytes)
            .unwrap_or(false)
    }

    /// Rehashes the blob and reports the actual digest; a corrupt blob is
    /// reported, not deleted, so the operator can decide.
    pub fn verify(&self, sha256: &str) -> Result<ContentDigest> {
        if !is_sha256_hex(sha256) {
            return Err(RunnerError::Content {
                sha256: sha256.to_owned(),
                reason: "not a lowercase sha256 hex digest".into(),
            });
        }
        let path = self.blob_path(sha256);
        if !path.is_file() {
            return Err(RunnerError::Content {
                sha256: sha256.to_owned(),
                reason: "not present in store".into(),
            });
        }
        let actual = hash_file(&path)?;
        if actual.sha256 != sha256 {
            return Err(RunnerError::Content {
                sha256: sha256.to_owned(),
                reason: format!(
                    "stored bytes hash to {} ({} bytes); blob is corrupt",
                    actual.sha256, actual.size_bytes
                ),
            });
        }
        Ok(actual)
    }

    /// Copies `source` into the store, verifying it against `expected` when
    /// given. Returns the digest and whether the blob was already present.
    pub fn ingest_file(
        &self,
        source: &Path,
        expected: Option<&ContentDigest>,
    ) -> Result<(ContentDigest, bool)> {
        let digest = match expected {
            Some(expected) => verify_file(source, expected)?,
            None => hash_file(source)?,
        };
        if self.has(&digest) {
            return Ok((digest, true));
        }
        let target = self.blob_path(&digest.sha256);
        let temp = self.tmp.join(format!(
            "{}.{}.{}",
            digest.sha256,
            std::process::id(),
            crate::clock::unix_millis()
        ));
        let result = (|| {
            fs::copy(source, &temp).map_err(|source| RunnerError::io(&temp, source))?;
            // The copy is rehashed: the source could have changed under us
            // between the verification read and the copy.
            let copied = hash_file(&temp)?;
            if copied != digest {
                return Err(RunnerError::Integrity {
                    path: source.to_path_buf(),
                    expected_sha256: digest.sha256.clone(),
                    expected_size: digest.size_bytes,
                    actual_sha256: copied.sha256,
                    actual_size: copied.size_bytes,
                });
            }
            fs::set_permissions(&temp, fs::Permissions::from_mode(0o444))
                .map_err(|source| RunnerError::io(&temp, source))?;
            fs::File::open(&temp)
                .and_then(|file| file.sync_all())
                .map_err(|source| RunnerError::io(&temp, source))?;
            match fs::hard_link(&temp, &target) {
                Ok(()) => {}
                // A concurrent ingest of the same bytes won; identical content.
                Err(source) if source.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(source) => return Err(RunnerError::io(&target, source)),
            }
            fsync_dir(&self.blobs)
        })();
        let _ = fs::remove_file(&temp);
        result?;
        Ok((digest, false))
    }

    /// Places the blob at `target` (hard link, else copy) and verifies the
    /// materialized file's length. Fails if the blob is absent.
    pub fn materialize(&self, digest: &ContentDigest, target: &Path) -> Result<()> {
        let blob = self.blob_path(&digest.sha256);
        if !self.has(digest) {
            return Err(RunnerError::Content {
                sha256: digest.sha256.clone(),
                reason: format!(
                    "blob missing or wrong length (expected {} bytes)",
                    digest.size_bytes
                ),
            });
        }
        if let Some(parent) = target.parent() {
            ensure_dir(parent)?;
        }
        let _ = fs::remove_file(target);
        if fs::hard_link(&blob, target).is_err() {
            fs::copy(&blob, target).map_err(|source| RunnerError::io(target, source))?;
            fs::set_permissions(target, fs::Permissions::from_mode(0o444))
                .map_err(|source| RunnerError::io(target, source))?;
        }
        let len = fs::metadata(target)
            .map_err(|source| RunnerError::io(target, source))?
            .len();
        if len != digest.size_bytes {
            return Err(RunnerError::Integrity {
                path: target.to_path_buf(),
                expected_sha256: digest.sha256.clone(),
                expected_size: digest.size_bytes,
                actual_sha256: "<not hashed>".into(),
                actual_size: len,
            });
        }
        Ok(())
    }
}
