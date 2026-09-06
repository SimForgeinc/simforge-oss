"""``simforge-oss-splat job``: the runner-facing durable render workload
``simforge.render-bundle-nurec/v1`` (host-file transport, declared).

Protocol (same shape as ``simforge-oss-physics job``, agreed with the runtime owner):

- ``--params p.json``::

    {"scenesRoot": dir, "catalog": [dir, ...], "hoodDir": dir | "none",
     "sourcePackages": [{"sha256": hex64, "path": abs}], "scene": mapId,
     "rig": [V5 camera dict, ...] | path to JSON ({"cameras": [...]} or a list),
     "passes": ["rgb" | "depth" | "id", ...], "sceneStatePath": path (set by the runner),
     "ticks": int >= 1, "checkpointEveryTicks": int >= 0 (0 = never)}

  unknown or missing keys are rejected. ``sceneStatePath`` holds a scene-state.v1 stream (a
  JSON list of documents, or one document); tick ``k`` renders ``states[k]`` with ``sim_tick = k``
  and ``ticks`` must not exceed the stream length. Every camera of ``rig`` must be calibrated in
  the package of ``scene``.
- ``--out-dir`` receives ``frames/<sensorId>/<pass>/tick-<06d>.<png|npy>`` (rgb8/rgba8/id as PNG,
  depth32f as ``.npy`` float32 metres), ``bundles.jsonl`` (one line per tick: V5 frame identity,
  per-frame records with the ring-layout CRC32 ``digest`` and ``relativePath``, sourceEvidence,
  visibility), ``results.json`` and ``checkpoint/checkpoint-<tick>-<seq>.json``.
- ``--resume checkpoint.json`` continues at the checkpoint's ``nextTick``; frames already written
  are kept (their bundle lines are re-read from the existing ``bundles.jsonl``). ``generation``
  restarts with the process and ``results.json`` records ``resumedFrom``.
- stdout JSON lines: ``progress``, ``checkpoint``, ``done`` (with artifacts) or ``canceled``;
  stderr JSON line ``error``.
- exit 0 done, 1 bad params/resume, 2 prerequisite/backend/capacity failure (CapabilityError,
  unreachable package or scene, CUDA out of memory), 130 after SIGTERM (current tick finished,
  checkpoint written).

The ``digest`` of every frame equals the CRC32 the shm service would publish for the same tick
(same ``backend.ring_planes`` bytes), so a job's output and a live service's ring are directly
comparable. Writing files is a host copy by definition; this workload never claims otherwise.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import signal
import sys
import time
import zlib
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from . import __version__
from .prerequisites import CapabilityError, HoodProfile
from .protocol import JOB_TRANSPORT, WORKLOAD, parse_passes

PARAM_KEYS = {"scenesRoot", "catalog", "hoodDir", "sourcePackages", "scene", "rig", "passes", "sceneStatePath", "ticks", "checkpointEveryTicks"}
PROGRESS_EVERY_TICKS = 10
_SHA = re.compile(r"[a-f0-9]{64}")


class JobParamsError(ValueError):
    pass


class JobCanceled(Exception):
    pass


@dataclass(frozen=True)
class JobParams:
    scenes_root: Path
    catalog: tuple[Path, ...]
    hood_dir: str
    source_packages: dict[str, Path]
    scene: str
    rig: tuple[dict[str, Any], ...]
    passes: tuple[str, ...]
    scene_state_path: Path
    ticks: int
    checkpoint_every: int

    @classmethod
    def parse(cls, raw: Any) -> "JobParams":
        if not isinstance(raw, dict):
            raise JobParamsError("params must be a JSON object")
        unknown, missing = set(raw) - PARAM_KEYS, PARAM_KEYS - set(raw)
        if unknown or missing:
            raise JobParamsError(f"unknown keys {sorted(unknown)}, missing keys {sorted(missing)}")
        scenes_root = Path(str(raw["scenesRoot"]))
        if not scenes_root.is_absolute():
            raise JobParamsError("scenesRoot must be an absolute directory")
        catalog = raw["catalog"]
        if not isinstance(catalog, list) or not catalog or not all(isinstance(c, str) and Path(c).is_absolute() for c in catalog):
            raise JobParamsError("catalog must be a non-empty list of absolute directories")
        hood = raw["hoodDir"]
        if not isinstance(hood, str) or not hood or (hood != "none" and not Path(hood).is_absolute()):
            raise JobParamsError("hoodDir must be an absolute directory or the literal 'none'")
        packages: dict[str, Path] = {}
        if not isinstance(raw["sourcePackages"], list):
            raise JobParamsError("sourcePackages must be a list of {sha256, path}")
        for item in raw["sourcePackages"]:
            if not isinstance(item, dict) or set(item) != {"sha256", "path"} or not isinstance(item["sha256"], str) or not _SHA.fullmatch(item["sha256"]):
                raise JobParamsError("sourcePackages entries must be {sha256: lowercase hex64, path: absolute file}")
            path = Path(str(item["path"]))
            if not path.is_absolute():
                raise JobParamsError(f"sourcePackages path {path} must be absolute")
            if item["sha256"] in packages:
                raise JobParamsError(f"duplicate sourcePackages sha256 {item['sha256']}")
            packages[item["sha256"]] = path
        scene = raw["scene"]
        if not isinstance(scene, str) or not scene or "/" in scene or scene in (".", ".."):
            raise JobParamsError("scene must be a mapId (directory name under scenesRoot)")
        rig = raw["rig"]
        if isinstance(rig, str):
            rig_path = Path(rig)
            if not rig_path.is_absolute():
                raise JobParamsError("rig path must be absolute")
            try:
                loaded = json.loads(rig_path.read_text())
            except (OSError, ValueError) as exc:
                raise JobParamsError(f"rig file {rig_path}: {exc}") from exc
            rig = loaded.get("cameras") if isinstance(loaded, dict) else loaded
        if not isinstance(rig, list) or not rig or not all(isinstance(c, dict) and isinstance(c.get("sensorId"), str) and c["sensorId"] for c in rig):
            raise JobParamsError("rig must be a non-empty list of camera objects with sensorId (inline or via a JSON file)")
        ids = [c["sensorId"] for c in rig]
        if len(set(ids)) != len(ids):
            raise JobParamsError("rig sensorIds must be unique")
        passes = raw["passes"]
        if not isinstance(passes, list) or not passes or not all(isinstance(p, str) for p in passes):
            raise JobParamsError("passes must be a non-empty list of strings")
        try:
            canonical = parse_passes(passes)
        except CapabilityError as exc:
            raise JobParamsError(str(exc)) from exc
        state_path = Path(str(raw["sceneStatePath"]))
        if not state_path.is_absolute():
            raise JobParamsError("sceneStatePath must be absolute")
        ticks, every = raw["ticks"], raw["checkpointEveryTicks"]
        if not isinstance(ticks, int) or isinstance(ticks, bool) or ticks < 1:
            raise JobParamsError("ticks must be a positive integer")
        if not isinstance(every, int) or isinstance(every, bool) or every < 0:
            raise JobParamsError("checkpointEveryTicks must be a non-negative integer (0 = never)")
        return cls(scenes_root, tuple(Path(c) for c in catalog), hood, packages, scene, tuple(dict(c) for c in rig), canonical, state_path, ticks, every)

    def to_dict(self) -> dict[str, Any]:
        return {
            "scenesRoot": str(self.scenes_root),
            "catalog": [str(c) for c in self.catalog],
            "hoodDir": self.hood_dir,
            "sourcePackages": [{"sha256": k, "path": str(v)} for k, v in sorted(self.source_packages.items())],
            "scene": self.scene,
            "rig": list(self.rig),
            "passes": list(self.passes),
            "sceneStatePath": str(self.scene_state_path),
            "ticks": self.ticks,
            "checkpointEveryTicks": self.checkpoint_every,
        }


def _write_json(path: Path, doc: Any, compact: bool = False) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        if compact:
            json.dump(doc, fh, sort_keys=True, separators=(",", ":"))
        else:
            json.dump(doc, fh, sort_keys=True, indent=2)
        fh.write("\n")
    os.replace(tmp, path)


def _artifact(out_dir: Path, path: Path) -> dict[str, Any]:
    data = path.read_bytes()
    return {"relativePath": str(path.relative_to(out_dir)), "sha256": hashlib.sha256(data).hexdigest(), "sizeBytes": len(data)}


def load_scene_states(path: Path) -> list[dict[str, Any]]:
    doc = json.loads(path.read_text())
    states = doc if isinstance(doc, list) else [doc]
    if not states or not all(isinstance(s, dict) for s in states):
        raise JobParamsError(f"{path}: scene-state stream must be a document or a non-empty list of documents")
    return states


class JobRunner:
    def __init__(self, params: JobParams, out_dir: Path, resume: dict[str, Any] | None) -> None:
        self.params = params
        self.out_dir = out_dir
        self.next_tick = 0
        self.resumed_from: str | None = None
        self.bundles: list[dict[str, Any]] = []
        if resume is not None:
            if resume.get("workload") != WORKLOAD or resume.get("params") != params.to_dict():
                raise JobParamsError("checkpoint workload/params differ from --params")
            self.next_tick = int(resume["nextTick"])
            self.resumed_from = str(resume.get("checkpointPath") or "")
            log_path = out_dir / "bundles.jsonl"
            if log_path.exists():
                with log_path.open(encoding="utf-8") as fh:
                    self.bundles = [json.loads(line) for line in fh if line.strip()]
            self.bundles = [b for b in self.bundles if b["simTick"] < self.next_tick]
            if len(self.bundles) != self.next_tick:
                raise JobParamsError(f"bundles.jsonl holds {len(self.bundles)} ticks, checkpoint expects {self.next_tick}")
        self.states = load_scene_states(params.scene_state_path)
        if params.ticks > len(self.states):
            raise JobParamsError(f"ticks {params.ticks} exceeds the scene-state stream length {len(self.states)}")
        for k, s in enumerate(self.states[: params.ticks]):
            if s.get("mapId") != params.scene:
                raise JobParamsError(f"states[{k}] mapId {s.get('mapId')!r} != scene {params.scene!r}")
        self._canceled = False
        self._checkpoint_seq = 0
        (out_dir / "checkpoint").mkdir(parents=True, exist_ok=True)
        (out_dir / "frames").mkdir(parents=True, exist_ok=True)
        signal.signal(signal.SIGTERM, self._on_sigterm)

    # ------------------------------------------------------------ events
    def _on_sigterm(self, _signum, _frame) -> None:
        self._canceled = True

    @staticmethod
    def emit(event: dict[str, Any]) -> None:
        sys.stdout.write(json.dumps(event, sort_keys=True) + "\n")
        sys.stdout.flush()

    def _checkpoint(self) -> None:
        self._checkpoint_seq += 1
        path = self.out_dir / "checkpoint" / f"checkpoint-{self.next_tick:06d}-{self._checkpoint_seq:04d}.json"
        _write_json(path, {"workload": WORKLOAD, "params": self.params.to_dict(), "nextTick": self.next_tick, "checkpointPath": str(path)})
        self.emit({"event": "checkpoint", "path": str(path), "nextTick": self.next_tick})

    def _rewrite_bundles(self) -> Path:
        path = self.out_dir / "bundles.jsonl"
        tmp = path.with_suffix(".jsonl.tmp")
        with tmp.open("w", encoding="utf-8") as fh:
            for b in self.bundles:
                fh.write(json.dumps(b, sort_keys=True, separators=(",", ":")) + "\n")
        os.replace(tmp, path)
        return path

    # ---------------------------------------------------------------- run
    def run(self) -> None:
        import torch

        from .backend import SplatBackend, SplatSession, ring_planes

        backend = SplatBackend(self.params.scenes_root, list(self.params.catalog), hood=HoodProfile.parse(self.params.hood_dir),
                               source_packages=self.params.source_packages, max_scenes=1)
        session = SplatSession()
        session.load_scene_state(self.states[: self.params.ticks])
        backend.scene_for(self.params.scene)
        session.set_cameras(list(self.params.rig))
        frame_paths: list[Path] = []
        if self.next_tick:
            self._rewrite_bundles()  # truncate any lines past the checkpoint
            frame_paths = [self.out_dir / f["relativePath"] for b in self.bundles for f in b["frames"]]
        t_job = time.perf_counter()
        while self.next_tick < self.params.ticks:
            k = self.next_tick
            session.apply_tick(k)
            t0 = time.perf_counter()
            tick = backend.render_tick(session, k, self.params.passes)
            records = []
            for cam in tick.cameras:
                for plane in ring_planes(cam, tick.passes):
                    rel, digest = self._write_frame(k, plane)
                    frame_paths.append(self.out_dir / rel)
                    records.append({"sensorId": plane.sensor_id, "pass": plane.pass_, "format": plane.format, "width": plane.width,
                                    "height": plane.height, "tickId": k, "digest": digest, "relativePath": rel})
            torch.cuda.synchronize(backend.device)
            server_ms = (time.perf_counter() - t0) * 1000.0
            line = {"simTick": k, "frame": tick.identity.wire(), "frames": records, "sourceEvidence": tick.source_evidence,
                    "visibility": tick.visibility, "serverMs": round(server_ms, 3)}
            self.bundles.append(line)
            with (self.out_dir / "bundles.jsonl").open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(line, sort_keys=True, separators=(",", ":")) + "\n")
            self.next_tick = k + 1
            if self.next_tick % PROGRESS_EVERY_TICKS == 0 or self.next_tick == self.params.ticks:
                self.emit({"event": "progress", "tick": k, "ticks": self.params.ticks, "serverMs": round(server_ms, 3)})
            unfinished = self.next_tick < self.params.ticks
            due = self.params.checkpoint_every and self.next_tick % self.params.checkpoint_every == 0
            if unfinished and (due or self._canceled):
                self._checkpoint()
            if self._canceled and unfinished:
                raise JobCanceled()
        results_path = self.out_dir / "results.json"
        _write_json(results_path, {
            "workload": WORKLOAD, "version": __version__, "params": self.params.to_dict(), "renderer": backend.renderer_info(),
            "transport": JOB_TRANSPORT, "ticks": self.params.ticks, "resumedFrom": self.resumed_from,
            "wallMs": round((time.perf_counter() - t_job) * 1000.0, 1), "qualification": "not-qualified",
        })
        bundles_path = self._rewrite_bundles()
        artifacts = [_artifact(self.out_dir, results_path), _artifact(self.out_dir, bundles_path)]
        artifacts += [_artifact(self.out_dir, p) for p in frame_paths]
        self.emit({"event": "done", "artifacts": artifacts})

    def _write_frame(self, tick: int, plane) -> tuple[str, str]:
        """Host copy of one ring-layout plane -> file; returns (relativePath, CRC32 hex of the ring bytes)."""
        data = plane.data.contiguous().cpu().numpy()
        digest = f"{zlib.crc32(data.tobytes()) & 0xFFFFFFFF:08x}"
        ext = "npy" if plane.format == "depth32f" else "png"
        rel = f"frames/{plane.sensor_id}/{plane.pass_}/tick-{tick:06d}.{ext}"
        path = self.out_dir / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp")
        if plane.format == "depth32f":
            with tmp.open("wb") as fh:
                np.save(fh, data[:, : plane.width])
            os.replace(tmp, path)
        else:
            from PIL import Image

            if plane.format == "rgb8":
                image = Image.fromarray(data, "RGB")
            else:
                image = Image.fromarray(np.ascontiguousarray(data[:, : plane.width * 4].reshape(plane.height, plane.width, 4)), "RGBA")
            image.save(tmp, format="PNG")
            os.replace(tmp, path)
        return rel, digest


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
    except CapabilityError as exc:
        return fail("capability", str(exc), 2)
    except (JobParamsError, OSError, ValueError, KeyError) as exc:
        return fail("bad-params", str(exc), 1)
    try:
        runner.run()
    except JobCanceled:
        runner.emit({"event": "canceled"})
        return 130
    except CapabilityError as exc:
        return fail("capability", str(exc), 2)
    except ImportError as exc:  # a tier prerequisite (torch/kaolin/tracer/trimesh...) is not importable
        return fail("capability", f"prerequisite import failed: {exc}", 2)
    except FileNotFoundError as exc:
        return fail("source-unreachable", str(exc), 2)
    except MemoryError as exc:  # torch.OutOfMemoryError subclasses it
        return fail("gpu-capacity", str(exc), 2)
    except ValueError as exc:  # scene/tick/identity validation from the backend
        return fail("backend", str(exc), 2)
    return 0
