"""M2 sweep driver (pre-registered in PREREG.md).

{corridor, junction} x 12 easterbrook sites x {heavy@16, heavy@32, city@8} x seeds 1..25,
draws 1, clip 30 s. One batch invocation per (template, preset, density, seed) covers all
matched sites with --concurrency 6; invocations run serially so the stream never exceeds
6 workers. Extra maps that finish syncing before mining are run at seeds 1..10.

Writes a manifest line per invocation to <base>/sweep-manifest.jsonl and a final
<base>/sweep-summary.json. Run under hub start.
"""
import json, os, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
CLI = ['node', os.path.join(ROOT, 'packages', 'cli', 'bin', 'uniscenarios.js')]

TEMPLATES = {
    'corridor': os.path.join(HERE, 'templates', 'world-corridor.template.json'),
    'junction': os.path.join(HERE, 'templates', 'world-junction.template.json'),
}
ARMS = [                       # (preset, densityOverride | None)
    ('heavy', None),           # 16 veh/km
    ('heavy', 32),
    ('city', None),            # 8 veh/km, pedestrianShare 0.06
]
PRIMARY_MAP = 'easterbrook-discovery-school'
PRIMARY_SEEDS = list(range(1, 26))
EXTRA_MAPS = ['yale-street', 'belmont-research-center', 'el-camino-road',
              'richmond-field-station']
EXTRA_SEEDS = list(range(1, 11))

RUNID = str(int(time.time() * 1000))
BASE = '/tmp/tgr-worldgen-m2-%s' % RUNID


def map_ready(map_id):
    """A map is usable when sites match resolves without a missing-artifact error."""
    p = subprocess.run(CLI + ['sites', 'match', TEMPLATES['corridor'], '--map', map_id],
                       capture_output=True, text=True, timeout=300, cwd=ROOT)
    if p.returncode != 0:
        return False
    try:
        d = json.loads(p.stdout.splitlines()[-1])
        return (d['maps'][0].get('siteCount') or 0) > 0
    except Exception:                                                       # noqa: BLE001
        return False


def run_cellblock(template, map_id, preset, density, seed, manifest):
    tag = '%s-%s-%s-d%s-s%02d' % (template, map_id.split('-')[0], preset,
                                  density or 'def', seed)
    out = os.path.join(BASE, tag)
    os.makedirs(out)
    args = CLI + ['batch', TEMPLATES[template], '--map', map_id, '--draws', '1',
                  '--concurrency', '6', '--ambient', preset, '--ambient-seed', str(seed),
                  '--out', out]
    if density is not None:
        args += ['--ambient-density', str(density)]
    t0 = time.time()
    p = subprocess.run(args, capture_output=True, text=True, timeout=1800, cwd=ROOT)
    wall = round(time.time() - t0, 2)
    row = {'template': template, 'map': map_id, 'preset': preset, 'density': density,
           'seed': seed, 'out': out, 'wallS': wall, 'rc': p.returncode}
    summ_path = os.path.join(out, 'batch-summary.json')
    if os.path.exists(summ_path):
        s = json.load(open(summ_path))
        row['cells'] = s.get('cells')
        row['elapsedMs'] = s.get('elapsedMs')
        row['ok'] = sum(1 for r in s.get('results', []) if r.get('status') == 'ok')
        amb = s.get('ambient') or {}
        row['actorsPerCell'] = amb.get('actorsPerCell')
    else:
        row['error'] = (p.stderr or p.stdout)[-400:]
    with open(manifest, 'a') as f:
        f.write(json.dumps(row) + '\n')
    print(json.dumps({k: row.get(k) for k in ('template', 'map', 'preset', 'density',
                                              'seed', 'cells', 'ok', 'wallS')}),
          flush=True)
    return row


def main():
    os.makedirs(BASE)
    manifest = os.path.join(BASE, 'sweep-manifest.jsonl')
    print('BASE=%s' % BASE, flush=True)
    rows = []
    t_start = time.time()
    for template in TEMPLATES:
        for preset, density in ARMS:
            for seed in PRIMARY_SEEDS:
                rows.append(run_cellblock(template, PRIMARY_MAP, preset, density,
                                          seed, manifest))
    # Extra maps, only those that became ready by now (additive per PREREG).
    ready = [m for m in EXTRA_MAPS if map_ready(m)]
    print('extra maps ready: %s' % ready, flush=True)
    for map_id in ready:
        for template in TEMPLATES:
            for preset, density in ARMS:
                for seed in EXTRA_SEEDS:
                    rows.append(run_cellblock(template, map_id, preset, density,
                                              seed, manifest))
    total_cells = sum(r.get('cells') or 0 for r in rows)
    wall_h = (time.time() - t_start) / 3600.0
    summary = {'runId': RUNID, 'base': BASE, 'invocations': len(rows),
               'totalCells': total_cells, 'wallHours': round(wall_h, 3),
               'cellsPerHour': round(total_cells / wall_h, 1) if wall_h else None,
               'failedInvocations': [r for r in rows if r.get('rc') != 0],
               'extraMapsRun': ready}
    json.dump(summary, open(os.path.join(BASE, 'sweep-summary.json'), 'w'), indent=1)
    print(json.dumps({k: summary[k] for k in ('invocations', 'totalCells', 'wallHours',
                                              'cellsPerHour', 'extraMapsRun')}),
          flush=True)


if __name__ == '__main__':
    main()
