//! The per-sensor trace channel and the perception episode metrics.
//!
//! Columnar, like every other channel: one array per quantity, index-aligned
//! with `ticks.t`. Statuses and reasons are small integers with an exported
//! legend rather than strings, because a 30 s clip at 50 Hz is 1500 samples
//! per target and a run of identical integers is what gzip is good at.
//!
//! The detection *model* (aperture, Koschmieder extinction, glare) belongs to
//! the engine's perception pass; this module owns what it concludes: the
//! latch/debounce that turns raw observations into the reported status the
//! `detected` trigger condition reads, the recorded channel, and the episode
//! summary. Map/percept divergence is recorded as *exposure* only — the
//! engine has no lane-keeping perception controller, so a declared divergence
//! deliberately does not feed back into control.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::math::{hypot, quantize, Vec2};
use crate::types::{MapDivergence, MapDivergenceExtent, MapDivergenceKind, SensorType, SimSensor};

use super::{check_len, precision, quantize_all, TraceError};

/// Bounded evidence: an author needs the worst dropouts, not all of them.
const MAX_RECORDED_GAPS: usize = 16;

/// Detection status, ordered so that a larger number is strictly more
/// perception. The trace records the number; this is the legend.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(into = "u8", try_from = "u8")]
#[repr(u8)]
pub enum DetectionStatus {
    Absent = 0,
    Missed = 1,
    Degraded = 2,
    Detected = 3,
}

impl From<DetectionStatus> for u8 {
    fn from(s: DetectionStatus) -> u8 {
        s as u8
    }
}

impl TryFrom<u8> for DetectionStatus {
    type Error = String;
    fn try_from(v: u8) -> Result<Self, String> {
        match v {
            0 => Ok(Self::Absent),
            1 => Ok(Self::Missed),
            2 => Ok(Self::Degraded),
            3 => Ok(Self::Detected),
            other => Err(format!("detection status code {other} is outside 0..=3")),
        }
    }
}

/// Legend for the recorded `reason` channel, in code order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[repr(u8)]
pub enum DetectionReason {
    Detected = 0,
    Absent = 1,
    Disabled = 2,
    OutOfRange = 3,
    OutOfFov = 4,
    Occluded = 5,
    AtmosphericAttenuation = 6,
    BelowAngularResolution = 7,
    LowLight = 8,
    Glare = 9,
}

impl DetectionReason {
    pub const ALL: [DetectionReason; 10] = [
        Self::Detected,
        Self::Absent,
        Self::Disabled,
        Self::OutOfRange,
        Self::OutOfFov,
        Self::Occluded,
        Self::AtmosphericAttenuation,
        Self::BelowAngularResolution,
        Self::LowLight,
        Self::Glare,
    ];

    #[inline]
    pub const fn code(self) -> u8 {
        self as u8
    }

    pub fn from_code(code: u8) -> Option<Self> {
        Self::ALL.get(code as usize).copied()
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Detected => "detected",
            Self::Absent => "absent",
            Self::Disabled => "disabled",
            Self::OutOfRange => "out_of_range",
            Self::OutOfFov => "out_of_fov",
            Self::Occluded => "occluded",
            Self::AtmosphericAttenuation => "atmospheric_attenuation",
            Self::BelowAngularResolution => "below_angular_resolution",
            Self::LowLight => "low_light",
            Self::Glare => "glare",
        }
    }
}

/// What the detection model concluded about one sensor/target on one tick.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DetectionObservation {
    pub status: DetectionStatus,
    pub reason: DetectionReason,
    /// 0 when a hard gate rejected the target.
    pub confidence: f64,
    pub range_m: f64,
    /// Signed bearing off boresight, radians.
    pub bearing_rad: f64,
    /// Target present, sensor on, inside range and field of view; says nothing
    /// about whether anything is in the way.
    pub in_aperture: bool,
    /// `in_aperture` and the geometric line of sight is clear.
    pub observable: bool,
}

impl DetectionObservation {
    /// The observation recorded when the observer itself is absent.
    pub const OBSERVER_ABSENT: DetectionObservation = DetectionObservation {
        status: DetectionStatus::Absent,
        reason: DetectionReason::Absent,
        confidence: 0.0,
        range_m: 0.0,
        bearing_rad: 0.0,
        in_aperture: false,
        observable: false,
    };
}

/* ---------------------------------------------------------------- channels */

/// One sensor's opinion about one other actor, over the whole clip.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SensorTargetTrack {
    /// [`DetectionStatus`] codes.
    pub status: Vec<u8>,
    /// [`DetectionReason`] codes.
    pub reason: Vec<u8>,
    pub confidence: Vec<f64>,
    pub range_m: Vec<f64>,
    /// 1 while geometric line of sight to the target is clear.
    pub line_of_sight: Vec<u8>,
}

/// One declared sensor's whole channel.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SensorTrack {
    pub observer: String,
    pub sensor_id: String,
    #[serde(rename = "type")]
    pub sensor_type: SensorType,
    /// Keyed by target actor id, in sorted order.
    pub targets: BTreeMap<String, SensorTargetTrack>,
}

impl SensorTrack {
    pub(crate) fn validate(&self, key: &str, ticks: usize) -> Result<(), TraceError> {
        for (target, track) in &self.targets {
            let prefix = format!("ticks.sensors.{key}.targets.{target}");
            check_len(&format!("{prefix}.status"), track.status.len(), ticks)?;
            check_len(&format!("{prefix}.reason"), track.reason.len(), ticks)?;
            check_len(
                &format!("{prefix}.confidence"),
                track.confidence.len(),
                ticks,
            )?;
            check_len(&format!("{prefix}.rangeM"), track.range_m.len(), ticks)?;
            check_len(
                &format!("{prefix}.lineOfSight"),
                track.line_of_sight.len(),
                ticks,
            )?;
        }
        Ok(())
    }

    /// A raw floating-point confidence product would break bit-identical
    /// replay comparison; quantise with the rest of the channels.
    pub(crate) fn quantize(&mut self) {
        for track in self.targets.values_mut() {
            quantize_all(&mut track.confidence, precision::SENSOR_CONFIDENCE);
            quantize_all(&mut track.range_m, precision::SENSOR_RANGE);
        }
    }
}

/// Per-tick exposure of one observer to one declared map/percept divergence.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MapDivergenceTrack {
    pub id: String,
    pub kind: MapDivergenceKind,
    pub observer: String,
    /// 1 while the observer is inside the divergent extent.
    pub active: Vec<u8>,
}

/// Stable channel key. `observer/sensorId` is unique by construction.
pub fn sensor_channel_key(observer_id: &str, sensor_id: &str) -> String {
    format!("{observer_id}/{sensor_id}")
}

/* ----------------------------------------------------------------- metrics */

/// A maximal run in which an observable target was not reported.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectionGap {
    pub start_s: f64,
    pub end_s: f64,
    pub duration_s: f64,
    /// The reason that dominated the run.
    pub reason: DetectionReason,
    /// `true` when the gap was still open at the end of the clip.
    pub open_at_clip_end: bool,
}

/// Everything the perception layer concluded about one sensor/target pair.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SensorPerceptionMetric {
    pub observer: String,
    pub sensor_id: String,
    pub target: String,
    /// First tick at which the geometric line of sight was clear and in aperture.
    pub first_line_of_sight_t: Option<f64>,
    /// First tick at which the sensor reported the target.
    pub first_detection_t: Option<f64>,
    /// Clip time of first detection; `None` when it was never detected.
    pub time_to_first_detection_s: Option<f64>,
    /// Seconds between the world making the target available and the sensor
    /// admitting it exists.
    pub perception_lag_s: Option<f64>,
    pub detected_s: f64,
    pub degraded_s: f64,
    pub missed_s: f64,
    /// Longest dropout while the target was geometrically available.
    pub longest_gap_s: f64,
    pub total_gap_s: f64,
    /// Bounded evidence; the longest gaps, in time order.
    pub gaps: Vec<DetectionGap>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MapDivergenceMetric {
    pub id: String,
    pub kind: MapDivergenceKind,
    pub observer: String,
    pub severity: f64,
    pub lateral_error_m: Option<f64>,
    pub first_active_t: Option<f64>,
    pub active_s: f64,
}

/// The perception episode summary.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PerceptionMetrics {
    pub sensors: Vec<SensorPerceptionMetric>,
    pub map_divergence: Vec<MapDivergenceMetric>,
}

impl PerceptionMetrics {
    pub(crate) fn quantize(&mut self, decimals: i32) {
        for s in &mut self.sensors {
            super::quantize_opt(&mut s.first_line_of_sight_t, decimals);
            super::quantize_opt(&mut s.first_detection_t, decimals);
            super::quantize_opt(&mut s.time_to_first_detection_s, decimals);
            super::quantize_opt(&mut s.perception_lag_s, decimals);
            s.detected_s = quantize(s.detected_s, decimals);
            s.degraded_s = quantize(s.degraded_s, decimals);
            s.missed_s = quantize(s.missed_s, decimals);
            s.longest_gap_s = quantize(s.longest_gap_s, decimals);
            s.total_gap_s = quantize(s.total_gap_s, decimals);
            for g in &mut s.gaps {
                g.start_s = quantize(g.start_s, decimals);
                g.end_s = quantize(g.end_s, decimals);
                g.duration_s = quantize(g.duration_s, decimals);
            }
        }
        for d in &mut self.map_divergence {
            d.severity = quantize(d.severity, decimals);
            super::quantize_opt(&mut d.lateral_error_m, decimals);
            super::quantize_opt(&mut d.first_active_t, decimals);
            d.active_s = quantize(d.active_s, decimals);
        }
    }
}

/* ------------------------------------------------------------ accumulator */

/// The observer geometry a divergence extent is tested against.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DivergenceObserverView<'a> {
    pub position: Vec2,
    /// Current lane, for lane-scoped divergences.
    pub lane_rsl: Option<&'a str>,
    pub lane_s: f64,
}

/// Is the observer inside the divergent extent?
pub fn in_extent(divergence: &MapDivergence, observer: DivergenceObserverView<'_>) -> bool {
    match &divergence.extent {
        MapDivergenceExtent::Lane { rsl, s_min, s_max } => {
            observer.lane_rsl == Some(rsl.as_str())
                && s_min.is_none_or(|s| observer.lane_s >= s)
                && s_max.is_none_or(|s| observer.lane_s <= s)
        }
        MapDivergenceExtent::Circle { center, radius_m } => {
            let c = center.to_local();
            hypot(observer.position.x - c.x, observer.position.y - c.y) <= *radius_m
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SensorEntry {
    observer: String,
    sensor_id: String,
    sensor_type: SensorType,
    /// Debounce in whole ticks, so the latch cannot drift under replay.
    latch_ticks: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairAccumulator {
    /// Index into `sensors`.
    sensor: usize,
    target: String,
    track: SensorTargetTrack,
    first_line_of_sight_t: Option<f64>,
    first_detection_t: Option<f64>,
    detected_ticks: u64,
    degraded_ticks: u64,
    missed_ticks: u64,
    reported_status: DetectionStatus,
    pending_status: DetectionStatus,
    pending_ticks: u32,
    /// Open gap, if any.
    gap_start_t: Option<f64>,
    /// Ticks per reason inside the open gap, indexed by reason code.
    gap_reason_ticks: [u32; 10],
    gaps: Vec<DetectionGap>,
    last_t: f64,
}

impl PairAccumulator {
    fn new(sensor: usize, target: &str) -> Self {
        Self {
            sensor,
            target: target.to_owned(),
            track: SensorTargetTrack::default(),
            first_line_of_sight_t: None,
            first_detection_t: None,
            detected_ticks: 0,
            degraded_ticks: 0,
            missed_ticks: 0,
            reported_status: DetectionStatus::Absent,
            pending_status: DetectionStatus::Absent,
            pending_ticks: 0,
            gap_start_t: None,
            gap_reason_ticks: [0; 10],
            gaps: Vec::new(),
            last_t: 0.0,
        }
    }

    fn close_gap(&mut self, end_t: f64, open_at_clip_end: bool) -> DetectionGap {
        let start_s = self.gap_start_t.unwrap_or(end_t);
        // Ties resolve to the alphabetically first reason name, matching the
        // sorted-entry fold of the reference.
        let mut reason = DetectionReason::Occluded;
        let mut best: i64 = -1;
        let mut ranked: Vec<(&'static str, DetectionReason)> = DetectionReason::ALL
            .iter()
            .map(|r| (r.as_str(), *r))
            .collect();
        ranked.sort_by(|x, y| x.0.cmp(y.0));
        for (_, r) in ranked {
            let ticks = self.gap_reason_ticks[r.code() as usize];
            if ticks > 0 && i64::from(ticks) > best {
                best = i64::from(ticks);
                reason = r;
            }
        }
        self.gap_start_t = None;
        self.gap_reason_ticks = [0; 10];
        DetectionGap {
            start_s,
            end_s: end_t,
            duration_s: (end_t - start_s).max(0.0),
            reason,
            open_at_clip_end,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DivergenceAccumulator {
    divergence: MapDivergence,
    observer: String,
    track: MapDivergenceTrack,
    first_active_t: Option<f64>,
    active_ticks: u64,
}

/// Perception state for one world: the latch per sensor/target, the recorded
/// channels and the divergence exposure. Plain serialisable data, so a
/// checkpoint carries it verbatim.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PerceptionAccumulator {
    dt: f64,
    record_history: bool,
    /// Sorted by `(observer, sensor_id)`.
    sensors: Vec<SensorEntry>,
    /// Sorted by `(observer, sensor_id, target)`.
    pairs: Vec<PairAccumulator>,
    /// Sorted by `(divergence.id, observer)`.
    divergences: Vec<DivergenceAccumulator>,
    /// Every actor id known to the pass, sorted.
    target_ids: Vec<String>,
    tick_count: u64,
}

impl PerceptionAccumulator {
    /// `observers` lists each actor's declared sensor suite; `target_ids` is
    /// every actor in the world. `record_history = false` keeps only the
    /// latch state (live/streaming worlds), so nothing grows per tick.
    pub fn new(
        observers: &[(&str, &[SimSensor])],
        target_ids: &[&str],
        divergences: &[MapDivergence],
        dt: f64,
        record_history: bool,
    ) -> Self {
        let mut sensors: Vec<SensorEntry> = observers
            .iter()
            .flat_map(|(actor_id, suite)| {
                suite.iter().map(|sensor| SensorEntry {
                    observer: (*actor_id).to_owned(),
                    sensor_id: sensor.id.clone(),
                    sensor_type: sensor.sensor_type,
                    latch_ticks: crate::math::js_round(sensor.detection.latch_s / dt) as u32,
                })
            })
            .collect();
        sensors.sort_by(|x, y| {
            x.observer
                .cmp(&y.observer)
                .then_with(|| x.sensor_id.cmp(&y.sensor_id))
        });
        let mut targets: Vec<String> = target_ids.iter().map(|t| (*t).to_owned()).collect();
        targets.sort();
        targets.dedup();
        let mut this = Self {
            dt,
            record_history,
            sensors,
            pairs: Vec::new(),
            divergences: Vec::new(),
            target_ids: Vec::new(),
            tick_count: 0,
        };
        let mut sorted_divergences: Vec<&MapDivergence> = divergences.iter().collect();
        sorted_divergences.sort_by(|x, y| x.id.cmp(&y.id));
        for divergence in &sorted_divergences {
            // Explicit observers are tracked whether or not they exist yet;
            // empty means *every* actor, joined as targets register.
            let mut scoped: Vec<&str> = divergence.observers.iter().map(String::as_str).collect();
            scoped.sort_unstable();
            for observer in scoped {
                this.push_divergence(divergence, observer);
            }
        }
        for target in &targets {
            this.add_target_inner(target, &sorted_divergences);
        }
        this.finish_sort();
        this
    }

    fn push_divergence(&mut self, divergence: &MapDivergence, observer: &str) {
        self.divergences.push(DivergenceAccumulator {
            divergence: divergence.clone(),
            observer: observer.to_owned(),
            track: MapDivergenceTrack {
                id: divergence.id.clone(),
                kind: divergence.kind,
                observer: observer.to_owned(),
                active: Vec::new(),
            },
            first_active_t: None,
            active_ticks: 0,
        });
    }

    fn add_target_inner(&mut self, target: &str, divergences: &[&MapDivergence]) {
        if self
            .target_ids
            .binary_search_by(|t| t.as_str().cmp(target))
            .is_ok()
        {
            return;
        }
        let at = self.target_ids.partition_point(|t| t.as_str() < target);
        self.target_ids.insert(at, target.to_owned());
        for (index, sensor) in self.sensors.iter().enumerate() {
            if sensor.observer == target {
                continue;
            }
            self.pairs.push(PairAccumulator::new(index, target));
        }
        for divergence in divergences {
            if divergence.observers.is_empty() {
                self.push_divergence(divergence, target);
            }
        }
    }

    fn finish_sort(&mut self) {
        let sensors = &self.sensors;
        self.pairs.sort_by(|x, y| {
            let sx = &sensors[x.sensor];
            let sy = &sensors[y.sensor];
            sx.observer
                .cmp(&sy.observer)
                .then_with(|| sx.sensor_id.cmp(&sy.sensor_id))
                .then_with(|| x.target.cmp(&y.target))
        });
        self.divergences.sort_by(|x, y| {
            x.divergence
                .id
                .cmp(&y.divergence.id)
                .then_with(|| x.observer.cmp(&y.observer))
        });
    }

    /// Add a live target without disturbing any existing sensor/latch state.
    pub fn add_target(&mut self, target: &str) {
        let known = self
            .target_ids
            .binary_search_by(|t| t.as_str().cmp(target))
            .is_ok();
        if known {
            return;
        }
        let mut declared: Vec<MapDivergence> = Vec::new();
        for acc in &self.divergences {
            if acc.divergence.observers.is_empty()
                && !declared.iter().any(|d| d.id == acc.divergence.id)
            {
                declared.push(acc.divergence.clone());
            }
        }
        let refs: Vec<&MapDivergence> = declared.iter().collect();
        self.add_target_inner(target, &refs);
        self.finish_sort();
    }

    /// `true` when any sensor or divergence is declared, i.e. the pass has work.
    pub fn is_active(&self) -> bool {
        !self.sensors.is_empty() || !self.divergences.is_empty()
    }

    /// Every declared sensor key `observer/sensorId`, sorted.
    pub fn sensor_keys(&self) -> Vec<String> {
        self.sensors
            .iter()
            .map(|s| sensor_channel_key(&s.observer, &s.sensor_id))
            .collect()
    }

    /// Declared sensor pairs in channel order, for the engine's per-tick fan-out.
    pub fn pair_count(&self) -> usize {
        self.pairs.len()
    }

    /// Record one tick. `detect` is the engine's detection model, invoked once
    /// per `(observer, sensorId, target)` in sorted order from the same frozen
    /// snapshot the controllers plan against; `exposure` returns the observer
    /// geometry for divergence extents, `None` when the observer is absent.
    pub fn observe_tick<'a>(
        &mut self,
        t: f64,
        mut detect: impl FnMut(&str, &str, &str) -> DetectionObservation,
        mut exposure: impl FnMut(&str) -> Option<DivergenceObserverView<'a>>,
    ) {
        let record = self.record_history;
        for acc in &mut self.pairs {
            let sensor = &self.sensors[acc.sensor];
            let observation = detect(&sensor.observer, &sensor.sensor_id, &acc.target);
            accumulate(acc, sensor.latch_ticks, t, observation, record);
        }
        for acc in &mut self.divergences {
            let active =
                exposure(&acc.observer).is_some_and(|view| in_extent(&acc.divergence, view));
            if record {
                acc.track.active.push(u8::from(active));
                if active {
                    acc.active_ticks += 1;
                    if acc.first_active_t.is_none() {
                        acc.first_active_t = Some(t);
                    }
                }
            }
        }
        self.tick_count += 1;
    }

    fn pair_range(&self, observer: &str) -> std::ops::Range<usize> {
        let sensors = &self.sensors;
        let start = self
            .pairs
            .partition_point(|p| sensors[p.sensor].observer.as_str() < observer);
        let end = self
            .pairs
            .partition_point(|p| sensors[p.sensor].observer.as_str() <= observer);
        start..end
    }

    /// The reported status of `target` for `observer`, optionally narrowed to
    /// one sensor. Without `sensor_id` the suite's best opinion wins.
    pub fn status_of(
        &self,
        observer: &str,
        target: &str,
        sensor_id: Option<&str>,
    ) -> DetectionStatus {
        let mut best = DetectionStatus::Absent;
        for acc in &self.pairs[self.pair_range(observer)] {
            if acc.target != target {
                continue;
            }
            if sensor_id.is_some_and(|id| self.sensors[acc.sensor].sensor_id != id) {
                continue;
            }
            if acc.reported_status > best {
                best = acc.reported_status;
            }
        }
        best
    }

    /// `true` when the observer's suite currently reports the target.
    pub fn detects(&self, observer: &str, target: &str, sensor_id: Option<&str>) -> bool {
        self.status_of(observer, target, sensor_id) >= DetectionStatus::Detected
    }

    /// `true` when the pair is even monitored — an unknown sensor is an author bug.
    pub fn has_sensor(&self, observer: &str, sensor_id: Option<&str>) -> bool {
        self.sensors
            .iter()
            .any(|s| s.observer == observer && sensor_id.is_none_or(|id| s.sensor_id == id))
    }

    /// The trace channel, keyed `observer/sensorId`.
    pub fn sensor_tracks(&self) -> BTreeMap<String, SensorTrack> {
        let mut out = BTreeMap::new();
        for sensor in &self.sensors {
            out.insert(
                sensor_channel_key(&sensor.observer, &sensor.sensor_id),
                SensorTrack {
                    observer: sensor.observer.clone(),
                    sensor_id: sensor.sensor_id.clone(),
                    sensor_type: sensor.sensor_type,
                    targets: BTreeMap::new(),
                },
            );
        }
        for acc in &self.pairs {
            let sensor = &self.sensors[acc.sensor];
            if let Some(track) =
                out.get_mut(&sensor_channel_key(&sensor.observer, &sensor.sensor_id))
            {
                track.targets.insert(acc.target.clone(), acc.track.clone());
            }
        }
        out
    }

    /// The map-divergence exposure channel, keyed `divergenceId/observer`.
    pub fn divergence_tracks(&self) -> BTreeMap<String, MapDivergenceTrack> {
        self.divergences
            .iter()
            .map(|acc| {
                (
                    format!("{}/{}", acc.divergence.id, acc.observer),
                    acc.track.clone(),
                )
            })
            .collect()
    }

    /// The episode summary written to `metrics.perception`.
    pub fn metrics(&self) -> PerceptionMetrics {
        let clip_end_t = if self.tick_count == 0 {
            0.0
        } else {
            self.pairs.first().map_or(0.0, |p| p.last_t)
        };
        let sensors = self
            .pairs
            .iter()
            .map(|acc| {
                let sensor = &self.sensors[acc.sensor];
                let mut gaps = acc.gaps.clone();
                if acc.gap_start_t.is_some() {
                    let mut open = acc.clone();
                    gaps.push(open.close_gap(clip_end_t + self.dt, true));
                }
                let longest_gap_s = gaps.iter().fold(0.0_f64, |m, g| m.max(g.duration_s));
                let total_gap_s = gaps.iter().map(|g| g.duration_s).sum();
                let mut ranked = gaps;
                ranked.sort_by(|x, y| {
                    y.duration_s
                        .partial_cmp(&x.duration_s)
                        .unwrap_or(std::cmp::Ordering::Equal)
                });
                ranked.truncate(MAX_RECORDED_GAPS);
                ranked.sort_by(|x, y| {
                    x.start_s
                        .partial_cmp(&y.start_s)
                        .unwrap_or(std::cmp::Ordering::Equal)
                });
                SensorPerceptionMetric {
                    observer: sensor.observer.clone(),
                    sensor_id: sensor.sensor_id.clone(),
                    target: acc.target.clone(),
                    first_line_of_sight_t: acc.first_line_of_sight_t,
                    first_detection_t: acc.first_detection_t,
                    time_to_first_detection_s: acc.first_detection_t,
                    perception_lag_s: match (acc.first_line_of_sight_t, acc.first_detection_t) {
                        (Some(los), Some(det)) => Some(det - los),
                        _ => None,
                    },
                    detected_s: acc.detected_ticks as f64 * self.dt,
                    degraded_s: acc.degraded_ticks as f64 * self.dt,
                    missed_s: acc.missed_ticks as f64 * self.dt,
                    longest_gap_s,
                    total_gap_s,
                    gaps: ranked,
                }
            })
            .collect();
        let map_divergence = self
            .divergences
            .iter()
            .map(|acc| MapDivergenceMetric {
                id: acc.divergence.id.clone(),
                kind: acc.divergence.kind,
                observer: acc.observer.clone(),
                severity: acc.divergence.severity,
                lateral_error_m: acc.divergence.lateral_error_m,
                first_active_t: acc.first_active_t,
                active_s: acc.active_ticks as f64 * self.dt,
            })
            .collect();
        PerceptionMetrics {
            sensors,
            map_divergence,
        }
    }
}

fn accumulate(
    acc: &mut PairAccumulator,
    latch_ticks: u32,
    t: f64,
    observation: DetectionObservation,
    record: bool,
) {
    acc.last_t = t;
    if observation.status == acc.pending_status {
        acc.pending_ticks += 1;
    } else {
        acc.pending_status = observation.status;
        acc.pending_ticks = 1;
    }
    if acc.pending_ticks > latch_ticks {
        acc.reported_status = acc.pending_status;
    }
    let reported = acc.reported_status;
    if !record {
        return;
    }
    let detected = reported >= DetectionStatus::Detected;
    acc.track.status.push(reported.into());
    acc.track.reason.push(if detected {
        DetectionReason::Detected.code()
    } else {
        observation.reason.code()
    });
    acc.track.confidence.push(observation.confidence);
    acc.track.range_m.push(observation.range_m);
    acc.track
        .line_of_sight
        .push(u8::from(observation.observable));

    if observation.observable && acc.first_line_of_sight_t.is_none() {
        acc.first_line_of_sight_t = Some(t);
    }
    match reported {
        DetectionStatus::Detected => {
            acc.detected_ticks += 1;
            if acc.first_detection_t.is_none() {
                acc.first_detection_t = Some(t);
            }
        }
        DetectionStatus::Degraded => acc.degraded_ticks += 1,
        DetectionStatus::Missed => acc.missed_ticks += 1,
        DetectionStatus::Absent => {}
    }

    // A gap is a run in which the target was geometrically available to this
    // sensor and the sensor still failed to report it.
    let in_gap = observation.in_aperture && !detected;
    if in_gap {
        if acc.gap_start_t.is_none() {
            acc.gap_start_t = Some(t);
            acc.gap_reason_ticks = [0; 10];
        }
        acc.gap_reason_ticks[observation.reason.code() as usize] += 1;
    } else if acc.gap_start_t.is_some() {
        let gap = acc.close_gap(t, false);
        acc.gaps.push(gap);
    }
}
