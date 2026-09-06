//! The runtime manifest (`simforge.native-runtime/v1`) identifies one built
//! runtime: binary digest, source revision, target and support tiers. It is
//! produced by `scripts/native-runtime/write-runtime-manifest.mjs` at
//! packaging time and lives beside the binary. The runner hashes its own
//! executable at startup and refuses to serve jobs if the manifest does not
//! describe it, so a job's recorded `runtimeId` is a truthful pin.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{Result, RunnerError};
use crate::fsatomic::read_json;
use crate::hash::{canonical_sha256, hash_file, is_sha256_hex, ContentDigest};

pub const RUNTIME_MANIFEST_SCHEMA: &str = "simforge.native-runtime/v1";
pub const RUNTIME_MANIFEST_FILE: &str = "runtime-manifest.json";
pub const RUNTIME_MANIFEST_ENV: &str = "SIMFORGE_RUNTIME_MANIFEST";
pub const RUNNER_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeManifest {
    pub schema: String,
    /// Runner crate version; must equal the binary's compiled version.
    pub version: String,
    /// Full lowercase git SHA of the source the binary was built from.
    pub revision: String,
    /// Rust target triple.
    pub target: String,
    pub built_at: String,
    pub binary: BinaryIdentity,
    /// Versions of the native crates linked into the binary.
    #[serde(default)]
    pub crates: BTreeMap<String, String>,
    /// Declared support tiers (hardware/driver/backend classes this build
    /// was packaged for). Descriptive; admission uses worker capacity.
    #[serde(default)]
    pub support_tiers: Vec<SupportTier>,
    /// Everything else the bundle ships (render service, FFI library,
    /// provider wheels), each pinned by digest and support tier.
    #[serde(default)]
    pub components: Vec<RuntimeComponent>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeComponent {
    pub kind: ComponentKind,
    pub name: String,
    /// Path relative to the runtime root at install time.
    pub install: String,
    pub sha256: String,
    pub size_bytes: u64,
    pub tier: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platform: Option<String>,
    /// Python module of a provider wheel.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub module: Option<String>,
    /// Build-time absolute source path of an asset (provenance only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// Redistribution terms of a third-party asset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credit: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ComponentKind {
    Binary,
    SharedLibrary,
    Wheel,
    Asset,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BinaryIdentity {
    pub name: String,
    pub sha256: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SupportTier {
    pub tier: String,
    pub description: String,
    #[serde(default)]
    pub requires: BTreeMap<String, String>,
    /// Declared qualification state; `unqualified` tiers are shipped as
    /// capability, not as a claim.
    pub qualification: TierQualification,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TierQualification {
    pub status: QualificationStatus,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub blockers: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evidence: Option<String>,
    /// Individual observations retained separately from the verdict; they
    /// never promote a tier by themselves.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub observed: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum QualificationStatus {
    Qualified,
    Unqualified,
}

/// A loaded manifest that has been checked against the running executable.
#[derive(Debug, Clone)]
pub struct VerifiedRuntime {
    pub manifest: RuntimeManifest,
    pub manifest_path: PathBuf,
    /// Canonical sha256 of the manifest; the identity jobs pin and record.
    pub runtime_id: String,
}

/// The identity recorded in persisted job state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeIdentity {
    pub runtime_id: String,
    pub version: String,
    pub revision: String,
    pub target: String,
    pub binary_sha256: String,
}

impl RuntimeManifest {
    pub fn validate(&self) -> std::result::Result<(), String> {
        if self.schema != RUNTIME_MANIFEST_SCHEMA {
            return Err(format!("schema must be {RUNTIME_MANIFEST_SCHEMA}"));
        }
        if self.revision.len() != 40
            || !self
                .revision
                .bytes()
                .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
        {
            return Err("revision must be a full lowercase git SHA".into());
        }
        if self.target.is_empty() {
            return Err("target must be a Rust target triple".into());
        }
        if self.binary.name.is_empty() || !is_sha256_hex(&self.binary.sha256) {
            return Err("binary must carry a name and sha256".into());
        }
        for tier in &self.support_tiers {
            if tier.qualification.status == QualificationStatus::Unqualified
                && tier.qualification.blockers.is_empty()
            {
                return Err(format!(
                    "support tier {} is unqualified but lists no blockers",
                    tier.tier
                ));
            }
        }
        let tiers: std::collections::BTreeSet<&str> = self
            .support_tiers
            .iter()
            .map(|tier| tier.tier.as_str())
            .collect();
        for component in &self.components {
            if !is_sha256_hex(&component.sha256) || component.install.is_empty() {
                return Err(format!(
                    "component {} must carry an install path and sha256",
                    component.name
                ));
            }
            if !tiers.contains(component.tier.as_str()) {
                return Err(format!(
                    "component {} references undeclared support tier {}",
                    component.name, component.tier
                ));
            }
        }
        Ok(())
    }

    pub fn runtime_id(&self) -> Result<String> {
        canonical_sha256(self)
    }

    /// Builds a manifest for `binary` by hashing it. Used by the packaging
    /// script's Rust-side tests and by anyone producing a manifest in Rust.
    pub fn describe_binary(
        binary: &Path,
        revision: &str,
        target: &str,
        built_at: &str,
    ) -> Result<Self> {
        let ContentDigest { sha256, size_bytes } = hash_file(binary)?;
        let name = binary
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        Ok(RuntimeManifest {
            schema: RUNTIME_MANIFEST_SCHEMA.to_owned(),
            version: RUNNER_VERSION.to_owned(),
            revision: revision.to_owned(),
            target: target.to_owned(),
            built_at: built_at.to_owned(),
            binary: BinaryIdentity {
                name,
                sha256,
                size_bytes,
            },
            crates: BTreeMap::from([("simforge-runner".to_owned(), RUNNER_VERSION.to_owned())]),
            support_tiers: Vec::new(),
            components: Vec::new(),
        })
    }
}

/// Resolves the manifest path: `$SIMFORGE_RUNTIME_MANIFEST`, else
/// `runtime-manifest.json` beside the executable.
pub fn default_manifest_path(executable: &Path) -> PathBuf {
    match std::env::var_os(RUNTIME_MANIFEST_ENV) {
        Some(path) if !path.is_empty() => PathBuf::from(path),
        _ => executable
            .parent()
            .map(|dir| dir.join(RUNTIME_MANIFEST_FILE))
            .unwrap_or_else(|| PathBuf::from(RUNTIME_MANIFEST_FILE)),
    }
}

pub fn current_executable() -> Result<PathBuf> {
    std::env::current_exe().map_err(|source| RunnerError::io("<current executable>", source))
}

/// Loads and verifies the manifest against `executable`.
pub fn load_verified(manifest_path: &Path, executable: &Path) -> Result<VerifiedRuntime> {
    if !manifest_path.is_file() {
        return Err(RunnerError::Runtime {
            path: manifest_path.to_path_buf(),
            reason: format!("missing; package the binary with scripts/native-runtime/write-runtime-manifest.mjs or set {RUNTIME_MANIFEST_ENV}"),
        });
    }
    let manifest: RuntimeManifest = read_json(manifest_path)?;
    manifest.validate().map_err(|reason| RunnerError::Runtime {
        path: manifest_path.to_path_buf(),
        reason,
    })?;
    if manifest.version != RUNNER_VERSION {
        return Err(RunnerError::Runtime {
            path: manifest_path.to_path_buf(),
            reason: format!(
                "manifest version {} does not match runner version {RUNNER_VERSION}",
                manifest.version
            ),
        });
    }
    let actual = hash_file(executable)?;
    if actual.sha256 != manifest.binary.sha256 || actual.size_bytes != manifest.binary.size_bytes {
        return Err(RunnerError::Runtime {
            path: manifest_path.to_path_buf(),
            reason: format!(
                "manifest describes binary {}/{} but {} is {}/{}",
                manifest.binary.sha256,
                manifest.binary.size_bytes,
                executable.display(),
                actual.sha256,
                actual.size_bytes
            ),
        });
    }
    let runtime_id = manifest.runtime_id()?;
    Ok(VerifiedRuntime {
        manifest,
        manifest_path: manifest_path.to_path_buf(),
        runtime_id,
    })
}

impl VerifiedRuntime {
    pub fn identity(&self) -> RuntimeIdentity {
        RuntimeIdentity {
            runtime_id: self.runtime_id.clone(),
            version: self.manifest.version.clone(),
            revision: self.manifest.revision.clone(),
            target: self.manifest.target.clone(),
            binary_sha256: self.manifest.binary.sha256.clone(),
        }
    }
}
