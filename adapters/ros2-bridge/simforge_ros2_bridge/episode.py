"""Native episode session for the bridge.

One :class:`BridgeSession` wraps a ``simforge_oss_gym`` ``EnvSession`` built
from an episode spec (the same spec documents the SDK consumes). Stepping is
in-process and strictly ordered — reset, then one ``step`` per decision — which
is what makes the bridge's lockstep loop deterministic.

Actions are the engine's own named override fields (``ACTION_FIELDS``):
``throttle``/``brake``/``steer`` for raw vehicle control,
``target_speed_mps``/``target_acceleration_mps2`` for longitudinal setpoints.
An empty mapping keeps the scenario's authored choreography. The same named
form is what the bridge records on ``/simforge/applied_action`` (see
:data:`RECORD_SCHEMA`), so a bag replays through :meth:`BridgeSession.step`
without any translation.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

import numpy as np

from simforge_oss_gym.episodes import episode_config_json, load_episode_spec
from simforge_oss_gym.native import ACTION_FIELDS, ACTION_WIDTH, ENGINE_HZ, STATE_VECTOR_SIZE, EnvSession, StepView

#: Schema of the bridge-owned bag records (``/simforge/episode`` events and
#: ``/simforge/applied_action`` payloads). Bumped whenever their shape changes;
#: replay refuses bags recorded under any other value.
RECORD_SCHEMA = 2

_SLOT = {name: index for index, name in enumerate(ACTION_FIELDS)}


@dataclass(frozen=True)
class Decision:
    """The observation returned by one reset or step."""

    t: float
    reward: float
    terminated: bool
    truncated: bool
    #: ``(STATE_VECTOR_SIZE,)`` float64: x, y, cos h, sin h, speed, accel,
    #: lateral offset, lateral rate, route s, nearest-actor range.
    state_vector: np.ndarray

    @property
    def state_bytes(self) -> bytes:
        """Little-endian float64 bytes of the state vector (the digest input)."""
        return np.ascontiguousarray(self.state_vector, dtype="<f8").tobytes()


def decision_of(view: StepView) -> Decision:
    sv = view.state_vector
    if sv.shape != (STATE_VECTOR_SIZE,):
        raise RuntimeError(
            f"episode config disables the state vector (got shape {sv.shape}); the bridge needs observation.stateVector"
        )
    return Decision(float(view.t_s), float(view.reward), bool(view.terminated), bool(view.truncated), sv)


def encode_action(action: Mapping[str, Any], out: np.ndarray) -> np.ndarray | None:
    """Named override fields -> flat native row; ``None`` for the authored choreography."""
    if not action:
        return None
    out.fill(np.nan)
    for name, value in action.items():
        slot = _SLOT.get(name)
        if slot is None:
            raise ValueError(f"unknown action field {name!r}; engine fields are {ACTION_FIELDS}")
        out[slot] = float(value)
    return out


class BridgeSession:
    """One episode of an episode spec, stepped in lockstep by the bridge."""

    def __init__(self, spec_path: str | Path, session: int = 0, *, maps_dir: str | Path | None = None) -> None:
        spec = load_episode_spec(spec_path, maps_dir=maps_dir)
        if session >= len(spec.episodes):
            raise IndexError(f"session {session} requested but the spec has {len(spec.episodes)} episodes")
        self.spec_path = Path(spec_path).resolve()
        self.session_index = session
        self.episode = spec.episodes[session]
        self.sessions = len(spec.episodes)
        self._row = np.empty(ACTION_WIDTH, dtype=np.float64)
        self._session = EnvSession(self.episode.input, self.episode.graph, episode_config_json(spec.episode_config))
        self.ego: str = self._session.ego
        self.decision_hz: int = self._session.decision_hz
        self.engine_hz: int = ENGINE_HZ

    @property
    def native(self) -> EnvSession:
        return self._session

    def reset(self, seed: str | int | None = None) -> Decision:
        return decision_of(self._session.reset(seed))

    def step(self, action: Mapping[str, Any] | None) -> Decision:
        """Hold ``action`` for one decision interval; empty/``None`` keeps the choreography."""
        return decision_of(self._session.step(encode_action(action or {}, self._row)))

    def close(self) -> None:
        self.__dict__.pop("_session", None)

    def __enter__(self) -> "BridgeSession":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()
