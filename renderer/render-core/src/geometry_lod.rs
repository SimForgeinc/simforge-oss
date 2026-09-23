//! Distance LODs for the static map from the map's `derived/geometry-lod`
//! derivative (schema `simforge.map-geometry-lod.v1`, built at map ingest).
//!
//! The derivative supplies, per heavy master mesh, a chain of lighter
//! versions of the *same* primitives (same vertex layout, so no new
//! pipelines) and optionally a cross-card impostor, each with an object-space
//! geometric error. At readiness every master primitive entity gets sibling
//! entities for its levels, and every one of them (master included) a
//! [`VisibilityRange`] so that, per view, exactly one level draws:
//!
//! ```text
//! level L draws while  d_L <= distance < d_{L+1},   d_L = e_L * s * f_px / px
//! ```
//!
//! with `e_L` the level's geometric error, `s` the instance's largest axis
//! scale, `f_px` the focal length in pixels of the most demanding RGB camera
//! of the rig and `px` the pixel-error budget (1 by default). Ranges are
//! abrupt (no dithered cross-fade), so a frame is a pure function of the
//! camera pose: deterministic, with a bounded, documented error. Distance is
//! measured, as the manifest defines it, to the world-space centre of the
//! mesh's bounding sphere: every chain member (RGB and ID) carries that
//! sphere's box as its `Aabb` (with `NoAutoAabb`) and ranges use it
//! (`use_aabb`), so all primitives of a node switch together. The box is
//! also a conservative frustum-culling bound.
//!
//! The ID pass clones every level with the master's ID material and the same
//! ranges, so the instance-ID and semantic outputs switch with RGB. The
//! lidar/radar scene is built from the masters only (full detail, see
//! `SceneApp::static_sensor_meshes`): level entities carry no `InstanceId`.
use anyhow::{Context, Result};
use bevy::camera::visibility::{RenderLayers, VisibilityRange};
use bevy::gltf::Gltf;
use bevy::light::NotShadowCaster;
use bevy::prelude::*;
use std::collections::HashMap;

/// Pixel-error budget of a level switch (the derivative's own default).
pub const DEFAULT_PIXEL_ERROR_PX: f32 = 1.0;

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub schema: String,
    pub meshes: Vec<ManifestMesh>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestMesh {
    pub mesh: u32,
    pub name: String,
    /// Mesh-local bounding sphere; its world centre is where the selection
    /// distance is measured to.
    pub bounds: ManifestBounds,
    pub levels: Vec<ManifestLevel>,
    #[serde(default)]
    pub impostor: Option<ManifestImpostor>,
}

#[derive(Debug, Clone, Copy, serde::Deserialize)]
pub struct ManifestBounds {
    pub center: [f32; 3],
    pub radius: f32,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestLevel {
    pub level: u32,
    pub lod_mesh: u32,
    pub geometric_error_m: f32,
    pub triangles: u64,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestImpostor {
    pub lod_mesh: u32,
    pub geometric_error_m: f32,
    pub material: u32,
    #[serde(default = "yes")]
    pub casts_shadow: bool,
}

fn yes() -> bool {
    true
}

impl Manifest {
    pub fn load(path: &std::path::Path) -> Result<Self> {
        let manifest: Manifest = serde_json::from_slice(
            &std::fs::read(path).with_context(|| format!("read geometry LOD manifest {}", path.display()))?,
        )
        .with_context(|| format!("parse geometry LOD manifest {}", path.display()))?;
        anyhow::ensure!(
            manifest.schema == "simforge.map-geometry-lod.v1",
            "geometry LOD manifest {} has schema {:?}, expected simforge.map-geometry-lod.v1",
            path.display(),
            manifest.schema
        );
        for mesh in &manifest.meshes {
            let mut previous = 0.0f32;
            for level in &mesh.levels {
                anyhow::ensure!(
                    level.geometric_error_m > previous,
                    "geometry LOD mesh {} ({}): level {} error {} is not above the previous {previous}",
                    mesh.mesh,
                    mesh.name,
                    level.level,
                    level.geometric_error_m
                );
                previous = level.geometric_error_m;
            }
            if let Some(impostor) = &mesh.impostor {
                anyhow::ensure!(
                    impostor.geometric_error_m > previous,
                    "geometry LOD mesh {} ({}): impostor error {} is not above the last level's {previous}",
                    mesh.mesh,
                    mesh.name,
                    impostor.geometric_error_m
                );
            }
        }
        Ok(manifest)
    }
}

/// A LOD chain being loaded or applied.
pub(crate) struct GeometryLods {
    pub manifest: Manifest,
    /// Asset path of `lod.gltf` (sub-assets are `#Mesh{K}/Primitive{j}`).
    pub lod_path: String,
    /// Asset path of the master glTF the manifest indexes.
    pub master_path: String,
    pub lod_gltf: Handle<Gltf>,
    pub pixel_error_px: f32,
    /// Focal length (px) the current ranges were computed for.
    pub applied_f_px: Option<f32>,
}

/// One entity of a LOD chain: the master primitive (level 0), a lighter
/// level or the impostor. `errors[i]` is the switch error at which level i
/// starts (0 for the master); a member draws from its own start to the next.
#[derive(Component, Clone, Debug)]
pub(crate) struct LodMember {
    pub start_error_m: f32,
    pub end_error_m: Option<f32>,
}

/// Parse `Mesh{N}/Primitive{M}` from a sub-asset label.
pub(crate) fn mesh_primitive(label: &str) -> Option<(u32, u32)> {
    let rest = label.strip_prefix("Mesh")?;
    let (mesh, primitive) = rest.split_once("/Primitive")?;
    // fallback-ok: a label that is not Mesh{N}/Primitive{M} names no LOD master
    Some((mesh.parse().ok()?, primitive.parse().ok()?))
}

/// Switch distance of an error `e` for an instance of scale `s`.
pub fn switch_distance(error_m: f32, scale: f32, f_px: f32, pixel_error_px: f32) -> f32 {
    error_m * scale * f_px / pixel_error_px
}

/// Focal length in pixels of a perspective view.
pub fn focal_px(fov_y_rad: f32, height_px: u32) -> f32 {
    height_px as f32 / (2.0 * (fov_y_rad * 0.5).tan())
}

fn range_for(member: &LodMember, scale: f32, f_px: f32, pixel_error_px: f32) -> VisibilityRange {
    let start = switch_distance(member.start_error_m, scale, f_px, pixel_error_px);
    let end = member
        .end_error_m
        .map_or(f32::INFINITY, |error| switch_distance(error, scale, f_px, pixel_error_px));
    VisibilityRange { start_margin: start..start, end_margin: end..end, use_aabb: true }
}

/// The selection bound every chain member carries.
fn bounds_aabb(bounds: &ManifestBounds) -> (bevy::camera::primitives::Aabb, bevy::camera::visibility::NoAutoAabb) {
    let center = Vec3::from_array(bounds.center);
    (
        bevy::camera::primitives::Aabb::from_min_max(center - Vec3::splat(bounds.radius), center + Vec3::splat(bounds.radius)),
        bevy::camera::visibility::NoAutoAabb,
    )
}

/// Spawn the level entities for every master primitive the manifest covers
/// and their ID clones. `id_clones` maps a master primitive entity to its
/// ID-pass clone and ID material. Returns (masters, level entities).
pub(crate) fn spawn_levels(
    world: &mut World,
    lods: &GeometryLods,
    id_clones: &HashMap<Entity, (Entity, Handle<StandardMaterial>)>,
) -> Result<(usize, usize)> {
    let by_mesh: HashMap<u32, &ManifestMesh> = lods.manifest.meshes.iter().map(|m| (m.mesh, m)).collect();
    let prefix = format!("{}#", lods.master_path);
    let mut masters: Vec<(Entity, u32, u32)> = Vec::new();
    {
        let mut query = world.query::<(Entity, &Mesh3d, &crate::engine::InstanceId)>();
        for (entity, mesh, _) in query.iter(world) {
            let Some(path) = mesh.0.path() else { continue }; // fallback-ok: generated meshes are not in the master glTF
            let path = path.to_string();
            let Some(label) = path.strip_prefix(&prefix) else { continue }; // fallback-ok: other files have no LODs
            let Some((mesh_index, primitive)) = mesh_primitive(label) else { continue }; // fallback-ok: non-primitive sub-assets
            if by_mesh.contains_key(&mesh_index) {
                masters.push((entity, mesh_index, primitive));
            }
        }
    }
    // Deterministic spawn order (entity allocation must not depend on ECS
    // iteration order).
    masters.sort_by_key(|(entity, mesh, primitive)| (*mesh, *primitive, entity.to_bits()));
    let asset_server = world.resource::<AssetServer>().clone();
    let mut spawned = 0usize;
    for (master, mesh_index, primitive) in &masters {
        let entry = by_mesh[mesh_index];
        let (material, transform, parent, layers, no_shadow) = {
            let e = world.entity(*master);
            (
                e.get::<MeshMaterial3d<StandardMaterial>>()
                    .with_context(|| format!("LOD master {} has no StandardMaterial", entry.name))?
                    .0
                    .clone(),
                e.get::<Transform>().copied().unwrap_or(Transform::IDENTITY), // fallback-ok: an entity without Transform is at its parent's origin
                e.get::<ChildOf>().map(|c| c.parent()),
                e.get::<RenderLayers>().cloned(),
                e.contains::<NotShadowCaster>(),
            )
        };
        let first_error = entry.levels.first().map(|l| l.geometric_error_m).or(entry.impostor.as_ref().map(|i| i.geometric_error_m));
        let bound = bounds_aabb(&entry.bounds);
        world.entity_mut(*master).insert((LodMember { start_error_m: 0.0, end_error_m: first_error }, bound.clone()));
        if let Some((clone, _)) = id_clones.get(master) {
            world.entity_mut(*clone).insert((LodMember { start_error_m: 0.0, end_error_m: first_error }, bound.clone()));
        }
        let mut chain: Vec<(Handle<Mesh>, Handle<StandardMaterial>, f32, Option<f32>, bool)> = Vec::new();
        for (k, level) in entry.levels.iter().enumerate() {
            let end = entry
                .levels
                .get(k + 1)
                .map(|next| next.geometric_error_m)
                .or(entry.impostor.as_ref().map(|i| i.geometric_error_m));
            chain.push((
                asset_server.load(format!("{}#Mesh{}/Primitive{}", lods.lod_path, level.lod_mesh, primitive)),
                material.clone(),
                level.geometric_error_m,
                end,
                !no_shadow,
            ));
        }
        // The impostor replaces the whole node: spawn it once, with the
        // node's first primitive.
        if let (Some(impostor), 0) = (&entry.impostor, *primitive) {
            chain.push((
                asset_server.load(format!("{}#Mesh{}/Primitive0", lods.lod_path, impostor.lod_mesh)),
                asset_server.load(format!("{}#Material{}", lods.lod_path, impostor.material)),
                impostor.geometric_error_m,
                None,
                impostor.casts_shadow && !no_shadow,
            ));
        }
        for (mesh, level_material, start, end, casts_shadow) in chain {
            let member = LodMember { start_error_m: start, end_error_m: end };
            let mut cmd = world.spawn((Mesh3d(mesh.clone()), MeshMaterial3d(level_material), transform, member.clone(), bound.clone()));
            if let Some(parent) = parent {
                cmd.insert(ChildOf(parent));
            }
            if let Some(layers) = &layers {
                cmd.insert(layers.clone());
            }
            if !casts_shadow {
                cmd.insert(NotShadowCaster);
            }
            spawned += 1;
            if let Some((_, id_material)) = id_clones.get(master) {
                let mut clone = world.spawn((
                    crate::engine::IdClone,
                    Mesh3d(mesh),
                    MeshMaterial3d(id_material.clone()),
                    RenderLayers::layer(1),
                    transform,
                    member,
                    bound.clone(),
                ));
                if let Some(parent) = parent {
                    clone.insert(ChildOf(parent));
                }
            }
        }
    }
    Ok((masters.len(), spawned))
}

/// (Re)compute every chain member's range for focal length `f_px`.
pub(crate) fn apply_ranges(world: &mut World, f_px: f32, pixel_error_px: f32) {
    let mut query = world.query::<(Entity, &LodMember, &GlobalTransform)>();
    let updates: Vec<(Entity, VisibilityRange)> = query
        .iter(world)
        .map(|(entity, member, global)| {
            let (scale, _, _) = global.to_scale_rotation_translation();
            (entity, range_for(member, scale.abs().max_element(), f_px, pixel_error_px))
        })
        .collect();
    for (entity, range) in updates {
        world.entity_mut(entity).insert(range);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_parse_and_ranges_tile_the_distance_axis() {
        assert_eq!(mesh_primitive("Mesh765/Primitive1"), Some((765, 1)));
        assert_eq!(mesh_primitive("Material3"), None);
        // Chain master -> L1 (e=0.08) -> L2 (e=0.2) -> impostor (e=5.5).
        let members = [
            LodMember { start_error_m: 0.0, end_error_m: Some(0.08) },
            LodMember { start_error_m: 0.08, end_error_m: Some(0.2) },
            LodMember { start_error_m: 0.2, end_error_m: Some(5.5) },
            LodMember { start_error_m: 5.5, end_error_m: None },
        ];
        let f_px = focal_px(88.5f32.to_radians(), 720);
        let ranges: Vec<VisibilityRange> = members.iter().map(|m| range_for(m, 0.4, f_px, 1.0)).collect();
        // Every distance is covered by exactly one member.
        for d in [0.0f32, 1.0, 11.0, 12.5, 30.0, 400.0, 1e6] {
            let drawn = ranges.iter().filter(|r| r.is_visible_at_all(d)).count();
            assert_eq!(drawn, 1, "distance {d}");
        }
        // 0.08 m of error at scale 0.4 is one pixel at ~12 m for a 720p 120-degree camera.
        assert!((ranges[0].end_margin.start - 0.08 * 0.4 * f_px).abs() < 1e-3);
        assert!((f_px - 369.9).abs() < 1.0, "{f_px}");
    }
}
