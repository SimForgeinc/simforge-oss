"""In-process NuRec renderer on NVIDIA's open 3DGRUT (3DGUT rasterizer; Apache-2.0).

Renders RGB + depth (+ alpha) for f-theta cameras at rolling-shutter poses from a `NuRecScene`,
with SimForge-controlled rigid actors posed per tick. No NVIDIA renderer code is vendored: the
3DGRUT checkout is an external dependency of this prototype.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import torch
from scipy.spatial.transform import Rotation

from ..prerequisites import HoodProfile, activate_threedgrut

DEPTH_FAR_M = 1000.0  # published depth for pixels with no splat coverage (Bevy far plane)
THREEDGRUT = activate_threedgrut()  # explicit root ($THREEDGRUT_ROOT / installed package); CapabilityError otherwise

from hydra import compose, initialize_config_dir  # noqa: E402
from omegaconf import OmegaConf  # noqa: E402

from threedgrut.datasets.protocols import Batch  # noqa: E402
from threedgrut.export.sh_rotation import _band_sample_dirs, sh_basis  # noqa: E402
from threedgut_tracer import Tracer  # noqa: E402

from ..providers.nurec import CameraModel, GaussianLayer, NuRecScene, fourier_basis  # noqa: E402
from .isp import apply_camera_isp  # noqa: E402

# NRE FLU → OpenGL (x right, y up, z back) for the sky cubemap
_FLU_TO_GL = np.array([[0, -1, 0], [0, 0, 1], [-1, 0, 0]], dtype=np.float32)


def load_tracer_conf(method: str = "3dgut"):
    with initialize_config_dir(config_dir=str(THREEDGRUT / "configs"), version_base=None):
        conf = compose(config_name=f"apps/ncore_{method}.yaml")
    OmegaConf.set_struct(conf, False)
    conf.render.enable_kernel_timings = True
    if method == "3dgut":
        # Measured on NuRec scene 0593b1f2 (fog, large near-camera Gaussians), front_wide vs NRE:
        #   global_z_order=True (3DGRUT default): 11.9 / 29.2 / 31.8 dB
        #   global_z_order=False (per-tile depth sort, NRE's behaviour): 26.5 / 30.8 / 32.6 dB
        # n_rolling_shutter_iterations 5 -> 1: identical pixels, 65 -> 58 ms per 4-camera tick.
        conf.render.splat.global_z_order = False
        conf.render.splat.n_rolling_shutter_iterations = 1
    return conf


@dataclass
class _Gaussians:
    """Duck-typed stand-in for threedgrut MixtureOfGaussians as seen by the tracer."""

    positions: torch.Tensor
    rotation: torch.Tensor
    scale: torch.Tensor
    density: torch.Tensor
    features: torch.Tensor  # [N,48]
    n_active_features: int = 3
    ray_feature_dim: int = 3

    @property
    def num_gaussians(self):
        return int(self.positions.shape[0])

    def get_rotation(self):
        return self.rotation

    def get_scale(self):
        return self.scale

    def get_density(self):
        return self.density

    def get_features(self):
        return self.features

    # 3DGRT's build_acc applies the model's activations itself; ours are pre-activated.
    @staticmethod
    def rotation_activation(x):
        return x

    @staticmethod
    def scale_activation(x):
        return x

    @staticmethod
    def density_activation(x):
        return x


def cubemap_sample(tex: torch.Tensor, d: torch.Tensor) -> torch.Tensor:
    """OpenGL cubemap lookup. tex [6,S,S,3] faces (+X,-X,+Y,-Y,+Z,-Z); d [...,3] in GL frame."""
    S = tex.shape[1]
    x, y, z = d[..., 0], d[..., 1], d[..., 2]
    ax, ay, az = x.abs(), y.abs(), z.abs()
    face = torch.zeros_like(x, dtype=torch.long)
    ma = torch.maximum(ax, torch.maximum(ay, az)).clamp_min(1e-9)
    sc = torch.zeros_like(x)
    tc = torch.zeros_like(x)
    # per OpenGL spec (major axis → face, sc, tc)
    mx = (ax >= ay) & (ax >= az)
    my = (~mx) & (ay >= az)
    mz = ~(mx | my)
    pos = x >= 0
    face[mx & pos] = 0
    sc[mx & pos], tc[mx & pos] = -z[mx & pos], -y[mx & pos]
    face[mx & ~pos] = 1
    sc[mx & ~pos], tc[mx & ~pos] = z[mx & ~pos], -y[mx & ~pos]
    pos = y >= 0
    face[my & pos] = 2
    sc[my & pos], tc[my & pos] = x[my & pos], z[my & pos]
    face[my & ~pos] = 3
    sc[my & ~pos], tc[my & ~pos] = x[my & ~pos], -z[my & ~pos]
    pos = z >= 0
    face[mz & pos] = 4
    sc[mz & pos], tc[mz & pos] = x[mz & pos], -y[mz & pos]
    face[mz & ~pos] = 5
    sc[mz & ~pos], tc[mz & ~pos] = -x[mz & ~pos], -y[mz & ~pos]
    s = 0.5 * (sc / ma + 1.0)
    t = 0.5 * (tc / ma + 1.0)
    # bilinear
    fx = (s * S - 0.5).clamp(0, S - 1)
    fy = (t * S - 0.5).clamp(0, S - 1)
    x0 = fx.floor().long().clamp(0, S - 1)
    y0 = fy.floor().long().clamp(0, S - 1)
    x1 = (x0 + 1).clamp(max=S - 1)
    y1 = (y0 + 1).clamp(max=S - 1)
    wx = (fx - x0.float())[..., None]
    wy = (fy - y0.float())[..., None]
    c00 = tex[face, y0, x0]
    c01 = tex[face, y0, x1]
    c10 = tex[face, y1, x0]
    c11 = tex[face, y1, x1]
    return (c00 * (1 - wx) + c01 * wx) * (1 - wy) + (c10 * (1 - wx) + c11 * wx) * wy


def cubemap_sample_fast(tex: torch.Tensor, d: torch.Tensor) -> torch.Tensor:
    """Same lookup as cubemap_sample, branch-free (gather-based), bilinear."""
    S = tex.shape[1]
    ad = d.abs()
    axis = ad.argmax(dim=-1)  # 0:x 1:y 2:z
    ma = ad.max(dim=-1).values.clamp_min(1e-9)
    x, y, z = d[..., 0], d[..., 1], d[..., 2]
    sgn = torch.gather(d, -1, axis[..., None])[..., 0] >= 0
    face = axis * 2 + (~sgn).long()
    # sc/tc per face (OpenGL): +x:(-z,-y) -x:(z,-y) +y:(x,z) -y:(x,-z) +z:(x,-y) -z:(-x,-y)
    sc = torch.where(axis == 0, torch.where(sgn, -z, z), torch.where(axis == 1, x, torch.where(sgn, x, -x)))
    tc = torch.where(axis == 1, torch.where(sgn, z, -z), -y)
    s = 0.5 * (sc / ma + 1.0)
    t = 0.5 * (tc / ma + 1.0)
    fx = (s * S - 0.5).clamp(0, S - 1)
    fy = (t * S - 0.5).clamp(0, S - 1)
    x0 = fx.floor().long()
    y0 = fy.floor().long()
    x1 = (x0 + 1).clamp(max=S - 1)
    y1 = (y0 + 1).clamp(max=S - 1)
    wx = (fx - x0.float())[..., None]
    wy = (fy - y0.float())[..., None]
    c00 = tex[face, y0, x0]
    c01 = tex[face, y0, x1]
    c10 = tex[face, y1, x0]
    c11 = tex[face, y1, x1]
    return (c00 * (1 - wx) + c01 * wx) * (1 - wy) + (c10 * (1 - wx) + c11 * wx) * wy


class SplatRenderer:
    """Holds one loaded scene on the GPU and renders camera frames from engine state."""

    def __init__(
        self,
        scene: NuRecScene,
        *,
        method: str = "3dgut",
        fourier_kind: str = "sincos_2pi",
        use_sky: bool = True,
        use_isp: bool = True,
        isp_index: str = 'unique_sensor_idx',
        hood: HoodProfile | str | Path | None = None,
        max_fov_deg: float | None = None,
        fast_path: bool = True,
    ):
        self.scene = scene
        self.fast_path = fast_path
        self._isp_cache: dict[tuple, tuple] = {}
        self._assemble_version = 0
        self._packed_n = -1
        self._packed_version = -1
        self.device = scene.device
        self.conf = load_tracer_conf(method)
        self.tracer = Tracer(self.conf)
        self.fourier_kind = fourier_kind
        self.use_sky = use_sky
        self.use_isp = use_isp
        self.isp_index = isp_index
        self.hood = hood if isinstance(hood, HoodProfile) else HoodProfile.parse(hood)
        self._hood_cache: dict[tuple, torch.Tensor | None] = {}
        self.max_fov_deg = max_fov_deg
        self._ray_cache: dict[str, tuple[torch.Tensor, torch.Tensor, dict]] = {}
        self._camera_models: dict[str, Any] = {}
        # static layers concatenated once (positions already in NRE frame)
        self.static_layers = [l for l in scene.layers.values() if l.cuboid_ids is None]
        self.rigid_layers = [l for l in scene.layers.values() if l.cuboid_ids is not None]
        self.W2N = torch.from_numpy(scene.world_to_nre.astype(np.float32)).to(self.device)
        self._build_buffers()

    # ---------------- preallocated gaussian buffers ----------------
    def _build_buffers(self) -> None:
        """Static layers are written once; rigid actors are packed into the tail per tick."""
        dev = self.device
        n_s = sum(l.n for l in self.static_layers)
        n_r = sum(l.n for l in self.rigid_layers)
        N = n_s + n_r
        self.n_static = n_s
        self.buf_pos = torch.empty(N, 3, device=dev)
        self.buf_rot = torch.empty(N, 4, device=dev)
        self.buf_scl = torch.empty(N, 3, device=dev)
        self.buf_dns = torch.empty(N, 1, device=dev)
        self.buf_feat = torch.empty(N, 48, device=dev)
        self.buf_packed = torch.zeros(N, 12, device=dev)  # [pos(3)|dns(1)|rot(4)|scl(3)|pad(1)] as the raster kernel expects
        self._flu_to_gl = torch.from_numpy(_FLU_TO_GL).to(dev)
        o = 0
        self._static_ranges: list[tuple[GaussianLayer, int, int]] = []
        for l in self.static_layers:
            self.buf_pos[o : o + l.n] = l.positions
            self.buf_rot[o : o + l.n] = l.rotations
            self.buf_scl[o : o + l.n] = l.scales
            self.buf_dns[o : o + l.n] = l.densities
            self.buf_feat[o : o + l.n, 3:] = l.specular
            self.buf_feat[o : o + l.n, :3] = l.albedo[:, 0, :]
            self._static_ranges.append((l, o, o + l.n))
            o += l.n
        # rigid layers: sort gaussians by track so each track is a contiguous slice
        self._rigid: list[dict] = []
        for l in self.rigid_layers:
            order = torch.argsort(l.cuboid_ids)
            cid = l.cuboid_ids[order]
            T = len(l.track_ids)
            counts = torch.bincount(cid, minlength=T)
            starts = torch.cumsum(counts, 0) - counts
            self._rigid.append(
                {
                    "layer": l,
                    "pos": l.positions[order].contiguous(),
                    "rot": l.rotations[order].contiguous(),
                    "scl": l.scales[order].contiguous(),
                    "dns": l.densities[order].contiguous(),
                    "alb": l.albedo[order].contiguous(),
                    "spec": l.specular[order].reshape(-1, 15, 3).contiguous(),
                    "cid": cid,
                    "starts": starts.tolist(),
                    "counts": counts.tolist(),
                    "slot": {tid: i for i, tid in enumerate(l.track_ids)},
                    "ranges": l.track_time_ranges,
                }
            )
        self._sh_dirs = {l: _band_dirs(2 * l + 1, dev) for l in (1, 2, 3)}
        self._sh_basis = {l: sh_basis(l, self._sh_dirs[l])[:, l * l : l * l + 2 * l + 1] for l in (1, 2, 3)}
        self._last_static_t: int | None = None

    def _band_matrices(self, R: torch.Tensor) -> dict[int, torch.Tensor]:
        """Batched SH band rotation matrices for R [T,3,3] (same sample-and-solve as 3DGRUT's sh_rotation)."""
        out = {}
        for l in (1, 2, 3):
            dirs = self._sh_dirs[l]  # [n,3]
            n = 2 * l + 1
            rot_dirs = torch.einsum("nj,tjk->tnk", dirs, R)  # d @ R per track
            basis_rot = sh_basis(l, rot_dirs.reshape(-1, 3))[:, l * l : l * l + n].reshape(R.shape[0], n, n)
            out[l] = torch.linalg.solve(self._sh_basis[l][None].expand(R.shape[0], n, n), basis_rot)  # [T,n,n]
        return out

    # ---------------- cameras ----------------
    def _camera(self, cam: CameraModel):
        """Build ncore camera model + cached per-pixel camera-space rays."""
        if cam.logical_id in self._ray_cache:
            return self._ray_cache[cam.logical_id]
        import ncore.data as nd
        import ncore.sensors as ns

        p = cam.params
        params = nd.FThetaCameraModelParameters(
            resolution=np.asarray(p["resolution"], dtype=np.uint64),
            shutter_type=nd.ShutterType[p["shutter_type"]],
            principal_point=np.asarray(p["principal_point"], dtype=np.float32),
            reference_poly=nd.FThetaCameraModelParameters.PolynomialType[p["reference_poly"]],
            pixeldist_to_angle_poly=np.asarray(p["pixeldist_to_angle_poly"], dtype=np.float32),
            angle_to_pixeldist_poly=np.asarray(p["angle_to_pixeldist_poly"], dtype=np.float32),
            max_angle=float(p["max_angle"]),
            linear_cde=np.asarray(p["linear_cde"], dtype=np.float32),
        )
        model = ns.FThetaCameraModel(params, device=self.device)
        if self.max_fov_deg is not None:
            model.max_angle = min(math.radians(self.max_fov_deg) / 2, model.max_angle)
        w, h = cam.resolution_wh
        px, py = np.meshgrid(np.arange(w, dtype=np.int16), np.arange(h, dtype=np.int16))
        pixels = np.stack([px.flatten(), py.flatten()], axis=1)
        rays = model.pixels_to_camera_rays(pixels).reshape(h, w, 3).to(torch.float32).contiguous()
        intr = {
            "resolution": np.asarray(p["resolution"], dtype=np.uint64),
            "shutter_type": p["shutter_type"],
            "principal_point": np.asarray(p["principal_point"], dtype=np.float32),
            "reference_poly": p["reference_poly"],
            "pixeldist_to_angle_poly": np.asarray(p["pixeldist_to_angle_poly"], dtype=np.float32),
            "angle_to_pixeldist_poly": np.asarray(p["angle_to_pixeldist_poly"], dtype=np.float32),
            "max_angle": float(model.max_angle),
            "linear_cde": np.asarray(p["linear_cde"], dtype=np.float32),
        }
        entry = (rays, torch.zeros_like(rays), intr)
        self._ray_cache[cam.logical_id] = entry
        self._camera_models[cam.logical_id] = model
        return entry

    # ---------------- gaussian assembly ----------------
    def _albedo_at(self, layer: GaussianLayer, t01: torch.Tensor | float) -> torch.Tensor:
        """Evaluate Fourier albedo. t01 scalar (holistic) or [N] per-gaussian (individual)."""
        F = layer.fourier_dim
        if F == 1:
            return layer.albedo[:, 0, :]
        if isinstance(t01, torch.Tensor) and t01.ndim == 1:
            # per-gaussian time: build basis [N,F]
            ks = torch.arange(F, device=self.device, dtype=torch.float32)
            if self.fourier_kind == "cos_pi_k":
                basis = torch.cos(math.pi * ks[None, :] * t01[:, None])
            elif self.fourier_kind in ("sincos_2pi", "sincos_pi"):
                mult = 2 * math.pi if self.fourier_kind == "sincos_2pi" else math.pi
                f = ((ks + 1) // 2).floor()
                ang = mult * f[None, :] * t01[:, None]
                basis = torch.where((ks % 2 == 1)[None, :], torch.sin(ang), torch.cos(ang))
                basis[:, 0] = 1.0
            else:  # dc
                basis = torch.zeros(t01.shape[0], F, device=self.device)
                basis[:, 0] = 1.0
            return torch.einsum("nf,nfc->nc", basis, layer.albedo)
        b = fourier_basis(F, float(t01), self.fourier_kind, self.device)
        return torch.einsum("f,nfc->nc", b, layer.albedo)

    def assemble(self, t_us: int, actor_poses_world: dict[str, np.ndarray] | None, track_time_offsets_us: dict[str, int] | None = None) -> _Gaussians:
        """Static layers (time-varying albedo) + posed rigid actors for time t, into the shared buffers.

        actor_poses_world: track_id → 4x4 pose of the cuboid frame in the world (sim) frame.
        Rigid actors without a pose are omitted (== removed from the scene).
        """
        if t_us != self._last_static_t:
            for layer, a, b in self._static_ranges:
                if layer.fourier_dim > 1:
                    t01 = min(max((t_us - layer.time_min_us) / max(1, (layer.time_max_us - layer.time_min_us)), 0.0), 1.0)
                    self.buf_feat[a:b, :3] = self._albedo_at(layer, t01)
            self._last_static_t = t_us
        o = self.n_static
        if actor_poses_world:
            for rg in self._rigid:
                active = [(rg["slot"][tid], T) for tid, T in actor_poses_world.items() if tid in rg["slot"] and rg["counts"][rg["slot"][tid]] > 0]
                if not active:
                    continue
                slots = [s for s, _ in active]
                Tw = np.stack([np.asarray(T, dtype=np.float32) for _, T in active])  # [K,4,4]
                Tn = torch.from_numpy(Tw).to(self.device)
                Tn = self.W2N[None] @ Tn
                R = Tn[:, :3, :3].contiguous()
                tr = Tn[:, :3, 3].contiguous()
                q_pose = _mat_to_quat_wxyz(R)  # [K,4]
                # gather gaussian indices of the active tracks (contiguous slices)
                idx = torch.cat([torch.arange(rg["starts"][s], rg["starts"][s] + rg["counts"][s], device=self.device) for s in slots])
                k_of = torch.cat([torch.full((rg["counts"][s],), k, device=self.device, dtype=torch.long) for k, s in enumerate(slots)])
                n = idx.shape[0]
                p = torch.einsum("nij,nj->ni", R[k_of], rg["pos"][idx]) + tr[k_of]
                q = _quat_mul(q_pose[k_of], rg["rot"][idx])
                # per-gaussian time over each track's own range
                if rg["ranges"] is not None:
                    rngs = rg["ranges"][torch.tensor(slots, device=self.device)]  # [K,2]
                    if track_time_offsets_us:
                        times = torch.tensor([t_us + track_time_offsets_us.get(rg["layer"].track_ids[s], 0) for s in slots], device=self.device, dtype=torch.int64)
                        t01 = ((times - rngs[:, 0]).float() / (rngs[:, 1] - rngs[:, 0]).clamp_min(1).float()).clamp(0, 1)[k_of]
                    else:
                        t01 = ((t_us - rngs[:, 0].float()) / (rngs[:, 1] - rngs[:, 0]).clamp_min(1).float()).clamp(0, 1)[k_of]
                else:
                    t01 = torch.zeros(n, device=self.device)
                alb = self._albedo_at(GaussianLayer(rg["layer"].name, p, q, rg["scl"][idx], rg["dns"][idx], rg["alb"][idx], rg["spec"][idx].reshape(n, 45)), t01)
                # rotate SH bands per track
                D = self._band_matrices(R)
                spec = rg["spec"][idx]  # [n,15,3]
                spec_out = torch.empty_like(spec)
                off = 0
                for l in (1, 2, 3):
                    w = 2 * l + 1
                    spec_out[:, off : off + w] = torch.einsum("nij,njc->nic", D[l][k_of], spec[:, off : off + w])
                    off += w
                self.buf_pos[o : o + n] = p
                self.buf_rot[o : o + n] = q
                self.buf_scl[o : o + n] = rg["scl"][idx]
                self.buf_dns[o : o + n] = rg["dns"][idx]
                self.buf_feat[o : o + n, :3] = alb
                self.buf_feat[o : o + n, 3:] = spec_out.reshape(n, 45)
                o += n
        self._assemble_version += 1
        return _Gaussians(self.buf_pos[:o], self.buf_rot[:o], self.buf_scl[:o], self.buf_dns[:o], self.buf_feat[:o])

    # ---------------- rendering ----------------
    @torch.no_grad()
    def render_camera(
        self,
        gaussians: _Gaussians,
        cam: CameraModel,
        T_world_rig_start: np.ndarray,
        T_world_rig_end: np.ndarray,
        composite=None,
    ) -> dict[str, torch.Tensor]:
        """Render one camera. `composite(raw_rgb, alpha, depth, C2W_end, rays_dir) -> (raw_rgb, depth)`
        runs on the raw radiance (after sky, before PPISP + hood) so injected actors receive the
        same ISP as the reconstruction."""
        rays_dir, rays_ori, intr = self._camera(cam)
        # camera→world (sim frame) → NRE frame
        C2W0 = self.scene.world_to_nre @ T_world_rig_start @ cam.T_rig_from_cam
        C2W1 = self.scene.world_to_nre @ T_world_rig_end @ cam.T_rig_from_cam
        batch = Batch(
            rays_ori=rays_ori[None],
            rays_dir=rays_dir[None],
            T_to_world=torch.from_numpy(C2W0.astype(np.float32)).to(self.device)[None],
            T_to_world_end=torch.from_numpy(C2W1.astype(np.float32)).to(self.device)[None],
            intrinsics_FThetaCameraModelParameters=intr,
        )
        if self.fast_path:
            out = self._trace_packed(gaussians, batch)
        else:
            out = self.tracer.render(gaussians, batch)
        rgb = out["pred_features"][0]  # [H,W,3]
        # pred_dist is the transmittance-weighted distance sum (not normalised): a pixel with alpha
        # 0.1 at 60 m reports 6 m. Normalise to the expected hit distance; pixels the splat does
        # not cover (sky, alpha < 0.05) are "far" (DEPTH_FAR_M) like the Bevy service's background.
        alpha = out["pred_opacity"][0]  # [H,W,1]
        depth = torch.where(alpha >= 0.05, out["pred_dist"][0] / alpha.clamp_min(0.05), torch.full_like(alpha, DEPTH_FAR_M))
        if self.use_sky and self.scene.sky is not None:
            # world-space ray dirs at the end pose (sky is at infinity; shutter irrelevant)
            R = torch.from_numpy(C2W1[:3, :3].astype(np.float32)).to(self.device)
            d_gl = rays_dir @ (self._flu_to_gl @ R).T
            sky = cubemap_sample_fast(self.scene.sky, d_gl) if self.fast_path else cubemap_sample(self.scene.sky, d_gl)
            rgb = rgb + sky * (1.0 - alpha)
        if composite is not None:
            rgb, depth = composite(rgb, alpha, depth, C2W1, rays_dir)
        raw_rgb = rgb
        if self.use_isp and self.scene.ppisp:
            ci = self.scene.sensor_idx.get(cam.logical_id, -1) if self.isp_index == 'unique_sensor_idx' else (self.scene.camera_order.index(cam.logical_id) if cam.logical_id in self.scene.camera_order else -1)
            if ci >= 0:
                if self.fast_path:
                    rgb = self._isp_fast(rgb, ci, cam.logical_id)
                else:
                    rgb = apply_camera_isp(
                        rgb,
                        self.scene.ppisp.get("vignetting_params", [None])[ci] if "vignetting_params" in self.scene.ppisp else None,
                        self.scene.ppisp.get("crf_params", [None])[ci] if "crf_params" in self.scene.ppisp else None,
                    )
        rgb = rgb.clamp(0.0, 1.0)
        hood = self._hood(cam.logical_id, rgb.shape[0], rgb.shape[1])
        if hood is not None:
            rgb = rgb * (1.0 - hood[..., 3:4]) + hood[..., :3] * hood[..., 3:4]
            # the ego body is the nearest thing in the frame: depth 0 under the hood so no actor
            # behind it counts as visible
            depth = torch.where(hood[..., 3:4] > 0.5, torch.zeros_like(depth), depth)
        return {"rgb": rgb, "raw_rgb": raw_rgb, "alpha": alpha, "depth": depth, "frame_time_ms": out["frame_time_ms"]}

    # ---------------- fast path ----------------
    def _trace_packed(self, g: _Gaussians, batch: Batch) -> dict[str, torch.Tensor]:
        """Call the 3DGUT raster wrapper directly with the particle buffer packed once per tick
        (Tracer.render re-packs [pos|dns|rot|scl|0] and re-contiguates features on every call)."""
        n = g.num_gaussians
        if self._packed_n != n or self._packed_version != self._assemble_version:
            self.buf_packed[:n, 0:3] = g.positions
            self.buf_packed[:n, 3:4] = g.density
            self.buf_packed[:n, 4:8] = g.rotation
            self.buf_packed[:n, 8:11] = g.scale
            self._packed_n, self._packed_version = n, self._assemble_version
        sensor, poses = Tracer._Tracer__create_camera_parameters(batch)
        ray_ori = batch.rays_ori
        ray_time = torch.zeros((1, ray_ori.shape[1], ray_ori.shape[2], 1), device=self.device, dtype=torch.long)
        feats_dns, hit_dist, hit_count, _vis = self.tracer.tracer_wrapper.trace(
            0,
            g.n_active_features,
            self.buf_packed[:n],
            g.features,
            ray_ori,
            batch.rays_dir,
            ray_time,
            sensor,
            poses.timestamps_us[0],
            poses.timestamps_us[1],
            poses.T_world_sensors[0],
            poses.T_world_sensors[1],
        )
        timings = self.tracer.tracer_wrapper.collect_times()
        return {
            "pred_features": feats_dns[..., :3].float().unsqueeze(0),
            "pred_opacity": feats_dns[..., 3:].float().unsqueeze(0),
            "pred_dist": hit_dist.unsqueeze(0),
            "hits_count": hit_count.unsqueeze(0),
            "frame_time_ms": timings.get("forward_render", 0.0),
        }

    def _isp_fast(self, rgb: torch.Tensor, ci: int, camera_id: str) -> torch.Tensor:
        """Vignetting map (cached per camera/resolution) + per-channel CRF via 4096-entry LUT."""
        H, W, _ = rgb.shape
        key = (ci, H, W)
        if key not in self._isp_cache:
            from .isp import crf_channel

            vig = self.scene.ppisp.get("vignetting_params")
            crf = self.scene.ppisp.get("crf_params")
            vmap = None
            if vig is not None:
                ys = torch.arange(H, device=self.device, dtype=torch.float32) / max(H - 1, 1)
                xs = torch.arange(W, device=self.device, dtype=torch.float32) / max(W - 1, 1)
                yy, xx = torch.meshgrid(ys, xs, indexing="ij")
                vmap = torch.empty(H, W, 3, device=self.device)
                for c in range(3):
                    cx, cy, a1, a2, a3 = vig[ci][c].tolist()
                    r2 = (xx - cx) ** 2 + (yy - cy) ** 2
                    vmap[..., c] = (1.0 + a1 * r2 + a2 * r2**2 + a3 * r2**3).clamp(0.0, 1.0)
            lut = None
            if crf is not None:
                xs = torch.linspace(0, 1, 4096, device=self.device)
                lut = torch.stack([crf_channel(xs, crf[ci][c]) for c in range(3)], dim=1)  # [4096,3]
            self._isp_cache[key] = (vmap, lut)
        vmap, lut = self._isp_cache[key]
        if vmap is not None:
            rgb = rgb * vmap
        if lut is not None:
            idx = (rgb.clamp(0, 1) * 4095 + 0.5).long()
            rgb = torch.stack([lut[idx[..., c], c] for c in range(3)], dim=-1)
        return rgb

    def _hood(self, camera_id: str, h: int, w: int) -> torch.Tensor | None:
        """Ego-hood RGBA overlay of the selected profile (same asset AlpaSim's renderer composites),
        resized bilinear; None only for the explicit `none` profile."""
        key = (camera_id, h, w)
        if key not in self._hood_cache:
            p = self.hood.overlay(camera_id)
            if p is None:
                self._hood_cache[key] = None
            else:
                from PIL import Image

                im = np.asarray(Image.open(p).convert("RGBA"), dtype=np.float32) / 255.0
                t = torch.from_numpy(im).permute(2, 0, 1)[None]
                t = torch.nn.functional.interpolate(t, size=(h, w), mode="bilinear", align_corners=False)
                self._hood_cache[key] = t[0].permute(1, 2, 0).contiguous().to(self.device)
        return self._hood_cache[key]

    def render_rig(
        self,
        t_end_us: int,
        T_world_rig_start: np.ndarray,
        T_world_rig_end: np.ndarray,
        cameras: list[str],
        actor_poses_world: dict[str, np.ndarray] | None,
    ) -> dict[str, dict[str, torch.Tensor]]:
        g = self.assemble(t_end_us, actor_poses_world)
        return {c: self.render_camera(g, self.scene.cameras[c], T_world_rig_start, T_world_rig_end) for c in cameras}


def _band_dirs(n: int, device) -> torch.Tensor:
    return _band_sample_dirs(n, device, torch.float32)


def _mat_to_quat_wxyz(R: torch.Tensor) -> torch.Tensor:
    """Batched rotation matrix → unit quaternion (w,x,y,z), R [K,3,3] (K small; scipy on CPU is robust)."""
    q = Rotation.from_matrix(R.detach().cpu().numpy().astype(np.float64)).as_quat()  # xyzw
    q = np.asarray(q, dtype=np.float32).reshape(-1, 4)[:, [3, 0, 1, 2]]
    return torch.from_numpy(np.ascontiguousarray(q)).to(R.device)


def _quat_mul(a: torch.Tensor, b: torch.Tensor) -> torch.Tensor:
    """Hamilton product, wxyz, broadcasting."""
    aw, ax, ay, az = a.unbind(-1)
    bw, bx, by, bz = b.unbind(-1)
    return torch.stack(
        [
            aw * bw - ax * bx - ay * by - az * bz,
            aw * bx + ax * bw + ay * bz - az * by,
            aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw,
        ],
        dim=-1,
    )
