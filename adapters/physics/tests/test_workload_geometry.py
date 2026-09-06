import math

import numpy as np
import pytest

pytest.importorskip("mujoco")

from simforge_oss_physics.scene_state import to_scene_position, to_scene_quaternion, yaw_from_quaternion
from simforge_oss_physics.workload import (
    WHEELS,
    Workload,
    WorkloadSpec,
    quat_about_z,
    ramp_slab_pose,
    start_pose,
)


def rotate(q_wxyz, v):
    w, x, y, z = q_wxyz
    r = np.array([x, y, z])
    return v + 2.0 * np.cross(r, np.cross(r, v) + w * v)


def test_ramp_slab_top_surface_spans_start_to_end():
    spec = WorkloadSpec()
    half, center, quat = ramp_slab_pose(spec.course)
    low = center + rotate(quat, np.array([-half[0], 0.0, half[2]]))
    high = center + rotate(quat, np.array([half[0], 0.0, half[2]]))
    assert low == pytest.approx([spec.course.ramp_start_x_m, 0.0, 0.0], abs=1e-12)
    assert high == pytest.approx([spec.course.ramp_end_x_m, 0.0, spec.course.ramp_rise_m], abs=1e-12)


@pytest.mark.parametrize("region", ["approach", "ramp", "plateau"])
@pytest.mark.parametrize("yaw", [0.0, 0.3])
def test_start_pose_puts_every_wheel_bottom_on_the_surface(region, yaw):
    spec = WorkloadSpec()
    robot, course = spec.robot, spec.course
    pose = start_pose(spec, region, lateral_offset_m=0.04, yaw_rad=yaw)
    pitch = course.incline_rad if region == "ramp" else 0.0
    normal = np.array([-math.sin(pitch), 0.0, math.cos(pitch)])
    wx, wy, wz = robot.wheelbase_m / 2, robot.track_m / 2, robot.wheel_offset_z_m
    offsets = {"fl": (wx, wy, wz), "fr": (wx, -wy, wz), "rl": (-wx, wy, wz), "rr": (-wx, -wy, wz)}
    assert pose.position[1] == pytest.approx(0.04)
    for name in WHEELS:
        centre = pose.position + rotate(pose.quaternion, np.array(offsets[name]))
        bottom = centre - normal * robot.wheel_radius_m
        assert bottom[2] == pytest.approx(course.surface_height_m(bottom[0]), abs=1e-9)


def test_scene_frame_mapping_matches_engine_conventions():
    # xodr-local (x, y, z) -> scene (x, z, -y)
    assert to_scene_position(np.array([1.0, 2.0, 3.0])) == [1.0, 3.0, -2.0]
    theta = 0.7
    q = quat_about_z(theta)
    # engine yawToQuaternion(theta) == [0, sin(theta/2), 0, cos(theta/2)]
    assert to_scene_quaternion(q) == pytest.approx([0.0, math.sin(theta / 2), 0.0, math.cos(theta / 2)])
    assert yaw_from_quaternion(q) == pytest.approx(theta)


def test_workload_digest_changes_with_any_spec_field():
    base = Workload()
    heavier = Workload(WorkloadSpec(robot=base.spec.robot.__class__(chassis_mass_kg=31.0)))
    assert base.digest != heavier.digest
    assert Workload().digest == base.digest
