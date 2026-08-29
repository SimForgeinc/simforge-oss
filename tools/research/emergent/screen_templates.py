"""Arm (i) step 1: screen candidate templates for frozen-gate-passing cells (ambient OFF).

For each template: batch --maps <maps> --max-sites <n> --draws <n>, gate every cell,
keep templates with >= 1 passing cell. Writes screen.json into --out.

Usage: screen_templates.py --out /tmp/tgr-emergent-screen-<runid> [--maps a,b] [--extend]
"""
import argparse
import glob
import json
import os
import time

import emergent_lib as L

DEFAULT_MAPS = 'belmont-research-center,el-camino-road'
POOLS = {
    'core': ['examples/*.template.json', 'examples/mechanisms/*/*.template.json'],
    'extend': ['research/edge-case-corpus/vista-corpus/templates/*.template.json'],
}


def templates_for(pool):
    files = []
    for pat in POOLS[pool]:
        files.extend(sorted(glob.glob(os.path.join(L.ROOT, pat))))
    return files


def screen_one(tpl, out_base, maps, max_sites, draws, concurrency):
    name = os.path.basename(tpl).replace('.template.json', '')
    out = os.path.join(out_base, name)
    t0 = time.time()
    code, stdout, stderr = L.run_cli([
        'batch', tpl, '--maps', maps, '--max-sites', str(max_sites),
        '--draws', str(draws), '--out', out, '--concurrency', str(concurrency)])
    wall = time.time() - t0
    if not os.path.isdir(out):
        return {'template': name, 'file': tpl, 'error': (stderr or stdout)[-300:],
                'cells': 0, 'passed': 0, 'wallS': round(wall, 1)}
    gated = [L.gate_cell(c) for c in L.collect_cells(out)]
    s = L.summarize(gated)
    s.update({'template': name, 'file': tpl, 'wallS': round(wall, 1),
              'exitCode': code,
              'passingCells': [
                  {'map': g['map'], 'site': g['site'], 'draw': g['drawName'],
                   'clearanceM': g.get('clearanceM'), 'minTTC': g.get('minTTC')}
                  for g in gated if g.get('pass')]})
    return s


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True)
    ap.add_argument('--maps', default=DEFAULT_MAPS)
    ap.add_argument('--max-sites', type=int, default=2)
    ap.add_argument('--draws', type=int, default=2)
    ap.add_argument('--concurrency', type=int, default=6)
    ap.add_argument('--pool', choices=['core', 'extend'], default='core')
    ap.add_argument('--target', type=int, default=15)
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    rows = []
    for tpl in templates_for(args.pool):
        row = screen_one(tpl, args.out, args.maps, args.max_sites, args.draws,
                         args.concurrency)
        rows.append(row)
        print(json.dumps({k: row.get(k) for k in
                          ('template', 'cells', 'passed', 'deathCensus', 'wallS', 'error')}),
              flush=True)
    passing = [r for r in rows if r.get('passed', 0) > 0]
    report = {
        'runId': os.path.basename(args.out.rstrip('/')),
        'maps': args.maps, 'maxSites': args.max_sites, 'draws': args.draws,
        'pool': args.pool,
        'templatesScreened': len(rows),
        'templatesPassing': len(passing),
        'target': args.target,
        'passing': [r['template'] for r in passing],
        'rows': rows,
    }
    with open(os.path.join(args.out, 'screen.json'), 'w') as f:
        json.dump(report, f, indent=1)
    print(json.dumps({k: report[k] for k in
                      ('templatesScreened', 'templatesPassing', 'passing')}, indent=1))


if __name__ == '__main__':
    main()
