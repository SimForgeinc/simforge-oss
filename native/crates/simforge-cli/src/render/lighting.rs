//! The scenario's environment as the native renderer's `Lighting`: the port
//! of packages/render/src/native/lighting.ts and the environment-extension
//! parsers it uses (packages/scenario/src/studio-contracts/editor-environment-policy.ts).
//!
//! The sun is placed at the map's own site (its OpenDRIVE `geoReference`) by
//! the NOAA solar model on the scene clock (local civil time there), with the
//! Lookdev Lab's weather presets. Nothing is silently substituted: a
//! malformed extension block, an explicit sun the renderer cannot place,
//! weather it cannot draw, or a site without a known civil time fails.
//!
//! Transcendentals go through `simforge_core::math` (bit-exact ports of V8's
//! fdlibm), so the angles are the TypeScript engine's to the last bit.

use std::sync::OnceLock;

use regex::Regex;
use serde::Serialize;
use serde_json::{json, Map, Value};
use simforge_core::math::{acos, cos, sin};

use super::canonical::{js_round, num};
use crate::contract::CliError;

/// Day of year the scene clock runs on (the scenario has no date).
pub const DEFAULT_DAY_OF_YEAR: u32 = 172;
pub const SCENE_TIME_EXTENSION_KEY: &str = "org.simforge.sceneTime.v1";
pub const LIGHTING_EXTENSION_KEY: &str = "org.simforge.lighting.v1";
pub const LIGHTING_SCALE_REVISION: f64 = 2.0;

pub const WEATHER_PRESETS: &[&str] = &[
    "clear",
    "cloudy",
    "overcast",
    "light_rain",
    "heavy_rain",
    "wet_road",
    "fog_light",
    "fog_dense",
    "snow",
    "sleet",
];
pub const TIME_OF_DAY_PRESETS: &[&str] = &[
    "dawn",
    "morning",
    "noon",
    "afternoon",
    "dusk",
    "night",
    "night_lit",
];
/// `DEFAULT_WEATHER` / `DEFAULT_TIME_OF_DAY` (packages/scenario environment.ts).
pub const DEFAULT_WEATHER: &str = "cloudy";
pub const DEFAULT_TIME_OF_DAY: &str = "dusk";

/// `LIGHTING_RANGES`: the authored lighting knobs and their bounds.
const LIGHTING_RANGES: &[(&str, f64, f64)] = &[
    ("ambient", 0.0, 5.0),
    ("sun", 0.0, 4.0),
    ("sunWarmth", -1.0, 1.0),
    ("exposure", 0.1, 3.0),
    ("sky", 0.0, 3.0),
    ("visibilityM", 20.0, 120_000.0),
    ("haze", 0.0, 1.0),
];

fn input(code: &str, reason: impl Into<String>) -> CliError {
    CliError::findings(code, reason)
}

fn extension_invalid(extension: &str, reason: impl std::fmt::Display) -> CliError {
    input(
        "render_environment_extension_invalid",
        format!("scenario environment extension {extension}: {reason}"),
    )
    .with_detail(json!({ "extension": extension }))
}

/// Where and in which civil time the scene clock runs: the map origin.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LightingSite {
    pub latitude_deg: f64,
    pub longitude_deg: f64,
    pub utc_offset_hours: f64,
    pub time_zone: String,
}

struct Zone {
    time_zone: &'static str,
    utc_offset_hours: f64,
    latitude: (f64, f64),
    longitude: (f64, f64),
}

/// `SITE_TIME_ZONES`: civil zones the scene clock can run in (summer time on
/// day 172). A site outside every zone is refused.
const SITE_TIME_ZONES: &[Zone] = &[
    Zone {
        time_zone: "America/Los_Angeles (PDT)",
        utc_offset_hours: -7.0,
        latitude: (32.5, 49.0),
        longitude: (-124.8, -114.0),
    },
    Zone {
        time_zone: "Europe/Berlin (CEST)",
        utc_offset_hours: 2.0,
        latitude: (45.8, 55.1),
        longitude: (2.5, 24.2),
    },
];

/// `nativeLightingSiteFromOpenDrive`: the transverse Mercator origin
/// (`+lat_0`, `+lon_0`) of the OpenDRIVE `geoReference`, and its civil zone.
pub fn lighting_site_from_opendrive(xodr: &str, map_id: &str) -> Result<LightingSite, CliError> {
    static GEO: OnceLock<Regex> = OnceLock::new();
    static TMERC: OnceLock<Regex> = OnceLock::new();
    let geo = GEO.get_or_init(|| {
        Regex::new(r"<geoReference>\s*(?:<!\[CDATA\[)?([^<\]]*)(?:\]\]>)?\s*</geoReference>")
            .expect("regex")
    });
    let unknown = |why: String| input("native_lighting_site_unknown", why);
    let reference = geo
        .captures(xodr)
        .map(|c| c[1].trim().to_owned())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            unknown(format!(
                "map {map_id} has no OpenDRIVE geoReference; the sun cannot be placed"
            ))
        })?;
    let parameter = |name: &str| -> Option<f64> {
        let re = Regex::new(&format!(r"(?:^|\s)\+{name}=(-?[0-9.]+)(?:\s|$)")).expect("regex");
        re.captures(&reference)
            .and_then(|c| c[1].parse::<f64>().ok())
            .filter(|v| v.is_finite())
    };
    let latitude = parameter("lat_0");
    let longitude = parameter("lon_0");
    let tmerc = TMERC.get_or_init(|| Regex::new(r"(?:^|\s)\+proj=tmerc(?:\s|$)").expect("regex"));
    let (Some(latitude_deg), Some(longitude_deg)) = (latitude, longitude) else {
        return Err(unknown(format!(
            "map {map_id} geoReference \"{reference}\" is not a transverse Mercator origin with +lat_0/+lon_0"
        )));
    };
    if !tmerc.is_match(&reference) || latitude_deg.abs() > 90.0 || longitude_deg.abs() > 180.0 {
        return Err(unknown(format!(
            "map {map_id} geoReference \"{reference}\" is not a transverse Mercator origin with +lat_0/+lon_0"
        )));
    }
    let zone = SITE_TIME_ZONES
        .iter()
        .find(|z| {
            latitude_deg >= z.latitude.0
                && latitude_deg <= z.latitude.1
                && longitude_deg >= z.longitude.0
                && longitude_deg <= z.longitude.1
        })
        .ok_or_else(|| {
            unknown(format!(
                "map {map_id} lies at {latitude_deg}, {longitude_deg}, where the scene clock has no known civil time zone"
            ))
        })?;
    Ok(LightingSite {
        latitude_deg,
        longitude_deg,
        utc_offset_hours: zone.utc_offset_hours,
        time_zone: zone.time_zone.to_owned(),
    })
}

/// The lab's `WEATHER_PRESETS` entry a scenario weather maps to.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WeatherPreset {
    pub weather: &'static str,
    pub cloud_cover: f64,
    pub visibility_m: f64,
    pub haze: f64,
    pub wetness: f64,
    pub turbidity: f64,
    pub cloud_type: f64,
    pub cloud_base_m: f64,
    pub cloud_top_m: f64,
    pub cloud_density: f64,
}

const CLEAR: WeatherPreset = WeatherPreset {
    weather: "clear",
    cloud_cover: 0.0,
    visibility_m: 25_000.0,
    haze: 0.0,
    wetness: 0.0,
    turbidity: 2.4,
    cloud_type: 0.85,
    cloud_base_m: 1200.0,
    cloud_top_m: 2800.0,
    cloud_density: 1.0,
};
const CLOUDY: WeatherPreset = WeatherPreset {
    weather: "cloudy",
    cloud_cover: 0.45,
    visibility_m: 20_000.0,
    haze: 0.03,
    wetness: 0.0,
    turbidity: 2.8,
    cloud_type: 0.85,
    cloud_base_m: 1200.0,
    cloud_top_m: 2800.0,
    cloud_density: 1.0,
};
const OVERCAST: WeatherPreset = WeatherPreset {
    weather: "overcast",
    cloud_cover: 0.95,
    visibility_m: 12_000.0,
    haze: 0.10,
    wetness: 0.05,
    turbidity: 3.2,
    cloud_type: 0.15,
    cloud_base_m: 700.0,
    cloud_top_m: 1900.0,
    cloud_density: 1.4,
};
const FOG: WeatherPreset = WeatherPreset {
    weather: "fog",
    cloud_cover: 0.75,
    visibility_m: 150.0,
    haze: 0.20,
    wetness: 0.15,
    turbidity: 3.0,
    cloud_type: 0.10,
    cloud_base_m: 400.0,
    cloud_top_m: 1200.0,
    cloud_density: 1.4,
};
const RAIN: WeatherPreset = WeatherPreset {
    weather: "rain",
    cloud_cover: 0.90,
    visibility_m: 3_000.0,
    haze: 0.10,
    wetness: 0.85,
    turbidity: 2.6,
    cloud_type: 0.30,
    cloud_base_m: 500.0,
    cloud_top_m: 2600.0,
    cloud_density: 1.8,
};

/// `weatherPreset`: scenario weather -> renderer air mass. Snow and sleet
/// are refused (the renderer draws neither).
pub fn weather_preset(weather: &str) -> Result<WeatherPreset, CliError> {
    Ok(match weather {
        "clear" => CLEAR,
        "cloudy" => CLOUDY,
        "overcast" => OVERCAST,
        "light_rain" => WeatherPreset {
            cloud_cover: 0.85,
            visibility_m: 8_000.0,
            wetness: 0.6,
            ..RAIN
        },
        "heavy_rain" => WeatherPreset {
            visibility_m: 1_500.0,
            wetness: 1.0,
            ..RAIN
        },
        "wet_road" => WeatherPreset {
            wetness: 0.7,
            ..OVERCAST
        },
        "fog_light" => WeatherPreset {
            cloud_cover: 0.6,
            visibility_m: 600.0,
            wetness: 0.1,
            ..FOG
        },
        "fog_dense" => FOG,
        "snow" | "sleet" => {
            return Err(input(
                "native_weather_unsupported",
                format!("the native renderer cannot draw {weather}"),
            ))
        }
        other => {
            return Err(input(
                "render_environment_invalid",
                format!("unknown scenario weather {other:?}"),
            ))
        }
    })
}

/// `PRESET_MINUTES`: Studio's minutes for a time-of-day preset.
pub fn preset_minutes(time_of_day: &str) -> Result<f64, CliError> {
    Ok(match time_of_day {
        "dawn" => 360.0,
        "morning" => 540.0,
        "noon" => 720.0,
        "afternoon" => 900.0,
        "dusk" => 1080.0,
        "night" => 0.0,
        "night_lit" => 1260.0,
        other => {
            return Err(input(
                "render_environment_invalid",
                format!("unknown time of day {other:?}"),
            ))
        }
    })
}

fn extension<'a>(environment: &'a Value, key: &str) -> Option<&'a Value> {
    environment.get("extensions").and_then(|e| e.get(key))
}

/// `parseRenderSceneMinutes`: the exact authored clock in [0, 1440), or `None`.
pub fn parse_scene_minutes(environment: &Value) -> Result<Option<f64>, CliError> {
    let Some(block) = extension(environment, SCENE_TIME_EXTENSION_KEY) else {
        return Ok(None);
    };
    let Some(object) = block.as_object() else {
        return Err(extension_invalid(
            SCENE_TIME_EXTENSION_KEY,
            "is not an object",
        ));
    };
    let minutes = object
        .get("minutes")
        .and_then(Value::as_f64)
        .filter(|m| m.is_finite())
        .ok_or_else(|| extension_invalid(SCENE_TIME_EXTENSION_KEY, "has no finite minutes"))?;
    Ok(Some(((minutes % 1440.0) + 1440.0) % 1440.0))
}

/// `sceneMinutes`: the exact clock, else the preset's minutes.
pub fn scene_minutes(environment: &Value) -> Result<f64, CliError> {
    match parse_scene_minutes(environment)? {
        Some(m) => Ok(m),
        None => preset_minutes(environment["timeOfDay"].as_str().unwrap_or_default()),
    }
}

/// `parseRenderLightingOverrides`: the authored lighting block, strictly.
/// Returns the overrides in the block's key order.
pub fn parse_lighting_overrides(environment: &Value) -> Result<Vec<(String, f64)>, CliError> {
    let Some(block) = extension(environment, LIGHTING_EXTENSION_KEY) else {
        return Ok(Vec::new());
    };
    let Some(record) = block.as_object() else {
        return Err(extension_invalid(
            LIGHTING_EXTENSION_KEY,
            "is not an object",
        ));
    };
    if record.get("scaleRevision").and_then(Value::as_f64) != Some(LIGHTING_SCALE_REVISION) {
        let revision = record
            .get("scaleRevision")
            .map_or("undefined".to_owned(), |v| v.to_string());
        return Err(extension_invalid(
            LIGHTING_EXTENSION_KEY,
            format!("scaleRevision {revision} is not the current lighting scale (2); re-save the scenario's lighting"),
        ));
    }
    let mut out = Vec::new();
    for (key, value) in record {
        if key == "scaleRevision" {
            continue;
        }
        let Some((_, min, max)) = LIGHTING_RANGES.iter().find(|(f, _, _)| f == key) else {
            return Err(extension_invalid(
                LIGHTING_EXTENSION_KEY,
                format!("unknown field {key}"),
            ));
        };
        let v = value.as_f64().filter(|v| v.is_finite()).ok_or_else(|| {
            extension_invalid(
                LIGHTING_EXTENSION_KEY,
                format!("{key} is not a finite number"),
            )
        })?;
        if v < *min || v > *max {
            return Err(extension_invalid(
                LIGHTING_EXTENSION_KEY,
                format!("{key} {v} is outside [{min}, {max}]"),
            ));
        }
        out.push((key.clone(), v));
    }
    Ok(out)
}

/// `sceneClockSunAngles`: the display sun Studio writes beside an exact clock.
pub fn scene_clock_sun_angles(minutes: f64) -> (f64, f64) {
    let value = ((js_round(minutes) % 1440.0) + 1440.0) % 1440.0;
    let daylight = (value - 360.0) / 720.0;
    let elevation = f64::max(-12.0, 65.0 * sin(std::f64::consts::PI * daylight));
    (value / 4.0, js_round(elevation * 100.0) / 100.0)
}

/// NOAA low-precision solar position (the lab's `solar_position`), degrees
/// to three decimals: `(elevation, compass azimuth)`.
pub fn solar_position(
    time_minutes: f64,
    day_of_year: f64,
    latitude_deg: f64,
    longitude_deg: f64,
    utc_offset_hours: f64,
) -> (f64, f64) {
    let pi = std::f64::consts::PI;
    let gamma = 2.0 * pi / 365.0 * (day_of_year - 1.0 + (time_minutes / 60.0 - 12.0) / 24.0);
    let eqtime = 229.18
        * (0.000075 + 0.001868 * cos(gamma)
            - 0.032077 * sin(gamma)
            - 0.014615 * cos(2.0 * gamma)
            - 0.040849 * sin(2.0 * gamma));
    let decl = 0.006918 - 0.399912 * cos(gamma) + 0.070257 * sin(gamma)
        - 0.006758 * cos(2.0 * gamma)
        + 0.000907 * sin(2.0 * gamma)
        - 0.002697 * cos(3.0 * gamma)
        + 0.00148 * sin(3.0 * gamma);
    let time_offset = eqtime + 4.0 * longitude_deg - 60.0 * utc_offset_hours;
    let true_solar = time_minutes + time_offset;
    let hour_angle = (true_solar / 4.0 - 180.0) * pi / 180.0;
    let lat = latitude_deg * pi / 180.0;
    // `clamp` propagates NaN as `Math.max(-1, Math.min(1, v))` does.
    let cos_zenith =
        (sin(lat) * sin(decl) + cos(lat) * cos(decl) * cos(hour_angle)).clamp(-1.0, 1.0);
    let zenith = acos(cos_zenith);
    let elevation = 90.0 - zenith * 180.0 / pi;
    let denom = cos(lat) * sin(zenith);
    let azimuth = if denom.abs() < 1e-9 {
        180.0
    } else {
        let cos_az = ((sin(lat) * cos_zenith - sin(decl)) / denom).clamp(-1.0, 1.0);
        let a = acos(cos_az) * 180.0 / pi;
        if hour_angle > 0.0 {
            360.0 - a
        } else {
            a
        }
    };
    (
        js_round(elevation * 1000.0) / 1000.0,
        js_round((((azimuth % 360.0) + 360.0) % 360.0) * 1000.0) / 1000.0,
    )
}

/// `assertNoExplicitSun`: authored sun angles are refused unless they are the
/// exact clock's own display sun.
fn assert_no_explicit_sun(environment: &Value, exact_minutes: Option<f64>) -> Result<(), CliError> {
    let azimuth = environment.get("sunAzimuthDeg");
    let elevation = environment.get("sunElevationDeg");
    if azimuth.is_none() && elevation.is_none() {
        return Ok(());
    }
    if let (Some(minutes), Some(a), Some(e)) = (
        exact_minutes,
        azimuth.and_then(Value::as_f64),
        elevation.and_then(Value::as_f64),
    ) {
        let (da, de) = scene_clock_sun_angles(minutes);
        if (a - da).abs() < 1e-6 && (e - de).abs() < 1e-6 {
            return Ok(());
        }
    }
    let show = |v: Option<&Value>| v.map_or("undefined".to_owned(), |v| v.to_string());
    Err(input(
        "native_lighting_sun_override_unsupported",
        format!(
            "the scenario authors its own sun (azimuth {} deg corridor-relative, elevation {} deg); the native renderer places the sun from the scene clock and cannot resolve a corridor-relative azimuth",
            show(azimuth),
            show(elevation)
        ),
    ))
}

/// `NativeLightingResolution`: the wire `lighting` and what decided it.
#[derive(Debug, Clone, PartialEq)]
pub struct LightingResolution {
    /// `render_core::engine::Lighting`, wire form (the scene spec's `lighting`).
    pub lighting: Value,
    pub provenance: Value,
}

/// `resolveNativeLighting`. `cloud_fixed_step_s` defaults to 1/30 as in
/// TypeScript; the engine passes [`cloud_fixed_step_s`] of the RGB schedules.
pub fn resolve_native_lighting(
    environment: &Value,
    site: &LightingSite,
    day_of_year: Option<u32>,
    cloud_fixed_step_s: Option<f64>,
) -> Result<LightingResolution, CliError> {
    let weather = environment["weather"].as_str().unwrap_or_default();
    let preset = weather_preset(weather)?;
    let exact = parse_scene_minutes(environment)?;
    let minutes = match exact {
        Some(m) => m,
        None => preset_minutes(environment["timeOfDay"].as_str().unwrap_or_default())?,
    };
    assert_no_explicit_sun(environment, exact)?;
    let day = f64::from(day_of_year.unwrap_or(DEFAULT_DAY_OF_YEAR));
    let (elevation, azimuth) = solar_position(
        minutes,
        day,
        site.latitude_deg,
        site.longitude_deg,
        site.utc_offset_hours,
    );
    let overrides = parse_lighting_overrides(environment)?;
    let get = |k: &str| overrides.iter().find(|(f, _)| f == k).map(|(_, v)| *v);
    if let Some(warmth) = get("sunWarmth").filter(|w| *w != 0.0) {
        return Err(input(
            "native_lighting_sun_warmth_unsupported",
            format!("authored sunWarmth {warmth} has no counterpart in the native renderer's physical sun"),
        ));
    }
    let shifted = minutes - 60.0 * site.utc_offset_hours;
    let utc_minutes = ((shifted % 1440.0) + 1440.0) % 1440.0;
    let utc_day_shift = (shifted / 1440.0).floor();
    let utc_day = 1.0 + ((((day - 1.0 + utc_day_shift) % 365.0) + 365.0) % 365.0);
    let lighting = json!({
        "sun_elev_deg": num(elevation),
        "sun_azim_deg": num(azimuth),
        "rung": 3,
        "weather": preset.weather,
        "sun_scale": num(get("sun").unwrap_or(1.0)),
        "ambient_scale": num(get("ambient").unwrap_or(1.0)),
        "sky_scale": num(get("sky").unwrap_or(1.0)),
        "ev100_bias": num(get("exposure").map_or(0.0, |e| -e.log2())),
        "cloud_cover": num(preset.cloud_cover),
        "haze": num(get("haze").unwrap_or(preset.haze)),
        "wetness": num(preset.wetness),
        "atmosphere": true,
        "turbidity": num(preset.turbidity),
        "ozone_du": 300,
        "air_density": 1,
        "visibility_m": num(get("visibilityM").unwrap_or(preset.visibility_m)),
        "night": {
            "utc_year": 2026,
            "utc_day_of_year": num(utc_day),
            "utc_minutes": num(utc_minutes),
            "latitude_deg": num(site.latitude_deg),
            "longitude_deg": num(site.longitude_deg),
            "elevation_m": 15,
            "natural_ambient_lux": 0.002,
            "urban_skyglow_lux": 0.05,
            "limiting_magnitude": 6.5,
            "fixture_budget": 12,
            "fixture_shadow_budget": 0,
            "window_mode": "synthetic_facade",
            "cloud_quality": "scalable",
            "cloud_wind_mps": [12, 4],
            "cloud_density": num(preset.cloud_density),
            "cloud_type": num(preset.cloud_type),
            "cloud_base_m": num(preset.cloud_base_m),
            "cloud_top_m": num(preset.cloud_top_m),
            "sky_display_lift": 120,
            "exposure_offset_stops": 0,
            "sky_debug_mode": 0,
            "cloud_fixed_step_s": num(cloud_fixed_step_s.unwrap_or(1.0 / 30.0)),
        },
    });
    let overrides_json: Map<String, Value> = overrides
        .iter()
        .map(|(k, v)| (k.clone(), num(*v)))
        .collect();
    let provenance = json!({
        "weather": weather,
        "preset": preset.weather,
        "sceneMinutes": num(minutes),
        "dayOfYear": num(day),
        "sunSource": "solar-model",
        "site": site,
        "overrides": overrides_json,
    });
    Ok(LightingResolution {
        lighting,
        provenance,
    })
}

/// The engine's cloud clock step: one render per frame of the fastest RGB
/// camera (`1 / Math.max(1, ...fps)`).
pub fn cloud_fixed_step_s(rgb_fps: &[f64]) -> f64 {
    1.0 / rgb_fps.iter().copied().fold(1.0, f64::max)
}

/// The scenario environment a workspace renders under: the revision's
/// `document.json` `environment`, with the scenario schema's defaults
/// (`weather: cloudy`, `timeOfDay: dusk`, `surfacePatches: []`) exactly as the
/// hosted render intent's `renderSpec.authoredEnvironment` carries it
/// (`buildRenderSpec`: `input.environment ?? input.content.environment`,
/// parsed by `EnvironmentSchema`). Accepts the bare revision content or a
/// `{content}` wrapper. Unknown fields are refused (the schema is strict).
pub fn authored_environment_from_document(document: &Value) -> Result<Value, CliError> {
    let content =
        if document.get("scenarioVersion").is_some() || document.get("environment").is_some() {
            document
        } else if let Some(content) = document.get("content") {
            content
        } else {
            return Err(input(
                "render_environment_invalid",
                "document.json is not a scenario document (no scenarioVersion or environment)",
            ));
        };
    let mut environment = match content.get("environment") {
        None | Some(Value::Null) => Map::new(),
        Some(Value::Object(map)) => map.clone(),
        Some(_) => {
            return Err(input(
                "render_environment_invalid",
                "document environment is not an object",
            ))
        }
    };
    const KNOWN: &[&str] = &[
        "weather",
        "timeOfDay",
        "frictionScale",
        "sunAzimuthDeg",
        "sunElevationDeg",
        "surfacePatches",
        "extensions",
    ];
    if let Some(unknown) = environment.keys().find(|k| !KNOWN.contains(&k.as_str())) {
        return Err(input(
            "render_environment_invalid",
            format!("document environment has unknown field {unknown}"),
        ));
    }
    let weather = environment
        .entry("weather")
        .or_insert_with(|| json!(DEFAULT_WEATHER));
    if !weather
        .as_str()
        .is_some_and(|w| WEATHER_PRESETS.contains(&w))
    {
        return Err(input(
            "render_environment_invalid",
            format!("document environment weather {weather} is not a preset"),
        ));
    }
    let time = environment
        .entry("timeOfDay")
        .or_insert_with(|| json!(DEFAULT_TIME_OF_DAY));
    if !time
        .as_str()
        .is_some_and(|t| TIME_OF_DAY_PRESETS.contains(&t))
    {
        return Err(input(
            "render_environment_invalid",
            format!("document environment timeOfDay {time} is not a preset"),
        ));
    }
    environment
        .entry("surfacePatches")
        .or_insert_with(|| json!([]));
    Ok(Value::Object(environment))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lab() -> LightingSite {
        LightingSite {
            latitude_deg: 37.44,
            longitude_deg: -122.14,
            utc_offset_hours: -7.0,
            time_zone: "America/Los_Angeles (PDT)".into(),
        }
    }

    fn base() -> Value {
        json!({ "weather": "clear", "timeOfDay": "dawn", "surfacePatches": [] })
    }

    fn with_ext(key: &str, block: Value) -> Value {
        let mut e = base();
        e["extensions"] = json!({ key: block });
        e
    }

    fn at(environment: &Value) -> Result<LightingResolution, CliError> {
        resolve_native_lighting(environment, &lab(), None, None)
    }

    fn solar(minutes: f64, site: &LightingSite) -> (f64, f64) {
        solar_position(
            minutes,
            172.0,
            site.latitude_deg,
            site.longitude_deg,
            site.utc_offset_hours,
        )
    }

    #[test]
    fn matches_the_lab_solar_model_at_the_canonical_hours() {
        assert_eq!(solar(385.0, &lab()), (5.758, 115.248));
        assert_eq!(solar(720.0, &lab()), (69.511, 51.898));
        assert_eq!(solar(1195.0, &lab()), (5.724, 244.72));
        assert_eq!(solar(0.0, &lab()), (-26.938, 162.031));
    }

    #[test]
    fn reads_the_exact_clock_else_the_preset_and_refuses_a_malformed_one() {
        assert_eq!(scene_minutes(&base()).unwrap(), 360.0);
        assert_eq!(
            scene_minutes(&with_ext(
                SCENE_TIME_EXTENSION_KEY,
                json!({ "minutes": 1195 })
            ))
            .unwrap(),
            1195.0
        );
        let mut lit = base();
        lit["timeOfDay"] = json!("night_lit");
        assert_eq!(scene_minutes(&lit).unwrap(), 1260.0);
        for bad in [json!({ "minutes": "noon" }), json!(385)] {
            assert_eq!(
                scene_minutes(&with_ext(SCENE_TIME_EXTENSION_KEY, bad))
                    .unwrap_err()
                    .code,
                "render_environment_extension_invalid"
            );
        }
    }

    #[test]
    fn is_the_lab_default_for_a_fresh_scenario() {
        let r = at(&with_ext(
            SCENE_TIME_EXTENSION_KEY,
            json!({ "minutes": 385 }),
        ))
        .unwrap();
        let l = &r.lighting;
        assert_eq!(l["sun_elev_deg"], 5.758);
        assert_eq!(l["sun_azim_deg"], 115.248);
        assert_eq!(l["weather"], "clear");
        assert_eq!(l["visibility_m"], 25_000.0);
        assert_eq!(l["ev100_bias"], 0.0);
        assert_eq!(l["night"]["utc_minutes"], 805.0);
        assert_eq!(l["night"]["utc_day_of_year"], 172.0);
        assert_eq!(l["night"]["cloud_base_m"], 1200.0);
        assert_eq!(
            r.provenance["site"]["timeZone"],
            "America/Los_Angeles (PDT)"
        );
    }

    #[test]
    fn maps_drawable_weather_and_refuses_snow() {
        assert_eq!(weather_preset("cloudy").unwrap().cloud_cover, 0.45);
        let heavy = weather_preset("heavy_rain").unwrap();
        assert_eq!(
            (heavy.weather, heavy.wetness, heavy.visibility_m),
            ("rain", 1.0, 1500.0)
        );
        assert_eq!(weather_preset("fog_dense").unwrap().visibility_m, 150.0);
        assert_eq!(
            weather_preset("snow").unwrap_err().code,
            "native_weather_unsupported"
        );
        let mut sleet = base();
        sleet["weather"] = json!("sleet");
        assert_eq!(at(&sleet).unwrap_err().code, "native_weather_unsupported");
    }

    #[test]
    fn honours_the_lighting_block_and_refuses_what_it_would_drop() {
        let mut e = with_ext(
            LIGHTING_EXTENSION_KEY,
            json!({ "scaleRevision": 2, "sun": 1.5, "ambient": 0.5, "exposure": 2, "visibilityM": 4000, "haze": 0.2 }),
        );
        e["weather"] = json!("cloudy");
        let r = at(&e).unwrap();
        assert_eq!(r.lighting["sun_scale"], 1.5);
        assert_eq!(r.lighting["ambient_scale"], 0.5);
        assert_eq!(r.lighting["ev100_bias"], -1.0);
        assert_eq!(r.lighting["visibility_m"], 4000.0);
        assert_eq!(r.lighting["haze"], 0.2);
        assert_eq!(
            r.provenance["overrides"],
            json!({ "sun": 1.5, "ambient": 0.5, "exposure": 2, "visibilityM": 4000, "haze": 0.2 })
        );
        for invalid in [
            json!({ "sun": 1.5 }),
            json!({ "scaleRevision": 1, "sun": 1.5 }),
            json!({ "scaleRevision": 2, "sun": "bright" }),
            json!({ "scaleRevision": 2, "sun": 9 }),
            json!({ "scaleRevision": 2, "exposre": 2 }),
            json!("sunny"),
        ] {
            assert_eq!(
                at(&with_ext(LIGHTING_EXTENSION_KEY, invalid.clone()))
                    .unwrap_err()
                    .code,
                "render_environment_extension_invalid",
                "{invalid}"
            );
        }
        assert_eq!(
            at(&with_ext(
                LIGHTING_EXTENSION_KEY,
                json!({ "scaleRevision": 2, "sunWarmth": 0.4 })
            ))
            .unwrap_err()
            .code,
            "native_lighting_sun_warmth_unsupported"
        );
        assert_eq!(
            at(&with_ext(
                LIGHTING_EXTENSION_KEY,
                json!({ "scaleRevision": 2, "sunWarmth": 0 })
            ))
            .unwrap()
            .lighting["sun_scale"],
            1.0
        );
    }

    #[test]
    fn places_the_clock_sun_and_refuses_an_explicit_one() {
        let (a, e) = scene_clock_sun_angles(385.0);
        let mut shadowed = with_ext(SCENE_TIME_EXTENSION_KEY, json!({ "minutes": 385 }));
        shadowed["sunAzimuthDeg"] = json!(a);
        shadowed["sunElevationDeg"] = json!(e);
        assert_eq!(at(&shadowed).unwrap().lighting["sun_elev_deg"], 5.758);
        shadowed["sunAzimuthDeg"] = json!(90);
        shadowed["sunElevationDeg"] = json!(4);
        assert_eq!(
            at(&shadowed).unwrap_err().code,
            "native_lighting_sun_override_unsupported"
        );
        let mut only = base();
        only["sunElevationDeg"] = json!(4);
        assert_eq!(
            at(&only).unwrap_err().code,
            "native_lighting_sun_override_unsupported"
        );
    }

    #[test]
    fn rolls_the_utc_day_both_ways() {
        let l = at(&with_ext(
            SCENE_TIME_EXTENSION_KEY,
            json!({ "minutes": 1380 }),
        ))
        .unwrap()
        .lighting;
        assert_eq!(
            (
                l["night"]["utc_minutes"].as_f64(),
                l["night"]["utc_day_of_year"].as_f64()
            ),
            (Some(360.0), Some(173.0))
        );
        let berlin = LightingSite {
            latitude_deg: 48.26,
            longitude_deg: 11.65,
            utc_offset_hours: 2.0,
            time_zone: "Europe/Berlin (CEST)".into(),
        };
        let l = resolve_native_lighting(
            &with_ext(SCENE_TIME_EXTENSION_KEY, json!({ "minutes": 60 })),
            &berlin,
            None,
            None,
        )
        .unwrap()
        .lighting;
        assert_eq!(
            (
                l["night"]["utc_minutes"].as_f64(),
                l["night"]["utc_day_of_year"].as_f64()
            ),
            (Some(1380.0), Some(171.0))
        );
    }

    fn xodr(geo: &str) -> String {
        format!(
            r#"<?xml version="1.0"?><OpenDRIVE><header revMajor="1" revMinor="6"><geoReference><![CDATA[{geo}]]></geoReference></header></OpenDRIVE>"#
        )
    }

    #[test]
    fn takes_the_site_from_the_georeference_and_refuses_unknown_ones() {
        let richmond = lighting_site_from_opendrive(&xodr("+proj=tmerc +lat_0=37.9150891287087 +lon_0=-122.333308830857 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +vunits=m +no_defs"), "richmond").unwrap();
        assert_eq!(
            richmond,
            LightingSite {
                latitude_deg: 37.9150891287087,
                longitude_deg: -122.333308830857,
                utc_offset_hours: -7.0,
                time_zone: "America/Los_Angeles (PDT)".into()
            }
        );
        let garching = lighting_site_from_opendrive(&xodr("+proj=tmerc +lat_0=48.2554688997943 +lon_0=11.6522926105154 +k=1 +x_0=0 +y_0=0 +datum=WGS84"), "garching").unwrap();
        assert_eq!(garching.utc_offset_hours, 2.0);
        assert!(solar(795.0, &garching).0 < solar(795.0, &richmond).0);
        for bad in [
            "<OpenDRIVE><header/></OpenDRIVE>".to_owned(),
            xodr("+proj=utm +zone=10 +datum=WGS84"),
            xodr("+proj=tmerc +lat_0=35.68 +lon_0=139.69"),
        ] {
            assert_eq!(
                lighting_site_from_opendrive(&bad, "m").unwrap_err().code,
                "native_lighting_site_unknown"
            );
        }
    }

    #[test]
    fn the_document_environment_gets_the_schema_defaults() {
        let e = authored_environment_from_document(&json!({ "scenarioVersion": 2 })).unwrap();
        assert_eq!(
            e,
            json!({ "weather": "cloudy", "timeOfDay": "dusk", "surfacePatches": [] })
        );
        let e = authored_environment_from_document(
            &json!({ "content": { "environment": { "weather": "clear", "timeOfDay": "noon" } } }),
        )
        .unwrap();
        assert_eq!(e["weather"], "clear");
        assert!(authored_environment_from_document(
            &json!({ "scenarioVersion": 2, "environment": { "weather": "hail" } })
        )
        .is_err());
        assert!(authored_environment_from_document(
            &json!({ "scenarioVersion": 2, "environment": { "wether": "clear" } })
        )
        .is_err());
    }
}
