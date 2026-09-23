#!/usr/bin/env python3
"""Publish frozen EpisodeBatch scaling workloads using TrainViz's timing method."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]


def check_floors(workloads: list[dict], minimum: float) -> list[str]:
    failures = []
    for workload in workloads:
        row = next((row for row in workload['rows'] if row['num_envs'] == 64), None)
        rate = row['median_env_steps_per_s'] if row else None
        if rate is None or not rate >= minimum:
            failures.append(f"{workload['id']}: 64-env decisions/s {rate!r} < {minimum:g}")
    return failures


def main() -> int:
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument('--out', type=Path, default=ROOT / 'docs/engineering/benchmarks/state-throughput.json')
    parser.add_argument('--runner-class', default='local')
    args = parser.parse_args()
    if args.out.suffix != '.json':
        parser.error('--out must end in .json; its .md sibling is emitted too')

    from simforge_oss_gym import _native
    from simforge_oss_gym.episodes import map_dir
    from simforge_oss_gym.train import benchmark

    suite_bytes = (HERE / 'suite.json').read_bytes()
    suite = json.loads(suite_bytes)
    topology = map_dir(suite['mapId']) / 'topology-index.json.gz'
    topology_sha = hashlib.sha256(topology.read_bytes()).hexdigest()
    if topology_sha != suite['topologySha256']:
        raise RuntimeError(f'{topology}: map topology differs from the pinned benchmark suite')
    sha = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    cpuinfo = Path('/proc/cpuinfo')
    cpu = next((line.split(':', 1)[1].strip() for line in cpuinfo.read_text().splitlines()
                if line.startswith('model name')), platform.processor()) if cpuinfo.exists() else platform.processor()
    hardware = {
        'host': platform.node(), 'cpu': cpu, 'logical_cpus': os.cpu_count(),
        'affinity_cpus': len(os.sched_getaffinity(0)) if hasattr(os, 'sched_getaffinity') else None,
        'os': platform.platform(), 'architecture': platform.machine(),
        'runner_class': args.runner_class,
        'load_average_at_start': list(os.getloadavg()) if hasattr(os, 'getloadavg') else None,
    }
    result = {
        'schema': 'simforge.state-throughput/v2', 'measured_at': datetime.now(timezone.utc).isoformat(),
        'git_sha': sha, 'hardware': hardware, 'python': sys.version,
        'suite_sha256': hashlib.sha256(suite_bytes).hexdigest(), 'map_id': suite['mapId'],
        'topology_sha256': topology_sha,
        'native_extension_sha256': hashlib.sha256(Path(_native.__file__).read_bytes()).hexdigest(),
        'benchmark_source_sha256': hashlib.sha256(Path(benchmark.__file__).read_bytes()).hexdigest(),
        'method': 'env-throughput.md#measured-results',
        'loop_owner': 'native EpisodeBatch (N kernel Episodes)',
        'workloads': [],
    }
    with tempfile.TemporaryDirectory(prefix='simforge-state-bench-') as scratch:
        for scenario in suite['scenarios']:
            spec = HERE / scenario['spec']
            if hashlib.sha256(spec.read_bytes()).hexdigest() != scenario['sha256']:
                raise RuntimeError(f'{spec}: frozen scenario digest mismatch')
            raw = Path(scratch) / f"{scenario['id']}.json"
            command = [sys.executable, '-m', 'simforge_oss_gym.train.benchmark', '--spec', str(spec),
                       '--out', str(raw), '--seconds', str(suite['seconds']),
                       '--repeats', str(suite['repeats']), '--threads', str(suite['threads'])]
            print(f"benchmarking {scenario['id']}", file=sys.stderr, flush=True)
            subprocess.run(command, cwd=ROOT, check=True, stdout=sys.stderr)
            measured = json.loads(raw.read_text())
            if [row['num_envs'] for row in measured['rows']] != suite['numEnvs']:
                raise RuntimeError('TrainViz benchmark no longer covers the pinned environment counts')
            for row in measured['rows']:
                if len(row['samples']) != suite['repeats']:
                    raise RuntimeError('TrainViz benchmark no longer covers the pinned window count')
                for sample in row['samples']:
                    sample['autoreset_only_rows'] = sample['batch_calls'] * row['num_envs'] - sample['decisions']
                    if sample['seconds'] < suite['seconds'] or sample['autoreset_only_rows'] < 0:
                        raise RuntimeError('invalid benchmark window accounting')
            result['workloads'].append({'id': scenario['id'], 'family': scenario['family'], **measured})

    baseline_path = ROOT / 'docs/engineering/benchmarks/state-throughput-2026-09-22-final.json'
    baseline = json.loads(baseline_path.read_text())
    result['session_batch_baseline'] = {
        'path': str(baseline_path.relative_to(ROOT)),
        'sha256': hashlib.sha256(baseline_path.read_bytes()).hexdigest(),
        'native_extension_sha256': baseline['native_extension_sha256'],
        'measured_at': baseline['measured_at'],
    }
    for workload in result['workloads']:
        previous = next(entry for entry in baseline['workloads'] if entry['id'] == workload['id'])
        for row in workload['rows']:
            old = next(entry for entry in previous['rows'] if entry['num_envs'] == row['num_envs'])
            row['session_batch_baseline_decisions_per_s'] = old['median_env_steps_per_s']
            row['versus_session_batch_percent'] = 100 * (row['median_env_steps_per_s'] / old['median_env_steps_per_s'] - 1)

    floor = suite['floors']['state64DecisionsPerSecond']
    failures = check_floors(result['workloads'], floor)
    result['gate'] = {'minimum_64_env_decisions_per_s': floor, 'passed': not failures, 'failures': failures}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, indent=2) + '\n')
    lines = [
        '# Fixed-suite EpisodeBatch state throughput', '',
        f"Measured {result['measured_at']}; git `{sha}`; runner `{args.runner_class}`.", '',
        f"Hardware: {cpu}; {hardware['logical_cpus']} logical CPUs "
        f"({hardware['affinity_cpus']} available); {hardware['os']}.", '',
        'Method: [the original SessionBatch entry](env-throughput.md#measured-results); '
        'the same TrainViz timing and NEXT_STEP accounting now exercise N kernel Episodes, including trace hashing.', '',
        f"Map: `{suite['mapId']}`. Native extension SHA-256: `{result['native_extension_sha256']}`.", '',
        '| Workload | Envs | Rust threads | Median decisions/s | Window rates |',
        '|---|---:|---:|---:|---|',
    ]
    for workload in result['workloads']:
        for row in workload['rows']:
            rates = ', '.join(f"{sample['env_steps_per_s']:,.2f}" for sample in row['samples'])
            lines.append(f"| {workload['id']} | {row['num_envs']} | {row['threads']} | "
                         f"{row['median_env_steps_per_s']:,.2f} | {rates} |")
    lines += ['', '## Compared with the final SessionBatch entry', '',
              'Historical baseline is unchanged; its different binary and measurement time are retained in JSON.', '',
              '| Workload | Envs | SessionBatch decisions/s | EpisodeBatch decisions/s | Change |',
              '|---|---:|---:|---:|---:|']
    for workload in result['workloads']:
        for row in workload['rows']:
            lines.append(f"| {workload['id']} | {row['num_envs']} | {row['session_batch_baseline_decisions_per_s']:,.2f} | "
                         f"{row['median_env_steps_per_s']:,.2f} | {row['versus_session_batch_percent']:+.2f}% |")
    lines += ['', f"Gate: **{'PASS' if not failures else 'FAIL'}**; each workload at 64 envs must sustain "
              f"≥{floor:,.0f} decisions/s.", '', f'Raw counts, timings and provenance: [{args.out.name}]({args.out.name}).', '']
    if failures:
        lines += [*failures, '']
    args.out.with_suffix('.md').write_text('\n'.join(lines))
    print(json.dumps({'json': str(args.out), 'markdown': str(args.out.with_suffix('.md')), 'gate': result['gate']}))
    return 1 if failures else 0


if __name__ == '__main__':
    raise SystemExit(main())
