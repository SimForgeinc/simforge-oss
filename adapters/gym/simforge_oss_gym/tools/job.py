"""``python -m simforge_oss_gym job``: the runner-facing workload
``simforge.policy-episodes/v1`` (native roadway policy episodes).

Protocol (shared with every Python provider the durable runner supervises):

- ``--params p.json``: ``{"specPath": str, "session": int, "policy":
  "scripted"|"trajectory"|"torch", "policySeed": int, "seeds": [int|str],
  "steps": int, "deadlineMs": float|null, "fallback": "repeat-last"|"zero-control"|"scripted",
  "execution": "pure-pursuit"|"speed-setpoint", "forceMissAt": [int],
  "decisionHz": int|null, "mapsDir": str|null, "checkpointEveryDecisions": int}``;
  unknown or missing keys are rejected (all keys required; use ``null`` where optional).
- ``--out-dir``: receives ``episodes.json`` (per-seed summaries),
  ``trace.<index>.jsonl`` per episode (digest-chained policy trace) and
  ``checkpoint/checkpoint-<n>.json``.
- ``--resume checkpoint.json``: continue from a checkpoint written by this command
  (completed episodes plus the in-progress episode's native ``EnvSession``
  checkpoint, trace lines and digest chain).
- stdout JSON lines: ``progress``, ``checkpoint``, ``done`` (with artifacts) or
  ``canceled``; stderr JSON line ``error``.
- exit 0 done, 1 bad params/resume, 2 engine/schema failure, 130 after SIGTERM
  (current decision finished, checkpoint written).
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import signal
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..env import SimForgeEnv
from ..native import ENGINE_HZ, ENGINE_VERSION, NativeError, EngineError, SchemaError
from ..policy import PolicyRunner
from .policies import Policy, make_policy
from .policy_runner import _canonical, _percentiles, _step_record

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
        if doc["policy"] not in ("scripted", "trajectory", "torch"):
            raise JobParamsError("policy must be scripted, trajectory or torch")
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


def _write_text(path: Path, text: str) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text)
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
        #: In-progress episode state restored from a checkpoint, consumed by `run`.
        self.resume_state: dict[str, Any] | None = None
        if resume is not None:
            if resume.get("params") != params.to_dict():
                raise JobParamsError("checkpoint params differ from --params")
            self.completed = list(resume["completed"])
            self.episode_index = int(resume["episodeIndex"])
            self.resume_state = resume.get("inProgress")
        self._canceled = False
        self._checkpoint_seq = 0
        (out_dir / "checkpoint").mkdir(parents=True, exist_ok=True)
        signal.signal(signal.SIGTERM, self._on_sigterm)
        # Policies are reconstructed deterministically from their seed; scripted
        # trajectory policies are pure functions of the step index.
        self.policy: Policy = make_policy(params.policy, params.policy_seed)
        self.env = SimForgeEnv(params.spec_path, session=params.session, decision_hz=params.decision_hz, maps_dir=params.maps_dir)

    def _on_sigterm(self, _signum: int, _frame: Any) -> None:
        self._canceled = True

    @staticmethod
    def emit(event: dict[str, Any]) -> None:
        sys.stdout.write(json.dumps(event, sort_keys=True) + "\n")
        sys.stdout.flush()

    def _checkpoint(self, in_progress: dict[str, Any] | None, decision: int) -> None:
        self._checkpoint_seq += 1
        path = self.out_dir / "checkpoint" / f"checkpoint-{self.episode_index:04d}-{decision:06d}-{self._checkpoint_seq:04d}.json"
        _write_json(path, {"params": self.params.to_dict(), "episodeIndex": self.episode_index, "completed": self.completed, "inProgress": in_progress})
        self.emit({"event": "checkpoint", "path": str(path)})

    def run(self) -> None:
        params = self.params
        runner = PolicyRunner(self.env, deadline_ms=params.deadline_ms, fallback=params.fallback, execution=params.execution)
        while self.episode_index < len(params.seeds):
            seed = params.seeds[self.episode_index]
            trace_path = self.out_dir / f"trace.{self.episode_index:04d}.jsonl"
            self._run_episode(runner, seed, trace_path)
            self.episode_index += 1
            self.resume_state = None
            _write_json(self.out_dir / "episodes.json", self.completed)
            self.emit({"event": "progress", "episodeIndex": self.episode_index, "episodes": len(params.seeds)})
            if self._canceled and self.episode_index < len(params.seeds):
                self._checkpoint(None, 0)
                raise JobCanceled()
        artifacts = [_artifact(self.out_dir, self.out_dir / "episodes.json")]
        artifacts += [_artifact(self.out_dir, self.out_dir / f"trace.{i:04d}.jsonl") for i in range(len(params.seeds))]
        self.emit({"event": "done", "artifacts": artifacts})

    def _run_episode(self, runner: PolicyRunner, seed: int | str, trace_path: Path) -> None:
        params = self.params
        chain = hashlib.sha256()
        misses = 0
        infer_samples: list[float] = []
        cross_track: list[float] = []
        terminated = truncated = False

        if self.resume_state is not None and self.resume_state["seed"] == seed:
            state = self.resume_state
            # The checkpoint carries the env continuation state and the executor's held plan;
            # the host-side policy is replayed over the completed steps (pure function of step index).
            observation, _ = runner.restore(base64.b64decode(state["envCheckpoint"]))
            self.policy = make_policy(params.policy, params.policy_seed)
            for step in range(state["step"]):
                self.policy.act(step, None)
            lines: list[str] = list(state["lines"])
            chain = _rebuild_chain(lines)
            start = int(state["step"])
            misses = int(state["misses"])
            infer_samples = list(state["inferMs"])
            cross_track = list(state["crossTrackM"])
        else:
            observation, info = runner.reset(seed)
            reset_record = {"reset": {**_step_record(observation, info), "seed": seed, "session": self.env.session_index, "deadline_ms": params.deadline_ms, "fallback": params.fallback, "execution": runner.execution, "policy": self.policy.name}}
            chain.update(_canonical(reset_record))
            lines = [json.dumps({**reset_record, "digest": chain.hexdigest()}, sort_keys=True)]
            start = 0

        steps_done = start
        for step in range(start, params.steps):
            t0 = time.perf_counter()
            decision = self.policy.act(step, observation["state_vector"])
            infer_ms = (time.perf_counter() - t0) * 1000.0
            reported = (params.deadline_ms or 0.0) * 4.0 if step in params.force_miss_at else infer_ms
            result = runner.act(decision.action, elapsed_ms=reported)
            observation = result.observation
            misses += result.deadline_miss
            terminated, truncated = result.terminated, result.truncated
            steps_done = step + 1
            infer_samples.append(infer_ms)
            if result.executor is not None:
                cross_track.append(abs(float(result.executor["crossTrackErrorM"])))
            deterministic = {
                "step": step, "a": decision.action, "reasoning": decision.reasoning, "ex": result.executor, "miss": int(result.deadline_miss),
                "applied": result.applied, "rw": result.reward, "term": int(terminated), "trunc": int(truncated), **_step_record(observation, result.info),
            }
            chain.update(_canonical(deterministic))
            lines.append(json.dumps({**deterministic, "digest": chain.hexdigest(), "timing": {"infer_ms": round(infer_ms, 4)}}, sort_keys=True))
            if steps_done % PROGRESS_EVERY_DECISIONS == 0:
                self.emit({"event": "progress", "episodeIndex": self.episode_index, "step": steps_done, "steps": params.steps})
            done = terminated or truncated
            if not done and (steps_done % params.checkpoint_every == 0 or self._canceled):
                self._checkpoint(
                    {"seed": seed, "step": steps_done, "envCheckpoint": base64.b64encode(runner.checkpoint()).decode(), "lines": lines, "misses": misses, "inferMs": infer_samples, "crossTrackM": cross_track},
                    steps_done,
                )
                if self._canceled:
                    _write_text(trace_path, "\n".join(lines) + "\n")
                    raise JobCanceled()
            if done:
                break

        summary = {
            "policy": self.policy.name, "policy_checkpoint": self.policy.checkpoint_digest, "seed": seed, "session": self.env.session_index,
            "steps": steps_done, "deadline_misses": misses, "episode_digest": chain.hexdigest(), "terminated": terminated, "truncated": truncated,
            "infer_ms": _percentiles(infer_samples), "cross_track_m": _percentiles(cross_track),
        }
        lines.append(json.dumps({"summary": summary}, sort_keys=True))
        _write_text(trace_path, "\n".join(lines) + "\n")
        self.completed.append({**summary, "trace": trace_path.name})


def _rebuild_chain(lines: list[str]) -> "hashlib._Hash":
    """Recompute the digest chain from the persisted trace lines (digest/timing excluded)."""
    chain = hashlib.sha256()
    for line in lines:
        record = json.loads(line)
        record.pop("digest", None)
        record.pop("timing", None)
        chain.update(_canonical(record))
    return chain


def capabilities(*, probe: bool = True) -> dict[str, Any]:
    """Provider capability report; its canonical hash is part of job identity."""
    from ..profiles import available_profiles

    report: dict[str, Any] = {
        "provider": "simforge-oss-gym",
        "workloads": [WORKLOAD_ID],
        "engineVersion": ENGINE_VERSION,
        "engineHz": ENGINE_HZ,
        "policies": ["scripted", "trajectory", "torch"],
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
