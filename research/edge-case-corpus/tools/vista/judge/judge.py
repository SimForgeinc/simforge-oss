"""judge.py -- an INDEPENDENT quality judge for driving-scenario rollouts.

The frozen admission gate is physics-only. It answers "is this a physically genuine near-encounter?"
It cannot answer "is this an INTERESTING, NOVEL edge case, and does it do what the brief asked for?"
This module answers that, and is designed so that its most important possible output is
    verdict = "physically-valid-but-boring".

Design (justified in RUBRIC.md):
  Stage 0  deterministic features from the raw trace              (features.py)
  Stage 1  BLIND vision pass: the model sees the rollout and is NOT told the brief
  Stage 2  RUBRIC pass: the model is given the brief, its OWN stage-1 description, the images again,
           and a *verified* numeric appendix, and scores 5 anchored dimensions
  Stage 3  cross-checks: the model's falsifiable stage-1 claims are checked against the trace, and
           hard mechanical rules override the model where physics already settles the question

Model: gpt-5.6-luna, reasoning effort medium (the only permitted model).

CLI:
    .venv/bin/python judge/judge.py <trace.json.gz> --instance <i.json> --brief "..." --out <dir>
    .venv/bin/python judge/judge.py --batch <batch-summary.json> --brief "..." --out <dir>
"""
import argparse, base64, json, math, os, sys, time, hashlib

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(HERE))

import features as F
import rollout_render as RR
import gate as G

MODEL = 'gpt-5.6-luna'
EFFORT = 'medium'
ENDPOINT = os.environ.get('OPENAI_BASE_URL', 'https://api.openai.com/v1').rstrip('/') + '/responses'

RUBRIC_VERSION = 'vista-independent-judge/v1'


# --------------------------------------------------------------------------- llm
def _call(prompt, images=(), max_tokens=4000, retries=3):
    import httpx
    key = os.environ.get('OPENAI_API_KEY')
    if not key:
        raise RuntimeError('OPENAI_API_KEY not set -- preflight it before any run')
    content = [{'type': 'input_text', 'text': prompt}]
    for p in images:
        with open(p, 'rb') as f:
            content.append({'type': 'input_image',
                            'image_url': 'data:image/png;base64,' + base64.b64encode(f.read()).decode()})
    body = {'model': MODEL, 'reasoning': {'effort': EFFORT}, 'max_output_tokens': max_tokens,
            'input': [{'role': 'user', 'content': content}]}
    last = None
    for k in range(retries):
        try:
            r = httpx.post(ENDPOINT, headers={'Authorization': f'Bearer {key}',
                                              'Content-Type': 'application/json'},
                           json=body, timeout=300)
            r.raise_for_status()
            d = r.json()
            out = []
            for it in d.get('output', []):
                for c in it.get('content', []) or []:
                    if c.get('type') == 'output_text':
                        out.append(c['text'])
            txt = '\n'.join(out).strip()
            if txt:
                return txt
            last = f'empty output (status={d.get("status")})'
        except Exception as ex:                                   # noqa: BLE001
            last = repr(ex)
        time.sleep(2 + 3 * k)
    raise RuntimeError(f'llm call failed after {retries} tries: {last}')


def _json_block(txt):
    """Pull the last well-formed JSON object out of a model reply."""
    s = txt
    if '```' in s:
        parts = [p for p in s.split('```') if p.strip().startswith(('{', 'json'))]
        if parts:
            s = parts[-1]
            if s.strip().startswith('json'):
                s = s.strip()[4:]
    start = s.find('{')
    while start != -1:
        depth = 0
        for i in range(start, len(s)):
            if s[i] == '{': depth += 1
            elif s[i] == '}':
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(s[start:i + 1])
                    except Exception:                              # noqa: BLE001
                        break
        start = s.find('{', start + 1)
    raise ValueError('no JSON object in model reply:\n' + txt[:800])


# --------------------------------------------------------------------------- prompts
STAGE1 = """You are looking at a top-down replay of a driving simulation. You are NOT told what the
scenario was supposed to be, and you must not guess at any intended label. Report only what you can
actually see and what the numbers below state.

Image 1 is a six-panel filmstrip of the whole clip, read left-to-right, top row then bottom row.
Image 2 is two close-ups side by side. LEFT is the moment the ego's footprint came closest to another
road user. RIGHT is the moment that road user was most directly in front of the ego, in its path.
THESE ARE OFTEN NOT THE SAME MOMENT, and the difference matters: if the other party had already
finished crossing and stopped by the time of the closest approach, then the "near miss" is a pass-by
and the real interaction happened earlier and further away. The red line joins the two parties.

Colour key: BLUE = the ego (the vehicle under test). YELLOW = a pedestrian. RED = another car.
Faded grey boxes = static scenery props (parked vehicles, etc.), they never move.
Arrows point along each actor's heading. The dotted blue line is where the ego has already been.
Every panel is ego-centred, so the ego appears near the middle of each panel and the ROAD moves, not
the ego. Each panel's title gives the time and the ego's speed.

Ego speed over the clip, sampled: {speed_trace}
Clip length {clip} s. All times below are trace time; the actors were placed {warmup} s before t=0.

Describe what happens, then answer in JSON. Be concrete and physical. If you cannot tell, say so
rather than inventing.

Answer with ONE JSON object and nothing else:
{{
 "scene": "one sentence: what kind of road/junction this is",
 "narrative": "3-5 sentences: what each visible road user does over the clip, in order",
 "critical_moment": {{"t_seconds": <number>, "what_happens": "<short>",
                      "other_party": "<the label you read off the image>"}},
 "ego_response": {{"braked": true|false, "swerved": true|false,
                   "description": "<what the ego did about it>"}},
 "conflict_type": "one of: crossing | head-on | following | lane-change/cut-in | door/opening | none",
 "would_a_human_driver_have_had_to_do_something": true|false,
 "anything_physically_impossible": "<what, or 'none'>",
 "confidence": 0.0-1.0
}}"""

STAGE2 = """You are the independent quality judge for a corpus of autonomous-driving EDGE-CASE
scenarios. Your job is NOT to check physics -- a separate frozen physical gate already did that, and
this clip PASSED it. Your job is the thing the gate cannot do: decide whether this is a genuinely
interesting, novel edge case that realises what was asked for, or whether it is a physically valid but
BORING clip. Saying "physically valid but boring" is the single most important verdict you can give.
Corpora like this are ruined by graders who wave through anything that did not crash.

THE BRIEF THAT WAS AUTHORED FROM (one sentence, the intent):
    "{brief}"

YOUR OWN DESCRIPTION OF THE CLIP, written BEFORE you were shown that brief:
{stage1}

The same two images are attached again (filmstrip, then the two close-ups: minimum clearance on the
left, most-in-the-ego's-path on the right).

VERIFIED MEASUREMENTS, computed directly from the simulation trace. These are ground truth. If your
earlier description disagrees with them, the measurements win:
{facts}

SCORE EACH DIMENSION 0-4 USING THESE ANCHORS. Do not average them; give each one separately.

R1 intent realisation -- does the specific event the brief names actually happen, with the named kind
   of actor, in the named spatial relationship?
   0 the named event does not happen at all
   1 something vaguely related happens, but the named mechanism does not (e.g. the brief says the
     pedestrian emerges from between parked cars, and the pedestrian is nowhere near the parked cars,
     or the parked cars are on the other side of the road, or the occluder never occluded)
   2 the event happens but a named element is missing or misplaced
   3 the event happens as described, with all named elements in the right relationship
   4 as 3, and the geometry/timing makes the mechanism unmistakable

R2 conflict genuineness -- is there a real conflict, or is this a pass-by?
   0 no conflict: paths never contest the same space; the actors are merely near each other
   1 trivial: separation was comfortable throughout, or the "conflict" is with something stationary
     that the ego simply drove past
   2 a real but easy interaction: the ego had time and space
   3 a genuine conflict: the two contest the same space at the same time and one of them had to give
   4 a severe conflict: contested space, little margin, and the outcome depended on the response

R3 novelty and interest -- for a training/evaluation corpus, is this worth a slot?
   0 generic car-following or free driving; nothing a normal drive would not contain
   1 a common, well-covered situation (ordinary lead-vehicle braking, ordinary crossing pedestrian in
     full view with plenty of warning)
   2 a recognisable but somewhat distinctive situation
   3 a genuinely distinctive interaction: occlusion, unusual actor behaviour, an awkward geometry, a
     rule violation by another party, or a combination that a driver would remember
   4 rare and specific; you would expect a competent system to be surprised by it

R4 ego response: non-trivial but survivable -- this is a BAND, not a ladder. Both ends are bad.
   0 the ego did nothing at all (constant speed and heading), OR the ego collided / the situation was
     unsurvivable
   1 a negligible response (a token speed change) or a wildly excessive one (emergency stop for
     nothing)
   2 a modest but real response
   3 a clearly non-trivial, proportionate response: meaningful braking and/or a real path change, and
     it worked
   4 as 3, and the response had to be well-timed -- earlier or later and it would not have worked

R5 plausibility -- would a driving instructor accept that this could happen on a real road?
   0 physically or behaviourally impossible (a body passing through another, an actor teleporting, a
     vehicle in a place no vehicle can be, a pedestrian standing motionless in a live traffic lane
     for no reason)
   1 several implausible details
   2 one clearly odd detail
   3 plausible
   4 plausible and natural

Then decide the verdict, applying these rules IN ORDER and stopping at the first that matches:
  R5 <= 1                       -> "invalid"
  R1 <= 1                       -> "intent-not-realised"
  R2 <= 1 or R4 == 0            -> "physically-valid-but-boring"
  R3 <= 1 and R2 <= 2           -> "physically-valid-but-boring"
  min(R1,R2,R3,R4) >= 3         -> "high"
  otherwise                     -> "acceptable"

Answer with ONE JSON object and nothing else:
{{
 "R1_intent_realisation":  {{"score": 0-4, "why": "<cite a specific time or panel>"}},
 "R2_conflict_genuineness":{{"score": 0-4, "why": "<cite a specific time or panel>"}},
 "R3_novelty":             {{"score": 0-4, "why": "<what makes it (un)distinctive>"}},
 "R4_ego_response":        {{"score": 0-4, "why": "<cite the measured speed/steer numbers>"}},
 "R5_plausibility":        {{"score": 0-4, "why": "<what, if anything, looks wrong>"}},
 "verdict": "high|acceptable|physically-valid-but-boring|intent-not-realised|invalid",
 "one_line": "<the single most useful sentence for the author>",
 "what_would_make_it_better": "<one concrete change, or 'nothing'>",
 "predicted_difficulty_0_100": <number>
}}"""


# --------------------------------------------------------------------------- facts for the model
def _speed_sample(trace, n=14):
    ts = trace['ticks']['t']; e = trace['ticks']['actors']['ego']
    idx = [int(round(k * (len(ts) - 1) / (n - 1))) for k in range(n)]
    return ', '.join(f'{ts[i]:.1f}s:{e["speedMps"][i]:.1f}' for i in idx)


def _facts_block(feat, diff):
    conf = feat['conflictActor']
    c = feat['challengers'].get(conf, {})
    lines = [
        f"ego travelled {feat['egoDistanceM']} m (net displacement {feat['egoNetDisplacementM']} m)",
        f"ego speed {feat['ego']['speedMinMps']}..{feat['ego']['speedMaxMps']} m/s "
        f"(gave up {feat['ego']['speedDropMps']} m/s)",
        f"ego OBSERVED peak deceleration {feat['ego']['peakDecelObservedMps2']} m/s^2, "
        f"peak lateral acceleration {feat['ego']['peakLatAccelObservedMps2']} m/s^2",
        f"ego intervention episodes: {feat['ego']['brakingEpisodes']} braking, "
        f"{feat['ego']['steeringEpisodes']} steering; {feat['ego']['brakingSeconds']} s under braking",
        f"ego never changed speed at all: {feat['ego']['egoNeverChangedSpeed']}",
        f"closest other road user: {conf}",
    ]
    if c:
        lines += [
            f"  its kind: {c.get('kind')}; its speed range {c.get('speedMinMps')}..{c.get('speedMaxMps')} m/s",
            f"  ITS SPEED AT THE MOMENT OF CLOSEST APPROACH: {c.get('speedAtMinClearanceMps')} m/s "
            f"(if this is ~0 the 'near miss' is with something that has stopped moving)",
            f"  TRUE oriented-bounding-box clearance {c.get('minClearanceM')} m at t={c.get('tMinClearance')} s",
            f"  encounter geometry: {c.get('geometry')} (heading difference {c.get('headingDiffRad')} rad)",
            f"  closing rate at that instant: {c.get('closingRateAtMinMps')} m/s",
            f"  was it already closest at the very start of the clip? {c.get('closestAtStart')}",
        ]
    pc = c.get('conflictEvent') or {}
    if pc:
        lines += [
            'CONTESTED-SPACE EVENT (did the two bodies ever occupy the SAME GROUND, at possibly '
            'different times? this is separate from how close they were at any one instant):',
            f"  did their footprints ever overlap in space? {pc.get('contested')} "
            f"(closest the two PATHS came, with timing removed: {pc.get('pathSeparationM')} m)",
            f"  the ego occupied that ground at t={pc.get('tCross')} s; the other party occupied it "
            f"at t={pc.get('tChallengerAtCross')} s",
            f"  time separation at that point (a post-encroachment time): "
            f"{pc.get('encroachmentGapS')} s; {pc.get('whoArrivedFirst')} got there first",
            f"  the other party's speed WHEN THE EGO ARRIVED: "
            f"{pc.get('challengerSpeedAtEgoArrival')} m/s "
            '(if ~0 it had already finished and stopped, which is usually route exhaustion)',
        ]
    others = [k for k in feat['challengers'] if k != conf]
    if others:
        lines.append('other road users: ' + '; '.join(
            f"{k} (min clearance {feat['challengers'][k].get('minClearanceM')} m)" for k in others))
    if feat['props']:
        lines.append('static props and how close the ego passed them: ' + '; '.join(
            f"{k} {v['minClearanceM']} m at t={v['t']} s" for k, v in feat['props'].items()))
    if feat.get('engine_revealToConflictS') is not None:
        lines.append(f"declared occlusion: the target became visible "
                     f"{feat['engine_revealToConflictS']} s before the conflict")
    if feat.get('engine_occluderIneffective'):
        lines.append('WARNING: the engine reports the declared occluder never actually occluded')
    lines.append(f"trigger events fired: {[ (e.get('interactionId'), e.get('t')) for e in feat['events'] ]}")
    lines.append(f"MEASURED difficulty (control effort the ego actually spent, 0-100): {diff['score']} "
                 f"{diff['components']}")
    return '\n'.join('  - ' + l for l in lines)


# --------------------------------------------------------------------------- mechanical checks
def mechanical_flags(feat, gate_cell=None):
    """Physics-settled facts that OVERRIDE the model. These cannot be argued with."""
    f = []
    ego = feat['ego']
    conf = feat['challengers'].get(feat['conflictActor'] or '', {})
    if ego['egoNeverChangedSpeed'] and ego['peakLatAccelObservedMps2'] < 0.3:
        f.append(('EGO_NEVER_ACTED', 'the ego held a constant speed and heading for the entire clip'))
    if ego['peakDecelObservedMps2'] < 0.5 and ego['peakLatAccelObservedMps2'] < 0.5:
        f.append(('EGO_RESPONSE_NEGLIGIBLE',
                  f"observed peak decel {ego['peakDecelObservedMps2']} m/s^2, "
                  f"peak lat {ego['peakLatAccelObservedMps2']} m/s^2"))
    if conf.get('closestAtStart'):
        f.append(('CLOSEST_AT_SPAWN', 'the closest approach is at the first co-present tick'))
    if conf.get('speedMaxMps') is not None and conf['speedMaxMps'] < 0.2:
        f.append(('CHALLENGER_STATIC',
                  'the nearest road user never moves -- this is scenery, not a conflict'))
    elif conf.get('speedAtMinClearanceMps') is not None and conf['speedAtMinClearanceMps'] < 0.3:
        f.append(('CHALLENGER_STOPPED_AT_CONFLICT',
                  f"the other party had stopped ({conf['speedAtMinClearanceMps']} m/s) by the time of "
                  'closest approach: the closest-approach instant is a pass-by, not the conflict'))
    if conf.get('maxTickJumpM', 0) > 0.0:
        dt = feat.get('dt') or 0.02
        v = conf.get('speedMaxMps') or 0.0
        if conf['maxTickJumpM'] > 1.5 * v * dt + 0.05:
            f.append(('CHALLENGER_DISCONTINUOUS',
                      f"largest single-tick jump {conf['maxTickJumpM']} m exceeds its own speed"))
    pc = conf.get('conflictEvent') or {}
    if pc:
        if not pc.get('contested') and pc.get('pathSeparationM', 0) > 2.0:
            f.append(('NO_CONTESTED_SPACE',
                      f"the two paths never came closer than {pc['pathSeparationM']} m even with "
                      'timing removed: they never contested any ground'))
        if not pc.get('sameEvent'):
            f.append(('PROXIMITY_IS_NOT_THE_CONFLICT',
                      f"the minimum-clearance instant (t={conf.get('tMinClearance')}) is "
                      f"{pc.get('lagS')} s away from the contested-space instant (t={pc.get('tCross')})"))
        if pc.get('challengerSpeedAtEgoArrival') is not None \
                and pc['challengerSpeedAtEgoArrival'] < 0.3:
            f.append(('CHALLENGER_STOPPED_AFTER_CROSSING',
                      f"the other party crossed with a {pc.get('encroachmentGapS')} s gap and had "
                      f"stopped ({pc['challengerSpeedAtEgoArrival']} m/s) by the time the ego "
                      'arrived; it is left standing in the carriageway'))
        if pc.get('encroachmentGapS') is not None and pc['encroachmentGapS'] < 0.2:
            f.append(('NEAR_COLLISION_BY_TIMING',
                      f"encroachment gap only {pc['encroachmentGapS']} s: a collision that missed by "
                      'timing alone'))
    if conf.get('presentFrac', 1.0) < 0.98:
        f.append(('CHALLENGER_PARTIALLY_ABSENT',
                  f"present for only {conf.get('presentFrac')} of the clip"))
    for pid, p in (feat.get('props') or {}).items():
        if p['minClearanceM'] <= 0.0:
            f.append(('EGO_INTERSECTS_PROP',
                      f'the ego footprint overlaps static prop {pid} at t={p["t"]} s '
                      f'(props are collidable:false so nothing else notices)'))
    if feat.get('engine_occluderIneffective'):
        f.append(('OCCLUDER_INEFFECTIVE', 'a declared occluder never actually blocked line of sight'))
    if feat.get('engine_clippedCriticality'):
        f.append(('CRITICALITY_CLIPPED', 'the solver had to clip the criticality target'))
    if feat['egoDistanceM'] > 1.0 and feat['egoNetDisplacementM'] / feat['egoDistanceM'] < 0.5:
        f.append(('EGO_NOT_MAKING_PROGRESS',
                  f"net displacement is only "
                  f"{feat['egoNetDisplacementM']/feat['egoDistanceM']:.2f} of path length"))
    return f


HARD_CAPS = {
    'EGO_NEVER_ACTED':          {'R4': 0},
    'EGO_RESPONSE_NEGLIGIBLE':  {'R4': 1},
    'CHALLENGER_STATIC':        {'R2': 1},
    'CLOSEST_AT_SPAWN':         {'R2': 1},
    'CHALLENGER_DISCONTINUOUS': {'R5': 1},
    'EGO_INTERSECTS_PROP':      {'R5': 0},
    'OCCLUDER_INEFFECTIVE':     {'R1': 1},
    'EGO_NOT_MAKING_PROGRESS':  {'R5': 1},
    # deliberately NOT capped: a pedestrian frozen in the carriageway can be a legitimate hard case.
    # It is surfaced to the model instead, which must address it under R5.
    'CHALLENGER_STOPPED_AT_CONFLICT': {},
    # also not capped: it is a fact about the GATE's bookkeeping, not necessarily about the scenario.
    # Surfaced to the model, which must decide whether the real interaction was genuine.
    'PROXIMITY_IS_NOT_THE_CONFLICT': {},
    'CHALLENGER_STOPPED_AFTER_CROSSING': {},   # realism note, not a conflict test -- see conflict.py
    'NEAR_COLLISION_BY_TIMING': {},            # informative; C5's PET floor already governs it
    'NO_CONTESTED_SPACE':       {'R2': 1},     # they never shared any ground: not a conflict
}


def _verdict(scores):
    R1, R2, R3, R4, R5 = (scores[k] for k in ('R1', 'R2', 'R3', 'R4', 'R5'))
    if R5 <= 1: return 'invalid'
    if R1 <= 1: return 'intent-not-realised'
    if R2 <= 1 or R4 == 0: return 'physically-valid-but-boring'
    if R3 <= 1 and R2 <= 2: return 'physically-valid-but-boring'
    if min(R1, R2, R3, R4) >= 3: return 'high'
    return 'acceptable'


def cross_check(stage1, feat):
    """Check the model's falsifiable stage-1 claims against the trace. A judge that cannot be
    caught being wrong is a judge that cannot be trusted."""
    out = {}
    conf = feat['conflictActor']
    c = feat['challengers'].get(conf or '', {})
    # the critic may legitimately name EITHER the minimum-clearance instant or the contested-space
    # instant; both are correct answers to "when was the critical moment". Only naming neither is wrong.
    valid_t = [t for t in (c.get('tMinClearance'),
                           (c.get('conflictEvent') or {}).get('tCross'),
                           (c.get('conflictEvent') or {}).get('tChallengerAtCross')) if t is not None]
    t_claim = (stage1.get('critical_moment') or {}).get('t_seconds')
    if valid_t and isinstance(t_claim, (int, float)):
        out['conflict_time_error_s'] = round(min(abs(t_claim - t) for t in valid_t), 2)
        out['conflict_time_ok'] = out['conflict_time_error_s'] <= 1.5
        out['conflict_time_candidates'] = valid_t
    party = str((stage1.get('critical_moment') or {}).get('other_party', '')).lower()
    known = set(k.lower() for k in feat['challengers']) | set(
        k.lower() for k in (feat['props'] or {}))
    out['other_party_ok'] = any(k in party or party in k for k in known) if party else False
    er = stage1.get('ego_response') or {}
    braked_true = feat['ego']['peakDecelObservedMps2'] >= 1.0
    swerved_true = feat['ego']['peakLatAccelObservedMps2'] >= 1.0
    out['braked_claim_ok'] = (bool(er.get('braked')) == braked_true)
    out['swerved_claim_ok'] = (bool(er.get('swerved')) == swerved_true)
    out['braked_measured'] = braked_true
    out['swerved_measured'] = swerved_true
    checks = [v for k, v in out.items() if k.endswith('_ok')]
    out['reliability'] = round(sum(1 for v in checks if v) / max(len(checks), 1), 2)
    return out


# --------------------------------------------------------------------------- main entry
def judge_trace(trace_path, brief, out_dir, dev_assets, instance_path=None,
                gate_verdict=None, gate_band=None, tag=None, keep_images=True):
    os.makedirs(out_dir, exist_ok=True)
    tag = tag or hashlib.sha1(trace_path.encode()).hexdigest()[:10]
    trace = F.load_trace(trace_path)
    feat = F.rollout_features(trace)
    diff = F.difficulty(feat)
    conf = feat['conflictActor']
    tmin = (feat['challengers'].get(conf or '') or {}).get('tMinClearance')
    clr = (feat['challengers'].get(conf or '') or {}).get('minClearanceM')

    pc = (feat['challengers'].get(conf or '') or {}).get('conflictEvent') or {}
    tcross = pc.get('tCross')
    film = os.path.join(out_dir, f'{tag}.film.png')
    close = os.path.join(out_dir, f'{tag}.close.png')
    RR.filmstrip(trace, dev_assets, film, tmin=tmin)
    RR.two_up(trace, dev_assets, close, tmin, tcross,
              pair=('ego', conf) if conf else None)

    s1_raw = _call(STAGE1.format(speed_trace=_speed_sample(trace),
                                 clip=feat['clipSeconds'], warmup=feat['warmupSeconds']),
                   images=(film, close))
    s1 = _json_block(s1_raw)

    s2_raw = _call(STAGE2.format(brief=brief,
                                 stage1=json.dumps(s1, indent=1),
                                 facts=_facts_block(feat, diff)),
                   images=(film, close))
    s2 = _json_block(s2_raw)

    scores = {k: int((s2.get(f'{k}_{n}') or {}).get('score', 0))
              for k, n in (('R1', 'intent_realisation'), ('R2', 'conflict_genuineness'),
                           ('R3', 'novelty'), ('R4', 'ego_response'), ('R5', 'plausibility'))}
    raw_scores = dict(scores)
    flags = mechanical_flags(feat)
    applied = []
    for code, _ in flags:
        for dim, cap in HARD_CAPS.get(code, {}).items():
            if scores[dim] > cap:
                applied.append({'flag': code, 'dim': dim, 'from': scores[dim], 'to': cap})
                scores[dim] = cap
    xc = cross_check(s1, feat)
    if xc.get('reliability', 1.0) < 0.5:
        # the model demonstrably misread the clip: it does not get to award high marks on it
        for dim in ('R1', 'R2', 'R3'):
            if scores[dim] > 2:
                applied.append({'flag': 'LOW_RELIABILITY', 'dim': dim, 'from': scores[dim], 'to': 2})
                scores[dim] = 2

    result = {
        'rubricVersion': RUBRIC_VERSION, 'model': MODEL, 'effort': EFFORT,
        'trace': trace_path, 'instance': instance_path, 'brief': brief,
        'mapId': feat['mapId'], 'conflictActor': conf,
        'gate': {'verdict': gate_verdict, 'band': gate_band},
        'scoresRaw': raw_scores, 'scores': scores,
        'verdictModel': s2.get('verdict'), 'verdict': _verdict(scores),
        'oneLine': s2.get('one_line'), 'improve': s2.get('what_would_make_it_better'),
        'difficultyMeasured': diff, 'difficultyModelGuess': s2.get('predicted_difficulty_0_100'),
        'mechanicalFlags': [c for c, _ in flags], 'mechanicalFlagDetail': dict(flags),
        'capsApplied': applied, 'crossCheck': xc,
        'stage1': s1, 'stage2': s2,
        'features': {k: v for k, v in feat.items() if k != 'events'},
        'images': {'filmstrip': film, 'closeup': close},
    }
    with open(os.path.join(out_dir, f'{tag}.judgement.json'), 'w') as f:
        json.dump(result, f, indent=1)
    if not keep_images:
        for p in (film, close):
            try: os.remove(p)
            except OSError: pass
    return result


def judge_batch(summary_path, brief, out_dir, dev_assets, only_gate_pass=True, limit=None, workers=4):
    gres = G.gate_batch(summary_path)
    cells = [c for c in gres['cells'] if c.get('traceFile')]
    if only_gate_pass:
        cells = [c for c in cells if c.get('pass')]
    if limit:
        cells = cells[:limit]
    from concurrent.futures import ThreadPoolExecutor

    def one(c):
        tag = f"{c['mapId'][:8]}-{c['siteId'][:8]}-d{c.get('drawIndex')}"
        try:
            r = judge_trace(c['traceFile'], brief, out_dir, dev_assets,
                            instance_path=c.get('instanceFile'),
                            gate_verdict=c.get('verdict'), gate_band=c.get('band'), tag=tag)
            r['gate']['pass'] = c.get('pass')
            r['gate']['clearanceM'] = c.get('clearanceM')
        except Exception as ex:                                    # noqa: BLE001
            r = {'trace': c['traceFile'], 'error': repr(ex), 'gate': {'pass': c.get('pass')}}
        print(f"  {tag}: gate={'PASS' if c.get('pass') else 'fail'} "
              f"judge={r.get('verdict')} scores={r.get('scores')} "
              f"diff={(r.get('difficultyMeasured') or {}).get('score')}", flush=True)
        return r

    with ThreadPoolExecutor(max_workers=workers) as ex:
        out = list(ex.map(one, cells))
    with open(os.path.join(out_dir, 'judgements.json'), 'w') as f:
        json.dump({'summary': summary_path, 'brief': brief,
                   'gate': {k: gres[k] for k in ('admitted', 'passingCells', 'totalCells',
                                                 'nMaps', 'nSites', 'lossCounts')},
                   'judgements': out}, f, indent=1)
    return out


def _default_dev_assets():
    p = os.path.abspath(HERE)
    for _ in range(8):
        p = os.path.dirname(p)
        cand = os.path.join(p, 'dev-assets')
        if os.path.isdir(cand):
            return cand
    raise RuntimeError('dev-assets not found')


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('trace', nargs='?')
    ap.add_argument('--batch')
    ap.add_argument('--brief', required=True)
    ap.add_argument('--instance')
    ap.add_argument('--out', required=True)
    ap.add_argument('--dev-assets', default=None)
    ap.add_argument('--all-cells', action='store_true',
                    help='judge gate-failing cells too (default: only gate-passing)')
    ap.add_argument('--limit', type=int)
    ap.add_argument('--workers', type=int, default=4)
    a = ap.parse_args()
    dev = a.dev_assets or _default_dev_assets()
    if a.batch:
        judge_batch(a.batch, a.brief, a.out, dev, only_gate_pass=not a.all_cells, limit=a.limit, workers=a.workers)
    else:
        r = judge_trace(a.trace, a.brief, a.out, dev, instance_path=a.instance)
        print(json.dumps({k: r[k] for k in ('verdict', 'scores', 'scoresRaw', 'mechanicalFlags',
                                            'capsApplied', 'crossCheck', 'oneLine', 'improve')},
                         indent=1))
