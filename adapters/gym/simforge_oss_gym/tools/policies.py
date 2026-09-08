"""Reference policies for the policy runner.

All are deterministic given their construction arguments: the scripted
policies are pure functions of the step index; the torch policy derives its
weights from ``torch.manual_seed`` and runs inference in no-grad eval mode,
so identical seeds yield bit-identical actions on one machine.

Policies return a :class:`PolicyDecision`: the current policy action document
(``{"kind": "control", ...}`` or ``{"kind": "trajectory", "points": [...]}``)
plus optional reasoning text. The runner stores both in the digested trace.
"""

from __future__ import annotations

import hashlib
import math
from dataclasses import dataclass
from typing import Any, Protocol, Sequence

import numpy as np


def control(throttle: float, brake: float, steer: float) -> dict[str, Any]:
    return {"kind": "control", "throttle": float(throttle), "brake": float(brake), "steer": float(steer)}


def trajectory(points: Sequence[tuple[float, float, float, float, float]]) -> dict[str, Any]:
    """Points are ``(x, y, heading_rad, speed_mps, t_s)`` in the ego frame at issuance."""
    return {"kind": "trajectory", "points": [[float(v) for v in point] for point in points]}


@dataclass(frozen=True)
class PolicyDecision:
    action: dict[str, Any]
    reasoning: str | None = None


class Policy(Protocol):
    name: str
    checkpoint_digest: str

    def act(self, step: int, state_vector: np.ndarray | None) -> PolicyDecision:
        """Return the decision for this step."""


class ScriptedPolicy:
    """Smooth open-loop throttle/steer schedule; ignores observations."""

    name = "scripted"
    #: Content digest of the (frozen) schedule below — the scripted policy's "weights".
    checkpoint_digest = hashlib.sha256(b"scripted-v1:throttle=0.35+0.15*sin(step/5.0);brake=0;steer=0.02*sin(step/7.0)").hexdigest()

    def act(self, step: int, state_vector: np.ndarray | None) -> PolicyDecision:
        throttle = 0.35 + 0.15 * math.sin(step / 5.0)
        steer = 0.02 * math.sin(step / 7.0)
        return PolicyDecision(control(throttle, 0.0, steer))


class ScriptedTrajectoryPolicy:
    """Ego-frame S-curve plans, replanned at the Alpamayo cadence.

    Emits a 4 s trajectory every ``replan_every`` decisions (default 20 =
    0.5 Hz at 10 Hz decisions) and *resends the identical points* in between:
    the executor's zero-order hold keeps the original anchor, so the ego tracks
    one plan per replan window. Reasoning text is produced on replan acts only.

    The global path is a crest-anchored cosine ``y(t) = A(cos(wt) - 1)`` whose
    tangent at t = 0 is zero, matching the ego's lane-aligned starting yaw; the
    policy is open-loop, so each replan assumes the ego sits on the path
    aligned with its tangent. The plan-relative cross-track error in the
    executor telemetry is the tracking truth.
    """

    name = "scripted-trajectory"
    checkpoint_digest = hashlib.sha256(b"scripted-trajectory-v1:cosine-crest-s-curve").hexdigest()

    def __init__(
        self,
        *,
        speed_mps: float = 8.0,
        amplitude_m: float = 1.5,
        period_s: float = 10.0,
        horizon_s: float = 4.0,
        sample_s: float = 0.4,
        replan_every: int = 20,
        decision_hz: float = 10.0,
    ) -> None:
        self.speed = speed_mps
        self.amplitude = amplitude_m
        self.period = period_s
        self.horizon = horizon_s
        self.sample = sample_s
        self.replan_every = replan_every
        self.decision_hz = decision_hz
        self._held: dict[str, Any] | None = None
        #: Whether the most recent decision issued a new plan (ZOH resend = False).
        self.last_replanned = False

    def act(self, step: int, state_vector: np.ndarray | None) -> PolicyDecision:
        if step % self.replan_every != 0 and self._held is not None:
            self.last_replanned = False
            return PolicyDecision(self._held)
        self.last_replanned = True
        t0 = step / self.decision_hz
        w = 2.0 * math.pi / self.period
        y0 = self.amplitude * (math.cos(w * t0) - 1.0)
        h0 = math.atan2(-self.amplitude * w * math.sin(w * t0), self.speed)
        cos_h, sin_h = math.cos(h0), math.sin(h0)
        points = []
        for j in range(1, round(self.horizon / self.sample) + 1):
            t = j * self.sample
            vy = -self.amplitude * w * math.sin(w * (t0 + t))
            gx = self.speed * t
            gy = self.amplitude * (math.cos(w * (t0 + t)) - 1.0) - y0
            points.append((gx * cos_h + gy * sin_h, -gx * sin_h + gy * cos_h, math.atan2(vy, self.speed) - h0, math.hypot(self.speed, vy), t))
        self._held = trajectory(points)
        bearing = "right" if math.sin(w * (t0 + self.horizon / 2)) >= 0 else "left"
        reasoning = (
            f"scripted S-curve replan {step // self.replan_every}: bearing {bearing}, "
            f"amplitude {self.amplitude} m, period {self.period} s, {self.speed} m/s, {len(points)} pts over {self.horizon} s"
        )
        return PolicyDecision(self._held, reasoning)


class TorchMlpPolicy:
    """Tiny random MLP over the 10-dim state vector; seeded, eval-mode, no-grad."""

    name = "torch-mlp"

    def __init__(self, seed: int = 0) -> None:
        import torch  # deferred: keeps the scripted path torch-free

        self._torch = torch
        torch.manual_seed(seed)
        self.net = torch.nn.Sequential(
            torch.nn.Linear(10, 32),
            torch.nn.Tanh(),
            torch.nn.Linear(32, 32),
            torch.nn.Tanh(),
            torch.nn.Linear(32, 3),
        )
        self.net.eval()
        digest = hashlib.sha256()
        for key, tensor in sorted(self.net.state_dict().items()):
            digest.update(key.encode())
            digest.update(tensor.detach().cpu().contiguous().numpy().tobytes())
        self.checkpoint_digest = digest.hexdigest()

    def act(self, step: int, state_vector: np.ndarray | None) -> PolicyDecision:
        torch = self._torch
        observation = np.zeros(10, dtype=np.float32) if state_vector is None else state_vector.astype(np.float32)
        with torch.no_grad():
            out = self.net(torch.from_numpy(observation))
        throttle = float(torch.sigmoid(out[0])) * 0.8
        steer = float(torch.tanh(out[2])) * 0.3
        return PolicyDecision(control(throttle, 0.0, steer))


def make_policy(name: str, seed: int = 0) -> Policy:
    if name == "scripted":
        return ScriptedPolicy()
    if name == "trajectory":
        return ScriptedTrajectoryPolicy()
    if name == "torch":
        return TorchMlpPolicy(seed)
    raise ValueError(f"unknown policy {name!r} (expected 'scripted', 'trajectory' or 'torch')")


def make_recorded_path_policy(
    recorded_path: Sequence[tuple[float, float, float, float]], decision_hz: float = 10.0
) -> Policy:
    """The G5 stock-replay policy over a replay-context bundle's recorded path."""
    return RecordedPathPolicy(recorded_path, decision_hz=decision_hz)


class RecordedPathPolicy:
    """Forced ground truth: drive the scene's own recorded ego path.

    This is the G5 stock-replay policy. It emits, at every decision, the
    upcoming recorded poses transformed into the ego frame at issuance, so the
    sim, the pure-pursuit executor and the scoring chain are exercised with the
    trajectory the world was recorded from. If a stock replay cannot reproduce
    the recorded path within tolerance and without infractions, no model score
    from that scene means anything — which is why this runs before any model.

    ``recorded_path`` rows are ``(t_s, x, y, heading_rad)`` in the bundle's
    metric world frame, ascending in time. Nothing is invented: when the
    horizon runs past the recording, the plan is whatever remains.
    """

    name = "recorded-path"

    def __init__(
        self,
        recorded_path: Sequence[tuple[float, float, float, float]],
        *,
        decision_hz: float = 10.0,
        horizon_s: float = 2.0,
        sample_s: float = 0.2,
    ) -> None:
        if len(recorded_path) < 2:
            raise ValueError("recorded_path needs at least two poses")
        self.path = [tuple(float(v) for v in row) for row in recorded_path]
        self.decision_hz = float(decision_hz)
        self.horizon = float(horizon_s)
        self.sample = float(sample_s)
        self.checkpoint_digest = hashlib.sha256(
            b"recorded-path-v1:" + repr([tuple(round(v, 6) for v in row) for row in self.path]).encode()
        ).hexdigest()
        self.last_replanned = True

    def _pose_at(self, t: float) -> tuple[float, float, float]:
        """Recorded pose at ``t`` seconds, linearly interpolated, clamped."""
        path = self.path
        if t <= path[0][0]:
            return path[0][1], path[0][2], path[0][3]
        for index in range(1, len(path)):
            if path[index][0] >= t:
                t0, x0, y0, h0 = path[index - 1]
                t1, x1, y1, h1 = path[index]
                span = t1 - t0
                u = 0.0 if span <= 0 else (t - t0) / span
                return x0 + u * (x1 - x0), y0 + u * (y1 - y0), h0 + u * math.atan2(math.sin(h1 - h0), math.cos(h1 - h0))
        return path[-1][1], path[-1][2], path[-1][3]

    def act(self, step: int, state_vector: np.ndarray | None) -> PolicyDecision:
        t0 = self.path[0][0] + step / self.decision_hz
        x0, y0, h0 = self._pose_at(t0)
        cos_h, sin_h = math.cos(-h0), math.sin(-h0)
        points: list[tuple[float, float, float, float, float]] = []
        previous = (0.0, 0.0)
        for index in range(1, int(round(self.horizon / self.sample)) + 1):
            t = index * self.sample
            xw, yw, hw = self._pose_at(t0 + t)
            dx, dy = xw - x0, yw - y0
            ex, ey = dx * cos_h - dy * sin_h, dx * sin_h + dy * cos_h
            speed = math.hypot(ex - previous[0], ey - previous[1]) / self.sample
            points.append((ex, ey, math.atan2(math.sin(hw - h0), math.cos(hw - h0)), speed, t))
            previous = (ex, ey)
        self.last_replanned = True
        return PolicyDecision(trajectory(points), f"stock replay: recorded path from t={t0:.2f}s")
