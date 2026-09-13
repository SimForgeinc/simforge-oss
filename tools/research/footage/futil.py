"""Shared utilities for Stream B (FootageLane) — footage review at scale.

Contract references (research/edge-case-corpus/RETHINK-CONTRACTS.md):
  §2 cell artifact layout, §3 footage verdict schema, §6 model policy.
Prior art: tools/tg-research/instrument/ (previous lead session). Reused where sound
(vision preflight pattern, JSON parsing, broken templates, marker metrics); superseded
where the assignment or contracts changed the design (see reports PREREG-v2).

Vision discipline: every judge model must PASS tools/gates/assert_vision.py's
randomized-colour probe in THIS process before any verdict is produced. The probe
colour stays random (terra names pure red "orange"; a fixed-colour probe would
either falsely fail a seeing model or miss real blindness). A FAIL is retried with
a fresh random colour up to MAX_VISION_ATTEMPTS; a truly blind model fails every
colour, so retries never admit one. Every attempt is recorded.
"""
import base64
import gzip
import hashlib
import json
import math
import os
import random
import sys
import time

import httpx

REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..'))
GATES = os.path.join(REPO, 'tools', 'gates')
sys.path.insert(0, GATES)

BASE_URL = os.environ.get('OPENAI_BASE_URL', 'http://127.0.0.1:4141/v1').rstrip('/')
API_KEY = os.environ.get('OPENAI_API_KEY', 'x')
MODELS = ('gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra')
EFFORTS = ('low', 'medium', 'high')
MAX_VISION_ATTEMPTS = 3

STREAM = 'footage'


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def sha256_text(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def load_json(path):
    with open(path) as f:
        return json.load(f)


def load_trace(path):
    with gzip.open(path, 'rt') as f:
        return json.load(f)


def dump_json(path, obj):
    tmp = path + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(obj, f, indent=2, sort_keys=True)
        f.write('\n')
    os.replace(tmp, path)


# ---------------------------------------------------------------- vision preflight

_VISION_LOG = {}      # model -> list of attempt dicts (kept for the report)


def assert_vision_session(model):
    """Randomized-colour probe, fatal after MAX_VISION_ATTEMPTS. Cached per process."""
    if model in _VISION_LOG and _VISION_LOG[model][-1]['ok']:
        return _VISION_LOG[model]
    import assert_vision
    attempts = _VISION_LOG.setdefault(model, [])
    for i in range(MAX_VISION_ATTEMPTS):
        ok, detail = assert_vision.check(model=model)
        attempts.append({'attempt': i + 1, 'ok': bool(ok), 'detail': detail,
                         'at': time.strftime('%Y-%m-%dT%H:%M:%S')})
        if ok:
            return attempts
        time.sleep(1.0)
    raise SystemExit(f'FATAL: vision preflight failed for {model} after '
                     f'{MAX_VISION_ATTEMPTS} randomized probes: {attempts}')


def vision_log():
    return {m: list(v) for m, v in _VISION_LOG.items()}


# ---------------------------------------------------------------- gateway call

def responses_call(body, retries=4, timeout=420):
    """POST /v1/responses with backoff. Returns (parsed_response, raw_text, wall_s)."""
    last = None
    for attempt in range(retries):
        t0 = time.time()
        try:
            r = httpx.post(BASE_URL + '/responses',
                           headers={'Authorization': f'Bearer {API_KEY}'},
                           json=body, timeout=timeout)
            if r.status_code != 200:
                raise RuntimeError(f'HTTP {r.status_code}: {r.text[:300]}')
            return r.json(), r.text, time.time() - t0
        except Exception as e:                                             # noqa: BLE001
            last = e
            time.sleep(2 + 4 * attempt + random.random())
    raise RuntimeError(f'gateway call failed after {retries} tries: {last}')


def output_text(resp):
    return ' '.join(c.get('text', '')
                    for it in resp.get('output', []) for c in (it.get('content') or [])
                    if c.get('type') == 'output_text').strip()


def parse_json_block(txt):
    s = txt.strip()
    if s.startswith('```'):
        s = s.split('```')[1]
        s = s[4:] if s[:4].lower() == 'json' else s
    start = s.find('{')
    if start < 0:
        raise ValueError(f'no JSON object in reply: {txt[:160]!r}')
    depth = 0
    for i in range(start, len(s)):
        if s[i] == '{':
            depth += 1
        elif s[i] == '}':
            depth -= 1
            if depth == 0:
                return json.loads(s[start:i + 1])
    raise ValueError(f'unbalanced JSON in reply: {txt[:160]!r}')


def png_data_url(path):
    return 'data:image/png;base64,' + base64.b64encode(open(path, 'rb').read()).decode()


# ---------------------------------------------------------------- cells

def is_cell_dir(d):
    return (os.path.isfile(os.path.join(d, 'instance.json'))
            and os.path.isfile(os.path.join(d, 'trace.json.gz'))
            and os.path.isfile(os.path.join(d, 'meta.json')))


def discover_cells(root):
    """Contract-§2 cell dirs anywhere under root, sorted by cellId.
    Cells may nest (EmergentLane promoted-*/ counterparts live INSIDE their parent
    cell dir), so descent continues past a match; only render/ output is skipped."""
    out = []
    for dirpath, dirnames, _ in os.walk(root):
        if os.path.basename(dirpath) == 'render':
            dirnames[:] = []
            continue
        if is_cell_dir(dirpath):
            out.append(dirpath)
    return sorted(out, key=lambda d: load_json(os.path.join(d, 'meta.json')).get('cellId', d))


# ---------------------------------------------------------------- AUC

def auc_mannwhitney(pos, neg):
    """AUC = P(score_pos > score_neg) + 0.5 P(=). Exact rank computation, no scipy."""
    if not pos or not neg:
        return None
    ranked = sorted([(v, 1) for v in pos] + [(v, 0) for v in neg], key=lambda t: t[0])
    values = [v for v, _ in ranked]
    ranks = {}
    i = 0
    while i < len(values):
        j = i
        while j + 1 < len(values) and values[j + 1] == values[i]:
            j += 1
        for k in range(i, j + 1):
            ranks[k] = (i + j) / 2.0 + 1.0
        i = j + 1
    rank_sum_pos = sum(ranks[k] for k, (_, lab) in enumerate(ranked) if lab == 1)
    n1, n0 = len(pos), len(neg)
    u = rank_sum_pos - n1 * (n1 + 1) / 2.0
    return u / (n1 * n0)


def bootstrap_auc_ci(pos, neg, n_boot=1000, seed=20260816, alpha=0.05):
    rng = random.Random(seed)
    aucs = []
    for _ in range(n_boot):
        bp = [pos[rng.randrange(len(pos))] for _ in range(len(pos))]
        bn = [neg[rng.randrange(len(neg))] for _ in range(len(neg))]
        a = auc_mannwhitney(bp, bn)
        if a is not None:
            aucs.append(a)
    aucs.sort()
    lo = aucs[int(math.floor(alpha / 2 * len(aucs)))]
    hi = aucs[min(len(aucs) - 1, int(math.ceil((1 - alpha / 2) * len(aucs))) - 1)]
    return lo, hi


def summarize_scores(vals):
    if not vals:
        return None
    s = sorted(vals)
    n = len(s)
    return {'n': n, 'mean': round(sum(s) / n, 3), 'min': s[0], 'max': s[-1],
            'p25': s[n // 4], 'median': s[n // 2], 'p75': s[(3 * n) // 4]}
