"""Generate the source-map -> cooked-CARLA-world manifest.

One entry per NAS source folder. The world is found automatically: the cooked
world whose OpenDRIVE shares the source's geoReference and covers the same
header bounds, then the two road networks are compared (``xodr_identity``).
The status is derived, never typed:

``exact``                the cooked world's OpenDRIVE is the source XODR byte for byte
``approved-equivalent``  same road network within the parity tolerance; ids may be
                         renumbered (the signal id map is recorded) and non-road data
                         (objects, static signs, export date) may differ, all listed
``needs-decision``       same roads, but the world and the source disagree on something a
                         human must rule on (e.g. the export dropped the signal controllers
                         the world was cooked with); unbound until ``decisions`` accepts it
``needs-recook``         the road network changed; the world must be re-cooked
``no-world``             no cooked world covers this source

Only ``exact`` and ``approved-equivalent`` entries are bindable.
"""
from __future__ import annotations

import json
import re
from dataclasses import asdict
from pathlib import Path
from typing import Any

from . import xodr_identity

SCHEMA = "simforge.carla-world-manifest/v1"
BINDABLE = ("exact", "approved-equivalent")
_GEO = re.compile(rb"<geoReference>\s*<!\[CDATA\[(.*?)\]\]>\s*</geoReference>|<geoReference>(.*?)</geoReference>", re.S)
_HEADER = re.compile(rb"<header\b[^>]*>", re.S)
_ATTR = re.compile(rb'(\w+)="([^"]*)"')


def header_identity(data: bytes) -> dict[str, Any]:
    head = data[:65536]
    header = _HEADER.search(head)
    attrs = {k.decode(): v.decode() for k, v in _ATTR.findall(header.group(0))} if header else {}
    geo = _GEO.search(head)
    geo_text = (geo.group(1) or geo.group(2) or b"").decode().strip() if geo else ""
    bounds = {k: float(attrs[k]) for k in ("north", "south", "east", "west") if k in attrs}
    return {"geoReference": geo_text, "bounds": bounds, "date": attrs.get("date")}


def _iou(a: dict[str, float], b: dict[str, float]) -> float:
    if len(a) != 4 or len(b) != 4:
        return 0.0
    w = min(a["east"], b["east"]) - max(a["west"], b["west"])
    h = min(a["north"], b["north"]) - max(a["south"], b["south"])
    if w <= 0 or h <= 0:
        return 0.0
    inter = w * h
    area = lambda r: (r["east"] - r["west"]) * (r["north"] - r["south"])
    return inter / (area(a) + area(b) - inter)


def _stem(name: str) -> str:
    stem = name.rsplit(".", 1)[0]
    return re.sub(r"_GLB$", "", stem, flags=re.I).lower()


def _pick_primary(folder: str, files: list[dict], decision: dict) -> tuple[dict | None, dict | None, list[dict]]:
    glbs = [f for f in files if f["name"].lower().endswith(".glb")]
    xodrs = [f for f in files if f["name"].lower().endswith(".xodr")]
    if len(glbs) > 1:
        raise ValueError(f"{folder}: more than one GLB; the manifest maps one source to one world")
    glb = glbs[0] if glbs else None
    primary = None
    if decision.get("primaryXodr"):
        primary = next((f for f in xodrs if f["name"] == decision["primaryXodr"]), None)
        if primary is None:
            raise ValueError(f"{folder}: decisions name primaryXodr {decision['primaryXodr']} which is absent")
    elif len(xodrs) == 1:
        primary = xodrs[0]
    elif glb is not None:
        matching = [f for f in xodrs if _stem(f["name"]) == _stem(glb["name"])]
        primary = matching[0] if len(matching) == 1 else None
    if xodrs and primary is None:
        raise ValueError(f"{folder}: several XODRs and none matches the GLB; record primaryXodr in decisions")
    extras = [f for f in files if f is not glb and f is not primary]
    return glb, primary, extras


def _simforge_index(envs: dict[str, dict]) -> dict[str, dict[str, Any]]:
    """xodr sha256 -> env -> map asset summary."""
    out: dict[str, dict[str, Any]] = {}
    for env, doc in sorted(envs.items()):
        for asset in doc.get("mapAssets", []):
            for version in asset.get("mapVersions", []):
                slot = out.setdefault(version["xodrSha256"], {}).setdefault(env, {
                    "mapAssetId": asset["id"], "label": asset.get("label"),
                    "carlaMapName": asset.get("carlaMapName"),
                    "ue5CarlaMapName": asset.get("ue5CarlaMapName"),
                    "mapVersions": [],
                })
                if slot["mapAssetId"] != asset["id"]:
                    raise ValueError(f"{env}: xodr {version['xodrSha256']} belongs to two map assets")
                slot["mapVersions"].append({k: version.get(k) for k in ("id", "createdAt", "retiredAt", "dependents")})
    for per_env in out.values():
        for slot in per_env.values():
            slot["mapVersions"].sort(key=lambda v: (v.get("createdAt") or "", v["id"]))
    return out


def generate(inputs: Path, decisions: dict[str, dict], legacy: list[dict] | None = None) -> dict:
    nas = json.loads((inputs / "nas.json").read_text())
    cooked = json.loads((inputs / "cooked.json").read_text())
    envs = {
        p.stem[len("simforge-"):]: json.loads(p.read_text())
        for p in sorted(inputs.glob("simforge-*.json"))
    }
    simforge = _simforge_index(envs)

    world_headers = {}
    for world in cooked["worlds"]:
        data = (inputs / "cooked" / f"{world}.xodr").read_bytes()
        world_headers[world] = header_identity(data)
    parsed_worlds: dict[str, xodr_identity.Network] = {}

    by_folder: dict[str, list[dict]] = {}
    for f in nas["files"]:
        by_folder.setdefault(f["folder"], []).append(f)

    primaries = {}
    picked = {}
    for folder, files in sorted(by_folder.items()):
        picked[folder] = _pick_primary(folder, files, decisions.get(folder, {}))
        if picked[folder][1] is not None:
            primaries[picked[folder][1]["sha256"]] = f"{folder}/{picked[folder][1]['name']}"

    entries = []
    claimed: dict[str, str] = {}
    for folder, (glb, primary, extras) in sorted(picked.items()):
        decision = decisions.get(folder, {})
        entry: dict[str, Any] = {
            "sourceFolder": folder,
            "glb": {k: glb[k] for k in ("name", "sha256", "bytes", "mtime")} if glb else None,
            "xodr": {k: primary[k] for k in ("name", "sha256", "bytes", "mtime")} if primary else None,
            "extraFiles": [],
        }
        for extra in extras:
            item = {k: extra[k] for k in ("name", "sha256", "bytes", "mtime")}
            dup = primaries.get(extra["sha256"])
            if dup and not dup.startswith(folder + "/"):
                item["duplicateOf"] = dup
            entry["extraFiles"].append(item)
        if primary is None:
            entry.update(status="no-world", carlaWorld=None, reason="source folder has no XODR")
            entries.append(entry)
            continue
        source_bytes = (inputs / "nas" / folder / primary["name"]).read_bytes()
        source_header = header_identity(source_bytes)
        entry["xodr"]["exportDate"] = source_header["date"]
        entry["xodr"]["geoReference"] = source_header["geoReference"]
        entry["simforge"] = simforge.get(primary["sha256"], {})

        world = decision.get("world")
        if world is None:
            scored = sorted(
                ((round(_iou(source_header["bounds"], h["bounds"]), 6), w)
                 for w, h in world_headers.items() if h["geoReference"] == source_header["geoReference"]),
                reverse=True,
            )
            if scored and scored[0][0] >= 0.5 and (len(scored) == 1 or scored[1][0] < scored[0][0]):
                world = scored[0][1]
            entry["worldMatch"] = {"method": "geoReference+headerBoundsIoU",
                                   "candidates": [{"world": w, "iou": s} for s, w in scored[:3] if s > 0]}
        else:
            entry["worldMatch"] = {"method": "decision"}
        if world is None:
            entry.update(status="no-world", carlaWorld=None,
                         reason="no cooked world shares this source's geoReference and extent")
            entries.append(entry)
            continue
        if world not in parsed_worlds:
            parsed_worlds[world] = xodr_identity.parse((inputs / "cooked" / f"{world}.xodr").read_bytes())
        comparison = xodr_identity.compare(xodr_identity.parse(source_bytes), parsed_worlds[world])
        entry["carlaWorld"] = world
        entry["cookedXodrSha256"] = comparison.runtime_sha256
        if comparison.byte_exact:
            status = "exact"
        elif comparison.geometry_equivalent and not comparison.blocking:
            accepted = decision.get("acceptDecisionItems", [])
            open_items = [item for item in comparison.decision_required if item not in accepted]
            status = "needs-decision" if open_items else "approved-equivalent"
        else:
            status = "needs-recook"
        if decision.get("hold"):
            status = "needs-decision"
            entry["hold"] = decision["hold"]
        entry["status"] = status
        summary = asdict(comparison)
        entry["comparison"] = {k: summary[k] for k in ("roads", "signals", "controllers", "objects", "header")}
        entry["differences"] = comparison.differences
        entry["blocking"] = comparison.blocking
        entry["decisionRequired"] = comparison.decision_required
        entry["signalIdMap"] = comparison.signal_id_map if status in BINDABLE else {}
        if status in BINDABLE and comparison.signals.get("nonPhysicalGateRuntimeIds"):
            entry["unownedCookedSignalIds"] = comparison.signals["nonPhysicalGateRuntimeIds"]
        if status in BINDABLE:
            if world in claimed:
                raise ValueError(f"world {world} is bound by both {claimed[world]} and {folder}")
            claimed[world] = folder
        entries.append(entry)

    worlds = {
        w: {"xodrSha256": cooked["worlds"][w]["xodrSha256"],
            "boundSource": claimed.get(w),
            "matchedSources": sorted(e["sourceFolder"] for e in entries if e.get("carlaWorld") == w)}
        for w in sorted(cooked["worlds"])
    }
    return {
        "schema": SCHEMA,
        "tolerance": {"positionM": xodr_identity.GEOMETRY_TOLERANCE,
                      "headingDeg": round(xodr_identity.HEADING_TOLERANCE * 180 / 3.141592653589793, 6)},
        "source": {"root": nas["root"]},
        "cookedImage": {k: cooked[k] for k in ("image", "imageId", "repoDigests", "engineBinarySha256", "version")},
        "maps": entries,
        "worlds": worlds,
        "legacySources": legacy or [],
    }


def dump(manifest: dict) -> str:
    return json.dumps(manifest, indent=1, sort_keys=True) + "\n"
