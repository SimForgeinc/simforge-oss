//! N independent worlds stepped in one call.
//!
//! Results are exposed as the session crate's flat N-major buffers plus a
//! per-world f32 object slab and world-major reward-term matrix built here.
//! Masked stepping (skip finished worlds) and per-world reset are composed
//! from `reset_some`/`step_batch` so semantics stay in one place upstream.

use simforge_core::engine::ActionOverride;
use simforge_core::rng::Seed;
use simforge_session::{EnvSession, FlatBatch, SessionBatch};

use super::{decode_checkpoint, encode_checkpoint, episode_config_from_json, Graph, Scenario};
use crate::action::decode_action_rows;
use crate::error::{BindingError, Result};
use crate::OBJECT_FEATURES;

pub struct Batch {
    batch: SessionBatch,
    actions: Vec<Option<ActionOverride>>,
    decoded: Vec<ActionOverride>,
    objects_f32: Vec<f32>,
    reward_terms: Vec<f64>,
    max_objects: usize,
}

impl Batch {
    /// `scenarios[i]` runs over `graphs[i]`; all worlds share `episode_json`.
    /// `threads = 0` uses the available hardware parallelism.
    pub fn new(
        scenarios: &[Scenario],
        graphs: &[Graph],
        episode_json: Option<&str>,
        max_objects: usize,
        threads: usize,
    ) -> Result<Self> {
        if scenarios.is_empty() {
            return Err(BindingError::argument("a batch needs at least one world"));
        }
        if scenarios.len() != graphs.len() {
            return Err(BindingError::argument(format!(
                "{} scenarios but {} graphs",
                scenarios.len(),
                graphs.len()
            )));
        }
        if max_objects == 0 {
            return Err(BindingError::argument("max_objects must be positive"));
        }
        let config = episode_config_from_json(episode_json)?;
        let sessions = scenarios
            .iter()
            .zip(graphs)
            .map(|(s, g)| {
                Ok(EnvSession::new(
                    s.input().clone(),
                    g.run_options(None)?,
                    config.clone(),
                )?)
            })
            .collect::<Result<Vec<_>>>()?;
        let n = sessions.len();
        let batch = SessionBatch::new(sessions, max_objects, threads)?;
        Ok(Self {
            batch,
            actions: vec![None; n],
            decoded: Vec::with_capacity(n),
            objects_f32: vec![0.0; n * max_objects * OBJECT_FEATURES],
            reward_terms: vec![0.0; n * 3],
            max_objects,
        })
    }

    #[inline]
    pub fn len(&self) -> usize {
        self.batch.len()
    }
    #[inline]
    pub fn is_empty(&self) -> bool {
        self.batch.is_empty()
    }
    pub fn max_objects(&self) -> usize {
        self.max_objects
    }
    pub fn decision_hz(&self) -> u32 {
        self.batch.config().decision_hz
    }
    pub fn egos(&self) -> Vec<String> {
        self.batch
            .sessions()
            .iter()
            .map(|s| s.ego().to_owned())
            .collect()
    }
    pub fn bev_shape(&self) -> Option<(usize, usize, usize)> {
        self.batch
            .config()
            .observation
            .bev
            .as_ref()
            .map(|b| (b.height(), b.width(), crate::BEV_CHANNELS))
    }
    pub fn state_vector_enabled(&self) -> bool {
        self.batch.config().observation.state_vector
    }

    /// Flat N-major buffers of the last call (`state`, `bev`, `rewards`,
    /// `terminated`, `truncated`, `t_s`, `object_counts`).
    #[inline]
    pub fn flat(&self) -> &FlatBatch {
        self.batch.flat()
    }
    /// `(N, max_objects, OBJECT_FEATURES)` f32.
    #[inline]
    pub fn objects_f32(&self) -> &[f32] {
        &self.objects_f32
    }
    /// `(N, 3)` `[progress, proximity, comfort]`.
    #[inline]
    pub fn reward_terms(&self) -> &[f64] {
        &self.reward_terms
    }

    pub fn object_ids(&self, world: usize) -> Result<Vec<String>> {
        let s = self.session(world)?;
        Ok(s.last_result()
            .observation
            .objects
            .iter()
            .take(self.max_objects)
            .map(|o| s.actor_id(o.actor).map(str::to_owned).unwrap_or_default())
            .collect())
    }

    pub fn info_json(&self, world: usize) -> Result<String> {
        let s = self.session(world)?;
        let info = &s.last_result().info;
        let minima: Vec<serde_json::Value> = info
            .minima
            .iter()
            .map(|m| {
                serde_json::json!({
                    "a": s.actor_id(m.a).unwrap_or(""),
                    "b": s.actor_id(m.b).unwrap_or(""),
                    "minDistanceM": m.min_distance_m,
                    "minTtcS": m.min_ttc_s,
                    "minPathTtcS": m.min_path_ttc_s,
                    "minPetS": m.min_pet_s,
                })
            })
            .collect();
        Ok(serde_json::to_string(
            &serde_json::json!({"events": info.events, "minima": minima, "causal": info.causal}),
        )?)
    }

    pub fn reset_all(&mut self, seeds: Option<&[Seed]>) -> Result<()> {
        self.batch.reset_all(seeds)?;
        self.refresh();
        Ok(())
    }

    /// Reset only `worlds`; `seeds[k]` (when given) applies to `worlds[k]`.
    pub fn reset_worlds(&mut self, worlds: &[usize], seeds: Option<&[Option<Seed>]>) -> Result<()> {
        if let Some(seeds) = seeds {
            if seeds.len() != worlds.len() {
                return Err(BindingError::argument(format!(
                    "{} seeds for {} worlds",
                    seeds.len(),
                    worlds.len()
                )));
            }
        }
        for &w in worlds {
            if w >= self.len() {
                return Err(BindingError::argument(format!(
                    "world {w} out of range (batch has {})",
                    self.len()
                )));
            }
        }
        let list: Vec<(usize, Option<Seed>)> = worlds
            .iter()
            .enumerate()
            .map(|(k, &w)| (w, seeds.and_then(|s| s[k].clone())))
            .collect();
        self.batch.reset_some(&list)?;
        self.refresh();
        Ok(())
    }

    /// `actions` is `(N, ACTION_WIDTH)` row-major; `mask[i] == false` leaves
    /// world `i` untouched for this call (its last result is repeated).
    pub fn step_batch(&mut self, actions: &[f64], mask: Option<&[bool]>) -> Result<()> {
        let n = self.len();
        if let Some(mask) = mask {
            if mask.len() != n {
                return Err(BindingError::argument(format!(
                    "mask has {} entries for {n} worlds",
                    mask.len()
                )));
            }
        }
        decode_action_rows(actions, n, &mut self.decoded)?;
        for (i, a) in self.decoded.iter().enumerate() {
            self.actions[i] = Some(*a);
        }
        match mask {
            None => self.batch.step_batch(&self.actions)?,
            Some(mask) => self.batch.step_masked(&self.actions, mask)?,
        }
        self.refresh();
        Ok(())
    }

    pub fn checkpoint(&self, world: usize) -> Result<Vec<u8>> {
        encode_checkpoint(&self.session(world)?.checkpoint()?)
    }

    pub fn restore(&mut self, world: usize, bytes: &[u8]) -> Result<()> {
        let checkpoint = decode_checkpoint(bytes)?;
        let n = self.len();
        let s = self.batch.session_mut(world).ok_or_else(|| {
            BindingError::argument(format!("world {world} out of range (batch has {n})"))
        })?;
        s.restore(&checkpoint)?;
        self.batch.reset_some(&[])?;
        self.refresh();
        Ok(())
    }

    fn session(&self, world: usize) -> Result<&EnvSession> {
        self.batch.session(world).ok_or_else(|| {
            BindingError::argument(format!(
                "world {world} out of range (batch has {})",
                self.len()
            ))
        })
    }

    fn refresh(&mut self) {
        let flat = self.batch.flat();
        for (dst, src) in self.objects_f32.iter_mut().zip(&flat.objects) {
            *dst = *src as f32;
        }
        for (i, s) in self.batch.sessions().iter().enumerate() {
            let t = &s.last_result().info.reward_terms;
            self.reward_terms[i * 3] = t.progress;
            self.reward_terms[i * 3 + 1] = t.proximity;
            self.reward_terms[i * 3 + 2] = t.comfort;
        }
    }
}
