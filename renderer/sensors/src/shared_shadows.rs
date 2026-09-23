//! One directional cascade atlas for the union of the selected camera frusta.
//!
//! This is an explicit quality mode: the same texels cover a larger footprint,
//! but every camera's cascade slice remains covered. Copying a forward camera's
//! cascades to a rear camera would instead silently lose shadow coverage.
use bevy::camera::visibility::RenderLayers;
use bevy::light::{CascadeShadowConfig, Cascades, DirectionalLight, DirectionalLightShadowMap, SimulationLightSystems};
use bevy::prelude::*;
use bevy::render::camera::ExtractedCamera;
use bevy::render::{Render, RenderApp, RenderSystems};

pub(super) fn install(app: &mut App) {
    app.add_systems(PostUpdate, union_cascades
        .after(SimulationLightSystems::UpdateDirectionalLightCascades)
        .before(SimulationLightSystems::UpdateLightFrusta));
    app.sub_app_mut(RenderApp).add_systems(Render, suppress_duplicate_passes
        .after(RenderSystems::CreateViews).before(RenderSystems::Queue));
}

fn union_cascades(
    map: Res<DirectionalLightShadowMap>,
    cameras: Query<(&GlobalTransform, &Projection, &Camera, Option<&RenderLayers>), With<super::SensorCam>>,
    mut lights: Query<(&GlobalTransform, &CascadeShadowConfig, &mut Cascades, Option<&RenderLayers>), With<DirectionalLight>>,
) {
    for (light, config, mut cascades, light_layers) in &mut lights {
        if cascades.cascades.is_empty() { continue; }
        let world_from_light = Mat4::from_quat(light.rotation());
        let light_from_world = world_from_light.transpose();
        let mut shared = Vec::with_capacity(config.bounds.len());
        let mut near = config.minimum_distance;
        for &far in &config.bounds {
            let mut min = Vec3::splat(f32::INFINITY);
            let mut max = Vec3::splat(f32::NEG_INFINITY);
            for (transform, projection, camera, layers) in &cameras {
                if !camera.is_active || !layers.unwrap_or_default().intersects(light_layers.unwrap_or_default()) { continue; } // fallback-ok: Bevy semantics: no RenderLayers component means layer 0
                let light_from_camera = light_from_world * transform.to_matrix();
                for corner in projection.get_frustum_corners(-near, -far) {
                    let p = light_from_camera.transform_point3(Vec3::from(corner));
                    min = min.min(p); max = max.max(p);
                }
            }
            if !min.is_finite() { break; }
            // Two guard texels cover rounding the center down to the texel grid.
            let diameter = (max.x-min.x).max(max.y-min.y).ceil() / (1.0-2.0/map.size as f32);
            let texel_size = diameter / map.size as f32;
            let center = Vec3::new(
                ((min.x+max.x)*0.5/texel_size).floor()*texel_size,
                ((min.y+max.y)*0.5/texel_size).floor()*texel_size,
                max.z,
            );
            let cascade_from_world = Mat4::from_cols(
                light_from_world.x_axis, light_from_world.y_axis, light_from_world.z_axis, (-center).extend(1.0),
            );
            let world_from_cascade = Mat4::from_cols(
                world_from_light.x_axis, world_from_light.y_axis, world_from_light.z_axis, world_from_light*center.extend(1.0),
            );
            let clip_from_cascade = Mat4::from_cols(
                Vec4::new(2.0/diameter,0.0,0.0,0.0), Vec4::new(0.0,2.0/diameter,0.0,0.0),
                Vec4::new(0.0,0.0,(max.z-min.z).recip(),0.0), Vec4::new(0.0,0.0,1.0,1.0),
            );
            shared.push(bevy::light::cascade::Cascade {
                world_from_cascade, clip_from_cascade, clip_from_world: clip_from_cascade*cascade_from_world, texel_size,
            });
            near = far*(1.0-config.overlap_proportion);
        }
        if shared.len() == config.bounds.len() {
            for view in cascades.cascades.values_mut() { view.clone_from(&shared); }
        }
    }
}

fn suppress_duplicate_passes(mut views: Query<(&ExtractedCamera, &mut bevy::pbr::ViewLightEntities)>) {
    let first = views.iter().filter(|(_, lights)| !lights.lights.is_empty()).map(|(camera, _)| camera.order).min();
    for (camera, mut lights) in &mut views {
        if Some(camera.order) != first {
            // All view light uniforms still reference the common atlas; only
            // the first camera preprocesses and renders its identical cascades.
            lights.lights.clear();
        }
    }
}
