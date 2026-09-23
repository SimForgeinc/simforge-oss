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
    BundleEntry, ShmRing, FORMAT_DEPTH32F, FORMAT_JPEG, FORMAT_LIDAR_PLY, FORMAT_LIDAR_BINARY, FORMAT_RADAR_CSV,
    FORMAT_RGBA16F, FORMAT_RGBA8,
};
use anyhow::{Context, Result};
use bevy::math::{Quat, Vec3};
use render_core::engine::{
    CameraSpec, CapturedFrame, LegendEntry, Lighting, PassSet, SceneApp, SensorTriangle,
};
use render_core::profiles::RenderProfileConfig;
use render_core::render_config::{LidarBackend, Preset, RenderConfig, RenderRequest};
use render_core::vehicle_model::{VehicleModelCatalog, VehicleModelEntry};
use sensors::bvh::{Blas, Hit, InstancedScene, Raycast, RaycastScene, Tri};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

/// Scene description for prewarm. Unknown keys are refused: a retired
/// field (`profile`) or a misspelt one fails loudly instead of being dropped.
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SceneSpec {
    pub glbs: Vec<String>,
    /// Vegetation prototype GLBs with sibling instance sidecars.
    #[serde(default)]
    pub veg_glbs: Vec<String>,
    /// Required: an absent lighting block would render the calibration
    /// defaults (a fixed dawn), not the scene's.
    pub lighting: Lighting,
    /// Legacy look settings; superseded by `render`.
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
    /// Explicit opt-in for development/policy harnesses whose scenes use
    /// generic catalog ids: an actor without a resolvable catalog model
    /// renders as its class cuboid (logged per actor as `primitive-actor:`).
    /// Off by default and never set by the SimForge render engine: without
    /// it an unresolvable model fails the tick.
    #[serde(default)]
    pub allow_primitive_actors: bool,
    /// Meter the sky through the first RGB camera of every render when the
    /// authored lighting names no `meter_view` (the Lookdev Lab's per-frame
    /// metering: a sunward low sun stops the camera down instead of
    /// printing a white sky). Off, the incident meter alone sets exposure.
    #[serde(default = "default_true")]
    pub auto_meter: bool,
    /// `free` (default; rc.73 semantics: captures depend on how many frames
    /// were drawn) or `pinned` (a capture is a function of its scene and
    /// simulation time; see `render_core::engine::CaptureClock`).
    #[serde(default)]
    pub capture_clock: Option<String>,
    /// Jittered frames a pinned capture accumulates on TAA views (default 4).
    #[serde(default)]
    pub taa_samples: Option<u32>,
    /// THE render configuration surface: a preset plus dotted overrides
    /// (`render_core::render_config`). Mutually exclusive with the legacy
    /// look fields (`profileConfig`, `captureClock`, `taaSamples`,
    /// `sharedShadows`, `lidarBackend`), which only [`SceneSpec::render_config`]
    /// maps, in one place.
    #[serde(default)]
    pub render: Option<render_core::render_config::RenderRequest>,
    /// The texture tier the job stager actually staged `glbs[0]` with. The
    /// render config's `textures.tier` must match it (the service cannot
    /// re-stage textures, so a mismatch is an error, not a silent no-op).
    #[serde(default)]
    pub texture_tier: Option<render_core::render_config::TextureTier>,
    /// Render one directional cascade set for the whole RGB rig instead of
    /// one per camera (`render_core::shared_shadows`). Cascades are fitted
    /// to the union of the rig's frusta, so every view stays covered; the
    /// atlas grows to 4096 so texel density is at least a per-view fit's.
    /// Default on: on the Belmont 8-camera rig it halves GPU time per
    /// render (624 -> 325 ms on an RTX 3080) at 55 dB mean / 52 dB min PSNR
    /// against per-view cascades (docs/engineering/native-render-gpu-profile.md).
    #[serde(default)]
    pub shared_shadows: Option<bool>,
    /// `auto` (default: hardware rays when the device has them), `gpu`,
    /// `cpu` or `verify` (hardware rays re-checked against the CPU every
    /// scan). Every backend produces the same bytes; see [`LidarBackend`].
    #[serde(default)]
    pub lidar_backend: Option<String>,
    /// The map's geometry LOD derivative (`derived/geometry-lod/manifest.json`
    /// of the master in `glbs[0]`). Cameras and the ID pass then draw each
    /// heavy mesh at the coarsest level within one pixel of error for the
    /// rig's most demanding camera; lidar/radar keep full detail.
    #[serde(default)]
    pub geometry_lod: Option<String>,
    /// Absolute path of the map's `derived/ground/ground-mesh.bin`: the one
    /// placement height source, shared with the simulator and the contact
    /// gate. Absent only for map versions published before their ground
    /// derivative; the service then reports `legacy-mesh-field` at hello.
    #[serde(default)]
    pub ground_mesh: Option<String>,
}

impl SceneSpec {
    /// The resolved render config, and any deprecation notes. The ONLY place
    /// legacy look fields are mapped onto [`RenderConfig`]; with `render`
    /// present they are an error.
    pub fn render_config(&self) -> Result<(RenderConfig, Vec<String>)> {
        let legacy = self.profile_config != RenderProfileConfig::default()
            || self.capture_clock.is_some()
            || self.taa_samples.is_some()
            || self.shared_shadows.is_some()
            || self.lidar_backend.is_some();
        if let Some(request) = &self.render {
            anyhow::ensure!(
                !legacy,
                "[native_render_config_invalid] `render` cannot be combined with the legacy profileConfig/captureClock/taaSamples/sharedShadows/lidarBackend fields"
            );
            let config = request.resolve()?;
            self.check_texture_tier(&config)?;
            return Ok((config, Vec::new()));
        }
        if !legacy {
            return Ok((RenderRequest::default().resolve()?, Vec::new()));
        }
        Ok((legacy_render_config(self)?, vec![
            "scene spec uses the legacy look fields (profileConfig/captureClock/taaSamples/sharedShadows/lidarBackend); send `render: {preset, set}` instead".to_string(),
        ]))
    }
}

/// A [`RenderRequest`] as JSON (`{preset, set}`), for tools.
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(transparent)]
pub struct RenderRequestJson(pub RenderRequest);

/// Merge CLI `--preset` / `--set key=value` into the scene spec's `render`
/// request (the CLI, the scene spec and the protocol share one surface).
pub fn apply_render_cli(spec: &mut SceneSpec, preset: Option<String>, sets: &[String]) -> Result<()> {
    if preset.is_none() && sets.is_empty() {
        return Ok(());
    }
    let request = spec.render.get_or_insert_with(RenderRequest::default);
    if let Some(preset) = preset {
        Preset::parse(&preset)?;
        request.preset = Some(preset);
    }
    for assignment in sets {
        request.push_set(assignment)?;
    }
    Ok(())
}

impl SceneSpec {
    fn check_texture_tier(&self, config: &RenderConfig) -> Result<()> {
        use render_core::render_config::TextureTier;
        let staged = self.texture_tier.unwrap_or(TextureTier::UastcFull); // fallback-ok: a scene without a declared tier is the full-resolution master (rc.73 staging); a different requested tier fails below
        anyhow::ensure!(
            staged == config.textures.tier,
            "[native_render_config_invalid] textures.tier {:?} but the scene's master was staged as {:?}; the tier is chosen when the job stages the map",
            config.textures.tier,
            staged
        );
        Ok(())
    }
}

/// rc.73-era scene-spec look fields onto the showcase preset.
fn legacy_render_config(spec: &SceneSpec) -> Result<RenderConfig> {
    use render_core::render_config::{ClockMode, LidarBackend, SsaoQuality};
    let fx = spec.profile_config.cinematic;
    let mut config = RenderConfig::preset(Preset::Showcase);
    config.aa.mode = fx.aa;
    config.aa.taa_samples = spec.taa_samples.unwrap_or(4); // fallback-ok: the rc.73 pinned-clock default, recorded in the resolved config
    config.ssr.enabled = fx.ssr;
    config.ssao.enabled = fx.ssao;
    config.ssao.quality = if fx.ssao_ultra { SsaoQuality::Ultra } else { SsaoQuality::High };
    config.bloom.intensity = fx.bloom_intensity;
    config.dof = render_core::render_config::DofConfig {
        enabled: fx.dof_enabled,
        aperture_f_stops: fx.dof_aperture_f_stops,
        focal_distance_m: fx.dof_focal_distance_m,
    };
    config.motion_blur.shutter_angle = fx.motion_shutter_angle;
    config.motion_blur.samples = fx.motion_samples;
    config.grading = render_core::render_config::GradingConfig {
        tone_map: fx.tone_map,
        exposure: fx.grading_exposure,
        temperature: fx.grading_temperature,
        tint: fx.grading_tint,
        post_saturation: fx.grading_post_saturation,
        contrast: fx.grading_contrast,
    };
    config.lens.vignette = fx.vignette_intensity;
    config.lens.distortion = fx.lens_distortion;
    config.lens.chromatic_aberration = fx.chromatic_aberration;
    config.clock.mode = match spec.capture_clock.as_deref() {
        None | Some("free") => ClockMode::Free,
        Some("pinned") => ClockMode::Pinned,
        Some(other) => anyhow::bail!("[native_render_config_invalid] captureClock {other:?} (free | pinned)"),
    };
    config.shadows.shared = spec.shared_shadows.unwrap_or(true); // fallback-ok: rc.74 default, recorded in the resolved config
    // What rc.74 rendered: its shared 2560 atlas was rounded up to 4096 by Bevy.
    config.shadows.map_size = if config.shadows.shared { 4096 } else { 2048 };
    config.lidar.backend = match spec.lidar_backend.as_deref() {
        None | Some("auto") => LidarBackend::Auto,
        Some("gpu") => LidarBackend::Gpu,
        Some("cpu") => LidarBackend::Cpu,
        Some("verify") => LidarBackend::Verify,
        Some(other) => anyhow::bail!("[native_render_config_invalid] lidarBackend {other:?} (auto | gpu | cpu | verify)"),
    };
    config.validate()?;
    Ok(config)
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
    let (config, _) = spec.render_config()?;
    let mut phases: Vec<(String, f64)> = Vec::new();
    let mut mark = std::time::Instant::now();
    let mut phase = |name: &str, mark: &mut std::time::Instant| {
        phases.push((name.to_string(), mark.elapsed().as_secs_f64()));
        *mark = std::time::Instant::now();
    };
    let mut app =
        SceneApp::new_with_profile_config(&spec.lighting, config.profile_config())?;
    app.apply_render_config(&config)?;
    phase("device", &mut mark);
    // The constructor spawns the ladder with calibration defaults (IBL gain
    // 1.0, no EV bias); only a relight resolves the spec's `ambient_scale`,
    // `ev100_bias`, weather and night controls. A scene that never receives a
    // `set_lighting` request must still render the lighting it declared.
    app.apply_lighting(&spec.lighting, config.profile_config())?;
    phase("lighting", &mut mark);
    app.load_tiles(&spec.glbs)?;
    if let (Some(manifest), true) = (&spec.geometry_lod, config.lod.enabled) {
        let master = spec
            .glbs
            .first()
            .ok_or_else(|| anyhow::anyhow!("geometryLod needs the master glTF in glbs[0]"))?;
        app.load_geometry_lods(Path::new(manifest), master)?;
    }
    app.load_vegetation(&spec.veg_glbs)?;
    if let Some(ground_mesh) = &spec.ground_mesh {
        app.load_ground_mesh(Path::new(ground_mesh))?;
    }
    match app.ground_source() {
        render_core::engine::GroundSource::GroundMesh { sha256 } => eprintln!("ground-source: ground-mesh {sha256}"),
        render_core::engine::GroundSource::LegacyMeshField => eprintln!("ground-source: legacy-mesh-field (the scene names no groundMesh)"),
    }
    // One view compiles the look's pipelines before the first request.
    app.add_camera(CameraSpec {
        sensor_id: "__prewarm__".into(),
        width: 64,
        height: 64,
        fov_y_deg: 58.0,
        near: spec.near_m,
        far: spec.far_m,
        passes: PassSet { rgb: true, id: false, depth: false, hdr: false },
    });
    let _legend = app.wait_until_ready()?;
    phase("ready", &mut mark);
    app.warmup(spec.warmup_frames);
    phase("warmup", &mut mark);
    // Prewarm views must not consume render/readback work in every service
    // tick; real retained-rig cameras are registered on first request.
    app.clear_cameras();
    let mut record = serde_json::Map::new();
    for (name, seconds) in phases {
        record.insert(name, serde_json::json!(seconds));
    }
    for (name, value) in app.ready_phases() {
        record.insert(format!("ready.{name}"), serde_json::json!(value));
    }
    eprintln!("prewarm-phases: {}", serde_json::Value::Object(record));
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

/// The static map's ray scenes, built on first use, never at startup (an
/// RGB-only render must not pay for them).
///
/// The static layer is instanced: one tree per mesh asset and one instance
/// per mesh node (Belmont: 2.2M unique triangles, 4.9k instances, built in
/// about a second), where a flat world-space soup was 266M triangles, a
/// minute to build and ~15 GB. It is the lidar/radar reference; the
/// hardware-ray backend traces a device copy of exactly this scene and
/// returns bit-identical hits (`sensors::gpu_rays`).
pub(crate) struct MapSensorScenes {
    pub(crate) static_scene: InstancedScene,
    /// The road surface only, world-space (episode footprint checks).
    pub(crate) road: RaycastScene,
    /// Hardware-ray copy of `static_scene` for lidar, when enabled.
    pub(crate) gpu: Option<sensors::gpu_rays::GpuRayScene>,
}

/// Static map geometry as mesh trees and their placements.
pub(crate) struct StaticSensorInput {
    pub(crate) blases: Vec<Blas>,
    /// `(tree, world, instance id)` in the deterministic static order
    /// (`SceneApp::static_sensor_meshes`): the insertion order is the last
    /// tie-break between coincident instances.
    pub(crate) instances: Vec<(usize, bevy::math::Mat4, u32)>,
}

/// Build the static and road scenes from the static input.
pub(crate) fn build_map_sensor_scenes(input: &StaticSensorInput, legend: &HashMap<u32, String>) -> MapSensorScenes {
    let mut static_scene = InstancedScene::new();
    let slots: Vec<usize> = input.blases.iter().map(|blas| static_scene.add_blas(blas)).collect();
    let mut road = RaycastScene::new();
    for (blas, world, instance_id) in &input.instances {
        static_scene.add_instance(slots[*blas], *world, *instance_id);
        let is_road = legend.get(instance_id).is_some_and(|name| {
            sensors::taxonomy::SemanticClass::from_mesh_name(name) == sensors::taxonomy::SemanticClass::Road
        });
        if is_road {
            for tri in input.blases[*blas].tris() {
                road.push_tri(Tri {
                    a: world.transform_point3(tri.a),
                    b: world.transform_point3(tri.b),
                    c: world.transform_point3(tri.c),
                    instance_id: *instance_id,
                });
            }
        }
    }
    std::thread::scope(|scope| {
        scope.spawn(|| road.build());
        static_scene.build();
    });
    MapSensorScenes { static_scene, road, gpu: None }
}

/// Snapshot the static map as mesh trees: one tree per mesh asset, built in
/// parallel. A mesh the snapshot cannot read fails, naming it.
pub(crate) fn static_sensor_input(app: &mut SceneApp) -> Result<StaticSensorInput, String> {
    let meshes = app.static_sensor_meshes().map_err(|error| format!("static sensor geometry: {error:#}"))?;
    let mut slot_of: HashMap<bevy::asset::AssetId<bevy::prelude::Mesh>, usize> = HashMap::new();
    let mut triangles: Vec<Vec<[Vec3; 3]>> = Vec::new();
    let mut instances = Vec::with_capacity(meshes.len());
    for mesh in &meshes {
        let slot = match slot_of.get(&mesh.mesh.id()) {
            Some(slot) => *slot,
            None => {
                let tris = app
                    .mesh_asset_triangles(&mesh.mesh, &mesh.label)
                    .map_err(|error| format!("static sensor geometry: {error:#}"))?;
                triangles.push(tris);
                slot_of.insert(mesh.mesh.id(), triangles.len() - 1);
                triangles.len() - 1
            }
        };
        instances.push((slot, mesh.world, mesh.instance_id));
    }
    // Largest meshes first so the parallel build finishes evenly.
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get()).min(16); // fallback-ok: thread count only, not output
    let mut order: Vec<usize> = (0..triangles.len()).collect();
    order.sort_by_key(|&i| std::cmp::Reverse(triangles[i].len()));
    let next = std::sync::atomic::AtomicUsize::new(0);
    let built: Vec<std::sync::Mutex<Option<Blas>>> = (0..triangles.len()).map(|_| std::sync::Mutex::new(None)).collect();
    std::thread::scope(|scope| {
        for _ in 0..threads {
            scope.spawn(|| loop {
                let k = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let Some(&index) = order.get(k) else { break };
                let blas = Blas::build(triangles[index].iter().copied().map(to_tri));
                *built[index].lock().expect("static tree slot") = Some(blas);
            });
        }
    });
    let blases = built
        .into_iter()
        .map(|slot| slot.into_inner().expect("static tree slot").expect("every static tree built"))
        .collect();
    Ok(StaticSensorInput { blases, instances })
}

struct CombinedSensorScene<'a> {
    static_scene: &'a InstancedScene,
    actor_scene: &'a dyn Raycast,
}

/// Per-job cache of actor mesh trees, keyed by mesh asset. The strong handle
/// keeps the asset (and therefore its id) alive for the cache's lifetime, so
/// an id can never be reused for different geometry.
#[derive(Default)]
pub(crate) struct ActorBlasCache {
    by_mesh: HashMap<bevy::asset::AssetId<bevy::prelude::Mesh>, (bevy::prelude::Handle<bevy::prelude::Mesh>, Blas)>,
    /// Trees built (cache misses) over the cache's lifetime (diagnostics/tests).
    pub(crate) builds: usize,
}

fn to_tri(triangle: [Vec3; 3]) -> Tri {
    // The mesh tree's own ids are never reported: hits carry the instance's.
    Tri { a: triangle[0], b: triangle[1], c: triangle[2], instance_id: 0 }
}

/// One actor mesh of a tick, owned so the scans can run off the main thread.
#[derive(Clone)]
pub(crate) enum ActorSensorInstance {
    /// A rigid mesh: the job-cached tree of its asset at this tick's pose.
    Shared { blas: Blas, world: bevy::math::Mat4, instance_id: u32 },
    /// A skinned mesh posed this tick (world space; tree built with the scan).
    Posed { triangles: Vec<[Vec3; 3]>, instance_id: u32 },
}

/// Snapshot the tick's actor meshes: exactly what the cameras draw (see
/// `SceneApp::actor_sensor_meshes`). Rigid meshes resolve to a tree built
/// once per job per mesh asset; nothing per tick touches their triangles.
pub(crate) fn snapshot_actor_sensor_instances(
    app: &mut SceneApp,
    cache: &mut ActorBlasCache,
) -> Result<Vec<ActorSensorInstance>, String> {
    let meshes = app
        .actor_sensor_meshes()
        .map_err(|error| format!("actor sensor geometry: {error:#}"))?;
    let mut out = Vec::with_capacity(meshes.len());
    for mesh in meshes {
        match mesh.geometry {
            render_core::engine::ActorSensorGeometry::Rigid { mesh: handle, world } => {
                let id = handle.id();
                if !cache.by_mesh.contains_key(&id) {
                    let triangles = app
                        .mesh_asset_triangles(&handle, &mesh.label)
                        .map_err(|error| format!("actor sensor geometry: {error:#}"))?;
                    cache.by_mesh.insert(id, (handle.clone(), Blas::build(triangles.into_iter().map(to_tri))));
                    cache.builds += 1;
                }
                out.push(ActorSensorInstance::Shared { blas: cache.by_mesh[&id].1.clone(), world, instance_id: mesh.instance_id });
            }
            render_core::engine::ActorSensorGeometry::Skinned { triangles, .. } => {
                out.push(ActorSensorInstance::Posed { triangles, instance_id: mesh.instance_id });
            }
        }
    }
    Ok(out)
}

/// The tick's two-level actor scene: shared mesh trees referenced by
/// instance (only the instance tree is built here) plus posed skins.
pub(crate) fn build_actor_sensor_scene(instances: &[ActorSensorInstance]) -> InstancedScene {
    let mut scene = InstancedScene::new();
    let mut slots: Vec<(Blas, usize)> = Vec::new();
    for instance in instances {
        match instance {
            ActorSensorInstance::Shared { blas, world, instance_id } => {
                let slot = match slots.iter().find(|(known, _)| known.ptr_eq(blas)) {
                    Some((_, slot)) => *slot,
                    None => {
                        let slot = scene.add_blas(blas);
                        slots.push((blas.clone(), slot));
                        slot
                    }
                };
                scene.add_instance(slot, *world, *instance_id);
            }
            ActorSensorInstance::Posed { triangles, instance_id } => {
                let slot = scene.add_blas(&Blas::build(triangles.iter().copied().map(to_tri)));
                scene.add_instance(slot, bevy::math::Mat4::IDENTITY, *instance_id);
            }
        }
    }
    scene.build();
    scene
}

impl Raycast for CombinedSensorScene<'_> {
    /// Nearest hit; an equal-distance actor hit keeps the static one. The
    /// actor layer is searched only up to the static hit: it can only win
    /// strictly nearer, so the result is the same as searching both to
    /// `max_distance`, without walking actors behind a wall.
    fn cast(&self, origin: Vec3, direction: Vec3, max_distance: f32) -> Option<Hit> {
        let static_hit = self.static_scene.cast(origin, direction, max_distance);
        let reach = static_hit.map_or(max_distance, |hit| hit.distance);
        match self.actor_scene.cast(origin, direction, reach) {
            Some(actor_hit) if static_hit.is_none_or(|hit| actor_hit.distance < hit.distance) => Some(actor_hit),
            _ => static_hit,
        }
    }
}

/// Everything the dispatch loop owns. Bevy's App is not Send, so the whole
/// state stays on one thread by design.
pub struct ServiceState {
    pub app: SceneApp,
    pub shm_path: String,
    pub shm: ShmRing,
    pub near_m: f32,
    pub far_m: f32,
    /// Cinematic settings currently in force; `set_lighting` updates it so
    /// a lighting-only change keeps the look the scene was prewarmed with.
    pub profile_config: render_core::profiles::RenderProfileConfig,
    /// Static instance legend (id -> mesh name), frozen at readiness.
    pub(crate) legend: HashMap<u32, String>,
    /// Loaded scene-state stream (V2 `load_scene_state`).
    scene: Vec<SceneState>,
    /// Index of the most recently applied scene frame.
    current_tick: Option<u32>,
    /// Body extents each scene actor was spawned with (scene-yup `[x, y, z]`),
    /// so observations can recover the ground-contact origin.
    actor_extents: HashMap<String, [f32; 3]>,
    episode: Option<crate::episode::Episode>,
    /// Pass payloads from the last render (V2 `encode_jpeg` source).
    cache: HashMap<String, CachedPass>,
    /// Retained camera rig in registration order.
    rig: Vec<ServiceCamera>,
    /// Retained CPU sensor rigs in registration order.
    lidars: Vec<ServiceLidar>,
    radars: Vec<ServiceRadar>,
    /// Static map BVHs, built on first lidar/radar render or episode and
    /// reused for every later tick (see [`MapSensorScenes`]).
    sensor_scenes: Option<std::sync::Arc<MapSensorScenes>>,
    /// Actor mesh trees built once per mesh asset for this job.
    actor_blas: ActorBlasCache,
    /// Identity each live actor spawned with (see [`SpawnedActor`]).
    spawned_actors: HashMap<String, SpawnedActor>,
    /// The (GLB, clip) each actor's attached model was bound with.
    actor_model_bindings: HashMap<String, (PathBuf, Option<String>)>,
    /// [`SceneSpec::allow_primitive_actors`].
    allow_primitive_actors: bool,
    /// Static legend id -> sensor class, built with the sensor scenes.
    static_sensor_classes: Option<std::sync::Arc<HashMap<u32, sensors::taxonomy::SemanticClass>>>,
    /// Something that can queue new pipelines or materials (a camera, a
    /// spawned actor or model, a relight) changed since the last readiness
    /// wait. Under a pinned capture clock readiness runs only then; the
    /// capture itself still verifies the GPU was idle and retries if not.
    needs_settle: bool,
    /// Run a tick's lidar/radar scans while the GPU renders it (on by
    /// default; outputs are verified bit-identical to the serial path).
    pub overlap_sensors: bool,
    /// Lidar tracing engine (`RenderConfig.lidar.backend`).
    pub lidar_backend: LidarBackend,
    /// The resolved render configuration (recorded by callers' manifests).
    pub render_config: RenderConfig,
    /// Deprecation notes from resolving the scene spec's render fields.
    pub render_deprecations: Vec<String>,
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

/// What [`ServiceState::ensure_sensor_scenes_outcome`] did.
pub struct SensorScenesOutcome {    /// Already built before this call.
    pub loaded: bool,
    /// Logical (instanced) static triangles.
    pub triangles: usize,
    /// Unique static triangles (the trees' storage).
    pub unique_triangles: usize,
    /// The hardware-ray backend is on.
    pub gpu: bool,
}


impl ServiceState {
    /// Build the map's sensor scenes if nothing has needed them yet. Logs
    /// progress: on a large map this runs for minutes inside one request.
    fn ensure_sensor_scenes(&mut self) -> Result<(), String> {
        if self.sensor_scenes.is_none() {
            self.ensure_sensor_scenes_outcome()?;
        }
        Ok(())
    }

    /// [`Self::ensure_sensor_scenes`], reporting what was built.
    /// A static mesh the snapshot cannot read fails the request, and so
    /// does a requested hardware backend the device cannot run.
    pub fn ensure_sensor_scenes_outcome(&mut self) -> Result<SensorScenesOutcome, String> {
        if let Some(scenes) = &self.sensor_scenes {
            return Ok(SensorScenesOutcome {
                loaded: true,
                triangles: scenes.static_scene.tri_count(),
                unique_triangles: scenes.static_scene.unique_tri_count(),
                gpu: scenes.gpu.is_some(),
            });
        }
        let started = std::time::Instant::now();
        let input = static_sensor_input(&mut self.app)?;
        let snapshot_s = started.elapsed().as_secs_f64();
        let mut scenes = build_map_sensor_scenes(&input, &self.legend);
        drop(input);
        let built_s = started.elapsed().as_secs_f64();
        let use_gpu = match self.lidar_backend {
            LidarBackend::Cpu => false,
            LidarBackend::Gpu | LidarBackend::Verify => true,
            LidarBackend::Auto => self.gpu_ray_device().is_some_and(|(device, _)| sensors::gpu_rays::supported(&device)),
        };
        if use_gpu {
            let (device, queue) = self
                .gpu_ray_device()
                .ok_or_else(|| "[native_lidar_gpu_unavailable] no render device for hardware rays".to_string())?;
            if !sensors::gpu_rays::supported(&device) {
                return Err("[native_lidar_gpu_unavailable] lidarBackend requires hardware ray queries this device lacks".into());
            }
            let gpu = sensors::gpu_rays::GpuRayScene::new(&scenes.static_scene, device, queue)
                .map_err(|error| format!("[native_lidar_gpu_build] {error:#}"))?;
            scenes.gpu = Some(gpu);
        }
        eprintln!(
            "sensor-scenes: static {} instances / {} unique of {} logical triangles; snapshot {snapshot_s:.1} s, trees {:.1} s, hardware rays {} ({:.1} s)",
            scenes.static_scene.instance_count(),
            scenes.static_scene.unique_tri_count(),
            scenes.static_scene.tri_count(),
            built_s - snapshot_s,
            match &scenes.gpu {
                Some(gpu) => format!("on, {} sliver envelopes", gpu.envelope_triangles),
                None => "off".to_string(),
            },
            started.elapsed().as_secs_f64() - built_s,
        );
        let outcome = SensorScenesOutcome {
            loaded: false,
            triangles: scenes.static_scene.tri_count(),
            unique_triangles: scenes.static_scene.unique_tri_count(),
            gpu: scenes.gpu.is_some(),
        };
        self.sensor_scenes = Some(std::sync::Arc::new(scenes));
        Ok(outcome)
    }

    /// The render device and queue, for the hardware-ray backend.
    fn gpu_ray_device(&mut self) -> Option<(wgpu::Device, wgpu::Queue)> {
        let world = self.app.world_mut();
        let device = world.get_resource::<bevy::render::renderer::RenderDevice>()?.wgpu_device().clone();
        let queue: wgpu::Queue = (****world.get_resource::<bevy::render::renderer::RenderQueue>()?).clone();
        Some((device, queue))
    }

    /// Classes of the frozen static legend, resolved once: the legend never
    /// changes after readiness and dynamic actors take ids beyond it.
    /// Whether RGB cameras carry the dash-cam camera model (its per-frame
    /// metering replaces the service's scene-wide auto meter).
    pub(crate) fn camera_model_on(&self) -> bool {
        self.render_config.grading.tone_map == render_core::profiles::ToneMap::DashcamWdr
    }

    fn static_sensor_classes(&mut self) -> std::sync::Arc<HashMap<u32, sensors::taxonomy::SemanticClass>> {
        if let Some(classes) = &self.static_sensor_classes {
            return classes.clone();
        }
        let classes: HashMap<u32, sensors::taxonomy::SemanticClass> = self
            .legend
            .iter()
            .map(|(instance_id, name)| {
                // Static ids never collide with actor ids (actors take ids
                // above the frozen legend); a static mesh's class is its
                // name's taxonomy class (TAXONOMY.md: unmatched names are
                // the prop class by definition).
                (*instance_id, sensors::taxonomy::SemanticClass::from_mesh_name(name))
            })
            .collect();
        let classes = std::sync::Arc::new(classes);
        self.static_sensor_classes = Some(classes.clone());
        classes
    }

    /// Switch a running service to another resolved render config (sweeps,
    /// closed-loop reconfiguration). The next capture settles first.
    pub fn reconfigure(&mut self, config: &RenderConfig) -> Result<(), String> {
        self.app.reconfigure(config).map_err(|error| format!("{error:#}"))?;
        self.profile_config = config.profile_config();
        self.lidar_backend = config.lidar.backend;
        self.render_config = *config;
        self.needs_settle = true;
        Ok(())
    }

    /// Whether the map sensor scenes exist (tests, diagnostics).
    pub fn sensor_scenes_built(&self) -> bool {
        self.sensor_scenes.is_some()
    }
}

impl ServiceState {
    pub fn new(
        app: SceneApp,
        spec: &SceneSpec,
        shm_path: String,
        shm: ShmRing,
    ) -> Result<Self> {
        let (render_config, render_deprecations) = spec.render_config()?;
        for note in &render_deprecations {
            eprintln!("deprecated: {note}");
        }
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
        Ok(Self {
            app,
            shm_path,
            shm,
            near_m: spec.near_m,
            far_m: spec.far_m,
            profile_config: render_config.profile_config(),
            render_config,
            render_deprecations,
            legend,
            scene: Vec::new(),
            current_tick: None,
            actor_extents: HashMap::new(),
            episode: None,
            cache: HashMap::new(),
            rig: Vec::new(),
            lidars: Vec::new(),
            radars: Vec::new(),
            sensor_scenes: None,
            actor_blas: ActorBlasCache::default(),
            spawned_actors: HashMap::new(),
            actor_model_bindings: HashMap::new(),
            allow_primitive_actors: spec.allow_primitive_actors,
            static_sensor_classes: None,
            needs_settle: true,
            lidar_backend: render_config.lidar.backend,
            overlap_sensors: std::env::var("SIMFORGE_NATIVE_SERIAL_SENSORS").map_or(true, |value| value.is_empty() || value == "0"),
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
fn auto_meter(state: &mut ServiceState, cam: &ServiceCamera, eye: &[f32; 3], target: &[f32; 3]) -> Result<(), String> {
    // With the camera model on auto, every frame meters itself; the scene's
    // incident exposure stays the base (and nothing depends on the heading a
    // previous request metered).
    let camera_meters = state.camera_model_on()
        && state.render_config.camera.exposure.mode == render_core::render_config::ExposureMode::Auto;
    if !state.auto_meter
        || camera_meters
        || !state.lighting_authored.atmosphere
        || state.lighting_authored.meter_view.is_some()
    {
        return Ok(());
    }
    let forward = [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]];
    let len = (forward[0] * forward[0] + forward[1] * forward[1] + forward[2] * forward[2]).sqrt();
    if len <= 1.0e-6 {
        return Err(format!("[native_camera_config_invalid] camera {} eye and target coincide", cam.sensor_id));
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
            return Ok(());
        }
    }
    let mut lighting = state.lighting_authored.clone();
    lighting.meter_view = Some(view);
    // A failed re-meter would leave this view at another heading's
    // exposure: the tick fails instead.
    state
        .app
        .advance_lighting(&lighting, state.profile_config)
        .map_err(|error| format!("[native_auto_meter_failed] camera {}: {error:#}", cam.sensor_id))?;
    state.auto_meter_view = Some(view);
    state.cache.clear();
    Ok(())
}

/// Readiness record written to `--ready-file` once the endpoint is bound:
/// everything a host needs to connect and map the ring without probing
/// the endpoint itself (a stat/connect poll is not portable to named
/// pipes). Written atomically (temp file + rename).
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadyRecord<'a> {
    pub protocol: u32,
    pub pid: u32,
    /// The `--socket` value as given: a Unix socket path or a Windows
    /// named-pipe endpoint (see [`crate::endpoint`]).
    pub endpoint: &'a str,
    pub shm: ShmInfo,
    /// The resolved render configuration this service renders with.
    pub render_config: &'a RenderConfig,
    /// Deprecation notes (legacy scene-spec fields that were mapped).
    pub deprecations: &'a [String],
    /// Static meshes no semantic rule classifies (their semantic pixels are
    /// unlabeled), so a consumer sees the gap instead of a guess.
    pub unlabeled_statics: UnlabeledStatics,
}

/// Static legend entries whose mesh name no [`sensors::taxonomy::StaticKind`]
/// rule matches: the semantic pass writes them as unlabeled.
#[derive(Clone, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnlabeledStatics {
    pub instances: usize,
    /// Up to 16 distinct names, most frequent first (trailing digits and
    /// underscores stripped), then by name.
    pub names: Vec<(String, usize)>,
}

impl UnlabeledStatics {
    pub fn of(legend: &HashMap<u32, String>) -> Self {
        let mut counts: std::collections::BTreeMap<String, usize> = std::collections::BTreeMap::new();
        let mut instances = 0;
        for name in legend.values() {
            if sensors::taxonomy::StaticKind::of(name) == sensors::taxonomy::StaticKind::Unknown {
                instances += 1;
                let base = name.trim_end_matches(|c: char| c.is_ascii_digit() || c == '_' || c == '.').to_string();
                *counts.entry(base).or_default() += 1;
            }
        }
        let mut names: Vec<(String, usize)> = counts.into_iter().collect();
        names.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        names.truncate(16);
        Self { instances, names }
    }
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
        "simforge-render serve listening on {}",
        crate::endpoint::describe(listener.endpoint()),
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
                render_config: &state.render_config,
                deprecations: &state.render_deprecations,
                unlabeled_statics: UnlabeledStatics::of(&state.legend),
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
    let mut queue: std::collections::VecDeque<WireRequest> = std::collections::VecDeque::new();
    // A bundle whose capture is on the GPU (pipelined clients only).
    let mut in_flight: Option<BundleInFlight> = None;
    let mut eof = false;
    let write = |connection: &mut crate::endpoint::Connection, response: &WireResponse| -> Result<()> {
        connection.write_all(&encode_frame(response)?)?;
        Ok(())
    };
    loop {
        if queue.is_empty() && !eof {
            // With a capture on the GPU, take only what the client already
            // sent; otherwise block for the next request.
            let read = if in_flight.is_some() { read_ready(&mut connection, &mut buf)? } else { Some(connection.read(&mut buf)?) };
            match read {
                Some(0) => eof = true,
                Some(n) => {
                    for payload in reader.push(&buf[..n]).map_err(anyhow::Error::msg)? {
                        queue.push_back(decode_request(&payload).map_err(anyhow::Error::msg)?);
                    }
                }
                None => {}
            }
        }
        let next = queue.pop_front();
        let chain = next.as_ref().is_some_and(|request| pipelined_bundle(state, request));
        if let Some(flight) = in_flight.take() {
            if chain {
                // Submit the next capture before collecting this one: its CPU
                // frame build overlaps this frame's GPU work. Responses keep
                // request order.
                let begun = begin_bundle(state, bundle_request(next.expect("chained request")));
                write(&mut connection, &finish_bundle(state, flight))?;
                match begun {
                    Ok(flight) => in_flight = Some(flight),
                    Err(response) => write(&mut connection, &response)?,
                }
                continue;
            }
            write(&mut connection, &finish_bundle(state, flight))?;
        }
        let Some(request) = next else {
            if eof {
                return Ok(CloseConnection::Eof);
            }
            continue;
        };
        if chain {
            match begin_bundle(state, bundle_request(request)) {
                Ok(flight) => in_flight = Some(flight),
                Err(response) => write(&mut connection, &response)?,
            }
            continue;
        }
        let response = dispatch(state, request);
        write(&mut connection, &response)?;
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

/// Bytes the client has already sent, without blocking (`None`: nothing yet;
/// `Some(0)`: end of stream). Named-pipe hosts never pipeline.
fn read_ready(connection: &mut crate::endpoint::Connection, buf: &mut [u8]) -> Result<Option<usize>> {
    #[cfg(unix)]
    {
        let stream = connection.unix_stream();
        stream.set_nonblocking(true)?;
        let read = connection.read(buf);
        connection.unix_stream().set_nonblocking(false)?;
        match read {
            Ok(n) => Ok(Some(n)),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => Ok(None),
            Err(error) => Err(error.into()),
        }
    }
    #[cfg(not(unix))]
    {
        let _ = (connection, buf); // fallback-ok: unused on this platform
        Ok(None)
    }
}

/// A `render_bundle` the service may begin while the previous one is still
/// on the GPU: the client asked for it, it needs no device outputs and no
/// semantic pass (derived from the live actor legend at publication), and
/// no policy episode owns the scene.
fn pipelined_bundle(state: &ServiceState, request: &WireRequest) -> bool {
    match &request.body {
        RequestBody::RenderBundle { pipeline, device_sensors, passes, .. } => {
            pipeline.unwrap_or(false) // fallback-ok: documented optional request flag
                && device_sensors.as_ref().is_none_or(Vec::is_empty)
                && passes.as_ref().is_none_or(|passes| !passes.iter().any(|pass| pass == "semantic"))
                && state.episode.is_none()
        }
        _ => false,
    }
}

fn bundle_request(request: WireRequest) -> BundleRequest {
    let i = request.i;
    match request.body {
        RequestBody::RenderBundle { sim_tick, cameras, lidars, radars, tick_index, passes, device_sensors, sim_time_s, observe, .. } => BundleRequest {
            i, sim_tick, cameras, lidars, radars, tick_index, passes,
            device_sensors: device_sensors.unwrap_or_default(), sim_time_s, observe: observe.unwrap_or(false), // fallback-ok: documented optional request fields (none requested)
        },
        _ => unreachable!("bundle_request on a non-bundle request"),
    }
}

/// Serve one decoded request against the resident scene. Shared by the
/// socket loop and the in-process FFI host; after an `export_device_stream`
/// acknowledgement the caller must drain [`ServiceState::take_export`].
pub fn dispatch(state: &mut ServiceState, request: WireRequest) -> WireResponse {
    let i = request.i;
    if state.episode.as_ref().is_some_and(|episode|episode.termination.is_none())
        && matches!(&request.body,RequestBody::Render {..}|RequestBody::RenderBundle {..}
            |RequestBody::Load {..}|RequestBody::LoadSceneState {..}|RequestBody::SetLighting {..}) {
        return WireResponse::error(i,"an active episode owns scene and rig state; step/reset it, or reset_cameras to leave episode mode");
    }
    match request.body {
        RequestBody::DescribeProducts {profile} => WireResponse {i,body:ResponseBody::DescribeProducts {ok:true,consumer:profile.consumer()}},
        RequestBody::ResetEpisode { scenario, ego_id, mut cameras, lidars, limits, consumer } => {
            let mut episode = match crate::episode::Episode::reset(scenario, ego_id, limits) {
                Ok(episode) => episode,
                Err(error) => return WireResponse::error(i, error),
            };
            if let Some(consumer)=consumer {
                if let Err(error)=episode.configure_consumer(consumer) {return WireResponse::error(i,error);}
            }
            if episode.consumer.video() || episode.consumer.labels {
                return WireResponse::error(i,"policy episodes require image products without labels; labelled and video captures use `simforge-render job`");
            }
            if episode.consumer.depth.is_some_and(|depth| !matches!(depth,render_core::products::DepthProduct::MetricAxial {..})) {
                return WireResponse::error(i,"policy depth requires metric_axial; raw reverse-Z is available through render_bundle");
            }
            if episode.consumer.occupancy && lidars.is_empty() {
                return WireResponse::error(i,"declared occupancy requires at least one lidar");
            }
            for camera in &mut cameras {
                // The consumer product defines the policy image; a camera that
                // asks for something else is refused, not silently rewritten.
                if (camera.width,camera.height)!=(episode.consumer.width,episode.consumer.height)
                    || camera.semantic
                    || camera.depth_encoding.is_some()
                {
                    return WireResponse::error(i,format!(
                        "[native_episode_camera_conflict] camera {} asks for {}x{} semantic={} depth={:?}; policy episodes render {}x{} rgb (depth via the consumer spec)",
                        camera.sensor_id,camera.width,camera.height,camera.semantic,camera.depth_encoding,
                        episode.consumer.width,episode.consumer.height));
                }
                if camera.attach.as_ref().is_some_and(|mount| mount.roll_deg!=0.0) {
                    return WireResponse::error(i,"SceneApp eye/target cameras do not support calibrated roll");
                }
            }
            let history_indices=match episode.warm_start() {
                Ok(indices)=>indices,Err(error)=>return WireResponse::error(i,error),
            };
            if let Err(error)=state.ensure_sensor_scenes() {return WireResponse::error(i,error);}
            episode.evaluate(&|pose| on_road(&state.sensor_scenes.as_ref().expect("sensor scenes built").road,pose));
            forget_all_actors(state);
            state.scene.clear();
            state.app.clear_cameras();
            state.cache.clear();
            state.rig = cameras;
            state.lidars.clear();
            state.radars.clear();
            state.episode=None;
            state.current_tick = None;
            let start_cursor=state.shm.cursor_total();
            let mut history=Vec::new();
            for &index in history_indices.iter().take(history_indices.len()-1) {
                let frame=episode.authored[index].clone();
                let tick=frame.tick;
                let time_seconds=tick as f64/frame.tick_hz as f64;
                replace_episode_frame(state,frame);
                let response=render_bundle_op(state,i,tick as u64,None,None,None,Some(0),Some(vec!["rgb".into()]),Vec::new(),Some(time_seconds));
                match response.body {
                    ResponseBody::RenderBundle {frame,frames,..}=>history.push(crate::proto::EpisodeImageHistory {time_seconds,frame,frames}),
                    body=>return WireResponse {i,body},
                }
            }
            state.lidars=if episode.consumer.lidar.is_some() {lidars} else {Vec::new()};
            replace_episode_frame(state,episode.authored[episode.index].clone());
            state.episode = Some(episode);
            let mut response=render_episode(state, i);
            if state.shm.cursor_total()-start_cursor>state.shm.usable_bytes() {
                state.episode=None;
                return WireResponse::error(i,"reset history exceeds shared-memory capacity; enlarge --shm-size-mb");
            }
            if let ResponseBody::Episode {history:rows,..}=&mut response.body {*rows=history;}
            response
        }
        RequestBody::StepEpisode { action } => {
            if state.episode.is_some() {
                if let Err(error) = state.ensure_sensor_scenes() {
                    return WireResponse::error(i, error);
                }
            }
            let Some(episode) = state.episode.as_mut() else {
                return WireResponse::error(i, "reset_episode is required before step_episode");
            };
            match episode.advance(action, |pose| on_road(&state.sensor_scenes.as_ref().expect("sensor scenes built").road,pose)) {
                Ok(frame) => replace_episode_frame(state,frame),
                Err(error) => return WireResponse::error(i, error),
            }
            render_episode(state, i)
        }
        RequestBody::Hello => {
            let (size_bytes, meta_bytes, _) = state.shm.path_size_meta();
            WireResponse {
                i,
                body: ResponseBody::Hello {
                    ok: true,
                    protocol: NATIVE_SERVICE_PROTOCOL_VERSION,
                    legend_entries: state.legend.len(),
                    shm: ShmInfo {
                        path: state.shm_path.clone(),
                        size_bytes,
                        meta_bytes,
                    },
                    capabilities: crate::proto::NATIVE_SERVICE_CAPABILITIES
                        .iter()
                        .map(|c| (*c).to_owned())
                        .collect(),
                    render_config: state.render_config,
                    deprecations: state.render_deprecations.clone(),
                    ground: state.app.ground_source().into(),
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
            let Some(first) = states.first() else {
                return WireResponse::error(i, "[native_scene_state_empty] load_scene_state carries no frames");
            };
            let map_id = first.map_id.clone();
            for (index, frame) in states.iter().enumerate() {
                if let Err(error) = frame.validate() {
                    return WireResponse::error(i, format!("scene frame {index}: {error}"));
                }
                if frame.map_id != map_id {
                    return WireResponse::error(i, format!(
                        "[native_scene_map_mismatch] scene frame {index} is on map {:?}, frame 0 on {map_id:?}", frame.map_id
                    ));
                }
            }
            let ticks = states.len();
            // A new stream is a new world: nothing from a previous one stays.
            forget_all_actors(state);
            state.scene = states;
            state.episode=None;
            state.current_tick = None;
            WireResponse { i, body: ResponseBody::LoadSceneState { ok: true, ticks, map_id } }
        }
        RequestBody::ObserveActors => {
            WireResponse { i, body: ResponseBody::ObserveActors { ok: true, tick: state.current_tick, actors: observe_actors(state) } }
        }
        RequestBody::ResetCameras => {
            state.episode=None;
            state.app.clear_cameras();
            state.cache.clear();
            state.rig.clear();
            state.lidars.clear();
            state.radars.clear();
            WireResponse { i, body: ResponseBody::ResetCameras { ok: true } }
        }
        RequestBody::SetLighting { lighting, profile_config, advance } => {
            let started = std::time::Instant::now();
            let profile_config = profile_config.unwrap_or(state.profile_config); // fallback-ok: documented: a relight without settings keeps the ones in force
            let outcome = if advance {
                state.app.advance_lighting(&lighting, profile_config)
            } else {
                state.app.apply_lighting(&lighting, profile_config).map(|r| (r, false))
            };
            match outcome {
                Ok((resolved, full_relight)) => {
                    state.needs_settle = true;
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
            sim_time_s,
            observe,
            pipeline: _,
        } => {
            let request = BundleRequest {
                i, sim_tick, cameras, lidars, radars, tick_index, passes,
                device_sensors: device_sensors.unwrap_or_default(), sim_time_s, observe: observe.unwrap_or(false), // fallback-ok: documented optional request fields (none requested)
            };
            match begin_bundle(state, request) {
                Ok(flight) => finish_bundle(state, flight),
                Err(response) => response,
            }
        }
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

/// Every scene actor as the renderer drew it on the last applied tick.
fn observe_actors(state: &ServiceState) -> Vec<crate::proto::ObservedActorPose> {
    let mut actors = Vec::new();
    let mut ids: Vec<String> = state.actor_extents.keys().cloned().collect();
    ids.sort();
    for id in ids {
        let Some((centre, rotation)) = state.app.actor_world_pose(&id) else {
            continue;
        };
        let half = state.actor_extents[&id][1] * 0.5;
        let origin = centre - rotation * Vec3::new(0.0, half, 0.0);
        let model = state.app.actor_model_world_pose(&id);
        actors.push(crate::proto::ObservedActorPose {
            id,
            position: origin.to_array(),
            rotation: rotation.to_array(),
            body_centre: centre.to_array(),
            model_position: model.map(|(p, _)| p.to_array()),
            model_rotation: model.map(|(_, r)| r.to_array()),
            visible: true,
        });
    }
    actors
}

/// Remove an actor and everything the service tracks about it.
fn forget_actor(state: &mut ServiceState, id: &str) {
    state.app.remove_actor(id);
    state.actor_extents.remove(id);
    state.spawned_actors.remove(id);
    state.actor_model_bindings.remove(id);
}

fn forget_all_actors(state: &mut ServiceState) {
    for id in state.app.actor_ids() {
        forget_actor(state, &id);
    }
}

/// Compiled frames are complete snapshots. A despawn between sampled image
/// times must not leave an invisible-to-metrics actor in RGB or lidar.
fn replace_episode_frame(state:&mut ServiceState, frame:SceneState) {
    {
        let live:std::collections::HashSet<&str>=frame.actors.iter()
            .filter(|actor|actor.kind!="despawn").map(|actor|actor.id.as_str()).collect();
        let stale:Vec<String>=state.app.actor_ids().into_iter().filter(|id|!live.contains(id.as_str())).collect();
        for id in stale {forget_actor(state,&id);}
    }
    state.scene.clear();
    state.scene.push(frame);
    state.current_tick=None;
}

fn on_road(roads: &RaycastScene, footprint: crate::traffic::Footprint) -> bool {
    footprint.corners().iter().all(|p| roads.cast(Vec3::new(p[0] as f32,10000.0,p[1] as f32),Vec3::NEG_Y,20000.0).is_some())
}

fn render_episode(state: &mut ServiceState, i: u64) -> WireResponse {
    let tick = state.scene[0].tick;
    let consumer=state.episode.as_ref().unwrap().consumer.clone();
    let mut passes=vec!["rgb".into()];
    if consumer.depth.is_some() {passes.push("depth".into());}
    let tick_hz = state.scene[0].tick_hz;
    let response = render_bundle_op(state, i, tick as u64, None, None, None,
        Some(0), Some(passes), Vec::new(), (tick_hz > 0.0).then(|| f64::from(tick) / f64::from(tick_hz)));
    match response.body {
        ResponseBody::RenderBundle { frame, frames, bundle_offset, bundle_len, server_ms, sensor_to_policy, .. } => {
            WireResponse { i, body: ResponseBody::Episode {
                ok: true, observation: state.episode.as_ref().unwrap().observe(&state.scene[0]),
                frame, frames, bundle_offset, bundle_len, server_ms, consumer, near_m:state.near_m, sensor_to_policy, history:Vec::new(),
            } }
        }
        body => {state.episode=None; WireResponse { i, body }},
    }
}

/// The catalog model an actor must render with. Every failure names the
/// actor and what is missing: the service never keeps a proxy in its place
/// (docs/engineering/no-silent-fallbacks.md). `Ok(None)` only for body-centred
/// catalog entries, whose catalog definition is the primitive, and for
/// actors of a scene spec that explicitly allows primitive actors.
fn resolve_actor_model(state: &ServiceState, actor: &ActorState, class: &str) -> Result<Option<VehicleModelEntry>, String> {
    if let Some(path) = state.actor_model_refs.get(&actor.id) {
        return Ok(Some(VehicleModelEntry {
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
            rider: None,
        }));
    }
    let primitive = |reason: String| -> Result<Option<VehicleModelEntry>, String> {
        if state.allow_primitive_actors {
            eprintln!("primitive-actor: {} renders as its class cuboid (scene spec allowPrimitiveActors): {reason}", actor.id);
            Ok(None)
        } else {
            Err(reason)
        }
    };
    let Some(catalog_id) = actor.catalog_id.as_deref() else {
        return primitive(format!("[native_actor_catalog_missing] actor {} ({class}) has no catalogId", actor.id));
    };
    let (catalog, which) = if class == "pedestrian" {
        (state.pedestrian_models.as_ref(), "pedestrianModels")
    } else {
        (state.vehicle_models.as_ref(), "vehicleModels")
    };
    let Some(catalog) = catalog else {
        return primitive(format!(
            "[native_actor_catalog_unavailable] actor {} needs catalog model {catalog_id}, but the scene spec has no {which} directory",
            actor.id
        ));
    };
    match catalog.resolve(catalog_id) {
        Some(entry) => Ok(Some(entry.clone())),
        None => primitive(format!(
            "[native_actor_model_unresolved] actor {}: catalog id {catalog_id} has no model in the {which} catalog",
            actor.id
        )),
    }
}

/// Identity an actor was spawned with; frames may move it, never change it.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct SpawnedActor {
    class: String,
    catalog_id: Option<String>,
    dims: [f32; 3],
    color: Option<String>,
}

/// Apply scene-state frame `index` to the world (spawn/update/despawn).
///
/// Strict: an actor without a class, dims or a resolvable catalog model, a
/// model that is missing or fails to load, a motion clip the catalog entry
/// lacks, an actor whose identity changes between frames, and a live actor a
/// frame does not account for all fail the tick with a `[native_*]` code.
fn apply_scene_tick(state: &mut ServiceState, index: u32) -> Result<(), String> {
    let frame = state
        .scene
        .get(index as usize)
        .cloned()
        .ok_or_else(|| format!("tick_index {index} out of range (loaded {} ticks)", state.scene.len()))?;
    if !(frame.tick_hz.is_finite() && frame.tick_hz > 0.0) {
        return Err(format!("[native_scene_tick_hz_invalid] scene frame {index} has tickHz {}", frame.tick_hz));
    }
    let mut seen = std::collections::HashSet::new();
    for actor in &frame.actors {
        if !seen.insert(actor.id.as_str()) {
            return Err(format!("[native_scene_actor_duplicated] actor {} appears twice in scene frame {index}", actor.id));
        }
        match actor.kind.as_str() {
            "despawn" => forget_actor(state, &actor.id),
            "spawn" | "update" => {
                let class = actor.actor_class.clone().ok_or_else(|| {
                    format!("[native_actor_class_missing] actor {} has no actorClass", actor.id)
                })?;
                let body_centred = actor
                    .catalog_id
                    .as_deref()
                    .is_some_and(render_core::catalog::body_centred_origin);
                let authored_dims = actor.dims.ok_or_else(|| {
                    format!("[native_actor_dims_missing] actor {} ({class}) has no dims", actor.id)
                })?;
                if ![authored_dims.l, authored_dims.w, authored_dims.h].iter().all(|v| v.is_finite() && *v > 0.0) {
                    return Err(format!("[native_actor_dims_invalid] actor {} dims {authored_dims:?}", actor.id));
                }
                let dims = {
                    use render_core::coordinates::{source_to_bevy,LengthWidthHeight,SourceRotation,FrameBasis};
                    source_to_bevy(LengthWidthHeight {length:authored_dims.l,width:authored_dims.w,height:authored_dims.h},
                        SourceRotation::WorldQuaternion(actor.transform.rotation),FrameBasis::Rig).size_xyz.to_array()
                };
                let identity = SpawnedActor {
                    class: class.clone(),
                    catalog_id: actor.catalog_id.clone(),
                    dims: [authored_dims.l, authored_dims.w, authored_dims.h],
                    color: actor.color.clone(),
                };
                match state.spawned_actors.get(&actor.id) {
                    Some(previous) if *previous != identity => {
                        return Err(format!(
                            "[native_actor_identity_changed] actor {} changed from {previous:?} to {identity:?} without a despawn",
                            actor.id
                        ));
                    }
                    Some(_) => {}
                    None => {
                        state.spawned_actors.insert(actor.id.clone(), identity);
                    }
                }
                let color = actor_color(actor, &class)?;
                // Body-centred catalog entries (articulated robot components)
                // are placed verbatim with their full rotation: their catalog
                // definition is the primitive, so they never get a GLB.
                let model = if body_centred { None } else { resolve_actor_model(state, actor, &class)? };
                // The full attitude is applied: render-timeline frames carry
                // road + body pitch/roll.
                let [qx, qy, qz, qw] = actor.transform.rotation;
                let rotation = Quat::from_xyzw(qx, qy, qz, qw).normalize();
                let mut position = actor.transform.position;
                if !body_centred {
                    position[1] = actor_base_y(state, &actor.id, position, frame.ground_y)?;
                }
                // Source vehicle positions are ground origins; cuboids are
                // centre-origin, lifted along the body's own up axis.
                // Asset calibration never touches this body pose.
                let mut body_position=position;
                if !body_centred {
                    body_position=(Vec3::from_array(position)+rotation*Vec3::new(0.0,dims[1]*0.5,0.0)).to_array();
                }
                if state.actor_extents.insert(actor.id.clone(), dims).is_none() {
                    state.needs_settle = true;
                }
                state.app.upsert_actor(
                    &actor.id,
                    &class,
                    body_position,
                    rotation,
                    dims,
                    color,
                );
                if let Some(model) = model {
                    apply_actor_model(state, actor, &model, &frame, dims, color, position, rotation)?;
                }
            }
            other => return Err(format!("unknown actor kind {other:?} for {}", actor.id)),
        }
    }
    // Every frame is a complete snapshot of the live actors: one missing
    // without a despawn would otherwise stay frozen and visible.
    let mut unaccounted: Vec<String> = state
        .app
        .actor_ids()
        .into_iter()
        .filter(|id| !seen.contains(id.as_str()))
        .collect();
    if !unaccounted.is_empty() {
        unaccounted.sort();
        return Err(format!(
            "[native_scene_actor_unaccounted] scene frame {index} neither updates nor despawns live actor(s) {}",
            unaccounted.join(", ")
        ));
    }
    state.current_tick = Some(index);
    Ok(())
}

/// A ridden two-wheeler's clip time at this frame: its odometer phase. The
/// odometer is the timeline's `wheelSpinRad`; without it the rider cannot be
/// posed and the frame fails rather than drawing a frozen or riderless bike.
fn rider_clip_time(actor: &ActorState, rider: &render_core::vehicle_model::RiderSpec) -> Result<f32, String> {
    let spin = actor.wheel_spin_rad.filter(|v| v.is_finite()).ok_or_else(|| format!(
        "[native_rider_odometer_missing] ridden two-wheeler {} ({}) needs the render timeline's wheelSpinRad to pose its rider, \
         and this scene-state frame carries none (a timeline from before samplerVersion 2, or the \
         xosc-lowered legacy path); re-simulate the scenario",
        actor.id,
        actor.catalog_id.as_deref().unwrap_or("?"), // fallback-ok: error message text only
    ))?;
    Ok(rider.clip_time_from_wheel_spin(spin))
}

/// Attach, rebind or pose an actor's catalog model for this frame.
#[allow(clippy::too_many_arguments)]
fn apply_actor_model(
    state: &mut ServiceState,
    actor: &ActorState,
    model: &VehicleModelEntry,
    frame: &SceneState,
    dims: [f32; 3],
    color: [f32; 3],
    position: [f32; 3],
    rotation: Quat,
) -> Result<(), String> {
    let moving = actor.velocity.iter().map(|value| value * value).sum::<f32>().sqrt() > 0.2
        || actor.catalog_id.as_deref().is_some_and(|id| id.ends_with("_walking"));
    let motion = if moving { "walk" } else { "idle" };
    // A ridden two-wheeler plays its one ride clip, phased by distance (never
    // by wall or frame time), and always renders with its rider.
    let rider_time = model.rider.as_ref().map(|rider| rider_clip_time(actor, rider)).transpose()?;
    // A catalog entry with animation clips must have the one this motion
    // needs: rendering it without would freeze the actor in its bind pose.
    let (glb_path, clip) = if let Some(rider) = &model.rider {
        (model.glb_path.clone(), Some(rider.clip.clone()))
    } else if model.animations.is_empty() {
        (model.glb_path.clone(), None)
    } else {
        let (path, clip) = model.animations.get(motion).ok_or_else(|| {
            format!(
                "[native_actor_animation_missing] actor {} ({}) is {motion}ing but its catalog model binds no {motion:?} clip (has {:?})",
                actor.id,
                actor.catalog_id.as_deref().unwrap_or("-"), // fallback-ok: error message text only
                { let mut names: Vec<_> = model.animations.keys().collect(); names.sort(); names }
            )
        })?;
        (path.clone(), Some(clip.clone()))
    };
    // A ridden two-wheeler is phased by distance; everything else by frame time.
    let animation_time_s = match rider_time {
        Some(time) => time,
        None => frame.tick as f32 / frame.tick_hz,
    };
    let binding = (glb_path.clone(), clip.clone());
    if state.app.actor_has_model(&actor.id) && state.actor_model_bindings.get(&actor.id) != Some(&binding) {
        // The motion changed (idle <-> walk): bind the other clip's GLB.
        state
            .app
            .detach_actor_asset(&actor.id)
            .map_err(|error| format!("[native_actor_model_rebind_failed] actor {}: {error:#}", actor.id))?;
        state.actor_model_bindings.remove(&actor.id);
    }
    if !state.app.actor_has_model(&actor.id) {
        if !glb_path.is_file() {
            return Err(format!(
                "[native_actor_model_missing] actor {}: catalog model file {} does not exist",
                actor.id,
                glb_path.display()
            ));
        }
        let scale = match (model.uniform_scale, model.scale_to_dims) {
            (Some(scale), _) => scale,
            (None, true) => {
                let length = model.model_length_m.filter(|length| *length > 0.1).ok_or_else(|| {
                    format!(
                        "[native_actor_model_scale_unknown] actor {}: catalog model {} scales to the actor's length but its model length is unknown",
                        actor.id,
                        glb_path.display()
                    )
                })?;
                dims[0] / length as f32
            }
            (None, false) => 1.0,
        };
        state.needs_settle = true;
        // Only an authored colour tints the paint slot; without one the model
        // renders its own authored paint (never a class palette colour).
        let tint = (model.tintable && actor.color.is_some()).then_some(color);
        state
            .app
            .attach_actor_asset(&actor.id, &glb_path, scale, tint, clip.as_deref(), animation_time_s)
            .map_err(|error| format!("[native_actor_model_load_failed] actor {}: {error:#}", actor.id))?;
        if let Some(rider) = &model.rider {
            state
                .app
                .set_actor_material_colors(&actor.id, &rider.colors_for(&actor.id))
                .map_err(|error| format!("[native_rider_palette_failed] actor {}: {error:#}", actor.id))?;
        }
        state.actor_model_bindings.insert(actor.id.clone(), binding);
    } else if clip.is_some() {
        state
            .app
            .set_actor_animation_time(&actor.id, animation_time_s)
            .map_err(|error| format!("[native_actor_animation_failed] actor {}: {error:#}", actor.id))?;
    }
    let asset_position=(Vec3::from_array(position)+rotation*Vec3::new(0.0,model.ground_offset_m,0.0)).to_array();
    let asset_rotation=rotation*Quat::from_rotation_y(model.yaw_offset_rad);
    state.app.set_actor_asset_pose(&actor.id,asset_position,asset_rotation)
        .map_err(|error|format!("catalog pose: {error:#}"))?;
    state.app.set_actor_articulation(
        &actor.id,
        actor.body_attitude.map(|a| (a.pitch_rad, a.roll_rad)),
        actor.wheel_drop_m,
    )
    .map(|_| ())
    .map_err(|error|format!("catalog articulation: {error:#}"))
}

/// Height precedence for authored scene state. Non-zero actor Y is
/// canonical; frame `groundY` covers zero-height traces; without either the
/// scene-state contract says "snap to the map" (`groundY` absent), which
/// must land on the scene's ground source (`SceneApp::ground_height`): off
/// the map, or between stacked decks, is an error, never an invented height.
fn actor_base_y(state: &ServiceState, actor_id: &str, position: [f32; 3], frame_ground_y: Option<f32>) -> Result<f32, String> {
    base_y_precedence(position[1], frame_ground_y, || state.app.ground_height(position[0], position[2]))
        .map_err(|error| format!("actor {actor_id} has no authored height: {error}"))
}

fn base_y_precedence(
    authored_y: f32,
    frame_ground_y: Option<f32>,
    sampled_y: impl FnOnce() -> Result<f32, String>,
) -> Result<f32, String> {
    if authored_y.abs() >= 1e-4 {
        Ok(authored_y)
    } else {
        match frame_ground_y {
            Some(y) => Ok(y),
            None => sampled_y(),
        }
    }
}

fn quat_yaw(q: &[f32; 4]) -> f32 {
    let [x, y, z, w] = *q;
    // Yaw about +Y from a unit quaternion.
    let sin = 2.0 * (w * y + z * x);
    let cos = 1.0 - 2.0 * (y * y + z * z);
    sin.atan2(cos)
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


/// Resolve a camera pose: explicit eye/target, or rigid attachment against
/// the current scene frame.
fn resolve_pose(
    state: &ServiceState,
    cam: &ServiceCamera,
) -> Result<([f32; 3], [f32; 3]), String> {
    let Some(attach) = &cam.attach else {
        return Ok((cam.eye, cam.target));
    };
    let mount=resolve_sensor_mount(state,attach)?;
    let target=if attach.look_at_actor {
        mount.host_origin+Vec3::Y
    } else {
        mount.origin+50.0*(mount.rotation*Vec3::X)
    };
    Ok((mount.origin.to_array(),target.to_array()))
}

struct ResolvedSensorMount {
    origin: Vec3,
    rotation: Quat,
    host_velocity: Vec3,
    host_origin: Vec3,
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
    let position = actor.transform.position;
    let actor_y = actor_base_y(state, &attach.actor_id, position, frame.ground_y)?;
    // Sensors ride the body rigidly, pitch and roll included (yaw-only for
    // xosc-lowered frames, whose rotations carry no attitude).
    let [qx, qy, qz, qw] = actor.transform.rotation;
    let actor_rotation = Quat::from_xyzw(qx, qy, qz, qw).normalize();
    // Wire mount: forward/right/up. Canonical sensor: forward/up/right.
    let local_offset = Vec3::new(
        attach.offset_m[0],
        attach.offset_m[2],
        attach.offset_m[1],
    );
    let origin = Vec3::new(position[0], actor_y, position[2])
        + actor_rotation.mul_vec3(local_offset);
    use render_core::coordinates::{source_to_bevy, LengthWidthHeight, SourceRotation, FrameBasis};
    let mount_rotation = source_to_bevy(LengthWidthHeight::UNIT,
        SourceRotation::MountYawPitchRoll { parent_rotation: actor_rotation,
            yaw: attach.yaw_deg.to_radians(), pitch: attach.pitch_deg.to_radians(),
            roll: attach.roll_deg.to_radians() }, FrameBasis::Rig).rotation;
    Ok(ResolvedSensorMount {
        origin,
        rotation: mount_rotation,
        host_velocity: Vec3::from_array(actor.velocity),
        host_origin: Vec3::new(position[0],actor_y,position[2]),
    })
}

fn lidar_config(sensor: &ServiceLidar) -> sensors::lidar::LidarConfig {
    sensors::lidar::LidarConfig {
        channels: sensor.channels,
        rotation_frequency_hz: sensor.rotation_frequency_hz,
        points_per_second: sensor.points_per_second,
        vfov_deg: sensor.vertical_fov_deg,
        hfov_deg: sensor.horizontal_fov_deg,
        range_m: sensor.range_m,
    }
}

fn upsert_lidar_rig(state: &mut ServiceState, sensor: &ServiceLidar) -> Result<(), String> {
    lidar_config(sensor).validate().map_err(|error| format!("lidar {}: {error}", sensor.sensor_id))?;
    match state
        .lidars
        .iter_mut()
        .find(|registered| registered.sensor_id == sensor.sensor_id)
    {
        Some(registered) => *registered = sensor.clone(),
        None => state.lidars.push(sensor.clone()),
    }
    Ok(())
}

fn upsert_radar_rig(state: &mut ServiceState, sensor: &ServiceRadar) -> Result<(), String> {
    let bad = |what: String| Err(format!("[native_radar_config_invalid] radar {}: {what}", sensor.sensor_id));
    if sensor.points_per_second == 0 {
        return bad("points per second is 0".into());
    }
    if !(sensor.horizontal_fov_deg.is_finite() && sensor.horizontal_fov_deg > 0.0 && sensor.horizontal_fov_deg <= 180.0) {
        return bad(format!("horizontal FOV {} deg (0, 180]", sensor.horizontal_fov_deg));
    }
    if !(sensor.vertical_fov_deg.is_finite() && sensor.vertical_fov_deg > 0.0 && sensor.vertical_fov_deg < 180.0) {
        return bad(format!("vertical FOV {} deg (0, 180)", sensor.vertical_fov_deg));
    }
    if !(sensor.range_m.is_finite() && sensor.range_m > 0.0) {
        return bad(format!("range {} m", sensor.range_m));
    }
    match state
        .radars
        .iter_mut()
        .find(|registered| registered.sensor_id == sensor.sensor_id)
    {
        Some(registered) => *registered = sensor.clone(),
        None => state.radars.push(sensor.clone()),
    }
    Ok(())
}

/// Upsert a camera spec into the retained rig (registration order kept).
fn upsert_rig(state: &mut ServiceState, cam: &ServiceCamera) -> Result<(), String> {
    let bad = |what: String| Err(format!("[native_camera_config_invalid] camera {}: {what}", cam.sensor_id));
    if cam.width == 0 || cam.height == 0 {
        return bad(format!("size {}x{}", cam.width, cam.height));
    }
    if !(cam.fov_deg.is_finite() && cam.fov_deg > 0.0 && cam.fov_deg < 180.0) {
        return bad(format!("vertical FOV {} deg", cam.fov_deg));
    }
    if !matches!(cam.depth_encoding.as_deref(), None | Some("linear") | Some("carla")) {
        return bad(format!("unknown depth encoding {:?} (linear, carla)", cam.depth_encoding));
    }
    match state.rig.iter_mut().find(|c| c.sensor_id == cam.sensor_id) {
        Some(slot) => *slot = cam.clone(),
        None => state.rig.push(cam.clone()),
    }
    Ok(())
}

/// GPU pass set every service camera is registered with. Which of them
/// are copied out is decided per request (`capture_keys`); the ID view
/// only renders when one of its passes is requested.
const SERVICE_PASSES: PassSet = PassSet { rgb: true, id: true, depth: true, hdr: false };

/// Register a camera, or re-register it when its size or field of view
/// changed since the last request. Cached payloads of a replaced
/// camera belong to the old target and are dropped.
fn ensure_camera(state: &mut ServiceState, cam: &ServiceCamera, hdr: bool) {
    let spec = CameraSpec {
        sensor_id: cam.sensor_id.clone(),
        width: cam.width,
        height: cam.height,
        fov_y_deg: cam.fov_deg,
        near: state.near_m,
        far: state.far_m,
        passes: PassSet { hdr, ..SERVICE_PASSES },
    };
    if state.app.camera(&cam.sensor_id) == Some(&spec) {
        return;
    }
    let prefix = format!("{}:", cam.sensor_id);
    state.cache.retain(|key, _| !key.starts_with(&prefix));
    state.app.add_camera(spec);
    // A presentation camera that shows its host (the trailing chase) is
    // narrow: the rig-wide cascade union would coarsen its shadows ~3x, so
    // it keeps its own fit. Rig sensors share one cascade set.
    let presentation = cam.attach.as_ref().is_some_and(|attach| attach.host_visible);
    state.app.set_camera_shared_shadows(&cam.sensor_id, !presentation);
    state.needs_settle = true;
}

/// Bring the resident rig in line with `cameras` for this tick: register
/// or replace each camera, mount it on its attach actor (so that actor's
/// RGB geometry is excluded from this view only), resolve and set its
/// pose, and re-meter through the first camera.
fn sync_rig(state: &mut ServiceState, cameras: &[ServiceCamera], hdr: bool) -> Result<(), String> {
    for (index, cam) in cameras.iter().enumerate() {
        ensure_camera(state, cam, hdr);
        let host = cam
            .attach
            .as_ref()
            .filter(|attach| !attach.host_visible)
            .map(|attach| attach.actor_id.as_str());
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
            auto_meter(state, cam, &eye, &target)?;
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
///
/// Every instance id in the pass must be a static legend entry or a live
/// actor with a mappable class: an unknown id or class fails the pass
/// instead of being written as unlabeled.
fn semantic_from_ids(state: &ServiceState, id_data: &[u8], width: u32, height: u32, stride: usize) -> Result<Vec<u8>, String> {
    let legend = &state.legend;
    let app = &state.app;
    let mut classes: HashMap<u32, u8> = HashMap::new();
    let mut failure: Option<String> = None;
    let out = crate::carla::semantic_from_ids(id_data, width, height, stride, |id| {
        if let Some(class) = classes.get(&id) {
            return *class;
        }
        let class = if let Some(class) = app.actor_instance_class(id) {
            crate::carla::actor_class_of(class)
        } else if let Some(name) = legend.get(&id) {
            Ok(crate::carla::static_class_of(name))
        } else {
            Err(format!("[native_semantic_instance_unknown] instance id {id} in the ID pass is neither a static mesh nor a live actor"))
        };
        match class {
            Ok(class) => {
                classes.insert(id, class);
                class
            }
            Err(error) => {
                failure.get_or_insert(error);
                0
            }
        }
    });
    match failure {
        Some(error) => Err(error),
        None => Ok(out),
    }
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
    if want.hdr {
        planned.push(PlannedPass { pass: "hdr", format_tag: FORMAT_RGBA16F, format_name: "rgba16f", data: take("hdr")?.to_vec() });
    }
    if want.depth {
        let raw = take("depth")?;
        let carla = cam.depth_encoding.as_deref() == Some("carla");
        planned.push(PlannedPass {
            pass: "depth",
            format_tag: FORMAT_DEPTH32F,
            format_name: if carla { "carla-depth-bgra" } else { "depth32f" },
            data: if carla {
                crate::carla::depth_to_carla(raw, cam.width, cam.height, stride, state.near_m)
            } else {
                raw.to_vec()
            },
        });
    }
    if want_semantic {
        let out = semantic_from_ids(state, take("id")?, cam.width, cam.height, stride)?;
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
        if let Err(error) = upsert_rig(state, cam) {
            return WireResponse::error(i, error);
        }
    }
    if let Err(error) = sync_rig(state, &cameras, false) {
        return WireResponse::error(i, error);
    }
    if let Err(error) = state.app.wait_for_capture_ready() {
        return WireResponse::error(i, format!("capture readiness: {error:#}"));
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
        if let Err(error) = std::fs::create_dir_all(&dir) {
            return WireResponse::error(i, format!("export_dir {dir}: {error}"));
        }
        // Debug PNG mirror of frames already published in the ring (the
        // Python `render(export_dir=...)` aid); write errors are logged.
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
        if item.pass != "rgb" {
            return WireResponse::error(i, format!(
                "[native_jpeg_pass_unsupported] {key}: only rgb passes encode as JPEG (id/depth/semantic bytes are not colour)"
            ));
        }
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
    "this simforge-render was built without the `gpu-interop` feature; device streams are unavailable (host frames via the shm ring remain available)"
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
    let mut want = PassSet { rgb: false, id: false, depth: false, hdr: false };
    let mut want_semantic = false;
    for pass in requested {
        match pass.as_str() {
            "rgb" => want.rgb = true,
            "id" => want.id = true,
            "depth" => want.depth = true,
            "hdr" => want.hdr = true,
            "semantic" => want_semantic = true,
            other => return Err(format!("unknown bundle pass {other:?}")),
        }
    }
    let want_id_output = want.id;
    want.id |= want_semantic;
    Ok((want, want_id_output, want_semantic))
}

/// The exposure each camera metered for this capture, when the look carries
/// the camera model (`None` otherwise). A camera model whose readback is
/// missing from the capture is an error, never an omitted row.
fn camera_exposures(
    state: &ServiceState,
    captured: &CapturedFrame,
    rig: &[ServiceCamera],
) -> Result<Option<std::collections::BTreeMap<String, crate::proto::CameraExposure>>, String> {
    if !state.camera_model_on() || !rig.iter().any(|cam| captured.passes.contains_key(&format!("{}:rgb", cam.sensor_id))) {
        return Ok(None);
    }
    let sensor = state.render_config.camera.sensor;
    let mut out = std::collections::BTreeMap::new();
    for cam in rig {
        if !captured.passes.contains_key(&format!("{}:rgb", cam.sensor_id)) {
            continue;
        }
        let bytes = captured_pass(captured, &cam.sensor_id, "exposure")?;
        let value = |k: usize| f32::from_le_bytes(bytes[k * 4..k * 4 + 4].try_into().expect("four bytes"));
        let program = render_core::camera_model::exposure_program(
            value(0),
            sensor.f_number,
            sensor.min_shutter_s,
            sensor.max_shutter_s,
            sensor.iso_max,
        );
        out.insert(cam.sensor_id.clone(), crate::proto::CameraExposure {
            ev100: value(0),
            adjust_ev: value(1),
            metered_log2_luminance: value(2),
            f_number: program.f_number,
            shutter_s: program.shutter_s,
            iso: program.iso,
            gain_db: program.gain_db,
        });
    }
    Ok(Some(out))
}

/// Everything [`finish_bundle`] needs of a bundle whose capture is on the GPU.
pub(crate) struct BundleInFlight {
    i: u64,
    sim_tick: u64,
    rig: Vec<ServiceCamera>,
    published: PassSet,
    want_semantic: bool,
    ticket: render_core::engine::CaptureTicket,
    /// This tick's lidar/radar scans, running on the ray pool.
    scan: Option<std::thread::JoinHandle<SensorResult>>,
    sensor_to_policy: std::collections::BTreeMap<String, render_core::coordinates::PolicyFromSensor>,
    observed: Option<(Option<u32>, Vec<crate::proto::ObservedActorPose>)>,
    stages: crate::proto::BundleStages,
    /// Service time spent in [`begin_bundle`], ms.
    begin_ms: f64,
}

/// Arguments of one `render_bundle` request.
pub(crate) struct BundleRequest {
    pub i: u64,
    pub sim_tick: u64,
    pub cameras: Option<Vec<ServiceCamera>>,
    pub lidars: Option<Vec<ServiceLidar>>,
    pub radars: Option<Vec<ServiceRadar>>,
    pub tick_index: Option<u32>,
    pub passes: Option<Vec<String>>,
    pub device_sensors: Vec<String>,
    pub sim_time_s: Option<f64>,
    pub observe: bool,
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
    sim_time_s: Option<f64>,
) -> WireResponse {
    let request = BundleRequest {
        i, sim_tick, cameras, lidars, radars, tick_index, passes, device_sensors, sim_time_s, observe: false,
    };
    match begin_bundle(state, request) {
        Ok(flight) => finish_bundle(state, flight),
        Err(response) => response,
    }
}

/// First half of a bundle: apply the tick, pose the rig, submit the capture
/// (without waiting for the GPU) and start the tick's sensor scans. After
/// this returns the world may move on to the next tick: everything the
/// bundle publishes is either on the GPU or owned by the in-flight record.
pub(crate) fn begin_bundle(state: &mut ServiceState, request: BundleRequest) -> Result<BundleInFlight, WireResponse> {
    let t0 = std::time::Instant::now();
    let BundleRequest { i, sim_tick, cameras, lidars, radars, tick_index, passes, device_sensors, sim_time_s, observe } = request;
    let mut stages = crate::proto::BundleStages::default();
    let ms = |since: std::time::Instant| since.elapsed().as_secs_f64() * 1000.0;
    // Default rgb-only: the policy hot loop.
    let requested = passes.unwrap_or_else(|| vec!["rgb".to_string()]); // fallback-ok: documented protocol default: rgb-only bundles
    let (want, want_id_output, want_semantic) = parse_bundle_passes(&requested).map_err(|error| WireResponse::error(i, error))?;
    for cam in cameras.iter().flatten() {
        upsert_rig(state, cam).map_err(|error| WireResponse::error(i, error))?;
    }
    for sensor in lidars.iter().flatten() {
        upsert_lidar_rig(state, sensor).map_err(|error| WireResponse::error(i, error))?;
    }
    for sensor in radars.iter().flatten() {
        upsert_radar_rig(state, sensor).map_err(|error| WireResponse::error(i, error))?;
    }
    if state.rig.is_empty() && state.lidars.is_empty() && state.radars.is_empty() {
        return Err(WireResponse::error(
            i,
            "render_bundle: no sensors registered (send `cameras`, `lidars`, or `radars` once)",
        ));
    }
    let mark = std::time::Instant::now();
    if let Some(index) = tick_index {
        apply_scene_tick(state, index).map_err(|error| WireResponse::error(i, error))?;
    }
    stages.apply_ms = ms(mark);
    let mark = std::time::Instant::now();
    let rig = state.rig.clone();
    let lidar_rig = state.lidars.clone();
    let radar_rig = state.radars.clone();
    sync_rig(state, &rig, want.hdr).map_err(|error| WireResponse::error(i, error))?;
    stages.rig_ms = ms(mark);
    let mut host_keys = capture_keys(&rig, want);
    if want.rgb && state.camera_model_on() {
        host_keys.extend(rig.iter().map(|cam| format!("{}:exposure", cam.sensor_id)));
    }
    for sensor_id in &device_sensors {
        if !rig.iter().any(|cam| cam.sensor_id == *sensor_id) {
            return Err(WireResponse::error(i, format!("render_bundle: device sensor {sensor_id:?} is not in the rig")));
        }
    }
    // The sky of this capture: its simulation time (pinned clock only).
    let sim_time = sim_time_s.or_else(|| {
        let frame = state.scene.get(state.current_tick? as usize)?;
        (frame.tick_hz > 0.0).then(|| f64::from(frame.tick) / f64::from(frame.tick_hz))
    });
    if let Some(seconds) = sim_time {
        state.app.set_sim_time(seconds);
    }
    let mark = std::time::Instant::now();
    let pinned = state.app.capture_clock() != render_core::engine::CaptureClock::Free;
    if !pinned || state.needs_settle {
        match state.app.wait_for_capture_ready() {
            Ok(updates) => stages.readiness_updates = updates,
            Err(error) => return Err(WireResponse::error(i, format!("capture readiness: {error:#}"))),
        }
        state.needs_settle = false;
    }
    stages.readiness_ms = ms(mark);
    let sensors_wanted = !lidar_rig.is_empty() || !radar_rig.is_empty();
    if sensors_wanted {
        let mark = std::time::Instant::now();
        state.ensure_sensor_scenes().map_err(|error| WireResponse::error(i, error))?;
        stages.sensor_scenes_ms = ms(mark);
    }
    let mark = std::time::Instant::now();
    // Device outputs keep the blocking path (their slots are armed by the
    // submission); host frames are collected in `finish_bundle`.
    let ticket = if device_sensors.is_empty() {
        state.app.capture_begin(sim_tick, &host_keys)
    } else {
        capture_bundle(state, sim_tick, &host_keys, &device_sensors).map(render_core::engine::CaptureTicket::Ready)
    }
    .map_err(|error| WireResponse::error(i, format!("render: {error:#}")))?;
    stages.capture_ms = ms(mark);
    // The world is now exactly as the capture drew it: snapshot the scan
    // inputs here and let the scans run while the GPU works.
    let policy_host = policy_host_frame(state).map_err(|error| WireResponse::error(i, error))?;
    let mut sensor_to_policy = std::collections::BTreeMap::new();
    let mut scan = None;
    if sensors_wanted {
        let mark = std::time::Instant::now();
        let work = prepare_sensor_work(state, &lidar_rig, &radar_rig, policy_host).map_err(|error| WireResponse::error(i, error))?;
        stages.sensor_setup_ms = ms(mark);
        sensor_to_policy = work.sensor_to_policy.clone();
        let scenes = state.sensor_scenes.clone().expect("sensor scenes built");
        let backend = state.lidar_backend;
        if state.overlap_sensors {
            stages.sensors_overlapped = true;
            scan = Some(
                std::thread::Builder::new()
                    .name("sensor-scan".into())
                    .spawn(move || run_sensor_work(&scenes, &work, backend))
                    .map_err(|error| WireResponse::error(i, format!("spawn sensor scan: {error}")))?,
            );
        } else {
            let result = run_sensor_work(&scenes, &work, backend);
            scan = Some(std::thread::spawn(move || result));
        }
    }
    let observed = observe.then(|| (state.current_tick, observe_actors(state)));
    Ok(BundleInFlight {
        i,
        sim_tick,
        rig,
        published: PassSet { rgb: want.rgb, id: want_id_output, depth: want.depth, hdr: want.hdr },
        want_semantic,
        ticket,
        scan,
        sensor_to_policy,
        observed,
        stages,
        begin_ms: t0.elapsed().as_secs_f64() * 1000.0,
    })
}

/// Second half: wait for the capture's readback and the scans, publish the
/// bundle and answer.
pub(crate) fn finish_bundle(state: &mut ServiceState, flight: BundleInFlight) -> WireResponse {
    let t0 = std::time::Instant::now();
    let BundleInFlight { i, sim_tick, rig, published, want_semantic, ticket, scan, sensor_to_policy, observed, mut stages, begin_ms } = flight;
    let ms = |since: std::time::Instant| since.elapsed().as_secs_f64() * 1000.0;
    let mark = std::time::Instant::now();
    let captured = match state.app.capture_finish(ticket) {
        Ok(captured) => captured,
        Err(error) => {
            if let Some(scan) = scan {
                let _ = scan.join(); // fallback-ok: the render already failed; the scan result is discarded with it
            }
            return WireResponse::error(i, format!("render: {error:#}"));
        }
    };
    stages.capture_ms += ms(mark);
    {
        let capture = state.app.last_capture_stats();
        stages.capture_attempts = capture.attempts;
        stages.capture_settle_updates = capture.settle_updates;
        stages.readback_wait_ms = capture.readback_wait_ms;
        stages.readback_copy_ms = capture.readback_copy_ms;
        stages.readback_bytes = capture.readback_bytes;
        stages.accumulation_frames = capture.accumulation_frames;
    }
    let mark = std::time::Instant::now();
    let start_cursor = state.shm.cursor_total();
    let mut frames: Vec<FrameRecord> = Vec::new();
    let mut entries: Vec<BundleEntry> = Vec::new();
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
    stages.publish_cameras_ms = ms(mark);
    let exposure = match camera_exposures(state, &captured, &rig) {
        Ok(exposure) => exposure,
        Err(error) => return WireResponse::error(i, error),
    };
    if let Some(scan) = scan {
        let mark = std::time::Instant::now();
        let result = match scan.join() {
            Ok(result) => result,
            Err(_) => return WireResponse::error(i, "sensor scan thread panicked"),
        };
        stages.sensor_wait_ms = ms(mark);
        if let Some(error) = result.error {
            return WireResponse::error(i, error);
        }
        stages.lidar_gpu = result.lidar_gpu;
        if !result.unknown_instances.is_empty() {
            return WireResponse::error(i, format!(
                "[native_sensor_instance_unknown] lidar/radar hit instance id(s) {:?} that are neither static meshes nor live actors",
                result.unknown_instances
            ));
        }
        stages.actor_scene_ms = result.actor_scene_ms;
        stages.lidar_ms = result.lidar_ms;
        stages.radar_ms = result.radar_ms;
        for SensorPayload { sensor_id, pass, format_tag, format_name, count, data } in result.payloads {
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
    let mark = std::time::Instant::now();
    let published_bundle = state.shm.publish_bundle(sim_tick, start_cursor, &entries);
    stages.publish_sensors_ms = ms(mark);
    let (observed_tick, observed_actors) = match observed {
        Some((tick, actors)) => (tick, Some(actors)),
        None => (None, None),
    };
    match published_bundle {
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
                sensor_to_policy,
                server_ms: begin_ms + t0.elapsed().as_secs_f64() * 1000.0,
                stages: Some(stages),
                observed_tick,
                observed_actors,
                exposure,
            },
        },
        Err(error) => WireResponse::error(i, format!("publish bundle: {error}")),
    }
}

/// The ego frame sensor poses are reported relative to in policy episodes.
fn policy_host_frame(state: &ServiceState) -> Result<Option<render_core::coordinates::SensorFrame>, String> {
    let Some(episode) = state.episode.as_ref() else { return Ok(None) };
    let Some(frame) = state.current_tick.and_then(|tick| state.scene.get(tick as usize)) else { return Ok(None) };
    let actor = frame.actors.iter().find(|actor| actor.id == episode.ego_id).ok_or_else(|| {
        format!("[native_episode_ego_missing] episode ego {} is not in the current scene frame", episode.ego_id)
    })?;
    let p = actor.transform.position;
    let origin = Vec3::new(p[0], actor_base_y(state, &actor.id, p, frame.ground_y)?, p[2]);
    Ok(Some(render_core::coordinates::SensorFrame::from_bevy_pose(
        origin,
        Quat::from_rotation_y(quat_yaw(&actor.transform.rotation)),
    )))
}

/// One lidar scan of a tick: resolved mount and payload encoding.
struct LidarJob {
    sensor_id: String,
    config: sensors::lidar::LidarConfig,
    origin: Vec3,
    rotation: Quat,
    binary: bool,
}

/// One radar scan of a tick.
struct RadarJob {
    sensor_id: String,
    config: sensors::radar::RadarConfig,
    origin: Vec3,
    rotation: Quat,
    host_velocity: Vec3,
}

/// Everything one tick's lidar/radar scans read, owned, so the scans can run
/// on another thread while the GPU renders. Built from the world by
/// [`prepare_sensor_work`]; [`run_sensor_work`] is a pure function of it and
/// the static map scene.
struct SensorWork {
    /// The tick's actor meshes (see [`snapshot_actor_sensor_instances`]).
    actors: Vec<ActorSensorInstance>,
    /// Frozen static legend classes (built once per service).
    static_classes: std::sync::Arc<HashMap<u32, sensors::taxonomy::SemanticClass>>,
    /// The current frame's actors, resolved through the engine.
    actor_classes: HashMap<u32, sensors::taxonomy::SemanticClass>,
    instance_velocities: HashMap<u32, Vec3>,
    lidars: Vec<LidarJob>,
    radars: Vec<RadarJob>,
    sensor_to_policy: std::collections::BTreeMap<String, render_core::coordinates::PolicyFromSensor>,
}

/// One published lidar/radar payload.
struct SensorPayload {
    sensor_id: String,
    pass: &'static str,
    format_tag: u32,
    format_name: &'static str,
    count: u32,
    data: Vec<u8>,
}

struct SensorResult {
    payloads: Vec<SensorPayload>,
    /// Hit instance ids that are neither static legend entries nor live
    /// actors (must be empty: the finish step fails the bundle otherwise).
    unknown_instances: Vec<u32>,
    /// A scan that could not run (hardware-ray failure or a verify-mode
    /// mismatch): fails the bundle.
    error: Option<String>,
    /// Lidar beams traced on the RT cores.
    lidar_gpu: bool,
    actor_scene_ms: f64,
    lidar_ms: f64,
    radar_ms: f64,
}

/// Snapshot the scan inputs of the current tick from the world.
fn prepare_sensor_work(
    state: &mut ServiceState,
    lidar_rig: &[ServiceLidar],
    radar_rig: &[ServiceRadar],
    policy_host: Option<render_core::coordinates::SensorFrame>,
) -> Result<SensorWork, String> {
    let static_classes = state.static_sensor_classes();
    let actors = snapshot_actor_sensor_instances(&mut state.app, &mut state.actor_blas)?;
    let frame = state.current_tick.and_then(|index| state.scene.get(index as usize));
    let tick_hz = frame
        .map(|frame| frame.tick_hz)
        .ok_or_else(|| "[native_scene_tick_missing] lidar/radar requested before any scene tick was applied".to_string())?;
    let mut instance_velocities = HashMap::new();
    // The static legend alone would drop every actor back to the default
    // albedo: the current frame's actors are resolved through the engine.
    let mut actor_classes = HashMap::new();
    if let Some(frame) = frame {
        for actor in frame.actors.iter().filter(|actor| actor.kind != "despawn") {
            let instance_id = state.app.actor_instance_id(&actor.id).ok_or_else(|| {
                format!("[native_scene_actor_unaccounted] actor {} of the current frame is not in the world", actor.id)
            })?;
            instance_velocities.insert(instance_id, Vec3::from_array(actor.velocity));
            let class = state.app.actor_instance_class(instance_id).ok_or_else(|| {
                format!("[native_actor_class_missing] actor {} has no class in the world", actor.id)
            })?;
            actor_classes.insert(instance_id, sensors::taxonomy::SemanticClass::try_from_actor_class(class)?);
            // A ridden two-wheeler's rider is its own instance (class `rider`)
            // moving with the bike.
            if let Some(rider_id) = state.app.actor_rider_instance_id(&actor.id) {
                instance_velocities.insert(rider_id, Vec3::from_array(actor.velocity));
                actor_classes.insert(rider_id, sensors::taxonomy::SemanticClass::Rider);
            }
        }
    }
    let binary = state.episode.as_ref().is_some_and(|episode| {
        matches!(episode.consumer.lidar, Some(render_core::products::PointEncoding::Binary))
    });
    let mut sensor_to_policy = std::collections::BTreeMap::new();
    let mut lidars = Vec::with_capacity(lidar_rig.len());
    for sensor in lidar_rig {
        let mount = resolve_sensor_mount(state, &sensor.attach)?;
        if let Some(host) = policy_host {
            let pose = render_core::coordinates::SensorFrame::from_bevy_pose(mount.origin, mount.rotation);
            sensor_to_policy.insert(sensor.sensor_id.clone(), pose.policy_relative_to(host));
        }
        lidars.push(LidarJob {
            sensor_id: sensor.sensor_id.clone(),
            config: lidar_config(sensor),
            origin: mount.origin,
            rotation: mount.rotation,
            binary,
        });
    }
    let mut radars = Vec::with_capacity(radar_rig.len());
    for sensor in radar_rig {
        let mount = resolve_sensor_mount(state, &sensor.attach)?;
        radars.push(RadarJob {
            sensor_id: sensor.sensor_id.clone(),
            config: sensors::radar::RadarConfig::from_points_per_second(
                sensor.points_per_second,
                tick_hz,
                sensor.horizontal_fov_deg,
                sensor.vertical_fov_deg,
                sensor.range_m,
            )
            .map_err(|error| format!("radar {}: {error}", sensor.sensor_id))?,
            origin: mount.origin,
            rotation: mount.rotation,
            host_velocity: mount.host_velocity,
        });
    }
    Ok(SensorWork { actors, static_classes, actor_classes, instance_velocities, lidars, radars, sensor_to_policy })
}

/// One lidar scan with the static layer traced on the RT cores and the
/// actor layer on the CPU, merged by the same rule as
/// [`CombinedSensorScene`] (an actor wins only strictly nearer; its search
/// stops at the static hit). Byte-identical to the CPU scan.
fn gpu_lidar_scan(
    gpu: &sensors::gpu_rays::GpuRayScene,
    combined: &CombinedSensorScene<'_>,
    config: &sensors::lidar::LidarConfig,
    origin: Vec3,
    rotation: Quat,
    instance_class: &(dyn Fn(u32) -> sensors::taxonomy::SemanticClass + Sync),
) -> Result<Vec<sensors::lidar::LidarPoint>, String> {
    let t0 = std::time::Instant::now();
    let (frame, dirs) = sensors::lidar::beams(config, origin, rotation);
    let rays: Vec<sensors::gpu_rays::Ray> =
        dirs.iter().map(|dir| sensors::gpu_rays::Ray { origin, dir: *dir, t_max: config.range_m }).collect();
    let t1 = std::time::Instant::now();
    let statics = gpu
        .cast_hits(combined.static_scene, &rays)
        .map_err(|error| format!("[native_lidar_gpu_trace] {error:#}"))?;
    let t2 = std::time::Instant::now();
    // Actor layer on the CPU, one chunk of beams per ray-pool task; chunks
    // are concatenated in beam order, so the result is scheduling-free.
    let merge = |dirs: &[Vec3], statics: &[Option<Hit>]| -> Vec<Option<Hit>> {
        dirs.iter()
            .zip(statics)
            .map(|(dir, static_hit)| {
                let static_hit = *static_hit;
                let reach = static_hit.map_or(config.range_m, |hit| hit.distance);
                match combined.actor_scene.cast(origin, *dir, reach) {
                    Some(actor_hit) if static_hit.is_none_or(|hit| actor_hit.distance < hit.distance) => Some(actor_hit),
                    _ => static_hit,
                }
            })
            .collect()
    };
    const CHUNK: usize = 4096;
    let hits: Vec<Option<Hit>> = sensors::RAY_POOL
        .scope(|scope| {
            for (dirs, statics) in dirs.chunks(CHUNK).zip(statics.chunks(CHUNK)) {
                let merge = &merge;
                scope.spawn(async move { merge(dirs, statics) });
            }
        })
        .into_iter()
        .flatten()
        .collect();
    let t3 = std::time::Instant::now();
    let points = sensors::lidar::points_from_hits(frame, &dirs, &hits, instance_class);
    if std::env::var_os("SIMFORGE_DEBUG_LIDAR_TIMING").is_some() {
        eprintln!(
            "lidar-gpu: {} rays: beams {:.1} ms, trace {:.1} ms, actors {:.1} ms, points {:.1} ms",
            rays.len(),
            (t1 - t0).as_secs_f64() * 1e3,
            (t2 - t1).as_secs_f64() * 1e3,
            (t3 - t2).as_secs_f64() * 1e3,
            t3.elapsed().as_secs_f64() * 1e3
        );
    }
    Ok(points)
}

/// Build the actor scene and run every scan of `work` (pure; any thread).
fn run_sensor_work(scenes: &MapSensorScenes, work: &SensorWork, backend: LidarBackend) -> SensorResult {
    let started = std::time::Instant::now();
    let actor_scene = build_actor_sensor_scene(&work.actors);
    let actor_scene_ms = started.elapsed().as_secs_f64() * 1000.0;
    let combined_scene = CombinedSensorScene { static_scene: &scenes.static_scene, actor_scene: &actor_scene };
    // Every hit resolves to a static legend class or a live actor; an id
    // that resolves to neither is recorded and fails the bundle rather than
    // being labelled a prop.
    let unknown = std::sync::Mutex::new(std::collections::BTreeSet::new());
    let instance_class = |instance_id: u32| -> sensors::taxonomy::SemanticClass {
        match work.actor_classes.get(&instance_id).or_else(|| work.static_classes.get(&instance_id)) {
            Some(class) => *class,
            None => {
                unknown.lock().expect("unknown-instance set").insert(instance_id);
                sensors::taxonomy::SemanticClass::Unlabeled
            }
        }
    };
    let mut payloads = Vec::with_capacity(work.lidars.len() + work.radars.len());
    let mut error = None;
    let lidar_gpu = scenes.gpu.is_some() && backend != LidarBackend::Cpu;
    let started = std::time::Instant::now();
    for job in &work.lidars {
        let points = match (&scenes.gpu, lidar_gpu) {
            (Some(gpu), true) => match gpu_lidar_scan(gpu, &combined_scene, &job.config, job.origin, job.rotation, &instance_class) {
                Ok(points) => {
                    if backend == LidarBackend::Verify {
                        let reference = sensors::lidar::scan(&combined_scene, &job.config, job.origin, job.rotation, &instance_class);
                        let bytes = |points: &[sensors::lidar::LidarPoint]| sensors::formats::encode_lidar_ply_binary(points);
                        if bytes(&points) != bytes(&reference) {
                            error = Some(format!(
                                "[native_lidar_gpu_parity] lidar {}: hardware rays ({} points) differ from the CPU reference ({} points)",
                                job.sensor_id,
                                points.len(),
                                reference.len()
                            ));
                        }
                    }
                    points
                }
                Err(message) => {
                    error = Some(message);
                    Vec::new()
                }
            },
            _ => sensors::lidar::scan(&combined_scene, &job.config, job.origin, job.rotation, &instance_class),
        };
        payloads.push(SensorPayload {
            sensor_id: job.sensor_id.clone(),
            pass: "lidar",
            format_tag: if job.binary { FORMAT_LIDAR_BINARY } else { FORMAT_LIDAR_PLY },
            format_name: if job.binary { "ply-binary" } else { "ply-ascii" },
            count: points.len() as u32,
            data: if job.binary {
                sensors::formats::encode_lidar_ply_binary(&points)
            } else {
                sensors::formats::encode_lidar_ply(&points)
            },
        });
    }
    let lidar_ms = started.elapsed().as_secs_f64() * 1000.0;
    let started = std::time::Instant::now();
    for job in &work.radars {
        let detections = sensors::radar::scan(
            &combined_scene,
            &job.config,
            job.origin,
            job.rotation,
            job.host_velocity,
            &|instance_id| match work.instance_velocities.get(&instance_id) {
                Some(velocity) => *velocity,
                // Static geometry does not move.
                None if work.static_classes.contains_key(&instance_id) => Vec3::ZERO,
                None => {
                    unknown.lock().expect("unknown-instance set").insert(instance_id);
                    Vec3::ZERO
                }
            },
        );
        payloads.push(SensorPayload {
            sensor_id: job.sensor_id.clone(),
            pass: "radar",
            format_tag: FORMAT_RADAR_CSV,
            format_name: "radar-csv",
            count: detections.len() as u32,
            data: sensors::formats::encode_radar_csv(&detections),
        });
    }
    let radar_ms = started.elapsed().as_secs_f64() * 1000.0;
    let unknown_instances = unknown.into_inner().expect("unknown-instance set").into_iter().collect();
    SensorResult { payloads, unknown_instances, error, lidar_gpu, actor_scene_ms, lidar_ms, radar_ms }
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
        base_y_precedence, actor_color, rider_clip_time, build_map_sensor_scenes, build_sensor_scene, capture_keys,
        instance_coverage, on_road, parse_bundle_passes, row_stride, CombinedSensorScene,
    };
    use render_core::engine::SensorTriangle;
    use std::collections::HashMap;

    fn quad(x0: f32, z0: f32, size: f32, y: f32, instance_id: u32) -> [SensorTriangle; 2] {
        let (a, b, c, d) = ([x0, y, z0], [x0 + size, y, z0], [x0 + size, y, z0 + size], [x0, y, z0 + size]);
        [
            SensorTriangle { a, b, c, instance_id },
            SensorTriangle { a, b: c, c: d, instance_id },
        ]
    }

    /// World-space test triangles as static input: one identity-placed
    /// tree per instance id, in id order (as the engine orders statics).
    fn static_input(triangles: Vec<SensorTriangle>) -> super::StaticSensorInput {
        let mut by_id: std::collections::BTreeMap<u32, Vec<Tri>> = Default::default();
        for t in triangles {
            by_id.entry(t.instance_id).or_default().push(Tri {
                a: Vec3::from_array(t.a), b: Vec3::from_array(t.b), c: Vec3::from_array(t.c), instance_id: 0,
            });
        }
        let mut input = super::StaticSensorInput { blases: Vec::new(), instances: Vec::new() };
        for (id, tris) in by_id {
            input.blases.push(sensors::bvh::Blas::build(tris));
            input.instances.push((input.blases.len() - 1, bevy::math::Mat4::IDENTITY, id));
        }
        input
    }

    fn static_scene(triangles: Vec<SensorTriangle>) -> sensors::bvh::InstancedScene {
        build_map_sensor_scenes(&static_input(triangles), &HashMap::new()).static_scene
    }

    #[test]
    fn combined_scene_prunes_actors_behind_static_hits_without_changing_results() {
        // Static: ground at y=0 plus walls; actors: cars in front of, level
        // with and behind the walls. The pruned cast must equal searching
        // both layers to full range.
        let mut map = Vec::new();
        map.extend(quad(-60.0, -60.0, 120.0, 0.0, 1));
        for (i, x) in [8.0f32, -14.0, 20.0].into_iter().enumerate() {
            let id = 2 + i as u32;
            map.push(SensorTriangle { a: [x, 0.0, -30.0], b: [x, 6.0, -30.0], c: [x, 0.0, 30.0], instance_id: id });
            map.push(SensorTriangle { a: [x, 6.0, -30.0], b: [x, 6.0, 30.0], c: [x, 0.0, 30.0], instance_id: id });
        }
        let statics = static_scene(map);
        let car = sensors::bvh::Blas::build(quad(-2.0, -1.0, 4.0, 1.4, 0).iter().map(|t| Tri {
            a: Vec3::from_array(t.a), b: Vec3::from_array(t.b), c: Vec3::from_array(t.c), instance_id: 0,
        }).chain([Tri { a: Vec3::new(-2.0, 0.0, 0.0), b: Vec3::new(-2.0, 1.4, 0.0), c: Vec3::new(-2.0, 0.0, 1.0), instance_id: 0 }]));
        let instances: Vec<super::ActorSensorInstance> = [4.0f32, 8.0, 12.0, -9.0, -20.0]
            .into_iter()
            .enumerate()
            .map(|(i, x)| super::ActorSensorInstance::Shared {
                blas: car.clone(),
                world: bevy::math::Mat4::from_translation(Vec3::new(x, 0.0, (i as f32) - 2.0)),
                instance_id: 100 + i as u32,
            })
            .collect();
        let actors = super::build_actor_sensor_scene(&instances);
        let combined = CombinedSensorScene { static_scene: &statics, actor_scene: &actors };
        let origin = Vec3::new(0.3, 1.1, 0.2);
        let mut actor_hits = 0;
        for step in 0..720 {
            for ring in 0..8 {
                let az = step as f32 / 720.0 * std::f32::consts::TAU;
                let el = (-12.0 + 3.0 * ring as f32).to_radians();
                let dir = Vec3::new(el.cos() * az.cos(), el.sin(), el.cos() * az.sin());
                let full = match (statics.cast(origin, dir, 80.0), actors.cast(origin, dir, 80.0)) {
                    (Some(s), Some(a)) if a.distance < s.distance => Some(a),
                    (Some(s), _) => Some(s),
                    (None, a) => a,
                };
                let pruned = sensors::bvh::Raycast::cast(&combined, origin, dir, 80.0);
                let key = |hit: Option<sensors::bvh::Hit>| hit.map(|h| (h.distance.to_bits(), h.instance_id));
                assert_eq!(key(pruned), key(full), "az {az} el {el}");
                actor_hits += usize::from(full.is_some_and(|h| h.instance_id >= 100));
            }
        }
        assert!(actor_hits > 50, "fixture must hit actors ({actor_hits})");
    }

    #[test]
    fn map_sensor_scenes_split_road_from_everything_and_match_a_serial_build() {
        // A road slab at y=0 (id 1), a building roof at y=5 (id 2) beside it.
        let mut triangles = Vec::new();
        triangles.extend(quad(0.0, 0.0, 10.0, 0.0, 1));
        triangles.extend(quad(20.0, 0.0, 10.0, 5.0, 2));
        let legend: HashMap<u32, String> =
            [(1, "Road_Asphalt_01".to_string()), (2, "Building_Block_7".to_string())].into();
        let scenes = build_map_sensor_scenes(&static_input(triangles.clone()), &legend);
        let down = |scene: &RaycastScene, x: f32| {
            scene.cast(Vec3::new(x, 100.0, 5.0), Vec3::NEG_Y, 1000.0).map(|hit| hit.instance_id)
        };
        assert_eq!(down(&scenes.road, 5.0), Some(1));
        assert_eq!(down(&scenes.road, 25.0), None, "buildings are not road");
        let instanced = |x: f32| {
            scenes.static_scene.cast(Vec3::new(x, 100.0, 5.0), Vec3::NEG_Y, 1000.0).map(|hit| hit.instance_id)
        };
        assert_eq!(instanced(25.0), Some(2));
        let serial = build_sensor_scene(triangles);
        for x in [1.0, 5.0, 9.5, 15.0, 21.0, 29.0] {
            assert_eq!(instanced(x), down(&serial, x));
        }
        let footprint = |x: f64| crate::traffic::Footprint { x, z: 5.0, yaw: 0.0, length: 2.0, width: 1.0 };
        assert!(on_road(&scenes.road, footprint(5.0)));
        assert!(!on_road(&scenes.road, footprint(25.0)));
    }
    use crate::proto::ServiceCamera;
    use crate::scene::{ActorState, ActorTransform};
    use bevy::math::{Quat, Vec3};
    use sensors::bvh::{InstancedScene, RaycastScene, Tri};
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
        assert_eq!(base_y_precedence(2.225, None, || Ok(-9.7)), Ok(2.225));
        assert_eq!(base_y_precedence(0.0, Some(3.5), || Ok(-9.7)), Ok(3.5));
        assert_eq!(base_y_precedence(0.0, None, || Ok(1.75)), Ok(1.75));
        // Off the map with no authored height: the ground source's error,
        // never an invented height.
        assert_eq!(
            base_y_precedence(0.0, None, || Err("[native_ground_height_unavailable] off".into())),
            Err("[native_ground_height_unavailable] off".to_string())
        );
    }

    #[test]
    fn ridden_two_wheeler_clip_time_is_its_odometer_phase_and_requires_it() {
        let rider = render_core::vehicle_model::RiderSpec {
            clip: "ride".into(),
            clip_duration_s: 1.0,
            meters_per_cycle: 4.2,
            palettes: vec![None],
        };
        let actor = |spin: Option<f64>| ActorState {
            id: "bike-1".into(),
            kind: "update".into(),
            catalog_id: Some("vehicle.bicycle".into()),
            actor_class: Some("cyclist".into()),
            color: None,
            transform: ActorTransform { position: [0.0; 3], rotation: [0.0, 0.0, 0.0, 1.0] },
            dims: None,
            velocity: [3.0, 0.0, 0.0],
            wheel_spin_rad: spin,
            body_attitude: None,
            wheel_drop_m: None,
        };
        // 6.3 m travelled = 1.5 cycles -> half-way through the clip.
        let t = rider_clip_time(&actor(Some(6.3 / 0.35)), &rider).unwrap();
        assert!((t - 0.5).abs() < 1e-5, "{t}");
        let error = rider_clip_time(&actor(None), &rider).unwrap_err();
        assert!(error.contains("wheelSpinRad") && error.contains("bike-1"), "{error}");
        assert!(rider_clip_time(&actor(Some(f64::NAN)), &rider).is_err());
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
            wheel_spin_rad: None,
            body_attitude: None,
            wheel_drop_m: None,
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
        let mut static_instanced = InstancedScene::new();
        let wall = static_instanced.add_mesh(static_scene);
        static_instanced.add_instance(wall, bevy::math::Mat4::IDENTITY, 1);
        static_instanced.build();
        let actor_scene = RaycastScene::new();
        let scene = CombinedSensorScene {
            static_scene: &static_instanced,
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
        let radar = sensors::radar::RadarConfig::from_points_per_second(1280, 20.0, 30.0, 10.0, 30.0).unwrap();
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

    /// An actor as the service snapshots it: a shared model-local tree
    /// placed by a world matrix (the rigid-mesh path).
    fn sensor_work(actor_triangles: Vec<SensorTriangle>) -> super::SensorWork {
        let origin = Vec3::from_array(actor_triangles[0].a);
        let blas = sensors::bvh::Blas::build(actor_triangles.iter().map(|t| Tri {
            a: Vec3::from_array(t.a) - origin,
            b: Vec3::from_array(t.b) - origin,
            c: Vec3::from_array(t.c) - origin,
            instance_id: 0,
        }));
        super::SensorWork {
            actors: vec![super::ActorSensorInstance::Shared {
                blas,
                world: bevy::math::Mat4::from_translation(origin),
                instance_id: actor_triangles[0].instance_id,
            }],
            static_classes: std::sync::Arc::new(HashMap::from([(1, SemanticClass::Building), (2, SemanticClass::Building), (3, SemanticClass::Prop)])),
            actor_classes: HashMap::from([(7, SemanticClass::Car)]),
            instance_velocities: HashMap::from([(7, Vec3::new(3.0, 0.0, 0.0))]),
            lidars: vec![super::LidarJob {
                sensor_id: "lidar".into(),
                config: sensors::lidar::LidarConfig {
                    channels: 4, rotation_frequency_hz: 10.0, points_per_second: 4096,
                    vfov_deg: 20.0, hfov_deg: 360.0, range_m: 60.0,
                },
                origin: Vec3::new(0.0, 1.5, 0.0),
                rotation: Quat::IDENTITY,
                binary: false,
            }],
            radars: vec![super::RadarJob {
                sensor_id: "radar".into(),
                config: sensors::radar::RadarConfig::from_points_per_second(1280, 20.0, 60.0, 10.0, 60.0).unwrap(),
                origin: Vec3::new(0.0, 1.0, 0.0),
                rotation: Quat::IDENTITY,
                host_velocity: Vec3::new(10.0, 0.0, 0.0),
            }],
            sensor_to_policy: Default::default(),
        }
    }

    #[test]
    fn scans_on_the_sensor_thread_match_the_serial_scan_byte_for_byte() {
        let mut map = Vec::new();
        map.extend(quad(-50.0, -50.0, 100.0, 0.0, 1));
        for (i, x) in [10.0f32, -12.0, 0.0].into_iter().enumerate() {
            map.extend(quad(x, 8.0, 2.0, 0.5, 1 + i as u32));
        }
        let scenes = std::sync::Arc::new(build_map_sensor_scenes(&static_input(map), &HashMap::new()));
        let actor = quad(5.0, -3.0, 2.0, 1.0, 7).to_vec();
        let serial = super::run_sensor_work(&scenes, &sensor_work(actor.clone()), super::LidarBackend::Cpu);
        let shared = scenes.clone();
        let work = sensor_work(actor);
        let threaded = std::thread::spawn(move || super::run_sensor_work(&shared, &work, super::LidarBackend::Cpu)).join().unwrap();
        let bytes = |result: &super::SensorResult| result.payloads.iter().map(|p| (p.sensor_id.clone(), p.count, p.data.clone())).collect::<Vec<_>>();
        assert_eq!(bytes(&threaded), bytes(&serial));
        assert!(threaded.payloads.iter().any(|p| p.count > 0), "fixture must produce hits");
    }

    /// The hardware-ray lidar path publishes the CPU scan's exact bytes,
    /// with actors merged on top (skips without an RT-capable GPU).
    #[test]
    fn gpu_lidar_payloads_match_the_cpu_scan_byte_for_byte() {
        let Some((device, queue, name)) = sensors::gpu_rays::headless_device() else {
            eprintln!("SKIP gpu lidar payload parity: no hardware ray queries");
            return;
        };
        let mut map = Vec::new();
        map.extend(quad(-50.0, -50.0, 100.0, 0.0, 1));
        for (i, x) in [10.0f32, -12.0, 0.0].into_iter().enumerate() {
            map.extend(quad(x, 8.0, 2.0, 0.5, 2 + i as u32));
        }
        let mut scenes = build_map_sensor_scenes(&static_input(map), &HashMap::new());
        scenes.gpu = Some(sensors::gpu_rays::GpuRayScene::new(&scenes.static_scene, device, queue).expect("gpu scene"));
        let actor = quad(5.0, -3.0, 2.0, 1.0, 7).to_vec();
        let cpu = super::run_sensor_work(&scenes, &sensor_work(actor.clone()), super::LidarBackend::Cpu);
        let gpu = super::run_sensor_work(&scenes, &sensor_work(actor.clone()), super::LidarBackend::Gpu);
        let verify = super::run_sensor_work(&scenes, &sensor_work(actor), super::LidarBackend::Verify);
        assert!(gpu.lidar_gpu && !cpu.lidar_gpu);
        assert!(gpu.error.is_none() && verify.error.is_none(), "{:?} {:?}", gpu.error, verify.error);
        let bytes = |result: &super::SensorResult| result.payloads.iter().map(|p| (p.sensor_id.clone(), p.count, p.data.clone())).collect::<Vec<_>>();
        assert_eq!(bytes(&gpu), bytes(&cpu), "on {name}");
        assert!(gpu.payloads.iter().any(|p| p.pass == "lidar" && p.count > 0), "fixture must produce lidar hits");
    }

    #[test]
    fn persistent_lidar_radar_payloads_are_bit_identical_across_three_tick_runs() {
        let first = deterministic_sensor_run();
        let second = deterministic_sensor_run();
        assert_eq!(first, second);
        assert_ne!(first[0], first[2], "fixture must exercise distinct ticks");
    }
}
