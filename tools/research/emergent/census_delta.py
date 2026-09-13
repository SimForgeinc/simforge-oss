"""Arm (i) dynamism-census delta: per-arm aggregates over the shared frozen census.

Imports tools/research/shared/dynamism_census.py (read-only, sha256 recorded in the
report) and runs it over the contract cell dirs of /tmp/tgr-emergent-pair1/cells,
grouped by arm (cellId contains '<tpl>.<arm>-'). Emits per-arm aggregate + per-metric
delta vs the off arm, plus a per-template breakdown for the report table.

Usage: census_delta.py <pair-out-dir> [--workers 6] [--out file.json]
"""
import argparse
import hashlib
import json
import re
import os
import sys
from concurrent.futures import ProcessPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
SHARED = os.path.join(ROOT, 'tools', 'research', 'shared')
sys.path.insert(0, SHARED)
import dynamism_census as DC  # noqa: E402

ARMS = ('off', 'light', 'city', 'heavy')


def cell_arm_tpl(cid):
    # emergent-<runid>-<tpl>.<arm>-<map>-<site8>-<draw>; template ids contain hyphens
    m = re.match(r'^emergent-[^-]+-(?P<tpl>.+)\.(?P<arm>off|light|city|heavy)-', cid)
    if not m:
        return None, None
    return m.group('tpl'), m.group('arm')


def one(args):
    d, cid = args
    t, i = DC._cell_paths(d)
    if not t:
        return None
    row = DC.census_path(t, i)
    row['cell'] = cid
    return row


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('out_dir')
    ap.add_argument('--workers', type=int, default=6)
    ap.add_argument('--out')
    args = ap.parse_args()
    cells_dir = os.path.join(args.out_dir, 'cells')
    jobs = []
    for cid in sorted(os.listdir(cells_dir)):
        d = os.path.join(cells_dir, cid)
        if os.path.isdir(d):
            jobs.append((d, cid))
    by_arm, by_tpl_arm = {a: [] for a in ARMS}, {}
    with ProcessPoolExecutor(max_workers=args.workers) as ex:
        for row in ex.map(one, jobs, chunksize=8):
            if row is None:
                continue
            tpl, arm = cell_arm_tpl(row["cell"])
            if arm is None:
                continue
            if arm not in by_arm:
                continue
            by_arm[arm].append(row)
            by_tpl_arm.setdefault((tpl, arm), []).append(row)
    agg = {arm: DC.aggregate(rows) for arm, rows in by_arm.items() if rows}
    deltas = {}
    off = agg.get('off', {})
    for arm in ('light', 'city', 'heavy'):
        if arm not in agg:
            continue
        deltas[arm] = {}
        for metric in DC.NUMERIC:
            a, b = agg[arm].get(metric), off.get(metric)
            if isinstance(a, dict) and isinstance(b, dict):
                deltas[arm][metric] = {
                    'mean': round(a['mean'] - b['mean'], 3),
                    'meanOff': b['mean'], 'meanOn': a['mean'],
                }
    per_tpl = {}
    for (tpl, arm), rows in sorted(by_tpl_arm.items()):
        per_tpl.setdefault(tpl, {})[arm] = {
            'cells': len(rows),
            'interactingPairsMean': round(sum(r['interactingPairs'] for r in rows) / len(rows), 2),
            'actorsMovingMean': round(sum(r['actorsMoving'] for r in rows) / len(rows), 2),
            'hardBrakeMean': round(sum(r['hardBrakeEvents'] for r in rows) / len(rows), 2),
            'laneChangesMean': round(sum(r['laneChangesExecuted'] for r in rows) / len(rows), 2),
        }
    censu_sha = hashlib.sha256(
        open(os.path.join(SHARED, 'dynamism_census.py'), 'rb').read()).hexdigest()
    rep = {'censusSha256': censu_sha, 'cellsPerArm': {a: len(r) for a, r in by_arm.items()},
           'aggregate': agg, 'deltasVsOff': deltas, 'perTemplate': per_tpl}
    out = args.out or os.path.join(args.out_dir, 'census-delta.json')
    json.dump(rep, open(out, 'w'), indent=1)
    print(json.dumps({'cellsPerArm': rep['cellsPerArm'], 'deltasVsOff': deltas}, indent=1))


if __name__ == '__main__':
    main()
