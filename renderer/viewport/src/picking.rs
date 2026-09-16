//! Ray picking against resident map geometry.
//!
//! A hit must be useful to the editor, which means three things beyond "the
//! ray crossed something": a stable id that survives a reload (see
//! `SceneIndex::stable_id`), the renderer-contract layer the hit belongs to,
//! and a world point plus distance in metres. `PickHit`'s field names are the
//! shared `PickResult.hits` shape from `packages/viewer/src/renderer-contract.ts`.

use bevy::camera::primitives::Aabb;
use bevy::math::Vec3;
use bevy::prelude::*;
use serde::{Deserialize, Serialize};

/// Marks a loaded map entity with the identity the editor can hold on to.
#[derive(Component, Debug, Clone)]
pub struct MapEntity {
    pub stable_id: String,
    pub layer: &'static str,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct PickHit {
    pub layer: String,
    pub id: Option<String>,
    #[serde(rename = "distanceM")]
    pub distance_m: f32,
    pub point: [f32; 3],
}

/// Slab test. Returns the entry distance along `direction` (which must be
/// normalized) or `None`. A ray that starts inside the box returns 0.
pub fn ray_aabb(origin: Vec3, direction: Vec3, min: Vec3, max: Vec3) -> Option<f32> {
    let mut near: f32 = 0.0;
    let mut far: f32 = f32::INFINITY;
    for axis in 0..3 {
        let o = origin[axis];
        let d = direction[axis];
        if d.abs() < f32::EPSILON {
            if o < min[axis] || o > max[axis] {
                return None;
            }
            continue;
        }
        let inv = 1.0 / d;
        let mut a = (min[axis] - o) * inv;
        let mut b = (max[axis] - o) * inv;
        if a > b {
            std::mem::swap(&mut a, &mut b);
        }
        near = near.max(a);
        far = far.min(b);
        if near > far {
            return None;
        }
    }
    (far >= 0.0).then_some(near.max(0.0))
}

/// Collect hits, nearest first, restricted to `layers` (empty means all).
pub fn hits<'a>(
    origin: Vec3,
    direction: Vec3,
    layers: &[String],
    max_hits: usize,
    candidates: impl Iterator<Item = (&'a MapEntity, &'a Aabb, &'a GlobalTransform)>,
) -> Vec<PickHit> {
    let direction = direction.normalize_or_zero();
    if direction == Vec3::ZERO {
        return Vec::new();
    }
    let mut hits: Vec<PickHit> = candidates
        .filter(|(entity, _, _)| layers.is_empty() || layers.iter().any(|layer| layer == entity.layer))
        .filter_map(|(entity, aabb, transform)| {
            // Meshes are built in world space by the progressive loader, but
            // the transform is applied anyway so a future instanced entity
            // does not silently pick in the wrong place.
            let center = transform.transform_point(Vec3::from(aabb.center));
            let extents = Vec3::from(transform.affine().matrix3.abs() * aabb.half_extents);
            let distance = ray_aabb(origin, direction, center - extents, center + extents)?;
            Some(PickHit {
                layer: entity.layer.to_owned(),
                id: Some(entity.stable_id.clone()),
                distance_m: distance,
                point: (origin + direction * distance).to_array(),
            })
        })
        .collect();
    hits.sort_by(|left, right| left.distance_m.total_cmp(&right.distance_m));
    hits.truncate(max_hits.max(1));
    hits
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ray_hit_matches_shared_pick_shape() {
        let distance = ray_aabb(Vec3::new(0.0, 1.0, 5.0), Vec3::NEG_Z, Vec3::splat(-1.0), Vec3::splat(1.0)).unwrap();
        let hit = PickHit {
            layer: "ground".into(),
            id: None,
            distance_m: distance,
            point: [0.0, 1.0, 1.0],
        };
        assert_eq!(hit.layer, "ground");
        assert_eq!(hit.id, None);
        assert_eq!(hit.distance_m, 4.0);
        assert_eq!(serde_json::to_value(hit).unwrap()["distanceM"], 4.0);
    }

    #[test]
    fn misses_and_backwards_rays_produce_no_hit() {
        assert_eq!(
            ray_aabb(Vec3::new(5.0, 5.0, 5.0), Vec3::Y, Vec3::splat(-1.0), Vec3::splat(1.0)),
            None
        );
        // Box behind the origin.
        assert_eq!(
            ray_aabb(Vec3::new(0.0, 0.0, 5.0), Vec3::Z, Vec3::splat(-1.0), Vec3::splat(1.0)),
            None
        );
        // Starting inside the box is a zero-distance hit, not a miss.
        assert_eq!(
            ray_aabb(Vec3::ZERO, Vec3::Z, Vec3::splat(-1.0), Vec3::splat(1.0)),
            Some(0.0)
        );
    }

    #[test]
    fn hits_carry_stable_ids_sorted_by_distance_and_filtered_by_layer() {
        let near = MapEntity { stable_id: "map-static:1:Post".to_owned(), layer: "map-static" };
        let far = MapEntity { stable_id: "ground:2:Slab".to_owned(), layer: "ground" };
        let near_aabb = Aabb::from_min_max(Vec3::new(-1.0, -1.0, -3.0), Vec3::new(1.0, 1.0, -1.0));
        let far_aabb = Aabb::from_min_max(Vec3::new(-10.0, -1.0, -30.0), Vec3::new(10.0, 1.0, -20.0));
        let transform = GlobalTransform::IDENTITY;
        let collected = hits(
            Vec3::ZERO,
            Vec3::NEG_Z,
            &[],
            8,
            [(&near, &near_aabb, &transform), (&far, &far_aabb, &transform)].into_iter(),
        );
        assert_eq!(collected.len(), 2);
        assert_eq!(collected[0].id.as_deref(), Some("map-static:1:Post"));
        assert_eq!(collected[0].distance_m, 1.0);
        assert_eq!(collected[0].point, [0.0, 0.0, -1.0]);
        assert_eq!(collected[1].distance_m, 20.0);

        let ground_only = hits(
            Vec3::ZERO,
            Vec3::NEG_Z,
            &["ground".to_owned()],
            8,
            [(&near, &near_aabb, &transform), (&far, &far_aabb, &transform)].into_iter(),
        );
        assert_eq!(ground_only.len(), 1);
        assert_eq!(ground_only[0].layer, "ground");

        // maxHits truncates after sorting, so it keeps the nearest.
        let one = hits(
            Vec3::ZERO,
            Vec3::NEG_Z,
            &[],
            1,
            [(&far, &far_aabb, &transform), (&near, &near_aabb, &transform)].into_iter(),
        );
        assert_eq!(one.len(), 1);
        assert_eq!(one[0].id.as_deref(), Some("map-static:1:Post"));
    }

    #[test]
    fn a_scaled_transform_moves_the_hit() {
        let entity = MapEntity { stable_id: "map-static:3:Box".to_owned(), layer: "map-static" };
        let aabb = Aabb::from_min_max(Vec3::splat(-1.0), Vec3::splat(1.0));
        let transform = GlobalTransform::from(
            Transform::from_xyz(0.0, 0.0, -10.0).with_scale(Vec3::splat(2.0)),
        );
        let collected = hits(Vec3::ZERO, Vec3::NEG_Z, &[], 8, [(&entity, &aabb, &transform)].into_iter());
        // Centre at -10 with half-extent 2 after scaling: entry at 8 m.
        assert_eq!(collected[0].distance_m, 8.0);
    }
}
