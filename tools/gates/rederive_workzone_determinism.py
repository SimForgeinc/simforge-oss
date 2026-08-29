#!/usr/bin/env python3
"""INDEPENDENT re-derivation of the a2138927 determinism claim.

Claim under test: the work-zone family is deterministic; the 3/18 verify_replay result was an
artifact of comparing traceBytes on cells the solver REFUSED (no trace in either run).

This script deliberately does NOT import tools/gates/verify_replay.py. It:
  1. builds the workzone template for a real C8 brief through the frozen authoring surface
     (import only; the frozen file is not modified),
  2. runs the identical batch TWICE into two fresh /tmp dirs via the CLI directly,
  3. compares, per cell, the ENTIRE result record minus volatile fields (paths, timings),
     which is STRICTER than status+error-code: if refusals differ in any payload detail,
     this comparison fails where the relaxed gate would pass,
  4. for cells with traces in both runs: sha256 of the DECOMPRESSED bytes must match,
  5. any cell with a trace in one run but not the other is an immediate failure.
"""
import gzip, hashlib, json, os, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
WT = os.path.abspath(os.path.join(HERE, '..', '..'))
sys.path.insert(0, HERE)
import author_corpus as A                                                  # noqa: E402

CLI = ['node', os.path.join(WT, 'packages', 'cli', 'bin', 'simforge.js')]
VOLATILE = {'traceFile', 'instanceFile', 'evidenceDir', 'outDir', 'durationMs', 'wallMs',
            'startedAt', 'finishedAt', 'timestamp', 'elapsedMs'}


def strip_volatile(rec):
    return {k: v for k, v in sorted(rec.items()) if k not in VOLATILE}


def run_once(template_path, outdir, draws, max_sites):
    args = CLI + ['batch', template_path, '--out', outdir, '--draws', str(draws),
                  '--concurrency', '4', '--max-sites', str(max_sites), '--all-maps']
    p = subprocess.run(args, capture_output=True, text=True, timeout=1800, cwd=WT)
    summ = os.path.join(outdir, 'batch-summary.json')
    if not os.path.exists(summ):
        print('FATAL: no summary; rc=%d stderr=%s' % (p.returncode, p.stderr[-500:]))
        sys.exit(2)
    return json.load(open(summ))


def trace_sha(path):
    with gzip.open(path) as f:
        return hashlib.sha256(f.read()).hexdigest()


def main():
    briefs, dev, held = A.load_splits()
    c8 = [b for b in briefs if b['category'] == 'C8.workzone']
    brief = c8[0]
    print('brief: %s (%s)' % (brief['id'], brief['category']))
    template = A.build_template(brief)
    tpath = '/tmp/tg-rederive/workzone-%s.template.json' % brief['id']
    json.dump(template, open(tpath, 'w'), indent=1)

    stamp = int(time.time() * 1000)
    summaries = []
    for i in (1, 2):
        d = '/tmp/tg-rederive/run%d-%d' % (i, stamp)
        os.makedirs(d)
        s = run_once(tpath, d, draws=3, max_sites=4)
        print('run %d: %d results -> %s' % (i, len(s.get('results', [])), d))
        summaries.append(s)

    idx = [{'%s/%s/%s' % (r['mapId'], r['siteId'], r['drawIndex']): r
            for r in s.get('results', [])} for s in summaries]
    keys = sorted(set(idx[0]) | set(idx[1]))
    asym_cells = [k for k in keys if k not in idx[0] or k not in idx[1]]

    n_trace_pairs = n_trace_identical = 0
    n_refusal_pairs = n_refusal_identical = 0
    failures = []
    refusal_codes = {}
    for k in sorted(set(idx[0]) & set(idx[1])):
        a, b = idx[0][k], idx[1][k]
        ta, tb = a.get('traceFile'), b.get('traceFile')
        ha, hb = bool(ta and os.path.exists(ta)), bool(tb and os.path.exists(tb))
        if ha != hb:
            failures.append({'cell': k, 'why': 'trace in one run only', 'a': ha, 'b': hb})
            continue
        rec_match = strip_volatile(a) == strip_volatile(b)
        if ha:  # both produced a trace
            n_trace_pairs += 1
            bytes_match = trace_sha(ta) == trace_sha(tb)
            if rec_match and bytes_match:
                n_trace_identical += 1
            else:
                failures.append({'cell': k, 'why': 'trace pair differs',
                                 'recordMatch': rec_match, 'bytesMatch': bytes_match})
        else:   # both refused
            n_refusal_pairs += 1
            code = (a.get('error') or {}).get('code') or a.get('status')
            refusal_codes[code] = refusal_codes.get(code, 0) + 1
            if rec_match:
                n_refusal_identical += 1
            else:
                da = strip_volatile(a); db = strip_volatile(b)
                diff_keys = [kk for kk in set(da) | set(db) if da.get(kk) != db.get(kk)]
                failures.append({'cell': k, 'why': 'refusal records differ',
                                 'differingFields': diff_keys})

    verdict = (not asym_cells and not failures
               and n_trace_identical == n_trace_pairs
               and n_refusal_identical == n_refusal_pairs)
    rep = {
        'derivation': 'independent (does not import verify_replay.py)',
        'comparison': 'full result record minus volatile fields; decompressed trace bytes',
        'brief': brief['id'], 'template': tpath, 'draws': 3, 'maxSites': 4,
        'cells': len(keys), 'asymmetricCells': asym_cells,
        'tracePairs': n_trace_pairs, 'tracePairsBitIdentical': n_trace_identical,
        'refusalPairs': n_refusal_pairs, 'refusalPairsFullyIdentical': n_refusal_identical,
        'refusalCodes': refusal_codes,
        'failures': failures,
        'verdict': 'DETERMINISTIC' if verdict else 'NOT DETERMINISTIC',
    }
    print(json.dumps(rep, indent=1))
    out = os.path.join(WT, 'research/edge-case-corpus/reports/training-grade',
                       'W7-determinism-rederived.json')
    json.dump(rep, open(out, 'w'), indent=1)
    print('wrote', out)
    return 0 if verdict else 1


if __name__ == '__main__':
    sys.exit(main())
