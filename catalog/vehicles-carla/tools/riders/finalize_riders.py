#!/usr/bin/env python3
"""Record the ridden two-wheeler GLBs in ../../manifest.json and ../../ATTRIBUTION.json.

Idempotent: rewrites every `*_rider` entry from the GLBs on disk and leaves
all other entries untouched. Run after build_riders.py.
"""
import hashlib
import json
from pathlib import Path

import gltf_io
from build_riders import MODELS

ROOT = Path(__file__).resolve().parents[2]
PEDESTRIANS = ROOT.parent / 'pedestrians-carla'


def main():
    manifest = json.loads((ROOT / 'manifest.json').read_text())
    attribution = json.loads((ROOT / 'ATTRIBUTION.json').read_text())
    walkers = json.loads((PEDESTRIANS / 'manifest.json').read_text())['pedestrians']
    walker_attr = {a['id']: a for a in json.loads((PEDESTRIANS / 'ATTRIBUTION.json').read_text())['assets']}
    rigs = json.loads((Path(__file__).with_name('rigs.json')).read_text())['models']
    for vid, spec in MODELS.items():
        base_key = f'vehicle_{vid}'
        key = f'{base_key}_rider'
        path = ROOT / 'models' / f'{key}.glb'
        data = path.read_bytes()
        doc, _ = gltf_io.load_glb(path)
        rider = doc['asset']['extras']['rider']
        anim = doc['animations'][0]
        base = manifest['vehicles'][base_key]
        walker_id = rider['pedestrian']
        walker = walkers[walker_id]
        assert walker['sourceMesh'] == rigs[vid]['rider']['skeletalMesh']
        manifest['vehicles'][key] = {
            'file': f'models/{key}.glb', 'family': base['family'], 'display': f"{base['display']} with rider",
            'carla_blueprint': base['carla_blueprint'], 'tintable': base['tintable'], 'dims_lwh_m': base['dims_lwh_m'],
            'bbox': base['bbox'], 'nodes': sorted({n['name'] for n in doc['nodes'] if 'mesh' in n}),
            'materials': [m['name'] for m in doc['materials']],
            'riderlessBase': base['file'],
            'rider': {
                'pedestrian': walker_id, 'sourceMesh': walker['sourceMesh'], 'carlaBlueprint': rigs[vid]['blueprint'],
                'helmet': spec.get('helmet'), 'slots': rider['slots'], 'variants': rider['variants'],
                'clip': anim['name'], 'clipDurationS': 1.0, 'metersPerCycle': anim['extras']['metersPerCycle'],
                'cycle': anim['extras']['cycle'], 'wheelTurnsPerCycle': anim['extras']['wheelTurnsPerCycle'],
                'pose': doc['asset']['extras']['riderPoseReport'],
            },
            'size_bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(),
        }
        bike_attr = attribution['assets'][base_key]
        attribution['assets'][key] = {
            'title': f"{bike_attr['title']} with rider",
            'source_packages': bike_attr['source_packages'] + [
                f"Content/Carla/Static/Pedestrian (CARLA UE5 0.10.0 cooked content): {walker['sourceMesh']} "
                f"(via SimForge {walker_id}, catalog/pedestrians-carla)",
                'Content/Carla/Animations/Base (CARLA UE5 0.10.0 cooked content): AS_Pedestrian_BikeHands, '
                'AB_Biker (graph re-evaluated offline)',
                f"Content/Carla/Blueprints/Vehicles/2Wheeled (CARLA UE5 0.10.0 cooked content): {rigs[vid]['blueprint']} "
                '(rider mount, Seat/Handler/Pedal bones)',
            ],
            'license': 'CC-BY-4.0',
            'attribution': (f"{bike_attr['attribution'].rstrip('.')}. Rider: {walker_attr[walker_id]['attribution'].rstrip('.')}. "
                            'Riding pose after CARLA AB_Biker / AS_Pedestrian_BikeHands, CC BY 4.0.'
                            + (' Helmet: SimForge procedural geometry, CC BY 4.0.' if spec.get('helmet') else '')),
            'modifications': (bike_attr['modifications'] + ' Rider: CARLA walker conversion attached per the CARLA '
                              'blueprint, posed by an offline re-evaluation of AB_Biker (seat/handlebar/pedal IK) and '
                              'baked into a looping `ride` clip; clothing materials renamed to rider_* palette slots; '
                              'unreferenced textures pruned'
                              + ('; hair primitives removed under a SimForge procedural helmet.' if spec.get('helmet') else '.')),
        }
    (ROOT / 'manifest.json').write_text(json.dumps(manifest, indent=2))
    (ROOT / 'ATTRIBUTION.json').write_text(json.dumps(attribution, indent=2))


if __name__ == '__main__':
    main()
