//! Scenario packages (`simforge.scenario-package/v1`) for Node: the hosted
//! app's "Export for CLI" writes through here, so its containers are
//! byte-identical to the ones the `simforge` CLI writes (one Rust writer).
//!
//! Errors carry `package␟<error JSON>␟<message>` in the reason; the
//! TypeScript wrapper rebuilds a `ScenarioPackageError` with `code`, `rule`,
//! `path` and `dimensions`.

use std::path::Path;

use napi::bindgen_prelude::*;
use napi_derive::napi;

use simforge_package::{
    inspect_bytes, verify_bytes, verify_file, ErrorCode, PackageBuilder, PackageError,
    PackageReader, ReceiptInput, VerifyOptions,
};

fn to_napi(err: PackageError) -> Error {
    let status = match err.code {
        ErrorCode::ArgumentInvalid => Status::InvalidArg,
        _ => Status::GenericFailure,
    };
    Error::new(
        status,
        format!("package\u{1f}{}\u{1f}{}", err.to_json(), err),
    )
}

fn js<T>(r: simforge_package::Result<T>) -> Result<T> {
    r.map_err(to_napi)
}

fn report<T: serde::Serialize>(value: &T) -> Result<String> {
    serde_json::to_string(value).map_err(|e| Error::new(Status::GenericFailure, e.to_string()))
}

fn options(cli_version: Option<String>) -> Result<VerifyOptions> {
    js(VerifyOptions::new(cli_version.as_deref()))
}

/// One listed member: its path (`document.json`, `timeline/<sha>.json`, ...) and bytes.
#[napi(object)]
pub struct ScenarioPackageMember {
    pub path: String,
    pub data: Uint8Array,
}

/// One blob (full form): bytes in memory, or a file whose sha256 is given.
#[napi(object)]
pub struct ScenarioPackageBlob {
    pub data: Option<Uint8Array>,
    pub sha256: Option<String>,
    pub file: Option<String>,
}

#[napi(object)]
pub struct ScenarioPackageReceipt {
    pub exported_at: String,
    pub exporter_release: String,
    pub texture_tier: Option<String>,
}

#[napi(object)]
pub struct ScenarioPackageWritten {
    pub package_id: String,
    pub form: String,
    /// `manifest.json`: the exact canonical bytes whose sha256 is the package id.
    pub manifest_json: String,
    /// `WriteOutcome` as JSON (form, sizes, content report).
    pub report_json: String,
    /// The container, when no `outPath` was given.
    pub bytes: Option<Buffer>,
}

#[napi(object)]
pub struct ScenarioPackageBlobOut {
    pub sha256: String,
    pub data: Buffer,
}

#[napi(object)]
pub struct ScenarioPackageMemberOut {
    pub path: String,
    pub data: Buffer,
}

#[napi(object)]
pub struct ScenarioPackageContents {
    pub manifest_json: String,
    pub receipt_json: Option<String>,
    /// `Verification` as JSON.
    pub report_json: String,
    pub members: Vec<ScenarioPackageMemberOut>,
    pub blobs: Vec<ScenarioPackageBlobOut>,
}

/// Write a package. `manifestDraftJson` is the whole v1 manifest except
/// `members`, which the writer computes. With `outPath` the container is
/// written to that file (via a temporary sibling) instead of returned.
#[napi]
pub fn scenario_package_write(
    manifest_draft_json: String,
    members: Vec<ScenarioPackageMember>,
    blobs: Vec<ScenarioPackageBlob>,
    receipt: Option<ScenarioPackageReceipt>,
    out_path: Option<String>,
) -> Result<ScenarioPackageWritten> {
    let mut builder = js(PackageBuilder::from_draft_json(&manifest_draft_json))?;
    for m in members {
        js(builder.member(&m.path, m.data.to_vec()))?;
    }
    for b in blobs {
        match (b.data, b.file, b.sha256) {
            (Some(data), None, sha) => {
                let got = builder.blob(data.to_vec());
                if let Some(sha) = sha {
                    if sha != got {
                        return Err(to_napi(PackageError::argument(
                            "blob_digest",
                            format!("a blob given as {sha} hashes to {got}"),
                        )));
                    }
                }
            }
            (None, Some(file), Some(sha)) => {
                js(builder.blob_file(&sha, Path::new(&file)))?;
            }
            _ => {
                return Err(to_napi(PackageError::argument(
                    "blob",
                    "a blob is { data } or { sha256, file }",
                )))
            }
        }
    }
    if let Some(r) = receipt {
        builder.receipt(ReceiptInput {
            exported_at: r.exported_at,
            exporter_release: r.exporter_release,
            texture_tier: r.texture_tier,
        });
    }
    let (outcome, bytes) = match out_path {
        Some(path) => (js(builder.write_file(Path::new(&path)))?, None),
        None => {
            let (outcome, bytes) = js(builder.to_bytes())?;
            (outcome, Some(Buffer::from(bytes)))
        }
    };
    Ok(ScenarioPackageWritten {
        package_id: outcome.package_id.clone(),
        form: outcome.form.as_str().to_owned(),
        manifest_json: String::from_utf8(outcome.manifest_bytes.clone())
            .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?,
        report_json: report(&outcome)?,
        bytes,
    })
}

/// Fully verify a container (bytes, or a file path). Returns the
/// `Verification` report as JSON. `cliVersion` is the reading CLI's version
/// for the `producer.minCli` check; `null` when a producer re-checks its own
/// output (the report then says `cliCheck: "not-evaluated"`).
#[napi]
pub fn scenario_package_verify(
    bytes: Option<Uint8Array>,
    path: Option<String>,
    cli_version: Option<String>,
) -> Result<String> {
    let opts = options(cli_version)?;
    let verification = match (bytes, path) {
        (Some(bytes), None) => js(verify_bytes(&bytes, &opts))?,
        (None, Some(path)) => js(verify_file(Path::new(&path), &opts))?,
        _ => {
            return Err(to_napi(PackageError::argument(
                "input",
                "pass exactly one of bytes or path",
            )))
        }
    };
    report(&verification)
}

/// Structure, manifest and version checks only (no member hashing).
#[napi]
pub fn scenario_package_inspect(bytes: Uint8Array, cli_version: Option<String>) -> Result<String> {
    let opts = options(cli_version)?;
    report(&js(inspect_bytes(&bytes, &opts))?)
}

/// Verify, then return every member and blob (each re-proven as it is read).
#[napi]
pub fn scenario_package_read(
    bytes: Uint8Array,
    cli_version: Option<String>,
) -> Result<ScenarioPackageContents> {
    let opts = options(cli_version)?;
    let mut reader = js(PackageReader::open(std::io::Cursor::new(&bytes[..]), &opts))?;
    let verification = js(reader.verify())?;
    let paths: Vec<String> = reader
        .manifest()
        .members
        .iter()
        .map(|m| m.path.clone())
        .collect();
    let mut members = Vec::with_capacity(paths.len());
    for path in paths {
        let data = js(reader.read_member(&path))?;
        members.push(ScenarioPackageMemberOut {
            path,
            data: Buffer::from(data),
        });
    }
    let mut blobs = Vec::new();
    for sha256 in reader.blob_digests() {
        let mut data = Vec::new();
        js(reader.copy_blob(&sha256, &mut data))?;
        blobs.push(ScenarioPackageBlobOut {
            sha256,
            data: Buffer::from(data),
        });
    }
    let receipt_json = match reader.receipt() {
        Some(r) => Some(
            String::from_utf8(js(r.to_canonical_bytes())?)
                .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?,
        ),
        None => None,
    };
    Ok(ScenarioPackageContents {
        manifest_json: String::from_utf8(reader.manifest_bytes().to_vec())
            .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?,
        receipt_json,
        report_json: report(&verification)?,
        members,
        blobs,
    })
}
