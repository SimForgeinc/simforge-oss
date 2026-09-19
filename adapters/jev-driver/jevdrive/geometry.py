"""Deterministic Frenet sampling and conservative continuous swept OBB checks.
All inputs are ego-frame route/map/perception geometry, never hidden actors.
"""
from bisect import bisect_right
import math
from . import policy as C


def angle_delta(a, b):
    return (a - b + math.pi) % (2 * math.pi) - math.pi


class RoutePolyline:
    def __init__(self, points):
        self.points = points
        self.arc = [0.0]
        for a, b in zip(points, points[1:]):
            self.arc.append(self.arc[-1] + math.hypot(b[0] - a[0], b[1] - a[1]))
        self.origin, self.offset = self.project(0.0, 0.0)
        self.headings = []
        for i in range(len(points)):
            a, b = points[max(0, i - 1)], points[min(len(points) - 1, i + 1)]
            self.headings.append(math.atan2(b[1] - a[1], b[0] - a[0]))

    def project(self, x, y):
        best = (0.0, math.inf)
        for i, (a, b) in enumerate(zip(self.points, self.points[1:])):
            dx, dy = b[0] - a[0], b[1] - a[1]
            length2 = dx * dx + dy * dy
            if length2 <= C.NUMERIC_EPS:
                continue
            u = min(1.0, max(0.0, ((x - a[0]) * dx + (y - a[1]) * dy) / length2))
            distance = math.hypot(x - a[0] - u * dx, y - a[1] - u * dy)
            if distance < best[1]:
                best = (self.arc[i] + u * math.sqrt(length2), distance)
        return best

    def sample(self, distance):
        s = self.origin + distance
        i = min(len(self.points) - 2, max(0, bisect_right(self.arc, s) - 1))
        span = self.arc[i + 1] - self.arc[i]
        u = 0.0 if span <= C.NUMERIC_EPS else (s - self.arc[i]) / span
        a, b = self.points[i], self.points[i + 1]
        return (a[0] + u * (b[0] - a[0]), a[1] + u * (b[1] - a[1]),
                self.headings[i] + u * angle_delta(self.headings[i + 1], self.headings[i]))


def box_corners(x, y, heading, length, width, margin=0.0):
    c, s = math.cos(heading), math.sin(heading)
    l, w = length / 2 + margin, width / 2 + margin
    return [(x + c * dx - s * dy, y + s * dx + c * dy)
            for dx, dy in ((-l, -w), (l, -w), (l, w), (-l, w))]


def convex_hull(points):
    points = sorted(set(points))
    def cross(o, a, b):
        return (a[0]-o[0])*(b[1]-o[1])-(a[1]-o[1])*(b[0]-o[0])
    lo, hi = [], []
    for p in points:
        while len(lo) >= 2 and cross(lo[-2], lo[-1], p) <= 0:
            lo.pop()
        lo.append(p)
    for p in reversed(points):
        while len(hi) >= 2 and cross(hi[-2], hi[-1], p) <= 0:
            hi.pop()
        hi.append(p)
    return lo[:-1] + hi[:-1]


def polygons_overlap(a, b):
    for polygon in (a, b):
        for p, q in zip(polygon, polygon[1:] + polygon[:1]):
            axis = (-(q[1] - p[1]), q[0] - p[0])
            pa = [x * axis[0] + y * axis[1] for x, y in a]
            pb = [x * axis[0] + y * axis[1] for x, y in b]
            if max(pa) < min(pb) or max(pb) < min(pa):
                return False
    return True


def swept_footprint_hits(previous, current, ego, obstacle):
    """Hull of expanded endpoint OBBs plus rotational-arc bound contains sweep.
    Between consecutive planned samples, position/heading are interpolated.
    A corner travels at most R*abs(delta_heading) due to rotation; expanding
    endpoints by that bound covers the non-linear rotational sweep as well.
    """
    radius = math.hypot(ego["length_m"], ego["width_m"]) / 2
    margin = (C.POSITION_MARGIN_M + C.TRACKING_MARGIN_M + C.QUANTUM_M
              + radius * abs(angle_delta(current[2], previous[2])))
    hull = convex_hull(box_corners(*previous, ego["length_m"], ego["width_m"], margin)
                       + box_corners(*current, ego["length_m"], ego["width_m"], margin))
    ox, oy, length, width, heading = obstacle
    return polygons_overlap(hull, box_corners(ox, oy, heading, length, width))


def footprint_in_corridor(pose, ego, route, width):
    return all(route.project(x, y)[1] + C.TRACKING_MARGIN_M <= width / 2
               for x, y in box_corners(*pose, ego["length_m"], ego["width_m"]))
