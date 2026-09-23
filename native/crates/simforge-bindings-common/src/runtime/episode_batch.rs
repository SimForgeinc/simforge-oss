//! Typed training fast path over the very same Episode used by JSON hosts.
use simforge_session::{EpisodeAction, EpisodeBatch as KernelBatch, FlatBatch, REWARD_TERM_COUNT};
use super::{decode_checkpoint, encode_checkpoint, episode::parse_spec, Graph};
use crate::{error::{BindingError, Result}, OBJECT_FEATURES};

pub struct EpisodeBatch {
    inner: KernelBatch,
    actions: Vec<EpisodeAction>,
    objects: Vec<f32>,
    reward_terms: Vec<f64>,
    collisions: Vec<bool>,
    goals: Vec<bool>,
}

impl EpisodeBatch {
    pub fn new(specs: &[String], graphs: &[Graph], max_objects: usize, threads: usize) -> Result<Self> {
        if specs.len() != graphs.len() { return Err(BindingError::argument("one graph required per Episode spec")); }
        let specs = specs.iter().zip(graphs).map(|(s, g)| parse_spec(s, g)).collect::<Result<Vec<_>>>()?;
        let inner = KernelBatch::new(specs, max_objects, threads)?;
        let n = inner.len();
        Ok(Self { inner, actions: Vec::with_capacity(n), objects: vec![0.0; n * max_objects * OBJECT_FEATURES],
            reward_terms: vec![0.0; n * REWARD_TERM_COUNT], collisions: vec![false; n], goals: vec![false; n] })
    }
    pub fn len(&self) -> usize { self.inner.len() }
    pub fn is_empty(&self) -> bool { self.inner.is_empty() }
    pub fn max_objects(&self) -> usize { self.inner.flat().max_objects }
    pub fn decision_hz(&self) -> u32 { self.inner.decision_hz() }
    pub fn egos(&self) -> Vec<String> { self.inner.episodes().iter().map(|e| e.ego().to_owned()).collect() }
    pub fn flat(&self) -> &FlatBatch { self.inner.flat() }
    pub fn objects_f32(&self) -> &[f32] { &self.objects }
    pub fn reward_terms(&self) -> &[f64] { &self.reward_terms }
    pub fn collisions(&self) -> &[bool] { &self.collisions }
    pub fn goals(&self) -> &[bool] { &self.goals }
    pub fn autoreset(&self) -> &[bool] { self.inner.autoreset() }
    pub fn term_reasons(&self) -> Vec<Option<String>> {
        self.inner.episodes().iter().enumerate().map(|(i, e)|
            if self.inner.reset_view() || self.inner.autoreset()[i] { None } else { e.last_step().term_reason.map(str::to_owned) }).collect()
    }
    pub fn state_vector_enabled(&self) -> bool { self.inner.env(0).expect("nonempty batch").config().observation.state_vector }
    pub fn signals_enabled(&self) -> bool { self.inner.env(0).expect("nonempty batch").config().observation.signals }
    pub fn bev_shape(&self) -> Option<(usize, usize, usize)> {
        let flat = self.flat();
        (flat.bev_height > 0).then_some((flat.bev_height, flat.bev_width, crate::BEV_CHANNELS))
    }
    pub fn object_ids(&self, i: usize) -> Result<Vec<String>> {
        let e = self.inner.episodes().get(i).ok_or_else(|| BindingError::argument("world out of range"))?;
        let env = self.inner.env(i).expect("checked world");
        e.last_step().obs.objects.unwrap_or_default().iter().take(self.max_objects())
            .map(|o| env.actor_id(o.actor).map(str::to_owned).map_err(Into::into)).collect()
    }
    pub fn signals_json(&self, i: usize) -> Result<Option<String>> {
        let e = self.inner.episodes().get(i).ok_or_else(|| BindingError::argument("world out of range"))?;
        e.last_step().obs.signals.map(serde_json::to_string).transpose().map_err(Into::into)
    }
    pub fn info_json(&self, i: usize) -> Result<String> {
        let env = self.inner.env(i).ok_or_else(|| BindingError::argument("world out of range"))?;
        let info = &env.last_result().info;
        let minima: Vec<_> = info.minima.iter().map(|m| serde_json::json!({
            "a":env.actor_id(m.a).unwrap_or(""), "b":env.actor_id(m.b).unwrap_or(""),
            "minDistanceM":m.min_distance_m, "minTtcS":m.min_ttc_s,
            "minPathTtcS":m.min_path_ttc_s, "minPetS":m.min_pet_s,
        })).collect();
        Ok(serde_json::json!({"events":info.events, "minima":minima, "causal":info.causal,
            "collision":info.collision, "rewardTerms":info.reward_terms}).to_string())
    }
    pub fn reset_all(&mut self, seeds: Option<&[u64]>) -> Result<()> {
        self.inner.reset_all(seeds)?;
        self.refresh(true);
        Ok(())
    }
    pub fn reset_seed(&mut self, seed: u64) -> Result<()> {
        self.inner.reset_seed(seed)?;
        self.refresh(true);
        Ok(())
    }
    /// Dense (N, 2) setpoints or (N, 3) controls; no Python per-world packing.
    pub fn step_all(&mut self, rows: &[f64], width: usize) -> Result<()> {
        if !matches!(width, 2 | 3) || rows.len() != self.len() * width {
            return Err(BindingError::argument("actions must be (N, 2) setpoints or (N, 3) controls"));
        }
        self.actions.clear();
        self.actions.extend(rows.chunks_exact(width).map(|row| if width == 2 {
            EpisodeAction::Setpoint { speed_mps: Some(row[0]), acceleration_mps2: Some(row[1]),
                preview_point: None, preview_heading_rad: None, motion_direction: None }
        } else { EpisodeAction::Control { c: [row[0], row[1], row[2]] } }));
        self.inner.step_all(&self.actions)?;
        self.refresh(false);
        Ok(())
    }
    pub fn step_all_json(&mut self, actions: &str) -> Result<()> {
        self.actions = serde_json::from_str(actions).map_err(|e| BindingError::argument(format!("Episode actions: {e}")))?;
        self.inner.step_all(&self.actions)?;
        self.refresh(false);
        Ok(())
    }
    pub fn checkpoint(&self) -> Result<Vec<u8>> { encode_checkpoint(&self.inner.checkpoint()?) }
    pub fn restore(&mut self, bytes: &[u8]) -> Result<()> {
        self.inner.restore(&decode_checkpoint(bytes)?)?;
        self.refresh(self.inner.reset_view());
        Ok(())
    }
    pub fn trace_digests(&self) -> Vec<String> { self.inner.episodes().iter().map(|e| e.trace_digest().to_owned()).collect() }
    pub fn trace_json(&self, i: usize) -> Result<&str> {
        self.inner.episodes().get(i).map(|e| e.trace_json()).ok_or_else(|| BindingError::argument("world out of range"))
    }
    fn refresh(&mut self, reset: bool) {
        for (dst, src) in self.objects.iter_mut().zip(&self.inner.flat().objects) { *dst = *src as f32; }
        for (i, episode) in self.inner.episodes().iter().enumerate() {
            let terms = episode.last_step().reward_terms;
            let clear = reset || self.inner.autoreset()[i];
            self.reward_terms[i * REWARD_TERM_COUNT..(i + 1) * REWARD_TERM_COUNT]
                .copy_from_slice(&if clear { [0.0; REWARD_TERM_COUNT] } else { terms.values() });
            self.collisions[i] = !clear && terms.collision.is_some();
            self.goals[i] = !clear && terms.goal.is_some();
        }
    }
}
