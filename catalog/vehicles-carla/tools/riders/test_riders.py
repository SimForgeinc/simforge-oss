#!/usr/bin/env python3
"""python3 -m unittest test_riders  (from this directory)."""
import hashlib
import json
import math
import tempfile
import unittest
from pathlib import Path

import numpy as np

import build_riders
from rider_ik import Pose, axis_angle, mat_to_quat, quat_to_mat, two_bone

HERE = Path(__file__).resolve().parent
PACK = HERE.parents[1]


def chain():
    # A straight three-joint chain hanging down -Y from the origin (a leg).
    nodes = [{'name': 'a', 'children': [1]}, {'name': 'b', 'translation': [0, -0.45, 0], 'children': [2]},
             {'name': 'c', 'translation': [0, -0.43, 0]}]
    return Pose(nodes, 0, (np.eye(3), np.zeros(3)))


class RiderIk(unittest.TestCase):
    def test_quaternion_round_trip(self):
        for axis, angle in (((1, 0, 0), 0.3), ((0, 1, 1), 2.9), ((1, -2, 0.5), -1.2)):
            m = axis_angle(axis, angle)
            self.assertTrue(np.allclose(quat_to_mat(mat_to_quat(m)), m, atol=1e-9))

    def test_two_bone_reaches_and_bends_about_its_hinge(self):
        rest = chain()
        pose = rest.copy()
        target = np.array([0.25, -0.6, 0.05])
        reach = two_bone(pose, rest, 'a', 'b', 'c', target, pole=np.array([1.0, 0, 0]), motion=np.array([-1.0, 0, 0]))
        self.assertLess(reach, 1.0)
        self.assertLess(np.linalg.norm(pose.pos('c') - target), 1e-6)
        # Knee goes toward the pole (forward), never sideways past the target plane.
        self.assertGreater(pose.pos('b')[0], 0.0)
        self.assertAlmostEqual(np.linalg.norm(pose.pos('b') - pose.pos('a')), 0.45, places=9)

    def test_unreachable_target_clamps_without_stretching(self):
        rest = chain()
        pose = rest.copy()
        reach = two_bone(pose, rest, 'a', 'b', 'c', np.array([0, -2.0, 0]), np.array([1.0, 0, 0]), np.array([-1.0, 0, 0]))
        self.assertGreater(reach, 1.0)
        self.assertAlmostEqual(np.linalg.norm(pose.pos('c') - pose.pos('a')), 0.88, places=3)

    def test_fnv1a32_matches_the_catalog_contract(self):
        self.assertEqual(build_riders.fnv1a32(''), 0x811C9DC5)
        self.assertEqual(build_riders.fnv1a32('a'), 0xE40C292C)


class RiderBuild(unittest.TestCase):
    def test_builds_are_byte_identical_to_the_committed_models(self):
        manifest = json.loads((PACK / 'manifest.json').read_text())['vehicles']
        rigs = json.loads((HERE / 'rigs.json').read_text())['models']
        pose = json.loads((HERE / 'bikehands-pose.json').read_text())
        for vid in ('bicycle_gazelle_omafiets', 'motorcycle_harley'):
            spec = build_riders.MODELS[vid]
            builder = build_riders.RiderBuilder(
                vid, spec, rigs[vid], PACK / 'models' / f'vehicle_{vid}.glb',
                PACK.parent / 'pedestrians-carla' / 'models' / f"pedestrian_{spec['pedestrian']}.glb", pose)
            data = builder.build()
            self.assertEqual(hashlib.sha256(data).hexdigest(), manifest[f'vehicle_{vid}_rider']['sha256'], vid)

    def test_pedal_cycle_is_closed(self):
        rigs = json.loads((HERE / 'rigs.json').read_text())['models']
        spec = build_riders.MODELS['bicycle_bh_crossbike']
        b = build_riders.RiderBuilder.__new__(build_riders.RiderBuilder)
        b.spec, b.rig = spec, rigs['bicycle_bh_crossbike']
        for side in 'LR':
            self.assertTrue(np.allclose(b.pedal_points(0.0)[side], b.pedal_points(1.0)[side]))
            self.assertTrue(np.allclose(b.pedal_points(0.0)[side], np.array(b.rig['points'][
                'LeftPedalGeo' if side == 'L' else 'RightPedalGeo']), atol=1e-9))


if __name__ == '__main__':
    unittest.main()
