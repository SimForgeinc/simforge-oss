//! `simforge assets`: the actor-asset closure (`simforge.actor-assets-closure/v1`).
//!
//! `assets pull` installs one closure into a local actor-asset root, in the
//! layout the native render path reads (`packages/render/src/native/local-runtime.ts`
//! `resolveActorAssets`, `SIMFORGE_ACTOR_ASSETS_ROOT`):
//!
//! ```text
//! <root>/closures/<digest>.json               the closure document; sha256 = digest
//! <root>/closures/<digest>.ATTRIBUTION.json   who made each asset and under which licence
//! <root>/blobs/sha256/<aa>/<sha256>           every member's bytes, content-addressed
//! ```
//!
//! The origin layout is the public CDN's (`actor-assets.ts`): `<origin>/actor-assets/closures/<digest>.json`
//! and `<origin>/actor-assets/blobs/sha256/<aa>/<sha256>`; a `file://` origin is a
//! closure root holding `closures/` and `blobs/` directly.
//!
//! Everything is verified before anything is installed: the document hashes to
//! its digest, every blob to its sha256 and size, and the attribution covers
//! every member. New blobs are staged under the root and renamed into place
//! only after the whole closure verified; the closure document is written
//! last, so its presence means the closure is complete.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use clap::{Args, Subcommand, ValueEnum};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::contract::{CliError, CmdResult, Ctx, Outcome};
use crate::net::{self, FetchError};
use crate::paths::{self, Resolved};

/// The actor closure every native render binds: `PINNED_ACTOR_ASSETS_DIGEST`
/// in `oss/packages/render/src/native/actor-assets.ts` (the `actors` pin of
/// `oss/catalog/closures.lock.json`, track X #745: the attributed public
/// closure with its own ATTRIBUTION.json member). Bump both together.
pub const PINNED_ACTOR_ASSETS_DIGEST: &str =
    "793ec86ceda7734f1f5f7c0b260a396c11c970a471ab4418987e4d531f33daa4";
/// The public asset origin (`DEFAULT_ACTOR_ASSETS_BASE_URL` in actor-assets.ts).
pub const PUBLIC_ASSETS_BASE_URL: &str = "https://da3tufozhdsvl.cloudfront.net";
pub const CLOSURE_SCHEMA: &str = "simforge.actor-assets-closure/v1";
pub const ATTRIBUTION_SCHEMA: &str = "simforge.actor-assets-attribution/v1";
/// A closure member that carries the attribution itself (the per-pack closures).
const ATTRIBUTION_MEMBER: &str = "ATTRIBUTION.json";
/// The render closure's catalog: each entry's `model.attribution` covers its models.
const CATALOG_MEMBER: &str = "catalog-models.json";
const WORKERS: usize = 8;

#[derive(Debug, Subcommand)]
pub enum AssetsCommand {
    /// Pull the actor-asset closure and its ATTRIBUTION.json, verifying every blob's sha256.
    Pull(PullArgs),
}

#[derive(Debug, Args)]
pub struct PullArgs {
    /// Pull only this closure. Default: both the actor closure and the sky plates.
    #[arg(long, value_enum)]
    pub only: Option<Only>,
    /// The actor closure digest (sha256). Default: the closure this build is pinned to.
    #[arg(long, value_name = "SHA256")]
    pub closure: Option<String>,
    /// Asset store base URL (https:// or file://). Default: SIMFORGE_ACTOR_ASSETS_BASE_URL, then the public store.
    #[arg(long, value_name = "URL")]
    pub base_url: Option<String>,
    /// Local asset root. Default: SIMFORGE_ACTOR_ASSETS_ROOT, then $XDG_DATA_HOME/simforge/actor-assets.
    #[arg(long, value_name = "DIR")]
    pub root: Option<PathBuf>,
    /// Seconds to wait for a connection or for a response to start.
    #[arg(long, value_name = "SECONDS", default_value_t = 60)]
    pub timeout: u64,
}

/// Which closure `assets pull` fetches.
#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum Only {
    /// The actor closure (vehicle, walker and prop models) with its attribution.
    Actors,
    /// The renderer's sky plates (`simforge_assets::PINNED_SKY_CLOSURE`).
    Sky,
}

pub fn run(command: AssetsCommand, _ctx: &Ctx) -> CmdResult {
    match command {
        AssetsCommand::Pull(args) => pull(args),
    }
}

// ------------------------------------------------------------------ origin

/// `--base-url`, `SIMFORGE_ACTOR_ASSETS_BASE_URL`, then the public store.
pub fn base_url(flag: Option<&str>) -> Resolved<String> {
    let (raw, source) = match flag {
        Some(url) => (url.to_owned(), "flag:--base-url".to_owned()),
        None => match std::env::var("SIMFORGE_ACTOR_ASSETS_BASE_URL")
            .ok()
            .map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty())
        {
            Some(url) => (url, "env:SIMFORGE_ACTOR_ASSETS_BASE_URL".to_owned()),
            None => (PUBLIC_ASSETS_BASE_URL.to_owned(), "default".to_owned()),
        },
    };
    Resolved {
        value: raw.trim_end_matches('/').to_owned(),
        source,
    }
}

/// The object prefix under a base: `<origin>/actor-assets` for http(s) (a
/// base already ending in `/actor-assets` is accepted, as in actor-assets.ts);
/// a `file://` base is the closure root itself.
fn prefix(base: &str) -> String {
    if base.starts_with("file://") {
        base.to_owned()
    } else {
        format!("{}/actor-assets", base.trim_end_matches("/actor-assets"))
    }
}

fn closure_url(base: &str, digest: &str) -> String {
    format!("{}/closures/{digest}.json", prefix(base))
}

fn blob_url(base: &str, sha256: &str) -> String {
    format!("{}/blobs/sha256/{}/{sha256}", prefix(base), &sha256[..2])
}

fn blob_path(root: &Path, sha256: &str) -> PathBuf {
    root.join("blobs")
        .join("sha256")
        .join(&sha256[..2])
        .join(sha256)
}

// ------------------------------------------------------------------ closure document

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Member<'a> {
    sha256: &'a str,
    bytes: u64,
}

fn is_sha256(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn safe_member_path(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.contains('\\')
        && !path.contains(':')
        && path
            .split('/')
            .all(|p| !p.is_empty() && p != "." && p != "..")
}

fn invalid(digest: &str, reason: impl Into<String>) -> CliError {
    CliError::findings("closure_invalid", reason).with_detail(json!({ "closure": digest }))
}

fn parse_members<'a>(
    digest: &str,
    doc: &'a Value,
) -> Result<BTreeMap<&'a str, Member<'a>>, CliError> {
    if doc.get("schema").and_then(Value::as_str) != Some(CLOSURE_SCHEMA) {
        return Err(invalid(
            digest,
            format!("closure {digest} is not a {CLOSURE_SCHEMA} document"),
        ));
    }
    let members = doc
        .get("members")
        .and_then(Value::as_object)
        .ok_or_else(|| invalid(digest, format!("closure {digest} has no members object")))?;
    let mut out = BTreeMap::new();
    for (path, member) in members {
        if !safe_member_path(path) {
            return Err(invalid(
                digest,
                format!("closure {digest} has an unsafe member path {path:?}"),
            ));
        }
        let sha256 = member
            .get("sha256")
            .and_then(Value::as_str)
            .filter(|s| is_sha256(s));
        let bytes = member.get("bytes").and_then(Value::as_u64);
        match (sha256, bytes) {
            (Some(sha256), Some(bytes)) => {
                out.insert(path.as_str(), Member { sha256, bytes });
            }
            _ => {
                return Err(invalid(
                    digest,
                    format!("closure {digest} member {path} lacks a sha256/bytes identity"),
                ))
            }
        }
    }
    Ok(out)
}

// ------------------------------------------------------------------ blobs

/// Stream `reader` into `file`, hashing; refuse more than `expected` bytes.
fn copy_hashed(
    mut reader: impl Read,
    mut out: impl Write,
    expected: u64,
) -> std::io::Result<(String, u64)> {
    let mut hasher = Sha256::new();
    let mut total = 0u64;
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        total += n as u64;
        hasher.update(&buf[..n]);
        out.write_all(&buf[..n])?;
        if total > expected {
            break; // oversize: the caller reports the mismatch
        }
    }
    out.flush()?;
    Ok((hex(&hasher.finalize()), total))
}

fn hash_file(path: &Path) -> std::io::Result<(String, u64)> {
    copy_hashed(fs::File::open(path)?, std::io::sink(), u64::MAX)
}

#[derive(Debug)]
enum BlobState {
    /// Already installed and verified.
    Reused,
    /// Downloaded and verified into the staging directory.
    Staged(PathBuf),
}

#[derive(Debug)]
enum BlobFailure {
    Fetch {
        url: String,
        error: String,
        status: Option<u16>,
    },
    Mismatch {
        url: String,
        actual_sha256: String,
        actual_bytes: u64,
    },
    Io(String),
}

fn fetch_blob(
    agent: &ureq::Agent,
    base: &str,
    root: &Path,
    staging: &Path,
    member: Member<'_>,
    repaired: &AtomicUsize,
) -> Result<BlobState, BlobFailure> {
    let installed = blob_path(root, member.sha256);
    if installed.is_file() {
        match hash_file(&installed) {
            Ok((sha, bytes)) if sha == member.sha256 && bytes == member.bytes => {
                return Ok(BlobState::Reused)
            }
            // A corrupt installed blob is replaced (reported as repaired), never trusted.
            _ => {
                repaired.fetch_add(1, Ordering::Relaxed);
            }
        }
    }
    let url = blob_url(base, member.sha256);
    let reader = net::open_stream(agent, &url).map_err(|e| BlobFailure::Fetch {
        url: url.clone(),
        status: match e {
            FetchError::Status(code) => Some(code),
            _ => None,
        },
        error: e.to_string(),
    })?;
    let staged = staging.join(member.sha256);
    let file = fs::File::create(&staged)
        .map_err(|e| BlobFailure::Io(format!("{}: {e}", staged.display())))?;
    let (sha, bytes) =
        copy_hashed(reader, std::io::BufWriter::new(file), member.bytes).map_err(|e| {
            BlobFailure::Fetch {
                url: url.clone(),
                error: e.to_string(),
                status: None,
            }
        })?;
    if sha != member.sha256 || bytes != member.bytes {
        return Err(BlobFailure::Mismatch {
            url,
            actual_sha256: sha,
            actual_bytes: bytes,
        });
    }
    Ok(BlobState::Staged(staged))
}

// ------------------------------------------------------------------ attribution

fn declared_license(text: &str) -> Option<&'static str> {
    let t = text.to_ascii_uppercase();
    if t.contains("CC BY 4.0") || t.contains("CC-BY-4.0") {
        Some("CC-BY-4.0")
    } else {
        None
    }
}

/// The attribution document for a closure, and a licence summary for stdout.
/// A closure that carries `ATTRIBUTION.json` is attributed by that member; the
/// render closure is attributed by `catalog-models.json`, whose entries each
/// carry `model.attribution`, and every member must be covered by one entry.
fn attribution(
    digest: &str,
    members: &BTreeMap<&str, Member<'_>>,
    read: &dyn Fn(&str) -> Result<Vec<u8>, CliError>,
) -> Result<(Vec<u8>, Value), CliError> {
    let fail = |code: &str, reason: String, detail: Value| {
        Err(CliError::findings(code.to_owned(), reason).with_detail(detail))
    };
    if members.contains_key(ATTRIBUTION_MEMBER) {
        let bytes = read(ATTRIBUTION_MEMBER)?;
        let doc: Value = match serde_json::from_slice(&bytes) {
            Ok(Value::Object(map)) => Value::Object(map),
            _ => {
                return fail(
                    "attribution_invalid",
                    format!("closure {digest} member {ATTRIBUTION_MEMBER} is not a JSON object"),
                    json!({ "closure": digest }),
                )
            }
        };
        let mut licenses: BTreeMap<String, u64> = BTreeMap::new();
        let assets = doc.get("assets").and_then(Value::as_object);
        for asset in assets.into_iter().flat_map(|a| a.values()) {
            let license = asset
                .get("license")
                .and_then(Value::as_str)
                .unwrap_or("unstated");
            *licenses.entry(license.to_owned()).or_default() += 1;
        }
        let summary = json!({
            "source": format!("member:{ATTRIBUTION_MEMBER}"),
            "license": doc.get("license"),
            "assets": assets.map_or(0, |a| a.len()),
            "licenses": licenses,
        });
        return Ok((bytes, summary));
    }
    if !members.contains_key(CATALOG_MEMBER) {
        return fail(
            "attribution_missing",
            format!("closure {digest} carries neither {ATTRIBUTION_MEMBER} nor {CATALOG_MEMBER}; its assets cannot be attributed"),
            json!({ "closure": digest }),
        );
    }
    let catalog: Value = serde_json::from_slice(&read(CATALOG_MEMBER)?).map_err(|e| {
        CliError::findings("attribution_invalid", format!("{CATALOG_MEMBER}: {e}"))
            .with_detail(json!({ "closure": digest }))
    })?;
    let table = ["models", "entries", "vehicles"]
        .iter()
        .find_map(|k| catalog.get(*k).filter(|v| v.is_object()))
        .unwrap_or(&catalog);
    let Some(table) = table.as_object() else {
        return fail(
            "attribution_invalid",
            format!("{CATALOG_MEMBER} is not an object"),
            json!({ "closure": digest }),
        );
    };
    let mut entries = BTreeMap::new();
    let mut unattributed = Vec::new();
    let mut covered: BTreeSet<String> = BTreeSet::new();
    let mut licenses: BTreeMap<&str, u64> = BTreeMap::new();
    let mut by_source: BTreeMap<String, u64> = BTreeMap::new();
    for (id, entry) in table.iter().filter(|(id, _)| id.contains('.')) {
        let model = entry.get("model").unwrap_or(entry);
        let text = model
            .get("attribution")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty());
        let Some(text) = text else {
            unattributed.push(id.clone());
            continue;
        };
        let source = model.get("source").and_then(Value::as_str);
        let license = declared_license(text);
        *licenses.entry(license.unwrap_or("unstated")).or_default() += 1;
        *by_source
            .entry(source.unwrap_or("unstated").to_owned())
            .or_default() += 1;
        // An entry covers the models it binds and everything under models/<id>/.
        let mut bound: BTreeSet<String> = BTreeSet::new();
        if let Some(p) = model.get("glbPath").and_then(Value::as_str) {
            bound.insert(p.to_owned());
        }
        for anim in entry
            .get("animations")
            .and_then(Value::as_object)
            .into_iter()
            .flat_map(|a| a.values())
        {
            if let Some(p) = anim.get("glbPath").and_then(Value::as_str) {
                bound.insert(p.to_owned());
            }
        }
        let dir = format!("models/{id}/");
        bound.extend(
            members
                .keys()
                .filter(|m| m.starts_with(&dir))
                .map(|m| (*m).to_owned()),
        );
        covered.extend(bound.iter().cloned());
        entries.insert(
            id.clone(),
            json!({ "attribution": text, "source": source, "license": license, "members": bound }),
        );
    }
    let uncovered: Vec<&str> = members
        .keys()
        .copied()
        .filter(|m| *m != CATALOG_MEMBER && !covered.contains(*m))
        .collect();
    if !unattributed.is_empty() || !uncovered.is_empty() {
        return fail(
            "attribution_incomplete",
            format!(
                "closure {digest}: {} catalog entr(ies) carry no attribution and {} member(s) are covered by no attributed entry",
                unattributed.len(),
                uncovered.len()
            ),
            json!({ "closure": digest, "unattributedEntries": unattributed, "uncoveredMembers": uncovered }),
        );
    }
    let catalog_member = members[CATALOG_MEMBER];
    let doc = json!({
        "schema": ATTRIBUTION_SCHEMA,
        "closure": digest,
        "derivedFrom": { "member": CATALOG_MEMBER, "sha256": catalog_member.sha256 },
        "entries": entries,
    });
    let mut bytes = serde_json::to_vec_pretty(&doc).expect("json");
    bytes.push(b'\n');
    let summary = json!({
        "source": format!("derived:{CATALOG_MEMBER}"),
        "entries": entries.len(),
        "licenses": licenses,
        "bySource": by_source,
    });
    Ok((bytes, summary))
}

// ------------------------------------------------------------------ pull

fn io_error(what: &str, path: &Path, e: std::io::Error) -> CliError {
    CliError::new("io_error", format!("{what} {}: {e}", path.display()))
        .with_path(path.display().to_string())
}

/// Write `bytes` to `dest` through a temporary file and a rename.
fn write_atomic(dest: &Path, bytes: &[u8]) -> Result<(), CliError> {
    let dir = dest.parent().expect("dest has a parent");
    fs::create_dir_all(dir).map_err(|e| io_error("create", dir, e))?;
    let tmp = dir.join(format!(
        ".{}.tmp-{}",
        dest.file_name().unwrap().to_string_lossy(),
        std::process::id()
    ));
    fs::write(&tmp, bytes).map_err(|e| io_error("write", &tmp, e))?;
    fs::rename(&tmp, dest).map_err(|e| io_error("rename into", dest, e))
}

/// Removes the staging directory however the pull ends.
struct Staging(PathBuf);

impl Drop for Staging {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub fn pull(args: PullArgs) -> CmdResult {
    if args.timeout == 0 {
        return Err(
            CliError::new("bad_value", "--timeout must be at least 1 second")
                .with_path("--timeout"),
        );
    }
    if args.only == Some(Only::Sky) && args.closure.is_some() {
        return Err(CliError::new(
            "conflicting_arguments",
            "--closure names the actor closure; it does not apply with --only sky",
        )
        .with_path("--closure"));
    }
    let base = base_url(args.base_url.as_deref());
    let mut out = match args.only {
        Some(Only::Sky) => json!({
            "schema": "simforge.assets-pull/v1",
            "baseUrl": { "value": base.value, "source": base.source },
            "actors": { "status": "skipped", "reason": "--only sky" },
        }),
        _ => pull_actors(&args)?,
    };
    out["sky"] = match args.only {
        Some(Only::Actors) => json!({ "status": "skipped", "reason": "--only actors" }),
        _ => pull_sky(&base)?,
    };
    Ok(Outcome::ok(out))
}

/// The sky plates closure (`simforge_assets::PINNED_SKY_CLOSURE`), fetched by
/// digest into the asset cache the renderer resolves its plates from
/// (`render_core::sky_pass::SkyAssetPaths`), every member verified, and the
/// plates re-verified against their pinned SOURCES.json.
pub fn pull_sky(base: &Resolved<String>) -> Result<Value, CliError> {
    let pin = simforge_assets::Identity::from(simforge_assets::PINNED_SKY_CLOSURE);
    let store = simforge_assets::Store::new(&base.value, simforge_assets::cache_root_from_env());
    let mut fetched = 0usize;
    let mut fetched_bytes = 0u64;
    let materialized = store
        .materialize(&pin, &mut |progress| {
            let simforge_assets::Progress::Member {
                identity,
                fetched: now,
                ..
            } = progress;
            if now {
                fetched += 1;
                fetched_bytes += identity.bytes;
            }
        })
        .map_err(|e| sky_error(e, &pin.sha256))?;
    // What a render resolves now (an explicit SIMFORGE_SKY_ASSETS or runtime
    // root outranks the cache, and is reported as such); the plates it picks
    // are verified against their pinned SOURCES.json either way.
    let render_uses = match render_core::sky_pass::SkyAssetPaths::resolve() {
        Ok(paths) => json!({ "dir": paths.dir }),
        Err(e) => {
            return Err(CliError::findings("sky_invalid", format!("{e:#}"))
                .with_path(materialized.directory.display().to_string()))
        }
    };
    Ok(json!({
        "status": "installed",
        "closure": { "digest": pin.sha256, "bytes": pin.bytes },
        "directory": materialized.directory,
        "cache": store.cache_dir(),
        "members": materialized.closure.members.len(),
        "bytes": materialized.closure.total_member_bytes(),
        "downloaded": { "count": fetched, "bytes": fetched_bytes },
        "renderUses": render_uses,
    }))
}

/// A sky closure failure in the contract: unreachable is "could not run"
/// (exit 1), bytes that do not verify are findings (exit 2).
pub fn sky_error(error: simforge_assets::Error, digest: &str) -> CliError {
    let (code, findings) = match &error {
        simforge_assets::Error::Unavailable { .. } => ("sky_unavailable", false),
        simforge_assets::Error::Mismatch { .. } => ("sky_mismatch", true),
        simforge_assets::Error::Invalid(_) => ("sky_invalid", true),
        simforge_assets::Error::Io { .. } => ("write_failed", false),
    };
    let e = if findings {
        CliError::findings(code, error.to_string())
    } else {
        CliError::new(code, error.to_string())
    };
    e.with_detail(json!({ "closure": digest }))
}

fn pull_actors(args: &PullArgs) -> Result<Value, CliError> {
    if args.timeout == 0 {
        return Err(
            CliError::new("bad_value", "--timeout must be at least 1 second")
                .with_path("--timeout"),
        );
    }
    let digest = args
        .closure
        .clone()
        .unwrap_or_else(|| PINNED_ACTOR_ASSETS_DIGEST.to_owned());
    if !is_sha256(&digest) {
        return Err(CliError::new(
            "bad_value",
            "--closure must be a lowercase sha256 (64 hex characters)",
        )
        .with_path("--closure"));
    }
    let base = base_url(args.base_url.as_deref());
    if !(base.value.starts_with("https://")
        || base.value.starts_with("http://")
        || base.value.starts_with("file://"))
    {
        return Err(CliError::new(
            "bad_value",
            "--base-url must be https://, http:// or file://",
        )
        .with_path("--base-url"));
    }
    let root = paths::assets_root(args.root.as_deref())?;
    let root_path = root.value.clone();
    let timeout = Duration::from_secs(args.timeout);

    // The closure document: installed and intact, or fetched.
    let url = closure_url(&base.value, &digest);
    let installed_doc = root_path.join("closures").join(format!("{digest}.json"));
    let installed_bytes = fs::read(&installed_doc)
        .ok()
        .filter(|b| hex(&Sha256::digest(b)) == digest);
    let doc_reused = installed_bytes.is_some();
    let doc_bytes = match installed_bytes {
        Some(bytes) => bytes,
        None => net::get_bytes(&url, timeout).map_err(|e| match e {
            FetchError::Status(404) | FetchError::Io(_) => CliError::new(
                "unknown_closure",
                format!("the asset store has no closure {digest} ({url})"),
            )
            .with_path(url.clone())
            .with_detail(json!({ "closure": digest, "url": url, "baseUrl": base.value })),
            other => other.into_cli(&url),
        })?,
    };
    let actual = hex(&Sha256::digest(&doc_bytes));
    if actual != digest {
        return Err(CliError::findings(
            "closure_digest_mismatch",
            format!("{url} does not hash to {digest}"),
        )
        .with_path(url.clone())
        .with_detail(json!({ "expected": digest, "actual": actual, "bytes": doc_bytes.len() })));
    }
    let doc: Value = serde_json::from_slice(&doc_bytes)
        .map_err(|e| invalid(&digest, format!("closure {digest} is not JSON: {e}")))?;
    let members = parse_members(&digest, &doc)?;

    // Distinct blobs, then fetch or verify each in parallel.
    let mut distinct: BTreeMap<&str, Member<'_>> = BTreeMap::new();
    for member in members.values() {
        if let Some(other) = distinct.get(member.sha256) {
            if other.bytes != member.bytes {
                return Err(invalid(
                    &digest,
                    format!(
                        "closure {digest} lists blob {} with two sizes",
                        member.sha256
                    ),
                ));
            }
        }
        distinct.insert(member.sha256, *member);
    }
    fs::create_dir_all(&root_path).map_err(|e| io_error("create", &root_path, e))?;
    let staging = Staging(root_path.join(format!(
            ".staging-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos())
        )));
    fs::create_dir_all(&staging.0).map_err(|e| io_error("create", &staging.0, e))?;

    let agent = net::stream_agent(timeout);
    let queue: Mutex<Vec<Member<'_>>> = Mutex::new(distinct.values().copied().collect());
    let results: Mutex<HashMap<String, Result<BlobState, BlobFailure>>> =
        Mutex::new(HashMap::new());
    let repaired = AtomicUsize::new(0);
    std::thread::scope(|scope| {
        for _ in 0..WORKERS.min(distinct.len().max(1)) {
            scope.spawn(|| loop {
                let Some(member) = queue.lock().unwrap().pop() else {
                    break;
                };
                let outcome = fetch_blob(
                    &agent,
                    &base.value,
                    &root_path,
                    &staging.0,
                    member,
                    &repaired,
                );
                results
                    .lock()
                    .unwrap()
                    .insert(member.sha256.to_owned(), outcome);
            });
        }
    });
    let results = results.into_inner().unwrap();

    let path_of = |sha: &str| {
        members
            .iter()
            .find(|(_, m)| m.sha256 == sha)
            .map(|(p, _)| *p)
            .unwrap_or("?")
    };
    let mut mismatches = Vec::new();
    let mut fetch_failures = Vec::new();
    for (sha, outcome) in &results {
        let member = distinct[sha.as_str()];
        match outcome {
            Ok(_) => {}
            Err(BlobFailure::Mismatch {
                url,
                actual_sha256,
                actual_bytes,
            }) => mismatches.push(json!({
                "member": path_of(sha), "url": url,
                "expected": { "sha256": sha, "bytes": member.bytes },
                "actual": { "sha256": actual_sha256, "bytes": actual_bytes },
            })),
            Err(BlobFailure::Fetch { url, error, status }) => fetch_failures.push(
                json!({ "member": path_of(sha), "url": url, "error": error, "status": status }),
            ),
            Err(BlobFailure::Io(error)) => {
                fetch_failures.push(json!({ "member": path_of(sha), "error": error }))
            }
        }
    }
    if !mismatches.is_empty() {
        return Err(CliError::findings(
            "blob_mismatch",
            format!("{} blob(s) of closure {digest} do not match their sha256/size; nothing was installed", mismatches.len()),
        )
        .with_detail(json!({ "closure": digest, "mismatches": mismatches })));
    }
    if !fetch_failures.is_empty() {
        return Err(CliError::new(
            "download_failed",
            format!(
                "{} blob(s) of closure {digest} could not be fetched; nothing was installed",
                fetch_failures.len()
            ),
        )
        .with_detail(json!({ "closure": digest, "failures": fetch_failures })));
    }

    // Attribution, read from the verified bytes (staged or installed).
    let local = |sha: &str| match &results[sha] {
        Ok(BlobState::Staged(p)) => p.clone(),
        _ => blob_path(&root_path, sha),
    };
    let read = |member: &str| -> Result<Vec<u8>, CliError> {
        let path = local(members[member].sha256);
        fs::read(&path).map_err(|e| io_error("read", &path, e))
    };
    let (attribution_bytes, attribution_summary) = attribution(&digest, &members, &read)?;

    // Commit: blobs, attribution, then the closure document last.
    let (mut downloaded, mut downloaded_bytes, mut reused, mut reused_bytes) =
        (0u64, 0u64, 0u64, 0u64);
    for (sha, outcome) in &results {
        let bytes = distinct[sha.as_str()].bytes;
        match outcome {
            Ok(BlobState::Staged(staged)) => {
                let dest = blob_path(&root_path, sha);
                let dir = dest.parent().unwrap();
                fs::create_dir_all(dir).map_err(|e| io_error("create", dir, e))?;
                fs::rename(staged, &dest).map_err(|e| io_error("install", &dest, e))?;
                downloaded += 1;
                downloaded_bytes += bytes;
            }
            _ => {
                reused += 1;
                reused_bytes += bytes;
            }
        }
    }
    let attribution_path = root_path
        .join("closures")
        .join(format!("{digest}.ATTRIBUTION.json"));
    write_atomic(&attribution_path, &attribution_bytes)?;
    if !doc_reused {
        write_atomic(&installed_doc, &doc_bytes)?;
    }
    drop(staging);

    let member_bytes: u64 = members.values().map(|m| m.bytes).sum();
    let mut attribution = attribution_summary;
    attribution["path"] = json!(attribution_path);
    Ok(json!({
        "schema": "simforge.assets-pull/v1",
        "closure": {
            "digest": digest,
            "schema": CLOSURE_SCHEMA,
            "bytes": doc_bytes.len(),
            "url": url,
            "path": installed_doc,
            "reused": doc_reused,
        },
        "baseUrl": { "value": base.value, "source": base.source },
        "root": { "path": root.value, "source": root.source },
        "members": { "count": members.len(), "bytes": member_bytes },
        "blobs": {
            "distinct": distinct.len(),
            "bytes": distinct.values().map(|m| m.bytes).sum::<u64>(),
            "downloaded": { "count": downloaded, "bytes": downloaded_bytes },
            "reused": { "count": reused, "bytes": reused_bytes },
            "repaired": repaired.load(Ordering::Relaxed),
        },
        "attribution": attribution,
        "use": { "SIMFORGE_ACTOR_ASSETS_ROOT": root.value },
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origin_layout_matches_actor_assets_ts() {
        let d = "ab".repeat(32);
        assert_eq!(
            closure_url("https://cdn.example", &d),
            format!("https://cdn.example/actor-assets/closures/{d}.json")
        );
        assert_eq!(
            closure_url("https://cdn.example/actor-assets", &d),
            format!("https://cdn.example/actor-assets/closures/{d}.json")
        );
        assert_eq!(
            blob_url("file:///x/root", &d),
            format!("file:///x/root/blobs/sha256/ab/{d}")
        );
    }

    #[test]
    fn member_paths_are_confined() {
        for bad in ["", "/abs", "a/../b", "a//b", "./a", "a\\b", "c:x"] {
            assert!(!safe_member_path(bad), "{bad}");
        }
        assert!(safe_member_path("models/vehicle.car/model.glb"));
    }

    #[test]
    fn licence_detection() {
        assert_eq!(
            declared_license("model © CARLA contributors, licensed CC BY 4.0; converted"),
            Some("CC-BY-4.0")
        );
        assert_eq!(declared_license("Generated with Meshy for SimForge"), None);
    }
}
