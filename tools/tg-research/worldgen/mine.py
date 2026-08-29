"""M3 miner (pre-registered in PREREG.md M3).

Scans RAW sweep traces for near-critical events between ANY actor pair (ego, ambient,
ambient-ambient). No summary metric is used as evidence; everything derives from
ticks + actorMetadata via tg_gate primitives. Emits events.jsonl + mining-summary.json.

Usage: mine.py <sweep-base-dir> [--out <dir>]
"""
import argparse, json, math, os, sys, time
from concurrent.futures import ProcessPoolExecutor

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
sys.path.insert(0, os.path.join(ROOT, 'tools', 'gates'))
import tg_gate as G                                                        # noqa: E402

# Registered thresholds (PREREG M3). Mirrors of frozen gate constants are labelled.
BROAD_M = 8.0            # candidate clearance ceiling
GAP_MERGE_S = 1.0        # window merge gap
T_MIN_S = 2.5            # t* must exceed this (mirror of gate C2 warmup+margin)
TTC_NEAR_S = 4.0
DECEL_NEAR = 2.5
T1_CLEAR_M = 5.0         # mirror C3_CLEARANCE
T1_TTC_S = 3.0           # mirror C4_TTC
STATIC_MPS = 0.5
STOP_MPS = 0.3
YIELD_DECEL = 2.0
CLOSING_MIN_MPS = 0.1
SMOOTH_TICKS = 5


def _arr(vals):
    return np.array([np.nan if v is None else float(v) for v in vals], dtype=np.float64)


def _smooth(x, w=SMOOTH_TICKS):
    """Moving average with edge-value padding: no zero-pad edge artifacts."""
    if len(x) < w:
        return x
    half = w // 2
    padded = np.concatenate((np.full(half, x[0]), x, np.full(w - 1 - half, x[-1])))
    return np.convolve(padded, np.ones(w) / w, mode='valid')


def heading_bucket(deg):
    if deg < 45.0:
        return 'same-dir'
    if deg <= 135.0:
        return 'crossing'
    return 'opposing'


def mine_trace(trace, cell):
    """All pair events for one raw trace. Returns (events, collisions_bucket)."""
    hdr = trace['header']
    ts = np.asarray(trace['ticks']['t'], dtype=np.float64)
    dt = float(hdr.get('dt', 0.02))
    meta = hdr.get('actorMetadata', {})
    ambient = set(hdr.get('ambientActorIds') or [])
    actors = {}
    for aid, a in trace['ticks']['actors'].items():
        d = meta.get(aid, {}).get('dims', {})
        l = float(d.get('l', 4.8 if aid == 'ego' else 0.6))
        w = float(d.get('w', 1.9 if aid == 'ego' else 0.6))
        actors[aid] = {
            'x': _arr(a['x']), 'y': _arr(a['y']), 'h': _arr(a['headingRad']),
            'v': _arr(a['speedMps']),
            'present': np.array(a['present'], dtype=bool),
            'lane': a.get('laneRsl') or [None] * len(ts),
            'lat': _arr(a.get('lateralOffsetM') or [0] * len(ts)),
            'l': l, 'w': w, 'r': math.hypot(l, w) / 2.0,
            'kind': meta.get(aid, {}).get('kind', 'car' if aid == 'ego' else '?'),
        }
    ids = sorted(actors)
    events, collisions = [], []
    raw_coll_pairs = {}
    for c in (trace.get('metrics', {}).get('collisions') or []):
        raw_coll_pairs.setdefault(frozenset((c.get('a'), c.get('b'))), []).append(
            float(c.get('t', -1.0)))

    for i in range(len(ids)):
        for j in range(i + 1, len(ids)):
            A, B = actors[ids[i]], actors[ids[j]]
            both = A['present'] & B['present']
            if not both.any():
                continue
            dx, dy = A['x'] - B['x'], A['y'] - B['y']
            centre = np.hypot(dx, dy)
            pad = A['r'] + B['r']
            cand = both & (centre - pad <= BROAD_M)
            if not cand.any():
                continue
            # OBB clearance on candidate ticks, memoised on relative pose.
            clear = np.full(len(ts), np.inf)
            memo = {}
            for k in np.flatnonzero(cand):
                key = (round(dx[k], 2), round(dy[k], 2),
                       round(A['h'][k], 3), round(B['h'][k], 3))
                cl = memo.get(key)
                if cl is None:
                    cl = G.obb_clearance(
                        G._corners(A['x'][k], A['y'][k], A['h'][k], A['l'], A['w']),
                        G._corners(B['x'][k], B['y'][k], B['h'][k], B['l'], B['w']))
                    memo[key] = cl
                clear[k] = cl
            hit = np.flatnonzero(clear <= BROAD_M)
            if hit.size == 0:
                continue
            # merge into windows (gap <= GAP_MERGE_S)
            gaps = np.flatnonzero(np.diff(hit) > GAP_MERGE_S / dt)
            bounds = np.concatenate(([0], gaps + 1, [hit.size]))
            for b in range(len(bounds) - 1):
                w_idx = hit[bounds[b]:bounds[b + 1]]
                ev = _window_event(ids[i], ids[j], A, B, ts, dt, clear, w_idx,
                                   ambient, cell, raw_coll_pairs)
                if ev is None:
                    continue
                (collisions if ev['collision'] else events).append(ev)
    return events, collisions


def _window_event(ida, idb, A, B, ts, dt, clear, w_idx, ambient, cell, raw_coll):
    t0i, t1i = int(w_idx[0]), int(w_idx[-1])
    va, vb = A['v'][w_idx], B['v'][w_idx]
    va_max, vb_max = np.nanmax(va), np.nanmax(vb)
    if va_max < STATIC_MPS and vb_max < STATIC_MPS:
        return None                                   # registered static-pair exclusion
    cw = clear[w_idx]
    kmin = int(w_idx[int(np.argmin(cw))])
    t_star = float(ts[kmin])
    min_clear = float(clear[kmin])
    if t_star <= T_MIN_S:
        return None                                   # spawn/settle guard (C2 mirror)

    # TTC_rr on contiguous candidate runs only (never across sub-threshold holes)
    ttc_rr = None
    run_bounds = np.flatnonzero(np.diff(w_idx) > 1)
    for a0, a1 in zip(np.concatenate(([0], run_bounds + 1)),
                      np.concatenate((run_bounds, [w_idx.size - 1]))):
        run = w_idx[a0:a1 + 1]
        if run.size < 2:
            continue
        cw_run = clear[run]
        closing = -np.gradient(_smooth(cw_run), dt)
        with np.errstate(divide='ignore', invalid='ignore'):
            ttc = np.where(closing > CLOSING_MIN_MPS, cw_run / closing, np.inf)
        m = float(np.min(ttc))
        if math.isfinite(m) and (ttc_rr is None or m < ttc_rr):
            ttc_rr = m

    # max decel per actor over window +-1 s, only on contiguous PRESENT runs
    ext0, ext1 = max(0, t0i - int(1 / dt)), min(len(ts) - 1, t1i + int(1 / dt))
    def max_decel(V, P):
        seg = np.where(P[ext0:ext1 + 1], V[ext0:ext1 + 1], np.nan)
        best = 0.0
        finite = np.isfinite(seg)
        if not finite.any():
            return best
        starts = np.flatnonzero(finite & ~np.roll(finite, 1))
        ends = np.flatnonzero(finite & ~np.roll(finite, -1))
        if finite[0]:
            starts = np.concatenate(([0], starts[starts != 0]))
        if finite[-1]:
            ends = np.concatenate((ends[ends != len(seg) - 1], [len(seg) - 1]))
        for s0, s1 in zip(starts, ends):
            run = seg[s0:s1 + 1]
            if len(run) < SMOOTH_TICKS + 1:
                continue
            best = max(best, float(np.max(-np.gradient(_smooth(run), dt))))
        return max(0.0, best)
    dec_a, dec_b = max_decel(A['v'], A['present']), max_decel(B['v'], B['present'])

    pair_key = frozenset((ida, idb))
    coll_ts = raw_coll.get(pair_key, ())
    collision = bool(min_clear <= 0.0 or
                     any(ts[t0i] - 0.25 <= ct <= ts[t1i] + 0.25 for ct in coll_ts))
    near = bool(min_clear <= BROAD_M and
                ((ttc_rr is not None and ttc_rr <= TTC_NEAR_S) or
                 max(dec_a, dec_b) >= DECEL_NEAR))
    if not (near or collision):
        return None
    tier = 'T1' if (min_clear <= T1_CLEAR_M and ttc_rr is not None
                    and ttc_rr <= T1_TTC_S) else 'T2'

    rel_head = math.degrees(abs(math.atan2(
        math.sin(A['h'][kmin] - B['h'][kmin]), math.cos(A['h'][kmin] - B['h'][kmin]))))
    lane_a, lane_b = A['lane'][kmin], B['lane'][kmin]
    lane_rel = 'same' if (lane_a is not None and lane_a == lane_b) else 'different'

    sa, sb = float(A['v'][kmin]), float(B['v'][kmin])
    if min(sa, sb) < STATIC_MPS:
        movement = 'counterpart-stopped'
        stopped = ida if sa < sb else idb
    elif max(sa, sb) < 3.0:
        movement, stopped = 'low-speed-both', None
    else:
        movement, stopped = 'both-moving', None

    # was the stopped actor stopped >= 2 s before the window? (C9/C11 rule input)
    pre_stopped = False
    if stopped:
        V = (A if stopped == ida else B)['v']
        pre0 = max(0, t0i - int(2.0 / dt))
        seg = V[pre0:t0i + 1]
        seg = seg[~np.isnan(seg)]
        pre_stopped = bool(len(seg) > 0 and np.nanmax(seg) < STATIC_MPS)

    # lateral convergence inside window
    lat_conv = bool(abs((A['lat'][kmin] or 0) - (A['lat'][t0i] or 0)) >= 0.5 or
                    abs((B['lat'][kmin] or 0) - (B['lat'][t0i] or 0)) >= 0.5 or
                    A['lane'][t0i] != lane_a or B['lane'][t0i] != lane_b)

    # yield-forced stop: reaches < STOP_MPS inside window after decel >= YIELD_DECEL
    def yield_stop(V):
        seg = V[t0i:t1i + 1]
        seg = seg[~np.isnan(seg)]
        if len(seg) < SMOOTH_TICKS + 1 or np.min(seg) >= STOP_MPS:
            return False
        stop_at = int(np.argmax(seg < STOP_MPS))
        if stop_at < 2:
            return False
        dec = -np.gradient(_smooth(seg[:stop_at + 1]), dt)
        return bool(np.max(dec) >= YIELD_DECEL)
    y_stop = bool(yield_stop(A['v']) or yield_stop(B['v']))

    ego_involved = 'ego' in (ida, idb)
    kinds = sorted([A['kind'] if not ida == 'ego' else 'ego',
                    B['kind'] if not idb == 'ego' else 'ego'])
    hb = heading_bucket(rel_head)
    sig = (hb, lane_rel, '+'.join(k if k != 'ego' else 'car' for k in kinds), movement)

    cat = classify(hb, lane_rel, movement, pre_stopped, y_stop, lat_conv,
                   [A['kind'], B['kind']], cell['template'],
                   speed_at_start=max(float(np.nan_to_num(A['v'][t0i])),
                                      float(np.nan_to_num(B['v'][t0i]))))
    return {
        'cell': {k: cell[k] for k in ('template', 'map', 'preset', 'density', 'seed',
                                      'site', 'out')},
        'trace': cell['trace'],
        'pair': [ida, idb], 'kinds': kinds, 'egoInvolved': ego_involved,
        'ambientOnly': ida in ambient and idb in ambient,
        'window': [float(ts[t0i]), float(ts[t1i])], 'tStar': t_star,
        'minClearanceM': round(min_clear, 3),
        'speedsAtStart': [round(float(np.nan_to_num(A['v'][t0i])), 2),
                          round(float(np.nan_to_num(B['v'][t0i])), 2)],
        'speedsAtTStar': [round(sa, 2), round(sb, 2)],
        'ttcRrS': None if ttc_rr is None or not math.isfinite(ttc_rr) else round(ttc_rr, 3),
        'maxDecel': [round(dec_a, 3), round(dec_b, 3)],
        'relHeadingDeg': round(rel_head, 1), 'laneRelation': lane_rel,
        'movement': movement, 'preStopped': pre_stopped, 'yieldStop': y_stop,
        'lateralConvergence': lat_conv,
        'collision': collision, 'tier': None if collision else tier,
        'signature': list(sig), 'category': None if collision else cat,
    }


def classify(hb, lane_rel, movement, pre_stopped, y_stop, lat_conv, kinds, template,
             speed_at_start):
    """Registered taxonomy rules, applied in PREREG order."""
    ks = set(kinds)
    if 'pedestrian' in ks:
        return 'C5'
    if 'bicycle' in ks or 'motorcycle' in ks:
        return 'C6'
    if hb == 'opposing':
        return 'C10'
    if hb == 'crossing':
        return 'C3' if template == 'junction' else 'C2'
    # same-dir from here
    if lane_rel == 'same' and movement == 'counterpart-stopped' and pre_stopped:
        return 'C9' if speed_at_start >= 3.0 else 'C11'
    if lane_rel == 'same':
        return 'C1'
    if lat_conv:
        return 'C2'
    if y_stop and template == 'junction':
        return 'C3'
    return 'C1-adjacent'


def process_cell(cell):
    try:
        tr = G.load_trace(cell['trace'])
    except Exception as e:                                                  # noqa: BLE001
        return {'cell': cell, 'error': str(e), 'events': [], 'collisions': []}
    ev, coll = mine_trace(tr, cell)
    return {'cell': cell, 'events': ev, 'collisions': coll,
            'nAmbient': len(tr['header'].get('ambientActorIds') or [])}


def collect_cells(base):
    cells = []
    man = os.path.join(base, 'sweep-manifest.jsonl')
    for line in open(man):
        row = json.loads(line)
        summ_path = os.path.join(row['out'], 'batch-summary.json')
        if not os.path.exists(summ_path):
            continue
        s = json.load(open(summ_path))
        for r in s.get('results', []):
            if r.get('status') != 'ok' or not r.get('traceFile'):
                continue
            cells.append({'template': row['template'], 'map': row['map'],
                          'preset': row['preset'], 'density': row['density'],
                          'seed': row['seed'], 'site': r['siteId'], 'out': row['out'],
                          'trace': r['traceFile'], 'verdict': r.get('verdict'),
                          'band': r.get('band')})
    return cells


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('base')
    ap.add_argument('--out', default=None)
    ap.add_argument('--workers', type=int, default=6)
    args = ap.parse_args()
    out_dir = args.out or os.path.join(args.base, 'mining')
    os.makedirs(out_dir, exist_ok=True)
    cells = collect_cells(args.base)
    print('cells to mine: %d' % len(cells), flush=True)
    t0 = time.time()
    events, collisions, errors, ambient_counts = [], [], [], []
    with ProcessPoolExecutor(max_workers=args.workers) as ex:
        for res in ex.map(process_cell, cells, chunksize=8):
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
            key = '%s|%s|%s|%s' % (c['template'], c['map'], c['preset'],
                                   c['density'] or 'def')
            table.setdefault(key, {'cells': 0, 'T1': 0, 'T2': 0, 'ego': 0,
                                   'ambientOnly': 0, 'events': 0})['cells'] += 1
        for e in evts:
            c = e['cell']
            key = '%s|%s|%s|%s' % (c['template'], c['map'], c['preset'],
                                   c['density'] or 'def')
            t = table[key]
            t['events'] += 1
            t[e['tier']] += 1
            t['ego' if e['egoInvolved'] else 'ambientOnly'] += 1
        for t in table.values():
            t['per1000runs'] = round(t['events'] / t['cells'] * 1000, 1) if t['cells'] else None
            t['T1per1000'] = round(t['T1'] / t['cells'] * 1000, 1) if t['cells'] else None
        return table

    cats, sigs = {}, {}
    for e in events:
        cats[e['category']] = cats.get(e['category'], 0) + 1
        s = '|'.join(e['signature'])
        sigs[s] = sigs.get(s, 0) + 1
    summary = {
        'cellsMined': len(cells), 'errors': errors[:20], 'nErrors': len(errors),
        'wallS': round(wall, 1),
        'events': len(events), 'collisions': len(collisions),
        'meanAmbientActors': round(float(np.mean(ambient_counts)), 2) if ambient_counts else None,
        'yieldTable': yield_table(events, cells),
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
