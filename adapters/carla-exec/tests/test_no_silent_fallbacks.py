"""No silent fallbacks in CARLA renders (docs/engineering/no-silent-fallbacks.md).

Every test here proves one former fallback now either fails the job with a
`carla_*` code, or happens only when the render intent allows it and is
recorded. The CARLA stand-ins are no more capable than the real bindings.
"""
from __future__ import annotations

import copy
import hashlib
import io
import json
import math
import struct
import sys
from contextlib import redirect_stdout
from pathlib import Path
from threading import Condition, Lock
from types import SimpleNamespace
from typing import Any

import pytest

from simforge_oss_carla_exec import local
from simforge_oss_carla_exec.runtime import backend as backend_module
from simforge_oss_carla_exec.runtime import executor as worker_runner
from simforge_oss_carla_exec.runtime import sensor_video
from simforge_oss_carla_exec.runtime.backend import CarlaBackend
from simforge_oss_carla_exec.runtime.compiler import (
    ActorBinding,
    ActorFrame,
    ExecutionPlan,
    PlanFrame,
    compile_xosc14,
)
from simforge_oss_carla_exec.runtime.contract import ContractError, Environment, parse_lease
from simforge_oss_carla_exec.runtime.executor import execute_lease
from simforge_oss_carla_exec.runtime.policy import (
    LIDAR_DETERMINISTIC_ATTRIBUTES,
    CarlaRenderError,
    LidarSweep,
    RenderPolicy,
    WalkerAnimationMonitor,
    bone_pose_signature,
    lidar_ticks_per_revolution,
    write_lidar_ply,
)
from simforge_oss_carla_exec.runtime.timeline import BoundTimeline

import test_runtime as rt
import test_trace_replay as tr

ALLOW_BODY = RenderPolicy(frozenset({"carla-actor-body"}), frozenset({"render-evidence.substitutions"}))


def code_of(excinfo) -> str:
    assert isinstance(excinfo.value, CarlaRenderError), excinfo.value
    return excinfo.value.code


# -- the error type ------------------------------------------------------------

def test_policy_errors_carry_the_machine_code_in_the_native_prefix_framing():
    error = CarlaRenderError("carla_map_not_cooked", "map X has no cooked world")
    assert str(error) == "[carla_map_not_cooked] map X has no cooked world"
    assert error.retryable is False
    # Handlers of either historical exception type keep catching it.
    assert isinstance(error, ContractError) and isinstance(error, RuntimeError)
    with pytest.raises(ValueError):
        CarlaRenderError("native_wrong_prefix", "x")


# -- walker animation ----------------------------------------------------------

def _bones(thigh_pitch: float, calf_pitch: float = 0.0) -> Any:
    def bone(name, pitch):
        rotation = SimpleNamespace(pitch=pitch, yaw=0.0, roll=0.0)
        return SimpleNamespace(bone_name=name, relative=SimpleNamespace(rotation=rotation))
    return SimpleNamespace(bone_transforms=[
        bone("crl_root", 0.0), bone("crl_spine__C", 1.0),
        bone("crl_thigh__L", thigh_pitch), bone("crl_leg__L", calf_pitch),
    ])


def test_bone_signature_uses_leg_bones_and_refuses_an_unreadable_skeleton():
    assert set(bone_pose_signature(_bones(10.0))) == {"crl_thigh__L", "crl_leg__L"}
    with pytest.raises(CarlaRenderError) as refused:
        bone_pose_signature(SimpleNamespace(bone_transforms=[_bones(0).bone_transforms[0]]))
    assert code_of(refused) == "carla_walker_animation_unverifiable"


def test_a_walking_walker_whose_legs_never_move_fails_the_render():
    monitor = WalkerAnimationMonitor()
    with pytest.raises(CarlaRenderError) as frozen:
        for tick in range(0, 200, 5):
            assert monitor.wants_sample("ped", tick, 1.4, False)
            monitor.observe("ped", tick, bone_pose_signature(_bones(0.0)))
    assert code_of(frozen) == "carla_walker_animation_inactive"
    assert "ped" in str(frozen.value)


def test_a_walking_walker_with_a_gait_is_proven_once_and_no_longer_sampled():
    monitor = WalkerAnimationMonitor()
    for tick, pitch in ((0, 0.0), (5, 12.0)):
        assert monitor.wants_sample("ped", tick, 1.4, False)
        monitor.observe("ped", tick, bone_pose_signature(_bones(pitch)))
    assert not monitor.wants_sample("ped", 10, 1.4, False)
    report = monitor.finish()
    assert report["walkers"]["ped"]["verdict"] == "animated"
    assert report["walkers"]["ped"]["provenAtTick"] == 5


def test_standing_or_downed_walkers_are_not_required_to_walk():
    monitor = WalkerAnimationMonitor()
    assert not monitor.wants_sample("still", 0, 0.0, False)
    assert not monitor.wants_sample("down", 0, 1.4, True)
    # A pair must span continuous walking: a stop in between restarts it.
    assert monitor.wants_sample("ped", 0, 1.4, False)
    monitor.observe("ped", 0, bone_pose_signature(_bones(0.0)))
    assert not monitor.wants_sample("ped", 5, 0.0, False)
    assert monitor.wants_sample("ped", 10, 1.4, False)
    monitor.observe("ped", 10, bone_pose_signature(_bones(0.0)))
    assert monitor.report()["walkers"] == {}
    monitor.finish()


def test_a_frozen_walker_is_caught_at_the_end_of_a_short_walk():
    monitor = WalkerAnimationMonitor()
    for tick in (0, 5, 10):
        monitor.observe("ped", tick, bone_pose_signature(_bones(3.0)))
    with pytest.raises(CarlaRenderError) as frozen:
        monitor.finish()
    assert code_of(frozen) == "carla_walker_animation_inactive"


class _GaitWorld(tr.FakeWorld):
    """Walkers expose get_bones(); `animated` decides whether the legs move."""

    def __init__(self, animated: bool):
        super().__init__()
        self.animated = animated

    def try_spawn_actor(self, blueprint, transform):
        actor = super().try_spawn_actor(blueprint, transform)
        if actor is not None and blueprint.startswith("walker."):
            world = self
            actor.get_bones = lambda: _bones(20.0 * math.sin(world.ticks) if world.animated else 0.0)
        return actor


def _replay_walk(animated: bool, ticks: int = 80) -> CarlaBackend:
    backend = tr.replay_backend(_GaitWorld(animated))
    backend.spawn(tr.BINDINGS, tr.FIRST, tr.CATALOG)
    backend.signals, backend.executed_signals, backend.executed_signal_lamps = {}, {}, {}
    backend.walker_animation = WalkerAnimationMonitor()
    for index in range(1, ticks):
        frame = tr.frame(
            index, index * 0.02,
            car=ActorFrame("active", 10.0 + index * 0.08, 5.0, 2.0, 30.0, 4.0, pitch_deg=1.5, roll_deg=-0.5),
            ped=ActorFrame("active", 12.0, 8.0 + index * 0.028, 2.2, 90.0, 1.4),
            cone=ActorFrame("active", 15.0, 9.0, 2.1, 0.0, 0.0),
        )
        backend.apply(frame)
        backend.tick(None)
    return backend


def test_trace_replay_samples_walker_bones_and_fails_a_frozen_gait():
    """The user-visible defect: walkers sliding frozen or T-posed. Parity only
    grades the root transform, so this used to render and pass."""
    with pytest.raises(CarlaRenderError) as frozen:
        _replay_walk(animated=False)
    assert code_of(frozen) == "carla_walker_animation_inactive"
    backend = _replay_walk(animated=True)
    assert backend.walker_animation.finish()["walkers"]["ped"]["verdict"] == "animated"


def test_a_walker_without_bone_readback_cannot_be_verified():
    backend = tr.replay_backend()
    backend.spawn(tr.BINDINGS, tr.FIRST, tr.CATALOG)
    backend.signals, backend.executed_signals, backend.executed_signal_lamps = {}, {}, {}
    backend.walker_animation = WalkerAnimationMonitor()
    backend.apply(tr.FIRST)
    with pytest.raises(CarlaRenderError) as unverifiable:
        backend.tick(None)
    assert code_of(unverifiable) == "carla_walker_animation_unverifiable"


# -- trace replay spawn --------------------------------------------------------

class _RefusingWorld(tr.FakeWorld):
    def __init__(self, refused: str):
        super().__init__()
        self.refused = refused

    def try_spawn_actor(self, blueprint, transform):
        if blueprint == self.refused:
            self.spawns.append((blueprint, transform))
            return None
        return super().try_spawn_actor(blueprint, transform)


@pytest.mark.parametrize("refused", ["walker.pedestrian.0015", "static.prop.trafficcone01"])
def test_replay_fails_when_carla_refuses_a_body_instead_of_dropping_it(refused):
    """Formerly the actor was dropped with outcome "dropped" (props had no
    retry at all) and the render passed unless every actor was dropped."""
    backend = tr.replay_backend(_RefusingWorld(refused))
    with pytest.raises(CarlaRenderError) as refused_spawn:
        backend.spawn(tr.BINDINGS, tr.FIRST, tr.CATALOG)
    assert code_of(refused_spawn) == "carla_actor_spawn_refused"


def test_the_replay_gate_expects_every_plan_actor_even_one_carla_never_showed():
    backend = tr.replay_backend()
    backend.spawn(tr.BINDINGS, tr.FIRST, tr.CATALOG)
    plan = ExecutionPlan("simforge.execution-plan/v1", 0.02, {
        **tr.BINDINGS, "ghost": ActorBinding("ghost", "actor_ghost", "car", "car"),
    }, (tr.FIRST,), "a" * 64)
    geometry = worker_runner._replay_geometry(backend, plan)
    assert geometry["classes"]["ghost"] == "vehicle" and geometry["classes"]["ped"] == "walker"


def test_a_body_without_a_readable_bounding_box_fails_instead_of_guessing_its_pivot():
    backend = tr.replay_backend()
    actor = SimpleNamespace(type_id="walker.pedestrian.0015", bounding_box=None)
    with pytest.raises(CarlaRenderError) as missing:
        backend._bottom_offset(actor, "walker", {"dims": {"h": 1.8}})
    assert code_of(missing) == "carla_actor_extent_unavailable"


def test_a_failed_streaming_spectator_fails_the_render():
    class World(tr.FakeWorld):
        def get_spectator(self):
            return SimpleNamespace(set_transform=lambda _t: (_ for _ in ()).throw(RuntimeError("rpc lost")))
    backend = tr.replay_backend(World())
    backend.spawn(tr.BINDINGS, tr.FIRST, tr.CATALOG)
    backend.signals, backend.executed_signals, backend.executed_signal_lamps = {}, {}, {}
    backend.apply(tr.FIRST)
    with pytest.raises(CarlaRenderError) as failed:
        backend.tick(None)
    assert code_of(failed) == "carla_streaming_anchor_failed"


def test_the_radar_host_velocity_is_required_for_a_mounted_radar():
    context = {"velocities": {"ego": (2.0, 0.0, 0.0)}}
    assert CarlaBackend._radar_host_velocity(context, "ego") == (2.0, 0.0, 0.0)
    assert CarlaBackend._radar_host_velocity(context, None) == (0.0, 0.0, 0.0)
    with pytest.raises(CarlaRenderError) as missing:
        CarlaBackend._radar_host_velocity(context, "other")
    assert code_of(missing) == "carla_radar_host_velocity_unavailable"


# -- blueprint placement probe ---------------------------------------------------

class _ProbeWorld:
    def __init__(self, spawn_points=(), placeable=frozenset(), destroy_result=True):
        self.spawn_points, self.placeable, self.destroy_result = list(spawn_points), placeable, destroy_result
        self.probes = []

    def get_blueprint_library(self):
        return SimpleNamespace(find=lambda blueprint_id: blueprint_id)

    def get_map(self):
        return SimpleNamespace(get_spawn_points=lambda: self.spawn_points)

    def try_spawn_actor(self, blueprint, transform):
        self.probes.append((blueprint, transform))
        if blueprint not in self.placeable:
            return None
        return SimpleNamespace(destroy=lambda: self.destroy_result)


def test_a_world_without_spawn_points_still_probes_every_blueprint():
    """Formerly every id was reported placeable, unverified, when the map had
    no spawn points."""
    backend = object.__new__(CarlaBackend)
    backend.carla = tr.Carla
    backend.world = _ProbeWorld(placeable=frozenset({"vehicle.lincoln.mkz"}))
    assert backend.spawnable_blueprints({"vehicle.lincoln.mkz", "walker.pedestrian.0099"}) == frozenset({"vehicle.lincoln.mkz"})
    assert {transform.location.z for _blueprint, transform in backend.world.probes} == {backend_module.BLUEPRINT_PROBE_ALTITUDE_M}


def test_a_placement_probe_that_cannot_be_destroyed_fails():
    backend = object.__new__(CarlaBackend)
    backend.carla = tr.Carla
    backend.world = _ProbeWorld(placeable=frozenset({"vehicle.lincoln.mkz"}), destroy_result=False)
    with pytest.raises(RuntimeError, match="failed to destroy"):
        backend.spawnable_blueprints({"vehicle.lincoln.mkz"})


def test_the_mkz_is_no_longer_aliased_to_the_impala():
    assert not hasattr(backend_module, "RUNTIME_BLUEPRINT_ALIASES")


# -- environment ------------------------------------------------------------------

REQUEST = Environment(0.0, 0.0, 0.0, 0.0, 0.0, 5.0, 0.0, 0.0, 0.0)  # clear dawn


class _WeatherWorld:
    def __init__(self, enabled):
        self.enabled, self.weather = enabled, None

    def is_weather_enabled(self): return self.enabled
    def set_weather(self, weather): self.weather = weather
    def get_weather(self): return self.weather


def _weather_backend(enabled, map_name="Belmont_Office_Park_Belmont_CA"):
    backend = object.__new__(CarlaBackend)
    backend.carla = SimpleNamespace(WeatherParameters=lambda **values: SimpleNamespace(**values))
    backend.world = _WeatherWorld(enabled)
    backend.map_evidence = {"loadedMapName": map_name}
    return backend


def test_a_cooked_map_with_baked_lighting_fails_a_request_it_cannot_show():
    """Formerly any clear request with the sun above the horizon (dawn, dusk,
    any azimuth) rendered the cooked map's baked daylight and passed."""
    backend = _weather_backend(enabled=False)
    with pytest.raises(CarlaRenderError) as refused:
        backend.configure_environment(REQUEST)
    assert code_of(refused) == "carla_environment_unsupported_on_cooked_map"


def test_a_cooked_map_renders_a_request_equal_to_its_registered_baked_environment(monkeypatch):
    baked = {field: float(getattr(REQUEST, field)) for field in backend_module.ENVIRONMENT_FIELDS}
    monkeypatch.setattr(backend_module, "COOKED_MAP_BAKED_ENVIRONMENTS", {"Belmont_Office_Park_Belmont_CA": baked})
    backend = _weather_backend(enabled=False)
    backend.configure_environment(REQUEST)
    evidence = backend.environment_evidence
    assert (evidence["mode"], evidence["exact"], evidence["observed"]) == ("cooked-baked", True, baked)
    assert worker_runner._environment_evidence_is_accepted(evidence, REQUEST)
    noon = Environment(0.0, 0.0, 0.0, 0.0, 0.0, 75.0, 0.0, 0.0, 0.0)
    with pytest.raises(CarlaRenderError, match="bakes a different environment"):
        _weather_backend(enabled=False).configure_environment(noon)


def test_a_world_with_weather_applies_and_reads_back_the_request():
    backend = _weather_backend(enabled=True)
    backend.configure_environment(REQUEST)
    assert backend.environment_evidence["mode"] == "runtime-weather"
    assert worker_runner._environment_evidence_is_accepted(backend.environment_evidence, REQUEST)
    # The former inexact "cooked-baked-default" evidence is never accepted.
    legacy = {
        "schema": "simforge.environment-evidence/v1", "available": True, "exact": False,
        "requested": backend.environment_evidence["requested"], "observed": None,
        "mode": "cooked-baked-default", "reason": "custom-map-baked-default-daylight",
    }
    assert not worker_runner._environment_evidence_is_accepted(legacy, REQUEST)


def _v3(**overrides):
    spec = tr._v3_spec()
    for key, value in overrides.items():
        spec[key] = value
    return spec


@pytest.mark.parametrize("environment, code", [
    ({"timeOfDay": "noon"}, "carla_environment_incomplete"),
    ({"weather": "clear", "timeOfDay": "night_lit"}, "carla_environment_unsupported"),
    ({"weather": "clear", "timeOfDay": "noon", "sunAzimuthDeg": 90}, "carla_environment_unresolvable"),
    ({"weather": "sandstorm", "timeOfDay": "noon"}, "carla_environment_unsupported"),
])
def test_environment_mapping_refuses_what_carla_cannot_show(environment, code):
    with pytest.raises(CarlaRenderError) as refused:
        local._render_spec_v3_to_native(_v3(authoredEnvironment=environment))
    assert code_of(refused) == code


def test_environment_mapping_uses_the_preset_only_for_what_the_scenario_leaves_to_it():
    native, _parsed, _ = local._render_spec_v3_to_native(_v3(authoredEnvironment={"weather": "clear", "timeOfDay": "dawn"}))
    assert (native["environment"]["sunAltitude"], native["environment"]["sunAzimuth"]) == (5.0, 0.0)
    native, _parsed, _ = local._render_spec_v3_to_native(
        _v3(authoredEnvironment={"weather": "clear", "timeOfDay": "dawn", "sunElevationDeg": 12})
    )
    assert native["environment"]["sunAltitude"] == 12.0


# -- capture rate and video ---------------------------------------------------------

def test_a_camera_asking_for_another_fps_fails_instead_of_being_captured_at_the_video_fps():
    spec = tr._v3_spec()
    spec["sources"][0]["attributes"]["fps"] = 30
    with pytest.raises(CarlaRenderError) as refused:
        local._render_spec_v3_to_native(spec)
    assert code_of(refused) == "carla_camera_fps_mismatch"


def test_a_video_size_other_than_the_camera_fails_instead_of_being_ignored():
    spec = tr._v3_spec()
    spec["video"]["width"] = 1920
    with pytest.raises(CarlaRenderError) as refused:
        local._render_spec_v3_to_native(spec)
    assert code_of(refused) == "carla_video_size_mismatch"


def test_lossless_video_fails_instead_of_becoming_lossy_cinematic():
    spec = tr._v3_spec()
    spec["video"]["quality"] = "lossless"
    with pytest.raises(CarlaRenderError) as refused:
        local._render_spec_v3_to_native(spec)
    assert code_of(refused) == "carla_video_quality_unsupported"


def test_a_render_without_video_takes_the_camera_rate_and_needs_one():
    spec = tr._v3_spec()
    spec["artifacts"] = ["manifest"]
    del spec["video"]
    spec["sources"][0]["attributes"]["fps"] = 10
    native, parsed, _ = local._render_spec_v3_to_native(spec)
    assert parsed.fps == 10.0  # formerly 24, whatever the camera asked
    lidar_only = copy.deepcopy(spec)
    lidar_only["sources"][0].update({
        "modality": "lidar",
        "attributes": {"channels": 32, "rangeM": 100, "pointsPerSecond": 100_000, "rotationFrequencyHz": 10,
                       "upperFovDeg": 10, "lowerFovDeg": -30, "horizontalFovDeg": 360},
    })
    with pytest.raises(CarlaRenderError) as refused:
        local._render_spec_v3_to_native(lidar_only)
    assert code_of(refused) == "carla_render_fps_unspecified"


def test_a_lidar_source_must_state_its_horizontal_fov():
    spec = tr._v3_spec()
    spec["sources"].append({
        "actorId": "ego", "sensorId": "roof", "outputName": "roof", "modality": "lidar",
        "transform": spec["sources"][0]["transform"],
        "attributes": {"channels": 32, "rangeM": 100, "pointsPerSecond": 100_000, "rotationFrequencyHz": 10,
                       "upperFovDeg": 10, "lowerFovDeg": -30},
    })
    with pytest.raises(ContractError, match="invalid lidar fields"):
        local._render_spec_v3_to_native(spec)
    spec["sources"][1]["attributes"]["horizontalFovDeg"] = 120
    _native, parsed, _ = local._render_spec_v3_to_native(spec)
    assert parsed.sensors[1].config["horizontalFovDeg"] == 120.0


def test_unmet_preferred_capabilities_are_reported():
    assert local._unmet_preferred_capabilities(tr._v3_spec(preferred=["map.static_semantics", "sensor.rgb"])) == [
        "map.static_semantics",
    ]


def test_the_sensor_mount_frame_matches_the_native_engine():
    """Mount frame: +X forward, +Y up, +Z left; yaw CCW (left). The native
    engine flips the yaw sign for CARLA's clockwise attach yaw and keeps pitch
    (up); CARLA's y is right. `lowerRenderSpecToCarla` in render-spec.ts
    (pitch -, yaw +) has no production consumer and disagrees with both."""
    spec = tr._v3_spec()
    spec["sources"][0]["transform"] = {
        "position": {"x": 1.0, "y": 1.5, "z": 0.5},
        "rotation": {"yawRad": math.pi / 2, "pitchRad": 0.1, "rollRad": 0.0},
    }
    native, _parsed, _ = local._render_spec_v3_to_native(spec)
    mount = native["sensors"][0]["transform"]
    # What configure_sensors hands CARLA: Location(x, -y, z), Rotation(pitch, -yaw, roll).
    carla_location = (mount["x"], -mount["y"], mount["z"])
    carla_rotation = (mount["pitch"], -mount["yaw"], mount["roll"])
    assert carla_location == pytest.approx((1.0, -0.5, 1.5))   # 0.5 m left is CARLA y = -0.5
    assert carla_rotation[1] == pytest.approx(-90.0)          # facing left is CARLA yaw -90
    assert carla_rotation[0] == pytest.approx(math.degrees(0.1))  # pitched up stays positive


# -- lidar --------------------------------------------------------------------------

def test_lidar_revolutions_must_span_whole_ticks():
    assert lidar_ticks_per_revolution(10.0, 0.02) == 5
    assert lidar_ticks_per_revolution(50.0, 0.02) == 1
    with pytest.raises(CarlaRenderError) as refused:
        lidar_ticks_per_revolution(20.0, 0.02)
    assert code_of(refused) == "carla_lidar_schedule_unsupported"


def _points(*values: tuple[float, float, float, float]) -> bytes:
    return b"".join(struct.pack("<4f", *value) for value in values)


def test_a_lidar_capture_holds_one_full_revolution_not_a_single_tick_sector(tmp_path):
    sweep = LidarSweep("lidar", 3)
    for frame, x in ((10, 1.0), (11, 2.0), (12, 3.0), (13, 4.0)):
        sweep.add(frame, _points((x, 0.0, 0.0, 0.5)))
    target = tmp_path / "rev.ply"
    assert write_lidar_ply(target, "lidar", sweep.revolution(13)) == 3
    points = sensor_video._read_lidar_points(target)
    assert [point[0] for point in points] == [2.0, 3.0, 4.0]
    with pytest.raises(CarlaRenderError, match="contiguous tick slices"):
        sweep.revolution(14)
    sweep.add(20, _points((9.0, 0.0, 0.0, 0.5)))  # a gap starts a new revolution
    with pytest.raises(CarlaRenderError, match="contiguous tick slices"):
        sweep.revolution(20)


class _Blueprint:
    def __init__(self, blueprint_id, attributes):
        self.id, self.available, self.values = blueprint_id, set(attributes), {}

    def has_attribute(self, name): return name in self.available
    def set_attribute(self, name, value): self.values[name] = value


_LIDAR_ATTRIBUTES = {
    "channels", "range", "points_per_second", "rotation_frequency", "upper_fov", "lower_fov",
    "horizontal_fov", "sensor_tick", *LIDAR_DETERMINISTIC_ATTRIBUTES,
}


class _SensorWorld:
    """Every tick each listening lidar delivers the sector swept in that tick."""

    def __init__(self):
        self.frame = 100
        self.listeners: list[tuple[Any, Any]] = []
        self.spawned: list[tuple[Any, Any]] = []

    def get_blueprint_library(self):
        return SimpleNamespace(find=lambda blueprint_id: _Blueprint(blueprint_id, _LIDAR_ATTRIBUTES))

    def spawn_actor(self, blueprint, transform, attach_to=None):
        world = self
        sensor = SimpleNamespace(
            type_id=blueprint.id, parent=attach_to, attributes=dict(blueprint.values),
            listen=lambda callback: world.listeners.append((sensor, callback)),
            destroy=lambda: True, stop=lambda: None,
        )
        self.spawned.append((blueprint, transform))
        return sensor

    def tick(self):
        self.frame += 1
        for _sensor, callback in self.listeners:
            callback(SimpleNamespace(frame=self.frame, timestamp=self.frame * 0.02,
                                     raw_data=_points((float(self.frame), 0.0, 0.0, 1.0))))
        return self.frame

    def get_spectator(self):
        return SimpleNamespace(set_transform=lambda _t: None)


def _sensor_backend(world, mode="trace-replay", server_version="0.9.16"):
    backend = object.__new__(CarlaBackend)
    backend.client = SimpleNamespace(get_server_version=lambda: server_version)
    backend.carla = SimpleNamespace(
        Transform=tr.Transform, Location=tr.Location, Rotation=tr.Rotation, ColorConverter=None,
    )
    backend.world = world
    ego_transform = tr.Transform(tr.Location(0.0, 0.0, 0.0), tr.Rotation())
    backend.actors = {"ego": SimpleNamespace(id=7, get_transform=lambda: ego_transform)}
    backend.execution_mode = mode
    backend.fixed_timestep_s = 0.02
    backend.map_evidence = {"loadedMapName": "Belmont_Office_Park_Belmont_CA"}
    backend.camera_grade_evidence, backend.visual_quality_stats, backend.sensor_listen_retries = {}, {}, {}
    backend.sensors, backend.sensor_records = [], []
    backend.sensor_lock = Lock()
    backend.sensor_condition = Condition(backend.sensor_lock)
    backend.sensor_pending, backend.sensor_last_frame = {}, {}
    backend.sensor_error, backend.sensor_closed = None, False
    backend.sensor_timeout_s, backend.sensor_writer_workers, backend.sensor_writer_pool = 1.0, 1, None
    backend.capture_disk_bytes = 0
    backend.last_carla_frame = None
    backend.current_plan_frame = None
    backend.carla_to_plan_frame = {}
    backend.streaming_evidence = {"available": True}
    backend.bottom_offsets, backend.z_offset_m, backend.actor_classes = {"ego": 0.0}, 0.0, {"ego": "vehicle"}
    return backend


def _lidar_spec(rotation_hz=10, modality="lidar"):
    value = rt.lease_value(outputs=["trace"], sensors=[{
        "role": "roof", "actorId": "ego", "sensorId": "lidar-1", "modality": modality,
        "transform": {"x": 0, "y": 0, "z": 2.4, "pitch": 0, "yaw": 0, "roll": 0},
        "config": {"channels": 32, "rangeM": 120, "pointsPerSecond": 100_000, "rotationFrequencyHz": rotation_hz,
                   "upperFovDeg": 10, "lowerFovDeg": -30, "horizontalFovDeg": 270},
    }], formats=["json", "ply"])
    return parse_lease(value).render_spec


def test_lidar_sets_every_noise_and_dropoff_attribute_and_reads_them_back(tmp_path):
    """Formerly six attributes were set and CARLA's defaults (e.g. a 45 %
    random point drop-off) applied unrecorded; horizontal FOV was never set."""
    world = _SensorWorld()
    backend = _sensor_backend(world)
    backend.configure_sensors(_lidar_spec(), tmp_path / "out", 10**9)
    blueprint, _transform = world.spawned[0]
    assert blueprint.values["dropoff_general_rate"] == "0.0"
    assert blueprint.values["noise_stddev"] == "0.0"
    assert blueprint.values["horizontal_fov"] == "270.0"
    evidence = backend.sensor_attribute_evidence["roof:ego:lidar-1:lidar"]
    assert evidence["observed"]["dropoff_general_rate"] == "0.0"
    assert set(evidence["requested"]) == set(evidence["observed"])


def test_a_blueprint_missing_a_lidar_noise_attribute_fails(tmp_path):
    world = _SensorWorld()
    world.get_blueprint_library = lambda: SimpleNamespace(
        find=lambda blueprint_id: _Blueprint(blueprint_id, _LIDAR_ATTRIBUTES - {"dropoff_general_rate"}),
    )
    with pytest.raises(CarlaRenderError) as refused:
        _sensor_backend(world).configure_sensors(_lidar_spec(), tmp_path / "out", 10**9)
    assert code_of(refused) == "carla_sensor_attribute_unsupported"


def test_replay_pre_rolls_and_captures_full_lidar_revolutions(tmp_path):
    world = _SensorWorld()
    backend = _sensor_backend(world)
    output = tmp_path / "out"
    backend.configure_sensors(_lidar_spec(rotation_hz=10), output, 10**9)
    report = backend._prepare_replay(lambda: None)
    assert report["lidarPreRollTicks"] == 4
    # t=0 capture on the next tick, then two non-capture ticks, then a capture.
    backend.tick({"outputFrameIndex": 0, "scheduledTimeS": 0.0, "contentTimeS": 0.0})
    backend.tick(None)
    backend.tick(None)
    backend.tick({"outputFrameIndex": 1, "scheduledTimeS": 0.06, "contentTimeS": 0.06})
    key = "roof:ego:lidar-1:lidar"
    first = sensor_video._read_lidar_points(output / key / "00000000.ply")
    second = sensor_video._read_lidar_points(output / key / "00000001.ply")
    # Each capture is the five tick sectors ending at its own tick.
    assert [point[0] for point in first] == [float(frame) for frame in range(world.frame - 7, world.frame - 2)]
    assert [point[0] for point in second] == [float(frame) for frame in range(world.frame - 4, world.frame + 1)]


def test_physics_validation_cannot_assemble_multi_tick_lidar_revolutions(tmp_path):
    with pytest.raises(CarlaRenderError) as refused:
        _sensor_backend(_SensorWorld(), mode="native-physics").configure_sensors(_lidar_spec(rotation_hz=10), tmp_path, 10**9)
    assert code_of(refused) == "carla_lidar_schedule_unsupported"


def test_semantic_lidar_gets_no_ray_cast_noise_attributes(tmp_path):
    world = _SensorWorld()
    backend = _sensor_backend(world)
    backend.configure_sensors(_lidar_spec(modality="semantic-lidar"), tmp_path / "out", 10**9)
    assert not set(LIDAR_DETERMINISTIC_ATTRIBUTES) & set(world.spawned[0][0].values)


# -- camera grade ------------------------------------------------------------------

_RGB_ATTRIBUTES = {
    "image_size_x", "image_size_y", "fov", "sensor_tick", "temp", "scene_color_tint", "slope",
    "shadow_constrast_scale", "exposure_compensation", "enable_postprocess_effects",
    "motion_blur_intensity", "gamma",
}


def _rgb_spec():
    return parse_lease(rt.lease_value(outputs=["trace"])).render_spec


def test_the_rgb_grade_is_keyed_by_the_exact_cooked_map_and_recorded(tmp_path):
    world = _SensorWorld()
    world.get_blueprint_library = lambda: SimpleNamespace(find=lambda blueprint_id: _Blueprint(blueprint_id, _RGB_ATTRIBUTES))
    backend = _sensor_backend(world)
    backend.map_evidence = {"loadedMapName": "Yale_St_Palo_Alto_CA"}
    backend.configure_sensors(_rgb_spec(), tmp_path / "out", 10**9)
    blueprint = world.spawned[0][0]
    assert blueprint.values["exposure_compensation"] == "-0.4"
    grade = backend.camera_grade_evidence["primary:ego:hero:rgb"]
    assert grade["profile"] == "rrmaps-accepted-v1" and grade["mapExposureSource"] == "COOKED_MAP_RGB_EXPOSURE"
    # A map whose name merely contains "Yale" gets no exposure (formerly a substring match).
    other = _SensorWorld()
    other.get_blueprint_library = world.get_blueprint_library
    near = _sensor_backend(other)
    near.map_evidence = {"loadedMapName": "Old_Yale_Test"}
    near.configure_sensors(_rgb_spec(), tmp_path / "out2", 10**9)
    assert "exposure_compensation" not in other.spawned[0][0].values


def test_a_camera_missing_a_quality_attribute_fails_instead_of_skipping_it(tmp_path):
    world = _SensorWorld()
    world.get_blueprint_library = lambda: SimpleNamespace(
        find=lambda blueprint_id: _Blueprint(blueprint_id, _RGB_ATTRIBUTES - {"enable_postprocess_effects"}),
    )
    with pytest.raises(CarlaRenderError) as refused:
        _sensor_backend(world).configure_sensors(_rgb_spec(), tmp_path / "out", 10**9)
    assert code_of(refused) == "carla_sensor_attribute_unsupported"


# -- worker configuration ---------------------------------------------------------

@pytest.mark.parametrize("name, value", [
    ("SIMFORGE_CARLA_ALLOW_GENERATED_XODR", "1"),
    ("SIMFORGE_CARLA_MAP_BINDING", "allow-approximate"),
    ("SIMFORGE_CARLA_MAP_Z_OFFSETS_JSON", '{"' + "c" * 64 + '": 0.1}'),
    ("SIMFORGE_CARLA_SIGNAL_ID_MAP", '{"1": "2"}'),
])
def test_worker_settings_that_changed_render_output_are_refused(monkeypatch, name, value):
    monkeypatch.setenv(name, value)
    with pytest.raises(CarlaRenderError) as refused:
        backend_module.forbid_output_changing_worker_config()
    assert code_of(refused) == "carla_forbidden_worker_config"


def test_identity_attestation_never_invents_a_version(monkeypatch):
    for name in ("SIMFORGE_CARLA_VERSION", "SIMFORGE_ENGINE_VERSION", "SIMFORGE_WORKER_IMAGE_DIGEST", "SIMFORGE_WORKER_REVISION"):
        monkeypatch.delenv(name, raising=False)
    attestation = worker_runner._attestation({}, "trace-replay", {"carlaServerVersion": "0.10.0"})
    assert attestation["carlaVersion"] is None and attestation["engineVersion"] is None
    assert attestation["carlaServerVersion"] == "0.10.0"
    assert attestation["workerIdentityComplete"] is False
    monkeypatch.setenv("SIMFORGE_CARLA_VERSION", "0.10.0")
    assert worker_runner._attestation({}, "trace-replay", {})["carlaVersion"] == "0.10.0"


def test_map_evidence_other_than_an_exact_cooked_binding_is_rejected():
    lease = parse_lease(rt.lease_value())
    base = {
        "schema": "simforge.carla-map-evidence/v1", "available": True, "source": "cooked-custom-map",
        "identityMode": "xodr-byte-exact", "binding": "exact", "exact": True,
        "packageXodrSha256": lease.execution_package.xodr.sha256,
    }
    assert worker_runner._map_binding({"map": base}, lease) == ("exact", [])
    for override in (
        {"source": "generated-opendrive-world", "identityMode": "generated-opendrive"},
        {"identityMode": "approximate", "binding": "approximate", "exact": False},
    ):
        assert worker_runner._map_binding({"map": {**base, **override}}, lease) == (None, ["map-binding"])


# -- compiler -------------------------------------------------------------------------

def test_an_entity_without_a_kind_fails_instead_of_becoming_a_prop():
    """Formerly a CatalogReference with no kind property compiled as a
    static_object, so a road user rendered as a prop."""
    start = rt.XOSC.index(b'<Vehicle name="uniscenarios_car"')
    end = rt.XOSC.index(b"</Vehicle>") + len(b"</Vehicle>")
    xosc = rt.XOSC[:start] + b'<CatalogReference catalogName="c" entryName="vehicle.sedan"/>' + rt.XOSC[end:]
    with pytest.raises(CarlaRenderError) as refused:
        compile_xosc14(xosc)
    assert code_of(refused) == "carla_xosc_unsupported_or_incomplete"


def test_a_world_position_without_z_fails_instead_of_meaning_zero():
    xosc = rt.XOSC.replace(b'<WorldPosition x="0.2" y="0" z="0" h="0" p="0" r="0"/>', b'<WorldPosition x="0.2" y="0" h="0" p="0" r="0"/>')
    with pytest.raises(CarlaRenderError, match="lacks z"):
        compile_xosc14(xosc)


def test_init_actions_the_replay_cannot_execute_fail_instead_of_being_ignored():
    appearance = (
        b'<PrivateAction><AppearanceAction><LightStateAction><LightType><VehicleLight vehicleLightType="lowBeam"/>'
        b'</LightType><LightState mode="on"/></LightStateAction></AppearanceAction></PrivateAction>'
    )
    xosc = rt.XOSC.replace(b"</TeleportAction></PrivateAction>", b"</TeleportAction></PrivateAction>" + appearance, 1)
    with pytest.raises(CarlaRenderError, match="AppearanceAction is not executable"):
        compile_xosc14(xosc)
    # The exporter's Init EnvironmentAction is a copy of the intent's environment.
    environment = b'<GlobalAction><EnvironmentAction><Environment name="e"/></EnvironmentAction></GlobalAction>'
    compile_xosc14(rt.XOSC.replace(b"<Init><Actions>", b"<Init><Actions>" + environment))


def test_a_knockdown_for_no_actor_fails():
    xosc = rt.XOSC.replace(
        b'<Property name="uniscenarios.provenance.inputHash"',
        b'<Property name="uniscenarios.trajectoryReplay.knockedDownAtS.nobody" value="0.02"/><Property name="uniscenarios.provenance.inputHash"',
    )
    with pytest.raises(CarlaRenderError, match="knockdown times name no actor: nobody"):
        compile_xosc14(xosc)


# -- appearance -----------------------------------------------------------------------

def _appearance_plan(**appearance):
    frames = tuple(
        PlanFrame(index, index * 0.02, {"ego": ActorFrame("spawn" if index == 0 else "active", 0, 0, 0, 0, 0, dict(appearance))}, {})
        for index in range(3)
    )
    return ExecutionPlan("simforge.execution-plan/v1", 0.02, {"ego": ActorBinding("ego", "actor_ego", "car", "c")}, frames, "a" * 64)


def test_a_visual_appearance_cue_fails_while_an_audio_cue_is_only_recorded():
    """Formerly pose cues rendered as nothing, listed as `unrenderedCues`."""
    with pytest.raises(CarlaRenderError) as refused:
        worker_runner._preflight_appearance(_appearance_plan(**{"cue.pose.stopArm:extended": "requested"}))
    assert code_of(refused) == "carla_appearance_cue_unsupported"
    plan = _appearance_plan(**{"cue.audio.horn": "requested"})
    worker_runner._preflight_appearance(plan)
    assert worker_runner._appearance_capability(plan)["unrenderedCues"] == ["cue.audio.horn"]


class _Timeline:
    dt, warmup_s, clip_end_s = 0.02, 0.0, 0.04
    times = [0.0, 0.02, 0.04]
    actor_ids = ["ego"]
    sha256 = key = trace_sha256 = "c" * 64
    xodr_sha256 = None
    modes: dict[str, str] = {"indicatorLeft": "flashing", "indicatorRight": "flashing"}

    def props(self): return []
    def poses(self, t):
        return {"ego": {"present": True, "x": 0.0, "y": 0.0, "z": 0.0, "headingRad": 0.0, "pitchRad": 0.0,
                        "rollRad": 0.0, "speedMps": 0.0, "downed": False}}
    def signals_at(self, t): return {}
    def light_modes_at(self, actor_id, t): return dict(self.modes)


def test_a_baked_timeline_renders_the_xosc_doors_instead_of_dropping_them():
    """Formerly doors were dropped with a timeline but reported as rendered."""
    plan = _appearance_plan(**{"door.doorFrontLeft": "open", "light.warningLights": "flashing"})
    sampler = BoundTimeline(_Timeline(), plan)
    state = sampler.frame_at(1, 0.02).actors["ego"]
    assert state.appearance["door.doorFrontLeft"] == "open"
    # Hazards render through both indicators, never as a second writer.
    assert "light.warningLights" not in state.appearance
    rendered = set(state.appearance)
    worker_runner._verify_timeline_appearance(plan, rendered)
    with pytest.raises(CarlaRenderError) as incomplete:
        worker_runner._verify_timeline_appearance(plan, {"light.indicatorLeft", "light.indicatorRight"})
    assert code_of(incomplete) == "carla_timeline_appearance_incomplete"


def test_a_hazard_the_timeline_indicators_do_not_show_fails():
    timeline = _Timeline()
    timeline.modes = {"indicatorLeft": "flashing", "indicatorRight": "off"}
    sampler = BoundTimeline(timeline, _appearance_plan(**{"light.warningLights": "flashing"}))
    with pytest.raises(CarlaRenderError) as refused:
        sampler.frame_at(1, 0.02)
    assert code_of(refused) == "carla_timeline_appearance_incomplete"


def test_an_unknown_timeline_light_channel_or_missing_key_fails():
    timeline = _Timeline()
    timeline.modes = {"fogLamp": "on"}
    with pytest.raises(CarlaRenderError) as unknown:
        BoundTimeline(timeline, _appearance_plan()).frame_at(0, 0.0)
    assert code_of(unknown) == "carla_timeline_incomplete"

    class Legacy(_Timeline):
        def poses(self, t):
            pose = super().poses(t)
            del pose["ego"]["downed"]
            return pose
    with pytest.raises(CarlaRenderError, match="lacks downed"):
        BoundTimeline(Legacy(), _appearance_plan()).frame_at(0, 0.0)


# -- sensor visualizations ---------------------------------------------------------------

def test_sensor_visualizations_refuse_malformed_frames_and_use_fixed_scales(tmp_path):
    ply = tmp_path / "bad.ply"
    ply.write_text("ply\nformat ascii 1.0\nelement vertex 2\nproperty float32 x\nproperty float32 y\nproperty float32 z\nproperty float32 I\nend_header\n1 2 3 0.5\n")
    with pytest.raises(sensor_video.SensorVideoError, match="declares 2 points but holds 1"):
        sensor_video._read_lidar_points(ply)
    csv = tmp_path / "bad.csv"
    csv.write_text("depth_m,azimuth_rad,altitude_rad,velocity_mps\n10,0,x,1\n")
    with pytest.raises(sensor_video.SensorVideoError, match="not numeric"):
        sensor_video._read_radar_detections(csv)
    assert "-fs" not in sensor_video._ffmpeg_common(10.0, tmp_path / "out.mp4")
    radar = SimpleNamespace(modality="radar", config={"rangeM": 80.0})
    assert sensor_video.visualization_scales(radar) == {"viewRangeM": 80.0, "velocityScaleMps": 20.0}


# -- executor --------------------------------------------------------------------------

def _catalog_lease(catalog_entries):
    catalog = json.dumps({
        "contractVersion": "simforge.asset-catalog/v1", "catalogVersionId": "uscatalog-1", "entries": catalog_entries,
    }).encode()
    manifest = json.loads(rt.MANIFEST)
    manifest["assetCatalog"]["manifestSha256"] = rt.digest(catalog)
    manifest_bytes = json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()
    value = rt.lease_value()
    value["job"]["executionPackage"]["assetCatalog"].update({"sha256": rt.digest(catalog), "sizeBytes": len(catalog)})
    lease = parse_lease(rt.seal_lease(value, manifest_bytes))
    assets = {"memory:manifest": manifest_bytes, "memory:xosc": rt.XOSC, "memory:xodr": rt.XODR,
              "memory:catalog": catalog, "memory:traffic": rt.DISABLED_TRAFFIC}
    return lease, assets


_SUBSTITUTE_SEDAN = [{
    "id": "vehicle.sedan", "class": "vehicle", "actorClass": "car", "dims": {"l": 4.7, "w": 1.82, "h": 1.45},
    "runtimeBindings": {"carla": {"mode": "native-blueprint", "blueprintId": "vehicle.lincoln.mkz", "fidelity": "semantic-substitute"}},
}]


def test_the_executor_records_and_announces_an_allowed_substitution():
    lease, assets = _catalog_lease(_SUBSTITUTE_SEDAN)
    validator = lambda body: {"valid": True, "xmlSha256": rt.digest(body), "xsdSha256": rt.OFFICIAL_XSD_SHA256}
    with pytest.raises(CarlaRenderError) as refused:
        execute_lease(lease, rt.FakeBackend(), validator, downloader=lambda url, _limit: assets[url], uploader=lambda *_a: None)
    assert code_of(refused) == "carla_blueprint_unavailable"
    events = []
    result = execute_lease(
        lease, rt.FakeBackend(), validator,
        downloader=lambda url, _limit: assets[url], uploader=lambda *_a: None,
        progress=lambda event, payload: events.append((event, payload)), policy=ALLOW_BODY,
    )
    assert [(item["subject"], item["rendered"]) for item in result["substitutions"]] == [("ego", "vehicle.lincoln.mkz")]
    assert [payload["subject"] for event, payload in events if event == "substitution"] == ["ego"]


def test_compile_time_body_substitutions_need_the_allowance():
    with pytest.raises(CarlaRenderError) as refused:
        worker_runner._compiled_substitutions(
            {"carlaVehicleFallbacks": [{"actorId": "ego", "authoredCatalogId": "a", "fallbackCatalogId": "b"}]}, RenderPolicy(),
        )
    assert code_of(refused) == "carla_blueprint_unavailable"
    records = worker_runner._compiled_substitutions(
        {"carlaVehicleFallbacks": [{"actorId": "ego", "authoredCatalogId": "a", "fallbackCatalogId": "b"}]}, ALLOW_BODY,
    )
    assert [(item["requested"], item["rendered"], item["allowedBy"]) for item in records] == [("a", "b", "allowSubstitutions")]


class _NoLidarDataBackend(rt.FakeBackend):
    def tick(self, capture=None, abort=None):
        (abort or (lambda: None))()
        if capture is not None:
            for sensor in self.sensor_specs:
                self.records.append({
                    "artifactName": sensor.artifact_name, "role": sensor.role, "actorId": sensor.actor_id,
                    "sensorId": sensor.sensor_id, "modality": sensor.modality,
                    "outputFrameIndex": int(capture["outputFrameIndex"]), "scheduledTimeS": capture["scheduledTimeS"],
                    "carlaFrame": self.frame.index + 1, "actualCarlaTimeS": self.frame.t, "relativePath": "x",
                })
        return rt._fake_readback(self)


def test_a_lidar_that_captured_no_data_directory_fails_instead_of_being_skipped():
    value = rt.lease_value(outputs=["trace"], sensors=[{
        "role": "roof", "actorId": "ego", "sensorId": "lidar-1", "modality": "lidar",
        "transform": {"x": 0, "y": 0, "z": 2.4, "pitch": 0, "yaw": 0, "roll": 0},
        "config": {"channels": 32, "rangeM": 120, "pointsPerSecond": 100_000, "rotationFrequencyHz": 25,
                   "upperFovDeg": 10, "lowerFovDeg": -30, "horizontalFovDeg": 360},
    }], formats=["json", "ply"])
    lease = parse_lease(value)
    assets = {"memory:manifest": rt.MANIFEST, "memory:xosc": rt.XOSC, "memory:xodr": rt.XODR,
              "memory:catalog": rt.CATALOG, "memory:traffic": rt.DISABLED_TRAFFIC}
    with pytest.raises(CarlaRenderError) as missing:
        execute_lease(
            lease, _NoLidarDataBackend(),
            lambda body: {"valid": True, "xmlSha256": rt.digest(body), "xsdSha256": rt.OFFICIAL_XSD_SHA256},
            downloader=lambda url, _limit: assets[url], uploader=lambda *_a: None,
        )
    assert code_of(missing) == "carla_sensor_capture_missing"


# -- run-intent ----------------------------------------------------------------------------

def _local_intent(tmp_path, *, allow=None, cooked=True, monkeypatch):
    from simforge_oss_carla_exec import run_local
    scenario = tmp_path / "scenario.xosc"
    scenario.write_bytes(rt.XOSC)
    xodr = tmp_path / "map.xodr"
    xodr.write_bytes(rt.XODR)
    catalog = tmp_path / "catalog.json"
    catalog.write_bytes(rt.CATALOG)
    intent = run_local.build_intent(
        rt.XOSC, xodr, catalog, ("local-map", "local-catalog"), "Belmont_Office_Park_Belmont_CA", "authored",
        end_seconds=0.04, seed=1, rig="single-front", video=run_local.video_format(fps=25),
    )
    if allow:
        intent["allowSubstitutions"] = allow
    monkeypatch.setattr(local, "cooked_map_name_for_xodr", lambda sha: "Belmont_Office_Park_Belmont_CA" if cooked else None)
    inputs = {"scenario.xosc": scenario, "local-map": xodr, "local-catalog": catalog}
    intent_sha = hashlib.sha256(local._canonical_render_intent_json(intent).encode()).hexdigest()
    return intent, intent_sha, inputs


def test_an_uncooked_map_is_refused_before_carla_is_contacted(tmp_path, monkeypatch):
    intent, intent_sha, inputs = _local_intent(tmp_path, cooked=False, monkeypatch=monkeypatch)
    with pytest.raises(CarlaRenderError) as refused:
        local._intent_lease(intent, intent_sha, "b" * 64, inputs, tmp_path / "out")
    assert code_of(refused) == "carla_map_not_cooked"
    intent, intent_sha, inputs = _local_intent(tmp_path, cooked=True, monkeypatch=monkeypatch)
    lease, _paths = local._intent_lease(intent, intent_sha, "b" * 64, inputs, tmp_path / "out")
    assert lease.execution_package.xodr.map_name == "Belmont_Office_Park_Belmont_CA"


def test_a_render_without_a_timeline_needs_the_explicit_legacy_replay(tmp_path, monkeypatch):
    """Formerly an intent without render.timeline silently replayed the xosc."""
    intent, _sha, inputs = _local_intent(tmp_path, cooked=True, monkeypatch=monkeypatch)
    assert intent["motionSource"] == "original-xosc"
    implicit = {key: value for key, value in intent.items() if key != "motionSource"}
    implicit_sha = hashlib.sha256(local._canonical_render_intent_json(implicit).encode()).hexdigest()
    with pytest.raises(CarlaRenderError) as refused:
        local._intent_lease(implicit, implicit_sha, "b" * 64, inputs, tmp_path / "out")
    assert code_of(refused) == "carla_render_timeline_missing"
    bogus = {**intent, "motionSource": "whatever"}
    bogus_sha = hashlib.sha256(local._canonical_render_intent_json(bogus).encode()).hexdigest()
    with pytest.raises(ContractError):
        local._intent_lease(bogus, bogus_sha, "b" * 64, inputs, tmp_path / "out")


def _run_args(tmp_path, intent, control_features=""):
    intent_path = tmp_path / "intent.json"
    intent_path.write_text(json.dumps(intent))
    return SimpleNamespace(
        intent=str(intent_path), package=str(tmp_path / "package.json"), output=str(tmp_path / "out"),
        progress=str(tmp_path / "progress.jsonl"), manifest=str(tmp_path / "manifest.json"),
        host="127.0.0.1", port=2000, control_features=control_features,
    )


def _succeeding(substitutions):
    def execute(*_args, policy=None, progress=None, **_kwargs):
        for record in substitutions:
            progress("substitution", record)
        return {
            "status": "succeeded", "parity": {"accepted": True}, "artifacts": [],
            "substitutions": list(substitutions),
        }
    return execute


SUBSTITUTION = {
    "kind": "carla-actor-body", "subject": "ego", "requested": "vehicle.generated_van",
    "rendered": "vehicle.kia.carnival", "allowedBy": "allowSubstitutions",
}
SUBSTITUTION_WITH_DETAILS = {**SUBSTITUTION, "details": {"actorClass": "van", "lengthDeltaM": -0.25}}


def test_run_intent_records_substitutions_in_the_manifest_and_the_job_events(tmp_path, monkeypatch):
    intent, intent_sha, inputs = _local_intent(tmp_path, allow=["carla-actor-body"], monkeypatch=monkeypatch)
    monkeypatch.setattr(local, "_read_input_package", lambda _p, _i: (intent_sha, "b" * 64, inputs))
    monkeypatch.setattr(local, "_execute_local_lease", _succeeding([SUBSTITUTION_WITH_DETAILS]))
    args = _run_args(tmp_path, intent, "render-evidence.substitutions,native-evidence.parity")
    local._run_intent(args)
    manifest = json.loads(Path(args.manifest).read_text())
    # Exactly the RenderSubstitution fields the strict TS manifest schema takes.
    assert manifest["substitutions"] == [SUBSTITUTION]
    assert manifest["warnings"] == [{
        "code": "carla.substitution.carla-actor-body",
        "message": "ego: rendered vehicle.kia.carnival instead of vehicle.generated_van",
    }]
    progress = [json.loads(line) for line in Path(args.progress).read_text().splitlines()]
    assert any(record.get("code") == "carla.substitution.carla-actor-body" for record in progress)


def test_run_intent_refuses_substitutions_the_lease_cannot_record(tmp_path, monkeypatch):
    intent, intent_sha, inputs = _local_intent(tmp_path, allow=["carla-actor-body"], monkeypatch=monkeypatch)
    monkeypatch.setattr(local, "_read_input_package", lambda _p, _i: (intent_sha, "b" * 64, inputs))
    monkeypatch.setattr(local, "_execute_local_lease", _succeeding([SUBSTITUTION]))
    with pytest.raises(CarlaRenderError) as refused:
        local._run_intent(_run_args(tmp_path, intent))
    assert code_of(refused) == "carla_substitutions_unreportable"


def test_run_intent_omits_the_substitutions_field_for_a_baseline_lease(tmp_path, monkeypatch):
    intent, intent_sha, inputs = _local_intent(tmp_path, monkeypatch=monkeypatch)
    monkeypatch.setattr(local, "_read_input_package", lambda _p, _i: (intent_sha, "b" * 64, inputs))
    monkeypatch.setattr(local, "_execute_local_lease", _succeeding([]))
    args = _run_args(tmp_path, intent)
    local._run_intent(args)
    manifest = json.loads(Path(args.manifest).read_text())
    assert "substitutions" not in manifest and manifest["warnings"] == []


def test_run_intent_prints_the_machine_code_and_exits_distinctly_on_a_policy_refusal(tmp_path, monkeypatch):
    def refuse(_args):
        raise CarlaRenderError("carla_map_not_cooked", "map X has no cooked world")
    monkeypatch.setattr(local, "_run_intent", refuse)
    monkeypatch.setattr(sys, "argv", [
        "simforge-oss-carla-exec", "run-intent", "--intent", "i", "--package", "p", "--output", "o",
        "--progress", "g", "--manifest", "m", "--control-features", "render-evidence.substitutions",
    ])
    stdout = io.StringIO()
    with redirect_stdout(stdout), pytest.raises(SystemExit) as exited:
        local.main()
    assert exited.value.code == 3
    failure = json.loads(stdout.getvalue())
    assert failure == {
        "schema": "simforge.carla-render-failure/v1", "code": "carla_map_not_cooked",
        "message": "[carla_map_not_cooked] map X has no cooked world", "retryable": False,
    }


_UE5_RGB_ATTRIBUTES = frozenset({
    "enable_postprocess_effects", "fov", "image_size_x", "image_size_y", "lens_circle_falloff",
    "lens_circle_multiplier", "lens_k", "lens_kcube", "lens_x_size", "lens_y_size",
    "post_process_profile", "role_name", "ros_name", "sensor_tick", "use_ray_tracing",
})


def test_carla_010_cameras_use_the_named_ue5_native_profile(tmp_path):
    """CARLA 0.10's rgb camera has none of the UE4 grade attributes; the
    UE5 profile is named in the evidence instead of silently half-applying."""
    world = _SensorWorld()
    world.get_blueprint_library = lambda: SimpleNamespace(find=lambda blueprint_id: _Blueprint(blueprint_id, _UE5_RGB_ATTRIBUTES))
    backend = _sensor_backend(world, server_version="0.10.0")
    backend.configure_sensors(_rgb_spec(), tmp_path / "out", 10**9)
    grade = backend.camera_grade_evidence["primary:ego:hero:rgb"]
    assert grade["profile"] == "carla-0.10-ue5-native-v1" and grade["attributes"] == {}
    assert grade["serverVersion"] == "0.10.0" and grade["motionBlurIntensity"] is None
    yale = _sensor_backend(_SensorWorld(), server_version="0.10.0")
    yale.world.get_blueprint_library = world.get_blueprint_library
    yale.map_evidence = {"loadedMapName": "Yale_St_Palo_Alto_CA"}
    with pytest.raises(CarlaRenderError) as refused:
        yale.configure_sensors(_rgb_spec(), tmp_path / "out2", 10**9)
    assert code_of(refused) == "carla_sensor_attribute_unsupported"
    with pytest.raises(CarlaRenderError) as unknown:
        _sensor_backend(_SensorWorld(), server_version="0.11.0").configure_sensors(_rgb_spec(), tmp_path / "out3", 10**9)
    assert code_of(unknown) == "carla_engine_version_unsupported"
