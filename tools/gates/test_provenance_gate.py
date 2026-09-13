#!/usr/bin/env python3
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import provenance_gate as gate


def mini_trace(pair=("ego", "child"), profile="sensor-limited"):
    return {
        "header": {
            "ego": {"controllerProfile": profile},
            "operationalConditions": {
                "visibility": "restricted",
                "effects": {"visibilityRangeM": 80, "frictionScale": 0.4},
            },
        },
        "metrics": {
            "collisions": [],
            "minTTC": {"pair": list(pair), "t": 5.0, "value": 0.8},
            "minDistance": [{"pair": ["ego", "ambient:1"], "t": 3.0, "minDistanceM": 0.1}],
            "declaredOcclusion": [{"observerId": "ego", "targetId": "child", "t": 4.8}],
        },
    }


def mini_instance():
    return {"input": {"actors": [
        {"id": "ego", "kind": "car", "tags": ["role:ego"]},
        {"id": "child", "kind": "pedestrian", "tags": ["role:child", "catalog:pedestrian.child"]},
        {"id": "ambient:1", "kind": "car", "tags": []},
    ]}}


class ProvenanceGateTests(unittest.TestCase):
    def test_extracts_ttc_event_over_incidental_distance(self):
        event = gate.extract_critical_event(mini_trace())
        self.assertEqual(event, {"kind": "min-ttc", "t": 5.0, "value": 0.8,
                                 "actors": ["ego", "child"]})

    def test_attributes_criticality_to_designated_hazard(self):
        brief = {"brief": "A child emerges into the ego path.", "hazardActorIds": ["child"]}
        verdict = gate.check_provenance(mini_trace(), mini_instance(), brief)
        self.assertTrue(verdict["pass"])
        self.assertEqual(verdict["reasons"], [])

        corrupted = gate.check_provenance(mini_trace(("ego", "ambient:1")), mini_instance(), brief)
        self.assertFalse(corrupted["pass"])
        self.assertEqual(corrupted["reasons"][0]["code"], "critical-event-wrong-actors")

        instance = mini_instance()
        instance["input"]["actors"][1]["id"] = "bystander"
        corrupted = gate.check_provenance(mini_trace(), instance, brief)
        self.assertFalse(corrupted["pass"])
        self.assertEqual(corrupted["reasons"][0]["code"], "designated-hazard-missing")

    def test_verifies_named_preconditions_in_critical_window(self):
        brief = {"brief": "A child emerges from behind an occluder on a wet low-grip road.",
                 "hazardActorIds": ["child"]}
        checks = gate.verify_preconditions(mini_trace(), mini_instance(), brief,
                                           gate.extract_critical_event(mini_trace()))
        self.assertEqual({row["name"]: row["held"] for row in checks},
                         {"occlusion": True, "reduced-friction": True})

        trace = mini_trace()
        trace["metrics"]["declaredOcclusion"][0]["t"] = 2.0
        trace["header"]["operationalConditions"]["effects"]["frictionScale"] = 1
        checks = gate.verify_preconditions(trace, mini_instance(), brief,
                                           gate.extract_critical_event(trace))
        self.assertEqual({row["name"]: row["held"] for row in checks},
                         {"occlusion": False, "reduced-friction": False})

    def test_rejects_missing_and_legacy_controller_profiles(self):
        brief = {"brief": "A child crosses.", "hazardActorIds": ["child"]}
        missing = mini_trace()
        del missing["header"]["ego"]
        self.assertEqual(gate.check_provenance(missing, mini_instance(), brief)["reasons"][0]["code"],
                         "controller-profile-missing")
        legacy = mini_trace(profile="omniscient-legacy")
        self.assertEqual(gate.check_provenance(legacy, mini_instance(), brief)["reasons"][0]["code"],
                         "controller-profile-untrusted")


if __name__ == "__main__":
    unittest.main()
