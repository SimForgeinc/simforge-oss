//! One finite episode over one world.

use simforge_core::engine::ActorSnapshot;
use simforge_core::rng::Seed;
use simforge_session::{EnvCheckpoint, EnvSession, StepResult};

use super::simulate::{push_actor_row, ACTOR_ROW};
use super::{decode_checkpoint, encode_checkpoint, episode_config_from_json, Graph, Scenario};
use crate::action::decode_action;
use crate::error::{BindingError, Result};
use crate::{OBJECT_FEATURES, STATE_VECTOR_SIZE};

/// Borrowed view of the last decision. Slices are valid until the next
/// mutating call on the owning [`Env`]; hosts copy them out.
pub struct StepView<'a> {
    result: &'a StepResult,
    session: &'a EnvSession,
    objects: &'a [f32],
    object_ids: &'a [String],
    reward_terms: [f64; 3],
}

impl<'a> StepView<'a> {
    pub fn t_s(&self) -> f64 {
        self.result.observation.t_s
    }
    pub fn reward(&self) -> f64 {
        self.result.reward
    }
    pub fn terminated(&self) -> bool {
        self.result.terminated
    }
    pub fn truncated(&self) -> bool {
        self.result.truncated
    }
    /// `[f64; STATE_VECTOR_SIZE]`, or empty when the state vector is disabled.
    pub fn state_vector(&self) -> &[f64] {
        self.result
            .observation
            .state_vector
            .as_ref()
            .map_or(&[], |v| &v[..])
    }
    /// `(max_objects, OBJECT_FEATURES)` row-major f32, zero-padded.
    pub fn objects(&self) -> &[f32] {
        self.objects
    }
    pub fn object_count(&self) -> usize {
        self.object_ids.len()
    }
    pub fn object_ids(&self) -> &[String] {
        self.object_ids
    }
    /// `(height, width, channels)` and the raster, when BEV is configured.
    pub fn bev(&self) -> Option<((usize, usize, usize), &[f32])> {
        self.result
            .observation
            .bev
            .as_ref()
            .map(|b| ((b.height, b.width, b.channels), &b.data[..]))
    }
    /// `[progress, proximity, comfort]`.
    pub fn reward_terms(&self) -> [f64; 3] {
        self.reward_terms
    }
    /// `{events, minima, causal}` with actor handles resolved to canonical ids.
    pub fn info_json(&self) -> Result<String> {
        let info = &self.result.info;
        let minima: Vec<serde_json::Value> = info
            .minima
            .iter()
            .map(|m| {
                serde_json::json!({
                    "a": self.session_actor_id(m.a),
                    "b": self.session_actor_id(m.b),
                    "minDistanceM": m.min_distance_m,
                    "minTtcS": m.min_ttc_s,
                    "minPathTtcS": m.min_path_ttc_s,
                    "minPetS": m.min_pet_s,
                })
            })
            .collect();
        Ok(serde_json::to_string(&serde_json::json!({
            "events": info.events,
            "minima": minima,
            "causal": info.causal,
        }))?)
    }

    fn session_actor_id(&self, actor: simforge_core::engine::ActorIndex) -> String {
        self.session
            .actor_id(actor)
            .map(str::to_owned)
            .unwrap_or_default()
    }
}

pub struct Env {
    session: EnvSession,
    max_objects: usize,
    objects: Vec<f32>,
    object_ids: Vec<String>,
}

impl Env {
    pub fn new(
        scenario: &Scenario,
        graph: &Graph,
        episode_json: Option<&str>,
        max_objects: usize,
    ) -> Result<Self> {
        if max_objects == 0 {
            return Err(BindingError::argument("max_objects must be positive"));
        }
        let config = episode_config_from_json(episode_json)?;
        let session = EnvSession::new(scenario.input().clone(), graph.run_options(None)?, config)?;
        Ok(Self {
            session,
            max_objects,
            objects: vec![0.0; max_objects * OBJECT_FEATURES],
            object_ids: Vec::new(),
        })
    }

    #[inline]
    pub fn session(&self) -> &EnvSession {
        &self.session
    }

    pub fn ego(&self) -> &str {
        self.session.ego()
    }
    pub fn decision_hz(&self) -> u32 {
        self.session.episode().decision_hz
    }
    pub fn decision_ticks(&self) -> usize {
        self.session.episode().decision_ticks
    }
    pub fn clip_seconds(&self) -> f64 {
        self.session.episode().clip_seconds
    }
    pub fn max_objects(&self) -> usize {
        self.max_objects
    }
    /// `(height, width, channels)` when BEV is configured.
    pub fn bev_shape(&self) -> Option<(usize, usize, usize)> {
        self.session
            .config()
            .observation
            .bev
            .as_ref()
            .map(|b| (b.height(), b.width(), crate::BEV_CHANNELS))
    }
    pub fn state_vector_enabled(&self) -> bool {
        self.session.config().observation.state_vector
    }

    pub fn reset(&mut self, seed: Option<Seed>) -> Result<StepView<'_>> {
        self.session.reset(seed.as_ref())?;
        self.refresh();
        Ok(self.view())
    }

    /// `row` is one flat action row or `None` for the authored choreography.
    pub fn step(&mut self, row: Option<&[f64]>) -> Result<StepView<'_>> {
        let action = row.map(decode_action).transpose()?;
        self.session.step(action)?;
        self.refresh();
        Ok(self.view())
    }

    /// Step with an already-decoded override (policy executors).
    pub(crate) fn step_override(
        &mut self,
        action: Option<simforge_core::engine::ActionOverride>,
    ) -> Result<StepView<'_>> {
        self.session.step(action)?;
        self.refresh();
        Ok(self.view())
    }

    pub fn view(&self) -> StepView<'_> {
        let terms = &self.session.last_result().info.reward_terms;
        StepView {
            result: self.session.last_result(),
            session: &self.session,
            objects: &self.objects,
            object_ids: &self.object_ids,
            reward_terms: [terms.progress, terms.proximity, terms.comfort],
        }
    }

    pub fn checkpoint(&self) -> Result<Vec<u8>> {
        encode_checkpoint(&self.session.checkpoint()?)
    }

    pub fn restore(&mut self, bytes: &[u8]) -> Result<StepView<'_>> {
        let checkpoint: EnvCheckpoint = decode_checkpoint(bytes)?;
        self.restore_checkpoint(&checkpoint)
    }

    pub(crate) fn restore_checkpoint(
        &mut self,
        checkpoint: &EnvCheckpoint,
    ) -> Result<StepView<'_>> {
        self.session.restore(checkpoint)?;
        self.refresh();
        Ok(self.view())
    }

    /// `(t_s, x, y, yaw_rad, speed_mps)`; errors before `reset()`.
    pub fn ego_pose(&self) -> Result<[f64; 5]> {
        let (pose, t_s) = self
            .session
            .ego_pose()
            .ok_or(simforge_session::SessionError::NotReset)?;
        Ok([t_s, pose.x, pose.y, pose.yaw_rad, pose.speed_mps])
    }

    /// Engine world plus the actor snapshot rows of the observation instant;
    /// errors before `reset()`.
    fn actor_state(&self) -> Result<(&simforge_core::engine::Simulation, &[ActorSnapshot])> {
        let sim = self
            .session
            .simulation()
            .ok_or(simforge_session::SessionError::NotReset)?;
        Ok((sim, self.session.actor_snapshots()?))
    }

    /// Actors in the world at the observation instant; errors before `reset()`.
    pub fn actor_count(&self) -> Result<usize> {
        Ok(self.actor_state()?.1.len())
    }
    /// Canonical ids in snapshot (sorted-id) order — the row order of every
    /// other actor read here; errors before `reset()`.
    pub fn actor_ids(&self) -> Result<Vec<String>> {
        let (sim, actors) = self.actor_state()?;
        Ok(actors
            .iter()
            .map(|a| sim.actor_id(a.index).to_owned())
            .collect())
    }
    pub fn actor_kinds(&self) -> Result<Vec<&'static str>> {
        let (sim, actors) = self.actor_state()?;
        Ok(actors
            .iter()
            .map(|a| sim.actor_kind(a.index).as_str())
            .collect())
    }
    /// `(N, 3)` `[l, w, h]`.
    pub fn actor_dims(&self) -> Result<Vec<f64>> {
        let (sim, actors) = self.actor_state()?;
        Ok(actors
            .iter()
            .flat_map(|a| {
                let d = sim.actor_dims(a.index);
                [d.l, d.w, d.h]
            })
            .collect())
    }
    /// `(N, ACTOR_ROW)` rows at the observation instant (xodr-local frame).
    pub fn actor_rows(&self) -> Result<Vec<f64>> {
        let actors = self.actor_state()?.1;
        let mut rows = Vec::with_capacity(actors.len() * ACTOR_ROW);
        for a in actors {
            push_actor_row(&mut rows, a);
        }
        Ok(rows)
    }
    pub fn actor_present(&self) -> Result<Vec<bool>> {
        Ok(self.actor_state()?.1.iter().map(|a| a.present).collect())
    }

    /// Live signal state at the current instant as JSON `{tS, signals, overrides}`; errors before `reset()`.
    pub fn signal_book_json(&self) -> Result<String> {
        let sim = self
            .session
            .simulation()
            .ok_or(simforge_session::SessionError::NotReset)?;
        signal_state_json(sim)
    }

    /// Every causal frame recorded this episode (`CausalChannel`, camelCase JSON); errors before `reset()`.
    pub fn causal_channel_json(&self) -> Result<String> {
        Ok(serde_json::to_string(&self.session.causal_channel()?)?)
    }

    fn refresh(&mut self) {
        let obs = &self.session.last_result().observation;
        self.objects.fill(0.0);
        self.object_ids.clear();
        for (k, o) in obs.objects.iter().take(self.max_objects).enumerate() {
            let row = &mut self.objects[k * OBJECT_FEATURES..(k + 1) * OBJECT_FEATURES];
            row[0] = o.range_m as f32;
            row[1] = o.bearing_rad as f32;
            row[2] = o.range_rate_mps as f32;
            row[3] = if o.line_of_sight { 1.0 } else { 0.0 };
            row[4] = 1.0;
            self.object_ids.push(
                self.session
                    .actor_id(o.actor)
                    .map(str::to_owned)
                    .unwrap_or_default(),
            );
        }
        debug_assert!(obs
            .state_vector
            .map_or(true, |v| v.len() == STATE_VECTOR_SIZE));
    }
}

/// `{tS, signals: SignalSnapshot[], overrides: [{signalId, indication}]}` for the
/// live signal book of `sim` (phase overrides applied).
pub(crate) fn signal_state_json(sim: &simforge_core::engine::Simulation) -> Result<String> {
    let book = sim.signal_book();
    let t_s = sim.t_s();
    let overrides: Vec<serde_json::Value> = book
        .ids()
        .zip(book.overrides())
        .filter_map(|(id, o)| o.map(|ind| serde_json::json!({"signalId": id, "indication": ind})))
        .collect();
    Ok(serde_json::to_string(&serde_json::json!({
        "tS": t_s,
        "signals": book.snapshots_at(t_s, Some(sim.dt_s())),
        "overrides": overrides,
    }))?)
}
