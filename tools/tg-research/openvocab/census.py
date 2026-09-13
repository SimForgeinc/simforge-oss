#!/usr/bin/env python3
"""Richness census from RAW traces, per admitted brief of an openvocab run.

Every number here is read from the trace file (`tg_gate.load_trace`) — never from
summary fields. Definitions are pre-registered in PREREG.md §Richness:

- actorsPresent      : actors with >=1 present tick (ego + scripted + ambient).
- ambientActors      : header.ambientActorIds that are present at >=1 tick.
- challengerCount    : non-ego, non-ambient actors with metadata static != true.
- staticActors       : non-ego, non-ambient actors with metadata static == true.
- verbsFired         : distinct verbs among the template's interactions minus the
                       interactions named in trace metrics.triggerNeverFired.
- signalPhaseChanges : value transitions across ticks.signals arrays.
- unscriptedLaneChanges : lane-index changes (same road:section, different lane) between
                       consecutive present ticks, by actors with no authored
                       changeLane/laneOffset interaction (ambient always qualifies).
- unscriptedStops    : stop-and-resume cycles (speed < 0.3 m/s held >= 1.0 s after
                       having moved >= 2 m/s, then > 1.0 m/s again) by non-ego actors
                       with no authored speed/gap interaction — the yield/queue signature.

Per brief the census is the MEAN over its gate-PASSING cells of the final batch (the
admitted archetype is those cells). Usage: census.py --report report.json --out census.json
"""
import argparse, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
sys.path.insert(0, os.path.join(ROOT, 'tools', 'gates'))
import tg_gate as G                                                         # noqa: E402


def rsl_parts(rsl):
    if not isinstance(rsl, str):
        return None
    bits = rsl.rsplit(':', 2)
    return (bits[0], bits[1], bits[2]) if len(bits) == 3 else None


def cell_census(trace, template):
    hdr, ticks = trace['header'], trace['ticks']
    meta = hdr.get('actorMetadata', {})
    ambient = set(hdr.get('ambientActorIds') or [])
    inter = (template.get('choreography') or {}).get('interactions') or []
    tnf = set(map(str, trace.get('metrics', {}).get('triggerNeverFired') or []))
    verbs_fired = sorted({i['verb'] for i in inter
                          if i.get('id') not in tnf and i.get('verb')})
    lat_scripted = {i.get('actor') for i in inter if i.get('verb') in ('changeLane',
                                                                       'laneOffset')}
    lon_scripted = {i.get('actor') for i in inter if i.get('verb') in ('speed', 'gap')}

    present, amb_present, challengers, statics = [], 0, 0, 0
    lane_changes, stops = 0, 0
    for aid, a in ticks['actors'].items():
        if not any(a['present']):
            continue
        present.append(aid)
        is_amb = aid in ambient
        if is_amb:
            amb_present += 1
        elif aid != 'ego':
            if meta.get(aid, {}).get('static'):
                statics += 1
            else:
                challengers += 1
        if aid == 'ego':
            continue
        # unscripted lane changes
        if is_amb or aid not in lat_scripted:
            prev = None
            for rsl, pr in zip(a['laneRsl'], a['present']):
                if not pr:
                    prev = None
                    continue
                cur = rsl_parts(rsl)
                if prev and cur and prev[0] == cur[0] and prev[1] == cur[1] \
                        and prev[2] != cur[2]:
                    lane_changes += 1
                prev = cur
        # unscripted stop-and-resume cycles
        if is_amb or aid not in lon_scripted:
            dt = hdr.get('dt', 0.02)
            moved = False
            stopped_for = 0.0
            counted = False
            for v, pr in zip(a['speedMps'], a['present']):
                if not pr:
                    continue
                if v >= 2.0:
                    moved = True
                    counted = False
                if moved and v < 0.3:
                    stopped_for += dt
                    if stopped_for >= 1.0 and not counted:
                        stops += 1
                        counted = True
                elif v > 1.0:
                    stopped_for = 0.0
    signal_changes = 0
    for sid, arr in (ticks.get('signals') or {}).items():
        signal_changes += sum(1 for i in range(1, len(arr)) if arr[i] != arr[i - 1])
    return {'actorsPresent': len(present), 'ambientActors': amb_present,
            'challengerCount': challengers, 'staticActors': statics,
            'verbsFired': verbs_fired, 'nVerbsFired': len(verbs_fired),
            'signalPhaseChanges': signal_changes,
            'unscriptedLaneChanges': lane_changes, 'unscriptedStops': stops}


def brief_census(row):
    outdir = row.get('outdir')
    summ = os.path.join(outdir or '', 'batch-summary.json')
    if not outdir or not os.path.exists(summ):
        return None
    template = json.load(open(row['template'])) if row.get('template') and \
        os.path.exists(row['template']) else {}
    summary = json.load(open(summ))
    cells = []
    for r in summary.get('results', []):
        tf = r.get('traceFile')
        if not tf or not os.path.exists(tf):
            continue
        g = G.gate_cell(tf, verdict=r.get('verdict'), band=r.get('band'),
                        brief=row.get('briefText'), version=2)
        if not g.get('pass'):
            continue
        cells.append(cell_census(G.load_trace(tf), template))
    if not cells:
        return None
    n = len(cells)
    agg = {k: round(sum(c[k] for c in cells) / n, 2)
           for k in ('actorsPresent', 'ambientActors', 'challengerCount', 'staticActors',
                     'nVerbsFired', 'signalPhaseChanges', 'unscriptedLaneChanges',
                     'unscriptedStops')}
    verbs = sorted({v for c in cells for v in c['verbsFired']})
    return {'id': row['id'], 'category': row['category'], 'passingCells': n,
            'ambientRequested': row.get('ambient'), **agg, 'verbsFired': verbs}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--report', required=True)
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    rep = json.load(open(a.report))
    corpus = json.load(open(os.path.join(ROOT, 'research', 'edge-case-corpus',
                                         'agent-authoring', 'brief-corpus-full.json')))
    brief_by_id = {b['id']: b['brief'] for b in corpus['briefs']}
    rows = [r for r in rep['rows'] if r.get('admitted')]
    out_rows = []
    for r in rows:
        r['briefText'] = brief_by_id.get(r['id'])
        c = brief_census(r)
        if c:
            out_rows.append(c)
        print('  census %-24s %s' % (r['id'], json.dumps(
            {k: c[k] for k in ('actorsPresent', 'ambientActors', 'challengerCount',
                               'nVerbsFired', 'signalPhaseChanges',
                               'unscriptedLaneChanges', 'unscriptedStops')})
            if c else 'no passing cells found'), flush=True)

    def dist(key):
        vals = sorted(c[key] for c in out_rows)
        n = len(vals)
        if not n:
            return None
        return {'mean': round(sum(vals) / n, 2), 'min': vals[0], 'max': vals[-1],
                'median': vals[n // 2], 'p25': vals[n // 4], 'p75': vals[3 * n // 4]}

    result = {
        'nAdmittedWithCells': len(out_rows),
        'distributions': {k: dist(k) for k in ('actorsPresent', 'ambientActors',
                                               'challengerCount', 'staticActors',
                                               'nVerbsFired', 'signalPhaseChanges',
                                               'unscriptedLaneChanges', 'unscriptedStops')},
        'shares': {
            'ambientOn': round(sum(1 for c in out_rows if c['ambientActors'] > 0)
                               / len(out_rows), 4) if out_rows else None,
            'multiChallenger': round(sum(1 for c in out_rows if c['challengerCount'] > 1)
                                     / len(out_rows), 4) if out_rows else None,
            'signalDynamics': round(sum(1 for c in out_rows if c['signalPhaseChanges'] > 0)
                                    / len(out_rows), 4) if out_rows else None,
            'unscriptedMotion': round(sum(1 for c in out_rows
                                          if c['unscriptedLaneChanges'] > 0
                                          or c['unscriptedStops'] > 0)
                                      / len(out_rows), 4) if out_rows else None,
        },
        'ambientRequestedDistribution': {},
        'verbUsage': {},
        'perBrief': out_rows,
    }
    for r in rep['rows']:
        amb = r.get('ambient') or 'n/a'
        result['ambientRequestedDistribution'][amb] = \
            result['ambientRequestedDistribution'].get(amb, 0) + 1
    for c in out_rows:
        for v in c['verbsFired']:
            result['verbUsage'][v] = result['verbUsage'].get(v, 0) + 1
    json.dump(result, open(a.out, 'w'), indent=1)
    print(json.dumps({k: v for k, v in result.items() if k != 'perBrief'}, indent=1))
    print('wrote %s' % a.out)
    return 0


if __name__ == '__main__':
    sys.exit(main())
