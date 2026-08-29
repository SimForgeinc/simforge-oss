"""Blind vision judge for rendered rollouts. Stream B, tg-rethink.

Codex models ONLY (the gateway silently blinds Anthropic models to input_image;
see tools/gates/assert_vision.py). assert_vision runs once per process and is FATAL.

The rubric prompt below is pre-registered in PREREG.md; do not edit after the first
measured run without a superseding prereg. The judge never receives arm labels, file
names, actor ids, or metric values -- only the anonymized filmstrip PNG.
"""
import base64
import json
import os
import sys
import time

import httpx

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'gates'))

JUDGE_VERSION = 'judge-v1'
DEFAULT_MODEL = os.environ.get('TGR_JUDGE_MODEL', 'gpt-5.6-sol')
DEFAULT_EFFORT = os.environ.get('TGR_JUDGE_EFFORT', 'medium')
URL = os.environ.get('OPENAI_BASE_URL', 'http://127.0.0.1:4141/v1').rstrip('/') + '/responses'

RUBRIC = """You are reviewing ONE traffic scene from a driving simulator, shown as a filmstrip of 8 \
top-down schematic keyframes in time order (left to right, top row first; each panel is \
timestamped). Road lanes are grey/olive lines, junctions brown. The ego vehicle is the BLUE box. \
Other road users: green boxes = cars/trucks, teal = buses, red discs = pedestrians, orange = \
cyclists, amber = deliberately parked/static vehicles or objects, dashed brown = fixed roadside \
objects. Thin trails show each actor's last 2 seconds of motion.

Judge whether this reads as REAL TRAFFIC. Score each 0-10 (0 = not at all, 10 = fully):
- density_plausible: is the amount of traffic believable for a public road (not an empty dead \
world, not absurdly packed)?
- motion_natural: do actors move like real vehicles/pedestrians (smooth speeds, no frozen \
actors stuck mid-road, no teleporting, no impossible accelerations, pedestrians at walking pace)?
- reactions_present: do any non-ego actors visibly REACT to others (braking behind a leader, \
queuing, yielding, lane changes), rather than ignoring everything?
- scene_coherent: does the arrangement make physical sense (nobody parked inside an obstacle, \
no vehicle driving through another, actors on plausible parts of the road)?
- overall: 0-10, "does this look like footage of real traffic?"

Answer STRICT JSON only:
{"density_plausible": n, "motion_natural": n, "reactions_present": n, "scene_coherent": n, \
"overall": n, "reason": "<one sentence>"}"""

_VISION_OK = {}


def assert_vision_or_die(model):
    """Random-colour probe via tools/gates/assert_vision. Fatal on failure, cached per model."""
    if model in _VISION_OK:
        return
    import assert_vision
    ok, detail = assert_vision.check(model=model)
    if not ok:
        raise SystemExit(f'FATAL: vision preflight failed for {model}: {detail}')
    _VISION_OK[model] = detail


def _parse_json(txt):
    s = txt.strip()
    if s.startswith('```'):
        s = s.split('```')[1]
        s = s[4:] if s[:4].lower() == 'json' else s
    start = s.find('{')
    depth = 0
    for i in range(start, len(s)):
        if s[i] == '{':
            depth += 1
        elif s[i] == '}':
            depth -= 1
            if depth == 0:
                return json.loads(s[start:i + 1])
    raise ValueError(f'no JSON object in reply: {txt[:120]!r}')


def judge_image(png_path, model=None, effort=None, retries=4, timeout=300):
    """One blind judgment. Returns dict with subscores, overall, reason, model, latency_s."""
    model = model or DEFAULT_MODEL
    effort = effort or DEFAULT_EFFORT
    assert_vision_or_die(model)
    b64 = base64.b64encode(open(png_path, 'rb').read()).decode()
    body = {
        'model': model,
        'reasoning': {'effort': effort},
        'max_output_tokens': 4000,
        'input': [{'role': 'user', 'content': [
            {'type': 'input_text', 'text': RUBRIC},
            {'type': 'input_image', 'image_url': f'data:image/png;base64,{b64}'},
        ]}],
    }
    key = os.environ.get('OPENAI_API_KEY', 'gateway')
    last = None
    for attempt in range(retries):
        t0 = time.time()
        try:
            r = httpx.post(URL, headers={'Authorization': f'Bearer {key}'}, json=body, timeout=timeout)
            if r.status_code != 200:
                raise RuntimeError(f'HTTP {r.status_code}: {r.text[:200]}')
            d = r.json()
            txt = ' '.join(c.get('text', '')
                           for it in d.get('output', []) for c in (it.get('content') or [])
                           if c.get('type') == 'output_text').strip()
            parsed = _parse_json(txt)
            for k in ('density_plausible', 'motion_natural', 'reactions_present',
                      'scene_coherent', 'overall'):
                parsed[k] = float(parsed[k])
            parsed['model'] = model
            parsed['effort'] = effort
            parsed['latency_s'] = round(time.time() - t0, 2)
            parsed['judge_version'] = JUDGE_VERSION
            usage = d.get('usage') or {}
            if usage:
                parsed['tokens'] = {'in': usage.get('input_tokens'), 'out': usage.get('output_tokens')}
            return parsed
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(2 + 4 * attempt)
    raise RuntimeError(f'judge failed after {retries} tries: {last}')
