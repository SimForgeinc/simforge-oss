//! `native-render-service` — long-lived native render service (WSB5).
//!
//! Prewarms one map, then serves (scene-state tick, rig) requests over a
//! local endpoint with frames handed off through a memory-mapped ring file.
//!
//! Usage:
//!   native-render-service --scene <scene.json> --socket <endpoint>
//!       [--shm <ring file>] [--shm-size-mb 256] [--ready-file <path>]
//!
//! `--socket` is a Unix-domain socket path on Linux/macOS and a local
//! named-pipe endpoint (`\\.\pipe\<name>`) on Windows; see
//! `service::endpoint`. `--shm` defaults to `/dev/shm` on Linux and the OS
//! temp directory elsewhere. `--ready-file` receives a JSON record
//! (`service::server::ReadyRecord`) once the endpoint accepts connections.
//!
//! scene.json: { glbs: [...], profile: "sensor"|"cinematic", lighting?: {...},
//!               nearM?, farM?, warmupFrames?, sensorCacheDir? }
//!
//!   native-render-service --scene <scene.json> --build-sensor-cache
//!
//! loads the map, builds (or verifies) its content-addressed static sensor
//! scenes in `sensorCacheDir`, prints one JSON line and exits: the worker's
//! prewarm runs it so no render job pays the first-lidar BVH build.
use anyhow::{Context, Result};
use service::proto::NATIVE_SERVICE_PROTOCOL_VERSION;
use service::server::{prewarm, serve, ServiceState};
use service::shm::{default_ring_path, ShmRing};
use std::path::PathBuf;

fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let mut socket = None;
    let mut shm_path: Option<PathBuf> = None;
    let mut shm_size_mb = 256u64;
    let mut scene_path = None;
    let mut ready_file: Option<PathBuf> = None;
    let mut build_sensor_cache = false;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--help" | "-h" => {
                println!("native-render-service --scene SCENE.json --socket ENDPOINT [--shm PATH] [--shm-size-mb 256] [--ready-file PATH]\n\
                    Synchronous v5 MessagePack request/response with shared-memory frames; no background simulation clock.\n\
                    Closed loop: python -m simforge_native.closed_loop --help. reset_episode/step_episode use typed ConsumerSpec products.\n\
                    Two output modes: sensor-capture --profile training|showcase; describe_products exposes their typed defaults.\n\
                    This resident SceneApp engine supports model catalogs but is not sensor-capture's qualified shared-shadow/ring backend.\n\
                    Scene lighting 'sensor|cinematic' is a legacy visual control, NOT an output mode; policy cameras always use cinematic.");
                return Ok(());
            }
            "--socket" => socket = Some(args.next().context("--socket requires an endpoint")?),
            "--shm" => shm_path = Some(args.next().context("--shm requires a path")?.into()),
            "--shm-size-mb" => {
                shm_size_mb = args.next().context("--shm-size-mb requires a number")?.parse()?;
            }
            "--scene" => scene_path = Some(args.next().context("--scene requires a path")?),
            "--build-sensor-cache" => build_sensor_cache = true,
            "--ready-file" => {
                ready_file = Some(args.next().context("--ready-file requires a path")?.into());
            }
            other => anyhow::bail!("unknown argument {other}"),
        }
    }
    let scene_path = scene_path.context("missing --scene")?;
    let mut spec: service::server::SceneSpec = serde_json::from_str(
        &std::fs::read_to_string(&scene_path).with_context(|| format!("read {scene_path}"))?,
    )
    .with_context(|| format!("parse {scene_path}"))?;
    if build_sensor_cache {
        anyhow::ensure!(spec.sensor_cache_dir.is_some(), "--build-sensor-cache needs sensorCacheDir in the scene");
        spec.warmup_frames = 0;
        let t0 = std::time::Instant::now();
        let app = prewarm(&spec)?;
        let loaded_s = t0.elapsed().as_secs_f64();
        let ring = default_ring_path(&format!("simforge-sensor-cache.{pid}", pid = std::process::id()));
        let shm = ShmRing::create(&ring, 1 << 20)?;
        let mut state = ServiceState::new(app, &spec, ring.to_string_lossy().into_owned(), shm)?;
        state.sync_sensor_cache_writes = true;
        let t1 = std::time::Instant::now();
        let outcome = state.ensure_sensor_scenes_outcome().map_err(anyhow::Error::msg)?;
        let _ = std::fs::remove_file(&ring);
        println!(
            "{}",
            serde_json::json!({
                "schema": "simforge.native-sensor-cache/v1",
                "key": outcome.key,
                "cached": outcome.loaded,
                "triangles": outcome.triangles,
                "sceneLoadS": loaded_s,
                "sensorScenesS": t1.elapsed().as_secs_f64(),
            })
        );
        // The Bevy app owns device threads; the process exit is the teardown.
        std::process::exit(0);
    }
    let socket = socket.context("missing --socket")?;
    let shm_path = shm_path.unwrap_or_else(|| {
        default_ring_path(&format!("simforge-native-render.{pid}", pid = std::process::id()))
    });
    eprintln!(
        "native-render-service v{} prewarming {} tiles (profile {:?})...",
        NATIVE_SERVICE_PROTOCOL_VERSION,
        spec.glbs.len(),
        spec.profile
    );
    let t0 = std::time::Instant::now();
    let app = prewarm(&spec)?;
    eprintln!("prewarmed in {:.1} s", t0.elapsed().as_secs_f64());

    // Round capacity up to a multiple that fits whole frame sets; the ring is
    // large enough for many 736x416 RGBA + f32 depth records by default.
    let capacity = (shm_size_mb * 1024 * 1024) as usize;
    let shm = ShmRing::create(&shm_path, capacity)?;
    let state = ServiceState::new(app, &spec, shm_path.to_string_lossy().into_owned(), shm)?;
    serve(state, &socket, ready_file.as_deref())?;
    Ok(())
}
