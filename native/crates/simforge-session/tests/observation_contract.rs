use std::sync::Arc;

use serde_json::{json, Value};
use simforge_core::engine::RunOptions;
use simforge_core::hash::sha256_bytes;
use simforge_core::map::{LaneGraph, TopologyIndex};
use simforge_core::rng::Seed;
use simforge_core::trace::events::SimEvent;
use simforge_core::types::{parse_scenario_input_value, ActorKind};
use simforge_session::{resolve_ego_id, EnvSession};

fn fixture() -> (Value, Arc<LaneGraph>) {
    let spec: Value = serde_json::from_str(include_str!(
        "../../../../adapters/gym/tests/fixtures/synthetic-episode-trajectory.json"
    )).unwrap();
    let entry = &spec["instances"][0];
    let topology = TopologyIndex::from_json_slice(&serde_json::to_vec(&entry["topology"]).unwrap()).unwrap();
    (entry["input"].clone(), Arc::new(LaneGraph::new(topology)))
}

fn session(input: &Value, graph: Arc<LaneGraph>, config: Value) -> EnvSession {
    EnvSession::new(
        parse_scenario_input_value(input).unwrap(),
        RunOptions::new(graph),
        serde_json::from_value(config).unwrap(),
    ).unwrap()
}

#[test]
fn privileged_existing_scenario_rerun_digest() {
    let (input, graph) = fixture();
    let run = || {
        let mut env = session(&input, graph.clone(), json!({}));
        let mut frames = vec![env.reset(Some(&Seed::Number(42.0))).unwrap().clone()];
        for _ in 0..40 {
            frames.push(env.step(None).unwrap().clone());
        }
        sha256_bytes(&serde_json::to_vec(&frames).unwrap())
    };
    let first = run();
    println!("privileged-synthetic-trajectory-seed42-40decisions={first}");
    assert_eq!(first, run());
}

#[test]
fn visible_hides_occluded_actor_and_nearest_range() {
    let (mut input, graph) = fixture();
    input["occluders"] = json!([{"id":"wall", "obb": {
        "center":{"x":30.0,"z":1.75},"lengthM":1.0,"widthM":10.0,"headingRad":0.0,"heightM":3.0
    }}]);
    let mut privileged = session(&input, graph.clone(), json!({}));
    let mut visible = session(&input, graph, json!({"observation":{"visible":true}}));
    let privileged = privileged.reset(None).unwrap();
    assert_eq!(privileged.observation.objects.len(), 1);
    assert!(!privileged.observation.objects[0].line_of_sight);
    assert!(privileged.observation.state_vector.unwrap()[9] < 60.0);
    let visible = visible.reset(None).unwrap();
    assert!(visible.observation.objects.is_empty(), "occluded actor leaked through Visible");
    assert_eq!(visible.observation.state_vector.unwrap()[9], 1e6);
}

fn contact(partner_kind: &str, prop: bool) {
    let (mut input, graph) = fixture();
    input["warmupSeconds"] = json!(0);
    input["clipSeconds"] = json!(4);
    let ego = &mut input["actors"][0];
    ego["behavior"]["rules"]["collisionAvoidance"] = json!(false);
    ego["behavior"]["rules"]["yieldToPedestrians"] = json!(false);
    ego["behavior"]["rules"]["yieldToVehicles"] = json!(false);
    if prop {
        input["actors"].as_array_mut().unwrap().truncate(1);
        input["props"] = json!([{"id":"obstacle", "catalogId":"test-barrier", "pose":{"x":28.0,"z":0.0,"headingRad":0.0}, "dims":{"l":1.0,"w":2.0,"h":1.0}, "collidable":true}]);
    } else {
        let partner = &mut input["actors"][1];
        partner["kind"] = json!(partner_kind);
        partner.as_object_mut().unwrap().remove("dims");
        partner["initial"] = json!({"pose":{"x":28.0,"z":0.0,"headingRad":0.0}, "speedMps":0.0});
        partner["behavior"]["route"] = json!({"kind":"polyline", "points":[{"x":28.0,"z":0.0},{"x":80.0,"z":0.0}]});
        partner["behavior"]["cruiseSpeedMps"] = json!(0.0);
    }
    let partner_id = if prop { "prop:obstacle" } else { "other" };
    let mut env = session(&input, graph, json!({}));
    env.reset(None).unwrap();
    while !env.ended() {
        env.step(None).unwrap();
    }
    let result = env.last_result();
    assert!(result.terminated, "{partner_kind} contact must terminate, not truncate: {:?}", result.info.events);
    assert!(!result.truncated);
    assert!(result.info.reward_terms.collision.is_some());
    assert_eq!(result.term_reason(), Some("collision"));
    let collision = result.info.collision.as_ref().unwrap();
    assert_eq!(collision.partner_id, partner_id);
    assert_eq!(collision.partner_kind.as_str(), partner_kind);
    assert_eq!(collision.side, Some(simforge_core::trace::events::ContactSide::Front), "actual approaching contact must attribute the ego's front, not a perceived neighbour");
    assert!(result.info.events.iter().any(|event| matches!(event,
        SimEvent::Collision {a,b,..} if (a == "ego" && b == partner_id) || (b == "ego" && a == partner_id)
    )));
    if !prop {
        let sim = env.simulation().unwrap();
        assert_eq!(sim.actor_kind(sim.actor_index(partner_id).unwrap()), ActorKind::parse(partner_kind).unwrap());
    }
}

#[test]
fn geometric_contact_face_boundary_and_rotation_are_explicit() {
    use simforge_core::math::{Obb, Vec2};
    use simforge_core::trace::events::ContactSide;
    let ego = Obb { center: Vec2 { x: 0.0, y: 0.0 }, length_m: 4.0, width_m: 2.0, heading_rad: 0.0 };
    let at = |x, y| Obb { center: Vec2 { x, y }, ..ego };
    assert_eq!(ContactSide::between(&ego, &at(5.0, 0.0)), ContactSide::Front);
    assert_eq!(ContactSide::between(&ego, &at(-5.0, 0.0)), ContactSide::Rear);
    assert_eq!(ContactSide::between(&ego, &at(-2.0, 1.0)), ContactSide::Lateral, "corner ties are not rear-only exemptions");
    assert_eq!(ContactSide::between(&ego, &at(-2.0, 1.0 - 1e-6)), ContactSide::Rear);
    let rotated = Obb { heading_rad: std::f64::consts::FRAC_PI_2, ..ego };
    assert_eq!(ContactSide::between(&rotated, &at(0.0, 5.0)), ContactSide::Front);
}

// Regression contract for the historical 2026-08 PPO validity failure. The
// current pre-W0 kernel already passes: retain coverage of real engine contact,
// not fabricated collision events or a nearest-perceived-object guess.
#[test]
fn pedestrian_contact_terminates_as_collision() { contact("pedestrian", false); }

#[test]
fn cyclist_contact_terminates_as_collision() { contact("bicycle", false); }

#[test]
fn static_prop_contact_terminates_as_collision() { contact("static_object", true); }

#[test]
fn ego_role_beats_vehicle_sort_order_and_concrete_kinds_resolve() {
    let (mut input, _) = fixture();
    input.as_object_mut().unwrap().remove("metricSubject");
    input["actors"][0]["id"] = json!("z-ego");
    input["actors"][0]["kind"] = json!("car");
    input["actors"][0]["tags"] = json!(["role:ego"]);
    input["actors"][1]["kind"] = json!("van");
    assert_eq!(resolve_ego_id(&parse_scenario_input_value(&input).unwrap()).unwrap(), "z-ego");
    input["actors"][0]["tags"] = json!([]);
    assert_eq!(resolve_ego_id(&parse_scenario_input_value(&input).unwrap()).unwrap(), "other");
    input["metricSubject"] = json!("z-ego");
    assert_eq!(resolve_ego_id(&parse_scenario_input_value(&input).unwrap()).unwrap(), "z-ego");
}

#[test]
fn signal_approaches_count_down_switch_and_preserve_unknown_override_timing() {
    let (mut input, graph) = fixture();
    input["warmupSeconds"] = json!(0);
    input["signalPrograms"] = json!([{
        "id":"junction", "phases":[{"phase":"red","durationS":1.0},{"phase":"green","durationS":1.0}],
        "loop":true, "offsetS":0.0,
        "stopLines":[{"rsl":"1:0:-2","s":90.0},{"rsl":"1:0:-1","s":90.0}]
    }]);
    input["interactions"] = json!([{
        "id":"blackout","actorId":"ego","trigger":{"kind":"at","t":1.2},
        "verb":"set","target":{"key":"signal:junction.phase","value":"off"}
    }]);
    let mut env = session(&input, graph, json!({"observation":{"signals":true}}));
    let initial = env.reset(None).unwrap().observation.signals.as_ref().unwrap();
    assert_eq!(initial.len(), 2);
    assert_eq!(initial[0].lane_rsl, "1:0:-1");
    assert_eq!(initial[1].lane_rsl, "1:0:-2");
    assert_eq!(initial[0].phase.as_str(), "red");
    assert_eq!(initial[0].time_to_change_s, Some(1.0));
    for _ in 0..5 { env.step(None).unwrap(); }
    assert_eq!(env.last_result().observation.signals.as_ref().unwrap()[0].time_to_change_s, Some(0.5));
    let checkpoint = env.checkpoint().unwrap();
    for _ in 0..5 { env.step(None).unwrap(); }
    let green = env.last_result().observation.signals.as_ref().unwrap();
    assert_eq!(green[0].phase.as_str(), "green");
    assert_eq!(green[0].time_to_change_s, Some(1.0));
    for _ in 0..3 { env.step(None).unwrap(); }
    let overridden = env.last_result().clone();
    let row = &overridden.observation.signals.as_ref().unwrap()[0];
    assert_eq!(row.phase.as_str(), "off");
    assert_eq!(row.time_to_change_s, None);
    assert_eq!(serde_json::to_value(row).unwrap()["source"], "override");
    env.restore(&checkpoint).unwrap();
    for _ in 0..8 { env.step(None).unwrap(); }
    assert_eq!(env.last_result(), &overridden);
}

#[test]
fn held_final_signal_phase_has_no_fictitious_countdown() {
    let (mut input, graph) = fixture();
    input["warmupSeconds"] = json!(0);
    input["signalPrograms"] = json!([{
        "id":"held", "phases":[{"phase":"red","durationS":1.0}],
        "loop":false, "stopLines":[{"rsl":"1:0:-1","s":90.0}]
    }]);
    let mut env = session(&input, graph, json!({"observation":{"signals":true}}));
    let row = &env.reset(None).unwrap().observation.signals.as_ref().unwrap()[0];
    assert_eq!(row.phase.as_str(), "red");
    assert_eq!(row.time_to_change_s, None);
}

#[test]
fn visible_channel_reruns_deterministically_without_hidden_bev_occupancy() {
    let (mut input, graph) = fixture();
    input["occluders"] = json!([{"id":"wall", "obb": {
        "center":{"x":30.0,"z":1.75},"lengthM":1.0,"widthM":10.0,"headingRad":0.0,"heightM":3.0
    }}]);
    let run = || {
        let mut env = session(&input, graph.clone(), json!({"observation":{"visible":true,"signals":true,"bev":{"resolutionM":1.0}}}));
        let reset = env.reset(Some(&Seed::Number(42.0))).unwrap();
        assert!(reset.observation.bev.as_ref().unwrap().data.chunks_exact(3).all(|cell| cell[2] == 0.0));
        let mut frames = vec![reset.clone()];
        for _ in 0..40 { frames.push(env.step(None).unwrap().clone()); }
        sha256_bytes(&serde_json::to_vec(&frames).unwrap())
    };
    let first = run();
    println!("visible-v1-occluded-synthetic-seed42-40decisions-bev1m={first}");
    assert_eq!(first, run());
}

#[test]
fn privileged_checkpoint_cannot_be_restored_into_visible_session() {
    let (input, graph) = fixture();
    let mut privileged = session(&input, graph.clone(), json!({}));
    privileged.reset(None).unwrap();
    let checkpoint = privileged.checkpoint().unwrap();
    let mut visible = session(&input, graph, json!({"observation":{"visible":true}}));
    assert!(visible.restore(&checkpoint).is_err(), "restore bypassed the privilege boundary");
}
