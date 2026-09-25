//! Texture tiers and the staged master (`texture-profile.ts`).
//!
//! A map closure carries two texture tiers: `uastc-full` (the full-size
//! KTX2 images, preferably uploaded from the ingest-built `textures-full-bc7`
//! GPU blocks) and `bc7-512` (512 px BC7 variants for training throughput).
//! [`plan_texture_members`] picks exactly the members one tier renders from;
//! [`stage_texture_profile`] hard-links them into a content-keyed cache tree
//! beside a rewritten `master.gltf` that names the tier's images, and
//! estimates the device memory the scene needs.
//!
//! The staged tree, its key and the rewritten master are byte-identical to
//! the TypeScript engine's, so a CLI render and a worker render of the same
//! map share one staged tree and one set of pixels.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Value};

use super::error::{PlanError, PlanResult, Warning};
use super::jsjson::JsValue;
use super::ktx2;
use super::map_closure::{
    assert_safe_member_path, hash_file, MapClosure, MemberSource, MASTER_PATH,
};
use simforge_core::hash::js_number_to_string;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum TextureTier {
    #[serde(rename = "uastc-full")]
    UastcFull,
    #[serde(rename = "bc7-512")]
    Bc7_512,
}

impl TextureTier {
    pub fn as_str(self) -> &'static str {
        match self {
            TextureTier::UastcFull => "uastc-full",
            TextureTier::Bc7_512 => "bc7-512",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "uastc-full" => Some(TextureTier::UastcFull),
            "bc7-512" => Some(TextureTier::Bc7_512),
            _ => None,
        }
    }
}

/// The ingest-built full-resolution GPU-block variant of `uastc-full`.
pub const FULL_GPU_VARIANT_ID: &str = "textures-full-bc7";
const ML_VARIANT_ID: &str = "textures-512-bc7";
const FULL_GPU_VARIANT_CODECS: [&str; 3] = ["bc7", "bc5", "bc4"];
/// Actor/lighting/driver reserve of the admission estimate.
pub const SCENE_RESERVE_BYTES: u64 = 512 * 1024 * 1024;

/// What one tier renders from.
#[derive(Debug, Clone, PartialEq)]
pub struct TexturePlan {
    /// Every member besides `master.gltf` (manifests, variant index, images,
    /// buffers), in the order the TypeScript planner adds them.
    pub members: Vec<String>,
    /// Final image uri per referenced image index, in texture order.
    pub images: Vec<(usize, String)>,
    pub variant_digest: String,
    /// `bc7-512`: the 512 px variant replaces every image.
    pub variant: bool,
    /// `uastc-full` only: why the service will transcode UASTC at load
    /// instead of uploading the ingest-built GPU blocks.
    pub transcode_at_load: Option<String>,
}

struct Members(Vec<String>);

impl Members {
    fn add(&mut self, uri: &str) {
        if !self.0.iter().any(|m| m == uri) {
            self.0.push(uri.to_owned());
        }
    }
}

fn parse_json(source: &dyn MemberSource, uri: &str) -> PlanResult<Value> {
    serde_json::from_str(&source.read_text(uri)?).map_err(|e| {
        PlanError::new(
            "native_texture_manifest_invalid",
            format!("{uri} is not JSON ({e})"),
        )
    })
}

/// The image index a glTF texture samples (`KHR_texture_basisu.source ?? source`).
fn texture_image_index(texture: &JsValue) -> Option<JsValue> {
    let basisu = texture
        .get("extensions")
        .and_then(|e| e.get("KHR_texture_basisu"))
        .and_then(|k| k.get("source"))
        .filter(|v| **v != JsValue::Null);
    basisu.or_else(|| texture.get("source")).cloned()
}

fn index_label(index: &JsValue) -> String {
    match index {
        JsValue::Number(n) => js_number_to_string(*n),
        JsValue::Null => "null".to_owned(),
        other => other.stringify(),
    }
}

fn image_at<'a>(document: &'a JsValue, index: &JsValue) -> Option<&'a JsValue> {
    let n = index.as_f64()?;
    if n < 0.0 || n.fract() != 0.0 {
        return None;
    }
    document.get("images")?.as_array()?.get(n as usize)
}

fn str_field<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

/// `planNativeTextureMembers`: the members `tier` renders from. Pure over
/// the master and the small manifest members; no texture is read.
pub fn plan_texture_members(
    document: &JsValue,
    tier: TextureTier,
    source: &dyn MemberSource,
) -> PlanResult<TexturePlan> {
    let mut members = Members(Vec::new());
    let require = |members: &mut Members, uri: &str| -> PlanResult<String> {
        assert_safe_member_path(uri)?;
        let sha256 = source
            .sha256(uri)
            .ok_or_else(|| PlanError::new("native_texture_member_missing", uri))?
            .to_owned();
        members.add(uri);
        Ok(sha256)
    };
    let mut variant: Option<Value> = None;
    let mut variant_digest = String::new();
    if tier == TextureTier::Bc7_512 {
        let manifest_sha256 = require(&mut members, "3d/manifest.json")?;
        require(&mut members, "3d/variants/manifest.json")?;
        let manifest = parse_json(source, "3d/variants/manifest.json")?;
        if str_field(&manifest, "sourceManifestSha256") != Some(manifest_sha256.as_str()) {
            return Err(PlanError::bare("native_ml_manifest_binding_mismatch"));
        }
        let entry = manifest.get("variants").and_then(|v| v.get(ML_VARIANT_ID));
        let entry = match entry {
            Some(e) if str_field(e, "sourceManifestSha256") == Some(manifest_sha256.as_str()) => e,
            _ => return Err(PlanError::bare("native_ml_texture_variant_unavailable")),
        };
        let index_uri = format!(
            "3d/variants/{}",
            str_field(entry, "file").unwrap_or("undefined")
        );
        let index_sha256 = require(&mut members, &index_uri)?;
        if Some(index_sha256.as_str()) != str_field(entry, "outputSha256") {
            return Err(PlanError::bare("native_ml_texture_index_digest_mismatch"));
        }
        let index = parse_json(source, &index_uri)?;
        if index.get("schemaVersion").and_then(Value::as_f64) != Some(1.0)
            || str_field(&index, "id") != Some(ML_VARIANT_ID)
            || str_field(&index, "sourceManifestSha256") != Some(manifest_sha256.as_str())
        {
            return Err(PlanError::bare("native_ml_texture_index_invalid"));
        }
        variant = Some(index);
        variant_digest = index_sha256;
    }

    // uastc-full: prefer the pre-transcoded blocks when ingest built them,
    // from derived/textures-full-bc7/ first, else the closure's own variants.
    let mut full_variant: Option<Value> = None;
    let mut full_variant_base = String::new();
    let mut transcode_at_load: Option<String> = None;
    if tier == TextureTier::UastcFull {
        let manifest_sha256 = source.sha256("3d/manifest.json").map(str::to_owned);
        let derived_uri = format!("derived/{FULL_GPU_VARIANT_ID}/manifest.json");
        let derived_base = format!("derived/{FULL_GPU_VARIANT_ID}/");
        let candidates = [
            (
                derived_uri.as_str(),
                derived_base.as_str(),
                derived_base.as_str(),
            ),
            ("3d/variants/manifest.json", "3d/", "3d/variants/"),
        ];
        let envelope = candidates
            .into_iter()
            .find(|(uri, _, _)| source.sha256(uri).is_some());
        match (manifest_sha256, envelope) {
            (Some(manifest_sha256), Some((envelope_uri, base, index_base))) => {
                let manifest = parse_json(source, envelope_uri)?;
                let entry = manifest
                    .get("variants")
                    .and_then(|v| v.get(FULL_GPU_VARIANT_ID));
                let index_uri = entry.map(|e| {
                    format!(
                        "{index_base}{}",
                        str_field(e, "file").unwrap_or("undefined")
                    )
                });
                match (entry, index_uri) {
                    (Some(entry), Some(index_uri)) => {
                        if str_field(&manifest, "sourceManifestSha256")
                            != Some(manifest_sha256.as_str())
                            || str_field(entry, "sourceManifestSha256")
                                != Some(manifest_sha256.as_str())
                        {
                            transcode_at_load = Some(format!(
                                "{FULL_GPU_VARIANT_ID} is bound to another manifest"
                            ));
                        } else if source.sha256(&index_uri) != str_field(entry, "outputSha256")
                            || source.sha256(&index_uri).is_none()
                        {
                            transcode_at_load = Some(format!(
                                "{FULL_GPU_VARIANT_ID} index is missing or its digest differs"
                            ));
                        } else {
                            let index = parse_json(source, &index_uri)?;
                            if index.get("schemaVersion").and_then(Value::as_f64) != Some(1.0)
                                || str_field(&index, "id") != Some(FULL_GPU_VARIANT_ID)
                                || str_field(&index, "sourceManifestSha256")
                                    != Some(manifest_sha256.as_str())
                            {
                                transcode_at_load =
                                    Some(format!("{FULL_GPU_VARIANT_ID} index is invalid"));
                            } else {
                                members.add("3d/manifest.json");
                                members.add(envelope_uri);
                                assert_safe_member_path(&index_uri)?;
                                members.add(&index_uri);
                                variant_digest = str_field(entry, "outputSha256")
                                    .unwrap_or_default()
                                    .to_owned();
                                full_variant = Some(index);
                                full_variant_base = base.to_owned();
                            }
                        }
                    }
                    _ => {
                        transcode_at_load =
                            Some(format!("closure has no {FULL_GPU_VARIANT_ID} variant"))
                    }
                }
            }
            _ => transcode_at_load = Some("closure has no texture variants".to_owned()),
        }
    }

    // Referenced image indices, in texture order, unique.
    let mut indices: Vec<JsValue> = Vec::new();
    for texture in document
        .get("textures")
        .and_then(JsValue::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
    {
        if let Some(index) = texture_image_index(texture) {
            if !indices.contains(&index) {
                indices.push(index);
            }
        }
    }
    let mut images = Vec::new();
    for index in &indices {
        let image_uri = image_at(document, index)
            .and_then(|image| image.get("uri"))
            .and_then(JsValue::as_str)
            .filter(|uri| !uri.is_empty() && !uri.starts_with("data:"))
            .ok_or_else(|| {
                PlanError::new("native_texture_external_image_required", index_label(index))
            })?;
        let mut uri = image_uri.to_owned();
        if let Some(variant) = &variant {
            let replacement = variant
                .get("images")
                .and_then(|i| i.get(format!("../{image_uri}")));
            let valid = replacement.filter(|r| {
                r.get("width")
                    .and_then(Value::as_f64)
                    .is_some_and(|w| w <= 512.0)
                    && r.get("height")
                        .and_then(Value::as_f64)
                        .is_some_and(|h| h <= 512.0)
                    && matches!(str_field(r, "codec"), Some("bc7") | Some("rgba"))
            });
            let replacement = valid
                .ok_or_else(|| PlanError::new("native_ml_texture_missing_or_invalid", image_uri))?;
            uri = format!(
                "3d/{}",
                str_field(replacement, "file").unwrap_or("undefined")
            );
            if Some(require(&mut members, &uri)?.as_str()) != str_field(replacement, "outputSha256")
            {
                return Err(PlanError::new("native_ml_texture_digest_mismatch", &uri));
            }
        }
        // A full GPU variant omits images that need no transcode (passthrough).
        if let Some(gpu) = full_variant
            .as_ref()
            .and_then(|v| v.get("images"))
            .and_then(|i| i.get(format!("../{image_uri}")))
        {
            let codec = str_field(gpu, "codec").unwrap_or("undefined");
            if !FULL_GPU_VARIANT_CODECS.contains(&codec) {
                return Err(PlanError::new(
                    "native_texture_variant_codec_invalid",
                    format!("{codec} for {image_uri}"),
                ));
            }
            uri = format!(
                "{full_variant_base}{}",
                str_field(gpu, "file").unwrap_or("undefined")
            );
            if Some(require(&mut members, &uri)?.as_str()) != str_field(gpu, "outputSha256") {
                return Err(PlanError::new(
                    "native_texture_variant_digest_mismatch",
                    &uri,
                ));
            }
        }
        require(&mut members, &uri)?;
        let slot = index.as_f64().expect("image_at accepted a numeric index") as usize;
        images.push((slot, uri));
    }
    for buffer in document
        .get("buffers")
        .and_then(JsValue::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
    {
        let uri = buffer
            .get("uri")
            .and_then(JsValue::as_str)
            .filter(|uri| !uri.is_empty() && !uri.starts_with("data:"))
            .ok_or_else(|| PlanError::bare("native_external_geometry_required"))?;
        require(&mut members, uri)?;
    }
    Ok(TexturePlan {
        members: members.0,
        images,
        variant_digest,
        variant: variant.is_some(),
        transcode_at_load,
    })
}

fn geometry_bytes(document: &JsValue) -> u64 {
    document
        .get("buffers")
        .and_then(JsValue::as_array)
        .map(|buffers| {
            buffers
                .iter()
                .map(|b| b.get("byteLength").and_then(JsValue::as_f64).unwrap_or(0.0) as u64)
                .sum()
        })
        .unwrap_or(0)
}

fn unique_images(plan: &TexturePlan) -> Vec<&str> {
    let mut out: Vec<&str> = Vec::new();
    for (_, uri) in &plan.images {
        if !out.contains(&uri.as_str()) {
            out.push(uri);
        }
    }
    out
}

fn texture_bytes(plan: &TexturePlan, path_of: impl Fn(&str) -> Option<PathBuf>) -> PlanResult<u64> {
    let mut total = 0;
    for uri in unique_images(plan) {
        let path =
            path_of(uri).ok_or_else(|| PlanError::new("native_texture_member_missing", uri))?;
        let header = ktx2::read_header(&path, 80).map_err(|e| {
            PlanError::new("native_texture_member_unreadable", format!("{uri}: {e}"))
        })?;
        total += ktx2::vram_bytes(&header, uri, plan.variant)?;
    }
    Ok(total)
}

/// Scene memory a map needs at one tier (`measureNativeTextureDemand`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextureDemand {
    pub texture_bytes: u64,
    pub geometry_bytes: u64,
    pub scene_bytes: u64,
}

pub fn measure_texture_demand(
    document: &JsValue,
    tier: TextureTier,
    closure: &MapClosure,
) -> PlanResult<TextureDemand> {
    let plan = plan_texture_members(document, tier, closure)?;
    let texture_bytes = texture_bytes(&plan, |uri| closure.path(uri).map(Path::to_path_buf))?;
    let geometry_bytes = geometry_bytes(document);
    Ok(TextureDemand {
        texture_bytes,
        geometry_bytes,
        scene_bytes: texture_bytes + geometry_bytes * 2 + SCENE_RESERVE_BYTES,
    })
}

/// `nativeSceneEstimateBytes`: the admission ESTIMATE of a job's device
/// memory (textures, geometry upload + expansion, frame attachments and a
/// 512 MiB reserve). Not a driver measurement.
pub fn scene_estimate_bytes(texture_bytes: u64, geometry_bytes: u64, frame_pixels: u64) -> u64 {
    texture_bytes + geometry_bytes * 2 + frame_pixels * 64 + SCENE_RESERVE_BYTES
}

/// `nativeStartupTimeoutMs`: the service start budget, scaled by the scene.
pub fn startup_timeout_ms(texture_bytes: u64, geometry_bytes: u64) -> u64 {
    let seconds = 300.0
        + 30.0 * (texture_bytes as f64 / 1024f64.powi(3))
        + 2.0 * (geometry_bytes as f64 / 1024f64.powi(2));
    simforge_core::math::js_round(seconds.min(1800.0) * 1000.0) as u64
}

/// `native_texture_capacity_exceeded`: demand over the declared capacity.
pub fn capacity_error(demand: u64, capacity: u64, source: CapacitySource) -> PlanError {
    PlanError::new(
        "native_texture_capacity_exceeded",
        format!(
            "calculated demand {demand} bytes exceeds {} capacity {capacity} bytes; declare a different ceiling with an explicit VRAM budget. This is a block-payload estimate, not measured driver allocation.",
            source.as_str()
        ),
    )
    .with_detail(json!({ "demandBytes": demand, "capacityBytes": capacity, "capacitySource": source.as_str() }))
}

/// `native_gpu_memory_insufficient`: the device cannot hold the scene.
/// `retryable` in the detail: false when even the whole device is too small.
pub fn gpu_memory_error(demand: u64, total: u64, free: u64, tier: TextureTier) -> PlanError {
    let gb = |bytes: u64| format!("{:.1}", bytes as f64 / 1024f64.powi(3));
    let advice = match tier {
        TextureTier::UastcFull => "Render at ML quality (512 px textures, about a fifth of the texture memory) or below 720p, or on a worker with more GPU memory.",
        TextureTier::Bc7_512 => "Render on a worker with more GPU memory.",
    };
    PlanError::new(
        "native_gpu_memory_insufficient",
        format!(
            "not enough GPU memory for this map at {} quality: the scene needs about {} GB and this worker has {} GB free of {} GB. {advice}",
            tier.as_str(),
            gb(demand),
            gb(free),
            gb(total)
        ),
    )
    .with_detail(json!({ "demandBytes": demand, "totalBytes": total, "freeBytes": free, "retryable": demand <= total }))
}

/// Where the admission capacity came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CapacitySource {
    /// An explicit budget (`nativeVramBudgetBytes`).
    Explicit,
    /// The device's reported memory.
    Measured,
    /// Neither: admission was skipped, and the run says so.
    Unmeasured,
}

impl CapacitySource {
    pub fn as_str(self) -> &'static str {
        match self {
            CapacitySource::Explicit => "explicit",
            CapacitySource::Measured => "measured",
            CapacitySource::Unmeasured => "unmeasured",
        }
    }
}

pub struct StageInput<'a> {
    pub closure: &'a MapClosure,
    pub render_textures: TextureTier,
    /// Sum of the rig's frame pixels (attachments and readback).
    pub frame_pixels: u64,
    /// An explicit budget; wins over the device.
    pub budget_bytes: Option<u64>,
    /// The device's total memory, when it was measured.
    pub device_capacity_bytes: Option<u64>,
    /// The cache root; default [`native_cache_root`].
    pub cache_directory: Option<PathBuf>,
    /// Further closure members staged beside the master at their map-relative
    /// paths (geometry LOD, road decals, luminaires); part of the key.
    pub extra_members: &'a [String],
    /// The caller checks capacity itself once residency is known.
    pub defer_capacity_check: bool,
}

/// The staged profile. Serialises to the TypeScript profile's fields.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextureProfile {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcode_at_load: Option<String>,
    pub master_path: PathBuf,
    pub render_textures: TextureTier,
    pub member_count: usize,
    pub texture_bytes: u64,
    pub geometry_bytes: u64,
    pub estimated_bytes: u64,
    pub budget_bytes: u64,
    pub capacity_bytes: Option<u64>,
    pub capacity_source: CapacitySource,
    pub cache_key: String,
    /// Reused a completed staging (its marker), rather than staging now.
    #[serde(skip)]
    pub reused: bool,
    /// `texture_tier_miss`, `gpu_memory_unmeasured`.
    #[serde(skip)]
    pub warnings: Vec<Warning>,
}

/// `SIMFORGE_NATIVE_CACHE_DIR`, `$SIMFORGE_CACHE_DIR/native-textures`, then
/// `${XDG_CACHE_HOME:-~/.cache}/simforge/native-textures` (the worker's
/// order), with the source that chose it.
pub fn native_cache_root() -> PlanResult<(PathBuf, &'static str)> {
    let env = |name: &str| {
        std::env::var_os(name)
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
    };
    if let Some(dir) = env("SIMFORGE_NATIVE_CACHE_DIR") {
        return Ok((dir, "env:SIMFORGE_NATIVE_CACHE_DIR"));
    }
    if let Some(dir) = env("SIMFORGE_CACHE_DIR") {
        return Ok((dir.join("native-textures"), "env:SIMFORGE_CACHE_DIR"));
    }
    let (base, source) = match env("XDG_CACHE_HOME") {
        Some(dir) => (dir, "env:XDG_CACHE_HOME"),
        None => (
            env("HOME")
                .ok_or_else(|| PlanError::bare("native_texture_cache_root_unknown"))?
                .join(".cache"),
            "home",
        ),
    };
    Ok((base.join("simforge").join("native-textures"), source))
}

const STAGED_MARKER: &str = ".staged.json";

fn read_marker(directory: &Path, identity: &str) -> Option<(u64, u64)> {
    let marker: Value =
        serde_json::from_slice(&std::fs::read(directory.join(STAGED_MARKER)).ok()?).ok()?;
    if str_field(&marker, "identity") != Some(identity) {
        return None;
    }
    let texture = marker.get("textureBytes")?.as_u64()?;
    let geometry = marker.get("geometryBytes")?.as_u64()?;
    directory
        .join(MASTER_PATH)
        .is_file()
        .then_some((texture, geometry))
}

fn unique_suffix() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("{}.{nanos:x}.{n}", std::process::id())
}

fn io_error(code: &'static str, what: &Path, e: std::io::Error) -> PlanError {
    PlanError::new(code, format!("{}: {e}", what.display()))
}

/// Publish `source` at `target` atomically through a same-directory temp.
fn copy_atomic(source: &Path, target: &Path) -> PlanResult<()> {
    let parent = target.parent().expect("staged members live under the tree");
    let temporary = parent.join(format!(".asset-{}", unique_suffix()));
    std::fs::create_dir_all(&temporary)
        .map_err(|e| io_error("native_texture_stage_failed", &temporary, e))?;
    let candidate = temporary.join("payload");
    let result = std::fs::copy(source, &candidate)
        .and_then(|_| std::fs::rename(&candidate, target))
        .map_err(|e| io_error("native_texture_stage_failed", target, e));
    let _ = std::fs::remove_dir_all(&temporary); // fallback-ok: best-effort removal of our own temp dir
    result
}

#[cfg(unix)]
fn same_file(a: &Path, b: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    match (std::fs::metadata(a), std::fs::metadata(b)) {
        (Ok(a), Ok(b)) => a.ino() == b.ino() && a.dev() == b.dev(),
        _ => false,
    }
}

#[cfg(not(unix))]
fn same_file(_: &Path, _: &Path) -> bool {
    false
}

fn link_member(uri: &str, source: &Path, sha256: &str, size: u64, target: &Path) -> PlanResult<()> {
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| io_error("native_texture_stage_failed", parent, e))?;
    }
    match std::fs::hard_link(source, target) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            // Already staged as a link to this very blob: nothing to prove again.
            if same_file(target, source) {
                return Ok(());
            }
            let (digest, bytes) = hash_file(target)
                .map_err(|e| io_error("native_texture_stage_failed", target, e))?;
            if digest != sha256 || bytes != size {
                return Err(PlanError::new("native_texture_cache_digest_mismatch", uri));
            }
            Ok(())
        }
        Err(e)
            if e.kind() == std::io::ErrorKind::CrossesDevices
                || e.kind() == std::io::ErrorKind::PermissionDenied =>
        {
            copy_atomic(source, target)
        }
        Err(e) => Err(io_error("native_texture_stage_failed", target, e)),
    }
}

/// `stageNativeTextureProfile`.
pub fn stage_texture_profile(input: StageInput<'_>) -> PlanResult<TextureProfile> {
    let closure = input.closure;
    let mut warnings = Vec::new();
    let (capacity, capacity_source) = match (input.budget_bytes, input.device_capacity_bytes) {
        (Some(budget), _) => (Some(budget), CapacitySource::Explicit),
        (None, Some(device)) => (Some(device), CapacitySource::Measured),
        (None, None) => {
            warnings.push(Warning {
                code: "gpu_memory_unmeasured",
                message: "device memory was not measured and no VRAM budget was given; the texture admission check was skipped".to_owned(),
            });
            (None, CapacitySource::Unmeasured)
        }
    };
    if capacity == Some(0) {
        return Err(PlanError::bare("native_vram_capacity_missing"));
    }
    let master = closure
        .member(MASTER_PATH)
        .expect("MapClosure always has its master");
    let text = std::fs::read_to_string(&master.path)
        .map_err(|e| io_error("native_texture_member_unreadable", &master.path, e))?;
    let mut document = JsValue::parse(&text).map_err(|e| {
        PlanError::new(
            "native_texture_master_invalid",
            format!("master.gltf is not JSON ({e})"),
        )
    })?;
    let plan = plan_texture_members(&document, input.render_textures, closure)?;
    if let Some(reason) = &plan.transcode_at_load {
        if input.render_textures == TextureTier::UastcFull {
            warnings.push(Warning {
                code: "texture_tier_miss",
                message: format!("uastc-full textures transcode at load: {reason}"),
            });
        }
    }

    // Selected members, insertion-ordered (a JS Map: re-setting keeps the slot).
    let mut selected: Vec<(String, &super::map_closure::Member)> = Vec::new();
    for uri in &plan.members {
        let member = closure
            .member(uri)
            .ok_or_else(|| PlanError::new("native_texture_member_missing", uri))?;
        selected.push((uri.clone(), member));
    }
    for uri in input.extra_members {
        assert_safe_member_path(uri)?;
        let member = closure
            .member(uri)
            .ok_or_else(|| PlanError::new("native_render_member_missing", uri))?;
        match selected.iter_mut().find(|(u, _)| u == uri) {
            Some(slot) => slot.1 = member,
            None => selected.push((uri.clone(), member)),
        }
    }
    let pairs = JsValue::Array(
        selected
            .iter()
            .map(|(uri, m)| JsValue::Array(vec![uri.as_str().into(), m.sha256.as_str().into()]))
            .collect(),
    );
    let preimage = JsValue::Array(vec![
        master.sha256.as_str().into(),
        input.render_textures.as_str().into(),
        plan.variant_digest.as_str().into(),
        pairs,
    ]);
    let identity = super::map_closure::sha256_hex(preimage.stringify().as_bytes());
    let cache_root = match input.cache_directory.clone() {
        Some(dir) => dir,
        None => native_cache_root()?.0,
    };
    let directory = cache_root.join(&identity);
    let master_path = directory.join(MASTER_PATH);

    let staged = read_marker(&directory, &identity);
    let (texture_bytes, geometry_bytes) = match staged {
        Some(bytes) => bytes,
        None => {
            let texture = texture_bytes(&plan, |uri| {
                selected
                    .iter()
                    .find(|(u, _)| u == uri)
                    .map(|(_, m)| m.path.clone())
            })?;
            for (index, uri) in &plan.images {
                let image = document
                    .get_mut("images")
                    .and_then(JsValue::as_array_mut)
                    .and_then(|images| images.get_mut(*index))
                    .expect("planned images exist");
                if image.get("uri").and_then(JsValue::as_str) != Some(uri.as_str()) {
                    image.set("uri", uri.as_str().into());
                    image.set("mimeType", "image/ktx2".into());
                }
            }
            (texture, geometry_bytes(&document))
        }
    };
    let estimated_bytes = scene_estimate_bytes(texture_bytes, geometry_bytes, input.frame_pixels);
    if let Some(capacity) = capacity {
        if !input.defer_capacity_check && estimated_bytes > capacity {
            return Err(capacity_error(estimated_bytes, capacity, capacity_source));
        }
    }
    let profile = TextureProfile {
        transcode_at_load: plan.transcode_at_load.clone(),
        master_path: master_path.clone(),
        render_textures: input.render_textures,
        member_count: selected.len() + 1,
        texture_bytes,
        geometry_bytes,
        estimated_bytes,
        budget_bytes: input.budget_bytes.unwrap_or(estimated_bytes),
        capacity_bytes: capacity,
        capacity_source,
        cache_key: identity.clone(),
        reused: staged.is_some(),
        warnings,
    };
    if staged.is_some() {
        return Ok(profile);
    }
    std::fs::create_dir_all(&directory)
        .map_err(|e| io_error("native_texture_stage_failed", &directory, e))?;
    for (uri, member) in &selected {
        let target = uri
            .split('/')
            .fold(directory.clone(), |p, part| p.join(part));
        link_member(uri, &member.path, &member.sha256, member.size, &target)?;
    }
    // Never modify the read-only installed master or a hardlink to it.
    let temporary = directory.join(format!(".master-{}", unique_suffix()));
    std::fs::create_dir_all(&temporary)
        .map_err(|e| io_error("native_texture_stage_failed", &temporary, e))?;
    let candidate = temporary.join(MASTER_PATH);
    let written = std::fs::write(&candidate, document.stringify())
        .and_then(|_| std::fs::rename(&candidate, &master_path))
        .map_err(|e| io_error("native_texture_stage_failed", &master_path, e));
    let _ = std::fs::remove_dir_all(&temporary); // fallback-ok: best-effort removal of our own temp dir
    written?;
    // Written last (temp + rename): its presence means the tree is complete.
    let marker = JsValue::Object(vec![
        ("identity".to_owned(), identity.as_str().into()),
        (
            "textureBytes".to_owned(),
            JsValue::Number(texture_bytes as f64),
        ),
        (
            "geometryBytes".to_owned(),
            JsValue::Number(geometry_bytes as f64),
        ),
    ]);
    let marker_tmp = directory.join(format!("{STAGED_MARKER}.{}.tmp", unique_suffix()));
    std::fs::write(&marker_tmp, marker.stringify())
        .and_then(|_| std::fs::rename(&marker_tmp, directory.join(STAGED_MARKER)))
        .map_err(|e| {
            io_error(
                "native_texture_stage_failed",
                &directory.join(STAGED_MARKER),
                e,
            )
        })?;
    Ok(profile)
}

#[cfg(test)]
mod tests;
