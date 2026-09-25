//! The texture planners against the TypeScript native engine.
//!
//! `fixtures/render-textures/mini-yale` is a small closure cut from the
//! installed yale-street@v2 native profile: its real 3d/manifest.json, the
//! first three textures with their real KTX2 headers and 512 px BC7
//! variants, and 400 real accessors (written with Python's float repr, so
//! the staged master exercises JavaScript number formatting).
//! `ts-golden.json` is what the TypeScript engine produced for it
//! (`golden.mts`, run with tsx against oss/packages/render/src/native).
//!
//! The `#[ignore]`d test repeats the comparison on a whole installed map:
//!
//! ```sh
//! tsx fixtures/render-textures/golden.mts <repo> <map dir> <cache dir> ts-golden.json
//! SIMFORGE_CLI_TEST_NATIVE_MAP=~/.local/share/simforge/maps/.corpus/yale-street \
//! SIMFORGE_CLI_TEST_TS_GOLDEN=ts-golden.json \
//!   cargo test -p simforge --test render_textures -- --ignored
//! ```
//!
//! Its staging cache is created next to the golden file, so it can hold
//! hard links to the map when both are on one filesystem.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use simforge_cli::render::geometry_lod::{plan_geometry_lod, GeometryLodMode};
use simforge_cli::render::jsjson::JsValue;
use simforge_cli::render::map_closure::{sha256_hex, MapClosure};
use simforge_cli::render::residency::{
    corner_focal_px, plan_texture_density, texture_residency_levels, DensityImage, ResidencyCamera,
};
use simforge_cli::render::road_decals::plan_road_decals;
use simforge_cli::render::textures::{
    plan_texture_members, stage_texture_profile, StageInput, TextureTier,
};

fn env_path(name: &str) -> PathBuf {
    PathBuf::from(
        std::env::var_os(name).unwrap_or_else(|| panic!("set {name} (see the module docs)")),
    )
}

fn tree(dir: &Path, base: &Path, out: &mut Vec<String>) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            tree(&path, base, out);
        } else {
            out.push(
                path.strip_prefix(base)
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
            );
        }
    }
}

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/render-textures")
}

#[test]
fn stages_the_same_tree_as_the_typescript_engine_on_the_fixture() {
    let cache = tempfile::tempdir().unwrap();
    check_stage(
        &fixtures().join("mini-yale"),
        &fixtures().join("ts-golden.json"),
        cache.path(),
    );
}

#[test]
fn residency_levels_match_the_typescript_engine_on_the_fixture() {
    check_residency(&fixtures().join("ts-golden.json"));
}

#[test]
#[ignore = "needs an installed native map and its TypeScript golden (SIMFORGE_CLI_TEST_NATIVE_MAP, SIMFORGE_CLI_TEST_TS_GOLDEN)"]
fn stages_the_same_tree_as_the_typescript_engine_on_an_installed_map() {
    let golden_path = env_path("SIMFORGE_CLI_TEST_TS_GOLDEN");
    let cache = tempfile::tempdir_in(golden_path.parent().unwrap()).unwrap();
    check_stage(
        &env_path("SIMFORGE_CLI_TEST_NATIVE_MAP"),
        &golden_path,
        cache.path(),
    );
    check_residency(&golden_path);
}

fn check_stage(map: &Path, golden_path: &Path, cache: &Path) {
    let golden: Value = serde_json::from_slice(&std::fs::read(golden_path).unwrap()).unwrap();
    let closure = MapClosure::open(map).unwrap();
    let master =
        JsValue::parse(&std::fs::read_to_string(closure.path("master.gltf").unwrap()).unwrap())
            .unwrap();

    for tier in [TextureTier::UastcFull, TextureTier::Bc7_512] {
        let expected = &golden[tier.as_str()];
        let plan = plan_texture_members(&master, tier, &closure).unwrap();
        assert_eq!(
            json!(plan.members),
            expected["planMembers"],
            "{tier:?} plan members (order included)"
        );
        let first: Vec<Value> = plan
            .images
            .iter()
            .take(50)
            .map(|(i, u)| json!([i, u]))
            .collect();
        assert_eq!(json!(first), expected["planImages"], "{tier:?} plan images");
        assert_eq!(
            plan.images.len() as u64,
            expected["planImageCount"].as_u64().unwrap()
        );
        assert_eq!(
            plan.variant_digest,
            expected["variantDigest"].as_str().unwrap()
        );
        assert_eq!(json!(plan.transcode_at_load), expected["transcodeAtLoad"]);

        let profile = stage_texture_profile(StageInput {
            closure: &closure,
            render_textures: tier,
            frame_pixels: 1920 * 1080,
            budget_bytes: None,
            device_capacity_bytes: Some(64 * 1024 * 1024 * 1024),
            cache_directory: Some(cache.join(tier.as_str())),
            extra_members: &[],
            defer_capacity_check: false,
        })
        .unwrap();
        for key in [
            "cacheKey",
            "textureBytes",
            "geometryBytes",
            "estimatedBytes",
            "memberCount",
        ] {
            assert_eq!(
                serde_json::to_value(&profile).unwrap()[key],
                expected[key],
                "{tier:?} {key}"
            );
        }
        let dir = profile.master_path.parent().unwrap();
        let staged = std::fs::read(&profile.master_path).unwrap();
        if sha256_hex(&staged) != expected["stagedMasterSha256"].as_str().unwrap() {
            // Leave the bytes beside the golden for a diff.
            std::fs::write(
                golden_path.with_file_name(format!("rust-{}-master.gltf", tier.as_str())),
                &staged,
            )
            .unwrap();
        }
        assert_eq!(
            sha256_hex(&staged),
            expected["stagedMasterSha256"].as_str().unwrap(),
            "{tier:?} staged master bytes"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join(".staged.json")).unwrap(),
            expected["marker"].as_str().unwrap()
        );
        let mut files = Vec::new();
        tree(dir, dir, &mut files);
        files.sort();
        assert_eq!(files.len() as u64, expected["fileCount"].as_u64().unwrap());
        assert_eq!(
            sha256_hex(files.join("\n").as_bytes()),
            expected["files"].as_str().unwrap(),
            "{tier:?} staged file list"
        );
    }
    let lod = plan_geometry_lod(GeometryLodMode::Auto, &closure).unwrap();
    assert_eq!(lod.is_none(), golden["geometryLod"].is_null());
    assert_eq!(
        plan_road_decals(&closure).unwrap().is_none(),
        golden["roadDecals"].is_null()
    );
    assert_eq!(
        plan_texture_density(&closure).unwrap().is_none(),
        golden["textureDensity"].is_null()
    );
}

fn check_residency(golden_path: &Path) {
    let golden: Value = serde_json::from_slice(&std::fs::read(golden_path).unwrap()).unwrap();
    let r = &golden["residency"];
    let images: Vec<DensityImage> = r["images"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| DensityImage {
            uri: i["uri"].as_str().unwrap().to_owned(),
            width: i["width"].as_u64().unwrap() as u32,
            height: i["height"].as_u64().unwrap() as u32,
            uses: i["uses"]
                .as_array()
                .unwrap()
                .iter()
                .map(|u| std::array::from_fn(|k| u[k].as_f64().unwrap()))
                .collect(),
        })
        .collect();
    let frames: Vec<Vec<ResidencyCamera>> = r["frames"]
        .as_array()
        .unwrap()
        .iter()
        .map(|cams| {
            cams.as_array()
                .unwrap()
                .iter()
                .map(|c| ResidencyCamera {
                    eye: std::array::from_fn(|k| c["eye"][k].as_f64().unwrap()),
                    width: c["width"].as_u64().unwrap() as u32,
                    height: c["height"].as_u64().unwrap() as u32,
                    fov_deg: c["fovDeg"].as_f64().unwrap(),
                })
                .collect()
        })
        .collect();
    let focal: Vec<f64> = frames[0].iter().map(corner_focal_px).collect();
    assert_eq!(
        json!(focal),
        r["focal"],
        "corner focal lengths, bit for bit"
    );
    let levels = texture_residency_levels(&images, &frames, r["nearM"].as_f64().unwrap()).unwrap();
    assert_eq!(serde_json::to_value(&levels).unwrap(), r["levels"]);
}
