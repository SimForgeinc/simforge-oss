#!/usr/bin/env python3
"""Remove proven normal-as-albedo bindings; preserve binary GLB payload exactly."""
import hashlib
import json
from pathlib import Path
import struct
import sys

CONVENTION = 'y-up, meters; bind-pose facing +Z; walk/run gait axis +Z; in-place animation; actor binding yaw +pi/2 maps +Z to +X'
TINTS = json.loads((Path(__file__).resolve().parent.parent / 'material-tints.json').read_text())['materials']


def repair_materials(doc):
    repaired = []
    for material in doc.get('materials', []):
        pbr = material.get('pbrMetallicRoughness', {})
        texture = pbr.get('baseColorTexture')
        if texture is None:
            continue
        image = doc['images'][doc['textures'][texture['index']]['source']]
        name = image.get('name', '')
        if '_n@d' not in name.lower() and 'normal' not in name.lower():
            continue
        del pbr['baseColorTexture']
        tint = TINTS.get(material['name'])
        rgb = tint['linearRgb'] if tint else [0.5, 0.5, 0.5]
        placeholder = tint is None or tint['placeholder']
        alpha = pbr.get('baseColorFactor', [1, 1, 1, 1])[3]
        pbr['baseColorFactor'] = [*rgb, alpha]
        material.setdefault('extras', {})['baseColorFallback'] = {
            'reason': 'normal-map-was-bound-as-albedo',
            'removedImage': name,
            'sourceTintAvailable': not placeholder,
            'kind': 'neutral-gray-placeholder' if placeholder else 'source-primary-tint-without-layer-masks',
            'sourceMaterial': tint['sourceMaterial'] if tint else None,
            'parameter': tint['parameter'] if tint else None,
        }
        repaired.append(material['name'])
    return repaired


def main():
    root = Path(sys.argv[1])
    stats = json.loads((root / 'assembly-stats.json').read_text())
    report = []
    for entry in stats.values():
        path = root / entry['file']
        original = path.read_bytes()
        magic, version, length = struct.unpack_from('<III', original)
        assert (magic, version, length) == (0x46546C67, 2, len(original))
        size, kind = struct.unpack_from('<II', original, 12)
        assert kind == 0x4E4F534A
        doc = json.loads(original[20:20 + size])
        repaired = repair_materials(doc)
        doc['asset'].setdefault('extras', {})['convention'] = CONVENTION
        text = json.dumps(doc, separators=(',', ':')).encode()
        text += b' ' * (-len(text) % 4)
        suffix = original[20 + size:]
        output = (struct.pack('<III', magic, version, 20 + len(text) + len(suffix))
                  + struct.pack('<II', len(text), kind) + text + suffix)
        assert output[20 + len(text):] == suffix
        path.write_bytes(output)
        entry.update(bytes=len(output), sha256=hashlib.sha256(output).hexdigest())
        entry['materialColorFallbacks'] = {
            material['name']: material['extras']['baseColorFallback']
            for material in doc['materials']
            if 'baseColorFallback' in material.get('extras', {})
        }
        report.append({'file': entry['file'], 'repairedMaterials': repaired,
                       'binaryUnchanged': True, 'bytes': len(output), 'sha256': entry['sha256']})
    (root / 'assembly-stats.json').write_text(json.dumps(stats, indent=2, sort_keys=True) + '\n')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
