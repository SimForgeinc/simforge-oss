"""Pick the map tiles the driven path actually passes, and decompress them once.

Installed tiles use EXT_meshopt_compression + KHR_mesh_quantization, which no
current scen-play build loads. `gltf-transform dequantize` decodes both on read
and writes them back out uncompressed, keeping KHR_texture_basisu (the vendored
bevy_gltf reads that natively). Results are cached: re-runs skip the work.
"""
from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path

ap = argparse.ArgumentParser()
ap.add_argument("--scene-state", required=True)
ap.add_argument("--maps-root", required=True)
ap.add_argument("--out", required=True)
ap.add_argument("--radius-m", type=float, default=140.0)
args = ap.parse_args()

state = json.loads(Path(args.scene_state).read_text())
bundle = Path(args.maps_root) / state["mapId"]
manifest = json.loads((bundle / "3d" / "manifest.json").read_text())
out = Path(args.out)
out.mkdir(parents=True, exist_ok=True)

points = [(e["position"][0], e["position"][2]) for f in state["frames"][::10] for e in f["actors"]]
if not points:
    raise SystemExit("scene state has no actor positions")

radius2 = args.radius_m ** 2
sources, heights = [], []
for tile in manifest["tiles"]:
    lo, hi = tile["bounds"]["min"], tile["bounds"]["max"]
    near = any(
        max(lo[0] - x, 0.0, x - hi[0]) ** 2 + max(lo[2] - z, 0.0, z - hi[2]) ** 2 < radius2
        for x, z in points
    )
    if near:
        sources.append(bundle / "3d" / tile["lods"][0]["file"])
        heights += [lo[1], hi[1]]

for layer in manifest.get("staticLayers", []):  # road surface, always relevant
    sources.insert(0, bundle / "3d" / layer["file"])

for src in sources:
    dst = out / src.name
    if dst.exists():
        continue
    subprocess.run(
        ["npx", "--yes", "@gltf-transform/cli@4", "dequantize", str(src), str(dst)],
        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )

# Chase camera and actor origins sit on the road surface, so take the lower end
# of the tile height range rather than the mean, which vegetation tiles skew.
ground_y = 0.0  # unused: render.sh lets the renderer raycast terrain instead
(out / "ground-y.txt").write_text("0\n")  # retained for callers that pin a flat height
print(f"tiles={len(sources)} cached={out} ground_y={ground_y}")
