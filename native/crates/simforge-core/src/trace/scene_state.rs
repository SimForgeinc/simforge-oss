//! `simforge.scene-state.v1` — the one scene description both native-renderer
//! ingestion modes consume: emitted from a finished [`SimTrace`] for
//! playback, or per tick by [`SceneStateStream`] for closed-loop live mode.
//!
//! Coordinate frame: y-up **scene** frame — `position = [x, groundY, z]` with
//! `x/z = to_scene_xz(trace xodr-local x/y)` and headings numerically
//! identical. Actor origins are on the ground plane at the actor's centre;
//! `groundY` carries the renderer's road-surface elevation because traces
//! have no height channel.
//!
//! Deterministic: same trace → same document (sorted actor ids, fixed
//! six-decimal quantisation).

use serde::{Deserialize, Serialize};

use crate::math::{cos, quantize, sin, Vec2};
use crate::types::{
    ActorKind, Dims, OperationalConditions, TimeOfDay, Weather as ConditionWeather,
};

use super::SimTrace;

/// The only version renderers accept.
pub const SCENE_STATE_VERSION: &str = "simforge.scene-state.v1";
const PRECISION: i32 = 6;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RenderProfile {
    Sensor,
    Cinematic,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WeatherPreset {
    Clear,
    Fog,
    Rain,
    Night,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Weather {
    pub preset: WeatherPreset,
    pub fog_density: f64,
    pub rain_intensity: f64,
    /// Road wetness fraction for reflectance ramp.
    pub wetness: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ActorClass {
    Car,
    Truck,
    Bus,
    Motorcycle,
    Bicycle,
    Pedestrian,
    Prop,
}

/// Static per-actor description: identity + geometry binding, never per-tick.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActorDesc {
    pub id: String,
    /// prop-catalog entry used for mesh selection (`vehicle.sedan`, …).
    pub catalog_id: String,
    pub actor_class: ActorClass,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dims: Option<Dims>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

/// `spawn` on the first present tick, `despawn` on the first absent tick
/// after presence; consumers never infer from presence gaps.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ActorTickKind {
    Spawn,
    Update,
    Despawn,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActorTick {
    pub id: String,
    pub kind: ActorTickKind,
    pub position: [f64; 3],
    /// Y-up quaternion `[x, y, z, w]`.
    pub rotation: [f64; 4],
    /// Yaw in radians, CCW from +X about +Y; redundant with rotation, exact.
    pub yaw_rad: f64,
    /// World-frame linear velocity m/s `[vx, vy, vz]`.
    pub velocity: [f64; 3],
    /// Backward finite difference of the velocity channel (carries the
    /// centripetal term when a body turns); zero on spawn.
    pub acceleration: [f64; 3],
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SceneFrame {
    pub tick: u64,
    /// Seconds since clip start.
    pub t: f64,
    pub actors: Vec<ActorTick>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneState {
    pub version: String,
    pub map_id: String,
    pub frame: String,
    pub dt: f64,
    pub tick_hz: f64,
    pub tick_count: u64,
    pub weather: Weather,
    /// Hour of day [0, 24).
    pub time_of_day: f64,
    pub profile: RenderProfile,
    /// Road-surface elevation hint; null when the consumer must resolve it.
    pub ground_y: Option<f64>,
    pub actors: Vec<ActorDesc>,
    pub frames: Vec<SceneFrame>,
}

/// Yaw about +Y → y-up quaternion `[x, y, z, w]`.
pub fn yaw_to_quaternion(yaw: f64) -> [f64; 4] {
    [0.0, sin(yaw / 2.0), 0.0, cos(yaw / 2.0)]
}

pub fn actor_class_of(kind: ActorKind) -> ActorClass {
    match kind {
        ActorKind::Truck => ActorClass::Truck,
        ActorKind::Bus => ActorClass::Bus,
        ActorKind::Motorcycle => ActorClass::Motorcycle,
        ActorKind::Bicycle => ActorClass::Bicycle,
        ActorKind::Pedestrian => ActorClass::Pedestrian,
        ActorKind::StaticObject => ActorClass::Prop,
        ActorKind::Vehicle
        | ActorKind::Car
        | ActorKind::Van
        | ActorKind::Scooter
        | ActorKind::SidewalkRobot
        | ActorKind::Drone
        | ActorKind::Animal => ActorClass::Car,
    }
}

/// Catalog binding: a `catalog:<id>` tag wins; otherwise a deterministic
/// class default keeps browser and native consistent.
pub fn catalog_id_for(kind: ActorKind, tags: &[String]) -> String {
    if let Some(tag) = tags.iter().find_map(|t| t.strip_prefix("catalog:")) {
        return tag.to_owned();
    }
    match kind {
        ActorKind::Pedestrian => "pedestrian.adult",
        ActorKind::Bicycle => "cyclist.commuter",
        ActorKind::Bus => "vehicle.transit-bus",
        ActorKind::Truck => "vehicle.box-truck",
        ActorKind::Motorcycle => "vehicle.motorcycle",
        ActorKind::StaticObject => "hazard.cardboard_box",
        _ => "vehicle.sedan",
    }
    .to_owned()
}

/// Weather ladder and hour of day from the executed operational conditions.
pub fn weather_from(conditions: &OperationalConditions) -> (Weather, f64) {
    let preset = match (conditions.time_of_day, conditions.weather) {
        (TimeOfDay::Night, _) => WeatherPreset::Night,
        (_, ConditionWeather::Rain) => WeatherPreset::Rain,
        (_, ConditionWeather::Overcast) => WeatherPreset::Fog,
        (_, ConditionWeather::Clear) => WeatherPreset::Clear,
    };
    let time_of_day = match conditions.time_of_day {
        TimeOfDay::Night => 2.0,
        TimeOfDay::Dusk => 19.5,
        TimeOfDay::Dawn => 6.0,
        TimeOfDay::Day => 12.0,
    };
    let weather = Weather {
        preset,
        fog_density: match preset {
            WeatherPreset::Fog => 0.35,
            WeatherPreset::Night => 0.05,
            _ => 0.0,
        },
        rain_intensity: if preset == WeatherPreset::Rain {
            0.7
        } else {
            0.0
        },
        wetness: if preset == WeatherPreset::Rain {
            0.8
        } else {
            0.0
        },
    };
    (weather, time_of_day)
}

/// One actor's observable state on a live tick.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LiveActorSample<'a> {
    pub id: &'a str,
    pub present: bool,
    pub position: Vec2,
    pub heading_rad: f64,
    pub speed_mps: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct StreamActorState {
    id: String,
    present: bool,
    velocity: [f64; 3],
}

/// Per-tick scene-state frame emitter keeping only the previous presence and
/// velocity per actor (bounded state). Spawn/despawn derive from presence
/// transitions; a re-entering body never inherits velocity history.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SceneStateStream {
    dt: f64,
    /// Sorted by id.
    actors: Vec<StreamActorState>,
}

impl SceneStateStream {
    pub fn new(dt: f64) -> Self {
        Self {
            dt,
            actors: Vec::new(),
        }
    }

    pub fn dt(&self) -> f64 {
        self.dt
    }

    /// Forget every actor: the next frame emits fresh `spawn`s.
    pub fn clear(&mut self) {
        self.actors.clear();
    }

    /// Emit one frame. Actor order in the frame is sorted by id regardless
    /// of the input order.
    pub fn frame<'a>(
        &mut self,
        tick: u64,
        t: f64,
        actors: impl IntoIterator<Item = LiveActorSample<'a>>,
    ) -> SceneFrame {
        let mut records: Vec<ActorTick> = Vec::new();
        for sample in actors {
            let index = match self
                .actors
                .binary_search_by(|a| a.id.as_str().cmp(sample.id))
            {
                Ok(i) => i,
                Err(i) => {
                    self.actors.insert(
                        i,
                        StreamActorState {
                            id: sample.id.to_owned(),
                            present: false,
                            velocity: [0.0; 3],
                        },
                    );
                    i
                }
            };
            let state = &mut self.actors[index];
            let was = state.present;
            state.present = sample.present;
            let kind = match (sample.present, was) {
                (false, false) => continue,
                (true, false) => ActorTickKind::Spawn,
                (false, true) => ActorTickKind::Despawn,
                (true, true) => ActorTickKind::Update,
            };
            let prev = (kind == ActorTickKind::Update).then_some(state.velocity);
            let record = actor_tick(
                sample.id,
                kind,
                sample.position,
                sample.heading_rad,
                sample.speed_mps,
                prev,
                self.dt,
            );
            state.velocity = raw_velocity(sample.heading_rad, sample.speed_mps);
            records.push(record);
        }
        records.sort_by(|a, b| a.id.cmp(&b.id));
        SceneFrame {
            tick,
            t: quantize(t, PRECISION),
            actors: records,
        }
    }
}

fn raw_velocity(heading_rad: f64, speed_mps: f64) -> [f64; 3] {
    [
        speed_mps * cos(heading_rad),
        0.0,
        -speed_mps * sin(heading_rad),
    ]
}

fn actor_tick(
    id: &str,
    kind: ActorTickKind,
    position: Vec2,
    heading_rad: f64,
    speed_mps: f64,
    prev_velocity: Option<[f64; 3]>,
    dt: f64,
) -> ActorTick {
    let velocity = raw_velocity(heading_rad, speed_mps);
    let acceleration = match prev_velocity {
        Some(prev) => {
            let inv_dt = 1.0 / dt;
            [
                (velocity[0] - prev[0]) * inv_dt,
                0.0,
                (velocity[2] - prev[2]) * inv_dt,
            ]
        }
        None => [0.0; 3],
    };
    let q = yaw_to_quaternion(heading_rad);
    ActorTick {
        id: id.to_owned(),
        kind,
        position: [
            quantize(position.x, PRECISION),
            0.0,
            quantize(-position.y, PRECISION),
        ],
        rotation: [
            quantize(q[0], PRECISION),
            quantize(q[1], PRECISION),
            quantize(q[2], PRECISION),
            quantize(q[3], PRECISION),
        ],
        yaw_rad: quantize(heading_rad, PRECISION),
        velocity: [
            quantize(velocity[0], PRECISION),
            0.0,
            quantize(velocity[2], PRECISION),
        ],
        acceleration: [
            quantize(acceleration[0], PRECISION),
            0.0,
            quantize(acceleration[2], PRECISION),
        ],
    }
}

/// Emit the per-tick scene-state document from a finished trace.
pub fn emit_scene_state(trace: &SimTrace) -> SceneState {
    let header = &trace.header;
    let (weather, time_of_day) = weather_from(&header.operational_conditions);
    let actors: Vec<ActorDesc> = trace
        .ticks
        .actors
        .keys()
        .map(|id| {
            let meta = &header.actor_metadata[id];
            ActorDesc {
                id: id.clone(),
                catalog_id: catalog_id_for(meta.kind, &meta.tags),
                actor_class: actor_class_of(meta.kind),
                dims: Some(meta.dims),
                color: meta
                    .tags
                    .iter()
                    .find_map(|t| t.strip_prefix("color:"))
                    .map(str::to_owned),
            }
        })
        .collect();

    let mut stream = SceneStateStream::new(header.dt);
    let frames = trace
        .ticks
        .t
        .iter()
        .enumerate()
        .map(|(i, t)| {
            stream.frame(
                i as u64,
                *t,
                trace
                    .ticks
                    .actors
                    .iter()
                    .map(|(id, track)| LiveActorSample {
                        id,
                        present: track.is_present(i),
                        position: Vec2::new(track.x[i], track.y[i]),
                        heading_rad: track.heading_rad[i],
                        speed_mps: track.speed_mps[i],
                    }),
            )
        })
        .collect::<Vec<_>>();

    SceneState {
        version: SCENE_STATE_VERSION.to_owned(),
        map_id: header.map_id.clone(),
        frame: "scene-yup".to_owned(),
        dt: header.dt,
        tick_hz: quantize(1.0 / header.dt, PRECISION),
        tick_count: frames.len() as u64,
        weather,
        time_of_day,
        profile: RenderProfile::Sensor,
        ground_y: None,
        actors,
        frames,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presence_transitions_drive_spawn_update_despawn_and_reset_acceleration() {
        let mut stream = SceneStateStream::new(0.1);
        let sample = |present, speed| LiveActorSample {
            id: "a",
            present,
            position: Vec2::new(1.0, 2.0),
            heading_rad: 0.0,
            speed_mps: speed,
        };
        let f0 = stream.frame(0, 0.0, [sample(false, 0.0)]);
        assert!(f0.actors.is_empty());
        let f1 = stream.frame(1, 0.1, [sample(true, 1.0)]);
        assert_eq!(f1.actors[0].kind, ActorTickKind::Spawn);
        assert_eq!(f1.actors[0].acceleration, [0.0; 3]);
        assert_eq!(f1.actors[0].position, [1.0, 0.0, -2.0]);
        let f2 = stream.frame(2, 0.2, [sample(true, 2.0)]);
        assert_eq!(f2.actors[0].kind, ActorTickKind::Update);
        assert!((f2.actors[0].acceleration[0] - 10.0).abs() < 1e-9);
        let f3 = stream.frame(3, 0.3, [sample(false, 0.0)]);
        assert_eq!(f3.actors[0].kind, ActorTickKind::Despawn);
        let f4 = stream.frame(4, 0.4, [sample(true, 2.0)]);
        assert_eq!(f4.actors[0].kind, ActorTickKind::Spawn);
        assert_eq!(f4.actors[0].acceleration, [0.0; 3]);
    }
}
