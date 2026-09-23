use super::*;
use std::sync::Arc;
use simforge_core::map::{LaneGraph, TopologyIndex};

fn fixture(options: EpisodeOptions) -> EpisodeSpec {
    let document: Value = serde_json::from_str(include_str!(
        "../../../../../adapters/gym/tests/fixtures/synthetic-episode.json"
    )).unwrap();
    let instance = &document["instances"][0];
    let graph = Arc::new(LaneGraph::new(TopologyIndex::from_json_slice(
        &serde_json::to_vec(&instance["topology"]).unwrap()).unwrap()));
    let mut scenario = simforge_core::types::parse_scenario_input(
        &instance["input"].to_string()).unwrap();
    scenario.clip_seconds = 30.0;
    EpisodeSpec { scenario, topology: RunOptions::new(graph), options }
}

fn speed(value: f64) -> EpisodeAction {
    EpisodeAction::Setpoint { speed_mps: Some(value), acceleration_mps2: None,
        preview_point: None, preview_heading_rad: None, motion_direction: None }
}

#[test]
fn state_channel_matches_env_for_thirty_seconds_and_reset_replays() {
    let spec = fixture(EpisodeOptions { seed: 42, max_decisions: Some(300), ..EpisodeOptions::default() });
    let mut env_input = spec.scenario.clone();
    env_input.seed = Seed::from(42u32);
    let mut env = EnvSession::new(env_input, spec.topology.clone(), EpisodeConfig {
        max_decisions: Some(300), ..EpisodeConfig::default()
    }).unwrap();
    let mut episode = Episode::new(spec).unwrap();
    assert_eq!(episode.reset().unwrap().state_vector, env.reset(None).unwrap().observation.state_vector.as_ref());
    let before = episode.snapshot().unwrap();
    std::thread::sleep(std::time::Duration::from_millis(2));
    assert_eq!(episode.snapshot().unwrap(), before, "offline barrier advanced during inference");
    for _ in 0..300 {
        let expected = env.step(Some(ActionOverride { target_speed_mps: Some(8.0),
            motion_direction: Some(MotionDirection::Forward), ..ActionOverride::default() })).unwrap();
        let actual = episode.step(speed(8.0)).unwrap();
        assert_eq!(actual.obs.state_vector, expected.observation.state_vector.as_ref());
        assert_eq!(actual.reward_terms, &expected.info.reward_terms);
        assert_eq!((actual.reward, actual.terminated, actual.truncated),
            (expected.reward, expected.terminated, expected.truncated));
        assert!(actual.obs.objects.is_none());
        assert_eq!(actual.dl.el, None);
    }
    let digest = episode.trace_digest().to_owned();
    let core = episode.finish().unwrap();
    assert_eq!((core.status, core.decisions, core.timing.policy_simulation_s), ("succeeded", 300, 30.0));
    assert!(episode.step(speed(8.0)).is_err());
    episode.reset().unwrap();
    for _ in 0..300 { episode.step(speed(8.0)).unwrap(); }
    assert_eq!(episode.trace_digest(), digest);
    println!("30s Rust Episode/EnvSession state parity: {digest}");
}

#[test]
fn applied_controls_are_physics_inputs_not_requested_setpoints() {
    let mut episode = Episode::new(fixture(EpisodeOptions::default())).unwrap();
    episode.reset().unwrap();
    let control = episode.step(EpisodeAction::Control { c: [1.0, 0.0, 0.7] })
        .unwrap().applied_control.expect("dynamic ego has actuator evidence");
    assert_eq!(control.steer, 0.7, "input steering is not the lagged wheel angle");
    assert!(control.throttle > 0.0 && control.throttle < 1.0, "actuator evidence must reflect the physical jerk limit, not the requested full pedal");
    let sim = episode.env.simulation().unwrap();
    assert_eq!(Some(control), sim.applied_control(sim.actor_index(episode.ego()).unwrap()));
    let row: Value = serde_json::from_str(episode.trace_json().lines().last().unwrap()).unwrap();
    assert_eq!(serde_json::from_value::<VehicleControl>(row["appliedControl"].clone()).unwrap(), control);
    let resolved = episode.step(speed(0.0)).unwrap().applied_control.unwrap();
    assert!(resolved.brake > 0.0, "setpoint controller braking reaches actuator evidence");
}

#[test]
fn warmup_is_scripted_and_not_charged_to_policy_budget() {
    let spec = fixture(EpisodeOptions { seed: 5, warmup_decisions: 3,
        max_decisions: Some(2), ..EpisodeOptions::default() });
    let mut input = spec.scenario.clone();
    input.seed = Seed::from(5u32);
    let mut env = EnvSession::new(input, spec.topology.clone(), EpisodeConfig::default()).unwrap();
    env.reset(None).unwrap();
    for _ in 0..3 { env.step(None).unwrap(); }
    let mut episode = Episode::new(spec).unwrap();
    assert_eq!(episode.reset().unwrap().state_vector, env.last_result().observation.state_vector.as_ref());
    assert!(!episode.step(speed(8.0)).unwrap().truncated);
    assert!(episode.step(speed(8.0)).unwrap().truncated);
    let result = episode.finish().unwrap();
    assert_eq!((result.decisions, result.warmup_decisions), (2, 3));
    let trace = episode.trace_json().to_owned();
    episode.finish().unwrap();
    assert_eq!(episode.trace_json(), trace);
    let phases: Vec<String> = trace.lines().filter_map(|line| {
        serde_json::from_str::<Value>(line).unwrap()["phase"].as_str().map(str::to_owned)
    }).collect();
    assert_eq!(phases, ["warmup", "warmup", "warmup", "policy", "policy"]);
}

#[test]
fn realtime_boundary_and_hold_last_retrack_without_reanchoring() {
    let mut episode = Episode::new(fixture(EpisodeOptions {
        mode: EpisodeMode::Realtime { deadline_ms: 10.0, fallback: EpisodeFallback::HoldLast },
        ..EpisodeOptions::default()
    })).unwrap();
    episode.reset().unwrap();
    episode.step_at_latency(speed(1.0), Some(10.1)).unwrap();
    assert_eq!(episode.last_step().dl.ap, "scripted");
    let plan = EpisodeAction::Trajectory { p: vec![[1.0, 0.0, 0.0, 8.0, 0.1], [80.0, 0.0, 0.0, 8.0, 10.0]] };
    episode.step_at_latency(plan.clone(), Some(10.0)).unwrap();
    assert_eq!(episode.last_step().dl.miss, 0);
    assert_eq!(episode.last_step().ex.unwrap().plan_age_s, 0.0);
    episode.step_at_latency(plan, Some(10.0)).unwrap();
    assert!((episode.last_step().ex.unwrap().plan_age_s - 0.1).abs() < 1e-10);
    episode.step_at_latency(speed(0.0), Some(10.1)).unwrap();
    let held = episode.last_step();
    assert_eq!((held.dl.miss, held.dl.ap), (1, "repeat-last"));
    assert!((held.ex.unwrap().plan_age_s - 0.2).abs() < 1e-10);
    assert_eq!(held.ex.unwrap().target_speed_mps, 8.0);
}

#[test]
fn measured_deadline_miss_coasts_and_digest_excludes_latency() {
    let options = EpisodeOptions { mode: EpisodeMode::Realtime {
        deadline_ms: 1.0, fallback: EpisodeFallback::ZeroControl }, ..EpisodeOptions::default() };
    let mut measured = Episode::new(fixture(options.clone())).unwrap();
    measured.reset().unwrap();
    std::thread::sleep(std::time::Duration::from_millis(5));
    let outcome = measured.step(EpisodeAction::Control { c: [1.0, 0.0, 0.5] }).unwrap();
    assert_eq!((outcome.dl.miss, outcome.dl.ap), (1, "zero-control"));
    assert!(outcome.dl.el.unwrap() > 1.0);
    let measured_state = *outcome.obs.state_vector.unwrap();
    let mut replay = Episode::new(fixture(options)).unwrap();
    replay.reset().unwrap();
    replay.step_at_latency(EpisodeAction::Control { c: [1.0, 0.0, 0.5] }, Some(100.0)).unwrap();
    assert_eq!(*replay.last_step().obs.state_vector.unwrap(), measured_state);
    assert_eq!(measured.trace_digest(), replay.trace_digest());
}

#[test]
fn malformed_cameras_and_privilege_mixing_are_refused() {
    let mut options = EpisodeOptions::default();
    options.observation.channels = vec![ObservationChannel::Cameras {
        rig: ResidentCameraRig { cameras: Vec::new() }, passes: vec![CameraPass::Rgb],
        backend: CameraBackend::Service { socket: "/unused".into() }, enhance: None }];
    assert!(matches!(Episode::new(fixture(options)), Err(SessionError::Camera(message))
        if message.contains("must not be empty")));
    let mut options = EpisodeOptions::default();
    options.observation.channels = vec![ObservationChannel::Visible, ObservationChannel::State];
    assert!(Episode::new(fixture(options)).is_err());
}

#[test]
fn replay_admission_and_time_support_cannot_report_success() {
    let mut spec = fixture(EpisodeOptions::default());
    let context = EpisodeReplayContext { scene_id: "fixture".into(), digest: "fixture-digest".into(),
        qualified: true, stock_replay_passed: Some(true), lateral_m: 1000.0,
        longitudinal_s: 1000.0, heading_rad: std::f64::consts::PI,
        recorded_path: vec![[0.0, 0.0, 0.0, 0.0], [0.15, 400.0, 0.0, 0.0]], measure_only: false };
    spec.options.replay_context = Some(context.clone());
    let mut episode = Episode::new(spec).unwrap();
    episode.reset().unwrap();
    assert!(!episode.step(speed(8.0)).unwrap().truncated);
    assert_eq!(episode.step(speed(8.0)).unwrap().term_reason, Some("envelope_exceeded"));
    assert_eq!(episode.finish().unwrap().status, "partial");
    assert!(episode.step(speed(8.0)).is_err());
    let mut spec = fixture(EpisodeOptions::default());
    spec.options.replay_context = Some(EpisodeReplayContext { qualified: false, ..context });
    assert!(Episode::new(spec).is_err());
}

#[test]
fn selected_bev_dimensions_and_early_finish_are_observable() {
    let mut options = EpisodeOptions::default();
    options.observation.channels = vec![ObservationChannel::Bev { h: 24, w: 16, resolution_m: 1.0 }];
    let mut episode = Episode::new(fixture(options)).unwrap();
    let obs = episode.reset().unwrap();
    assert!(obs.state_vector.is_none() && obs.objects.is_none());
    let bev = obs.bev.unwrap();
    assert_eq!((bev.height, bev.width, bev.data.len()), (24, 16, 24 * 16 * 3));
    episode.step(speed(8.0)).unwrap();
    let core = episode.finish().unwrap();
    assert_eq!((core.status, core.truncation), ("partial", Some("caller_finished")));
    assert!(episode.step(speed(8.0)).is_err());
}

#[test]
fn setpoint_preview_changes_the_executed_pose_and_matches_env() {
    let spec = fixture(EpisodeOptions::default());
    let mut env = EnvSession::new(spec.scenario.clone(), spec.topology.clone(), EpisodeConfig::default()).unwrap();
    let mut episode = Episode::new(spec).unwrap();
    episode.reset().unwrap();
    env.reset(None).unwrap();
    let preview = Vec2 { x: 40.0, y: 2.0 };
    for _ in 0..20 {
        let command = EpisodeAction::Setpoint { speed_mps: Some(8.0), acceleration_mps2: None,
            preview_point: Some(preview), preview_heading_rad: Some(0.1), motion_direction: Some(MotionDirection::Forward) };
        let result = episode.step(command).unwrap();
        let reference = env.step(Some(ActionOverride { target_speed_mps: Some(8.0),
            preview_point: Some(preview), preview_heading_rad: Some(0.1),
            motion_direction: Some(MotionDirection::Forward), ..ActionOverride::default() })).unwrap();
        assert_eq!(result.obs.state_vector, reference.observation.state_vector.as_ref());
        assert_eq!(result.term_reason, reference.term_reason());
        if result.terminated || result.truncated { break; }
    }
    assert!(episode.snapshot().unwrap()["actors"][0]["state"]["y"].as_f64().unwrap().abs() > 0.01);
}

#[test]
fn reference_warmup_and_scripted_fallback_use_the_kernel_executor() {
    let plan = EpisodeAction::Trajectory { p: vec![
        [1.0, 0.0, 0.0, 4.0, 0.1], [30.0, 2.0, 0.1, 4.0, 5.0],
    ] };
    let options = EpisodeOptions {
        warmup_decisions: 2, warmup_actions: vec![plan.clone(), plan.clone()],
        warmup_policy: "trajectory".into(), execution: TrajectoryExecution::SpeedSetpoint,
        mode: EpisodeMode::Realtime { deadline_ms: 10.0, fallback: EpisodeFallback::Scripted },
        ..EpisodeOptions::default()
    };
    let spec = fixture(options);
    let mut reference = EnvSession::new(spec.scenario.clone(), spec.topology.clone(), EpisodeConfig::default()).unwrap();
    reference.reset(None).unwrap();
    for _ in 0..2 {
        reference.step(Some(ActionOverride { target_speed_mps: Some(4.0), ..ActionOverride::default() })).unwrap();
    }
    let mut episode = Episode::new(spec).unwrap();
    assert_eq!(episode.reset().unwrap().state_vector, reference.last_result().observation.state_vector.as_ref());
    episode.step_at_latency(plan, Some(10.1)).unwrap();
    let scripted = reference.step(None).unwrap();
    assert_eq!(episode.last_step().obs.state_vector, scripted.observation.state_vector.as_ref());
    assert_eq!(episode.last_step().dl.ap, "scripted");
    assert!(episode.last_step().ex.is_none());
    assert_eq!(episode.finish().unwrap().warmup_decisions, 2);
}

#[test]
fn stock_replay_measures_unqualified_context_without_enforcing_it() {
    let context = EpisodeReplayContext {
        scene_id: "unqualified".into(), digest: "raw-bundle".into(),
        qualified: false, stock_replay_passed: Some(false), measure_only: true,
        lateral_m: 0.0, longitudinal_s: 0.0, heading_rad: 0.0,
        recorded_path: vec![[0.0, 100.0, 10.0, 0.0], [0.1, 101.0, 10.0, 0.0]],
    };
    let mut episode = Episode::new(fixture(EpisodeOptions {
        replay_context: Some(context.clone()), max_decisions: Some(2), ..EpisodeOptions::default()
    })).unwrap();
    episode.reset().unwrap();
    let step = episode.step(speed(8.0)).unwrap();
    assert!(!step.envelope.unwrap().inside);
    assert!(!step.truncated);
    assert!(episode.step(speed(8.0)).unwrap().truncated);
    assert_eq!(episode.finish().unwrap().decisions, 2);
    assert!(Episode::new(fixture(EpisodeOptions {
        replay_context: Some(EpisodeReplayContext { measure_only: false, ..context }),
        ..EpisodeOptions::default()
    })).is_err());
}

#[test]
fn first_policy_deadline_retains_the_last_reference_warmup_plan() {
    let plan = EpisodeAction::Trajectory { p: vec![
        [1.0, 0.0, 0.0, 4.0, 0.1], [30.0, 2.0, 0.1, 4.0, 5.0],
    ] };
    let mode = EpisodeMode::Realtime { deadline_ms: 10.0, fallback: EpisodeFallback::HoldLast };
    let mut reference = Episode::new(fixture(EpisodeOptions { mode, ..EpisodeOptions::default() })).unwrap();
    reference.reset().unwrap();
    reference.step_at_latency(plan.clone(), Some(0.0)).unwrap();
    reference.step_at_latency(plan.clone(), Some(0.0)).unwrap();
    let mut warmed = Episode::new(fixture(EpisodeOptions {
        mode, warmup_decisions: 2, warmup_actions: vec![plan.clone(), plan],
        warmup_policy: "trajectory".into(), ..EpisodeOptions::default()
    })).unwrap();
    assert_eq!(warmed.reset().unwrap().state_vector, reference.last_step().obs.state_vector);
    reference.step_at_latency(speed(0.0), Some(10.1)).unwrap();
    warmed.step_at_latency(speed(0.0), Some(10.1)).unwrap();
    assert_eq!(warmed.last_step().obs.state_vector, reference.last_step().obs.state_vector);
    assert_eq!(warmed.last_step().dl.ap, "repeat-last");
    assert!((warmed.last_step().ex.unwrap().plan_age_s - 0.2).abs() < 1e-10);
}
