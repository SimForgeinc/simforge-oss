"""Author genuine multi-vehicle episodes on an installed OpenDRIVE corridor."""
import json
from pathlib import Path
from simforge_oss_gym import native
from simforge_oss_gym.episodes import map_dir

MAP_ID = "garching-phase-1-2"
LANE = "160:0:-3"


def author(destination, bad_actor=False):
    bundle = native.MapBundle.load(str(map_dir(MAP_ID)))
    graph = bundle.graph
    control = json.loads(bundle.control_plan_json())
    route = {"kind": "lanePath", "lanes": [LANE]}
    # 874 m of real lane, almost straight over this 350 m segment; no signal
    # or stop control intersects it. Keep the complete map control book anyway.
    if any(s["rsl"] == LANE for key in ("signalPrograms", "roadControls") for p in control[key] for s in p.get("stopLines", [])):
        raise ValueError("chosen corridor is controlled")
    actors = []
    starts = [("alpha", 100.0, 6.0 if bad_actor else 9.0, 17.0 if bad_actor else 10.0),
              ("bravo", 195.0 if bad_actor else 145.0, 7.0, 7.0),
              ("charlie", 242.0 if bad_actor else 192.0, 6.0, 6.0)]
    for aid, s, speed, cruise in starts:
        x, y, heading = graph.sample_lane(LANE, s)
        persona = "reckless" if bad_actor and aid == "alpha" else "cooperative"
        actors.append({"id": aid, "kind": "car", "dims": {"l": 4.7, "w": 1.82, "h": 1.45},
                       "initial": {"laneRef": {"rsl": LANE, "s": s, "tFrac": 0},
                                   "pose": {"x": x, "z": -y, "headingRad": heading}, "speedMps": speed},
                       "behavior": {"route": route, "cruiseSpeedMps": cruise,
                                    "rules": {"obeySignals": True, "yieldToVehicles": True, "yieldToPedestrians": True,
                                              "collisionAvoidance": True, "aggression": 0.5, "speedFactor": 1.0}},
                       "presentAtStart": True, "static": False,
                       "tags": ["catalog:vehicle.sedan", "persona:" + persona, "controlled:jev"]})
    data = {"schemaVersion": 1, "mapId": MAP_ID, "clipSeconds": 20.0, "warmupSeconds": 0.0,
            "dt": 0.02, "seed": "jev-multidriver-1", "physics": {"mode": "dynamic-v1"},
            "operationalConditions": {"weather": "clear", "timeOfDay": "day", "traffic": "moderate", "visibility": "unrestricted",
                                      "effects": {"visibilityRangeM": 1000.0, "frictionScale": 1.0, "trafficSpeedFactor": 1.0}},
            "metricSubject": "alpha", "actors": actors, "interactions": [],
            **control, "surfacePatches": [], "props": [], "occluders": [], "occlusionPairs": []}
    # Parsing here verifies native schema, not just JSON syntax.
    normalized = json.loads(native.ScenarioInput.parse(json.dumps(data)).to_json())
    Path(destination).write_text(json.dumps({"version": 1, "instances": [{"input": normalized}]}, indent=2))
