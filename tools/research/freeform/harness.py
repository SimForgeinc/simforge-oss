#!/usr/bin/env python3
"""Stream A (FreeformLane) freedom-arm authoring harness: the model writes the FULL
ScenarioTemplateV2, RETHINK-PLAN.md section 3A.

Adopted from tools/tg-research/openvocab/harness.py (prior lead session) and adapted to
the rethink contracts; the per-brief loop, lane contract and engine plumbing are its
design. Differences, all contract-driven:

  * briefs come from the frozen tools/research/shared/briefs-sample.json (or --pilot);
  * repair budgets: schema repairs <=3, site repairs <=2, gate-feedback revises <=3
    (RETHINK-PLAN 3A "2-3 repair rounds" = full validate->sites->probe->revise cycles);
  * final batch matches the W7 baseline convention exactly (draws=10, max-sites=10);
  * every feasible final cell gets a dynamism census row (shared frozen instrument);
  * up to KEEP_CELLS cells per brief are exported to the rethink cell-artifact contract
    (instance.json + trace.json.gz + meta.json) for FootageLane; bulky batch dirs are
    deleted after extraction;
  * model/effort are per-run arguments (the model/effort grid is pre-registered in
    reports/rethink/freeform/REPORT.md).

Per-brief protocol (frozen before the measured runs; zero per-brief tuning):
  author -> [repair loop: validate errors | zero sites | probe gate census, budget 3]
         -> final batch draws=10 max-sites=10 -> frozen gate + portability -> cells+census

Usage:
  harness.py --run-id pilot1 --pilot [--model gpt-5.6-luna --effort medium]
  harness.py --run-id main1 --sample all --model <winner> --effort <winner>
             [--workers 6 --batch-concurrency 1] [--only a,b | --limit N] [--out r.json]
"""
import argparse, concurrent.futures, json, hashlib, os, re, shutil, subprocess, sys
import threading, time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
GATES = os.path.join(ROOT, 'tools', 'gates')
SHARED = os.path.join(ROOT, 'tools', 'research', 'shared')
sys.path.insert(0, HERE)
sys.path.insert(0, GATES)
sys.path.insert(0, SHARED)
import llm                                                                  # noqa: E402
import tg_gate as G                                                         # noqa: E402
import probe_lib as P                                                       # noqa: E402
import dynamism_census as DC                                                # noqa: E402

STREAM = 'freeform'
ALL_MAPS = ['yale-street', 'belmont-research-center', 'el-camino-road',
            'easterbrook-discovery-school', 'richmond-field-station']
AMBIENT_PRESETS = ('off', 'light', 'moderate', 'city', 'heavy')
PILOT_IDS = ('c3-ltap-ld', 'c2-weave', 'c5-bus-stop-emergence', 'c13b-preemption',
             'c9b-spill')

# Frozen protocol constants.
# Repair budgets (pilot1 finding: a unified 3-call budget was consumed by schema
# wrestling before any engine feedback — c13b/c5 got 0 gate-revise rounds. "3 repair
# rounds" = 3 full validate->sites->probe->census->revise cycles; schema/site repairs
# are sub-steps with their own pools.)
MAX_VALIDATE_REPAIRS = 3                  # schema-error fixes, total per brief
MAX_SITE_REPAIRS = 2                      # zero-sites anchor rethinks, total per brief
MAX_REVISES = 3                           # gate-feedback revision cycles
PROBE_DRAWS, PROBE_MAX_SITES = 4, 2       # per-map site cap (pilot: 4/map = 80-cell probes)
FINAL_DRAWS, FINAL_MAX_SITES = 10, 10     # = author_llm.py defaults (W7 baseline arm)
KEEP_CELLS = 6                            # exported cell artifacts per brief
# Ambient CPU policy (prior session, measured: uncapped 'moderate' = 20 actors,
# ~43 s/cell; capped 8 actors / 200 m = ~8.5 s/cell). Presets stay the model's choice.
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
    """The model's wrapper -> (ambient, settleS, structureNote, template)."""
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
    meta.setdefault('createdAt', '2026-08-16T00:00:00.000Z')
    meta.setdefault('modifiedAt', '2026-08-16T00:00:00.000Z')
    meta.setdefault('author', 'agent/freeform')
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
    rc, out, so, se = P.cli(*args, timeout=7200)
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
    return ('map=%s site=%s draw=%s firstFailure=%s | egoVmax=%.1fm/s egoDist=%.0fm | '
            'clearance=%.2fm@t=%s with=%s | minTTC=%s@t=%s reqDecel=%.2f collisions=%s '
            'verdict=%s band=%s%s' % (
                r.get('mapId'), str(r.get('site'))[:8], r.get('draw'),
                r.get('firstFailure') or 'PASS',
                r.get('maxSpeedMps') or 0.0, r.get('distanceTravelledM') or 0.0,
                r.get('clearanceM') if r.get('clearanceM') is not None else float('nan'),
                r.get('closestT'), r.get('closestWith'), r.get('minTTC'), r.get('minTTCt'),
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
        hints = {
            'arrival_unconverged': 'arrival_unconverged: the arrival solver could not '
                'back-solve the start for the declared ttc/deltaT — lower the approach '
                'speed, add requiredUpstreamRunwayM to the role, widen the ttc, or use a '
                '`when` trigger instead.',
            'signal_unbindable': 'signal_unbindable: that site\'s junction exposes no '
                'controllable signal for the approach — require control:["signalized"] '
                'on the junction feature so only signalized sites match.',
            'spawn_overlap': 'spawn_overlap: two actors/props materialise on top of each '
                'other — separate poses (dsM/laneOffset) or drop a repeat row.',
            'unknown_site': 'unknown_site: the matcher offered a site the solver cannot '
                'place — tighten the anchor (runway/lane clauses) so unusable sites stop '
                'matching.',
        }
        for code in rc:
            for k, h in hints.items():
                if k in str(code):
                    lines.append(h)
    advice = {
        'C1': 'C1 fails: the ego never really drives (needs max speed >=2 m/s AND >=10 m '
              'travelled — see egoVmax/egoDist below). Common causes: ambient traffic '
              'queued ahead of the ego (ambient is PHYSICALLY real; use off/light or start '
              'the ego upstream of it), the ego sitting at a red signal it obeys (give its '
              'approach green until the conflict), or a low initialSpeedKph.',
        'C2': 'C2 fails: closest approach or minTTC lands before warmup+0.5s — the conflict '
              'is front-loaded (check clearance@t and with= below: if t=0, that actor '
              'SPAWNS too close — start challengers >15-20 m away and bring them in with '
              'the timeline/arrival solver).',
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


# ------------------------------------------------------------------ cell artifacts
def sha256_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def _link_or_copy(src, dst):
    try:
        os.link(src, dst)
    except OSError:
        shutil.copyfile(src, dst)


def select_keep(recs, keep):
    """Up to `keep` cells: half passing, half gate-failed (map-diverse round-robin).

    Lead directive 2026-08-16 (after the authoring-surface freeze; this touches cell
    ARTIFACT SELECTION only, never the authoring protocol): the footage judge must see
    gate-failed freedom cells too, to separate alive-but-inadmissible from
    dead-and-inadmissible. Shortfall on either side is filled from the other.
    """
    def rrobin(pool):
        by_map = {}
        for r in pool:
            by_map.setdefault(r.get('mapId'), []).append(r)
        out, more = [], True
        while more:
            more = False
            for m in sorted(by_map):
                if by_map[m]:
                    out.append(by_map[m].pop(0))
                    more = True
        return out
    passing = rrobin([r for r in recs if r.get('pass')])
    failing = rrobin([r for r in recs if not r.get('pass')
                      and r.get('firstFailure') != 'NOTRACE'])
    half = (keep + 1) // 2
    take_pass = min(len(passing), max(half, keep - len(failing)))
    return (passing[:take_pass] + failing[:keep - take_pass])[:keep]


def export_cells(cells_root, runid, arm, brief, template_path, template_sha, recs, keep):
    """Write the rethink cell-artifact contract for up to `keep` cells."""
    exported = []
    for r in select_keep(recs, keep):
        tf = r.get('trace')
        if not tf or not os.path.exists(tf):
            continue
        inst = tf.replace('.trace.json.gz', '.instance.json')
        cell_id = '%s-%s-%s-%s-%s-%03d' % (STREAM, runid, brief['id'], r.get('mapId'),
                                           r.get('site'), r.get('draw') or 0)
        cdir = os.path.join(cells_root, cell_id)
        os.makedirs(cdir, exist_ok=True)
        _link_or_copy(tf, os.path.join(cdir, 'trace.json.gz'))
        if os.path.exists(inst):
            _link_or_copy(inst, os.path.join(cdir, 'instance.json'))
        meta = {'cellId': cell_id, 'briefId': brief['id'], 'stream': STREAM, 'arm': arm,
                'templateSha256': template_sha, 'map': r.get('mapId'), 'site': r.get('site'),
                'draw': r.get('draw'), 'seed': r.get('seed'),
                'gate': {'pass': bool(r.get('pass')),
                         'firstFailure': r.get('firstFailure'),
                         'clearanceM': r.get('clearanceM'),
                         'tMinClearance': r.get('closestT')},
                'notes': 'brief: %s' % brief['brief'][:200]}
        json.dump(meta, open(os.path.join(cdir, 'meta.json'), 'w'), indent=1)
        exported.append(cell_id)
    return exported


def census_rows(recs):
    """Dynamism census for every feasible cell (raw trace + paired instance)."""
    rows = []
    for r in recs:
        tf = r.get('trace')
        if not tf or not os.path.exists(tf):
            continue
        try:
            row = DC.census_path(tf)
        except Exception as e:                                             # noqa: BLE001
            row = {'error': str(e)[:200], 'trace': tf}
        row.update({'mapId': r.get('mapId'), 'site': r.get('site'), 'draw': r.get('draw'),
                    'pass': bool(r.get('pass')), 'firstFailure': r.get('firstFailure')})
        rows.append(row)
    return rows


# ------------------------------------------------------------------ per-brief loop
_print_lock = threading.Lock()


class Author:
    def __init__(self, run_dir, runid, arm, model, effort, maps, concurrency,
                 keep_batches=False, final_draws=FINAL_DRAWS,
                 final_max_sites=FINAL_MAX_SITES):
        self.run_dir, self.runid, self.arm = run_dir, runid, arm
        self.model, self.effort = model, effort
        self.final_draws, self.final_max_sites = final_draws, final_max_sites
        self.maps, self.concurrency = maps, concurrency
        self.keep_batches = keep_batches
        self.llm_dir = os.path.join(run_dir, 'llm')
        self.cells_root = os.path.join(run_dir, 'cells')
        os.makedirs(self.llm_dir, exist_ok=True)
        os.makedirs(self.cells_root, exist_ok=True)

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
        trail = {'id': brief['id'], 'category': brief['category'], 'rounds': []}
        pools = {'validate': 0, 'site': 0, 'revise': 0}
        schema_error_rounds = 0
        seq = [0]

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

        def tag(kind):
            seq[0] += 1
            return '%s%d' % (kind, seq[0])

        def fail(err, detail):
            return {**trail, 'admitted': False, 'error': err, 'detail': detail,
                    'usage': usage, 'wallS': round(time.time() - t0, 1),
                    'repairPools': dict(pools), 'schemaErrorRounds': schema_error_rounds}

        # ---- author
        try:
            cur = emit('author', AUTHOR_PROMPT % (brief['category'], brief['brief']), 'r0')
        except Exception as e:                                             # noqa: BLE001
            return fail('author_call_failed', str(e)[:300])

        def ensure_valid(cur):
            """Schema-repair sub-loop drawing on the validate pool."""
            nonlocal schema_error_rounds
            while cur['errors'] and pools['validate'] < MAX_VALIDATE_REPAIRS:
                pools['validate'] += 1
                schema_error_rounds += 1
                cur = emit('repair', REPAIR_PROMPT % (
                    brief['category'], brief['brief'],
                    json.dumps({'ambient': cur['ambient'], 'structureNote': cur['note'],
                                'template': cur['template']}, indent=1),
                    '\n'.join('- ' + e for e in cur['errors'])), tag('v'))
            if cur['errors']:
                schema_error_rounds += 1
            return cur

        # ---- validate -> sites -> probe/revise cycles
        probe, last_good, dead = None, None, None
        try:
            cur = ensure_valid(cur)
            while True:
                if cur['errors']:
                    dead = ('template_invalid', cur['errors'][:8])
                    break

                total, with_sites, failures = match_sites(cur['path'], self.maps)
                trail['rounds'][-1]['sitesMatched'] = total
                if total == 0:
                    if pools['site'] >= MAX_SITE_REPAIRS:
                        dead = ('no_sites', dict(list(failures.items())[:5]))
                        break
                    pools['site'] += 1
                    cur = ensure_valid(emit('site_repair', SITE_PROMPT % (
                        brief['category'], brief['brief'],
                        json.dumps({'ambient': cur['ambient'], 'structureNote': cur['note'],
                                    'template': cur['template']}, indent=1),
                        '\n'.join('- %s: %s' % kv for kv in sorted(failures.items()))),
                        tag('s')))
                    continue

                last_good = dict(cur)             # validates AND matches >=1 site
                probe_dir = os.path.join(bdir, 'probe-%d' % int(time.time() * 1000))
                probe = run_and_gate(brief, cur['path'], probe_dir, self.maps, PROBE_DRAWS,
                                     PROBE_MAX_SITES, self.concurrency,
                                     cur['ambient'], cur['settle'])
                trail['rounds'].append({'kind': 'probe', 'result': {
                    k: probe.get(k) for k in ('admitted', 'cells', 'feasibleCells',
                                              'passingCells', 'maps', 'sites',
                                              'firstFailure', 'refusalCodes', 'error')}})
                fb = feedback_text(probe)
                if not self.keep_batches:
                    shutil.rmtree(probe_dir, ignore_errors=True)
                if probe.get('admitted') or pools['revise'] >= MAX_REVISES:
                    break
                pools['revise'] += 1
                cur = ensure_valid(emit('revise', REVISE_PROMPT % (
                    brief['category'], brief['brief'],
                    json.dumps({'ambient': cur['ambient'], 'structureNote': cur['note'],
                                'template': cur['template']}, indent=1), fb), tag('r')))
        except Exception as e:                                             # noqa: BLE001
            if last_good is None:
                return fail('llm_call_failed', str(e)[:300])
            trail['rounds'].append({'kind': 'llm_call_failed', 'detail': str(e)[:200]})
            cur, dead = last_good, None

        # A repair/revise that broke validation or lost every site at budget exhaustion:
        # fall back to the last template that validated and matched sites (recorded).
        if dead is not None or cur['errors']:
            if last_good is None:
                return fail(*(dead or ('template_invalid', cur['errors'][:8])))
            cur = last_good
            trail['rounds'].append({'kind': 'fallback_to_last_valid',
                                    'template': cur['path'],
                                    'reason': (dead or ('template_invalid',))[0]})

        # ---- final measured batch (W7 convention)
        final_dir = os.path.join(bdir, 'final-%d' % int(time.time() * 1000))
        final = run_and_gate(brief, cur['path'], final_dir, self.maps, self.final_draws,
                             self.final_max_sites, self.concurrency,
                             cur['ambient'], cur['settle'])
        recs = final.pop('_recs', []) or []

        # census on every feasible final cell, cell artifacts, then delete the batch dir
        crows = census_rows(recs)
        json.dump(crows, open(os.path.join(bdir, 'census-rows.json'), 'w'), indent=1)
        tsha = sha256_file(cur['path']) if os.path.exists(cur['path']) else None
        exported = export_cells(self.cells_root, self.runid, self.arm, brief, cur['path'],
                                tsha, recs, KEEP_CELLS)
        for cid in exported:
            rows_for = [c for c in crows if c.get('trace') and cid.endswith(
                '%s-%s-%03d' % (c.get('mapId'), c.get('site'), c.get('draw') or 0))]
            if rows_for:
                json.dump(rows_for[0], open(os.path.join(self.cells_root, cid,
                                                         'census.json'), 'w'), indent=1)
        if not self.keep_batches:
            shutil.rmtree(final_dir, ignore_errors=True)

        feas = [c for c in crows if 'error' not in c]
        row = {**trail, **final,
               'ambient': cur['ambient'], 'ambientSettleS': cur['settle'],
               'structureNote': cur['note'], 'templateSha256': tsha,
               'usage': usage, 'wallS': round(time.time() - t0, 1),
               'repairPools': dict(pools), 'schemaErrorRounds': schema_error_rounds,
               'cellsExported': exported,
               'censusAggAll': DC.aggregate(feas),
               'censusAggPassing': DC.aggregate([c for c in feas if c.get('pass')])}
        json.dump(row, open(os.path.join(self.run_dir, 'row-%s.json' % brief['id']), 'w'),
                  indent=1)
        return row


# ------------------------------------------------------------------ run orchestration
def load_sample(which):
    s = json.load(open(os.path.join(SHARED, 'briefs-sample.json')))
    briefs = []
    if which in ('dev', 'all'):
        briefs += s['dev']
    if which in ('owner', 'all'):
        briefs += s['owner']
    return briefs, s


def load_pilot():
    corpus = json.load(open(os.path.join(ROOT, 'research', 'edge-case-corpus',
                                         'agent-authoring', 'brief-corpus-full.json')))
    return [b for b in corpus['briefs'] if b['id'] in PILOT_IDS]


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


def surface_sha():
    """sha256 of the frozen authoring surface (prompt+vocab+harness+llm+census)."""
    h = hashlib.sha256()
    for f in ('VOCAB.md', 'harness.py', 'llm.py'):
        h.update(open(os.path.join(HERE, f), 'rb').read())
    h.update(open(os.path.join(SHARED, 'dynamism_census.py'), 'rb').read())
    return h.hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--run-id', required=True)
    ap.add_argument('--sample', default='all', choices=('dev', 'owner', 'all'))
    ap.add_argument('--pilot', action='store_true', help='use the 5 pilot briefs instead')
    ap.add_argument('--model', default='gpt-5.6-luna')
    ap.add_argument('--effort', default='medium')
    ap.add_argument('--arm', default=None, help='arm label for cell meta (default runid)')
    ap.add_argument('--workers', type=int, default=6)
    ap.add_argument('--batch-concurrency', type=int, default=1)
    ap.add_argument('--final-draws', type=int, default=FINAL_DRAWS)
    ap.add_argument('--final-max-sites', type=int, default=FINAL_MAX_SITES)
    ap.add_argument('--only')
    ap.add_argument('--limit', type=int)
    ap.add_argument('--min-maps', type=int, default=2)
    ap.add_argument('--keep-batches', action='store_true')
    ap.add_argument('--out')
    a = ap.parse_args()

    run_dir = '/tmp/tgr-freeform-%s' % a.run_id
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
        print('FATAL: only %d ready maps (< %d); refusing a measured run'
              % (len(maps), a.min_maps))
        return 2

    if a.pilot:
        sel = load_pilot()
    else:
        sel, _ = load_sample(a.sample)
    if a.only:
        want = set(a.only.split(','))
        sel = [b for b in sel if b['id'] in want]
    if a.limit:
        sel = sel[:a.limit]

    arm = a.arm or a.run_id
    author = Author(run_dir, a.run_id, arm, a.model, a.effort, maps,
                    a.batch_concurrency, a.keep_batches,
                    final_draws=a.final_draws, final_max_sites=a.final_max_sites)
    ssha = surface_sha()
    print('freeform authoring: %d briefs, model %s effort %s, maps=%d, probe=%d final=%d '
          'surfaceSha=%s' % (len(sel), a.model, a.effort, len(maps), PROBE_DRAWS,
                             a.final_draws, ssha[:16]))

    def run(b):
        try:
            r = author.author_brief(b)
        except Exception as e:                                             # noqa: BLE001
            r = {'id': b['id'], 'category': b['category'],
                 'admitted': False, 'error': 'unhandled', 'detail': str(e)[:300],
                 'rounds': []}
        with _print_lock:
            print('  %-4s %-46s cells=%3d pass=%3d maps=%d sites=%d amb=%-8s rep=%d %s'
                  % ('ADM' if r.get('admitted') else '----', r['id'],
                     r.get('feasibleCells', 0) or 0, r.get('passingCells', 0) or 0,
                     r.get('maps', 0) or 0, r.get('sites', 0) or 0,
                     r.get('ambient', '?'), sum((r.get('repairPools') or {}).values()),
                     r.get('error', '')), flush=True)
        return r

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

    # arm-level census: pool every brief's per-cell rows
    all_rows, pass_rows = [], []
    for r in rows:
        p = os.path.join(run_dir, re.sub(r'[^A-Za-z0-9_-]', '-', r['id']),
                         'census-rows.json')
        if os.path.exists(p):
            cr = [c for c in json.load(open(p)) if 'error' not in c]
            all_rows += cr
            pass_rows += [c for c in cr if c.get('pass')]

    rep = {'gate': 'freeform full-schema authoring (%s, effort %s)' % (a.model, a.effort),
           'stream': STREAM, 'runId': a.run_id, 'arm': arm, 'runDir': run_dir,
           'model': a.model, 'effort': a.effort,
           'endpoint': os.environ.get('OPENAI_BASE_URL', ''),
           'surfaceSha256': ssha, 'mapsUsed': maps,
           'gateHashBefore': hash_before, 'gateHashAfter': hash_after,
           'briefs': len(rows), 'admitted': admitted,
           'admissionRate': round(admitted / len(rows), 4) if rows else 0.0,
           'probeDraws': PROBE_DRAWS, 'draws': a.final_draws, 'maxSites': a.final_max_sites,
           'budgets': {'validate': MAX_VALIDATE_REPAIRS, 'site': MAX_SITE_REPAIRS,
                       'revise': MAX_REVISES}, 'keepCells': KEEP_CELLS,
           'perCategory': dict(sorted(by_cat.items())),
           'categoriesCovered': sum(1 for c in by_cat.values() if c['admitted'] > 0),
           'firstFailureAcrossRejected': dict(sorted(fails.items(), key=lambda kv: -kv[1])),
           'usageTotal': usage, 'wallSeconds': wall,
           'censusAggAllCells': DC.aggregate(all_rows),
           'censusAggPassingCells': DC.aggregate(pass_rows),
           'cellsRoot': os.path.join(run_dir, 'cells'),
           'rows': rows}
    print(json.dumps({k: v for k, v in rep.items() if k != 'rows'}, indent=1))
    out = a.out or os.path.join(run_dir, 'report.json')
    json.dump(rep, open(out, 'w'), indent=1)
    print('wrote %s' % out)
    return 0


if __name__ == '__main__':
    sys.exit(main())
