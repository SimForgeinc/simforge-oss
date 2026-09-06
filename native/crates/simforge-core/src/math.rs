//! Deterministic planar geometry, all `f64`.
//!
//! Everything here operates in the **xodr-local** frame: `x` east, `y` north,
//! metres, headings measured CCW from `+x`. The scene frame (what the viewer
//! uses, y-up) meets the local frame in exactly one place: [`local_from_scene`]
//! / [`to_scene_xz`]. Inputs are flipped once on ingest; traces are emitted
//! local and flipped by the consumer.
//!
//! | Surface | Frame |
//! |---|---|
//! | `SimScenarioInput` poses / points / occluder OBBs | **scene** `{x, z}` |
//! | Everything inside the engine | **xodr-local** `{x, y}` |
//! | trace ticks (`header.frame == "xodr-local"`) | **xodr-local** `{x, y}` |
//!
//! `heading_rad` is numerically identical in both frames: a rotation of `+X`
//! about scene `+Y` and a rotation of `+X` about local `+Z` describe the same
//! direction under `scene = (x, z, -y)`.

use std::ops::{Add, AddAssign, Mul, Neg, Sub, SubAssign};

use serde::{Deserialize, Serialize};

pub mod ieee754;

pub use ieee754::{acos, atan, atan2, cbrt, cos, exp, hypot, log, pow, sin, sin_cos, tan, tanh};

pub const TWO_PI: f64 = std::f64::consts::PI * 2.0;

/// A 2-D point / vector in xodr-local metres.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct Vec2 {
    pub x: f64,
    pub y: f64,
}

impl Vec2 {
    pub const ZERO: Vec2 = Vec2 { x: 0.0, y: 0.0 };

    #[inline]
    pub const fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }

    /// Unit vector for a heading (CCW from `+x`).
    #[inline]
    pub fn from_heading(heading_rad: f64) -> Self {
        let (s, c) = sin_cos(heading_rad);
        Self { x: c, y: s }
    }

    #[inline]
    pub fn dot(self, o: Vec2) -> f64 {
        self.x * o.x + self.y * o.y
    }

    /// 2-D cross product (`z` of the 3-D cross), positive when `o` is CCW of `self`.
    #[inline]
    pub fn cross(self, o: Vec2) -> f64 {
        self.x * o.y - self.y * o.x
    }

    #[inline]
    pub fn length2(self) -> f64 {
        self.x * self.x + self.y * self.y
    }

    #[inline]
    pub fn length(self) -> f64 {
        hypot(self.x, self.y)
    }

    /// Heading of this vector, CCW from `+x`, in `(-PI, PI]`.
    #[inline]
    pub fn heading(self) -> f64 {
        atan2(self.y, self.x)
    }

    /// Rotated CCW by `angle_rad`.
    #[inline]
    pub fn rotated(self, angle_rad: f64) -> Self {
        let (s, c) = sin_cos(angle_rad);
        Self {
            x: self.x * c - self.y * s,
            y: self.x * s + self.y * c,
        }
    }

    /// Left-hand perpendicular (`+90°`).
    #[inline]
    pub fn perp_left(self) -> Self {
        Self {
            x: -self.y,
            y: self.x,
        }
    }

    #[inline]
    pub fn is_finite(self) -> bool {
        self.x.is_finite() && self.y.is_finite()
    }
}

impl Add for Vec2 {
    type Output = Vec2;
    #[inline]
    fn add(self, o: Vec2) -> Vec2 {
        Vec2 {
            x: self.x + o.x,
            y: self.y + o.y,
        }
    }
}
impl AddAssign for Vec2 {
    #[inline]
    fn add_assign(&mut self, o: Vec2) {
        self.x += o.x;
        self.y += o.y;
    }
}
impl Sub for Vec2 {
    type Output = Vec2;
    #[inline]
    fn sub(self, o: Vec2) -> Vec2 {
        Vec2 {
            x: self.x - o.x,
            y: self.y - o.y,
        }
    }
}
impl SubAssign for Vec2 {
    #[inline]
    fn sub_assign(&mut self, o: Vec2) {
        self.x -= o.x;
        self.y -= o.y;
    }
}
impl Mul<f64> for Vec2 {
    type Output = Vec2;
    #[inline]
    fn mul(self, k: f64) -> Vec2 {
        Vec2 {
            x: self.x * k,
            y: self.y * k,
        }
    }
}
impl Mul<Vec2> for f64 {
    type Output = Vec2;
    #[inline]
    fn mul(self, v: Vec2) -> Vec2 {
        Vec2 {
            x: v.x * self,
            y: v.y * self,
        }
    }
}
impl Neg for Vec2 {
    type Output = Vec2;
    #[inline]
    fn neg(self) -> Vec2 {
        Vec2 {
            x: -self.x,
            y: -self.y,
        }
    }
}

/* ------------------------------------------------------------------ frames */

/// A ground-plane point in the y-up scene frame.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct SceneXZ {
    pub x: f64,
    pub z: f64,
}

/// scene `{x, z}` → xodr-local `{x, y}`.
#[inline]
pub fn local_from_scene(p: SceneXZ) -> Vec2 {
    Vec2 { x: p.x, y: -p.z }
}

/// xodr-local `{x, y}` → scene `{x, z}`.
#[inline]
pub fn to_scene_xz(p: Vec2) -> SceneXZ {
    SceneXZ { x: p.x, z: -p.y }
}

/// Headings are frame-invariant under this mapping; this documents that.
#[inline]
pub const fn scene_heading(local_heading_rad: f64) -> f64 {
    local_heading_rad
}

/* ----------------------------------------------------------------- scalars */

#[inline]
pub fn clamp(v: f64, lo: f64, hi: f64) -> f64 {
    if v < lo {
        lo
    } else if v > hi {
        hi
    } else {
        v
    }
}

#[inline]
pub fn lerp(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t
}

#[inline]
pub fn dist(a: Vec2, b: Vec2) -> f64 {
    hypot(a.x - b.x, a.y - b.y)
}

#[inline]
pub fn dist2(a: Vec2, b: Vec2) -> f64 {
    let dx = a.x - b.x;
    let dy = a.y - b.y;
    dx * dx + dy * dy
}

/// Wrap an angle into `(-PI, PI]`.
///
/// Uses the truncating remainder (`%`), like the JavaScript reference, so the
/// intermediate value keeps the sign of the input before the single correction.
#[inline]
pub fn normalize_angle(a: f64) -> f64 {
    let mut v = a % TWO_PI;
    if v <= -std::f64::consts::PI {
        v += TWO_PI;
    }
    if v > std::f64::consts::PI {
        v -= TWO_PI;
    }
    v
}

/// Shortest signed delta from `from` to `to`, in `(-PI, PI]`.
#[inline]
pub fn angle_delta(from: f64, to: f64) -> f64 {
    normalize_angle(to - from)
}

/// Interpolate between two headings the short way round.
#[inline]
pub fn lerp_angle(a: f64, b: f64, t: f64) -> f64 {
    normalize_angle(a + angle_delta(a, b) * t)
}

/// ECMAScript `Math.round`: nearest integer, ties toward `+∞`.
#[inline]
pub fn js_round(x: f64) -> f64 {
    // `f64::round` breaks ties away from zero, which agrees with JavaScript
    // for non-negative inputs and disagrees for exact negative halves.
    let r = x.round();
    if x < 0.0 && x - r == 0.5 {
        r + 1.0
    } else {
        r
    }
}

/// Round to a fixed number of decimals with a deterministic tie rule.
///
/// Used only for trace serialisation, never inside an integrator: quantising
/// the output keeps traces small and byte-comparable across platforms that may
/// differ in the last ULP of `hypot` et al. Non-finite input quantises to `0`;
/// negative halves round symmetrically to positive ones so mirrored scenarios
/// quantise identically; `-0` normalises to `0`.
pub fn quantize(v: f64, decimals: i32) -> f64 {
    if !v.is_finite() {
        return 0.0;
    }
    let f = 10f64.powi(decimals);
    let scaled = v * f;
    let r = if scaled < 0.0 {
        -(-scaled).round()
    } else {
        scaled.round()
    };
    r / f + 0.0
}

/* --------------------------------------------------------------------- OBB */

/// An oriented bounding box in the ground plane.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Obb {
    /// Centre in xodr-local metres.
    pub center: Vec2,
    /// Full length along the heading axis, metres.
    pub length_m: f64,
    /// Full width across the heading axis, metres.
    pub width_m: f64,
    /// Heading in radians, CCW from `+x`.
    pub heading_rad: f64,
}

/// The four corners of an OBB, counter-clockwise from front-left.
pub fn obb_corners(obb: &Obb) -> [Vec2; 4] {
    let (s, c) = sin_cos(obb.heading_rad);
    let hl = obb.length_m / 2.0;
    let hw = obb.width_m / 2.0;
    let fx = c * hl;
    let fy = s * hl;
    let lx = -s * hw;
    let ly = c * hw;
    let Vec2 { x, y } = obb.center;
    [
        Vec2 {
            x: x + fx + lx,
            y: y + fy + ly,
        },
        Vec2 {
            x: x - fx + lx,
            y: y - fy + ly,
        },
        Vec2 {
            x: x - fx - lx,
            y: y - fy - ly,
        },
        Vec2 {
            x: x + fx - lx,
            y: y + fy - ly,
        },
    ]
}

#[inline]
fn project_extent(points: &[Vec2; 4], ax: f64, ay: f64) -> (f64, f64) {
    let mut lo = f64::INFINITY;
    let mut hi = f64::NEG_INFINITY;
    for p in points {
        let v = p.x * ax + p.y * ay;
        if v < lo {
            lo = v;
        }
        if v > hi {
            hi = v;
        }
    }
    (lo, hi)
}

/// Separating-axis test. `true` when the two boxes overlap (touching counts).
pub fn obb_overlap(a: &Obb, b: &Obb) -> bool {
    let ca = obb_corners(a);
    let cb = obb_corners(b);
    let (sa, ca_) = sin_cos(a.heading_rad);
    let (sb, cb_) = sin_cos(b.heading_rad);
    let axes = [(ca_, sa), (-sa, ca_), (cb_, sb), (-sb, cb_)];
    for (ax, ay) in axes {
        let (alo, ahi) = project_extent(&ca, ax, ay);
        let (blo, bhi) = project_extent(&cb, ax, ay);
        if ahi < blo || bhi < alo {
            return false;
        }
    }
    true
}

/// Exact minimum surface separation between two ground-plane OBBs.
pub fn obb_separation(a: &Obb, b: &Obb) -> f64 {
    if obb_overlap(a, b) {
        return 0.0;
    }
    let ac = obb_corners(a);
    let bc = obb_corners(b);
    let mut best2 = f64::INFINITY;
    for p in &ac {
        for i in 0..4 {
            best2 = best2.min(point_segment(*p, bc[i], bc[(i + 1) % 4]).d2);
        }
    }
    for p in &bc {
        for i in 0..4 {
            best2 = best2.min(point_segment(*p, ac[i], ac[(i + 1) % 4]).d2);
        }
    }
    best2.sqrt()
}

/* ---------------------------------------------------------------- segments */

/// Result of projecting a point onto a segment.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SegmentProjection {
    /// Clamped parameter along `a→b`, in `[0, 1]`.
    pub t: f64,
    /// Squared distance from the point to `closest`.
    pub d2: f64,
    pub closest: Vec2,
}

/// Squared distance from a point to a segment, plus the clamped parameter.
pub fn point_segment(p: Vec2, a: Vec2, b: Vec2) -> SegmentProjection {
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let len2 = dx * dx + dy * dy;
    let t = if len2 <= 0.0 {
        0.0
    } else {
        clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2, 0.0, 1.0)
    };
    let closest = Vec2 {
        x: a.x + dx * t,
        y: a.y + dy * t,
    };
    SegmentProjection {
        t,
        d2: dist2(p, closest),
        closest,
    }
}

/// Segment/segment intersection parameter along `p→p2`, or `None`.
pub fn segment_intersection(p: Vec2, p2: Vec2, q: Vec2, q2: Vec2) -> Option<f64> {
    let rx = p2.x - p.x;
    let ry = p2.y - p.y;
    let sx = q2.x - q.x;
    let sy = q2.y - q.y;
    let denom = rx * sy - ry * sx;
    if denom.abs() < 1e-12 {
        return None;
    }
    let qpx = q.x - p.x;
    let qpy = q.y - p.y;
    let t = (qpx * sy - qpy * sx) / denom;
    let u = (qpx * ry - qpy * rx) / denom;
    if !(0.0..=1.0).contains(&t) || !(0.0..=1.0).contains(&u) {
        return None;
    }
    Some(t)
}

/// Point-in-polygon by ray casting; boundary membership is unspecified.
pub fn point_in_polygon(p: Vec2, poly: &[Vec2]) -> bool {
    let mut inside = false;
    let n = poly.len();
    if n == 0 {
        return false;
    }
    let mut j = n - 1;
    for i in 0..n {
        let a = poly[i];
        let b = poly[j];
        if (a.y > p.y) != (b.y > p.y) {
            let x_at = ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x;
            if p.x < x_at {
                inside = !inside;
            }
        }
        j = i;
    }
    inside
}

/// Distance from a point to a segment, metres. Degenerate segments collapse to
/// their first endpoint (the `1e-12` threshold matches the surface-field
/// reference implementation).
pub fn distance_to_segment(p: Vec2, a: Vec2, b: Vec2) -> f64 {
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let length_sq = dx * dx + dy * dy;
    if length_sq < 1e-12 {
        return hypot(p.x - a.x, p.y - a.y);
    }
    let t = (((p.x - a.x) * dx + (p.y - a.y) * dy) / length_sq).clamp(0.0, 1.0);
    hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_angle_wraps_into_half_open_interval() {
        assert_eq!(normalize_angle(std::f64::consts::PI), std::f64::consts::PI);
        assert_eq!(normalize_angle(-std::f64::consts::PI), std::f64::consts::PI);
        assert!((normalize_angle(3.0 * std::f64::consts::PI) - std::f64::consts::PI).abs() < 1e-12);
    }

    #[test]
    fn quantize_is_symmetric_and_drops_negative_zero() {
        assert_eq!(quantize(0.125, 2), 0.13);
        assert_eq!(quantize(-0.125, 2), -0.13);
        assert_eq!(quantize(-0.001, 2).to_bits(), 0f64.to_bits());
        assert_eq!(quantize(f64::NAN, 3), 0.0);
    }

    #[test]
    fn js_round_ties_toward_positive_infinity() {
        assert_eq!(js_round(-2.5), -2.0);
        assert_eq!(js_round(2.5), 3.0);
        assert_eq!(js_round(0.49999999999999994), 0.0);
    }

    #[test]
    fn obb_overlap_and_separation() {
        let a = Obb {
            center: Vec2::new(0.0, 0.0),
            length_m: 4.0,
            width_m: 2.0,
            heading_rad: 0.0,
        };
        let b = Obb {
            center: Vec2::new(5.0, 0.0),
            length_m: 4.0,
            width_m: 2.0,
            heading_rad: 0.0,
        };
        assert!(!obb_overlap(&a, &b));
        assert!((obb_separation(&a, &b) - 1.0).abs() < 1e-12);
        let c = Obb {
            center: Vec2::new(3.0, 0.0),
            length_m: 4.0,
            width_m: 2.0,
            heading_rad: 0.0,
        };
        assert!(obb_overlap(&a, &c));
        assert_eq!(obb_separation(&a, &c), 0.0);
    }

    #[test]
    fn segment_intersection_parameter() {
        let t = segment_intersection(
            Vec2::new(0.0, 0.0),
            Vec2::new(4.0, 0.0),
            Vec2::new(1.0, -1.0),
            Vec2::new(1.0, 1.0),
        );
        assert_eq!(t, Some(0.25));
        assert_eq!(
            segment_intersection(
                Vec2::new(0.0, 0.0),
                Vec2::new(1.0, 0.0),
                Vec2::new(0.0, 1.0),
                Vec2::new(1.0, 1.0)
            ),
            None
        );
    }

    #[test]
    fn point_in_polygon_ray_cast() {
        let square = [
            Vec2::new(0.0, 0.0),
            Vec2::new(2.0, 0.0),
            Vec2::new(2.0, 2.0),
            Vec2::new(0.0, 2.0),
        ];
        assert!(point_in_polygon(Vec2::new(1.0, 1.0), &square));
        assert!(!point_in_polygon(Vec2::new(3.0, 1.0), &square));
    }
}
