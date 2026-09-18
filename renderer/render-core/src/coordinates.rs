//! The source/Bevy frame boundary. Imported glTF geometry is already in the
//! scene frame and must NOT be rotated to compensate for a sensor convention.
use bevy::math::{EulerRot, Quat, Vec3};

#[derive(Clone, Copy, Debug)]
pub struct LengthWidthHeight {
    pub length: f32,
    pub width: f32,
    pub height: f32,
}
impl LengthWidthHeight {
    pub const UNIT: Self = Self { length: 1.0, width: 1.0, height: 1.0 };
}

#[derive(Clone, Copy, Debug)]
pub enum SourceRotation {
    /// Source scene-world quaternion, explicitly [x,y,z,w], not a Bevy output.
    WorldQuaternion([f32; 4]),
    /// Source mount angles in radians, relative to the already-resolved rig
    /// world orientation. This parent is a transform, NOT another source angle.
    MountYawPitchRoll { parent_rotation: Quat, yaw: f32, pitch: f32, roll: f32 },
}

#[derive(Clone, Copy, Debug)]
pub enum FrameBasis { Rig, Camera }

/// Distinct output type: neither this value nor its Quat is a SourceRotation.
#[derive(Clone, Copy, Debug)]
pub struct BevyFrame {
    pub size_xyz: Vec3,
    pub rotation: Quat,
}

/// Convert source dimensions and orientation at the ONLY frame boundary.
///
/// Source actor/rig axes are +X forward, +Y up, +Z lateral (camera-right at
/// identity heading). Dimensions arrive as LENGTH, WIDTH, HEIGHT, not XYZ.
/// Source world quaternions already use the Y-up scene frame. Source MOUNT yaw
/// is different: positive yaw aims +X toward +Z, pitch raises the nose toward
/// +Y, and roll turns +Y toward +Z. Mount translations must already be lowered
/// to scene metres by the rig parser; this function does not remirror them.
///
/// Bevy cameras look down -Z, so only Camera adds the optical-basis rotation.
/// Rig is shared by actor bodies, lidar and radar. Quaternion input uses a raw
/// source [x,y,z,w] array while the output is a Bevy Quat, making accidental
/// re-application to an already-converted rotation a type error.
#[inline]
pub fn source_to_bevy(dimensions: LengthWidthHeight, rotation: SourceRotation, basis: FrameBasis) -> BevyFrame {
    let rotation = match rotation {
        SourceRotation::WorldQuaternion([x,y,z,w]) => Quat::from_xyzw(x,y,z,w),
        SourceRotation::MountYawPitchRoll { parent_rotation, yaw, pitch, roll } =>
            parent_rotation * Quat::from_euler(EulerRot::YZX, -yaw, pitch, roll),
    };
    let rotation = match basis {
        FrameBasis::Rig => rotation,
        FrameBasis::Camera => rotation * Quat::from_rotation_y(-std::f32::consts::FRAC_PI_2),
    };
    BevyFrame { size_xyz: Vec3::new(dimensions.length, dimensions.height, dimensions.width), rotation }
}

/// A rigid sensor pose, with its inverse cached once per scan rather than once
/// per return. World offsets alone are NOT sensor coordinates when it rotates.
#[derive(Clone, Copy, Debug)]
pub struct SensorFrame {
    origin: Vec3,
    world_from_sensor: Quat,
    sensor_from_world: Quat,
}
impl SensorFrame {
    #[inline]
    pub fn from_bevy_pose(origin: Vec3, rotation: Quat) -> Self {
        Self { origin, world_from_sensor: rotation, sensor_from_world: rotation.inverse() }
    }
    #[inline]
    pub fn direction_to_world(self, direction: Vec3) -> Vec3 { self.world_from_sensor * direction }
    #[inline]
    pub fn point_to_sensor(self, world_point: Vec3) -> Vec3 { self.sensor_from_world * (world_point - self.origin) }
}
