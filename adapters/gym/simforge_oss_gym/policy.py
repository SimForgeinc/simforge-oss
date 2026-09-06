"""Deadline-accounted policy execution over a native ``EnvSession``.

Control actions pass through to the force-based backend; ego-frame trajectory
plans are anchored at issuance and tracked by the engine's pure-pursuit
follower (``execution="pure-pursuit"``) or reduced to a speed setpoint
(``"speed-setpoint"``). A decision whose reported inference latency exceeds
``deadline_ms`` applies the fallback (``repeat-last`` | ``zero-control`` |
``scripted``) deterministically; the verdict rides on every result.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Mapping

import numpy as np

from .env import SimForgeEnv, info_of, observation_of
from .native import PolicySession, PolicyStep, StepView


@dataclass(frozen=True)
class Decision:
    """One resolved decision."""

    observation: dict[str, np.ndarray]
    reward: float
    terminated: bool
    truncated: bool
    info: dict[str, Any]
    #: ``policy`` | ``repeat-last`` | ``zero-control`` | ``scripted``.
    applied: str
    deadline_miss: bool
    deadline_limit_ms: float | None
    deadline_elapsed_ms: float | None
    #: Pure-pursuit executor telemetry (pose, cross-track, setpoints, preview) or ``None``.
    executor: dict[str, Any] | None


class PolicyRunner:
    """Drive one :class:`SimForgeEnv` with control or trajectory actions."""

    def __init__(self, env: SimForgeEnv, *, deadline_ms: float | None = 50.0, fallback: str = "repeat-last", execution: str = "pure-pursuit") -> None:
        self.env = env
        self._session = PolicySession(env.native, deadline_ms, fallback, execution)

    @property
    def execution(self) -> str:
        return self._session.execution

    def reset(self, seed: int | float | str | None = None) -> tuple[dict[str, np.ndarray], dict[str, Any]]:
        view = self._session.reset(seed)
        return observation_of(view), info_of(view, self.env.ego, channel=self.env.info_channel)

    def act_control(self, throttle: float, brake: float, steer: float, *, elapsed_ms: float | None = None) -> Decision:
        return self._decision(self._session.act_control(float(throttle), float(brake), float(steer), elapsed_ms))

    def act_trajectory(self, points: np.ndarray, *, elapsed_ms: float | None = None) -> Decision:
        """``points`` is ``(K, 5)`` rows ``[x, y, heading_rad, speed_mps, t_s]`` in the ego frame at issuance."""
        rows = np.ascontiguousarray(points, dtype=np.float64)
        if rows.ndim != 2 or rows.shape[1] != 5:
            raise ValueError(f"trajectory must be (K, 5), got {rows.shape}")
        return self._decision(self._session.act_trajectory(rows, elapsed_ms))

    def checkpoint(self) -> bytes:
        """Episode + executor continuation state (held plan, last applied action)."""
        return self._session.checkpoint()

    def restore(self, checkpoint: bytes) -> tuple[dict[str, np.ndarray], dict[str, Any]]:
        view = self._session.restore(checkpoint)
        return observation_of(view), info_of(view, self.env.ego, channel=self.env.info_channel)

    def act(self, action: Mapping[str, Any], *, elapsed_ms: float | None = None) -> Decision:
        """Dispatch on the current wire form: ``{"kind": "control", ...}`` or ``{"kind": "trajectory", "points": [...]}``."""
        kind = action.get("kind")
        if kind == "control":
            return self.act_control(action["throttle"], action["brake"], action["steer"], elapsed_ms=elapsed_ms)
        if kind == "trajectory":
            return self.act_trajectory(np.asarray(action["points"], dtype=np.float64), elapsed_ms=elapsed_ms)
        raise ValueError(f"unknown policy action kind {kind!r}")

    def _decision(self, step: PolicyStep) -> Decision:
        view: StepView = step.step
        executor_json = step.executor_json()
        return Decision(
            observation=observation_of(view),
            reward=view.reward,
            terminated=view.terminated,
            truncated=view.truncated,
            info=info_of(view, self.env.ego, channel=self.env.info_channel),
            applied=step.applied,
            deadline_miss=step.deadline_miss,
            deadline_limit_ms=step.deadline_limit_ms,
            deadline_elapsed_ms=step.deadline_elapsed_ms,
            executor=None if executor_json is None else json.loads(executor_json),
        )
