#!/usr/bin/env python3
"""Write carla-blueprints.json: pack model key -> CARLA 0.10 blueprint id.

A pack model is "the same source model" as a CARLA blueprint when the
blueprint's VehicleMesh (walking the blueprint's parent chain) is the skeletal
mesh the model was converted from (ATTRIBUTION.json source_packages).

Inputs: CARLA `Content/Carla/Config/VehicleParameters.json` (Make/Model ->
blueprint class; blueprint id = vehicle.<make>.<model>, lower-case, spaces
removed) and `SimforgeCarlaExport --dumpbps` dumps of those classes.
Usage: carla_blueprints.py VehicleParameters.json <bp-dump-dir>... > ../carla-blueprints.json
"""
import json
import re
import sys
from pathlib import Path

PACK = Path(__file__).resolve().parents[1]


def vehicle_mesh(dumps, bp):
    for d in dumps:
        path = d / f'{bp}.json'
        if not path.is_file():
            continue
        exports = json.loads(path.read_text())
        parent = None
        for e in exports:
            props = e.get('Properties', {})
            if e.get('Name') == 'VehicleMesh' and 'SkeletalMesh' in props:
                return props['SkeletalMesh']['ObjectName'].split("'")[1]
            if e.get('Type') == 'BlueprintGeneratedClass' and e.get('Super'):
                parent = e['Super'].get('ObjectName', '').split("'")[1].removesuffix('_C')
        return vehicle_mesh(dumps, parent) if parent else None
    raise SystemExit(f'no dump for {bp}')


def main(params, *dump_dirs):
    dumps = [Path(d) for d in dump_dirs]
    sources = {}
    for key, asset in json.loads((PACK / 'ATTRIBUTION.json').read_text())['assets'].items():
        if key.endswith('_rider'):
            continue
        for package in asset['source_packages']:
            match = re.search(r': (SK_\w+)$', package)
            if match:
                sources[match.group(1)] = key
    table = {}
    for vehicle in json.loads(Path(params).read_text())['Vehicles']:
        blueprint_id = 'vehicle.' + vehicle['Make'].lower().replace(' ', '') + '.' + vehicle['Model'].lower().replace(' ', '')
        bp = vehicle['Class'].rsplit('/', 1)[-1].split('.')[0]
        mesh = vehicle_mesh(dumps, bp)
        key = sources.get(mesh)
        if key:
            table[key] = {'blueprintId': blueprint_id, 'blueprintClass': bp, 'vehicleMesh': mesh}
            if (PACK / 'models' / f'{key}_rider.glb').is_file():
                table[f'{key}_rider'] = table[key]
    out = {'carlaVersion': '0.10.0', 'source': 'Content/Carla/Config/VehicleParameters.json + blueprint VehicleMesh',
           'models': dict(sorted(table.items()))}
    sys.stdout.write(json.dumps(out, indent=2) + '\n')


if __name__ == '__main__':
    main(*sys.argv[1:])
