#!/usr/bin/env python3
"""Pre-seed the showcase gallery from the best judged rethink cells."""

import argparse
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import time

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[2]
DEFAULT_ROOTS = (
    pathlib.Path('/tmp/tgr-freeform-base1/cells'),
    pathlib.Path('/tmp/tgr-emergent-pair1/cells'),
    pathlib.Path('/tmp/tgr-vista-main1/cells'),
)


def load(path):
    with open(path, encoding='utf-8') as handle:
        return json.load(handle)


def atomic_json(path, value):
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name('.%s.%d.tmp' % (path.name, os.getpid()))
    with open(temp, 'w', encoding='utf-8') as handle:
        json.dump(value, handle, indent=2)
        handle.write('\n')
    os.replace(temp, path)


def safe(value):
    return re.sub(r'[^A-Za-z0-9._-]', '-', str(value))[:180]


def review_for(cell):
    preferred = cell / 'review-gpt-5.6-sol.json'
    reviews = [preferred] if preferred.is_file() else sorted(cell.glob('review-*.json'))
    for path in reviews:
        try:
            review = load(path)
            if review.get('visionAsserted') is True:
                return review
        except (OSError, ValueError, TypeError):
            pass
    return None


def candidates(roots):
    rows = []
    for root in roots:
        if not root.is_dir():
            continue
        for cell in root.iterdir():
            if not cell.is_dir():
                continue
            required = [cell / 'instance.json', cell / 'trace.json.gz', cell / 'meta.json']
            if not all(path.is_file() for path in required):
                continue
            try:
                meta = load(cell / 'meta.json')
                review = review_for(cell)
            except (OSError, ValueError, TypeError):
                continue
            if not review:
                continue
            score = float(review.get('realism') or 0) + float(review.get('dynamism') or 0)
            rows.append({'cell': cell, 'meta': meta, 'review': review, 'score': score,
                         'gatePass': bool((meta.get('gate') or {}).get('pass'))})
    rows.sort(key=lambda row: (row['gatePass'], row['score'], float(row['review'].get('confidence') or 0)), reverse=True)
    return rows


def render(instance, trace, out):
    out.mkdir(parents=True, exist_ok=True)
    cli = ROOT / 'packages' / 'cli' / 'bin' / 'simforge.js'
    cmd = ['node', str(cli), 'render', str(trace), '--instance', str(instance), '--out', str(out),
           '--tier', '2d', '--format', 'both', '--camera', 'follow-ego', '--fps', '12']
    attempt = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=240)
    if attempt.returncode != 0:
        fallback = ['node', str(ROOT / 'scripts' / 'render-trace.mjs'),
                    '--instance', str(instance), '--trace', str(trace), '--out', str(out),
                    '--camera', 'follow-ego', '--fps', '12']
        attempt = subprocess.run(fallback, cwd=ROOT, capture_output=True, text=True, timeout=240)
    if attempt.returncode != 0:
        raise RuntimeError((attempt.stderr or attempt.stdout)[-1000:])
    videos = list(out.glob('*.mp4'))
    if not videos:
        raise RuntimeError('renderer wrote no mp4')
    rollout = out / 'rollout.mp4'
    if videos[0] != rollout:
        shutil.copyfile(videos[0], rollout)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', default=str(ROOT / 'showcase-data'))
    parser.add_argument('--limit', type=int, default=24)
    parser.add_argument('--roots', nargs='*', default=[str(path) for path in DEFAULT_ROOTS])
    parser.add_argument('--force', action='store_true')
    args = parser.parse_args()
    if args.limit < 1 or args.limit > 100:
        parser.error('--limit must be from 1 to 100')

    job = pathlib.Path(args.data_dir).resolve() / 'jobs' / 'preseed'
    cells_out = job / '40-cells'
    renders_out = job / '60-render2d'
    selected = candidates([pathlib.Path(path) for path in args.roots])[:args.limit]
    cards, failures = [], []
    started = time.monotonic()
    for index, row in enumerate(selected, 1):
        meta, review, source = row['meta'], row['review'], row['cell']
        cell_id = safe(meta.get('cellId') or source.name)
        cell_out = cells_out / cell_id
        render_out = renders_out / cell_id
        try:
            cell_out.mkdir(parents=True, exist_ok=True)
            for name in ('instance.json', 'trace.json.gz', 'meta.json'):
                target = cell_out / name
                if args.force or not target.is_file():
                    shutil.copyfile(source / name, target)
            atomic_json(cell_out / ('review-%s.json' % safe(review.get('model', 'unknown'))), review)
            if args.force or not (render_out / 'rollout.mp4').is_file():
                render(cell_out / 'instance.json', cell_out / 'trace.json.gz', render_out)
            brief_id = meta.get('briefId') or meta.get('harvestId') or cell_id
            cards.append({
                'id': 'preseed-%s' % cell_id,
                'jobId': 'preseed',
                'cellId': cell_id,
                'brief': str(brief_id),
                'engine': meta.get('stream') or 'research',
                'maps': [meta.get('map')] if meta.get('map') else [],
                'ambient': 'unknown',
                'admitted': row['gatePass'],
                'gate': meta.get('gate'),
                'scores': {'realism': review.get('realism'), 'dynamism': review.get('dynamism')},
                'judge': {'model': review.get('model'), 'effort': review.get('effort'),
                          'plausible': review.get('plausible'), 'confidence': review.get('confidence')},
                'headline': '/artifacts/jobs/preseed/60-render2d/%s/rollout.mp4' % cell_id,
                'source': str(source),
                'createdAt': '2026-08-16T00:00:00.000Z',
            })
            print('[%d/%d] %s realism=%s dynamism=%s' %
                  (index, len(selected), cell_id, review.get('realism'), review.get('dynamism')), flush=True)
        except Exception as exc:  # noqa: BLE001
            failures.append({'cellId': cell_id, 'error': str(exc)[:1000]})
            print('[%d/%d] FAIL %s: %s' % (index, len(selected), cell_id, exc), file=sys.stderr, flush=True)

    atomic_json(renders_out / 'index.json', {'cells': [{'cellId': card['cellId'], 'status': 'complete'} for card in cards]})
    atomic_json(job / '90-gallery.json', cards)
    atomic_json(job / 'preseed-summary.json', {
        'sources': [str(path) for path in args.roots],
        'candidates': len(candidates([pathlib.Path(path) for path in args.roots])),
        'selected': len(selected),
        'rendered': len(cards),
        'failures': failures,
        'wallS': round(time.monotonic() - started, 2),
    })
    print(json.dumps({'gallery': str(job / '90-gallery.json'), 'cards': len(cards), 'failures': len(failures)}))
    return 0 if cards else 1


if __name__ == '__main__':
    sys.exit(main())
