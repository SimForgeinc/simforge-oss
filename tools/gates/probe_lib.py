"""Shared probe plumbing: run a real batch, gate every cell from its RAW trace.

Every probe in this directory goes through here so that "a cell" means exactly one thing and the
gate is applied identically everywhere. Nothing in this module reads a summary metric as evidence:
the summary supplies only `verdict`/`band` (which ARE the `evaluate` outputs C5 is defined over),
the cell coordinates, the resolved params, and the path to the trace.
"""
import json, math, os, shutil, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
CLI = ['node', os.path.join(ROOT, 'packages', 'cli', 'bin', 'simforge.js')]
MAPS = ['yale-street', 'belmont-research-center', 'el-camino-road',
        'easterbrook-discovery-school', 'richmond-field-station']

sys.path.insert(0, HERE)
import tg_gate as G                                                        # noqa: E402


def cli(*args, timeout=3600):
    """Run the CLI. Returns (returncode, last-json-line, stdout-tail, stderr-tail)."""
    p = subprocess.run(CLI + [str(a) for a in args], capture_output=True, text=True,
                       timeout=timeout, cwd=ROOT)
    out = None
    for line in p.stdout.splitlines():
        line = line.strip()
        if line.startswith('{'):
            try:
                out = json.loads(line)
            except Exception:                                              # noqa: BLE001
                pass
    return p.returncode, out, p.stdout[-3000:], p.stderr[-3000:]


def unique_outdir(tag):
    """A UNIQUE output dir per attempt. Reusing one cost this project two withdrawn archetypes."""
    d = '/tmp/tg-%s-%d' % (tag, int(time.time() * 1000))
    shutil.rmtree(d, ignore_errors=True)
    os.makedirs(d)
    return d


def run_batch(template_path, outdir, maps=None, draws=4, max_sites=None, concurrency=6,
              min_score=None, timeout=3600):
    args = ['batch', template_path, '--out', outdir, '--draws', draws, '--concurrency', concurrency]
    if maps is None:
        args.append('--all-maps')
    elif len(maps) == 1:
        args += ['--map', maps[0]]
    else:
        args += ['--maps', ','.join(maps)]
    if max_sites:
        args += ['--max-sites', max_sites]
    if min_score is not None:
        args += ['--min-score', min_score]
    rc, out, so, se = cli(*args, timeout=timeout)
    summ = os.path.join(outdir, 'batch-summary.json')
    if not os.path.exists(summ):
        raise RuntimeError('batch produced no summary (rc=%s)\nSTDERR: %s' % (rc, se[-800:]))
    return json.load(open(summ))


def forward_gap_at(trace, other, index=0):
    """Realised longitudinal gap from ego to `other`, at tick `index`.

    Geometric projection of (other - ego) onto the ego heading unit vector.
    NEVER compares lane `s`: `s` restarts per lane, and a challenger on a successor lane reads as
    "behind" when it is not. A previously-claimed sign bug was retracted for exactly this reason.
    """
    a = trace['ticks']['actors']
    if 'ego' not in a or other not in a:
        return None
    e, o = a['ego'], a[other]
    if index >= len(e['x']) or not (e['present'][index] and o['present'][index]):
        return None
    hx, hy = math.cos(e['headingRad'][index]), math.sin(e['headingRad'][index])
    return (o['x'][index] - e['x'][index]) * hx + (o['y'][index] - e['y'][index]) * hy


def gate_summary(summary, brief=None, version=2, want_gap_for=None):
    """Gate every cell of a finished batch. Returns one record per cell."""
    recs = []
    for r in summary.get('results', []):
        tf = r.get('traceFile')
        if not tf or not os.path.exists(tf):
            recs.append({'mapId': r.get('mapId'), 'site': r.get('siteId'), 'draw': r.get('drawIndex'),
                         'pass': False, 'error': 'no trace (status=%s)' % r.get('status'),
                         'firstFailure': 'NOTRACE', 'params': r.get('params', {})})
            continue
        g = G.gate_cell(tf, verdict=r.get('verdict'), band=r.get('band'), brief=brief, version=version)
        g['site'] = r.get('siteId')
        g['draw'] = r.get('drawIndex')
        g['params'] = r.get('params', {})
        g['siteScore'] = r.get('siteScore')
        g['firstFailure'] = G.first_failure(g)
        g['firstFailurePublished'] = G.first_failure_published(g)
        g['passPublished'] = g['firstFailurePublished'] is None
        if want_gap_for:
            tr = G.load_trace(tf)
            g['realisedGapT0M'] = forward_gap_at(tr, want_gap_for, 0)
        recs.append(g)
    return recs


def loss_census(recs, key='firstFailure', passkey='pass'):
    """Share of FAILING cells by the criterion each fails first -- the shape the brief reports."""
    fails = [r for r in recs if not r.get(passkey)]
    counts = {}
    for r in fails:
        k = r.get(key) or '?'
        counts[k] = counts.get(k, 0) + 1
    n = len(fails)
    return {'cells': len(recs), 'passed': len(recs) - n, 'failed': n,
            'passRate': round((len(recs) - n) / len(recs), 4) if recs else 0.0,
            'counts': dict(sorted(counts.items())),
            'share': {k: round(v / n, 4) for k, v in sorted(counts.items())} if n else {}}


def pearson(xs, ys):
    pts = [(x, y) for x, y in zip(xs, ys) if x is not None and y is not None]
    n = len(pts)
    if n < 3:
        return None, n
    mx = sum(p[0] for p in pts) / n
    my = sum(p[1] for p in pts) / n
    sxy = sum((p[0] - mx) * (p[1] - my) for p in pts)
    sxx = sum((p[0] - mx) ** 2 for p in pts)
    syy = sum((p[1] - my) ** 2 for p in pts)
    if sxx <= 0 or syy <= 0:
        return None, n
    return sxy / math.sqrt(sxx * syy), n
