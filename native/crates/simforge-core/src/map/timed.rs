//! Timed routes: exact absolute-time world keyframes.
//!
//! A `timedPolyline` route hands pose ownership to time rather than cruise
//! speed through its final authored timestamp. Between keyframes the path is a
//! cubic Hermite spline whose tangents are the per-segment velocities (blended
//! at interior waypoints with the harmonic mean of the adjacent speeds so a
//! corner is rounded without skipping the waypoint). Once the last keyframe has
//! passed the actor is released onto a straight freeform runway
//! ([`TimedRoute::released_route`]) so the motion backend can brake naturally.
//!
//! A `recordedTrack` is the same ownership with a different source of truth:
//! every keyframe also carries the body yaw and signed speed the engine itself
//! produced, so replay interpolates the recorded state linearly between ticks
//! instead of re-deriving heading from the path. That is what keeps a
//! stationary or reversing body facing the way it was recorded.
//!
//! Keyframes are stored in the engine frame; the scene-frame flip happens once
//! in [`TimedRoute::from_scene_points`] / [`TimedRoute::from_recorded_samples`].

use serde::{Deserialize, Serialize};

use crate::math::{angle_delta, clamp, local_from_scene, normalize_angle, SceneXZ, Vec2};
use crate::types::{RecordedSample, TimedPoint};

use super::route::Route;

/// Straight-ahead runway used after the final timed position releases to physics.
pub const TIMED_ROUTE_RELEASE_RUNWAY_M: f64 = 2000.0;

/// Samples per segment used by [`TimedRoute::kinematic_extrema`].
const EXTREMA_SAMPLES: usize = 16;

/// Clock slack when deciding whether a replay tick lands on a recorded one.
const RECORDED_TICK_TOLERANCE_S: f64 = 1e-9;

/// One absolute-time keyframe in xodr-local metres.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimedKeyframe {
    pub time_s: f64,
    pub point: Vec2,
}

/// Recorded body state riding on a keyframe of a recorded take.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordedPose {
    /// Body yaw, engine frame (identical to the scene yaw).
    pub heading_rad: f64,
    /// Signed longitudinal speed along the yaw; negative = reversing.
    pub speed_mps: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TimedSample {
    pub position: Vec2,
    pub heading_rad: f64,
    /// Signed along `heading_rad` for a recorded take; never negative for an
    /// authored spline, whose heading already points along the motion.
    pub speed_mps: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TimedKinematics {
    pub position: Vec2,
    pub velocity: Vec2,
    pub acceleration: Vec2,
    pub speed_mps: f64,
    /// `0` when the velocity vanishes.
    pub heading_rad: f64,
}

/// Peak value with the segment (0-based) where it occurs.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct SegmentPeak {
    pub value: f64,
    pub segment: usize,
}

/// Peak demands of a timed route, for feasibility checks against an actor's
/// speed / acceleration envelopes.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct TimedRouteExtrema {
    pub max_speed_mps: SegmentPeak,
    pub max_longitudinal_accel_mps2: SegmentPeak,
    pub max_lateral_accel_mps2: SegmentPeak,
}

/// Immutable keyframe track. At least one keyframe; keyframes are kept in the
/// authored order (the schema requires non-decreasing time).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TimedRoute {
    points: Vec<TimedKeyframe>,
    /// Parallel to `points` for a recorded take; empty for authored keyframes.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    recorded: Vec<RecordedPose>,
}

impl TimedRoute {
    pub fn new(points: Vec<TimedKeyframe>) -> Self {
        Self {
            points,
            recorded: Vec::new(),
        }
    }

    /// From the document's scene-frame keyframes.
    pub fn from_scene_points(points: &[TimedPoint]) -> Self {
        Self::new(
            points
                .iter()
                .map(|p| TimedKeyframe {
                    time_s: p.time_s,
                    point: local_from_scene(SceneXZ { x: p.x, z: p.z }),
                })
                .collect(),
        )
    }

    /// From a take recorded in the scene frame: pose, yaw and signed speed
    /// per tick become the authority for the whole track.
    pub fn from_recorded_samples(samples: &[RecordedSample]) -> Self {
        Self {
            points: samples
                .iter()
                .map(|s| TimedKeyframe {
                    time_s: s.time_s,
                    point: local_from_scene(SceneXZ { x: s.x, z: s.z }),
                })
                .collect(),
            recorded: samples
                .iter()
                .map(|s| RecordedPose {
                    heading_rad: normalize_angle(s.heading_rad),
                    speed_mps: s.speed_mps,
                })
                .collect(),
        }
    }

    /// Whether every keyframe carries recorded yaw and speed.
    #[inline]
    pub fn is_recorded(&self) -> bool {
        !self.recorded.is_empty()
    }

    #[inline]
    pub fn keyframes(&self) -> &[TimedKeyframe] {
        &self.points
    }

    #[inline]
    pub fn len(&self) -> usize {
        self.points.len()
    }

    #[inline]
    pub fn is_empty(&self) -> bool {
        self.points.is_empty()
    }

    /// Time of the final keyframe, after which pose ownership releases.
    pub fn end_time_s(&self) -> Option<f64> {
        self.points.last().map(|p| p.time_s)
    }

    /// Velocity tangent at keyframe `index`.
    fn tangent(&self, index: usize) -> Vec2 {
        let points = &self.points;
        if points.len() <= 1 {
            return Vec2::ZERO;
        }
        let point = points[index];
        if index == 0 {
            let next = points[1];
            let dt = next.time_s - point.time_s;
            return if dt > 0.0 {
                (next.point - point.point) * (1.0 / dt)
            } else {
                Vec2::ZERO
            };
        }
        if index == points.len() - 1 {
            let previous = points[index - 1];
            let dt = point.time_s - previous.time_s;
            return if dt > 0.0 {
                (point.point - previous.point) * (1.0 / dt)
            } else {
                Vec2::ZERO
            };
        }
        let previous = points[index - 1];
        let next = points[index + 1];
        let incoming_dt = point.time_s - previous.time_s;
        let outgoing_dt = next.time_s - point.time_s;
        if incoming_dt <= 0.0 || outgoing_dt <= 0.0 {
            return Vec2::ZERO;
        }
        let incoming = (point.point - previous.point) * (1.0 / incoming_dt);
        let outgoing = (next.point - point.point) * (1.0 / outgoing_dt);
        let incoming_speed = incoming.length();
        let outgoing_speed = outgoing.length();
        if incoming_speed < 1e-9 || outgoing_speed < 1e-9 {
            return Vec2::ZERO;
        }
        let direction = incoming * (1.0 / incoming_speed) + outgoing * (1.0 / outgoing_speed);
        let direction_length = direction.length();
        if direction_length < 1e-6 {
            return Vec2::ZERO;
        }
        // The harmonic mean keeps the tangent below the faster adjacent segment.
        // Averaging unit directions rounds the corner without skipping the waypoint.
        let speed = (2.0 * incoming_speed * outgoing_speed) / (incoming_speed + outgoing_speed);
        direction * (speed / direction_length)
    }

    /// Cubic Hermite state on segment `segment_index` at `fraction ∈ [0, 1]`.
    /// Requires `segment_index + 1 < len()`.
    pub fn segment_kinematics(&self, segment_index: usize, fraction: f64) -> TimedKinematics {
        let from = self.points[segment_index];
        let to = self.points[segment_index + 1];
        let duration_s = to.time_s - from.time_s;
        let u = clamp(fraction, 0.0, 1.0);
        let u2 = u * u;
        let u3 = u2 * u;
        let from_tangent = self.tangent(segment_index) * duration_s;
        let to_tangent = self.tangent(segment_index + 1) * duration_s;
        let h00 = 2.0 * u3 - 3.0 * u2 + 1.0;
        let h10 = u3 - 2.0 * u2 + u;
        let h01 = -2.0 * u3 + 3.0 * u2;
        let h11 = u3 - u2;
        let position = from.point * h00 + from_tangent * h10 + to.point * h01 + to_tangent * h11;
        let (velocity, acceleration) = if duration_s > 0.0 {
            let dh00 = 6.0 * u2 - 6.0 * u;
            let dh10 = 3.0 * u2 - 4.0 * u + 1.0;
            let dh01 = -6.0 * u2 + 6.0 * u;
            let dh11 = 3.0 * u2 - 2.0 * u;
            let ddh00 = 12.0 * u - 6.0;
            let ddh10 = 6.0 * u - 4.0;
            let ddh01 = -12.0 * u + 6.0;
            let ddh11 = 6.0 * u - 2.0;
            (
                (from.point * dh00 + from_tangent * dh10 + to.point * dh01 + to_tangent * dh11)
                    * (1.0 / duration_s),
                (from.point * ddh00 + from_tangent * ddh10 + to.point * ddh01 + to_tangent * ddh11)
                    * (1.0 / (duration_s * duration_s)),
            )
        } else {
            (Vec2::ZERO, Vec2::ZERO)
        };
        let speed_mps = velocity.length();
        TimedKinematics {
            position,
            velocity,
            acceleration,
            speed_mps,
            heading_rad: if speed_mps > 1e-8 {
                velocity.heading()
            } else {
                0.0
            },
        }
    }

    /// Pose at absolute time `time_s`. Before the first keyframe the actor
    /// waits at it facing the second; after the last it rests there facing
    /// along the final segment. `fallback_heading_rad` is used wherever the
    /// path has no direction (single keyframe, coincident points, zero speed).
    /// A recorded take never needs the fallback: its yaw is part of the record.
    pub fn sample(&self, time_s: f64, fallback_heading_rad: f64) -> TimedSample {
        if self.is_recorded() {
            return self.sample_recorded(time_s);
        }
        let points = &self.points;
        if points.len() == 1 {
            return TimedSample {
                position: points[0].point,
                heading_rad: fallback_heading_rad,
                speed_mps: 0.0,
            };
        }
        let first = points[0];
        let last = points[points.len() - 1];
        if time_s < first.time_s {
            let next = points[1];
            return TimedSample {
                position: first.point,
                heading_rad: (next.point - first.point).heading(),
                speed_mps: 0.0,
            };
        }
        if time_s > last.time_s {
            let previous = points[points.len() - 2];
            return TimedSample {
                position: last.point,
                heading_rad: (last.point - previous.point).heading(),
                speed_mps: 0.0,
            };
        }
        let mut next_index = 1;
        while points[next_index].time_s < time_s {
            next_index += 1;
        }
        let segment_index = next_index - 1;
        let from = points[segment_index];
        let to = points[next_index];
        let duration_s = to.time_s - from.time_s;
        // Coincident timestamps snap to the later keyframe instead of dividing by zero.
        let fraction = if duration_s > 0.0 {
            (time_s - from.time_s) / duration_s
        } else {
            1.0
        };
        if (to.point - from.point).length() <= 1e-6 {
            return TimedSample {
                position: from.point,
                heading_rad: fallback_heading_rad,
                speed_mps: 0.0,
            };
        }
        let k = self.segment_kinematics(segment_index, fraction);
        TimedSample {
            position: k.position,
            heading_rad: if k.speed_mps > 1e-8 {
                k.heading_rad
            } else {
                fallback_heading_rad
            },
            speed_mps: k.speed_mps,
        }
    }

    /// Linear interpolation of the recorded state between the two ticks that
    /// bracket `time_s`; heading takes the shortest arc so a wrap across ±π
    /// never spins the body. Outside the take the body rests at its end pose;
    /// on the end samples themselves the recorded speed is reported so the
    /// replayed trace matches the take tick for tick.
    fn sample_recorded(&self, time_s: f64) -> TimedSample {
        let points = &self.points;
        let recorded = &self.recorded;
        let last_index = points.len() - 1;
        let end = |index: usize| TimedSample {
            position: points[index].point,
            heading_rad: recorded[index].heading_rad,
            speed_mps: if (time_s - points[index].time_s).abs() <= RECORDED_TICK_TOLERANCE_S {
                recorded[index].speed_mps
            } else {
                0.0
            },
        };
        if time_s <= points[0].time_s {
            return end(0);
        }
        if time_s >= points[last_index].time_s {
            return end(last_index);
        }
        // First keyframe strictly after `time_s`; times are strictly increasing.
        let next_index = points.partition_point(|k| k.time_s <= time_s);
        let from = points[next_index - 1];
        let to = points[next_index];
        let u = clamp((time_s - from.time_s) / (to.time_s - from.time_s), 0.0, 1.0);
        let from_pose = recorded[next_index - 1];
        let to_pose = recorded[next_index];
        TimedSample {
            position: from.point + (to.point - from.point) * u,
            heading_rad: normalize_angle(
                from_pose.heading_rad + angle_delta(from_pose.heading_rad, to_pose.heading_rad) * u,
            ),
            speed_mps: from_pose.speed_mps + (to_pose.speed_mps - from_pose.speed_mps) * u,
        }
    }

    /// Timed points own pose only through their final timestamp. Once
    /// released, a freeform runway gives the motion backend somewhere to
    /// continue naturally with the terminal speed and heading instead of
    /// treating the last point as a permanent route end.
    pub fn released_route(&self, fallback_heading_rad: f64) -> Route {
        let last = self.points[self.points.len() - 1];
        let previous = self
            .points
            .iter()
            .rev()
            .skip(1)
            .find(|c| (last.point - c.point).length() > 1e-6)
            .copied()
            .or_else(|| self.points.len().checked_sub(2).map(|i| self.points[i]))
            .unwrap_or(last);
        let delta = last.point - previous.point;
        let length = delta.length();
        let direction = if length > 1e-6 {
            delta * (1.0 / length)
        } else {
            Vec2::from_heading(fallback_heading_rad)
        };
        Route::from_polyline([
            last.point,
            last.point + direction * TIMED_ROUTE_RELEASE_RUNWAY_M,
        ])
    }

    /// Peak speed and longitudinal / lateral acceleration demanded by the
    /// spline, sampled 17× per segment. `None` when the route has fewer than
    /// two keyframes (nothing moves) or is a recorded take, whose demands the
    /// engine's own physics already met when it was recorded.
    pub fn kinematic_extrema(&self) -> Option<TimedRouteExtrema> {
        if self.points.len() < 2 || self.is_recorded() {
            return None;
        }
        let mut out = TimedRouteExtrema::default();
        for segment in 0..self.points.len() - 1 {
            for sample in 0..=EXTREMA_SAMPLES {
                let state =
                    self.segment_kinematics(segment, sample as f64 / EXTREMA_SAMPLES as f64);
                if state.speed_mps > out.max_speed_mps.value {
                    out.max_speed_mps = SegmentPeak {
                        value: state.speed_mps,
                        segment,
                    };
                }
                if state.speed_mps < 1e-6 {
                    continue;
                }
                let longitudinal = (state.velocity.dot(state.acceleration) / state.speed_mps).abs();
                let lateral = (state.velocity.cross(state.acceleration) / state.speed_mps).abs();
                if longitudinal > out.max_longitudinal_accel_mps2.value {
                    out.max_longitudinal_accel_mps2 = SegmentPeak {
                        value: longitudinal,
                        segment,
                    };
                }
                if lateral > out.max_lateral_accel_mps2.value {
                    out.max_lateral_accel_mps2 = SegmentPeak {
                        value: lateral,
                        segment,
                    };
                }
            }
        }
        Some(out)
    }
}

#[cfg(test)]
mod tests {
    use std::f64::consts::PI;

    use super::*;
    use crate::math::to_scene_xz;

    fn sample(time_s: f64, x: f64, z: f64, heading_rad: f64, speed_mps: f64) -> RecordedSample {
        RecordedSample {
            time_s,
            x,
            z,
            heading_rad,
            speed_mps,
        }
    }

    #[test]
    fn recorded_take_reports_its_own_ticks_verbatim_and_holds_beyond_the_ends() {
        let route = TimedRoute::from_recorded_samples(&[
            sample(0.0, 1.0, 2.0, 0.3, 4.0),
            sample(0.02, 1.1, 2.0, 0.35, 4.5),
            sample(0.04, 1.2, 2.1, 0.4, 5.0),
        ]);
        assert!(route.is_recorded());
        let mid = route.sample(0.02, 9.0);
        assert_eq!(to_scene_xz(mid.position), SceneXZ { x: 1.1, z: 2.0 });
        assert_eq!(mid.heading_rad, 0.35);
        assert_eq!(mid.speed_mps, 4.5);
        let last = route.sample(0.04, 9.0);
        assert_eq!(last.speed_mps, 5.0);
        assert_eq!(last.heading_rad, 0.4);
        let after = route.sample(1.0, 9.0);
        assert_eq!(after.position, last.position);
        assert_eq!(after.heading_rad, 0.4);
        assert_eq!(after.speed_mps, 0.0);
        let before = route.sample(-5.0, 9.0);
        assert_eq!(to_scene_xz(before.position), SceneXZ { x: 1.0, z: 2.0 });
        assert_eq!(before.heading_rad, 0.3);
        assert_eq!(before.speed_mps, 0.0);
        assert!(route.kinematic_extrema().is_none());
    }

    #[test]
    fn recorded_take_interpolates_between_ticks_on_the_shortest_heading_arc() {
        let route = TimedRoute::from_recorded_samples(&[
            sample(0.0, 0.0, 0.0, PI - 0.1, 1.0),
            sample(1.0, 2.0, 0.0, -PI + 0.1, 3.0),
        ]);
        let half = route.sample(0.5, 0.0);
        assert!(
            (half.heading_rad.abs() - PI).abs() < 1e-9,
            "{}",
            half.heading_rad
        );
        assert!((half.speed_mps - 2.0).abs() < 1e-12);
        assert!((to_scene_xz(half.position).x - 1.0).abs() < 1e-12);
    }

    #[test]
    fn recorded_take_keeps_body_yaw_while_stationary_and_reversing() {
        // Reversing along +x with the nose pointing -x: the yaw is the
        // recorded body yaw, the speed sign says the car is backing up.
        let route = TimedRoute::from_recorded_samples(&[
            sample(0.0, 0.0, 0.0, PI, 0.0),
            sample(1.0, 0.0, 0.0, PI, 0.0),
            sample(2.0, 2.0, 0.0, PI, -2.0),
        ]);
        let still = route.sample(0.5, 0.0);
        assert_eq!(still.heading_rad, normalize_angle(PI));
        assert_eq!(still.speed_mps, 0.0);
        let backing = route.sample(1.5, 0.0);
        assert_eq!(backing.heading_rad, normalize_angle(PI));
        assert!(backing.speed_mps < 0.0);
        assert!(to_scene_xz(backing.position).x > 0.0);
    }

    #[test]
    fn authored_keyframes_are_unchanged_by_the_recorded_channel() {
        let route = TimedRoute::from_scene_points(&[
            TimedPoint {
                time_s: 0.0,
                x: 0.0,
                z: 0.0,
            },
            TimedPoint {
                time_s: 1.0,
                x: 10.0,
                z: 0.0,
            },
        ]);
        assert!(!route.is_recorded());
        assert!(route.kinematic_extrema().is_some());
        let json = serde_json::to_value(&route).unwrap();
        assert!(json.get("recorded").is_none());
    }
}
