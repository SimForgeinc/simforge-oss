//! Policy-step execution: trajectory / control actions, declarative deadline
//! enforcement with explicit fallback, and the per-episode executor that turns
//! a [`PolicyAction`] into the engine's [`ActionOverride`].
//!
//! Determinism invariant: nothing here reads a wall clock. Deadline
//! enforcement is *declarative* — the client (or a real-time gateway in front
//! of the host) measures its own inference latency and reports it as
//! `elapsed_ms`; the executor's output is a pure function of its inputs while
//! the reported latency still deterministically selects the fallback action
//! whenever `elapsed_ms > limit_ms`.
//!
//! Fallback semantics on a deadline miss (the supplied action is discarded):
//!
//! - `RepeatLast` — re-apply the last *applied* action of this episode
//!   (policy or fallback); before any applied action it degrades to `Scripted`.
//! - `ZeroControl` — control passthrough of all zeros (coast, wheel centred).
//! - `Scripted` — no override this decision; the authored choreography drives
//!   the ego.
//!
//! Trajectory execution is a host property:
//!
//! - `PurePursuit` (default): the plan is anchored to the world frame at the
//!   pose of the observation this act responds to and tracked by the
//!   session's [`TrajectoryFollower`] until a *different* plan replaces it
//!   (zero-order hold; byte-identical points hold the original anchor).
//! - `SpeedSetpoint`: the target speed is taken from the earliest point with
//!   `t > 0` (falling back to the first point); steering stays with the
//!   authored route logic.

use serde::{Deserialize, Serialize};
use simforge_core::engine::ActionOverride;
use simforge_core::math::Vec2;
use simforge_core::physics::{MotionDirection, VehicleControl};

use crate::error::Result;
use crate::trajectory::{
    anchor_plan_to_world, TrackedPose, TrajectoryFollower, TrajectoryFollowerConfig,
    TrajectoryPlanPoint,
};

/// One trajectory sample in the *ego frame at plan issuance*: x forward along
/// the ego heading, y left (90° CCW), heading relative to the ego yaw
/// (radians), signed speed (m/s, negative = reverse), `t` seconds from
/// issuance. Samples are strictly future (`t > 0`) — the first point is not
/// the current pose.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct TrajectoryPoint {
    pub x: f64,
    pub y: f64,
    pub heading: f64,
    pub speed: f64,
    pub t: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PolicyAction {
    Trajectory {
        points: Vec<TrajectoryPoint>,
    },
    /// Low-level control action, passed through to the vehicle backend.
    Control {
        throttle: f64,
        brake: f64,
        steer: f64,
    },
}

/// The all-zero control fallback (coast, wheel centred).
pub static ZERO_CONTROL: PolicyAction = PolicyAction::Control {
    throttle: 0.0,
    brake: 0.0,
    steer: 0.0,
};

/// Fallback applied when a decision misses its deadline.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FallbackPolicy {
    RepeatLast,
    ZeroControl,
    Scripted,
}

pub const FALLBACK_POLICIES: [FallbackPolicy; 3] = [
    FallbackPolicy::RepeatLast,
    FallbackPolicy::ZeroControl,
    FallbackPolicy::Scripted,
];

/// How a host executes trajectory actions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TrajectoryExecution {
    #[default]
    PurePursuit,
    SpeedSetpoint,
}

/// What actually drove the ego this decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AppliedSource {
    Policy,
    RepeatLast,
    ZeroControl,
    Scripted,
}

/// Per-decision deadline verdict.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeadlineReport {
    /// Effective limit for this decision; `None` = no deadline.
    pub limit_ms: Option<f64>,
    /// Client/gateway-reported inference latency; `None` = unreported.
    pub elapsed_ms: Option<f64>,
    pub miss: bool,
    pub applied: AppliedSource,
}

/// Resolve one decision's deadline verdict and the action to apply. Pure and
/// deterministic. `last_applied` is the last action actually applied this
/// episode (policy or fallback); `None` before the first applied action.
/// Returns the report and the action to apply (`None` = scripted, no override).
pub fn resolve_deadline<'a>(
    action: &'a PolicyAction,
    elapsed_ms: Option<f64>,
    limit_ms: Option<f64>,
    fallback: FallbackPolicy,
    last_applied: Option<&'a PolicyAction>,
) -> (DeadlineReport, Option<&'a PolicyAction>) {
    let miss = matches!((limit_ms, elapsed_ms), (Some(limit), Some(elapsed)) if elapsed > limit);
    if !miss {
        return (
            DeadlineReport {
                limit_ms,
                elapsed_ms,
                miss: false,
                applied: AppliedSource::Policy,
            },
            Some(action),
        );
    }
    let report = |applied| DeadlineReport {
        limit_ms,
        elapsed_ms,
        miss: true,
        applied,
    };
    match fallback {
        FallbackPolicy::ZeroControl => (report(AppliedSource::ZeroControl), Some(&ZERO_CONTROL)),
        FallbackPolicy::Scripted => (report(AppliedSource::Scripted), None),
        FallbackPolicy::RepeatLast => match last_applied {
            None => (report(AppliedSource::Scripted), None),
            Some(last) => (report(AppliedSource::RepeatLast), Some(last)),
        },
    }
}

/// Reduce a policy action to the engine override under `SpeedSetpoint`
/// execution. Control passes through verbatim. A trajectory reduces to a speed
/// setpoint from the earliest strictly-future point; negative setpoint speed
/// flips the motion direction with the magnitude preserved.
pub fn speed_setpoint_override(action: &PolicyAction) -> ActionOverride {
    match action {
        PolicyAction::Control {
            throttle,
            brake,
            steer,
        } => ActionOverride {
            control: Some(VehicleControl {
                throttle: *throttle,
                brake: *brake,
                steer: *steer,
                // A policy step has no parking-brake channel.
                handbrake: false,
            }),
            ..ActionOverride::default()
        },
        PolicyAction::Trajectory { points } => {
            let next = points
                .iter()
                .find(|p| p.t > 0.0)
                .or_else(|| points.first())
                .copied()
                .unwrap_or(TrajectoryPoint {
                    x: 0.0,
                    y: 0.0,
                    heading: 0.0,
                    speed: 0.0,
                    t: 0.0,
                });
            let (speed, dir) = if next.speed < 0.0 {
                (-next.speed, MotionDirection::Reverse)
            } else {
                (next.speed, MotionDirection::Forward)
            };
            ActionOverride {
                target_speed_mps: Some(speed),
                motion_direction: Some(dir),
                ..ActionOverride::default()
            }
        }
    }
}

/// Executor telemetry for one pure-pursuit decision.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutorFrame {
    /// Ego pose the command was computed from (world frame).
    pub x: f64,
    pub y: f64,
    pub heading_rad: f64,
    pub speed_mps: f64,
    /// Signed cross-track error to the anchored plan, +left, metres.
    pub cross_track_error_m: f64,
    /// Along-track arc position, metres.
    pub along_track_m: f64,
    /// Plan age, seconds since issuance.
    pub plan_age_s: f64,
    /// Applied setpoints: speed, feedforward accel, direction.
    pub target_speed_mps: f64,
    pub target_acceleration_mps2: f64,
    pub motion_direction: MotionDirection,
    /// Pure-pursuit preview point + heading (world frame).
    pub preview_point: Vec2,
    pub preview_heading_rad: f64,
}

/// One resolved decision: the override to hold for the decision interval,
/// the deadline verdict, and executor telemetry when pure pursuit ran.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ResolvedDecision {
    /// `None` = scripted: the authored choreography drives the ego.
    pub override_action: Option<ActionOverride>,
    pub deadline: DeadlineReport,
    pub executor: Option<ExecutorFrame>,
}

/// Configuration of one [`PolicyExecutor`] for one episode.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyExecutorConfig {
    pub deadline_ms: Option<f64>,
    pub fallback: FallbackPolicy,
    pub execution: TrajectoryExecution,
    pub follower: TrajectoryFollowerConfig,
}

impl Default for PolicyExecutorConfig {
    fn default() -> Self {
        Self {
            deadline_ms: None,
            fallback: FallbackPolicy::Scripted,
            execution: TrajectoryExecution::PurePursuit,
            follower: TrajectoryFollowerConfig::default(),
        }
    }
}

/// Per-episode policy execution state: deadline policy, last applied action,
/// the opaque recurrent state token and the trajectory follower holding the
/// anchored plan across decisions (ZOH on the plan across 10 Hz acts between
/// slower replans). Serialisable so an episode checkpoint carries it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyExecutor {
    config: PolicyExecutorConfig,
    last_applied: Option<PolicyAction>,
    /// Opaque bytes owned entirely by the policy; echoed back on every act.
    #[serde(with = "serde_bytes_vec")]
    state_token: Vec<u8>,
    follower: TrajectoryFollower,
    /// Ego-frame points of the held plan — byte-equal points keep the anchor.
    held_plan: Option<Vec<TrajectoryPoint>>,
    #[serde(skip)]
    anchored: Vec<TrajectoryPlanPoint>,
}

impl PolicyExecutor {
    pub fn new(config: PolicyExecutorConfig) -> Result<Self> {
        Ok(Self {
            config,
            last_applied: None,
            state_token: Vec::new(),
            follower: TrajectoryFollower::new(config.follower)?,
            held_plan: None,
            anchored: Vec::new(),
        })
    }

    #[inline]
    pub fn config(&self) -> &PolicyExecutorConfig {
        &self.config
    }

    /// Drop per-episode state (last applied action, token, held plan).
    pub fn reset(&mut self) {
        self.last_applied = None;
        self.state_token.clear();
        self.follower.clear();
        self.held_plan = None;
    }

    #[inline]
    pub fn state_token(&self) -> &[u8] {
        &self.state_token
    }

    pub fn set_state_token(&mut self, token: &[u8]) {
        self.state_token.clear();
        self.state_token.extend_from_slice(token);
    }

    #[inline]
    pub fn last_applied(&self) -> Option<&PolicyAction> {
        self.last_applied.as_ref()
    }

    #[inline]
    pub fn follower(&self) -> &TrajectoryFollower {
        &self.follower
    }

    /// Resolve one decision against the pose of the observation it responds
    /// to. `limit_override_ms` is a per-act deadline that supersedes the
    /// episode default when present.
    pub fn decide(
        &mut self,
        action: &PolicyAction,
        elapsed_ms: Option<f64>,
        limit_override_ms: Option<f64>,
        pose: &TrackedPose,
        t_s: f64,
    ) -> Result<ResolvedDecision> {
        let limit_ms = limit_override_ms.or(self.config.deadline_ms);
        let (deadline, apply) = resolve_deadline(
            action,
            elapsed_ms,
            limit_ms,
            self.config.fallback,
            self.last_applied.as_ref(),
        );
        let Some(apply) = apply else {
            return Ok(ResolvedDecision {
                override_action: None,
                deadline,
                executor: None,
            });
        };
        // `apply` may borrow `self.last_applied`; clone before mutating.
        let apply = apply.clone();
        let (override_action, executor) = self.execute(&apply, pose, t_s)?;
        self.last_applied = Some(apply);
        Ok(ResolvedDecision {
            override_action: Some(override_action),
            deadline,
            executor,
        })
    }

    fn execute(
        &mut self,
        action: &PolicyAction,
        pose: &TrackedPose,
        t_s: f64,
    ) -> Result<(ActionOverride, Option<ExecutorFrame>)> {
        let points = match (action, self.config.execution) {
            (PolicyAction::Trajectory { points }, TrajectoryExecution::PurePursuit) => points,
            _ => return Ok((speed_setpoint_override(action), None)),
        };
        let same_plan = self
            .held_plan
            .as_deref()
            .is_some_and(|held| same_points(held, points));
        if !same_plan {
            let mut ego_plan: Vec<TrajectoryPlanPoint> = std::mem::take(&mut self.anchored);
            ego_plan.clear();
            ego_plan.extend(points.iter().map(|p| TrajectoryPlanPoint {
                x: p.x,
                y: p.y,
                heading_rad: p.heading,
                speed_mps: p.speed,
                t_s: p.t,
            }));
            let mut world = Vec::with_capacity(ego_plan.len());
            anchor_plan_to_world(&ego_plan, pose, &mut world);
            self.follower.set_plan(&world, t_s)?;
            self.anchored = ego_plan;
            match &mut self.held_plan {
                Some(held) => {
                    held.clear();
                    held.extend_from_slice(points);
                }
                None => self.held_plan = Some(points.clone()),
            }
        }
        let cmd = self.follower.command(pose, t_s)?;
        let override_action = ActionOverride {
            target_speed_mps: Some(cmd.target_speed_mps),
            target_acceleration_mps2: Some(cmd.target_acceleration_mps2),
            motion_direction: Some(cmd.motion_direction),
            preview_point: Some(cmd.preview_point),
            preview_heading_rad: Some(cmd.preview_heading_rad),
            control: None,
        };
        let frame = ExecutorFrame {
            x: pose.x,
            y: pose.y,
            heading_rad: pose.yaw_rad,
            speed_mps: pose.speed_mps,
            cross_track_error_m: cmd.cross_track_error_m,
            along_track_m: cmd.along_track_m,
            plan_age_s: cmd.plan_age_s,
            target_speed_mps: cmd.target_speed_mps,
            target_acceleration_mps2: cmd.target_acceleration_mps2,
            motion_direction: cmd.motion_direction,
            preview_point: cmd.preview_point,
            preview_heading_rad: cmd.preview_heading_rad,
        };
        Ok((override_action, Some(frame)))
    }
}

/// Bitwise point equality (the wire is exact doubles; NaN never equals).
fn same_points(a: &[TrajectoryPoint], b: &[TrajectoryPoint]) -> bool {
    a.len() == b.len()
        && a.iter().zip(b).all(|(p, q)| {
            p.x == q.x && p.y == q.y && p.heading == q.heading && p.speed == q.speed && p.t == q.t
        })
}

/// `Vec<u8>` as a JSON array of bytes without pulling in `serde_bytes`; the
/// token only crosses the coarse checkpoint boundary.
mod serde_bytes_vec {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub fn serialize<S: Serializer>(v: &Vec<u8>, s: S) -> Result<S::Ok, S::Error> {
        v.serialize(s)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
        Vec::<u8>::deserialize(d)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn traj(speed: f64) -> PolicyAction {
        PolicyAction::Trajectory {
            points: vec![TrajectoryPoint {
                x: 5.0,
                y: 0.0,
                heading: 0.0,
                speed,
                t: 1.0,
            }],
        }
    }

    #[test]
    fn deadline_miss_selects_fallback() {
        let a = traj(3.0);
        let (r, apply) =
            resolve_deadline(&a, Some(60.0), Some(50.0), FallbackPolicy::Scripted, None);
        assert!(r.miss && apply.is_none() && r.applied == AppliedSource::Scripted);
        let (r, apply) = resolve_deadline(
            &a,
            Some(60.0),
            Some(50.0),
            FallbackPolicy::ZeroControl,
            None,
        );
        assert_eq!(apply, Some(&ZERO_CONTROL));
        assert_eq!(r.applied, AppliedSource::ZeroControl);
        let (r, apply) =
            resolve_deadline(&a, Some(60.0), Some(50.0), FallbackPolicy::RepeatLast, None);
        assert!(apply.is_none() && r.applied == AppliedSource::Scripted);
        let last = traj(1.0);
        let (r, apply) = resolve_deadline(
            &a,
            Some(60.0),
            Some(50.0),
            FallbackPolicy::RepeatLast,
            Some(&last),
        );
        assert_eq!(apply, Some(&last));
        assert_eq!(r.applied, AppliedSource::RepeatLast);
        let (r, apply) = resolve_deadline(&a, None, Some(50.0), FallbackPolicy::ZeroControl, None);
        assert!(!r.miss && apply == Some(&a));
    }

    #[test]
    fn speed_setpoint_reduction() {
        let o = speed_setpoint_override(&traj(-4.0));
        assert_eq!(o.target_speed_mps, Some(4.0));
        assert_eq!(o.motion_direction, Some(MotionDirection::Reverse));
        assert!(o.preview_point.is_none());
    }

    #[test]
    fn identical_plan_holds_anchor_and_ages() {
        let mut ex = PolicyExecutor::new(PolicyExecutorConfig::default()).unwrap();
        let pose0 = TrackedPose {
            x: 0.0,
            y: 0.0,
            yaw_rad: 0.0,
            speed_mps: 2.0,
        };
        let plan = PolicyAction::Trajectory {
            points: vec![
                TrajectoryPoint {
                    x: 2.0,
                    y: 0.0,
                    heading: 0.0,
                    speed: 2.0,
                    t: 1.0,
                },
                TrajectoryPoint {
                    x: 4.0,
                    y: 0.0,
                    heading: 0.0,
                    speed: 4.0,
                    t: 2.0,
                },
            ],
        };
        let d0 = ex.decide(&plan, None, None, &pose0, 0.0).unwrap();
        assert!((d0.executor.unwrap().plan_age_s).abs() < 1e-12);
        // Same bytes a decision later from a moved pose: plan age advances, anchor unchanged.
        let pose1 = TrackedPose {
            x: 1.0,
            y: 0.0,
            yaw_rad: 0.0,
            speed_mps: 2.0,
        };
        let d1 = ex.decide(&plan, None, None, &pose1, 0.1).unwrap();
        assert!((d1.executor.unwrap().plan_age_s - 0.1).abs() < 1e-12);
        assert_eq!(ex.follower().plan()[0].x, 2.0);
        // A different plan re-anchors at the new pose.
        let plan2 = PolicyAction::Trajectory {
            points: vec![TrajectoryPoint {
                x: 2.0,
                y: 0.0,
                heading: 0.0,
                speed: 2.0,
                t: 1.0,
            }],
        };
        ex.decide(&plan2, None, None, &pose1, 0.2).unwrap();
        assert_eq!(ex.follower().plan()[0].x, 3.0);
        assert_eq!(ex.follower().plan_start_s(), 0.2);
    }
}
