"""M1 seed-diversity probe (pre-registered in PREREG.md).

20 identical corridor worlds on the top easterbrook site, only --ambient-seed varies.
Measures whether the seed axis actually explores population space (falsifier F4).
"""
import json, os, subprocess, sys, time
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
sys.path.insert(0, os.path.join(ROOT, 'tools', 'gates'))
import tg_gate as G                                                        # noqa: E402

CLI = ['node', os.path.join(ROOT, 'packages', 'cli', 'bin', 'uniscenarios.js')]
TEMPLATE = os.path.join(HERE, 'templates', 'world-corridor.template.json')
SEEDS = list(range(1, 21))
RUNID = str(int(time.time() * 1000))
BASE = '/tmp/tgr-worldgen-m1-%s' % RUNID


def run_seed(seed):
    out = os.path.join(BASE, 'seed-%02d' % seed)
    os.makedirs(out)
    t0 = time.time()
    subprocess.run(CLI + ['batch', TEMPLATE, '--map', 'easterbrook-discovery-school',
                          '--max-sites', '1', '--draws', '1', '--ambient', 'heavy',
                          '--ambient-seed', str(seed), '--out', out],
                   capture_output=True, text=True, timeout=600, cwd=ROOT)
    summ = json.load(open(os.path.join(out, 'batch-summary.json')))
    r = summ['results'][0]
    tr = G.load_trace(r['traceFile'])
    hdr = tr['header']
    amb = set(hdr.get('ambientActorIds') or [])
    meta = hdr.get('actorMetadata', {})
    spawn, occ = set(), set()
    for aid in amb:
        a = tr['ticks']['actors'][aid]
        kind = meta.get(aid, {}).get('kind', '?')
        first = None
        for x, y, pr in zip(a['x'], a['y'], a['present']):
            if not pr:
                continue
            if first is None:
                first = (kind, int(x // 10), int(y // 10))
            occ.add((int(x // 10), int(y // 10)))
        if first:
            spawn.add(first)
    return {'seed': seed, 'site': r['siteId'], 'actorCount': len(amb),
            'spawn': sorted(map(list, spawn)), 'occ': sorted(map(list, occ)),
            'elapsedS': round(time.time() - t0, 2), 'inputHash': hdr.get('inputHash')}


def jaccard(a, b):
    a, b = set(map(tuple, a)), set(map(tuple, b))
    return len(a & b) / len(a | b) if a | b else 1.0


def main():
    os.makedirs(BASE)
    with ThreadPoolExecutor(max_workers=6) as ex:
        worlds = list(ex.map(run_seed, SEEDS))
    sites = {w['site'] for w in worlds}
    assert len(sites) == 1, 'probe must pin one site, got %s' % sites

    n = len(worlds)
    js, jo = [], []
    for i in range(n):
        for j in range(i + 1, n):
            js.append(jaccard(worlds[i]['spawn'], worlds[j]['spawn']))
            jo.append(jaccard(worlds[i]['occ'], worlds[j]['occ']))
    j_spawn = sum(js) / len(js)
    j_occ = sum(jo) / len(jo)
    counts = sorted(w['actorCount'] for w in worlds)
    distinct_counts = len(set(counts))
    # Registered decision rule (PREREG.md M1)
    if j_spawn >= 0.8:
        verdict = 'NO-GO'
    elif j_spawn < 0.5:
        verdict = 'GO'
    else:
        verdict = 'GO-with-caveat' if j_occ < 0.9 else 'NO-GO'
    out = {'runId': RUNID, 'base': BASE, 'site': sites.pop(), 'nSeeds': n,
           'J_spawn_mean': round(j_spawn, 4), 'J_occ_mean': round(j_occ, 4),
           'J_spawn_minmax': [round(min(js), 4), round(max(js), 4)],
           'actorCounts': counts, 'distinctActorCounts': distinct_counts,
           'identicalWorldPairs': sum(1 for v in js if v == 1.0),
           'verdict': verdict,
           'worlds': [{k: w[k] for k in ('seed', 'actorCount', 'elapsedS', 'inputHash')}
                      for w in worlds]}
    path = os.path.join(HERE, 'm1-diversity.json')
    json.dump(out, open(path, 'w'), indent=1)
    print(json.dumps({k: out[k] for k in ('site', 'J_spawn_mean', 'J_occ_mean',
                                          'actorCounts', 'identicalWorldPairs',
                                          'verdict', 'base')}, indent=1))


if __name__ == '__main__':
    main()
