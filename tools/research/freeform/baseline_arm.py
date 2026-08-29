#!/usr/bin/env python3
"""Baseline arm: the FROZEN W7 compiler pipeline (tools/gates/author_llm.py, unmodified)
run over the frozen rethink brief sample, its outputs adapted to the rethink cell
artifact contract.

author_llm.py is imported as a library and driven brief-by-brief through its own frozen
`author_brief` protocol (author -> repair -> probe draws=4 -> revise -> final draws=10
max-sites=10). NOTHING in that module is modified. Two seams are patched from outside,
neither of which changes behaviour the pipeline can observe:

  * probe_lib.unique_outdir is redirected into this run's own directory, so every batch
    the pipeline produces lands under /tmp/tgr-freeform-<runid>/ and can be extracted
    (gate rows re-derived from raw traces, dynamism census, cell artifacts) and deleted;
  * vlm.ask is replaced with a byte-equivalent /v1/responses client that also RECORDS
    token usage (the original discards the usage block), so the baseline arm's cost is
    measurable. Model/effort stay vlm.MODEL/vlm.EFFORT (VISTA_MODEL/VISTA_EFFORT env;
    default = the published W7 config gpt-5.6-luna/medium).

Usage:
  baseline_arm.py --run-id base1 [--sample all] [--workers 6 --batch-concurrency 1]
                  [--only a,b | --limit N] [--out report.json]
"""
import argparse, concurrent.futures, json, os, re, shutil, subprocess, sys
import threading, time

import httpx

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
GATES = os.path.join(ROOT, 'tools', 'gates')
SHARED = os.path.join(ROOT, 'tools', 'research', 'shared')
EC = os.path.join(ROOT, 'research', 'edge-case-corpus')
sys.path.insert(0, GATES)
sys.path.insert(0, SHARED)
sys.path.insert(0, HERE)
import tg_gate as G                                                         # noqa: E402
import probe_lib as P                                                       # noqa: E402
import dynamism_census as DC                                                # noqa: E402
# Import OUR harness before the vista path joins sys.path: a different, older
# `harness.py` lives in research/edge-case-corpus/tools/vista/.
from harness import (census_rows, export_cells, gate_tripwire, load_sample,  # noqa: E402
                     sha256_file, surface_sha)
sys.path.insert(0, os.path.join(EC, 'tools', 'vista'))
import vlm                                                                  # noqa: E402
import author_llm as AL                                                     # noqa: E402

ARM = 'baseline'
_tls = threading.local()


# --------------------------------------------------------- usage-recording vlm.ask
def _recording_ask(prompt, images=None, max_tokens=12000, retries=4, timeout=300):
    """Byte-equivalent replacement for vlm.ask that records token usage per thread."""
    key = os.environ['OPENAI_API_KEY']
    url = os.environ.get('OPENAI_BASE_URL', 'https://api.openai.com/v1').rstrip('/') \
        + '/responses'
    content = [{'type': 'input_text', 'text': prompt}]
    assert not images, 'baseline authoring path never sends images'
    body = {'model': vlm.MODEL, 'reasoning': {'effort': vlm.EFFORT},
            'max_output_tokens': max_tokens,
            'input': [{'role': 'user', 'content': content}]}
    last = None
    for i in range(retries):
        try:
            r = httpx.post(url, headers={'Authorization': f'Bearer {key}'}, json=body,
                           timeout=timeout)
            if r.status_code != 200:
                last = f'HTTP {r.status_code}: {r.text[:300]}'
                time.sleep(2 + 4 * i)
                continue
            d = r.json()
            out = []
            for item in d.get('output', []):
                for c in item.get('content', []) or []:
                    if c.get('type') == 'output_text':
                        out.append(c['text'])
            txt = '\n'.join(out).strip()
            usage = d.get('usage') or {}
            acc = getattr(_tls, 'usage', None)
            if acc is not None:
                for k in ('input_tokens', 'output_tokens', 'total_tokens'):
                    if isinstance(usage.get(k), (int, float)):
                        acc[k] = acc.get(k, 0) + usage[k]
                acc['calls'] = acc.get('calls', 0) + 1
            if txt:
                return txt
            last = f"empty output (status={d.get('status')})"
        except Exception as e:                                             # noqa: BLE001
            last = f'{type(e).__name__}: {e}'
        time.sleep(2 + 4 * i)
    raise RuntimeError(f'model call failed after {retries} tries: {last}')


def _patched_outdir_factory(run_dir):
    def unique_outdir(tag):
        d = os.path.join(run_dir, 'batches', '%s-%d' % (tag, int(time.time() * 1000)))
        shutil.rmtree(d, ignore_errors=True)
        os.makedirs(d)
        dirs = getattr(_tls, 'outdirs', None)
        if dirs is not None:
            dirs.append(d)
        return d
    return unique_outdir


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--run-id', required=True)
    ap.add_argument('--sample', default='all', choices=('dev', 'owner', 'all'))
    ap.add_argument('--workers', type=int, default=6)
    ap.add_argument('--batch-concurrency', type=int, default=1)
    ap.add_argument('--only')
    ap.add_argument('--limit', type=int)
    ap.add_argument('--keep-batches', action='store_true')
    ap.add_argument('--out')
    a = ap.parse_args()

    run_dir = '/tmp/tgr-freeform-%s' % a.run_id
    if os.path.exists(run_dir):
        print('FATAL: run dir %s already exists; run ids are never reused' % run_dir)
        return 2
    os.makedirs(os.path.join(run_dir, 'batches'))
    os.makedirs(os.path.join(run_dir, 'cells'))
    os.makedirs(os.path.join(run_dir, 'logs'))

    ok, hash_before = gate_tripwire()
    print('gate tripwire (before): %s' % hash_before)
    if not ok:
        print('FATAL: gate hash tripwire failed before the run')
        return 2

    # Outside patches (author_llm itself untouched).
    vlm.ask = _recording_ask
    P.unique_outdir = _patched_outdir_factory(run_dir)

    sel, _ = load_sample(a.sample)
    if a.only:
        want = set(a.only.split(','))
        sel = [b for b in sel if b['id'] in want]
    if a.limit:
        sel = sel[:a.limit]

    print('baseline (W7 compiler pipeline, frozen): %d briefs, model %s effort %s'
          % (len(sel), vlm.MODEL, vlm.EFFORT))
    cells_root = os.path.join(run_dir, 'cells')
    lock = threading.Lock()

    def run(b):
        _tls.usage, _tls.outdirs = {}, []
        t0 = time.time()
        try:
            row = AL.author_brief(b, probe_draws=4, final_draws=10, max_sites=10,
                                  concurrency=a.batch_concurrency,
                                  log_dir=os.path.join(run_dir, 'logs'))
        except Exception as e:                                             # noqa: BLE001
            row = {'id': b['id'], 'category': b['category'], 'family': None,
                   'admitted': False, 'error': 'unhandled', 'detail': str(e)[:300],
                   'rounds': []}
        row['usage'] = dict(_tls.usage)
        row['wallS'] = round(time.time() - t0, 1)

        # Extract from the final batch: re-gated rows, census, cell artifacts.
        outdir = row.get('outdir')
        summ = os.path.join(outdir, 'batch-summary.json') if outdir else None
        if summ and os.path.exists(summ):
            summary = json.load(open(summ))
            recs = P.gate_summary(summary, brief=b['brief'], version=2)
            crows = census_rows(recs)
            bdir = os.path.join(run_dir, re.sub(r'[^A-Za-z0-9_-]', '-', b['id']))
            os.makedirs(bdir, exist_ok=True)
            json.dump(crows, open(os.path.join(bdir, 'census-rows.json'), 'w'), indent=1)
            tpath = row.get('template')
            tsha = sha256_file(tpath) if tpath and os.path.exists(tpath) else None
            row['templateSha256'] = tsha
            row['cellsExported'] = export_cells(
                cells_root, a.run_id, ARM, b, tpath, tsha, recs, keep=6)
            feas = [c for c in crows if 'error' not in c]
            row['censusAggAll'] = DC.aggregate(feas)
            row['censusAggPassing'] = DC.aggregate([c for c in feas if c.get('pass')])
        if not a.keep_batches:
            for d in _tls.outdirs:
                shutil.rmtree(d, ignore_errors=True)
        with lock:
            print('  %-4s %-46s fam=%-18s cells=%3d pass=%3d maps=%d sites=%d %s'
                  % ('ADM' if row.get('admitted') else '----', row['id'],
                     str(row.get('family')), row.get('feasibleCells', 0) or 0,
                     row.get('passingCells', 0) or 0, row.get('maps', 0) or 0,
                     row.get('sites', 0) or 0, row.get('error', '')), flush=True)
        json.dump(row, open(os.path.join(run_dir, 'row-%s.json' % row['id']), 'w'),
                  indent=1)
        return row

    t_run0 = time.time()
    with concurrent.futures.ThreadPoolExecutor(max_workers=a.workers) as pool:
        rows = list(pool.map(run, sel))
    wall = round(time.time() - t_run0, 1)

    ok, hash_after = gate_tripwire()
    print('gate tripwire (after): %s' % hash_after)

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
    usage = {}
    for r in rows:
        for k, v in (r.get('usage') or {}).items():
            usage[k] = usage.get(k, 0) + v
    all_rows, pass_rows = [], []
    for r in rows:
        p = os.path.join(run_dir, re.sub(r'[^A-Za-z0-9_-]', '-', r['id']),
                         'census-rows.json')
        if os.path.exists(p):
            cr = [c for c in json.load(open(p)) if 'error' not in c]
            all_rows += cr
            pass_rows += [c for c in cr if c.get('pass')]

    rep = {'gate': 'baseline W7 compiler pipeline (frozen author_llm.py, %s effort %s)'
                   % (vlm.MODEL, vlm.EFFORT),
           'stream': 'freeform', 'arm': ARM, 'runId': a.run_id, 'runDir': run_dir,
           'model': vlm.MODEL, 'effort': vlm.EFFORT,
           'endpoint': os.environ.get('OPENAI_BASE_URL', ''),
           'surfaceSha256': surface_sha(),
           'authorLlmSha256': sha256_file(os.path.join(GATES, 'author_llm.py')),
           'gateHashBefore': hash_before, 'gateHashAfter': hash_after,
           'briefs': len(rows), 'admitted': admitted,
           'admissionRate': round(admitted / len(rows), 4) if rows else 0.0,
           'probeDraws': 4, 'draws': 10, 'maxSites': 10,
           'perCategory': dict(sorted(by_cat.items())),
           'categoriesCovered': sum(1 for c in by_cat.values() if c['admitted'] > 0),
           'firstFailureAcrossRejected': dict(sorted(fails.items(), key=lambda kv: -kv[1])),
           'usageTotal': usage, 'wallSeconds': wall,
           'censusAggAllCells': DC.aggregate(all_rows),
           'censusAggPassingCells': DC.aggregate(pass_rows),
           'cellsRoot': cells_root,
           'rows': rows}
    print(json.dumps({k: v for k, v in rep.items() if k != 'rows'}, indent=1))
    out = a.out or os.path.join(run_dir, 'report.json')
    json.dump(rep, open(out, 'w'), indent=1)
    print('wrote %s' % out)
    return 0


if __name__ == '__main__':
    sys.exit(main())
