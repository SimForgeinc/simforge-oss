"""Contract tests for the Python face of the shared render-timeline sampler."""

from __future__ import annotations

import math
from pathlib import Path

import pytest

import simforge_oss_timeline as st

REPO = Path(__file__).resolve().parents[3]
EXAMPLE = REPO / "examples/edge-cases/03-red-light-ambulance-preemption/scenario.trace.json.gz"


@pytest.fixture(scope="module")
def timeline() -> st.Timeline:
    return st.Timeline.from_json(st.build_timeline(EXAMPLE.read_bytes(), plane=(3.0, 0.02, -0.01)))


def test_versions_and_identity(timeline: st.Timeline) -> None:
    assert st.RENDER_TIMELINE_VERSION == "simforge.render-timeline.v1"
    assert st.SAMPLER_VERSION == "simforge.timeline-sampler/2"
    assert st.TIMELINE_DT_S == 0.02
    assert timeline.dt == 0.02
    assert timeline.trace_sha256 == st.trace_sha256(EXAMPLE.read_bytes())
    assert len(timeline.key) == 64 and len(timeline.sha256) == 64
    again = st.Timeline.from_json(timeline.to_json())
    assert again.sha256 == timeline.sha256


def test_pose_contract_fields(timeline: st.Timeline) -> None:
    p = st.pose(timeline, "focus-vehicle", 3.01)
    for key in ("present", "x", "y", "z", "headingRad", "pitchRad", "rollRad", "speedMps", "velocity", "acceleration"):
        assert key in p
    assert p["present"] is True
    assert p["z"] == pytest.approx(3.0 + 0.02 * p["x"] - 0.01 * p["y"], abs=2e-4)
    assert p["velocity"][0] == pytest.approx(p["speedMps"] * math.cos(p["headingRad"]), abs=1e-12)
    assert p == timeline.pose("focus-vehicle", 3.01)


def test_exact_at_ticks_and_despawn_edge(timeline: st.Timeline) -> None:
    times = timeline.times
    ambulance = timeline.actor("ambulance")
    despawn = ambulance["lifecycle"][0]["despawnTick"]
    assert despawn is not None
    last = timeline.pose("ambulance", times[despawn - 1])
    held = timeline.pose("ambulance", (times[despawn - 1] + times[despawn]) / 2)
    assert held["present"] and held["x"] == last["x"] and held["headingRad"] == last["headingRad"]
    assert timeline.pose("ambulance", times[despawn])["present"] is False


def test_domain_and_unknown_actor(timeline: st.Timeline) -> None:
    with pytest.raises(ValueError):
        timeline.pose("focus-vehicle", -0.5)
    with pytest.raises(ValueError):
        timeline.pose("focus-vehicle", timeline.clip_end_s + 0.5)
    with pytest.raises(KeyError):
        timeline.pose("nobody", 1.0)


def test_signals_lights_and_batch(timeline: st.Timeline) -> None:
    signalled = REPO / "examples/edge-cases/04-child-emerging-behind-bus/scenario.trace.json.gz"
    other = st.Timeline.from_json(st.build_timeline(signalled.read_bytes(), flat_z=0.0))
    signals = other.signals_at(10.0)
    assert signals and all(isinstance(v, str) for v in signals.values())
    lights = timeline.lights_at("ambulance", 5.0)
    assert set(lights) == {"lowBeam", "brake", "reverse", "indicatorLeft", "indicatorRight", "emergency"}
    all_poses = timeline.poses(5.0)
    assert sorted(all_poses) == timeline.actor_ids
    assert timeline.pose_array("focus-vehicle", 5.0)[1] == all_poses["focus-vehicle"]["x"]
    assert len(timeline.pose_array("focus-vehicle", 5.0)) == st.POSE_ARRAY_LEN


def test_other_dt_is_rejected() -> None:
    import gzip
    import json

    doc = json.loads(gzip.decompress(EXAMPLE.read_bytes()))
    doc["header"]["dt"] = 0.05
    with pytest.raises(ValueError, match="dt"):
        st.build_timeline(json.dumps(doc), flat_z=0.0)


def test_parity_comparator_grades_observations(timeline: st.Timeline) -> None:
    import json as _json

    lines = []
    for k in range(40):
        t = k * 0.1
        actors = []
        for actor_id, p in timeline.poses(t).items():
            if p["present"]:
                actors.append({"id": actor_id, "position": [p["x"], p["y"] + 0.003, p["z"]],
                               "headingRad": p["headingRad"], "pitchRad": p["pitchRad"], "rollRad": p["rollRad"]})
        lines.append(_json.dumps({"t": t, "actors": actors}))
    report = st.compare_observed(timeline, "\n".join(lines), "carla")
    assert report["schema"] == "simforge.render-parity/v1"
    assert report["pass"] is True
    assert report["maxHorizontalErrorM"] == pytest.approx(0.003, abs=1e-9)
    strict = dict(report["profile"], positionToleranceM=0.001)
    assert st.compare_observed(timeline, "\n".join(lines), strict)["pass"] is False
