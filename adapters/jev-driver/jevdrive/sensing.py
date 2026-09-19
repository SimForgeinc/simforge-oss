"""Per-actor ideal range/LOS sensor; no driver intent or latch is an input.

The wheel only exposes EnvSession's ego-only radial slab, not its generic
ObservationBuilder. This adapter gates native physical boxes geometrically,
then normalizes ONLY visible tracks with the existing SceneObservation helpers.
This is labelled exact simulated box sensing, not a learned detector.
"""
import json
import math
from . import policy as C
from .geometry import box_corners, polygons_overlap
from .scene import observation, track_record, rotate, wrap, set_visibility_coverage

class ActorSensor:
    def __init__(self, world, actor_id):
        self.actor_id = actor_id
        self.index = world.index[actor_id]
        self.spec = world.specs[actor_id]
        self.route = world.episode.graph.route(json.dumps(self.spec["behavior"]["route"]))
        lane_ids = set(self.route.lane_rsls)
        # Controls elsewhere on a map do not invalidate an unrelated corridor.
        # A control on this route still fails closed, not interpreted as green.
        for key in ("signalPrograms", "roadControls"):
            if any(s["rsl"] in lane_ids for p in world.data[key] for s in p.get("stopLines", [])):
                raise ValueError("route crosses unsupported signal/road-control adapter")
        lanes = [json.loads(world.episode.graph.lane_json(r)) for r in self.route.lane_rsls]
        if not lanes or any(not l.get("speedLimitKph") for l in lanes):
            raise ValueError("authoritative lane speed limits required")
        self.width = min(l["representativeWidthM"] for l in lanes)
        self.limit = min(l["speedLimitKph"] / 3.6 for l in lanes)
        self.static = [(o["obb"]["center"]["x"], -o["obb"]["center"]["z"],
                        o["obb"]["headingRad"], o["obb"]["lengthM"], o["obb"]["widthM"])
                       for o in world.data["occluders"]]
        self.first_seen = {}
        self.previous = None
        self.debug_counts = {}

    def observe(self, world):
        i = self.index
        _, ex, ey, yaw, speed = world.pose(self.actor_id)
        ego = world.rows[i]
        time_s = world.time_s
        objects = []
        omitted = 0
        blockers = self.static + [(float(r[0]), float(r[1]), float(r[2]), float(world.dims[j][0]), float(world.dims[j][1]))
                                 for j, r in enumerate(world.rows) if j != i and world.present[j]]
        # Physical ray gate can inspect potential occluders; rejected targets are
        # never converted into object records or passed to planner/model.
        for j, aid in enumerate(world.ids):
            if i == j or not world.present[j]:
                continue
            row = world.rows[j]
            dx, dy = float(row[0]) - ex, float(row[1]) - ey
            if math.hypot(dx, dy) > C.PERCEPTION_RANGE_M:
                continue
            target = (float(row[0]), float(row[1]))
            hidden = any((bx, by) != target and polygons_overlap([(ex, ey), target], box_corners(bx, by, bh, bl, bw))
                         for bx, by, bh, bl, bw in blockers)
            if hidden:
                omitted += 1
                continue
            self.first_seen.setdefault(aid, time_s)
            x, y = rotate(dx, dy, yaw)
            vx, vy = rotate(float(row[3]) * math.cos(float(row[2])) - speed * math.cos(yaw),
                            float(row[3]) * math.sin(float(row[2])) - speed * math.sin(yaw), yaw)
            obj = track_record(aid, world.kinds[j], x, y, vx, vy, wrap(float(row[2]) - yaw),
                               float(world.dims[j][0]), float(world.dims[j][1]),
                               "simforge-visible-box-sensor", time_s - self.first_seen[aid])
            objects.append(obj)
        visible_ids = {o["track_id"] for o in objects}
        self.first_seen = {k: v for k, v in self.first_seen.items() if k in visible_ids}
        arc = float(ego[7])
        start = max(0.0, arc - C.ROUTE_BACK_M)
        end = min(self.route.length_m, arc + C.ROUTE_FORWARD_M)
        count = math.ceil((end - start) / C.ROUTE_SAMPLE_M)
        centerline = [list(rotate(p[0] - ex, p[1] - ey, yaw))
                      for p in (self.route.pose_at(min(end, start + k * C.ROUTE_SAMPLE_M)) for k in range(count + 1))]
        route = {"centerline_m": centerline, "width_m": self.width, "speed_limit_mps": self.limit,
                 "required_stop_m": None, "source": "map:" + world.input.map_id, "complete": True}
        scene = observation(world.tick, time_s,
                            {"name": "native-per-actor-visible-boxes", "version": "1", "kind": "ground_truth"},
                            speed, float(ego[4]), world.dims[i][:2], route, objects)
        scene["schema_version"] = C.CURVED_SCHEMA_VERSION
        signed = None
        if self.previous is not None and time_s > self.previous[0]:
            signed = 0.0 if speed < C.STOPPED_MPS else math.copysign(speed, arc - self.previous[1])
        self.previous = (time_s, arc)
        scene["ego"].update(longitudinal_velocity_mps=signed,
                            longitudinal_velocity_source="native_magnitude_with_route_arc_delta_sign",
                            cruise_speed_mps=self.spec["behavior"]["cruiseSpeedMps"])
        scene["capabilities"]["supplied"] += ["ego.longitudinal_velocity_mps", "objects.class", "objects.length_m", "objects.width_m", "objects.rel_vx_mps", "objects.rel_vy_mps"]
        local_static = [(*rotate(x - ex, y - ey, yaw), l, w, wrap(h - yaw)) for x, y, h, l, w in self.static]
        set_visibility_coverage(scene, local_static)
        self.debug_counts = {"visible_objects": len(scene["objects"]), "omitted_occluded_objects": omitted}
        C.validate_capabilities(scene["capabilities"])
        return scene
