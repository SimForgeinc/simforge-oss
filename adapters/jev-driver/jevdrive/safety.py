"""Finite maneuver lattice and conservative modeled-envelope filter.
Not a safety certificate: unknown map/coverage/uncertainty fails closed, and
emergency braking cannot make an already-unavoidable collision avoidable.
"""
from __future__ import annotations

from dataclasses import dataclass
import math
import numpy as np
from . import policy as C
from .geometry import RoutePolyline, angle_delta, footprint_in_corridor, swept_footprint_hits


@dataclass(frozen=True)
class Candidate:
    id: str
    accel_mps2: float
    points: np.ndarray
    min_clearance_m: float

    def summary(self):
        result = {"id": self.id, "end_speed_mps": round(float(self.points[-1, 3]), 1),
                  "horizon_s": round(float(self.points[-1, 4]), 2),
                  "min_clearance_m": round(float(self.min_clearance_m), 1)}
        if self.id in C.CREEP_DISTANCES_M:
            advance = math.hypot(float(self.points[-1, 0]), float(self.points[-1, 1]))
            result.update(profile="advance_then_stop",
                          advance_m=round(round(advance / C.CREEP_DISTANCE_RESOLUTION_M) * C.CREEP_DISTANCE_RESOLUTION_M, 6),
                          duration_s=C.CREEP_DURATION_S)
        else:
            result["accel_mps2"] = self.accel_mps2
        return result


def motion(speed, accel, time_s, limit=math.inf):
    """Exact distance/speed for a bounded constant-acceleration segment."""
    if abs(accel) <= C.NUMERIC_EPS:
        return speed * time_s, speed
    bound = limit if accel > 0 else 0.0
    change_s = max(0.0, (bound - speed) / accel)
    t = min(time_s, change_s)
    v = max(0.0, min(limit, speed + accel * t))
    return speed * t + accel * t * t / 2 + v * (time_s - t), v

def straight_corridor(scene):
    points = scene["route"]["centerline_m"]
    return (all(abs(p[1]) <= C.NUMERIC_EPS for p in points)
            and all(b[0] > a[0] for a, b in zip(points, points[1:])))


def admission(scene):
    if scene["schema_version"] not in (C.SCHEMA_VERSION, C.CURVED_SCHEMA_VERSION) or scene["frame"] != "ego-flu":
        return "unsupported_schema_or_frame"
    if scene["schema_version"] == C.CURVED_SCHEMA_VERSION:
        signed = scene["ego"].get("longitudinal_velocity_mps")
        if signed is None:
            return "unobserved_motion_direction"
        if signed < -C.STOPPED_MPS:
            return "reverse_motion_unqualified"
    coverage, route = scene["coverage"], scene["route"]
    if not coverage["complete"] or coverage["omitted_objects"]:
        return "unbounded_or_truncated_coverage"
    if coverage["unknown_regions_m"] is None or coverage["untracked_occupied_regions_m"] is None:
        return "unsupported_visibility_or_occupancy"
    if coverage["measurement_age_s"] > C.MAX_MEASUREMENT_AGE_S:
        return "stale_coverage"
    if not route["complete"] or route["speed_limit_mps"] is None or route["width_m"] < C.MIN_CORRIDOR_WIDTH_M:
        return "unknown_route_rules"
    points = route["centerline_m"]
    if len(points) < 2:
        return "route_support_exhausted"
    geometry = RoutePolyline(points)
    if geometry.arc[-1] - geometry.origin < C.MIN_ROUTE_LENGTH_M:
        return "route_support_exhausted"
    if geometry.offset > C.MAX_TRACKING_LATERAL_ERROR_M:
        return "outside_route_corridor"
    if scene["ego"]["width_m"] / 2 + C.TRACKING_MARGIN_M > route["width_m"] / 2:
        return "footprint_outside_corridor"
    for obj in scene["objects"]:
        if len(obj["track_id"]) > C.MAX_TRACK_ID_CHARS or obj["measurement_age_s"] > C.MAX_MEASUREMENT_AGE_S:
            return "stale_or_invalid_track"
        for name in ("position_cov_m2", "velocity_cov_m2ps2"):
            cov = obj[name]
            if cov is None:
                continue  # bounded ODD priors below, never fabricated covariance
            if len(cov) != 3 or not all(math.isfinite(x) for x in cov):
                return "invalid_covariance"
            if cov[0] < 0 or cov[2] < 0 or cov[0] * cov[2] + C.NUMERIC_EPS < cov[1] ** 2:
                return "invalid_covariance"
    return None


def projected_extents(obj):
    length = obj.get("length_m") if obj.get("length_m") is not None else C.UNKNOWN_LENGTH_M
    width = obj.get("width_m") if obj.get("width_m") is not None else C.UNKNOWN_WIDTH_M
    if obj.get("heading_rad") is None:
        radius = math.hypot(length, width) / 2
        return radius, radius
    c, s = abs(math.cos(obj["heading_rad"])), abs(math.sin(obj["heading_rad"]))
    return (c * length + s * width) / 2, (s * length + c * width) / 2

def uncertainty_bounds(obj, time_s):
    pos, vel = obj["position_cov_m2"], obj["velocity_cov_m2ps2"]
    ux = C.UNKNOWN_POSITION_BOUND_M if pos is None else C.UNCERTAINTY_SIGMAS * math.sqrt(pos[0])
    uy = C.UNKNOWN_POSITION_BOUND_M if pos is None else C.UNCERTAINTY_SIGMAS * math.sqrt(pos[2])
    bearing, radial = obj["bearing_rad"], obj["range_rate_mps"]
    vx = obj.get("rel_vx_mps")
    vy = obj.get("rel_vy_mps")
    if radial is None:
        return 0.0, 0.0, ux + time_s * C.INITIAL_RANGE_RATE_BOUND_MPS, uy + time_s * C.INITIAL_RANGE_RATE_BOUND_MPS
    if vx is None or vy is None:
        vx, vy = radial * math.cos(bearing), radial * math.sin(bearing)
        ux += time_s * (C.UNKNOWN_RADIAL_SPEED_ERROR_MPS * abs(math.cos(bearing)) + C.UNKNOWN_TANGENTIAL_SPEED_MPS * abs(math.sin(bearing)))
        uy += time_s * (C.UNKNOWN_RADIAL_SPEED_ERROR_MPS * abs(math.sin(bearing)) + C.UNKNOWN_TANGENTIAL_SPEED_MPS * abs(math.cos(bearing)))
    elif vel is None:
        ux += time_s * C.UNKNOWN_TANGENTIAL_SPEED_MPS
        uy += time_s * C.UNKNOWN_TANGENTIAL_SPEED_MPS
    else:
        ux += time_s * C.UNCERTAINTY_SIGMAS * math.sqrt(vel[0])
        uy += time_s * C.UNCERTAINTY_SIGMAS * math.sqrt(vel[2])
    return vx, vy, ux, uy


def check_points(scene, points, profile=C.CONSERVATIVE):
    """Swept AABB tubes between samples + stopping reserve at the horizon.

    Longitudinal traffic may brake immediately or accelerate within bounds;
    lateral motion is constant velocity with covariance-expanded intervals.
    Bounding boxes are projected to enclosing axis-aligned rectangles. No
    existence-score threshold can silently discard a possible obstacle.
    """
    ego = scene["ego"]
    half_l, half_w = ego["length_m"] / 2, ego["width_m"] / 2
    margin = profile.position_margin_m + profile.tracking_margin_m + C.QUANTUM_M
    min_clearance = C.PERCEPTION_RANGE_M
    prior_x, prior_t = 0.0, 0.0
    prior_y, prior_heading, prior_speed = 0.0, 0.0, ego["speed_mps"]
    route_geometry = None if straight_corridor(scene) else RoutePolyline(scene["route"]["centerline_m"])
    for x, y, heading, speed, t in points:
        if speed < -C.NUMERIC_EPS or speed > scene["route"]["speed_limit_mps"] + C.NUMERIC_EPS:
            return False, "speed_limit", 0.0
        if route_geometry is None:
            if abs(y) + half_w + C.TRACKING_MARGIN_M > scene["route"]["width_m"] / 2:
                return False, "corridor", 0.0
            if x + half_l + margin > scene["route"]["centerline_m"][-1][0]:
                return False, "route_extent", 0.0
        else:
            if not footprint_in_corridor((x, y, heading), ego, route_geometry, scene["route"]["width_m"]):
                return False, "swept_footprint_corridor", 0.0
            if max(speed, prior_speed) * abs(angle_delta(heading, prior_heading)) / (t - prior_t) > C.MAX_LATERAL_ACCEL_MPS2:
                return False, "lateral_acceleration_limit", 0.0
        for obstacle in scene["coverage"].get("occupied_obbs_m_rad", []):
            if swept_footprint_hits((prior_x, prior_y, prior_heading), (x, y, heading), ego, obstacle):
                return False, "swept_footprint_static_obb", 0.0
        c, s = abs(math.cos(heading)), abs(math.sin(heading))
        pc, ps = abs(math.cos(prior_heading)), abs(math.sin(prior_heading))
        extent_x = max(c * half_l + s * half_w, pc * half_l + ps * half_w)
        extent_y = max(s * half_l + c * half_w, ps * half_l + pc * half_w)
        ego_ylo, ego_yhi = min(prior_y, y) - extent_y, max(prior_y, y) + extent_y
        stop = scene["route"]["required_stop_m"]
        if stop is not None and x + half_l + speed * speed / (2 * profile.guaranteed_brake_mps2) + profile.stop_buffer_m >= stop:
            return False, "stop_constraint", 0.0
        regions = [(r, True) for r in scene["coverage"]["unknown_regions_m"]]
        regions += [(r, False) for r in scene["coverage"]["untracked_occupied_regions_m"]]
        for region, shadow in regions:
            rx, ry, length, width = region
            expansion = C.SHADOW_ACTOR_RADIUS_M + margin
            if shadow:
                expansion += profile.shadow_max_speed_mps * (t + profile.shadow_reaction_s)
            lo, hi = rx - length / 2 - expansion, rx + length / 2 + expansion
            if ry - width / 2 - expansion > ego_yhi or ry + width / 2 + expansion < ego_ylo:
                continue
            clearance = max(lo - (max(prior_x, x) + extent_x), min(prior_x, x) - extent_x - hi)
            min_clearance = min(min_clearance, clearance)
            if clearance <= 0:
                return False, "occlusion_reachability" if shadow else "untracked_occupancy", clearance
        for obj in scene["objects"]:
            ol, ow = projected_extents(obj)
            rvx, vy, ux, uy = uncertainty_bounds(obj, t)
            ylo = min(obj["y_m"] + vy * prior_t, obj["y_m"] + vy * t) - ow - uy - margin
            yhi = max(obj["y_m"] + vy * prior_t, obj["y_m"] + vy * t) + ow + uy + margin
            if ylo > ego_yhi or yhi < ego_ylo:
                continue
            ov = rvx + ego["speed_mps"]
            if ov >= 0:
                lo = obj["x_m"] + motion(ov, -C.OTHER_MAX_BRAKE_MPS2, prior_t)[0] - ol - ux - margin
                hi = obj["x_m"] + motion(ov, C.OTHER_MAX_ACCEL_MPS2, t)[0] + ol + ux + margin
            else:
                lo = obj["x_m"] + ov * t - C.OTHER_MAX_ACCEL_MPS2 * t * t / 2 - ol - ux - margin
                hi = obj["x_m"] + ov * prior_t + ol + ux + margin
            elo = min(prior_x, x) - extent_x - profile.tracking_speed_error_mps * t
            ehi = max(prior_x, x) + extent_x + profile.tracking_speed_error_mps * t
            clearance = max(lo - ehi, elo - hi)
            min_clearance = min(min_clearance, clearance)
            if clearance <= 0:
                return False, "swept_collision_tube:" + obj["track_id"], clearance
            if obj["x_m"] > 0:
                obstacle_stop = obj["x_m"] + max(0, ov) ** 2 / (2 * C.OTHER_MAX_BRAKE_MPS2) - ol - margin - ux
                ego_stop = x + half_l + (speed + profile.tracking_speed_error_mps) ** 2 / (2 * profile.guaranteed_brake_mps2)
                if ego_stop + profile.stop_buffer_m >= obstacle_stop:
                    return False, "terminal_stopping_reserve:" + obj["track_id"], clearance
        prior_x, prior_t = x, t
        prior_y, prior_heading, prior_speed = y, heading, speed
    return True, None, min_clearance


def creep_motion(distance, t):
    u = min(1.0, t / C.CREEP_DURATION_S)
    x = distance * (10 * u**3 - 15 * u**4 + 6 * u**5)
    speed = distance / C.CREEP_DURATION_S * (30 * u**2 - 60 * u**3 + 30 * u**4)
    return x, speed


def remaining_creep(scene, latch, pose):
    age = scene["state_time_s"] - latch["time_s"]
    ax, ay, ah = latch["pose"][1:4]
    ca, sa, cc, sc = math.cos(ah), math.sin(ah), math.cos(pose[3]), math.sin(pose[3])
    rows = []
    for x, y, h, speed, t in latch["points"]:
        if t <= age + C.NUMERIC_EPS:
            continue
        dx, dy = ax + ca * x - sa * y - pose[1], ay + sa * x + ca * y - pose[2]
        rows.append([cc * dx + sc * dy, -sc * dx + cc * dy, angle_delta(ah + h, pose[3]), speed, t - age])
    if not rows:
        return None
    if rows[-1][4] < C.PLAN_HORIZON_S - C.NUMERIC_EPS:
        rows.append([*rows[-1][:3], 0.0, C.PLAN_HORIZON_S])
    return np.array(rows, dtype=np.float64)

def generate(scene, latch=None, pose=None, *, profile=C.CONSERVATIVE, candidate_family=C.LEGACY_MANEUVER_IDS):
    names = candidate_family
    reason = admission(scene)
    if reason:
        return {}, {name: reason for name in names}
    speed = scene["ego"]["speed_mps"]
    limit = max(0.0, min(scene["route"]["speed_limit_mps"] - profile.tracking_speed_error_mps,
                         scene["ego"].get("cruise_speed_mps", math.inf)))
    accepted, rejected = {}, {}
    route_geometry = None if straight_corridor(scene) else RoutePolyline(scene["route"]["centerline_m"])
    for name in names:
        spec = C.MANEUVERS[name]
        if name in C.CREEP_DISTANCES_M:
            if latch is not None and latch["id"] == name and pose is not None:
                points = remaining_creep(scene, latch, pose)
                if points is None:
                    rejected[name] = "completed_creep"
                    continue
            elif speed > C.NUMERIC_EPS:
                rejected[name] = "creep_requires_standstill"
                continue
            else:
                distance = C.CREEP_DISTANCES_M[name]
                peak_accel = (10 * math.sqrt(3) / 3) * distance / C.CREEP_DURATION_S**2
                if peak_accel > min(profile.max_accel_mps2, C.MAX_BRAKE_MPS2):
                    rejected[name] = "acceleration_limit"
                    continue
                rows = []
                for k in range(1, round(profile.horizon_s / C.PLAN_SAMPLE_S) + 1):
                    t = k * C.PLAN_SAMPLE_S
                    x, v = creep_motion(distance, t)
                    px, py, heading = (x, 0.0, 0.0) if route_geometry is None else route_geometry.sample(x)
                    rows.append((px, py, heading, v, t))
                points = np.array(rows, dtype=np.float64)
            ok, reason, clearance = check_points(scene, points, profile)
            if ok:
                accepted[name] = Candidate(name, 0.0, points, clearance)
            else:
                rejected[name] = reason
            continue
        accel = spec["accel_mps2"]
        if accel > profile.max_accel_mps2 or accel < -C.MAX_BRAKE_MPS2:
            rejected[name] = "acceleration_limit"
            continue
        if accel > 0 and speed >= limit:
            rejected[name] = "speed_headroom"
            continue
        rows = []
        for k in range(1, round(profile.horizon_s / C.PLAN_SAMPLE_S) + 1):
            t = k * C.PLAN_SAMPLE_S
            x, v = motion(speed, accel, t, max(limit, speed))
            px, py, heading = (x, 0.0, 0.0) if route_geometry is None else route_geometry.sample(x)
            rows.append((px, py, heading, v, t))
        points = np.array(rows, dtype=np.float64)
        ok, reason, clearance = check_points(scene, points, profile)
        if ok:
            accepted[name] = Candidate(name, accel, points, clearance)
        else:
            rejected[name] = reason
    return accepted, rejected


def conservative_baseline(scene, feasible):
    if not feasible:
        return "emergency_brake"
    ego = scene["ego"]
    gap = C.PERCEPTION_RANGE_M
    for obj in scene["objects"]:
        ol, ow = projected_extents(obj)
        if obj["x_m"] > 0 and abs(obj["y_m"]) < ow + ego["width_m"] / 2 + C.POSITION_MARGIN_M:
            gap = min(gap, obj["x_m"] - ol - ego["length_m"] / 2)
    if gap >= C.BASELINE_STOP_GAP_M + ego["speed_mps"] * C.BASELINE_HEADWAY_S and "hold" in feasible:
        return "hold"
    for name in ("yield", "stop", "hold", "progress", "late_brake", "surge", *C.CREEP_DISTANCES_M):
        if name in feasible:
            return name
    raise AssertionError("nonempty feasible set has no known maneuver")

def minimum_risk_stop(scene):
    """Unchecked emergency action, NOT a candidate advertised as collision-safe.
    Uses the native speed-tracking executor; holding raw brake=1 in rc61 drives
    backward after reaching zero speed, so raw brake passthrough is forbidden.
    """
    route = None if straight_corridor(scene) else RoutePolyline(scene["route"]["centerline_m"])
    rows = []
    signed = scene["ego"].get("longitudinal_velocity_mps")
    direction = -1.0 if signed is not None and signed < 0 else 1.0
    for k in range(1, round(C.PLAN_HORIZON_S / C.PLAN_SAMPLE_S) + 1):
        t = k * C.PLAN_SAMPLE_S
        distance, v = motion(scene["ego"]["speed_mps"], -C.MAX_BRAKE_MPS2, t)
        distance, v = direction * distance, direction * v
        x, y, heading = (distance, 0.0, 0.0) if route is None else route.sample(distance)
        rows.append((x, y, heading, v, t))
    return np.array(rows, dtype=np.float64)


def monitor(scene, latch, feasible, pose, profile=C.CONSERVATIVE):
    if not feasible:
        holding_stop = latch is not None and latch["id"] == "emergency_brake"
        return "emergency_brake", None if holding_stop else "no_feasible_candidate"
    if latch is None:
        return conservative_baseline(scene, feasible), "initial_conservative_latch"
    if latch["id"] not in feasible:
        return conservative_baseline(scene, feasible), "latched_maneuver_no_longer_feasible"
    age = scene["state_time_s"] - latch["time_s"]
    if latch["id"] in C.CREEP_DISTANCES_M:
        expected_v = float(np.interp(age, latch["points"][:, 4], latch["points"][:, 3]))
    else:
        expected_v = motion(latch["speed_mps"], C.MANEUVERS[latch["id"]]["accel_mps2"], age,
                            max(latch["speed_mps"], min(scene["route"]["speed_limit_mps"] - profile.tracking_speed_error_mps,
                                                        scene["ego"].get("cruise_speed_mps", math.inf))))[1]
    if abs(scene["ego"]["speed_mps"] - expected_v) > profile.tracking_speed_error_mps:
        return conservative_baseline(scene, feasible), "tracking_speed_error"
    if straight_corridor(scene):
        lateral_error = abs(pose[2] - latch["pose"][2])
    else:
        dx, dy = pose[1] - latch["pose"][1], pose[2] - latch["pose"][2]
        c, s = math.cos(latch["pose"][3]), math.sin(latch["pose"][3])
        local_x, local_y = c * dx + s * dy, -s * dx + c * dy
        held_geometry = RoutePolyline([[0.0, 0.0]] + latch["points"][:, :2].tolist())
        lateral_error = held_geometry.project(local_x, local_y)[1]
    if lateral_error > C.MAX_TRACKING_LATERAL_ERROR_M:
        return conservative_baseline(scene, feasible), "tracking_lateral_error"
    return latch["id"], None
