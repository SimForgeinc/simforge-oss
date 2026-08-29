#!/usr/bin/env python3
"""Calibration measurement for the realism instrument. Stream B, tg-rethink.

Stages (resumable, state in RUN dir):
    calibrate.py metrics    -> scores.jsonl      (deterministic battery per cell)
    calibrate.py render     -> strips/*.png      (anonymized filmstrips)
    calibrate.py judge      -> judgments.jsonl   (blind vision judge, seeded-shuffled order)
    calibrate.py analyze    -> calibration.json  (AUC tables, CIs, confusion matrices)

Everything follows PREREG.md; axes, composites, seeds and thresholds are fixed there.
"""
import argparse
import glob
import json
import math
import os
import random
import sys
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, '..', '..', 'gates'))

RUN = os.environ.get('TGR_CALIB_RUN', '/tmp/tgr-instrument-calib1')
SEED = 20260815
ARMS = ('rplus', 'rminus', 'bplus')
JUDGE_WORKERS = 6


def cells():
    """[(arm, template, cellDir, draw, instancePath, tracePath)] in stable order."""
    out = []
    for arm in ARMS:
        for tp in sorted(glob.glob(os.path.join(RUN, arm, '*', '*', '*', 'draw-*.trace.json.gz'))):
            cell_dir = os.path.dirname(tp)
            draw = os.path.basename(tp).split('.')[0]
            template = os.path.relpath(cell_dir, os.path.join(RUN, arm)).split(os.sep)[0]
            ip = os.path.join(cell_dir, f'{draw}.instance.json')
            out.append((arm, template, cell_dir, draw,
                        ip if os.path.exists(ip) else None, tp))
    return out


def cell_id(arm, template, cell_dir, draw):
    parts = cell_dir.split(os.sep)
    return f'{arm}__{template}__{parts[-2]}__{parts[-1]}__{draw}'


def stage_metrics():
    import tg_gate
    from metrics import compute_metrics
    path = os.path.join(RUN, 'scores.jsonl')
    done = set()
    if os.path.exists(path):
        with open(path) as f:
            done = {json.loads(l)['id'] for l in f if l.strip()}
    with open(path, 'a') as out:
        for arm, template, cd, draw, ip, tp in cells():
            cid = cell_id(arm, template, cd, draw)
            if cid in done:
                continue
            instance = json.load(open(ip)) if ip else None
            m = compute_metrics(tg_gate.load_trace(tp), instance)
            out.write(json.dumps({'id': cid, 'arm': arm, 'template': template,
                                  'cellDir': cd, 'draw': draw, 'metrics': m}) + '\n')
    print(f'metrics: {sum(1 for _ in open(path))} rows')


def stage_render():
    import tg_gate
    from filmstrip import render_filmstrip
    strips = os.path.join(RUN, 'strips')
    os.makedirs(strips, exist_ok=True)
    n = 0
    for arm, template, cd, draw, ip, tp in cells():
        png = os.path.join(strips, cell_id(arm, template, cd, draw) + '.png')
        if os.path.exists(png):
            continue
        instance = json.load(open(ip)) if ip else None
        render_filmstrip(tg_gate.load_trace(tp), instance, png)
        n += 1
    print(f'render: {n} new strips, total {len(os.listdir(strips))}')


def stage_judge():
    from judge import assert_vision_or_die, judge_image, DEFAULT_MODEL
    assert_vision_or_die(DEFAULT_MODEL)  # fatal preflight, once
    path = os.path.join(RUN, 'judgments.jsonl')
    done = set()
    if os.path.exists(path):
        with open(path) as f:
            done = {json.loads(l)['id'] for l in f if l.strip()}
    todo = []
    for arm, template, cd, draw, ip, tp in cells():
        cid = cell_id(arm, template, cd, draw)
        png = os.path.join(RUN, 'strips', cid + '.png')
        if cid not in done and os.path.exists(png):
            todo.append((cid, png))
    random.Random(SEED).shuffle(todo)  # blind protocol: randomized judging order
    print(f'judge: {len(todo)} to go, {len(done)} done')
    out = open(path, 'a')

    def one(item):
        cid, png = item
        try:
            j = judge_image(png)
            return {'id': cid, 'judge': j}
        except Exception as e:  # noqa: BLE001
            return {'id': cid, 'error': f'{type(e).__name__}: {e}'}

    with ThreadPoolExecutor(max_workers=JUDGE_WORKERS) as pool:
        for row in pool.map(one, todo):
            out.write(json.dumps(row) + '\n')
            out.flush()
    out.close()


# ---------------------------------------------------------------- analysis helpers
def auc(pos, neg):
    """Mann-Whitney AUC with midranks (ties)."""
    both = sorted((v, 1) for v in pos) + sorted((v, 0) for v in neg)
    both.sort(key=lambda r: r[0])
    ranks = {}
    i = 0
    while i < len(both):
        j = i
        while j < len(both) and both[j][0] == both[i][0]:
            j += 1
        mid = (i + 1 + j) / 2.0
        for k in range(i, j):
            ranks[k] = mid
        i = j
    r_pos = sum(ranks[k] for k, (_, lab) in enumerate(both) if lab == 1)
    n1, n0 = len(pos), len(neg)
    return (r_pos - n1 * (n1 + 1) / 2.0) / (n1 * n0) if n1 and n0 else None


def auc_ci(pos, neg, n_boot=1000, seed=SEED):
    rng = random.Random(seed)
    vals = []
    for _ in range(n_boot):
        p = [pos[rng.randrange(len(pos))] for _ in pos]
        q = [neg[rng.randrange(len(neg))] for _ in neg]
        a = auc(p, q)
        if a is not None:
            vals.append(a)
    vals.sort()
    return (vals[int(0.025 * len(vals))], vals[int(0.975 * len(vals))]) if vals else (None, None)


def youden_confusion(pos, neg):
    """Threshold maximizing TPR - FPR; returns threshold + confusion counts."""
    best = None
    for thr in sorted(set(pos) | set(neg)):
        tp = sum(1 for v in pos if v >= thr)
        fn = len(pos) - tp
        fp = sum(1 for v in neg if v >= thr)
        tn = len(neg) - fp
        j = tp / len(pos) - fp / len(neg)
        if best is None or j > best[0]:
            best = (j, thr, tp, fn, fp, tn)
    j, thr, tp, fn, fp, tn = best
    return {'threshold': thr, 'youdenJ': round(j, 3), 'tp': tp, 'fn': fn, 'fp': fp, 'tn': tn}


def spearman(xs, ys):
    def rank(v):
        order = sorted(range(len(v)), key=lambda i: v[i])
        r = [0.0] * len(v)
        i = 0
        while i < len(order):
            j = i
            while j < len(order) and v[order[j]] == v[order[i]]:
                j += 1
            mid = (i + 1 + j) / 2.0
            for k in range(i, j):
                r[order[k]] = mid
            i = j
        return r
    rx, ry = rank(xs), rank(ys)
    mx, my = sum(rx) / len(rx), sum(ry) / len(ry)
    num = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    den = math.sqrt(sum((a - mx) ** 2 for a in rx) * sum((b - my) ** 2 for b in ry))
    return num / den if den else None


def stage_analyze():
    rows = {}
    with open(os.path.join(RUN, 'scores.jsonl')) as f:
        for l in f:
            r = json.loads(l)
            rows[r['id']] = r
    judged = {}
    judge_errors = []
    jpath = os.path.join(RUN, 'judgments.jsonl')
    if os.path.exists(jpath):
        with open(jpath) as f:
            for l in f:
                r = json.loads(l)
                if 'judge' in r:
                    judged[r['id']] = r['judge']
                else:
                    judge_errors.append(r)

    def arm_of(cid):
        return cid.split('__')[0]

    # instrument extractors per PREREG
    def metric_alive(r):
        return r['metrics']['aliveness_score']

    def metric_natural(r):
        return -r['metrics']['naturalism_penalty']

    def judge_alive(j):
        return (j['density_plausible'] + j['reactions_present']) / 2.0

    def judge_natural(j):
        return (j['motion_natural'] + j['scene_coherent']) / 2.0

    def judge_overall(j):
        return j['overall']

    axes = {}
    # aliveness: R+ pos vs R- neg; naturalism: healthy pos vs B+ neg
    splits = {
        'aliveness': (['rplus'], ['rminus']),
        'naturalism': (['rplus', 'rminus'], ['bplus']),
    }
    instruments = {
        'aliveness': {
            'metrics.aliveness_score': lambda cid: metric_alive(rows[cid]),
            'judge.density+reactions': lambda cid: judge_alive(judged[cid]) if cid in judged else None,
            'judge.overall': lambda cid: judge_overall(judged[cid]) if cid in judged else None,
        },
        'naturalism': {
            'metrics.-naturalism_penalty': lambda cid: metric_natural(rows[cid]),
            'judge.motion+coherence': lambda cid: judge_natural(judged[cid]) if cid in judged else None,
            'judge.overall': lambda cid: judge_overall(judged[cid]) if cid in judged else None,
        },
    }
    for axis, (pos_arms, neg_arms) in splits.items():
        axes[axis] = {}
        pos_ids = [cid for cid in rows if arm_of(cid) in pos_arms]
        neg_ids = [cid for cid in rows if arm_of(cid) in neg_arms]
        for name, fn in instruments[axis].items():
            pos = [fn(c) for c in pos_ids]
            neg = [fn(c) for c in neg_ids]
            pos = [v for v in pos if v is not None]
            neg = [v for v in neg if v is not None]
            if not pos or not neg:
                axes[axis][name] = None
                continue
            a = auc(pos, neg)
            lo, hi = auc_ci(pos, neg)
            axes[axis][name] = {
                'auc': round(a, 4), 'ci95': [round(lo, 4), round(hi, 4)],
                'n_pos': len(pos), 'n_neg': len(neg),
                'confusion_youden': youden_confusion(pos, neg),
            }

    # secondary: per-component AUCs on their axis
    component_auc = {}
    comp_axis = {
        'aliveness': ['actor_count_mean', 'moving_actor_count_mean', 'nonego_reactive_decels',
                      'lane_change_count', 'signal_phase_changes', 'interacting_fraction',
                      'queue_max_cluster', 'pet_pairs_total', 'speed_mean_std'],
        'naturalism': ['teleport_ticks', 'heading_jump_ticks', 'accel_viol_frac', 'frozen_ego',
                       'nonstatic_stopped_count', 'authored_stop_violations', 'prop_overlap_count',
                       'vru_overspeed_count'],
    }
    for axis, comps in comp_axis.items():
        pos_arms, neg_arms = splits[axis]
        pos_ids = [cid for cid in rows if arm_of(cid) in pos_arms]
        neg_ids = [cid for cid in rows if arm_of(cid) in neg_arms]
        sign = 1.0 if axis == 'aliveness' else -1.0  # naturalism components are defect counts
        component_auc[axis] = {}
        for comp in comps:
            pos = [sign * rows[c]['metrics'][comp] for c in pos_ids
                   if rows[c]['metrics'].get(comp) is not None]
            neg = [sign * rows[c]['metrics'][comp] for c in neg_ids
                   if rows[c]['metrics'].get(comp) is not None]
            if pos and neg:
                component_auc[axis][comp] = round(auc(pos, neg), 4)

    # judge-metric agreement (all judged cells)
    common = [cid for cid in rows if cid in judged]
    agreement = {}
    if len(common) > 2:
        agreement['aliveness_spearman'] = round(spearman(
            [metric_alive(rows[c]) for c in common], [judge_alive(judged[c]) for c in common]), 4)
        agreement['naturalism_spearman'] = round(spearman(
            [metric_natural(rows[c]) for c in common], [judge_natural(judged[c]) for c in common]), 4)

    # per-broken-class breakdown (naturalism instruments on each B+ class vs healthy)
    per_class = {}
    class_of = {'b1-frozen-ego': 'B1-frozen-ego', 'b2-zero-kph': 'B2-zero-kph',
                'c7-bus-shelter-baseline': 'B3-vru-occluder', 'c7-hedge-corner-baseline': 'B3-vru-occluder'}
    healthy_ids = [cid for cid in rows if arm_of(cid) in ('rplus', 'rminus')]
    for cls in sorted(set(class_of.values())):
        ids = [cid for cid in rows if arm_of(cid) == 'bplus'
               and class_of.get(rows[cid]['template']) == cls]
        if not ids:
            continue
        entry = {'n': len(ids)}
        pos = [metric_natural(rows[c]) for c in healthy_ids]
        neg = [metric_natural(rows[c]) for c in ids]
        entry['metrics_auc'] = round(auc(pos, neg), 4)
        jp = [judge_natural(judged[c]) for c in healthy_ids if c in judged]
        jn = [judge_natural(judged[c]) for c in ids if c in judged]
        if jp and jn:
            entry['judge_auc'] = round(auc(jp, jn), 4)
        per_class[cls] = entry

    lat = [j['latency_s'] for j in judged.values() if j.get('latency_s')]
    lat.sort()
    counts = {}
    for cid in rows:
        counts[arm_of(cid)] = counts.get(arm_of(cid), 0) + 1

    report = {
        'run': RUN,
        'seed': SEED,
        'cells_per_arm': counts,
        'judged': len(judged),
        'judge_errors': len(judge_errors),
        'primary_auc': axes,
        'component_auc': component_auc,
        'judge_metric_agreement': agreement,
        'per_broken_class_naturalism': per_class,
        'judge_latency_s': {'median': lat[len(lat) // 2] if lat else None,
                            'p90': lat[int(0.9 * len(lat))] if lat else None},
    }
    out = os.path.join(RUN, 'calibration.json')
    with open(out, 'w') as f:
        json.dump(report, f, indent=1)
    print(json.dumps(report, indent=1))


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('stage', choices=['metrics', 'render', 'judge', 'analyze', 'all'])
    args = ap.parse_args()
    stages = ['metrics', 'render', 'judge', 'analyze'] if args.stage == 'all' else [args.stage]
    for s in stages:
        globals()[f'stage_{s}']()


if __name__ == '__main__':
    main()
