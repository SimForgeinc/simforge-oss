//! The shared sampler: `pose(timeline, actorId, t)`.
//!
//! Every renderer samples through this function (Rust directly, the editor
//! through the WASM binding, CARLA through the Python binding), so "preview
//! equals render" is a testable statement: the same timeline bytes and the
//! same `t` give bit-identical poses everywhere. Only IEEE-exact arithmetic
//! and the core's portable trig (`crate::math`) are used.
//!
//! Rules (`simforge.timeline-sampler/2`; the sampling rules are unchanged
//! from /1, the derivation rules changed: see `render-timeline.md`):
//! - `t` is clip-relative seconds on `[0, clipEndS]` (±1e-9, clamped).
//! - Tick `i` is the last tick with `t[i] <= t`; `f = (t - t[i]) / (t[i+1] - t[i])`.
//! - Absent strictly before the spawn tick and at or after the despawn tick:
//!   `present[i]` alone decides.
//! - Present at `i` and `i+1`: linear in every channel, heading along the
//!   shortest arc (`h[i] + wrap(h[i+1] - h[i]) * f`, not re-wrapped), pitch and
//!   roll linear. Exact at tick times (`f = 0` returns the stored values).
//! - Present at `i`, absent at `i+1`: hold tick `i` (never interpolate
//!   toward a despawned sample).
//! - `velocity = speed * (cos h, sin h, 0)` at the sampled heading;
//!   `acceleration` is the per-tick backward difference of velocity (zero on
//!   a spawn tick), interpolated like any other channel.
//! - Lights: modes held from their change tick; `flashing` resolves to on
//!   while `(t mod 1 s) < 0.5 s`.

use std::collections::BTreeMap;

use serde::Serialize;

use crate::math::{cos, sin};
use crate::types::ControlIndication;

use super::{body, wrap_pi, LightKind, LightMode, RenderTimeline, TimelineActor, TIMELINE_DT_S};

/// Tolerance on the sampling domain edges.
pub const DOMAIN_EPSILON_S: f64 = 1e-9;

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum SampleError {
    #[error("unknown actor {0:?}")]
    UnknownActor(String),
    #[error("t={t} is outside the timeline [0, {clip_end_s}]")]
    OutOfRange { t: f64, clip_end_s: f64 },
    #[error("t is not finite")]
    NonFinite,
}

/// One sampled pose, xodr-local / OpenSCENARIO world frame.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelinePose {
    pub present: bool,
    /// Floor tick index the sample was taken from.
    pub tick: u32,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub heading_rad: f64,
    pub pitch_rad: f64,
    pub roll_rad: f64,
    pub speed_mps: f64,
    pub velocity: [f64; 3],
    pub acceleration: [f64; 3],
    pub road_pitch_rad: f64,
    pub road_roll_rad: f64,
    pub body_pitch_rad: f64,
    pub body_roll_rad: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wheel_steer_rad: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wheel_spin_rad: Option<f64>,
    /// Four-wheelers: per-wheel drop `[FL, FR, RL, RR]` (suspension travel).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wheel_drop_m: Option<[f64; 4]>,
    /// Knocked off its feet at or before this tick (`downedSinceTick`).
    pub downed: bool,
}

/// Width of [`TimelinePose::to_array`].
pub const POSE_ARRAY_LEN: usize = 20;

impl TimelinePose {
    fn absent(tick: u32) -> Self {
        Self {
            present: false,
            tick,
            x: 0.0,
            y: 0.0,
            z: 0.0,
            heading_rad: 0.0,
            pitch_rad: 0.0,
            roll_rad: 0.0,
            speed_mps: 0.0,
            velocity: [0.0; 3],
            acceleration: [0.0; 3],
            road_pitch_rad: 0.0,
            road_roll_rad: 0.0,
            body_pitch_rad: 0.0,
            body_roll_rad: 0.0,
            wheel_steer_rad: None,
            wheel_spin_rad: None,
            wheel_drop_m: None,
            downed: false,
        }
    }

    /// Flat, binding-neutral encoding (exact f64 bits):
    /// `[present, x, y, z, heading, pitch, roll, speed, vx, vy, vz, ax, ay, az,
    /// roadPitch, roadRoll, bodyPitch, bodyRoll, wheelSteer|NaN, wheelSpin|NaN]`.
    pub fn to_array(&self) -> [f64; POSE_ARRAY_LEN] {
        [
            if self.present { 1.0 } else { 0.0 },
            self.x,
            self.y,
            self.z,
            self.heading_rad,
            self.pitch_rad,
            self.roll_rad,
            self.speed_mps,
            self.velocity[0],
            self.velocity[1],
            self.velocity[2],
            self.acceleration[0],
            self.acceleration[1],
            self.acceleration[2],
            self.road_pitch_rad,
            self.road_roll_rad,
            self.body_pitch_rad,
            self.body_roll_rad,
            self.wheel_steer_rad.unwrap_or(f64::NAN),
            self.wheel_spin_rad.unwrap_or(f64::NAN),
        ]
    }
}

/// Resolved light states at one instant (`flashing` already phased).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LightStates {
    pub low_beam: bool,
    pub brake: bool,
    pub reverse: bool,
    pub indicator_left: bool,
    pub indicator_right: bool,
    pub emergency: bool,
}

/// `(floor tick, fraction)` for `t`, or an error outside the domain.
pub fn locate(timeline: &RenderTimeline, t: f64) -> Result<(usize, f64), SampleError> {
    if !t.is_finite() {
        return Err(SampleError::NonFinite);
    }
    let ts = &timeline.t;
    let first = ts[0];
    let last = ts[ts.len() - 1];
    if t < first - DOMAIN_EPSILON_S || t > last + DOMAIN_EPSILON_S {
        return Err(SampleError::OutOfRange {
            t,
            clip_end_s: last,
        });
    }
    let t = t.clamp(first, last);
    let i = ts.partition_point(|v| *v <= t).saturating_sub(1);
    if i + 1 >= ts.len() {
        return Ok((ts.len() - 1, 0.0));
    }
    Ok((i, (t - ts[i]) / (ts[i + 1] - ts[i])))
}

#[inline]
fn lerp(a: f64, b: f64, f: f64) -> f64 {
    a + (b - a) * f
}

fn velocity_of(speed: f64, heading: f64) -> [f64; 3] {
    [speed * cos(heading), speed * sin(heading), 0.0]
}

fn tick_acceleration(actor: &TimelineActor, i: usize) -> [f64; 3] {
    let tr = &actor.track;
    if i == 0 || tr.present[i] != 1 || tr.present[i - 1] != 1 {
        return [0.0; 3];
    }
    let v1 = velocity_of(tr.speed_mps[i], tr.heading_rad[i]);
    let v0 = velocity_of(tr.speed_mps[i - 1], tr.heading_rad[i - 1]);
    let inv = 1.0 / TIMELINE_DT_S;
    [(v1[0] - v0[0]) * inv, (v1[1] - v0[1]) * inv, 0.0]
}

/// Sample one actor at `t` (clip-relative seconds).
pub fn sample_actor(
    timeline: &RenderTimeline,
    actor: &TimelineActor,
    t: f64,
) -> Result<TimelinePose, SampleError> {
    let (i, f) = locate(timeline, t)?;
    let tr = &actor.track;
    if tr.present[i] != 1 {
        return Ok(TimelinePose::absent(i as u32));
    }
    let next = i + 1 < tr.present.len() && tr.present[i + 1] == 1;
    let (j, f) = if next { (i + 1, f) } else { (i, 0.0) };
    let ch = |c: &Vec<f64>| lerp(c[i], c[j], f);
    let heading = tr.heading_rad[i] + wrap_pi(tr.heading_rad[j] - tr.heading_rad[i]) * f;
    let speed = ch(&tr.speed_mps);
    let a0 = tick_acceleration(actor, i);
    let a1 = if next {
        tick_acceleration(actor, j)
    } else {
        a0
    };
    Ok(TimelinePose {
        present: true,
        tick: i as u32,
        x: ch(&tr.x),
        y: ch(&tr.y),
        z: ch(&tr.z),
        heading_rad: heading,
        pitch_rad: ch(&tr.pitch_rad),
        roll_rad: ch(&tr.roll_rad),
        speed_mps: speed,
        velocity: velocity_of(speed, heading),
        acceleration: [lerp(a0[0], a1[0], f), lerp(a0[1], a1[1], f), 0.0],
        road_pitch_rad: ch(&tr.road_pitch_rad),
        road_roll_rad: ch(&tr.road_roll_rad),
        body_pitch_rad: ch(&tr.body_pitch_rad),
        body_roll_rad: ch(&tr.body_roll_rad),
        wheel_steer_rad: tr.wheel_steer_rad.as_ref().map(ch),
        wheel_spin_rad: tr.wheel_spin_rad.as_ref().map(ch),
        wheel_drop_m: tr
            .wheel_drop_m
            .as_ref()
            .map(|d| std::array::from_fn(|k| lerp(d[i][k], d[j][k], f))),
        downed: actor.downed_since_tick.is_some_and(|d| i >= d as usize),
    })
}

/// `pose(timeline, actorId, t)` — the shared sampler.
pub fn pose(
    timeline: &RenderTimeline,
    actor_id: &str,
    t: f64,
) -> Result<TimelinePose, SampleError> {
    let actor = timeline
        .actor(actor_id)
        .ok_or_else(|| SampleError::UnknownActor(actor_id.to_owned()))?;
    sample_actor(timeline, actor, t)
}

/// Every actor at `t`, sorted by id (absent actors included, `present=false`).
pub fn poses(timeline: &RenderTimeline, t: f64) -> Result<Vec<(&str, TimelinePose)>, SampleError> {
    timeline
        .actors
        .iter()
        .map(|a| sample_actor(timeline, a, t).map(|p| (a.id.as_str(), p)))
        .collect()
}

/// Signal indications held at `t` (tick floor).
pub fn signals_at(
    timeline: &RenderTimeline,
    t: f64,
) -> Result<BTreeMap<String, ControlIndication>, SampleError> {
    let (i, _) = locate(timeline, t)?;
    Ok(timeline
        .signals
        .iter()
        .filter_map(|(id, changes)| {
            let k = changes.partition_point(|c| c.tick as usize <= i);
            (k > 0).then(|| (id.clone(), changes[k - 1].indication))
        })
        .collect())
}

/// Whether a `flashing` light is lit at `t`: 1 s period, 50 % duty, on at 0.
pub fn flash_on(t: f64) -> bool {
    let phase = t - body::FLASH_PERIOD_S * (t / body::FLASH_PERIOD_S).floor();
    phase < body::FLASH_PERIOD_S * body::FLASH_DUTY
}

/// Raw light modes held at `t` (tick floor).
pub fn light_modes_at(
    timeline: &RenderTimeline,
    actor_id: &str,
    t: f64,
) -> Result<BTreeMap<LightKind, LightMode>, SampleError> {
    let actor = timeline
        .actor(actor_id)
        .ok_or_else(|| SampleError::UnknownActor(actor_id.to_owned()))?;
    let (i, _) = locate(timeline, t)?;
    let mut modes: BTreeMap<LightKind, LightMode> = LightKind::ALL
        .iter()
        .map(|k| (*k, LightMode::Off))
        .collect();
    if actor.track.present[i] == 1 {
        for change in actor.lights.iter().take_while(|c| c.tick as usize <= i) {
            modes.insert(change.light, change.mode);
        }
    }
    Ok(modes)
}

/// Light states at `t`, with flashing resolved against the timeline clock.
pub fn lights_at(
    timeline: &RenderTimeline,
    actor_id: &str,
    t: f64,
) -> Result<LightStates, SampleError> {
    let modes = light_modes_at(timeline, actor_id, t)?;
    let lit = |k: LightKind| match modes[&k] {
        LightMode::On => true,
        LightMode::Off => false,
        LightMode::Flashing => flash_on(t),
    };
    Ok(LightStates {
        low_beam: lit(LightKind::LowBeam),
        brake: lit(LightKind::Brake),
        reverse: lit(LightKind::Reverse),
        indicator_left: lit(LightKind::IndicatorLeft),
        indicator_right: lit(LightKind::IndicatorRight),
        emergency: lit(LightKind::Emergency),
    })
}

/* ------------------------------------------------------- scene-state view */

/// Scene-yup (Bevy, scene-state.v1) projection of a sampled pose:
/// `position = [x, z, -y]`, yaw numerically identical, quaternion `[x, y, z, w]`.
/// `yaw_only` drops pitch/roll (renderers that apply yaw only).
pub fn scene_yup(pose: &TimelinePose, yaw_only: bool) -> ([f64; 3], [f64; 4]) {
    let position = [pose.x, pose.z, -pose.y];
    // Scene axes: X = east, Y = up, Z = south; at yaw 0 the body faces +X
    // and its right side is +Z. Nose down (OSC p > 0) turns +X toward -Y:
    // a rotation of -p about local Z. Right side down (OSC r > 0) turns +Z
    // toward -Y: a rotation of +r about local X. Intrinsic yaw-pitch-roll:
    // q = q_yaw(Y, h) * q_pitch(Z, -p) * q_roll(X, r).
    let (h, p, r) = if yaw_only {
        (pose.heading_rad, 0.0, 0.0)
    } else {
        (pose.heading_rad, pose.pitch_rad, pose.roll_rad)
    };
    let (sy, cy) = (sin(h / 2.0), cos(h / 2.0));
    let (sp, cp) = (sin(-p / 2.0), cos(-p / 2.0));
    let (sr, cr) = (sin(r / 2.0), cos(r / 2.0));
    // q_yaw = (0, sy, 0, cy); q_pitch = (0, 0, sp, cp); q_roll = (sr, 0, 0, cr)
    let qyp = quat_mul([0.0, sy, 0.0, cy], [0.0, 0.0, sp, cp]);
    let q = quat_mul(qyp, [sr, 0.0, 0.0, cr]);
    (position, q)
}

fn quat_mul(a: [f64; 4], b: [f64; 4]) -> [f64; 4] {
    let [ax, ay, az, aw] = a;
    let [bx, by, bz, bw] = b;
    [
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
    ]
}

/// A `simforge.scene-state.v1` document sampled from the timeline at
/// `times` (one frame per time, `t` = the time itself): scene-yup positions
/// with the baked height as `y`, rotations from [`scene_yup`] (`yaw_only`
/// drops pitch/roll), velocity = speed × heading, acceleration from the
/// sampler, explicit spawn/update/despawn from presence. `dt` is the mean
/// frame spacing. This is the scene-state projection of the render
/// contract for consumers that read whole documents (scen-play, goldens).
pub fn scene_state_document(
    timeline: &RenderTimeline,
    times: &[f64],
    yaw_only: bool,
) -> Result<super::super::scene_state::SceneState, SampleError> {
    use super::super::scene_state::{
        ActorDesc, ActorTick, ActorTickKind, SceneFrame, SceneState, SCENE_STATE_VERSION,
    };
    let mut previous = vec![false; timeline.actors.len()];
    let mut frames = Vec::with_capacity(times.len());
    for (tick, t) in times.iter().enumerate() {
        let mut actors = Vec::new();
        for (index, actor) in timeline.actors.iter().enumerate() {
            let pose = sample_actor(timeline, actor, *t)?;
            let was = previous[index];
            previous[index] = pose.present;
            let kind = match (pose.present, was) {
                (false, false) => continue,
                (true, false) => ActorTickKind::Spawn,
                (true, true) => ActorTickKind::Update,
                (false, true) => ActorTickKind::Despawn,
            };
            let (position, rotation) = scene_yup(&pose, yaw_only);
            let four_wheeled = pose.wheel_drop_m.is_some();
            actors.push(ActorTick {
                id: actor.id.clone(),
                kind,
                position,
                rotation,
                yaw_rad: pose.heading_rad,
                velocity: [pose.velocity[0], 0.0, -pose.velocity[1]],
                acceleration: [pose.acceleration[0], 0.0, -pose.acceleration[1]],
                wheel_spin_rad: pose.wheel_spin_rad,
                // Four-wheelers only: the sprung body's attitude over its
                // wheels, applied to the model's `body` node (never to the
                // actor transform, which keeps the wheels on the ground).
                body_attitude: (four_wheeled && !yaw_only).then_some(
                    super::super::scene_state::BodyAttitude {
                        pitch_rad: pose.body_pitch_rad,
                        roll_rad: pose.body_roll_rad,
                    },
                ),
                wheel_drop_m: if yaw_only { None } else { pose.wheel_drop_m },
            });
        }
        frames.push(SceneFrame {
            tick: tick as u64,
            t: *t,
            actors,
        });
    }
    let dt = if times.len() > 1 {
        (times[times.len() - 1] - times[0]) / (times.len() - 1) as f64
    } else {
        timeline.dt_s
    };
    Ok(SceneState {
        version: SCENE_STATE_VERSION.to_owned(),
        map_id: timeline.map_id.clone(),
        frame: "scene-yup".to_owned(),
        dt,
        tick_hz: 1.0 / dt,
        tick_count: frames.len() as u64,
        weather: timeline.environment.weather,
        time_of_day: timeline.environment.time_of_day,
        profile: timeline.environment.profile,
        // Heights are baked: consumers must not substitute their own ground.
        ground_y: None,
        actors: timeline
            .actors
            .iter()
            .map(|a| ActorDesc {
                id: a.id.clone(),
                catalog_id: a.catalog_id.clone(),
                actor_class: a.actor_class,
                dims: Some(a.dims),
                color: a.color.clone(),
            })
            .collect(),
        frames,
    })
}
