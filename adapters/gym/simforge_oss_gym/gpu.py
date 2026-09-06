"""Gymnasium ``VectorEnv`` over the ``roadway-dynamic-gpu-v1`` device batch.

Provider: ``simforge-oss-gpu`` (``pip install simforge-oss-gym[gpu]``; Warp,
CUDA device required). The document is admitted at construction: every
unsupported feature is reported through ``ProfileAdmissionError`` and nothing
is approximated.

Observations are **torch tensors on the batch device**. The provider hands out
an owned ``OutputLease`` per call from a bounded ring; tensors are exported on
the caller's current torch stream (made to wait on the producer's readiness
event, no host sync). This env requests hand-back of the previous lease on
every call; the provider only reuses a slot once every tensor exported from it
has been collected, so retained observations stay valid and merely keep their
slot outstanding (``LeaseExhaustedError`` once the whole ring is retained).
Action storage is persistent and marked ready on the writer stream each step.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Mapping, Sequence

import numpy as np
from gymnasium import spaces
from gymnasium.vector import AutoresetMode, VectorEnv
from gymnasium.vector.utils import batch_space

try:
    from simforge_oss_gpu.batch import ActionBatch, Checkpoint, OutputLease, RoadwayGpuBatch
    from simforge_oss_gpu.lane_graph import LaneGraph as GpuLaneGraph
    from simforge_oss_gpu.profile import PROFILE_ID
except ImportError as error:  # pragma: no cover - extras guard
    raise ImportError("the roadway-dynamic-gpu-v1 profile needs simforge-oss-gpu and warp-lang: `pip install simforge-oss-gym[gpu]`") from error

import torch

from .env import ActionMode, action_space_for
from .episodes import EpisodeSpec, LoadedEpisode, episode_config, load_episode_spec
from .native import STATE_VECTOR_SIZE

#: Device action columns of the provider's ``ActionBatch.values``.
_VAL = {"dir": 0, "speed": 1, "accel": 2, "px": 3, "py": 4, "pheading": 5, "throttle": 6, "brake": 7, "steer": 8}
#: ``ActionBatch.valid`` columns.
_VALID = {"pending": 0, "dir": 1, "speed": 2, "accel": 3, "preview": 4, "pheading": 5, "control": 6}


def _gpu_graph(topology: bytes) -> GpuLaneGraph:
    import gzip

    raw = gzip.decompress(topology) if topology[:2] == b"\x1f\x8b" else topology
    return GpuLaneGraph(json.loads(raw))


class SimForgeGpuVectorEnv(VectorEnv):
    """N device-resident worlds of one admitted scenario document.

    All worlds run the same document (``session`` selects it from the spec) with
    per-world seeds; that is the provider's batch layout. ``NEXT_STEP``
    autoreset: finished worlds are passed back as the reset mask on the next
    ``step``, exactly the provider's own semantics.
    """

    metadata: dict[str, Any] = {"render_modes": [], "autoreset_mode": AutoresetMode.NEXT_STEP, "profile": PROFILE_ID}

    def __init__(
        self,
        episodes_spec: str | Path | None = None,
        *,
        episode: LoadedEpisode | None = None,
        session: int = 0,
        num_envs: int,
        device: str = "cuda:0",
        action_mode: ActionMode = "setpoint",
        decision_hz: int | None = None,
        clip_seconds: float | None = None,
        max_decisions: int | None = None,
        episode_config_overrides: Mapping[str, Any] | None = None,
        use_cuda_graph: bool = True,
        lease_slots: int = 4,
        maps_dir: str | Path | None = None,
    ) -> None:
        if (episodes_spec is None) == (episode is None):
            raise ValueError("pass exactly one of episodes_spec or episode")
        base_config: Mapping[str, Any] = {}
        if episodes_spec is not None:
            spec: EpisodeSpec = load_episode_spec(episodes_spec, maps_dir=maps_dir)
            episode = spec.episodes[session]
            base_config = spec.episode_config
        assert episode is not None
        config = episode_config(base_config, decision_hz=decision_hz, clip_seconds=clip_seconds, max_decisions=max_decisions)
        if episode_config_overrides:
            config.update(episode_config_overrides)
        if config.get("observation", {}).get("bev"):
            raise ValueError("roadway-dynamic-gpu-v1 does not produce BEV rasters; remove observation.bev")

        document = json.loads(episode.input.to_json())
        self._batch = RoadwayGpuBatch(
            document, _gpu_graph(episode.topology_bytes), num_worlds=num_envs, episode=config or None, device=device, use_cuda_graph=use_cuda_graph, lease_slots=lease_slots
        )
        self.device: torch.device = self._batch.torch_device
        self.num_envs = num_envs
        self.ego: str = self._batch.ego_id
        self.actor_ids: tuple[str, ...] = tuple(self._batch.actor_ids)
        self.action_mode: ActionMode = action_mode
        max_objects = len(self.actor_ids)
        self.single_action_space = action_space_for(action_mode)
        self.single_observation_space = spaces.Dict(
            {
                "state_vector": spaces.Box(-np.inf, np.inf, (STATE_VECTOR_SIZE,), np.float64),
                "objects": spaces.Box(-np.inf, np.inf, (max_objects, 4), np.float64),
                "objects_valid": spaces.MultiBinary(max_objects),
            }
        )
        self.action_space = batch_space(self.single_action_space, num_envs)
        self.observation_space = batch_space(self.single_observation_space, num_envs)

        # Persistent action storage: the CUDA graph is captured against these pointers.
        self._values = torch.full((num_envs, 9), float("nan"), dtype=torch.float64, device=self.device)
        self._valid = torch.zeros((num_envs, 7), dtype=torch.int32, device=self.device)
        self._actions = ActionBatch.from_torch(self._values, self._valid, stream=torch.cuda.current_stream(self.device))
        self._needs_reset = torch.zeros(num_envs, dtype=torch.bool, device=self.device)
        #: Lease of the most recent call; its tensors are what the last step returned.
        self.last_lease: OutputLease | None = None

    # ------------------------------------------------------------------ api

    def reset(self, *, seed: int | Sequence[int] | None = None, options: Mapping[str, Any] | None = None) -> tuple[dict[str, torch.Tensor], dict[str, Any]]:
        seeds = None
        if isinstance(seed, int):
            seeds = np.arange(seed, seed + self.num_envs, dtype=np.int64)
        elif seed is not None:
            seeds = np.asarray(list(seed), dtype=np.int64)
            if seeds.shape != (self.num_envs,):
                raise ValueError(f"need {self.num_envs} seeds, got {seeds.shape}")
        elif options and options.get("seeds") is not None:
            seeds = np.asarray(list(options["seeds"]), dtype=np.int64)
        self._release_last()
        lease = self._batch.reset(None, seeds)
        self.last_lease = lease
        self._needs_reset.zero_()
        return self._observation(lease), self._infos(lease)

    def step(self, actions: torch.Tensor | np.ndarray) -> tuple[dict[str, torch.Tensor], torch.Tensor, torch.Tensor, torch.Tensor, dict[str, Any]]:
        rows = torch.as_tensor(actions, dtype=torch.float64, device=self.device)
        if rows.shape[0] != self.num_envs:
            raise ValueError(f"need {self.num_envs} actions, got {rows.shape[0]}")
        stream = torch.cuda.current_stream(self.device)
        self._encode(rows)
        # The producer stream waits on this event before reading the action storage; no host sync.
        self._actions.mark_ready(stream)
        self._release_last()
        if bool(self._needs_reset.any()):
            self._batch.reset(self._needs_reset.cpu().numpy(), None).release()
        lease = self._batch.step(self._actions)
        self.last_lease = lease
        tensors = lease.torch(stream)
        terminated = tensors["terminated"].to(torch.bool)
        truncated = tensors["truncated"].to(torch.bool)
        self._needs_reset = terminated | truncated
        return self._observation(lease), tensors["reward"], terminated, truncated, self._infos(lease)

    def checkpoint(self) -> Checkpoint:
        return self._batch.checkpoint()

    def restore(self, checkpoint: Checkpoint) -> dict[str, torch.Tensor]:
        self._release_last()
        lease = self._batch.restore(checkpoint)
        self.last_lease = lease
        self._needs_reset = lease.torch(torch.cuda.current_stream(self.device))["ended"].to(torch.bool)
        return self._observation(lease)

    def capabilities(self) -> dict[str, Any]:
        return self._batch.capabilities()

    def close_extras(self, **kwargs: Any) -> None:
        self._release_last()
        self.__dict__.pop("_batch", None)

    def __enter__(self) -> "SimForgeGpuVectorEnv":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # -------------------------------------------------------------- helpers

    def _release_last(self) -> None:
        """Request hand-back of the previous lease.

        The provider hands the slot back only once every tensor exported from it
        has been collected, and makes the producer wait device-side on events
        recorded on every registered consumer stream; tensors a caller still
        holds therefore stay valid and simply keep that slot retained.
        """
        if self.last_lease is None:
            return
        self.last_lease.release()
        self.last_lease = None

    def _encode(self, rows: torch.Tensor) -> None:
        self._values.fill_(float("nan"))
        self._valid.zero_()
        self._valid[:, _VALID["pending"]] = 1
        if self.action_mode == "setpoint":
            if rows.shape[1] != 2:
                raise ValueError(f"setpoint actions must be (N, 2), got {tuple(rows.shape)}")
            self._values[:, _VAL["speed"]] = rows[:, 0]
            self._values[:, _VAL["accel"]] = rows[:, 1]
            self._valid[:, _VALID["speed"]] = 1
            self._valid[:, _VALID["accel"]] = 1
        else:
            if rows.shape[1] != 3:
                raise ValueError(f"control actions must be (N, 3), got {tuple(rows.shape)}")
            self._values[:, _VAL["throttle"]] = rows[:, 0]
            self._values[:, _VAL["brake"]] = rows[:, 1]
            self._values[:, _VAL["steer"]] = rows[:, 2]
            self._valid[:, _VALID["control"]] = 1

    def _observation(self, lease: OutputLease) -> dict[str, torch.Tensor]:
        tensors = lease.torch(torch.cuda.current_stream(self.device))
        return {"state_vector": tensors["state_vector"], "objects": tensors["objects"], "objects_valid": tensors["objects_valid"].to(torch.bool)}

    def _infos(self, lease: OutputLease) -> dict[str, Any]:
        tensors = lease.torch(torch.cuda.current_stream(self.device))
        mask = np.ones(self.num_envs, dtype=np.bool_)
        return {
            "t_s": tensors["t_s"],
            "_t_s": mask,
            "reward_terms": tensors["reward_terms"],
            "_reward_terms": mask,
            "ego": np.array([self.ego] * self.num_envs, dtype=object),
            "_ego": mask,
        }
