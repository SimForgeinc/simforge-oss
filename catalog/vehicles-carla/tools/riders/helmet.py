"""Procedural motorcycle helmet fitted around a posed rider head.

CARLA's rider pedestrians carry no helmet and CARLA ships no helmet asset, so
this shell is SimForge-authored geometry (same licence as the rest of the
pack; see ATTRIBUTION.json). The shell is a smooth closed-cell surface fitted
to the head's skinned vertices with a fixed margin: `full` has a chin bar and
a dark visor across the eye port, `open` is a 3/4 shell ending above the brow
with a short peak.
"""
import math

import numpy as np

from rider_ik import norm

N_THETA = 40
N_PHI = 72


def _smooth(a, b, t):
    t = min(1.0, max(0.0, t))
    t = t * t * (3 - 2 * t)
    return a + (b - a) * t


def _lower_edge(style, phi):
    """Polar angle (from the crown) where the shell ends, by azimuth."""
    back = 1 - (1 + math.cos(phi)) / 2  # 0 at the front, 1 at the back
    if style == 'full':
        return math.radians(_smooth(146.0, 124.0, back))
    return math.radians(_smooth(84.0, 126.0, min(1.0, back * 1.9)))


def _is_visor(style, theta, phi):
    return style == 'full' and abs(phi) < math.radians(72) and math.radians(74) < theta < math.radians(107)


def build(doc, binary, head_vertices, head_world, style):
    import gltf_io
    assert style in ('full', 'open')
    # Head frame: forward/up from the posed head joint; the joint's rest axes
    # are not anatomical, so derive them from the vertex cloud orientation.
    forward = np.array([1.0, 0.0, 0.0])
    up = np.array([0.0, 1.0, 0.0])
    right = np.cross(forward, up)
    basis = np.column_stack([forward, up, right])
    local = (head_vertices - head_vertices.mean(axis=0)) @ basis
    lo, hi = local.min(axis=0), local.max(axis=0)
    centre = head_vertices.mean(axis=0) + basis @ ((lo + hi) / 2)
    half = (hi - lo) / 2
    # Shell radii: cranium + padding. Up is measured from the centre to the crown.
    a = half[0] + 0.040
    c = half[2] + 0.034
    b = half[1] + 0.028
    centre = centre + up * 0.018
    positions, normals, uvs, visor = [], [], [], []
    for i in range(N_THETA + 1):
        for j in range(N_PHI):
            phi = -math.pi + 2 * math.pi * j / N_PHI
            edge = _lower_edge(style, phi)
            theta = edge * i / N_THETA
            s = math.sin(theta)
            d = np.array([s * math.cos(phi), math.cos(theta), s * math.sin(phi)])
            p, n = _shell_point(style, d, theta, phi, a, b, c)
            positions.append(centre + basis @ p)
            normals.append(basis @ n)
            uvs.append([j / N_PHI, i / N_THETA])
            visor.append(_is_visor(style, theta, phi))
    positions = np.array(positions)
    normals = np.array(normals)
    inner_scale = 0.92
    inner = centre + (positions - centre) * inner_scale
    ring = N_PHI

    def vid(i, j):
        return i * ring + (j % ring)

    shell, glass, liner = [], [], []
    for i in range(N_THETA):
        for j in range(N_PHI):
            quad = (vid(i, j), vid(i + 1, j), vid(i + 1, j + 1), vid(i, j + 1))
            tris = [(quad[0], quad[1], quad[2]), (quad[0], quad[2], quad[3])]
            is_glass = all(visor[q] for q in quad)
            (glass if is_glass else shell).extend(tris)
    count = len(positions)
    # Liner: inner shell (reversed winding) + a rim joining the two lower edges.
    for i in range(N_THETA):
        for j in range(N_PHI):
            q = (vid(i, j) + count, vid(i + 1, j) + count, vid(i + 1, j + 1) + count, vid(i, j + 1) + count)
            liner.extend([(q[0], q[2], q[1]), (q[0], q[3], q[2])])
    bottom = N_THETA
    for j in range(N_PHI):
        o0, o1 = vid(bottom, j), vid(bottom, j + 1)
        liner.extend([(o0, o1 + count, o1), (o0, o0 + count, o1 + count)])
    all_pos = np.concatenate([positions, inner])
    all_nrm = np.concatenate([normals, -normals])
    all_uv = np.concatenate([uvs, uvs])
    # Orient every triangle outward from the shell centre (liner inward).
    def orient(tris, outward):
        out = []
        for t in tris:
            p0, p1, p2 = all_pos[list(t)]
            n = np.cross(p1 - p0, p2 - p0)
            mid = (p0 + p1 + p2) / 3 - centre
            if (np.dot(n, mid) > 0) != outward:
                t = (t[0], t[2], t[1])
            out.append(t)
        return out
    shell, glass = orient(shell, True), orient(glass, True)
    liner = orient(liner, False)
    if style == 'open':
        peak = _peak(centre, basis, a, b, c)
    # Transform into the head joint's local frame (the helmet node is its child).
    inv = np.linalg.inv(head_world)
    local_pos = all_pos @ inv[:3, :3].T + inv[:3, 3]
    local_nrm = all_nrm @ inv[:3, :3].T
    tangents = np.concatenate([_tangents(local_nrm), np.ones((len(local_nrm), 1))], axis=1)
    w = gltf_io.Writer(doc, binary)
    attrs = {
        'POSITION': w.accessor(local_pos.astype(np.float32), 'VEC3', target=34962, minmax=True),
        'NORMAL': w.accessor(local_nrm.astype(np.float32), 'VEC3', target=34962),
        'TANGENT': w.accessor(tangents.astype(np.float32), 'VEC4', target=34962),
        'TEXCOORD_0': w.accessor(all_uv.astype(np.float32), 'VEC2', target=34962),
    }
    mats = _materials(doc)
    prims = []
    for tris, mat in ((shell, 'rider_helmet'), (glass, 'rider_helmet_visor'), (liner, 'rider_helmet_liner')):
        if not tris:
            continue
        idx = w.accessor(np.array(tris, dtype=np.uint32).reshape(-1, 1), 'SCALAR', component=5125, target=34963)
        prims.append({'attributes': dict(attrs), 'indices': idx, 'material': mats[mat]})
    if style == 'open':
        ppos, pnrm, puv, ptri = peak
        ppos = ppos @ inv[:3, :3].T + inv[:3, 3]
        pnrm = pnrm @ inv[:3, :3].T
        pt = np.concatenate([_tangents(pnrm), np.ones((len(pnrm), 1))], axis=1)
        pattrs = {
            'POSITION': w.accessor(ppos.astype(np.float32), 'VEC3', target=34962, minmax=True),
            'NORMAL': w.accessor(pnrm.astype(np.float32), 'VEC3', target=34962),
            'TANGENT': w.accessor(pt.astype(np.float32), 'VEC4', target=34962),
            'TEXCOORD_0': w.accessor(puv.astype(np.float32), 'VEC2', target=34962),
        }
        idx = w.accessor(np.array(ptri, dtype=np.uint32).reshape(-1, 1), 'SCALAR', component=5125, target=34963)
        prims.append({'attributes': pattrs, 'indices': idx, 'material': mats['rider_helmet_liner']})
    for p in prims:
        # SCALAR float accessors get min/max from Writer; index accessors must not.
        doc['accessors'][p['indices']].pop('min', None)
        doc['accessors'][p['indices']].pop('max', None)
    doc['meshes'].append({'name': f'rider_helmet_{style}', 'primitives': prims})
    return len(doc['meshes']) - 1


def _shell_point(style, d, theta, phi, a, b, c):
    """Moulded shell: longer at the back, flatter crown, chin bar on full-face."""
    fwd = d[0]
    ax = a * (1.0 + 0.10 * max(0.0, -fwd))  # rounder, deeper rear
    by = b * 0.94
    radius = np.array([ax, by, c])
    p = radius * d
    if style == 'full':
        # Chin bar: push the lower front forward and down.
        front = max(0.0, math.cos(phi)) ** 2
        low = _smooth(0.0, 1.0, (theta - math.radians(100)) / math.radians(30))
        p = p + np.array([0.045, -0.015, 0.0]) * front * low
    # Normal of the (unbent) ellipsoid is a good shading normal for this smooth shell.
    n = norm(d / radius)
    return p, n


def _tangents(normals):
    ref = np.where(np.abs(normals[:, 1:2]) < 0.9, np.array([[0.0, 1.0, 0.0]]), np.array([[1.0, 0.0, 0.0]]))
    t = np.cross(ref, normals)
    return t / np.linalg.norm(t, axis=1, keepdims=True)


def _peak(centre, basis, a, b, c):
    """Short moulded peak above the brow of an open-face shell (two-sided slab)."""
    rows, cols = 6, 24
    pos, nrm, uv, tri = [], [], [], []
    edge = math.radians(84.0)
    for i in range(rows + 1):
        for j in range(cols + 1):
            phi = math.radians(-62 + 124 * j / cols)
            ext = 0.055 * math.cos(phi * 0.9) * i / rows
            s, co = math.sin(edge), math.cos(edge)
            base = np.array([a * s * math.cos(phi), b * co, c * s * math.sin(phi)])
            out = norm(np.array([math.cos(phi), 0.0, math.sin(phi)]))
            p = base + out * ext + np.array([0.0, -0.35 * ext, 0.0])
            pos.append(centre + basis @ p)
            nrm.append(basis @ norm(np.array([0.2 * math.cos(phi), 1.0, 0.2 * math.sin(phi)])))
            uv.append([j / cols, i / rows])
    n = len(pos)
    pos = np.array(pos + [p - np.array(nr) * 0.004 for p, nr in zip(pos, nrm)])
    nrm = np.array(nrm + [-np.array(v) for v in nrm])
    uv = np.array(uv + uv)
    for i in range(rows):
        for j in range(cols):
            k = i * (cols + 1) + j
            q = (k, k + cols + 1, k + cols + 2, k + 1)
            tri.extend([(q[0], q[2], q[1]), (q[0], q[3], q[2])])
            tri.extend([(q[0] + n, q[1] + n, q[2] + n), (q[0] + n, q[2] + n, q[3] + n)])
    # Top faces up.
    fixed = []
    for t in tri:
        p0, p1, p2 = pos[list(t)]
        face = np.cross(p1 - p0, p2 - p0)
        want = nrm[t[0]]
        if np.dot(face, want) < 0:
            t = (t[0], t[2], t[1])
        fixed.append(t)
    return pos, nrm, uv, fixed


def _materials(doc):
    wanted = {
        'rider_helmet': {'pbrMetallicRoughness': {'baseColorFactor': [0.30, 0.31, 0.32, 1.0], 'metallicFactor': 0.35, 'roughnessFactor': 0.28}},
        'rider_helmet_visor': {'pbrMetallicRoughness': {'baseColorFactor': [0.008, 0.010, 0.014, 1.0], 'metallicFactor': 0.8, 'roughnessFactor': 0.05}},
        'rider_helmet_liner': {'pbrMetallicRoughness': {'baseColorFactor': [0.02, 0.02, 0.02, 1.0], 'metallicFactor': 0.0, 'roughnessFactor': 0.85}},
    }
    out = {}
    for name, body in wanted.items():
        doc['materials'].append(dict(name=name, **body, extras={'source': 'SimForge procedural helmet'}))
        out[name] = len(doc['materials']) - 1
    return out
