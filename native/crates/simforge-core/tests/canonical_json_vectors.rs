//! The shared canonical-JSON conformance vectors (`fixtures/canonical-json/vectors.json`).
//!
//! TypeScript (`@simforge-oss/scenario/canonical-json`) runs the same file, so a
//! digest computed in the browser, in Node or here is one digest. A vector that
//! fails here means the Rust writer and the TS writer disagree on the rule.

use std::path::PathBuf;

use serde_json::Value;
use simforge_core::hash::{canonical_json, sha256};

fn vectors() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../fixtures/canonical-json/vectors.json");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    serde_json::from_str(&text).expect("vectors.json is JSON")
}

#[test]
fn rust_canonical_json_matches_the_shared_vectors() {
    let suite = vectors();
    assert_eq!(suite["rule"], "simforge.canonical-json/v1");
    let list = suite["vectors"].as_array().expect("vectors array");
    assert!(!list.is_empty());
    for vector in list {
        let id = vector["id"].as_str().unwrap();
        let input: Value = serde_json::from_str(vector["input"].as_str().unwrap())
            .unwrap_or_else(|e| panic!("{id}: input is not JSON: {e}"));
        let canonical = canonical_json(&input).unwrap_or_else(|e| panic!("{id}: {e}"));
        assert_eq!(canonical, vector["canonical"].as_str().unwrap(), "vector {id}");
        assert_eq!(sha256(&canonical), vector["sha256"].as_str().unwrap(), "vector {id} digest");
    }
}
