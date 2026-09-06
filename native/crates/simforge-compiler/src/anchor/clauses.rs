//! Clause evaluation.
//!
//! 1. **Worst value over the s-interval, not mean.** A corridor that is 3
//!    lanes for 90 m and 1 lane for 10 m is not a 3-lane corridor.
//! 2. **Every clause emits a [`ClauseResult`]** with required/actual/score/
//!    slack, so every consumer can explain the match without re-deriving.
//!
//! A clause the derived index cannot answer is `supported: false`. If it was
//! `required`, that is a *failure*, not a free pass.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{json, Value};
use simforge_core::math::hypot;

use super::scoring::{
    arm_count_near_miss, passes_required, score_bool, score_range, score_set, ToleranceKind,
};
use super::{
    flip_relation, round2, AnchorFrame, ClauseResult, FeatureMatch, MAnchor, MClause, MFeature,
    MFeatureKind, MRange, OriginKind,
};
use crate::geometry::{
    adjacent_kinds, curvature_deg_per_10m_at, point_at_s, project_point, CrossSection,
};
use crate::map_index::{DerivedMapIndex, Fact, JunctionDescriptor, PointFeature, PointFeatureKind};
use crate::template::{
    CrossingPlacement, Essentiality, JunctionControl, ParkingOrientation, Side, TurnDirection,
};

/// Sampling stride for worst-over-interval evaluation.
pub const SAMPLE_STRIDE_M: f64 = 10.0;
/// Corridor extent used when the anchor states no runway requirement.
pub const DEFAULT_CORRIDOR_M: f64 = 100.0;
/// Geometry-only fallback for points whose source lane is unavailable.
const POINT_FEATURE_GEOMETRIC_FALLBACK_M: f64 = 6.0;

#[derive(Debug, Clone)]
pub struct CorridorSample {
    pub s: f64,
    pub lane_rsl: String,
    pub s_in_lane: f64,
    pub is_junction: bool,
    pub cs: CrossSection,
    pub curvature_deg_per10m: f64,
}

/// Sample the corridor. Junction-internal spans are skipped: lane counts and
/// widths inside a junction describe the junction, not the road.
pub fn sample_corridor(
    index: &DerivedMapIndex,
    frame: &AnchorFrame,
    s_from: f64,
    s_to: f64,
    stride: f64,
) -> Vec<CorridorSample> {
    let mut out = Vec::new();
    let lo = s_from.max(frame.s_range.0);
    let hi = s_to.min(frame.s_range.1);
    let mut s = lo;
    while s <= hi + 1e-9 {
        if let Some((span, s_in_lane)) = frame.lane_at_s(s) {
            if let Some(lane) = index.lane(&span.lane_rsl) {
                if !lane.is_junction {
                    if let Some(cs) = index.cross_section(&span.lane_rsl, s_in_lane) {
                        out.push(CorridorSample {
                            s,
                            lane_rsl: span.lane_rsl.clone(),
                            s_in_lane,
                            is_junction: span.is_junction,
                            cs,
                            curvature_deg_per10m: curvature_deg_per_10m_at(
                                &lane.polyline,
                                s_in_lane,
                                10.0,
                            ),
                        });
                    }
                }
            }
        }
        s += stride;
    }
    out
}

fn unsupported<T: serde::Serialize>(
    path: &str,
    c: &MClause<T>,
    reason: impl Into<String>,
) -> ClauseResult {
    let required = c.essentiality == Essentiality::Required;
    ClauseResult {
        path: path.to_owned(),
        essentiality: c.essentiality,
        required: serde_json::to_value(&c.value).unwrap_or(Value::Null),
        actual: Value::Null,
        score: if required { 0.0 } else { 1.0 },
        slack: if required { 1.0 } else { 0.0 },
        weight: if required { c.weight() } else { 0.0 },
        supported: false,
        worst_at_s: None,
        reason: reason.into(),
    }
}

fn result<T: serde::Serialize>(
    path: &str,
    c: &MClause<T>,
    actual: Value,
    score: f64,
    slack: f64,
    worst_at_s: Option<f64>,
    reason: String,
) -> ClauseResult {
    ClauseResult {
        path: path.to_owned(),
        essentiality: c.essentiality,
        required: serde_json::to_value(&c.value).unwrap_or(Value::Null),
        actual,
        score,
        slack,
        weight: c.weight(),
        supported: true,
        worst_at_s,
        reason,
    }
}

fn fact<'a>(feature: &'a PointFeature, keys: &[&str]) -> Option<&'a Fact> {
    keys.iter().find_map(|k| feature.facts.get(*k))
}

fn range_text(r: MRange) -> String {
    format!("[{}, {}]", r.0, r.1)
}

fn evaluate_parking_predicates(
    feature: &MFeature,
    candidate: &PointFeature,
    path: &str,
) -> Vec<ClauseResult> {
    let Some(p) = &feature.parking else {
        return Vec::new();
    };
    let mut out = Vec::new();
    if let Some(c) = &p.orientation {
        let raw = fact(candidate, &["parking_orientation", "orientation"])
            .and_then(Fact::as_str)
            .and_then(|s| match s {
                "parallel" => Some(ParkingOrientation::Parallel),
                "angled" => Some(ParkingOrientation::Angled),
                "perpendicular" => Some(ParkingOrientation::Perpendicular),
                _ => None,
            });
        let actual = raw.or_else(|| {
            fact(candidate, &["is_parallel_parking"])
                .and_then(Fact::as_bool)
                .map(|b| {
                    if b {
                        ParkingOrientation::Parallel
                    } else {
                        ParkingOrientation::Angled
                    }
                })
        });
        let p_path = format!("{path}.orientation");
        match actual {
            None => out.push(unsupported(
                &p_path,
                c,
                format!("{} carries no parking-orientation evidence", candidate.id),
            )),
            Some(actual) => {
                let matches = actual == c.value;
                out.push(result(
                    &p_path,
                    c,
                    json!(actual.as_str()),
                    if matches { 1.0 } else { 0.0 },
                    if matches { 0.0 } else { 1.0 },
                    None,
                    format!("{} is {} parking", candidate.id, actual.as_str()),
                ));
            }
        }
    }
    if let Some(c) = &p.capacity {
        let p_path = format!("{path}.capacity");
        match fact(candidate, &["space_count", "capacity", "stall_count"])
            .and_then(Fact::as_f64)
            .filter(|v| v.is_finite())
        {
            None => out.push(unsupported(
                &p_path,
                c,
                format!("{} carries no counted parking capacity", candidate.id),
            )),
            Some(raw) => {
                let scored = score_range(raw, c.value, ToleranceKind::CountLanes);
                out.push(result(
                    &p_path,
                    c,
                    json!(raw),
                    scored.score,
                    scored.slack,
                    None,
                    format!("{} holds {raw} space(s)", candidate.id),
                ));
            }
        }
    }
    if let Some(c) = &p.length_m {
        let p_path = format!("{path}.lengthM");
        match fact(
            candidate,
            &[
                "parking_length_m",
                "length_m",
                "parking_extent_length_m",
                "stall_length_m",
            ],
        )
        .and_then(Fact::as_f64)
        .filter(|v| v.is_finite())
        {
            None => out.push(unsupported(
                &p_path,
                c,
                format!("{} carries no measured parking-zone length", candidate.id),
            )),
            Some(raw) => {
                let scored = score_range(raw, c.value, ToleranceKind::DistanceM);
                out.push(result(
                    &p_path,
                    c,
                    json!(round2(raw)),
                    scored.score,
                    scored.slack,
                    None,
                    format!("{} spans {} m of kerb", candidate.id, round2(raw)),
                ));
            }
        }
    }
    if let Some(c) = &p.occupancy {
        out.push(unsupported(&format!("{path}.occupancy"), c, "no map-intel fact reports parking occupancy; set it as a scenario parameter, not an anchor clause"));
    }
    out
}

fn evaluate_supports_scenario(
    feature: &MFeature,
    candidate: &PointFeature,
    path: &str,
) -> Vec<ClauseResult> {
    let Some(c) = &feature.supports_scenario else {
        return Vec::new();
    };
    let p_path = format!("{path}.supportsScenario");
    let listed: Option<Vec<String>> = match fact(
        candidate,
        &["supported_scenario_templates", "supportedScenarioTemplates"],
    ) {
        Some(Fact::Text(s)) => Some(vec![s.clone()]),
        Some(Fact::Texts(v)) => Some(v.clone()),
        _ => None,
    };
    let Some(listed) = listed.filter(|l| !l.is_empty()) else {
        return vec![unsupported(
            &p_path,
            c,
            format!(
                "{} publishes no supported_scenario_templates whitelist",
                candidate.id
            ),
        )];
    };
    let hit = c.value.iter().find(|wanted| listed.contains(wanted));
    let reason = match hit {
        Some(h) => format!("{} was built for \"{h}\"", candidate.id),
        None => format!(
            "{} supports {}, none of {}",
            candidate.id,
            listed.join("|"),
            c.value.join("|")
        ),
    };
    vec![result(
        &p_path,
        c,
        json!(listed),
        if hit.is_some() { 1.0 } else { 0.0 },
        if hit.is_some() { 0.0 } else { 1.0 },
        None,
        reason,
    )]
}

fn evaluate_crossing_predicates(
    feature: &MFeature,
    candidate: &PointFeature,
    path: &str,
) -> Vec<ClauseResult> {
    let Some(cp) = &feature.crossing else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut boolean_clause =
        |clause: &Option<MClause<bool>>, key: &str, aliases: &[&str], label: &str| {
            let Some(clause) = clause else { return };
            let p_path = format!("{path}.{key}");
            match fact(candidate, aliases).and_then(Fact::as_bool) {
                None => out.push(unsupported(
                    &p_path,
                    clause,
                    format!("{} carries no map evidence for {label}", candidate.id),
                )),
                Some(raw) => {
                    let (score, slack) = score_bool(raw, clause.value);
                    out.push(result(
                        &p_path,
                        clause,
                        json!(raw),
                        score,
                        slack,
                        None,
                        format!(
                            "{} is {}{label}",
                            candidate.id,
                            if raw { "" } else { "not " }
                        ),
                    ));
                }
            }
        };
    boolean_clause(&cp.marked, "marked", &["is_marked", "marked"], "marked");
    boolean_clause(
        &cp.controlled,
        "controlled",
        &["is_signalized", "is_controlled", "controlled"],
        "signal-controlled",
    );
    if let Some(c) = &cp.length_m {
        let p_path = format!("{path}.lengthM");
        match fact(candidate, &["crossing_length_m", "length_m", "lengthM"])
            .and_then(Fact::as_f64)
            .filter(|v| v.is_finite())
        {
            None => out.push(unsupported(
                &p_path,
                c,
                format!("{} carries no measured crossing length", candidate.id),
            )),
            Some(raw) => {
                let scored = score_range(raw, c.value, ToleranceKind::DistanceM);
                out.push(result(
                    &p_path,
                    c,
                    json!(round2(raw)),
                    scored.score,
                    scored.slack,
                    None,
                    format!(
                        "{} crossing envelope is {} m long",
                        candidate.id,
                        round2(raw)
                    ),
                ));
            }
        }
    }
    if let Some(c) = &cp.placement {
        let p_path = format!("{path}.placement");
        let is_midblock = fact(candidate, &["is_midblock"]).and_then(Fact::as_bool);
        let is_near_junction = fact(candidate, &["is_near_junction"]).and_then(Fact::as_bool);
        let actual = match is_midblock {
            Some(true) => Some(CrossingPlacement::Midblock),
            Some(false) => Some(CrossingPlacement::JunctionLeg),
            None => {
                if candidate.junction_id.is_some() || is_near_junction == Some(true) {
                    Some(CrossingPlacement::JunctionLeg)
                } else if is_near_junction == Some(false) {
                    Some(CrossingPlacement::Midblock)
                } else {
                    None
                }
            }
        };
        match actual {
            None => out.push(unsupported(
                &p_path,
                c,
                format!(
                    "{} carries no junction-leg or midblock evidence",
                    candidate.id
                ),
            )),
            Some(actual) => {
                let matches = c.value == CrossingPlacement::Either || c.value == actual;
                let label = if actual == CrossingPlacement::JunctionLeg {
                    "junction-leg"
                } else {
                    "midblock"
                };
                let actual_text = if actual == CrossingPlacement::JunctionLeg {
                    "junction_leg"
                } else {
                    "midblock"
                };
                out.push(result(
                    &p_path,
                    c,
                    json!(actual_text),
                    if matches { 1.0 } else { 0.0 },
                    if matches { 0.0 } else { 1.0 },
                    None,
                    format!("{} is a {label} crossing", candidate.id),
                ));
            }
        }
    }
    out
}

struct Worst<T> {
    value: T,
    score: f64,
    slack: f64,
    at_s: f64,
}

fn worst_over_samples<T>(
    samples: &[CorridorSample],
    mut evaluate: impl FnMut(&CorridorSample) -> (T, f64, f64),
) -> Option<Worst<T>> {
    let mut best: Option<Worst<T>> = None;
    for sample in samples {
        let (value, score, slack) = evaluate(sample);
        if best.as_ref().is_none_or(|b| score < b.score) {
            best = Some(Worst {
                value,
                score,
                slack,
                at_s: sample.s,
            });
        }
    }
    best
}

fn range_clause(
    results: &mut Vec<ClauseResult>,
    path: &str,
    c: Option<&MClause<MRange>>,
    samples: &[CorridorSample],
    kind: ToleranceKind,
    read: impl Fn(&CorridorSample) -> f64,
) {
    let Some(c) = c else { return };
    if samples.is_empty() {
        results.push(unsupported(
            path,
            c,
            "no drivable corridor samples available",
        ));
        return;
    }
    let Some(worst) = worst_over_samples(samples, |sample| {
        let value = read(sample);
        let scored = score_range(value, c.value, kind);
        (value, scored.score, scored.slack)
    }) else {
        return;
    };
    let reason = if worst.score >= 1.0 {
        format!(
            "{path} holds over the whole interval (worst {})",
            round2(worst.value)
        )
    } else {
        format!(
            "{path} worst value {} at s={} m, wanted {}",
            round2(worst.value),
            round2(worst.at_s),
            range_text(c.value)
        )
    };
    results.push(result(
        path,
        c,
        json!(worst.value),
        worst.score,
        worst.slack,
        Some(worst.at_s),
        reason,
    ));
}

fn adjacent_reference_lane<'a>(
    index: &'a DerivedMapIndex,
    frame: &'a AnchorFrame,
    lane_rsl: &str,
) -> Option<&'a str> {
    if frame.s_of_lane.contains_key(lane_rsl) {
        return frame
            .s_of_lane
            .get_key_value(lane_rsl)
            .map(|(k, _)| k.as_str());
    }
    let lane = index.lane(lane_rsl);
    for r in frame.s_of_lane.keys() {
        let Some(ref_lane) = index.lane(r) else {
            continue;
        };
        if ref_lane.adjacent_left.lane_rsl.as_deref() == Some(lane_rsl)
            || ref_lane.adjacent_right.lane_rsl.as_deref() == Some(lane_rsl)
        {
            return Some(r.as_str());
        }
        if let Some(l) = lane {
            if l.adjacent_left.lane_rsl.as_deref() == Some(r.as_str())
                || l.adjacent_right.lane_rsl.as_deref() == Some(r.as_str())
            {
                return Some(r.as_str());
            }
        }
    }
    None
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LocateSource {
    PointSameRoad,
    PointNearby,
    LaneAdjacent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FeatureSide {
    Left,
    Right,
    Both,
}

impl FeatureSide {
    fn as_str(self) -> &'static str {
        match self {
            Self::Left => "left",
            Self::Right => "right",
            Self::Both => "both",
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct Located {
    s: f64,
    adjacent: bool,
    source: LocateSource,
    distance_m: f64,
    side: FeatureSide,
}

fn point_feature_world_point(
    index: &DerivedMapIndex,
    feature: &PointFeature,
) -> Option<crate::geometry::Point2> {
    if let Some(p) = feature.point {
        return Some(p);
    }
    let lane = index.lane(&feature.lane_rsl)?;
    if lane.polyline.len() < 2 {
        return None;
    }
    Some(point_at_s(&lane.polyline, feature.s))
}

fn point_feature_s(
    index: &DerivedMapIndex,
    frame: &AnchorFrame,
    feature: &PointFeature,
) -> Option<Located> {
    if let Some(point) = point_feature_world_point(index, feature) {
        let source_lane = index.lane(&feature.lane_rsl);
        let mut best_semantic: Option<Located> = None;
        let mut best_nearby: Option<Located> = None;
        for span in &frame.reference_path {
            let Some(lane) = index.lane(&span.lane_rsl) else {
                continue;
            };
            if lane.polyline.len() < 2 {
                continue;
            }
            let projected = project_point(&lane.polyline, point);
            let frame_s = frame
                .s_of_lane
                .get(&span.lane_rsl)
                .copied()
                .unwrap_or(span.s_start);
            let semantic = source_lane
                .is_some_and(|sl| lane.road_id == sl.road_id && lane.section == sl.section);
            let candidate = Located {
                s: frame_s + projected.s,
                adjacent: span.lane_rsl != feature.lane_rsl,
                source: if semantic {
                    LocateSource::PointSameRoad
                } else {
                    LocateSource::PointNearby
                },
                distance_m: projected.distance,
                side: if projected.distance < 0.25 {
                    FeatureSide::Both
                } else if projected.side > 0 {
                    FeatureSide::Left
                } else {
                    FeatureSide::Right
                },
            };
            let slot = if semantic {
                &mut best_semantic
            } else {
                &mut best_nearby
            };
            let better = match slot {
                None => true,
                Some(b) => {
                    candidate.distance_m < b.distance_m
                        || (candidate.distance_m == b.distance_m && candidate.s < b.s)
                }
            };
            if better {
                *slot = Some(candidate);
            }
        }
        if let Some(b) = best_semantic {
            return Some(b);
        }
        if let Some(b) = best_nearby {
            if b.distance_m <= POINT_FEATURE_GEOMETRIC_FALLBACK_M {
                return Some(b);
            }
        }
        return None;
    }
    let r = adjacent_reference_lane(index, frame, &feature.lane_rsl)?;
    let side = match feature.side.as_deref() {
        Some("left") => FeatureSide::Left,
        Some("right") => FeatureSide::Right,
        _ => FeatureSide::Both,
    };
    Some(Located {
        s: frame.s_of_lane[r] + feature.s,
        adjacent: r != feature.lane_rsl,
        source: LocateSource::LaneAdjacent,
        distance_m: 0.0,
        side,
    })
}

fn feature_side_matches(actual: FeatureSide, wanted: Side) -> bool {
    match wanted {
        Side::Either => matches!(actual, FeatureSide::Left | FeatureSide::Right),
        Side::Both => actual == FeatureSide::Both,
        Side::Left => matches!(actual, FeatureSide::Left | FeatureSide::Both),
        Side::Right => matches!(actual, FeatureSide::Right | FeatureSide::Both),
    }
}

fn evaluate_corridor(
    results: &mut Vec<ClauseResult>,
    anchor: &MAnchor,
    index: &DerivedMapIndex,
    frame: &AnchorFrame,
    samples: &[CorridorSample],
) {
    let Some(corridor) = &anchor.corridor else {
        return;
    };
    range_clause(
        results,
        "corridor.throughLanesSameDir",
        corridor.through_lanes_same_dir.as_ref(),
        samples,
        ToleranceKind::CountLanes,
        |s| s.cs.same_dir_driving.len() as f64,
    );
    range_clause(
        results,
        "corridor.throughLanesOpposing",
        corridor.through_lanes_opposing.as_ref(),
        samples,
        ToleranceKind::CountLanes,
        |s| s.cs.opposing_driving.len() as f64,
    );
    range_clause(
        results,
        "corridor.laneWidthM",
        corridor.lane_width_m.as_ref(),
        samples,
        ToleranceKind::WidthM,
        |s| s.cs.lane_width_m,
    );
    range_clause(
        results,
        "corridor.speedLimitKph",
        corridor.speed_limit_kph.as_ref(),
        samples,
        ToleranceKind::SpeedKph,
        |s| s.cs.speed_limit_kph,
    );
    range_clause(
        results,
        "corridor.curvatureDegPer10m",
        corridor.curvature_deg_per10m.as_ref(),
        samples,
        ToleranceKind::CurvatureDegPer10m,
        |s| s.curvature_deg_per10m,
    );
    if let Some(c) = &corridor.grade_pct {
        let reason = if index.capabilities.grade {
            "grade capability declared but not implemented by this index"
        } else {
            "lane polylines are 2-D: grade is not derivable from this map index"
        };
        results.push(unsupported("corridor.gradePct", c, reason));
    }
    for (path, clause, available) in [
        (
            "corridor.runwayUpstreamM",
            corridor.runway_upstream_m.as_ref(),
            frame.runway_upstream_m,
        ),
        (
            "corridor.runwayDownstreamM",
            corridor.runway_downstream_m.as_ref(),
            frame.runway_downstream_m,
        ),
    ] {
        let Some(clause) = clause else { continue };
        let wanted = clause.value;
        let tolerance = (0.25 * wanted).max(10.0);
        let slack = (wanted - available).max(0.0);
        let score = if slack == 0.0 {
            1.0
        } else {
            (1.0 - slack / tolerance).max(0.0)
        };
        let reason = if score >= 1.0 {
            format!(
                "{} m of runway available, {wanted} m needed",
                round2(available)
            )
        } else {
            format!(
                "only {} m of runway, {wanted} m needed (short by {} m)",
                round2(available),
                round2(slack)
            )
        };
        results.push(ClauseResult {
            path: path.to_owned(),
            essentiality: clause.essentiality,
            required: json!(wanted),
            actual: json!(round2(available)),
            score,
            slack,
            weight: clause.weight(),
            supported: true,
            worst_at_s: None,
            reason,
        });
    }
    if let Some(c) = &corridor.requires_adjacent {
        let wanted: Vec<&str> = c.value.iter().map(|k| k.as_str()).collect();
        if let Some(worst) = worst_over_samples(samples, |sample| {
            let kinds = adjacent_kinds(&sample.cs);
            let missing = wanted
                .iter()
                .filter(|w| !kinds.iter().any(|k| k == *w))
                .count();
            (kinds, if missing == 0 { 1.0 } else { 0.0 }, missing as f64)
        }) {
            let reason = if worst.score >= 1.0 {
                "every required adjacency present along the corridor".to_owned()
            } else {
                format!(
                    "missing adjacency at s={} m (found {})",
                    round2(worst.at_s),
                    if worst.value.is_empty() {
                        "none".to_owned()
                    } else {
                        worst.value.join(", ")
                    }
                )
            };
            results.push(ClauseResult {
                path: "corridor.requiresAdjacent".to_owned(),
                essentiality: c.essentiality,
                required: json!(wanted),
                actual: json!(worst.value),
                score: worst.score,
                slack: worst.slack,
                weight: c.weight(),
                supported: true,
                worst_at_s: Some(worst.at_s),
                reason,
            });
        }
    }
    if let Some(c) = &corridor.forbids_adjacent {
        let forbidden: Vec<&str> = c.value.iter().map(|k| k.as_str()).collect();
        if let Some(worst) = worst_over_samples(samples, |sample| {
            let kinds = adjacent_kinds(&sample.cs);
            let hits: Vec<String> = forbidden
                .iter()
                .filter(|f| kinds.iter().any(|k| k == *f))
                .map(|f| (*f).to_owned())
                .collect();
            let n = hits.len();
            (hits, if n == 0 { 1.0 } else { 0.0 }, n as f64)
        }) {
            let reason = if worst.score >= 1.0 {
                "no forbidden adjacency along the corridor".to_owned()
            } else {
                format!(
                    "forbidden adjacency {} at s={} m",
                    worst.value.join(", "),
                    round2(worst.at_s)
                )
            };
            results.push(ClauseResult {
                path: "corridor.forbidsAdjacent".to_owned(),
                essentiality: c.essentiality,
                required: json!(format!("none of {}", forbidden.join(", "))),
                actual: json!(worst.value),
                score: worst.score,
                slack: worst.slack,
                weight: c.weight(),
                supported: true,
                worst_at_s: Some(worst.at_s),
                reason,
            });
        }
    }
    if let Some(c) = &corridor.lane_change_legal {
        let side = c.value.side;
        let (lo, hi) = c.value.s_range;
        let relevant: Vec<CorridorSample> = samples
            .iter()
            .filter(|s| s.s >= lo && s.s <= hi)
            .cloned()
            .collect();
        if relevant.is_empty() {
            results.push(unsupported(
                "corridor.laneChangeLegal",
                c,
                format!("no corridor samples inside s∈[{lo}, {hi}]"),
            ));
        } else if let Some(worst) = worst_over_samples(&relevant, |sample| {
            let perms = index
                .lane(&sample.lane_rsl)
                .map(|l| l.lane_change_permissions.as_slice())
                .unwrap_or(&[]);
            let wanted: Vec<crate::map_index::LaneSideName> = match side {
                Side::Either | Side::Both => vec![
                    crate::map_index::LaneSideName::Left,
                    crate::map_index::LaneSideName::Right,
                ],
                Side::Left => vec![crate::map_index::LaneSideName::Left],
                Side::Right => vec![crate::map_index::LaneSideName::Right],
            };
            let covering: Vec<_> = perms
                .iter()
                .filter(|p| {
                    wanted.contains(&p.side)
                        && sample.s_in_lane >= p.start_s
                        && sample.s_in_lane <= p.end_s
                })
                .collect();
            if covering.is_empty() {
                let has_neighbour = sample.cs.same_dir_driving.len() > 1;
                return (
                    if has_neighbour {
                        "no marking data"
                    } else {
                        "no adjacent lane"
                    },
                    if has_neighbour { 0.5 } else { 0.0 },
                    1.0,
                );
            }
            let allowed = if side == Side::Both {
                wanted
                    .iter()
                    .all(|w| covering.iter().any(|p| p.side == *w && p.allowed))
            } else {
                covering.iter().any(|p| p.allowed)
            };
            (
                if allowed { "allowed" } else { "forbidden" },
                if allowed { 1.0 } else { 0.0 },
                if allowed { 0.0 } else { 1.0 },
            )
        }) {
            results.push(ClauseResult {
                path: "corridor.laneChangeLegal".to_owned(),
                essentiality: c.essentiality,
                required: json!(format!(
                    "{} lane change legal over s∈[{lo}, {hi}]",
                    side.as_str()
                )),
                actual: json!(worst.value),
                score: worst.score,
                slack: worst.slack,
                weight: c.weight(),
                supported: true,
                worst_at_s: Some(worst.at_s),
                reason: format!(
                    "lane-change legality worst case \"{}\" at s={} m",
                    worst.value,
                    round2(worst.at_s)
                ),
            });
        }
    }
}

/// Where the reference path enters each junction, in frame `s`.
pub fn junctions_along_path(index: &DerivedMapIndex, frame: &AnchorFrame) -> Vec<(String, f64)> {
    let mut out = Vec::new();
    let mut previous: Option<&str> = None;
    for span in &frame.reference_path {
        let junction_id = index
            .lane(&span.lane_rsl)
            .and_then(|l| l.junction_id.as_deref());
        if let Some(j) = junction_id {
            if previous != Some(j) {
                out.push((j.to_owned(), span.s_start));
            }
        }
        previous = junction_id;
    }
    out
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransitionKind {
    Merge,
    LaneDrop,
}

impl TransitionKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Merge => "merge",
            Self::LaneDrop => "lane_drop",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct LaneTransition {
    pub kind: TransitionKind,
    pub s: f64,
    pub from: usize,
    pub to: usize,
    pub lane_rsl: Option<String>,
}

fn reaches(index: &DerivedMapIndex, start: &str, targets: &BTreeSet<&str>) -> bool {
    if targets.contains(start) {
        return true;
    }
    let mut open: Vec<String> = vec![start.to_owned()];
    let mut seen: BTreeSet<String> = BTreeSet::from([start.to_owned()]);
    for _depth in 0..4 {
        if open.is_empty() {
            break;
        }
        let mut next: Vec<String> = Vec::new();
        for rsl in &open {
            let Some(lane) = index.lane(rsl) else {
                continue;
            };
            for successor in &lane.successors {
                if targets.contains(successor.as_str()) {
                    return true;
                }
                if seen.insert(successor.clone()) {
                    next.push(successor.clone());
                }
            }
        }
        next.sort();
        open = next;
    }
    false
}

fn reaches_without_junction(index: &DerivedMapIndex, start: &str, target: &str) -> bool {
    if start == target {
        return true;
    }
    let mut open: Vec<String> = vec![start.to_owned()];
    let mut seen: BTreeSet<String> = BTreeSet::from([start.to_owned()]);
    for _depth in 0..4 {
        if open.is_empty() {
            break;
        }
        let mut next: Vec<String> = Vec::new();
        for rsl in &open {
            let Some(lane) = index.lane(rsl) else {
                continue;
            };
            for successor in &lane.successors {
                if index.lane(successor).is_some_and(|l| l.is_junction) {
                    continue;
                }
                if successor == target {
                    return true;
                }
                if seen.insert(successor.clone()) {
                    next.push(successor.clone());
                }
            }
        }
        next.sort();
        open = next;
    }
    false
}

/// Physical same-direction lanes at a sample: connected components of the
/// cross-section's driving lanes, each represented by its nearest member.
fn physical_lanes(index: &DerivedMapIndex, sample: &CorridorSample) -> Vec<String> {
    let mut remaining: BTreeSet<String> = sample.cs.same_dir_driving.values().cloned().collect();
    let mut components: Vec<Vec<String>> = Vec::new();
    while let Some(seed) = remaining.iter().next().cloned() {
        remaining.remove(&seed);
        let mut component = vec![seed];
        let mut cursor = 0;
        while cursor < component.len() {
            let Some(lane) = index.lane(&component[cursor]) else {
                cursor += 1;
                continue;
            };
            let mut linked: Vec<&String> = lane
                .predecessors
                .iter()
                .chain(lane.successors.iter())
                .collect();
            linked.sort();
            for l in linked {
                if remaining.remove(l) {
                    component.push(l.clone());
                }
            }
            cursor += 1;
        }
        components.push(component);
    }
    let point = index
        .lane(&sample.lane_rsl)
        .map(|r| point_at_s(&r.polyline, sample.s_in_lane));
    let mut out: Vec<String> = components
        .into_iter()
        .map(|component| {
            let mut scored: Vec<(String, f64, f64)> = component
                .into_iter()
                .map(|rsl| {
                    let lane = index.lane(&rsl);
                    match (lane, point) {
                        (Some(lane), Some(p)) => {
                            let proj = project_point(&lane.polyline, p);
                            (
                                rsl,
                                proj.distance,
                                proj.s.min((lane.length_m - proj.s).max(0.0)),
                            )
                        }
                        _ => (rsl, f64::INFINITY, -1.0),
                    }
                })
                .collect();
            scored.sort_by(|a, b| {
                a.1.partial_cmp(&b.1)
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then(b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal))
                    .then_with(|| a.0.cmp(&b.0))
            });
            scored.swap_remove(0).0
        })
        .collect();
    out.sort();
    out
}

/// Lane-count transitions along the corridor, used for `merge` / `lane_drop`.
pub fn lane_count_transitions(
    index: &DerivedMapIndex,
    samples: &[CorridorSample],
    frame: Option<&AnchorFrame>,
) -> Vec<LaneTransition> {
    let mut out: Vec<LaneTransition> = Vec::new();
    for i in 1..samples.len() {
        let prev = &samples[i - 1];
        let cur = &samples[i];
        if !reaches_without_junction(index, &prev.lane_rsl, &cur.lane_rsl) {
            continue;
        }
        let previous = physical_lanes(index, prev);
        let current = physical_lanes(index, cur);
        let from = previous.len();
        let to = current.len();
        if to < from {
            let mut survivors: BTreeSet<String> = BTreeSet::new();
            for target in &current {
                let target_lane = index.lane(target);
                let target_set: BTreeSet<&str> = BTreeSet::from([target.as_str()]);
                let mut candidates: Vec<(String, bool, f64)> = previous
                    .iter()
                    .filter(|rsl| !survivors.contains(*rsl) && reaches(index, rsl, &target_set))
                    .map(|rsl| {
                        let gap = match (
                            index.lane(rsl).and_then(|l| l.polyline.last().copied()),
                            target_lane.and_then(|l| l.polyline.first().copied()),
                        ) {
                            (Some(end), Some(start)) => hypot(end.x - start.x, end.y - start.y),
                            _ => f64::INFINITY,
                        };
                        (rsl.clone(), rsl == target, gap)
                    })
                    .collect();
                candidates.sort_by(|a, b| {
                    b.1.cmp(&a.1)
                        .then(a.2.partial_cmp(&b.2).unwrap_or(std::cmp::Ordering::Equal))
                        .then_with(|| a.0.cmp(&b.0))
                });
                if let Some(first) = candidates.first() {
                    survivors.insert(first.0.clone());
                }
            }
            let terminating: Vec<&String> = previous
                .iter()
                .filter(|rsl| !survivors.contains(*rsl))
                .collect();
            let current_set: BTreeSet<&str> = current.iter().map(String::as_str).collect();
            for lane_rsl in &terminating {
                out.push(LaneTransition {
                    kind: if reaches(index, lane_rsl, &current_set) {
                        TransitionKind::Merge
                    } else {
                        TransitionKind::LaneDrop
                    },
                    s: cur.s,
                    from,
                    to,
                    lane_rsl: Some((*lane_rsl).clone()),
                });
            }
            if terminating.is_empty() {
                out.push(LaneTransition {
                    kind: TransitionKind::LaneDrop,
                    s: cur.s,
                    from,
                    to,
                    lane_rsl: None,
                });
            }
        }
    }
    if let Some(frame) = frame {
        let path_lanes: BTreeSet<&str> = frame
            .reference_path
            .iter()
            .map(|s| s.lane_rsl.as_str())
            .collect();
        for terminating in index.lanes.values() {
            if terminating.is_junction
                || terminating.lane_type != "driving"
                || !terminating.successors.is_empty()
            {
                continue;
            }
            let Some(cs) =
                index.cross_section(&terminating.rsl, (terminating.length_m - 0.5).max(0.0))
            else {
                continue;
            };
            for (k, sibling_rsl) in &cs.same_dir_driving {
                if *k == 0 {
                    continue;
                }
                let Some(sibling) = index.lane(sibling_rsl) else {
                    continue;
                };
                if sibling.is_junction
                    || sibling.lane_type != "driving"
                    || sibling.successors.is_empty()
                {
                    continue;
                }
                let side = if *k > 0 {
                    crate::map_index::LaneSideName::Left
                } else {
                    crate::map_index::LaneSideName::Right
                };
                let allowed = terminating.lane_change_permissions.iter().any(|p| {
                    p.side == side && p.allowed && p.end_s >= (terminating.length_m - 30.0).max(0.0)
                });
                if !allowed {
                    continue;
                }
                let Some(endpoint) = terminating.polyline.last().copied() else {
                    continue;
                };
                let sibling_at = project_point(&sibling.polyline, endpoint);
                let mut continuation_m = (sibling.length_m - sibling_at.s).max(0.0);
                let mut cursor = sibling;
                let mut visited: BTreeSet<&str> = BTreeSet::from([sibling.rsl.as_str()]);
                for _hop in 0..4 {
                    if continuation_m >= 20.0 {
                        break;
                    }
                    let mut succ: Vec<&String> = cursor.successors.iter().collect();
                    succ.sort();
                    let Some(next) = succ.first().and_then(|r| index.lane(r)) else {
                        break;
                    };
                    if next.is_junction || !visited.insert(next.rsl.as_str()) {
                        break;
                    }
                    continuation_m += next.length_m;
                    cursor = next;
                }
                if continuation_m < 20.0 {
                    continue;
                }
                let survivor_touches_path = path_lanes.contains(sibling_rsl.as_str())
                    || sibling
                        .successors
                        .iter()
                        .any(|r| path_lanes.contains(r.as_str()))
                    || sibling
                        .predecessors
                        .iter()
                        .any(|r| path_lanes.contains(r.as_str()));
                if !survivor_touches_path {
                    continue;
                }
                let mut best: Option<(f64, f64)> = None;
                for span in &frame.reference_path {
                    let Some(lane) = index.lane(&span.lane_rsl) else {
                        continue;
                    };
                    if lane.is_junction {
                        continue;
                    }
                    let projected = project_point(&lane.polyline, endpoint);
                    let candidate = (span.s_start + projected.s, projected.distance);
                    if best.is_none_or(|b| {
                        candidate.1 < b.1 || (candidate.1 == b.1 && candidate.0 < b.0)
                    }) {
                        best = Some(candidate);
                    }
                }
                let Some((s, distance)) = best else { continue };
                if distance > 8.0 || s < frame.s_range.0 || s > frame.s_range.1 {
                    continue;
                }
                out.push(LaneTransition {
                    kind: TransitionKind::LaneDrop,
                    s,
                    from: cs.same_dir_driving.len(),
                    to: cs.same_dir_driving.len() - 1,
                    lane_rsl: Some(terminating.rsl.clone()),
                });
            }
        }
    }
    let mut unique: BTreeMap<String, LaneTransition> = BTreeMap::new();
    for t in out {
        let key = format!(
            "{}:{}@{}",
            t.kind.as_str(),
            t.lane_rsl.as_deref().unwrap_or(""),
            simforge_core::math::js_round(t.s * 100.0)
        );
        unique.entry(key).or_insert(t);
    }
    let mut all: Vec<LaneTransition> = unique.into_values().collect();
    all.sort_by(|a, b| {
        a.s.partial_cmp(&b.s)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                a.lane_rsl
                    .as_deref()
                    .unwrap_or("")
                    .cmp(b.lane_rsl.as_deref().unwrap_or(""))
            })
    });
    all
}

fn evaluate_junction_predicates(
    results: &mut Vec<ClauseResult>,
    feature: &MFeature,
    descriptor: Option<&JunctionDescriptor>,
    frame: &AnchorFrame,
    index: &DerivedMapIndex,
    is_origin: bool,
) {
    let Some(jp) = &feature.junction else { return };
    let base = format!("features.{}.junction", feature.id);
    let Some(descriptor) = descriptor else {
        if let Some(c) = &jp.arms {
            results.push(unsupported(
                &format!("{base}.arms"),
                c,
                "no junction descriptor for the matched feature",
            ));
        }
        if let Some(c) = &jp.control {
            results.push(unsupported(
                &format!("{base}.control"),
                c,
                "no junction descriptor for the matched feature",
            ));
        }
        if let Some(c) = &jp.ego_turn {
            results.push(unsupported(
                &format!("{base}.egoTurn"),
                c,
                "no junction descriptor for the matched feature",
            ));
        }
        if let Some(c) = &jp.conflicting_approach {
            results.push(unsupported(
                &format!("{base}.conflictingApproach"),
                c,
                "no junction descriptor for the matched feature",
            ));
        }
        if let Some(c) = &jp.size_m {
            results.push(unsupported(
                &format!("{base}.sizeM"),
                c,
                "no junction descriptor for the matched feature",
            ));
        }
        if let Some(c) = &jp.has_crossing_on_leg {
            results.push(unsupported(
                &format!("{base}.hasCrossingOnLeg"),
                c,
                "no junction descriptor for the matched feature",
            ));
        }
        return;
    };
    if let Some(c) = &jp.arms {
        let (lo, hi) = c.value;
        let actual = descriptor.arms as f64;
        let inside = actual >= lo && actual <= hi;
        let nearest = if actual < lo { lo } else { hi };
        let score = if inside {
            1.0
        } else {
            arm_count_near_miss(descriptor.arms, nearest.round() as usize)
        };
        let reason = if inside {
            format!("{}-arm junction", descriptor.arms)
        } else {
            format!(
                "{}-arm junction, wanted {} (near-miss {score})",
                descriptor.arms,
                if lo == hi {
                    format!("{lo}")
                } else {
                    format!("{lo}-{hi}")
                }
            )
        };
        results.push(result(
            &format!("{base}.arms"),
            c,
            json!(descriptor.arms),
            score,
            if inside {
                0.0
            } else {
                (actual - nearest).abs()
            },
            None,
            reason,
        ));
    }
    if let Some(c) = &jp.control {
        let path = format!("{base}.control");
        match descriptor.control {
            Some(control) if index.capabilities.junction_control => {
                let set = score_set(control, &c.value);
                let wanted: Vec<&str> = c.value.iter().map(|v| v.as_str()).collect();
                let reason = if set.score >= 1.0 {
                    format!("{} junction as requested", control.as_str())
                } else {
                    format!(
                        "{} junction, wanted {}{}",
                        control.as_str(),
                        wanted.join("|"),
                        set.closest
                            .map(|c| format!(" (nearest {}, near-miss {})", c.as_str(), set.score))
                            .unwrap_or_default()
                    )
                };
                results.push(result(
                    &path,
                    c,
                    json!(control.as_str()),
                    set.score,
                    if set.score >= 1.0 {
                        0.0
                    } else {
                        1.0 - set.score
                    },
                    None,
                    reason,
                ));
            }
            _ => results.push(unsupported(
                &path,
                c,
                "junction control is not available in this map index",
            )),
        }
    }
    if let Some(c) = &jp.ego_turn {
        let actual = if is_origin {
            frame.ego_turn.unwrap_or(TurnDirection::Straight)
        } else {
            TurnDirection::Straight
        };
        let (score, slack) = score_bool(actual == c.value, true);
        let reason = if score >= 1.0 {
            format!("reference path turns {}", actual.as_str())
        } else {
            format!(
                "reference path turns {}, wanted {}",
                actual.as_str(),
                c.value.as_str()
            )
        };
        let mut r = result(
            &format!("{base}.egoTurn"),
            c,
            json!(actual.as_str()),
            score,
            slack,
            None,
            reason,
        );
        r.supported = is_origin;
        results.push(r);
    }
    if let Some(c) = &jp.conflicting_approach {
        let wanted = &c.value;
        let ego_gate_id = frame.ego_gate_id.as_deref();
        struct Hit<'a> {
            pair: &'a crate::map_index::ConflictPair,
            other: &'a crate::map_index::DerivedGate,
            relation: crate::template::ApproachRelation,
        }
        let matches: Vec<Hit<'_>> = match ego_gate_id {
            Some(ego) => descriptor
                .conflict_pairs
                .iter()
                .filter(|p| p.gate_a == ego || p.gate_b == ego)
                .filter_map(|p| {
                    let other_id = if p.gate_a == ego {
                        &p.gate_b
                    } else {
                        &p.gate_a
                    };
                    let relation = if p.gate_a == ego {
                        p.relation
                    } else {
                        flip_relation(p.relation)
                    };
                    index.gate(other_id).map(|other| Hit {
                        pair: p,
                        other,
                        relation,
                    })
                })
                .collect(),
            None => Vec::new(),
        };
        let movement: Vec<&Hit<'_>> = matches
            .iter()
            .filter(|m| m.relation == wanted.from && m.other.turn_relation == wanted.turn)
            .collect();
        let hit = movement.iter().find(|m| match wanted.crossing_angle_deg {
            None => true,
            Some((lo, hi)) => m.pair.crossing_angle_deg >= lo && m.pair.crossing_angle_deg <= hi,
        });
        let relation_only = matches.iter().filter(|m| m.relation == wanted.from).count();
        let score = if hit.is_some() { 1.0 } else { 0.0 };
        let actual = match hit {
            Some(h) => {
                json!({ "from": h.relation.as_str(), "turn": h.other.turn_relation.as_str(), "crossingAngleDeg": round2(h.pair.crossing_angle_deg) })
            }
            None => {
                let mut v = json!({ "conflictsFound": matches.len(), "matchingRelation": relation_only, "matchingMovement": movement.len() });
                if wanted.crossing_angle_deg.is_some() {
                    let mut angles: Vec<f64> = movement
                        .iter()
                        .map(|m| round2(m.pair.crossing_angle_deg))
                        .collect();
                    angles.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
                    v["crossingAnglesDeg"] = json!(angles);
                }
                v
            }
        };
        let reason = match hit {
            Some(h) => format!(
                "conflicting {} {} movement crosses the ego path at {}°",
                wanted.from.as_str(),
                wanted.turn.as_str(),
                round2(h.pair.crossing_angle_deg)
            ),
            None => match wanted.crossing_angle_deg {
                Some((lo, hi)) if !movement.is_empty() => format!(
                    "{} {} movement angle is outside [{lo}, {hi}]°",
                    wanted.from.as_str(),
                    wanted.turn.as_str()
                ),
                _ => format!(
                    "no {} {} movement crosses the ego path ({} conflicts at this junction)",
                    wanted.from.as_str(),
                    wanted.turn.as_str(),
                    matches.len()
                ),
            },
        };
        let mut r = result(
            &format!("{base}.conflictingApproach"),
            c,
            actual,
            score,
            if score >= 1.0 { 0.0 } else { 1.0 },
            None,
            reason,
        );
        r.supported = ego_gate_id.is_some();
        results.push(r);
    }
    if let Some(c) = &jp.size_m {
        let scored = score_range(descriptor.size_m, c.value, ToleranceKind::DistanceM);
        results.push(result(
            &format!("{base}.sizeM"),
            c,
            json!(round2(descriptor.size_m)),
            scored.score,
            scored.slack,
            None,
            format!("junction spans {} m", round2(descriptor.size_m)),
        ));
    }
    if let Some(c) = &jp.has_crossing_on_leg {
        let path = format!("{base}.hasCrossingOnLeg");
        if !index.capabilities.crossings {
            results.push(unsupported(
                &path,
                c,
                "this map index carries no crossing layer",
            ));
        } else {
            let actual = descriptor
                .crossings_by_approach
                .values()
                .any(|v| !v.is_empty());
            let (score, slack) = score_bool(actual, c.value);
            results.push(result(
                &path,
                c,
                json!(actual),
                score,
                slack,
                None,
                if actual {
                    "junction has a marked crossing".to_owned()
                } else {
                    "junction has no marked crossing".to_owned()
                },
            ));
        }
    }
}

pub struct EvaluationResult {
    pub clauses: Vec<ClauseResult>,
    pub feature_matches: BTreeMap<String, FeatureMatch>,
    pub reasons: Vec<String>,
    pub samples: Vec<CorridorSample>,
}

struct PointCandidate<'a> {
    p: &'a PointFeature,
    located: Located,
    point_clauses: Vec<ClauseResult>,
    side_score: f64,
    same_road_score: f64,
    lateral_score: f64,
    lateral_slack: f64,
    score: f64,
    slack: f64,
}

impl PointCandidate<'_> {
    fn passes_required(&self, feature: &MFeature) -> bool {
        (feature.at_m.essentiality != Essentiality::Required || self.score == 1.0)
            && feature.lateral_distance_m.as_ref().is_none_or(|c| {
                c.essentiality != Essentiality::Required || self.lateral_score == 1.0
            })
            && feature.same_road.as_ref().is_none_or(|c| {
                c.essentiality != Essentiality::Required || self.same_road_score == 1.0
            })
            && feature
                .side
                .as_ref()
                .is_none_or(|c| c.essentiality != Essentiality::Required || self.side_score == 1.0)
            && self.point_clauses.iter().all(|c| {
                c.essentiality != Essentiality::Required
                    || (c.supported && passes_required(c.score))
            })
    }

    fn weighted(&self) -> f64 {
        self.point_clauses.iter().map(|c| c.score * c.weight).sum()
    }
}

fn cmp_f64_desc(a: f64, b: f64) -> std::cmp::Ordering {
    b.partial_cmp(&a).unwrap_or(std::cmp::Ordering::Equal)
}

/// Evaluate every clause of an anchor against one frame.
pub fn evaluate_anchor(
    index: &DerivedMapIndex,
    frame: &AnchorFrame,
    anchor: &MAnchor,
) -> EvaluationResult {
    let mut results: Vec<ClauseResult> = Vec::new();
    let mut feature_matches: BTreeMap<String, FeatureMatch> = BTreeMap::new();

    let origin = anchor.origin_feature();
    let upstream_need = anchor
        .corridor
        .as_ref()
        .and_then(|c| c.runway_upstream_m.as_ref())
        .map_or(DEFAULT_CORRIDOR_M, |c| c.value);
    let downstream_default = if origin.is_some_and(|o| o.kind == MFeatureKind::Junction) {
        0.0
    } else {
        DEFAULT_CORRIDOR_M
    };
    let downstream_need = anchor
        .corridor
        .as_ref()
        .and_then(|c| c.runway_downstream_m.as_ref())
        .map_or(downstream_default, |c| c.value);
    let feature_reach_up = anchor
        .features
        .iter()
        .fold(0.0_f64, |acc, f| acc.max(-f.at_m.value.0).max(0.0));
    let feature_reach_down = anchor
        .features
        .iter()
        .fold(0.0_f64, |acc, f| acc.max(f.at_m.value.1).max(0.0));
    let samples = sample_corridor(
        index,
        frame,
        -upstream_need.max(feature_reach_up),
        downstream_need.max(feature_reach_down),
        SAMPLE_STRIDE_M,
    );

    evaluate_corridor(&mut results, anchor, index, frame, &samples);

    let junctions = junctions_along_path(index, frame);
    let transitions = lane_count_transitions(index, &samples, Some(frame));

    for feature in &anchor.features {
        let is_origin =
            origin.is_some_and(|o| o.id == feature.id) && frame.origin.kind != OriginKind::Corridor;
        let path = format!("features.{}", feature.id);
        if is_origin {
            let origin_junction_id = frame.origin_junction_id();
            feature_matches.insert(
                feature.id.clone(),
                FeatureMatch {
                    map_feature_id: frame.origin.map_feature_id.clone(),
                    s: 0.0,
                    kind: feature.kind,
                },
            );
            let scored = score_range(0.0, feature.at_m.value, ToleranceKind::DistanceM);
            results.push(result(
                &format!("{path}.atM"),
                &feature.at_m,
                json!(0),
                scored.score,
                scored.slack,
                None,
                "origin feature sits at s = 0 by construction".to_owned(),
            ));
            evaluate_junction_predicates(
                &mut results,
                feature,
                origin_junction_id.and_then(|j| index.junction_descriptors.get(j)),
                frame,
                index,
                true,
            );
            continue;
        }
        match feature.kind {
            MFeatureKind::Junction => {
                let mut scored: Vec<(&(String, f64), f64, f64)> = junctions
                    .iter()
                    .filter(|(j, _)| format!("junction:{j}") != frame.origin.map_feature_id)
                    .map(|j| {
                        let s = score_range(j.1, feature.at_m.value, ToleranceKind::DistanceM);
                        (j, s.score, s.slack)
                    })
                    .collect();
                scored.sort_by(|a, b| cmp_f64_desc(a.1, b.1).then_with(|| a.0 .0.cmp(&b.0 .0)));
                let Some((best, score, slack)) = scored.first().copied() else {
                    results.push(unsupported(
                        &format!("{path}.atM"),
                        &feature.at_m,
                        "no further junction along the reference path",
                    ));
                    continue;
                };
                feature_matches.insert(
                    feature.id.clone(),
                    FeatureMatch {
                        map_feature_id: format!("junction:{}", best.0),
                        s: best.1,
                        kind: MFeatureKind::Junction,
                    },
                );
                results.push(result(
                    &format!("{path}.atM"),
                    &feature.at_m,
                    json!(round2(best.1)),
                    score,
                    slack,
                    Some(best.1),
                    format!("junction {} at s={} m", best.0, round2(best.1)),
                ));
                evaluate_junction_predicates(
                    &mut results,
                    feature,
                    index.junction_descriptors.get(&best.0),
                    frame,
                    index,
                    false,
                );
            }
            MFeatureKind::Merge | MFeatureKind::LaneDrop => {
                let wanted = if feature.kind == MFeatureKind::Merge {
                    TransitionKind::Merge
                } else {
                    TransitionKind::LaneDrop
                };
                let mut scored: Vec<(&LaneTransition, f64, f64)> = transitions
                    .iter()
                    .filter(|t| t.kind == wanted)
                    .map(|t| {
                        let s = score_range(t.s, feature.at_m.value, ToleranceKind::DistanceM);
                        (t, s.score, s.slack)
                    })
                    .collect();
                scored.sort_by(|a, b| {
                    cmp_f64_desc(a.1, b.1).then(
                        a.0.s
                            .partial_cmp(&b.0.s)
                            .unwrap_or(std::cmp::Ordering::Equal),
                    )
                });
                let Some((best, score, slack)) = scored.first().copied() else {
                    results.push(unsupported(
                        &format!("{path}.atM"),
                        &feature.at_m,
                        format!("no {} along the reference path", wanted.as_str()),
                    ));
                    continue;
                };
                feature_matches.insert(
                    feature.id.clone(),
                    FeatureMatch {
                        map_feature_id: format!(
                            "{}:{}@{}",
                            wanted.as_str(),
                            best.lane_rsl.as_deref().unwrap_or(&frame.entry_lane_rsl),
                            round2(best.s)
                        ),
                        s: best.s,
                        kind: feature.kind,
                    },
                );
                results.push(result(
                    &format!("{path}.atM"),
                    &feature.at_m,
                    json!(round2(best.s)),
                    score,
                    slack,
                    Some(best.s),
                    format!(
                        "{} {}→{} lanes at s={} m",
                        wanted.as_str(),
                        best.from,
                        best.to,
                        round2(best.s)
                    ),
                ));
            }
            _ => {
                let point_kind = feature.kind.point_kind();
                let kind_available = match feature.kind {
                    MFeatureKind::Crossing => index.capabilities.crossings,
                    MFeatureKind::ParkingZone => index.capabilities.parking_zones,
                    MFeatureKind::WorkZoneSuitable => index.capabilities.work_zones,
                    MFeatureKind::OcclusionZone => index.capabilities.occlusion_zones,
                    _ => {
                        point_kind.is_some_and(|k| index.point_features.iter().any(|p| p.kind == k))
                    }
                };
                if !kind_available {
                    results.push(unsupported(
                        &format!("{path}.atM"),
                        &feature.at_m,
                        format!("this map index carries no {} layer", feature.kind.as_str()),
                    ));
                    continue;
                }
                let Some(point_kind) = point_kind else {
                    results.push(unsupported(
                        &format!("{path}.atM"),
                        &feature.at_m,
                        format!("{} is not a point-feature kind", feature.kind.as_str()),
                    ));
                    continue;
                };
                let mut on_path: Vec<PointCandidate<'_>> = index
                    .point_features
                    .iter()
                    .filter(|p| p.kind == point_kind)
                    .filter_map(|p| {
                        let located = point_feature_s(index, frame, p)?;
                        let mut point_clauses = evaluate_crossing_predicates(feature, p, &path);
                        point_clauses.extend(evaluate_parking_predicates(feature, p, &path));
                        point_clauses.extend(evaluate_supports_scenario(feature, p, &path));
                        let side_score = feature.side.as_ref().map_or(1.0, |c| {
                            if feature_side_matches(located.side, c.value) {
                                1.0
                            } else {
                                0.0
                            }
                        });
                        let same_road_score = feature.same_road.as_ref().map_or(1.0, |c| {
                            if c.value == (located.source == LocateSource::PointSameRoad) {
                                1.0
                            } else {
                                0.0
                            }
                        });
                        let (lateral_score, lateral_slack) =
                            feature.lateral_distance_m.as_ref().map_or((1.0, 0.0), |c| {
                                let s = score_range(
                                    located.distance_m,
                                    c.value,
                                    ToleranceKind::DistanceM,
                                );
                                (s.score, s.slack)
                            });
                        let at =
                            score_range(located.s, feature.at_m.value, ToleranceKind::DistanceM);
                        Some(PointCandidate {
                            p,
                            located,
                            point_clauses,
                            side_score,
                            same_road_score,
                            lateral_score,
                            lateral_slack,
                            score: at.score,
                            slack: at.slack,
                        })
                    })
                    .collect();
                on_path.sort_by(|a, b| {
                    b.passes_required(feature)
                        .cmp(&a.passes_required(feature))
                        .then_with(|| cmp_f64_desc(a.weighted(), b.weighted()))
                        .then_with(|| cmp_f64_desc(a.score, b.score))
                        .then_with(|| cmp_f64_desc(a.lateral_score, b.lateral_score))
                        .then_with(|| cmp_f64_desc(a.same_road_score, b.same_road_score))
                        .then_with(|| cmp_f64_desc(a.side_score, b.side_score))
                        .then_with(|| {
                            a.located
                                .distance_m
                                .partial_cmp(&b.located.distance_m)
                                .unwrap_or(std::cmp::Ordering::Equal)
                        })
                        .then_with(|| a.located.adjacent.cmp(&b.located.adjacent))
                        .then_with(|| a.p.id.cmp(&b.p.id))
                });
                let Some(best) = on_path.into_iter().next() else {
                    results.push(unsupported(
                        &format!("{path}.atM"),
                        &feature.at_m,
                        format!("no {} on the reference path", feature.kind.as_str()),
                    ));
                    continue;
                };
                let kind_name = feature.kind.as_str();
                feature_matches.insert(
                    feature.id.clone(),
                    FeatureMatch {
                        map_feature_id: best.p.id.clone(),
                        s: best.located.s,
                        kind: feature.kind,
                    },
                );
                let suffix = match best.located.source {
                    LocateSource::PointSameRoad => format!(
                        " (same-road station, {} m lateral)",
                        round2(best.located.distance_m)
                    ),
                    LocateSource::PointNearby => format!(
                        " (projected {} m from feature point)",
                        round2(best.located.distance_m)
                    ),
                    LocateSource::LaneAdjacent if best.located.adjacent => {
                        " on an adjacent lane".to_owned()
                    }
                    LocateSource::LaneAdjacent => String::new(),
                };
                results.push(result(
                    &format!("{path}.atM"),
                    &feature.at_m,
                    json!(round2(best.located.s)),
                    best.score,
                    best.slack,
                    Some(best.located.s),
                    format!(
                        "{kind_name} {} at s={} m{suffix}",
                        best.p.id,
                        round2(best.located.s)
                    ),
                ));
                if let Some(c) = &feature.lateral_distance_m {
                    results.push(result(
                        &format!("{path}.lateralDistanceM"),
                        c,
                        json!(round2(best.located.distance_m)),
                        best.lateral_score,
                        best.lateral_slack,
                        Some(best.located.s),
                        format!(
                            "{kind_name} {} is {} m laterally from the reference path",
                            best.p.id,
                            round2(best.located.distance_m)
                        ),
                    ));
                }
                if let Some(c) = &feature.same_road {
                    let actual = best.located.source == LocateSource::PointSameRoad;
                    let matches = c.value == actual;
                    let reason = if actual {
                        format!(
                            "{kind_name} {} shares the reference OpenDRIVE road and section",
                            best.p.id
                        )
                    } else {
                        format!(
                            "{kind_name} {} is only geometrically near the reference path",
                            best.p.id
                        )
                    };
                    results.push(result(
                        &format!("{path}.sameRoad"),
                        c,
                        json!(actual),
                        if matches { 1.0 } else { 0.0 },
                        if matches { 0.0 } else { 1.0 },
                        Some(best.located.s),
                        reason,
                    ));
                }
                if let Some(c) = &feature.side {
                    let matches = feature_side_matches(best.located.side, c.value);
                    let reason = if matches {
                        format!(
                            "{kind_name} {} is on the {} side of travel",
                            best.p.id,
                            best.located.side.as_str()
                        )
                    } else {
                        format!(
                            "{kind_name} {} is on the {} side of travel, wanted {}",
                            best.p.id,
                            best.located.side.as_str(),
                            c.value.as_str()
                        )
                    };
                    results.push(result(
                        &format!("{path}.side"),
                        c,
                        json!(best.located.side.as_str()),
                        if matches { 1.0 } else { 0.0 },
                        if matches { 0.0 } else { 1.0 },
                        Some(best.located.s),
                        reason,
                    ));
                }
                results.extend(best.point_clauses);
            }
        }
    }

    results.sort_by(|a, b| a.path.cmp(&b.path));
    let reasons = results
        .iter()
        .filter(|r| r.score >= 1.0 && r.supported)
        .map(|r| r.reason.clone())
        .collect();
    EvaluationResult {
        clauses: results,
        feature_matches,
        reasons,
        samples,
    }
}

/// Weighted score over the soft clauses; required clauses are pass/fail.
pub fn aggregate_score(clauses: &[ClauseResult]) -> (f64, Vec<String>) {
    let failed_required: Vec<String> = clauses
        .iter()
        .filter(|c| c.essentiality == Essentiality::Required && !passes_required(c.score))
        .map(|c| c.path.clone())
        .collect();
    let mut weighted = 0.0;
    let mut total = 0.0;
    for c in clauses {
        if c.essentiality == Essentiality::Required || !c.supported {
            continue;
        }
        weighted += c.score * c.weight;
        total += c.weight;
    }
    (
        if total == 0.0 { 1.0 } else { weighted / total },
        failed_required,
    )
}

/// Sample-derived junction descriptors keyed for the origin.
pub fn origin_control(index: &DerivedMapIndex, frame: &AnchorFrame) -> Option<JunctionControl> {
    frame
        .origin_junction_id()
        .and_then(|j| index.junction_descriptors.get(j))
        .and_then(|d| d.control)
}

/// Fact set keyed by kind, used by the matcher's candidate generation.
pub fn point_kinds_present(index: &DerivedMapIndex) -> BTreeSet<PointFeatureKind> {
    index.point_features.iter().map(|p| p.kind).collect()
}
