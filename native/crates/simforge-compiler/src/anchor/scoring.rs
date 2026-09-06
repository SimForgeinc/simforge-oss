//! Clause scoring: linear falloff over a tolerance band for ranges, a
//! near-miss table for sets, pass/fail for booleans.

use super::MRange;
use crate::template::JunctionControl;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToleranceKind {
    DistanceM,
    SpeedKph,
    WidthM,
    CurvatureDegPer10m,
    CountLanes,
    GradePct,
}

/// Tolerance band width. `DistanceM` uses "25 % of the range width, min 10 m".
pub fn tolerance_for(kind: ToleranceKind, range: MRange) -> f64 {
    match kind {
        ToleranceKind::DistanceM => (0.25 * (range.1 - range.0).abs()).max(10.0),
        ToleranceKind::SpeedKph => 10.0,
        ToleranceKind::WidthM => 0.4,
        ToleranceKind::CurvatureDegPer10m => 2.0,
        ToleranceKind::CountLanes => 1.0,
        ToleranceKind::GradePct => 2.0,
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RangeScore {
    pub score: f64,
    pub slack: f64,
    pub tolerance: f64,
}

/// Linear falloff outside `[min, max]` over a tolerance band. Never negative.
pub fn score_range(value: f64, range: MRange, kind: ToleranceKind) -> RangeScore {
    let tolerance = tolerance_for(kind, range);
    let (lo, hi) = range;
    if value >= lo && value <= hi {
        return RangeScore {
            score: 1.0,
            slack: 0.0,
            tolerance,
        };
    }
    let slack = if value < lo { lo - value } else { value - hi };
    if tolerance <= 0.0 {
        return RangeScore {
            score: 0.0,
            slack,
            tolerance,
        };
    }
    RangeScore {
        score: (1.0 - slack / tolerance).max(0.0),
        slack,
        tolerance,
    }
}

/// Near-miss similarity of two junction controls, 1 when identical.
pub fn near_miss_score(a: JunctionControl, b: JunctionControl) -> f64 {
    use JunctionControl as C;
    if a == b {
        return 1.0;
    }
    let (x, y) = if a < b { (a, b) } else { (b, a) };
    match (x, y) {
        (C::Signalized, C::AllWayStop) => 0.6,
        (C::MinorStop, C::Yield) => 0.85,
        (C::AllWayStop, C::MinorStop) => 0.5,
        (C::Yield, C::Uncontrolled) => 0.5,
        (C::AllWayStop, C::Roundabout) => 0.3,
        _ => 0.0,
    }
}

/// Arm-count near miss: `|Δ| == 1` → 0.4, otherwise 0.
pub fn arm_count_near_miss(actual: usize, wanted: usize) -> f64 {
    match actual.abs_diff(wanted) {
        0 => 1.0,
        1 => 0.4,
        _ => 0.0,
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct SetScore {
    pub score: f64,
    pub closest: Option<JunctionControl>,
    pub slack: f64,
}

/// Best near-miss score of `actual` against any member of `allowed`.
pub fn score_set(actual: JunctionControl, allowed: &[JunctionControl]) -> SetScore {
    let mut sorted: Vec<JunctionControl> = allowed.to_vec();
    sorted.sort();
    let mut best = 0.0;
    let mut closest = None;
    for want in &sorted {
        let s = near_miss_score(actual, *want);
        if s > best {
            best = s;
            closest = Some(*want);
        }
    }
    if closest.is_none() {
        closest = sorted.first().copied();
    }
    SetScore {
        score: best,
        closest,
        slack: if best >= 1.0 { 0.0 } else { 1.0 - best },
    }
}

pub fn score_bool(actual: bool, wanted: bool) -> (f64, f64) {
    if actual == wanted {
        (1.0, 0.0)
    } else {
        (0.0, 1.0)
    }
}

pub const REQUIRED_PASS_EPSILON: f64 = 1e-9;

pub fn passes_required(score: f64) -> bool {
    score >= 1.0 - REQUIRED_PASS_EPSILON
}
