//! Content-addressed asset closures: the 3D models and other large assets that
//! live outside git.
//!
//! A closure is one immutable JSON document (`simforge.actor-assets-closure/v1`)
//! whose sha256 is its identity. It lists members by path, each with the sha256
//! and byte size of its content. The origin serves both by digest:
//!
//! ```text
//! <origin>/actor-assets/closures/<digest>.json
//! <origin>/actor-assets/blobs/sha256/<aa>/<sha256>
//! ```
//!
//! A `file://` origin is a local closure root holding `closures/` and `blobs/`
//! directly. The local cache keeps the same layout as the render workers
//! (`packages/render/src/native/actor-assets.ts`) and the repository tooling
//! (`scripts/actor-assets/closures.mjs`):
//!
//! ```text
//! <cache>/blobs/sha256/<aa>/<sha256>   renamed into place only after it hashes to its name
//! <cache>/closures/<digest>.json       closure documents, verified the same way
//! <cache>/trees/<digest>/...           a closure laid out by member path (hard links into blobs/)
//! ```
//!
//! Nothing here substitutes anything: a pinned asset that cannot be fetched or
//! does not verify is an [`Error`] naming the digest and the URL.
//!
//! `simforge assets pull` is [`Store::materialize`] over the pins of a
//! [`Lock`] (or [`PINNED_ACTOR_CLOSURE`]).

use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const CLOSURE_SCHEMA: &str = "simforge.actor-assets-closure/v1";
pub const LOCK_SCHEMA: &str = "simforge.asset-closures-lock/v1";
/// The public asset origin (CloudFront over the public asset bucket).
pub const DEFAULT_ORIGIN: &str = "https://da3tufozhdsvl.cloudfront.net";
/// Written last into a materialized tree; a tree without it is incomplete.
pub const TREE_COMPLETE_MARKER: &str = ".simforge-closure-complete";

/// The native actor closure every render binds: catalog-models.json keyed by
/// catalog id (each entry carries its CC-BY attribution) plus every model.
/// Mirrors `PINNED_ACTOR_ASSETS_DIGEST` in packages/render/src/native/actor-assets.ts
/// and `closures.actors` in catalog/closures.lock.json (checked by this crate's tests).
pub const PINNED_ACTOR_CLOSURE: Pin = Pin {
    sha256: "218209f5109d8a25d9967de1cca4b202555dc12f53289463aa40a6812d79854f",
    bytes: 22971,
};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// The origin does not serve the asset, or the network failed.
    #[error("{what} {sha256} is unavailable from {url}: {reason}")]
    Unavailable {
        what: &'static str,
        sha256: String,
        url: String,
        reason: String,
    },
    /// The origin served bytes that are not the pinned asset.
    #[error("{what} from {url} does not verify: expected {expected_sha256}/{expected_bytes}, got {actual_sha256}/{actual_bytes}")]
    Mismatch {
        what: &'static str,
        url: String,
        expected_sha256: String,
        expected_bytes: u64,
        actual_sha256: String,
        actual_bytes: u64,
    },
    #[error("invalid closure data: {0}")]
    Invalid(String),
    #[error("{context}: {source}")]
    Io {
        context: String,
        #[source]
        source: io::Error,
    },
}

pub type Result<T> = std::result::Result<T, Error>;

fn io_err(context: impl Into<String>) -> impl FnOnce(io::Error) -> Error {
    let context = context.into();
    move |source| Error::Io { context, source }
}

/// A compile-time pin (`sha256` + byte size of a closure document).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Pin {
    pub sha256: &'static str,
    pub bytes: u64,
}

/// The identity of a closure document or a member: sha256 and byte size.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Identity {
    pub sha256: String,
    pub bytes: u64,
}

impl Identity {
    pub fn new(sha256: impl Into<String>, bytes: u64) -> Result<Self> {
        let sha256 = sha256.into();
        if !is_sha256(&sha256) {
            return Err(Error::Invalid(format!(
                "{sha256:?} is not a lowercase hex sha256"
            )));
        }
        Ok(Self { sha256, bytes })
    }
}

impl From<Pin> for Identity {
    fn from(pin: Pin) -> Self {
        Self {
            sha256: pin.sha256.to_owned(),
            bytes: pin.bytes,
        }
    }
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(DIGITS[(b >> 4) as usize] as char);
        out.push(DIGITS[(b & 15) as usize] as char);
    }
    out
}

/// sha256 and size of a file.
pub fn hash_file(path: &Path) -> Result<Identity> {
    let mut file = fs::File::open(path).map_err(io_err(format!("open {}", path.display())))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    let mut total = 0u64;
    loop {
        let n = file
            .read(&mut buf)
            .map_err(io_err(format!("read {}", path.display())))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        total += n as u64;
    }
    Ok(Identity {
        sha256: hex(&hasher.finalize()),
        bytes: total,
    })
}

fn safe_member_path(member: &str) -> Result<Vec<&str>> {
    let parts: Vec<&str> = member.split('/').collect();
    if parts
        .iter()
        .any(|p| p.is_empty() || *p == "." || *p == ".." || p.contains('\\'))
    {
        return Err(Error::Invalid(format!(
            "unsafe closure member path: {member}"
        )));
    }
    Ok(parts)
}

/// A parsed, verified closure document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Closure {
    pub digest: String,
    pub bytes: u64,
    pub members: BTreeMap<String, Identity>,
    /// The optional `licenses` table (empty when the closure records none).
    pub licenses: BTreeMap<String, MemberLicense>,
}

/// The licence value for a member whose redistribution terms are not confirmed.
pub const UNCONFIRMED_LICENSE: &str = "UNCONFIRMED";

/// One member's licence in a closure's optional `licenses` table (v1 readers
/// that predate it ignore it; the digest binds it). `license` is an SPDX id
/// (or `LicenseRef-*`), or [`UNCONFIRMED_LICENSE`] while the terms are open.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemberLicense {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attribution: Option<String>,
    pub license: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

#[derive(Deserialize)]
struct ClosureDocument {
    schema: String,
    members: BTreeMap<String, Identity>,
    #[serde(default)]
    licenses: BTreeMap<String, MemberLicense>,
}

impl Closure {
    /// Parses closure document bytes against their declared identity.
    pub fn parse(bytes: &[u8], declared: &Identity) -> Result<Self> {
        let digest = sha256_hex(bytes);
        if digest != declared.sha256 || bytes.len() as u64 != declared.bytes {
            return Err(Error::Mismatch {
                what: "closure document",
                url: String::from("(bytes)"),
                expected_sha256: declared.sha256.clone(),
                expected_bytes: declared.bytes,
                actual_sha256: digest,
                actual_bytes: bytes.len() as u64,
            });
        }
        let document: ClosureDocument = serde_json::from_slice(bytes)
            .map_err(|e| Error::Invalid(format!("closure {digest}: {e}")))?;
        if document.schema != CLOSURE_SCHEMA {
            return Err(Error::Invalid(format!(
                "closure {digest} is {:?}, not {CLOSURE_SCHEMA}",
                document.schema
            )));
        }
        for (path, member) in &document.members {
            safe_member_path(path)?;
            if !is_sha256(&member.sha256) {
                return Err(Error::Invalid(format!(
                    "closure {digest} member {path} has no sha256 identity"
                )));
            }
        }
        for (path, license) in &document.licenses {
            if !document.members.contains_key(path) {
                return Err(Error::Invalid(format!(
                    "closure {digest}: licenses names {path}, which is not a member"
                )));
            }
            if license.license.is_empty() {
                return Err(Error::Invalid(format!(
                    "closure {digest}: {path} has no license"
                )));
            }
        }
        Ok(Self {
            digest,
            bytes: declared.bytes,
            members: document.members,
            licenses: document.licenses,
        })
    }

    /// Members a public distribution may not carry: no licence recorded, or
    /// [`UNCONFIRMED_LICENSE`].
    pub fn unlicensed(&self) -> Vec<&str> {
        self.members
            .keys()
            .filter(|path| {
                self.licenses
                    .get(*path)
                    .is_none_or(|l| l.license == UNCONFIRMED_LICENSE)
            })
            .map(String::as_str)
            .collect()
    }

    /// The canonical document bytes for `members` (sorted keys, no whitespace):
    /// what a seal writes and what the digest is computed over.
    pub fn canonical_document(members: &BTreeMap<String, Identity>) -> Result<Vec<u8>> {
        Self::canonical_document_with_licenses(members, &BTreeMap::new())
    }

    /// [`Closure::canonical_document`] with a `licenses` table (omitted when empty).
    pub fn canonical_document_with_licenses(
        members: &BTreeMap<String, Identity>,
        licenses: &BTreeMap<String, MemberLicense>,
    ) -> Result<Vec<u8>> {
        for path in members.keys() {
            safe_member_path(path)?;
        }
        for path in licenses.keys() {
            if !members.contains_key(path) {
                return Err(Error::Invalid(format!(
                    "licenses names {path}, which is not a member"
                )));
            }
        }
        // serde_json's Map is ordered by key here (no `preserve_order`), so this
        // is the sorted-key, whitespace-free form the Node sealer writes.
        let mut document = serde_json::Map::new();
        if !licenses.is_empty() {
            document.insert(
                "licenses".into(),
                serde_json::to_value(licenses).expect("licenses"),
            );
        }
        document.insert(
            "members".into(),
            serde_json::to_value(members).expect("members"),
        );
        document.insert("schema".into(), CLOSURE_SCHEMA.into());
        Ok(serde_json::to_vec(&serde_json::Value::Object(document)).expect("closure document"))
    }

    pub fn total_member_bytes(&self) -> u64 {
        self.members.values().map(|m| m.bytes).sum()
    }
}

/// `catalog/closures.lock.json`: the closures a checkout pins, by name.
#[derive(Debug, Clone, Deserialize)]
pub struct Lock {
    pub schema: String,
    pub origin: String,
    pub closures: BTreeMap<String, LockedClosure>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LockedClosure {
    pub sha256: String,
    pub bytes: u64,
    /// The document's path in git, relative to the lock (absent for closures
    /// whose document lives only in the store).
    #[serde(default)]
    pub document: Option<String>,
}

impl Lock {
    pub fn load(path: &Path) -> Result<Self> {
        let bytes = fs::read(path).map_err(io_err(format!("read {}", path.display())))?;
        let lock: Lock = serde_json::from_slice(&bytes)
            .map_err(|e| Error::Invalid(format!("{}: {e}", path.display())))?;
        if lock.schema != LOCK_SCHEMA {
            return Err(Error::Invalid(format!(
                "{} is {:?}, not {LOCK_SCHEMA}",
                path.display(),
                lock.schema
            )));
        }
        for (name, pin) in &lock.closures {
            if !is_sha256(&pin.sha256) {
                return Err(Error::Invalid(format!(
                    "{} closure {name} has no sha256",
                    path.display()
                )));
            }
        }
        Ok(lock)
    }

    pub fn get(&self, name: &str) -> Result<Identity> {
        let pin = self.closures.get(name).ok_or_else(|| {
            Error::Invalid(format!(
                "no closure named {name} in the lock; pinned: {}",
                self.closures.keys().cloned().collect::<Vec<_>>().join(", ")
            ))
        })?;
        Identity::new(pin.sha256.clone(), pin.bytes)
    }
}

/// The cache root: `SIMFORGE_ACTOR_ASSETS_CACHE_DIR`, else
/// `$SIMFORGE_CACHE_DIR/actor-assets`, else `$XDG_CACHE_HOME/simforge/actor-assets`,
/// else `~/.cache/simforge/actor-assets`.
pub fn cache_root_from_env() -> PathBuf {
    let var = |name: &str| std::env::var(name).ok().filter(|v| !v.trim().is_empty());
    if let Some(explicit) = var("SIMFORGE_ACTOR_ASSETS_CACHE_DIR") {
        return PathBuf::from(explicit);
    }
    if let Some(cache) = var("SIMFORGE_CACHE_DIR") {
        return Path::new(&cache).join("actor-assets");
    }
    let base = var("XDG_CACHE_HOME").map(PathBuf::from).unwrap_or_else(|| {
        let home = var("HOME")
            .or_else(|| var("USERPROFILE"))
            .unwrap_or_else(|| ".".into());
        Path::new(&home).join(".cache")
    });
    base.join("simforge").join("actor-assets")
}

/// The origin root; a trailing `/actor-assets` is folded away (operators have
/// configured both spellings).
pub fn normalize_origin(configured: &str) -> String {
    let base = configured.trim().trim_end_matches('/');
    let base = if base.is_empty() {
        DEFAULT_ORIGIN
    } else {
        base
    };
    if base.starts_with("file://") {
        base.to_owned()
    } else {
        base.strip_suffix("/actor-assets")
            .unwrap_or(base)
            .to_owned()
    }
}

/// Progress events from [`Store::materialize`].
#[derive(Debug, Clone)]
pub enum Progress<'a> {
    /// A member is present in the cache (downloaded now when `fetched`).
    Member {
        path: &'a str,
        identity: &'a Identity,
        fetched: bool,
    },
}

/// A materialized closure: every member verified, laid out under `directory`.
#[derive(Debug, Clone)]
pub struct Materialized {
    pub directory: PathBuf,
    pub closure: Closure,
}

/// An origin plus a local cache.
#[derive(Debug, Clone)]
pub struct Store {
    origin: String,
    cache: PathBuf,
    /// Re-hash cached files on every use instead of trusting size + inode.
    verify_full: bool,
    concurrency: usize,
}

impl Store {
    pub fn new(origin: &str, cache: impl Into<PathBuf>) -> Self {
        Self {
            origin: normalize_origin(origin),
            cache: cache.into(),
            verify_full: std::env::var("SIMFORGE_CACHE_VERIFY").as_deref() == Ok("full"),
            concurrency: 4,
        }
    }

    /// `SIMFORGE_ACTOR_ASSETS_BASE_URL` (else `fallback_origin`, else the
    /// public origin) and [`cache_root_from_env`].
    pub fn from_env(fallback_origin: Option<&str>) -> Self {
        let origin = std::env::var("SIMFORGE_ACTOR_ASSETS_BASE_URL")
            .ok()
            .filter(|v| !v.trim().is_empty())
            .or_else(|| fallback_origin.map(str::to_owned))
            .unwrap_or_else(|| DEFAULT_ORIGIN.to_owned());
        Self::new(&origin, cache_root_from_env())
    }

    pub fn with_concurrency(mut self, concurrency: usize) -> Self {
        self.concurrency = concurrency.max(1);
        self
    }

    pub fn with_full_verification(mut self, full: bool) -> Self {
        self.verify_full = full;
        self
    }

    pub fn origin(&self) -> &str {
        &self.origin
    }

    pub fn cache_dir(&self) -> &Path {
        &self.cache
    }

    fn prefix(&self) -> String {
        if self.origin.starts_with("file://") {
            self.origin.clone()
        } else {
            format!("{}/actor-assets", self.origin)
        }
    }

    pub fn blob_url(&self, sha256: &str) -> String {
        format!("{}/blobs/sha256/{}/{sha256}", self.prefix(), &sha256[..2])
    }

    pub fn closure_url(&self, digest: &str) -> String {
        format!("{}/closures/{digest}.json", self.prefix())
    }

    pub fn blob_path(&self, sha256: &str) -> PathBuf {
        self.cache
            .join("blobs")
            .join("sha256")
            .join(&sha256[..2])
            .join(sha256)
    }

    fn closure_path(&self, digest: &str) -> PathBuf {
        self.cache.join("closures").join(format!("{digest}.json"))
    }

    /// Where [`Store::materialize`] lays out closure `digest`.
    pub fn tree_path(&self, digest: &str) -> PathBuf {
        self.cache.join("trees").join(digest)
    }

    fn cached_valid(&self, path: &Path, expected: &Identity) -> Result<bool> {
        match fs::metadata(path) {
            Ok(meta) if meta.is_file() && meta.len() == expected.bytes => {}
            _ => return Ok(false),
        }
        if !self.verify_full {
            return Ok(true);
        }
        Ok(hash_file(path)?.sha256 == expected.sha256)
    }

    /// Fetches `url` into `destination` only if the bytes are `expected`.
    fn fetch_verified(
        &self,
        what: &'static str,
        url: &str,
        expected: &Identity,
        destination: &Path,
    ) -> Result<()> {
        let parent = destination.parent().expect("cache paths have a parent");
        fs::create_dir_all(parent).map_err(io_err(format!("create {}", parent.display())))?;
        let temporary = parent.join(format!(
            ".{}.{}.{:?}.tmp",
            expected.sha256,
            std::process::id(),
            std::thread::current().id()
        ));
        let result = self
            .download(what, url, expected, &temporary)
            .and_then(|actual| {
                if actual != *expected {
                    return Err(Error::Mismatch {
                        what,
                        url: url.to_owned(),
                        expected_sha256: expected.sha256.clone(),
                        expected_bytes: expected.bytes,
                        actual_sha256: actual.sha256,
                        actual_bytes: actual.bytes,
                    });
                }
                let mut perms = fs::metadata(&temporary)
                    .map_err(io_err(format!("stat {}", temporary.display())))?
                    .permissions();
                perms.set_readonly(true);
                fs::set_permissions(&temporary, perms)
                    .map_err(io_err(format!("chmod {}", temporary.display())))?;
                fs::rename(&temporary, destination)
                    .map_err(io_err(format!("rename into {}", destination.display())))
            });
        let _ = fs::remove_file(&temporary);
        result
    }

    /// Streams `url` to `temporary`, hashing as it goes.
    fn download(
        &self,
        what: &'static str,
        url: &str,
        expected: &Identity,
        temporary: &Path,
    ) -> Result<Identity> {
        let unavailable = |reason: String| Error::Unavailable {
            what,
            sha256: expected.sha256.clone(),
            url: url.to_owned(),
            reason,
        };
        let mut reader: Box<dyn Read> = if let Some(path) = url.strip_prefix("file://") {
            Box::new(fs::File::open(path).map_err(|e| unavailable(e.to_string()))?)
        } else {
            let response = ureq::get(url)
                .call()
                .map_err(|e| unavailable(e.to_string()))?;
            Box::new(response.into_body().into_reader())
        };
        let mut file = fs::File::create(temporary)
            .map_err(io_err(format!("create {}", temporary.display())))?;
        let mut hasher = Sha256::new();
        let mut buf = vec![0u8; 1 << 20];
        let mut total = 0u64;
        loop {
            let n = reader
                .read(&mut buf)
                .map_err(|e| unavailable(format!("read failed: {e}")))?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            file.write_all(&buf[..n])
                .map_err(io_err(format!("write {}", temporary.display())))?;
            total += n as u64;
            if total > expected.bytes {
                return Err(Error::Mismatch {
                    what,
                    url: url.to_owned(),
                    expected_sha256: expected.sha256.clone(),
                    expected_bytes: expected.bytes,
                    actual_sha256: String::from("(truncated: longer than pinned)"),
                    actual_bytes: total,
                });
            }
        }
        file.sync_all()
            .map_err(io_err(format!("sync {}", temporary.display())))?;
        Ok(Identity {
            sha256: hex(&hasher.finalize()),
            bytes: total,
        })
    }

    /// Proves the cached blob is `member`'s bytes, fetching it when absent or
    /// wrong. Returns its cache path and whether it was fetched now.
    pub fn pull_blob(&self, member: &Identity) -> Result<(PathBuf, bool)> {
        if !is_sha256(&member.sha256) {
            return Err(Error::Invalid(format!(
                "{:?} is not a sha256",
                member.sha256
            )));
        }
        let path = self.blob_path(&member.sha256);
        if self.cached_valid(&path, member)? {
            return Ok((path, false));
        }
        remove_readonly(&path);
        self.fetch_verified("blob", &self.blob_url(&member.sha256), member, &path)?;
        Ok((path, true))
    }

    /// Fetches (or proves the cached copy of) a closure document and parses it.
    pub fn pull_closure(&self, id: &Identity) -> Result<Closure> {
        let path = self.closure_path(&id.sha256);
        if !self.cached_valid(&path, id)? {
            remove_readonly(&path);
            self.fetch_verified("closure document", &self.closure_url(&id.sha256), id, &path)?;
        }
        let bytes = fs::read(&path).map_err(io_err(format!("read {}", path.display())))?;
        Closure::parse(&bytes, id)
    }

    /// The materialized tree of `id` if it is already complete in the cache
    /// (no network).
    pub fn materialized(&self, id: &Identity) -> Result<Option<Materialized>> {
        let path = self.closure_path(&id.sha256);
        if !self.cached_valid(&path, id)? {
            return Ok(None);
        }
        let bytes = fs::read(&path).map_err(io_err(format!("read {}", path.display())))?;
        let closure = Closure::parse(&bytes, id)?;
        let directory = self.tree_path(&closure.digest);
        if self.tree_complete(&directory, &closure)? {
            Ok(Some(Materialized { directory, closure }))
        } else {
            Ok(None)
        }
    }

    fn tree_complete(&self, directory: &Path, closure: &Closure) -> Result<bool> {
        if !directory.join(TREE_COMPLETE_MARKER).is_file() {
            return Ok(false);
        }
        for (member_path, member) in &closure.members {
            let file =
                directory.join(safe_member_path(member_path)?.join(std::path::MAIN_SEPARATOR_STR));
            let Ok(tree) = fs::metadata(&file) else {
                return Ok(false);
            };
            if !tree.is_file() || tree.len() != member.bytes {
                return Ok(false);
            }
            if !self.verify_full && same_file(&tree, &self.blob_path(&member.sha256)) {
                continue;
            }
            if hash_file(&file)?.sha256 != member.sha256 {
                return Ok(false);
            }
        }
        Ok(true)
    }

    /// Fetches closure `id` and every member into the cache (verified by
    /// sha256), then lays the members out under `<cache>/trees/<digest>/`
    /// (hard links) and returns that directory. A complete tree is reused.
    pub fn materialize(
        &self,
        id: &Identity,
        progress: &mut (dyn FnMut(Progress<'_>) + Send),
    ) -> Result<Materialized> {
        let closure = self.pull_closure(id)?;
        let directory = self.tree_path(&closure.digest);
        if self.tree_complete(&directory, &closure)? {
            return Ok(Materialized { directory, closure });
        }
        let entries: Vec<(&String, &Identity)> = closure.members.iter().collect();
        let cursor = AtomicUsize::new(0);
        let first_error: Mutex<Option<Error>> = Mutex::new(None);
        let progress = Mutex::new(progress);
        std::thread::scope(|scope| {
            for _ in 0..self.concurrency.min(entries.len().max(1)) {
                scope.spawn(|| loop {
                    if first_error.lock().expect("lock").is_some() {
                        return;
                    }
                    let index = cursor.fetch_add(1, Ordering::Relaxed);
                    let Some((path, member)) = entries.get(index) else {
                        return;
                    };
                    match self.pull_blob(member) {
                        Ok((_, fetched)) => (progress.lock().expect("lock"))(Progress::Member {
                            path,
                            identity: member,
                            fetched,
                        }),
                        Err(error) => {
                            first_error.lock().expect("lock").get_or_insert(error);
                            return;
                        }
                    }
                });
            }
        });
        if let Some(error) = first_error.into_inner().expect("lock") {
            return Err(error);
        }

        let trees = directory.parent().expect("tree has a parent");
        fs::create_dir_all(trees).map_err(io_err(format!("create {}", trees.display())))?;
        let temporary = trees.join(format!(".{}.{}.tmp", closure.digest, std::process::id()));
        let _ = fs::remove_dir_all(&temporary);
        for (member_path, member) in &closure.members {
            let target =
                temporary.join(safe_member_path(member_path)?.join(std::path::MAIN_SEPARATOR_STR));
            let parent = target.parent().expect("member has a parent");
            fs::create_dir_all(parent).map_err(io_err(format!("create {}", parent.display())))?;
            let source = self.blob_path(&member.sha256);
            if fs::hard_link(&source, &target).is_err() {
                fs::copy(&source, &target).map_err(io_err(format!(
                    "copy {} to {}",
                    source.display(),
                    target.display()
                )))?;
            }
        }
        fs::write(
            temporary.join(TREE_COMPLETE_MARKER),
            format!("{}\n", closure.digest),
        )
        .map_err(io_err("write tree marker"))?;
        let _ = fs::remove_dir_all(&directory);
        if let Err(error) = fs::rename(&temporary, &directory) {
            let _ = fs::remove_dir_all(&temporary);
            // Another process published the same tree first.
            if !self.tree_complete(&directory, &closure)? {
                return Err(Error::Io {
                    context: format!("publish {}", directory.display()),
                    source: error,
                });
            }
        }
        Ok(Materialized { directory, closure })
    }
}

fn remove_readonly(path: &Path) {
    if let Ok(meta) = fs::metadata(path) {
        let mut perms = meta.permissions();
        #[allow(clippy::permissions_set_readonly_false)]
        perms.set_readonly(false);
        let _ = fs::set_permissions(path, perms);
        let _ = fs::remove_file(path);
    }
}

#[cfg(unix)]
fn same_file(a: &fs::Metadata, b: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    fs::metadata(b)
        .map(|b| a.ino() == b.ino() && a.dev() == b.dev())
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn same_file(_: &fs::Metadata, _: &Path) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_document_matches_the_node_sealer() {
        let mut members = BTreeMap::new();
        members.insert(
            "models/a.glb".to_owned(),
            Identity::new("a".repeat(64), 3).unwrap(),
        );
        members.insert(
            "ATTRIBUTION.json".to_owned(),
            Identity::new("b".repeat(64), 7).unwrap(),
        );
        let bytes = Closure::canonical_document(&members).unwrap();
        assert_eq!(
            String::from_utf8(bytes).unwrap(),
            format!(
                "{{\"members\":{{\"ATTRIBUTION.json\":{{\"bytes\":7,\"sha256\":\"{}\"}},\"models/a.glb\":{{\"bytes\":3,\"sha256\":\"{}\"}}}},\"schema\":\"simforge.actor-assets-closure/v1\"}}",
                "b".repeat(64),
                "a".repeat(64)
            )
        );
    }

    #[test]
    fn origin_spellings_fold() {
        assert_eq!(
            normalize_origin("https://x.net/actor-assets/"),
            "https://x.net"
        );
        assert_eq!(normalize_origin(""), DEFAULT_ORIGIN);
        assert_eq!(normalize_origin("file:///tmp/root/"), "file:///tmp/root");
        let store = Store::new("https://x.net", "/c");
        assert_eq!(
            store.blob_url(&"ab".repeat(32)),
            format!(
                "https://x.net/actor-assets/blobs/sha256/ab/{}",
                "ab".repeat(32)
            )
        );
    }

    #[test]
    fn unsafe_member_paths_are_refused() {
        for bad in ["../x", "a//b", "./a", "a\\b", ""] {
            assert!(safe_member_path(bad).is_err(), "{bad}");
        }
    }
}
