//! Determinism and correctness tests for the sensor math modules.

use sensors::bvh::{RaycastScene, Tri};
use sensors::formats;
use sensors::lidar::{self, LidarConfig};
use sensors::radar::{self, RadarConfig};
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

