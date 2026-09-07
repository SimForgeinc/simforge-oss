//! Server loop: prewarm a map once, then serve render requests.
//!
//! Single-client-at-a-time (a new connection replaces the old, mirroring
//! env-server's serveSocket). All Bevy work stays on the server thread; the
//! socket is drained synchronously between renders — deterministic by
//! construction.
//!
//! Every render request applies its scene tick and rig changes to the
//! resident scene, then performs exactly one [`SceneApp::capture`]; the
//! published payloads and the response's
//! [`render_core::engine::FrameIdentity`] come from that single submission.
use crate::proto::{
    decode_request, encode_frame, CameraAttach, CoverageRecord, FrameReader, FrameRecord, JpegItem,
    RequestBody, ResponseBody, ServiceCamera, ServiceLidar, ServiceRadar, ShmInfo, WireRequest,
    WireResponse, NATIVE_SERVICE_PROTOCOL_VERSION,
};
use crate::scene::{ActorState, SceneState};
use crate::shm::{
    BundleEntry, ShmRing, FORMAT_DEPTH32F, FORMAT_JPEG, FORMAT_LIDAR_PLY, FORMAT_RADAR_CSV,
    FORMAT_RGBA8,
};
use anyhow::{Context, Result};
use bevy::math::{EulerRot, Quat, Vec3};
use render_core::engine::{
    CameraSpec, CapturedFrame, LegendEntry, Lighting, PassSet, Profile, SceneApp, SensorTriangle,
};
use render_core::profiles::RenderProfileConfig;
use render_core::vehicle_model::{VehicleModelCatalog, VehicleModelEntry};
use sensors::bvh::{Hit, Raycast, RaycastScene, Tri};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

/// Scene description for prewarm (subset of the batch job schema).
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneSpec {
    pub glbs: Vec<String>,
    /// Vegetation prototype GLBs with sibling instance sidecars.
    #[serde(default)]
    pub veg_glbs: Vec<String>,
    #[serde(default)]
    pub lighting: Lighting,
    pub profile: Profile,
    /// Advanced cinematic settings; ignored by sensor cameras.
    #[serde(default)]
    pub profile_config: RenderProfileConfig,
    #[serde(default = "default_near")]
    pub near_m: f32,
    #[serde(default = "default_far")]
    pub far_m: f32,
    #[serde(default = "default_warmup")]
    pub warmup_frames: u32,
    /// CarlaVehicles catalog directories. Only models referenced by scene
    /// actors are loaded; unknown catalog ids retain the explicit cuboid
    /// fallback.
    #[serde(default)]
    pub vehicle_models: Option<String>,
    #[serde(default)]
    pub pedestrian_models: Option<String>,
    /// Optional actor-id -> absolute GLB override.
    #[serde(default)]
    pub actor_model_refs: HashMap<String, String>,
    /// Meter the sky through the first RGB camera of every render when the
    /// authored lighting names no `meter_view` (the Lookdev Lab's per-frame
    /// metering: a sunward low sun stops the camera down instead of
    /// printing a white sky). Off, the incident meter alone sets exposure.
    #[serde(default = "default_true")]
    pub auto_meter: bool,
}

fn default_true() -> bool {
    true
}

fn default_near() -> f32 {
    0.5
}
fn default_far() -> f32 {
    900.0
}
fn default_warmup() -> u32 {
    10
}

/// Prewarm the scene (tiles + ID pass + shader warmup) and return the app.
/// The warmup cameras are registered before the readiness barrier so the
/// pipelines the real rig will need are compiled up front.
pub fn prewarm(spec: &SceneSpec) -> Result<SceneApp> {
    let mut app =
        SceneApp::new_with_profile_config(&spec.lighting, spec.profile_config)?;
    // The constructor spawns the ladder with calibration defaults (IBL gain
    // 1.0, no EV bias); only a relight resolves the spec's `ambient_scale`,
    // `ev100_bias`, weather and night controls. A scene that never receives a
    // `set_lighting` request must still render the lighting it declared.
    app.apply_lighting(&spec.lighting, spec.profile_config)?;
    app.load_tiles(&spec.glbs)?;
    app.load_vegetation(&spec.veg_glbs)?;
    // Bevy's atmosphere bindings are a per-view mesh layout. Mixing a
    // sensor view (which intentionally strips cinematic atmosphere) with an
    // atmosphere cinematic view during the same prewarm produces incompatible
    // bind groups and permanently poisons the render pipelines. Prewarm only
    // the actual cinematic layout for physical-atmosphere scenes.
    let prewarm_profiles: &[(&str, Profile)] = if spec.lighting.atmosphere {
        &[("__prewarm_cinematic__", Profile::Cinematic)]
    } else {
        &[
            ("__prewarm_sensor__", Profile::Sensor),
            ("__prewarm_cinematic__", Profile::Cinematic),
        ]
    };
    for &(sensor_id, profile) in prewarm_profiles {
        app.add_camera(
            CameraSpec {
                sensor_id: sensor_id.into(),
                width: 64,
                height: 64,
                fov_y_deg: 58.0,
                near: spec.near_m,
                far: spec.far_m,
                passes: PassSet { rgb: true, id: false, depth: false },
            },
            profile,
        );
    }
    let _legend = app.wait_until_ready()?;
    app.warmup(spec.warmup_frames);
    // Prewarm views must not consume render/readback work in every service
    // tick; real retained-rig cameras are registered on first request.
    app.clear_cameras();
    Ok(app)
}

/// wgpu COPY_BYTES_PER_ROW_ALIGNMENT — must match render-core's readback
/// row stride (`RenderDevice::align_copy_bytes_per_row`).
fn row_stride(width: u32, pixel_bytes: usize) -> usize {
    let row = width as usize * pixel_bytes;
    row.div_ceil(256) * 256
}

/// Fraction of visible pixels in an RGBA8 instance-ID readback. RGB encodes
/// the little-endian 24-bit ID; alpha is intentionally ignored because the
/// clear target and opaque geometry both carry alpha 255.
fn instance_coverage(data: &[u8], width: u32, height: u32) -> f64 {
    let stride = row_stride(width, 4);
    let visible = data
        .chunks_exact(stride)
        .take(height as usize)
        .flat_map(|row| row[..width as usize * 4].chunks_exact(4))
        .filter(|pixel| pixel[0] != 0 || pixel[1] != 0 || pixel[2] != 0)
        .count();
    visible as f64 / f64::from(width * height)
}

/// Cached payload of one pass from the last rendered tick (JPEG source).
struct CachedPass {
    data: Vec<u8>,
    width: u32,
    height: u32,
    stride: usize,
    tick_id: u64,
}

fn build_sensor_scene(triangles: Vec<SensorTriangle>) -> RaycastScene {
    let mut scene = RaycastScene::new();
    for triangle in triangles {
        scene.push_tri(Tri {
            a: Vec3::from_array(triangle.a),
            b: Vec3::from_array(triangle.b),
            c: Vec3::from_array(triangle.c),
            instance_id: triangle.instance_id,
        });
    }
    scene.build();
    scene
}

struct CombinedSensorScene<'a> {
    static_scene: &'a RaycastScene,
    actor_scene: &'a RaycastScene,
}

impl Raycast for CombinedSensorScene<'_> {
    fn cast(&self, origin: Vec3, direction: Vec3, max_distance: f32) -> Option<Hit> {
        match (
            self.static_scene.cast(origin, direction, max_distance),
            self.actor_scene.cast(origin, direction, max_distance),
        ) {
            (Some(static_hit), Some(actor_hit)) if actor_hit.distance < static_hit.distance => {
                Some(actor_hit)
            }
            (Some(static_hit), _) => Some(static_hit),
            (None, actor_hit) => actor_hit,
        }
    }
}

/// Everything the dispatch loop owns. Bevy's App is not Send, so the whole
/// state stays on one thread by design.
pub struct ServiceState {
    pub app: SceneApp,
    pub profile: Profile,
    pub shm_path: String,
    pub shm: ShmRing,
    pub near_m: f32,
    pub far_m: f32,
    /// Cinematic settings currently in force; `set_lighting` updates it so
    /// a lighting-only change keeps the look the scene was prewarmed with.
    pub profile_config: render_core::profiles::RenderProfileConfig,
    /// Static instance legend (id -> mesh name), frozen at readiness.
    legend: HashMap<u32, String>,
    /// Loaded scene-state stream (V2 `load_scene_state`).
    scene: Vec<SceneState>,
    /// Index of the most recently applied scene frame.
    current_tick: Option<u32>,
    /// Pass payloads from the last render (V2 `encode_jpeg` source).
    cache: HashMap<String, CachedPass>,
    /// Retained camera rig in registration order.
    rig: Vec<ServiceCamera>,
    /// Retained CPU sensor rigs in registration order.
    lidars: Vec<ServiceLidar>,
    radars: Vec<ServiceRadar>,
    /// Static map BVH, built once after prewarm and reused for every tick.
    static_sensor_scene: RaycastScene,
    vehicle_models: Option<VehicleModelCatalog>,
    pedestrian_models: Option<VehicleModelCatalog>,
    actor_model_refs: HashMap<String, PathBuf>,
    /// Lighting as the caller authored it (scene spec, then every
    /// `set_lighting`), before the service adds a metering camera.
    lighting_authored: Lighting,
    auto_meter: bool,
    /// Metering camera the service last applied on the caller's behalf.
    auto_meter_view: Option<render_core::atmosphere::MeterView>,
    /// Handles to send behind the `export_device_stream` acknowledgement.
    #[cfg(feature = "gpu-interop")]
    pending_export: Option<render_core::gpu_interop::ExportedStream>,
}

impl ServiceState {
    pub fn new(
        mut app: SceneApp,
        spec: &SceneSpec,
        shm_path: String,
        shm: ShmRing,
    ) -> Result<Self> {
        let vehicle_models = spec
            .vehicle_models
            .as_deref()
            .map(|dir| VehicleModelCatalog::load(Path::new(dir)))
            .transpose()
            .context("load vehicle model catalog")?;
        let pedestrian_models = spec
            .pedestrian_models
            .as_deref()
            .map(|dir| VehicleModelCatalog::load(Path::new(dir)))
            .transpose()
            .context("load pedestrian model catalog")?;
        let legend: HashMap<u32, String> = app
            .legend()
            .into_iter()
            .map(|LegendEntry { id, name }| (id, name))
            .collect();
        let static_sensor_scene = build_sensor_scene(app.sensor_triangles(false));
        Ok(Self {
            app,
            profile: spec.profile,
            shm_path,
            shm,
            near_m: spec.near_m,
            far_m: spec.far_m,
            profile_config: spec.profile_config,
            legend,
            scene: Vec::new(),
            current_tick: None,
            cache: HashMap::new(),
            rig: Vec::new(),
            lidars: Vec::new(),
            radars: Vec::new(),
            static_sensor_scene,
            vehicle_models,
            pedestrian_models,
            actor_model_refs: spec
                .actor_model_refs
                .iter()
                .map(|(actor, path)| (actor.clone(), PathBuf::from(path)))
                .collect(),
            lighting_authored: spec.lighting.clone(),
            auto_meter: spec.auto_meter,
            auto_meter_view: None,
            #[cfg(feature = "gpu-interop")]
            pending_export: None,
        })
    }

    /// Exported handles produced by the last `export_device_stream`, to be
    /// delivered to the consumer by whoever owns the transport.
    #[cfg(feature = "gpu-interop")]
    pub fn take_export(&mut self) -> Option<render_core::gpu_interop::ExportedStream> {
        self.pending_export.take()
    }
}

/// Re-meter the live look through `cam` at `eye -> target` when the caller
/// left the metering camera to the service and the heading, field or aspect
/// moved since the last reading. An in-place advance (see
/// `SceneApp::advance_lighting`): ~25 ms by day, and the TAA history is kept.
fn auto_meter(state: &mut ServiceState, cam: &ServiceCamera, eye: &[f32; 3], target: &[f32; 3]) {
    if !state.auto_meter
        || !state.lighting_authored.atmosphere
        || state.lighting_authored.meter_view.is_some()
    {
        return;
    }
    let forward = [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]];
    let len = (forward[0] * forward[0] + forward[1] * forward[1] + forward[2] * forward[2]).sqrt();
    if len <= 1.0e-6 {
        return;
    }
    let view = render_core::atmosphere::MeterView {
        forward: [forward[0] / len, forward[1] / len, forward[2] / len],
        fov_y_deg: cam.fov_deg,
        aspect: cam.width.max(1) as f32 / cam.height.max(1) as f32,
    };
    if let Some(previous) = &state.auto_meter_view {
        let cos = previous.forward[0] * view.forward[0]
            + previous.forward[1] * view.forward[1]
            + previous.forward[2] * view.forward[2];
        let same_heading = cos >= 0.5f32.to_radians().cos();
        if same_heading
            && (previous.fov_y_deg - view.fov_y_deg).abs() < 1.0e-3
            && (previous.aspect - view.aspect).abs() < 1.0e-3
        {
            return;
        }
    }
    let mut lighting = state.lighting_authored.clone();
    lighting.meter_view = Some(view);
    match state.app.advance_lighting(&lighting, state.profile_config) {
        Ok(_) => {
            state.auto_meter_view = Some(view);
            state.cache.clear();
        }
        Err(error) => eprintln!("auto meter: {error:#}"),
    }
}

/// Readiness record written to `--ready-file` once the endpoint is bound:
/// everything a host needs to connect and map the ring without probing
/// the endpoint itself (a stat/connect poll is not portable to named
/// pipes). Written atomically (temp file + rename).
#[derive(Debug, serde::Serialize)]
pub struct ReadyRecord<'a> {
    pub protocol: u32,
    pub pid: u32,
    /// The `--socket` value as given: a Unix socket path or a Windows
    /// named-pipe endpoint (see [`crate::endpoint`]).
    pub endpoint: &'a str,
    pub shm: ShmInfo,
}

fn write_ready_file(path: &Path, record: &ReadyRecord<'_>) -> Result<()> {
    let body = serde_json::to_vec_pretty(record)?;
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, body).with_context(|| format!("write {}", tmp.display()))?;
    std::fs::rename(&tmp, path).with_context(|| format!("publish {}", path.display()))?;
    Ok(())
}

/// Serve one local endpoint until killed or `close`. A new connection
/// replaces the old one (env-server serveSocket convention). `ready_file`,
/// when given, receives a [`ReadyRecord`] as soon as the endpoint accepts
/// connections.
pub fn serve(mut state: ServiceState, endpoint: &str, ready_file: Option<&Path>) -> Result<()> {
    let mut listener = crate::endpoint::Listener::bind(endpoint)?;
    eprintln!(
        "native-render-service listening on {} (profile {:?})",
        crate::endpoint::describe(listener.endpoint()),
        state.profile
    );
    if let Some(path) = ready_file {
        let (size_bytes, meta_bytes, _) = state.shm.path_size_meta();
        write_ready_file(
            path,
            &ReadyRecord {
                protocol: NATIVE_SERVICE_PROTOCOL_VERSION,
                pid: std::process::id(),
                endpoint: listener.endpoint(),
                shm: ShmInfo { path: state.shm_path.clone(), size_bytes, meta_bytes },
            },
        )?;
    }

    loop {
        let connection = listener.accept()?;
        match handle_connection(&mut state, connection) {
            Ok(CloseConnection::ClientClose) | Ok(CloseConnection::Eof) => {}
            Err(error) => eprintln!("connection error: {error:#}"),
        }
    }
}

enum CloseConnection {
    ClientClose,
    Eof,
}

fn handle_connection(
    state: &mut ServiceState,
    mut connection: crate::endpoint::Connection,
) -> Result<CloseConnection> {
    let mut reader = FrameReader::new();
    let mut buf = [0u8; 65536];
    loop {
        let n = connection.read(&mut buf)?;
        if n == 0 {
            return Ok(CloseConnection::Eof);
        }
        for payload in reader.push(&buf[..n]).map_err(anyhow::Error::msg)? {
            let request = decode_request(&payload).map_err(anyhow::Error::msg)?;
            let response = dispatch(state, request);
            connection.write_all(&encode_frame(&response)?)?;
            // Descriptor transfer rides the same socket right behind its
            // acknowledgement: this thread is the only writer, so the
            // `SFGX` frame and its SCM_RIGHTS cannot interleave.
            #[cfg(feature = "gpu-interop")]
            if let Some(exported) = state.take_export() {
                exported
                    .send_over_unix(connection.unix_stream())
                    .context("send device stream handles")?;
            }
            if matches!(response.body, ResponseBody::Close { .. }) {
                return Ok(CloseConnection::ClientClose);
            }
        }
    }
}

/// Serve one decoded request against the resident scene. Shared by the
/// socket loop and the in-process FFI host; after an `export_device_stream`
/// acknowledgement the caller must drain [`ServiceState::take_export`].
pub fn dispatch(state: &mut ServiceState, request: WireRequest) -> WireResponse {
    let i = request.i;
    match request.body {
        RequestBody::Hello => {
            let (size_bytes, meta_bytes, _) = state.shm.path_size_meta();
            WireResponse {
                i,
                body: ResponseBody::Hello {
                    ok: true,
                    protocol: NATIVE_SERVICE_PROTOCOL_VERSION,
                    profile: format!("{:?}", state.profile).to_lowercase(),
                    legend_entries: state.legend.len(),
                    shm: ShmInfo {
                        path: state.shm_path.clone(),
                        size_bytes,
                        meta_bytes,
                    },
                },
            }
        }
        RequestBody::Load { glbs } => {
            let tiles = glbs.len();
            match state.app.load_tiles(&glbs).and_then(|()| state.app.wait_until_ready().map(|_| ())) {
                Ok(()) => WireResponse { i, body: ResponseBody::Load { ok: true, tiles } },
                Err(error) => WireResponse::error(i, format!("load failed: {error:#}")),
            }
        }
        RequestBody::LoadSceneState { states } => {
            if let Some(first) = states.first() {
                if let Err(error) = first.validate() {
                    return WireResponse::error(i, error);
                }
            }
            let ticks = states.len();
            let map_id = states.first().map(|s| s.map_id.clone()).unwrap_or_default();
            state.scene = states;
            state.current_tick = None;
            WireResponse { i, body: ResponseBody::LoadSceneState { ok: true, ticks, map_id } }
        }
        RequestBody::ResetCameras => {
            state.app.clear_cameras();
            state.cache.clear();
            state.rig.clear();
            state.lidars.clear();
            state.radars.clear();
            WireResponse { i, body: ResponseBody::ResetCameras { ok: true } }
        }
        RequestBody::SetLighting { lighting, profile_config, advance } => {
            let started = std::time::Instant::now();
            let profile_config = profile_config.unwrap_or(state.profile_config);
            let outcome = if advance {
                state.app.advance_lighting(&lighting, profile_config)
            } else {
                state.app.apply_lighting(&lighting, profile_config).map(|r| (r, false))
            };
            match outcome {
                Ok((resolved, full_relight)) => {
                    state.profile_config = profile_config;
                    state.lighting_authored = lighting.clone();
                    state.auto_meter_view = None;
                    // Frames cached against the previous look are stale.
                    state.cache.clear();
                    WireResponse {
                        i,
                        body: ResponseBody::SetLighting {
                            ok: true,
                            resolved,
                            // Requested mode, and what the live views
                            // actually carry after the strip/apply cycle.
                            anti_alias: profile_config.cinematic.aa.as_str().to_string(),
                            camera_anti_alias: state.app.camera_anti_alias(),
                            server_ms: started.elapsed().as_secs_f64() * 1000.0,
                            full_relight,
                        },
                    }
                }
                Err(error) => WireResponse::error(i, format!("set_lighting failed: {error:#}")),
            }
        }
        RequestBody::GetState => {
            let camera_anti_alias = state.app.camera_anti_alias();
            WireResponse {
                i,
                body: ResponseBody::GetState {
                    ok: true,
                    protocol: crate::proto::NATIVE_SERVICE_PROTOCOL_VERSION,
                    resolved: state.app.resolved_lighting(),
                    anti_alias: state.profile_config.cinematic.aa.as_str().to_string(),
                    cameras: camera_anti_alias.len(),
                    camera_anti_alias,
                },
            }
        }
        RequestBody::Render { tick_id, cameras, export_dir, tick_index } => {
            render_tick(state, i, tick_id, cameras, export_dir, tick_index)
        }
        RequestBody::RenderBundle {
            sim_tick,
            cameras,
            lidars,
            radars,
            tick_index,
            passes,
            device_sensors,
        } => render_bundle_op(
            state,
            i,
            sim_tick,
            cameras,
            lidars,
            radars,
            tick_index,
            passes,
            device_sensors.unwrap_or_default(),
        ),
        RequestBody::EncodeJpeg { items } => encode_jpeg_op(state, i, items),
        RequestBody::OpenDeviceStream { sensor_id, passes, slots, wait_ms } => {
            open_device_stream_op(state, i, &sensor_id, &passes, slots, wait_ms)
        }
        RequestBody::ExportDeviceStream { sensor_id } => export_device_stream_op(state, i, &sensor_id),
        RequestBody::CloseDeviceStream { sensor_id, grace_ms } => {
            close_device_stream_op(state, i, &sensor_id, grace_ms)
        }
        RequestBody::Close => WireResponse { i, body: ResponseBody::Close { ok: true } },
    }
}

fn resolve_actor_model(state: &ServiceState, actor: &ActorState) -> Option<VehicleModelEntry> {
    if let Some(path) = state.actor_model_refs.get(&actor.id) {
        return Some(VehicleModelEntry {
            glb_path: path.clone(),
            attribution: String::new(),
            source: "scene-spec-override".to_string(),
            tintable: false,
            scale_to_dims: false,
            model_length_m: None,
            uniform_scale: None,
            yaw_offset_rad: 0.0,
            ground_offset_m: 0.0,
            animations: HashMap::new(),
        });
    }
    let catalog_id = actor.catalog_id.as_deref()?;
    let catalog = if actor.actor_class.as_deref() == Some("pedestrian") {
        state.pedestrian_models.as_ref()?
    } else {
        state.vehicle_models.as_ref()?
    };
    catalog.resolve(catalog_id).cloned()
}

/// Apply scene-state frame `index` to the world (spawn/update/despawn).
fn apply_scene_tick(state: &mut ServiceState, index: u32) -> Result<(), String> {
    let frame = state
        .scene
        .get(index as usize)
        .cloned()
        .ok_or_else(|| format!("tick_index {index} out of range (loaded {} ticks)", state.scene.len()))?;
    for actor in &frame.actors {
        match actor.kind.as_str() {
            "despawn" => state.app.remove_actor(&actor.id),
            "spawn" | "update" => {
                let class = actor.actor_class.clone().unwrap_or_else(|| "prop".into());
                let color = actor_color(actor, &class)?;
                let body_centred = actor
                    .catalog_id
                    .as_deref()
                    .is_some_and(render_core::catalog::body_centred_origin);
                let dims = if body_centred {
                    actor.dims.map(|d| [d.l, d.h, d.w]).unwrap_or_else(|| actor_dims(&class))
                } else {
                    actor_dims(&class)
                };
                // Body-centred catalog entries (articulated robot components)
                // are placed verbatim with their full rotation and never get
                // a GLB or a ground fallback.
                let model = if body_centred { None } else { resolve_actor_model(state, actor) };
                let [qx, qy, qz, qw] = actor.transform.rotation;
                let mut rotation = Quat::from_xyzw(qx, qy, qz, qw).normalize();
                let mut position = actor.transform.position;
                if !body_centred {
                    rotation = Quat::from_rotation_y(quat_yaw(&actor.transform.rotation));
                    position[1] = actor_base_y(
                        position[1],
                        frame.ground_y,
                        state.app.ground_at(position[0], position[2]),
                    );
                }
                if let Some(model) = &model {
                    rotation = Quat::from_rotation_y(model.yaw_offset_rad) * rotation;
                    position[1] += model.ground_offset_m;
                }
                state.app.upsert_actor(
                    &actor.id,
                    &class,
                    position,
                    rotation,
                    dims,
                    color,
                    false,
                );
                if let Some(model) = model {
                    let moving = actor.velocity.iter().map(|value| value * value).sum::<f32>().sqrt() > 0.2
                        || actor.catalog_id.as_deref().is_some_and(|id| id.ends_with("_walking"));
                    let animation = model.animations.get(if moving { "walk" } else { "idle" });
                    let (glb_path, clip) = animation
                        .map(|(path, clip)| (path, Some(clip.as_str())))
                        .unwrap_or((&model.glb_path, None));
                    let animation_time_s = if frame.tick_hz > 0.0 {
                        frame.tick as f32 / frame.tick_hz
                    } else {
                        0.0
                    };
                    if !state.app.actor_has_model(&actor.id) {
                        if !glb_path.is_file() {
                            eprintln!(
                                "catalog model for {} is missing; retaining proxy: {}",
                                actor.id,
                                glb_path.display()
                            );
                            continue;
                        }
                        let scale = model.uniform_scale.unwrap_or_else(|| {
                            if model.scale_to_dims {
                                model
                                    .model_length_m
                                    .filter(|length| *length > 0.1)
                                    .map(|length| dims[0] / length as f32)
                                    .unwrap_or(1.0)
                            } else {
                                1.0
                            }
                        });
                        if let Err(error) = state.app.attach_actor_asset(
                            &actor.id,
                            glb_path,
                            scale,
                            model.tintable.then_some(color),
                            clip,
                            animation_time_s,
                        ) {
                            eprintln!(
                                "catalog model for {} failed to load; retaining proxy: {error:#}",
                                actor.id
                            );
                        }
                    } else if clip.is_some() {
                        let _ = state
                            .app
                            .set_actor_animation_time(&actor.id, animation_time_s);
                    }
                }
            }
            other => return Err(format!("unknown actor kind {other:?} for {}", actor.id)),
        }
    }
    state.current_tick = Some(index);
    Ok(())
}

/// Height precedence for authored scene state. Non-zero actor Y is canonical;
/// frame `groundY` is the explicit fallback for legacy zero-height traces;
/// mesh sampling is only the last resort when neither is authored.
fn actor_base_y(authored_y: f32, frame_ground_y: Option<f32>, sampled_y: f32) -> f32 {
    if authored_y.abs() >= 1e-4 {
        authored_y
    } else {
        frame_ground_y.unwrap_or(sampled_y)
    }
}

fn quat_yaw(q: &[f32; 4]) -> f32 {
    let [x, y, z, w] = *q;
    // Yaw about +Y from a unit quaternion.
    let sin = 2.0 * (w * y + z * x);
    let cos = 1.0 - 2.0 * (y * y + z * z);
    sin.atan2(cos)
}

/// Interim actor geometry: cuboids per class until the prop-catalog actor
/// pipeline lands in render-core (same stand-in as the WSB3 harness).
fn actor_dims(class: &str) -> [f32; 3] {
    match class {
        "car" => [4.5, 1.6, 1.8],
        "van" | "suv" | "pickup" => [4.8, 1.9, 2.0],
        "truck" | "bus" => [8.0, 3.0, 2.5],
        "motorcycle" | "cyclist" => [2.2, 1.5, 0.9],
        "pedestrian" => [0.5, 1.8, 0.5],
        _ => [1.0, 1.0, 1.0],
    }
}

fn class_color(class: &str) -> [f32; 3] {
    match class {
        "car" => [0.65, 0.67, 0.70],
        "truck" | "bus" => [0.55, 0.58, 0.62],
        "motorcycle" | "cyclist" => [0.60, 0.55, 0.45],
        "pedestrian" => [0.75, 0.65, 0.55],
        _ => [0.5, 0.5, 0.5],
    }
}

fn actor_color(actor: &ActorState, class: &str) -> Result<[f32; 3], String> {
    let Some(authored) = actor.color.as_deref() else {
        return Ok(class_color(class));
    };
    let color = render_core::catalog::parse_hex_color(authored)
        .ok_or_else(|| format!("invalid actor color {authored:?} for {}", actor.id))?
        .to_srgba();
    Ok([color.red, color.green, color.blue])
}

fn resolved_actor_y(position_y: f32, authored_ground_y: Option<f32>, sampled_ground_y: f32) -> f32 {
    if position_y.abs() < 1e-4 && authored_ground_y.is_none() {
        sampled_ground_y
    } else {
        position_y
    }
}

/// Resolve a camera pose: explicit eye/target, or rigid attachment against
/// the current scene frame.
fn resolve_pose(
    state: &ServiceState,
    cam: &ServiceCamera,
) -> Result<([f32; 3], [f32; 3]), String> {
    let Some(attach) = &cam.attach else {
        return Ok((cam.eye, cam.target));
    };
    let index = state
        .current_tick
        .ok_or_else(|| "attach requested but no scene tick applied yet".to_string())?;
    let frame = &state.scene[index as usize];
    let actor = frame
        .actors
        .iter()
        .find(|a| a.id == attach.actor_id && a.kind != "despawn")
        .ok_or_else(|| format!("attach actor {:?} not present in tick {index}", attach.actor_id))?;
    let yaw = quat_yaw(&actor.transform.rotation);
    let pos = actor.transform.position;
    let base_y = actor_base_y(
        pos[1],
        frame.ground_y,
        state.app.ground_at(pos[0], pos[2]),
    );
    // Actor-local mount (x fwd, y right, z up) -> world (y-up, yaw about +Y).
    let (sy, cy) = yaw.sin_cos();
    let off = attach.offset_m;
    let eye = [
        pos[0] + cy * off[0] + sy * off[1],
        base_y + off[2],
        pos[2] - sy * off[0] + cy * off[1],
    ];
    if attach.look_at_actor {
        return Ok((eye, [pos[0], base_y + 1.0, pos[2]]));
    }
    // CARLA yaw is left-handed (clockwise from above); Uni yaw is CCW, so a
    // CARLA-relative mount yaw subtracts. Pitch passes through (negative =
    // down, matching CARLA semantics).
    let total_yaw = yaw - attach.yaw_deg.to_radians();
    let pitch = attach.pitch_deg.to_radians();
    let (ty, tyc) = total_yaw.sin_cos();
    let (sp, cp) = pitch.sin_cos();
    let dir = [cp * tyc, sp, -cp * ty];
    const TARGET_DIST: f32 = 50.0;
    let target = [
        eye[0] + TARGET_DIST * dir[0],
        eye[1] + TARGET_DIST * dir[1],
        eye[2] + TARGET_DIST * dir[2],
    ];
    Ok((eye, target))
}

struct ResolvedSensorMount {
    origin: Vec3,
    rotation: Quat,
    host_velocity: Vec3,
}

fn resolve_sensor_mount(
    state: &ServiceState,
    attach: &CameraAttach,
) -> Result<ResolvedSensorMount, String> {
    let index = state
        .current_tick
        .ok_or_else(|| "sensor attach requested but no scene tick applied yet".to_string())?;
    let frame = &state.scene[index as usize];
    let actor = frame
        .actors
        .iter()
        .find(|actor| actor.id == attach.actor_id && actor.kind != "despawn")
        .ok_or_else(|| {
            format!(
                "sensor attach actor {:?} not present in tick {index}",
                attach.actor_id
            )
        })?;
    let yaw = quat_yaw(&actor.transform.rotation);
    let position = actor.transform.position;
    let actor_y = resolved_actor_y(
        position[1],
        frame.ground_y,
        state.app.ground_at(position[0], position[2]),
    );
    let actor_rotation = Quat::from_rotation_y(yaw);
    // Wire mount coordinates are x-forward, y-right, z-up. The deterministic
    // sensor model's canonical local frame is x-forward, y-up, z-left.
    let local_offset = Vec3::new(
        attach.offset_m[0],
        attach.offset_m[2],
        -attach.offset_m[1],
    );
    let origin = Vec3::new(position[0], actor_y, position[2])
        + actor_rotation.mul_vec3(local_offset);
    let mount_rotation = Quat::from_euler(
        EulerRot::YXZ,
        attach.yaw_deg.to_radians(),
        attach.pitch_deg.to_radians(),
        attach.roll_deg.to_radians(),
    );
    Ok(ResolvedSensorMount {
        origin,
        rotation: actor_rotation * mount_rotation,
        host_velocity: Vec3::from_array(actor.velocity),
    })
}

fn upsert_lidar_rig(state: &mut ServiceState, sensor: &ServiceLidar) {
    match state
        .lidars
        .iter_mut()
        .find(|registered| registered.sensor_id == sensor.sensor_id)
    {
        Some(registered) => *registered = sensor.clone(),
        None => state.lidars.push(sensor.clone()),
    }
}

fn upsert_radar_rig(state: &mut ServiceState, sensor: &ServiceRadar) {
    match state
        .radars
        .iter_mut()
        .find(|registered| registered.sensor_id == sensor.sensor_id)
    {
        Some(registered) => *registered = sensor.clone(),
        None => state.radars.push(sensor.clone()),
    }
}

/// Upsert a camera spec into the retained rig (registration order kept).
fn upsert_rig(state: &mut ServiceState, cam: &ServiceCamera) {
    match state.rig.iter_mut().find(|c| c.sensor_id == cam.sensor_id) {
        Some(slot) => *slot = cam.clone(),
        None => state.rig.push(cam.clone()),
    }
}

/// GPU pass set every service camera is registered with. Which of them
/// are copied out is decided per request (`capture_keys`); the ID view
/// only renders when one of its passes is requested.
const SERVICE_PASSES: PassSet = PassSet { rgb: true, id: true, depth: true };

/// Register a camera, or re-register it when its size, field of view or
/// profile changed since the last request. Cached payloads of a replaced
/// camera belong to the old target and are dropped.
fn ensure_camera(state: &mut ServiceState, cam: &ServiceCamera) {
    let spec = CameraSpec {
        sensor_id: cam.sensor_id.clone(),
        width: cam.width,
        height: cam.height,
        fov_y_deg: cam.fov_deg,
        near: state.near_m,
        far: state.far_m,
        passes: SERVICE_PASSES,
    };
    let profile = cam.profile.unwrap_or(state.profile);
    if state.app.camera(&cam.sensor_id) == Some((&spec, profile)) {
        return;
    }
    let prefix = format!("{}:", cam.sensor_id);
    state.cache.retain(|key, _| !key.starts_with(&prefix));
    state.app.add_camera(spec, profile);
}

/// Bring the resident rig in line with `cameras` for this tick: register
/// or replace each camera, mount it on its attach actor (so that actor's
/// RGB geometry is excluded from this view only), resolve and set its
/// pose, and re-meter through the first camera.
fn sync_rig(state: &mut ServiceState, cameras: &[ServiceCamera]) -> Result<(), String> {
    for (index, cam) in cameras.iter().enumerate() {
        ensure_camera(state, cam);
        let host = cam.attach.as_ref().map(|attach| attach.actor_id.as_str());
        state
            .app
            .set_camera_host(&cam.sensor_id, host)
            .map_err(|error| format!("set host: {error:#}"))?;
        let (eye, target) = resolve_pose(state, cam)?;
        state
            .app
            .set_pose(&cam.sensor_id, &eye, &target)
            .map_err(|error| format!("set pose: {error:#}"))?;
        if index == 0 {
            auto_meter(state, cam, &eye, &target);
        }
    }
    Ok(())
}

/// Capture keys for `cameras` restricted to `passes`.
fn capture_keys(cameras: &[ServiceCamera], passes: PassSet) -> Vec<String> {
    cameras
        .iter()
        .flat_map(|cam| passes.keys(&cam.sensor_id))
        .collect()
}

/// Publish one payload into the ring and record it. Returns the record
/// offset and the payload CRC32.
#[allow(clippy::too_many_arguments)]
fn publish_frame(
    state: &mut ServiceState,
    sensor_id: &str,
    pass: &str,
    width: u32,
    height: u32,
    format_tag: u32,
    format_name: &str,
    tick_id: u64,
    data: &[u8],
    frames: &mut Vec<FrameRecord>,
) -> Result<(u64, u32), String> {
    let digest = crc32fast::hash(data);
    let offset = state
        .shm
        .publish(sensor_id, pass, width, height, format_tag, tick_id, data)
        .map_err(|error| format!("publish: {error}"))?;
    frames.push(FrameRecord {
        sensor_id: sensor_id.to_string(),
        pass: pass.to_string(),
        offset,
        len: data.len() as u64,
        width,
        height,
        format: format_name.to_string(),
        tick_id,
        digest: format!("{digest:08x}"),
    });
    Ok((offset, digest))
}

/// Derive the CARLA semantic layout from an instance-ID payload.
fn semantic_from_ids(state: &ServiceState, id_data: &[u8], width: u32, height: u32, stride: usize) -> Vec<u8> {
    let legend = &state.legend;
    let app = &state.app;
    crate::carla::semantic_from_ids(id_data, width, height, stride, |id| {
        if let Some(class) = app.actor_instance_class(id) {
            return crate::carla::actor_class_of(class);
        }
        legend
            .get(&id)
            .map(|name| crate::carla::static_class_of(name))
            .unwrap_or(0)
    })
}

/// One camera pass ready for publication, in canonical order.
struct PlannedPass {
    pass: &'static str,
    format_tag: u32,
    format_name: &'static str,
    data: Vec<u8>,
}

/// The bytes of one captured pass. Every requested pass must be present in
/// the capture; the engine guarantees that for registered keys, so absence
/// is an internal error.
fn captured_pass<'a>(
    captured: &'a CapturedFrame,
    sensor_id: &str,
    pass: &str,
) -> Result<&'a [u8], String> {
    captured
        .passes
        .get(&format!("{sensor_id}:{pass}"))
        .map(|captured| captured.bytes.as_slice())
        .ok_or_else(|| {
            format!(
                "capture generation {} has no {pass:?} for {sensor_id}",
                captured.identity.generation
            )
        })
}

/// Encode the captured passes of one camera for publication: rgb, id,
/// depth (raw or CARLA-packed), semantic (derived from id).
fn plan_camera_passes(
    state: &ServiceState,
    captured: &CapturedFrame,
    cam: &ServiceCamera,
    want: PassSet,
    want_semantic: bool,
) -> Result<Vec<PlannedPass>, String> {
    let stride = row_stride(cam.width, 4);
    let take = |pass| captured_pass(captured, &cam.sensor_id, pass);
    let mut planned = Vec::with_capacity(4);
    if want.rgb {
        planned.push(PlannedPass { pass: "rgb", format_tag: FORMAT_RGBA8, format_name: "rgba8", data: take("rgb")?.to_vec() });
    }
    if want.id {
        planned.push(PlannedPass { pass: "id", format_tag: FORMAT_RGBA8, format_name: "rgba8", data: take("id")?.to_vec() });
    }
    if want.depth {
        let raw = take("depth")?;
        let carla = cam.depth_encoding.as_deref() == Some("carla");
        planned.push(PlannedPass {
            pass: "depth",
            format_tag: FORMAT_DEPTH32F,
            format_name: if carla { "carla-depth-bgra" } else { "depth32f" },
            data: if carla {
                crate::carla::depth_to_carla(raw, cam.width, cam.height, stride, state.near_m, state.far_m)
            } else {
                raw.to_vec()
            },
        });
    }
    if want_semantic {
        let out = semantic_from_ids(state, take("id")?, cam.width, cam.height, stride);
        planned.push(PlannedPass { pass: "semantic", format_tag: FORMAT_RGBA8, format_name: "rgba8", data: out });
    }
    Ok(planned)
}

fn render_tick(
    state: &mut ServiceState,
    i: u64,
    tick_id: u64,
    cameras: Vec<ServiceCamera>,
    export_dir: Option<String>,
    tick_index: Option<u32>,
) -> WireResponse {
    let t0 = std::time::Instant::now();
    if let Some(index) = tick_index {
        if let Err(error) = apply_scene_tick(state, index) {
            return WireResponse::error(i, error);
        }
    }
    for cam in &cameras {
        upsert_rig(state, cam);
    }
    if let Err(error) = sync_rig(state, &cameras) {
        return WireResponse::error(i, error);
    }
    let captured = match state.app.capture(tick_id, &capture_keys(&cameras, SERVICE_PASSES)) {
        Ok(captured) => captured,
        Err(error) => return WireResponse::error(i, format!("render: {error:#}")),
    };
    let mut frames = Vec::new();
    let mut coverage = Vec::with_capacity(cameras.len());
    let mut export_payloads: Vec<(String, String, u32, u32, Vec<u8>)> = Vec::new();
    // Publish in deterministic order: cameras in request order, passes
    // rgb/id/depth/semantic within each.
    for cam in &cameras {
        let stride = row_stride(cam.width, 4);
        let planned = match plan_camera_passes(state, &captured, cam, SERVICE_PASSES, cam.semantic) {
            Ok(planned) => planned,
            Err(error) => return WireResponse::error(i, error),
        };
        for PlannedPass { pass, format_tag, format_name, data } in planned {
            if pass == "id" {
                coverage.push(CoverageRecord {
                    sensor_id: cam.sensor_id.clone(),
                    fraction: instance_coverage(&data, cam.width, cam.height),
                });
            }
            if let Err(error) = publish_frame(
                state, &cam.sensor_id, pass, cam.width, cam.height, format_tag, format_name, tick_id, &data, &mut frames,
            ) {
                return WireResponse::error(i, error);
            }
            if export_dir.is_some() {
                export_payloads.push((cam.sensor_id.clone(), pass.to_string(), cam.width, cam.height, data.clone()));
            }
            if pass != "semantic" {
                // JPEG source: the raw pass bytes (depth stays the linear
                // readback even when published CARLA-packed).
                let raw = if pass == "depth" {
                    captured.passes[&format!("{}:depth", cam.sensor_id)].bytes.clone()
                } else {
                    data
                };
                state.cache.insert(
                    format!("{}:{pass}", cam.sensor_id),
                    CachedPass { data: raw, width: cam.width, height: cam.height, stride, tick_id },
                );
            }
        }
    }
    let server_ms = t0.elapsed().as_secs_f64() * 1000.0;
    if let Some(dir) = export_dir {
        std::fs::create_dir_all(&dir).ok();
        std::thread::spawn(move || {
            async_export_pngs(&dir, tick_id, &export_payloads);
        });
    }
    WireResponse {
        i,
        body: ResponseBody::Render {
            ok: true,
            tick_id,
            frame: captured.identity,
            frames,
            server_ms,
            coverage,
        },
    }
}

fn encode_jpeg_op(state: &mut ServiceState, i: u64, items: Vec<JpegItem>) -> WireResponse {
    let t0 = std::time::Instant::now();
    let mut frames = Vec::new();
    let mut tick_id = 0;
    for item in &items {
        let key = format!("{}:{}", item.sensor_id, item.pass);
        let Some(cached) = state.cache.get(&key) else {
            return WireResponse::error(i, format!("no cached pass {key} (render first)"));
        };
        let rgba = crate::carla::strip_rgba_padding(&cached.data, cached.width, cached.height, cached.stride);
        // RGBA -> RGB.
        let mut rgb = Vec::with_capacity(cached.width as usize * cached.height as usize * 3);
        for px in rgba.chunks_exact(4) {
            rgb.extend_from_slice(&px[..3]);
        }
        tick_id = cached.tick_id;
        let (w, h) = (cached.width, cached.height);
        let jpeg = match crate::carla::encode_jpeg(&rgb, w, h, item.quality) {
            Ok(j) => j,
            Err(error) => return WireResponse::error(i, error),
        };
        if let Err(error) = publish_frame(
            state, &item.sensor_id, "jpeg", w, h, FORMAT_JPEG, "jpeg", tick_id, &jpeg, &mut frames,
        ) {
            return WireResponse::error(i, error);
        }
    }
    let server_ms = t0.elapsed().as_secs_f64() * 1000.0;
    WireResponse { i, body: ResponseBody::EncodeJpeg { ok: true, tick_id, frames, server_ms } }
}

/// Publish one payload into the ring as both a frame record and a bundle
/// table entry.
#[allow(clippy::too_many_arguments)]
fn publish_bundle_frame(
    state: &mut ServiceState,
    sensor_id: &str,
    pass: &str,
    width: u32,
    height: u32,
    format_tag: u32,
    format_name: &str,
    sim_tick: u64,
    data: &[u8],
    entries: &mut Vec<BundleEntry>,
    frames: &mut Vec<FrameRecord>,
) -> Result<(), String> {
    let (offset, digest) = publish_frame(
        state, sensor_id, pass, width, height, format_tag, format_name, sim_tick, data, frames,
    )?;
    entries.push(BundleEntry {
        camera_id: sensor_id.to_string(),
        pass: pass.to_string(),
        payload_offset: offset + crate::shm::RECORD_HEADER_BYTES as u64,
        payload_len: data.len() as u64,
        width,
        height,
        format_tag,
        digest,
    });
    Ok(())
}

/// One capture for a bundle: host keys plus, when requested, device
/// streams filled by the same submission.
fn capture_bundle(
    state: &mut ServiceState,
    sim_tick: u64,
    host_keys: &[String],
    device_sensors: &[String],
) -> Result<CapturedFrame> {
    if device_sensors.is_empty() {
        return state.app.capture(sim_tick, host_keys);
    }
    #[cfg(feature = "gpu-interop")]
    {
        state.app.capture_device(sim_tick, host_keys, device_sensors)
    }
    #[cfg(not(feature = "gpu-interop"))]
    {
        anyhow::bail!(NO_DEVICE_INTEROP)
    }
}

/// Device-stream ops are rejected outright on builds without the Linux-only
/// `gpu-interop` feature; host frames through the ring are the portable path.
#[cfg(not(feature = "gpu-interop"))]
const NO_DEVICE_INTEROP: &str = if cfg!(target_os = "linux") {
    "this native-render-service was built without the `gpu-interop` feature; device streams are unavailable (host frames via the shm ring remain available)"
} else {
    "device streams (Vulkan/CUDA opaque-fd export) are a Linux-only capability; this OS build serves host frames via the shm ring only"
};

#[cfg(feature = "gpu-interop")]
fn open_device_stream_op(
    state: &mut ServiceState,
    i: u64,
    sensor_id: &str,
    passes: &[String],
    slots: u32,
    wait_ms: Option<u64>,
) -> WireResponse {
    let (want, _, semantic) = match parse_bundle_passes(passes) {
        Ok(parsed) => parsed,
        Err(error) => return WireResponse::error(i, error),
    };
    if semantic {
        return WireResponse::error(i, "device streams carry rendered planes only; `semantic` is a host-derived pass");
    }
    if slots == 0 {
        return WireResponse::error(i, "open_device_stream: slots must be at least 1");
    }
    let wait = wait_ms.map(std::time::Duration::from_millis);
    match state.app.open_device_stream(sensor_id, want, slots as usize, wait) {
        Ok((stream_id, planes)) => WireResponse {
            i,
            body: ResponseBody::OpenDeviceStream {
                ok: true,
                sensor_id: sensor_id.to_string(),
                stream_id,
                planes: planes
                    .into_iter()
                    .map(|plane| crate::proto::DevicePlaneLayout {
                        name: plane.name,
                        width: plane.width,
                        height: plane.height,
                        format: serde_json::to_value(plane.format)
                            .ok()
                            .and_then(|value| value.as_str().map(str::to_owned))
                            .unwrap_or_default(),
                        dtype: plane.dtype,
                        channels: plane.channels,
                        pixel_bytes: plane.pixel_bytes,
                        offset: plane.offset,
                        row_stride: plane.row_stride,
                        bytes: plane.bytes,
                    })
                    .collect(),
            },
        },
        Err(error) => WireResponse::error(i, format!("open_device_stream: {error:#}")),
    }
}

#[cfg(feature = "gpu-interop")]
fn export_device_stream_op(state: &mut ServiceState, i: u64, sensor_id: &str) -> WireResponse {
    match state.app.export_device_stream(sensor_id) {
        Ok(exported) => {
            let response = ResponseBody::ExportDeviceStream {
                ok: true,
                sensor_id: sensor_id.to_string(),
                stream_id: exported.manifest.stream_id.0,
                slots: exported.manifest.slots,
            };
            state.pending_export = Some(exported);
            WireResponse { i, body: response }
        }
        Err(error) => WireResponse::error(i, format!("export_device_stream: {error:#}")),
    }
}

#[cfg(feature = "gpu-interop")]
fn close_device_stream_op(state: &mut ServiceState, i: u64, sensor_id: &str, grace_ms: u64) -> WireResponse {
    match state
        .app
        .close_device_stream(sensor_id, std::time::Duration::from_millis(grace_ms))
    {
        Ok(Some(teardown)) => WireResponse {
            i,
            body: ResponseBody::CloseDeviceStream {
                ok: true,
                sensor_id: sensor_id.to_string(),
                outstanding_consumer_leases: teardown.outstanding_consumer_leases as u32,
                abandoned_producer_leases: teardown.abandoned_producer_leases as u32,
            },
        },
        Ok(None) => WireResponse::error(i, format!("close_device_stream: no device stream open for {sensor_id}")),
        Err(error) => WireResponse::error(i, format!("close_device_stream: {error:#}")),
    }
}

#[cfg(not(feature = "gpu-interop"))]
fn open_device_stream_op(
    _state: &mut ServiceState,
    i: u64,
    _sensor_id: &str,
    _passes: &[String],
    _slots: u32,
    _wait_ms: Option<u64>,
) -> WireResponse {
    WireResponse::error(i, NO_DEVICE_INTEROP)
}

#[cfg(not(feature = "gpu-interop"))]
fn export_device_stream_op(_state: &mut ServiceState, i: u64, _sensor_id: &str) -> WireResponse {
    WireResponse::error(i, NO_DEVICE_INTEROP)
}

#[cfg(not(feature = "gpu-interop"))]
fn close_device_stream_op(_state: &mut ServiceState, i: u64, _sensor_id: &str, _grace_ms: u64) -> WireResponse {
    WireResponse::error(i, NO_DEVICE_INTEROP)
}

/// Requested bundle passes: the GPU pass set to copy plus whether the
/// derived semantic output is wanted (which needs the id pass rendered).
fn parse_bundle_passes(requested: &[String]) -> Result<(PassSet, bool, bool), String> {
    let mut want = PassSet { rgb: false, id: false, depth: false };
    let mut want_semantic = false;
    for pass in requested {
        match pass.as_str() {
            "rgb" => want.rgb = true,
            "id" => want.id = true,
            "depth" => want.depth = true,
            "semantic" => want_semantic = true,
            other => return Err(format!("unknown bundle pass {other:?}")),
        }
    }
    let want_id_output = want.id;
    want.id |= want_semantic;
    Ok((want, want_id_output, want_semantic))
}

/// Render every rig camera for one sim tick and publish an atomic frame
/// bundle (frames first, then the bundle table record, then the meta-page
/// latest-bundle pointer flip). Cameras keep rig registration order and
/// passes are canonical (rgb, id, depth, semantic) within each camera, so
/// ring layout and per-frame digests are deterministic for a deterministic
/// renderer.
#[allow(clippy::too_many_arguments)]
fn render_bundle_op(
    state: &mut ServiceState,
    i: u64,
    sim_tick: u64,
    cameras: Option<Vec<ServiceCamera>>,
    lidars: Option<Vec<ServiceLidar>>,
    radars: Option<Vec<ServiceRadar>>,
    tick_index: Option<u32>,
    passes: Option<Vec<String>>,
    device_sensors: Vec<String>,
) -> WireResponse {
    let t0 = std::time::Instant::now();
    // Default rgb-only: the policy hot loop.
    let requested = passes.unwrap_or_else(|| vec!["rgb".to_string()]);
    let (want, want_id_output, want_semantic) = match parse_bundle_passes(&requested) {
        Ok(parsed) => parsed,
        Err(error) => return WireResponse::error(i, error),
    };
    for cam in cameras.iter().flatten() {
        upsert_rig(state, cam);
    }
    for sensor in lidars.iter().flatten() {
        upsert_lidar_rig(state, sensor);
    }
    for sensor in radars.iter().flatten() {
        upsert_radar_rig(state, sensor);
    }
    if state.rig.is_empty() && state.lidars.is_empty() && state.radars.is_empty() {
        return WireResponse::error(
            i,
            "render_bundle: no sensors registered (send `cameras`, `lidars`, or `radars` once)",
        );
    }
    if let Some(index) = tick_index {
        if let Err(error) = apply_scene_tick(state, index) {
            return WireResponse::error(i, error);
        }
    }
    let rig = state.rig.clone();
    let lidar_rig = state.lidars.clone();
    let radar_rig = state.radars.clone();
    if let Err(error) = sync_rig(state, &rig) {
        return WireResponse::error(i, error);
    }
    let host_keys = capture_keys(&rig, want);
    for sensor_id in &device_sensors {
        if !rig.iter().any(|cam| cam.sensor_id == *sensor_id) {
            return WireResponse::error(i, format!("render_bundle: device sensor {sensor_id:?} is not in the rig"));
        }
    }
    let captured = match capture_bundle(state, sim_tick, &host_keys, &device_sensors) {
        Ok(captured) => captured,
        Err(error) => return WireResponse::error(i, format!("render: {error:#}")),
    };

    let start_cursor = state.shm.cursor_total();
    let mut frames: Vec<FrameRecord> = Vec::new();
    let mut entries: Vec<BundleEntry> = Vec::new();
    let published = PassSet { rgb: want.rgb, id: want_id_output, depth: want.depth };
    for cam in &rig {
        let planned = match plan_camera_passes(state, &captured, cam, published, want_semantic) {
            Ok(planned) => planned,
            Err(error) => return WireResponse::error(i, error),
        };
        for PlannedPass { pass, format_tag, format_name, data } in planned {
            if let Err(error) = publish_bundle_frame(
                state, &cam.sensor_id, pass, cam.width, cam.height, format_tag, format_name, sim_tick, &data,
                &mut entries, &mut frames,
            ) {
                return WireResponse::error(i, error);
            }
        }
    }
    if !lidar_rig.is_empty() || !radar_rig.is_empty() {
        let actor_scene = build_sensor_scene(state.app.sensor_triangles(true));
        let combined_scene = CombinedSensorScene {
            static_scene: &state.static_sensor_scene,
            actor_scene: &actor_scene,
        };
        let mut instance_velocities = HashMap::new();
        let tick_hz = state
            .current_tick
            .and_then(|index| state.scene.get(index as usize))
            .map(|frame| frame.tick_hz)
            .filter(|tick_hz| *tick_hz > 0.0)
            .unwrap_or(20.0);
        if let Some(frame) = state
            .current_tick
            .and_then(|index| state.scene.get(index as usize))
        {
            for actor in &frame.actors {
                if let Some(instance_id) = state.app.actor_instance_id(&actor.id) {
                    instance_velocities.insert(instance_id, Vec3::from_array(actor.velocity));
                }
            }
        }
        let instance_class = |instance_id| {
            state
                .app
                .actor_instance_class(instance_id)
                .map(sensors::taxonomy::SemanticClass::from_actor_class)
                .or_else(|| {
                    state
                        .legend
                        .get(&instance_id)
                        .map(|name| sensors::taxonomy::SemanticClass::from_mesh_name(name))
                })
                .unwrap_or(sensors::taxonomy::SemanticClass::Prop)
        };
        let mut sensor_payloads: Vec<(
            String,
            &'static str,
            u32,
            &'static str,
            u32,
            Vec<u8>,
        )> = Vec::with_capacity(lidar_rig.len() + radar_rig.len());
        for sensor in &lidar_rig {
            let mount = match resolve_sensor_mount(state, &sensor.attach) {
                Ok(mount) => mount,
                Err(error) => return WireResponse::error(i, error),
            };
            let config = sensors::lidar::LidarConfig {
                channels: sensor.channels,
                rotation_frequency_hz: sensor.rotation_frequency_hz,
                points_per_second: sensor.points_per_second,
                vfov_deg: sensor.vertical_fov_deg,
                hfov_deg: sensor.horizontal_fov_deg,
                range_m: sensor.range_m,
            };
            let points = sensors::lidar::scan(
                &combined_scene,
                &config,
                mount.origin,
                mount.rotation,
                &instance_class,
            );
            let count = points.len() as u32;
            sensor_payloads.push((
                sensor.sensor_id.clone(),
                "lidar",
                FORMAT_LIDAR_PLY,
                "ply-ascii",
                count,
                sensors::formats::encode_lidar_ply(&points),
            ));
        }
        for sensor in &radar_rig {
            let mount = match resolve_sensor_mount(state, &sensor.attach) {
                Ok(mount) => mount,
                Err(error) => return WireResponse::error(i, error),
            };
            let config = sensors::radar::RadarConfig::from_budget(
                Some(sensor.points_per_second),
                tick_hz,
                sensor.horizontal_fov_deg,
                sensor.vertical_fov_deg,
                sensor.range_m,
            );
            let detections = sensors::radar::scan(
                &combined_scene,
                &config,
                mount.origin,
                mount.rotation,
                mount.host_velocity,
                &|instance_id| {
                    instance_velocities
                        .get(&instance_id)
                        .copied()
                        .unwrap_or(Vec3::ZERO)
                },
            );
            let count = detections.len() as u32;
            sensor_payloads.push((
                sensor.sensor_id.clone(),
                "radar",
                FORMAT_RADAR_CSV,
                "radar-csv",
                count,
                sensors::formats::encode_radar_csv(&detections),
            ));
        }
        for (sensor_id, pass, format_tag, format_name, count, data) in sensor_payloads {
            if let Err(error) = publish_bundle_frame(
                state, &sensor_id, pass, count, 1, format_tag, format_name, sim_tick, &data, &mut entries,
                &mut frames,
            ) {
                return WireResponse::error(i, error);
            }
        }
    }
    // A bundle bigger than the ring would overwrite its own frames; refuse
    // before flipping the pointer (frames are garbage, pointer stays valid).
    if state.shm.cursor_total() - start_cursor > state.shm.usable_bytes() {
        return WireResponse::error(
            i,
            format!(
                "render_bundle: bundle ({} bytes) exceeds ring capacity ({} usable); raise --shm-size-mb",
                state.shm.cursor_total() - start_cursor,
                state.shm.usable_bytes()
            ),
        );
    }
    match state.shm.publish_bundle(sim_tick, start_cursor, &entries) {
        Ok((bundle_offset, bundle_len)) => WireResponse {
            i,
            body: ResponseBody::RenderBundle {
                ok: true,
                sim_tick,
                frame: captured.identity,
                bundle_offset,
                bundle_len,
                frames,
                device: captured.device,
                server_ms: t0.elapsed().as_secs_f64() * 1000.0,
            },
        },
        Err(error) => WireResponse::error(i, format!("publish bundle: {error}")),
    }
}

/// PNG demotion: encoding happens off the critical path after the response.
fn async_export_pngs(dir: &str, tick_id: u64, payloads: &[(String, String, u32, u32, Vec<u8>)]) {
    use render_core::engine::strip_padding;
    for (sensor_id, pass, w, h, data) in payloads {
        let raw = strip_padding(data, *w as usize, *h as usize, 4);
        let name = match pass.as_str() {
            "depth" => format!("tick-{tick_id:06}.{sensor_id}.depth.f32.bin"),
            other => format!("tick-{tick_id:06}.{sensor_id}.{other}.png"),
        };
        let path = Path::new(dir).join(name);
        let result: std::io::Result<()> = if pass == "depth" {
            std::fs::write(&path, raw)
        } else {
            match image::RgbaImage::from_raw(*w, *h, raw) {
                Some(img) => img
                    .save(&path)
                    .map_err(|e| std::io::Error::other(e.to_string())),
                None => Err(std::io::Error::other("bad rgba")),
            }
        };
        if let Err(error) = result {
            eprintln!("async export failed for {path:?}: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        actor_base_y, actor_color, capture_keys, instance_coverage, parse_bundle_passes,
        row_stride, CombinedSensorScene,
    };
    use crate::proto::ServiceCamera;
    use crate::scene::{ActorState, ActorTransform};
    use bevy::math::{Quat, Vec3};
    use sensors::bvh::{RaycastScene, Tri};
    use sensors::taxonomy::SemanticClass;

    #[test]
    fn coverage_counts_nonzero_rgb_and_ignores_alpha_and_padding() {
        let mut data = vec![0_u8; row_stride(2, 4) * 2];
        data[3] = 255; // Background alpha must not count.
        data[4] = 1;
        data[row_stride(2, 4) + 1] = 2;
        data[row_stride(2, 4) + 8] = 9; // Padding must not count.
        assert_eq!(instance_coverage(&data, 2, 2), 0.5);
    }

    #[test]
    fn semantic_requires_the_id_capture_without_publishing_it() {
        let camera = ServiceCamera {
            sensor_id: "front".into(),
            width: 64,
            height: 48,
            fov_deg: 58.0,
            eye: [0.0; 3],
            target: [1.0, 0.0, 0.0],
            semantic: false,
            depth_encoding: None,
            attach: None,
            profile: None,
        };
        let (want, id_output, semantic) =
            parse_bundle_passes(&["rgb".to_string(), "semantic".to_string()]).unwrap();
        assert!(want.id && !id_output && semantic);
        assert_eq!(
            capture_keys(std::slice::from_ref(&camera), want),
            vec!["front:rgb".to_string(), "front:id".to_string()]
        );
        let (want, id_output, _) = parse_bundle_passes(&["depth".to_string()]).unwrap();
        assert!(!want.rgb && !want.id && want.depth && !id_output);
        assert_eq!(capture_keys(std::slice::from_ref(&camera), want), vec!["front:depth".to_string()]);
        assert!(parse_bundle_passes(&["normals".to_string()]).is_err());
    }


    #[test]
    fn authored_actor_height_precedes_mesh_ground() {
        assert_eq!(actor_base_y(2.225, None, -9.7), 2.225);
        assert_eq!(actor_base_y(0.0, Some(3.5), -9.7), 3.5);
        assert_eq!(actor_base_y(0.0, None, 1.75), 1.75);
    }

    #[test]
    fn authored_actor_color_and_no_color_palette_are_deterministic() {
        let actor = |color: Option<&str>| ActorState {
            id: "vehicle-test".into(),
            kind: "spawn".into(),
            catalog_id: Some("vehicle.hatchback".into()),
            actor_class: Some("car".into()),
            color: color.map(str::to_owned),
            transform: ActorTransform {
                position: [0.0; 3],
                rotation: [0.0, 0.0, 0.0, 1.0],
            },
            dims: None,
            velocity: [0.0; 3],
        };
        let red = actor_color(&actor(Some("#8f2f2f")), "car").unwrap();
        assert_eq!(red, [143.0 / 255.0, 47.0 / 255.0, 47.0 / 255.0]);
        assert_eq!(
            actor_color(&actor(None), "car").unwrap(),
            [0.65, 0.67, 0.70]
        );
        assert!(actor_color(&actor(Some("red")), "car").is_err());
    }

    fn deterministic_sensor_run() -> Vec<(Vec<u8>, Vec<u8>)> {
        let mut static_scene = RaycastScene::new();
        for (a, b, c) in [
            (
                Vec3::new(10.0, -10.0, -10.0),
                Vec3::new(10.0, 10.0, -10.0),
                Vec3::new(10.0, 10.0, 10.0),
            ),
            (
                Vec3::new(10.0, -10.0, -10.0),
                Vec3::new(10.0, 10.0, 10.0),
                Vec3::new(10.0, -10.0, 10.0),
            ),
        ] {
            static_scene.push_tri(Tri { a, b, c, instance_id: 1 });
        }
        static_scene.build();
        let actor_scene = RaycastScene::new();
        let scene = CombinedSensorScene {
            static_scene: &static_scene,
            actor_scene: &actor_scene,
        };
        let lidar = sensors::lidar::LidarConfig {
            channels: 2,
            rotation_frequency_hz: 2.0,
            points_per_second: 256,
            vfov_deg: 10.0,
            hfov_deg: 30.0,
            range_m: 30.0,
        };
        let radar = sensors::radar::RadarConfig::from_budget(
            Some(128),
            20.0,
            30.0,
            10.0,
            30.0,
        );
        (0..3)
            .map(|tick| {
                let origin = Vec3::new(tick as f32 * 0.25, 0.0, 0.0);
                let lidar_points = sensors::lidar::scan(
                    &scene,
                    &lidar,
                    origin,
                    Quat::IDENTITY,
                    &|_| SemanticClass::Road,
                );
                let radar_detections = sensors::radar::scan(
                    &scene,
                    &radar,
                    origin,
                    Quat::IDENTITY,
                    Vec3::ZERO,
                    &|_| Vec3::ZERO,
                );
                (
                    sensors::formats::encode_lidar_ply(&lidar_points),
                    sensors::formats::encode_radar_csv(&radar_detections),
                )
            })
            .collect()
    }

    #[test]
    fn persistent_lidar_radar_payloads_are_bit_identical_across_three_tick_runs() {
        let first = deterministic_sensor_run();
        let second = deterministic_sensor_run();
        assert_eq!(first, second);
        assert_ne!(first[0], first[2], "fixture must exercise distinct ticks");
    }
}
