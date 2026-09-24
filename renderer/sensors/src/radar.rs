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

/// The fewest rays per rendered frame a radar fan can cast. Submission
/// checks the same floor (`@simforge-oss/render` `NATIVE_RADAR_MIN_RAYS_PER_FRAME`).
pub const MIN_RAYS_PER_FRAME: u32 = 1;

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
    /// discretisation). The fan works at any size; a budget below one ray
    /// per frame is an error, never silently raised. (It used to be refused
    /// below 64 rays, a leftover of the old silent 64-ray clamp: the default
    /// 1500 points/s radar then failed at 24 and 30 fps.)
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
        if per_frame < MIN_RAYS_PER_FRAME {
            return Err(format!(
                "[native_radar_config_invalid] {points_per_second} points/s at {tick_hz} Hz is {per_frame} rays per frame; the radar model needs at least {MIN_RAYS_PER_FRAME}"
            ));
        }
        let side = ((per_frame as f32).sqrt().round() as u32).max(1);
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

#[cfg(test)]
mod budget_tests {
    use super::*;

    /// The render wizard's default radar (1500 points/s) at every frame rate
    /// the wizard offers (20, 24 and 30 fps; 24 fps renders at the scene's
    /// 23.999807 Hz): a valid fan whose size follows the budget.
    #[test]
    fn the_wizard_default_radar_renders_at_every_offered_frame_rate() {
        for (tick_hz, rays) in [(20.0f32, 81u32), (23.999807, 64), (30.0, 49)] {
            let config = RadarConfig::from_points_per_second(1_500, tick_hz, 60.0, 30.0, 100.0)
                .unwrap_or_else(|error| panic!("{tick_hz} Hz: {error}"));
            assert_eq!(
                config.azimuth_rays * config.elevation_rows,
                rays,
                "{tick_hz} Hz"
            );
        }
    }

    #[test]
    fn a_budget_below_one_ray_per_frame_is_refused_not_raised() {
        let error = RadarConfig::from_points_per_second(10, 30.0, 60.0, 30.0, 100.0).unwrap_err();
        assert!(
            error.contains("[native_radar_config_invalid]") && error.contains("0 rays per frame"),
            "{error}"
        );
        let one = RadarConfig::from_points_per_second(30, 30.0, 60.0, 30.0, 100.0).unwrap();
        assert_eq!((one.azimuth_rays, one.elevation_rows), (1, 1));
    }
}
