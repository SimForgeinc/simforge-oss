//! Bounded source interval and explicit sampled timestamps. Profiles select
//! cadence/products only; the RGB renderer and encoder quality are shared.
use super::CaptureConfig;
use crate::scene_state::SceneSequence;
use anyhow::{bail, Result};
use bevy::prelude::Resource;
use serde_json::json;
use std::collections::BTreeSet;

#[derive(Resource)]
pub(super) struct CapturePlan {
    pub target_ticks: BTreeSet<u32>,
    pub source_ticks: usize,
    pub metadata: serde_json::Value,
}

pub(super) fn prepare(args: &mut CaptureConfig, source: &SceneSequence) -> Result<(CapturePlan, SceneSequence)> {
    let cadence_flags = usize::from(args.capture_hz.is_some())
        + usize::from(!args.timestamps_seconds.is_empty()) + usize::from(!args.keyframes_seconds.is_empty());
    if cadence_flags > 1 { bail!("choose exactly one cadence control: rate, timestamps, or keyframes"); }
    args.consumer.validate().map_err(anyhow::Error::msg)?;
    let hz = source.ticks[0].tick_hz as f64;
    if !hz.is_finite() || hz <= 0.0 || source.ticks.iter().any(|s| s.tick_hz as f64 != hz) {
        bail!("capture requires one finite, positive scene tick rate");
    }
    if source.ticks.windows(2).any(|p| p[0].tick >= p[1].tick) {
        bail!("source timestamps must be strictly increasing; repeated scene ticks overwrite artifacts");
    }
    if let Some(host) = &source.rig_host_id {
        if let Some(missing) = source.ticks.iter().find(|state| source.rig_host_at(state).is_none()) {
            bail!("rig host {host} has no live pose at source tick {}; refusing to switch hosts", missing.tick);
        }
    }
    let source_ticks = source.ticks.len();
    let first = source.ticks[0].tick;
    let last = source.ticks.last().unwrap().tick;
    let capture_hz = args.consumer.camera_hz;
    if !capture_hz.is_finite() || capture_hz <= 0.0 || capture_hz > hz {
        bail!("capture rate must be positive and no greater than scene tick rate {hz}");
    }
    let index_at = |seconds: f64| -> Result<usize> {
        let tick = seconds * hz;
        if !tick.is_finite() || tick < first as f64 || tick > last as f64 || (tick - tick.round()).abs() > 1e-4 {
            bail!("timestamp {seconds} must be an exact scene tick within [{}, {}] seconds", first as f64 / hz, last as f64 / hz);
        }
        source.ticks.binary_search_by_key(&(tick.round() as u32), |s| s.tick)
            .map_err(|_| anyhow::anyhow!("timestamp {seconds} was excluded by the source stride"))
    };
    let mut selected = BTreeSet::new();
    let mut targets = BTreeSet::new();
    let mut windows = Vec::new();
    if !args.keyframes_seconds.is_empty() {
        if !args.timestamps_seconds.is_empty() { bail!("choose --keyframes-seconds or --timestamps-seconds, not both"); }
        for &t0 in &args.keyframes_seconds {
            let current = index_at(t0)?;
            targets.insert(source.ticks[current].tick);
            let mut history = Vec::new();
            for frame in 0..args.consumer.camera_history_frames {
                let offset=(frame as f64+1.0-args.consumer.camera_history_frames as f64)/args.consumer.camera_hz;
                let index = index_at(t0 + offset)?;
                selected.insert(index);
                history.push(source.ticks[index].tick);
            }
            windows.push(json!({"keyframeSeconds":t0,"keyframeTick":source.ticks[current].tick,"cameraTicks":history}));
        }
    } else if !args.timestamps_seconds.is_empty() {
        for &seconds in &args.timestamps_seconds { selected.insert(index_at(seconds)?); }
    } else {
        let step = hz / capture_hz;
        if (step - step.round()).abs() > 1e-6 { bail!("capture rate must divide the scene tick rate exactly; use --timestamps-seconds for irregular sampling"); }
        let step = step.round() as u32;
        for tick in (first..=last).step_by(step as usize) {
            let index=source.ticks.binary_search_by_key(&tick,|scene|scene.tick)
                .map_err(|_|anyhow::anyhow!("declared camera cadence requires tick {tick}, excluded by the source stride"))?;
            selected.insert(index);
        }
    }
    if selected.is_empty() { bail!("capture schedule selected no frames"); }
    if args.keyframes_seconds.is_empty() {
        targets.extend(selected.iter().map(|&index| source.ticks[index].tick));
    }
    let sampled_ticks: Vec<u32> = selected.iter().map(|&index| source.ticks[index].tick).collect();
    let cadence: Vec<u32> = sampled_ticks.windows(2).map(|pair| pair[1] - pair[0]).collect();
    if args.consumer.video() && cadence.windows(2).any(|pair| pair[0] != pair[1]) {
        bail!("irregular timestamps require image artifacts, not constant-frame-rate video");
    }
    let inferred_fps = cadence.first().map(|&step| hz / step as f64).unwrap_or(capture_hz);
    args.video_fps = Some(inferred_fps);
    let sampled: Vec<_> = selected.into_iter().map(|index| source.ticks[index].clone()).collect();
    let metadata = json!({
        "schema":"simforge.capture-samples/v1", "profile":args.profile,
        "sceneTickHz":hz, "sourceFrames":source_ticks, "sourceFirstTick":first, "sourceLastTick":last,
        "sourceDurationSeconds":(last as f64 - first as f64 + args.tick_stride as f64) / hz,
        "requestedCameraHz":capture_hz, "requestedTimestampsSeconds":args.timestamps_seconds,
        "requestedKeyframesSeconds":args.keyframes_seconds, "consumer":args.consumer,
        "rgbWidth":args.consumer.width,"rgbHeight":args.consumer.height,"rgbFormat":args.consumer.rgb_format(),
        "videoFps":args.video_fps, "jpegQuality":args.consumer.jpeg_quality(),
        "visualSettings":{"tonemapping":"AgX","msaa":1,"taa":false,"sharedShadows":!args.per_view_shadows,
            "noShadows":args.no_shadows,"shadowCascades":args.shadow_cascades,"fastGpu":args.fast_gpu,
            "videoEncoder":args.consumer.video_encoder(),"videoQualityParameter":args.consumer.video_quality()},
        "sceneState":args.scene_state, "rigHostId":source.rig_host_id,
        "arguments":args,
        "projection":"pinhole", "cameraForward":"-Z", "depthFormat":args.consumer.depth_format(),
        "physicalProjectionAspect":args.projection_aspect.unwrap_or(args.consumer.width as f32/args.consumer.height as f32),
        "projectionAspectLocked":args.projection_aspect.is_some(),
        "lidarFrame":"sensor-local metres: +X forward, +Y up, +Z camera-right at identity heading",
        "radarFrame":"sensor azimuth toward +Z, elevation toward +Y; relative radial velocity in metres/second",
        "metricDepth":if args.consumer.depth_format()=="metric-f16" {json!({"width":args.consumer.width/args.consumer.depth_scale(),"height":args.consumer.height/args.consumer.depth_scale(),"units":"metres","axis":"positive optical Z","reduction":"minimum axial depth per raster block; foreground-biased","nearMetres":0.5,"validRange":[1,120],"invalid":0,"mask":"uint8, 0 invalid / 1 valid","notPaiSubstitute":"dense pinhole raster, not sparse lidar/f-theta projection"})} else {serde_json::Value::Null},
        "samples":sampled.iter().enumerate().map(|(index,s)|json!({"frameIndex":index,"tick":s.tick,"timestampSeconds":s.tick as f64/hz,"targets":targets.contains(&s.tick)})).collect::<Vec<_>>(),
        "windows":windows,
    });
    Ok((CapturePlan { target_ticks: targets, source_ticks, metadata }, SceneSequence { ticks: sampled, rig_host_id: source.rig_host_id.clone() }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;
    use super::super::CaptureArgs;
    use crate::scene_state::{SceneState, SCENE_STATE_SCHEMA};

    fn source() -> SceneSequence {
        SceneSequence { ticks: (0..=1000).map(|tick| SceneState {
            version: SCENE_STATE_SCHEMA.into(), map_id: "fixture".into(), tick,
            tick_hz: 50.0, weather: None, time_of_day: None, actors: Vec::new(),
        }).collect(), rig_host_id: None }
    }

    fn args(extra: &[&str]) -> CaptureConfig {
        let mut argv = vec!["capture", "--rig-program", "unused", "--glbs", "/unused.gltf", "--out", "/unused"];
        argv.extend_from_slice(extra);
        CaptureConfig::resolve(CaptureArgs::parse_from(argv)).unwrap()
    }

    #[test]
    fn sparse_schedule_stops_at_source_boundary_and_preserves_time() {
        let source = source();
        let mut options = args(&["--profile","showcase","--capture-hz","2"]);
        let (plan, scene) = prepare(&mut options, &source).unwrap();
        assert_eq!(scene.ticks.iter().map(|s| s.tick).collect::<Vec<_>>(), (0..=1000).step_by(25).collect::<Vec<_>>());
        assert_eq!(plan.source_ticks, 1001);
        assert_eq!(plan.metadata["samples"][40]["timestampSeconds"], 20.0);
        assert_eq!(options.video_fps, Some(2.0));
    }

    #[test]
    fn overlapping_windows_share_history_but_not_current_targets() {
        let source = source();
        let mut options = args(&["--keyframes-seconds", "8,8.5"]);
        let (plan, scene) = prepare(&mut options, &source).unwrap();
        assert_eq!(scene.ticks.iter().map(|s| s.tick).collect::<Vec<_>>(), [325,350,375,400,425]);
        assert_eq!(plan.target_ticks, BTreeSet::from([400,425]));
        assert_eq!(plan.metadata["windows"][0]["cameraTicks"], json!([325,350,375,400]));
        assert_eq!(plan.metadata["windows"][1]["cameraTicks"], json!([350,375,400,425]));
        assert!(prepare(&mut args(&["--keyframes-seconds", "1"]), &source).is_err());
    }

    #[test]
    fn invalid_cadence_never_rounds_pads_or_retimes_video() {
        for extra in [
            vec!["--timestamps-seconds", "20.02"],
            vec!["--timestamps-seconds", "0.01"],
            vec!["--profile","showcase","--timestamps-seconds","0,0.5,2"],
        ] {
            assert!(prepare(&mut args(&extra), &source()).is_err(), "{extra:?}");
        }
        assert!(CaptureArgs::try_parse_from(["capture","--rig-program","unused","--glbs","/unused","--out","/unused",
            "--capture-hz","2","--timestamps-seconds","0,1"]).is_err());
        let mut strided=source();
        strided.ticks.retain(|state|state.tick%2==0);
        assert!(prepare(&mut args(&[]),&strided).is_err(),
            "a source stride must not silently turn the declared 2 Hz consumer into 1 Hz");
    }
}
