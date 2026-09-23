"""`pose-smoke`: prove a CARLA runtime places and moves every actor class correctly.

Builds a small trajectory-replay scenario on the loaded cooked map (a moving
and a parked vehicle, a walking and a standing pedestrian, and three props of
different heights on the road and the sidewalk), then runs it through the
production backend in the default trace-replay mode -- spawn with physics off,
the per-tick batched pose application, and the blocking replay parity gate
against the sampler. ``--mode native-physics`` runs the physics-validation
path instead (native settle, placement validation, pose gates). It also probes
CARLA's attitude sign conventions, which the replay pose mapping relies on. No
sensors are attached, so it also runs against a render-less (``-nullrhi``)
simulator.

It fails (exit 1) when any actor ends above or below the ground surface, is
displaced from its authored pose, does not follow its authored motion, or is
a walking pedestrian whose legs do not move (frozen or T-posed gait). It is
the qualification check for the two defects this module exists to catch:
floating props and pedestrians that stand still while their plan walks away.
"""
from __future__ import annotations

import math
from typing import Any, Mapping

from .runtime.backend import CarlaBackend
from .runtime.compiler import compile_xosc14
from .runtime.contract import EXECUTION_MODE_TRACE_REPLAY, normalize_execution_mode
from .runtime.policy import CarlaRenderError, WalkerAnimationMonitor
from .runtime.pose_gates import GROUND_LABELS, PoseGateError
from .runtime.replay import CARLA_PITCH_SIGN, CARLA_ROLL_SIGN, ReplayParityGate, expected_replay_poses
from .runtime.timeline import PlanTimeline

SMOKE_DURATION_S = 6.0
SMOKE_VERTEX_STEP_S = 0.1
#: Final checks, independent of the in-loop gates (defence in depth).
MAX_GROUND_GAP_M = {"vehicle": 0.30, "walker": 0.05, "prop": 0.05}
#: Under trace replay the timeline z is authoritative and the cooked-mesh gap
#: is the map's own XODR-vs-cook delta (kerb heights are absent from XODR
#: elevation v1), so only a gross gap -- a broken height source -- fails.
MAX_REPLAY_GROUND_GAP_M = 0.25
MIN_TRAVEL_FRACTION = 0.9

SMOKE_CATALOG: Mapping[str, Mapping[str, Any]] = {
    "smoke.car": {"blueprintId": "vehicle.ue4.chevrolet.impala", "actorClass": "car", "dims": {"l": 5.36, "w": 2.03, "h": 1.41}},
    "smoke.walker.a": {"blueprintId": "walker.pedestrian.0015", "actorClass": "pedestrian", "dims": {"l": 0.5, "w": 0.5, "h": 1.8}},
    "smoke.walker.b": {"blueprintId": "walker.pedestrian.0016", "actorClass": "pedestrian", "dims": {"l": 0.5, "w": 0.5, "h": 1.8}},
    "smoke.cone": {"blueprintId": "static.prop.trafficcone01", "actorClass": "static_object", "dims": {"l": 0.6, "w": 0.6, "h": 1.23}},
    "smoke.busstop": {"blueprintId": "static.prop.busstop", "actorClass": "static_object", "dims": {"l": 1.894, "w": 3.876, "h": 2.739}},
    "smoke.bench": {"blueprintId": "static.prop.bench01", "actorClass": "static_object", "dims": {"l": 1.793, "w": 0.638, "h": 1.004}},
}


def _anchor(carla: Any, runtime_map: Any) -> tuple[Any, Any]:
    """A straight driving lane with a sidewalk beside it."""
    for waypoint in runtime_map.generate_waypoints(6.0):
        if waypoint.lane_type != carla.LaneType.Driving or waypoint.is_junction:
            continue
        ahead = waypoint.next_until_lane_end(2.0)
        if len(ahead) < 20:
            continue
        start_yaw = waypoint.transform.rotation.yaw
        if any(abs(((item.transform.rotation.yaw - start_yaw + 180) % 360) - 180) > 3.0 for item in ahead[:20]):
            continue
        for step in ("get_right_lane", "get_left_lane"):
            lane = waypoint
            for _ in range(4):
                lane = getattr(lane, step)() if lane is not None else None
                if lane is not None and lane.lane_type == carla.LaneType.Sidewalk:
                    return waypoint, lane
    raise RuntimeError("pose-smoke found no straight driving lane with a sidewalk on this map")


def smoke_scenario(carla: Any, runtime_map: Any, map_name: str) -> bytes:
    road, sidewalk = _anchor(carla, runtime_map)
    heading = math.radians(-road.transform.rotation.yaw)
    fx, fy = math.cos(heading), math.sin(heading)

    def osc(location: Any) -> tuple[float, float, float]:
        return float(location.x), -float(location.y), float(location.z)

    rx, ry, rz = osc(road.transform.location)
    sx, sy, sz = osc(sidewalk.transform.location)
    actors = [
        ("car_moving", "car", "Vehicle", "smoke.car", rx, ry, rz, 5.0),
        ("car_parked", "car", "Vehicle", "smoke.car", rx - fx * 12, ry - fy * 12, rz, None),
        ("ped_walking", "pedestrian", "Pedestrian", "smoke.walker.a", sx, sy, sz, 1.4),
        ("ped_standing", "pedestrian", "Pedestrian", "smoke.walker.b", sx + fx * 12, sy + fy * 12, sz, None),
        ("cone", "static_object", "MiscObject", "smoke.cone", sx + fx * 16, sy + fy * 16, sz, None),
        # Behind the moving car: a 3.9 m wide shelter overhangs a narrow sidewalk.
        ("busstop", "static_object", "MiscObject", "smoke.busstop", sx - fx * 24, sy - fy * 24, sz, None),
        ("bench", "static_object", "MiscObject", "smoke.bench", sx + fx * 6, sy + fy * 6, sz, None),
    ]

    lane_any = getattr(getattr(carla, "LaneType", None), "Any", None)

    def surface_z(x: float, y: float, z: float) -> float:
        """The OpenDRIVE lane elevation under (x, y), as a baked timeline has
        it. The anchor's z is not valid 24 m away on a sloped street."""
        if not hasattr(carla, "Location") or not hasattr(runtime_map, "get_waypoint"):
            return z
        location = carla.Location(x=x, y=-y, z=z)
        waypoint = runtime_map.get_waypoint(location, project_to_road=False, lane_type=lane_any) if lane_any is not None else None
        if waypoint is None:
            waypoint = runtime_map.get_waypoint(location, project_to_road=True)
        return float(waypoint.transform.location.z) if waypoint is not None else z

    def pose(x: float, y: float, z: float) -> str:
        z = surface_z(x, y, z)
        return f'<WorldPosition x="{x:.4f}" y="{y:.4f}" z="{z:.4f}" h="{heading:.6f}" p="0" r="0"/>'

    entities, inits = [], []
    for actor_id, kind, element, catalog, x, y, z, speed in actors:
        extra = {
            "Pedestrian": ' mass="80" pedestrianCategory="pedestrian"',
            "MiscObject": ' mass="1" miscObjectCategory="obstacle"',
            "Vehicle": ' vehicleCategory="car"',
        }[element]
        body = '<BoundingBox><Center x="0" y="0" z="0"/><Dimensions width="1" length="1" height="1"/></BoundingBox>'
        if element == "Vehicle":
            body += (
                '<Performance maxSpeed="50" maxAcceleration="5" maxDeceleration="8"/><Axles>'
                '<FrontAxle maxSteering="0.5" wheelDiameter="0.6" trackWidth="1.6" positionX="2.8" positionZ="0.3"/>'
                '<RearAxle maxSteering="0" wheelDiameter="0.6" trackWidth="1.6" positionX="0" positionZ="0.3"/></Axles>'
            )
        entities.append(
            f'<ScenarioObject name="actor_{actor_id}"><{element} name="{catalog}"{extra}>{body}<Properties>'
            f'<Property name="simforge.actorId" value="{actor_id}"/><Property name="simforge.actorKind" value="{kind}"/>'
            f'<Property name="simforge.tag" value="catalog:{catalog}"/></Properties></{element}></ScenarioObject>'
        )
        actions = f"<PrivateAction><TeleportAction><Position>{pose(x, y, z)}</Position></TeleportAction></PrivateAction>"
        if speed is not None:
            vertices = "".join(
                f'<Vertex time="{index * SMOKE_VERTEX_STEP_S:.3f}"><Position>'
                f"{pose(x + fx * speed * index * SMOKE_VERTEX_STEP_S, y + fy * speed * index * SMOKE_VERTEX_STEP_S, z)}"
                f'</Position><Motion speed_longitudinal="{speed}"/></Vertex>'
                for index in range(int(round(SMOKE_DURATION_S / SMOKE_VERTEX_STEP_S)) + 1)
            )
            actions += (
                "<PrivateAction><RoutingAction><FollowTrajectoryAction><TimeReference>"
                '<Timing domainAbsoluteRelative="absolute" scale="1" offset="0"/></TimeReference>'
                '<TrajectoryFollowingMode followingMode="position"/><TrajectoryRef>'
                f'<Trajectory name="trajectory_{actor_id}" closed="false"><Shape><Polyline>{vertices}'
                "</Polyline></Shape></Trajectory></TrajectoryRef></FollowTrajectoryAction></RoutingAction></PrivateAction>"
            )
        inits.append(f'<Private entityRef="actor_{actor_id}">{actions}</Private>')
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n<OpenSCENARIO>'
        '<FileHeader revMajor="1" revMinor="4" date="2026-09-22T00:00:00" description="pose-smoke" author="simforge">'
        '<Properties><Property name="simforge.executionMode" value="trajectory-replay"/></Properties></FileHeader>'
        f'<ParameterDeclarations/><CatalogLocations/><RoadNetwork><LogicFile filepath="{map_name}.xodr"/></RoadNetwork>'
        f"<Entities>{''.join(entities)}</Entities>"
        f"<Storyboard><Init><Actions>{''.join(inits)}</Actions></Init><StopTrigger/></Storyboard></OpenSCENARIO>"
    ).encode("utf-8")


def _ground_gap(backend: CarlaBackend, actor: Any) -> float | None:
    carla = backend.carla
    transform = actor.get_transform()
    box = actor.bounding_box
    bottom = float(transform.location.z) + float(box.location.z) - float(box.extent.z)
    hits = backend.world.cast_ray(
        carla.Location(x=transform.location.x, y=transform.location.y, z=bottom + 1.5),
        carla.Location(x=transform.location.x, y=transform.location.y, z=bottom - 4.0),
    )
    ground = [float(hit.location.z) for hit in hits if str(hit.label) in GROUND_LABELS]
    return None if not ground else bottom - max(ground)


def attitude_probe(backend: CarlaBackend, anchor: Any) -> dict[str, object]:
    """Verify the CARLA rotation sign conventions replay depends on.

    An OSC pitch of +10 deg (nose down) and roll of +10 deg (right side down)
    are mapped through ``CARLA_PITCH_SIGN``/``CARLA_ROLL_SIGN`` and applied to
    a kinematic vehicle; the forward/right vectors CARLA reports must agree.
    """
    carla, world = backend.carla, backend.world
    blueprint = world.get_blueprint_library().find(SMOKE_CATALOG["smoke.car"]["blueprintId"])
    location = anchor.transform.location
    actor = world.try_spawn_actor(blueprint, carla.Transform(
        carla.Location(x=location.x, y=location.y, z=location.z + 30.0), anchor.transform.rotation,
    ))
    if actor is None:
        return {"verdict": "fail", "reason": "attitude probe vehicle could not spawn"}
    try:
        actor.set_simulate_physics(False)
        yaw = anchor.transform.rotation.yaw
        actor.set_transform(carla.Transform(actor.get_transform().location, carla.Rotation(pitch=CARLA_PITCH_SIGN * 10.0, yaw=yaw, roll=0.0)))
        world.tick()
        forward_z = float(world.get_snapshot().find(actor.id).get_transform().get_forward_vector().z)
        actor.set_transform(carla.Transform(actor.get_transform().location, carla.Rotation(pitch=0.0, yaw=yaw, roll=CARLA_ROLL_SIGN * 10.0)))
        world.tick()
        right_z = float(world.get_snapshot().find(actor.id).get_transform().get_right_vector().z)
    finally:
        actor.destroy()
    nose_down, right_down = forward_z < -0.1, right_z < -0.1
    return {
        "verdict": "pass" if nose_down and right_down else "fail",
        "oscPitchPlus10": {"forwardZ": forward_z, "noseDown": nose_down},
        "oscRollPlus10": {"rightZ": right_z, "rightSideDown": right_down},
    }


def run_pose_smoke(
    host: str, port: int, map_name: str | None = None, mode: str = EXECUTION_MODE_TRACE_REPLAY,
) -> dict[str, object]:
    mode = normalize_execution_mode(mode, "pose-smoke mode")
    backend = CarlaBackend(host, port)
    result: dict[str, object] = {"schema": "simforge.carla-pose-smoke/v1", "mode": mode, "verdict": "fail"}
    failures: list[str] = []
    replay = mode == EXECUTION_MODE_TRACE_REPLAY
    try:
        world = backend.client.get_world()
        loaded = str(world.get_map().name).rsplit("/", 1)[-1]
        target = map_name or loaded
        if target != loaded:
            world = backend.client.load_world(target)
        runtime_map = world.get_map()
        xosc = smoke_scenario(backend.carla, runtime_map, target)
        plan = compile_xosc14(xosc)
        backend.configure_execution(mode)
        backend.load_opendrive(target, str(runtime_map.to_opendrive()).encode("utf-8"), plan.fixed_timestep_s)
        if replay:
            result["attitude"] = attitude_probe(backend, _anchor(backend.carla, backend.world.get_map())[0])
            if result["attitude"]["verdict"] != "pass":
                failures.append(f"CARLA attitude conventions differ from the replay mapping: {result['attitude']}")
        backend.spawn(plan.actors, plan.frames[0], SMOKE_CATALOG)
        # The walking pedestrian's legs must move (renders fail otherwise);
        # sampled here too, although no sensor is attached.
        backend.walker_animation = WalkerAnimationMonitor()
        backend.prepare_scenario(plan.frames[0])
        backend.validate_placement()
        sampler = PlanTimeline(plan)
        gate = ReplayParityGate()
        travelled = {actor_id: [0.0, 0.0] for actor_id in plan.actors}
        previous: dict[str, tuple[float, float, float, float]] = {}
        max_gap: dict[str, float] = {}
        for index in range(sampler.tick_count()):
            frame = sampler.frame_at_tick(index)
            backend.apply(frame)
            readback = backend.tick(None)
            if replay:
                gate.observe(
                    frame,
                    expected_replay_poses(frame, backend.actor_classes, backend.bottom_offsets, backend.z_offset_m),
                    {
                        actor_id: _observed(value)
                        for actor_id, value in readback.items() if value.get("present")
                    },
                )
            else:
                backend.collision_readback(frame.index, frame.t)
            for actor_id, value in readback.items():
                if not value.get("present"):
                    continue
                state = frame.actors[actor_id]
                if actor_id in previous:
                    px, py, ax, ay = previous[actor_id]
                    travelled[actor_id][0] += math.hypot(state.x - px, state.y - py)
                    travelled[actor_id][1] += math.hypot(float(value["x"]) - ax, float(value["y"]) - ay)
                previous[actor_id] = (state.x, state.y, float(value["x"]), float(value["y"]))
                if frame.index % 25 == 0:
                    gap = _ground_gap(backend, backend.actors[actor_id])
                    if gap is not None and abs(gap) > abs(max_gap.get(actor_id, 0.0)):
                        max_gap[actor_id] = gap
        actors: dict[str, dict[str, object]] = {}
        for actor_id in plan.actors:
            klass = backend.actor_classes.get(actor_id, "vehicle")
            planned, actual = travelled[actor_id]
            gap = max_gap.get(actor_id, 0.0)
            actors[actor_id] = {"class": klass, "plannedTravelM": planned, "actualTravelM": actual, "maxGroundGapM": gap}
            if abs(gap) > (MAX_REPLAY_GROUND_GAP_M if replay else MAX_GROUND_GAP_M[klass]):
                failures.append(f"{actor_id} ({klass}) is {gap:+.3f} m from the ground")
            if planned > 1.0 and actual < MIN_TRAVEL_FRACTION * planned:
                failures.append(f"{actor_id} ({klass}) travelled {actual:.2f} m of a planned {planned:.2f} m")
        result.update({"map": target, "actors": actors})
        if replay:
            parity = gate.report()
            result["replayParity"] = {key: value for key, value in parity.items() if key != "violations"}
            result["replayParity"]["firstViolations"] = parity["violations"][:4]
            if parity["verdict"] != "pass":
                failures.append(
                    f"replay parity failed: max {parity['maxPositionErrorM']:.4f} m / "
                    f"{parity['maxRotationErrorDeg']:.3f} deg over {parity['samples']} samples"
                )
            result["replay"] = backend.replay_evidence()
        else:
            result["poseGates"] = backend.pose_gate.report()
        result["walkerAnimation"] = backend.walker_animation.report()
        backend.walker_animation.finish()
    except (PoseGateError, CarlaRenderError) as exc:
        failures.append(str(exc))
    finally:
        backend.cleanup()
    result["failures"] = failures
    result["verdict"] = "pass" if not failures else "fail"
    return result


def _observed(value: Mapping[str, Any]) -> Any:
    from .runtime.replay import RenderPose
    return RenderPose(
        float(value["x"]), float(value["y"]), float(value["z"]),
        float(value["headingDeg"]), float(value.get("pitchDeg", 0.0)), float(value.get("rollDeg", 0.0)),
    )
