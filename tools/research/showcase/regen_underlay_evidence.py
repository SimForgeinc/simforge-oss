#!/usr/bin/env python3
"""Re-render 2D evidence WITH the road underlay for every corpus case that simulated.

Writes to showcase-data/evidence-underlay/<caseId>/<cellId>/ so no recorded job
artifact or evidence hash is touched. One cell per case (the first cell the
oracle actually reviewed, else the first cell with a trace).
"""
import json, subprocess, sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path.home() / 'UniScenarios-training-grade'
JOBS = ROOT / 'showcase-data' / 'jobs'
OUT = ROOT / 'showcase-data' / 'evidence-underlay'
CASES = json.loads((ROOT / 'apps/showcase/campaigns/edge-cases.json').read_text())['cases']


def load(p):
    try:
        return json.loads(Path(p).read_text())
    except Exception:
        return None


# pick, per case, the job with the most reviewed cells (best evidence)
pick = {}
for jobdir in sorted(p for p in JOBS.iterdir() if p.is_dir()):
    brief = load(jobdir / '00-brief.json')
    if not brief:
        continue
    case = brief.get('campaignCaseId')
    if not case:
        continue
    idx = load(jobdir / '40-cells' / 'index.json')
    cells = [c for c in ((idx or {}).get('cells') or []) if c.get('traceFile')]
    if not cells:
        continue
    sem = load(jobdir / '62-semantic2d.json') or {}
    reviewed = {r.get('cellId') for r in (sem.get('cells') or [])}
    chosen = next((c for c in cells if c.get('cellId') in reviewed), cells[0])
    score = (len(reviewed), len(cells))
    if case not in pick or score > pick[case][0]:
        pick[case] = (score, jobdir, chosen)

jobs = []
for case, (_score, jobdir, cell) in sorted(pick.items()):
    cellId = cell['cellId']
    trace = jobdir / '40-cells' / cellId / 'trace.json.gz'
    inst = jobdir / '40-cells' / cellId / 'instance.json'
    if not trace.is_file() or not inst.is_file():
        continue
    dest = OUT / case / cellId
    if (dest / 'rollout.mp4').is_file():
        continue
    jobs.append((case, cellId, trace, inst, dest))

print(f'cases with simulated cells: {len(pick)}   to render: {len(jobs)}', flush=True)


def render(item):
    case, cellId, trace, inst, dest = item
    dest.mkdir(parents=True, exist_ok=True)
    cmd = ['node', str(ROOT / 'packages/cli/bin/simforge.js'), 'render', str(trace),
           '--instance', str(inst), '--out', str(dest), '--tier', '2d', '--format', 'both',
           '--camera', 'follow-ego', '--fps', '12', '--full-clip', '--composition', 'incident',
           '--dev-assets', str(ROOT / 'dev-assets')]
    r = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=600)
    ok = (dest / 'rollout.mp4').is_file() or any(dest.glob('*.mp4'))
    return case, ok, (r.stderr or '')[-160:] if not ok else ''


ok = bad = 0
with ThreadPoolExecutor(max_workers=8) as pool:
    for case, good, err in pool.map(render, jobs):
        if good:
            ok += 1
        else:
            bad += 1
            print(f'  FAIL {case}: {err}', flush=True)
print(f'rendered ok={ok} failed={bad}')
total = sum(1 for c in CASES if (OUT / c['id']).is_dir() and any((OUT / c['id']).glob('*/*.mp4')))
print(f'cases with underlay evidence video: {total}/{len(CASES)}')
