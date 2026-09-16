use anyhow::Result;
use bevy::app::ScheduleRunnerPlugin;
use bevy::asset::{LoadState, UnapprovedPathMode};
use bevy::gltf::Gltf;
use bevy::prelude::*;
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

fn control_system(channel: Res<ControlChannel>, mut cameras: Query<&mut Transform, With<Camera3d>>, mut app_exit: MessageWriter<AppExit>) {
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
            ControlCommand::PointerRay { .. } => println!("{{\"event\":\"error\",\"code\":\"native_pick_not_implemented\",\"message\":\"native pointer picking is not implemented\"}}"),
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
