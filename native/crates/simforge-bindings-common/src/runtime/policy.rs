//! Deadline-accounted policy execution over an [`Env`].
//!
//! The executor resolves control or ego-frame trajectory actions against the
//! pose of the observation they answer, applies the fallback on a missed
//! deadline, and steps the same session — one plant, no second controller.

use simforge_session::{
    DeadlineReport, ExecutorFrame, FallbackPolicy, PolicyAction, PolicyExecutor,
    PolicyExecutorConfig, TrackedPose, TrajectoryExecution, TrajectoryPoint,
};

use super::env::{Env, StepView};
use super::{decode_checkpoint, encode_checkpoint};
use crate::error::{BindingError, Result};

/// One resolved decision: the step it produced plus the deadline verdict.
pub struct PolicyOutcome<'a> {
    pub step: StepView<'a>,
    pub deadline: DeadlineReport,
    pub executor: Option<ExecutorFrame>,
}

impl PolicyOutcome<'_> {
    pub fn applied_str(&self) -> &'static str {
        match self.deadline.applied {
            simforge_session::AppliedSource::Policy => "policy",
            simforge_session::AppliedSource::RepeatLast => "repeat-last",
            simforge_session::AppliedSource::ZeroControl => "zero-control",
            simforge_session::AppliedSource::Scripted => "scripted",
        }
    }
    pub fn executor_json(&self) -> Result<Option<String>> {
        self.executor
            .as_ref()
            .map(|f| serde_json::to_string(f).map_err(Into::into))
            .transpose()
    }
}

pub struct Policy {
    executor: PolicyExecutor,
    points: Vec<TrajectoryPoint>,
}

pub fn parse_fallback(name: &str) -> Result<FallbackPolicy> {
    match name {
        "repeat-last" => Ok(FallbackPolicy::RepeatLast),
        "zero-control" => Ok(FallbackPolicy::ZeroControl),
        "scripted" => Ok(FallbackPolicy::Scripted),
        other => Err(BindingError::argument(format!(
            "unknown fallback {other:?}; expected repeat-last, zero-control or scripted"
        ))),
    }
}

pub fn parse_execution(name: &str) -> Result<TrajectoryExecution> {
    match name {
        "pure-pursuit" => Ok(TrajectoryExecution::PurePursuit),
        "speed-setpoint" => Ok(TrajectoryExecution::SpeedSetpoint),
        other => Err(BindingError::argument(format!(
            "unknown execution {other:?}; expected pure-pursuit or speed-setpoint"
        ))),
    }
}

impl Policy {
    pub fn new(deadline_ms: Option<f64>, fallback: &str, execution: &str) -> Result<Self> {
        if let Some(limit) = deadline_ms {
            if !(limit > 0.0) {
                return Err(BindingError::argument("deadline_ms must be positive"));
            }
        }
        let config = PolicyExecutorConfig {
            deadline_ms,
            fallback: parse_fallback(fallback)?,
            execution: parse_execution(execution)?,
            ..PolicyExecutorConfig::default()
        };
        Ok(Self {
            executor: PolicyExecutor::new(config)?,
            points: Vec::new(),
        })
    }

    pub fn execution_str(&self) -> &'static str {
        match self.executor.config().execution {
            TrajectoryExecution::PurePursuit => "pure-pursuit",
            TrajectoryExecution::SpeedSetpoint => "speed-setpoint",
        }
    }

    /// Reset the episode and the executor's per-episode state together.
    pub fn reset<'e>(
        &mut self,
        env: &'e mut Env,
        seed: Option<simforge_core::rng::Seed>,
    ) -> Result<StepView<'e>> {
        self.executor.reset();
        env.reset(seed)
    }

    pub fn act_control<'e>(
        &mut self,
        env: &'e mut Env,
        throttle: f64,
        brake: f64,
        steer: f64,
        elapsed_ms: Option<f64>,
    ) -> Result<PolicyOutcome<'e>> {
        let action = PolicyAction::Control {
            throttle,
            brake,
            steer,
        };
        self.act(env, &action, elapsed_ms)
    }

    /// `points` is `(K, 5)` row-major `[x, y, heading_rad, speed_mps, t_s]` in
    /// the ego frame at issuance.
    pub fn act_trajectory<'e>(
        &mut self,
        env: &'e mut Env,
        points: &[f64],
        elapsed_ms: Option<f64>,
    ) -> Result<PolicyOutcome<'e>> {
        if points.is_empty() || points.len() % 5 != 0 {
            return Err(BindingError::argument(format!(
                "trajectory must be (K, 5) with K >= 1, got {} values",
                points.len()
            )));
        }
        self.points.clear();
        for p in points.chunks_exact(5) {
            if p.iter().any(|v| !v.is_finite()) {
                return Err(BindingError::argument("trajectory points must be finite"));
            }
            self.points.push(TrajectoryPoint {
                x: p[0],
                y: p[1],
                heading: p[2],
                speed: p[3],
                t: p[4],
            });
        }
        let action = PolicyAction::Trajectory {
            points: std::mem::take(&mut self.points),
        };
        let outcome = self.act(env, &action, elapsed_ms);
        if let PolicyAction::Trajectory { points } = action {
            self.points = points;
        }
        outcome
    }

    /// Episode checkpoint carrying the executor state (last applied action,
    /// held plan, anchor) beside the env's continuation state.
    pub fn checkpoint(&self, env: &Env) -> Result<Vec<u8>> {
        #[derive(serde::Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Bundle<'a> {
            env: &'a simforge_session::EnvCheckpoint,
            executor: &'a PolicyExecutor,
        }
        let env_checkpoint = env.session().checkpoint()?;
        encode_checkpoint(&Bundle {
            env: &env_checkpoint,
            executor: &self.executor,
        })
    }

    /// Restore a checkpoint taken with [`Policy::checkpoint`]; returns the checkpointed decision's result.
    pub fn restore<'e>(&mut self, env: &'e mut Env, bytes: &[u8]) -> Result<StepView<'e>> {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Bundle {
            env: simforge_session::EnvCheckpoint,
            executor: PolicyExecutor,
        }
        let bundle: Bundle = decode_checkpoint(bytes)?;
        if bundle.executor.config() != self.executor.config() {
            return Err(BindingError::argument(
                "policy checkpoint was taken with a different executor configuration",
            ));
        }
        self.executor = bundle.executor;
        env.restore_checkpoint(&bundle.env)
    }

    fn act<'e>(
        &mut self,
        env: &'e mut Env,
        action: &PolicyAction,
        elapsed_ms: Option<f64>,
    ) -> Result<PolicyOutcome<'e>> {
        let [t_s, x, y, yaw_rad, speed_mps] = env.ego_pose()?;
        let pose = TrackedPose {
            x,
            y,
            yaw_rad,
            speed_mps,
        };
        let decision = self.executor.decide(action, elapsed_ms, None, &pose, t_s)?;
        let step = env.step_override(decision.override_action)?;
        Ok(PolicyOutcome {
            step,
            deadline: decision.deadline,
            executor: decision.executor,
        })
    }
}
