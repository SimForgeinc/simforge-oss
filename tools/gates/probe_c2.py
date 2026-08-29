#!/usr/bin/env python3
"""C2 GATE (W1). Fixed 200-cell probe: does warm-up compensation remove the spawn-artifact loss?

W1 exit criterion, from the brief:
  * the C2 share of gate failures falls from 29.3% to < 10%
  * the realised t=0 gap correlates with the REQUESTED gap at r > 0.9

The probe is a frozen family of three challenger kinds -- a stopped obstacle, a slow cyclist and a
slower lead -- which between them span the categories that dominate the C2 loss in the 819-trace
census (C6/C14/C11/C8/C7). Each family has two arms:

  baseline  the round-6 representation: a stopped actor authored as `initialSpeedKph: 0`, and the
            requested gap written straight into `dsM`.
  fixed     W1: (a) stopped actors carry `actor.static: true`; (b) `dsM` is compensated by
            `warmupSeconds * (v_ego - v_challenger)`.

Both are authoring-side. Nothing under `packages/` is changed, and the gate is untouched.

Every metric comes from the raw trace. The realised gap is the geometric projection of
(challenger - ego) onto the ego heading unit vector at tick 0 -- lane `s` is never compared across
actors (it restarts per lane; a previous "sign bug" was retracted for exactly that reason).

Usage:  probe_c2.py [--arm baseline|fixed|both] [--cells 200] [--out report.json]
Exit 0 when the fixed arm meets BOTH exit criteria.
"""
import argparse, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import probe_lib as P                                                      # noqa: E402

PROBES = os.path.join(HERE, 'probes')
FAMILIES = ('obstacle', 'cyclist', 'lead')
TARGET_CELLS = 200
C2_SHARE_MAX = 0.10
GAP_R_MIN = 0.90


def run_arm(arm, draws, concurrency, cells_target):
    """Run every family for one arm and return a deterministic slice of cells."""
    per_family = {}
    for fam in FAMILIES:
        tpl = os.path.join(PROBES, 'c2probe-%s-%s.template.json' % (fam, arm))
        out = P.unique_outdir('c2-%s-%s' % (fam, arm))
        summ = P.run_batch(tpl, out, maps=None, draws=draws, concurrency=concurrency)
        recs = P.gate_summary(summ, brief=None, version=2, want_gap_for='chal')
        for r in recs:
            r['family'] = fam
            r['requestedGapM'] = r.get('params', {}).get('initialGapM')
        per_family[fam] = sorted(recs, key=lambda r: (str(r.get('mapId')), str(r.get('site')), r.get('draw') or 0))
        print('  %-9s %-8s %3d cells -> %s' % (arm, fam, len(recs), out))

    # Deterministic, balanced slice: round-robin the families until the target is met, so the mix
    # cannot drift with however many sites a map happens to yield.
    take, i = [], 0
    quota = cells_target // len(FAMILIES)
    for fam in FAMILIES:
        take += per_family[fam][:quota]
    i = 0
    while len(take) < cells_target and i < cells_target:
        for fam in FAMILIES:
            if len(take) >= cells_target:
                break
            rest = per_family[fam][quota:]
            if i < len(rest):
                take.append(rest[i])
        i += 1
    return take[:cells_target], per_family


def report_arm(name, cells):
    # Two censuses, deliberately. `strict` is the v2 manifest text (closest approach AND minTTC);
    # `published` is the closest-approach-only reading that produced the 29.3% baseline this exit
    # criterion is measured against. Admission always uses the strict one.
    census = P.loss_census(cells)
    pub = P.loss_census(cells, key='firstFailurePublished', passkey='passPublished')
    c2_share = pub['share'].get('C2', 0.0)
    req = [c.get('requestedGapM') for c in cells]
    got = [c.get('realisedGapT0M') for c in cells]
    r, n = P.pearson(req, got)
    errs = [abs(a - b) for a, b in zip(req, got) if a is not None and b is not None]
    errs.sort()
    out = {'arm': name, 'cells': census['cells'], 'passed': census['passed'],
           'failed': census['failed'], 'passRate': census['passRate'],
           'firstFailureCounts': census['counts'], 'firstFailureShare': census['share'],
           'published': {'passed': pub['passed'], 'passRate': pub['passRate'],
                         'firstFailureCounts': pub['counts'], 'firstFailureShare': pub['share']},
           'C2shareOfFailures': round(c2_share, 4),
           'gapCorrelationR': None if r is None else round(r, 4), 'gapPairs': n,
           'gapMedianAbsErrM': round(errs[len(errs) // 2], 3) if errs else None}
    print('\n--- %s ---' % name)
    print('  strict (v2 manifest) : passed %d/%d (%.3f) share=%s'
          % (out['passed'], out['cells'], out['passRate'], json.dumps(out['firstFailureShare'])))
    print('  published (baseline) : passed %d/%d (%.3f) share=%s'
          % (pub['passed'], out['cells'], pub['passRate'], json.dumps(pub['share'])))
    print('  C2 share of failures (published reading, vs 29.3%% baseline): %.4f' % out['C2shareOfFailures'])
    print('  requested-vs-realised gap: r=%s  n=%d  medianAbsErr=%s m'
          % (out['gapCorrelationR'], n, out['gapMedianAbsErrM']))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--arm', default='both', choices=('baseline', 'fixed', 'both'))
    ap.add_argument('--draws', type=int, default=4)
    ap.add_argument('--cells', type=int, default=TARGET_CELLS)
    ap.add_argument('--concurrency', type=int, default=7)
    ap.add_argument('--out')
    a = ap.parse_args()

    arms = ('baseline', 'fixed') if a.arm == 'both' else (a.arm,)
    results, raw = {}, {}
    for arm in arms:
        cells, _ = run_arm(arm, a.draws, a.concurrency, a.cells)
        raw[arm] = cells
        results[arm] = report_arm(arm, cells)

    rep = {'gate': 'C2 probe (W1)', 'targetCells': a.cells, 'draws': a.draws,
           'criteria': {'C2shareOfFailures': '< %.2f' % C2_SHARE_MAX,
                        'gapCorrelationR': '> %.2f' % GAP_R_MIN},
           'arms': results}
    if 'fixed' in results:
        f = results['fixed']
        rep['pass'] = bool(f['C2shareOfFailures'] < C2_SHARE_MAX
                           and f['gapCorrelationR'] is not None and f['gapCorrelationR'] > GAP_R_MIN)
    else:
        rep['pass'] = None
    if a.out:
        json.dump({'report': rep,
                   'cells': {k: [{kk: vv for kk, vv in c.items()
                                  if kk in ('family', 'mapId', 'site', 'draw', 'requestedGapM',
                                            'realisedGapT0M', 'closestT', 'minTTCt', 'clearanceM',
                                            'minTTC', 'requiredDecelMaxEgo', 'band', 'verdict',
                                            'firstFailure', 'firstFailurePublished', 'pass',
                                            'passPublished', 'maxSpeedMps', 'distanceTravelledM',
                                            'warmupSeconds')} for c in v]
                             for k, v in raw.items()}}, open(a.out, 'w'), indent=1)
        print('\nwrote %s' % a.out)
    print('\nC2 PROBE GATE: %s' % ('PASS' if rep['pass'] else ('FAIL' if rep['pass'] is False else 'N/A')))
    return 0 if rep['pass'] else 1


if __name__ == '__main__':
    sys.exit(main())
