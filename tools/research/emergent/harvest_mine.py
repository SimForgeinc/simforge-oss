"""Arm (ii) mining over harvest cell dirs — REUSES the pre-registered miner verbatim.

tools/tg-research/worldgen/mine.py owns every threshold and the taxonomy (PREREG M3);
this wrapper only adapts cell COLLECTION from the contract layout
(<out>/cells/<cellId>/{trace.json.gz, meta.json}) to mine.py's cell dicts, then runs
their process_cell in a pool and writes their summary shape.

Usage: harvest_mine.py <out-dir> [--workers 6]
"""
import argparse
import json
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
sys.path.insert(0, os.path.join(ROOT, 'tools', 'tg-research', 'worldgen'))
sys.path.insert(0, os.path.join(ROOT, 'tools', 'gates'))
import mine  # noqa: E402  (pre-registered miner, reused)

TPL_KIND = {'jS': 'junction', 'jL': 'junction', 'ml': 'multilane', 'bo': 'junction'}


def collect_cells(out_dir):
    cells = []
    cells_dir = os.path.join(out_dir, 'cells')
    for cid in sorted(os.listdir(cells_dir)):
        d = os.path.join(cells_dir, cid)
        meta_p = os.path.join(d, 'meta.json')
        trace_p = os.path.join(d, 'trace.json.gz')
        if not (os.path.exists(meta_p) and os.path.exists(trace_p)):
            continue
        m = json.load(open(meta_p))
        if m.get('status') != 'ok':
            continue
        cells.append({
            'cellId': m['cellId'],
            'template': TPL_KIND.get(m.get('template'), m.get('template')),
            'tplShort': m.get('template'),
            'map': m['map'], 'preset': m['profile'], 'density': m['profile'],
            'seed': m['seed'], 'site': m['site'], 'out': d,
            'trace': trace_p, 'verdict': m.get('verdict'), 'band': m.get('band'),
        })
    return cells


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('base')
    ap.add_argument('--workers', type=int, default=6)
    args = ap.parse_args()
    out_dir = os.path.join(args.base, 'mining')
    os.makedirs(out_dir, exist_ok=True)
    cells = collect_cells(args.base)
    print('cells to mine: %d' % len(cells), flush=True)
    t0 = time.time()
    events, collisions, errors, ambient_counts = [], [], [], []
    with ProcessPoolExecutor(max_workers=args.workers) as ex:
        for res in ex.map(mine.process_cell, cells, chunksize=8):
            if res.get('error'):
                errors.append({'trace': res['cell']['trace'], 'error': res['error']})
                continue
            events.extend(res['events'])
            collisions.extend(res['collisions'])
            ambient_counts.append(res['nAmbient'])
    wall = time.time() - t0
    with open(os.path.join(out_dir, 'events.jsonl'), 'w') as f:
        for e in events:
            f.write(json.dumps(e) + '\n')
    with open(os.path.join(out_dir, 'collisions.jsonl'), 'w') as f:
        for e in collisions:
            f.write(json.dumps(e) + '\n')

    def yield_table(evts, cs):
        table = {}
        for c in cs:
            key = '%s|%s|%s' % (c['tplShort'], c['map'], c['preset'])
            table.setdefault(key, {'cells': 0, 'T1': 0, 'T2': 0, 'ego': 0,
                                   'ambientOnly': 0, 'events': 0})['cells'] += 1
        for e in evts:
            c = e['cell']
            # e['cell'] carries mine.py's key subset; recover tplShort from template
            key = '%s|%s|%s' % ({'junction': e['cell']['template'],
                                 'multilane': 'ml'}.get(c['template'], c['template']),
                                c['map'], c['preset'])
            # fallback: group by (template,map,preset) verbatim
            key = '%s|%s|%s' % (c['template'], c['map'], c['preset'])
            t = table.setdefault(key, {'cells': 0, 'T1': 0, 'T2': 0, 'ego': 0,
                                       'ambientOnly': 0, 'events': 0})
            t['events'] += 1
            if e['tier']:
                t[e['tier']] += 1
            t['ego' if e['egoInvolved'] else 'ambientOnly'] += 1
        for t in table.values():
            t['per1000runs'] = round(t['events'] / t['cells'] * 1000, 1) if t['cells'] else None
            t['T1per1000'] = round(t['T1'] / t['cells'] * 1000, 1) if t['cells'] else None
        return table

    # miner groups by template kind; rebuild cells table keyed the same way
    kind_cells = [{**c, 'tplShort': c['template']} for c in cells]
    cats, sigs = {}, {}
    for e in events:
        if e['category']:
            cats[e['category']] = cats.get(e['category'], 0) + 1
        s = '|'.join(e['signature'])
        sigs[s] = sigs.get(s, 0) + 1
    summary = {
        'cellsMined': len(cells), 'errors': errors[:20], 'nErrors': len(errors),
        'wallS': round(wall, 1),
        'events': len(events), 'collisions': len(collisions),
        'meanAmbientActors': round(float(np.mean(ambient_counts)), 2) if ambient_counts else None,
        'yieldTable': yield_table(events, kind_cells),
        'categorySpectrum': dict(sorted(cats.items(), key=lambda kv: -kv[1])),
        'clusters': dict(sorted(sigs.items(), key=lambda kv: -kv[1])),
        'egoInvolved': sum(1 for e in events if e['egoInvolved']),
        'ambientOnly': sum(1 for e in events if e['ambientOnly']),
        'tierT1': sum(1 for e in events if e['tier'] == 'T1'),
    }
    json.dump(summary, open(os.path.join(out_dir, 'mining-summary.json'), 'w'), indent=1)
    print(json.dumps({k: summary[k] for k in ('cellsMined', 'events', 'collisions',
                                              'tierT1', 'egoInvolved', 'ambientOnly',
                                              'categorySpectrum', 'wallS')}, indent=1))


if __name__ == '__main__':
    main()
