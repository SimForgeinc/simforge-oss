"""Host-side lane graph and lane-path routes.

A faithful port of the parts of ``packages/engine/src/map/{lane-graph,route}.ts``
the profile needs at admission time: decoding ``topology-index.json(.gz)``,
lane polyline geometry, legal orientation, lane-path route construction and the
route queries used to place actors at ``t = 0``. The same geometry is then
flattened into the shared device tables (see :mod:`.scenario`), and the device
kernels re-implement ``poseAt`` / ``projectPoint`` / ``lateralOffsetAt`` on
those tables with the identical algorithm.
"""

from __future__ import annotations

import gzip
import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

DEFAULT_SPEED_LIMIT_MPS = 13.4
DEFAULT_LANE_WIDTH_M = 3.5
ENDPOINT_TOL_M = 0.5
TWO_PI = 2.0 * math.pi


def normalize_angle(a: float) -> float:
    """Wrap into ``(-pi, pi]`` exactly like ``core/math.ts``."""
    v = math.fmod(a, TWO_PI)
    if v <= -math.pi:
        v += TWO_PI
    if v > math.pi:
        v -= TWO_PI
    return v


def angle_delta(from_rad: float, to_rad: float) -> float:
    return normalize_angle(to_rad - from_rad)


def clamp(v: float, lo: float, hi: float) -> float:
    return lo if v < lo else hi if v > hi else v


@dataclass(frozen=True)
class LaneGeometry:
    rsl: str
    index: int
    lane_id: int
    is_junction: bool
    points: np.ndarray  # (n, 2) float64, storage order
    cum: np.ndarray  # (n,) cumulative arc length
    headings: np.ndarray  # (n,) heading of segment starting at vertex i (last repeated)
    length_m: float
    speed_limit_mps: float
    width_m: float
    width_samples: np.ndarray  # (k, 2) [s, widthM]; k may be 0
    predecessors: tuple[str, ...]
    successors: tuple[str, ...]

    def sample_storage(self, s: float) -> tuple[float, float, float]:
        q = clamp(s, 0.0, self.length_m)
        cum = self.cum
        lo, hi = 0, len(cum) - 1
        while hi - lo > 1:
            mid = (lo + hi) >> 1
            if cum[mid] <= q:
                lo = mid
            else:
                hi = mid
        a = self.points[lo]
        b = self.points[hi]
        span = cum[hi] - cum[lo]
        t = (q - cum[lo]) / span if span > 1e-9 else 0.0
        return float(a[0] + (b[0] - a[0]) * t), float(a[1] + (b[1] - a[1]) * t), float(self.headings[lo])

    def width_at(self, s: float) -> float:
        samples = self.width_samples
        if len(samples) == 0:
            return self.width_m
        if len(samples) == 1:
            return float(samples[0, 1])
        q = clamp(s, 0.0, self.length_m)
        if q <= samples[0, 0]:
            return float(samples[0, 1])
        for i in range(1, len(samples)):
            a = samples[i - 1]
            b = samples[i]
            if q <= b[0]:
                span = b[0] - a[0]
                t = (q - a[0]) / span if span > 1e-9 else 0.0
                return float(a[1] + (b[1] - a[1]) * t)
        return float(samples[-1, 1])


def _point_of(p: Any) -> tuple[float, float]:
    if isinstance(p, (list, tuple)):
        return float(p[0]), float(p[1])
    return float(p["x"]), float(p["y"])


class LaneGraph:
    """Immutable drivable geometry of one map; build once, share across batches."""

    def __init__(self, index: dict[str, Any]) -> None:
        self.map_name: str = str(index.get("mapName") or "unknown")
        self.topology_digest: str = str((index.get("source") or {}).get("xodrSha256") or "")
        self._geom: dict[str, LaneGeometry] = {}
        lanes = index.get("lanes") or {}
        for order, rsl in enumerate(sorted(lanes.keys())):
            lane = lanes[rsl]
            pts: list[tuple[float, float]] = []
            for raw in lane.get("polyline") or []:
                v = _point_of(raw)
                if pts and abs(pts[-1][0] - v[0]) < 1e-9 and abs(pts[-1][1] - v[1]) < 1e-9:
                    continue
                pts.append(v)
            if len(pts) < 2:
                continue
            points = np.asarray(pts, dtype=np.float64)
            seg = np.diff(points, axis=0)
            seg_len = np.hypot(seg[:, 0], seg[:, 1])
            cum = np.concatenate(([0.0], np.cumsum(seg_len)))
            headings = np.arctan2(seg[:, 1], seg[:, 0])
            headings = np.concatenate((headings, headings[-1:]))
            kph = lane.get("speedLimitKph")
            width = lane.get("representativeWidthM")
            samples = lane.get("widthSamples") or []
            width_samples = (
                np.asarray([[float(s["s"]), float(s["widthM"])] for s in samples], dtype=np.float64)
                if samples
                else np.zeros((0, 2), dtype=np.float64)
            )
            self._geom[rsl] = LaneGeometry(
                rsl=rsl,
                index=len(self._geom),
                lane_id=int(lane.get("laneId", 0)),
                is_junction=bool(lane.get("isJunction", False)),
                points=points,
                cum=cum,
                headings=headings,
                length_m=float(cum[-1]),
                speed_limit_mps=float(kph) / 3.6 if kph and kph > 0 else DEFAULT_SPEED_LIMIT_MPS,
                width_m=float(width) if width and width > 0 else DEFAULT_LANE_WIDTH_M,
                width_samples=width_samples,
                predecessors=tuple(lane.get("predecessors") or []),
                successors=tuple(lane.get("successors") or []),
            )
        self.lanes: list[LaneGeometry] = sorted(self._geom.values(), key=lambda g: g.index)

    @classmethod
    def load(cls, path: str | Path) -> "LaneGraph":
        raw = Path(path).read_bytes()
        if raw[:2] == b"\x1f\x8b":
            raw = gzip.decompress(raw)
        return cls(json.loads(raw))

    def geometry(self, rsl: str) -> LaneGeometry | None:
        return self._geom.get(rsl)

    def require_geometry(self, rsl: str) -> LaneGeometry:
        g = self._geom.get(rsl)
        if g is None:
            raise KeyError(f"lane {rsl} is not in the topology index (or has no polyline)")
        return g

    def nominal_reversed(self, rsl: str) -> bool | None:
        g = self.geometry(rsl)
        if g is None or g.is_junction:
            return None
        return g.lane_id > 0

    def endpoints(self, rsl: str, reversed_: bool) -> tuple[np.ndarray, np.ndarray]:
        g = self.require_geometry(rsl)
        first, last = g.points[0], g.points[-1]
        return (last, first) if reversed_ else (first, last)

    def orient_toward(self, rsl: str, from_point: np.ndarray, tol: float = ENDPOINT_TOL_M) -> bool | None:
        g = self.geometry(rsl)
        if g is None:
            return None
        nominal = self.nominal_reversed(rsl)
        options = [False, True] if nominal is None else [nominal]
        best: tuple[bool, float] | None = None
        for rev in options:
            entry, _ = self.endpoints(rsl, rev)
            d = float(math.hypot(entry[0] - from_point[0], entry[1] - from_point[1]))
            if d <= tol and (best is None or d < best[1]):
                best = (rev, d)
        return None if best is None else best[0]


@dataclass(frozen=True)
class RouteLeg:
    lane: LaneGeometry
    reversed: bool
    s_start: float
    length_m: float


@dataclass(frozen=True)
class RoutePose:
    x: float
    y: float
    heading_rad: float
    rsl: str
    lane_s: float
    storage_s: float
    leg_index: int


class RouteBuildError(Exception):
    def __init__(self, code: str, reason: str) -> None:
        super().__init__(reason)
        self.code = code
        self.reason = reason


class Route:
    """Lane-chain route: identical query semantics to ``Route`` in route.ts."""

    def __init__(self, legs: list[RouteLeg]) -> None:
        if not legs:
            raise RouteBuildError("route_empty", "no lanes")
        self.legs = legs
        self.length_m = legs[-1].s_start + legs[-1].length_m

    def leg_index_at(self, s: float) -> int:
        q = clamp(s, 0.0, self.length_m)
        lo, hi = 0, len(self.legs) - 1
        while lo < hi:
            mid = (lo + hi + 1) >> 1
            if self.legs[mid].s_start <= q:
                lo = mid
            else:
                hi = mid - 1
        return lo

    def pose_at(self, s: float) -> RoutePose:
        q = clamp(s, 0.0, self.length_m)
        i = self.leg_index_at(q)
        leg = self.legs[i]
        lane_s = clamp(q - leg.s_start, 0.0, leg.length_m)
        storage_s = leg.length_m - lane_s if leg.reversed else lane_s
        x, y, heading = leg.lane.sample_storage(storage_s)
        if leg.reversed:
            heading += math.pi
        return RoutePose(x, y, normalize_angle(heading), leg.lane.rsl, lane_s, storage_s, i)

    def width_at(self, s: float) -> float:
        i = self.leg_index_at(s)
        leg = self.legs[i]
        lane_s = clamp(s - leg.s_start, 0.0, leg.length_m)
        storage_s = leg.length_m - lane_s if leg.reversed else lane_s
        return leg.lane.width_at(storage_s)

    def point_with_offset(self, s: float, lateral_m: float) -> tuple[float, float]:
        pose = self.pose_at(s)
        if lateral_m == 0.0:
            return pose.x, pose.y
        nx = -math.sin(pose.heading_rad)
        ny = math.cos(pose.heading_rad)
        return pose.x + nx * lateral_m, pose.y + ny * lateral_m

    def s_of_lane_storage(self, rsl: str, storage_s: float) -> float | None:
        for leg in self.legs:
            if leg.lane.rsl == rsl:
                travel = leg.length_m - storage_s if leg.reversed else storage_s
                return leg.s_start + clamp(travel, 0.0, leg.length_m)
        return None

    def project_point(self, x: float, y: float, step_m: float = 2.0) -> tuple[float, float]:
        best_s, best_d = 0.0, math.inf
        n = max(2, math.ceil(self.length_m / step_m) + 1)
        for i in range(n):
            s = (self.length_m * i) / (n - 1)
            p = self.pose_at(s)
            d = math.hypot(p.x - x, p.y - y)
            if d < best_d:
                best_s, best_d = s, d
        lo = max(0.0, best_s - step_m)
        hi = min(self.length_m, best_s + step_m)
        for _ in range(24):
            m1 = lo + (hi - lo) / 3
            m2 = hi - (hi - lo) / 3
            p1 = self.pose_at(m1)
            p2 = self.pose_at(m2)
            d1 = math.hypot(p1.x - x, p1.y - y)
            d2 = math.hypot(p2.x - x, p2.y - y)
            if d1 < d2:
                hi = m2
            else:
                lo = m1
        s = (lo + hi) / 2
        p = self.pose_at(s)
        return s, math.hypot(p.x - x, p.y - y)

    def lateral_offset_at(self, s: float, x: float, y: float) -> float:
        pose = self.pose_at(s)
        dx = x - pose.x
        dy = y - pose.y
        return -math.sin(pose.heading_rad) * dx + math.cos(pose.heading_rad) * dy


def build_lane_path_route(graph: LaneGraph, lanes: list[str]) -> Route:
    if not lanes:
        raise RouteBuildError("route_empty", "no lanes")
    for rsl in lanes:
        if graph.geometry(rsl) is None:
            raise RouteBuildError("route_lane_missing", f"lane {rsl} not in topology")
    first = lanes[0]
    first_reversed = graph.nominal_reversed(first)
    if first_reversed is None:
        first_reversed = False
    if len(lanes) > 1:
        nxt = lanes[1]
        matched = False
        for rev in (first_reversed, not first_reversed):
            _, exit_pt = graph.endpoints(first, rev)
            if graph.orient_toward(nxt, exit_pt) is not None:
                first_reversed = rev
                matched = True
                break
        if not matched:
            raise RouteBuildError(
                "route_disconnected", f"lane {first} does not connect to {nxt} within {ENDPOINT_TOL_M} m"
            )
    g0 = graph.require_geometry(first)
    legs = [RouteLeg(g0, first_reversed, 0.0, g0.length_m)]
    for rsl in lanes[1:]:
        prev = legs[-1]
        _, exit_pt = graph.endpoints(prev.lane.rsl, prev.reversed)
        oriented = graph.orient_toward(rsl, exit_pt)
        if oriented is None:
            raise RouteBuildError("route_disconnected", f"lane {prev.lane.rsl} does not connect to {rsl}")
        g = graph.require_geometry(rsl)
        legs.append(RouteLeg(g, oriented, prev.s_start + prev.length_m, g.length_m))
    return Route(legs)
