//! Continuation checkpoints. An engine writes a complete state closure into
//! a staging directory; the runner hashes every file, publishes the
//! directory atomically as `checkpoints/<sequence>` and points
//! `checkpoints/latest.json` at it. A resumed attempt only continues from a
//! checkpoint whose files re-verify and whose runtime identity matches.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::clock::now_rfc3339;
use crate::error::{Result, RunnerError};
use crate::fsatomic::{
    ensure_dir, publish_dir, read_json, remove_dir_if_present, write_json_atomic,
};
use crate::hash::{canonical_sha256, hash_file, verify_file, ContentDigest};

pub const CHECKPOINT_SCHEMA: &str = "simforge.native-checkpoint/v1";
pub const CHECKPOINT_MANIFEST_FILE: &str = "checkpoint.json";
const LATEST_FILE: &str = "latest.json";
/// Checkpoints retained after a new publication (the newest plus one prior,
/// so a corrupt newest still leaves a verified continuation point).
const RETAINED: usize = 2;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointFile {
    pub relative_path: String,
    pub sha256: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointManifest {
    pub schema: String,
    pub sequence: u64,
    pub attempt: u32,
    pub runtime_id: String,
    pub created_at: String,
    /// Engine-owned description of the checkpoint (e.g. tick, episode
    /// index, backend profile). Coarse metadata, parsed once on resume.
    pub metadata: serde_json::Value,
    pub files: Vec<CheckpointFile>,
}

/// What job state records about the latest checkpoint.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointRef {
    pub sequence: u64,
    pub attempt: u32,
    pub runtime_id: String,
    pub manifest_sha256: String,
    pub published_at: String,
    pub metadata: serde_json::Value,
}

/// A verified checkpoint handed to a resuming engine.
#[derive(Debug, Clone)]
pub struct ResumePoint {
    pub dir: PathBuf,
    pub manifest: CheckpointManifest,
}

pub struct CheckpointStore {
    root: PathBuf,
}

impl CheckpointStore {
    pub fn new(root: PathBuf) -> Self {
        CheckpointStore { root }
    }

    fn latest_path(&self) -> PathBuf {
        self.root.join(LATEST_FILE)
    }

    fn sequence_dir(&self, sequence: u64) -> PathBuf {
        self.root.join(format!("{sequence:012}"))
    }

    pub fn latest(&self) -> Result<Option<CheckpointRef>> {
        let path = self.latest_path();
        if !path.exists() {
            return Ok(None);
        }
        read_json(&path).map(Some)
    }

    /// Prepares an empty staging directory for the next checkpoint.
    pub fn begin(&self, sequence: u64) -> Result<PathBuf> {
        ensure_dir(&self.root)?;
        let staging = self.root.join(format!(".staging-{sequence:012}"));
        remove_dir_if_present(&staging)?;
        ensure_dir(&staging)?;
        Ok(staging)
    }

    /// Hashes and publishes a staging directory the engine has finished
    /// writing. Fails if the sequence is already published.
    pub fn publish(
        &self,
        staging: &Path,
        sequence: u64,
        attempt: u32,
        runtime_id: &str,
        metadata: serde_json::Value,
    ) -> Result<CheckpointRef> {
        let mut files = Vec::new();
        collect_files(staging, staging, &mut files)?;
        if files.is_empty() {
            let _ = remove_dir_if_present(staging);
            return Err(RunnerError::Engine {
                workload: String::new(),
                reason: "checkpoint staging directory is empty".into(),
            });
        }
        let manifest = CheckpointManifest {
            schema: CHECKPOINT_SCHEMA.to_owned(),
            sequence,
            attempt,
            runtime_id: runtime_id.to_owned(),
            created_at: now_rfc3339(),
            metadata,
            files,
        };
        write_json_atomic(&staging.join(CHECKPOINT_MANIFEST_FILE), &manifest)?;
        let target = self.sequence_dir(sequence);
        publish_dir(staging, &target)?;
        let reference = CheckpointRef {
            sequence,
            attempt,
            runtime_id: runtime_id.to_owned(),
            manifest_sha256: canonical_sha256(&manifest)?,
            published_at: now_rfc3339(),
            metadata: manifest.metadata.clone(),
        };
        write_json_atomic(&self.latest_path(), &reference)?;
        self.prune(sequence)?;
        Ok(reference)
    }

    fn prune(&self, newest: u64) -> Result<()> {
        let mut sequences = Vec::new();
        for entry in
            fs::read_dir(&self.root).map_err(|source| RunnerError::io(&self.root, source))?
        {
            let entry = entry.map_err(|source| RunnerError::io(&self.root, source))?;
            if let Some(sequence) = entry
                .file_name()
                .to_str()
                .and_then(|name| name.parse::<u64>().ok())
            {
                if sequence <= newest {
                    sequences.push(sequence);
                }
            }
        }
        sequences.sort_unstable_by(|a, b| b.cmp(a));
        for stale in sequences.into_iter().skip(RETAINED) {
            remove_dir_if_present(&self.sequence_dir(stale))?;
        }
        Ok(())
    }

    /// Loads and fully re-verifies the referenced checkpoint.
    pub fn resume_point(&self, reference: &CheckpointRef) -> Result<ResumePoint> {
        let dir = self.sequence_dir(reference.sequence);
        let manifest: CheckpointManifest = read_json(&dir.join(CHECKPOINT_MANIFEST_FILE))?;
        if manifest.schema != CHECKPOINT_SCHEMA || manifest.sequence != reference.sequence {
            return Err(RunnerError::JobState {
                job_id: String::new(),
                reason: format!(
                    "checkpoint {} manifest does not match its reference",
                    reference.sequence
                ),
            });
        }
        let actual_sha256 = canonical_sha256(&manifest)?;
        if actual_sha256 != reference.manifest_sha256 {
            return Err(RunnerError::JobState {
                job_id: String::new(),
                reason: format!(
                    "checkpoint {} manifest hash {actual_sha256} differs from recorded {}",
                    reference.sequence, reference.manifest_sha256
                ),
            });
        }
        for file in &manifest.files {
            verify_file(
                &dir.join(&file.relative_path),
                &ContentDigest {
                    sha256: file.sha256.clone(),
                    size_bytes: file.size_bytes,
                },
            )?;
        }
        Ok(ResumePoint { dir, manifest })
    }

    /// Removes every checkpoint; used when an attempt restarts from scratch.
    pub fn clear(&self) -> Result<()> {
        remove_dir_if_present(&self.root)
    }
}

fn collect_files(base: &Path, dir: &Path, out: &mut Vec<CheckpointFile>) -> Result<()> {
    let mut entries: Vec<_> = fs::read_dir(dir)
        .map_err(|source| RunnerError::io(dir, source))?
        .collect::<std::io::Result<_>>()
        .map_err(|source| RunnerError::io(dir, source))?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let path = entry.path();
        let kind = entry
            .file_type()
            .map_err(|source| RunnerError::io(&path, source))?;
        if kind.is_dir() {
            collect_files(base, &path, out)?;
        } else if kind.is_file() {
            if path.file_name().and_then(|name| name.to_str()) == Some(CHECKPOINT_MANIFEST_FILE)
                && path.parent() == Some(base)
            {
                return Err(RunnerError::Engine {
                    workload: String::new(),
                    reason: format!("engine may not write {CHECKPOINT_MANIFEST_FILE} itself"),
                });
            }
            let digest = hash_file(&path)?;
            let relative = path.strip_prefix(base).map_err(|_| {
                RunnerError::io(&path, std::io::Error::other("outside checkpoint dir"))
            })?;
            out.push(CheckpointFile {
                relative_path: relative.to_string_lossy().into_owned(),
                sha256: digest.sha256,
                size_bytes: digest.size_bytes,
            });
        } else {
            return Err(RunnerError::Engine {
                workload: String::new(),
                reason: format!("checkpoint contains non-regular entry {}", path.display()),
            });
        }
    }
    Ok(())
}
