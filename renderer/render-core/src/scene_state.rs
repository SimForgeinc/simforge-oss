//! simforge.scene-state.v1 consumer types (serde). Mirrors
//! packages/scene-state/src/schema.ts and docs/native-renderer/scene-state-v1.md.

use serde::{Deserialize, Serialize};

pub const SCENE_STATE_VERSION: &str = "simforge.scene-state.v1";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum RenderProfile {
    #[default]
    Sensor,
    Cinematic,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Weather {
    pub preset: WeatherPreset,
    #[serde(default)]
    pub fog_density: f64,
    #[serde(default)]
    pub rain_intensity: f64,
    #[serde(default)]
    pub wetness: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WeatherPreset {
    Clear,
    Fog,
    Rain,
    Night,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActorDesc {
    pub id: String,
    #[serde(rename = "catalogId")]
    pub catalog_id: String,
    #[serde(rename = "actorClass")]
    pub actor_class: String,
    #[serde(default)]
    pub dims: Option<Dims>,
    #[serde(default)]
    pub color: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Dims {
    pub l: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ActorTickKind {
    Spawn,
    Update,
    Despawn,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActorTick {
    pub id: String,
    pub kind: ActorTickKind,
    pub position: [f64; 3],
    pub rotation: [f64; 4],
    #[serde(rename = "yawRad")]
    pub yaw_rad: f64,
    pub velocity: [f64; 3],
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SceneFrame {
    pub tick: u32,
    pub t: f64,
    pub actors: Vec<ActorTick>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SceneState {
    pub version: String,
    #[serde(rename = "mapId")]
    pub map_id: String,
    pub frame: String,
    pub dt: f64,
    #[serde(rename = "tickHz")]
    pub tick_hz: f64,
    #[serde(rename = "tickCount")]
    pub tick_count: u32,
    pub weather: Weather,
    #[serde(rename = "timeOfDay")]
    pub time_of_day: f64,
    #[serde(default)]
    pub profile: RenderProfile,
    #[serde(default, rename = "groundY")]
    pub ground_y: Option<f64>,
    pub actors: Vec<ActorDesc>,
    pub frames: Vec<SceneFrame>,
}

/// Largest disagreement tolerated between an actor's quaternion and its
/// redundant `yawRad` channel, radians. The engine emits both from the same
/// heading, so anything above serialisation noise means the document was
/// synthesised by something that got the frame convention wrong — the failure
/// that rendered every vehicle mirrored about the X axis.
const YAW_CONSISTENCY_TOLERANCE_RAD: f64 = 1.0e-3;

/// Yaw about +Y of a `[x, y, z, w]` quaternion, CCW from +X.
fn quaternion_yaw(q: [f64; 4]) -> f64 {
    let [x, y, z, w] = q;
    (2.0 * (w * y + x * z)).atan2(1.0 - 2.0 * (y * y + x * x))
}

impl SceneState {
    pub fn from_json_bytes(bytes: &[u8]) -> anyhow::Result<Self> {
        let state: Self = serde_json::from_slice(bytes)?;
        state.validate()?;
        Ok(state)
    }

    pub fn load(path: &std::path::Path) -> anyhow::Result<Self> {
        let bytes = std::fs::read(path)?;
        Self::from_json_bytes(&bytes)
    }

    /// Reject documents this renderer cannot faithfully play back.
    ///
    /// The orientation check is the load-bearing one: `rotation` is applied
    /// verbatim to the actor while `yawRad` drives the chase camera, the
    /// headlight beams and the wheel solver, so a document where the two
    /// disagree renders a vehicle whose body points one way and whose motion
    /// points another. Failing here names the offending actor instead of
    /// producing 400 plausible-looking frames of wrong geometry.
    pub fn validate(&self) -> anyhow::Result<()> {
        if self.version != SCENE_STATE_VERSION {
            anyhow::bail!(
                "scene state version {:?} is not {SCENE_STATE_VERSION}",
                self.version
            );
        }
        if self.frame != "scene-yup" {
            anyhow::bail!("scene state frame {:?} is not scene-yup", self.frame);
        }
        for frame in &self.frames {
            for actor in &frame.actors {
                let q = actor.rotation;
                let norm = (q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]).sqrt();
                if !norm.is_finite() || (norm - 1.0).abs() > 1.0e-3 {
                    anyhow::bail!(
                        "tick {} actor {}: rotation quaternion is not a unit quaternion (norm {norm})",
                        frame.tick,
                        actor.id
                    );
                }
                let delta = (quaternion_yaw(q) - actor.yaw_rad).sin().abs();
                if delta > YAW_CONSISTENCY_TOLERANCE_RAD {
                    anyhow::bail!(
                        "tick {} actor {}: rotation quaternion yaw {:.6} rad disagrees with yawRad {:.6} rad; \
                         scene-yup yaw is CCW from +X about +Y",
                        frame.tick,
                        actor.id,
                        quaternion_yaw(q),
                        actor.yaw_rad
                    );
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn document(rotation: [f64; 4], yaw_rad: f64) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "version": SCENE_STATE_VERSION,
            "mapId": "belmont-research-center",
            "frame": "scene-yup",
            "dt": 0.05,
            "tickHz": 20.0,
            "tickCount": 1,
            "weather": { "preset": "clear", "fogDensity": 0.0, "rainIntensity": 0.0, "wetness": 0.0 },
            "timeOfDay": 12.0,
            "profile": "sensor",
            "groundY": 2.0,
            "actors": [{ "id": "ego", "catalogId": "vehicle.honda_civic", "actorClass": "car" }],
            "frames": [{
                "tick": 0,
                "t": 0.0,
                "actors": [{
                    "id": "ego",
                    "kind": "update",
                    "position": [0.0, 2.0, 0.0],
                    "rotation": rotation,
                    "yawRad": yaw_rad,
                    "velocity": [0.0, 0.0, 0.0],
                }],
            }],
        }))
        .expect("serialise fixture")
    }

    /// An engine-emitted document round-trips, including the camelCase
    /// `groundY`/`fogDensity` keys the emitter actually writes.
    #[test]
    fn accepts_engine_camel_case_document() {
        let yaw = 0.75_f64;
        let (s, c) = ((yaw / 2.0).sin(), (yaw / 2.0).cos());
        let state = SceneState::from_json_bytes(&document([0.0, s, 0.0, c], yaw))
            .expect("engine document must load");
        assert_eq!(state.ground_y, Some(2.0));
        assert_eq!(state.weather.preset, WeatherPreset::Clear);
    }

    /// The regression: a left-handed (CARLA) yaw written into a y-up
    /// quaternion mirrors every heading about +X. The renderer must refuse it
    /// rather than render 400 frames of sideways traffic.
    #[test]
    fn rejects_mirrored_heading_quaternion() {
        let yaw = 0.75_f64;
        let (s, c) = ((yaw / 2.0).sin(), (yaw / 2.0).cos());
        let error = SceneState::from_json_bytes(&document([0.0, -s, 0.0, c], yaw))
            .expect_err("a mirrored quaternion must be rejected");
        let message = error.to_string();
        assert!(message.contains("ego"), "{message}");
        assert!(message.contains("disagrees with yawRad"), "{message}");
    }

    /// Yaw is an angle: ±π must compare equal, not as a 2π disagreement.
    #[test]
    fn accepts_equivalent_yaw_wrapping() {
        let yaw = std::f64::consts::PI;
        let (s, c) = ((yaw / 2.0).sin(), (yaw / 2.0).cos());
        SceneState::from_json_bytes(&document([0.0, s, 0.0, c], -yaw))
            .expect("plus and minus pi are the same heading");
    }
}
