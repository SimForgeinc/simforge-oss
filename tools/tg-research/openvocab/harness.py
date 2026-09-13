#!/usr/bin/env python3
"""Stream A open-vocabulary authoring surface: the model writes the FULL ScenarioTemplateV2.

Frozen per-brief protocol (counters are the algorithm; zero per-brief tuning):

  author                         -> one JSON {ambient, ambientSettleS, structureNote, template}
  validate loop                  -> `template validate` errors + lane-contract violations fed
                                    back verbatim; <= MAX_VALIDATE_REPAIRS repair calls total
  site loop                      -> `sites match` per ready map; when 0 sites everywhere the
                                    per-map failureSummary goes back; <= MAX_SITE_REPAIRS calls
  probe batch  (PROBE_DRAWS)     -> frozen-gate census per criterion + solver refusal codes +
                                    raw-trace facts of sample cells fed back
  revise loop                    -> <= MAX_REVISES calls, each followed by a fresh probe when
                                    budget remains
  final batch  (FINAL_DRAWS)     -> gate + portability decide admission, exactly as W7 did

The gate is the frozen physical gate v2 applied to RAW traces by tg_gate, unchanged.
Admission/reporting conventions are copied from tools/gates/author_llm.py so the report is
directly comparable to the W7 (0.6986 DEV) and M8 (0.7534 DEV) baselines and consumable by
tools/gates/judge_blind.py.

The lane contract forbids scene_absolute roles, anchor pins and map-bound routes; those are
rejected at the validate step (the schema allows them; this lane does not).

Usage:
  harness.py --run-id dev1 --split DEV [--model gpt-5.6-sol --effort medium]
             [--workers 3 --batch-concurrency 2] [--only a,b | --limit N]
             [--out report.json]
"""
import argparse, concurrent.futures, json, os, re, subprocess, sys, threading, time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
GATES = os.path.join(ROOT, 'tools', 'gates')
EC = os.path.join(ROOT, 'research', 'edge-case-corpus')
sys.path.insert(0, HERE)
sys.path.insert(0, GATES)
import llm                                                                  # noqa: E402
import tg_gate as G                                                         # noqa: E402
import probe_lib as P                                                       # noqa: E402

RUN_TAG = 'openvocab'
ALL_MAPS = ['yale-street', 'belmont-research-center', 'el-camino-road',
            'easterbrook-discovery-school', 'richmond-field-station']
AMBIENT_PRESETS = ('off', 'light', 'moderate', 'city', 'heavy')

# Frozen protocol constants.
MAX_VALIDATE_REPAIRS = 2
MAX_SITE_REPAIRS = 2
MAX_REVISES = 2
PROBE_DRAWS, PROBE_MAX_SITES = 4, 4
FINAL_DRAWS, FINAL_MAX_SITES = 10, 6      # final = M8 deterministic baseline's convention
# Ambient resource policy (measured 2026-08-15: uncapped 'moderate' = 20 actors,
# ~43 s/cell; capped 8 actors / 200 m = ~8.5 s/cell at concurrency 2). Presets stay the
# model's choice; the cap is a stream-level CPU policy, reported in PREREG.
AMBIENT_MAX_ACTORS, AMBIENT_RADIUS_M = 8, 200

VOCAB = open(os.path.join(HERE, 'VOCAB.md')).read()
GOLD1 = open(os.path.join(ROOT, 'examples', 'school-dartout.template.json')).read()
GOLD2 = open(os.path.join(ROOT, 'examples', 'mechanisms', 'corridor',
                          'lead-hard-brake.template.json')).read()

PREAMBLE = """%s

## GOLD EXAMPLE 1 (shape reference ONLY — a rich occlusion/VRU template; never copy its
content into an unrelated brief):

```json
%s
```

## GOLD EXAMPLE 2 (shape reference ONLY — a minimal corridor template showing the
late-response idiom):

```json
%s
```
""" % (VOCAB, GOLD1, GOLD2)

AUTHOR_PROMPT = PREAMBLE + """
## YOUR BRIEF

Category: %s
Brief: "%s"

Author this brief as a complete ScenarioTemplateV2. Express the named mechanism itself.
Return exactly ONE JSON object of the output contract ({ambient, ambientSettleS,
structureNote, template}), no prose outside it."""

REPAIR_PROMPT = PREAMBLE + """
## YOUR BRIEF

Category: %s
Brief: "%s"

## YOUR PREVIOUS ANSWER (being repaired)

```json
%s
```

## VALIDATION ERRORS (verbatim)

%s

Fix every error. Return the FULL corrected JSON object of the output contract, no prose."""

SITE_PROMPT = PREAMBLE + """
## YOUR BRIEF

Category: %s
Brief: "%s"

## YOUR PREVIOUS ANSWER (valid, but its anchor matched ZERO sites on every map)

```json
%s
```

## MATCHER FAILURE, PER MAP (verbatim)

%s

Relax or rethink the anchor (see MAP FACTS): demote non-load-bearing clauses to
"preferred", widen ranges, or re-express the structure the mechanism actually needs.
Keep the mechanism. Return the FULL corrected JSON object, no prose."""

REVISE_PROMPT = PREAMBLE + """
## YOUR BRIEF

Category: %s
Brief: "%s"

## YOUR PREVIOUS ANSWER (valid, sites matched, but the probe batch did not admit it)

```json
%s
```

## MEASURED ENGINE FEEDBACK (probe batch, frozen gate on raw traces)

%s

Revise the template to fix the dominant failure while keeping the brief's mechanism.
Return the FULL corrected JSON object, no prose."""


# ------------------------------------------------------------------ lane contract
def contract_violations(t):
    """The lane's own rules, checked before the engine sees the template."""
    v = []
    roles = t.get('roles') or []
    ids = [r.get('id') for r in roles if isinstance(r, dict)]
    for r in roles:
        if isinstance(r, dict) and r.get('kind') == 'scene_absolute':
            v.append('role "%s": scene_absolute is FORBIDDEN in this lane; use a portable '
                     'binding (on_reference/relative_to/conflicting_gate/...)' % r.get('id'))
    if (t.get('anchor') or {}).get('pin'):
        v.append('anchor.pin is FORBIDDEN in this lane; the anchor must be a portable predicate')
    for i in ((t.get('choreography') or {}).get('interactions') or []):
        tgt = i.get('target') if isinstance(i, dict) else None
        mode = (tgt or {}).get('mode') if isinstance(tgt, dict) else None
        if mode in ('customRoute', 'lanePath'):
            v.append('interaction "%s": route mode %s is map-bound and FORBIDDEN; use '
                     'turn/crossing/polyline/acquire/nearMiss' % (i.get('id'), mode))
    if 'ego' not in ids:
        v.append('no role with id "ego": the metric subject must be a role literally named "ego"')
    if t.get('metricSubject') not in (None, 'ego'):
        v.append('metricSubject must be "ego"')
    return v


def normalise_answer(d):
    """The model's wrapper -> (ambient, settleS, structureNote, template). Lenient on the
    wrapper (a missing field has a defined default), strict on the template itself."""
    if not isinstance(d, dict):
        raise ValueError('answer is not a JSON object')
    t = d.get('template')
    if not isinstance(t, dict):
        raise ValueError('answer has no "template" object')
    amb = d.get('ambient')
    amb = amb if amb in AMBIENT_PRESETS else 'off'
    try:
        settle = max(0.0, min(300.0, float(d.get('ambientSettleS') or 0)))
    except (TypeError, ValueError):
        settle = 0.0
    note = d.get('structureNote')
    note = str(note)[:400] if note else None
    if 'metricSubject' not in t:
        t['metricSubject'] = 'ego'
    meta = t.setdefault('meta', {})
    meta.setdefault('name', 'untitled')
    meta.setdefault('createdAt', '2026-08-15T00:00:00.000Z')
    meta.setdefault('modifiedAt', '2026-08-15T00:00:00.000Z')
    meta.setdefault('author', 'agent/openvocab')
    meta.setdefault('appVersion', 'uniscenarios/0.0.1')
    return amb, settle, note, t


# ------------------------------------------------------------------ engine plumbing
def validate_template(t, path):
    json.dump(t, open(path, 'w'), indent=1)
    rc, out, so, se = P.cli('template', 'validate', path)
    issues = [i for i in ((out or {}).get('issues') or []) if i.get('severity') == 'error']
    lines = ['%s [%s]: %s' % (i.get('path'), i.get('code'), str(i.get('message'))[:220])
             for i in issues[:14]]
    lines += ['LANE CONTRACT: ' + c for c in contract_violations(t)]
    return lines


def match_sites(path, maps):
    """Per-map `sites match`. Returns (totalSites, mapsWithSites, perMapFailure)."""
    total, with_sites, failures = 0, [], {}
    for m in maps:
        rc, out, so, se = P.cli('sites', 'match', path, '--map', m, timeout=600)
        rep = ((out or {}).get('maps') or [{}])[0]
        n = len(rep.get('sites') or [])
        total += n
        if n:
            with_sites.append(m)
        else:
            failures[m] = str(rep.get('failureSummary') or (out or {}).get('reason')
                              or 'no site matched')[:400]
    return total, with_sites, failures


def run_batch(path, outdir, maps, draws, max_sites, concurrency, ambient, settle):
    os.makedirs(outdir)
    args = ['batch', path, '--out', outdir, '--draws', draws, '--concurrency', concurrency,
            '--maps', ','.join(maps), '--max-sites', max_sites]
    if ambient != 'off':
        args += ['--ambient', ambient, '--ambient-max-actors', AMBIENT_MAX_ACTORS,
                 '--ambient-radius-m', AMBIENT_RADIUS_M]
        if settle:
            args += ['--ambient-settle', settle]
    rc, out, so, se = P.cli(*args, timeout=3400)
    summ = os.path.join(outdir, 'batch-summary.json')
    if not os.path.exists(summ):
        raise RuntimeError('batch produced no summary (rc=%s) %s' % (rc, se[-500:]))
    return json.load(open(summ))


def run_and_gate(brief, path, outdir, maps, draws, max_sites, concurrency, ambient, settle):
    """Batch + frozen gate + portability. Row conventions copied from author_llm.py."""
    try:
        summary = run_batch(path, outdir, maps, draws, max_sites, concurrency, ambient, settle)
    except Exception as e:                                                 # noqa: BLE001
        return {'id': brief['id'], 'category': brief['category'],
                'admitted': False, 'error': 'batch_failed', 'detail': str(e)[:300],
                'outdir': outdir}
    recs = P.gate_summary(summary, brief=brief['brief'], version=2)
    refusals = {}
    for r in summary.get('results', []):
        tf = r.get('traceFile')
        if not tf or not os.path.exists(tf):
            code = (r.get('error') or {}).get('code') or r.get('status') or 'unknown'
            refusals[code] = refusals.get(code, 0) + 1
    feasible = [r for r in recs if r.get('firstFailure') != 'NOTRACE']
    port = G.portability(feasible)
    census = P.loss_census(feasible) if feasible else {'counts': {}, 'passed': 0}
    admitted = bool(census['passed'] > 0 and port['ok'])
    return {'id': brief['id'], 'category': brief['category'],
            'cells': len(recs), 'feasibleCells': len(feasible),
            'passingCells': census['passed'], 'maps': port['nMaps'], 'sites': port['nSites'],
            'admitted': admitted, 'firstFailure': census['counts'],
            'refusalCodes': refusals, 'outdir': outdir, 'template': path,
            '_recs': recs}


def cell_fact_line(r):
    tnf = r.get('triggerNeverFired') or []
    return ('map=%s site=%s draw=%s firstFailure=%s | clearance=%.2fm@t=%s minTTC=%s@t=%s '
            'reqDecel=%.2f collisions=%s verdict=%s band=%s%s' % (
                r.get('mapId'), str(r.get('site'))[:8], r.get('draw'),
                r.get('firstFailure') or 'PASS',
                r.get('clearanceM') if r.get('clearanceM') is not None else float('nan'),
                r.get('closestT'), r.get('minTTC'), r.get('minTTCt'),
                r.get('requiredDecelMaxEgo') or 0.0, r.get('collisions'),
                r.get('verdict'), r.get('band'),
                (' triggerNeverFired=%s' % ','.join(map(str, tnf))) if tnf else ''))


def feedback_text(probe):
    """Everything the model gets to see about a probe: census, refusals, raw-trace samples."""
    lines = []
    if probe.get('error'):
        lines.append('HARD ERROR: %s %s' % (probe['error'], probe.get('detail', '')))
    lines.append('Cells: %d simulated, %d feasible, %d gate-passing; portability %d maps / '
                 '%d sites (need >=2 maps and >=3 sites among PASSING cells).'
                 % (probe.get('cells', 0), probe.get('feasibleCells', 0),
                    probe.get('passingCells', 0), probe.get('maps', 0), probe.get('sites', 0)))
    ff = probe.get('firstFailure') or {}
    if ff:
        lines.append('First-failure census over failing cells: %s' % json.dumps(ff))
    rc = probe.get('refusalCodes') or {}
    if rc:
        lines.append('Engine refusals (no trace produced): %s — these cells never simulated; '
                     'change placement/anchor so the solver can place the scene.'
                     % json.dumps(rc))
    advice = {
        'C1': 'C1 fails: the ego never really drives — raise its initialSpeedKph / runway.',
        'C2': 'C2 fails: closest approach or minTTC lands before warmup+0.5s — the conflict '
              'is front-loaded; widen the initial separation or delay the threat.',
        'C3': 'C3 fails: clearance never gets within 5 m — the encounter misses; tighten the '
              'geometry or the arrival relation.',
        'C4': 'C4 fails: no braking demand (reqDecel < 1.5 and minTTC > 3) — the ego is never '
              'genuinely surprised; make the response later or the threat sharper.',
        'C5': 'C5 fails: evaluator rejected (collision, non-critical band, or a trigger that '
              'never fired) — check triggerNeverFired below and keep minTTC <= 3 s contact-free.',
        'C6': 'C6 fails: occlusion not proven — the declared occluder must actually hide the '
              'target from the ego and reveal it before the conflict.',
    }
    for k in ('C1', 'C2', 'C3', 'C4', 'C5', 'C6'):
        if ff.get(k):
            lines.append(advice[k])
    recs = probe.get('_recs') or []
    fails, seen = [], set()
    for r in recs:
        f = r.get('firstFailure')
        if f and f != 'NOTRACE' and f not in seen:
            seen.add(f)
            fails.append(r)
    passing = [r for r in recs if r.get('pass')]
    if fails:
        lines.append('Sample FAILING cells (raw-trace facts):')
        lines += ['  - ' + cell_fact_line(r) for r in fails[:4]]
    if passing:
        lines.append('Sample PASSING cell: ' + cell_fact_line(passing[0]))
    if probe.get('maps', 0) < 2 or probe.get('sites', 0) < 3:
        lines.append('Portability is short: passing cells must span >=2 maps and >=3 sites — '
                     'loosen anchor clauses that exclude maps, or fix the failure that kills '
                     'whole maps.')
    return '\n'.join('- ' + ln for ln in lines)


# ------------------------------------------------------------------ per-brief loop
_print_lock = threading.Lock()


class Author:
    def __init__(self, run_dir, model, effort, maps, concurrency):
        self.run_dir, self.model, self.effort = run_dir, model, effort
        self.maps, self.concurrency = maps, concurrency
        self.llm_dir = os.path.join(run_dir, 'llm')
        os.makedirs(self.llm_dir, exist_ok=True)

    def call(self, brief, prompt, tag, usage_acc):
        d, usage = llm.ask_json(prompt, self.model, self.effort, log_dir=self.llm_dir,
                                tag='%s-%s' % (brief['id'], tag))
        for k in ('input_tokens', 'output_tokens', 'total_tokens'):
            if isinstance(usage.get(k), (int, float)):
                usage_acc[k] = usage_acc.get(k, 0) + usage[k]
        usage_acc['calls'] = usage_acc.get('calls', 0) + 1
        return d

    def author_brief(self, brief):
        t0 = time.time()
        bid = re.sub(r'[^A-Za-z0-9_-]', '-', brief['id'])
        bdir = os.path.join(self.run_dir, bid)
        os.makedirs(bdir, exist_ok=True)
        usage = {}
        trail = {'id': brief['id'], 'category': brief['category'], 'family': None,
                 'rounds': []}
        repairs = sites_r = revises = 0
        schema_error_rounds = 0

        def emit(kind, prompt, tag):
            raw = self.call(brief, prompt, tag, usage)
            amb, settle, note, t = normalise_answer(raw)
            path = os.path.join(bdir, '%s.template.json' % tag)
            errors = validate_template(t, path)
            trail['rounds'].append({'kind': kind, 'ambient': amb, 'ambientSettleS': settle,
                                    'structureNote': note, 'template': path,
                                    'validationErrors': len(errors)})
            return {'ambient': amb, 'settle': settle, 'note': note, 'template': t,
                    'path': path, 'errors': errors}

        def fail(err, detail):
            return {**trail, 'admitted': False, 'error': err, 'detail': detail,
                    'usage': usage, 'wallS': round(time.time() - t0, 1),
                    'validateRepairs': repairs, 'siteRepairs': sites_r, 'revises': revises,
                    'schemaErrorRounds': schema_error_rounds}

        # ---- author + validate loop
        try:
            cur = emit('author', AUTHOR_PROMPT % (brief['category'], brief['brief']), 'r0')
        except Exception as e:                                             # noqa: BLE001
            return fail('author_call_failed', str(e)[:300])
        while cur['errors'] and repairs < MAX_VALIDATE_REPAIRS:
            repairs += 1
            schema_error_rounds += 1
            try:
                cur = emit('repair', REPAIR_PROMPT % (
                    brief['category'], brief['brief'],
                    json.dumps({'ambient': cur['ambient'], 'structureNote': cur['note'],
                                'template': cur['template']}, indent=1),
                    '\n'.join('- ' + e for e in cur['errors'])), 'r0v%d' % repairs)
            except Exception as e:                                         # noqa: BLE001
                return fail('repair_call_failed', str(e)[:300])
        if cur['errors']:
            schema_error_rounds += 1
            return fail('template_invalid', cur['errors'][:8])

        # ---- site loop
        total, with_sites, failures = match_sites(cur['path'], self.maps)
        trail['rounds'][-1]['sitesMatched'] = total
        while total == 0 and sites_r < MAX_SITE_REPAIRS:
            sites_r += 1
            try:
                nxt = emit('site_repair', SITE_PROMPT % (
                    brief['category'], brief['brief'],
                    json.dumps({'ambient': cur['ambient'], 'structureNote': cur['note'],
                                'template': cur['template']}, indent=1),
                    '\n'.join('- %s: %s' % kv for kv in sorted(failures.items()))),
                    'r0s%d' % sites_r)
            except Exception as e:                                         # noqa: BLE001
                return fail('site_repair_call_failed', str(e)[:300])
            if nxt['errors'] and repairs < MAX_VALIDATE_REPAIRS:
                repairs += 1
                schema_error_rounds += 1
                try:
                    nxt = emit('repair', REPAIR_PROMPT % (
                        brief['category'], brief['brief'],
                        json.dumps({'ambient': nxt['ambient'], 'structureNote': nxt['note'],
                                    'template': nxt['template']}, indent=1),
                        '\n'.join('- ' + e for e in nxt['errors'])), 'r0s%dv' % sites_r)
                except Exception as e:                                     # noqa: BLE001
                    return fail('repair_call_failed', str(e)[:300])
            if nxt['errors']:
                schema_error_rounds += 1
                break
            cur = nxt
            total, with_sites, failures = match_sites(cur['path'], self.maps)
            trail['rounds'][-1]['sitesMatched'] = total
        if total == 0:
            return fail('no_sites', dict(list(failures.items())[:5]))

        # ---- probe + revise loop
        probe = run_and_gate(brief, cur['path'],
                             os.path.join(bdir, 'probe-%d' % int(time.time() * 1000)),
                             self.maps, PROBE_DRAWS, PROBE_MAX_SITES, self.concurrency,
                             cur['ambient'], cur['settle'])
        trail['rounds'].append({'kind': 'probe', 'result': {
            k: probe.get(k) for k in ('admitted', 'cells', 'feasibleCells', 'passingCells',
                                      'maps', 'sites', 'firstFailure', 'refusalCodes',
                                      'error')}})
        while not probe.get('admitted') and revises < MAX_REVISES:
            revises += 1
            try:
                nxt = emit('revise', REVISE_PROMPT % (
                    brief['category'], brief['brief'],
                    json.dumps({'ambient': cur['ambient'], 'structureNote': cur['note'],
                                'template': cur['template']}, indent=1),
                    feedback_text(probe)), 'r%d' % revises)
            except Exception as e:                                         # noqa: BLE001
                trail['rounds'].append({'kind': 'revise_failed', 'detail': str(e)[:200]})
                break
            if nxt['errors'] and repairs < MAX_VALIDATE_REPAIRS:
                repairs += 1
                schema_error_rounds += 1
                try:
                    nxt = emit('repair', REPAIR_PROMPT % (
                        brief['category'], brief['brief'],
                        json.dumps({'ambient': nxt['ambient'], 'structureNote': nxt['note'],
                                    'template': nxt['template']}, indent=1),
                        '\n'.join('- ' + e for e in nxt['errors'])), 'r%dv' % revises)
                except Exception as e:                                     # noqa: BLE001
                    trail['rounds'].append({'kind': 'revise_failed', 'detail': str(e)[:200]})
                    break
            if nxt['errors']:
                schema_error_rounds += 1
                trail['rounds'].append({'kind': 'revise_invalid',
                                        'detail': nxt['errors'][:4]})
                break
            n_total, n_with, n_fail = match_sites(nxt['path'], self.maps)
            if n_total == 0:
                trail['rounds'].append({'kind': 'revise_no_sites',
                                        'detail': dict(list(n_fail.items())[:3])})
                break
            cur = nxt
            if revises >= MAX_REVISES:
                break
            probe = run_and_gate(brief, cur['path'],
                                 os.path.join(bdir, 'probe-%d' % int(time.time() * 1000)),
                                 self.maps, PROBE_DRAWS, PROBE_MAX_SITES, self.concurrency,
                                 cur['ambient'], cur['settle'])
            trail['rounds'].append({'kind': 'probe', 'result': {
                k: probe.get(k) for k in ('admitted', 'cells', 'feasibleCells',
                                          'passingCells', 'maps', 'sites', 'firstFailure',
                                          'refusalCodes', 'error')}})

        # ---- final measured batch
        final = run_and_gate(brief, cur['path'],
                             os.path.join(bdir, 'final-%d' % int(time.time() * 1000)),
                             self.maps, FINAL_DRAWS, FINAL_MAX_SITES, self.concurrency,
                             cur['ambient'], cur['settle'])
        final.pop('_recs', None)
        row = {**trail, **final,
               'ambient': cur['ambient'], 'ambientSettleS': cur['settle'],
               'structureNote': cur['note'], 'usage': usage,
               'wallS': round(time.time() - t0, 1),
               'validateRepairs': repairs, 'siteRepairs': sites_r, 'revises': revises,
               'schemaErrorRounds': schema_error_rounds}
        return row


# ------------------------------------------------------------------ run orchestration
def load_splits():
    corpus = json.load(open(os.path.join(EC, 'agent-authoring', 'brief-corpus-full.json')))
    dev, held = set(), set()
    for key in ('tranche1Split', 'tranche2Split'):
        blk = corpus.get(key) or {}
        dev |= set(blk.get('DEV') or [])
        held |= set(blk.get('HELDOUT') or [])
    return corpus['briefs'], dev, held


def gate_tripwire():
    p = subprocess.run([os.path.join(ROOT, '.venv', 'bin', 'python'),
                        os.path.join(GATES, 'verify_gate_hash.py')],
                       capture_output=True, text=True, cwd=ROOT, timeout=120)
    last = (p.stdout.strip().splitlines() or ['?'])[-1]
    return p.returncode == 0 and 'PASS' in last, last


def ready_maps():
    ready = []
    probe = os.path.join(ROOT, 'examples', 'mechanisms', 'corridor',
                         'lead-hard-brake.template.json')
    for m in ALL_MAPS:
        rc, out, so, se = P.cli('sites', 'match', probe, '--map', m, timeout=600)
        if rc == 0 and out and out.get('maps'):
            ready.append(m)
    return ready


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--run-id', required=True)
    ap.add_argument('--split', default='DEV', choices=('DEV', 'HELDOUT', 'ALL'))
    ap.add_argument('--model', default='gpt-5.6-sol')
    ap.add_argument('--effort', default='medium')
    ap.add_argument('--workers', type=int, default=3)
    ap.add_argument('--batch-concurrency', type=int, default=2)
    ap.add_argument('--only')
    ap.add_argument('--limit', type=int)
    ap.add_argument('--min-maps', type=int, default=2)
    ap.add_argument('--out')
    a = ap.parse_args()

    run_dir = '/tmp/tgr-openvocab-%s' % a.run_id
    if os.path.exists(run_dir):
        print('FATAL: run dir %s already exists; run ids are never reused' % run_dir)
        return 2
    os.makedirs(run_dir)

    ok, hash_before = gate_tripwire()
    print('gate tripwire (before): %s' % hash_before)
    if not ok:
        print('FATAL: gate hash tripwire failed before the run')
        return 2

    maps = ready_maps()
    print('ready maps: %s' % ','.join(maps))
    if len(maps) < a.min_maps:
        print('FATAL: only %d ready maps (< %d); refusing a measured run' % (len(maps),
                                                                             a.min_maps))
        return 2

    briefs, dev, held = load_splits()
    if a.split == 'DEV':
        sel = [b for b in briefs if b['id'] in dev]
    elif a.split == 'HELDOUT':
        sel = [b for b in briefs if b['id'] in held]
    else:
        sel = briefs
    if a.only:
        want = set(a.only.split(','))
        sel = [b for b in sel if b['id'] in want]
    if a.limit:
        sel = sel[:a.limit]

    author = Author(run_dir, a.model, a.effort, maps, a.batch_concurrency)
    print('openvocab authoring: %d briefs (%s), model %s effort %s, maps=%d, '
          'probe=%d final=%d' % (len(sel), a.split, a.model, a.effort, len(maps),
                                 PROBE_DRAWS, FINAL_DRAWS))

    def run(b):
        try:
            r = author.author_brief(b)
        except Exception as e:                                             # noqa: BLE001
            r = {'id': b['id'], 'category': b['category'], 'family': None,
                 'admitted': False, 'error': 'unhandled', 'detail': str(e)[:300],
                 'rounds': []}
        with _print_lock:
            print('  %-4s %-24s cells=%3d pass=%3d maps=%d sites=%d amb=%-8s rounds=%d %s'
                  % ('ADM' if r.get('admitted') else '----', r['id'],
                     r.get('feasibleCells', 0) or 0, r.get('passingCells', 0) or 0,
                     r.get('maps', 0) or 0, r.get('sites', 0) or 0,
                     r.get('ambient', '?'), len(r.get('rounds', [])), r.get('error', '')),
                  flush=True)
        json.dump(r, open(os.path.join(run_dir, 'row-%s.json' % r['id']), 'w'), indent=1)
        return r

    with concurrent.futures.ThreadPoolExecutor(max_workers=a.workers) as pool:
        rows = list(pool.map(run, sel))

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

    rep = {'gate': 'openvocab full-schema authoring (%s, effort %s)' % (a.model, a.effort),
           'split': a.split, 'model': a.model, 'effort': a.effort,
           'endpoint': os.environ.get('OPENAI_BASE_URL', ''),
           'runId': a.run_id, 'runDir': run_dir, 'mapsUsed': maps,
           'gateHashBefore': hash_before, 'gateHashAfter': hash_after,
           'briefs': len(rows), 'admitted': admitted,
           'admissionRate': round(admitted / len(rows), 4) if rows else 0.0,
           'probeDraws': PROBE_DRAWS, 'draws': FINAL_DRAWS, 'maxSites': FINAL_MAX_SITES,
           'perCategory': dict(sorted(by_cat.items())),
           'categoriesCovered': sum(1 for c in by_cat.values() if c['admitted'] > 0),
           'firstFailureAcrossRejected': dict(sorted(fails.items(), key=lambda kv: -kv[1])),
           'rows': rows}
    print(json.dumps({k: v for k, v in rep.items() if k != 'rows'}, indent=1))

    # Cross-stream index: briefId -> cell dirs + gate row.
    index = {'stream': 'openvocab', 'runId': a.run_id, 'briefs': {}}
    for r in rows:
        cells = []
        summ = os.path.join(r.get('outdir') or '', 'batch-summary.json')
        if r.get('outdir') and os.path.exists(summ):
            s = json.load(open(summ))
            cells = sorted({os.path.dirname(x['traceFile'])
                            for x in s.get('results', []) if x.get('traceFile')})
        index['briefs'][r['id']] = {'admitted': bool(r.get('admitted')),
                                    'outdir': r.get('outdir'), 'cellDirs': cells,
                                    'template': r.get('template')}
    json.dump(index, open(os.path.join(run_dir, 'index.json'), 'w'), indent=1)

    out = a.out or os.path.join(run_dir, 'report.json')
    json.dump(rep, open(out, 'w'), indent=1)
    print('wrote %s' % out)
    return 0


if __name__ == '__main__':
    sys.exit(main())
