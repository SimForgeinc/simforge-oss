"""Shared LLM client for the audit. gpt-5.6-luna via the responses API."""
import base64, json, os, re, time
import httpx

URL = os.environ.get('OPENAI_BASE_URL', 'https://api.openai.com/v1').rstrip('/') + '/responses'
MODEL = 'gpt-5.6-luna'


def _key():
    k = os.environ.get('OPENAI_API_KEY')
    if not k:
        raise RuntimeError('OPENAI_API_KEY not set')
    return k


def ask(prompt, images=(), effort='medium', max_tokens=4000, retries=4):
    content = [{'type': 'input_text', 'text': prompt}]
    for p in images:
        with open(p, 'rb') as f:
            b64 = base64.b64encode(f.read()).decode()
        content.append({'type': 'input_image', 'image_url': f'data:image/png;base64,{b64}'})
    body = {'model': MODEL, 'reasoning': {'effort': effort}, 'max_output_tokens': max_tokens,
            'input': [{'role': 'user', 'content': content}]}
    last = None
    for i in range(retries):
        try:
            r = httpx.post(URL, headers={'Authorization': f'Bearer {_key()}',
                                         'Content-Type': 'application/json'},
                           json=body, timeout=300)
            if r.status_code != 200:
                last = f'HTTP {r.status_code}: {r.text[:300]}'
                time.sleep(2 + 3 * i)
                continue
            d = r.json()
            txt = ''.join(c['text'] for it in d.get('output', []) for c in it.get('content', [])
                          if c.get('type') == 'output_text')
            if not txt.strip():
                last = 'empty output'
                time.sleep(2 + 3 * i)
                continue
            return txt
        except Exception as e:                                     # noqa: BLE001
            last = str(e)
            time.sleep(2 + 3 * i)
    raise RuntimeError(f'LLM failed after {retries}: {last}')


def ask_json(prompt, images=(), **kw):
    t = ask(prompt, images, **kw)
    s = t.strip()
    s = re.sub(r'^```(?:json)?|```$', '', s, flags=re.M).strip()
    try:
        return json.loads(s), t
    except Exception:
        m = re.search(r'\{.*\}', s, re.S)
        if m:
            return json.loads(m.group(0)), t
    raise ValueError('no JSON in: ' + t[:400])
