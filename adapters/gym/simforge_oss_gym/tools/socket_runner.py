"""Seeded policy episodes over ``simforge env serve`` (the socket gym path).

The socket counterpart of ``simforge-oss-policy-runner``: the same reference
policies that act with ``control`` rows (``scripted``, ``torch``), the same
digested JSONL trace (a SHA-256 chained over the canonical JSON of every
deterministic record, wall-clock timing excluded), against an episode server
instead of the in-process ``_native`` session. Trajectory policies need the
native pure-pursuit executor and are refused here, not approximated.

    simforge env serve ws/ --socket /tmp/sf.sock --no-sensors &
    python -m simforge_oss_gym.tools.socket_runner --socket /tmp/sf.sock \\
        --policy scripted --seed 42 --steps 30 --out /tmp/trace.jsonl

stdout: one JSON summary ``{schema, steps, digest, ...}``; exit 1 on a
server error, 0 otherwise.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path
from typing import Any

import numpy as np

from ..socket_env import EnvServeError, SimForgeSocketEnv
from .policies import make_policy

SCHEMA = "simforge.socket-policy-trace/v1"


def _canonical(record: dict[str, Any]) -> bytes:
    return json.dumps(record, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def _sv_digest(state: np.ndarray) -> str:
    return hashlib.sha256(np.ascontiguousarray(state, dtype="<f8").tobytes()).hexdigest()


def run(socket: str, policy_name: str, seed: int | float | str, steps: int, policy_seed: int = 0, out: str | None = None) -> dict[str, Any]:
    policy = make_policy(policy_name, seed=policy_seed)
    env = SimForgeSocketEnv(socket, action_mode="control", info_channel=False)
    chain = hashlib.sha256()
    lines: list[str] = []
    try:
        obs, info = env.reset(seed=seed)
        reset = {"k": "reset", "seed": seed, "sv_sha256": _sv_digest(obs["state_vector"]), "t_s": info["t_s"]}
        chain.update(_canonical(reset))
        lines.append(json.dumps({**reset, "digest": chain.hexdigest()}))
        taken = 0
        for step in range(steps):
            decision = policy.act(step, obs["state_vector"])
            action = decision.action
            if action.get("kind") != "control":
                raise ValueError(f"policy {policy_name!r} acts with {action.get('kind')!r} actions; the socket runner drives control rows only")
            started = time.perf_counter()
            obs, reward, terminated, truncated, info = env.step([action["throttle"], action["brake"], action["steer"]])
            elapsed_ms = (time.perf_counter() - started) * 1000.0
            record = {
                "k": "step",
                "step": step,
                "a": action,
                "reward": reward,
                "terminated": terminated,
                "truncated": truncated,
                "t_s": info["t_s"],
                "sv_sha256": _sv_digest(obs["state_vector"]),
                "objects": info["object_ids"],
                "reward_terms": info["reward_terms"],
            }
            chain.update(_canonical(record))
            lines.append(json.dumps({**record, "digest": chain.hexdigest(), "timing": {"stepMs": elapsed_ms}}))
            taken += 1
            if terminated or truncated:
                break
    finally:
        env.close()
    if out:
        Path(out).write_text("\n".join(lines) + "\n")
    return {
        "schema": SCHEMA,
        "socket": socket,
        "policy": policy_name,
        "policyDigest": policy.checkpoint_digest,
        "seed": seed,
        "steps": taken,
        "digest": chain.hexdigest(),
        "trace": out,
    }


def _seed(text: str) -> int | float | str:
    for cast in (int, float):
        try:
            return cast(text)
        except ValueError:
            pass
    return text


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--socket", required=True, help="simforge env serve socket")
    parser.add_argument("--policy", default="scripted", choices=("scripted", "torch"))
    parser.add_argument("--policy-seed", type=int, default=0)
    parser.add_argument("--seed", default="42", help="episode seed (int, float or string)")
    parser.add_argument("--steps", type=int, default=30)
    parser.add_argument("--out", default=None, help="trace JSONL path")
    args = parser.parse_args(argv)
    try:
        summary = run(args.socket, args.policy, _seed(args.seed), args.steps, args.policy_seed, args.out)
    except EnvServeError as error:
        print(json.dumps({"code": error.code, "reason": error.reason, "detail": error.detail}), file=sys.stderr)
        return 1
    print(json.dumps(summary))
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
