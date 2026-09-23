"""Minimal GLB read/write/merge helpers (python3 + numpy only)."""
import json
import struct

import numpy as np

COMPONENT = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
WIDTH = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}


def load_glb(path):
    data = open(path, 'rb').read()
    magic, version, length = struct.unpack_from('<III', data)
    assert magic == 0x46546C67 and version == 2 and length == len(data), path
    size, kind = struct.unpack_from('<II', data, 12)
    assert kind == 0x4E4F534A
    doc = json.loads(data[20:20 + size])
    n, kind = struct.unpack_from('<II', data, 20 + size)
    assert kind == 0x004E4942
    return doc, bytearray(data[28 + size:28 + size + n])


def save_glb(doc, binary):
    binary = bytes(binary) + b'\0' * (-len(binary) % 4)
    doc['buffers'] = [{'byteLength': len(binary)}]
    text = json.dumps(doc, separators=(',', ':'), sort_keys=False).encode()
    text += b' ' * (-len(text) % 4)
    return (struct.pack('<III', 0x46546C67, 2, 28 + len(text) + len(binary))
            + struct.pack('<II', len(text), 0x4E4F534A) + text
            + struct.pack('<II', len(binary), 0x004E4942) + binary)


def read_accessor(doc, binary, index):
    acc = doc['accessors'][index]
    view = doc['bufferViews'][acc['bufferView']]
    dtype = np.dtype(COMPONENT[acc['componentType']])
    width = WIDTH[acc['type']]
    offset = view.get('byteOffset', 0) + acc.get('byteOffset', 0)
    stride = view.get('byteStride', dtype.itemsize * width)
    count = acc['count']
    raw = np.frombuffer(bytes(binary), dtype=np.uint8, count=stride * (count - 1) + dtype.itemsize * width, offset=offset)
    rows = np.lib.stride_tricks.as_strided(raw, shape=(count, dtype.itemsize * width), strides=(stride, 1))
    out = np.frombuffer(np.ascontiguousarray(rows).tobytes(), dtype=dtype).reshape(count, width)
    if acc.get('normalized'):
        out = out.astype(np.float64) / np.iinfo(dtype).max
    return out


class Writer:
    """Appends accessors to an existing doc/binary pair."""

    def __init__(self, doc, binary):
        self.doc = doc
        self.binary = binary

    def view(self, payload, target=None):
        self.binary.extend(b'\0' * (-len(self.binary) % 4))
        view = {'buffer': 0, 'byteOffset': len(self.binary), 'byteLength': len(payload)}
        if target:
            view['target'] = target
        self.binary.extend(payload)
        self.doc['bufferViews'].append(view)
        return len(self.doc['bufferViews']) - 1

    def accessor(self, array, kind, component=5126, target=None, minmax=False):
        array = np.ascontiguousarray(array, dtype=COMPONENT[component])
        count = array.shape[0]
        acc = {'bufferView': self.view(array.tobytes(), target), 'componentType': component,
               'count': count, 'type': kind}
        if minmax or kind == 'SCALAR' and component == 5126:
            flat = array.reshape(count, -1)
            acc['min'] = [float(v) for v in flat.min(axis=0)]
            acc['max'] = [float(v) for v in flat.max(axis=0)]
        self.doc['accessors'].append(acc)
        return len(self.doc['accessors']) - 1


def merge(base_doc, base_bin, other_doc, other_bin):
    """Append every resource of `other` into `base`; returns index offsets.

    Scenes of `other` are not merged; the caller parents other's root nodes.
    """
    base_bin.extend(b'\0' * (-len(base_bin) % 8))
    shift = len(base_bin)
    base_bin.extend(other_bin)
    off = {k: len(base_doc.get(k, [])) for k in
           ('bufferViews', 'accessors', 'images', 'samplers', 'textures', 'materials', 'meshes', 'skins', 'nodes')}
    for view in other_doc.get('bufferViews', []):
        view = dict(view)
        view['byteOffset'] = view.get('byteOffset', 0) + shift
        base_doc.setdefault('bufferViews', []).append(view)
    for acc in other_doc.get('accessors', []):
        acc = dict(acc)
        if 'bufferView' in acc:
            acc['bufferView'] += off['bufferViews']
        base_doc.setdefault('accessors', []).append(acc)
    for img in other_doc.get('images', []):
        img = dict(img)
        if 'bufferView' in img:
            img['bufferView'] += off['bufferViews']
        base_doc.setdefault('images', []).append(img)
    for s in other_doc.get('samplers', []):
        base_doc.setdefault('samplers', []).append(dict(s))
    for t in other_doc.get('textures', []):
        t = dict(t)
        if 'source' in t:
            t['source'] += off['images']
        if 'sampler' in t:
            t['sampler'] += off['samplers']
        base_doc.setdefault('textures', []).append(t)


    for m in other_doc.get('materials', []):
        m = json.loads(json.dumps(m))
        for key in ('normalTexture', 'occlusionTexture', 'emissiveTexture'):
            if key in m:
                m[key]['index'] += off['textures']
        pbr = m.get('pbrMetallicRoughness', {})
        for key in ('baseColorTexture', 'metallicRoughnessTexture'):
            if key in pbr:
                pbr[key]['index'] += off['textures']
        assert not m.get('extensions'), 'material extensions are not remapped'
        base_doc.setdefault('materials', []).append(m)
    for mesh in other_doc.get('meshes', []):
        mesh = json.loads(json.dumps(mesh))
        for p in mesh['primitives']:
            p['attributes'] = {k: v + off['accessors'] for k, v in p['attributes'].items()}
            if 'indices' in p:
                p['indices'] += off['accessors']
            if 'material' in p:
                p['material'] += off['materials']
            assert 'targets' not in p, 'morph targets are not supported'
        base_doc.setdefault('meshes', []).append(mesh)
    for skin in other_doc.get('skins', []):
        skin = dict(skin)
        skin['joints'] = [j + off['nodes'] for j in skin['joints']]
        if 'inverseBindMatrices' in skin:
            skin['inverseBindMatrices'] += off['accessors']
        if 'skeleton' in skin:
            skin['skeleton'] += off['nodes']
        base_doc.setdefault('skins', []).append(skin)
    for node in other_doc.get('nodes', []):
        node = json.loads(json.dumps(node))
        if 'children' in node:
            node['children'] = [c + off['nodes'] for c in node['children']]
        if 'mesh' in node:
            node['mesh'] += off['meshes']
        if 'skin' in node:
            node['skin'] += off['skins']
        base_doc['nodes'].append(node)
    assert not other_doc.get('animations'), 'strip animations before merging'
    for ext in other_doc.get('extensionsUsed', []):
        if ext not in base_doc.setdefault('extensionsUsed', []):
            base_doc['extensionsUsed'].append(ext)
    return off


def compact(doc, binary):
    """Drop unreferenced materials/textures/images/samplers/accessors/views.

    Referenced payload bytes are copied unchanged, in their original order.
    """
    scene_nodes = set()
    stack = list(doc['scenes'][doc.get('scene', 0)]['nodes'])
    while stack:
        i = stack.pop()
        scene_nodes.add(i)
        stack.extend(doc['nodes'][i].get('children', []))
    assert len(scene_nodes) == len(doc['nodes']), 'orphan nodes'
    meshes = sorted({doc['nodes'][i]['mesh'] for i in scene_nodes if 'mesh' in doc['nodes'][i]})
    materials = sorted({p['material'] for m in meshes for p in doc['meshes'][m]['primitives'] if 'material' in p})

    def tex_refs(m):
        out = [m[k]['index'] for k in ('normalTexture', 'occlusionTexture', 'emissiveTexture') if k in m]
        pbr = m.get('pbrMetallicRoughness', {})
        out += [pbr[k]['index'] for k in ('baseColorTexture', 'metallicRoughnessTexture') if k in pbr]
        return out
    textures = sorted({t for m in materials for t in tex_refs(doc['materials'][m])})
    images = sorted({doc['textures'][t]['source'] for t in textures})
    samplers = sorted({doc['textures'][t]['sampler'] for t in textures if 'sampler' in doc['textures'][t]})
    accessors = set()
    for m in meshes:
        for p in doc['meshes'][m]['primitives']:
            accessors.update(p['attributes'].values())
            if 'indices' in p:
                accessors.add(p['indices'])
    for s in doc.get('skins', []):
        if 'inverseBindMatrices' in s:
            accessors.add(s['inverseBindMatrices'])
    for a in doc.get('animations', []):
        for s in a['samplers']:
            accessors.update((s['input'], s['output']))
    accessors = sorted(accessors)
    views = sorted({doc['accessors'][a]['bufferView'] for a in accessors if 'bufferView' in doc['accessors'][a]}
                   | {doc['images'][i]['bufferView'] for i in images})
    remap = lambda used: {old: new for new, old in enumerate(used)}  # noqa: E731
    vmap, amap, imap, smap, tmap, mmap, meshmap = (remap(x) for x in (views, accessors, images, samplers, textures, materials, meshes))
    out = bytearray()
    new_views = []
    for v in views:
        view = dict(doc['bufferViews'][v])
        start = view.get('byteOffset', 0)
        out.extend(b'\0' * (-len(out) % 4))
        chunk = binary[start:start + view['byteLength']]
        view['byteOffset'] = len(out)
        out.extend(chunk)
        new_views.append(view)
    new_acc = []
    for a in accessors:
        acc = dict(doc['accessors'][a])
        if 'bufferView' in acc:
            acc['bufferView'] = vmap[acc['bufferView']]
        new_acc.append(acc)
    new_images = []
    for i in images:
        img = dict(doc['images'][i])
        img['bufferView'] = vmap[img['bufferView']]
        new_images.append(img)
    new_tex = []
    for t in textures:
        tex = dict(doc['textures'][t])
        tex['source'] = imap[tex['source']]
        if 'sampler' in tex:
            tex['sampler'] = smap[tex['sampler']]
        new_tex.append(tex)
    new_mat = []
    for m in materials:
        mat = json.loads(json.dumps(doc['materials'][m]))
        for k in ('normalTexture', 'occlusionTexture', 'emissiveTexture'):
            if k in mat:
                mat[k]['index'] = tmap[mat[k]['index']]
        pbr = mat.get('pbrMetallicRoughness', {})
        for k in ('baseColorTexture', 'metallicRoughnessTexture'):
            if k in pbr:
                pbr[k]['index'] = tmap[pbr[k]['index']]
        new_mat.append(mat)
    new_meshes = []
    for m in meshes:
        mesh = json.loads(json.dumps(doc['meshes'][m]))
        for p in mesh['primitives']:
            p['attributes'] = {k: amap[v] for k, v in p['attributes'].items()}
            if 'indices' in p:
                p['indices'] = amap[p['indices']]
            if 'material' in p:
                p['material'] = mmap[p['material']]
        new_meshes.append(mesh)
    for n in doc['nodes']:
        if 'mesh' in n:
            n['mesh'] = meshmap[n['mesh']]
    for s in doc.get('skins', []):
        if 'inverseBindMatrices' in s:
            s['inverseBindMatrices'] = amap[s['inverseBindMatrices']]
    for a in doc.get('animations', []):
        for s in a['samplers']:
            s['input'], s['output'] = amap[s['input']], amap[s['output']]
    doc.update(bufferViews=new_views, accessors=new_acc, images=new_images, textures=new_tex,
               materials=new_mat, meshes=new_meshes)
    if samplers:
        doc['samplers'] = [doc['samplers'][s] for s in samplers]
    else:
        doc.pop('samplers', None)
    for key in ('images', 'textures'):
        if not doc[key]:
            doc.pop(key)
    return out
