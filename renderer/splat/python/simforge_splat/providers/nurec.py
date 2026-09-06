"""NuRec (.usdz / volume.nurec) loader → in-memory Gaussian layers for in-process rendering.

Format facts used here (all read from the package itself):
- `volume.nurec` = gzip(msgpack({nre_data: {version, model, config, state_dict}})).
- state_dict tensors are float16 bytes + `.shape` entries (same layout 3DGRUT's NuRecUSDImporter reads).
- Layers under `.gaussians_nodes.<layer>.`: positions[N,3], rotations[N,4] (wxyz, pre-normalize),
  scales[N,3] (pre-exp), densities[N,1] (pre-sigmoid), features_albedo[N,3] or [N,F,3] (Fourier
  time coefficients, index 0 = DC), features_specular[N,45] (SH deg 3 minus DC).
- Rigid actors: `.gaussians_nodes.dynamic_rigids.gaussian_cuboid_ids[N]` → index into
  `_extra_state.obj_track_ids.dynamic_rigids`; gaussians live in the cuboid-local frame.
- Sky: `.background.textures[1,6,S,S,3]` cubemap (OpenGL face order), sampled with rays in the
  OpenGL frame (NRE FLU→GL: x_gl=-y, y_gl=z, z_gl=-x), composited as rgb + (1-alpha)*sky.
- Camera models: `rig_trajectories.json[camera_calibrations]` (ncore FTheta at render resolution,
  T_sensor_rig = camera→rig, OpenCV camera axes) — the package's own f-theta model.
- Frames: Gaussians are in the NRE frame; poses in rig_trajectories/sequence_tracks are in the
  "world" (simulation) frame; `world_to_nre` converts.
"""
from __future__ import annotations

import gzip
import json
import math
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import msgpack
import numpy as np
import torch

A15_CAMERAS = (
    "camera_cross_left_120fov",
    "camera_front_wide_120fov",
    "camera_cross_right_120fov",
    "camera_front_tele_30fov",
)


def _t(state: dict, key: str, dtype=np.float16) -> np.ndarray:
    raw = state[key]
    shape = state.get(key + ".shape")
    arr = np.frombuffer(raw, dtype=dtype)
    return arr.reshape(shape) if shape is not None else arr


@dataclass
class GaussianLayer:
    name: str
    positions: torch.Tensor  # [N,3] (NRE frame for static layers; cuboid-local for rigids)
    rotations: torch.Tensor  # [N,4] wxyz normalized
    scales: torch.Tensor  # [N,3] post-exp
    densities: torch.Tensor  # [N,1] post-sigmoid
    albedo: torch.Tensor  # [N,F,3] (F>=1; index 0 = DC)
    specular: torch.Tensor  # [N,45]
    time_min_us: int = 0
    time_max_us: int = 1
    # rigid-layer extras
    cuboid_ids: torch.Tensor | None = None  # [N] int64 → track slot
    track_ids: list[str] = field(default_factory=list)
    track_time_ranges: torch.Tensor | None = None  # [T,2] int64

    @property
    def n(self) -> int:
        return int(self.positions.shape[0])

    @property
    def fourier_dim(self) -> int:
        return int(self.albedo.shape[1])


@dataclass
class CameraModel:
    logical_id: str
    params: dict[str, Any]  # ncore FThetaCameraModelParameters-compatible dict
    T_rig_from_cam: np.ndarray  # 4x4, OpenCV camera axes → rig FLU

    @property
    def resolution_wh(self) -> tuple[int, int]:
        r = self.params["resolution"]
        return int(r[0]), int(r[1])


class NuRecScene:
    def __init__(self, usdz_path: str | Path, device: str = "cuda", *, layers: tuple[str, ...] | None = None):
        self.path = Path(usdz_path)
        self.device = torch.device(device)
        self.zip = zipfile.ZipFile(self.path)
        raw = gzip.decompress(self.zip.read("volume.nurec"))
        blob = msgpack.unpackb(raw, raw=False, strict_map_key=False)["nre_data"]
        self.version = blob["version"]
        self.config = blob["config"]
        state = blob["state_dict"]
        self.layer_config = self.config["layers"]
        extra = state["._extra_state"]
        self.obj_track_ids: dict[str, list[str]] = extra["obj_track_ids"]

        self.layers: dict[str, GaussianLayer] = {}
        wanted = layers or tuple(self.layer_config.keys())
        for name in wanted:
            pref = f".gaussians_nodes.{name}"
            if f"{pref}.positions" not in state:
                continue
            self.layers[name] = self._load_layer(name, pref, state)

        # sky cubemap [6,S,S,3]
        if ".background.textures" in state:
            tex = _t(state, ".background.textures").astype(np.float32)[0]
            self.sky = torch.from_numpy(tex).to(self.device).clamp_(0, 1).contiguous()
        else:
            self.sky = None

        # PPISP params (per-camera vignetting/CRF; per-frame exposure/color kept for reference)
        self.ppisp = {}
        for k in ("exposure_params", "vignetting_params", "color_params", "crf_params"):
            kk = f".post_processings.0.ppisp.{k}"
            if kk in state:
                self.ppisp[k] = torch.from_numpy(_t(state, kk).astype(np.float32)).to(self.device)

        # package-side metadata
        rig = json.loads(self.zip.read("rig_trajectories.json"))
        self.world_to_nre = np.asarray(rig["world_to_nre"]["matrix"], dtype=np.float64)
        self.cameras: dict[str, CameraModel] = {}
        self.sensor_idx: dict[str, int] = {}
        for key, cal in rig["camera_calibrations"].items():
            lid = cal["logical_sensor_name"]
            cm = cal["camera_model"]
            assert cm["type"] == "ftheta", cm["type"]
            p = dict(cm["parameters"])
            self.cameras[lid] = CameraModel(lid, p, np.asarray(cal["T_sensor_rig"], dtype=np.float64))
            self.sensor_idx[lid] = int(cal["unique_sensor_idx"])
        # checkpoint camera order (metadata.yaml) → ppisp camera index
        import yaml

        meta = yaml.safe_load(self.zip.read("metadata.yaml"))
        self.camera_order: list[str] = list(meta["sensors"]["camera_ids"])
        self.time_range_us = (int(meta["time_range"]["start"]), int(meta["time_range"]["end"]))

    # ------------------------------------------------------------------
    def _load_layer(self, name: str, pref: str, state: dict) -> GaussianLayer:
        dev = self.device
        f32 = lambda k: torch.from_numpy(_t(state, f"{pref}.{k}").astype(np.float32)).to(dev)
        pos = f32("positions")
        rot = torch.nn.functional.normalize(f32("rotations"), dim=1)
        scl = torch.exp(f32("scales"))
        dns = torch.sigmoid(f32("densities"))
        alb = f32("features_albedo")
        if alb.ndim == 2:
            alb = alb[:, None, :]
        spec = f32("features_specular")
        layer = GaussianLayer(name, pos, rot, scl, dns, alb.contiguous(), spec)
        te = state.get(f"{pref}.time_embed._extra_state")
        if isinstance(te, dict) and "timestamps_us_min" in te:
            layer.time_min_us, layer.time_max_us = int(te["timestamps_us_min"]), int(te["timestamps_us_max"])
        else:
            layer.time_min_us, layer.time_max_us = self._time_range_fallback(state)
        cid_key = f"{pref}.gaussian_cuboid_ids"
        if cid_key in state:
            layer.cuboid_ids = torch.from_numpy(_t(state, cid_key, np.int32).astype(np.int64)).to(dev)
            layer.track_ids = list(self.obj_track_ids.get(name, []))
            rng_key = f"{pref}.time_embed.timestamps_us_ranges"
            if rng_key in state:
                layer.track_time_ranges = torch.from_numpy(_t(state, rng_key, np.int64).copy()).to(dev)
        return layer

    @staticmethod
    def _time_range_fallback(state: dict) -> tuple[int, int]:
        te = state.get(".gaussians_nodes.background.time_embed._extra_state")
        if isinstance(te, dict):
            return int(te["timestamps_us_min"]), int(te["timestamps_us_max"])
        return 0, 1

    # ------------------------------------------------------------------
    def total_gaussians(self) -> int:
        return sum(l.n for l in self.layers.values())

    def gpu_bytes(self) -> int:
        n = 0
        for l in self.layers.values():
            for t in (l.positions, l.rotations, l.scales, l.densities, l.albedo, l.specular):
                n += t.numel() * t.element_size()
        if self.sky is not None:
            n += self.sky.numel() * 4
        return n


# ----------------------------------------------------------------------
# Fourier time basis. NRE stores F coefficients per Gaussian with index 0 = DC (its initializer
# writes the static albedo into [:,0,:]); the remaining basis is not documented in an open source.
# `basis_kind` selects a candidate; B2 picks the one that matches NRE renders best (see BENCHMARK).
def fourier_basis(F: int, t01: float, kind: str, device) -> torch.Tensor:
    if F == 1 or kind == "dc":
        b = torch.zeros(F, device=device)
        b[0] = 1.0
        return b
    t = float(t01)
    if kind == "cos_pi_k":  # [cos(pi k t)]_{k=0..F-1}
        k = torch.arange(F, device=device, dtype=torch.float32)
        return torch.cos(math.pi * k * t)
    if kind == "sincos_2pi":  # [1, sin(2pi t), cos(2pi t), sin(4pi t), cos(4pi t), ...]
        out = torch.zeros(F, device=device)
        out[0] = 1.0
        for i in range(1, F):
            f = (i + 1) // 2
            out[i] = math.sin(2 * math.pi * f * t) if i % 2 == 1 else math.cos(2 * math.pi * f * t)
        return out
    if kind == "sincos_pi":  # [1, sin(pi t), cos(pi t), sin(2pi t), ...]
        out = torch.zeros(F, device=device)
        out[0] = 1.0
        for i in range(1, F):
            f = (i + 1) // 2
            out[i] = math.sin(math.pi * f * t) if i % 2 == 1 else math.cos(math.pi * f * t)
        return out
    raise ValueError(kind)


# ----------------------------------------------------------------------------------
# Package trajectories, ground and the BackgroundProvider face (simforge.splat-backend/v1)
# ----------------------------------------------------------------------------------
import io as _io

from scipy.spatial import cKDTree
from scipy.spatial.transform import Rotation


@dataclass
class Traj:
    """Time-indexed rigid poses (source world, z-up). Interpolates position linearly, rotation by slerp."""

    t_us: np.ndarray
    pos: np.ndarray  # [N,3]
    quat_xyzw: np.ndarray  # [N,4]

    def __post_init__(self):
        order = np.argsort(self.t_us, kind="stable")
        self.t_us, self.pos, self.quat_xyzw = self.t_us[order], self.pos[order], self.quat_xyzw[order]
        # make consecutive quaternions hemisphere-consistent so nlerp never goes the long way
        q = self.quat_xyzw.astype(np.float64).copy()
        for k in range(1, len(q)):
            if np.dot(q[k - 1], q[k]) < 0:
                q[k] = -q[k]
        self.quat_xyzw = q
        self._tf = self.t_us.astype(np.float64)

    @property
    def start_us(self) -> int:
        return int(self.t_us[0])

    @property
    def end_us(self) -> int:
        return int(self.t_us[-1])

    def contains(self, t: int) -> bool:
        return self.start_us <= t <= self.end_us

    def at(self, t: int) -> tuple[np.ndarray, Rotation]:
        """Position lerp + quaternion nlerp between the two bracketing samples (~20 us)."""
        tc = float(min(max(t, self.start_us), self.end_us))
        k = int(np.searchsorted(self._tf, tc, side="right"))
        if k <= 0:
            return self.pos[0].copy(), Rotation.from_quat(self.quat_xyzw[0])
        if k >= len(self._tf):
            return self.pos[-1].copy(), Rotation.from_quat(self.quat_xyzw[-1])
        t0, t1 = self._tf[k - 1], self._tf[k]
        f = 0.0 if t1 <= t0 else (tc - t0) / (t1 - t0)
        p = self.pos[k - 1] * (1 - f) + self.pos[k] * f
        q = self.quat_xyzw[k - 1] * (1 - f) + self.quat_xyzw[k] * f
        q = q / max(np.linalg.norm(q), 1e-12)
        return p, Rotation.from_quat(q)

    def mat(self, t: int) -> np.ndarray:
        p, r = self.at(t)
        m = np.eye(4)
        m[:3, :3] = r.as_matrix()
        m[:3, 3] = p
        return m


class GroundModel:
    """Nearest-vertex height lookup on `mesh_ground.ply` (source frame, z-up)."""

    def __init__(self, ply_bytes: bytes):
        import trimesh

        mesh = trimesh.load(_io.BytesIO(ply_bytes), file_type="ply", force="mesh", process=False)
        self.vertices = np.asarray(mesh.vertices, dtype=np.float64)
        self._tree = cKDTree(self.vertices[:, :2])

    def z_at(self, x: float, y: float) -> float:
        _, i = self._tree.query([x, y], k=3)
        return float(np.median(self.vertices[np.atleast_1d(i), 2]))

    def z_at_many(self, xy: np.ndarray) -> np.ndarray:
        _, i = self._tree.query(xy, k=1)
        return self.vertices[i, 2]


def load_package_motion(zip_file: zipfile.ZipFile) -> dict[str, Any]:
    """Recorded rig trajectory, recorded object tracks, ground, rig box, from the usdz."""
    rig = json.loads(zip_file.read("rig_trajectories.json"))
    tracks = json.loads(zip_file.read("sequence_tracks.json"))
    (seq_key,) = list(tracks.keys())
    r0 = rig["rig_trajectories"][0]
    T = np.asarray(r0["T_rig_worlds"], dtype=np.float64)
    t_us = np.asarray(r0["T_rig_world_timestamps_us"], dtype=np.int64)
    ego = Traj(t_us, T[:, :3, 3].copy(), Rotation.from_matrix(T[:, :3, :3]).as_quat())
    td = tracks[seq_key]["tracks_data"]
    actors: dict[str, dict[str, Any]] = {}
    dims_rows = tracks[seq_key].get("cuboidtracks_data", {}).get("cuboids_dims", [])
    for index, (tid, cls, ts, poses) in enumerate(zip(td["tracks_id"], td["tracks_label_class"], td["tracks_timestamps_us"], td["tracks_poses"])):
        p = np.asarray(poses, dtype=np.float64)
        ts_arr = np.asarray(ts, dtype=np.int64)
        if len(ts_arr) < 1 or p.shape[1] < 7:
            continue
        dims = dims_rows[index] if index < len(dims_rows) else None
        actors[str(tid)] = {"class": cls, "traj": Traj(ts_arr, p[:, :3], p[:, 3:7]), "dims": dims}
    ground = GroundModel(zip_file.read("mesh_ground.ply"))
    rig_z = T[:, 2, 3]
    ground_z = ground.z_at_many(T[:, :2, 3])
    return {
        "ego": ego,
        "actors": actors,
        "ground": ground,
        "rig_bbox": r0["rig_bbox"],
        "rig_height_above_ground_m": float(np.median(rig_z - ground_z)),
        "time_range_us": (int(t_us[0]), int(t_us[-1])),
    }


def yaw_removed(r: Rotation) -> Rotation:
    """The rotation with its z-yaw factored out: R = Rz(yaw) * R_pr; returns R_pr."""
    m = r.as_matrix()
    yaw = math.atan2(m[1, 0], m[0, 0])
    return Rotation.from_euler("z", -yaw) * r


def rz(yaw: float) -> Rotation:
    return Rotation.from_euler("z", yaw)
