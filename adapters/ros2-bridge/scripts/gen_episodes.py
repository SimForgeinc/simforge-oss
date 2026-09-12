#!/usr/bin/env python3
"""Regenerate the bridge's self-contained episode specs on the synthetic
two-lane straight (no external map assets, no Node):

- ``synthetic-straight.episodes.json``   externally controlled ego only
  (smoke test)
- ``autoware-lanechange.episodes.json``  ego plus one PARKED ground-truth
  vehicle in the ego's start lane past the lane-change zone — the object the
  Autoware bridge publishes as ``PredictedObjects`` and the authored route
  lane-changes around

Both use ``dynamic-v1`` physics (raw throttle/brake/steer passthrough) with a
30 s clip and a 2 s warm-up, and are validated through the native runtime
before being written. The synthetic topology and the vehicle template come
from the SDK's own dynamic fixture so the three stay in lockstep.

    python3 adapters/ros2-bridge/scripts/gen_episodes.py [config/episodes]
"""

from __future__ import annotations

import copy
import json
import sys
from pathlib import Path
from typing import Any

from simforge_oss_gym.native import LaneGraph, ScenarioInput

_REPO = Path(__file__).resolve().parents[3]
_FIXTURE = _REPO / "adapters" / "gym" / "tests" / "fixtures" / "synthetic-episode.json"
_START_RSL = "1:0:-1"


def _vehicle(template: dict[str, Any], *, actor_id: str, s: float, speed_mps: float) -> dict[str, Any]:
    actor = copy.deepcopy(template)
    actor["id"] = actor_id
    actor["initial"] = {
        "laneRef": {"rsl": _START_RSL, "s": s, "tFrac": 0},
        "pose": {"x": s, "z": 0, "headingRad": 0},
        "speedMps": speed_mps,
    }
    actor["behavior"]["route"] = {"kind": "follow", "startRsl": _START_RSL, "turns": [], "maxLengthM": 2000}
    actor["behavior"]["cruiseSpeedMps"] = speed_mps
    return actor


def _spec(base: dict[str, Any], topology: dict[str, Any], actors: list[dict[str, Any]]) -> dict[str, Any]:
    input = copy.deepcopy(base)
    input.update(clipSeconds=30, warmupSeconds=2, seed="fixture", physics={"mode": "dynamic-v1"}, actors=actors)
    input.pop("metricSubject", None)  # single ego: the lowest-id vehicle is the subject
    input["interactions"] = []
    document = json.dumps(input)
    ScenarioInput.parse(document)
    LaneGraph.from_topology(json.dumps(topology).encode())
    return {"version": 1, "episode": {"decisionHz": 10}, "instances": [{"input": json.loads(document), "topology": topology}]}


def main() -> int:
    out_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[1] / "config" / "episodes"
    fixture = json.loads(_FIXTURE.read_text())
    instance = fixture["instances"][0]
    base, topology = instance["input"], instance["topology"]
    template = next(a for a in base["actors"] if a["kind"] == "vehicle")

    ego = _vehicle(template, actor_id="ego", s=50, speed_mps=8)
    parked = _vehicle(template, actor_id="npc-parked", s=185, speed_mps=0)
    for name, actors in (
        ("synthetic-straight.episodes.json", [ego]),
        ("autoware-lanechange.episodes.json", [ego, parked]),
    ):
        path = out_dir / name
        path.write_text(json.dumps(_spec(base, topology, actors), indent=2) + "\n")
        print(f"wrote {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
