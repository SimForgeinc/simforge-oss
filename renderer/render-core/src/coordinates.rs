//! The source/Bevy frame boundary. Imported glTF geometry is already in the
//! scene frame and must NOT be rotated to compensate for a sensor convention.
use bevy::math::{EulerRot, Mat4, Quat, Vec3, Vec4};

#[derive(Clone, Copy, Debug)]
pub struct LengthWidthHeight {
    pub length: f32,
    pub width: f32,
    pub height: f32,
}
impl LengthWidthHeight {
    pub const UNIT: Self = Self {
        length: 1.0,
        width: 1.0,
        height: 1.0,
    };
}

#[derive(Clone, Copy, Debug)]
pub enum SourceRotation {
    /// Source scene-world quaternion, explicitly [x,y,z,w], not a Bevy output.
    WorldQuaternion([f32; 4]),
    /// Source mount angles in radians, relative to the already-resolved rig
    /// world orientation. This parent is a transform, NOT another source angle.
    MountYawPitchRoll {
        parent_rotation: Quat,
        yaw: f32,
        pitch: f32,
        roll: f32,
    },
}

#[derive(Clone, Copy, Debug)]
pub enum FrameBasis {
    Rig,
    Camera,
}

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
pub fn source_to_bevy(
    dimensions: LengthWidthHeight,
    rotation: SourceRotation,
    basis: FrameBasis,
) -> BevyFrame {
    let rotation = match rotation {
        SourceRotation::WorldQuaternion([x, y, z, w]) => Quat::from_xyzw(x, y, z, w),
        SourceRotation::MountYawPitchRoll {
            parent_rotation,
            yaw,
            pitch,
            roll,
        } => parent_rotation * Quat::from_euler(EulerRot::YZX, -yaw, pitch, roll),
    };
    let rotation = match basis {
        FrameBasis::Rig => rotation,
        FrameBasis::Camera => rotation * Quat::from_rotation_y(-std::f32::consts::FRAC_PI_2),
    };
    BevyFrame {
        size_xyz: Vec3::new(dimensions.length, dimensions.height, dimensions.width),
        rotation,
    }
}

/// Row-major affine map from native sensor coordinates into policy
/// forward/left/up coordinates at the host actor origin (not a PAI axle).
#[derive(Clone, Copy, Debug, serde::Serialize)]
#[serde(transparent)]
pub struct PolicyFromSensor(pub [[f32; 4]; 4]);
impl PolicyFromSensor {
    #[inline]
    pub fn point(&self, p: Vec3) -> Vec3 {
        let row =
            |i: usize| self.0[i][0] * p.x + self.0[i][1] * p.y + self.0[i][2] * p.z + self.0[i][3];
        Vec3::new(row(0), row(1), row(2))
    }
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
        Self {
            origin,
            world_from_sensor: rotation,
            sensor_from_world: rotation.inverse(),
        }
    }
    #[inline]
    pub fn direction_to_world(self, direction: Vec3) -> Vec3 {
        self.world_from_sensor * direction
    }
    #[inline]
    pub fn point_to_sensor(self, world_point: Vec3) -> Vec3 {
        self.sensor_from_world * (world_point - self.origin)
    }
    /// Resolve once per scan, then publish this exact transform to consumers.
    /// They must not independently re-derive the mount's yaw/pitch/roll.
    pub fn policy_relative_to(self, host: Self) -> PolicyFromSensor {
        let relative = Mat4::from_rotation_translation(
            host.sensor_from_world * self.world_from_sensor,
            host.point_to_sensor(self.origin),
        );
        let policy_from_rig = Mat4::from_cols(Vec4::X, Vec4::Z, -Vec4::Y, Vec4::W);
        PolicyFromSensor((policy_from_rig * relative).transpose().to_cols_array_2d())
    }
}

#[cfg(test)]
mod policy_tests {
    use super::*;
    #[test]
    fn published_matrix_preserves_offset_and_turning_sensor_direction() {
        for yaw in [0.7, -1.2] {
            let rotation = Quat::from_rotation_y(yaw);
            let origin = Vec3::new(31.0, 4.0, -17.0);
            let host = SensorFrame::from_bevy_pose(origin, rotation);
            let mount = source_to_bevy(
                LengthWidthHeight::UNIT,
                SourceRotation::MountYawPitchRoll {
                    parent_rotation: rotation,
                    yaw: std::f32::consts::FRAC_PI_2,
                    pitch: 0.0,
                    roll: 0.0,
                },
                FrameBasis::Rig,
            );
            let sensor = SensorFrame::from_bevy_pose(
                origin + rotation * Vec3::new(0.0, 1.0, 2.0),
                mount.rotation,
            );
            let point = sensor
                .policy_relative_to(host)
                .point(Vec3::new(10.0, 0.0, 0.0));
            assert!(
                point.abs_diff_eq(Vec3::new(0.0, -12.0, 1.0), 2e-5),
                "{point:?}"
            );
        }
    }
}
