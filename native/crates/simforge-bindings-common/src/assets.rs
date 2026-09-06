//! Immutable assets crossing the FFI once: decoded topologies as shared lane
//! graphs, and validated scenario inputs.
//!
//! Lane graphs are the expensive artifact; identical topology bytes (same
//! SHA-256) share one [`LaneGraph`] across every world that uses the map.
//! Hosts hold `Arc`s; dropping the last handle frees the graph.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use simforge_core::hash::sha256_bytes;
use simforge_core::map::{LaneGraph, TopologyIndex};
use simforge_core::rng::Seed;
use simforge_core::types::SimScenarioInput;

use crate::error::{BindingError, Result};

/// Decode plain or gzip topology JSON into a shared lane graph.
pub fn lane_graph_from_topology(bytes: &[u8]) -> Result<Arc<LaneGraph>> {
    let index = TopologyIndex::decode(bytes)?;
    Ok(Arc::new(LaneGraph::new(index)))
}

/// Process-wide digest-keyed graph cache used by episode banks and batches
/// that load many instances over the same map.
#[derive(Default)]
pub struct GraphCache {
    by_digest: Mutex<HashMap<String, Arc<LaneGraph>>>,
}

impl GraphCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// Decode once per distinct byte content; returns the shared graph and its
    /// byte digest.
    pub fn load(&self, bytes: &[u8]) -> Result<(Arc<LaneGraph>, String)> {
        let digest = sha256_bytes(bytes);
        if let Some(graph) = self
            .by_digest
            .lock()
            .expect("graph cache poisoned")
            .get(&digest)
        {
            return Ok((Arc::clone(graph), digest));
        }
        let graph = lane_graph_from_topology(bytes)?;
        self.by_digest
            .lock()
            .expect("graph cache poisoned")
            .insert(digest.clone(), Arc::clone(&graph));
        Ok((graph, digest))
    }
}

/// Parse a scenario document (plain JSON bytes) through the validating
/// contract and normalise it exactly once. Accepts either a raw
/// `SimScenarioInput` or the CLI's `{kind: "scenario-instance", input}`
/// envelope.
pub fn parse_scenario(bytes: &[u8]) -> Result<SimScenarioInput> {
    let document: serde_json::Value = serde_json::from_slice(bytes)?;
    let input =
        if document.get("kind").and_then(serde_json::Value::as_str) == Some("scenario-instance") {
            document.get("input").ok_or_else(|| {
                BindingError::argument("scenario-instance requires an input document")
            })?
        } else {
            &document
        };
    Ok(simforge_core::types::parse_scenario_input_value(input)?.normalized())
}

/// Serialize a scenario input back to its canonical camelCase JSON.
pub fn scenario_to_json(input: &SimScenarioInput) -> Result<String> {
    Ok(serde_json::to_string(input)?)
}

/// Host seed values are either numbers or text; both are canonical `Seed`s.
pub fn seed_from_host(number: Option<f64>, text: Option<&str>) -> Result<Option<Seed>> {
    match (number, text) {
        (None, None) => Ok(None),
        (Some(n), None) => {
            if !n.is_finite() {
                return Err(BindingError::argument("seed must be finite"));
            }
            Ok(Some(Seed::Number(n)))
        }
        (None, Some(t)) => Ok(Some(Seed::Text(t.to_owned()))),
        (Some(_), Some(_)) => Err(BindingError::argument(
            "seed must be a number or a string, not both",
        )),
    }
}

/// Parse a JSON seed value (`number | string | null`).
pub fn seed_from_json(value: &serde_json::Value) -> Result<Option<Seed>> {
    match value {
        serde_json::Value::Null => Ok(None),
        serde_json::Value::Number(n) => seed_from_host(n.as_f64(), None),
        serde_json::Value::String(s) => Ok(Some(Seed::Text(s.clone()))),
        other => Err(BindingError::argument(format!(
            "seed must be a number or string, got {other}"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_scenario, scenario_to_json};

    #[test]
    fn instance_envelope_preserves_input_independent_of_key_position() {
        let raw = serde_json::json!({
            "schemaVersion": 1,
            "mapId": "synthetic",
            "clipSeconds": 1,
            "warmupSeconds": 0,
            "dt": 0.02,
            "seed": 0,
            "actors": [],
            "interactions": []
        });
        let input = parse_scenario(&serde_json::to_vec(&raw).unwrap()).unwrap();
        let envelope = format!(
            "{{\n  \"manifest\": {{\"notes\": \"{}\"}},\n  \"kind\": \"scenario-instance\",\n  \"version\": 1,\n  \"input\": {}\n}}",
            "x".repeat(300),
            serde_json::to_string_pretty(&raw).unwrap()
        );
        let wrapped = parse_scenario(envelope.as_bytes()).unwrap();
        assert_eq!(
            scenario_to_json(&wrapped).unwrap(),
            scenario_to_json(&input).unwrap()
        );
    }
}
