#!/usr/bin/env python3
"""Fail loudly if the configured model cannot actually see an image.

Why this exists
---------------
The omp auth-gateway serves Anthropic models through the same /v1/responses shape the lane's
harness uses, but it SILENTLY DROPS input_image content. Measured 2026-08-15, four solid-colour
probes (red, blue, green, yellow) per model:

    gpt-5.6-luna    4/4   sees every colour
    gpt-5.6-sol     4/4   sees every colour
    gpt-5.6-terra   3/4   sees the image; names a pure-red one "orange"
    claude-opus-5   0/4   "I don't see an image" -- blind, every time
    claude-fable-5  0/4   same

Every one of those returned HTTP 200 with status=completed. Nothing in the response signals the
loss, and the blind models answer in fluent, confident prose.

That is a silent-corruption hazard for every vision path in this lane -- the blind per-scenario
judge (axes 3 and 4 score rendered rollouts) and loccritic. A vision-blind model emits confident,
plausible, entirely ungrounded verdicts and the resulting scores look perfectly normal. No
downstream metric would reveal it.

Note the two distinct failure modes, because only the first is caught by asking "did it refuse?":
terra SEES the image and misnames a colour, while the Anthropic models see nothing at all yet still
answer. A fixed-colour probe is therefore not enough -- terra replies "orange" to a red image, so a
red-only probe would call it blind, and a blue-only probe would miss the naming flaw entirely.
check() randomises the colour for exactly this reason.

So: any run that scores images MUST call this first, and MUST treat failure as fatal rather than
degrading to a text-only verdict.

Usage
-----
    python3 tools/gates/assert_vision.py                  # checks VISTA_MODEL (or the default)
    python3 tools/gates/assert_vision.py --model M ...    # checks specific models
    VISTA_MODEL=claude-opus-5 python3 tools/gates/assert_vision.py   # exits 1

Exit 0 only if every checked model reports the colour correctly.
"""
import argparse
import random
import base64
import os
import struct
import sys
import zlib

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..',
                                'research', 'edge-case-corpus', 'tools', 'vista'))

# A solid-colour PNG built in-process. Deliberately not read from disk: the check must not be able
# to pass because a stale fixture happened to be lying around.
_COLOUR = (255, 0, 0)
_EXPECT = 'red'


# A solid-colour PNG built in-process. Deliberately not read from disk: the check must not be able
# to pass because a stale fixture happened to be lying around.
PALETTE = {'red': (255, 0, 0), 'blue': (0, 0, 255), 'green': (0, 255, 0), 'yellow': (255, 255, 0)}
DEFAULT_COLOUR = 'red'


def _png(colour=DEFAULT_COLOUR, width=8, height=8):
    # Resolve the colour inside the call. Taking the RGB tuple as a default argument would bind it
    # at definition time, so changing the expected colour would silently keep emitting the old
    # image and report a false failure.
    rgb = PALETTE[colour]

    def chunk(tag, data):
        body = tag + data
        return struct.pack('>I', len(data)) + body + struct.pack('>I', zlib.crc32(body) & 0xffffffff)

    raw = b''.join(b'\x00' + bytes(rgb * width) for _ in range(height))
    return (b'\x89PNG\r\n\x1a\n'
            + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw))
            + chunk(b'IEND', b''))


def check(model=None, effort=None, colour=None):
    """Returns (ok, detail). Sees the image => ok.

    The colour is chosen at random per call unless pinned. A vision-blind model that confabulates
    one fixed answer -- gpt-5.6-terra replies 'orange' whatever it is sent -- would otherwise pass
    whenever the probe happened to use its favourite colour.
    """
    import httpx  # imported here so --help works without the venv

    url = os.environ.get('OPENAI_BASE_URL', 'https://api.openai.com/v1').rstrip('/') + '/responses'
    model = model or os.environ.get('VISTA_MODEL', 'gpt-5.6-luna')
    effort = effort or os.environ.get('VISTA_EFFORT', 'medium')
    colour = colour or random.choice(list(PALETTE))
    b64 = base64.b64encode(_png(colour)).decode()
    body = {
        'model': model,
        'reasoning': {'effort': effort},
        'input': [{'role': 'user', 'content': [
            {'type': 'input_text',
             'text': 'What single colour fills this image? Answer with one word.'},
            {'type': 'input_image', 'image_url': f'data:image/png;base64,{b64}'},
        ]}],
    }
    try:
        r = httpx.post(url, headers={'Authorization': f"Bearer {os.environ.get('OPENAI_API_KEY', 'gateway')}"},
                       json=body, timeout=180)
    except Exception as e:                                                        # noqa: BLE001
        return False, f'{type(e).__name__}: {e}'
    if r.status_code != 200:
        return False, f'HTTP {r.status_code}: {r.text[:200]}'
    d = r.json()
    txt = ' '.join(c.get('text', '')
                   for it in d.get('output', []) for c in (it.get('content') or [])
                   if c.get('type') == 'output_text').strip()
    if colour in txt.lower():
        return True, f'sees {colour} ({txt[:40]!r})'
    return False, (f'FAILED on a {colour} image -- status={d.get("status")} answered {txt[:70]!r}')


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--model', action='append', dest='models',
                    help='model to check (repeatable); default is VISTA_MODEL or gpt-5.6-luna')
    ap.add_argument('--effort', default=None)
    a = ap.parse_args()

    models = a.models or [os.environ.get('VISTA_MODEL', 'gpt-5.6-luna')]
    worst = 0
    for m in models:
        ok, detail = check(m, a.effort)
        print(f'{"PASS" if ok else "FAIL"}  {m:<26} {detail}')
        if not ok:
            worst = 1
    if worst:
        print('\nFATAL: a model that cannot see images must never score rendered rollouts.\n'
              'Keep every vision path (judge, loccritic) on an openai-codex model.', file=sys.stderr)
    return worst


if __name__ == '__main__':
    raise SystemExit(main())
