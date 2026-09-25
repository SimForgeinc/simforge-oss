//! The Rust ports in `src/render/` against golden outputs of the TypeScript
//! reference (`tests/fixtures/render/generate-goldens.mts`): byte-identical
//! lidar/radar rasterisation, the exact ffmpeg argument vectors, codec
//! assignment, fixed schedules and the sensor video format. Plus the actor
//! closure store, verified and laid out as the platform does.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use simforge_cli::render::actor_assets::{self, ActorAppearance, SensorHost};
use simforge_cli::render::schedule::{
    assert_video_profile_supported, locale_compare, sensor_video_format, union_frame_micros,
    CameraFormat, FixedSchedule, VideoProfile,
};
use simforge_cli::render::sensor_video::{
    parse_lidar_ply, parse_radar_csv, LidarVideoRasterizer, RadarVideoRasterizer,
};
use simforge_cli::render::video::{
    assign_video_codecs, encoder_codec_args, ffmpeg_encode_args, VideoCodec,
    VideoEncoderPreference, VideoFormat,
};

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/render")
}

fn goldens() -> Value {
    serde_json::from_slice(&std::fs::read(fixtures().join("goldens.json")).unwrap()).unwrap()
}

fn sha(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn f32_bytes(values: &[f32]) -> Vec<u8> {
    values.iter().flat_map(|v| v.to_le_bytes()).collect()
}

#[test]
fn lidar_frames_are_byte_identical_to_the_typescript() {
    for case in goldens()["lidar"].as_array().unwrap() {
        let payload = std::fs::read(fixtures().join(case["payload"].as_str().unwrap())).unwrap();
        let scan = parse_lidar_ply(&payload, "lidar").unwrap();
        assert_eq!(scan.count as u64, case["count"].as_u64().unwrap());
        assert_eq!(sha(&f32_bytes(&scan.xyz)), case["xyzSha256"], "{case}");
        assert_eq!(
            sha(&f32_bytes(&scan.intensity)),
            case["intensitySha256"],
            "{case}"
        );
        let mut raster = LidarVideoRasterizer::new(
            case["width"].as_u64().unwrap() as u32,
            case["height"].as_u64().unwrap() as u32,
            case["rangeM"].as_f64().unwrap(),
            case["mountHeightM"].as_f64().unwrap(),
        )
        .unwrap();
        let first = sha(raster.frame(&scan));
        assert_eq!(first, case["rgbaSha256"], "{case}");
        // The buffer is reused: a second frame is the same bytes.
        assert_eq!(sha(raster.frame(&scan)), first);
    }
}

#[test]
fn radar_frames_are_byte_identical_to_the_typescript() {
    for case in goldens()["radar"].as_array().unwrap() {
        let payload = std::fs::read(fixtures().join(case["payload"].as_str().unwrap())).unwrap();
        let scan = parse_radar_csv(&payload, "radar").unwrap();
        assert_eq!(scan.count as u64, case["count"].as_u64().unwrap());
        let fields: Vec<u8> = [
            &scan.depth_m,
            &scan.azimuth_rad,
            &scan.altitude_rad,
            &scan.velocity_mps,
        ]
        .iter()
        .flat_map(|v| f32_bytes(v))
        .collect();
        assert_eq!(sha(&fields), case["fieldsSha256"], "{case}");
        let mut raster = RadarVideoRasterizer::new(
            case["width"].as_u64().unwrap() as u32,
            case["height"].as_u64().unwrap() as u32,
            case["horizontalFovDeg"].as_f64().unwrap(),
            case["rangeM"].as_f64().unwrap(),
        )
        .unwrap();
        assert_eq!(sha(raster.frame(&scan)), case["rgbaSha256"], "{case}");
    }
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|s| s.as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn ffmpeg_argument_vectors_are_the_typescript_ones() {
    let g = goldens();
    let f = &g["ffmpeg"];
    assert_eq!(
        encoder_codec_args(VideoCodec::Libx264),
        strings(&f["libx264CodecArgs"])
    );
    assert_eq!(
        encoder_codec_args(VideoCodec::H264Nvenc),
        strings(&f["nvencCodecArgs"])
    );
    let hd = VideoFormat {
        width: 1920,
        height: 1080,
        frames_per_second: 29.97,
    };
    assert_eq!(
        ffmpeg_encode_args(VideoCodec::Libx264, hd, "/out/video/cam front.mp4"),
        strings(&f["libx264EncodeArgs"])
    );
    let small = VideoFormat {
        width: 640,
        height: 360,
        frames_per_second: 10.0,
    };
    assert_eq!(
        ffmpeg_encode_args(VideoCodec::H264Nvenc, small, "/out/v.mp4"),
        strings(&f["nvencEncodeArgs"])
    );
    let ids = |n: usize| {
        ["a", "b", "c", "d"][..n]
            .iter()
            .map(|s| s.to_string())
            .collect::<Vec<_>>()
    };
    let names = |v: Vec<(String, VideoCodec)>| {
        v.into_iter()
            .map(|(_, c)| c.as_str().to_owned())
            .collect::<Vec<_>>()
    };
    assert_eq!(
        names(assign_video_codecs(&ids(4), VideoEncoderPreference::Auto, true, 2).unwrap()),
        strings(&f["assign"]["auto2"])
    );
    assert_eq!(
        names(assign_video_codecs(&ids(2), VideoEncoderPreference::Auto, false, 8).unwrap()),
        strings(&f["assign"]["autoNoNvenc"])
    );
    assert_eq!(
        names(
            assign_video_codecs(
                &ids(2),
                VideoEncoderPreference::Fixed(VideoCodec::Libx264),
                true,
                8
            )
            .unwrap()
        ),
        strings(&f["assign"]["libx264"])
    );
}

#[test]
fn schedules_and_the_sensor_video_format_are_the_typescript_ones() {
    for case in goldens()["schedules"].as_array().unwrap() {
        let clip = &case["clip"];
        let (start, end) = (
            clip["startSeconds"].as_f64().unwrap(),
            clip["endSeconds"].as_f64().unwrap(),
        );
        let mut schedules = Vec::new();
        let mut cameras = Vec::new();
        for source in case["sources"].as_array().unwrap() {
            let name = source["outputName"].as_str().unwrap();
            let rate = match source["modality"].as_str().unwrap() {
                "rgb" => {
                    cameras.push(CameraFormat {
                        output_name: name.into(),
                        width: source["attributes"]["width"].as_u64().unwrap() as u32,
                        height: source["attributes"]["height"].as_u64().unwrap() as u32,
                    });
                    source["attributes"]["fps"].as_f64().unwrap()
                }
                "lidar" => source["attributes"]["rotationFrequencyHz"]
                    .as_f64()
                    .unwrap(),
                _ => case["fps"].as_f64().unwrap(),
            };
            schedules.push(FixedSchedule::new(name, start, end, rate).unwrap());
        }
        for (schedule, expected) in schedules.iter().zip(case["schedules"].as_array().unwrap()) {
            assert_eq!(schedule.source_id, expected["sourceId"]);
            assert_eq!(
                schedule.frame_count,
                expected["frameCount"].as_u64().unwrap(),
                "{}",
                case["name"]
            );
            let micros: Vec<i64> = expected["micros"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_i64().unwrap())
                .collect();
            assert_eq!(schedule.frame_micros(), micros, "{}", case["name"]);
        }
        let camera_schedules: Vec<&FixedSchedule> = schedules
            .iter()
            .filter(|s| cameras.iter().any(|c| c.output_name == s.source_id))
            .collect();
        let union: Vec<i64> = case["unionMicros"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_i64().unwrap())
            .collect();
        assert_eq!(union_frame_micros(camera_schedules), union);
        let format = sensor_video_format(&cameras, &schedules).unwrap();
        let expected = &case["sensorVideoFormat"];
        assert_eq!(format.width as u64, expected["width"].as_u64().unwrap());
        assert_eq!(format.height as u64, expected["height"].as_u64().unwrap());
        assert_eq!(
            format.frames_per_second,
            expected["framesPerSecond"].as_f64().unwrap()
        );
        assert_eq!(format.frame_count, expected["frameCount"].as_u64().unwrap());
    }
}

#[test]
fn sensor_ids_sort_like_locale_compare() {
    // Node 22 (ICU root): `[...].sort((a, b) => a.localeCompare(b))`.
    let mut ids = [
        "cam_a",
        "cam-b",
        "Cam-a",
        "cam-a",
        "cama",
        "cam1",
        "cam10",
        "cam2",
        "front",
        "Front",
        "rear-left",
        "rear_left",
        "rearLeft",
    ];
    ids.sort_by(|a, b| locale_compare(a, b));
    assert_eq!(
        ids,
        [
            "cam_a",
            "cam-a",
            "Cam-a",
            "cam-b",
            "cam1",
            "cam10",
            "cam2",
            "cama",
            "front",
            "Front",
            "rear_left",
            "rear-left",
            "rearLeft"
        ]
    );
}

#[test]
fn video_profiles_outside_mp4_h264_lossy_are_refused() {
    let profile = |c: &str, k: &str, q: Option<&str>| VideoProfile {
        container: c.into(),
        codec: k.into(),
        quality: q.map(Into::into),
    };
    assert!(assert_video_profile_supported(None).is_ok());
    assert!(assert_video_profile_supported(Some(&profile("mp4", "h264", Some("high")))).is_ok());
    assert_eq!(
        assert_video_profile_supported(Some(&profile("webm", "vp9", None)))
            .unwrap_err()
            .code,
        "native_video_profile_unsupported"
    );
    assert_eq!(
        assert_video_profile_supported(Some(&profile("mp4", "h264", Some("lossless"))))
            .unwrap_err()
            .code,
        "native_video_quality_unsupported"
    );
}

// ------------------------------------------------------------------ actor assets

/// A store laid out as `simforge assets pull` writes it; returns (root, digest).
fn store(members: &[(&str, &[u8])]) -> (tempfile::TempDir, String) {
    let root = tempfile::tempdir().unwrap();
    let mut listed = serde_json::Map::new();
    for (path, bytes) in members {
        let digest = sha(bytes);
        let blob = root
            .path()
            .join("blobs/sha256")
            .join(&digest[..2])
            .join(&digest);
        std::fs::create_dir_all(blob.parent().unwrap()).unwrap();
        std::fs::write(&blob, bytes).unwrap();
        listed.insert(
            (*path).into(),
            json!({ "bytes": bytes.len(), "sha256": digest }),
        );
    }
    let document = serde_json::to_vec(
        &json!({ "members": listed, "schema": "simforge.actor-assets-closure/v1" }),
    )
    .unwrap();
    let digest = sha(&document);
    std::fs::create_dir_all(root.path().join("closures")).unwrap();
    std::fs::write(
        root.path().join(format!("closures/{digest}.json")),
        &document,
    )
    .unwrap();
    (root, digest)
}

const SEDAN_GLB: &[u8] = b"glb:vehicle.sedan";
const CATALOG: &str = r#"{"vehicle.sedan":{"model":{"glbPath":"models/vehicle.sedan/model.glb"},"tintable":true,"scaleToDims":false}}"#;

#[test]
fn ensures_the_closure_as_a_hard_linked_tree_and_binds_verified_models() {
    let (root, digest) = store(&[
        ("catalog-models.json", CATALOG.as_bytes()),
        ("models/vehicle.sedan/model.glb", SEDAN_GLB),
    ]);
    let assets = actor_assets::ensure_actor_assets(root.path(), &digest, None, None).unwrap();
    assert_eq!(assets.closure.digest, digest);
    assert_eq!(assets.directory, root.path().join("trees").join(&digest));
    assert_eq!(
        std::fs::read(assets.directory.join("models/vehicle.sedan/model.glb")).unwrap(),
        SEDAN_GLB
    );
    assert_eq!(assets.models.keys().collect::<Vec<_>>(), ["vehicle.sedan"]);
    assert_eq!(
        (assets.linked_files, assets.copied_files, assets.reused_tree),
        (2, 0, false)
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let blob = root
            .path()
            .join("blobs/sha256")
            .join(&sha(SEDAN_GLB)[..2])
            .join(sha(SEDAN_GLB));
        let tree = assets.directory.join("models/vehicle.sedan/model.glb");
        assert_eq!(
            std::fs::metadata(tree).unwrap().ino(),
            std::fs::metadata(blob).unwrap().ino()
        );
    }
    // A second render reuses the tree without laying it out again.
    let again = actor_assets::ensure_actor_assets(root.path(), &digest, None, None).unwrap();
    assert!(again.reused_tree);
    assert_eq!(again.linked_files, 0);
}

#[test]
fn refuses_a_closure_whose_bytes_are_not_the_declared_identity_or_size() {
    let (root, digest) = store(&[
        ("catalog-models.json", CATALOG.as_bytes()),
        ("models/vehicle.sedan/model.glb", SEDAN_GLB),
    ]);
    let wrong = "f".repeat(64);
    std::fs::copy(
        root.path().join(format!("closures/{digest}.json")),
        root.path().join(format!("closures/{wrong}.json")),
    )
    .unwrap();
    let err = actor_assets::ensure_actor_assets(root.path(), &wrong, None, None).unwrap_err();
    assert_eq!(err.code, "actor_closure_digest_mismatch");
    assert!(err.reason.contains("does not match its declared identity"));
    let err = actor_assets::ensure_actor_assets(root.path(), &digest, Some(1), None).unwrap_err();
    assert_eq!(err.code, "actor_closure_digest_mismatch");
    let err =
        actor_assets::ensure_actor_assets(root.path(), &"a".repeat(64), None, None).unwrap_err();
    assert_eq!(
        (err.code.as_str(), err.exit.code()),
        ("actor_closure_not_installed", 1)
    );
}

#[test]
fn re_verifies_the_store_on_every_render_and_rebuilds_a_modified_tree() {
    let (root, digest) = store(&[
        ("catalog-models.json", CATALOG.as_bytes()),
        ("models/vehicle.sedan/model.glb", SEDAN_GLB),
    ]);
    let first = actor_assets::ensure_actor_assets(root.path(), &digest, None, None).unwrap();
    // A tampered tree member (not the blob) is rebuilt.
    let member = first.directory.join("models/vehicle.sedan/model.glb");
    std::fs::remove_file(&member).unwrap();
    std::fs::write(&member, "tampered").unwrap();
    let second = actor_assets::ensure_actor_assets(root.path(), &digest, None, None).unwrap();
    assert!(!second.reused_tree);
    assert_eq!(std::fs::read(&member).unwrap(), SEDAN_GLB);
    // A tampered store blob fails by member path, with the pull hint.
    let blob = root
        .path()
        .join("blobs/sha256")
        .join(&sha(SEDAN_GLB)[..2])
        .join(sha(SEDAN_GLB));
    std::fs::remove_file(&blob).unwrap();
    std::fs::write(&blob, "not the sedan").unwrap();
    let err = actor_assets::ensure_actor_assets(root.path(), &digest, None, None).unwrap_err();
    assert_eq!(err.code, "actor_asset_blob_mismatch");
    assert!(err.detail.unwrap()["hint"]
        .as_str()
        .unwrap()
        .contains("simforge assets pull"));
    std::fs::remove_file(&blob).unwrap();
    let err = actor_assets::ensure_actor_assets(root.path(), &digest, None, None).unwrap_err();
    assert_eq!(err.code, "actor_asset_blob_missing");
}

#[test]
fn refuses_a_catalog_that_binds_an_id_outside_the_closure() {
    let catalog = r#"{"vehicle.sedan":{"model":{"glbPath":"models/elsewhere.glb"},"tintable":true,"scaleToDims":false}}"#;
    let (root, digest) = store(&[("catalog-models.json", catalog.as_bytes())]);
    let err = actor_assets::ensure_actor_assets(root.path(), &digest, None, None).unwrap_err();
    assert!(
        err.reason.contains("not a closure member"),
        "{}",
        err.reason
    );
}

fn members() -> BTreeMap<String, actor_assets::ClosureMember> {
    let m = |c: u8| actor_assets::ClosureMember {
        sha256: [c; 32],
        bytes: 1,
    };
    BTreeMap::from([
        ("models/pedestrian.adult/model.glb".to_owned(), m(0xaa)),
        ("models/pedestrian.adult/walk.glb".to_owned(), m(0xbb)),
    ])
}

fn parse(
    table: Value,
) -> Result<BTreeMap<String, actor_assets::ActorClosureModel>, simforge_cli::contract::CliError> {
    actor_assets::parse_actor_closure_catalog(&serde_json::to_vec(&table).unwrap(), &members())
}

#[test]
fn binds_animations_and_in_model_clips_by_motion_as_the_service_does() {
    let entry = json!({ "model": { "glbPath": "models/pedestrian.adult/model.glb" }, "tintable": false, "scaleToDims": false });
    let mut adult = entry.clone();
    adult["animations"] = json!({ "walk": { "glbPath": "models/pedestrian.adult/walk.glb", "clip": "Walk", "groundOffsetM": 0.027 } });
    let mut child = entry.clone();
    child["model"] = json!({ "glbPath": "models/pedestrian.adult/model.glb", "clips": { "idle": "Idle", "locomotion": "Run" }, "clipGroundOffsetM": { "idle": 0.274, "locomotion": 0.285 } });
    let mut bicycle = entry.clone();
    bicycle["animations"] =
        json!({ "ride": { "glbPath": "models/pedestrian.adult/walk.glb", "clip": "ride" } });
    let models = parse(json!({ "version": 3, "pedestrian.adult": adult, "pedestrian.child": child, "vehicle.bicycle": bicycle })).unwrap();
    let walk = &models["pedestrian.adult"].animations["walk"];
    assert_eq!(
        (
            walk.glb_path.as_str(),
            walk.clip.as_str(),
            walk.ground_offset_m
        ),
        ("models/pedestrian.adult/walk.glb", "Walk", Some(0.027))
    );
    let child = &models["pedestrian.child"].animations;
    assert_eq!(child.keys().collect::<Vec<_>>(), ["idle", "walk"]);
    assert_eq!(
        (child["idle"].clip.as_str(), child["idle"].ground_offset_m),
        ("Idle", Some(0.274))
    );
    assert_eq!(
        (child["walk"].clip.as_str(), child["walk"].ground_offset_m),
        ("Run", Some(0.285))
    );
    assert_eq!(
        models["vehicle.bicycle"].animations["ride"].ground_offset_m,
        None
    );
}

#[test]
fn refuses_every_malformed_catalog_entry_by_name_instead_of_skipping_it() {
    let entry = json!({ "model": { "glbPath": "models/pedestrian.adult/model.glb" }, "tintable": false, "scaleToDims": false });
    let with = |patch: Value| {
        let mut e = entry.clone();
        for (k, v) in patch.as_object().unwrap() {
            e[k] = v.clone();
        }
        json!({ "pedestrian.adult": e })
    };
    let model_with = |patch: Value| {
        let mut m = entry["model"].clone();
        for (k, v) in patch.as_object().unwrap() {
            m[k] = v.clone();
        }
        with(json!({ "model": m }))
    };
    let walk = "models/pedestrian.adult/walk.glb";
    for (table, message) in [
        (
            json!({ "pedestrian.adult": "model.glb" }),
            "entry pedestrian.adult is not an object",
        ),
        (
            with(json!({ "model": { "glbPath": 7 } })),
            "pedestrian.adult model has no glbPath",
        ),
        (
            json!({ "pedestrian.adult": { "model": entry["model"], "scaleToDims": false } }),
            "does not declare tintable",
        ),
        (
            with(json!({ "uniformScale": "big" })),
            "uniformScale is not a finite number",
        ),
        (
            with(json!({ "animations": { "walk": { "glbPath": walk } } })),
            "animation walk names no clip",
        ),
        (
            with(json!({ "animations": [] })),
            "animations is not an object",
        ),
        (
            with(json!({ "animations": { "walk": { "glbPath": walk, "clip": "Walk" } } })),
            "walk clip without a measured groundOffsetM",
        ),
        (
            with(
                json!({ "animations": { "walk": { "glbPath": walk, "clip": "Walk", "groundOffsetM": "low" } } }),
            ),
            "animation walk groundOffsetM is not a finite number",
        ),
        (
            model_with(json!({ "clips": { "idle": "Idle" } })),
            "idle clip without a measured groundOffsetM",
        ),
        (
            model_with(json!({ "clips": { "sprint": "Run" } })),
            "model.clips.sprint is not a known motion",
        ),
        (
            model_with(json!({ "animated": true })),
            "is animated but binds no animation clips",
        ),
        (json!([]), "expected an object"),
    ] {
        let err = parse(table.clone()).unwrap_err();
        assert_eq!(err.code, "native_actor_catalog_invalid", "{table}");
        assert!(err.reason.contains(message), "{table}: {}", err.reason);
    }
}

fn model(catalog_id: &str, animations: &[&str]) -> (String, actor_assets::ActorClosureModel) {
    (
        catalog_id.to_owned(),
        actor_assets::ActorClosureModel {
            catalog_id: catalog_id.to_owned(),
            glb_path: format!("models/{catalog_id}/model.glb"),
            animations: animations
                .iter()
                .map(|m| {
                    (
                        (*m).to_owned(),
                        actor_assets::ActorClosureAnimation {
                            glb_path: format!("models/{catalog_id}/model.glb"),
                            clip: (*m).to_owned(),
                            ground_offset_m: None,
                        },
                    )
                })
                .collect(),
        },
    )
}

fn appearance(id: &str, kind: &str, catalog: &str, authored: bool) -> ActorAppearance {
    ActorAppearance {
        actor_id: id.into(),
        kind: Some(kind.into()),
        catalog_id: catalog.into(),
        authored,
    }
}

#[test]
fn appearance_must_be_grounded_in_the_closure_or_a_procedural_builder() {
    let digest = "a".repeat(64);
    let models = BTreeMap::from([model("vehicle.sedan", &[])]);
    let host = SensorHost {
        source_id: "cam1".into(),
        actor_id: "ego".into(),
        catalog_asset_id: "vehicle.sedan".into(),
    };
    let check = |a: &[ActorAppearance],
                 h: &[SensorHost],
                 m: &BTreeMap<String, actor_assets::ActorClosureModel>| {
        actor_assets::assert_actor_appearance_grounded(a, h, &digest, m)
    };
    let err = check(
        &[
            appearance("ego", "car", "vehicle.sedan", false),
            appearance("parked", "car", "vehicle.hatchback", true),
        ],
        std::slice::from_ref(&host),
        &models,
    )
    .unwrap_err();
    assert_eq!(err.code, "native_actor_model_missing");
    assert!(err
        .reason
        .contains("parked requires catalog model vehicle.hatchback"));
    let err = check(
        &[appearance("truck-1", "truck", "vehicle.box_truck", false)],
        &[],
        &models,
    )
    .unwrap_err();
    assert!(
        err.reason
            .contains("truck-1 requires catalog model vehicle.box_truck (truck default)"),
        "{}",
        err.reason
    );
    assert_eq!(
        check(
            &[appearance("thing", "hovercraft", "vehicle.sedan", false)],
            &[],
            &models
        )
        .unwrap_err()
        .code,
        "native_actor_kind_unmapped"
    );
    let err = check(
        &[appearance("van-1", "van", "vehicle.sedan", false)],
        &[],
        &models,
    )
    .unwrap_err();
    assert_eq!(err.code, "native_actor_default_mismatch");
    assert!(err
        .reason
        .contains("documented default for van is vehicle.van"));
    // Procedural identity needs no closure model; the same vehicle's GLB id does.
    let empty = BTreeMap::new();
    assert!(check(
        &[appearance(
            "parked",
            "car",
            "vehicle.hatchback.low_poly",
            true
        )],
        &[],
        &empty
    )
    .is_ok());
    assert!(check(
        &[appearance("parked", "car", "vehicle.hatchback", true)],
        &[],
        &empty
    )
    .is_err());
    let other = SensorHost {
        catalog_asset_id: "vehicle.kia.carnival".into(),
        ..host.clone()
    };
    let err = check(
        &[appearance("ego", "car", "vehicle.sedan", false)],
        &[other],
        &models,
    )
    .unwrap_err();
    assert!(err.reason.contains("identifies actor ego as vehicle.kia.carnival, but the scenario renders it as vehicle.sedan"));
    assert!(check(&[], &[host], &models)
        .unwrap_err()
        .reason
        .contains("never present"));
}

#[test]
fn kind_defaults_are_the_documented_table() {
    for (kind, id) in [
        ("vehicle", "vehicle.sedan"),
        ("car", "vehicle.sedan"),
        ("truck", "vehicle.box_truck"),
        ("bus", "vehicle.bus"),
        ("van", "vehicle.van"),
        ("motorcycle", "vehicle.motorcycle"),
        ("bicycle", "vehicle.bicycle"),
        ("pedestrian", "pedestrian.adult"),
        ("scooter", "vehicle.bicycle"),
        ("sidewalk_robot", "sidewalk_robot.delivery_rover"),
        ("drone", "drone.camera_quadcopter"),
        ("animal", "animal.dog"),
        ("static_object", "hazard.cardboard_box"),
        ("obstacle", "hazard.cardboard_box"),
    ] {
        assert_eq!(
            actor_assets::kind_default_catalog_id(kind, "a").unwrap(),
            id,
            "{kind}"
        );
    }
    assert_eq!(
        actor_assets::kind_default_catalog_id("hovercraft", "actor h")
            .unwrap_err()
            .code,
        "native_actor_kind_unmapped"
    );
}

fn frame(tick: u32, actors: &[(&str, &str, f64)]) -> Value {
    json!({
        "version": "simforge.scene-state.v1", "mapId": "m", "tick": tick, "tickHz": 24, "weather": { "preset": "clear" },
        "timeOfDay": 12, "groundY": 0,
        "actors": actors.iter().map(|(id, catalog, speed)| json!({
            "id": id, "kind": if tick == 0 { "spawn" } else { "update" }, "catalogId": catalog, "actorClass": "pedestrian",
            "transform": { "position": [0, 0, 0], "rotation": [0, 0, 0, 1] }, "velocity": [speed, 0, 0],
        })).collect::<Vec<_>>(),
    })
}

#[test]
fn moving_walkers_need_their_clips() {
    let digest = "c".repeat(64);
    let walker = appearance("walker", "pedestrian", "pedestrian.adult", true);
    let both = BTreeMap::from([model("pedestrian.adult", &["walk", "idle"])]);
    let frames = [
        frame(0, &[("walker", "pedestrian.adult", 0.0)]),
        frame(1, &[("walker", "pedestrian.adult", 1.4)]),
    ];
    assert!(actor_assets::assert_actor_animations_bound(
        std::slice::from_ref(&walker),
        &frames,
        &digest,
        &both
    )
    .is_ok());
    let idle_only = BTreeMap::from([model("pedestrian.adult", &["idle"])]);
    let err = actor_assets::assert_actor_animations_bound(
        std::slice::from_ref(&walker),
        &[frame(0, &[("walker", "pedestrian.adult", 1.4)])],
        &digest,
        &idle_only,
    )
    .unwrap_err();
    assert_eq!(err.code, "native_actor_animation_missing");
    assert!(err.reason.contains(
        "pedestrian walker moves but its catalog model pedestrian.adult binds no walk clip"
    ));
    let dog = appearance("dog", "animal", "animal.dog", false);
    let dogs = BTreeMap::from([model("animal.dog", &[])]);
    assert!(actor_assets::assert_actor_animations_bound(
        std::slice::from_ref(&dog),
        &[frame(0, &[("dog", "animal.dog", 0.0)])],
        &digest,
        &dogs
    )
    .is_ok());
    assert_eq!(
        actor_assets::assert_actor_animations_bound(
            &[dog],
            &[frame(0, &[("dog", "animal.dog", 3.0)])],
            &digest,
            &dogs
        )
        .unwrap_err()
        .code,
        "native_actor_animation_missing"
    );
}

/// The real pinned closure pulled by `simforge assets pull`
/// (`SIMFORGE_CLI_TEST_ACTOR_ASSETS=<root>`, e.g. $XDG_CACHE_HOME/simforge/actor-assets).
#[test]
#[ignore = "needs an installed actor closure (SIMFORGE_CLI_TEST_ACTOR_ASSETS)"]
fn the_pinned_closure_verifies_and_binds_every_catalog_model() {
    let root = PathBuf::from(
        std::env::var_os("SIMFORGE_CLI_TEST_ACTOR_ASSETS").expect("SIMFORGE_CLI_TEST_ACTOR_ASSETS"),
    );
    let digest = "218209f5109d8a25d9967de1cca4b202555dc12f53289463aa40a6812d79854f";
    let tree = tempfile::tempdir_in(&root).unwrap();
    let assets =
        actor_assets::ensure_actor_assets(&root, digest, Some(22971), Some(tree.path())).unwrap();
    assert!(assets.models.len() > 50, "{}", assets.models.len());
    assert_eq!(assets.copied_files, 0);
    assert!(assets.models.contains_key("vehicle.sedan"));
}

/// Encoded videos differ between ffmpeg builds; decoded frames must not.
#[test]
#[ignore = "needs ffmpeg with libx264 on PATH"]
fn a_libx264_encode_decodes_to_the_rasterized_frames_within_codec_loss() {
    use simforge_cli::render::video::VideoEncoder;
    let ffmpeg = which_ffmpeg();
    let dir = tempfile::tempdir().unwrap();
    let scan = parse_radar_csv(
        &std::fs::read(fixtures().join("radar-a.csv")).unwrap(),
        "radar",
    )
    .unwrap();
    let mut raster = RadarVideoRasterizer::new(320, 180, 90.0, 100.0).unwrap();
    let rgba = raster.frame(&scan).to_vec();
    let out = dir.path().join("radar.mp4");
    let format = VideoFormat {
        width: 320,
        height: 180,
        frames_per_second: 10.0,
    };
    let mut encoder = VideoEncoder::new(&ffmpeg, &out, format, VideoCodec::Libx264).unwrap();
    for _ in 0..10 {
        encoder.write(&rgba).unwrap();
    }
    let done = encoder.finish().unwrap();
    assert_eq!((done.frames, done.fell_back), (10, false));
    let decoded = std::process::Command::new(&ffmpeg)
        .args(["-loglevel", "error", "-i"])
        .arg(&out)
        .args(["-f", "rawvideo", "-pix_fmt", "rgba", "-"])
        .output()
        .unwrap();
    assert!(decoded.status.success());
    assert_eq!(decoded.stdout.len(), rgba.len() * 10);
    // yuv420p at CRF 18: mean absolute error well under 2 levels per channel.
    let first = &decoded.stdout[..rgba.len()];
    let mae: f64 = first
        .iter()
        .zip(&rgba)
        .map(|(a, b)| (*a as f64 - *b as f64).abs())
        .sum::<f64>()
        / rgba.len() as f64;
    assert!(mae < 6.0, "mean absolute error {mae}");
}

fn which_ffmpeg() -> PathBuf {
    std::env::split_paths(&std::env::var_os("PATH").unwrap())
        .map(|d| d.join("ffmpeg"))
        .find(|p| p.is_file())
        .expect("ffmpeg on PATH")
}
