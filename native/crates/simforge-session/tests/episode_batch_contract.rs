use std::sync::Arc;
use simforge_core::{engine::RunOptions, map::{LaneGraph, TopologyIndex}};
use simforge_session::{Episode, EpisodeAction, EpisodeBatch, EpisodeOptions, EpisodeSpec, ObservationChannel};

fn spec(seed: u64, horizon: u32) -> EpisodeSpec {
    let document: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../adapters/gym/tests/fixtures/synthetic-episode.json")).unwrap();
    let instance = &document["instances"][0];
    let graph = Arc::new(LaneGraph::new(TopologyIndex::from_json_slice(
        &serde_json::to_vec(&instance["topology"]).unwrap()).unwrap()));
    let scenario = simforge_core::types::parse_scenario_input(&instance["input"].to_string()).unwrap();
    let mut options = EpisodeOptions { seed, max_decisions: Some(horizon), ..EpisodeOptions::default() };
    options.observation.channels = vec![ObservationChannel::Visible, ObservationChannel::Signals];
    EpisodeSpec { scenario, topology: RunOptions::new(graph), options }
}

fn action(i: usize) -> EpisodeAction {
    EpisodeAction::Setpoint { speed_mps: Some(5.0 + i as f64 * 0.2), acceleration_mps2: Some(-0.1),
        preview_point: None, preview_heading_rad: None, motion_direction: None }
}

#[test]
fn eight_parallel_episodes_have_sequential_trace_digests() {
    let seed = (1u64 << 54) + 137;
    let specs: Vec<_> = (0..8).map(|i| spec(seed + i, 12 + i as u32)).collect();
    let mut sequential: Vec<_> = specs.iter().cloned().map(|s| Episode::new(s).unwrap()).collect();
    let mut batch = EpisodeBatch::new(specs, 64, 4).unwrap();
    batch.reset_seed(seed).unwrap();
    for e in &mut sequential { e.reset().unwrap(); }
    let actions: Vec<_> = (0..8).map(action).collect();
    for _ in 0..35 {
        batch.step_all(&actions).unwrap();
        for (i, e) in sequential.iter_mut().enumerate() {
            if e.ended() { e.reset().unwrap(); } else { e.step(actions[i].clone()).unwrap(); }
            assert_eq!(batch.episodes()[i].trace_digest(), e.trace_digest(), "world {i}");
            assert_eq!(batch.episodes()[i].last_step().obs.state_vector, e.last_step().obs.state_vector);
        }
    }
    for (i, e) in batch.episodes().iter().enumerate() { println!("EpisodeBatch N=8 world={i} digest={}", e.trace_digest()); }
}

#[test]
fn whole_batch_checkpoint_keeps_held_plans_and_pending_resets() {
    let mut specs = vec![spec(1, 2), spec(2, 11)];
    for s in &mut specs { s.options.warmup_decisions = 1; }
    let mut batch = EpisodeBatch::new(specs.clone(), 64, 2).unwrap();
    batch.reset_seed(81).unwrap();
    let initial = batch.checkpoint().unwrap();
    let reset_view = batch.flat().clone();
    batch.restore(&initial).unwrap();
    assert_eq!(batch.flat(), &reset_view, "warm-up reward must not leak into restored reset rows");
    let actions = vec![EpisodeAction::Trajectory { p: vec![[1.0, 0.0, 0.0, 8.0, 0.1], [80.0, 0.0, 0.0, 8.0, 10.0]] }; 2];
    for _ in 0..2 { batch.step_all(&actions).unwrap(); }
    assert_eq!(batch.flat().truncated, [1, 0]);
    let checkpoint = batch.checkpoint().unwrap();
    let mut restored = EpisodeBatch::new(specs, 64, 1).unwrap();
    restored.restore(&checkpoint).unwrap();
    assert_eq!(restored.flat(), batch.flat());
    for _ in 0..10 {
        batch.step_all(&actions).unwrap();
        restored.step_all(&actions).unwrap();
        assert_eq!(restored.flat(), batch.flat());
        assert_eq!(restored.autoreset(), batch.autoreset());
        for i in 0..2 { assert_eq!(restored.episodes()[i].trace_digest(), batch.episodes()[i].trace_digest()); }
    }
}

#[test]
fn invalid_action_and_checkpoint_do_not_partially_advance_batch() {
    let specs = vec![spec(1, 2), spec(2, 11)];
    let mut batch = EpisodeBatch::new(specs, 64, 2).unwrap();
    batch.reset_all(None).unwrap();
    let before = batch.flat().clone();
    assert!(batch.step_all(&[action(0), EpisodeAction::Control { c: [2.0, 0.0, 0.0] }]).is_err());
    assert_eq!(batch.flat(), &before);
    let mut wrong_specs = vec![spec(1, 2), spec(2, 12)];
    wrong_specs[0].options.warmup_decisions = 1;
    let mut wrong = EpisodeBatch::new(wrong_specs, 64, 1).unwrap();
    wrong.reset_all(None).unwrap();
    assert!(batch.restore(&wrong.checkpoint().unwrap()).is_err());
    assert_eq!(batch.flat(), &before);
}
