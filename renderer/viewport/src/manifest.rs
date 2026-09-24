//! The immutable map manifest, as the native renderer sees it.
//!
//! `.map-release.json` at the root of a native map profile is the same
//! `simforge.map-installation.v1` document the registry publishes and the
//! studio's `native-profile` endpoint reports members from. The renderer does
//! not trust argv for identity: argv (or a `load-map` command) states which
//! release the host *believes* it is opening, and this module proves it
//! against the bytes on disk. A mismatch is an `error` event, never a load.
//!
//! Cost discipline: `master.gltf` is hashed before `manifest-ready` because
//! every later decision is read out of it, and it is small (1-25 MB across
//! the canonical maps). `geometry.bin` is 60-400 MB, so its hash runs on a
//! background thread and reports through `complete`/`error` instead of
//! delaying first pixels by a second.

use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fmt;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

pub const MANIFEST_FILE: &str = ".map-release.json";
pub const MASTER_GLTF: &str = "master.gltf";
pub const GEOMETRY_BIN: &str = "geometry.bin";
const SCHEMA: &str = "simforge.map-installation.v1";

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct Member {
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MapRelease {
    pub schema: String,
    pub name: String,
    pub version: String,
    pub profile: String,
    pub release_digest: String,
    pub canonical_digest: String,
    pub members: BTreeMap<String, Member>,
}

impl MapRelease {
    pub fn total_bytes(&self) -> u64 {
        self.members.values().map(|member| member.bytes).sum()
    }

    pub fn member(&self, relative_path: &str) -> Option<&Member> {
        self.members.get(relative_path)
    }
}

/// Every rejection carries the protocol error code the host sees. The codes
/// are part of the contract: `native_map_unavailable` mirrors the studio
/// endpoint's 404 so both halves name the same condition the same way.
#[derive(Debug, PartialEq, Eq)]
pub struct ManifestError {
    pub code: &'static str,
    pub message: String,
}

impl fmt::Display for ManifestError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for ManifestError {}

fn reject(code: &'static str, message: impl Into<String>) -> ManifestError {
    ManifestError {
        code,
        message: message.into(),
    }
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

pub fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 20];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

#[derive(Debug)]
pub struct VerifiedManifest {
    pub root: PathBuf,
    pub release: MapRelease,
    /// Members whose content digest was verified before `manifest-ready`.
    pub verified: Vec<String>,
    /// Members present with the declared byte length but not content-hashed
    /// on the startup path.
    pub size_checked: usize,
}

/// Load `.map-release.json` and prove the profile on disk is the release the
/// host asked for.
///
/// Checks, in order of cost: manifest present and parseable, schema and
/// profile, requested digest well-formed, manifest digest equals the
/// requested digest, required members declared, every declared member present
/// with its declared byte length, and finally the content hash of
/// `eager_digest` members.
pub fn load_and_verify(
    root: &Path,
    requested_release_digest: &str,
    eager_digest: &[&str],
) -> Result<VerifiedManifest, ManifestError> {
    let manifest_path = root.join(MANIFEST_FILE);
    let raw = std::fs::read(&manifest_path).map_err(|error| {
        reject(
            "native_map_unavailable",
            format!("cannot read {}: {error}", manifest_path.display()),
        )
    })?;
    let release: MapRelease = serde_json::from_slice(&raw).map_err(|error| {
        reject(
            "native_map_unavailable",
            format!("{MANIFEST_FILE} is not a map release document: {error}"),
        )
    })?;
    if release.schema != SCHEMA {
        return Err(reject(
            "manifest_schema_unsupported",
            format!("expected schema {SCHEMA}, found {}", release.schema),
        ));
    }
    if release.profile != "native" {
        return Err(reject(
            "profile_mismatch",
            format!(
                "map root holds the `{}` profile, not `native`",
                release.profile
            ),
        ));
    }
    if !is_sha256(requested_release_digest) {
        return Err(reject(
            "release_digest_malformed",
            format!(
                "requested release digest is not a lowercase sha-256: {requested_release_digest}"
            ),
        ));
    }
    if !is_sha256(&release.release_digest) || !is_sha256(&release.canonical_digest) {
        return Err(reject(
            "release_digest_malformed",
            "manifest release/canonical digest is not a lowercase sha-256".to_owned(),
        ));
    }
    if release.release_digest != requested_release_digest {
        return Err(reject(
            "release_digest_mismatch",
            format!(
                "host asked for release {requested_release_digest} but {} declares {}",
                root.display(),
                release.release_digest
            ),
        ));
    }
    for required in [MASTER_GLTF, GEOMETRY_BIN] {
        if release.member(required).is_none() {
            return Err(reject(
                "member_missing",
                format!("manifest does not declare the required member {required}"),
            ));
        }
    }
    let mut size_checked = 0usize;
    for (relative_path, member) in &release.members {
        let path = root.join(relative_path);
        let metadata = std::fs::metadata(&path).map_err(|error| {
            reject(
                "member_missing",
                format!("declared member {relative_path} is not on disk: {error}"),
            )
        })?;
        if metadata.len() != member.bytes {
            return Err(reject(
                "member_size_mismatch",
                format!(
                    "{relative_path} is {} bytes on disk, manifest declares {}",
                    metadata.len(),
                    member.bytes
                ),
            ));
        }
        size_checked += 1;
    }
    let mut verified = Vec::new();
    for relative_path in eager_digest {
        let member = release.member(relative_path).ok_or_else(|| {
            reject(
                "member_missing",
                format!("manifest does not declare {relative_path}"),
            )
        })?;
        let actual = sha256_file(&root.join(relative_path)).map_err(|error| {
            reject(
                "member_unreadable",
                format!("cannot hash {relative_path}: {error}"),
            )
        })?;
        if actual != member.sha256 {
            return Err(reject(
                "member_digest_mismatch",
                format!(
                    "{relative_path} hashes to {actual}, manifest declares {}",
                    member.sha256
                ),
            ));
        }
        verified.push((*relative_path).to_owned());
    }
    Ok(VerifiedManifest {
        root: root.to_path_buf(),
        release,
        verified,
        size_checked,
    })
}

/// Content-verify one member; used for the large deferred members.
pub fn verify_member(
    root: &Path,
    release: &MapRelease,
    relative_path: &str,
) -> Result<(), ManifestError> {
    let member = release.member(relative_path).ok_or_else(|| {
        reject(
            "member_missing",
            format!("manifest does not declare {relative_path}"),
        )
    })?;
    let actual = sha256_file(&root.join(relative_path)).map_err(|error| {
        reject(
            "member_unreadable",
            format!("cannot hash {relative_path}: {error}"),
        )
    })?;
    if actual != member.sha256 {
        return Err(reject(
            "member_digest_mismatch",
            format!(
                "{relative_path} hashes to {actual}, manifest declares {}",
                member.sha256
            ),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    struct Fixture {
        root: PathBuf,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    /// A two-member profile: a `master.gltf` with known content and a
    /// `geometry.bin`, wired into a manifest whose digests are computed here
    /// so the fixture is self-consistent by construction.
    fn fixture(mutate: impl FnOnce(&mut serde_json::Value)) -> Fixture {
        let id = COUNTER.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "simforge-viewport-manifest-{}-{id}",
            std::process::id()
        ));
        std::fs::create_dir_all(&root).expect("fixture root");
        let gltf = br#"{"asset":{"version":"2.0"}}"#;
        let geometry = b"geometry-bytes";
        std::fs::write(root.join(MASTER_GLTF), gltf).expect("write gltf");
        std::fs::write(root.join(GEOMETRY_BIN), geometry).expect("write bin");
        let digest = |bytes: &[u8]| format!("{:x}", Sha256::digest(bytes));
        let mut manifest = serde_json::json!({
            "schema": SCHEMA,
            "name": "fixture-map",
            "version": "v1",
            "profile": "native",
            "releaseDigest": "1".repeat(64),
            "canonicalDigest": "2".repeat(64),
            "members": {
                MASTER_GLTF: { "bytes": gltf.len(), "sha256": digest(gltf) },
                GEOMETRY_BIN: { "bytes": geometry.len(), "sha256": digest(geometry) },
            }
        });
        mutate(&mut manifest);
        std::fs::write(
            root.join(MANIFEST_FILE),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .expect("write manifest");
        Fixture { root }
    }

    #[test]
    fn verifies_a_consistent_profile() {
        let fixture = fixture(|_| {});
        let verified =
            load_and_verify(&fixture.root, &"1".repeat(64), &[MASTER_GLTF]).expect("verify");
        assert_eq!(verified.release.name, "fixture-map");
        assert_eq!(verified.verified, vec![MASTER_GLTF.to_owned()]);
        assert_eq!(verified.size_checked, 2);
        verify_member(&fixture.root, &verified.release, GEOMETRY_BIN)
            .expect("deferred member verifies");
    }

    #[test]
    fn rejects_a_release_digest_the_host_did_not_ask_for() {
        let fixture = fixture(|_| {});
        let error =
            load_and_verify(&fixture.root, &"3".repeat(64), &[MASTER_GLTF]).expect_err("mismatch");
        assert_eq!(error.code, "release_digest_mismatch");
    }

    #[test]
    fn rejects_a_corrupted_member() {
        let fixture = fixture(|_| {});
        std::fs::write(
            fixture.root.join(MASTER_GLTF),
            br#"{"asset":{"version":"2.1"}}"#,
        )
        .expect("corrupt");
        let error =
            load_and_verify(&fixture.root, &"1".repeat(64), &[MASTER_GLTF]).expect_err("corrupt");
        // Same byte length, different bytes: only the content hash catches it.
        assert_eq!(error.code, "member_digest_mismatch");
    }

    #[test]
    fn rejects_a_truncated_member_before_hashing() {
        let fixture = fixture(|_| {});
        std::fs::write(fixture.root.join(GEOMETRY_BIN), b"short").expect("truncate");
        let error =
            load_and_verify(&fixture.root, &"1".repeat(64), &[MASTER_GLTF]).expect_err("truncated");
        assert_eq!(error.code, "member_size_mismatch");
    }

    #[test]
    fn rejects_a_web_profile_root() {
        let fixture = fixture(|manifest| manifest["profile"] = serde_json::json!("web"));
        let error = load_and_verify(&fixture.root, &"1".repeat(64), &[]).expect_err("profile");
        assert_eq!(error.code, "profile_mismatch");
    }

    #[test]
    fn rejects_a_malformed_requested_digest() {
        let fixture = fixture(|_| {});
        let error = load_and_verify(&fixture.root, "native-release", &[]).expect_err("malformed");
        assert_eq!(error.code, "release_digest_malformed");
    }
}
