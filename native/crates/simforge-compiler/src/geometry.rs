//! Planar helpers over travel-ordered lane polylines, plus the cross-section
//! query ("standing on lane X at arc length s, what is beside me?").
//!
//! Everything is 2-D on purpose: topology polylines carry `{x, y}` only, so
//! grade is *not derivable* — `IndexCapabilities::grade` says so and a required
//! `gradePct` clause fails loudly rather than scoring a silent 1.0.

use std::collections::{BTreeMap, BTreeSet};

use simforge_core::math::{atan2, dist, hypot, Vec2, TWO_PI};

use crate::map_index::{DerivedLane, LaneTable};

pub type Point2 = Vec2;

/// Cumulative arc length at each vertex; `[0] == 0`.
pub fn cumulative_lengths(poly: &[Point2]) -> Vec<f64> {
    let mut out = Vec::with_capacity(poly.len());
    if poly.is_empty() {
        return out;
    }
    out.push(0.0);
    for i in 1..poly.len() {
        out.push(out[i - 1] + dist(poly[i - 1], poly[i]));
    }
    out
}

pub fn polyline_length(poly: &[Point2]) -> f64 {
    if poly.len() < 2 {
        return 0.0;
    }
    let mut total = 0.0;
    for i in 1..poly.len() {
        total += dist(poly[i - 1], poly[i]);
    }
    total
}

/// Point at arc length `s`, clamped to the ends.
pub fn point_at_s(poly: &[Point2], s: f64) -> Point2 {
    if poly.is_empty() {
        return Vec2::ZERO;
    }
    if poly.len() == 1 {
        return poly[0];
    }
    let c = cumulative_lengths(poly);
    let total = c[c.len() - 1];
    let target = s.max(0.0).min(total);
    for i in 1..poly.len() {
        let prev = c[i - 1];
        let cur = c[i];
        if target <= cur {
            let seg = cur - prev;
            let t = if seg <= 1e-9 {
                0.0
            } else {
                (target - prev) / seg
            };
            let a = poly[i - 1];
            let b = poly[i];
            return Vec2 {
                x: a.x + (b.x - a.x) * t,
                y: a.y + (b.y - a.y) * t,
            };
        }
    }
    poly[poly.len() - 1]
}

/// Tangent heading (radians, CCW from +x) at arc length `s`.
pub fn heading_at_s(poly: &[Point2], s: f64) -> f64 {
    if poly.len() < 2 {
        return 0.0;
    }
    let c = cumulative_lengths(poly);
    let total = c[c.len() - 1];
    let target = s.max(0.0).min(total);
    for i in 1..poly.len() {
        if target <= c[i] || i == poly.len() - 1 {
            let a = poly[i - 1];
            let b = poly[i];
            return atan2(b.y - a.y, b.x - a.x);
        }
    }
    0.0
}

/// Signed angle difference `a - b` in `(-pi, pi]`.
pub fn angle_diff(a: f64, b: f64) -> f64 {
    let mut d = (a - b) % TWO_PI;
    if d > std::f64::consts::PI {
        d -= TWO_PI;
    }
    if d <= -std::f64::consts::PI {
        d += TWO_PI;
    }
    d
}

#[inline]
pub fn to_deg(rad: f64) -> f64 {
    rad * 180.0 / std::f64::consts::PI
}

#[inline]
pub fn to_rad(deg: f64) -> f64 {
    deg * std::f64::consts::PI / 180.0
}

/// Mean absolute heading change per 10 m over a window centred on `s`.
pub fn curvature_deg_per_10m_at(poly: &[Point2], s: f64, window_m: f64) -> f64 {
    let total = polyline_length(poly);
    if total < 1.0 {
        return 0.0;
    }
    let half = window_m / 2.0;
    let s0 = (s - half).min(total - 1e-6).max(0.0);
    let s1 = (s + half).min(total).max(s0 + 1e-6);
    let h0 = heading_at_s(poly, s0);
    let h1 = heading_at_s(poly, s1);
    let span = s1 - s0;
    to_deg(angle_diff(h1, h0)).abs() * 10.0 / span
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Projection {
    pub s: f64,
    pub distance: f64,
    /// `+1` = left of travel direction, `-1` = right.
    pub side: i8,
}

/// Nearest point on a polyline to `p`: arc length, distance, and side.
pub fn project_point(poly: &[Point2], p: Point2) -> Projection {
    let mut best = Projection {
        s: 0.0,
        distance: f64::INFINITY,
        side: 1,
    };
    if poly.is_empty() {
        return best;
    }
    if poly.len() == 1 {
        return Projection {
            s: 0.0,
            distance: dist(poly[0], p),
            side: 1,
        };
    }
    let c = cumulative_lengths(poly);
    for i in 1..poly.len() {
        let a = poly[i - 1];
        let b = poly[i];
        let vx = b.x - a.x;
        let vy = b.y - a.y;
        let len2 = vx * vx + vy * vy;
        let t = if len2 <= 1e-12 {
            0.0
        } else {
            (((p.x - a.x) * vx + (p.y - a.y) * vy) / len2).clamp(0.0, 1.0)
        };
        let qx = a.x + vx * t;
        let qy = a.y + vy * t;
        let d = hypot(p.x - qx, p.y - qy);
        if d < best.distance {
            let cross = vx * (p.y - a.y) - vy * (p.x - a.x);
            best = Projection {
                s: c[i - 1] + t * len2.sqrt(),
                distance: d,
                side: if cross >= 0.0 { 1 } else { -1 },
            };
        }
    }
    best
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PolylineCrossing {
    pub point: Point2,
    pub s_on_a: f64,
    pub s_on_b: f64,
    /// Absolute crossing angle in `[0, 180]`.
    pub angle_deg: f64,
}

/// First proper intersection of two polylines (segment/segment, O(n·m)).
pub fn polyline_intersection(a: &[Point2], b: &[Point2]) -> Option<PolylineCrossing> {
    if a.len() < 2 || b.len() < 2 {
        return None;
    }
    let ca = cumulative_lengths(a);
    let cb = cumulative_lengths(b);
    let mut best: Option<PolylineCrossing> = None;
    for i in 1..a.len() {
        let p1 = a[i - 1];
        let p2 = a[i];
        let r = Vec2 {
            x: p2.x - p1.x,
            y: p2.y - p1.y,
        };
        for j in 1..b.len() {
            let q1 = b[j - 1];
            let q2 = b[j];
            let s = Vec2 {
                x: q2.x - q1.x,
                y: q2.y - q1.y,
            };
            let denom = r.x * s.y - r.y * s.x;
            if denom.abs() < 1e-12 {
                continue;
            }
            let qp = Vec2 {
                x: q1.x - p1.x,
                y: q1.y - p1.y,
            };
            let t = (qp.x * s.y - qp.y * s.x) / denom;
            let u = (qp.x * r.y - qp.y * r.x) / denom;
            if !(0.0..=1.0).contains(&t) || !(0.0..=1.0).contains(&u) {
                continue;
            }
            let point = Vec2 {
                x: p1.x + r.x * t,
                y: p1.y + r.y * t,
            };
            let s_on_a = ca[i - 1] + t * hypot(r.x, r.y);
            let s_on_b = cb[j - 1] + u * hypot(s.x, s.y);
            let angle = to_deg(angle_diff(atan2(r.y, r.x), atan2(s.y, s.x))).abs();
            let candidate = PolylineCrossing {
                point,
                s_on_a,
                s_on_b,
                angle_deg: angle,
            };
            if best.is_none_or(|b| candidate.s_on_a < b.s_on_a) {
                best = Some(candidate);
            }
        }
    }
    best
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BBox {
    pub min_x: f64,
    pub min_y: f64,
    pub max_x: f64,
    pub max_y: f64,
}

pub fn bbox(poly: &[Point2]) -> BBox {
    let mut b = BBox {
        min_x: f64::INFINITY,
        min_y: f64::INFINITY,
        max_x: f64::NEG_INFINITY,
        max_y: f64::NEG_INFINITY,
    };
    for p in poly {
        b.min_x = b.min_x.min(p.x);
        b.min_y = b.min_y.min(p.y);
        b.max_x = b.max_x.max(p.x);
        b.max_y = b.max_y.max(p.y);
    }
    b
}

pub fn bbox_overlaps(a: &BBox, b: &BBox, pad: f64) -> bool {
    a.min_x - pad <= b.max_x
        && b.min_x - pad <= a.max_x
        && a.min_y - pad <= b.max_y
        && b.min_y - pad <= a.max_y
}

/* ---------------------------------------------------------- cross section */

/// Largest centre-to-centre lateral gap that still counts as "the next lane".
pub const MAX_LANE_GAP_M: f64 = 6.0;
/// Radius of the cross-section query.
pub const CROSS_SECTION_RADIUS_M: f64 = 26.0;
/// Grid cell size for the lane lookup.
const GRID_CELL_M: f64 = 25.0;

#[derive(Debug, Clone, PartialEq)]
pub struct NeighborLane {
    pub rsl: String,
    pub lane_type: String,
    pub same_direction: bool,
    /// Signed lateral offset from the reference lane: positive = left of travel.
    pub lateral_m: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CrossSection {
    pub reference_rsl: String,
    pub s: f64,
    /// Same-direction driving lanes by signed k (0 = reference, +1 = one left).
    pub same_dir_driving: BTreeMap<i32, String>,
    /// Opposing driving lanes, innermost first.
    pub opposing_driving: Vec<String>,
    /// Every lane reached by the chain, ordered left to right.
    pub neighbors: Vec<NeighborLane>,
    pub lane_width_m: f64,
    pub speed_limit_kph: f64,
}

/// Width of a lane at travel-order arc length `s`, linearly interpolated.
pub fn lane_width_at(lane: &DerivedLane, s: f64) -> f64 {
    let samples = &lane.width_samples;
    if samples.is_empty() {
        return lane.representative_width_m;
    }
    if samples.len() == 1 {
        return samples[0].width_m;
    }
    let clamped = s.max(samples[0].s).min(samples[samples.len() - 1].s);
    for i in 1..samples.len() {
        let a = samples[i - 1];
        let b = samples[i];
        if clamped <= b.s {
            let span = b.s - a.s;
            let t = if span <= 1e-9 {
                0.0
            } else {
                (clamped - a.s) / span
            };
            return a.width_m + (b.width_m - a.width_m) * t;
        }
    }
    samples[samples.len() - 1].width_m
}

/// Uniform grid over lane polyline vertices, built once per lane table.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct LaneGrid {
    cells: BTreeMap<(i64, i64), Vec<String>>,
}

fn cell_of(p: Point2) -> (i64, i64) {
    (
        (p.x / GRID_CELL_M).floor() as i64,
        (p.y / GRID_CELL_M).floor() as i64,
    )
}

impl LaneGrid {
    pub fn build(lanes: &LaneTable) -> Self {
        let mut cells: BTreeMap<(i64, i64), Vec<String>> = BTreeMap::new();
        for (rsl, lane) in lanes {
            let mut seen: BTreeSet<(i64, i64)> = BTreeSet::new();
            for p in &lane.polyline {
                let key = cell_of(*p);
                if !seen.insert(key) {
                    continue;
                }
                cells.entry(key).or_default().push(rsl.clone());
            }
        }
        Self { cells }
    }

    pub fn lanes_near(&self, at: Point2, radius: f64) -> Vec<String> {
        let span = (radius / GRID_CELL_M).ceil() as i64;
        let (cx, cy) = cell_of(at);
        let mut found: BTreeSet<&str> = BTreeSet::new();
        for dx in -span..=span {
            for dy in -span..=span {
                if let Some(bucket) = self.cells.get(&(cx + dx, cy + dy)) {
                    found.extend(bucket.iter().map(String::as_str));
                }
            }
        }
        found.into_iter().map(str::to_owned).collect()
    }
}

/// The cross-section at `(lane_rsl, s)`; `s` is arc length along the lane's
/// travel-ordered polyline.
pub fn cross_section_at(
    lanes: &LaneTable,
    grid: &LaneGrid,
    lane_rsl: &str,
    s: f64,
) -> Option<CrossSection> {
    let reference = lanes.get(lane_rsl)?;
    if reference.polyline.len() < 2 {
        return None;
    }
    let at = point_at_s(&reference.polyline, s);
    let ref_heading = heading_at_s(&reference.polyline, s);

    let mut candidates: BTreeSet<String> = grid
        .lanes_near(at, CROSS_SECTION_RADIUS_M)
        .into_iter()
        .collect();
    for adj in [
        &reference.adjacent_left.lane_rsl,
        &reference.adjacent_right.lane_rsl,
    ] {
        if let Some(r) = adj {
            if lanes.contains_key(r) {
                candidates.insert(r.clone());
            }
        }
    }
    candidates.remove(lane_rsl);

    let mut measured: Vec<NeighborLane> = Vec::new();
    for other_rsl in &candidates {
        let Some(other) = lanes.get(other_rsl) else {
            continue;
        };
        if other.polyline.len() < 2 || other.is_junction {
            continue;
        }
        let proj = project_point(&other.polyline, at);
        if proj.distance > CROSS_SECTION_RADIUS_M {
            continue;
        }
        let other_heading = heading_at_s(&other.polyline, proj.s);
        let delta = angle_diff(other_heading, ref_heading).abs();
        let parallel = delta < std::f64::consts::FRAC_PI_8
            || delta > std::f64::consts::PI - std::f64::consts::FRAC_PI_8;
        if !parallel {
            continue;
        }
        let other_point = point_at_s(&other.polyline, proj.s);
        let back = project_point(&reference.polyline, other_point);
        if (back.s - s).abs() > MAX_LANE_GAP_M * 3.0 {
            continue;
        }
        measured.push(NeighborLane {
            rsl: other_rsl.clone(),
            lane_type: other.lane_type.clone(),
            same_direction: delta < std::f64::consts::FRAC_PI_2,
            lateral_m: f64::from(back.side) * back.distance,
        });
    }

    let chain_side = |side: f64| -> Vec<NeighborLane> {
        let mut pool: Vec<&NeighborLane> = measured
            .iter()
            .filter(|n| js_sign(n.lateral_m) == side)
            .collect();
        pool.sort_by(|a, b| {
            a.lateral_m
                .abs()
                .partial_cmp(&b.lateral_m.abs())
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.rsl.cmp(&b.rsl))
        });
        let mut accepted: Vec<NeighborLane> = Vec::new();
        let mut previous = 0.0;
        for candidate in pool {
            let gap = candidate.lateral_m.abs() - previous;
            if gap > MAX_LANE_GAP_M {
                break;
            }
            if gap < 0.3 && !accepted.is_empty() {
                continue;
            }
            accepted.push(candidate.clone());
            previous = candidate.lateral_m.abs();
        }
        accepted
    };

    let mut neighbors: Vec<NeighborLane> = chain_side(1.0);
    neighbors.extend(chain_side(-1.0));
    neighbors.sort_by(|a, b| {
        b.lateral_m
            .partial_cmp(&a.lateral_m)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut same_dir_driving: BTreeMap<i32, String> = BTreeMap::new();
    same_dir_driving.insert(0, lane_rsl.to_owned());
    let take_through = |side: f64| -> Vec<&NeighborLane> {
        let mut ordered: Vec<&NeighborLane> = neighbors
            .iter()
            .filter(|n| js_sign(n.lateral_m) == side)
            .collect();
        ordered.sort_by(|a, b| {
            a.lateral_m
                .abs()
                .partial_cmp(&b.lateral_m.abs())
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let mut out = Vec::new();
        for n in ordered {
            if !n.same_direction || n.lane_type != "driving" {
                break;
            }
            out.push(n);
        }
        out
    };
    for (i, n) in take_through(1.0).into_iter().enumerate() {
        same_dir_driving.insert(i as i32 + 1, n.rsl.clone());
    }
    for (i, n) in take_through(-1.0).into_iter().enumerate() {
        same_dir_driving.insert(-(i as i32 + 1), n.rsl.clone());
    }

    let mut opposing: Vec<&NeighborLane> = neighbors
        .iter()
        .filter(|n| !n.same_direction && n.lane_type == "driving")
        .collect();
    opposing.sort_by(|a, b| {
        a.lateral_m
            .abs()
            .partial_cmp(&b.lateral_m.abs())
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let opposing_driving = opposing.into_iter().map(|n| n.rsl.clone()).collect();

    Some(CrossSection {
        reference_rsl: lane_rsl.to_owned(),
        s,
        same_dir_driving,
        opposing_driving,
        neighbors,
        lane_width_m: lane_width_at(reference, s),
        speed_limit_kph: reference.speed_limit_kph,
    })
}

/// `Math.sign` for the chain filters (`0` for an exact zero offset).
fn js_sign(v: f64) -> f64 {
    if v > 0.0 {
        1.0
    } else if v < 0.0 {
        -1.0
    } else {
        0.0
    }
}

/// Adjacent-kind vocabulary present at a cross-section (matcher clause units).
pub fn adjacent_kinds(cs: &CrossSection) -> Vec<String> {
    let mut kinds: BTreeSet<&str> = BTreeSet::new();
    for n in &cs.neighbors {
        if n.lane_type == "driving" {
            if !n.same_direction {
                kinds.insert("opposing");
            }
            continue;
        }
        match n.lane_type.as_str() {
            "parking" => {
                kinds.insert("parking");
            }
            "biking" => {
                kinds.insert("biking");
            }
            "sidewalk" => {
                kinds.insert("sidewalk");
            }
            "shoulder" => {
                kinds.insert("shoulder");
            }
            "median" | "restricted" => {
                kinds.insert("median");
            }
            _ => {}
        }
    }
    kinds.into_iter().map(str::to_owned).collect()
}
