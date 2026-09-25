//! The map registry, read side: resolve `name[@version]` to an immutable
//! release, verify it, and materialize its closures into the local cache.
//!
//! A port of `pullVersion` in `oss/packages/map-registry/src/registry.ts`.
//! The on-disk result (layouts, hardlinked blob cache, `.map-release.json`
//! receipts in canonical JSON) is byte-identical to the TypeScript CLI's, so
//! the compiler, the renderer and Studio find a map pulled by either.
//!
//! Trust chain, each link checked before the next is read:
//! `index.json` → `maps/<name>/versions.json` (the record's `releaseDigest`)
//! → `release.json` (its canonical digest must equal that record) → the
//! canonical closure (its digest must equal both the record and the
//! release) → every blob (size and sha256 against the closure). Nothing is
//! installed until every blob a profile needs is verified in the cache, and
//! each profile directory appears by one atomic rename.

use std::collections::{BTreeMap, BTreeSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::auth;
use crate::contract::CliError;
use crate::net::{self, FetchError};
use crate::paths;

/// The env var holding a bearer token for a private http(s) registry named
/// by `--registry` or `SIMFORGE_MAPS_REGISTRY`.
pub const TOKEN_ENV: &str = "SIMFORGE_MAPS_REGISTRY_TOKEN";

/// Timeout for registry documents (index, versions, release, closures).
const DOCUMENT_TIMEOUT: Duration = Duration::from_secs(60);
/// Attempts per blob for transient network failures.
const BLOB_ATTEMPTS: u32 = 3;
/// The public map (the only one a public release may carry).
const PUBLIC_MAP: &str = "richmond-field-station";
const RECEIPT: &str = ".map-release.json";

// ------------------------------------------------------------------ errors

fn invalid(code: &str, reason: impl Into<String>) -> CliError {
    CliError::findings(code, reason)
}

fn io_error(path: &Path, error: std::io::Error) -> CliError {
    CliError::new("io_error", format!("{}: {error}", path.display()))
        .with_path(path.display().to_string())
}

// ------------------------------------------------------------------ canonical JSON

pub fn canonical_json(value: &Value) -> String {
    simforge_core::hash::canonical_json(value)
        .expect("registry documents hold only finite JSON numbers")
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn digest_of(value: &Value) -> String {
    sha256_hex(canonical_json(value).as_bytes())
}

// ------------------------------------------------------------------ validation (schema.ts)

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn is_map_name(name: &str) -> bool {
    // ^[a-z0-9]+(?:-[a-z0-9]+)*$
    !name.is_empty()
        && name.split('-').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        })
}

fn is_version(version: &str) -> bool {
    // ^v[1-9][0-9]*$
    let Some(rest) = version.strip_prefix('v') else {
        return false;
    };
    !rest.is_empty() && rest.as_bytes()[0] != b'0' && rest.bytes().all(|b| b.is_ascii_digit())
}

/// `assertSafeRelativePath`.
pub fn assert_safe_relative_path(path: &str) -> Result<(), CliError> {
    let unsafe_char = path
        .chars()
        .any(|c| matches!(c, '%' | ':' | '?' | '#') || (c as u32) < 0x20);
    if path.is_empty()
        || path.starts_with('/')
        || path.contains('\\')
        || unsafe_char
        || path
            .split('/')
            .any(|p| p.is_empty() || p == "." || p == "..")
    {
        return Err(invalid(
            "unsafe_member_path",
            format!("unsafe closure member path: {path:?}"),
        )
        .with_path(path.to_owned()));
    }
    Ok(())
}

/// ISO-8601 date or date-time, the forms `Date.parse` accepts from our writers.
fn is_timestamp(value: &str) -> bool {
    let b = value.as_bytes();
    let digits =
        |r: std::ops::Range<usize>| r.clone().all(|i| b.get(i).is_some_and(u8::is_ascii_digit));
    if b.len() < 10
        || !digits(0..4)
        || b[4] != b'-'
        || !digits(5..7)
        || b[7] != b'-'
        || !digits(8..10)
    {
        return false;
    }
    if b.len() == 10 {
        return true;
    }
    if b[10] != b'T' || b.len() < 16 || !digits(11..13) || b[13] != b':' || !digits(14..16) {
        return false;
    }
    let mut i = 16;
    if b.get(i) == Some(&b':') {
        if !digits(i + 1..i + 3) {
            return false;
        }
        i += 3;
        if b.get(i) == Some(&b'.') {
            i += 1;
            let start = i;
            while b.get(i).is_some_and(u8::is_ascii_digit) {
                i += 1;
            }
            if i == start {
                return false;
            }
        }
    }
    match &b[i..] {
        [] | [b'Z'] => true,
        [s, h1, h2, b':', m1, m2] => {
            matches!(s, b'+' | b'-') && [h1, h2, m1, m2].iter().all(|d| d.is_ascii_digit())
        }
        _ => false,
    }
}

/// One closure member, after `assertClosure`.
#[derive(Debug, Clone)]
pub struct Member {
    pub sha256: String,
    pub bytes: u64,
    /// The member object verbatim, for the receipt.
    pub raw: Value,
}

#[derive(Debug, Clone)]
pub struct Closure {
    pub kind: String,
    pub master: bool,
    pub members: BTreeMap<String, Member>,
    pub digest: String,
}

/// `Number.isSafeInteger(x) && x >= 0` on a JSON number.
fn safe_nonnegative_integer(value: &Value) -> Option<u64> {
    const MAX_SAFE: u64 = (1 << 53) - 1;
    if let Some(u) = value.as_u64() {
        return (u <= MAX_SAFE).then_some(u);
    }
    let f = value.as_f64()?;
    (f >= 0.0 && f.fract() == 0.0 && f <= MAX_SAFE as f64).then_some(f as u64)
}

/// `assertClosure` over a parsed closure document.
pub fn parse_closure(value: &Value, label: &str) -> Result<Closure, CliError> {
    let bad = |reason: String| invalid("closure_invalid", format!("{label}: {reason}"));
    let obj = value
        .as_object()
        .ok_or_else(|| bad("not an object".into()))?;
    if obj.get("schema").and_then(Value::as_str) != Some("map-closure.v1") {
        return Err(bad(format!(
            "unsupported closure schema: {}",
            obj.get("schema").unwrap_or(&Value::Null)
        )));
    }
    let kind = obj.get("kind").and_then(Value::as_str).unwrap_or_default();
    if kind != "canonical" && kind != "web" {
        return Err(bad(format!("unsupported closure kind: {kind:?}")));
    }
    let members_value = obj
        .get("members")
        .and_then(Value::as_object)
        .ok_or_else(|| bad("invalid closure members".into()))?;
    if kind != "canonical" && obj.get("toolFingerprint").is_none() {
        return Err(bad(format!(
            "derived closure {kind} requires toolFingerprint"
        )));
    }
    let mut members = BTreeMap::new();
    for (path, member) in members_value {
        assert_safe_relative_path(path)?;
        let sha = member
            .get("sha256")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !is_sha256(sha) {
            return Err(bad(format!("invalid sha256 for {path}")).with_path(path.clone()));
        }
        let bytes = member
            .get("bytes")
            .and_then(safe_nonnegative_integer)
            .ok_or_else(|| bad(format!("invalid byte count for {path}")).with_path(path.clone()))?;
        members.insert(
            path.clone(),
            Member {
                sha256: sha.to_owned(),
                bytes,
                raw: member.clone(),
            },
        );
    }
    let master = obj
        .get("metadata")
        .and_then(|m| m.get("master"))
        .and_then(Value::as_bool)
        == Some(true);
    Ok(Closure {
        kind: kind.to_owned(),
        master,
        members,
        digest: digest_of(value),
    })
}

#[derive(Debug, Clone)]
pub struct ClosureRef {
    pub key: String,
    pub digest: String,
}

#[derive(Debug, Clone)]
pub struct Release {
    pub canonical: ClosureRef,
    pub web: Option<ClosureRef>,
    pub digest: String,
}

/// `assertRelease` + `releaseDigest`.
pub fn parse_release(value: &Value) -> Result<Release, CliError> {
    let bad = |reason: &str| invalid("release_invalid", reason.to_owned());
    let obj = value
        .as_object()
        .ok_or_else(|| bad("unsupported map release"))?;
    if obj.get("schema").and_then(Value::as_str) != Some("simforge.map-release.v1") {
        return Err(bad("unsupported map release"));
    }
    let name = obj.get("name").and_then(Value::as_str).unwrap_or_default();
    let version = obj
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !is_map_name(name) || !is_version(version) {
        return Err(bad("invalid map release identity"));
    }
    let expected_visibility = if name == PUBLIC_MAP {
        "public"
    } else {
        "private"
    };
    if obj.get("visibility").and_then(Value::as_str) != Some(expected_visibility) {
        return Err(bad("map release visibility violates public policy"));
    }
    if !obj
        .get("createdAt")
        .and_then(Value::as_str)
        .is_some_and(is_timestamp)
    {
        return Err(bad("invalid release timestamp"));
    }
    if obj.get("sourceRef").is_some_and(|v| !v.is_string()) {
        return Err(bad("invalid sourceRef"));
    }
    let prefix = format!("maps/{name}/{version}/");
    let reference = |v: Option<&Value>| -> Result<ClosureRef, CliError> {
        let key = v.and_then(|r| r.get("key")).and_then(Value::as_str);
        let digest = v.and_then(|r| r.get("digest")).and_then(Value::as_str);
        let (Some(key), Some(digest)) = (key, digest) else {
            return Err(bad("invalid release closure reference"));
        };
        assert_safe_relative_path(key)?;
        if !key.starts_with(&prefix) || !key.ends_with(".json") || !is_sha256(digest) {
            return Err(bad("invalid release closure reference"));
        }
        Ok(ClosureRef {
            key: key.to_owned(),
            digest: digest.to_owned(),
        })
    };
    let canonical = reference(obj.get("canonical"))?;
    let web = match obj.get("web") {
        None => None,
        Some(v) => Some(reference(Some(v))?),
    };
    Ok(Release {
        canonical,
        web,
        digest: digest_of(value),
    })
}

// ------------------------------------------------------------------ transport

/// How requests to a registry are authorized.
pub enum RegistryAuth {
    None,
    /// `SIMFORGE_MAPS_REGISTRY_TOKEN`, for a registry named explicitly.
    Env(String),
    /// The logged-in account's session on a SimForge host (`simforge login`
    /// or `SIMFORGE_TOKEN`), refreshed once if the registry rejects it.
    Account(Arc<auth::Credential>),
}

/// A read-only registry: a `file://` directory or an http(s) origin.
pub struct Registry {
    pub url: String,
    /// Why this registry: `flag:--registry`, `env:NAME`, `account:<host>` or `default`.
    pub source: String,
    auth: RegistryAuth,
    agent: ureq::Agent,
}

impl Registry {
    pub fn new(url: &str, auth: RegistryAuth, source: impl Into<String>) -> Result<Self, CliError> {
        let url = url.trim_end_matches('/').to_owned();
        if url.starts_with("s3://") {
            return Err(CliError::new(
                "bad_value",
                "s3:// registries need AWS credentials and are not supported by this CLI; use the registry's https:// origin (with SIMFORGE_MAPS_REGISTRY_TOKEN if it is private) or a file:// mirror",
            )
            .with_path("--registry"));
        }
        if !(url.starts_with("file://")
            || url.starts_with("https://")
            || url.starts_with("http://"))
        {
            return Err(
                CliError::new("bad_value", format!("unsupported registry URL: {url}"))
                    .with_path("--registry"),
            );
        }
        let auth = if url.starts_with("file://") {
            RegistryAuth::None
        } else {
            auth
        };
        Ok(Self {
            url,
            source: source.into(),
            auth,
            agent: net::pooled_agent(),
        })
    }

    pub fn authenticated(&self) -> bool {
        !matches!(self.auth, RegistryAuth::None)
    }

    /// The `registry` object of a result document: where, why, and as whom
    /// (never a token).
    pub fn describe(&self) -> Value {
        let mut out = json!({
            "url": self.url,
            "source": self.source,
            "authenticated": self.authenticated(),
        });
        match &self.auth {
            RegistryAuth::None => {
                out["auth"] = json!("none");
            }
            RegistryAuth::Env(_) => {
                out["auth"] = json!(format!("bearer (env:{TOKEN_ENV})"));
            }
            RegistryAuth::Account(credential) => {
                out["auth"] = json!(format!("account ({})", credential.source_label()));
                out["host"] = json!(credential.host.name);
                if let auth::Source::Stored(record) = credential.source() {
                    out["account"] = json!(record.account.email);
                    out["organization"] = json!(record.organization.name);
                }
            }
        }
        out
    }

    /// Why a request was refused, with what to do about it.
    fn refusal(&self, error: FetchError, url: &str) -> CliError {
        let status = match &error {
            FetchError::Status(code @ (401 | 403)) => Some(*code),
            _ => None,
        };
        let cli = error.into_cli(url);
        let Some(status) = status else {
            return cli;
        };
        let hint = match &self.auth {
            RegistryAuth::Account(credential) => format!(
                "the login for {} was revoked, expired or lacks {}; run `simforge login --host {}`",
                credential.host.name,
                auth::host::MAPS_READ,
                credential.host.name
            ),
            RegistryAuth::Env(_) => format!("{TOKEN_ENV} is not accepted by this registry"),
            RegistryAuth::None => "this registry needs credentials: run `simforge login`, or set SIMFORGE_MAPS_REGISTRY_TOKEN for a registry you name with --registry".into(),
        };
        CliError::new(
            "unauthorized",
            format!("the registry refused access (HTTP {status}): {hint}"),
        )
        .with_path(url.to_owned())
        .with_detail(json!({ "url": url, "status": status, "registry": self.url, "hint": hint }))
    }

    fn object_url(&self, key: &str) -> String {
        if self.url.starts_with("file://") {
            format!("{}/{key}", self.url)
        } else {
            let encoded: Vec<String> = key.split('/').map(net::encode_uri_component).collect();
            format!("{}/{}", self.url, encoded.join("/"))
        }
    }

    fn open(&self, key: &str, timeout: Duration) -> Result<Box<dyn Read + Send>, FetchError> {
        let url = self.object_url(key);
        match &self.auth {
            RegistryAuth::None => net::open(&self.agent, &url, timeout, None),
            RegistryAuth::Env(token) => net::open(&self.agent, &url, timeout, Some(token)),
            RegistryAuth::Account(credential) => {
                let token = credential.access_token();
                match net::open(&self.agent, &url, timeout, Some(&token)) {
                    // The access token expired mid-run or was rotated by another
                    // process: refresh once and retry; a second 401 stands.
                    Err(FetchError::Status(401)) => {
                        match credential.refresh_after_rejection(&token) {
                            Ok(Some(fresh)) => net::open(&self.agent, &url, timeout, Some(&fresh)),
                            Ok(None) | Err(_) => Err(FetchError::Status(401)),
                        }
                    }
                    other => other,
                }
            }
        }
    }

    /// A registry document, or `None` when the registry does not have it.
    fn get_optional(&self, key: &str) -> Result<Option<Vec<u8>>, CliError> {
        match self.open(key, DOCUMENT_TIMEOUT) {
            Ok(reader) => {
                let mut bytes = Vec::new();
                reader
                    .take(net::MAX_DOCUMENT_BYTES)
                    .read_to_end(&mut bytes)
                    .map_err(|e| {
                        FetchError::Unreachable(e.to_string()).into_cli(&self.object_url(key))
                    })?;
                Ok(Some(bytes))
            }
            Err(FetchError::Status(404)) => Ok(None),
            Err(FetchError::Io(e)) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(self.refusal(e, &self.object_url(key))),
        }
    }

    /// `name@version` of the release in this registry whose version record
    /// names `release_digest` (when given) or whose canonical closure digest
    /// is `closure_digest` (index, then each map's versions.json).
    pub fn find_release(
        &self,
        release_digest: Option<&str>,
        closure_digest: &str,
        name_hint: &str,
    ) -> Result<Option<String>, CliError> {
        let index = self.index()?;
        let mut names: Vec<String> = index
            .as_object()
            .map(|o| o.keys().cloned().collect())
            .unwrap_or_default();
        names.sort_by_key(|n| n != name_hint);
        for name in names {
            if !is_map_name(&name) {
                continue;
            }
            let records = self
                .get_json_optional(&format!("maps/{name}/versions.json"))?
                .unwrap_or_else(|| json!([]));
            for record in records.as_array().into_iter().flatten() {
                let by_release =
                    release_digest.is_some_and(|d| record["releaseDigest"].as_str() == Some(d));
                let by_closure = record["closureDigest"].as_str() == Some(closure_digest);
                if by_release || (release_digest.is_none() && by_closure) {
                    if let Some(version) = record["version"].as_str() {
                        return Ok(Some(format!("{name}@{version}")));
                    }
                }
            }
        }
        Ok(None)
    }

    /// `index.json` read within `timeout`, which must exist and be an object
    /// (the `doctor` probe: a missing index is a failure there, not `{}`).
    pub fn index_strict(&self, timeout: Duration) -> Result<Map<String, Value>, CliError> {
        let url = self.object_url("index.json");
        let reader = self
            .open("index.json", timeout)
            .map_err(|e| self.refusal(e, &url))?;
        let mut bytes = Vec::new();
        reader
            .take(net::MAX_DOCUMENT_BYTES)
            .read_to_end(&mut bytes)
            .map_err(|e| FetchError::Unreachable(e.to_string()).into_cli(&url))?;
        serde_json::from_slice::<Map<String, Value>>(&bytes).map_err(|e| {
            CliError::new(
                "registry_document_invalid",
                format!("{url} is not a registry index: {e}"),
            )
            .with_path(url.clone())
        })
    }

    /// The registry's `index.json` (`{}` when it has none).
    pub fn index(&self) -> Result<Value, CliError> {
        Ok(self
            .get_json_optional("index.json")?
            .unwrap_or_else(|| json!({})))
    }

    fn get_json_optional(&self, key: &str) -> Result<Option<Value>, CliError> {
        let Some(bytes) = self.get_optional(key)? else {
            return Ok(None);
        };
        serde_json::from_slice(&bytes).map(Some).map_err(|e| {
            invalid(
                "registry_document_invalid",
                format!("invalid JSON in {key}: {e}"),
            )
            .with_path(key.to_owned())
        })
    }

    fn get_json(&self, key: &str) -> Result<Value, CliError> {
        self.get_json_optional(key)?.ok_or_else(|| {
            CliError::new("not_found", format!("the registry has no {key}"))
                .with_path(self.object_url(key))
        })
    }

    /// Stream one blob into `target` (created), hashing as it goes.
    fn fetch_blob(
        &self,
        member_path: &str,
        member: &Member,
        target: &Path,
    ) -> Result<(), BlobFailure> {
        let key = blob_key(&member.sha256);
        // A bound on the whole transfer: two minutes plus 64 KiB/s.
        let timeout = Duration::from_secs(120 + member.bytes / 65_536);
        let reader = self.open(&key, timeout).map_err(BlobFailure::Fetch)?;
        // The cache directory appears only once the registry has answered,
        // so a refused pull leaves nothing behind.
        let parent = target.parent().expect("a blob path has a parent");
        std::fs::create_dir_all(parent).map_err(|e| BlobFailure::Local(io_error(parent, e)))?;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(target)
            .map_err(|e| BlobFailure::Local(io_error(target, e)))?;
        let mut hasher = Sha256::new();
        let mut limited = reader.take(member.bytes + 1);
        let mut buf = vec![0u8; 1 << 20];
        let mut total: u64 = 0;
        loop {
            let n = limited
                .read(&mut buf)
                .map_err(|e| BlobFailure::Fetch(FetchError::Unreachable(e.to_string())))?;
            if n == 0 {
                break;
            }
            total += n as u64;
            hasher.update(&buf[..n]);
            file.write_all(&buf[..n])
                .map_err(|e| BlobFailure::Local(io_error(target, e)))?;
        }
        let actual = format!("{:x}", hasher.finalize());
        if total != member.bytes || actual != member.sha256 {
            return Err(BlobFailure::Mismatch(
                invalid(
                    "blob_verification_failed",
                    format!("registry blob verification failed for {member_path} ({})", member.sha256),
                )
                .with_path(member_path.to_owned())
                .with_detail(json!({
                    "expected": { "sha256": member.sha256, "bytes": member.bytes },
                    // More bytes than declared stops reading at bytes + 1.
                    "actual": { "sha256": actual, "bytes": total, "oversize": total > member.bytes },
                })),
            ));
        }
        Ok(())
    }
}

/// The registry a command reads, and as whom, in this order:
/// 1. one named explicitly (`--registry`, `SIMFORGE_MAPS_REGISTRY`,
///    `SIMFORGE_MAPS_PUBLIC_URL`), with `SIMFORGE_MAPS_REGISTRY_TOKEN` as its bearer;
/// 2. the logged-in account's registry on the host (`--host`, `SIMFORGE_HOST`,
///    `simforge.ai`): the maps that account's organization can use;
/// 3. the public registry, when no login exists for the default host.
///
/// A host named explicitly (`--host`, `SIMFORGE_HOST`) without a login is an
/// error, never a silent switch to the public registry.
pub fn select(registry_flag: Option<&str>, host_flag: Option<&str>) -> Result<Registry, CliError> {
    if let Some(url) = paths::registry_override(registry_flag) {
        if host_flag.is_some() {
            return Err(CliError::new(
                "conflicting_arguments",
                format!("--host selects the account's registry; {} names another ({}). Pass one of them.", url.source, url.value),
            )
            .with_path("--host"));
        }
        let auth = std::env::var(TOKEN_ENV)
            .ok()
            .map(|t| t.trim().to_owned())
            .filter(|t| !t.is_empty())
            .map_or(RegistryAuth::None, RegistryAuth::Env);
        return Registry::new(&url.value, auth, url.source);
    }
    let host = auth::resolve_host(host_flag)?;
    match auth::credential(&host)? {
        Some(credential) => {
            let url = credential.metadata.simforge_maps_registry.clone();
            Registry::new(
                &url,
                RegistryAuth::Account(Arc::new(credential)),
                format!("account:{}", host.name),
            )
        }
        None if host.source != "default" => Err(auth::not_logged_in(&host)),
        None => Registry::new(paths::PUBLIC_REGISTRY_URL, RegistryAuth::None, "default"),
    }
}

/// Where [`select`] would look, without touching the network (`doctor --offline`).
pub fn planned(registry_flag: Option<&str>) -> Value {
    if let Some(url) = paths::registry_override(registry_flag) {
        return json!({ "registry": url.value, "source": url.source });
    }
    let logged_in = auth::resolve_host(None).ok().and_then(|host| {
        let store = auth::store::Store::open().ok()?;
        store.record(&host.name).ok().flatten().map(|r| (host, r))
    });
    match logged_in {
        Some((host, record)) => json!({
            "registry": record.metadata.simforge_maps_registry,
            "source": format!("account:{}", host.name),
        }),
        None => json!({ "registry": paths::PUBLIC_REGISTRY_URL, "source": "default" }),
    }
}

/// `maps list`: every map the registry lists, with its versions.
pub fn list(registry: &Registry) -> Result<Value, CliError> {
    let index = registry.index()?;
    let entries = index.as_object().ok_or_else(|| {
        invalid("registry_document_invalid", "index.json is not an object").with_path("index.json")
    })?;
    let mut maps = Vec::new();
    for (name, entry) in entries {
        if !is_map_name(name) {
            continue;
        }
        let records = registry
            .get_json_optional(&format!("maps/{name}/versions.json"))?
            .unwrap_or_else(|| json!([]));
        let versions: Vec<Value> = records
            .as_array()
            .into_iter()
            .flatten()
            .map(|r| {
                json!({
                    "version": r.get("version"),
                    "releaseDigest": r.get("releaseDigest"),
                    "closureDigest": r.get("closureDigest"),
                    "createdAt": r.get("createdAt"),
                })
            })
            .collect();
        maps.push(json!({
            "name": name,
            "latest": entry.get("latest"),
            "summary": entry.get("summary"),
            "versions": versions,
        }));
    }
    Ok(json!({ "maps": maps }))
}

enum BlobFailure {
    Fetch(FetchError),
    Mismatch(CliError),
    Local(CliError),
}

fn blob_key(digest: &str) -> String {
    format!("blobs/sha256/{}/{digest}", &digest[..2])
}

// ------------------------------------------------------------------ resolve

pub struct Resolved {
    pub name: String,
    pub version: String,
    pub record_closure_digest: String,
    pub release: Release,
    pub closure: Closure,
    pub web: Option<Closure>,
}

/// `resolveVersion` + `exactDerivedClosures`.
pub fn resolve(registry: &Registry, reference: &str) -> Result<Resolved, CliError> {
    let (name, explicit) = match reference.rfind('@') {
        Some(at) => (&reference[..at], Some(&reference[at + 1..])),
        None => (reference, None),
    };
    if !is_map_name(name) {
        return Err(
            CliError::new("bad_value", format!("invalid map name: {name:?}"))
                .with_path("NAME@VERSION"),
        );
    }
    let index = registry
        .get_json_optional("index.json")?
        .unwrap_or_else(|| json!({}));
    let Some(entry) = index.get(name) else {
        return Err(CliError::new("unknown_map", format!("unknown map: {name}"))
            .with_path(name.to_owned())
            .with_detail(json!({
                "registry": registry.url,
                "known": index.as_object().map(|m| m.keys().cloned().collect::<Vec<_>>()).unwrap_or_default(),
            })));
    };
    let version = match explicit {
        Some(v) => v.to_owned(),
        None => entry
            .get("latest")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
    };
    if !is_version(&version) {
        return Err(
            CliError::new("bad_value", format!("invalid map version: {version:?}"))
                .with_path("NAME@VERSION"),
        );
    }
    let records = registry
        .get_json_optional(&format!("maps/{name}/versions.json"))?
        .unwrap_or_else(|| json!([]));
    let record = records
        .as_array()
        .and_then(|rows| rows.iter().find(|r| r.get("version").and_then(Value::as_str) == Some(&version)))
        .ok_or_else(|| {
            CliError::new("unknown_version", format!("unknown map version: {name}@{version}"))
                .with_path(format!("{name}@{version}"))
                .with_detail(json!({
                    "known": records.as_array().map(|rows| rows.iter().filter_map(|r| r.get("version").cloned()).collect::<Vec<_>>()).unwrap_or_default(),
                }))
        })?;
    let record_release = record
        .get("releaseDigest")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !is_sha256(record_release) {
        return Err(invalid(
            "release_unsupported",
            format!("{name}@{version} has no supported immutable release; re-ingest it with the current pipeline"),
        ));
    }
    let record_closure = record
        .get("closureDigest")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();

    let release_key = format!("maps/{name}/{version}/release.json");
    let release_value = registry.get_json(&release_key)?;
    let release = parse_release(&release_value)?;
    if release_value.get("name").and_then(Value::as_str) != Some(name)
        || release_value.get("version").and_then(Value::as_str) != Some(&version)
        || release.digest != record_release
    {
        return Err(invalid(
            "release_digest_mismatch",
            "release digest or identity mismatch",
        )
        .with_detail(json!({
            "key": release_key, "expected": record_release, "actual": release.digest,
        })));
    }
    let closure = parse_closure(
        &registry.get_json(&release.canonical.key)?,
        &release.canonical.key,
    )?;
    if closure.kind != "canonical" {
        return Err(invalid(
            "closure_invalid",
            "release canonical reference is not canonical",
        ));
    }
    if closure.digest != record_closure || closure.digest != release.canonical.digest {
        return Err(invalid("closure_digest_mismatch", format!("closure digest mismatch for {name}@{version}")).with_detail(json!({
            "key": release.canonical.key, "record": record_closure, "release": release.canonical.digest, "actual": closure.digest,
        })));
    }
    let web = match &release.web {
        None => None,
        Some(web_ref) => {
            let web = parse_closure(&registry.get_json(&web_ref.key)?, &web_ref.key)?;
            if web.kind != "web" || web.digest != web_ref.digest {
                return Err(invalid(
                    "closure_digest_mismatch",
                    "release web closure digest mismatch",
                )
                .with_detail(json!({
                    "key": web_ref.key, "release": web_ref.digest, "actual": web.digest,
                })));
            }
            Some(web)
        }
    };
    Ok(Resolved {
        name: name.to_owned(),
        version,
        record_closure_digest: record_closure,
        release,
        closure,
        web,
    })
}

// ------------------------------------------------------------------ profiles

/// `isSourceImage`: verbatim source rasters (archive only).
fn is_source_image(path: &str) -> bool {
    let Some(file) = path.strip_prefix("images/") else {
        return false;
    };
    if file.contains('/') {
        return false;
    }
    let lower = file.to_ascii_lowercase();
    let Some((stem, ext)) = lower.rsplit_once('.') else {
        return false;
    };
    !stem.is_empty() && matches!(ext, "png" | "jpg" | "jpeg" | "webp" | "avif")
}

/// `isMasterContent`: the master document, its geometry and every image.
fn is_master_content(path: &str) -> bool {
    path == "master.gltf" || path == "geometry.bin" || path.starts_with("images/")
}

struct Profile {
    /// `semantic`, `native` or `web` (the receipt's `profile`).
    name: &'static str,
    /// The key in the output's `materialized`.
    output_key: &'static str,
    destination: PathBuf,
    members: BTreeMap<String, Member>,
}

// ------------------------------------------------------------------ blob cache

static UNIQUE: AtomicU64 = AtomicU64::new(0);

fn unique_suffix() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    format!(
        "{}-{nanos:x}-{}",
        std::process::id(),
        UNIQUE.fetch_add(1, Ordering::Relaxed)
    )
}

fn hash_file(path: &Path) -> std::io::Result<(String, u64)> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    let mut total = 0u64;
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        total += n as u64;
        hasher.update(&buf[..n]);
    }
    Ok((format!("{:x}", hasher.finalize()), total))
}

#[derive(Default)]
struct CacheStats {
    downloaded: AtomicU64,
    downloaded_bytes: AtomicU64,
    reused: AtomicU64,
    reused_bytes: AtomicU64,
    retries: AtomicU64,
}

fn cached_blob_path(blob_root: &Path, digest: &str) -> PathBuf {
    blob_root.join("sha256").join(&digest[..2]).join(digest)
}

/// `cachedBlob`: reuse a verified cache entry or download, verify and
/// rename one into place.
fn ensure_blob(
    registry: &Registry,
    blob_root: &Path,
    member_path: &str,
    member: &Member,
    stats: &CacheStats,
) -> Result<(), CliError> {
    let cached = cached_blob_path(blob_root, &member.sha256);
    match hash_file(&cached) {
        Ok((sha, bytes)) if sha == member.sha256 && bytes == member.bytes => {
            stats.reused.fetch_add(1, Ordering::Relaxed);
            stats
                .reused_bytes
                .fetch_add(member.bytes, Ordering::Relaxed);
            return Ok(());
        }
        Ok(_) => {} // a corrupt cache entry is replaced below
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(io_error(&cached, e)),
    }
    let mut attempt = 0;
    loop {
        attempt += 1;
        let temporary = PathBuf::from(format!("{}.{}", cached.display(), unique_suffix()));
        let result = registry.fetch_blob(member_path, member, &temporary);
        let outcome = match result {
            Ok(()) => std::fs::rename(&temporary, &cached).map_err(|e| io_error(&cached, e)),
            Err(BlobFailure::Mismatch(e)) | Err(BlobFailure::Local(e)) => Err(e),
            Err(BlobFailure::Fetch(e)) if net::is_transient(&e) && attempt < BLOB_ATTEMPTS => {
                let _ = std::fs::remove_file(&temporary);
                stats.retries.fetch_add(1, Ordering::Relaxed);
                std::thread::sleep(Duration::from_millis(500 * u64::from(attempt)));
                continue;
            }
            Err(BlobFailure::Fetch(e)) => {
                let url = registry.object_url(&blob_key(&member.sha256));
                let mut error = registry.refusal(e, &url);
                let mut detail = error.detail.take().unwrap_or_else(|| json!({}));
                detail["member"] = json!(member_path);
                detail["url"] = json!(url);
                Err(error.with_detail(detail))
            }
        };
        let _ = std::fs::remove_file(&temporary);
        if outcome.is_ok() {
            stats.downloaded.fetch_add(1, Ordering::Relaxed);
            stats
                .downloaded_bytes
                .fetch_add(member.bytes, Ordering::Relaxed);
        }
        return outcome;
    }
}

/// Every distinct blob, verified in the cache, `concurrency` at a time. The
/// first failure stops the rest.
fn fill_cache(
    registry: &Registry,
    blob_root: &Path,
    blobs: &[(String, Member)],
    concurrency: usize,
    stats: &CacheStats,
) -> Result<(), CliError> {
    let next = AtomicUsize::new(0);
    let failed = AtomicBool::new(false);
    let first_error: Mutex<Option<CliError>> = Mutex::new(None);
    std::thread::scope(|scope| {
        for _ in 0..concurrency.min(blobs.len()).max(1) {
            scope.spawn(|| {
                while !failed.load(Ordering::Relaxed) {
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    let Some((path, member)) = blobs.get(i) else {
                        break;
                    };
                    if let Err(error) = ensure_blob(registry, blob_root, path, member, stats) {
                        failed.store(true, Ordering::Relaxed);
                        first_error.lock().unwrap().get_or_insert(error);
                        break;
                    }
                }
            });
        }
    });
    match first_error.into_inner().unwrap() {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

// ------------------------------------------------------------------ materialize

fn link_or_copy(source: &Path, target: &Path) -> Result<(), CliError> {
    if std::fs::hard_link(source, target).is_ok() {
        return Ok(());
    }
    std::fs::copy(source, target)
        .map(|_| ())
        .map_err(|e| io_error(target, e))
}

/// `materializeClosure`: stage every member (hardlinked from the cache),
/// write the receipt, then replace the destination by one rename.
fn materialize(
    profile: &Profile,
    blob_root: &Path,
    installation: &Map<String, Value>,
) -> Result<(), CliError> {
    let destination = &profile.destination;
    let staging = PathBuf::from(format!(
        "{}.pull-{}",
        destination.display(),
        unique_suffix()
    ));
    let result = (|| {
        std::fs::create_dir_all(&staging).map_err(|e| io_error(&staging, e))?;
        for (path, member) in &profile.members {
            let target = staging.join(path);
            let parent = target.parent().expect("member paths are relative files");
            std::fs::create_dir_all(parent).map_err(|e| io_error(parent, e))?;
            link_or_copy(&cached_blob_path(blob_root, &member.sha256), &target)?;
        }
        let mut receipt = installation.clone();
        receipt.insert("profile".into(), json!(profile.name));
        receipt.insert(
            "members".into(),
            Value::Object(
                profile
                    .members
                    .iter()
                    .map(|(p, m)| (p.clone(), m.raw.clone()))
                    .collect(),
            ),
        );
        let receipt_path = staging.join(RECEIPT);
        std::fs::write(
            &receipt_path,
            format!("{}\n", canonical_json(&Value::Object(receipt))),
        )
        .map_err(|e| io_error(&receipt_path, e))?;
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent).map_err(|e| io_error(parent, e))?;
        }
        match std::fs::remove_dir_all(destination) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(io_error(destination, e)),
        }
        std::fs::rename(&staging, destination).map_err(|e| io_error(destination, e))
    })();
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&staging);
    }
    result
}

// ------------------------------------------------------------------ pull

pub struct PullOptions {
    pub cache_root: PathBuf,
    /// Also materialize the verbatim source rasters under `dev-assets`.
    pub archive: bool,
    pub concurrency: usize,
}

/// `pullVersion`. Returns the JSON summary.
pub fn pull(
    registry: &Registry,
    reference: &str,
    options: &PullOptions,
) -> Result<Value, CliError> {
    let resolved = resolve(registry, reference)?;
    let Resolved {
        name,
        version,
        release,
        closure,
        web,
        record_closure_digest,
    } = resolved;
    if !closure.master {
        return Err(invalid(
            "release_unsupported",
            format!("{name}@{version} predates the map master format (tiled canonical closure); re-ingest it with the current pipeline"),
        ));
    }
    if closure.members.contains_key(RECEIPT) {
        return Err(invalid(
            "unsafe_member_path",
            "map closure uses reserved installation receipt path",
        )
        .with_path(RECEIPT));
    }

    let root = &options.cache_root;
    let blob_root = root.join(".blobs");
    let pick = |filter: &dyn Fn(&str) -> bool| -> BTreeMap<String, Member> {
        closure
            .members
            .iter()
            .filter(|(p, _)| filter(p))
            .map(|(p, m)| (p.clone(), m.clone()))
            .collect()
    };
    let archive = options.archive;
    let mut profiles = vec![
        Profile {
            name: "semantic",
            output_key: "canonical",
            destination: root.join("dev-assets").join(&name),
            members: pick(&|p| archive || !is_master_content(p)),
        },
        Profile {
            name: "native",
            output_key: "native",
            destination: root.join(".corpus").join(&name),
            members: pick(&|p| !is_source_image(p)),
        },
    ];
    if profiles[1].members.is_empty() {
        return Err(invalid(
            "release_unsupported",
            format!("{name} master closure carries no .gltf document"),
        ));
    }
    if let Some(web) = &web {
        if web.members.contains_key(RECEIPT) {
            return Err(invalid(
                "unsafe_member_path",
                "map closure uses reserved installation receipt path",
            )
            .with_path(RECEIPT));
        }
        // A browser installation is self-contained: web geometry and textures
        // plus the canonical semantics the compiler reads.
        let mut members = pick(&|p| !is_master_content(p));
        for (path, member) in &members {
            if let Some(w) = web.members.get(path) {
                if w.sha256 != member.sha256 || w.bytes != member.bytes {
                    return Err(invalid(
                        "closure_invalid",
                        format!("web/semantic profile conflict: {path}"),
                    )
                    .with_path(path.clone()));
                }
            }
        }
        members.extend(web.members.iter().map(|(p, m)| (p.clone(), m.clone())));
        profiles.push(Profile {
            name: "web",
            output_key: "web",
            destination: root.join("map-bundles").join(&name),
            members,
        });
    }

    // Every distinct blob any profile needs, verified before anything is installed.
    let mut seen = BTreeSet::new();
    let mut blobs: Vec<(String, Member)> = Vec::new();
    for profile in &profiles {
        for (path, member) in &profile.members {
            if seen.insert(member.sha256.clone()) {
                blobs.push((path.clone(), member.clone()));
            }
        }
    }
    let stats = CacheStats::default();
    fill_cache(registry, &blob_root, &blobs, options.concurrency, &stats)?;

    let mut installation = Map::new();
    installation.insert("schema".into(), json!("simforge.map-installation.v1"));
    installation.insert("name".into(), json!(name));
    installation.insert("version".into(), json!(version));
    installation.insert("releaseDigest".into(), json!(release.digest));
    installation.insert("canonicalDigest".into(), json!(record_closure_digest));
    if let Some(web_ref) = &release.web {
        installation.insert("webDigest".into(), json!(web_ref.digest));
    }
    let mut materialized = Map::new();
    let mut profile_summary = Map::new();
    for profile in &profiles {
        materialize(profile, &blob_root, &installation)?;
        materialized.insert(profile.output_key.into(), json!(profile.destination));
        profile_summary.insert(
            profile.name.into(),
            json!({
                "path": profile.destination,
                "members": profile.members.len(),
                "bytes": profile.members.values().map(|m| m.bytes).sum::<u64>(),
            }),
        );
    }
    let native_inputs = closure
        .members
        .keys()
        .filter(|p| !is_source_image(p))
        .count();
    Ok(json!({
        "name": name,
        "version": version,
        "closureDigest": record_closure_digest,
        "releaseDigest": release.digest,
        "webDigest": release.web.as_ref().map(|w| w.digest.clone()),
        "cacheRoot": root,
        "materialized": materialized,
        "profiles": profile_summary,
        "closure": {
            "members": closure.members.len(),
            "bytes": closure.members.values().map(|m| m.bytes).sum::<u64>(),
        },
        "blobs": {
            "distinct": blobs.len(),
            "downloaded": stats.downloaded.load(Ordering::Relaxed),
            "downloadedBytes": stats.downloaded_bytes.load(Ordering::Relaxed),
            "reused": stats.reused.load(Ordering::Relaxed),
            "reusedBytes": stats.reused_bytes.load(Ordering::Relaxed),
            "retries": stats.retries.load(Ordering::Relaxed),
            "cache": blob_root,
        },
        "nativeWorkerInputs": { "count": native_inputs },
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_paths_match_the_typescript_rule() {
        for ok in ["a", "images/x.ktx2", "3d/0/1.glb", "derived/a b.json"] {
            assert!(assert_safe_relative_path(ok).is_ok(), "{ok}");
        }
        for bad in [
            "", "/a", "a\\b", "a/../b", "./a", "a//b", "a/", "a%2e", "c:x", "a?b", "a#b", "a\u{1}",
        ] {
            let error = assert_safe_relative_path(bad).unwrap_err();
            assert_eq!(error.exit, crate::contract::Exit::Findings, "{bad:?}");
        }
    }

    #[test]
    fn names_versions_and_timestamps() {
        assert!(is_map_name("richmond-field-station") && is_map_name("a1"));
        assert!(
            !is_map_name("Richmond")
                && !is_map_name("a--b")
                && !is_map_name("-a")
                && !is_map_name("")
        );
        assert!(is_version("v1") && is_version("v10"));
        assert!(!is_version("v0") && !is_version("v01") && !is_version("1") && !is_version("v"));
        assert!(
            is_timestamp("2026-09-19T05:36:57.832Z")
                && is_timestamp("2026-09-19")
                && is_timestamp("2026-09-19T05:36:57+02:00")
        );
        assert!(
            !is_timestamp("yesterday")
                && !is_timestamp("2026-09-19T05")
                && !is_timestamp("2026-09-19T05:36:57.Z")
        );
    }

    #[test]
    fn profile_filters() {
        assert!(is_source_image("images/a.PNG") && is_source_image("images/b.jpeg"));
        assert!(
            !is_source_image("images/a.ktx2")
                && !is_source_image("images/x/a.png")
                && !is_source_image("a.png")
        );
        assert!(
            is_master_content("master.gltf")
                && is_master_content("images/a.ktx2")
                && !is_master_content("map.xodr")
        );
    }

    #[test]
    fn canonical_json_matches_the_shared_vectors() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../fixtures/canonical-json/vectors.json");
        let vectors: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        let mut checked = 0;
        for v in vectors["vectors"].as_array().unwrap() {
            let Some(input) = v["input"].as_str() else {
                continue;
            };
            let Ok(parsed) = serde_json::from_str::<Value>(input) else {
                continue;
            };
            if let (Ok(out), Some(expected)) = (
                simforge_core::hash::canonical_json(&parsed),
                v["canonical"].as_str(),
            ) {
                assert_eq!(out, expected, "{}", v["id"]);
                checked += 1;
            }
        }
        assert!(checked >= 5, "only {checked} vectors checked");
    }
}
