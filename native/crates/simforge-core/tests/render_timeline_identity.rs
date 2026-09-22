//! Binding identity corpus, Rust side. The same corpus is replayed by the
//! WASM binding (`packages/native-runtime/src/__tests__/render-timeline-identity.test.ts`)
//! and the Python binding (`adapters/timeline/tests/test_identity.py`); all
//! three must reproduce the committed digests bit for bit.
//!
//! Re-bless after an intentional samplerVersion change:
//! `SIMFORGE_BLESS_TIMELINE_IDENTITY=1 cargo test -p simforge-core --test render_timeline_identity`.

use std::path::{Path, PathBuf};

use serde_json::Value;
use sha2::{Digest, Sha256};

use simforge_core::trace::timeline::{
    build_render_timeline, maybe_gunzip, sampler, HeightField, RenderTimeline, SAMPLER_VERSION,
};
use simforge_core::trace::SimTrace;

const CANONICAL_NAN: u64 = 0x7ff8_0000_0000_0000;

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

/// The probe schedule every harness uses: each tick, the midpoint to the
/// next tick, and 30 % of the way to it.
fn probe_times(t: &[f64]) -> Vec<f64> {
    let mut out = Vec::with_capacity(t.len() * 3);
    for i in 0..t.len() {
        out.push(t[i]);
        if i + 1 < t.len() {
            out.push((t[i] + t[i + 1]) / 2.0);
            out.push(t[i] + 0.3 * (t[i + 1] - t[i]));
        }
    }
    out
}

fn pose_digest(tl: &RenderTimeline) -> String {
    let mut hasher = Sha256::new();
    for t in probe_times(&tl.t) {
        for actor in &tl.actors {
            let p = sampler::pose(tl, &actor.id, t).unwrap();
            for v in p.to_array() {
                let bits = if v.is_nan() { CANONICAL_NAN } else { v.to_bits() };
                hasher.update(bits.to_le_bytes());
            }
        }
    }
    hex(&hasher.finalize())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn height_of(spec: &Value) -> HeightField {
    match spec["kind"].as_str().unwrap() {
        "flat" => HeightField::flat(spec["z"].as_f64().unwrap()),
        "plane" => HeightField::plane(
            spec["z0"].as_f64().unwrap(),
            spec["gx"].as_f64().unwrap(),
            spec["gy"].as_f64().unwrap(),
        ),
        other => panic!("unknown height kind {other}"),
    }
}

#[test]
fn rust_reproduces_the_binding_identity_corpus() {
    let corpus_path = repo().join("fixtures/render-timeline/identity-corpus.json");
    let mut corpus: Value =
        serde_json::from_slice(&std::fs::read(&corpus_path).unwrap()).unwrap();
    let bless = std::env::var_os("SIMFORGE_BLESS_TIMELINE_IDENTITY").is_some();
    assert_eq!(corpus["samplerVersion"], SAMPLER_VERSION);
    let mut failures = Vec::new();
    for case in corpus["cases"].as_array_mut().unwrap() {
        let bytes = std::fs::read(repo().join(case["trace"].as_str().unwrap())).unwrap();
        let trace = SimTrace::from_json_slice(&maybe_gunzip(&bytes).unwrap()).unwrap();
        let catalog = case["catalogDigest"].as_str();
        let tl = build_render_timeline(&trace, &height_of(&case["height"]), catalog).unwrap();
        let got = [
            ("timelineKey", tl.identity.timeline_key.clone()),
            ("timelineSha256", tl.sha256().unwrap()),
            ("poseDigest", pose_digest(&tl)),
        ];
        for (field, value) in got {
            if bless {
                case[field] = Value::String(value);
            } else if case[field].as_str() != Some(value.as_str()) {
                failures.push(format!("{} {field}: {} != {value}", case["id"], case[field]));
            }
        }
    }
    if bless {
        let text = serde_json::to_string_pretty(&corpus).unwrap() + "\n";
        std::fs::write(&corpus_path, text).unwrap();
    }
    assert!(failures.is_empty(), "{failures:#?}");
}
