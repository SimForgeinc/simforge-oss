//! The Rust scene-assembly ports against the TypeScript native engine,
//! byte for byte: tests/fixtures/render/*.json were produced once by running
//! the TypeScript modules (packages/render/src/native/{timeline-lowering,
//! camera-schedule, lighting, luminaires}.ts and ../schedule.ts) under tsx on
//! the same inputs; see tests/fixtures/render/README.md.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use simforge_cli::render::canonical::{canonical_json, js_number, js_round, q, sha256_hex};
use simforge_cli::render::lighting::{resolve_native_lighting, LightingSite};
use simforge_cli::render::lowering::lower_timeline;
use simforge_cli::render::luminaires::{order_fixtures, NightFixture};
use simforge_cli::render::rig::{
    camera_clip_planes, camera_schedule, sensor_rigs, Clip, Rig, SensorHost,
};
use simforge_cli::render::schedule::{
    create_fixed_schedules, union_frame_micros, union_frame_times_s, FixedSchedule,
    FIXED_SCHEDULE_V1_SCHEMA,
};
use simforge_core::trace::timeline::{
    build_render_timeline, maybe_gunzip, HeightField, RenderTimeline,
};
use simforge_core::trace::SimTrace;

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

fn fixture(name: &str) -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/render")
        .join(name);
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

fn timeline(case: &str) -> RenderTimeline {
    let (path, height, catalog) = match case {
        "ambulance-plane" | "ambulance-plane-attitude" => (
            "examples/edge-cases/03-red-light-ambulance-preemption/scenario.trace.json.gz",
            HeightField::plane(7.5, 0.04, -0.02),
            None,
        ),
        "red-runner-flat-signals" => (
            "examples/edge-cases/07-protected-left-red-runner/scenario.trace.json.gz",
            HeightField::flat(0.0),
            None,
        ),
        "richmond-small-flat-offset" => (
            "fixtures/archive-corpus/traces/rc73-engine090-richmond-small.trace.json.gz",
            HeightField::flat(3.25),
            Some("cat"),
        ),
        other => panic!("unknown case {other}"),
    };
    let raw = std::fs::read(repo().join(path)).unwrap();
    let trace = SimTrace::from_json_slice(&maybe_gunzip(&raw).unwrap()).unwrap();
    build_render_timeline(&trace, &height, catalog).unwrap()
}

fn schedules(v: &Value) -> Vec<FixedSchedule> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|s| FixedSchedule {
            schema: FIXED_SCHEDULE_V1_SCHEMA,
            source_id: s["sourceId"].as_str().unwrap().into(),
            start_seconds: s["startSeconds"].as_f64().unwrap(),
            end_seconds: s["endSeconds"].as_f64().unwrap(),
            frames_per_second: s["framesPerSecond"].as_f64().unwrap(),
            frame_count: s["frameCount"].as_u64().unwrap(),
        })
        .collect()
}

#[test]
fn timeline_lowering_is_byte_identical_to_the_typescript_engine() {
    let golden = fixture("lowering.json");
    let mut states_of_first = None;
    for case in golden["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let tl = timeline(name);
        let times = union_frame_times_s(&schedules(&case["schedules"]));
        let expected_times: Vec<f64> = case["frameTimes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_f64().unwrap())
            .collect();
        assert_eq!(times, expected_times, "{name}: frame times");
        let heads: BTreeMap<String, String> = case["signalHeads"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned()))
            .collect();
        let lowering =
            lower_timeline(&tl, &times, case["attitude"].as_bool().unwrap(), &heads).unwrap();
        assert_eq!(lowering.timeline_sha256, case["timelineSha256"], "{name}");
        assert_eq!(lowering.timeline_key, case["timelineKey"], "{name}");
        assert_eq!(
            lowering.states.len() as u64,
            case["frameCount"].as_u64().unwrap(),
            "{name}"
        );
        assert_eq!(
            canonical_json(&json!(lowering.states[..3])),
            case["head"].as_str().unwrap(),
            "{name}: first frames"
        );
        let n = lowering.states.len();
        assert_eq!(
            canonical_json(&json!(lowering.states[n - 2..])),
            case["tail"].as_str().unwrap(),
            "{name}: last frames"
        );
        assert_eq!(
            sha256_hex(canonical_json(&json!(lowering.states)).as_bytes()),
            case["statesSha256"],
            "{name}: every frame"
        );
        assert_eq!(lowering.sha256, case["sha256"], "{name}: lowering digest");
        assert_eq!(json!(lowering.appearances), case["appearances"], "{name}");
        assert_eq!(json!(lowering.warnings), case["warnings"], "{name}");
        if name == "ambulance-plane" {
            states_of_first = Some(lowering.states);
        }
    }

    // The rig on the first case's frames.
    let rig_golden = fixture("rig.json");
    let rig = Rig::parse(
        &json!({ "schema": "simforge.render-rig/v1", "sources": rig_golden["sources"] }),
    )
    .unwrap();
    let hosts: Vec<SensorHost> = serde_json::from_value(rig_golden["sensorHosts"].clone()).unwrap();
    let states = states_of_first.unwrap();
    let schedule = camera_schedule(&rig.sources, &hosts, &states).unwrap();
    let json_schedule: Vec<Vec<Value>> = schedule
        .iter()
        .map(|tick| tick.iter().map(|c| c.json.clone()).collect())
        .collect();
    assert_eq!(
        canonical_json(&json!(json_schedule[..2])),
        rig_golden["cameraScheduleHead"].as_str().unwrap()
    );
    assert_eq!(
        sha256_hex(canonical_json(&json!(json_schedule)).as_bytes()),
        rig_golden["cameraScheduleSha256"]
    );
    let (lidars, radars) = sensor_rigs(&rig.sources, &hosts).unwrap();
    assert_eq!(
        canonical_json(&json!({ "lidars": lidars, "radars": radars })),
        rig_golden["sensorRigs"].as_str().unwrap()
    );
    let (near, far) = camera_clip_planes(&rig.sources).unwrap();
    assert_eq!(
        canonical_json(&json!({ "nearM": near, "farM": far })),
        canonical_json(&rig_golden["clipPlanes"])
    );
    let fixed = create_fixed_schedules(
        &rig.sources,
        &Clip {
            start_seconds: 0.5,
            end_seconds: 18.25,
        },
        Some(20.0),
    )
    .unwrap();
    assert_eq!(
        canonical_json(&json!(fixed)),
        canonical_json(&rig_golden["schedules"])
    );
    let without_radar: Vec<FixedSchedule> = fixed
        .iter()
        .filter(|s| s.source_id != rig.sources[2].output_name())
        .cloned()
        .collect();
    assert_eq!(
        canonical_json(&json!(union_frame_micros(&without_radar))),
        canonical_json(&rig_golden["unionMicros"])
    );
    let fixtures: Vec<NightFixture> = rig_golden["fixtures"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| NightFixture {
            source_id: f["source_id"].as_str().unwrap().into(),
            source_name: f["source_name"].as_str().unwrap().into(),
            position: [
                f["position"][0].as_f64().unwrap(),
                f["position"][1].as_f64().unwrap(),
                f["position"][2].as_f64().unwrap(),
            ],
            heading_rad: f["heading_rad"].as_f64().unwrap(),
            rule: f["rule"].as_str().unwrap().into(),
        })
        .collect();
    let eyes: Vec<[f64; 3]> = schedule
        .iter()
        .flat_map(|tick| tick.iter().map(|c| c.eye))
        .collect();
    let (ordered, observer) = order_fixtures(&fixtures, &eyes);
    assert_eq!(
        canonical_json(&json!({ "fixtures": ordered, "observer": observer })),
        rig_golden["orderedFixtures"].as_str().unwrap()
    );
}

#[test]
fn lighting_is_byte_identical_to_the_typescript_engine() {
    let golden = fixture("lighting.json");
    let sites: BTreeMap<String, LightingSite> = golden["sites"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(name, s)| {
            (
                name.clone(),
                LightingSite {
                    latitude_deg: s["latitudeDeg"].as_f64().unwrap(),
                    longitude_deg: s["longitudeDeg"].as_f64().unwrap(),
                    utc_offset_hours: s["utcOffsetHours"].as_f64().unwrap(),
                    time_zone: s["timeZone"].as_str().unwrap().into(),
                },
            )
        })
        .collect();
    let envs = golden["environments"].as_array().unwrap();
    for case in golden["cases"].as_array().unwrap() {
        let site = &sites[case["site"].as_str().unwrap()];
        let env = &envs[case["environment"].as_u64().unwrap() as usize];
        let r = resolve_native_lighting(env, site, None, case["cloudFixedStepS"].as_f64()).unwrap();
        assert_eq!(
            canonical_json(&r.lighting),
            case["lighting"].as_str().unwrap(),
            "{case}"
        );
        assert_eq!(
            canonical_json(&r.provenance),
            case["provenance"].as_str().unwrap(),
            "{case}"
        );
    }
}

#[test]
fn javascript_numbers_match_node() {
    for case in fixture("numbers.json")["cases"].as_array().unwrap() {
        let v = f64::from_bits(case["bits"].as_str().unwrap().parse().unwrap());
        let label = format!("{v:e}");
        assert_eq!(js_number(v), case["string"].as_str().unwrap(), "{label}");
        assert_eq!(
            js_number(q(v)),
            case["fixed6"].as_str().unwrap(),
            "{label}: toFixed(6)"
        );
        let rounded = js_round(v * 1_000_000.0);
        match case["round"].as_f64() {
            Some(expected) => assert_eq!(rounded, expected, "{label}: Math.round"),
            None => assert!(
                !rounded.is_finite(),
                "{label}: node rounded to a non-finite value"
            ),
        }
    }
}

/// The public richmond OpenDRIVE (not in git): `SIMFORGE_CLI_TEST_RICHMOND=<dir
/// with map.xodr>`. Expected values from the TypeScript `signalHeadGuids` and
/// `nativeLightingSiteFromOpenDrive` on the same file (2026-09-24).
#[test]
#[ignore = "needs the public richmond-field-station OpenDRIVE (SIMFORGE_CLI_TEST_RICHMOND)"]
fn richmond_signal_heads_and_site_match_the_typescript_engine() {
    use simforge_cli::render::lighting::lighting_site_from_opendrive;
    use simforge_cli::render::signal_heads::signal_head_guids;
    let dir = std::env::var_os("SIMFORGE_CLI_TEST_RICHMOND").expect("SIMFORGE_CLI_TEST_RICHMOND");
    let xodr = std::fs::read_to_string(PathBuf::from(dir).join("map.xodr")).unwrap();
    let guids: Vec<(String, String)> = signal_head_guids(&xodr).into_iter().collect();
    assert_eq!(guids.len(), 38);
    assert_eq!(
        sha256_hex(serde_json::to_string(&guids).unwrap().as_bytes()),
        "6cd70c41a066430d30109427e24cd2f6d8f6d308ecb2c2ad76e85e7b9acf44f8"
    );
    let site = lighting_site_from_opendrive(&xodr, "richmond").unwrap();
    assert_eq!(
        (site.latitude_deg, site.longitude_deg, site.utc_offset_hours),
        (37.9150891287087, -122.333308830857, -7.0)
    );
}
