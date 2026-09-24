//! One error type for every refusal. `code` is the stable, user-facing family
//! (scenario-package.md section 9); `rule` names the exact check that failed,
//! so a hostile-fixture test can assert which rule refused a package.

use std::fmt;

use serde::Serialize;
use serde_json::{json, Value};

/// The error family. The string form (`package_*`) is the contract the CLI
/// prints and the hosted app maps to UI copy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
pub enum ErrorCode {
    /// Not a strict-subset ZIP, or a name/layout rule of section 10 failed.
    ContainerInvalid,
    /// The manifest parses but violates the v1 schema or its own invariants.
    ManifestInvalid,
    /// `manifest.json` is not exactly `canonicalJson(manifest)`.
    ManifestNotCanonical,
    /// A member's bytes do not match the sha256/size/CRC recorded for them.
    DigestMismatch,
    /// A versioned dimension is ahead of this reader (or the manifest major is unknown).
    VersionUnsupported,
    /// Two digests that must agree (trace header, timeline identity, map, ...) do not.
    IdentityMismatch,
    /// A member cannot be decoded as what its role says it is.
    MemberInvalid,
    /// A closure listing (`map/closure.json`, `actors/closure.json`) is malformed or self-contradictory.
    ClosureInvalid,
    /// A full package lacks a blob its form requires.
    FormIncomplete,
    /// The container exceeds the configured size limit.
    TooLarge,
    /// Another configured limit (entry count, member size, DEFLATE ratio) was hit.
    LimitExceeded,
    /// The builder was given something it cannot package (an unknown member path, a draft with `members`).
    ArgumentInvalid,
    /// Reading or writing the container failed at the OS level.
    Io,
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ContainerInvalid => "package_container_invalid",
            Self::ManifestInvalid => "package_manifest_invalid",
            Self::ManifestNotCanonical => "package_manifest_not_canonical",
            Self::DigestMismatch => "package_digest_mismatch",
            Self::VersionUnsupported => "package_version_unsupported",
            Self::IdentityMismatch => "package_identity_mismatch",
            Self::MemberInvalid => "package_member_invalid",
            Self::ClosureInvalid => "package_closure_invalid",
            Self::FormIncomplete => "package_form_incomplete",
            Self::TooLarge => "package_too_large",
            Self::LimitExceeded => "package_limit_exceeded",
            Self::ArgumentInvalid => "package_argument_invalid",
            Self::Io => "package_io_error",
        }
    }
}

impl fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// One versioned dimension a reader refuses (section 5.4).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SkewDimension {
    pub dimension: String,
    pub found: String,
    pub supported: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackageError {
    pub code: ErrorCode,
    /// The exact rule, e.g. `duplicate_name`, `blob_unreferenced`.
    pub rule: &'static str,
    pub message: String,
    /// The member path (or blob digest) the refusal is about, when there is one.
    pub path: Option<String>,
    /// Non-empty only for [`ErrorCode::VersionUnsupported`].
    pub dimensions: Vec<SkewDimension>,
}

pub type Result<T, E = PackageError> = std::result::Result<T, E>;

impl PackageError {
    pub fn new(code: ErrorCode, rule: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            rule,
            message: message.into(),
            path: None,
            dimensions: Vec::new(),
        }
    }

    pub fn at(mut self, path: impl Into<String>) -> Self {
        self.path = Some(path.into());
        self
    }

    pub fn container(rule: &'static str, message: impl Into<String>) -> Self {
        Self::new(ErrorCode::ContainerInvalid, rule, message)
    }

    pub fn manifest(rule: &'static str, message: impl Into<String>) -> Self {
        Self::new(ErrorCode::ManifestInvalid, rule, message)
    }

    pub fn digest(rule: &'static str, message: impl Into<String>) -> Self {
        Self::new(ErrorCode::DigestMismatch, rule, message)
    }

    pub fn identity(rule: &'static str, message: impl Into<String>) -> Self {
        Self::new(ErrorCode::IdentityMismatch, rule, message)
    }

    pub fn member(rule: &'static str, message: impl Into<String>) -> Self {
        Self::new(ErrorCode::MemberInvalid, rule, message)
    }

    pub fn closure(rule: &'static str, message: impl Into<String>) -> Self {
        Self::new(ErrorCode::ClosureInvalid, rule, message)
    }

    pub fn argument(rule: &'static str, message: impl Into<String>) -> Self {
        Self::new(ErrorCode::ArgumentInvalid, rule, message)
    }

    pub fn io(err: std::io::Error) -> Self {
        Self::new(ErrorCode::Io, "io", err.to_string())
    }

    /// `{code, rule, message, path?, dimensions?}`: the shape the CLI prints and
    /// the Node binding throws.
    pub fn to_json(&self) -> Value {
        let mut out = json!({
            "code": self.code.as_str(),
            "rule": self.rule,
            "message": self.message,
        });
        if let Some(path) = &self.path {
            out["path"] = json!(path);
        }
        if !self.dimensions.is_empty() {
            out["dimensions"] = json!(self.dimensions);
        }
        out
    }
}

impl fmt::Display for PackageError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} ({}): {}", self.code, self.rule, self.message)?;
        if let Some(path) = &self.path {
            write!(f, " [{path}]")?;
        }
        Ok(())
    }
}

impl std::error::Error for PackageError {}

impl From<std::io::Error> for PackageError {
    fn from(err: std::io::Error) -> Self {
        Self::io(err)
    }
}
