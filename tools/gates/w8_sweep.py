#!/usr/bin/env python3
"""W8 driver: fixed stratified sample, 30 arms (6 models x 5 efforts), aggregation + analysis.

Everything analysis-relevant is fixed by research/edge-case-corpus/W8-MODEL-EFFORT-EXPERIMENT.md
(pre-registered) and by this file BEFORE any arm runs:

  sample     n=20, stratified by category: one slot per category (15), the remaining 5 to the
             largest categories by (count desc, name asc); within a category the brief is drawn
             by random.Random(SEED) over the sorted brief ids. SEED = 8, recorded in the report.
  repeats    determinism re-authoring on the first 5 sample ids sorted lexicographically.
  models     the five verified in the amendment table plus claude-sonnet-5. NOTE, recorded here
             and in FINDINGS: the amendment's table lists FIVE models while its arithmetic and
             the reopening instruction say SIX x 5 = 30 arms; the sixth was chosen before any
             arm ran (the only other current-generation general-line model on the gateway) and
             verified live.
  metric     gate admission rate over the 20 briefs per arm, frozen gate v2, Wilson 95% CI.

Arms run as subprocesses (w8_arm.py) so vlm.py's import-time VISTA_MODEL/VISTA_EFFORT binding
selects the arm; up to --parallel-arms run concurrently, template paths isolated per arm.

Usage: w8_sweep.py [--parallel-arms 3] [--only-missing] [--out report.json]
"""
import argparse, concurrent.futures, json, math, os, random, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
sys.path.insert(0, HERE)
import author_corpus as A                                                  # noqa: E402

SEED = 8
MODELS = ['gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra',
          'claude-opus-5', 'claude-fable-5', 'claude-sonnet-5']
EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
ARM_DIR = '/tmp/tg-w8-arms'


def build_sample():
    briefs, _, _ = A.load_splits()
    by_cat = {}
    for b in briefs:
        by_cat.setdefault(b['category'], []).append(b['id'])
    for ids in by_cat.values():
        ids.sort()
    cats = sorted(by_cat)
    extras = [c for c, _ in sorted(((c, len(v)) for c, v in by_cat.items()),
                                   key=lambda kv: (-kv[1], kv[0]))[:5]]
    rng = random.Random(SEED)
    picked = []
    for c in cats:
        pool = list(by_cat[c])
        first = rng.choice(pool)
        picked.append(first)
        if c in extras:
            rest = [i for i in pool if i != first]
            picked.append(rng.choice(rest))
    picked.sort()
    return {'seed': SEED, 'n': len(picked), 'briefIds': picked,
            'extraSlotCategories': extras,
            'determinismRepeatIds': picked[:5]}


def wilson(k, n, z=1.959964):
    if n == 0:
        return (0.0, 0.0)
    p = k / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return (round((c - h) / d, 4), round((c + h) / d, 4))


def gate_hash():
    p = subprocess.run([os.path.join(ROOT, '.venv', 'bin', 'python'),
                        os.path.join(HERE, 'verify_gate_hash.py')],
                       capture_output=True, text=True, cwd=ROOT)
    last = [l for l in p.stdout.splitlines() if 'TRIPWIRE' in l]
    return {'pass': p.returncode == 0, 'line': last[-1] if last else p.stdout[-200:]}


def run_arm(model, effort, sample_path, workers, batch_conc):
    out = os.path.join(ARM_DIR, 'arm-%s-%s.json' % (model, effort))
    if os.path.exists(out):
        return out
    env = dict(os.environ, VISTA_MODEL=model, VISTA_EFFORT=effort)
    t0 = time.monotonic()
    p = subprocess.run([os.path.join(ROOT, '.venv', 'bin', 'python'),
                        os.path.join(HERE, 'w8_arm.py'), '--sample', sample_path,
                        '--out', out, '--workers', str(workers),
                        '--batch-concurrency', str(batch_conc)],
                       capture_output=True, text=True, cwd=ROOT, env=env, timeout=14400)
    if not os.path.exists(out):
        json.dump({'model': model, 'effort': effort, 'failed': True,
                   'stderr': p.stderr[-2000:], 'stdout': p.stdout[-500:]},
                  open(out + '.failed', 'w'), indent=1)
        return out + '.failed'
    print('arm %s/%s done in %.0fs' % (model, effort, time.monotonic() - t0), flush=True)
    return out


def analyse(arms, sample, hash_before, hash_after):
    table, ranks = {}, {}
    for arm in arms:
        m, e = arm['model'], arm['effort']
        lo, hi = wilson(arm['admitted'], arm['n'])
        table.setdefault(m, {})[e] = {
            'admitted': arm['admitted'], 'n': arm['n'], 'rate': arm['admissionRate'],
            'ci95': [lo, hi], 'authorErrors': arm['authorErrorCount'],
            'wallS': arm['wallS'], 'usage': arm['usageTotals'],
            'determinismIdentical': sum(1 for d in arm['determinismRepeats']
                                        if d['templateIdentical']),
            'determinismN': len(arm['determinismRepeats']),
            'firstFailureCells': arm['firstFailureCells']}
    # H1 monotonicity within model
    h1 = {}
    for m in table:
        rates = [table[m][e]['rate'] for e in EFFORTS if e in table[m]]
        mono_up = all(b >= a for a, b in zip(rates, rates[1:]))
        mono_down = all(b <= a for a, b in zip(rates, rates[1:]))
        h1[m] = {'rates': rates,
                 'monotoneIncreasing': mono_up, 'monotoneDecreasing': mono_down}
    # H2 rank stability across efforts
    for e in EFFORTS:
        r = sorted((m for m in table if e in table[m]),
                   key=lambda m: (-table[m][e]['rate'], m))
        ranks[e] = r
    # H3 criterion shares by effort (pooled over models)
    h3 = {}
    for e in EFFORTS:
        cells = {}
        for m in table:
            if e in table[m]:
                for k, v in table[m][e]['firstFailureCells'].items():
                    cells[k] = cells.get(k, 0) + v
        tot = sum(cells.values()) or 1
        h3[e] = {k: round(v / tot, 4) for k, v in sorted(cells.items())}
    return {'sample': sample, 'models': MODELS, 'efforts': EFFORTS,
            'gateHashBeforeFirstArm': hash_before, 'gateHashAfterLastArm': hash_after,
            'table': table, 'h1Monotonicity': h1, 'h2RankByEffort': ranks,
            'h3FirstFailureShareByEffort': h3}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--parallel-arms', type=int, default=3)
    ap.add_argument('--workers', type=int, default=5)
    ap.add_argument('--batch-concurrency', type=int, default=3)
    ap.add_argument('--out', default=os.path.join(
        ROOT, 'research/edge-case-corpus/reports/training-grade/W8-model-effort-sweep.json'))
    a = ap.parse_args()

    os.makedirs(ARM_DIR, exist_ok=True)
    sample_path = os.path.join(ARM_DIR, 'sample.json')
    if os.path.exists(sample_path):
        sample = json.load(open(sample_path))
    else:
        sample = build_sample()
        json.dump(sample, open(sample_path, 'w'), indent=1)
    print('sample n=%d seed=%d ids=%s' % (sample['n'], sample['seed'],
                                          ','.join(sample['briefIds'])), flush=True)

    hash_before = gate_hash()
    print('gate before:', hash_before['line'], flush=True)
    assert hash_before['pass'], 'tripwire failed before first arm'

    jobs = [(m, e) for m in MODELS for e in EFFORTS]
    with concurrent.futures.ThreadPoolExecutor(max_workers=a.parallel_arms) as pool:
        list(pool.map(lambda me: run_arm(me[0], me[1], sample_path,
                                         a.workers, a.batch_concurrency), jobs))

    hash_after = gate_hash()
    print('gate after:', hash_after['line'], flush=True)

    arms, failed = [], []
    for m, e in jobs:
        p = os.path.join(ARM_DIR, 'arm-%s-%s.json' % (m, e))
        if os.path.exists(p):
            arms.append(json.load(open(p)))
        else:
            failed.append('%s/%s' % (m, e))
    rep = analyse(arms, sample, hash_before, hash_after)
    rep['failedArms'] = failed
    rep['armFiles'] = ARM_DIR
    json.dump(rep, open(a.out, 'w'), indent=1)
    print('wrote %s (%d arms, %d failed)' % (a.out, len(arms), len(failed)))
    return 0 if not failed else 1


if __name__ == '__main__':
    sys.exit(main())
