//! The detection model — a closed-form, deterministic answer to one question:
//! *does this sensor report this actor on this tick, and if not, why not?*
//!
//! Four hard gates first (sensor off, target absent, outside aperture, line
//! of sight blocked), then confidence as a product of physical terms written
//! in the same `1 − threshold/actual` form: Koschmieder contrast, angular
//! resolution, precipitation, illumination and glare. Per-modality
//! `sensitivity` exponents make a radar's indifference to fog fall out of the
//! same evaluator rather than a branch on sensor type.
//!
//! The per-tick pass ([`PerceptionPass`]) resolves sensor poses and glare
//! once per sensor, then answers the trace accumulator's sorted `(observer,
//! sensor, target)` fan-out from a frozen actor snapshot. The accumulator
//! ([`PerceptionAccumulator`]) owns latching, gaps, tracks and the episode
//! summary; nothing here keeps a second copy of what it concluded.
//!
//! Object detection is closed loop through the `detected` trigger condition
//! ([`PerceptionView`]). Map/percept divergence is recorded as exposure only:
//! the engine has no lane-keeping perception controller to mislead.

use std::cell::Cell;

use crate::map::LaneGraph;
use crate::math::{acos, angle_delta, atan2, clamp, cos, exp, hypot, log, pow, sin, sin_cos, Vec2};
use crate::trace::perception::{DivergenceObserverView, PerceptionAccumulator};
use crate::types::{Atmosphere, EmissiveGlare, PerceptionConfig, SetValue, SimSensor};

pub use crate::trace::perception::{DetectionObservation, DetectionReason, DetectionStatus};

use super::actor::{ActorIndex, ActorRuntime};
use super::triggers::PerceptionQuery;
use super::visibility::{has_line_of_sight, OccluderShape};

/// Koschmieder's constant, `−ln(0.02)`.
pub const KOSCHMIEDER_K: f64 = 3.912023005428146;
/// Precipitation rate, mm/h, that halves the usable contrast on its own.
pub const PRECIPITATION_HALF_MM_PER_H: f64 = 25.0;

/// A bright thing that can wash out a detector, in the sensor frame.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GlareSource {
    pub azimuth_rad: f64,
    pub elevation_rad: f64,
    pub half_angle_rad: f64,
    /// Confidence lost when the target sits exactly on the source, 0..1.
    pub intensity: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SensorPose {
    pub position: Vec2,
    /// Boresight direction, radians CCW from `+x`.
    pub boresight_rad: f64,
    /// Height of the origin above the ground plane, metres.
    pub height_m: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PerceivedTarget {
    pub present: bool,
    pub position: Vec2,
    /// Full height of the target's box; the silhouette the detector must resolve.
    pub height_m: f64,
}

/// Resolve the sensor's origin and boresight from its mount and its carrier.
/// Mount is `+x` forward, `+y` up, `+z` left in the actor frame; in the
/// engine plane "left" of heading θ is `(−sin θ, cos θ)`. Pitch and roll are
/// carried by the document for rendering; the plan-view detector reads yaw.
pub fn sensor_pose(
    sensor: &SimSensor,
    carrier_position: Vec2,
    carrier_heading_rad: f64,
) -> SensorPose {
    let (sin, cos) = sin_cos(carrier_heading_rad);
    let forward = sensor.mount.position.x;
    let left = sensor.mount.position.z;
    SensorPose {
        position: Vec2 {
            x: carrier_position.x + forward * cos - left * sin,
            y: carrier_position.y + forward * sin + left * cos,
        },
        boresight_rad: carrier_heading_rad + sensor.mount.rotation.yaw_rad,
        height_m: sensor.mount.position.y,
    }
}

/// `1 − threshold/actual`, clamped — the shared shape of every soft term.
#[inline]
fn headroom(actual: f64, threshold: f64) -> f64 {
    if !(actual > 0.0) {
        return 0.0;
    }
    clamp(1.0 - threshold / actual, 0.0, 1.0)
}

/// Apparent contrast of a black target at range `r` through visibility `V`.
#[inline]
pub fn koschmieder_contrast(range_m: f64, fog_visibility_m: f64) -> f64 {
    exp((-KOSCHMIEDER_K * range_m) / fog_visibility_m)
}

/// The range at which apparent contrast falls to the detector's floor.
#[inline]
pub fn contrast_limited_range_m(fog_visibility_m: f64, contrast_threshold: f64) -> f64 {
    (fog_visibility_m * log(1.0 / contrast_threshold)) / KOSCHMIEDER_K
}

/// The range at which the target's silhouette falls below angular resolution.
#[inline]
pub fn resolution_limited_range_m(target_height_m: f64, min_angular_size_rad: f64) -> f64 {
    target_height_m / min_angular_size_rad
}

/// Great-circle angle between two (azimuth, elevation) directions, radians.
pub fn angular_separation_rad(az_a: f64, el_a: f64, az_b: f64, el_b: f64) -> f64 {
    let dot = cos(el_a) * cos(el_b) * cos(az_a - az_b) + sin(el_a) * sin(el_b);
    acos(clamp(dot, -1.0, 1.0))
}

/// Worst-case confidence loss from any source near the target's bearing.
fn glare_loss(sources: &[GlareSource], target_azimuth_rad: f64, target_elevation_rad: f64) -> f64 {
    let mut worst = 0.0f64;
    for source in sources {
        let separation = angular_separation_rad(
            source.azimuth_rad,
            source.elevation_rad,
            target_azimuth_rad,
            target_elevation_rad,
        );
        let loss = source.intensity * clamp(1.0 - separation / source.half_angle_rad, 0.0, 1.0);
        if loss > worst {
            worst = loss;
        }
    }
    worst
}

#[inline]
fn miss(
    status: DetectionStatus,
    reason: DetectionReason,
    range_m: f64,
    bearing_rad: f64,
    in_aperture: bool,
) -> DetectionObservation {
    DetectionObservation {
        status,
        reason,
        confidence: 0.0,
        range_m,
        bearing_rad,
        in_aperture,
        observable: false,
    }
}

/// The whole model, for one sensor and one target, on one tick.
///
/// `line_of_sight` is the engine's occluder test — perception does not get a
/// second, disagreeing notion of geometry — and is *only* occluders, never
/// `operationalConditions.effects.visibilityRangeM`: that field is the
/// pre-perception stand-in for weather, and applying it here would attenuate
/// the same fog twice while blaming geometry for the air. A declared sensor's
/// own optics (`aperture.far_m`, the contrast model) are the authority on range.
pub fn observe_target(
    sensor: &SimSensor,
    pose: &SensorPose,
    target: &PerceivedTarget,
    line_of_sight: bool,
    atmosphere: &Atmosphere,
    glare_sources: &[GlareSource],
) -> DetectionObservation {
    let dx = target.position.x - pose.position.x;
    let dy = target.position.y - pose.position.y;
    let range_m = hypot(dx, dy);
    let bearing_rad = angle_delta(pose.boresight_rad, atan2(dy, dx));

    if !target.present {
        return miss(
            DetectionStatus::Absent,
            DetectionReason::Absent,
            range_m,
            bearing_rad,
            false,
        );
    }
    if !sensor.enabled {
        return miss(
            DetectionStatus::Missed,
            DetectionReason::Disabled,
            range_m,
            bearing_rad,
            false,
        );
    }
    if range_m < sensor.aperture.near_m || range_m > sensor.aperture.far_m {
        return miss(
            DetectionStatus::Missed,
            DetectionReason::OutOfRange,
            range_m,
            bearing_rad,
            false,
        );
    }
    let half_fov_rad = sensor.aperture.horizontal_fov_deg * std::f64::consts::PI / 360.0;
    if bearing_rad.abs() > half_fov_rad {
        return miss(
            DetectionStatus::Missed,
            DetectionReason::OutOfFov,
            range_m,
            bearing_rad,
            false,
        );
    }
    // Targets are boxes on the ground; the elevation that matters is the one
    // to the middle of the silhouette, which is what a detector centres on.
    let target_elevation_rad = atan2(target.height_m / 2.0 - pose.height_m, range_m.max(1e-6));
    let half_vfov_rad = sensor.aperture.vertical_fov_deg * std::f64::consts::PI / 360.0;
    if target_elevation_rad.abs() > half_vfov_rad {
        return miss(
            DetectionStatus::Missed,
            DetectionReason::OutOfFov,
            range_m,
            bearing_rad,
            false,
        );
    }
    if !line_of_sight {
        return miss(
            DetectionStatus::Missed,
            DetectionReason::Occluded,
            range_m,
            bearing_rad,
            true,
        );
    }

    let model = &sensor.detection;
    let s = &model.sensitivity;
    let contrast_range_m =
        contrast_limited_range_m(atmosphere.fog_visibility_m, model.contrast_threshold);
    let contrast_term = clamp(1.0 - range_m / contrast_range_m, 0.0, 1.0);
    let precipitation_term =
        1.0 / (1.0 + atmosphere.precipitation_mm_per_h / PRECIPITATION_HALF_MM_PER_H);
    let atmospheric_term = pow(contrast_term * precipitation_term, s.atmosphere);
    let resolution_range_m =
        resolution_limited_range_m(target.height_m, model.min_angular_size_rad);
    let resolution_term = clamp(1.0 - range_m / resolution_range_m, 0.0, 1.0);
    let illumination_term = pow(
        headroom(atmosphere.illumination_frac, model.min_illumination_frac),
        s.illumination,
    );
    let loss = glare_loss(glare_sources, bearing_rad, target_elevation_rad);
    let glare_term = pow(1.0 - loss, s.glare);

    let confidence = clamp(
        atmospheric_term * resolution_term * illumination_term * glare_term,
        0.0,
        1.0,
    );
    let status = if confidence >= model.detect_confidence {
        DetectionStatus::Detected
    } else if confidence >= model.degraded_confidence {
        DetectionStatus::Degraded
    } else {
        DetectionStatus::Missed
    };
    let reason = if status == DetectionStatus::Detected {
        DetectionReason::Detected
    } else {
        // The term that cost the most confidence — the honest single-word why.
        let mut best = (atmospheric_term, DetectionReason::AtmosphericAttenuation);
        for entry in [
            (resolution_term, DetectionReason::BelowAngularResolution),
            (illumination_term, DetectionReason::LowLight),
            (glare_term, DetectionReason::Glare),
        ] {
            if entry.0 < best.0 {
                best = entry;
            }
        }
        best.1
    };
    DetectionObservation {
        status,
        reason,
        confidence,
        range_m,
        bearing_rad,
        in_aperture: true,
        observable: true,
    }
}

/// Emissive-glare truthiness: the perception layer's reading of a state
/// value (`"false"` / `"off"` strings are not emitting).
pub fn emitting(value: Option<&SetValue>) -> bool {
    match value {
        None => false,
        Some(SetValue::Bool(b)) => *b,
        Some(SetValue::Number(n)) => *n != 0.0,
        Some(SetValue::Text(t)) => !(t.is_empty() || t == "false" || t == "off"),
    }
}

/// `true` when the actor is present and asserts any configured emissive key.
pub fn is_glare_emitter(glare: &EmissiveGlare, actor: &ActorRuntime) -> bool {
    actor.present
        && glare
            .state_keys
            .iter()
            .any(|key| emitting(actor.state_key(key)))
}

#[inline]
fn wrap_pi(angle: f64) -> f64 {
    let wrapped = (angle + std::f64::consts::PI) % (2.0 * std::f64::consts::PI);
    (if wrapped < 0.0 {
        wrapped + 2.0 * std::f64::consts::PI
    } else {
        wrapped
    }) - std::f64::consts::PI
}

/// A glare emitter on this tick (an actor asserting an emissive state key).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GlareEmitter {
    pub position: Vec2,
}

/// Glare sources for one sensor pose: the sun plus every in-range emitter,
/// expressed off boresight exactly like the target's bearing. `out` is
/// cleared and filled.
pub fn glare_sources(
    config: &PerceptionConfig,
    pose: &SensorPose,
    emitters: &[GlareEmitter],
    out: &mut Vec<GlareSource>,
) {
    out.clear();
    push_glare_sources(config, pose, emitters, out);
}

/// [`glare_sources`] that appends, so several sensors share one flat buffer.
fn push_glare_sources(
    config: &PerceptionConfig,
    pose: &SensorPose,
    emitters: &[GlareEmitter],
    out: &mut Vec<GlareSource>,
) {
    if let Some(sun) = &config.atmosphere.sun {
        if sun.elevation_rad > 0.0 {
            out.push(GlareSource {
                azimuth_rad: wrap_pi(sun.azimuth_rad - pose.boresight_rad),
                elevation_rad: sun.elevation_rad,
                half_angle_rad: sun.half_angle_rad,
                intensity: sun.intensity,
            });
        }
    }
    let glare: &EmissiveGlare = &config.emissive_glare;
    for emitter in emitters {
        let dx = emitter.position.x - pose.position.x;
        let dy = emitter.position.y - pose.position.y;
        let range_m = hypot(dx, dy);
        if range_m > glare.range_m || range_m < 1e-6 {
            continue;
        }
        out.push(GlareSource {
            azimuth_rad: wrap_pi(atan2(dy, dx) - pose.boresight_rad),
            elevation_rad: atan2(glare.height_m - pose.height_m, range_m),
            half_angle_rad: glare.half_angle_rad,
            // A beacon saturates less as it recedes; linear in range so that
            // `range_m` means exactly "no longer blinding beyond here".
            intensity: glare.intensity * (1.0 - range_m / glare.range_m),
        });
    }
}

/// The observer geometry a map divergence extent is tested against, or
/// `None` when the observer is absent. Lane and traversal-direction `s` come
/// from the actor's current route pose; a freeform route has no lane.
pub fn divergence_view<'g>(
    actor: &ActorRuntime,
    graph: &'g LaneGraph,
) -> Option<DivergenceObserverView<'g>> {
    if !actor.present {
        return None;
    }
    let pose = actor.route.pose_at(actor.route_s);
    Some(DivergenceObserverView {
        position: actor.position,
        lane_rsl: pose.lane.map(|lane| graph.rsl(lane)),
        lane_s: pose.lane_s,
    })
}

/* --------------------------------------------------------------- the pass */

/// One declared sensor bound to its carrier, in accumulator channel order.
#[derive(Debug, Clone)]
struct SensorSlot {
    observer: ActorIndex,
    /// Redundant with `actors[observer].id`; kept so the sorted-order cursor
    /// checks compare against a stable string without indexing the snapshot.
    observer_id: String,
    sensor: SimSensor,
}

/// A target the accumulator may ask about, sorted by id.
#[derive(Debug, Clone)]
struct TargetSlot {
    id: String,
    actor: ActorIndex,
}

/// Engine-side state for the per-tick perception pass: the sensor table in
/// channel order, the sorted id → index table, and the per-tick buffers
/// (sensor poses, glare) that are computed once per sensor rather than once
/// per `(sensor, target)` pair. Rebuildable from the input and the actor
/// table, so a checkpoint carries only the accumulator.
#[derive(Debug, Clone)]
pub struct PerceptionPass {
    config: PerceptionConfig,
    /// Sorted by `(observer id, sensor id)` — the accumulator's channel order.
    sensors: Vec<SensorSlot>,
    /// Sorted by id.
    targets: Vec<TargetSlot>,
    /// Per sensor slot, this tick; `None` while the observer is absent.
    poses: Vec<Option<SensorPose>>,
    /// Flat glare sources for every sensor slot this tick.
    glare: Vec<GlareSource>,
    /// Per sensor slot, the `glare[start..end]` window.
    glare_ranges: Vec<(u32, u32)>,
    emitters: Vec<GlareEmitter>,
}

impl PerceptionPass {
    /// `observers` pairs each carrier with its declared suite; any order.
    /// `actors` is the registered actor table (ids resolve indices once).
    pub fn new(
        config: &PerceptionConfig,
        observers: &[(ActorIndex, &[SimSensor])],
        actors: &[ActorRuntime],
    ) -> Self {
        let mut sensors: Vec<SensorSlot> = observers
            .iter()
            .flat_map(|(observer, suite)| {
                let observer_id = &actors[observer.index()].id;
                suite.iter().map(move |sensor| SensorSlot {
                    observer: *observer,
                    observer_id: observer_id.clone(),
                    sensor: sensor.clone(),
                })
            })
            .collect();
        sensors.sort_by(|x, y| {
            x.observer_id
                .cmp(&y.observer_id)
                .then_with(|| x.sensor.id.cmp(&y.sensor.id))
        });
        let mut targets: Vec<TargetSlot> = actors
            .iter()
            .map(|a| TargetSlot {
                id: a.id.clone(),
                actor: a.index,
            })
            .collect();
        targets.sort_by(|x, y| x.id.cmp(&y.id));
        let count = sensors.len();
        Self {
            config: config.clone(),
            sensors,
            targets,
            poses: vec![None; count],
            glare: Vec::new(),
            glare_ranges: vec![(0, 0); count],
            emitters: Vec::new(),
        }
    }

    /// Register a spawned actor as a target. Sensor suites are declared on
    /// the document; a live spawn observes nothing, matching the accumulator.
    pub fn add_target(&mut self, actor: &ActorRuntime) {
        let at = self
            .targets
            .partition_point(|t| t.id.as_str() < actor.id.as_str());
        if self.targets.get(at).is_some_and(|t| t.id == actor.id) {
            self.targets[at].actor = actor.index;
            return;
        }
        self.targets.insert(
            at,
            TargetSlot {
                id: actor.id.clone(),
                actor: actor.index,
            },
        );
    }

    /// `true` when any sensor is declared, i.e. detection has work to do.
    /// Divergence exposure is the accumulator's own question.
    pub fn has_sensors(&self) -> bool {
        !self.sensors.is_empty()
    }

    pub fn config(&self) -> &PerceptionConfig {
        &self.config
    }

    /// Sensor poses and glare for this tick, once per sensor slot.
    fn begin_tick(&mut self, actors: &[ActorRuntime]) {
        self.emitters.clear();
        let glare = &self.config.emissive_glare;
        if !glare.state_keys.is_empty() {
            // Sorted by id, like every other fan-out.
            for target in &self.targets {
                let actor = &actors[target.actor.index()];
                if is_glare_emitter(glare, actor) {
                    self.emitters.push(GlareEmitter {
                        position: actor.position,
                    });
                }
            }
        }
        self.glare.clear();
        for (i, slot) in self.sensors.iter().enumerate() {
            let observer = &actors[slot.observer.index()];
            let start = self.glare.len() as u32;
            self.poses[i] = observer.present.then(|| {
                let pose = sensor_pose(&slot.sensor, observer.position, observer.heading_rad);
                push_glare_sources(&self.config, &pose, &self.emitters, &mut self.glare);
                pose
            });
            self.glare_ranges[i] = (start, self.glare.len() as u32);
        }
    }

    /// Sorted-order cursor with a binary-search fallback: the accumulator
    /// walks `(observer, sensor, target)` in exactly this table's order, so
    /// the common case is one string compare per call.
    fn sensor_slot(&self, cursor: &Cell<usize>, observer: &str, sensor_id: &str) -> Option<usize> {
        let at = cursor.get();
        let hit = |i: usize| {
            self.sensors
                .get(i)
                .is_some_and(|s| s.observer_id == observer && s.sensor.id == sensor_id)
        };
        if hit(at) {
            return Some(at);
        }
        if hit(at + 1) {
            cursor.set(at + 1);
            return Some(at + 1);
        }
        let found = self
            .sensors
            .binary_search_by(|s| {
                s.observer_id
                    .as_str()
                    .cmp(observer)
                    .then_with(|| s.sensor.id.as_str().cmp(sensor_id))
            })
            .ok()?;
        cursor.set(found);
        Some(found)
    }

    fn target_slot(&self, cursor: &Cell<usize>, target: &str) -> Option<ActorIndex> {
        let at = cursor.get();
        let hit = |i: usize| self.targets.get(i).is_some_and(|t| t.id == target);
        if hit(at) {
            return Some(self.targets[at].actor);
        }
        if hit(at + 1) {
            cursor.set(at + 1);
            return Some(self.targets[at + 1].actor);
        }
        let found = self
            .targets
            .binary_search_by(|t| t.id.as_str().cmp(target))
            .ok()?;
        cursor.set(found);
        Some(self.targets[found].actor)
    }

    /// One perception tick, from the same frozen snapshot the controllers plan
    /// against. `occluders` is this tick's occluder set (see
    /// [`super::visibility::collect_tick_occluders`]); neither endpoint of a
    /// sight line occludes it, so a static pedestrian cannot hide behind
    /// itself. Observations flow into `acc`, which owns the latch and record.
    pub fn observe_tick(
        &mut self,
        t: f64,
        actors: &[ActorRuntime],
        graph: &LaneGraph,
        occluders: &[OccluderShape<'_>],
        acc: &mut PerceptionAccumulator,
    ) {
        self.begin_tick(actors);
        let this = &*self;
        let sensor_cursor = Cell::new(0usize);
        let target_cursor = Cell::new(0usize);
        let exposure_cursor = Cell::new(0usize);

        let detect = |observer: &str, sensor_id: &str, target: &str| -> DetectionObservation {
            let Some(slot) = this.sensor_slot(&sensor_cursor, observer, sensor_id) else {
                return DetectionObservation::OBSERVER_ABSENT;
            };
            let Some(pose) = this.poses[slot] else {
                return DetectionObservation::OBSERVER_ABSENT;
            };
            let sensor_slot = &this.sensors[slot];
            let target_index = this.target_slot(&target_cursor, target);
            // An unknown target id is a body that never existed: absent, at
            // the sensor's own origin, as the reference records it.
            let view = match target_index {
                Some(index) => {
                    let body = &actors[index.index()];
                    PerceivedTarget {
                        present: body.present,
                        position: body.position,
                        height_m: body.dims.h,
                    }
                }
                None => PerceivedTarget {
                    present: false,
                    position: pose.position,
                    height_m: 0.0,
                },
            };
            let los = view.present
                && has_line_of_sight(
                    pose.position,
                    view.position,
                    occluders.iter().filter(|o| match o.actor {
                        Some(body) => body != sensor_slot.observer && target_index != Some(body),
                        None => true,
                    }),
                    f64::INFINITY,
                );
            let (start, end) = this.glare_ranges[slot];
            observe_target(
                &sensor_slot.sensor,
                &pose,
                &view,
                los,
                &this.config.atmosphere,
                &this.glare[start as usize..end as usize],
            )
        };
        let exposure = |observer: &str| {
            let index = this.target_slot(&exposure_cursor, observer)?;
            divergence_view(&actors[index.index()], graph)
        };
        acc.observe_tick(t, detect, exposure);
    }

    /// The trigger-facing read-back for this tick.
    pub fn view<'a>(
        &'a self,
        acc: &'a PerceptionAccumulator,
        actors: &'a [ActorRuntime],
    ) -> PerceptionView<'a> {
        PerceptionView { acc, actors }
    }
}

/// `detected` condition read-back over the accumulator's latched status.
/// Indices resolve to ids here, once per query, so the trigger layer never
/// formats a key. Absent observers/targets are gated by the trigger itself.
#[derive(Debug, Clone, Copy)]
pub struct PerceptionView<'a> {
    acc: &'a PerceptionAccumulator,
    actors: &'a [ActorRuntime],
}

impl<'a> PerceptionView<'a> {
    pub fn new(acc: &'a PerceptionAccumulator, actors: &'a [ActorRuntime]) -> Self {
        Self { acc, actors }
    }
}

impl PerceptionQuery for PerceptionView<'_> {
    fn detects(&self, observer: ActorIndex, target: ActorIndex, sensor: Option<&str>) -> bool {
        self.acc.detects(
            &self.actors[observer.index()].id,
            &self.actors[target.index()].id,
            sensor,
        )
    }

    fn has_sensor(&self, observer: ActorIndex, sensor: Option<&str>) -> bool {
        self.acc
            .has_sensor(&self.actors[observer.index()].id, sensor)
    }
}
