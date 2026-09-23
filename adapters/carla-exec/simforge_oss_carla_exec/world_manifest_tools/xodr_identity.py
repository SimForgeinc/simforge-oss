"""Road-network identity between a source XODR and a cooked CARLA world's XODR.

A cooked RoadRunner world re-serializes the OpenDRIVE it was built from, and a
re-export of an unchanged scene may renumber roads, junctions and signals. The
question this module answers is therefore not "are the bytes equal" but "is
this the same road network, and if the ids moved, where did each one go".

Roads are paired by their geometry (not their ids), then every paired road is
compared field by field: plan-view geometry, lane sections and widths,
elevation, superelevation, lane offsets and topology (links through the derived
road/junction id maps). Signals are paired by (road, s, t, type, subtype,
orientation); controllers by the set of signals they drive. Anything that does
not pair is reported, never guessed.

Pure standard library so the generator runs anywhere the adapter does.
"""
from __future__ import annotations

import hashlib
import math
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from typing import Any, Iterable

#: Geometry tolerance for "the same road" (m): the replay parity gate's 1 cm.
#: A RoadRunner re-export of an unchanged scene moves reference lines by a few
#: millimetres (tiny segments split or merged, headings wrapped by 2*pi); a
#: real edit moves them by far more. Anything above this is a different road
#: network, which a cooked world cannot absorb.
GEOMETRY_TOLERANCE = 0.01


def _f(value: str | None) -> float:
    return float(value) if value is not None else 0.0


@dataclass
class Road:
    id: str
    junction: str
    length: float
    geometry: list[tuple]  # (s, x, y, hdg, length, kind, params...)
    lanes: list[tuple]
    elevation: list[tuple]
    lateral: list[tuple]
    lane_offset: list[tuple]
    links: list[tuple]  # (predecessor|successor, elementType, elementId, contactPoint)


@dataclass
class Signal:
    id: str
    road: str
    s: float
    t: float
    type: str
    subtype: str
    orientation: str
    dynamic: bool
    z_offset: float


@dataclass
class Network:
    sha256: str
    header: dict[str, str]
    geo_reference: str
    roads: dict[str, Road]
    signals: dict[str, Signal]
    controllers: dict[str, frozenset[str]]
    objects: Counter
    junctions: set[str]

    @property
    def dynamic_signal_ids(self) -> set[str]:
        return {sid for sid, sig in self.signals.items() if sig.dynamic}


def _poly(element: ET.Element, names: Iterable[str]) -> tuple:
    return tuple(_f(element.get(name)) for name in names)


def parse(data: bytes) -> Network:
    root = ET.fromstring(data)
    header = root.find("header")
    geo = header.find("geoReference") if header is not None else None
    roads: dict[str, Road] = {}
    signals: dict[str, Signal] = {}
    objects: Counter = Counter()
    for road in root.findall("road"):
        rid = road.get("id")
        geometry = []
        for g in road.find("planView").findall("geometry"):
            kind = list(g)[0]
            params = tuple(sorted((k, _f(v)) for k, v in kind.attrib.items() if k != "pRange"))
            geometry.append((_f(g.get("s")), _f(g.get("x")), _f(g.get("y")), _f(g.get("hdg")),
                             _f(g.get("length")), kind.tag, kind.get("pRange", ""), params))
        lanes = []
        lanes_el = road.find("lanes")
        lane_offset = [ _poly(o, ("s", "a", "b", "c", "d")) for o in lanes_el.findall("laneOffset")] if lanes_el is not None else []
        for section in (lanes_el.findall("laneSection") if lanes_el is not None else []):
            for side in ("left", "center", "right"):
                side_el = section.find(side)
                if side_el is None:
                    continue
                for lane in side_el.findall("lane"):
                    widths = tuple(_poly(w, ("sOffset", "a", "b", "c", "d")) for w in lane.findall("width"))
                    lanes.append((_f(section.get("s")), lane.get("id"), lane.get("type"), lane.get("level", "false"), widths))
        elevation = [_poly(e, ("s", "a", "b", "c", "d")) for e in road.findall("elevationProfile/elevation")]
        lateral = [_poly(e, ("s", "a", "b", "c", "d")) for e in road.findall("lateralProfile/superelevation")]
        links = []
        link = road.find("link")
        if link is not None:
            for which in ("predecessor", "successor"):
                el = link.find(which)
                if el is not None:
                    links.append((which, el.get("elementType"), el.get("elementId"), el.get("contactPoint", "")))
        roads[rid] = Road(rid, road.get("junction", "-1"), _f(road.get("length")), geometry, lanes,
                          elevation, lateral, lane_offset, links)
        for sig in road.findall("signals/signal"):
            signals[sig.get("id")] = Signal(
                sig.get("id"), rid, _f(sig.get("s")), _f(sig.get("t")), sig.get("type", ""),
                sig.get("subtype", ""), sig.get("orientation", ""), sig.get("dynamic") == "yes",
                _f(sig.get("zOffset")),
            )
        for obj in road.findall("objects/object"):
            objects[(obj.get("type", ""), obj.get("name", ""))] += 1
    controllers = {
        c.get("id"): frozenset(ctrl.get("signalId") for ctrl in c.findall("control"))
        for c in root.findall("controller")
    }
    return Network(
        sha256=hashlib.sha256(data).hexdigest(),
        header=dict(header.attrib) if header is not None else {},
        geo_reference=(geo.text or "").strip() if geo is not None else "",
        roads=roads, signals=signals, controllers=controllers, objects=objects,
        junctions={j.get("id") for j in root.findall("junction")},
    )


# ---- sampled evaluation -------------------------------------------------
#: Reference-line sample spacing (m). Every geometry's endpoints are sampled too.
SAMPLE_STEP_M = 0.5
#: Heading tolerance (rad): the replay parity gate's 0.1 degree.
HEADING_TOLERANCE = math.radians(0.1)


def _eval_geometry(g: tuple, t: float) -> tuple[float, float, float]:
    """(x, y, heading) at distance ``t`` along one planView geometry."""
    _, x0, y0, h0, length, kind, prange, params = g
    p = dict(params)
    if kind == "line":
        return x0 + math.cos(h0) * t, y0 + math.sin(h0) * t, h0
    if kind == "arc":
        k = p["curvature"]
        if abs(k) < 1e-12:
            return x0 + math.cos(h0) * t, y0 + math.sin(h0) * t, h0
        return x0 + (math.sin(h0 + k * t) - math.sin(h0)) / k, y0 - (math.cos(h0 + k * t) - math.cos(h0)) / k, h0 + k * t
    if kind == "spiral":
        c0, c1 = p["curvStart"], p["curvEnd"]
        dc = (c1 - c0) / length if length > 0 else 0.0
        n = max(4, int(t / 0.05) + 1)
        h = lambda u: h0 + c0 * u + 0.5 * dc * u * u
        x = y = 0.0
        du = t / n
        for i in range(n):  # Simpson per sub-interval
            a, m, b = i * du, (i + 0.5) * du, (i + 1) * du
            x += du / 6 * (math.cos(h(a)) + 4 * math.cos(h(m)) + math.cos(h(b)))
            y += du / 6 * (math.sin(h(a)) + 4 * math.sin(h(m)) + math.sin(h(b)))
        return x0 + x, y0 + y, h(t)
    if kind == "poly3":
        a, b, c, d = p["a"], p["b"], p["c"], p["d"]
        u = t
        v = a + b * u + c * u * u + d * u ** 3
        dv = b + 2 * c * u + 3 * d * u * u
        return x0 + u * math.cos(h0) - v * math.sin(h0), y0 + u * math.sin(h0) + v * math.cos(h0), h0 + math.atan(dv)
    if kind == "paramPoly3":
        q = t / length if prange != "arcLength" and length > 0 else t
        u = p["aU"] + p["bU"] * q + p["cU"] * q * q + p["dU"] * q ** 3
        v = p["aV"] + p["bV"] * q + p["cV"] * q * q + p["dV"] * q ** 3
        du = p["bU"] + 2 * p["cU"] * q + 3 * p["dU"] * q * q
        dv = p["bV"] + 2 * p["cV"] * q + 3 * p["dV"] * q * q
        return (x0 + u * math.cos(h0) - v * math.sin(h0), y0 + u * math.sin(h0) + v * math.cos(h0),
                h0 + math.atan2(dv, du))
    raise ValueError(f"unsupported OpenDRIVE geometry {kind}")


def _eval_ref(road: Road, s: float) -> tuple[float, float, float]:
    geometry = road.geometry
    idx = 0
    for i, g in enumerate(geometry):
        if g[0] <= s + 1e-9:
            idx = i
    g = geometry[idx]
    return _eval_geometry(g, min(max(s - g[0], 0.0), g[4]))


def _eval_poly(records: list[tuple], s: float) -> float:
    rec = None
    for r in records:
        if r[0] <= s + 1e-9:
            rec = r
    if rec is None:
        return 0.0
    ds = s - rec[0]
    return rec[1] + rec[2] * ds + rec[3] * ds * ds + rec[4] * ds ** 3


def _sections(road: Road) -> list[tuple[float, tuple]]:
    grouped: dict[float, list] = defaultdict(list)
    for section_s, lane_id, lane_type, level, widths in road.lanes:
        grouped[section_s].append((lane_id, lane_type, level, widths))
    return sorted((k, tuple(v)) for k, v in grouped.items())


def _lane_widths(sections: list[tuple[float, tuple]], s: float) -> tuple[int, dict[str, tuple[str, float]]]:
    index = 0
    for i, (s0, _) in enumerate(sections):
        if s0 <= s + 1e-9:
            index = i
    if not sections:
        return 0, {}
    s0, lanes = sections[index]
    out = {}
    for lane_id, lane_type, _level, widths in lanes:
        out[lane_id] = (lane_type, _eval_poly(list(widths), s - s0) if widths else 0.0)
    return index, out


def _angle_diff(a: float, b: float) -> float:
    return abs(math.atan2(math.sin(a - b), math.cos(a - b)))


def _mirror_lanes(sections: list[tuple[float, tuple]]) -> list[tuple[float, tuple]]:
    """Lane sections of a road driven the other way: left and right swap sides."""
    out = []
    for s0, lanes in sections:
        out.append((s0, tuple(sorted(
            ((str(-int(lid)) if lid.lstrip("-").isdigit() else lid), ltype, level, widths)
            for lid, ltype, level, widths in lanes
        ))))
    return out


def road_deviation(a: Road, b: Road, step: float = SAMPLE_STEP_M, *, reverse: bool = False) -> dict[str, float] | None:
    """Worst sampled deviation between two roads, or None when their lane
    structure differs (different lane sections, lane ids or lane types).

    ``reverse`` compares ``b`` driven backwards (RoadRunner may export a
    connector in the opposite direction): positions are matched end to start,
    headings differ by pi and lanes swap sides. Only single-section roads are
    compared reversed; anything richer is reported as a structural mismatch.
    """
    sa, sb = _sections(a), _sections(b)
    if reverse:
        if len(sa) != 1 or len(sb) != 1:
            return None
        sa_keys = sorted((l[0], l[1]) for l in sa[0][1])
        sb_keys = sorted((l[0], l[1]) for l in _mirror_lanes(sb)[0][1])
        if sa_keys != sb_keys:
            return None
    elif len(sa) != len(sb) or any(
        [(l[0], l[1]) for l in x[1]] != [(l[0], l[1]) for l in y[1]] for x, y in zip(sa, sb)
    ):
        return None
    n = max(2, int(math.ceil(max(a.length, b.length) / step)) + 1)
    us = sorted({i / (n - 1) for i in range(n)} | {g[0] / a.length for g in a.geometry if a.length > 0})
    worst = {"position": 0.0, "heading": 0.0, "elevation": 0.0, "superelevation": 0.0,
             "laneOffset": 0.0, "laneWidth": 0.0, "length": abs(a.length - b.length)}
    sign = -1.0 if reverse else 1.0
    for u in us:
        s1 = u * a.length
        s2 = (1.0 - u) * b.length if reverse else u * b.length
        x1, y1, h1 = _eval_ref(a, s1)
        x2, y2, h2 = _eval_ref(b, s2)
        if reverse:
            h2 += math.pi
        worst["position"] = max(worst["position"], math.hypot(x1 - x2, y1 - y2))
        worst["heading"] = max(worst["heading"], _angle_diff(h1, h2))
        worst["elevation"] = max(worst["elevation"], abs(_eval_poly(a.elevation, s1) - _eval_poly(b.elevation, s2)))
        worst["superelevation"] = max(worst["superelevation"], abs(_eval_poly(a.lateral, s1) - sign * _eval_poly(b.lateral, s2)))
        worst["laneOffset"] = max(worst["laneOffset"], abs(_eval_poly(a.lane_offset, s1) - sign * _eval_poly(b.lane_offset, s2)))
        _, wa = _lane_widths(sa, s1)
        _, wb = _lane_widths(sb, s2)
        if reverse:
            wb = {(str(-int(k)) if k.lstrip("-").isdigit() else k): v for k, v in wb.items()}
        # A lane-section boundary that moved by less than one sample leaves
        # different lane sets at one station; compare the lanes both sides have.
        for lane_id in set(wa) & set(wb):
            worst["laneWidth"] = max(worst["laneWidth"], abs(wa[lane_id][1] - wb[lane_id][1]))
    return worst


def _within(dev: dict[str, float], tolerance: float) -> bool:
    return all(v <= tolerance for k, v in dev.items() if k != "heading") and dev["heading"] <= HEADING_TOLERANCE


def _cell(x: float, y: float, size: float) -> tuple[int, int]:
    return int(math.floor(x / size)), int(math.floor(y / size))


def pair_roads(source: Network, runtime: Network, tolerance: float) -> tuple[dict[str, str], dict[str, dict[str, float]], set[str]]:
    """Pair every source road with the world road that has the same reference
    line (start/end within tolerance, then sampled deviation), preferring the
    candidate whose already-paired neighbours agree when several overlap."""
    size = max(tolerance * 4, 0.05)
    grid: dict[tuple[int, int], list[str]] = defaultdict(list)
    for rid, road in runtime.roads.items():
        g = road.geometry[0]
        grid[_cell(g[1], g[2], size)].append(rid)

    end_grid: dict[tuple[int, int], list[str]] = defaultdict(list)
    for rid, road in runtime.roads.items():
        e = _eval_ref(road, road.length)
        end_grid[_cell(e[0], e[1], size)].append(rid)

    def candidates(road: Road) -> list[tuple[str, bool]]:
        g = road.geometry[0]
        start_a = (g[1], g[2])
        end_a = _eval_ref(road, road.length)
        out = []
        for reverse, index, anchor in ((False, grid, start_a), (True, end_grid, start_a)):
            cx, cy = _cell(anchor[0], anchor[1], size)
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    for rid in index.get((cx + dx, cy + dy), ()):
                        other = runtime.roads[rid]
                        if abs(other.length - road.length) > tolerance:
                            continue
                        o_start = other.geometry[0][1], other.geometry[0][2]
                        o_end = _eval_ref(other, other.length)
                        near_a, near_b = (o_end, o_start) if reverse else (o_start, o_end)
                        if math.hypot(near_a[0] - start_a[0], near_a[1] - start_a[1]) > tolerance:
                            continue
                        if math.hypot(near_b[0] - end_a[0], near_b[1] - end_a[1]) > tolerance:
                            continue
                        out.append((rid, reverse))
        return out

    options: dict[str, list[tuple[str, dict[str, float]]]] = {}
    reversed_candidates: set[tuple[str, str]] = set()
    for rid, road in source.roads.items():
        found = []
        for cand, reverse in candidates(road):
            dev = road_deviation(road, runtime.roads[cand], reverse=reverse)
            if dev is not None and _within(dev, tolerance):
                found.append((cand, dev))
                if reverse:
                    reversed_candidates.add((rid, cand))
        options[rid] = found

    road_map: dict[str, str] = {}
    deviations: dict[str, dict[str, float]] = {}
    taken: set[str] = set()
    # 1) unambiguous pairs
    for rid, found in options.items():
        if len(found) == 1 and found[0][0] not in taken:
            road_map[rid], deviations[rid] = found[0]
            taken.add(found[0][0])
    # 2) overlapping roads (same reference line, e.g. lane connectors inside a
    #    junction): choose the candidate whose links agree with pairs made so far.
    progress = True
    while progress:
        progress = False
        for rid, found in options.items():
            if rid in road_map:
                continue
            free = [(c, d) for c, d in found if c not in taken]
            if not free:
                continue
            links = source.roads[rid].links

            def agreement(cand: str) -> int:
                other = {(w, t, e) for w, t, e, _ in runtime.roads[cand].links}
                return sum(1 for w, t, e, _ in links if t == "road" and (w, t, road_map.get(e)) in other)

            scored = sorted(free, key=lambda cd: (-agreement(cd[0]), max(cd[1].values()), cd[0]))
            if len(scored) == 1 or agreement(scored[0][0]) > agreement(scored[1][0]):
                road_map[rid], deviations[rid] = scored[0]
                taken.add(scored[0][0])
                progress = True
    # 3) whatever is still tied is geometrically indistinguishable; pair in id order
    for rid, found in sorted(options.items()):
        if rid in road_map:
            continue
        free = [(c, d) for c, d in found if c not in taken]
        if free:
            road_map[rid], deviations[rid] = sorted(free, key=lambda cd: (max(cd[1].values()), cd[0]))[0]
            taken.add(road_map[rid])
    reversed_pairs = {src for src, dst in road_map.items() if (src, dst) in reversed_candidates}
    return road_map, deviations, reversed_pairs


@dataclass
class Comparison:
    source_sha256: str
    runtime_sha256: str
    byte_exact: bool
    geometry_equivalent: bool
    roads: dict[str, Any] = field(default_factory=dict)
    signals: dict[str, Any] = field(default_factory=dict)
    controllers: dict[str, Any] = field(default_factory=dict)
    objects: dict[str, Any] = field(default_factory=dict)
    header: dict[str, Any] = field(default_factory=dict)
    signal_id_map: dict[str, str] = field(default_factory=dict)
    differences: list[str] = field(default_factory=list)
    blocking: list[str] = field(default_factory=list)
    decision_required: list[str] = field(default_factory=list)


def compare(source: Network, runtime: Network) -> Comparison:
    result = Comparison(source.sha256, runtime.sha256, source.sha256 == runtime.sha256, False)
    if result.byte_exact:
        result.geometry_equivalent = True
        return result

    # ---- header -------------------------------------------------------
    bounds = ("north", "south", "east", "west")
    header_bounds_equal = all(
        abs(_f(source.header.get(k)) - _f(runtime.header.get(k))) <= GEOMETRY_TOLERANCE for k in bounds
    )
    result.header = {
        "geoReferenceEqual": source.geo_reference == runtime.geo_reference,
        "boundsEqual": header_bounds_equal,
        "sourceDate": source.header.get("date"),
        "runtimeDate": runtime.header.get("date"),
    }
    if not result.header["geoReferenceEqual"]:
        result.blocking.append("geoReference differs")
    if not header_bounds_equal:
        result.blocking.append("header bounds differ")

    # ---- roads: pair by sampled geometry, then check topology ------------
    road_map, deviations, reversed_roads = pair_roads(source, runtime, GEOMETRY_TOLERANCE)
    unmatched_source = sorted(set(source.roads) - set(road_map))
    unmatched_runtime = sorted(set(runtime.roads) - set(road_map.values()))

    junction_map: dict[str, str] = {}
    junction_conflicts = 0
    for src, dst in road_map.items():
        a, b = source.roads[src].junction, runtime.roads[dst].junction
        if (a == "-1") != (b == "-1"):
            junction_conflicts += 1
            continue
        if a != "-1" and junction_map.setdefault(a, b) != b:
            junction_conflicts += 1

    worst = {k: 0.0 for k in ("position", "heading", "elevation", "superelevation", "laneOffset", "laneWidth", "length")}
    for dev in deviations.values():
        for k, v in dev.items():
            worst[k] = max(worst[k], v)
    structural = Counter()
    link_mismatch = 0
    for src, dst in road_map.items():
        a, b = source.roads[src], runtime.roads[dst]
        flip = {"predecessor": "successor", "successor": "predecessor", "start": "end", "end": "start"}
        mapped_links = []
        for which, kind, eid, contact in a.links:
            target = road_map.get(eid) if kind == "road" else junction_map.get(eid)
            if src in reversed_roads:
                which = flip[which]
            if kind == "road" and eid in reversed_roads and contact:
                contact = flip[contact]
            mapped_links.append((which, kind, target, contact))
        if sorted(mapped_links, key=str) != sorted(b.links, key=str):
            link_mismatch += 1

    renumbered = sum(1 for s, d in road_map.items() if s != d)
    result.roads = {
        "source": len(source.roads), "runtime": len(runtime.roads), "paired": len(road_map),
        "renumbered": renumbered, "reversed": sorted(reversed_roads), "unpairedSource": len(unmatched_source),
        "unpairedRuntime": len(unmatched_runtime), "junctionConflicts": junction_conflicts,
        "structuralMismatches": dict(structural), "linkMismatches": link_mismatch,
        "maxDeviation": {k: round(v, 6) for k, v in worst.items()},
        "junctions": {"source": len(source.junctions), "runtime": len(runtime.junctions),
                      "renumbered": sum(1 for s, d in junction_map.items() if s != d)},
    }
    geometry_ok = (
        not unmatched_source and not unmatched_runtime and junction_conflicts == 0
        and not structural and link_mismatch == 0
    )
    if not geometry_ok:
        result.blocking.append(
            "road network differs: "
            f"{len(unmatched_source)} source / {len(unmatched_runtime)} world roads unpaired, "
            f"{sum(structural.values())} structural and {link_mismatch} topology mismatches, "
            f"max deviations {result.roads['maxDeviation']}"
        )
    result.geometry_equivalent = geometry_ok and not result.blocking
    if renumbered:
        result.differences.append(f"road ids renumbered ({renumbered} of {len(road_map)})")
    if reversed_roads:
        result.differences.append(
            f"{len(reversed_roads)} roads exported in the opposite direction (same reference line and lanes): "
            + ", ".join(f"{r}->{road_map[r]}" for r in sorted(reversed_roads))
        )
    if result.roads["junctions"]["renumbered"]:
        result.differences.append(f"junction ids renumbered ({result.roads['junctions']['renumbered']})")

    # ---- signals ------------------------------------------------------
    def sig_key(sig: Signal, road: str | None) -> tuple:
        return (road, round(sig.s, 2), round(sig.t, 2), sig.type, sig.subtype, sig.orientation, sig.dynamic)

    def source_sig_key(sig: Signal) -> tuple:
        target = road_map.get(sig.road)
        if sig.road in reversed_roads and target is not None:
            length = runtime.roads[target].length
            orientation = {"+": "-", "-": "+"}.get(sig.orientation, sig.orientation)
            return (target, round(length - sig.s, 2), round(-sig.t, 2), sig.type, sig.subtype, orientation, sig.dynamic)
        return sig_key(sig, target)

    runtime_by_key: dict[tuple, list[str]] = defaultdict(list)
    for sid, sig in runtime.signals.items():
        runtime_by_key[sig_key(sig, sig.road)].append(sid)
    signal_map: dict[str, str] = {}
    taken_signals: set[str] = set()
    unpaired_source_signals: list[str] = []
    for sid, sig in sorted(source.signals.items()):
        options = [c for c in runtime_by_key.get(source_sig_key(sig), []) if c not in taken_signals]
        if len(options) >= 1:
            signal_map[sid] = sorted(options)[0]
            taken_signals.add(signal_map[sid])
        else:
            unpaired_source_signals.append(sid)
    unpaired_runtime_signals = sorted(set(runtime.signals) - set(signal_map.values()))
    dyn = lambda net, ids: sorted(i for i in ids if net.signals[i].dynamic)
    result.signals = {
        "source": len(source.signals), "runtime": len(runtime.signals),
        "sourceDynamic": len(source.dynamic_signal_ids), "runtimeDynamic": len(runtime.dynamic_signal_ids),
        "paired": len(signal_map), "renumbered": sum(1 for a, b in signal_map.items() if a != b),
        "unpairedSourceDynamic": dyn(source, unpaired_source_signals),
        "unpairedRuntimeDynamic": dyn(runtime, unpaired_runtime_signals),
        "unpairedSourceStatic": len(unpaired_source_signals) - len(dyn(source, unpaired_source_signals)),
        "unpairedRuntimeStatic": len(unpaired_runtime_signals) - len(dyn(runtime, unpaired_runtime_signals)),
    }
    result.signal_id_map = {
        a: b for a, b in sorted(signal_map.items()) if a != b and source.signals[a].dynamic
    }
    if result.signals["renumbered"]:
        result.differences.append(f"signal ids renumbered ({result.signals['renumbered']})")
    if result.signals["unpairedSourceStatic"] or result.signals["unpairedRuntimeStatic"]:
        result.differences.append(
            f"static signs differ ({result.signals['unpairedSourceStatic']} only in source, "
            f"{result.signals['unpairedRuntimeStatic']} only in the world)"
        )
    if result.signals["unpairedSourceDynamic"]:
        result.blocking.append(
            f"{len(result.signals['unpairedSourceDynamic'])} dynamic source signals have no counterpart in the world"
        )
    if result.signals["unpairedRuntimeDynamic"]:
        result.decision_required.append(
            f"the world has {len(result.signals['unpairedRuntimeDynamic'])} dynamic signals the source does not declare"
        )

    # ---- controllers --------------------------------------------------
    # Multisets: two controllers may drive the same set of heads.
    mapped_controllers = Counter(
        frozenset(signal_map.get(s, f"?{s}") for s in members) for members in source.controllers.values()
    )
    runtime_controllers = Counter(runtime.controllers.values())
    result.controllers = {
        "source": len(source.controllers), "runtime": len(runtime.controllers),
        "paired": sum((mapped_controllers & runtime_controllers).values()),
        "onlySource": sum((mapped_controllers - runtime_controllers).values()),
        "onlyRuntime": sum((runtime_controllers - mapped_controllers).values()),
    }
    # CARLA spawns a traffic-light actor only for a head some controller
    # drives. A dynamic head no controller owns has no actor to bind, so a
    # plan that drives it fails loudly in bind_signals; record which ones.
    controlled = set().union(*runtime.controllers.values()) if runtime.controllers else set()
    inverse = {v: k for k, v in signal_map.items()}
    uncontrolled = sorted(sid for sid in runtime.dynamic_signal_ids if sid not in controlled)
    result.signals["runtimeDynamicWithoutController"] = uncontrolled
    result.signals["sourceHeadsWithoutCarlaActor"] = sorted(inverse[s] for s in uncontrolled if s in inverse)
    if uncontrolled:
        result.differences.append(
            f"{len(uncontrolled)} dynamic heads have no signal controller (in the world and the source), so CARLA "
            "spawns no actor for them; a signal plan that drives them fails at bind_signals: "
            + ", ".join(f"{inverse.get(s, '?')}->{s}" for s in uncontrolled)
        )
    if result.controllers["onlySource"]:
        result.blocking.append(f"{result.controllers['onlySource']} source signal controllers are not in the world")
    if result.controllers["onlyRuntime"]:
        result.decision_required.append(
            f"the world has {result.controllers['onlyRuntime']} signal controllers the source does not declare"
        )

    # ---- objects (rendered from the cooked world, informational) --------
    only_source = source.objects - runtime.objects
    only_runtime = runtime.objects - source.objects
    result.objects = {
        "source": sum(source.objects.values()), "runtime": sum(runtime.objects.values()),
        "onlySource": sum(only_source.values()), "onlyRuntime": sum(only_runtime.values()),
    }
    if result.objects["onlySource"] or result.objects["onlyRuntime"]:
        result.differences.append(
            f"OpenDRIVE objects differ ({result.objects['source']} in source, {result.objects['runtime']} in the world); "
            "the world renders its own cooked meshes"
        )
    if result.header.get("sourceDate") != result.header.get("runtimeDate"):
        result.differences.append(
            f"export date {result.header.get('sourceDate')} vs cooked {result.header.get('runtimeDate')}"
        )
    return result
