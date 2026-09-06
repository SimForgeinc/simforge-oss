//! Per-tick capture of the columnar trace channels.
//!
//! The engine hands the recorder one [`ActorFrame`] per registered actor and
//! one [`SignalFrame`] per registered signal, in registration order, once per
//! recorded tick. Capture mode decides what is kept:
//!
//! - [`TraceCapture::Full`] preallocates every channel for the clip and
//!   accumulates the complete trace for [`TraceRecorder::finish`].
//! - [`TraceCapture::Streaming`] keeps only the last frame per actor/signal
//!   (for live subscribers and `peek`) and never grows, so a long-running
//!   world cannot accumulate an unbounded trace. `finish` refuses.
//!
//! The recorder is plain serialisable state: a checkpoint carries it verbatim
//! and continuation appends to the same channels.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::physics::MotionDirection;
use crate::types::ControlIndication;

use super::perception::{MapDivergenceTrack, SensorTrack};
use super::{
    ActorPhysicsTrack, ActorTrack, EpisodeMetrics, SemanticLedger, SignalTrack, SimEvent, SimTrace,
    TraceError, TraceHeader, TraceTicks, TRACE_FORMAT_VERSION,
};

/// Force-based backend telemetry for one actor on one tick.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhysicsFrame {
    pub vx_body_mps: f64,
    pub vy_body_mps: f64,
    pub yaw_rate_radps: f64,
    pub steer_rad: f64,
    pub wheel_angular_speed_radps: f64,
    pub tire_utilization: f64,
    pub front_normal_force_n: f64,
    pub rear_normal_force_n: f64,
    pub collision_impulse_ns: f64,
    pub collision_count: u32,
}

/// One actor's observable state on one recorded tick. Borrowed strings: the
/// recorder copies only what the channel stores.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ActorFrame<'a> {
    pub x: f64,
    pub y: f64,
    pub heading_rad: f64,
    pub speed_mps: f64,
    pub lateral_offset_m: f64,
    pub motion_direction: MotionDirection,
    pub lane_rsl: Option<&'a str>,
    /// Route arc length, metres.
    pub s: f64,
    pub present: bool,
    /// Required for every actor registered with physics channels.
    pub physics: Option<PhysicsFrame>,
    /// Identity of the route the actor currently follows (`route:<hash>`),
    /// feeding the semantic ledger's `routeRef` channel.
    pub route_ref: &'a str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SignalFrame {
    pub phase: ControlIndication,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TraceCapture {
    /// Accumulate the whole clip.
    Full,
    /// Retain only the latest frame; no trace can be finished.
    Streaming,
}

/// The latest frame per actor, owned, for live consumers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LatestActorFrame {
    pub x: f64,
    pub y: f64,
    pub heading_rad: f64,
    pub speed_mps: f64,
    pub lateral_offset_m: f64,
    pub motion_direction: MotionDirection,
    pub lane_rsl: Option<String>,
    pub s: f64,
    pub present: bool,
    pub physics: Option<PhysicsFrame>,
    pub route_ref: String,
}

impl LatestActorFrame {
    fn from_frame(frame: &ActorFrame<'_>) -> Self {
        let mut out = Self {
            x: 0.0,
            y: 0.0,
            heading_rad: 0.0,
            speed_mps: 0.0,
            lateral_offset_m: 0.0,
            motion_direction: MotionDirection::Forward,
            lane_rsl: None,
            s: 0.0,
            present: false,
            physics: None,
            route_ref: String::new(),
        };
        out.update(frame);
        out
    }

    fn update(&mut self, frame: &ActorFrame<'_>) {
        self.x = frame.x;
        self.y = frame.y;
        self.heading_rad = frame.heading_rad;
        self.speed_mps = frame.speed_mps;
        self.lateral_offset_m = frame.lateral_offset_m;
        self.motion_direction = frame.motion_direction;
        // Reuse the existing allocation when the lane did not change.
        match frame.lane_rsl {
            Some(next) => {
                if self.lane_rsl.as_deref() != Some(next) {
                    let mut buf = self.lane_rsl.take().unwrap_or_default();
                    buf.clear();
                    buf.push_str(next);
                    self.lane_rsl = Some(buf);
                }
            }
            None => self.lane_rsl = None,
        }
        self.s = frame.s;
        self.present = frame.present;
        self.physics = frame.physics;
        if self.route_ref != frame.route_ref {
            self.route_ref.clear();
            self.route_ref.push_str(frame.route_ref);
        }
    }
}

/// The accumulated columnar channels of a full capture.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordedTicks {
    pub t: Vec<f64>,
    /// Indexed like the recorder's registration order.
    pub actors: Vec<ActorTrack>,
    /// Route identity per actor per tick, parallel to `actors`.
    pub route_refs: Vec<Vec<String>>,
    pub signals: Vec<SignalTrack>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceRecorder {
    capture: TraceCapture,
    /// Registration order; the trace itself is keyed by sorted id.
    actor_ids: Vec<String>,
    /// Parallel to `actor_ids`: whether the actor records physics channels.
    physics: Vec<bool>,
    signal_ids: Vec<String>,
    /// `Some` in full capture.
    ticks: Option<RecordedTicks>,
    latest_t: Option<f64>,
    latest_actors: Vec<Option<LatestActorFrame>>,
    latest_signals: Vec<Option<ControlIndication>>,
    len: u64,
}

impl TraceRecorder {
    /// `actor_ids`/`signal_ids` fix the registration order for every later
    /// `record_tick`; `physics_actor_ids` names the actors whose frames must
    /// carry telemetry. `expected_ticks` preallocates every channel.
    pub fn new(
        actor_ids: impl IntoIterator<Item = impl Into<String>>,
        signal_ids: impl IntoIterator<Item = impl Into<String>>,
        physics_actor_ids: &[&str],
        capture: TraceCapture,
        expected_ticks: usize,
    ) -> Self {
        let actor_ids: Vec<String> = actor_ids.into_iter().map(Into::into).collect();
        let signal_ids: Vec<String> = signal_ids.into_iter().map(Into::into).collect();
        let physics: Vec<bool> = actor_ids
            .iter()
            .map(|id| physics_actor_ids.contains(&id.as_str()))
            .collect();
        let ticks = match capture {
            TraceCapture::Full => Some(RecordedTicks {
                t: Vec::with_capacity(expected_ticks),
                actors: physics
                    .iter()
                    .map(|p| ActorTrack::with_capacity(expected_ticks, *p))
                    .collect(),
                route_refs: actor_ids
                    .iter()
                    .map(|_| Vec::with_capacity(expected_ticks))
                    .collect(),
                signals: signal_ids
                    .iter()
                    .map(|_| SignalTrack {
                        phase: Vec::with_capacity(expected_ticks),
                    })
                    .collect(),
            }),
            TraceCapture::Streaming => None,
        };
        Self {
            capture,
            latest_actors: vec![None; actor_ids.len()],
            latest_signals: vec![None; signal_ids.len()],
            actor_ids,
            physics,
            signal_ids,
            ticks,
            latest_t: None,
            len: 0,
        }
    }

    pub fn capture(&self) -> TraceCapture {
        self.capture
    }

    pub fn actor_ids(&self) -> &[String] {
        &self.actor_ids
    }

    pub fn signal_ids(&self) -> &[String] {
        &self.signal_ids
    }

    /// Recorded ticks so far (counts in both capture modes).
    pub fn len(&self) -> u64 {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// Clip time of the last recorded tick.
    pub fn recorded_until(&self) -> Option<f64> {
        self.latest_t
    }

    /// Register an actor that joined after construction (spawned ambient
    /// traffic). In full capture its channels are back-filled as absent for
    /// every tick already recorded, so every channel stays index-aligned.
    pub fn add_actor(&mut self, actor_id: &str, physics: bool) -> usize {
        let index = self.actor_ids.len();
        self.actor_ids.push(actor_id.to_owned());
        self.physics.push(physics);
        self.latest_actors.push(None);
        if let Some(ticks) = &mut self.ticks {
            let n = ticks.t.len();
            let mut track = ActorTrack::with_capacity(n, physics);
            track.x.resize(n, 0.0);
            track.y.resize(n, 0.0);
            track.heading_rad.resize(n, 0.0);
            track.speed_mps.resize(n, 0.0);
            track.lateral_offset_m.resize(n, 0.0);
            track.motion_direction.resize(n, MotionDirection::Forward);
            track.lane_rsl.resize(n, None);
            track.s.resize(n, 0.0);
            track.present.resize(n, 0);
            if let Some(p) = &mut track.physics {
                for _ in 0..n {
                    push_physics(p, &PhysicsFrame::default());
                }
            }
            ticks.actors.push(track);
            ticks.route_refs.push(vec![String::new(); n]);
        }
        index
    }

    /// Record one tick. Frames are in registration order; a mismatch in
    /// count, a missing physics frame for a physics actor, or a non-finite
    /// lateral offset is rejected rather than silently recorded.
    pub fn record_tick(
        &mut self,
        t: f64,
        actors: &[ActorFrame<'_>],
        signals: &[SignalFrame],
    ) -> Result<(), TraceError> {
        if actors.len() != self.actor_ids.len() {
            return Err(TraceError::FrameCount {
                found: actors.len(),
                expected: self.actor_ids.len(),
            });
        }
        if signals.len() != self.signal_ids.len() {
            return Err(TraceError::SignalCount {
                found: signals.len(),
                expected: self.signal_ids.len(),
            });
        }
        let tick = self.len as usize;
        for (i, frame) in actors.iter().enumerate() {
            if self.physics[i] && frame.physics.is_none() {
                return Err(TraceError::MissingPhysicsFrame {
                    actor_id: self.actor_ids[i].clone(),
                    tick,
                });
            }
            if !frame.lateral_offset_m.is_finite() {
                return Err(TraceError::NonFiniteLateral {
                    actor_id: self.actor_ids[i].clone(),
                    tick,
                });
            }
        }
        if let Some(ticks) = &mut self.ticks {
            ticks.t.push(t);
            for (i, frame) in actors.iter().enumerate() {
                let track = &mut ticks.actors[i];
                track.x.push(frame.x);
                track.y.push(frame.y);
                track.heading_rad.push(frame.heading_rad);
                track.speed_mps.push(frame.speed_mps);
                track.lateral_offset_m.push(frame.lateral_offset_m);
                track.motion_direction.push(frame.motion_direction);
                track.lane_rsl.push(frame.lane_rsl.map(str::to_owned));
                track.s.push(frame.s);
                track.present.push(u8::from(frame.present));
                if let (Some(p), Some(physics)) = (&mut track.physics, &frame.physics) {
                    push_physics(p, physics);
                }
                ticks.route_refs[i].push(frame.route_ref.to_owned());
            }
            for (i, signal) in signals.iter().enumerate() {
                ticks.signals[i].phase.push(signal.phase);
            }
        }
        for (slot, frame) in self.latest_actors.iter_mut().zip(actors) {
            match slot {
                Some(latest) => latest.update(frame),
                None => *slot = Some(LatestActorFrame::from_frame(frame)),
            }
        }
        for (slot, signal) in self.latest_signals.iter_mut().zip(signals) {
            *slot = Some(signal.phase);
        }
        self.latest_t = Some(t);
        self.len += 1;
        Ok(())
    }

    /// Latest frame per actor in registration order (`None` before the first
    /// tick) — the live-subscriber and `peek` surface.
    pub fn latest_actors(&self) -> impl Iterator<Item = (&str, Option<&LatestActorFrame>)> {
        self.actor_ids
            .iter()
            .map(String::as_str)
            .zip(self.latest_actors.iter().map(Option::as_ref))
    }

    pub fn latest_signals(&self) -> impl Iterator<Item = (&str, Option<ControlIndication>)> {
        self.signal_ids
            .iter()
            .map(String::as_str)
            .zip(self.latest_signals.iter().copied())
    }

    /// Accumulated channels (full capture only).
    pub fn ticks(&self) -> Option<&RecordedTicks> {
        self.ticks.as_ref()
    }

    /// Route-ref channel per actor keyed by id, for the ledger builder.
    pub fn route_refs(&self) -> Result<BTreeMap<&str, &[String]>, TraceError> {
        let ticks = self.ticks.as_ref().ok_or(TraceError::StreamingCapture)?;
        Ok(self
            .actor_ids
            .iter()
            .map(String::as_str)
            .zip(ticks.route_refs.iter().map(Vec::as_slice))
            .collect())
    }

    /// Assemble the complete trace. `header.trace_version` and `actor_ids`
    /// are set here; `downed_since` carries each knocked-down actor's clip
    /// time; perception channels are attached when present. The ledger is
    /// built by `ledger` from the assembled header/ticks and the per-actor
    /// route-ref channel, because the ledger needs the finished channels and
    /// the trace needs the ledger.
    #[allow(clippy::too_many_arguments)]
    pub fn finish(
        self,
        mut header: TraceHeader,
        events: Vec<SimEvent>,
        metrics: EpisodeMetrics,
        downed_since: &BTreeMap<String, f64>,
        sensors: Option<BTreeMap<String, SensorTrack>>,
        map_divergence: Option<BTreeMap<String, MapDivergenceTrack>>,
        ledger: impl FnOnce(
            &TraceHeader,
            &TraceTicks,
            &[SimEvent],
            &EpisodeMetrics,
            &BTreeMap<&str, &[String]>,
        ) -> SemanticLedger,
    ) -> Result<SimTrace, TraceError> {
        let recorded = self.ticks.ok_or(TraceError::StreamingCapture)?;
        let mut actors = BTreeMap::new();
        for (id, mut track) in self.actor_ids.iter().zip(recorded.actors) {
            track.down_since_s = downed_since.get(id).copied();
            actors.insert(id.clone(), track);
        }
        let signals = self.signal_ids.into_iter().zip(recorded.signals).collect();
        header.trace_version = TRACE_FORMAT_VERSION;
        header.actor_ids = actors.keys().cloned().collect();
        let ticks = TraceTicks {
            t: recorded.t,
            actors,
            signals,
            sensors,
            map_divergence,
        };
        let route_refs: BTreeMap<&str, &[String]> = self
            .actor_ids
            .iter()
            .map(String::as_str)
            .zip(recorded.route_refs.iter().map(Vec::as_slice))
            .collect();
        let semantic_ledger = ledger(&header, &ticks, &events, &metrics, &route_refs);
        let trace = SimTrace {
            header,
            ticks,
            events,
            metrics,
            semantic_ledger,
        };
        trace.validate()?;
        Ok(trace)
    }
}

fn push_physics(track: &mut ActorPhysicsTrack, frame: &PhysicsFrame) {
    track.vx_body_mps.push(frame.vx_body_mps);
    track.vy_body_mps.push(frame.vy_body_mps);
    track.yaw_rate_radps.push(frame.yaw_rate_radps);
    track.steer_rad.push(frame.steer_rad);
    track
        .wheel_angular_speed_radps
        .push(frame.wheel_angular_speed_radps);
    track.tire_utilization.push(frame.tire_utilization);
    track.front_normal_force_n.push(frame.front_normal_force_n);
    track.rear_normal_force_n.push(frame.rear_normal_force_n);
    track.collision_impulse_ns.push(frame.collision_impulse_ns);
    track.collision_count.push(f64::from(frame.collision_count));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame<'a>(physics: Option<PhysicsFrame>) -> ActorFrame<'a> {
        ActorFrame {
            x: 0.0,
            y: 0.0,
            heading_rad: 0.0,
            speed_mps: 0.0,
            lateral_offset_m: 0.0,
            motion_direction: MotionDirection::Forward,
            lane_rsl: None,
            s: 0.0,
            present: true,
            physics,
            route_ref: "route:x",
        }
    }

    #[test]
    fn physics_actor_without_physics_frame_is_rejected() {
        let mut rec = TraceRecorder::new(
            ["ego"],
            Vec::<String>::new(),
            &["ego"],
            TraceCapture::Full,
            4,
        );
        let err = rec.record_tick(0.0, &[frame(None)], &[]).unwrap_err();
        assert!(matches!(err, TraceError::MissingPhysicsFrame { .. }));
        assert_eq!(rec.len(), 0);
        rec.record_tick(0.0, &[frame(Some(PhysicsFrame::default()))], &[])
            .unwrap();
        assert_eq!(rec.len(), 1);
    }

    #[test]
    fn streaming_capture_keeps_only_latest_frame() {
        let mut rec = TraceRecorder::new(
            ["ego"],
            Vec::<String>::new(),
            &[],
            TraceCapture::Streaming,
            0,
        );
        for i in 0..1000 {
            rec.record_tick(i as f64 * 0.02, &[frame(None)], &[])
                .unwrap();
        }
        assert!(rec.ticks().is_none());
        assert_eq!(rec.len(), 1000);
        assert!(matches!(
            rec.route_refs(),
            Err(TraceError::StreamingCapture)
        ));
    }
}
