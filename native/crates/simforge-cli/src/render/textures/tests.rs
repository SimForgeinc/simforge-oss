//! Ported from `oss/packages/render/src/native/texture-profile.test.ts`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use super::*;
use crate::render::ktx2::MAGIC;
use crate::render::map_closure::{sha256_hex, Member};

fn header(size: u32, format: u32) -> Vec<u8> {
    let mut bytes = vec![0u8; 80];
    bytes[..12].copy_from_slice(&MAGIC);
    bytes[12..16].copy_from_slice(&format.to_le_bytes());
    bytes[20..24].copy_from_slice(&size.to_le_bytes());
    bytes[24..28].copy_from_slice(&size.to_le_bytes());
    bytes[36..40].copy_from_slice(&1u32.to_le_bytes());
    bytes[40..44].copy_from_slice(&1u32.to_le_bytes());
    bytes
}

struct Fixture {
    _dir: tempfile::TempDir,
    root: PathBuf,
    original: String,
    members: BTreeMap<String, Member>,
    cache: PathBuf,
}

impl Fixture {
    fn add(&mut self, relative: &str, bytes: &[u8]) -> String {
        let path = relative
            .split('/')
            .fold(self.root.clone(), |p, part| p.join(part));
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, bytes).unwrap();
        let sha256 = sha256_hex(bytes);
        self.members.insert(
            relative.to_owned(),
            Member {
                path,
                sha256: sha256.clone(),
                size: bytes.len() as u64,
            },
        );
        sha256
    }

    fn closure(&self) -> MapClosure {
        MapClosure::from_members(&self.root, self.members.clone()).unwrap()
    }
}

fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    let original = r#"{"buffers":[{"uri":"geometry.bin","byteLength":16}],"images":[{"uri":"images/not-installed.jpg"},{"uri":"images/full.ktx2"}],"textures":[{"source":0,"extensions":{"KHR_texture_basisu":{"source":1}}}]}"#.to_owned();
    let mut f = Fixture {
        cache: root.join("cache"),
        _dir: dir,
        root,
        original: original.clone(),
        members: BTreeMap::new(),
    };
    f.add("master.gltf", original.as_bytes());
    f.add("geometry.bin", &[0; 16]);
    f.add("images/full.ktx2", &header(1024, 0));
    let manifest = f.add("3d/manifest.json", b"{}");
    let image = f.add("3d/variants/objects/bc7.ktx2", &header(512, 145));
    let index = f.add(
        "3d/variants/bc7.json",
        format!(r#"{{"schemaVersion":1,"id":"textures-512-bc7","sourceManifestSha256":"{manifest}","images":{{"../images/full.ktx2":{{"file":"variants/objects/bc7.ktx2","outputSha256":"{image}","width":512,"height":512,"codec":"bc7"}}}}}}"#).as_bytes(),
    );
    f.add(
        "3d/variants/manifest.json",
        format!(r#"{{"sourceManifestSha256":"{manifest}","variants":{{"textures-512-bc7":{{"file":"bc7.json","outputSha256":"{index}","sourceManifestSha256":"{manifest}"}}}}}}"#).as_bytes(),
    );
    f
}

fn stage(
    f: &Fixture,
    closure: &MapClosure,
    tier: TextureTier,
    frame_pixels: u64,
    capacity: Option<u64>,
) -> PlanResult<TextureProfile> {
    stage_texture_profile(StageInput {
        closure,
        render_textures: tier,
        frame_pixels,
        budget_bytes: None,
        device_capacity_bytes: capacity,
        cache_directory: Some(f.cache.clone()),
        extra_members: &[],
        defer_capacity_check: false,
    })
}

const GIB16: u64 = 16 * 1024 * 1024 * 1024;

fn master_json(path: &Path) -> serde_json::Value {
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

#[test]
fn selects_the_basis_source_pins_bc7_and_leaves_the_installed_master_unchanged() {
    let f = fixture();
    let closure = f.closure();
    let full = stage(&f, &closure, TextureTier::UastcFull, 640 * 480, Some(GIB16)).unwrap();
    let ml = stage(&f, &closure, TextureTier::Bc7_512, 640 * 480, Some(GIB16)).unwrap();
    assert_eq!(full.texture_bytes, 1024 * 1024);
    assert_eq!(ml.texture_bytes, 512 * 512);
    assert_eq!(ml.budget_bytes, ml.estimated_bytes);
    assert_eq!(
        master_json(&ml.master_path)["images"][1]["uri"],
        "3d/variants/objects/bc7.ktx2"
    );
    assert_eq!(
        std::fs::read_to_string(f.root.join("master.gltf")).unwrap(),
        f.original
    );
    assert_eq!(
        std::fs::read_to_string(&full.master_path).unwrap(),
        f.original
    );
    assert_eq!(full.capacity_source, CapacitySource::Measured);
    assert_eq!(full.warnings[0].code, "texture_tier_miss");
}

#[test]
fn refuses_a_capacity_before_staging_and_exposes_demand_and_capacity() {
    let f = fixture();
    let error = stage(&f, &f.closure(), TextureTier::Bc7_512, 1920 * 1080, Some(1)).unwrap_err();
    assert_eq!(error.code, "native_texture_capacity_exceeded");
    let detail = error.detail.unwrap();
    assert_eq!(detail["capacityBytes"], 1);
    assert_eq!(detail["capacitySource"], "measured");
    assert_eq!(
        detail["demandBytes"],
        512 * 512 + 32 + 1920 * 1080 * 64 + 512 * 1024 * 1024
    );
    assert!(!f.cache.exists());
}

#[test]
fn an_unmeasured_device_skips_admission_and_says_so() {
    let f = fixture();
    let profile = stage(&f, &f.closure(), TextureTier::Bc7_512, 1920 * 1080, None).unwrap();
    assert_eq!(profile.capacity_source, CapacitySource::Unmeasured);
    assert_eq!(profile.capacity_bytes, None);
    assert!(profile
        .warnings
        .iter()
        .any(|w| w.code == "gpu_memory_unmeasured"));
    let json = serde_json::to_value(&profile).unwrap();
    assert_eq!(json["capacitySource"], "unmeasured");
    assert_eq!(json["capacityBytes"], serde_json::Value::Null);
}

#[test]
fn reuses_the_cache_across_simultaneous_stagings_without_partial_files() {
    let f = fixture();
    let closure = f.closure();
    let (a, b) = std::thread::scope(|scope| {
        let a = scope
            .spawn(|| stage(&f, &closure, TextureTier::Bc7_512, 1280 * 720, Some(GIB16)).unwrap());
        let b = scope
            .spawn(|| stage(&f, &closure, TextureTier::Bc7_512, 1280 * 720, Some(GIB16)).unwrap());
        (a.join().unwrap(), b.join().unwrap())
    });
    assert_eq!(a.master_path, b.master_path);
    assert_eq!(
        master_json(&a.master_path)["buffers"][0]["uri"],
        "geometry.bin"
    );
    assert_eq!(
        std::fs::read(a.master_path.parent().unwrap().join("geometry.bin")).unwrap(),
        vec![0u8; 16]
    );
}

#[test]
fn a_cross_filesystem_copy_publishes_the_same_tree() {
    let f = fixture();
    let closure = f.closure();
    let source = &closure.members["geometry.bin"];
    let target = f.root.join("elsewhere/geometry.bin");
    std::fs::create_dir_all(target.parent().unwrap()).unwrap();
    copy_atomic(&source.path, &target).unwrap();
    assert_eq!(std::fs::read(&target).unwrap(), vec![0u8; 16]);
    assert_eq!(
        std::fs::read_dir(target.parent().unwrap()).unwrap().count(),
        1,
        "no temp left behind"
    );
    // A staged file with other bytes is refused, never overwritten.
    std::fs::write(&target, [9u8; 16]).unwrap();
    let error = link_member(
        "geometry.bin",
        &source.path,
        &source.sha256,
        source.size,
        &target,
    )
    .unwrap_err();
    assert_eq!(error.code, "native_texture_cache_digest_mismatch");
}

#[test]
fn selects_exactly_one_tier_before_any_texture_is_read() {
    let f = fixture();
    let closure = f.closure();
    let document = JsValue::parse(&f.original).unwrap();
    let full = plan_texture_members(&document, TextureTier::UastcFull, &closure).unwrap();
    let mut members = full.members.clone();
    members.sort();
    assert_eq!(members, ["geometry.bin", "images/full.ktx2"]);
    let ml = plan_texture_members(&document, TextureTier::Bc7_512, &closure).unwrap();
    assert_eq!(
        ml.members,
        [
            "3d/manifest.json",
            "3d/variants/manifest.json",
            "3d/variants/bc7.json",
            "3d/variants/objects/bc7.ktx2",
            "geometry.bin"
        ]
    );
    // Staging succeeds from the selected members alone.
    let selected: BTreeMap<String, Member> = f
        .members
        .iter()
        .filter(|(k, _)| k.as_str() == "master.gltf" || full.members.contains(k))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    let closure = MapClosure::from_members(&f.root, selected).unwrap();
    assert_eq!(
        stage(&f, &closure, TextureTier::UastcFull, 640 * 480, Some(GIB16))
            .unwrap()
            .texture_bytes,
        1024 * 1024
    );
}

#[test]
fn a_completed_staging_is_reused_from_its_marker() {
    let f = fixture();
    let closure = f.closure();
    let first = stage(&f, &closure, TextureTier::UastcFull, 640 * 480, Some(GIB16)).unwrap();
    std::fs::remove_file(f.root.join("images/full.ktx2")).unwrap();
    let second = stage(&f, &closure, TextureTier::UastcFull, 640 * 480, Some(GIB16)).unwrap();
    assert!(second.reused && !first.reused);
    assert_eq!(
        (
            second.master_path.clone(),
            second.cache_key.clone(),
            second.texture_bytes
        ),
        (
            first.master_path.clone(),
            first.cache_key.clone(),
            first.texture_bytes
        )
    );
    assert_eq!(
        std::fs::read(first.master_path.parent().unwrap().join("images/full.ktx2"))
            .unwrap()
            .len(),
        80
    );
    assert_eq!(
        stage(&f, &closure, TextureTier::UastcFull, 640 * 480, Some(1024))
            .unwrap_err()
            .code,
        "native_texture_capacity_exceeded"
    );
}

#[test]
fn measures_per_tier_scene_memory_matching_what_staging_admits() {
    let f = fixture();
    let closure = f.closure();
    let document = JsValue::parse(&f.original).unwrap();
    let full = measure_texture_demand(&document, TextureTier::UastcFull, &closure).unwrap();
    let ml = measure_texture_demand(&document, TextureTier::Bc7_512, &closure).unwrap();
    assert_eq!(full.texture_bytes, 1024 * 1024);
    assert_eq!(ml.texture_bytes, 512 * 512);
    let staged = stage(&f, &closure, TextureTier::UastcFull, 0, Some(GIB16)).unwrap();
    assert_eq!(full.scene_bytes, staged.estimated_bytes);
}

#[test]
fn refuses_fast_with_advice_when_the_device_cannot_hold_the_scene() {
    let gib = 1024u64.pow(3);
    let error = gpu_memory_error(7 * gib, 10 * gib, 3 * gib, TextureTier::UastcFull);
    assert!(
        error
            .message
            .contains("needs about 7.0 GB and this worker has 3.0 GB free of 10.0 GB"),
        "{}",
        error.message
    );
    assert!(error.message.contains("ML quality"));
    assert_eq!(error.detail.unwrap()["retryable"], true);
    assert_eq!(
        gpu_memory_error(12 * gib, 10 * gib, 9 * gib, TextureTier::UastcFull)
            .detail
            .unwrap()["retryable"],
        false
    );
    assert_eq!(startup_timeout_ms(0, 0), 300_000);
    assert!(startup_timeout_ms(5_480_000_000, 143_000_000) > 600_000);
    assert_eq!(
        startup_timeout_ms(1_000_000_000_000, 1_000_000_000_000),
        1_800_000
    );
}

fn full_gpu_header() -> Vec<u8> {
    header(1024, 145)
}

#[test]
fn uastc_full_uploads_ingest_built_gpu_blocks_else_reports_a_load_time_transcode() {
    let mut f = fixture();
    let miss = stage(&f, &f.closure(), TextureTier::UastcFull, 0, Some(GIB16)).unwrap();
    assert_eq!(
        miss.transcode_at_load.as_deref(),
        Some("closure has no textures-full-bc7 variant")
    );
    assert_eq!(
        master_json(&miss.master_path)["images"][1]["uri"],
        "images/full.ktx2"
    );

    let manifest = f.members["3d/manifest.json"].sha256.clone();
    let gpu = f.add("3d/variants/objects/full-bc7.ktx2", &full_gpu_header());
    let index = f.add(
        "3d/variants/full-bc7.json",
        format!(r#"{{"schemaVersion":1,"id":"textures-full-bc7","sourceManifestSha256":"{manifest}","images":{{"../images/full.ktx2":{{"file":"variants/objects/full-bc7.ktx2","outputSha256":"{gpu}","width":1024,"height":1024,"codec":"bc7"}}}}}}"#).as_bytes(),
    );
    let mut variants: serde_json::Value = serde_json::from_slice(
        &std::fs::read(&f.members["3d/variants/manifest.json"].path).unwrap(),
    )
    .unwrap();
    variants["variants"]["textures-full-bc7"] = serde_json::json!({ "file": "full-bc7.json", "outputSha256": index, "sourceManifestSha256": manifest });
    f.add("3d/variants/manifest.json", variants.to_string().as_bytes());
    let closure = f.closure();

    let plan = plan_texture_members(
        &JsValue::parse(&f.original).unwrap(),
        TextureTier::UastcFull,
        &closure,
    )
    .unwrap();
    assert_eq!(plan.transcode_at_load, None);
    assert!(plan
        .members
        .iter()
        .any(|m| m == "3d/variants/objects/full-bc7.ktx2"));
    assert!(!plan.members.iter().any(|m| m == "images/full.ktx2"));
    let hit = stage(&f, &closure, TextureTier::UastcFull, 0, Some(GIB16)).unwrap();
    assert_eq!(hit.transcode_at_load, None);
    assert!(hit.warnings.iter().all(|w| w.code != "texture_tier_miss"));
    let image = &master_json(&hit.master_path)["images"][1];
    assert_eq!(image["uri"], "3d/variants/objects/full-bc7.ktx2");
    assert_eq!(image["mimeType"], "image/ktx2");
    assert_eq!(hit.texture_bytes, miss.texture_bytes);
    assert_ne!(hit.cache_key, miss.cache_key);
}

#[test]
fn finds_the_gpu_variant_in_derived_before_3d_variants() {
    let mut f = fixture();
    let manifest = f.members["3d/manifest.json"].sha256.clone();
    let bytes = full_gpu_header();
    let gpu = f.add("derived/textures-full-bc7/objects/abc.ktx2", &bytes);
    let index = f.add(
        "derived/textures-full-bc7/index-1.json",
        format!(r#"{{"schemaVersion":1,"id":"textures-full-bc7","sourceManifestSha256":"{manifest}","images":{{"../images/full.ktx2":{{"file":"objects/abc.ktx2","outputSha256":"{gpu}","width":1024,"height":1024,"codec":"bc7"}}}}}}"#).as_bytes(),
    );
    f.add(
        "derived/textures-full-bc7/manifest.json",
        format!(r#"{{"schema":"simforge.map-texture-variant.v1","sourceManifestSha256":"{manifest}","variants":{{"textures-full-bc7":{{"file":"index-1.json","outputSha256":"{index}","sourceManifestSha256":"{manifest}"}}}}}}"#).as_bytes(),
    );
    let staged = stage(&f, &f.closure(), TextureTier::UastcFull, 0, Some(GIB16)).unwrap();
    assert_eq!(staged.transcode_at_load, None);
    assert_eq!(
        master_json(&staged.master_path)["images"][1]["uri"],
        "derived/textures-full-bc7/objects/abc.ktx2"
    );
    assert_eq!(
        std::fs::read(
            staged
                .master_path
                .parent()
                .unwrap()
                .join("derived/textures-full-bc7/objects/abc.ktx2")
        )
        .unwrap(),
        bytes
    );
}

#[test]
fn extra_members_are_staged_and_keyed() {
    let mut f = fixture();
    f.add("derived/road-decals/manifest.json", b"{}");
    let closure = f.closure();
    let plain = stage(&f, &closure, TextureTier::UastcFull, 0, Some(GIB16)).unwrap();
    let extra = [
        "derived/road-decals/manifest.json".to_owned(),
        "geometry.bin".to_owned(),
    ];
    let with = stage_texture_profile(StageInput {
        closure: &closure,
        render_textures: TextureTier::UastcFull,
        frame_pixels: 0,
        budget_bytes: Some(GIB16),
        device_capacity_bytes: None,
        cache_directory: Some(f.cache.clone()),
        extra_members: &extra,
        defer_capacity_check: false,
    })
    .unwrap();
    assert_ne!(plain.cache_key, with.cache_key);
    assert_eq!(
        with.member_count,
        plain.member_count + 1,
        "geometry.bin keeps its slot"
    );
    assert_eq!(with.capacity_source, CapacitySource::Explicit);
    assert!(with
        .master_path
        .parent()
        .unwrap()
        .join("derived/road-decals/manifest.json")
        .is_file());
    let missing = ["derived/nope.json".to_owned()];
    let error = stage_texture_profile(StageInput {
        closure: &closure,
        render_textures: TextureTier::UastcFull,
        frame_pixels: 0,
        budget_bytes: None,
        device_capacity_bytes: None,
        cache_directory: Some(f.cache.clone()),
        extra_members: &missing,
        defer_capacity_check: false,
    })
    .unwrap_err();
    assert_eq!(
        error.message,
        "native_render_member_missing: derived/nope.json"
    );
}
