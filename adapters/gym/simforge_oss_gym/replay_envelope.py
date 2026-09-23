"""Replay-context asset loading for native Episode admission and measurement.

The kernel owns all projection, limit checks and truncation. Python resolves the
bundle, hashes its exact bytes, checks camera coverage and passes the recorded
qualification evidence without reimplementing the episode's validity rules.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence

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
    #: Camera set the scene is qualified FOR (``validity.profileCameraIds``).
    #: Qualification is per camera set: a scene can reconstruct well for wide
    #: cameras and badly for a tele, so "the scene is qualified" is not
    #: well-formed on its own.
    profile_camera_ids: tuple[int, ...]
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

    def episode_context(self, *, measure_only: bool = False) -> dict[str, Any]:
        """Resolved kernel contract; measurement-only is the G5 stock replay."""
        verdict = stock_replay_verdict(self)
        return {
            "sceneId": self.scene_id, "digest": self.digest,
            "qualified": self.qualified,
            "stockReplayPassed": None if verdict is None else bool(verdict.get("passed", False)),
            **self.limits.as_dict(), "recordedPath": self.recorded_path,
            "measureOnly": measure_only,
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
        profile_camera_ids=tuple(sorted(int(v) for v in document.get("validity", {}).get("profileCameraIds", []))),
        gates=dict(document.get("validity", {}).get("gates", {})),
        envelope_basis=dict(document.get("validity", {}).get("envelopeBasis", {})),
    )


def require_profile_coverage(context: ReplayContext, camera_ids: Sequence[int]) -> None:
    """Refuse a rig the scene is not qualified for.

    ``validity.profileCameraIds`` names the camera set whose renders passed the
    gates. Driving a preset that includes a camera outside it would score a
    model against views nobody measured.
    """
    if not context.profile_camera_ids:
        return
    outside = sorted(set(int(c) for c in camera_ids) - set(context.profile_camera_ids))
    if outside:
        raise ReplayContextError(
            "replay_context_profile_mismatch",
            f"scene {context.scene_id} is qualified for cameras {list(context.profile_camera_ids)}; "
            f"the requested rig adds {outside}",
            {"qualifiedFor": list(context.profile_camera_ids), "outside": outside},
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


