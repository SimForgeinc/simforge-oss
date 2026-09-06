//! The immutable job manifest (`simforge.native-job/v1`).
//!
//! A manifest fully describes one job: the engine workload and its coarse
//! JSON parameters, every input by content digest, the bounded resources the
//! job may consume, the outputs it must produce, and optional ownership
//! passthrough for an external (cloud) lease. Once submitted it never
//! changes; its canonical sha256 is the job's input identity.

use std::collections::BTreeMap;
use std::path::{Component, Path};

use serde::{Deserialize, Serialize};

use crate::error::{Result, RunnerError};
use crate::hash::{canonical_sha256, is_sha256_hex};
use crate::resources::ResourceDeclaration;

pub const JOB_MANIFEST_SCHEMA: &str = "simforge.native-job/v1";
pub const MAX_JOB_ID_LEN: usize = 96;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JobManifest {
    pub schema: String,
    pub job_id: String,
    /// Engine workload identifier, e.g. `simforge.simulate/v1`.
    pub workload: String,
    /// Coarse engine parameters. JSON is acceptable here because it is parsed
    /// once at admission, never on a stepping path.
    #[serde(default)]
    pub params: serde_json::Value,
    #[serde(default)]
    pub inputs: Vec<InputDeclaration>,
    pub resources: ResourceDeclaration,
    pub outputs: Vec<OutputContract>,
    /// Pins the job to one runtime identity (`runtimeId` from the runtime
    /// manifest). Absent means any runtime that can serve the workload.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<RuntimePin>,
    /// Opaque ownership passthrough for jobs claimed from an external control
    /// plane. The runner records it in every event and in the artifact
    /// manifest; it never talks to the control plane itself.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lease: Option<LeasePassthrough>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub labels: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimePin {
    pub runtime_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LeasePassthrough {
    pub lease_id: String,
    pub fence_token: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InputDeclaration {
    pub input_id: String,
    pub sha256: String,
    pub size_bytes: u64,
    /// Path, relative to the job workspace, at which the engine sees the
    /// input. Defaults to `inputs/<inputId>`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relative_path: Option<String>,
    pub source: InputSource,
}

/// Where the bytes come from when they are not yet in the worker's store.
/// Remote transfer is owned by the existing cloud worker, which hands the
/// runner local files; the runner itself only resolves local content.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum InputSource {
    /// Must already be present in the content store under its digest.
    Cas,
    /// A local file, verified against the declared digest and ingested into
    /// the content store at submission. The source file is never modified or
    /// removed by the runner.
    File { path: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OutputContract {
    pub output_id: String,
    /// Path relative to the job's output directory.
    pub relative_path: String,
    pub media_type: String,
    /// Required outputs must exist for the job to complete.
    #[serde(default = "default_true")]
    pub required: bool,
    /// Pinned digest for deterministic replays: completion fails if the
    /// produced bytes differ.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_sha256: Option<String>,
    /// When set, `relativePath` is a pattern (`*` within a segment, `**` for
    /// any number of segments) that may match many produced files, e.g.
    /// `frames/*/*/tick-*.png`. `required` then means at least one match.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub glob: bool,
}

impl OutputContract {
    /// Whether a produced path satisfies this contract.
    pub fn matches(&self, relative_path: &str) -> bool {
        if self.glob {
            glob_match(&self.relative_path, relative_path)
        } else {
            self.relative_path == relative_path
        }
    }
}

/// Segment-wise glob: `**` spans zero or more segments; `*` inside a segment
/// matches any run of non-separator characters.
pub fn glob_match(pattern: &str, path: &str) -> bool {
    fn segment(pattern: &str, text: &str) -> bool {
        match pattern.split_once('*') {
            None => pattern == text,
            Some((head, tail)) => {
                if !text.starts_with(head) {
                    return false;
                }
                let rest = &text[head.len()..];
                (0..=rest.len()).any(|split| segment(tail, &rest[split..]))
            }
        }
    }
    fn walk(patterns: &[&str], parts: &[&str]) -> bool {
        match patterns.split_first() {
            None => parts.is_empty(),
            Some((&"**", rest)) => (0..=parts.len()).any(|skip| walk(rest, &parts[skip..])),
            Some((first, rest)) => parts
                .split_first()
                .is_some_and(|(part, remaining)| segment(first, part) && walk(rest, remaining)),
        }
    }
    let patterns: Vec<&str> = pattern.split('/').collect();
    let parts: Vec<&str> = path.split('/').collect();
    walk(&patterns, &parts)
}

fn default_true() -> bool {
    true
}

pub fn is_valid_job_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_JOB_ID_LEN
        && !value.starts_with('.')
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

/// A relative path that stays inside its base: non-empty, no root, no `..`,
/// no `.` components.
pub fn is_safe_relative(value: &str) -> bool {
    if value.is_empty() || value.ends_with('/') {
        return false;
    }
    Path::new(value)
        .components()
        .all(|component| matches!(component, Component::Normal(_)))
}

impl JobManifest {
    pub fn validate(&self) -> Result<()> {
        let reject = |reason: String| Err(RunnerError::Manifest { reason });
        if self.schema != JOB_MANIFEST_SCHEMA {
            return reject(format!(
                "schema must be {JOB_MANIFEST_SCHEMA}, got {}",
                self.schema
            ));
        }
        if !is_valid_job_id(&self.job_id) {
            return reject(format!(
                "jobId {:?} must match [A-Za-z0-9._-]{{1,{MAX_JOB_ID_LEN}}} and not start with '.'",
                self.job_id
            ));
        }
        if self.workload.is_empty() || self.workload.len() > 128 || !self.workload.is_ascii() {
            return reject("workload must be a non-empty ASCII identifier".into());
        }
        if !self.params.is_object() && !self.params.is_null() {
            return reject("params must be a JSON object or null".into());
        }
        self.resources
            .validate()
            .map_err(|reason| RunnerError::Manifest { reason })?;

        let mut input_ids = std::collections::BTreeSet::new();
        let mut input_paths = std::collections::BTreeSet::new();
        for input in &self.inputs {
            if input.input_id.is_empty() || input.input_id.len() > 128 {
                return reject("inputId must be 1..=128 characters".into());
            }
            if !input_ids.insert(input.input_id.as_str()) {
                return reject(format!("duplicate inputId {}", input.input_id));
            }
            if !is_sha256_hex(&input.sha256) {
                return reject(format!(
                    "input {} sha256 must be 64 lowercase hex characters",
                    input.input_id
                ));
            }
            let path = input.workspace_path();
            if !is_safe_relative(&path) {
                return reject(format!(
                    "input {} relativePath {path:?} escapes the workspace",
                    input.input_id
                ));
            }
            if !input_paths.insert(path.clone()) {
                return reject(format!("duplicate input relativePath {path}"));
            }
            if let InputSource::File { path } = &input.source {
                if path.is_empty() {
                    return reject(format!(
                        "input {} file source path is empty",
                        input.input_id
                    ));
                }
            }
        }

        if self.outputs.is_empty() {
            return reject("outputs must declare at least one output contract".into());
        }
        let mut output_ids = std::collections::BTreeSet::new();
        let mut output_paths = std::collections::BTreeSet::new();
        for output in &self.outputs {
            if output.output_id.is_empty() || output.output_id.len() > 128 {
                return reject("outputId must be 1..=128 characters".into());
            }
            if !output_ids.insert(output.output_id.as_str()) {
                return reject(format!("duplicate outputId {}", output.output_id));
            }
            if !is_safe_relative(&output.relative_path) {
                return reject(format!(
                    "output {} relativePath {:?} escapes the output directory",
                    output.output_id, output.relative_path
                ));
            }
            if !output_paths.insert(output.relative_path.as_str()) {
                return reject(format!(
                    "duplicate output relativePath {}",
                    output.relative_path
                ));
            }
            if output.media_type.is_empty() {
                return reject(format!("output {} mediaType is empty", output.output_id));
            }
            if let Some(expected) = &output.expected_sha256 {
                if !is_sha256_hex(expected) {
                    return reject(format!(
                        "output {} expectedSha256 must be 64 lowercase hex characters",
                        output.output_id
                    ));
                }
                if output.glob {
                    return reject(format!(
                        "output {} cannot pin expectedSha256 on a glob contract",
                        output.output_id
                    ));
                }
            }
        }
        if let Some(pin) = &self.runtime {
            if !is_sha256_hex(&pin.runtime_id) {
                return reject("runtime.runtimeId must be a runtime manifest sha256".into());
            }
        }
        if let Some(lease) = &self.lease {
            if lease.lease_id.is_empty() || lease.fence_token.is_empty() {
                return reject("lease requires non-empty leaseId and fenceToken".into());
            }
        }
        Ok(())
    }

    /// The canonical manifest identity: sha256 over sorted-key compact JSON.
    pub fn sha256(&self) -> Result<String> {
        canonical_sha256(self)
    }

    pub fn output(&self, output_id: &str) -> Option<&OutputContract> {
        self.outputs
            .iter()
            .find(|output| output.output_id == output_id)
    }

    /// The contract a produced path satisfies: exact contracts first, then
    /// glob contracts in declaration order.
    pub fn output_for_path(&self, relative_path: &str) -> Option<&OutputContract> {
        self.outputs
            .iter()
            .find(|output| !output.glob && output.relative_path == relative_path)
            .or_else(|| {
                self.outputs
                    .iter()
                    .find(|output| output.glob && output.matches(relative_path))
            })
    }
}

impl InputDeclaration {
    pub fn workspace_path(&self) -> String {
        match &self.relative_path {
            Some(path) => path.clone(),
            None => format!("inputs/{}", self.input_id),
        }
    }

    pub fn digest(&self) -> crate::hash::ContentDigest {
        crate::hash::ContentDigest {
            sha256: self.sha256.clone(),
            size_bytes: self.size_bytes,
        }
    }
}
