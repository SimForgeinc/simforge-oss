//! Pedestrian authoring solvers: the deterministic near-miss solve against an
//! authoritative timed target trajectory, and the shared preview/playback
//! projection of authored pedestrian movements.
//!
//! Plan hashes are FNV-1a 32 over the canonical (sorted-key) JSON of the
//! solution body — a versioned canonicalisation of the historical
//! insertion-order digest.

use serde::{Deserialize, Serialize};

use crate::hash::canonical_json_of;
use crate::math::{atan2, cos, dist, hypot, obb_separation, sin, Obb, Vec2};
use crate::types::{Dims, PassSide, ScenePoint};

/// FNV-1a 32 over the canonical JSON of `value`, lower-hex, 8 digits.
pub fn plan_hash<T: Serialize + ?Sized>(value: &T) -> String {
    let text = canonical_json_of(value).unwrap_or_default();
    let mut h: u32 = 0x811c_9dc5;
    for unit in text.encode_utf16() {
        h ^= unit as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    format!("{h:08x}")
}

#[inline]
fn q(n: f64) -> f64 {
    (n * 1e6).round() / 1e6
}

/* ------------------------------------------------------------- near miss */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NearMissPass {
    Front,
    Behind,
    Auto,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimedTrajectoryPoint {
    pub t: f64,
    pub x: f64,
    pub z: f64,
    /// Optional authoritative heading; segment direction when omitted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub heading_rad: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PedestrianNearMissRequest<'a> {
    pub pedestrian_id: &'a str,
    pub target_id: &'a str,
    pub pedestrian_start: ScenePoint,
    pub pedestrian_dims: Dims,
    /// Canonical preview/playback target trajectory, including turns and stops.
    pub target_trajectory: &'a [TimedTrajectoryPoint],
    pub target_dims: Dims,
    pub trigger_time_s: f64,
    pub deadline_s: f64,
    pub clearance_m: Option<f64>,
    pub pass: NearMissPass,
    pub min_speed_mps: Option<f64>,
    pub max_speed_mps: Option<f64>,
    pub tolerance_m: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PedestrianNearMissIssueCode {
    NearMissInvalidTrajectory,
    NearMissInvalidWindow,
    NearMissInfeasibleSpeed,
    NearMissClearanceUnresolved,
    NearMissWouldCollide,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PedestrianNearMissDiagnostic {
    pub code: PedestrianNearMissIssueCode,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<serde_json::Map<String, serde_json::Value>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PedestrianNearMissSolution {
    pub pedestrian_id: String,
    pub target_id: String,
    pub pass: PassSide,
    pub trigger_time_s: f64,
    pub closest_approach_time_s: f64,
    pub predicted_clearance_m: f64,
    pub requested_clearance_m: f64,
    /// Signed target travel time represented by the front/behind offset.
    pub predicted_time_gap_s: f64,
    pub speed_mps: f64,
    pub heading_rad: f64,
    pub points: [ScenePoint; 3],
    /// Stable digest shared by preview and playback adapters.
    #[serde(default)]
    pub plan_hash: String,
}

struct TrajectoryPose {
    point: Vec2,
    heading_rad: f64,
    speed_mps: f64,
}

fn trajectory_pose(points: &[TimedTrajectoryPoint], t: f64) -> Option<TrajectoryPose> {
    if points.len() < 2 || t < points[0].t || t > points[points.len() - 1].t {
        return None;
    }
    let mut i = 0;
    while i + 1 < points.len() && points[i + 1].t < t {
        i += 1;
    }
    let a = points[i];
    let b = points[(i + 1).min(points.len() - 1)];
    let dt = b.t - a.t;
    let u = if dt <= 1e-9 { 0.0 } else { (t - a.t) / dt };
    let dx = b.x - a.x;
    let dz = b.z - a.z;
    Some(TrajectoryPose {
        point: Vec2 {
            x: a.x + dx * u,
            y: a.z + dz * u,
        },
        heading_rad: a.heading_rad.unwrap_or_else(|| {
            if hypot(dx, dz) > 1e-9 {
                atan2(dz, dx)
            } else {
                b.heading_rad.unwrap_or(0.0)
            }
        }),
        speed_mps: if dt <= 1e-9 { 0.0 } else { hypot(dx, dz) / dt },
    })
}

/// Solve a deterministic pedestrian near miss against an authoritative timed
/// target trajectory. The closest-approach pose has the requested OBB-to-OBB
/// clearance and is rejected rather than relaxed when infeasible.
pub fn solve_pedestrian_near_miss(
    request: &PedestrianNearMissRequest<'_>,
) -> Result<PedestrianNearMissSolution, PedestrianNearMissDiagnostic> {
    let mut trajectory: Vec<TimedTrajectoryPoint> = request.target_trajectory.to_vec();
    trajectory.sort_by(|a, b| a.t.partial_cmp(&b.t).unwrap_or(std::cmp::Ordering::Equal));
    let invalid = trajectory.len() < 2
        || trajectory
            .iter()
            .enumerate()
            .any(|(i, p)| !(p.t + p.x + p.z).is_finite() || (i > 0 && p.t <= trajectory[i - 1].t));
    if invalid {
        return Err(PedestrianNearMissDiagnostic {
            code: PedestrianNearMissIssueCode::NearMissInvalidTrajectory,
            message: "target trajectory must contain strictly increasing finite samples".to_owned(),
            detail: None,
        });
    }
    if !(request.deadline_s > request.trigger_time_s) {
        return Err(PedestrianNearMissDiagnostic {
            code: PedestrianNearMissIssueCode::NearMissInvalidWindow,
            message: "near-miss deadline must be after its trigger".to_owned(),
            detail: None,
        });
    }
    let clearance = request.clearance_m.unwrap_or(0.5);
    let tolerance = request.tolerance_m.unwrap_or(0.02);
    let min_speed = request.min_speed_mps.unwrap_or(0.5);
    let max_speed = request.max_speed_mps.unwrap_or(3.0);
    let passes: &[PassSide] = match request.pass {
        NearMissPass::Front => &[PassSide::Front],
        NearMissPass::Behind => &[PassSide::Behind],
        NearMissPass::Auto => &[PassSide::Front, PassSide::Behind],
    };
    let start_t = (request.trigger_time_s + 0.1).max(trajectory[0].t);
    let end_t = request.deadline_s.min(trajectory[trajectory.len() - 1].t);
    let start = Vec2 {
        x: request.pedestrian_start.x,
        y: request.pedestrian_start.z,
    };
    let mut candidates: Vec<PedestrianNearMissSolution> = Vec::new();

    // A 50 ms grid is exact relative to the engine's 20 Hz contract.
    let mut t = (start_t * 20.0).ceil() / 20.0;
    while t <= end_t + 1e-9 {
        if let Some(target) = trajectory_pose(&trajectory, t) {
            let hx = cos(target.heading_rad);
            let hz = sin(target.heading_rad);
            for &pass in passes {
                let sign = if pass == PassSide::Front { 1.0 } else { -1.0 };
                let mut centre_offset =
                    request.target_dims.l / 2.0 + request.pedestrian_dims.w / 2.0 + clearance;
                let mut closest = Vec2 {
                    x: target.point.x + hx * centre_offset * sign,
                    y: target.point.y + hz * centre_offset * sign,
                };
                let mut ped_heading = atan2(closest.y - start.y, closest.x - start.x);
                for _ in 0..2 {
                    let delta = ped_heading - target.heading_rad;
                    let ped_extent = cos(delta).abs() * request.pedestrian_dims.l / 2.0
                        + sin(delta).abs() * request.pedestrian_dims.w / 2.0;
                    centre_offset = request.target_dims.l / 2.0 + ped_extent + clearance;
                    closest = Vec2 {
                        x: target.point.x + hx * centre_offset * sign,
                        y: target.point.y + hz * centre_offset * sign,
                    };
                    ped_heading = atan2(closest.y - start.y, closest.x - start.x);
                }
                let travel_s = t - request.trigger_time_s;
                let speed = dist(start, closest) / travel_s;
                if speed < min_speed - 1e-9 || speed > max_speed + 1e-9 {
                    continue;
                }
                let ped_obb = Obb {
                    center: closest,
                    length_m: request.pedestrian_dims.l,
                    width_m: request.pedestrian_dims.w,
                    heading_rad: ped_heading,
                };
                let target_obb = Obb {
                    center: target.point,
                    length_m: request.target_dims.l,
                    width_m: request.target_dims.w,
                    heading_rad: target.heading_rad,
                };
                let actual = obb_separation(&ped_obb, &target_obb);
                if actual <= 1e-9 || (actual - clearance).abs() > tolerance {
                    continue;
                }
                let beyond = Vec2 {
                    x: closest.x + cos(ped_heading) * 2.0,
                    y: closest.y + sin(ped_heading) * 2.0,
                };
                let mut solution = PedestrianNearMissSolution {
                    pedestrian_id: request.pedestrian_id.to_owned(),
                    target_id: request.target_id.to_owned(),
                    pass,
                    trigger_time_s: q(request.trigger_time_s),
                    closest_approach_time_s: q(t),
                    predicted_clearance_m: q(actual),
                    requested_clearance_m: q(clearance),
                    predicted_time_gap_s: q(sign * centre_offset / target.speed_mps.max(1e-6)),
                    speed_mps: q(speed),
                    heading_rad: q(ped_heading),
                    points: [
                        request.pedestrian_start,
                        ScenePoint {
                            x: q(closest.x),
                            z: q(closest.y),
                        },
                        ScenePoint {
                            x: q(beyond.x),
                            z: q(beyond.y),
                        },
                    ],
                    plan_hash: String::new(),
                };
                solution.plan_hash = plan_hash(&solution);
                candidates.push(solution);
            }
        }
        t += 0.05;
    }
    candidates.sort_by(|a, b| {
        a.closest_approach_time_s
            .partial_cmp(&b.closest_approach_time_s)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                a.speed_mps
                    .partial_cmp(&b.speed_mps)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .then_with(|| a.pass.as_str().cmp(b.pass.as_str()))
    });
    match candidates.into_iter().next() {
        Some(best) => Ok(best),
        None => {
            let mut detail = serde_json::Map::new();
            detail.insert("minSpeedMps".into(), min_speed.into());
            detail.insert("maxSpeedMps".into(), max_speed.into());
            detail.insert("clearanceM".into(), clearance.into());
            Err(PedestrianNearMissDiagnostic {
                code: PedestrianNearMissIssueCode::NearMissInfeasibleSpeed,
                message:
                    "no collision-free near miss satisfies the time, speed and clearance bounds"
                        .to_owned(),
                detail: Some(detail),
            })
        }
    }
}

/* ------------------------------------------------------------ projection */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PedestrianProjectionSegmentKind {
    Stationary,
    Walking,
    Invalid,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PedestrianProjectionMovement<'a> {
    pub interaction_id: &'a str,
    pub trigger_time_s: Option<f64>,
    pub speed_mps: f64,
    pub points: &'a [ScenePoint],
    pub diagnostic: Option<&'a str>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PedestrianProjectionSegment {
    pub interaction_id: Option<String>,
    pub kind: PedestrianProjectionSegmentKind,
    pub start_time_s: f64,
    pub end_time_s: f64,
    pub points: Vec<ScenePoint>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnostic: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PedestrianTriggerPoint {
    pub interaction_id: String,
    pub time_s: f64,
    pub point: ScenePoint,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PedestrianProjection {
    pub actor_id: String,
    pub segments: Vec<PedestrianProjectionSegment>,
    pub trigger_points: Vec<PedestrianTriggerPoint>,
    pub endpoint: ScenePoint,
    #[serde(default)]
    pub plan_hash: String,
}

/// Shared preview/playback projection for authored pedestrian routes.
pub fn resolve_pedestrian_projection(
    actor_id: &str,
    start: ScenePoint,
    clip_seconds: f64,
    movements: &[PedestrianProjectionMovement<'_>],
) -> PedestrianProjection {
    let mut ordered: Vec<&PedestrianProjectionMovement<'_>> = movements.iter().collect();
    ordered.sort_by(|a, b| {
        let ta = a.trigger_time_s.unwrap_or(f64::INFINITY);
        let tb = b.trigger_time_s.unwrap_or(f64::INFINITY);
        ta.partial_cmp(&tb)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.interaction_id.cmp(b.interaction_id))
    });
    let mut point = start;
    let mut time = 0.0;
    let mut segments = Vec::new();
    let mut trigger_points = Vec::new();
    for movement in ordered {
        let Some(trigger_time) = movement.trigger_time_s else {
            segments.push(invalid_segment(movement, time, point));
            continue;
        };
        if movement.points.len() < 2 || movement.speed_mps <= 0.0 {
            segments.push(invalid_segment(movement, time, point));
            continue;
        }
        let trigger = time.max(trigger_time);
        if trigger > time {
            segments.push(PedestrianProjectionSegment {
                interaction_id: None,
                kind: PedestrianProjectionSegmentKind::Stationary,
                start_time_s: time,
                end_time_s: trigger,
                points: vec![point, point],
                diagnostic: None,
            });
        }
        let mut points: Vec<ScenePoint> = Vec::with_capacity(movement.points.len());
        points.push(point);
        points.extend_from_slice(&movement.points[1..]);
        let mut length = 0.0;
        for i in 1..points.len() {
            length += hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
        }
        let end = clip_seconds.min(trigger + length / movement.speed_mps);
        let last = points[points.len() - 1];
        segments.push(PedestrianProjectionSegment {
            interaction_id: Some(movement.interaction_id.to_owned()),
            kind: PedestrianProjectionSegmentKind::Walking,
            start_time_s: trigger,
            end_time_s: end,
            points,
            diagnostic: None,
        });
        trigger_points.push(PedestrianTriggerPoint {
            interaction_id: movement.interaction_id.to_owned(),
            time_s: trigger,
            point,
        });
        point = last;
        time = end;
    }
    if time < clip_seconds {
        segments.push(PedestrianProjectionSegment {
            interaction_id: None,
            kind: PedestrianProjectionSegmentKind::Stationary,
            start_time_s: time,
            end_time_s: clip_seconds,
            points: vec![point, point],
            diagnostic: None,
        });
    }
    let mut projection = PedestrianProjection {
        actor_id: actor_id.to_owned(),
        segments,
        trigger_points,
        endpoint: point,
        plan_hash: String::new(),
    };
    projection.plan_hash = plan_hash(&projection);
    projection
}

fn invalid_segment(
    movement: &PedestrianProjectionMovement<'_>,
    time: f64,
    point: ScenePoint,
) -> PedestrianProjectionSegment {
    PedestrianProjectionSegment {
        interaction_id: Some(movement.interaction_id.to_owned()),
        kind: PedestrianProjectionSegmentKind::Invalid,
        start_time_s: time,
        end_time_s: time,
        points: vec![point],
        diagnostic: Some(
            movement
                .diagnostic
                .unwrap_or("unresolved pedestrian movement")
                .to_owned(),
        ),
    }
}
