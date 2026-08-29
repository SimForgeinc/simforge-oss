#!/usr/bin/env python3
"""Pre-registered model x effort grid for the freedom arm (owner directive 2026-08-16).

Arms: {gpt-5.6-luna, gpt-5.6-sol, gpt-5.6-terra} x {low, medium, high} on a fixed
15-brief subset of the frozen sample (9 DEV + 6 owner, seeded, written once to
grid-subset.json and never regenerated). Arms run sequentially; each arm uses the
frozen harness with its default worker budget (<= 6 concurrent batch workers).
Grid arms run a REDUCED final batch (draws=6, max-sites=6; declared here and in
REPORT.md before any arm ran) purely to bound wall time: selection is internal to the
grid, all arms identical. The winner reruns the FULL protocol (draws=10, max-sites=10)
on the whole sample; grid numbers are never pooled with main-arm numbers.


SELECTION RULE (declared before any grid arm ran; also in REPORT.md):
  1. higher admitted count on the 15-brief subset;
  2. tie -> higher censusAggPassingCells.interactingPairs.mean;
  3. tie -> lower usageTotal.total_tokens.
The winning config authors the FULL frozen sample (harness.py --sample all).

Usage: grid_run.py [--models a,b,c] [--efforts x,y,z] [--tag g1]
"""
import argparse, json, os, random, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
SHARED = os.path.join(ROOT, 'tools', 'research', 'shared')
SUBSET = os.path.join(HERE, 'grid-subset.json')
PY = os.path.join(ROOT, '.venv', 'bin', 'python')

SEED = 20260816
MODELS = ('gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra')
EFFORTS = ('low', 'medium', 'high')
N_DEV, N_OWNER = 9, 6


def make_subset():
    """9 DEV (distinct categories) + 6 owner (distinct groups), seeded, from the
    frozen sample. Written once; regeneration refuses if the file exists."""
    if os.path.exists(SUBSET):
        return json.load(open(SUBSET))
    rng = random.Random(SEED + 1)                # distinct stream from the sample draw
    s = json.load(open(os.path.join(SHARED, 'briefs-sample.json')))
    by_cat = {}
    for b in s['dev']:
        by_cat.setdefault(b['category'], []).append(b)
    cats = sorted(by_cat)
    rng.shuffle(cats)
    dev = [rng.choice(sorted(by_cat[c], key=lambda b: b['id'])) for c in cats[:N_DEV]]
    by_grp = {}
    for b in s['owner']:
        by_grp.setdefault(b['group'], []).append(b)
    grps = sorted(by_grp)
    rng.shuffle(grps)
    own = [rng.choice(sorted(by_grp[g], key=lambda b: b['id'])) for g in grps[:N_OWNER]]
    out = {'kind': 'freeform-grid-subset', 'seed': SEED + 1,
           'ids': sorted([b['id'] for b in dev + own]),
           'dev': [b['id'] for b in dev], 'owner': [b['id'] for b in own]}
    json.dump(out, open(SUBSET, 'w'), indent=1)
    print('wrote %s (%d briefs)' % (SUBSET, len(out['ids'])))
    return out


def select_winner(arm_reports):
    """The pre-registered rule, mechanically."""
    def key(rep):
        pool = ((rep.get('censusAggPassingCells') or {}).get('interactingPairs')
                or {}).get('mean') or 0.0
        toks = (rep.get('usageTotal') or {}).get('total_tokens') or 0
        return (rep.get('admitted', 0), pool, -toks)
    ranked = sorted(arm_reports, key=key, reverse=True)
    return ranked[0], ranked


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--models', default=','.join(MODELS))
    ap.add_argument('--efforts', default=','.join(EFFORTS))
    ap.add_argument('--tag', default='g1')
    ap.add_argument('--workers', type=int, default=6)
    a = ap.parse_args()

    sub = make_subset()
    ids = ','.join(sub['ids'])
    reports = []
    for model in a.models.split(','):
        for effort in a.efforts.split(','):
            run_id = 'grid-%s-%s-%s' % (a.tag, model.replace('gpt-5.6-', ''), effort)
            out = '/tmp/tgr-freeform-%s/report.json' % run_id
            if os.path.exists(out):
                print('SKIP %s (report exists)' % run_id)
                reports.append(json.load(open(out)))
                continue
            cmd = [PY, os.path.join(HERE, 'harness.py'), '--run-id', run_id,
                   '--sample', 'all', '--only', ids, '--model', model,
                   '--effort', effort, '--arm', run_id,
                   '--final-draws', '6', '--final-max-sites', '6',
                   '--workers', str(a.workers), '--batch-concurrency', '1']
            print('=== ARM %s ===' % run_id, flush=True)
            rc = subprocess.call(cmd, cwd=ROOT)
            if rc != 0:
                print('ARM %s FAILED rc=%d' % (run_id, rc))
                continue
            reports.append(json.load(open(out)))

    winner, ranked = select_winner(reports)
    table = [{'runId': r.get('runId'), 'model': r.get('model'), 'effort': r.get('effort'),
              'admitted': r.get('admitted'), 'briefs': r.get('briefs'),
              'interactingPairsPassingMean':
                  ((r.get('censusAggPassingCells') or {}).get('interactingPairs')
                   or {}).get('mean'),
              'totalTokens': (r.get('usageTotal') or {}).get('total_tokens'),
              'wallSeconds': r.get('wallSeconds')} for r in ranked]
    result = {'kind': 'freeform-grid-result', 'subset': sub,
              'selectionRule': ['admitted desc', 'interactingPairs passing mean desc',
                                'total_tokens asc'],
              'table': table,
              'winner': {'model': winner.get('model'), 'effort': winner.get('effort'),
                         'runId': winner.get('runId')}}
    out = os.path.join(HERE, 'grid-result-%s.json' % a.tag)
    json.dump(result, open(out, 'w'), indent=1)
    print(json.dumps(result, indent=1))
    print('wrote %s' % out)
    return 0


if __name__ == '__main__':
    sys.exit(main())
