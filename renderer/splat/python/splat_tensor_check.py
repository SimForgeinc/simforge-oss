#!/usr/bin/env python3
"""In-process validation of the NuRec direct-tensor path against a real imported scene.

Exercises `simforge_splat.tensor.NuRecTensorSensor` on one scene bundle (its NuRec package must
be reachable) and records, as a JSON report:

  1. ready/release ordering on a NON-default consumer stream (a consumer kernel reads the leased
     planes on its own stream; the checksum it computes must equal a host-verified checksum);
  2. bounded backpressure: with every slot leased the third render raises LeaseExhausted within
     --wait-ms; releasing one lease lets it proceed;
  3. held-view lifetime: a lease kept across later renders, reset_cameras, camera re-registration
     and a scene-state reload keeps its contents (checksum unchanged) until its own release;
  3b. retained views after release(): the slot is HELD (no reuse, no free), the capacity account
     does not grow (pools-only default), a render with every slot held raises LeaseExhausted, and
     dropping the view hands the slot back; the view's bytes never change meanwhile;
  4. identity: simTick echoes the request; sceneRevision/rigRevision/generation advance exactly
     when the resident state, the rig and the render count change;
  5. no host staging in render(): the CUDA memory-copy counters (torch profiler) over N steady
     renders show zero DtoH bytes; the DIAGNOSTIC host copies this script makes are outside the
     measured window and labeled as such;
  6. bounded VRAM: torch allocator peak over N steady renders with immediate release;
  7. host parity (optional, --socket): the same tick rendered through the running splat service
     yields ring payload CRC32s equal to the tensor planes' CRC32s (rgb8 packed rows; depth/id
     re-padded on the host to the ring's 256-byte stride).

Requires a CUDA GPU with the 3DGUT tracer built; this is the real-source recipe, not a unit test.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import zlib
from pathlib import Path

import numpy as np
import torch

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
sys.path[:0] = [str(REPO / "renderer/service/python"), str(HERE)]
from simforge_splat.tensor import LeaseExhausted, NuRecTensorError, NuRecTensorSensor, NuRecTensorUnsupported  # noqa: E402
from splat_client_check import cameras_from_rig, scene_state  # noqa: E402

FRONT = "camera_front_wide_120fov"


def crc_tensor(t: torch.Tensor, stream: torch.cuda.Stream) -> str:
    """DIAGNOSTIC device->host copy of one tensor on `stream`."""
    with torch.cuda.stream(stream):
        c = t.clone()
    stream.synchronize()
    return f"{zlib.crc32(c.cpu().numpy().tobytes()) & 0xFFFFFFFF:08x}"


def crc_planes(lease, stream: torch.cuda.Stream) -> dict[str, str]:
    """DIAGNOSTIC device->host copy on the consumer stream; not part of the measured path."""
    out = {}
    with torch.cuda.stream(stream):
        tensors = {name: t.clone() for name, t in lease.tensors().items()}
    stream.synchronize()
    for name, t in tensors.items():
        out[name] = f"{zlib.crc32(t.cpu().numpy().tobytes()) & 0xFFFFFFFF:08x}"
    return out


def consumer_checksum(lease, stream: torch.cuda.Stream) -> int:
    """A 'policy kernel': sums the rgb plane on the consumer stream (ordered after the ready event)."""
    with torch.cuda.stream(stream):
        return int(lease.plane("rgb").to(torch.int64).sum().item())


def padded_crc(plane: np.ndarray, pixel_bytes: int) -> str:
    """CRC of the plane laid out like a ring record (rows padded to 256 B)."""
    h = plane.shape[0]
    row = plane.reshape(h, -1).view(np.uint8)
    stride = -(-row.shape[1] // 256) * 256
    buf = np.zeros((h, stride), dtype=np.uint8)
    buf[:, : row.shape[1]] = row
    return f"{zlib.crc32(buf.tobytes()) & 0xFFFFFFFF:08x}"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--scene", required=True, help="imported scene bundle dir (<scenes-root>/<mapId>)")
    ap.add_argument("--catalog", action="append", default=[], help="GLB catalog roots (repeatable)")
    ap.add_argument("--hood-dir", required=True, metavar="DIR|none", help="hood overlay profile, same as the service (stamped into evidence)")
    ap.add_argument("--skip-digest", action="store_true")
    ap.add_argument("--socket", default=None, help="running splat service for host-path parity")
    ap.add_argument("--steady", type=int, default=20, help="steady-state renders for the profiler/VRAM windows")
    ap.add_argument("--wait-ms", type=int, default=200)
    ap.add_argument("--out", default="/tmp/splat-tensor-check.json")
    args = ap.parse_args()
    bundle = Path(args.scene)
    catalog = args.catalog or [str(REPO / "catalog/vehicles-carla"), str(REPO / "catalog/pedestrians-carla")]
    report: dict = {"scene": bundle.name, "device": torch.cuda.get_device_name(0)}

    sensor = NuRecTensorSensor.open(bundle.parent, catalog, hood=args.hood_dir, slots=2, wait_ms=args.wait_ms,
                                    verify_digest=not args.skip_digest)
    report["capabilities"] = sensor.capabilities()
    cams = cameras_from_rig(bundle, {"width": 552, "height": 348, "format": "rgb8"})
    docs = [scene_state(bundle, t_s, 50.0) for t_s in (1.0, 3.0, 5.0)]
    loaded = sensor.load_scene_state(docs)
    sensor.set_cameras(cams)
    planes = {"rgb": "rgb8", "depth": "depth32f", "id": "rgba8"}
    consumer = torch.cuda.Stream()

    # -- capability errors are explicit (probed before any stream exists) -------------------
    errors = {}
    for label, fn in {
        "semantic": lambda: sensor.open_stream(FRONT, {"semantic": "rgba8"}),
        "jpeg_format": lambda: sensor.open_stream(FRONT, {"rgb": "jpeg"}),
        "unknown_camera": lambda: sensor.open_stream("not-a-camera", planes),
        "cpu_stream": lambda: sensor.render(0, consumer_stream="cpu"),
        "no_stream": lambda: sensor.render(0, consumer_stream=consumer),
    }.items():
        try:
            fn()
            errors[label] = "NO ERROR (bug)"
        except (NuRecTensorUnsupported, NuRecTensorError, ValueError) as e:
            errors[label] = f"{type(e).__name__}: {e}"
    report["capability_errors"] = errors
    streams = {c["sensorId"]: sensor.open_stream(c["sensorId"], planes).wire() for c in cams}
    report["streams"] = streams

    # -- 1. ordering on a non-default stream --------------------------------------------
    f0 = sensor.render(0, consumer_stream=consumer)
    a = f0[FRONT]
    kernel_sum = consumer_checksum(a, consumer)
    consumer.synchronize()
    host_sum = int(a.plane("rgb").cpu().to(torch.int64).sum().item())  # DIAGNOSTIC
    crc0 = crc_planes(a, consumer)
    report["ordering"] = {"consumer_kernel_sum": kernel_sum, "host_sum": host_sum, "equal": kernel_sum == host_sum, "crc": crc0}
    report["identity"] = [f0.identity.wire()]
    assert f0.identity.sim_tick == 0 and f0.identity.scene_revision == loaded["sceneRevision"] == 1 and f0.identity.rig_revision == 1

    # -- 2. bounded backpressure ------------------------------------------------------------
    f1 = sensor.render(1, consumer_stream=consumer)
    report["identity"].append(f1.identity.wire())
    t0 = time.perf_counter()
    try:
        sensor.render(2, consumer_stream=consumer)
        report["backpressure"] = {"exhausted": False}
    except LeaseExhausted as e:
        report["backpressure"] = {"exhausted": True, "waited_ms": round((time.perf_counter() - t0) * 1000, 1), "error": str(e)}
    f0.release()
    f2 = sensor.render(2, consumer_stream=consumer)
    report["identity"].append(f2.identity.wire())
    assert f2.identity.generation == f1.identity.generation + 1
    f2.release()

    # -- 3. held view across later frames / reset / re-register / reload --------------------
    held = f1[FRONT]
    held_crc = crc_planes(held, consumer)
    sensor.reset_cameras()
    sensor.set_cameras(cams)
    for c in cams:
        sensor.open_stream(c["sensorId"], planes)
    sensor.load_scene_state(docs)  # same mapId: streams stay; sceneRevision bumps
    f3 = sensor.render(3, consumer_stream=consumer)
    report["identity"].append(f3.identity.wire())
    assert f3.identity.rig_revision == 3 and f3.identity.scene_revision == 2, f3.identity
    f3.release()
    held_after = crc_planes(held, consumer)
    report["held_view"] = {"before": held_crc, "after": held_after, "unchanged": held_crc == held_after, "released": held.released}
    f1.release()
    assert sensor.outstanding() == 0

    # -- 3b. release while a view is still held: reuse is deferred, memory is bounded ----------
    mem0 = sensor.memory()
    f4 = sensor.render(4, consumer_stream=consumer)
    kept = f4[FRONT].plane("rgb")  # exported view outlives the lease
    kept_crc = crc_tensor(kept, consumer)
    f4.release()
    held_after_release = sensor.held()
    with sensor.render(5, consumer_stream=consumer) as fr:  # the other slot
        consumer_checksum(fr[FRONT], consumer)
        kept2 = fr[FRONT].plane("rgb")  # both slots now held by views
    t0 = time.perf_counter()
    try:
        sensor.render(6, consumer_stream=consumer)
        exhausted = False
    except LeaseExhausted:
        exhausted = True
    waited_ms = round((time.perf_counter() - t0) * 1000, 1)
    del kept2  # handback happens on the next acquire's reclaim
    with sensor.render(6, consumer_stream=consumer) as fr:
        consumer_checksum(fr[FRONT], consumer)
    mem1 = sensor.memory()
    report["held_view_after_release"] = {
        "held_after_release": held_after_release, "exhausted_with_both_held": exhausted, "waited_ms": waited_ms,
        "unchanged": crc_tensor(kept, consumer) == kept_crc, "used_bytes_before": mem0["usedBytes"],
        "used_bytes_after": mem1["usedBytes"], "capacity_bytes": mem1["capacityBytes"], "outstanding": sensor.outstanding()}
    assert held_after_release >= 1 and exhausted and report["held_view_after_release"]["unchanged"], report["held_view_after_release"]
    assert mem1["usedBytes"] == mem0["usedBytes"] <= mem1["capacityBytes"], (mem0, mem1)
    del kept

    # -- 4/5/6. steady state: profiler memcpy + allocator peak ---------------------------------
    torch.cuda.synchronize()
    torch.cuda.reset_peak_memory_stats()
    base = torch.cuda.memory_allocated()
    from torch.profiler import ProfilerActivity, profile

    with profile(activities=[ProfilerActivity.CUDA]) as prof:
        for k in range(args.steady):
            with sensor.render(10 + k, consumer_stream=consumer) as frame:
                consumer_checksum(frame[FRONT], consumer)
        torch.cuda.synchronize()
    dtoh = [e for e in prof.key_averages() if "Memcpy DtoH" in e.key]
    report["steady_state"] = {
        "renders": args.steady,
        "dtoh_events": sum(e.count for e in dtoh),
        "dtoh_keys": [e.key for e in dtoh],
        "peak_alloc_mb": round(torch.cuda.max_memory_allocated() / 2**20, 1),
        "alloc_growth_mb": round((torch.cuda.memory_allocated() - base) / 2**20, 1),
        "outstanding_leases": sensor.outstanding(),
    }

    # -- 7. host parity through the running service ------------------------------------------
    if args.socket:
        from simforge_native import BundleRingReader, NativeRenderClient

        client = NativeRenderClient(args.socket)
        assert client.hello["protocol"] == 5, client.hello
        reader = BundleRingReader(client.hello["shm"]["path"])
        client.load_scene_state([docs[0]])
        resp = client.render_bundle(0, cams, passes=["rgb", "depth", "id"])
        assert resp["ok"], resp
        b = reader.bundle_at(resp["bundle_offset"], resp["bundle_len"], verify=True)
        host = {(e.camera_id, e.pass_): e.digest_hex for e in b.entries}
        fx = sensor.render(0, consumer_stream=consumer)
        parity = {}
        for cid, lease in fx.leases.items():
            with torch.cuda.stream(consumer):
                t = {n: v.clone() for n, v in lease.tensors().items()}
            consumer.synchronize()
            rgb = t["rgb"].cpu().numpy()
            parity[f"{cid}/rgb"] = (f"{zlib.crc32(rgb.tobytes()) & 0xFFFFFFFF:08x}", host.get((cid, "rgb")))
            parity[f"{cid}/depth"] = (padded_crc(t["depth"].cpu().numpy(), 4), host.get((cid, "depth")))
            parity[f"{cid}/id"] = (padded_crc(t["id"].cpu().numpy(), 4), host.get((cid, "id")))
        fx.release()
        report["host_parity"] = {"pairs": parity, "identical": all(a == b for a, b in parity.values()),
                                 "service_frame": resp["frame"], "note": "tensor CRCs from DIAGNOSTIC host copies"}
        client.close()
        reader.close()

    sensor.close()
    Path(args.out).write_text(json.dumps(report, indent=1, default=str))
    print(json.dumps({k: report[k] for k in ("ordering", "backpressure", "held_view", "held_view_after_release", "steady_state", "host_parity") if k in report}, indent=1, default=str))


if __name__ == "__main__":
    main()
