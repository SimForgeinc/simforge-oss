"""Sub-clip rendering and deterministic refusals of `run-intent`.

A render intent may ask for part of the authored clip (`renderSpec.clip`),
exactly as the native engine renders it: output frame ``k`` shows clip time
``startSeconds + k / fps``. Trace replay seeks to the start by spawning every
body at its start-tick pose, so a sub-clip's frames are the corresponding
frames of the full-clip render. What CARLA cannot render exactly is refused
with a machine code, never widened to the full clip.
"""
from __future__ import annotations

import gzip
import hashlib
import io
import json
import sys
from contextlib import redirect_stdout

import pytest

from simforge_oss_carla_exec import local
from simforge_oss_carla_exec.runtime import executor as worker_runner
from simforge_oss_carla_exec.runtime.compiler import ExecutionPlan, PlanFrame
from simforge_oss_carla_exec.runtime.contract import OFFICIAL_XSD_SHA256, ContractError, canonical_json, parse_lease
from simforge_oss_carla_exec.runtime.executor import execute_lease
from simforge_oss_carla_exec.runtime.policy import CarlaRenderError
from simforge_oss_carla_exec.runtime.timeline import resolve_render_window

import test_runtime as rt


def _digest(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()


#: The runtime fixture stretched to a 1 s clip: the ego drives 5 m.
LONG_XOSC = rt.XOSC.replace(
    b'<Vertex time="0.04"><Position><WorldPosition x="0.2"',
    b'<Vertex time="1"><Position><WorldPosition x="5"',
)
assert LONG_XOSC != rt.XOSC
LONG_TRAFFIC = canonical_json({
    "schema": "simforge.materialized-traffic.v1",
    "sourceInputDigest": rt.SOURCE_INPUT_DIGEST,
    "map": {"assetId": "map-asset-1", "versionId": "map-version-1"},
    "provider": {"id": "disabled", "version": "none", "seed": ""},
    "fixedStepSeconds": 0.02,
    "durationSeconds": 1.0,
    "actors": [],
    "signals": [],
}).encode()


def _plan(seconds: float = 20.0) -> ExecutionPlan:
    frames = tuple(PlanFrame(index, round(index * 0.02, 9), {}, {}) for index in range(round(seconds / 0.02) + 1))
    return ExecutionPlan("simforge.execution-plan/v1", 0.02, {}, frames, "a" * 64)


def code_of(excinfo) -> str:
    assert isinstance(excinfo.value, CarlaRenderError), excinfo.value
    return excinfo.value.code


# -- the window ------------------------------------------------------------------

def test_no_clip_and_the_authored_clip_are_the_full_render():
    plan = _plan()
    for clip in (None, (0.0, 20.0)):
        window = resolve_render_window(plan, clip, "trace-replay")
        assert (window.start_tick, window.end_tick, window.full) == (0, 1000, True)
        assert window.restrict(plan) is plan


def test_a_prefix_and_a_later_window_land_on_their_ticks():
    plan = _plan()
    prefix = resolve_render_window(plan, (0.0, 10.0), "trace-replay")
    assert (prefix.start_tick, prefix.end_tick, prefix.full) == (0, 500, False)
    assert prefix.duration_s(plan) == pytest.approx(10.0)
    later = resolve_render_window(plan, (2.5, 7.5), "trace-replay")
    assert (later.start_tick, later.end_tick, later.tick_count) == (125, 375, 251)
    restricted = later.restrict(plan)
    assert restricted.sha256 == plan.sha256
    assert [frame.index for frame in restricted.frames] == list(range(125, 376))
    assert later.evidence(plan)["seek"] == "spawn-at-start-tick-pose"


def test_windows_carla_cannot_render_exactly_are_refused_with_a_code():
    plan = _plan()
    with pytest.raises(CarlaRenderError) as beyond:
        resolve_render_window(plan, (0.0, 25.0), "trace-replay")
    assert code_of(beyond) == "carla_clip_outside_scenario"
    # Physics validation integrates and grades the whole authored clip.
    for clip in ((2.0, 10.0), (0.0, 10.0)):
        with pytest.raises(CarlaRenderError) as physics:
            resolve_render_window(plan, clip, "native-physics")
        assert code_of(physics) == "carla_clip_physics_validation_partial"
    assert resolve_render_window(plan, (0.0, 20.0), "native-physics").full
    with pytest.raises(CarlaRenderError) as short:
        resolve_render_window(plan, (1.011, 1.019), "trace-replay")
    assert code_of(short) == "carla_clip_too_short"
    with pytest.raises(ContractError):
        resolve_render_window(plan, (3.0, 2.0), "trace-replay")


@pytest.mark.parametrize("fps", [20, 24, 25, 30])
def test_a_sub_clip_schedules_exactly_the_full_clips_frames_for_those_seconds(fps):
    plan = _plan()
    full = worker_runner._capture_schedule(plan, fps)
    start, end = 2.0, 12.0
    window = resolve_render_window(plan, (start, end), "trace-replay")
    sub = worker_runner._capture_schedule(plan, fps, window=window)
    offset = round(start * fps)
    assert len(sub) == round((end - start) * fps)
    for tick, (index, scheduled, content) in sub.items():
        # Same tick, same instant (bit-exact), output index shifted by the start.
        assert full[tick] == (index + offset, scheduled, content)
    assert min(sub) == window.start_tick
    assert max(sub) < window.end_tick


def test_a_fractional_frame_count_is_refused_not_rounded():
    plan = _plan()
    window = resolve_render_window(plan, (0.0, 10.01), "trace-replay")
    with pytest.raises(CarlaRenderError) as fractional:
        worker_runner._capture_schedule(plan, 24, window=window)
    assert code_of(fractional) == "carla_clip_frame_count_fractional"


# -- execution ---------------------------------------------------------------------

def _long_lease(clip=None, outputs=("trace", "annotations")):
    value = rt.lease_value(outputs=list(outputs))
    job = value["job"]
    package = job["executionPackage"]
    package["xosc"] = {**package["xosc"], "sha256": _digest(LONG_XOSC), "sizeBytes": len(LONG_XOSC)}
    package["ambient"]["resultSha256"] = _digest(LONG_TRAFFIC)
    package["ambient"]["materializedTraffic"] = {
        "url": "memory:traffic", "sha256": _digest(LONG_TRAFFIC), "sizeBytes": len(LONG_TRAFFIC),
    }
    if clip is not None:
        job["renderSpec"]["clip"] = {"startSeconds": clip[0], "endSeconds": clip[1]}
    manifest = rt.execution_manifest(
        xosc=LONG_XOSC,
        ambient={
            "mode": "disabled", "ambientConfig": {},
            "configSha256": _digest(b"{}"), "resultSha256": _digest(LONG_TRAFFIC),
        },
        traffic=LONG_TRAFFIC,
    )
    return parse_lease(rt.seal_lease(value, manifest)), manifest


def _execute(clip=None):
    lease, manifest = _long_lease(clip)
    assets = {
        "memory:manifest": manifest, "memory:xosc": LONG_XOSC, "memory:xodr": rt.XODR,
        "memory:catalog": rt.CATALOG, "memory:traffic": LONG_TRAFFIC,
    }
    uploaded: dict[str, bytes] = {}
    backend = rt.FakeBackend()
    result = execute_lease(
        lease, backend,
        lambda body: {"valid": True, "xmlSha256": _digest(body), "xsdSha256": OFFICIAL_XSD_SHA256},
        downloader=lambda url, _limit: assets[url],
        uploader=lambda url, body, _media, _headers: uploaded.__setitem__(url, rt.artifact_bytes(body)),
    )
    trace = json.loads(gzip.decompress(uploaded["memory:upload:trace"]))
    annotations = [json.loads(line) for line in uploaded["memory:upload:annotations"].decode().splitlines()]
    return result, backend, trace, annotations


def test_the_lease_carries_the_clip_and_an_absent_clip_is_the_full_render():
    lease, _manifest = _long_lease((0.2, 0.6))
    assert lease.render_spec.clip == (0.2, 0.6)
    assert _long_lease()[0].render_spec.clip is None


def test_a_sub_clip_seeks_to_its_start_pose_and_matches_the_full_render_frame_for_frame():
    full_result, full_backend, full_trace, full_annotations = _execute()
    sub_result, sub_backend, sub_trace, sub_annotations = _execute((0.2, 0.6))
    assert full_result["status"] == sub_result["status"] == "succeeded"
    # Seek: spawn and prepare happen at the start tick, then only the
    # window's ticks run (10..30), never the 0.2 s before it.
    assert ("prepare", 10) in sub_backend.calls and ("prepare", 0) in full_backend.calls
    applied = [call[1] for call in sub_backend.calls if call[0] == "apply"]
    assert applied == list(range(10, 31))
    # 0.4 s at 25 fps: 10 frames, labelled with the clip time they show.
    assert len(sub_annotations) == 10
    assert [item["index"] for item in sub_annotations] == list(range(10))
    by_time = {item["contentTimeS"]: item for item in full_annotations}
    for item in sub_annotations:
        reference = by_time[item["contentTimeS"]]
        assert item["simulationFrameIndex"] == reference["simulationFrameIndex"]
        assert item["scheduledTimeS"] == reference["scheduledTimeS"]
        assert item["actors"] == reference["actors"]
    assert sub_annotations[0]["contentTimeS"] == pytest.approx(0.2)
    assert sub_annotations[0]["actors"]["ego"]["x"] == pytest.approx(1.0)
    # The trace covers exactly the window's ticks and agrees with the full one.
    assert [frame["index"] for frame in sub_trace["frames"]] == list(range(10, 31))
    assert sub_trace["frames"] == full_trace["frames"][10:31]
    assert sub_trace["planSha256"] == full_trace["planSha256"]
    # Replay parity against the sampler ran over the window only.
    assert sub_result["parity"]["replay"]["samples"] == 21
    assert sub_result["parity"]["replay"]["verdict"] == "pass"


def test_a_prefix_renders_the_first_seconds_and_stops():
    result, backend, trace, annotations = _execute((0.0, 0.48))
    assert result["status"] == "succeeded"
    assert ("prepare", 0) in backend.calls
    assert [frame["index"] for frame in trace["frames"]] == list(range(0, 25))
    assert len(annotations) == 12
    assert annotations[-1]["contentTimeS"] == pytest.approx(0.44)


def test_the_render_manifest_records_the_window(tmp_path):
    lease, manifest = _long_lease((0.2, 0.6), outputs=("trace", "manifest"))
    assets = {
        "memory:manifest": manifest, "memory:xosc": LONG_XOSC, "memory:xodr": rt.XODR,
        "memory:catalog": rt.CATALOG, "memory:traffic": LONG_TRAFFIC,
    }
    uploaded: dict[str, bytes] = {}
    execute_lease(
        lease, rt.FakeBackend(),
        lambda body: {"valid": True, "xmlSha256": _digest(body), "xsdSha256": OFFICIAL_XSD_SHA256},
        downloader=lambda url, _limit: assets[url],
        uploader=lambda url, body, _media, _headers: uploaded.__setitem__(url, rt.artifact_bytes(body)),
    )
    render_manifest = json.loads(uploaded["memory:upload:manifest"])
    assert render_manifest["renderWindow"] == {
        "schema": "simforge.carla-render-window/v1", "startS": 0.2, "endS": 0.6,
        "startTick": 10, "endTick": 30, "authoredClipEndS": 1.0, "fullClip": False,
        "seek": "spawn-at-start-tick-pose",
    }
    assert render_manifest["capture"]["durationS"] == pytest.approx(0.4)
    assert render_manifest["capture"]["frameCount"] == 10


# -- run-intent ----------------------------------------------------------------------

def _intent(tmp_path, monkeypatch, start=0.0, end=1.0, fps=25):
    from simforge_oss_carla_exec import run_local
    scenario = tmp_path / "scenario.xosc"
    scenario.write_bytes(LONG_XOSC)
    xodr = tmp_path / "map.xodr"
    xodr.write_bytes(rt.XODR)
    catalog = tmp_path / "catalog.json"
    catalog.write_bytes(rt.CATALOG)
    intent = run_local.build_intent(
        LONG_XOSC, xodr, catalog, ("local-map", "local-catalog"), "Belmont_Office_Park_Belmont_CA", "authored",
        start_seconds=start, end_seconds=end, seed=1, rig="single-front", video=run_local.video_format(fps=fps),
    )
    monkeypatch.setattr(local, "cooked_map_name_for_xodr", lambda _sha: "Belmont_Office_Park_Belmont_CA")
    inputs = {"scenario.xosc": scenario, "local-map": xodr, "local-catalog": catalog}
    intent_sha = hashlib.sha256(local._canonical_render_intent_json(intent).encode()).hexdigest()
    return intent, intent_sha, inputs


def test_run_intent_accepts_a_sub_clip_and_sizes_the_lease_for_it(tmp_path, monkeypatch):
    """Formerly: ContractError('CARLA run-intent currently requires the full authored clip')."""
    intent, intent_sha, inputs = _intent(tmp_path, monkeypatch, end=0.48)
    lease, _paths = local._intent_lease(intent, intent_sha, "b" * 64, inputs, tmp_path / "out")
    assert lease.render_spec.clip == (0.0, 0.48)
    resources = lease.execution_package.runtime_requirements.resources
    assert resources.duration_s == pytest.approx(0.48)
    assert resources.capture_frames == 12
    intent, intent_sha, inputs = _intent(tmp_path, monkeypatch, start=0.2, end=0.6)
    lease, _paths = local._intent_lease(intent, intent_sha, "b" * 64, inputs, tmp_path / "out")
    assert lease.render_spec.clip == (0.2, 0.6)
    full, full_sha, inputs = _intent(tmp_path, monkeypatch)
    lease, _paths = local._intent_lease(full, full_sha, "b" * 64, inputs, tmp_path / "out")
    assert lease.render_spec.clip == (0.0, 1.0)


@pytest.mark.parametrize(("start", "end", "fps", "code"), [
    (0.0, 1.5, 25, "carla_clip_outside_scenario"),
    (0.0, 0.41, 24, "carla_clip_frame_count_fractional"),
])
def test_run_intent_refuses_what_it_cannot_render_before_carla_is_contacted(tmp_path, monkeypatch, start, end, fps, code):
    intent, intent_sha, inputs = _intent(tmp_path, monkeypatch, start=start, end=end, fps=fps)
    with pytest.raises(CarlaRenderError) as refused:
        local._intent_lease(intent, intent_sha, "b" * 64, inputs, tmp_path / "out")
    assert code_of(refused) == code


def _main(monkeypatch, run_intent):
    monkeypatch.setattr(local, "_run_intent", run_intent)
    monkeypatch.setattr(sys, "argv", [
        "simforge-oss-carla-exec", "run-intent", "--intent", "i", "--package", "p", "--output", "o",
        "--progress", "g", "--manifest", "m",
    ])
    stdout = io.StringIO()
    with redirect_stdout(stdout), pytest.raises(SystemExit) as exited:
        local.main()
    return exited.value.code, stdout.getvalue()


def test_a_contract_violation_prints_a_non_retryable_failure_record_and_exits_3(monkeypatch):
    """Formerly a traceback and exit 1, which the worker retried as an execution failure."""
    def violate(_args):
        raise ContractError("input package intentSha256 does not match canonical render intent bytes")
    code, stdout = _main(monkeypatch, violate)
    assert code == 3
    assert json.loads(stdout.strip().splitlines()[-1]) == {
        "schema": "simforge.carla-render-failure/v1",
        "code": "carla_render_contract_violation",
        "message": "[carla_render_contract_violation] input package intentSha256 does not match canonical render intent bytes",
        "retryable": False,
    }


def test_a_policy_refusal_keeps_its_own_code(monkeypatch):
    def refuse(_args):
        raise CarlaRenderError("carla_clip_outside_scenario", "renderSpec.clip ends at 25 s")
    code, stdout = _main(monkeypatch, refuse)
    record = json.loads(stdout)
    assert code == 3 and record["code"] == "carla_clip_outside_scenario" and record["retryable"] is False


def test_an_unreadable_intent_is_a_contract_violation(tmp_path, monkeypatch):
    intent_path = tmp_path / "intent.json"
    intent_path.write_text("{not json")
    monkeypatch.setattr(sys, "argv", [
        "simforge-oss-carla-exec", "run-intent", "--intent", str(intent_path), "--package", "p",
        "--output", str(tmp_path / "o"), "--progress", str(tmp_path / "g"), "--manifest", str(tmp_path / "m"),
    ])
    stdout = io.StringIO()
    with redirect_stdout(stdout), pytest.raises(SystemExit) as exited:
        local.main()
    assert exited.value.code == 3
    assert json.loads(stdout.getvalue())["code"] == "carla_render_contract_violation"


def test_an_unexpected_crash_is_not_disguised_as_a_refusal(monkeypatch):
    def crash(_args):
        raise RuntimeError("CARLA synchronous tick barrier is broken")
    monkeypatch.setattr(local, "_run_intent", crash)
    monkeypatch.setattr(sys, "argv", [
        "simforge-oss-carla-exec", "run-intent", "--intent", "i", "--package", "p", "--output", "o",
        "--progress", "g", "--manifest", "m",
    ])
    with pytest.raises(RuntimeError, match="tick barrier"):
        local.main()
