"""Portable planar roadway observations. No renderer, images or model internals.
Provider coordinates: x forward, y left at observation issuance. Relative
velocities subtract ego velocity but not the rotating-frame derivative.
Unknown covariance is null, never a fabricated zero. This module has no actuation.
"""
from __future__ import annotations

import math
from . import policy as C






def quantize(value, quantum):
    return round(round(float(value) / quantum) * quantum, 6)


def rotate(x, y, yaw):
    c, s = math.cos(yaw), math.sin(yaw)
    return c * x + s * y, -s * x + c * y


def wrap(angle):
    return (angle + math.pi) % (2 * math.pi) - math.pi


def track_record(track_id, kind, x, y, vx, vy, yaw, length, width, source, track_age_s):
    return {
        "track_id": str(track_id), "class": kind,
        "x_m": quantize(x, C.QUANTUM_M), "y_m": quantize(y, C.QUANTUM_M),
        "rel_vx_mps": quantize(vx, C.QUANTUM_MPS), "rel_vy_mps": quantize(vy, C.QUANTUM_MPS),
        "range_m": quantize(math.hypot(x, y), C.QUANTUM_M),
        "bearing_rad": quantize(math.atan2(y, x), C.QUANTUM_RAD),
        "range_rate_mps": quantize((x * vx + y * vy) / max(C.NUMERIC_EPS, math.hypot(x, y)), C.QUANTUM_MPS),
        "heading_rad": quantize(yaw, C.QUANTUM_RAD),
        "length_m": quantize(length, C.QUANTUM_M), "width_m": quantize(width, C.QUANTUM_M),
        "existence_probability": 1.0, "position_cov_m2": [0.0, 0.0, 0.0],
        "velocity_cov_m2ps2": [0.0, 0.0, 0.0], "detection_score": None,
        "class_probabilities": None, "track_status": "confirmed",
        "source": source, "measurement_age_s": 0.0,
        "uncertainty_source": "exact_simulator_state",
        "track_age_s": quantize(track_age_s, C.QUANTUM_TIME_S),
    }


def observation(seq, time_s, provider, speed, accel, dims, route, objects):
    objects.sort(key=lambda obj: (math.hypot(obj["x_m"], obj["y_m"]), obj["track_id"]))
    in_range = [obj for obj in objects if math.hypot(obj["x_m"], obj["y_m"]) <= C.PERCEPTION_RANGE_M]
    omitted = max(0, len(in_range) - C.MAX_OBJECTS)
    for obj in in_range:
        obj["state_time_s"] = quantize(time_s, C.QUANTUM_TIME_S)
        obj["last_observed_time_s"] = quantize(time_s - obj["measurement_age_s"], C.QUANTUM_TIME_S)
    return {
        "schema_version": C.SCHEMA_VERSION, "seq": seq,
        "state_time_s": quantize(time_s, C.QUANTUM_TIME_S),
        "last_observed_time_s": quantize(time_s, C.QUANTUM_TIME_S), "frame": "ego-flu",
        "provider": provider,
        "capabilities": {"profile": "planar-tracked-objects", "supplied": [
            "ego.speed_mps", "objects.x_m", "objects.y_m", "objects.range_rate_mps",
            "route.speed_limit_mps", "coverage.unknown_regions_m", "candidates"],
                         "unsupported": []},
        "uncertainty_layout": {"frame": "ego-flu", "position_order": ["xx", "xy", "yy"],
                               "velocity_order": ["vxvx", "vxvy", "vyvy"], "packing": "upper_triangle",
                               "position_units": "m^2", "velocity_units": "m^2/s^2",
                               "conditioning": "given existence; cross position-velocity covariance omitted"},
        "calibration": {"status": "calibrated", "method": "exact_simulator_state",
                        "model_version": provider["version"], "calibration_domain": "simulated-measurement",
                        "calibration_dataset": None, "calibration_version": "exact-no-statistical-fit"},
        "ego": {"speed_mps": quantize(speed, C.QUANTUM_MPS),
                "accel_mps2": quantize(accel, C.QUANTUM_ACCEL_MPS2),
                "length_m": quantize(dims[0], C.QUANTUM_M), "width_m": quantize(dims[1], C.QUANTUM_M)},
        "route": route,
        "coverage": {"radius_m": C.PERCEPTION_RANGE_M, "complete": omitted == 0,
                     "omitted_objects": omitted, "measurement_age_s": 0.0,
                     "unknown_regions_m": [], "untracked_occupied_regions_m": [],
                     "observed_free_regions_m": None, "frame": "ego-flu", "vertical_bounds_m": None,
                     "state_time_s": quantize(time_s, C.QUANTUM_TIME_S),
                     "source": "map-and-visible-blockers", "geometry": "rectangles:[center_x,center_y,length,width]"},
        "objects": in_range[:C.MAX_OBJECTS],
    }




def visibility_shadows(blockers):
    """Conservative rectangular shadow superset in the admitted forward corridor.
    Inputs are visible blocker bounds or static map geometry, NEVER hidden actors.
    Unknown blocker extents use the declared ODD upper bound.
    """
    regions = []
    for x, y, length, width in blockers:
        near = x - length / 2
        if near <= C.NUMERIC_EPS or near >= C.PERCEPTION_RANGE_M:
            continue
        scale = C.PERCEPTION_RANGE_M / near
        low = min(y - width / 2, (y - width / 2) * scale)
        high = max(y + width / 2, (y + width / 2) * scale)
        start = max(0.0, x - length / 2)
        regions.append([quantize((start + C.PERCEPTION_RANGE_M) / 2, C.QUANTUM_M),
                        quantize((low + high) / 2, C.QUANTUM_M),
                        quantize(C.PERCEPTION_RANGE_M - start, C.QUANTUM_M),
                        quantize(high - low, C.QUANTUM_M)])
    return regions

def set_visibility_coverage(scene, static_obbs):
    """Derive bounded unknown space only from visible boxes and map blockers."""
    blockers = [(o["x_m"], o["y_m"], o["length_m"], o["width_m"], o["heading_rad"])
                for o in scene["objects"]]
    blockers.extend(static_obbs)
    projected = []
    for x, y, length, width, heading in blockers:
        c, s = abs(math.cos(heading)), abs(math.sin(heading))
        projected.append((x, y, c*length+s*width, s*length+c*width))
    regions = visibility_shadows(projected)
    scene["coverage"]["occupied_obbs_m_rad"] = [list(o) for o in static_obbs[:C.MAX_UNKNOWN_REGIONS]]
    scene["coverage"]["unknown_regions_m"] = regions[:C.MAX_UNKNOWN_REGIONS]
    if len(regions) > C.MAX_UNKNOWN_REGIONS or len(static_obbs) > C.MAX_UNKNOWN_REGIONS:
        scene["coverage"]["complete"] = False




