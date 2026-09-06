//! Episode metrics — the block that reject filters and evaluators consume.
//!
//! Accumulated online during the recorded window (`t ≥ 0`) so a long clip
//! never needs a second pass over the tick arrays. The accumulator is plain
//! serialisable state: a checkpoint carries it verbatim and continuation
//! resumes exactly where the minima and sample series left off.
//!
//! **reveal-to-conflict**: when occluders are present, each declared pair
//! tracks the last time line of sight *opened* before the criticality peak.
//! The metric is `conflictT − losOpenT`; its critical band is 0.4–1.5 s.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::math::{dist, quantize, segment_intersection, Obb, Vec2};
use crate::types::OcclusionPair;

use super::monitored_pairs::{select_metric_pair, SelectionReason};
use super::pairs::{
    ordered_pair, read_pair, read_path_conflict, read_static_obb_path_conflict,
    read_static_path_conflict, PairActor, PathScratch, StaticPathConflict, PATH_HORIZON_S,
};
use super::perception::PerceptionMetrics;
use super::{precision, quantize_all, quantize_opt};

/* ----------------------------------------------------------------- records */

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairMinDistance {
    pub pair: [String; 2],
    pub min_distance_m: f64,
    pub t: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MinTtcRecord {
    pub value: f64,
    pub t: f64,
    pub pair: [String; 2],
}

/// Route-aware TTC for a crossing whose conflict-zone occupancies overlap.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MinPathTtcRecord {
    pub value: f64,
    pub t: f64,
    pub pair: [String; 2],
    pub conflict_point: Vec2,
}

/// Minimum predicted post-encroachment time at a future route intersection.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MinPetRecord {
    pub value: f64,
    /// Simulation sample at which this prediction was made.
    pub t: f64,
    pub pair: [String; 2],
    pub conflict_point: Vec2,
    /// Predicted order through the conflict zone.
    pub first_actor: String,
    pub second_actor: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TtcSeries {
    pub pair: [String; 2],
    pub t: Vec<f64>,
    pub value: Vec<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathTtcSeries {
    pub pair: [String; 2],
    pub t: Vec<f64>,
    pub value: Vec<f64>,
    pub conflict_x: Vec<f64>,
    pub conflict_y: Vec<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetSeries {
    pub pair: [String; 2],
    pub t: Vec<f64>,
    pub value: Vec<f64>,
    pub conflict_x: Vec<f64>,
    pub conflict_y: Vec<f64>,
    pub first_actor: Vec<String>,
    pub second_actor: Vec<String>,
}

/// Finite pair-metric observations retained so consumers can select a
/// truthful minimum inside an authored time window. Episode-wide `min*`
/// records remain the canonical global summaries.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct CriticalitySamples {
    pub ttc: Vec<TtcSeries>,
    #[serde(rename = "pathTTC")]
    pub path_ttc: Vec<PathTtcSeries>,
    pub pet: Vec<PetSeries>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevealToConflict {
    /// Directional authored relation; unlike `pair`, these preserve roles.
    pub observer: String,
    pub target: String,
    /// Seconds between line of sight opening and the conflict moment.
    pub value: f64,
    /// First time the declared occluder ref actually blocked this pair.
    pub first_blocked_t: f64,
    pub los_open_t: f64,
    pub conflict_t: f64,
    pub pair: [String; 2],
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub occluder_id: Option<String>,
    pub relevant_occluder_ids: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum IneffectiveReason {
    #[serde(rename = "never_blocked_before_conflict")]
    NeverBlockedBeforeConflict,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OccluderIneffective {
    pub observer: String,
    pub target: String,
    pub pair: [String; 2],
    pub conflict_t: f64,
    /// Present when the first block happened only after `conflict_t`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_blocked_t: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub occluder_id: Option<String>,
    pub relevant_occluder_ids: Vec<String>,
    pub reason: IneffectiveReason,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeclaredOcclusionStatus {
    RevealedBeforeConflict,
    BlockedAtConflict,
    NeverBlockedBeforeConflict,
    OccluderUnobserved,
    PairUnobserved,
}

/// One result for every authored observer/target/occluder declaration.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeclaredOcclusionMetric {
    pub observer: String,
    pub target: String,
    /// Stable, unordered pair used by the distance/TTC metric tables.
    pub pair: [String; 2],
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub occluder_id: Option<String>,
    pub relevant_occluder_ids: Vec<String>,
    pub status: DeclaredOcclusionStatus,
    pub first_blocked_t: Option<f64>,
    pub los_open_t: Option<f64>,
    /// Predicted physical conflict instant (`observation t + TTC`).
    pub conflict_t: Option<f64>,
    pub reveal_to_conflict_s: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InvariantResidual {
    pub id: String,
    pub kind: String,
    pub target: f64,
    pub achieved: f64,
    pub residual: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollisionRecord {
    pub t: f64,
    pub a: String,
    pub b: String,
    /// `body` or `door:<left|right|rear>` when articulated geometry caused contact.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collider_a: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collider_b: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EpisodeMetrics {
    #[serde(rename = "minTTC")]
    pub min_ttc: Option<MinTtcRecord>,
    /// Crossing-route TTC; `None` when no future occupancy overlap was observed.
    #[serde(rename = "minPathTTC")]
    pub min_path_ttc: Option<MinPathTtcRecord>,
    /// Predicted PET at the nearest crossing-route conflict.
    #[serde(rename = "minPET")]
    pub min_pet: Option<MinPetRecord>,
    pub criticality_samples: CriticalitySamples,
    pub min_distance: Vec<PairMinDistance>,
    pub required_decel_max: BTreeMap<String, f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub invariant_residuals: Option<Vec<InvariantResidual>>,
    pub reveal_to_conflict: Option<RevealToConflict>,
    /// Complete directional evidence, one entry per authored occlusion pair.
    pub declared_occlusion: Vec<DeclaredOcclusionMetric>,
    /// Declared pairs never hidden before their closest criticality sample.
    pub occluder_ineffective: Vec<OccluderIneffective>,
    pub collisions: Vec<CollisionRecord>,
    pub trigger_never_fired: Vec<String>,
    /// `true` when the criticality peak falls outside the proportional
    /// edge-safe recorded window — the clipped-criticality reject filter.
    pub clipped_criticality: bool,
    /// Wall-clock-free performance counter: integration steps executed.
    pub ticks_simulated: u64,
    /// Per-sensor detection summary and declared map/percept divergence
    /// exposure. Absent when no sensor and no divergence is declared.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub perception: Option<PerceptionMetrics>,
}

impl EpisodeMetrics {
    /// Quantise derived floats so trace digests do not encode insignificant ULPs.
    pub fn quantize(&mut self) {
        let p = precision::METRIC;
        if let Some(r) = &mut self.min_ttc {
            r.value = quantize(r.value, p);
            r.t = quantize(r.t, p);
        }
        if let Some(r) = &mut self.min_path_ttc {
            r.value = quantize(r.value, p);
            r.t = quantize(r.t, p);
            r.conflict_point = quantize_point(r.conflict_point, p);
        }
        if let Some(r) = &mut self.min_pet {
            r.value = quantize(r.value, p);
            r.t = quantize(r.t, p);
            r.conflict_point = quantize_point(r.conflict_point, p);
        }
        for s in &mut self.criticality_samples.ttc {
            quantize_all(&mut s.t, p);
            quantize_all(&mut s.value, p);
        }
        for s in &mut self.criticality_samples.path_ttc {
            quantize_all(&mut s.t, p);
            quantize_all(&mut s.value, p);
            quantize_all(&mut s.conflict_x, p);
            quantize_all(&mut s.conflict_y, p);
        }
        for s in &mut self.criticality_samples.pet {
            quantize_all(&mut s.t, p);
            quantize_all(&mut s.value, p);
            quantize_all(&mut s.conflict_x, p);
            quantize_all(&mut s.conflict_y, p);
        }
        for d in &mut self.min_distance {
            d.min_distance_m = quantize(d.min_distance_m, p);
            d.t = quantize(d.t, p);
        }
        for v in self.required_decel_max.values_mut() {
            *v = quantize(*v, p);
        }
        if let Some(residuals) = &mut self.invariant_residuals {
            for r in residuals {
                r.target = quantize(r.target, p);
                r.achieved = quantize(r.achieved, p);
                r.residual = quantize(r.residual, p);
            }
        }
        if let Some(r) = &mut self.reveal_to_conflict {
            r.value = quantize(r.value, p);
            r.first_blocked_t = quantize(r.first_blocked_t, p);
            r.los_open_t = quantize(r.los_open_t, p);
            r.conflict_t = quantize(r.conflict_t, p);
        }
        for d in &mut self.declared_occlusion {
            quantize_opt(&mut d.first_blocked_t, p);
            quantize_opt(&mut d.los_open_t, p);
            quantize_opt(&mut d.conflict_t, p);
            quantize_opt(&mut d.reveal_to_conflict_s, p);
        }
        for o in &mut self.occluder_ineffective {
            o.conflict_t = quantize(o.conflict_t, p);
            quantize_opt(&mut o.first_blocked_t, p);
        }
        for c in &mut self.collisions {
            c.t = quantize(c.t, p);
        }
        if let Some(perception) = &mut self.perception {
            perception.quantize(p);
        }
    }
}

fn quantize_point(p: Vec2, decimals: i32) -> Vec2 {
    Vec2::new(quantize(p.x, decimals), quantize(p.y, decimals))
}

/// Keep criticality away from the recorded edges without imposing a
/// long-clip assumption: four seconds at each end of a 20 s clip, the same
/// 20% proportion for compact clips.
pub fn criticality_window(clip_seconds: f64) -> (f64, f64) {
    let edge_guard = (clip_seconds * 0.2).min(4.0);
    (edge_guard, (clip_seconds - edge_guard).max(edge_guard))
}

/* ------------------------------------------------------------ accumulator */

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct PairAccumulator {
    a: String,
    b: String,
    min_distance: f64,
    min_distance_t: f64,
    min_ttc: f64,
    min_ttc_t: f64,
    min_path_ttc: f64,
    min_path_ttc_t: f64,
    min_path_ttc_point: Option<Vec2>,
    min_pet: f64,
    min_pet_t: f64,
    min_pet_point: Option<Vec2>,
    /// `true` when `a` is predicted first through the zone at the PET minimum.
    min_pet_a_first: Option<bool>,
    ttc_t: Vec<f64>,
    ttc_value: Vec<f64>,
    path_ttc_t: Vec<f64>,
    path_ttc_value: Vec<f64>,
    path_ttc_x: Vec<f64>,
    path_ttc_y: Vec<f64>,
    pet_t: Vec<f64>,
    pet_value: Vec<f64>,
    pet_x: Vec<f64>,
    pet_y: Vec<f64>,
    pet_a_first: Vec<bool>,
}

impl PairAccumulator {
    fn new(a: &str, b: &str) -> Self {
        let (lo, hi) = ordered_pair(a, b);
        Self {
            a: lo.to_owned(),
            b: hi.to_owned(),
            min_distance: f64::INFINITY,
            min_distance_t: 0.0,
            min_ttc: f64::INFINITY,
            min_ttc_t: 0.0,
            min_path_ttc: f64::INFINITY,
            min_path_ttc_t: 0.0,
            min_path_ttc_point: None,
            min_pet: f64::INFINITY,
            min_pet_t: 0.0,
            min_pet_point: None,
            min_pet_a_first: None,
            ttc_t: Vec::new(),
            ttc_value: Vec::new(),
            path_ttc_t: Vec::new(),
            path_ttc_value: Vec::new(),
            path_ttc_x: Vec::new(),
            path_ttc_y: Vec::new(),
            pet_t: Vec::new(),
            pet_value: Vec::new(),
            pet_x: Vec::new(),
            pet_y: Vec::new(),
            pet_a_first: Vec::new(),
        }
    }

    fn pair(&self) -> [String; 2] {
        [self.a.clone(), self.b.clone()]
    }

    fn pet_actors(&self, a_first: bool) -> (String, String) {
        if a_first {
            (self.a.clone(), self.b.clone())
        } else {
            (self.b.clone(), self.a.clone())
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BlockedInterval {
    start_t: f64,
    end_t: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OcclusionMonitor {
    observer: String,
    target: String,
    occluder_id: Option<String>,
    /// Concrete ids observed for this declared ref; proves a non-vacuous set.
    relevant_occluder_ids: BTreeSet<String>,
    /// Blocked intervals observed after t=0, transition-compressed.
    blocked_intervals: Vec<BlockedInterval>,
    first_blocked_t: Option<f64>,
    /// Most recent transition from blocked to clear line of sight.
    los_open_t: Option<f64>,
    los_blocked: bool,
    saw_occluder: bool,
    saw_blocked: bool,
}

impl OcclusionMonitor {
    fn matches(&self, a: &str, b: &str) -> bool {
        let (lo, hi) = ordered_pair(a, b);
        let (mlo, mhi) = ordered_pair(&self.observer, &self.target);
        lo == mlo && hi == mhi
    }

    fn sorted_pair(&self) -> [String; 2] {
        let (lo, hi) = ordered_pair(&self.observer, &self.target);
        [lo.to_owned(), hi.to_owned()]
    }

    fn relevant_ids(&self) -> Vec<String> {
        self.relevant_occluder_ids.iter().cloned().collect()
    }

    /// Latest blocked interval that opened before `conflict_t` and closed at
    /// or before it; an interval still open (or closing after) at conflict
    /// means the target is hidden at conflict.
    fn reveal_open_t_at_conflict(&self, conflict_t: f64) -> Option<f64> {
        let latest = self
            .blocked_intervals
            .iter()
            .take_while(|i| i.start_t <= conflict_t)
            .last()?;
        match latest.end_t {
            Some(end) if end <= conflict_t => Some(end),
            _ => None,
        }
    }
}

/// A line-of-sight blocker as the metric layer sees it: identity, optional
/// author-level group and ground-plane outline. The engine's occluder type
/// implements this; no shape is copied per tick.
pub trait OccluderView {
    fn id(&self) -> &str;
    fn group_id(&self) -> Option<&str>;
    fn corners(&self) -> &[Vec2];
}

/// One fixed collision shape owned by a static actor on this tick
/// (`body`, `door:left`, …).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StaticShape<'a> {
    pub actor_id: &'a str,
    pub name: &'a str,
    pub obb: Obb,
}

#[inline]
fn occluder_relevant<O: OccluderView>(occluder_id: Option<&str>, o: &O) -> bool {
    match occluder_id {
        Some(id) => o.id() == id || o.group_id() == Some(id),
        None => true,
    }
}

/// Smallest sample of one series observed inside `[lo, hi]`; `INFINITY` when none.
fn window_minimum<'p>(
    pairs: &'p [PairAccumulator],
    lo: f64,
    hi: f64,
    series: impl Fn(&'p PairAccumulator) -> (&'p Vec<f64>, &'p Vec<f64>),
) -> f64 {
    let mut value = f64::INFINITY;
    for p in pairs {
        let (ts, vs) = series(p);
        for (t, v) in ts.iter().zip(vs) {
            if *t >= lo && *t <= hi && *v < value {
                value = *v;
            }
        }
    }
    value
}

/// `true` when the segment `a → b` is within range and not blocked by any
/// occluder accepted by `relevant`.
pub fn has_line_of_sight<'o, O: OccluderView + 'o>(
    a: Vec2,
    b: Vec2,
    occluders: impl IntoIterator<Item = &'o O>,
    max_range_m: f64,
) -> bool {
    if dist(a, b) > max_range_m {
        return false;
    }
    for occ in occluders {
        let c = occ.corners();
        for i in 0..c.len() {
            if segment_intersection(a, b, c[i], c[(i + 1) % c.len()]).is_some() {
                return false;
            }
        }
    }
    true
}

/// Read-only pair minima for live inspection.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PairMinimaView<'a> {
    pub a: &'a str,
    pub b: &'a str,
    pub min_distance_m: f64,
    pub min_distance_t: f64,
    pub min_ttc_s: f64,
    pub min_ttc_t: f64,
    pub min_path_ttc_s: f64,
    pub min_pet_s: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricAccumulator {
    /// When set, only pairs containing this actor enter episode criticality.
    metric_subject: Option<String>,
    /// Generated background road users; a pair touching one is never scored.
    ambient_actor_ids: BTreeSet<String>,
    /// Sorted by `(a, b)` for allocation-free lookup.
    pairs: Vec<PairAccumulator>,
    occlusion_monitors: Vec<OcclusionMonitor>,
    required_decel_max: BTreeMap<String, f64>,
    collisions: Vec<CollisionRecord>,
    trigger_never_fired: Vec<String>,
    ticks: u64,
    #[serde(skip)]
    scratch: PathScratch,
}

impl MetricAccumulator {
    pub fn new(
        actor_ids: impl IntoIterator<Item = impl Into<String>>,
        occlusion_pairs: &[OcclusionPair],
        metric_subject: Option<&str>,
        ambient_actor_ids: impl IntoIterator<Item = impl Into<String>>,
    ) -> Self {
        let mut monitors: Vec<OcclusionMonitor> = occlusion_pairs
            .iter()
            .map(|p| OcclusionMonitor {
                observer: p.observer.clone(),
                target: p.target.clone(),
                occluder_id: p.occluder_id.clone(),
                relevant_occluder_ids: BTreeSet::new(),
                blocked_intervals: Vec::new(),
                first_blocked_t: None,
                los_open_t: None,
                los_blocked: false,
                saw_occluder: false,
                saw_blocked: false,
            })
            .collect();
        monitors.sort_by(|x, y| {
            x.sorted_pair().cmp(&y.sorted_pair()).then_with(|| {
                x.occluder_id
                    .as_deref()
                    .unwrap_or("")
                    .cmp(y.occluder_id.as_deref().unwrap_or(""))
            })
        });
        Self {
            metric_subject: metric_subject.map(str::to_owned),
            ambient_actor_ids: ambient_actor_ids.into_iter().map(Into::into).collect(),
            pairs: Vec::new(),
            occlusion_monitors: monitors,
            required_decel_max: actor_ids.into_iter().map(|id| (id.into(), 0.0)).collect(),
            collisions: Vec::new(),
            trigger_never_fired: Vec::new(),
            ticks: 0,
            scratch: PathScratch::new(),
        }
    }

    pub fn metric_subject(&self) -> Option<&str> {
        self.metric_subject.as_deref()
    }

    pub fn ambient_actor_ids(&self) -> &BTreeSet<String> {
        &self.ambient_actor_ids
    }

    pub fn ticks(&self) -> u64 {
        self.ticks
    }

    pub fn collisions(&self) -> &[CollisionRecord] {
        &self.collisions
    }

    /// Per-pair minima observed so far, sorted by `(a, b)`; `INFINITY`
    /// where no finite sample exists. The `peek` surface for live worlds.
    pub fn pair_minima(&self) -> impl Iterator<Item = PairMinimaView<'_>> {
        self.pairs.iter().map(|p| PairMinimaView {
            a: &p.a,
            b: &p.b,
            min_distance_m: p.min_distance,
            min_distance_t: p.min_distance_t,
            min_ttc_s: p.min_ttc,
            min_ttc_t: p.min_ttc_t,
            min_path_ttc_s: p.min_path_ttc,
            min_pet_s: p.min_pet,
        })
    }

    /// Register an actor that joined the world after construction (spawned
    /// ambient traffic, `exist` interactions).
    pub fn add_actor(&mut self, actor_id: &str) {
        self.required_decel_max
            .entry(actor_id.to_owned())
            .or_insert(0.0);
    }

    /// Fold the braking demand an actor needed on this tick into its maximum.
    pub fn record_required_decel(&mut self, actor_id: &str, decel_mps2: f64) {
        match self.required_decel_max.get_mut(actor_id) {
            Some(v) => *v = v.max(decel_mps2),
            None => {
                self.required_decel_max
                    .insert(actor_id.to_owned(), decel_mps2.max(0.0));
            }
        }
    }

    pub fn record_collision(&mut self, record: CollisionRecord) {
        self.collisions.push(record);
    }

    pub fn record_trigger_never_fired(&mut self, interaction_id: &str) {
        self.trigger_never_fired.push(interaction_id.to_owned());
    }

    fn pair_index(&self, a: &str, b: &str) -> Result<usize, usize> {
        let (lo, hi) = ordered_pair(a, b);
        self.pairs
            .binary_search_by(|p| p.a.as_str().cmp(lo).then_with(|| p.b.as_str().cmp(hi)))
    }

    fn pair_mut(&mut self, a: &str, b: &str) -> &mut PairAccumulator {
        let index = match self.pair_index(a, b) {
            Ok(i) => i,
            Err(i) => {
                self.pairs.insert(i, PairAccumulator::new(a, b));
                i
            }
        };
        &mut self.pairs[index]
    }

    /// Fold one recorded tick into the accumulator.
    ///
    /// `actors` is the complete world; only present, unretired bodies pair.
    /// `static_shapes` lists every fixed collision shape owned by static
    /// actors on this tick (body plus articulated doors), `occluders` the
    /// tick's line-of-sight blockers.
    pub fn observe_tick<A: PairActor, O: OccluderView>(
        &mut self,
        t: f64,
        actors: &[A],
        occluders: &[O],
        visibility_range_m: f64,
        static_shapes: &[StaticShape<'_>],
    ) {
        self.ticks += 1;
        let mut scratch = std::mem::take(&mut self.scratch);
        for i in 0..actors.len() {
            let a = &actors[i];
            if !(a.is_present() && !a.is_retired()) {
                continue;
            }
            for b in &actors[i + 1..] {
                if !(b.is_present() && !b.is_retired()) {
                    continue;
                }
                self.observe_pair(
                    t,
                    a,
                    b,
                    occluders,
                    visibility_range_m,
                    static_shapes,
                    &mut scratch,
                );
            }
        }
        self.scratch = scratch;
    }

    #[allow(clippy::too_many_arguments)]
    fn observe_pair<A: PairActor, O: OccluderView>(
        &mut self,
        t: f64,
        a: &A,
        b: &A,
        occluders: &[O],
        visibility_range_m: f64,
        static_shapes: &[StaticShape<'_>],
        scratch: &mut PathScratch,
    ) {
        let both_static = a.is_static() && b.is_static();
        let (static_actor, moving_actor) = if a.is_static() {
            (Some(a), Some(b))
        } else if b.is_static() {
            (Some(b), Some(a))
        } else {
            (None, None)
        };
        let static_id = static_actor.map(|s| s.id());
        let has_articulated_shape = static_id.is_some_and(|id| {
            static_shapes
                .iter()
                .any(|s| s.actor_id == id && s.name.starts_with("door:"))
        });
        let explicit = self
            .occlusion_monitors
            .iter()
            .any(|m| m.matches(a.id(), b.id()));
        let selection = select_metric_pair(
            self.metric_subject.as_deref(),
            explicit,
            &self.ambient_actor_ids,
            a.id(),
            b.id(),
            has_articulated_shape,
        );
        // Hard stop: an ambient pair is never scored, not even through the
        // articulated-static escape hatch below.
        if selection.reason == SelectionReason::AmbientExcluded {
            return;
        }
        if !selection.scored && !selection.monitored && !has_articulated_shape {
            return;
        }
        // Static actors are physical collidables, but only a dynamic-static
        // collision course enters criticality metrics, so an adjacent parked
        // actor cannot steal the incident. Nearest path conflict over the
        // static body footprint and every articulated shape.
        let static_path: Option<StaticPathConflict> = match (static_actor, moving_actor) {
            (Some(fixed), Some(moving)) => {
                let mut best = read_static_path_conflict(moving, fixed, PATH_HORIZON_S, t, scratch);
                for shape in static_shapes.iter().filter(|s| s.actor_id == fixed.id()) {
                    if let Some(path) = read_static_obb_path_conflict(
                        moving,
                        &shape.obb,
                        PATH_HORIZON_S,
                        t,
                        scratch,
                    ) {
                        if best.is_none_or(|b| path.path_ttc_s < b.path_ttc_s) {
                            best = Some(path);
                        }
                    }
                }
                best
            }
            _ => None,
        };
        let score_pair = if both_static {
            selection.scored
        } else {
            (selection.scored || has_articulated_shape)
                && (!(a.is_static() || b.is_static()) || static_path.is_some())
        };
        if score_pair {
            let readout = read_pair(a, b);
            let ttc = static_path.map_or(readout.ttc_s, |s| s.path_ttc_s);
            let path = match static_path {
                Some(s) => Some((s.path_ttc_s, f64::INFINITY, s.conflict_point, 0.0, 0.0)),
                None => read_path_conflict(a, b, PATH_HORIZON_S, t, scratch).map(|p| {
                    (
                        p.path_ttc_s,
                        p.pet_s,
                        p.conflict_point,
                        p.arrival_a_s,
                        p.arrival_b_s,
                    )
                }),
            };
            let a_is_lo = a.id() < b.id();
            let p = self.pair_mut(a.id(), b.id());
            if readout.gap_m < p.min_distance {
                p.min_distance = readout.gap_m;
                p.min_distance_t = t;
            }
            if ttc.is_finite() {
                p.ttc_t.push(t);
                p.ttc_value.push(ttc);
            }
            if ttc < p.min_ttc {
                p.min_ttc = ttc;
                p.min_ttc_t = t;
            }
            if let Some((path_ttc, pet, point, arrival_a, arrival_b)) = path {
                if path_ttc < p.min_path_ttc {
                    p.min_path_ttc = path_ttc;
                    p.min_path_ttc_t = t;
                    p.min_path_ttc_point = Some(point);
                }
                if path_ttc.is_finite() {
                    p.path_ttc_t.push(t);
                    p.path_ttc_value.push(path_ttc);
                    p.path_ttc_x.push(point.x);
                    p.path_ttc_y.push(point.y);
                }
                // PET is defined only after one participant has cleared the
                // conflict zone; zero means simultaneous occupancy and is owned
                // by collision/path-TTC.
                if pet.is_finite() && pet > 0.0 {
                    // `arrival_a` belongs to the actor passed first, which may
                    // be the pair's `b` in canonical order.
                    let first_is_lo = if arrival_a <= arrival_b {
                        a_is_lo
                    } else {
                        !a_is_lo
                    };
                    if pet < p.min_pet {
                        p.min_pet = pet;
                        p.min_pet_t = t;
                        p.min_pet_point = Some(point);
                        p.min_pet_a_first = Some(first_is_lo);
                    }
                    p.pet_t.push(t);
                    p.pet_value.push(pet);
                    p.pet_x.push(point.x);
                    p.pet_y.push(point.y);
                    p.pet_a_first.push(first_is_lo);
                }
            }
        }
        let pa = a.position();
        let pb = b.position();
        for monitor in self
            .occlusion_monitors
            .iter_mut()
            .filter(|m| m.matches(a.id(), b.id()))
        {
            let occluder_id = monitor.occluder_id.as_deref();
            if !occluders.iter().any(|o| occluder_relevant(occluder_id, o)) {
                continue;
            }
            monitor.saw_occluder = true;
            for o in occluders
                .iter()
                .filter(|o| occluder_relevant(occluder_id, *o))
            {
                if !monitor.relevant_occluder_ids.contains(o.id()) {
                    monitor.relevant_occluder_ids.insert(o.id().to_owned());
                }
            }
            let clear = has_line_of_sight(
                pa,
                pb,
                occluders
                    .iter()
                    .filter(|o| occluder_relevant(occluder_id, *o)),
                visibility_range_m,
            );
            if !clear {
                if !monitor.los_blocked {
                    monitor.blocked_intervals.push(BlockedInterval {
                        start_t: t,
                        end_t: None,
                    });
                }
                if monitor.first_blocked_t.is_none() {
                    monitor.first_blocked_t = Some(t);
                }
                monitor.los_blocked = true;
                monitor.saw_blocked = true;
            } else if monitor.los_blocked {
                monitor.los_blocked = false;
                monitor.los_open_t = Some(t);
                if let Some(latest) = monitor.blocked_intervals.last_mut() {
                    latest.end_t = Some(t);
                }
            }
        }
    }

    /// Finalise the episode summary. `perception` is attached verbatim.
    pub fn compute(
        &self,
        clip_seconds: f64,
        perception: Option<PerceptionMetrics>,
    ) -> EpisodeMetrics {
        let mut min_distance = Vec::new();
        let mut min_ttc: Option<MinTtcRecord> = None;
        let mut min_path_ttc: Option<MinPathTtcRecord> = None;
        let mut min_pet: Option<MinPetRecord> = None;
        for p in &self.pairs {
            if p.min_distance.is_finite() {
                min_distance.push(PairMinDistance {
                    pair: p.pair(),
                    min_distance_m: p.min_distance,
                    t: p.min_distance_t,
                });
            }
            if p.min_ttc.is_finite() && min_ttc.as_ref().is_none_or(|m| p.min_ttc < m.value) {
                min_ttc = Some(MinTtcRecord {
                    value: p.min_ttc,
                    t: p.min_ttc_t,
                    pair: p.pair(),
                });
            }
            if let Some(point) = p.min_path_ttc_point {
                if p.min_path_ttc.is_finite()
                    && min_path_ttc
                        .as_ref()
                        .is_none_or(|m| p.min_path_ttc < m.value)
                {
                    min_path_ttc = Some(MinPathTtcRecord {
                        value: p.min_path_ttc,
                        t: p.min_path_ttc_t,
                        pair: p.pair(),
                        conflict_point: point,
                    });
                }
            }
            if let (Some(point), Some(a_first)) = (p.min_pet_point, p.min_pet_a_first) {
                if p.min_pet.is_finite() && min_pet.as_ref().is_none_or(|m| p.min_pet < m.value) {
                    let (first_actor, second_actor) = p.pet_actors(a_first);
                    min_pet = Some(MinPetRecord {
                        value: p.min_pet,
                        t: p.min_pet_t,
                        pair: p.pair(),
                        conflict_point: point,
                        first_actor,
                        second_actor,
                    });
                }
            }
        }

        let declared_occlusion: Vec<DeclaredOcclusionMetric> = self
            .occlusion_monitors
            .iter()
            .map(|monitor| {
                let p = self
                    .pair_index(&monitor.observer, &monitor.target)
                    .ok()
                    .map(|i| &self.pairs[i]);
                let base = |status, first_blocked_t, los_open_t, conflict_t, reveal| {
                    DeclaredOcclusionMetric {
                        observer: monitor.observer.clone(),
                        target: monitor.target.clone(),
                        pair: monitor.sorted_pair(),
                        occluder_id: monitor.occluder_id.clone(),
                        relevant_occluder_ids: monitor.relevant_ids(),
                        status,
                        first_blocked_t,
                        los_open_t,
                        conflict_t,
                        reveal_to_conflict_s: reveal,
                    }
                };
                let Some(p) = p.filter(|p| p.min_distance.is_finite()) else {
                    return base(
                        DeclaredOcclusionStatus::PairUnobserved,
                        monitor.first_blocked_t,
                        None,
                        None,
                        None,
                    );
                };
                // Reveal evidence is bound to the predicted physical conflict
                // instant, not the earlier sample at which TTC was minimal.
                let conflict_t = if p.min_path_ttc < p.min_ttc {
                    p.min_path_ttc_t + p.min_path_ttc
                } else if p.min_ttc == f64::INFINITY {
                    p.min_distance_t
                } else {
                    p.min_ttc_t + p.min_ttc
                };
                if !monitor.saw_occluder {
                    return base(
                        DeclaredOcclusionStatus::OccluderUnobserved,
                        monitor.first_blocked_t,
                        None,
                        Some(conflict_t),
                        None,
                    );
                }
                if let Some(los_open_t) = monitor.reveal_open_t_at_conflict(conflict_t) {
                    return base(
                        DeclaredOcclusionStatus::RevealedBeforeConflict,
                        monitor.first_blocked_t,
                        Some(los_open_t),
                        Some(conflict_t),
                        Some(conflict_t - los_open_t),
                    );
                }
                if monitor.first_blocked_t.is_none_or(|fb| fb > conflict_t) {
                    return base(
                        DeclaredOcclusionStatus::NeverBlockedBeforeConflict,
                        monitor.first_blocked_t,
                        None,
                        Some(conflict_t),
                        None,
                    );
                }
                base(
                    DeclaredOcclusionStatus::BlockedAtConflict,
                    monitor.first_blocked_t,
                    None,
                    Some(conflict_t),
                    None,
                )
            })
            .collect();

        let ttc_criticality: Option<(f64, f64, &[String; 2])> = match (&min_path_ttc, &min_ttc) {
            (Some(path), Some(ttc))
                if path.value < ttc.value || (path.value == ttc.value && path.t < ttc.t) =>
            {
                Some((path.value, path.t, &path.pair))
            }
            (Some(path), None) => Some((path.value, path.t, &path.pair)),
            (_, Some(ttc)) => Some((ttc.value, ttc.t, &ttc.pair)),
            (None, None) => None,
        };
        let effective_criticality = match &min_pet {
            Some(pet) if pet.value > 0.0 && ttc_criticality.is_none_or(|(v, _, _)| v > 3.0) => {
                Some((pet.value, pet.t, &pet.pair))
            }
            _ => ttc_criticality,
        };

        let mut reveal_to_conflict = None;
        if let Some((value, t, pair)) = effective_criticality {
            let best = declared_occlusion
                .iter()
                .filter(|m| {
                    m.status == DeclaredOcclusionStatus::RevealedBeforeConflict
                        && m.pair == *pair
                        && m.los_open_t.is_some()
                })
                .max_by(|x, y| {
                    x.los_open_t
                        .partial_cmp(&y.los_open_t)
                        .unwrap_or(std::cmp::Ordering::Equal)
                });
            if let Some(best) = best {
                let los_open_t = best.los_open_t.unwrap_or(0.0);
                let conflict_t = best.conflict_t.unwrap_or(t + value);
                reveal_to_conflict = Some(RevealToConflict {
                    observer: best.observer.clone(),
                    target: best.target.clone(),
                    value: conflict_t - los_open_t,
                    first_blocked_t: best.first_blocked_t.unwrap_or(los_open_t),
                    los_open_t,
                    conflict_t,
                    pair: pair.clone(),
                    occluder_id: best.occluder_id.clone(),
                    relevant_occluder_ids: best.relevant_occluder_ids.clone(),
                });
            }
        }
        let occluder_ineffective = declared_occlusion
            .iter()
            .filter(|m| m.status == DeclaredOcclusionStatus::NeverBlockedBeforeConflict)
            .filter_map(|m| {
                Some(OccluderIneffective {
                    observer: m.observer.clone(),
                    target: m.target.clone(),
                    pair: m.pair.clone(),
                    conflict_t: m.conflict_t?,
                    first_blocked_t: m.first_blocked_t,
                    occluder_id: m.occluder_id.clone(),
                    relevant_occluder_ids: m.relevant_occluder_ids.clone(),
                    reason: IneffectiveReason::NeverBlockedBeforeConflict,
                })
            })
            .collect();

        let (lo, hi) = criticality_window(clip_seconds);
        let window_ttc = window_minimum(&self.pairs, lo, hi, |p| (&p.ttc_t, &p.ttc_value));
        let window_path_ttc =
            window_minimum(&self.pairs, lo, hi, |p| (&p.path_ttc_t, &p.path_ttc_value));
        let window_ttc_criticality = window_ttc.min(window_path_ttc);
        let window_pet = window_minimum(&self.pairs, lo, hi, |p| (&p.pet_t, &p.pet_value));
        let window_has_criticality = window_ttc_criticality.is_finite()
            || (window_pet.is_finite()
                && window_pet > 0.0
                && (!window_ttc_criticality.is_finite() || window_ttc_criticality > 3.0));
        let clipped = effective_criticality.is_some() && !window_has_criticality;

        let criticality_samples = CriticalitySamples {
            ttc: self
                .pairs
                .iter()
                .filter(|p| !p.ttc_t.is_empty())
                .map(|p| TtcSeries {
                    pair: p.pair(),
                    t: p.ttc_t.clone(),
                    value: p.ttc_value.clone(),
                })
                .collect(),
            path_ttc: self
                .pairs
                .iter()
                .filter(|p| !p.path_ttc_t.is_empty())
                .map(|p| PathTtcSeries {
                    pair: p.pair(),
                    t: p.path_ttc_t.clone(),
                    value: p.path_ttc_value.clone(),
                    conflict_x: p.path_ttc_x.clone(),
                    conflict_y: p.path_ttc_y.clone(),
                })
                .collect(),
            pet: self
                .pairs
                .iter()
                .filter(|p| !p.pet_t.is_empty())
                .map(|p| {
                    let (first_actor, second_actor) = p
                        .pet_a_first
                        .iter()
                        .map(|&a_first| p.pet_actors(a_first))
                        .unzip();
                    PetSeries {
                        pair: p.pair(),
                        t: p.pet_t.clone(),
                        value: p.pet_value.clone(),
                        conflict_x: p.pet_x.clone(),
                        conflict_y: p.pet_y.clone(),
                        first_actor,
                        second_actor,
                    }
                })
                .collect(),
        };

        let mut collisions = self.collisions.clone();
        collisions.sort_by(|x, y| {
            x.t.partial_cmp(&y.t)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| x.a.cmp(&y.a))
        });
        let trigger_never_fired: Vec<String> = self
            .trigger_never_fired
            .iter()
            .cloned()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();

        EpisodeMetrics {
            min_ttc,
            min_path_ttc,
            min_pet,
            criticality_samples,
            min_distance,
            required_decel_max: self.required_decel_max.clone(),
            invariant_residuals: None,
            reveal_to_conflict,
            declared_occlusion,
            occluder_ineffective,
            collisions,
            trigger_never_fired,
            clipped_criticality: clipped,
            ticks_simulated: self.ticks,
            perception,
        }
    }
}
