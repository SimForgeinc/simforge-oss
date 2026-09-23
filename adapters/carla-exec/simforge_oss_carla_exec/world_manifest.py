"""The checked-in source-map -> cooked-CARLA-world manifest, and the binding
tables the runtime derives from it.

``assets/carla-world-manifest.json`` is GENERATED (``python -m
simforge_oss_carla_exec.world_manifest_tools generate``) from the NAS source
exports, the cooked engine image and the SimForge map registry. Nothing in it
is typed by hand except ``decisions`` inputs, and the runtime never keeps a
second copy: the cooked-world registry, the approved re-serialization digests
and the signal id remaps below are all read from it.

A source whose status is not bindable (``needs-recook``, ``needs-decision``,
``no-world``) is *known* to have no usable world. The runtime refuses it with
the manifest's own reason instead of trying a name or a generated world.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, Mapping

MANIFEST_PATH = Path(__file__).parent / "assets" / "carla-world-manifest.json"
SCHEMA = "simforge.carla-world-manifest/v1"
BINDABLE = frozenset({"exact", "approved-equivalent"})
STATUSES = frozenset({"exact", "approved-equivalent", "needs-decision", "needs-recook", "no-world"})


@dataclass(frozen=True)
class Binding:
    source_xodr_sha256: str
    world: str
    runtime_xodr_sha256: str
    signal_id_map: Mapping[str, str]
    origin: str  # "<sourceFolder>" or "legacy:<note>"


@dataclass(frozen=True)
class Refusal:
    source_xodr_sha256: str
    status: str
    world: str | None
    reason: str
    origin: str


def _is_sha(value: object) -> bool:
    return isinstance(value, str) and len(value) == 64 and all(c in "0123456789abcdef" for c in value)


def validate(manifest: Mapping[str, Any]) -> None:
    if manifest.get("schema") != SCHEMA:
        raise ValueError(f"CARLA world manifest schema must be {SCHEMA}")
    seen_sources: set[str] = set()
    bound_worlds: dict[str, str] = {}
    for entry in manifest.get("maps", []):
        status = entry.get("status")
        if status not in STATUSES:
            raise ValueError(f"{entry.get('sourceFolder')}: unknown status {status!r}")
        xodr = entry.get("xodr") or {}
        sha = xodr.get("sha256")
        if sha is None:
            if status != "no-world":
                raise ValueError(f"{entry.get('sourceFolder')}: only a no-world entry may lack an XODR")
            continue
        if not _is_sha(sha):
            raise ValueError(f"{entry.get('sourceFolder')}: xodr sha256 is malformed")
        if sha in seen_sources:
            raise ValueError(f"source XODR {sha} appears in two manifest entries")
        seen_sources.add(sha)
        if status in BINDABLE:
            world = entry.get("carlaWorld")
            if not isinstance(world, str) or not world or not _is_sha(entry.get("cookedXodrSha256")):
                raise ValueError(f"{entry['sourceFolder']}: a bindable entry needs carlaWorld and cookedXodrSha256")
            if status == "exact" and entry["cookedXodrSha256"] != sha:
                raise ValueError(f"{entry['sourceFolder']}: exact entry whose cooked digest differs")
            if world in bound_worlds:
                raise ValueError(f"world {world} is bound by {bound_worlds[world]} and {entry['sourceFolder']}")
            bound_worlds[world] = entry["sourceFolder"]
            signal_map = entry.get("signalIdMap", {})
            if len(set(signal_map.values())) != len(signal_map):
                raise ValueError(f"{entry['sourceFolder']}: signal id map is not one-to-one")
        elif entry.get("signalIdMap"):
            raise ValueError(f"{entry['sourceFolder']}: an unbound entry must not carry a signal id map")
    for legacy in manifest.get("legacySources", []):
        if not (_is_sha(legacy.get("sourceXodrSha256")) and _is_sha(legacy.get("cookedXodrSha256"))
                and isinstance(legacy.get("carlaWorld"), str) and legacy.get("note")):
            raise ValueError("legacy source entries need sourceXodrSha256, cookedXodrSha256, carlaWorld and note")
        if legacy["sourceXodrSha256"] in seen_sources:
            raise ValueError(f"legacy source {legacy['sourceXodrSha256']} is also a current source")
        seen_sources.add(legacy["sourceXodrSha256"])


@lru_cache(maxsize=4)
def load(path: str | None = None) -> Mapping[str, Any]:
    manifest = json.loads(Path(path or MANIFEST_PATH).read_text())
    validate(manifest)
    return manifest


def bindings(manifest: Mapping[str, Any] | None = None) -> dict[str, Binding]:
    m = manifest if manifest is not None else load()
    out: dict[str, Binding] = {}
    for entry in m.get("maps", []):
        if entry["status"] in BINDABLE:
            sha = entry["xodr"]["sha256"]
            out[sha] = Binding(sha, entry["carlaWorld"], entry["cookedXodrSha256"],
                               dict(entry.get("signalIdMap", {})), entry["sourceFolder"])
    for legacy in m.get("legacySources", []):
        sha = legacy["sourceXodrSha256"]
        out[sha] = Binding(sha, legacy["carlaWorld"], legacy["cookedXodrSha256"],
                           dict(legacy.get("signalIdMap", {})), f"legacy:{legacy['note']}")
    return out


def refusals(manifest: Mapping[str, Any] | None = None) -> dict[str, Refusal]:
    m = manifest if manifest is not None else load()
    out: dict[str, Refusal] = {}
    for entry in m.get("maps", []):
        sha = (entry.get("xodr") or {}).get("sha256")
        if sha is None or entry["status"] in BINDABLE:
            continue
        reasons = list(entry.get("blocking", [])) + list(entry.get("decisionRequired", []))
        if entry.get("hold"):
            reasons.insert(0, str(entry["hold"]))
        if entry.get("reason"):
            reasons.insert(0, str(entry["reason"]))
        out[sha] = Refusal(sha, entry["status"], entry.get("carlaWorld"),
                           "; ".join(reasons) or entry["status"], entry["sourceFolder"])
    return out


def cooked_map_names(manifest: Mapping[str, Any] | None = None) -> dict[str, str]:
    """source XODR sha256 -> cooked world (the COOKED_MAPS registry)."""
    return {sha: b.world for sha, b in bindings(manifest).items()}


def approved_cooked_digests(manifest: Mapping[str, Any] | None = None) -> dict[str, frozenset[str]]:
    """source XODR sha256 -> approved runtime XODR sha256s (the approved pairs)."""
    return {
        sha: frozenset({b.runtime_xodr_sha256})
        for sha, b in bindings(manifest).items() if b.runtime_xodr_sha256 != sha
    }


def signal_id_maps(manifest: Mapping[str, Any] | None = None) -> dict[tuple[str, str, str], Mapping[str, str]]:
    return {
        (b.world, sha, b.runtime_xodr_sha256): b.signal_id_map
        for sha, b in bindings(manifest).items() if b.signal_id_map
    }


def env_values(manifest: Mapping[str, Any] | None = None) -> dict[str, str]:
    """The legacy env-var encodings, for workers that predate the manifest."""
    names: dict[str, str] = {}
    for sha, world in sorted(cooked_map_names(manifest).items()):
        if world in names:
            # The env format keys by world name, so it can carry one source per world.
            continue
        names[world] = sha
    return {
        "SIMFORGE_CARLA_COOKED_MAPS_JSON": json.dumps(dict(sorted(names.items())), separators=(",", ":")),
        "SIMFORGE_CARLA_APPROVED_COOKED_XODR_JSON": json.dumps(
            {sha: sorted(v) for sha, v in sorted(approved_cooked_digests(manifest).items())}, separators=(",", ":")
        ),
    }
