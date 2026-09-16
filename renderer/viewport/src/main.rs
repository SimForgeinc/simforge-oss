//! SimForge native interactive viewport.
//!
//! A Bevy/wgpu process that the Electron shell owns and the React editor
//! drives over newline-delimited JSON (see `PROTOCOL.md`). It renders a
//! canonical native map profile, progressively, under an explicit GPU byte
//! budget, and answers picks against the geometry it has actually made
//! resident.
//!
//! This binary is not the headless sensor `render_bundle` service: that
//! subsystem has its own transport (MessagePack over a length-prefixed
//! socket) and its own frame ring, and nothing here applies to it.

mod manifest;
mod picking;
mod protocol;
mod readiness;
mod scene;

use bevy::app::ScheduleRunnerPlugin;
use bevy::asset::{RenderAssetUsages, UnapprovedPathMode};
use bevy::camera::primitives::Aabb;
use bevy::camera::Projection;
use bevy::mesh::{Indices, PrimitiveTopology};
use bevy::prelude::*;
use bevy::render::error_handler::{RenderErrorHandler, RenderErrorPolicy};
use bevy::render::settings::RenderCreation;
use bevy::window::{ExitCondition, PresentMode, WindowLevel, WindowPosition, WindowResolution};
use clap::Parser;
use picking::MapEntity;
use protocol::{ControlCommand, Identity, Incoming, KeyState, PointerButton};
use readiness::{GpuAdapter, GpuPending, GpuReadinessPlugin, GpuSettle, Readiness};
use scene::{LoadRequest, LoadResponse, SceneIndex, Tier};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Instant;

pub const RENDERER_ID: &str = "native-wgpu-bevy";

/// Default GPU byte budget. An RTX 3080 has 10 GB and a macOS unified-memory
/// machine shares its budget with the compositor, so 2 GiB is the largest
/// resident set that leaves room for the window system on every machine the
/// team runs. Overridable, not guessed per-machine: a budget that changes
/// under you is a budget you cannot benchmark.
const DEFAULT_GPU_BUDGET_BYTES: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Parser, Resource, Clone, Debug)]
#[command(about = "SimForge native interactive viewport")]
struct Args {
    /// Native map profile root: the directory holding `.map-release.json`.
    /// Optional, because the host may instead send `load-map`.
    #[arg(long)]
    map_root: Option<PathBuf>,
    /// Immutable map version id the host believes it is opening.
    #[arg(long)]
    map_version_id: Option<String>,
    /// Release digest the host believes the root holds; verified, not echoed.
    #[arg(long)]
    release_digest: Option<String>,
    /// Start without a window for smoke/CI probing.
    #[arg(long, default_value_t = false)]
    headless: bool,
    /// Undecorated always-on-top window, positioned by `resize`, for
    /// compositing inside the editor's viewport region.
    #[arg(long, default_value_t = false)]
    embedded: bool,
    #[arg(long, default_value_t = 1280.0)]
    width: f32,
    #[arg(long, default_value_t = 720.0)]
    height: f32,
    #[arg(long)]
    x: Option<i32>,
    #[arg(long)]
    y: Option<i32>,
    /// Resident GPU byte budget for map geometry and textures.
    #[arg(long, default_value_t = DEFAULT_GPU_BUDGET_BYTES)]
    gpu_budget_bytes: u64,
    /// Fraction of the budget the coarse tier may use.
    #[arg(long, default_value_t = 0.08)]
    coarse_budget_fraction: f32,
    /// Node admissions/evictions started per frame. Deliberately small: an
    /// unbounded upload queue is how a loader takes the window compositor
    /// down with it.
    #[arg(long, default_value_t = 4)]
    stream_ops_per_frame: usize,
    /// Screen-relative extent (world extent / distance) at or above which a
    /// node is wanted at detail tier.
    #[arg(long, default_value_t = 0.06)]
    detail_screen_extent: f32,
    /// Screen-relative extent below which a node is evicted entirely.
    #[arg(long, default_value_t = 0.004)]
    coarse_screen_extent: f32,
    /// Emit `frame-stats` once per second.
    #[arg(long, default_value_t = false)]
    frame_stats: bool,
    /// Exit as soon as `complete` is announced; for benchmarks and CI.
    #[arg(long, default_value_t = false)]
    exit_on_complete: bool,
}

/// Device loss is observed by a wgpu callback that Bevy polls from a plain
/// `fn` error handler, so the signal has to live outside the ECS.
static DEVICE_LOST: AtomicBool = AtomicBool::new(false);
static DEVICE_LOST_REASON: LazyLock<Mutex<String>> = LazyLock::new(|| Mutex::new(String::new()));
static RENDER_ERROR: LazyLock<Mutex<Option<String>>> = LazyLock::new(|| Mutex::new(None));

fn signal_device_lost(reason: impl Into<String>) {
    *DEVICE_LOST_REASON.lock().expect("device lost reason") = reason.into();
    DEVICE_LOST.store(true, Ordering::Release);
}

/// Bevy's default policy quits the app on any render error. The editor needs
/// the opposite: a device loss must be reported and recovered from, because
/// the whole point of the `auto` fallback is that the UI decides what to do.
fn render_error_policy(
    error: &bevy::render::error_handler::RenderError,
    _main_world: &mut World,
    _render_world: &mut World,
) -> RenderErrorPolicy {
    if matches!(error.ty, bevy::render::error_handler::ErrorType::DeviceLost) {
        signal_device_lost(if error.description.is_empty() {
            "wgpu reported device loss".to_owned()
        } else {
            error.description.clone()
        });
        return RenderErrorPolicy::Recover(RenderCreation::default());
    }
    *RENDER_ERROR.lock().expect("render error") = Some(format!("{:?}: {}", error.ty, error.description));
    RenderErrorPolicy::StopRendering
}

#[derive(Resource)]
struct ControlChannel(Mutex<Receiver<Incoming>>);

/// Everything about the currently loaded map. Absent until a verified
/// manifest exists, which is what keeps argv from standing in for identity.
#[derive(Resource)]
struct LoadedMap {
    index: Arc<SceneIndex>,
    release: manifest::MapRelease,
    requests: Sender<LoadRequest>,
    /// `Receiver` is `Send` but not `Sync`, and a Bevy resource must be both.
    responses: Mutex<Receiver<LoadResponse>>,
    coarse_plan: Vec<usize>,
    resident: Vec<Tier>,
    entities: HashMap<usize, Entity>,
    /// Reads the loader thread owns, with the bytes each one has reserved
    /// against the budget. Reserving at admission rather than at spawn is what
    /// keeps the resident set inside the budget: the check is otherwise made
    /// against a number that ignores every read already in flight.
    in_flight: HashMap<usize, u64>,
    reserved_bytes: u64,
    materials: HashMap<usize, MaterialSlot>,
    coarse_material: Handle<StandardMaterial>,
    resident_bytes: u64,
    peak_resident_bytes: u64,
    budget_bytes: u64,
    coarse_budget_bytes: u64,
    /// Nodes whose desired tier could not be admitted within the budget.
    budget_skipped: HashSet<usize>,
    /// Lifetime admissions and evictions. A scheduler that never settles is
    /// indistinguishable from a slow one unless you can see these climbing
    /// while `residentBytes` sits still, so they are reported, not just held.
    admissions: u64,
    evictions: u64,
    /// `plan_member[node]` mirrors `coarse_plan` for O(1) membership: the
    /// scheduler asks this question once per node per frame.
    plan_member: Vec<bool>,
    started: Instant,
    coarse_announced: bool,
    interactive_announced: bool,
    complete_announced: bool,
    geometry_verified: Arc<Mutex<Option<Result<(), String>>>>,
}

struct MaterialSlot {
    handle: Handle<StandardMaterial>,
    users: usize,
    bytes: u64,
}

#[derive(Resource, Default)]
struct ViewportState {
    readiness: Readiness,
    selection: Vec<String>,
    overlays: HashMap<String, (bool, Value)>,
    frame_deltas: Vec<f32>,
    last_stats: Option<Instant>,
}


impl ViewportState {
    /// Announce a state transition, or ignore it if the contract forbids it.
    fn advance(&mut self, next: Readiness, fields: Value) -> bool {
        if !self.readiness.may_advance_to(next) {
            return false;
        }
        self.readiness = next;
        protocol::emit(next.wire(), fields);
        true
    }
}

fn main() -> anyhow::Result<()> {
    let args = Args::parse();
    let (control_tx, control_rx) = mpsc::channel();
    std::thread::spawn(move || {
        use std::io::BufRead;
        let stdin = std::io::stdin();
        for line in stdin.lock().lines().map_while(Result::ok) {
            if line.trim().is_empty() {
                continue;
            }
            if control_tx.send(protocol::parse_incoming(&line)).is_err() {
                break;
            }
        }
    });

    // The asset root is the map root: KTX2 textures are loaded by their
    // manifest-relative path, so the asset server must be anchored there. A
    // `load-map` for a different root is rejected rather than silently
    // resolving against the wrong directory (see `handle_load_map`).
    let asset_root = args
        .map_root
        .clone()
        .unwrap_or_else(|| PathBuf::from("."))
        .to_string_lossy()
        .to_string();

    let mut app = App::new();
    app.insert_resource(args.clone());
    app.insert_resource(ControlChannel(Mutex::new(control_rx)));
    app.insert_resource(ViewportState::default());
    let asset_plugin = AssetPlugin {
        file_path: asset_root,
        unapproved_path_mode: UnapprovedPathMode::Allow,
        ..default()
    };
    if args.headless {
        app.add_plugins(
            DefaultPlugins
                .set(asset_plugin)
                .set(WindowPlugin {
                    primary_window: None,
                    exit_condition: ExitCondition::DontExit,
                    ..default()
                })
                .disable::<bevy::winit::WinitPlugin>()
                .disable::<bevy::audio::AudioPlugin>(),
        );
        app.add_plugins(ScheduleRunnerPlugin::run_loop(std::time::Duration::from_secs_f64(1.0 / 60.0)));
    } else {
        let window = Window {
            title: "SimForge native viewport".to_owned(),
            resolution: WindowResolution::new(args.width as u32, args.height as u32),
            position: match (args.x, args.y) {
                (Some(x), Some(y)) => WindowPosition::At(IVec2::new(x, y)),
                _ => WindowPosition::Automatic,
            },
            decorations: !args.embedded,
            window_level: if args.embedded { WindowLevel::AlwaysOnTop } else { WindowLevel::Normal },
            skip_taskbar: args.embedded,
            present_mode: PresentMode::AutoVsync,
            ..default()
        };
        app.add_plugins(DefaultPlugins.set(asset_plugin).set(WindowPlugin {
            primary_window: Some(window),
            ..default()
        }));
        app.insert_resource(RenderErrorHandler(render_error_policy));
    }
    app.add_plugins(GpuReadinessPlugin);
    app.add_systems(Startup, setup);
    app.add_systems(
        Update,
        (
            control_system,
            stream_system,
            readiness_system,
            device_loss_system,
            overlay_system,
            frame_stats_system,
            orbit_camera,
        )
            .chain(),
    );
    app.run();
    Ok(())
}

fn setup(
    mut commands: Commands,
    args: Res<Args>,
    mut state: ResMut<ViewportState>,
    adapter: Option<Res<GpuAdapter>>,
) {
    // First thing on the wire, before any map: whoever reads the events has
    // to know which GPU produced the numbers that follow. Absent only in a
    // build with no render app at all.
    if let Some(adapter) = adapter {
        protocol::emit(
            "adapter",
            json!({
                "renderer": RENDERER_ID,
                "name": adapter.name,
                "backend": adapter.backend,
                "deviceType": adapter.device_type,
                "driver": adapter.driver,
                "driverInfo": adapter.driver_info,
            }),
        );
    }
    if !args.headless {
        commands.spawn((
            Camera3d::default(),
            Transform::from_xyz(0.0, 120.0, 220.0).looking_at(Vec3::ZERO, Vec3::Y),
        ));
        commands.spawn((
            DirectionalLight { illuminance: 20_000.0, shadow_maps_enabled: false, ..default() },
            Transform::from_xyz(200.0, 400.0, 200.0).looking_at(Vec3::ZERO, Vec3::Y),
        ));
    }
    // argv identity is a request, exactly like a `load-map` command: it is
    // verified against the manifest on disk before anything is announced.
    if let (Some(root), Some(map_version_id), Some(release_digest)) =
        (args.map_root.clone(), args.map_version_id.clone(), args.release_digest.clone())
    {
        commands.queue(move |world: &mut World| {
            begin_load(world, root, map_version_id, release_digest);
        });
    } else {
        protocol::emit("starting", json!({ "awaiting": "load-map" }));
        state.readiness = Readiness::Starting;
    }
}

/// Verify a map root against the identity the host asked for, then start the
/// progressive load. Every failure path emits `error` and loads nothing.
fn begin_load(world: &mut World, root: PathBuf, map_version_id: String, release_digest: String) {
    let args = world.resource::<Args>().clone();
    if let Some(existing) = world.get_resource::<LoadedMap>() {
        let same_root = existing.index.root == root;
        let same_release = existing.release.release_digest == release_digest;
        if same_root && same_release {
            return;
        }
        // The asset server is anchored at the root given at launch, so a
        // different root cannot be served by this process. Saying so beats
        // loading textures from the wrong map.
        if !same_root {
            protocol::emit_error(
                "map_root_immutable",
                format!(
                    "this viewport process is anchored at {}; restart it to open {}",
                    existing.index.root.display(),
                    root.display()
                ),
            );
            return;
        }
        let entities: Vec<Entity> = existing.entities.values().copied().collect();
        for entity in entities {
            world.entity_mut(entity).despawn();
        }
        world.remove_resource::<LoadedMap>();
    }
    protocol::set_identity(Identity {
        map_version_id: map_version_id.clone(),
        release_digest: release_digest.clone(),
        canonical_digest: None,
    });
    let verified = match manifest::load_and_verify(&root, &release_digest, &[manifest::MASTER_GLTF]) {
        Ok(verified) => verified,
        Err(error) => {
            protocol::emit_error(error.code, error.message);
            world.resource_mut::<ViewportState>().readiness = Readiness::Error;
            return;
        }
    };
    protocol::set_identity(Identity {
        map_version_id: map_version_id.clone(),
        release_digest: release_digest.clone(),
        canonical_digest: Some(verified.release.canonical_digest.clone()),
    });
    // Everything downstream reads through the root the verifier proved, not
    // through the argument, so a future caller cannot slip an unverified path
    // past the digest check.
    let root = verified.root.clone();
    let document: Value = match std::fs::read(root.join(manifest::MASTER_GLTF))
        .map_err(|error| error.to_string())
        .and_then(|bytes| serde_json::from_slice(&bytes).map_err(|error| error.to_string()))
    {
        Ok(document) => document,
        Err(error) => {
            protocol::emit_error("manifest_unreadable", format!("master.gltf is not JSON: {error}"));
            world.resource_mut::<ViewportState>().readiness = Readiness::Error;
            return;
        }
    };
    let index = match SceneIndex::parse(&root, &document, &verified.release.members) {
        Ok(index) => index,
        Err(error) => {
            protocol::emit_error("scene_index_failed", error);
            world.resource_mut::<ViewportState>().readiness = Readiness::Error;
            return;
        }
    };
    let index = Arc::new(index);
    let coarse_budget_bytes =
        (args.gpu_budget_bytes as f64 * f64::from(args.coarse_budget_fraction.clamp(0.001, 1.0))) as u64;
    let coarse_plan = index.coarse_plan(coarse_budget_bytes);
    let node_count = index.nodes.len();
    let (request_tx, request_rx) = mpsc::channel();
    let (response_tx, response_rx) = mpsc::channel();
    scene::spawn_loader(index.clone(), request_rx, response_tx);

    // `geometry.bin` is 60-400 MB across the canonical maps. Hashing it on
    // the startup path would add a second of latency to every load, so it is
    // verified alongside the load and reported with `complete`; a mismatch
    // still fails the load.
    let geometry_verified: Arc<Mutex<Option<Result<(), String>>>> = Arc::new(Mutex::new(None));
    {
        let slot = geometry_verified.clone();
        let release = verified.release.clone();
        let root = root.clone();
        std::thread::spawn(move || {
            let outcome = manifest::verify_member(&root, &release, manifest::GEOMETRY_BIN)
                .map_err(|error| format!("{}: {}", error.code, error.message));
            *slot.lock().expect("geometry verification slot") = Some(outcome);
        });
    }

    let coarse_material = world
        .resource_mut::<Assets<StandardMaterial>>()
        .add(StandardMaterial {
            base_color: Color::srgb(0.62, 0.63, 0.66),
            unlit: true,
            ..default()
        });
    let members = verified.release.members.len();
    let total_bytes = verified.release.total_bytes();
    let coarse_nodes = coarse_plan.len();
    let name = verified.release.name.clone();
    let version = verified.release.version.clone();
    let verified_members = verified.verified.clone();
    let size_checked = verified.size_checked;
    let scene_bounds = index.bounds().map(|(min, max)| {
        json!({ "min": [min.x, min.y, min.z], "max": [max.x, max.y, max.z] })
    });
    let mut plan_member = vec![false; node_count];
    for node in &coarse_plan {
        plan_member[*node] = true;
    }
    world.insert_resource(LoadedMap {
        index,
        release: verified.release,
        requests: request_tx,
        responses: Mutex::new(response_rx),
        coarse_plan,
        resident: vec![Tier::Absent; node_count],
        entities: HashMap::new(),
        in_flight: HashMap::new(),
        reserved_bytes: 0,
        materials: HashMap::new(),
        coarse_material,
        resident_bytes: 0,
        peak_resident_bytes: 0,
        budget_bytes: args.gpu_budget_bytes,
        coarse_budget_bytes,
        budget_skipped: HashSet::new(),
        admissions: 0,
        evictions: 0,
        plan_member,
        started: Instant::now(),
        coarse_announced: false,
        interactive_announced: false,
        complete_announced: false,
        geometry_verified,
    });
    world.resource_mut::<GpuSettle>().reset();
    let mut state = world.resource_mut::<ViewportState>();
    state.readiness = Readiness::Starting;
    state.advance(
        Readiness::ManifestReady,
        json!({
            "name": name,
            "version": version,
            "members": members,
            "totalBytes": total_bytes,
            "verified": verified_members,
            "sizeCheckedMembers": size_checked,
            "drawableNodes": node_count,
            "coarseNodes": coarse_nodes,
            "budgetBytes": args.gpu_budget_bytes,
            "coarseBudgetBytes": coarse_budget_bytes,
            // World-space bounds of the drawable set. The editor frames a map
            // it has never opened from this, and it is the only way a caller
            // can aim a camera without parsing `master.gltf` itself.
            "sceneBounds": scene_bounds,
        }),
    );
}

/// Priority of a node for admission: larger is more important. Screen-
/// relative extent, so a distant hill outranks a nearby fence post only when
/// it actually covers more of the frame.
fn priority(node: &scene::DrawNode, camera: Vec3) -> f32 {
    let distance = node.center().distance(camera).max(1.0);
    node.extent() / distance
}

fn desired_tier(args: &Args, node: &scene::DrawNode, camera: Vec3) -> Tier {
    let screen = priority(node, camera);
    if screen >= args.detail_screen_extent {
        Tier::Detail
    } else if screen >= args.coarse_screen_extent {
        Tier::Coarse
    } else {
        Tier::Absent
    }
}

/// Drain finished reads into GPU assets, then admit and evict within budget.
#[allow(clippy::too_many_arguments)]
fn stream_system(
    mut commands: Commands,
    args: Res<Args>,
    mut map: Option<ResMut<LoadedMap>>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    asset_server: Res<AssetServer>,
    cameras: Query<&GlobalTransform, With<Camera3d>>,
    mut settle: ResMut<GpuSettle>,
) {
    let Some(map) = map.as_deref_mut() else { return };
    let camera = cameras.iter().next().map(|transform| transform.translation()).unwrap_or(Vec3::ZERO);

    let mut spawned = 0usize;
    while spawned < args.stream_ops_per_frame.max(1) {
        let Ok(response) = map.responses.lock().expect("loader channel").try_recv() else { break };
        if let Some(reserved) = map.in_flight.remove(&response.node) {
            map.reserved_bytes = map.reserved_bytes.saturating_sub(reserved);
        }
        match response.result {
            Ok(primitives) => {
                spawn_node(map, &mut commands, &mut meshes, &mut materials, &asset_server, response.node, response.tier, primitives);
                settle.reset();
                spawned += 1;
            }
            Err(error) => {
                protocol::emit_error(
                    "node_load_failed",
                    format!("node {} failed to load: {error}", response.node),
                );
            }
        }
    }

    // Until the coarse plan is resident, the only admissions are coarse ones:
    // coarse-first is a scheduling rule, not a hope about read ordering.
    // Between `coarse-ready` and `interactive` nothing new is admitted: the
    // GPU has to prove it can draw the coarse tier before the editor is told
    // it can interact, and a stream of fresh uploads would keep resetting
    // that evidence. Detail streaming resumes once `interactive` is out.
    if map.coarse_announced && !map.interactive_announced {
        return;
    }
    let coarse_stage = !map.coarse_announced;
    let mut wanted: Vec<(usize, Tier, f32)> = Vec::new();
    for (index, node) in map.index.nodes.iter().enumerate() {
        let mut tier = desired_tier(&args, node, camera);
        if coarse_stage {
            tier = if map.plan_member[index] { Tier::Coarse } else { Tier::Absent };
        } else if tier > Tier::Coarse && map.plan_member[index] {
            // Plan members stay at least coarse so the silhouette never
            // disappears while detail streams in.
            tier = tier.max(Tier::Coarse);
        }
        if tier != map.resident[index] && !map.in_flight.contains_key(&index) {
            wanted.push((index, tier, priority(node, camera)));
        }
    }
    wanted.sort_by(|left, right| right.2.total_cmp(&left.2));

    let concurrency = args.stream_ops_per_frame.max(1);
    let mut operations = 0usize;
    for (index, tier, want_priority) in wanted {
        if operations >= concurrency {
            break;
        }
        // Hard cap on outstanding reads, not just on admissions per frame: an
        // unbounded queue is both a budget hole and the way a loader takes the
        // window compositor down with it.
        if tier > map.resident[index] && map.in_flight.len() >= concurrency {
            break;
        }
        let current = map.resident[index];
        if tier < current {
            evict_node(map, &mut commands, &mut materials, index, tier);
            operations += 1;
            continue;
        }
        let cost = node_cost(map, index, tier).saturating_sub(node_cost(map, index, current));
        // The stage ceiling, not the whole budget: during the coarse stage an
        // admission checked against `coarse_budget_bytes` must not be waved
        // through by an eviction plan drawn against the larger figure.
        let ceiling = if coarse_stage { map.coarse_budget_bytes } else { map.budget_bytes };
        let committed = map.resident_bytes + map.reserved_bytes;
        if committed + cost > ceiling
            && !free_bytes_for(map, &mut commands, &mut materials, cost, want_priority, camera, ceiling)
        {
            map.budget_skipped.insert(index);
            continue;
        }
        map.budget_skipped.remove(&index);
        if map.requests.send(LoadRequest { node: index, tier }).is_ok() {
            map.in_flight.insert(index, cost);
            map.reserved_bytes += cost;
            map.admissions += 1;
            operations += 1;
        }
    }
    map.peak_resident_bytes = map.peak_resident_bytes.max(map.resident_bytes);
}

/// GPU bytes a node occupies at `tier`, including the textures its materials
/// would pull in at detail tier.
fn node_cost(map: &LoadedMap, index: usize, tier: Tier) -> u64 {
    let node = &map.index.nodes[index];
    let mut bytes = node.bytes_at(tier);
    if tier == Tier::Detail {
        for primitive in &node.primitives {
            if let Some(material) = primitive.material {
                if map.materials.contains_key(&material) {
                    continue;
                }
                bytes += map.index.materials.get(material).map(|slot| slot.texture_bytes).unwrap_or(0);
            }
        }
    }
    bytes
}

/// A resident node the scheduler is allowed to give up, and what giving it up
/// would free.
struct Evictable {
    index: usize,
    bytes: u64,
    priority: f32,
}

/// Choose the evictions that make `needed` bytes fit under `ceiling`, or
/// `None` when no permissible set of them does.
///
/// Planning before evicting is the whole point, and it is why this is a pure
/// function with tests. Evicting greedily and only then discovering the
/// admission still does not fit frees geometry for nothing: those nodes are
/// wanted again on the next pass, are re-admitted because there is now room,
/// refill the budget, and are evicted again by the same oversized candidate.
/// Every lap uploads geometry, every upload resets the GPU settle evidence,
/// and `complete` — which requires a settled frame — never arrives. That is
/// the whole of the `complete` hang on a map whose closure does not fit in
/// the budget.
///
/// All-or-nothing also makes progress provable rather than hoped for. A
/// candidate only displaces strictly less important nodes, so the priority of
/// whatever is evicted is strictly below the priority of what replaces it;
/// a re-admission therefore has to displace something strictly cheaper still,
/// and a strictly decreasing chain over a finite node set terminates. No
/// damping constant is needed, and adding one would only widen the band of
/// candidates that plan, fail, and leave the resident set thrashing.
fn plan_evictions(
    evictable: &mut [Evictable],
    committed: u64,
    ceiling: u64,
    needed: u64,
    candidate_priority: f32,
) -> Option<Vec<usize>> {
    let Some(deficit) = committed.saturating_add(needed).checked_sub(ceiling).filter(|gap| *gap > 0)
    else {
        return Some(Vec::new());
    };
    evictable.sort_by(|left, right| left.priority.total_cmp(&right.priority));
    let mut freed = 0u64;
    let mut plan = Vec::new();
    for candidate in evictable.iter() {
        if freed >= deficit {
            break;
        }
        // Ties never evict: two nodes of equal importance displacing each
        // other is the thrash this function exists to prevent.
        if candidate.priority >= candidate_priority {
            break;
        }
        freed += candidate.bytes;
        plan.push(candidate.index);
    }
    (freed >= deficit).then_some(plan)
}

/// Free `needed` bytes under `ceiling` for a candidate of `candidate_priority`,
/// or leave the resident set untouched and report that it cannot be done.
fn free_bytes_for(
    map: &mut LoadedMap,
    commands: &mut Commands,
    materials: &mut Assets<StandardMaterial>,
    needed: u64,
    candidate_priority: f32,
    camera: Vec3,
    ceiling: u64,
) -> bool {
    let mut evictable: Vec<Evictable> = map
        .resident
        .iter()
        .enumerate()
        .filter(|(index, tier)| **tier != Tier::Absent && !map.plan_member[*index])
        .map(|(index, tier)| Evictable {
            index,
            // What `evict_node` will actually subtract. Shared material bytes
            // it may additionally release are not counted, so a plan can only
            // ever free more than it promised, never less.
            bytes: map.index.nodes[index].bytes_at(*tier),
            priority: priority(&map.index.nodes[index], camera),
        })
        .collect();
    let committed = map.resident_bytes + map.reserved_bytes;
    let Some(plan) = plan_evictions(&mut evictable, committed, ceiling, needed, candidate_priority)
    else {
        return false;
    };
    for index in plan {
        evict_node(map, commands, materials, index, Tier::Absent);
    }
    true
}

fn evict_node(
    map: &mut LoadedMap,
    commands: &mut Commands,
    materials: &mut Assets<StandardMaterial>,
    index: usize,
    tier: Tier,
) {
    if let Some(entity) = map.entities.remove(&index) {
        commands.entity(entity).despawn();
    }
    let previous = std::mem::replace(&mut map.resident[index], Tier::Absent);
    if previous != Tier::Absent {
        map.evictions += 1;
    }
    map.resident_bytes = map.resident_bytes.saturating_sub(map.index.nodes[index].bytes_at(previous));
    if previous == Tier::Detail {
        release_materials(map, materials, index);
    }
    if tier != Tier::Absent {
        // Downgrades are executed as an eviction plus a fresh request; the
        // scheduler will pick the node up again on its next pass.
        map.budget_skipped.remove(&index);
    }
}

fn release_materials(map: &mut LoadedMap, materials: &mut Assets<StandardMaterial>, index: usize) {
    let used: Vec<usize> = map.index.nodes[index]
        .primitives
        .iter()
        .filter_map(|primitive| primitive.material)
        .collect();
    for material in used {
        let Some(slot) = map.materials.get_mut(&material) else { continue };
        slot.users = slot.users.saturating_sub(1);
        if slot.users == 0 {
            let slot = map.materials.remove(&material).expect("material slot");
            map.resident_bytes = map.resident_bytes.saturating_sub(slot.bytes);
            materials.remove(&slot.handle);
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn spawn_node(
    map: &mut LoadedMap,
    commands: &mut Commands,
    meshes: &mut Assets<Mesh>,
    materials: &mut Assets<StandardMaterial>,
    asset_server: &AssetServer,
    index: usize,
    tier: Tier,
    primitives: Vec<scene::PrimitiveData>,
) {
    if let Some(entity) = map.entities.remove(&index) {
        commands.entity(entity).despawn();
        let previous = map.resident[index];
        map.resident_bytes = map.resident_bytes.saturating_sub(map.index.nodes[index].bytes_at(previous));
        if previous == Tier::Detail {
            release_materials(map, materials, index);
        }
    }
    let node = &map.index.nodes[index];
    let stable_id = map.index.stable_id(index);
    let layer = node.layer();
    let transform = Transform::from_matrix(node.transform);
    let local_min = node.local_min;
    let local_max = node.local_max;
    let mut children = Vec::new();
    for primitive in primitives {
        let mut mesh = Mesh::new(PrimitiveTopology::TriangleList, RenderAssetUsages::RENDER_WORLD);
        let vertices = primitive.positions.len();
        mesh.insert_attribute(Mesh::ATTRIBUTE_POSITION, primitive.positions);
        match (&primitive.normals, tier) {
            (Some(_), _) => {
                mesh.insert_attribute(Mesh::ATTRIBUTE_NORMAL, primitive.normals.clone().expect("normals"));
            }
            (None, Tier::Detail) => {
                // A detail node whose primitive has no authored normals gets
                // flat-shaded geometry rather than a black surface.
                mesh.insert_attribute(Mesh::ATTRIBUTE_NORMAL, vec![[0.0f32, 1.0, 0.0]; vertices]);
            }
            (None, _) => {}
        }
        if let Some(uvs) = primitive.uvs {
            mesh.insert_attribute(Mesh::ATTRIBUTE_UV_0, uvs);
        }
        mesh.insert_indices(Indices::U32(primitive.indices));
        let mesh = meshes.add(mesh);
        let material = match tier {
            Tier::Detail => acquire_material(map, materials, asset_server, primitive.material),
            _ => map.coarse_material.clone(),
        };
        children.push((Mesh3d(mesh), MeshMaterial3d(material)));
    }
    let entity = commands
        .spawn((
            transform,
            Visibility::Inherited,
            Aabb::from_min_max(local_min, local_max),
            MapEntity { stable_id, layer },
        ))
        .with_children(|parent| {
            for (mesh, material) in children {
                parent.spawn((mesh, material, Transform::IDENTITY));
            }
        })
        .id();
    map.entities.insert(index, entity);
    map.resident[index] = tier;
    map.resident_bytes += map.index.nodes[index].bytes_at(tier);
    map.peak_resident_bytes = map.peak_resident_bytes.max(map.resident_bytes);
}

fn acquire_material(
    map: &mut LoadedMap,
    materials: &mut Assets<StandardMaterial>,
    asset_server: &AssetServer,
    material: Option<usize>,
) -> Handle<StandardMaterial> {
    let Some(material_index) = material else { return map.coarse_material.clone() };
    if let Some(slot) = map.materials.get_mut(&material_index) {
        slot.users += 1;
        return slot.handle.clone();
    }
    let Some(definition) = map.index.materials.get(material_index).cloned() else {
        return map.coarse_material.clone();
    };
    let texture = definition
        .base_color_texture
        .as_deref()
        .map(|path| asset_server.load::<Image>(path.to_owned()));
    let handle = materials.add(StandardMaterial {
        base_color: Color::srgba(
            definition.base_color[0],
            definition.base_color[1],
            definition.base_color[2],
            definition.base_color[3],
        ),
        base_color_texture: texture.clone(),
        metallic: definition.metallic,
        perceptual_roughness: definition.roughness.max(0.05),
        alpha_mode: if definition.alpha_blend { AlphaMode::Blend } else { AlphaMode::Opaque },
        double_sided: definition.double_sided,
        cull_mode: if definition.double_sided { None } else { Some(bevy::render::render_resource::Face::Back) },
        ..default()
    });
    map.resident_bytes += definition.texture_bytes;
    map.materials.insert(
        material_index,
        MaterialSlot { handle: handle.clone(), users: 1, bytes: definition.texture_bytes },
    );
    handle
}

/// Advance the readiness state machine from evidence, never from a timer.
fn readiness_system(
    mut map: Option<ResMut<LoadedMap>>,
    mut state: ResMut<ViewportState>,
    pending: Res<GpuPending>,
    mut settle: ResMut<GpuSettle>,
    args: Res<Args>,
    cameras: Query<(&Camera, &Transform, Option<&Projection>), With<Camera3d>>,
    mut exit: MessageWriter<AppExit>,
) {
    let Some(map) = map.as_deref_mut() else { return };
    if let Some(outcome) = map.geometry_verified.lock().expect("geometry verification slot").take() {
        if let Err(message) = outcome {
            protocol::emit_error("member_digest_mismatch", message);
            state.readiness = Readiness::Error;
            return;
        }
    }
    let coarse_resident = map
        .coarse_plan
        .iter()
        .all(|index| map.resident[*index] != Tier::Absent);
    if !map.coarse_announced {
        if !coarse_resident || !map.in_flight.is_empty() {
            return;
        }
        map.coarse_announced = true;
        state.advance(
            Readiness::CoarseReady,
            json!({
                "elapsedMs": map.started.elapsed().as_millis(),
                "residentBytes": map.resident_bytes,
                "nodes": map.coarse_plan.len(),
            }),
        );
        return;
    }
    let settled = settle.poll(&pending);
    if !map.interactive_announced {
        if !settled {
            return;
        }
        map.interactive_announced = true;
        state.advance(
            Readiness::Interactive,
            json!({
                "elapsedMs": map.started.elapsed().as_millis(),
                "residentBytes": map.resident_bytes,
                "pipelinesPending": pending.pipelines(),
                "materialsPending": pending.materials(),
            }),
        );
        // The editor derives pick rays from the reported pose, so it must
        // have one the moment it is told the viewport is interactive rather
        // than after the first camera command.
        if let Some((camera, transform, projection)) = cameras.iter().next() {
            let aspect = camera
                .logical_viewport_size()
                .map(|size| size.x / size.y.max(1.0))
                .unwrap_or(16.0 / 9.0);
            emit_camera_state(transform, projection, aspect);
        }
        settle.reset();
        return;
    }
    if map.complete_announced {
        return;
    }
    if !map.in_flight.is_empty() || !settled {
        return;
    }
    let skipped_bytes: u64 = map
        .budget_skipped
        .iter()
        .map(|index| map.index.nodes[*index].detail_bytes)
        .sum();
    map.complete_announced = true;
    state.advance(
        Readiness::Complete,
        json!({
            "elapsedMs": map.started.elapsed().as_millis(),
            "residentBytes": map.resident_bytes,
            "peakResidentBytes": map.peak_resident_bytes,
            "budgetBytes": map.budget_bytes,
            "residentNodes": map.entities.len(),
            "budgetSkippedNodes": map.budget_skipped.len(),
            "budgetSkippedBytes": skipped_bytes,
            "admissions": map.admissions,
            "evictions": map.evictions,
            "verified": [manifest::MASTER_GLTF, manifest::GEOMETRY_BIN],
        }),
    );
    if args.exit_on_complete {
        exit.write(AppExit::Success);
    }
}

/// Device loss: report it, then rebuild everything the device owned. The
/// editor decides whether to keep waiting (explicit `native`) or switch to
/// WebGL (`auto`); this process's job is to be honest and to recover.
fn device_loss_system(
    mut commands: Commands,
    mut map: Option<ResMut<LoadedMap>>,
    mut state: ResMut<ViewportState>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    mut settle: ResMut<GpuSettle>,
) {
    if let Some(message) = RENDER_ERROR.lock().expect("render error").take() {
        protocol::emit_error("render_error", message);
        state.readiness = Readiness::Error;
        return;
    }
    if !DEVICE_LOST.swap(false, Ordering::AcqRel) {
        return;
    }
    let reason = DEVICE_LOST_REASON.lock().expect("device lost reason").clone();
    state.advance(Readiness::DeviceLost, json!({
        "reason": if reason.is_empty() { "wgpu reported device loss".to_owned() } else { reason },
        "recoverable": true,
    }));
    let Some(map) = map.as_deref_mut() else { return };
    let resident: Vec<usize> = map
        .resident
        .iter()
        .enumerate()
        .filter(|(_, tier)| **tier != Tier::Absent)
        .map(|(index, _)| index)
        .collect();
    for index in resident {
        evict_node(map, &mut commands, &mut materials, index, Tier::Absent);
    }
    map.in_flight.clear();
    map.reserved_bytes = 0;
    map.budget_skipped.clear();
    map.coarse_announced = false;
    map.interactive_announced = false;
    map.complete_announced = false;
    map.started = Instant::now();
    settle.reset();
    // A recovered device is a fresh load: the state machine restarts at
    // manifest-ready (identity is already proven) and re-announces every
    // readiness state as the scene comes back.
    state.readiness = Readiness::ManifestReady;
}

fn overlay_system(state: Res<ViewportState>, mut gizmos: Gizmos) {
    for (visible, payload) in state.overlays.values() {
        if !visible {
            continue;
        }
        let color = Color::srgb(1.0, 0.55, 0.1);
        if let Some(points) = payload.get("points").and_then(Value::as_array) {
            for point in points.iter().filter_map(vec3_from_json) {
                gizmos.sphere(point, 0.75, color);
            }
        }
        if let Some(lines) = payload.get("lines").and_then(Value::as_array) {
            for line in lines.iter().filter_map(Value::as_array) {
                let points: Vec<Vec3> = line.iter().filter_map(vec3_from_json).collect();
                for pair in points.windows(2) {
                    gizmos.line(pair[0], pair[1], color);
                }
            }
        }
    }
}

fn vec3_from_json(value: &Value) -> Option<Vec3> {
    let array = value.as_array()?;
    if array.len() != 3 {
        return None;
    }
    Some(Vec3::new(
        array[0].as_f64()? as f32,
        array[1].as_f64()? as f32,
        array[2].as_f64()? as f32,
    ))
}

fn frame_stats_system(args: Res<Args>, time: Res<Time>, mut state: ResMut<ViewportState>, map: Option<Res<LoadedMap>>) {
    if !args.frame_stats {
        return;
    }
    let delta = time.delta_secs() * 1000.0;
    if delta > 0.0 {
        state.frame_deltas.push(delta);
    }
    let now = Instant::now();
    let last = *state.last_stats.get_or_insert(now);
    if now.duration_since(last).as_millis() < 1000 {
        return;
    }
    state.last_stats = Some(now);
    let mut deltas = std::mem::take(&mut state.frame_deltas);
    if deltas.is_empty() {
        return;
    }
    deltas.sort_by(f32::total_cmp);
    let quantile = |fraction: f32| -> f32 {
        let at = ((deltas.len() as f32 - 1.0) * fraction).round() as usize;
        deltas[at.min(deltas.len() - 1)]
    };
    let (frames, p50, p95, p99) = (deltas.len(), quantile(0.50), quantile(0.95), quantile(0.99));
    protocol::emit(
        "frame-stats",
        json!({
            // CPU frame delta, not a GPU timestamp query. Neither backend has
            // timestamp queries, so anything reported from here is wall time
            // between main-world frames and must be labelled as such.
            "source": "cpu-frame-delta",
            "frames": frames,
            "p50Ms": p50,
            "p95Ms": p95,
            "p99Ms": p99,
            // The raw window, so a consumer spanning several buckets can take
            // true percentiles instead of averaging percentiles.
            "samplesMs": deltas,
            "residentBytes": map.as_ref().map(|map| map.resident_bytes).unwrap_or(0),
            "peakResidentBytes": map.as_ref().map(|map| map.peak_resident_bytes).unwrap_or(0),
            "admissions": map.as_ref().map(|map| map.admissions).unwrap_or(0),
            "evictions": map.as_ref().map(|map| map.evictions).unwrap_or(0),
            "budgetSkippedNodes": map.as_ref().map(|map| map.budget_skipped.len()).unwrap_or(0),
        }),
    );
}

fn orbit_camera(
    time: Res<Time>,
    keys: Res<ButtonInput<KeyCode>>,
    mut cameras: Query<&mut Transform, With<Camera3d>>,
) {
    let Ok(mut transform) = cameras.single_mut() else { return };
    let mut direction = Vec3::ZERO;
    if keys.pressed(KeyCode::KeyW) {
        direction.z -= 1.0;
    }
    if keys.pressed(KeyCode::KeyS) {
        direction.z += 1.0;
    }
    if keys.pressed(KeyCode::KeyA) {
        direction.x -= 1.0;
    }
    if keys.pressed(KeyCode::KeyD) {
        direction.x += 1.0;
    }
    if direction != Vec3::ZERO {
        transform.translation += direction.normalize() * 40.0 * time.delta_secs();
    }
}

/// Report the pose and intrinsics the viewport is actually drawing with. The
/// editor derives pick rays from this, so a guessed field here becomes a
/// misplaced pick there.
fn emit_camera_state(transform: &Transform, projection: Option<&Projection>, aspect: f32) {
    let target = transform.translation + transform.forward() * 100.0;
    let (fov, near, far) = match projection {
        Some(Projection::Perspective(perspective)) => (perspective.fov, perspective.near, perspective.far),
        _ => (std::f32::consts::FRAC_PI_4, 0.1, 1000.0),
    };
    protocol::emit(
        "camera-state",
        json!({
            "position": transform.translation.to_array(),
            "target": target.to_array(),
            "fovYRad": fov,
            "aspect": aspect,
            "nearM": near,
            "farM": far,
        }),
    );
}

#[allow(clippy::too_many_arguments)]
fn control_system(
    mut commands: Commands,
    channel: Res<ControlChannel>,
    mut state: ResMut<ViewportState>,
    mut cameras: Query<(&Camera, &mut Transform, &GlobalTransform, Option<&Projection>), With<Camera3d>>,
    candidates: Query<(&MapEntity, &Aabb, &GlobalTransform)>,
    mut windows: Query<&mut Window>,
    mut exit: MessageWriter<AppExit>,
) {
    let Ok(channel) = channel.0.lock() else { return };
    for incoming in channel.try_iter() {
        let command = match incoming {
            Incoming::Command(command) => command,
            Incoming::Rejected { code, message } => {
                protocol::emit_error(code, message);
                continue;
            }
        };
        match command {
            ControlCommand::LoadMap { map_root, map_version_id, release_digest } => {
                if map_root.is_empty() || map_version_id.is_empty() || release_digest.is_empty() {
                    protocol::emit_error(
                        "load_map_incomplete",
                        "load-map requires a non-empty mapRoot, mapVersionId and releaseDigest",
                    );
                    continue;
                }
                let root = PathBuf::from(map_root);
                commands.queue(move |world: &mut World| {
                    begin_load(world, root, map_version_id, release_digest);
                });
            }
            ControlCommand::Camera { position, target } => {
                let position = Vec3::from_array(position);
                let target = Vec3::from_array(target);
                if !position.is_finite() || !target.is_finite() || position.distance_squared(target) <= f32::EPSILON {
                    protocol::emit_error("invalid_camera_pose", "camera position/target must be finite and distinct");
                    continue;
                }
                let Ok((camera, mut transform, _, projection)) = cameras.single_mut() else {
                    protocol::emit_error("no_camera", "viewport has no camera to pose");
                    continue;
                };
                transform.translation = position;
                transform.look_at(target, Vec3::Y);
                let aspect = camera
                    .logical_viewport_size()
                    .map(|size| size.x / size.y.max(1.0))
                    .unwrap_or(16.0 / 9.0);
                emit_camera_state(&transform, projection, aspect);
            }
            ControlCommand::PointerRay { origin, direction, layers, max_hits } => {
                let origin = Vec3::from_array(origin);
                let direction = Vec3::from_array(direction);
                if !origin.is_finite() || !direction.is_finite() || direction.length_squared() <= f32::EPSILON {
                    protocol::emit_error(
                        "invalid_pointer_ray",
                        "origin/direction must be finite and direction nonzero",
                    );
                    continue;
                }
                emit_pick(origin, direction, &layers, max_hits.unwrap_or(8), &candidates);
            }
            ControlCommand::PointerButton { button, state: button_state, x, y } => {
                if button != PointerButton::Primary || button_state != KeyState::Pressed {
                    // Secondary/middle and release transitions are accepted
                    // and change nothing: the editor owns context menus and
                    // drag gestures.
                    continue;
                }
                let Ok((camera, _, global, _)) = cameras.single() else {
                    protocol::emit_error("no_camera", "viewport has no camera to pick through");
                    continue;
                };
                let Some(size) = camera.logical_viewport_size() else {
                    protocol::emit_error("no_viewport", "camera has no viewport to unproject through");
                    continue;
                };
                let viewport = Vec2::new((x + 1.0) * 0.5 * size.x, (1.0 - y) * 0.5 * size.y);
                let Ok(ray) = camera.viewport_to_world(global, viewport) else {
                    protocol::emit_error("unprojection_failed", "pointer position does not unproject");
                    continue;
                };
                let hits = emit_pick(ray.origin, *ray.direction, &[], 8, &candidates);
                let ids: Vec<String> = hits.into_iter().filter_map(|hit| hit.id).take(1).collect();
                state.selection = ids.clone();
                protocol::emit("selection-changed", json!({ "ids": ids }));
            }
            ControlCommand::Key { key, state: key_state, modifiers: _ } => {
                if key_state != KeyState::Pressed {
                    continue;
                }
                if key == "Escape" {
                    state.selection.clear();
                    protocol::emit("selection-changed", json!({ "ids": Vec::<String>::new() }));
                    continue;
                }
                let step = match key.as_str() {
                    "w" | "W" | "ArrowUp" => Vec3::new(0.0, 0.0, -1.0),
                    "s" | "S" | "ArrowDown" => Vec3::new(0.0, 0.0, 1.0),
                    "a" | "A" | "ArrowLeft" => Vec3::new(-1.0, 0.0, 0.0),
                    "d" | "D" | "ArrowRight" => Vec3::new(1.0, 0.0, 0.0),
                    _ => Vec3::ZERO,
                };
                if step == Vec3::ZERO {
                    continue;
                }
                if let Ok((camera, mut transform, _, projection)) = cameras.single_mut() {
                    let step = transform.rotation * step * 10.0;
                    transform.translation += step;
                    let aspect = camera
                        .logical_viewport_size()
                        .map(|size| size.x / size.y.max(1.0))
                        .unwrap_or(16.0 / 9.0);
                    emit_camera_state(&transform, projection, aspect);
                }
            }
            ControlCommand::Selection { ids } => {
                state.selection = ids.clone();
                protocol::emit("selection-changed", json!({ "ids": ids }));
            }
            ControlCommand::Overlay { id, visible, payload } => {
                state.overlays.insert(id.clone(), (visible, payload));
                protocol::emit("overlay-state", json!({ "id": id, "visible": visible }));
            }
            ControlCommand::Resize { width, height, pixel_ratio, x, y } => {
                if !(width.is_finite() && height.is_finite() && pixel_ratio.is_finite())
                    || width < 1.0
                    || height < 1.0
                    || pixel_ratio <= 0.0
                {
                    protocol::emit_error("invalid_resize", "width/height must be >= 1 and pixelRatio > 0");
                    continue;
                }
                let Ok(mut window) = windows.single_mut() else {
                    protocol::emit_error("no_window", "headless viewport has no window to resize");
                    continue;
                };
                window.resolution.set_scale_factor_override(Some(pixel_ratio));
                window.resolution.set(width, height);
                if let (Some(x), Some(y)) = (x, y) {
                    window.position = WindowPosition::At(IVec2::new(x, y));
                }
                protocol::emit(
                    "resized",
                    json!({ "width": width, "height": height, "pixelRatio": pixel_ratio, "x": x, "y": y }),
                );
            }
            ControlCommand::DebugDeviceLost { reason } => {
                signal_device_lost(reason.unwrap_or_else(|| "injected by debug-device-lost".to_owned()));
            }
            ControlCommand::Quit => {
                exit.write(AppExit::Success);
            }
        }
    }
}

fn emit_pick(
    origin: Vec3,
    direction: Vec3,
    layers: &[String],
    max_hits: usize,
    candidates: &Query<(&MapEntity, &Aabb, &GlobalTransform)>,
) -> Vec<picking::PickHit> {
    let hits = picking::hits(origin, direction, layers, max_hits, candidates.iter());
    protocol::emit("picked", json!({ "hits": hits }));
    hits
}

#[cfg(test)]
mod tests {
    use super::*;

    fn evictable(entries: &[(usize, u64, f32)]) -> Vec<Evictable> {
        entries
            .iter()
            .map(|(index, bytes, priority)| Evictable { index: *index, bytes: *bytes, priority: *priority })
            .collect()
    }

    #[test]
    fn an_admission_that_already_fits_evicts_nothing() {
        let mut resident = evictable(&[(0, 100, 0.1)]);
        let plan = plan_evictions(&mut resident, 400, 1_000, 100, 9.0);
        assert_eq!(plan, Some(Vec::new()));
    }

    #[test]
    fn evicts_the_least_important_nodes_and_stops_once_the_deficit_is_covered() {
        // Deficit is 150 bytes; the two cheapest-priority nodes cover it, and
        // the third must be left alone even though it is also evictable.
        let mut resident = evictable(&[(7, 100, 0.3), (3, 100, 0.1), (5, 100, 0.2)]);
        let plan = plan_evictions(&mut resident, 950, 1_000, 200, 9.0);
        assert_eq!(plan, Some(vec![3, 5]));
    }

    #[test]
    fn refuses_to_evict_anything_more_important_than_the_candidate() {
        let mut resident = evictable(&[(0, 500, 2.0)]);
        assert_eq!(plan_evictions(&mut resident, 1_000, 1_000, 100, 1.0), None);
        // Equal importance is not more important, and still must not evict:
        // two equally ranked nodes displacing each other is pure thrash.
        let mut tied = evictable(&[(0, 500, 1.0)]);
        assert_eq!(plan_evictions(&mut tied, 1_000, 1_000, 100, 1.0), None);
    }

    /// The `complete` hang, as a unit test. A candidate too large for even the
    /// whole evictable set must leave the resident set untouched: evicting
    /// part of it frees geometry for an admission that still fails, and those
    /// nodes are then re-admitted, re-evicted, and re-uploaded forever, which
    /// resets the GPU settle evidence and starves `complete`.
    #[test]
    fn an_unsatisfiable_candidate_evicts_nothing_at_all() {
        let mut resident = evictable(&[(1, 100, 0.1), (2, 100, 0.2), (3, 100, 0.3)]);
        let plan = plan_evictions(&mut resident, 1_000, 1_000, 5_000, 9.0);
        assert_eq!(plan, None);
    }

    /// Eviction only ever runs downhill in priority, which is what makes the
    /// scheduler terminate: whatever is displaced can only come back by
    /// displacing something strictly less important than itself.
    #[test]
    fn every_planned_eviction_ranks_below_the_candidate() {
        let mut resident = evictable(&[(1, 40, 0.9), (2, 40, 0.5), (3, 40, 1.4), (4, 40, 0.2)]);
        let plan = plan_evictions(&mut resident, 1_000, 1_000, 120, 1.0).expect("plan");
        assert_eq!(plan, vec![4, 2, 1]);
        for index in plan {
            let ranked = resident.iter().find(|entry| entry.index == index).expect("entry");
            assert!(ranked.priority < 1.0, "evicted node {index} outranks its candidate");
        }
    }
}
