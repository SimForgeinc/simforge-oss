"""``python -m simforge_oss_gpu job``: the runner-facing workload
(``simforge.gpu-batch-rollout/v1``) following the provider job protocol of
``simforge_oss_physics.job``.

stdout JSON lines: ``progress {decision, timeS, worldsEnded}``,
``checkpoint {path}``, then ``done {artifacts: [{relativePath, sha256, sizeBytes}]}``
(exit 0) or, after SIGTERM, a final checkpoint and ``canceled`` (exit 130).
stderr ``{"event": "error", code, message}`` with exit 1 (``bad-params``) or 2
(``admission``, ``capacity``, ``backend``).

Params (``--params`` JSON; unknown keys rejected)::

    {
      "inputPath": "scenario.json",          # SimScenarioInput document
      "topologyPath": "topology-index.json.gz",
      "numWorlds": 1024,
      "episode": {...},                      # EpisodeConfig object (optional)
      "decisions": 200,                      # decisions per world after reset
      "actions": "hold" | "path/to/schedule.json",  # JSON array of EnvAction per decision (cycled)
      "device": "cuda:0",
      "seeds": [..numWorlds ints..],         # optional, default 0..N-1
      "checkpointEveryDecisions": 50,        # 0 = never
      "leaseSlots": 2                        # optional
    }

Artifacts: ``rollout.json`` (per-world return / length / termination cause,
capabilities, digests) and ``decisions.jsonl.gz`` (one record per decision:
decision index, t, per-world reward and ended flags, and SHA-256 digests of the
state-vector and reward-term arrays for conformance/replay checks).
Checkpoints: ``checkpoint/checkpoint-<decision>-<n>.npz`` (device state via
``RoadwayGpuBatch.checkpoint`` plus job progress); ``--resume`` restores one.

The per-decision host readback here is the *job's* recording, declared as
such; it is not the training hot path (bindings consume leases on device).
"""

from __future__ import annotations

import gzip
import hashlib
import io
import json
import os
import signal
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from .batch import CHECKPOINT_FORMAT, ActionBatch, Checkpoint, RoadwayGpuBatch
from .errors import BackendUnavailableError, GpuBatchError, ProfileAdmissionError
from .lane_graph import LaneGraph
from .profile import PROFILE_ID
from .scenario import EpisodeConfig

PARAM_KEYS = {"inputPath", "topologyPath", "numWorlds", "episode", "decisions", "actions", "device", "seeds",
              "checkpointEveryDecisions", "leaseSlots"}
PROGRESS_EVERY_DECISIONS = 50
WORKLOAD_ID = "simforge.gpu-batch-rollout/v1"


class JobParamsError(ValueError):
    pass


class JobCanceled(Exception):
    pass


@dataclass(frozen=True)
class JobParams:
    input_path: str
    topology_path: str
    num_worlds: int
    episode: dict[str, Any] | None
    decisions: int
    actions: str
    device: str
    seeds: tuple[int, ...] | None
    checkpoint_every: int
    lease_slots: int

    @classmethod
    def parse(cls, raw: Any) -> "JobParams":
        if not isinstance(raw, dict):
            raise JobParamsError("params must be an object")
        unknown = set(raw) - PARAM_KEYS
        if unknown:
            raise JobParamsError(f"unknown params: {sorted(unknown)}")
        for key in ("inputPath", "topologyPath", "numWorlds", "decisions"):
            if key not in raw:
                raise JobParamsError(f"missing param {key}")
        num_worlds = int(raw["numWorlds"])
        decisions = int(raw["decisions"])
        if num_worlds <= 0 or decisions <= 0:
            raise JobParamsError("numWorlds and decisions must be positive")
        seeds = raw.get("seeds")
        if seeds is not None:
            seeds = tuple(int(s) for s in seeds)
            if len(seeds) != num_worlds:
                raise JobParamsError("seeds must have numWorlds entries")
        actions = raw.get("actions", "hold")
        if not isinstance(actions, str):
            raise JobParamsError("actions must be 'hold' or a schedule path")
        episode = raw.get("episode")
        if episode is not None and not isinstance(episode, dict):
            raise JobParamsError("episode must be an object")
        return cls(
            input_path=str(raw["inputPath"]), topology_path=str(raw["topologyPath"]), num_worlds=num_worlds,
            episode=episode, decisions=decisions, actions=actions, device=str(raw.get("device", "cuda:0")),
            seeds=seeds, checkpoint_every=int(raw.get("checkpointEveryDecisions", 0)),
            lease_slots=int(raw.get("leaseSlots", 2)),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "inputPath": self.input_path, "topologyPath": self.topology_path, "numWorlds": self.num_worlds,
            "episode": self.episode, "decisions": self.decisions, "actions": self.actions, "device": self.device,
            "seeds": list(self.seeds) if self.seeds is not None else None,
            "checkpointEveryDecisions": self.checkpoint_every, "leaseSlots": self.lease_slots,
        }


def _write_bytes(path: Path, data: bytes) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def _write_json(path: Path, doc: Any) -> None:
    _write_bytes(path, (json.dumps(doc, sort_keys=True, indent=2) + "\n").encode("utf-8"))


def _artifact(out_dir: Path, path: Path) -> dict[str, Any]:
    data = path.read_bytes()
    return {"relativePath": str(path.relative_to(out_dir)), "sha256": hashlib.sha256(data).hexdigest(), "sizeBytes": len(data)}


def _digest(arr: np.ndarray) -> str:
    return hashlib.sha256(np.ascontiguousarray(arr).tobytes()).hexdigest()


class JobRunner:
    def __init__(self, params: JobParams, out_dir: Path, resume: Path | None) -> None:
        self.params = params
        self.out_dir = out_dir
        self.document = json.loads(Path(params.input_path).read_text(encoding="utf-8"))
        self.graph = LaneGraph.load(params.topology_path)
        self.episode = EpisodeConfig.from_document(params.episode)
        self.schedule: list[dict[str, Any]] | None = None
        if params.actions != "hold":
            self.schedule = json.loads(Path(params.actions).read_text(encoding="utf-8"))
            if not isinstance(self.schedule, list) or not self.schedule:
                raise JobParamsError("action schedule must be a non-empty JSON array")
        n = params.num_worlds
        self.returns = np.zeros(n, dtype=np.float64)
        self.lengths = np.zeros(n, dtype=np.int64)
        self.termination = np.zeros(n, dtype=np.int8)  # 0 running, 1 terminated, 2 truncated, 3 horizon
        self.decision = 0
        self.records: list[str] = []
        self._resume = resume
        self._canceled = False
        self._checkpoint_seq = 0
        (out_dir / "checkpoint").mkdir(parents=True, exist_ok=True)
        signal.signal(signal.SIGTERM, self._on_sigterm)

    def _on_sigterm(self, _signum, _frame) -> None:
        self._canceled = True

    @staticmethod
    def emit(event: dict[str, Any]) -> None:
        sys.stdout.write(json.dumps(event, sort_keys=True) + "\n")
        sys.stdout.flush()

    # ------------------------------------------------------------ checkpoint

    def _checkpoint(self, batch: RoadwayGpuBatch) -> None:
        self._checkpoint_seq += 1
        cp = batch.checkpoint()
        path = self.out_dir / "checkpoint" / f"checkpoint-{self.decision:06d}-{self._checkpoint_seq:04d}.npz"
        meta = {
            "workload": WORKLOAD_ID, "params": self.params.to_dict(), "identity": cp.identity(), "decision": self.decision,
            "checkpointSeq": self._checkpoint_seq, "records": self.records,
        }
        buf = io.BytesIO()
        np.savez(buf, __meta__=np.frombuffer(json.dumps(meta, sort_keys=True).encode("utf-8"), dtype=np.uint8),
                 __seeds__=cp.seeds, __returns__=self.returns, __lengths__=self.lengths, __termination__=self.termination,
                 **{f"state.{k}": v for k, v in cp.arrays.items()})
        _write_bytes(path, buf.getvalue())
        self.emit({"event": "checkpoint", "path": str(path)})

    def _restore(self, batch: RoadwayGpuBatch, path: Path) -> None:
        with np.load(path, allow_pickle=False) as data:
            meta = json.loads(bytes(data["__meta__"]).decode("utf-8"))
            if meta.get("params") != self.params.to_dict():
                raise JobParamsError("checkpoint params differ from --params")
            arrays = {k[len("state."):]: data[k] for k in data.files if k.startswith("state.")}
            cp = Checkpoint(
                format=meta["identity"]["format"], profile_id=meta["identity"]["profileId"],
                document_digest=meta["identity"]["documentDigest"], topology_digest=meta["identity"]["topologyDigest"],
                episode_digest=meta["identity"]["episodeDigest"], num_worlds=int(meta["identity"]["numWorlds"]),
                seeds=data["__seeds__"], arrays=arrays,
            )
            self.returns = data["__returns__"].copy()
            self.lengths = data["__lengths__"].copy()
            self.termination = data["__termination__"].copy()
            self.decision = int(meta["decision"])
            self._checkpoint_seq = int(meta["checkpointSeq"])
            self.records = list(meta["records"])
        batch.restore(cp).release()

    # ------------------------------------------------------------------ run

    def run(self) -> None:
        params = self.params
        batch = RoadwayGpuBatch(self.document, self.graph, num_worlds=params.num_worlds, episode=self.episode,
                                device=params.device, seeds=params.seeds, lease_slots=params.lease_slots)
        if self._resume is not None:
            self._restore(batch, self._resume)
        else:
            lease = batch.reset()
            out = lease.numpy()
            lease.release()
            self._record(0, out)
        actions = ActionBatch.hold_choreography(params.num_worlds, batch.device)
        while self.decision < params.decisions and (self.termination == 0).any():
            if self.schedule is not None:
                step_actions = ActionBatch.from_dicts([self.schedule[self.decision % len(self.schedule)]] * params.num_worlds, batch.device)
                import warp as wp

                wp.copy(actions.values, step_actions.values, stream=batch.stream)
                wp.copy(actions.valid, step_actions.valid, stream=batch.stream)
            lease = batch.step(actions)
            out = lease.numpy()
            lease.release()
            self.decision += 1
            running = self.termination == 0
            self.returns[running] += out["reward"][running]
            self.lengths[running] += 1
            self.termination[running & (out["terminated"] == 1)] = 1
            self.termination[running & (out["truncated"] == 1)] = 2
            if self.decision >= params.decisions:
                self.termination[self.termination == 0] = 3
            self._record(self.decision, out)
            ended = int((self.termination != 0).sum())
            if self.decision % PROGRESS_EVERY_DECISIONS == 0 or ended == params.num_worlds:
                self.emit({"event": "progress", "decision": self.decision, "timeS": float(out["t_s"].max()), "worldsEnded": ended})
            unfinished = self.decision < params.decisions and (self.termination == 0).any()
            due = params.checkpoint_every and self.decision % params.checkpoint_every == 0
            if unfinished and (due or self._canceled):
                self._checkpoint(batch)
            if self._canceled:
                if not unfinished:
                    self._write_artifacts(batch)
                raise JobCanceled()
        self.emit({"event": "done", "artifacts": self._write_artifacts(batch)})

    def _record(self, decision: int, out: dict[str, np.ndarray]) -> None:
        self.records.append(json.dumps({
            "decision": decision, "tS": float(out["t_s"].max()),
            "reward": [float(x) for x in out["reward"]], "ended": [int(x) for x in out["ended"]],
            "stateVectorSha256": _digest(out["state_vector"]), "rewardTermsSha256": _digest(out["reward_terms"]),
            "actorStateSha256": _digest(out["actor_state"]),
        }, sort_keys=True))

    def _write_artifacts(self, batch: RoadwayGpuBatch) -> list[dict[str, Any]]:
        causes = {0: "running", 1: "terminated", 2: "truncated", 3: "horizon"}
        rollout = {
            "workload": WORKLOAD_ID, "profileId": PROFILE_ID, "params": self.params.to_dict(), "capabilities": batch.capabilities(),
            "decisions": self.decision,
            "worlds": [
                {"world": w, "seed": int(batch.seeds[w]), "return": float(self.returns[w]), "length": int(self.lengths[w]),
                 "termination": causes[int(self.termination[w])]}
                for w in range(self.params.num_worlds)
            ],
        }
        rollout_path = self.out_dir / "rollout.json"
        _write_json(rollout_path, rollout)
        decisions_path = self.out_dir / "decisions.jsonl.gz"
        _write_bytes(decisions_path, gzip.compress(("\n".join(self.records) + "\n").encode("utf-8"), mtime=0))
        return [_artifact(self.out_dir, rollout_path), _artifact(self.out_dir, decisions_path)]


def run_job(params_path: str, out_dir: str, resume_path: str | None) -> int:
    def fail(code: str, message: str, status: int) -> int:
        sys.stderr.write(json.dumps({"event": "error", "code": code, "message": message}, sort_keys=True) + "\n")
        sys.stderr.flush()
        return status

    try:
        with open(params_path, encoding="utf-8") as fh:
            params = JobParams.parse(json.load(fh))
        runner = JobRunner(params, Path(out_dir), Path(resume_path) if resume_path else None)
    except (JobParamsError, OSError, ValueError, KeyError) as exc:
        return fail("bad-params", str(exc), 1)
    try:
        runner.run()
    except JobCanceled:
        runner.emit({"event": "canceled"})
        return 130
    except JobParamsError as exc:
        return fail("bad-params", str(exc), 1)
    except ProfileAdmissionError as exc:
        code = "capacity" if all(i.code == "capacity_exceeded" for i in exc.issues) else "admission"
        return fail(code, str(exc), 2)
    except BackendUnavailableError as exc:
        return fail("backend", str(exc), 2)
    except GpuBatchError as exc:
        return fail("backend", str(exc), 2)
    return 0
