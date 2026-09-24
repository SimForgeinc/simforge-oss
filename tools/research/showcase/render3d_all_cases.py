#!/usr/bin/env python3
"""3D-render one cell for every corpus case that simulated.

3D rendering is deterministic (it replays the recorded trace) and needs no model
quota; the pipeline only rations it behind the 2D semantic oracle to save GPU.
This bypasses that rationing so every generated scenario can be inspected.

Writes to showcase-data/evidence-3d/<caseId>/<cellId>/ - outside the job dirs, so
no recorded evidence hash is touched. Failures are recorded with their exporter
reason, never hidden.
"""
import json, subprocess, time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path.home() / 'UniScenarios-training-grade'
JOBS = ROOT / 'showcase-data' / 'jobs'
UNDER = ROOT / 'showcase-data' / 'evidence-underlay'
OUT = ROOT / 'showcase-data' / 'evidence-3d'
CASES = json.loads((ROOT / 'apps/showcase/campaigns/edge-cases.json').read_text())['cases']
WORKERS = 5

targets = []
for case in CASES:
    cid = case['id']
    cdir = UNDER / cid
    if not cdir.is_dir():
        continue
    cells = sorted(p.name for p in cdir.iterdir() if p.is_dir())
    if not cells:
        continue
    cell = cells[0]
    src = None
    for jd in sorted(JOBS.iterdir()):
        if (jd / '40-cells' / cell / 'trace.json.gz').is_file():
            src = jd
            break
    if src is None:
        continue
    dest = OUT / cid / cell
    if any(dest.glob('*.mp4')):
        continue
    targets.append((cid, cell, src, dest))

print(f'cases to 3D-render: {len(targets)}', flush=True)


def render(item):
    cid, cell, src, dest = item
    dest.mkdir(parents=True, exist_ok=True)
    cmd = ['node', str(ROOT / 'packages/cli/bin/simforge.js'), 'render',
           str(src / '40-cells' / cell / 'trace.json.gz'),
           '--instance', str(src / '40-cells' / cell / 'instance.json'),
           '--out', str(dest), '--tier', '3d', '--format', 'both',
           '--camera', 'follow-ego', '--fps', '12', '--full-clip',
           '--composition', 'incident']
    t0 = time.time()
    try:
        r = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=1800)
        err = (r.stderr or '')
    except subprocess.TimeoutExpired:
        err = 'timeout after 1800s'
    ok = any(dest.glob('*.mp4'))
    reason = ''
    if not ok:
        for line in err.splitlines():
            if line.strip().startswith('Error:') or ' Error: ' in line:
                reason = line.strip()[:160]
        reason = reason or err.strip()[-150:] or 'no mp4 and no error text'
    return cid, ok, round(time.time() - t0, 1), reason


ok = []
bad = []
with ThreadPoolExecutor(max_workers=WORKERS) as pool:
    for cid, good, secs, reason in pool.map(render, targets):
        if good:
            ok.append(cid)
            print(f'  OK   {cid:34s} {secs:6.1f}s', flush=True)
        else:
            bad.append((cid, reason))
            print(f'  FAIL {cid:34s} {secs:6.1f}s  {reason}', flush=True)

print(f'\n3D rendered ok={len(ok)} failed={len(bad)}')
for cid, reason in bad:
    print(f'  {cid}: {reason}')
summary = {'ok': ok, 'failed': [{'case': c, 'reason': r} for c, r in bad]}
(OUT / 'summary.json').write_text(json.dumps(summary, indent=1))
print(f"wrote {(OUT / 'summary.json').relative_to(ROOT)}")
