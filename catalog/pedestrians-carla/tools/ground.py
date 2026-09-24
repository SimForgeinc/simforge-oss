#!/usr/bin/env python3
"""Derive each walker's sole height from its posed skin, per clip.

The renderers place a walker's model origin on the ground point the simulator
gives them. That is only right if the posed soles sit at y = 0, and they do
not: the bind pose of every G2 adult sits 1-5 cm low, the clips move the hips
further, and the G2 child clips (authored on the child mesh but retargeted
against the shared adult skeleton's reference pose by animate.py) carry the
child's hips about 26 cm below its rest height, burying the feet.

For every model and clip this poses the skin exactly as glTF defines it
(node TRS, LINEAR/STEP channel sampling with slerped rotations, 4-influence
linear blend skinning) at every keyframe and every midpoint and takes the
lowest vertex of each pose. It records, in assembly-stats.json:

- `soleHeightM[clip]`: the stance sole height, the median of those per-pose
  lows. A constant lift cannot hold every pose of a gait at zero (the lows
  of one walk cycle span 3-7 cm: hips bob, and heel strike dips a few frames
  below the stance), and lifting by the single lowest pose would float the
  walker for the rest of the cycle; the median stands the typical pose on
  its soles. `bind` is the bind pose's lowest vertex.
- `soleRangeM[clip]`: the [lowest, highest] per-pose low, the clip's own
  gait spread around that stance height (evidence, and a regression bound).

finalize.py turns `soleHeightM` into the catalog grounding offsets; a model
this cannot pose fails the tool instead of getting a default.

Usage: ground.py [catalog root]   (numpy required)
"""
import json
from pathlib import Path
import struct
import sys

import numpy as np

COMPONENT = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
WIDTH = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}


def load_glb(path):
    data = path.read_bytes()
    magic, version, length = struct.unpack_from('<III', data)
    assert (magic, version, length) == (0x46546C67, 2, len(data)), path
    size, kind = struct.unpack_from('<II', data, 12)
    assert kind == 0x4E4F534A
    doc = json.loads(data[20:20 + size])
    n, kind = struct.unpack_from('<II', data, 20 + size)
    assert kind == 0x004E4942
    return doc, data[28 + size:28 + size + n]


class Skin:
    def __init__(self, path):
        self.path = path
        self.doc, self.bin = load_glb(path)
        doc = self.doc
        self.parent = {c: i for i, n in enumerate(doc['nodes']) for c in n.get('children', [])}
        self.animations = {a.get('name'): a for a in doc.get('animations', [])}
        self.primitives = []
        for index, node in enumerate(doc['nodes']):
            if 'mesh' not in node:
                continue
            for primitive in doc['meshes'][node['mesh']]['primitives']:
                attributes = primitive['attributes']
                if 'JOINTS_0' not in attributes or 'skin' not in node:
                    raise SystemExit(f'{path}: mesh node {node.get("name")} is not skinned; cannot pose it')
                self.primitives.append((
                    node['skin'],
                    self.accessor(attributes['POSITION']),
                    self.accessor(attributes['JOINTS_0']).astype(np.int64),
                    self.accessor(attributes['WEIGHTS_0']),
                ))
        if not self.primitives:
            raise SystemExit(f'{path}: no mesh geometry to pose')
        self.inverse_binds = [
            self.accessor(skin['inverseBindMatrices']).reshape(-1, 4, 4).transpose(0, 2, 1)
            for skin in doc['skins']
        ]
        self.cache = {}

    def accessor(self, index):
        a = self.doc['accessors'][index]
        view = self.doc['bufferViews'][a['bufferView']]
        dtype = np.dtype(COMPONENT[a['componentType']])
        width = WIDTH[a['type']]
        start = view.get('byteOffset', 0) + a.get('byteOffset', 0)
        stride = view.get('byteStride') or dtype.itemsize * width
        count = a['count']
        rows = np.ndarray((count, width), dtype=dtype, buffer=self.bin, offset=start,
                          strides=(stride, dtype.itemsize))
        out = rows.astype(np.float64)
        if a.get('normalized'):
            out /= float(np.iinfo(dtype).max)
        return out

    def channels(self, clip):
        if clip not in self.cache:
            animation = self.animations[clip]
            channels = []
            for channel in animation['channels']:
                target = channel['target']
                if target['path'] not in ('translation', 'rotation', 'scale') or 'node' not in target:
                    continue
                sampler = animation['samplers'][channel['sampler']]
                interpolation = sampler.get('interpolation', 'LINEAR')
                times = self.accessor(sampler['input'])[:, 0]
                values = self.accessor(sampler['output'])
                if interpolation == 'CUBICSPLINE':
                    values = values.reshape(len(times), 3, -1)[:, 1]
                channels.append((target['node'], target['path'], times, values, interpolation))
            self.cache[clip] = channels
        return self.cache[clip]

    def times(self, clip):
        """Every keyframe of the clip and every midpoint between them."""
        keys = np.unique(np.concatenate([times for _, _, times, _, _ in self.channels(clip)]))
        return np.unique(np.concatenate([keys, (keys[:-1] + keys[1:]) / 2]))

    def local_matrices(self, clip, time_s):
        trs = []
        for node in self.doc['nodes']:
            if 'matrix' in node:
                trs.append(np.array(node['matrix'], dtype=np.float64).reshape(4, 4).T)
            else:
                trs.append([np.array(node.get('translation', [0, 0, 0]), dtype=np.float64),
                            np.array(node.get('rotation', [0, 0, 0, 1]), dtype=np.float64),
                            np.array(node.get('scale', [1, 1, 1]), dtype=np.float64)])
        if clip is not None:
            for node, path, times, values, interpolation in self.channels(clip):
                if not isinstance(trs[node], list):
                    raise SystemExit(f'{self.path}: clip {clip} animates matrix node {node}')
                t = min(max(time_s, times[0]), times[-1])
                k = min(max(int(np.searchsorted(times, t, side='right')) - 1, 0), len(times) - 1)
                if interpolation == 'STEP' or k + 1 == len(times) or times[k + 1] <= times[k]:
                    value = values[k]
                else:
                    f = (t - times[k]) / (times[k + 1] - times[k])
                    value = slerp(values[k], values[k + 1], f) if path == 'rotation' else values[k] * (1 - f) + values[k + 1] * f
                trs[node][('translation', 'rotation', 'scale').index(path)] = value
        return [m if not isinstance(m, list) else compose(*m) for m in trs]

    def lowest(self, clip=None, time_s=0.0):
        local = self.local_matrices(clip, time_s)
        world = [None] * len(local)

        def resolve(i):
            if world[i] is None:
                world[i] = local[i] if i not in self.parent else resolve(self.parent[i]) @ local[i]
            return world[i]

        low = np.inf
        for skin, positions, joints, weights in self.primitives:
            palette = np.stack([resolve(j) for j in self.doc['skins'][skin]['joints']]) @ self.inverse_binds[skin]
            # Only the posed height is needed: row 1 of each joint matrix.
            rows = palette[:, 1, :]
            homogeneous = np.c_[positions, np.ones(len(positions))]
            y = np.zeros(len(positions))
            for k in range(4):
                y += weights[:, k] * np.einsum('ij,ij->i', rows[joints[:, k]], homogeneous)
            low = min(low, float(y.min()))
        return low


def compose(t, r, s):
    x, y, z, w = r / np.linalg.norm(r)
    m = np.eye(4)
    m[:3, :3] = np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ]) * s[None, :]
    m[:3, 3] = t
    return m


def slerp(a, b, f):
    a = a / np.linalg.norm(a)
    b = b / np.linalg.norm(b)
    d = float(np.dot(a, b))
    if d < 0:
        b, d = -b, -d
    if d > 0.9995:
        q = a + f * (b - a)
        return q / np.linalg.norm(q)
    theta = np.arccos(d)
    return (np.sin((1 - f) * theta) * a + np.sin(f * theta) * b) / np.sin(theta)


def sole_heights(path, clips):
    skin = Skin(path)
    heights = {'bind': round(skin.lowest(), 4) + 0.0}
    ranges = {}
    for clip in clips:
        if clip not in skin.animations:
            raise SystemExit(f'{path}: declared clip {clip} is not in the GLB')
        lows = np.array([skin.lowest(clip, float(t)) for t in skin.times(clip)])
        heights[clip] = round(float(np.median(lows)), 4) + 0.0
        ranges[clip] = [round(float(lows.min()), 4) + 0.0, round(float(lows.max()), 4) + 0.0]
    return heights, ranges


def main():
    root = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent)
    stats_path = root / 'assembly-stats.json'
    stats = json.loads(stats_path.read_text())
    for blueprint, entry in sorted(stats.items()):
        clips = sorted(entry.get('clips', {}))
        entry['soleHeightM'], entry['soleRangeM'] = sole_heights(root / entry['file'], clips)
        print(blueprint, json.dumps(entry['soleHeightM'], sort_keys=True), json.dumps(entry['soleRangeM'], sort_keys=True), flush=True)
    stats_path.write_text(json.dumps(stats, indent=2, sort_keys=True) + '\n')


if __name__ == '__main__':
    main()
