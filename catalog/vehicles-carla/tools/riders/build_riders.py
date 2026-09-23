#!/usr/bin/env python3
"""Build ridden two-wheeler GLBs: CARLA bike + CARLA rider + baked AB_Biker pose.

Usage (from this directory):
  build_riders.py --bike-dir ../../models --pedestrian-dir ../../../pedestrians-carla/models --out ../../models

Inputs are the existing CC BY 4.0 CARLA conversions in this repo (bike GLBs,
pedestrian GLBs), the CARLA grip pose `bikehands-pose.json` and the bike
rig/blueprint data `rigs.json` (both from extract_rigs.py over CUE4Parse dumps). Mesh, skin and texture payloads are copied byte for byte;
only node transforms, material names/colours and animation data are authored
here. Output is deterministic (same inputs -> same bytes).

Scene graph added to each bike GLB:
  <bike root>
    rider                static mount (yaw +pi/2: pedestrian bind faces +Z)
      <SK_*.ao> ... crl_*          pedestrian skeleton, posed (static riding pose)
        crl_Head__C > rider_helmet motorcycles/scooter only
  rider_mesh             second scene root: skinned rider mesh (joints above)
Animation `ride` loops one phase cycle:
  bicycles     one crank revolution: crank + pedals orbit, rider legs IK'd to
               the pedals, wheels turn `gearRatio` revolutions;
  motorcycles  one wheel revolution, rider static.
Consumers map odometer distance to clip time:
  t = frac(distanceM / metersPerCycle) * duration.
"""
import argparse
import copy
import hashlib
import json
import math
from pathlib import Path

import numpy as np

import gltf_io
import helmet as helmet_mod
from rider_ik import (X, Y, Z, Pose, axis_angle, mat_to_quat, norm, quat_to_mat, rotation_between, two_bone)

FRAMES = 48  # keys per cycle (7.5 deg of crank per key)
DURATION = 1.0

# Rider per blueprint = the pedestrian mesh CARLA's own blueprint attaches (rigs.json
# rider.skeletalMesh), resolved to the SimForge pedestrian conversion of that mesh.
# `slots` maps the rider's clothing materials to tintable rider slots.
MODELS = {
    'bicycle_bh_crossbike': dict(kind='bicycle', pedestrian='0017', gear=2,
                                 slots={'afro_f02_jacket_b': 'rider_top', 'afro_f02_pants_b': 'rider_bottom',
                                        'afro_f02_shoes_b': 'rider_shoes'}),
    'bicycle_gazelle_omafiets': dict(kind='bicycle', pedestrian='0047', gear=2,
                                     slots={'euro_m02_jacket_a': 'rider_top', 'euro_m02_pants_a': 'rider_bottom',
                                            'euro_m02_shoes_a': 'rider_shoes'}),
    'bicycle_diamondback_century': dict(kind='bicycle', pedestrian='0038', gear=2,
                                        slots={'asia_m02_shirt_a': 'rider_top', 'asia_m02_pants_a': 'rider_bottom',
                                               'asia_m02_boots_a': 'rider_shoes'}),
    'motorcycle_harley': dict(kind='motorcycle', pedestrian='0027', helmet='open',
                              slots={'afro_m02_waist': 'rider_top', 'afro_m02_pants': 'rider_bottom',
                                     'afro_m02_shoes': 'rider_shoes'}),
    'motorcycle_kawasaki_ninja': dict(kind='motorcycle', pedestrian='0032', helmet='full',
                                      slots={'asia_f01_jacket_a': 'rider_top', 'afro_f01_pants_e': 'rider_bottom',
                                             'afro_f01_pants_d': 'rider_shoes'}),
    'motorcycle_yamaha_yzf': dict(kind='motorcycle', pedestrian='0043', helmet='full',
                                  slots={'afro_f01_jacket_c': 'rider_top', 'afro_f01_pants_a': 'rider_bottom'}),
    'scooter_vespa': dict(kind='scooter', pedestrian='0039', helmet='open',
                          slots={'euro_f01_dress_a': 'rider_top', 'euro_f01_boots_a': 'rider_shoes'}),
}

# Rider outfit palettes (linear RGB). Variant 0 is the asset as authored (the
# CARLA rider's converted colours, SimForge helmet grey); variant k >= 1 writes
# PALETTES[k - 1] into the rider_* materials. A consumer picks
# fnv1a32(actorId) % (len(PALETTES) + 1). Stored in the GLB
# (asset.extras.rider) and in the catalog binding so no consumer invents colours.
PALETTES = [
    {'rider_top': [0.030, 0.045, 0.110], 'rider_bottom': [0.040, 0.050, 0.080], 'rider_shoes': [0.020, 0.020, 0.020], 'rider_helmet': [0.015, 0.015, 0.017]},
    {'rider_top': [0.450, 0.030, 0.025], 'rider_bottom': [0.025, 0.025, 0.028], 'rider_shoes': [0.700, 0.700, 0.680], 'rider_helmet': [0.750, 0.750, 0.740]},
    {'rider_top': [0.110, 0.130, 0.050], 'rider_bottom': [0.300, 0.240, 0.140], 'rider_shoes': [0.120, 0.060, 0.025], 'rider_helmet': [0.090, 0.095, 0.100]},
    {'rider_top': [0.180, 0.180, 0.190], 'rider_bottom': [0.060, 0.090, 0.180], 'rider_shoes': [0.800, 0.800, 0.800], 'rider_helmet': [0.500, 0.020, 0.020]},
    {'rider_top': [0.012, 0.012, 0.012], 'rider_bottom': [0.015, 0.015, 0.018], 'rider_shoes': [0.010, 0.010, 0.010], 'rider_helmet': [0.010, 0.010, 0.010]},
    {'rider_top': [0.800, 0.620, 0.020], 'rider_bottom': [0.050, 0.050, 0.055], 'rider_shoes': [0.030, 0.030, 0.030], 'rider_helmet': [0.850, 0.650, 0.030]},
    {'rider_top': [0.720, 0.720, 0.700], 'rider_bottom': [0.380, 0.300, 0.200], 'rider_shoes': [0.150, 0.080, 0.035], 'rider_helmet': [0.420, 0.430, 0.440]},
    {'rider_top': [0.020, 0.200, 0.220], 'rider_bottom': [0.070, 0.070, 0.075], 'rider_shoes': [0.300, 0.300, 0.300], 'rider_helmet': [0.020, 0.090, 0.350]},
]

# Pose tuning (metres/degrees), per kind. Values reproduce AB_Biker's intent:
# hips on the Seat bone, hands on the Handler*Socket bones, feet on the
# *PedalGeo bones, head levelled toward a point ahead (LookAt (300,0,100) cm).
KIND = {
    'bicycle': dict(hip_above_seat=0.085, hip_back=0.02, reach=0.90, max_lean=60.0, toe_down=16.0, toe_swing=10.0, gaze_down=12.0),
    'motorcycle': dict(hip_above_seat=0.075, hip_back=0.0, reach=0.88, max_lean=85.0, toe_down=8.0, toe_swing=0.0, gaze_down=6.0),
    'scooter': dict(hip_above_seat=0.075, hip_back=0.0, reach=0.88, max_lean=45.0, toe_down=0.0, toe_swing=0.0, gaze_down=6.0),
}
SIDES = {'L': -1.0, 'R': 1.0}  # model +Z is the rider's right


def fnv1a32(text):
    h = 0x811C9DC5
    for byte in text.encode():
        h = ((h ^ byte) * 0x01000193) & 0xFFFFFFFF
    return h


def bikehands_locals(pose):
    """Local rotations of AS_Pedestrian_BikeHands (a static pose; bikehands-pose.json)."""
    out = {}
    for name, q in pose['rotations'].items():
        q = np.array(q, dtype=float)
        out[name] = q / np.linalg.norm(q)
    return out


def bike_body_triangles(doc, binary):
    """World-space triangles of the rigid bike body (for the saddle surface)."""
    tris = []
    for n in doc['nodes']:
        if 'mesh' not in n or n.get('name') != 'body':
            continue
        r = quat_to_mat(n.get('rotation', [0, 0, 0, 1]))
        t = np.array(n.get('translation', [0, 0, 0]))
        for p in doc['meshes'][n['mesh']]['primitives']:
            pos = gltf_io.read_accessor(doc, binary, p['attributes']['POSITION']).astype(float) @ r.T + t
            idx = gltf_io.read_accessor(doc, binary, p['indices']).reshape(-1, 3)
            tris.append(pos[idx])
    return np.concatenate(tris)


def saddle_top(tris, seat, ceiling=0.25):
    """Highest body surface under (x, z=0) below Seat bone + `ceiling` (vertical ray cast)."""
    x, z = seat[0], 0.0
    a, b, c = tris[:, 0], tris[:, 1], tris[:, 2]
    # Barycentric test in the XZ plane.
    v0, v1 = b - a, c - a
    den = v0[:, 0] * v1[:, 2] - v1[:, 0] * v0[:, 2]
    ok = np.abs(den) > 1e-12
    px, pz = x - a[:, 0], z - a[:, 2]
    safe = np.where(ok, den, 1.0)
    u = np.where(ok, (px * v1[:, 2] - v1[:, 0] * pz) / safe, -1.0)
    v = np.where(ok, (v0[:, 0] * pz - px * v0[:, 2]) / safe, -1.0)
    hit = ok & (u >= 0) & (v >= 0) & (u + v <= 1)
    y = a[:, 1] + u * v0[:, 1] + v * v1[:, 1]
    y = y[hit & (y < seat[1] + ceiling)]
    if len(y) == 0:
        raise ValueError(f'no saddle surface at x={x:.3f}')
    return float(y.max())


def skinned_vertices(doc, binary, mesh_index, skin_index, pose, joint_filter=None):
    """CPU-skin a mesh with the current pose (joint world x inverse bind)."""
    skin = doc['skins'][skin_index]
    ibm = gltf_io.read_accessor(doc, binary, skin['inverseBindMatrices']).reshape(-1, 4, 4).transpose(0, 2, 1)
    mats = []
    for k, j in enumerate(skin['joints']):
        m = np.eye(4)
        m[:3, :3] = pose.wr[j]
        m[:3, 3] = pose.wt[j]
        mats.append(m @ ibm[k])
    mats = np.array(mats)
    out = []
    for p in doc['meshes'][mesh_index]['primitives']:
        pos = gltf_io.read_accessor(doc, binary, p['attributes']['POSITION']).astype(float)
        joints = gltf_io.read_accessor(doc, binary, p['attributes']['JOINTS_0']).astype(int)
        weights = gltf_io.read_accessor(doc, binary, p['attributes']['WEIGHTS_0']).astype(float)
        hom = np.concatenate([pos, np.ones((len(pos), 1))], axis=1)
        acc = np.zeros((len(pos), 3))
        for c in range(4):
            acc += weights[:, c:c + 1] * np.einsum('nij,nj->ni', mats[joints[:, c]], hom)[:, :3]
        if joint_filter is not None:
            wanted = [k for k, j in enumerate(skin['joints']) if j in set(joint_filter)]
            keep = np.isin(joints[np.arange(len(pos)), weights.argmax(axis=1)], wanted)
            acc = acc[keep]
        out.append(acc)
    return np.concatenate(out)


class RiderBuilder:
    def __init__(self, vid, spec, rig, bike_path, ped_path, clip):
        self.vid, self.spec, self.rig = vid, spec, rig
        self.kind = KIND[spec['kind']]
        self.doc, self.bin = gltf_io.load_glb(bike_path)
        assert not self.doc.get('animations') and not self.doc.get('skins'), f'{bike_path} is already rigged'
        self.bike_tris = bike_body_triangles(self.doc, self.bin)
        ped_doc, ped_bin = gltf_io.load_glb(ped_path)
        self.ped_source = ped_doc['nodes'][0]['name']
        expected = rig['rider']['skeletalMesh'] + '.ao'
        assert self.ped_source == expected, (vid, self.ped_source, expected)
        ped_doc = copy.deepcopy(ped_doc)
        ped_doc.pop('animations', None)
        self.ped_extras = ped_doc['asset'].get('extras', {})
        self.off = gltf_io.merge(self.doc, self.bin, ped_doc, ped_bin)
        self.clip = bikehands_locals(clip)

    # -- scene graph -------------------------------------------------------
    def attach(self):
        doc, off = self.doc, self.off
        root = doc['scenes'][doc.get('scene', 0)]['nodes']
        assert len(root) == 1, 'bike GLBs have a single root node'
        self.bike_root = root[0]
        assert not doc['nodes'][self.bike_root].get('rotation') and not doc['nodes'][self.bike_root].get('translation')
        ped_root = off['nodes']  # SK_*.ao
        mesh_nodes = [i for i in range(off['nodes'], len(doc['nodes'])) if 'skin' in doc['nodes'][i]]
        assert len(mesh_nodes) == 1
        self.mesh_node = mesh_nodes[0]
        doc['nodes'][self.mesh_node]['name'] = 'rider_mesh'
        doc['nodes'][self.mesh_node]['extras'] = {'semanticClass': 'rider'}
        # The skinned mesh node is a scene root: glTF ignores a skinned mesh's parent
        # transforms and some loaders (three.js) bake them into the bind matrix.
        yaw = [0.0, math.sin(math.pi / 4), 0.0, math.cos(math.pi / 4)]
        doc['nodes'].append({'name': 'rider', 'rotation': yaw, 'translation': [0.0, 0.0, 0.0],
                             'children': [ped_root],
                             'extras': {'semanticClass': 'rider', 'source': self.ped_source}})
        self.mount = len(doc['nodes']) - 1
        doc['nodes'][self.bike_root]['children'].append(self.mount)
        root.append(self.mesh_node)
        self.skin = doc['nodes'][self.mesh_node]['skin']

    def pose(self):
        nodes = self.doc['nodes']
        mount_rot = quat_to_mat(nodes[self.mount]['rotation'])
        self.rest = Pose(nodes, self.off['nodes'], (mount_rot, np.zeros(3)))
        pose = self.rest.copy()
        for name, q in self.clip.items():
            if name in pose.by_name and name not in ('crl_root',):
                pose.r[pose.id(name)] = quat_to_mat(q)
        pose.evaluate()
        # Grip orientation: AS_Pedestrian_BikeHands hand rotation, as authored.
        self.hand_rot = {s: pose.rot(f'crl_hand__{s}') for s in SIDES}
        self.bh = pose.copy()
        return pose

    def place_hips(self, pose, drop=0.0, slide=0.0):
        seat = np.array(self.rig['points']['Seat'])
        x = seat[0] - self.kind['hip_back'] + slide
        top = saddle_top(self.bike_tris, np.array([x, seat[1], 0.0]))
        hips = 0.5 * (pose.pos('crl_thigh__L') + pose.pos('crl_thigh__R'))
        target = np.array([x, top + self.kind['hip_above_seat'] - drop, 0.0])
        pose.root_world = (pose.root_world[0], pose.root_world[1] + target - hips)
        pose.evaluate()
        return target

    def grip_target(self, side):
        name = 'HandlerLeftSocket' if side == 'L' else 'HandlerRightSocket'
        return np.array(self.rig['points'][name])

    def wrist_target(self, pose, side):
        # Bar sits under the proximal phalanges of the curled grip pose.
        bh = self.bh
        grip = 0.5 * (bh.pos(f'crl_handMiddle01__{side}') + bh.pos(f'crl_handMiddle02__{side}'))
        offset = grip - bh.pos(f'crl_hand__{side}')
        return self.grip_target(side) - offset

    def lean(self, pose):
        """Pitch the torso (hips/spine/spine01) until the hands reach the bars.

        AB_Biker pins the hips to the Seat bone and does not stretch the arms,
        so on long-reach sport bikes CARLA's hands float short of the grips.
        Here the rider may slide forward along the saddle (up to 0.25 m) before
        the torso lean exceeds the per-kind limit.
        """
        arm = {s: np.linalg.norm(pose.pos(f'crl_foreArm__{s}') - pose.pos(f'crl_arm__{s}'))
               + np.linalg.norm(pose.pos(f'crl_hand__{s}') - pose.pos(f'crl_foreArm__{s}')) for s in SIDES}

        def ratio(theta, slide):
            trial = pose.copy()
            for name, share in (('crl_hips__C', 0.4), ('crl_spine__C', 0.3), ('crl_spine01__C', 0.3)):
                trial.rotate_world(name, axis_angle(Z, -theta * share))
            self.place_hips(trial, slide=slide)
            return max(np.linalg.norm(self.wrist_target(trial, s) - trial.pos(f'crl_arm__{s}')) / arm[s]
                       for s in SIDES), trial

        limit = math.radians(self.kind['max_lean'])
        want = self.kind['reach']
        for step in range(26):
            slide = 0.01 * step
            lo, hi = math.radians(-10), limit
            try:
                if ratio(hi, slide)[0] > want:
                    continue
            except ValueError:
                break
            if ratio(lo, slide)[0] <= want:
                theta = lo
            else:
                for _ in range(40):
                    mid = 0.5 * (lo + hi)
                    if ratio(mid, slide)[0] > want:
                        lo = mid
                    else:
                        hi = mid
                theta = hi
            self.lean_deg, self.slide = math.degrees(theta), slide
            return ratio(theta, slide)[1]
        raise AssertionError(f'{self.vid}: the rider cannot reach the handlebars')

    def level_head(self, pose):
        forward = norm(pose.rot('crl_Head__C') @ self.rest.rot('crl_Head__C').T @ X)
        down = math.radians(self.kind['gaze_down'])
        want = np.array([math.cos(down), -math.sin(down), 0.0])
        delta = rotation_between(forward, want)
        axis_vec = np.array([delta[2, 1] - delta[1, 2], delta[0, 2] - delta[2, 0], delta[1, 0] - delta[0, 1]])
        angle = math.acos(max(-1.0, min(1.0, (np.trace(delta) - 1) / 2)))
        if angle > 1e-6:
            half = axis_angle(axis_vec, angle / 2)
            pose.rotate_world('crl_neck__C', half)
            forward = norm(pose.rot('crl_Head__C') @ self.rest.rot('crl_Head__C').T @ X)
            pose.rotate_world('crl_Head__C', rotation_between(forward, want))

    def solve_arms(self, pose):
        reach = {}
        for s, sign in SIDES.items():
            pole = norm(np.array([-0.35, -0.55, 0.75 * sign]))
            reach[s] = two_bone(pose, self.rest, f'crl_arm__{s}', f'crl_foreArm__{s}', f'crl_hand__{s}',
                                self.wrist_target(pose, s), pole, motion=X)
            pose.set_world_rot(f'crl_hand__{s}', self.hand_rot[s])
            err = np.linalg.norm(pose.pos(f'crl_hand__{s}') - self.wrist_target(pose, s))
            assert err < 0.03, f'{self.vid}: {s} hand misses the grip by {err:.3f} m'
        return reach

    # -- pedals ------------------------------------------------------------
    def pedal_points(self, phase):
        pts = self.rig['points']
        if self.spec['kind'] != 'bicycle':
            return {'L': np.array(pts['LeftPedalGeo']), 'R': np.array(pts['RightPedalGeo'])}
        centre = np.array(pts['PedalsGeo'])
        rot = axis_angle(Z, -2 * math.pi * phase)
        out = {}
        for s, key in (('L', 'LeftPedalGeo'), ('R', 'RightPedalGeo')):
            v = np.array(pts[key]) - centre
            radial = rot @ np.array([v[0], v[1], 0.0])
            out[s] = centre + radial + np.array([0.0, 0.0, v[2]])
        return out

    def crank_angle(self, side, phase):
        pts = self.rig['points']
        v = np.array(pts['LeftPedalGeo' if side == 'L' else 'RightPedalGeo']) - np.array(pts['PedalsGeo'])
        return math.atan2(v[1], v[0]) - 2 * math.pi * phase

    def solve_legs(self, pose, phase):
        reach = {}
        pedals = self.pedal_points(phase)
        for s, sign in SIDES.items():
            ang = self.crank_angle(s, phase) if self.spec['kind'] == 'bicycle' else 0.0
            toe = math.radians(self.kind['toe_down'] + self.kind['toe_swing'] * math.sin(ang))
            foot_rot = axis_angle(Z, -toe) @ self.rest.rot(f'crl_foot__{s}')
            ball_rest = self.rest.pos(f'crl_toe__{s}')
            ankle_rest = self.rest.pos(f'crl_foot__{s}')
            sole = ball_rest[1] - self.rest_floor
            normal = axis_angle(Z, -toe) @ Y
            ball = pedals[s] + normal * (sole + 0.012)
            ankle = ball - axis_angle(Z, -toe) @ (ball_rest - ankle_rest)
            pole = norm(np.array([1.0, 0.15, 0.18 * sign]))
            reach[s] = two_bone(pose, self.rest, f'crl_thigh__{s}', f'crl_leg__{s}', f'crl_foot__{s}', ankle, pole,
                                motion=-X)
            pose.set_world_rot(f'crl_foot__{s}', foot_rot)
        return reach

    # -- build -------------------------------------------------------------
    def build(self):
        self.attach()
        pose = self.pose()
        mesh_index = self.doc['nodes'][self.mesh_node]['mesh']
        rest_vertices = skinned_vertices(self.doc, self.bin, mesh_index, self.skin, self.rest)
        self.rest_floor = float(rest_vertices[:, 1].min())
        pose = self.lean(pose)
        self.level_head(pose)
        # Lower the hips when the legs cannot reach the lowest pedal position.
        drop = 0.0
        for _ in range(6):
            worst = max(max(self.solve_legs(pose.copy(), k / FRAMES).values()) for k in range(FRAMES))
            if worst <= 0.985:
                break
            leg = np.linalg.norm(pose.pos('crl_leg__L') - pose.pos('crl_thigh__L')) + np.linalg.norm(
                pose.pos('crl_foot__L') - pose.pos('crl_leg__L'))
            drop += (worst - 0.975) * leg
            self.place_hips(pose, drop, self.slide)
        self.hip_drop = drop
        self.arm_reach = self.solve_arms(pose)
        frames = []
        for k in range(FRAMES + 1):
            p = pose.copy()
            self.solve_legs(p, (k % FRAMES) / FRAMES)
            frames.append(p)
        self.leg_reach = max(max(self.solve_legs(pose.copy(), k / FRAMES).values()) for k in range(FRAMES))
        base = frames[0]
        # Static pose = frame 0 (consumers without animation still see a rider on the bike).
        for i in base.order:
            q = mat_to_quat(base.r[i])
            node = self.doc['nodes'][i]
            node['rotation'] = [float(v) for v in q]
        self.doc['nodes'][self.mount]['translation'] = [float(v) for v in base.root_world[1]]
        self.posed_vertices = skinned_vertices(self.doc, self.bin, mesh_index, self.skin, base)
        self.check_clearance(base)
        if self.spec.get('helmet'):
            self.add_helmet(base)
        self.materials()
        self.animation(frames)
        self.extras()
        self.bin = gltf_io.compact(self.doc, self.bin)
        return gltf_io.save_glb(self.doc, self.bin)

    def check_clearance(self, pose):
        v = self.posed_vertices
        assert v[:, 1].min() > 0.0, f'{self.vid}: rider penetrates the ground ({v[:, 1].min():.3f})'
        for s in SIDES:
            err = np.linalg.norm(pose.pos(f'crl_hand__{s}') - self.wrist_target(pose, s))
            assert err < 0.03, (self.vid, s, err)

    def add_helmet(self, pose):
        head_joints = [pose.id(n) for n in pose.by_name if n and (n.startswith('crl_Head') or n.startswith('crl_eye'))]
        head = skinned_vertices(self.doc, self.bin, self.doc['nodes'][self.mesh_node]['mesh'], self.skin, pose,
                                joint_filter=head_joints)
        head_id = pose.id('crl_Head__C')
        world = np.eye(4)
        world[:3, :3] = pose.wr[head_id]
        world[:3, 3] = pose.wt[head_id]
        mesh = helmet_mod.build(self.doc, self.bin, head, world, style=self.spec['helmet'])
        self.doc['nodes'].append({'name': 'rider_helmet', 'mesh': mesh, 'extras': {'semanticClass': 'rider'}})
        self.doc['nodes'][head_id].setdefault('children', []).append(len(self.doc['nodes']) - 1)
        # Hair and brows would poke through the shell; a helmeted rider has them tucked away.
        rider_mesh = self.doc['meshes'][self.doc['nodes'][self.mesh_node]['mesh']]
        names = {i: m.get('name', '') for i, m in enumerate(self.doc['materials'])}
        kept = [p for p in rider_mesh['primitives'] if not any(k in names[p['material']] for k in ('hair', 'eyebrow', 'slashes'))]
        assert len(kept) < len(rider_mesh['primitives']), f'{self.vid}: no hair primitive found to hide'
        rider_mesh['primitives'] = kept

    def materials(self):
        slots = self.spec['slots']
        seen = set()
        for m in self.doc['materials'][self.off['materials']:]:
            if m['name'] in slots:
                slot = slots[m['name']]
                m.setdefault('extras', {})['sourceMaterialName'] = m['name']
                pbr = m.setdefault('pbrMetallicRoughness', {})
                assert 'baseColorTexture' not in pbr, f'{m["name"]}: textured clothing cannot take a palette colour'
                m['name'] = slot
                seen.add(slot)
        missing = set(slots.values()) - seen
        assert not missing, f'{self.vid}: rider slots without material: {missing}'
        if self.spec.get('helmet'):
            seen.add('rider_helmet')
        self.slots = sorted(seen)

    def animation(self, frames):
        w = gltf_io.Writer(self.doc, self.bin)
        times = w.accessor(np.array([[k * DURATION / FRAMES] for k in range(FRAMES + 1)]), 'SCALAR')
        anim = {'name': 'ride', 'samplers': [], 'channels': []}

        def channel(node, path, rows):
            rows = np.array(rows, dtype=np.float32)
            out = w.accessor(rows, 'VEC4' if path == 'rotation' else 'VEC3')
            anim['samplers'].append({'input': times, 'output': out, 'interpolation': 'LINEAR'})
            anim['channels'].append({'sampler': len(anim['samplers']) - 1, 'target': {'node': node, 'path': path}})

        def continuous(quats):
            out = []
            for q in quats:
                if out and np.dot(q, out[-1]) < 0:
                    q = -q
                out.append(q)
            return out

        names = {n.get('name'): i for i, n in enumerate(self.doc['nodes'][:self.off['nodes']])}
        wheel_turns = self.spec.get('gear', 1)
        for wheel in ('wheel_f', 'wheel_r'):
            i = names[wheel]
            base = quat_to_mat(self.doc['nodes'][i].get('rotation', [0, 0, 0, 1]))
            channel(i, 'rotation', continuous([mat_to_quat(base @ axis_angle(Z, -2 * math.pi * wheel_turns * k / FRAMES))
                                               for k in range(FRAMES + 1)]))
        if self.spec['kind'] == 'bicycle':
            i = names['pedals_geo']
            base = quat_to_mat(self.doc['nodes'][i].get('rotation', [0, 0, 0, 1]))
            centre = np.array(self.doc['nodes'][i]['translation'])
            assert np.allclose(centre, self.rig['points']['PedalsGeo'], atol=2e-3)
            channel(i, 'rotation', continuous([mat_to_quat(axis_angle(Z, -2 * math.pi * k / FRAMES) @ base)
                                               for k in range(FRAMES + 1)]))
            for s, node in (('L', 'left_pedal_geo'), ('R', 'right_pedal_geo')):
                j = names[node]
                start = np.array(self.doc['nodes'][j]['translation'])
                assert np.allclose(start, self.pedal_points(0)[s], atol=2e-3)
                channel(j, 'translation', [self.pedal_points(k / FRAMES)[s] for k in range(FRAMES + 1)])
            for s in SIDES:
                for bone in (f'crl_thigh__{s}', f'crl_leg__{s}', f'crl_foot__{s}'):
                    j = frames[0].id(bone)
                    channel(j, 'rotation', continuous([mat_to_quat(f.r[j]) for f in frames]))
        self.meters_per_cycle = 2 * math.pi * self.wheel_radius() * wheel_turns
        anim['extras'] = {'phaseDriver': 'odometer', 'metersPerCycle': round(self.meters_per_cycle, 6),
                          'cycle': 'crank revolution' if self.spec['kind'] == 'bicycle' else 'wheel revolution',
                          'wheelTurnsPerCycle': wheel_turns}
        self.doc['animations'] = [anim]

    def wheel_radius(self):
        names = {n.get('name'): n for n in self.doc['nodes'][:self.off['nodes']]}
        return float(np.mean([names[w]['translation'][1] for w in ('wheel_f', 'wheel_r')]))

    def extras(self):
        extras = self.doc['asset'].setdefault('extras', {})
        extras['rider'] = {
            'node': 'rider', 'semanticClass': 'rider', 'source': self.ped_source,
            'pedestrian': f"walker.pedestrian.{self.spec['pedestrian']}",
            'carlaBlueprint': self.rig['blueprint'], 'animBlueprint': 'AB_Biker (re-evaluated offline)',
            'gripPose': 'AS_Pedestrian_BikeHands', 'clip': 'ride', 'metersPerCycle': round(self.meters_per_cycle, 6),
            'slots': self.slots, 'helmet': self.spec.get('helmet'),
            'variants': 1 + len(PALETTES),
            'palettes': [None] + [{k: v for k, v in p.items() if k in self.slots} for p in PALETTES],
        }
        extras['riderPoseReport'] = {
            'torsoLeanDeg': round(self.lean_deg, 2), 'seatSlideM': round(self.slide, 3), 'hipDropM': round(self.hip_drop, 4),
            'maxLegReach': round(self.leg_reach, 4), 'armReach': {k: round(v, 4) for k, v in self.arm_reach.items()},
        }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--bike-dir', type=Path, required=True)
    ap.add_argument('--pedestrian-dir', type=Path, required=True)
    ap.add_argument('--bikehands', type=Path, default=Path(__file__).with_name('bikehands-pose.json'))
    ap.add_argument('--rigs', type=Path, default=Path(__file__).with_name('rigs.json'))
    ap.add_argument('--out', type=Path, required=True)
    ap.add_argument('--only', nargs='*')
    args = ap.parse_args()
    clip = json.loads(args.bikehands.read_text())
    assert clip['name'] == 'AS_Pedestrian_BikeHands' and clip['skeleton'] == 'Skel_Pedestrian_G2', args.bikehands
    rigs = json.loads(args.rigs.read_text())['models']
    report = {}
    for vid, spec in MODELS.items():
        if args.only and vid not in args.only:
            continue
        b = RiderBuilder(vid, spec, rigs[vid], args.bike_dir / f'vehicle_{vid}.glb',
                         args.pedestrian_dir / f"pedestrian_{spec['pedestrian']}.glb", clip)
        data = b.build()
        out = args.out / f'vehicle_{vid}_rider.glb'
        out.write_bytes(data)
        report[vid] = dict(file=out.name, bytes=len(data), sha256=hashlib.sha256(data).hexdigest(),
                           **b.doc['asset']['extras']['riderPoseReport'])
        print(json.dumps({vid: report[vid]}))


if __name__ == '__main__':
    main()
