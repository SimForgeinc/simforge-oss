//! `simforge.render-timeline.v1` — the render contract.
//!
//! One authoritative [`SimTrace`] becomes one render timeline: the trace's
//! actor tracks plus everything a renderer would otherwise derive on its own
//! and get differently — ground-contact height baked from one height source
//! ([`height`]), road and body attitude, signal phases, vehicle lights and
//! explicit actor lifecycle — on an explicit time origin. Every renderer
//! (editor, Bevy, CARLA) reads poses through the one shared sampler
//! ([`sampler::pose`]), never from its own interpolation. OpenSCENARIO is a
//! derived export of the same trace, not a render input.
//!
//! Frame: OpenSCENARIO world / xodr-local — right-handed, `x` east, `y`
//! north, `z` up, heading CCW from `+x`. Orientation follows OpenSCENARIO
//! `Orientation`: pitch positive = nose down, roll positive = right side
//! down. Renderers convert to their own frame (Bevy scene-yup:
//! `[x, z, -y]`; CARLA: negate `y` and yaw, flip pitch).
//!
//! Contract: `docs/engineering/render-timeline.md`.

pub mod height;
pub mod sampler;

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::hash::content_hash_of;
use crate::math::{atan, clamp, quantize, Vec2};
use crate::physics::MotionDirection;
use crate::types::{ActorKind, ControlIndication, Dims, SetValue, TimeOfDay};

use super::scene_state::{
    actor_class_of, catalog_id_for, weather_from, ActorClass, RenderProfile, Weather,
};
use super::{SimEvent, SimTrace, TraceError};

pub use height::{HeightError, HeightField, HeightQuery, HeightSource};
pub use sampler::{pose, LightStates, SampleError, TimelinePose};

/// The only document version renderers accept.
pub const RENDER_TIMELINE_VERSION: &str = "simforge.render-timeline.v1";
/// Version of the derivation *and* sampling rules. Any change to how a
/// channel is derived (heights, attitude, lights) or sampled bumps it, which
/// changes every timeline key.
pub const SAMPLER_VERSION: &str = "simforge.timeline-sampler/1";
/// Schema tag of the key preimage.
pub const TIMELINE_KEY_SCHEMA: &str = "simforge.render-timeline-key/v1";
/// The one fixed step. Traces at any other dt are rejected.
pub const TIMELINE_DT_S: f64 = 0.02;

/// Decimal places each stored channel is quantised to. Matches trace v4 for
/// the channels it copies.
pub mod precision {
    pub const T: i32 = 6;
    pub const POSITION: i32 = 4;
    pub const HEIGHT: i32 = 4;
    pub const ANGLE: i32 = 6;
    pub const SPEED: i32 = 4;
}

/// Body attitude gains (per class, sampler-versioned constants; the catalog
/// digest in the key reserves the move to catalog-sourced values).
pub mod body {
    /// rad per m/s² of longitudinal acceleration (braking → nose down).
    pub const K_PITCH: f64 = 0.006;
    /// rad per m/s² of lateral acceleration (left turn → right side down).
    pub const K_ROLL: f64 = 0.008;
    pub const MAX_RAD: f64 = 0.05;
    /// First-order low-pass time constant.
    pub const TAU_S: f64 = 0.15;
    /// Wheelbase and track as fractions of the body's length and width.
    pub const WHEELBASE_OF_LENGTH: f64 = 0.6;
    pub const MIN_WHEELBASE_M: f64 = 0.5;
    pub const TRACK_OF_WIDTH: f64 = 0.85;
    pub const WHEEL_RADIUS_M: f64 = 0.35;
    pub const MAX_STEER_RAD: f64 = 0.7;
    /// Brake light on at this deceleration, held while stopped.
    pub const BRAKE_ON_MPS2: f64 = 1.0;
    pub const BRAKE_HOLD_MPS2: f64 = 0.3;
    pub const STOPPED_MPS: f64 = 0.05;
    /// Flashing lights: period and duty, phase from timeline `t` (on at 0).
    pub const FLASH_PERIOD_S: f64 = 1.0;
    pub const FLASH_DUTY: f64 = 0.5;
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum TimelineError {
    #[error("trace: {0}")]
    Trace(#[from] TraceError),
    #[error("trace dt {found} is not the fixed render step {expected}")]
    UnsupportedDt { found: f64, expected: f64 },
    #[error("trace was simulated on graph {trace} but the height source is xodr {source_digest}")]
    MapMismatch {
        trace: String,
        source_digest: String,
    },
    #[error("height for actor {actor_id} at tick {tick}: {error}")]
    Height {
        actor_id: String,
        tick: usize,
        error: HeightError,
    },
    #[error("height for prop {prop_id}: {error}")]
    PropHeight { prop_id: String, error: HeightError },
    #[error("timeline version {0:?} is not {RENDER_TIMELINE_VERSION}")]
    UnsupportedVersion(String),
    #[error("timeline sampler {found:?} is not {SAMPLER_VERSION}")]
    UnsupportedSampler { found: String },
    #[error("timeline is malformed: {0}")]
    Malformed(String),
    #[error("timeline JSON: {0}")]
    Json(String),
    #[error("hash: {0}")]
    Hash(String),
}

impl From<serde_json::Error> for TimelineError {
    fn from(e: serde_json::Error) -> Self {
        TimelineError::Json(e.to_string())
    }
}

/* -------------------------------------------------------------- identity */

/// Canonical trace identity: `traceSha256 = sha256(canonicalJson(quantized
/// trace))` — never the bytes of a gzip or any other encoding.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalTraceIdentity {
    pub trace_sha256: String,
    pub trace_version: u32,
    pub engine_version: String,
    pub input_hash: String,
    pub map_id: String,
    pub engine_graph_digest: String,
}

impl CanonicalTraceIdentity {
    pub fn of(trace: &SimTrace) -> Result<Self, TimelineError> {
        Ok(Self {
            trace_sha256: trace
                .digest()
                .map_err(|e| TimelineError::Hash(e.to_string()))?,
            trace_version: trace.header.trace_version,
            engine_version: trace.header.engine_version.clone(),
            input_hash: trace.header.input_hash.clone(),
            map_id: trace.header.map_id.clone(),
            engine_graph_digest: trace.header.engine_graph_digest.clone(),
        })
    }
}

/// The timeline cache key and the inputs it is derived from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineIdentity {
    pub trace_sha256: String,
    pub height_field_digest: String,
    /// Actor-catalog closure digest; `null` when the caller pins none.
    pub catalog_digest: Option<String>,
    pub sampler_version: String,
    /// `sha256(canonicalJson({schema, traceSha256, heightFieldDigest,
    /// catalogDigest, samplerVersion}))`.
    pub timeline_key: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct KeyPreimage<'a> {
    schema: &'a str,
    trace_sha256: &'a str,
    height_field_digest: &'a str,
    catalog_digest: Option<&'a str>,
    sampler_version: &'a str,
}

/// `H(traceSha256, heightFieldDigest, catalogDigest, samplerVer)`: computable
/// before building, so a worker can look the timeline up by key.
pub fn timeline_key(
    trace_sha256: &str,
    height_field_digest: &str,
    catalog_digest: Option<&str>,
) -> String {
    content_hash_of(&KeyPreimage {
        schema: TIMELINE_KEY_SCHEMA,
        trace_sha256,
        height_field_digest,
        catalog_digest,
        sampler_version: SAMPLER_VERSION,
    })
    .expect("key preimage is plain strings")
}

/* ------------------------------------------------------------- document */

/// The time origin. Timeline `t = 0` is the first rendered instant (clip
/// start). The warm-up prologue precedes it, is simulated but never
/// recorded or rendered; OpenSCENARIO exports place `t` at
/// `SimulationTime = t + xoscTimeOffsetS`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeOrigin {
    /// Always `0`: frames carry clip-relative `t`.
    pub time_origin_s: f64,
    pub warmup_s: f64,
    /// `t` of the last tick; sampling is defined on `[0, clipEndS]`.
    pub clip_end_s: f64,
    /// Equals `warmupS`.
    pub xosc_time_offset_s: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineEnvironment {
    pub weather: Weather,
    /// Hour of day [0, 24).
    pub time_of_day: f64,
    pub profile: RenderProfile,
    /// Environment-driven low-beam default (authored darkness).
    pub low_beams: bool,
}

/// One presence interval: present from `spawnTick` (inclusive) until
/// `despawnTick` (exclusive, the first absent tick); `null` = to clip end.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresenceInterval {
    pub spawn_tick: u32,
    pub despawn_tick: Option<u32>,
}

/// Per-tick channels, index-aligned with [`RenderTimeline::t`]. Values at
/// absent ticks are zero and never read by the sampler.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineTrack {
    /// 1 while the body exists.
    pub present: Vec<u8>,
    pub x: Vec<f64>,
    pub y: Vec<f64>,
    /// Ground-contact elevation (bottom of the body), from the height source.
    pub z: Vec<f64>,
    pub heading_rad: Vec<f64>,
    /// Signed longitudinal speed (negative while reversing).
    pub speed_mps: Vec<f64>,
    pub road_pitch_rad: Vec<f64>,
    pub road_roll_rad: Vec<f64>,
    pub body_pitch_rad: Vec<f64>,
    pub body_roll_rad: Vec<f64>,
    /// `roadPitchRad + bodyPitchRad`: what renderers apply.
    pub pitch_rad: Vec<f64>,
    /// `roadRollRad + bodyRollRad`: what renderers apply.
    pub roll_rad: Vec<f64>,
    /// Front-wheel steer, vehicles only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wheel_steer_rad: Option<Vec<f64>>,
    /// Integrated wheel rotation since spawn (unwrapped), vehicles only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wheel_spin_rad: Option<Vec<f64>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LightKind {
    LowBeam,
    Brake,
    Reverse,
    IndicatorLeft,
    IndicatorRight,
    Emergency,
}

impl LightKind {
    pub const ALL: [LightKind; 6] = [
        LightKind::LowBeam,
        LightKind::Brake,
        LightKind::Reverse,
        LightKind::IndicatorLeft,
        LightKind::IndicatorRight,
        LightKind::Emergency,
    ];
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LightMode {
    On,
    Off,
    Flashing,
}

/// A light's mode from `tick` on (held until the next change). Every light
/// is `off` before its first change.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LightChange {
    pub tick: u32,
    pub light: LightKind,
    pub mode: LightMode,
}

/// A signal head's indication from `tick` on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalChange {
    pub tick: u32,
    pub indication: ControlIndication,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineActor {
    pub id: String,
    pub kind: ActorKind,
    /// Mesh binding, identical to scene-state.v1 `ActorDesc.catalogId`.
    pub catalog_id: String,
    pub actor_class: ActorClass,
    pub dims: Dims,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(rename = "static")]
    pub is_static: bool,
    /// Who authored the body: `authored`, generated `native-ambient`
    /// traffic, or `sumo` traffic. Traffic is baked into actor data; no
    /// consumer runs traffic of its own.
    pub origin: ActorOrigin,
    pub lifecycle: Vec<PresenceInterval>,
    pub track: TimelineTrack,
    /// Sorted by tick, then light.
    pub lights: Vec<LightChange>,
}

/// Actor provenance (`header.actorMetadata[id].origin` rule): tags `sumo` /
/// `sumo:*` → `sumo`; tags `ambient` / `ambient:*` or membership in
/// `header.ambientActorIds` → `native-ambient`; otherwise `authored`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ActorOrigin {
    Authored,
    NativeAmbient,
    Sumo,
}

pub fn actor_origin(tags: &[String], listed_ambient: bool) -> ActorOrigin {
    let has = |p: &str| {
        tags.iter()
            .any(|t| t == p || t.strip_prefix(p).is_some_and(|r| r.starts_with(':')))
    };
    if has("sumo") {
        ActorOrigin::Sumo
    } else if has("ambient") || listed_ambient {
        ActorOrigin::NativeAmbient
    } else {
        ActorOrigin::Authored
    }
}

/// A fixed prop from the trace's prop closure, height baked.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineProp {
    pub id: String,
    pub catalog_id: String,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub heading_rad: f64,
    pub dims: Dims,
    pub scale: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderTimeline {
    pub version: String,
    pub identity: TimelineIdentity,
    pub trace: CanonicalTraceIdentity,
    pub height_source: HeightSource,
    pub map_id: String,
    /// Always `xodr-local` (OpenSCENARIO world frame).
    pub frame: String,
    pub dt_s: f64,
    pub tick_count: u32,
    /// Clip-relative tick times.
    pub t: Vec<f64>,
    pub time: TimeOrigin,
    pub environment: TimelineEnvironment,
    /// Sorted by id.
    pub actors: Vec<TimelineActor>,
    /// Sorted by id.
    pub props: Vec<TimelineProp>,
    /// Keyed by signal id; each list sorted by tick.
    pub signals: BTreeMap<String, Vec<SignalChange>>,
}

impl RenderTimeline {
    /// Parse and validate a timeline document (plain or gzipped JSON).
    pub fn from_json_slice(bytes: &[u8]) -> Result<Self, TimelineError> {
        let bytes = maybe_gunzip(bytes)?;
        let timeline: RenderTimeline = serde_json::from_slice(&bytes)?;
        timeline.validate()?;
        Ok(timeline)
    }

    pub fn to_json(&self) -> Result<String, TimelineError> {
        Ok(serde_json::to_string(self)?)
    }

    /// Content digest of the document: `sha256(canonicalJson(timeline))`.
    /// Render jobs reference this as `timelineSha256`.
    pub fn sha256(&self) -> Result<String, TimelineError> {
        content_hash_of(self).map_err(|e| TimelineError::Hash(e.to_string()))
    }

    pub fn actor(&self, id: &str) -> Option<&TimelineActor> {
        self.actors
            .binary_search_by(|a| a.id.as_str().cmp(id))
            .ok()
            .map(|i| &self.actors[i])
    }

    pub fn validate(&self) -> Result<(), TimelineError> {
        if self.version != RENDER_TIMELINE_VERSION {
            return Err(TimelineError::UnsupportedVersion(self.version.clone()));
        }
        if self.identity.sampler_version != SAMPLER_VERSION {
            return Err(TimelineError::UnsupportedSampler {
                found: self.identity.sampler_version.clone(),
            });
        }
        let bad = |m: String| Err(TimelineError::Malformed(m));
        if self.frame != "xodr-local" {
            return bad(format!("frame {:?}", self.frame));
        }
        if self.dt_s != TIMELINE_DT_S {
            return Err(TimelineError::UnsupportedDt {
                found: self.dt_s,
                expected: TIMELINE_DT_S,
            });
        }
        let n = self.t.len();
        if n == 0 || n != self.tick_count as usize {
            return bad(format!("t has {n} ticks, tickCount {}", self.tick_count));
        }
        if self.t.iter().any(|v| !v.is_finite()) || self.t.windows(2).any(|w| w[1] <= w[0]) {
            return bad("t must be finite and strictly increasing".to_owned());
        }
        if self.actors.windows(2).any(|w| w[1].id <= w[0].id) {
            return bad("actors must be sorted by unique id".to_owned());
        }
        for actor in &self.actors {
            let tr = &actor.track;
            let mut lens = vec![
                ("present", tr.present.len()),
                ("x", tr.x.len()),
                ("y", tr.y.len()),
                ("z", tr.z.len()),
                ("headingRad", tr.heading_rad.len()),
                ("speedMps", tr.speed_mps.len()),
                ("roadPitchRad", tr.road_pitch_rad.len()),
                ("roadRollRad", tr.road_roll_rad.len()),
                ("bodyPitchRad", tr.body_pitch_rad.len()),
                ("bodyRollRad", tr.body_roll_rad.len()),
                ("pitchRad", tr.pitch_rad.len()),
                ("rollRad", tr.roll_rad.len()),
            ];
            if let Some(v) = &tr.wheel_steer_rad {
                lens.push(("wheelSteerRad", v.len()));
            }
            if let Some(v) = &tr.wheel_spin_rad {
                lens.push(("wheelSpinRad", v.len()));
            }
            if let Some((name, len)) = lens.iter().find(|(_, len)| *len != n) {
                return bad(format!(
                    "actors.{}.track.{name} has {len} ticks, expected {n}",
                    actor.id
                ));
            }
            if tr.present.iter().any(|p| *p > 1) {
                return bad(format!("actors.{}.track.present must be 0/1", actor.id));
            }
            let finite = [
                &tr.x,
                &tr.y,
                &tr.z,
                &tr.heading_rad,
                &tr.speed_mps,
                &tr.pitch_rad,
                &tr.roll_rad,
            ];
            if finite.iter().any(|c| c.iter().any(|v| !v.is_finite())) {
                return bad(format!(
                    "actors.{} has a non-finite channel value",
                    actor.id
                ));
            }
            if lifecycle_of(&tr.present) != actor.lifecycle {
                return bad(format!(
                    "actors.{}.lifecycle disagrees with present",
                    actor.id
                ));
            }
        }
        Ok(())
    }
}

/// Serialisable timeline values (lets bindings without a serde dependency
/// ask for JSON text).
pub trait JsonDocument: Serialize {}
impl<T: Serialize + ?Sized> JsonDocument for T {}

/// Plain `serde_json` text of any timeline value.
pub fn to_json_string<T: JsonDocument + ?Sized>(value: &T) -> Result<String, TimelineError> {
    Ok(serde_json::to_string(value)?)
}

/// JSON bytes, transparently gunzipped when they carry the gzip magic.
pub fn maybe_gunzip(bytes: &[u8]) -> Result<std::borrow::Cow<'_, [u8]>, TimelineError> {
    if bytes.len() >= 2 && bytes[0] == 0x1f && bytes[1] == 0x8b {
        use std::io::Read;
        let mut out = Vec::new();
        flate2::read::MultiGzDecoder::new(bytes)
            .read_to_end(&mut out)
            .map_err(|e| TimelineError::Json(format!("gzip: {e}")))?;
        Ok(std::borrow::Cow::Owned(out))
    } else {
        Ok(std::borrow::Cow::Borrowed(bytes))
    }
}

/* ---------------------------------------------------------------- build */

/// Presence intervals from a 0/1 channel.
pub fn lifecycle_of(present: &[u8]) -> Vec<PresenceInterval> {
    let mut out = Vec::new();
    let mut open: Option<u32> = None;
    for (i, p) in present.iter().enumerate() {
        match (open, *p == 1) {
            (None, true) => open = Some(i as u32),
            (Some(spawn), false) => {
                out.push(PresenceInterval {
                    spawn_tick: spawn,
                    despawn_tick: Some(i as u32),
                });
                open = None;
            }
            _ => {}
        }
    }
    if let Some(spawn) = open {
        out.push(PresenceInterval {
            spawn_tick: spawn,
            despawn_tick: None,
        });
    }
    out
}

/// Shortest signed angle `d` wrapped into `[-π, π)`.
#[inline]
pub(crate) fn wrap_pi(d: f64) -> f64 {
    use std::f64::consts::{PI, TAU};
    d - TAU * ((d + PI) / TAU).floor()
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

fn lane_road(rsl: &Option<String>) -> Option<i64> {
    rsl.as_deref()?
        .split(':')
        .next()?
        .parse::<f64>()
        .ok()
        .filter(|v| v.is_finite())
        .map(|v| v as i64)
}

/// First tick index whose `t` is at or after `event_t` (clamped).
fn tick_at_or_after(t: &[f64], event_t: f64) -> u32 {
    let i = t.partition_point(|v| *v < event_t - 1e-9);
    i.min(t.len().saturating_sub(1)) as u32
}

/// Build the render timeline for `trace` against `height`. The trace must
/// be a validated current-format trace at [`TIMELINE_DT_S`].
pub fn build_render_timeline(
    trace: &SimTrace,
    height: &HeightField,
    catalog_digest: Option<&str>,
) -> Result<RenderTimeline, TimelineError> {
    trace.validate()?;
    let header = &trace.header;
    if (header.dt - TIMELINE_DT_S).abs() > 1e-12 {
        return Err(TimelineError::UnsupportedDt {
            found: header.dt,
            expected: TIMELINE_DT_S,
        });
    }
    let source = height.source().clone();
    if let Some(xodr) = &source.xodr_sha256 {
        if !header.engine_graph_digest.is_empty() && &header.engine_graph_digest != xodr {
            return Err(TimelineError::MapMismatch {
                trace: header.engine_graph_digest.clone(),
                source_digest: xodr.clone(),
            });
        }
    }
    let identity = CanonicalTraceIdentity::of(trace)?;
    let key = timeline_key(&identity.trace_sha256, &source.digest, catalog_digest);

    let n = trace.ticks.t.len();
    let t: Vec<f64> = trace
        .ticks
        .t
        .iter()
        .map(|v| quantize(*v, precision::T))
        .collect();
    let dt = TIMELINE_DT_S;
    let (weather, time_of_day) = weather_from(&header.operational_conditions);
    let low_beams = !matches!(header.operational_conditions.time_of_day, TimeOfDay::Day);
    let ambient: std::collections::BTreeSet<&str> = header
        .ambient_actor_ids
        .iter()
        .flatten()
        .map(String::as_str)
        .collect();

    // Events → per-actor light cues (state_set lights.*). Brake cues latch an
    // authored override over the derived brake light until the next cue.
    let mut cue_changes: BTreeMap<&str, Vec<LightChange>> = BTreeMap::new();
    let mut brake_cues: BTreeMap<&str, Vec<(u32, bool)>> = BTreeMap::new();
    for event in &trace.events {
        let SimEvent::StateSet {
            t: et,
            actor_id,
            key,
            value,
        } = event
        else {
            continue;
        };
        let tick = tick_at_or_after(&t, *et);
        use LightKind::{Emergency, IndicatorLeft, IndicatorRight};
        use LightMode::{Flashing, Off};
        let changes: &[(LightKind, LightMode)] = match (key.as_str(), value) {
            ("lights.indicator", SetValue::Text(v)) => match v.as_str() {
                "left" => &[(IndicatorLeft, Flashing), (IndicatorRight, Off)],
                "right" => &[(IndicatorLeft, Off), (IndicatorRight, Flashing)],
                "hazard" => &[(IndicatorLeft, Flashing), (IndicatorRight, Flashing)],
                "off" => &[(IndicatorLeft, Off), (IndicatorRight, Off)],
                _ => &[],
            },
            ("lights.hazard", v) => {
                if v.truthy() {
                    &[(IndicatorLeft, Flashing), (IndicatorRight, Flashing)]
                } else {
                    &[(IndicatorLeft, Off), (IndicatorRight, Off)]
                }
            }
            ("lights.emergency", SetValue::Text(v)) => match v.as_str() {
                "flashing" | "flashing_siren" => &[(Emergency, Flashing)],
                "off" => &[(Emergency, Off)],
                _ => &[],
            },
            ("lights.brake", v) => {
                brake_cues
                    .entry(actor_id.as_str())
                    .or_default()
                    .push((tick, v.truthy()));
                &[]
            }
            _ => &[],
        };
        let list = cue_changes.entry(actor_id.as_str()).or_default();
        for (light, mode) in changes {
            list.push(LightChange {
                tick,
                light: *light,
                mode: *mode,
            });
        }
    }

    let mut actors = Vec::with_capacity(trace.ticks.actors.len());
    for (id, src) in &trace.ticks.actors {
        let meta = &header.actor_metadata[id];
        let kind = meta.kind;
        let is_vehicle = four_wheeled(kind);
        let is_two_wheeler = two_wheeled(kind);
        let dims = meta.dims;
        let wheelbase = (dims.l * body::WHEELBASE_OF_LENGTH).max(body::MIN_WHEELBASE_M);
        let track_w = dims.w * body::TRACK_OF_WIDTH;
        let present: Vec<u8> = src.present.clone();

        let mut tr = TimelineTrack {
            present: present.clone(),
            x: vec![0.0; n],
            y: vec![0.0; n],
            z: vec![0.0; n],
            heading_rad: vec![0.0; n],
            speed_mps: vec![0.0; n],
            road_pitch_rad: vec![0.0; n],
            road_roll_rad: vec![0.0; n],
            body_pitch_rad: vec![0.0; n],
            body_roll_rad: vec![0.0; n],
            pitch_rad: vec![0.0; n],
            roll_rad: vec![0.0; n],
            wheel_steer_rad: is_vehicle.then(|| vec![0.0; n]),
            wheel_spin_rad: is_vehicle.then(|| vec![0.0; n]),
        };
        let mut body_pitch = 0.0;
        let mut body_roll = 0.0;
        let mut spin = 0.0;
        let alpha = dt / (body::TAU_S + dt);
        let steer_channel = src.physics.as_ref().map(|p| &p.steer_rad);
        for i in 0..n {
            if present[i] != 1 {
                continue;
            }
            let fresh = i == 0 || present[i - 1] != 1;
            let x = quantize(src.x[i], precision::POSITION);
            let y = quantize(src.y[i], precision::POSITION);
            let heading = quantize(src.heading_rad[i], precision::ANGLE);
            let raw_speed = src.speed_mps[i];
            let signed = if raw_speed < 0.0 {
                raw_speed
            } else {
                raw_speed * src.motion_direction[i].sign()
            };
            let speed = quantize(signed, precision::SPEED);
            let query = HeightQuery {
                preferred_road: lane_road(&src.lane_rsl[i]),
                label: Some(id),
            };
            let z = height
                .elevation(x, y, query)
                .map_err(|error| TimelineError::Height {
                    actor_id: id.clone(),
                    tick: i,
                    error,
                })?;
            let probe = |px: f64, py: f64| height.elevation(px, py, query).ok();
            let fwd = Vec2::from_heading(heading);
            let left = fwd.perp_left();
            // Road attitude over the footprint (OpenSCENARIO signs).
            let (road_pitch, road_roll) = if is_vehicle || is_two_wheeler {
                let half = wheelbase / 2.0;
                let front = probe(x + fwd.x * half, y + fwd.y * half);
                let rear = probe(x - fwd.x * half, y - fwd.y * half);
                let pitch = match (front, rear) {
                    (Some(zf), Some(zr)) => atan((zr - zf) / wheelbase),
                    _ => 0.0,
                };
                let roll = if is_vehicle {
                    let half_t = track_w / 2.0;
                    let zl = probe(x + left.x * half_t, y + left.y * half_t);
                    let zr = probe(x - left.x * half_t, y - left.y * half_t);
                    match (zl, zr) {
                        (Some(zl), Some(zr)) if track_w > 0.0 => atan((zl - zr) / track_w),
                        _ => 0.0,
                    }
                } else {
                    0.0
                };
                (pitch, roll)
            } else {
                (0.0, 0.0)
            };
            // Body attitude and wheels from the trace's own kinematics.
            let (a_long, yaw_rate) = if fresh {
                body_pitch = 0.0;
                body_roll = 0.0;
                spin = 0.0;
                (0.0, 0.0)
            } else {
                let prev_heading = tr.heading_rad[i - 1];
                (
                    (speed - tr.speed_mps[i - 1]) / dt,
                    wrap_pi(heading - prev_heading) / dt,
                )
            };
            let steer = if is_vehicle {
                let from_channel = steer_channel.and_then(|c| c.get(i).copied());
                let steer = from_channel.unwrap_or_else(|| {
                    let v = speed.abs().max(0.5) * if speed < 0.0 { -1.0 } else { 1.0 };
                    atan(wheelbase * yaw_rate / v)
                });
                clamp(steer, -body::MAX_STEER_RAD, body::MAX_STEER_RAD)
            } else {
                0.0
            };
            if is_vehicle && !fresh {
                let target_pitch = clamp(-body::K_PITCH * a_long, -body::MAX_RAD, body::MAX_RAD);
                let target_roll = clamp(
                    body::K_ROLL * speed * yaw_rate,
                    -body::MAX_RAD,
                    body::MAX_RAD,
                );
                body_pitch += alpha * (target_pitch - body_pitch);
                body_roll += alpha * (target_roll - body_roll);
                spin += speed * dt / body::WHEEL_RADIUS_M;
            }
            let rp = quantize(road_pitch, precision::ANGLE);
            let rr = quantize(road_roll, precision::ANGLE);
            let bp = quantize(body_pitch, precision::ANGLE);
            let br = quantize(body_roll, precision::ANGLE);
            tr.x[i] = x;
            tr.y[i] = y;
            tr.z[i] = quantize(z, precision::HEIGHT);
            tr.heading_rad[i] = heading;
            tr.speed_mps[i] = speed;
            tr.road_pitch_rad[i] = rp;
            tr.road_roll_rad[i] = rr;
            tr.body_pitch_rad[i] = bp;
            tr.body_roll_rad[i] = br;
            tr.pitch_rad[i] = quantize(rp + bp, precision::ANGLE);
            tr.roll_rad[i] = quantize(rr + br, precision::ANGLE);
            if let Some(ws) = &mut tr.wheel_steer_rad {
                ws[i] = quantize(steer, precision::ANGLE);
            }
            if let Some(sp) = &mut tr.wheel_spin_rad {
                sp[i] = quantize(spin, precision::ANGLE);
            }
        }

        // Lights: derived channels, then authored cues.
        let mut lights: Vec<LightChange> = Vec::new();
        if is_vehicle || is_two_wheeler {
            let mut state: BTreeMap<LightKind, LightMode> = LightKind::ALL
                .iter()
                .map(|k| (*k, LightMode::Off))
                .collect();
            let mut set =
                |lights: &mut Vec<LightChange>, tick: usize, light: LightKind, mode: LightMode| {
                    if state.get(&light) != Some(&mode) {
                        state.insert(light, mode);
                        lights.push(LightChange {
                            tick: tick as u32,
                            light,
                            mode,
                        });
                    }
                };
            let mut braking = false;
            let cues: &[(u32, bool)] = brake_cues.get(id.as_str()).map_or(&[], Vec::as_slice);
            let mut authored: Option<bool> = None;
            let mut next_cue = 0;
            for i in 0..n {
                while next_cue < cues.len() && cues[next_cue].0 as usize <= i {
                    authored = Some(cues[next_cue].1);
                    next_cue += 1;
                }
                let on = present[i] == 1;
                let fresh = on && (i == 0 || present[i - 1] != 1);
                let low = on && low_beams;
                set(
                    &mut lights,
                    i,
                    LightKind::LowBeam,
                    if low { LightMode::On } else { LightMode::Off },
                );
                let reversing = on && src.motion_direction[i] == MotionDirection::Reverse;
                set(
                    &mut lights,
                    i,
                    LightKind::Reverse,
                    if reversing {
                        LightMode::On
                    } else {
                        LightMode::Off
                    },
                );
                if !on || fresh {
                    braking = false;
                } else {
                    let v0 = tr.speed_mps[i - 1].abs();
                    let v1 = tr.speed_mps[i].abs();
                    let decel = (v0 - v1) / dt;
                    braking = if decel >= body::BRAKE_ON_MPS2 {
                        true
                    } else if braking {
                        decel >= body::BRAKE_HOLD_MPS2 || v1 < body::STOPPED_MPS
                    } else {
                        false
                    };
                }
                let brake = on && authored.unwrap_or(braking);
                set(
                    &mut lights,
                    i,
                    LightKind::Brake,
                    if brake { LightMode::On } else { LightMode::Off },
                );
            }
        }
        if let Some(cues) = cue_changes.get(id.as_str()) {
            lights.extend(cues.iter().copied());
        }
        // Stable: derived first, then cues in event order; a cue at the same
        // tick for the same light replaces the earlier entry.
        lights.sort_by(|a, b| a.tick.cmp(&b.tick).then(a.light.cmp(&b.light)));
        let mut dedup: Vec<LightChange> = Vec::with_capacity(lights.len());
        for change in lights {
            match dedup.last_mut() {
                Some(last) if last.tick == change.tick && last.light == change.light => {
                    *last = change
                }
                _ => dedup.push(change),
            }
        }

        actors.push(TimelineActor {
            id: id.clone(),
            kind,
            catalog_id: catalog_id_for(kind, &meta.tags),
            actor_class: actor_class_of(kind),
            dims,
            color: meta
                .tags
                .iter()
                .find_map(|t| t.strip_prefix("color:"))
                .map(str::to_owned),
            is_static: meta.is_static,
            origin: actor_origin(&meta.tags, ambient.contains(id.as_str())),
            lifecycle: lifecycle_of(&present),
            track: tr,
            lights: dedup,
        });
    }

    let mut props = Vec::with_capacity(header.prop_metadata.len());
    for (id, prop) in &header.prop_metadata {
        let local = prop.pose.position_local();
        let x = quantize(local.x, precision::POSITION);
        let y = quantize(local.y, precision::POSITION);
        let z = height
            .elevation(
                x,
                y,
                HeightQuery {
                    preferred_road: None,
                    label: Some(id),
                },
            )
            .map_err(|error| TimelineError::PropHeight {
                prop_id: id.clone(),
                error,
            })?;
        props.push(TimelineProp {
            id: id.clone(),
            catalog_id: prop.catalog_id.clone(),
            x,
            y,
            z: quantize(z, precision::HEIGHT),
            heading_rad: quantize(prop.pose.heading_rad, precision::ANGLE),
            dims: prop.dims,
            scale: prop.scale,
        });
    }

    let mut signals = BTreeMap::new();
    for (id, track) in &trace.ticks.signals {
        let mut changes: Vec<SignalChange> = Vec::new();
        for (i, phase) in track.phase.iter().enumerate() {
            if changes.last().map(|c| c.indication) != Some(*phase) {
                changes.push(SignalChange {
                    tick: i as u32,
                    indication: *phase,
                });
            }
        }
        signals.insert(id.clone(), changes);
    }

    let clip_end_s = *t.last().unwrap_or(&0.0);
    let timeline = RenderTimeline {
        version: RENDER_TIMELINE_VERSION.to_owned(),
        identity: TimelineIdentity {
            trace_sha256: identity.trace_sha256.clone(),
            height_field_digest: source.digest.clone(),
            catalog_digest: catalog_digest.map(str::to_owned),
            sampler_version: SAMPLER_VERSION.to_owned(),
            timeline_key: key,
        },
        trace: identity,
        height_source: source,
        map_id: header.map_id.clone(),
        frame: "xodr-local".to_owned(),
        dt_s: TIMELINE_DT_S,
        tick_count: n as u32,
        t,
        time: TimeOrigin {
            time_origin_s: 0.0,
            warmup_s: header.warmup_seconds,
            clip_end_s,
            xosc_time_offset_s: header.warmup_seconds,
        },
        environment: TimelineEnvironment {
            weather,
            time_of_day,
            profile: RenderProfile::Sensor,
            low_beams,
        },
        actors,
        props,
        signals,
    };
    timeline.validate()?;
    Ok(timeline)
}

#[cfg(test)]
mod tests;
