//! Tier-2 invariant residuals.
//!
//! The engine types `metrics.invariantResiduals` and deliberately leaves it
//! empty: invariants live in the template layer, so only something that has
//! read the template can populate it. That is this module.
//!
//! The rule it follows is *absolute values are re-derived, relations are
//! preserved*: every check is a relation between two actors or between an
//! actor and the posted limit, and every residual is reported in the
//! invariant's own units with the sign that says which way it missed.
//!
//! Where a check is an approximation it says so in `method`, because a
//! residual whose provenance is unclear is a number nobody can act on:
//!
//! | invariant | source |
//! |---|---|
//! | `ttc` | `metrics.minTTC` (engine, closing-speed form) |
//! | `path_ttc` | `metrics.minPathTTC` (route/conflict-zone occupancy) |
//! | `pet` | `metrics.minPET` (route-intersection occupancy separation) |
//! | `near_miss` | exact sampled OBB clearance (`verify_near_miss_outcome`) |
//! | `gap` (distance) | `metrics.minDistance` for the pair, or the pair series inside a window |
//! | `gap` (time), `headway` | per-tick centre distance ÷ follower speed — Euclidean, not along-lane |
//! | `closing_speed` | per-tick range rate at the criticality peak |
//! | `speed_rel_limit` | per-tick speed ÷ the entry lane's posted limit |
//! | `event_order` | `trigger_fired` events |
//! | `decel_budget` | `metrics.requiredDecelMax` |
//! | `detection_gap`, `time_to_first_detection`, `perception_lag`, `map_divergence` | `metrics.perception` |
//! | `arrival` | the arrival solver's achieved Δt |
//!
//! An invariant that silently grades nothing is the failure this layer exists
//! to prevent, so a missing observation is reported `unchecked` with the
//! reason rather than passing by default. Likewise an authored expression that
//! cannot be lowered (window, `minSeparationS`, `maxMps2`) yields `unchecked`
//! naming the expression error instead of widening the constraint.

use std::collections::BTreeMap;

use serde::Serialize;
use simforge_core::evaluation::{
    criticality_metrics_in_window, verify_near_miss_outcome, NearMissOptions,
};
use simforge_core::hash::js_number_to_string;
use simforge_core::math::{hypot, js_round};
use simforge_core::solve::ArrivalSolution;
use simforge_core::trace::perception::DetectionReason;
use simforge_core::trace::{SensorPerceptionMetric, SimEvent, SimTrace};

use crate::expr::{ExprScope, NumberOrExpr};
use crate::template::{
    DetectionGapReason, GapMetric, GapUnit, Invariant, InvariantKind, Range, ScenarioTemplate,
};

/// `Number.MAX_SAFE_INTEGER`: the reference disables the near-miss tolerance
/// band by passing it as the tolerance.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum InvariantStatus {
    Held,
    Violated,
    Unchecked,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct InvariantResidualReport {
    pub id: String,
    pub kind: &'static str,
    pub essentiality: &'static str,
    pub status: InvariantStatus,
    pub range: Option<Range>,
    pub achieved: Option<f64>,
    /// Signed distance outside the range, in the invariant's own units.
    pub residual: f64,
    pub method: &'static str,
    pub reason: String,
}

pub struct InvariantContext<'a> {
    pub template: &'a ScenarioTemplate,
    pub trace: &'a SimTrace,
    pub scope: &'a ExprScope,
    pub arrival: &'a [ArrivalSolution],
    /// Posted limit of the reference lane, kph — what `speed_rel_limit` divides by.
    pub speed_limit_kph: Option<f64>,
}

/* ---------------------------------------------------------------- helpers */

fn outside(range: Range, value: f64) -> f64 {
    if let Some(lo) = range.0 {
        if value < lo {
            return value - lo;
        }
    }
    if let Some(hi) = range.1 {
        if value > hi {
            return value - hi;
        }
    }
    0.0
}

fn fmt_bound(bound: Option<f64>, open: &str) -> String {
    bound.map_or_else(|| open.to_owned(), js_number_to_string)
}

fn fmt_range(range: Range) -> String {
    format!(
        "[{}, {}]",
        fmt_bound(range.0, "−∞"),
        fmt_bound(range.1, "∞")
    )
}

/// `Math.round(x * 1000) / 1000`, with `-0` normalised so JSON carries `0`.
fn round3(value: f64) -> f64 {
    js_round(value * 1000.0) / 1000.0 + 0.0
}

/// ECMAScript `Number.prototype.toFixed` for finite `|x| < 1e21`: the
/// nearest `n / 10^digits`, ties resolved toward the larger `n` (away from
/// zero once the sign is restored). Rust's `{:.N}` breaks exact ties to
/// even, so it is not a drop-in.
pub(crate) fn to_fixed(value: f64, digits: usize) -> String {
    if !value.is_finite() || value.abs() >= 1e21 {
        return js_number_to_string(value);
    }
    // Enough exact decimals that any non-tie is separated from the tie
    // digit pattern by far more than an ulp at every magnitude below 1e21.
    let exact = format!("{:.*}", digits + 26, value.abs());
    let (int, frac) = exact
        .split_once('.')
        .expect("fixed formatting emits a decimal point");
    let (keep, rest) = frac.split_at(digits);
    let mut out = Vec::with_capacity(int.len() + digits + 1);
    out.extend_from_slice(int.as_bytes());
    out.extend_from_slice(keep.as_bytes());
    if rest.as_bytes()[0] >= b'5' {
        let mut i = out.len();
        loop {
            if i == 0 {
                out.insert(0, b'1');
                break;
            }
            i -= 1;
            if out[i] == b'9' {
                out[i] = b'0';
            } else {
                out[i] += 1;
                break;
            }
        }
    }
    let split = out.len() - digits;
    let mut s = String::with_capacity(out.len() + 2);
    if value < 0.0 {
        s.push('-');
    }
    s.push_str(std::str::from_utf8(&out[..split]).expect("ascii digits"));
    if digits > 0 {
        s.push('.');
        s.push_str(std::str::from_utf8(&out[split..]).expect("ascii digits"));
    }
    s
}

fn kind_name(kind: &InvariantKind) -> &'static str {
    match kind {
        InvariantKind::Headway { .. } => "headway",
        InvariantKind::Gap { .. } => "gap",
        InvariantKind::Ttc { .. } => "ttc",
        InvariantKind::PathTtc { .. } => "path_ttc",
        InvariantKind::Pet { .. } => "pet",
        InvariantKind::NearMiss { .. } => "near_miss",
        InvariantKind::Arrival { .. } => "arrival",
        InvariantKind::ClosingSpeed { .. } => "closing_speed",
        InvariantKind::SpeedRelLimit { .. } => "speed_rel_limit",
        InvariantKind::EventOrder { .. } => "event_order",
        InvariantKind::DecelBudget { .. } => "decel_budget",
        InvariantKind::DetectionGap { .. } => "detection_gap",
        InvariantKind::TimeToFirstDetection { .. } => "time_to_first_detection",
        InvariantKind::PerceptionLag { .. } => "perception_lag",
        InvariantKind::MapDivergence { .. } => "map_divergence",
    }
}

fn gap_metric_name(metric: GapMetric) -> &'static str {
    match metric {
        GapMetric::Longest => "longest",
        GapMetric::Total => "total",
    }
}

/// The authored dropout cause, as the perception channel records it.
fn detection_reason(reason: DetectionGapReason) -> DetectionReason {
    match reason {
        DetectionGapReason::Occluded => DetectionReason::Occluded,
        DetectionGapReason::AtmosphericAttenuation => DetectionReason::AtmosphericAttenuation,
        DetectionGapReason::BelowAngularResolution => DetectionReason::BelowAngularResolution,
        DetectionGapReason::LowLight => DetectionReason::LowLight,
        DetectionGapReason::Glare => DetectionReason::Glare,
    }
}

fn pair_matches(pair: &[String; 2], of: &str, to: &str) -> bool {
    (pair[0] == of && pair[1] == to) || (pair[0] == to && pair[1] == of)
}

/// The shared-presence sample series of one actor pair: centre distance, the
/// `a` actor's speed and the range rate (positive while closing). Ticks where
/// either actor is absent are skipped and reset the range-rate baseline.
struct TrackPair {
    t: Vec<f64>,
    distance: Vec<f64>,
    speed_of: Vec<f64>,
    closing: Vec<f64>,
}

fn pair_series(trace: &SimTrace, a: &str, b: &str) -> Option<TrackPair> {
    let ta = trace.ticks.actors.get(a)?;
    let tb = trace.ticks.actors.get(b)?;
    let n = trace.ticks.t.len();
    let mut series = TrackPair {
        t: Vec::with_capacity(n),
        distance: Vec::with_capacity(n),
        speed_of: Vec::with_capacity(n),
        closing: Vec::with_capacity(n),
    };
    let mut prev_d: Option<f64> = None;
    let mut prev_t = 0.0;
    for i in 0..n {
        if !ta.is_present(i) || !tb.is_present(i) {
            prev_d = None;
            continue;
        }
        let d = hypot(ta.x[i] - tb.x[i], ta.y[i] - tb.y[i]);
        let now = trace.ticks.t[i];
        series.t.push(now);
        series.distance.push(d);
        series.speed_of.push(ta.speed_mps[i]);
        series.closing.push(match prev_d {
            Some(pd) if now != prev_t => (pd - d) / (now - prev_t),
            _ => 0.0,
        });
        prev_d = Some(d);
        prev_t = now;
    }
    (!series.t.is_empty()).then_some(series)
}

/// Per-sensor summaries for one observer/target pair. Omitting `sensor`
/// selects the whole suite, which the callers reduce over — a suite detects
/// when its earliest sensor does. Empty when the pair is not in the channel.
fn perception_entries<'t>(
    trace: &'t SimTrace,
    observer: &'t str,
    target: &'t str,
    sensor: Option<&'t str>,
) -> impl Iterator<Item = &'t SensorPerceptionMetric> + Clone + 't {
    trace
        .metrics
        .perception
        .iter()
        .flat_map(|p| p.sensors.iter())
        .filter(move |e| {
            e.observer == observer && e.target == target && sensor.is_none_or(|s| e.sensor_id == s)
        })
}

/// Why a perception invariant could not be checked, in the author's terms.
fn perception_missing_reason(
    trace: &SimTrace,
    observer: &str,
    target: &str,
    sensor: Option<&str>,
) -> String {
    let Some(perception) = &trace.metrics.perception else {
        return "the trace carries no perception channel: no actor declared a sensor".to_owned();
    };
    let mut for_observer = perception
        .sensors
        .iter()
        .filter(|e| e.observer == observer)
        .peekable();
    if for_observer.peek().is_none() {
        return format!("{observer} declares no sensors");
    }
    if let Some(sensor) = sensor {
        if !for_observer.any(|e| e.sensor_id == sensor) {
            return format!("{observer} has no sensor \"{sensor}\"");
        }
    }
    format!("{observer} never observed {target}")
}

/// The authored window on the clip timeline, or the whole clip. An
/// expression that cannot be lowered is an error the caller must surface, not
/// a licence to widen the check to the whole clip.
fn window_of(inv: &Invariant, scope: &ExprScope, clip_seconds: f64) -> Result<(f64, f64), String> {
    let Some((lo, hi)) = &inv.base.window else {
        return Ok((0.0, clip_seconds));
    };
    let eval = |bound: &NumberOrExpr, which: &str| {
        bound
            .evaluate(scope)
            .map_err(|e| format!("the window {which} bound could not be evaluated: {e}"))
    };
    Ok((eval(lo, "lower")?, eval(hi, "upper")?))
}

/* --------------------------------------------------------------- checker */

fn unchecked(inv: &Invariant, reason: String) -> InvariantResidualReport {
    InvariantResidualReport {
        id: inv.base.id.clone(),
        kind: kind_name(&inv.kind),
        essentiality: inv.base.essentiality.as_str(),
        status: InvariantStatus::Unchecked,
        range: None,
        achieved: None,
        residual: 0.0,
        method: "none",
        reason,
    }
}

fn report(
    inv: &Invariant,
    range: Range,
    achieved: f64,
    method: &'static str,
    reason: String,
) -> InvariantResidualReport {
    let residual = outside(range, achieved);
    InvariantResidualReport {
        id: inv.base.id.clone(),
        kind: kind_name(&inv.kind),
        essentiality: inv.base.essentiality.as_str(),
        status: if residual == 0.0 {
            InvariantStatus::Held
        } else {
            InvariantStatus::Violated
        },
        range: Some(range),
        achieved: Some(round3(achieved)),
        residual: round3(residual),
        method,
        reason,
    }
}

/// Minimum of `distance / max(0.5, speed_of)` over the window: the time-gap
/// and headway families share this Euclidean approximation.
fn min_time_gap(series: &TrackPair, in_window: impl Fn(f64) -> bool) -> Option<(f64, f64)> {
    let mut best = f64::INFINITY;
    let mut best_t = 0.0;
    for i in 0..series.t.len() {
        if !in_window(series.t[i]) {
            continue;
        }
        let value = series.distance[i] / series.speed_of[i].max(0.5);
        if value < best {
            best = value;
            best_t = series.t[i];
        }
    }
    best.is_finite().then_some((best, best_t))
}

pub fn check_invariants(ctx: &InvariantContext<'_>) -> Vec<InvariantResidualReport> {
    let InvariantContext {
        template,
        trace,
        scope,
        arrival,
        speed_limit_kph,
    } = *ctx;
    let clip = trace.header.clip_seconds;
    let metrics = &trace.metrics;
    let mut out = Vec::with_capacity(template.invariants.len());

    for inv in &template.invariants {
        let (lo, hi) = match window_of(inv, scope, clip) {
            Ok(window) => window,
            Err(reason) => {
                out.push(unchecked(inv, reason));
                continue;
            }
        };
        let in_window = |t: f64| t >= lo && t <= hi;

        match &inv.kind {
            InvariantKind::Ttc { of, to, range, .. } => {
                let pair = [of.clone(), to.clone()];
                let min = criticality_metrics_in_window(metrics, (lo, hi), Some(&pair)).min_ttc;
                let Some(min) = min.filter(|m| pair_matches(&m.pair, of, to)) else {
                    out.push(unchecked(inv, format!("no TTC was recorded for {of}/{to}")));
                    continue;
                };
                out.push(report(
                    inv,
                    *range,
                    min.value,
                    "metrics.minTTC",
                    format!(
                        "min TTC {} s at t={} s, wanted {}",
                        to_fixed(min.value, 2),
                        to_fixed(min.t, 2),
                        fmt_range(*range)
                    ),
                ));
            }
            InvariantKind::PathTtc { of, to, range } => {
                let pair = [of.clone(), to.clone()];
                let min =
                    criticality_metrics_in_window(metrics, (lo, hi), Some(&pair)).min_path_ttc;
                let Some(min) = min.filter(|m| pair_matches(&m.pair, of, to)) else {
                    out.push(unchecked(
                        inv,
                        format!("no path TTC was recorded for {of}/{to}"),
                    ));
                    continue;
                };
                out.push(report(
                    inv,
                    *range,
                    min.value,
                    "metrics.minPathTTC",
                    format!(
                        "min path TTC {} s at t={} s, wanted {}",
                        to_fixed(min.value, 2),
                        to_fixed(min.t, 2),
                        fmt_range(*range)
                    ),
                ));
            }
            InvariantKind::Pet { of, to, range } => {
                let pair = [of.clone(), to.clone()];
                let min = criticality_metrics_in_window(metrics, (lo, hi), Some(&pair)).min_pet;
                let Some(min) = min.filter(|m| pair_matches(&m.pair, of, to)) else {
                    out.push(unchecked(inv, format!("no PET was recorded for {of}/{to}")));
                    continue;
                };
                out.push(report(
                    inv,
                    *range,
                    min.value,
                    "metrics.minPET",
                    format!(
                        "min PET {} s at t={} s, wanted {}",
                        to_fixed(min.value, 2),
                        to_fixed(min.t, 2),
                        fmt_range(*range)
                    ),
                ));
            }
            InvariantKind::NearMiss {
                pedestrian,
                target,
                clearance_range_m,
            } => {
                let verification = verify_near_miss_outcome(
                    trace,
                    NearMissOptions {
                        pedestrian_id: pedestrian,
                        target_id: target,
                        requested_clearance_m: 0.0,
                        tolerance_m: Some(MAX_SAFE_INTEGER),
                    },
                );
                let Some(realized) = verification.realized_clearance_m else {
                    out.push(unchecked(inv, verification.reason));
                    continue;
                };
                let mut result = report(
                    inv,
                    *clearance_range_m,
                    realized,
                    "exact-sampled-obb-clearance",
                    format!(
                        "closest footprint clearance {} m at t={} s",
                        to_fixed(realized, 3),
                        verification
                            .closest_approach_time_s
                            .map_or_else(|| "?".to_owned(), |t| to_fixed(t, 2)),
                    ),
                );
                if verification.collision {
                    result.status = InvariantStatus::Violated;
                    if result.residual == 0.0 {
                        result.residual = -clearance_range_m.0.unwrap_or(0.001).max(0.001);
                    }
                    result.reason = "collision occurred; near-miss intent requires strictly positive contact-free clearance".to_owned();
                }
                out.push(result);
            }
            InvariantKind::Gap {
                of,
                to,
                unit: GapUnit::Distance,
                range,
            } => {
                if inv.base.window.is_some() {
                    if let Some(series) = pair_series(trace, of, to) {
                        let mut min_distance = f64::INFINITY;
                        let mut min_t = 0.0;
                        for i in 0..series.t.len() {
                            let t = series.t[i];
                            if !in_window(t) {
                                continue;
                            }
                            let distance = series.distance[i];
                            if distance < min_distance {
                                min_distance = distance;
                                min_t = t;
                            }
                        }
                        if !min_distance.is_finite() {
                            out.push(unchecked(inv, "no tick fell inside the window".to_owned()));
                            continue;
                        }
                        out.push(report(
                            inv,
                            *range,
                            min_distance,
                            "pair-series-distance",
                            format!(
                                "closest approach {} m at t={} s within the required window",
                                to_fixed(min_distance, 2),
                                to_fixed(min_t, 2)
                            ),
                        ));
                        continue;
                    }
                }
                let Some(entry) = metrics
                    .min_distance
                    .iter()
                    .find(|d| pair_matches(&d.pair, of, to))
                else {
                    out.push(unchecked(inv, format!("no distance series for {of}/{to}")));
                    continue;
                };
                out.push(report(
                    inv,
                    *range,
                    entry.min_distance_m,
                    "metrics.minDistance",
                    format!(
                        "closest approach {} m at t={} s",
                        to_fixed(entry.min_distance_m, 2),
                        to_fixed(entry.t, 2)
                    ),
                ));
            }
            InvariantKind::Gap {
                of,
                to,
                unit: GapUnit::Time,
                range,
            } => {
                let Some(series) = pair_series(trace, of, to) else {
                    out.push(unchecked(inv, format!("no shared ticks for {of}/{to}")));
                    continue;
                };
                let Some((best, best_t)) = min_time_gap(&series, in_window) else {
                    out.push(unchecked(inv, "no tick fell inside the window".to_owned()));
                    continue;
                };
                out.push(report(
                    inv,
                    *range,
                    best,
                    "euclidean-gap/speed",
                    format!(
                        "min time gap {} s at t={} s",
                        to_fixed(best, 2),
                        to_fixed(best_t, 2)
                    ),
                ));
            }
            InvariantKind::Headway { of, to, range } => {
                let Some(series) = pair_series(trace, of, to) else {
                    out.push(unchecked(inv, format!("no shared ticks for {of}/{to}")));
                    continue;
                };
                let Some((best, best_t)) = min_time_gap(&series, in_window) else {
                    out.push(unchecked(inv, "no tick fell inside the window".to_owned()));
                    continue;
                };
                out.push(report(
                    inv,
                    *range,
                    best,
                    "euclidean-headway",
                    format!(
                        "min headway {} s at t={} s",
                        to_fixed(best, 2),
                        to_fixed(best_t, 2)
                    ),
                ));
            }
            InvariantKind::ClosingSpeed { of, to, range_kph } => {
                let Some(series) = pair_series(trace, of, to) else {
                    out.push(unchecked(inv, format!("no shared ticks for {of}/{to}")));
                    continue;
                };
                let mut peak = f64::NEG_INFINITY;
                let mut peak_t = 0.0;
                for i in 0..series.t.len() {
                    if !in_window(series.t[i]) {
                        continue;
                    }
                    if series.closing[i] > peak {
                        peak = series.closing[i];
                        peak_t = series.t[i];
                    }
                }
                if !peak.is_finite() {
                    out.push(unchecked(inv, "no tick fell inside the window".to_owned()));
                    continue;
                }
                let peak_kph = peak * 3.6;
                out.push(report(
                    inv,
                    *range_kph,
                    peak_kph,
                    "range-rate",
                    format!(
                        "peak closing speed {} kph at t={} s",
                        to_fixed(peak_kph, 1),
                        to_fixed(peak_t, 2)
                    ),
                ));
            }
            InvariantKind::SpeedRelLimit { of, range_frac } => {
                let (Some(track), Some(limit)) = (
                    trace.ticks.actors.get(of),
                    speed_limit_kph.filter(|l| *l > 0.0),
                ) else {
                    out.push(unchecked(
                        inv,
                        "no posted speed limit on the reference lane".to_owned(),
                    ));
                    continue;
                };
                let mut peak: f64 = 0.0;
                for i in 0..trace.ticks.t.len() {
                    if !track.is_present(i) || !in_window(trace.ticks.t[i]) {
                        continue;
                    }
                    peak = peak.max(track.speed_mps[i] * 3.6);
                }
                out.push(report(
                    inv,
                    *range_frac,
                    peak / limit,
                    "peak-speed/limit",
                    format!(
                        "peak {} kph against a {} kph limit",
                        to_fixed(peak, 1),
                        js_number_to_string(limit)
                    ),
                ));
            }
            InvariantKind::EventOrder {
                events,
                strict,
                min_separation_s,
            } => {
                let mut fired: BTreeMap<&str, f64> = BTreeMap::new();
                for event in &trace.events {
                    if let SimEvent::TriggerFired {
                        t, interaction_id, ..
                    } = event
                    {
                        fired.entry(interaction_id.as_str()).or_insert(*t);
                    }
                }
                let mut missing = events
                    .iter()
                    .filter(|id| !fired.contains_key(id.as_str()))
                    .peekable();
                if missing.peek().is_some() {
                    let missing = missing.map(String::as_str).collect::<Vec<_>>().join(", ");
                    out.push(unchecked(
                        inv,
                        format!("interaction(s) never fired: {missing}"),
                    ));
                    continue;
                }
                let min_sep = match min_separation_s {
                    None => 0.0,
                    Some(expr) => match expr.evaluate(scope) {
                        Ok(v) => v,
                        Err(e) => {
                            out.push(unchecked(
                                inv,
                                format!("minSeparationS could not be evaluated: {e}"),
                            ));
                            continue;
                        }
                    },
                };
                let need = if *strict { min_sep.max(1e-9) } else { min_sep };
                let mut worst: f64 = 0.0;
                let mut tightest = f64::INFINITY;
                let mut prev: Option<f64> = None;
                let mut fired_at = String::new();
                for id in events {
                    let t = fired[id.as_str()];
                    if let Some(p) = prev {
                        let delta = t - p;
                        tightest = tightest.min(delta);
                        if delta < need {
                            worst = worst.min(delta - need);
                        }
                        fired_at.push_str(" → ");
                    }
                    fired_at.push_str(&to_fixed(t, 2));
                    prev = Some(t);
                }
                out.push(InvariantResidualReport {
                    id: inv.base.id.clone(),
                    kind: kind_name(&inv.kind),
                    essentiality: inv.base.essentiality.as_str(),
                    status: if worst == 0.0 {
                        InvariantStatus::Held
                    } else {
                        InvariantStatus::Violated
                    },
                    range: None,
                    achieved: tightest.is_finite().then(|| round3(tightest)),
                    residual: round3(worst),
                    method: "trigger_fired",
                    reason: format!("fired at {fired_at} s"),
                });
            }
            InvariantKind::DecelBudget { of, max_mps2 } => {
                let Some(achieved) = metrics.required_decel_max.get(of).copied() else {
                    out.push(unchecked(inv, format!("{of} is not in the trace")));
                    continue;
                };
                let max = match max_mps2.evaluate(scope) {
                    Ok(v) => v,
                    Err(e) => {
                        out.push(unchecked(
                            inv,
                            format!("maxMps2 could not be evaluated: {e}"),
                        ));
                        continue;
                    }
                };
                out.push(report(
                    inv,
                    Range(None, Some(max)),
                    achieved,
                    "metrics.requiredDecelMax",
                    format!(
                        "peak required decel {} m/s² against a {} m/s² budget",
                        to_fixed(achieved, 2),
                        js_number_to_string(max)
                    ),
                ));
            }
            /* --------------------------------------------------- perception --
             * These read `metrics.perception`, the per-sensor channel's
             * episode summary. A missing summary is reported `unchecked` with
             * the reason rather than passing by default.
             */
            InvariantKind::DetectionGap {
                of,
                to,
                sensor,
                range,
                metric,
                reason,
            } => {
                let mut entries = perception_entries(trace, of, to, sensor.as_deref()).peekable();
                if entries.peek().is_none() {
                    out.push(unchecked(
                        inv,
                        perception_missing_reason(trace, of, to, sensor.as_deref()),
                    ));
                    continue;
                }
                let wanted = (*reason).map(detection_reason);
                let mut count = 0usize;
                let mut total = 0.0;
                let mut longest: f64 = 0.0;
                for gap in entries.flat_map(|e| e.gaps.iter()) {
                    if wanted.is_some_and(|r| gap.reason != r)
                        || !(in_window(gap.start_s) || in_window(gap.end_s))
                    {
                        continue;
                    }
                    count += 1;
                    total += gap.duration_s;
                    longest = longest.max(gap.duration_s);
                }
                let achieved = match metric {
                    GapMetric::Total => total,
                    GapMetric::Longest => longest,
                };
                let qualifier =
                    wanted.map_or_else(String::new, |r| format!(" caused by {}", r.as_str()));
                out.push(report(
                    inv,
                    *range,
                    achieved,
                    "metrics.perception.gaps",
                    format!(
                        "{} detection gap{qualifier} {} s over {count} dropout(s), wanted {}",
                        gap_metric_name(*metric),
                        to_fixed(achieved, 2),
                        fmt_range(*range)
                    ),
                ));
            }
            InvariantKind::TimeToFirstDetection {
                of,
                to,
                sensor,
                range,
            } => {
                let mut entries = perception_entries(trace, of, to, sensor.as_deref()).peekable();
                if entries.peek().is_none() {
                    out.push(unchecked(
                        inv,
                        perception_missing_reason(trace, of, to, sensor.as_deref()),
                    ));
                    continue;
                }
                // A suite detects when its *earliest* sensor does.
                let Some(achieved) = entries
                    .filter_map(|e| e.time_to_first_detection_s)
                    .reduce(f64::min)
                else {
                    out.push(unchecked(inv, format!("{of} never detected {to} at all")));
                    continue;
                };
                out.push(report(
                    inv,
                    *range,
                    achieved,
                    "metrics.perception.timeToFirstDetectionS",
                    format!(
                        "{of} first detected {to} at t={} s, wanted {}",
                        to_fixed(achieved, 2),
                        fmt_range(*range)
                    ),
                ));
            }
            InvariantKind::PerceptionLag {
                of,
                to,
                sensor,
                range,
            } => {
                let mut entries = perception_entries(trace, of, to, sensor.as_deref()).peekable();
                if entries.peek().is_none() {
                    out.push(unchecked(
                        inv,
                        perception_missing_reason(trace, of, to, sensor.as_deref()),
                    ));
                    continue;
                }
                let Some(achieved) = entries
                    .clone()
                    .filter_map(|e| e.perception_lag_s)
                    .reduce(f64::min)
                else {
                    let saw_los = entries.any(|e| e.first_line_of_sight_t.is_some());
                    out.push(unchecked(
                        inv,
                        if saw_los {
                            format!("{of} had line of sight to {to} but never detected it, so the lag is unbounded")
                        } else {
                            format!("{of} never had line of sight to {to}, so there is no lag to measure")
                        },
                    ));
                    continue;
                };
                out.push(report(
                    inv,
                    *range,
                    achieved,
                    "metrics.perception.perceptionLagS",
                    format!(
                        "line of sight opened {} s before {of} reported {to}, wanted {}",
                        to_fixed(achieved, 2),
                        fmt_range(*range)
                    ),
                ));
            }
            InvariantKind::MapDivergence {
                of,
                divergence,
                range,
            } => {
                let mut entries = metrics
                    .perception
                    .iter()
                    .flat_map(|p| p.map_divergence.iter())
                    .filter(|e| {
                        e.observer == *of
                            && (e.id == *divergence
                                || e.id
                                    .strip_prefix(divergence.as_str())
                                    .is_some_and(|rest| rest.starts_with(':')))
                    })
                    .peekable();
                let Some(first) = entries.peek() else {
                    out.push(unchecked(
                        inv,
                        if metrics.perception.is_none() {
                            "the trace carries no perception channel".to_owned()
                        } else {
                            format!("divergence \"{divergence}\" was not materialized for observer {of}")
                        },
                    ));
                    continue;
                };
                let kind = first.kind.as_str();
                // Segmented extents are one divergence to the author; sum the exposure.
                let achieved: f64 = entries.map(|e| e.active_s).sum();
                out.push(report(
                    inv,
                    *range,
                    achieved,
                    "metrics.perception.mapDivergence",
                    format!(
                        "{of} spent {} s inside \"{divergence}\" ({kind}), wanted {}",
                        to_fixed(achieved, 2),
                        fmt_range(*range)
                    ),
                ));
            }
            InvariantKind::Arrival {
                of,
                sync_with,
                delta_t_range,
                ..
            } => {
                let Some(solution) = arrival
                    .iter()
                    .find(|s| s.actor_id == *of && s.reference_actor_id == *sync_with)
                else {
                    out.push(unchecked(
                        inv,
                        format!("no arrival solve for {of} against {sync_with}"),
                    ));
                    continue;
                };
                out.push(report(
                    inv,
                    *delta_t_range,
                    solution.achieved_delta_t,
                    "arrival-solver",
                    format!(
                        "achieved Δt {} s (requested {} s)",
                        to_fixed(solution.achieved_delta_t, 3),
                        to_fixed(solution.target_delta_t, 3)
                    ),
                ));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_fixed_matches_ecmascript_ties_and_signs() {
        assert_eq!(to_fixed(0.125, 2), "0.13");
        assert_eq!(to_fixed(-0.125, 2), "-0.13");
        assert_eq!(to_fixed(2.5, 0), "3");
        assert_eq!(to_fixed(1.005, 2), "1.00");
        assert_eq!(to_fixed(9.995, 2), "9.99");
        assert_eq!(to_fixed(9.9951, 2), "10.00");
        assert_eq!(to_fixed(-0.001, 2), "-0.00");
        assert_eq!(to_fixed(0.0, 3), "0.000");
        assert_eq!(to_fixed(-0.0, 2), "0.00");
        assert_eq!(to_fixed(123.456, 1), "123.5");
    }

    #[test]
    fn round3_normalises_negative_zero_and_js_ties() {
        assert!(round3(-0.0001).is_sign_positive());
        assert_eq!(round3(-0.0005), 0.0);
        assert_eq!(round3(0.0005), 0.001);
        assert_eq!(round3(1.23456), 1.235);
    }

    #[test]
    fn outside_is_signed_toward_the_missed_bound() {
        let r = Range(Some(1.0), Some(2.0));
        assert_eq!(outside(r, 0.5), -0.5);
        assert_eq!(outside(r, 2.5), 0.5);
        assert_eq!(outside(r, 1.5), 0.0);
        assert_eq!(outside(Range(None, Some(2.0)), -10.0), 0.0);
        assert_eq!(fmt_range(Range(None, Some(2.0))), "[−∞, 2]");
        assert_eq!(fmt_range(Range(Some(0.5), None)), "[0.5, ∞]");
    }
}
