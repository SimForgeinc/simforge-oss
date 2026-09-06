"""Live/clip ``WorldSession`` and truth subscriptions over the native runtime.

Commands are plain dicts in the current ``WorldCommand`` shape
(``{"kind": "spawn"|"despawn"|"batch"|"act", ...}``); the world executes them
atomically and records a replayable log whose digest is deterministic.
Truth frames are the current scene-state documents, delivered per engine tick
to bounded drop-oldest subscribers.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Iterator, Mapping, Sequence

import numpy as np

from .episodes import LoadedEpisode, load_episode_spec
from .native import LaneGraph, ScenarioInput, TruthSubscription, WorldSession, WorldSnapshot, replay_world_log


class TruthStream:
    """Pull-based per-tick ground-truth reader for one :class:`SimForgeWorld`."""

    def __init__(self, subscription: TruthSubscription) -> None:
        self._subscription = subscription

    def drain(self) -> list[dict[str, Any]]:
        """Every queued tick frame, oldest first."""
        return [json.loads(frame) for frame in self._subscription.drain()]

    def frames(self) -> Iterator[dict[str, Any]]:
        yield from self.drain()

    @property
    def dropped(self) -> int:
        return self._subscription.dropped

    @property
    def queued(self) -> int:
        return self._subscription.queued

    def close(self) -> None:
        self._subscription.close()

    def __enter__(self) -> "TruthStream":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()


class SimForgeWorld:
    """Command-driven world with atomic edits, checkpoint/replay and truth subscribers."""

    def __init__(
        self,
        episodes_spec: str | Path | None = None,
        *,
        episode: LoadedEpisode | None = None,
        session: int = 0,
        mode: str = "clip",
        horizon_seconds: float | None = None,
        client_id: str = "python",
        maps_dir: str | Path | None = None,
    ) -> None:
        if (episodes_spec is None) == (episode is None):
            raise ValueError("pass exactly one of episodes_spec or episode")
        if episodes_spec is not None:
            spec = load_episode_spec(episodes_spec, maps_dir=maps_dir)
            episode = spec.episodes[session]
        assert episode is not None
        options: dict[str, Any] = {"mode": mode}
        if horizon_seconds is not None:
            options["horizonSeconds"] = float(horizon_seconds)
        self.episode = episode
        self.client_id = client_id
        self._seq = 0
        self._session = WorldSession(episode.input, episode.graph, json.dumps(options))

    @property
    def time_s(self) -> float:
        return self._session.time

    @property
    def tick(self) -> int:
        return self._session.tick

    @property
    def digest(self) -> str:
        return self._session.digest

    def command(self, command: Mapping[str, Any]) -> dict[str, Any]:
        """Apply one command; returns ``{"ok", "actorIds", "error"}``."""
        self._seq += 1
        return json.loads(self._session.command(json.dumps(command), self.client_id, self._seq))

    def spawn(self, **spawn: Any) -> dict[str, Any]:
        return self.command({"kind": "spawn", "spawn": spawn})

    def despawn(self, actor_id: str) -> dict[str, Any]:
        return self.command({"kind": "despawn", "actorId": actor_id})

    def batch(self, ops: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
        """Atomic: every op applies or none does."""
        return self.command({"kind": "batch", "ops": list(ops)})

    def act(self, actor_id: str, action: Mapping[str, Any] | None) -> dict[str, Any]:
        """Zero-order-hold override for ``actor_id``; ``None`` releases it."""
        return self.command({"kind": "act", "actorId": actor_id, "action": None if action is None else dict(action)})

    def advance(self, ticks: int) -> dict[str, Any]:
        return json.loads(self._session.advance(int(ticks)))

    def snapshot(self) -> WorldSnapshot:
        return self._session.snapshot()

    def actor_frame(self) -> dict[str, Any]:
        """Snapshot as columnar arrays: ids, kinds, present, pose ``(N, 5)``."""
        snap = self._session.snapshot()
        return {
            "t_s": snap.t_s,
            "tick": snap.tick,
            "done": snap.done,
            "actor_ids": snap.actor_ids,
            "kinds": snap.kinds,
            "lane_rsls": snap.lane_rsls,
            "present": np.asarray(snap.present),
            "pose": np.asarray(snap.pose),
        }

    def subscribe(self, capacity: int | None = None) -> TruthStream:
        return TruthStream(self._session.subscribe(capacity))

    def log(self) -> dict[str, Any]:
        return json.loads(self._session.log_json())

    def checkpoint(self) -> bytes:
        return self._session.checkpoint()

    def restore(self, checkpoint: bytes) -> None:
        self._session.restore(checkpoint)

    def replay(self, log: Mapping[str, Any] | None = None) -> dict[str, Any]:
        """Replay ``log`` (default: this world's log) against the same scenario; the digest must match."""
        document = json.dumps(self.log() if log is None else log)
        return json.loads(replay_world_log(document, self.episode.input, self.episode.graph))

    def close(self) -> None:
        self.__dict__.pop("_session", None)

    def __enter__(self) -> "SimForgeWorld":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()


def replay_log(log: Mapping[str, Any], input: ScenarioInput, graph: LaneGraph) -> dict[str, Any]:
    return json.loads(replay_world_log(json.dumps(log), input, graph))
