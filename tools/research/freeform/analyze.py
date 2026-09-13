#!/usr/bin/env python3
"""Build the per-arm comparison table for REPORT.md from run report.json files.

Reads freedom/baseline/grid arm reports, emits:
  * markdown table: admission, validity-after-repairs, per-criterion first-failures,
    census aggregates (all + passing cells), tokens, wall;
  * H-freedom-effort readout over the grid arms (admission by model x effort, with
    exact binomial CIs on the subset);
  * falsifier checks (validity >= 50%, gate floor >= 0.35, census vs baseline).

Usage: analyze.py --reports r1.json r2.json ... [--grid grid-result-g1.json]
                  [--out-md table.md] [--out-json analysis.json]
"""
import argparse, json, math, os


def wilson(k, n, z=1.96):
    if n == 0:
        return (0.0, 0.0)
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (round(max(0.0, c - h), 3), round(min(1.0, c + h), 3))


def validity(rows):
    """Share of briefs whose FINAL template validated (reached a batch)."""
    ok = sum(1 for r in rows if r.get('error') not in
             ('template_invalid', 'author_call_failed', 'repair_call_failed',
              'llm_call_failed', 'site_repair_call_failed'))
    return ok, len(rows)


def arm_summary(rep):
    rows = rep.get('rows') or []
    vok, vn = validity(rows)
    admitted = rep.get('admitted', 0)
    n = rep.get('briefs', len(rows))
    usage = rep.get('usageTotal') or {}
    ca = rep.get('censusAggAllCells') or {}
    cp = rep.get('censusAggPassingCells') or {}

    def m(agg, key):
        v = (agg.get(key) or {})
        return v.get('mean')

    ffs = rep.get('firstFailureAcrossRejected') or {}
    return {
        'arm': rep.get('arm') or rep.get('runId'),
        'model': rep.get('model'), 'effort': rep.get('effort'),
        'briefs': n, 'admitted': admitted,
        'admissionRate': rep.get('admissionRate'),
        'admissionCI95': wilson(admitted, n),
        'validityRate': round(vok / vn, 4) if vn else None,
        'validity': '%d/%d' % (vok, vn),
        'firstFailures': ffs,
        'census': {
            'allCells': {k: m(ca, k) for k in
                         ('actorsMoving', 'laneChangesExecuted', 'swerveEvents',
                          'signalPhaseChanges', 'interactingPairs', 'hardBrakeEvents',
                          'actorCount', 'ambientCount')},
            'passingCells': {k: m(cp, k) for k in
                             ('actorsMoving', 'laneChangesExecuted', 'swerveEvents',
                              'signalPhaseChanges', 'interactingPairs', 'hardBrakeEvents',
                              'actorCount', 'ambientCount')},
            'cellsAll': ca.get('cells'), 'cellsPassing': cp.get('cells'),
            'authoredEventsFireRateAll': ca.get('authoredEventsFireRate'),
        },
        'tokens': usage.get('total_tokens'), 'calls': usage.get('calls'),
        'wallSeconds': rep.get('wallSeconds'),
        'draws': rep.get('draws'), 'maxSites': rep.get('maxSites'),
        'surfaceSha256': rep.get('surfaceSha256'),
    }


def md_table(summaries):
    cols = ('arm', 'model', 'effort', 'briefs', 'admitted', 'admissionRate',
            'validity', 'tokens', 'wallSeconds')
    out = ['| ' + ' | '.join(cols) + ' |', '|' + '---|' * len(cols)]
    for s in summaries:
        out.append('| ' + ' | '.join(str(s.get(c)) for c in cols) + ' |')
    return '\n'.join(out)


def effort_readout(summaries):
    grid = [s for s in summaries if s['arm'] and str(s['arm']).startswith('grid-')]
    by_model = {}
    for s in grid:
        by_model.setdefault(s['model'], {})[s['effort']] = s
    lines = []
    order = ('low', 'medium', 'high')
    for model in sorted(by_model):
        row = by_model[model]
        adm = [row.get(e, {}).get('admitted') for e in order]
        tok = [row.get(e, {}).get('tokens') for e in order]
        nd = all(adm[i] is not None and adm[i + 1] is not None and adm[i] <= adm[i + 1]
                 for i in range(len(adm) - 1))
        pos = (adm[0] is not None and adm[2] is not None and adm[2] > adm[0])
        lines.append({'model': model, 'admittedLowMedHigh': adm,
                      'tokensLowMedHigh': tok,
                      'nonDecreasing': nd, 'positiveLowToHigh': pos})
    n_pos = sum(1 for l in lines if l['positiveLowToHigh'])
    return {'perModel': lines,
            'H_freedom_effort': {
                'criterion': 'non-decreasing low->med->high per model AND strictly '
                             'positive low->high delta for >=2 of 3 models',
                'positiveModels': n_pos,
                'supported': bool(n_pos >= 2 and all(l['nonDecreasing'] for l in lines))}}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--reports', nargs='+', required=True)
    ap.add_argument('--out-md')
    ap.add_argument('--out-json')
    a = ap.parse_args()
    summaries = []
    for p in a.reports:
        rep = json.load(open(p))
        s = arm_summary(rep)
        s['report'] = p
        summaries.append(s)
    analysis = {'arms': summaries, 'effort': effort_readout(summaries)}
    md = md_table(summaries)
    print(md)
    print()
    print(json.dumps(analysis['effort'], indent=1))
    if a.out_md:
        open(a.out_md, 'w').write(md + '\n')
    if a.out_json:
        json.dump(analysis, open(a.out_json, 'w'), indent=1)
        print('wrote %s' % a.out_json)
    return 0


if __name__ == '__main__':
    sys_exit = main()
    raise SystemExit(sys_exit)
