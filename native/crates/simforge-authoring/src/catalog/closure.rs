//! Does a persisted matcher site close against a raw catalog location?

use simforge_compiler::anchor::MatchedSite;
use simforge_compiler::map_index::{DerivedMapIndex, PointFeatureKind};

use super::js::Js;

fn lane_section(rsl: &str) -> Option<String> {
    let parts: Vec<&str> = rsl.split(':').collect();
    (parts.len() == 3 && !parts[0].is_empty() && !parts[1].is_empty())
        .then(|| format!("{}:{}", parts[0], parts[1]))
}

fn point_segment_distance(p: (f64, f64), a: (f64, f64), b: (f64, f64)) -> f64 {
    let dx = b.0 - a.0;
    let dy = b.1 - a.1;
    let length_squared = dx * dx + dy * dy;
    if length_squared == 0.0 {
        return hypot(p.0 - a.0, p.1 - a.1);
    }
    let t = (((p.0 - a.0) * dx + (p.1 - a.1) * dy) / length_squared).clamp(0.0, 1.0);
    hypot(p.0 - (a.0 + t * dx), p.1 - (a.1 + t * dy))
}

/// `Math.hypot(a, b)` as V8 computes it (scaled Kahan sum of squares), so
/// distances agree to the last bit with the TypeScript reference.
fn hypot(a: f64, b: f64) -> f64 {
    let (a, b) = (a.abs(), b.abs());
    if a.is_infinite() || b.is_infinite() {
        return f64::INFINITY;
    }
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    let max = a.max(b);
    if max == 0.0 {
        return 0.0;
    }
    let mut sum = 0.0_f64;
    let mut compensation = 0.0_f64;
    for v in [a, b] {
        let n = v / max;
        let summand = n * n - compensation;
        let preliminary = sum + summand;
        compensation = (preliminary - sum) - summand;
        sum = preliminary;
    }
    sum.sqrt() * max
}

/// `Math.min(a, b)`: NaN wins.
fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.min(b)
    }
}

fn point_polyline_distance(p: (f64, f64), polyline: &[(f64, f64)]) -> f64 {
    match polyline {
        [] => f64::INFINITY,
        [only] => hypot(p.0 - only.0, p.1 - only.1),
        _ => polyline
            .windows(2)
            .map(|w| point_segment_distance(p, w[0], w[1]))
            .fold(f64::INFINITY, js_min),
    }
}

/// Prove that a persisted matcher site and a raw catalog location describe
/// the same physical reservation. A shared map or road name is not enough:
/// the location's scene point must close against its pinned lane, and the
/// matched frame must bind that location, its exact junction movement, or its
/// anchored road section.
pub fn matcher_site_closes_location(
    site: &MatchedSite,
    value: &Js,
    index: &DerivedMapIndex,
) -> bool {
    if !value.is_record() {
        return false;
    }
    let anchor = value.get("anchor").filter(|a| a.is_record());
    let road = anchor.and_then(|a| a.get("road")).filter(|r| r.is_record());
    let scene = anchor
        .and_then(|a| a.get("scene"))
        .filter(|s| s.is_record());
    let (Some(location_id), Some(rsl), Some(offset_m), Some(scene_x), Some(scene_z)) = (
        value.get("id").and_then(Js::as_str),
        road.and_then(|r| r.get("rsl")).and_then(Js::as_str),
        road.and_then(|r| r.get("offsetM")).and_then(Js::as_f64),
        scene.and_then(|s| s.get("x")).and_then(Js::as_f64),
        scene.and_then(|s| s.get("z")).and_then(Js::as_f64),
    ) else {
        return false;
    };

    let Some(anchored_lane) = index.lane(rsl) else {
        return false;
    };
    if lane_section(rsl).is_none() {
        return false;
    }
    let polyline: Vec<(f64, f64)> = anchored_lane.polyline.iter().map(|p| (p.x, p.y)).collect();
    let anchor_distance = point_polyline_distance((scene_x, -scene_z), &polyline);
    // `!(d <= limit)` also rejects NaN, as `!isFinite(d) || d > limit` does.
    if !anchor_distance.is_finite() || anchor_distance > offset_m.abs() + 2.0 {
        return false;
    }

    let path_has_rsl = site
        .frame
        .reference_path
        .iter()
        .any(|span| span.lane_rsl == rsl);
    let feature_bound = site
        .feature_matches
        .values()
        .any(|m| m.map_feature_id == location_id);
    let binds_work_zone_reservation = site
        .feature_matches
        .values()
        .any(|m| feature_kind(&m.kind).as_deref() == Some("work_zone_suitable"));
    let point_feature = index.point_features.iter().find(|f| f.id == location_id);
    // A point feature (notably a crosswalk) may be anchored to its own
    // perpendicular lane while the matcher's vehicle reference path runs
    // through it: once the scene point closed against its anchor lane, an
    // exact feature-id match is the authoritative join.
    if feature_bound {
        return true;
    }
    // `work_zone_suitable` is a derived corridor reservation kept in the
    // point-feature index for lookup; its exactness is the anchored road
    // segment plus membership in the reference path, checked below. Genuine
    // point features stay identity-bound.
    if let Some(feature) = point_feature {
        if feature.kind != PointFeatureKind::WorkZoneSuitable || binds_work_zone_reservation {
            return false;
        }
    }

    let origin = site.frame.origin.map_feature_id.as_str();
    if origin.starts_with("junction:") {
        let junction_id = road.and_then(|r| r.get("junctionId")).and_then(Js::as_str);
        return junction_id.is_some_and(|j| origin == format!("junction:{j}")) && path_has_rsl;
    }
    index
        .fact_index
        .segment_ids_by_lane
        .get(rsl)
        .is_some_and(|segment| origin == segment)
        && path_has_rsl
}

fn feature_kind<T: serde::Serialize>(kind: &T) -> Option<String> {
    serde_json::to_value(kind)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
}
