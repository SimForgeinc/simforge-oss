#!/usr/bin/env python3
"""Append native CARLA motion to existing GLBs, never re-export mesh/texture data."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import struct


def load_glb(path):
    data = path.read_bytes()
    magic, version, length = struct.unpack_from('<III', data)
    assert (magic, version, length) == (0x46546C67, 2, len(data))
    size, kind = struct.unpack_from('<II', data, 12)
    assert kind == 0x4E4F534A
    doc = json.loads(data[20:20 + size])
    n, kind = struct.unpack_from('<II', data, 20 + size)
    assert kind == 0x004E4942
    return doc, bytearray(data[28 + size:28 + size + n])


def save_glb(doc, binary):
    doc['buffers'] = [{'byteLength': len(binary)}]
    text = json.dumps(doc, separators=(',', ':')).encode()
    text += b' ' * (-len(text) % 4)
    return (struct.pack('<III', 0x46546C67, 2, 28 + len(text) + len(binary))
            + struct.pack('<II', len(text), 0x4E4F534A) + text
            + struct.pack('<II', len(binary), 0x004E4942) + binary)


def append_animations(doc, binary, clips, family):
    extras = doc['asset'].setdefault('extras', {})
    # Regeneration replaces only our appended tail; the original payload remains exact.
    boundary = extras.get('animationBase')
    if boundary:
        binary = binary[:boundary['bytes']]
        doc['accessors'] = doc['accessors'][:boundary['accessors']]
        doc['bufferViews'] = doc['bufferViews'][:boundary['views']]
    else:
        assert not doc.get('animations'), 'Refusing to overwrite foreign animation data'
        boundary = {'bytes': len(binary), 'accessors': len(doc['accessors']), 'views': len(doc['bufferViews'])}
    original_hash = hashlib.sha256(binary).hexdigest()
    joints = {doc['nodes'][i]['name']: i for i in doc['skins'][0]['joints']}
    assert len(joints) == {'G2': 66, 'G3': 26}[family]
    parents = {child: i for i, node in enumerate(doc['nodes']) for child in node.get('children', [])}
    animations = []

    def accessor(rows, kind):
        flat = [v for row in rows for v in row]
        assert all(math.isfinite(v) for v in flat)
        payload = struct.pack('<' + 'f' * len(flat), *flat)
        view = len(doc['bufferViews'])
        doc['bufferViews'].append({'buffer': 0, 'byteOffset': len(binary), 'byteLength': len(payload)})
        binary.extend(payload)
        value = {'bufferView': view, 'componentType': 5126, 'count': len(rows), 'type': kind}
        if kind == 'SCALAR':
            value.update(min=[min(flat)], max=[max(flat)])
        doc['accessors'].append(value)
        return len(doc['accessors']) - 1

    for role, clip in clips.items():
        assert clip['skeleton'] == 'Skel_Pedestrian_' + family and not clip['additive']
        tracks = clip['tracks']
        names = {t['name'] for t in tracks}
        omitted = names - joints.keys()
        assert omitted == ({'crl_eye__L_A', 'crl_eye__R_A'} if family == 'G2' else set()), omitted
        assert joints.keys() <= names
        # The newer G2 source has two additional eye leaves, not additional deform chains.
        for index, track in enumerate(tracks):
            if track['name'] in omitted:
                assert not any(t['parent'] == index for t in tracks)
                assert tracks[track['parent']]['name'] in joints
                continue
            node = joints[track['name']]
            if track['parent'] >= 0:
                assert doc['nodes'][parents[node]]['name'] == tracks[track['parent']]['name']
        times = accessor([[i * clip['duration'] / (clip['frames'] - 1)] for i in range(clip['frames'])], 'SCALAR')
        animation = {'name': role, 'samplers': [], 'channels': [], 'extras': {
            'source': clip['source'], 'rigFamily': family, 'rootMotion': 'in-place', 'omittedSourceLeaves': sorted(omitted)}}

        def channel(node, path, values):
            output = accessor(values, 'VEC4' if path == 'rotation' else 'VEC3')
            sampler = len(animation['samplers'])
            animation['samplers'].append({'input': times, 'output': output, 'interpolation': 'LINEAR'})
            animation['channels'].append({'sampler': sampler, 'target': {'node': node, 'path': path}})

        for track in tracks:
            name = track['name']
            if name not in joints or name == 'crl_root':
                continue
            node = joints[name]
            rotations = []
            for sample in track['samples']:
                q = sample['rotation']
                norm = math.sqrt(sum(v*v for v in q))
                assert norm > 0.99
                q = [v/norm for v in q]
                if rotations and sum(a*b for a,b in zip(q, rotations[-1])) < 0:
                    q = [-v for v in q]
                rotations.append(q)
            channel(node, 'rotation', rotations)
            if name == 'crl_hips__C':
                target = doc['nodes'][node]['translation']
                reference = track['referenceTranslation']
                ratio = math.sqrt(sum(v*v for v in target) / sum(v*v for v in reference))
                channel(node, 'translation', [[target[k] + (s['translation'][k] - reference[k]) * ratio
                                              for k in range(3)] for s in track['samples']])
        animations.append(animation)
    doc['animations'] = animations
    extras.update(animationBase=boundary, rigFamily=family, rootMotion='in-place',
                  convention='y-up, meters, +X forward, in-place animation')
    assert hashlib.sha256(binary[:boundary['bytes']]).hexdigest() == original_hash
    return save_glb(doc, binary)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('decoded', type=Path)
    parser.add_argument('root', type=Path)
    args = parser.parse_args()
    stats = json.loads((args.root / 'assembly-stats.json').read_text())
    cache = {}
    for entry in stats.values():
        path = args.root / entry['file']
        doc, binary = load_glb(path)
        assert doc['nodes'][0]['name'] == entry['sourceMesh'] + '.ao'
        family = 'G' + str(entry['generation'])
        assert entry['sourceMesh'].endswith('_' + family)
        child = entry['age'] == 'child'
        if family == 'G3':
            sources = {'walk': 'AS_childWalking_G3', 'idle': 'AS_idleAXz02_G3', 'run': 'AS_joggingG3'}
        elif child:
            sources = {'walk': 'AS_Girl_walkCicle0C', 'idle': 'AS_Girl_Idle', 'run': 'AS_Girl_runCicle0E'}
        else:
            sources = {'walk': 'AS_female_WalkCicle0D' if entry['gender'] == 'female' else 'AS_male2_WalkCicle0E',
                       'idle': 'AS_female_Idle0C', 'run': 'AS_female_runCicle0E'}
        for name in sources.values():
            if name not in cache:
                cache[name] = json.loads((args.decoded / (name + '.json')).read_text())
        output = append_animations(doc, binary, {role: cache[name] for role, name in sources.items()}, family)
        path.write_bytes(output)
        entry.update(bytes=len(output), sha256=hashlib.sha256(output).hexdigest(), rigFamily=family,
                     jointCount=len(doc['skins'][0]['joints']), rootMotion='in-place',
                     clips={role: {'source': name, 'duration': cache[name]['duration']} for role, name in sources.items()})
    (args.root / 'assembly-stats.json').write_text(json.dumps(stats, indent=2, sort_keys=True) + '\n')
    print(json.dumps({'models': len(stats), 'bytes': sum(e['bytes'] for e in stats.values())}))


if __name__ == '__main__':
    main()
