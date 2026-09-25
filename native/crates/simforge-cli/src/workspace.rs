//! A workspace: an imported `simforge.scenario-package/v1`, unpacked.
//!
//! The members sit at their package paths (docs/engineering/scenario-package.md
//! section 3.3): `manifest.json`, `document.json`, `simulation/trace.json.gz`,
//! `simulation/resolution.json.gz`, `timeline/<sha256>.json`, `map/closure.json`,
//! `actors/closure.json`, `catalog/entries.json`. `package import` writes this
//! layout after verifying every member; the commands that read a workspace
//! (timeline build, render, simulate, env serve) read only the fields below.
//! The strict manifest schema belongs to the `simforge-package` crate; until it
//! lands this reader checks the schema string and the fields it uses, and
//! fails loudly on anything missing.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::contract::CliError;

pub const PACKAGE_SCHEMA: &str = "simforge.scenario-package/v1";
pub const MANIFEST: &str = "manifest.json";
pub const TRACE: &str = "simulation/trace.json.gz";
pub const RESOLUTION: &str = "simulation/resolution.json.gz";
pub const TIMELINE_DIR: &str = "timeline";

/// One packaged timeline's identity (`manifest.timelines[]`).
#[derive(Debug, Clone)]
pub struct PackagedTimeline {
    pub timeline_sha256: String,
    pub timeline_key: String,
    pub sampler_version: String,
    pub height_field_digest: String,
    pub catalog_digest: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Workspace {
    pub dir: PathBuf,
    pub manifest: Value,
}

fn missing(dir: &Path, field: &str) -> CliError {
    CliError::findings(
        "workspace_invalid",
        format!("the workspace manifest has no `{field}`"),
    )
    .with_path(dir.join(MANIFEST).display().to_string())
}

impl Workspace {
    pub fn open(dir: &Path) -> Result<Self, CliError> {
        let path = dir.join(MANIFEST);
        let bytes = std::fs::read(&path).map_err(|e| {
            CliError::new(
                "workspace_not_found",
                format!(
                    "{} is not a workspace (no readable {MANIFEST}: {e})",
                    dir.display()
                ),
            )
            .with_path(dir.display().to_string())
            .with_detail(json!({ "hint": "create one with `simforge package import <package.zip> --into <dir>`" }))
        })?;
        let manifest: Value = serde_json::from_slice(&bytes).map_err(|e| {
            CliError::findings("workspace_invalid", format!("{MANIFEST} is not JSON: {e}"))
                .with_path(path.display().to_string())
        })?;
        if manifest["schema"] != PACKAGE_SCHEMA {
            return Err(CliError::findings(
                "workspace_invalid",
                format!(
                    "{MANIFEST} has schema {}, expected {PACKAGE_SCHEMA}",
                    manifest["schema"]
                ),
            )
            .with_path(path.display().to_string()));
        }
        Ok(Self {
            dir: dir.to_path_buf(),
            manifest,
        })
    }

    pub fn member(&self, path: &str) -> PathBuf {
        path.split('/')
            .fold(self.dir.clone(), |p, part| p.join(part))
    }

    pub fn read_member(&self, path: &str) -> Result<Vec<u8>, CliError> {
        let file = self.member(path);
        std::fs::read(&file).map_err(|e| {
            CliError::findings(
                "workspace_member_missing",
                format!("cannot read workspace member {path}: {e}"),
            )
            .with_path(file.display().to_string())
        })
    }

    fn str_at(&self, pointer: &str) -> Result<&str, CliError> {
        self.manifest
            .pointer(pointer)
            .and_then(Value::as_str)
            .ok_or_else(|| missing(&self.dir, pointer))
    }

    /// `simulation.traceSha256`: the canonical trace identity.
    pub fn trace_sha256(&self) -> Result<&str, CliError> {
        self.str_at("/simulation/traceSha256")
    }

    /// `map.xodrSha256`: the OpenDRIVE the trace was simulated on.
    pub fn xodr_sha256(&self) -> Result<&str, CliError> {
        self.str_at("/map/xodrSha256")
    }

    /// `map.heightSourceDigest`: the height source the packaged timelines used.
    pub fn height_source_digest(&self) -> Option<&str> {
        self.manifest
            .pointer("/map/heightSourceDigest")
            .and_then(Value::as_str)
    }

    pub fn map_label(&self) -> Option<&str> {
        self.manifest
            .pointer("/map/sourceMapId")
            .and_then(Value::as_str)
    }

    pub fn timelines(&self) -> Result<Vec<PackagedTimeline>, CliError> {
        let list = self
            .manifest
            .get("timelines")
            .and_then(Value::as_array)
            .ok_or_else(|| missing(&self.dir, "/timelines"))?;
        list.iter()
            .enumerate()
            .map(|(i, t)| {
                let field = |name: &str| {
                    t[name]
                        .as_str()
                        .map(str::to_owned)
                        .ok_or_else(|| missing(&self.dir, &format!("/timelines/{i}/{name}")))
                };
                Ok(PackagedTimeline {
                    timeline_sha256: field("timelineSha256")?,
                    timeline_key: field("timelineKey")?,
                    sampler_version: field("samplerVersion")?,
                    height_field_digest: field("heightFieldDigest")?,
                    catalog_digest: t["catalogDigest"].as_str().map(str::to_owned),
                })
            })
            .collect()
    }

    /// Where a timeline with this digest lives in the workspace.
    pub fn timeline_path(&self, timeline_sha256: &str) -> PathBuf {
        self.dir
            .join(TIMELINE_DIR)
            .join(format!("{timeline_sha256}.json"))
    }
}
