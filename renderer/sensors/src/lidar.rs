//! Deterministic spinning-lidar model.
//!
//! Beam pattern: `channels` elevation rings evenly spaced across the vertical
//! FOV, and an azimuth resolution derived from
//! `points_per_second / (channels * rotation_frequency_hz)` — i.e. the number
//! of azimuth steps per revolution CARLA's rotational lidar would produce.
//! One captured scan is one full revolution starting at azimuth step 0.
//!
//! Each beam is raycast against the scene BVH. Returns per point:
//! sensor-frame `{x, y, z}`, an intensity proxy, and the owning instance id.
//! Points are emitted in strict (channel, azimuth) order for hash stability.

use crate::bvh::{Hit, Raycast};
use crate::taxonomy::{lidar_albedo, SemanticClass};
use bevy::math::{Quat, Vec3};
use crate::RAY_POOL;
use render_core::coordinates::SensorFrame;

#[derive(Debug, Clone)]
pub struct LidarConfig {
    pub channels: u32,
    pub rotation_frequency_hz: f32,
    pub points_per_second: u32,
    /// Vertical FOV extent in degrees: beams span [-vfov/2, +vfov/2].
    pub vfov_deg: f32,
    /// Horizontal coverage in degrees; 360 = full rotation.
    pub hfov_deg: f32,
    pub range_m: f32,
}

impl LidarConfig {
    /// Azimuth steps per revolution the model supports.
    pub const AZIMUTH_STEPS: std::ops::RangeInclusive<u32> = 64..=4096;

    /// Reject a configuration the scan would otherwise reshape (the clamps in
    /// [`Self::azimuth_steps`] and `channels.max(1)` in [`scan`]): the render
    /// service validates every declared lidar with this before scanning.
    pub fn validate(&self) -> Result<(), String> {
        let bad = |what: String| Err(format!("[native_lidar_config_invalid] {what}"));
        if self.channels == 0 {
            return bad("channels is 0".into());
        }
        if !(self.rotation_frequency_hz.is_finite() && self.rotation_frequency_hz > 0.0) {
            return bad(format!("rotation frequency {} Hz", self.rotation_frequency_hz));
        }
        if self.points_per_second == 0 {
            return bad("points per second is 0".into());
        }
        if !(self.hfov_deg.is_finite() && self.hfov_deg > 0.0 && self.hfov_deg <= 360.0) {
            return bad(format!("horizontal FOV {} deg (0, 360]", self.hfov_deg));
        }
        if !(self.vfov_deg.is_finite() && self.vfov_deg > 0.0 && self.vfov_deg < 180.0) {
            return bad(format!("vertical FOV {} deg (0, 180)", self.vfov_deg));
        }
        if !(self.range_m.is_finite() && self.range_m > 0.0) {
            return bad(format!("range {} m", self.range_m));
        }
        let per_channel =
            (self.points_per_second as f32 / (self.channels as f32 * self.rotation_frequency_hz)).round() as u32;
        if !Self::AZIMUTH_STEPS.contains(&per_channel) {
            return bad(format!(
                "{} points/s over {} channels at {} Hz is {per_channel} azimuth steps per revolution; the model supports {:?}",
                self.points_per_second, self.channels, self.rotation_frequency_hz, Self::AZIMUTH_STEPS
            ));
        }
        Ok(())
    }

    pub fn azimuth_steps(&self) -> u32 {
        if self.rotation_frequency_hz <= 0.0 || self.channels == 0 {
            return 360;
        }
        let per_channel =
            self.points_per_second as f32 / (self.channels as f32 * self.rotation_frequency_hz);
        (per_channel.round() as u32).clamp(64, 4096)
    }
}

pub struct LidarPoint {
    /// Sensor-local metres: +X forward, +Y up, +Z lateral (camera-right).
    pub x: f32,
    pub y: f32,
    pub z: f32,
    /// Intensity proxy in [0, 1].
    pub intensity: f32,
    pub instance_id: u32,
}

/// Beam direction in the sensor frame: azimuth 0 = forward, positive toward
/// +z; elevation positive up. See render_core::coordinates for the basis.
fn beam_dir(azimuth_rad: f32, elevation_rad: f32) -> Vec3 {
    let cos_e = elevation_rad.cos();
    Vec3::new(cos_e * azimuth_rad.cos(), elevation_rad.sin(), cos_e * azimuth_rad.sin())
}

/// The beams of one full scan, world-space directions in strict
/// `(channel, azimuth)` order, plus the sensor frame the points are
/// expressed in. [`scan`] and [`points_from_hits`] share this so a scan
/// traced elsewhere (the hardware-ray backend) uses the very same rays.
pub fn beams(config: &LidarConfig, sensor_origin_world: Vec3, sensor_rot_world: Quat) -> (SensorFrame, Vec<Vec3>) {
    let frame = SensorFrame::from_bevy_pose(sensor_origin_world, sensor_rot_world);
    let channels = config.channels.max(1);
    let az_steps = config.azimuth_steps();
    let hfov_span = if config.hfov_deg >= 359.999 { 360.0 } else { config.hfov_deg };
    let az_offset = if config.hfov_deg >= 359.999 { 0.0 } else { hfov_span.to_radians() * 0.5 };
    let mut dirs = Vec::with_capacity((channels * az_steps) as usize);
    for ch in 0..channels {
        // Evenly spaced elevations across [-vfov/2, +vfov/2], top-down.
        let frac = if channels > 1 { ch as f32 / (channels - 1) as f32 } else { 0.5 };
        let elev = (config.vfov_deg * (0.5 - frac)).to_radians();
        for step in 0..az_steps {
            let az = (step as f32 / az_steps as f32) * hfov_span.to_radians() - az_offset;
            dirs.push(frame.direction_to_world(beam_dir(az, elev)));
        }
    }
    (frame, dirs)
}

/// Points of a scan from its per-beam first hits (`hits[i]` for `dirs[i]`),
/// in beam order; misses emit nothing.
pub fn points_from_hits(
    frame: SensorFrame,
    dirs: &[Vec3],
    hits: &[Option<Hit>],
    instance_class: &(dyn Fn(u32) -> SemanticClass + Sync),
) -> Vec<LidarPoint> {
    dirs.iter()
        .zip(hits)
        .filter_map(|(dir, hit)| {
            let hit = hit.as_ref()?;
            let local = frame.point_to_sensor(hit.point);
            Some(LidarPoint {
                x: local.x,
                y: local.y,
                z: local.z,
                intensity: intensity_proxy(hit, *dir, instance_class),
                instance_id: hit.instance_id,
            })
        })
        .collect()
}

/// Cast one full scan.
///
/// `instance_class` resolves a hit instance id to its semantic class for the
/// intensity proxy.
///
/// Elevation rings are cast in parallel — one task per channel — and the
/// per-channel point lists are concatenated in channel order, so the emitted
/// order is the same strict `(channel, azimuth)` sequence a serial scan
/// produces and scan hashes are unaffected by thread scheduling.
pub fn scan(
    scene: &dyn Raycast,
    config: &LidarConfig,
    sensor_origin_world: Vec3,
    sensor_rot_world: Quat,
    instance_class: &(dyn Fn(u32) -> SemanticClass + Sync),
) -> Vec<LidarPoint> {
    let (frame, dirs) = beams(config, sensor_origin_world, sensor_rot_world);
    let az_steps = config.azimuth_steps() as usize;
    let range_m = config.range_m;
    let rings: Vec<Vec<LidarPoint>> = RAY_POOL.scope(|scope| {
        for ring in dirs.chunks(az_steps.max(1)) {
            scope.spawn(async move {
                let hits: Vec<Option<Hit>> =
                    ring.iter().map(|dir| scene.cast(sensor_origin_world, *dir, range_m)).collect();
                points_from_hits(frame, ring, &hits, instance_class)
            });
        }
    });
    rings.into_iter().flatten().collect()
}

/// Intensity proxy: albedo(class) x (0.25 + 0.75 x |cos incidence|), clamped
/// to [0,1] — a deterministic, physically-motivated stand-in for reflectivity
/// (documented in TAXONOMY.md).
fn intensity_proxy(
    hit: &Hit,
    beam_dir_world: Vec3,
    instance_class: &dyn Fn(u32) -> SemanticClass,
) -> f32 {
    let class = instance_class(hit.instance_id);
    let cosine = hit.normal.dot(-beam_dir_world.normalize_or_zero()).abs();
    lidar_albedo(class).mul_add(0.25 + 0.75 * cosine, 0.0).clamp(0.0, 1.0)
}
