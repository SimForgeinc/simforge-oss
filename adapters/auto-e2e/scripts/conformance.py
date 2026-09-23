#!/usr/bin/env python3
"""Replay one completed drive decision's Bevy PNGs through a live AutoE2E socket.

Run after a >=6.5-second measured episode so all 64 input poses are retained in
steps.jsonl (the prologue is intentionally excluded from the scored trace):

  scripts/conformance.py --run RUN_DIR --socket /tmp/auto-e2e.sock --out receipt.json

This is an inference probe, not a simulator replay or a score recomputation.
The PNGs are the bench's recorded Bevy outputs.  It refuses a short pose
history, malformed frame, failed strict checkpoint probe or invalid raster.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import math
import os
from pathlib import Path
import socket
import struct
import time

import msgpack
from PIL import Image

SENSORS = (
    "camera_front_wide_120fov",
    "camera_cross_left_120fov",
    "camera_cross_right_120fov",
    "camera_rear_tele_30fov",
    "camera_rear_left_70fov",
    "camera_rear_right_70fov",
)


def rpc(connection: socket.socket, payload: dict) -> dict:
    data = msgpack.packb(payload, use_bin_type=True)
    connection.sendall(struct.pack("<I", len(data)) + data)
    def exactly(size: int) -> bytes:
        parts = bytearray()
        while len(parts) < size:
            chunk = connection.recv(size - len(parts))
            if not chunk:
                raise EOFError("AutoE2E endpoint closed before completing its response")
            parts.extend(chunk)
        return bytes(parts)
    size = struct.unpack("<I", exactly(4))[0]
    response = msgpack.unpackb(exactly(size), raw=False)
    if response.get("ok") is not True:
        raise RuntimeError(f"endpoint error: {response.get('error')}")
    return response["result"]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument("--socket", required=True)
    parser.add_argument("--map-dir", type=Path)
    parser.add_argument("--step", type=int, default=64)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    config = json.loads((args.run / "run.json").read_text())
    if config["policyId"] != "auto-e2e":
        raise ValueError("conformance input must be an auto-e2e drive run")
    steps = [json.loads(line) for line in (args.run / "steps.jsonl").read_text().splitlines()]
    if args.step < 64 or args.step >= len(steps):
        raise ValueError(f"--step must be in [64, {len(steps) - 1}] to use 64 measured poses")
    history = []
    for row in steps[args.step - 64:args.step]:
        pose = row["pose"]
        history.append([pose["x"], pose["y"], pose["yawRad"], pose["speedMps"], row["tS"]])
    if any(abs(history[i][4] - history[i - 1][4] - 0.1) > 1e-5 for i in range(1, 64)):
        raise ValueError("recorded ego history is not 64 real poses at 10Hz")
    pose = steps[args.step - 1]["pose"]
    # Each step row is post-action; the camera of step N is rendered at that
    # step's input pose, after row N-1. Warmup frames occupy [0,warmupFrames).
    frame_index = int(config["warmupFrames"]) + args.step
    cameras, frame_receipts = [], []
    for index, sensor in enumerate(SENSORS):
        file = args.run / "frames" / sensor / f"{frame_index}.png"
        with Image.open(file) as image:
            rgb = image.convert("RGB")
            cameras.append({"camera_id": index, "encoding": "raw", "width": rgb.width, "height": rgb.height, "frames": [rgb.tobytes()]})
        frame_receipts.append({"path": str(file), "sha256": hashlib.sha256(file.read_bytes()).hexdigest()})
    map_dir = args.map_dir
    if map_dir is None:
        cache = Path(os.environ.get("SIMFORGE_MAPS_CACHE_ROOT", Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local/share")) / "simforge/maps"))
        map_dir = cache / "map-bundles" / config["mapId"]
    with gzip.open(map_dir / "topology-index.json.gz", "rt") as file:
        topology = json.load(file)
    lanes = [
        {"polyline": lane["polyline"], "widthM": lane.get("representativeWidthM") or 3.5,
         "laneType": lane["laneType"], "isJunction": lane.get("isJunction", False), "junctionId": lane.get("junctionId")}
        for lane in topology["lanes"].values() if len(lane.get("polyline", [])) >= 2
    ]
    # Reuse the native mission route recorded by newer policy versions. For
    # older artifacts, select the nearest real lane polyline from the same
    # OpenDRIVE-derived topology; never substitute the model trajectory.
    route = steps[args.step - 1].get("extras", {}).get("routePoints")
    if not isinstance(route, list) or len(route) < 2:
        px, py = float(pose["x"]), float(pose["y"])
        candidates = []
        for lane in lanes:
            points = [[float(p.get("x", 0.0)), float(p.get("y", 0.0))] if isinstance(p, dict) else [float(p[0]), float(p[1])] for p in lane["polyline"]]
            if len(points) < 2:
                continue
            nearest = min(range(len(points)), key=lambda i: (points[i][0] - px) ** 2 + (points[i][1] - py) ** 2)
            candidates.append((math.hypot(points[nearest][0] - px, points[nearest][1] - py), points[nearest:]))
        if not candidates:
            raise ValueError("the run has no native routePoints and topology has no lane polyline")
        route = min(candidates, key=lambda item: item[0])[1]
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(120)
        connection.connect(args.socket)
        hello = rpc(connection, {"op": "hello", "config": {"graph": {"lanes": lanes}}})
        if not hello.get("probe", {}).get("loadable"):
            raise ValueError("endpoint strict checkpoint probe did not pass")
        started = time.perf_counter()
        result = rpc(connection, {"op": "act", "seed": int(config["seed"]) + args.step, "obs": {
            "cameras": cameras, "pose": pose, "ego_history": history, "route": {"points": route},
        }})
        elapsed_ms = (time.perf_counter() - started) * 1000
    controls = result["controls"]
    extras = result["extras"]
    if len(controls) != 64 or any(len(row) != 2 or not all(math.isfinite(v) for v in row) for row in controls):
        raise ValueError("model did not produce 64 finite acceleration/curvature control pairs")
    if not (extras["mapValid"] and extras["routeValid"] and extras["egoHistory"]["paddedOldestRows"] == 0):
        raise ValueError("invalid raster or padded ego history")
    receipt = {
        "schema": "simforge.auto-e2e-conformance/v1",
        "runDir": str(args.run.resolve()),
        "step": args.step,
        "source": "recorded native Bevy PNGs + OpenDRIVE-derived topology + native mission route + measured ego poses",
        "frames": frame_receipts,
        "hello": hello,
        "elapsedMs": elapsed_ms,
        "result": result,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps({
        "ok": True,
        "receipt": str(args.out),
        "controls": len(controls),
        "elapsedMs": elapsed_ms,
        "vram": result["vram"],
        "raster": extras["raster"],
    }))


if __name__ == "__main__":
    main()
