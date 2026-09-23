use std::sync::Arc;
use serde_json::{json, Value};
use simforge_core::{engine::{ActionOverride, RunOptions}, map::{LaneGraph, TopologyIndex}, physics::MotionDirection, types::parse_scenario_input_value};
use simforge_session::EnvSession;

fn fixture() -> (Value, Arc<LaneGraph>) {
    let doc: Value = serde_json::from_str(include_str!("../../../../adapters/gym/tests/fixtures/synthetic-episode-trajectory.json")).unwrap();
    let entry = &doc["instances"][0];
    let graph = Arc::new(LaneGraph::new(TopologyIndex::from_json_slice(&serde_json::to_vec(&entry["topology"]).unwrap()).unwrap()));
    let mut input = entry["input"].clone();
    input["warmupSeconds"] = json!(0);
    input["actors"][0]["initial"]["speedMps"] = json!(0.0);
    input["actors"][0]["behavior"]["cruiseSpeedMps"] = json!(0.0);
    input["actors"][0]["behavior"]["rules"]["collisionAvoidance"] = json!(false);
    input["actors"][0]["behavior"]["rules"]["obeySignals"] = json!(false);
    (input, graph)
}

fn env(input: Value, graph: Arc<LaneGraph>, config: Value) -> EnvSession {
    let mut env = EnvSession::new(parse_scenario_input_value(&input).unwrap(), RunOptions::new(graph), serde_json::from_value(config).unwrap()).unwrap();
    env.reset(None).unwrap();
    env
}

fn speed(v: f64, direction: MotionDirection) -> Option<ActionOverride> {
    Some(ActionOverride { target_speed_mps: Some(v), target_acceleration_mps2: Some(0.0), motion_direction: Some(direction), ..Default::default() })
}

#[test]
fn first_step_and_reverse_pay_signed_authored_route_progress() {
    let (mut input, graph) = fixture();
    input["actors"].as_array_mut().unwrap().truncate(1);
    input["actors"][0]["initial"]["speedMps"] = json!(4.0);
    let mut forward = env(input.clone(), graph.clone(), json!({}));
    let start = forward.last_result().observation.state_vector.unwrap()[8];
    let first = forward.step(speed(4.0, MotionDirection::Forward)).unwrap();
    assert!(first.info.reward_terms.progress > 0.0, "the first decision must not lose its progress reward");
    assert!((first.info.reward_terms.progress - 0.05 * (first.observation.state_vector.unwrap()[8] - start)).abs() < 1e-12);
    input["actors"][0]["initial"]["speedMps"] = json!(0.0);
    let mut reverse = env(input, graph, json!({}));
    let mut progress = 0.0;
    for _ in 0..20 { progress += reverse.step(speed(2.0, MotionDirection::Reverse)).unwrap().info.reward_terms.progress; }
    assert!(progress < -0.01, "speed magnitude or a reversed route binding must not earn forward progress: {progress}");
}

#[test]
fn queue_gap_and_adjacent_lane_waiting_are_distinct_from_stuck() {
    let (input, graph) = fixture();
    let waiting = |gap: f64, lateral: f64| {
        let mut input = input.clone();
        let lead = &mut input["actors"][1];
        lead["initial"] = json!({"pose":{"x":24.5 + gap,"z":lateral,"headingRad":0.0},"speedMps":0.0});
        lead["static"] = json!(true);
        lead["behavior"]["route"] = json!({"kind":"polyline","points":[{"x":0.0,"z":lateral},{"x":400.0,"z":lateral}]});
        let mut e = env(input, graph.clone(), json!({"goal":null}));
        let terms = e.step(speed(0.0, MotionDirection::Forward)).unwrap().info.reward_terms;
        terms
    };
    assert_eq!(waiting(10.0, 0.0).stuck, 0.0);
    assert_eq!(waiting(10.01, 0.0).stuck, -0.05);
    assert_eq!(waiting(5.0, 3.5).stuck, -0.05, "adjacent-lane parking cannot excuse the ego");
}

#[test]
fn queue_goal_requires_authored_target_safe_gap_and_full_dwell() {
    let (mut input, graph) = fixture();
    let route = input["actors"][0]["behavior"]["route"].clone();
    let lead = &mut input["actors"][1];
    lead["initial"] = json!({"pose":{"x":30.0,"z":0.0,"headingRad":0.0},"speedMps":0.0});
    lead["static"] = json!(true);
    lead["tags"] = json!(["role:queue-tail"]);
    lead["behavior"]["route"] = route;
    let mut e = env(input, graph, json!({}));
    for _ in 0..9 { assert!(!e.step(speed(0.0, MotionDirection::Forward)).unwrap().terminated); }
    let checkpoint = e.checkpoint().unwrap();
    let terminal = e.step(speed(0.0, MotionDirection::Forward)).unwrap().clone();
    assert_eq!(terminal.term_reason(), Some("goal"), "config={:?} state={:?} terms={:?}", e.config(), e.checkpoint().unwrap().reward_state, terminal.info.reward_terms);
    assert_eq!(terminal.info.reward_terms.goal, Some(5.0));
    assert_eq!(terminal.info.reward_terms.stuck, 0.0);
    e.restore(&checkpoint).unwrap();
    assert_eq!(*e.step(speed(0.0, MotionDirection::Forward)).unwrap(), terminal);
}

#[test]
fn corridor_boundary_is_inclusive_and_exit_terminates() {
    let (input, graph) = fixture();
    for (offset, expected) in [(2.25, false), (2.251, true)] {
        let mut input = input.clone();
        input["actors"].as_array_mut().unwrap().truncate(1);
        input["actors"][0]["initial"]["pose"]["z"] = json!(-offset);
        input["actors"][0]["initial"].as_object_mut().unwrap().remove("laneRef");
        let mut e = env(input, graph.clone(), json!({}));
        let result = e.step(speed(0.0, MotionDirection::Forward)).unwrap();
        assert_eq!(result.terminated, expected);
        assert_eq!(result.info.reward_terms.offroad, expected.then_some(-10.0));
        assert_eq!(result.term_reason(), expected.then_some("offroad"));
    }
}

#[test]
fn red_front_bumper_crossing_is_terminal_but_green_is_not() {
    let (input, graph) = fixture();
    for phase in ["red", "green"] {
        let mut input = input.clone();
        input["actors"].as_array_mut().unwrap().truncate(1);
        input["actors"][0]["initial"]["speedMps"] = json!(10.0);
        input["signalPrograms"] = json!([{"id":"light","phases":[{"phase":phase,"durationS":30}],"loop":true,"stopLines":[{"rsl":"1:0:-1","s":24.0}]}]);
        let mut e = env(input, graph.clone(), json!({}));
        for _ in 0..5 { if !e.ended() { e.step(speed(10.0, MotionDirection::Forward)).unwrap(); } }
        assert_eq!(e.last_result().term_reason(), if phase == "red" { Some("red_crossing") } else { None });
        assert_eq!(e.last_result().info.reward_terms.red_crossing, if phase == "red" { Some(-5.0) } else { None });
    }
}

#[test]
fn geometric_route_end_is_a_goal_without_a_despawn_event() {
    let (mut input, graph) = fixture();
    input["actors"].as_array_mut().unwrap().truncate(1);
    input["actors"][0]["initial"]["speedMps"] = json!(1.0);
    input["actors"][0]["initial"].as_object_mut().unwrap().remove("laneRef");
    input["actors"][0]["behavior"]["route"] = json!({
        "kind":"polyline", "points":[{"x":0.0,"z":0.0},{"x":20.5,"z":0.0}]
    });
    let mut e = env(input, graph, json!({}));
    while !e.ended() { e.step(speed(1.0, MotionDirection::Forward)).unwrap(); }
    let result = e.last_result();
    assert_eq!(result.term_reason(), Some("goal"));
    assert_eq!(result.info.reward_terms.goal, Some(5.0));
    assert!(!result.info.events.iter().any(|event| matches!(event,
        simforge_core::trace::events::SimEvent::Despawn { .. })));
}
