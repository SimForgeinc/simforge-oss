"""``simforge-oss-physics job``: the runner-facing workload
``simforge.articulated-mujoco/v1``.

Protocol (agreed with the native runner owner):

- ``--params p.json``: ``{"backend": "mujoco-cpu"|"mujoco-warp", "seeds": [int],
  "start": "approach"|"ramp"|"plateau", "decisions": int, "torqueNm": float,
  "checkpointEveryDecisions": int}``; unknown or missing keys are rejected.
- ``--out-dir``: receives ``episodes.json`` (per-seed summaries),
  ``scene-state.<seed>.json`` per episode and ``checkpoint/checkpoint-<n>.json``.
- ``--resume checkpoint.json``: continue from a checkpoint written by this command.
- stdout JSON lines: ``progress``, ``checkpoint``, ``done`` (with artifacts) or
  ``canceled``; stderr JSON line ``error``.
- exit 0 done, 1 bad params/resume, 2 solver/backend/capacity failure,
  130 after SIGTERM (current decision finished, checkpoint written).

The Warp backend runs every seed as one world of a single batch. A world that
finishes early is summarised, then reset with its own seed so the batch keeps
consistent per-world state; its later trajectory is discarded.
"""

from __future__ import annotations

import hashlib
import json
import os
import signal
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence

import numpy as np

from .course_asset import render_scene_spec, write_course_resources
from .cpu import MuJoCoCpuSession
from .profile import Backend
from .scene_state import merge_scene_state, scene_state_digest, to_service_states
from .types import (
    BackendCapabilityError,
    ContactCapacityError,
    PhysicsAdapterError,
    ResetOptions,
    Snapshot,
    StepResult,
)
from .workload import ACTION_SIZE, OBS, Workload

PARAM_KEYS = {"backend", "seeds", "start", "decisions", "torqueNm", "checkpointEveryDecisions"}
PROGRESS_EVERY_DECISIONS = 50


class JobParamsError(ValueError):
    pass


class JobCanceled(Exception):
    pass


@dataclass(frozen=True)
class JobParams:
    backend: Backend
    seeds: tuple[int, ...]
    start: str
    decisions: int
    torque_nm: float
    checkpoint_every: int

    @classmethod
    def parse(cls, raw: Any) -> "JobParams":
        if not isinstance(raw, dict):
            raise JobParamsError("params must be a JSON object")
        unknown = set(raw) - PARAM_KEYS
        missing = PARAM_KEYS - set(raw)
        if unknown or missing:
            raise JobParamsError(f"unknown keys {sorted(unknown)}, missing keys {sorted(missing)}")
        try:
            backend = Backend(raw["backend"])
        except ValueError as exc:
            raise JobParamsError(f"backend must be one of {[b.value for b in Backend]}") from exc
        seeds = raw["seeds"]
        if not isinstance(seeds, list) or not seeds or not all(isinstance(s, int) and not isinstance(s, bool) for s in seeds):
            raise JobParamsError("seeds must be a non-empty list of integers")
        if len(set(seeds)) != len(seeds):
            raise JobParamsError("seeds must be unique (they name output files)")
        if raw["start"] not in ("approach", "ramp", "plateau"):
            raise JobParamsError("start must be approach|ramp|plateau")
        decisions, every = raw["decisions"], raw["checkpointEveryDecisions"]
        if not isinstance(decisions, int) or decisions < 1:
            raise JobParamsError("decisions must be a positive integer")
        if not isinstance(every, int) or every < 0:
            raise JobParamsError("checkpointEveryDecisions must be a non-negative integer (0 = never)")
        torque = raw["torqueNm"]
        if not isinstance(torque, (int, float)) or isinstance(torque, bool) or not np.isfinite(torque):
            raise JobParamsError("torqueNm must be a finite number")
        return cls(backend, tuple(seeds), raw["start"], decisions, float(torque), every)

    def to_dict(self) -> dict[str, Any]:
        return {
            "backend": self.backend.value,
            "seeds": list(self.seeds),
            "start": self.start,
            "decisions": self.decisions,
            "torqueNm": self.torque_nm,
            "checkpointEveryDecisions": self.checkpoint_every,
        }


def episode_summary(seed: int, workload: Workload, last: StepResult, total_reward: float, doc: dict) -> dict[str, Any]:
    """Per-seed summary; identical shape for ``rollout`` and ``job``."""
    return {
        "seed": seed,
        "decisions": last.tick,
        "time_s": last.time_s,
        "terminated": last.terminated,
        "truncated": last.truncated,
        "total_reward": total_reward,
        "final_chassis_pos_m": last.observation[OBS["chassis_pos"]].tolist(),
        "info": {k: (v.item() if hasattr(v, "item") else v) for k, v in last.info.items()},
        "scene_state_digest": scene_state_digest(doc),
        "scene_state_frames": doc["tickCount"],
        "workload_digest": workload.digest,
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


class JobRunner:
    def __init__(self, params: JobParams, out_dir: Path, resume: dict[str, Any] | None) -> None:
        self.params = params
        self.out_dir = out_dir
        self.workload = Workload()
        self.completed: list[dict[str, Any]] = []
        self.episode_index = 0
        #: Accumulated reward per in-progress seed; persisted in checkpoints.
        self.rewards: dict[int, float] = {}
        self.resume_snapshots: dict[int, Snapshot] = {}
        #: scene-state recorded before the checkpoint, per seed; the segment
        #: recorded after restore is merged onto it when the episode finishes.
        self.prior_recordings: dict[int, dict[str, Any]] = {}
        if resume is not None:
            if resume.get("params") != params.to_dict():
                raise JobParamsError("checkpoint params differ from --params")
            self.completed = list(resume["completed"])
            self.episode_index = int(resume["episodeIndex"])
            self.rewards = {int(k): float(v) for k, v in resume["rewards"].items()}
            self.resume_snapshots = {int(s["seed"]): Snapshot.from_dict(s) for s in resume["snapshots"]}
            self.prior_recordings = {int(k): v for k, v in resume["recordings"].items()}
        self._canceled = False
        self._checkpoint_seq = 0
        (out_dir / "checkpoint").mkdir(parents=True, exist_ok=True)
        signal.signal(signal.SIGTERM, self._on_sigterm)

    # ------------------------------------------------------------ events

    def _on_sigterm(self, _signum, _frame) -> None:
        self._canceled = True

    @staticmethod
    def emit(event: dict[str, Any]) -> None:
        sys.stdout.write(json.dumps(event, sort_keys=True) + "\n")
        sys.stdout.flush()

    def _write_episodes(self) -> Path:
        path = self.out_dir / "episodes.json"
        _write_json(path, self.completed)
        return path

    def _checkpoint(self, snapshots: Sequence[Snapshot], recordings: dict[int, dict[str, Any]], decision: int) -> None:
        """``recordings`` maps seed -> scene-state exported so far (already
        merged with any prior segment) for every snapshotted world."""
        self._checkpoint_seq += 1
        path = self.out_dir / "checkpoint" / f"checkpoint-{decision:06d}-{self._checkpoint_seq:04d}.json"
        _write_json(
            path,
            {
                "params": self.params.to_dict(),
                "episodeIndex": self.episode_index,
                "snapshots": [s.to_dict() for s in snapshots],
                "recordings": {str(k): v for k, v in recordings.items()},
                "rewards": {str(k): v for k, v in self.rewards.items()},
                "completed": self.completed,
            },
        )
        self.emit({"event": "checkpoint", "path": str(path)})

    def _recording(self, seed: int, segment: dict[str, Any]) -> dict[str, Any]:
        prior = self.prior_recordings.get(seed)
        return merge_scene_state(prior, segment) if prior is not None else segment

    def _progress(self, seed: int, res: StepResult) -> None:
        self.emit({"event": "progress", "seed": seed, "decision": res.tick, "timeS": res.time_s})

    def _finish_episode(self, seed: int, last: StepResult, segment: dict) -> None:
        doc = self._recording(seed, segment)
        self.prior_recordings.pop(seed, None)
        _write_json(self.out_dir / f"scene-state.{seed}.json", doc, compact=True)
        _write_json(self.out_dir / "render" / f"scene-state.{seed}.native.json", to_service_states(doc), compact=True)
        self.completed.append(episode_summary(seed, self.workload, last, self.rewards.pop(seed, 0.0), doc))
        self._write_episodes()

    def _write_render_resources(self) -> list[Path]:
        """Course GLB (content-addressed), its manifest and the renderer prewarm
        SceneSpec. ``render/scene-spec.json`` keeps GLB paths relative to the
        output directory; a consumer resolves them with
        ``course_asset.render_scene_spec`` before prewarming."""
        manifest = write_course_resources(self.workload, self.out_dir)
        render_dir = self.out_dir / "render"
        render_dir.mkdir(parents=True, exist_ok=True)
        spec = render_scene_spec(manifest, self.out_dir)
        spec["glbs"] = [f["path"] for f in manifest["files"] if f["kind"] == "glb"]
        spec_path = render_dir / "scene-spec.json"
        _write_json(spec_path, {"schema": "simforge.physics-render-scene/v1", "mapId": manifest["mapId"], "glbPathsRelativeTo": ".", "sceneSpec": spec})
        return [self.out_dir / f["path"] for f in manifest["files"]] + [self.out_dir / "course" / "manifest.json", spec_path]

    # ---------------------------------------------------------------- run

    def run(self) -> None:
        resources = self._write_render_resources()
        if self.params.backend is Backend.MUJOCO_CPU:
            self._run_cpu()
        else:
            self._run_warp()
        episodes = self._write_episodes()
        artifacts = [_artifact(self.out_dir, p) for p in [episodes, *resources]]
        for s in self.completed:
            artifacts.append(_artifact(self.out_dir, self.out_dir / f"scene-state.{s['seed']}.json"))
            artifacts.append(_artifact(self.out_dir, self.out_dir / "render" / f"scene-state.{s['seed']}.native.json"))
        self.emit({"event": "done", "artifacts": artifacts})

    def _run_cpu(self) -> None:
        action = np.full(ACTION_SIZE, self.params.torque_nm)
        seeds = self.params.seeds
        while self.episode_index < len(seeds):
            seed = seeds[self.episode_index]
            session = MuJoCoCpuSession(self.workload)
            snap = self.resume_snapshots.pop(seed, None)
            if snap is not None:
                res = session.restore(snap)
            else:
                res = session.reset(seed, ResetOptions(start=self.params.start))  # type: ignore[arg-type]
                self.rewards[seed] = 0.0
            while res.tick < self.params.decisions and not res.done:
                res = session.step(action)
                self.rewards[seed] += res.reward
                if res.tick % PROGRESS_EVERY_DECISIONS == 0 or res.done:
                    self._progress(seed, res)
                unfinished = res.tick < self.params.decisions and not res.done
                due = self.params.checkpoint_every and res.tick % self.params.checkpoint_every == 0
                if unfinished and (due or self._canceled):
                    self._checkpoint([session.snapshot()], {seed: self._recording(seed, session.export_scene_state())}, res.tick)
                if self._canceled:
                    if not unfinished:
                        self._finish_episode(seed, res, session.export_scene_state())
                        self.episode_index += 1
                        self._checkpoint([], {}, res.tick)
                    raise JobCanceled()
            self._finish_episode(seed, res, session.export_scene_state())
            self.episode_index += 1

    def _run_warp(self) -> None:
        from .warp import MuJoCoWarpBatch

        seeds = list(self.params.seeds)
        nworld = len(seeds)
        batch = MuJoCoWarpBatch(self.workload, nworld=nworld)
        options = ResetOptions(start=self.params.start)  # type: ignore[arg-type]
        done_seeds = {s["seed"] for s in self.completed}
        active = np.array([s not in done_seeds for s in seeds])
        batch.reset(seeds, options)
        for w, seed in enumerate(seeds):
            snap = self.resume_snapshots.pop(seed, None)
            if snap is not None:
                batch.restore(w, snap)
            elif active[w]:
                self.rewards[seed] = 0.0
        actions = np.full((nworld, ACTION_SIZE), self.params.torque_nm)
        while active.any():
            res = batch.step(actions)
            tick = int(res.tick[active].max())
            reset_mask = res.terminated | res.truncated
            for w in np.flatnonzero(active):
                seed = seeds[w]
                world = res.world(w)
                self.rewards[seed] += world.reward
                finished = world.done or world.tick >= self.params.decisions
                if world.tick % PROGRESS_EVERY_DECISIONS == 0 or finished:
                    self._progress(seed, world)
                if finished:
                    self._finish_episode(seed, world, batch.export_scene_state(w))
                    active[w] = False
                    reset_mask[w] = True
            # Finished worlds are reset with their own seed so the batch stays
            # steppable; their further trajectory is never recorded.
            if reset_mask.any():
                batch.reset_worlds(reset_mask, seeds, options)
            due = self.params.checkpoint_every and tick % self.params.checkpoint_every == 0
            if active.any() and (due or self._canceled):
                worlds = np.flatnonzero(active)
                self._checkpoint(
                    [batch.snapshot(w) for w in worlds],
                    {seeds[w]: self._recording(seeds[w], batch.export_scene_state(w)) for w in worlds},
                    tick,
                )
            if self._canceled:
                raise JobCanceled()
        self.episode_index = len(seeds)


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
    except (JobParamsError, OSError, ValueError, KeyError) as exc:
        return fail("bad-params", str(exc), 1)
    try:
        runner.run()
    except JobCanceled:
        runner.emit({"event": "canceled"})
        return 130
    except ContactCapacityError as exc:
        return fail("contact-capacity", str(exc), 2)
    except BackendCapabilityError as exc:
        return fail("backend-capability", str(exc), 2)
    except PhysicsAdapterError as exc:
        return fail("physics-adapter", str(exc), 2)
    return 0
