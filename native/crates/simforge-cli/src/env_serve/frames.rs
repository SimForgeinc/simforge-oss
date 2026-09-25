//! Closed-loop scene-state frames: what the renderer draws for the state an
//! episode is in *now* (a `simforge.scene-state.v1` frame per render).
//!
//! An offline render lowers a render timeline; a closed-loop episode has no
//! timeline (its future depends on the policy), so each frame is built from
//! the engine's actor snapshots with the render timeline's own rules, one
//! instant at a time:
//!
//! - **Identity**: ids, kinds and dims from the engine; the catalog id by the
//!   timeline's binding (`scene_state::catalog_id_for`: a `catalog:<id>` tag,
//!   else the documented kind default); the actor class and body colour by
//!   the same tables. A kind the renderer has no class for is an error.
//! - **Presence**: `spawn` / `update` / `despawn` continue across frames of
//!   one episode; a reset starts a new stream.
//! - **Heights and road attitude**: on a grounded world the engine's own
//!   contact (`ActorSnapshot.contact`: z, pitch, roll, wheel drop), which is
//!   what a grounded trace records and its timeline replays. On an
//!   ungrounded world the timeline's legacy rule (`xodr-elevation/v1`): the
//!   body's wheel probes on the OpenDRIVE elevation, the actor's lane road
//!   preferred, a tie broken by the same probe's previous elevation, then
//!   the contact fit. An unresolvable probe is an error, never a flat 0.
//! - **Body attitude** (the sprung body's pitch/roll from acceleration) is
//!   not derived in closed loop and is not sent; the road attitude is.
//! - **Wheel odometer**: speed integrated over the frame interval, as the
//!   timeline integrates it (`wheelSpinRad = odometer / 0.35 m`).
//! - **Lights**: the timeline's derived lamps: low beams from the scenario's
//!   time of day, brake on deceleration >= 1 m/s² held while >= 0.3 m/s² or
//!   stopped, reverse while moving backwards. Authored light cues
//!   (`state_set lights.*` events) are not replayed in closed loop.
//! - **Signals**: every program's phase at the engine time, bound to the
//!   map's heads exactly as the offline lowering binds timeline signals.

use std::collections::BTreeMap;
use std::sync::Arc;

use serde::Serialize;
use serde_json::{json, Map, Value};
use simforge_core::engine::contact::{fit, ContactGeometry};
use simforge_core::map::LaneGraph;
use simforge_core::trace::scene_state::{body_color_of, catalog_id_for, weather_from};
use simforge_core::trace::timeline::{body, HeightField, HeightQuery};
use simforge_core::trace::ContactFrame;
use simforge_core::types::{ActorKind, SimScenarioInput, TimeOfDay};

use crate::contract::CliError;
use crate::render::lowering::{native_actor_class, SCENE_STATE_VERSION};
use crate::render::signal_heads::{resolve_frame_signals, SignalEvidence};

/// What an actor was bound to when the episode loaded.
#[derive(Debug, Clone)]
pub struct ActorMeta {
    pub kind: ActorKind,
    pub kind_name: String,
    pub class: &'static str,
    pub catalog_id: String,
    pub authored: bool,
    pub color: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct LoopState {
    present: bool,
    spin: f64,
    braking: bool,
    speed: f64,
    probe_z: [Option<f64>; 4],
}

fn name_of<T: Serialize>(value: &T) -> String {
    match serde_json::to_value(value) {
        Ok(Value::String(s)) => s,
        other => panic!("expected a string enum, got {other:?}"),
    }
}

fn four_wheeled(kind: ActorKind) -> bool {
    matches!(
        kind,
        ActorKind::Vehicle | ActorKind::Car | ActorKind::Van | ActorKind::Truck | ActorKind::Bus
    )
}

fn two_wheeled(kind: ActorKind) -> bool {
    matches!(
        kind,
        ActorKind::Motorcycle | ActorKind::Bicycle | ActorKind::Scooter
    )
}

/// 6 decimal places, as every lowered channel.
fn q(v: f64) -> f64 {
    (v * 1e6).round() / 1e6
}

fn road_of(rsl: &str) -> Option<i64> {
    rsl.split(':')
        .next()?
        .parse::<f64>()
        .ok()
        .filter(|v| v.is_finite())
        .map(|v| v as i64)
}

/// Builds the frames of one closed-loop episode.
pub struct FrameBuilder {
    map_id: String,
    weather: String,
    time_of_day: f64,
    low_beams: bool,
    /// `None` on a grounded world (the engine's contact is used).
    height: Option<HeightField>,
    lanes: Arc<LaneGraph>,
    heads: BTreeMap<String, String>,
    evidence: SignalEvidence,
    meta: BTreeMap<String, ActorMeta>,
    state: BTreeMap<String, LoopState>,
    last_t: Option<f64>,
    tick: u32,
}

impl FrameBuilder {
    pub fn new(
        input: &SimScenarioInput,
        height: Option<HeightField>,
        lanes: Arc<LaneGraph>,
        heads: BTreeMap<String, String>,
    ) -> Result<Self, CliError> {
        let (weather, time_of_day) = weather_from(&input.operational_conditions);
        let mut meta = BTreeMap::new();
        for actor in &input.actors {
            let kind_name = name_of(&actor.kind);
            let class = native_actor_class(&kind_name, &format!("actor {}", actor.id))?;
            meta.insert(
                actor.id.to_string(),
                ActorMeta {
                    kind: actor.kind,
                    class,
                    catalog_id: catalog_id_for(actor.kind, &actor.tags),
                    authored: actor.tags.iter().any(|t| t.starts_with("catalog:")),
                    color: body_color_of(&actor.tags),
                    kind_name,
                },
            );
        }
        Ok(Self {
            map_id: input.map_id.clone(),
            weather: name_of(&weather.preset),
            time_of_day,
            low_beams: !matches!(input.operational_conditions.time_of_day, TimeOfDay::Day),
            height,
            lanes,
            heads,
            evidence: SignalEvidence::default(),
            meta,
            state: BTreeMap::new(),
            last_t: None,
            tick: 0,
        })
    }

    /// Every scenario actor as the renderer binds it (for the actor-asset check).
    pub fn actors(&self) -> &BTreeMap<String, ActorMeta> {
        &self.meta
    }

    /// Forget the previous episode: the next frame starts a new stream.
    pub fn restart(&mut self) {
        self.state.clear();
        self.last_t = None;
        self.tick = 0;
        self.evidence = SignalEvidence::default();
    }

    /// Signal-binding warnings accumulated this episode.
    pub fn signal_warnings(&self) -> Vec<Value> {
        crate::render::signal_heads::signal_binding_warnings(&self.evidence)
    }

    #[allow(clippy::too_many_arguments)]
    fn xodr_contact(
        &self,
        id: &str,
        geometry: ContactGeometry,
        x: f64,
        y: f64,
        heading: f64,
        road: Option<i64>,
        previous: [Option<f64>; 4],
    ) -> Result<(ContactFrame, [Option<f64>; 4]), CliError> {
        let height = self
            .height
            .as_ref()
            .expect("an ungrounded world has an elevation field");
        let mut z = [0.0; 4];
        let mut probes = [None; 4];
        for (k, (px, py)) in geometry.probes(x, y, heading).into_iter().enumerate() {
            let query = |continuity_z| HeightQuery {
                preferred_road: road,
                label: Some(id),
                continuity_z,
            };
            let value = match height.elevation(px, py, query(None)) {
                Ok(v) => v,
                Err(simforge_core::trace::timeline::HeightError::Ambiguous { .. })
                    if previous[k].is_some() =>
                {
                    height
                        .elevation(px, py, query(previous[k]))
                        .map_err(|e| height_error(id, e))?
                }
                Err(e) => return Err(height_error(id, e)),
            };
            z[k] = value;
            probes[k] = Some(value);
        }
        Ok((fit(geometry, &z), probes))
    }

    /// The frame for the episode's current instant.
    pub fn frame(
        &mut self,
        env: &simforge_bindings_common::runtime::Env,
    ) -> Result<Value, CliError> {
        let session = env.session();
        let sim = session
            .simulation()
            .ok_or_else(|| CliError::new("episode_not_reset", "the episode has not been reset"))?;
        let snapshots = session
            .actor_snapshots()
            .map_err(|e| CliError::new("episode_error", e.to_string()))?;
        let t = sim.t_s();
        let dt = self.last_t.map(|last| t - last).filter(|d| *d > 0.0);
        let mut actors = Vec::new();
        for snap in snapshots {
            let id = sim.actor_id(snap.index).to_owned();
            let meta = self.meta.get(&id).cloned().ok_or_else(|| {
                CliError::new(
                    "episode_actor_unknown",
                    format!("the engine reports actor {id}, which the scenario does not declare"),
                )
            })?;
            let mut st = self.state.get(&id).cloned().unwrap_or_default();
            let was = st.present;
            let present = snap.present;
            if !present && !was {
                continue;
            }
            let dims = sim.actor_dims(snap.index);
            let mut record = Map::new();
            record.insert("id".into(), json!(id));
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
            record.insert("catalogId".into(), json!(meta.catalog_id));
            record.insert("actorClass".into(), json!(meta.class));
            record.insert(
                "dims".into(),
                json!({ "l": dims.l, "w": dims.w, "h": dims.h }),
            );
            if let Some(color) = meta.color.as_deref().filter(|c| !c.is_empty()) {
                record.insert("color".into(), json!(color));
            }
            if !present {
                // A despawn record carries no pose of its own.
                record.insert(
                    "transform".into(),
                    json!({ "position": [0.0, 0.0, 0.0], "rotation": [0.0, 0.0, 0.0, 1.0] }),
                );
                record.insert("velocity".into(), json!([0.0, 0.0, 0.0]));
                self.state.insert(id, LoopState::default());
                actors.push(Value::Object(record));
                continue;
            }
            let wheelbase =
                simforge_core::physics::actor_physics_profile(meta.kind).map(|p| p.wheelbase_m);
            let geometry = ContactGeometry::for_actor(meta.kind, &dims, wheelbase);
            let contact = match (&snap.contact, &self.height) {
                (Some(contact), _) => *contact,
                (None, Some(_)) => {
                    let road = snap.lane.and_then(|lane| road_of(self.lanes.rsl(lane)));
                    let previous = if was { st.probe_z } else { [None; 4] };
                    let (frame, probes) = self.xodr_contact(
                        &id,
                        geometry,
                        snap.x,
                        snap.y,
                        snap.heading_rad,
                        road,
                        previous,
                    )?;
                    st.probe_z = probes;
                    frame
                }
                (None, None) => {
                    return Err(CliError::new(
                        "episode_contact_missing",
                        format!("actor {id} has no ground contact on a grounded world"),
                    ))
                }
            };
            let heading = snap.heading_rad;
            let pose = simforge_core::trace::timeline::TimelinePose {
                present: true,
                tick: self.tick,
                x: snap.x,
                y: snap.y,
                z: contact.z,
                heading_rad: heading,
                pitch_rad: contact.pitch_rad,
                roll_rad: contact.roll_rad,
                speed_mps: snap.speed_mps,
                velocity: [0.0; 3],
                acceleration: [0.0; 3],
                road_pitch_rad: contact.pitch_rad,
                road_roll_rad: contact.roll_rad,
                body_pitch_rad: 0.0,
                body_roll_rad: 0.0,
                wheel_steer_rad: None,
                wheel_spin_rad: None,
                wheel_drop_m: None,
                downed: false,
            };
            let (position, rotation) =
                simforge_core::trace::timeline::sampler::scene_yup(&pose, false);
            let v = snap.longitudinal_velocity_mps;
            let (vx, vy) = (v * heading.cos(), v * heading.sin());
            record.insert(
                "transform".into(),
                json!({
                    "position": position.iter().map(|c| q(*c)).collect::<Vec<_>>(),
                    "rotation": rotation.iter().map(|c| q(*c)).collect::<Vec<_>>(),
                }),
            );
            record.insert("velocity".into(), json!([q(vx), 0.0, q(-vy)]));
            let wheeled = four_wheeled(meta.kind) || two_wheeled(meta.kind);
            if wheeled {
                if let Some(dt) = dt.filter(|_| was) {
                    st.spin += v * dt / body::WHEEL_RADIUS_M;
                } else if !was {
                    st.spin = 0.0;
                }
                record.insert("wheelSpinRad".into(), json!(q(st.spin)));
            }
            if four_wheeled(meta.kind) {
                record.insert(
                    "wheelDropM".into(),
                    json!(contact
                        .wheel_drop_m
                        .iter()
                        .map(|d| q(*d))
                        .collect::<Vec<_>>()),
                );
            }
            let mut lights = Map::new();
            if wheeled {
                let speed = v.abs();
                st.braking = match dt.filter(|_| was) {
                    Some(dt) => {
                        let decel = (st.speed - speed) / dt;
                        if decel >= body::BRAKE_ON_MPS2 {
                            true
                        } else if st.braking {
                            decel >= body::BRAKE_HOLD_MPS2 || speed < body::STOPPED_MPS
                        } else {
                            false
                        }
                    }
                    None => false,
                };
                st.speed = speed;
                if self.low_beams {
                    lights.insert("lowBeam".into(), json!(true));
                }
                if st.braking {
                    lights.insert("brake".into(), json!(true));
                }
                if v < -body::STOPPED_MPS {
                    lights.insert("reverse".into(), json!(true));
                }
            }
            record.insert("lights".into(), Value::Object(lights));
            st.present = true;
            self.state.insert(id, st);
            actors.push(Value::Object(record));
        }
        let book = sim.signal_book();
        let indications: BTreeMap<String, String> = book
            .ids()
            .enumerate()
            .map(|(i, id)| (id.to_owned(), name_of(&book.phase_at_index(i as u32, t))))
            .collect();
        let signals = resolve_frame_signals(&indications, t, &self.heads, &mut self.evidence)?;
        let tick_hz = match dt {
            Some(dt) => q(1.0 / dt),
            None => q(1.0 / sim.dt_s()),
        };
        let frame = json!({
            "version": SCENE_STATE_VERSION,
            "mapId": self.map_id,
            "tick": self.tick,
            "tickHz": tick_hz,
            "t": t,
            "weather": { "preset": self.weather },
            "timeOfDay": self.time_of_day,
            "groundY": 0,
            "actors": actors,
            "signals": signals,
        });
        self.tick += 1;
        self.last_t = Some(t);
        Ok(frame)
    }
}

fn height_error(id: &str, error: simforge_core::trace::timeline::HeightError) -> CliError {
    CliError::new(
        "episode_height_unresolved",
        format!("actor {id}: no road elevation under its wheels ({error})"),
    )
}
