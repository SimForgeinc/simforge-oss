#!/usr/bin/env python3
"""Blind vision judge for rendered rollouts — Stream B, contract §3 verdicts.

Codex models only (gateway silently blinds Anthropic models to input_image; see
tools/gates/assert_vision.py). assert_vision preflight is per-model per-process,
randomized colour, fatal after retries (futil.assert_vision_session).

Blinding: the judge receives ONLY keyframe PNGs (rendered with --redact) plus the
fixed rubric. Never gate results, briefs, mechanisms, labels, filenames, or metric
values. The rubric below is frozen after the strategy pilot; its sha256 is recorded
in every verdict (_meta.promptSha256).

Strategies (frame subsets of the render_cells.py frame plan):
  spread8: 8 frames spanning the whole clip (always includes first and last).
  burst6:  the burst frames around the conflict moment (~0.5 s spacing).
The calibration pilot measures both; ONE is frozen for all measured runs.
"""
import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import futil                                                               # noqa: E402

JUDGE_VERSION = 'footage-judge-v1'
STRATEGIES = ('spread8', 'burst6')

RUBRIC = """You are reviewing a short clip from a top-down schematic traffic simulator, \
shown as {n} keyframes in time order. The timestamp stamped on each frame is simulation \
seconds. Legend: the EGO vehicle is the BLUE box; pedestrians are small RED discs; \
cyclists and scooters are ORANGE discs; animals are TAN discs; small delivery robots are \
VIOLET discs; motorcycles are narrow VIOLET boxes; other moving vehicles are GREEN boxes \
(sized to their real footprint); deliberately parked/stopped vehicles are AMBER boxes; \
fixed roadside objects (shelters, hedges, containers) are dashed brown outlines; thin \
trails show each mover's recent path. Roads, where drawn, are grey surfaces with lane lines.

Judge whether this clip reads like footage of real traffic.

1. Describe in 2-4 sentences what actually happens across the clip: who moves, who \
interacts, what the outcome is.
2. Score:
- "realism" (0-10): does this look like real traffic behaving like traffic?
- "dynamism" (0-10): how alive is the scene — motion variety, several actors doing \
things, visible interaction between road users?
- "plausible" (true/false): could this exact scene exist in the real world?
- "defects": every defect you can actually SEE in the frames, chosen from: "teleport" \
(an actor jumps position between adjacent frames far beyond its speed), "frozen_actor" \
(an actor stuck motionless where it should be moving, e.g. mid-lane), "overlap" (two \
objects occupying the same space, one inside another), "off_road" (a road user somewhere \
no road user could be), "unnatural_speed" (impossibly fast or slow motion for that actor \
type), or "other:<short description>". Empty list if none.
- "confidence" (0-1): your confidence in these scores.

Answer STRICT JSON only:
{{"description": "...", "realism": n, "dynamism": n, "plausible": true, \
"defects": [], "confidence": 0.0}}"""


def prompt_for(n_frames):
    return RUBRIC.format(n=n_frames)


PROMPT_SHA = futil.sha256_text(RUBRIC)


def select_frames(render_dir):
    """-> {strategy: [(t, pngPath)]} from render-manifest.json."""
    man = futil.load_json(os.path.join(render_dir, 'render-manifest.json'))
    frames = [(f['t'], os.path.join(render_dir, 'frames', f['png']))
              for f in man['frames']]
    frames.sort()
    plan = man['footage']['framePlan']
    burst_times = set(plan['burstTimes'])
    n = len(frames)
    idx = sorted({round(k * (n - 1) / 7) for k in range(8)}) if n > 8 else list(range(n))
    spread = [frames[i] for i in idx]
    burst = [f for f in frames if f[0] in burst_times] or spread
    return {'spread8': spread, 'burst6': burst,
            'redacted': man['footage'].get('redacted', False)}


def _norm(parsed):
    out = {
        'realism': max(0.0, min(10.0, float(parsed['realism']))),
        'dynamism': max(0.0, min(10.0, float(parsed['dynamism']))),
        'plausible': bool(parsed['plausible']),
        'mechanismObserved': str(parsed.get('description', ''))[:2000],
        'defects': [str(d) for d in (parsed.get('defects') or [])][:16],
        'confidence': max(0.0, min(1.0, float(parsed.get('confidence', 0.0)))),
    }
    return out


def judge_cell(cell_dir, model, effort, strategy, require_redacted=True, timeout=420):
    """One blind verdict. Returns a contract-§3 dict (+_meta)."""
    futil.assert_vision_session(model)
    sel = select_frames(os.path.join(cell_dir, 'render'))
    if require_redacted and not sel['redacted']:
        raise RuntimeError(f'{cell_dir}: render is NOT redacted; judge would see gate metrics')
    frames = sel[strategy]
    meta = futil.load_json(os.path.join(cell_dir, 'meta.json'))
    content = [{'type': 'input_text', 'text': prompt_for(len(frames))}]
    for _, png in frames:
        content.append({'type': 'input_image', 'image_url': futil.png_data_url(png)})
    body = {'model': model, 'reasoning': {'effort': effort},
            'max_output_tokens': 4000,
            'input': [{'role': 'user', 'content': content}]}
    resp, raw, wall = futil.responses_call(body, timeout=timeout)
    txt = futil.output_text(resp)
    parsed = _norm(futil.parse_json_block(txt))
    usage = resp.get('usage') or {}
    verdict = {
        'cellId': meta['cellId'],
        'model': model,
        'effort': effort,
        'visionAsserted': True,
        'realism': parsed['realism'],
        'plausible': parsed['plausible'],
        'dynamism': parsed['dynamism'],
        'mechanismObserved': parsed['mechanismObserved'],
        'defects': parsed['defects'],
        'confidence': parsed['confidence'],
        'rawResponseSha256': futil.sha256_text(raw),
        '_meta': {
            'judgeVersion': JUDGE_VERSION,
            'promptSha256': PROMPT_SHA,
            'strategy': strategy,
            'framesUsed': [t for t, _ in frames],
            'latencyS': round(wall, 2),
            'tokens': {'in': usage.get('input_tokens'), 'out': usage.get('output_tokens'),
                       'reasoning': (usage.get('output_tokens_details') or {}).get('reasoning_tokens')},
        },
    }
    return verdict


def write_contract_verdict(cell_dir, verdict):
    """cell/review-<model>.json per contract §3 (scaled runs; one per model)."""
    futil.dump_json(os.path.join(cell_dir, f'review-{verdict["model"]}.json'), verdict)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('cell')
    ap.add_argument('--model', default='gpt-5.6-sol')
    ap.add_argument('--effort', default='low')
    ap.add_argument('--strategy', default='spread8', choices=STRATEGIES)
    ap.add_argument('--allow-unredacted', action='store_true')
    args = ap.parse_args()
    v = judge_cell(args.cell, args.model, args.effort, args.strategy,
                   require_redacted=not args.allow_unredacted)
    print(json.dumps(v, indent=2))


if __name__ == '__main__':
    main()
