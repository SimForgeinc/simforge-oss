"""``python -m simforge_oss_gym job``: the runner-facing workload
``simforge.policy-episodes/v1`` (native roadway policy episodes).

Protocol (shared with every Python provider the durable runner supervises):

- ``--params p.json``: ``{"specPath": str, "session": int, "policy":
  "scripted"|"trajectory", "policySeed": int, "seeds": [int|str],
  "steps": int, "deadlineMs": float|null, "fallback": "repeat-last"|"zero-control"|"scripted",
  "execution": "pure-pursuit"|"speed-setpoint", "forceMissAt": [int],
  "decisionHz": int|null, "mapsDir": str|null, "checkpointEveryDecisions": int}``;
  unknown or missing keys are rejected (all keys required; use ``null`` where optional).
- ``--out-dir``: receives ``episodes.json`` (per-seed summaries),
  ``trace.<index>.jsonl`` per episode (digest-chained policy trace) and
  ``checkpoint/checkpoint-<n>.json``.
- ``--resume checkpoint.json``: retain completed episodes and restart the
  interrupted episode from its seed. Checkpoints are episode-boundary receipts;
  an in-flight kernel Episode is never reconstructed in a second host loop.
- stdout JSON lines: ``progress``, ``checkpoint``, ``done`` (with artifacts) or
  ``canceled``; stderr JSON line ``error``.
- exit 0 done, 1 bad params/resume, 2 engine/schema failure, 130 after SIGTERM
  (current decision finished, checkpoint written).
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..episodes import load_episode_spec
from ..native import ENGINE_HZ, ENGINE_VERSION, NativeError, EngineError, SchemaError
from .policies import make_policy
from .policy_runner import _Cancellation, run_episode

PARAM_KEYS = {
    "specPath", "session", "policy", "policySeed", "seeds", "steps", "deadlineMs", "fallback", "execution",
    "forceMissAt", "decisionHz", "mapsDir", "checkpointEveryDecisions",
}
PROGRESS_EVERY_DECISIONS = 50
WORKLOAD_ID = "simforge.policy-episodes/v1"


class JobParamsError(ValueError):
    pass


class JobCanceled(Exception):
    pass


@dataclass(frozen=True)
class JobParams:
    spec_path: str
    session: int
    policy: str
    policy_seed: int
    seeds: tuple[int | str, ...]
    steps: int
    deadline_ms: float | None
    fallback: str
    execution: str
    force_miss_at: tuple[int, ...]
    decision_hz: int | None
    maps_dir: str | None
    checkpoint_every: int

    @classmethod
    def parse(cls, doc: Any) -> "JobParams":
        if not isinstance(doc, dict) or set(doc) != PARAM_KEYS:
            raise JobParamsError(f"params must be an object with exactly the keys {sorted(PARAM_KEYS)}")
        if doc["policy"] not in ("scripted", "trajectory"):
            raise JobParamsError("policy must be scripted or trajectory")
        if doc["fallback"] not in ("repeat-last", "zero-control", "scripted"):
            raise JobParamsError("fallback must be repeat-last, zero-control or scripted")
        if doc["execution"] not in ("pure-pursuit", "speed-setpoint"):
            raise JobParamsError("execution must be pure-pursuit or speed-setpoint")
        seeds = tuple(doc["seeds"])
        if not seeds or not all(isinstance(s, (int, str)) and not isinstance(s, bool) for s in seeds):
            raise JobParamsError("seeds must be a non-empty list of ints or strings")
        if int(doc["steps"]) <= 0 or int(doc["checkpointEveryDecisions"]) <= 0:
            raise JobParamsError("steps and checkpointEveryDecisions must be positive")
        return cls(
            spec_path=str(doc["specPath"]),
            session=int(doc["session"]),
            policy=str(doc["policy"]),
            policy_seed=int(doc["policySeed"]),
            seeds=seeds,
            steps=int(doc["steps"]),
            deadline_ms=None if doc["deadlineMs"] is None else float(doc["deadlineMs"]),
            fallback=str(doc["fallback"]),
            execution=str(doc["execution"]),
            force_miss_at=tuple(int(v) for v in doc["forceMissAt"]),
            decision_hz=None if doc["decisionHz"] is None else int(doc["decisionHz"]),
            maps_dir=None if doc["mapsDir"] is None else str(doc["mapsDir"]),
            checkpoint_every=int(doc["checkpointEveryDecisions"]),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "specPath": self.spec_path, "session": self.session, "policy": self.policy, "policySeed": self.policy_seed,
            "seeds": list(self.seeds), "steps": self.steps, "deadlineMs": self.deadline_ms, "fallback": self.fallback,
            "execution": self.execution, "forceMissAt": list(self.force_miss_at), "decisionHz": self.decision_hz,
            "mapsDir": self.maps_dir, "checkpointEveryDecisions": self.checkpoint_every,
        }


def _write_json(path: Path, doc: Any) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(doc, sort_keys=True, separators=(",", ":")))
    os.replace(tmp, path)


def _artifact(out_dir: Path, path: Path) -> dict[str, Any]:
    data = path.read_bytes()
    return {"relativePath": str(path.relative_to(out_dir)), "sha256": hashlib.sha256(data).hexdigest(), "sizeBytes": len(data)}


class JobRunner:
    def __init__(self, params: JobParams, out_dir: Path, resume: dict[str, Any] | None) -> None:
        self.params = params
        self.out_dir = out_dir
        self.completed: list[dict[str, Any]] = []
        self.episode_index = 0
        if resume is not None:
            if resume.get("params") != params.to_dict():
                raise JobParamsError("checkpoint params differ from --params")
            if resume.get("schema") != "simforge.episode-job-checkpoint/v2":
                raise JobParamsError("checkpoint predates kernel Episode; start a new job")
            self.completed = list(resume["completed"])
            self.episode_index = int(resume["episodeIndex"])
        self._cancellation = _Cancellation()
        self._checkpoint_seq = 0
        (out_dir / "checkpoint").mkdir(parents=True, exist_ok=True)
        self.loaded = load_episode_spec(params.spec_path, maps_dir=params.maps_dir)

    @staticmethod
    def emit(event: dict[str, Any]) -> None:
        sys.stdout.write(json.dumps(event, sort_keys=True) + "\n")
        sys.stdout.flush()

    def _checkpoint(self, decision: int) -> None:
        self._checkpoint_seq += 1
        path = self.out_dir / "checkpoint" / f"checkpoint-{self.episode_index:04d}-{decision:06d}-{self._checkpoint_seq:04d}.json"
        _write_json(path, {"schema": "simforge.episode-job-checkpoint/v2",
                          "params": self.params.to_dict(), "episodeIndex": self.episode_index,
                          "completed": self.completed})
        self.emit({"event": "checkpoint", "path": str(path)})

    def _decision(self, decision: int) -> None:
        if decision % PROGRESS_EVERY_DECISIONS == 0:
            self.emit({"event": "progress", "episodeIndex": self.episode_index,
                       "step": decision, "steps": self.params.steps})
        if decision % self.params.checkpoint_every == 0:
            self._checkpoint(decision)

    def run(self) -> None:
        params = self.params
        self._cancellation.install()
        try:
            for index in range(self.episode_index, len(params.seeds)):
                self.episode_index = index
                if self._cancellation.requested:
                    self._checkpoint(0)
                    raise JobCanceled()
                trace_path = self.out_dir / f"trace.{index:04d}.jsonl"
                # Interrupted evidence remains immutable when the same seed is
                # restarted; completed episodes are never replayed on resume.
                for old in (trace_path, trace_path.with_suffix(".episode-v2.jsonl")):
                    if old.exists():
                        old.rename(old.with_name(f"{old.name}.interrupted-{time.time_ns()}"))
                summary = run_episode(
                    self.loaded.episodes[params.session], make_policy(params.policy),
                    seed=params.seeds[index], session=params.session,
                    episode_config=self.loaded.episode_config, decision_hz=params.decision_hz,
                    mode="offline-simtime" if params.deadline_ms is None else "realtime",
                    deadline_ms=params.deadline_ms, fallback=params.fallback, execution=params.execution,
                    max_steps=params.steps, force_miss_at=params.force_miss_at, trace_path=trace_path,
                    cancellation=self._cancellation, on_decision=self._decision,
                )
                if summary.cancelled:
                    self._checkpoint(summary.steps)
                    raise JobCanceled()
                self.completed.append({**summary.__dict__, "trace": trace_path.name})
                self.episode_index = index + 1
                _write_json(self.out_dir / "episodes.json", self.completed)
                self._checkpoint(0)
                self.emit({"event": "progress", "episodeIndex": self.episode_index, "episodes": len(params.seeds)})
        finally:
            self._cancellation.restore()
        artifacts = [_artifact(self.out_dir, self.out_dir / "episodes.json")]
        for index in range(len(params.seeds)):
            path = self.out_dir / f"trace.{index:04d}.jsonl"
            artifacts.extend(_artifact(self.out_dir, item) for item in (path, path.with_suffix(".episode-v2.jsonl")))
        self.emit({"event": "done", "artifacts": artifacts})


def capabilities(*, probe: bool = True) -> dict[str, Any]:
    """Provider capability report; its canonical hash is part of job identity."""
    from ..profiles import available_profiles

    report: dict[str, Any] = {
        "provider": "simforge-oss-gym",
        "workloads": [WORKLOAD_ID],
        "engineVersion": ENGINE_VERSION,
        "engineHz": ENGINE_HZ,
        "policies": ["scripted", "trajectory"],
        "profiles": available_profiles(),
    }
    if probe:
        try:
            import torch

            report["torch"] = torch.__version__
        except ImportError:
            report["torch"] = None
    return report


def run_job(params_path: str, out_dir: str, resume_path: str | None) -> int:
    def fail(code: str, message: str, status: int) -> int:
        sys.stderr.write(json.dumps({"event": "error", "code": code, "message": message}, sort_keys=True) + "\n")
        sys.stderr.flush()
        return status

    try:
        params = JobParams.parse(json.loads(Path(params_path).read_text()))
        resume = json.loads(Path(resume_path).read_text()) if resume_path else None
        runner = JobRunner(params, Path(out_dir), resume)
    except (JobParamsError, OSError, ValueError, KeyError, SchemaError) as exc:
        return fail("bad-params", str(exc), 1)
    except (EngineError, NativeError) as exc:
        return fail("engine", str(exc), 2)
    try:
        runner.run()
    except JobCanceled:
        runner.emit({"event": "canceled"})
        return 130
    except (EngineError, SchemaError, NativeError) as exc:
        return fail("engine", str(exc), 2)
    return 0


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(prog="python -m simforge_oss_gym")
    sub = parser.add_subparsers(dest="command", required=True)
    job = sub.add_parser("job", help=f"run the {WORKLOAD_ID} workload for the durable runner")
    job.add_argument("--params", required=True)
    job.add_argument("--out-dir", required=True)
    job.add_argument("--resume", default=None)
    caps = sub.add_parser("capabilities", help="print the provider capability report as JSON")
    caps.add_argument("--no-probe", action="store_true", help="skip optional dependency probes")
    args = parser.parse_args(argv)
    if args.command == "job":
        return run_job(args.params, args.out_dir, args.resume)
    print(json.dumps(capabilities(probe=not args.no_probe), sort_keys=True))
    return 0
