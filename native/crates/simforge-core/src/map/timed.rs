//! Timed routes: the authored schedule of a drawn route.
//!
//! A `timedPolyline` route says where the body should be at a given absolute
//! time, through its final authored timestamp. Between keyframes the path is a
//! cubic Hermite spline whose tangents are the per-segment velocities (blended
//! at interior waypoints with the harmonic mean of the adjacent speeds so a
//! corner is rounded without skipping the waypoint). Once the last keyframe
//! has passed the actor is released onto a straight freeform runway
//! ([`TimedRoute::released_route`]) so it brakes naturally.
//!
//! Under `dynamic-v1` the schedule is a target, not a teleport: the drawn
//! polyline is the actor's route, so the path tracker steers along it while
//! this sampler supplies the speed the body should be doing — plus a station
//! correction when it lags the schedule. The body therefore drives to its
//! waypoints under tyre and drivetrain limits instead of being placed on
//! them.
//!
//! Keyframes are stored in the engine frame; the scene-frame flip happens once
//! in [`TimedRoute::from_scene_points`].

use serde::{Deserialize, Serialize};

use crate::math::{clamp, local_from_scene, SceneXZ, Vec2};
use crate::types::TimedPoint;

use super::route::Route;

/// Straight-ahead runway used after the final timed position releases to physics.
pub const TIMED_ROUTE_RELEASE_RUNWAY_M: f64 = 2000.0;

/// Samples per segment used by [`TimedRoute::kinematic_extrema`].
const EXTREMA_SAMPLES: usize = 16;

/// One absolute-time keyframe in xodr-local metres.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimedKeyframe {
    pub time_s: f64,
    pub point: Vec2,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TimedSample {
    pub position: Vec2,
    pub heading_rad: f64,
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
}

impl TimedRoute {
    pub fn new(points: Vec<TimedKeyframe>) -> Self {
        Self { points }
    }

    /// From the document's scene-frame keyframes.
    pub fn from_scene_points(points: &[TimedPoint]) -> Self {
        Self {
            points: points
                .iter()
                .map(|p| TimedKeyframe {
                    time_s: p.time_s,
                    point: local_from_scene(SceneXZ { x: p.x, z: p.z }),
                })
                .collect(),
        }
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
    pub fn sample(&self, time_s: f64, fallback_heading_rad: f64) -> TimedSample {
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
    /// two keyframes (nothing moves).
    pub fn kinematic_extrema(&self) -> Option<TimedRouteExtrema> {
        if self.points.len() < 2 {
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
