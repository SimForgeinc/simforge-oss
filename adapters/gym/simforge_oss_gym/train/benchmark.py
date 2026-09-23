"""Measure real native state+objects decisions, excluding NEXT_STEP reset rows."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import time
from pathlib import Path

import numpy as np

from ..episodes import load_episode_spec
from ..native import ABI_VERSION, ENGINE_VERSION
from ..vector import SimForgeVectorEnv


def main() -> None:
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument('--spec', required=True)
    parser.add_argument('--out', required=True)
    parser.add_argument('--seconds', type=float, default=5)
    parser.add_argument('--repeats', type=int, default=3)
    parser.add_argument('--threads', type=int, default=8)
    args = parser.parse_args()
    spec = load_episode_spec(args.spec)
    rows = []
    for n in (1, 8, 32, 64):
        episodes = [spec.episodes[i % len(spec.episodes)] for i in range(n)]
        with SimForgeVectorEnv(episodes=episodes, threads=min(n, args.threads), decision_hz=10, bev=False, info_channel=False) as env:
            actions = np.tile([6.0, 0.0], (n, 1))
            samples = []
            for repeat in range(args.repeats):
                env.reset(seed=0)
                pending = np.zeros(n, dtype=bool)
                for _ in range(30):
                    _, _, term, trunc, _ = env.step(actions)
                    pending = term | trunc
                decisions = 0
                calls = 0
                began = time.perf_counter()
                while time.perf_counter() - began < args.seconds:
                    decisions += int((~pending).sum())
                    _, _, term, trunc, _ = env.step(actions)
                    pending = term | trunc
                    calls += 1
                elapsed = time.perf_counter() - began
                samples.append({'decisions': decisions, 'seconds': elapsed, 'env_steps_per_s': decisions / elapsed, 'batch_calls': calls})
            row = {'num_envs': n, 'threads': min(n, args.threads), 'median_env_steps_per_s': float(np.median([x['env_steps_per_s'] for x in samples])), 'samples': samples}
            rows.append(row)
            print(json.dumps(row), flush=True)
    result = {'host': platform.node(), 'cpu': platform.processor(), 'logical_cpus': os.cpu_count(), 'engine_version': ENGINE_VERSION, 'binding_abi': ABI_VERSION, 'observation': 'native state(10)+objects(64,5), BEV disabled', 'decision_hz': 10, 'physics_hz': 50, 'action': [6.0, 0.0], 'mode': 'setpoint', 'info_channel': False, 'spec': str(Path(args.spec).resolve()), 'spec_sha256': hashlib.sha256(Path(args.spec).read_bytes()).hexdigest(), 'rows': rows}
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, indent=2) + '\n')


if __name__ == '__main__':
    main()
