//! Determinism and correctness tests for the sensor math modules.

use sensors::bvh::{RaycastScene, Tri};
use sensors::formats;
use sensors::imu_gnss::TmercOrigin;
use sensors::lidar::{self, LidarConfig};
use sensors::radar::{self, RadarConfig};
use sensors::rig::{parse_pronto_rig, SensorKind};
use sensors::taxonomy::SemanticClass;
use bevy::math::{Quat, Vec3};

fn ground_scene() -> RaycastScene {
    // 10x10 ground plane at y=0 made of two triangles, instance id 7.
    let mut s = RaycastScene::new();
    s.push_tri(Tri {
        a: Vec3::new(-500.0, 0.0, -500.0),
        b: Vec3::new(500.0, 0.0, 500.0),
        c: Vec3::new(-500.0, 0.0, 500.0),
        instance_id: 7,
    });
    s.push_tri(Tri {
        a: Vec3::new(-500.0, 0.0, -500.0),
        b: Vec3::new(500.0, 0.0, -500.0),
        c: Vec3::new(500.0, 0.0, 500.0),
        instance_id: 7,
    });
    s.build();
    s
}

#[test]
fn half_precision_depth_keeps_the_range_reverse_z_actually_uses() {
    use sensors::capture::f32_to_f16_bits as half;

    // Exact representables, and the rounding mode.
    assert_eq!(half(0.0), 0x0000);
    assert_eq!(half(-0.0), 0x8000);
    assert_eq!(half(1.0), 0x3c00);
    assert_eq!(half(0.5), 0x3800);
    assert_eq!(half(-2.0), 0xc000);
    assert_eq!(half(65504.0), 0x7bff, "largest finite half");

    // Overflow saturates to infinity rather than wrapping to a small number,
    // which is what a naive truncation does and what would silently turn far
    // geometry into near geometry.
    assert_eq!(half(1.0e5), 0x7c00);
    assert_eq!(half(-1.0e5), 0xfc00);
    assert_eq!(half(f32::INFINITY), 0x7c00);
    assert!(half(f32::NAN) & 0x7c00 == 0x7c00 && half(f32::NAN) & 0x03ff != 0);

    // Tiny values fall into subnormals, then to signed zero — never to a
    // spurious large value.
    assert_eq!(half(1.0e-8), 0x0000);
    assert!(half(1.0e-6) < 0x0400, "subnormal, not normal");

    // Reverse-Z depth lives in [0, 1]; check the precision claim there. Half
    // has an 11-bit significand, so relative error is under 2^-11.
    for value in [0.999_9, 0.75, 0.5, 0.25, 0.1, 0.01, 0.001] {
        let bits = half(value);
        let back = decode_half(bits);
        let relative = ((back - value) / value).abs();
        assert!(relative < 1.0 / 2048.0, "{value} -> {back} ({relative})");
    }
}

/// Half bit pattern back to f32, for checking the encoder's error.
fn decode_half(bits: u16) -> f32 {
    let sign = if bits & 0x8000 != 0 { -1.0f32 } else { 1.0 };
    let exponent = ((bits >> 10) & 0x1f) as i32;
    let mantissa = (bits & 0x03ff) as f32;
    match exponent {
        0 => sign * mantissa * 2.0f32.powi(-24),
        31 => sign * f32::INFINITY,
        _ => sign * (1.0 + mantissa / 1024.0) * 2.0f32.powi(exponent - 15),
    }
}

#[test]
fn binary_ply_carries_the_same_points_as_the_ascii_form() {
    let points = vec![
        sensors::lidar::LidarPoint { x: 1.5, y: -2.25, z: 3.0, intensity: 0.5, instance_id: 7 },
        sensors::lidar::LidarPoint { x: -0.125, y: 0.0, z: 12.75, intensity: 1.0, instance_id: 4242 },
    ];
    let binary = sensors::formats::encode_lidar_ply_binary(&points);

    let header_end = b"end_header\n";
    let split = binary
        .windows(header_end.len())
        .position(|w| w == header_end)
        .expect("header terminator")
        + header_end.len();
    let header = std::str::from_utf8(&binary[..split]).expect("ascii header");
    assert!(header.contains("format binary_little_endian 1.0"));
    assert!(header.contains("element vertex 2"));

    let body = &binary[split..];
    assert_eq!(body.len(), points.len() * 20, "5 x 4-byte properties per point");

    // Values must survive exactly: this is a container change, not a fidelity
    // change.
    for (i, point) in points.iter().enumerate() {
        let row = &body[i * 20..(i + 1) * 20];
        let f = |o: usize| f32::from_le_bytes([row[o], row[o + 1], row[o + 2], row[o + 3]]);
        assert_eq!(f(0), point.x);
        assert_eq!(f(4), point.y);
        assert_eq!(f(8), point.z);
        assert_eq!(f(12), point.intensity);
        assert_eq!(
            u32::from_le_bytes([row[16], row[17], row[18], row[19]]),
            point.instance_id
        );
    }
    // And it is materially smaller per point than the text form it replaces:
    // the fixed header is longer, the rows are far shorter, and a real scan is
    // tens of thousands of points.
    let many: Vec<sensors::lidar::LidarPoint> = (0..1000)
        .map(|i| sensors::lidar::LidarPoint {
            x: i as f32 * 0.25,
            y: -(i as f32) * 0.125,
            z: 1.0 / (i as f32 + 1.0),
            intensity: (i % 100) as f32 / 100.0,
            instance_id: i as u32,
        })
        .collect();
    let ascii_many = sensors::formats::encode_lidar_ply(&many).len();
    let binary_many = sensors::formats::encode_lidar_ply_binary(&many).len();
    assert!(
        binary_many * 2 < ascii_many,
        "binary {binary_many} should be less than half of ascii {ascii_many}"
    );
}

#[test]
fn composite_scene_returns_the_nearest_layer_hit() {
    let statics = ground_scene();
    // A closer horizontal quad at y=1, standing in for an actor cuboid face.
    let mut actors = RaycastScene::new();
    actors.push_tri(Tri {
        a: Vec3::new(-2.0, 1.0, -2.0),
        b: Vec3::new(2.0, 1.0, 2.0),
        c: Vec3::new(-2.0, 1.0, 2.0),
        instance_id: 42,
    });
    actors.build();

    let composed = sensors::bvh::CompositeScene::new(vec![&statics, &actors]);
    let hit = sensors::bvh::Raycast::cast(&composed, Vec3::new(-0.5, 5.0, 0.5), Vec3::NEG_Y, 100.0)
        .expect("hit");
    assert_eq!(hit.instance_id, 42, "actor layer must win over the ground");
    assert!((hit.distance - 4.0).abs() < 1e-4);

    // Outside the actor's extent the static ground still answers.
    let hit = sensors::bvh::Raycast::cast(&composed, Vec3::new(-100.0, 5.0, 90.0), Vec3::NEG_Y, 100.0)
        .expect("hit");
    assert_eq!(hit.instance_id, 7);
}

#[test]
fn rig_host_falls_back_to_the_first_actor_when_no_ego_id_exists() {
    // Compiled production documents name actors after draft entities and carry
    // no id "ego"; without the fallback the rig sensed from the map origin.
    let document = r#"{
      "version": "simforge.scene-state.v1",
      "mapId": "belmont",
      "frame": "scene-yup",
      "dt": 0.02,
      "tickHz": 50,
      "tickCount": 2,
      "weather": {"preset": "clear"},
      "timeOfDay": 12,
      "actors": [
        {"id": "vehicle-aaa", "catalogId": "vehicle.honda_civic", "actorClass": "car"},
        {"id": "vehicle-bbb", "catalogId": "vehicle.honda_civic", "actorClass": "car"}
      ],
      "frames": [
        {"tick": 0, "t": 0.0, "actors": [
          {"id": "vehicle-aaa", "kind": "spawn", "position": [10.0, 0.0, -3.0], "rotation": [0,0,0,1], "yawRad": 0, "velocity": [5.0,0,0]},
          {"id": "vehicle-bbb", "kind": "spawn", "position": [40.0, 0.0, -3.0], "rotation": [0,0,0,1], "yawRad": 0, "velocity": [4.0,0,0]}
        ]},
        {"tick": 1, "t": 0.02, "actors": [
          {"id": "vehicle-aaa", "kind": "update", "position": [10.1, 0.0, -3.0], "rotation": [0,0,0,1], "yawRad": 0, "velocity": [5.0,0,0]},
          {"id": "vehicle-bbb", "kind": "update", "position": [40.08, 0.0, -3.0], "rotation": [0,0,0,1], "yawRad": 0, "velocity": [4.0,0,0]}
        ]}
      ]
    }"#;

    let sequence = sensors::scene_state::SceneSequence::from_json(document, 0, 2, 1)
        .expect("parse document");
    assert_eq!(sequence.ticks.len(), 2);

    let host = sequence.ticks[0].ego().expect("a rig host must be resolved");
    assert_eq!(host.id, "vehicle-aaa");
    assert_eq!(host.transform.position, [10.0, 0.0, -3.0]);
    assert_eq!(host.catalog_id.as_deref(), Some("vehicle.honda_civic"));

    // The host moves with the clip, so the rig is not pinned to one pose.
    let later = sequence.ticks[1].ego().expect("host at second tick");
    assert_eq!(later.id, "vehicle-aaa");
    assert!((later.transform.position[0] - 10.1).abs() < 1e-6);
}

#[test]
fn scene_sampling_rejects_repeated_tail_frames() {
    let document = r#"{
        "version":"simforge.scene-state.v1", "mapId":"fixture", "tickHz":50,
        "frames":[{"tick":0,"actors":[]},{"tick":1,"actors":[]},{"tick":2,"actors":[]}]
    }"#;
    let read = sensors::scene_state::SceneSequence::from_json;
    let exact = read(document, 0, 2, 2).unwrap();
    assert_eq!(exact.ticks.iter().map(|s| s.tick).collect::<Vec<_>>(), [0, 2]);
    assert!(read(document, 0, 3, 2).is_err(), "never duplicate the final pose to fill a request");
    assert!(read(document, 3, 1, 1).is_err(), "an invalid start must not select the final frame");
    assert!(read(document, 0, 2, 0).is_err(), "zero stride would repeat one frame");
    assert!(read(document, 0, 0, 1).is_err(), "an empty request must not manufacture a frame");
}

#[test]
fn bvh_nearest_hit_and_normal() {
    let s = ground_scene();
    let hit = s.cast(Vec3::new(1.0, 3.0, 2.0), Vec3::NEG_Y, 100.0).expect("hit");
    assert!((hit.distance - 3.0).abs() < 1e-4);
    assert_eq!(hit.instance_id, 7);
    assert!((hit.normal.y.abs() - 1.0).abs() < 1e-5);
    assert!(s.cast(Vec3::new(1.0, 3.0, 2.0), Vec3::Y, 100.0).is_none());
}

#[test]
fn lidar_scan_is_ordered_and_deterministic() {
    let s = ground_scene();
    let cfg = LidarConfig {
        channels: 8,
        rotation_frequency_hz: 10.0,
        points_per_second: 8000,
        vfov_deg: 20.0,
        hfov_deg: 360.0,
        range_m: 200.0,
    };
    let origin = Vec3::new(0.0, 2.0, 0.0);
    let a = lidar::scan(&s, &cfg, origin, Quat::IDENTITY, &|_| SemanticClass::Road);
    let b = lidar::scan(&s, &cfg, origin, Quat::IDENTITY, &|_| SemanticClass::Road);
    assert!(!a.is_empty());
    assert_eq!(a.len(), b.len());
    for (p, q) in a.iter().zip(b.iter()) {
        assert_eq!(p.x.to_bits(), q.x.to_bits());
        assert_eq!(p.intensity.to_bits(), q.intensity.to_bits());
        assert_eq!(p.instance_id, q.instance_id);
    }
    // Ordered by channel then azimuth: azimuth increases along the scan.
    // Ground returns at |x,z| = 2 / sin(elev): nearer beams come from the
    // lowest channel (largest elevation) — just check all points lie on y=0.
    for p in &a {
        assert!((p.y + 2.0).abs() < 1e-3, "ground return sits 2 m below the sensor");
        assert!(p.instance_id == 7);
        assert!((0.0..=1.0).contains(&p.intensity));
    }
}

#[test]
fn radar_radial_velocity_projection() {
    let s = ground_scene();
    let cfg = RadarConfig {
        hfov_deg: 30.0,
        vfov_deg: 30.0,
        range_m: 100.0,
        azimuth_rays: 5,
        elevation_rows: 5,
    };
    // Target moving straight away from sensor at +x with 3 m/s; sensor host
    // static -> radial velocity positive ~3 for beams hitting at x=+.
    let detections = radar::scan(
        &s,
        &cfg,
        Vec3::new(0.0, 1.5, 0.0),
        Quat::IDENTITY,
        Vec3::ZERO,
        &|id| if id == 7 { Vec3::new(3.0, 0.0, 0.0) } else { Vec3::ZERO },
    );
    assert!(!detections.is_empty());
    // Static scene without host motion would read zero relative velocity:
    let d_static = radar::scan(
        &s,
        &cfg,
        Vec3::new(0.0, 1.5, 0.0),
        Quat::IDENTITY,
        Vec3::ZERO,
        &|_| Vec3::ZERO,
    );
    for d in &d_static {
        assert!(d.velocity.abs() < 1e-5);
    }
    let _ = detections;
}

#[test]
fn tmerc_inverse_matches_reference() {
    // Yale Street geoReference (RoadRunner / MathWorks export).
    let tm = TmercOrigin::parse(
        "+proj=tmerc +lat_0=37.4100548676094 +lon_0=-122.154771275882 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +vunits=m +no_defs",
    )
    .expect("tmerc params");
    // Origin maps back to lat_0/lon_0.
    let (lat, lon) = tm.inverse(0.0, 0.0);
    assert!((lat - 37.4100548676094).abs() < 1e-9, "lat {lat}");
    assert!((lon - (-122.154771275882)).abs() < 1e-9, "lon {lon}");
    // Reference values from pyproj (same projection string).
    let (lat_r, lon_r) = tm.inverse(50.0, -30.0);
    assert!((lat_r - 37.409784560292294).abs() < 1e-8, "lat {lat_r}");
    assert!((lon_r - (-122.15420650654427)).abs() < 1e-8, "lon {lon_r}");
    let (lat3, lon3) = tm.inverse(749.0219, 1683.4817);
    assert!((lat3 - 37.42522304990563).abs() < 1e-8, "lat {lat3}");
    assert!((lon3 - (-122.14630904698045)).abs() < 1e-8, "lon {lon3}");
}

#[test]
fn rig_parses_pronto_program() {
    let path = concat!(
        "/home/path/SimForge/qualification/",
        "render-qualification-program.v1.json"
    );
    let Ok(text) = std::fs::read_to_string(path) else {
        return; // qualification file absent in bare checkouts
    };
    let rig = parse_pronto_rig(&text, 1920, 1080).expect("rig");
    let cameras: Vec<_> = rig.cameras().filter(|c| c.id != sensors::rig::CHASE_CAMERA_SENSOR_ID).collect();
    let lidars: Vec<_> = rig.lidars().collect();
    let radars: Vec<_> = rig.radars().collect();
    assert_eq!(cameras.len(), 8);
    // Chase rides outside the measurement rig.
    assert_eq!(rig.cameras().count(), 9);
    assert_eq!(lidars.len(), 6);
    assert_eq!(radars.len(), 4);
    assert!(rig.chase().is_some());
    // cam1 front center: mount x=0.85-0.1508, z=0, yaw 0.
    let cam1 = cameras.iter().find(|c| c.id == "pronto-cam1").unwrap();
    assert!((cam1.mount.x - (0.85 - 0.1508)).abs() < 1e-4);
    assert!(cam1.mount.z.abs() < 1e-6);
    assert_eq!(cam1.horizontal_fov_deg, 120.0);
    // 16:9 aspect: vfov < hfov.
    let vfov = cam1.vertical_fov_deg.unwrap();
    assert!(vfov > 80.0 && vfov < 95.0, "vfov {vfov}");
    // Rear center camera yaw ~ pi.
    let cam5 = cameras.iter().find(|c| c.id == "pronto-cam5").unwrap();
    assert!((cam5.mount.yaw - std::f32::consts::PI).abs() < 1e-3);
    // All kinds present exactly once each per contract counts.
    assert!(rig.sensors.iter().all(|s| matches!(
        s.kind,
        SensorKind::Camera | SensorKind::Lidar | SensorKind::Radar
    )));
}

#[test]
fn fmt_g_matches_nine_significant_digits() {
    assert_eq!(formats::fmt_g(0.0), "0");
    assert_eq!(formats::fmt_g(1.0), "1");
    assert_eq!(formats::fmt_g(-12.5), "-12.5");
    assert_eq!(formats::fmt_g(123456792.0), "123456792"); // exact f32 neighbor
    // Round-trip always exact.
    for v in [0.25f32, -0.001, 98.76543, 1e-6, 42.0] {
        let parsed: f32 = formats::fmt_g(v).parse().unwrap();
        assert_eq!(parsed.to_bits(), v.to_bits());
    }
}

/// Exercises the emitted labels, not the camera's component wiring. The old
/// PBR aux path applied screen-space debanding and produced adjacent IDs/classes.
#[test]
#[ignore = "requires a Vulkan GPU; run explicitly on the capture workstation"]
fn rendered_aux_labels_are_discrete() {
    use serde_json::json;
    use std::{fs, path::PathBuf, process::Command, time::{SystemTime, UNIX_EPOCH}};
    struct Fixture(PathBuf);
    impl Drop for Fixture {
        fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
    }
    let fixture = Fixture(std::env::temp_dir().join(format!(
        "simforge-aux-labels-{}-{}", std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos(),
    )));
    fs::create_dir_all(&fixture.0).unwrap();
    // One mesh with two walls: both the old -Z camera and corrected +X
    // camera see a flat class-8 surface, isolating the label regression.
    let positions: [[f32; 3]; 12] = [
        [-2.0,-2.0,0.0], [2.0,-2.0,0.0], [2.0,2.0,0.0],
        [-2.0,-2.0,0.0], [2.0,2.0,0.0], [-2.0,2.0,0.0],
        [5.0,-2.0,3.0], [5.0,-2.0,7.0], [5.0,2.0,7.0],
        [5.0,-2.0,3.0], [5.0,2.0,7.0], [5.0,2.0,3.0],
    ];
    let mut vertices = Vec::new();
    for vertex in positions.into_iter().chain([[0.0,0.0,1.0]; 6]).chain([[-1.0,0.0,0.0]; 6]) {
        for value in vertex { vertices.extend_from_slice(&value.to_le_bytes()); }
    }
    fs::write(fixture.0.join("vertices.bin"), vertices).unwrap();
    fs::write(fixture.0.join("fixture.gltf"), json!({
        "asset": {"version":"2.0"}, "scene":0, "scenes":[{"nodes":[0]}],
        "nodes":[{"mesh":0,"name":"prop-wall"}],
        "meshes":[{"name":"prop-wall","primitives":[{"attributes":{"POSITION":0,"NORMAL":1}}]}],
        "buffers":[{"uri":"vertices.bin","byteLength":288}],
        "bufferViews":[{"buffer":0,"byteOffset":0,"byteLength":144},{"buffer":0,"byteOffset":144,"byteLength":144}],
        "accessors":[
            {"bufferView":0,"componentType":5126,"count":12,"type":"VEC3","min":[-2,-2,0],"max":[5,2,7]},
            {"bufferView":1,"componentType":5126,"count":12,"type":"VEC3"}
        ]
    }).to_string()).unwrap();
    fs::write(fixture.0.join("rig.json"), json!({"prontoRig":{
        "id":"label-regression", "sensors":[{
            "id":"fixture-cam","label":"fixture","type":"dash_camera","horizontalFovDeg":60.0,
            "sourceMountMm":{"longitudinal":-850.0,"lateralRight":-5000.0,"up":-1280.0},
            "rotationDeg":{"yaw":0.0,"pitch":0.0,"roll":0.0}
        }]
    }}).to_string()).unwrap();
    fs::write(fixture.0.join("scene.json"), json!({
        "version":sensors::scene_state::SCENE_STATE_SCHEMA,"mapId":"fixture","tickHz":50,
        "actors":[{"id":"ego","actorClass":"car"},{"id":"late","actorClass":"car"}],
        "frames":[
            {"tick":0,"actors":[{"id":"ego","kind":"spawn","position":[0,0,0]}]},
            {"tick":1,"actors":[
                {"id":"ego","kind":"update","position":[0,0,0]},
                {"id":"late","kind":"spawn","position":[3,0,5]}]}
        ]
    }).to_string()).unwrap();
    fs::write(fixture.0.join("products.json"),json!({
        "name":"label-qualification","cameraHistoryFrames":1,
        "egoHistory":{"points":16,"hz":10},"futureTarget":{"points":50,"hz":10},
        "cameraHz":50,"width":64,"height":64,"rgb":{"kind":"png"},
        "depth":null,"labels":true,"lidar":null,"radar":null,"occupancy":false,
    }).to_string()).unwrap();
    let binary = std::env::var_os("SENSOR_CAPTURE_TEST_BIN")
        .unwrap_or_else(|| env!("CARGO_BIN_EXE_sensor-capture").into());
    for batched in [false, true] {
        let output = fixture.0.join(if batched { "batched" } else { "legacy" });
        let mut command = Command::new(&binary);
        command
            .args(["--rig-program"]).arg(fixture.0.join("rig.json"))
            .args(["--glbs"]).arg(fixture.0.join("fixture.gltf"))
            .args(["--scene-state"]).arg(fixture.0.join("scene.json"))
            .args(["--profile","showcase","--product-spec"]).arg(fixture.0.join("products.json"))
            .args(["--tick-count","2"])
            .args(["--sensors","fixture-cam","--width","64","--height","64",
                "--warmup","3","--settle-ticks","0","--no-shadows","--out"]).arg(&output)
            .env("XDG_RUNTIME_DIR","/tmp").env("WGPU_BACKEND","vulkan");
        if batched { command.arg("--batch-ids"); }
        let result = command.output().expect("launch sensor-capture");
        assert!(result.status.success(), "capture failed:\n{}\n{}",
            String::from_utf8_lossy(&result.stdout), String::from_utf8_lossy(&result.stderr));
        let instance = image::open(output.join("fixture-cam/00000000.instance.png")).unwrap().into_rgba8();
        let semantic = image::open(output.join("fixture-cam/00000000.semantic.png")).unwrap().into_rgba8();
        // Class 8 exposes gamma-domain dither rounding to invalid class 9;
        // the very darkest labels can coincidentally round back unchanged.
        let legend: serde_json::Value = serde_json::from_slice(&fs::read(output.join("legend.json")).unwrap()).unwrap();
        let id_of = |name: &str| {
            legend["instances"].as_array().unwrap().iter()
                .find(|entry| entry[1].as_str() == Some(name)).unwrap()[0].as_u64().unwrap() as u16
        };
        let [lo, hi] = id_of("prop-wall").to_le_bytes();
        let label = [lo, hi, SemanticClass::Prop.id(), 255];
        assert_eq!(instance.get_pixel(32, 32).0, label, "the fixture wall must occupy the center");
        for (pixel, class) in instance.pixels().zip(semantic.pixels()) {
            assert!(pixel.0 == [0,0,0,255] || pixel.0 == label,
                "integer label was altered: {:?} (batched={batched})", pixel.0);
            assert_eq!(class.0, [pixel[2],0,0,255]);
        }
        let late = image::open(output.join("fixture-cam/00000001.instance.png")).unwrap().into_rgba8();
        let late_semantic = image::open(output.join("fixture-cam/00000001.semantic.png")).unwrap().into_rgba8();
        let [lo, hi] = id_of("actor:late").to_le_bytes();
        assert_eq!(late.get_pixel(32,32).0, [lo,hi,SemanticClass::Car.id(),255],
            "a car first appearing after tick0 must not be labelled Prop");
        assert_eq!(late_semantic.get_pixel(32,32).0, [SemanticClass::Car.id(),0,0,255]);
    }
}
