#!/usr/bin/env python3
"""Pre-registered dynamism census — RETHINK-CONTRACTS.md section 4, implemented exactly.

Shared instrument for every rethink stream (built by A/FreeformLane, consumed read-only by
all). Reports that use it freeze it by sha256. No metric is added, removed, or redefined
after the first measured arm without a version bump reported as such.

Supersedes tools/tg-research/openvocab/census.py (prior lead session): that census
measured a different, un-contracted metric set (verbsFired, unscriptedStops, ...) per
admitted brief; this one implements the RETHINK-CONTRACTS section 4 list per cell. Its
laneRsl neighbour-transition reading is kept, hardened with the lateral-sweep requirement.

Every metric is computed from the RAW columnar trace (`ticks.actors[id].{x,y,headingRad,
speedMps,lateralOffsetM,laneRsl,present}`, `ticks.signals[id].phase`, `events[]`), never
from summary fields. The materialized `instance.json` supplies only `authoredEventsTotal`
(the count of authored interactions — an *input*, not a summary).

Metric definitions (CONTRACT, verbatim intent; operationalisation noted where the contract
leaves a constant open — those constants are part of this frozen file):

- actorsMoving          actors with >= 5 m travelled and >= 1 m/s max speed.
- laneChangesExecuted   realized lane-change maneuvers: laneRsl transition where road and
                        section stay the same and the lane id changes (a NEIGHBOUR move,
                        never a chain successor, which changes road/section), confirmed by
                        a lateral sweep: max |lateralOffsetM| >= 0.8 m within +-1.0 s of
                        the transition tick.
- swerveEvents          per actor: |lateral offset - baseline| excursions >= 0.8 m WITH
                        return (back to <= 0.3 m of baseline). Baseline = median offset
                        over the actor's first second of presence. Ticks within +-0.6 s of
                        a laneRsl transition are excluded so a lane change's reference
                        switch is not double-counted as a swerve; tick-to-tick offset
                        jumps > 1.5 m (reference-lane remap) close no excursion.
- signalPhaseChanges    phase transitions across consecutive recorded ticks, summed over
                        every signal track in `ticks.signals` (signal programs + mid-clip
                        overrides both surface here; empty/absent block = 0).
- interactingPairs      distinct actor pairs whose pairwise TTC < 5 s at any tick. TTC at
                        a tick: centre distance minus both actors' half-diagonal radii,
                        divided by the closing speed (finite-difference velocities),
                        defined only while closing > 0.05 m/s; floored at 0.
- speedVarianceEgoPath  population variance of ego speed over its present ticks.
- hardBrakeEvents       decel >= 3 m/s^2 sustained >= 0.5 s, any actor: maximal runs of
                        consecutive present ticks with smoothed (5-tick boxcar) forward
                        deceleration >= 3.0, run length >= 0.5 s.
- authoredEventsFired   distinct interactionIds among trace `events` kind=trigger_fired.
- authoredEventsTotal   len(instance.input.interactions) (materialized authored timeline);
                        falls back to the template's choreography.interactions count when
                        only a template is available.
- actorCount            non-ambient actor tracks in the trace.
- ambientCount          header.ambientActorIds with a track in the trace.

Per-cell row + per-arm aggregate (`aggregate(rows)`).

Usage:
  dynamism_census.py --self-test [--smoke-dir /tmp/tgr-lead-smoke]
  dynamism_census.py --cells CELLDIR [CELLDIR ...] [--out rows.json]
  dynamism_census.py --traces T.trace.json.gz [...] [--out rows.json]
A cell dir follows the rethink cell contract (instance.json + trace.json.gz); a raw batch
draw pair (draw-K.trace.json.gz + draw-K.instance.json) is accepted the same way.
"""
import argparse, glob, gzip, json, math, os, statistics, sys

CENSUS_VERSION = 1

LANE_SWEEP_M = 0.8          # lateral sweep confirming a lane change
LANE_SWEEP_WINDOW_S = 1.0
SWERVE_EXCURSION_M = 0.8    # contract: >= 0.8 m with return
SWERVE_RETURN_M = 0.3
SWERVE_MIN_TICKS = 3
SWERVE_LANE_GUARD_S = 0.6
SWERVE_JUMP_M = 1.5
TTC_INTERACT_S = 5.0        # contract: pairwise TTC < 5 s
TTC_MIN_CLOSING = 0.05
HARD_BRAKE_MPS2 = 3.0       # contract: decel >= 3 m/s^2
HARD_BRAKE_MIN_S = 0.5      # contract: sustained >= 0.5 s
MOVING_DIST_M = 5.0         # contract: >= 5 m travelled
MOVING_SPEED_MPS = 1.0      # contract: >= 1 m/s max speed


def load_trace(path):
    op = gzip.open if str(path).endswith('.gz') else open
    with op(path, 'rb') as f:
        return json.loads(f.read())


def _rsl(s):
    """'road:section:lane' -> (road, section, lane) or None."""
    if not isinstance(s, str):
        return None
    bits = s.split(':')
    return (bits[0], bits[1], bits[2]) if len(bits) == 3 else None


def _present_speeds(track):
    return [v for v, pr in zip(track['speedMps'], track['present']) if pr]


def _travel(track):
    d, px, py = 0.0, None, None
    for x, y, pr in zip(track['x'], track['y'], track['present']):
        if not pr:
            px = py = None
            continue
        if px is not None:
            d += math.hypot(x - px, y - py)
        px, py = x, y
    return d


def _lane_transitions(track):
    """Indices i where laneRsl changes between consecutive present ticks."""
    out = []
    lr, pres = track.get('laneRsl') or [], track['present']
    prev_i = None
    for i in range(len(pres)):
        if not pres[i]:
            continue
        if prev_i is not None and lr[i] != lr[prev_i]:
            out.append(i)
        prev_i = i
    return out


def _lane_changes(track, dt):
    """Contract: neighbour laneRsl transition + lateral sweep; chain successors excluded."""
    n = 0
    lr = track.get('laneRsl') or []
    off = track.get('lateralOffsetM') or []
    pres = track['present']
    if not lr or not off:
        return 0
    win = max(1, int(round(LANE_SWEEP_WINDOW_S / dt)))
    prev_i = None
    for i in range(len(pres)):
        if not pres[i]:
            continue
        if prev_i is not None and lr[i] != lr[prev_i]:
            a, b = _rsl(lr[prev_i]), _rsl(lr[i])
            if a and b and a[0] == b[0] and a[1] == b[1] and a[2] != b[2]:
                lo, hi = max(0, i - win), min(len(pres), i + win + 1)
                sweep = max((abs(off[j]) for j in range(lo, hi)
                             if pres[j] and off[j] is not None), default=0.0)
                if sweep >= LANE_SWEEP_M:
                    n += 1
        prev_i = i
    return n


def _swerves(track, dt):
    """Excursions >= SWERVE_EXCURSION_M from baseline with return, lane-change-guarded."""
    off, pres = track.get('lateralOffsetM') or [], track['present']
    idx = [i for i in range(len(pres)) if pres[i] and i < len(off) and off[i] is not None]
    if len(idx) < SWERVE_MIN_TICKS + 2:
        return 0
    first_s = [off[i] for i in idx[:max(1, int(round(1.0 / dt)))]]
    base = statistics.median(first_s)
    guard = set()
    g = max(1, int(round(SWERVE_LANE_GUARD_S / dt)))
    for i in _lane_transitions(track):
        guard.update(range(max(0, i - g), min(len(pres), i + g + 1)))
    n, in_exc, exc_ticks, prev = 0, False, 0, None
    for i in idx:
        v = off[i]
        if prev is not None and abs(v - prev) > SWERVE_JUMP_M:
            in_exc, exc_ticks = False, 0          # reference remap: void the excursion
            prev = v
            continue
        prev = v
        if i in guard:
            in_exc, exc_ticks = False, 0
            continue
        dev = abs(v - base)
        if not in_exc:
            if dev >= SWERVE_EXCURSION_M:
                in_exc, exc_ticks = True, 1
        else:
            if dev >= SWERVE_EXCURSION_M:
                exc_ticks += 1
            elif dev <= SWERVE_RETURN_M:
                if exc_ticks >= SWERVE_MIN_TICKS:
                    n += 1                        # returned: a completed swerve
                in_exc, exc_ticks = False, 0
    return n


def _signal_changes(trace):
    n = 0
    for sid, tr in (trace['ticks'].get('signals') or {}).items():
        ph = tr.get('phase') or []
        n += sum(1 for i in range(1, len(ph))
                 if ph[i] is not None and ph[i - 1] is not None and ph[i] != ph[i - 1])
    return n


def _radius(meta, aid, default_lw):
    d = (meta.get(aid) or {}).get('dims') or {}
    return math.hypot(d.get('l', default_lw[0]), d.get('w', default_lw[1])) / 2.0


def _interacting_pairs(trace):
    """Distinct pairs with pairwise TTC < 5 s at any tick (numpy; all actors)."""
    import numpy as np
    ticks = trace['ticks']
    ts = ticks['t']
    if len(ts) < 3:
        return 0, []
    dt = (ts[-1] - ts[0]) / max(1, len(ts) - 1)
    meta = trace['header'].get('actorMetadata') or {}
    ids, X, Y, P, R, V = [], [], [], [], [], []
    for aid, tr in ticks['actors'].items():
        ids.append(aid)
        x = np.asarray(tr['x'], dtype=float)
        y = np.asarray(tr['y'], dtype=float)
        X.append(x)
        Y.append(y)
        P.append(np.asarray(tr['present'], dtype=bool))
        R.append(_radius(meta, aid, (0.6, 0.6)))
        V.append((np.gradient(x, dt), np.gradient(y, dt)))
    pairs = []
    for i in range(len(ids)):
        vi_x, vi_y = V[i]
        for j in range(i + 1, len(ids)):
            both = P[i] & P[j]
            if not both.any():
                continue
            rx, ry = X[j] - X[i], Y[j] - Y[i]
            dist = np.hypot(rx, ry)
            pad = R[i] + R[j]
            vj_x, vj_y = V[j]
            dvx, dvy = vj_x - vi_x, vj_y - vi_y
            with np.errstate(divide='ignore', invalid='ignore'):
                closing = -(rx * dvx + ry * dvy) / np.where(dist > 1e-9, dist, np.nan)
            valid = both & (closing > TTC_MIN_CLOSING)
            if not valid.any():
                continue
            with np.errstate(divide='ignore', invalid='ignore'):
                ttc = np.maximum(dist - pad, 0.0) / closing
            if bool((ttc[valid] < TTC_INTERACT_S).any()):
                pairs.append((ids[i], ids[j]))
    return len(pairs), pairs


def _hard_brakes(track, dt):
    sp, pres = track['speedMps'], track['present']
    xs = [(i, v) for i, v in enumerate(sp) if pres[i] and v is not None]
    if len(xs) < 6:
        return 0
    idxs = [i for i, _ in xs]
    vals = [v for _, v in xs]
    k = 5
    sm = []
    for i in range(len(vals)):
        lo, hi = max(0, i - k // 2), min(len(vals), i + k // 2 + 1)
        sm.append(sum(vals[lo:hi]) / (hi - lo))
    need = max(1, int(round(HARD_BRAKE_MIN_S / dt)))
    n, run = 0, 0
    for a in range(1, len(sm)):
        contiguous = (idxs[a] - idxs[a - 1]) == 1
        decel = (sm[a - 1] - sm[a]) / dt if contiguous else 0.0
        if contiguous and decel >= HARD_BRAKE_MPS2:
            run += 1
            if run == need:
                n += 1                            # one event per maximal run
        else:
            run = 0
    return n


def authored_events_total(instance=None, template=None):
    if isinstance(instance, dict):
        inp = instance.get('input') or {}
        ia = inp.get('interactions')
        if isinstance(ia, list):
            return len(ia)
    if isinstance(template, dict):
        ch = template.get('choreography') or {}
        ia = ch.get('interactions')
        if isinstance(ia, list):
            return len(ia)
    return None


def census_cell(trace, instance=None, template=None):
    """One per-cell census row. `trace` is a path or a loaded trace dict."""
    if not isinstance(trace, dict):
        trace = load_trace(trace)
    hdr, ticks = trace['header'], trace['ticks']
    ts = ticks['t']
    dt = hdr.get('dt') or ((ts[-1] - ts[0]) / max(1, len(ts) - 1) if len(ts) > 1 else 0.02)
    ambient = set(hdr.get('ambientActorIds') or [])
    actors = ticks['actors']

    moving = lane_changes = swerves = brakes = 0
    for aid, tr in actors.items():
        sp = _present_speeds(tr)
        if sp and max(sp) >= MOVING_SPEED_MPS and _travel(tr) >= MOVING_DIST_M:
            moving += 1
        lane_changes += _lane_changes(tr, dt)
        swerves += _swerves(tr, dt)
        brakes += _hard_brakes(tr, dt)

    n_pairs, _ = _interacting_pairs(trace)

    ego = actors.get('ego')
    ego_speeds = _present_speeds(ego) if ego else []
    speed_var = statistics.pvariance(ego_speeds) if len(ego_speeds) > 1 else 0.0

    fired = {e.get('interactionId') for e in (trace.get('events') or [])
             if e.get('kind') == 'trigger_fired' and e.get('interactionId')}
    total = authored_events_total(instance, template)

    return {
        'censusVersion': CENSUS_VERSION,
        'mapId': hdr.get('mapId'), 'seed': hdr.get('seed'), 'inputHash': hdr.get('inputHash'),
        'actorsMoving': moving,
        'laneChangesExecuted': lane_changes,
        'swerveEvents': swerves,
        'signalPhaseChanges': _signal_changes(trace),
        'interactingPairs': n_pairs,
        'speedVarianceEgoPath': round(speed_var, 4),
        'hardBrakeEvents': brakes,
        'authoredEventsFired': len(fired),
        'authoredEventsTotal': total,
        'actorCount': sum(1 for a in actors if a not in ambient),
        'ambientCount': sum(1 for a in actors if a in ambient),
    }


NUMERIC = ('actorsMoving', 'laneChangesExecuted', 'swerveEvents', 'signalPhaseChanges',
           'interactingPairs', 'speedVarianceEgoPath', 'hardBrakeEvents',
           'authoredEventsFired', 'actorCount', 'ambientCount')


def aggregate(rows):
    """Per-arm aggregate: mean/median/max per metric + event-share indicators."""
    if not rows:
        return {'cells': 0}
    agg = {'cells': len(rows), 'censusVersion': CENSUS_VERSION}
    for k in NUMERIC:
        vs = [r[k] for r in rows if isinstance(r.get(k), (int, float))]
        if not vs:
            continue
        agg[k] = {'mean': round(statistics.mean(vs), 4),
                  'median': round(statistics.median(vs), 4),
                  'max': round(max(vs), 4)}
    tot = [r for r in rows if isinstance(r.get('authoredEventsTotal'), int)]
    if tot:
        f = sum(r['authoredEventsFired'] for r in tot)
        t = sum(r['authoredEventsTotal'] for r in tot)
        agg['authoredEventsFireRate'] = round(f / t, 4) if t else None
        agg['authoredEventsTotal'] = {'mean': round(statistics.mean(
            [r['authoredEventsTotal'] for r in tot]), 4)}
    for k in ('laneChangesExecuted', 'swerveEvents', 'signalPhaseChanges', 'hardBrakeEvents'):
        vs = [r[k] for r in rows if isinstance(r.get(k), (int, float))]
        agg['shareCellsWith_' + k] = round(sum(1 for v in vs if v > 0) / len(vs), 4) if vs else None
    return agg


# --------------------------------------------------------------------------- cell IO
def _cell_paths(d):
    """(trace, instance) inside a contract cell dir or for a raw batch draw pair."""
    t = os.path.join(d, 'trace.json.gz')
    i = os.path.join(d, 'instance.json')
    if os.path.exists(t):
        return t, (i if os.path.exists(i) else None)
    hits = sorted(glob.glob(os.path.join(d, 'draw-*.trace.json.gz')))
    return (hits[0], hits[0].replace('.trace.json.gz', '.instance.json')) if hits else (None, None)


def census_path(trace_path, instance_path=None):
    inst = None
    if instance_path is None and trace_path.endswith('.trace.json.gz'):
        cand = trace_path.replace('.trace.json.gz', '.instance.json')
        instance_path = cand if os.path.exists(cand) else None
    if instance_path and os.path.exists(instance_path):
        inst = json.load(open(instance_path))
    row = census_cell(load_trace(trace_path), instance=inst)
    row['trace'] = trace_path
    return row


# --------------------------------------------------------------------------- self-test
def _mk_track(n, x=None, y=None, speed=None, off=None, rsl=None, present=None):
    z = [0.0] * n
    return {'x': x or z[:], 'y': y or z[:], 'headingRad': z[:],
            'speedMps': speed or z[:], 'lateralOffsetM': off or z[:],
            'laneRsl': rsl or ['1:0:-1'] * n, 'present': present or [True] * n,
            'motionDirection': [1] * n, 's': z[:]}


def _mk_trace(actors, dt=0.02, n=None, signals=None, events=None, ambient=None, meta=None):
    n = n or len(next(iter(actors.values()))['x'])
    return {'header': {'dt': dt, 'mapId': 'synthetic', 'seed': '0',
                       'ambientActorIds': ambient or [],
                       'actorMetadata': meta or {a: {'dims': {'l': 4.7, 'w': 1.8}}
                                                 for a in actors}},
            'ticks': {'t': [round(i * dt, 4) for i in range(n)], 'actors': actors,
                      'signals': signals or {}},
            'events': events or [], 'metrics': {}}


def self_test(smoke_dir):
    import numpy as np                                                     # noqa: F401
    n, dt = 500, 0.02
    failures = []

    def check(name, got, want):
        ok = got == want
        print('  %-52s %s (got %r, want %r)' % (name, 'PASS' if ok else 'FAIL', got, want))
        if not ok:
            failures.append(name)

    # 1. Lane change: neighbour lane transition + sweep -> 1; successor road -> 0.
    off = [0.0] * n
    rsl = ['7:0:-1'] * 250 + ['7:0:-2'] * (n - 250)
    for i in range(200, 250):
        off[i] = min(1.7, (i - 200) * 0.04)      # sweep toward neighbour
    for i in range(250, 300):
        off[i] = max(0.0, 1.7 - (i - 250) * 0.04)
    a = _mk_track(n, x=[i * 0.2 for i in range(n)], speed=[10.0] * n, off=off, rsl=rsl)
    row = census_cell(_mk_trace({'lc': a}))
    check('laneChangesExecuted: neighbour+sweep', row['laneChangesExecuted'], 1)
    check('  ...swerve not double-counted', row['swerveEvents'], 0)
    b = _mk_track(n, x=[i * 0.2 for i in range(n)], speed=[10.0] * n,
                  rsl=['7:0:-1'] * 250 + ['9:0:-1'] * (n - 250))
    check('laneChangesExecuted: chain successor ignored',
          census_cell(_mk_trace({'cs': b}))['laneChangesExecuted'], 0)

    # 2. Swerve: out >= 0.8 m and back -> 1.
    off2 = [0.0] * n
    for i in range(100, 130):
        off2[i] = 1.0
    c = _mk_track(n, x=[i * 0.2 for i in range(n)], speed=[10.0] * n, off=off2)
    check('swerveEvents: excursion with return', census_cell(_mk_trace({'sw': c}))['swerveEvents'], 1)
    off3 = [0.0] * 100 + [1.0] * (n - 100)       # leaves and never returns
    d = _mk_track(n, x=[i * 0.2 for i in range(n)], speed=[10.0] * n, off=off3)
    check('swerveEvents: no return -> 0', census_cell(_mk_trace({'nr': d}))['swerveEvents'], 0)

    # 3. Hard brake: 15 -> 0 m/s at 5 m/s^2 (3 s) -> 1 event; gentle 1 m/s^2 -> 0.
    sp = [15.0] * 100 + [max(0.0, 15.0 - 5.0 * (i - 100) * dt) for i in range(100, n)]
    e = _mk_track(n, x=[i * 0.2 for i in range(n)], speed=sp)
    check('hardBrakeEvents: 5 m/s^2 sustained', census_cell(_mk_trace({'hb': e}))['hardBrakeEvents'], 1)
    sp2 = [15.0 - min(14.0, 1.0 * i * dt) for i in range(n)]
    f = _mk_track(n, x=[i * 0.2 for i in range(n)], speed=sp2)
    check('hardBrakeEvents: 1 m/s^2 -> 0', census_cell(_mk_trace({'gb': f}))['hardBrakeEvents'], 0)

    # 4. Interacting pair: head-on 10 m/s each from 60 m -> TTC < 5 s; parallel -> 0.
    g1 = _mk_track(n, x=[i * dt * 10 for i in range(n)], speed=[10.0] * n)
    g2 = _mk_track(n, x=[60 - i * dt * 10 for i in range(n)], speed=[10.0] * n)
    row = census_cell(_mk_trace({'ego': g1, 'op': g2}))
    check('interactingPairs: head-on', row['interactingPairs'], 1)
    check('  ...actorsMoving counts both', row['actorsMoving'], 2)
    h1 = _mk_track(n, x=[i * dt * 10 for i in range(n)], speed=[10.0] * n)
    h2 = _mk_track(n, x=[i * dt * 10 for i in range(n)],
                   y=[50.0] * n, speed=[10.0] * n)
    check('interactingPairs: parallel -> 0',
          census_cell(_mk_trace({'p1': h1, 'p2': h2}))['interactingPairs'], 0)

    # 5. Signals + events + counts.
    ph = ['green'] * 200 + ['yellow'] * 100 + ['red'] * (n - 300)
    row = census_cell(_mk_trace({'st': _mk_track(n)}, signals={'sig1': {'phase': ph}},
                                events=[{'kind': 'trigger_fired', 'interactionId': 'i1'},
                                        {'kind': 'trigger_fired', 'interactionId': 'i1'},
                                        {'kind': 'trigger_fired', 'interactionId': 'i2'}],
                                ambient=['amb1']),
                      template={'choreography': {'interactions': [1, 2, 3]}})
    check('signalPhaseChanges', row['signalPhaseChanges'], 2)
    check('authoredEventsFired distinct', row['authoredEventsFired'], 2)
    check('authoredEventsTotal from template', row['authoredEventsTotal'], 3)
    check('actorsMoving: static -> 0', row['actorsMoving'], 0)

    # 6. Real smoke traces (integration: columnar format, instance pairing).
    smoke = sorted(glob.glob(os.path.join(smoke_dir, '*', '*', 'draw-*.trace.json.gz')))
    if smoke:
        rows = [census_path(p) for p in smoke]
        print('  smoke traces: %d cells' % len(rows))
        for r in rows[:4]:
            print('    %s' % json.dumps({k: r[k] for k in
                                         ('actorsMoving', 'interactingPairs',
                                          'hardBrakeEvents', 'authoredEventsFired',
                                          'authoredEventsTotal', 'actorCount')}))
        ok = all(isinstance(r['interactingPairs'], int) and
                 r['actorCount'] >= 1 and r['authoredEventsTotal'] is not None
                 for r in rows)
        check('smoke integration (fields populated)', ok, True)
        print('  smoke aggregate: %s' % json.dumps(aggregate(rows), sort_keys=True)[:400])
    else:
        print('  (no smoke traces at %s — synthetic checks only)' % smoke_dir)

    print('SELF-TEST: %s' % ('PASS' if not failures else 'FAIL: %s' % failures))
    return 0 if not failures else 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--self-test', action='store_true')
    ap.add_argument('--smoke-dir', default='/tmp/tgr-lead-smoke')
    ap.add_argument('--cells', nargs='*', help='cell dirs (contract layout or batch draws)')
    ap.add_argument('--traces', nargs='*', help='explicit trace.json.gz paths')
    ap.add_argument('--out')
    a = ap.parse_args()
    if a.self_test:
        return self_test(a.smoke_dir)
    rows = []
    for d in a.cells or []:
        t, i = _cell_paths(d)
        if not t:
            print('no trace in %s' % d, file=sys.stderr)
            continue
        r = census_path(t, i)
        r['cell'] = d
        rows.append(r)
    for t in a.traces or []:
        rows.append(census_path(t))
    rep = {'rows': rows, 'aggregate': aggregate(rows)}
    if a.out:
        json.dump(rep, open(a.out, 'w'), indent=1)
        print('wrote %s (%d rows)' % (a.out, len(rows)))
    else:
        print(json.dumps(rep, indent=1))
    return 0


if __name__ == '__main__':
    sys.exit(main())
