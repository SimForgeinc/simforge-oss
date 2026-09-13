#!/usr/bin/env python3
"""Render contract-§2 cell dirs to cell/render/ via scripts/render-trace.mjs.

Produces per cell (contract §2): cell/render/frames/*.png, cell/render/rollout.mp4,
cell/render/render-manifest.json (the renderer's manifest + our frame plan block).

Frame plan (deterministic, recorded): 12 times uniform across the clip UNION a
conflict-centred burst {conflictT + d : d in BURST_OFFSETS}, snapped to ticks,
deduped, ascending. conflictT = metrics.revealToConflict.conflictT, else
metrics.minTTC.t, else clip midpoint. The judge strategies (judge.py) pick frame
subsets from this plan; one render pass serves both.

Renderer flags: --redact (suppresses judge-biasing HUD text; REQUIRED for any
judge-facing render) and --dev-assets (lane/junction underlay) are EngineLane
additions; this driver passes them through and fails loudly if unsupported.

Budget: ≤4 concurrent renders (worker cap from the lane brief).
"""
import argparse
import os
import shutil
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import futil                                                               # noqa: E402

RENDERER = os.path.join(futil.REPO, 'scripts', 'render-trace.mjs')
UNIFORM_N = 12
BURST_OFFSETS = (-1.5, -1.0, -0.5, 0.0, 0.5, 1.0)
RENDER_VERSION = 'footage-render-v1'


def conflict_time(trace):
    m = trace.get('metrics') or {}
    r = (m.get('revealToConflict') or {}).get('conflictT')
    if r is not None:
        return float(r), 'revealToConflict.conflictT'
    t = (m.get('minTTC') or {}).get('t')
    if t is not None:
        return float(t), 'minTTC.t'
    ts = trace['ticks']['t']
    return float(ts[len(ts) // 2]), 'clip-midpoint'


def spawn_times(trace):
    """First-present time of every non-ego actor, +0.6 s, +1.2 s (label-blind,
    applied to every cell). VRU-in-occluder overlaps happen at spawn, never at
    conflict — a plan sampling only conflict physically hides that defect class."""
    ts = trace['ticks']['t']
    out = []
    for aid, ch in trace['ticks']['actors'].items():
        if aid == 'ego':
            continue
        first = next((i for i in range(len(ts)) if ch['present'][i]), None)
        if first is not None:
            t = float(ts[first])
            out.extend([t, t + 0.6, t + 1.2])
    return out


def frame_plan(trace):
    ts = trace['ticks']['t']
    t0, t_end = float(ts[0]), float(ts[-1])
    conflict, basis = conflict_time(trace)
    conflict = max(t0, min(t_end, conflict))
    uniform = [t0 + k * (t_end - t0) / (UNIFORM_N - 1) for k in range(UNIFORM_N)]
    burst = [max(t0, min(t_end, conflict + d)) for d in BURST_OFFSETS]
    spawns = [max(t0, min(t_end, t)) for t in spawn_times(trace)]

    def snap(t):
        # nearest tick, matching the renderer's own nearestIndex
        best, bd = ts[0], abs(ts[0] - t)
        for v in ts:
            d = abs(v - t)
            if d < bd:
                best, bd = v, d
        return round(float(best), 6)

    times = sorted({snap(t) for t in uniform + burst + spawns})
    return {'times': times, 'conflictT': conflict, 'conflictBasis': basis,
            'burstTimes': sorted({snap(t) for t in burst}),
            'spawnTimes': sorted({snap(t) for t in spawns}),
            'uniformN': UNIFORM_N, 'burstOffsets': list(BURST_OFFSETS)}


def render_cell(cell_dir, args):
    render_dir = os.path.join(cell_dir, 'render')
    manifest_path = os.path.join(render_dir, 'render-manifest.json')
    if os.path.isfile(manifest_path) and not args.force:
        return cell_dir, 'cached'
    trace_path = os.path.join(cell_dir, 'trace.json.gz')
    plan = frame_plan(futil.load_trace(trace_path))
    if os.path.isdir(render_dir):
        shutil.rmtree(render_dir)
    cmd = ['node', RENDERER,
           '--instance', os.path.join(cell_dir, 'instance.json'),
           '--trace', trace_path,
           '--out', render_dir,
           '--times', ','.join(str(t) for t in plan['times']),
           '--size', f'{args.width}x{args.height}',
           '--scale', str(args.scale), '--fps', str(args.fps),
           '--camera', args.camera]
    if args.redact:
        cmd.append('--redact')
    if args.dev_assets:
        cmd.extend(['--dev-assets', args.dev_assets])
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    if p.returncode != 0:
        raise RuntimeError(f'render failed for {cell_dir}: {p.stderr[-500:]}')
    os.replace(os.path.join(render_dir, 'trace-render.mp4'),
               os.path.join(render_dir, 'rollout.mp4'))
    man = futil.load_json(os.path.join(render_dir, 'manifest.json'))
    man['footage'] = {'renderVersion': RENDER_VERSION, 'framePlan': plan,
                      'redacted': bool(args.redact),
                      'camera': args.camera,
                      'devAssets': args.dev_assets or None,
                      'video': 'rollout.mp4'}
    futil.dump_json(manifest_path, man)
    os.remove(os.path.join(render_dir, 'manifest.json'))
    return cell_dir, 'rendered'


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('roots', nargs='+', help='cell dirs or roots containing them')
    ap.add_argument('--workers', type=int, default=4)
    ap.add_argument('--width', type=int, default=800)
    ap.add_argument('--height', type=int, default=500)
    ap.add_argument('--camera', default='follow-ego', choices=('pair', 'follow-ego'))
    ap.add_argument('--scale', type=float, default=8)
    ap.add_argument('--fps', type=int, default=4)
    ap.add_argument('--redact', action='store_true',
                    help='REQUIRED for judge-facing renders')
    ap.add_argument('--dev-assets', default=None)
    ap.add_argument('--force', action='store_true')
    args = ap.parse_args()
    args.workers = min(args.workers, 4)

    cells = []
    for r in args.roots:
        cells.extend([r] if futil.is_cell_dir(r) else futil.discover_cells(r))
    if not cells:
        raise SystemExit(f'no contract cell dirs under {args.roots}')
    ok = err = 0
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for fut in [pool.submit(render_cell, c, args) for c in cells]:
            try:
                _, status = fut.result()
                ok += 1
            except Exception as e:                                        # noqa: BLE001
                err += 1
                print(f'ERROR {e}', file=sys.stderr)
    print(f'rendered/cached {ok} cells, {err} errors, redact={args.redact}')
    return 1 if err else 0


if __name__ == '__main__':
    raise SystemExit(main())
