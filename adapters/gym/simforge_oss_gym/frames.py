"""Endpoint history assembly from the kernel Episode's real camera frames.

``bevy:<rig.json>`` selects the Episode Cameras channel. The rig supplies
``cameras`` (ego-relative mounts), ``passes`` and ``backend``; an embedded
backend also supplies its real scene document. The kernel alone creates the
post-step scene and renders it. This module only packs RGB bytes for the
existing endpoint MessagePack wire and releases native frame leases.

Prerecorded ``dir:`` images are not a closed-loop source: they cannot reflect
the state after a policy diverges. Recorded observations belong to open-loop
evaluation, not this adapter.
"""

from __future__ import annotations

import json
import os
from collections import deque
from pathlib import Path
from typing import Any, Iterable, Mapping, Protocol, Sequence

import numpy as np

#: Frames per camera in the Alpamayo observation window (oldest -> newest).
NUM_FRAMES_PER_CAMERA = 4
#: Ego-history steps in the Alpamayo observation window.
NUM_HISTORY_STEPS = 16


class FrameSourceError(RuntimeError):
    """Typed frame-source failure carrying a stable code for the ledger."""

    def __init__(self, code: str, message: str, detail: Mapping[str, Any] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.detail = dict(detail or {})


class FrameSource(Protocol):
    """One tick of real camera frames, keyed by renderer sensor id."""

    @property
    def sensor_ids(self) -> tuple[str, ...]:
        """Sensor ids this source can produce."""

    def capture(self, *, step: int, tick: int, t_s: float) -> dict[str, tuple[bytes, str, int, int]]:
        """``{sensor_id: (payload, encoding, width, height)}`` for this decision.

        ``encoding`` is the wire encoding of ``payload``: ``raw`` (packed
        H*W*3 RGB bytes) or ``jpeg``/``png`` (the encoded file bytes).
        """

    def close(self) -> None: ...


def rgba_to_rgb_bytes(view: np.ndarray) -> tuple[bytes, int, int]:
    """Pack one ``(H, W, 4)`` RGBA array into contiguous ``H*W*3`` RGB bytes."""
    array = np.asarray(view)
    if array.ndim != 3 or array.shape[2] != 4:
        raise FrameSourceError("frame_decode_failed", f"expected (H, W, 4) rgba, got {array.shape}")
    height, width = int(array.shape[0]), int(array.shape[1])
    return np.ascontiguousarray(array[:, :, :3]).tobytes(), width, height


class EpisodeFrameSource:
    """Borrow each kernel camera frame only long enough to pack the wire RGB."""

    def __init__(self, channel: Mapping[str, Any]) -> None:
        self.channel = dict(channel)
        self._sensor_ids = tuple(str(camera["sensorId"]) for camera in channel["rig"]["cameras"])
        self.episode: Any = None
        self.observation: Mapping[str, Any] = {}
        self._frames: Sequence[Any] | None = None

    @property
    def sensor_ids(self) -> tuple[str, ...]:
        return self._sensor_ids

    def bind(self, episode: Any) -> None:
        self.episode = episode

    def observe(self, observation: Mapping[str, Any], frames: Sequence[Any] | None = None) -> None:
        self.observation = observation
        self._frames = frames

    def capture(self, *, step: int, tick: int, t_s: float) -> dict[str, tuple[bytes, str, int, int]]:
        del step, tick
        if self.episode is None or self.observation.get("tS") != t_s:
            raise FrameSourceError("frame_missing", "no kernel camera observation at this decision barrier")
        rows = self.observation.get("cameras") or []
        refs = list(self._frames) if self._frames is not None else []
        out: dict[str, tuple[bytes, str, int, int]] = {}
        try:
            for index, row in enumerate(rows):
                ref = refs[index] if self._frames is not None else self.episode.frame(row["frame"]["id"])
                if self._frames is None:
                    refs.append(ref)
                if row["pass"] != "rgb":
                    continue
                width, height = int(row["width"]), int(row["height"])
                stride = int(row["frame"]["rowStride"])
                if row["frame"]["format"] != "rgba8":
                    raise FrameSourceError("frame_decode_failed", f"unsupported RGB frame format {row['frame']['format']!r}")
                pixels = np.ndarray((height, width, 4), dtype=np.uint8, buffer=ref.buffer(), strides=(stride, 4, 1))
                payload, width, height = rgba_to_rgb_bytes(pixels)
                del pixels
                out[str(row["sensorId"])] = (payload, "raw", width, height)
        finally:
            for ref in refs:
                ref.release()
            self._frames = None
        missing = [sensor for sensor in self.sensor_ids if sensor not in out]
        if missing:
            raise FrameSourceError("frame_missing", f"kernel returned no RGB frames for {missing}")
        return out

    def close(self) -> None:
        if self._frames is not None:
            for frame in self._frames:
                frame.release()
            self._frames = None
        self.episode = None


def make_frame_source(spec: str | None, *, profile: str | None = None, sensor_ids: Sequence[str] | None = None) -> EpisodeFrameSource | None:
    """Resolve render assets, never construct a second renderer or world owner."""
    if not spec or spec == "none":
        return None
    scheme, _, target = spec.partition(":")
    if scheme != "bevy" or not target:
        raise FrameSourceError("frame_source_unavailable", "closed-loop cameras require bevy:<rig.json>; prerecorded dir: frames cannot follow policy actions")
    rig_path = Path(target).expanduser()
    if not rig_path.is_file():
        raise FrameSourceError("frame_source_unavailable", f"bevy rig document {rig_path} does not exist")
    document = json.loads(rig_path.read_text())
    cameras = document.get("cameras") or document.get("rig", {}).get("cameras")
    if not cameras and not (document.get("profile") or profile):
        raise FrameSourceError("frame_source_unavailable", "bevy rig document requires cameras or a camera profile")
    backend = dict(document.get("backend") or {"kind": "embedded", "scene": document.get("scene")})
    if backend.get("kind") == "embedded":
        scene = backend.get("scene")
        if isinstance(scene, str):
            scene_path = Path(scene).expanduser()
            if not scene_path.is_absolute():
                scene_path = Path(os.environ.get("SIMFORGE_SCENE_ROOT", rig_path.parent)) / scene_path
            backend["scene"] = json.loads(scene_path.read_text())
        elif not isinstance(scene, Mapping):
            raise FrameSourceError("frame_source_unavailable", "embedded cameras require a real scene document")
    if document.get("sceneState"):
        raise FrameSourceError("frame_source_unavailable", "sceneState providers are obsolete; the kernel Episode owns scene state")
    if cameras:
        channel = {"kind": "cameras", "rig": {"cameras": cameras},
                   "passes": list(document.get("passes") or ["rgb"]), "backend": backend}
    else:
        from .episodes import observation_channels
        channel = observation_channels(f"cams:{document.get('profile') or profile}", backend=backend,
                                       passes=document.get("passes") or ["rgb"])[-1]
    source = EpisodeFrameSource(channel)
    missing = set(sensor_ids or ()) - set(source.sensor_ids)
    if missing:
        raise FrameSourceError("frame_source_rig_mismatch", f"rig is missing cameras {sorted(missing)}")
    return source


class ObservationAssembler:
    """Rolling per-camera frame window + ego history -> wire `act` observation.

    ``camera_map`` maps renderer sensor ids to model camera indices 0..6.
    Frames are stored exactly as the source produced them (packed RGB or the
    encoded file bytes); nothing is resized, decoded or padded here.

    ``ready`` is only true once every mapped camera holds a full window of
    *distinct real* frames and the ego history is complete. Cold-start
    replication is available (``allow_cold_start=True``) but never silent: it
    stamps ``cold_start`` on the emitted observation so provenance records
    that the oldest frame was replicated.
    """

    def __init__(
        self,
        camera_map: Mapping[str, int],
        *,
        num_frames: int = NUM_FRAMES_PER_CAMERA,
        allow_cold_start: bool = False,
    ) -> None:
        if not camera_map:
            raise FrameSourceError("camera_map_invalid", "camera_map must not be empty")
        indices = [int(v) for v in camera_map.values()]
        if len(set(indices)) != len(indices):
            raise FrameSourceError("camera_map_invalid", f"duplicate model camera index in {dict(camera_map)}")
        for sensor_id, index in camera_map.items():
            if not 0 <= int(index) <= 6:
                raise FrameSourceError("camera_map_invalid", f"camera index {index} for {sensor_id!r} outside 0..6")
        self.camera_map = {str(k): int(v) for k, v in camera_map.items()}
        self.num_frames = int(num_frames)
        self.allow_cold_start = bool(allow_cold_start)
        self._frames: dict[str, deque[tuple[bytes, str, int, int]]] = {
            sensor_id: deque(maxlen=self.num_frames) for sensor_id in self.camera_map
        }
        self.ticks_pushed = 0

    def push(self, captured: Mapping[str, tuple[bytes, str, int, int]]) -> None:
        missing = [s for s in self.camera_map if s not in captured]
        if missing:
            raise FrameSourceError(
                "frame_missing",
                f"capture is missing mapped cameras: {missing}",
                {"missing": missing},
            )
        for sensor_id in self.camera_map:
            payload, encoding, width, height = captured[sensor_id]
            window = self._frames[sensor_id]
            if window:
                _, prev_encoding, prev_w, prev_h = window[-1]
                if (prev_encoding, prev_w, prev_h) != (encoding, width, height):
                    raise FrameSourceError(
                        "frame_geometry_changed",
                        f"{sensor_id}: frame changed {prev_encoding} {prev_w}x{prev_h} -> {encoding} {width}x{height} mid-history",
                    )
            window.append((payload, encoding, width, height))
        self.ticks_pushed += 1

    @property
    def frames_ready(self) -> bool:
        return all(len(window) >= self.num_frames for window in self._frames.values())

    def observation(
        self,
        ego_history_xyz: Sequence[Sequence[float]],
        ego_history_rot: Sequence[Sequence[Sequence[float]]] | None = None,
        ego_history_t_s: Sequence[float] | None = None,
        nav_text: str | None = None,
    ) -> dict[str, Any]:
        """Wire `act.obs`; raises when the window or history is incomplete."""
        history = np.asarray(ego_history_xyz, dtype=np.float64)
        if history.shape != (NUM_HISTORY_STEPS, 3):
            raise FrameSourceError(
                "ego_history_incomplete",
                f"ego_history_xyz must be ({NUM_HISTORY_STEPS}, 3), got {history.shape}",
            )
        if not self.frames_ready and not self.allow_cold_start:
            short = {s: len(w) for s, w in self._frames.items() if len(w) < self.num_frames}
            raise FrameSourceError(
                "frame_window_incomplete",
                f"camera window incomplete {short}; run the warm-up phase or pass --allow-cold-start",
                {"short": short},
            )
        cold_start = not self.frames_ready
        cameras: list[dict[str, Any]] = []
        for sensor_id, index in sorted(self.camera_map.items(), key=lambda kv: kv[1]):
            window = list(self._frames[sensor_id])
            if not window:
                raise FrameSourceError("frame_missing", f"{sensor_id}: no frames captured yet")
            encoding, width, height = window[-1][1], window[-1][2], window[-1][3]
            payloads = [entry[0] for entry in window]
            payloads = [payloads[0]] * (self.num_frames - len(payloads)) + payloads
            cameras.append(
                {
                    "camera_id": index,
                    "frames": payloads,
                    "encoding": encoding,
                    "width": width,
                    "height": height,
                }
            )
        obs: dict[str, Any] = {"cameras": cameras, "ego_history_xyz": history.tolist()}
        if ego_history_rot is not None:
            rot = np.asarray(ego_history_rot, dtype=np.float64)
            if rot.shape != (NUM_HISTORY_STEPS, 3, 3):
                raise FrameSourceError(
                    "ego_history_incomplete",
                    f"ego_history_rot must be ({NUM_HISTORY_STEPS}, 3, 3), got {rot.shape}",
                )
            obs["ego_history_rot"] = rot.tolist()
        if ego_history_t_s is not None:
            times = [float(v) for v in ego_history_t_s]
            if len(times) != NUM_HISTORY_STEPS:
                raise FrameSourceError(
                    "ego_history_incomplete",
                    f"ego_history_t_s must have {NUM_HISTORY_STEPS} entries, got {len(times)}",
                )
            obs["ego_history_t_s"] = times
        if nav_text is not None:
            obs["nav_text"] = nav_text
        if cold_start:
            obs["cold_start"] = True
        return obs

    def camera_ids(self) -> list[int]:
        return sorted(self.camera_map.values())


def ego_history_from_trail(
    trail: Iterable[tuple[float, float, float, float, float]],
    *,
    steps: int = NUM_HISTORY_STEPS,
) -> tuple[list[list[float]], list[list[list[float]]], list[float]]:
    """Ego-frame-at-t0 history from recorded world poses.

    ``trail`` rows are ``(t_s, x, y, yaw_rad, speed_mps)`` in the engine world
    frame, oldest first; the LAST row is t0. Returns
    ``(xyz[steps][3], rot[steps][3][3], t_s[steps])`` in the FLU ego frame at
    t0 (x forward, y left, z up; t0 at the origin with identity rotation),
    matching the AlpaSim ``build_ego_history`` convention.

    Raises when fewer than ``steps`` real poses exist — the history is never
    padded, extrapolated or zero-filled.
    """
    rows = list(trail)
    if len(rows) < steps:
        raise FrameSourceError(
            "ego_history_incomplete",
            f"need {steps} recorded ego poses, have {len(rows)}",
            {"have": len(rows), "need": steps},
        )
    window = rows[-steps:]
    t0, x0, y0, yaw0, _ = window[-1]
    cos0, sin0 = np.cos(-yaw0), np.sin(-yaw0)
    xyz: list[list[float]] = []
    rot: list[list[list[float]]] = []
    times: list[float] = []
    for t_s, x, y, yaw, _speed in window:
        dx, dy = x - x0, y - y0
        # World -> ego-at-t0 (planar rotation by -yaw0), FLU with z = 0.
        ex = dx * cos0 - dy * sin0
        ey = dx * sin0 + dy * cos0
        xyz.append([float(ex), float(ey), 0.0])
        dyaw = float(yaw - yaw0)
        c, s = float(np.cos(dyaw)), float(np.sin(dyaw))
        rot.append([[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]])
        times.append(float(t_s - t0))
    return xyz, rot, times
