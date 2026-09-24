"""Trace replay: CARLA renders the scenario trace, it never re-simulates it."""
from __future__ import annotations

import hashlib
import json
import math
import struct
from pathlib import Path
from threading import Condition, Lock
from typing import Any

import pytest

from simforge_oss_carla_exec import local
from simforge_oss_carla_exec.runtime import backend as backend_module
from simforge_oss_carla_exec.runtime.backend import CarlaBackend
from simforge_oss_carla_exec.runtime.compiler import (
    ActorBinding,
    ActorFrame,
    ExecutionPlan,
    PlanFrame,
    compile_xosc14,
)
from simforge_oss_carla_exec.runtime.contract import (
    ContractError,
    REPLAY_PARITY_TOLERANCES,
    normalize_execution_mode,
)
from simforge_oss_carla_exec.runtime.replay import (
    CARLA_PITCH_SIGN,
    DOWNED_ORIGIN_HEIGHT_M,
    GroundDiagnostic,
    RenderPose,
    ReplayParityGate,
    carla_transform,
    expected_replay_poses,
    map_z_calibration,
    observed_pose,
    render_pose,
)
from simforge_oss_carla_exec.runtime.timeline import BoundTimeline, PlanTimeline


# -- a CARLA 0.10 stand-in no more capable than the real bindings -------------

class Vector3D:
    def __init__(self, x=0.0, y=0.0, z=0.0): self.x, self.y, self.z = x, y, z


class Location(Vector3D):
    pass


class Rotation:
    def __init__(self, pitch=0.0, yaw=0.0, roll=0.0): self.pitch, self.yaw, self.roll = pitch, yaw, roll


class Transform:
    def __init__(self, location=None, rotation=None):
        self.location, self.rotation = location or Location(), rotation or Rotation()


class WalkerControl:
    def __init__(self, direction=None, speed=0.0, jump=False): self.direction, self.speed, self.jump = direction, speed, jump


class _Command:
    class ApplyTransform:
        def __init__(self, actor_id, transform): self.actor_id, self.transform = actor_id, transform

    class ApplyTargetVelocity:
        def __init__(self, actor_id, velocity): self.actor_id, self.velocity = actor_id, velocity

    class ApplyWalkerControl:
        def __init__(self, actor_id, control): self.actor_id, self.control = actor_id, control


class Carla:
    Location, Rotation, Transform, Vector3D, WalkerControl = Location, Rotation, Transform, Vector3D, WalkerControl
    command = _Command


class _Box:
    def __init__(self, bottom):
        self.location = Location(z=0.0)
        self.extent = Location(z=-bottom)


class FakeActor:
    def __init__(self, world, actor_id, type_id, transform):
        self.world, self.id, self.type_id = world, actor_id, type_id
        self.transform = transform
        self.simulate_physics = True
        self.bounding_box = _Box(-0.93 if type_id.startswith("walker.") else 0.0)
        self.destroyed = False
        self.log: list[tuple[str, Any]] = []

    def set_simulate_physics(self, value):
        assert self.world.ticks == 0 or not value, "physics must be off before the first tick"
        self.simulate_physics = value
        self.log.append(("physics", value))

    def set_transform(self, transform):
        if self.type_id.startswith("static.prop."):
            return  # CARLA 0.10 ignores prop teleports
        self.transform = transform
        self.log.append(("teleport", transform))

    def get_transform(self): return self.transform

    def destroy(self):
        self.destroyed = True
        self.world.live.pop(self.id, None)
        return True


class FakeWorld:
    def __init__(self, refuse_near_ground=False):
        self.ticks = 0
        self.next_id = 100
        self.live: dict[int, FakeActor] = {}
        self.spawns: list[tuple[str, Transform]] = []
        self.refuse_near_ground = refuse_near_ground

    def get_blueprint_library(self):
        class Library:
            def find(self, blueprint_id): return blueprint_id
        return Library()

    def try_spawn_actor(self, blueprint, transform):
        self.spawns.append((blueprint, transform))
        if self.refuse_near_ground and transform.location.z < 40.0 and not blueprint.startswith("static.prop."):
            return None
        self.next_id += 1
        actor = FakeActor(self, self.next_id, blueprint, transform)
        self.live[actor.id] = actor
        return actor

    def tick(self):
        self.ticks += 1
        return self.ticks

    def get_spectator(self):
        world = self

        class Spectator:
            def set_transform(self, transform):
                world.spectator_transform = transform
        return Spectator()

    def get_snapshot(self):
        world = self

        class Snapshot:
            def find(self, actor_id):
                actor = world.live.get(actor_id)
                if actor is None:
                    return None
                return type("ActorSnapshot", (), {"get_transform": lambda _self: actor.transform})()
        return Snapshot()


class FakeClient:
    def __init__(self, world):
        self.world = world
        self.batches: list[list[Any]] = []

    def apply_batch_sync(self, commands, do_tick):
        assert do_tick is False
        self.batches.append(list(commands))
        for command in commands:
            if isinstance(command, _Command.ApplyTransform):
                self.world.live[command.actor_id].set_transform(command.transform)
        return [type("Response", (), {"error": ""})() for _ in commands]


CATALOG = {
    "car": {"blueprintId": "vehicle.ue4.chevrolet.impala", "dims": {"l": 5.36, "w": 2.03, "h": 1.41}},
    "ped": {"blueprintId": "walker.pedestrian.0015", "dims": {"l": 0.5, "w": 0.5, "h": 1.8}},
    "cone": {"blueprintId": "static.prop.trafficcone01", "dims": {"l": 0.6, "w": 0.6, "h": 1.23}},
}
BINDINGS = {
    "car": ActorBinding("car", "actor_car", "car", "car"),
    "ped": ActorBinding("ped", "actor_ped", "pedestrian", "ped"),
    "cone": ActorBinding("cone", "actor_cone", "static_object", "cone", static=True),
}


def replay_backend(world=None):
    backend = object.__new__(CarlaBackend)
    backend.carla = Carla
    backend.world = world or FakeWorld()
    backend.client = FakeClient(backend.world)
    backend.actors = {}
    backend.execution_mode = "trace-replay"
    backend.package_xodr_sha256 = "0" * 64
    backend.sensor_lock = Lock()
    backend.sensor_condition = Condition(backend.sensor_lock)
    backend.sensor_pending, backend.sensor_error = {}, None
    return backend


def frame(index, t, **states):
    return PlanFrame(index, t, states, {})


FIRST = frame(
    0, 0.0,
    car=ActorFrame("spawn", 10.0, 5.0, 2.0, 30.0, 4.0, pitch_deg=1.5, roll_deg=-0.5),
    ped=ActorFrame("spawn", 12.0, 8.0, 2.2, 90.0, 1.4),
    cone=ActorFrame("spawn", 15.0, 9.0, 2.1, 0.0, 0.0),
)


# -- execution mode vocabulary ------------------------------------------------

def test_trace_replay_is_the_default_and_diagnostic_replay_is_its_historical_name():
    assert normalize_execution_mode(None, "mode") == "trace-replay"
    assert normalize_execution_mode("diagnostic-replay", "mode") == "trace-replay"
    assert normalize_execution_mode("native-physics", "mode") == "native-physics"
    with pytest.raises(ContractError):
        normalize_execution_mode("teleport", "mode")
    assert REPLAY_PARITY_TOLERANCES == {"positionM": 0.01, "rotationDeg": 0.1}


# -- compiler: time origin and attitude ----------------------------------------

def _replay_xosc(warmup=None, clip=None, knockdown=None, signal_at=None, pitch="0", roll="0"):
    header = ['<Property name="simforge.executionMode" value="trajectory-replay"/>']
    if warmup is not None:
        header.append(f'<Property name="uniscenarios.trajectoryReplay.warmupSeconds" value="{warmup}"/>')
    if clip is not None:
        header.append(f'<Property name="uniscenarios.trajectoryReplay.clipSeconds" value="{clip}"/>')
    if knockdown is not None:
        header.append(f'<Property name="uniscenarios.trajectoryReplay.knockedDownAtS.ego" value="{knockdown}"/>')
    offset = warmup or 0.0
    end = offset + (clip if clip is not None else 0.1)
    vertices = "".join(
        f'<Vertex time="{t:.2f}"><Position><WorldPosition x="{t * 10:.4f}" y="0" z="1" h="0" p="{pitch}" r="{roll}"/></Position>'
        f'<Motion speed_longitudinal="10"/></Vertex>'
        for t in [index * 0.02 for index in range(int(round(end / 0.02)) + 1)]
    )
    story = ""
    if signal_at is not None:
        story = (
            '<Story name="s"><Act name="a"><ManeuverGroup name="g" maximumExecutionCount="1"><Actors selectTriggeringEntities="false"/>'
            '<Maneuver name="m"><Event name="e" priority="overwrite"><Action name="sig"><GlobalAction><InfrastructureAction>'
            '<TrafficSignalAction><TrafficSignalStateAction name="7" state="red"/></TrafficSignalAction></InfrastructureAction></GlobalAction></Action>'
            f'<StartTrigger><ConditionGroup><Condition name="c" delay="0" conditionEdge="none"><ByValueCondition><SimulationTimeCondition value="{signal_at}" rule="greaterOrEqual"/></ByValueCondition></Condition></ConditionGroup></StartTrigger>'
            '</Event></Maneuver></ManeuverGroup><StartTrigger/><StopTrigger/></Act></Story>'
        )
    return (
        '<?xml version="1.0" encoding="UTF-8"?><OpenSCENARIO><FileHeader revMajor="1" revMinor="4" date="x" description="t" author="t">'
        f'<Properties>{"".join(header)}</Properties></FileHeader><ParameterDeclarations/><CatalogLocations/>'
        '<RoadNetwork><LogicFile filepath="m.xodr"/></RoadNetwork><Entities><ScenarioObject name="actor_ego"><Vehicle name="car" vehicleCategory="car">'
        '<Properties><Property name="simforge.actorId" value="ego"/><Property name="simforge.actorKind" value="car"/></Properties></Vehicle></ScenarioObject></Entities>'
        '<Storyboard><Init><Actions>'
        '<GlobalAction><InfrastructureAction><TrafficSignalAction><TrafficSignalStateAction name="7" state="green"/></TrafficSignalAction></InfrastructureAction></GlobalAction>'
        '<Private entityRef="actor_ego"><PrivateAction><RoutingAction><FollowTrajectoryAction><TimeReference>'
        '<Timing domainAbsoluteRelative="absolute" scale="1" offset="0"/></TimeReference><TrajectoryFollowingMode followingMode="position"/>'
        f'<TrajectoryRef><Trajectory name="t" closed="false"><Shape><Polyline>{vertices}</Polyline></Shape></Trajectory></TrajectoryRef>'
        f'</FollowTrajectoryAction></RoutingAction></PrivateAction></Private></Actions></Init>{story}<StopTrigger/></Storyboard></OpenSCENARIO>'
    ).encode()


def test_clip_starts_after_the_warm_up_the_exporter_shifted_every_time_by():
    plan = compile_xosc14(_replay_xosc(warmup=5, clip=1.0, knockdown=0.5, signal_at=5.4))
    assert plan.warmup_s == 5.0 and plan.source_time_offset_s == 5.0
    assert plan.frames[0].t == 0.0 and plan.frames[-1].t == pytest.approx(1.0)
    assert len(plan.frames) == 51
    # Clip t=0 shows the xosc t=5 pose, never the warm-up.
    assert plan.frames[0].actors["ego"].x == pytest.approx(50.0)
    assert plan.frames[-1].actors["ego"].x == pytest.approx(60.0)
    # Triggers are xosc time; knockdowns are clip time.
    assert plan.frames[19].signals == {"7": "green"} and plan.frames[20].signals == {"7": "red"}
    assert not plan.frames[24].actors["ego"].downed and plan.frames[25].actors["ego"].downed


def test_sources_without_a_warm_up_header_keep_their_origin_and_digest():
    plain = compile_xosc14(_replay_xosc())
    declared_zero = compile_xosc14(_replay_xosc(warmup=0, clip=0.1))
    assert plain.warmup_s == 0.0 and plain.frames[-1].t == pytest.approx(0.1)
    assert plain.sha256 == declared_zero.sha256


def test_rejects_a_clip_outside_the_authored_trajectories():
    with pytest.raises(ContractError, match="warm-up and clip"):
        compile_xosc14(_replay_xosc(warmup=5, clip=1.0).replace(b'clipSeconds" value="1.0"', b'clipSeconds" value="9"'))


def test_baked_pitch_and_roll_reach_the_plan_and_its_digest():
    level = compile_xosc14(_replay_xosc())
    tilted = compile_xosc14(_replay_xosc(pitch="0.05", roll="-0.02"))
    state = tilted.frames[3].actors["ego"]
    assert state.pitch_deg == pytest.approx(math.degrees(0.05))
    assert state.roll_deg == pytest.approx(math.degrees(-0.02))
    assert level.frames[3].actors["ego"].pitch_deg == 0.0
    assert level.sha256 != tilted.sha256


# -- sampler ------------------------------------------------------------------

def _plan(*frames_):
    return ExecutionPlan("simforge.execution-plan/v1", 0.02, {"a": ActorBinding("a", "actor_a", "car", "car")}, tuple(frames_), "a" * 64)


def test_sampler_is_exact_on_ticks_and_interpolates_between_them():
    plan = _plan(
        frame(0, 0.0, a=ActorFrame("spawn", 0.0, 0.0, 1.0, 179.0, 2.0, pitch_deg=0.0)),
        frame(1, 0.02, a=ActorFrame("active", 1.0, 2.0, 2.0, -179.0, 4.0, appearance={"light.brakeLights": "on"}, pitch_deg=2.0)),
    )
    sampler = PlanTimeline(plan)
    assert sampler.frame_at(1, 0.02) is plan.frames[1]
    mid = sampler.frame_at(1, 0.015).actors["a"]
    assert (mid.x, mid.y, mid.z) == pytest.approx((0.75, 1.5, 1.75))
    # Shortest arc across +-180, not a spin through 0.
    assert ((mid.heading_deg + 180) % 360 - 180) == pytest.approx(-179.5)
    assert mid.pitch_deg == pytest.approx(1.5)
    # Discrete state latches from the tick at or before t.
    assert mid.appearance == {} and mid.lifecycle == "spawn"
    with pytest.raises(RuntimeError, match="not on tick"):
        sampler.frame_at(0, 0.015)


def test_sampler_holds_the_last_present_pose_until_the_despawn_tick():
    plan = _plan(
        frame(0, 0.0, a=ActorFrame("spawn", 0.0, 0.0, 0.0, 0.0, 1.0)),
        frame(1, 0.02, a=ActorFrame("absent", 9.0, 9.0, 9.0, 0.0, 0.0)),
    )
    held = PlanTimeline(plan).frame_at(0, 0.009).actors["a"]
    assert (held.x, held.lifecycle) == (0.0, "spawn")


def test_bound_timeline_maps_the_shared_sampler_binding_onto_plan_frames():
    class Timeline:
        dt, clip_end_s, warmup_s, times = 0.02, 0.02, 5.0, [0.0, 0.02]
        actor_ids = ["a"]
        sha256 = key = trace_sha256 = "b" * 64
        sampler_version = "simforge.timeline-sampler/3"
        xodr_sha256 = None

        def props(self): return [{"id": "cone", "catalogId": "c", "x": 3.0, "y": 4.0, "z": 0.5, "headingRad": 0.0}]

        def poses(self, t):
            return {"a": {"present": True, "x": 1.0, "y": 2.0, "z": 3.0, "headingRad": math.pi / 2,
                          "pitchRad": 0.01, "rollRad": -0.02, "speedMps": 4.0, "downed": False}}

        def signals_at(self, t): return {"signal:7": "red"}
        def light_modes_at(self, actor_id, t): return {"brake": "on", "indicatorLeft": "flashing", "lowBeam": "off"}

    plan = ExecutionPlan(
        "simforge.execution-plan/v1", 0.02,
        {"a": ActorBinding("a", "actor_a", "car", "car"), "cone": ActorBinding("cone", "actor_cone", "static_object", "c", static=True)},
        (frame(0, 0.0, a=ActorFrame("spawn", 0, 0, 0, 0, 0)),), "a" * 64,
    )
    sampler = BoundTimeline(Timeline(), plan)
    assert sampler.tick_count() == 2
    state = sampler.frame_at_tick(1).actors["a"]
    assert state.heading_deg == pytest.approx(90.0)
    assert state.pitch_deg == pytest.approx(math.degrees(0.01))
    assert state.appearance == {"light.brakeLights": "on", "light.indicatorLeft": "flashing", "light.lowBeam": "off"}
    assert sampler.frame_at_tick(1).actors["cone"].x == 3.0
    assert sampler.frame_at_tick(1).signals == {"7": "red"}
    assert sampler.evidence()["source"] == "render-timeline"
    plan_without_prop = ExecutionPlan("simforge.execution-plan/v1", 0.02, {"a": plan.actors["a"]}, plan.frames, "a" * 64)
    with pytest.raises(ContractError, match="differ from the execution plan"):
        BoundTimeline(Timeline(), plan_without_prop)


# -- identity corpus: CARLA replay against the real shared sampler --------------

REPO = Path(__file__).resolve().parents[3]
CORPUS_PATH = REPO / "fixtures/render-timeline/identity-corpus.json"


def _corpus_timelines():
    st = pytest.importorskip("simforge_oss_timeline")
    corpus = json.loads(CORPUS_PATH.read_text())
    assert corpus["samplerVersion"] == st.SAMPLER_VERSION
    for case in corpus["cases"]:
        height = case["height"]
        kwargs = {"flat_z": height["z"]} if height["kind"] == "flat" else {"plane": (height["z0"], height["gx"], height["gy"])}
        body = st.build_timeline((REPO / case["trace"]).read_bytes(), catalog_digest=case["catalogDigest"], **kwargs)
        timeline = st.Timeline.from_json(body)
        assert timeline.sha256 == case["timelineSha256"], case["id"]
        yield case["id"], timeline


def _corpus_plan(timeline) -> ExecutionPlan:
    actors = {actor_id: ActorBinding(actor_id, f"actor_{actor_id}", "car", "c") for actor_id in timeline.actor_ids}
    actors.update({prop["id"]: ActorBinding(prop["id"], f"actor_{prop['id']}", "static_object", "p", static=True) for prop in timeline.props()})
    return ExecutionPlan("simforge.execution-plan/v1", 0.02, actors, (), "a" * 64)


def _float32(value: float) -> float:
    return struct.unpack("<f", struct.pack("<f", value))[0]


@pytest.mark.skipif(not CORPUS_PATH.exists(), reason="identity corpus not in this checkout")
def test_every_corpus_pose_survives_the_carla_mapping_within_the_replay_gate():
    """What CARLA can represent (float32 UE centimetres/degrees) of every
    sampler pose on the corpus, ticks and mid-ticks, stays inside the blocking
    replay tolerance, so any gate failure on real CARLA is CARLA's doing."""
    checked = 0
    for case_id, timeline in _corpus_timelines():
        sampler = BoundTimeline(timeline, _corpus_plan(timeline))
        gate = ReplayParityGate()
        times = timeline.times
        for index in range(0, len(times), 7):
            for t in (times[index], min(times[-1], times[index] + 0.013)):
                frame_ = sampler.frame_at(index, t)
                classes = {actor_id: ("walker" if actor_id.startswith(("ped", "road", "cross")) else "vehicle") for actor_id in frame_.actors}
                expected = expected_replay_poses(frame_, classes, {}, 0.0)
                observed = {}
                for actor_id, (_klass, pose) in expected.items():
                    transform = carla_transform(Carla, pose)
                    ue = Transform(
                        Location(x=_float32(transform.location.x * 100) / 100, y=_float32(transform.location.y * 100) / 100, z=_float32(transform.location.z * 100) / 100),
                        Rotation(pitch=_float32(transform.rotation.pitch), yaw=_float32(transform.rotation.yaw), roll=_float32(transform.rotation.roll)),
                    )
                    observed[actor_id] = observed_pose(ue)
                gate.observe(frame_, expected, observed)
                checked += len(expected)
        report = gate.report()
        assert report["verdict"] == "pass", (case_id, report["violations"][:2])
        assert report["maxPositionErrorM"] < 1e-3, case_id
    assert checked > 1000


@pytest.mark.skipif(not CORPUS_PATH.exists(), reason="identity corpus not in this checkout")
def test_plan_sampler_interpolates_exactly_like_the_shared_sampler():
    """The xosc-plan sampler (used until packages ship timelines) follows the
    shared sampler's rules: sampling a plan made of the timeline's own ticks
    between ticks reproduces ``pose(timeline, id, t)``."""
    for case_id, timeline in _corpus_timelines():
        bound = BoundTimeline(timeline, _corpus_plan(timeline))
        frames = tuple(bound.frame_at_tick(index) for index in range(bound.tick_count()))
        plan = ExecutionPlan("simforge.execution-plan/v1", 0.02, _corpus_plan(timeline).actors, frames, "a" * 64)
        sampler = PlanTimeline(plan)
        for index in range(0, len(frames) - 1, 11):
            t = frames[index].t + 0.007
            ours = sampler.frame_at(index, t).actors
            theirs = bound.frame_at(index, t).actors
            for actor_id, want in theirs.items():
                got = ours[actor_id]
                assert got.lifecycle == want.lifecycle or want.lifecycle == "absent", (case_id, actor_id, t)
                if want.lifecycle == "absent":
                    continue
                assert (got.x, got.y, got.z) == pytest.approx((want.x, want.y, want.z), abs=1e-9), (case_id, actor_id, t)
                assert ((got.heading_deg - want.heading_deg + 180) % 360 - 180) == pytest.approx(0.0, abs=1e-7), (case_id, actor_id, t)
                assert (got.pitch_deg, got.roll_deg) == pytest.approx((want.pitch_deg, want.roll_deg), abs=1e-7), (case_id, actor_id, t)


# -- pose mapping and parity ----------------------------------------------------

def test_render_pose_puts_the_body_bottom_on_the_timeline_ground():
    walker = render_pose(ActorFrame("active", 1, 2, 3.0, 45, 1, pitch_deg=5, roll_deg=5), bottom_offset_m=-0.93, z_offset_m=0.02, walker=True)
    assert walker.z == pytest.approx(3.0 + 0.02 + 0.93)
    # Walkers stay upright whatever the road does.
    assert (walker.pitch_deg, walker.roll_deg) == (0.0, 0.0)
    car = render_pose(ActorFrame("active", 1, 2, 3.0, 45, 1, pitch_deg=2, roll_deg=-1), bottom_offset_m=0.0, z_offset_m=0.0, walker=False)
    assert (car.z, car.pitch_deg, car.roll_deg) == (3.0, 2, -1)
    downed = render_pose(ActorFrame("active", 1, 2, 3.0, 45, 0, downed=True), bottom_offset_m=-0.93, z_offset_m=0.0, walker=True)
    assert downed.z == pytest.approx(3.0 + DOWNED_ORIGIN_HEIGHT_M) and (downed.pitch_deg, downed.roll_deg) == (0.0, 90.0)


def test_carla_transform_mirrors_y_and_yaw_and_round_trips():
    pose = RenderPose(10.0, 5.0, 2.0, 30.0, 1.5, -0.5)
    transform = carla_transform(Carla, pose)
    assert (transform.location.x, transform.location.y, transform.rotation.yaw) == (10.0, -5.0, -30.0)
    assert transform.rotation.pitch == CARLA_PITCH_SIGN * 1.5
    assert observed_pose(transform) == pose


def test_replay_gate_is_blocking_at_one_centimetre_and_a_tenth_of_a_degree():
    gate = ReplayParityGate()
    state = frame(0, 0.0, a=ActorFrame("spawn", 0, 0, 0, 0, 0))
    expected = {"a": ("vehicle", RenderPose(0, 0, 0, 0, 0, 0))}
    gate.observe(state, expected, {"a": RenderPose(0.009, 0, 0, 0.09, 0, 0)})
    assert gate.passed
    gate.observe(state, expected, {"a": RenderPose(0, 0, 0.011, 0, 0, 0)})
    gate.observe(state, expected, {"a": RenderPose(0, 0, 0, 0, 0, 0.2)})
    report = gate.report()
    assert report["verdict"] == "fail" and report["violationCount"] == 2
    assert report["byClass"]["vehicle"]["maxPositionErrorM"] == pytest.approx(0.011)
    assert report["byClass"]["vehicle"]["maxRotationErrorDeg"] == pytest.approx(0.2)


def test_replay_gate_requires_exact_lifecycle_and_signal_closure():
    gate = ReplayParityGate()
    state = frame(0, 0.0, a=ActorFrame("spawn", 0, 0, 0, 0, 0))
    gate.observe(state, {"a": ("walker", RenderPose(0, 0, 0, 0, 0, 0))}, {}, expected_signals={"1": "red"}, observed_signals={"1": "red"})
    gate.observe(state, {}, {"ghost": RenderPose(0, 0, 0, 0, 0, 0)}, expected_signals={"1": "red"}, observed_signals={"1": "green"})
    report = gate.report()
    assert report["lifecycleMismatches"] == 2 and report["signalMismatches"] == 1
    assert report["verdict"] == "fail"
    assert ReplayParityGate().report()["verdict"] == "fail", "no samples can never pass"


def test_ground_diagnostic_reports_cooked_vs_timeline_and_the_residual():
    diagnostic = GroundDiagnostic()
    for delta in (0.02, 0.03, 0.04):
        diagnostic.observe("a", "vehicle", delta)
    diagnostic.observe("b", "walker", None)
    report = diagnostic.report(applied_offset_m=0.03, offset_source="built-in")
    assert report["authority"] == "timeline-z"
    assert report["suggestedCalibrationM"] == pytest.approx(0.03)
    assert report["residualAfterCalibration"]["maxM"] == pytest.approx(0.01)
    assert report["unresolvedSamples"] == 1


def test_map_calibration_comes_only_from_the_package_registry(monkeypatch):
    """Formerly a worker env (SIMFORGE_CARLA_MAP_Z_OFFSETS_JSON) could shift
    every actor up to 2 m. Now the package registry is the only source and the
    env fails the render."""
    from simforge_oss_carla_exec.runtime import replay as replay_module
    sha = "c" * 64
    monkeypatch.delenv("SIMFORGE_CARLA_MAP_Z_OFFSETS_JSON", raising=False)
    assert map_z_calibration(sha) == (0.0, "none")
    monkeypatch.setattr(replay_module, "MAP_Z_CALIBRATION_M", {sha: -0.04})
    assert map_z_calibration(sha) == (-0.04, "built-in")
    monkeypatch.setenv("SIMFORGE_CARLA_MAP_Z_OFFSETS_JSON", json.dumps({sha: -0.04}))
    with pytest.raises(ContractError, match=r"\[carla_forbidden_worker_config\]"):
        map_z_calibration(sha)


# -- backend: spawn, per-tick batch, readback -----------------------------------

def test_replay_spawns_every_class_kinematic_at_its_exact_timeline_pose():
    backend = replay_backend()
    backend.spawn(BINDINGS, FIRST, CATALOG)
    assert backend.world.ticks == 0
    assert set(backend.actors) == {"car", "ped", "cone"}
    for actor in backend.actors.values():
        assert actor.simulate_physics is False
    car, ped, cone = (backend.actors[name].transform for name in ("car", "ped", "cone"))
    assert (car.location.x, car.location.y, car.location.z) == (10.0, -5.0, 2.0)
    assert (car.rotation.yaw, car.rotation.pitch, car.rotation.roll) == (-30.0, CARLA_PITCH_SIGN * 1.5, -0.5)
    # Walker capsule centre 0.93 m above its feet, which are on the timeline z.
    assert ped.location.z == pytest.approx(2.2 + 0.93)
    # A prop is spawned exactly where it belongs; it is never moved later.
    assert cone.location.z == pytest.approx(2.1)
    report = backend.spawn_placement_report()
    assert report["mode"] == "trace-replay"
    assert report["nudgedActorIds"] == [] and report["droppedActorIds"] == []
    assert report["actors"]["car"]["physics"] == "off-from-spawn"
    assert not getattr(backend, "collision_sensors", [])


def test_replay_stages_a_body_whose_near_surface_spawn_is_refused_without_nudging():
    backend = replay_backend(FakeWorld(refuse_near_ground=True))
    backend.spawn(BINDINGS, FIRST, CATALOG)
    report = backend.spawn_placement_report()
    assert report["stagedActorIds"] == ["car", "ped"]
    car = backend.actors["car"].transform.location
    assert (car.x, car.y, car.z) == (10.0, -5.0, 2.0)


def test_replay_prepare_has_no_settle_phase():
    backend = replay_backend()
    backend.spawn(BINDINGS, FIRST, CATALOG)
    report = backend.prepare_scenario(FIRST)
    assert report["settleTicks"] == 0 and report["sensorWarmupTicks"] == 0
    assert backend.world.ticks == 0


def test_replay_applies_one_batch_per_tick_and_reads_back_the_sampler_pose():
    backend = replay_backend()
    backend.spawn(BINDINGS, FIRST, CATALOG)
    backend.signals, backend.executed_signals, backend.executed_signal_lamps = {}, {}, {}
    second = frame(
        1, 0.02,
        car=ActorFrame("active", 10.08, 5.04, 2.0, 31.0, 4.0, pitch_deg=1.5, roll_deg=-0.5),
        ped=ActorFrame("active", 12.0, 8.028, 2.2, 90.0, 1.4),
        cone=ActorFrame("active", 15.0, 9.0, 2.1, 0.0, 0.0),
    )
    backend.apply(second)
    assert len(backend.client.batches) == 1
    kinds = sorted(type(command).__name__ for command in backend.client.batches[0])
    assert kinds == ["ApplyTargetVelocity", "ApplyTargetVelocity", "ApplyTransform", "ApplyTransform", "ApplyWalkerControl"]
    walker_control = next(c for c in backend.client.batches[0] if isinstance(c, _Command.ApplyWalkerControl)).control
    assert walker_control.speed == pytest.approx(1.4)
    readback = backend.tick(None)
    assert readback["car"]["x"] == pytest.approx(10.08) and readback["car"]["headingDeg"] == pytest.approx(31.0)
    assert readback["ped"]["contactZ"] == pytest.approx(2.2)
    assert readback["car"]["speedSource"] == "timeline"
    gate = ReplayParityGate()
    gate.observe(
        second,
        expected_replay_poses(second, backend.actor_classes, backend.bottom_offsets, backend.z_offset_m),
        {key: RenderPose(v["x"], v["y"], v["z"], v["headingDeg"], v["pitchDeg"], v["rollDeg"]) for key, v in readback.items()},
    )
    assert gate.passed, gate.report()


def test_a_moving_prop_is_respawned_because_carla_ignores_prop_teleports():
    backend = replay_backend()
    backend.spawn(BINDINGS, FIRST, CATALOG)
    backend.signals, backend.executed_signals, backend.executed_signal_lamps = {}, {}, {}
    first_id = backend.actors["cone"].id
    moved = frame(1, 0.02, **{**FIRST.actors, "cone": ActorFrame("active", 15.5, 9.0, 2.1, 0.0, 0.5)})
    backend.apply(moved)
    assert backend.actors["cone"].id != first_id
    assert backend.actors["cone"].transform.location.x == pytest.approx(15.5)
    assert backend.replay_evidence()["propRespawns"] == {"cone": 1}


def test_a_despawned_actor_is_destroyed_once_and_reported_absent():
    backend = replay_backend()
    backend.spawn(BINDINGS, FIRST, CATALOG)
    backend.signals, backend.executed_signals, backend.executed_signal_lamps = {}, {}, {}
    gone = frame(1, 0.02, **{**FIRST.actors, "ped": ActorFrame("absent", 12, 8, 2.2, 90, 0)})
    backend.apply(gone)
    backend.apply(gone)
    readback = backend.tick(None)
    assert readback["ped"] == {"present": False, "lifecycle": "absent", "appearance": {}}


# -- map binding by digest ------------------------------------------------------

class _MapWorld:
    def __init__(self, name, xodr):
        self.name, self.xodr = name, xodr

    def get_map(self):
        world = self
        return type("Map", (), {"name": f"/Game/{world.name}", "to_opendrive": lambda _self: world.xodr})()

    def get_settings(self):
        return type("Settings", (), {"synchronous_mode": True, "fixed_delta_seconds": 0.02, "no_rendering_mode": False})()

    def apply_settings(self, settings):
        self.settings = settings


def _map_backend(runtime_xodr: str, name: str = "Custom_Map", monkeypatch=None, package: bytes = b"<OpenDRIVE/>"):
    if monkeypatch is not None:
        # Register the package XODR as this cooked world.
        cooked = {hashlib.sha256(package).hexdigest(): name}
        monkeypatch.setattr(backend_module, "cooked_map_name_for_xodr", lambda sha: cooked.get(sha))
    backend = object.__new__(CarlaBackend)
    backend.map_load_timeout_s = 10.0
    world = _MapWorld(name, runtime_xodr)

    class Client:
        def get_available_maps(self): return [f"/Game/Maps/{name}"]
        def set_timeout(self, _t): pass
        def load_world(self, _name): return world
    backend.client = Client()
    return backend


def test_map_binding_accepts_a_byte_exact_runtime_opendrive(monkeypatch):
    monkeypatch.delenv("SIMFORGE_CARLA_MAP_BINDING", raising=False)
    backend = _map_backend("<OpenDRIVE/>", monkeypatch=monkeypatch)
    backend.load_opendrive("Custom_Map", b"<OpenDRIVE/>", 0.02)
    assert backend.map_evidence["identityMode"] == "xodr-byte-exact"
    assert backend.map_evidence["binding"] == "exact"
    assert backend.physics_evidence["requested"]["max_substep_delta_time"] == 0.01


def test_map_binding_rejects_a_different_road_network_loaded_by_name(monkeypatch):
    monkeypatch.delenv("SIMFORGE_CARLA_MAP_BINDING", raising=False)
    monkeypatch.delenv("SIMFORGE_CARLA_APPROVED_COOKED_XODR_JSON", raising=False)
    backend = _map_backend("<OpenDRIVE other/>", monkeypatch=monkeypatch)
    with pytest.raises(RuntimeError, match=r"\[carla_map_digest_mismatch\].*not bound to the package XODR"):
        backend.load_opendrive("Custom_Map", b"<OpenDRIVE/>", 0.02)


def test_map_binding_accepts_an_approved_cooked_reserialization(monkeypatch):
    package, runtime = b"<OpenDRIVE/>", "<OpenDRIVE cooked/>"
    monkeypatch.setenv("SIMFORGE_CARLA_APPROVED_COOKED_XODR_JSON", json.dumps({
        hashlib.sha256(package).hexdigest(): [hashlib.sha256(runtime.encode()).hexdigest()],
    }))
    backend = _map_backend(runtime, monkeypatch=monkeypatch, package=package)
    backend.load_opendrive("Custom_Map", package, 0.02)
    assert backend.map_evidence["identityMode"] == "approved-cooked-digest"
    assert backend.map_evidence["exact"] is True


def test_an_approximate_map_binding_is_never_rendered(monkeypatch):
    """Formerly SIMFORGE_CARLA_MAP_BINDING=allow-approximate rendered a
    different road network, labelled only in evidence. The worker setting now
    fails the render, and so does the unbound world without it."""
    monkeypatch.delenv("SIMFORGE_CARLA_APPROVED_COOKED_XODR_JSON", raising=False)
    monkeypatch.setenv("SIMFORGE_CARLA_MAP_BINDING", "allow-approximate")
    backend = _map_backend("<OpenDRIVE other/>", monkeypatch=monkeypatch)
    with pytest.raises(RuntimeError, match=r"\[carla_forbidden_worker_config\].*SIMFORGE_CARLA_MAP_BINDING"):
        backend.load_opendrive("Custom_Map", b"<OpenDRIVE/>", 0.02)
    monkeypatch.setenv("SIMFORGE_CARLA_MAP_BINDING", "exact")
    with pytest.raises(RuntimeError, match=r"\[carla_map_digest_mismatch\]"):
        _map_backend("<OpenDRIVE other/>", monkeypatch=monkeypatch).load_opendrive("Custom_Map", b"<OpenDRIVE/>", 0.02)


def test_an_uncooked_map_is_refused_instead_of_generating_a_bare_opendrive_world(monkeypatch):
    """Formerly SIMFORGE_CARLA_ALLOW_GENERATED_XODR=1 (set in the SimCloud
    rtx3080 image) rendered any uncooked map as a generated road mesh with no
    buildings, props or signals, and labelled it exact."""
    monkeypatch.delenv("SIMFORGE_CARLA_ALLOW_GENERATED_XODR", raising=False)
    backend = _map_backend("<OpenDRIVE/>", name="Some_Other_World")  # the runtime has no such cooked world
    backend.client.generate_opendrive_world = lambda *_args: pytest.fail("must never generate a world")
    with pytest.raises(RuntimeError, match=r"\[carla_map_not_cooked\]"):
        backend.load_opendrive("Custom_Map", b"<OpenDRIVE/>", 0.02)
    monkeypatch.setenv("SIMFORGE_CARLA_ALLOW_GENERATED_XODR", "1")
    with pytest.raises(RuntimeError, match=r"\[carla_forbidden_worker_config\].*ALLOW_GENERATED_XODR"):
        _map_backend("<OpenDRIVE/>", monkeypatch=monkeypatch).load_opendrive("Custom_Map", b"<OpenDRIVE/>", 0.02)


def test_a_package_naming_another_world_than_its_xodr_binds_is_rejected(monkeypatch):
    richmond = "80704cd1bc2563a63d5d365a5b0c43936222cef811f513e89129a8205e464643"
    monkeypatch.setattr(backend_module, "cooked_map_name_for_xodr", lambda sha: "Richmond_Field_Station_Richmond_CA" if sha == richmond else None)
    monkeypatch.setattr(backend_module.hashlib, "sha256", lambda body=b"": type("H", (), {"hexdigest": lambda _s: richmond})())
    backend = _map_backend("<OpenDRIVE/>")
    with pytest.raises(RuntimeError, match="binds the cooked world"):
        backend.load_opendrive("Belmont_Office_Park_Belmont_CA", b"<OpenDRIVE/>", 0.02)


def test_the_known_cooked_worlds_have_approved_runtime_digests():
    for source in backend_module.COOKED_MAP_NAMES_BY_XODR_SHA256:
        assert backend_module.approved_cooked_xodr_digests(source), source


# -- render-intent entry point ----------------------------------------------------

def _v3_spec(required=(), preferred=()):
    return {
        "schema": "simforge.render-spec/v3",
        "sources": [{
            "actorId": "ego", "sensorId": "front", "outputName": "front", "modality": "rgb",
            "transform": {"position": {"x": 0, "y": 1.5, "z": 0}, "rotation": {"yawRad": 0, "pitchRad": 0, "rollRad": 0}},
            "attributes": {"width": 640, "height": 360, "fps": 24, "horizontalFovDeg": 90, "nearM": 0.1, "farM": 500},
        }],
        "clip": {"startSeconds": 0, "endSeconds": 1},
        "video": {"width": 640, "height": 360, "fps": 24, "container": "mp4", "codec": "h264", "quality": "standard"},
        "artifacts": ["video", "manifest"],
        "capabilityIntent": {"required": list(required), "preferred": list(preferred), "fidelity": "review"},
        "authoredEnvironment": {"weather": "clear", "timeOfDay": "noon"},
    }


def test_render_intents_replay_unless_they_require_physics_validation():
    """Formerly a *preferred* actor.native_controls silently turned the job into
    a physics-validation run; only a required capability may now."""
    native, parsed, _ = local._render_spec_v3_to_native(_v3_spec())
    assert native["executionMode"] == parsed.execution_mode == "trace-replay"
    _native, parsed, _ = local._render_spec_v3_to_native(_v3_spec(required=["actor.native_controls"]))
    assert parsed.execution_mode == "native-physics"
    with pytest.raises(ContractError, match=r"\[carla_capability_preference_unsupported\]"):
        local._render_spec_v3_to_native(_v3_spec(preferred=["actor.native_controls"]))


def test_run_intent_refuses_to_publish_a_render_that_failed_parity(monkeypatch, tmp_path):
    monkeypatch.setattr(local, "_read_input_package", lambda _path, _intent: ("a" * 64, "b" * 64, {}))
    monkeypatch.setattr(local, "_intent_lease", lambda *_args: (object(), {}))
    monkeypatch.setattr(local, "_execute_local_lease", lambda *_args, **_kwargs: {
        "status": "failed-parity",
        "parity": {"accepted": False},
        "parityEvidence": {
            "execution": {"mode": "trace-replay"},
            "trajectory": {"verdict": "fail", "failedActorIds": ["ped"], "metrics": {"max.positionM": 0.4}},
            "semantics": {"failedCheckIds": []},
            "artifacts": {"missingKinds": []},
        },
        "artifacts": [],
    })
    intent = tmp_path / "intent.json"
    intent.write_text(json.dumps({"intentId": "i"}))
    args = type("Args", (), {
        "intent": str(intent), "package": str(tmp_path / "p.json"), "output": str(tmp_path / "out"),
        "progress": str(tmp_path / "progress.jsonl"), "manifest": str(tmp_path / "manifest.json"),
        "host": "127.0.0.1", "port": 2000,
    })()
    with pytest.raises(RuntimeError, match="blocking parity gate"):
        local._run_intent(args)
    assert not (tmp_path / "manifest.json").exists()
    progress = [json.loads(line) for line in (tmp_path / "progress.jsonl").read_text().splitlines()]
    assert any(record.get("code") == "carla.parity_failed" for record in progress)


def test_timeline_doppler_follows_carlas_radar_convention_with_timeline_velocities():
    from simforge_oss_carla_exec.runtime.replay import (
        DopplerBody, body_containing, radar_point_world, timeline_radial_velocity,
    )
    identity = [[1, 0, 0, 0.0], [0, 1, 0, 0.0], [0, 0, 1, 1.0], [0, 0, 0, 1]]
    point = radar_point_world(identity, 20.0, 0.0, 0.0)
    assert point == pytest.approx((20.0, 0.0, 1.0))
    car = DopplerBody("car", (21.0, 0.0, 0.7), 0.0, (2.4, 1.0, 0.7), (5.0, 0.0, 0.0))
    kerb = DopplerBody("kerb", (50.0, 0.0, 0.0), 0.0, (0.5, 0.5, 0.5), (0.0, 0.0, 0.0))
    assert body_containing(point, [car, kerb]) is car
    assert body_containing((35.0, 0.0, 1.0), [car, kerb]) is None
    # Receding at 5 m/s from a sensor moving at 2 m/s: +3 m/s (CARLA: positive recedes).
    assert timeline_radial_velocity((0, 0, 1.0), point, car.velocity, (2.0, 0.0, 0.0)) == pytest.approx(3.0)
    # Static world seen from a moving sensor closes at the sensor speed.
    assert timeline_radial_velocity((0, 0, 1.0), point, (0.0, 0.0, 0.0), (2.0, 0.0, 0.0)) == pytest.approx(-2.0)


def test_radar_csv_carries_the_timeline_doppler_under_replay(tmp_path):
    from simforge_oss_carla_exec.runtime.replay import DopplerBody
    detection = type("Detection", (), {"depth": 20.0, "azimuth": 0.0, "altitude": 0.0, "velocity": 0.0})()
    transform = type("T", (), {"get_matrix": lambda _self: [[1, 0, 0, 0.0], [0, 1, 0, 0.0], [0, 0, 1, 1.0], [0, 0, 0, 1]]})()
    measurement = type("Measurement", (list,), {"transform": transform})([detection])
    context = {
        "bodies": (DopplerBody("car", (21.0, 0.0, 0.7), 0.0, (2.4, 1.0, 0.7), (5.0, 0.0, 0.0)),),
        "velocities": {"ego": (2.0, 0.0, 0.0)},
        "hostActorId": "ego", "hostVelocity": (2.0, 0.0, 0.0),
    }
    target = tmp_path / "radar.csv"
    CarlaBackend._write_radar_csv(target, measurement, context)
    header, row = target.read_text().splitlines()
    assert header == "depth_m,azimuth_rad,altitude_rad,velocity_mps,timeline_velocity_mps,timeline_actor_id"
    assert row.split(",")[3:] == ["0", "3", "car"]
    CarlaBackend._write_radar_csv(target, measurement)
    assert target.read_text().splitlines()[0] == "depth_m,azimuth_rad,altitude_rad,velocity_mps"


@pytest.mark.skipif(not CORPUS_PATH.exists(), reason="identity corpus not in this checkout")
def test_the_shared_comparator_grades_carla_observations_mapped_back_to_the_timeline():
    """CARLA observations (float32 UE, walker capsules, calibration applied)
    mapped back with timeline_observation pass WS-B's `carla` comparator
    profile; a 2 cm lift fails it."""
    st = pytest.importorskip("simforge_oss_timeline")
    from simforge_oss_carla_exec.runtime.replay import timeline_observation
    for case_id, timeline in list(_corpus_timelines())[:4]:
        sampler = BoundTimeline(timeline, _corpus_plan(timeline))
        good, lifted = [], []
        for index in range(0, len(timeline.times), 5):
            frame_ = sampler.frame_at_tick(index)
            classes = {actor_id: ("walker" if timeline.actor(actor_id)["actorClass"] == "pedestrian" else "vehicle") for actor_id in sampler.actor_ids}
            bottoms = {actor_id: (-0.93 if klass == "walker" else 0.0) for actor_id, klass in classes.items()}
            expected = expected_replay_poses(frame_, classes, bottoms, 0.05, skip=sampler.props)
            actors, raised = [], []
            for actor_id, (klass, pose) in sorted(expected.items()):
                transform = carla_transform(Carla, pose)
                ue = Transform(
                    Location(x=_float32(transform.location.x * 100) / 100, y=_float32(transform.location.y * 100) / 100, z=_float32(transform.location.z * 100) / 100),
                    Rotation(pitch=_float32(transform.rotation.pitch), yaw=_float32(transform.rotation.yaw), roll=_float32(transform.rotation.roll)),
                )
                seen = observed_pose(ue)
                kwargs = dict(walker=klass == "walker", downed=frame_.actors[actor_id].downed, bottom_offset_m=bottoms[actor_id], z_offset_m=0.05)
                actors.append(timeline_observation(actor_id, seen, **kwargs))
                raised.append(timeline_observation(actor_id, RenderPose(seen.x, seen.y, seen.z + 0.02, seen.heading_deg, seen.pitch_deg, seen.roll_deg), **kwargs))
            good.append(json.dumps({"t": frame_.t, "actors": actors}))
            lifted.append(json.dumps({"t": frame_.t, "actors": raised}))
        report = st.compare_observed(timeline, "\n".join(good), "carla")
        assert report["pass"] is True, (case_id, report["worst"][:2])
        assert report["maxPositionErrorM"] < 1e-3
        assert st.compare_observed(timeline, "\n".join(lifted), "carla")["pass"] is False, case_id


def test_rotation_parity_is_the_geodesic_angle_so_euler_aliases_measure_zero():
    from simforge_oss_carla_exec.runtime.replay import orientation_error_deg
    # UE reports pitch 90 orientations with yaw and roll exchanged.
    assert orientation_error_deg(RenderPose(0, 0, 0, 30.0, 90.0, 0.0), RenderPose(0, 0, 0, 0.0, 90.0, -30.0)) < 1e-6 or \
        orientation_error_deg(RenderPose(0, 0, 0, 30.0, 90.0, 0.0), RenderPose(0, 0, 0, 0.0, 90.0, 30.0)) < 1e-6
    assert orientation_error_deg(RenderPose(0, 0, 0, 10.0, 0, 0), RenderPose(0, 0, 0, 10.05, 0, 0)) == pytest.approx(0.05, abs=1e-9)
    assert orientation_error_deg(RenderPose(0, 0, 0, 0, 1.0, 0), RenderPose(0, 0, 0, 0, 0, 1.0)) == pytest.approx(math.sqrt(2), rel=1e-3)
