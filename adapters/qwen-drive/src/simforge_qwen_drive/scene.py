"""Convert the SimForge observation wire into Qwen-Drive's scene schema.

Qwen-Drive was trained on three views, four temporal frames per view at
``[-1.5, -1.0, -0.5, 0]`` seconds, and sixteen ego poses at 10 Hz ending at
the current pose.  The adapter keeps this contract explicit and refuses cold
or partial observations instead of padding model inputs with invented pixels.
"""
from __future__ import annotations

from io import BytesIO
from typing import Any, Mapping

import numpy as np
from PIL import Image

from .families import CAMERA_IDS, CAMERA_SENSOR_IDS, FRAME_OFFSETS_S

CAMERA_VIEWS = ("<FRONT VIEW>", "<FRONT LEFT VIEW>", "<FRONT RIGHT VIEW>")
FRAME_COUNT = len(FRAME_OFFSETS_S)
HISTORY_POINTS = 16
HISTORY_DT_S = 0.1
NAV_STRAIGHT, NAV_LEFT, NAV_RIGHT = 0, 1, 2


class SceneInputError(ValueError):
    """Raised when a policy observation cannot satisfy Qwen-Drive's schema."""


def _as_image(payload: bytes, encoding: str, width: int, height: int) -> Image.Image:
    if encoding == "raw":
        expected_rgb = width * height * 3
        expected_rgba = width * height * 4
        if len(payload) == expected_rgb:
            return Image.frombytes("RGB", (width, height), payload)
        if len(payload) == expected_rgba:
            return Image.frombytes("RGBA", (width, height), payload).convert("RGB")
        raise SceneInputError(
            f"raw frame has {len(payload)} bytes; expected {expected_rgb} RGB or {expected_rgba} RGBA"
        )
    if encoding in {"jpeg", "jpg", "png", "webp"}:
        try:
            with Image.open(BytesIO(payload)) as image:
                return image.convert("RGB")
        except Exception as exc:  # noqa: BLE001 - annotate malformed wire input
            raise SceneInputError(f"cannot decode {encoding} camera frame: {exc}") from exc
    raise SceneInputError(f"unsupported camera encoding {encoding!r}")


def _numeric_array(value: Any, name: str) -> np.ndarray:
    try:
        array = np.asarray(value, dtype=np.float32)
    except (TypeError, ValueError) as exc:
        raise SceneInputError(f"{name} is not numeric") from exc
    if not np.isfinite(array).all():
        raise SceneInputError(f"{name} contains non-finite values")
    return array


def _history(observation: Mapping[str, Any]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    raw = observation.get("ego_history_xyz", observation.get("ego_history"))
    if raw is None:
        raise SceneInputError("ego_history_xyz is required")
    values = _numeric_array(raw, "ego_history_xyz")
    if values.ndim == 4 and values.shape[:2] == (1, 1):
        values = values[0, 0]
    elif values.ndim == 3 and values.shape[0] == 1:
        values = values[0]
    if values.ndim != 2 or values.shape[0] < HISTORY_POINTS or values.shape[1] < 3:
        raise SceneInputError(
            f"ego_history_xyz must have at least {HISTORY_POINTS} rows and 3 columns; got {values.shape}"
        )
    values = values[-HISTORY_POINTS:, :3].astype(np.float32, copy=False)
    # The wire contract is the current ego frame: the newest pose is the origin.
    if np.abs(values[-1]).max() > 1e-3:
        raise SceneInputError("ego_history_xyz must be expressed in the current ego frame (newest row at the origin)")
    supplied_velocity = observation.get("ego_history_velocity")
    supplied_acceleration = observation.get("ego_history_acceleration")
    if supplied_velocity is not None:
        velocity = _numeric_array(supplied_velocity, "ego_history_velocity")
        if velocity.ndim == 3 and velocity.shape[0] == 1:
            velocity = velocity[0]
        velocity = velocity[-HISTORY_POINTS:, :2]
    else:
        velocity = np.gradient(values[:, :2], HISTORY_DT_S, axis=0, edge_order=2)
    if supplied_acceleration is not None:
        acceleration = _numeric_array(supplied_acceleration, "ego_history_acceleration")
        if acceleration.ndim == 3 and acceleration.shape[0] == 1:
            acceleration = acceleration[0]
        acceleration = acceleration[-HISTORY_POINTS:, :2]
    else:
        acceleration = np.gradient(velocity, HISTORY_DT_S, axis=0, edge_order=2)
    if velocity.shape != (HISTORY_POINTS, 2) or acceleration.shape != (HISTORY_POINTS, 2):
        raise SceneInputError(
            f"history dynamics must be ({HISTORY_POINTS}, 2), got {velocity.shape}/{acceleration.shape}"
        )
    return values, velocity.astype(np.float32), acceleration.astype(np.float32)


def nav_command(observation: Mapping[str, Any], history: np.ndarray) -> int:
    explicit = observation.get("nav_command")
    if explicit is not None:
        if isinstance(explicit, str):
            normalized = explicit.lower().replace("_", " ").strip()
            if normalized in {"straight", "go straight"}:
                return NAV_STRAIGHT
            if normalized in {"left", "turn left"}:
                return NAV_LEFT
            if normalized in {"right", "turn right"}:
                return NAV_RIGHT
        try:
            value = int(explicit)
        except (TypeError, ValueError) as exc:
            raise SceneInputError(f"invalid nav_command {explicit!r}") from exc
        if value in (NAV_STRAIGHT, NAV_LEFT, NAV_RIGHT):
            return value
        raise SceneInputError(f"nav_command must be 0, 1 or 2, got {value}")
    route = observation.get("route")
    points = route.get("points") if isinstance(route, Mapping) else route
    if points is None:
        return NAV_STRAIGHT
    path = _numeric_array(points, "route.points")
    if path.ndim != 2 or path.shape[0] < 2 or path.shape[1] < 2:
        return NAV_STRAIGHT
    xy = path[:, :2]
    segments = np.diff(xy, axis=0)
    lengths = np.linalg.norm(segments, axis=1)
    arc = np.concatenate(([0.0], np.cumsum(lengths)))
    index = int(np.searchsorted(arc, 40.0, side="right") - 1)
    index = max(0, min(index, len(segments) - 1))
    angle = float(np.degrees(np.arctan2(segments[index, 1], segments[index, 0])))
    if angle > 30.0:
        return NAV_LEFT
    if angle < -30.0:
        return NAV_RIGHT
    return NAV_STRAIGHT


def _camera_entries(observation: Mapping[str, Any]) -> dict[int, Mapping[str, Any]]:
    cameras = observation.get("cameras")
    if not isinstance(cameras, list):
        raise SceneInputError("cameras must be a list")
    by_id: dict[int, Mapping[str, Any]] = {}
    for camera in cameras:
        if not isinstance(camera, Mapping):
            raise SceneInputError("camera entry must be an object")
        try:
            camera_id = int(camera["camera_id"])
        except (KeyError, TypeError, ValueError) as exc:
            raise SceneInputError("camera entry has no integer camera_id") from exc
        by_id[camera_id] = camera
    missing = [camera_id for camera_id in CAMERA_IDS if camera_id not in by_id]
    if missing:
        raise SceneInputError(f"Qwen-Drive camera ids missing: {missing}")
    return by_id


def build_scene(observation: Mapping[str, Any], *, model_config: Any = None):
    """Build a real ``qwen_drive.scene.DrivingScene`` from a socket observation."""
    try:
        from qwen_drive.scene import CameraFrame, DrivingScene
    except ImportError as exc:  # pragma: no cover - exercised by setup smoke
        raise SceneInputError("the pinned Qwen-Drive package is not on PYTHONPATH") from exc
    frame_size = observation.get("frame_size") or {}
    width = int(frame_size.get("width", observation.get("width", 0)))
    height = int(frame_size.get("height", observation.get("height", 0)))
    if width <= 0 or height <= 0:
        raise SceneInputError("frame_size.width and frame_size.height are required")
    by_id = _camera_entries(observation)
    views: dict[str, list[Any]] = {}
    for camera_id, view in zip(CAMERA_IDS, CAMERA_VIEWS):
        entry = by_id[camera_id]
        frames = entry.get("frames")
        if not isinstance(frames, list) or len(frames) != FRAME_COUNT:
            raise SceneInputError(
                f"camera {camera_id} needs exactly {FRAME_COUNT} temporal frames, got {len(frames or [])}"
            )
        encoding = str(entry.get("encoding", "raw")).lower()
        views[view] = [
            CameraFrame(_as_image(bytes(payload), encoding, width, height))
            for payload in frames
        ]
    history, velocity, acceleration = _history(observation)
    command = nav_command(observation, history)
    ego_velocity = observation.get("ego_velocity")
    if ego_velocity is None:
        ego_velocity = velocity[-1].tolist()
    ego_acceleration = observation.get("ego_acceleration")
    if ego_acceleration is None:
        ego_acceleration = acceleration[-1].tolist()
    driving_command = {
        NAV_STRAIGHT: (0.0, 1.0, 0.0, 0.0),
        NAV_LEFT: (1.0, 0.0, 0.0, 0.0),
        NAV_RIGHT: (0.0, 0.0, 1.0, 0.0),
    }[command]
    return DrivingScene(
        views=views,
        history=history,
        history_velocity=velocity,
        history_acceleration=acceleration,
        ego_velocity=ego_velocity,
        ego_acceleration=ego_acceleration,
        driving_command=driving_command,
        nav_command=command,
        metadata={"simforge": True, "frame_size": [width, height]},
    )
