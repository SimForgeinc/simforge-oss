"""Arm (ii) gating: frozen gate over harvest artifacts.

Subcommands:
  raw <out>       — gate every raw world-run cell directly (registered structural-fail
                    demonstration: ambient counterparts are gate-invisible, so expect
                    C3 with clearanceM=None on every cell that has no authored challenger).
  promoted <out>  — gate every cells/*/promoted-*/ artifact (tag-strip route); writes
                    the gate block into the parent cell's meta.json and a summary.

The gate is imported frozen (tools/gates/tg_gate.py); verify_gate_hash.py is asserted
PASS at entry.
"""
import argparse
import json
import os
import subprocess
import sys

import emergent_lib as L

sys.path.insert(0, os.path.join(L.ROOT, 'tools', 'gates'))
import tg_gate as G  # noqa: E402


def assert_tripwire():
    r = subprocess.run([sys.executable, os.path.join(L.ROOT, 'tools/gates/verify_gate_hash.py')],
                       capture_output=True, text=True)
    if 'PASS' not in r.stdout.splitlines()[-1]:
        raise SystemExit('gate tripwire FAILED:\n' + r.stdout)


def gate_raw(out):
    cells_dir = os.path.join(out, 'cells')
    rows = []
    for cid in sorted(os.listdir(cells_dir)):
        d = os.path.join(cells_dir, cid)
        tp, mp = os.path.join(d, 'trace.json.gz'), os.path.join(d, 'meta.json')
        if not (os.path.exists(tp) and os.path.exists(mp)):
            continue
        m = json.load(open(mp))
        g = G.gate_cell(tp, verdict=m.get('verdict'), band=m.get('band'), version=2)
        rows.append({'cellId': cid, 'pass': g.get('pass'),
                     'firstFailure': G.first_failure(g),
                     'clearanceM': g.get('clearanceM'), 'minTTC': g.get('minTTC')})
        m['gate'] = {'pass': bool(g.get('pass')), 'firstFailure': G.first_failure(g),
                     'clearanceM': g.get('clearanceM'),
                     'tMinClearance': g.get('closestT')}
        json.dump(m, open(mp, 'w'), indent=1)
    census = {}
    for r in rows:
        k = 'PASS' if r['pass'] else (r['firstFailure'] or '?')
        census[k] = census.get(k, 0) + 1
    clearance_none = sum(1 for r in rows if r['clearanceM'] is None)
    summary = {'cells': len(rows), 'census': census,
               'clearanceNone': clearance_none,
               'structuralFailConfirmed': clearance_none == len(rows) and
               census.get('PASS', 0) == 0}
    json.dump({'rows': rows, 'summary': summary},
              open(os.path.join(out, 'mining', 'raw-gate.json'), 'w'), indent=1)
    print(json.dumps(summary, indent=1))


def gate_promoted(out):
    cells_dir = os.path.join(out, 'cells')
    rows = []
    for cid in sorted(os.listdir(cells_dir)):
        d = os.path.join(cells_dir, cid)
        for sub in sorted(os.listdir(d)) if os.path.isdir(d) else []:
            if not sub.startswith('promoted-'):
                continue
            pd = os.path.join(d, sub)
            tp, rp = os.path.join(pd, 'trace.json.gz'), os.path.join(pd, 'result.json')
            if not (os.path.exists(tp) and os.path.exists(rp)):
                continue
            res = json.load(open(rp))
            g = G.gate_cell(tp, verdict=res.get('verdict'), band=res.get('band'), version=2)
            row = {'cellId': cid, 'promoted': sub, 'pass': g.get('pass'),
                   'firstFailure': G.first_failure(g),
                   'clearanceM': g.get('clearanceM'), 'closestT': g.get('closestT'),
                   'closestWith': g.get('closestWith'), 'minTTC': g.get('minTTC'),
                   'requiredDecelMaxEgo': g.get('requiredDecelMaxEgo'),
                   'collisions': g.get('collisions'),
                   'verdict': res.get('verdict'), 'band': res.get('band'),
                   'evidenceOk': res.get('evidenceOk')}
            rows.append(row)
            mp = os.path.join(d, 'meta.json')
            m = json.load(open(mp))
            m.setdefault('promotions', {})[sub] = {
                'pass': bool(g.get('pass')), 'firstFailure': G.first_failure(g),
                'clearanceM': g.get('clearanceM'), 'tMinClearance': g.get('closestT')}
            if g.get('pass'):
                m['gate'] = m['promotions'][sub] | {'route': 'tag-strip'}
            json.dump(m, open(mp, 'w'), indent=1)
    census = {}
    for r in rows:
        k = 'PASS' if r['pass'] else (r['firstFailure'] or '?')
        census[k] = census.get(k, 0) + 1
    passing = [r for r in rows if r['pass']]
    # Portability is NOT computed here on purpose: promoted instances are
    # site-pinned; only re-cast templates may claim portability (prior stream
    # rule, kept). The summary reports admitted cells and their sites only.
    summary = {'promotedCells': len(rows), 'census': census,
               'admitted': len(passing),
               'admittedCellIds': [r['cellId'] for r in passing]}
    json.dump({'rows': rows, 'summary': summary},
              open(os.path.join(out, 'mining', 'promoted-gate.json'), 'w'), indent=1)
    print(json.dumps(summary, indent=1))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('mode', choices=['raw', 'promoted'])
    ap.add_argument('out')
    args = ap.parse_args()
    assert_tripwire()
    (gate_raw if args.mode == 'raw' else gate_promoted)(args.out)


if __name__ == '__main__':
    main()
