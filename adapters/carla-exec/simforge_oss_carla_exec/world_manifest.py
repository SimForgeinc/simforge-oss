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
    origin: str  # the source folder, else legacy:<note>
    unowned_signal_ids: frozenset[str] = frozenset()


@dataclass(frozen=True)
class Refusal:
    source_xodr_sha256: str
    status: str
    world: str | None
    reason: str
    origin: str


def _is_sha(value: object) -> bool:
    return isinstance(value, str) and len(value) == 64 and all(c in "0123456789abcdef" for c in value)


#: Every key a generated manifest carries on every map entry and legacy source.
#: The generator writes empty values explicitly, so a missing key is a malformed
#: manifest and fails here, never a default.
MAP_ENTRY_KEYS = ("sourceFolder", "status", "xodr", "carlaWorld", "signalIdMap", "unownedCookedSignalIds",
                  "blocking", "decisionRequired", "reason", "hold")
LEGACY_KEYS = ("sourceXodrSha256", "cookedXodrSha256", "carlaWorld", "note", "signalIdMap", "unownedCookedSignalIds")


def _require(record: Mapping[str, Any], keys: tuple[str, ...], label: str) -> None:
    missing = [key for key in keys if key not in record]
    if missing:
        raise ValueError(f"CARLA world manifest {label} lacks required key(s): {', '.join(missing)}")


def validate(manifest: Mapping[str, Any]) -> None:
    _require(manifest, ("schema", "maps", "legacySources"), "document")
    if manifest["schema"] != SCHEMA:
        raise ValueError(f"CARLA world manifest schema must be {SCHEMA}")
    seen_sources: set[str] = set()
    bound_worlds: dict[str, str] = {}
    by_source = {entry["xodr"]["sha256"]: entry for entry in manifest["maps"] if entry.get("xodr")}
    for entry in manifest["maps"]:
        _require(entry, MAP_ENTRY_KEYS, f"entry {entry.get('sourceFolder')!r}")
        folder, status = entry["sourceFolder"], entry["status"]
        if status not in STATUSES:
            raise ValueError(f"{folder}: unknown status {status!r}")
        if entry["xodr"] is None:
            if status != "no-world":
                raise ValueError(f"{folder}: only a no-world entry may lack an XODR")
            continue
        sha = entry["xodr"]["sha256"]
        if not _is_sha(sha):
            raise ValueError(f"{folder}: xodr sha256 is malformed")
        if sha in seen_sources:
            raise ValueError(f"source XODR {sha} appears in two manifest entries")
        seen_sources.add(sha)
        if status in BINDABLE:
            world = entry["carlaWorld"]
            if not isinstance(world, str) or not world or not _is_sha(entry.get("cookedXodrSha256")):
                raise ValueError(f"{folder}: a bindable entry needs carlaWorld and cookedXodrSha256")
            if status == "exact" and entry["cookedXodrSha256"] != sha:
                raise ValueError(f"{folder}: exact entry whose cooked digest differs")
            if "derivedFrom" in entry:
                # A refit binds its original's world; the original must bind it too.
                origin = by_source.get(entry["derivedFrom"])  # fallback-ok: None is the error case, raised below
                if origin is None or origin["carlaWorld"] != world or origin.get("cookedXodrSha256") != entry["cookedXodrSha256"]:
                    raise ValueError(f"{folder}: a derived source must bind its original's world")
            else:
                if world in bound_worlds:
                    raise ValueError(f"world {world} is bound by {bound_worlds[world]} and {folder}")
                bound_worlds[world] = folder
            signal_map = entry["signalIdMap"]
            if len(set(signal_map.values())) != len(signal_map):
                raise ValueError(f"{folder}: signal id map is not one-to-one")
        else:
            if entry["signalIdMap"] or entry["unownedCookedSignalIds"]:
                raise ValueError(f"{folder}: an unbound entry must not carry signal bindings")
            if not (entry["reason"] or entry["hold"] or entry["blocking"] or entry["decisionRequired"]):
                raise ValueError(f"{folder}: an unbound entry must state why it is unbound")
    for legacy in manifest["legacySources"]:
        _require(legacy, LEGACY_KEYS, "legacy source")
        if not (_is_sha(legacy["sourceXodrSha256"]) and _is_sha(legacy["cookedXodrSha256"])
                and isinstance(legacy["carlaWorld"], str) and legacy["note"]):
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
    for entry in m["maps"]:
        if entry["status"] in BINDABLE:
            sha = entry["xodr"]["sha256"]
            out[sha] = Binding(sha, entry["carlaWorld"], entry["cookedXodrSha256"],
                               dict(entry["signalIdMap"]), entry["sourceFolder"],
                               frozenset(entry["unownedCookedSignalIds"]))
    for legacy in m["legacySources"]:
        sha = legacy["sourceXodrSha256"]
        out[sha] = Binding(sha, legacy["carlaWorld"], legacy["cookedXodrSha256"],
                           dict(legacy["signalIdMap"]), f"legacy:{legacy['note']}",
                           frozenset(legacy["unownedCookedSignalIds"]))
    return out


def refusals(manifest: Mapping[str, Any] | None = None) -> dict[str, Refusal]:
    m = manifest if manifest is not None else load()
    out: dict[str, Refusal] = {}
    for entry in m["maps"]:
        if entry["xodr"] is None or entry["status"] in BINDABLE:
            continue
        sha = entry["xodr"]["sha256"]
        reasons = [str(item) for item in (entry["reason"], entry["hold"]) if item]
        reasons += [str(item) for item in [*entry["blocking"], *entry["decisionRequired"]]]
        out[sha] = Refusal(sha, entry["status"], entry["carlaWorld"], "; ".join(reasons), entry["sourceFolder"])
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


def unowned_cooked_signals(manifest: Mapping[str, Any] | None = None) -> dict[tuple[str, str, str], frozenset[str]]:
    """(world, source sha256, runtime sha256) -> heads the world ships beyond the source."""
    return {
        (b.world, sha, b.runtime_xodr_sha256): b.unowned_signal_ids
        for sha, b in bindings(manifest).items() if b.unowned_signal_ids
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
