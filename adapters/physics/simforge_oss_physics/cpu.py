"""MuJoCo CPU backend: one world per session, ``mujoco.mj_step`` on the host."""

from __future__ import annotations

import mujoco
import numpy as np

from .profile import PROFILE_ID, Backend
from .scene_state import SceneStateRecorder, scene_state_digest
from .types import EpisodeStateError, ResetOptions, Snapshot, StepResult
from .workload import (
    ACTION_SIZE,
    EXPORTED_BODIES,
    OBS,
    OBSERVATION_LAYOUT,
    OBSERVATION_SIZE,
    WHEELS,
    Workload,
    start_pose,
)


def load_model(workload: Workload) -> "mujoco.MjModel":
    """Compile the workload MJCF and verify its sensor layout matches
    ``OBSERVATION_LAYOUT`` exactly (offset and size per field)."""
    model = mujoco.MjModel.from_xml_string(workload.mjcf)
    if model.nsensordata != OBSERVATION_SIZE:
        raise RuntimeError(f"model nsensordata {model.nsensordata} != OBSERVATION_SIZE {OBSERVATION_SIZE}")
    if model.nu != ACTION_SIZE:
        raise RuntimeError(f"model nu {model.nu} != ACTION_SIZE {ACTION_SIZE}")
    expected_offsets: list[tuple[str, int, int]] = []
    offset = 0
    for f in OBSERVATION_LAYOUT:
        if f.size == 4 and f.name.startswith("wheel_"):
            for i, n in enumerate(WHEELS):
                expected_offsets.append((f"{f.name}_{n}", offset + i, 1))
        else:
            expected_offsets.append((f.name, offset, f.size))
        offset += f.size
    for name, adr, dim in expected_offsets:
        sid = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_SENSOR, name)
        if sid < 0:
            raise RuntimeError(f"sensor {name!r} missing from model")
        if int(model.sensor_adr[sid]) != adr or int(model.sensor_dim[sid]) != dim:
            raise RuntimeError(
                f"sensor {name!r} at adr={model.sensor_adr[sid]} dim={model.sensor_dim[sid]}, expected adr={adr} dim={dim}"
            )
    return model


class MuJoCoCpuSession:
    """Finite-episode execution of the workload on the MuJoCo CPU solver.

    Episode API: ``reset(seed, options) -> StepResult`` then ``step(action) ->
    StepResult`` until ``result.done``; ``snapshot()``/``restore()`` capture
    and resume complete integration state; ``export_scene_state()`` emits the
    recorded frames.

    Each decision applies the clipped wheel torques, runs
    ``substeps_per_decision`` ``mj_step`` calls, then ``mj_forward`` so the
    observation describes the post-integration state (``mj_step`` leaves
    sensors at the pre-integration state).
    """

    backend = Backend.MUJOCO_CPU
    state_spec = int(mujoco.mjtState.mjSTATE_INTEGRATION)
    state_spec_name = "mjSTATE_INTEGRATION"

    def __init__(self, workload: Workload | None = None) -> None:
        self.workload = workload or Workload()
        self.model = load_model(self.workload)
        self.data = mujoco.MjData(self.model)
        self.mujoco_version = mujoco.__version__
        self._body_ids = np.array(
            [mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_BODY, b) for b in EXPORTED_BODIES]
        )
        self._state_size = mujoco.mj_stateSize(self.model, self.state_spec)
        self.recorder = SceneStateRecorder(self.workload)
        self.tick = 0
        self.seed = 0
        self.options = ResetOptions()
        self._lateral_offset_m = 0.0
        self._yaw_rad = 0.0
        self._prev_x = 0.0
        self._finished = True

    # ------------------------------------------------------------------ api

    @property
    def time_s(self) -> float:
        return float(self.data.time)

    @property
    def finished(self) -> bool:
        return self._finished

    def reset(self, seed: int, options: ResetOptions | None = None) -> StepResult:
        self.options = options or ResetOptions()
        self.seed = int(seed)
        self._lateral_offset_m, self._yaw_rad = self.options.sample_pose_offsets(self.seed)
        pose = start_pose(
            self.workload.spec,
            self.options.start,
            lateral_offset_m=self._lateral_offset_m,
            yaw_rad=self._yaw_rad,
            height_offset_m=self.options.height_offset_m,
        )
        mujoco.mj_resetData(self.model, self.data)
        self.data.qpos[:] = 0.0
        self.data.qpos[:7] = pose.qpos()
        self.data.qvel[:] = 0.0
        self.data.ctrl[:] = 0.0
        mujoco.mj_forward(self.model, self.data)
        self.tick = 0
        self._finished = False
        obs = self._observe()
        self._prev_x = float(obs[OBS["chassis_pos"]][0])
        self.recorder.clear()
        self._record()
        _, _, _, info = self.workload.evaluate(
            obs[None, :], np.array([self._prev_x]), np.zeros((1, ACTION_SIZE)), np.array([0])
        )
        return StepResult(
            observation=obs,
            reward=0.0,
            terminated=False,
            truncated=False,
            tick=0,
            time_s=self.time_s,
            info={k: v[0].item() for k, v in info.items()},
        )

    def step(self, action: np.ndarray) -> StepResult:
        if self._finished:
            raise EpisodeStateError("episode is finished or not reset; call reset() first")
        torque = self.workload.clip_action(action)
        if torque.shape != (ACTION_SIZE,):
            raise ValueError(f"action shape {torque.shape} != ({ACTION_SIZE},)")
        self.data.ctrl[:] = torque
        substeps = self.workload.spec.simulation.substeps_per_decision
        for _ in range(substeps):
            mujoco.mj_step(self.model, self.data)
        mujoco.mj_forward(self.model, self.data)
        self.tick += 1
        obs = self._observe()
        reward, terminated, truncated, info = self.workload.evaluate(
            obs[None, :], np.array([self._prev_x]), torque[None, :], np.array([self.tick])
        )
        self._prev_x = float(obs[OBS["chassis_pos"]][0])
        self._record()
        self._finished = bool(terminated[0] or truncated[0])
        return StepResult(
            observation=obs,
            reward=float(reward[0]),
            terminated=bool(terminated[0]),
            truncated=bool(truncated[0]),
            tick=self.tick,
            time_s=self.time_s,
            info={k: v[0].item() for k, v in info.items()},
        )

    def snapshot(self) -> Snapshot:
        state = np.empty(self._state_size, dtype=np.float64)
        mujoco.mj_getState(self.model, self.data, state, self.state_spec)
        return Snapshot(
            profile_id=PROFILE_ID,
            backend=self.backend.value,
            workload_id=self.workload.id,
            workload_digest=self.workload.digest,
            mujoco_version=self.mujoco_version,
            state_spec=self.state_spec,
            state_spec_name=self.state_spec_name,
            state=state,
            tick=self.tick,
            time_s=self.time_s,
            seed=self.seed,
            start=self.options.start,
            lateral_offset_m=self._lateral_offset_m,
            yaw_rad=self._yaw_rad,
            prev_x_m=self._prev_x,
            finished=self._finished,
        )

    def restore(self, snapshot: Snapshot) -> StepResult:
        snapshot.check_compatible(
            backend=self.backend,
            workload_digest=self.workload.digest,
            mujoco_version=self.mujoco_version,
            state_spec=self.state_spec,
        )
        if snapshot.state.shape != (self._state_size,):
            raise ValueError(f"state size {snapshot.state.shape} != ({self._state_size},)")
        mujoco.mj_setState(self.model, self.data, np.ascontiguousarray(snapshot.state, dtype=np.float64), self.state_spec)
        mujoco.mj_forward(self.model, self.data)
        self.tick = snapshot.tick
        self.seed = snapshot.seed
        self.options = ResetOptions(start=snapshot.start)
        self._lateral_offset_m = snapshot.lateral_offset_m
        self._yaw_rad = snapshot.yaw_rad
        self._prev_x = snapshot.prev_x_m
        self._finished = snapshot.finished
        self.recorder.rewind(self.tick)
        if len(self.recorder) == 0:
            self._record()
        obs = self._observe()
        return StepResult(
            observation=obs,
            reward=0.0,
            terminated=False,
            truncated=False,
            tick=self.tick,
            time_s=self.time_s,
            info={},
        )

    def export_scene_state(self, from_tick: int = 0) -> dict:
        return self.recorder.export(from_tick)

    def export_digest(self, from_tick: int = 0) -> str:
        return scene_state_digest(self.export_scene_state(from_tick))

    # -------------------------------------------------------------- helpers

    def _observe(self) -> np.ndarray:
        return np.array(self.data.sensordata, dtype=np.float64, copy=True)

    def _record(self) -> None:
        sd = self.data.sensordata
        self.recorder.record(
            self.tick,
            self.time_s,
            self.data.xpos[self._body_ids],
            self.data.xquat[self._body_ids],
            sd[OBS["chassis_linvel"]],
            sd[OBS["chassis_angvel"]],
        )
