#!/usr/bin/env python3
"""RUBRIC GATE (W4). Replay a previously-admitted corpus under the new mechanism rubrics.

W4 exit criterion, from the brief:
  * <= 20 rubric files, each pre-registered by sha256 BEFORE any solving
  * on a replay of a previously-admitted batch the new rubrics reject at least one archetype the
    old ones accepted. "If they reject nothing, they are still ceremony and you have not finished."

Both rubric sets are evaluated by the ENGINE, through `uniscenarios evaluate --rubric`, so this
compares two rubrics rather than one rubric and one reimplementation of it.

Usage:  replay_rubrics.py [--corpus DIR] [--workers N] [--out report.json]
"""
import argparse, concurrent.futures, glob, hashlib, json, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
EC = os.path.join(ROOT, 'research', 'edge-case-corpus')
CLI = ['node', os.path.join(ROOT, 'packages', 'cli', 'bin', 'simforge.js')]
NEW_DIR = os.path.join(EC, 'rubrics', 'mechanism')
OLD_DIR = os.path.join(EC, 'tools')
MAX_RUBRICS = 20


def slug(category):
    head, tail = category.split('.', 1)
    return head.lower() + '-' + ''.join(c if c.isalnum() else '-' for c in tail.lower())


def evaluate(trace, rubric):
    p = subprocess.run(CLI + ['evaluate', trace, '--rubric', rubric],
                       capture_output=True, text=True, cwd=ROOT, timeout=300)
    out = None
    for line in p.stdout.splitlines():
        line = line.strip()
        if line.startswith('{'):
            try:
                out = json.loads(line)
            except Exception:                                              # noqa: BLE001
                pass
    if out is None:
        return {'verdict': 'error', 'error': p.stderr[-200:]}
    ev = out.get('intentEvaluation') or {}
    return {'verdict': ev.get('verdict'), 'counts': ev.get('counts'),
            'failed': [c.get('id') for c in (ev.get('criteria') or [])
                       if c.get('status') == 'fail']}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--corpus', default=os.path.join(EC, 'gold-corpus-v3'))
    ap.add_argument('--workers', type=int, default=7)
    ap.add_argument('--out')
    a = ap.parse_args()

    manifest = json.load(open(os.path.join(a.corpus, 'MANIFEST.json')))
    entries = manifest['corpus']

    new_files = sorted(glob.glob(os.path.join(NEW_DIR, '*.rubric.json')))
    prereg = json.load(open(os.path.join(NEW_DIR, 'PREREGISTRATION.json')))
    drift = []
    for cat, rec in prereg['rubrics'].items():
        path = os.path.join(ROOT, rec['file'])
        got = hashlib.sha256(open(path, 'rb').read()).hexdigest()
        if got != rec['sha256']:
            drift.append({'category': cat, 'expected': rec['sha256'][:16], 'got': got[:16]})

    jobs = []
    for aid, entry in entries.items():
        cat = entry.get('category')
        new_rubric = os.path.join(NEW_DIR, '%s.rubric.json' % slug(cat))
        old_rubric = os.path.join(OLD_DIR, '%s.rubric.json' % aid)
        for trace in sorted(glob.glob(os.path.join(a.corpus, aid, '*.trace.json.gz'))):
            jobs.append((aid, cat, trace, new_rubric, old_rubric))

    results = {}

    def run(job):
        aid, cat, trace, new_rubric, old_rubric = job
        new = evaluate(trace, new_rubric) if os.path.exists(new_rubric) else {'verdict': 'missing'}
        old = evaluate(trace, old_rubric) if os.path.exists(old_rubric) else {'verdict': 'missing'}
        return aid, cat, os.path.basename(trace), new, old

    with concurrent.futures.ThreadPoolExecutor(max_workers=a.workers) as pool:
        for aid, cat, tname, new, old in pool.map(run, jobs):
            r = results.setdefault(aid, {'category': cat, 'traces': []})
            r['traces'].append({'trace': tname, 'new': new, 'old': old})

    # An archetype is ACCEPTED by a rubric set when at least one of its traces is accepted -- the
    # same "some trace satisfies it" rule the admission gate uses.
    newly_rejected, both_ok, old_rejected = [], [], []
    for aid, r in sorted(results.items()):
        n_ok = any(t['new']['verdict'] == 'accept' for t in r['traces'])
        o_ok = any(t['old']['verdict'] == 'accept' for t in r['traces'])
        if o_ok and not n_ok:
            reasons = sorted({f for t in r['traces'] for f in (t['new'].get('failed') or [])})
            newly_rejected.append({'archetype': aid, 'category': r['category'], 'failedCriteria': reasons})
        elif o_ok and n_ok:
            both_ok.append(aid)
        elif not o_ok:
            old_rejected.append(aid)

    rep = {
      'gate': 'rubric replay (W4)',
      'rubricFiles': len(new_files), 'rubricLimit': MAX_RUBRICS,
      'preRegistrationDrift': drift,
      'archetypesReplayed': len(results), 'tracesEvaluated': len(jobs),
      'acceptedByBoth': len(both_ok),
      'rejectedByOldToo': len(old_rejected),
      'newlyRejected': len(newly_rejected),
      'newlyRejectedDetail': newly_rejected,
      'pass': bool(len(new_files) <= MAX_RUBRICS and not drift and len(newly_rejected) >= 1),
    }
    print(json.dumps({k: v for k, v in rep.items() if k != 'newlyRejectedDetail'}, indent=1))
    print('\nnewly rejected (%d):' % len(newly_rejected))
    for n in newly_rejected[:40]:
        print('   %-24s %-20s %s' % (n['archetype'], n['category'], ','.join(n['failedCriteria'])))
    if a.out:
        json.dump(rep, open(a.out, 'w'), indent=1)
    print('\nRUBRIC GATE: %s' % ('PASS' if rep['pass'] else 'FAIL'))
    return 0 if rep['pass'] else 1


if __name__ == '__main__':
    sys.exit(main())
