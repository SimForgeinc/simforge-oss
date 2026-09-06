"""Gymnasium environments for the ``articulated-mujoco-v1`` profile.

The physics provider is ``simforge-oss-physics`` (``pip install
simforge-oss-gym[articulated]``, plus ``[articulated-warp]`` for the batched
MuJoCo Warp backend). It is an implementation dependency of this SDK: the
public environment API lives here, the solver, workload and qualification
gates live in the provider. Nothing here approximates a missing backend.
"""

from __future__ import annotations

import tempfile
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal, Mapping, Sequence

import gymnasium as gym
import numpy as np
from gymnasium import spaces
from gymnasium.vector import AutoresetMode, VectorEnv
from gymnasium.vector.utils import batch_space

try:
    import simforge_oss_physics as physics
except ImportError as error:  # pragma: no cover - extras guard
    raise ImportError(
        "the articulated-mujoco-v1 profile needs simforge-oss-physics: `pip install simforge-oss-gym[articulated]`"
    ) from error

if TYPE_CHECKING:
    from .bevy_sensors import BevySensorRig

PROFILE_ID: str = physics.PROFILE_ID

SensorBackend = Literal["bevy"]


def _spaces(workload: physics.Workload) -> tuple[spaces.Box, spaces.Box]:
    limit = float(workload.spec.robot.motor_torque_max_nm)
    observation = spaces.Box(-np.inf, np.inf, (physics.OBSERVATION_SIZE,), np.float64)
    action = spaces.Box(-limit, limit, (physics.ACTION_SIZE,), np.float64)
    return observation, action


def _reset_options(options: Mapping[str, Any] | None) -> physics.ResetOptions | None:
    if not options:
        return None
    return physics.ResetOptions(**{k: v for k, v in options.items() if k != "seed"})


def _info(result: physics.StepResult) -> dict[str, Any]:
    return {"t_s": result.time_s, "tick": result.tick, **dict(result.info)}


class ArticulatedEnv(gym.Env[np.ndarray, np.ndarray]):
    """One delivery-robot curb/ramp world on the MuJoCo CPU solver.

    Observation: float64 ``(27,)`` per ``simforge_oss_physics.OBSERVATION_LAYOUT``.
    Action: per-wheel motor torque ``(4,)`` N*m bounded by the workload's motor
    limit. ``reset(seed=...)`` seeds the start-pose jitter; ``options`` may carry
    ``ResetOptions`` fields (``start``, ``lateral_jitter_m``, ...).
    """

    metadata: dict[str, Any] = {"render_modes": [], "profile": PROFILE_ID}

    def __init__(
        self,
        workload: physics.Workload | None = None,
        *,
        sensors: SensorBackend | None = None,
        cameras: Sequence[Mapping[str, Any]] = (),
        resource_dir: str | Path | None = None,
        sensor_options: Mapping[str, Any] | None = None,
    ) -> None:
        super().__init__()
        self.workload = workload or physics.Workload()
        self._session = physics.MuJoCoCpuSession(self.workload)
        self.observation_space, self.action_space = _spaces(self.workload)
        self._seed = 0
        #: Next MuJoCo tick to hand to the renderer (`None` = nothing rendered since reset/restore;
        #: the first export starts at the recorder's first frame so the segment opens with spawns).
        self._next_render_tick: int | None = None
        self.sensors: BevySensorRig | None = None
        if sensors is not None:
            if sensors != "bevy":
                raise ValueError(f"unknown sensor backend {sensors!r}; the articulated profile supports 'bevy'")
            if not cameras:
                raise ValueError("sensors='bevy' needs at least one camera document")
            from simforge_oss_physics.course_asset import render_scene_spec, write_course_resources

            from .bevy_sensors import BevySensorRig

            directory = Path(resource_dir) if resource_dir is not None else Path(tempfile.mkdtemp(prefix="simforge-course-"))
            manifest = write_course_resources(self.workload, directory)
            self.render_scene = render_scene_spec(manifest, directory)
            self.sensors = BevySensorRig(self.render_scene, cameras, self._scene_state_since_render, **dict(sensor_options or {}))

    def reset(self, *, seed: int | None = None, options: Mapping[str, Any] | None = None) -> tuple[np.ndarray, dict[str, Any]]:
        super().reset(seed=seed)
        if seed is not None:
            self._seed = int(seed)
        result = self._session.reset(self._seed, _reset_options(options))
        self._next_render_tick = None
        return result.observation, _info(result)

    def _scene_state_since_render(self) -> list[dict[str, Any]]:
        """Body poses recorded by MuJoCo since the last rendered tick (never re-derived).

        ``export_scene_state(from_tick=k)`` includes tick ``k`` and opens the segment
        with ``spawn`` records, so the next export starts one past the last rendered
        tick; the recorder only holds frames since the last reset/restore.
        """
        from simforge_oss_physics.scene_state import to_service_states

        states = to_service_states(self._session.export_scene_state(self._next_render_tick or 0))
        self._next_render_tick = self._session.tick + 1
        return states

    def render_sensors(self, cuda_stream: Any | None = None) -> Any:
        """Render the configured cameras at the current MuJoCo tick and full body poses."""
        if self.sensors is None:
            raise RuntimeError("construct ArticulatedEnv(sensors='bevy', cameras=[...]) to render")
        return self.sensors.render(self._session.tick, cuda_stream=cuda_stream)

    def step(self, action: np.ndarray) -> tuple[np.ndarray, float, bool, bool, dict[str, Any]]:
        result = self._session.step(np.asarray(action, dtype=np.float64))
        return result.observation, result.reward, result.terminated, result.truncated, _info(result)

    def snapshot(self) -> physics.Snapshot:
        return self._session.snapshot()

    def restore(self, snapshot: physics.Snapshot) -> tuple[np.ndarray, dict[str, Any]]:
        result = self._session.restore(snapshot)
        self._next_render_tick = None
        return result.observation, _info(result)

    def export_scene_state(self, from_tick: int = 0) -> dict[str, Any]:
        return self._session.export_scene_state(from_tick)

    @property
    def native(self) -> physics.MuJoCoCpuSession:
        return self._session

    def close(self) -> None:
        if self.sensors is not None:
            self.sensors.close()
            self.sensors = None
        self.__dict__.pop("_session", None)


class ArticulatedVectorEnv(VectorEnv):
    """N worlds on MuJoCo Warp (``simforge-oss-gym[articulated-warp]``, CUDA device required).

    ``NEXT_STEP`` autoreset: finished worlds restart on the following ``step``
    with their action ignored. The provider raises ``BackendUnavailableError`` /
    ``BackendCapabilityError`` when the device or model is unsupported.
    """

    metadata: dict[str, Any] = {"render_modes": [], "autoreset_mode": AutoresetMode.NEXT_STEP, "profile": PROFILE_ID}

    def __init__(self, num_envs: int, *, workload: physics.Workload | None = None, device: str | None = None, **warp_options: Any) -> None:
        from simforge_oss_physics.warp import MuJoCoWarpBatch

        self.workload = workload or physics.Workload()
        self._batch = MuJoCoWarpBatch(self.workload, nworld=num_envs, device=device, **warp_options)
        self.num_envs = num_envs
        self.single_observation_space, self.single_action_space = _spaces(self.workload)
        self.observation_space = batch_space(self.single_observation_space, num_envs)
        self.action_space = batch_space(self.single_action_space, num_envs)
        self._seeds = np.arange(num_envs, dtype=np.int64)
        self._options: physics.ResetOptions | None = None
        self._needs_reset = np.zeros(num_envs, dtype=np.bool_)

    def reset(self, *, seed: int | Sequence[int] | None = None, options: Mapping[str, Any] | None = None) -> tuple[np.ndarray, dict[str, Any]]:
        if isinstance(seed, int):
            self._seeds = seed + np.arange(self.num_envs, dtype=np.int64)
        elif seed is not None:
            seeds = np.asarray(list(seed), dtype=np.int64)
            if seeds.shape != (self.num_envs,):
                raise ValueError(f"need {self.num_envs} seeds, got {seeds.shape}")
            self._seeds = seeds
        self._options = _reset_options(options)
        result = self._batch.reset([int(s) for s in self._seeds], self._options)
        self._needs_reset[:] = False
        return result.observation, self._infos(result)

    def step(self, actions: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, dict[str, Any]]:
        actions = np.asarray(actions, dtype=np.float64)
        if actions.shape != (self.num_envs, physics.ACTION_SIZE):
            raise ValueError(f"actions must be {(self.num_envs, physics.ACTION_SIZE)}, got {actions.shape}")
        if self._needs_reset.any():
            # Re-seed restarted worlds deterministically from their previous seed.
            self._seeds = np.where(self._needs_reset, self._seeds + self.num_envs, self._seeds)
            self._batch.reset_worlds(self._needs_reset, [int(s) for s in self._seeds[self._needs_reset]], self._options)
        result = self._batch.step(actions)
        self._needs_reset = result.terminated | result.truncated
        return result.observation, result.reward, result.terminated, result.truncated, self._infos(result)

    def snapshot(self, world: int) -> physics.Snapshot:
        return self._batch.snapshot(world)

    def restore(self, world: int, snapshot: physics.Snapshot) -> None:
        self._batch.restore(world, snapshot)
        self._needs_reset[world] = False

    def close_extras(self, **kwargs: Any) -> None:
        self.__dict__.pop("_batch", None)

    def __enter__(self) -> "ArticulatedVectorEnv":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def _infos(self, result: physics.BatchStepResult) -> dict[str, Any]:
        mask = np.ones(self.num_envs, dtype=np.bool_)
        infos: dict[str, Any] = {"t_s": result.time_s, "_t_s": mask, "tick": result.tick, "_tick": mask}
        for key, value in result.info.items():
            infos[key] = value
            infos[f"_{key}"] = mask
        return infos
