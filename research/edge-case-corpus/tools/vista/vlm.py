"""Model client for the lane. Text and vision.

Default model gpt-5.6-luna at reasoning effort medium: that is W7's frozen configuration and the
one the published baselines are comparable against, so an unset environment reproduces it exactly.

VISTA_MODEL / VISTA_EFFORT override both, for the W8 model-by-effort sweep and the W9 production
arm, on the owner's explicit instruction to relax the single-model restriction.

WARNING -- vision: the omp auth-gateway serves Anthropic models through this same responses shape
but SILENTLY DROPS input_image: claude-opus-5 and claude-fable-5 answer "I don't see an image" on
0/4 colour probes while still reporting status=completed. Any vision path (the blind judge,
loccritic) must therefore stay on an openai-codex model -- luna and sol score 4/4, terra 3/4 (it
sees the image but calls pure red "orange"). Run tools/gates/assert_vision.py before trusting a
vision result on a non-default model; it exits non-zero rather than degrading silently.
"""
import os, json, base64, time
import httpx

MODEL = os.environ.get('VISTA_MODEL', 'gpt-5.6-luna')
EFFORT = os.environ.get('VISTA_EFFORT', 'medium')
URL = os.environ.get('OPENAI_BASE_URL', 'https://api.openai.com/v1').rstrip('/') + '/responses'


def _content(prompt, images):
    c = [{'type': 'input_text', 'text': prompt}]
    for p in images or []:
        b64 = base64.b64encode(open(p, 'rb').read()).decode()
        c.append({'type': 'input_image', 'image_url': f'data:image/png;base64,{b64}'})
    return c


def ask(prompt, images=None, max_tokens=12000, retries=4, timeout=300):
    """One call. Returns the concatenated output text. Raises after `retries` failures."""
    key = os.environ['OPENAI_API_KEY']
    body = {'model': MODEL, 'reasoning': {'effort': EFFORT}, 'max_output_tokens': max_tokens,
            'input': [{'role': 'user', 'content': _content(prompt, images)}]}
    last = None
    for i in range(retries):
        try:
            r = httpx.post(URL, headers={'Authorization': f'Bearer {key}'}, json=body, timeout=timeout)
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
            if txt:
                return txt
            last = f"empty output (status={d.get('status')}, incomplete={d.get('incomplete_details')})"
        except Exception as e:                                    # noqa: BLE001
            last = f'{type(e).__name__}: {e}'
        time.sleep(2 + 4 * i)
    raise RuntimeError(f'model call failed after {retries} tries: {last}')


def ask_json(prompt, images=None, **kw):
    """Ask for JSON and parse it, tolerating a stray code fence."""
    txt = ask(prompt, images, **kw)
    return parse_json(txt), txt


def parse_json(txt):
    """Parse the model's reply into JSON, tolerating fences and trailing content.

    The naive version lost whole briefs to `Extra data: line 1 column 4089`: when the model emits a
    valid object followed by anything else (a second object, a stray note), `json.loads` raises, and
    the first-brace/last-brace fallback spans BOTH values and raises again. Scan for the first
    complete JSON value instead, then keep scanning and prefer the largest object found -- the
    template is always the biggest thing in the reply.
    """
    s = txt.strip()
    if s.startswith('```'):
        s = s.split('\n', 1)[1] if '\n' in s else s
        if s.rstrip().endswith('```'):
            s = s.rstrip()[:-3]
    s = s.strip()
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        pass

    dec = json.JSONDecoder()
    best, i, n = None, 0, len(s)
    while i < n:
        c = s.find('{', i)
        if c < 0:
            break
        try:
            val, end = dec.raw_decode(s, c)
        except json.JSONDecodeError:
            i = c + 1
            continue
        if isinstance(val, dict) and (best is None or len(json.dumps(val)) > len(json.dumps(best))):
            best = val
        i = max(end, c + 1)
    if best is not None:
        return best
    raise ValueError('no JSON object found in model reply (%d chars)' % len(s))
