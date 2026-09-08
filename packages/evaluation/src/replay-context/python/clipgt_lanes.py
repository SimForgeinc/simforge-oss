#!/usr/bin/env python3
"""Extract per-lane geometry from a NuRec package's ClipGT annotations, as a binding source.

A lane-departure claim is a claim about lane POSITION, so it needs a lane the vehicle is
actually in. The number this replaces — 5.454 m of departure by a vehicle driving 0.16 m from
the recorded human path — came from binding to the nearest centreline of a lane graph derived
from `map.xodr`, which was already 1.101 m off at the first pose. Renaming the metric did not
give it a better lane; only a better binding source does.

What is emitted, per lane, in the package's own world frame:

* `centreline` — the midpoint sequence of the lane's two rails. Derived, and labelled as such.
* `leftRail` / `rightRail` — the annotated rails verbatim, so a consumer can bind by
  CONTAINMENT (is the vehicle inside this lane's rails?) instead of by nearest centreline.
  Containment is the binding a lane-position metric wants: nearest-centreline picks a lane even
  when the vehicle is nowhere near it, which is exactly how the 5.454 m arose.
* `widthM` — median rail separation, for consumers that need a scale.

Deliberately not emitted: any travel direction or speed limit. `lane_direction` is a geometry
class (STRAIGHT, MERGE_LEFT, ...) and `speed_limit` is 0 (unset) on most lanes. Those two
categories stay unavailable; nothing here changes that.

Rails are resampled onto a common arclength parameterisation before the midpoint is taken,
because the two rails of one lane do not carry the same vertex count and a naive zip would pair
points that are not opposite each other.
"""

from __future__ import annotations

import argparse
import io
import json
import math
import sys
import zipfile


def _resample(points: list[list[float]], count: int) -> list[list[float]]:
    """Resample a polyline onto `count` points evenly spaced by arclength."""
    if len(points) == 1:
        return [list(points[0]) for _ in range(count)]
    cumulative = [0.0]
    for index in range(1, len(points)):
        step = math.dist(points[index - 1], points[index])
        cumulative.append(cumulative[-1] + step)
    total = cumulative[-1]
    if total == 0:
        return [list(points[0]) for _ in range(count)]
    out: list[list[float]] = []
    cursor = 0
    for i in range(count):
        target = total * i / (count - 1) if count > 1 else 0.0
        while cursor < len(cumulative) - 2 and cumulative[cursor + 1] < target:
            cursor += 1
        span = cumulative[cursor + 1] - cumulative[cursor]
        t = 0.0 if span == 0 else (target - cumulative[cursor]) / span
        ax, ay = points[cursor]
        bx, by = points[cursor + 1]
        out.append([ax + t * (bx - ax), ay + t * (by - ay)])
    return out


def _lane_records(table) -> tuple[list[dict], dict]:
    lanes: list[dict] = []
    census = {"rows": 0, "degenerate": 0, "railMismatch": 0}
    for index, lane in enumerate(table["lane"]):
        census["rows"] += 1
        left = [[float(p["x"]), float(p["y"])] for p in (lane.get("left_rail") or [])]
        right = [[float(p["x"]), float(p["y"])] for p in (lane.get("right_rail") or [])]
        if len(left) < 2 or len(right) < 2:
            census["degenerate"] += 1
            continue
        if len(left) != len(right):
            # Not an error — the rails are labelled independently — but worth counting, since a
            # naive zip of mismatched rails is a plausible way to produce a plausible-looking
            # centreline that is wrong.
            census["railMismatch"] += 1
        samples = max(len(left), len(right))
        left_s = _resample(left, samples)
        right_s = _resample(right, samples)
        centreline = [[(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] for a, b in zip(left_s, right_s)]
        widths = sorted(math.dist(a, b) for a, b in zip(left_s, right_s))
        lanes.append({
            "id": f"lane-{index}",
            "centreline": centreline,
            "leftRail": left,
            "rightRail": right,
            "widthM": widths[len(widths) // 2],
        })
    return lanes, census


def main() -> int:
    parser = argparse.ArgumentParser(description="ClipGT lane binding source")
    parser.add_argument("--package", required=True)
    parser.add_argument("--frame", required=True, help="frame the points are in; must match ego.frame")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    import pyarrow.parquet as pq

    with zipfile.ZipFile(args.package) as archive:
        if "clipgt/lane.parquet" not in archive.namelist():
            json.dump({"error": {"code": "input_error", "retryable": False,
                                 "message": "package carries no clipgt/lane.parquet; lane context is unavailable",
                                 "fields": ["clipgt/lane.parquet"]}}, sys.stdout)
            print()
            return 2
        table = pq.read_table(io.BytesIO(archive.read("clipgt/lane.parquet"))).to_pydict()

    lanes, census = _lane_records(table)
    if not lanes:
        json.dump({"error": {"code": "input_error", "retryable": False,
                             "message": "no lane carried two usable rails; lane context is unavailable",
                             "fields": ["clipgt/lane.parquet"]}}, sys.stdout)
        print()
        return 2

    xs = [p[0] for lane in lanes for p in lane["centreline"]]
    ys = [p[1] for lane in lanes for p in lane["centreline"]]
    block = {
        "schema": "simforge.lane-context/v1",
        "source": "clipgt-lane-rails",
        "frame": args.frame,
        # Static for the clip: ClipGT lane geometry carries no time dimension.
        "timeSupportUs": None,
        "lanes": lanes,
        "coverage": {"boundsMinXY": [min(xs), min(ys)], "boundsMaxXY": [max(xs), max(ys)]},
        "provenance": {
            "lanes": census,
            "centrelineDerivation": "midpoint of arclength-resampled left and right rails",
            "bindingRecommendation": "containment in the lane's own rails; nearest-centreline "
                                     "binds to a lane the vehicle may not be in, which is how the "
                                     "superseded 5.454 m lane-departure arose",
            "travelDirectionEmitted": False,
            "speedLimitsEmitted": False,
        },
    }
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(block, handle)
    summary = {k: block[k] for k in ("schema", "source", "frame", "coverage", "provenance")}
    json.dump({**summary, "laneCount": len(lanes), "out": args.out}, sys.stdout, indent=2)
    print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
