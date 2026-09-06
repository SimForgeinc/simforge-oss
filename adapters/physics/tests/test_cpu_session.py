import dataclasses
import json

import numpy as np
import pytest

pytest.importorskip("mujoco")

from simforge_oss_physics import (
    ACTION_SIZE,
    OBS,
    OBSERVATION_SIZE,
    EpisodeStateError,
    MuJoCoCpuSession,
    ResetOptions,
    Snapshot,
    SnapshotIncompatibleError,
    Workload,
    WorkloadSpec,
)


def drive(k):
    return np.array([1.0, 0.8, 1.0, 0.8]) if k % 2 == 0 else np.array([0.8, 1.0, 0.8, 1.0])


def test_reset_is_seed_deterministic_and_seed_sensitive():
    a, b = MuJoCoCpuSession(), MuJoCoCpuSession()
    ra, rb = a.reset(3), b.reset(3)
    assert ra.observation.shape == (OBSERVATION_SIZE,)
    assert np.array_equal(ra.observation, rb.observation)
    assert not np.array_equal(ra.observation, b.reset(4).observation)


def test_step_semantics_and_action_clipping():
    s = MuJoCoCpuSession()
    s.reset(0, ResetOptions(lateral_jitter_m=0.0, yaw_jitter_rad=0.0))
    res = s.step(np.full(ACTION_SIZE, 100.0))  # clipped to motor_torque_max_nm
    assert res.tick == 1
    assert res.time_s == pytest.approx(s.workload.spec.simulation.decision_dt_s)
    assert res.info["effort_nm2"] == pytest.approx(4 * s.workload.spec.robot.motor_torque_max_nm**2)
    assert np.all(res.observation[OBS["wheel_normal_force"]] > 0)
    with pytest.raises(ValueError):
        s.step(np.zeros(3))


def test_episode_terminates_at_goal_and_refuses_further_steps():
    spec = WorkloadSpec()
    spec = dataclasses.replace(spec, simulation=dataclasses.replace(spec.simulation, max_decisions=3))
    s = MuJoCoCpuSession(Workload(spec))
    s.reset(0)
    last = None
    for _ in range(3):
        last = s.step(np.zeros(ACTION_SIZE))
    assert last.truncated and not last.terminated and last.done
    with pytest.raises(EpisodeStateError):
        s.step(np.zeros(ACTION_SIZE))


def test_snapshot_round_trip_resumes_identically_and_rewinds_recording():
    s = MuJoCoCpuSession()
    s.reset(5)
    for k in range(20):
        s.step(drive(k))
    snap = Snapshot.from_dict(json.loads(json.dumps(s.snapshot().to_dict())))
    tail_a = [s.step(drive(k)).observation for k in range(20, 30)]
    assert len(s.recorder) == 31
    restored = s.restore(snap)
    assert restored.tick == 20 and len(s.recorder) == 21
    tail_b = [s.step(drive(k)).observation for k in range(20, 30)]
    assert np.array_equal(np.stack(tail_a), np.stack(tail_b))


def test_restore_rejects_foreign_snapshot():
    s = MuJoCoCpuSession()
    s.reset(0)
    snap = s.snapshot()
    other = MuJoCoCpuSession(Workload(WorkloadSpec(robot=dataclasses.replace(s.workload.spec.robot, wheel_radius_m=0.11))))
    with pytest.raises(SnapshotIncompatibleError):
        other.restore(snap)
    with pytest.raises(SnapshotIncompatibleError):
        s.restore(dataclasses.replace(snap, backend="mujoco-warp"))


def test_scene_state_export_shape_and_frame():
    s = MuJoCoCpuSession()
    s.reset(1)
    for k in range(5):
        s.step(drive(k))
    doc = s.export_scene_state()
    assert doc["version"] == "simforge.scene-state.v1" and doc["frame"] == "scene-yup"
    assert doc["tickCount"] == 6 and [f["tick"] for f in doc["frames"]] == list(range(6))
    assert [a["id"] for a in doc["actors"]] == ["chassis", "wheel_fl", "wheel_fr", "wheel_rl", "wheel_rr"]
    first, second = doc["frames"][0]["actors"][0], doc["frames"][1]["actors"][0]
    assert first["kind"] == "spawn" and second["kind"] == "update"
    assert "acceleration" not in first and "acceleration" in second
    # scene y is MuJoCo z: the chassis sits above the ground at rest height.
    assert first["position"][1] == pytest.approx(s.workload.spec.robot.chassis_center_height_m, abs=0.02)
    segment = s.export_scene_state(from_tick=3)
    assert segment["tickCount"] == 3 and segment["frames"][0]["actors"][0]["kind"] == "spawn"
