#!/usr/bin/env python3
"""Pixel measurement for the replay-context validity gates (G1, G2).

Compares the renders produced by ``simforge-oss-splat job`` against the frames actually
recorded in the NuRec package, and reports the numbers ``gates.ts`` turns into verdicts. All
imaging lives here rather than in TypeScript because this side already has the stack; the
caller does the orchestration and owns the thresholds.

Inputs
------
``--package``      the ``.usdz`` scene artifact; recorded frames are its
                   ``frames/<sensorId>/<timestampUs>.jpeg`` members, read straight from the zip.
``--render-dir``   a job output directory: ``frames/<sensorId>/rgb/tick-<06d>.png`` and
                   ``frames/<sensorId>/depth/tick-<06d>.npy``.
``--baseline-dir`` for an off-trajectory probe, the on-trajectory render of the same scene.
``--episode-start-us`` / ``--tick-hz`` reproduce the renderer's own clock
                   (``t_us = episode_start + tick / tick_hz * 1e6``) so a rendered tick is
                   matched to the recorded frame it should look like. The formula is the
                   renderer's, not a re-derivation.

Output
------
One JSON document on stdout::

    {"perCamera": [{"sensorId", "cameraId", "frames", "psnrDb", "ssim"}],
     "holeFraction": float, "worstCamera": str}

Honesty rules encoded here
--------------------------
* A rendered tick with no recorded frame within half a frame period is **skipped**, not
  compared against the nearest thing available: a fidelity number computed against the wrong
  instant is worse than a missing one.
* Recorded frames are area-resampled down to the render size before comparison. The package
  records at full sensor resolution while the renderer works at the calibrated render size,
  and upsampling the render would invent detail and inflate the score.
* ``holeFraction`` is *newly* unsupported pixels relative to the baseline. Sky is unsupported
  in every render of an outdoor scene; counting it would make every scene fail for a reason
  that has nothing to do with leaving the trajectory.
"""

from __future__ import annotations

import argparse
import io
import json
import re
import sys
import zipfile
from pathlib import Path

import numpy as np

FRAME_MEMBER = re.compile(r"^frames/([^/]+)/(\d+)\.(jpe?g|png)$", re.IGNORECASE)
TICK_FILE = re.compile(r"^tick-(\d{6})\.(png|npy)$")


def _load_image(data: bytes) -> np.ndarray:
    """Decode to float32 RGB in [0, 1]."""
    from PIL import Image

    with Image.open(io.BytesIO(data)) as handle:
        return np.asarray(handle.convert("RGB"), dtype=np.float32) / 255.0


def _area_resize(image: np.ndarray, width: int, height: int) -> np.ndarray:
    """Area-average resample to (height, width). Downsampling only; never invents detail."""
    from PIL import Image

    if image.shape[0] == height and image.shape[1] == width:
        return image
    with Image.fromarray((np.clip(image, 0.0, 1.0) * 255.0).astype(np.uint8)) as handle:
        resized = handle.resize((width, height), Image.BOX)
        return np.asarray(resized, dtype=np.float32) / 255.0


def _gaussian_kernel(sigma: float = 1.5, radius: int = 5) -> np.ndarray:
    offsets = np.arange(-radius, radius + 1, dtype=np.float64)
    kernel = np.exp(-(offsets ** 2) / (2.0 * sigma * sigma))
    return (kernel / kernel.sum()).astype(np.float32)


def _blur(image: np.ndarray, kernel: np.ndarray) -> np.ndarray:
    """Separable convolution with edge padding, on a [H, W] plane."""
    radius = (kernel.size - 1) // 2
    padded = np.pad(image, ((0, 0), (radius, radius)), mode="edge")
    horizontal = np.zeros_like(image)
    for index, weight in enumerate(kernel):
        horizontal += weight * padded[:, index : index + image.shape[1]]
    padded = np.pad(horizontal, ((radius, radius), (0, 0)), mode="edge")
    vertical = np.zeros_like(image)
    for index, weight in enumerate(kernel):
        vertical += weight * padded[index : index + image.shape[0], :]
    return vertical


def _psnr(a: np.ndarray, b: np.ndarray) -> float:
    mse = float(np.mean((a - b) ** 2))
    if mse <= 0.0:
        return 99.0
    return float(10.0 * np.log10(1.0 / mse))


def _ssim(a: np.ndarray, b: np.ndarray) -> float:
    """Mean SSIM over the luminance channel, Gaussian window (sigma 1.5), standard constants."""
    kernel = _gaussian_kernel()
    luma_a = a @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    luma_b = b @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    c1 = 0.01 ** 2
    c2 = 0.03 ** 2
    mu_a = _blur(luma_a, kernel)
    mu_b = _blur(luma_b, kernel)
    mu_aa = mu_a * mu_a
    mu_bb = mu_b * mu_b
    mu_ab = mu_a * mu_b
    sigma_aa = _blur(luma_a * luma_a, kernel) - mu_aa
    sigma_bb = _blur(luma_b * luma_b, kernel) - mu_bb
    sigma_ab = _blur(luma_a * luma_b, kernel) - mu_ab
    numerator = (2.0 * mu_ab + c1) * (2.0 * sigma_ab + c2)
    denominator = (mu_aa + mu_bb + c1) * (sigma_aa + sigma_bb + c2)
    # SSIM is bounded by 1; on a near-flat region float error can push the ratio a hair past it,
    # and a reported 1.0000113 would look like a measurement bug rather than a perfect match.
    return float(np.clip(np.mean(numerator / np.maximum(denominator, 1e-12)), -1.0, 1.0))


def _recorded_frames(package: Path) -> dict[str, list[tuple[int, str]]]:
    frames: dict[str, list[tuple[int, str]]] = {}
    with zipfile.ZipFile(package) as archive:
        for name in archive.namelist():
            match = FRAME_MEMBER.match(name)
            if match is None:
                continue
            frames.setdefault(match.group(1), []).append((int(match.group(2)), name))
    for entries in frames.values():
        entries.sort()
    return frames


def _rendered_ticks(render_dir: Path, sensor_id: str, kind: str, suffix: str) -> dict[int, Path]:
    directory = render_dir / "frames" / sensor_id / kind
    if not directory.is_dir():
        return {}
    ticks: dict[int, Path] = {}
    for path in directory.iterdir():
        match = TICK_FILE.match(path.name)
        if match is not None and path.name.endswith(suffix):
            ticks[int(match.group(1))] = path
    return ticks


def _unsupported_mask(depth: np.ndarray) -> np.ndarray:
    """Pixels the renderer produced no surface for: non-finite or non-positive depth."""
    return ~np.isfinite(depth) | (depth <= 0.0)


def main() -> int:
    parser = argparse.ArgumentParser(description="replay-context fidelity and coverage measurement")
    parser.add_argument("--package", required=True)
    parser.add_argument("--render-dir", required=True)
    parser.add_argument("--baseline-dir")
    parser.add_argument("--cameras", required=True, help="comma-separated <cameraId>:<sensorId> pairs")
    parser.add_argument("--episode-start-us", type=int, default=0)
    parser.add_argument("--tick-hz", type=float, default=10.0)
    args = parser.parse_args()

    package = Path(args.package)
    render_dir = Path(args.render_dir)
    baseline_dir = Path(args.baseline_dir) if args.baseline_dir else None

    cameras: list[tuple[int, str]] = []
    for token in args.cameras.split(","):
        if not token.strip():
            continue
        camera_id, _, sensor_id = token.partition(":")
        cameras.append((int(camera_id), sensor_id))

    recorded = _recorded_frames(package)
    tolerance_us = int(0.5 * 1e6 / args.tick_hz)

    per_camera = []
    worst_hole = 0.0
    worst_camera = ""

    with zipfile.ZipFile(package) as archive:
        for camera_id, sensor_id in cameras:
            rgb_ticks = _rendered_ticks(render_dir, sensor_id, "rgb", ".png")
            depth_ticks = _rendered_ticks(render_dir, sensor_id, "depth", ".npy")
            baseline_depth = (
                _rendered_ticks(baseline_dir, sensor_id, "depth", ".npy") if baseline_dir is not None else {}
            )
            entries = recorded.get(sensor_id, [])

            psnr_values: list[float] = []
            ssim_values: list[float] = []
            newly_unsupported: list[float] = []

            for tick in sorted(rgb_ticks):
                t_us = int(round(args.episode_start_us + tick / args.tick_hz * 1e6))

                if entries:
                    nearest = min(entries, key=lambda entry: abs(entry[0] - t_us))
                    if abs(nearest[0] - t_us) <= tolerance_us:
                        rendered = _load_image(rgb_ticks[tick].read_bytes())
                        truth = _area_resize(
                            _load_image(archive.read(nearest[1])), rendered.shape[1], rendered.shape[0]
                        )
                        psnr_values.append(_psnr(rendered, truth))
                        ssim_values.append(_ssim(rendered, truth))

                depth_path = depth_ticks.get(tick)
                if depth_path is None:
                    continue
                depth = np.load(depth_path)
                mask = _unsupported_mask(depth)
                base_path = baseline_depth.get(tick)
                if base_path is not None:
                    base_mask = _unsupported_mask(np.load(base_path))
                    if base_mask.shape == mask.shape:
                        mask = mask & ~base_mask
                newly_unsupported.append(float(np.mean(mask)))

            hole = max(newly_unsupported) if newly_unsupported else 0.0
            if hole >= worst_hole:
                worst_hole = hole
                worst_camera = sensor_id
            per_camera.append(
                {
                    "sensorId": sensor_id,
                    "cameraId": camera_id,
                    "frames": len(psnr_values),
                    "psnrDb": float(np.mean(psnr_values)) if psnr_values else 0.0,
                    "ssim": float(np.mean(ssim_values)) if ssim_values else 0.0,
                }
            )

    json.dump(
        {"perCamera": per_camera, "holeFraction": worst_hole, "worstCamera": worst_camera},
        sys.stdout,
    )
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
