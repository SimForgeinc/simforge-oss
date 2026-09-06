//! Wire protocol for the native render service.
//!
//! Every message is one u32-LE length-prefixed msgpack payload (max
//! [`MAX_FRAME_BYTES`]); requests carry `{ i: <sequence>, op: "<verb>", ... }`;
//! responses echo `i`.
use render_core::engine::{DeviceReady, FrameIdentity};
use serde::{Deserialize, Serialize};

/// Wire protocol version; bumped on any breaking frame change.
///
/// V5: every rendered response (`render`, `render_bundle`) carries the
/// [`FrameIdentity`] of the single submission its payloads were copied
/// from, and every published frame record carries a CRC32 `digest`. The
/// per-camera GPU pass set is no longer frozen at first registration: each
/// `render_bundle` request selects the passes it wants, and a camera
/// re-sent with a different size, field of view or profile is re-registered
/// in place. Mounted cameras exclude their host actor from their own view
/// only. Requests are unchanged from V4.
pub const NATIVE_SERVICE_PROTOCOL_VERSION: u32 = 5;

/// Rigid attachment of a camera to a scene-state actor (CARLA
/// `AttachmentType.Rigid` analogue): the pose is re-resolved from the
/// actor's transform on every rendered tick, so the camera never lags or
/// springs. `offsetM` is the mount position in actor-local frame
/// (x forward, y right, z up, metres); yaw/pitch are degrees relative to
/// the actor heading.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraAttach {
    pub actor_id: String,
    #[serde(default)]
    pub offset_m: [f32; 3],
    #[serde(default)]
    pub yaw_deg: f32,
    #[serde(default)]
    pub pitch_deg: f32,
    #[serde(default)]
    pub roll_deg: f32,
    /// Aim at the attached actor origin instead of projecting the mount's
    /// yaw/pitch. Intended for trailing chase cameras; sensor mounts leave it
    /// false and retain their calibrated rigid orientation.
    #[serde(default)]
    pub look_at_actor: bool,
}

/// Hard cap on one framed message; guards against a corrupt length prefix.
pub const MAX_FRAME_BYTES: usize = 64 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize)]
pub struct WireRequest {
    #[serde(default)]
    pub i: u64,
    #[serde(flatten)]
    pub body: RequestBody,
}

/// One rig camera in a render request. Poses are absolute world-space
/// eye/target points (y-up), matching the spike / W0 camera convention.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceCamera {
    pub sensor_id: String,
    pub width: u32,
    pub height: u32,
    /// Vertical FOV degrees.
    pub fov_deg: f32,
    pub eye: [f32; 3],
    pub target: [f32; 3],
    /// Also produce the semantic output (derived from the instance-ID pass,
    /// CARLA byte layout).
    #[serde(default)]
    pub semantic: bool,
    /// `"linear"` (default, raw reverse-Z Depth32Float passthrough) or
    /// `"carla"` (24-bit fixed point over a 1000 m far plane, BGRA order).
    #[serde(default)]
    pub depth_encoding: Option<String>,
    /// Rigid attachment — when present, eye/target are re-resolved from the
    /// attached actor's scene-state transform every render, the explicit
    /// eye/target fields are ignored, and the host actor's RGB geometry is
    /// excluded from this camera's view only.
    #[serde(default)]
    pub attach: Option<CameraAttach>,
    /// Optional per-camera render profile. Omit to inherit the service scene
    /// profile. A campaign chase camera can therefore be cinematic while the
    /// retained Pronto cameras remain sensor-profile and hash-stable.
    #[serde(default)]
    pub profile: Option<render_core::engine::Profile>,
}

/// Retained spinning lidar declaration for `render_bundle`.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceLidar {
    pub sensor_id: String,
    pub attach: CameraAttach,
    #[serde(default = "default_lidar_channels")]
    pub channels: u32,
    #[serde(default = "default_lidar_rotation_hz")]
    pub rotation_frequency_hz: f32,
    #[serde(default = "default_lidar_points_per_second")]
    pub points_per_second: u32,
    #[serde(default = "default_lidar_horizontal_fov")]
    pub horizontal_fov_deg: f32,
    #[serde(default = "default_lidar_vertical_fov")]
    pub vertical_fov_deg: f32,
    #[serde(default = "default_lidar_range")]
    pub range_m: f32,
}

/// Retained fixed-fan radar declaration for `render_bundle`.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceRadar {
    pub sensor_id: String,
    pub attach: CameraAttach,
    #[serde(default = "default_radar_points_per_second")]
    pub points_per_second: u32,
    #[serde(default = "default_radar_horizontal_fov")]
    pub horizontal_fov_deg: f32,
    #[serde(default = "default_radar_vertical_fov")]
    pub vertical_fov_deg: f32,
    #[serde(default = "default_radar_range")]
    pub range_m: f32,
}

fn default_lidar_channels() -> u32 { 128 }
fn default_lidar_rotation_hz() -> f32 { 10.0 }
fn default_lidar_points_per_second() -> u32 { 1_300_000 }
fn default_lidar_horizontal_fov() -> f32 { 120.0 }
fn default_lidar_vertical_fov() -> f32 { 25.0 }
fn default_lidar_range() -> f32 { 200.0 }
fn default_radar_points_per_second() -> u32 { 1_500 }
fn default_radar_horizontal_fov() -> f32 { 30.0 }
fn default_radar_vertical_fov() -> f32 { 30.0 }
fn default_radar_range() -> f32 { 100.0 }

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum RequestBody {
    /// Handshake: protocol version, prewarmed scene info, shm location.
    Hello,
    /// Add more tiles before first render (map prewarm extension).
    Load { glbs: Vec<String> },
    /// Render one tick for the given cameras (rgb + id + depth, plus
    /// semantic per camera) and publish the frames individually. Cameras
    /// upsert the retained rig like `render_bundle`.
    Render {
        tick_id: u64,
        cameras: Vec<ServiceCamera>,
        /// When present, PNG export of this tick happens asynchronously into
        /// this directory after the response.
        #[serde(default)]
        export_dir: Option<String>,
        /// Apply this frame index of the loaded scene-state stream before
        /// rendering (actor spawn/update/despawn + attach resolution).
        #[serde(default)]
        tick_index: Option<u32>,
    },
    /// Load a scene-state.v1 stream (one document per tick, in order).
    /// Actors are created lazily on the first rendered tick that references
    /// them. `mapId`/`xodrSha256` must match the prewarmed scene contract.
    LoadSceneState { states: Vec<crate::scene::SceneState> },
    /// Drop every registered camera, lidar and radar; the next render
    /// re-registers from its request.
    ResetCameras,
    /// JPEG-encode cached pass payloads from the last rendered tick and
    /// publish the results into the shm ring as `jpeg` records.
    EncodeJpeg { items: Vec<JpegItem> },
    /// Render every rig camera for one sim tick and publish an atomic
    /// frame bundle (per-camera frames + one bundle table record + the
    /// meta-page latest-bundle pointer). `cameras`, when present, upserts the
    /// retained rig (registration order preserved); when absent, the rig from
    /// previous `render_bundle`/`render` calls is reused. `passes` defaults
    /// to `["rgb"]` and selects, per request, which outputs are copied
    /// from the GPU; the instance-ID view renders only when `id` or
    /// `semantic` is requested.
    RenderBundle {
        sim_tick: u64,
        #[serde(default)]
        cameras: Option<Vec<ServiceCamera>>,
        /// Lidar declarations upsert the retained non-camera rig. Send once,
        /// then omit on the persistent hot loop.
        #[serde(default)]
        lidars: Option<Vec<ServiceLidar>>,
        /// Radar declarations upsert the retained non-camera rig.
        #[serde(default)]
        radars: Option<Vec<ServiceRadar>>,
        /// Scene-state frame to apply before rendering (as in `render`).
        #[serde(default)]
        tick_index: Option<u32>,
        /// Subset of `rgb | id | depth | semantic`.
        #[serde(default)]
        passes: Option<Vec<String>>,
        /// Sensors whose open device streams are filled from this bundle's
        /// submission (GPU-local copies into a leased slot; no host bytes).
        #[serde(default)]
        device_sensors: Option<Vec<String>>,
    },
    /// Re-light the prewarmed scene in place. The tiles and the instance-ID
    /// pass stay loaded; the lighting ladder, the cinematic stack on every
    /// registered camera, distance fog and the wet-road ramp are rebuilt
    /// from these settings. Answers with the engine values that were
    /// actually applied.
    SetLighting {
        lighting: render_core::engine::Lighting,
        #[serde(default)]
        profile_config: Option<render_core::profiles::RenderProfileConfig>,
        /// Update the live look in place instead of respawning it, so TAA
        /// history survives (time-lapse recording). Falls back to the full
        /// relight when the change is more than the sun's position; the
        /// response says which happened.
        #[serde(default)]
        advance: bool,
    },
    /// Read back the current look without changing anything. `set_lighting`
    /// can only report the AA components of cameras that are already
    /// registered, and the first camera is registered by the first render;
    /// a lookdev surface that wants to prove what its live views carry
    /// needs a read that is not tied to a write.
    GetState,
    Close,
    /// Allocate an exportable Vulkan device stream for a registered camera:
    /// `slots` independently leasable outputs, one plane per requested
    /// pass (`rgb`/`id` RGBA8 sRGB, `depth` Depth32Float). `wait_ms` bounds
    /// how long a bundle blocks for a consumer release when every slot is
    /// outstanding; omitted means fail fast. Requires a service built with
    /// `gpu-interop` and a Vulkan device that exports memory/semaphores;
    /// otherwise the request is rejected explicitly.
    OpenDeviceStream {
        sensor_id: String,
        passes: Vec<String>,
        slots: u32,
        #[serde(default)]
        wait_ms: Option<u64>,
    },
    /// Export fresh handles for every slot of a sensor's device stream
    /// (see `ResponseBody::ExportDeviceStream`).
    ExportDeviceStream { sensor_id: String },
    /// Tear down a sensor's device stream after waiting up to `graceMs` for
    /// outstanding consumer leases.
    CloseDeviceStream {
        sensor_id: String,
        #[serde(default)]
        grace_ms: u64,
    },
}

/// One requested JPEG encoding from the last rendered tick's cache.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JpegItem {
    pub sensor_id: String,
    pub pass: String,
    pub quality: u8,
}

#[derive(Debug, Serialize)]
pub struct WireResponse {
    pub i: u64,
    #[serde(flatten)]
    pub body: ResponseBody,
}

#[derive(Debug, Serialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum ResponseBody {
    Hello {
        ok: bool,
        protocol: u32,
        profile: String,
        legend_entries: usize,
        shm: ShmInfo,
    },
    Load {
        ok: bool,
        tiles: usize,
    },
    LoadSceneState {
        ok: bool,
        ticks: usize,
        map_id: String,
    },
    ResetCameras {
        ok: bool,
    },
    SetLighting {
        ok: bool,
        /// Engine values the renderer resolved from the request.
        resolved: render_core::engine::ResolvedLighting,
        /// Anti-aliasing mode the applied `profile_config` asked for.
        anti_alias: String,
        /// `(sensorId, mode)` read back off every live RGB view's actual
        /// components. A `conflict:` prefix means two AA components are on
        /// one camera, i.e. the strip/apply cycle failed. Empty before the
        /// first camera registration.
        camera_anti_alias: Vec<(String, String)>,
        /// Server-side re-light wall time, milliseconds.
        server_ms: f64,
        /// `true` when the request asked for an in-place advance but the
        /// renderer had to fall back to a full relight (TAA history reset).
        /// Always `false` for a plain `set_lighting`.
        full_relight: bool,
    },
    GetState {
        ok: bool,
        protocol: u32,
        resolved: render_core::engine::ResolvedLighting,
        anti_alias: String,
        camera_anti_alias: Vec<(String, String)>,
        cameras: usize,
    },
    /// JPEG records published into the shm ring.
    EncodeJpeg {
        ok: bool,
        tick_id: u64,
        frames: Vec<FrameRecord>,
        /// Server-side encode+publish wall time, milliseconds.
        server_ms: f64,
    },
    /// Atomic frame bundle published.
    RenderBundle {
        ok: bool,
        sim_tick: u64,
        /// Identity of the single GPU submission every camera payload in
        /// this bundle was copied from. Lidar/radar payloads are computed on
        /// the CPU from the same scene revision.
        frame: FrameIdentity,
        /// Physical offset of the bundle RECORD header in the shm file.
        bundle_offset: u64,
        /// Bundle table payload length.
        bundle_len: u64,
        /// One record per published frame.
        frames: Vec<FrameRecord>,
        /// Device-resident outputs by sensor for `device_sensors`: the slot
        /// the consumer must lease (`ImportedStream.lease(slot, generation)`)
        /// and whose ready signal is bound to this bundle's submission.
        device: std::collections::HashMap<String, DeviceReady>,
        /// Server-side render+publish wall time, milliseconds.
        server_ms: f64,
    },
    /// Exportable device stream allocated for a camera.
    OpenDeviceStream {
        ok: bool,
        sensor_id: String,
        stream_id: u64,
        /// Byte layout of every plane in a slot.
        planes: Vec<DevicePlaneLayout>,
    },
    /// Acknowledged export. Immediately after this frame the service writes
    /// one `SFGX` frame (`b"SFGX" ++ u32le(len) ++ manifest JSON`) carrying
    /// every slot's memory/ready/release descriptors as `SCM_RIGHTS` on the
    /// same socket; the client must consume it before its next request
    /// (`simforge_native.gpu.receive_stream`).
    ExportDeviceStream {
        ok: bool,
        sensor_id: String,
        stream_id: u64,
        slots: u32,
    },
    CloseDeviceStream {
        ok: bool,
        sensor_id: String,
        /// Published slots the consumer had not released within the grace.
        outstanding_consumer_leases: u32,
        /// Slots acquired by the renderer but never submitted.
        abandoned_producer_leases: u32,
    },
    Render {
        ok: bool,
        tick_id: u64,
        /// Identity of the single GPU submission every payload was copied from.
        frame: FrameIdentity,
        /// One record per produced pass payload.
        frames: Vec<FrameRecord>,
        /// Server-side render+publish wall time, milliseconds.
        server_ms: f64,
        /// Fraction of camera pixels whose instance ID is non-zero.
        coverage: Vec<CoverageRecord>,
    },
    Close {
        ok: bool,
    },
    Error {
        ok: bool,
        error: String,
    },
}

/// Shared-memory ring descriptor handed out at hello.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ShmInfo {
    pub path: String,
    /// Total capacity bytes (including the meta page).
    pub size_bytes: u64,
    /// Records start after this many reserved bytes (meta page).
    pub meta_bytes: u64,
}

impl WireResponse {
    pub fn error(i: u64, error: impl Into<String>) -> Self {
        Self { i, body: ResponseBody::Error { ok: false, error: error.into() } }
    }
}

/// One produced pass payload published into the shm ring.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameRecord {
    pub sensor_id: String,
    /// `rgb | id | depth | semantic | jpeg | lidar | radar`
    pub pass: String,
    pub offset: u64,
    /// Payload byte length (row-padded).
    pub len: u64,
    pub width: u32,
    pub height: u32,
    /// `rgba8` (RGB + ID + semantic), `depth32f` (raw reverse-Z
    /// Depth32Float), `carla-depth-bgra`, `jpeg`, `ply-ascii` or `radar-csv`.
    pub format: String,
    pub tick_id: u64,
    /// CRC32 (IEEE) of the payload bytes as 8-char lowercase hex.
    pub digest: String,
}

/// Byte layout of one plane inside every slot of a device stream (mirror of
/// `gpu_interop::PlaneLayout`, also carried by the exported manifest).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DevicePlaneLayout {
    pub name: String,
    pub width: u32,
    pub height: u32,
    /// `rgba8-unorm-srgb`, `depth32-float`, ... (kebab-case `PlaneFormat`).
    pub format: String,
    /// numpy-style typestr of one channel (`|u1`, `<f4`, ...).
    pub dtype: String,
    pub channels: u32,
    pub pixel_bytes: u32,
    /// Byte offset of row 0 inside the slot allocation.
    pub offset: u64,
    /// Bytes between consecutive rows (256-byte aligned copy stride).
    pub row_stride: u32,
    /// `row_stride * height`.
    pub bytes: u64,
}

/// Geometry coverage measured from the instance-ID pass already rendered for
/// a camera. A zero ID is the deterministic clear/background value.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverageRecord {
    pub sensor_id: String,
    pub fraction: f64,
}

/* --------------------------------------------------------------- framing */

/// Incremental frame splitter: feed transport chunks, pull complete payloads
/// (same contract as rl-env's FrameReader).
pub struct FrameReader {
    buf: Vec<u8>,
}

impl FrameReader {
    pub fn new() -> Self {
        Self { buf: Vec::new() }
    }

    /// Feed one transport chunk; returns every complete payload in order.
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<Vec<u8>>, String> {
        self.buf.extend_from_slice(chunk);
        let mut out = Vec::new();
        loop {
            if self.buf.len() < 4 {
                return Ok(out);
            }
            let len = u32::from_le_bytes([self.buf[0], self.buf[1], self.buf[2], self.buf[3]])
                as usize;
            if len > MAX_FRAME_BYTES {
                return Err(format!("frame length {len} exceeds cap"));
            }
            if self.buf.len() < 4 + len {
                return Ok(out);
            }
            out.push(self.buf[4..4 + len].to_vec());
            self.buf.drain(..4 + len);
        }
    }
}

/// Encode one length-prefixed msgpack-serializable message.
pub fn encode_frame<T: Serialize>(value: &T) -> Result<Vec<u8>, rmp_serde::encode::Error> {
    let payload = rmp_serde::to_vec_named(value)?;
    let mut out = Vec::with_capacity(4 + payload.len());
    out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    out.extend_from_slice(&payload);
    Ok(out)
}

/// Decode one length-prefixed request payload.
pub fn decode_request(payload: &[u8]) -> Result<WireRequest, String> {
    rmp_serde::from_slice(payload).map_err(|e| format!("bad request: {e}"))
}

/// Decode one request document from JSON (in-process FFI host; same
/// `{i, op, ...}` envelope as the msgpack frames).
pub fn decode_request_json(document: &str) -> Result<WireRequest, String> {
    serde_json::from_str(document).map_err(|e| format!("bad request: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use render_core::engine::Profile;

    #[test]
    fn camera_profile_is_optional_and_camel_case() {
        let base = r#"{
            "sensorId":"pronto-cam0","width":1920,"height":1080,"fovDeg":60,
            "eye":[0,2,0],"target":[1,2,0]
        }"#;
        let sensor: ServiceCamera = serde_json::from_str(base).unwrap();
        assert_eq!(sensor.profile, None);

        let cinematic: ServiceCamera = serde_json::from_str(
            &base.replace(
                "\"eye\"",
                "\"profile\":\"cinematic\",\"eye\"",
            ),
        )
        .unwrap();
        assert_eq!(cinematic.profile, Some(Profile::Cinematic));
    }

    #[test]
    fn camera_only_bundle_request_needs_no_cpu_sensor_fields() {
        let request: RequestBody = serde_json::from_str(
            r#"{
                "op":"render_bundle",
                "sim_tick":7,
                "cameras":[{
                    "sensorId":"front","width":64,"height":48,"fovDeg":60,
                    "eye":[0,2,0],"target":[1,2,0]
                }]
            }"#,
        )
        .unwrap();
        match request {
            RequestBody::RenderBundle {
                cameras,
                lidars,
                radars,
                ..
            } => {
                assert_eq!(cameras.unwrap().len(), 1);
                assert!(lidars.is_none());
                assert!(radars.is_none());
            }
            _ => panic!("wrong request variant"),
        }
    }
}
