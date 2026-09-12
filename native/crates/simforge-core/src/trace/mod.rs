//! The trace format — the engine's only output — and everything that feeds it.
//!
//! Columnar per actor: one array per channel, index-aligned with `ticks.t`.
//! `header.frame` is always `xodr-local` (`x` east, `y` north, headings CCW
//! from `+x`); consumers that draw in the y-up scene frame apply
//! [`crate::math::to_scene_xz`] or use [`scene_state`].
//!
//! Only `t ∈ [0, clipSeconds]` is recorded; the warm-up prologue is excluded
//! by construction. Only the current format ([`TRACE_FORMAT_VERSION`]) is
//! accepted: there is no read path for older envelopes and no channel
//! backfill. A document missing a mandatory channel is rejected, not repaired.
//!
//! Sub-modules:
//! - [`events`] — the discrete [`SimEvent`] stream.
//! - [`recorder`] — per-tick [`recorder::ActorFrame`] capture into channels.
//! - [`pairs`] — pairwise kinematic readouts (clearance, TTC, path conflict).
//! - [`metrics`] — the online [`metrics::MetricAccumulator`] behind [`EpisodeMetrics`].
//! - [`perception`] — sensor channels and the perception episode summary.
//! - [`ledger`] — the runtime-neutral semantic ledger.
//! - [`scene_state`] — the `simforge.scene-state.v1` render document.

pub mod events;
pub mod ledger;
pub mod metrics;
pub mod monitored_pairs;
pub mod pairs;
pub mod perception;
pub mod recorder;
pub mod scene_state;

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::math::quantize;
use crate::physics::MotionDirection;
use crate::rng::Seed;
use crate::types::{
    ActorKind, ControlIndication, Dims, MotionPhysicsMode, OperationalConditions, StaticProp,
};

pub use events::{AbortReason, CrashReason, DespawnReason, ReleasedReason, SimEvent};
pub use ledger::SemanticLedger;
pub use metrics::{
    criticality_window, CollisionRecord, CriticalitySamples, DeclaredOcclusionMetric,
    DeclaredOcclusionStatus, EpisodeMetrics, InvariantResidual, MetricAccumulator,
    MinPathTtcRecord, MinPetRecord, MinTtcRecord, OccluderIneffective, PairMinDistance,
    RevealToConflict,
};
pub use perception::{
    DetectionGap, MapDivergenceMetric, MapDivergenceTrack, PerceptionAccumulator,
    PerceptionMetrics, SensorPerceptionMetric, SensorTargetTrack, SensorTrack,
};
pub use recorder::{
    ActorFrame, PhysicsFrame, RecordedTicks, SignalFrame, TraceCapture, TraceRecorder,
};

/// v4: mandatory lane-relative lateral-offset actor channel. Unknown versions
/// fail closed.
pub const TRACE_FORMAT_VERSION: u32 = 4;

/// Decimal places each channel is quantised to before serialisation.
pub mod precision {
    pub const T: i32 = 6;
    pub const POSITION: i32 = 4;
    pub const HEADING: i32 = 6;
    pub const SPEED: i32 = 4;
    pub const S: i32 = 4;
    pub const EVENT: i32 = 6;
    pub const METRIC: i32 = 6;
    pub const SENSOR_CONFIDENCE: i32 = 4;
    pub const SENSOR_RANGE: i32 = 3;
}

/// A trace document violated the current format contract.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum TraceError {
    #[error("header.traceVersion {found} is not the current trace format {expected}")]
    UnsupportedVersion { found: u32, expected: u32 },
    #[error("{channel} length {found} does not match ticks.t length {expected}")]
    ChannelLength {
        channel: String,
        found: usize,
        expected: usize,
    },
    #[error("{channel} contains a non-finite value at index {index}")]
    NonFinite { channel: String, index: usize },
    #[error("{channel} contains {value} at index {index}; present must be 0 or 1")]
    InvalidPresent {
        channel: String,
        index: usize,
        value: u8,
    },
    #[error("header.frame must be xodr-local")]
    InvalidFrame,
    #[error("header.actorIds does not match ticks.actors keys")]
    ActorSetMismatch,
    #[error("actor {actor_id} has no actorMetadata entry")]
    MissingActorMetadata { actor_id: String },
    #[error(
        "actor {actor_id} declares a physics backend but its track carries no physics channels"
    )]
    MissingPhysicsChannels { actor_id: String },
    #[error("recorder actor frame count {found} does not match {expected} registered actors")]
    FrameCount { found: usize, expected: usize },
    #[error("recorder signal phase count {found} does not match {expected} registered signals")]
    SignalCount { found: usize, expected: usize },
    #[error("actor {actor_id} is registered with physics channels but tick {tick} carries no physics frame")]
    MissingPhysicsFrame { actor_id: String, tick: usize },
    #[error("actor {actor_id} lateral offset is non-finite at tick {tick}")]
    NonFiniteLateral { actor_id: String, tick: usize },
    #[error("recorder is in streaming capture mode and holds no accumulated trace")]
    StreamingCapture,
    #[error("trace JSON: {0}")]
    Json(String),
}

impl From<serde_json::Error> for TraceError {
    fn from(e: serde_json::Error) -> Self {
        TraceError::Json(e.to_string())
    }
}

/* ------------------------------------------------------------------ tracks */

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActorTrack {
    pub x: Vec<f64>,
    pub y: Vec<f64>,
    pub heading_rad: Vec<f64>,
    pub speed_mps: Vec<f64>,
    /// Lane-relative lateral state, retained for maneuver/OSC conformance.
    pub lateral_offset_m: Vec<f64>,
    /// `-1` for authored rear-first motion, `1` for forward motion.
    pub motion_direction: Vec<MotionDirection>,
    pub lane_rsl: Vec<Option<String>>,
    /// Route arc length, metres.
    pub s: Vec<f64>,
    /// 1 while the actor exists in the world, 0 before spawn / after despawn.
    pub present: Vec<u8>,
    /// Force-based backend telemetry. Absent on archived traces recorded by
    /// the removed choreography backend, and for bodies with no plant.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub physics: Option<ActorPhysicsTrack>,
    /// Clip time at which this body was knocked off its feet, absent while it
    /// stayed on them. A scalar: the state is monotonic in a planar engine.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub down_since_s: Option<f64>,
}

impl ActorTrack {
    pub fn with_capacity(ticks: usize, physics: bool) -> Self {
        Self {
            x: Vec::with_capacity(ticks),
            y: Vec::with_capacity(ticks),
            heading_rad: Vec::with_capacity(ticks),
            speed_mps: Vec::with_capacity(ticks),
            lateral_offset_m: Vec::with_capacity(ticks),
            motion_direction: Vec::with_capacity(ticks),
            lane_rsl: Vec::with_capacity(ticks),
            s: Vec::with_capacity(ticks),
            present: Vec::with_capacity(ticks),
            physics: physics.then(|| ActorPhysicsTrack::with_capacity(ticks)),
            down_since_s: None,
        }
    }

    pub fn is_present(&self, index: usize) -> bool {
        self.present.get(index).is_some_and(|p| *p == 1)
    }

    fn validate(&self, actor_id: &str, ticks: usize) -> Result<(), TraceError> {
        let channel = |name: &str| format!("ticks.actors.{actor_id}.{name}");
        check_len(&channel("x"), self.x.len(), ticks)?;
        check_len(&channel("y"), self.y.len(), ticks)?;
        check_len(&channel("headingRad"), self.heading_rad.len(), ticks)?;
        check_len(&channel("speedMps"), self.speed_mps.len(), ticks)?;
        check_len(
            &channel("lateralOffsetM"),
            self.lateral_offset_m.len(),
            ticks,
        )?;
        check_len(
            &channel("motionDirection"),
            self.motion_direction.len(),
            ticks,
        )?;
        check_len(&channel("laneRsl"), self.lane_rsl.len(), ticks)?;
        check_len(&channel("s"), self.s.len(), ticks)?;
        check_len(&channel("present"), self.present.len(), ticks)?;
        check_finite(&channel("x"), &self.x)?;
        check_finite(&channel("y"), &self.y)?;
        check_finite(&channel("headingRad"), &self.heading_rad)?;
        check_finite(&channel("speedMps"), &self.speed_mps)?;
        check_finite(&channel("lateralOffsetM"), &self.lateral_offset_m)?;
        check_finite(&channel("s"), &self.s)?;
        if let Some((index, value)) = self.present.iter().enumerate().find(|(_, p)| **p > 1) {
            return Err(TraceError::InvalidPresent {
                channel: channel("present"),
                index,
                value: *value,
            });
        }
        if let Some(physics) = &self.physics {
            physics.validate(actor_id, ticks)?;
        }
        Ok(())
    }

    fn quantize(&mut self) {
        quantize_all(&mut self.x, precision::POSITION);
        quantize_all(&mut self.y, precision::POSITION);
        quantize_all(&mut self.heading_rad, precision::HEADING);
        quantize_all(&mut self.speed_mps, precision::SPEED);
        quantize_all(&mut self.lateral_offset_m, precision::POSITION);
        quantize_all(&mut self.s, precision::S);
        if let Some(physics) = &mut self.physics {
            physics.quantize();
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActorPhysicsTrack {
    pub vx_body_mps: Vec<f64>,
    pub vy_body_mps: Vec<f64>,
    pub yaw_rate_radps: Vec<f64>,
    pub steer_rad: Vec<f64>,
    pub wheel_angular_speed_radps: Vec<f64>,
    /// Peak axle/tire force as a fraction of the friction-circle limit.
    pub tire_utilization: Vec<f64>,
    pub front_normal_force_n: Vec<f64>,
    pub rear_normal_force_n: Vec<f64>,
    /// Sum of normal collision impulses applied during the preceding tick.
    pub collision_impulse_ns: Vec<f64>,
    pub collision_count: Vec<f64>,
}

impl ActorPhysicsTrack {
    pub fn with_capacity(ticks: usize) -> Self {
        Self {
            vx_body_mps: Vec::with_capacity(ticks),
            vy_body_mps: Vec::with_capacity(ticks),
            yaw_rate_radps: Vec::with_capacity(ticks),
            steer_rad: Vec::with_capacity(ticks),
            wheel_angular_speed_radps: Vec::with_capacity(ticks),
            tire_utilization: Vec::with_capacity(ticks),
            front_normal_force_n: Vec::with_capacity(ticks),
            rear_normal_force_n: Vec::with_capacity(ticks),
            collision_impulse_ns: Vec::with_capacity(ticks),
            collision_count: Vec::with_capacity(ticks),
        }
    }

    fn channels_mut(&mut self) -> [(&'static str, &mut Vec<f64>); 10] {
        [
            ("vxBodyMps", &mut self.vx_body_mps),
            ("vyBodyMps", &mut self.vy_body_mps),
            ("yawRateRadps", &mut self.yaw_rate_radps),
            ("steerRad", &mut self.steer_rad),
            (
                "wheelAngularSpeedRadps",
                &mut self.wheel_angular_speed_radps,
            ),
            ("tireUtilization", &mut self.tire_utilization),
            ("frontNormalForceN", &mut self.front_normal_force_n),
            ("rearNormalForceN", &mut self.rear_normal_force_n),
            ("collisionImpulseNs", &mut self.collision_impulse_ns),
            ("collisionCount", &mut self.collision_count),
        ]
    }

    fn channels(&self) -> [(&'static str, &Vec<f64>); 10] {
        [
            ("vxBodyMps", &self.vx_body_mps),
            ("vyBodyMps", &self.vy_body_mps),
            ("yawRateRadps", &self.yaw_rate_radps),
            ("steerRad", &self.steer_rad),
            ("wheelAngularSpeedRadps", &self.wheel_angular_speed_radps),
            ("tireUtilization", &self.tire_utilization),
            ("frontNormalForceN", &self.front_normal_force_n),
            ("rearNormalForceN", &self.rear_normal_force_n),
            ("collisionImpulseNs", &self.collision_impulse_ns),
            ("collisionCount", &self.collision_count),
        ]
    }

    fn validate(&self, actor_id: &str, ticks: usize) -> Result<(), TraceError> {
        for (name, values) in self.channels() {
            let channel = format!("ticks.actors.{actor_id}.physics.{name}");
            check_len(&channel, values.len(), ticks)?;
            check_finite(&channel, values)?;
        }
        Ok(())
    }

    fn quantize(&mut self) {
        for (_, values) in self.channels_mut() {
            quantize_all(values, precision::SPEED);
        }
    }
}

/// Export/render-ready phase channel for one concrete signal program.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SignalTrack {
    pub phase: Vec<ControlIndication>,
}

/* ------------------------------------------------------------------ header */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TraceSource {
    #[serde(rename = "sim-engine")]
    SimEngine,
    #[serde(rename = "openscenario-replay")]
    OpenScenarioReplay,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum EgoControllerProfile {
    #[serde(rename = "sensor-limited")]
    SensorLimited,
    #[serde(rename = "external-replay")]
    ExternalReplay,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EgoProvenance {
    pub controller_profile: EgoControllerProfile,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TraceFrame {
    #[serde(rename = "xodr-local")]
    XodrLocal,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceActorMetadata {
    pub kind: ActorKind,
    pub dims: Dims,
    #[serde(rename = "static")]
    pub is_static: bool,
    pub tags: Vec<String>,
}

/// Motion backend an actor track was produced by. `kinematic-v1` names the
/// removed choreography backend: nothing records it any more, but archived
/// traces must keep parsing so they still replay.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ActorBackendMode {
    #[serde(rename = "kinematic-v1")]
    KinematicV1,
    #[serde(rename = "dynamic-v1")]
    DynamicV1,
    #[serde(rename = "fixed-static-v1")]
    FixedStaticV1,
}

/// Motion semantics a trace header was recorded under. Distinct from
/// [`MotionPhysicsMode`], which is the *input* selection and no longer has a
/// kinematic value; provenance keeps the legacy string readable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RecordedPhysicsMode {
    #[serde(rename = "kinematic-v1")]
    KinematicV1,
    #[serde(rename = "dynamic-v1")]
    DynamicV1,
}

impl From<MotionPhysicsMode> for ActorBackendMode {
    fn from(mode: MotionPhysicsMode) -> Self {
        match mode {
            MotionPhysicsMode::DynamicV1 => ActorBackendMode::DynamicV1,
        }
    }
}

impl From<MotionPhysicsMode> for RecordedPhysicsMode {
    fn from(mode: MotionPhysicsMode) -> Self {
        match mode {
            MotionPhysicsMode::DynamicV1 => RecordedPhysicsMode::DynamicV1,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ActorBackendReason {
    Selected,
    StaticActor,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActorBackendProfile {
    Kind(ActorKind),
    FixedStatic,
}

impl Serialize for ActorBackendProfile {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Kind(kind) => kind.serialize(serializer),
            Self::FixedStatic => serializer.serialize_str("fixed-static"),
        }
    }
}

impl<'de> Deserialize<'de> for ActorBackendProfile {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct ProfileVisitor;

        impl<'de> serde::de::Visitor<'de> for ProfileVisitor {
            type Value = ActorBackendProfile;

            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("an actor kind or fixed-static")
            }

            fn visit_str<E: serde::de::Error>(self, value: &str) -> Result<Self::Value, E> {
                if value == "fixed-static" {
                    Ok(ActorBackendProfile::FixedStatic)
                } else {
                    ActorKind::deserialize(serde::de::value::StrDeserializer::<E>::new(value))
                        .map(ActorBackendProfile::Kind)
                }
            }
        }

        deserializer.deserialize_str(ProfileVisitor)
    }
}

#[cfg(test)]
mod actor_backend_profile_tests {
    use super::ActorBackendProfile;

    #[test]
    fn fixed_static_profile_round_trips_as_the_trace_wire_string() {
        let wire = "\"fixed-static\"";
        let profile: ActorBackendProfile = serde_json::from_str(wire).unwrap();
        assert_eq!(profile, ActorBackendProfile::FixedStatic);
        assert_eq!(serde_json::to_string(&profile).unwrap(), wire);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActorPhysicsBackendProvenance {
    pub mode: ActorBackendMode,
    pub reason: ActorBackendReason,
    /// Exact class-native dynamics profile used by the moving solver.
    pub profile: ActorBackendProfile,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActorCrashRecord {
    pub t: f64,
    pub other_id: String,
    pub reason: CrashReason,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TraceSolver {
    #[serde(rename = "uniscenarios-sim-engine")]
    UniscenariosSimEngine,
}

/// Executed motion semantics; consumers must not infer fidelity from tracks.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhysicsTraceProvenance {
    pub mode: RecordedPhysicsMode,
    pub solver: TraceSolver,
    pub solver_version: String,
    /// Actual integration/substep interval used by the selected solver.
    pub substep_s: f64,
    /// sha256 of vehicleProfiles, or null when no profiles were supplied.
    pub vehicle_profile_digest: Option<String>,
    /// Digest of the complete class defaults plus per-actor overrides.
    pub resolved_profile_digest: String,
    /// Executed backend per actor.
    pub actor_backends: BTreeMap<String, ActorPhysicsBackendProvenance>,
    /// First material impact per moving actor. Empty means no crash occurred.
    pub crashes: BTreeMap<String, ActorCrashRecord>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceHeader {
    pub trace_version: u32,
    pub engine_version: String,
    /// `sha256(canonicalJson(parsedInput))`.
    pub input_hash: String,
    /// Origin of an adapted immutable trace. Absent on native sim-engine
    /// traces for hash stability.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<TraceSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_xosc_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub materialized_traffic_digest: Option<String>,
    pub seed: Seed,
    pub map_id: String,
    /// Engine graph digest (source XODR sha256).
    pub engine_graph_digest: String,
    pub dt: f64,
    pub clip_seconds: f64,
    pub warmup_seconds: f64,
    pub frame: TraceFrame,
    pub actor_ids: Vec<String>,
    /// Render-facing identity keyed by actor id.
    pub actor_metadata: BTreeMap<String, TraceActorMetadata>,
    /// Complete fixed-prop closure copied from the parsed input (scene frame).
    pub prop_metadata: BTreeMap<String, StaticProp>,
    /// Ids of generated background road users, sorted; absent when none.
    /// These bodies are followed, yielded to, collidable and rendered but
    /// excluded from every episode criticality metric.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ambient_actor_ids: Option<Vec<String>>,
    /// Optional catalog-cell provenance attached by batch/materialization layers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub catalog_slot: Option<Value>,
    pub metric_subject: Option<String>,
    pub ego: EgoProvenance,
    /// Exact hash-covered ambient conditions executed by this trace.
    pub operational_conditions: OperationalConditions,
    pub physics: PhysicsTraceProvenance,
}

/* ------------------------------------------------------------------- trace */

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceTicks {
    pub t: Vec<f64>,
    pub actors: BTreeMap<String, ActorTrack>,
    /// Empty on unsignalized maps.
    pub signals: BTreeMap<String, SignalTrack>,
    /// Per-sensor perception channel keyed `observerId/sensorId`; present
    /// only when an actor declares a sensor.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sensors: Option<BTreeMap<String, SensorTrack>>,
    /// Declared map/percept divergence exposure keyed `divergenceId/observerId`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub map_divergence: Option<BTreeMap<String, MapDivergenceTrack>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SimTrace {
    pub header: TraceHeader,
    pub ticks: TraceTicks,
    pub events: Vec<SimEvent>,
    pub metrics: EpisodeMetrics,
    /// Runtime-neutral behavioral evidence; every current trace includes it.
    pub semantic_ledger: SemanticLedger,
}

impl SimTrace {
    /// Parse and validate a current-format trace document.
    pub fn from_json_slice(bytes: &[u8]) -> Result<Self, TraceError> {
        let trace: SimTrace = serde_json::from_slice(bytes)?;
        trace.validate()?;
        Ok(trace)
    }

    /// Reject anything that is not a complete current-format trace.
    pub fn validate(&self) -> Result<(), TraceError> {
        if self.header.trace_version != TRACE_FORMAT_VERSION {
            return Err(TraceError::UnsupportedVersion {
                found: self.header.trace_version,
                expected: TRACE_FORMAT_VERSION,
            });
        }
        if self.header.frame != TraceFrame::XodrLocal {
            return Err(TraceError::InvalidFrame);
        }
        let ticks = self.ticks.t.len();
        check_finite("ticks.t", &self.ticks.t)?;
        if self.header.actor_ids.len() != self.ticks.actors.len()
            || !self
                .header
                .actor_ids
                .iter()
                .all(|id| self.ticks.actors.contains_key(id))
        {
            return Err(TraceError::ActorSetMismatch);
        }
        for (id, track) in &self.ticks.actors {
            if !self.header.actor_metadata.contains_key(id) {
                return Err(TraceError::MissingActorMetadata {
                    actor_id: id.clone(),
                });
            }
            track.validate(id, ticks)?;
            let dynamic = self
                .header
                .physics
                .actor_backends
                .get(id)
                .is_some_and(|b| b.mode == ActorBackendMode::DynamicV1);
            if dynamic && track.physics.is_none() {
                return Err(TraceError::MissingPhysicsChannels {
                    actor_id: id.clone(),
                });
            }
        }
        for (id, track) in &self.ticks.signals {
            check_len(
                &format!("ticks.signals.{id}.phase"),
                track.phase.len(),
                ticks,
            )?;
        }
        if let Some(sensors) = &self.ticks.sensors {
            for (key, track) in sensors {
                track.validate(key, ticks)?;
            }
        }
        if let Some(divergence) = &self.ticks.map_divergence {
            for (key, track) in divergence {
                check_len(
                    &format!("ticks.mapDivergence.{key}.active"),
                    track.active.len(),
                    ticks,
                )?;
            }
        }
        Ok(())
    }

    /// Quantise every channel in place — the last step before a trace is
    /// compared, hashed or written.
    pub fn quantize(&mut self) {
        quantize_all(&mut self.ticks.t, precision::T);
        for track in self.ticks.actors.values_mut() {
            track.quantize();
        }
        if let Some(sensors) = &mut self.ticks.sensors {
            for track in sensors.values_mut() {
                track.quantize();
            }
        }
        for event in &mut self.events {
            let t = event.t_mut();
            *t = quantize(*t, precision::EVENT);
        }
        self.metrics.quantize();
        self.semantic_ledger.quantize();
    }

    pub fn actor_dims(&self, actor_id: &str) -> Option<&Dims> {
        self.header.actor_metadata.get(actor_id).map(|m| &m.dims)
    }

    /// Content digest of the canonical trace bytes:
    /// `sha256(canonicalJson(quantized trace))`. The trace is quantised on a
    /// clone, so the caller's copy is unchanged.
    pub fn digest(&self) -> Result<String, crate::error::CoreError> {
        let mut quantized = self.clone();
        quantized.quantize();
        crate::hash::content_hash_of(&quantized)
    }
}

/* ----------------------------------------------------------------- helpers */

pub(crate) fn check_len(channel: &str, found: usize, expected: usize) -> Result<(), TraceError> {
    if found != expected {
        return Err(TraceError::ChannelLength {
            channel: channel.to_owned(),
            found,
            expected,
        });
    }
    Ok(())
}

pub(crate) fn check_finite(channel: &str, values: &[f64]) -> Result<(), TraceError> {
    match values.iter().position(|v| !v.is_finite()) {
        Some(index) => Err(TraceError::NonFinite {
            channel: channel.to_owned(),
            index,
        }),
        None => Ok(()),
    }
}

pub(crate) fn quantize_all(values: &mut [f64], decimals: i32) {
    for v in values {
        *v = quantize(*v, decimals);
    }
}

pub(crate) fn quantize_opt(value: &mut Option<f64>, decimals: i32) {
    if let Some(v) = value {
        *v = quantize(*v, decimals);
    }
}

/// Quantise every number inside a decoded JSON value to `decimals` places —
/// the ledger's opaque environment/sensor blocks are quantised exactly like
/// the typed metrics.
pub(crate) fn quantize_value(value: &mut Value, decimals: i32) {
    match value {
        Value::Number(n) => {
            if let Some(f) = n.as_f64() {
                if let Some(q) = serde_json::Number::from_f64(quantize(f, decimals)) {
                    *n = q;
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(|v| quantize_value(v, decimals)),
        Value::Object(map) => map.values_mut().for_each(|v| quantize_value(v, decimals)),
        _ => {}
    }
}
