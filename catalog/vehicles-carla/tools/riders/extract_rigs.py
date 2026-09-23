#!/usr/bin/env python3
"""Derive rider mount data for the CARLA two-wheelers from CUE4Parse dumps.

Inputs (produced by ../extract, see README.md):
  skel.json      `SimforgeCarlaExport <content> skel.json --skel sks.txt`
  <bp-dir>/BP_*.json  `SimforgeCarlaExport <content> <bp-dir> --dumpbps bps.txt`
Output: rigs.json (committed), in SimForge model space: y-up, +X forward,
+Z right, metres (UE (X, Y, Z) cm -> (X, Z, Y) / 100).
"""
import json
import sys

import numpy as np

BLUEPRINTS = {
    'bicycle_bh_crossbike': ('BP_CrossBike', 'SK_CrossBike'),
    'bicycle_gazelle_omafiets': ('BP_LeisureBike', 'SK_LeisureBike'),
    'bicycle_diamondback_century': ('BP_RoadBike', 'SK_RoadBike'),
    'motorcycle_harley': ('BP_Harley', 'SK_Harley'),
    'motorcycle_kawasaki_ninja': ('BP_KawasakiNinja', 'SK_KawasakiNinja'),
    'motorcycle_yamaha_yzf': ('BP_Yamaha', 'SK_Yamaha'),
    'scooter_vespa': ('BP_Vespa', 'SK_Vespa'),
}
POINTS = ('Seat', 'HandlerLeftSocket', 'HandlerRightSocket', 'PedalsGeo', 'LeftPedalGeo', 'RightPedalGeo')


def qmat(q):
    x, y, z, w = q
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


def world_points(mesh):
    world = {}
    for i, bone in enumerate(mesh['bones']):
        rot, t = qmat(bone['q']), np.array(bone['t'], dtype=float)
        if bone['parent'] >= 0:
            prot, pt = world[bone['parent']]
            rot, t = prot @ rot, prot @ t + pt
        world[i] = (rot, t)
    return {mesh['bones'][i]['name']: [round(float(v), 5) for v in (t[0] / 100, t[2] / 100, t[1] / 100)]
            for i, (_, t) in world.items()}


def rider_component(bp):
    for export in bp:
        if export.get('Name') == 'SkeletalMesh_GEN_VARIABLE':
            p = export['Properties']
            overrides = [o['ObjectName'].split("'")[1] if o else None for o in p.get('OverrideMaterials', [])]
            return {'skeletalMesh': p['SkeletalMesh']['ObjectName'].split("'")[1],
                    'relativeLocationCm': p.get('RelativeLocation'), 'relativeRotationDeg': p.get('RelativeRotation'),
                    'overrideMaterials': overrides}
    raise SystemExit('blueprint has no rider component')


def main(skel_path, bp_dir, out_path):
    skel = json.load(open(skel_path))
    base = json.load(open(f'{bp_dir}/BP_Base2wheeledNew.json'))
    anim_class = next(e['Properties']['AnimClass']['ObjectName'] for e in base
                      if e.get('Name') == 'SkeletalMesh_GEN_VARIABLE')
    rigs = {'source': 'CARLA 0.10.0 UE5 cooked content (Carla git ada75f92, Content git 518f45bd)',
            'riderAnimBlueprint': anim_class, 'models': {}}
    for vid, (bp_name, sk_name) in BLUEPRINTS.items():
        pts = world_points(skel[sk_name])
        rigs['models'][vid] = {'blueprint': bp_name, 'skeletalMesh': sk_name,
                               'points': {k: pts[k] for k in POINTS},
                               'rider': rider_component(json.load(open(f'{bp_dir}/{bp_name}.json')))}
    open(out_path, 'w').write(json.dumps(rigs, indent=1, sort_keys=True) + '\n')


if __name__ == '__main__':
    main(*sys.argv[1:4])
