//! `simforge env serve`: closed-loop episodes of a workspace over a Unix
//! socket (`simforge.env-serve/v1`), with rendered sensors.
//!
//! The episode is the Python SDK's: simforge-bindings-common's `Env` over
//! simforge-session's `EnvSession`, on the scenario input the workspace's
//! resolution records and the installed map it was simulated on. The action
//! row, observation layout, info channel and checkpoints are the `_native`
//! session's, byte for byte; only the transport differs.
//!
//! With `--rig`, every reset/step/observe also renders the current state in
//! process: the scene assembled exactly as `simforge render` assembles it
//! (staged texture tier, derivatives, lighting at the map's site, the actor
//! closure bound), fed one scene-state frame per instant
//! (`env_serve::frames`). `--no-sensors` serves the episode alone, on the CPU.
//!
//! stdout carries one JSON line once the socket is listening
//! (`{schema, socket, pid, ...}`), the command's one result document; the
//! renderer's diagnostics go to `--log`. The server runs until a client
//! sends `close`, or until SIGINT/SIGTERM, and exits 0, removing its socket.

use std::path::{Path, PathBuf};

use clap::{Args, Subcommand};
use serde_json::{json, Value};

use super::render::{Pass, Textures};
use super::Preset;
use crate::contract::{emit, CliError, CmdResult, Ctx, Exit, Outcome};
use crate::installed_maps::{self, TOPOLOGY, XODR};
use crate::paths;
use crate::render::actor_assets::ActorAppearance;
use crate::render::rig::{self, Rig};
use crate::render::scene_setup::{self, Warnings};
use crate::render::signal_heads::signal_head_guids;
use crate::render::textures::TextureTier;
use crate::workspace::{Workspace, RESOLUTION};

#[derive(Debug, Subcommand)]
pub enum EnvCommand {
    /// Serve reset/step/observe episodes with rendered sensors over a Unix socket.
    Serve(ServeArgs),
}

#[derive(Debug, Args)]
pub struct ServeArgs {
    /// The workspace directory (an imported scenario package).
    #[arg(value_name = "WORKSPACE")]
    pub workspace: PathBuf,
    /// The Unix socket to listen on (refused if another server is live on it).
    #[arg(long, value_name = "PATH")]
    pub socket: PathBuf,
    /// The sensor rig (`simforge.render-rig/v1`, as `simforge render` takes it).
    #[arg(long, value_name = "RIG.JSON", required_unless_present = "no_sensors")]
    pub rig: Option<PathBuf>,
    /// Serve the episode without a renderer (observations are the engine's only).
    #[arg(long, conflicts_with = "rig")]
    pub no_sensors: bool,
    /// The render preset for observations.
    #[arg(long, value_enum, default_value = "training")]
    pub preset: Preset,
    /// Camera passes rendered per observation, comma-separated.
    #[arg(long, value_enum, value_delimiter = ',', default_value = "rgb")]
    pub passes: Vec<Pass>,
    /// The staged texture tier.
    #[arg(long, value_enum, default_value = "uastc-full")]
    pub textures: Textures,
    /// Episode configuration (camelCase `EpisodeConfig`, as the gym's episode specs carry it).
    #[arg(long, value_name = "EPISODE.JSON")]
    pub episode: Option<PathBuf>,
    /// Policy decisions per second (overrides the episode's `decisionHz`).
    #[arg(long, value_name = "HZ")]
    pub decision_hz: Option<u32>,
    /// Rows of the `objects` observation.
    #[arg(long, value_name = "N", default_value_t = simforge_bindings_common::DEFAULT_MAX_OBJECTS)]
    pub max_objects: usize,
    /// Render on a software (CPU) Vulkan adapter such as lavapipe, explicitly.
    #[arg(long)]
    pub allow_software_adapter: bool,
    /// Use this map directory instead of the installed map found by content.
    #[arg(long, value_name = "DIR")]
    pub map_dir: Option<PathBuf>,
    /// Map cache root to search. Default: SIMFORGE_MAPS_CACHE_ROOT, then $XDG_DATA_HOME/simforge/maps.
    #[arg(long, value_name = "DIR")]
    pub cache_root: Option<PathBuf>,
    /// Actor-asset root. Default: SIMFORGE_ACTOR_ASSETS_ROOT, then $XDG_DATA_HOME/simforge/actor-assets.
    #[arg(long, value_name = "DIR")]
    pub assets_root: Option<PathBuf>,
    /// The actor closure to bind, instead of the workspace's `catalog.actorClosureDigest`.
    #[arg(long, value_name = "SHA256")]
    pub actor_closure: Option<String>,
    /// A texture budget in bytes; without it admission is skipped (reported).
    #[arg(long, value_name = "BYTES")]
    pub vram_budget: Option<u64>,
    /// Where the renderer's diagnostics go. Default: `<socket>.log`.
    #[arg(long, value_name = "FILE")]
    pub log: Option<PathBuf>,
    /// Render on the installed map release even where its members differ from the
    /// workspace's map closure (recorded; the default refuses).
    #[arg(long)]
    pub allow_map_drift: bool,
    /// Size of the renderer's shared-memory frame ring, MiB.
    #[arg(long, value_name = "MIB", default_value_t = 512)]
    pub shm_size_mb: u64,
}

pub fn run(command: EnvCommand, ctx: &Ctx) -> CmdResult {
    match command {
        EnvCommand::Serve(args) => serve(args, ctx),
    }
}

fn read_plain(path: &Path) -> Result<Vec<u8>, CliError> {
    use std::io::Read;
    let bytes = std::fs::read(path).map_err(|e| {
        CliError::findings(
            "workspace_member_missing",
            format!("cannot read {}: {e}", path.display()),
        )
        .with_path(path.display().to_string())
    })?;
    if !bytes.starts_with(&[0x1f, 0x8b]) {
        return Ok(bytes);
    }
    let mut out = Vec::new();
    flate2::read::GzDecoder::new(bytes.as_slice())
        .read_to_end(&mut out)
        .map_err(|e| CliError::findings("workspace_invalid", format!("{}: {e}", path.display())))?;
    Ok(out)
}

/// The scenario input the workspace's resolution records, checked against
/// its recorded digest.
fn resolved_input(ws: &Workspace) -> Result<Value, CliError> {
    let path = ws.member(RESOLUTION);
    let invalid = |reason: String| {
        CliError::findings("resolution_invalid", reason).with_path(path.display().to_string())
    };
    let resolution: Value = serde_json::from_slice(&read_plain(&path)?)
        .map_err(|e| invalid(format!("{RESOLUTION} is not JSON: {e}")))?;
    if resolution["contract"] != super::simulate::RESOLUTION_CONTRACT {
        return Err(invalid(format!(
            "{RESOLUTION} has contract {}, expected {}",
            resolution["contract"],
            super::simulate::RESOLUTION_CONTRACT
        )));
    }
    let input = resolution
        .get("resolvedInput")
        .filter(|v| v.is_object())
        .cloned()
        .ok_or_else(|| invalid("the resolution has no resolvedInput".into()))?;
    let recorded = resolution["resolvedInputDigest"]
        .as_str()
        .ok_or_else(|| invalid("the resolution has no resolvedInputDigest".into()))?;
    let digest = simforge_core::hash::content_hash(&input)
        .map_err(|e| invalid(format!("resolvedInput: {e}")))?;
    if digest != recorded {
        return Err(invalid(format!(
            "resolvedInput digests to {digest}, but the record says {recorded}"
        )));
    }
    Ok(input)
}

/// `--episode` with `--decision-hz` applied.
fn episode_json(args: &ServeArgs) -> Result<Option<String>, CliError> {
    let mut config = match &args.episode {
        None => serde_json::Map::new(),
        Some(path) => {
            let bytes = std::fs::read(path).map_err(|e| {
                CliError::new(
                    "missing_file",
                    format!("cannot read --episode {}: {e}", path.display()),
                )
                .with_path("--episode")
            })?;
            match serde_json::from_slice(&bytes) {
                Ok(Value::Object(map)) => map,
                Ok(_) => {
                    return Err(
                        CliError::new("bad_value", "--episode must hold a JSON object")
                            .with_path("--episode"),
                    )
                }
                Err(e) => {
                    return Err(
                        CliError::new("bad_value", format!("--episode is not JSON: {e}"))
                            .with_path("--episode"),
                    )
                }
            }
        }
    };
    if let Some(hz) = args.decision_hz {
        config.insert("decisionHz".into(), json!(hz));
    }
    Ok((!config.is_empty()).then(|| Value::Object(config).to_string()))
}

fn binding(e: simforge_bindings_common::BindingError) -> CliError {
    CliError::new("episode_invalid", e.to_string())
}

#[cfg(not(unix))]
fn serve(_args: ServeArgs, _ctx: &Ctx) -> CmdResult {
    Err(CliError::new(
        "unsupported_platform",
        "`simforge env serve` listens on a Unix socket; this platform has none",
    ))
}

#[cfg(unix)]
fn serve(args: ServeArgs, _ctx: &Ctx) -> CmdResult {
    use crate::env_serve::frames::FrameBuilder;
    use crate::env_serve::sensors::Sensors;
    use crate::env_serve::server::{self, Rendering, Server};
    use simforge_bindings_common::runtime::{Env, MapAsset, Scenario};

    let socket = paths::absolutize(&args.socket);
    let mut warnings = Warnings::default();

    // The episode.
    let ws = Workspace::open(&args.workspace)?;
    let input_value = resolved_input(&ws)?;
    let want_xodr = ws.xodr_sha256()?.to_owned();
    let map_id = input_value["mapId"].as_str().unwrap_or_default().to_owned();
    let world_dir = match &args.map_dir {
        Some(dir) => paths::absolutize(dir),
        None => {
            let root = paths::maps_root(args.cache_root.as_deref())?;
            installed_maps::find_by_xodr(&root.value, &want_xodr, Some(&map_id))?.dir
        }
    };
    let world = installed_maps::describe(&world_dir, "world").ok_or_else(|| {
        CliError::new(
            "map_not_found",
            format!("{} has no {XODR}", world_dir.display()),
        )
    })?;
    if world.xodr_sha256 != want_xodr {
        return Err(CliError::findings(
            "map_mismatch",
            format!("{} holds an OpenDRIVE with sha256 {}, but the workspace was simulated on {want_xodr}", world_dir.display(), world.xodr_sha256),
        ));
    }
    let asset = MapAsset::load(&world_dir).map_err(|e| {
        CliError::findings("map_invalid", e.to_string()).with_path(world_dir.display().to_string())
    })?;
    let scenario = Scenario::parse(input_value.to_string().as_bytes()).map_err(binding)?;
    let mut env = Env::new(
        &scenario,
        asset.graph(),
        episode_json(&args)?.as_deref(),
        args.max_objects,
    )
    .map_err(binding)?;

    // The renderer.
    let mut capture = None;
    let log = args
        .log
        .clone()
        .unwrap_or_else(|| PathBuf::from(format!("{}.log", socket.display())));
    let mut hello_extra =
        json!({ "workspace": ws.dir, "map": { "dir": world_dir, "xodrSha256": want_xodr } });
    let rendering = match &args.rig {
        None => None,
        Some(rig_path) => {
            if args.allow_software_adapter {
                std::env::set_var("SIMFORGE_NATIVE_ALLOW_SOFTWARE_ADAPTER", "1");
            }
            let tier = match args.textures {
                Textures::UastcFull => TextureTier::UastcFull,
                Textures::Bc7_512 => TextureTier::Bc7_512,
            };
            let rig_json: Value =
                serde_json::from_slice(&std::fs::read(rig_path).map_err(|e| {
                    CliError::new(
                        "missing_file",
                        format!("cannot read --rig {}: {e}", rig_path.display()),
                    )
                    .with_path("--rig")
                })?)
                .map_err(|e| {
                    CliError::findings("render_rig_invalid", format!("--rig is not JSON: {e}"))
                        .with_path("--rig")
                })?;
            let rig = Rig::parse(&rig_json)?;
            rig::assert_native_sources_supported(&rig.sources)?;
            rig::assert_native_radar_budgets(&rig.sources)?;
            if rig.clip.is_some() || rig.video.is_some() {
                warnings.push("env_rig_clip_video_ignored", "the rig's clip and video apply to offline renders; a closed-loop episode renders every decision");
            }
            let map = scene_setup::native_map(
                &want_xodr,
                &map_id,
                args.map_dir.as_deref(),
                args.cache_root.as_deref(),
            )?;
            let closure = scene_setup::open_closure(&map, tier, &mut warnings)?;
            let drift = scene_setup::check_map_drift(
                &ws,
                &closure,
                &map,
                args.allow_map_drift,
                &mut warnings,
            )?;
            hello_extra["map"]["drift"] = json!(drift);
            let xodr_text = scene_setup::xodr_text(&map)?;
            let (sky, _) = scene_setup::sky_assets()?;
            hello_extra["sky"] = json!(sky.dir);
            let derived = scene_setup::plan_derivatives(&closure, tier, false, &mut warnings)?;
            let profile = scene_setup::stage_textures(
                &closure,
                tier,
                scene_setup::frame_pixels(&rig.sources, None),
                args.vram_budget,
                &derived,
                &mut warnings,
            )?;

            // Heights: the engine's contact on a grounded world, else the
            // OpenDRIVE elevation (the timeline's legacy source).
            let height = match asset.graph().ground() {
                Some(_) => None,
                None => {
                    let topology = std::fs::read(map.file(TOPOLOGY)).map_err(|e| {
                        CliError::new(
                            "missing_file",
                            format!("cannot read {}: {e}", map.file(TOPOLOGY).display()),
                        )
                    })?;
                    Some(
                        simforge_core::trace::timeline::HeightField::from_xodr(
                            xodr_text.as_bytes(),
                            &topology,
                        )
                        .map_err(|e| CliError::findings("map_invalid", format!("height: {e}")))?,
                    )
                }
            };
            let mut frames = FrameBuilder::new(
                scenario.input(),
                height,
                std::sync::Arc::clone(asset.graph().lane_graph()),
                signal_head_guids(&xodr_text),
            )?;
            let catalog = |id: &str| frames.actors().get(id).map(|m| m.catalog_id.clone());
            let (hosts, hosts_derived) = rig.sensor_hosts(catalog)?;
            if hosts_derived {
                warnings.push("render_sensor_hosts_derived", "the rig names no sensorHosts; each source is hosted by its own actorId with that actor's catalog id");
            }
            // The initial instant (default seed) places the cameras for the
            // luminaire order and checks the rig against the scene.
            env.reset(None).map_err(binding)?;
            let first = frames.frame(&env)?;
            frames.restart();
            let schedule =
                rig::camera_schedule(&rig.sources, &hosts, std::slice::from_ref(&first))?;
            let cameras: Vec<Value> = schedule[0].iter().map(|c| c.json.clone()).collect();
            let eyes: Vec<[f64; 3]> = schedule[0].iter().map(|c| c.eye).collect();
            let (lidars, radars) = rig::sensor_rigs(&rig.sources, &hosts)?;
            let (near_m, far_m) = rig::camera_clip_planes(&rig.sources)?;
            let appearances: Vec<ActorAppearance> = frames
                .actors()
                .iter()
                .map(|(id, m)| ActorAppearance {
                    actor_id: id.clone(),
                    kind: Some(m.kind_name.clone()),
                    catalog_id: m.catalog_id.clone(),
                    authored: m.authored,
                })
                .collect();
            let digest = scene_setup::actor_closure_digest(&ws, args.actor_closure.as_deref())?;
            let assets = scene_setup::bind_actor_assets(
                &digest,
                args.assets_root.as_deref(),
                &appearances,
                &hosts,
                std::slice::from_ref(&first),
            )?;
            let rgb_fps: Vec<f64> = vec![f64::from(env.decision_hz())];
            let (lighting, provenance) = scene_setup::scene_lighting(
                &ws,
                &xodr_text,
                &map_id,
                &rgb_fps,
                derived.luminaires.as_ref(),
                &eyes,
                &mut warnings,
            )?;
            let ground = closure
                .path(crate::installed_maps::GROUND_MESH)
                .map(Path::to_path_buf);
            let scene = scene_setup::scene_spec(&scene_setup::SpecInput {
                profile: &profile,
                lighting,
                near_m,
                far_m,
                models_dir: &assets.directory,
                preset: args.preset.as_str(),
                tier,
                derivatives: &derived,
                residency_path: None,
                ground_mesh: ground.as_deref(),
            });
            let passes: Vec<String> = args.passes.iter().map(|p| p.as_str().to_owned()).collect();
            capture = Some(
                crate::render::job_runner::StderrCapture::start(&log).map_err(|e| {
                    CliError::new(
                        "write_failed",
                        format!("cannot open --log {}: {e}", log.display()),
                    )
                })?,
            );
            let sensors = Sensors::start(
                scene,
                cameras.clone(),
                lidars,
                radars,
                passes.clone(),
                args.shm_size_mb,
            )?;
            let describe: Vec<Value> = rig
                .sources
                .iter()
                .map(|s| match s.rgb() {
                    Some(c) => json!({ "sourceId": s.output_name(), "modality": "rgb", "width": c.attributes.width, "height": c.attributes.height, "passes": passes }),
                    None => json!({ "sourceId": s.output_name(), "modality": s.modality() }),
                })
                .collect();
            hello_extra["preset"] = json!(args.preset.as_str());
            hello_extra["textures"] = json!(tier.as_str());
            hello_extra["renderConfig"] = sensors.render_config.clone();
            hello_extra["lighting"] = provenance;
            hello_extra["actorAssets"] = assets.evidence();
            hello_extra["log"] = json!(log);
            hello_extra["softwareAdapter"] = json!(args.allow_software_adapter);
            Some(Rendering {
                sensors,
                frames,
                describe: json!(describe),
            })
        }
    };

    let listener = server::bind(&socket)?;
    let mut cleanup = vec![socket.clone()];
    if let Some(r) = &rendering {
        cleanup.push(r.sensors.shm_path().to_path_buf());
    }
    server::install_signal_handlers(&cleanup);
    emit(
        &json!({
            "schema": "simforge.env-serve-ready/v1",
            "protocol": crate::env_serve::wire::PROTOCOL,
            "socket": socket,
            "pid": std::process::id(),
            "ego": env.ego(),
            "decisionHz": env.decision_hz(),
            "sensors": rendering.is_some(),
            "log": rendering.as_ref().map(|_| json!(log)),
            "warnings": warnings.0,
        }),
        false,
    );
    let mut server = Server::new(env, rendering, hello_extra, warnings.0);
    let served = server::serve(&mut server, &listener);
    drop(server);
    drop(capture);
    let _ = std::fs::remove_file(&socket);
    served.map_err(|e| {
        CliError::new(
            "socket_failed",
            format!("serving {}: {e}", socket.display()),
        )
    })?;
    Ok(Outcome::already_emitted(Exit::Ok))
}
