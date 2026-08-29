#!/usr/bin/env python3
"""Calibration measurement for the footage judge — Stream B.

Stages (run in order; each is resumable and idempotent):
  pilot    strategy shakeout: PILOT_N cells x {spread8, burst6} x 3 models @ medium.
           Picks ONE strategy by mean realism-AUC across models (tie: cheaper tokens),
           freezes it to <run>/strategy.json. Pilot verdicts never enter the grid stats.
  grid     frozen strategy x {luna,sol,terra} x {low,medium,high} x every cell.
           Verdicts appended to <run>/verdicts.jsonl (resume: done (cell,model,effort)
           tuples are skipped).
  analyze  per-arm realism/dynamism AUC + bootstrap CI + class distributions +
           plausible/defect rates + cost; adequacy + cheapest-adequate selection;
           writes <run>/calibration-results.json.

SELECTION RULE (pre-registered in PREREG-v2 BEFORE any grid verdict was produced):
  adequate(arm)  := realism AUC >= 0.80 (threshold inherited from the prior
                    instrument PREREG, unchanged) AND bootstrap 95% CI lower
                    bound >= 0.70.
  chosen judge   := among adequate arms, lowest mean total tokens/cell;
                    ties -> lower mean latency, then lower effort rank
                    (low<medium<high), then model order sol, luna, terra
                    (sol first per W9 production default).
  no adequate arm -> calibration FAILED; scaling does NOT run (plan §3B falsifier).

Blinding: judging order is seeded-shuffled; workers see only cell dirs. Labels live
in labels.json, read only by analyze.
"""
import argparse
import itertools
import json
import os
import random
import sys
import threading
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import futil                                                               # noqa: E402
import judge                                                               # noqa: E402

SEED = 20260816
PILOT_N = 12          # 6 good + 6 absurd
PILOT_EFFORT = 'medium'
AUC_MIN = 0.80        # inherited from tools/tg-research/instrument/PREREG.md, unchanged
CI_LO_MIN = 0.70
EFFORT_RANK = {'low': 0, 'medium': 1, 'high': 2}
MODEL_PREF = {'gpt-5.6-sol': 0, 'gpt-5.6-luna': 1, 'gpt-5.6-terra': 2}


def load_labels(run):
    return futil.load_json(os.path.join(run, 'labels.json'))


def cell_dirs(run):
    return futil.discover_cells(os.path.join(run, 'cells'))


def pilot_cells(run, labels):
    """Seeded stratified pilot subset: PILOT_N/2 per class, spread over templates."""
    rng = random.Random(SEED)
    by_class = {'good': [], 'absurd': []}
    for d in cell_dirs(run):
        meta = futil.load_json(os.path.join(d, 'meta.json'))
        by_class[labels[meta['cellId']]].append((meta['briefId'], meta['cellId'], d))
    picked = []
    for cls, items in sorted(by_class.items()):
        by_tpl = {}
        for brief, cid, d in sorted(items):
            by_tpl.setdefault(brief, []).append((cid, d))
        groups = sorted(by_tpl.values(), key=len)
        rng.shuffle(groups)
        take = []
        while len(take) < PILOT_N // 2 and any(groups):
            for g in groups:
                if g and len(take) < PILOT_N // 2:
                    take.append(g.pop(rng.randrange(len(g))))
        picked.extend(take)
    return picked


def _append_locked(path, obj, lock):
    with lock:
        with open(path, 'a') as f:
            f.write(json.dumps(obj, sort_keys=True) + '\n')


def _run_matrix(jobs, out_path, workers, allow_unredacted=False):
    lock = threading.Lock()
    done = errs = 0

    def one(job):
        cell, model, effort, strategy = job
        try:
            v = judge.judge_cell(cell, model, effort, strategy,
                                 require_redacted=not allow_unredacted)
            v['_meta']['cellDir'] = cell
            _append_locked(out_path, v, lock)
            return True, None
        except Exception as e:                                             # noqa: BLE001
            _append_locked(out_path, {'error': str(e)[:400], 'cellDir': cell,
                                      'model': model, 'effort': effort,
                                      'strategy': strategy}, lock)
            return False, str(e)

    # vision preflight serially first (one probe per model, cached in-process)
    for m in sorted({m for _, m, _, _ in jobs}):
        futil.assert_vision_session(m)
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for ok, err in pool.map(one, jobs):
            done += ok
            errs += not ok
            if err:
                print(f'ERR {err[:160]}', file=sys.stderr)
    return done, errs


def _done_keys(path):
    keys = set()
    if os.path.isfile(path):
        for line in open(path):
            r = json.loads(line)
            if 'error' not in r:
                keys.add((r['_meta']['cellDir'], r['model'], r['effort'],
                          r['_meta']['strategy']))
    return keys


def stage_pilot(run, workers, allow_unredacted):
    labels = load_labels(run)
    out_path = os.path.join(run, 'pilot-verdicts.jsonl')
    cells = pilot_cells(run, labels)
    jobs = [(d, m, PILOT_EFFORT, s)
            for (_, d), m, s in itertools.product(cells, futil.MODELS, judge.STRATEGIES)]
    done = _done_keys(out_path)
    jobs = [j for j in jobs if j not in done]
    rng = random.Random(SEED + 1)
    rng.shuffle(jobs)
    print(f'pilot: {len(jobs)} judgments to run ({len(done)} cached)')
    n_ok, n_err = _run_matrix(jobs, out_path, workers, allow_unredacted)
    print(f'pilot: {n_ok} ok, {n_err} errors')

    # pick strategy
    rows = [json.loads(l) for l in open(out_path) if 'error' not in json.loads(l)]
    stats = {}
    for strat in judge.STRATEGIES:
        aucs, toks = [], []
        for model in futil.MODELS:
            sel = [r for r in rows if r['model'] == model and r['_meta']['strategy'] == strat]
            pos = [r['realism'] for r in sel
                   if labels[r['cellId']] == 'good']
            neg = [r['realism'] for r in sel
                   if labels[r['cellId']] == 'absurd']
            a = futil.auc_mannwhitney(pos, neg)
            if a is not None:
                aucs.append(a)
            toks.extend((r['_meta']['tokens']['in'] or 0) + (r['_meta']['tokens']['out'] or 0)
                        for r in sel if r['_meta']['tokens']['in'] is not None)
        stats[strat] = {'meanAUC': round(sum(aucs) / len(aucs), 4) if aucs else None,
                        'perModelAUC': None if not aucs else [round(a, 4) for a in aucs],
                        'meanTokens': round(sum(toks) / len(toks), 1) if toks else None,
                        'n': len(toks)}
    ranked = sorted(judge.STRATEGIES,
                    key=lambda s: (-(stats[s]['meanAUC'] or 0), stats[s]['meanTokens'] or 1e9))
    frozen = {'strategy': ranked[0], 'stats': stats, 'pilotN': PILOT_N,
              'pilotEffort': PILOT_EFFORT, 'seed': SEED,
              'visionLog': futil.vision_log()}
    futil.dump_json(os.path.join(run, 'strategy.json'), frozen)
    print(json.dumps(frozen, indent=2))


def stage_grid(run, workers, allow_unredacted):
    strategy = futil.load_json(os.path.join(run, 'strategy.json'))['strategy']
    out_path = os.path.join(run, 'verdicts.jsonl')
    cells = cell_dirs(run)
    jobs = [(d, m, e, strategy)
            for d, m, e in itertools.product(cells, futil.MODELS, futil.EFFORTS)]
    done = _done_keys(out_path)
    jobs = [j for j in jobs if j not in done]
    rng = random.Random(SEED + 2)
    rng.shuffle(jobs)
    print(f'grid: strategy={strategy}, {len(jobs)} judgments to run ({len(done)} cached)')
    n_ok, n_err = _run_matrix(jobs, out_path, workers, allow_unredacted)
    print(f'grid: {n_ok} ok, {n_err} errors')


def _spearman(xs, ys):
    def rank(v):
        order = sorted(range(len(v)), key=lambda i: v[i])
        rk = [0.0] * len(v)
        i = 0
        while i < len(order):
            j = i
            while j + 1 < len(order) and v[order[j + 1]] == v[order[i]]:
                j += 1
            for k in range(i, j + 1):
                rk[order[k]] = (i + j) / 2.0
            i = j + 1
        return rk
    rx, ry = rank(xs), rank(ys)
    n = len(xs)
    mx, my = sum(rx) / n, sum(ry) / n
    num = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    den = (sum((a - mx) ** 2 for a in rx) * sum((b - my) ** 2 for b in ry)) ** 0.5
    return num / den if den else None


def youden_confusion(pos, neg):
    best = None
    for thr in sorted(set(pos + neg)):
        tp = sum(1 for v in pos if v >= thr)
        fn = len(pos) - tp
        fp = sum(1 for v in neg if v >= thr)
        tn = len(neg) - fp
        j = tp / len(pos) - fp / len(neg)
        if best is None or j > best['youdenJ']:
            best = {'threshold': thr, 'youdenJ': round(j, 3),
                    'tp': tp, 'fn': fn, 'fp': fp, 'tn': tn}
    return best


def stage_analyze(run):
    labels = load_labels(run)
    brief_of = {}
    for d in cell_dirs(run):
        m = futil.load_json(os.path.join(d, 'meta.json'))
        brief_of[m['cellId']] = m.get('briefId', '?')
    rows = [json.loads(l) for l in open(os.path.join(run, 'verdicts.jsonl'))]
    errors = [r for r in rows if 'error' in r]
    rows = [r for r in rows if 'error' not in r]
    arms = {}
    for model in futil.MODELS:
        for effort in futil.EFFORTS:
            sel = [r for r in rows if r['model'] == model and r['effort'] == effort]
            # one verdict per cell (last wins if duplicated by resume)
            per_cell = {r['cellId']: r for r in sel}
            sel = list(per_cell.values())
            pos = [r for r in sel if labels[r['cellId']] == 'good']
            neg = [r for r in sel if labels[r['cellId']] == 'absurd']
            if not pos or not neg:
                arms[f'{model}/{effort}'] = {'error': 'missing class', 'n': len(sel)}
                continue
            rp, rn = [r['realism'] for r in pos], [r['realism'] for r in neg]
            dp, dn = [r['dynamism'] for r in pos], [r['dynamism'] for r in neg]
            auc_r = futil.auc_mannwhitney(rp, rn)
            ci = futil.bootstrap_auc_ci(rp, rn, seed=SEED)
            toks = [(r['_meta']['tokens']['in'] or 0) + (r['_meta']['tokens']['out'] or 0)
                    for r in sel if r['_meta']['tokens']['in'] is not None]
            lat = [r['_meta']['latencyS'] for r in sel]
            # per-broken-template realism means (which absurdity classes does it catch?)
            sub = {}
            for r in neg:
                sub.setdefault(brief_of.get(r['cellId'], '?'), []).append(r['realism'])
            arms[f'{model}/{effort}'] = {
                'n': len(sel), 'nGood': len(pos), 'nAbsurd': len(neg),
                'realismAUC': round(auc_r, 4),
                'realismAUC_CI95': [round(ci[0], 4), round(ci[1], 4)],
                'dynamismAUC': round(futil.auc_mannwhitney(dp, dn), 4),
                'realismGood': futil.summarize_scores(rp),
                'realismAbsurd': futil.summarize_scores(rn),
                'realismGoodScores': sorted(rp),
                'realismAbsurdScores': sorted(rn),
                'plausibleRateGood': round(sum(r['plausible'] for r in pos) / len(pos), 3),
                'plausibleRateAbsurd': round(sum(r['plausible'] for r in neg) / len(neg), 3),
                'defectRateGood': round(sum(bool(r['defects']) for r in pos) / len(pos), 3),
                'defectRateAbsurd': round(sum(bool(r['defects']) for r in neg) / len(neg), 3),
                'youden': youden_confusion(rp, rn),
                'absurdRealismByTemplate': {k: futil.summarize_scores(v)
                                            for k, v in sorted(sub.items())},
                'meanTokens': round(sum(toks) / len(toks), 1) if toks else None,
                'meanLatencyS': round(sum(lat) / len(lat), 2),
                'adequate': bool(auc_r >= AUC_MIN and ci[0] >= CI_LO_MIN),
            }
    # inter-model agreement per effort (Spearman on realism over common cells)
    agreement = {}
    for effort in futil.EFFORTS:
        for m1, m2 in itertools.combinations(futil.MODELS, 2):
            v1 = {r['cellId']: r['realism'] for r in rows
                  if r['model'] == m1 and r['effort'] == effort}
            v2 = {r['cellId']: r['realism'] for r in rows
                  if r['model'] == m2 and r['effort'] == effort}
            common = sorted(set(v1) & set(v2))
            if len(common) >= 10:
                agreement[f'{m1}~{m2}@{effort}'] = round(
                    _spearman([v1[c] for c in common], [v2[c] for c in common]), 3)

    adequate = [k for k, v in arms.items() if v.get('adequate')]

    def cost_key(k):
        v = arms[k]
        model, effort = k.split('/')
        return (v['meanTokens'] or 1e12, v['meanLatencyS'],
                EFFORT_RANK[effort], MODEL_PREF[model])
    chosen = min(adequate, key=cost_key) if adequate else None
    results = {
        'selectionRule': {'aucMin': AUC_MIN, 'ciLoMin': CI_LO_MIN,
                          'cost': 'mean total tokens/cell, ties: latency, effort rank, sol<luna<terra'},
        'strategy': futil.load_json(os.path.join(run, 'strategy.json'))['strategy'],
        'arms': arms, 'adequateArms': sorted(adequate), 'chosenJudge': chosen,
        'interModelSpearman': agreement,
        'judgeErrors': len(errors), 'seed': SEED,
        'calibrationPassed': bool(chosen),
    }
    futil.dump_json(os.path.join(run, 'calibration-results.json'), results)
    print(json.dumps({k: v for k, v in results.items()
                      if k not in ('arms',)}, indent=2))
    for k in sorted(arms):
        v = arms[k]
        if 'error' in v:
            print(f'{k:26} ERROR {v}')
        else:
            print(f'{k:26} AUC={v["realismAUC"]:.3f} CI[{v["realismAUC_CI95"][0]:.3f},'
                  f'{v["realismAUC_CI95"][1]:.3f}] dynAUC={v["dynamismAUC"]:.3f} '
                  f'tok={v["meanTokens"]} lat={v["meanLatencyS"]}s adequate={v["adequate"]}')


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('stages', nargs='+', choices=['pilot', 'grid', 'analyze'])
    ap.add_argument('--run', required=True)
    ap.add_argument('--workers', type=int, default=12, help='concurrent vision calls')
    ap.add_argument('--allow-unredacted', action='store_true',
                    help='pilot-only escape hatch; NEVER for measured runs')
    args = ap.parse_args()
    for s in args.stages:
        if s == 'analyze':
            stage_analyze(args.run)
        else:
            {'pilot': stage_pilot, 'grid': stage_grid}[s](args.run, args.workers,
                                                          args.allow_unredacted)


if __name__ == '__main__':
    main()
