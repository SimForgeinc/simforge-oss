"""M4 re-cast template builders.

Each family reproduces a mined encounter geometry with the EGO in one participant's
role and an AUTHORED (non-ambient) challenger in the other's -- the only route past the
frozen gate, which cannot see ambient actors. Parameter ranges are centred on the mined
event's kinematics and clamped to ranges the gold corpus proved admissible. Ambient
stays ON at batch time (the world stays alive); the authored pair carries the gate.
"""
import copy, json

CLAMP = lambda v, lo, hi: max(lo, min(hi, v))                              # noqa: E731


def _meta(name, archetype, tags, ev):
    src = ev['cell']
    return {
        'name': name,
        'description': ('Re-cast of a mined emergent encounter (%s, %s/%s preset=%s '
                        'seed=%s site=%s, tier %s, clearance %.2f m, TTC %s s). Ego '
                        'takes one participant role; an authored challenger reproduces '
                        'the other; ambient traffic stays on.'
                        % (ev['category'], src['template'], src['map'], src['preset'],
                           src['seed'], src['site'], ev['tier'], ev['minClearanceM'],
                           ev['ttcRrS'])),
        'createdAt': '2026-08-15T00:00:00.000Z', 'modifiedAt': '2026-08-15T00:00:00.000Z',
        'appVersion': 'uniscenarios/0.0.1', 'archetype': archetype,
        'tags': ['worldgen-recast'] + tags, 'author': 'agent/tg-research-worldgen',
        'negativeControl': False,
    }


def _corridor_anchor(aid, lanes=(1, 8), runway=220, opposing=None, lane_change=False):
    c = {
        'throughLanesSameDir': {'value': list(lanes), 'essentiality': 'required'},
        'curvatureDegPer10m': {'value': [0, 5], 'essentiality': 'required'},
        'runwayDownstreamM': {'value': [runway, None], 'essentiality': 'required'},
    }
    if opposing:
        c['throughLanesOpposing'] = {'value': list(opposing), 'essentiality': 'required'}
        c['runwayUpstreamM'] = {'value': [100, None], 'essentiality': 'required'}
    if lane_change:
        c['laneChangeLegal'] = {'value': {'side': 'either', 'sRange': [30, 150]},
                                'essentiality': 'required'}
    return {'id': aid, 'corridor': c, 'features': [],
            'policy': {'allowMirror': True, 'maxSitesPerMap': 12,
                       'diversity': 'moderate', 'minScore': 0.5}}


def _params(decls):
    return {'declarations': decls, 'constraints': []}


def _p(pid, unit, rng, default):
    return {'id': pid, 'type': 'continuous', 'unit': unit, 'tier': 1,
            'range': [round(rng[0], 3), round(rng[1], 3)],
            'default': round(default, 3), 'distribution': 'uniform'}


def _bracket(center, lo, hi, spread=0.2):
    c = CLAMP(center, lo, hi)
    return [max(lo, c * (1 - spread)), min(hi, c * (1 + spread))], c


ACTOR = {
    'car': {'class': 'car', 'catalogId': 'vehicle.hatchback'},
    'van': {'class': 'van', 'catalogId': 'vehicle.van'},
    'truck': {'class': 'truck', 'catalogId': 'vehicle.box_truck'},
    'bus': {'class': 'bus', 'catalogId': 'vehicle.bus'},
    'motorcycle': {'class': 'motorcycle', 'catalogId': 'vehicle.motorcycle'},
    'bicycle': {'class': 'bicycle'},
}


def counterpart_kind(ev):
    ks = [k for k in ev['kinds'] if k != 'ego']
    for pref in ('bicycle', 'motorcycle', 'truck', 'bus', 'van'):
        if pref in ks:
            return pref
    return ks[0] if ks else 'car'


def rear_end(ev, brake=True):
    """Same-dir same-lane conflict: ego closes on a braking or slow lead."""
    kind = counterpart_kind(ev)
    v_fast = max(ev['speedsAtStart'])
    if brake:
        dec = max(ev['maxDecel'])
        gap_rng, gap_d = _bracket(1.2 * max(v_fast, 10), 15, 30)
        dec_rng, dec_d = _bracket(dec if dec >= 4 else 6.5, 4, 8, 0.15)
        decls = [_p('initialGapM', 'm', gap_rng, gap_d),
                 _p('leadDecelMps2', 'm/s^2', dec_rng, dec_d),
                 _p('reactionDelayS', 's', [0.5, 1.4], 0.9)]
        inter = [
            {'id': 'ego-delays-response', 'actor': 'ego', 'verb': 'set',
             'trigger': {'kind': 'at', 't': 0},
             'target': {'key': 'rules.collisionAvoidance', 'value': False}},
            {'id': 'lead-brakes', 'actor': 'lead', 'verb': 'speed',
             'trigger': {'kind': 'at', 't': 3}, 'target': {'mode': 'stop'},
             'dynamics': {'shape': 'linear', 'constraint': 'rate',
                          'value': 'param.leadDecelMps2'}},
            {'id': 'ego-brakes', 'actor': 'ego', 'verb': 'speed',
             'trigger': {'kind': 'after', 'of': 'lead-brakes', 'event': 'start',
                         'delayS': 'param.reactionDelayS'},
             'target': {'mode': 'stop'},
             'dynamics': {'shape': 'linear', 'constraint': 'rate', 'value': 8}}]
        invs = [
            {'id': 'rear-end-criticality', 'kind': 'ttc', 'of': 'ego', 'to': 'lead',
             'range': [0.7, 3], 'mode': 'min', 'window': [3, 10],
             'essentiality': 'required'},
            {'id': 'response-budget', 'kind': 'decel_budget', 'of': 'ego',
             'maxMps2': 8, 'essentiality': 'required'},
            {'id': 'minimum-clearance', 'kind': 'gap', 'of': 'ego', 'to': 'lead',
             'unit': 'distance', 'range': [0.5, None], 'window': [3, 12],
             'essentiality': 'required'},
            {'id': 'event-sequence', 'kind': 'event_order',
             'events': ['lead-brakes', 'ego-brakes'], 'strict': True,
             'minSeparationS': 'param.reactionDelayS', 'essentiality': 'required'}]
        lead_speed = 'clamp(0.8 * lane.speedLimitKph, 30, 60)'
        arch, tags = 'worldgen-recast.rear-end-brake', ['rear-end', 'mined']
    else:
        v_slow = min(ev['speedsAtTStar'])
        sl_rng, sl_d = _bracket(max(v_slow * 3.6, 10), 8, 25)
        ttc_rng, ttc_d = _bracket(ev['ttcRrS'] or 1.5, 0.8, 2.2, 0.25)
        decls = [_p('leadSpeedKph', 'kph', sl_rng, sl_d),
                 _p('reactTtcS', 's', ttc_rng, ttc_d),
                 _p('initialGapM', 'm', [30, 45], 38)]
        inter = [
            {'id': 'ego-delays-response', 'actor': 'ego', 'verb': 'set',
             'trigger': {'kind': 'at', 't': 0},
             'target': {'key': 'rules.collisionAvoidance', 'value': False}},
            {'id': 'ego-brakes', 'actor': 'ego', 'verb': 'speed',
             'trigger': {'kind': 'when',
                         'condition': {'kind': 'ttc', 'of': 'ego', 'to': 'lead',
                                       'op': '<=', 'valueS': 'param.reactTtcS'},
                         'byLatest': 12, 'ifNever': 'fire'},
             'target': {'mode': 'match', 'role': 'lead', 'offsetKph': 0},
             'dynamics': {'shape': 'linear', 'constraint': 'rate', 'value': 8}}]
        invs = [
            {'id': 'slow-lead-criticality', 'kind': 'ttc', 'of': 'ego', 'to': 'lead',
             'range': [0.5, 3], 'mode': 'min', 'window': [2, 12],
             'essentiality': 'required'},
            {'id': 'response-budget', 'kind': 'decel_budget', 'of': 'ego',
             'maxMps2': 8, 'essentiality': 'required'}]
        lead_speed = 'param.leadSpeedKph'
        arch, tags = 'worldgen-recast.slow-lead', ['slow-lead', 'vru-lead', 'mined']
    return {
        'scenarioVersion': 2,
        'meta': _meta('Re-cast: %s lead conflict (%s)' % ('braking' if brake else 'slow',
                                                          kind), arch, tags, ev),
        'params': _params(decls),
        'environment': {'weather': 'clear', 'timeOfDay': 'noon'},
        'anchor': _corridor_anchor(arch.split('.')[1]),
        'roles': [
            {'id': 'ego', 'kind': 'on_reference',
             'actor': {'class': 'car', 'catalogId': 'vehicle.sedan'},
             'pose': {'laneOffset': 0, 's': 30, 'tFrac': 0, 'headingOffsetRad': 0},
             'initialSpeedKph': 'clamp(0.8 * lane.speedLimitKph, 30, 60)'},
            {'id': 'lead', 'kind': 'relative_to', 'label': 'mined counterpart, re-cast',
             'actor': ACTOR[kind], 'requiredSameSegmentAs': 'ego',
             'requiredHeadingRelation': {'role': 'ego', 'relation': 'parallel',
                                         'maxErrorDeg': 10},
             'ref': 'ego', 'dLane': 0, 'dsM': 'param.initialGapM', 'tFrac': 0,
             'headingOffsetRad': 0, 'initialSpeedKph': lead_speed}],
        'props': [],
        'choreography': {'clipSeconds': 14, 'warmupSeconds': 2, 'interactions': inter},
        'invariants': invs, 'variants': [], 'metricSubject': 'ego',
    }


def cut_in(ev):
    """Same-dir adjacent-lane lateral convergence: challenger inserts and brakes."""
    kind = counterpart_kind(ev)
    dec = max(ev['maxDecel'])
    ins_rng, ins_d = _bracket(max(ev['speedsAtStart']) * 1.0, 12, 20, 0.15)
    dec_rng, dec_d = _bracket(dec if dec >= 4 else 5.25, 4, 6, 0.1)
    return {
        'scenarioVersion': 2,
        'meta': _meta('Re-cast: cut-in and brake (%s)' % kind,
                      'worldgen-recast.cut-in-brake', ['cut-in', 'mined'], ev),
        'params': _params([_p('insertionLeadM', 'm', ins_rng, ins_d),
                           _p('lateralRateMps', 'm/s', [1.3, 1.7], 1.5),
                           _p('cutInDecelMps2', 'm/s^2', dec_rng, dec_d)]),
        'environment': {'weather': 'clear', 'timeOfDay': 'noon'},
        'anchor': _corridor_anchor('worldgen-recast-cut-in', lanes=(2, 8), runway=240,
                                   lane_change=True),
        'roles': [
            {'id': 'ego', 'kind': 'on_reference',
             'actor': {'class': 'car', 'catalogId': 'vehicle.sedan'},
             'pose': {'laneOffset': 0, 's': 28, 'tFrac': 0, 'headingOffsetRad': 0},
             'initialSpeedKph': 'clamp(0.82 * lane.speedLimitKph, 30, 55)'},
            {'id': 'cut-in', 'kind': 'relative_to', 'label': 'mined counterpart, re-cast',
             'actor': ACTOR[kind], 'requiredSameRoadSectionAs': 'ego',
             'requiredHeadingRelation': {'role': 'ego', 'relation': 'parallel',
                                         'maxErrorDeg': 10},
             'ref': 'ego', 'dLane': -1, 'dsM': '-param.insertionLeadM', 'tFrac': 0,
             'headingOffsetRad': 0,
             'initialSpeedKph': 'clamp(0.92 * lane.speedLimitKph, 33, 60)'}],
        'props': [],
        'choreography': {'clipSeconds': 8, 'warmupSeconds': 2, 'interactions': [
            {'id': 'cut-in-enters', 'actor': 'cut-in', 'verb': 'changeLane',
             'trigger': {'kind': 'at', 't': 1}, 'target': {'mode': 'toRole', 'role': 'ego'},
             'dynamics': {'shape': 'sinusoidal', 'constraint': 'rate',
                          'value': 'param.lateralRateMps'}},
            {'id': 'cut-in-brakes', 'actor': 'cut-in', 'verb': 'speed',
             'trigger': {'kind': 'after', 'of': 'cut-in-enters', 'event': 'start',
                         'delayS': 2.6},
             'target': {'mode': 'factor', 'factor': 0.3},
             'dynamics': {'shape': 'linear', 'constraint': 'rate',
                          'value': 'param.cutInDecelMps2'}},
            {'id': 'ego-brakes', 'actor': 'ego', 'verb': 'speed',
             'trigger': {'kind': 'after', 'of': 'cut-in-brakes', 'event': 'start',
                         'delayS': 1.1},
             'target': {'mode': 'stop'},
             'dynamics': {'shape': 'linear', 'constraint': 'rate', 'value': 5.5}}]},
        'invariants': [
            {'id': 'cut-in-criticality', 'kind': 'ttc', 'of': 'ego', 'to': 'cut-in',
             'range': [0.5, 3], 'mode': 'min', 'window': [3.5, 7],
             'essentiality': 'required'},
            {'id': 'cut-in-sequence', 'kind': 'event_order',
             'events': ['cut-in-enters', 'cut-in-brakes', 'ego-brakes'], 'strict': True,
             'minSeparationS': 1.1, 'essentiality': 'required'},
            {'id': 'ego-braking-budget', 'kind': 'decel_budget', 'of': 'ego',
             'maxMps2': 8, 'essentiality': 'required'}],
        'variants': [], 'metricSubject': 'ego',
    }


def path_cross(ev):
    """Mid-block crossing of ego's corridor (cyclist or emerging vehicle)."""
    kind = counterpart_kind(ev)
    v = max(min(ev['speedsAtTStar']), 2.0)
    speed_lo, speed_hi = (10, 26) if kind == 'bicycle' else (12, 30)
    sp_rng, sp_d = _bracket(v * 3.6, speed_lo, speed_hi)
    ttc_rng, ttc_d = _bracket(ev['ttcRrS'] or 1.4, 1.0, 1.8, 0.25)
    return {
        'scenarioVersion': 2,
        'meta': _meta('Re-cast: %s crosses the corridor' % kind,
                      'worldgen-recast.path-cross', ['crossing', 'mined'], ev),
        'params': _params([_p('arrivalTtc', 's', ttc_rng, ttc_d),
                           _p('crosserSpeedKph', 'kph', sp_rng, sp_d)]),
        'environment': {'weather': 'clear', 'timeOfDay': 'noon'},
        'anchor': _corridor_anchor('worldgen-recast-path-cross', lanes=(1, 3),
                                   runway=150),
        'roles': [
            {'id': 'ego', 'kind': 'on_reference',
             'actor': {'class': 'car', 'catalogId': 'vehicle.sedan'},
             'pose': {'laneOffset': 0,
                      's': '100 - (clamp(0.8 * lane.speedLimitKph, 22, 48) / 3.6) * 5.5',
                      'tFrac': 0, 'headingOffsetRad': 0},
             'initialSpeedKph': 'clamp(0.8 * lane.speedLimitKph, 22, 48)'},
            {'id': 'crosser', 'kind': 'on_reference', 'label': 'mined counterpart, re-cast',
             'actor': ACTOR[kind],
             'pose': {'laneOffset': 0, 's': 65, 'tFrac': -1, 'headingOffsetRad': 0},
             'initialSpeedKph': 'param.crosserSpeedKph'}],
        'props': [],
        'choreography': {'clipSeconds': 12, 'warmupSeconds': 1, 'interactions': [
            {'id': 'ego-holds-course', 'actor': 'ego', 'verb': 'set',
             'trigger': {'kind': 'at', 't': 0},
             'target': {'key': 'rules.collisionAvoidance', 'value': False}},
            {'id': 'crosser-commits', 'actor': 'crosser', 'verb': 'set',
             'trigger': {'kind': 'at', 't': 0},
             'target': {'key': 'rules.collisionAvoidance', 'value': False}},
            {'id': 'crosser-crosses', 'actor': 'crosser', 'verb': 'route',
             'trigger': {'kind': 'at', 't': 0},
             'target': {'mode': 'polyline', 'points': [
                 {'laneOffset': 0, 's': 65, 'tFrac': -1, 'headingOffsetRad': 0},
                 {'laneOffset': 0, 's': 100, 'tFrac': -1, 'headingOffsetRad': 0},
                 {'laneOffset': 0, 's': 100, 'tFrac': 0, 'headingOffsetRad': 0},
                 {'laneOffset': 0, 's': 100, 'tFrac': 1, 'headingOffsetRad': 0}]}},
            {'id': 'crosser-arrival', 'actor': 'crosser', 'verb': 'speed',
             'trigger': {'kind': 'arrival', 'of': 'crosser',
                         'at': {'pose': {'laneOffset': 0, 's': 100, 'tFrac': 0,
                                         'headingOffsetRad': 0}},
                         'syncWith': 'ego', 'ttc': 'param.arrivalTtc'},
             'target': {'mode': 'absolute', 'valueKph': 'param.crosserSpeedKph'},
             'dynamics': {'shape': 'step', 'constraint': 'time', 'value': 0.1}}]},
        'invariants': [
            {'id': 'criticality', 'kind': 'pet', 'essentiality': 'required',
             'of': 'ego', 'to': 'crosser', 'range': [0.2, 3]},
            {'id': 'arrival-band', 'kind': 'arrival', 'essentiality': 'required',
             'of': 'crosser',
             'at': {'pose': {'laneOffset': 0, 's': 100, 'tFrac': 0,
                             'headingOffsetRad': 0}},
             'syncWith': 'ego', 'deltaTRange': [-2.6, -0.8]}],
        'variants': [], 'metricSubject': 'ego',
    }


def junction_cross(ev):
    """Crossing conflict at a junction: challenger violates priority."""
    kind = counterpart_kind(ev)
    dt_rng, dt_d = _bracket((ev['ttcRrS'] or 0.8), 0.5, 1.3, 0.3)
    return {
        'scenarioVersion': 2,
        'meta': _meta('Re-cast: junction crossing conflict (%s)' % kind,
                      'worldgen-recast.junction-cross', ['junction', 'mined'], ev),
        'params': _params([_p('arrivalDeltaS', 's', dt_rng, dt_d)]),
        'environment': {'weather': 'clear', 'timeOfDay': 'noon'},
        'anchor': {
            'id': 'worldgen-recast-junction',
            'corridor': {
                'throughLanesSameDir': {'value': [1, 5], 'essentiality': 'required'},
                'runwayUpstreamM': {'value': [45, None], 'essentiality': 'required'},
                'runwayDownstreamM': {'value': [65, None], 'essentiality': 'required'}},
            'features': [{
                'id': 'conflict-junction', 'kind': 'junction',
                'essentiality': 'required',
                'atM': {'value': [0, 0], 'essentiality': 'required'},
                'arms': {'value': [3, 4], 'essentiality': 'required'},
                'egoTurn': {'value': ['straight'], 'essentiality': 'required'},
                'conflictingApproach': {
                    'value': {'from': 'from_left', 'turn': 'straight',
                              'crossingAngleDeg': [60, 120]},
                    'essentiality': 'required'}}],
            'policy': {'allowMirror': True, 'maxSitesPerMap': 12,
                       'diversity': 'moderate', 'minScore': 0.4}},
        'roles': [
            {'id': 'ego', 'kind': 'on_reference',
             'actor': {'class': 'car', 'catalogId': 'vehicle.sedan'},
             'pose': {'laneOffset': 0, 's': -42, 'tFrac': 0, 'headingOffsetRad': 0},
             'initialSpeedKph': 'clamp(0.62 * lane.speedLimitKph, 18, 38)'},
            {'id': 'crosser', 'kind': 'conflicting_gate', 'feature': 'conflict-junction',
             'from': 'from_left', 'turn': 'straight',
             'actor': ACTOR[kind],
             'arriveAtConflict': {'relativeTo': 'ego', 'deltaT': 'param.arrivalDeltaS'},
             'initialSpeedKph': 'clamp(0.7 * lane.speedLimitKph, 20, 42)'}],
        'props': [],
        'choreography': {'clipSeconds': 16, 'warmupSeconds': 2, 'interactions': [
            {'id': 'crosser-ignores-signals', 'actor': 'crosser', 'verb': 'set',
             'trigger': {'kind': 'at', 't': 0},
             'target': {'key': 'rules.obeySignals', 'value': False}},
            {'id': 'crosser-commits', 'actor': 'crosser', 'verb': 'set',
             'trigger': {'kind': 'at', 't': 0},
             'target': {'key': 'rules.collisionAvoidance', 'value': False}}]},
        'invariants': [
            {'id': 'crossing-criticality', 'kind': 'pet', 'of': 'ego', 'to': 'crosser',
             'range': [0.3, 1.5], 'window': [3, 14], 'essentiality': 'required'},
            {'id': 'crosser-arrival', 'kind': 'arrival', 'of': 'crosser',
             'at': {'feature': 'conflict-junction', 'at': 'center'}, 'syncWith': 'ego',
             'deltaTRange': [0.3, 1.6], 'essentiality': 'required'}],
        'variants': [], 'metricSubject': 'ego',
    }


def opposing(ev):
    """Opposing-lane encroachment into ego's path with late return."""
    kind = counterpart_kind(ev)
    ttc_rng, ttc_d = _bracket(ev['ttcRrS'] or 2.1, 1.6, 2.6, 0.2)
    return {
        'scenarioVersion': 2,
        'meta': _meta('Re-cast: opposing encroachment (%s)' % kind,
                      'worldgen-recast.opposing-encroach', ['oncoming', 'mined'], ev),
        'params': _params([_p('returnTtcS', 's', ttc_rng, ttc_d),
                           _p('lateralRateMps', 'm/s', [0.7, 1.4], 1.0)]),
        'environment': {'weather': 'clear', 'timeOfDay': 'noon'},
        'anchor': _corridor_anchor('worldgen-recast-opposing', lanes=(1, 3),
                                   runway=180, opposing=(1, 4)),
        'roles': [
            {'id': 'ego', 'kind': 'on_reference',
             'actor': {'class': 'car', 'catalogId': 'vehicle.sedan'},
             'pose': {'laneOffset': 0, 's': -99, 'tFrac': 0, 'headingOffsetRad': 0},
             'initialSpeedKph': 'clamp(0.4 * lane.speedLimitKph, 25, 34)'},
            {'id': 'encroacher', 'kind': 'opposing', 'k': 0,
             'label': 'mined counterpart, re-cast', 'actor': ACTOR[kind],
             'pose': {'laneOffset': 0, 's': -3.5, 'tFrac': 0, 'headingOffsetRad': 0},
             'initialSpeedKph': 'clamp(0.48 * lane.speedLimitKph, 30, 40)',
             'requiredHeadingRelation': {'role': 'ego', 'relation': 'antiparallel',
                                         'maxErrorDeg': 8}}],
        'props': [],
        'choreography': {'clipSeconds': 16, 'warmupSeconds': 0, 'interactions': [
            {'id': 'encroacher-commits', 'actor': 'encroacher', 'verb': 'set',
             'trigger': {'kind': 'at', 't': 0},
             'target': {'key': 'rules.collisionAvoidance', 'value': False}},
            {'id': 'crosses-centerline', 'actor': 'encroacher', 'verb': 'changeLane',
             'trigger': {'kind': 'at', 't': 1.5},
             'target': {'mode': 'toRole', 'role': 'ego'},
             'dynamics': {'shape': 'sinusoidal', 'constraint': 'rate',
                          'value': 'param.lateralRateMps'}},
            {'id': 'returns-opposing', 'actor': 'encroacher', 'verb': 'laneOffset',
             'trigger': {'kind': 'when',
                         'condition': {'kind': 'ttc', 'of': 'encroacher', 'to': 'ego',
                                       'op': '<=', 'valueS': 'param.returnTtcS'},
                         'byLatest': 10, 'ifNever': 'fire'},
             'target': {'tFrac': 0, 'reference': 'lane_center'},
             'dynamics': {'shape': 'sinusoidal', 'constraint': 'rate',
                          'value': 'param.lateralRateMps'}}]},
        'invariants': [
            {'id': 'centerline-occupancy-order', 'kind': 'event_order',
             'events': ['crosses-centerline', 'returns-opposing'], 'strict': True,
             'minSeparationS': 1, 'essentiality': 'required'},
            {'id': 'head-on-criticality', 'kind': 'ttc', 'of': 'ego', 'to': 'encroacher',
             'range': [0.3, 3.8], 'mode': 'min', 'window': [2, 12],
             'essentiality': 'required'}],
        'variants': [], 'metricSubject': 'ego',
    }


def family_for(ev):
    """Registered family routing by mined category + geometry."""
    cat, hb = ev['category'], ev['signature'][0]
    if cat in ('C1', 'C1-adjacent'):
        return 'rear_end_brake', lambda e: rear_end(e, brake=True)
    if cat in ('C9', 'C11'):
        return 'rear_end_brake', lambda e: rear_end(e, brake=True)
    if cat == 'C2' and hb == 'crossing':
        return 'path_cross', path_cross
    if cat == 'C2':
        return 'cut_in', cut_in
    if cat == 'C3':
        return 'junction_cross', junction_cross
    if cat == 'C10':
        return 'opposing', opposing
    if cat == 'C6' and hb == 'crossing':
        return 'path_cross', path_cross
    if cat == 'C6' and hb == 'same-dir':
        return 'slow_vru_lead', lambda e: rear_end(e, brake=False)
    if cat == 'C6':
        return 'opposing', opposing
    if cat == 'C5':
        return 'path_cross', path_cross
    return None, None
