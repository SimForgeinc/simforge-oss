//! Trajectory-following executor: pure pursuit + a time-indexed speed profile.
//!
//! Turns a planned trajectory — world-frame samples `{x, y, heading_rad,
//! speed_mps, t_s}` with `t_s` seconds from plan issuance — into per-decision
//! setpoints for the engine's motion backend: a preview point + heading for
//! the bicycle model's pure-pursuit steering and a target speed + feedforward
//! acceleration for its longitudinal controller. The follower never integrates
//! anything itself; the engine's `dynamic-v1` plant is the only plant.
//!
//! The follower holds one plan at a time (zero-order hold): [`set_plan`]
//! replaces it on replan, [`command`] is called once per decision with the
//! live pose. Everything is a pure function of its inputs — no wall clock, no
//! randomness — so the same plan sequence over the same poses yields
//! bit-identical commands.
//!
//! Frame convention (shared with the policy wire): planned trajectories
//! arrive in the *ego frame at plan issuance* — x forward along the ego
//! heading, y left (90° CCW), heading relative to the ego yaw, `t_s` seconds
//! from issuance; the first sample is strictly future (t > 0), not the current
//! pose. [`anchor_plan_to_world`] rebases such a plan onto the world frame at
//! the issuance pose; the follower itself always works in world coordinates.
//!
//! [`set_plan`]: TrajectoryFollower::set_plan
//! [`command`]: TrajectoryFollower::command

use serde::{Deserialize, Serialize};
use simforge_core::math::{
    clamp, cos, hypot, lerp, lerp_angle, normalize_angle, sin, sin_cos, Vec2,
};
use simforge_core::physics::MotionDirection;

use crate::error::{Result, SessionError};

/// One plan sample; world frame after [`anchor_plan_to_world`].
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrajectoryPlanPoint {
    pub x: f64,
    pub y: f64,
    pub heading_rad: f64,
    /// Signed: negative = reverse travel, magnitude = travel speed.
    pub speed_mps: f64,
    /// Seconds from plan issuance.
    pub t_s: f64,
}

/// Planar pose + travel speed of the tracked actor at one decision.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackedPose {
    pub x: f64,
    pub y: f64,
    pub yaw_rad: f64,
    pub speed_mps: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrajectoryFollowerConfig {
    /// Minimum pure-pursuit lookahead, metres.
    pub lookahead_base_m: f64,
    /// Speed-proportional lookahead gain, seconds (`Ld = base + gain·|v|`).
    pub lookahead_gain_s: f64,
    /// Lookahead ceiling, metres.
    pub lookahead_max_m: f64,
}

impl Default for TrajectoryFollowerConfig {
    fn default() -> Self {
        Self {
            lookahead_base_m: 2.5,
            lookahead_gain_s: 0.55,
            lookahead_max_m: 12.0,
        }
    }
}

/// One decision output of the follower.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FollowerCommand {
    /// Travel-speed magnitude setpoint (>= 0).
    pub target_speed_mps: f64,
    /// Feedforward acceleration in the travel frame (slope of the speed profile).
    pub target_acceleration_mps2: f64,
    pub motion_direction: MotionDirection,
    /// Pure-pursuit preview point on the plan polyline, world frame.
    pub preview_point: Vec2,
    pub preview_heading_rad: f64,
    /// Signed lateral offset from the plan polyline; positive = left of the plan.
    pub cross_track_error_m: f64,
    /// Arc position of the pose's projection along the plan, metres.
    pub along_track_m: f64,
    /// Seconds since plan issuance.
    pub plan_age_s: f64,
}

/// Rebase an ego-frame plan (x forward, y left, heading relative, at the
/// issuance pose) onto the world frame, writing into `out` (cleared first) so
/// a policy loop can reuse one buffer. Input order is preserved.
pub fn anchor_plan_to_world(
    points: &[TrajectoryPlanPoint],
    anchor: &TrackedPose,
    out: &mut Vec<TrajectoryPlanPoint>,
) {
    let (sin_yaw, cos_yaw) = sin_cos(anchor.yaw_rad);
    out.clear();
    out.reserve(points.len());
    for p in points {
        out.push(TrajectoryPlanPoint {
            x: anchor.x + p.x * cos_yaw - p.y * sin_yaw,
            y: anchor.y + p.x * sin_yaw + p.y * cos_yaw,
            heading_rad: normalize_angle(anchor.yaw_rad + p.heading_rad),
            speed_mps: p.speed_mps,
            t_s: p.t_s,
        });
    }
}

/// Deterministic trajectory tracker. Hold-and-replace plan semantics; one
/// `command` per decision. Serialisable so an `EnvSession` checkpoint carries
/// the held plan.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrajectoryFollower {
    config: TrajectoryFollowerConfig,
    /// Sorted by `t_s`.
    points: Vec<TrajectoryPlanPoint>,
    /// Cumulative polyline arc length at each plan point, metres.
    arc: Vec<f64>,
    plan_start_s: f64,
}

impl Default for TrajectoryFollower {
    fn default() -> Self {
        Self::new(TrajectoryFollowerConfig::default()).expect("default follower config is valid")
    }
}

impl TrajectoryFollower {
    pub fn new(config: TrajectoryFollowerConfig) -> Result<Self> {
        if !(config.lookahead_base_m > 0.0) {
            return Err(SessionError::Policy(
                "lookaheadBaseM must be positive".into(),
            ));
        }
        if !(config.lookahead_max_m >= config.lookahead_base_m) {
            return Err(SessionError::Policy(
                "lookaheadMaxM must be >= lookaheadBaseM".into(),
            ));
        }
        Ok(Self {
            config,
            points: Vec::new(),
            arc: Vec::new(),
            plan_start_s: 0.0,
        })
    }

    #[inline]
    pub fn has_plan(&self) -> bool {
        !self.points.is_empty()
    }

    /// The held plan, world frame, sorted by `t_s`.
    #[inline]
    pub fn plan(&self) -> &[TrajectoryPlanPoint] {
        &self.points
    }

    #[inline]
    pub fn plan_start_s(&self) -> f64 {
        self.plan_start_s
    }

    pub fn clear(&mut self) {
        self.points.clear();
        self.arc.clear();
        self.plan_start_s = 0.0;
    }

    /// Replace the held plan. `points` are world-frame samples (anchor
    /// ego-frame wire plans with [`anchor_plan_to_world`] first);
    /// `plan_start_s` is the sim time of issuance — the instant the samples'
    /// `t_s` count from. Internal buffers are reused across replans.
    pub fn set_plan(&mut self, points: &[TrajectoryPlanPoint], plan_start_s: f64) -> Result<()> {
        if points.is_empty() {
            return Err(SessionError::Policy(
                "trajectory plan needs at least one point".into(),
            ));
        }
        self.points.clear();
        self.points.extend_from_slice(points);
        // Stable sort by t_s (ECMAScript sort is stable; ties keep input order).
        self.points.sort_by(|a, b| {
            a.t_s
                .partial_cmp(&b.t_s)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        self.arc.clear();
        self.arc.push(0.0);
        for i in 1..self.points.len() {
            let (a, b) = (self.points[i - 1], self.points[i]);
            let prev = self.arc[i - 1];
            self.arc.push(prev + hypot(b.x - a.x, b.y - a.y));
        }
        self.plan_start_s = plan_start_s;
        Ok(())
    }

    /// Track the held plan from `pose` at sim time `t_s`. Errors without a plan.
    pub fn command(&self, pose: &TrackedPose, t_s: f64) -> Result<FollowerCommand> {
        if self.points.is_empty() {
            return Err(SessionError::Policy(
                "command() without a plan; call set_plan() first".into(),
            ));
        }
        let (cross_track_error_m, along_track_m) = self.project(pose);
        let lookahead_m = clamp(
            self.config.lookahead_base_m + self.config.lookahead_gain_s * pose.speed_mps.abs(),
            self.config.lookahead_base_m,
            self.config.lookahead_max_m,
        );
        let (preview_point, preview_heading_rad) = self.at(along_track_m + lookahead_m);
        let plan_age_s = t_s - self.plan_start_s;
        let (speed_mps, slope_mps2) = self.sample_speed(plan_age_s);
        let motion_direction = if speed_mps < 0.0 {
            MotionDirection::Reverse
        } else {
            MotionDirection::Forward
        };
        let sign = if speed_mps < 0.0 { -1.0 } else { 1.0 };
        Ok(FollowerCommand {
            target_speed_mps: speed_mps.abs(),
            target_acceleration_mps2: sign * slope_mps2,
            motion_direction,
            preview_point,
            preview_heading_rad,
            cross_track_error_m,
            along_track_m,
            plan_age_s,
        })
    }

    /// Signed projection of `pose` onto the plan polyline. The first and last
    /// segments project as open-ended rays: plan samples are strictly future,
    /// so right after (re)anchoring the pose sits *behind* the first sample —
    /// the longitudinal gap must not read as lateral error. `along_track_m` is
    /// correspondingly signed (negative = behind the first sample).
    fn project(&self, pose: &TrackedPose) -> (f64, f64) {
        let pts = &self.points;
        let mut first_seg: Option<usize> = None;
        let mut last_seg = 0usize;
        for i in 0..pts.len().saturating_sub(1) {
            if self.arc[i + 1] - self.arc[i] < 1e-9 {
                continue;
            }
            if first_seg.is_none() {
                first_seg = Some(i);
            }
            last_seg = i;
        }
        let Some(first_seg) = first_seg else {
            // Single sample (or all samples coincident): lateral error in the sample's frame.
            let only = pts[0];
            let ct = -(pose.x - only.x) * sin(only.heading_rad)
                + (pose.y - only.y) * cos(only.heading_rad);
            return (ct, 0.0);
        };
        let mut best_d2 = f64::INFINITY;
        let mut best_arc = 0.0;
        let mut best_ct = 0.0;
        for i in first_seg..=last_seg {
            let a = pts[i];
            let b = pts[i + 1];
            let seg_len = self.arc[i + 1] - self.arc[i];
            if seg_len < 1e-9 {
                continue;
            }
            let dx = b.x - a.x;
            let dy = b.y - a.y;
            let t_raw = ((pose.x - a.x) * dx + (pose.y - a.y) * dy) / (seg_len * seg_len);
            let lo = if i == first_seg {
                f64::NEG_INFINITY
            } else {
                0.0
            };
            let hi = if i == last_seg { f64::INFINITY } else { 1.0 };
            let t = clamp(t_raw, lo, hi);
            let cx = a.x + t * dx;
            let cy = a.y + t * dy;
            // Frozen TS: `(pose.x - cx) ** 2 + (pose.y - cy) ** 2`; V8 lowers `** 2` to `x * x`.
            let ex = pose.x - cx;
            let ey = pose.y - cy;
            let d2 = ex * ex + ey * ey;
            if d2 < best_d2 - 1e-12 {
                best_d2 = d2;
                best_arc = self.arc[i] + t * seg_len;
                best_ct = (dx * (pose.y - cy) - dy * (pose.x - cx)) / seg_len;
            }
        }
        (best_ct, best_arc)
    }

    /// Point + heading at arc position `s` along the plan, clamped to its ends.
    fn at(&self, s: f64) -> (Vec2, f64) {
        let pts = &self.points;
        let last = pts[pts.len() - 1];
        let total = self.arc[self.arc.len() - 1];
        if pts.len() == 1 || s >= total {
            return (
                Vec2 {
                    x: last.x,
                    y: last.y,
                },
                last.heading_rad,
            );
        }
        if s <= 0.0 {
            return (
                Vec2 {
                    x: pts[0].x,
                    y: pts[0].y,
                },
                pts[0].heading_rad,
            );
        }
        for i in 0..pts.len() - 1 {
            let seg_len = self.arc[i + 1] - self.arc[i];
            if seg_len < 1e-9 || s > self.arc[i + 1] {
                continue;
            }
            let t = (s - self.arc[i]) / seg_len;
            let a = pts[i];
            let b = pts[i + 1];
            return (
                Vec2 {
                    x: lerp(a.x, b.x, t),
                    y: lerp(a.y, b.y, t),
                },
                lerp_angle(a.heading_rad, b.heading_rad, t),
            );
        }
        (
            Vec2 {
                x: last.x,
                y: last.y,
            },
            last.heading_rad,
        )
    }

    /// Piecewise-linear signed speed profile over plan time, clamped at the ends.
    fn sample_speed(&self, age_s: f64) -> (f64, f64) {
        let pts = &self.points;
        let first = pts[0];
        let last = pts[pts.len() - 1];
        if age_s <= first.t_s || pts.len() == 1 {
            return (first.speed_mps, 0.0);
        }
        if age_s >= last.t_s {
            return (last.speed_mps, 0.0);
        }
        for i in 0..pts.len() - 1 {
            let a = pts[i];
            let b = pts[i + 1];
            if age_s > b.t_s {
                continue;
            }
            let dt = b.t_s - a.t_s;
            if dt < 1e-9 {
                continue;
            }
            let u = (age_s - a.t_s) / dt;
            return (
                lerp(a.speed_mps, b.speed_mps, u),
                (b.speed_mps - a.speed_mps) / dt,
            );
        }
        (last.speed_mps, 0.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn straight_plan() -> Vec<TrajectoryPlanPoint> {
        (1..=5)
            .map(|i| TrajectoryPlanPoint {
                x: i as f64 * 2.0,
                y: 0.0,
                heading_rad: 0.0,
                speed_mps: 5.0 + i as f64,
                t_s: i as f64 * 0.5,
            })
            .collect()
    }

    #[test]
    fn anchoring_rotates_and_translates() {
        let plan = [TrajectoryPlanPoint {
            x: 1.0,
            y: 0.0,
            heading_rad: 0.0,
            speed_mps: 1.0,
            t_s: 0.5,
        }];
        let anchor = TrackedPose {
            x: 10.0,
            y: 5.0,
            yaw_rad: std::f64::consts::FRAC_PI_2,
            speed_mps: 0.0,
        };
        let mut out = Vec::new();
        anchor_plan_to_world(&plan, &anchor, &mut out);
        assert!((out[0].x - 10.0).abs() < 1e-12);
        assert!((out[0].y - 6.0).abs() < 1e-12);
        assert!((out[0].heading_rad - std::f64::consts::FRAC_PI_2).abs() < 1e-12);
    }

    #[test]
    fn behind_first_sample_is_along_track_not_lateral() {
        let mut f = TrajectoryFollower::default();
        f.set_plan(&straight_plan(), 0.0).unwrap();
        let cmd = f
            .command(
                &TrackedPose {
                    x: 0.0,
                    y: 0.0,
                    yaw_rad: 0.0,
                    speed_mps: 0.0,
                },
                0.0,
            )
            .unwrap();
        assert!(cmd.cross_track_error_m.abs() < 1e-12);
        assert!(cmd.along_track_m < 0.0);
        // Before the first sample time: first speed, zero slope.
        assert_eq!(cmd.target_speed_mps, 6.0);
        assert_eq!(cmd.target_acceleration_mps2, 0.0);
        assert_eq!(cmd.motion_direction, MotionDirection::Forward);
    }

    #[test]
    fn speed_profile_interpolates_with_slope() {
        let mut f = TrajectoryFollower::default();
        f.set_plan(&straight_plan(), 1.0).unwrap();
        let cmd = f
            .command(
                &TrackedPose {
                    x: 4.0,
                    y: 0.3,
                    yaw_rad: 0.0,
                    speed_mps: 6.0,
                },
                1.75,
            )
            .unwrap();
        // age 0.75 s sits between t=0.5 (v=6) and t=1.0 (v=7).
        assert!((cmd.target_speed_mps - 6.5).abs() < 1e-12);
        assert!((cmd.target_acceleration_mps2 - 2.0).abs() < 1e-12);
        assert!((cmd.cross_track_error_m - 0.3).abs() < 1e-12);
        assert!((cmd.along_track_m - 2.0).abs() < 1e-12);
    }

    #[test]
    fn reverse_speed_flips_direction_and_feedforward_sign() {
        let plan = [
            TrajectoryPlanPoint {
                x: -1.0,
                y: 0.0,
                heading_rad: 0.0,
                speed_mps: -1.0,
                t_s: 0.5,
            },
            TrajectoryPlanPoint {
                x: -3.0,
                y: 0.0,
                heading_rad: 0.0,
                speed_mps: -3.0,
                t_s: 1.5,
            },
        ];
        let mut f = TrajectoryFollower::default();
        f.set_plan(&plan, 0.0).unwrap();
        let cmd = f
            .command(
                &TrackedPose {
                    x: 0.0,
                    y: 0.0,
                    yaw_rad: 0.0,
                    speed_mps: -1.0,
                },
                1.0,
            )
            .unwrap();
        assert_eq!(cmd.motion_direction, MotionDirection::Reverse);
        assert!((cmd.target_speed_mps - 2.0).abs() < 1e-12);
        assert!((cmd.target_acceleration_mps2 - 2.0).abs() < 1e-12);
    }
}
