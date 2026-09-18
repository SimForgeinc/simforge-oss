//! Keep physical intrinsics independent of the output pixel grid. Bevy's
//! standard perspective update replaces aspect_ratio with target W/H; that is
//! wrong for an intentional non-square-pixel image matching the model's resize.
use bevy::camera::{CameraProjection, SubCameraView};
use bevy::math::Vec3A;
use bevy::prelude::*;

#[derive(Clone, Debug)]
struct CalibratedProjection(PerspectiveProjection);
impl CameraProjection for CalibratedProjection {
    fn get_clip_from_view(&self) -> Mat4 { self.0.get_clip_from_view() }
    fn get_clip_from_view_for_sub(&self, view: &SubCameraView) -> Mat4 { self.0.get_clip_from_view_for_sub(view) }
    fn update(&mut self, _width: f32, _height: f32) {
        // Deliberately fixed calibration: resizing the output changes pixel
        // shape, not the physical frustum. Do not call Perspective::update.
    }
    fn far(&self) -> f32 { self.0.far() }
    fn get_frustum_corners(&self, near: f32, far: f32) -> [Vec3A; 8] { self.0.get_frustum_corners(near, far) }
}

pub(super) fn camera_projection(vfov: f32, physical_aspect: Option<f32>) -> Projection {
    let perspective = PerspectiveProjection {
        fov: vfov, near: 0.5, far: 900.0, aspect_ratio: physical_aspect.unwrap_or(1.0), ..default()
    };
    if physical_aspect.is_some() { Projection::custom(CalibratedProjection(perspective)) }
    else { Projection::Perspective(perspective) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn calibrated_grid_matches_resize_without_changing_field_of_view() {
        let vfov = crate::rig::vertical_fov_deg(70.0,16.0/9.0).to_radians();
        let mut reference = camera_projection(vfov,None);
        reference.update(1920.0,1080.0);
        // Two target grids: current and history. Bevy's update must NOT silently
        // turn either one into a different physical frustum.
        for target in [Vec2::new(1280.0,704.0),Vec2::new(544.0,288.0)] {
            let mut calibrated = camera_projection(vfov,Some(16.0/9.0));
            calibrated.update(target.x,target.y);
            for point in [Vec3::new(-3.0,1.0,-10.0),Vec3::new(1.0,-2.0,-8.0)] {
                let reference_ndc = reference.get_clip_from_view().project_point3(point);
                let target_ndc = calibrated.get_clip_from_view().project_point3(point);
                let resized = (reference_ndc.truncate()+Vec2::ONE)*0.5*target;
                let direct = (target_ndc.truncate()+Vec2::ONE)*0.5*target;
                assert!(resized.abs_diff_eq(direct,1e-4), "projected point moved on grid {target:?}");
            }
            assert_eq!(calibrated.get_frustum_corners(-0.5,-100.0),reference.get_frustum_corners(-0.5,-100.0));
        }
    }
}
