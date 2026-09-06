"""Gymnasium ``VectorEnv`` over one native ``SessionBatch``.

N independent worlds step together in the Rust runtime (CPU-parallel over
worlds, GIL released). Every ``step`` is one native call: an ``(N, ACTION_WIDTH)``
action matrix in, world-major observation/reward/flag arrays out.

Autoreset follows Gymnasium's ``NEXT_STEP`` mode: a world that reported
``terminated`` or ``truncated`` is reset on the following ``step`` (its action
is ignored) and returns its reset observation with reward ``0`` and both flags
``False``. Observations returned earlier are owned copies and never change.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Mapping, Sequence

import numpy as np
from gymnasium.vector import AutoresetMode, VectorEnv
from gymnasium.vector.utils import batch_space

from .env import ActionMode, action_space_for, encode_action, observation_space_for
from .episodes import EpisodeSpec, LoadedEpisode, episode_config, episode_config_json, load_episode_spec
from .native import ACTION_WIDTH, BatchView, SessionBatch


class SimForgeVectorEnv(VectorEnv):
    """Synchronous vector of N SimForge worlds executed natively in one call."""

    metadata: dict[str, Any] = {"render_modes": [], "autoreset_mode": AutoresetMode.NEXT_STEP}

    def __init__(
        self,
        episodes_spec: str | Path | None = None,
        *,
        episodes: Sequence[LoadedEpisode] | None = None,
        num_envs: int | None = None,
        action_mode: ActionMode = "setpoint",
        decision_hz: int | None = None,
        clip_seconds: float | None = None,
        max_decisions: int | None = None,
        bev: Mapping[str, Any] | bool | None = None,
        episode_config_overrides: Mapping[str, Any] | None = None,
        threads: int | None = None,
        info_channel: bool = False,
        maps_dir: str | Path | None = None,
    ) -> None:
        if (episodes_spec is None) == (episodes is None):
            raise ValueError("pass exactly one of episodes_spec or episodes")
        base_config: Mapping[str, Any] = {}
        if episodes_spec is not None:
            spec: EpisodeSpec = load_episode_spec(episodes_spec, maps_dir=maps_dir)
            episodes = spec.episodes
            base_config = spec.episode_config
        assert episodes is not None
        if num_envs is not None:
            if num_envs > len(episodes):
                raise ValueError(f"need {num_envs} worlds but the spec provides {len(episodes)}")
            episodes = episodes[:num_envs]
        if not episodes:
            raise ValueError("a vector env needs at least one episode")
        config = episode_config(base_config, decision_hz=decision_hz, clip_seconds=clip_seconds, max_decisions=max_decisions, bev=bev)
        if episode_config_overrides:
            config.update(episode_config_overrides)

        self._batch = SessionBatch(
            [ep.input for ep in episodes], [ep.graph for ep in episodes], episode_config_json(config), threads
        )
        self.num_envs: int = self._batch.size
        self.egos: tuple[str, ...] = tuple(self._batch.egos)
        self.decision_hz: int = self._batch.decision_hz
        self.action_mode: ActionMode = action_mode
        self.info_channel = info_channel
        self.single_action_space = action_space_for(action_mode)
        self.single_observation_space = observation_space_for(self._batch.max_objects, self._batch.bev_shape)
        self.action_space = batch_space(self.single_action_space, self.num_envs)
        self.observation_space = batch_space(self.single_observation_space, self.num_envs)
        self._actions = np.empty((self.num_envs, ACTION_WIDTH), dtype=np.float64)
        self._needs_reset = np.zeros(self.num_envs, dtype=np.bool_)
        self._ego_array = np.array(self.egos, dtype=object)

    # ------------------------------------------------------------------ api

    def reset(
        self, *, seed: int | Sequence[int] | None = None, options: Mapping[str, Any] | None = None
    ) -> tuple[dict[str, np.ndarray], dict[str, Any]]:
        seeds = self._seeds(seed, options)
        view = self._batch.reset_all(seeds)
        self._needs_reset[:] = False
        return self._observation(view), self._infos(view)

    def step(
        self, actions: np.ndarray | Sequence[Any]
    ) -> tuple[dict[str, np.ndarray], np.ndarray, np.ndarray, np.ndarray, dict[str, Any]]:
        rows = np.asarray(actions, dtype=np.float64)
        if rows.shape[0] != self.num_envs:
            raise ValueError(f"need {self.num_envs} actions, got {rows.shape[0]}")
        for i in range(self.num_envs):
            encode_action(self.action_mode, rows[i], self._actions[i])

        if self._needs_reset.any():
            # NEXT_STEP autoreset: finished worlds restart now and skip this step.
            self._batch.reset_worlds(np.flatnonzero(self._needs_reset).astype(np.int64), None)
            view = self._batch.step_batch(self._actions, ~self._needs_reset)
        else:
            view = self._batch.step_batch(self._actions, None)
        self._needs_reset = view.terminated | view.truncated
        return self._observation(view), view.reward, view.terminated, view.truncated, self._infos(view)

    def checkpoint(self, world: int) -> bytes:
        return self._batch.checkpoint(world)

    def restore(self, world: int, checkpoint: bytes) -> None:
        self._batch.restore(world, checkpoint)
        self._needs_reset[world] = False

    def close_extras(self, **kwargs: Any) -> None:
        self.__dict__.pop("_batch", None)

    def __enter__(self) -> "SimForgeVectorEnv":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # -------------------------------------------------------------- helpers

    def _seeds(self, seed: int | Sequence[int] | None, options: Mapping[str, Any] | None) -> list[Any] | None:
        if seed is None:
            explicit = None if options is None else options.get("seeds")
            if explicit is None:
                return None
            seeds = list(explicit)
        elif isinstance(seed, int):
            seeds = [seed + i for i in range(self.num_envs)]
        else:
            seeds = list(seed)
        if len(seeds) != self.num_envs:
            raise ValueError(f"need {self.num_envs} seeds, got {len(seeds)}")
        return seeds

    @staticmethod
    def _observation(view: BatchView) -> dict[str, np.ndarray]:
        obs = {"state_vector": view.state_vector, "objects": view.objects}
        bev = view.bev
        if bev is not None:
            obs["bev"] = bev
        return obs

    def _infos(self, view: BatchView) -> dict[str, Any]:
        n = self.num_envs
        mask = np.ones(n, dtype=np.bool_)
        infos: dict[str, Any] = {
            "t_s": view.t_s,
            "_t_s": mask,
            "ego": self._ego_array,
            "_ego": mask,
            "reward_terms": view.reward_terms,
            "_reward_terms": mask,
            "object_ids": np.array([view.object_ids(i) for i in range(n)], dtype=object),
            "_object_ids": mask,
        }
        if self.info_channel:
            channel = [json.loads(view.info_json(i)) for i in range(n)]
            for key in ("events", "minima", "causal"):
                infos[key] = np.array([entry[key] for entry in channel], dtype=object)
                infos[f"_{key}"] = mask
        return infos
