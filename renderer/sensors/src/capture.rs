//! Multi-camera multi-pass deterministic capture harness.
//!
//! A headless Bevy app renders the selected rig cameras into image targets:
//! - RGB uses AgX; depth is copied from the same view's reverse-Z depth buffer.
//! - An optional second, unlit view packs instance ID in R/G and semantic
//!   class in B. Label cameras disable both tonemapping and debanding.
//! - IDs are assigned from sorted mesh names and geometry centers (0 is the
//!   background). ID clones are created in registry order.
//! - Static geometry is instanced once for CPU ray sensors and the optional
//!   hardware-ray lidar backend. Actor cuboids are posed from scene-state.
//!
//! Strict draws are the default; `--fast-gpu` enables an explicitly
//! non-byte-stable indirect path. Shared shadows and hardware lidar are also
//! opt-in because their fidelity differs from the reference. `--video` feeds
//! final encoders directly and joins them before the capture summary/manifest.

use crate::bvh::{InstancedScene, Raycast, RaycastScene, Tri};
use crate::formats;
use crate::imu_gnss::{GnssSample, ImuSample, TmercOrigin};
use crate::lidar;
use crate::radar;
use crate::rig::{Mount, RigSpec, SensorKind};
use crate::scene_state::SceneState;
use crate::taxonomy::{Legend, SemanticClass};
use anyhow::{bail, Context as _, Result};
use crossbeam_channel;
use bevy::app::{AppExit, ScheduleRunnerPlugin};
use bevy::camera::visibility::RenderLayers;
use bevy::camera::RenderTarget;
use bevy::core_pipeline::tonemapping::Tonemapping;
use bevy::gltf::Gltf;
use bevy::light::cascade::CascadeShadowConfigBuilder;
use bevy::light::{DirectionalLight, DirectionalLightShadowMap, GlobalAmbientLight};
use bevy::log::LogPlugin;
use bevy::prelude::*;
use bevy::render::render_asset::RenderAssets;
use bevy::render::render_resource::{
    Buffer, BufferDescriptor, BufferUsages, CommandEncoderDescriptor, MapMode, PollType,
    TexelCopyBufferInfo, TexelCopyBufferLayout, TextureFormat, TextureUsages,
};
use bevy::render::renderer::{RenderContext, RenderDevice, RenderGraph, RenderQueue};
use bevy::render::texture::GpuImage;
use bevy::render::camera::ExtractedCamera;
use bevy::render::view::ViewDepthTexture;
use bevy::render::{Extract, RenderApp, RenderSystems};
use bevy::world_serialization::{WorldAssetRoot, WorldInstance, WorldInstanceSpawner};
use bevy::window::ExitCondition;
use serde_json::json;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

#[path = "gpu_profile.rs"]
mod gpu_profile;
#[path = "gpu_lidar.rs"]
mod gpu_lidar;
#[path = "shared_shadows.rs"]
mod shared_shadows;
#[path = "aux_material.rs"]
mod aux_material;
#[path = "video.rs"]
mod video;
use video::VideoSink;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

#[derive(clap::Parser, Debug, Clone, bevy::prelude::Resource)]
pub struct CaptureArgs {
    /// qualification/render-qualification-program.v1.json (prontoRig source).
    #[arg(long)]
    pub rig_program: String,
    /// Corpus GLB files (absolute paths), comma-separated.
    #[arg(long, value_delimiter = ',', required = true)]
    pub glbs: Vec<String>,
    /// scene-state.v1 JSON file (optional: absent = ego at origin, no actors).
    #[arg(long)]
    pub scene_state: Option<String>,
    /// Map xodr for GNSS georeference.
    #[arg(long)]
    pub xodr: Option<String>,
    /// First scene-state tick index to capture (default 0).
    #[arg(long, default_value_t = 0)]
    pub tick: u32,
    /// Number of ticks to capture in this process. One process loads the map
    /// once and captures every tick, which is the difference between paying
    /// the ~10-minute bring-up per tick and paying it per clip.
    #[arg(long, default_value_t = 1)]
    pub tick_count: u32,
    /// Stride between captured ticks in the scene-state document.
    #[arg(long, default_value_t = 1)]
    pub tick_stride: u32,
    #[arg(long, default_value_t = 736)]
    pub width: u32,
    #[arg(long, default_value_t = 416)]
    pub height: u32,
    #[arg(long, default_value_t = 20)]
    pub warmup: u32,
    /// App ticks of stable mesh-entity count required before the instance
    /// registry is frozen. The registry must see the complete scene or
    /// instance ids are nondeterministic; this is the settle margin.
    #[arg(long, default_value_t = 500)]
    pub settle_ticks: u64,
    /// Sensor subset: comma-separated sensor ids, or a named preset.
    ///
    /// `parity-front` is the two-source rig CARLA is measured with (the forward
    /// measurement camera plus the chase view), so the two engines can be timed
    /// on the same workload. `cameras` keeps every camera and drops the
    /// raycast sensors. Empty means the whole rig.
    #[arg(long, value_delimiter = ',')]
    pub sensors: Vec<String>,
    /// RGB artifact codec. `jpeg` is ~10x smaller and ~5x cheaper to encode
    /// than PNG; instance and semantic passes are never lossy, whatever this
    /// says, because their pixels are ids rather than colours.
    #[arg(long, default_value = "png")]
    pub rgb_format: String,
    /// JPEG quality when `--rgb-format jpeg`.
    #[arg(long, default_value_t = 92)]
    pub jpeg_quality: u8,
    /// Depth artifact format: `f32` (raw, 4 bytes/px) or `f16` (half, 2
    /// bytes/px). Reverse-Z depth in [0,1] keeps ~3 decimal digits in f16,
    /// which is 1 cm at 10 m and 1 m at 300 m.
    #[arg(long, default_value = "f32")]
    pub depth_format: String,
    /// Lidar/radar artifact encoding: `ascii` (CARLA-parity text) or `binary`
    /// (little-endian PLY / packed f32 rows).
    #[arg(long, default_value = "ascii")]
    pub point_format: String,
    /// Stream RGB directly to final MP4 containers instead of per-frame files.
    #[arg(long)]
    pub video: bool,
    /// x264 pins thread/GOP settings; NVENC is an explicit hardware-encoder option.
    #[arg(long, default_value = "x264", value_parser = ["x264", "nvenc"])]
    pub video_encoder: String,
    #[arg(long, default_value_t = 18)]
    pub video_crf: u32,
    #[arg(long, default_value_t = 50.0)]
    pub video_fps: f64,
    /// Only RGB products for selected cameras (no depth or ID view).
    #[arg(long)]
    pub rgb_only: bool,
    /// Emit device timestamp timings per view, shadows and readback transfer.
    #[arg(long)]
    pub profile_gpu: bool,
    /// Disable directional shadows for a quality/performance ablation.
    #[arg(long)]
    pub no_shadows: bool,
    /// Directional shadow cascade count.
    #[arg(long, default_value_t = 4)]
    pub shadow_cascades: usize,
    /// CPU reference or hardware ray-query lidar. GPU is not numerically
    /// equivalent: rare first-hit range outliers and instance ownership changes
    /// were measured. Use --verify-gpu-lidar to compare every beam; CPU is default.
    #[arg(long, default_value = "cpu", value_parser = ["cpu", "gpu"])]
    pub lidar_backend: String,
    /// Compare every GPU beam with the CPU reference; expensive, not a timing mode.
    #[arg(long)]
    pub verify_gpu_lidar: bool,
    /// Share directional shadows across the union of camera frusta; lower texel density.
    #[arg(long)]
    pub shared_shadows: bool,
    /// Batch ID clones with a single material and per-instance tags.
    #[arg(long)]
    pub batch_ids: bool,
    /// Opt into GPU indirect draw compaction/clustering. Faster, but coplanar
    /// instance ownership can vary between processes; strict draws are default.
    #[arg(long)]
    pub fast_gpu: bool,
    /// Output directory.
    #[arg(long)]
    pub out: String,
}

// ---------------------------------------------------------------------------
// Main world <-> render world readback plumbing (spike pattern, generalized)
// ---------------------------------------------------------------------------

struct SentPass {
    key: String,
    frame: u64,
    data: Vec<u8>,
}

#[derive(Resource, Deref)]
struct MainReceiver(crossbeam_channel::Receiver<SentPass>);
#[derive(Resource, Deref)]
struct RenderSender(crossbeam_channel::Sender<SentPass>);

#[derive(Component, Clone)]
struct ImageCopier {
    buffer: Buffer,
    src_image: Handle<Image>,
    key: String,
}

#[derive(Component, Clone)]
struct DepthCopier {
    buffer: Buffer,
    src_image: Handle<Image>,
    key: String,
}

#[derive(Resource, Default)]
struct Copiers(Vec<ImageCopier>);
#[derive(Resource, Default)]
struct DepthCopiers(Vec<DepthCopier>);
#[derive(Resource, Default, Clone, Copy)]
struct GlobalFrame(u64);
/// Unconditional per-Update counter used for bring-up timing.
#[derive(Resource, Default, Clone, Copy)]
struct AppTick(u64);
#[derive(Resource, Default, Clone, Copy)]
struct FrameStamp(u64);

/// Frames whose readback is wanted. Copying ~28 render targets out of VRAM and
/// into host `Vec`s costs real milliseconds, and bring-up plus warmup frames
/// have nothing worth reading, so the copy is armed per frame instead of
/// running unconditionally.
#[derive(Resource, Default, Clone)]
struct ArmedFrames(Vec<u64>);

#[derive(Resource, Default)]
struct CaptureFence(Option<wgpu::SubmissionIndex>);

/// Per-stage profile clock. Every stage of bring-up and every per-tick stage
/// prints one `PROF` line, so a run is attributable without a profiler.
#[derive(Resource)]
struct Prof {
    process_start: Instant,
    stage_start: Instant,
}

impl Prof {
    fn new() -> Self {
        let now = Instant::now();
        Self { process_start: now, stage_start: now }
    }

    /// Close the current stage and open the next one.
    fn stage(&mut self, name: &str) {
        let now = Instant::now();
        println!(
            "PROF stage={name} seconds={:.3} sinceStart={:.3}",
            now.duration_since(self.stage_start).as_secs_f64(),
            now.duration_since(self.process_start).as_secs_f64(),
        );
        self.stage_start = now;
    }

    fn since_start(&self) -> f64 {
        self.process_start.elapsed().as_secs_f64()
    }
}

/// A camera pass that must follow the ego each tick.
#[derive(Component, Clone)]
struct SensorCam {
    mount: Mount,
}

/// Maps an actor cuboid back to its scene-state actor id so ticks can move it.
#[derive(Component)]
struct ActorBoxOf(String);

/// A tick whose cameras have been posed and whose GPU frame is in flight.
struct InFlight {
    frame: u64,
    /// Index into `SceneSequence::ticks`.
    sequence_index: usize,
    /// Scene-state tick number, used for output file names.
    tick: u32,
    /// This tick's lidar/radar work, running while the GPU renders its
    /// cameras. Joined when the tick's camera passes are written.
    cpu_sensors: Option<bevy::tasks::Task<CpuSensorTiming>>,
}

/// Capture cursor across the batched ticks.
#[derive(Resource, Default)]
struct CaptureProgress {
    /// Next sequence index to pose.
    next: usize,
    /// Ticks posed and awaiting their readback.
    in_flight: Vec<InFlight>,
    /// Ticks fully written.
    written: usize,
    /// Wall clock of the first armed frame, for the steady-state rate.
    first_armed: Option<Instant>,
    /// Ticks this process will capture: the parsed sequence length, which a
    /// single-tick stream input caps at 1 regardless of `--tick-count`.
    planned: usize,
}

fn setup_target_image(images: &mut Assets<Image>, w: u32, h: u32, format: TextureFormat) -> Handle<Image> {
    let mut img = Image::new_target_texture(w, h, format, None);
    img.texture_descriptor.usage |= TextureUsages::COPY_SRC;
    images.add(img)
}

fn make_buffer(device: &RenderDevice, size_bytes: usize) -> Buffer {
    device.create_buffer(&BufferDescriptor {
        label: Some("sensor-readback"),
        size: size_bytes as u64,
        usage: BufferUsages::MAP_READ | BufferUsages::COPY_DST,
        mapped_at_creation: false,
    })
}

fn aligned_row(width: usize, pixel_size: usize) -> usize {
    RenderDevice::align_copy_bytes_per_row(width * pixel_size)
}

// ---------------------------------------------------------------------------
// Harness state
// ---------------------------------------------------------------------------

#[derive(Component)]
struct TileLoad(Handle<Gltf>);
#[derive(Component)]
struct SceneSpawned;
#[derive(Component)]
struct IdClone;
#[derive(Component)]
struct ActorBox;
/// The layer-1 aux clone that mirrors an actor cuboid, so it can be re-posed
/// with its source each tick.
#[derive(Component)]
struct ActorIdClone(Entity);


#[derive(Resource)]
struct HarnessState {
    total_glbs: u32,
    /// Actor cuboids spawned (once).
    boxes_spawned: bool,
    /// App tick at which the tile scene became ready.
    ready_tick: Option<u64>,
    /// Mesh-entity count observed on the previous tick.
    last_mesh_count: Option<usize>,
    /// Tick of the last count change (settle detection).
    last_change_tick: Option<u64>,
    build_ready_at: Option<Instant>,
    clones_done: bool,
    sensors_spawned: bool,
    gpu_idle_frames: u32,
    gpu_ready: bool,
    /// Every batched tick has been written; the app may exit.
    finished: bool,
    /// Deterministic instance registry: sorted (name, entity-bits) -> id.
    instance_names: Vec<(u32, String)>,
    instance_classes: Vec<(u32, u8)>,
    /// entity -> instance id for triangle extraction.
    entity_ids: HashMap<Entity, u32>,
}

fn mount_world_transform(ego: Transform, m: &Mount) -> Transform {
    let rot_ego = ego.rotation;
    let pos = ego.translation + rot_ego.mul_vec3(Vec3::new(m.x, m.y, m.z));
    // CARLA lowering maps (x,y,z) to (x,z,y), passing source yaw through:
    // positive yaw aims +X toward +Z. Pitch is +Z (nose up), roll is +X.
    let rot = rot_ego * Quat::from_euler(EulerRot::YZX, -m.yaw, m.pitch, m.roll);
    Transform { translation: pos, rotation: rot, scale: Vec3::ONE }
}

fn mount_camera_transform(ego: Transform, mount: &Mount) -> Transform {
    let mut transform = mount_world_transform(ego, mount);
    // Bevy's optical axis is -Z; the rig's optical/beam axis is +X.
    transform.rotation *= Quat::from_rotation_y(-std::f32::consts::FRAC_PI_2);
    transform
}

#[cfg(test)]
mod mount_tests {
    use super::*;

    #[test]
    fn chase_optical_axis_follows_heading_and_aims_ahead() {
        let ego = Transform::from_xyz(7.0, 2.0, -3.0)
            .with_rotation(Quat::from_rotation_y(0.8));
        let mount = crate::rig::chase_camera(1920, 1080).mount;
        let camera = mount_camera_transform(ego, &mount);
        let forward = *camera.forward();
        let heading = ego.rotation * Vec3::X;
        assert!(Vec3::new(forward.x, 0.0, forward.z).normalize().abs_diff_eq(heading, 1e-5));
        assert!(forward.y < 0.0, "chase must look down, not at the sky");
        let ground_hit = camera.translation + forward * ((ego.translation.y-camera.translation.y)/forward.y);
        assert!(ground_hit.distance(ego.translation + 8.0*heading) < 0.03);
    }

    #[test]
    fn mount_pitch_moves_optical_axis_up_and_roll_keeps_it_forward() {
        let mut mount = Mount { x: 0.0, y: 0.0, z: 0.0, yaw: 0.0, pitch: 30.0f32.to_radians(), roll: 0.0 };
        let pitched = mount_camera_transform(Transform::IDENTITY, &mount);
        assert!((*pitched.forward()).abs_diff_eq(Vec3::new(30.0f32.to_radians().cos(), 0.5, 0.0), 1e-5));
        mount.pitch = 0.0;
        mount.roll = std::f32::consts::FRAC_PI_2;
        let rolled = mount_camera_transform(Transform::IDENTITY, &mount);
        assert!((*rolled.forward()).abs_diff_eq(Vec3::X, 1e-5));
        assert!((*rolled.up()).abs_diff_eq(Vec3::Z, 1e-5));
        mount.roll = 0.0;
        mount.yaw = std::f32::consts::FRAC_PI_2;
        let yawed = mount_camera_transform(Transform::IDENTITY, &mount);
        assert!((*yawed.forward()).abs_diff_eq(Vec3::Z, 1e-5), "source +90 yaw must match CARLA +Y");
    }
}

/// Resolve `--sensors` into the sources to keep, preserving rig order.
///
/// Named presets exist so a cross-engine comparison names one workload rather
/// than pasting ids: `parity-front` is the two sources the CARLA adapter's
/// `parity-front` rig lowers (forward measurement camera + chase view), and
/// `cameras` keeps the imaging rig without the raycast sensors.
fn select_sensors(
    sensors: Vec<crate::rig::RigSensor>,
    selection: &[String],
) -> Result<Vec<crate::rig::RigSensor>> {
    const PARITY_FRONT: [&str; 2] = ["pronto-cam3", crate::rig::CHASE_CAMERA_SENSOR_ID];
    let wants_cameras_only = selection.iter().any(|s| s == "cameras");
    let mut wanted: Vec<String> = Vec::new();
    for name in selection {
        match name.as_str() {
            "cameras" => {}
            "parity-front" => wanted.extend(PARITY_FRONT.iter().map(|s| s.to_string())),
            id => wanted.push(id.to_string()),
        }
    }
    let kept: Vec<crate::rig::RigSensor> = sensors
        .into_iter()
        .filter(|s| {
            if wants_cameras_only && s.kind != SensorKind::Camera {
                return false;
            }
            wanted.is_empty() || wanted.iter().any(|id| id == &s.id)
        })
        .collect();
    let missing: Vec<&String> = wanted
        .iter()
        .filter(|id| !kept.iter().any(|s| &s.id == *id))
        .collect();
    if !missing.is_empty() {
        bail!("--sensors named sources the rig does not contain: {missing:?}");
    }
    if kept.is_empty() {
        bail!("--sensors selected no sources");
    }
    Ok(kept)
}

pub fn run_capture(args: CaptureArgs) -> Result<()> {

    if args.glbs.iter().any(|g| !Path::new(g).is_absolute()) {
        bail!("glb paths must be absolute");
    }
    std::env::set_var("BEVY_ASSET_ROOT", render_core::platform::ASSET_ROOT);
    let rig_text = std::fs::read_to_string(&args.rig_program)
        .with_context(|| format!("read {}", args.rig_program))?;
    let mut rig: RigSpec = crate::rig::parse_pronto_rig(&rig_text, args.width, args.height)?;
    if !args.sensors.is_empty() {
        let before = rig.sensors.len();
        rig.sensors = select_sensors(rig.sensors, &args.sensors)?;
        println!(
            "SUBSET {:?} kept {} of {} sources",
            args.sensors,
            rig.sensors.len(),
            before
        );
    }
    let n_cams = rig.cameras().count();
    println!("RIG {} cameras={} lidars={} radars={} (+chase)",
        rig.rig_id, n_cams, rig.lidars().count(), rig.radars().count());

    let sequence: Option<crate::scene_state::SceneSequence> = match &args.scene_state {
        Some(p) => Some(
            crate::scene_state::SceneSequence::from_json(
                &std::fs::read_to_string(p)?,
                args.tick,
                args.tick_count,
                args.tick_stride,
            )
            .with_context(|| format!("parse {}", p))?,
        ),
        None => None,
    };
    let planned_ticks = sequence.as_ref().map(|s| s.ticks.len()).unwrap_or(1);
    println!(
        "BATCH ticks={planned_ticks} start={} stride={}",
        args.tick, args.tick_stride
    );

    // Georeference for GNSS.
    let tmerc: Option<TmercOrigin> = args.xodr.as_ref().and_then(|p| {
        let text = std::fs::read_to_string(p).ok()?;
        let start = text.find("<geoReference><![CDATA[")? + "<geoReference><![CDATA[".len();
        let end = text[start..].find("]]></geoReference>")? + start;
        TmercOrigin::parse(&text[start..end])
    });

    let out_dir = PathBuf::from(&args.out);
    std::fs::create_dir_all(&out_dir)?;

    let (tx, rx) = crossbeam_channel::unbounded::<SentPass>();

    let mut app = App::new();
    app.insert_resource(ClearColor(Color::srgb(0.53, 0.74, 0.92)))
        .add_plugins((
            DefaultPlugins
                .set(render_core::platform::asset_plugin())
                .set(WindowPlugin { primary_window: None, exit_condition: ExitCondition::DontExit, ..default() })
                // Pipeline compilation stays synchronous so no task can outlive the
                // wgpu device during teardown.
                .set(render_core::platform::render_plugin(true))
                .disable::<bevy::winit::WinitPlugin>()
                .disable::<bevy::audio::AudioPlugin>()
                .set(LogPlugin {
                    filter: "warn,wgpu_core=warn,wgpu_hal=warn,naga=warn".into(),
                    ..default()
                }),
            ScheduleRunnerPlugin::run_loop(Duration::ZERO),
        ))
        .insert_resource(GlobalAmbientLight {
            color: Color::srgb(1.0, 0.98, 0.94),
            brightness: 0.6,
            affects_lightmapped_meshes: true,
        })
        .insert_resource(DirectionalLightShadowMap { size: 2048 })
        .insert_resource(MainReceiver(rx))
        .insert_resource(args.clone())
        .insert_resource(rig)
        .insert_resource(HarnessState {
            total_glbs: args.glbs.len() as u32,
            build_ready_at: None,
            clones_done: false,
            sensors_spawned: false,
            gpu_idle_frames: 0,
            gpu_ready: false,
            finished: false,
            boxes_spawned: false,
            ready_tick: None,
            last_mesh_count: None,
            last_change_tick: None,
            instance_names: Vec::new(),
            instance_classes: Vec::new(),
            entity_ids: HashMap::new(),
        })
        .init_resource::<GlobalFrame>()
        .init_resource::<AppTick>()
        .insert_resource(CaptureProgress { planned: planned_ticks, ..default() })
        .insert_resource(Prof::new())
        .insert_resource(HarnessSetup::default())
        .add_systems(Startup, startup_setup)
        .add_systems(
            Update,
            (
                check_assets,
                poll_roots,
                bump_tick,
                build_tile_bvh,
                spawn_actor_boxes,
                build_id_and_semantic_passes,
                spawn_sensors,
                tick_frames,
                pose_next_tick,
            )
                .chain(),
        )
        .add_systems(PreUpdate, collect_passes)
        .add_plugins(render_core::readiness::GpuReadinessPlugin);
    aux_material::install(&mut app);
    if args.shared_shadows {
        shared_shadows::install(&mut app);
    }

    if let Some(sequence) = sequence {
        // The first tick doubles as the bring-up scene state (actor cuboids,
        // ground snapping, instance registry).
        app.insert_resource(sequence.ticks[0].clone());
        app.insert_resource(sequence);
    }
    if let Some(tm) = tmerc {
        app.insert_resource(tm);
    }

    app.insert_resource(VideoSink::new(n_cams, planned_ticks));
    let render_app = app.get_sub_app_mut(RenderApp).unwrap();
    render_app
        .insert_resource(RenderSender(tx))
        .init_resource::<Copiers>()
        .init_resource::<DepthCopiers>()
        .init_resource::<FrameStamp>()
        .init_resource::<ArmedFrames>()
        .init_resource::<CaptureFence>()
        .add_systems(ExtractSchedule, (extract_copiers, extract_frame, extract_armed))
        .add_systems(RenderGraph, copy_passes.after(bevy::render::renderer::RenderGraphSystems::Submit))
        .add_systems(bevy::render::Render, receive_passes.after(RenderSystems::Render));
    if args.profile_gpu {
        gpu_profile::install(&mut app);
    }

    app.run();

    let manifest_start = Instant::now();
    let files = write_manifest(&out_dir)?;
    println!(
        "PROF stage=manifest seconds={:.3} files={files}",
        manifest_start.elapsed().as_secs_f64()
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

/// Transient setup state consumed during scene bring-up.
#[derive(Resource, Default)]
struct HarnessSetup {
    /// Set once the full raycast BVH (with instance ids) is built.
    sensor_scene_ready: bool,
    /// Set after the tiles-only BVH phase used for ground snapping.
    tile_bvh_done: bool,
}

fn sun_direction(elev_deg: f32, azim_deg: f32) -> Dir3 {
    let elev = elev_deg.to_radians();
    let azim = azim_deg.to_radians();
    let dir = Vec3::new(-(elev.cos() * azim.sin()), -elev.sin(), -(elev.cos() * azim.cos()));
    Dir3::new(dir.normalize()).unwrap()
}

fn startup_setup(mut commands: Commands, args: Res<CaptureArgs>, server: Res<AssetServer>,
    mut clusters: ResMut<bevy::light::cluster::GlobalClusterSettings>) {
    if !args.fast_gpu {
        clusters.gpu_clustering = None;
    }
    commands.spawn((
        DirectionalLight { illuminance: 28_000.0, shadow_maps_enabled: !args.no_shadows, ..default() },
        CascadeShadowConfigBuilder {
            minimum_distance: 1.0,
            maximum_distance: 400.0,
            num_cascades: args.shadow_cascades,
            ..default()
        }
        .build(),
        Transform::IDENTITY.looking_to(sun_direction(60.0, 190.0), Vec3::Y),
    ));
    for g in &args.glbs {
        let path = render_core::platform::asset_path(Path::new(g))
            .unwrap_or_else(|err| panic!("capture tile {err:#}"));
        let handle: Handle<Gltf> = server.load(path);
        commands.spawn(TileLoad(handle));
    }
}

// ---------------------------------------------------------------------------
// Scene bring-up: tiles, actors, ID/semantic clones, raycast BVH
// ---------------------------------------------------------------------------

fn check_assets(mut commands: Commands, gltfs: Res<Assets<Gltf>>, loads: Query<(Entity, &TileLoad), Without<SceneSpawned>>) {
    for (e, tile) in &loads {
        let Some(gltf) = gltfs.get(&tile.0) else { continue };
        let Some(scene) = gltf.default_scene.clone() else {
            panic!("GLB without default scene");
        };
        commands.entity(e).insert(SceneSpawned);
        commands.spawn((WorldAssetRoot(scene),));
    }
}

/// Spawn interim actor cuboids (before ID assignment so they join the same
/// legend space), snapped onto the static ground via a downward raycast
/// (traces carry no ground height).
///
/// One cuboid is spawned per actor appearing anywhere in the batched tick
/// range, not just in the first tick: the instance registry is frozen once,
/// so an actor that enters the scene later must already own an id or the
/// legend would change mid-clip. Actors absent from a tick are hidden by
/// `pose_next_tick`.
#[allow(clippy::too_many_arguments)]
fn spawn_actor_boxes(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    sequence: Option<Res<crate::scene_state::SceneSequence>>,
    sensor_scene: Option<Res<SensorScene>>,
    mut state: ResMut<HarnessState>,
) {
    let Some(sensor_scene) = sensor_scene else { return };
    if state.boxes_spawned || !setup_ready_for_boxes(&state) || sequence.is_none() {
        return;
    }
    state.boxes_spawned = true;
    let sequence = sequence.unwrap();

    // The rig host gets no cuboid: the sensors are mounted on it, and a box
    // around them would occlude every scan.
    let ego_id = sequence.ticks[0].ego().map(|a| a.id.clone()).unwrap_or_default();
    // First appearance wins for dims and initial pose; ids stay in first-seen
    // order so the registry sort below is fed a stable set.
    let mut seen: Vec<&crate::scene_state::ActorState> = Vec::new();
    for tick in &sequence.ticks {
        for a in &tick.actors {
            if a.id == ego_id || a.kind == "despawn" {
                continue;
            }
            if !seen.iter().any(|s| s.id == a.id) {
                seen.push(a);
            }
        }
    }

    for a in seen {
        let (l, w, h) = actor_dims(a);
        let pos = Vec3::from_slice(&a.transform.position);
        let quat = Quat::from_xyzw(
            a.transform.rotation[0],
            a.transform.rotation[1],
            a.transform.rotation[2],
            a.transform.rotation[3],
        );
        let ground = ground_y(&sensor_scene.scene, pos);
        commands.spawn((
            ActorBox,
            ActorBoxOf(a.id.clone()),
            Name::new(format!("actor:{}", a.id)),
            Mesh3d(meshes.add(Cuboid::new(w, h, l))),
            MeshMaterial3d(materials.add(StandardMaterial {
                base_color: Color::srgb(0.85, 0.85, 0.88),
                ..default()
            })),
            Transform {
                translation: Vec3::new(pos.x, ground + h * 0.5, pos.z),
                rotation: quat,
                scale: Vec3::ONE,
            },
            RenderLayers::layer(0),
        ));
    }
    println!("ACTORS spawned={} (union over batched ticks)", sequence.ticks.iter().map(|t| t.actors.len()).max().unwrap_or(0));
}

/// Ground height under (x, z): downward raycast from high above; falls back
/// to 0 when nothing is hit.
pub fn ground_y(scene: &InstancedScene, pos: Vec3) -> f32 {
    scene
        .cast(Vec3::new(pos.x, 500.0, pos.z), Vec3::NEG_Y, 1000.0)
        .map(|h| h.point.y)
        .unwrap_or(0.0)
}

fn setup_ready_for_boxes(state: &HarnessState) -> bool {
    state.build_ready_at.is_some() && state.ready_tick.is_some()
}

/// Catalog dims lookup is WSB2 territory; until then dims come from the
/// scene-state catalogId convention `vehicle.*`/`walker.*` with sane defaults.
fn actor_dims(a: &crate::scene_state::ActorState) -> (f32, f32, f32) {
    match a.actor_class.as_deref().unwrap_or("prop") {
        "car" => (4.8, 1.9, 1.5),
        "truck" => (8.0, 2.5, 3.2),
        "pedestrian" => (0.6, 0.6, 1.75),
        "cyclist" => (1.7, 0.6, 1.7),
        _ => (1.0, 1.0, 1.0),
    }
}

fn poll_roots(
    roots: Query<&WorldInstance>,
    spawner: Option<Res<WorldInstanceSpawner>>,
    mut state: ResMut<HarnessState>,
    mut prof: ResMut<Prof>,
) {
    let Some(spawner) = spawner else { return };
    if state.build_ready_at.is_some() {
        return;
    }
    if roots.iter().count() < state.total_glbs as usize {
        return;
    }
    if roots.iter().all(|wi| spawner.instance_is_ready(**wi)) {
        state.build_ready_at = Some(Instant::now());
        state.last_mesh_count = None;
        prof.stage("assets_loaded");
    }
}

/// Phase 1: BVH over static tile geometry only (no instance ids yet) so the
/// actor boxes and the ego can be ground-snapped in the next systems.
fn build_tile_bvh(
    mut commands: Commands,
    meshes: Res<Assets<Mesh>>,
    meshes_q: Query<(Entity, &Mesh3d, Option<&GlobalTransform>), Without<ActorBox>>,
    state: Res<HarnessState>,
    mut setup: ResMut<HarnessSetup>,
    mut prof: ResMut<Prof>,
) {
    if setup.tile_bvh_done || state.build_ready_at.is_none() {
        return;
    }
    let mut scene = InstancedScene::new();
    let mut mesh_cache = HashMap::new();
    for (_e, mesh3d, gt) in &meshes_q {
        push_mesh_instance(mesh3d, gt, &meshes, &mut scene, &mut mesh_cache, 0);
    }
    scene.build();
    println!("BVH tiles: {} triangles", scene.tri_count());
    commands.insert_resource(SensorScene {
        scene: std::sync::Arc::new(scene),
        actors: RaycastScene::new(),
        classes: HashMap::new(),
        gpu_lidar: None,
    });
    setup.tile_bvh_done = true;
    prof.stage("tile_bvh");
}

/// Phase 2: assign deterministic instance IDs across static tiles + actor
/// boxes, clone meshes into the ID (layer 1) and semantic (layer 2) passes,
/// and rebuild the raycast BVH with real instance ids.
fn build_id_and_semantic_passes(
    mut commands: Commands,
    tick: Res<AppTick>,
    args: Res<CaptureArgs>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    mut aux_materials: ResMut<Assets<aux_material::AuxMaterial>>,
    meshes: Res<Assets<Mesh>>,
    scene_state: Option<Res<crate::scene_state::SceneState>>,
    sensor_scene: Option<ResMut<SensorScene>>,
    meshes_q: Query<
        (
            Entity,
            &Mesh3d,
            Option<&Name>,
            Option<&ChildOf>,
            Option<&GlobalTransform>,
            Option<&Transform>,
            Has<ActorBox>,
        ),
        (Without<IdClone>, Without<WorldAssetRoot>),
    >,
    mut state: ResMut<HarnessState>,
    mut setup: ResMut<HarnessSetup>,
    mut prof: ResMut<Prof>,
    gpu: (Res<RenderDevice>, Res<RenderQueue>),
) {
    let Some(mut sensor_scene) = sensor_scene else { return };
    if state.clones_done || !setup.tile_bvh_done || state.ready_tick.is_none() {
        return;
    }
    // Let hierarchy spawning and transform propagation settle: require a few
    // ticks past readiness AND a stable mesh-entity count, otherwise the
    // instance registry captures a partial scene (nondeterministic).
    if tick.0 < state.ready_tick.unwrap_or(0) + 3 {
        return;
    }
    // The GLTF spawner streams node entities in over many ticks; wait until
    // the mesh-entity count has been stable for a while. The final registry
    // is the complete scene regardless of when we proceed, so this only
    // affects latency, not determinism.
    let count = meshes_q.iter().count();
    if state.last_mesh_count != Some(count) {
        state.last_mesh_count = Some(count);
        state.last_change_tick = Some(tick.0);
        return;
    }
    if tick.0 < state.last_change_tick.unwrap_or(tick.0) + args.settle_ticks {
        return;
    }
    println!("IDPASS scene settled: {count} mesh entities at tick {}", tick.0);

    // ---- deterministic instance registry ----
    // Sort key: name, then world-space AABB-center bits derived from actual
    // geometry. ECS entity ids differ across processes and must never enter
    // the ordering; duplicate mesh names (instanced geometry) disambiguate by
    // position.
    let mut entries: Vec<(String, [u32; 3], Entity)> = Vec::new();
    for (e, mesh3d, name, _child_of, gt, _local, _is_actor) in &meshes_q {
        let name = name.map(|n| n.to_string()).unwrap_or_else(|| format!("unnamed_mesh_{e}"));
        let key = meshes.get(&mesh3d.0)
            .map(|mesh| {
                let mut acc = Vec3::ZERO;
                let mut n = 0u32;
                collect_tri_centroids(mesh, gt, |c| {
                    acc += c;
                    n += 1;
                });
                if n > 0 {
                    let c = acc / n as f32;
                    [c.x.to_bits(), c.y.to_bits(), c.z.to_bits()]
                } else {
                    [0, 0, 0]
                }
            })
            .unwrap_or([0, 0, 0]);
        entries.push((name, key, e));
    }
    entries.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));

    let mut entity_ids: HashMap<Entity, u32> = HashMap::with_capacity(entries.len());
    let mut instance_names: Vec<(u32, String)> = Vec::with_capacity(entries.len());
    let mut instance_classes: Vec<(u32, u8)> = Vec::with_capacity(entries.len());
    for (i, (name, _, e)) in entries.into_iter().enumerate() {
        let id = (i + 1) as u32;
        entity_ids.insert(e, id);
        instance_names.push((id, name.clone()));
        let class = if let Some(actor) = name.strip_prefix("actor:") {
            actor_class_of(scene_state.as_deref(), actor)
        } else {
            SemanticClass::from_mesh_name(&name)
        };
        instance_classes.push((id, class.id()));
    }
    state.entity_ids = entity_ids;

    // ---- clones + static BVH ----
    // Actor cuboids are deliberately NOT part of this BVH: they move every
    // tick, and rebuilding a 300k-triangle tree per tick would dwarf the
    // sensing itself. They go into `SensorScene::actors`, a tiny tree rebuilt
    // per tick, and the two are composed for casts.
    let mut legend_instances: Vec<(u32, String)> = Vec::new();
    let mut legend_classes: Vec<(u32, u8)> = Vec::new();
    let mut ray_scene = InstancedScene::new();
    let mut mesh_cache = HashMap::new();
    let shared_aux = (args.batch_ids && !args.rgb_only).then(|| aux_materials.add(aux_material::AuxMaterial::default()));

    let mut ordered_meshes: Vec<_> = meshes_q.iter().collect();
    ordered_meshes.sort_unstable_by_key(|row| state.entity_ids.get(&row.0).copied().unwrap_or(0));
    for (e, mesh3d, name, child_of, gt, local, is_actor) in ordered_meshes {
        let Some(&id) = state.entity_ids.get(&e) else { continue };
        let name_s = name.map(|n| n.to_string()).unwrap_or_else(|| format!("unnamed_mesh_{e}"));
        let class = SemanticClass::ALL
            .iter()
            .copied()
            .find(|c| c.id() == instance_class_lookup(&instance_classes, id))
            .unwrap_or(SemanticClass::Prop);

        if !args.rgb_only {
            let mut cmd = commands.spawn((
                IdClone, Mesh3d(mesh3d.0.clone()), RenderLayers::layer(1),
                bevy::mesh::MeshTag((id & 0xffff) | (u32::from(class.id()) << 16)),
            ));
            if let Some(material) = &shared_aux {
                cmd.insert(MeshMaterial3d(material.clone()));
            } else {
                let bytes = id.to_le_bytes();
                cmd.insert(MeshMaterial3d(materials.add(StandardMaterial {
                    base_color: Color::srgb_u8(bytes[0], bytes[1], class.id()),
                    unlit: true,
                    ..default()
                })));
            }
            // Clones share their source parent's local transform.
            cmd.insert(local.copied().unwrap_or(Transform::IDENTITY));
            if let Some(p) = child_of.map(|c| c.parent()) {
                cmd.insert(ChildOf(p));
            }
            if is_actor {
                cmd.insert(ActorIdClone(e));
            }
        }

        legend_instances.push((id, name_s.clone()));
        legend_classes.push((id, class.id()));

        // Triangle soup for lidar/radar: statics only.
        if !is_actor {
            push_mesh_instance(mesh3d, gt, &meshes, &mut ray_scene, &mut mesh_cache, id);
        }
    }
    ray_scene.build();
    println!("BVH static: {} triangles", ray_scene.tri_count());

    // Legend must be byte-stable across processes: ECS iteration order is not.
    legend_instances.sort_by_key(|(id, _)| *id);
    legend_classes.sort_by_key(|(id, _)| *id);
    state.instance_names = legend_instances;
    state.instance_classes = legend_classes;
    let gpu_lidar = (args.lidar_backend == "gpu").then(|| {
        std::sync::Arc::new(gpu_lidar::GpuLidar::new(&ray_scene, gpu.0.clone(), gpu.1.clone(), args.profile_gpu))
    });
    *sensor_scene = SensorScene {
        scene: std::sync::Arc::new(ray_scene),
        actors: RaycastScene::new(),
        classes: state.instance_classes.iter().cloned().collect(),
        gpu_lidar,
    };
    setup.sensor_scene_ready = true;
    state.clones_done = true;
    prof.stage("id_pass");
}

/// Visit the world-space centroid of every triangle of `mesh`.
fn collect_tri_centroids(mesh: &bevy::mesh::Mesh, gt: Option<&GlobalTransform>, mut f: impl FnMut(Vec3)) {
    let Some(pos_attr) = mesh.attribute(bevy::mesh::Mesh::ATTRIBUTE_POSITION) else { return };
    let world = gt.map(|g| g.to_matrix()).unwrap_or(Mat4::IDENTITY);
    let positions: Vec<Vec3> = match pos_attr {
        bevy::mesh::VertexAttributeValues::Float32x3(v) => v.iter().map(|p| Vec3::from(*p)).collect(),
        _ => return,
    };
    match mesh.indices() {
        Some(bevy::mesh::Indices::U32(idx)) => {
            for t in idx.chunks_exact(3) {
                f(world.transform_point3(
                    (positions[t[0] as usize] + positions[t[1] as usize] + positions[t[2] as usize]) / 3.0,
                ));
            }
        }
        Some(bevy::mesh::Indices::U16(idx)) => {
            for t in idx.chunks_exact(3) {
                f(world.transform_point3(
                    (positions[t[0] as usize] + positions[t[1] as usize] + positions[t[2] as usize]) / 3.0,
                ));
            }
        }
        _ => {
            for t in positions.chunks_exact(3) {
                f(world.transform_point3((t[0] + t[1] + t[2]) / 3.0));
            }
        }
    }
}

fn instance_class_lookup(classes: &[(u32, u8)], id: u32) -> u8 {
    classes
        .iter()
        .find(|(i, _)| *i == id)
        .map(|(_, c)| *c)
        .unwrap_or(0)
}

fn actor_class_of(ss: Option<&crate::scene_state::SceneState>, actor_id: &str) -> SemanticClass {
    ss.and_then(|s| s.actors.iter().find(|a| a.id == actor_id))
        .and_then(|a| a.actor_class.as_deref())
        .map(SemanticClass::from_actor_class)
        .unwrap_or(SemanticClass::Prop)
}
#[derive(Resource)]
pub struct SensorScene {
    /// Immutable world geometry with instance ids: built once.
    ///
    /// Shared behind an `Arc` so a tick's raycasting can run as a task
    /// alongside the GPU passes without copying a tree that is measured in
    /// gigabytes.
    pub scene: std::sync::Arc<InstancedScene>,
    /// Actor cuboids at the tick being sensed: rebuilt per tick and composed
    /// with `scene` for casts.
    pub actors: RaycastScene,
    /// instance id -> semantic class byte.
    pub classes: HashMap<u32, u8>,
    gpu_lidar: Option<std::sync::Arc<gpu_lidar::GpuLidar>>,
}

fn push_mesh_instance(
    mesh3d: &Mesh3d,
    gt: Option<&GlobalTransform>,
    meshes: &Assets<Mesh>,
    scene: &mut InstancedScene,
    cache: &mut HashMap<AssetId<Mesh>, usize>,
    id: u32,
) {
    let Some(mesh) = meshes.get(&mesh3d.0) else { return };
    let index = *cache.entry(mesh3d.0.id()).or_insert_with(|| {
        let mut local = RaycastScene::new();
        push_mesh_triangles_matrix(mesh, Mat4::IDENTITY, &mut local, 0);
        scene.add_mesh(local)
    });
    scene.add_instance(index, gt.map(GlobalTransform::to_matrix).unwrap_or(Mat4::IDENTITY), id);
}

/// Push `mesh`'s triangles into `out`, transformed by `world`, all tagged with
/// instance `id`.
fn push_mesh_triangles_matrix(
    mesh: &bevy::mesh::Mesh,
    world: Mat4,
    out: &mut RaycastScene,
    id: u32,
) {
    let Some(pos_attr) = mesh.attribute(bevy::mesh::Mesh::ATTRIBUTE_POSITION) else { return };
    let positions: Vec<Vec3> = match pos_attr {
        bevy::mesh::VertexAttributeValues::Float32x3(v) => v.iter().map(|p| Vec3::from(*p)).collect(),
        _ => return,
    };
    let mut push = |a: Vec3, b: Vec3, c: Vec3| {
        let a = world.transform_point3(a);
        let b = world.transform_point3(b);
        let c = world.transform_point3(c);
        out.push_tri(Tri { a, b, c, instance_id: id });
    };
    match mesh.indices() {
        Some(bevy::mesh::Indices::U32(idx)) => {
            for tri in idx.chunks_exact(3) {
                push(
                    positions[tri[0] as usize],
                    positions[tri[1] as usize],
                    positions[tri[2] as usize],
                );
            }
        }
        Some(bevy::mesh::Indices::U16(idx)) => {
            for tri in idx.chunks_exact(3) {
                push(
                    positions[tri[0] as usize],
                    positions[tri[1] as usize],
                    positions[tri[2] as usize],
                );
            }
        }
        _ => {
            for tri in positions.chunks_exact(3) {
                push(tri[0], tri[1], tri[2]);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Cameras + sensors
// ---------------------------------------------------------------------------

/// Spawn rig cameras (RGB + depth + instance each) and the chase camera.
#[allow(clippy::too_many_arguments)]
fn spawn_sensors(
    mut commands: Commands,
    args: Res<CaptureArgs>,
    rig: Res<RigSpec>,
    scene_state: Option<Res<crate::scene_state::SceneState>>,
    sensor_scene: Option<Res<SensorScene>>,
    setup: Res<HarnessSetup>,
    mut state: ResMut<HarnessState>,
    mut images: ResMut<Assets<Image>>,
    device: Res<RenderDevice>,
    mut prof: ResMut<Prof>,
) {
    let Some(sensor_scene) = sensor_scene else { return };
    if state.sensors_spawned || !setup.sensor_scene_ready {
        return;
    }
    let mut ego = ego_transform(scene_state.as_deref(), args.tick);
    // Sensors mount relative to the ground plane: drop the ego origin onto
    // the static surface under it.
    ego.translation.y = ground_y(&sensor_scene.scene, ego.translation);
    println!(
        "EGO pose x={} y={} z={} (ground-snapped)",
        ego.translation.x, ego.translation.y, ego.translation.z
    );
    let rgba_buf = aligned_row(args.width as usize, 4) * args.height as usize;
    let mut cam_order: isize = 0;

    let cam_index_of: HashMap<String, usize> =
        rig.cameras().enumerate().map(|(i, s)| (s.id.clone(), i)).collect();

    for sensor in rig.sensors.iter() {
        let tf = mount_camera_transform(ego, &sensor.mount);
        if sensor.kind != SensorKind::Camera {
            continue; // lidar/radar are CPU-side; handled in collect_passes
        }
        let is_chase = sensor.id == crate::rig::CHASE_CAMERA_SENSOR_ID;
        let i = cam_index_of.get(&sensor.id).copied().unwrap_or(rig.cameras().count());
        let vfov = sensor.vertical_fov_deg.unwrap_or(58.0).to_radians();

        // RGB pass (AgX tonemapping, default clear).
        let rgb_image =
            setup_target_image(&mut images, args.width, args.height, TextureFormat::Rgba8UnormSrgb);
        let rgb_handle = rgb_image.clone();
        commands.spawn(ImageCopier {
            buffer: make_buffer(&device, rgba_buf),
            src_image: rgb_image.clone(),
            key: format!("rgb{i}"),
        });
        spawn_camera_entity(
            &mut commands,
            tf,
            vfov,
            0,
            false,
            Tonemapping::AgX,
            cam_order,
            rgb_image.into(),
            None,
            sensor.mount,
            args.fast_gpu,
        );
        cam_order += 1;

        if !is_chase && !args.rgb_only {
            // Raw reverse-Z Depth32Float readback rides the RGB view. The chase
            // camera is a review view, not a measurement: no depth artifact is
            // written for it, so no staging buffer is allocated or mapped.
            commands.spawn(DepthCopier {
                src_image: rgb_handle,
                buffer: make_buffer(&device, rgba_buf),
                key: format!("depth{i}"),
            });

            // Aux pass: instance id in R/G + semantic class in B, unlit on
            // render-layer 1, black clear, neutral exposure.
            spawn_pass_camera(
                &mut commands, &mut images, &device, &args, &format!("inst{i}"), tf, vfov, 1,
                true, Tonemapping::None, cam_order, sensor.mount,
            );
            cam_order += 1;
        }
    }
    state.sensors_spawned = true;
    prof.stage("sensors_spawned");
}

#[allow(clippy::too_many_arguments)]
fn spawn_pass_camera(
    commands: &mut Commands,
    images: &mut Assets<Image>,
    device: &RenderDevice,
    args: &CaptureArgs,
    key: &str,
    transform: Transform,
    vfov_rad: f32,
    layer: u32,
    clear_black: bool,
    tonemap: Tonemapping,
    order: isize,
    mount: Mount,
) {
    let image = setup_target_image(images, args.width, args.height, TextureFormat::Rgba8UnormSrgb);
    let rgba_buf = aligned_row(args.width as usize, 4) * args.height as usize;
    commands.spawn(ImageCopier {
        buffer: make_buffer(device, rgba_buf),
        src_image: image.clone(),
        key: key.to_string(),
    });
    // Unlit ID/semantic colors are absolute values: neutralize the camera's
    // default EV100 exposure (sunlight ≈ 1/39321 would crush them to black).
    let exposure = if clear_black {
        Some(bevy::camera::Exposure { ev100: -1.2f32.log2() }) // multiplier == 1.0
    } else {
        None
    };
    spawn_camera_entity(
        commands, transform, vfov_rad, layer, clear_black, tonemap, order, image.into(), exposure,
        mount, args.fast_gpu,
    );
}

#[allow(clippy::too_many_arguments)]
fn spawn_camera_entity(
    commands: &mut Commands,
    transform: Transform,
    vfov_rad: f32,
    layer: u32,
    clear_black: bool,
    tonemap: Tonemapping,
    order: isize,
    target: RenderTarget,
    exposure: Option<bevy::camera::Exposure>,
    mount: Mount,
    fast_gpu: bool,
) {
    let mut e = commands.spawn((
        Camera3d {
            depth_texture_usages: (TextureUsages::RENDER_ATTACHMENT | TextureUsages::COPY_SRC).into(),
            ..default()
        },
        Camera {
            order,
            clear_color: if clear_black {
                ClearColorConfig::Custom(Color::BLACK)
            } else {
                ClearColorConfig::Default
            },
            ..default()
        },
        Projection::from(PerspectiveProjection { fov: vfov_rad, near: 0.5, far: 900.0, ..default() }),
        Msaa::Off,
        tonemap,
        transform,
        target,
        RenderLayers::layer(layer as usize),
        SensorCam { mount },
    ));
    if clear_black {
        // These channels encode integer labels, not radiance. The default
        // PBR debanding shader perturbs IDs and semantic classes by +/-1.
        e.insert(bevy::core_pipeline::tonemapping::DebandDither::Disabled);
    }
    // Neutral exposure for the aux pass: unlit ID/class colors are absolute.
    if let Some(exposure) = exposure {
        e.insert(exposure);
    }
    if !fast_gpu {
        e.insert(bevy::render::view::NoIndirectDrawing);
    }
}

fn ego_transform(ss: Option<&crate::scene_state::SceneState>, tick_index: u32) -> Transform {
    match ss.and_then(|s| s.ego()) {
        Some(ego) => Transform {
            translation: Vec3::from_slice(&ego.transform.position),
            rotation: Quat::from_xyzw(
                ego.transform.rotation[0],
                ego.transform.rotation[1],
                ego.transform.rotation[2],
                ego.transform.rotation[3],
            ),
            scale: Vec3::ONE,
        },
        None => {
            let _ = tick_index;
            Transform::IDENTITY
        }
    }
}

// ---------------------------------------------------------------------------
// Frame loop + capture
// ---------------------------------------------------------------------------

/// Unconditional per-Update counter; also stamps scene-readiness for the
/// bring-up settle gate.
fn bump_tick(mut tick: ResMut<AppTick>, mut state: ResMut<HarnessState>) {
    tick.0 += 1;
    if state.build_ready_at.is_some() && state.ready_tick.is_none() {
        state.ready_tick = Some(tick.0);
    }
}

fn tick_frames(mut frame: ResMut<GlobalFrame>, mut state: ResMut<HarnessState>, pending: Res<render_core::readiness::GpuPending>) {
    if state.build_ready_at.is_some() && state.clones_done && state.sensors_spawned {
        if !state.gpu_ready {
            state.gpu_idle_frames = if pending.is_idle() { state.gpu_idle_frames + 1 } else { 0 };
            if state.gpu_idle_frames < render_core::readiness::GPU_IDLE_FRAMES {
                return;
            }
            state.gpu_ready = true;
            println!("PROF gpuReady samples={}", pending.samples());
        }
        frame.0 += 1;
    }
    if frame.0 > 0 && frame.0 % 500 == 0 {
        println!(
            "PROGRESS frame={} ready={} clones={} sensors={}",
            frame.0,
            state.build_ready_at.is_some(),
            state.clones_done,
            state.sensors_spawned
        );
    }
}

/// Pose the next batched tick: move the ego's cameras and the actor cuboids,
/// rebuild the small actor BVH, run the CPU sensors for that tick, and arm the
/// frame whose readback will carry its camera passes.
///
/// The CPU sensors run here rather than at collection time because they only
/// need the pose and the BVH, so they overlap the GPU work already in flight
/// and need no per-tick snapshot of the actor tree.
#[allow(clippy::too_many_arguments)]
fn pose_next_tick(
    args: Res<CaptureArgs>,
    rig: Res<RigSpec>,
    frame: Res<GlobalFrame>,
    sequence: Option<Res<crate::scene_state::SceneSequence>>,
    tmerc: Option<Res<TmercOrigin>>,
    meshes: Res<Assets<Mesh>>,
    state: Res<HarnessState>,
    mut scene_state: Option<ResMut<crate::scene_state::SceneState>>,
    mut sensor_scene: Option<ResMut<SensorScene>>,
    mut progress: ResMut<CaptureProgress>,
    mut cams: Query<(&SensorCam, &mut Transform), (Without<ActorBox>, Without<ActorIdClone>)>,
    mut boxes: Query<
        (Entity, &ActorBoxOf, &Mesh3d, &mut Transform, &mut Visibility),
        With<ActorBox>,
    >,
    mut id_clones: Query<
        (&ActorIdClone, &mut Transform, &mut Visibility),
        (Without<ActorBox>, Without<SensorCam>),
    >,
) {
    let Some(mut sensor_scene) = sensor_scene.take() else { return };
    let Some(sequence) = sequence else { return };
    if !state.clones_done || !state.sensors_spawned || state.finished {
        return;
    }
    // The first capture waits out the warmup frames (pipeline compilation,
    // shadow cascades, light probes); after that every frame carries a tick.
    if frame.0 < args.warmup as u64 {
        return;
    }
    // At most two ticks in flight: the frame being rendered and the frame
    // whose readback is landing next Update.
    if progress.next >= sequence.ticks.len() || progress.in_flight.len() >= 2 {
        return;
    }
    let started = Instant::now();
    let index = progress.next;
    let tick = &sequence.ticks[index];

    // ---- ego + camera poses ----
    // The rig host is the same actor for the whole batch: resolved once from
    // the first tick so the mount never hops between vehicles mid-clip.
    let ego_host = sequence.ticks[0].ego().map(|a| a.id.as_str());
    let mut ego = ego_transform(Some(tick), tick.tick);
    ego.translation.y = ground_y(&sensor_scene.scene, ego.translation);
    for (cam, mut transform) in &mut cams {
        *transform = mount_camera_transform(ego, &cam.mount);
    }

    // ---- actor poses ----
    let pose_of: HashMap<&str, &crate::scene_state::ActorState> = tick
        .actors
        .iter()
        .filter(|a| Some(a.id.as_str()) != ego_host && a.kind != "despawn")
        .map(|a| (a.id.as_str(), a))
        .collect();
    let mut actor_transform: HashMap<Entity, Transform> = HashMap::new();
    for (entity, owner, _, mut transform, mut visibility) in &mut boxes {
        match pose_of.get(owner.0.as_str()) {
            Some(actor) => {
                let (_, _, h) = actor_dims(actor);
                let pos = Vec3::from_slice(&actor.transform.position);
                let ground = ground_y(&sensor_scene.scene, pos);
                *transform = Transform {
                    translation: Vec3::new(pos.x, ground + h * 0.5, pos.z),
                    rotation: Quat::from_xyzw(
                        actor.transform.rotation[0],
                        actor.transform.rotation[1],
                        actor.transform.rotation[2],
                        actor.transform.rotation[3],
                    ),
                    scale: Vec3::ONE,
                };
                *visibility = Visibility::Inherited;
                actor_transform.insert(entity, *transform);
            }
            // Absent from this tick: keep the id, hide the body.
            None => *visibility = Visibility::Hidden,
        }
    }
    for (clone, mut transform, mut visibility) in &mut id_clones {
        match actor_transform.get(&clone.0) {
            Some(source) => {
                *transform = *source;
                *visibility = Visibility::Inherited;
            }
            None => *visibility = Visibility::Hidden,
        }
    }
    let posed = Instant::now();

    // ---- actor BVH for this tick ----
    // Cuboids only: 12 triangles each, so this rebuild is microseconds against
    // the static tree's hundreds of thousands of triangles.
    let mut actors = RaycastScene::new();
    for (entity, _, mesh3d, transform, visibility) in &boxes {
        if matches!(*visibility, Visibility::Hidden) {
            continue;
        }
        let Some(&id) = state.entity_ids.get(&entity) else { continue };
        let Some(mesh) = meshes.get(&mesh3d.0) else { continue };
        push_mesh_triangles_matrix(mesh, transform.to_matrix(), &mut actors, id);
    }
    actors.build();
    sensor_scene.actors = actors;
    let bvh_built = Instant::now();

    // ---- CPU sensors for this tick ----
    if let Some(scene_state) = scene_state.as_mut() {
        **scene_state = tick.clone();
    }
    // Lidar and radar for this tick run as a task: the rays only need the pose
    // and the geometry, so they proceed while the GPU renders this tick's 17
    // camera views. Measured serially this was 1.2 s of raycasting waiting on
    // 0.6 s of GPU work, one after the other.
    let point_format = PointFormat::from_flag(&args.point_format);
    let task = {
        let out_dir = PathBuf::from(&args.out);
        let rig = rig.clone();
        let statics = std::sync::Arc::clone(&sensor_scene.scene);
        let gpu_lidar = sensor_scene.gpu_lidar.clone();
        let verify_gpu_lidar = args.verify_gpu_lidar;
        let actors = std::mem::take(&mut sensor_scene.actors);
        let classes = sensor_scene.classes.clone();
        let instance_names = state.instance_names.clone();
        let scene_tick = tick.clone();
        let sequence_for_track = if index == 0 { Some((*sequence).clone()) } else { None };
        let tmerc = tmerc.as_deref().copied();
        let tick_number = tick.tick;
        crate::RAY_POOL.spawn(async move {
            run_cpu_sensors(
                &out_dir,
                &rig,
                Some(&scene_tick),
                sequence_for_track.as_ref(),
                tmerc.as_ref(),
                &statics,
                gpu_lidar.as_deref(),
                verify_gpu_lidar,
                &actors,
                &classes,
                &instance_names,
                tick_number,
                point_format,
                ego,
                index == 0,
            )
        })
    };

    progress.in_flight.push(InFlight {
        frame: frame.0,
        sequence_index: index,
        tick: tick.tick,
        cpu_sensors: Some(task),
    });
    progress.next += 1;
    if progress.first_armed.is_none() {
        progress.first_armed = Some(started);
    }
    println!(
        "PROF tick={} index={index} frame={} poseMs={:.1} actorBvhMs={:.1}",
        tick.tick,
        frame.0,
        posed.duration_since(started).as_secs_f64() * 1e3,
        bvh_built.duration_since(posed).as_secs_f64() * 1e3,
    );
}

fn strip_padding(data: &[u8], width: usize, height: usize, pixel: usize) -> Vec<u8> {
    let row = width * pixel;
    let aligned = aligned_row(width, pixel);
    if row == aligned {
        return data[..row * height].to_vec();
    }
    data.chunks_exact(aligned)
        .take(height)
        .flat_map(|r| &r[..row])
        .copied()
        .collect()
}

/// Write the camera passes of every in-flight tick whose readback has landed,
/// and exit once the batch is complete.
///
/// Independent image/point artifacts use the IO pool. RGB video bypasses
/// per-frame files and is fed to the ordered encoder sink.
#[allow(clippy::too_many_arguments)]
fn collect_passes(
    receiver: Res<MainReceiver>,
    args: Res<CaptureArgs>,
    rig: Res<RigSpec>,
    mut state: ResMut<HarnessState>,
    mut progress: ResMut<CaptureProgress>,
    mut prof: ResMut<Prof>,
    mut video: ResMut<VideoSink>,
    mut arrived: Local<HashMap<(u64, String), SentPass>>,
    mut exit: MessageWriter<AppExit>,
) {
    // Keyed by (frame, pass key) and RETAINED across calls: a frame's 25 passes
    // can be sent across more than one Update, and a per-call map would drop the
    // early ones, so that frame would never reach its expected count, the
    // in-flight slots would fill, posing would stop, and the run would sit there
    // forever. Entries are removed only when their tick is written.
    while let Ok(p) = receiver.try_recv() {
        arrived.insert((p.frame, p.key.clone()), p);
    }
    if progress.in_flight.is_empty() {
        return;
    }

    let cam_index_of: HashMap<String, usize> =
        rig.cameras().enumerate().map(|(i, s)| (s.id.clone(), i)).collect();
    let mut expected = 0usize;
    for sensor in rig.sensors.iter() {
        if sensor.kind != SensorKind::Camera {
            continue;
        }
        // Chase: RGB only. Measurement cameras: RGB + depth + aux.
        expected += if args.rgb_only || sensor.id == crate::rig::CHASE_CAMERA_SENSOR_ID { 1 } else { 3 };
    }

    let out_dir = PathBuf::from(&args.out);
    let w = args.width as usize;
    let h = args.height as usize;
    let mut completed: Vec<u64> = Vec::new();

    // Snapshot the ready flights, taking each one's raycast task with it so
    // `progress` is free to mutate below.
    let mut ready: Vec<(u64, u32, usize, Option<bevy::tasks::Task<CpuSensorTiming>>)> = Vec::new();
    for flight in progress.in_flight.iter_mut() {
        let have = arrived.keys().filter(|(frame, _)| *frame == flight.frame).count();
        if have >= expected {
            ready.push((flight.frame, flight.tick, flight.sequence_index, flight.cpu_sensors.take()));
        }
    }

    for (frame, tick, sequence_index, cpu_sensors) in ready {
        let started = Instant::now();
        let mut jobs: Vec<(PathBuf, WritePass)> = Vec::new();
        for sensor in rig.sensors.iter() {
            if sensor.kind != SensorKind::Camera {
                continue;
            }
            let is_chase = sensor.id == crate::rig::CHASE_CAMERA_SENSOR_ID;
            let i = cam_index_of.get(&sensor.id).copied().unwrap_or(rig.cameras().count());
            let dir = out_dir.join(&sensor.id);
            std::fs::create_dir_all(&dir).expect("mkdir");
            // Buffers are moved out of the arrival map, never copied: each is
            // a full render target.
            let mut take = |key: String| -> Vec<u8> {
                arrived
                    .remove(&(frame, key.clone()))
                    .unwrap_or_else(|| panic!("missing pass {key} for frame {frame}"))
                    .data
            };
            // RGB may be lossy: it is imagery. The aux passes never are — their
            // pixels are instance ids and class ids, and a JPEG of an id map is
            // garbage.
            if args.video {
                video.push(sequence_index, sensor.id.clone(), take(format!("rgb{i}")));
            } else {
                let (rgb_name, rgb_pass) = match args.rgb_format.as_str() {
                    "jpeg" | "jpg" => (
                        format!("{tick:08}.rgb.jpg"),
                        WritePass::Jpeg(take(format!("rgb{i}")), args.jpeg_quality),
                    ),
                    _ => (
                        format!("{tick:08}.rgb.png"),
                        WritePass::Png(take(format!("rgb{i}"))),
                    ),
                };
                jobs.push((dir.join(rgb_name), rgb_pass));
            }
            if !is_chase && !args.rgb_only {
                let instance = take(format!("inst{i}"));
                jobs.push((
                    dir.join(format!("{tick:08}.semantic.png")),
                    WritePass::Semantic(instance.clone()),
                ));
                jobs.push((
                    dir.join(format!("{tick:08}.instance.png")),
                    WritePass::Png(instance),
                ));
                let depth = take(format!("depth{i}"));
                let (depth_name, depth_pass) = match args.depth_format.as_str() {
                    "f16" | "half" => (
                        format!("{tick:08}.depth.f16.bin"),
                        WritePass::DepthHalf(depth),
                    ),
                    _ => (format!("{tick:08}.depth.f32.bin"), WritePass::Raw(depth)),
                };
                jobs.push((dir.join(depth_name), depth_pass));
            }
        }

        bevy::tasks::IoTaskPool::get().scope(|scope| {
            for (path, pass) in &jobs {
                scope.spawn(async move { pass.write(path, w, h) });
            }
        });
        if args.video {
            video.drain(&args, &out_dir);
        }
        let written = Instant::now();

        // This tick's raycasting has been running alongside its render; whatever
        // is left of it is the part that did not fit under the GPU work.
        let cpu = cpu_sensors
            .map(|task| bevy::tasks::block_on(task))
            .unwrap_or(CpuSensorTiming { lidar_ms: 0.0, radar_ms: 0.0, imu_ms: 0.0 });
        progress.written += 1;
        completed.push(frame);
        println!(
            "PROF tick={tick} index={sequence_index} writeMs={:.1} files={} lidarMs={:.1} radarMs={:.1} imuMs={:.1} joinMs={:.1} sinceStart={:.3}",
            written.duration_since(started).as_secs_f64() * 1e3,
            jobs.len(),
            cpu.lidar_ms,
            cpu.radar_ms,
            cpu.imu_ms,
            written.elapsed().as_secs_f64() * 1e3,
            prof.since_start(),
        );
    }

    if completed.is_empty() {
        return;
    }
    progress.in_flight.retain(|f| !completed.contains(&f.frame));

    // The legend covers the whole batch (one frozen instance registry), so it
    // is written once, with the first completed tick.
    if progress.written == completed.len() {
        let legend = Legend {
            schema: "uniscenarios.sensor-legend/v1",
            classes: SemanticClass::ALL.iter().map(|c| (c.id(), c.name())).collect(),
            instances: state.instance_names.clone(),
            instance_classes: state.instance_classes.clone(),
        };
        std::fs::write(
            out_dir.join("legend.json"),
            serde_json::to_string_pretty(&legend).unwrap(),
        )
        .expect("write legend");
    }

    if progress.written >= progress.planned && progress.in_flight.is_empty() {
        // App::run consumes the app and replaces it with App::empty(). Finish
        // live encoders here, before AppExit, never by looking up resources
        // after run() returns. The capture clock includes the trailer flush.
        let drain_start = Instant::now();
        let encoded = video.finish(args.video);
        if encoded > 0 {
            println!("PROF stage=encoder_drain seconds={:.3} frames={encoded}", drain_start.elapsed().as_secs_f64());
        }
        state.finished = true;
        let captured = progress.written as f64;
        let steady = progress
            .first_armed
            .map(|t| t.elapsed().as_secs_f64())
            .unwrap_or(0.0);
        println!(
            "PROF summary ticks={} captureSeconds={:.3} perTickSeconds={:.3} totalSeconds={:.3}",
            progress.written,
            steady,
            steady / captured.max(1.0),
            prof.since_start(),
        );
        prof.stage("capture");
        exit.write(AppExit::Success);
    }
}

/// One output file's payload, encoded off the frame thread.
enum WritePass {
    /// RGBA8 render target saved as PNG.
    Png(Vec<u8>),
    /// RGBA8 render target saved as JPEG at the given quality. Imagery only.
    Jpeg(Vec<u8>, u8),
    /// Aux pass whose blue channel carries the semantic class; re-encoded into
    /// the red channel for the standard semantic artifact shape.
    Semantic(Vec<u8>),
    /// Raw `Depth32Float` bytes, row padding stripped.
    Raw(Vec<u8>),
    /// Reverse-Z depth narrowed to IEEE half precision: half the bytes, and
    /// reverse-Z puts the precision where the geometry is (near the camera).
    DepthHalf(Vec<u8>),
}

impl WritePass {
    fn write(&self, path: &Path, w: usize, h: usize) {
        match self {
            WritePass::Png(data) => {
                let raw = strip_padding(data, w, h, 4);
                image::RgbaImage::from_raw(w as u32, h as u32, raw)
                    .expect("rgba")
                    .save(path)
                    .expect("save png");
            }
            WritePass::Jpeg(data, quality) => {
                let raw = strip_padding(data, w, h, 4);
                // JPEG has no alpha; drop it rather than letting the encoder
                // guess.
                let mut rgb = Vec::with_capacity(w * h * 3);
                for px in raw.chunks_exact(4) {
                    rgb.extend_from_slice(&px[..3]);
                }
                let file = std::fs::File::create(path).expect("create jpeg");
                let mut writer = std::io::BufWriter::new(file);
                image::codecs::jpeg::JpegEncoder::new_with_quality(&mut writer, *quality)
                    .encode(&rgb, w as u32, h as u32, image::ExtendedColorType::Rgb8)
                    .expect("encode jpeg");
            }
            WritePass::Semantic(data) => {
                let raw = strip_padding(data, w, h, 4);
                let mut sem = Vec::with_capacity(raw.len());
                for px in raw.chunks_exact(4) {
                    sem.extend_from_slice(&[px[2], 0, 0, 255]);
                }
                image::RgbaImage::from_raw(w as u32, h as u32, sem)
                    .expect("rgba")
                    .save(path)
                    .expect("save semantic");
            }
            WritePass::Raw(data) => {
                std::fs::write(path, strip_padding(data, w, h, 4)).expect("write raw");
            }
            WritePass::DepthHalf(data) => {
                let raw = strip_padding(data, w, h, 4);
                let mut half = Vec::with_capacity(raw.len() / 2);
                for bytes in raw.chunks_exact(4) {
                    let value = f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
                    half.extend_from_slice(&f32_to_f16_bits(value).to_le_bytes());
                }
                std::fs::write(path, half).expect("write depth half");
            }
        }
    }
}

/// IEEE 754 binary32 -> binary16 bit pattern, round-to-nearest-even, with
/// saturation to +/-inf rather than wrapping. No dependency needed for one
/// well-defined bit twiddle.
pub fn f32_to_f16_bits(value: f32) -> u16 {
    let bits = value.to_bits();
    let sign = ((bits >> 16) & 0x8000) as u16;
    let exponent = ((bits >> 23) & 0xff) as i32;
    let mantissa = bits & 0x007f_ffff;

    if exponent == 0xff {
        // Inf or NaN: keep NaN-ness by preserving a nonzero mantissa.
        let mantissa16 = if mantissa != 0 { 0x0200 } else { 0 };
        return sign | 0x7c00 | mantissa16;
    }
    let unbiased = exponent - 127;
    if unbiased > 15 {
        return sign | 0x7c00;
    }
    if unbiased < -24 {
        return sign;
    }
    if unbiased < -14 {
        // Subnormal half: shift the implicit bit in and round.
        let shift = (-14 - unbiased) as u32;
        let full = mantissa | 0x0080_0000;
        let mut out = (full >> (shift + 13)) as u16;
        let round_bit = 1u32 << (shift + 12);
        if (full & round_bit) != 0 && ((full & (round_bit - 1)) != 0 || (out & 1) == 1) {
            out += 1;
        }
        return sign | out;
    }
    let mut out = ((unbiased + 15) as u16) << 10 | (mantissa >> 13) as u16;
    if (mantissa & 0x0000_1000) != 0
        && ((mantissa & 0x0000_0fff) != 0 || (out & 1) == 1)
    {
        out += 1;
    }
    sign | out
}

/// Point-cloud artifact encoding.
#[derive(Clone, Copy, PartialEq, Eq)]
enum PointFormat {
    /// CARLA-parity ASCII: readable, and ~2.6x the bytes of binary.
    Ascii,
    /// Little-endian packed rows: 20 bytes per lidar point, 16 per detection.
    Binary,
}

impl PointFormat {
    fn from_flag(flag: &str) -> Self {
        match flag {
            "binary" | "bin" => PointFormat::Binary,
            _ => PointFormat::Ascii,
        }
    }
}

/// Wall-clock cost of one tick's CPU sensors.
struct CpuSensorTiming {
    lidar_ms: f64,
    radar_ms: f64,
    imu_ms: f64,
}

/// Lidar, radar and (once per batch) IMU/GNSS for one tick.
///
/// Casts run against the composed static + per-tick actor trees, and each
/// sensor's scan is internally parallel, so a tick's raycasting scales with
/// cores instead of serializing 780k rays on the frame thread.
#[allow(clippy::too_many_arguments)]
fn run_cpu_sensors(
    out_dir: &Path,
    rig: &RigSpec,
    scene_state: Option<&SceneState>,
    sequence: Option<&crate::scene_state::SceneSequence>,
    tmerc: Option<&TmercOrigin>,
    statics: &InstancedScene,
    gpu_lidar: Option<&gpu_lidar::GpuLidar>,
    verify_gpu_lidar: bool,
    actors: &RaycastScene,
    classes: &HashMap<u32, u8>,
    instance_names: &[(u32, String)],
    tick: u32,
    // `ascii` for CARLA-parity text, `binary` for little-endian packed rows.
    point_format: PointFormat,
    // Ground-snapped rig host pose, identical to the one the cameras use.
    // Deriving it again from the document would put the mounts at the
    // document's y (0 m for compiled traces) and bury every lidar.
    ego: Transform,
    write_track: bool,
) -> CpuSensorTiming {
    use crate::taxonomy::SemanticClass;
    let class_of = |id: u32| -> SemanticClass {
        classes
            .get(&id)
            .and_then(|c| SemanticClass::ALL.iter().copied().find(|k| k.id() == *c))
            .unwrap_or(SemanticClass::Prop)
    };
    let world = crate::bvh::CompositeScene::new(vec![statics, actors]);

    // Sensor mounts hang off the ground-snapped host pose; only the velocity
    // comes from the document.
    let ego_vel = scene_state
        .and_then(|s| s.ego())
        .map(|ego| Vec3::from_slice(&ego.velocity))
        .unwrap_or(Vec3::ZERO);
    // instance id -> scene-state actor velocity (statics = zero). Resolved
    // once per tick into a map: the radar asks per hit, and a linear scan of
    // the instance registry per hit is quadratic in scene size.
    let velocities: HashMap<u32, Vec3> = instance_names
        .iter()
        .filter_map(|(id, name)| {
            let actor_id = name.strip_prefix("actor:")?;
            let actor = scene_state?.actors.iter().find(|a| a.id == actor_id)?;
            Some((*id, Vec3::from_slice(&actor.velocity)))
        })
        .collect();
    let velocity_of = |id: u32| -> Vec3 { velocities.get(&id).copied().unwrap_or(Vec3::ZERO) };

    // ---- lidars ----
    let lidar_start = Instant::now();
    let requests: Vec<_> = rig.lidars().map(|sensor| {
        let mount_tf = mount_world_transform(ego, &sensor.mount);
        gpu_lidar::Request {
            config: lidar::LidarConfig {
                channels: sensor.lidar_channels,
                rotation_frequency_hz: sensor.rotation_frequency_hz,
                points_per_second: sensor.points_per_second.unwrap_or(1_300_000),
                vfov_deg: sensor.vertical_fov_deg.unwrap_or(25.0),
                hfov_deg: sensor.horizontal_fov_deg,
                range_m: sensor.range_m,
            },
            origin: mount_tf.translation,
            rotation: mount_tf.rotation,
        }
    }).collect();
    let mut gpu_scans = gpu_lidar.map(|gpu| gpu.scan_batch(
        &requests, actors, &class_of, verify_gpu_lidar.then_some(&world as &dyn Raycast),
        statics,
    ));
    for (index, (sensor, request)) in rig.lidars().zip(&requests).enumerate() {
        let points = if let Some(scans) = &mut gpu_scans {
            std::mem::take(&mut scans[index])
        } else {
            lidar::scan(&world, &request.config, request.origin, request.rotation, &class_of)
        };
        let dir = out_dir.join(&sensor.id);
        std::fs::create_dir_all(&dir).expect("mkdir lidar");
        match point_format {
            PointFormat::Ascii => std::fs::write(
                dir.join(format!("{tick:08}.ply")),
                formats::encode_lidar_ply(&points),
            ),
            PointFormat::Binary => std::fs::write(
                dir.join(format!("{tick:08}.bin.ply")),
                formats::encode_lidar_ply_binary(&points),
            ),
        }
        .expect("write lidar");
    }
    let lidar_done = Instant::now();

    // ---- radars ----
    let tick_hz = scene_state.map(|s| s.tick_hz).unwrap_or(20.0);
    for sensor in rig.radars() {
        let cfg = radar::RadarConfig::from_budget(
            sensor.points_per_second,
            tick_hz,
            sensor.horizontal_fov_deg,
            sensor.vertical_fov_deg.unwrap_or(30.0),
            sensor.range_m,
        );
        let mount_tf = mount_world_transform(ego, &sensor.mount);
        let detections = radar::scan(
            &world,
            &cfg,
            mount_tf.translation,
            mount_tf.rotation,
            ego_vel,
            &velocity_of,
        );
        let dir = out_dir.join(&sensor.id);
        std::fs::create_dir_all(&dir).expect("mkdir radar");
        match point_format {
            PointFormat::Ascii => std::fs::write(
                dir.join(format!("{tick:08}.csv")),
                formats::encode_radar_csv(&detections),
            ),
            PointFormat::Binary => std::fs::write(
                dir.join(format!("{tick:08}.f32x4.bin")),
                formats::encode_radar_binary(&detections),
            ),
        }
        .expect("write radar");
    }
    let radar_done = Instant::now();

    // ---- IMU / GNSS ----
    // These are derived from the whole ego track, not from the rendered tick,
    // so they are written once per batch rather than re-derived per tick.
    if write_track {
        let (imu_samples, gnss_samples) = derive_imu_gnss(sequence, tmerc);
        if !imu_samples.is_empty() {
            formats::write_imu_jsonl(&out_dir.join("imu.jsonl"), &imu_samples).expect("write imu");
        }
        if !gnss_samples.is_empty() {
            formats::write_gnss_jsonl(&out_dir.join("gnss.jsonl"), &gnss_samples).expect("write gnss");
        }
    }
    let imu_done = Instant::now();

    CpuSensorTiming {
        lidar_ms: lidar_done.duration_since(lidar_start).as_secs_f64() * 1e3,
        radar_ms: radar_done.duration_since(lidar_done).as_secs_f64() * 1e3,
        imu_ms: imu_done.duration_since(radar_done).as_secs_f64() * 1e3,
    }
}

/// IMU and GNSS across the whole captured sequence.
///
/// Accelerations are finite-differenced between consecutive captured ticks and
/// the yaw rate comes from the document when present, falling back to the
/// differenced heading. A single captured tick yields a single zero-accel
/// sample, which is all one pose can support.
fn derive_imu_gnss(
    sequence: Option<&crate::scene_state::SceneSequence>,
    tmerc: Option<&TmercOrigin>,
) -> (Vec<ImuSample>, Vec<GnssSample>) {
    let Some(sequence) = sequence else { return (vec![], vec![]) };
    let mut imu = Vec::with_capacity(sequence.ticks.len());
    let mut gnss = Vec::new();
    let mut previous: Option<(f64, Vec3, f32)> = None;

    for state in &sequence.ticks {
        let Some(ego) = state.ego() else { continue };
        let hz = f64::from(state.tick_hz.max(1e-6));
        let t = f64::from(state.tick) / hz;
        let velocity = Vec3::from_slice(&ego.velocity);
        let yaw = {
            let [x, y, z, w] = ego.transform.rotation;
            (2.0 * (w * y + x * z)).atan2(1.0 - 2.0 * (y * y + x * x))
        };

        let (accel, differenced_yaw_rate) = match previous {
            Some((t_prev, v_prev, yaw_prev)) if t > t_prev => {
                let dt = (t - t_prev) as f32;
                let mut dyaw = yaw - yaw_prev;
                // Shortest way round, so a wrap does not spike the rate.
                while dyaw > std::f32::consts::PI {
                    dyaw -= std::f32::consts::TAU;
                }
                while dyaw < -std::f32::consts::PI {
                    dyaw += std::f32::consts::TAU;
                }
                ((velocity - v_prev) / dt, dyaw / dt)
            }
            _ => (Vec3::ZERO, 0.0),
        };
        let yaw_rate = ego.angular_velocity_y.unwrap_or(differenced_yaw_rate);

        imu.push(ImuSample {
            tick: state.tick,
            t,
            accel: [accel.x, accel.y, accel.z],
            gyro: [0.0, yaw_rate, 0.0],
        });
        if let Some(tm) = tmerc {
            let (lat, lon) = tm.inverse(
                f64::from(ego.transform.position[0]),
                f64::from(-ego.transform.position[2]),
            );
            gnss.push(GnssSample {
                tick: state.tick,
                t,
                latitude_deg: lat,
                longitude_deg: lon,
                altitude_m: ego.transform.position[1],
            });
        }
        previous = Some((t, velocity, yaw));
    }
    (imu, gnss)
}

// ---------------------------------------------------------------------------
// Manifest + render-world readback plumbing
// ---------------------------------------------------------------------------

/// Hash every artifact in the output tree. Returns the file count.
///
/// A batched clip writes tens of thousands of files, so hashing runs on the IO
/// pool; results are sorted by path afterwards, keeping the manifest stable.
fn write_manifest(out_dir: &Path) -> Result<usize> {
    let mut paths: Vec<PathBuf> = Vec::new();
    fn walk(dir: &Path, paths: &mut Vec<PathBuf>) -> Result<()> {
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.is_dir() {
                walk(&path, paths)?;
            } else {
                paths.push(path);
            }
        }
        Ok(())
    }
    walk(out_dir, &mut paths)?;
    let mut files: Vec<(String, String)> = bevy::tasks::IoTaskPool::get().scope(|scope| {
        for path in &paths {
            scope.spawn(async move {
                let rel = path
                    .strip_prefix(out_dir)
                    .expect("path under out dir")
                    .to_string_lossy()
                    .to_string();
                (rel, crate::sha256_file(path).expect("hash artifact"))
            });
        }
    });
    files.sort();
    let count = files.len();
    let manifest = json!({
        "schema": "uniscenarios.sensor-capture-manifest/v1",
        "profile": "sensor",
        "files": files.into_iter().map(|(p, h)| json!({"path": p, "sha256": h})).collect::<Vec<_>>(),
    });
    std::fs::write(out_dir.join("manifest.json"), serde_json::to_string_pretty(&manifest)?)?;
    Ok(count)
}

fn extract_copiers(
    mut commands: Commands,
    images: Extract<Query<&ImageCopier>>,
    depths: Extract<Query<&DepthCopier>>,
) {
    commands.insert_resource(Copiers(images.iter().cloned().collect()));
    commands.insert_resource(DepthCopiers(depths.iter().cloned().collect()));
}

fn extract_frame(frame: Extract<Res<GlobalFrame>>, mut stamp: ResMut<FrameStamp>) {
    stamp.0 = frame.0;
}

/// Publish the frames whose passes the main world is waiting for.
fn extract_armed(progress: Extract<Res<CaptureProgress>>, mut armed: ResMut<ArmedFrames>) {
    armed.0.clear();
    armed.0.extend(progress.in_flight.iter().map(|f| f.frame));
}

fn copy_passes(
    ctx: RenderContext,
    queue: Res<RenderQueue>,
    copiers: Res<Copiers>,
    depths: Res<DepthCopiers>,
    gpu_images: Res<RenderAssets<GpuImage>>,
    depth_views: Query<(Entity, &ExtractedCamera, &ViewDepthTexture)>,
    armed: Res<ArmedFrames>,
    stamp: Res<FrameStamp>,
    profile: Option<Res<gpu_profile::GpuProfile>>,
    mut fence: ResMut<CaptureFence>,
) {
    // Bring-up and warmup frames have nothing worth copying out of VRAM.
    if !armed.0.contains(&stamp.0) {
        return;
    }
    let mut encoder =
        ctx.render_device()
            .create_command_encoder(&CommandEncoderDescriptor::default());
    if let Some(profile) = &profile { profile.copy_start(&mut encoder); }
    for c in copiers.0.iter() {
        let Some(src) = gpu_images.get(&c.src_image) else { continue };
        let width = src.texture_descriptor.size.width as usize;
        let pixel = src.texture_descriptor.format.block_copy_size(None).unwrap_or(4);
        let padded = aligned_row(width, pixel as usize);
        encoder.copy_texture_to_buffer(
            src.texture.as_image_copy(),
            TexelCopyBufferInfo {
                buffer: &c.buffer,
                layout: TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(std::num::NonZero::<u32>::new(padded as u32).unwrap().into()),
                    rows_per_image: None,
                },
            },
            src.texture_descriptor.size,
        );
    }
    for d in depths.0.iter() {
        let Some((_, _, view)) = depth_views.iter().find(|(_, cam, _)| {
            matches!(
                cam.target,
                Some(bevy::camera::NormalizedRenderTarget::Image(ref irt))
                    if irt.handle.id() == d.src_image.id()
            )
        }) else {
            continue;
        };
        let tex = &view.texture;
        let width = tex.size().width as usize;
        let padded = aligned_row(width, 4);
        encoder.copy_texture_to_buffer(
            tex.as_image_copy(),
            TexelCopyBufferInfo {
                buffer: &d.buffer,
                layout: TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(std::num::NonZero::<u32>::new(padded as u32).unwrap().into()),
                    rows_per_image: None,
                },
            },
            tex.size(),
        );
    }
    if let Some(profile) = &profile { profile.copy_end(&mut encoder); }
    fence.0 = Some(queue.submit(std::iter::once(encoder.finish())));
}

fn receive_passes(
    device: Res<RenderDevice>,
    sender: Res<RenderSender>,
    copiers: Res<Copiers>,
    depths: Res<DepthCopiers>,
    stamp: Res<FrameStamp>,
    armed: Res<ArmedFrames>,
    profile: Option<ResMut<gpu_profile::GpuProfile>>,
    fence: Res<CaptureFence>,
) {
    // Only armed frames were copied, so only armed frames have anything to map.
    if !armed.0.contains(&stamp.0) {
        // Warmup must not build an unbounded queue of old frames that then
        // gets charged to the first captured tick. Captured frames below use
        // their own submission fence instead of this startup-only drain.
        if stamp.0 > 0 {
            device.poll(PollType::wait_indefinitely()).expect("drain warmup");
        }
        return;
    }
    struct Pending {
        key: String,
        buffer: Buffer,
    }
    let mut pending: Vec<Pending> = Vec::new();
    for c in copiers.0.iter().cloned() {
        pending.push(Pending { key: c.key.clone(), buffer: c.buffer.clone() });
    }
    for d in depths.0.iter().cloned() {
        pending.push(Pending { key: d.key.clone(), buffer: d.buffer.clone() });
    }
    if pending.is_empty() {
        return;
    }
    let started = Instant::now();
    let (s, r) = crossbeam_channel::bounded::<()>(pending.len());
    for p in &pending {
        let tx = s.clone();
        p.buffer.slice(..).map_async(MapMode::Read, move |res| {
            if res.is_err() {
                panic!("map buffer failed");
            }
            let _ = tx.send(());
        });
    }
    let profile_ready = profile.as_ref().map(|p| p.map());
    device.poll(PollType::Wait { submission_index: fence.0.clone(), timeout: None }).expect("poll capture fence");
    for _ in &pending {
        r.recv().expect("map_async result");
    }
    let mapped = Instant::now();
    let mut bytes = 0usize;
    for p in &pending {
        let data = p.buffer.slice(..).get_mapped_range().to_vec();
        bytes += data.len();
        let _ = sender.send(SentPass { key: p.key.clone(), frame: stamp.0, data });
        p.buffer.unmap();
    }
    println!(
        "PROF readback frame={} passes={} mapMs={:.1} copyMs={:.1} bytes={bytes}",
        stamp.0,
        pending.len(),
        mapped.duration_since(started).as_secs_f64() * 1e3,
        mapped.elapsed().as_secs_f64() * 1e3,
    );
    if let (Some(mut profile), Some(ready)) = (profile, profile_ready) {
        ready.recv().expect("timestamp readback");
        profile.report(stamp.0);
    }
}
