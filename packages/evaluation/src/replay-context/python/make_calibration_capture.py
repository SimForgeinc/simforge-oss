#!/usr/bin/env python3
"""Generate a product-owned calibrated pinhole capture for exercising the reconstruction path.

Reconstruction needs a calibrated, ego-posed, multi-view capture with a real seed point cloud.
Licensed AV captures are gated and non-redistributable, and a reconstruction of one cannot be
committed either — so proving that `reconstruct.nurec` actually trains and exports needs an
input we own outright. This generates one: a small textured scene rasterised from known camera
poses, with the point cloud taken from the scene's own geometry rather than estimated.

Everything here is authored in this repository. No third-party asset, no dataset byte, no
scanned or captured content. The output is therefore committable and publishable, and it
carries no licence obligation.

What makes it a *valid* reconstruction input rather than a toy:

- **Real pinhole calibration.** One intrinsic matrix, applied consistently to project geometry
  and written verbatim into `cameras.txt` as a COLMAP `PINHOLE` model. The renderer and the
  dataset cannot disagree, because the same numbers do both jobs.
- **Exact poses.** Camera poses are chosen, not solved, and written in COLMAP's world-to-camera
  convention. Any pose error in a reconstruction from this capture is the reconstructor's.
- **A real point cloud.** `points3D.txt` holds the scene's actual surface samples with their
  actual colours — the seed a 3DGUT run initialises from, not random noise.
- **Genuine multi-view parallax.** Cameras orbit and translate, so surfaces are seen from
  materially different angles; a reconstruction that only memorised one view will not fit.

What it deliberately is not: photorealistic, noisy, or exposure-varying. It exercises the
pipeline and the gates, not a claim about real-world reconstruction quality. A bundle built
from it is marked `synthetic-fixture` and can never be scored.

Usage:
    make_calibration_capture.py --out <dir> [--views 24] [--width 640] [--height 480]
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np

# ----------------------------------------------------------------------------- scene


def _box(centre: np.ndarray, size: np.ndarray, colour: tuple[int, int, int]) -> list[tuple]:
    """Axis-aligned box as 12 coloured triangles."""
    cx, cy, cz = centre
    sx, sy, sz = size / 2.0
    corners = np.array(
        [
            [cx - sx, cy - sy, cz - sz], [cx + sx, cy - sy, cz - sz],
            [cx + sx, cy + sy, cz - sz], [cx - sx, cy + sy, cz - sz],
            [cx - sx, cy - sy, cz + sz], [cx + sx, cy - sy, cz + sz],
            [cx + sx, cy + sy, cz + sz], [cx - sx, cy + sy, cz + sz],
        ],
        dtype=np.float64,
    )
    faces = [
        (0, 1, 2), (0, 2, 3), (4, 6, 5), (4, 7, 6),
        (0, 4, 5), (0, 5, 1), (2, 6, 7), (2, 7, 3),
        (1, 5, 6), (1, 6, 2), (0, 3, 7), (0, 7, 4),
    ]
    # Shade each face slightly differently so orientation is recoverable from appearance alone;
    # a uniformly coloured box is ambiguous to a reconstructor and would be a weaker test.
    out = []
    for index, (a, b, c) in enumerate(faces):
        shade = 0.65 + 0.35 * (index / len(faces))
        out.append((corners[a], corners[b], corners[c], tuple(int(min(255, ch * shade)) for ch in colour)))
    return out


def build_scene() -> list[tuple]:
    """A ground plane with a few boxes on it. Metres, z-up, origin at the plane centre."""
    tris: list[tuple] = []
    # Ground: a checker of triangles so the plane carries texture rather than being featureless.
    step = 1.0
    for ix in range(-6, 6):
        for iy in range(-6, 6):
            x0, y0 = ix * step, iy * step
            x1, y1 = x0 + step, y0 + step
            light = (ix + iy) % 2 == 0
            colour = (150, 150, 155) if light else (95, 95, 100)
            p00 = np.array([x0, y0, 0.0])
            p10 = np.array([x1, y0, 0.0])
            p11 = np.array([x1, y1, 0.0])
            p01 = np.array([x0, y1, 0.0])
            tris.append((p00, p10, p11, colour))
            tris.append((p00, p11, p01, colour))
    tris += _box(np.array([0.0, 0.0, 0.75]), np.array([1.5, 1.5, 1.5]), (200, 80, 70))
    tris += _box(np.array([2.5, -1.5, 0.5]), np.array([1.0, 2.0, 1.0]), (70, 140, 200))
    tris += _box(np.array([-2.0, 2.0, 1.0]), np.array([1.2, 1.2, 2.0]), (90, 190, 110))
    return tris


# ------------------------------------------------------------------------ rasteriser


def rasterise(
    tris: list[tuple],
    world_from_cam: np.ndarray,
    fx: float,
    fy: float,
    cx: float,
    cy: float,
    width: int,
    height: int,
) -> np.ndarray:
    """Z-buffered pinhole rasterisation. Returns uint8 RGB [H, W, 3]."""
    cam_from_world = np.linalg.inv(world_from_cam)
    image = np.zeros((height, width, 3), dtype=np.uint8)
    depth = np.full((height, width), np.inf)

    for a, b, c, colour in tris:
        pts = np.stack([a, b, c])
        cam = (cam_from_world[:3, :3] @ pts.T).T + cam_from_world[:3, 3]
        if np.any(cam[:, 2] <= 0.05):
            continue  # behind or too close to the camera; no near-plane clipping in this tool
        u = fx * cam[:, 0] / cam[:, 2] + cx
        v = fy * cam[:, 1] / cam[:, 2] + cy
        zs = cam[:, 2]

        min_x = max(int(np.floor(u.min())), 0)
        max_x = min(int(np.ceil(u.max())), width - 1)
        min_y = max(int(np.floor(v.min())), 0)
        max_y = min(int(np.ceil(v.max())), height - 1)
        if min_x > max_x or min_y > max_y:
            continue

        area = (u[1] - u[0]) * (v[2] - v[0]) - (u[2] - u[0]) * (v[1] - v[0])
        if abs(area) < 1e-9:
            continue

        xs = np.arange(min_x, max_x + 1)
        ys = np.arange(min_y, max_y + 1)
        gx, gy = np.meshgrid(xs + 0.5, ys + 0.5)
        w0 = ((u[1] - u[0]) * (gy - v[0]) - (gx - u[0]) * (v[1] - v[0])) / area
        w1 = ((gx - u[0]) * (v[2] - v[0]) - (u[2] - u[0]) * (gy - v[0])) / area
        w2 = 1.0 - w0 - w1
        inside = (w0 >= 0) & (w1 >= 0) & (w2 >= 0)
        if not inside.any():
            continue
        # Barycentric weights above are (for vertex 2, vertex 1, vertex 0) by construction.
        z = w2 * zs[0] + w1 * zs[1] + w0 * zs[2]
        patch_depth = depth[min_y : max_y + 1, min_x : max_x + 1]
        visible = inside & (z < patch_depth)
        if not visible.any():
            continue
        patch_depth[visible] = z[visible]
        patch_image = image[min_y : max_y + 1, min_x : max_x + 1]
        patch_image[visible] = np.array(colour, dtype=np.uint8)
    return image


def surface_points(tris: list[tuple], per_triangle: int, rng: np.random.Generator) -> tuple[np.ndarray, np.ndarray]:
    """Uniform samples on the scene's triangles: the seed point cloud, from real geometry."""
    points = []
    colours = []
    for a, b, c, colour in tris:
        u = rng.random((per_triangle, 1))
        v = rng.random((per_triangle, 1))
        over = (u + v) > 1.0
        u[over] = 1.0 - u[over]
        v[over] = 1.0 - v[over]
        pts = a + u * (b - a) + v * (c - a)
        points.append(pts)
        colours.append(np.repeat(np.array(colour, dtype=np.int64)[None, :], per_triangle, axis=0))
    return np.concatenate(points), np.concatenate(colours)


def look_at(eye: np.ndarray, target: np.ndarray) -> np.ndarray:
    """world_from_cam for an OpenCV-convention camera (+x right, +y down, +z forward)."""
    forward = target - eye
    forward = forward / np.linalg.norm(forward)
    world_up = np.array([0.0, 0.0, 1.0])
    right = np.cross(forward, world_up)
    right = right / np.linalg.norm(right)
    down = np.cross(forward, right)
    m = np.eye(4)
    m[:3, 0] = right
    m[:3, 1] = down
    m[:3, 2] = forward
    m[:3, 3] = eye
    return m


def quat_wxyz(rotation: np.ndarray) -> tuple[float, float, float, float]:
    trace = rotation[0, 0] + rotation[1, 1] + rotation[2, 2]
    if trace > 0:
        s = math.sqrt(trace + 1.0) * 2
        return s / 4, (rotation[2, 1] - rotation[1, 2]) / s, (rotation[0, 2] - rotation[2, 0]) / s, (rotation[1, 0] - rotation[0, 1]) / s
    if rotation[0, 0] > rotation[1, 1] and rotation[0, 0] > rotation[2, 2]:
        s = math.sqrt(1.0 + rotation[0, 0] - rotation[1, 1] - rotation[2, 2]) * 2
        return (rotation[2, 1] - rotation[1, 2]) / s, s / 4, (rotation[0, 1] + rotation[1, 0]) / s, (rotation[0, 2] + rotation[2, 0]) / s
    if rotation[1, 1] > rotation[2, 2]:
        s = math.sqrt(1.0 + rotation[1, 1] - rotation[0, 0] - rotation[2, 2]) * 2
        return (rotation[0, 2] - rotation[2, 0]) / s, (rotation[0, 1] + rotation[1, 0]) / s, s / 4, (rotation[1, 2] + rotation[2, 1]) / s
    s = math.sqrt(1.0 + rotation[2, 2] - rotation[0, 0] - rotation[1, 1]) * 2
    return (rotation[1, 0] - rotation[0, 1]) / s, (rotation[0, 2] + rotation[2, 0]) / s, (rotation[1, 2] + rotation[2, 1]) / s, s / 4


def main() -> int:
    parser = argparse.ArgumentParser(description="product-owned calibrated pinhole capture")
    parser.add_argument("--out", required=True)
    parser.add_argument("--views", type=int, default=24)
    parser.add_argument("--width", type=int, default=640)
    parser.add_argument("--height", type=int, default=480)
    parser.add_argument("--seed", type=int, default=7)
    args = parser.parse_args()

    from PIL import Image

    out = Path(args.out)
    images_dir = out / "images"
    sparse = out / "sparse" / "0"
    images_dir.mkdir(parents=True, exist_ok=True)
    sparse.mkdir(parents=True, exist_ok=True)

    width, height = args.width, args.height
    fx = fy = 0.9 * width
    cx, cy = width / 2.0, height / 2.0
    tris = build_scene()
    rng = np.random.default_rng(args.seed)

    poses: list[np.ndarray] = []
    for index in range(args.views):
        angle = 2 * math.pi * index / args.views
        radius = 7.0 + 0.6 * math.sin(3 * angle)
        eye = np.array([radius * math.cos(angle), radius * math.sin(angle), 2.6 + 0.5 * math.cos(2 * angle)])
        poses.append(look_at(eye, np.array([0.0, 0.0, 0.8])))

    camera_lines = [
        "# Camera list with one line of data per camera:",
        "#   CAMERA_ID, MODEL, WIDTH, HEIGHT, PARAMS[]",
        f"1 PINHOLE {width} {height} {fx} {fy} {cx} {cy}",
    ]
    (sparse / "cameras.txt").write_text("\n".join(camera_lines) + "\n")

    image_lines = [
        "# Image list with two lines of data per image:",
        "#   IMAGE_ID, QW, QX, QY, QZ, TX, TY, TZ, CAMERA_ID, NAME",
        "#   POINTS2D[]",
    ]
    for index, world_from_cam in enumerate(poses):
        rgb = rasterise(tris, world_from_cam, fx, fy, cx, cy, width, height)
        name = f"view-{index:04d}.png"
        Image.fromarray(rgb).save(images_dir / name)
        cam_from_world = np.linalg.inv(world_from_cam)
        qw, qx, qy, qz = quat_wxyz(cam_from_world[:3, :3])
        t = cam_from_world[:3, 3]
        image_lines.append(f"{index + 1} {qw} {qx} {qy} {qz} {t[0]} {t[1]} {t[2]} 1 {name}")
        image_lines.append("")
    (sparse / "images.txt").write_text("\n".join(image_lines) + "\n")

    points, colours = surface_points(tris, per_triangle=12, rng=rng)
    point_lines = ["# 3D point list with one line of data per point:", "#   POINT3D_ID, X, Y, Z, R, G, B, ERROR, TRACK[]"]
    for index, (p, c) in enumerate(zip(points, colours)):
        point_lines.append(f"{index + 1} {p[0]} {p[1]} {p[2]} {int(c[0])} {int(c[1])} {int(c[2])} 0.0")
    (sparse / "points3D.txt").write_text("\n".join(point_lines) + "\n")

    manifest = {
        "schema": "simforge.calibration-capture/v1",
        "generator": "make_calibration_capture.py",
        "authoredInRepository": True,
        "license": "Apache-2.0 (authored here; contains no third-party or captured content)",
        "views": args.views,
        "resolution": {"width": width, "height": height},
        "intrinsics": {"model": "PINHOLE", "fx": fx, "fy": fy, "cx": cx, "cy": cy},
        "pointCloud": {"points": int(points.shape[0]), "source": "exact scene surface samples, not estimated"},
        "poses": "exact, authored; COLMAP world-to-camera convention",
        "note": "Synthetic. Exercises the reconstruction pipeline and its gates; not a claim about real-world reconstruction quality.",
    }
    (out / "capture.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({**manifest, "outputDir": str(out)}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
