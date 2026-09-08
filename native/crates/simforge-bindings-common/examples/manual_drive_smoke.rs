//! Manual-drive replay proof. A recorded take (stationary → reversing with a
//! heading wrap → forward) must (1) replay through the native engine tick for
//! tick, (2) release to a staged `ActionOverride`, and (3) compile from a
//! `manualDrive` route interaction on a pinned scene_absolute role into the
//! same recorded spawn, with malformed / competing takes rejected.
//!
//! ```sh
//! TOPOLOGY=$DEV_ASSETS/belmont-research-center/topology-index.json.gz \
//! MAP_DIR=$DEV_ASSETS/belmont-research-center \
//!   cargo run -p simforge-bindings-common --example manual_drive_smoke
//! ```

use std::sync::Arc;

use serde_json::json;
use simforge_bindings_common::assets::lane_graph_from_topology;
use simforge_core::engine::{ActionOverride, ActorAction, RunOptions, Simulation};
use simforge_core::math::normalize_angle;
use simforge_core::types::parse_scenario_input_value;

fn main() {
    let topo =
        std::fs::read(std::env::var("TOPOLOGY").expect("TOPOLOGY=path/to/topology-index.json.gz"))
            .unwrap();
    let graph = lane_graph_from_topology(&topo).unwrap();

    let dt: f64 = 0.02;
    let clip: f64 = 3.0;
    let ticks = (clip / dt).round() as usize;
    let (x0, z0) = (-144.25, -98.70);
    let mut samples = Vec::new();
    let (mut x, mut z) = (x0, z0);
    for k in 0..=ticks {
        let t = k as f64 * dt;
        let (heading, speed) = if t < 1.0 {
            (2.9, 0.0)
        } else if t < 2.0 {
            // reversing while the yaw sweeps 3.0 → -3.0 across ±π
            (normalize_angle(3.0 + (t - 1.0) * 0.28), -2.0)
        } else {
            (-3.0, 3.0)
        };
        if k > 0 {
            // scene frame: x = cos(h), z = -sin(h) per unit of forward travel
            x += heading.cos() * speed * dt;
            z += -heading.sin() * speed * dt;
        }
        samples.push(json!({
            "timeS": (t * 1e6).round() / 1e6,
            "x": x, "y": 0.0, "z": z, "headingRad": heading, "speedMps": speed,
        }));
    }
    let first = samples[0].clone();
    let doc = json!({
        "schemaVersion": 1,
        "mapId": "belmont-research-center",
        "clipSeconds": clip,
        "warmupSeconds": 1,
        "dt": dt,
        "seed": "manual-drive-smoke",
        "operationalConditions": {
            "weather": "clear", "timeOfDay": "day", "traffic": "moderate", "visibility": "unrestricted",
            "effects": { "visibilityRangeM": 1000, "frictionScale": 1, "trafficSpeedFactor": 1 }
        },
        "metricSubject": "ego",
        "actors": [{
            "id": "ego", "kind": "car", "dims": { "l": 4.8, "w": 1.9, "h": 1.5 },
            "initial": {
                "pose": { "x": first["x"], "z": first["z"], "headingRad": first["headingRad"] },
                "speedMps": 0
            },
            "behavior": {
                "rules": { "obeySignals": true, "yieldToVehicles": true, "yieldToPedestrians": true,
                           "collisionAvoidance": true, "aggression": 0.5, "speedFactor": 1 },
                "route": { "kind": "recordedTrack", "samples": samples },
                "cruiseSpeedMps": 0
            },
            "presentAtStart": true, "tags": ["role:ego", "class:car"]
        }],
        "interactions": [], "signalPrograms": [], "roadControls": [], "surfacePatches": [],
        "props": [], "occluders": [], "occlusionPairs": []
    });
    let input = parse_scenario_input_value(&doc).unwrap();

    // 1. Faithful replay.
    let sim = Simulation::new(input.clone(), RunOptions::new(Arc::clone(&graph))).unwrap();
    let result = sim.run().unwrap();
    let track = &result.trace.ticks.actors["ego"];
    let t = &result.trace.ticks.t;
    assert_eq!(t.len(), ticks + 1, "one trace tick per sample");
    let mut max_pos = 0.0f64;
    let mut max_head = 0.0f64;
    let mut max_speed = 0.0f64;
    for k in 0..=ticks {
        let s = &doc["actors"][0]["behavior"]["route"]["samples"][k];
        assert!(
            (t[k] - s["timeS"].as_f64().unwrap()).abs() < 1e-9,
            "tick {k} time"
        );
        let dx = track.x[k] - s["x"].as_f64().unwrap();
        let dy = track.y[k] - (-s["z"].as_f64().unwrap());
        max_pos = max_pos.max(dx.hypot(dy));
        max_head = max_head
            .max(normalize_angle(track.heading_rad[k] - s["headingRad"].as_f64().unwrap()).abs());
        let speed = s["speedMps"].as_f64().unwrap();
        max_speed = max_speed.max((track.speed_mps[k] - speed.abs()).abs());
        if speed < 0.0 {
            assert!(
                track.motion_direction[k].is_reverse(),
                "tick {k} reverse gear"
            );
        } else if speed > 0.0 {
            assert!(
                !track.motion_direction[k].is_reverse(),
                "tick {k} forward gear"
            );
        }
    }
    println!("replay: max position error {max_pos:.3e} m, max heading error {max_head:.3e} rad, max speed error {max_speed:.3e} m/s");
    assert!(max_pos < 1e-6 && max_head < 1e-6 && max_speed < 1e-6);
    let warnings: Vec<_> = result.issues.iter().map(|i| i.code.as_str()).collect();
    println!("issues: {warnings:?}");

    // 2. Live control preempts the take.
    let mut sim = Simulation::new(input, RunOptions::new(graph)).unwrap();
    let ego = sim.actor_index("ego").unwrap();
    let hold = ActorAction {
        actor: ego,
        action: ActionOverride {
            target_speed_mps: Some(0.0),
            target_acceleration_mps2: Some(0.0),
            ..ActionOverride::default()
        },
    };
    // Warm-up only, no override: the body waits on sample 0.
    sim.advance((1.0 / dt).round() as usize, &[]).unwrap();
    let start = sim.actor_snapshot(ego);
    // Hold from t=0 while the take would reverse 1 m by t=1.5 s.
    let held_ticks = (1.5 / dt).round() as usize;
    sim.advance(held_ticks, &[hold]).unwrap();
    let held = sim.actor_snapshot(ego);
    let sample = &doc["actors"][0]["behavior"]["route"]["samples"][held_ticks];
    let drift = (held.x - start.x).hypot(held.y - start.y);
    let take_travel =
        (sample["x"].as_f64().unwrap() - start.x).hypot(-sample["z"].as_f64().unwrap() - start.y);
    println!("override: body moved {drift:.3} m under live hold by t=1.5 s; the take would have moved it {take_travel:.3} m (speed now {:.3})", held.speed_mps);
    assert!(
        drift < 0.5 * take_travel && take_travel > 0.9,
        "override must release the take"
    );

    // 3. Compiler: manualDrive interaction → folded recorded spawn.
    let map_dir = std::env::var("MAP_DIR").expect("MAP_DIR=path/to/dev-assets/<mapId>");
    let bundle =
        simforge_compiler::bundle::MapBundle::load(std::path::Path::new(&map_dir)).unwrap();
    let scene_samples: Vec<_> = doc["actors"][0]["behavior"]["route"]["samples"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| {
            json!({ "timeS": s["timeS"], "x": s["x"], "y": 0.0, "z": s["z"],
                         "headingRad": s["headingRad"], "speedMps": s["speedMps"] })
        })
        .collect();
    let template = |interactions: serde_json::Value| {
        json!({
            "scenarioVersion": 2,
            "meta": { "name": "manual drive smoke", "description": "", "createdAt": "2026-09-07T00:00:00.000Z",
                      "modifiedAt": "2026-09-07T00:00:00.000Z", "appVersion": "0.0.0-dev", "tags": [], "negativeControl": false },
            "params": { "declarations": [], "constraints": [] },
            "environment": { "weather": "clear", "timeOfDay": "noon", "surfacePatches": [] },
            "anchor": { "features": [], "policy": { "allowMirror": false, "maxSitesPerMap": 10, "diversity": "strict", "minScore": 0.5 },
                        "pin": { "mapId": "belmont-research-center" } },
            "roles": [{
                "id": "ego", "actor": { "class": "car", "static": false, "sensors": [] },
                "initialSpeedKph": 30, "essentiality": "required", "kind": "scene_absolute",
                // deliberately not sample 0: the take must win.
                "pose": { "position": { "x": 0.0, "y": 0.0, "z": 0.0 }, "headingRad": 0.0 }
            }],
            "props": [], "trafficControls": [], "mapSignalPlans": [],
            "choreography": { "clipSeconds": clip, "warmupSeconds": 1, "interactions": interactions },
            "perception": { "mapDivergences": [] },
            "invariants": [], "variants": [],
            "metricSubject": "ego"
        })
    };
    let manual = |recording: serde_json::Value| {
        json!({
            "id": "take", "actor": "ego", "trigger": { "kind": "at", "t": 0 }, "until": { "kind": "at", "t": clip },
            "verb": "route", "target": { "mode": "manualDrive", "recording": recording }
        })
    };
    let good = json!({ "version": 1, "clipSeconds": clip, "samples": scene_samples });
    let options = simforge_compiler::materialize::MaterializeOptions::new();
    let compiled = simforge_compiler::materialize::instantiate(
        &template(json!([manual(good.clone())])),
        &bundle,
        simforge_compiler::materialize::SiteSelection::Auto,
        &options,
    )
    .unwrap();
    let actor = compiled.input.actor("ego").unwrap();
    let simforge_core::types::RouteSpec::RecordedTrack {
        samples: compiled_samples,
    } = &actor.behavior.route
    else {
        panic!(
            "expected recordedTrack spawn route, got {:?}",
            actor.behavior.route
        );
    };
    assert_eq!(compiled_samples.len(), ticks + 1);
    assert_eq!(actor.initial.pose.x, first["x"].as_f64().unwrap());
    assert_eq!(actor.initial.pose.z, first["z"].as_f64().unwrap());
    assert_eq!(
        actor.initial.pose.heading_rad,
        first["headingRad"].as_f64().unwrap()
    );
    assert!(
        compiled.input.interactions.is_empty(),
        "take is folded, not a runtime interaction"
    );
    println!("compiled: recordedTrack spawn with {} samples, pose from sample 0, {} runtime interactions", compiled_samples.len(), compiled.input.interactions.len());
    let sim = Simulation::new(
        compiled.input.clone(),
        RunOptions::new(bundle.graph().clone()),
    )
    .unwrap();
    let replay = sim.run().unwrap();
    let track = &replay.trace.ticks.actors["ego"];
    let worst = (0..=ticks)
        .map(|k| {
            let s = &compiled_samples[k];
            (track.x[k] - s.x).hypot(track.y[k] + s.z)
                + normalize_angle(track.heading_rad[k] - s.heading_rad).abs()
        })
        .fold(0.0f64, f64::max);
    println!("compiled replay: worst per-tick position+heading error {worst:.3e}");
    assert!(worst < 1e-6);

    // 4. Rejections.
    let reject = |label: &str, interactions: serde_json::Value| {
        let err = simforge_compiler::materialize::instantiate(
            &template(interactions),
            &bundle,
            simforge_compiler::materialize::SiteSelection::Auto,
            &options,
        )
        .err()
        .unwrap_or_else(|| panic!("{label}: expected a compile error"));
        println!("rejected {label}: {err}");
    };
    let mut short = good.clone();
    short["samples"].as_array_mut().unwrap().pop();
    reject("take not covering clip end", json!([manual(short)]));
    let mut wrong_clip = good.clone();
    wrong_clip["clipSeconds"] = json!(clip + 1.0);
    reject(
        "take recorded against another clip length",
        json!([manual(wrong_clip)]),
    );
    let mut nan = good.clone();
    nan["samples"][3]["x"] = json!("nope");
    reject("non-numeric sample", json!([manual(nan)]));
    let mut unordered = good.clone();
    unordered["samples"][5]["timeS"] = json!(0.0);
    reject("out-of-order sample times", json!([manual(unordered)]));
    reject(
        "competing motion interaction",
        json!([manual(good.clone()), {
            "id": "brake", "actor": "ego", "trigger": { "kind": "at", "t": 1 }, "verb": "speed",
            "target": { "mode": "stop" }, "dynamics": { "shape": "linear", "constraint": "rate", "value": 3 }
        }]),
    );
    let mut late = manual(good.clone());
    late["trigger"]["t"] = json!(0.5);
    reject("take not starting at t=0", json!([late]));
    println!("ok");
}
