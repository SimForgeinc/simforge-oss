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
    file_url_path(url)
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

/// Decode `%XX` escapes in a `file://` URL path (the TS registry decodes the
/// pathname the same way).
fn percent_decode(path: &str) -> String {
    let bytes = path.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = &bytes[i + 1..i + 3];
            if hex.iter().all(u8::is_ascii_hexdigit) {
                let v =
                    u8::from_str_radix(std::str::from_utf8(hex).unwrap_or("0"), 16).unwrap_or(0);
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The local directory a `file://` URL names.
pub fn file_url_path(url: &str) -> Option<PathBuf> {
    url.strip_prefix("file://")
        .map(|p| PathBuf::from(percent_decode(p)))
}

/// `encodeURIComponent` of one path segment (unreserved characters and
/// `!'()*` stay; everything else becomes `%XX` of its UTF-8 bytes).
pub fn encode_uri_component(segment: &str) -> String {
    let mut out = String::with_capacity(segment.len());
    for b in segment.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(char::from(b));
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Open a streaming GET of `url` (http, https or file) on `agent`, whose
/// connection pool is reused across calls. `timeout` bounds this request
/// alone. `bearer` is sent as `Authorization: Bearer <token>` on http(s)
/// only, and ureq never forwards it across a redirect.
pub fn open(
    agent: &ureq::Agent,
    url: &str,
    timeout: Duration,
    bearer: Option<&str>,
) -> Result<Box<dyn Read + Send>, FetchError> {
    if let Some(path) = file_url_path(url) {
        return std::fs::File::open(path)
            .map(|f| Box::new(f) as Box<dyn Read + Send>)
            .map_err(FetchError::Io);
    }
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err(FetchError::Scheme(
            url.split("://").next().unwrap_or(url).to_owned(),
        ));
    }
    let mut request = agent
        .get(url)
        .config()
        .timeout_global(Some(timeout))
        .build();
    if let Some(token) = bearer {
        request = request.header("Authorization", format!("Bearer {token}"));
    }
    let response = request.call().map_err(|e| match e {
        ureq::Error::StatusCode(code) => FetchError::Status(code),
        other => FetchError::Unreachable(other.to_string()),
    })?;
    Ok(Box::new(response.into_body().into_reader()))
}

/// An agent for many requests to one origin: no global timeout (each
/// request sets its own) and a pool deep enough for parallel downloads.
pub fn pooled_agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .user_agent(concat!("simforge/", env!("CARGO_PKG_VERSION")))
        .max_idle_connections(64)
        .max_idle_connections_per_host(64)
        .build()
        .into()
}

/// Whether a failed fetch is worth retrying (the bytes are verified either way).
pub fn is_transient(error: &FetchError) -> bool {
    match error {
        FetchError::Unreachable(_) => true,
        FetchError::Status(code) => *code == 408 || *code == 429 || *code >= 500,
        FetchError::Io(_) | FetchError::Scheme(_) => false,
    }
}
