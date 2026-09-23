"""KITScenes-v3-style BEV rasterisation from SimForge lane geometry.

The native bench supplies world-frame lane graph and route points.  This module
projects those real OpenDRIVE-derived geometries into the fixed AutoE2E raster:
256x256 at 1 m/px, ego anchor row 170 / column 127.5, x forward and y left.
No all-free or blank fallback is marked valid.  Missing semantic categories
remain zero and are reported in ``RasterDiagnostics`` so a run cannot imply
that unavailable crosswalk/signal data was observed.
"""

from __future__ import annotations

from dataclasses import dataclass, asdict
import math
from typing import Any, Iterable, Mapping, Sequence

import numpy as np

H = W = 256
MPP = 1.0
X_MAX, X_MIN = 170.5, -85.5
Y_MAX, Y_MIN = 128.0, -128.0
EGO_ROW, EGO_COL = 170.0, 127.5
MAP_CHANNELS = 14
ROUTE_CHANNELS = 2
CH = {
    "drivable": 0,
    "lane_boundary": 1,
    "centerline": 2,
    "intersection": 3,
    "crosswalk": 4,
    "stop_line": 5,
    "traffic_signal": 6,
    "dir_sin": 7,
    "dir_cos": 8,
    "dir_valid": 9,
    "known": 10,
    "road_level": 11,
    "road_level_valid": 12,
    "overlap": 13,
}
ROUTE_CORRIDOR = 0
ROUTE_DESTINATION = 1


@dataclass(frozen=True)
class RasterDiagnostics:
    map_valid: bool
    route_valid: bool
    lane_count: int
    visible_lane_count: int
    drivable_pixels: int
    centerline_pixels: int
    intersection_pixels: int
    crosswalks_filled: int
    stop_lines_filled: int
    signals_filled: int
    unavailable_channels: tuple[str, ...]
    geometry: str = "kitscenes-v3-bev-1m-v1"

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def blank_map() -> np.ndarray:
    return np.zeros((MAP_CHANNELS, H, W), dtype=np.float32)


def blank_route() -> np.ndarray:
    return np.zeros((ROUTE_CHANNELS, H, W), dtype=np.float32)


def _pose_tuple(pose: Mapping[str, Any] | Sequence[float]) -> tuple[float, float, float]:
    if isinstance(pose, Mapping):
        return float(pose.get("x", 0.0)), float(pose.get("y", 0.0)), float(pose.get("yawRad", pose.get("yaw", 0.0)))
    return float(pose[0]), float(pose[1]), float(pose[2])


def world_to_ego(points: Sequence[Sequence[float]], pose: Mapping[str, Any] | Sequence[float]) -> np.ndarray:
    """Convert world ``[x,y]`` points to ego ``[forward,left]`` metres."""

    x0, y0, yaw = _pose_tuple(pose)
    pts = np.asarray(points, dtype=np.float64).reshape(-1, 2)
    dx, dy = pts[:, 0] - x0, pts[:, 1] - y0
    c, s = math.cos(yaw), math.sin(yaw)
    return np.column_stack((dx * c + dy * s, -dx * s + dy * c))


def to_pixels(xy: np.ndarray) -> np.ndarray:
    """Ego ``[forward,left]`` metres to floating raster ``[row,col]``."""

    xy = np.asarray(xy, dtype=np.float64).reshape(-1, 2)
    return np.stack([EGO_ROW - xy[:, 0] / MPP, EGO_COL - xy[:, 1] / MPP], axis=1)


def _draw_polyline(canvas: np.ndarray, points: np.ndarray, value: float = 1.0, width_m: float = 1.0) -> None:
    if len(points) < 1:
        return
    pixels = to_pixels(points)
    width = max(1, int(round(width_m / MPP)))
    radius = max(0, width // 2)
    segments = zip(pixels[:-1], pixels[1:]) if len(pixels) > 1 else ((pixels[0], pixels[0]),)
    for start, end in segments:
        dist = float(np.linalg.norm(end - start))
        n = max(2, int(dist * 2.0) + 1)
        samples = start + (end - start) * np.linspace(0.0, 1.0, n)[:, None]
        rr = np.rint(samples[:, 0]).astype(np.int64)
        cc = np.rint(samples[:, 1]).astype(np.int64)
        for dr in range(-radius, radius + 1):
            for dc in range(-radius, radius + 1):
                if dr * dr + dc * dc > radius * radius:
                    continue
                r, c = rr + dr, cc + dc
                valid = (r >= 0) & (r < H) & (c >= 0) & (c < W)
                canvas[r[valid], c[valid]] = value


def _offset_polyline(points: np.ndarray, offset_m: float) -> np.ndarray:
    if len(points) < 2:
        return points.copy()
    out = points.copy()
    for i in range(len(points)):
        if i == 0:
            tangent = points[1] - points[0]
        elif i == len(points) - 1:
            tangent = points[-1] - points[-2]
        else:
            tangent = points[i + 1] - points[i - 1]
        norm = float(np.linalg.norm(tangent))
        if norm < 1e-6:
            continue
        normal = np.array([-tangent[1], tangent[0]]) / norm
        out[i] += normal * offset_m
    return out


def _lane_points(lane: Mapping[str, Any]) -> np.ndarray:
    raw = lane.get("polyline", lane.get("points", []))
    values: list[list[float]] = []
    for point in raw or []:
        if isinstance(point, Mapping):
            values.append([float(point.get("x", 0.0)), float(point.get("y", point.get("z", 0.0)))])
        elif len(point) >= 2:
            values.append([float(point[0]), float(point[1])])
    return np.asarray(values, dtype=np.float64).reshape(-1, 2)


def _within_window(points: np.ndarray) -> bool:
    if len(points) == 0:
        return False
    return bool(
        np.any((points[:, 0] >= X_MIN - 10) & (points[:, 0] <= X_MAX + 10) & (points[:, 1] >= Y_MIN - 10) & (points[:, 1] <= Y_MAX + 10))
    )


def _semantic_points(items: Iterable[Any]) -> list[np.ndarray]:
    result: list[np.ndarray] = []
    for item in items:
        raw = item.get("points", item.get("polyline", item)) if isinstance(item, Mapping) else item
        arr = np.asarray(raw, dtype=np.float64).reshape(-1, 2) if raw is not None else np.empty((0, 2))
        if len(arr):
            result.append(arr)
    return result


def _direction_at(points: np.ndarray, index: int) -> tuple[float, float]:
    if len(points) < 2:
        return 0.0, 1.0
    i = min(max(index, 0), len(points) - 2)
    tangent = points[i + 1] - points[i]
    n = float(np.linalg.norm(tangent))
    if n < 1e-6:
        return 0.0, 1.0
    return float(tangent[1] / n), float(tangent[0] / n)


def rasterize(
    graph: Mapping[str, Any] | None,
    ego_pose: Mapping[str, Any] | Sequence[float],
    route_points: Sequence[Sequence[float]] | None,
    *,
    corridor_width_m: float = 6.0,
    destination_radius_m: float = 4.0,
) -> tuple[np.ndarray, np.ndarray, RasterDiagnostics]:
    """Rasterise native graph/route geometry and return ``(map, route, diag)``."""

    map_raster = blank_map()
    route_raster = blank_route()
    graph = graph or {}
    lanes = list(graph.get("lanes", []))
    visible = 0
    intersections = 0
    for lane in lanes:
        world = _lane_points(lane)
        if len(world) < 2:
            continue
        ego = world_to_ego(world, ego_pose)
        if not _within_window(ego):
            continue
        visible += 1
        width = float(lane.get("widthM", lane.get("representativeWidthM", 3.5)) or 3.5)
        width = min(max(width, 1.0), 12.0)
        drivable = str(lane.get("laneType", "driving")).lower() in {"driving", "bidirectional", "parking", "shoulder"}
        if drivable:
            _draw_polyline(map_raster[CH["drivable"]], ego, 1.0, width)
        _draw_polyline(map_raster[CH["centerline"]], ego, 1.0, 0.35)
        _draw_polyline(map_raster[CH["lane_boundary"]], _offset_polyline(ego, width * 0.5), 1.0, 0.2)
        _draw_polyline(map_raster[CH["lane_boundary"]], _offset_polyline(ego, -width * 0.5), 1.0, 0.2)
        if bool(lane.get("isJunction", False)) or lane.get("junctionId") not in (None, ""):
            intersections += 1
            _draw_polyline(map_raster[CH["intersection"]], ego, 1.0, width)
        # Direction fields are real lane tangents, not a synthetic route guess.
        pixels = to_pixels(ego)
        for i, (row, col) in enumerate(np.rint(pixels).astype(np.int64)):
            if not (0 <= row < H and 0 <= col < W):
                continue
            sin_dir, cos_dir = _direction_at(ego, i)
            map_raster[CH["dir_sin"], row, col] = sin_dir * 0.5 + 0.5
            map_raster[CH["dir_cos"], row, col] = cos_dir * 0.5 + 0.5
            map_raster[CH["dir_valid"], row, col] = 1.0
    map_raster[CH["known"]] = np.maximum(map_raster[CH["known"]], map_raster[CH["drivable"]])
    map_raster[CH["known"]] = np.maximum(map_raster[CH["known"]], map_raster[CH["centerline"]])
    map_raster[CH["road_level_valid"]] = map_raster[CH["known"]]
    # Road level 0 is the only level represented by the lane graph.  Encoding
    # it as zero while marking validity avoids inventing elevation values.
    map_raster[CH["road_level"]] = 0.0

    crosswalks = _semantic_points(graph.get("crosswalks", []))
    for item in crosswalks:
        _draw_polyline(map_raster[CH["crosswalk"]], world_to_ego(item, ego_pose), 1.0, 2.0)
    stop_lines = _semantic_points(graph.get("stopLines", graph.get("stop_lines", [])))
    for item in stop_lines:
        _draw_polyline(map_raster[CH["stop_line"]], world_to_ego(item, ego_pose), 1.0, 0.6)
    signals = _semantic_points(graph.get("trafficSignals", graph.get("signals", [])))
    for item in signals:
        _draw_polyline(map_raster[CH["traffic_signal"]], world_to_ego(item, ego_pose), 1.0, 1.0)

    route = np.asarray(route_points or [], dtype=np.float64).reshape(-1, 2) if route_points else np.empty((0, 2))
    route_ego = world_to_ego(route, ego_pose) if len(route) else route
    route_ok = len(route_ego) >= 2
    if route_ok:
        _draw_polyline(route_raster[ROUTE_CORRIDOR], route_ego, 1.0, corridor_width_m)
        end = to_pixels(route_ego[-1:])[0]
        rr, cc = np.rint(end).astype(np.int64)
        radius = max(1, int(round(destination_radius_m / MPP)))
        r0, r1 = max(0, rr - radius), min(H, rr + radius + 1)
        c0, c1 = max(0, cc - radius), min(W, cc + radius + 1)
        if r0 < r1 and c0 < c1:
            route_raster[ROUTE_DESTINATION, r0:r1, c0:c1] = 1.0

    map_ok = visible > 0 and int(np.count_nonzero(map_raster[CH["drivable"]])) > 0
    diag = RasterDiagnostics(
        map_valid=map_ok,
        route_valid=route_ok,
        lane_count=len(lanes),
        visible_lane_count=visible,
        drivable_pixels=int(np.count_nonzero(map_raster[CH["drivable"]])),
        centerline_pixels=int(np.count_nonzero(map_raster[CH["centerline"]])),
        intersection_pixels=int(np.count_nonzero(map_raster[CH["intersection"]])),
        crosswalks_filled=len(crosswalks),
        stop_lines_filled=len(stop_lines),
        signals_filled=len(signals),
        unavailable_channels=("overlap",) if not graph.get("overlap") else (),
    )
    return map_raster.astype(np.float32), route_raster.astype(np.float32), diag
