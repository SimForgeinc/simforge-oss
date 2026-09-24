//! One directional cascade set for a whole camera rig.
//!
//! Bevy fits every camera its own cascades and renders them: a rig of eight
//! views pays 8 × 4 directional shadow passes per frame, each re-drawing
//! every caster in its slice. On a vegetation-heavy map that is the single
//! largest GPU cost of the frame (Belmont: about 55% of an eight-camera
//! cinematic render on an RTX 3080).
//!
//! In shared mode each cascade is fitted to the *union* of the marked
//! views' frustum slices (the same near/far split per cascade), so every
//! view's slice stays covered, rear-facing views included. Every view then
//! samples the same cascade transforms, and only the first marked view
//! (lowest camera order) keeps its shadow views: it renders the four
//! cascades into the shared directional shadow atlas once, before any
//! marked view's main passes read it. The other views' shadow views are
//! dropped in the render world.
//!
//! The cascade centre is snapped to the cascade's texel grid, and the
//! diameter is rounded up to whole metres, so the atlas does not shimmer as
//! the rig translates. For seven 120-degree cameras around a vehicle the
//! union's texels are about 25% larger than one camera's own fit (the
//! wide wedge of one view is nearly as large as the disc around all of
//! them), so shared mode wants 1.25x the per-view atlas; atlas sizes are
//! powers of two (Bevy rounds others up), so the presets use 4096 to keep at
//! least the per-view texel density. Narrow presentation views (a
//! trailing chase) should stay unmarked and keep their own tight fit.
//!
//! Bevy renders each view's cascades into array layers 0..n of one atlas,
//! immediately before that view's passes, so the atlas holds the most
//! recent writer's cascades. Suppression is therefore only applied to
//! marked views that no unmarked shadow-rendering view precedes (in camera
//! order) since the first marked view: interleaving an unmarked view keeps
//! the output correct and only forfeits the saving.
//!
//! This originated in the retired sensor-capture harness
//! (TICK-LATENCY-REPORT.md); it is keyed on an explicit per-view marker.
use bevy::camera::visibility::RenderLayers;
use bevy::light::{
    CascadeShadowConfig, Cascades, DirectionalLight, DirectionalLightShadowMap,
    SimulationLightSystems,
};
use bevy::prelude::*;
use bevy::render::camera::ExtractedCamera;
use bevy::render::extract_component::{ExtractComponent, ExtractComponentPlugin};
use bevy::render::{Render, RenderApp, RenderSystems};

/// Marks a camera whose directional cascades are fitted to, and rendered
/// once for, the union of all marked cameras.
#[derive(Component, Clone, Copy, Debug, Default, ExtractComponent)]
pub struct SharedShadowView;

/// Install the cascade union (main world) and the duplicate-pass
/// suppression (render world). Harmless when no camera is marked.
pub struct SharedShadowsPlugin;

impl Plugin for SharedShadowsPlugin {
    fn build(&self, app: &mut App) {
        app.add_plugins(ExtractComponentPlugin::<SharedShadowView>::default())
            .add_systems(
                PostUpdate,
                union_cascades
                    .after(SimulationLightSystems::UpdateDirectionalLightCascades)
                    .before(SimulationLightSystems::UpdateLightFrusta),
            );
        app.sub_app_mut(RenderApp).add_systems(
            Render,
            suppress_duplicate_passes
                .after(RenderSystems::CreateViews)
                .before(RenderSystems::Queue),
        );
    }
}

/// The cascades for `bounds` over the union of the given camera frusta, in
/// light space. `None` when no camera contributes (nothing to fit).
pub fn union_cascades_for(
    world_from_light: Mat4,
    config: &CascadeShadowConfig,
    map_size: usize,
    cameras: &[(Mat4, Projection)],
) -> Option<Vec<bevy::light::cascade::Cascade>> {
    if cameras.is_empty() {
        return None;
    }
    let light_from_world = world_from_light.inverse();
    let mut shared = Vec::with_capacity(config.bounds.len());
    let mut near = config.minimum_distance;
    for &far in &config.bounds {
        let mut min = Vec3::splat(f32::INFINITY);
        let mut max = Vec3::splat(f32::NEG_INFINITY);
        for (world_from_camera, projection) in cameras {
            let light_from_camera = light_from_world * *world_from_camera;
            for corner in projection.get_frustum_corners(-near, -far) {
                let p = light_from_camera.transform_point3(Vec3::from(corner));
                min = min.min(p);
                max = max.max(p);
            }
        }
        if !min.is_finite() || !max.is_finite() {
            return None;
        }
        // Two guard texels cover rounding the centre down to the texel grid.
        let diameter = (max.x - min.x).max(max.y - min.y).ceil() / (1.0 - 2.0 / map_size as f32);
        let texel_size = diameter / map_size as f32;
        let center = Vec3::new(
            ((min.x + max.x) * 0.5 / texel_size).floor() * texel_size,
            ((min.y + max.y) * 0.5 / texel_size).floor() * texel_size,
            max.z,
        );
        let cascade_from_world = Mat4::from_cols(
            light_from_world.x_axis,
            light_from_world.y_axis,
            light_from_world.z_axis,
            (-center).extend(1.0),
        );
        let world_from_cascade = Mat4::from_cols(
            world_from_light.x_axis,
            world_from_light.y_axis,
            world_from_light.z_axis,
            world_from_light * center.extend(1.0),
        );
        let clip_from_cascade = Mat4::from_cols(
            Vec4::new(2.0 / diameter, 0.0, 0.0, 0.0),
            Vec4::new(0.0, 2.0 / diameter, 0.0, 0.0),
            Vec4::new(0.0, 0.0, (max.z - min.z).recip(), 0.0),
            Vec4::new(0.0, 0.0, 1.0, 1.0),
        );
        shared.push(bevy::light::cascade::Cascade {
            world_from_cascade,
            clip_from_cascade,
            clip_from_world: clip_from_cascade * cascade_from_world,
            texel_size,
        });
        near = far * (1.0 - config.overlap_proportion);
    }
    Some(shared)
}

fn union_cascades(
    map: Res<DirectionalLightShadowMap>,
    cameras: Query<
        (
            &GlobalTransform,
            &Projection,
            &Camera,
            Option<&RenderLayers>,
        ),
        With<SharedShadowView>,
    >,
    mut lights: Query<
        (
            &GlobalTransform,
            &CascadeShadowConfig,
            &mut Cascades,
            Option<&RenderLayers>,
        ),
        With<DirectionalLight>,
    >,
) {
    for (light, config, mut cascades, light_layers) in &mut lights {
        if cascades.cascades.is_empty() {
            continue;
        }
        // fallback-ok: an entity without RenderLayers is on layer 0 (Bevy's definition)
        let light_layers = light_layers.cloned().unwrap_or_default();
        let views: Vec<(Mat4, Projection)> = cameras
            .iter()
            .filter(|(_, _, camera, layers)| {
                // fallback-ok: an entity without RenderLayers is on layer 0 (Bevy's definition)
                camera.is_active
                    && layers
                        .cloned()
                        .unwrap_or_default()
                        .intersects(&light_layers)
            })
            .map(|(transform, projection, _, _)| (transform.to_matrix(), projection.clone()))
            .collect();
        // The light's orientation only: cascade space is light space
        // translated to each cascade's centre.
        let world_from_light = Mat4::from_quat(light.rotation());
        let Some(shared) = union_cascades_for(world_from_light, config, map.size, &views) else {
            continue;
        };
        if shared.len() != config.bounds.len() {
            continue;
        }
        let marked: Vec<Entity> = cascades.cascades.keys().copied().collect();
        for view in marked {
            if cameras.get(view).is_ok() {
                if let Some(slot) = cascades.cascades.get_mut(&view) {
                    slot.clone_from(&shared);
                }
            }
        }
    }
}

/// Keep the shadow views of the first marked camera only. Every marked
/// view's light uniforms reference the same atlas layers and identical
/// cascade transforms, so the other views would re-render identical maps.
fn suppress_duplicate_passes(
    mut views: Query<(
        &ExtractedCamera,
        &mut bevy::pbr::ViewLightEntities,
        Has<SharedShadowView>,
    )>,
) {
    let mut order: Vec<(isize, bool, bool)> = views
        .iter()
        .map(|(camera, lights, marked)| (camera.order, marked, !lights.lights.is_empty()))
        .collect();
    order.sort_by_key(|(order, _, _)| *order);
    let keep = suppressible(&order);
    if std::env::var_os("SIMFORGE_DEBUG_SHARED_SHADOWS").is_some() {
        eprintln!("shared-shadows: views {order:?} suppress {keep:?}");
    }
    for (camera, mut lights, marked) in &mut views {
        if marked && keep.contains(&camera.order) && !lights.lights.is_empty() {
            lights.lights.clear();
        }
    }
}

/// Camera orders of marked views whose shadow views can be dropped, given
/// every view as `(order, marked, renders_shadows)` sorted by order: each
/// marked view after the first marked shadow renderer, up to the first
/// unmarked shadow renderer (which overwrites the atlas).
fn suppressible(views: &[(isize, bool, bool)]) -> Vec<isize> {
    let mut out = Vec::new();
    let mut seen_first = false;
    for &(order, marked, renders) in views {
        if !renders {
            continue;
        }
        match (marked, seen_first) {
            (true, false) => seen_first = true,
            (true, true) => out.push(order),
            (false, true) => break,
            (false, false) => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suppression_stops_at_an_interleaved_unmarked_view() {
        // chase (unmarked) first, then the marked rig: all but the first
        // marked view drop their passes.
        let v = [
            (0, false, true),
            (10, true, true),
            (20, true, true),
            (30, true, true),
        ];
        assert_eq!(suppressible(&v), vec![20, 30]);
        // an unmarked renderer in the middle rewrites the atlas: the views
        // after it must render their own (identical) cascades again.
        let v = [
            (0, true, true),
            (10, true, true),
            (20, false, true),
            (30, true, true),
        ];
        assert_eq!(suppressible(&v), vec![10]);
        // views that render no shadows (ID views) do not interrupt a run.
        let v = [(0, true, true), (5, false, false), (10, true, true)];
        assert_eq!(suppressible(&v), vec![10]);
    }

    fn camera_at(yaw_deg: f32) -> (Mat4, Projection) {
        let transform = Transform::from_xyz(0.0, 2.0, 0.0)
            .with_rotation(Quat::from_rotation_y(yaw_deg.to_radians()));
        (
            transform.to_matrix(),
            Projection::Perspective(PerspectiveProjection {
                fov: 88.5f32.to_radians(),
                aspect_ratio: 16.0 / 9.0,
                near: 0.05,
                far: 1000.0,
                ..Default::default()
            }),
        )
    }

    fn config() -> CascadeShadowConfig {
        bevy::light::cascade::CascadeShadowConfigBuilder {
            minimum_distance: 1.0,
            maximum_distance: 400.0,
            num_cascades: 4,
            ..Default::default()
        }
        .build()
    }

    /// Every corner of every contributing frustum slice lands inside its
    /// shared cascade's clip volume: no view loses coverage.
    #[test]
    fn union_covers_every_view_slice() {
        let world_from_light = Transform::default()
            .looking_to(Vec3::new(0.3, -0.9, 0.2).normalize(), Vec3::Y)
            .to_matrix();
        let rig: Vec<_> = [0.0, 50.0, -50.0, 90.0, -90.0, 140.0, -140.0, 180.0]
            .iter()
            .map(|y| camera_at(*y))
            .collect();
        let config = config();
        let cascades = union_cascades_for(world_from_light, &config, 2048, &rig).unwrap();
        assert_eq!(cascades.len(), 4);
        let mut near = config.minimum_distance;
        for (cascade, &far) in cascades.iter().zip(&config.bounds) {
            for (world_from_camera, projection) in &rig {
                for corner in projection.get_frustum_corners(-near, -far) {
                    let world = world_from_camera.transform_point3(Vec3::from(corner));
                    let clip = cascade.clip_from_world.project_point3(world);
                    assert!(
                        clip.x.abs() <= 1.0 + 1e-4 && clip.y.abs() <= 1.0 + 1e-4,
                        "{clip:?}"
                    );
                    assert!((-1e-3..=1.0 + 1e-3).contains(&clip.z), "{clip:?}");
                }
            }
            near = far * (1.0 - config.overlap_proportion);
        }
    }

    /// Translating the rig by less than a texel leaves the cascade centre on
    /// the same texel grid point (no shimmer from sub-texel motion).
    #[test]
    fn cascade_centre_is_texel_snapped() {
        let world_from_light = Transform::default()
            .looking_to(Vec3::new(0.0, -1.0, 0.001).normalize(), Vec3::Y)
            .to_matrix();
        let config = config();
        let a = union_cascades_for(world_from_light, &config, 2048, &[camera_at(0.0)]).unwrap();
        for cascade in &a {
            let origin = cascade.world_from_cascade.w_axis.truncate();
            let light_space = world_from_light.inverse().transform_point3(origin);
            let texels = light_space.truncate() / cascade.texel_size;
            assert!(
                (texels - texels.round()).abs().max_element() < 1e-2,
                "{texels:?}"
            );
        }
    }

    /// For the production rig (seven 120-degree cameras around the host) the
    /// union's texel size stays within 30% of a single forward camera's own
    /// fit, cascade by cascade: the wide wedge of one view is nearly as
    /// large as the disc around all of them.
    #[test]
    fn wide_rig_union_stays_within_thirty_percent_of_one_wide_view() {
        let world_from_light = Transform::default()
            .looking_to(Vec3::new(0.2, -0.95, 0.1).normalize(), Vec3::Y)
            .to_matrix();
        let config = config();
        let single =
            union_cascades_for(world_from_light, &config, 2048, &[camera_at(0.0)]).unwrap();
        let rig: Vec<_> = [0.0, 50.0, -50.0, 90.0, -90.0, 140.0, -140.0]
            .iter()
            .map(|y| camera_at(*y))
            .collect();
        let union = union_cascades_for(world_from_light, &config, 2048, &rig).unwrap();
        let ratios: Vec<f32> = single
            .iter()
            .zip(&union)
            .map(|(one, all)| all.texel_size / one.texel_size)
            .collect();
        eprintln!("union/single texel ratio per cascade: {ratios:?}");
        for ratio in ratios {
            assert!(ratio <= 1.3, "{ratio}");
        }
    }
}
