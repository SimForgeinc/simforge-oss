"""Mirror remote learning evidence; render queued checkpoints only with a GPU grant.

A local gpu-permit.json is explicit coordination, not an automatic claim on the
workstation GPU: {"remaining": 3, "max_update": 40, "duration": 6}. The operator
must obtain the renderer slot before creating it. Each evaluation consumes one
grant; absent/exhausted grants leave requests pending while learning continues.
"""
from __future__ import annotations

import argparse
import functools
import http.server
import json
import os
import subprocess
import threading
import time
from pathlib import Path


def command(argv: list[str], cwd: Path, logfile: Path) -> None:
    with logfile.open('a') as log:
        log.write('\nCOMMAND ' + json.dumps(argv) + '\n')
        log.flush()
        subprocess.run(argv, cwd=cwd, stdout=log, stderr=subprocess.STDOUT, check=True, env={**os.environ, 'SIMFORGE_SKY_ASSETS': os.environ.get('SIMFORGE_SKY_ASSETS', str(Path.home() / '.local/share/simforge/native-runtime/share/sky'))})


def render_one(repo: Path, run: Path, request_path: Path, duration: float) -> None:
    request = json.loads(request_path.read_text())
    update = request['update']
    checkpoint = run / 'checkpoints' / request['checkpoint']
    target = run / 'rollouts' / f'update-{update:06d}'
    target.mkdir(parents=True, exist_ok=True)
    if (target / 'evaluation.json').exists():
        return
    cli = ['node', '--import', 'tsx', '--conditions=development', 'packages/cli/src/main.ts', 'drive']
    logfile = target / 'evaluation.log'
    command([*cli, 'run', '--scenario', str(run / 'scenarios/render-val.episodes.json'), '--policy', 'torch:' + str(checkpoint), '--seed', '100', '--duration', str(duration), '--out', str(target / 'native'), '--model-socket', f'/tmp/simforge-ppo-eval-{update}.sock'], repo, logfile)
    candidates = list((target / 'native').glob('*/result.json'))
    if len(candidates) != 1:
        raise RuntimeError(f'expected exactly one native result, got {candidates}')
    native = candidates[0].parent
    command([*cli, 'verify', str(native)], repo, logfile)
    command([*cli, 'compose', str(native), '--out', str(target / 'checkpoint.mp4')], repo, logfile)
    score = json.loads((native / 'score.json').read_text())
    result = json.loads((native / 'result.json').read_text())
    receipt = {**request, 'status': 'rendered', 'video': str(target / 'checkpoint.mp4'), 'native_run': str(native), 'duration_requested_s': duration, 'score': score, 'result': result}
    (target / 'evaluation.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(f'ROLLOUT_READY {target / "checkpoint.mp4"} score={native / "score.json"}', flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument('--remote', required=True, help='host:/absolute/run/directory/')
    parser.add_argument('--out', required=True)
    parser.add_argument('--repo', required=True)
    parser.add_argument('--port', type=int, default=8767)
    parser.add_argument('--seconds', type=float, default=10)
    args = parser.parse_args()
    run, repo = Path(args.out), Path(args.repo)
    run.mkdir(parents=True, exist_ok=True)
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(run))
    server = http.server.ThreadingHTTPServer(('127.0.0.1', args.port), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    print(f'DASHBOARD_READY http://127.0.0.1:{args.port}/ {run}', flush=True)
    try:
        while True:
            try:
                subprocess.run(['rsync', '-a', '--exclude=*.partial', '--exclude=*.partial.*', '--exclude=rollouts/', '--exclude=gpu-permit.json', '--exclude=scenarios/', args.remote.rstrip('/') + '/', str(run) + '/'], check=True)
                permit_path = run / 'gpu-permit.json'
                if permit_path.exists():
                    permit = json.loads(permit_path.read_text())
                    for request in sorted((run / 'eval-requests').glob('*.json')):
                        data = json.loads(request.read_text())
                        target = run / 'rollouts' / f"update-{data['update']:06d}"
                        if data['update'] > permit.get('max_update', float('inf')) or (target / 'evaluation.json').exists() or (target / 'error.json').exists():
                            continue
                        if permit.get('remaining', 0) <= 0:
                            break
                        # Consume before starting: a crash must never claim the
                        # GPU again after the operator has handed it to a peer.
                        permit['remaining'] -= 1
                        permit_path.write_text(json.dumps(permit) + '\n')
                        try:
                            render_one(repo, run, request, float(permit.get('duration', 6)))
                            from .timelapse import assemble
                            assemble(run)
                        except Exception as error:
                            target.mkdir(parents=True, exist_ok=True)
                            (target / 'error.json').write_text(json.dumps({'error': str(error), 'request': str(request)}, indent=2) + '\n')
                            print(f'ROLLOUT_FAILED {request} {error}', flush=True)
                    if permit.get('remaining', 0) == 0:
                        print('GPU_GRANT_EXHAUSTED; no further rendering without a new explicit permit', flush=True)
            except (OSError, subprocess.CalledProcessError, json.JSONDecodeError) as error:
                print(f'COLLECTOR_ERROR {error}', flush=True)
            time.sleep(args.seconds)
    finally:
        server.shutdown()


if __name__ == '__main__':
    main()
