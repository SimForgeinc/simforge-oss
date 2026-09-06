"""Episode runner: seeded policy episodes with a digested JSONL trace.

Each trace line carries the deterministic step record plus a ``digest``, a
SHA-256 chained over the canonical JSON of every deterministic record so far.
Wall-clock timing (``timing``) is *excluded* from the digest: two runs with the
same seed, policy and forced misses produce identical digests even though
inference latency varies.

Digest-covered per step: the policy action ``a`` (trajectory points included),
the policy's ``reasoning`` text, ``ex`` (the executor's telemetry: pose, signed
cross-track error, applied setpoints, preview point; ``None`` on non-trajectory
steps or speed-setpoint execution), the deadline verdict, reward, flags, the
state vector and reward terms, and the perceived object ids.

Deadline misses are exercised deterministically: ``force_miss_at`` steps report
a fixed elapsed time of 4x the deadline instead of the measured one, so the
fallback path is part of the digested dynamics.

    simforge-oss-policy-runner --spec tests/fixtures/synthetic-episode-dynamic.json \
        --policy torch --seed 42 --policy-seed 7 --steps 30 --deadline-ms 50 \
        --fallback zero-control --force-miss-at 9 --out /tmp/trace.jsonl
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping

import numpy as np

from ..env import SimForgeEnv
from ..policy import Decision, PolicyRunner
from .policies import Policy, make_policy


def _canonical(record: Mapping[str, Any]) -> bytes:
    return json.dumps(record, sort_keys=True, separators=(",", ":")).encode()


def _percentiles(samples: list[float]) -> dict[str, float]:
    if not samples:
        return {"p50": 0.0, "p95": 0.0, "max": 0.0}
    data = np.asarray(samples)
    return {"p50": round(float(np.percentile(data, 50)), 4), "p95": round(float(np.percentile(data, 95)), 4), "max": round(float(data.max()), 4)}


def _step_record(observation: Mapping[str, np.ndarray], info: Mapping[str, Any]) -> dict[str, Any]:
    state = observation["state_vector"]
    terms = info["reward_terms"]
    return {
        "t": info["t_s"],
        "sv_sha256": hashlib.sha256(np.ascontiguousarray(state, dtype="<f8").tobytes()).hexdigest(),
        "sv": [float(v) for v in state],
        "terms": [terms["progress"], terms["proximity"], terms["comfort"]],
        "objs": list(info["object_ids"]),
    }


@dataclass
class EpisodeSummary:
    policy: str
    policy_checkpoint: str
    seed: int | str
    session: int
    steps: int
    deadline_misses: int
    episode_digest: str
    terminated: bool
    truncated: bool
    infer_ms: dict[str, float] = field(default_factory=dict)
    step_ms: dict[str, float] = field(default_factory=dict)
    cross_track_m: dict[str, float] = field(default_factory=dict)


def run_episode(
    env: SimForgeEnv,
    policy: Policy,
    *,
    seed: int | str,
    deadline_ms: float = 50.0,
    fallback: str = "repeat-last",
    execution: str = "pure-pursuit",
    max_steps: int = 30,
    force_miss_at: tuple[int, ...] = (),
    trace_path: str | Path | None = None,
) -> EpisodeSummary:
    runner = PolicyRunner(env, deadline_ms=deadline_ms, fallback=fallback, execution=execution)
    observation, info = runner.reset(seed)

    chain = hashlib.sha256()
    reset_record = {
        "reset": {
            **_step_record(observation, info),
            "seed": seed,
            "session": env.session_index,
            "deadline_ms": deadline_ms,
            "fallback": fallback,
            "execution": runner.execution,
            "policy": policy.name,
        }
    }
    chain.update(_canonical(reset_record))

    lines = [json.dumps({**reset_record, "digest": chain.hexdigest()}, sort_keys=True)]
    infer_samples: list[float] = []
    step_samples: list[float] = []
    cross_track_samples: list[float] = []
    misses = 0
    terminated = truncated = False
    steps_done = 0

    for step in range(max_steps):
        t0 = time.perf_counter()
        decision = policy.act(step, observation["state_vector"])
        infer_ms = (time.perf_counter() - t0) * 1000.0
        reported_ms = deadline_ms * 4.0 if step in force_miss_at else infer_ms

        t1 = time.perf_counter()
        result: Decision = runner.act(decision.action, elapsed_ms=reported_ms)
        step_ms = (time.perf_counter() - t1) * 1000.0

        observation, info = result.observation, result.info
        misses += result.deadline_miss
        terminated, truncated = result.terminated, result.truncated
        steps_done = step + 1
        infer_samples.append(infer_ms)
        step_samples.append(step_ms)
        if result.executor is not None:
            cross_track_samples.append(abs(float(result.executor["crossTrackErrorM"])))

        deterministic = {
            "step": step,
            "a": decision.action,
            "reasoning": decision.reasoning,
            "ex": result.executor,
            "miss": int(result.deadline_miss),
            "applied": result.applied,
            "rw": result.reward,
            "term": int(terminated),
            "trunc": int(truncated),
            **_step_record(observation, info),
        }
        chain.update(_canonical(deterministic))
        lines.append(
            json.dumps({**deterministic, "digest": chain.hexdigest(), "timing": {"infer_ms": round(infer_ms, 4), "step_ms": round(step_ms, 4)}}, sort_keys=True)
        )
        if terminated or truncated:
            break

    summary = EpisodeSummary(
        policy=policy.name,
        policy_checkpoint=policy.checkpoint_digest,
        seed=seed,
        session=env.session_index,
        steps=steps_done,
        deadline_misses=misses,
        episode_digest=chain.hexdigest(),
        terminated=terminated,
        truncated=truncated,
        infer_ms=_percentiles(infer_samples),
        step_ms=_percentiles(step_samples),
        cross_track_m=_percentiles(cross_track_samples),
    )
    lines.append(json.dumps({"summary": summary.__dict__}, sort_keys=True))
    if trace_path is not None:
        Path(trace_path).write_text("\n".join(lines) + "\n")
    return summary


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="simforge-oss-policy-runner")
    parser.add_argument("--spec", required=True, help="episode spec JSON")
    parser.add_argument("--session", type=int, default=0, help="episode index inside the spec")
    parser.add_argument("--policy", choices=("scripted", "trajectory", "torch"), default="scripted")
    parser.add_argument("--seed", default="42", help="episode seed (int or string)")
    parser.add_argument("--policy-seed", type=int, default=0, help="torch weight seed")
    parser.add_argument("--steps", type=int, default=30)
    parser.add_argument("--deadline-ms", type=float, default=50.0)
    parser.add_argument("--fallback", choices=("repeat-last", "zero-control", "scripted"), default="repeat-last")
    parser.add_argument("--execution", choices=("pure-pursuit", "speed-setpoint"), default="pure-pursuit")
    parser.add_argument("--force-miss-at", type=int, action="append", default=[], help="step index whose elapsed time is forced over the deadline (repeatable)")
    parser.add_argument("--decision-hz", type=int, default=None)
    parser.add_argument("--maps-dir", default=None, help="installed map corpus root (default: SIMFORGE_MAPS_CACHE_ROOT layout)")
    parser.add_argument("--out", default=None, help="trace JSONL path")
    args = parser.parse_args(argv)

    seed: int | str = int(args.seed) if args.seed.lstrip("-").isdigit() else args.seed
    policy = make_policy(args.policy, args.policy_seed)
    with SimForgeEnv(args.spec, session=args.session, decision_hz=args.decision_hz, maps_dir=args.maps_dir) as env:
        summary = run_episode(
            env,
            policy,
            seed=seed,
            deadline_ms=args.deadline_ms,
            fallback=args.fallback,
            execution=args.execution,
            max_steps=args.steps,
            force_miss_at=tuple(args.force_miss_at),
            trace_path=args.out,
        )
    json.dump(summary.__dict__, sys.stdout, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
