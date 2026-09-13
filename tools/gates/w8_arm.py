#!/usr/bin/env python3
"""One W8 sweep arm: author the fixed 20-brief sample with VISTA_MODEL x VISTA_EFFORT.

Runs the SAME authoring pipeline as W7 -- author_llm.py, unmodified (its sha256 is recorded in
the arm report) -- varying only the model and reasoning effort through the environment overrides
vlm.py gained in W8 amendment 1. The frozen gate v2 is applied by the same unmodified tg_gate.

Measurement without modification: token usage and LLM wall time are captured by OBSERVING the
httpx responses (a wrapper around httpx.post that reads r.json()['usage'] and returns r
untouched); the request path is byte-identical to W7's.

Per the pre-registration's secondary metrics, the first 5 sample briefs (sorted by id) are
authored a SECOND time and the final template bytes compared, so authoring non-determinism at
fixed effort is measured, not assumed away.

Usage: VISTA_MODEL=m VISTA_EFFORT=e w8_arm.py --sample sample.json --out arm.json [--workers 5]
"""
import argparse, concurrent.futures, hashlib, json, os, re, sys, threading, time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(ROOT, 'research', 'edge-case-corpus', 'tools', 'vista'))

import httpx                                                               # noqa: E402
import vlm                                                                 # noqa: E402
import author_llm as AL                                                    # noqa: E402
import author_corpus as A                                                  # noqa: E402

TL = threading.local()
_orig_post = httpx.post


def _observing_post(url, **kw):
    t0 = time.monotonic()
    r = _orig_post(url, **kw)
    acc = getattr(TL, 'acc', None)
    if acc is not None:
        acc['llmCalls'] += 1
        acc['llmWallS'] += time.monotonic() - t0
        try:
            u = r.json().get('usage') or {}
        except Exception:                                                  # noqa: BLE001
            u = {}
        acc['inputTokens'] += u.get('input_tokens') or 0
        acc['outputTokens'] += u.get('output_tokens') or 0
        acc['reasoningTokens'] += ((u.get('output_tokens_details') or {})
                                   .get('reasoning_tokens')) or 0
    return r


httpx.post = _observing_post


def author_one(brief, workers_cfg):
    TL.acc = {'llmCalls': 0, 'llmWallS': 0.0, 'inputTokens': 0, 'outputTokens': 0,
              'reasoningTokens': 0}
    t0 = time.monotonic()
    try:
        row = AL.author_brief(brief, probe_draws=4, final_draws=10, max_sites=10,
                              concurrency=workers_cfg['batchConcurrency'], log_dir=None)
    except Exception as e:                                                 # noqa: BLE001
        row = {'id': brief['id'], 'category': brief['category'], 'family': None,
               'admitted': False, 'error': 'unhandled', 'detail': str(e)[:300], 'rounds': []}
    acc = TL.acc
    TL.acc = None
    row['wallS'] = round(time.monotonic() - t0, 1)
    row['usage'] = {k: (round(v, 1) if isinstance(v, float) else v) for k, v in acc.items()}
    tpl = row.get('template')
    if tpl and os.path.exists(tpl):
        row['templateSha'] = hashlib.sha256(open(tpl, 'rb').read()).hexdigest()
        row['templateBody'] = open(tpl).read()
    return row


def slim(row, keep_body=False):
    out = {k: row.get(k) for k in ('id', 'category', 'family', 'admitted', 'cells',
                                   'feasibleCells', 'passingCells', 'maps', 'sites',
                                   'firstFailure', 'refusalCodes', 'error', 'detail',
                                   'wallS', 'usage', 'templateSha', 'outdir')}
    out['rounds'] = [r.get('kind') for r in row.get('rounds', []) if isinstance(r, dict)]
    out['decisions'] = [r.get('decision') for r in row.get('rounds', [])
                        if isinstance(r, dict) and isinstance(r.get('decision'), dict)]
    if keep_body:
        out['templateBody'] = row.get('templateBody')
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--sample', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--workers', type=int, default=5)
    ap.add_argument('--batch-concurrency', type=int, default=3)
    a = ap.parse_args()

    model, effort = vlm.MODEL, vlm.EFFORT
    # Isolate this arm's temp template paths so concurrent arms cannot race on /tmp.
    # Filename-only change; the pipeline is author_llm.py, unmodified.
    AL.RUN_TAG = 'w8-%s-%s' % (re.sub(r'[^a-z0-9.-]', '-', model), effort)

    sample = json.load(open(a.sample))
    briefs, _, _ = A.load_splits()
    by_id = {b['id']: b for b in briefs}
    sel = [by_id[i] for i in sample['briefIds']]
    repeat_ids = sample['determinismRepeatIds']
    cfg = {'batchConcurrency': a.batch_concurrency}

    t0 = time.monotonic()
    with concurrent.futures.ThreadPoolExecutor(max_workers=a.workers) as pool:
        first = list(pool.map(lambda b: author_one(b, cfg), sel))
    first_by_id = {r['id']: r for r in first}

    # Determinism repeats, strictly after every first-pass template body is harvested.
    with concurrent.futures.ThreadPoolExecutor(max_workers=a.workers) as pool:
        second = list(pool.map(lambda b: author_one(b, cfg),
                               [by_id[i] for i in repeat_ids]))
    det = []
    for r2 in second:
        r1 = first_by_id.get(r2['id'], {})
        det.append({'id': r2['id'],
                    'templateIdentical': bool(r1.get('templateBody') is not None
                                              and r1.get('templateBody') == r2.get('templateBody')),
                    'admittedFirst': r1.get('admitted'), 'admittedSecond': r2.get('admitted'),
                    'shaFirst': r1.get('templateSha'), 'shaSecond': r2.get('templateSha')})

    admitted = sum(1 for r in first if r.get('admitted'))
    author_errors = sum(1 for r in first if r.get('error'))
    ff = {}
    for r in first:
        for k, v in (r.get('firstFailure') or {}).items():
            ff[k] = ff.get(k, 0) + v
    rep = {
        'model': model, 'effort': effort,
        'pipeline': {'file': 'tools/gates/author_llm.py',
                     'sha256': hashlib.sha256(
                         open(os.path.join(HERE, 'author_llm.py'), 'rb').read()).hexdigest()},
        'n': len(first), 'admitted': admitted,
        'admissionRate': round(admitted / len(first), 4) if first else 0.0,
        'authorErrorCount': author_errors,
        'firstFailureCells': ff,
        'wallS': round(time.monotonic() - t0, 1),
        'usageTotals': {k: sum(r.get('usage', {}).get(k, 0) for r in first + second)
                        for k in ('llmCalls', 'llmWallS', 'inputTokens', 'outputTokens',
                                  'reasoningTokens')},
        'determinismRepeats': det,
        'rows': [slim(r) for r in first],
        'repeatRows': [slim(r) for r in second],
    }
    json.dump(rep, open(a.out, 'w'), indent=1)
    print(json.dumps({k: rep[k] for k in ('model', 'effort', 'n', 'admitted', 'admissionRate',
                                          'authorErrorCount', 'wallS')}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
