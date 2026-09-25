//! Render timeline -> native `load_scene_state` frames: the port of
//! packages/render/src/native/timeline-lowering.ts (and the actor-class
//! table it shares with lowering.ts).
//!
//! Every frame time is sampled through the shared sampler
//! (`simforge_core::trace::timeline::sampler`, the function the editor, CARLA
//! and the WASM `sceneFramesArray` use) and sent as one scene-state.v1 frame
//! whose `y` is the timeline's baked ground-contact height (`groundY: 0`, so
//! the baked height is authoritative even at 0). Numbers are quantised with
//! JavaScript's `Number(v.toFixed(6))`, so the frames and their digest are
//! the ones the TypeScript engine sent (`canonical::canonical_json`).

use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;
use serde_json::{json, Map, Value};
use simforge_core::trace::timeline::{sampler, RenderTimeline};

use super::canonical::{canonical_json, num, q, sha256_hex};
use super::signal_heads::{resolve_frame_signals, signal_binding_warnings, SignalEvidence};
use crate::contract::CliError;

pub const SCENE_STATE_VERSION: &str = "simforge.scene-state.v1";

/// Engine actor kind -> the service's actor class (`SCENE_ACTOR_CLASS_OF_KIND`
/// plus the legacy OpenSCENARIO categories), total and explicit.
pub const NATIVE_ACTOR_CLASSES: &[(&str, &str)] = &[
    ("vehicle", "car"),
    ("car", "car"),
    ("van", "van"),
    ("truck", "truck"),
    ("bus", "bus"),
    ("motorcycle", "motorcycle"),
    ("bicycle", "cyclist"),
    ("scooter", "cyclist"),
    ("pedestrian", "pedestrian"),
    ("sidewalk_robot", "prop"),
    ("drone", "prop"),
    ("animal", "prop"),
    ("static_object", "prop"),
    ("obstacle", "prop"),
    ("suv", "suv"),
    ("pickup", "pickup"),
];

/// Engine actor kind -> catalog id when the scenario authored none
/// (`NATIVE_KIND_DEFAULT_CATALOG_IDS`).
pub const NATIVE_KIND_DEFAULT_CATALOG_IDS: &[(&str, &str)] = &[
    ("vehicle", "vehicle.sedan"),
    ("car", "vehicle.sedan"),
    ("truck", "vehicle.box_truck"),
    ("bus", "vehicle.bus"),
    ("van", "vehicle.van"),
    ("motorcycle", "vehicle.motorcycle"),
    ("bicycle", "vehicle.bicycle"),
    ("pedestrian", "pedestrian.adult"),
    ("scooter", "vehicle.bicycle"),
    ("sidewalk_robot", "sidewalk_robot.delivery_rover"),
    ("drone", "drone.camera_quadcopter"),
    ("animal", "animal.dog"),
    ("static_object", "hazard.cardboard_box"),
    ("obstacle", "hazard.cardboard_box"),
];

fn unmapped(kind: &str, subject: &str, table: &str) -> CliError {
    CliError::findings(
        "native_actor_kind_unmapped",
        format!("{subject} has actor kind \"{kind}\", which the native {table} table does not map"),
    )
    .with_detail(json!({ "kind": kind }))
}

/// The native service's actor class for an engine actor kind.
pub fn native_actor_class(kind: &str, subject: &str) -> Result<&'static str, CliError> {
    NATIVE_ACTOR_CLASSES
        .iter()
        .find(|(k, _)| *k == kind)
        .map(|(_, c)| *c)
        .ok_or_else(|| unmapped(kind, subject, "actor class"))
}

/// The documented catalog default for an actor kind.
pub fn native_kind_default_catalog_id(kind: &str, subject: &str) -> Result<&'static str, CliError> {
    NATIVE_KIND_DEFAULT_CATALOG_IDS
        .iter()
        .find(|(k, _)| *k == kind)
        .map(|(_, c)| *c)
        .ok_or_else(|| unmapped(kind, subject, "catalog default"))
}

/// One rendered actor's appearance identity (`NativeActorAppearance`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Appearance {
    pub actor_id: String,
    pub kind: String,
    pub catalog_id: String,
    pub authored: bool,
}

/// `NativeTimelineLowering`.
#[derive(Debug, Clone)]
pub struct Lowering {
    pub map_id: String,
    pub fixed_timestep_seconds: f64,
    /// scene-state.v1 frames, one per frame time.
    pub states: Vec<Value>,
    pub frame_times: Vec<f64>,
    /// Every actor drawn in at least one frame, in timeline (id) order.
    pub appearances: Vec<Appearance>,
    /// `sha256(canonicalSceneJson({timelineSha256, states}))`.
    pub sha256: String,
    pub timeline_sha256: String,
    pub timeline_key: String,
    /// `{code, message}`: lamp and signal requests not bound as asked.
    pub warnings: Vec<Value>,
}

impl Lowering {
    pub const SOURCE: &'static str = "render-timeline";
}

fn string_of<T: Serialize>(value: &T) -> String {
    match serde_json::to_value(value) {
        Ok(Value::String(s)) => s,
        other => panic!("expected a string enum, got {other:?}"),
    }
}

fn sample_error(e: impl std::fmt::Display) -> CliError {
    CliError::findings("render_timeline_sample_failed", e.to_string())
}

/// Lower `timeline` at `frame_times_s` (the union of the RGB schedules).
/// `attitude: false` sends yaw-only rotations (the released service applies
/// yaw only; `attitude` is off in the TypeScript engine unless asked).
pub fn lower_timeline(
    timeline: &RenderTimeline,
    frame_times_s: &[f64],
    attitude: bool,
    signal_heads: &BTreeMap<String, String>,
) -> Result<Lowering, CliError> {
    if frame_times_s.is_empty() {
        return Err(CliError::findings(
            "native_render_camera_missing",
            "native render requires at least one RGB schedule",
        ));
    }
    let end = timeline.time.clip_end_s;
    if let Some((i, t)) = frame_times_s
        .iter()
        .enumerate()
        .find(|(_, t)| **t > end + 1e-9)
    {
        return Err(CliError::findings(
            "render_frame_beyond_clip",
            format!("render frame {i} at {t}s exceeds the timeline clip end {end}s"),
        ));
    }
    let yaw_only = !attitude;
    let actors = &timeline.actors;
    let classes: Vec<&str> = actors
        .iter()
        .map(|a| native_actor_class(&string_of(&a.kind), &format!("actor {}", a.id)))
        .collect::<Result<_, _>>()?;
    let weather = string_of(&timeline.environment.weather.preset);
    let time_of_day = timeline.environment.time_of_day;
    let mut previous = vec![false; actors.len()];
    let mut rendered: BTreeSet<&str> = BTreeSet::new();
    let mut evidence = SignalEvidence::default();
    let mut states = Vec::with_capacity(frame_times_s.len());

    for (tick, &clip_time) in frame_times_s.iter().enumerate() {
        let poses = sampler::poses(timeline, clip_time).map_err(sample_error)?;
        let mut out = Vec::new();
        for (index, ((id, p), actor)) in poses.iter().zip(actors.iter()).enumerate() {
            debug_assert_eq!(*id, actor.id);
            let present = p.present;
            let was = previous[index];
            previous[index] = present;
            if !present && !was {
                continue;
            }
            rendered.insert(&actor.id);
            let (position, rotation) = sampler::scene_yup(p, yaw_only);
            let four_wheeled = p.wheel_drop_m.is_some() && !yaw_only;
            let mut record = Map::new();
            record.insert("id".into(), json!(actor.id));
            record.insert(
                "kind".into(),
                json!(if present {
                    if was {
                        "update"
                    } else {
                        "spawn"
                    }
                } else {
                    "despawn"
                }),
            );
            record.insert("catalogId".into(), json!(actor.catalog_id));
            record.insert("actorClass".into(), json!(classes[index]));
            record.insert(
                "dims".into(),
                json!({ "l": num(actor.dims.l), "w": num(actor.dims.w), "h": num(actor.dims.h) }),
            );
            if let Some(color) = actor.color.as_deref().filter(|c| !c.is_empty()) {
                record.insert("color".into(), json!(color));
            }
            record.insert(
                "transform".into(),
                json!({
                    "position": position.iter().map(|v| num(q(*v))).collect::<Vec<_>>(),
                    "rotation": rotation.iter().map(|v| num(q(*v))).collect::<Vec<_>>(),
                }),
            );
            record.insert(
                "velocity".into(),
                json!([
                    num(q(p.velocity[0])),
                    num(q(p.velocity[2])),
                    num(q(-p.velocity[1]))
                ]),
            );
            if present {
                if let Some(spin) = p.wheel_spin_rad {
                    record.insert("wheelSpinRad".into(), num(q(spin)));
                }
                if four_wheeled {
                    record.insert(
                        "bodyAttitude".into(),
                        json!({ "pitchRad": num(q(p.body_pitch_rad)), "rollRad": num(q(p.body_roll_rad)) }),
                    );
                    let drop = p.wheel_drop_m.expect("four-wheeled");
                    record.insert(
                        "wheelDropM".into(),
                        json!(drop.iter().map(|v| num(q(*v))).collect::<Vec<_>>()),
                    );
                }
                let lit =
                    sampler::lights_at(timeline, &actor.id, clip_time).map_err(sample_error)?;
                let mut lights = Map::new();
                for (key, on) in [
                    ("lowBeam", lit.low_beam),
                    ("brake", lit.brake),
                    ("reverse", lit.reverse),
                    ("indicatorLeft", lit.indicator_left),
                    ("indicatorRight", lit.indicator_right),
                    ("emergency", lit.emergency),
                ] {
                    if on {
                        lights.insert(key.into(), json!(true));
                    }
                }
                record.insert("lights".into(), Value::Object(lights));
            }
            out.push(Value::Object(record));
        }
        let previous_time = if tick == 0 {
            frame_times_s
                .get(1)
                .copied()
                .unwrap_or(clip_time + timeline.dt_s)
        } else {
            frame_times_s[tick - 1]
        };
        let tick_hz = q(1.0 / f64::max(1e-9, (clip_time - previous_time).abs()));
        let indications: BTreeMap<String, String> = sampler::signals_at(timeline, clip_time)
            .map_err(sample_error)?
            .into_iter()
            .map(|(id, indication)| (id, string_of(&indication)))
            .collect();
        let signals = resolve_frame_signals(&indications, clip_time, signal_heads, &mut evidence)?;
        states.push(json!({
            "version": SCENE_STATE_VERSION,
            "mapId": timeline.map_id,
            "tick": tick,
            "tickHz": num(tick_hz),
            "weather": { "preset": weather },
            "timeOfDay": num(time_of_day),
            "groundY": 0,
            "actors": out,
            "signals": signals,
        }));
    }

    let appearances = actors
        .iter()
        .filter(|a| rendered.contains(a.id.as_str()))
        .map(|a| Appearance {
            actor_id: a.id.clone(),
            kind: string_of(&a.kind),
            catalog_id: a.catalog_id.clone(),
            authored: a.catalog_authored,
        })
        .collect();
    let timeline_sha256 = timeline
        .sha256()
        .map_err(|e| CliError::findings("render_timeline_invalid", e.to_string()))?;
    let sha256 = sha256_hex(
        canonical_json(&json!({ "timelineSha256": timeline_sha256, "states": states })).as_bytes(),
    );
    Ok(Lowering {
        map_id: timeline.map_id.clone(),
        fixed_timestep_seconds: timeline.dt_s,
        states,
        frame_times: frame_times_s.to_vec(),
        appearances,
        sha256,
        timeline_sha256,
        timeline_key: timeline.identity.timeline_key.clone(),
        warnings: signal_binding_warnings(&evidence),
    })
}

/// The frames as the job's `sceneState` document (`{frames: [...]}`).
pub fn scene_state_document(lowering: &Lowering) -> Value {
    json!({ "frames": lowering.states })
}
