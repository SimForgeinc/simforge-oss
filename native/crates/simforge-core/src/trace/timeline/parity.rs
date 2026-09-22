//! Renderer parity: observed per-frame actor transforms vs the shared sampler.
//!
//! Any renderer (Bevy `observed-frames.jsonl`, CARLA observed transforms)
//! reports what it actually drew; this compares every observation with
//! `pose(timeline, actorId, t)` at the observation's own `t` and grades the
//! worst error against a tolerance profile. It is the parity gate, not a
//! diagnostic: a failing report fails the render.
//!
//! Observation records (one JSON object per line):
//! `{"t"|"time": <clip s>, "actors": [{"id", "position": [3], "rotation"?: [x,y,z,w],
//!   "headingRad"?, "pitchRad"?, "rollRad"?, "visible"?}]}`
//! Frame conventions ([`ObservedFrameKind`]):
//! - `scene-yup` (Bevy): `position = [x, height, -y]`, `rotation` a y-up
//!   quaternion composed like [`super::sampler::scene_yup`].
//! - `xodr-local` (CARLA after un-flipping, any OSC-frame reporter):
//!   `position = [x, y, z]`, orientation in `headingRad/pitchRad/rollRad`
//!   with OpenSCENARIO signs.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::math::atan2;

use super::sampler::{sample_actor, SampleError};
use super::{wrap_pi, RenderTimeline};

pub const PARITY_REPORT_SCHEMA: &str = "simforge.render-parity/v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ObservedFrameKind {
    SceneYup,
    XodrLocal,
}

/// Which point of the body the observed position names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HeightReference {
    /// Ground-contact origin (the timeline's `z`).
    Ground,
    /// Body centre: `z + h/2`.
    BodyCentre,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParityProfile {
    pub name: String,
    pub position_tolerance_m: f64,
    pub angle_tolerance_deg: f64,
    pub frame: ObservedFrameKind,
    pub height_reference: HeightReference,
    /// Compare pitch/roll too. Off for renderers that apply yaw only.
    pub compare_attitude: bool,
}

impl ParityProfile {
    /// Bevy observed transforms: ≤ 1e-3 m / 0.05° (f32 cast), scene-yup,
    /// ground-contact actor roots.
    pub fn bevy() -> Self {
        Self {
            name: "bevy".to_owned(),
            position_tolerance_m: 1e-3,
            angle_tolerance_deg: 0.05,
            frame: ObservedFrameKind::SceneYup,
            height_reference: HeightReference::Ground,
            compare_attitude: true,
        }
    }

    /// CARLA trace replay: ≤ 1 cm / 0.1° (float32 plus UE units), reported
    /// in the OpenSCENARIO frame by the adapter.
    pub fn carla() -> Self {
        Self {
            name: "carla".to_owned(),
            position_tolerance_m: 0.01,
            angle_tolerance_deg: 0.1,
            frame: ObservedFrameKind::XodrLocal,
            height_reference: HeightReference::Ground,
            compare_attitude: true,
        }
    }

    /// A profile from its JSON form.
    pub fn from_json(text: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(text)
    }

    pub fn named(name: &str) -> Option<Self> {
        match name {
            "bevy" => Some(Self::bevy()),
            "carla" => Some(Self::carla()),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ObservedActor {
    id: String,
    position: [f64; 3],
    #[serde(default)]
    rotation: Option<[f64; 4]>,
    #[serde(default)]
    heading_rad: Option<f64>,
    #[serde(default)]
    pitch_rad: Option<f64>,
    #[serde(default)]
    roll_rad: Option<f64>,
    #[serde(default)]
    visible: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
struct ObservedFrame {
    #[serde(default)]
    t: Option<f64>,
    #[serde(default)]
    time: Option<f64>,
    #[serde(default)]
    actors: Vec<ObservedActor>,
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum ParityError {
    #[error("observed frame {line}: {message}")]
    Record { line: usize, message: String },
    #[error("observed frame {line}: {error}")]
    Sample { line: usize, error: SampleError },
    #[error("no observed frames")]
    Empty,
    #[error("hash: {0}")]
    Hash(String),
}

/// One observation's error against the sampler.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PoseError {
    pub t: f64,
    pub actor_id: String,
    pub position_error_m: f64,
    pub horizontal_error_m: f64,
    pub vertical_error_m: f64,
    pub heading_error_deg: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pitch_error_deg: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub roll_error_deg: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresenceMismatch {
    pub t: f64,
    pub actor_id: String,
    /// `true`: drawn but absent in the timeline; `false`: present in the
    /// timeline but not drawn.
    pub observed: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActorParity {
    pub compared: usize,
    pub max_position_error_m: f64,
    pub max_heading_error_deg: f64,
    pub max_attitude_error_deg: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParityReport {
    pub schema: String,
    pub timeline_sha256: String,
    pub timeline_key: String,
    pub sampler_version: String,
    pub profile: ParityProfile,
    pub frames: usize,
    pub compared_poses: usize,
    pub max_position_error_m: f64,
    pub max_horizontal_error_m: f64,
    pub max_vertical_error_m: f64,
    pub max_heading_error_deg: f64,
    /// `null` when the profile does not compare attitude.
    pub max_pitch_error_deg: Option<f64>,
    pub max_roll_error_deg: Option<f64>,
    pub p95_position_error_m: f64,
    pub p95_heading_error_deg: f64,
    pub presence_mismatches: usize,
    /// First mismatches, in observation order (at most 20).
    pub presence_mismatch_samples: Vec<PresenceMismatch>,
    /// Worst observations by position error, then heading (at most 10).
    pub worst: Vec<PoseError>,
    pub per_actor: BTreeMap<String, ActorParity>,
    pub pass: bool,
}

/// OSC heading/pitch/roll of a y-up quaternion composed as
/// `q_yaw(Y, h) · q_pitch(Z, −p) · q_roll(X, r)` (inverse of `scene_yup`).
pub fn scene_quaternion_to_hpr(q: [f64; 4]) -> (f64, f64, f64) {
    let [x, y, z, w] = q;
    let n = (x * x + y * y + z * z + w * w).sqrt();
    let (x, y, z, w) = if n > 0.0 {
        (x / n, y / n, z / n, w / n)
    } else {
        (0.0, 0.0, 0.0, 1.0)
    };
    let rotate = |v: [f64; 3]| -> [f64; 3] {
        let u = [x, y, z];
        let cross = |a: [f64; 3], b: [f64; 3]| {
            [
                a[1] * b[2] - a[2] * b[1],
                a[2] * b[0] - a[0] * b[2],
                a[0] * b[1] - a[1] * b[0],
            ]
        };
        let t = cross(u, v).map(|c| 2.0 * c);
        let c2 = cross(u, t);
        [
            v[0] + w * t[0] + c2[0],
            v[1] + w * t[1] + c2[1],
            v[2] + w * t[2] + c2[2],
        ]
    };
    let f = rotate([1.0, 0.0, 0.0]);
    let r = rotate([0.0, 0.0, 1.0]);
    let u = rotate([0.0, 1.0, 0.0]);
    let heading = atan2(-f[2], f[0]);
    let pitch = atan2(-f[1], (f[0] * f[0] + f[2] * f[2]).sqrt());
    let roll = atan2(-r[1], u[1]);
    (heading, pitch, roll)
}

fn percentile(mut values: Vec<f64>, p: f64) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    values.sort_by(f64::total_cmp);
    let rank = ((p * values.len() as f64).ceil() as usize).clamp(1, values.len());
    values[rank - 1]
}

/// Compare observed frames (JSONL text) with the timeline.
pub fn compare_observed_jsonl(
    timeline: &RenderTimeline,
    jsonl: &str,
    profile: &ParityProfile,
) -> Result<ParityReport, ParityError> {
    let mut frames = Vec::new();
    for (index, line) in jsonl.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let frame: ObservedFrame = serde_json::from_str(line).map_err(|e| ParityError::Record {
            line: index + 1,
            message: e.to_string(),
        })?;
        frames.push((index + 1, frame));
    }
    if frames.is_empty() {
        return Err(ParityError::Empty);
    }
    let deg = 180.0 / std::f64::consts::PI;
    let mut errors: Vec<PoseError> = Vec::new();
    let mut mismatches: Vec<PresenceMismatch> = Vec::new();
    let mut mismatch_count = 0usize;
    let mut per_actor: BTreeMap<String, ActorParity> = BTreeMap::new();
    for (line, frame) in &frames {
        let t = frame.t.or(frame.time).ok_or_else(|| ParityError::Record {
            line: *line,
            message: "record has neither t nor time".to_owned(),
        })?;
        let mut seen = std::collections::BTreeSet::new();
        for observed in &frame.actors {
            if observed.visible == Some(false) {
                continue;
            }
            seen.insert(observed.id.as_str());
            let Some(actor) = timeline.actor(&observed.id) else {
                continue; // renderer-local bodies (cameras, props) are not graded
            };
            let pose = sample_actor(timeline, actor, t)
                .map_err(|error| ParityError::Sample { line: *line, error })?;
            if !pose.present {
                mismatch_count += 1;
                if mismatches.len() < 20 {
                    mismatches.push(PresenceMismatch {
                        t,
                        actor_id: observed.id.clone(),
                        observed: true,
                    });
                }
                continue;
            }
            let [px, py, pz] = observed.position;
            let (ox, oy, mut oz) = match profile.frame {
                ObservedFrameKind::SceneYup => (px, -pz, py),
                ObservedFrameKind::XodrLocal => (px, py, pz),
            };
            if profile.height_reference == HeightReference::BodyCentre {
                oz -= actor.dims.h / 2.0;
            }
            let (oh, op, or) = match (profile.frame, observed.rotation) {
                (ObservedFrameKind::SceneYup, Some(q)) => scene_quaternion_to_hpr(q),
                _ => (
                    observed.heading_rad.unwrap_or(f64::NAN),
                    observed.pitch_rad.unwrap_or(0.0),
                    observed.roll_rad.unwrap_or(0.0),
                ),
            };
            let horizontal = ((ox - pose.x).powi(2) + (oy - pose.y).powi(2)).sqrt();
            let vertical = (oz - pose.z).abs();
            let position = (horizontal * horizontal + vertical * vertical).sqrt();
            let heading = if oh.is_nan() {
                f64::INFINITY
            } else {
                wrap_pi(oh - pose.heading_rad).abs() * deg
            };
            let (pitch, roll) = if profile.compare_attitude {
                (
                    Some(wrap_pi(op - pose.pitch_rad).abs() * deg),
                    Some(wrap_pi(or - pose.roll_rad).abs() * deg),
                )
            } else {
                (None, None)
            };
            let entry = per_actor.entry(observed.id.clone()).or_default();
            entry.compared += 1;
            entry.max_position_error_m = entry.max_position_error_m.max(position);
            entry.max_heading_error_deg = entry.max_heading_error_deg.max(heading);
            entry.max_attitude_error_deg = entry
                .max_attitude_error_deg
                .max(pitch.unwrap_or(0.0))
                .max(roll.unwrap_or(0.0));
            errors.push(PoseError {
                t,
                actor_id: observed.id.clone(),
                position_error_m: position,
                horizontal_error_m: horizontal,
                vertical_error_m: vertical,
                heading_error_deg: heading,
                pitch_error_deg: pitch,
                roll_error_deg: roll,
            });
        }
        // Present in the timeline but not drawn.
        for actor in &timeline.actors {
            if seen.contains(actor.id.as_str()) {
                continue;
            }
            let pose = sample_actor(timeline, actor, t)
                .map_err(|error| ParityError::Sample { line: *line, error })?;
            if pose.present {
                mismatch_count += 1;
                if mismatches.len() < 20 {
                    mismatches.push(PresenceMismatch {
                        t,
                        actor_id: actor.id.clone(),
                        observed: false,
                    });
                }
            }
        }
    }
    let max = |f: fn(&PoseError) -> f64| errors.iter().map(f).fold(0.0, f64::max);
    let max_opt = |f: fn(&PoseError) -> Option<f64>| {
        profile
            .compare_attitude
            .then(|| errors.iter().filter_map(f).fold(0.0, f64::max))
    };
    let max_position = max(|e| e.position_error_m);
    let max_heading = max(|e| e.heading_error_deg);
    let max_pitch = max_opt(|e| e.pitch_error_deg);
    let max_roll = max_opt(|e| e.roll_error_deg);
    let mut worst = errors.clone();
    worst.sort_by(|a, b| {
        b.position_error_m
            .total_cmp(&a.position_error_m)
            .then(b.heading_error_deg.total_cmp(&a.heading_error_deg))
    });
    worst.truncate(10);
    let angle_ok = max_heading <= profile.angle_tolerance_deg
        && max_pitch.is_none_or(|v| v <= profile.angle_tolerance_deg)
        && max_roll.is_none_or(|v| v <= profile.angle_tolerance_deg);
    let pass = !errors.is_empty()
        && mismatch_count == 0
        && max_position <= profile.position_tolerance_m
        && angle_ok;
    Ok(ParityReport {
        schema: PARITY_REPORT_SCHEMA.to_owned(),
        timeline_sha256: timeline
            .sha256()
            .map_err(|e| ParityError::Hash(e.to_string()))?,
        timeline_key: timeline.identity.timeline_key.clone(),
        sampler_version: timeline.identity.sampler_version.clone(),
        profile: profile.clone(),
        frames: frames.len(),
        compared_poses: errors.len(),
        max_position_error_m: max_position,
        max_horizontal_error_m: max(|e| e.horizontal_error_m),
        max_vertical_error_m: max(|e| e.vertical_error_m),
        max_heading_error_deg: max_heading,
        max_pitch_error_deg: max_pitch,
        max_roll_error_deg: max_roll,
        p95_position_error_m: percentile(errors.iter().map(|e| e.position_error_m).collect(), 0.95),
        p95_heading_error_deg: percentile(
            errors.iter().map(|e| e.heading_error_deg).collect(),
            0.95,
        ),
        presence_mismatches: mismatch_count,
        presence_mismatch_samples: mismatches,
        worst,
        per_actor,
        pass,
    })
}

#[cfg(test)]
mod tests {
    use super::super::sampler::{poses, scene_yup};
    use super::*;

    fn timeline() -> RenderTimeline {
        use std::io::Read;
        let path = format!(
            "{}/../../../examples/edge-cases/04-child-emerging-behind-bus/scenario.trace.json.gz",
            env!("CARGO_MANIFEST_DIR")
        );
        let gz = std::fs::read(path).unwrap();
        let mut json = Vec::new();
        flate2::read::GzDecoder::new(&gz[..])
            .read_to_end(&mut json)
            .unwrap();
        let trace = crate::trace::SimTrace::from_json_slice(&json).unwrap();
        super::super::build_render_timeline(
            &trace,
            &super::super::HeightField::plane(4.0, 0.05, -0.03),
            None,
        )
        .unwrap()
    }

    /// Observations a perfect scene-yup renderer would report.
    fn perfect_scene_yup(tl: &RenderTimeline, times: &[f64], f32_cast: bool) -> String {
        let mut out = String::new();
        for t in times {
            let actors: Vec<serde_json::Value> = poses(tl, *t)
                .unwrap()
                .into_iter()
                .filter(|(_, p)| p.present)
                .map(|(id, p)| {
                    let (mut pos, mut q) = scene_yup(&p, false);
                    if f32_cast {
                        pos = pos.map(|v| v as f32 as f64);
                        q = q.map(|v| v as f32 as f64);
                    }
                    serde_json::json!({"id": id, "position": pos, "rotation": q, "visible": true})
                })
                .collect();
            out.push_str(&serde_json::json!({"time": t, "actors": actors}).to_string());
            out.push('\n');
        }
        out
    }

    #[test]
    fn a_perfect_bevy_replay_passes_within_f32() {
        let tl = timeline();
        let times: Vec<f64> = (0..200).map(|k| k as f64 / 24.0).collect();
        let report = compare_observed_jsonl(
            &tl,
            &perfect_scene_yup(&tl, &times, true),
            &ParityProfile::bevy(),
        )
        .unwrap();
        assert!(report.pass, "{report:#?}");
        assert!(report.compared_poses > 500);
        assert!(report.max_position_error_m < 1e-4);
        assert!(report.max_heading_error_deg < 1e-3);
        assert!(report.max_pitch_error_deg.unwrap() < 1e-3);
    }

    #[test]
    fn a_one_tick_late_label_or_a_raycast_height_fails() {
        let tl = timeline();
        let times: Vec<f64> = (1..200).map(|k| k as f64 / 25.0).collect();
        // Labelled one tick late: poses from t, reported at t + 0.02.
        let late: String = perfect_scene_yup(&tl, &times, false)
            .lines()
            .zip(&times)
            .map(|(line, t)| {
                let mut v: serde_json::Value = serde_json::from_str(line).unwrap();
                v["time"] = serde_json::json!(t + 0.02);
                v.to_string() + "\n"
            })
            .collect();
        let report = compare_observed_jsonl(&tl, &late, &ParityProfile::bevy()).unwrap();
        assert!(!report.pass);
        assert!(report.max_position_error_m > 0.01);
        // A renderer that re-derived height (+5 cm).
        let lifted: String = perfect_scene_yup(&tl, &times, false)
            .lines()
            .map(|line| {
                let mut v: serde_json::Value = serde_json::from_str(line).unwrap();
                for a in v["actors"].as_array_mut().unwrap() {
                    let y = a["position"][1].as_f64().unwrap();
                    a["position"][1] = serde_json::json!(y + 0.05);
                }
                v.to_string() + "\n"
            })
            .collect();
        let report = compare_observed_jsonl(&tl, &lifted, &ParityProfile::bevy()).unwrap();
        assert!(!report.pass);
        assert!((report.max_vertical_error_m - 0.05).abs() < 1e-9);
    }

    #[test]
    fn missing_bodies_are_presence_mismatches() {
        let tl = timeline();
        let text = r#"{"time": 1.0, "actors": []}"#;
        let report = compare_observed_jsonl(&tl, text, &ParityProfile::bevy()).unwrap();
        assert!(!report.pass);
        assert_eq!(report.presence_mismatches, tl.actors.len());
    }

    #[test]
    fn quaternion_round_trips_through_hpr() {
        let tl = timeline();
        let mut p = super::super::sampler::pose(&tl, "bus", 3.0).unwrap();
        p.heading_rad = 2.5;
        p.pitch_rad = 0.03;
        p.roll_rad = -0.02;
        let (_, q) = scene_yup(&p, false);
        let (h, pi, r) = scene_quaternion_to_hpr(q);
        assert!((h - 2.5).abs() < 1e-12);
        assert!((pi - 0.03).abs() < 1e-12);
        assert!((r + 0.02).abs() < 1e-12);
    }

    #[test]
    fn xodr_local_observations_with_body_centre_heights() {
        let tl = timeline();
        let mut profile = ParityProfile::carla();
        profile.height_reference = HeightReference::BodyCentre;
        let mut text = String::new();
        for k in 0..50 {
            let t = k as f64 * 0.1;
            let actors: Vec<serde_json::Value> = poses(&tl, t)
                .unwrap()
                .into_iter()
                .filter(|(_, p)| p.present)
                .map(|(id, p)| {
                    let h = tl.actor(id).unwrap().dims.h;
                    serde_json::json!({"id": id, "position": [p.x + 0.004, p.y, p.z + h / 2.0],
                        "headingRad": p.heading_rad, "pitchRad": p.pitch_rad, "rollRad": p.roll_rad})
                })
                .collect();
            text.push_str(&serde_json::json!({"t": t, "actors": actors}).to_string());
            text.push('\n');
        }
        let report = compare_observed_jsonl(&tl, &text, &profile).unwrap();
        assert!(report.pass, "{report:#?}");
        assert!((report.max_horizontal_error_m - 0.004).abs() < 1e-9);
    }
}
