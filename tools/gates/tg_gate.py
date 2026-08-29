"""Frozen physical admission gate, training-grade lane.

This module is the ONLY place the gate is implemented for this lane. It reads every metric from
the RAW TRACE (`ticks`, `header`, `metrics`), never from a batch summary or an `evaluate` verdict
field -- except `verdict`/`band`, which ARE the evaluate outputs C5 is defined over and which are
passed in explicitly by the caller.

Frozen contract (see research/edge-case-corpus/PHYSICAL-GATE-v2.json):
  v1 sha256 1a08698e95fca4bc...   v2 sha256 3823182614e5a5ba...
TIGHTENING IS ALLOWED. LOOSENING IS FORBIDDEN. `verify_gate_hash.py` is the tripwire.
"""
import gzip, json, math, os, re

# ---------------------------------------------------------------- frozen thresholds
# These constants ARE the gate. verify_gate_hash.py asserts each one against the frozen
# manifest text, so editing a number here fails the no-relaxation gate.
C1_SPEED, C1_DIST = 2.0, 10.0     # C1 ego actually drives
C2_MARGIN = 0.5                   # C2 closest approach at t > warmup + 0.5
C3_CLEARANCE = 5.0                # C3 TRUE OBB clearance <= 5.0 m
C4_DECEL, C4_TTC = 1.5, 3.0       # C4 genuine demand
PORT_MIN_MAPS, PORT_MIN_SITES = 2, 3

GATE_V1_SHA = '1a08698e95fca4bc97bd192ac2199be27b13e43ba066a654ee513d0f74f44c2d'
GATE_V2_SHA = '3823182614e5a5ba48db3dec06d09bbc178e874483f13f43176c32b930d79754'

# C6 arms only for briefs whose MECHANISM is occlusion.
OCCLUSION_TERMS = re.compile(
    r'\b(occlud\w*|occlusion|obscur\w*|hidden|hides?|hiding|blind\s+spot|blocked\s+(?:view|sight)|'
    r'out\s+of\s+(?:view|sight)|behind\s+(?:a|the|parked|stopped|stationary)|sight\s*line|'
    r'screen\w*\s+by|masked\s+by|conceal\w*)\b', re.I)
OCC_OK_STATUS = ('revealed_before_conflict', 'blocked_at_conflict')


def occlusion_intent(brief):
    """True when the brief NAMES occlusion as the mechanism. Inert (False) when brief is None,
    so no existing caller is silently tightened or loosened by accident."""
    if not brief:
        return False
    if isinstance(brief, dict):
        brief = ' '.join(str(brief.get(k, '')) for k in
                         ('brief', 'text', 'prompt', 'mechanism', 'category', 'id', 'title'))
    return bool(OCCLUSION_TERMS.search(str(brief)))


# ---------------------------------------------------------------- OBB geometry (C3)
def _corners(x, y, hd, l, w):
    c, s = math.cos(hd), math.sin(hd)
    hl, hw = l / 2.0, w / 2.0
    return [(x + c * dx - s * dy, y + s * dx + c * dy)
            for dx, dy in ((hl, hw), (hl, -hw), (-hl, -hw), (-hl, hw))]


def _seg_dist(p, a, b):
    px, py = p; ax, ay = a; bx, by = b
    vx, vy = bx - ax, by - ay
    L2 = vx * vx + vy * vy
    t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((px - ax) * vx + (py - ay) * vy) / L2))
    return math.hypot(px - (ax + t * vx), py - (ay + t * vy))


def _sat_overlap(A, B):
    """Separating-axis test: True when the two convex quads overlap."""
    for poly in (A, B):
        n = len(poly)
        for i in range(n):
            x1, y1 = poly[i]; x2, y2 = poly[(i + 1) % n]
            ax, ay = -(y2 - y1), (x2 - x1)
            pa = [ax * px + ay * py for px, py in A]
            pb = [ax * px + ay * py for px, py in B]
            if max(pa) < min(pb) or max(pb) < min(pa):
                return False
    return True


def obb_clearance(A, B):
    """TRUE oriented-bounding-box clearance in metres; 0.0 when the boxes overlap.

    NOT the engine's `minDistance`, which is a circumscribed-circle broad-phase proxy
    (car r=2.58 + pedestrian r=0.42 = 3.00 m, so it reads 0 m at 3 m of real separation).
    """
    if _sat_overlap(A, B):
        return 0.0
    best = float('inf')
    for P, Q in ((A, B), (B, A)):
        n = len(Q)
        for p in P:
            for i in range(n):
                d = _seg_dist(p, Q[i], Q[(i + 1) % n])
                if d < best:
                    best = d
    return best


def load_trace(path):
    with gzip.open(path) as f:
        return json.loads(f.read())


# ---------------------------------------------------------------- raw-trace facts
def trace_facts(trace):
    """Every gate input, read from the raw trace. Never returns or prints a bulk array."""
    hdr, ticks = trace['header'], trace['ticks']
    ts = ticks['t']
    warmup = hdr.get('warmupSeconds', 0.0)
    meta = hdr.get('actorMetadata', {})
    ego = ticks['actors'].get('ego')
    if ego is None:
        return {'error': 'no ego in trace'}

    # --- C1: ego really drives (raw speed + integrated path length, not a summary field)
    speeds = [v for v, pr in zip(ego['speedMps'], ego['present']) if pr]
    max_speed = max(speeds) if speeds else 0.0
    dist, px, py = 0.0, None, None
    for x, y, pr in zip(ego['x'], ego['y'], ego['present']):
        if not pr:
            px = py = None
            continue
        if px is not None:
            dist += math.hypot(x - px, y - py)
        px, py = x, y

    # --- C2/C3: true OBB closest approach against every non-ambient, non-ego actor
    ed = meta.get('ego', {}).get('dims', {})
    el, ew = ed.get('l', 4.8), ed.get('w', 1.9)
    er = math.hypot(el, ew) / 2.0
    ambient = set(hdr.get('ambientActorIds') or [])
    best = {'clearanceM': float('inf'), 't': None, 'with': None}
    per_challenger = {}
    for aid, a in ticks['actors'].items():
        if aid == 'ego' or aid in ambient:
            continue
        d = meta.get(aid, {}).get('dims', {})
        al, aw = d.get('l', 0.6), d.get('w', 0.6)
        ar = math.hypot(al, aw) / 2.0
        # Broad-phase cull. OBB clearance is bounded below by centreDist - (er + ar), so a tick
        # can be skipped only when that LOWER BOUND already exceeds the best clearance found so
        # far -- then it provably cannot improve on it.
        #
        # The earlier form (`if centreDist > er+ar+C3+1 and best < inf: continue`) is UNSOUND: once
        # any clearance is recorded, every subsequent distant tick is skipped, so a trajectory that
        # starts far apart and closes later keeps the t=0 value forever. Measured on a probe cell:
        # it reported clearance 39.80 m at t=0 where the true closest approach was 8.03 m at
        # t=18.0 s -- wrong on BOTH C2 (closest-approach time) and C3 (clearance). The same cull
        # appears in tools/vista/gate.py; see FINDINGS defect TG-G1.
        loc = {'clearanceM': float('inf'), 't': None}
        pad = er + ar
        for i in range(len(ts)):
            if not (ego['present'][i] and a['present'][i]):
                continue
            centre = math.hypot(ego['x'][i] - a['x'][i], ego['y'][i] - a['y'][i])
            if centre - pad >= loc['clearanceM']:
                continue
            cl = obb_clearance(_corners(ego['x'][i], ego['y'][i], ego['headingRad'][i], el, ew),
                               _corners(a['x'][i], a['y'][i], a['headingRad'][i], al, aw))
            if cl < loc['clearanceM']:
                loc = {'clearanceM': cl, 't': ts[i]}
        per_challenger[aid] = loc
        if loc['clearanceM'] < best['clearanceM']:
            best = {'clearanceM': loc['clearanceM'], 't': loc['t'], 'with': aid}

    m = trace.get('metrics', {})
    mt = m.get('minTTC') or {}
    occ = list(m.get('declaredOcclusion') or [])
    return {
        'mapId': hdr.get('mapId'),
        'seed': hdr.get('seed'),
        'inputHash': hdr.get('inputHash'),
        'maxSpeedMps': round(max_speed, 3),
        'distanceTravelledM': round(dist, 3),
        'warmupSeconds': warmup,
        'clearanceM': None if best['clearanceM'] == float('inf') else round(best['clearanceM'], 3),
        'closestT': best['t'],
        'closestWith': best['with'],
        'perChallenger': {k: {'clearanceM': None if v['clearanceM'] == float('inf')
                              else round(v['clearanceM'], 3), 't': v['t']}
                          for k, v in per_challenger.items()},
        'minTTC': mt.get('value'),
        'minTTCt': mt.get('t'),
        'requiredDecelMaxEgo': round((m.get('requiredDecelMax') or {}).get('ego', 0.0) or 0.0, 3),
        'collisions': sum(1 for c in (m.get('collisions') or [])
                          if not ({c.get('a'), c.get('b')} <= ambient)),
        'triggerNeverFired': list(m.get('triggerNeverFired') or []),
        'declaredOcclusion': occ,
        'occluderIneffective': list(m.get('occluderIneffective') or []),
        'revealToConflict': m.get('revealToConflict'),
        'clipSeconds': hdr.get('clipSeconds'),
        'dt': hdr.get('dt', 0.02),
    }


def gate_cell(trace_path, verdict=None, band=None, brief=None, version=2):
    """Gate one cell against the frozen contract. Returns the per-criterion verdict dict."""
    f = trace_facts(load_trace(trace_path))
    if 'error' in f:
        return {'pass': False, 'error': f['error'], 'trace': trace_path}
    c1 = f['maxSpeedMps'] >= C1_SPEED and f['distanceTravelledM'] >= C1_DIST
    # C2 covers BOTH named events: closest approach AND minTTC.
    t_lim = f['warmupSeconds'] + C2_MARGIN
    c2_close = f['closestT'] is not None and f['closestT'] > t_lim
    c2_ttc = f['minTTCt'] is None or f['minTTCt'] > t_lim
    c2 = bool(c2_close and c2_ttc)
    c3 = f['clearanceM'] is not None and f['clearanceM'] <= C3_CLEARANCE
    c4 = (f['requiredDecelMaxEgo'] >= C4_DECEL) or (f['minTTC'] is not None and f['minTTC'] <= C4_TTC)
    c5 = bool(verdict == 'accept' and band == 'critical'
              and f['collisions'] == 0 and not f['triggerNeverFired'])
    wants_occ = occlusion_intent(brief)
    if version < 2 or not wants_occ:
        c6, c6_reason = True, None
    else:
        proven = [o for o in f['declaredOcclusion'] if str(o.get('status')) in OCC_OK_STATUS]
        c6 = bool(proven) and not f['occluderIneffective']
        c6_reason = (None if c6 else
                     ('declaredOcclusion empty' if not f['declaredOcclusion'] else
                      ('occluderIneffective non-empty' if f['occluderIneffective'] else
                       'no declaredOcclusion entry reached %s' % ' | '.join(OCC_OK_STATUS))))
    f.update({'trace': trace_path, 'verdict': verdict, 'band': band,
              'C1': c1, 'C2': c2, 'C3': c3, 'C4': c4, 'C5': c5, 'C6': c6,
              'C2_closestOK': c2_close, 'C2_minTTC_OK': c2_ttc,
              'occlusionIntent': wants_occ, 'C6_reason': c6_reason,
              'pass': bool(c1 and c2 and c3 and c4 and c5 and c6)})
    return f


def first_failure(g):
    """The single criterion a failing cell fails FIRST, in gate order. Used for loss census."""
    for k in ('C1', 'C2', 'C3', 'C4', 'C5', 'C6'):
        if not g.get(k, True):
            return k
    return None


def first_failure_published(g):
    """Loss census under the PUBLISHED baseline reading of C2.

    The v2 manifest text requires "the closest-approach and minTTC events" to occur after
    warmup + 0.5. The brief's own section 3.1, `LANE-CONTRACT.md`, and the `tools/vista/gate.py`
    implementation that produced the 29.3% C2 census and the 0.466 DEV baseline all test the
    CLOSEST-APPROACH event only.

    Admission (`gate_cell.pass`) uses the stricter manifest reading -- tightening is allowed. This
    function exists purely so the loss census can be compared like-for-like against the published
    29.3%, which was measured the other way. Reporting both is the honest option; silently picking
    whichever is flattering is not.
    """
    order = (('C1', g.get('C1', True)), ('C2', g.get('C2_closestOK', True)),
             ('C3', g.get('C3', True)), ('C4', g.get('C4', True)),
             ('C5', g.get('C5', True)), ('C6', g.get('C6', True)))
    for k, ok in order:
        if not ok:
            return k
    return None


def portability(cells):
    """>= 2 maps AND >= 3 distinct sites, over the cells that PASSED."""
    ok = [c for c in cells if c.get('pass')]
    maps = {c.get('mapId') or c.get('map') for c in ok} - {None}
    sites = {(c.get('mapId') or c.get('map'), c.get('site')) for c in ok} - {(None, None)}
    return {'maps': sorted(m for m in maps if m), 'nMaps': len(maps), 'nSites': len(sites),
            'ok': len(maps) >= PORT_MIN_MAPS and len(sites) >= PORT_MIN_SITES}
