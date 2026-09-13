#!/usr/bin/env python3
"""Blind per-scenario judge (axes 3 + 4) and corpus-layout judge, for the W7 frozen run.

Judge model: gpt-5.6-luna at reasoning effort medium (vlm.py) -- the same contract as every
previous round's judge, so the aggregates are comparable to the published baselines
(criticalAgreement 0.980 / categoryAgreement 0.384, kappa 0.336).

Three measurements, all OUTSIDE the authoring loop (never an optimisation signal):

STAGE A -- blind trace judgement. The judge sees SYMBOLIC FACTS read from the raw trace by
  tg_gate.trace_facts (actor kinds/dims/speeds, true OBB clearance and when, minTTC, required
  decel, collisions, occlusion events). It is NOT told the brief, the category, the gate verdict,
  or whether the cell was admitted. It answers: is this a critical edge case; which of the 15
  categories; what mechanism produced the criticality.

AXIS 3 -- mechanism provenance. A second, separate call: the judge now sees the same facts PLUS
  the brief's named mechanism and answers whether THAT mechanism caused the criticality shown.
  Physics overrides the model: if the brief names occlusion and the trace has no genuine
  hide-then-reveal, provenance is scored NO regardless of the model's answer.

AXIS 4 -- situational plausibility. Gate-independent by construction: judged from the AUTHORED
  SCENE (brief + the authoring decision + the corridor the template demands), for EVERY brief in
  the split, so sampling is balanced and the judge cannot infer admission. It answers: would this
  scene exist in the real world as described?

LAYOUT -- the corpus-layout judge, same shape as gold-corpus-v3/JUDGE.json (coverageVerdict,
  biggestGaps, fitForTrainingData, reasoning) over the per-category admitted counts.

Usage:
  judge_blind.py --report W7-luna-DEV.json W7-luna-HELDOUT.json --out JUDGE-W7.json
"""
import argparse, concurrent.futures, json, math, os, re, sys, threading

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
EC = os.path.join(ROOT, 'research', 'edge-case-corpus')
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(EC, 'tools', 'vista'))
import tg_gate as G                                                        # noqa: E402
import vlm                                                                 # noqa: E402

CATEGORIES = ['C1.car-following', 'C2.cut-in-merge', 'C3.intersection', 'C4.roundabout',
              'C5.pedestrian', 'C6.cyclist-ptw', 'C7.occlusion', 'C8.workzone', 'C9.hazard',
              'C10.oncoming', 'C11.parking', 'C12.school', 'C13.control', 'C14.loss-of-control',
              'C15.adversarial']

_print_lock = threading.Lock()


# ---------------------------------------------------------------- facts for the judge
def _actor_block(trace):
    meta = trace['header'].get('actorMetadata', {})
    ambient = set(trace['header'].get('ambientActorIds') or [])
    ticks = trace['ticks']
    ts = ticks['t']
    lines = []
    for aid, a in ticks['actors'].items():
        if aid in ambient:
            continue
        m = meta.get(aid, {})
        d = m.get('dims', {})
        cat = next((t.split(':', 1)[1] for t in m.get('tags', []) if t.startswith('catalog:')),
                   m.get('kind', '?'))
        speeds = [v for v, pr in zip(a['speedMps'], a['present']) if pr]
        n = len(ts)
        idx = [0, n // 4, n // 2, 3 * n // 4, n - 1]
        prof = ', '.join('%.1fs:%.1f' % (ts[i], a['speedMps'][i]) for i in idx if a['present'][i])
        lines.append('  - %s: %s (%s), %.1fx%.1f m, static=%s, speed m/s over time [%s], '
                     'max %.1f m/s' % (aid, m.get('kind', '?'), cat, d.get('l', 0), d.get('w', 0),
                                       m.get('static', False), prof,
                                       max(speeds) if speeds else 0.0))
    return '\n'.join(lines)


def facts_text(trace_path):
    trace = G.load_trace(trace_path)
    f = G.trace_facts(trace)
    occ = ('occlusion events: %s; occluderIneffective: %s; revealToConflict: %s'
           % (f['declaredOcclusion'] or 'none', f['occluderIneffective'] or 'none',
              f['revealToConflict']))
    return """ACTORS:
%s
KINEMATICS (computed from the raw trace, not self-reported):
  - ego max speed %.1f m/s, distance travelled %.1f m (after a %.1f s warm-up not shown)
  - TRUE closest oriented-bounding-box clearance: %.2f m at t=%s s, against actor '%s'
  - minimum time-to-collision: %s s at t=%s
  - ego required deceleration, max: %.2f m/s^2
  - collisions: %d
  - triggers that never fired: %s
  - %s
CLIP: %.0f s at dt=%.2f s.""" % (
        _actor_block(trace), f['maxSpeedMps'], f['distanceTravelledM'], f['warmupSeconds'],
        f['clearanceM'] if f['clearanceM'] is not None else float('nan'), f['closestT'],
        f['closestWith'], f['minTTC'], f['minTTCt'], f['requiredDecelMaxEgo'], f['collisions'],
        f['triggerNeverFired'] or 'none', occ, f['clipSeconds'] or 0, f['dt']), f


STAGE_A = """You are an independent, blind quality judge for autonomous-driving simulation traces.
You are told NOTHING about what this scenario was supposed to be. Below are symbolic facts
computed from the raw trace of one rollout (no collision unless stated).

%s

Taxonomy (choose the single best fit):
%s

Answer as ONE JSON object:
{"isCriticalEdgeCase": true/false,   // a genuine safety-critical near-miss demanding skill,
                                     // not a spawn artifact, not two distant actors
 "confidence": 0.0-1.0,
 "category": "<one taxonomy id>",
 "mechanism": "<one sentence: what mechanism produced the criticality>",
 "whyCritical": "<one sentence citing the numbers above>"}"""

AXIS3 = """You are an independent judge of MECHANISM PROVENANCE for one autonomous-driving
simulation trace. The scenario was authored from this brief:

  "%s"

Below are symbolic facts computed from the raw trace:

%s

Question: did the mechanism NAMED IN THE BRIEF actually cause the criticality visible in these
facts? Answer NO if the criticality is real but produced by something else (e.g. the brief names
an occlusion but the target was never hidden; the brief names a merge but the conflict is a
plain rear-end). Answer as ONE JSON object:
{"mechanismCaused": "yes"/"partial"/"no",
 "evidence": "<one sentence citing the specific fact that shows it>",
 "confidence": 0.0-1.0}"""

AXIS4 = """You are an independent judge of SITUATIONAL PLAUSIBILITY for autonomous-driving
training scenarios. Judge ONLY whether this scene, as authored, would exist in the real world.
Ignore whether it is dramatic or useful; a scene can be critical and implausible, or boring and
plausible.

BRIEF (category %s): "%s"

AUTHORED SCENE:
%s

Consider: do these actors, speeds and road context belong together in the real world? Is the
posted-speed context right for the activity described? Would a competent scenario reviewer
accept this scene as something that happens on real roads?

Answer as ONE JSON object:
{"plausible": true/false,
 "score": 0.0-1.0,      // 1.0 = unremarkably real, 0.0 = would not exist
 "objection": "<one sentence: the strongest objection, or 'none'>"}"""

LAYOUT = """You are the corpus-layout judge for a training corpus of autonomous-driving edge-case
scenarios. The stated target: at least 6 admitted archetypes in each of the 15 taxonomy
categories, none below 4, every archetype admitted under a frozen physical gate on >= 2 maps and
>= 3 distinct sites.

The corpus (admitted archetypes per category, from %d briefs attempted):
%s

DEV admission rate %.4f, HELDOUT %.4f, generalization gap %+.4f (p=%.3f).
Known map-inventory limits (verified mechanically, human dependency already filed): the five
maps have no roundabout, no school zone, no parking aisle, no rail crossing, no work-zone-ready
corridor, and no corridor posted below ~60 kph.

Answer as ONE JSON object:
{"coverageVerdict": "adequate"/"inadequate",
 "biggestGaps": ["<up to 4 concrete gaps, most important first>"],
 "fitForTrainingData": true/false,
 "reasoning": "<3-5 sentences. Judge the corpus in front of you, not the one you wish existed.>"}"""


# ---------------------------------------------------------------- helpers
def pick_cell(row, want_pass):
    """One trace path for an archetype: a gate-passing cell when want_pass, else the first cell
    with a trace. Lazy: gates cells one at a time and stops at the first hit."""
    outdir = row.get('outdir')
    if not outdir or not os.path.exists(os.path.join(outdir, 'batch-summary.json')):
        return None
    summary = json.load(open(os.path.join(outdir, 'batch-summary.json')))
    fallback = None
    for r in summary.get('results', []):
        tf = r.get('traceFile')
        if not tf or not os.path.exists(tf):
            continue
        if fallback is None:
            fallback = tf
        if not want_pass:
            return tf
        g = G.gate_cell(tf, verdict=r.get('verdict'), band=r.get('band'),
                        brief=row.get('briefText'), version=2)
        if g.get('pass'):
            return tf
    return fallback


def scene_text(row, brief):
    d = None
    for r in reversed(row.get('rounds', [])):
        if isinstance(r, dict) and isinstance(r.get('decision'), dict):
            d = r['decision']
            break
    lines = ['  - mechanism family: %s' % row.get('family')]
    if d:
        for k in ('egoSpeedKph', 'challengerCatalog', 'challengerSpeedKph', 'challengerStatic',
                  'occluder', 'junctionControl', 'corridorSpeedKph', 'gapM', 'conflictS'):
            if k in d:
                lines.append('  - %s: %s' % (k, json.dumps(d[k])))
    tpl = row.get('template')
    if tpl and os.path.exists(tpl):
        t = json.load(open(tpl))
        corr = (t.get('anchor') or {}).get('corridor') or {}
        sp = (corr.get('speedLimitKph') or {}).get('value')
        ln = (corr.get('throughLanesSameDir') or {}).get('value')
        lines.append('  - required corridor: posted speed %s kph, through-lanes %s' % (sp, ln))
    return '\n'.join(lines)


def _kappa(pairs):
    n = len(pairs)
    if not n:
        return None
    agree = sum(1 for a, b in pairs if a == b) / n
    pa = {}
    pb = {}
    for a, b in pairs:
        pa[a] = pa.get(a, 0) + 1
        pb[b] = pb.get(b, 0) + 1
    pe = sum(pa.get(c, 0) * pb.get(c, 0) for c in set(pa) | set(pb)) / (n * n)
    return (agree - pe) / (1 - pe) if pe < 1 else None


def ask_json(prompt):
    d, _ = vlm.ask_json(prompt, max_tokens=12000)
    return d


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--report', nargs='+', required=True)
    ap.add_argument('--workers', type=int, default=6)
    ap.add_argument('--out', required=True)
    a = ap.parse_args()

    corpus = json.load(open(os.path.join(EC, 'agent-authoring', 'brief-corpus-full.json')))
    brief_by_id = {b['id']: b for b in corpus['briefs']}

    rows, split_stats = [], {}
    for rp in a.report:
        rep = json.load(open(rp))
        split_stats[rep['split']] = {'admitted': rep['admitted'], 'n': rep['briefs'],
                                     'rate': rep['admissionRate']}
        rows.extend(rep['rows'])
    for r in rows:
        r['briefText'] = brief_by_id[r['id']]['brief']

    taxonomy = '\n'.join('  - ' + c for c in CATEGORIES)

    # ---------- STAGE A + AXIS 3, per archetype with a trace
    def judge_one(row):
        want_pass = bool(row.get('admitted'))
        tf = pick_cell(row, want_pass)
        if tf is None:
            return {'id': row['id'], 'skipped': 'no trace'}
        try:
            ftxt, facts = facts_text(tf)
        except Exception as e:                                             # noqa: BLE001
            return {'id': row['id'], 'skipped': 'facts failed: %s' % str(e)[:120]}
        out = {'id': row['id'], 'intended': row['category'], 'admitted': row.get('admitted'),
               'trace': tf}
        try:
            sa = ask_json(STAGE_A % (ftxt, taxonomy))
            out.update({'isCriticalEdgeCase': bool(sa.get('isCriticalEdgeCase')),
                        'confidence': sa.get('confidence'),
                        'category': sa.get('category'),
                        'mechanism': str(sa.get('mechanism'))[:300],
                        'whyCritical': str(sa.get('whyCritical'))[:300]})
        except Exception as e:                                             # noqa: BLE001
            out['stageAError'] = str(e)[:150]
        try:
            a3 = ask_json(AXIS3 % (row['briefText'], ftxt))
            caused = str(a3.get('mechanismCaused', 'no')).lower()
            # Physics override: an occlusion brief with no genuine reveal is NOT provenanced,
            # whatever the model said.
            if G.occlusion_intent(row['briefText']):
                occ_ok = bool(facts['declaredOcclusion']) and not facts['occluderIneffective']
                if not occ_ok:
                    caused = 'no'
                    a3['evidence'] = ('OVERRIDDEN BY PHYSICS: brief names occlusion but the '
                                      'trace shows no effective hide-then-reveal')
            out.update({'mechanismCaused': caused,
                        'mechanismEvidence': str(a3.get('evidence'))[:300],
                        'mechanismConfidence': a3.get('confidence')})
        except Exception as e:                                             # noqa: BLE001
            out['axis3Error'] = str(e)[:150]
        with _print_lock:
            print('  A/3 %-24s crit=%s cat=%s caused=%s' % (
                out['id'], out.get('isCriticalEdgeCase'), out.get('category'),
                out.get('mechanismCaused')))
        return out

    # ---------- AXIS 4, every brief (balanced by construction)
    def judge_plaus(row):
        try:
            p = ask_json(AXIS4 % (row['category'], row['briefText'],
                                  scene_text(row, brief_by_id[row['id']])))
            out = {'id': row['id'], 'admitted': row.get('admitted'),
                   'plausible': bool(p.get('plausible')), 'score': p.get('score'),
                   'objection': str(p.get('objection'))[:300]}
        except Exception as e:                                             # noqa: BLE001
            out = {'id': row['id'], 'admitted': row.get('admitted'),
                   'error': str(e)[:150]}
        with _print_lock:
            print('  A4  %-24s plausible=%s score=%s' % (out['id'], out.get('plausible'),
                                                         out.get('score')))
        return out

    with concurrent.futures.ThreadPoolExecutor(max_workers=a.workers) as pool:
        judgements = list(pool.map(judge_one, rows))
        plaus = list(pool.map(judge_plaus, rows))

    # ---------- aggregates
    jj = [j for j in judgements if 'skipped' not in j and 'stageAError' not in j]
    adm = [j for j in jj if j['admitted']]
    crit_agree = (sum(1 for j in adm if j['isCriticalEdgeCase']) / len(adm)) if adm else None
    cat_pairs = [(j['intended'], j.get('category')) for j in jj]
    cat_agree = (sum(1 for i, c in cat_pairs if i == c) / len(cat_pairs)) if cat_pairs else None
    a3j = [j for j in jj if 'axis3Error' not in j and j.get('mechanismCaused')]
    a3_adm = [j for j in a3j if j['admitted']]
    def frac(js, val):
        return round(sum(1 for j in js if j['mechanismCaused'] == val) / len(js), 4) if js else None
    pl = [p for p in plaus if 'error' not in p]
    pl_adm = [p for p in pl if p['admitted']]
    pl_rej = [p for p in pl if not p['admitted']]

    result = {
        'model': vlm.MODEL, 'effort': vlm.EFFORT,
        'endpoint': os.environ.get('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
        'splits': split_stats,
        'perScenario': {
            'n': len(jj), 'nAdmitted': len(adm),
            'criticalAgreement': round(crit_agree, 4) if crit_agree is not None else None,
            'categoryAgreement': round(cat_agree, 4) if cat_agree is not None else None,
            'categoryKappa': round(_kappa(cat_pairs), 4) if _kappa(cat_pairs) is not None else None,
            'judgements': judgements,
        },
        'axis3MechanismProvenance': {
            'n': len(a3j), 'nAdmitted': len(a3_adm),
            'causedYes': frac(a3_adm, 'yes'), 'causedPartial': frac(a3_adm, 'partial'),
            'causedNo': frac(a3_adm, 'no'),
            'allTraces': {'yes': frac(a3j, 'yes'), 'partial': frac(a3j, 'partial'),
                          'no': frac(a3j, 'no')},
        },
        'axis4Plausibility': {
            'n': len(pl),
            'plausibleShare': round(sum(1 for p in pl if p['plausible']) / len(pl), 4) if pl else None,
            'meanScore': round(sum(p['score'] or 0 for p in pl) / len(pl), 4) if pl else None,
            'admitted': {'n': len(pl_adm),
                         'plausibleShare': round(sum(1 for p in pl_adm if p['plausible'])
                                                 / len(pl_adm), 4) if pl_adm else None,
                         'meanScore': round(sum(p['score'] or 0 for p in pl_adm)
                                            / len(pl_adm), 4) if pl_adm else None},
            'rejected': {'n': len(pl_rej),
                         'plausibleShare': round(sum(1 for p in pl_rej if p['plausible'])
                                                 / len(pl_rej), 4) if pl_rej else None,
                         'meanScore': round(sum(p['score'] or 0 for p in pl_rej)
                                            / len(pl_rej), 4) if pl_rej else None},
            'judgements': plaus,
        },
    }

    # ---------- corpus-layout judge
    by_cat = {c: 0 for c in CATEGORIES}
    for r in rows:
        if r.get('admitted'):
            by_cat[r['category']] += 1
    dev = split_stats.get('DEV', {})
    held = split_stats.get('HELDOUT', {})
    gap = (dev.get('rate', 0) - held.get('rate', 0)) if dev and held else 0.0
    # two-proportion p, same formula as the authoring report
    p_val = 1.0
    if dev and held:
        k1, n1, k2, n2 = dev['admitted'], dev['n'], held['admitted'], held['n']
        p = (k1 + k2) / (n1 + n2)
        se = math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2))
        if se > 0:
            z = (k1 / n1 - k2 / n2) / se
            p_val = math.erfc(abs(z) / math.sqrt(2))
    layout_prompt = LAYOUT % (sum(s['n'] for s in split_stats.values()),
                              json.dumps(by_cat, indent=1), dev.get('rate', 0),
                              held.get('rate', 0), gap, p_val)
    try:
        lj = ask_json(layout_prompt)
    except Exception as e:                                                 # noqa: BLE001
        lj = {'error': str(e)[:200]}
    result['corpusLayout'] = lj
    result['layout'] = {'archetypes': sum(by_cat.values()), 'byCategory': by_cat,
                        'briefsAttempted': sum(s['n'] for s in split_stats.values()),
                        'devRate': dev.get('rate'), 'heldoutRate': held.get('rate'),
                        'gap': round(gap, 4), 'pValue': round(p_val, 4)}

    json.dump(result, open(a.out, 'w'), indent=1)
    print(json.dumps({k: v for k, v in result.items()
                      if k in ('perScenario', 'axis3MechanismProvenance', 'axis4Plausibility',
                               'corpusLayout', 'layout')}
                     | {'perScenario': {k: v for k, v in result['perScenario'].items()
                                        if k != 'judgements'},
                        'axis4Plausibility': {k: v for k, v in result['axis4Plausibility'].items()
                                              if k != 'judgements'}}, indent=1))
    print('wrote %s' % a.out)
    return 0


if __name__ == '__main__':
    sys.exit(main())
