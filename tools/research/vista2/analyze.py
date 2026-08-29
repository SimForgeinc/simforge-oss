#!/usr/bin/env python3
"""Aggregate a vista2 run: per-brief table, totals, dynamism census over emitted
cells, and the three-way comparison hook (per-brief admissions on the shared sample).

Usage: .venv/bin/python tools/research/vista2/analyze.py /tmp/tgr-vista-main1 [--md]

Reads only raw artifacts: metrics.jsonl (harness-written rows), cell dirs
(trace.json.gz + meta.json), guide snapshots. The census is the frozen shared
implementation (tools/research/shared/dynamism_census.py), imported, never copied.
"""
import argparse, hashlib, json, os, sys

_HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(_HERE, '..', '..', '..'))
sys.path.insert(0, os.path.join(ROOT, 'tools', 'research', 'shared'))


def rows_of(run_dir):
    p = os.path.join(run_dir, 'metrics.jsonl')
    return [json.loads(l) for l in open(p)] if os.path.exists(p) else []


def census_over_cells(run_dir):
    import dynamism_census as DC
    cells_root = os.path.join(run_dir, 'cells')
    if not os.path.isdir(cells_root):
        return None, None
    per_cell = []
    for cid in sorted(os.listdir(cells_root)):
        d = os.path.join(cells_root, cid)
        tr = os.path.join(d, 'trace.json.gz')
        meta_p = os.path.join(d, 'meta.json')
        if not (os.path.exists(tr) and os.path.exists(meta_p)):
            continue
        meta = json.load(open(meta_p))
        try:
            inst_p = os.path.join(d, 'instance.json')
            row = DC.census_cell(tr, instance=inst_p if os.path.exists(inst_p) else None)
        except Exception as e:  # noqa: BLE001
            row = {'error': str(e)[:120]}
        row['cellId'] = cid
        row['briefId'] = meta.get('briefId')
        row['gatePass'] = (meta.get('gate') or {}).get('pass')
        per_cell.append(row)
    agg = DC.aggregate([r for r in per_cell if 'error' not in r]) if per_cell else None
    return per_cell, agg


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('run_dir')
    ap.add_argument('--md', action='store_true')
    ap.add_argument('--census', action='store_true')
    args = ap.parse_args()
    rows = rows_of(args.run_dir)
    n = len(rows)
    adm = [r for r in rows if r.get('admitted')]
    tot = {'briefs': n, 'admitted': len(adm),
           'admissionRate': round(len(adm) / n, 4) if n else None,
           'actionsPerAdmitted': round(sum(r.get('actions', 0) for r in rows)
                                       / max(1, len(adm)), 1),
           'meanActions': round(sum(r.get('actions', 0) for r in rows) / max(1, n), 1),
           'meanWallS': round(sum(r.get('wallS', 0) for r in rows) / max(1, n), 1),
           'tokensIn': sum((r.get('usage') or {}).get('input_tokens', 0) for r in rows),
           'tokensOut': sum((r.get('usage') or {}).get('output_tokens', 0) for r in rows),
           'reasoningTokens': sum((r.get('usage') or {}).get('reasoning_tokens', 0)
                                  for r in rows),
           'llmWallS': round(sum((r.get('usage') or {}).get('wallS', 0) for r in rows)),
           'simulates': sum(r.get('simulates', 0) for r in rows),
           'emits': sum(r.get('emits', 0) for r in rows),
           'errors': [r['briefId'] for r in rows if r.get('error')]}
    out = {'runDir': args.run_dir, 'totals': tot,
           'perBriefAdmission': {r['briefId']: bool(r.get('admitted')) for r in rows}}
    if args.census:
        per_cell, agg = census_over_cells(args.run_dir)
        out['censusAggregate'] = agg
        out['censusSha256'] = hashlib.sha256(open(os.path.join(
            ROOT, 'tools', 'research', 'shared', 'dynamism_census.py'), 'rb')
            .read()).hexdigest()
        cp = os.path.join(args.run_dir, 'census-per-cell.json')
        json.dump(per_cell, open(cp, 'w'), indent=1)
        out['censusPerCellFile'] = cp
    if args.md:
        print('| brief | category | admitted | actions | sims | emits | wall s | tok in | maps/sites |')
        print('|---|---|---|---|---|---|---|---|---|')
        for r in rows:
            u = r.get('usage') or {}
            port = r.get('portability') or {}
            print('| %s | %s | %s | %s | %s | %s | %.0f | %.0fk | %s/%s |'
                  % (r['briefId'], r.get('category', ''),
                     '**YES**' if r.get('admitted') else 'no',
                     r.get('actions'), r.get('simulates'), r.get('emits'),
                     r.get('wallS', 0), u.get('input_tokens', 0) / 1000,
                     port.get('nMaps', 0), port.get('nSites', 0)))
    print(json.dumps(out if not args.md else out['totals'], indent=1))


if __name__ == '__main__':
    main()
