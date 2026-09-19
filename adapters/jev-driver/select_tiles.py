"""Prepare nearby native meshes with the declared BC7 tier, never master textures.

Only geometry is dequantized: the immutable tier KTX2 payloads pass through
unchanged. The source bundle is read-only; staging and cached GLBs live in --out.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import posixpath
import shutil
import struct
import subprocess
import tempfile

ap = argparse.ArgumentParser()
ap.add_argument("--scene-state", required=True)
ap.add_argument("--maps-root", required=True)
ap.add_argument("--out", required=True)
ap.add_argument("--texture-tier", required=True, choices=["textures-512-bc7"])
ap.add_argument("--radius-m", type=float, default=140.0)
args = ap.parse_args()

state = json.loads(Path(args.scene_state).read_text())
bundle = Path(args.maps_root).resolve() / state["mapId"]
manifest_bytes = (bundle / "3d/manifest.json").read_bytes()
manifest = json.loads(manifest_bytes)
manifest_hash = hashlib.sha256(manifest_bytes).hexdigest()
variants = json.loads((bundle / "3d/variants/manifest.json").read_text())
if variants["schemaVersion"] != 1 or variants["sourceManifestSha256"] != manifest_hash:
    raise ValueError("Texture variants do not match the map manifest")
reference = variants["variants"][args.texture_tier]
index_bytes = (bundle / "3d/variants" / reference["file"]).read_bytes()
if hashlib.sha256(index_bytes).hexdigest() != reference["outputSha256"]:
    raise ValueError("Texture tier index digest mismatch")
index = json.loads(index_bytes)
if (index["schemaVersion"] != 1 or index["id"] != args.texture_tier
        or index["codec"] != "bc7" or index["longestEdgePx"] != 512
        or index["sourceManifestSha256"] != manifest_hash):
    raise ValueError("Native playback requires the matching 512 px BC7 texture tier")
out = Path(args.out).resolve()
out.mkdir(parents=True, exist_ok=True)

points = [(e["position"][0], e["position"][2]) for f in state["frames"][::10] for e in f["actors"]]
if not points:
    raise SystemExit("scene state has no actor positions")

radius2 = args.radius_m ** 2
sources = [layer["file"] for layer in manifest.get("staticLayers", [])]
for tile in [*manifest["tiles"], *manifest.get("vegetationTiles", [])]:
    lo, hi = tile["bounds"]["min"], tile["bounds"]["max"]
    near = any(
        max(lo[0] - x, 0.0, x - hi[0]) ** 2 + max(lo[2] - z, 0.0, z - hi[2]) ** 2 < radius2
        for x, z in points
    )
    if near:
        sources.append(tile["lods"][0]["file"])
if not sources:
    raise ValueError("No real map meshes intersect the driven path")

glbs = []
with tempfile.TemporaryDirectory(prefix="tier-stage-", dir=out) as temporary:
    stage = Path(temporary)
    for file in dict.fromkeys(sources):
        src = bundle / "3d" / file
        with src.open("rb") as stream:
            source_hash = hashlib.file_digest(stream, "sha256").hexdigest()
            stream.seek(0)
            header = stream.read(20)
            if header[:4] != b"glTF" or header[16:20] != b"JSON":
                raise ValueError(f"Invalid GLB: {src}")
            document = json.loads(stream.read(struct.unpack_from("<I", header, 12)[0]))
        images = index["assets"][file]["images"]
        for image in document.get("images", []):
            uri = image["uri"]
            key = posixpath.normpath(posixpath.join(posixpath.dirname(file), uri))
            if key not in images:
                raise ValueError(f"Texture missing from tier asset declaration: {file}: {key}")
            selected = index["images"][key]
            if selected["codec"] not in ("bc7", "rgba"):
                raise ValueError(f"Unsupported native tier codec: {selected['codec']}")
            target = (bundle / "3d" / selected["file"]).resolve()
            link = Path(posixpath.normpath(str(stage / "3d" / posixpath.dirname(file) / uri)))
            if not link.is_relative_to(stage):
                raise ValueError(f"Texture URI escapes staging: {uri}")
            if not link.exists():
                with target.open("rb") as stream:
                    if hashlib.file_digest(stream, "sha256").hexdigest() != selected["outputSha256"]:
                        raise ValueError(f"Texture tier object digest mismatch: {target}")
                link.parent.mkdir(parents=True, exist_ok=True)
                link.symlink_to(target)
        identity = hashlib.sha256((source_hash + reference["outputSha256"]).encode()).hexdigest()
        dst = out / args.texture_tier / f"{identity}-{src.name}"
        if not dst.exists():
            staged = stage / "3d" / file
            staged.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(src, staged)
            dst.parent.mkdir(parents=True, exist_ok=True)
            pending = stage / "prepared.glb"
            subprocess.run(
                ["npx", "--yes", "@gltf-transform/cli@4", "dequantize", str(staged), str(pending)],
                check=True, stdout=subprocess.DEVNULL,
            )
            pending.replace(dst)
        glbs.append(str(dst))

selection = {"textureTier": args.texture_tier, "codec": "bc7", "downgradeReason": None,
             "sourceManifestSha256": manifest_hash, "indexSha256": reference["outputSha256"], "glbs": glbs}
(out / "selection.json").write_text(json.dumps(selection, indent=2) + "\n")
print(f"tiles={len(glbs)} textureTier={args.texture_tier} codec=bc7 downgradeReason=null cached={out}")
