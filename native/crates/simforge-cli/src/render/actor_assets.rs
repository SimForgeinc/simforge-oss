//! The actor-asset closure a render binds, ported from
//! `oss/packages/render/src/native/actor-assets.ts`.
//!
//! The closure (`simforge.actor-assets-closure/v1`) is the immutable document
//! whose digest names every vehicle, walker and prop model a render may draw;
//! each member it lists is content-addressed. `simforge assets pull` installs
//! it as `<root>/closures/<digest>.json` + `<root>/blobs/sha256/<aa>/<sha256>`.
//! Before any frame is rendered, [`ensure_actor_assets`]:
//!
//! 1. reads the closure document and checks its sha256 is the digest the
//!    render binds (and its size, when the caller pins one);
//! 2. re-hashes every member blob in the store (the store is a cache, never
//!    an authority; a missing or corrupt blob fails with a `simforge assets
//!    pull` hint, it is not fetched behind the caller's back);
//! 3. lays the members out once per digest as a tree of hard links under
//!    `<tree root>/<digest>` (the directory the service reads as
//!    `vehicleModels`/`pedestrianModels`), reused by later renders when every
//!    member is still the verified blob; a filesystem that refuses hard links
//!    gets copies, counted in the result;
//! 4. parses `catalog-models.json` exactly as the service does and binds each
//!    catalog id to a verified model.
//!
//! [`assert_actor_appearance_grounded`] and [`assert_actor_animations_bound`]
//! then refuse a render whose actors would not look like the scenario: no
//! class primitive stands in for a missing model, no walker slides in a
//! static pose. There is no default closure and no proxy downgrade.
//!
//! Catalog data: which catalog ids a procedural builder draws (and so need
//! no closure model) comes from `simforge_core::catalog_aliases::
//! PROCEDURAL_CATALOG_IDS`, generated from `@simforge-oss/asset-catalog` by
//! the same `generate-catalog.ts` (with its `--check` drift gate) that
//! already emits the Rust catalog aliases. Kind defaults are
//! `simforge_core::trace::scene_state::catalog_id_for`, the table the
//! TypeScript `NATIVE_KIND_DEFAULT_CATALOG_IDS` is pinned equal to.

use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::contract::CliError;

pub const NATIVE_ACTOR_ASSETS_INPUT_ID: &str = "actors.native-closure";
pub const NATIVE_ACTOR_ASSETS_CLOSURE_SCHEMA: &str = "simforge.actor-assets-closure/v1";
/// The closure member the retained service resolves catalog ids through.
pub const NATIVE_ACTOR_ASSETS_CATALOG_PATH: &str = "catalog-models.json";
/// The service plays `walk` above this speed (`renderer/service` `apply_scene_tick`).
pub const NATIVE_WALK_SPEED_MPS: f64 = 0.2;
const TREE_COMPLETE_MARKER: &str = ".simforge-closure-complete";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ClosureMember {
    pub sha256: [u8; 32],
    pub bytes: u64,
}

impl ClosureMember {
    pub fn sha256_hex(&self) -> String {
        hex(&self.sha256)
    }
}

/// One named motion clip (`walk`, `idle`) a catalog model binds.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActorClosureAnimation {
    pub glb_path: String,
    pub clip: String,
    /// Lift from the actor's ground point to the model origin while this clip plays.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ground_offset_m: Option<f64>,
}

/// A catalog id's model as `catalog-models.json` declares it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActorClosureModel {
    pub catalog_id: String,
    pub glb_path: String,
    /// Motion name → clip, as the service binds them.
    pub animations: BTreeMap<String, ActorClosureAnimation>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ActorAssetsClosure {
    pub digest: String,
    pub size_bytes: u64,
    pub members: BTreeMap<String, ClosureMember>,
}

/// A closure proven against its store and laid out for the service.
#[derive(Debug, Clone)]
pub struct VerifiedActorAssets {
    pub closure: ActorAssetsClosure,
    /// The tree holding exactly the closure members (`vehicleModels` / `pedestrianModels`).
    pub directory: PathBuf,
    /// Catalog ids the service can bind to a verified closure model.
    pub models: BTreeMap<String, ActorClosureModel>,
    /// Bytes re-hashed in the store.
    pub verified_bytes: u64,
    /// The tree was already complete and still the verified blobs.
    pub reused_tree: bool,
    /// Members laid out by hard link and by copy (a copy means the tree and
    /// store are on filesystems that refuse links).
    pub linked_files: u64,
    pub copied_files: u64,
}

impl VerifiedActorAssets {
    /// The record a render's results carry.
    pub fn evidence(&self) -> Value {
        json!({
            "inputId": NATIVE_ACTOR_ASSETS_INPUT_ID,
            "digest": self.closure.digest,
            "sizeBytes": self.closure.size_bytes,
            "members": self.closure.members.len(),
            "memberBytes": self.closure.members.values().map(|m| m.bytes).sum::<u64>(),
            "directory": self.directory,
            "models": self.models.len(),
            "verifiedBytes": self.verified_bytes,
            "reusedTree": self.reused_tree,
            "linkedFiles": self.linked_files,
            "copiedFiles": self.copied_files,
        })
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn parse_hex32(text: &str) -> Option<[u8; 32]> {
    if text.len() != 64
        || !text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, chunk) in text.as_bytes().chunks(2).enumerate() {
        out[i] = u8::from_str_radix(std::str::from_utf8(chunk).ok()?, 16).ok()?;
    }
    Some(out)
}

fn closure_error(code: &str, message: String) -> CliError {
    CliError::findings(code, message)
}

/// The path parts of a closure member, refusing anything that could escape the tree.
pub fn safe_member_path(member_path: &str) -> Result<Vec<&str>, CliError> {
    let parts: Vec<&str> = member_path.split('/').collect();
    if parts
        .iter()
        .any(|p| p.is_empty() || *p == "." || *p == ".." || p.contains('\\'))
    {
        return Err(closure_error(
            "actor_closure_invalid",
            format!("unsafe actor asset closure path: {member_path}"),
        ));
    }
    Ok(parts)
}

fn join_member(root: &Path, member_path: &str) -> Result<PathBuf, CliError> {
    Ok(safe_member_path(member_path)?
        .into_iter()
        .fold(root.to_path_buf(), |p, part| p.join(part)))
}

/// `parseActorAssetsClosure`: the document is the identity. Its sha256 must
/// be `digest` (and its size `size_bytes` when given).
pub fn parse_actor_assets_closure(
    bytes: &[u8],
    digest: &str,
    size_bytes: Option<u64>,
) -> Result<ActorAssetsClosure, CliError> {
    let actual = hex(&Sha256::digest(bytes));
    if actual != digest || size_bytes.is_some_and(|s| s != bytes.len() as u64) {
        return Err(closure_error(
            "actor_closure_digest_mismatch",
            format!(
                "actor asset closure does not match its declared identity: expected {digest}/{}, got {actual}/{}",
                size_bytes.map_or("*".to_owned(), |s| s.to_string()),
                bytes.len()
            ),
        ));
    }
    let document: Value = serde_json::from_slice(bytes).map_err(|e| {
        closure_error(
            "actor_closure_invalid",
            format!("actor asset closure {digest} is not JSON: {e}"),
        )
    })?;
    let members_json = match (&document["schema"], document.get("members")) {
        (Value::String(schema), Some(Value::Object(members)))
            if schema == NATIVE_ACTOR_ASSETS_CLOSURE_SCHEMA =>
        {
            members
        }
        _ => {
            return Err(closure_error(
                "actor_closure_invalid",
                "unsupported actor asset closure schema".into(),
            ))
        }
    };
    let mut members = BTreeMap::new();
    for (member_path, member) in members_json {
        safe_member_path(member_path)?;
        let sha = member["sha256"].as_str().and_then(parse_hex32);
        // `Number.isInteger(bytes) && bytes >= 0` (5.0 is an integer too).
        let size = member["bytes"]
            .as_f64()
            .filter(|b| b.fract() == 0.0 && *b >= 0.0 && *b <= 9_007_199_254_740_991.0);
        let (Some(sha256), Some(size)) = (sha, size) else {
            return Err(closure_error(
                "actor_closure_invalid",
                format!("actor asset closure member {member_path} lacks a sha256/bytes identity"),
            ));
        };
        members.insert(
            member_path.clone(),
            ClosureMember {
                sha256,
                bytes: size as u64,
            },
        );
    }
    if !members.contains_key(NATIVE_ACTOR_ASSETS_CATALOG_PATH) {
        return Err(closure_error(
            "actor_closure_invalid",
            format!("actor asset closure {digest} lacks {NATIVE_ACTOR_ASSETS_CATALOG_PATH}"),
        ));
    }
    Ok(ActorAssetsClosure {
        digest: actual,
        size_bytes: bytes.len() as u64,
        members,
    })
}

fn catalog_error(message: String) -> CliError {
    CliError::findings(
        "native_actor_catalog_invalid",
        format!("{NATIVE_ACTOR_ASSETS_CATALOG_PATH}: {message}"),
    )
}

fn finite(value: &Value) -> Option<f64> {
    value.as_f64().filter(|v| v.is_finite())
}

/// Motion states whose clips stand a walker on its own feet (a rider's clip is placed by its bike).
const MOTION_CLIPS: [&str; 3] = ["idle", "walk", "run"];

/// `parseActorClosureCatalog`: `catalog-models.json` as the retained service
/// reads it (`vehicle_model.rs` `from_sidecar`). Strict like the service: a
/// malformed entry is refused by name, never skipped, and every referenced
/// path must be a closure member.
pub fn parse_actor_closure_catalog(
    bytes: &[u8],
    members: &BTreeMap<String, ClosureMember>,
) -> Result<BTreeMap<String, ActorClosureModel>, CliError> {
    let raw: Value =
        serde_json::from_slice(bytes).map_err(|e| catalog_error(format!("not JSON ({e})")))?;
    let Value::Object(raw) = raw else {
        return Err(catalog_error("expected an object".into()));
    };
    let table: &Map<String, Value> = ["models", "entries", "vehicles"]
        .iter()
        .find_map(|key| raw.get(*key).and_then(Value::as_object))
        .unwrap_or(&raw);
    let member = |catalog_id: &str, what: &str, path: &Value| -> Result<String, CliError> {
        let Some(path) = path.as_str().filter(|p| !p.is_empty()) else {
            return Err(catalog_error(format!("{catalog_id} {what} has no glbPath")));
        };
        if !members.contains_key(path) {
            return Err(catalog_error(format!(
                "binds {catalog_id} {what} to {path}, which is not a closure member"
            )));
        }
        Ok(path.to_owned())
    };
    let mut models = BTreeMap::new();
    for (catalog_id, value) in table {
        if !catalog_id.contains('.') {
            continue; // wrapper metadata, e.g. `version`
        }
        let Value::Object(entry) = value else {
            return Err(catalog_error(format!(
                "entry {catalog_id} is not an object"
            )));
        };
        let model = match entry.get("model") {
            None => value,
            Some(model) => model,
        };
        let Value::Object(model) = model else {
            return Err(catalog_error(format!(
                "entry {catalog_id} model is not an object"
            )));
        };
        let glb_path = member(
            catalog_id,
            "model",
            model.get("glbPath").unwrap_or(&Value::Null),
        )?;
        for key in ["tintable", "scaleToDims"] {
            if !entry.get(key).is_some_and(Value::is_boolean) {
                return Err(catalog_error(format!(
                    "entry {catalog_id} does not declare {key} as a boolean"
                )));
            }
        }
        for key in ["uniformScale", "yawOffsetRad", "groundOffsetM"] {
            if let Some(v) = entry.get(key) {
                if finite(v).is_none() {
                    return Err(catalog_error(format!(
                        "entry {catalog_id} {key} is not a finite number"
                    )));
                }
            }
        }
        let mut animations: BTreeMap<String, ActorClosureAnimation> = BTreeMap::new();
        if let Some(value) = entry.get("animations") {
            let Value::Object(map) = value else {
                return Err(catalog_error(format!(
                    "entry {catalog_id} animations is not an object"
                )));
            };
            for (name, animation) in map {
                let Value::Object(animation) = animation else {
                    return Err(catalog_error(format!(
                        "entry {catalog_id} animation {name} is not an object"
                    )));
                };
                let path = member(
                    catalog_id,
                    &format!("animation {name}"),
                    animation.get("glbPath").unwrap_or(&Value::Null),
                )?;
                let Some(clip) = animation
                    .get("clip")
                    .and_then(Value::as_str)
                    .filter(|c| !c.is_empty())
                else {
                    return Err(catalog_error(format!(
                        "entry {catalog_id} animation {name} names no clip"
                    )));
                };
                let ground_offset_m = match animation.get("groundOffsetM") {
                    None => None,
                    Some(v) => Some(finite(v).ok_or_else(|| {
                        catalog_error(format!(
                            "entry {catalog_id} animation {name} groundOffsetM is not a finite number"
                        ))
                    })?),
                };
                animations.insert(
                    name.clone(),
                    ActorClosureAnimation {
                        glb_path: path,
                        clip: clip.to_owned(),
                        ground_offset_m,
                    },
                );
            }
        }
        if let Some(clips) = model.get("clips") {
            let Value::Object(clips) = clips else {
                return Err(catalog_error(format!(
                    "entry {catalog_id} model.clips is not an object"
                )));
            };
            let offsets = model.get("clipGroundOffsetM").and_then(Value::as_object);
            for (key, clip) in clips {
                let motion = match key.as_str() {
                    "idle" => "idle",
                    "locomotion" => "walk",
                    _ => {
                        return Err(catalog_error(format!(
                            "entry {catalog_id} model.clips.{key} is not a known motion (idle, locomotion)"
                        )))
                    }
                };
                let Some(clip) = clip.as_str().filter(|c| !c.is_empty()) else {
                    return Err(catalog_error(format!(
                        "entry {catalog_id} model.clips.{key} is not a clip name"
                    )));
                };
                if animations.contains_key(motion) {
                    return Err(catalog_error(format!(
                        "entry {catalog_id} binds the {motion} clip twice (animations and model.clips)"
                    )));
                }
                let ground_offset_m = match offsets.and_then(|o| o.get(key)) {
                    None => None,
                    Some(v) => Some(finite(v).ok_or_else(|| {
                        catalog_error(format!(
                            "entry {catalog_id} model.clipGroundOffsetM.{key} is not a finite number"
                        ))
                    })?),
                };
                animations.insert(
                    motion.to_owned(),
                    ActorClosureAnimation {
                        glb_path: glb_path.clone(),
                        clip: clip.to_owned(),
                        ground_offset_m,
                    },
                );
            }
        }
        for (motion, animation) in &animations {
            if MOTION_CLIPS.contains(&motion.as_str()) && animation.ground_offset_m.is_none() {
                return Err(catalog_error(format!(
                    "entry {catalog_id} binds a {motion} clip without a measured groundOffsetM; its walker would render at its origin, not on its soles"
                )));
            }
        }
        if model.get("animated") == Some(&Value::Bool(true)) && animations.is_empty() {
            return Err(catalog_error(format!(
                "entry {catalog_id} is animated but binds no animation clips"
            )));
        }
        models.insert(
            catalog_id.clone(),
            ActorClosureModel {
                catalog_id: catalog_id.clone(),
                glb_path,
                animations,
            },
        );
    }
    Ok(models)
}

fn hash_file(path: &Path) -> std::io::Result<([u8; 32], u64)> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    let mut total = 0u64;
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        total += n as u64;
    }
    Ok((hasher.finalize().into(), total))
}

pub fn blob_path(root: &Path, member: &ClosureMember) -> PathBuf {
    let sha = member.sha256_hex();
    root.join("blobs").join("sha256").join(&sha[..2]).join(sha)
}

pub fn closure_path(root: &Path, digest: &str) -> PathBuf {
    root.join("closures").join(format!("{digest}.json"))
}

fn pull_hint(digest: &str) -> String {
    format!("run `simforge assets pull --closure {digest}` to install or repair it")
}

/// Re-hash every member blob in the store, in parallel. The first failure
/// (missing or not the declared bytes) is reported by member path.
fn verify_store(root: &Path, closure: &ActorAssetsClosure) -> Result<u64, CliError> {
    let entries: Vec<(&String, &ClosureMember)> = closure.members.iter().collect();
    let next = std::sync::atomic::AtomicUsize::new(0);
    let failure: std::sync::Mutex<Option<CliError>> = std::sync::Mutex::new(None);
    let threads = std::thread::available_parallelism()
        .map_or(4, |n| n.get())
        .clamp(1, 8);
    std::thread::scope(|scope| {
        for _ in 0..threads.min(entries.len().max(1)) {
            scope.spawn(|| loop {
                if failure.lock().expect("failure lock").is_some() {
                    return;
                }
                let i = next.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let Some((member_path, member)) = entries.get(i) else {
                    return;
                };
                let blob = blob_path(root, member);
                let error = match hash_file(&blob) {
                    Ok((sha, bytes)) if sha == member.sha256 && bytes == member.bytes => continue,
                    Ok((sha, bytes)) => closure_error(
                        "actor_asset_blob_mismatch",
                        format!(
                            "actor asset blob digest mismatch for {member_path}: expected {}/{}, got {}/{bytes}",
                            member.sha256_hex(),
                            member.bytes,
                            hex(&sha)
                        ),
                    ),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => CliError::new(
                        "actor_asset_blob_missing",
                        format!("actor closure {} member {member_path} is not installed", closure.digest),
                    ),
                    Err(e) => CliError::new(
                        "actor_asset_blob_unreadable",
                        format!("cannot read {}: {e}", blob.display()),
                    ),
                };
                let error = error
                    .with_path(blob.display().to_string())
                    .with_detail(json!({ "member": member_path, "hint": pull_hint(&closure.digest) }));
                failure.lock().expect("failure lock").get_or_insert(error);
                return;
            });
        }
    });
    if let Some(error) = failure.into_inner().expect("failure lock") {
        return Err(error);
    }
    Ok(closure.members.values().map(|m| m.bytes).sum())
}

#[cfg(unix)]
fn same_file(a: &std::fs::Metadata, b: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    a.ino() == b.ino() && a.dev() == b.dev()
}

#[cfg(not(unix))]
fn same_file(_: &std::fs::Metadata, _: &std::fs::Metadata) -> bool {
    false
}

/// A tree member is valid when it is the verified blob itself (same inode)
/// or re-hashes to the member's bytes.
fn tree_member_valid(tree_file: &Path, blob_file: &Path, member: &ClosureMember) -> bool {
    let Ok(tree) = std::fs::metadata(tree_file) else {
        return false;
    };
    if !tree.is_file() || tree.len() != member.bytes {
        return false;
    }
    if std::fs::metadata(blob_file).is_ok_and(|blob| same_file(&tree, &blob)) {
        return true;
    }
    hash_file(tree_file).is_ok_and(|(sha, bytes)| sha == member.sha256 && bytes == member.bytes)
}

fn reuse_tree(directory: &Path, root: &Path, closure: &ActorAssetsClosure) -> bool {
    if !directory.join(TREE_COMPLETE_MARKER).is_file() {
        return false;
    }
    closure.members.iter().all(|(member_path, member)| {
        join_member(directory, member_path)
            .is_ok_and(|file| tree_member_valid(&file, &blob_path(root, member), member))
    })
}

/// `linkOrCopy`: a hard link, or a copy where the filesystem refuses links
/// (cross-device, or installed files that permit reading but not linking).
fn link_or_copy(source: &Path, target: &Path) -> std::io::Result<bool> {
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    match std::fs::hard_link(source, target) {
        Ok(()) => Ok(true),
        Err(e)
            if e.kind() == std::io::ErrorKind::CrossesDevices
                || e.kind() == std::io::ErrorKind::PermissionDenied
                || e.raw_os_error() == Some(1) /* EPERM */ =>
        {
            std::fs::copy(source, target)?;
            Ok(false)
        }
        Err(e) => Err(e),
    }
}

/// Verify the closure `digest` in the installed store at `root` and lay it
/// out under `<tree_root>/<digest>` (default tree root: `<root>/trees`, on the
/// store's filesystem so the links are free). See the module docs.
pub fn ensure_actor_assets(
    root: &Path,
    digest: &str,
    size_bytes: Option<u64>,
    tree_root: Option<&Path>,
) -> Result<VerifiedActorAssets, CliError> {
    if parse_hex32(digest).is_none() {
        return Err(CliError::new(
            "bad_value",
            format!("actor closure digest {digest:?} is not a lowercase sha256"),
        ));
    }
    let document = closure_path(root, digest);
    let bytes = std::fs::read(&document).map_err(|e| {
        CliError::new(
            "actor_closure_not_installed",
            format!(
                "actor closure {digest} is not installed in {} ({e})",
                root.display()
            ),
        )
        .with_path(document.display().to_string())
        .with_detail(json!({ "hint": pull_hint(digest) }))
    })?;
    let closure = parse_actor_assets_closure(&bytes, digest, size_bytes)?;
    let verified_bytes = verify_store(root, &closure)?;

    let tree_root = tree_root.map_or_else(|| root.join("trees"), Path::to_path_buf);
    let directory = tree_root.join(&closure.digest);
    let io = |what: &str, path: &Path, e: std::io::Error| {
        CliError::new("write_failed", format!("{what} {}: {e}", path.display()))
            .with_path(path.display().to_string())
    };
    let (mut linked, mut copied) = (0u64, 0u64);
    let reused = reuse_tree(&directory, root, &closure);
    if !reused {
        let temporary = tree_root.join(format!(".{}.{}.tmp", closure.digest, std::process::id()));
        let _ = std::fs::remove_dir_all(&temporary);
        for (member_path, member) in &closure.members {
            let target = join_member(&temporary, member_path)?;
            match link_or_copy(&blob_path(root, member), &target) {
                Ok(true) => linked += 1,
                Ok(false) => copied += 1,
                Err(e) => return Err(io("cannot lay out", &target, e)),
            }
        }
        std::fs::write(
            temporary.join(TREE_COMPLETE_MARKER),
            format!("{}\n", closure.digest),
        )
        .map_err(|e| io("cannot write", &temporary, e))?;
        if directory.exists() {
            std::fs::remove_dir_all(&directory).map_err(|e| io("cannot replace", &directory, e))?;
        }
        if let Err(e) = std::fs::rename(&temporary, &directory) {
            // A concurrent render published the same tree first; ours is redundant.
            let _ = std::fs::remove_dir_all(&temporary);
            if !reuse_tree(&directory, root, &closure) {
                return Err(io("cannot publish", &directory, e));
            }
        }
    }

    let catalog_member = closure.members[NATIVE_ACTOR_ASSETS_CATALOG_PATH];
    let catalog_file = directory.join(NATIVE_ACTOR_ASSETS_CATALOG_PATH);
    let catalog_bytes =
        std::fs::read(&catalog_file).map_err(|e| io("cannot read", &catalog_file, e))?;
    if Sha256::digest(&catalog_bytes).as_slice() != catalog_member.sha256 {
        return Err(closure_error(
            "actor_asset_blob_mismatch",
            format!(
                "materialized {NATIVE_ACTOR_ASSETS_CATALOG_PATH} does not match closure {}",
                closure.digest
            ),
        ));
    }
    let models = parse_actor_closure_catalog(&catalog_bytes, &closure.members)?;
    Ok(VerifiedActorAssets {
        closure,
        directory,
        models,
        verified_bytes,
        reused_tree: reused,
        linked_files: linked,
        copied_files: copied,
    })
}

/// A rendered actor's identity (`NativeActorAppearance`).
#[derive(Debug, Clone, PartialEq)]
pub struct ActorAppearance {
    pub actor_id: String,
    /// The engine actor kind, when known.
    pub kind: Option<String>,
    pub catalog_id: String,
    /// The scenario authored the catalog id (`catalog:<id>` tag).
    pub authored: bool,
}

/// A sensor source mounted on an actor, with the vehicle identity the rig contract names.
#[derive(Debug, Clone, PartialEq)]
pub struct SensorHost {
    pub source_id: String,
    pub actor_id: String,
    pub catalog_asset_id: String,
}

/// The documented catalog default for an engine actor kind
/// (`nativeKindDefaultCatalogId`); refuses an unknown kind.
pub fn kind_default_catalog_id(kind: &str, subject: &str) -> Result<String, CliError> {
    // `obstacle` is the OpenSCENARIO spelling of `static_object`.
    let engine_kind = if kind == "obstacle" {
        "static_object"
    } else {
        kind
    };
    match serde_json::from_value::<simforge_core::types::ActorKind>(json!(engine_kind)) {
        Ok(parsed) => Ok(simforge_core::trace::scene_state::catalog_id_for(parsed, &[])),
        Err(_) => Err(CliError::findings(
            "native_actor_kind_unmapped",
            format!("{subject} has actor kind \"{kind}\", which the native catalog default table does not map"),
        )
        .with_detail(json!({ "kind": kind }))),
    }
}

/// Whether a procedural builder draws `catalog_id` (no closure model needed).
pub fn is_procedural(catalog_id: &str) -> bool {
    simforge_core::catalog_aliases::is_procedural_catalog_id(catalog_id)
}

/// `assertActorAppearanceGrounded`: every rendered actor must declare a
/// procedural builder or bind a verified closure model; an unauthored actor
/// must carry its kind's documented default; every sensor host's contract
/// identity must be the identity rendered for that actor.
pub fn assert_actor_appearance_grounded(
    appearances: &[ActorAppearance],
    sensor_hosts: &[SensorHost],
    digest: &str,
    models: &BTreeMap<String, ActorClosureModel>,
) -> Result<(), CliError> {
    let by_actor: BTreeMap<&str, &ActorAppearance> = appearances
        .iter()
        .map(|a| (a.actor_id.as_str(), a))
        .collect();
    for host in sensor_hosts {
        let Some(appearance) = by_actor.get(host.actor_id.as_str()) else {
            return Err(CliError::findings(
                "native_sensor_host_absent",
                format!(
                    "sensor host {} rides actor {}, which is never present in the lowered scenario",
                    host.source_id, host.actor_id
                ),
            ));
        };
        if appearance.catalog_id != host.catalog_asset_id {
            return Err(CliError::findings(
                "native_sensor_host_identity_mismatch",
                format!(
                    "sensor host {} identifies actor {} as {}, but the scenario renders it as {}",
                    host.source_id, host.actor_id, host.catalog_asset_id, appearance.catalog_id
                ),
            ));
        }
    }
    for appearance in appearances {
        if !appearance.authored {
            let Some(kind) = appearance.kind.as_deref() else {
                return Err(CliError::findings(
                    "native_actor_kind_unmapped",
                    format!(
                        "actor {} has no authored catalog id and no kind to take a default from",
                        appearance.actor_id
                    ),
                ));
            };
            let expected =
                kind_default_catalog_id(kind, &format!("actor {}", appearance.actor_id))?;
            if appearance.catalog_id != expected {
                return Err(CliError::findings(
                    "native_actor_default_mismatch",
                    format!(
                        "actor {} (kind {kind}) has no authored catalog id; the scene source renders it as {}, but the documented default for {kind} is {expected}",
                        appearance.actor_id, appearance.catalog_id
                    ),
                )
                .with_detail(json!({ "actorId": appearance.actor_id, "kind": kind, "catalogId": appearance.catalog_id, "expected": expected })));
            }
        }
        if is_procedural(&appearance.catalog_id) || models.contains_key(&appearance.catalog_id) {
            continue;
        }
        let why = if appearance.authored {
            "authored".to_owned()
        } else {
            format!("{} default", appearance.kind.as_deref().unwrap_or_default())
        };
        return Err(CliError::findings(
            "native_actor_model_missing",
            format!(
                "actor {} requires catalog model {} ({why}), which actor closure {digest} does not provide",
                appearance.actor_id, appearance.catalog_id
            ),
        )
        .with_detail(json!({ "actorId": appearance.actor_id, "catalogId": appearance.catalog_id, "closure": digest })));
    }
    Ok(())
}

/// Actor kinds whose catalog model must animate while the actor moves.
const ANIMATED_KINDS: [&str; 2] = ["pedestrian", "animal"];

fn is_moving(actor: &Value) -> bool {
    let v = |i: usize| actor["velocity"][i].as_f64().unwrap_or(0.0);
    let (x, y, z) = (v(0), v(1), v(2));
    (x * x + y * y + z * z).sqrt() > NATIVE_WALK_SPEED_MPS
        || actor["catalogId"]
            .as_str()
            .is_some_and(|c| c.ends_with("_walking"))
}

/// `assertActorAnimationsBound`: a moving pedestrian or animal needs a `walk`
/// clip, a standing pedestrian an `idle` clip, in the closure. `states` are
/// the scene-state frames the render loads (`load_scene_state`: each with
/// `actors: [{id, kind: spawn|update|despawn, catalogId, velocity}]`).
/// Procedural models carry their own motion and are exempt.
pub fn assert_actor_animations_bound(
    appearances: &[ActorAppearance],
    states: &[Value],
    digest: &str,
    models: &BTreeMap<String, ActorClosureModel>,
) -> Result<(), CliError> {
    let animated: BTreeMap<&str, &ActorAppearance> = appearances
        .iter()
        .filter(|a| {
            a.kind
                .as_deref()
                .is_some_and(|k| ANIMATED_KINDS.contains(&k))
                && !is_procedural(&a.catalog_id)
        })
        .map(|a| (a.actor_id.as_str(), a))
        .collect();
    if animated.is_empty() {
        return Ok(());
    }
    let mut needs: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
    for state in states {
        for actor in state["actors"].as_array().into_iter().flatten() {
            let Some(id) = actor["id"].as_str() else {
                continue;
            };
            let Some(appearance) = animated.get(id) else {
                continue;
            };
            if actor["kind"] == "despawn" {
                continue;
            }
            let motion = if is_moving(actor) {
                "walk"
            } else if appearance.kind.as_deref() == Some("pedestrian") {
                "idle"
            } else {
                continue;
            };
            needs
                .entry(appearance.actor_id.as_str())
                .or_default()
                .insert(motion);
        }
    }
    for (actor_id, motions) in needs {
        let appearance = animated[actor_id];
        let Some(model) = models.get(&appearance.catalog_id) else {
            continue; // assert_actor_appearance_grounded refuses it by name
        };
        for motion in motions {
            if model.animations.contains_key(motion) {
                continue;
            }
            return Err(CliError::findings(
                "native_actor_animation_missing",
                format!(
                    "{} {actor_id} {} but its catalog model {} binds no {motion} clip in actor closure {digest}",
                    appearance.kind.as_deref().unwrap_or_default(),
                    if motion == "walk" { "moves" } else { "stands" },
                    appearance.catalog_id
                ),
            )
            .with_detail(json!({ "actorId": actor_id, "catalogId": appearance.catalog_id, "motion": motion, "closure": digest })));
        }
    }
    Ok(())
}
