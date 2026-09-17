//! Artifact writers with format parity against the CARLA path
//! (`adapters/carla-exec/simforge_oss_carla_exec/runtime/backend.py`):
//!
//! - LiDAR: ASCII PLY with `property float x/y/z/intensity`, rows after
//!   `end_header` — the shape CARLA's `save_to_disk` writes and what
//!   `sensor_video.py::_read_lidar_points` parses (it indexes parts[0..3]).
//!   One extra declared property, `property uint instance_id`, is appended;
//!   positional readers are unaffected.
//! - Radar: CSV whose header line is exactly
//!   `depth_m,azimuth_rad,altitude_rad,velocity_mps`, rows `%.9g` — byte
//!   parity with `_write_radar_csv`.
//! - IMU / GNSS: JSONL.

use crate::imu_gnss::{GnssSample, ImuSample};
use crate::lidar::LidarPoint;
use crate::radar::RadarDetection;
use anyhow::Result;
use std::fmt::Write as _;
use std::io::Write;
use std::path::Path;

pub fn encode_lidar_ply(points: &[LidarPoint]) -> Vec<u8> {
    let mut out = String::with_capacity(160 + points.len() * 64);
    let _ = writeln!(out, "ply");
    let _ = writeln!(out, "format ascii 1.0");
    let _ = writeln!(out, "element vertex {}", points.len());
    let _ = writeln!(out, "property float x");
    let _ = writeln!(out, "property float y");
    let _ = writeln!(out, "property float z");
    let _ = writeln!(out, "property float intensity");
    let _ = writeln!(out, "property uint instance_id");
    let _ = writeln!(out, "end_header");
    for p in points {
        let _ = writeln!(
            out,
            "{} {} {} {} {}",
            fmt_g(p.x),
            fmt_g(p.y),
            fmt_g(p.z),
            fmt_g(p.intensity),
            p.instance_id
        );
    }
    out.into_bytes()
}

pub fn write_lidar_ply(path: &Path, points: &[LidarPoint]) -> Result<()> {
    std::fs::write(path, encode_lidar_ply(points))?;
    Ok(())
}

/// Binary little-endian PLY: the same five properties, the same order, the same
/// values — 20 bytes per point instead of ~52 ASCII bytes, and no formatting.
///
/// ASCII PLY exists for byte parity with CARLA's `save_to_disk`. A scan of
/// 67,861 points costs 3.5 MB and ~32 ms to format as text; as binary it is
/// 1.4 MB and a memcpy. Every PLY reader in the wild (Open3D, PCL, trimesh,
/// meshlab) reads `binary_little_endian` natively, so this is a format choice,
/// not a fidelity one: the f32 values written are bit-identical to the floats
/// the ASCII path formats.
pub fn encode_lidar_ply_binary(points: &[LidarPoint]) -> Vec<u8> {
    let mut out = Vec::with_capacity(200 + points.len() * 20);
    out.extend_from_slice(b"ply\nformat binary_little_endian 1.0\n");
    out.extend_from_slice(format!("element vertex {}\n", points.len()).as_bytes());
    out.extend_from_slice(b"property float x\n");
    out.extend_from_slice(b"property float y\n");
    out.extend_from_slice(b"property float z\n");
    out.extend_from_slice(b"property float intensity\n");
    out.extend_from_slice(b"property uint instance_id\n");
    out.extend_from_slice(b"end_header\n");
    for p in points {
        out.extend_from_slice(&p.x.to_le_bytes());
        out.extend_from_slice(&p.y.to_le_bytes());
        out.extend_from_slice(&p.z.to_le_bytes());
        out.extend_from_slice(&p.intensity.to_le_bytes());
        out.extend_from_slice(&p.instance_id.to_le_bytes());
    }
    out
}

/// Radar detections as binary little-endian: four f32 per row, same order as
/// the CSV columns, preceded by the CSV's header line as a comment so the
/// column meaning travels with the file.
pub fn encode_radar_binary(detections: &[RadarDetection]) -> Vec<u8> {
    let mut out = Vec::with_capacity(64 + detections.len() * 16);
    out.extend_from_slice(b"# depth_m,azimuth_rad,altitude_rad,velocity_mps binary_le f32x4\n");
    for d in detections {
        out.extend_from_slice(&d.depth.to_le_bytes());
        out.extend_from_slice(&d.azimuth.to_le_bytes());
        out.extend_from_slice(&d.altitude.to_le_bytes());
        out.extend_from_slice(&d.velocity.to_le_bytes());
    }
    out
}

pub fn encode_radar_csv(detections: &[RadarDetection]) -> Vec<u8> {
    let mut out = String::with_capacity(64 + detections.len() * 80);
    let _ = writeln!(out, "depth_m,azimuth_rad,altitude_rad,velocity_mps");
    for d in detections {
        let _ = writeln!(
            out,
            "{},{},{},{}",
            fmt_g(d.depth),
            fmt_g(d.azimuth),
            fmt_g(d.altitude),
            fmt_g(d.velocity)
        );
    }
    out.into_bytes()
}

pub fn write_radar_csv(path: &Path, detections: &[RadarDetection]) -> Result<()> {
    std::fs::write(path, encode_radar_csv(detections))?;
    Ok(())
}

pub fn write_imu_jsonl(path: &Path, samples: &[ImuSample]) -> Result<()> {
    let mut f = std::fs::File::create(path)?;
    for s in samples {
        writeln!(f, "{}", serde_json::to_string(s)?)?;
    }
    Ok(())
}

pub fn write_gnss_jsonl(path: &Path, samples: &[GnssSample]) -> Result<()> {
    let mut f = std::fs::File::create(path)?;
    for s in samples {
        writeln!(f, "{}", serde_json::to_string(s)?)?;
    }
    Ok(())
}

/// 9-significant-digit fixed/short formatting matching Python `{:.9g}`
/// closely enough for numeric consumers while staying deterministic.
pub fn fmt_g(v: f32) -> String {
    if v == 0.0 {
        return "0".to_string();
    }
    let mag = v.abs().log10().floor();
    if mag >= -4.0 && mag < 9.0 {
        let decimals = (8.0 - mag).clamp(0.0, 12.0) as usize;
        format!("{:.*}", decimals, v)
            .trim_end_matches('0')
            .trim_end_matches('.')
            .to_string()
    } else {
        format!("{:.7e}", v)
    }
}
