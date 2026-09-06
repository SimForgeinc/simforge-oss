"""Injected actors: catalog meshes rasterized under the scene's own f-theta lens.

Why not Bevy: B3 measured a 4-camera Bevy actor pass at policy scale at >= 150 ms,
the whole tick budget; and its pinhole cannot reproduce a 120 deg f-theta image
without a wasteful oversampled warp (B5). Here the mesh vertices go through the
*same* ncore camera model that generates the background rays (angle -> pixel
polynomial), kaolin (Apache-2.0) rasterizes in image space, and the result is a
raw-radiance layer with ray-distance depth that composites against the splat
depth in one comparison per pixel.

Lighting is expressed in the reconstruction's raw radiance units: the sun and
ambient terms come from the scene's own sky cubemap (peak direction = sun,
hemisphere mean = ambient), so the actor then passes through the same PPISP as
the background. Shadows: `ground_shadow` darkens background pixels whose ground
point is occluded from the sun by the actor's mesh (sun-space shadow map).
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
import trimesh
from kaolin.render.mesh import rasterize


def _convex_hull(pts: np.ndarray) -> np.ndarray:
    """Andrew monotone chain; pts [N,2] -> hull vertices CCW."""
    pts = np.unique(pts, axis=0)
    if pts.shape[0] < 3:
        return pts
    order = np.lexsort((pts[:, 1], pts[:, 0]))
    pts = pts[order]

    def half(seq):
        out = []
        for p in seq:
            while len(out) >= 2 and np.cross(out[-1] - out[-2], p - out[-2]) <= 0:
                out.pop()
            out.append(p)
        return out

    lower = half(pts)
    upper = half(pts[::-1])
    return np.asarray(lower[:-1] + upper[:-1])


@dataclass
class MeshAsset:
    """Actor-local mesh in the NuRec actor frame (x forward, y left, z up), metres, ground at z=0."""

    catalog_id: str
    vertices: torch.Tensor  # [V,3] float32 on device
    faces: torch.Tensor  # [F,3] int64
    colors: torch.Tensor  # [V,3] float32 linear albedo 0..1
    normals: torch.Tensor  # [V,3]
    body_mask: torch.Tensor  # [V] bool: vertices the state colour may tint
    length_m: float
    width_m: float
    height_m: float


def _srgb_to_linear(c: torch.Tensor) -> torch.Tensor:
    return torch.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


class AssetLibrary:
    """Loads catalog GLBs once per catalog id and keeps them on the device."""

    def __init__(self, roots: list[Path], device: torch.device):
        self.roots = [Path(r) for r in roots]
        self.device = device
        self._cache: dict[str, MeshAsset] = {}
        self._index: dict[str, Path] = {}
        for root in self.roots:
            for glb in sorted(root.rglob("*.glb")):
                previous = self._index.get(glb.stem)
                if previous is not None and previous.resolve() != glb.resolve():
                    raise ValueError(f"ambiguous catalog stem {glb.stem!r}: {previous} and {glb}")
                self._index[glb.stem] = glb

    def resolve(self, catalog_id: str) -> Path | None:
        # Gallery filenames retain dots; CARLA filenames encode those separators as underscores.
        # Neither convention permits a family ID to choose an arbitrary concrete model.
        matches = {self._index[key] for key in (catalog_id, catalog_id.replace(".", "_")) if key in self._index}
        if len(matches) > 1:
            raise ValueError(f"ambiguous exact catalog id {catalog_id!r}: {sorted(map(str, matches))}")
        return next(iter(matches), None)

    def get(self, catalog_id: str) -> MeshAsset:
        if catalog_id in self._cache:
            return self._cache[catalog_id]
        path = self.resolve(catalog_id)
        if path is None:
            raise KeyError(f"catalog id {catalog_id!r} has no GLB under {[str(r) for r in self.roots]}")
        asset = load_glb(path, catalog_id, self.device)
        self._cache[catalog_id] = asset
        return asset


def load_glb(path: Path, catalog_id: str, device: torch.device) -> MeshAsset:
    """Concatenate the GLB's primitives in scene space; the tintable paint is the `body_paint`
    material slot (catalog CONVENTIONS.md), everything else keeps its baked colour."""
    scene = trimesh.load(str(path), force="scene")
    verts, faces, cols, body_parts, base = [], [], [], [], 0
    for node in scene.graph.nodes_geometry:
        T, gname = scene.graph[node]
        g = scene.geometry[gname]
        gv = np.asarray(trimesh.transform_points(g.vertices, T), dtype=np.float32)
        mat = getattr(g.visual, "material", None)
        visual = g.visual.to_color() if g.visual.kind == "texture" else g.visual
        source_colors = np.asarray(visual.vertex_colors)
        if source_colors.ndim == 1:
            source_colors = np.broadcast_to(source_colors, (len(gv), source_colors.size))
        if source_colors.ndim != 2 or source_colors.shape[0] != len(gv) or source_colors.shape[1] not in (3, 4):
            raise ValueError(f"unsupported_mesh_colors: {catalog_id!r} has invalid vertex colors")
        gc = np.array(source_colors[:, :3], dtype=np.float32, copy=True)
        if not np.isfinite(gc).all() or (gc < 0).any() or (gc > 255).any():
            raise ValueError(f"unsupported_mesh_colors: {catalog_id!r} has nonfinite or out-of-range colors")
        gc *= 1.0 / 255.0
        # glTF factors and COLOR_0 are linear; only image texels are sRGB.
        if g.visual.kind == "texture" and getattr(mat, "baseColorTexture", None) is not None:
            gc = _srgb_to_linear(torch.from_numpy(gc)).numpy()
            factor = getattr(mat, "baseColorFactor", None)
            if factor is not None:
                gc *= np.asarray(factor[:3], dtype=np.float32) / 255.0
        is_paint = str(getattr(mat, "name", "") or "").lower() == "body_paint"
        verts.append(gv)
        faces.append(np.asarray(g.faces, dtype=np.int64) + base)
        cols.append(gc)
        body_parts.append(np.full(len(gv), is_paint, dtype=bool))
        base += len(gv)
    v = np.concatenate(verts)
    f = np.concatenate(faces)
    vc = np.concatenate(cols)
    body = np.concatenate(body_parts)
    if not body.any():  # non-catalog GLB: fall back to the mid-luminance heuristic
        lum = vc.mean(axis=1)
        body = (lum > 0.08) & (lum < 0.9)
    # GLB actor frame (x forward, y up, z right) -> NuRec actor frame (x forward, y left, z up)
    v_n = np.stack([v[:, 0], -v[:, 2], v[:, 1]], axis=1)
    v_n[:, 2] -= v_n[:, 2].min()  # wheels on the ground plane
    mesh_n = trimesh.Trimesh(v_n, f, process=False)
    normals = np.asarray(mesh_n.vertex_normals, dtype=np.float32)
    ext = v_n.max(axis=0) - v_n.min(axis=0)
    dev = device
    return MeshAsset(
        catalog_id=catalog_id,
        vertices=torch.from_numpy(v_n).to(dev),
        faces=torch.from_numpy(f).to(dev),
        colors=torch.from_numpy(vc).to(dev),
        normals=torch.from_numpy(normals).to(dev),
        body_mask=torch.from_numpy(body).to(dev),
        length_m=float(ext[0]),
        width_m=float(ext[1]),
        height_m=float(ext[2]),
    )


@dataclass
class SunState:
    direction_world: np.ndarray  # unit vector towards the sun in the provider world (z-up)
    radiance: float  # raw radiance units of the reconstruction
    ambient: np.ndarray  # [3] hemisphere mean radiance
    source: str


def sun_from_cubemap(sky: torch.Tensor, flu_to_gl: np.ndarray) -> SunState:
    """Sun direction = luminance-weighted peak of the sky cubemap, expressed in the world (z-up) frame.

    Faces are OpenGL order (+X,-X,+Y,-Y,+Z,-Z) in the GL frame; `flu_to_gl` maps world FLU -> GL
    so its transpose maps a GL direction back to the world.
    """
    tex = sky.float()  # [6,S,S,3]
    S = tex.shape[1]
    lum = tex[..., 0] * 0.2126 + tex[..., 1] * 0.7152 + tex[..., 2] * 0.0722  # [6,S,S]
    # direction of every texel
    a = (torch.arange(S, device=tex.device, dtype=torch.float32) + 0.5) / S * 2 - 1
    u, v = torch.meshgrid(a, a, indexing="xy")  # u: column, v: row
    one = torch.ones_like(u)
    dirs = torch.stack([
        torch.stack([one, -v, -u], -1), torch.stack([-one, -v, u], -1),
        torch.stack([u, one, v], -1), torch.stack([u, -one, -v], -1),
        torch.stack([u, -v, one], -1), torch.stack([-u, -v, -one], -1),
    ])  # [6,S,S,3] GL frame
    dirs = F.normalize(dirs, dim=-1)
    # peak: top 0.1% texels by luminance, weighted mean direction
    k = max(1, int(lum.numel() * 0.001))
    top = torch.topk(lum.flatten(), k)
    d = (dirs.reshape(-1, 3)[top.indices] * top.values[:, None]).sum(0)
    d_gl = F.normalize(d, dim=0).cpu().numpy().astype(np.float64)
    d_world = flu_to_gl.T @ d_gl
    peak = float(top.values.mean())
    mean = float(lum.mean())
    up_hemi = tex.reshape(-1, 3)[dirs.reshape(-1, 3)[:, 1] > 0]
    ambient = up_hemi.mean(0).cpu().numpy().astype(np.float64) if up_hemi.numel() else np.full(3, mean)
    source = "envmap-peak"
    if peak < 3.0 * mean or d_world[2] < 0.05:
        # overcast / night: no usable peak; light from straight up, ambient only
        d_world = np.array([0.0, 0.0, 1.0])
        source = "envmap-no-peak(ambient-only)"
        peak = 0.0
    return SunState(direction_world=d_world / np.linalg.norm(d_world), radiance=peak, ambient=ambient, source=source)


class ActorPass:
    """Rasterizes posed catalog meshes under an f-theta camera; returns raw radiance, alpha, depth."""

    def __init__(self, device: torch.device):
        self.device = device

    @torch.no_grad()
    def render(
        self,
        camera_model,  # ncore FThetaCameraModel (device-resident)
        width: int,
        height: int,
        W2C: np.ndarray,  # 4x4 world -> OpenCV camera at shutter end (NuRec world frame)
        actors: list[tuple[MeshAsset, np.ndarray, np.ndarray | None]],  # (asset, T_world_actor 4x4, tint rgb or None)
        sun: SunState,
    ) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor] | None:
        if not actors:
            return None
        verts_cam, faces_all, feats, base = [], [], [], 0
        for asset, T, tint in actors:
            Tt = torch.from_numpy(np.asarray(T, dtype=np.float32)).to(self.device)
            Wc = torch.from_numpy(np.asarray(W2C, dtype=np.float32)).to(self.device)
            v_w = asset.vertices @ Tt[:3, :3].T + Tt[:3, 3]
            n_w = F.normalize(asset.normals @ Tt[:3, :3].T, dim=-1)
            v_c = v_w @ Wc[:3, :3].T + Wc[:3, 3]
            col = asset.colors
            if tint is not None:
                t = torch.from_numpy(np.asarray(tint, dtype=np.float32)).to(self.device)
                col = torch.where(asset.body_mask[:, None], _srgb_to_linear(t)[None].expand_as(col), col)
            sun_d = torch.from_numpy(sun.direction_world.astype(np.float32)).to(self.device)
            ndl = (n_w @ sun_d).clamp_min(0.0)
            amb = torch.from_numpy(sun.ambient.astype(np.float32)).to(self.device)
            # Lambert in raw radiance units; hemisphere ambient weighted by the normal's up component
            up = (0.5 + 0.5 * n_w[:, 2:3]).clamp(0, 1)
            rad = col * (amb[None] * up + sun.radiance * ndl[:, None] / math.pi)
            verts_cam.append(v_c)
            faces_all.append(asset.faces + base)
            feats.append(rad)
            base += v_c.shape[0]
        v_c = torch.cat(verts_cam)
        faces = torch.cat(faces_all)
        rad = torch.cat(feats)
        dist = v_c.norm(dim=-1)
        # f-theta projection of every vertex through the same model that made the background rays
        rays = v_c / dist.clamp_min(1e-6)[:, None]
        proj = camera_model.camera_rays_to_image_points(rays)
        ip, valid = proj.image_points.to(torch.float32), proj.valid_flag.bool()
        behind = v_c[:, 2] <= 0.05
        valid = valid & ~behind
        # kaolin NDC: x=-1 left, y=-1 bottom; ncore image points: pixel (col,row) centres at +0.5
        ndc = torch.stack([ip[:, 0] / width * 2 - 1, 1 - ip[:, 1] / height * 2], dim=-1)
        ndc = torch.where(valid[:, None], ndc, torch.full_like(ndc, 9.0))
        fv_img = ndc[faces][None]  # [1,F,3,2]
        fv_z = (-dist)[faces][None]  # nearest = largest
        fv_feat = torch.cat([rad, dist[:, None]], dim=-1)[faces][None]  # [1,F,3,4]
        face_ok = valid[faces].all(dim=-1)[None]
        if not bool(face_ok.any()):
            return None  # everything behind the camera / outside the lens
        img, fid = rasterize(height, width, fv_z, fv_img, fv_feat, valid_faces=face_ok)
        hit = fid[0] >= 0
        return img[0, ..., :3], hit.to(torch.float32), img[0, ..., 3]

    @torch.no_grad()
    def render_ids(self, camera_model, width: int, height: int, W2C: np.ndarray,
                   proxies: list[tuple[MeshAsset, np.ndarray, int]]) -> tuple[torch.Tensor, torch.Tensor] | None:
        """Nearest-proxy instance label per pixel and its ray distance; one rasterize call for all."""
        if not proxies:
            return None
        verts, faces, labels, base = [], [], [], 0
        Wc = torch.from_numpy(np.asarray(W2C, dtype=np.float32)).to(self.device)
        for asset, T, inst in proxies:
            Tt = torch.from_numpy(np.asarray(T, dtype=np.float32)).to(self.device)
            v_c = (asset.vertices @ Tt[:3, :3].T + Tt[:3, 3]) @ Wc[:3, :3].T + Wc[:3, 3]
            verts.append(v_c)
            faces.append(asset.faces + base)
            labels.append(torch.full((v_c.shape[0], 1), float(inst), device=self.device))
            base += v_c.shape[0]
        v_c = torch.cat(verts)
        fcs = torch.cat(faces)
        lab = torch.cat(labels)
        dist = v_c.norm(dim=-1)
        rays = v_c / dist.clamp_min(1e-6)[:, None]
        proj = camera_model.camera_rays_to_image_points(rays)
        ip, valid = proj.image_points.to(torch.float32), proj.valid_flag.bool()
        valid = valid & (v_c[:, 2] > 0.05)
        ndc = torch.stack([ip[:, 0] / width * 2 - 1, 1 - ip[:, 1] / height * 2], dim=-1)
        ndc = torch.where(valid[:, None], ndc, torch.full_like(ndc, 9.0))
        face_ok = valid[fcs].all(dim=-1)[None]
        if not bool(face_ok.any()):
            return None
        feat = torch.cat([lab, dist[:, None]], dim=-1)[fcs][None]
        img, fid = rasterize(height, width, (-dist)[fcs][None], ndc[fcs][None], feat, valid_faces=face_ok)
        hit = fid[0] >= 0
        label = torch.where(hit, img[0, ..., 0].round().to(torch.int32), torch.zeros((height, width), dtype=torch.int32, device=self.device))
        # per-proxy projected extent independent of the other proxies: convex hull of its
        # projected (valid) vertices -> area in px and bbox; occlusion-free reference for the visible fraction
        extents: dict[int, tuple[float, list[int]]] = {}
        ip_c = ip.cpu().numpy(); valid_c = valid.cpu().numpy()
        base = 0
        for asset, T, inst in proxies:
            n = asset.vertices.shape[0]
            pts = ip_c[base:base + n][valid_c[base:base + n]]
            base += n
            if pts.shape[0] < 3:
                continue
            pts = np.clip(pts, [0, 0], [width, height])
            hull = _convex_hull(pts)
            if hull.shape[0] < 3:
                continue
            x, y = hull[:, 0], hull[:, 1]
            area = 0.5 * abs(float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1))))
            if area < 1.0:
                continue
            extents[inst] = (area, [int(x.min()), int(y.min()), int(math.ceil(x.max())), int(math.ceil(y.max()))])
        return label, img[0, ..., 1], extents

    @torch.no_grad()
    def ground_shadow(
        self,
        points_world: torch.Tensor,  # [H,W,3] background hit points (NuRec world)
        actors: list[tuple[MeshAsset, np.ndarray, np.ndarray | None]],
        sun: SunState,
        res: int = 512,
        softness: float = 0.35,
    ) -> torch.Tensor:
        """Shadow factor in [1-softness .. 1] per background pixel: 1 = lit.

        Orthographic shadow map along the sun direction over the actors' footprint; a background
        point is shadowed when a mesh surface lies between it and the sun.
        """
        if not actors or sun.radiance <= 0.0:
            return None
        d = torch.from_numpy(sun.direction_world.astype(np.float32)).to(self.device)
        # sun-space basis: z' towards the sun
        zt = d
        xt = F.normalize(torch.linalg.cross(torch.tensor([0.0, 0.0, 1.0], device=self.device), zt), dim=0)
        if not torch.isfinite(xt).all() or xt.norm() < 1e-3:
            xt = torch.tensor([1.0, 0.0, 0.0], device=self.device)
        yt = torch.linalg.cross(zt, xt)
        R = torch.stack([xt, yt, zt])  # world -> sun space
        verts, faces, base = [], [], 0
        for asset, T, _ in actors:
            Tt = torch.from_numpy(np.asarray(T, dtype=np.float32)).to(self.device)
            v_w = asset.vertices @ Tt[:3, :3].T + Tt[:3, 3]
            verts.append(v_w @ R.T)
            faces.append(asset.faces + base)
            base += v_w.shape[0]
        v_s = torch.cat(verts)
        fcs = torch.cat(faces)
        lo = v_s[:, :2].min(0).values - 0.5
        hi = v_s[:, :2].max(0).values + 0.5
        span = (hi - lo).max()
        centre = (lo + hi) / 2
        ndc = (v_s[:, :2] - centre) / (span / 2)
        fv_img = ndc[fcs][None]
        fv_z = v_s[:, 2][fcs][None]  # largest z' = closest to the sun
        fv_feat = v_s[:, 2:3][fcs][None]
        smap, fid = rasterize(res, res, fv_z, fv_img, fv_feat)
        smap = torch.where(fid[0] >= 0, smap[0, ..., 0], torch.full_like(smap[0, ..., 0], -1e9))
        # background points into sun space
        p = points_world.reshape(-1, 3) @ R.T
        uv = (p[:, :2] - centre) / (span / 2)  # [-1,1] within the footprint
        inside = (uv.abs() < 1).all(dim=-1)
        grid = uv.reshape(1, 1, -1, 2)
        grid_y = -grid[..., 1:2]  # kaolin y=-1 bottom, grid_sample y=-1 top
        gs = torch.cat([grid[..., 0:1], grid_y], dim=-1)
        occ = F.grid_sample(smap[None, None], gs, mode="nearest", align_corners=False)[0, 0, 0]
        shadowed = inside & (occ > p[:, 2] + 0.02)
        factor = torch.ones(p.shape[0], device=self.device)
        factor[shadowed] = 1.0 - softness
        factor = factor.reshape(points_world.shape[0], points_world.shape[1])
        # soften the edge: small box blur
        factor = F.avg_pool2d(factor[None, None], 5, stride=1, padding=2)[0, 0]
        return factor
