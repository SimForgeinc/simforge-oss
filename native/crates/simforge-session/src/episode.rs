//! Episode timing, termination, reward and observation configuration.
//!
//! Everything is deterministic: decision boundaries land on integer engine
//! ticks (`decision_hz` must divide the engine rate), time is derived from
//! tick indices, never accumulated.

use serde::{Deserialize, Serialize};

use crate::error::{Result, SessionError};

/// The canonical fixed-step engine rate. `dt = 0.02 s`.
pub const ENGINE_HZ: u32 = 50;

/// Reward weights. One config object so training can retune without touching
/// semantics.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RewardConfig {
    /// Applied once when a collision involving the ego terminates the episode.
    pub collision_penalty: f64,
    /// Applied once when the configured goal (trigger fire or route end) is met.
    pub goal_bonus: f64,
    /// Per metre of ego route progress within one decision interval.
    pub progress_weight: f64,
    /// Per-decision penalty weight on standing too close to any other actor.
    pub proximity_weight: f64,
    /// Actors closer than this contribute the proximity penalty.
    pub proximity_range_m: f64,
    /// Per-decision penalty weight on absolute longitudinal acceleration.
    pub comfort_accel_weight: f64,
}

impl Default for RewardConfig {
    fn default() -> Self {
        Self {
            collision_penalty: -10.0,
            goal_bonus: 10.0,
            progress_weight: 0.05,
            proximity_weight: 0.02,
            proximity_range_m: 15.0,
            comfort_accel_weight: 0.005,
        }
    }
}

/// Ego-centric BEV raster geometry.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BevConfig {
    /// Metres per cell edge.
    pub resolution_m: f64,
    /// Forward extent from the ego reference point, metres.
    pub forward_m: f64,
    /// Backward extent behind the ego, metres.
    pub backward_m: f64,
    /// Half-width of the raster either side of the ego, metres.
    pub half_width_m: f64,
    /// Minimum half-width used when stamping lane surface polylines.
    pub lane_half_width_m: f64,
}

impl Default for BevConfig {
    fn default() -> Self {
        Self {
            resolution_m: 0.25,
            forward_m: 40.0,
            backward_m: 10.0,
            half_width_m: 20.0,
            lane_half_width_m: 1.75,
        }
    }
}

impl BevConfig {
    #[inline]
    pub fn width(&self) -> usize {
        (((2.0 * self.half_width_m) / self.resolution_m).round() as usize).max(1)
    }

    #[inline]
    pub fn height(&self) -> usize {
        (((self.forward_m + self.backward_m) / self.resolution_m).round() as usize).max(1)
    }
}

/// Observation-channel switches.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ObservationConfig {
    pub state_vector: bool,
    /// Object-list gating range when the ego declares no sensors.
    pub object_list_range_m: f64,
    /// `None` disables the BEV raster.
    pub bev: Option<BevConfig>,
}

impl Default for ObservationConfig {
    fn default() -> Self {
        Self {
            state_vector: true,
            object_list_range_m: 60.0,
            bev: None,
        }
    }
}

/// Goal definition for the completion bonus / `terminated` flag: a trigger
/// with this interaction id firing, and/or the ego running out of route.
/// Both set = both required.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalSpec {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interaction_id: Option<String>,
    #[serde(default)]
    pub route_end: bool,
}

/// Episode timing and termination policy as supplied by the caller.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EpisodeConfig {
    /// Must divide [`ENGINE_HZ`].
    pub decision_hz: u32,
    /// Overrides the input's authored clip length.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clip_seconds: Option<f64>,
    /// Warm-up ticks are consumed inside `reset` and never policy-visible.
    pub warmup_excluded: bool,
    /// Truncate after this many decisions even if clip time remains.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_decisions: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goal: Option<GoalSpec>,
    pub reward: RewardConfig,
    pub observation: ObservationConfig,
}

impl Default for EpisodeConfig {
    fn default() -> Self {
        Self {
            decision_hz: 10,
            clip_seconds: None,
            warmup_excluded: true,
            max_decisions: None,
            goal: None,
            reward: RewardConfig::default(),
            observation: ObservationConfig::default(),
        }
    }
}

/// Fully resolved episode timing, fixed for the session's lifetime.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedEpisode {
    pub decision_hz: u32,
    pub clip_seconds: f64,
    /// Engine ticks per decision (`ENGINE_HZ / decision_hz`).
    pub decision_ticks: usize,
    pub dt_decision_s: f64,
    pub max_decisions: Option<u32>,
    pub goal: Option<GoalSpec>,
    pub warmup_excluded: bool,
}

impl ResolvedEpisode {
    /// Validate and resolve against the input's authored clip length and step.
    pub fn resolve(cfg: &EpisodeConfig, authored_clip_seconds: f64, dt: f64) -> Result<Self> {
        if cfg.decision_hz == 0 || ENGINE_HZ % cfg.decision_hz != 0 {
            return Err(SessionError::Config(format!(
                "decisionHz must be a positive integer dividing {ENGINE_HZ}, got {}",
                cfg.decision_hz
            )));
        }
        let engine_dt = 1.0 / f64::from(ENGINE_HZ);
        if (dt - engine_dt).abs() > 1e-12 {
            return Err(SessionError::Config(format!(
                "input dt {dt} is not the {ENGINE_HZ} Hz engine step {engine_dt}"
            )));
        }
        let clip_seconds = cfg.clip_seconds.unwrap_or(authored_clip_seconds);
        if !(clip_seconds > 0.0) || !clip_seconds.is_finite() {
            return Err(SessionError::Config(format!(
                "clipSeconds must be a positive finite number, got {clip_seconds}"
            )));
        }
        if let Some(bev) = &cfg.observation.bev {
            if !(bev.resolution_m > 0.0)
                || !(bev.forward_m >= 0.0)
                || !(bev.backward_m >= 0.0)
                || !(bev.half_width_m > 0.0)
            {
                return Err(SessionError::Config("bev geometry must be positive (resolution, halfWidth) and non-negative (forward, backward)".into()));
            }
        }
        if !(cfg.observation.object_list_range_m >= 0.0) {
            return Err(SessionError::Config(
                "objectListRangeM must be non-negative".into(),
            ));
        }
        Ok(Self {
            decision_hz: cfg.decision_hz,
            clip_seconds,
            decision_ticks: (ENGINE_HZ / cfg.decision_hz) as usize,
            dt_decision_s: 1.0 / f64::from(cfg.decision_hz),
            max_decisions: cfg.max_decisions,
            goal: cfg.goal.clone(),
            warmup_excluded: cfg.warmup_excluded,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decision_rate_must_divide_engine_rate() {
        let mut cfg: EpisodeConfig = serde_json::from_str(
            r#"{"decisionHz":7,"observation":{"objectListRangeM":20},"reward":{"progressWeight":0.25}}"#,
        ).unwrap();
        assert!(ResolvedEpisode::resolve(&cfg, 20.0, 0.02).is_err());
        cfg.decision_hz = 25;
        let r = ResolvedEpisode::resolve(&cfg, 20.0, 0.02).unwrap();
        assert_eq!(r.decision_ticks, 2);
        assert_eq!(r.dt_decision_s, 0.04);
        assert_eq!(r.clip_seconds, 20.0);
    }
}
