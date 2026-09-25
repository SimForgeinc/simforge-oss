//! The sensor rig: `simforge.render-rig/v1` files, and the port of
//! packages/render/src/native/camera-schedule.ts (plus the source checks of
//! engine.ts) that turns rig sources into the render service's cameras,
//! lidars and radars.
//!
//! A rig's `sources` are exactly the hosted render intent's
//! `renderSpec.sources` (`RenderSourceV3`, packages/scenario/src/render-spec.ts)
//! and its `sensorHosts` the intent's `sensorHosts`, so a rig copied out of a
//! hosted render request renders unchanged. Schema: `render-rig.v1.schema.json`
//! next to this file.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use simforge_core::math::{atan, atan2, cos, sin, tan};

use crate::contract::CliError;

pub const RENDER_RIG_V1_SCHEMA: &str = "simforge.render-rig/v1";
/// `PRONTO_CHASE_CAMERA_SENSOR_ID` (packages/scenario/src/render-intent.ts):
/// the one mount allowed to see its host.
pub const CHASE_CAMERA_SENSOR_ID: &str = "chase-cam-trailing";
/// The native engine's largest camera frame (engine.ts `CAPABILITIES.limits`).
pub const MAX_CAMERA_WIDTH: u32 = 4096;
pub const MAX_CAMERA_HEIGHT: u32 = 4096;
/// render `sensors::radar::MIN_RAYS_PER_FRAME`.
pub const RADAR_MIN_RAYS_PER_FRAME: f64 = 1.0;
const TARGET_DISTANCE_M: f64 = 50.0;

fn invalid(code: &str, reason: impl Into<String>) -> CliError {
    CliError::findings(code, reason)
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Vec3 {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Rotation {
    #[serde(default)]
    pub yaw_rad: f64,
    #[serde(default)]
    pub pitch_rad: f64,
    #[serde(default)]
    pub roll_rad: f64,
}

/// `SensorMountSchema`: actor-local metres, +X forward, +Y up, +Z left.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Mount {
    pub position: Vec3,
    #[serde(default)]
    pub rotation: Rotation,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CameraAttributes {
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub horizontal_fov_deg: f64,
    pub near_m: f64,
    pub far_m: f64,
}

fn default_lidar_hfov() -> f64 {
    360.0
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LidarAttributes {
    pub channels: u32,
    pub range_m: f64,
    pub points_per_second: u64,
    pub rotation_frequency_hz: f64,
    pub upper_fov_deg: f64,
    pub lower_fov_deg: f64,
    /// Azimuth coverage; the schema default is a full 360-degree revolution.
    #[serde(default = "default_lidar_hfov")]
    pub horizontal_fov_deg: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RadarAttributes {
    pub horizontal_fov_deg: f64,
    pub vertical_fov_deg: f64,
    pub range_m: f64,
    pub points_per_second: u64,
}

/// The fields every source shares.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceCommon {
    pub actor_id: String,
    pub sensor_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sensor_label: Option<String>,
    pub output_name: String,
    pub transform: Mount,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Source<A> {
    pub common: SourceCommon,
    /// `rgb | depth | semantic | instance` for cameras, else `lidar` / `radar`.
    pub modality: String,
    pub attributes: A,
}

/// `RenderSourceV3`.
#[derive(Debug, Clone, PartialEq)]
pub enum RenderSource {
    Camera(Source<CameraAttributes>),
    Lidar(Source<LidarAttributes>),
    Radar(Source<RadarAttributes>),
}

impl RenderSource {
    pub fn common(&self) -> &SourceCommon {
        match self {
            RenderSource::Camera(s) => &s.common,
            RenderSource::Lidar(s) => &s.common,
            RenderSource::Radar(s) => &s.common,
        }
    }

    pub fn output_name(&self) -> &str {
        &self.common().output_name
    }

    pub fn modality(&self) -> &str {
        match self {
            RenderSource::Camera(s) => &s.modality,
            RenderSource::Lidar(_) => "lidar",
            RenderSource::Radar(_) => "radar",
        }
    }

    /// The RGB cameras (the native engine renders only `rgb` camera sources).
    pub fn rgb(&self) -> Option<&Source<CameraAttributes>> {
        match self {
            RenderSource::Camera(s) if s.modality == "rgb" => Some(s),
            _ => None,
        }
    }

    pub fn to_json(&self) -> Value {
        let (modality, attributes) = match self {
            RenderSource::Camera(s) => (s.modality.as_str(), serde_json::to_value(&s.attributes)),
            RenderSource::Lidar(s) => ("lidar", serde_json::to_value(&s.attributes)),
            RenderSource::Radar(s) => ("radar", serde_json::to_value(&s.attributes)),
        };
        let mut v = serde_json::to_value(self.common()).expect("source serializes");
        v["modality"] = json!(modality);
        v["attributes"] = attributes.expect("attributes serialize");
        v
    }
}

fn parse_source(index: usize, value: &Value) -> Result<RenderSource, CliError> {
    let path = format!("sources[{index}]");
    let object = value
        .as_object()
        .ok_or_else(|| invalid("render_rig_invalid", format!("{path} is not an object")))?;
    let known = [
        "actorId",
        "sensorId",
        "sensorLabel",
        "outputName",
        "transform",
        "modality",
        "attributes",
    ];
    if let Some(unknown) = object.keys().find(|k| !known.contains(&k.as_str())) {
        return Err(invalid(
            "render_rig_invalid",
            format!("{path} has unknown field {unknown}"),
        ));
    }
    let modality = object
        .get("modality")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("render_rig_invalid", format!("{path}.modality is missing")))?
        .to_owned();
    let mut common_json = value.clone();
    common_json
        .as_object_mut()
        .expect("object")
        .remove("modality");
    let attributes = common_json
        .as_object_mut()
        .expect("object")
        .remove("attributes")
        .ok_or_else(|| {
            invalid(
                "render_rig_invalid",
                format!("{path}.attributes is missing"),
            )
        })?;
    let err = |what: &str, e: serde_json::Error| {
        invalid("render_rig_invalid", format!("{path}.{what}: {e}"))
    };
    let common: SourceCommon = serde_json::from_value(common_json).map_err(|e| err("", e))?;
    let source = match modality.as_str() {
        "rgb" | "depth" | "semantic" | "instance" => RenderSource::Camera(Source {
            common,
            modality,
            attributes: serde_json::from_value(attributes).map_err(|e| err("attributes", e))?,
        }),
        "lidar" => RenderSource::Lidar(Source {
            common,
            modality,
            attributes: serde_json::from_value(attributes).map_err(|e| err("attributes", e))?,
        }),
        "radar" => RenderSource::Radar(Source {
            common,
            modality,
            attributes: serde_json::from_value(attributes).map_err(|e| err("attributes", e))?,
        }),
        other => {
            return Err(invalid(
                "render_rig_invalid",
                format!("{path}.modality {other:?} (rgb|depth|semantic|instance|lidar|radar)"),
            ))
        }
    };
    validate_source(&path, &source)?;
    Ok(source)
}

fn is_output_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || *b == b'_' || *b == b'-')
}

/// The render-spec/v3 schema's range checks (the ones zod enforces).
fn validate_source(path: &str, source: &RenderSource) -> Result<(), CliError> {
    let fail = |why: String| Err(invalid("render_rig_invalid", format!("{path}: {why}")));
    let c = source.common();
    if !is_output_name(&c.output_name) {
        return fail(format!(
            "outputName {:?} must match ^[A-Za-z0-9][A-Za-z0-9_-]{{0,63}}$",
            c.output_name
        ));
    }
    if c.actor_id.is_empty() || c.sensor_id.is_empty() {
        return fail("actorId and sensorId are required".into());
    }
    let r = c.transform.rotation;
    let (half, quarter) = (std::f64::consts::PI, std::f64::consts::FRAC_PI_2);
    if r.yaw_rad.abs() > half || r.roll_rad.abs() > half || r.pitch_rad.abs() > quarter {
        return fail(
            "transform.rotation is outside yaw/roll [-pi, pi], pitch [-pi/2, pi/2]".into(),
        );
    }
    let p = c.transform.position;
    if ![p.x, p.y, p.z].iter().all(|v| v.is_finite()) {
        return fail("transform.position must be finite".into());
    }
    match source {
        RenderSource::Camera(s) => {
            let a = &s.attributes;
            if !(64..=8192).contains(&a.width) || !(64..=8192).contains(&a.height) {
                return fail(format!(
                    "camera size {}x{} is outside 64..8192",
                    a.width, a.height
                ));
            }
            if !(a.fps > 0.0 && a.fps <= 240.0) {
                return fail(format!("fps {} is outside (0, 240]", a.fps));
            }
            if !(a.horizontal_fov_deg > 0.0 && a.horizontal_fov_deg <= 180.0) {
                return fail(format!(
                    "horizontalFovDeg {} is outside (0, 180]",
                    a.horizontal_fov_deg
                ));
            }
            if !(a.near_m > 0.0 && a.far_m.is_finite() && a.far_m > a.near_m) {
                return fail("nearM must be positive and farM greater than nearM".into());
            }
        }
        RenderSource::Lidar(s) => {
            let a = &s.attributes;
            if !(1..=256).contains(&a.channels)
                || !(a.range_m > 0.0 && a.range_m <= 1000.0)
                || a.points_per_second == 0
            {
                return fail("lidar channels 1..256, rangeM (0, 1000] and a positive pointsPerSecond are required".into());
            }
            if !(a.rotation_frequency_hz > 0.0 && a.rotation_frequency_hz <= 240.0) {
                return fail(format!(
                    "rotationFrequencyHz {} is outside (0, 240]",
                    a.rotation_frequency_hz
                ));
            }
            if a.upper_fov_deg <= a.lower_fov_deg
                || a.upper_fov_deg.abs() > 180.0
                || a.lower_fov_deg.abs() > 180.0
            {
                return fail(
                    "upperFovDeg must be greater than lowerFovDeg, both within [-180, 180]".into(),
                );
            }
            if !(5.0..=360.0).contains(&a.horizontal_fov_deg) {
                return fail(format!(
                    "horizontalFovDeg {} is outside [5, 360]",
                    a.horizontal_fov_deg
                ));
            }
        }
        RenderSource::Radar(s) => {
            let a = &s.attributes;
            if !(a.horizontal_fov_deg > 0.0 && a.horizontal_fov_deg <= 180.0)
                || !(a.vertical_fov_deg > 0.0 && a.vertical_fov_deg <= 180.0)
                || !(a.range_m > 0.0 && a.range_m <= 1000.0)
                || a.points_per_second == 0
            {
                return fail("radar fields are outside the render-spec ranges".into());
            }
        }
    }
    Ok(())
}

/// `RenderSensorSourceHost`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SensorHost {
    pub source_id: String,
    pub actor_id: String,
    /// `{catalogAssetId, ...}`; extra keys are kept (the hosted schema is loose here).
    pub vehicle_asset: Value,
}

/// `RenderClipSchema`: `[startSeconds, endSeconds)` of timeline time.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Clip {
    pub start_seconds: f64,
    pub end_seconds: f64,
}

/// `RenderVideoV3Schema`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Video {
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub container: String,
    pub codec: String,
    pub quality: String,
}

/// A parsed `simforge.render-rig/v1` document.
#[derive(Debug, Clone, PartialEq)]
pub struct Rig {
    pub sources: Vec<RenderSource>,
    /// Absent in the file: every source is hosted by its own `actorId`
    /// ([`Rig::sensor_hosts`] derives them, with the host's catalog id).
    pub sensor_hosts: Option<Vec<SensorHost>>,
    /// Absent: the caller renders the whole timeline and says so.
    pub clip: Option<Clip>,
    pub video: Option<Video>,
}

impl Rig {
    pub fn parse(value: &Value) -> Result<Self, CliError> {
        let object = value
            .as_object()
            .ok_or_else(|| invalid("render_rig_invalid", "the rig is not a JSON object"))?;
        if value["schema"] != RENDER_RIG_V1_SCHEMA {
            return Err(invalid(
                "render_rig_invalid",
                format!(
                    "rig schema {} (expected {RENDER_RIG_V1_SCHEMA})",
                    value["schema"]
                ),
            ));
        }
        let known = ["schema", "sources", "sensorHosts", "clip", "video"];
        if let Some(unknown) = object.keys().find(|k| !known.contains(&k.as_str())) {
            return Err(invalid(
                "render_rig_invalid",
                format!("unknown rig field {unknown}"),
            ));
        }
        let list = value["sources"]
            .as_array()
            .filter(|l| !l.is_empty() && l.len() <= 64)
            .ok_or_else(|| invalid("render_rig_invalid", "sources must list 1..64 sources"))?;
        let sources = list
            .iter()
            .enumerate()
            .map(|(i, s)| parse_source(i, s))
            .collect::<Result<Vec<_>, _>>()?;
        let mut names = BTreeSet::new();
        let mut keys = BTreeSet::new();
        for s in &sources {
            if !names.insert(s.output_name().to_owned()) {
                return Err(invalid(
                    "render_rig_invalid",
                    format!("duplicate source outputName {:?}", s.output_name()),
                ));
            }
            let c = s.common();
            if !keys.insert((
                c.actor_id.clone(),
                c.sensor_id.clone(),
                s.modality().to_owned(),
            )) {
                return Err(invalid(
                    "render_rig_invalid",
                    "duplicate actor/sensor/modality capture source",
                ));
            }
        }
        let parse = |key: &str| -> Result<Option<Value>, CliError> { Ok(object.get(key).cloned()) };
        let sensor_hosts: Option<Vec<SensorHost>> = match parse("sensorHosts")? {
            None => None,
            Some(v) => Some(
                serde_json::from_value(v)
                    .map_err(|e| invalid("render_rig_invalid", format!("sensorHosts: {e}")))?,
            ),
        };
        if let Some(hosts) = &sensor_hosts {
            for host in hosts {
                if host.vehicle_asset["catalogAssetId"]
                    .as_str()
                    .is_none_or(|s| s.trim().is_empty())
                {
                    return Err(invalid(
                        "render_rig_invalid",
                        format!(
                            "sensorHosts {}: vehicleAsset.catalogAssetId is required",
                            host.source_id
                        ),
                    ));
                }
            }
        }
        let clip: Option<Clip> = match parse("clip")? {
            None => None,
            Some(v) => Some(
                serde_json::from_value(v)
                    .map_err(|e| invalid("render_rig_invalid", format!("clip: {e}")))?,
            ),
        };
        let video: Option<Video> = match parse("video")? {
            None => None,
            Some(v) => Some(
                serde_json::from_value(v)
                    .map_err(|e| invalid("render_rig_invalid", format!("video: {e}")))?,
            ),
        };
        Ok(Self {
            sources,
            sensor_hosts,
            clip,
            video,
        })
    }

    /// The rig's sensor hosts: the file's, else one per source hosted by its
    /// own `actorId`, whose vehicle asset is that actor's timeline catalog id
    /// (`catalog_of(actorId)`; an actor the timeline lacks is refused).
    pub fn sensor_hosts(
        &self,
        catalog_of: impl Fn(&str) -> Option<String>,
    ) -> Result<(Vec<SensorHost>, bool), CliError> {
        if let Some(hosts) = &self.sensor_hosts {
            return Ok((hosts.clone(), false));
        }
        let hosts = self
            .sources
            .iter()
            .map(|s| {
                let actor = &s.common().actor_id;
                let catalog = catalog_of(actor).ok_or_else(|| {
                    invalid("native_sensor_host_unknown", format!("source {} is mounted on actor {actor}, which the timeline does not have", s.output_name()))
                })?;
                Ok(SensorHost {
                    source_id: s.output_name().to_owned(),
                    actor_id: actor.clone(),
                    vehicle_asset: json!({ "catalogAssetId": catalog }),
                })
            })
            .collect::<Result<Vec<_>, CliError>>()?;
        Ok((hosts, true))
    }
}

/// `nativeCameraClipPlanes`: nearest near and farthest far of the RGB cameras.
pub fn camera_clip_planes(sources: &[RenderSource]) -> Result<(f64, f64), CliError> {
    let cameras: Vec<&CameraAttributes> = sources
        .iter()
        .filter_map(|s| s.rgb())
        .map(|s| &s.attributes)
        .collect();
    if cameras.is_empty() {
        return Err(invalid(
            "native_render_camera_missing",
            "native render requires at least one RGB camera",
        ));
    }
    Ok((
        cameras
            .iter()
            .map(|c| c.near_m)
            .fold(f64::INFINITY, f64::min),
        cameras
            .iter()
            .map(|c| c.far_m)
            .fold(f64::NEG_INFINITY, f64::max),
    ))
}

/// `assertNativeSourcesSupported` (plus the engine's modality check).
pub fn assert_native_sources_supported(sources: &[RenderSource]) -> Result<(), CliError> {
    for source in sources {
        match source {
            RenderSource::Camera(s) if s.modality != "rgb" => {
                return Err(invalid(
                    "native_modality_unsupported",
                    format!(
                        "native retained engine does not render {} source {}",
                        s.modality, s.common.output_name
                    ),
                ))
            }
            RenderSource::Camera(s) => {
                let a = &s.attributes;
                if a.width > MAX_CAMERA_WIDTH || a.height > MAX_CAMERA_HEIGHT {
                    return Err(invalid(
                        "native_camera_size_unsupported",
                        format!(
                            "camera {} asks for {}x{}; the native engine renders at most {MAX_CAMERA_WIDTH}x{MAX_CAMERA_HEIGHT}",
                            s.common.output_name, a.width, a.height
                        ),
                    ));
                }
            }
            RenderSource::Lidar(s) => assert_symmetric_lidar(s)?,
            RenderSource::Radar(_) => {}
        }
    }
    Ok(())
}

fn assert_symmetric_lidar(s: &Source<LidarAttributes>) -> Result<(), CliError> {
    let a = &s.attributes;
    if (a.upper_fov_deg + a.lower_fov_deg).abs() > 1e-9 {
        return Err(invalid(
            "native_lidar_asymmetric_fov_unsupported",
            format!(
                "lidar {} scans {} to {} deg; the native service casts a vertical fan symmetric about the mount",
                s.common.output_name, a.lower_fov_deg, a.upper_fov_deg
            ),
        ));
    }
    Ok(())
}

/// `assertNativeRadarBudgets`: rays per camera frame must reach the fan's minimum.
pub fn assert_native_radar_budgets(sources: &[RenderSource]) -> Result<(), CliError> {
    let fps = sources
        .iter()
        .filter_map(|s| s.rgb())
        .map(|s| s.attributes.fps)
        .fold(0.0, f64::max);
    if fps <= 0.0 {
        return Ok(());
    }
    for source in sources {
        if let RenderSource::Radar(s) = source {
            let rays = super::canonical::js_round(s.attributes.points_per_second as f64 / fps);
            if rays < RADAR_MIN_RAYS_PER_FRAME {
                return Err(invalid(
                    "native_radar_budget_invalid",
                    format!(
                        "radar {}: {} points/s at {fps} fps is {rays} rays per frame; the radar model needs at least {RADAR_MIN_RAYS_PER_FRAME}",
                        s.common.output_name, s.attributes.points_per_second
                    ),
                ));
            }
        }
    }
    Ok(())
}

fn vertical_fov(horizontal_deg: f64, width: f64, height: f64) -> f64 {
    let horizontal = horizontal_deg * std::f64::consts::PI / 180.0;
    2.0 * atan(tan(horizontal / 2.0) * height / width) * 180.0 / std::f64::consts::PI
}

fn yaw_from_quaternion(q: [f64; 4]) -> f64 {
    let [x, y, z, w] = q;
    atan2(2.0 * (w * y + z * x), 1.0 - 2.0 * (y * y + z * z))
}

fn host_actor_id<'a>(
    common: &SourceCommon,
    hosts: &'a BTreeMap<String, String>,
) -> Result<&'a str, CliError> {
    let actor = hosts.get(&common.output_name).ok_or_else(|| {
        invalid(
            "native_sensor_host_missing",
            format!(
                "native render source {} has no sensor host mapping",
                common.output_name
            ),
        )
    })?;
    if *actor != common.actor_id {
        return Err(invalid(
            "native_sensor_host_mismatch",
            format!(
                "native sensor host for {} does not match actor {}",
                common.output_name, common.actor_id
            ),
        ));
    }
    Ok(actor)
}

/// The authored mount as the service's `attach` (camera-schedule.ts
/// `attachment`): CCW mount yaw becomes the service's clockwise yaw.
pub fn attachment(common: &SourceCommon, actor_id: &str) -> Value {
    let m = common.transform.position;
    let r = common.transform.rotation;
    // `v * 180 / Math.PI`, evaluated left to right as in TypeScript.
    let deg = |v: f64| v * 180.0 / std::f64::consts::PI;
    json!({
        "actorId": actor_id,
        "offsetM": [m.x, -m.z, m.y],
        "yawDeg": deg(-r.yaw_rad),
        "pitchDeg": deg(r.pitch_rad),
        "rollDeg": deg(r.roll_rad),
        "hostVisible": common.sensor_id == CHASE_CAMERA_SENSOR_ID,
    })
}

fn host_map(hosts: &[SensorHost]) -> BTreeMap<String, String> {
    hosts
        .iter()
        .map(|h| (h.source_id.clone(), h.actor_id.clone()))
        .collect()
}

/// One scheduled camera (`NativeScheduledCamera`, the service camera wire
/// shape): `eye`/`target` are the mount at the host's lowered pose; the
/// service re-resolves them from `attach` every tick.
#[derive(Debug, Clone, PartialEq)]
pub struct ScheduledCamera {
    pub json: Value,
    pub eye: [f64; 3],
}

/// `createNativeCameraSchedule`: every RGB camera at every lowered frame.
pub fn camera_schedule(
    sources: &[RenderSource],
    hosts: &[SensorHost],
    states: &[Value],
) -> Result<Vec<Vec<ScheduledCamera>>, CliError> {
    let map = host_map(hosts);
    let cameras: Vec<&Source<CameraAttributes>> = sources.iter().filter_map(|s| s.rgb()).collect();
    states
        .iter()
        .map(|state| {
            cameras
                .iter()
                .map(|source| {
                    let actor_id = host_actor_id(&source.common, &map)?;
                    let actor = state["actors"]
                        .as_array()
                        .and_then(|actors| {
                            actors.iter().find(|a| a["id"] == actor_id && a["kind"] != "despawn")
                        })
                        .ok_or_else(|| {
                            invalid(
                                "native_sensor_host_absent",
                                format!("native sensor host {actor_id} is absent at tick {}", state["tick"]),
                            )
                        })?;
                    let f = |v: &Value| v.as_f64().expect("lowered numbers are finite");
                    let p = &actor["transform"]["position"];
                    let r = &actor["transform"]["rotation"];
                    let host_yaw = yaw_from_quaternion([f(&r[0]), f(&r[1]), f(&r[2]), f(&r[3])]);
                    let m = source.common.transform.position;
                    let (forward, right, up) = (m.x, -m.z, m.y);
                    let (sin_yaw, cos_yaw) = (sin(host_yaw), cos(host_yaw));
                    let eye = [
                        f(&p[0]) + cos_yaw * forward + sin_yaw * right,
                        f(&p[1]) + up,
                        f(&p[2]) - sin_yaw * forward + cos_yaw * right,
                    ];
                    let yaw = host_yaw + source.common.transform.rotation.yaw_rad;
                    let pitch = source.common.transform.rotation.pitch_rad;
                    let cos_pitch = cos(pitch);
                    let dir = [cos_pitch * cos(yaw), sin(pitch), -cos_pitch * sin(yaw)];
                    let a = &source.attributes;
                    let target = [
                        eye[0] + TARGET_DISTANCE_M * dir[0],
                        eye[1] + TARGET_DISTANCE_M * dir[1],
                        eye[2] + TARGET_DISTANCE_M * dir[2],
                    ];
                    Ok(ScheduledCamera {
                        json: json!({
                            "sensorId": source.common.output_name,
                            "width": a.width,
                            "height": a.height,
                            "fovDeg": vertical_fov(a.horizontal_fov_deg, a.width as f64, a.height as f64),
                            "nearM": a.near_m,
                            "farM": a.far_m,
                            "eye": eye,
                            "target": target,
                            "attach": attachment(&source.common, actor_id),
                        }),
                        eye,
                    })
                })
                .collect()
        })
        .collect()
}

/// `createNativeSensorRigs`: the lidars and radars the service retains.
pub fn sensor_rigs(
    sources: &[RenderSource],
    hosts: &[SensorHost],
) -> Result<(Vec<Value>, Vec<Value>), CliError> {
    let map = host_map(hosts);
    let (mut lidars, mut radars) = (Vec::new(), Vec::new());
    for source in sources {
        match source {
            RenderSource::Lidar(s) => {
                assert_symmetric_lidar(s)?;
                let a = &s.attributes;
                lidars.push(json!({
                    "sensorId": s.common.output_name,
                    "attach": attachment(&s.common, host_actor_id(&s.common, &map)?),
                    "channels": a.channels,
                    "rotationFrequencyHz": a.rotation_frequency_hz,
                    "pointsPerSecond": a.points_per_second,
                    "horizontalFovDeg": a.horizontal_fov_deg,
                    "verticalFovDeg": a.upper_fov_deg - a.lower_fov_deg,
                    "rangeM": a.range_m,
                }));
            }
            RenderSource::Radar(s) => {
                let a = &s.attributes;
                radars.push(json!({
                    "sensorId": s.common.output_name,
                    "attach": attachment(&s.common, host_actor_id(&s.common, &map)?),
                    "pointsPerSecond": a.points_per_second,
                    "horizontalFovDeg": a.horizontal_fov_deg,
                    "verticalFovDeg": a.vertical_fov_deg,
                    "rangeM": a.range_m,
                }));
            }
            RenderSource::Camera(_) => {}
        }
    }
    Ok((lidars, radars))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn camera() -> Value {
        json!({
            "actorId": "ego", "sensorId": "dash-camera", "outputName": "ego-dash-camera-rgb", "modality": "rgb",
            "transform": { "position": { "x": 2, "y": 1.2, "z": 0 }, "rotation": { "yawRad": 0, "pitchRad": 0, "rollRad": 0 } },
            "attributes": { "width": 1280, "height": 720, "fps": 24, "horizontalFovDeg": 90, "nearM": 0.05, "farM": 1000 },
        })
    }

    fn lidar() -> Value {
        json!({
            "actorId": "ego", "sensorId": "roof-lidar", "outputName": "ego-roof-lidar-lidar", "modality": "lidar",
            "transform": { "position": { "x": 0, "y": 1.9, "z": 0 }, "rotation": { "yawRad": 0, "pitchRad": 0, "rollRad": 0.1 } },
            "attributes": { "channels": 64, "rangeM": 120, "pointsPerSecond": 1_200_000, "rotationFrequencyHz": 10, "upperFovDeg": 15, "lowerFovDeg": -15, "horizontalFovDeg": 360 },
        })
    }

    fn rig(sources: Vec<Value>) -> Rig {
        Rig::parse(&json!({ "schema": RENDER_RIG_V1_SCHEMA, "sources": sources })).unwrap()
    }

    fn host(source: &str) -> SensorHost {
        SensorHost {
            source_id: source.into(),
            actor_id: "ego".into(),
            vehicle_asset: json!({ "catalogAssetId": "vehicle.sedan" }),
        }
    }

    fn state(tick: u32, position: [f64; 3], heading: f64) -> Value {
        json!({
            "version": "simforge.scene-state.v1", "mapId": "richmond", "tick": tick, "tickHz": 24,
            "weather": { "preset": "clear" }, "timeOfDay": 12,
            "actors": [{
                "id": "ego", "kind": if tick == 0 { "spawn" } else { "update" }, "catalogId": "vehicle.sedan", "actorClass": "car",
                "transform": { "position": position, "rotation": [0.0, (heading / 2.0).sin(), 0.0, (heading / 2.0).cos()] },
                "velocity": [1, 0, 0],
            }],
        })
    }

    #[test]
    fn tracks_the_host_pose_and_composes_the_dash_mount_along_its_heading() {
        let r = rig(vec![camera()]);
        let schedule = camera_schedule(
            &r.sources,
            &[host("ego-dash-camera-rgb")],
            &[
                state(0, [10.0, 2.0, 20.0], 0.0),
                state(1, [11.0, 2.0, 18.0], std::f64::consts::FRAC_PI_2),
            ],
        )
        .unwrap();
        assert_eq!(schedule[0][0].json["eye"], json!([12.0, 3.2, 20.0]));
        assert_eq!(schedule[0][0].json["target"], json!([62.0, 3.2, 20.0]));
        let eye = schedule[1][0].eye;
        assert!(
            (eye[0] - 11.0).abs() < 1e-9
                && (eye[1] - 3.2).abs() < 1e-9
                && (eye[2] - 16.0).abs() < 1e-9
        );
        let target = &schedule[1][0].json["target"];
        assert!((target[0].as_f64().unwrap() - 11.0).abs() < 1e-9);
        assert!((target[2].as_f64().unwrap() + 34.0).abs() < 1e-9);
    }

    #[test]
    fn carries_the_mount_roll_and_refuses_an_asymmetric_band() {
        let r = rig(vec![lidar()]);
        let (lidars, _) = sensor_rigs(&r.sources, &[host("ego-roof-lidar-lidar")]).unwrap();
        assert!(
            (lidars[0]["attach"]["rollDeg"].as_f64().unwrap() - 0.1 * 180.0 / std::f64::consts::PI)
                .abs()
                < 1e-9
        );
        assert_eq!(lidars[0]["attach"]["pitchDeg"], 0.0);
        assert_eq!(lidars[0]["verticalFovDeg"], 30.0);
        let mut asymmetric = lidar();
        asymmetric["attributes"]["upperFovDeg"] = json!(10);
        asymmetric["attributes"]["lowerFovDeg"] = json!(-30);
        let r = rig(vec![asymmetric]);
        let err = sensor_rigs(&r.sources, &[host("ego-roof-lidar-lidar")]).unwrap_err();
        assert_eq!(err.code, "native_lidar_asymmetric_fov_unsupported");
        assert_eq!(
            assert_native_sources_supported(&r.sources)
                .unwrap_err()
                .code,
            "native_lidar_asymmetric_fov_unsupported"
        );
    }

    #[test]
    fn rig_files_are_strict() {
        let mut bad = camera();
        bad["attributes"]["fsp"] = json!(24);
        assert!(Rig::parse(&json!({ "schema": RENDER_RIG_V1_SCHEMA, "sources": [bad] })).is_err());
        assert!(
            Rig::parse(&json!({ "schema": "simforge.render-rig/v9", "sources": [camera()] }))
                .is_err()
        );
        assert!(Rig::parse(
            &json!({ "schema": RENDER_RIG_V1_SCHEMA, "sources": [camera(), camera()] })
        )
        .is_err());
        let r = rig(vec![camera(), lidar()]);
        let (hosts, derived) = r
            .sensor_hosts(|id| (id == "ego").then(|| "vehicle.sedan".to_owned()))
            .unwrap();
        assert!(derived);
        assert_eq!(hosts[1].source_id, "ego-roof-lidar-lidar");
        assert_eq!(
            r.sensor_hosts(|_| None).unwrap_err().code,
            "native_sensor_host_unknown"
        );
        assert_eq!(camera_clip_planes(&r.sources).unwrap(), (0.05, 1000.0));
        assert_eq!(
            camera_clip_planes(&rig(vec![lidar()]).sources)
                .unwrap_err()
                .code,
            "native_render_camera_missing"
        );
        // The lidar horizontal FOV defaults to a full revolution, as the schema says.
        let mut no_hfov = lidar();
        no_hfov["attributes"]
            .as_object_mut()
            .unwrap()
            .remove("horizontalFovDeg");
        match &rig(vec![no_hfov]).sources[0] {
            RenderSource::Lidar(s) => assert_eq!(s.attributes.horizontal_fov_deg, 360.0),
            _ => unreachable!(),
        }
    }

    #[test]
    fn the_example_rig_parses() {
        let example: Value =
            serde_json::from_str(include_str!("front-camera-lidar-radar.rig.json")).unwrap();
        let r = Rig::parse(&example).unwrap();
        assert_eq!(r.sources.len(), 3);
        assert_native_sources_supported(&r.sources).unwrap();
        assert_native_radar_budgets(&r.sources).unwrap();
    }
}
