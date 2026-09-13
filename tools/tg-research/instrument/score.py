#!/usr/bin/env python3
"""Stream B scorer CLI -- SHARED-CONTRACT interface. tg-rethink.

Usage:
    score.py CELL_DIR [CELL_DIR ...] [--judge] [--model M] [--out FILE]
    score.py --instance I.json --trace T.json.gz [--judge]

Per the shared contract, input is one cell dir (batch layout: draw-XXX.instance.json +
draw-XXX.trace.json.gz [+ draw-XXX.result.json]) or an explicit --instance/--trace pair.
Output is one JSON line per scored draw:

    {"cellDir": ..., "draw": "draw-000", "metrics": {...}, "judge": {...}|null, "version": ...}

judge is null unless --judge is given (vision path: Codex model only, assert_vision
preflight is fatal). judge = {"score": overall 0-10, "verdict": "realistic"|"unrealistic",
"model": ..., "subscores": {...}}. Verdict threshold overall >= 6.0 (pre-registered).
"""
import argparse
import glob
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'gates'))

import tg_gate  # noqa: E402
from metrics import METRICS_VERSION, compute_metrics  # noqa: E402

SCORER_VERSION = f'score-v1+{METRICS_VERSION}'
JUDGE_PASS = 6.0


def score_pair(instance_path, trace_path, do_judge=False, model=None, keep_render=None):
    trace = tg_gate.load_trace(trace_path)
    instance = None
    if instance_path and os.path.exists(instance_path):
        with open(instance_path) as f:
            instance = json.load(f)
    m = compute_metrics(trace, instance)
    judge = None
    if do_judge:
        from filmstrip import render_filmstrip  # lazy: matplotlib
        from judge import judge_image  # lazy: httpx + vision preflight
        if keep_render:
            png = keep_render
        else:
            fd, png = tempfile.mkstemp(suffix='.png', prefix='tgr-strip-')
            os.close(fd)
        try:
            render_filmstrip(trace, instance, png)
            j = judge_image(png, model=model)
            judge = {
                'score': j['overall'],
                'verdict': 'realistic' if j['overall'] >= JUDGE_PASS else 'unrealistic',
                'model': j['model'],
                'subscores': {k: j[k] for k in ('density_plausible', 'motion_natural',
                                                'reactions_present', 'scene_coherent')},
                'reason': j.get('reason'),
                'latency_s': j.get('latency_s'),
            }
        finally:
            if not keep_render and os.path.exists(png):
                os.unlink(png)
    return m, judge


def iter_cell_draws(cell_dir):
    for tp in sorted(glob.glob(os.path.join(cell_dir, 'draw-*.trace.json.gz'))):
        draw = os.path.basename(tp).split('.')[0]
        ip = os.path.join(cell_dir, f'{draw}.instance.json')
        yield draw, (ip if os.path.exists(ip) else None), tp


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('cell_dirs', nargs='*', help='batch cell dirs (draw-XXX.* layout)')
    ap.add_argument('--instance', help='explicit instance JSON')
    ap.add_argument('--trace', help='explicit trace .json.gz')
    ap.add_argument('--judge', action='store_true', help='also run the blind vision judge')
    ap.add_argument('--model', default=None, help='judge model (Codex only; default gpt-5.6-sol)')
    ap.add_argument('--out', default=None, help='append JSONL here instead of stdout')
    args = ap.parse_args()

    if not args.cell_dirs and not args.trace:
        ap.error('give cell dirs, or --instance/--trace')

    sink = open(args.out, 'a') if args.out else sys.stdout

    def emit(row):
        sink.write(json.dumps(row, separators=(',', ':')) + '\n')
        sink.flush()

    if args.trace:
        m, judge = score_pair(args.instance, args.trace, args.judge, args.model)
        emit({'cellDir': os.path.dirname(os.path.abspath(args.trace)), 'metrics': m,
              'judge': judge, 'version': SCORER_VERSION})
    for cd in args.cell_dirs:
        cd = os.path.abspath(cd)
        found = False
        for draw, ip, tp in iter_cell_draws(cd):
            found = True
            try:
                m, judge = score_pair(ip, tp, args.judge, args.model)
                emit({'cellDir': cd, 'draw': draw, 'metrics': m, 'judge': judge,
                      'version': SCORER_VERSION})
            except Exception as e:  # noqa: BLE001
                emit({'cellDir': cd, 'draw': draw, 'error': f'{type(e).__name__}: {e}',
                      'metrics': None, 'judge': None, 'version': SCORER_VERSION})
        if not found:
            emit({'cellDir': cd, 'error': 'no draw-*.trace.json.gz found',
                  'metrics': None, 'judge': None, 'version': SCORER_VERSION})
    if args.out:
        sink.close()


if __name__ == '__main__':
    main()
