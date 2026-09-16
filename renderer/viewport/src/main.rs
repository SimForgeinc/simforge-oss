use anyhow::Result;
use bevy::app::ScheduleRunnerPlugin;
use bevy::asset::{LoadState, UnapprovedPathMode};
use bevy::gltf::Gltf;
use bevy::prelude::*;
use bevy::camera::primitives::Aabb;
use bevy::window::ExitCondition;
use clap::Parser;
use serde::{Deserialize, Serialize};
use std::io::{self, BufRead};
use std::path::PathBuf;
use std::sync::{mpsc::{self, Receiver}, Mutex};
use std::thread;
use std::time::Instant;

#[derive(Parser, Resource, Clone)]
struct Args {
    /// Native map profile root containing master.gltf and its resources.
    #[arg(long)]
    map_root: PathBuf,
    /// Immutable map identity shown in readiness events.
    #[arg(long)]
    map_version_id: String,
    /// Canonical release digest bound to the loaded map.
    #[arg(long)]
    release_digest: String,
    /// Start without a window for smoke/CI probing.
    #[arg(long, default_value_t = false)]
    headless: bool,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "command", rename_all = "kebab-case")]
enum ControlCommand {
    Camera { position: [f32; 3], target: [f32; 3] },
    PointerRay { origin: [f32; 3], direction: [f32; 3], layers: Vec<String>, max_hits: Option<usize> },
    Quit,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
struct PickHit {
    layer: String,
    id: Option<String>,
    #[serde(rename = "distanceM")]
    distance_m: f32,
    point: [f32; 3],
}

fn ray_aabb(origin: Vec3, direction: Vec3, min: Vec3, max: Vec3) -> Option<f32> {
    let mut near: f32 = 0.0;
    let mut far: f32 = f32::INFINITY;
    for axis in 0..3 {
        let o = origin[axis];
        let d = direction[axis];
        if d.abs() < f32::EPSILON {
            if o < min[axis] || o > max[axis] { return None; }
            continue;
        }
        let inv = 1.0 / d;
        let mut a = (min[axis] - o) * inv;
        let mut b = (max[axis] - o) * inv;
        if a > b { std::mem::swap(&mut a, &mut b); }
        near = near.max(a);
        far = far.min(b);
        if near > far { return None; }
    }
    (far >= 0.0).then_some(near.max(0.0))
}

fn emit_pick(origin: Vec3, direction: Vec3, layers: &[String], max_hits: usize, query: &Query<(Entity, &Aabb, &GlobalTransform)>) {
    let mut hits: Vec<PickHit> = query.iter().filter_map(|(_entity, aabb, transform)| {
        let center = transform.transform_point(aabb.center.into());
        let extents = aabb.half_extents;
        let extents = Vec3::from(extents);
        let distance = ray_aabb(origin, direction, center - extents, center + extents)?;
        let layer = if layers.iter().any(|value| value == "map-static") { "map-static" } else { "ground" };
        Some(PickHit { layer: layer.into(), id: None, distance_m: distance, point: (origin + direction.normalize_or_zero() * distance).to_array() })
    }).collect();
    hits.sort_by(|a, b| a.distance_m.total_cmp(&b.distance_m));
    hits.truncate(max_hits.max(1));
    println!("{}", serde_json::json!({"event":"picked","hits":hits}));
}

#[cfg(test)]
mod pick_tests {
    use super::*;

    #[test]
    fn ray_hit_matches_shared_pick_shape() {
        let distance = ray_aabb(Vec3::new(0.0, 1.0, 5.0), Vec3::NEG_Z, Vec3::splat(-1.0), Vec3::splat(1.0)).unwrap();
        let hit = PickHit { layer: "ground".into(), id: None, distance_m: distance, point: [0.0, 1.0, 1.0] };
        assert_eq!(hit.layer, "ground");
        assert_eq!(hit.id, None);
        assert_eq!(hit.distance_m, 4.0);
        assert_eq!(serde_json::to_value(hit).unwrap()["distanceM"], 4.0);
    }
}

#[derive(Resource)]
struct ControlChannel(Mutex<Receiver<ControlCommand>>);

#[derive(Serialize)]
struct RendererEvent<'a> {
    event: &'a str,
    map_version_id: &'a str,
    release_digest: &'a str,
    renderer: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    elapsed_ms: Option<u128>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Resource)]
struct RuntimeState {
    args: Args,
    started: Instant,
    scene: Handle<Gltf>,
    announced_interactive: bool,
}

fn emit(state: &RuntimeState, event: &'static str, error: Option<String>) {
    let elapsed_ms = (event == "interactive").then(|| state.started.elapsed().as_millis());
    println!("{}", serde_json::to_string(&RendererEvent {
        event,
        map_version_id: &state.args.map_version_id,
        release_digest: &state.args.release_digest,
        renderer: "native-wgpu-bevy",
        elapsed_ms,
        error,
    }).expect("renderer event serializes"));
}
fn setup(mut commands: Commands, asset_server: Res<AssetServer>, args: Res<Args>) {
    let scene = asset_server.load::<Gltf>("master.gltf");
    commands.insert_resource(RuntimeState {
        args: args.clone(),
        started: Instant::now(),
        scene,
        announced_interactive: false,
    });
    if !args.headless {
        commands.spawn((Camera3d::default(), Transform::from_xyz(0.0, 25.0, 45.0).looking_at(Vec3::ZERO, Vec3::Y)));
        commands.spawn((DirectionalLight { illuminance: 20_000.0, shadow_maps_enabled: true, ..default() }, Transform::from_xyz(20.0, 40.0, 20.0).looking_at(Vec3::ZERO, Vec3::Y)));
    }
    println!("{}", serde_json::to_string(&RendererEvent {
        event: "manifest-ready",
        map_version_id: &args.map_version_id,
        release_digest: &args.release_digest,
        renderer: "native-wgpu-bevy",
        elapsed_ms: None,
        error: None,
    }).expect("renderer event serializes"));
}

fn load_scene(mut commands: Commands, mut state: ResMut<RuntimeState>, asset_server: Res<AssetServer>, gltfs: Res<Assets<Gltf>>) {
    if state.announced_interactive { return; }
    match asset_server.get_load_state(state.scene.id()) {
        Some(LoadState::Loaded) => {
            let Some(gltf) = gltfs.get(&state.scene) else { return; };
            let Some(scene) = gltf.default_scene.clone().or_else(|| gltf.scenes.first().cloned()) else {
                state.announced_interactive = true;
                emit(&state, "error", Some("native GLTF contains no scene".to_owned()));
                return;
            };
            commands.spawn(WorldAssetRoot(scene));
            state.announced_interactive = true;
            emit(&state, "interactive", None);
        }
        Some(LoadState::Failed(error)) => {
            state.announced_interactive = true;
            emit(&state, "error", Some(format!("native scene load failed: {error:?}")));
        }
        _ => {}
    }
}

fn orbit_camera(
    time: Res<Time>,
    keys: Res<ButtonInput<KeyCode>>,
    mut cameras: Query<&mut Transform, With<Camera3d>>,
) {
    let Ok(mut transform) = cameras.single_mut() else { return; };
    let mut direction = Vec3::ZERO;
    if keys.pressed(KeyCode::KeyW) { direction.z -= 1.0; }
    if keys.pressed(KeyCode::KeyS) { direction.z += 1.0; }
    if keys.pressed(KeyCode::KeyA) { direction.x -= 1.0; }
    if keys.pressed(KeyCode::KeyD) { direction.x += 1.0; }
    if direction != Vec3::ZERO { transform.translation += direction.normalize() * 20.0 * time.delta_secs(); }
}

fn control_system(channel: Res<ControlChannel>, mut cameras: Query<&mut Transform, With<Camera3d>>, bounds: Query<(Entity, &Aabb, &GlobalTransform)>, mut app_exit: MessageWriter<AppExit>) {
    let Ok(commands) = channel.0.lock() else { return; };
    for command in commands.try_iter() {
        match command {
            ControlCommand::Camera { position, target } => {
                let position = Vec3::from_array(position);
                let target = Vec3::from_array(target);
                if !position.is_finite() || !target.is_finite() || position.distance_squared(target) <= f32::EPSILON {
                    println!("{{\"event\":\"error\",\"error\":\"invalid camera pose\"}}");
                    continue;
                }
                if let Ok(mut camera) = cameras.single_mut() {
                    camera.translation = position;
                    camera.look_at(target, Vec3::Y);
                    println!("{{\"event\":\"camera-applied\"}}");
                }
            }
            ControlCommand::PointerRay { origin, direction, layers, max_hits } => {
                let origin = Vec3::from_array(origin);
                let direction = Vec3::from_array(direction);
                if !origin.is_finite() || !direction.is_finite() || direction.length_squared() <= f32::EPSILON {
                    println!("{{\"event\":\"error\",\"code\":\"invalid_pointer_ray\",\"message\":\"origin/direction must be finite and direction nonzero\"}}");
                } else {
                    emit_pick(origin, direction.normalize(), &layers, max_hits.unwrap_or(8), &bounds);
                }
            }
            ControlCommand::Quit => { app_exit.write(AppExit::Success); }
        }
    }
}

fn main() -> Result<()> {
    let args = Args::parse();
    let asset_root = args.map_root.to_string_lossy().to_string();
    let (control_tx, control_rx) = mpsc::channel();
    thread::spawn(move || {
        for line in io::stdin().lock().lines().flatten() {
            if let Ok(command) = serde_json::from_str::<ControlCommand>(&line) {
                if control_tx.send(command).is_err() { break; }
            }
        }
    });
    let mut app = App::new();
    app.insert_resource(args.clone());
    app.insert_resource(ControlChannel(Mutex::new(control_rx)));
    if args.headless {
        app.add_plugins(DefaultPlugins
            .set(AssetPlugin { file_path: asset_root, unapproved_path_mode: UnapprovedPathMode::Allow, ..default() })
            .set(WindowPlugin { primary_window: None, exit_condition: ExitCondition::DontExit, ..default() })
            .disable::<bevy::winit::WinitPlugin>()
            .disable::<bevy::audio::AudioPlugin>());
        app.add_plugins(ScheduleRunnerPlugin::run_loop(std::time::Duration::from_secs_f64(1.0 / 60.0)));
    } else {
        app.add_plugins(DefaultPlugins.set(AssetPlugin { file_path: asset_root, unapproved_path_mode: UnapprovedPathMode::Allow, ..default() }));
    }
    app.add_systems(Startup, setup);
    app.add_systems(Update, (load_scene, orbit_camera, control_system));
    app.run();
    Ok(())
}
