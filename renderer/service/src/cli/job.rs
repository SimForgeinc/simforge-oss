//! `simforge-render job`: render a job offline, in process, through exactly
//! the request path the render service serves (`load_scene_state`, then one
//! `render_bundle` per tick), and write its artifacts.
//!
//! Two ways to describe a job:
//!
//! * `--job job.json` (`simforge.render-job/v2`): a scene spec, an optional
//!   scene-state stream, a rig (explicit service cameras/lidars/radars, or a
//!   Pronto qualification rig program), the ticks and passes, and `outDir`.
//!   Artifacts land as `<outDir>/<sensor>/<tick:08>.<pass>.<ext>` plus
//!   `results.json` (sha256 per artifact, timings, the resolved render
//!   config).
//! * `--scene native-service-scene.json --trace native-trace.json --intent
//!   intent.json`: replay a platform render job from its own workspace files
//!   (the intent supplies the sources and mounts), for profiling.
//!
//! Common flags: `--preset training|showcase`, `--set key=value`,
//! `--scene-set field=json`, `--start/--ticks`, `--out result.json`,
//! `--dump-dir DIR --dump-every N` (RGB PNGs), `--sweep entries.json` (many
//! render configs in one process), `--camera-size WxH`, `--ablate ...`
//! (diagnostic feature removal), `--sources` (replay subset).
//!
//! `SIMFORGE_RENDER_DIAGNOSTICS=1` adds per-pass GPU timings (Bevy's
//! render diagnostics; totals are per tick, summed over views and frames).
use crate::proto::{ResponseBody, WireRequest};
use crate::server::{dispatch, prewarm, SceneSpec, ServiceState};
use crate::shm::{ShmRing, RECORD_HEADER_BYTES};
use anyhow::{bail, Context, Result};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Instant;

const JOB_USAGE: &str = "simforge-render job --job JOB.json [--preset training|showcase] [--set key=value ...]\n\
    simforge-render job --scene SCENE.json --trace TRACE.json --intent INTENT.json [--glb PATH] [--models DIR] [--sources all|id,...]\n\
        [--passes rgb,id,depth,semantic] [--out-dir DIR]\n\
    common: [--ground-mesh GROUND-MESH.bin] [--scene-set field=json ...] [--start N] [--ticks N] [--out RESULT.json] [--dump-dir DIR --dump-every N]\n\
            [--sweep ENTRIES.json] [--camera-size WxH] [--ablate a,b] [--shm-size-mb 512]\n\
    JOB.json is simforge.render-job/v2: {schema, scene, sceneState?, rig: {cameras?, lidars?, radars?, pronto?}, ticks?: {start?, count?}, passes, outDir, observe?}.\n\
    Artifacts: <outDir>/<sensor>/<tick:08>.<pass>.png|.f32.bin|.ply|.csv plus <outDir>/results.json.";

struct Args {
    job: Option<PathBuf>,
    scene: PathBuf,
    trace: PathBuf,
    intent: PathBuf,
    glb: Option<String>,
    models: Option<String>,
    start_set: Option<usize>,
    ticks_set: Option<usize>,
    sources: String,
    dump_dir: Option<PathBuf>,
    dump_every: usize,
    out: Option<PathBuf>,
    shm_size_mb: u64,
    ablate: Vec<String>,
    spec_overrides: Vec<(String, String)>,
    preset: Option<String>,
    render_sets: Vec<String>,
    sweep: Option<PathBuf>,
    camera_size: Option<(u32, u32)>,
    /// Replay form: camera passes (default `rgb`) and an artifact directory.
    passes: Option<Vec<String>>,
    out_dir: Option<PathBuf>,
}

fn parse_args(argv: Vec<String>) -> Result<Args> {
    let mut args = argv.into_iter();
    let mut parsed = Args {
        job: None,
        scene: PathBuf::new(),
        trace: PathBuf::new(),
        intent: PathBuf::new(),
        glb: None,
        models: None,
        start_set: None,
        ticks_set: None,
        sources: "all".into(),
        dump_dir: None,
        dump_every: 0,
        out: None,
        shm_size_mb: 512,
        ablate: Vec::new(),
        spec_overrides: Vec::new(),
        preset: None,
        render_sets: Vec::new(),
        sweep: None,
        camera_size: None,
        passes: None,
        out_dir: None,
    };
    while let Some(arg) = args.next() {
        let mut value = || {
            args.next()
                .with_context(|| format!("{arg} requires a value"))
        };
        match arg.as_str() {
            "--help" | "-h" => {
                println!("{JOB_USAGE}");
                std::process::exit(0);
            }
            "--job" => parsed.job = Some(value()?.into()),
            "--scene" => parsed.scene = value()?.into(),
            "--trace" => parsed.trace = value()?.into(),
            "--intent" => parsed.intent = value()?.into(),
            "--glb" => parsed.glb = Some(value()?),
            "--models" => parsed.models = Some(value()?),
            "--start" => parsed.start_set = Some(value()?.parse()?),
            "--ticks" => parsed.ticks_set = Some(value()?.parse()?),
            "--sources" => parsed.sources = value()?,
            "--dump-dir" => parsed.dump_dir = Some(value()?.into()),
            "--dump-every" => parsed.dump_every = value()?.parse()?,
            "--out" => parsed.out = Some(value()?.into()),
            "--shm-size-mb" => parsed.shm_size_mb = value()?.parse()?,
            "--scene-set" => {
                let kv = value()?;
                let (k, v) = kv.split_once('=').context("--scene-set key=json")?;
                parsed.spec_overrides.push((k.to_string(), v.to_string()));
            }
            // The map's ground derivative (`derived/ground/ground-mesh.bin`):
            // the scene spec's `groundMesh`, for either job form.
            "--ground-mesh" => parsed
                .spec_overrides
                .push(("groundMesh".into(), serde_json::to_string(&value()?)?)),
            "--passes" => {
                parsed.passes = Some(
                    value()?
                        .split(',')
                        .filter(|p| !p.is_empty())
                        .map(String::from)
                        .collect(),
                )
            }
            "--out-dir" => parsed.out_dir = Some(value()?.into()),
            "--preset" => parsed.preset = Some(value()?),
            "--sweep" => parsed.sweep = Some(value()?.into()),
            "--camera-size" => {
                let size = value()?;
                let (w, h) = size.split_once('x').context("--camera-size WxH")?;
                parsed.camera_size = Some((w.parse()?, h.parse()?));
            }
            "--set" => parsed.render_sets.push(value()?),
            "--ablate" => {
                parsed.ablate = value()?
                    .split(',')
                    .filter(|v| !v.is_empty())
                    .map(String::from)
                    .collect()
            }
            other => bail!("unknown argument {other}"),
        }
    }
    if parsed.job.is_none()
        && (parsed.scene.as_os_str().is_empty()
            || parsed.trace.as_os_str().is_empty()
            || parsed.intent.as_os_str().is_empty())
    {
        bail!("--job, or --scene with --trace and --intent, is required");
    }
    if parsed.job.is_some() && (parsed.passes.is_some() || parsed.out_dir.is_some()) {
        bail!("--passes and --out-dir belong to the replay form; a job file names its own passes and outDir");
    }
    Ok(parsed)
}

fn request(value: serde_json::Value) -> Result<WireRequest> {
    serde_json::from_value(value).context("build wire request")
}

/// Mirror of `packages/render/src/native/camera-schedule.ts` `attachment()`.
fn attachment(source: &serde_json::Value, pitch_offset_deg: f64) -> serde_json::Value {
    let p = &source["transform"]["position"];
    let r = &source["transform"]["rotation"];
    // fallback-ok: the intent omits zero mount offsets/angles
    let f = |v: &serde_json::Value| v.as_f64().unwrap_or(0.0);
    serde_json::json!({
        "actorId": source["actorId"],
        "offsetM": [f(&p["x"]), -f(&p["z"]), f(&p["y"])],
        "yawDeg": -f(&r["yawRad"]).to_degrees(),
        "pitchDeg": f(&r["pitchRad"]).to_degrees() + pitch_offset_deg,
        "hostVisible": source["sensorId"] == "chase-cam-trailing",
    })
}

/// Diagnostic ablations, applied to the live world before every tick so a
/// relight or re-registration cannot quietly restore what was removed.
/// Each one isolates the cost of one feature; none is a production mode.
fn ablate(world: &mut bevy::prelude::World, flags: &[String]) {
    use bevy::prelude::*;
    if flags.is_empty() {
        return;
    }
    let has = |name: &str| flags.iter().any(|f| f == name);
    let cameras: Vec<Entity> = world
        .query_filtered::<Entity, With<Camera3d>>()
        .iter(world)
        .collect();
    for entity in cameras {
        let mut e = world.entity_mut(entity);
        if has("nossao") {
            e.remove::<bevy::pbr::ScreenSpaceAmbientOcclusion>();
            e.remove::<bevy::pbr::ContactShadows>();
        }
        if has("nocontact") {
            e.remove::<bevy::pbr::ContactShadows>();
        }
        if has("nossr") {
            e.remove::<bevy::pbr::ScreenSpaceReflections>();
        }
        if has("notaa") {
            e.remove::<bevy::anti_alias::taa::TemporalAntiAliasing>();
        }
        if has("nobloom") {
            e.remove::<bevy::post_process::bloom::Bloom>();
        }
        if has("noatmo") {
            e.remove::<bevy::pbr::AtmosphereSettings>();
        }
        if has("nosky") {
            e.remove::<render_core::sky_pass::SkyPass>();
        }
        if has("occlusion") {
            e.insert(bevy::render::occlusion_culling::OcclusionCulling);
        }
    }
    if has("noshadows") {
        for mut light in world.query::<&mut DirectionalLight>().iter_mut(world) {
            if light.shadow_maps_enabled {
                light.shadow_maps_enabled = false;
            }
        }
        for mut light in world.query::<&mut SpotLight>().iter_mut(world) {
            if light.shadow_maps_enabled {
                light.shadow_maps_enabled = false;
            }
        }
        for mut light in world.query::<&mut PointLight>().iter_mut(world) {
            if light.shadow_maps_enabled {
                light.shadow_maps_enabled = false;
            }
        }
    }
    for flag in flags.iter().filter_map(|f| f.strip_prefix("hide:")) {
        let hidden: Vec<Entity> = world
            .query::<(Entity, &bevy::gltf::GltfMeshName)>()
            .iter(world)
            .filter(|(_, name)| name.0.contains(flag))
            .map(|(e, _)| e)
            .collect();
        for entity in hidden {
            if let Some(mut visibility) = world.get_mut::<Visibility>(entity) {
                if *visibility != Visibility::Hidden {
                    *visibility = Visibility::Hidden;
                }
            }
        }
    }
}

/// Per-phase draw structure of the last rendered frame, summed over views:
/// (views, multidraw batch sets, multidraw bins, batchable bins, unbatchable entities).
fn phase_stats(world: &mut bevy::prelude::World) -> Vec<(String, [usize; 5])> {
    use bevy::render::render_phase::{BinnedPhaseItem, ViewBinnedRenderPhases};
    fn one<P: BinnedPhaseItem>(
        world: &bevy::prelude::World,
        name: &str,
        out: &mut Vec<(String, [usize; 5])>,
    ) {
        let Some(phases) = world.get_resource::<ViewBinnedRenderPhases<P>>() else {
            return;
        };
        let mut sum = [0usize; 5];
        for phase in phases.values() {
            sum[0] += 1;
            sum[1] += phase.multidrawable_meshes.len();
            sum[3] += phase.batchable_meshes.len();
            sum[4] += phase
                .unbatchable_meshes
                .values()
                .map(|u| u.entities.len())
                .sum::<usize>();
        }
        out.push((name.to_string(), sum));
    }
    let mut out = Vec::new();
    one::<bevy::core_pipeline::core_3d::Opaque3d>(world, "opaque", &mut out);
    one::<bevy::core_pipeline::core_3d::AlphaMask3d>(world, "alpha-mask", &mut out);
    one::<bevy::core_pipeline::prepass::Opaque3dPrepass>(world, "prepass-opaque", &mut out);
    one::<bevy::core_pipeline::prepass::AlphaMask3dPrepass>(world, "prepass-alpha-mask", &mut out);
    one::<bevy::pbr::Shadow>(world, "shadow", &mut out);
    out
}

/// Render `ticks` ticks from `start` (the first one settles and is not
/// timed); returns timings and per-frame digests.
#[allow(clippy::too_many_arguments)]
fn sweep_pass(
    state: &mut ServiceState,
    cameras: &[serde_json::Value],
    lidars: &[serde_json::Value],
    radars: &[serde_json::Value],
    start: usize,
    ticks: usize,
    frame_count: usize,
    dump_dir: Option<&std::path::Path>,
    dump_every: usize,
) -> Result<serde_json::Value> {
    let end = (start + ticks + 1).min(frame_count);
    let mut tick_ms = Vec::new();
    let mut gpu_frames = Vec::new();
    let mut digests: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (n, tick) in (start..end).enumerate() {
        let mut body = serde_json::json!({
            "i": 10 + tick, "op": "render_bundle", "sim_tick": tick, "tick_index": tick,
            "cameras": cameras, "passes": ["rgb"],
        });
        if n == 0 && !lidars.is_empty() {
            body["lidars"] = serde_json::json!(lidars);
        }
        if n == 0 && !radars.is_empty() {
            body["radars"] = serde_json::json!(radars);
        }
        let started = Instant::now();
        let response = dispatch(state, request(body)?);
        let elapsed = started.elapsed().as_secs_f64() * 1000.0;
        let ResponseBody::RenderBundle {
            frames: records, ..
        } = response.body
        else {
            if let ResponseBody::Error { error, .. } = response.body {
                bail!("tick {tick}: {error}");
            }
            bail!("tick {tick}: unexpected response");
        };
        let frame_times = state.app.take_gpu_frame_times();
        if n == 0 {
            continue; // settle tick
        }
        tick_ms.push(elapsed);
        gpu_frames.extend(frame_times);
        for record in &records {
            digests
                .entry(format!("{}:{}", record.sensor_id, record.pass))
                .or_default()
                .push(record.digest.clone());
            if let Some(dir) = dump_dir {
                if record.pass == "rgb" && dump_every > 0 && (n - 1) % dump_every == 0 {
                    std::fs::create_dir_all(dir)?;
                    let map = state.shm.as_bytes();
                    let offset = record.offset as usize + RECORD_HEADER_BYTES;
                    let data = &map[offset..offset + record.len as usize];
                    let raw = render_core::engine::strip_padding(
                        data,
                        record.width as usize,
                        record.height as usize,
                        4,
                    );
                    image::save_buffer(
                        dir.join(format!("{}.t{tick:04}.png", record.sensor_id)),
                        &raw,
                        record.width,
                        record.height,
                        image::ColorType::Rgba8,
                    )?;
                }
            }
        }
    }
    let median = |values: &mut Vec<f64>| -> f64 {
        values.sort_by(|a, b| a.partial_cmp(b).unwrap());
        values.get(values.len() / 2).copied().unwrap_or(0.0) // fallback-ok: benchmark statistics over zero samples are reported as 0
    };
    let mut ticks_sorted = tick_ms.clone();
    let mut frames_sorted = gpu_frames.clone();
    Ok(serde_json::json!({
        "tickMs": tick_ms,
        "medianMsPerTick": median(&mut ticks_sorted),
        "gpuFrameMs": gpu_frames,
        "gpuFrameMedianMs": median(&mut frames_sorted),
        "digests": digests,
    }))
}

fn vertical_fov(horizontal_deg: f64, width: f64, height: f64) -> f64 {
    2.0 * ((horizontal_deg.to_radians() / 2.0).tan() * height / width)
        .atan()
        .to_degrees()
}

fn plan_from_replay(args: &Args) -> Result<Plan> {
    let mut spec_json: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&args.scene)?)?;
    if let Some(glb) = &args.glb {
        spec_json["glbs"] = serde_json::json!([glb]);
    }
    if let Some(models) = &args.models {
        spec_json["vehicleModels"] = serde_json::json!(models);
        spec_json["pedestrianModels"] = serde_json::json!(models);
    }
    for (key, value) in &args.spec_overrides {
        spec_json[key] = serde_json::from_str(value).with_context(|| format!("--set {key}"))?;
    }
    let spec: SceneSpec = serde_json::from_value(spec_json)?;
    let trace: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&args.trace)?)?;
    let intent: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&args.intent)?)?;
    let frames = trace["frames"].as_array().context("trace.frames")?.clone();

    let selected: Vec<serde_json::Value> = intent["renderSpec"]["sources"]
        .as_array()
        .context("intent.renderSpec.sources")?
        .iter()
        .filter(|source| match args.sources.as_str() {
            "all" => true,
            "rgb" | "lidar" | "radar" => source["modality"] == args.sources.as_str(),
            list => list.split(',').any(|name| source["outputName"] == name),
        })
        .cloned()
        .collect();
    let cameras: Vec<serde_json::Value> = selected
        .iter()
        .filter(|s| s["modality"] == "rgb")
        .map(|s| {
            let a = &s["attributes"];
            let (w, h) = match args.camera_size {
                // Same horizontal FOV, consumer-sized image (training rigs).
                Some((w, h)) => (f64::from(w), f64::from(h)),
                None => (a["width"].as_f64().unwrap(), a["height"].as_f64().unwrap()),
            };
            serde_json::json!({
                "sensorId": s["outputName"], "width": w as u32, "height": h as u32,
                "fovDeg": vertical_fov(a["horizontalFovDeg"].as_f64().unwrap(), w, h),
                // Each camera's own planes, as the worker sends them.
                "nearM": a["nearM"], "farM": a["farM"],
                "eye": [0.0, 0.0, 0.0], "target": [0.0, 0.0, 1.0],
                "attach": attachment(s, 0.0),
            })
        })
        .collect();
    let lidars: Vec<serde_json::Value> = selected
        .iter()
        .filter(|s| s["modality"] == "lidar")
        .map(|s| {
            let a = &s["attributes"];
            let upper = a["upperFovDeg"].as_f64().unwrap();
            let lower = a["lowerFovDeg"].as_f64().unwrap();
            serde_json::json!({
                "sensorId": s["outputName"], "attach": attachment(s, (upper + lower) / 2.0),
                "channels": a["channels"], "rotationFrequencyHz": a["rotationFrequencyHz"],
                "pointsPerSecond": a["pointsPerSecond"], "horizontalFovDeg": a["horizontalFovDeg"],
                "verticalFovDeg": upper - lower, "rangeM": a["rangeM"],
            })
        })
        .collect();
    let radars: Vec<serde_json::Value> = selected
        .iter()
        .filter(|s| s["modality"] == "radar")
        .map(|s| {
            let a = &s["attributes"];
            serde_json::json!({
                "sensorId": s["outputName"], "attach": attachment(s, 0.0),
                "pointsPerSecond": a["pointsPerSecond"], "horizontalFovDeg": a["horizontalFovDeg"],
                "verticalFovDeg": a["verticalFovDeg"], "rangeM": a["rangeM"],
            })
        })
        .collect();
    if let Some(dir) = &args.out_dir {
        std::fs::create_dir_all(dir)?;
    }
    Ok(Plan {
        spec,
        frames,
        cameras,
        lidars,
        radars,
        passes: args.passes.clone().unwrap_or_else(|| vec!["rgb".into()]), // fallback-ok: the replay form's documented default pass
        out_dir: args.out_dir.clone(),
        observe: false,
        start: args.start_set.unwrap_or(0), // fallback-ok: replay defaults, printed with the run
        ticks: args.ticks_set.unwrap_or(48), // fallback-ok: replay defaults, printed with the run
    })
}

/// Write one published frame as a job artifact:
/// `<dir>/<sensor>/<tick:08>.<pass>.<ext>`. RGB / instance-ID / semantic
/// are lossless PNG (RGBA8, padding stripped), depth is raw little-endian
/// f32 rows, lidar/radar are the service's own PLY/CSV payloads.
fn write_artifact(
    state: &ServiceState,
    record: &crate::proto::FrameRecord,
    dir: &std::path::Path,
    tick: usize,
) -> Result<serde_json::Value> {
    let map = state.shm.as_bytes();
    let offset = record.offset as usize + RECORD_HEADER_BYTES;
    let data = &map[offset..offset + record.len as usize];
    let sensor_dir = dir.join(&record.sensor_id);
    std::fs::create_dir_all(&sensor_dir)?;
    let (name, bytes): (String, Vec<u8>) = match record.format.as_str() {
        "rgba8" => {
            let raw = render_core::engine::strip_padding(
                data,
                record.width as usize,
                record.height as usize,
                4,
            );
            let mut png = Vec::new();
            image::ImageEncoder::write_image(
                image::codecs::png::PngEncoder::new(&mut png),
                &raw,
                record.width,
                record.height,
                image::ExtendedColorType::Rgba8,
            )?;
            (format!("{tick:08}.{}.png", record.pass), png)
        }
        "depth32f" => (
            format!("{tick:08}.{}.f32.bin", record.pass),
            render_core::engine::strip_padding(
                data,
                record.width as usize,
                record.height as usize,
                4,
            ),
        ),
        // Linear pre-exposure radiance: RGBA f16, row-major, no padding.
        // Scene luminance (cd/m²) = value · 1.2 · 2^EV100 with the base EV100
        // (`exposure[sensor].ev100 + exposure[sensor].adjustEv`).
        "rgba16f" => (
            format!("{tick:08}.{}.f16.bin", record.pass),
            render_core::engine::strip_padding(
                data,
                record.width as usize,
                record.height as usize,
                8,
            ),
        ),
        "ply-ascii" | "ply-binary" => (format!("{tick:08}.ply"), data.to_vec()),
        "radar-csv" => (format!("{tick:08}.csv"), data.to_vec()),
        other => bail!(
            "job artifact: {} {} has format {other}, which a job does not write",
            record.sensor_id,
            record.pass
        ),
    };
    let path = sensor_dir.join(&name);
    std::fs::write(&path, &bytes)?;
    use sha2::Digest;
    Ok(serde_json::json!({
        "sensorId": record.sensor_id,
        "pass": record.pass,
        "tick": tick,
        "path": format!("{}/{name}", record.sensor_id),
        "sha256": format!("{:x}", sha2::Sha256::digest(&bytes)),
        "bytes": bytes.len(),
    }))
}

/// `simforge.render-job/v2`.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct JobSpec {
    schema: String,
    scene: serde_json::Value,
    /// Scene-state stream: per-tick scene-state.v1 documents (the
    /// `load_scene_state` shape), as a bare array or `{frames: [...]}`,
    /// `.json` or `.json.gz`; absent for a static scene.
    #[serde(default)]
    scene_state: Option<PathBuf>,
    rig: JobRig,
    #[serde(default)]
    ticks: JobTicks,
    /// Camera passes (`rgb`, `id`, `depth`, `semantic`); required.
    passes: Vec<String>,
    out_dir: PathBuf,
    /// Record every rendered tick's observed actor transforms (what the
    /// renderer drew) to `<outDir>/observed-frames.jsonl`, for the timeline
    /// parity gate. Needs a scene state.
    #[serde(default)]
    observe: bool,
}

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct JobTicks {
    #[serde(default)]
    start: Option<usize>,
    #[serde(default)]
    count: Option<usize>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct JobRig {
    /// Service cameras (`ServiceCamera` wire shape).
    #[serde(default)]
    cameras: Vec<serde_json::Value>,
    #[serde(default)]
    lidars: Vec<serde_json::Value>,
    #[serde(default)]
    radars: Vec<serde_json::Value>,
    /// A `render-qualification-program/v1` document whose `prontoRig`
    /// sensors (plus the trailing chase camera) mount on `host`.
    #[serde(default)]
    pronto: Option<ProntoRig>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProntoRig {
    program: PathBuf,
    host: String,
    width: u32,
    height: u32,
}

fn plan_from_job(path: &std::path::Path, args: &Args) -> Result<Plan> {
    let job: JobSpec = serde_json::from_slice(
        &std::fs::read(path).with_context(|| format!("read {}", path.display()))?,
    )
    .with_context(|| format!("parse {}", path.display()))?;
    anyhow::ensure!(
        job.schema == "simforge.render-job/v2",
        "job schema {:?} (simforge.render-job/v2)",
        job.schema
    );
    let mut scene = job.scene;
    for (key, value) in &args.spec_overrides {
        scene[key] = serde_json::from_str(value).with_context(|| format!("--scene-set {key}"))?;
    }
    let spec: SceneSpec = serde_json::from_value(scene).context("job scene")?;
    let frames = match &job.scene_state {
        None => Vec::new(),
        Some(path) => {
            let bytes = std::fs::read(path).with_context(|| format!("read {}", path.display()))?;
            let text = if path.extension().is_some_and(|ext| ext == "gz") {
                let mut out = String::new();
                std::io::Read::read_to_string(
                    &mut flate2::read::GzDecoder::new(&bytes[..]),
                    &mut out,
                )?;
                out
            } else {
                String::from_utf8(bytes)?
            };
            let doc: serde_json::Value = serde_json::from_str(&text)?;
            match doc {
                serde_json::Value::Array(frames) => frames,
                serde_json::Value::Object(mut map) => match map.remove("frames") {
                    Some(serde_json::Value::Array(frames)) => frames,
                    _ => bail!("{}: scene-state has no frames array", path.display()),
                },
                _ => bail!(
                    "{}: scene-state is neither a frame array nor {{frames}}",
                    path.display()
                ),
            }
        }
    };
    let mut cameras = job.rig.cameras;
    let mut lidars = job.rig.lidars;
    let mut radars = job.rig.radars;
    if let Some(pronto) = &job.rig.pronto {
        // The radar budget is per rendered tick.
        let tick_hz = frames.first().and_then(|frame| frame["tickHz"].as_f64())
            .context("rig.pronto needs a sceneState whose frames carry tickHz (the radar budget is per tick)")?;
        let (c, l, r) = pronto_rig(pronto, tick_hz)?;
        cameras.extend(c);
        lidars.extend(l);
        radars.extend(r);
    }
    anyhow::ensure!(
        !(cameras.is_empty() && lidars.is_empty() && radars.is_empty()),
        "job rig has no sensors"
    );
    anyhow::ensure!(
        !job.observe || !frames.is_empty(),
        "job `observe` needs a sceneState: a static scene has no actors to observe"
    );
    std::fs::create_dir_all(&job.out_dir)?;
    Ok(Plan {
        spec,
        frames,
        cameras,
        lidars,
        radars,
        passes: job.passes,
        out_dir: Some(job.out_dir),
        observe: job.observe,
        // The job's range, unless the command line names one.
        start: args.start_set.unwrap_or(job.ticks.start.unwrap_or(0)), // fallback-ok: a job without ticks.start starts at tick 0 by the v2 schema
        ticks: args.ticks_set.unwrap_or(job.ticks.count.unwrap_or(1)), // fallback-ok: a job without ticks.count renders one tick by the v2 schema
    })
}

/// The Pronto port-E qualification rig (`prontoRig` of a
/// `render-qualification-program/v1` document) as attached service sensors,
/// plus the trailing chase camera. Sheet mounts are longitudinal/lateral-
/// right/up millimetres from the pod datum; see the qualification program.
fn pronto_rig(
    rig: &ProntoRig,
    tick_hz: f64,
) -> Result<(
    Vec<serde_json::Value>,
    Vec<serde_json::Value>,
    Vec<serde_json::Value>,
)> {
    const POD_FRONT_DATUM_M: f64 = 0.85;
    const POD_PLATE_HEIGHT_M: f64 = 1.78;
    let doc: serde_json::Value = serde_json::from_slice(&std::fs::read(&rig.program)?)?;
    let sensors = doc["prontoRig"]["sensors"]
        .as_array()
        .context("prontoRig.sensors missing")?;
    let f = |v: &serde_json::Value| v.as_f64().unwrap_or(0.0); // fallback-ok: an omitted sheet mount/rotation component is 0 by the program's definition
    let attach = |s: &serde_json::Value, host_visible: bool| -> serde_json::Value {
        let m = &s["sourceMountMm"];
        let r = &s["rotationDeg"];
        serde_json::json!({
            "actorId": rig.host,
            // Wire mount: forward / right / up. The sheet's lateral axis is
            // lateral-right; the service's middle component is the Bevy
            // actor-local z (left), hence the sign.
            "offsetM": [POD_FRONT_DATUM_M + f(&m["longitudinal"]) / 1000.0, -f(&m["lateralRight"]) / 1000.0, POD_PLATE_HEIGHT_M + f(&m["up"]) / 1000.0],
            "yawDeg": f(&r["yaw"]), "pitchDeg": f(&r["pitch"]), "rollDeg": f(&r["roll"]),
            "hostVisible": host_visible,
        })
    };
    let (mut cameras, mut lidars, mut radars) = (Vec::new(), Vec::new(), Vec::new());
    let (w, h) = (f64::from(rig.width), f64::from(rig.height));
    for s in sensors {
        let id = s["id"].as_str().context("prontoRig sensor id")?;
        match s["type"].as_str() {
            Some("dash_camera") => cameras.push(serde_json::json!({
                "sensorId": id, "width": rig.width, "height": rig.height,
                "fovDeg": vertical_fov(s["horizontalFovDeg"].as_f64().context("camera horizontalFovDeg")?, w, h),
                "eye": [0.0, 0.0, 0.0], "target": [0.0, 0.0, 1.0], "attach": attach(s, false),
            })),
            Some("lidar") => lidars.push(serde_json::json!({
                "sensorId": id, "attach": attach(s, false), "channels": 128, "rotationFrequencyHz": 10.0,
                "pointsPerSecond": 1_300_000, "horizontalFovDeg": s["horizontalFovDeg"].as_f64().unwrap_or(360.0), // fallback-ok: a lidar without an hfov is a spinning 360-degree unit in the program
                "verticalFovDeg": s["verticalFovDeg"].as_f64().context("lidar verticalFovDeg")?, "rangeM": 200.0,
            })),
            Some("radar") => radars.push(serde_json::json!({
                // The sheet's 1500 points/s is below the fan model's 64 rays
                // per tick at the rig's tick rate; the rig declares the
                // model's minimum explicitly (what the retired capture binary
                // rendered by silently raising its budget).
                "sensorId": id, "attach": attach(s, false), "pointsPerSecond": (64.0 * tick_hz).ceil().max(1_500.0) as u32,
                "horizontalFovDeg": s["horizontalFovDeg"].as_f64().context("radar horizontalFovDeg")?,
                "verticalFovDeg": s["verticalFovDeg"].as_f64().unwrap_or(30.0), // fallback-ok: the program's radar default elevation span
                "rangeM": 100.0,
            })),
            other => bail!("unknown prontoRig sensor type {other:?} for {id}"),
        }
    }
    // Trailing chase (presentation): 9 m behind, 3.4 m up, -11.3 deg, HFOV 70.
    cameras.push(serde_json::json!({
        "sensorId": "chase-cam-trailing", "width": rig.width, "height": rig.height,
        "fovDeg": vertical_fov(70.0, w, h), "eye": [0.0, 0.0, 0.0], "target": [0.0, 0.0, 1.0],
        "attach": {"actorId": rig.host, "offsetM": [-9.0, 0.0, 3.4], "pitchDeg": -11.3, "hostVisible": true},
    }));
    Ok((cameras, lidars, radars))
}

/// Everything one run renders.
struct Plan {
    spec: SceneSpec,
    /// Scene-state frames (`load_scene_state`); empty for a static scene.
    frames: Vec<serde_json::Value>,
    cameras: Vec<serde_json::Value>,
    lidars: Vec<serde_json::Value>,
    radars: Vec<serde_json::Value>,
    /// `rgb | id | depth | semantic` for the cameras.
    passes: Vec<String>,
    /// Write every artifact of every tick here (plus `results.json`).
    out_dir: Option<PathBuf>,
    /// Write `<out_dir>/observed-frames.jsonl` (job files only).
    observe: bool,
    start: usize,
    ticks: usize,
}

pub fn run(argv: Vec<String>) -> Result<()> {
    let args = parse_args(argv)?;
    let plan = match &args.job {
        Some(job) => plan_from_job(job, &args)?,
        None => plan_from_replay(&args)?,
    };
    let Plan {
        mut spec,
        frames,
        cameras,
        lidars,
        radars,
        passes,
        out_dir,
        observe,
        start,
        ticks,
    } = plan;
    crate::server::apply_render_cli(&mut spec, args.preset.clone(), &args.render_sets)?;
    let (resolved, _) = spec.render_config()?;
    eprintln!(
        "simforge-render job: render config {}",
        serde_json::to_string(&resolved)?
    );
    eprintln!(
        "simforge-render job: {} cameras, {} lidars, {} radars, ticks {}..{} of {}",
        cameras.len(),
        lidars.len(),
        radars.len(),
        start,
        start + ticks,
        frames.len()
    );

    let t0 = Instant::now();
    let app = prewarm(&spec)?;
    let prewarm_s = t0.elapsed().as_secs_f64();
    eprintln!("simforge-render job: prewarmed in {prewarm_s:.1} s");
    let shm_path = std::env::temp_dir().join(format!("simforge-render-job.{}", std::process::id()));
    let shm = ShmRing::create(&shm_path, (args.shm_size_mb * 1024 * 1024) as usize)?;
    let mut state = ServiceState::new(app, &spec, shm_path.to_string_lossy().into_owned(), shm)?;

    if !frames.is_empty() {
        let response = dispatch(
            &mut state,
            request(serde_json::json!({"i": 1, "op": "load_scene_state", "states": frames}))?,
        );
        if let ResponseBody::Error { error, .. } = &response.body {
            bail!("load_scene_state: {error}");
        }
    }
    // A static scene (no scene-state) still renders its ticks: tick numbers
    // only label the artifacts.
    let tick_count = if frames.is_empty() {
        start + ticks
    } else {
        frames.len()
    };
    // fallback-ok: discard load-time timings so the ticks start from zero
    let _ = state.app.take_gpu_pass_times();

    if let Some(sweep) = &args.sweep {
        // One process, one map load: every entry reconfigures the running
        // service (history-free pinned captures make that equivalent to a
        // fresh process) and renders the same ticks.
        let entries: Vec<serde_json::Value> = serde_json::from_slice(&std::fs::read(sweep)?)?;
        let mut results = Vec::new();
        for (index, entry) in entries.iter().enumerate() {
            let name = entry["name"]
                .as_str()
                .context("sweep entry needs a name")?
                .to_string();
            let request: crate::server::RenderRequestJson =
                serde_json::from_value(entry["render"].clone())
                    .with_context(|| format!("sweep entry {name}: render"))?;
            let config = request
                .0
                .resolve()
                .with_context(|| format!("sweep entry {name}"))?;
            state
                .reconfigure(&config)
                .map_err(|error| anyhow::anyhow!("sweep entry {name}: {error}"))?;
            let dump = args.dump_dir.as_ref().map(|dir| dir.join(&name));
            let pass = sweep_pass(
                &mut state,
                &cameras,
                if index == 0 { &lidars } else { &[] },
                &radars,
                start,
                ticks,
                tick_count,
                dump.as_deref(),
                args.dump_every,
            )?;
            eprintln!(
                "simforge-render job sweep {name}: {:.1} ms/tick, GPU {:.1} ms/frame",
                pass["medianMsPerTick"], pass["gpuFrameMedianMs"]
            );
            results.push(serde_json::json!({"name": name, "renderConfig": config, "result": pass}));
        }
        // fallback-ok: best-effort cleanup of the bench's own ring file
        let _ = std::fs::remove_file(&shm_path);
        if let Some(out) = &args.out {
            std::fs::write(
                out,
                serde_json::to_vec_pretty(
                    &serde_json::json!({"schema": "simforge.render-job-sweep/v1", "entries": results}),
                )?,
            )?;
        }
        return Ok(());
    }

    let end = (start + ticks).min(tick_count);
    if let (true, Some(dir)) = (observe, &out_dir) {
        match std::fs::remove_file(dir.join("observed-frames.jsonl")) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error.into()),
            _ => {}
        }
    }
    let mut artifacts: Vec<serde_json::Value> = Vec::new();
    let mut tick_ms = Vec::new();
    let mut server_ms = Vec::new();
    let mut digests: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut exposures: BTreeMap<String, serde_json::Value> = BTreeMap::new();
    // Non-finite HDR pixels over every tick and camera (see `exposure`).
    let mut non_finite_pixels = 0u64;
    let mut gpu: BTreeMap<String, (f64, usize)> = BTreeMap::new();
    let mut first_tick_ms = 0.0;
    let mut stages: BTreeMap<String, f64> = BTreeMap::new();
    let mut gpu_frames: Vec<f64> = Vec::new();
    for (n, tick) in (start..end).enumerate() {
        let mut body = serde_json::json!({
            "i": 10 + tick, "op": "render_bundle", "sim_tick": tick,
            "cameras": cameras, "passes": passes,
        });
        if !frames.is_empty() {
            body["tick_index"] = serde_json::json!(tick);
        }
        if observe {
            body["observe"] = serde_json::json!(true);
        }
        if n == 0 {
            if !lidars.is_empty() {
                body["lidars"] = serde_json::json!(lidars);
            }
            if !radars.is_empty() {
                body["radars"] = serde_json::json!(radars);
            }
        }
        ablate(state.app.world_mut(), &args.ablate);
        let started = Instant::now();
        let response = dispatch(&mut state, request(body)?);
        let elapsed = started.elapsed().as_secs_f64() * 1000.0;
        let ResponseBody::RenderBundle {
            frames: records,
            server_ms: reported,
            stages: tick_stages,
            observed_actors,
            exposure,
            ..
        } = response.body
        else {
            if let ResponseBody::Error { error, .. } = response.body {
                bail!("tick {tick}: {error}");
            }
            bail!("tick {tick}: unexpected response");
        };
        if let Some(exposure) = exposure {
            for (sensor, camera) in &exposure {
                if camera.non_finite_pixels > 0 {
                    eprintln!(
                        "simforge-render job: tick {tick} {sensor}: {} non-finite (NaN/inf) pixels before tone mapping",
                        camera.non_finite_pixels
                    );
                    non_finite_pixels += u64::from(camera.non_finite_pixels);
                }
            }
            exposures.insert(format!("{tick:08}"), serde_json::to_value(exposure)?);
        }
        if let Some(dir) = &out_dir {
            for record in &records {
                artifacts.push(write_artifact(&state, record, dir, tick)?);
            }
            if observe {
                let actors = observed_actors.with_context(|| {
                    format!("tick {tick}: the service answered `observe` without observed actors")
                })?;
                let frame = &frames[tick];
                // The frame's own simulation time, else its tick over its rate.
                let time = match (frame["t"].as_f64(), frame["tickHz"].as_f64()) {
                    (Some(t), _) => t,
                    (None, Some(hz)) if hz > 0.0 => tick as f64 / hz,
                    _ => bail!("tick {tick}: the scene-state frame has neither `t` nor a positive `tickHz`"),
                };
                use std::io::Write;
                let mut line = serde_json::to_vec(
                    &serde_json::json!({"tick": tick, "time": time, "actors": actors}),
                )?;
                line.push(b'\n');
                std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(dir.join("observed-frames.jsonl"))?
                    .write_all(&line)?;
            }
        }
        for record in &records {
            digests
                .entry(format!("{}:{}", record.sensor_id, record.pass))
                .or_default()
                .push(record.digest.clone());
            if let Some(dir) = &args.dump_dir {
                if record.pass == "rgb" && args.dump_every > 0 && n % args.dump_every == 0 {
                    std::fs::create_dir_all(dir)?;
                    let map = state.shm.as_bytes();
                    let start = record.offset as usize + RECORD_HEADER_BYTES;
                    let data = &map[start..start + record.len as usize];
                    let raw = render_core::engine::strip_padding(
                        data,
                        record.width as usize,
                        record.height as usize,
                        4,
                    );
                    image::save_buffer(
                        dir.join(format!("{}.t{tick:04}.png", record.sensor_id)),
                        &raw,
                        record.width,
                        record.height,
                        image::ColorType::Rgba8,
                    )?;
                }
            }
        }
        for pass in state.app.take_gpu_pass_times() {
            let entry = gpu.entry(pass.path).or_insert((0.0, 0));
            entry.0 += pass.total;
            entry.1 += pass.count;
        }
        let frame_times = state.app.take_gpu_frame_times();
        if n > 0 {
            gpu_frames.extend(frame_times);
        }
        if n == 0 && std::env::var_os("SIMFORGE_DEBUG_VIEW_STATE").is_some() {
            let world = state.app.world_mut();
            let mut q = world.query::<(
                &bevy::prelude::Camera,
                Option<&bevy::light::EnvironmentMapLight>,
                Option<&bevy::light::GeneratedEnvironmentMapLight>,
                Option<&bevy::light::AtmosphereEnvironmentMapLight>,
                Option<&bevy::camera::Exposure>,
            )>();
            let mut rows: Vec<String> = q
                .iter(world)
                .map(|(c, e, g, a, x)| {
                    format!(
                        "order {} env {:?} gen {:?} atm {:?} ev {:?}",
                        c.order,
                        e.map(|e| e.intensity),
                        g.map(|g| g.intensity),
                        a.map(|a| a.intensity),
                        x.map(|x| x.ev100)
                    )
                })
                .collect();
            rows.sort();
            for row in rows {
                eprintln!("view-state {row}");
            }
        }
        if n == 0 {
            first_tick_ms = elapsed;
            eprintln!("simforge-render job: first tick {elapsed:.0} ms (includes lidar BVH build / pipeline warmup)");
            gpu.clear();
        } else {
            tick_ms.push(elapsed);
            server_ms.push(reported);
            if let Some(tick_stages) = tick_stages {
                if let serde_json::Value::Object(map) = serde_json::to_value(tick_stages)? {
                    for (key, value) in map {
                        if let Some(v) = value.as_f64() {
                            *stages.entry(key).or_default() += v;
                        }
                    }
                }
            }
        }
        if n % 8 == 0 {
            eprintln!("simforge-render job: tick {tick} {elapsed:.1} ms");
        }
    }
    // fallback-ok: best-effort cleanup of the bench's own ring file
    let _ = std::fs::remove_file(&shm_path);
    let phases = phase_stats(state.app.render_world_mut());
    for (name, [views, sets, bins, batchable, unbatchable]) in &phases {
        eprintln!("  phase {name:20} views {views:3} multidraw sets {sets:5} bins {bins:6} batchable bins {batchable:5} unbatchable {unbatchable:5}");
    }
    let measured = tick_ms.len().max(1) as f64;
    let mean = tick_ms.iter().sum::<f64>() / measured;
    let mut sorted = tick_ms.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    // fallback-ok: benchmark statistics over zero ticks are reported as 0
    let median = sorted.get(sorted.len() / 2).copied().unwrap_or(0.0);
    let mut gpu_rows: Vec<(String, f64, f64)> = gpu
        .into_iter()
        .map(|(path, (total, count))| (path, total / measured, count as f64 / measured))
        .collect();
    gpu_rows.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
    eprintln!(
        "simforge-render job: mean {mean:.1} ms/tick, median {median:.1} ms/tick over {} ticks",
        tick_ms.len()
    );
    let mut frames_sorted = gpu_frames.clone();
    frames_sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    // fallback-ok: benchmark statistics without GPU timings are reported as 0
    let gpu_frame_median = frames_sorted
        .get(frames_sorted.len() / 2)
        .copied()
        .unwrap_or(0.0);
    let gpu_frame_total: f64 = gpu_frames.iter().sum();
    eprintln!(
        "simforge-render job: GPU frames {} (median {gpu_frame_median:.1} ms, max {:.1} ms), GPU busy {:.1} ms/tick",
        // fallback-ok: benchmark statistics without GPU timings are reported as 0
        gpu_frames.len(), frames_sorted.last().copied().unwrap_or(0.0), gpu_frame_total / measured
    );
    for (key, total) in &stages {
        eprintln!("  stage {key:24} {:9.2} /tick", total / measured);
    }
    for (path, per_tick, spans) in gpu_rows
        .iter()
        .filter(|row| row.0.ends_with("elapsed_gpu"))
        .take(40)
    {
        eprintln!("  {per_tick:9.3} ms/tick  {spans:5.1} spans  {path}");
    }
    let result = serde_json::json!({
        "schema": "simforge.render-job-results/v2",
        "ablate": args.ablate,
        "renderConfig": resolved,
        "unlabeledStatics": crate::server::UnlabeledStatics::of(&state.legend),
        "prewarmS": prewarm_s,
        "firstTickMs": first_tick_ms,
        "ticks": tick_ms.len(),
        "meanMsPerTick": mean,
        "medianMsPerTick": median,
        "tickMs": tick_ms,
        "gpuFrameMs": gpu_frames,
        "gpuFrameMedianMs": gpu_frame_median,
        "gpuBusyMsPerTick": gpu_frame_total / measured,
        "serverMs": server_ms,
        "gpuPerTick": gpu_rows.iter().map(|(p, v, c)| serde_json::json!({"path": p, "perTick": v, "spansPerTick": c})).collect::<Vec<_>>(),
        "stagesPerTick": stages.iter().map(|(k, v)| (k.clone(), serde_json::json!(v / measured))).collect::<serde_json::Map<_, _>>(),
        "digests": digests,
        // Per tick, per RGB camera: the metered exposure (dash-cam camera
        // model), with the frame's non-finite pixel count.
        "exposure": exposures,
        // Their sum: a correct render has none (the golden gate requires 0).
        "nonFinitePixels": non_finite_pixels,
        "artifacts": artifacts,
    });
    if let Some(dir) = &out_dir {
        std::fs::write(
            dir.join("results.json"),
            serde_json::to_vec_pretty(&result)?,
        )?;
        // With an instance-ID pass: which static mesh each id is, so an ID
        // pixel can be traced to the map object that drew it.
        if passes.iter().any(|pass| pass == "id") {
            let legend: BTreeMap<u32, &String> =
                state.legend.iter().map(|(id, name)| (*id, name)).collect();
            std::fs::write(dir.join("legend.json"), serde_json::to_vec_pretty(&legend)?)?;
        }
    }
    if let Some(out) = &args.out {
        std::fs::write(out, serde_json::to_vec_pretty(&result)?)?;
    }
    Ok(())
}
