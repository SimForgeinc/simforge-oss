"""Grounding, kinematic replay and fail-closed pose gates for CARLA renders.

Regression suite for two shipped defects measured on CARLA 0.10.0:

* props never simulate physics and ignore set_transform after spawn, so a prop
  spawned with the vehicle lift floated by exactly that lift for the whole clip
  (dev render d9d7: a dumpster 0.748 m above the road);
* WalkerControl moves a walker at ~5% of the commanded speed, so authored
  pedestrians stood still (dev render 6d3b: 20.8 m behind its plan).
"""
from __future__ import annotations

import pytest

from simforge_oss_carla_exec.runtime.backend import CarlaBackend
from simforge_oss_carla_exec.runtime.compiler import ActorBinding, ActorFrame, PlanFrame
from simforge_oss_carla_exec.runtime.parity import ParityAccumulator
from simforge_oss_carla_exec.runtime.pose_gates import (
    PROP,
    VEHICLE,
    WALKER,
    PoseGate,
    PoseGateError,
    gate_mode,
    motion_class,
    select_ground_z,
)


# -- pure gate logic ----------------------------------------------------------

def test_motion_class_follows_how_carla_moves_the_body():
    assert motion_class("vehicle.nissan.patrol") == VEHICLE
    assert motion_class("walker.pedestrian.0015") == WALKER
    assert motion_class("static.prop.dumpster") == PROP


def test_select_ground_ignores_non_ground_and_out_of_window_hits():
    hits = [("NONE", 3.62), ("Vegetation", 3.0), ("Sidewalks", 2.15), ("Roads", 2.0), ("Roads", -9.0)]
    assert select_ground_z(hits, 2.0) == pytest.approx(2.15)
    assert select_ground_z([("NONE", 3.6), ("TrafficSigns", 2.5)], 2.0) is None


def _walk(gate: PoseGate, actor_id: str, seconds: float, planned_speed: float, actual_speed: float) -> None:
    steps = int(round(seconds / gate.fixed_timestep_s))
    for index in range(steps):
        t = index * gate.fixed_timestep_s
        gate.observe_motion(index, {actor_id: (planned_speed * t, 0.0)}, {actor_id: (actual_speed * t, 0.0)})


def test_motion_gate_fails_a_pedestrian_that_does_not_follow_its_plan():
    gate = PoseGate(0.02)
    gate.register("ped", WALKER)
    # The measured CARLA 0.10 WalkerControl response: 1.4 m/s -> 0.068 m/s.
    with pytest.raises(PoseGateError, match="actor-not-moving"):
        _walk(gate, "ped", 3.0, 1.4, 0.068)


def test_motion_gate_passes_a_following_actor_and_a_parked_one():
    gate = PoseGate(0.02)
    gate.register("ped", WALKER)
    gate.register("parked", VEHICLE)
    for index in range(200):
        t = index * 0.02
        gate.observe_motion(index, {"ped": (1.4 * t, 0.0), "parked": (5.0, 5.0)}, {"ped": (1.4 * t, 0.0), "parked": (5.0, 5.0)})
    assert gate.report()["verdict"] == "pass"
    assert gate.windows_evaluated == 4


def test_motion_gate_exempts_a_native_vehicle_after_its_own_contact():
    gate = PoseGate(0.02)
    gate.register("car", VEHICLE)
    gate.exempt_motion("car")
    _walk(gate, "car", 3.0, 8.0, 0.0)
    assert gate.violations == []


def test_report_mode_records_without_failing(monkeypatch):
    monkeypatch.setenv("SIMFORGE_CARLA_POSE_GATES", "report")
    gate = PoseGate(0.02, mode=gate_mode())
    gate.register("ped", WALKER)
    _walk(gate, "ped", 3.0, 1.4, 0.0)
    assert gate.report()["verdict"] == "fail"
    assert {item["code"] for item in gate.violations} == {"actor-not-moving"}
    monkeypatch.setenv("SIMFORGE_CARLA_POSE_GATES", "off")
    with pytest.raises(RuntimeError, match="enforce or report"):
        gate_mode()


def test_placement_gate_fails_a_floating_prop_and_tolerates_vehicle_suspension():
    gate = PoseGate(0.02)
    gate.check_placement("car", VEHICLE, intended=(0, 0), actual=(0.01, 0), bottom_z=2.02, ground_z=2.0, ground_source="ground-raycast")
    with pytest.raises(PoseGateError, match="placement-airborne"):
        gate.check_placement("dumpster", PROP, intended=(0, 0), actual=(0, 0), bottom_z=6.675, ground_z=5.9, ground_source="ground-raycast")
    with pytest.raises(PoseGateError, match="placement-displaced"):
        gate.check_placement("ped", WALKER, intended=(0, 0), actual=(1.0, 0), bottom_z=2.0, ground_z=2.0, ground_source="ground-raycast")


def test_vehicle_ground_gate_needs_sustained_airborne_or_buried_motion():
    gate = PoseGate(0.02)
    # A brief bump is not a failure; one second airborne is.
    for frame in range(0, 40, 10):
        gate.observe_vehicle_ground("car", frame, 0.8, 0.2, post_contact=False)
    gate.observe_vehicle_ground("car", 40, 0.0, 0.2, post_contact=False)
    assert gate.violations == []
    with pytest.raises(PoseGateError, match="vehicle-airborne"):
        for frame in range(0, 60, 10):
            gate.observe_vehicle_ground("car", frame, 0.8, 0.2, post_contact=False)
    # Falling through the world fails even after a contact.
    with pytest.raises(PoseGateError, match="vehicle-below-ground"):
        gate.observe_vehicle_ground("lost", 10, -144.0, 0.2, post_contact=True)


def test_kinematic_readback_gate_catches_an_actor_that_ignored_its_pose():
    gate = PoseGate(0.02)
    gate.observe_kinematic_readback("cone", 0, commanded_z=2.0, actual_z=2.0, planar_error_m=0.0)
    with pytest.raises(PoseGateError, match="kinematic-readback-diverged"):
        gate.observe_kinematic_readback("cone", 1, commanded_z=2.0, actual_z=2.765, planar_error_m=0.0)


# -- backend behaviour against CARLA-shaped fakes -------------------------------

class _Vec:
    def __init__(self, x=0.0, y=0.0, z=0.0):
        self.x, self.y, self.z = x, y, z


class _Rot:
    # carla.Rotation takes pitch, yaw and roll (the spectator is pitched down).
    def __init__(self, pitch=0.0, yaw=0.0, roll=0.0):
        self.pitch, self.yaw, self.roll = pitch, yaw, roll


class _Transform:
    def __init__(self, location, rotation):
        self.location, self.rotation = location, rotation


class _WalkerControl:
    def __init__(self, direction=None, speed=0.0, jump=False):
        self.direction, self.speed, self.jump = direction, speed, jump


class _VehicleControl:
    def __init__(self, throttle=0.0, brake=0.0, steer=0.0):
        self.throttle, self.brake, self.steer = throttle, brake, steer


class _Carla:
    VehicleControl = _VehicleControl
    Location = _Vec
    Vector3D = _Vec
    Rotation = _Rot
    Transform = _Transform
    WalkerControl = _WalkerControl


class _Box:
    def __init__(self, center_z, extent_z):
        self.location, self.extent = _Vec(z=center_z), _Vec(z=extent_z)


#: Measured on CARLA 0.10.0: prop pivots at the mesh base, walker at its capsule centre.
_BOXES = {"static.prop.dumpster": _Box(0.62, 0.62), "walker.pedestrian.0015": _Box(-0.028, 0.903),
          "vehicle.nissan.patrol": _Box(0.95, 0.95)}


class _Actor:
    """Behaves like the CARLA 0.10 body of its type_id."""

    def __init__(self, type_id, transform, actor_id):
        self.type_id, self.id = type_id, actor_id
        self.bounding_box = _BOXES[type_id]
        self._transform = transform
        self.physics = True
        self.controls, self.velocities = [], []

    def get_transform(self):
        return self._transform

    def set_transform(self, value):
        if self.type_id.startswith("static."):
            return  # CARLA 0.10 props ignore post-spawn transforms entirely.
        self._transform = value

    def set_simulate_physics(self, value):
        self.physics = value

    def set_target_velocity(self, value):
        self.velocities.append(value)

    def set_target_angular_velocity(self, value):
        pass

    def get_velocity(self):
        return _Vec()

    def get_angular_velocity(self):
        return _Vec()

    def apply_control(self, control):
        self.controls.append(control)

    def destroy(self):
        return True


class _World:
    def __init__(self, ground=2.15):
        self.ground, self.spawns, self.ticks, self.next_id = ground, [], 0, 1
        self.bodies = []

    def get_blueprint_library(self):
        return type("Library", (), {"find": lambda _self, blueprint_id: blueprint_id})()

    def try_spawn_actor(self, blueprint_id, transform):
        self.spawns.append((blueprint_id, transform.location.z))
        actor = _Actor(blueprint_id, transform, self.next_id)
        self.next_id += 1
        self.bodies.append(actor)
        return actor

    def cast_ray(self, start, end):
        hits = [("NONE", self.ground + 1.6), ("Sidewalks", self.ground), ("Roads", self.ground - 0.15)]
        return [type("Hit", (), {"label": label, "location": _Vec(z=z)})() for label, z in hits if end.z <= z <= start.z]

    def tick(self):
        # Gravity: a physics-driven vehicle comes to rest on the road.
        for body in self.bodies:
            if body.physics and body.type_id.startswith("vehicle."):
                location = body.get_transform().location
                body._transform = _Transform(_Vec(location.x, location.y, self.ground), body.get_transform().rotation)
        self.ticks += 1
        return self.ticks

    def get_spectator(self):
        # The streaming anchor follows a body every tick; a failure to move
        # the spectator now fails the render instead of being swallowed.
        return type("Spectator", (), {"set_transform": lambda _self, _transform: None})()


def _backend(world):
    backend = object.__new__(CarlaBackend)
    backend.carla = _Carla
    backend.world = world
    backend.actors = {}
    backend.fixed_timestep_s = 0.02
    backend.execution_mode = "native-physics"
    backend.signals = {}
    backend.speed_integrals = {}
    return backend


_CATALOG = {
    "dumpster": {"blueprintId": "static.prop.dumpster", "actorClass": "static_object", "dims": {"l": 2.0, "w": 1.2, "h": 1.25}},
    "ped": {"blueprintId": "walker.pedestrian.0015", "actorClass": "pedestrian", "dims": {"l": 0.5, "w": 0.5, "h": 1.8}},
    "suv": {"blueprintId": "vehicle.nissan.patrol", "actorClass": "car", "dims": {"l": 5.2, "w": 2.0, "h": 1.9}},
}


def _spawn_scene(world, *, walker_speed=1.4):
    backend = _backend(world)
    actors = {
        "dumpster": ActorBinding("dumpster", "actor_dumpster", "static_object", "dumpster", static=True),
        "ped": ActorBinding("ped", "actor_ped", "pedestrian", "ped"),
        "suv": ActorBinding("suv", "actor_suv", "car", "suv", static=True),
    }
    frame = PlanFrame(0, 0.0, {
        "dumpster": ActorFrame("spawn", 10.0, 0.0, 2.0, 0.0, 0.0),
        "ped": ActorFrame("spawn", 0.0, 5.0, 2.0, 0.0, walker_speed),
        "suv": ActorFrame("spawn", 30.0, 0.0, 2.0, 0.0, 0.0),
    }, {})
    backend.spawn(actors, frame, _CATALOG)
    return backend, frame


def test_prop_is_spawned_on_the_ground_because_carla_cannot_move_it_later():
    world = _World(ground=2.15)
    backend, _ = _spawn_scene(world)
    dumpster_spawn_z = next(z for blueprint, z in world.spawns if blueprint == "static.prop.dumpster")
    # Previously ground + h/2 + 0.15 = +0.775 m: the floating dumpster of d9d7.
    assert dumpster_spawn_z == pytest.approx(2.15)
    prop = backend.actors["dumpster"]
    assert prop.physics is False
    placement = backend.spawn_placement_report()["actors"]["dumpster"]
    assert placement["motion"] == "kinematic-replay"
    assert placement["spawnLiftM"] == 0.0
    assert placement["groundSource"] == "ground-raycast"


def test_walker_is_grounded_by_its_measured_pivot_and_held_kinematically():
    world = _World(ground=2.15)
    backend, _ = _spawn_scene(world)
    walker = backend.actors["ped"]
    assert walker.physics is False
    # Bounding-box bottom exactly on the sidewalk top, not the lane centre.
    bottom = walker.get_transform().location.z + (-0.028 - 0.903)
    assert bottom == pytest.approx(2.15)
    assert backend.kinematic_actor_ids == {"dumpster", "ped"}
    assert backend.spawn_placement_report()["actors"]["suv"]["motion"] == "native-physics"


def test_apply_replays_the_walker_pose_and_drives_its_animation_speed():
    world = _World(ground=2.15)
    backend, _ = _spawn_scene(world)
    walker = backend.actors["ped"]
    backend.apply(PlanFrame(1, 0.02, {
        "dumpster": ActorFrame("active", 10.0, 0.0, 2.0, 0.0, 0.0),
        "ped": ActorFrame("active", 0.028, 5.0, 2.0, 0.0, 1.4),
        "suv": ActorFrame("active", 30.0, 0.0, 2.0, 0.0, 0.0),
    }, {}))
    pose = walker.get_transform()
    assert (pose.location.x, pose.location.y) == (pytest.approx(0.028), pytest.approx(-5.0))
    assert pose.location.z == pytest.approx(2.15 + 0.931)
    assert walker.controls[-1].speed == pytest.approx(1.4)
    assert walker.velocities[-1].x == pytest.approx(1.4)
    assert backend.last_controls["ped"]["motion"] == "kinematic-replay"


def test_prepare_never_writes_a_stale_spawn_readback_back_onto_a_grounded_body():
    class StaleWorld(_World):
        """The client snapshot still reports the lifted spawn pose."""
        def try_spawn_actor(self, blueprint_id, transform):
            actor = super().try_spawn_actor(blueprint_id, transform)
            lifted = transform
            actor.get_transform = lambda: lifted
            return actor
    world = StaleWorld(ground=2.15)
    backend, frame = _spawn_scene(world)
    walker = backend.actors["ped"]
    writes = []
    walker.set_transform = writes.append
    backend.prepare_scenario(frame)
    assert writes and all(item.location.z == pytest.approx(2.15 + 0.931) for item in writes)


def test_validate_placement_fails_loudly_on_a_floating_actor():
    world = _World(ground=2.15)
    backend, frame = _spawn_scene(world)
    backend.prepare_scenario(frame)
    assert backend.validate_placement()["verdict"] == "pass"
    # The same scene with a body hanging 0.775 m up fails before t=0.
    backend.actors["dumpster"]._transform = _Transform(_Vec(10.0, 0.0, 2.15 + 0.775), _Rot())
    with pytest.raises(PoseGateError, match="placement-airborne.*dumpster"):
        backend.validate_placement()


def test_tick_fails_when_a_kinematic_actor_does_not_follow_its_commanded_pose():
    world = _World(ground=2.15)
    backend, frame = _spawn_scene(world)
    backend.prepare_scenario(frame)
    walker = backend.actors["ped"]
    walker.set_transform = lambda _value: None   # the body stopped following
    moved = PlanFrame(1, 0.02, {
        "dumpster": ActorFrame("active", 10.0, 0.0, 2.0, 0.0, 0.0),
        "ped": ActorFrame("active", 0.5, 5.0, 2.0, 0.0, 1.4),
        "suv": ActorFrame("active", 30.0, 0.0, 2.0, 0.0, 0.0),
    }, {})
    backend.apply(moved)
    backend.sensor_condition = __import__("threading").Condition()
    backend.sensor_error = None
    backend.sensor_pending = {}
    with pytest.raises(PoseGateError, match="kinematic-readback-diverged.*ped"):
        backend.tick(None)


def test_tick_reports_ground_contact_elevation_used_by_parity():
    world = _World(ground=2.15)
    backend, frame = _spawn_scene(world)
    backend.prepare_scenario(frame)
    backend.apply(frame)
    backend.sensor_condition = __import__("threading").Condition()
    backend.sensor_error = None
    backend.sensor_pending = {}
    readback = backend.tick(None)
    assert readback["ped"]["contactZ"] == pytest.approx(2.15)
    assert readback["ped"]["z"] == pytest.approx(2.15 + 0.931)
    accumulator = ParityAccumulator({})
    accumulator.observe(PlanFrame(0, 0.0, {"ped": ActorFrame("spawn", 0.0, 5.0, 2.15, 0.0, 1.4)}, {}),
                        {"ped": {**readback["ped"], "speedMps": 1.4}})
    assert accumulator.report().max_error["positionM"] == pytest.approx(0.0, abs=1e-9)


def test_pose_smoke_scenario_compiles_every_actor_class():
    from simforge_oss_carla_exec.pose_smoke import SMOKE_CATALOG, smoke_scenario
    from simforge_oss_carla_exec.runtime.compiler import compile_xosc14

    class LaneType:
        Driving, Sidewalk = "Driving", "Sidewalk"

    class Waypoint:
        def __init__(self, lane_type, y, x=0.0):
            self.lane_type, self.is_junction = lane_type, False
            self.transform = _Transform(_Vec(x, y, 2.0), _Rot(0.0))
        def next_until_lane_end(self, step):
            return [Waypoint(LaneType.Driving, 0.0, step * index) for index in range(1, 30)]
        def get_right_lane(self):
            return Waypoint(LaneType.Sidewalk, 4.0) if self.lane_type == LaneType.Driving else None
        def get_left_lane(self):
            return None

    class Map:
        def generate_waypoints(self, _distance):
            return [Waypoint(LaneType.Driving, 0.0)]

    carla = type("Carla", (), {"LaneType": LaneType})
    plan = compile_xosc14(smoke_scenario(carla, Map(), "Smoke_Map"))
    assert set(plan.actors) == {"car_moving", "car_parked", "ped_walking", "ped_standing", "cone", "busstop", "bench"}
    assert {binding.catalog_name for binding in plan.actors.values()} <= set(SMOKE_CATALOG)
    moving = {actor_id for actor_id, binding in plan.actors.items() if not binding.static}
    assert moving == {"car_moving", "ped_walking"}
    assert plan.frames[-1].actors["ped_walking"].x == pytest.approx(1.4 * 6.0)
