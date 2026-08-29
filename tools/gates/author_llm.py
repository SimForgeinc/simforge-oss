#!/usr/bin/env python3
"""W7 LLM authoring surface: gpt-5.6-luna authors each brief; a thin compiler owns representation.

The round-6 tool surface is NOT on disk (12 of its 16 ops reference undefined names; the runner
was notebook-only -- see M0.5/M6 in FINDINGS). Per the archived blocker's nextAction, this is a
REBUILT surface, and any number it produces is reported as NOT like-for-like comparable to the
published 0.466. What it preserves from round 6:

  * the authoring LLM is gpt-5.6-luna at reasoning effort medium, and nothing else (vlm.py);
  * the LLM makes the scenario-level decisions: mechanism family, actors, gap/timing windows,
    occluder, junction control, works geometry -- as one bounded JSON decision per round;
  * two solve rounds against real engine feedback (probe at draws=4), then one final measured
    batch at draws=10, exactly the round-6 rhythm (solve rounds=2 draws=4, simulate draws=10);
  * zero per-brief tuning by the operator: one prompt template, one decision schema, one compiler.

What the compiler owns (representation, not authoring): W1 warm-up compensation as a constant
(TG-A2), `actor.static` for stopped actors (TG-A1), `lateralM`/`lateralRef` for the verge (W2),
`closures` for work zones (W3), the safety governor kept ON with a late-reaction release (TG-P1),
and clamping every LLM number into pre-registered physical bounds.

The gate is the frozen physical gate v2, applied to the RAW trace by tg_gate, unchanged.

Usage:  author_llm.py --split DEV [--workers 6] [--out report.json]
"""
import argparse, concurrent.futures, json, math, os, re, sys, threading

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
EC = os.path.join(ROOT, 'research', 'edge-case-corpus')
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(EC, 'tools', 'vista'))
import probe_lib as P                                                      # noqa: E402
import tg_gate as G                                                        # noqa: E402
import author_corpus as A                                                  # noqa: E402
import vlm                                                                 # noqa: E402

WEATHER = ('clear', 'cloudy', 'overcast', 'light_rain', 'heavy_rain', 'wet_road',
           'fog_light', 'fog_dense', 'snow', 'sleet')
TIMES_OF_DAY = ('dawn', 'morning', 'noon', 'afternoon', 'dusk', 'night', 'night_lit')
SURFACES = ('ice', 'packed_snow', 'standing_water', 'wet_leaves', 'loose_gravel',
            'sand', 'spilled_oil', 'polished_asphalt', 'grit_treated')
MARKING_QUALITIES = ('crisp', 'faded', 'absent', 'misaligned')
SURFACE_FRICTION = {
  'ice': 0.15, 'packed_snow': 0.3, 'standing_water': 0.5, 'wet_leaves': 0.45,
  'loose_gravel': 0.6, 'sand': 0.5, 'spilled_oil': 0.25,
  'polished_asphalt': 0.75, 'grit_treated': 1.15,
}
# Low grip cannot be made admissible by asking for impossible braking. These caps keep the
# approach conservative; the earlier reaction floor below gives the tyre circle time to work.
LOW_GRIP_SPEED_CAP = {
  'ice': 30.0, 'spilled_oil': 32.0, 'packed_snow': 35.0, 'wet_leaves': 40.0,
  'standing_water': 42.0, 'sand': 42.0, 'loose_gravel': 45.0,
  'polished_asphalt': 50.0,
}
LOW_GRIP_REACT_FLOOR = {
  'ice': 3.0, 'spilled_oil': 2.8, 'packed_snow': 2.6, 'wet_leaves': 2.4,
  'standing_water': 2.3, 'sand': 2.3, 'loose_gravel': 2.1,
}
WARMUP = 2.0
CLIP = 18.0                                          # A._base's recorded clip length.
HESITATE_CLIP = 12.0                                 # see `_hesitating_crossing`.
RUN_TAG = 'w7'

FAMILIES = ('longitudinal_lead', 'crossing_vru', 'hesitating_vru', 'occluded_vru',
            'junction_conflict', 'lateral_incursion', 'oncoming', 'parking_pullout', 'workzone')
VEHICLES = {'vehicle.sedan': 'car', 'vehicle.suv': 'car', 'vehicle.box_truck': 'truck',
            'vehicle.van': 'van', 'vehicle.bus': 'bus', 'vehicle.motorcycle': 'motorcycle',
            'vehicle.bicycle': 'bicycle'}
VRUS = {'pedestrian.adult_walking': 'pedestrian', 'pedestrian.child_walking': 'pedestrian',
        'vehicle.bicycle': 'bicycle'}
OCCLUDERS = ('occluder.hedge_run', 'occluder.covered_car', 'occluder.dumpster',
             'street.bus_shelter')

# Class physics copied from ACTOR_PHYSICS_PROFILES in sim-engine/dynamic-v1.ts.
# (wheelbaseM, maxSteerRad, tireMu, maxLateralAccelerationMps2)
LATERAL_PHYSICS = {
  'car': (2.7, 0.58, 1.0, 7.0),
  'van': (3.35, 0.54, 0.92, 5.0),
  'truck': (5.2, 0.44, 0.78, 3.1),
  'bus': (6.0, 0.46, 0.8, 2.8),
  'motorcycle': (1.45, 0.62, 0.95, 6.5),
  'bicycle': (1.08, 0.7, 0.82, 3.5),
}
# A portable full lane change can bind to a lane whose centre spacing is not known yet.
# Using the narrow end for the acceleration check and the wide end for completion is
# conservative across ordinary 2.5-4.0 m traffic lanes.
LANE_CHANGE_MIN_M = 2.5
LANE_CHANGE_MAX_M = 4.0
MIN_JERK_PEAK_RATE = 1.875
MIN_JERK_PEAK_ACCEL = 5.7735
GRAVITY_MPS2 = 9.80665

# Pre-registered physical bounds. The compiler CLAMPS the LLM's numbers into these; it never
# invents numbers of its own when the LLM supplied one.
BOUNDS = {
  'egoSpeedKph':      (30.0, 70.0),
  'challengerSpeedKph': (0.0, 60.0),
  'gapM':             (8.0, 130.0),
  'reactAtTtcS':      (0.8, 3.5),
  'eventLeadS':       (0.5, 4.0),
  'brakeAtS':         (2.6, 6.0),
  'conflictS':        (30.0, 120.0),
  'vruSpeedKph':      (3.0, 20.0),
  'arrivalTtcS':      (0.3, 3.0),
  'oncomingStartM':   (40.0, 160.0),
  'worksStartM':      (50.0, 110.0),
  'worksLengthM':     (20.0, 60.0),
  'surfaceAtM':      (-160.0, 160.0),
  'surfaceLengthM':  (5.0, 180.0),
  'markingAtM':      (-160.0, 160.0),
  'markingLengthM':  (5.0, 180.0),
  'windDirectionDeg': (0.0, 359.0),
  'windSpeedMps':     (0.0, 20.0),
  'windGustPeakMps': (5.0, 35.0),
  'closedWidthM':     (1.0, 2.2),
  'workerSpeedKph':   (3.0, 8.0),
  'corridorSpeedKph': (25.0, 90.0),
  # Hesitating crossing. Every one of these is the EGO'S REMAINING DISTANCE to the
  # pedestrian at the moment the phase begins, not a clip time: the phases are
  # anchored to the ego's observed approach, so the hold costs the conflict nothing.
  'hesitateAtM':      (24.0, 90.0),
  'walkOutM':         (8.0, 40.0),
  'approachM':        (8.0, 40.0),
  'holdS':            (0.6, 3.0),
}


def _clamp(v, key):
    lo, hi = BOUNDS[key]
    return max(lo, min(hi, float(v)))


def _window(d, key, default):
    """A [lo, hi] window from the decision, clamped into bounds, or the family default."""
    v = d.get(key)
    if not (isinstance(v, (list, tuple)) and len(v) == 2):
        lo, hi = default
    else:
        lo, hi = _clamp(v[0], key), _clamp(v[1], key)
    if key == 'reactAtTtcS':
        floor = LOW_GRIP_REACT_FLOOR.get(d.get('surfaceKind'))
        if floor is not None:
            lo, hi = max(lo, floor), max(hi, floor)
    if hi <= lo:
        hi = min(BOUNDS[key][1], lo + max(0.2, 0.05 * lo))
    return (round(lo, 2), round(hi, 2))


def _scalar(d, key, default):
    v = d.get(key)
    value = default if v is None or isinstance(v, (list, tuple, dict, str)) else _clamp(v, key)
    if key in ('egoSpeedKph', 'challengerSpeedKph'):
        if any(k in d for k in ('windDirectionDeg', 'windSpeedMps', 'windGustPeakMps')):
            value = max(value, 65.0 if key == 'egoSpeedKph' else 60.0)
        cap = LOW_GRIP_SPEED_CAP.get(d.get('surfaceKind'))
        if cap is not None:
            value = min(value, cap)
    return value


def _react_interactions(react_expr):
    return [
      {'id': 'ego-inattentive', 'actor': 'ego', 'verb': 'set',
       'trigger': {'kind': 'at', 't': 0},
       'target': {'key': 'rules.collisionAvoidance', 'value': False}},
      {'id': 'ego-reacts', 'actor': 'ego', 'verb': 'set',
       'trigger': {'kind': 'at', 't': react_expr},
       'target': {'key': 'rules.collisionAvoidance', 'value': True}},
    ]


# ------------------------------------------------------------------ compilers
def c_longitudinal_lead(brief, d):
    v_ego_kph = _scalar(d, 'egoSpeedKph', 55.0)
    v_ego = v_ego_kph / 3.6
    cat = d.get('challengerCatalog') if d.get('challengerCatalog') in VEHICLES else 'vehicle.sedan'
    static = bool(d.get('challengerStatic', False))
    kph = 0.0 if static else _scalar(d, 'challengerSpeedKph', 45.0)
    mps = kph / 3.6
    lead_brakes = bool(d.get('leadBrakes', not static)) and not static
    closing = max(v_ego - mps, 0.5)
    if static:
        g_dflt = (round(3.2 * closing, 1), round(closing * closing / 4.0, 1))
    else:
        lead_stop_m = (mps * mps) / (2 * 6.0)
        hi = max(12.0, v_ego * v_ego / 3.6 - lead_stop_m)
        g_dflt = (round(max(10.0, 0.35 * hi), 1), round(hi, 1))
    gap = _window(d, 'gapM', g_dflt)
    react_w = _window(d, 'reactAtTtcS', (1.4, 2.9))
    actor = {'class': VEHICLES[cat], 'catalogId': cat}
    if static:
        actor['static'] = True
    dsM = 'param.initialGapM + %.4f' % (WARMUP * closing)
    react = 'clamp(param.initialGapM / %.4f - param.reactAtTtcS, 0.2, 12)' % v_ego
    inter = _react_interactions(react)
    params = [A._p('initialGapM', gap[0], gap[1], 'm'),
              A._p('reactAtTtcS', react_w[0], react_w[1], 's')]
    if lead_brakes:
        b = _window(d, 'brakeAtS', (2.6, 4.4))
        params.append(A._p('brakeAtS', b[0], b[1], 's'))
        inter.append({'id': 'lead-brakes', 'actor': 'chal', 'verb': 'speed',
                      'trigger': {'kind': 'at', 't': 'param.brakeAtS'},
                      'target': {'mode': 'stop'},
                      'dynamics': {'shape': 'linear', 'constraint': 'rate', 'value': 6.0}})
    cs = _window(d, 'corridorSpeedKph', (50, 90))
    return A._base(
      brief['id'], brief['brief'][:120], 'w7.longitudinal.%s' % brief['id'],
      A._corridor(speed=cs, runway=340), params,
      [{**A._ego(), 'initialSpeedKph': v_ego_kph},
       {'id': 'chal', 'kind': 'relative_to', 'label': 'lead', 'actor': actor,
        'requiredSameSegmentAs': 'ego',
        'requiredHeadingRelation': {'role': 'ego', 'relation': 'parallel', 'maxErrorDeg': 10},
        'ref': 'ego', 'dLane': 0, 'dsM': dsM, 'tFrac': 0, 'headingOffsetRad': 0,
        'initialSpeedKph': kph}],
      [], inter)


def c_crossing_vru(brief, d, occluder=None, hesitate=False):
    v_ego_kph = _scalar(d, 'egoSpeedKph', 40.0)
    v_ego = v_ego_kph / 3.6
    cat = d.get('challengerCatalog') if d.get('challengerCatalog') in VRUS else None
    if cat is None:
        cat, cls, top = A._vru_catalog(brief['brief'])
    else:
        cls, top = VRUS[cat], (14.0 if cat == 'vehicle.bicycle' else 7.0)
    vspeed = _window(d, 'vruSpeedKph', (4.0, top))

    if hesitate:
        at, clip, params, inter = _hesitating_crossing(d, v_ego)
        archetype = 'w7.hesitating.%s' % brief['id']
    else:
        at, clip, params, inter = _continuous_crossing(d, v_ego)
        archetype = 'w7.crossing.%s' % brief['id']
    params.append(A._p('vruSpeedKph', vspeed[0], vspeed[1], 'kph'))

    props = []
    if occluder:
        props.append({'id': 'occ', 'catalogId': occluder, 'label': 'roadside occluder',
                      'essentiality': 'required',
                      'pose': {'laneOffset': 0, 's': at,
                               'lateralM': -2.2, 'lateralRef': 'verge', 'headingOffsetRad': 0},
                      'headingOffsetRad': 0, 'scale': 1,
                      'occludes': {'observer': 'ego', 'target': 'vru'}})
    start_lat = ({'lateralM': -3.4, 'lateralRef': 'verge'} if occluder
                 else {'lateralM': -1.0, 'lateralRef': 'verge'})
    return A._base(
      brief['id'], brief['brief'][:120], archetype,
      A._corridor(lanes=(1, 2), runway=220), params,
      [{**A._ego(), 'initialSpeedKph': v_ego_kph},
       {'id': 'vru', 'kind': 'on_reference', 'label': 'crossing road user',
        'actor': {'class': cls, 'catalogId': cat},
        'pose': {'laneOffset': 0, 's': at, **start_lat, 'headingOffsetRad': 0},
        'initialSpeedKph': 0}],
      props, inter(start_lat), clip=clip)


def _crossing_polyline(at, start_lat):
    return [{'laneOffset': 0, 's': at, **start_lat, 'headingOffsetRad': 0},
            {'laneOffset': 0, 's': '%s + 1.2' % at, 'lateralM': -0.2,
             'lateralRef': 'verge', 'headingOffsetRad': 0},
            {'laneOffset': 0, 's': '%s + 2.6' % at, 'tFrac': 0, 'headingOffsetRad': 0},
            {'laneOffset': 0, 's': '%s + 4.0' % at, 'tFrac': 1, 'headingOffsetRad': 0}]


def _continuous_crossing(d, v_ego):
    """One monotone walk, started on a clip clock back-solved from the ego's nominal speed."""
    conflict = _window(d, 'conflictS', (45, 85))
    lead = _window(d, 'eventLeadS', (1.4, 3.2))
    step = 'clamp(param.conflictS / %.4f - param.crossLeadS, 0.2, 12)' % v_ego
    at = 'param.conflictS'
    params = [A._p('conflictS', conflict[0], conflict[1], 'm'),
              A._p('crossLeadS', lead[0], lead[1], 's')]

    def inter(start_lat):
        return [
          {'id': 'vru-crosses', 'actor': 'vru', 'verb': 'route',
           'trigger': {'kind': 'at', 't': step},
           'target': {'mode': 'polyline', 'points': _crossing_polyline(at, start_lat)}},
          {'id': 'vru-walks', 'actor': 'vru', 'verb': 'speed',
           'trigger': {'kind': 'at', 't': step},
           'target': {'mode': 'absolute', 'valueKph': 'param.vruSpeedKph'},
           'dynamics': {'shape': 'linear', 'constraint': 'rate', 'value': 2.0}}]
    return at, CLIP, params, inter


def _hesitating_crossing(d, v_ego):
    """Will-they-won't-they: step out, freeze in the road, then commit.

    Every phase is triggered by the EGO'S REMAINING DISTANCE to the pedestrian rather
    than by a clip time. That is what makes the pause authorable: a clip clock has to
    be back-solved from an assumed ego speed and an assumed zero warm-up, and any hold
    inserted afterwards shifts the pedestrian's arrival at the conflict by the hold plus
    the walking ramps -- measured on this engine, a hand-timed 1 s pause took a crossing
    from 4/16 admitted cells to 0/16. Anchored to the approach, the hold is free: the
    pedestrian is in the road, stationary, exactly when the ego is `hesitateAtM` away,
    and commits `holdS` later whatever the site's speed limit did to the ego.
    A 12 s clip, not the family default 18 s. The mechanism runs from the step-out at
    about 1.5 s to the far kerb at about 10 s, and the review surface spends a FIXED
    budget of eight evenly spaced frames on whatever length the clip declares. At 18 s
    those frames are 2.6 s apart, so a 2 s standstill lands in at most one of them and
    is literally unobservable: measured here, the 2D oracle read frames-only evidence of
    an 18 s clip as "crosses continuously without a visible hesitation". At 12 s they are
    1.7 s apart and the hold spans two, which is what makes a standstill visible at all.
    """
    hes = _window(d, 'hesitateAtM', (44, 60))
    walk = _window(d, 'walkOutM', (16, 26))
    appr = _window(d, 'approachM', (14, 26))
    hold = _window(d, 'holdS', (2.0, 2.8))
    step_out = 'param.hesitateAtM + param.walkOutM'
    # The ego has already driven WARMUP * v_ego metres when the clip starts, so the
    # crossing sits that much further downstream for `stepOutM` to be an event at all.
    at = '%s + param.approachM + %.2f' % (step_out, WARMUP * v_ego)
    params = [A._p('hesitateAtM', hes[0], hes[1], 'm'),
              A._p('walkOutM', walk[0], walk[1], 'm'),
              A._p('approachM', appr[0], appr[1], 'm'),
              A._p('holdS', hold[0], hold[1], 's')]

    def near(m):
        return {'kind': 'distance', 'from': 'ego', 'to': {'role': 'vru'},
                'measure': 'euclidean', 'op': '<=', 'valueM': m}

    def inter(start_lat):
        return [
          {'id': 'vru-a-steps-out', 'actor': 'vru', 'verb': 'route',
           'trigger': {'kind': 'when', 'condition': near(step_out),
                       'byLatest': HESITATE_CLIP - 4.0, 'ifNever': 'fire'},
           'target': {'mode': 'polyline', 'points': _crossing_polyline(at, start_lat)}},
          {'id': 'vru-b-walks', 'actor': 'vru', 'verb': 'speed',
           'trigger': {'kind': 'after', 'of': 'vru-a-steps-out', 'event': 'start', 'delayS': 0},
           'target': {'mode': 'absolute', 'valueKph': 'param.vruSpeedKph'},
           'dynamics': {'shape': 'linear', 'constraint': 'rate', 'value': 2.0}},
          {'id': 'vru-c-hesitates', 'actor': 'vru', 'verb': 'speed',
           'trigger': {'kind': 'when', 'condition': near('param.hesitateAtM'),
                       'byLatest': HESITATE_CLIP - 2.0, 'ifNever': 'fire'},
           'target': {'mode': 'stop'},
           'dynamics': {'shape': 'step', 'constraint': 'time', 'value': 0.1}},
          {'id': 'vru-d-commits', 'actor': 'vru', 'verb': 'speed',
           'trigger': {'kind': 'after', 'of': 'vru-c-hesitates', 'event': 'start',
                       'delayS': 'param.holdS'},
           'target': {'mode': 'absolute', 'valueKph': 'param.vruSpeedKph'},
           'dynamics': {'shape': 'linear', 'constraint': 'rate', 'value': 2.0}}]
    return at, HESITATE_CLIP, params, inter


def c_hesitating_vru(brief, d):
    return c_crossing_vru(brief, d, hesitate=True)


def c_occluded_vru(brief, d):
    occ = d.get('occluder') if d.get('occluder') in OCCLUDERS else 'occluder.hedge_run'
    t = c_crossing_vru(brief, d, occluder=occ)
    t['meta']['archetype'] = 'w7.occluded.%s' % brief['id']
    return t


def c_junction_conflict(brief, d):
    v_ego_kph = _scalar(d, 'egoSpeedKph', 40.0)
    v_ego = v_ego_kph / 3.6
    ctl = d.get('junctionControl')
    control = (['signalized'] if ctl == 'signalized'
               else ['all_way_stop', 'minor_stop'] if ctl == 'stop' else None)
    jx = {'id': 'jx', 'kind': 'junction', 'essentiality': 'required',
          'atM': {'value': [0, 0], 'essentiality': 'required'}}
    if control:
        jx['control'] = {'value': control, 'essentiality': 'required'}
    cat = d.get('challengerCatalog')
    if cat in VRUS:
        chal = {'class': VRUS[cat], 'catalogId': cat}
    elif cat in VEHICLES:
        chal = {'class': VEHICLES[cat], 'catalogId': cat}
    else:
        conflicting = re.search(r'\bpedestrian|\bcyclist|\bchild', brief['brief'], re.I)
        if conflicting:
            c2, cls2, _ = A._vru_catalog(brief['brief'])
            chal = {'class': cls2, 'catalogId': c2}
        else:
            chal = {'class': 'car', 'catalogId': 'vehicle.sedan'}
    arrival = _window(d, 'arrivalTtcS', (0.5, 2.2))
    react_w = _window(d, 'reactAtTtcS', (1.2, 2.6))
    chal_kph = _scalar(d, 'challengerSpeedKph', 30.0)
    approach_m = 70.0
    react = 'clamp(%.4f / %.4f - param.reactAtTtcS, 0.2, 12)' % (approach_m, v_ego)
    return A._base(
      brief['id'], brief['brief'][:120], 'w7.junction.%s' % brief['id'],
      {**A._corridor(lanes=(1, 8), runway=200),
       'runwayUpstreamM': {'value': [110, None], 'essentiality': 'required'}},
      [A._p('arrivalTtc', arrival[0], arrival[1], 's'),
       A._p('reactAtTtcS', react_w[0], react_w[1], 's')],
      [{**A._ego(s=-approach_m), 'initialSpeedKph': v_ego_kph},
       {'id': 'chal', 'kind': 'conflicting_gate', 'label': 'conflicting movement',
        'actor': chal, 'essentiality': 'required',
        'feature': 'jx', 'from': 'from_left', 'turn': 'straight',
        'arriveAtConflict': {'relativeTo': 'ego', 'deltaT': '-param.arrivalTtc'},
        'requiredUpstreamRunwayM': 60,
        'initialSpeedKph': chal_kph}],
      [],
      _react_interactions(react) + [
       {'id': 'chal-commits', 'actor': 'chal', 'verb': 'set',
        'trigger': {'kind': 'at', 't': 0},
        'target': {'key': 'rules.yieldToVehicles', 'value': False}}],
      features=[jx], max_sites=8)


def _minimum_lane_change_speed_kph(actor_class, surface_kind):
    """Speed floor that leaves six seconds for a conservative-width lane change."""
    wheelbase, max_steer, tire_mu, max_lat = LATERAL_PHYSICS[actor_class]
    grip = SURFACE_FRICTION.get(surface_kind, 1.0)
    tyre_ceiling = min(max_lat, tire_mu * GRAVITY_MPS2 * grip)
    available_s = CLIP - 12.0
    minimum_rate = LANE_CHANGE_MAX_M * MIN_JERK_PEAK_RATE / available_s
    required_ceiling = (
      MIN_JERK_PEAK_ACCEL * minimum_rate ** 2
      / (MIN_JERK_PEAK_RATE ** 2 * LANE_CHANGE_MIN_M))
    if tyre_ceiling < required_ceiling:
        raise ValueError(
          'surface grip cannot support a full lane change before the clip ends')
    # Two percent absorbs the later three-decimal downward rounding of the rate.
    return (math.sqrt(required_ceiling * wheelbase / math.tan(max_steer))
            * 3.6 * 1.02)


def _feasible_lateral_rate(actor_class, speed_kph, surface_kind, preferred_rate=1.6):
    """Fastest preferred lane-change rate that fits tyre and steering limits."""
    wheelbase, max_steer, tire_mu, max_lat = LATERAL_PHYSICS[actor_class]
    speed = speed_kph / 3.6
    grip = SURFACE_FRICTION.get(surface_kind, 1.0)
    tyre_ceiling = min(max_lat, tire_mu * GRAVITY_MPS2 * grip)
    steering_ceiling = speed * speed * math.tan(max_steer) / wheelbase
    ceiling = min(tyre_ceiling, steering_ceiling)
    if ceiling <= 0:
        raise ValueError('lateral_incursion challenger must be moving; steering authority is zero')
    # T = 1.875 D / rate and peak ay = 5.7735 D / T^2. The narrowest
    # conservative lane is the worst case for acceleration at a fixed peak rate.
    max_rate = math.sqrt(
      ceiling * LANE_CHANGE_MIN_M * MIN_JERK_PEAK_RATE ** 2
      / MIN_JERK_PEAK_ACCEL)
    rate = min(preferred_rate, math.floor(max_rate * 0.995 * 1000.0) / 1000.0)
    max_duration = LANE_CHANGE_MAX_M * MIN_JERK_PEAK_RATE / max(rate, 1e-9)
    if max_duration > CLIP - 12.0:
        raise ValueError(
          'lateral_incursion challenger is too slow to finish a physical lane change '
          'before the clip: %.2f kph gives %.3f m/s2 lateral ceiling and needs %.2f s'
          % (speed_kph, ceiling, max_duration))
    return rate


def c_lateral_incursion(brief, d):
    v_ego_kph = _scalar(d, 'egoSpeedKph', 40.0)
    v_ego = v_ego_kph / 3.6
    cat = d.get('challengerCatalog') if d.get('challengerCatalog') in VEHICLES else 'vehicle.sedan'
    actor_class = VEHICLES[cat]
    chal_kph = max(_minimum_lane_change_speed_kph(actor_class, d.get('surfaceKind')),
                   _scalar(d, 'challengerSpeedKph', 34.0))
    lateral_rate = _feasible_lateral_rate(actor_class, chal_kph, d.get('surfaceKind'))
    closing = max(v_ego - chal_kph / 3.6, 1.0)
    gap = _window(d, 'gapM', (14, 34))
    cut_w = _window(d, 'eventLeadS', (0.8, 2.4))
    react_w = _window(d, 'reactAtTtcS', (1.0, 2.4))
    dsM = 'param.initialGapM + %.4f' % (WARMUP * closing)
    cut = 'clamp(param.initialGapM / %.4f - param.cutLeadS, 0.2, 12)' % closing
    react = 'clamp(param.initialGapM / %.4f - param.reactAtTtcS, 0.2, 12)' % closing
    return A._base(
      brief['id'], brief['brief'][:120], 'w7.lateral.%s' % brief['id'],
      A._corridor(lanes=(2, 8), speed=_window(d, 'corridorSpeedKph', (40, 90)), runway=260),
      [A._p('initialGapM', gap[0], gap[1], 'm'), A._p('cutLeadS', cut_w[0], cut_w[1], 's'),
       A._p('reactAtTtcS', react_w[0], react_w[1], 's')],
      [{**A._ego(), 'initialSpeedKph': v_ego_kph},
       {'id': 'chal', 'kind': 'relative_to', 'label': 'cutting-in vehicle',
        'actor': {'class': VEHICLES[cat], 'catalogId': cat},
        'requiredSameSegmentAs': 'ego',
        'ref': 'ego', 'dLane': 1, 'dsM': dsM, 'tFrac': 0, 'headingOffsetRad': 0,
        'initialSpeedKph': chal_kph}],
      [],
      _react_interactions(react) + [
       {'id': 'chal-cuts-in', 'actor': 'chal', 'verb': 'changeLane',
        'trigger': {'kind': 'at', 't': cut},
        'target': {'mode': 'toRole', 'role': 'ego'},
        'dynamics': {'shape': 'sinusoidal', 'constraint': 'rate',
                     'value': lateral_rate}}])


def c_oncoming(brief, d):
    v_ego_kph = _scalar(d, 'egoSpeedKph', 40.0)
    v_ego = v_ego_kph / 3.6
    onc_kph = _scalar(d, 'challengerSpeedKph', 35.0)
    cat = d.get('challengerCatalog') if d.get('challengerCatalog') in VEHICLES else 'vehicle.sedan'
    close = v_ego + onc_kph / 3.6
    start = _window(d, 'oncomingStartM', (60, 130))
    drift_w = _window(d, 'eventLeadS', (1.4, 3.0))
    react_w = _window(d, 'reactAtTtcS', (1.0, 2.4))
    react = 'clamp(param.oncomingStartM / %.4f - param.reactAtTtcS, 0.2, 12)' % close
    drift = 'clamp(param.oncomingStartM / %.4f - param.driftLeadS, 0.2, 12)' % close
    return A._base(
      brief['id'], brief['brief'][:120], 'w7.oncoming.%s' % brief['id'],
      A._corridor(lanes=(1, 1), speed=_window(d, 'corridorSpeedKph', (30, 70)), runway=260),
      [A._p('oncomingStartM', start[0], start[1], 'm'),
       A._p('driftLeadS', drift_w[0], drift_w[1], 's'),
       A._p('reactAtTtcS', react_w[0], react_w[1], 's')],
      [{**A._ego(), 'initialSpeedKph': v_ego_kph},
       {'id': 'chal', 'kind': 'opposing', 'label': 'oncoming vehicle',
        'actor': {'class': VEHICLES[cat], 'catalogId': cat},
        'pose': {'laneOffset': 0, 's': 'param.oncomingStartM', 'tFrac': 0,
                 'headingOffsetRad': 0},
        'initialSpeedKph': onc_kph}],
      [],
      _react_interactions(react) + [
       {'id': 'chal-holds', 'actor': 'chal', 'verb': 'set',
        'trigger': {'kind': 'at', 't': drift},
        'target': {'key': 'rules.collisionAvoidance', 'value': False}}])


def c_parking_pullout(brief, d):
    v_ego_kph = _scalar(d, 'egoSpeedKph', 45.0)
    v_ego = v_ego_kph / 3.6
    gap = _window(d, 'gapM', (22, 48))
    pull_w = _window(d, 'eventLeadS', (1.0, 2.6))
    react_w = _window(d, 'reactAtTtcS', (1.0, 2.4))
    dsM = 'param.initialGapM + %.4f' % (WARMUP * v_ego)
    pull = 'clamp(param.initialGapM / %.4f - param.pullLeadS, 0.2, 12)' % v_ego
    react = 'clamp(param.initialGapM / %.4f - param.reactAtTtcS, 0.2, 12)' % v_ego
    comp = WARMUP * v_ego
    return A._base(
      brief['id'], brief['brief'][:120], 'w7.parking.%s' % brief['id'],
      A._corridor(lanes=(1, 8), speed=(55, 90), runway=200),
      [A._p('initialGapM', gap[0], gap[1], 'm'), A._p('pullLeadS', pull_w[0], pull_w[1], 's'),
       A._p('reactAtTtcS', react_w[0], react_w[1], 's')],
      [{**A._ego(), 'initialSpeedKph': v_ego_kph},
       {'id': 'chal', 'kind': 'relative_to', 'label': 'vehicle leaving a kerbside bay',
        'actor': {'class': 'car', 'catalogId': 'vehicle.sedan'},
        'requiredSameSegmentAs': 'ego',
        'ref': 'ego', 'dLane': 0, 'dsM': dsM,
        'lateralM': -1.1, 'lateralRef': 'lane_edge', 'headingOffsetRad': 0,
        'initialSpeedKph': 0}],
      [],
      _react_interactions(react) + [
       {'id': 'chal-pulls-out', 'actor': 'chal', 'verb': 'route',
        'trigger': {'kind': 'at', 't': pull},
        'target': {'mode': 'polyline', 'points': [
            {'laneOffset': 0, 's': 'param.initialGapM + %.4f' % comp,
             'lateralM': -1.1, 'lateralRef': 'lane_edge', 'headingOffsetRad': 0},
            {'laneOffset': 0, 's': 'param.initialGapM + %.4f' % (comp + 6.0),
             'lateralM': -0.2, 'lateralRef': 'lane_edge', 'headingOffsetRad': 0},
            {'laneOffset': 0, 's': 'param.initialGapM + %.4f' % (comp + 14.0),
             'tFrac': 0, 'headingOffsetRad': 0},
            {'laneOffset': 0, 's': 'param.initialGapM + %.4f' % (comp + 30.0),
             'tFrac': 0, 'headingOffsetRad': 0}]}},
       {'id': 'chal-accelerates', 'actor': 'chal', 'verb': 'speed',
        'trigger': {'kind': 'at', 't': pull},
        'target': {'mode': 'absolute', 'valueKph': 24},
        'dynamics': {'shape': 'linear', 'constraint': 'rate', 'value': 2.5}}])


def c_workzone(brief, d):
    v_ego_kph = _scalar(d, 'egoSpeedKph', 40.0)
    v_ego = v_ego_kph / 3.6
    ws = _window(d, 'worksStartM', (60, 95))
    wl = _window(d, 'worksLengthM', (25, 50))
    cw = _window(d, 'closedWidthM', (1.2, 1.8))
    cl = _window(d, 'eventLeadS', (1.6, 3.4))
    wk = _window(d, 'workerSpeedKph', (3.5, 7.0))
    step = ('clamp((param.worksStartM + 0.5 * param.worksLengthM) / %.4f - param.crossLeadS, 0.2, 12)'
            % v_ego)
    mid = 'param.worksStartM + 0.5 * param.worksLengthM'
    return A._base(
      brief['id'], brief['brief'][:120], 'w7.workzone.%s' % brief['id'],
      A._corridor(lanes=(1, 8), speed=(50, 90), runway=340),
      [A._p('worksStartM', ws[0], ws[1], 'm'), A._p('worksLengthM', wl[0], wl[1], 'm'),
       A._p('closedWidthM', cw[0], cw[1], 'm'), A._p('crossLeadS', cl[0], cl[1], 's'),
       A._p('workerSpeedKph', wk[0], wk[1], 'kph')],
      [{**A._ego(), 'initialSpeedKph': v_ego_kph},
       {'id': 'worker', 'kind': 'on_reference', 'label': 'road worker',
        'actor': {'class': 'pedestrian', 'catalogId': 'construction.flagger'},
        'pose': {'laneOffset': 0, 's': mid, 'lateralM': -0.9,
                 'lateralRef': 'lane_edge', 'headingOffsetRad': 0},
        'initialSpeedKph': 0}],
      [],
      [{'id': 'worker-steps-out', 'actor': 'worker', 'verb': 'route',
        'trigger': {'kind': 'at', 't': step},
        'target': {'mode': 'polyline', 'points': [
            {'laneOffset': 0, 's': mid, 'lateralM': -0.9, 'lateralRef': 'lane_edge',
             'headingOffsetRad': 0},
            {'laneOffset': 0, 's': mid + ' + 1.5', 'lateralM': -0.2, 'lateralRef': 'lane_edge',
             'headingOffsetRad': 0},
            {'laneOffset': 0, 's': mid + ' + 3.0', 'tFrac': 0, 'headingOffsetRad': 0},
            {'laneOffset': 0, 's': mid + ' + 4.5', 'tFrac': 0.9, 'headingOffsetRad': 0}]}},
       {'id': 'worker-walks', 'actor': 'worker', 'verb': 'speed',
        'trigger': {'kind': 'at', 't': step},
        'target': {'mode': 'absolute', 'valueKph': 'param.workerSpeedKph'},
        'dynamics': {'shape': 'linear', 'constraint': 'rate', 'value': 2.0}}],
      closures=[{'id': 'wz', 'label': 'lane closure', 'laneOffset': 0,
                 'fromS': 'param.worksStartM',
                 'toS': 'param.worksStartM + param.worksLengthM',
                 'closedWidthM': 'param.closedWidthM', 'side': 'right', 'device': 'cone',
                 'assumedSpeedKph': 40, 'shiftTraffic': True, 'essentiality': 'required'}])


def _param_range(template, pid):
    for p in template['params']['declarations']:
        if p['id'] == pid:
            return tuple(p['range'])
    raise ValueError('compiler did not declare %s' % pid)


def _conflict_window(template, family):
    ego = next(r for r in template['roles'] if r['id'] == 'ego')
    ego_start = float(ego['pose']['s'])
    ego_kph = float(ego['initialSpeedKph'])
    if family in ('longitudinal_lead', 'lateral_incursion', 'parking_pullout'):
        lo, hi = _param_range(template, 'initialGapM')
        chal = next(r for r in template['roles'] if r['id'] == 'chal')
        expr = str(chal.get('dsM', ''))
        match = re.search(r'\+\s*(-?\d+(?:\.\d+)?)\s*$', expr)
        warmup_offset = float(match.group(1)) if match else 0.0
        return (ego_start + lo + warmup_offset, ego_start + hi + warmup_offset,
                ego_start, ego_kph)
    if family in ('crossing_vru', 'occluded_vru'):
        lo, hi = _param_range(template, 'conflictS')
        return lo, hi, ego_start, ego_kph
    if family == 'hesitating_vru':
        h = _param_range(template, 'hesitateAtM')
        w = _param_range(template, 'walkOutM')
        a = _param_range(template, 'approachM')
        warmup_offset = WARMUP * ego_kph / 3.6
        return (h[0] + w[0] + a[0] + warmup_offset,
                h[1] + w[1] + a[1] + warmup_offset, ego_start, ego_kph)
    if family == 'junction_conflict':
        return 0.0, 0.0, ego_start, ego_kph
    if family == 'oncoming':
        lo, hi = _param_range(template, 'oncomingStartM')
        chal = next(r for r in template['roles'] if r['id'] == 'chal')
        fraction = ego_kph / max(ego_kph + float(chal['initialSpeedKph']), 0.1)
        return ego_start + lo * fraction, ego_start + hi * fraction, ego_start, ego_kph
    if family == 'workzone':
        ws = _param_range(template, 'worksStartM')
        wl = _param_range(template, 'worksLengthM')
        return ws[0] + 0.5 * wl[0], ws[1] + 0.5 * wl[1], ego_start, ego_kph
    raise ValueError('no conflict geometry for family %s' % family)


def _number_hint(d, key, default):
    value = d.get(key)
    if isinstance(value, (list, tuple)) and len(value) == 2:
        lo, hi = _clamp(value[0], key), _clamp(value[1], key)
        return 0.5 * (min(lo, hi) + max(lo, hi))
    if value is None or isinstance(value, (dict, str, list, tuple)):
        return default
    return _clamp(value, key)


def _approach_window(d, prefix, conflict):
    """Cover the whole conservative braking zone; reject authored decoration behind it."""
    conflict_lo, conflict_hi, ego_start, ego_kph = conflict
    scale = SURFACE_FRICTION.get(d.get('surfaceKind'), 1.0)
    braking_m = max(12.0, (ego_kph / 3.6) ** 2 / (2.0 * 9.81 * scale))
    zone_start = max(ego_start, conflict_lo - braking_m)
    zone_end = conflict_hi
    at_key, length_key = prefix + 'AtM', prefix + 'LengthM'
    requested_at = _number_hint(d, at_key, zone_start)
    requested_length = _number_hint(d, length_key, max(5.0, zone_end - zone_start))
    if requested_at >= zone_end or requested_at + requested_length <= zone_start:
        return None
    at = min(requested_at, zone_start)
    end = max(requested_at + requested_length, zone_end)
    length = end - at
    if at < BOUNDS[at_key][0] or at > BOUNDS[at_key][1] or length > BOUNDS[length_key][1]:
        return None
    return round(at, 2), round(max(BOUNDS[length_key][0], length), 2)


def _ensure_director(template, conflict):
    for role in template['roles']:
        if role['id'] == 'director':
            return 'director'
    at = round(0.5 * (conflict[0] + conflict[1]), 2)
    template['roles'].append(
      {'id': 'director', 'kind': 'on_reference', 'label': 'traffic marshal',
       'actor': {'class': 'pedestrian', 'catalogId': 'pedestrian.traffic_marshal',
                 'static': True},
       'pose': {'laneOffset': 0, 's': at, 'lateralM': -0.8,
                'lateralRef': 'lane_edge', 'headingOffsetRad': 0},
       'initialSpeedKph': 0})
    return 'director'


def _vehicle_challenger(template, field):
    for role in template['roles']:
        if role['id'] == 'chal' and role['actor']['class'] in VEHICLES.values():
            return 'chal'
    raise ValueError('%s requires a vehicle challenger role' % field)


def _apply_environment(template, d, conflict):
    weather = d.get('weather') if d.get('weather') in WEATHER else 'clear'
    time_of_day = d.get('timeOfDay') if d.get('timeOfDay') in TIMES_OF_DAY else 'noon'
    surface = d.get('surfaceKind') if d.get('surfaceKind') in SURFACES else None
    marking = d.get('markingQuality') if d.get('markingQuality') in MARKING_QUALITIES else 'crisp'
    wind_requested = any(k in d for k in ('windDirectionDeg', 'windSpeedMps',
                                           'windGustPeakMps'))
    if (weather == 'clear' and time_of_day == 'noon' and surface is None
            and marking == 'crisp' and not wind_requested):
        return
    env = dict(template.get('environment') or {})
    env['weather'], env['timeOfDay'] = weather, time_of_day
    if wind_requested:
        direction = _scalar(d, 'windDirectionDeg', 90.0)
        steady = _window(d, 'windSpeedMps', (0.0, 4.0))
        template['params']['declarations'].append(
          A._p('windSpeedMps', steady[0], steady[1], 'mps'))
        wind = {'directionDeg': direction, 'speedMps': 'param.windSpeedMps'}
        peak = _window(d, 'windGustPeakMps', (32.0, 35.0))
        peak_lo = max(32.0, peak[0], steady[1])
        peak_hi = BOUNDS['windGustPeakMps'][1]
        template['params']['declarations'].append(
          A._p('windGustPeakMps', peak_lo, peak_hi, 'mps'))
        conflict_t = ((0.5 * (conflict[0] + conflict[1]) - conflict[2])
                      / max(conflict[3] / 3.6, 0.1))
        duration = 4.0
        clip = template['choreography']['clipSeconds']
        start = max(0.0, min(clip - duration, conflict_t - 0.5 * duration))
        wind['gust'] = {'startS': round(start, 2), 'durationS': duration,
                        'peakSpeedMps': 'param.windGustPeakMps'}
        high_sided = {'vehicle.box_truck', 'vehicle.bus', 'vehicle.van'}
        affected = next((r for r in template['roles']
                         if r['id'] == 'chal' and r['actor']['class'] in VEHICLES.values()), None)
        if affected is None:
            affected = next(r for r in template['roles'] if r['id'] == 'ego')
        if affected['actor']['catalogId'] not in high_sided:
            affected['actor'].update({'class': 'truck', 'catalogId': 'vehicle.box_truck'})
        env['wind'] = wind
    if surface is not None:
        window = _approach_window(d, 'surface', conflict)
        if window is None:
            raise ValueError('surface patch does not overlap the pre-conflict braking zone')
        env['surfacePatches'] = [
          {'id': 'approach-surface', 'kind': surface, 'label': surface.replace('_', ' '),
           'atM': window[0], 'lengthM': window[1], 'laneOffsets': [0],
           'essentiality': 'required'}]
    if marking != 'crisp':
        window = _approach_window(d, 'marking', conflict)
        if window is None:
            raise ValueError('marking treatment does not overlap the pre-conflict braking zone')
        env['markingTreatments'] = [
          {'id': 'marking-quality', 'quality': marking, 'atM': window[0],
           'lengthM': window[1], 'laneOffsets': []}]
    template['environment'] = env


def _apply_states(template, d, conflict):
    interactions = template['choreography']['interactions']
    gesture = d.get('directorGesture')
    if gesture in ('halt', 'wave_through', 'point'):
        director = _ensure_director(template, conflict)
        interactions.append(
          {'id': 'director-gesture', 'actor': director, 'verb': 'set',
           'trigger': {'kind': 'at', 't': 2.6},
           'target': {'key': 'pose.gesture', 'value': gesture}})
        if gesture == 'halt':
            interactions.append(
              {'id': 'gesture-halts-ego', 'actor': 'ego', 'verb': 'speed',
               'trigger': {'kind': 'at', 't': 2.6}, 'target': {'mode': 'stop'},
               'dynamics': {'shape': 'linear', 'constraint': 'rate', 'value': 4.0}})
        elif gesture == 'wave_through':
            chal = _vehicle_challenger(template, 'directorGesture=wave_through')
            interactions.extend([
              {'id': 'gesture-yielding-vehicle', 'actor': chal, 'verb': 'speed',
               'trigger': {'kind': 'at', 't': 2.6}, 'target': {'mode': 'stop'},
               'dynamics': {'shape': 'linear', 'constraint': 'rate', 'value': 4.0}},
              {'id': 'gesture-ego-proceeds', 'actor': 'ego', 'verb': 'set',
               'trigger': {'kind': 'at', 't': 2.6},
               'target': {'key': 'rules.collisionAvoidance', 'value': True}},
            ])
    challenger_gesture = d.get('challengerGesture')
    if challenger_gesture in ('halt', 'wave_through', 'point'):
        chal = _vehicle_challenger(template, 'challengerGesture')
        interactions.extend([
          {'id': 'challenger-gesture', 'actor': chal, 'verb': 'set',
           'trigger': {'kind': 'at', 't': 2.6},
           'target': {'key': 'pose.gesture', 'value': challenger_gesture}},
          {'id': 'gesturing-challenger-yields', 'actor': chal, 'verb': 'speed',
           'trigger': {'kind': 'at', 't': 2.6}, 'target': {'mode': 'stop'},
           'dynamics': {'shape': 'linear', 'constraint': 'rate', 'value': 4.0}},
          {'id': 'challenger-gesture-ego-proceeds', 'actor': 'ego', 'verb': 'set',
           'trigger': {'kind': 'at', 't': 2.6},
           'target': {'key': 'rules.collisionAvoidance', 'value': True}},
        ])
    paddle = d.get('paddle')
    if paddle in ('stop', 'slow'):
        if not any(r['id'] == 'worker' for r in template['roles']):
            raise ValueError('paddle requires the workzone flagger')
        interactions.append(
          {'id': 'flagger-paddle', 'actor': 'worker', 'verb': 'set',
           'trigger': {'kind': 'at', 't': 2.6},
           'target': {'key': 'pose.paddle', 'value': paddle}})
    state_fields = (
      ('stopArm', 'pose.stopArm', 'extended', 'school-bus-stop-arm'),
      ('emergencyLights', 'lights.emergency', 'flashing', 'challenger-emergency-lights'),
    )
    for field, key, value, iid in state_fields:
        if d.get(field) is True:
            chal = _vehicle_challenger(template, field)
            interactions.append(
              {'id': iid, 'actor': chal, 'verb': 'set',
               'trigger': {'kind': 'at', 't': 2.6}, 'target': {'key': key, 'value': value}})
    indicator = d.get('challengerIndicator')
    if indicator in ('left', 'right', 'hazard'):
        chal = _vehicle_challenger(template, 'challengerIndicator')
        interactions.append(
          {'id': 'challenger-indicator', 'actor': chal, 'verb': 'set',
           'trigger': {'kind': 'at', 't': 2.6},
           'target': {'key': 'lights.indicator', 'value': indicator}})


def _apply_signal_phase(template, d, family):
    phase = d.get('signalPhase')
    if phase not in ('normal', 'flashing_yellow', 'flashing_red', 'blackout'):
        return
    if family != 'junction_conflict':
        raise ValueError('signalPhase requires junction_conflict')
    jx = next(f for f in template['anchor']['features'] if f['id'] == 'jx')
    jx['control'] = {'value': ['signalized'], 'essentiality': 'required'}
    if phase == 'normal':
        return
    indication = 'off' if phase == 'blackout' else phase
    pose = {'laneOffset': 0, 's': -3, 'tFrac': 0, 'headingOffsetRad': 0}
    template['trafficControls'] = [
      {'id': 'incident-signal', 'kind': 'normal_signal', 'label': phase.replace('_', ' '),
       'pose': pose, 'feature': 'jx',
       'stopLines': [{'pose': pose, 'feature': 'jx'}],
       'phases': [{'indication': indication,
                   'durationS': template['choreography']['clipSeconds']}],
       'loop': False, 'darkFallback': 'all_way_stop', 'darkDwellS': 1}]


def compile_decision(brief, decision):
    family = decision['family']
    template = COMPILERS[family](brief, decision)
    conflict = _conflict_window(template, family)
    _apply_environment(template, decision, conflict)
    _apply_states(template, decision, conflict)
    _apply_signal_phase(template, decision, family)
    return template


COMPILERS = {
  'longitudinal_lead': c_longitudinal_lead,
  'crossing_vru':      c_crossing_vru,
  'hesitating_vru':    c_hesitating_vru,
  'occluded_vru':      c_occluded_vru,
  'junction_conflict': c_junction_conflict,
  'lateral_incursion': c_lateral_incursion,
  'oncoming':          c_oncoming,
  'parking_pullout':   c_parking_pullout,
  'workzone':          c_workzone,
}


# ------------------------------------------------------------------ prompts
TOOLDOC = """You are the scenario author for an autonomous-driving edge-case corpus. You receive
ONE one-sentence brief and must author it as a JSON authoring decision. A deterministic compiler
turns your decision into a portable scenario template (logical road anchors, no coordinates); the
real engine simulates it on five maps; a frozen physical gate admits or rejects it from the raw
trace. You cannot change the compiler, the engine, or the gate.

MECHANISM FAMILIES (pick exactly one as "family"):
- longitudinal_lead: ego closes on a slower/stopped/braking lead in its own lane (rear-end class).
- crossing_vru: a pedestrian/cyclist enters the ego lane from the roadside and keeps walking.
- hesitating_vru: will-they-won't-they. The pedestrian steps off the kerb, FREEZES in the road
  while the car bears down, then commits. Use it whenever the brief says hesitates, pauses,
  wavers, thinks better of it, steps back, or is undecided. Its phases are triggered by the
  ego's remaining distance, not by a clip clock, so the pause does not push the conflict away.
- occluded_vru: crossing_vru, but the VRU starts hidden behind a roadside occluder and is
  revealed before the conflict.
- junction_conflict: a conflicting movement (vehicle or VRU) arrives at a junction as ego crosses.
- lateral_incursion: a vehicle in the adjacent lane cuts into the ego lane.
- oncoming: an oncoming vehicle encroaches into the ego lane (closing speed is the SUM).
- parking_pullout: a parked vehicle pulls out of a kerbside bay into the ego path.
- workzone: a solved MUTCD lane closure shifts traffic; a road worker steps into the running lane.

DECISION FIELDS (all optional except "family"; ranges are [lo, hi] windows the engine samples
uniformly; every number is clamped into the physical bounds shown):
  family              one of the nine names above
  egoSpeedKph         30..70 (scalar)
  challengerCatalog   vehicles: vehicle.sedan | vehicle.suv | vehicle.box_truck | vehicle.van |
                      vehicle.bus | vehicle.motorcycle | vehicle.bicycle
                      VRUs: pedestrian.adult_walking | pedestrian.child_walking | vehicle.bicycle
  challengerSpeedKph  0..60 (scalar; lead/cut-in/oncoming/junction challenger speed).
                      A lateral_incursion is raised to its class-specific physical floor (about
                      4-13 kph) if lower, so its full-lane change can finish after the latest
                      trigger and before the clip ends.
  challengerStatic    true for a genuinely stopped lead (longitudinal only)
  leadBrakes          true = moving lead brakes hard, Euro NCAP CCRb (longitudinal only)
  gapM                [8..130] initial ego->challenger gap window (longitudinal/lateral/parking)
  reactAtTtcS         [0.8..3.5] ego reacts when TTC falls to this (late-reaction mechanism)
  eventLeadS          [0.5..4.0] event lead time before ego arrival (cross/cut/pull/drift)
  brakeAtS            [2.6..6.0] when the braking lead brakes (longitudinal, leadBrakes)
  conflictS           [30..120] conflict point distance ahead of ego spawn (crossing/occluded)
  vruSpeedKph         [3..20] VRU crossing speed window
  hesitateAtM         [24..90] hesitating_vru: ego's remaining distance when she FREEZES.
                      This single number sets the criticality; smaller = later = more critical.
  holdS               [0.6..3.0] hesitating_vru: how long she stands still in the road.
  walkOutM            [8..40] hesitating_vru: extra ego distance covered while she walks out,
                      i.e. how far into the road she gets before freezing.
  approachM           [8..40] hesitating_vru: extra ego distance before she steps off the kerb.
  occluder            occluder.hedge_run | occluder.covered_car | occluder.dumpster |
                      street.bus_shelter (occluded_vru only)
  junctionControl     signalized | stop | any (junction_conflict only)
  arrivalTtcS         [0.3..3.0] challenger arrives this long before ego at the conflict point
  oncomingStartM      [40..160] oncoming start distance window
  worksStartM/worksLengthM/closedWidthM/workerSpeedKph   workzone geometry windows
  corridorSpeedKph    [25..90] required posted-speed window for the corridor
  weather             clear | cloudy | overcast | light_rain | heavy_rain | wet_road |
                      fog_light | fog_dense | snow | sleet (default clear)
  timeOfDay           dawn | morning | noon | afternoon | dusk | night | night_lit
                      (default noon)
  surfaceKind         ice | packed_snow | standing_water | wet_leaves | loose_gravel | sand |
                      spilled_oil | polished_asphalt | grit_treated
  surfaceAtM          -160..160 (scalar or [lo,hi] hint for patch start)
  surfaceLengthM      5..180 (scalar or [lo,hi] hint for patch length)
                      The compiler derives the final window from the family's conflict point
                      and emits it only when it covers the ego braking zone BEFORE the conflict.
  markingQuality      crisp | faded | absent | misaligned (default crisp). Marking degradation
                      is visual evidence only and does not change lane geometry or dynamics.
  markingAtM          -160..160 (scalar or [lo,hi] approach-window start hint)
  markingLengthM      5..180 (scalar or [lo,hi] approach-window length hint). Like a surface,
                      degraded markings are emitted only across the pre-conflict braking zone.
  directorGesture     halt | wave_through | point. Adds a traffic marshal and state_set event;
                      halt also stops ego, while wave_through stops the challenger and lets ego
                      proceed, so the visible gesture is coupled to the traffic motion it directs.
  challengerGesture   wave_through | halt | point. Sets pose.gesture on the vehicle challenger,
                      which stops and holds while ego proceeds; unlike directorGesture this does
                      not add a marshal.
  windDirectionDeg    0..359 scalar: direction the air travels TOWARD, counter-clockwise from
                      corridor-forward; +90 pushes a forward-travelling actor to the left.
  windSpeedMps        [0..20] steady wind-speed window.
  windGustPeakMps     [5..35] gust-peak window, clamped never below steady wind. The compiler
                      derives gust timing so its midpoint coincides with the approach/conflict;
                      gust timing is deliberately not an author field.
  paddle              stop | slow (workzone only; set on the construction flagger)
  stopArm             true (vehicle challenger only; extends pose.stopArm)
  emergencyLights     true (vehicle challenger only; lights.emergency flashes)
  challengerIndicator left | right | hazard (vehicle challenger only)
  signalPhase         normal | flashing_yellow | flashing_red | blackout
                      (junction_conflict only). This requires junction.control=signalized, so
                      hosting is limited to signalized Yale, El Camino, and Richmond junctions;
                      Belmont and Easterbrook have none. A non-junction request is refused.
  rationale           one sentence, for the record

PHYSICS FACTS you must design around (all measured on this engine):
- The trace starts AFTER a 2.0 s warm-up; the compiler already compensates authored gaps for it.
- The frozen admission gate (pre-registered, cannot change): C1 ego really drives
  (>=2 m/s, >=10 m); C2 closest approach happens after t = 2.5 s (not a spawn artifact);
  C3 true OBB clearance <= 5.0 m; C4 requiredDecel >= 1.5 m/s^2 OR minTTC <= 3.0 s;
  C5 verdict=accept AND band=critical AND zero collisions; C6 occlusion briefs must show
  genuine hide-then-reveal before the conflict; portability >= 2 maps AND >= 3 distinct sites.
- The evaluator bands a trace trivially-safe unless minTTC <= 3.0 s, so the scenario must reach
  that; a hazard in plain view that the ego's safety governor sees early never gets there. The
  compiler therefore releases the ego's avoidance late (reactAtTtcS) -- your reactAtTtcS window
  decides how late. Lower = more critical but risks collision (C5 rejects any contact).
- LOW GRIP CHANGES THE PHYSICS, not just the picture. Ice has frictionScale 0.15 and caps
  achievable deceleration near 1.5 m/s^2. The frozen gate rejects every collision (C5), and the
  evaluator rejects braking demand above the grip-scaled ceiling as physically_unavoidable.
  Therefore low-grip briefs MUST use lower speeds, longer gaps, and/or earlier events. The
  compiler also caps approach speed and raises the reaction-TTC floor for low-grip surfaces;
  do not try to defeat those rails with a normal-speed, late-reaction decision.
- C2 and C4 nearly exclude each other at low ego speed on dry asphalt: at 35 kph the admissible
  gap window for a stopped lead is EMPTY, at 40 kph it is ~1 m wide, at 55 kph ~19 m.
  Longitudinal stopped-lead briefs therefore need dry grip; do not combine them with ice.
- The five maps publish NO corridor posted below ~60 kph; a corridorSpeedKph upper bound <= 60
  matches ZERO sites. There are no roundabouts, school zones, parking aisles, or rail crossings,
  so only those unavailable road-layout details must be reduced to the nearest hostable family.
  Weather, time of day, local surface grip, marking quality, actor states, and signal faults are
  directly expressible and MUST NOT be reduced to an ordinary clear, dry corridor.
- A crosswind gust consumes lateral friction-circle budget. Combining a strong gust with low grip
  can make the demand physically_unavoidable and fail evaluation, so wind briefs should use dry
  grip. With the active lateral controller, a truck at 12 m/s under a 25 m/s gust deviates only
  0.19 m (about 1.5 evidence pixels), and a sedan or short weak gust is similarly unprovable.
  At about 18 m/s road speed, a high-sided truck under a 35 m/s gust deviates 0.79 m over 3 s
  and 0.87 m over 4 s (about 7 pixels); a bus reaches 0.92 m over 4 s. The compiler therefore
  uses a box truck, bus, or van, an approximately 18 m/s approach, and a strong 4 s conflict-
  centred gust. Do not author a sedan or low peak for a wind brief: physically real but invisible
  motion will not certify.
- Collisions REJECT (C5): windows that force contact (huge vruSpeed + tiny eventLead, or
  reactAtTtcS all the way down) lose cells to collisions.

OUTPUT: exactly one JSON object, no prose outside it."""

AUTHOR_PROMPT = """%s

BRIEF (category %s):
"%s"

Author this brief. Return one JSON decision object."""

REVISE_PROMPT = """%s

BRIEF (category %s):
"%s"

Your previous decision was:
%s

The engine ran it on all five maps. Result: NOT admitted.
%s

Gate criteria the failing cells failed FIRST (count): %s
Feasible cells: %d across %d maps / %d sites; passing cells: %d.

Revise your decision to fix the dominant failure. Return one JSON decision object."""


def first_authored_collision(trace):
    """First collision with at least one non-ambient side, matching product validity."""
    ambient = set((trace.get('header') or {}).get('ambientActorIds') or [])
    collisions = ((trace.get('metrics') or {}).get('collisions') or [])
    for collision in collisions:
        a, b = collision.get('a'), collision.get('b')
        if a in ambient and b in ambient:
            continue
        detail = {'a': a, 'b': b, 't': collision.get('t')}
        times = (trace.get('ticks') or {}).get('t') or []
        tracks = (trace.get('ticks') or {}).get('actors') or {}
        if times and isinstance(collision.get('t'), (int, float)):
            index = min(range(len(times)), key=lambda i: abs(times[i] - collision['t']))
            points = []
            for actor_id in (a, b):
                track = tracks.get(actor_id) or {}
                xs, ys = track.get('x') or [], track.get('y') or []
                if index < len(xs) and index < len(ys):
                    points.append((xs[index], ys[index]))
            if points:
                detail['x'] = round(sum(point[0] for point in points) / len(points), 3)
                detail['y'] = round(sum(point[1] for point in points) / len(points), 3)
        return detail
    return None


def collision_feedback(detail):
    if not detail:
        return None
    where = (' near map position (x=%.3f, y=%.3f)' % (detail['x'], detail['y'])
             if 'x' in detail and 'y' in detail else '')
    return ('Authored collision: "%s" with "%s" at t=%.6fs%s. Revise actor spacing, '
            'speed, event timing, or reaction timing so their bodies do not overlap.'
            % (detail.get('a'), detail.get('b'), detail.get('t'), where))


def feedback_lines(row):
    notes = []
    ff = row.get('firstFailure') or {}
    if row.get('error'):
        notes.append('Hard error: %s %s' % (row['error'], row.get('detail', '')))
    if ff.get('C2'):
        notes.append('C2 failures: the closest approach lands too early -- widen the gap or '
                     'lower closing speed so the conflict develops after 2.5 s.')
    if ff.get('C4'):
        notes.append('C4 failures: no braking demand -- tighten reactAtTtcS or the event lead '
                     'so the ego is genuinely surprised.')
    if ff.get('C3'):
        notes.append('C3 failures: clearance stays above 5 m -- the encounter never gets close.')
    if ff.get('C1'):
        notes.append('C1 failures: the ego never really drives.')
    if ff.get('C5'):
        notes.append('C5 failures: rejected by the evaluator (collision, trivially-safe band, '
                     'or never-fired trigger).')
    collision = collision_feedback(row.get('firstAuthoredCollision'))
    if collision:
        notes.append(collision)
    if ff.get('C6'):
        notes.append('C6 failures: occlusion not proven (hide-then-reveal missing).')
    rc = row.get('refusalCodes') or {}
    if rc:
        notes.append('Engine refusals (no trace produced): %s -- these cells never simulated; '
                     'change the decision so the solver can place the scene.' % json.dumps(rc))
    if row.get('maps', 0) < 2 or row.get('sites', 0) < 3:
        notes.append('Portability short: %d maps / %d sites (need >=2 maps and >=3 sites) -- '
                     'loosen corridor requirements if possible.' % (row.get('maps', 0),
                                                                    row.get('sites', 0)))
    return '\n'.join('- ' + n for n in notes) if notes else '- (no per-criterion detail)'


# ------------------------------------------------------------------ runner
_print_lock = threading.Lock()


def decide(prompt):
    """One luna call -> decision dict. Raises on unusable output."""
    d, raw = vlm.ask_json(prompt, max_tokens=12000)
    if not isinstance(d, dict) or d.get('family') not in FAMILIES:
        raise ValueError('decision missing a valid family: %r' % (d if isinstance(d, dict)
                                                                  else type(d).__name__))
    return d, raw


def compile_and_validate(brief, decision, tag):
    template = compile_decision(brief, decision)
    path = '/tmp/tg-%s-%s-%s.template.json' % (RUN_TAG, tag,
                                               re.sub(r'[^A-Za-z0-9_-]', '-', brief['id']))
    json.dump(template, open(path, 'w'), indent=1)
    rc, out, so, se = P.cli('template', 'validate', path)
    issues = [str(i.get('message'))[:160] for i in ((out or {}).get('issues') or [])[:4]]
    return path, rc == 0, issues


def run_and_gate(brief, path, decision, draws, max_sites, concurrency):
    outdir = P.unique_outdir('%s-%s' % (RUN_TAG, re.sub(r'[^A-Za-z0-9_-]', '-', brief['id'])))
    try:
        summary = P.run_batch(path, outdir, maps=None, draws=draws,
                              max_sites=max_sites, concurrency=concurrency, timeout=1800)
    except Exception as e:                                                 # noqa: BLE001
        return {'id': brief['id'], 'category': brief['category'], 'family': decision['family'],
                'admitted': False, 'error': 'batch_failed', 'detail': str(e)[:200],
                'outdir': outdir}
    recs = P.gate_summary(summary, brief=brief['brief'], version=2)
    refusals = {}
    first_collision = None
    for r in summary.get('results', []):
        tf = r.get('traceFile')
        if not tf or not os.path.exists(tf):
            code = (r.get('error') or {}).get('code') or r.get('status') or 'unknown'
            refusals[code] = refusals.get(code, 0) + 1
        elif first_collision is None:
            first_collision = first_authored_collision(G.load_trace(tf))
    feasible = [r for r in recs if r.get('firstFailure') != 'NOTRACE']
    port = G.portability(feasible)
    census = P.loss_census(feasible) if feasible else {'counts': {}, 'passed': 0}
    admitted = bool(census['passed'] > 0 and port['ok'])
    return {'id': brief['id'], 'category': brief['category'], 'family': decision['family'],
            'cells': len(recs), 'feasibleCells': len(feasible),
            'passingCells': census['passed'], 'maps': port['nMaps'], 'sites': port['nSites'],
            'admitted': admitted, 'firstFailure': census['counts'],
            'refusalCodes': refusals, 'outdir': outdir,
            'firstAuthoredCollision': first_collision,
            'template': path}


def author_brief(brief, probe_draws, final_draws, max_sites, concurrency, log_dir):
    """The frozen per-brief protocol: author -> (repair) -> probe -> (revise) -> final."""
    trail = {'id': brief['id'], 'category': brief['category'], 'rounds': []}

    # Round 1: author.
    try:
        d1, raw1 = decide(AUTHOR_PROMPT % (TOOLDOC, brief['category'], brief['brief']))
    except Exception as e:                                                 # noqa: BLE001
        return {**trail, 'admitted': False, 'error': 'author_call_failed',
                'detail': str(e)[:200], 'family': None}
    trail['rounds'].append({'kind': 'author', 'decision': d1})
    path, ok, issues = compile_and_validate(brief, d1, 'r1')

    # One repair round on validation failure.
    if not ok:
        try:
            d1, raw1 = decide(REVISE_PROMPT % (
                TOOLDOC, brief['category'], brief['brief'], json.dumps(d1, indent=1),
                'The compiled template FAILED validation:\n' +
                '\n'.join('- ' + i for i in issues), '{}', 0, 0, 0, 0))
            trail['rounds'].append({'kind': 'repair', 'decision': d1})
            path, ok, issues = compile_and_validate(brief, d1, 'r1b')
        except Exception as e:                                             # noqa: BLE001
            return {**trail, 'admitted': False, 'error': 'repair_call_failed',
                    'detail': str(e)[:200], 'family': d1.get('family')}
        if not ok:
            return {**trail, 'admitted': False, 'error': 'template_invalid',
                    'detail': issues, 'family': d1.get('family')}

    # Probe (solve round): cheap batch, real feedback.
    probe = run_and_gate(brief, path, d1, probe_draws, max_sites=6, concurrency=concurrency)
    trail['rounds'].append({'kind': 'probe', 'result':
                            {k: probe.get(k) for k in ('admitted', 'cells', 'feasibleCells',
                                                       'passingCells', 'maps', 'sites',
                                                       'firstFailure', 'firstAuthoredCollision',
                                                       'refusalCodes', 'error')}})
    d_final = d1
    if not probe['admitted']:
        # Round 2: revise against the measured census.
        try:
            d2, raw2 = decide(REVISE_PROMPT % (
                TOOLDOC, brief['category'], brief['brief'], json.dumps(d1, indent=1),
                feedback_lines(probe), json.dumps(probe.get('firstFailure') or {}),
                probe.get('feasibleCells', 0), probe.get('maps', 0), probe.get('sites', 0),
                probe.get('passingCells', 0)))
            trail['rounds'].append({'kind': 'revise', 'decision': d2})
            p2, ok2, iss2 = compile_and_validate(brief, d2, 'r2')
            if ok2:
                d_final, path = d2, p2
        except Exception as e:                                             # noqa: BLE001
            trail['rounds'].append({'kind': 'revise_failed', 'detail': str(e)[:200]})

    # Final measured batch.
    final = run_and_gate(brief, path, d_final, final_draws, max_sites=max_sites,
                         concurrency=concurrency)
    row = {**trail, **final}
    if log_dir:
        json.dump(row, open(os.path.join(log_dir, '%s.json' % brief['id']), 'w'), indent=1)
    return row


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--split', default='DEV', choices=('DEV', 'HELDOUT', 'ALL'))
    ap.add_argument('--probe-draws', type=int, default=4)
    ap.add_argument('--draws', type=int, default=10)
    ap.add_argument('--max-sites', type=int, default=10)
    ap.add_argument('--workers', type=int, default=6)
    ap.add_argument('--batch-concurrency', type=int, default=4)
    ap.add_argument('--limit', type=int)
    ap.add_argument('--only', help='comma-separated brief ids')
    ap.add_argument('--log-dir')
    ap.add_argument('--out')
    a = ap.parse_args()

    briefs, dev, held = A.load_splits()
    if a.split == 'DEV':
        sel = [b for b in briefs if b['id'] in dev]
    elif a.split == 'HELDOUT':
        sel = [b for b in briefs if b['id'] in held]
    else:
        sel = briefs
    if a.only:
        want = set(a.only.split(','))
        sel = [b for b in sel if b['id'] in want]
    if a.limit:
        sel = sel[:a.limit]
    if a.log_dir:
        os.makedirs(a.log_dir, exist_ok=True)
    print('W7 LLM authoring: %d briefs (%s), model %s effort %s, probe=%d final=%d maxSites=%d'
          % (len(sel), a.split, vlm.MODEL, vlm.EFFORT, a.probe_draws, a.draws, a.max_sites))

    def run(b):
        try:
            r = author_brief(b, a.probe_draws, a.draws, a.max_sites, a.batch_concurrency,
                             a.log_dir)
        except Exception as e:                                             # noqa: BLE001
            r = {'id': b['id'], 'category': b['category'], 'family': None,
                 'admitted': False, 'error': 'unhandled', 'detail': str(e)[:300], 'rounds': []}
        with _print_lock:
            print('  %-4s %-24s %-18s cells=%3d pass=%3d maps=%d sites=%d rounds=%d %s'
                  % ('ADM' if r.get('admitted') else '----', r['id'], str(r.get('family')),
                     r.get('feasibleCells', 0) or 0, r.get('passingCells', 0) or 0,
                     r.get('maps', 0) or 0, r.get('sites', 0) or 0,
                     len(r.get('rounds', [])), r.get('error', '')))
        return r

    with concurrent.futures.ThreadPoolExecutor(max_workers=a.workers) as pool:
        rows = list(pool.map(run, sel))

    admitted = sum(1 for r in rows if r.get('admitted'))
    by_cat = {}
    for r in rows:
        c = by_cat.setdefault(r['category'], {'total': 0, 'admitted': 0})
        c['total'] += 1
        c['admitted'] += 1 if r.get('admitted') else 0
    fails = {}
    for r in rows:
        if not r.get('admitted'):
            for k, v in (r.get('firstFailure') or {}).items():
                fails[k] = fails.get(k, 0) + v
            if r.get('error'):
                fails[r['error']] = fails.get(r['error'], 0) + 1

    rep = {'gate': 'W7 LLM authoring (gpt-5.6-luna, effort medium)', 'split': a.split,
           'model': vlm.MODEL, 'effort': vlm.EFFORT,
           'endpoint': os.environ.get('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
           'briefs': len(rows), 'admitted': admitted,
           'admissionRate': round(admitted / len(rows), 4) if rows else 0.0,
           'probeDraws': a.probe_draws, 'draws': a.draws, 'maxSites': a.max_sites,
           'perCategory': dict(sorted(by_cat.items())),
           'categoriesCovered': sum(1 for c in by_cat.values() if c['admitted'] > 0),
           'firstFailureAcrossRejected': dict(sorted(fails.items(), key=lambda kv: -kv[1])),
           'rows': rows}
    print(json.dumps({k: v for k, v in rep.items() if k != 'rows'}, indent=1))
    if a.out:
        json.dump(rep, open(a.out, 'w'), indent=1)
        print('wrote %s' % a.out)
    return 0


if __name__ == '__main__':
    sys.exit(main())
