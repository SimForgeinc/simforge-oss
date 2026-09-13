"""Anonymized map-context filmstrip renderer for the vision judge. Stream B, tg-rethink.

Why not scripts/render-trace.mjs for the JUDGE path: that renderer stamps actor ids
("ambient:v1:<hash>", an "actors=..." header) onto every frame, which un-blinds a judge
in one glance, and it draws no road context. This one draws the map's lane geometry
(from dev-assets topology-index, same source as the vista renderer) plus unlabelled
actor footprints. The only text is the frame timestamp.

Colour code (kind-based, arm-independent, judge is told it):
  ego = blue box, cars/trucks/buses = green box, motorcycles = light green,
  pedestrians = red disc, cyclists = orange, static-authored actors = amber,
  occluder props = dashed brown. Camera fixed across all panels.
"""
import gzip
import json
import math
import os

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.patches import Circle, Polygon as MPoly  # noqa: E402

REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..'))
DEV_ASSETS = os.path.join(REPO, 'dev-assets')

LANE_COLORS = {'driving': '#5a5a5a', 'sidewalk': '#3d4a3d', 'shoulder': '#4a4436', 'parking': '#454055'}
JUNCTION_COLOR = '#6b5a45'
KIND_COLORS = {'car': '#84d65a', 'truck': '#84d65a', 'bus': '#5ad6b8', 'motorcycle': '#b8d65a',
               'cyclist': '#e67e22', 'bicycle': '#e67e22'}
_TOPO_CACHE = {}

N_FRAMES = 8
PANEL_PX = 420
TRAIL_S = 2.0


def _topo(map_id):
    if map_id not in _TOPO_CACHE:
        path = os.path.join(DEV_ASSETS, map_id, 'topology-index.json.gz')
        _TOPO_CACHE[map_id] = json.loads(gzip.open(path).read())
    return _TOPO_CACHE[map_id]


def _corners(x, y, hd, l, w):
    c, s = math.cos(hd), math.sin(hd)
    hl, hw = l / 2.0, w / 2.0
    return [(x + c * dx - s * dy, y + s * dx + c * dy)
            for dx, dy in ((hl, hw), (hl, -hw), (-hl, -hw), (-hl, hw))]


def _camera(trace):
    """Fixed ego-centric camera: judge density/motion where the footage would be shot.
    Half-span covers the ego trajectory (padded), clamped to [50, 80] m so actors stay
    readable; falls back to the union of all actors when there is no ego."""
    actors = trace['ticks']['actors']
    src = [actors['ego']] if 'ego' in actors else list(actors.values())
    xs, ys = [], []
    for a in src:
        xs.extend(x for x, p in zip(a['x'], a['present']) if p)
        ys.extend(y for y, p in zip(a['y'], a['present']) if p)
    cx, cy = (min(xs) + max(xs)) / 2.0, (min(ys) + max(ys)) / 2.0
    span = max((max(xs) - min(xs)) / 2.0, (max(ys) - min(ys)) / 2.0) + 20.0
    return cx, cy, min(max(span, 50.0), 80.0)


def _occluder_boxes(instance):
    out = []
    for occ in (instance or {}).get('input', {}).get('occluders') or []:
        obb = occ.get('obb') or {}
        c = obb.get('center') or {}
        if 'x' in c:
            out.append(_corners(c['x'], -c.get('z', 0.0), obb.get('headingRad', 0.0),
                                obb.get('lengthM', 1.0), obb.get('widthM', 1.0)))
    return out


def render_filmstrip(trace, instance, out_png, n_frames=N_FRAMES):
    hdr = trace['header']
    ticks = trace['ticks']
    ts = ticks['t']
    n = len(ts)
    meta = hdr.get('actorMetadata', {})
    dt = hdr.get('dt', 0.02)
    cx, cy, span = _camera(trace)
    lanes = _topo(hdr['mapId'])['lanes']
    occs = _occluder_boxes(instance)
    idxs = [round(i * (n - 1) / (n_frames - 1)) for i in range(n_frames)]

    rows, cols = 2, (n_frames + 1) // 2
    fig, axes = plt.subplots(rows, cols, figsize=(cols * PANEL_PX / 100.0, rows * PANEL_PX / 100.0), dpi=100)
    fig.patch.set_facecolor('#1a1a1a')

    for panel, idx in enumerate(idxs):
        ax = axes[panel // cols][panel % cols]
        ax.set_facecolor('#1a1a1a')
        # junction ribbons first, then surface lanes on top, so intersections read as
        # crossings rather than blobs; linewidth is in POINTS (72/inch at dpi=100).
        pt_per_m = PANEL_PX * 0.72 / (2.0 * span)
        for junction_pass in (True, False):
            for ln in lanes.values():
                if bool(ln.get('isJunction')) != junction_pass:
                    continue
                pl = ln.get('polyline') or []
                if not pl:
                    continue
                lx = [q['x'] for q in pl]
                ly = [q['y'] for q in pl]
                if max(lx) < cx - span or min(lx) > cx + span or max(ly) < cy - span or min(ly) > cy + span:
                    continue
                w = ln.get('representativeWidthM') or 3.5
                col = JUNCTION_COLOR if junction_pass else LANE_COLORS.get(ln.get('laneType'), '#2e2e2e')
                ax.plot(lx, ly, color=col, linewidth=max(0.6, w * pt_per_m * 0.9),
                        solid_capstyle='round', zorder=1 if junction_pass else 2)
        for box in occs:
            ax.add_patch(MPoly(box, closed=True, facecolor='#9b6b2f', alpha=0.5,
                               edgecolor='#ffc166', linestyle='--', linewidth=1.0, zorder=4))
        trail_ticks = int(TRAIL_S / dt)
        for aid, a in ticks['actors'].items():
            if not a['present'][idx]:
                continue
            m = meta.get(aid, {})
            kind = m.get('kind', 'car')
            dims = m.get('dims', {})
            static = bool(m.get('static'))
            if aid == 'ego':
                color = '#45a3ff'
            elif static:
                color = '#ffc166'
            elif kind == 'pedestrian':
                color = '#ff5a5f'
            else:
                color = KIND_COLORS.get(kind, '#84d65a')
            tp = [(a['x'][i], a['y'][i]) for i in range(max(0, idx - trail_ticks), idx + 1, 5)
                  if a['present'][i]]
            if len(tp) > 1:
                ax.plot([p[0] for p in tp], [p[1] for p in tp], color=color, linewidth=1.0,
                        alpha=0.55, zorder=3)
            x, y, hd = a['x'][idx], a['y'][idx], a['headingRad'][idx]
            if kind == 'pedestrian':
                ax.add_patch(Circle((x, y), max(0.5, dims.get('w', 0.6) / 2.0), facecolor=color,
                                    edgecolor='white', linewidth=0.8, zorder=5))
            else:
                box = _corners(x, y, hd, dims.get('l', 4.6), dims.get('w', 1.9))
                ax.add_patch(MPoly(box, closed=True, facecolor=color, edgecolor='white',
                                   linewidth=0.8, zorder=5))
        ax.set_xlim(cx - span, cx + span)
        ax.set_ylim(cy - span, cy + span)
        ax.set_aspect('equal')
        ax.set_xticks([])
        ax.set_yticks([])
        ax.set_title(f't={ts[idx]:.1f}s', color='white', fontsize=9, pad=2)
    for k in range(len(idxs), rows * cols):
        axes[k // cols][k % cols].axis('off')
    fig.tight_layout(pad=0.4)
    fig.savefig(out_png, facecolor='#1a1a1a')
    plt.close(fig)
    return out_png
