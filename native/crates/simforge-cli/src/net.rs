//! HTTP(S) and `file://` reads for registries and asset stores.
//!
//! One agent configuration for every command: rustls (no system OpenSSL),
//! a global timeout, and a `simforge/<version>` user agent. Failures are
//! typed so a caller can tell "unreachable" from "reached, but said no".

use std::io::Read;
use std::path::PathBuf;
use std::time::Duration;

use serde_json::json;

use crate::contract::CliError;

/// Why a fetch failed.
#[derive(Debug)]
pub enum FetchError {
    /// DNS, connect, TLS or timeout: nothing answered.
    Unreachable(String),
    /// Something answered with a non-2xx status.
    Status(u16),
    /// A local `file://` path that could not be read.
    Io(std::io::Error),
    /// The URL scheme is neither http(s) nor file.
    Scheme(String),
}

impl std::fmt::Display for FetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FetchError::Unreachable(e) => write!(f, "unreachable: {e}"),
            FetchError::Status(code) => write!(f, "HTTP {code}"),
            FetchError::Io(e) => write!(f, "{e}"),
            FetchError::Scheme(s) => write!(
                f,
                "unsupported URL scheme `{s}` (use https://, http:// or file://)"
            ),
        }
    }
}

impl FetchError {
    /// The contract error for a failed read of `url`.
    pub fn into_cli(self, url: &str) -> CliError {
        let code = match &self {
            FetchError::Unreachable(_) => "registry_unreachable",
            FetchError::Status(404) | FetchError::Io(_) => "not_found",
            FetchError::Status(_) => "registry_error",
            FetchError::Scheme(_) => "bad_value",
        };
        CliError::new(code, format!("could not read {url}: {self}"))
            .with_path(url.to_owned())
            .with_detail(json!({ "url": url }))
    }
}

/// The maximum body read into memory by [`get_bytes`]. Registry documents are
/// small; large blobs are streamed by the commands that fetch them.
pub const MAX_DOCUMENT_BYTES: u64 = 64 * 1024 * 1024;

pub fn agent(timeout: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        .user_agent(concat!("simforge/", env!("CARGO_PKG_VERSION")))
        .build()
        .into()
}

fn file_path(url: &str) -> Option<PathBuf> {
    url.strip_prefix("file://").map(PathBuf::from)
}

/// GET `url` into memory (at most [`MAX_DOCUMENT_BYTES`]).
pub fn get_bytes(url: &str, timeout: Duration) -> Result<Vec<u8>, FetchError> {
    if let Some(path) = file_path(url) {
        return std::fs::read(path).map_err(FetchError::Io);
    }
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err(FetchError::Scheme(
            url.split("://").next().unwrap_or(url).to_owned(),
        ));
    }
    let response = agent(timeout).get(url).call().map_err(|e| match e {
        ureq::Error::StatusCode(code) => FetchError::Status(code),
        other => FetchError::Unreachable(other.to_string()),
    })?;
    let mut bytes = Vec::new();
    response
        .into_body()
        .into_reader()
        .take(MAX_DOCUMENT_BYTES)
        .read_to_end(&mut bytes)
        .map_err(|e| FetchError::Unreachable(e.to_string()))?;
    Ok(bytes)
}
