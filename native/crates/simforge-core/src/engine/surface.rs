//! Localised surface conditions: grip as a *field* over the road rather than
//! one number for the whole scene. A patch is a `Region` (the same vocabulary
//! `reaches` uses); `kind` carries the coefficient; edges may taper.
//!
//! Overlaps resolve by **largest deviation from the baseline**, tie-broken by
//! the lower friction and then by patch id, so the result is order-independent
//! and a `grit_treated` strip through a snowfield behaves as grit.

use crate::map::LaneId;
use crate::math::{distance_to_segment, hypot, point_in_polygon, Vec2};
use crate::types::{Region, SurfacePatch};

/// Where an actor is, in the two terms a region can be expressed in.
#[derive(Debug, Clone, Copy)]
pub struct SurfaceQuery {
    pub position: Vec2,
    /// Lane identity and traversal-direction lane `s`; `None` for freeform routes.
    pub lane: Option<(LaneId, f64)>,
}

/// The resolved surface under one actor on one tick.
#[derive(Debug, Clone, PartialEq)]
pub struct SurfaceSample<'a> {
    pub friction_scale: f64,
    /// Patches covering the query point, worst-deviating first.
    pub patch_ids: Vec<&'a str>,
}

#[derive(Debug, Clone)]
struct ResolvedPatch {
    id: String,
    scale: f64,
    edge_taper_m: f64,
    region: ResolvedRegion,
}

#[derive(Debug, Clone)]
enum ResolvedRegion {
    Circle {
        center: Vec2,
        radius_m: f64,
    },
    Polygon {
        points: Vec<Vec2>,
    },
    /// `None` lane means the window names a lane absent from the graph and can
    /// never contain anyone.
    LaneWindow {
        lane: Option<LaneId>,
        s_min: f64,
        s_max: f64,
    },
}

/// Signed containment depth, metres: positive inside, negative outside.
fn containment_depth_m(region: &ResolvedRegion, q: &SurfaceQuery) -> f64 {
    match region {
        ResolvedRegion::Circle { center, radius_m } => {
            radius_m - hypot(q.position.x - center.x, q.position.y - center.y)
        }
        ResolvedRegion::Polygon { points } => {
            let inside = point_in_polygon(q.position, points);
            let mut nearest = f64::INFINITY;
            for i in 0..points.len() {
                let a = points[i];
                let b = points[(i + 1) % points.len()];
                nearest = nearest.min(distance_to_segment(q.position, a, b));
            }
            if inside {
                nearest
            } else {
                -nearest
            }
        }
        ResolvedRegion::LaneWindow { lane, s_min, s_max } => match (q.lane, lane) {
            (Some((actor_lane, lane_s)), Some(window_lane)) if actor_lane == *window_lane => {
                (lane_s - s_min).min(s_max - lane_s)
            }
            _ => f64::NEG_INFINITY,
        },
    }
}

/// The grip field for one episode.
#[derive(Debug, Clone)]
pub struct SurfaceField {
    baseline_friction_scale: f64,
    patches: Vec<ResolvedPatch>,
}

impl SurfaceField {
    /// `lane_id` resolves lane-window regions once, at construction.
    pub fn new(
        baseline_friction_scale: f64,
        patches: &[SurfacePatch],
        mut lane_id: impl FnMut(&str) -> Option<LaneId>,
    ) -> Self {
        let mut resolved: Vec<ResolvedPatch> = patches
            .iter()
            .map(|patch| ResolvedPatch {
                id: patch.id.clone(),
                scale: patch.effective_friction_scale(),
                edge_taper_m: patch.edge_taper_m,
                region: match &patch.region {
                    Region::Circle { center, radius_m } => ResolvedRegion::Circle {
                        center: center.to_local(),
                        radius_m: *radius_m,
                    },
                    Region::Polygon { points } => ResolvedRegion::Polygon {
                        points: points.iter().map(|p| p.to_local()).collect(),
                    },
                    Region::LaneWindow { rsl, s_min, s_max } => ResolvedRegion::LaneWindow {
                        lane: lane_id(rsl),
                        s_min: *s_min,
                        s_max: *s_max,
                    },
                },
            })
            .collect();
        resolved.sort_by(|a, b| a.id.cmp(&b.id));
        Self {
            baseline_friction_scale,
            patches: resolved,
        }
    }

    #[inline]
    pub fn baseline_friction_scale(&self) -> f64 {
        self.baseline_friction_scale
    }

    /// True when the field is the baseline everywhere and may be short-circuited.
    #[inline]
    pub fn is_uniform(&self) -> bool {
        self.patches.is_empty()
    }

    /// The worst grip anywhere in the field.
    pub fn worst_friction_scale(&self) -> f64 {
        self.patches
            .iter()
            .fold(self.baseline_friction_scale, |w, p| w.min(p.scale))
    }

    pub fn ids(&self) -> impl Iterator<Item = &str> {
        self.patches.iter().map(|p| p.id.as_str())
    }

    /// Effective grip multiplier at a query point; allocation-free.
    pub fn friction_scale_at(&self, q: &SurfaceQuery) -> f64 {
        if self.patches.is_empty() {
            return self.baseline_friction_scale;
        }
        // (deviation desc, scale asc, id asc) — evaluated without collecting.
        let mut best: Option<(f64, f64, &str)> = None;
        for patch in &self.patches {
            let depth = containment_depth_m(&patch.region, q);
            if depth <= 0.0 {
                continue;
            }
            let weight = if patch.edge_taper_m > 0.0 {
                (depth / patch.edge_taper_m).min(1.0)
            } else {
                1.0
            };
            let scale = self.baseline_friction_scale
                + (patch.scale - self.baseline_friction_scale) * weight;
            let deviation = (scale - self.baseline_friction_scale).abs();
            let better = match best {
                None => true,
                Some((bd, bs, bid)) => {
                    deviation > bd
                        || (deviation == bd
                            && (scale < bs || (scale == bs && patch.id.as_str() < bid)))
                }
            };
            if better {
                best = Some((deviation, scale, patch.id.as_str()));
            }
        }
        best.map_or(self.baseline_friction_scale, |(_, s, _)| s)
    }

    /// Full resolution at a query point: the effective scale and what produced it.
    pub fn sample_at(&self, q: &SurfaceQuery) -> SurfaceSample<'_> {
        if self.patches.is_empty() {
            return SurfaceSample {
                friction_scale: self.baseline_friction_scale,
                patch_ids: Vec::new(),
            };
        }
        let mut covering: Vec<(&str, f64, f64)> = Vec::new();
        for patch in &self.patches {
            let depth = containment_depth_m(&patch.region, q);
            if depth <= 0.0 {
                continue;
            }
            let weight = if patch.edge_taper_m > 0.0 {
                (depth / patch.edge_taper_m).min(1.0)
            } else {
                1.0
            };
            let scale = self.baseline_friction_scale
                + (patch.scale - self.baseline_friction_scale) * weight;
            covering.push((
                patch.id.as_str(),
                scale,
                (scale - self.baseline_friction_scale).abs(),
            ));
        }
        if covering.is_empty() {
            return SurfaceSample {
                friction_scale: self.baseline_friction_scale,
                patch_ids: Vec::new(),
            };
        }
        covering.sort_by(|a, b| {
            b.2.partial_cmp(&a.2)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
                .then(a.0.cmp(b.0))
        });
        SurfaceSample {
            friction_scale: covering[0].1,
            patch_ids: covering.iter().map(|c| c.0).collect(),
        }
    }
}
