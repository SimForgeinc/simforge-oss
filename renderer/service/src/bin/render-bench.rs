//! `render-bench` — replay a real native render job against the resident
//! service state, in process, and report where each tick's time goes.
//!
//! It drives exactly the request path the Studio worker drives
//! (`load_scene_state` once, then one `render_bundle` per tick with the rig's
//! attached cameras, lidar and radar), through [`service::server::dispatch`],
//! minus the socket and the Node-side encoders. That isolates the service:
//! scene application, readiness settling, GPU rendering, readback, CPU
//! sensors and shm publication.
//!
//! Inputs are the job's own files: the worker writes
//! `native-service-scene.json` and `trace/native-trace.json` into the job
//! workspace; the render intent supplies the sources and their mounts.
//!
//! Usage:
//!   render-bench --scene native-service-scene.json --trace native-trace.json
//!       --intent intent.json [--glb master.gltf] [--models actor-assets]
//!       [--start 0] [--ticks 48] [--sources all|rgb|lidar|<outputName,...>]
//!       [--dump-dir DIR --dump-every N] [--out result.json]
//!
//! `SIMFORGE_RENDER_DIAGNOSTICS=1` adds per-pass GPU timings (Bevy's
//! render diagnostics; totals are per tick, summed over views and frames).
use anyhow::{bail, Context, Result};
use service::proto::{ResponseBody, WireRequest};
use service::server::{dispatch, prewarm, SceneSpec, ServiceState};
use service::shm::{ShmRing, RECORD_HEADER_BYTES};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Instant;

struct Args {
    scene: PathBuf,
    trace: PathBuf,
    intent: PathBuf,
    glb: Option<String>,
    models: Option<String>,
    start: usize,
    ticks: usize,
    sources: String,
    dump_dir: Option<PathBuf>,
    dump_every: usize,
    out: Option<PathBuf>,
    shm_size_mb: u64,
}

fn parse_args() -> Result<Args> {
    let mut args = std::env::args().skip(1);
    let mut parsed = Args {
        scene: PathBuf::new(),
        trace: PathBuf::new(),
        intent: PathBuf::new(),
        glb: None,
        models: None,
        start: 0,
        ticks: 48,
        sources: "all".into(),
        dump_dir: None,
        dump_every: 0,
        out: None,
        shm_size_mb: 512,
    };
    while let Some(arg) = args.next() {
        let mut value = || args.next().with_context(|| format!("{arg} requires a value"));
        match arg.as_str() {
            "--scene" => parsed.scene = value()?.into(),
            "--trace" => parsed.trace = value()?.into(),
            "--intent" => parsed.intent = value()?.into(),
            "--glb" => parsed.glb = Some(value()?),
            "--models" => parsed.models = Some(value()?),
            "--start" => parsed.start = value()?.parse()?,
            "--ticks" => parsed.ticks = value()?.parse()?,
            "--sources" => parsed.sources = value()?,
            "--dump-dir" => parsed.dump_dir = Some(value()?.into()),
            "--dump-every" => parsed.dump_every = value()?.parse()?,
            "--out" => parsed.out = Some(value()?.into()),
            "--shm-size-mb" => parsed.shm_size_mb = value()?.parse()?,
            other => bail!("unknown argument {other}"),
        }
    }
    if parsed.scene.as_os_str().is_empty() || parsed.trace.as_os_str().is_empty() || parsed.intent.as_os_str().is_empty() {
        bail!("--scene, --trace and --intent are required");
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
    let f = |v: &serde_json::Value| v.as_f64().unwrap_or(0.0);
    serde_json::json!({
        "actorId": source["actorId"],
        "offsetM": [f(&p["x"]), -f(&p["z"]), f(&p["y"])],
        "yawDeg": -f(&r["yawRad"]).to_degrees(),
        "pitchDeg": f(&r["pitchRad"]).to_degrees() + pitch_offset_deg,
        "hostVisible": source["sensorId"] == "chase-cam-trailing",
    })
}

fn vertical_fov(horizontal_deg: f64, width: f64, height: f64) -> f64 {
    2.0 * ((horizontal_deg.to_radians() / 2.0).tan() * height / width).atan().to_degrees()
}

fn main() -> Result<()> {
    let args = parse_args()?;
    let mut spec_json: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&args.scene)?)?;
    if let Some(glb) = &args.glb {
        spec_json["glbs"] = serde_json::json!([glb]);
    }
    if let Some(models) = &args.models {
        spec_json["vehicleModels"] = serde_json::json!(models);
        spec_json["pedestrianModels"] = serde_json::json!(models);
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
            let (w, h) = (a["width"].as_f64().unwrap(), a["height"].as_f64().unwrap());
            serde_json::json!({
                "sensorId": s["outputName"], "width": w as u32, "height": h as u32,
                "fovDeg": vertical_fov(a["horizontalFovDeg"].as_f64().unwrap(), w, h),
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
    eprintln!(
        "render-bench: {} cameras, {} lidars, {} radars, ticks {}..{} of {}",
        cameras.len(), lidars.len(), radars.len(), args.start, args.start + args.ticks, frames.len()
    );

    let t0 = Instant::now();
    let app = prewarm(&spec)?;
    let prewarm_s = t0.elapsed().as_secs_f64();
    eprintln!("render-bench: prewarmed in {prewarm_s:.1} s");
    let shm_path = std::env::temp_dir().join(format!("render-bench.{}", std::process::id()));
    let shm = ShmRing::create(&shm_path, (args.shm_size_mb * 1024 * 1024) as usize)?;
    let mut state = ServiceState::new(app, &spec, shm_path.to_string_lossy().into_owned(), shm)?;

    let response = dispatch(&mut state, request(serde_json::json!({"i": 1, "op": "load_scene_state", "states": frames}))?);
    if let ResponseBody::Error { error, .. } = &response.body {
        bail!("load_scene_state: {error}");
    }
    let _ = state.app.take_gpu_pass_times();

    let end = (args.start + args.ticks).min(frames.len());
    let mut tick_ms = Vec::new();
    let mut server_ms = Vec::new();
    let mut digests: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut gpu: BTreeMap<String, (f64, usize)> = BTreeMap::new();
    let mut first_tick_ms = 0.0;
    for (n, tick) in (args.start..end).enumerate() {
        let mut body = serde_json::json!({
            "i": 10 + tick, "op": "render_bundle", "sim_tick": tick, "tick_index": tick,
            "cameras": cameras, "passes": ["rgb"],
        });
        if n == 0 {
            if !lidars.is_empty() { body["lidars"] = serde_json::json!(lidars); }
            if !radars.is_empty() { body["radars"] = serde_json::json!(radars); }
        }
        let started = Instant::now();
        let response = dispatch(&mut state, request(body)?);
        let elapsed = started.elapsed().as_secs_f64() * 1000.0;
        let ResponseBody::RenderBundle { frames: records, server_ms: reported, .. } = response.body else {
            if let ResponseBody::Error { error, .. } = response.body { bail!("tick {tick}: {error}"); }
            bail!("tick {tick}: unexpected response");
        };
        for record in &records {
            digests.entry(format!("{}:{}", record.sensor_id, record.pass)).or_default().push(record.digest.clone());
            if let Some(dir) = &args.dump_dir {
                if record.pass == "rgb" && args.dump_every > 0 && n % args.dump_every == 0 {
                    std::fs::create_dir_all(dir)?;
                    let map = state.shm.as_bytes();
                    let start = record.offset as usize + RECORD_HEADER_BYTES;
                    let data = &map[start..start + record.len as usize];
                    let raw = render_core::engine::strip_padding(data, record.width as usize, record.height as usize, 4);
                    image::save_buffer(
                        dir.join(format!("{}.t{tick:04}.png", record.sensor_id)),
                        &raw, record.width, record.height, image::ColorType::Rgba8,
                    )?;
                }
            }
        }
        for pass in state.app.take_gpu_pass_times() {
            let entry = gpu.entry(pass.path).or_insert((0.0, 0));
            entry.0 += pass.total;
            entry.1 += pass.count;
        }
        if n == 0 {
            first_tick_ms = elapsed;
            eprintln!("render-bench: first tick {elapsed:.0} ms (includes lidar BVH build / pipeline warmup)");
            gpu.clear();
        } else {
            tick_ms.push(elapsed);
            server_ms.push(reported);
        }
        if n % 8 == 0 {
            eprintln!("render-bench: tick {tick} {elapsed:.1} ms");
        }
    }
    let _ = std::fs::remove_file(&shm_path);
    let measured = tick_ms.len().max(1) as f64;
    let mean = tick_ms.iter().sum::<f64>() / measured;
    let mut sorted = tick_ms.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let median = sorted.get(sorted.len() / 2).copied().unwrap_or(0.0);
    let mut gpu_rows: Vec<(String, f64, f64)> = gpu
        .into_iter()
        .map(|(path, (total, count))| (path, total / measured, count as f64 / measured))
        .collect();
    gpu_rows.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
    eprintln!("render-bench: mean {mean:.1} ms/tick, median {median:.1} ms/tick over {} ticks", tick_ms.len());
    for (path, per_tick, spans) in gpu_rows.iter().filter(|row| row.0.ends_with("elapsed_gpu")).take(40) {
        eprintln!("  {per_tick:9.3} ms/tick  {spans:5.1} spans  {path}");
    }
    let result = serde_json::json!({
        "schema": "simforge.render-bench/v1",
        "prewarmS": prewarm_s,
        "firstTickMs": first_tick_ms,
        "ticks": tick_ms.len(),
        "meanMsPerTick": mean,
        "medianMsPerTick": median,
        "tickMs": tick_ms,
        "serverMs": server_ms,
        "gpuPerTick": gpu_rows.iter().map(|(p, v, c)| serde_json::json!({"path": p, "perTick": v, "spansPerTick": c})).collect::<Vec<_>>(),
        "digests": digests,
    });
    if let Some(out) = &args.out {
        std::fs::write(out, serde_json::to_vec_pretty(&result)?)?;
    }
    Ok(())
}
