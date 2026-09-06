//! Static collision geometry: map proxies and collidable fixed props, indexed
//! on a uniform grid once at construction. Shared across worlds by value
//! (immutable after build).

use serde::{Deserialize, Serialize};

use crate::math::{obb_corners, Obb, SceneXZ, Vec2};
use crate::types::StaticProp;

use super::spatial::point_cell;

/// Lightweight, renderer-independent map collision geometry.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum StaticColliderClass {
    Building,
    Wall,
    Barrier,
    Prop,
    RoadBoundary,
}

/// Scene-frame OBB (`x/z`, y-up), matching scenario poses.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneObb {
    pub center: SceneXZ,
    pub length_m: f64,
    pub width_m: f64,
    pub heading_rad: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StaticMapCollider {
    /// Stable within a map. The engine exposes contacts as `map:<id>`.
    pub id: String,
    pub class: StaticColliderClass,
    pub obb: SceneObb,
}

/// Uniform-grid size; larger than ordinary road-user footprints and one tick's motion.
pub const COLLISION_GRID_CELL_M: f64 = 20.0;

#[derive(Debug, Clone, PartialEq)]
pub struct StaticCollisionShape {
    /// Namespaced collision id: `prop:<id>` or `map:<id>`.
    pub id: String,
    pub obb: Obb,
    pub corners: [Vec2; 4],
}

/// Immutable static collision resources for one world layout.
#[derive(Debug, Clone, Default)]
pub struct StaticCollisionResources {
    /// Sorted by id.
    shapes: Vec<StaticCollisionShape>,
    /// `(cell x, cell y, shape index)` sorted.
    grid: Vec<(i32, i32, u32)>,
}

impl StaticCollisionResources {
    /// Collidable, unattached props in the `prop:` namespace plus map proxies
    /// in the `map:` namespace.
    pub fn build(props: &[StaticProp], map_colliders: &[StaticMapCollider]) -> Self {
        let mut shapes: Vec<StaticCollisionShape> = props
            .iter()
            .filter(|p| p.collidable && p.attachment.is_none())
            .map(|p| {
                let obb = Obb {
                    center: p.pose.position_local(),
                    length_m: p.dims.l * p.scale,
                    width_m: p.dims.w * p.scale,
                    heading_rad: p.pose.heading_rad,
                };
                StaticCollisionShape {
                    id: format!("prop:{}", p.id),
                    obb,
                    corners: obb_corners(&obb),
                }
            })
            .collect();
        let mut sorted_map: Vec<&StaticMapCollider> = map_colliders.iter().collect();
        sorted_map.sort_by(|a, b| crate::hash::cmp_locale(&a.id, &b.id));
        for c in sorted_map {
            let obb = Obb {
                center: crate::math::local_from_scene(c.obb.center),
                length_m: c.obb.length_m,
                width_m: c.obb.width_m,
                heading_rad: c.obb.heading_rad,
            };
            shapes.push(StaticCollisionShape {
                id: format!("map:{}", c.id),
                obb,
                corners: obb_corners(&obb),
            });
        }
        // Slot order is the contact order handed to the solver; the reference
        // sorts candidates with `localeCompare`.
        shapes.sort_by(|a, b| crate::hash::cmp_locale(&a.id, &b.id));
        let mut grid: Vec<(i32, i32, u32)> = Vec::new();
        for (index, shape) in shapes.iter().enumerate() {
            let (mut min_x, mut min_y, mut max_x, mut max_y) = (
                f64::INFINITY,
                f64::INFINITY,
                f64::NEG_INFINITY,
                f64::NEG_INFINITY,
            );
            for p in shape.corners {
                min_x = min_x.min(p.x);
                min_y = min_y.min(p.y);
                max_x = max_x.max(p.x);
                max_y = max_y.max(p.y);
            }
            let (x0, y0) = point_cell(min_x, min_y, COLLISION_GRID_CELL_M);
            let (x1, y1) = point_cell(max_x, max_y, COLLISION_GRID_CELL_M);
            for x in x0..=x1 {
                for y in y0..=y1 {
                    grid.push((x, y, index as u32));
                }
            }
        }
        grid.sort_unstable();
        Self { shapes, grid }
    }

    #[inline]
    pub fn shapes(&self) -> &[StaticCollisionShape] {
        &self.shapes
    }

    #[inline]
    pub fn shape(&self, slot: u32) -> &StaticCollisionShape {
        &self.shapes[slot as usize]
    }

    pub fn slot_of(&self, id: &str) -> Option<u32> {
        self.shapes
            .binary_search_by(|s| crate::hash::cmp_locale(s.id.as_str(), id))
            .ok()
            .map(|i| i as u32)
    }

    /// Shape slots whose grid cells intersect the AABB. `out` is cleared,
    /// filled sorted and deduplicated.
    pub fn candidates(&self, min_x: f64, min_y: f64, max_x: f64, max_y: f64, out: &mut Vec<u32>) {
        out.clear();
        if self.grid.is_empty()
            || !(min_x.is_finite() && min_y.is_finite() && max_x.is_finite() && max_y.is_finite())
        {
            return;
        }
        let (x0, y0) = point_cell(min_x, min_y, COLLISION_GRID_CELL_M);
        let (x1, y1) = point_cell(max_x, max_y, COLLISION_GRID_CELL_M);
        for x in x0..=x1 {
            for y in y0..=y1 {
                let start = self.grid.partition_point(|e| (e.0, e.1) < (x, y));
                let mut i = start;
                while i < self.grid.len() && self.grid[i].0 == x && self.grid[i].1 == y {
                    out.push(self.grid[i].2);
                    i += 1;
                }
            }
        }
        out.sort_unstable();
        out.dedup();
    }
}
