"""Arm (i): paired ambient off/on over gate-passing templates (rethink stream C).

For each template and each arm in {off, light(3/km), city(8/km), heavy(16/km)}:
  batch --maps <maps> --max-sites S --draws D [--ambient <preset> --ambient-seed pairseed1]
into <out>/<template>/<arm>/. Cell coordinates and paramSeed are ambient-independent
(cellSeed hashes template x site x draw only), so cells pair 1:1 across arms by
(map, site, draw); the driver asserts paramSeed equality per pair.

Then: frozen-gate every cell; per-arm survival + death census (C5 deaths split into
verdict-reject / collision-with-ambient / collision-authored / trigger-never-fired);
determinism re-runs for --rerun cells per arm (fresh out dir, decompressed byte-compare);
contract cell artifacts (hardlinks) for FootageLane under <out>/cells/.

Usage: pair_arm.py --templates a,b,c --out /tmp/tgr-emergent-pair1 [--maps ...]
"""
import argparse
import filecmp
import gzip
import json
import os
import time

import emergent_lib as L

ARMS = {
    'off': [],
    'light': ['--ambient', 'light', '--ambient-seed', 'pairseed1'],
    'city': ['--ambient', 'city', '--ambient-seed', 'pairseed1'],
    'heavy': ['--ambient', 'heavy', '--ambient-seed', 'pairseed1'],
}
DEFAULT_MAPS = 'belmont-research-center,el-camino-road,yale-street'


def find_template(name):
    for pat in ('examples/%s.template.json', 'examples/mechanisms/*/%s.template.json',
                'research/edge-case-corpus/vista-corpus/templates/%s.template.json'):
        import glob as _g
        hits = _g.glob(os.path.join(L.ROOT, pat % name))
        if hits:
            return hits[0]
    raise SystemExit('template not found: %s' % name)


def c5_subcause(g, cell):
    """Split a C5 death into its actual mechanism, reading the raw trace."""
    import tg_gate as G
    if g.get('triggerNeverFired'):
        return 'C5:trigger-never-fired'
    tr = G.load_trace(cell['trace'])
    ambient = set(tr['header'].get('ambientActorIds') or [])
    colls = tr.get('metrics', {}).get('collisions') or []
    scored = [c for c in colls if not ({c.get('a'), c.get('b')} <= ambient)]
    if scored:
        involved = any(c.get('a') in ambient or c.get('b') in ambient for c in scored)
        return 'C5:collision-with-ambient' if involved else 'C5:collision-authored'
    res = json.load(open(cell['result']))
    return 'C5:verdict-%s' % (res.get('band') or res.get('verdict'))


def run_arm(tpl_file, arm, arm_args, out, maps, max_sites, draws, concurrency, force=False):
    args = ['batch', tpl_file, '--maps', maps, '--max-sites', str(max_sites),
            '--draws', str(draws), '--out', out, '--concurrency', str(concurrency)]
    if force:
        args.append('--force')
    t0 = time.time()
    code, stdout, stderr = L.run_cli(args + arm_args)
    return {'exitCode': code, 'wallS': round(time.time() - t0, 1),
            'stderr': stderr[-300:] if code != 0 else None}


def gate_arm(out):
    cells = L.collect_cells(out)
    gated = []
    for c in cells:
        g = L.gate_cell(c)
        if g.get('cause') == 'C5':
            try:
                g['cause'] = c5_subcause(g, c)
            except Exception as e:  # noqa: BLE001
                g['cause'] = 'C5:unreadable(%s)' % e
        g['_cell'] = c
        gated.append(g)
    return gated


def determinism_check(tpl_file, arm, arm_args, base_out, maps, max_sites, draws,
                      concurrency, sample):
    """Re-run a SUBSET of the arm (first-ranked site per map: --max-sites 1, same
    cell coordinates and seeds as the main run) into a fresh dir; byte-compare
    decompressed traces of up to `sample` overlapping cells per map."""
    rerun_out = base_out + '-rerun'
    run_arm(tpl_file, arm, arm_args, rerun_out, maps, 1, draws, concurrency)
    orig = {(c['map'], c['site'], c['draw']): c for c in L.collect_cells(base_out)}
    rer = {(c['map'], c['site'], c['draw']): c for c in L.collect_cells(rerun_out)}
    keys = sorted(set(orig) & set(rer))[:max(sample, 9)]
    rows = []
    for k in keys:
        a, b = orig[k]['trace'], rer[k]['trace']
        if not (os.path.exists(a) and os.path.exists(b)):
            rows.append({'cell': list(k), 'identical': None, 'note': 'trace missing'})
            continue
        da, db = gzip.open(a).read(), gzip.open(b).read()
        rows.append({'cell': list(k), 'identical': da == db,
                     'gzIdentical': filecmp.cmp(a, b, shallow=False)})
    import shutil
    shutil.rmtree(rerun_out, ignore_errors=True)
    return rows


def link_contract_cells(tpl, arm, out, cells_dir, runid):
    """Hardlink batch artifacts into contract cell dirs for FootageLane."""
    made = []
    for c in L.collect_cells(out):
        draw_n = c['draw'].replace('draw-', '')
        cell_id = 'emergent-%s-%s.%s-%s-%s-%s' % (
            runid, tpl, arm, c['map'], c['site'][:8], int(draw_n))
        d = os.path.join(cells_dir, cell_id)
        if os.path.isdir(d):
            made.append(cell_id)
            continue
        if not os.path.exists(c['trace']):
            continue
        os.makedirs(d, exist_ok=True)
        os.link(c['instance'], os.path.join(d, 'instance.json'))
        os.link(c['trace'], os.path.join(d, 'trace.json.gz'))
        os.link(c['result'], os.path.join(d, 'result.json'))
        made.append(cell_id)
    return made


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--templates', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--maps', default=DEFAULT_MAPS)
    ap.add_argument('--max-sites', type=int, default=3)
    ap.add_argument('--draws', type=int, default=3)
    ap.add_argument('--concurrency', type=int, default=6)
    ap.add_argument('--rerun', type=int, default=3, help='determinism sample per arm')
    ap.add_argument('--skip-determinism', action='store_true')
    args = ap.parse_args()

    runid = os.path.basename(args.out.rstrip('/')).replace('tgr-emergent-', '')
    cells_dir = os.path.join(args.out, 'cells')
    os.makedirs(cells_dir, exist_ok=True)
    report = {'runId': runid, 'maps': args.maps, 'maxSites': args.max_sites,
              'draws': args.draws, 'ambientSeed': 'pairseed1',
              'settleS': 20, 'templates': {}}
    for name in args.templates.split(','):
        tpl_file = find_template(name)
        trow = {'file': tpl_file, 'arms': {}}
        gated_by_arm = {}
        for arm, arm_args in ARMS.items():
            out = os.path.join(args.out, name, arm)
            rr = run_arm(tpl_file, arm, arm_args, out, args.maps, args.max_sites,
                         args.draws, args.concurrency)
            gated = gate_arm(out)
            gated_by_arm[arm] = gated
            s = L.summarize([{k: v for k, v in g.items() if k != '_cell'} for g in gated])
            s['wallS'] = rr['wallS']
            s['exitCode'] = rr['exitCode']
            if rr['stderr']:
                s['stderr'] = rr['stderr']
            if not args.skip_determinism:
                s['determinism'] = determinism_check(
                    tpl_file, arm, arm_args, out, args.maps, args.max_sites,
                    args.draws, args.concurrency, args.rerun)
            s['contractCells'] = len(link_contract_cells(name, arm, out, cells_dir, runid))
            trow['arms'][arm] = s
            print(json.dumps({'template': name, 'arm': arm,
                              'passed': s['passed'], 'cells': s['cells'],
                              'deathCensus': s['deathCensus'], 'wallS': s['wallS']}),
                  flush=True)
        # paired integrity: paramSeed must match across arms per (map, site, draw)
        seeds = {}
        mismatch = []
        for arm, gated in gated_by_arm.items():
            for g in gated:
                c = g['_cell']
                res = json.load(open(c['result']))
                k = (c['map'], c['site'], c['draw'])
                if k in seeds and seeds[k] != res.get('paramSeed'):
                    mismatch.append({'cell': list(k), 'arm': arm})
                seeds.setdefault(k, res.get('paramSeed'))
        trow['pairedSeedMismatches'] = mismatch
        report['templates'][name] = trow
        with open(os.path.join(args.out, 'pair-report.json'), 'w') as f:
            json.dump(report, f, indent=1)
    print(json.dumps({'done': True, 'out': args.out}))


if __name__ == '__main__':
    main()
