//! Output contract verification and artifact publication.
//!
//! A job is only complete once every produced artifact has been re-hashed
//! by the runner, matches the engine's claim and the manifest's contract
//! (including any pinned replay digest), every required output exists, the
//! bytes are in the content store, and the staged output directory has been
//! renamed into place. `artifacts.json` is written last; its existence means
//! the outputs it lists verified at publication.

use std::collections::BTreeSet;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::cas::ContentStore;
use crate::clock::now_rfc3339;
use crate::engine::{ExecutionOutcome, ProducedArtifact};
use crate::error::{Result, RunnerError};
use crate::fsatomic::{publish_dir, read_json, write_json_atomic};
use crate::hash::{canonical_sha256, hash_file, ContentDigest};
use crate::manifest::{is_safe_relative, JobManifest, LeasePassthrough};
use crate::runtime::RuntimeIdentity;
use crate::state::{ArtifactSetRef, JobDir};

pub const ARTIFACT_MANIFEST_SCHEMA: &str = "simforge.native-artifacts/v1";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactManifest {
    pub schema: String,
    pub job_id: String,
    pub manifest_sha256: String,
    pub execution_identity: String,
    pub runtime: RuntimeIdentity,
    pub attempt: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lease: Option<LeasePassthrough>,
    pub published_at: String,
    pub artifacts: Vec<ProducedArtifact>,
    #[serde(default)]
    pub summary: serde_json::Value,
}

pub struct Publication<'a> {
    pub job_dir: &'a JobDir,
    pub manifest: &'a JobManifest,
    pub manifest_sha256: &'a str,
    pub execution_identity: &'a str,
    pub runtime: &'a RuntimeIdentity,
    pub attempt: u32,
    pub cas: &'a ContentStore,
}

/// Verifies `outcome` against the manifest's output contracts and publishes
/// it. On any violation nothing is published and the staging tree is left
/// for inspection.
pub fn verify_and_publish(
    publication: &Publication<'_>,
    outcome: ExecutionOutcome,
) -> Result<(ArtifactManifest, ArtifactSetRef)> {
    let staging = publication.job_dir.staging_dir();
    let staging_canonical = staging
        .canonicalize()
        .map_err(|source| RunnerError::io(&staging, source))?;
    let violation = |reason: String| RunnerError::Artifact { reason };

    let mut seen_ids = BTreeSet::new();
    let mut seen_paths = BTreeSet::new();
    for artifact in &outcome.artifacts {
        let contract = publication
            .manifest
            .output(&artifact.output_id)
            .ok_or_else(|| {
                violation(format!(
                    "engine produced undeclared output {}",
                    artifact.output_id
                ))
            })?;
        if !contract.glob && !seen_ids.insert(artifact.output_id.as_str()) {
            return Err(violation(format!(
                "engine produced output {} twice",
                artifact.output_id
            )));
        }
        seen_ids.insert(artifact.output_id.as_str());
        if !seen_paths.insert(artifact.relative_path.as_str()) {
            return Err(violation(format!(
                "engine produced {} twice",
                artifact.relative_path
            )));
        }
        if !is_safe_relative(&artifact.relative_path) || !contract.matches(&artifact.relative_path)
        {
            return Err(violation(format!(
                "output {} written to {} but contract requires {}",
                artifact.output_id, artifact.relative_path, contract.relative_path
            )));
        }
        if artifact.media_type != contract.media_type {
            return Err(violation(format!(
                "output {} media type {} but contract requires {}",
                artifact.output_id, artifact.media_type, contract.media_type
            )));
        }
        let path = staging.join(&artifact.relative_path);
        let canonical = path
            .canonicalize()
            .map_err(|source| RunnerError::io(&path, source))?;
        if !canonical.starts_with(&staging_canonical) {
            return Err(violation(format!(
                "output {} escapes the staging directory",
                artifact.output_id
            )));
        }
        if !canonical.is_file() {
            return Err(violation(format!(
                "output {} is not a regular file",
                artifact.output_id
            )));
        }
        let actual = hash_file(&canonical)?;
        let claimed = ContentDigest {
            sha256: artifact.sha256.clone(),
            size_bytes: artifact.size_bytes,
        };
        if actual != claimed {
            return Err(violation(format!(
                "output {} claimed {}/{} but bytes are {}/{}",
                artifact.output_id,
                claimed.sha256,
                claimed.size_bytes,
                actual.sha256,
                actual.size_bytes
            )));
        }
        if let Some(expected) = &contract.expected_sha256 {
            if *expected != actual.sha256 {
                return Err(violation(format!(
                    "output {} hashed {} but the manifest pins {expected}; the replay is not byte-identical",
                    artifact.output_id, actual.sha256
                )));
            }
        }
    }
    for contract in &publication.manifest.outputs {
        if contract.required && !seen_ids.contains(contract.output_id.as_str()) {
            return Err(violation(format!(
                "required output {} was not produced",
                contract.output_id
            )));
        }
    }

    for artifact in &outcome.artifacts {
        let path = staging.join(&artifact.relative_path);
        let expected = ContentDigest {
            sha256: artifact.sha256.clone(),
            size_bytes: artifact.size_bytes,
        };
        publication.cas.ingest_file(&path, Some(&expected))?;
    }

    let outputs = publication.job_dir.outputs_dir();
    publish_dir(&staging, &outputs)?;

    let manifest = ArtifactManifest {
        schema: ARTIFACT_MANIFEST_SCHEMA.to_owned(),
        job_id: publication.job_dir.job_id.clone(),
        manifest_sha256: publication.manifest_sha256.to_owned(),
        execution_identity: publication.execution_identity.to_owned(),
        runtime: publication.runtime.clone(),
        attempt: publication.attempt,
        lease: publication.manifest.lease.clone(),
        published_at: now_rfc3339(),
        artifacts: outcome.artifacts,
        summary: outcome.summary,
    };
    write_json_atomic(&publication.job_dir.artifacts_path(), &manifest)?;
    let reference = ArtifactSetRef {
        sha256: canonical_sha256(&manifest)?,
        count: manifest.artifacts.len(),
        published_at: manifest.published_at.clone(),
    };
    Ok((manifest, reference))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedArtifacts {
    pub manifest: ArtifactManifest,
    pub manifest_sha256: String,
    pub outputs_dir: String,
    pub verified: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub violations: Vec<String>,
}

/// Re-reads a published artifact manifest and re-hashes every listed file.
pub fn verify_published(job_dir: &JobDir) -> Result<VerifiedArtifacts> {
    let manifest: ArtifactManifest = read_json(&job_dir.artifacts_path())?;
    if manifest.schema != ARTIFACT_MANIFEST_SCHEMA || manifest.job_id != job_dir.job_id {
        return Err(RunnerError::Artifact {
            reason: "artifacts.json schema/jobId mismatch".into(),
        });
    }
    let manifest_sha256 = canonical_sha256(&manifest)?;
    let outputs = job_dir.outputs_dir();
    let mut violations = Vec::new();
    for artifact in &manifest.artifacts {
        let path = outputs.join(&artifact.relative_path);
        match hash_file(&path) {
            Ok(actual)
                if actual.sha256 == artifact.sha256 && actual.size_bytes == artifact.size_bytes => {
            }
            Ok(actual) => violations.push(format!(
                "{} is now {}/{}, published {}/{}",
                artifact.relative_path,
                actual.sha256,
                actual.size_bytes,
                artifact.sha256,
                artifact.size_bytes
            )),
            Err(error) => violations.push(format!("{}: {error}", artifact.relative_path)),
        }
    }
    Ok(VerifiedArtifacts {
        verified: violations.is_empty(),
        manifest,
        manifest_sha256,
        outputs_dir: display(&outputs),
        violations,
    })
}

fn display(path: &Path) -> String {
    path.display().to_string()
}
