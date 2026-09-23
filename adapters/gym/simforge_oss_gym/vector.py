"""Gymnasium ``VectorEnv`` over one native ``EpisodeBatch``.

N independent worlds step together in the Rust runtime (CPU-parallel over
worlds, GIL released). Every ``step`` is one native call: a dense action matrix
in, world-major observation/reward/flag arrays out.

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

from .env import ActionMode, action_matrix, action_space_for, observation_space_for
from .episodes import EpisodeSpec, LoadedEpisode, episode_config, kernel_episode_spec, load_episode_spec
from .native import REWARD_TERM_NAMES, EpisodeBatch, EpisodeBatchView


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
        observation_preset: str | None = None,
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
        base_config = {**base_config, **(episode_config_overrides or {})}
        config = episode_config(base_config, decision_hz=decision_hz, clip_seconds=clip_seconds, max_decisions=max_decisions, bev=bev, observation_preset=observation_preset)
        self._batch = EpisodeBatch(
            [kernel_episode_spec(ep, config) for ep in episodes], [ep.graph for ep in episodes],
            threads, info_channel=info_channel,
        )
        self.num_envs: int = self._batch.size
        self.egos: tuple[str, ...] = tuple(self._batch.egos)
        self.decision_hz: int = self._batch.decision_hz
        self.action_mode: ActionMode = action_mode
        self.info_channel = info_channel
        self._signals_enabled = bool(config.get("observation", {}).get("signals"))
        self.single_action_space = action_space_for(action_mode)
        self.single_observation_space = observation_space_for(self._batch.max_objects, self._batch.bev_shape)
        self.action_space = batch_space(self.single_action_space, self.num_envs)
        self.observation_space = batch_space(self.single_observation_space, self.num_envs)
        self._ego_array = np.array(self.egos, dtype=object)

    # ------------------------------------------------------------------ api

    def reset(
        self, *, seed: int | Sequence[int] | None = None, options: Mapping[str, Any] | None = None
    ) -> tuple[dict[str, np.ndarray], dict[str, Any]]:
        seeds = self._seeds(seed, options)
        view = self._batch.reset_all(seeds)
        self._signals_enabled = view.signals_json(0) is not None
        return self._observation(view), self._infos(view)

    def step(
        self, actions: np.ndarray | Sequence[Any]
    ) -> tuple[dict[str, np.ndarray], np.ndarray, np.ndarray, np.ndarray, dict[str, Any]]:
        view = self._batch.step_all(action_matrix(self.action_mode, actions, self.num_envs))
        return self._observation(view), view.reward, view.terminated, view.truncated, self._infos(view)

    def checkpoint(self) -> bytes:
        """Whole-batch continuation, including traces and pending autoresets."""
        return self._batch.checkpoint()

    def restore(self, checkpoint: bytes) -> tuple[dict[str, np.ndarray], dict[str, Any]]:
        view = self._batch.restore(checkpoint)
        self._signals_enabled = view.signals_json(0) is not None
        return self._observation(view), self._infos(view)

    def trace_digests(self) -> tuple[str, ...]:
        return tuple(self._batch.trace_digests())

    def close_extras(self, **kwargs: Any) -> None:
        self.__dict__.pop("_batch", None)

    def __enter__(self) -> "SimForgeVectorEnv":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # -------------------------------------------------------------- helpers

    def _seeds(self, seed: int | Sequence[int] | None, options: Mapping[str, Any] | None) -> int | list[Any] | None:
        if seed is None:
            explicit = None if options is None else options.get("seeds")
            if explicit is None:
                return None
            seeds = list(explicit)
        elif isinstance(seed, int):
            return seed  # seed+i expansion belongs to the kernel
        else:
            seeds = list(seed)
        if len(seeds) != self.num_envs:
            raise ValueError(f"need {self.num_envs} seeds, got {len(seeds)}")
        return seeds

    @staticmethod
    def _observation(view: EpisodeBatchView) -> dict[str, np.ndarray]:
        obs = {"state_vector": view.state_vector, "objects": view.objects}
        bev = view.bev
        if bev is not None:
            obs["bev"] = bev
        return obs

    def _infos(self, view: EpisodeBatchView) -> dict[str, Any]:
        n = self.num_envs
        mask = np.ones(n, dtype=np.bool_)
        infos: dict[str, Any] = {
            "t_s": view.t_s,
            "_t_s": mask,
            "ego": self._ego_array,
            "_ego": mask,
            "reward_terms": view.reward_terms,
            "_reward_terms": mask,
            "reward_term_names": REWARD_TERM_NAMES,
            "collision": view.collision,
            "_collision": mask,
            "goal": view.goal,
            "_goal": mask,
            "autoreset": view.autoreset,
            "_autoreset": mask,
            "term_reason": np.array(view.term_reasons, dtype=object),
            "_term_reason": mask,
            "object_ids": np.array([view.object_ids(i) for i in range(n)], dtype=object),
            "_object_ids": mask,
        }
        if self._signals_enabled:
            signals = np.empty(n, dtype=object)
            signals[:] = [json.loads(view.signals_json(i)) for i in range(n)]
            infos["signals"] = signals
            infos["_signals"] = mask
        if self.info_channel:
            channel = [json.loads(view.info_json(i)) for i in range(n)]
            for key in ("events", "minima", "causal"):
                infos[key] = np.array([entry[key] for entry in channel], dtype=object)
                infos[f"_{key}"] = mask
        return infos
