"""Bridge: shm frame bundles -> Alpamayo `act` observations.

Maps Bevy-rendered rig frames (renderer/service `render_bundle`, consumed
via ``simforge_native.BundleRingReader`` zero-copy views) onto the wire
observation documented in ``obs.py``: correct ``camera_id`` assignment,
RGBA->RGB packing, optional resize, and the 4-frame history window
assembled across sim ticks.

Zero-copy notes: frames stay numpy views into the shm ring right up to the
final RGBA->RGB pack, which is the one unavoidable copy — the model server
wants contiguous ``H*W*3`` bytes while the ring stores 256-byte-row-padded
RGBA. ``push_bundle`` records that conversion cost per tick in
``last_convert_s``.

This module deliberately has no torch dependency so policy runners can use
it without the inference venv; the authoritative decode lives in
``obs.decode_observation`` on the server side.
"""

from __future__ import annotations

import time
from collections import deque
from collections.abc import Mapping
from typing import Any

import numpy as np

#: Upstream Alpamayo camera-index convention, identical in all three upstream
#: packages (``CAMERA_NAMES_TO_INDICES``). MIRROR of ``ALPAMAYO_CAMERA_INDEX``
#: in packages/scenario/src/schema/v2/sensor-rigs.ts — keep byte-identical.
ALPAMAYO_CAMERA_INDEX: dict[str, int] = {
    "camera_cross_left_120fov": 0,
    "camera_front_wide_120fov": 1,
    "camera_cross_right_120fov": 2,
    "camera_rear_left_70fov": 3,
    "camera_rear_tele_30fov": 4,
    "camera_rear_right_70fov": 5,
    "camera_front_tele_30fov": 6,
}

#: Sensor ids per authored rig preset, camera-index ascending. MIRROR of the
#: `alpamayo-*` presets in packages/scenario/src/schema/v2/sensor-rigs.ts.
#: The 6-camera sets are the Alpamayo 2 Super task profiles: the driving
#: profile drops rear-tele (4), the VQA profile drops front-tele (6).
RIG_PROFILES: dict[str, tuple[str, ...]] = {
    "alpamayo-2cam": ("camera_front_wide_120fov", "camera_front_tele_30fov"),
    "alpamayo-4cam": (
        "camera_cross_left_120fov",
        "camera_front_wide_120fov",
        "camera_cross_right_120fov",
        "camera_front_tele_30fov",
    ),
    "alpamayo-6cam": (
        "camera_cross_left_120fov",
        "camera_front_wide_120fov",
        "camera_cross_right_120fov",
        "camera_rear_left_70fov",
        "camera_rear_right_70fov",
        "camera_front_tele_30fov",
    ),
    "alpamayo-6cam-vqa": (
        "camera_cross_left_120fov",
        "camera_front_wide_120fov",
        "camera_cross_right_120fov",
        "camera_rear_left_70fov",
        "camera_rear_tele_30fov",
        "camera_rear_right_70fov",
    ),
}

#: Model camera-index tuples per preset, ascending. Derived, not typed twice.
RIG_CAMERA_IDS: dict[str, tuple[int, ...]] = {
    profile: tuple(sorted(ALPAMAYO_CAMERA_INDEX[sensor] for sensor in sensors))
    for profile, sensors in RIG_PROFILES.items()
}

# Local mirrors of obs.py constants, so this module stays numpy-only and can
# be imported by a policy runner that has no inference environment.
NUM_FRAMES_PER_CAMERA = 4
NUM_HISTORY_STEPS = 16


def profile_camera_map(profile: str) -> dict[str, int]:
    """{preset sensor id -> model camera index} for an authored rig preset."""
    try:
        sensors = RIG_PROFILES[profile]
    except KeyError:
        raise ValueError(
            f"unknown rig profile {profile!r} (have {sorted(RIG_PROFILES)})"
        ) from None
    return {sensor_id: ALPAMAYO_CAMERA_INDEX[sensor_id] for sensor_id in sensors}


def profile_for_camera_ids(camera_ids: tuple[int, ...] | list[int]) -> str | None:
    """Rig-preset id matching a model camera-index set, or ``None``.

    Returns ``None`` rather than a nearest match: an unnamed camera set is
    recorded as unnamed in provenance, never relabelled as a preset it is not.
    """
    wanted = tuple(sorted(int(value) for value in camera_ids))
    for profile, ids in RIG_CAMERA_IDS.items():
        if ids == wanted:
            return profile
    return None


def rgba_view_to_rgb_bytes(
    view: np.ndarray, size: tuple[int, int] | None = None
) -> tuple[bytes, int, int]:
    """Pack one (H, W, 4) RGBA view into contiguous H*W*3 RGB bytes.

    ``size`` is an optional (width, height) resize target; PIL is imported
    lazily so the no-resize hot path stays numpy-only. Returns
    ``(bytes, width, height)``.
    """
    if view.ndim != 3 or view.shape[2] < 3:
        raise ValueError(f"expected (H, W, >=3) frame view, got {view.shape}")
    height, width = view.shape[0], view.shape[1]
    if size is not None and (width, height) != size:
        from PIL import Image

        rgb = np.ascontiguousarray(view[:, :, :3])
        image = Image.fromarray(rgb, mode="RGB").resize(size, Image.BILINEAR)
        width, height = size
        return image.tobytes(), width, height
    return np.ascontiguousarray(view[:, :, :3]).tobytes(), width, height


class BundleObservationBridge:
    """Accumulates per-camera frame history across ticks and emits wire obs.

    ``camera_map`` maps ring sensor ids (bundle entry ``camera_id`` strings)
    to model camera indices 0..6. Sensors present in the bundle but absent
    from the map are ignored, so a rig may carry extra QA cameras.

    History semantics (matches obs.py: frames oldest -> newest, t0 last):
    every ``push_bundle`` appends one frame per mapped camera to a rolling
    4-deep window. Until 4 ticks have been pushed, ``observation()`` pads by
    replicating the OLDEST available frame — the standard cold-start
    approximation for a fixed-length history model.
    """

    def __init__(
        self,
        camera_map: Mapping[str, int],
        num_frames: int = NUM_FRAMES_PER_CAMERA,
        size: tuple[int, int] | None = None,
    ):
        if not camera_map:
            raise ValueError("camera_map must not be empty")
        indices = list(camera_map.values())
        if len(set(indices)) != len(indices):
            raise ValueError(f"duplicate model camera index in map: {dict(camera_map)}")
        for sensor_id, index in camera_map.items():
            if not 0 <= int(index) <= 6:
                raise ValueError(f"camera index {index} for {sensor_id!r} outside 0..6")
        self.camera_map = dict(camera_map)
        self.num_frames = int(num_frames)
        self.size = size
        self._frames: dict[str, deque[bytes]] = {
            sensor_id: deque(maxlen=self.num_frames) for sensor_id in self.camera_map
        }
        self._dims: dict[str, tuple[int, int]] = {}
        self.ticks_pushed = 0
        self.last_convert_s = 0.0
        self.total_convert_s = 0.0

    @classmethod
    def for_profile(
        cls, profile: str, size: tuple[int, int] | None = None
    ) -> "BundleObservationBridge":
        return cls(profile_camera_map(profile), size=size)

    def push_views(self, views: Mapping[str, np.ndarray]) -> float:
        """Ingest one tick of {sensor id: (H, W, 4) rgba view}.

        Returns the RGBA->RGB conversion wall time in seconds (also stored
        in ``last_convert_s``).
        """
        missing = [s for s in self.camera_map if s not in views]
        if missing:
            raise ValueError(f"bundle tick missing mapped cameras: {missing}")
        t0 = time.perf_counter()
        packed: dict[str, tuple[bytes, int, int]] = {
            sensor_id: rgba_view_to_rgb_bytes(views[sensor_id], self.size)
            for sensor_id in self.camera_map
        }
        elapsed = time.perf_counter() - t0
        for sensor_id, (payload, width, height) in packed.items():
            dims = (width, height)
            previous = self._dims.get(sensor_id)
            if previous is not None and previous != dims:
                raise ValueError(
                    f"{sensor_id}: frame dims changed {previous} -> {dims} mid-history"
                )
            self._dims[sensor_id] = dims
            self._frames[sensor_id].append(payload)
        self.ticks_pushed += 1
        self.last_convert_s = elapsed
        self.total_convert_s += elapsed
        return elapsed

    def push_bundle(self, bundle: Any, pass_: str = "rgb") -> float:
        """Ingest one ``simforge_native`` Bundle (zero-copy views, rgb pass)."""
        views: dict[str, np.ndarray] = {}
        for entry in bundle.entries:
            if entry.camera_id in self.camera_map and entry.pass_ == pass_:
                if entry.format != "rgba8":
                    raise ValueError(
                        f"{entry.camera_id}/{pass_}: expected rgba8, got {entry.format}"
                    )
                views[entry.camera_id] = bundle.view(entry)
        return self.push_views(views)

    @property
    def ready(self) -> bool:
        """At least one full tick per mapped camera has been ingested."""
        return self.ticks_pushed > 0

    def observation(
        self,
        ego_history_xyz: Any,
        ego_history_rot: Any | None = None,
        nav_text: str | None = None,
    ) -> dict[str, Any]:
        """Wire-format `act` observation (see obs.py schema docstring)."""
        if not self.ready:
            raise ValueError("no frames pushed yet")
        hist = np.asarray(ego_history_xyz, dtype=np.float32)
        if hist.shape != (NUM_HISTORY_STEPS, 3):
            raise ValueError(f"ego_history_xyz must be (16, 3), got {hist.shape}")
        cameras = []
        for sensor_id, index in sorted(self.camera_map.items(), key=lambda kv: kv[1]):
            window = list(self._frames[sensor_id])
            # Cold start: replicate the oldest frame; newest stays t0 (last).
            window = [window[0]] * (self.num_frames - len(window)) + window
            width, height = self._dims[sensor_id]
            cameras.append(
                {
                    "camera_id": index,
                    "frames": window,
                    "encoding": "raw",
                    "width": width,
                    "height": height,
                }
            )
        obs: dict[str, Any] = {
            "cameras": cameras,
            "ego_history_xyz": hist.tolist(),
        }
        if ego_history_rot is not None:
            rot = np.asarray(ego_history_rot, dtype=np.float32)
            if rot.shape != (NUM_HISTORY_STEPS, 3, 3):
                raise ValueError(f"ego_history_rot must be (16, 3, 3), got {rot.shape}")
            obs["ego_history_rot"] = rot.tolist()
        if nav_text is not None:
            obs["nav_text"] = nav_text
        return obs


def constant_velocity_history(
    speed_mps: float = 8.0, hz: float = 10.0, steps: int = NUM_HISTORY_STEPS
) -> list[list[float]]:
    """Straight-line ego history along +x, t0 (last entry) at the origin."""
    dt = 1.0 / hz
    return [
        [-(steps - 1 - i) * speed_mps * dt, 0.0, 0.0] for i in range(steps)
    ]


def ego_history_from_positions(
    world_xyz: Any, heading_rad: float = 0.0, steps: int = NUM_HISTORY_STEPS
) -> list[list[float]]:
    """Convert the last ``steps`` world positions into the ego frame at t0.

    ``world_xyz`` is (N >= 1, 3), oldest -> newest. The newest position
    becomes the origin; ``heading_rad`` is the ego yaw at t0 in the same
    world frame (rotation about +z, x-forward ego convention). Histories
    shorter than ``steps`` are padded by replicating the oldest position.
    """
    positions = np.asarray(world_xyz, dtype=np.float64)
    if positions.ndim != 2 or positions.shape[1] != 3 or positions.shape[0] < 1:
        raise ValueError(f"world_xyz must be (N>=1, 3), got {positions.shape}")
    if positions.shape[0] < steps:
        pad = np.repeat(positions[:1], steps - positions.shape[0], axis=0)
        positions = np.concatenate([pad, positions], axis=0)
    positions = positions[-steps:]
    delta = positions - positions[-1]
    cos_h, sin_h = np.cos(-heading_rad), np.sin(-heading_rad)
    ego = np.empty_like(delta)
    ego[:, 0] = cos_h * delta[:, 0] - sin_h * delta[:, 1]
    ego[:, 1] = sin_h * delta[:, 0] + cos_h * delta[:, 1]
    ego[:, 2] = delta[:, 2]
    return [[float(v) for v in row] for row in ego]


def ego_history_rot_from_headings(
    headings_rad: Any, steps: int = NUM_HISTORY_STEPS
) -> list[list[list[float]]]:
    """Per-step ego rotations expressed in the t0 rig frame.

    ``headings_rad`` is a sequence of world yaw angles, oldest -> newest, in
    the same world frame as the positions passed to
    :func:`ego_history_from_positions`. The newest heading defines the t0
    frame, so the last matrix is the identity by construction.

    This is the AlpaSim ``build_ego_history`` convention: x forward, y left,
    z up (FLU), rotations 3x3 row-major about +z, relative to t0. Histories
    shorter than ``steps`` are padded by replicating the OLDEST heading,
    matching the position padding — the cold-start approximation, applied
    consistently rather than mixing a padded position with a fresh rotation.
    """
    headings = np.asarray(headings_rad, dtype=np.float64).reshape(-1)
    if headings.size < 1:
        raise ValueError("headings_rad must contain at least one heading")
    if headings.size < steps:
        headings = np.concatenate(
            [np.repeat(headings[:1], steps - headings.size), headings]
        )
    headings = headings[-steps:]
    relative = headings - headings[-1]
    cos_h = np.cos(relative)
    sin_h = np.sin(relative)
    matrices = np.zeros((steps, 3, 3), dtype=np.float64)
    matrices[:, 0, 0] = cos_h
    matrices[:, 0, 1] = -sin_h
    matrices[:, 1, 0] = sin_h
    matrices[:, 1, 1] = cos_h
    matrices[:, 2, 2] = 1.0
    return [[[float(v) for v in row] for row in mat] for mat in matrices]


def bundle_to_observation(
    bundle: Any,
    camera_map: Mapping[str, int] | str,
    ego_history_xyz: Any,
    ego_history_rot: Any | None = None,
    nav_text: str | None = None,
    size: tuple[int, int] | None = None,
    pass_: str = "rgb",
    ego_history_t_s: Any | None = None,
) -> dict[str, Any]:
    """One-shot bundle -> wire observation, for single-frame callers.

    ``camera_map`` is either a ``{sensor id: camera index}`` mapping or a rig
    preset id.

    COLD-START APPROXIMATION, stated rather than hidden: a single bundle
    carries one tick, so the 4-frame history window is filled by replicating
    that frame. The model then sees a stationary-looking image history while
    the ego history says the vehicle moved. Use
    :class:`BundleObservationBridge` across ticks for a real temporal window;
    this helper is for open-loop single-observation inference where only one
    tick exists. The returned observation carries
    ``frame_history: "replicated-single-tick"`` so provenance records it.
    """
    mapping = (
        profile_camera_map(camera_map) if isinstance(camera_map, str) else camera_map
    )
    bridge = BundleObservationBridge(mapping, size=size)
    bridge.push_bundle(bundle, pass_=pass_)
    obs = bridge.observation(
        ego_history_xyz, ego_history_rot=ego_history_rot, nav_text=nav_text
    )
    obs["frame_history"] = "replicated-single-tick"
    if ego_history_t_s is not None:
        obs["ego_history_t_s"] = [float(value) for value in ego_history_t_s]
    return obs
