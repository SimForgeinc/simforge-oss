//! Ridden two-wheelers (catalog/vehicles-carla `*_rider.glb`) phase their
//! pedal/wheel clip by the render timeline's `wheelSpinRad`. This checks the
//! contract end to end on the committed cyclist example: the timeline emits
//! the channel for the bicycle, it is the signed odometer the renderers
//! assume (`Σ speed·dt / 0.35`), and the scene-state projection carries it on
//! every present bicycle record.
//!
//! `RIDERS_SCENE_STATE_OUT=<file>` also writes the scene-state document on
//! the Yale XODR height source (`RIDERS_YALE_DIR`) for a native render.

use std::io::Read;
use std::path::PathBuf;

use simforge_core::trace::timeline::{build_render_timeline, sampler, HeightField};
use simforge_core::trace::SimTrace;

fn example(name: &str) -> SimTrace {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../examples/edge-cases")
        .join(name)
        .join("scenario.trace.json.gz");
    let gz = std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let mut json = Vec::new();
    flate2::read::GzDecoder::new(&gz[..]).read_to_end(&mut json).unwrap();
    SimTrace::from_json_slice(&json).unwrap()
}

#[test]
fn two_wheelers_carry_the_signed_odometer_their_riders_pedal_by() {
    let trace = example("05-cyclist-occlusion-conflict");
    let timeline = build_render_timeline(&trace, &HeightField::flat(0.0), None).unwrap();
    let bike = timeline.actors.iter().find(|a| a.id == "wrong-way-rider").expect("the cyclist");
    let spin = bike.track.wheel_spin_rad.as_ref().expect("sampler/2 emits wheelSpinRad for bicycles");
    // The odometer is the running sum of the timeline's own signed speed.
    let mut expected = 0.0;
    let mut moved = false;
    for i in 0..spin.len() {
        let fresh = i == 0 || bike.track.present[i - 1] != 1;
        if bike.track.present[i] == 1 && !fresh {
            expected += bike.track.speed_mps[i] * timeline.dt_s / 0.35;
        }
        if bike.track.present[i] == 1 {
            assert!((spin[i] - expected).abs() < 1e-3, "tick {i}: {} vs {expected}", spin[i]);
            moved |= spin[i].abs() > 1.0;
        }
    }
    assert!(moved, "the cyclist rides: its wheels turn");

    let times: Vec<f64> = (0..=40).map(|k| k as f64 * 0.25).collect();
    let doc = sampler::scene_state_document(&timeline, &times, false).unwrap();
    let mut records = 0;
    for frame in &doc.frames {
        for rec in frame.actors.iter().filter(|a| a.id == "wrong-way-rider") {
            if rec.kind != simforge_core::trace::scene_state::ActorTickKind::Despawn {
                assert!(rec.wheel_spin_rad.is_some(), "a present bicycle record must carry wheelSpinRad");
                records += 1;
            }
        }
    }
    assert!(records > 0);

    if let Ok(out) = std::env::var("RIDERS_SCENE_STATE_OUT") {
        let dir = PathBuf::from(std::env::var("RIDERS_YALE_DIR").expect("RIDERS_YALE_DIR"));
        let height = HeightField::from_xodr(
            &std::fs::read(dir.join("map.xodr")).unwrap(),
            &std::fs::read(dir.join("topology-index.json.gz")).unwrap(),
        )
        .unwrap();
        let timeline = build_render_timeline(&trace, &height, None).unwrap();
        let times: Vec<f64> = (0..=480).map(|k| k as f64 / 24.0).filter(|t| *t <= 20.0).collect();
        let doc = sampler::scene_state_document(&timeline, &times, false).unwrap();
        std::fs::write(out, serde_json::to_vec(&doc).unwrap()).unwrap();
    }
}
