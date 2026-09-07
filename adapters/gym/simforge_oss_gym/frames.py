"""Camera frame sources and the observation assembler for endpoint policies.

A driving policy endpoint (Alpamayo family) needs a *real* multi-camera
history at every decision. This module supplies frames from sources that
actually rendered or recorded them and refuses to invent any:

- ``dir:<root>`` — frames a renderer already produced on disk, one directory
  per sensor id, one file per decision step
  (``<root>/<sensorId>/<step:06d>.{raw,png,jpg,jpeg}``). ``raw`` needs a
  ``<root>/<sensorId>/meta.json`` (``{width, height, format: "rgba8"}``);
  encoded files are passed to the endpoint untouched (the model server
  decodes) and their dimensions are read from the file header, so this path
  needs no image library and no GPU. This is the source used by
  reconstructed replay-context bundles and by render-then-evaluate offline
  pipelines.
- ``bevy:<rig.json>`` — the resident Bevy renderer
  (:class:`~simforge_oss_gym.bevy_sensors.BevySensorRig`). The rig document
  supplies the render scene (map tiles, lighting) and the renderer camera
  descriptors: ``{"scene": <doc|path>, "cameras": [...], "passes": ["rgb"]}``.
  Scene state — what is rendered — comes by DEFAULT from the live episode via
  :class:`~simforge_oss_gym.scene_state.EnvSceneStateExporter`, which publishes
  the world as it is after the last applied action, so each rendered frame
  reflects what the policy just did (closed-loop feedback, not replay). A rig
  may add ``"sceneState": {"options": {...}}`` to tune that exporter (map id,
  ground height, weather, catalog overrides), or
  ``{"module", "factory", "options"}`` to hand rendering to another world
  owner such as a reconstruction renderer; a named binding that cannot be
  imported is a typed ``frame_source_unavailable`` failure, never a synthetic
  frame.

There is deliberately no "synthetic" source. An episode that cannot get real
camera frames fails with ``frame_source_required``; fabricating views would
turn an infrastructure gap into a fake scientific result.
"""

from __future__ import annotations

import json
import os
import struct
from collections import deque
from pathlib import Path
from typing import Any, Iterable, Mapping, Protocol, Sequence

import numpy as np

#: Frames per camera in the Alpamayo observation window (oldest -> newest).
NUM_FRAMES_PER_CAMERA = 4
#: Ego-history steps in the Alpamayo observation window.
NUM_HISTORY_STEPS = 16

ENCODED_SUFFIXES = {".png": "png", ".jpg": "jpeg", ".jpeg": "jpeg"}


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


def _png_size(header: bytes) -> tuple[int, int]:
    if len(header) < 24 or header[:8] != b"\x89PNG\r\n\x1a\n":
        raise FrameSourceError("frame_decode_failed", "not a PNG file")
    width, height = struct.unpack(">II", header[16:24])
    return int(width), int(height)


def _jpeg_size(data: bytes) -> tuple[int, int]:
    """Read SOFn dimensions without decoding pixels."""
    if data[:2] != b"\xff\xd8":
        raise FrameSourceError("frame_decode_failed", "not a JPEG file")
    offset = 2
    end = len(data)
    while offset + 9 < end:
        if data[offset] != 0xFF:
            offset += 1
            continue
        marker = data[offset + 1]
        if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
            offset += 2
            continue
        length = struct.unpack(">H", data[offset + 2 : offset + 4])[0]
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
            height, width = struct.unpack(">HH", data[offset + 5 : offset + 9])
            return int(width), int(height)
        offset += 2 + length
    raise FrameSourceError("frame_decode_failed", "no JPEG SOF marker found")


def rgba_to_rgb_bytes(view: np.ndarray) -> tuple[bytes, int, int]:
    """Pack one ``(H, W, 4)`` RGBA array into contiguous ``H*W*3`` RGB bytes."""
    array = np.asarray(view)
    if array.ndim != 3 or array.shape[2] != 4:
        raise FrameSourceError("frame_decode_failed", f"expected (H, W, 4) rgba, got {array.shape}")
    height, width = int(array.shape[0]), int(array.shape[1])
    return np.ascontiguousarray(array[:, :, :3]).tobytes(), width, height


class DirectoryFrameSource:
    """Frames a renderer already wrote to disk, one file per decision step."""

    def __init__(self, root: str | Path, *, sensor_ids: Sequence[str] | None = None) -> None:
        self.root = Path(root).expanduser()
        if not self.root.is_dir():
            raise FrameSourceError("frame_source_unavailable", f"frame directory {self.root} does not exist")
        discovered = sorted(p.name for p in self.root.iterdir() if p.is_dir())
        wanted = list(sensor_ids) if sensor_ids else discovered
        missing = [s for s in wanted if s not in discovered]
        if missing:
            raise FrameSourceError(
                "frame_source_unavailable",
                f"frame directory {self.root} has no frames for {missing}",
                {"available": discovered, "missing": missing},
            )
        if not wanted:
            raise FrameSourceError("frame_source_unavailable", f"frame directory {self.root} is empty")
        self._sensor_ids = tuple(wanted)
        self._meta: dict[str, dict[str, Any]] = {}
        for sensor_id in self._sensor_ids:
            meta_path = self.root / sensor_id / "meta.json"
            if meta_path.is_file():
                self._meta[sensor_id] = json.loads(meta_path.read_text())

    @property
    def sensor_ids(self) -> tuple[str, ...]:
        return self._sensor_ids

    def capture(self, *, step: int, tick: int, t_s: float) -> dict[str, tuple[bytes, str, int, int]]:
        del tick, t_s
        out: dict[str, tuple[bytes, str, int, int]] = {}
        for sensor_id in self._sensor_ids:
            directory = self.root / sensor_id
            candidates = [directory / f"{step:06d}{suffix}" for suffix in (".raw", *ENCODED_SUFFIXES)]
            path = next((p for p in candidates if p.is_file()), None)
            if path is None:
                raise FrameSourceError(
                    "frame_missing",
                    f"{sensor_id}: no frame for decision step {step} in {directory}",
                    {"sensorId": sensor_id, "step": step},
                )
            payload = path.read_bytes()
            if path.suffix == ".raw":
                meta = self._meta.get(sensor_id)
                if not meta:
                    raise FrameSourceError(
                        "frame_source_unavailable",
                        f"{sensor_id}: raw frames need meta.json with width/height/format",
                        {"sensorId": sensor_id},
                    )
                width, height = int(meta["width"]), int(meta["height"])
                fmt = str(meta.get("format", "rgba8"))
                if fmt == "rgba8":
                    array = np.frombuffer(payload, dtype=np.uint8).reshape(height, width, 4)
                    packed, width, height = rgba_to_rgb_bytes(array)
                elif fmt == "rgb8":
                    if len(payload) != width * height * 3:
                        raise FrameSourceError(
                            "frame_decode_failed",
                            f"{sensor_id}: rgb8 frame is {len(payload)} B, expected {width * height * 3} B",
                        )
                    packed = payload
                else:
                    raise FrameSourceError("frame_decode_failed", f"{sensor_id}: unsupported raw format {fmt!r}")
                out[sensor_id] = (packed, "raw", width, height)
                continue
            encoding = ENCODED_SUFFIXES[path.suffix]
            width, height = _png_size(payload[:24]) if encoding == "png" else _jpeg_size(payload)
            out[sensor_id] = (payload, encoding, width, height)
        return out

    def close(self) -> None:  # nothing owned
        return None


class BevyFrameSource:
    """Cameras rendered by the resident Bevy renderer for the live episode."""

    def __init__(self, rig: Mapping[str, Any], env: Any, rig_dir: Path | None = None) -> None:
        cameras = list(rig.get("cameras") or ())
        if not cameras:
            raise FrameSourceError("frame_source_unavailable", "bevy rig document declares no cameras")
        scene = self._resolve_scene(rig.get("scene"), rig_dir)
        provider = self._resolve_provider(rig.get("sceneState"), env)
        try:
            from .bevy_sensors import BevySensorRig
        except ImportError as error:
            raise FrameSourceError(
                "frame_source_unavailable",
                f"the resident Bevy renderer is not installed: {error}",
            ) from error
        self._rig = BevySensorRig(scene, cameras, provider, passes=tuple(rig.get("passes") or ("rgb",)), device=False)
        self._sensor_ids = tuple(str(camera["sensorId"]) for camera in cameras)

    @staticmethod
    def _resolve_scene(scene: Any, rig_dir: Path | None) -> Any:
        """The render scene document, or a path to it.

        A rig may embed the scene inline or name a file. A relative path is
        resolved against ``SIMFORGE_SCENE_ROOT`` when set (the directory a
        cloud worker downloaded the tenant-scoped, digest-verified map bundle
        into), else against the rig document's own directory. That indirection
        is what lets one rig document ship in a worker image while the map
        bundle it renders arrives per job.
        """
        if scene is None:
            raise FrameSourceError(
                "frame_source_unavailable",
                "bevy rig document has no `scene`; the renderer needs the map/tile scene and never synthesizes one",
            )
        if not isinstance(scene, str):
            return scene
        candidate = Path(scene).expanduser()
        if not candidate.is_absolute():
            root = os.environ.get("SIMFORGE_SCENE_ROOT")
            base = Path(root).expanduser() if root else (rig_dir or Path.cwd())
            candidate = base / candidate
        if not candidate.exists():
            raise FrameSourceError(
                "frame_source_unavailable",
                f"rig scene {candidate} does not exist (set SIMFORGE_SCENE_ROOT to the delivered map bundle)",
                {"scene": str(candidate)},
            )
        return str(candidate)

    @staticmethod
    def _resolve_provider(binding: Mapping[str, Any] | None, env: Any) -> Any:
        """The scene-state source the renderer renders from.

        Default: the live episode itself
        (:class:`~simforge_oss_gym.scene_state.EnvSceneStateExporter`), which
        publishes the world as it is after the last applied action — so the
        rendered cameras react to what the policy did. A rig may name a
        different provider (`sceneState: {module, factory, options}`) when
        another component owns the world, e.g. a reconstruction renderer.
        """
        if env is None:
            raise FrameSourceError(
                "frame_source_unavailable",
                "a bevy rig needs the live environment to render from; none was passed",
            )
        if not binding:
            from .scene_state import make_env_scene_state_provider

            return make_env_scene_state_provider(env)
        if binding.get("module") is None and binding.get("factory") is None:
            from .scene_state import make_env_scene_state_provider

            # Options-only binding: tune the built-in exporter (map id, ground
            # height, weather, catalog overrides) without replacing it.
            return make_env_scene_state_provider(env, **dict(binding.get("options") or {}))
        import importlib

        module_name = str(binding.get("module") or "")
        factory_name = str(binding.get("factory") or "")
        if not module_name or not factory_name:
            raise FrameSourceError("frame_source_unavailable", "`sceneState` needs both `module` and `factory`")
        try:
            module = importlib.import_module(module_name)
            factory = getattr(module, factory_name)
        except (ImportError, AttributeError) as error:
            raise FrameSourceError(
                "frame_source_unavailable",
                f"scene-state provider {module_name}.{factory_name} is unavailable: {error}",
                {"module": module_name, "factory": factory_name},
            ) from error
        provider = factory(env, **dict(binding.get("options") or {}))
        if not callable(provider):
            raise FrameSourceError(
                "frame_source_unavailable",
                f"{module_name}.{factory_name} returned {type(provider).__name__}, not a callable provider",
            )
        return provider

    @property
    def sensor_ids(self) -> tuple[str, ...]:
        return self._sensor_ids

    def capture(self, *, step: int, tick: int, t_s: float) -> dict[str, tuple[bytes, str, int, int]]:
        del step, t_s
        frames = self._rig.render(tick)
        if isinstance(frames, dict):  # device leases are not a host path
            raise FrameSourceError("frame_source_unavailable", "device-mode Bevy rig cannot feed the wire observation")
        out: dict[str, tuple[bytes, str, int, int]] = {}
        for frame in frames:
            if frame.pass_name != "rgb":
                continue
            payload, width, height = rgba_to_rgb_bytes(frame.array)
            out[frame.sensor_id] = (payload, "raw", width, height)
        missing = [s for s in self._sensor_ids if s not in out]
        if missing:
            raise FrameSourceError("frame_missing", f"renderer returned no rgb pass for {missing}", {"missing": missing})
        return out

    def close(self) -> None:
        self._rig.close()


def make_frame_source(spec: str | None, env: Any = None, *, sensor_ids: Sequence[str] | None = None) -> FrameSource | None:
    """Build the source named by ``spec`` (``dir:<path>`` | ``bevy:<rig.json>``)."""
    if spec is None or spec == "" or spec == "none":
        return None
    scheme, _, target = spec.partition(":")
    if not target:
        raise FrameSourceError("frame_source_unavailable", f"frame source {spec!r} needs a target (`dir:<path>`)")
    if scheme == "dir":
        return DirectoryFrameSource(target, sensor_ids=sensor_ids)
    if scheme == "bevy":
        rig_path = Path(target).expanduser()
        if not rig_path.is_file():
            raise FrameSourceError("frame_source_unavailable", f"bevy rig document {rig_path} does not exist")
        return BevyFrameSource(json.loads(rig_path.read_text()), env, rig_path.parent)
    raise FrameSourceError("frame_source_unavailable", f"unknown frame source scheme {scheme!r} (expected dir|bevy)")


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
