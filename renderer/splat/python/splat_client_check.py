#!/usr/bin/env python3
"""End-to-end check of the splat service through the native wire and the ring reader.

Builds a scene-state.v1 doc for one imported scene at a recorded timestamp (ego + recorded
actors from actor-trajectories.json), asks for rgb/depth/id (+ rgb8 policy output), reads the
bundle back with `simforge_native.BundleRingReader`, verifies CRCs, and compares the
front-wide frame to the Phase-0 NRE reference render of the same timestamp when present.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import time
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[3]
sys.path[:0] = [str(REPO / "renderer/service/python"), str(Path(__file__).resolve().parent)]
from simforge_native import NativeRenderClient  # noqa: E402
from simforge_native.bundles import BundleRingReader  # noqa: E402


def interp(samples, t_s):
    if t_s <= samples[0]["timeS"]:
        return samples[0]
    if t_s >= samples[-1]["timeS"]:
        return samples[-1]
    k = 1
    while samples[k]["timeS"] < t_s:
        k += 1
    a, b = samples[k - 1], samples[k]
    f = (t_s - a["timeS"]) / max(1e-9, b["timeS"] - a["timeS"])
    h0, h1 = a["headingRad"], b["headingRad"]
    dh = (h1 - h0 + math.pi) % (2 * math.pi) - math.pi
    return {"x": a["x"] + (b["x"] - a["x"]) * f, "z": a["z"] + (b["z"] - a["z"]) * f, "headingRad": h0 + dh * f, "speedMps": a["speedMps"] + (b["speedMps"] - a["speedMps"]) * f}


def scene_state(bundle: Path, t_s: float, tick_hz: float, inject: dict | None = None, drop: set[str] | None = None) -> dict:
    ego_ref = json.loads((bundle / "ego-reference.json").read_text())["samples"]
    traj = json.loads((bundle / "actor-trajectories.json").read_text())["actors"]
    scen = json.loads((bundle / "scenario.input.json").read_text())
    dims = {a["id"]: a["dims"] for a in scen["actors"]}
    classes = {a["id"]: a["kind"] for a in scen["actors"]}
    actors = []
    e = interp(ego_ref, t_s)
    q = [0.0, math.sin(e["headingRad"] / 2), 0.0, math.cos(e["headingRad"] / 2)]
    vx, vz = e["speedMps"] * math.cos(e["headingRad"]), -e["speedMps"] * math.sin(e["headingRad"])
    actors.append({"id": "ego", "kind": "update", "actorClass": "car", "transform": {"position": [e["x"], 0.0, e["z"]], "rotation": q}, "yawRad": e["headingRad"], "velocity": [vx, 0.0, vz], "dims": dims.get("ego")})
    for tid, a in traj.items():
        aid = f"nurec-{tid}"
        if drop and aid in drop:
            continue
        s = a["samples"]
        if t_s < s[0]["timeS"] - 1e-6 or t_s > s[-1]["timeS"] + 1e-6:
            continue
        p = interp(s, t_s)
        q = [0.0, math.sin(p["headingRad"] / 2), 0.0, math.cos(p["headingRad"] / 2)]
        actors.append({"id": aid, "kind": "update", "actorClass": classes.get(aid, a["kind"]), "transform": {"position": [p["x"], 0.0, p["z"]], "rotation": q}, "yawRad": p["headingRad"], "velocity": [0.0, 0.0, 0.0], "dims": dims.get(aid)})
    if inject:
        actors.append(inject)
    return {"version": "simforge.scene-state.v1", "mapId": bundle.name, "tick": int(round(t_s * tick_hz)), "tickHz": tick_hz, "actors": actors}


def cameras_from_rig(bundle: Path, output: dict | None) -> list[dict]:
    rig = json.loads((bundle / "camera-rig.json").read_text())
    cams = []
    for s in rig["sensors"]:
        c = {"sensorId": s["id"], "width": s["projection"]["width"], "height": s["projection"]["height"], "fovDeg": s["camera"]["verticalFovDeg"],
             "eye": [0, 0, 0], "target": [1, 0, 0], "attach": {"actorId": "ego", "offsetM": [0, 0, 0], "yawDeg": 0, "pitchDeg": 0, "rollDeg": 0, "lookAtActor": False},
             "projection": s["projection"]}
        if output:
            c["output"] = output
        cams.append(c)
    return cams


def psnr(a, b):
    a = a.astype(np.float64); b = b.astype(np.float64)
    mse = np.mean((a - b) ** 2)
    return 99.0 if mse == 0 else 20 * math.log10(255.0 / math.sqrt(mse))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--socket", default="/tmp/simforge-splat-gpu3.sock")
    ap.add_argument("--scene", default="/data/share7/ubuntu/simforge-fix/scenes-v3/007a5809-8a56-40b5-8af5-7e0f65229496")
    ap.add_argument("--nre-ref", default="/data/share7/ubuntu/simforge-fix/nurec-backend/runs/b1")
    ap.add_argument("--ticks", type=int, default=5)
    ap.add_argument("--out", default="/data/share7/ubuntu/simforge-fix/nurec-backend/runs/o2/client-check")
    ap.add_argument("--inject", action="store_true")
    args = ap.parse_args()
    bundle = Path(args.scene)
    out = Path(args.out); out.mkdir(parents=True, exist_ok=True)
    bg = json.loads((bundle / "background.json").read_text())
    start_us = bg["episode"]["startTimestampUs"]
    ref_dir = Path(args.nre_ref) / bundle.name / "nre_ref"
    ref_ticks = sorted({int(p.name.split("_")[0]) for p in ref_dir.glob("*_camera_front_wide_120fov.png")}) if ref_dir.exists() else []
    ref_ticks = [t for t in ref_ticks if 0 <= (t - start_us) / 1e6 <= 20.0]
    tick_hz = 1_000_000.0 if ref_ticks else 50.0
    client = NativeRenderClient(args.socket)
    assert client.hello["protocol"] == 5 and client.hello["transport"] == "host-shm", client.hello
    print("hello:", {k: v for k, v in client.hello.items() if k in ("protocol", "profile", "transport", "renderer", "determinism", "shm")})
    reader = BundleRingReader(client.hello["shm"]["path"])
    cams = cameras_from_rig(bundle, {"width": 552, "height": 348, "format": "rgb8"})
    times = ([(t - start_us) / 1e6 for t in ref_ticks] or [1.0, 3.0, 5.0])[:args.ticks]
    inject = None
    if args.inject:
        e = interp(json.loads((bundle / "ego-reference.json").read_text())["samples"], times[0])
        h = e["headingRad"]
        inject = {"id": "hazard-1", "kind": "spawn", "actorClass": "car", "catalogId": "vehicle.hatchback.audi_a2", "color": "#c0392b",
                  "transform": {"position": [e["x"] + 14 * math.cos(h), 0.0, e["z"] - 14 * math.sin(h)], "rotation": [0, math.sin(h / 2), 0, math.cos(h / 2)]}, "yawRad": h, "velocity": [0, 0, 0]}
    results = []
    for k, t_s in enumerate(times):
        doc = scene_state(bundle, t_s, tick_hz, inject=inject)
        source_timestamp_us = start_us + round(doc["tick"] / doc["tickHz"] * 1e6)
        if ref_ticks:
            assert source_timestamp_us == ref_ticks[k], "Reference/native source clocks differ"
        (out / f"{bundle.name[:8]}_{k}_state.json").write_text(json.dumps(doc, indent=2))
        r0 = client.load_scene_state([doc]); assert r0["ok"], r0
        t0 = time.perf_counter()
        resp = client.render_bundle(k, cams if k == 0 else None, passes=["rgb", "depth", "id"])
        wall = (time.perf_counter() - t0) * 1000
        assert resp["ok"], resp
        (out / f"{bundle.name[:8]}_{k}_response.json").write_text(json.dumps(resp, indent=2))
        b = reader.bundle_at(resp["bundle_offset"], resp["bundle_len"], verify=True)
        views = b.views()
        fw = views["camera_front_wide_120fov"]
        rgb = fw["rgb"]
        row = {"t_s": t_s, "wall_ms": round(wall, 1), "server_ms": round(resp["server_ms"], 1), "frame": resp["frame"], "entries": len(b.entries), "formats": sorted({e.format for e in b.entries}), "rgb_shape": list(rgb.shape) if hasattr(rgb, "shape") else None, "verify": True}
        row["source_timestamp_us"] = source_timestamp_us
        assert resp["frame"]["simTick"] == k and resp["frame"]["sceneRevision"] == k + 1, resp["frame"]
        assert all(e.digest_hex == f["digest"] for e, f in zip(b.entries, resp["frames"])), "ring CRC != response digest"
        if rgb.ndim == 1:  # rgb8 opaque view from the stock reader
            e = next(e for e in b.entries if e.camera_id == "camera_front_wide_120fov" and e.pass_ == "rgb")
            rgb = np.frombuffer(b.payload(e), dtype=np.uint8).reshape(e.height, e.width, 3)
            row["rgb_shape"] = list(rgb.shape)
        from PIL import Image
        Image.fromarray(np.ascontiguousarray(rgb)).save(out / f"{bundle.name[:8]}_{k}_fw.png")
        depth = fw["depth"]
        row["depth_median_m"] = float(np.median(depth[np.isfinite(depth) & (depth > 0)]))
        ids = fw["id"]
        row["id_instances"] = int(len(np.unique(ids[..., 0].astype(np.int32) | (ids[..., 1].astype(np.int32) << 8))) - 1)
        if ref_ticks and k < len(ref_ticks):
            ref = np.asarray(Image.open(ref_dir / f"{ref_ticks[k]}_camera_front_wide_120fov.png").convert("RGB").resize((552, 348), Image.Resampling.BOX))
            row["psnr_vs_nre_552"] = round(psnr(rgb, ref), 2)
            Image.fromarray(np.concatenate([ref, np.ascontiguousarray(rgb)], axis=1)).save(out / f"{bundle.name[:8]}_{k}_nre-vs-service.png")
        results.append(row)
        print(row, flush=True)
    (out / f"{bundle.name[:8]}_check.json").write_text(json.dumps(results, indent=1))
    client.close()


if __name__ == "__main__":
    main()
