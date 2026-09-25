//! `simforge render`: one offline render of a workspace, through the
//! renderer's own job path.
//!
//! The pipeline is the platform worker's native engine
//! (packages/render/src/native/engine.ts), step for step, over local inputs:
//!
//! 1. the render timeline (built from the workspace trace on its pinned
//!    height source; `timeline build`);
//! 2. the installed native map (found by the trace's OpenDRIVE digest), its
//!    texture tier staged, and its derivatives planned (geometry LOD, road
//!    decals, luminaires, texture residency);
//! 3. the rig (`simforge.render-rig/v1`: the hosted intent's sources and
//!    sensor hosts), fixed schedules, the timeline lowered to scene-state
//!    frames at the union of the camera frame times, the camera schedule;
//! 4. the actor closure the workspace pins, verified and bound (every actor
//!    and sensor host grounded in a model, every animated actor's clips);
//! 5. the scenario's lighting at the map's site, with its street luminaires;
//! 6. the contact gate (every wheel on the rendered ground);
//! 7. one `simforge.render-job/v2`, rendered in process by render_service
//!    (frames, id/depth/semantic passes, lidar PLY, radar CSV, results.json);
//! 8. the parity gate (the renderer drew every actor where the sampler says);
//! 9. one video per sensor with ffmpeg when it is installed (recorded as
//!    skipped when it is not).
//!
//! Nothing is substituted silently: a missing derivative, ground, luminaire
//! or encoder is a warning in the result or an error, never a quiet default.

use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Instant;

use clap::{Args, ValueEnum};
use serde_json::{json, Value};

use super::timeline::{self as timeline_cmd, HeightChoice};
use super::Preset;
use crate::contract::{CliError, CmdResult, Ctx, Outcome};
use crate::installed_maps::GROUND_MESH;
use crate::paths;
use crate::render::actor_assets::ActorAppearance;
use crate::render::derivatives;
use crate::render::gates;
use crate::render::job_runner;
use crate::render::lowering::{self, lower_timeline};
use crate::render::residency::{self, ResidencyCamera};
use crate::render::rig::{self, Clip, RenderSource, Rig};
use crate::render::scene_setup::{self, Warnings};
use crate::render::schedule::{self, CameraFormat, FixedSchedule};
use crate::render::sensor_video::{
    parse_lidar_ply, parse_radar_csv, LidarVideoRasterizer, RadarVideoRasterizer,
};
use crate::render::signal_heads::signal_head_guids;
use crate::render::textures::TextureTier;
use crate::render::video::{self, FfmpegResolution, VideoCodec, VideoEncoder, VideoFormat};
use crate::workspace::{Workspace, TRACE};

/// The render result document.
pub const CLI_RENDER_SCHEMA: &str = "simforge.cli-render/v1";

/// Camera passes a render writes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum Pass {
    Rgb,
    Id,
    Depth,
    Semantic,
}

impl Pass {
    pub fn as_str(self) -> &'static str {
        match self {
            Pass::Rgb => "rgb",
            Pass::Id => "id",
            Pass::Depth => "depth",
            Pass::Semantic => "semantic",
        }
    }
}

/// The staged texture tier.
#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum Textures {
    /// Full-resolution UASTC textures (the platform default).
    UastcFull,
    /// 512 px BC7 textures (about a fifth of the texture memory; ML quality).
    Bc7_512,
}

/// Whether to encode videos.
#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum VideoMode {
    /// Encode when ffmpeg is installed; record the videos as skipped when it is not.
    Auto,
    /// Fail when ffmpeg is missing.
    Required,
    /// Write frames only (recorded as skipped: off).
    Off,
}

#[derive(Debug, Args)]
pub struct RenderArgs {
    /// The workspace directory (an imported scenario package).
    #[arg(value_name = "WORKSPACE")]
    pub workspace: PathBuf,
    /// The render preset.
    #[arg(long, value_enum)]
    pub preset: Preset,
    /// The sensor rig (`simforge.render-rig/v1`: the hosted render's sources, sensorHosts, clip and video).
    /// Default: one front RGB camera (1280x720, 20 fps, 90 degree FOV) on the scenario's first actor
    /// (the first authored actor by id, else the first actor), recorded in render.json and results.json.
    #[arg(long, value_name = "RIG.JSON")]
    pub rig: Option<PathBuf>,
    /// Output directory (created; must be empty if it exists).
    #[arg(long, value_name = "DIR")]
    pub out: PathBuf,
    /// Camera passes, comma-separated.
    #[arg(
        long,
        value_enum,
        value_delimiter = ',',
        default_value = "rgb,id,depth,semantic"
    )]
    pub passes: Vec<Pass>,
    /// Render-config overrides on the preset (`key=value`, e.g. `aa.mode=fxaa`); repeatable.
    #[arg(long = "set", value_name = "KEY=VALUE")]
    pub sets: Vec<String>,
    /// The staged texture tier.
    #[arg(long, value_enum, default_value = "uastc-full")]
    pub textures: Textures,
    /// Encode videos with ffmpeg.
    #[arg(long, value_enum, default_value = "auto")]
    pub video: VideoMode,
    /// A texture budget in bytes; without it the device capacity is unmeasured and admission is skipped (reported).
    #[arg(long, value_name = "BYTES")]
    pub vram_budget: Option<u64>,
    /// Render on a software (CPU) Vulkan adapter such as lavapipe, explicitly. Slow; pixels differ from a GPU's.
    #[arg(long)]
    pub allow_software_adapter: bool,
    /// Use this native map directory (`.corpus/<map>`) instead of the installed map found by content.
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
    /// Render on the installed map release even where its members differ from the
    /// workspace's map closure (recorded in the result; the default refuses).
    #[arg(long)]
    pub allow_map_drift: bool,
}

fn write_json(path: &Path, value: &Value) -> Result<(), CliError> {
    let bytes = serde_json::to_vec_pretty(value).expect("JSON values serialize");
    std::fs::write(path, bytes).map_err(|e| {
        CliError::new(
            "write_failed",
            format!("cannot write {}: {e}", path.display()),
        )
        .with_path(path.display().to_string())
    })
}

fn prepare_out(out: &Path) -> Result<PathBuf, CliError> {
    let out = paths::absolutize(out);
    if out.exists() {
        let mut entries = std::fs::read_dir(&out).map_err(|e| {
            CliError::new(
                "bad_value",
                format!("--out {} is not a directory: {e}", out.display()),
            )
            .with_path("--out")
        })?;
        if entries.next().is_some() {
            return Err(CliError::new(
                "out_not_empty",
                format!(
                    "--out {} exists and is not empty; renders never overwrite",
                    out.display()
                ),
            )
            .with_path("--out"));
        }
    }
    std::fs::create_dir_all(out.join("job")).map_err(|e| {
        CliError::new(
            "write_failed",
            format!("cannot create {}: {e}", out.display()),
        )
    })?;
    Ok(out)
}

fn micros(seconds: f64) -> i64 {
    simforge_core::math::js_round(seconds * 1_000_000.0) as i64
}

pub fn run(args: RenderArgs, _ctx: &Ctx) -> CmdResult {
    let started = Instant::now();
    let mut stages: BTreeMap<&str, f64> = BTreeMap::new();
    let mut mark = Instant::now();
    let mut stage = |name: &'static str, mark: &mut Instant| {
        stages.insert(name, mark.elapsed().as_secs_f64());
        *mark = Instant::now();
    };
    let mut warnings = Warnings::default();

    if args.allow_software_adapter {
        // The renderer's own explicit opt-in (render_core::engine), set
        // before it creates its device; recorded in the result.
        std::env::set_var("SIMFORGE_NATIVE_ALLOW_SOFTWARE_ADAPTER", "1");
    }
    let tier = match args.textures {
        Textures::UastcFull => TextureTier::UastcFull,
        Textures::Bc7_512 => TextureTier::Bc7_512,
    };
    // Resolve the encoder first: a render that must encode fails in
    // milliseconds, naming the missing binary.
    let ffmpeg = match args.video {
        VideoMode::Off => None,
        _ => match video::resolve_ffmpeg()? {
            FfmpegResolution::Found {
                path,
                source,
                version,
            } => Some((path, source, version)),
            FfmpegResolution::Missing { searched } => {
                if args.video == VideoMode::Required {
                    return Err(CliError::new(
                        "ffmpeg_not_found",
                        "--video required, but no ffmpeg is installed",
                    )
                    .with_detail(json!({ "searched": searched })));
                }
                None
            }
        },
    };
    let out = prepare_out(&args.out)?;
    let job_dir = out.join("job");

    // 1. The timeline.
    let ws = Workspace::open(&args.workspace)?;
    let packaged = ws.timelines()?;
    let first = packaged.first().ok_or_else(|| {
        CliError::findings(
            "workspace_invalid",
            "the workspace manifest lists no timelines",
        )
    })?;
    let trace_path = ws.member(TRACE);
    let trace = timeline_cmd::load_trace(&trace_path, Some(ws.trace_sha256()?))?;
    let pinned = ws
        .height_source_digest()
        .unwrap_or(first.height_field_digest.as_str())
        .to_owned();
    let built = timeline_cmd::build_timeline(
        &trace,
        &trace_path,
        HeightChoice::Auto,
        None,
        args.map_dir.as_deref(),
        args.cache_root.as_deref(),
        Some(&pinned),
        first.catalog_digest.as_deref(),
    )?;
    for p in &packaged {
        if p.timeline_key == built.timeline.identity.timeline_key
            && p.timeline_sha256 != built.sha256
        {
            return Err(CliError::findings(
                "timeline_mismatch",
                format!(
                    "the workspace's timeline {} does not reproduce under this build ({})",
                    p.timeline_sha256, built.sha256
                ),
            ));
        }
    }
    let timeline = &built.timeline;
    std::fs::write(job_dir.join("timeline.json"), &built.bytes)
        .map_err(|e| CliError::new("write_failed", format!("cannot write the timeline: {e}")))?;
    stage("timeline", &mut mark);

    // 2. The native map and its closure.
    let map = scene_setup::native_map(
        &trace.header.engine_graph_digest,
        &trace.header.map_id,
        args.map_dir.as_deref(),
        args.cache_root.as_deref(),
    )?;
    let closure = scene_setup::open_closure(&map, tier, &mut warnings)?;
    let map_drift =
        scene_setup::check_map_drift(&ws, &closure, &map, args.allow_map_drift, &mut warnings)?;
    let xodr_text = scene_setup::xodr_text(&map)?;
    stage("map", &mut mark);

    // 3. The rig, schedules, lowering, camera schedule.
    let (rig_json, rig_default) = match &args.rig {
        Some(path) => {
            let rig_json: Value = serde_json::from_slice(&std::fs::read(path).map_err(|e| {
                CliError::new(
                    "missing_file",
                    format!("cannot read --rig {}: {e}", path.display()),
                )
                .with_path("--rig")
            })?)
            .map_err(|e| {
                CliError::findings("render_rig_invalid", format!("--rig is not JSON: {e}"))
                    .with_path("--rig")
            })?;
            (rig_json, None)
        }
        None => {
            let (rig_json, choice) = rig::default_rig(timeline)?;
            warnings.push(
                "render_rig_default",
                format!(
                    "no --rig: the default front camera is mounted on actor {} ({})",
                    choice["actorId"].as_str().unwrap_or(""),
                    choice["rule"].as_str().unwrap_or("")
                ),
            );
            (rig_json, Some(choice))
        }
    };
    let rig = Rig::parse(&rig_json)?;
    rig::assert_native_sources_supported(&rig.sources)?;
    rig::assert_native_radar_budgets(&rig.sources)?;
    if let Some(v) = &rig.video {
        schedule::assert_video_profile_supported(Some(&schedule::VideoProfile {
            container: v.container.clone(),
            codec: v.codec.clone(),
            quality: Some(v.quality.clone()),
        }))?;
    }
    let clip = match rig.clip {
        Some(clip) => clip,
        None => {
            warnings.push(
                "render_clip_whole_timeline",
                format!(
                    "the rig names no clip; rendering the whole timeline [0, {}) s",
                    timeline.time.clip_end_s
                ),
            );
            Clip {
                start_seconds: 0.0,
                end_seconds: timeline.time.clip_end_s,
            }
        }
    };
    let schedules =
        schedule::create_fixed_schedules(&rig.sources, &clip, rig.video.as_ref().map(|v| v.fps))?;
    let rgb_schedules: Vec<FixedSchedule> = schedules
        .iter()
        .filter(|s| {
            rig.sources
                .iter()
                .any(|src| src.output_name() == s.source_id && src.rgb().is_some())
        })
        .cloned()
        .collect();
    let frame_times = schedule::union_frame_times_s(&rgb_schedules);
    let heads = signal_head_guids(&xodr_text);
    let lowered = lower_timeline(timeline, &frame_times, true, &heads)?;
    warnings.extend_values(lowered.warnings.iter().cloned());
    let catalog_of = |id: &str| timeline.actor(id).map(|a| a.catalog_id.clone());
    let (hosts, hosts_derived) = rig.sensor_hosts(catalog_of)?;
    if hosts_derived {
        warnings.push("render_sensor_hosts_derived", "the rig names no sensorHosts; each source is hosted by its own actorId with that actor's timeline catalog id");
    }
    let cameras = rig::camera_schedule(&rig.sources, &hosts, &lowered.states)?;
    let (lidars, radars) = rig::sensor_rigs(&rig.sources, &hosts)?;
    let (near_m, far_m) = rig::camera_clip_planes(&rig.sources)?;
    let camera_formats: Vec<CameraFormat> = rig
        .sources
        .iter()
        .filter_map(|s| s.rgb())
        .map(|c| CameraFormat {
            output_name: c.common.output_name.clone(),
            width: c.attributes.width,
            height: c.attributes.height,
        })
        .collect();
    let sensor_video = schedule::sensor_video_format(&camera_formats, &schedules)?;
    stage("lowering", &mut mark);

    // The sky plates are verified before any staging or GPU work: a render without them
    // fails in the renderer after minutes of setup otherwise.
    let (sky, sky_fetch) = scene_setup::sky_assets()?;
    // 4. Derivatives and the staged texture tier.
    let derived = scene_setup::plan_derivatives(&closure, tier, true, &mut warnings)?;
    let frame_pixels = scene_setup::frame_pixels(
        &rig.sources,
        Some((sensor_video.width, sensor_video.height)),
    );
    let profile = scene_setup::stage_textures(
        &closure,
        tier,
        frame_pixels,
        args.vram_budget,
        &derived,
        &mut warnings,
    )?;
    write_json(
        &job_dir.join("texture-profile.json"),
        &serde_json::to_value(&profile).expect("profile serializes"),
    )?;
    let mut residency_path = None;
    let mut residency_summary = Value::Null;
    if let Some(density) = &derived.density {
        let frames: Vec<Vec<ResidencyCamera>> = cameras
            .iter()
            .map(|tick| {
                tick.iter()
                    .map(|c| ResidencyCamera {
                        eye: c.eye,
                        width: c.json["width"].as_u64().unwrap_or(0) as u32,
                        height: c.json["height"].as_u64().unwrap_or(0) as u32,
                        fov_deg: c.json["fovDeg"].as_f64().unwrap_or(0.0),
                    })
                    .collect()
            })
            .collect();
        let levels = residency::texture_residency_levels(&density.images, &frames, near_m)
            .map_err(|e| e.into_cli())?;
        let master = closure
            .path("master.gltf")
            .expect("a native closure has a master");
        let plan =
            residency::texture_residency_plan(master, &profile.master_path, &levels, density)
                .map_err(|e| e.into_cli())?;
        let path = job_dir.join("texture-residency.json");
        std::fs::write(&path, plan.plan_json())
            .map_err(|e| CliError::new("write_failed", e.to_string()))?;
        residency_summary = json!({
            "fullTextureBytes": plan.full_texture_bytes,
            "residentTextureBytes": plan.resident_texture_bytes,
            "levelsDropped": plan.levels_dropped,
        });
        residency_path = Some(path);
    }
    stage("textures", &mut mark);

    // 5. Actor assets.
    let digest = scene_setup::actor_closure_digest(&ws, args.actor_closure.as_deref())?;
    let appearances: Vec<ActorAppearance> = lowered
        .appearances
        .iter()
        .map(|a| ActorAppearance {
            actor_id: a.actor_id.clone(),
            kind: Some(a.kind.clone()),
            catalog_id: a.catalog_id.clone(),
            authored: a.authored,
        })
        .collect();
    let assets = scene_setup::bind_actor_assets(
        &digest,
        args.assets_root.as_deref(),
        &appearances,
        &hosts,
        &lowered.states,
    )?;
    stage("actorAssets", &mut mark);

    // 6. Lighting and luminaires.
    let rgb_fps: Vec<f64> = rgb_schedules.iter().map(|s| s.frames_per_second).collect();
    let eyes: Vec<[f64; 3]> = cameras
        .iter()
        .flat_map(|t| t.iter().map(|c| c.eye))
        .collect();
    let (scene_lighting, lighting_provenance) = scene_setup::scene_lighting(
        &ws,
        &xodr_text,
        &trace.header.map_id,
        &rgb_fps,
        derived.luminaires.as_ref(),
        &eyes,
        &mut warnings,
    )?;
    stage("lighting", &mut mark);

    // 7. Contact gate.
    let ground = closure.path(GROUND_MESH).map(Path::to_path_buf);
    let contact = gates::contact(timeline, ground.as_deref())?;
    let contact_summary = match &contact {
        Some(report) => {
            let summary = gates::contact_summary(report);
            if !report.pass {
                return Err(CliError::findings(
                    "render_contact_gate_failed",
                    format!(
                        "{} wheel contact(s) off the rendered ground by more than {} m",
                        report.failure_count, report.tolerance_m
                    ),
                )
                .with_detail(summary));
            }
            summary
        }
        None => {
            for w in derivatives::ground_absent_warnings() {
                warnings.extend_values([w.to_json()]);
            }
            Value::Null
        }
    };
    stage("contactGate", &mut mark);

    // 8. The job.
    let scene = scene_setup::scene_spec(&scene_setup::SpecInput {
        profile: &profile,
        lighting: scene_lighting,
        near_m,
        far_m,
        models_dir: &assets.directory,
        preset: args.preset.as_str(),
        tier,
        derivatives: &derived,
        residency_path: residency_path.as_deref(),
        ground_mesh: ground.as_deref(),
    });
    let scene_state_path = job_dir.join("scene-state.json.gz");
    {
        let file = std::fs::File::create(&scene_state_path)
            .map_err(|e| CliError::new("write_failed", e.to_string()))?;
        let mut gz = flate2::write::GzEncoder::new(file, flate2::Compression::fast());
        serde_json::to_writer(&mut gz, &lowering::scene_state_document(&lowered))
            .map_err(|e| CliError::new("write_failed", e.to_string()))?;
        gz.finish()
            .map_err(|e| CliError::new("write_failed", e.to_string()))?;
    }
    let passes: Vec<&str> = args.passes.iter().map(|p| p.as_str()).collect();
    let camera_schedule: Vec<Vec<Value>> = cameras
        .iter()
        .map(|t| t.iter().map(|c| c.json.clone()).collect())
        .collect();
    let job = json!({
        "schema": "simforge.render-job/v2",
        "scene": scene,
        "sceneState": scene_state_path,
        "rig": { "cameraSchedule": camera_schedule, "lidars": lidars, "radars": radars },
        "ticks": { "start": 0, "count": lowered.states.len() },
        "passes": passes,
        "outDir": out,
        "observe": true,
        "simTimesS": frame_times,
    });
    let job_path = job_dir.join("render-job.json");
    write_json(&job_path, &job)?;
    stage("jobSpec", &mut mark);
    let mut output = job_runner::run_job(&job_path, &out, &args.sets)?;
    // A default rig is the CLI's choice, not the renderer's: record it with the results.
    if let Some(choice) = &rig_default {
        output.results["rig"] = json!({ "source": "default", "default": choice });
        write_json(&output.results_path, &output.results)?;
    }
    stage("render", &mut mark);

    // 9. Parity.
    let parity = gates::parity(timeline, &out.join("observed-frames.jsonl"))?;
    let parity_json = serde_json::to_value(&parity).expect("parity serializes");
    write_json(&out.join("parity.json"), &parity_json)?;
    stage("parity", &mut mark);

    // 10. Videos.
    let videos = encode_videos(
        &out,
        &rig,
        &schedules,
        &frame_times,
        &output.results,
        sensor_video,
        ffmpeg.as_ref().map(|f| f.0.as_path()),
        args.video,
    )?;
    stage("video", &mut mark);

    let artifacts = output.results["artifacts"]
        .as_array()
        .map(Vec::len)
        .unwrap_or(0);
    let non_finite = output.results["nonFinitePixels"].as_u64().unwrap_or(0);
    let result = json!({
        "schema": CLI_RENDER_SCHEMA,
        "version": env!("CARGO_PKG_VERSION"),
        "workspace": ws.dir,
        "out": out,
        "preset": args.preset.as_str(),
        "sets": args.sets,
        "passes": passes,
        "textures": tier.as_str(),
        "renderConfig": output.results["renderConfig"],
        "softwareAdapter": std::env::var("SIMFORGE_NATIVE_ALLOW_SOFTWARE_ADAPTER").as_deref() == Ok("1"),
        "sky": { "dir": sky.dir, "fetched": sky_fetch.as_ref().map(|f| json!({ "closure": f["closure"], "downloaded": f["downloaded"] })) },
        "timeline": {
            "timelineSha256": built.sha256,
            "timelineKey": timeline.identity.timeline_key,
            "samplerVersion": timeline.identity.sampler_version,
            "heightSelection": built.height_selection,
        },
        "map": { "dir": map.dir, "release": map.release, "releaseDigest": map.release_digest, "xodrSha256": map.xodr_sha256, "drift": map_drift },
        "actorAssets": assets.evidence(),
        "rig": {
            "source": if rig_default.is_some() { "default" } else { "file" },
            "default": rig_default,
            "sources": rig.sources.iter().map(|s| json!({ "outputName": s.output_name(), "modality": s.modality() })).collect::<Vec<_>>(),
            "sensorHostsDerived": hosts_derived,
            "clip": { "startSeconds": clip.start_seconds, "endSeconds": clip.end_seconds },
        },
        "frames": lowered.states.len(),
        "lowering": { "sha256": lowered.sha256, "timelineSha256": lowered.timeline_sha256 },
        "textureProfile": { "masterPath": profile.master_path, "cacheKey": profile.cache_key, "textureBytes": profile.texture_bytes, "capacitySource": profile.capacity_source.as_str() },
        "residency": residency_summary,
        "derivatives": {
            "geometryLod": derived.geometry_lod.is_some(),
            "roadDecals": derived.road_decals.is_some(),
            "luminaires": derived.luminaires.is_some(),
            "ground": ground.is_some(),
        },
        "lighting": lighting_provenance,
        "gates": {
            "contact": contact_summary,
            "parity": {
                "pass": parity.pass,
                "frames": parity.frames,
                "comparedPoses": parity.compared_poses,
                "maxPositionErrorM": parity.max_position_error_m,
                "maxHeadingErrorDeg": parity.max_heading_error_deg,
                "presenceMismatches": parity.presence_mismatches,
                "report": out.join("parity.json"),
            },
            "nonFinitePixels": non_finite,
        },
        "artifacts": artifacts,
        "videos": videos,
        "results": output.results_path,
        "log": output.log_path,
        "warnings": warnings.0,
        "timingsS": { "total": started.elapsed().as_secs_f64(), "stages": stages },
    });
    write_json(&out.join("render.json"), &result)?;
    if !parity.pass {
        return Ok(Outcome::findings(result));
    }
    if non_finite > 0 {
        return Ok(Outcome::findings(result));
    }
    Ok(Outcome::ok(result))
}

/// Encode one video per sensor from the job's artifacts: each camera keeps
/// only the ticks on its own schedule (the platform's `wantedMicros`), lidar
/// and radar frames are rasterized every tick at the sensor-video format.
#[allow(clippy::too_many_arguments)]
fn encode_videos(
    out: &Path,
    rig: &Rig,
    schedules: &[FixedSchedule],
    frame_times: &[f64],
    results: &Value,
    sensor_video: schedule::SensorVideoFormat,
    ffmpeg: Option<&Path>,
    mode: VideoMode,
) -> Result<Vec<Value>, CliError> {
    let Some(ffmpeg) = ffmpeg else {
        let reason = if mode == VideoMode::Off {
            "off"
        } else {
            "ffmpeg_not_found"
        };
        return Ok(rig
            .sources
            .iter()
            .map(|s| video::skipped_video(s.output_name(), reason))
            .collect());
    };
    // Artifact paths by (sensor, tick, pass).
    let mut by_key: BTreeMap<(String, u64, String), String> = BTreeMap::new();
    for a in results["artifacts"].as_array().into_iter().flatten() {
        if let (Some(sensor), Some(tick), Some(pass), Some(path)) = (
            a["sensorId"].as_str(),
            a["tick"].as_u64(),
            a["pass"].as_str(),
            a["path"].as_str(),
        ) {
            by_key.insert((sensor.to_owned(), tick, pass.to_owned()), path.to_owned());
        }
    }
    let mut videos = Vec::new();
    for source in &rig.sources {
        let name = source.output_name();
        let output = out.join("video").join(format!("{name}.mp4"));
        match source {
            RenderSource::Camera(camera) => {
                let wanted: BTreeSet<i64> = schedules
                    .iter()
                    .find(|s| s.source_id == name)
                    .map(|s| s.frame_micros().into_iter().collect())
                    .unwrap_or_default();
                let format = VideoFormat {
                    width: camera.attributes.width,
                    height: camera.attributes.height,
                    frames_per_second: camera.attributes.fps,
                };
                let mut encoder = VideoEncoder::new(ffmpeg, &output, format, VideoCodec::Libx264)?;
                for (tick, t) in frame_times.iter().enumerate() {
                    if !wanted.contains(&micros(*t)) {
                        continue;
                    }
                    let path = by_key
                        .get(&(name.to_owned(), tick as u64, "rgb".to_owned()))
                        .ok_or_else(|| {
                            CliError::new(
                                "render_failed",
                                format!("camera {name} has no rgb frame at tick {tick}"),
                            )
                        })?;
                    let (_, _, rgba) = video::decode_rgba_png(&out.join(path))?;
                    encoder.write(&rgba)?;
                }
                let done = encoder.finish()?;
                videos.push(json!({ "sourceId": name, "status": "encoded", "path": done.path, "frames": done.frames, "codec": done.codec.as_str() }));
            }
            RenderSource::Lidar(lidar) => {
                let format = VideoFormat {
                    width: sensor_video.width,
                    height: sensor_video.height,
                    frames_per_second: sensor_video.frames_per_second,
                };
                let mut raster = LidarVideoRasterizer::new(
                    format.width,
                    format.height,
                    lidar.attributes.range_m,
                    lidar.common.transform.position.y,
                )?;
                let mut encoder = VideoEncoder::new(ffmpeg, &output, format, VideoCodec::Libx264)?;
                for tick in 0..frame_times.len() {
                    let path = by_key
                        .iter()
                        .find(|((s, t, _), _)| s == name && *t == tick as u64)
                        .map(|(_, p)| p.clone())
                        .ok_or_else(|| {
                            CliError::new(
                                "render_failed",
                                format!("lidar {name} has no scan at tick {tick}"),
                            )
                        })?;
                    let bytes = std::fs::read(out.join(&path))
                        .map_err(|e| CliError::new("render_failed", e.to_string()))?;
                    let scan = parse_lidar_ply(&bytes, &format!("lidar {name} tick {tick}"))?;
                    let frame = raster.frame(&scan).to_vec();
                    encoder.write(&frame)?;
                }
                let done = encoder.finish()?;
                videos.push(json!({ "sourceId": name, "status": "encoded", "path": done.path, "frames": done.frames, "codec": done.codec.as_str() }));
            }
            RenderSource::Radar(radar) => {
                let format = VideoFormat {
                    width: sensor_video.width,
                    height: sensor_video.height,
                    frames_per_second: sensor_video.frames_per_second,
                };
                let mut raster = RadarVideoRasterizer::new(
                    format.width,
                    format.height,
                    radar.attributes.horizontal_fov_deg,
                    radar.attributes.range_m,
                )?;
                let mut encoder = VideoEncoder::new(ffmpeg, &output, format, VideoCodec::Libx264)?;
                for tick in 0..frame_times.len() {
                    let path = by_key
                        .iter()
                        .find(|((s, t, _), _)| s == name && *t == tick as u64)
                        .map(|(_, p)| p.clone())
                        .ok_or_else(|| {
                            CliError::new(
                                "render_failed",
                                format!("radar {name} has no scan at tick {tick}"),
                            )
                        })?;
                    let bytes = std::fs::read(out.join(&path))
                        .map_err(|e| CliError::new("render_failed", e.to_string()))?;
                    let scan = parse_radar_csv(&bytes, &format!("radar {name} tick {tick}"))?;
                    let frame = raster.frame(&scan).to_vec();
                    encoder.write(&frame)?;
                }
                let done = encoder.finish()?;
                videos.push(json!({ "sourceId": name, "status": "encoded", "path": done.path, "frames": done.frames, "codec": done.codec.as_str() }));
            }
        }
    }
    let _ = std::io::stdout().flush();
    Ok(videos)
}
