"""NuRec splat rendering core shared by every host of this backend.

One `SplatBackend` owns the GPU residents (imported scene bundles + their NuRec packages, the
catalog mesh library, the actor rasterizer). A `SplatSession` is one consumer's resident state
(applied scene-state document, retained camera rig) together with the identity counters the
V5 envelope reports. `SplatBackend.render_tick` turns (session, sim_tick, passes) into device
tensors; the hosts decide where those go:

  * `service.py`  - separate-process host path: packs into the shm ring (declared host copy);
  * `tensor.py`   - in-process path: packs into leased CUDA slots handed to PyTorch consumers.

Neither host renders anything itself; pixel semantics live here once.

Frame identity (`render_core::engine::FrameIdentity`, camelCase on the wire):
  simTick        the caller's name for the resident scene state (never inferred);
  sceneRevision  bumps on every scene-state application on the session;
  rigRevision    bumps when the retained camera rig changes (register/replace/reset);
  generation     one per rendered tick across the backend - the single synchronous render every
                 pass of the tick was produced by.

Pose conventions: scene-state is y-up (x, y, z) with z = -y_source; the provider world is the
package's z-up frame. Ego actor centre = rig origin + Rz(yaw) * rig_bbox.centroid (importer).
"""
from __future__ import annotations

import gc
import hashlib
import json
import logging
import math
import re
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import torch
import torch.nn.functional as F

from .prerequisites import CapabilityError, HoodProfile, check_render_prerequisites
from .providers.nurec import NuRecScene, load_package_motion, rz, yaw_removed
from .render.actors import ActorPass, AssetLibrary, SunState, sun_from_cubemap
from .render.gaussians import _FLU_TO_GL, SplatRenderer, load_tracer_conf
from .protocol import PASSES, RGB_OUTPUT_FORMATS, parse_passes
from .ring import row_stride
from .source_patch import load_source_patch

log = logging.getLogger("simforge_splat")

__all__ = ["CapabilityError", "HoodProfile", "PASSES", "RGB_OUTPUT_FORMATS", "SplatBackend", "SplatSession",
           "TickRender", "CameraRender", "FrameIdentity", "OutputSpec", "output_spec", "parse_passes",
           "pack_rgb8", "pack_rgba8", "pack_depth", "pack_id", "RingPlane", "ring_planes", "source_sha"]


def source_sha() -> str:
    root = Path(__file__).resolve().parent
    digest = hashlib.sha256()
    for path in sorted(root.rglob("*.py")):
        digest.update(path.relative_to(root).as_posix().encode("utf-8") + b"\0")
        with path.open("rb") as stream:
            digest.update(hashlib.file_digest(stream, "sha256").digest())
    return digest.hexdigest()


def _hex_rgb(color: str | None) -> np.ndarray | None:
    if not color or not color.startswith("#") or len(color) != 7:
        return None
    return np.array([int(color[i:i + 2], 16) / 255.0 for i in (1, 3, 5)], dtype=np.float32)


# ----------------------------------------------------------------------------------
class LoadedScene:
    """One imported scene bundle + its NuRec package, resident on the GPU."""

    def __init__(self, bundle_dir: Path, device: torch.device, hood: HoodProfile, verify_digest: bool, source_packages: dict[str, Path] | None = None):
        self.bundle_dir = bundle_dir
        bg = json.loads((bundle_dir / "background.json").read_text())
        if bg.get("provider") != "nurec":
            raise ValueError(f"{bundle_dir}: background provider {bg.get('provider')!r} is not supported")
        self.background = bg
        expected = bg["sourceUsdzSha256"]
        if not isinstance(expected, str) or not re.fullmatch(r"[a-f0-9]{64}", expected):
            raise ValueError("invalid pinned source package SHA256")
        mapped = source_packages is not None and expected in source_packages
        usdz = source_packages[expected] if mapped else Path(bg["sourceUsdz"])
        if mapped and not usdz.is_absolute():
            raise ValueError("mapped source package path must be absolute")
        if not usdz.is_file():
            raise FileNotFoundError(f"{bundle_dir}: source package {usdz} is not reachable")
        package_digest = None
        if verify_digest or mapped:
            with usdz.open("rb") as stream:
                package_digest = hashlib.file_digest(stream, "sha256").hexdigest()
            if package_digest != expected:
                raise ValueError("source package identity mismatch")
        log.info("source package %s: expected_sha256=%s verified_sha256=%s", usdz, expected, package_digest)
        t0 = time.perf_counter()
        self.scene = NuRecScene(usdz, device=str(device))
        if verify_digest:
            member = bg["member"]
            digest = hashlib.sha256(self.scene.zip.read(member)).hexdigest()
            if digest != bg["digest"]:
                raise ValueError(f"{bundle_dir}: {member} digest {digest[:12]} != background.json {str(bg['digest'])[:12]}")
        self.motion = load_package_motion(self.scene.zip)
        self.authored_meshes, self.region_meshes = load_source_patch(self.scene, bg, bundle_dir, device)
        self.track_time_offsets = bg.get("sourcePatch", {}).get("trackTimeOffsetsUs", {})
        self.renderer = SplatRenderer(self.scene, hood=hood)
        self.actor_tracks: dict[str, str] = dict(bg.get("actorTracks", {}))
        self.episode_start_us = int(bg["episode"]["startTimestampUs"])
        self.shutter_us = int(bg.get("cameraShutterDurationUs", 30_000))
        centroid = np.asarray(self.motion["rig_bbox"]["centroid"], dtype=np.float64)
        self.rig_centroid_xy = centroid[:2]
        self.rig_height = float(self.motion["rig_height_above_ground_m"])
        self.sun = sun_from_cubemap(self.scene.sky, _FLU_TO_GL) if self.scene.sky is not None else SunState(np.array([0, 0, 1.0]), 0.0, np.full(3, 0.2), "no-envmap")
        self.load_s = time.perf_counter() - t0
        self.digest = str(bg["digest"])
        # ncore camera models by logical id are built lazily by the renderer

    def camera_resolution(self, sensor_id: str) -> tuple[int, int]:
        """(width, height) the package calibration renders `sensor_id` at."""
        cam = self.scene.cameras.get(sensor_id)
        if cam is None:
            raise ValueError(f"camera {sensor_id!r} is not calibrated in this package; the splat service renders the package's own cameras")
        return cam.resolution_wh

    # -- frame conversions -------------------------------------------------------
    def rig_pose_from_ego(self, actor: dict[str, Any], t_us: int) -> np.ndarray:
        """T_rig_world (source frame) from the ego actor's scene-state tick."""
        x_s, _y_s, z_s = (float(v) for v in actor["transform"]["position"])
        yaw = float(actor.get("yawRad", 0.0))
        c, s = math.cos(yaw), math.sin(yaw)
        cx, cy = self.rig_centroid_xy
        # importer: ego = rig + Rz(yaw) * centroid (source frame, y = -z_s)
        x = x_s - (c * cx - s * cy)
        y = -z_s - (s * cx + c * cy)
        z = self.motion["ground"].z_at(x, y) + self.rig_height
        _, r_rec = self.motion["ego"].at(t_us)
        rot = rz(yaw) * yaw_removed(r_rec)
        m = np.eye(4)
        m[:3, :3] = rot.as_matrix()
        m[:3, 3] = [x, y, z]
        return m

    def track_pose(self, track_id: str, actor: dict[str, Any], t_us: int) -> np.ndarray:
        """Cuboid frame pose in the source world for a recorded actor at the engine's pose."""
        x_s, _y_s, z_s = (float(v) for v in actor["transform"]["position"])
        yaw = float(actor.get("yawRad", 0.0))
        x, y = x_s, -z_s
        tr = self.motion["actors"][track_id]["traj"]
        source_t = t_us + int(self.track_time_offsets.get(track_id, 0))
        if not tr.contains(source_t):
            raise ValueError(f"track {track_id} outside recorded time support")
        p_rec, r_rec = tr.at(source_t)
        height_above_ground = p_rec[2] - self.motion["ground"].z_at(p_rec[0], p_rec[1])
        z = self.motion["ground"].z_at(x, y) + height_above_ground
        rot = rz(yaw) * yaw_removed(r_rec)
        m = np.eye(4)
        m[:3, :3] = rot.as_matrix()
        m[:3, 3] = [x, y, z]
        return m

    def mesh_pose(self, actor: dict[str, Any]) -> np.ndarray:
        x_s, _y_s, z_s = (float(v) for v in actor["transform"]["position"])
        yaw = float(actor.get("yawRad", 0.0))
        x, y = x_s, -z_s
        z = self.motion["ground"].z_at(x, y)
        m = np.eye(4)
        m[:3, :3] = rz(yaw).as_matrix()
        m[:3, 3] = [x, y, z]
        return m


# ----------------------------------------------------------------------------------
@dataclass(frozen=True)
class OutputSpec:
    """Host-visible rgb output requested by `cameras[].output`."""

    format: str  # rgb8 | rgba8
    width: int
    height: int


@dataclass(frozen=True)
class FrameIdentity:
    sim_tick: int
    scene_revision: int
    rig_revision: int
    generation: int

    def wire(self) -> dict[str, int]:
        return {"simTick": self.sim_tick, "sceneRevision": self.scene_revision, "rigRevision": self.rig_revision, "generation": self.generation}


@dataclass
class CameraRender:
    """Device tensors of one camera for one tick, at the package's calibrated resolution.

    rgb   float32 [H,W,3] in [0,1]: radiance after sky, actor composite, per-camera PPISP
          (vignetting + camera response), hood composite - the image the package's own cameras
          would capture; `pack_rgb8` quantizes it exactly like the host path.
    depth float32 [H,W,1] metres: expected hit distance; DEPTH_FAR_M where the splat has no
          coverage; 0 under the hood; injected/replacement geometry composited by depth.
    ids   uint8 [H,W,4]: instance id (little-endian u16 in R,G; 1 + index in ascending actor-id
          order), alpha 255; None unless the id pass was requested.
    """

    sensor_id: str
    width: int
    height: int
    output: OutputSpec
    rgb: torch.Tensor
    depth: torch.Tensor
    ids: torch.Tensor | None
    frame_time_ms: float


@dataclass
class TickRender:
    identity: FrameIdentity
    passes: tuple[str, ...]
    cameras: list[CameraRender]
    visibility: dict[str, list[dict]]
    source_evidence: dict[str, Any]
    source_timestamp_us: int


class SplatSession:
    """One consumer's resident state; the identity counters belong here."""

    def __init__(self) -> None:
        self.states: list[dict[str, Any]] = []
        self.tick_index: int | None = None
        self.state: dict[str, Any] | None = None
        self.scene_key: str | None = None
        self.cameras: list[dict[str, Any]] = []
        self.scene_revision = 0
        self.rig_revision = 0
        self._rig_key: str | None = None

    def load_scene_state(self, states: list[dict[str, Any]]) -> str:
        """Retain a simforge.scene-state.v1 stream (one document per tick); frame 0 becomes resident."""
        if not states:
            raise ValueError("load_scene_state: no states")
        map_id = states[0].get("mapId")
        if not isinstance(map_id, str) or not map_id:
            raise ValueError("load_scene_state: mapId required")
        for k, doc in enumerate(states):
            if doc.get("version") != "simforge.scene-state.v1":
                raise ValueError(f"load_scene_state: states[{k}] version {doc.get('version')!r} != simforge.scene-state.v1")
            if doc.get("mapId") != map_id:
                raise ValueError(f"load_scene_state: states[{k}] mapId {doc.get('mapId')!r} != {map_id!r}; one stream renders one scene")
        self.states = list(states)
        self.tick_index = 0
        self.state = self.states[0]
        self.scene_key = map_id
        self.scene_revision += 1
        return map_id

    def apply_tick(self, index: int) -> None:
        """Make frame `index` of the retained stream resident (V5 `tick_index`)."""
        if not self.states:
            raise ValueError("tick_index: load_scene_state first")
        if not 0 <= index < len(self.states):
            raise ValueError(f"tick_index {index} outside the loaded stream of {len(self.states)} ticks")
        if index != self.tick_index:
            self.tick_index = index
            self.state = self.states[index]
            self.scene_revision += 1

    def set_cameras(self, cameras: list[dict[str, Any]]) -> bool:
        """Replace the retained rig; returns whether it changed (rigRevision bumped)."""
        if not cameras:
            raise ValueError("render_bundle: cameras must not be empty")
        for cam in cameras:
            if not isinstance(cam.get("sensorId"), str) or not cam["sensorId"]:
                raise ValueError("camera without sensorId")
            output_spec(cam)  # validate format now, not at first render
        key = json.dumps(cameras, sort_keys=True, separators=(",", ":"), default=str)
        if key == self._rig_key:
            return False
        self.cameras = [dict(c) for c in cameras]
        self._rig_key = key
        self.rig_revision += 1
        return True

    def reset_cameras(self) -> None:
        if self.cameras or self._rig_key is not None:
            self.rig_revision += 1
        self.cameras = []
        self._rig_key = None


def output_spec(cam_spec: dict[str, Any], calibrated: tuple[int, int] | None = None) -> OutputSpec | None:
    """Parse `cameras[].output`. Without `calibrated` only the format is checked."""
    output = cam_spec.get("output")
    if output is None:
        if calibrated is None:
            return None
        return OutputSpec("rgba8", calibrated[0], calibrated[1])
    fmt = output.get("format", "rgb8")
    if fmt == "jpeg":
        raise CapabilityError(f"camera {cam_spec.get('sensorId')!r}: JPEG output is not served by the splat backend (no encoder); request rgb8 or rgba8")
    if fmt not in RGB_OUTPUT_FORMATS:
        raise CapabilityError(f"camera {cam_spec.get('sensorId')!r}: output format {fmt!r} unsupported; one of {RGB_OUTPUT_FORMATS}")
    if calibrated is None:
        return None
    width = int(output.get("width", calibrated[0]))
    height = int(output.get("height", calibrated[1]))
    if width <= 0 or height <= 0:
        raise ValueError(f"camera {cam_spec.get('sensorId')!r}: output size {width}x{height} invalid")
    if fmt == "rgba8" and (width, height) != calibrated:
        raise CapabilityError(f"camera {cam_spec.get('sensorId')!r}: rgba8 output is published at the calibrated {calibrated[0]}x{calibrated[1]} only; use rgb8 for a resampled policy view")
    return OutputSpec(fmt, width, height)


# ----------------------------------------------------------------------------------
# GPU-side packing shared by both hosts (the ONLY quantization/resampling in this backend).
def pack_rgb8(rgb: torch.Tensor, out: torch.Tensor) -> torch.Tensor:
    """rgb float [H,W,3] -> uint8 [oh,ow,3] into `out` (area resample when the size differs)."""
    oh, ow = out.shape[:2]
    if (oh, ow) != tuple(rgb.shape[:2]):
        rgb = F.interpolate(rgb.permute(2, 0, 1)[None], size=(oh, ow), mode="area")[0].permute(1, 2, 0)
    out.copy_((rgb.clamp(0, 1) * 255.0 + 0.5).to(torch.uint8))
    return out


def pack_rgba8(rgb: torch.Tensor, out: torch.Tensor) -> torch.Tensor:
    """rgb float [H,W,3] -> uint8 [H,W,4] into `out`, alpha 255."""
    out[..., :3] = (rgb.clamp(0, 1) * 255.0 + 0.5).to(torch.uint8)
    out[..., 3] = 255
    return out


def pack_depth(depth: torch.Tensor, out: torch.Tensor) -> torch.Tensor:
    """depth float [H,W,1] -> float32 [H,W] into `out`."""
    out.copy_(depth[..., 0])
    return out


def pack_id(ids: torch.Tensor, out: torch.Tensor) -> torch.Tensor:
    out.copy_(ids)
    return out


@dataclass(frozen=True)
class RingPlane:
    """One pass of one camera packed exactly as a ring record payload (row-padded like shm.rs)."""

    sensor_id: str
    pass_: str
    format: str  # rgb8 | rgba8 | depth32f
    width: int
    height: int
    data: torch.Tensor  # device tensor whose flat bytes are the payload


def ring_planes(cam: CameraRender, passes: tuple[str, ...]) -> list[RingPlane]:
    """Pack a camera's requested passes into their ring layouts on the GPU (no host bytes).

    Both host paths (shm service, durable job) publish these bytes verbatim, so their CRC32
    digests are comparable across hosts and with the in-process tensor planes."""
    cid, W, H, dev = cam.sensor_id, cam.width, cam.height, cam.rgb.device
    out: list[RingPlane] = []
    if "rgb" in passes:
        spec = cam.output
        if spec.format == "rgb8":
            u8 = pack_rgb8(cam.rgb, torch.empty((spec.height, spec.width, 3), dtype=torch.uint8, device=dev))
            out.append(RingPlane(cid, "rgb", "rgb8", spec.width, spec.height, u8))
        else:
            rgba = torch.zeros((H, row_stride("rgba8", W)), dtype=torch.uint8, device=dev)
            pack_rgba8(cam.rgb, rgba[:, : W * 4].view(H, W, 4))
            out.append(RingPlane(cid, "rgb", "rgba8", W, H, rgba))
    if "depth" in passes:
        d = torch.zeros((H, row_stride("depth32f", W) // 4), dtype=torch.float32, device=dev)
        pack_depth(cam.depth, d[:, :W])
        out.append(RingPlane(cid, "depth", "depth32f", W, H, d))
    if "id" in passes:
        buf = torch.zeros((H, row_stride("rgba8", W)), dtype=torch.uint8, device=dev)
        pack_id(cam.ids, buf[:, : W * 4].view(H, W, 4))
        out.append(RingPlane(cid, "id", "rgba8", W, H, buf))
    return out


# ----------------------------------------------------------------------------------
class SplatBackend:
    """GPU residents + the per-tick render. Thread-safe through `gpu_lock`."""

    def __init__(self, scenes_root: str | Path, catalog_roots: list[str | Path], *, hood: HoodProfile | str | Path | None,
                 device: str | torch.device = "cuda", verify_digest: bool = True,
                 source_packages: dict[str, Path] | None = None, max_scenes: int = 12,
                 determinism: str = "schedule-and-structure"):
        """`hood` is mandatory and explicit: a directory of `<cameraId>.png` overlays or the string
        `"none"` (a `HoodProfile` is accepted too). There is no default overlay location."""
        device = torch.device(device)
        if device.type != "cuda":
            raise CapabilityError(f"the splat backend renders on CUDA only (got {device})")
        self.prerequisites = check_render_prerequisites()
        self.device = torch.device("cuda", device.index if device.index is not None else torch.cuda.current_device())
        self.hood = hood if isinstance(hood, HoodProfile) else HoodProfile.parse(hood)
        self.scenes_root = Path(scenes_root)
        if not self.scenes_root.is_dir():
            raise FileNotFoundError(f"scenes root {self.scenes_root} is not a directory")
        self.max_scenes = int(max_scenes)
        self.verify_digest = verify_digest
        self.source_packages = source_packages
        self.determinism = determinism
        self._scenes: OrderedDict[str, LoadedScene] = OrderedDict()
        self.gpu_lock = threading.RLock()
        self.assets = AssetLibrary([Path(p) for p in catalog_roots], self.device)
        self.actor_pass = ActorPass(self.device)
        self.build = source_sha()
        conf = load_tracer_conf("3dgut")
        self.config_sha = hashlib.sha256(json.dumps({k: conf.render.splat[k] for k in sorted(conf.render.splat.keys())}, sort_keys=True, default=str).encode()).hexdigest()[:16]
        self._generation = 0
        self._boxes: dict[tuple, Any] = {}

    def renderer_info(self) -> dict[str, Any]:
        from . import __version__

        return {"implementation": "splat-native", "version": __version__, "backend": "3dgut",
                "device": torch.cuda.get_device_name(self.device), "build": self.build, "buildScope": "python-source-tree",
                "torchVersion": torch.__version__, "cudaVersion": torch.version.cuda, "config": self.config_sha,
                "threedgrutRoot": self.prerequisites["threedgrutRoot"], "hood": self.hood.wire()}

    # -- scenes -------------------------------------------------------------------
    def scene_for(self, map_id: str) -> LoadedScene:
        with self.gpu_lock:
            if map_id in self._scenes:
                self._scenes.move_to_end(map_id)
                return self._scenes[map_id]
            bundle = self.scenes_root / map_id
            if not (bundle / "background.json").exists():
                raise FileNotFoundError(f"no imported scene bundle for mapId {map_id!r} under {self.scenes_root}")
            while len(self._scenes) >= self.max_scenes:
                self._evict_one()
            try:
                scene = LoadedScene(bundle, self.device, self.hood, verify_digest=self.verify_digest, source_packages=self.source_packages)
            except torch.OutOfMemoryError:
                # the GPU is shared (policy endpoint, other residents): shed resident scenes and retry
                # once rather than failing the caller's episode
                log.warning("out of memory loading %s with %d resident scenes; evicting all and retrying", map_id, len(self._scenes))
                while self._scenes:
                    self._evict_one()
                scene = LoadedScene(bundle, self.device, self.hood, verify_digest=self.verify_digest, source_packages=self.source_packages)
            self._scenes[map_id] = scene
            log.info("loaded scene %s in %.1fs (%d gaussians, %d tracks, sun %s)", map_id, scene.load_s, scene.scene.total_gaussians(), len(scene.actor_tracks), scene.sun.source)
            return scene

    def _evict_one(self) -> None:
        evicted, old = self._scenes.popitem(last=False)
        del old
        gc.collect()
        torch.cuda.empty_cache()
        log.info("evicted scene %s", evicted)

    # -- rendering ----------------------------------------------------------------
    def render_tick(self, session: SplatSession, sim_tick: int, passes: tuple[str, ...]) -> TickRender:
        """Render every retained camera of `session` for one sim tick.

        Synchronous on the caller's current CUDA stream: every returned tensor is produced by torch
        ops (and the 3DGUT tracer extension) enqueued on that stream, so a consumer that orders on
        the same stream - or records an event on it - observes complete frames.
        """
        if not session.cameras:
            raise ValueError("render_bundle: no cameras retained (send `cameras` once)")
        if session.state is None or session.scene_key is None:
            raise ValueError("render_bundle: load_scene_state first")
        with self.gpu_lock:
            scene = self.scene_for(session.scene_key)
            self._generation += 1
            identity = FrameIdentity(int(sim_tick), session.scene_revision, session.rig_revision, self._generation)
            return self._render(scene, session, identity, passes)

    def _render(self, scene: LoadedScene, session: SplatSession, identity: FrameIdentity, passes: tuple[str, ...]) -> TickRender:
        doc = session.state
        tick_hz = float(doc.get("tickHz") or 10.0)
        tick = int(doc.get("tick") or 0)
        t_us = scene.episode_start_us + int(round(tick / tick_hz * 1e6))
        if scene.background.get("sourcePatch"):
            end = min(scene.scene.time_range_us[1], scene.episode_start_us + int(scene.background["episode"]["durationS"] * 1e6))
            if not scene.scene.time_range_us[0] <= t_us < end:
                raise ValueError("tick outside reconstruction support")
        actors = {a["id"]: a for a in doc.get("actors", [])}
        ego = actors.get("ego")
        if ego is None:
            raise ValueError("scene state has no 'ego' actor")
        T_rig_end = scene.rig_pose_from_ego(ego, t_us)
        # rolling-shutter start pose: extrapolate backwards with the ego velocity over the shutter
        vel = ego.get("velocity") or [0.0, 0.0, 0.0]
        dt = scene.shutter_us / 1e6
        T_rig_start = T_rig_end.copy()
        T_rig_start[0, 3] -= float(vel[0]) * dt
        T_rig_start[1, 3] -= -float(vel[2]) * dt
        # recorded actors: their Gaussians at the engine's pose; injected: catalog meshes
        posed: dict[str, np.ndarray] = {}
        meshes: list[tuple[Any, np.ndarray, np.ndarray | None, str]] = list(scene.region_meshes)
        for aid, a in actors.items():
            if aid == "ego" or a.get("kind") == "despawn":
                continue
            track = scene.actor_tracks.get(aid)
            if track is not None and track in scene.motion["actors"]:
                posed[track] = scene.track_pose(track, a, t_us)
            elif aid in scene.authored_meshes:
                asset, local, tint, _ = scene.authored_meshes[aid]
                meshes.append((asset, scene.mesh_pose(a) @ local, tint, aid))
            else:
                cid = a.get("catalogId")
                if not cid:
                    raise ValueError(f"actor {aid!r} requires an explicit catalogId or fork mesh binding")
                asset = self.assets.get(cid)
                meshes.append((asset, scene.mesh_pose(a), _hex_rgb(a.get("color")), aid))
        r = scene.renderer
        g = r.assemble(t_us, posed, scene.track_time_offsets)
        W2N = scene.scene.world_to_nre
        renders: list[CameraRender] = []
        visibility: dict[str, list[dict]] = {}
        for cam_spec in session.cameras:
            cid = cam_spec["sensorId"]
            calibrated = scene.camera_resolution(cid)
            cam = scene.scene.cameras[cid]
            proj = cam_spec.get("projection")
            if proj is not None and proj.get("type") != "ftheta":
                raise CapabilityError(f"camera {cid!r}: projection {proj.get('type')!r} unsupported")
            # authoritative extrinsic: projection.tSensorRig if supplied, else the package calibration
            if proj is not None and proj.get("tSensorRig"):
                cam_T = np.asarray(proj["tSensorRig"], dtype=np.float64).reshape(4, 4)
                if not np.allclose(cam_T, cam.T_rig_from_cam, atol=1e-6):
                    raise ValueError(f"camera {cid!r}: calibrated extrinsic override unsupported; diagnostic views must not alter the sensor rig")
            spec = output_spec(cam_spec, calibrated)

            def composite(raw, alpha, depth, C2W1, rays_dir, cam=cam):
                if not meshes:
                    return raw, depth
                cm = r._camera_models[cam.logical_id]
                W2C = np.linalg.inv(C2W1)
                out = self.actor_pass.render(cm, raw.shape[1], raw.shape[0], W2C, [(m[0], W2N @ m[1], m[2]) for m in meshes], scene.sun)
                if out is None:
                    return raw, depth  # all mesh faces may be outside this calibrated camera
                a_rgb, a_hit, a_dist = out
                d0 = depth[..., 0]
                front = (a_hit > 0) & (a_dist < d0)
                # shadow on the background from the injected actors (sun-space shadow map)
                pts = torch.from_numpy(C2W1[:3, 3].astype(np.float32)).to(raw.device) + (rays_dir @ torch.from_numpy(C2W1[:3, :3].astype(np.float32)).to(raw.device).T) * d0[..., None]
                shadow = self.actor_pass.ground_shadow(pts, [(m[0], W2N @ m[1], m[2]) for m in meshes], scene.sun)
                if shadow is not None:
                    raw = raw * shadow[..., None]
                raw = torch.where(front[..., None], a_rgb, raw)
                depth = torch.where(front[..., None], a_dist[..., None], depth)
                return raw, depth

            out = r.render_camera(g, cam, T_rig_start, T_rig_end, composite=composite)
            rgb = out["rgb"]
            H, W = rgb.shape[:2]
            if (W, H) != calibrated:
                raise RuntimeError(f"camera {cid!r}: renderer produced {W}x{H}, calibration says {calibrated[0]}x{calibrated[1]}")
            ids = None
            if "id" in passes:
                ids, visibility[cid] = self.id_pass(scene, r, cam, g, out, T_rig_end, actors, posed, meshes)
            renders.append(CameraRender(cid, W, H, spec, rgb, out["depth"], ids, float(out["frame_time_ms"])))
        evidence = {
            "schema": "simforge.nurec-render-evidence/v1",
            "sourceTimestampUs": t_us,
            "trackTimeOffsetsUs": dict(sorted(scene.track_time_offsets.items())),
            "posedTransformSha256": hashlib.sha256(json.dumps(
                {key: value.tolist() for key, value in sorted(posed.items())},
                separators=(",", ":"), allow_nan=False).encode()).hexdigest(),
            "rigTransformSha256": hashlib.sha256(json.dumps(
                T_rig_end.tolist(), separators=(",", ":"), allow_nan=False).encode()).hexdigest(),
            "regions": getattr(scene.scene, "source_patch_regions", []),
            "retainedStaticCounts": {name: layer.n for name, layer in sorted(scene.scene.layers.items()) if layer.cuboid_ids is None},
            "hood": self.hood.wire(),
            "qualification": "not-qualified",
        }
        return TickRender(identity, passes, renders, visibility, evidence, t_us)

    def id_pass(self, scene, r, cam, g, out, T_rig_end, actors, posed, meshes) -> tuple[torch.Tensor, list[dict]]:
        """Instance ids (1 + index in ascending actor-id order, semantic-legend rule) as [H,W,4] uint8,
        plus the per-actor visible set for this camera (O4): projected proxy pixels, pixels that pass the
        splat-depth test, visible fraction, 2-D bbox of the visible pixels, distance.

        Recorded actors are drawn as their truth cuboids (pose + dims from the scene state, never from
        the splat), injected ones as their meshes, all in ONE rasterization under the f-theta lens
        (nearest proxy wins); a pixel belongs to an actor when that proxy lies within 0.75 m of the
        composite depth (its own Gaussians / mesh are there) - an actor behind a reconstructed
        building fails the test and is occluded.
        """
        H, W = out["rgb"].shape[:2]
        ids = torch.zeros((H, W, 4), dtype=torch.uint8, device=out["rgb"].device)
        ids[..., 3] = 255
        order = sorted(a for a in actors if a != "ego")
        instance = {aid: 1 + k for k, aid in enumerate(order)}
        proxies = []
        for aid, a in actors.items():
            if aid == "ego" or a.get("kind") == "despawn":
                continue
            track = scene.actor_tracks.get(aid)
            if track is not None and track in posed:
                dims = scene.motion["actors"][track].get("dims") or a.get("dims") or [4.5, 2.0, 1.6]
                proxies.append((self._box_asset(dims), posed[track], instance[aid]))
        for asset, T, _tint, aid in meshes:
            if aid not in actors:
                continue  # replacement geometry occludes via composite depth; not an actor
            # injected actors are also drawn as their truth cuboid (dims from the scene state, else the
            # catalog asset's extent) - the same rule as the Bevy service's id pass, and the convex
            # silhouette makes projectedPx exact
            dims = actors[aid].get("dims") or [asset.length_m, asset.width_m, asset.height_m]
            if isinstance(dims, dict):
                dims = [dims["l"], dims["w"], dims["h"]]
            Tc = np.array(T, dtype=np.float64)
            Tc[:3, 3] += Tc[:3, 2] * (float(dims[2]) / 2.0)  # mesh origin is on the ground; the cuboid is centred
            proxies.append((self._box_asset(dims), Tc, instance[aid]))
        if not proxies:
            return ids, []
        cm = r._camera_models[cam.logical_id]
        C2W1 = scene.scene.world_to_nre @ T_rig_end @ cam.T_rig_from_cam
        W2C = np.linalg.inv(C2W1)
        W2N = scene.scene.world_to_nre
        res = self.actor_pass.render_ids(cm, W, H, W2C, [(asset, W2N @ T, inst) for asset, T, inst in proxies])
        if res is None:
            return ids, []
        label, dist, extents = res
        depth = out["depth"][..., 0]
        ok = (label > 0) & (dist <= depth + 0.75)
        lab = torch.where(ok, label, torch.zeros_like(label))
        ids[..., 0] = (lab & 0xFF).to(torch.uint8)
        ids[..., 1] = ((lab >> 8) & 0xFF).to(torch.uint8)
        n_inst = 1 + len(order)
        visible = torch.bincount(lab.reshape(-1), minlength=n_inst)[:n_inst].tolist()
        by_inst = {inst: aid for aid, inst in instance.items()}
        vis: list[dict] = []
        for inst in range(1, n_inst):
            ext = extents.get(inst)
            if ext is None:
                continue  # not in this camera's image
            area, bbox_proj = ext
            entry = {"actorId": by_inst[inst], "instance": inst, "projectedPx": int(round(area)), "projectedBboxPx": bbox_proj,
                     "visiblePx": int(visible[inst]), "visibleFraction": round(min(1.0, visible[inst] / area), 4)}
            if visible[inst]:
                m = lab == inst
                ys, xs = torch.nonzero(m, as_tuple=True)
                entry["bboxPx"] = [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1]
                entry["distanceM"] = round(float(dist[m].median()), 2)
            vis.append(entry)
        return ids, vis

    def _box_asset(self, dims):
        if isinstance(dims, dict):
            dims = [dims["l"], dims["w"], dims["h"]]
        key = tuple(round(float(v), 3) for v in dims[:3])
        if key in self._boxes:
            return self._boxes[key]
        import trimesh
        from .render.actors import MeshAsset

        l, w, h = key
        box = trimesh.creation.box(extents=(l, w, h))
        v = np.asarray(box.vertices, dtype=np.float32)
        f = np.asarray(box.faces, dtype=np.int64)
        dev = self.device
        asset = MeshAsset("__cuboid__", torch.from_numpy(v).to(dev), torch.from_numpy(f).to(dev),
                          torch.full((len(v), 3), 0.5, device=dev), torch.from_numpy(np.asarray(box.vertex_normals, dtype=np.float32)).to(dev),
                          torch.zeros(len(v), dtype=torch.bool, device=dev), l, w, h)
        self._boxes[key] = asset
        return asset
