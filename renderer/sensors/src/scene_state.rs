//! `simforge.scene-state.v1` consumer (WSB2's contract).
//!
//! Top-level shape (JSON or msgpack):
//! ```json
//! { "version": "simforge.scene-state.v1", "mapId": "...", "tick": 0, "tickHz": 50,
//!   "weather": {"preset": "clear"}, "timeOfDay": 12.0, "actors": [...] }
//! ```
//! Actor record: `{ id, kind: spawn|update|despawn, catalogId, actorClass,
//! transform: { position:[x,y,z], rotation:[qx,qy,qz,qw] }, velocity:[...],
//! angularVelocityY? }`. The ego actor has id `"ego"`.

use anyhow::{bail, Context, Result};
use bevy::prelude::Resource;
use serde::{Deserialize};

pub const SCENE_STATE_SCHEMA: &str = "simforge.scene-state.v1";

#[derive(Debug, Clone, Deserialize, Resource)]
pub struct SceneState {
    pub version: String,
    #[serde(rename = "mapId")]
    pub map_id: String,
    pub tick: u32,
    #[serde(rename = "tickHz")]
    pub tick_hz: f32,
    #[serde(default)]
    pub weather: Option<Weather>,
    #[serde(rename = "timeOfDay", default)]
    pub time_of_day: Option<f32>,
    #[serde(default)]
    pub actors: Vec<ActorState>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Weather {
    pub preset: String,
    #[serde(default)]
    pub params: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ActorState {
    pub id: String,
    /// spawn | update | despawn
    pub kind: String,
    #[serde(rename = "catalogId", default)]
    pub catalog_id: Option<String>,
    #[serde(rename = "actorClass", default)]
    pub actor_class: Option<String>,
    pub transform: ActorTransform,
    #[serde(default)]
    pub velocity: [f32; 3],
    #[serde(rename = "angularVelocityY", default)]
    pub angular_velocity_y: Option<f32>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ActorTransform {
    /// World frame = tile GLB frame, metres.
    #[serde(rename = "position")]
    pub position: [f32; 3],
    /// Quaternion [x, y, z, w].
    #[serde(rename = "rotation", default = "identity_quat")]
    pub rotation: [f32; 4],
}

fn identity_quat() -> [f32; 4] {
    [0.0, 0.0, 0.0, 1.0]
}

impl SceneState {
    pub fn from_json(text: &str) -> Result<SceneState> {
        let s: SceneState = serde_json::from_str(text).context("parse scene-state json")?;
        if s.version != SCENE_STATE_SCHEMA {
            bail!("scene-state schema mismatch: expected {SCENE_STATE_SCHEMA}, got {}", s.version);
        }
        Ok(s)
    }

    /// The actor hosting the sensor rig.
    ///
    /// The schema's convention is the id `"ego"`, but compiled production
    /// documents name actors after their draft entities (e.g.
    /// `vehicle-mu3ls1vm-450kkb3c`) and carry no `"ego"` id at all. Playback
    /// already falls back to the first actor in the frame; the sensor harness
    /// must agree, or the rig sits at the map origin and every scan is taken
    /// from nowhere.
    pub fn ego(&self) -> Option<&ActorState> {
        self.actors
            .iter()
            .find(|a| a.id == "ego")
            .or_else(|| self.actors.iter().find(|a| a.kind != "despawn"))
    }
}

// ---------------------------------------------------------------------------
// Multi-tick documents
// ---------------------------------------------------------------------------

/// The compiled `scene-state.v1` *document* shape: one header plus a frame per
/// simulated tick (`{version, mapId, tickHz, actors: [desc], frames: [{tick,
/// actors: [pose]}]}`). Playback consumes this directly; the sensor harness
/// consumes the per-tick *stream* shape above, so the document is projected
/// into one `SceneState` per captured tick, carrying each actor's catalog id
/// and class down from the header.
#[derive(Debug, Clone, Deserialize)]
struct Document {
    version: String,
    #[serde(rename = "mapId")]
    map_id: String,
    #[serde(rename = "tickHz")]
    tick_hz: f32,
    #[serde(default)]
    weather: Option<Weather>,
    #[serde(rename = "timeOfDay", default)]
    time_of_day: Option<f32>,
    #[serde(default)]
    actors: Vec<DocumentActor>,
    frames: Vec<DocumentFrame>,
}

#[derive(Debug, Clone, Deserialize)]
struct DocumentActor {
    id: String,
    #[serde(rename = "catalogId", default)]
    catalog_id: Option<String>,
    #[serde(rename = "actorClass", default)]
    actor_class: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct DocumentFrame {
    tick: u32,
    actors: Vec<DocumentPose>,
}

#[derive(Debug, Clone, Deserialize)]
struct DocumentPose {
    id: String,
    kind: String,
    position: [f32; 3],
    #[serde(default = "identity_quat")]
    rotation: [f32; 4],
    #[serde(default)]
    velocity: [f32; 3],
}

/// One or more ticks of scene state, in capture order.
#[derive(Debug, Clone, Resource)]
pub struct SceneSequence {
    pub ticks: Vec<SceneState>,
}

impl SceneSequence {
    /// Parse either shape: a single-tick stream record, or a compiled document
    /// projected into `start`, `start + stride`, ... for `count` ticks. Indices
    /// past the last frame clamp to the last frame, so a short document still
    /// yields the requested tick count rather than failing mid-capture.
    pub fn from_json(text: &str, start: u32, count: u32, stride: u32) -> Result<SceneSequence> {
        let value: serde_json::Value =
            serde_json::from_str(text).context("parse scene-state json")?;
        if !value.get("frames").is_some_and(|f| f.is_array()) {
            let single = SceneState::from_json(text)?;
            return Ok(SceneSequence { ticks: vec![single] });
        }
        let doc: Document =
            serde_json::from_value(value).context("parse scene-state document")?;
        if doc.version != SCENE_STATE_SCHEMA {
            bail!(
                "scene-state schema mismatch: expected {SCENE_STATE_SCHEMA}, got {}",
                doc.version
            );
        }
        if doc.frames.is_empty() {
            bail!("scene-state document has no frames");
        }
        let describe: std::collections::HashMap<&str, &DocumentActor> =
            doc.actors.iter().map(|a| (a.id.as_str(), a)).collect();
        let stride = stride.max(1) as usize;
        let last = doc.frames.len() - 1;
        let ticks = (0..count.max(1) as usize)
            .map(|i| {
                let index = (start as usize + i * stride).min(last);
                let frame = &doc.frames[index];
                SceneState {
                    version: doc.version.clone(),
                    map_id: doc.map_id.clone(),
                    tick: frame.tick,
                    tick_hz: doc.tick_hz,
                    weather: doc.weather.clone(),
                    time_of_day: doc.time_of_day,
                    actors: frame
                        .actors
                        .iter()
                        .map(|pose| {
                            let desc = describe.get(pose.id.as_str());
                            ActorState {
                                id: pose.id.clone(),
                                kind: pose.kind.clone(),
                                catalog_id: desc.and_then(|d| d.catalog_id.clone()),
                                actor_class: desc.and_then(|d| d.actor_class.clone()),
                                transform: ActorTransform {
                                    position: pose.position,
                                    rotation: pose.rotation,
                                },
                                velocity: pose.velocity,
                                angular_velocity_y: None,
                            }
                        })
                        .collect(),
                }
            })
            .collect();
        Ok(SceneSequence { ticks })
    }
}
