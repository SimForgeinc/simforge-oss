"""Gymnasium ``Env`` over one native ``EnvSession``.

The episode runs in-process in the Rust runtime: ``reset`` rebuilds the
world from the materialised scenario (consuming the warm-up prologue so no
policy-visible tick is negative), ``step`` holds one action for
``ENGINE_HZ / decision_hz`` engine ticks (zero-order hold) and returns the
Gymnasium 5-tuple. ``terminated`` is collision-or-goal, ``truncated`` is clip
end / decision horizon / engine completion; stepping a finished episode raises.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any, Literal, Mapping

import gymnasium as gym
import numpy as np
from gymnasium import spaces

from .episodes import EpisodeSpec, LoadedEpisode, episode_config, episode_config_json, load_episode_spec
from .native import ACTION_FIELDS, ACTION_WIDTH, ENGINE_HZ, OBJECT_FEATURES, STATE_VECTOR_SIZE, EnvSession, StepView

ActionMode = Literal["setpoint", "control"]

_SLOT = {name: index for index, name in enumerate(ACTION_FIELDS)}
_TARGET_SPEED = _SLOT["target_speed_mps"]
_TARGET_ACCEL = _SLOT["target_acceleration_mps2"]
_THROTTLE = _SLOT["throttle"]
_BRAKE = _SLOT["brake"]
_STEER = _SLOT["steer"]


def action_space_for(mode: ActionMode) -> spaces.Box:
    """The Box actually consumed by the engine for ``mode``.

    - ``setpoint``: ``[target_speed_mps >= 0, target_acceleration_mps2]`` — the
      longitudinal setpoint pair the planner blends (feed-forward acceleration
      plus a proportional speed term); steering follows the authored route.
    - ``control``: ``[throttle, brake, steer]`` in ``[0,1] x [0,1] x [-1,1]``,
      passed through to the force-based backend inside its rate/lag envelope.
    """
    if mode == "setpoint":
        return spaces.Box(np.array([0.0, -np.inf]), np.array([np.inf, np.inf]), (2,), np.float64)
    if mode == "control":
        return spaces.Box(np.array([0.0, 0.0, -1.0]), np.array([1.0, 1.0, 1.0]), (3,), np.float64)
    raise ValueError(f"unknown action_mode {mode!r}; expected 'setpoint' or 'control'")


def encode_action(mode: ActionMode, action: Any, out: np.ndarray) -> np.ndarray:
    """Write ``action`` (in ``mode``'s Box) into the flat native row ``out``."""
    out.fill(np.nan)
    values = np.asarray(action, dtype=np.float64).reshape(-1)
    if mode == "setpoint":
        if values.shape != (2,):
            raise ValueError(f"setpoint action must have shape (2,), got {values.shape}")
        out[_TARGET_SPEED] = values[0]
        out[_TARGET_ACCEL] = values[1]
    else:
        if values.shape != (3,):
            raise ValueError(f"control action must have shape (3,), got {values.shape}")
        out[_THROTTLE] = values[0]
        out[_BRAKE] = values[1]
        out[_STEER] = values[2]
    if not np.all(np.isfinite(values)):
        raise ValueError(f"action contains non-finite values: {values}")
    return out


def observation_space_for(max_objects: int, bev_shape: tuple[int, int, int] | None) -> spaces.Dict:
    members: dict[str, spaces.Space] = {
        "state_vector": spaces.Box(-np.inf, np.inf, (STATE_VECTOR_SIZE,), np.float64),
        "objects": spaces.Box(
            np.tile(np.array([0.0, -math.pi, -np.inf, 0.0, 0.0], dtype=np.float32), (max_objects, 1)),
            np.tile(np.array([np.inf, math.pi, np.inf, 1.0, 1.0], dtype=np.float32), (max_objects, 1)),
            (max_objects, OBJECT_FEATURES),
            np.float32,
        ),
    }
    if bev_shape is not None:
        members["bev"] = spaces.Box(-np.inf, np.inf, bev_shape, np.float32)
    return spaces.Dict(members)


def observation_of(view: StepView) -> dict[str, np.ndarray]:
    obs = {"state_vector": view.state_vector, "objects": view.objects}
    bev = view.bev
    if bev is not None:
        obs["bev"] = bev
    return obs


def info_of(view: StepView, ego: str, *, channel: bool) -> dict[str, Any]:
    progress, proximity, comfort = view.reward_terms
    info: dict[str, Any] = {
        "t_s": view.t_s,
        "ego": ego,
        "object_ids": view.object_ids,
        "reward_terms": {"progress": float(progress), "proximity": float(proximity), "comfort": float(comfort)},
    }
    if channel:
        info.update(json.loads(view.info_json()))
    return info


def _seed_value(seed: int | None, options: Mapping[str, Any] | None, default: int | float | str | None) -> int | float | str | None:
    if seed is not None:
        return seed
    if options and "seed" in options:
        return options["seed"]
    return default


class SimForgeEnv(gym.Env[dict[str, np.ndarray], np.ndarray]):
    """One SimForge episode stream as a Gymnasium environment.

    Construct from an episode spec path (``episodes_spec`` + ``session`` index)
    or from an already loaded :class:`LoadedEpisode`. Observations are a Dict
    of ``state_vector`` (float64 ``(10,)``), ``objects`` (float32
    ``(max_objects, 5)``, rows ``[range, bearing, range_rate, los, valid]``)
    and, when configured, ``bev`` (float32 ``(H, W, 3)``). Every array is a
    fresh copy owned by the caller.

    ``info`` carries ``t_s``, ``ego``, ``object_ids``, ``reward_terms`` and,
    unless ``info_channel=False``, the engine ``events``, pair ``minima`` and
    this decision's ``causal`` frame.
    """

    metadata: dict[str, Any] = {"render_modes": []}

    def __init__(
        self,
        episodes_spec: str | Path | None = None,
        *,
        episode: LoadedEpisode | None = None,
        session: int = 0,
        action_mode: ActionMode = "setpoint",
        decision_hz: int | None = None,
        clip_seconds: float | None = None,
        max_decisions: int | None = None,
        bev: Mapping[str, Any] | bool | None = None,
        episode_config_overrides: Mapping[str, Any] | None = None,
        seed: int | float | str | None = None,
        info_channel: bool = True,
        maps_dir: str | Path | None = None,
    ) -> None:
        super().__init__()
        if (episodes_spec is None) == (episode is None):
            raise ValueError("pass exactly one of episodes_spec or episode")
        base_config: Mapping[str, Any] = {}
        if episodes_spec is not None:
            spec: EpisodeSpec = load_episode_spec(episodes_spec, maps_dir=maps_dir)
            if session >= len(spec.episodes):
                raise IndexError(f"session {session} requested but the spec has {len(spec.episodes)} episodes")
            episode = spec.episodes[session]
            base_config = spec.episode_config
        assert episode is not None
        config = episode_config(base_config, decision_hz=decision_hz, clip_seconds=clip_seconds, max_decisions=max_decisions, bev=bev)
        if episode_config_overrides:
            config.update(episode_config_overrides)

        self.episode = episode
        self.session_index = session
        self.action_mode: ActionMode = action_mode
        self.info_channel = info_channel
        self._default_seed = seed
        self._row = np.empty(ACTION_WIDTH, dtype=np.float64)
        self._session = EnvSession(episode.input, episode.graph, episode_config_json(config))
        self.ego: str = self._session.ego
        self.decision_hz: int = self._session.decision_hz
        self.engine_hz: int = ENGINE_HZ
        self.action_space = action_space_for(action_mode)
        self.observation_space = observation_space_for(self._session.max_objects, self._session.bev_shape)

    # ------------------------------------------------------------------ api

    def reset(
        self, *, seed: int | None = None, options: Mapping[str, Any] | None = None
    ) -> tuple[dict[str, np.ndarray], dict[str, Any]]:
        super().reset(seed=seed)
        view = self._session.reset(_seed_value(seed, options, self._default_seed))
        return observation_of(view), info_of(view, self.ego, channel=self.info_channel)

    def step(self, action: np.ndarray | None) -> tuple[dict[str, np.ndarray], float, bool, bool, dict[str, Any]]:
        """Apply ``action`` for one decision; ``None`` keeps the authored choreography."""
        row = None if action is None else encode_action(self.action_mode, action, self._row)
        view = self._session.step(row)
        return observation_of(view), view.reward, view.terminated, view.truncated, info_of(view, self.ego, channel=self.info_channel)

    def checkpoint(self) -> bytes:
        """Complete continuation state of the current episode (opaque bytes)."""
        return self._session.checkpoint()

    def restore(self, checkpoint: bytes) -> tuple[dict[str, np.ndarray], dict[str, Any]]:
        view = self._session.restore(checkpoint)
        return observation_of(view), info_of(view, self.ego, channel=self.info_channel)

    def ego_pose(self) -> tuple[float, float, float, float, float]:
        """``(t_s, x, y, yaw_rad, speed_mps)`` at the current observation instant."""
        return self._session.ego_pose()

    @property
    def native(self) -> EnvSession:
        """The underlying native session (policy executors attach here)."""
        return self._session

    def close(self) -> None:
        self.__dict__.pop("_session", None)

    def __enter__(self) -> "SimForgeEnv":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()
