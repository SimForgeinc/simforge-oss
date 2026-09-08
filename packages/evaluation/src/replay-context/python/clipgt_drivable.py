#!/usr/bin/env python3
"""Extract authoritative drivable-area polygons from a NuRec package's ClipGT annotations.

The v1 off-road metric measured distance from one pre-bound lane centreline, which flagged a
recorded human drive as off-road because the binding was a lane-width out. Off-road means
vehicle-footprint containment in drivable-area polygons, and those polygons have to come from
the scene's own authoritative annotations rather than from a lane graph we derived.

Source of truth is `clipgt/lane.parquet`: each lane carries `left_rail` and `right_rail` as 3D
polylines, so the drivable surface of a lane is the ring `left_rail + reverse(right_rail)`.
`clipgt/road_island.parquet` contributes holes — medians and islands are inside the road's
outline but are not drivable.

Deliberately not inferred:

* **Speed limits.** `lane.speed_limit` exists and is `0` on the overwhelming majority of lanes
  (152 of 168 on the scene this was written against). Zero is *unset*, not a 0 m/s limit, and
  this tool never emits a speed limit. Speeding stays unavailable.
* **Travel direction.** `lane.lane_direction` is a geometry class (STRAIGHT, MERGE_LEFT,
  BRANCH_LEFT, ...), not traffic direction. Nothing here derives a heading authority from it.
* **Coordinates.** Points are emitted in the package's own world frame, unchanged. The consumer
  declares the frame must equal `ego.frame` and refuses on mismatch; transforming here would
  hide exactly the class of error that produced the v1 bug.

Output is the `drivableArea` block agreed with the scoring owner.
"""

from __future__ import annotations

import argparse
import io
import json
import sys
import zipfile


def _rings_from_lanes(table) -> list[dict]:
    """One drivable ring per lane: left rail out, right rail back."""
    rings = []
    for index, lane in enumerate(table["lane"]):
        left = lane.get("left_rail") or []
        right = lane.get("right_rail") or []
        # A lane needs both rails to bound a surface; one rail is a line, not an area.
        if len(left) < 2 or len(right) < 2:
            continue
        ring = [[float(p["x"]), float(p["y"])] for p in left]
        ring += [[float(p["x"]), float(p["y"])] for p in reversed(right)]
        if len(ring) < 4:
            continue
        rings.append({"id": f"lane-{index}", "kind": "drivable", "ring": ring})
    return rings


def _rings_from_islands(table, column: str, kind: str, prefix: str) -> tuple[list[dict], dict]:
    """Islands and other cut-outs, with a census so an empty row is distinguishable from a miss.

    A silently dropped hole would make undrivable ground look drivable, so the caller reports
    how many rows were seen, how many carried no geometry, and how many were unreadable.
    """
    rings: list[dict] = []
    census = {"rows": 0, "empty": 0, "unreadable": 0}
    for index, item in enumerate(table[column]):
        census["rows"] += 1
        points = item.get("location")
        if points is None:
            census["unreadable"] += 1
            continue
        if len(points) == 0:
            census["empty"] += 1
            continue
        ring = [[float(p["x"]), float(p["y"])] for p in points if isinstance(p, dict) and "x" in p]
        if len(ring) < 3:
            census["unreadable"] += 1
            continue
        rings.append({"id": f"{prefix}-{index}", "kind": kind, "ring": ring})
    return rings, census


def _dissolve(polygons: list[dict]) -> list[dict]:
    """Union the drivable rings, subtract the holes, and return the resulting boundary rings.

    Uses shapely at INGESTION time only, so the scoring consumer needs no geometry library and
    no tolerance: it receives a surface whose interior is genuinely contiguous.
    """
    from shapely.geometry import Polygon
    from shapely.ops import unary_union

    drivable = []
    for poly in polygons:
        if poly["kind"] != "drivable":
            continue
        shape = Polygon(poly["ring"])
        if not shape.is_valid:
            shape = shape.buffer(0)  # repair self-intersecting rails; area-preserving
        if not shape.is_empty:
            drivable.append(shape)
    holes = []
    for poly in polygons:
        if poly["kind"] != "hole":
            continue
        shape = Polygon(poly["ring"])
        if not shape.is_valid:
            shape = shape.buffer(0)
        if not shape.is_empty:
            holes.append(shape)

    surface = unary_union(drivable)
    if holes:
        surface = surface.difference(unary_union(holes))

    parts = list(getattr(surface, "geoms", [surface]))
    out: list[dict] = []
    for index, part in enumerate(parts):
        if part.is_empty:
            continue
        out.append({"id": f"surface-{index}", "kind": "drivable",
                    "ring": [[float(x), float(y)] for x, y in part.exterior.coords[:-1]]})
        for hole_index, interior in enumerate(part.interiors):
            # Interior rings of the dissolved surface are genuine holes: enclosed non-road.
            out.append({"id": f"surface-{index}-hole-{hole_index}", "kind": "hole",
                        "ring": [[float(x), float(y)] for x, y in interior.coords[:-1]]})
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description="ClipGT drivable-area extraction")
    parser.add_argument("--package", required=True)
    parser.add_argument("--frame", required=True, help="frame the points are in; must match ego.frame")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    import pyarrow.parquet as pq

    with zipfile.ZipFile(args.package) as archive:
        names = set(archive.namelist())
        if "clipgt/lane.parquet" not in names:
            json.dump(
                {"error": {"code": "input_error", "retryable": False,
                           "message": "package carries no clipgt/lane.parquet; drivable area is unavailable",
                           "fields": ["clipgt/lane.parquet"]}},
                sys.stdout)
            print()
            return 2
        lanes = pq.read_table(io.BytesIO(archive.read("clipgt/lane.parquet"))).to_pydict()
        polygons = _rings_from_lanes(lanes)
        island_census = {"rows": 0, "empty": 0, "unreadable": 0}
        if "clipgt/road_island.parquet" in names:
            islands = pq.read_table(io.BytesIO(archive.read("clipgt/road_island.parquet"))).to_pydict()
            island_rings, island_census = _rings_from_islands(islands, "road_island", "hole", "island")
            polygons += island_rings

    if not polygons:
        json.dump({"error": {"code": "input_error", "retryable": False,
                             "message": "no lane produced a usable drivable ring",
                             "fields": ["clipgt/lane.parquet"]}}, sys.stdout)
        print()
        return 2

    # DISSOLVE. Lane rings are per-lane, and adjacent lanes do not share byte-identical rails,
    # so testing membership in individual rings leaves hairline seams between lanes. Measured on
    # the recorded human drive of scene 0009402a, 18 of 18 footprint corners reported "off-road"
    # sat within 0.30 m of TWO lane polygons: they were in the seam, not off the road. The road
    # surface is the UNION of its lanes, so the union is what gets emitted — dissolved once here
    # rather than approximated with a tolerance at scoring time, which would have been a fudge
    # dressed as a fix.
    polygons = _dissolve(polygons)

    xs = [p[0] for poly in polygons for p in poly["ring"]]
    ys = [p[1] for poly in polygons for p in poly["ring"]]
    block = {
        "source": "clipgt",
        "frame": args.frame,
        "confidence": "authoritative",
        # Static for the clip: ClipGT lane geometry carries no time dimension, so a consumer
        # never has to pick a nearest frame. If a release adds one, this becomes a real window.
        "timeSupportUs": None,
        "polygons": polygons,
        "coverage": {"boundsMinXY": [min(xs), min(ys)], "boundsMaxXY": [max(xs), max(ys)]},
        "provenance": {
            "lanes": len(lanes["lane"]),
            "dissolved": True,
            "drivableRings": sum(1 for p in polygons if p["kind"] == "drivable"),
            "holeRings": sum(1 for p in polygons if p["kind"] == "hole"),
            # An empty island row means the scene has no island; an unreadable one means we
            # failed to parse geometry that exists, which would make undrivable ground look
            # drivable. The two must never be confused.
            "islandRows": island_census,
            "speedLimitsEmitted": False,
            "speedLimitNote": "lane.speed_limit is 0 (unset) on most lanes; zero is not a limit and no speed is emitted",
            "travelDirectionEmitted": False,
            "travelDirectionNote": "lane_direction is a geometry class, not traffic direction; no heading authority is derived",
        },
    }
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(block, handle)
    summary = {k: block[k] for k in ("source", "frame", "confidence", "coverage", "provenance")}
    json.dump({**summary, "out": args.out}, sys.stdout, indent=2)
    print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
