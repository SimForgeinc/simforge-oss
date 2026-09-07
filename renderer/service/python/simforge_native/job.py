"""``python -m simforge_native job``: the runner-facing workload
``simforge.render-bundle/v1`` over the in-process renderer.

Protocol (agreed with the native runner owner; mirrors
``adapters/physics/simforge_oss_physics/job.py``):

- ``--params p.json``::

      {"scene": <SceneSpec document or path>,          # glbs[abs], profile, lighting?, nearM, farM, warmupFrames
       "sceneStatePath": "<scene-state.v1 doc or array>",
       "rig": {"cameras": [camera docs], "lidars"?: [...], "radars"?: [...]},
       "passes": ["rgb", "id", "depth", "semantic"],   # default ["rgb"]
       "ticks": {"start": 0, "count": N} | null,        # null = every loaded tick
       "shmSizeBytes"?: int, "checkpointEveryTicks"?: int}

  Unknown or missing keys are rejected.
- ``--out-dir``: ``frames/<sensorId>/<pass>/tick-<06d>.<png|bin|ply|csv>``
  (rgb/id/semantic PNG, depth32f raw little-endian f32 rows, carla depth
  PNG, lidar PLY, radar CSV), ``bundles.jsonl`` (one line per tick: the
  response's ``frame`` identity and records), ``results.json``,
  ``checkpoint/checkpoint-<n>.json``.
- ``--resume checkpoint.json``: continue from ``nextTick``.
- stdout JSON lines ``progress``, ``checkpoint``, ``done`` (with artifacts) or
  ``canceled``; stderr JSON line ``error``.
- exit 0 done, 1 bad params/resume, 2 renderer failure, 130 after SIGTERM
  (SIGBREAK on Windows; current tick finished, checkpoint written).
"""
from __future__ import annotations

import ctypes
import hashlib
import json
import os
import struct
import sys
import tempfile
import time
import zlib
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from .embedded import PROTOCOL, EmbeddedRenderer, EmbeddedRendererError, find_library

PARAM_KEYS = {"scene", "sceneStatePath", "rig", "passes", "ticks", "shmSizeBytes", "checkpointEveryTicks"}
REQUIRED_KEYS = {"scene", "sceneStatePath", "rig"}
PASSES = ("rgb", "id", "depth", "semantic")
PROGRESS_EVERY_TICKS = 10


class JobParamsError(ValueError):
    pass


class JobCanceled(Exception):
    pass


@dataclass(frozen=True)
class JobParams:
    scene: dict[str, Any]
    states: list[dict[str, Any]]
    rig: dict[str, list[dict[str, Any]]]
    passes: list[str]
    start: int
    count: int
    shm_size_bytes: int
    checkpoint_every_ticks: int

    @staticmethod
    def parse(doc: dict[str, Any]) -> "JobParams":
        keys = set(doc)
        if keys - PARAM_KEYS or REQUIRED_KEYS - keys:
            raise JobParamsError(f"params keys must be {sorted(REQUIRED_KEYS)} + optional {sorted(PARAM_KEYS - REQUIRED_KEYS)}; got {sorted(keys)}")
        scene = doc["scene"]
        if isinstance(scene, str):
            with open(scene, encoding="utf-8") as fh:
                scene = json.load(fh)
        if not isinstance(scene, dict) or not scene.get("glbs"):
            raise JobParamsError("scene must be a SceneSpec document with non-empty glbs")
        with open(doc["sceneStatePath"], encoding="utf-8") as fh:
            states = json.load(fh)
        if isinstance(states, dict):
            states = [states]
        if not isinstance(states, list) or not states:
            raise JobParamsError("sceneStatePath must hold one scene-state.v1 document or a non-empty array")
        rig = doc["rig"]
        if not isinstance(rig, dict) or not rig.get("cameras"):
            raise JobParamsError("rig.cameras must be a non-empty list of camera documents")
        passes = list(doc.get("passes") or ["rgb"])
        unknown = [p for p in passes if p not in PASSES]
        if unknown:
            raise JobParamsError(f"unknown passes {unknown}; valid {list(PASSES)}")
        ticks = doc.get("ticks")
        start, count = 0, len(states)
        if ticks is not None:
            start = int(ticks["start"])
            count = int(ticks["count"])
            if start < 0 or count <= 0 or start + count > len(states):
                raise JobParamsError(f"ticks {ticks} out of range for {len(states)} loaded states")
        return JobParams(
            scene=scene,
            states=states,
            rig={k: list(rig.get(k) or []) for k in ("cameras", "lidars", "radars")},
            passes=passes,
            start=start,
            count=count,
            shm_size_bytes=int(doc.get("shmSizeBytes") or 256 * 1024 * 1024),
            checkpoint_every_ticks=int(doc.get("checkpointEveryTicks") or 50),
        )


# ------------------------------------------------------------------ encoding
def _png(width: int, height: int, rows: bytes, color_type: int, channels: int) -> bytes:
    stride = width * channels
    raw = b"".join(b"\x00" + rows[y * stride:(y + 1) * stride] for y in range(height))

    def chunk(tag: bytes, body: bytes) -> bytes:
        return struct.pack(">I", len(body)) + tag + body + struct.pack(">I", zlib.crc32(tag + body) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, color_type, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 6))
            + chunk(b"IEND", b""))


def _stride(width: int, pixel_bytes: int) -> int:
    return -(-width * pixel_bytes // 256) * 256


def encode_record(frame: dict[str, Any], payload: memoryview) -> tuple[str, bytes]:
    """(extension, bytes) for one FrameRecord payload (row-padded)."""
    fmt, w, h = frame["format"], frame["width"], frame["height"]
    if fmt == "rgba8":
        rows = np.frombuffer(payload, np.uint8, count=_stride(w, 4) * h).reshape(h, -1)[:, :w * 4]
        return "png", _png(w, h, np.ascontiguousarray(rows).tobytes(), 6, 4)
    if fmt == "carla-depth-bgra":
        rows = np.frombuffer(payload, np.uint8, count=_stride(w, 4) * h).reshape(h, -1, 4)[:, :w]
        rgba = rows[:, :, [2, 1, 0, 3]]
        return "png", _png(w, h, np.ascontiguousarray(rgba).tobytes(), 6, 4)
    if fmt == "depth32f":
        rows = np.frombuffer(payload, np.uint8, count=_stride(w, 4) * h).reshape(h, -1)[:, :w * 4]
        return "bin", np.ascontiguousarray(rows).tobytes()
    if fmt == "ply-ascii":
        return "ply", bytes(payload)
    if fmt == "radar-csv":
        return "csv", bytes(payload)
    raise EmbeddedRendererError(f"unknown record format {fmt!r}")


# ------------------------------------------------------------------- runner
def _write_bytes(path: Path, data: bytes) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def _write_json(path: Path, doc: Any) -> None:
    _write_bytes(path, (json.dumps(doc, sort_keys=True, indent=2) + "\n").encode())


def _artifact(out_dir: Path, path: Path) -> dict[str, Any]:
    data = path.read_bytes()
    return {"relativePath": str(path.relative_to(out_dir)), "sha256": hashlib.sha256(data).hexdigest(), "sizeBytes": len(data)}


class JobRunner:
    def __init__(self, params: JobParams, out_dir: Path, resume: dict[str, Any] | None) -> None:
        self.params = params
        self.out_dir = out_dir
        self.next_tick = params.start
        self.checkpoints = 0
        self.timings: list[dict[str, Any]] = []
        if resume is not None:
            self.next_tick = int(resume["nextTick"])
            self.checkpoints = int(resume.get("checkpoints", 0))
            if not params.start <= self.next_tick <= params.start + params.count:
                raise JobParamsError(f"resume nextTick {self.next_tick} outside the job's tick range")
        self.cancel = False
        (out_dir / "frames").mkdir(parents=True, exist_ok=True)
        (out_dir / "checkpoint").mkdir(parents=True, exist_ok=True)
        signal.signal(signal.SIGTERM, self._on_sigterm)
        # Windows: the runner cancels with CTRL_BREAK_EVENT on the provider's
        # process group, which Python delivers as SIGBREAK; SIGTERM never
        # arrives from the OS there.
        if hasattr(signal, "SIGBREAK"):
            signal.signal(signal.SIGBREAK, self._on_sigterm)

    def _on_sigterm(self, *_sig: Any) -> None:
        self.cancel = True

    @staticmethod
    def emit(event: dict[str, Any]) -> None:
        sys.stdout.write(json.dumps(event, sort_keys=True) + "\n")
        sys.stdout.flush()

    def _checkpoint(self) -> None:
        self.checkpoints += 1
        path = self.out_dir / "checkpoint" / f"checkpoint-{self.checkpoints}.json"
        _write_json(path, {"nextTick": self.next_tick, "checkpoints": self.checkpoints})
        self.emit({"event": "checkpoint", "path": str(path)})

    def _write_record(self, renderer: EmbeddedRenderer, tick: int, frame: dict[str, Any]) -> None:
        ext, data = encode_record(frame, renderer.read_record(frame))
        path = self.out_dir / "frames" / frame["sensorId"] / frame["pass"] / f"tick-{tick:06d}.{ext}"
        path.parent.mkdir(parents=True, exist_ok=True)
        _write_bytes(path, data)

    def run(self) -> None:
        p = self.params
        shm = tempfile.NamedTemporaryFile(prefix="simforge-render-job-", suffix=".shm", delete=False)
        shm.close()
        try:
            with EmbeddedRenderer(p.scene, shm.name, p.shm_size_bytes) as renderer:
                renderer.request("load_scene_state", states=p.states)
                end = p.start + p.count
                with open(self.out_dir / "bundles.jsonl", "a", encoding="utf-8") as bundles:
                    while self.next_tick < end:
                        tick = self.next_tick
                        fields: dict[str, Any] = {"tick_index": tick, "passes": p.passes}
                        if not self.timings:  # rig persists on the resident renderer after the first request
                            fields.update(cameras=p.rig["cameras"], lidars=p.rig["lidars"], radars=p.rig["radars"])
                        t0 = time.perf_counter()
                        resp = renderer.render_bundle(tick, **fields)
                        for frame in resp["frames"]:
                            self._write_record(renderer, tick, frame)
                        bundles.write(json.dumps({"tick": tick, "frame": resp["frame"], "records": resp["frames"]}, sort_keys=True) + "\n")
                        bundles.flush()
                        self.timings.append({"tick": tick, "serverMs": resp["server_ms"], "wallMs": (time.perf_counter() - t0) * 1000.0})
                        self.next_tick = tick + 1
                        if (tick - p.start + 1) % PROGRESS_EVERY_TICKS == 0 or self.next_tick == end:
                            self.emit({"event": "progress", "tick": tick, "rendered": tick - p.start + 1, "total": p.count})
                        if self.next_tick < end and (tick - p.start + 1) % p.checkpoint_every_ticks == 0:
                            self._checkpoint()
                        if self.cancel:
                            self._checkpoint()
                            raise JobCanceled()
        finally:
            os.unlink(shm.name)
        wall = [t["wallMs"] for t in self.timings]
        _write_json(self.out_dir / "results.json", {
            "schema": "simforge.render-bundle-results/v1",
            "protocol": PROTOCOL,
            "ticks": {"start": p.start, "count": p.count},
            "passes": p.passes,
            "sensors": [c["sensorId"] for c in p.rig["cameras"]],
            "timings": {"frames": len(wall), "avgWallMs": sum(wall) / len(wall) if wall else None,
                        "avgServerMs": sum(t["serverMs"] for t in self.timings) / len(wall) if wall else None},
        })
        artifacts = [_artifact(self.out_dir, f) for f in sorted((self.out_dir / "frames").rglob("tick-*.*"))]
        artifacts.append(_artifact(self.out_dir, self.out_dir / "bundles.jsonl"))
        artifacts.append(_artifact(self.out_dir, self.out_dir / "results.json"))
        self.emit({"event": "done", "artifacts": artifacts})


def run_job(params_path: str, out_dir: str, resume_path: str | None) -> int:
    def fail(code: str, message: str, status: int) -> int:
        sys.stderr.write(json.dumps({"event": "error", "code": code, "message": message}, sort_keys=True) + "\n")
        sys.stderr.flush()
        return status

    try:
        with open(params_path, encoding="utf-8") as fh:
            params = JobParams.parse(json.load(fh))
        resume = None
        if resume_path:
            with open(resume_path, encoding="utf-8") as fh:
                resume = json.load(fh)
        runner = JobRunner(params, Path(out_dir), resume)
    except (JobParamsError, OSError, ValueError, KeyError, TypeError) as exc:
        return fail("bad-params", str(exc), 1)
    try:
        runner.run()
    except JobCanceled:
        runner.emit({"event": "canceled"})
        return 130
    except EmbeddedRendererError as exc:
        return fail("renderer", str(exc), 2)
    return 0


def capabilities() -> dict[str, Any]:
    library = find_library()
    doc: dict[str, Any] = {"workload": "simforge.render-bundle/v1", "protocol": PROTOCOL, "passes": list(PASSES),
                           "library": None, "gpuInterop": False}
    if library:
        data = Path(library).read_bytes()
        doc["library"] = {"path": library, "sha256": hashlib.sha256(data).hexdigest(), "sizeBytes": len(data)}
        lib = ctypes.CDLL(library)
        lib.simforge_render_gpu_interop.restype = ctypes.c_int
        doc["gpuInterop"] = bool(lib.simforge_render_gpu_interop())
    return doc


def main(argv: list[str]) -> int:
    if not argv:
        sys.stderr.write("usage: python -m simforge_native job --params P --out-dir D [--resume C] | capabilities\n")
        return 1
    if argv[0] == "capabilities":
        sys.stdout.write(json.dumps(capabilities(), sort_keys=True) + "\n")
        return 0
    if argv[0] == "job":
        args = dict(zip(argv[1::2], argv[2::2]))
        if set(args) - {"--params", "--out-dir", "--resume"} or "--params" not in args or "--out-dir" not in args:
            sys.stderr.write("usage: python -m simforge_native job --params P --out-dir D [--resume C]\n")
            return 1
        return run_job(args["--params"], args["--out-dir"], args.get("--resume"))
    sys.stderr.write(f"unknown command {argv[0]!r}\n")
    return 1
