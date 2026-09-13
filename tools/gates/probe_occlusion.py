#!/usr/bin/env python3
"""OCCLUSION GATE (W2). Can a roadside occluder actually hide a VRU, on real maps?

W2 exit criterion, from the brief:
  * occlusion proven -- `revealed_before_conflict`, with `occluderIneffective` empty -- in >= 50%
    of cells for a C7 brief, on >= 2 maps and >= 3 sites
  * >= 5 C7 archetypes pass gate v2

Five C7 archetypes, each in two arms:

  baseline  the pre-W2 representation. `tFrac` is a fraction of lane width bounded to [-1, 1], so
            occluder and VRU both land on the lane edge -- measured lateral separation 0.01 m, i.e.
            the pedestrian stands INSIDE the hedge.
  fixed     W2: both are placed in metres from the `verge`, so the occluder is genuinely between
            the ego and the VRU.

Both arms declare `props[].occludes: {observer, target}`. That declaration is what produces
`declaredOcclusion` at all; the round-6 surface never emitted it, which is why `declaredOcclusion`
was empty in 0/30 traces. The arms therefore separate two different things, and the report keeps
them apart: the DECLARATION buys the proof, the LATERAL FORM buys the geometry.

Usage:  probe_occlusion.py [--arm baseline|fixed|both] [--draws N] [--out report.json]
Exit 0 when the fixed arm meets both criteria.
"""
import argparse, json, math, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import probe_lib as P                                                      # noqa: E402
import tg_gate as G                                                        # noqa: E402

PROBES = os.path.join(HERE, 'probes')
ARCHETYPES = ('c7-hedge-corner', 'c7-parked-row-child', 'c7-skip-container',
              'c7-bus-shelter', 'c7-fence-run')
PROVEN_MIN = 0.50
ARCHETYPES_MIN = 5
OCC_BRIEF = 'a pedestrian hidden behind a roadside occluder steps into the ego path'


def lateral_separation(instance_file):
    """Separation between the occluder and the VRU at spawn, metres.

    Occluder and VRU are authored at the SAME station `s`, so their plane distance IS the lateral
    separation and needs no projection. An earlier version of this function projected onto the ego
    heading taken at the ego's own position, tens of metres upstream; over that distance the road
    turns by up to 30 degrees and the projection was contaminated by curvature, not geometry.

    This is the number that says whether the scene is physical. `OCCLUSION-FINDING.md` reports the
    occluder ending up at the same lateral position as the VRU it is supposed to hide; a separation
    near zero is what that looks like, and it means the pedestrian is standing inside the hedge.
    """
    try:
        inst = json.load(open(instance_file))
    except Exception:                                                      # noqa: BLE001
        return None
    actors = {a['id']: a for a in inst['input'].get('actors', [])}
    props = {p['id']: p for p in (inst['input'].get('props') or [])}
    if 'vru' not in actors or 'hedge' not in props:
        return None
    v = actors['vru']['initial']['pose']
    p = props['hedge']['pose']
    return math.hypot(v['x'] - p['x'], v['z'] - p['z'])


def run_archetype(aid, arm, draws, concurrency):
    tpl = os.path.join(PROBES, '%s-%s.template.json' % (aid, arm))
    out = P.unique_outdir('occ-%s-%s' % (aid, arm))
    summ = P.run_batch(tpl, out, maps=None, draws=draws, concurrency=concurrency)
    recs = P.gate_summary(summ, brief=OCC_BRIEF, version=2)
    by_trace = {r.get('traceFile'): r for r in summ.get('results', [])}
    for r in recs:
        src = by_trace.get(r.get('trace'))
        r['lateralSepM'] = lateral_separation(src['instanceFile']) if src else None
        occ = r.get('declaredOcclusion') or []
        r['occStatus'] = occ[0].get('status') if occ else 'EMPTY'
        effective = not r.get('occluderIneffective')
        # STRICT: the word the exit criterion uses -- the target was hidden and then revealed.
        r['proven'] = bool(r['occStatus'] == 'revealed_before_conflict' and effective)
        # GATE V2: the frozen C6 also accepts `blocked_at_conflict`, i.e. the target was STILL
        # hidden when the conflict arrived -- a stronger occlusion, not a weaker one. Both are
        # reported so the choice of definition is visible rather than convenient.
        r['provenGateV2'] = bool(r['occStatus'] in G.OCC_OK_STATUS and effective)
    return recs, out


def summarise(aid, recs):
    n = len(recs)
    proven = [r for r in recs if r['proven']]
    proven_v2 = [r for r in recs if r['provenGateV2']]
    admitted = [r for r in recs if r.get('pass')]
    seps = sorted(r['lateralSepM'] for r in recs if r['lateralSepM'] is not None)
    port_all = P.G.portability([dict(r, **{'pass': True}) for r in proven]) if proven else None
    port_adm = G.portability(recs)
    statuses = {}
    for r in recs:
        statuses[r['occStatus']] = statuses.get(r['occStatus'], 0) + 1
    return {'archetype': aid, 'cells': n,
            'proven': len(proven), 'provenShare': round(len(proven) / n, 4) if n else 0.0,
            'provenGateV2': len(proven_v2),
            'provenGateV2Share': round(len(proven_v2) / n, 4) if n else 0.0,
            'provenGateV2Maps': sorted({r.get('mapId') for r in proven_v2 if r.get('mapId')}),
            'provenGateV2Sites': len({(r.get('mapId'), r.get('site')) for r in proven_v2}),
            'provenMaps': sorted({r.get('mapId') for r in proven if r.get('mapId')}),
            'provenSites': len({(r.get('mapId'), r.get('site')) for r in proven}),
            'occluderIneffectiveCells': sum(1 for r in recs if r.get('occluderIneffective')),
            'statuses': dict(sorted(statuses.items(), key=lambda kv: -kv[1])),
            'medianLateralSepM': round(seps[len(seps) // 2], 3) if seps else None,
            'gateV2Admitted': len(admitted),
            'gateV2Maps': port_adm['nMaps'], 'gateV2Sites': port_adm['nSites'],
            'gateV2Portable': port_adm['ok'],
            'firstFailure': P.loss_census(recs)['counts']}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--arm', default='both', choices=('baseline', 'fixed', 'both'))
    ap.add_argument('--draws', type=int, default=6)
    ap.add_argument('--concurrency', type=int, default=7)
    ap.add_argument('--out')
    a = ap.parse_args()

    arms = ('baseline', 'fixed') if a.arm == 'both' else (a.arm,)
    report = {'gate': 'occlusion probe (W2)',
              'criteria': {'provenShare': '>= %.2f' % PROVEN_MIN, 'maps': '>= 2', 'sites': '>= 3',
                           'archetypesPassingGateV2': '>= %d' % ARCHETYPES_MIN},
              'arms': {}}
    for arm in arms:
        rows = []
        for aid in ARCHETYPES:
            recs, out = run_archetype(aid, arm, a.draws, a.concurrency)
            s = summarise(aid, recs)
            rows.append(s)
            print('  %-9s %-22s cells=%3d proven=%3d (%.2f) maps=%d sites=%d sep=%s admitted=%d '
                  'maps/sites=%d/%d %s | provenV2=%.2f'
                  % (arm, aid, s['cells'], s['proven'], s['provenShare'], len(s['provenMaps']),
                     s['provenSites'], s['medianLateralSepM'], s['gateV2Admitted'],
                     s['gateV2Maps'], s['gateV2Sites'], 'PORTABLE' if s['gateV2Portable'] else '',
                     s['provenGateV2Share']))
        qualifying = [r for r in rows
                      if r['provenShare'] >= PROVEN_MIN and len(r['provenMaps']) >= 2
                      and r['provenSites'] >= 3]
        qualifying_v2 = [r for r in rows
                         if r['provenGateV2Share'] >= PROVEN_MIN
                         and len(r['provenGateV2Maps']) >= 2 and r['provenGateV2Sites'] >= 3]
        admitted_arch = [r for r in rows if r['gateV2Admitted'] > 0 and r['gateV2Portable']]
        seps = [r['medianLateralSepM'] for r in rows if r['medianLateralSepM'] is not None]
        report['arms'][arm] = {
            'archetypes': rows,
            'archetypesMeetingProvenClause': len(qualifying),
            'archetypesMeetingProvenClauseGateV2': len(qualifying_v2),
            'archetypesPassingGateV2': len(admitted_arch),
            'medianLateralSeparationM': round(sorted(seps)[len(seps) // 2], 3) if seps else None,
            'pass': bool(len(qualifying) >= 1 and len(admitted_arch) >= ARCHETYPES_MIN)}
        r = report['arms'][arm]
        print('  --> %s: proven clause met by %d/5 (strict) and %d/5 (gate-v2 statuses); '
              '%d/5 pass gate v2 portably; median occluder-VRU separation %s m\n'
              % (arm, r['archetypesMeetingProvenClause'], r['archetypesMeetingProvenClauseGateV2'],
                 r['archetypesPassingGateV2'], r['medianLateralSeparationM']))

    report['pass'] = report['arms'].get('fixed', {}).get('pass')
    if a.out:
        json.dump(report, open(a.out, 'w'), indent=1)
        print('wrote %s' % a.out)
    print('OCCLUSION PROBE GATE: %s' % ('PASS' if report['pass'] else 'FAIL'))
    return 0 if report['pass'] else 1


if __name__ == '__main__':
    sys.exit(main())
