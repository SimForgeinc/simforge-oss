"""Gateway client for the freeform stream (adopted from tools/tg-research/openvocab/llm.py, prior lead session; unchanged behaviour). Text only; every call logged to the run dir.

Unlike tools/vista/vlm.py this takes model/effort per call (the effort arm needs low and
high in one process) and never reads them from the environment, so a run's model config
is exactly what its PREREG says. Request/response pairs land in <log_dir>/NNNN-<tag>.json.
"""
import json, os, re, threading, time

import httpx

BASE = os.environ.get('OPENAI_BASE_URL', 'http://127.0.0.1:4141/v1').rstrip('/')
_seq = 0
_seq_lock = threading.Lock()


def _next_seq():
    global _seq
    with _seq_lock:
        _seq += 1
        return _seq


def parse_json(txt):
    """Parse the model's reply into one JSON object, tolerating fences and prose."""
    s = txt.strip()
    fence = re.search(r'```(?:json)?\s*(\{.*?\})\s*```', s, re.S)
    if fence:
        s = fence.group(1)
    start = s.find('{')
    if start < 0:
        raise ValueError('no JSON object found in model reply (%d chars)' % len(s))
    depth, in_str, esc = 0, False, False
    for i in range(start, len(s)):
        c = s[i]
        if in_str:
            if esc:
                esc = False
            elif c == '\\':
                esc = True
            elif c == '"':
                in_str = False
            continue
        if c == '"':
            in_str = True
        elif c == '{':
            depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0:
                return json.loads(s[start:i + 1])
    raise ValueError('unbalanced JSON object in model reply (%d chars)' % len(s))


def ask(prompt, model, effort, log_dir=None, tag='call', max_tokens=45000, retries=4,
        timeout=600):
    """One /v1/responses call. Returns (text, usage). Raises after `retries` failures."""
    key = os.environ.get('OPENAI_API_KEY', 'local')
    body = {'model': model, 'reasoning': {'effort': effort},
            'max_output_tokens': max_tokens,
            'input': [{'role': 'user',
                       'content': [{'type': 'input_text', 'text': prompt}]}]}
    last = None
    for i in range(retries):
        rec = {'t': time.time(), 'model': model, 'effort': effort, 'tag': tag,
               'attempt': i, 'prompt': prompt}
        try:
            r = httpx.post(BASE + '/responses', json=body, timeout=timeout,
                           headers={'authorization': 'Bearer %s' % key})
            r.raise_for_status()
            d = r.json()
            parts = []
            for item in d.get('output') or []:
                if item.get('type') == 'message':
                    for c in item.get('content') or []:
                        if c.get('type') == 'output_text':
                            parts.append(c.get('text') or '')
            text = ''.join(parts)
            usage = d.get('usage') or {}
            rec.update({'response': text, 'usage': usage,
                        'status': d.get('status'), 'ok': bool(text)})
            if log_dir:
                path = os.path.join(log_dir, '%04d-%s.json' % (_next_seq(), tag))
                json.dump(rec, open(path, 'w'), indent=1)
            if not text:
                last = 'empty output (status=%s)' % d.get('status')
                continue
            return text, usage
        except Exception as e:                                             # noqa: BLE001
            last = str(e)[:300]
            rec.update({'error': last})
            if log_dir:
                path = os.path.join(log_dir, '%04d-%s.json' % (_next_seq(), tag))
                json.dump(rec, open(path, 'w'), indent=1)
            time.sleep(2 + 4 * i)
    raise RuntimeError('model call failed after %d tries: %s' % (retries, last))


def ask_json(prompt, model, effort, **kw):
    text, usage = ask(prompt, model, effort, **kw)
    return parse_json(text), usage
