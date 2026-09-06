//! Lowering the authored perception layer onto a concrete site.
//!
//! Two jobs, both pure:
//!
//! 1. **Sensors.** A role's `sensors` are portable device descriptions; the
//!    engine wants one uniform angular envelope whatever the modality names
//!    its block.
//! 2. **Atmosphere.** Fog, rain, darkness and sun angle are already authored
//!    in `environment`, so they are derived from there rather than
//!    re-declared. Two sources of truth for the same fact is how a "heavy
//!    rain" preset and a `rainIntensity: 0.63` end up disagreeing.
//!
//! The preset-to-metres mapping is a table in one place on purpose: the
//! renderer, the friction model and the sensor model all have to agree on what
//! `fog_dense` means.

use simforge_core::types::{
    Atmosphere, DetectionModel, MapDivergence as SimMapDivergence,
    MapDivergenceExtent as SimDivergenceExtent, MapDivergenceKind as SimDivergenceKind,
    MountPosition, ScenePoint, SensorAperture, SensorMount, SensorRotation, SensorSensitivity,
    SensorType as SimSensorType, SimSensor, Sun,
};

use crate::geometry::to_rad;
use crate::template::{
    ActorSensor, Environment, MapDivergence, MapDivergenceExtent, MapDivergenceKind, SensorType,
    TimeOfDay, Weather,
};

/// Meteorological visibility, metres, per weather preset. A "dense fog"
/// warning is issued below about 50 m, "light fog"/mist sits in the low
/// hundreds, heavy rain cuts contrast to a few hundred metres; `20_000` is a
/// clear day.
pub fn weather_visibility_m(weather: Weather) -> f64 {
    match weather {
        Weather::Clear | Weather::Cloudy => 20_000.0,
        Weather::Overcast => 15_000.0,
        Weather::LightRain => 4_000.0,
        Weather::HeavyRain => 800.0,
        Weather::WetRoad => 8_000.0,
        Weather::FogLight => 400.0,
        Weather::FogDense => 60.0,
        Weather::Snow => 500.0,
        Weather::Sleet => 900.0,
    }
}

/// Precipitation rate, mm/h, per weather preset.
pub fn weather_precipitation_mm_per_h(weather: Weather) -> f64 {
    match weather {
        Weather::LightRain => 2.5,
        Weather::HeavyRain => 30.0,
        Weather::Sleet => 8.0,
        Weather::Snow => 5.0,
        _ => 0.0,
    }
}

/// Scene illumination as a fraction of full daylight, per time-of-day preset.
pub fn time_of_day_illumination(time_of_day: TimeOfDay) -> f64 {
    match time_of_day {
        TimeOfDay::Dawn => 0.25,
        TimeOfDay::Morning | TimeOfDay::Afternoon => 0.9,
        TimeOfDay::Noon => 1.0,
        TimeOfDay::Dusk => 0.2,
        TimeOfDay::Night => 0.012,
        TimeOfDay::NightLit => 0.05,
    }
}

/// Overcast and fog also cost light, on top of the hour.
fn weather_illumination_scale(weather: Weather) -> f64 {
    match weather {
        Weather::Overcast => 0.6,
        Weather::Cloudy => 0.8,
        Weather::HeavyRain => 0.45,
        Weather::FogLight => 0.6,
        Weather::FogDense => 0.35,
        Weather::Snow => 0.7,
        Weather::Sleet => 0.6,
        Weather::Clear | Weather::LightRain | Weather::WetRoad => 1.0,
    }
}

/// Derive the sensor-facing atmosphere from the authored `environment`.
///
/// The sun becomes a glare source only when it is *above* the horizon; a high
/// sun is geometrically incapable of being in frame and therefore costs
/// nothing. `sunAzimuthDeg` is clockwise from corridor-forward, so it is
/// rotated into the engine's `(x, y)` plane against the reference heading and
/// a glare scenario stays a glare scenario on a road that runs the other way.
pub fn atmosphere_from_environment(
    environment: &Environment,
    reference_heading_rad: f64,
    sun_elevation_deg: Option<f64>,
    sun_azimuth_deg: Option<f64>,
) -> Atmosphere {
    let illumination_frac = (time_of_day_illumination(environment.time_of_day)
        * weather_illumination_scale(environment.weather))
    .clamp(0.001, 1.0);
    let sun = match (sun_elevation_deg, sun_azimuth_deg) {
        (Some(elevation), Some(azimuth)) if elevation > 0.0 => Some(Sun {
            azimuth_rad: reference_heading_rad - to_rad(azimuth),
            elevation_rad: to_rad(elevation),
            half_angle_rad: 0.35,
            intensity: 0.9,
        }),
        _ => None,
    };
    Atmosphere {
        fog_visibility_m: weather_visibility_m(environment.weather),
        precipitation_mm_per_h: weather_precipitation_mm_per_h(environment.weather),
        illumination_frac,
        sun,
    }
}

/// Lower one authored sensor to the engine's uniform shape. Nothing here
/// switches on `type` except to carry the one camera-only field through.
pub fn lower_sensor(sensor: &ActorSensor) -> SimSensor {
    let aperture = sensor.aperture();
    SimSensor {
        id: sensor.id.clone(),
        label: sensor.label.clone(),
        enabled: sensor.enabled,
        mount: SensorMount {
            position: MountPosition {
                x: sensor.mount.position.x,
                y: sensor.mount.position.y,
                z: sensor.mount.position.z,
            },
            rotation: SensorRotation {
                yaw_rad: sensor.mount.rotation.yaw_rad,
                pitch_rad: sensor.mount.rotation.pitch_rad,
                roll_rad: sensor.mount.rotation.roll_rad,
            },
        },
        aperture: SensorAperture {
            horizontal_fov_deg: aperture.horizontal_fov_deg,
            vertical_fov_deg: aperture.vertical_fov_deg,
            near_m: aperture.near_m,
            far_m: aperture.far_m,
        },
        sensor_type: match sensor.sensor_type {
            SensorType::DashCamera => SimSensorType::DashCamera,
            SensorType::Lidar => SimSensorType::Lidar,
            SensorType::Radar => SimSensorType::Radar,
        },
        aspect_ratio: sensor.camera.map(|c| c.aspect_ratio),
        detection: DetectionModel {
            contrast_threshold: sensor.detection.contrast_threshold,
            min_angular_size_rad: sensor.detection.min_angular_size_rad,
            min_illumination_frac: sensor.detection.min_illumination_frac,
            detect_confidence: sensor.detection.detect_confidence,
            degraded_confidence: sensor.detection.degraded_confidence,
            sensitivity: SensorSensitivity {
                atmosphere: sensor.detection.sensitivity.atmosphere,
                illumination: sensor.detection.sensitivity.illumination,
                glare: sensor.detection.sensitivity.glare,
            },
            latch_s: sensor.detection.latch_s,
        },
    }
}

/// Lane windows a corridor-relative divergence covers, one per crossed lane.
#[derive(Debug, Clone, PartialEq)]
pub struct DivergenceWindow {
    pub rsl: String,
    pub s_min: f64,
    pub s_max: f64,
}

pub fn lower_divergence_kind(kind: MapDivergenceKind) -> SimDivergenceKind {
    match kind {
        MapDivergenceKind::LaneMarkingsFaded => SimDivergenceKind::LaneMarkingsFaded,
        MapDivergenceKind::LaneMarkingsObscured => SimDivergenceKind::LaneMarkingsObscured,
        MapDivergenceKind::LaneMarkingsRepainted => SimDivergenceKind::LaneMarkingsRepainted,
        MapDivergenceKind::LaneGeometryShifted => SimDivergenceKind::LaneGeometryShifted,
        MapDivergenceKind::LaneMissingFromMap => SimDivergenceKind::LaneMissingFromMap,
        MapDivergenceKind::LaneAbsentInWorld => SimDivergenceKind::LaneAbsentInWorld,
        MapDivergenceKind::ReflectorsMisaligned => SimDivergenceKind::ReflectorsMisaligned,
        MapDivergenceKind::SurfaceMisclassified => SimDivergenceKind::SurfaceMisclassified,
    }
}

/// Lower one declared divergence onto concrete extents.
///
/// `corridor` is a longitudinal fraction of the reference chain, so it becomes
/// one lane window per crossed leg — `s` restarts on every lane of a chain, so
/// the interval cannot be carried across as a pair of numbers. `aroundRole`
/// becomes a circle at the role's materialised pose; an absent role yields
/// nothing (the caller records why).
pub fn lower_map_divergence(
    divergence: &MapDivergence,
    windows: impl FnOnce(f64, f64, Option<i32>) -> Vec<DivergenceWindow>,
    role_pose: impl FnOnce(&str) -> Option<ScenePoint>,
) -> Vec<SimMapDivergence> {
    let common = |id: String, extent: SimDivergenceExtent| SimMapDivergence {
        id,
        kind: lower_divergence_kind(divergence.kind),
        extent,
        severity: divergence.severity,
        lateral_error_m: divergence.lateral_error_m,
        observers: divergence.observers.clone(),
        label: divergence.label.clone(),
    };
    match &divergence.extent {
        MapDivergenceExtent::AroundRole { role, radius_m } => match role_pose(role) {
            Some(center) => vec![common(
                divergence.id.clone(),
                SimDivergenceExtent::Circle {
                    center,
                    radius_m: *radius_m,
                },
            )],
            None => Vec::new(),
        },
        MapDivergenceExtent::Corridor {
            from_frac,
            to_frac,
            lane,
        } => {
            let windows = windows(*from_frac, *to_frac, *lane);
            let single = windows.len() == 1;
            windows
                .into_iter()
                .enumerate()
                .map(|(index, window)| {
                    let id = if single {
                        divergence.id.clone()
                    } else {
                        format!("{}:{index}", divergence.id)
                    };
                    common(
                        id,
                        SimDivergenceExtent::Lane {
                            rsl: window.rsl,
                            s_min: Some(window.s_min),
                            s_max: Some(window.s_max),
                        },
                    )
                })
                .collect()
        }
    }
}
