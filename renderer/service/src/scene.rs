//! `simforge.scene-state.v1` wire structs for the render service (V2 ops).
//!
//! Mirrors the frozen contract in `packages/scene-state/src/schema.ts` and
//! the consumer types in `native/sensors/src/scene_state.rs` (WSB3). Kept as
//! service-local mirrors so the service does not need to depend on the
//! sensors crate; field names and semantics are identical.

use serde::Deserialize;

pub const SCENE_STATE_SCHEMA: &str = "simforge.scene-state.v1";

/// One tick document of a scene-state stream.
#[derive(Debug, Clone, Deserialize)]
pub struct SceneState {
    pub version: String,
    #[serde(rename = "mapId")]
    pub map_id: String,
    pub tick: u32,
    #[serde(rename = "tickHz")]
    pub tick_hz: f32,
    #[serde(default)]
    pub weather: Option<serde_json::Value>,
    #[serde(rename = "timeOfDay", default)]
    pub time_of_day: Option<f32>,
    /// Road-surface elevation hint; null/absent means snap via raycast
    /// (the service uses its ground height field).
    #[serde(rename = "groundY", default)]
    pub ground_y: Option<f32>,
    #[serde(default)]
    pub actors: Vec<ActorState>,
    /// Signal-head lenses at this frame, keyed by the head's RoadRunner
    /// asset GUID (the map GLB head node `{guid}<asset>`, the OpenDRIVE
    /// `<vectorSignal signalId>`), lowercase with braces. Present on every
    /// render-timeline frame (possibly empty): the timeline is then the
    /// signal authority, and a head it does not name shows the engine's
    /// null-signal indication (forced green). Absent (xosc-lowered legacy
    /// frames): the map's heads keep their authored look and the service
    /// records `native_signal_state_absent`.
    #[serde(default)]
    pub signals: Option<std::collections::BTreeMap<String, render_core::signal_heads::SignalLens>>,
}

/// Resolved vehicle lamp states at this frame (the render timeline's
/// `lights_at`: flashing is already resolved to the frame's phase).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActorLights {
    #[serde(default)]
    pub low_beam: bool,
    #[serde(default)]
    pub brake: bool,
    #[serde(default)]
    pub reverse: bool,
    #[serde(default)]
    pub indicator_left: bool,
    #[serde(default)]
    pub indicator_right: bool,
    #[serde(default)]
    pub emergency: bool,
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
    /// Authored sRGB body colour (`#RRGGBB`). Absent actors use the
    /// deterministic class palette.
    #[serde(default)]
    pub color: Option<String>,
    /// Authored L/W/H extents in metres, shared by sensor proxies and the
    /// episode's collision/replay footprint (required for episode actors).
    #[serde(default)]
    pub dims: Option<ActorDims>,
    pub transform: ActorTransform,
    #[serde(default)]
    pub velocity: [f32; 3],
    /// Unwrapped wheel rotation since spawn (timeline `wheelSpinRad`), every
    /// wheeled actor on the timeline path: `odometerM = wheelSpinRad * 0.35`.
    #[serde(rename = "wheelSpinRad", default)]
    pub wheel_spin_rad: Option<f64>,
    /// Four-wheelers: sprung-body attitude, applied to the model's `body`
    /// node only (the transform carries road attitude, wheels stay down).
    #[serde(rename = "bodyAttitude", default)]
    pub body_attitude: Option<BodyAttitude>,
    /// Four-wheelers: per-wheel drop `[FL, FR, RL, RR]`, metres.
    #[serde(rename = "wheelDropM", default)]
    pub wheel_drop_m: Option<[f32; 4]>,
    /// Render-timeline vehicle lamps at this frame. Absent: the frame
    /// carries no lamp state (xosc-lowered legacy frames, non-vehicles).
    #[serde(default)]
    pub lights: Option<ActorLights>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
pub struct BodyAttitude {
    #[serde(rename = "pitchRad")]
    pub pitch_rad: f32,
    #[serde(rename = "rollRad")]
    pub roll_rad: f32,
}

#[derive(Debug, Clone, Copy, Deserialize)]
pub struct ActorDims {
    pub l: f32,
    pub w: f32,
    pub h: f32,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ActorTransform {
    /// World frame = tile GLB frame, metres; y is a ground hint only.
    pub position: [f32; 3],
    /// Y-up quaternion [x, y, z, w]. Required: an absent attitude is not
    /// "facing +X".
    pub rotation: [f32; 4],
}

impl SceneState {
    pub fn validate(&self) -> Result<(), String> {
        if self.version != SCENE_STATE_SCHEMA {
            return Err(format!(
                "scene-state schema mismatch: expected {SCENE_STATE_SCHEMA}, got {}",
                self.version
            ));
        }
        if !(self.tick_hz.is_finite() && self.tick_hz > 0.0) {
            return Err(format!(
                "[native_scene_tick_hz_invalid] tick {} has tickHz {}",
                self.tick, self.tick_hz
            ));
        }
        for actor in &self.actors {
            if actor.kind == "despawn" {
                continue;
            }
            let rotation = actor.transform.rotation;
            let norm = rotation.iter().map(|v| v * v).sum::<f32>().sqrt();
            if !actor
                .transform
                .position
                .iter()
                .chain(rotation.iter())
                .chain(actor.velocity.iter())
                .all(|v| v.is_finite())
                || !(0.5..2.0).contains(&norm)
            {
                return Err(format!(
                    "[native_actor_pose_invalid] actor {} at tick {} has a non-finite or non-unit pose",
                    actor.id, self.tick
                ));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{ActorLights, SceneState};

    #[test]
    fn actor_color_deserializes_from_scene_state() {
        let state: SceneState = serde_json::from_str(
            r##"{
                "version":"simforge.scene-state.v1","mapId":"belmont-research-center",
                "tick":0,"tickHz":20,
                "actors":[{
                    "id":"mini","kind":"spawn","catalogId":"vehicle.hatchback",
                    "actorClass":"car","color":"#8f2f2f",
                    "transform":{"position":[0,0,0],"rotation":[0,0,0,1]}
                }]
            }"##,
        )
        .unwrap();
        assert_eq!(state.actors[0].color.as_deref(), Some("#8f2f2f"));
    }

    #[test]
    fn lamps_and_signal_lenses_deserialize_from_scene_state() {
        use render_core::signal_heads::SignalLens;
        let state: SceneState = serde_json::from_str(
            r##"{
                "version":"simforge.scene-state.v1","mapId":"san-ramon-phase-1",
                "tick":3,"tickHz":60,
                "signals":{"{792c9df6-88ce-45b8-a711-1db32acf567e}":"red"},
                "actors":[
                  {"id":"lead","kind":"update","catalogId":"vehicle.suv","actorClass":"car",
                   "lights":{"brake":true,"lowBeam":true},
                   "transform":{"position":[0,0,0],"rotation":[0,0,0,1]}},
                  {"id":"ego","kind":"update","catalogId":"vehicle.sedan","actorClass":"car",
                   "lights":{},
                   "transform":{"position":[9,0,0],"rotation":[0,0,0,1]}}
                ]
            }"##,
        )
        .unwrap();
        let lead = state.actors[0].lights.unwrap();
        assert!(lead.brake && lead.low_beam && !lead.reverse);
        assert_eq!(state.actors[1].lights, Some(ActorLights::default()));
        assert_eq!(
            state.signals.unwrap()["{792c9df6-88ce-45b8-a711-1db32acf567e}"],
            SignalLens::Red
        );
        // A lamp this contract does not know is refused, never ignored.
        assert!(serde_json::from_str::<ActorLights>(r#"{"fog":true}"#).is_err());
    }
}
