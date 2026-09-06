//! Checkpoint byte codec shared by every host boundary and the runner.
//!
//! A checkpoint document (`SimulationCheckpoint`, the session crate's
//! `EnvCheckpoint` / `WorldCheckpoint`, runner batch bundles) is encoded
//! directly as one MessagePack value — no JSON intermediate:
//!
//! - structs are string-keyed maps (field names on the wire, so
//!   `#[serde(tag = ...)]` and `#[serde(untagged)]` enums round-trip and a
//!   missing field is a decode error, not a positional shift);
//! - tuples are arrays, which MessagePack accepts as map keys, so tuple-keyed
//!   accumulator maps such as `(observer, target) -> visible` are legal;
//! - `f64` is always float64, so NaN and ±inf minima survive verbatim.
//!
//! Hosts never inspect the bytes: they are opaque, portable across
//! Node/WASM/Python/runner, and a checkpoint is exactly one document —
//! trailing bytes are rejected.

use std::io::Cursor;

use serde::de::DeserializeOwned;
use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum CheckpointCodecError {
    #[error("checkpoint encode: {0}")]
    Encode(#[from] rmp_serde::encode::Error),
    #[error("checkpoint decode: {0}")]
    Decode(#[from] rmp_serde::decode::Error),
    #[error("checkpoint decode: {0} trailing bytes after the document")]
    Trailing(usize),
}

pub type Result<T, E = CheckpointCodecError> = std::result::Result<T, E>;

/// Encode one checkpoint document as MessagePack.
pub fn encode<T: Serialize + ?Sized>(value: &T) -> Result<Vec<u8>> {
    Ok(rmp_serde::to_vec_named(value)?)
}

/// Decode one checkpoint document produced by [`encode`].
pub fn decode<T: DeserializeOwned>(bytes: &[u8]) -> Result<T> {
    let mut deserializer = rmp_serde::Deserializer::new(Cursor::new(bytes));
    let value = T::deserialize(&mut deserializer)?;
    let trailing = bytes.len() - deserializer.position() as usize;
    if trailing != 0 {
        return Err(CheckpointCodecError::Trailing(trailing));
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use serde::{Deserialize, Serialize};

    use super::{decode, encode, CheckpointCodecError};

    /// The shapes JSON cannot carry and a real checkpoint contains: tuple-keyed
    /// maps (causal LOS state), non-finite accumulators (unmet minima), an
    /// internally tagged enum and an embedded `serde_json::Value` input.
    #[derive(Debug, PartialEq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct State {
        los_state: HashMap<(u32, u32), bool>,
        min_ttc_s: f64,
        min_gap_m: f64,
        worst_accel: f64,
        route: Route,
        input: serde_json::Value,
    }

    #[derive(Debug, PartialEq, Serialize, Deserialize)]
    #[serde(tag = "kind", rename_all = "camelCase")]
    enum Route {
        LaneChain { legs: Vec<String> },
        Polyline { points: Vec<(f64, f64)> },
    }

    fn sample() -> State {
        State {
            los_state: HashMap::from([((0, 3), true), ((3, 0), false)]),
            min_ttc_s: f64::INFINITY,
            min_gap_m: f64::NAN,
            worst_accel: f64::NEG_INFINITY,
            route: Route::Polyline {
                points: vec![(0.5, -1.25), (2.0, 3.0)],
            },
            input: serde_json::json!({ "actors": [{ "id": "ego", "speed": 8.5, "tags": [] }], "seed": 11 }),
        }
    }

    #[test]
    fn tuple_keys_and_non_finite_floats_round_trip() {
        let state = sample();
        let bytes = encode(&state).unwrap();
        let back: State = decode(&bytes).unwrap();
        assert_eq!(back.los_state, state.los_state);
        assert_eq!(back.min_ttc_s, f64::INFINITY);
        assert!(back.min_gap_m.is_nan());
        assert_eq!(back.worst_accel, f64::NEG_INFINITY);
        assert_eq!(back.route, state.route);
        assert_eq!(back.input, state.input);
    }

    #[test]
    fn truncated_and_padded_documents_are_rejected() {
        let bytes = encode(&sample()).unwrap();
        assert!(matches!(
            decode::<State>(&bytes[..bytes.len() / 2]),
            Err(CheckpointCodecError::Decode(_))
        ));
        let mut padded = bytes.clone();
        padded.extend_from_slice(&[0xc0, 0xc0]);
        assert!(matches!(
            decode::<State>(&padded),
            Err(CheckpointCodecError::Trailing(2))
        ));
    }
}
