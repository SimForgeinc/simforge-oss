#!/usr/bin/env python3
"""FROZEN RE-GATE (W7, deterministic part). Does the published corpus survive a CORRECT gate?

The 99-archetype / DEV 0.466 result was produced by a gate whose closest-approach search carried an
unsound broad-phase cull (defect TG-G1, still present at `tools/vista/gate.py:206`): once any
clearance was recorded, later distant ticks were skipped, so a trajectory that starts far apart and
closes later keeps its t=0 value forever. That is wrong on C2 (WHEN the closest approach happens)
and C3 (HOW CLOSE it gets) simultaneously.

This re-gates every retained trace of the published corpus with the corrected implementation and
reports what changes. It needs no authoring model, so it is the part of W7 that can be run.

`verdict`/`band` for C5 come from the engine's own `uniscenarios evaluate`, not from stored fields.
Portability (>= 2 maps, >= 3 sites) is read from the corpus manifest, because only three traces per
archetype were retained; that is stated in the report rather than silently assumed away.

Usage:  regate_corpus.py [--corpus DIR] [--workers N] [--out report.json]
"""
import argparse, concurrent.futures, glob, json, math, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
EC = os.path.join(ROOT, 'research', 'edge-case-corpus')
CLI = ['node', os.path.join(ROOT, 'packages', 'cli', 'bin', 'simforge.js')]

sys.path.insert(0, HERE)
import tg_gate as G                                                        # noqa: E402


def cli_json(args, timeout=300):
    p = subprocess.run(CLI + list(args), capture_output=True, text=True, cwd=ROOT, timeout=timeout)
    out = None
    for line in p.stdout.splitlines():
        line = line.strip()
        if line.startswith('{'):
            try:
                out = json.loads(line)
            except Exception:                                              # noqa: BLE001
                pass
    return p.returncode, out


def two_proportion_p(k1, n1, k2, n2):
    """Two-sided two-proportion z-test. Same test the published gap p-values used."""
    if n1 == 0 or n2 == 0:
        return None, None
    p1, p2 = k1 / n1, k2 / n2
    p = (k1 + k2) / (n1 + n2)
    se = math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2))
    if se == 0:
        return p1 - p2, 1.0
    z = (p1 - p2) / se
    # two-sided normal tail
    return p1 - p2, math.erfc(abs(z) / math.sqrt(2))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--corpus', default=os.path.join(EC, 'gold-corpus-v3'))
    ap.add_argument('--workers', type=int, default=7)
    ap.add_argument('--out')
    a = ap.parse_args()

    manifest = json.load(open(os.path.join(a.corpus, 'MANIFEST.json')))
    entries = manifest['corpus']
    splits = manifest['splits']
    dev_ids, held_ids = set(), set()
    for tranche in splits.values():
        if isinstance(tranche, dict):
            dev_ids.update(tranche.get('DEV', []))
            held_ids.update(tranche.get('HELDOUT', []))

    jobs = []
    for aid, entry in entries.items():
        for trace in sorted(glob.glob(os.path.join(a.corpus, aid, '*.trace.json.gz'))):
            jobs.append((aid, entry, trace))

    def run(job):
        aid, entry, trace = job
        rc, ev = cli_json(['evaluate', trace])
        verdict = (ev or {}).get('verdict')
        band = (ev or {}).get('band')
        brief = '%s %s' % (aid, entry.get('category', ''))
        g = G.gate_cell(trace, verdict=verdict, band=band, brief=brief, version=2)
        return aid, entry, os.path.basename(trace), g

    per_archetype = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=a.workers) as pool:
        for aid, entry, tname, g in pool.map(run, jobs):
            r = per_archetype.setdefault(aid, {'category': entry.get('category'),
                                               'split': entry.get('split'),
                                               'manifestMaps': len(entry.get('maps') or []),
                                               'manifestSites': entry.get('sites', 0),
                                               'traces': []})
            r['traces'].append({'trace': tname, 'pass': g['pass'],
                                'first': G.first_failure(g),
                                'firstPublished': G.first_failure_published(g),
                                'clearanceM': g.get('clearanceM'), 'closestT': g.get('closestT')})

    rows = []
    for aid, r in sorted(per_archetype.items()):
        portable = r['manifestMaps'] >= G.PORT_MIN_MAPS and r['manifestSites'] >= G.PORT_MIN_SITES
        strict = any(t['pass'] for t in r['traces']) and portable
        published = any(t['firstPublished'] is None for t in r['traces']) and portable
        split = 'DEV' if aid in dev_ids else ('HELDOUT' if aid in held_ids else (r['split'] or '?'))
        rows.append({'archetype': aid, 'category': r['category'], 'split': split,
                     'maps': r['manifestMaps'], 'sites': r['manifestSites'],
                     'admittedStrict': strict, 'admittedPublishedReading': published,
                     'firstFailures': sorted({t['first'] for t in r['traces'] if t['first']})})

    def rate(sel, key):
        s = [r for r in rows if r['split'] == sel]
        k = sum(1 for r in s if r[key])
        return k, len(s)

    out = {'gate': 'frozen re-gate of the published corpus (W7, deterministic part)',
           'corpus': os.path.relpath(a.corpus, ROOT),
           'archetypes': len(rows), 'tracesEvaluated': len(jobs),
           'note': 'Only three traces per archetype were retained, so an archetype counts as '
                   'admitted when a RETAINED trace passes. Portability is read from the manifest.',
           'byReading': {}}
    for key, label in (('admittedStrict', 'corrected gate (v2 manifest reading of C2)'),
                       ('admittedPublishedReading', 'corrected gate (published closest-approach-only C2)')):
        dk, dn = rate('DEV', key)
        hk, hn = rate('HELDOUT', key)
        gap, p = two_proportion_p(dk, dn, hk, hn)
        out['byReading'][key] = {
            'label': label,
            'admitted': sum(1 for r in rows if r[key]), 'total': len(rows),
            'DEV': {'admitted': dk, 'n': dn, 'rate': round(dk / dn, 4) if dn else None},
            'HELDOUT': {'admitted': hk, 'n': hn, 'rate': round(hk / hn, 4) if hn else None},
            'generalizationGap': None if gap is None else round(gap, 4),
            'pValue': None if p is None else round(p, 4)}
    cats = {}
    for r in rows:
        c = cats.setdefault(r['category'], {'total': 0, 'admitted': 0})
        c['total'] += 1
        if r['admittedStrict']:
            c['admitted'] += 1
    out['perCategory'] = dict(sorted(cats.items()))
    out['categoriesCovered'] = sum(1 for c in cats.values() if c['admitted'] > 0)
    fails = {}
    for r in rows:
        if not r['admittedStrict']:
            for f in r['firstFailures']:
                fails[f] = fails.get(f, 0) + 1
    out['firstFailureAmongRejected'] = dict(sorted(fails.items(), key=lambda kv: -kv[1]))
    out['rows'] = rows
    print(json.dumps({k: v for k, v in out.items() if k != 'rows'}, indent=1))
    if a.out:
        json.dump(out, open(a.out, 'w'), indent=1)
    return 0


if __name__ == '__main__':
    sys.exit(main())
