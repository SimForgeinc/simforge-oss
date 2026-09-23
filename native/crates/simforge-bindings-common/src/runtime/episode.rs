//! Identical Episode JSON boundary for PyO3 and N-API.

use simforge_session::{Episode as KernelEpisode, EpisodeAction, EpisodeOptions, EpisodeSpec};
use super::{Graph, Scenario};
use crate::error::{BindingError, Result};
pub use simforge_session::FrameRef;

pub struct Episode {
    inner: KernelEpisode,
}

impl Episode {
    /// Spec is {scenario: SimScenarioInput, ...EpisodeOptions}; the resolved
    /// LaneGraph carries static colliders exactly as it does for EnvSession.
    pub fn new(spec_json: &str, graph: &Graph) -> Result<Self> {
        Ok(Self { inner: KernelEpisode::new(parse_spec(spec_json, graph)?)? })
    }

    pub fn reset(&mut self) -> Result<String> {
        let result = serde_json::to_string(&self.inner.reset()?)?;
        self.inner.observation_delivered();
        Ok(result)
    }

    pub fn reset_with<F>(&mut self, mut callback: F) -> Result<String>
    where F: FnMut(String, Vec<FrameRef>) -> std::result::Result<(), String> {
        let result = self.inner.reset_with(|episode, phase| {
            let payload = serde_json::json!({"phase": phase, "observation":episode.last_step().obs,
                "snapshot":episode.snapshot()?});
            callback(payload.to_string(), episode.frames()?).map_err(simforge_session::SessionError::Camera)
        }, true)?;
        let result = serde_json::to_string(&result)?;
        self.inner.observation_delivered();
        Ok(result)
    }

    pub fn step(&mut self, action_json: &str) -> Result<String> {
        let action: EpisodeAction = serde_json::from_str(action_json)
            .map_err(|e| BindingError::argument(format!("Episode action: {e}")))?;
        let result = serde_json::to_string(&self.inner.step(action)?)?;
        self.inner.observation_delivered();
        Ok(result)
    }

    pub fn snapshot(&self) -> Result<String> { Ok(serde_json::to_string(&self.inner.snapshot()?)?) }
    pub fn trace_json(&self) -> &str { self.inner.trace_json() }
    pub fn trace_digest(&self) -> &str { self.inner.trace_digest() }
    pub fn finish(&mut self) -> Result<String> { Ok(serde_json::to_string(self.inner.finish()?)?) }
    pub fn ego(&self) -> &str { self.inner.ego() }
    pub fn ended(&self) -> bool { self.inner.ended() }
    pub fn frame(&self, id: u32) -> Result<FrameRef> { Ok(self.inner.frame(id)?) }
    pub fn scene_state_json(&self) -> Option<&str> { self.inner.scene_state_json() }
    pub fn close(&mut self) { self.inner.close(); }
}

pub(super) fn parse_spec(spec_json: &str, graph: &Graph) -> Result<EpisodeSpec> {
    let mut spec: serde_json::Value = serde_json::from_str(spec_json)?;
    let scenario = spec.as_object_mut().and_then(|map| map.remove("scenario"))
        .ok_or_else(|| BindingError::argument("Episode spec requires scenario"))?;
    let scenario = Scenario::parse(&serde_json::to_vec(&scenario)?)?;
    if let Some(value) = spec.get_mut("seed") {
        if !value.is_u64() {
            let seed: simforge_core::rng::Seed = serde_json::from_value(value.clone())
                .map_err(|e| BindingError::argument(format!("Episode seed: {e}")))?;
            *value = serde_json::json!(simforge_core::rng::normalize_seed(&seed));
        }
    }
    let options: EpisodeOptions = serde_json::from_value(spec)
        .map_err(|e| BindingError::argument(format!("Episode spec: {e}")))?;
    Ok(EpisodeSpec { scenario: scenario.input().clone(), topology: graph.run_options(None)?, options })
}
