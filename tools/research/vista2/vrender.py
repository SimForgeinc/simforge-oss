"""VISTA2 rendering + semantic ground truth.

Reuses the PROVEN primitives from research/edge-case-corpus/tools/vista/render.py
(topology loader, station, pixel<->world transform, nearest-lane projection) and adds
what the authoring game needs on top:

  - render_view(): a generic top-down render of any region with actor OBBs, heading
    noses, an optional route highlight and an optional motion trail. Every render
    returns the view dict that world_from_pixel() inverts, so any pixel the agent
    names in ANY frame maps back to world coordinates losslessly.
  - semantic_at(): ground-truth surface query from the topology index (NOT a colour
    sample): drivable / sidewalk / shoulder / parking / junction / off_road, plus the
    lane, width, speed limit and local travel heading.
  - actors_from_instance() / actors_from_trace(): the two scene-state sources.
    Instance poses are (x, z) with z = -y and headings already in the trace frame
    (verified empirically on a live cell, see REPORT.md).
  - keyframe_indices(): which ticks of a rollout to show (t=0, closest approach,
    even coverage).

Frames are re-rendered from stored scene state, never upscaled from PNGs, so
"lossless memory" means exactly that.
"""
import gzip, json, math, os, sys

_HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(_HERE, '..', '..', '..'))
sys.path.insert(0, os.path.join(ROOT, 'research', 'edge-case-corpus', 'tools', 'vista'))

os.environ.pop('MPLBACKEND', None)
import matplotlib; matplotlib.use('Agg')  # noqa: E402
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.patches import Polygon as MPoly  # noqa: E402

import render as base  # the proven renderer  # noqa: E402

topo = base.topo
station = base.station
world_from_pixel = base.world_from_pixel
nearest_lane = base.nearest_lane

DEV_ASSETS = os.path.join(ROOT, 'dev-assets')

LANE_COLORS = {'driving': '#5a5a5a', 'sidewalk': '#3d4a3d', 'shoulder': '#4a4436',
               'parking': '#454055'}
JUNCTION_COLOR = '#6b5a45'
ACTOR_COLORS = {'ego': '#2e86de'}
CHALLENGER_PALETTE = ['#c0392b', '#8e44ad', '#d35400', '#16a085', '#c2185b', '#7f8c8d']


def actor_color(aid, order):
    if aid in ACTOR_COLORS:
        return ACTOR_COLORS[aid]
    return CHALLENGER_PALETTE[order % len(CHALLENGER_PALETTE)]


def _corners(x, y, hd, l, w):
    c, s = math.cos(hd), math.sin(hd)
    hl, hw = l / 2.0, w / 2.0
    return [(x + c * dx - s * dy, y + s * dx + c * dy)
            for dx, dy in ((hl, hw), (hl, -hw), (-hl, -hw), (-hl, hw))]


def render_view(mapid, center, span_m, out, px=768, actors=None, route_pl=None,
                trails=None, marks=None, title='', grid_m=None):
    """Generic top-down render. Returns the view dict (world_from_pixel-compatible).

    actors: [{id,x,y,headingRad,l,w,color,label,speedMps?}]
    route_pl: [(x,y), ...] highlighted reference route
    trails: {actorId: [(x,y), ...]} thin motion history lines
    marks: [{x,y,label,color}] point markers
    """
    cx, cy = center
    span_m = max(12, int(round(span_m)))
    if grid_m is None:
        grid_m = 10 if span_m <= 120 else 25
    LNS = topo(DEV_ASSETS, mapid)['lanes']
    fig, ax = plt.subplots(figsize=(px / 100, px / 100), dpi=100)
    ax.set_facecolor('#1a1a1a')
    for ln in LNS.values():
        p = ln.get('polyline') or []
        if not p:
            continue
        xs = [q['x'] for q in p]; ys = [q['y'] for q in p]
        if max(xs) < cx - span_m or min(xs) > cx + span_m \
           or max(ys) < cy - span_m or min(ys) > cy + span_m:
            continue
        w = ln.get('representativeWidthM') or 3.5
        col = JUNCTION_COLOR if ln.get('isJunction') else LANE_COLORS.get(ln.get('laneType'), '#2e2e2e')
        ax.plot(xs, ys, color=col, linewidth=max(1.0, w * px / (2 * span_m) * 0.92),
                solid_capstyle='round', zorder=1)
    if route_pl:
        ax.plot([q[0] for q in route_pl], [q[1] for q in route_pl],
                color='#d8b45a', linewidth=1.8, zorder=3, alpha=0.95)
    for aid, tr in (trails or {}).items():
        if len(tr) > 1:
            ax.plot([q[0] for q in tr], [q[1] for q in tr],
                    color='white', linewidth=0.8, alpha=0.55, zorder=4)
    for a in (actors or []):
        cs = _corners(a['x'], a['y'], a['headingRad'], a['l'], a['w'])
        ax.add_patch(MPoly(cs, closed=True, facecolor=a.get('color', '#c0392b'),
                           edgecolor='white', linewidth=1.2, zorder=5))
        # heading nose: centre -> front-mid
        fx = (cs[0][0] + cs[1][0]) / 2; fy = (cs[0][1] + cs[1][1]) / 2
        ax.plot([a['x'], fx], [a['y'], fy], color='white', linewidth=1.6, zorder=6)
        lbl = a.get('label', a.get('id', '?'))
        if a.get('speedMps') is not None:
            lbl += ' %.0fkm/h' % (a['speedMps'] * 3.6)
        ax.text(a['x'], a['y'] + max(1.2, a['w']), lbl, color='white', fontsize=9,
                ha='center', va='bottom', zorder=7, weight='bold')
    for m in (marks or []):
        ax.scatter([m['x']], [m['y']], s=60, marker='x', c=m.get('color', '#f1c40f'), zorder=8)
        if m.get('label'):
            ax.text(m['x'] + 1, m['y'] + 1, m['label'], color=m.get('color', '#f1c40f'),
                    fontsize=8, zorder=8)
    for g in range(-((span_m // grid_m) * grid_m), span_m + 1, grid_m):
        ax.axvline(cx + g, color='#fff', alpha=0.10, linewidth=0.5, zorder=0)
        ax.axhline(cy + g, color='#fff', alpha=0.10, linewidth=0.5, zorder=0)
    ax.set_xlim(cx - span_m, cx + span_m); ax.set_ylim(cy - span_m, cy + span_m)
    ax.set_aspect('equal'); ax.set_xticks([]); ax.set_yticks([])
    ax.set_title('%s | view %dm across, grid %dm %s' % (mapid, 2 * span_m, grid_m, title),
                 color='white', fontsize=10)
    fig.patch.set_facecolor('#1a1a1a'); fig.tight_layout()
    fig.savefig(out, facecolor='#1a1a1a'); plt.close(fig)
    return {'out': out, 'center': (cx, cy), 'span': span_m, 'px': px, 'map': mapid}


def lanes_at(mapid, x, y):
    """Every lane record near the point, with per-lane distance/heading.
    Sorted by depth-inside score (distToCentre / halfwidth)."""
    hits = []
    for rsl, ln in topo(DEV_ASSETS, mapid)['lanes'].items():
        pl = ln.get('polyline') or []
        w = ln.get('representativeWidthM') or 3.5
        best = None
        acc = 0.0
        for a, b in zip(pl, pl[1:]):
            seg = math.hypot(b['x'] - a['x'], b['y'] - a['y'])
            if seg < 1e-9:
                continue
            t = max(0.0, min(1.0, ((x - a['x']) * (b['x'] - a['x'])
                                   + (y - a['y']) * (b['y'] - a['y'])) / seg ** 2))
            qx = a['x'] + t * (b['x'] - a['x']); qy = a['y'] + t * (b['y'] - a['y'])
            d = math.hypot(x - qx, y - qy)
            if best is None or d < best[0]:
                hd = math.atan2(b['y'] - a['y'], b['x'] - a['x'])
                best = (d, acc + t * seg, hd)
            acc += seg
        if best is None:
            continue
        d, s, hd = best
        hits.append({'score': d / max(w / 2.0, 0.1), 'rsl': rsl,
                     'laneType': ln.get('laneType'),
                     'isJunction': bool(ln.get('isJunction')), 'widthM': w,
                     'distToCentreM': round(d, 2), 's': round(s, 2),
                     'speedLimitKph': ln.get('speedLimitKph'),
                     'travelHeadingDeg': round(math.degrees(hd), 1)})
    hits.sort(key=lambda h: h['score'])
    return hits


def semantic_at(mapid, x, y, route_heading_deg=None):
    """Ground truth at a world point, from the topology index (never a colour sample).

    When several lanes overlap (junction interiors), `route_heading_deg` breaks the
    tie toward the best-aligned lane so travel-direction facts are meaningful."""
    hits = lanes_at(mapid, x, y)
    if not hits:
        return {'surface': 'off_road'}
    containing = [h for h in hits if h['distToCentreM'] <= h['widthM'] / 2.0 + 0.25]
    best = hits[0]
    if containing:
        if route_heading_deg is not None:
            def align(h):
                return abs((h['travelHeadingDeg'] - route_heading_deg + 180) % 360 - 180)
            driving = [h for h in containing if h['laneType'] == 'driving']
            best = min(driving or containing, key=align)
        else:
            best = containing[0]
        surface = 'junction' if best['isJunction'] else \
            {'driving': 'drivable', 'sidewalk': 'sidewalk', 'shoulder': 'shoulder',
             'parking': 'parking'}.get(best['laneType'], best['laneType'])
    else:
        surface = 'off_road'
    return {'surface': surface, 'nearestLane': best['rsl'], 'laneType': best['laneType'],
            'laneWidthM': best['widthM'], 'distToLaneCentreM': best['distToCentreM'],
            'speedLimitKph': best['speedLimitKph'],
            'laneTravelHeadingDeg': best['travelHeadingDeg'],
            'overlappingLanes': len(containing)}


def actors_from_instance(instance):
    """Instance -> render actor dicts. Instance pose is (x, z) with z = -y; headings
    are already in the trace/topology frame (verified on a live cell)."""
    out = []
    for a in instance['input']['actors']:
        p = a['initial']['pose']
        d = a.get('dims') or {}
        out.append({'id': a['id'], 'x': p['x'], 'y': -p['z'], 'headingRad': p['headingRad'],
                    'l': d.get('l', 1.0), 'w': d.get('w', 0.6),
                    'speedMps': a['initial'].get('speedMps'), 'kind': a.get('kind')})
    for pr in instance['input'].get('props') or []:
        p = pr.get('pose') or {}
        if 'x' not in p:
            continue
        d = pr.get('dims') or {}
        out.append({'id': pr.get('id', 'prop'), 'x': p['x'], 'y': -p['z'],
                    'headingRad': p.get('headingRad', 0.0),
                    'l': d.get('l', 1.0), 'w': d.get('w', 1.0), 'kind': 'prop'})
    return out


def load_trace(path):
    with gzip.open(path) as f:
        return json.loads(f.read())


def actors_from_trace(trace, idx):
    meta = trace['header'].get('actorMetadata', {})
    ambient = set(trace['header'].get('ambientActorIds') or [])
    out = []
    for aid, tr in trace['ticks']['actors'].items():
        if not tr['present'][idx]:
            continue
        d = (meta.get(aid, {}) or {}).get('dims', {}) or {}
        out.append({'id': aid, 'x': tr['x'][idx], 'y': tr['y'][idx],
                    'headingRad': tr['headingRad'][idx],
                    'l': d.get('l', 0.6), 'w': d.get('w', 0.6),
                    'speedMps': tr['speedMps'][idx],
                    'ambient': aid in ambient})
    return out


def keyframe_indices(trace, closest_t=None, n_even=4):
    """Tick indices to render: t=0, n_even evenly spaced, the closest-approach tick."""
    ts = trace['ticks']['t']
    n = len(ts)
    idxs = {0, n - 1}
    for k in range(1, n_even):
        idxs.add(round(k * (n - 1) / n_even))
    if closest_t is not None:
        j = min(range(n), key=lambda i: abs(ts[i] - closest_t))
        idxs.add(j)
    return sorted(idxs)


def scene_bbox(trace, pad=18.0):
    """Fixed view covering every non-ambient actor's whole track (comparable keyframes)."""
    ambient = set(trace['header'].get('ambientActorIds') or [])
    xs, ys = [], []
    for aid, tr in trace['ticks']['actors'].items():
        if aid in ambient:
            continue
        xs += [v for v, p in zip(tr['x'], tr['present']) if p]
        ys += [v for v, p in zip(tr['y'], tr['present']) if p]
    if not xs:
        return None
    cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
    span = max(40.0, (max(xs) - min(xs)) / 2 + pad, (max(ys) - min(ys)) / 2 + pad)
    return (cx, cy), min(span, 220.0)


def render_keyframe(trace, idx, out, view=None, px=768):
    ts = trace['ticks']['t']
    if view is None:
        center, span = scene_bbox(trace)
    else:
        center, span = view
    actors = []
    trails = {}
    order = 0
    for a in actors_from_trace(trace, idx):
        a['color'] = '#666666' if a.pop('ambient', False) else actor_color(a['id'], order)
        if a['color'] != '#666666':
            order += 1
        actors.append(a)
        tr = trace['ticks']['actors'][a['id']]
        trails[a['id']] = [(x, y) for x, y, p in
                           zip(tr['x'][:idx + 1], tr['y'][:idx + 1], tr['present'][:idx + 1]) if p]
    return render_view(trace['header']['mapId'], center, span, out, px=px,
                       actors=actors, trails=trails,
                       title='| t=%.1fs' % ts[idx])
