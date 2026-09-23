"""Episode-runner behaviour: timing modes, warm-up, envelope truncation, refusals.

These are the regressions for the campaign boundary repair: the evaluation
campaign spawns exactly this module, so the argv contract, the summary
document and the trace's digest identity are the interface both hosts and the
cloud worker depend on.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from simforge_oss_gym.episodes import load_episode_spec
from simforge_oss_gym.native import Episode, NativeError
from simforge_oss_gym.replay_envelope import load_replay_context
from simforge_oss_gym.tools.episode_trace import verify_trace
from simforge_oss_gym.tools.endpoint_policy import waypoints_to_plan
from simforge_oss_gym.tools.policies import make_policy
from simforge_oss_gym.tools.policy_runner import run_episode


def _trace_records(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def test_offline_mode_has_no_deadline_and_reproduces_its_digest(spec: str, tmp_path: Path) -> None:
    digests = []
    for run in range(2):
        trace = tmp_path / f"offline-{run}.jsonl"
        summary = run_episode(
            load_episode_spec(spec).episodes[0], make_policy("scripted"),
            seed=101, mode="offline-simtime", decision_hz=10,
            max_steps=12, trace_path=trace,
        )
        assert summary.mode == "offline-simtime"
        assert summary.status in ("completed", "terminated", "truncated")
        # No deadline exists in this mode, so a miss is impossible by construction.
        assert summary.deadline_misses == 0
        records = _trace_records(trace)
        assert records[0]["reset"]["mode"] == "offline-simtime"
        assert records[0]["reset"]["deadline_ms"] is None
        assert all(record.get("miss") == 0 for record in records if "step" in record)
        digests.append(summary.episode_digest)
    assert digests[0] == digests[1], "same seed and policy must reproduce the chained digest"


def test_realtime_mode_applies_the_fallback_on_a_forced_miss(spec: str, tmp_path: Path) -> None:
    trace = tmp_path / "realtime.jsonl"
    summary = run_episode(
        load_episode_spec(spec).episodes[0], make_policy("scripted"),
        seed=101, mode="realtime", decision_hz=10, deadline_ms=50.0,
        fallback="zero-control", max_steps=12, force_miss_at=(3,),
        trace_path=trace,
    )
    assert summary.mode == "realtime"
    assert summary.deadline_misses == 1
    missed = [record for record in _trace_records(trace) if record.get("step") == 3]
    assert missed and missed[0]["miss"] == 1
    assert missed[0]["applied"] == "zero-control"


def test_realtime_requires_a_deadline_and_offline_refuses_forced_misses(spec: str) -> None:
    episode = load_episode_spec(spec).episodes[0]
    with pytest.raises(ValueError, match="realtime mode requires"):
        run_episode(episode, make_policy("scripted"), seed=1, mode="realtime", max_steps=1)
    with pytest.raises(ValueError, match="force_miss_at is meaningless"):
        run_episode(episode, make_policy("scripted"), seed=1, mode="offline-simtime", max_steps=1, force_miss_at=(1,))


def test_warmup_steps_are_labelled_and_not_counted_as_model_decisions(spec: str, tmp_path: Path) -> None:
    trace = tmp_path / "warmup.jsonl"
    summary = run_episode(
        load_episode_spec(spec).episodes[0], make_policy("trajectory"),
        seed=101, mode="offline-simtime", decision_hz=10, max_steps=8,
        warmup_policy=make_policy("scripted"), warmup_steps=4, trace_path=trace,
    )
    raw, digest = verify_trace(trace.with_suffix(".episode-v2.jsonl").read_text())
    warmup = [row for row in raw if row.get("phase") == "warmup"]
    assert len(warmup) == 4
    assert all(row["pol"] == "warmup:scripted" for row in warmup)
    steps = [record for record in _trace_records(trace) if "step" in record]
    assert len(steps) == summary.model_decisions == 4
    assert all(row["pol"] == "scripted-trajectory" for row in steps)
    assert _trace_records(trace)[0]["reset"]["t"] == warmup[-1]["t"]
    assert summary.warmup_steps == 4 and summary.source_episode_digest == digest


def test_warmup_termination_preserves_partial_kernel_result(spec: str, tmp_path: Path) -> None:
    summary = run_episode(
        load_episode_spec(spec).episodes[0], make_policy("trajectory"), seed=101,
        episode_config={"clipSeconds": 0.2}, max_steps=8,
        warmup_policy=make_policy("scripted"), warmup_steps=4,
        trace_path=tmp_path / "partial.jsonl",
    )
    assert summary.result_status == "partial"
    assert summary.truncation == "warmup_terminated"
    assert summary.model_decisions == 0


def _write_bundle(directory: Path, *, qualified: bool, lateral_m: float, poses: int = 40) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "replay-context.json").write_text(
        json.dumps(
            {
                "schema": "simforge.replay-context/v1",
                "sceneId": directory.name,
                "source": {"kind": "user-bundle"},
                "cameras": [{"cameraId": index, "sensorId": f"s{index}", "width": 2, "height": 2} for index in (0, 1, 2, 6)],
                "ego": {
                    "originUs": 0,
                    "endUs": poses * 100_000,
                    "recordedPath": [
                        {"tUs": step * 100_000, "x": step * 0.8, "y": 0.0, "headingRad": 0.0} for step in range(poses)
                    ],
                },
                "dynamics": {"tracks": []},
                "geometry": {},
                "map": {},
                "validity": {
                    "qualified": qualified,
                    "envelope": {"lateralM": lateral_m, "longitudinalS": 0.5, "headingRad": 0.2},
                    "gates": {f"G{index}": {"id": f"G{index}", "passed": qualified} for index in range(1, 6)},
                    "envelopeBasis": {"largestPassingLateralM": lateral_m},
                },
            }
        )
    )
    return directory


def test_unqualified_bundle_refuses_a_model_episode(spec: str, tmp_path: Path) -> None:
    bundle = _write_bundle(tmp_path / "unqualified", qualified=False, lateral_m=0.0)
    context = load_replay_context(bundle)
    with pytest.raises(NativeError, match="replay_context_unqualified"):
        run_episode(load_episode_spec(spec).episodes[0], make_policy("scripted"),
                    seed=101, replay=context, max_steps=4)


def test_kernel_envelope_projects_onto_segments_and_stops_at_time_support(spec: str, tmp_path: Path) -> None:
    loaded = load_episode_spec(spec).episodes[0]
    context = load_replay_context(_write_bundle(tmp_path / "short", qualified=True, lateral_m=1.0))
    settings = {"scenario": json.loads(loaded.input.to_json()), "seed": 101,
                "observation": {"channels": [{"kind": "state"}]}}
    probe = Episode(json.dumps(settings), loaded.graph)
    initial = json.loads(probe.reset())["stateVector"]
    probe.close()
    x, y = initial[:2]
    replay = context.episode_context()
    replay.update(recordedPath=[[0, x - 0.4, y, 0], [0.15, x + 4.0, y, 0]],
                  longitudinalS=10.0)
    kernel = Episode(json.dumps({**settings, "replayContext": replay}), loaded.graph)
    kernel.reset()
    reset = json.loads(kernel.trace_json().splitlines()[0])["reset"]
    assert reset["env"]["inside"] is True
    assert reset["env"]["lateralM"] == pytest.approx(0.0, abs=1e-9)
    first = json.loads(kernel.step(json.dumps({"k": "s", "speedMps": 8.0})))
    assert first["envelope"]["inside"] is True
    second = json.loads(kernel.step(json.dumps({"k": "s", "speedMps": 8.0})))
    assert second["truncated"] and second["termReason"] == "envelope_exceeded"
    assert "time-support" in second["envelope"]["breached"]
    assert json.loads(kernel.finish())["status"] == "partial"
    kernel.close()


def test_endpoint_policy_refuses_without_a_real_frame_source(spec: str) -> None:
    proc = subprocess.run(
        [
            sys.executable,
            "-m",
            "simforge_oss_gym.tools.policy_runner",
            "--spec",
            spec,
            "--policy",
            "endpoint",
            "--endpoint-socket",
            "/tmp/simforge-nonexistent.sock",
            "--steps",
            "1",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 2
    payload = json.loads(proc.stdout.strip().splitlines()[-1])
    assert payload["status"] == "failed"
    # No frames means no episode — never a synthesized observation.
    assert payload["error"]["code"] == "frame_source_required"


def test_waypoints_become_a_policy_step_plan_with_derived_heading_and_speed() -> None:
    plan = waypoints_to_plan([[0.8, 0.0, 0.0], [1.6, 0.0, 0.0], [2.4, 0.8, 0.0]], dt_s=0.1)
    assert len(plan) == 3
    # First row is one dt in the future, measured from the ego origin at t0.
    assert plan[0] == pytest.approx((0.8, 0.0, 0.0, 8.0, 0.1))
    # Speed is the segment length over dt; heading the segment direction.
    assert plan[2][3] == pytest.approx(11.3137, abs=1e-3)
    assert plan[2][2] == pytest.approx(0.7853982, abs=1e-6)
    assert [row[4] for row in plan] == pytest.approx([0.1, 0.2, 0.3])


