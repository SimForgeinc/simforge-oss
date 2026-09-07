"""Off-trajectory validity envelope enforcement for replay-context episodes.

A reconstructed scene renders faithfully only near the trajectory it was
recorded from. ``simforge.replay-context/v1`` bundles therefore carry a
measured envelope (``validity.envelope``) and a qualification verdict
(``validity.qualified``, gates ``G1``..``G5``). This module reads that bundle
document (owned and produced by the reconstruction workstream) and enforces
the envelope *inside the episode loop*: the first decision whose ego pose
leaves the envelope terminates the episode with ``envelope_exceeded``.

Truncating after the fact would be wrong — every step past the breach is
rendered from unreliable geometry, so the simulation must stop there. A
truncated episode is scored up to the breach and flagged; it is never a
successful model result and never a model failure.

Bundle paths consumed (frozen with the reconstruction owner):
``validity.envelope.{lateralM,longitudinalS,headingRad}``,
``validity.qualified``, ``validity.gates``, ``validity.envelopeBasis``,
``ego.recordedPath[] = {tUs, x, y, headingRad}``, ``ego.originUs``,
``ego.endUs``, ``cameras[].cameraId``.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

BUNDLE_FILENAME = "replay-context.json"
STOCK_REPLAY_GATE = ("qualification", "stock-replay.json")


class ReplayContextError(RuntimeError):
    """Typed replay-context failure carrying a stable code."""

    def __init__(self, code: str, message: str, detail: Mapping[str, Any] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.detail = dict(detail or {})


@dataclass(frozen=True)
class EnvelopeLimits:
    lateral_m: float
    longitudinal_s: float
    heading_rad: float

    def as_dict(self) -> dict[str, float]:
        return {
            "lateralM": self.lateral_m,
            "longitudinalS": self.longitudinal_s,
            "headingRad": self.heading_rad,
        }


@dataclass(frozen=True)
class EnvelopeBreach:
    step: int
    t_s: float
    lateral_m: float
    longitudinal_s: float
    heading_rad: float
    limits: EnvelopeLimits
    #: Which limits failed: any of ``lateral``, ``longitudinal``, ``heading``, ``time-support``.
    breached: tuple[str, ...] = ()

    def as_dict(self) -> dict[str, Any]:
        return {
            "breached": True,
            "breachedLimits": list(self.breached),
            "atStep": self.step,
            "atTS": round(self.t_s, 6),
            "lateralM": round(self.lateral_m, 6),
            "longitudinalS": round(self.longitudinal_s, 6),
            "headingRad": round(self.heading_rad, 6),
            "limits": self.limits.as_dict(),
        }


@dataclass(frozen=True)
class ReplayContext:
    """The parts of a bundle the episode runner needs."""

    scene_id: str
    bundle_dir: Path
    digest: str
    qualified: bool
    limits: EnvelopeLimits
    #: ``(t_s, x, y, heading_rad)`` recorded reference poses, ascending time.
    recorded_path: tuple[tuple[float, float, float, float], ...]
    camera_ids: tuple[int, ...]
    gates: Mapping[str, Any]
    envelope_basis: Mapping[str, Any]

    def input_ref(self) -> dict[str, Any]:
        return {
            "kind": "replay-context",
            "ref": str(self.bundle_dir),
            "digest": self.digest,
            "sceneId": self.scene_id,
            "cameraIds": list(self.camera_ids),
            "envelope": self.limits.as_dict(),
            "envelopeBasis": dict(self.envelope_basis),
            "qualified": self.qualified,
        }


def _require(document: Mapping[str, Any], path: str) -> Any:
    node: Any = document
    for key in path.split("."):
        if not isinstance(node, Mapping) or key not in node:
            raise ReplayContextError(
                "replay_context_invalid",
                f"replay-context bundle is missing `{path}`",
                {"path": path},
            )
        node = node[key]
    return node


def load_replay_context(bundle: str | Path) -> ReplayContext:
    """Load and validate ``<bundle>/replay-context.json``."""
    import hashlib

    directory = Path(bundle).expanduser()
    path = directory / BUNDLE_FILENAME if directory.is_dir() else directory
    if not path.is_file():
        raise ReplayContextError("replay_context_missing", f"no replay-context bundle at {path}")
    raw = path.read_bytes()
    try:
        document = json.loads(raw)
    except json.JSONDecodeError as error:
        raise ReplayContextError("replay_context_invalid", f"{path}: {error}") from error
    schema = document.get("schema")
    if schema != "simforge.replay-context/v1":
        raise ReplayContextError(
            "replay_context_invalid",
            f"{path}: expected schema simforge.replay-context/v1, got {schema!r}",
        )
    envelope = _require(document, "validity.envelope")
    limits = EnvelopeLimits(
        lateral_m=float(_require(envelope, "lateralM")),
        longitudinal_s=float(_require(envelope, "longitudinalS")),
        heading_rad=float(_require(envelope, "headingRad")),
    )
    for name, value in (("lateralM", limits.lateral_m), ("longitudinalS", limits.longitudinal_s), ("headingRad", limits.heading_rad)):
        if not math.isfinite(value) or value < 0.0:
            raise ReplayContextError("replay_context_invalid", f"validity.envelope.{name} must be finite and >= 0, got {value}")
    recorded_raw = _require(document, "ego.recordedPath")
    if not isinstance(recorded_raw, list) or len(recorded_raw) < 2:
        raise ReplayContextError("replay_context_invalid", "ego.recordedPath needs at least two poses")
    origin_us = float(_require(document, "ego.originUs"))
    recorded: list[tuple[float, float, float, float]] = []
    for entry in recorded_raw:
        recorded.append(
            (
                (float(entry["tUs"]) - origin_us) / 1e6,
                float(entry["x"]),
                float(entry["y"]),
                float(entry["headingRad"]),
            )
        )
    recorded.sort(key=lambda row: row[0])
    cameras = document.get("cameras") or []
    camera_ids = tuple(sorted(int(camera["cameraId"]) for camera in cameras))
    return ReplayContext(
        scene_id=str(document.get("sceneId") or path.parent.name),
        bundle_dir=path.parent,
        digest=hashlib.sha256(raw).hexdigest(),
        qualified=bool(document.get("validity", {}).get("qualified", False)),
        limits=limits,
        recorded_path=tuple(recorded),
        camera_ids=camera_ids,
        gates=dict(document.get("validity", {}).get("gates", {})),
        envelope_basis=dict(document.get("validity", {}).get("envelopeBasis", {})),
    )


def stock_replay_verdict(context: ReplayContext) -> dict[str, Any] | None:
    """The G5 stock-replay verdict file, when the bundle carries one."""
    path = context.bundle_dir.joinpath(*STOCK_REPLAY_GATE)
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError as error:
        raise ReplayContextError("replay_context_invalid", f"{path}: {error}") from error


def require_model_episode_admission(context: ReplayContext) -> None:
    """Refuse a model episode on a scene whose validity is not proven.

    ``validity.qualified`` false (any of G1..G5 failing) means renders off the
    recorded trajectory are not trustworthy, so a policy episode on that scene
    would produce a number with no meaning. Refusing is the correct outcome —
    not scoring it as a model failure.
    """
    if not context.qualified:
        failed = [name for name, gate in context.gates.items() if not (isinstance(gate, Mapping) and gate.get("passed"))]
        raise ReplayContextError(
            "replay_context_unqualified",
            f"scene {context.scene_id} is not qualified for model episodes (failing gates: {failed or 'unknown'})",
            {"sceneId": context.scene_id, "failedGates": failed},
        )
    verdict = stock_replay_verdict(context)
    if verdict is not None and not verdict.get("passed", False):
        raise ReplayContextError(
            "replay_context_unqualified",
            f"scene {context.scene_id} failed the G5 stock-replay gate",
            {"sceneId": context.scene_id, "gate": verdict},
        )


class EnvelopeMonitor:
    """Per-decision deviation of the live ego pose from the recorded path."""

    def __init__(self, context: ReplayContext) -> None:
        self.context = context
        self.limits = context.limits
        #: Recorded window length in seconds; past it no actor poses remain.
        self.time_support_s = context.recorded_path[-1][0]
        self.max_lateral_m = 0.0
        self.max_longitudinal_s = 0.0
        self.max_heading_rad = 0.0
        self.breach: EnvelopeBreach | None = None

    def _project(self, x: float, y: float) -> tuple[float, float, float]:
        """Project ``(x, y)`` onto the recorded POLYLINE.

        Returns ``(lateral_m, recorded_t_s, recorded_heading_rad)`` at the
        closest point on the closest segment. Snapping to the nearest recorded
        *vertex* instead would report up to half a sample spacing of phantom
        lateral error (≈0.5 m at 10 Hz and 10 m/s) and truncate valid
        episodes, so the projection is onto segments.
        """
        path = self.context.recorded_path
        best_lateral = float("inf")
        best_t = path[0][0]
        best_heading = path[0][3]
        for index in range(1, len(path)):
            t0, x0, y0, h0 = path[index - 1]
            t1, x1, y1, h1 = path[index]
            sx, sy = x1 - x0, y1 - y0
            length_sq = sx * sx + sy * sy
            if length_sq <= 1e-12:
                continue
            u = ((x - x0) * sx + (y - y0) * sy) / length_sq
            u_clamped = min(1.0, max(0.0, u))
            px, py = x0 + u_clamped * sx, y0 + u_clamped * sy
            lateral = math.hypot(x - px, y - py)
            if lateral < best_lateral:
                best_lateral = lateral
                best_t = t0 + u_clamped * (t1 - t0)
                # Heading of the segment itself; the recorded per-sample
                # headings agree with it up to sampling noise.
                best_heading = math.atan2(sy, sx) if length_sq > 1e-6 else h0 + u_clamped * (h1 - h0)
        if not math.isfinite(best_lateral):
            # Degenerate path (all samples coincident): fall back to the first.
            t0, x0, y0, h0 = path[0]
            return math.hypot(x - x0, y - y0), t0, h0
        return best_lateral, best_t, best_heading

    def measure(self, *, step: int, t_s: float, x: float, y: float, heading_rad: float) -> dict[str, Any]:
        """Measure this decision; records (and returns) the first breach.

        Three ways out of the envelope, all fatal to the episode:
        lateral offset, longitudinal offset in recorded seconds, heading
        error — and leaving the recorded time support entirely, past which
        there are no actor poses left to replay and the world would be empty.
        """
        lateral_m, ref_t, ref_h = self._project(x, y)
        # Signed: positive = ahead of where the recorded drive was at this
        # instant. The envelope compares the magnitude; the sign is what makes
        # a report able to say "early" or "late".
        longitudinal_s = t_s - ref_t
        heading_error = abs(math.atan2(math.sin(heading_rad - ref_h), math.cos(heading_rad - ref_h)))
        self.max_lateral_m = max(self.max_lateral_m, lateral_m)
        self.max_longitudinal_s = max(self.max_longitudinal_s, abs(longitudinal_s))
        self.max_heading_rad = max(self.max_heading_rad, heading_error)

        breached: list[str] = []
        if lateral_m > self.limits.lateral_m:
            breached.append("lateral")
        if abs(longitudinal_s) > self.limits.longitudinal_s:
            breached.append("longitudinal")
        if heading_error > self.limits.heading_rad:
            breached.append("heading")
        if t_s > self.time_support_s + 1e-9:
            breached.append("time-support")
        if breached and self.breach is None:
            self.breach = EnvelopeBreach(
                step=step,
                t_s=t_s,
                lateral_m=lateral_m,
                longitudinal_s=longitudinal_s,
                heading_rad=heading_error,
                limits=self.limits,
                breached=tuple(breached),
            )
        return {
            "inside": not breached,
            "breached": breached,
            "lateralM": round(lateral_m, 6),
            "longitudinalS": round(longitudinal_s, 6),
            "headingRad": round(heading_error, 6),
            "closestTS": round(ref_t, 6),
        }

    def summary(self) -> dict[str, Any]:
        if self.breach is not None:
            return self.breach.as_dict()
        return {
            "breached": False,
            "maxLateralM": round(self.max_lateral_m, 6),
            "maxLongitudinalS": round(self.max_longitudinal_s, 6),
            "maxHeadingRad": round(self.max_heading_rad, 6),
            "limits": self.limits.as_dict(),
        }
