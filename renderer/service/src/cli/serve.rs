//! `simforge-render serve`: the long-lived render service (protocol 5).
//!
//! Prewarms one map, then serves (scene-state tick, rig) requests over a
//! local endpoint with frames handed off through a memory-mapped ring file.
//! Batch jobs (`render_bundle`) and closed-loop episodes
//! (`reset_episode` / `step_episode`) are the same service.
//!
//! Usage:
//!   simforge-render serve --scene <scene.json> --socket <endpoint>
//!       [--shm <ring file>] [--shm-size-mb 256] [--ready-file <path>]
//!       [--preset training|showcase] [--set key=value ...] [--print-render-config]
//!
//! `--socket` is a Unix-domain socket path on Linux/macOS and a local
//! named-pipe endpoint (`\\.\pipe\<name>`) on Windows; see
//! `crate::endpoint`. `--shm` defaults to `/dev/shm` on Linux and the OS
//! temp directory elsewhere. `--ready-file` receives a JSON record
//! (`crate::server::ReadyRecord`) once the endpoint accepts connections.
use anyhow::{Context, Result};
use crate::proto::NATIVE_SERVICE_PROTOCOL_VERSION;
use crate::server::{prewarm, serve, ServiceState};
use crate::shm::{default_ring_path, ShmRing};
use std::path::PathBuf;

pub fn run(args: Vec<String>) -> Result<()> {
    let mut args = args.into_iter();
    let mut socket = None;
    let mut shm_path: Option<PathBuf> = None;
    let mut shm_size_mb = 256u64;
    let mut scene_path = None;
    let mut ready_file: Option<PathBuf> = None;
    let mut preset: Option<String> = None;
    let mut sets: Vec<String> = Vec::new();
    let mut print_render_config = false;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--help" | "-h" => {
                println!("simforge-render serve --scene SCENE.json --socket ENDPOINT [--shm PATH] [--shm-size-mb 256] [--ready-file PATH]\n\
                    [--preset training|showcase] [--set key=value ...] [--print-render-config]\n\
                    Synchronous v5 MessagePack request/response with shared-memory frames; no background simulation clock.\n\
                    Batch jobs (render_bundle) and closed-loop episodes (reset_episode/step_episode; python -m simforge_render.closed_loop) share this service.\n\
                    The look is one RenderConfig: --preset training|showcase plus --set overrides (or `render` in the scene spec).");
                return Ok(());
            }
            "--socket" => socket = Some(args.next().context("--socket requires an endpoint")?),
            "--shm" => shm_path = Some(args.next().context("--shm requires a path")?.into()),
            "--shm-size-mb" => {
                shm_size_mb = args.next().context("--shm-size-mb requires a number")?.parse()?;
            }
            "--scene" => scene_path = Some(args.next().context("--scene requires a path")?),
            "--ready-file" => {
                ready_file = Some(args.next().context("--ready-file requires a path")?.into());
            }
            "--preset" => preset = Some(args.next().context("--preset requires training | showcase")?),
            "--set" => sets.push(args.next().context("--set requires key=value")?),
            "--print-render-config" => print_render_config = true,
            other => anyhow::bail!("unknown argument {other}"),
        }
    }
    let scene_path = scene_path.context("missing --scene")?;
    let mut spec: crate::server::SceneSpec = serde_json::from_str(
        &std::fs::read_to_string(&scene_path).with_context(|| format!("read {scene_path}"))?,
    )
    .with_context(|| format!("parse {scene_path}"))?;
    crate::server::apply_render_cli(&mut spec, preset, &sets)?;
    if print_render_config {
        let (config, deprecations) = spec.render_config()?;
        println!("{}", serde_json::to_string_pretty(&serde_json::json!({
            "renderConfig": config,
            "keys": config.keys()?.into_iter().map(|(key, value)| (key, value)).collect::<serde_json::Map<_, _>>(),
            "deprecations": deprecations,
        }))?);
        return Ok(());
    }
    let socket = socket.context("missing --socket")?;
    let shm_path = shm_path.unwrap_or_else(|| {
        default_ring_path(&format!("simforge-native-render.{pid}", pid = std::process::id()))
    });
    eprintln!(
        "simforge-render serve v{} prewarming {} tiles...",
        NATIVE_SERVICE_PROTOCOL_VERSION,
        spec.glbs.len(),
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
