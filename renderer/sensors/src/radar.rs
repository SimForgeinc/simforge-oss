//! Deterministic radar model: ray fan + radial velocity from exact
//! scene-state velocities.
//!
//! Beam layout: a uniform azimuth x elevation grid across the declared FOV
//! (CARLA's radar is a fixed fan, no rotation). A ray that hits within range
//! yields one detection with
//!
//! - `depth_m`: hit distance along the beam,
//! - `azimuth_rad`: atan2(right, forward) of the beam in the sensor frame,
//! - `altitude_rad`: elevation of the beam,
//! - `velocity_mps`: relative radial velocity — projection of
//!   `(target velocity − sensor-host velocity)` onto the unit beam; static
//!   geometry returns minus the host motion component.
//!
//! Rows are emitted in strict (azimuth, elevation) order for hash stability;
//! format parity with carla-bridge's `_write_radar_csv` lives in
//! `formats::write_radar_csv`.

use crate::bvh::{Hit, Raycast};
use crate::RAY_POOL;
use bevy::math::{Quat, Vec3};
use render_core::coordinates::SensorFrame;

#[derive(Debug, Clone)]
pub struct RadarConfig {
    pub hfov_deg: f32,
    pub vfov_deg: f32,
    pub range_m: f32,
    /// Azimuth rays across the FOV (uniform).
    pub azimuth_rays: u32,
    /// Elevation rows across the FOV (uniform).
    pub elevation_rows: u32,
}

impl RadarConfig {
    /// The per-frame ray budget is exactly `points_per_second / tick_hz` (rounded), laid out
    /// as the model's square azimuth x elevation grid (the fan's documented
    /// discretisation). A budget the model cannot honour is an error, never
    /// silently raised to the 64-ray floor.
    pub fn from_points_per_second(
        points_per_second: u32,
        tick_hz: f32,
        hfov_deg: f32,
        vfov_deg: f32,
        range_m: f32,
    ) -> Result<RadarConfig, String> {
        if !(tick_hz.is_finite() && tick_hz > 0.0) {
            return Err(format!(
                "[native_radar_config_invalid] tick rate {tick_hz} Hz"
            ));
        }
        let per_frame = (points_per_second as f32 / tick_hz).round() as u32;
        if per_frame < 64 {
            return Err(format!(
                "[native_radar_config_invalid] {points_per_second} points/s at {tick_hz} Hz is {per_frame} rays per frame; the radar model needs at least 64"
            ));
        }
        let side = (per_frame as f32).sqrt().round() as u32;
        Ok(RadarConfig {
            hfov_deg,
            vfov_deg,
            range_m,
            azimuth_rays: side,
            elevation_rows: side,
        })
    }
}

pub struct RadarDetection {
    pub depth: f32,
    /// Positive azimuth points toward sensor +Z (camera-right at zero heading).
    pub azimuth: f32,
    /// Positive = up.
    pub altitude: f32,
    /// Relative radial velocity in m/s along the beam.
    pub velocity: f32,
}

/// One radar beam: its fan angles and world-space direction.
#[derive(Clone, Copy, Debug)]
pub struct RadarBeam {
    pub azimuth: f32,
    pub altitude: f32,
    pub dir_world: Vec3,
}

/// The fan of one scan in strict (azimuth, elevation) order. [`scan`] and a
/// scan traced elsewhere (the hardware-ray backend) share this, so both cast
/// the very same f32 rays.
pub fn beams(config: &RadarConfig, origin: Vec3, rot: Quat) -> Vec<RadarBeam> {
    let frame = SensorFrame::from_bevy_pose(origin, rot);
    let (azimuth_rays, elevation_rows) = (config.azimuth_rays, config.elevation_rows);
    let hfov_rad = config.hfov_deg.to_radians();
    let vfov_rad = config.vfov_deg.to_radians();
    let mut out = Vec::with_capacity((azimuth_rays * elevation_rows) as usize);
    for az_i in 0..azimuth_rays {
        // Uniform azimuths centered on forward.
        let az = if azimuth_rays > 1 {
            (az_i as f32 / (azimuth_rays - 1) as f32 - 0.5) * hfov_rad
        } else {
            0.0
        };
        for el_j in 0..elevation_rows {
            let el = if elevation_rows > 1 {
                (el_j as f32 / (elevation_rows - 1) as f32 - 0.5) * vfov_rad
            } else {
                0.0
            };
            // Rig basis: azimuth toward +Z, elevation toward +Y.
            let cos_e = el.cos();
            let dir_sensor = Vec3::new(cos_e * az.cos(), el.sin(), cos_e * az.sin());
            out.push(RadarBeam {
                azimuth: az,
                altitude: el,
                dir_world: frame.direction_to_world(dir_sensor),
            });
        }
    }
    out
}

/// Detections of a scan from its per-beam first hits (`hits[i]` for
/// `beams[i]`), in beam order; misses emit nothing.
pub fn detections_from_hits(
    beams: &[RadarBeam],
    hits: &[Option<Hit>],
    host_velocity: Vec3,
    instance_velocity: &(dyn Fn(u32) -> Vec3 + Sync),
) -> Vec<RadarDetection> {
    beams
        .iter()
        .zip(hits)
        .filter_map(|(beam, hit)| {
            let hit = hit.as_ref()?;
            let rel = instance_velocity(hit.instance_id) - host_velocity;
            let beam_unit = beam.dir_world.normalize_or_zero();
            Some(RadarDetection {
                depth: hit.distance,
                azimuth: beam.azimuth,
                altitude: beam.altitude,
                velocity: rel.dot(beam_unit),
            })
        })
        .collect()
}

/// `instance_velocity` maps an instance id to its world-frame velocity (m/s);
/// static geometry maps to zero. `host_velocity` is the sensor host's
/// world-frame velocity.
///
/// Azimuth columns are cast in parallel — one task per azimuth — and the
/// per-column detections are concatenated in azimuth order, so emitted rows
/// keep the strict (azimuth, elevation) order a serial fan produces.
pub fn scan(
    scene: &dyn Raycast,
    config: &RadarConfig,
    origin: Vec3,
    rot: Quat,
    host_velocity: Vec3,
    instance_velocity: &(dyn Fn(u32) -> Vec3 + Sync),
) -> Vec<RadarDetection> {
    if config.azimuth_rays == 0 || config.elevation_rows == 0 {
        return Vec::new();
    }
    let all = beams(config, origin, rot);
    let range_m = config.range_m;
    let columns: Vec<Vec<RadarDetection>> = RAY_POOL.scope(|scope| {
        for column in all.chunks(config.elevation_rows as usize) {
            scope.spawn(async move {
                let hits: Vec<Option<Hit>> = column
                    .iter()
                    .map(|beam| scene.cast(origin, beam.dir_world, range_m))
                    .collect();
                detections_from_hits(column, &hits, host_velocity, instance_velocity)
            });
        }
    });
    columns.into_iter().flatten().collect()
}
