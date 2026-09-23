"""The CARLA actor binding table: catalog entry id -> CARLA blueprint.

A document's asset-catalog pin describes its actors for the SIMULATION (dims,
kinds, models). Which CARLA blueprint renders each catalog entry is RENDERER
ADAPTER configuration, so it lives here, next to the world manifest, and not
in the pinned catalog: re-pinning thousands of documents to change a
renderer mapping would be wrong.

``assets/carla-actor-bindings.json`` is GENERATED (``python -m
simforge_oss_carla_exec.world_manifest_tools actor-bindings``) from SimCloud's
``config/simforge/carla/carla-object-catalog.json`` (inventory-verified CARLA
equivalents and native CARLA objects) plus the renderer-parity table
``catalog/vehicles-carla/carla-substitutions.json`` where present. It is
content-addressed: its sha256 is recorded in every render manifest
(``inputs.actorBindings``), and the worker image digest pins the file.

Resolution (``resolve``): a catalog entry's own CARLA binding, when it has one,
must name the same blueprint as the table (its fidelity stands); otherwise the table binds it. An entry the table
lists as unavailable, or does not list at all, gets no binding, so the render
fails by name (``carla_blueprint_unavailable``) unless the render intent
allows the recorded ``carla-actor-body`` substitution.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, Mapping

from .runtime.contract import ContractError

TABLE_PATH = Path(__file__).parent / "assets" / "carla-actor-bindings.json"
SCHEMA = "simforge.carla-actor-bindings/v1"
FIDELITIES = frozenset({"exact", "native-blueprint", "semantic-substitute"})


@dataclass(frozen=True)
class ActorBindingTable:
    sha256: str
    bindings: Mapping[str, Mapping[str, Any]]
    unavailable: Mapping[str, str]
    source: Mapping[str, Any]

    def evidence(self) -> dict[str, Any]:
        return {"schema": SCHEMA, "sha256": self.sha256, "entries": len(self.bindings),
                "unavailable": len(self.unavailable), "source": dict(self.source)}


def parse(body: bytes) -> ActorBindingTable:
    try:
        value = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ContractError("CARLA actor binding table must be UTF-8 JSON") from exc
    if not isinstance(value, Mapping) or value.get("schema") != SCHEMA:
        raise ContractError(f"CARLA actor binding table schema must be {SCHEMA}")
    bindings = value.get("bindings")
    unavailable = value.get("unavailable")
    if not isinstance(bindings, Mapping) or not isinstance(unavailable, Mapping):
        raise ContractError("CARLA actor binding table needs bindings and unavailable objects")
    for catalog_id, binding in bindings.items():
        if (
            not isinstance(binding, Mapping)
            or not isinstance(binding.get("blueprintId"), str) or not binding["blueprintId"]
            or binding.get("fidelity") not in FIDELITIES
            or not isinstance(binding.get("actorClass"), str) or not binding["actorClass"]
        ):
            raise ContractError(f"CARLA actor binding for {catalog_id} needs blueprintId, fidelity and actorClass")
        if catalog_id in unavailable:
            raise ContractError(f"CARLA actor binding table both binds and marks unavailable {catalog_id}")
    if any(not isinstance(reason, str) or not reason for reason in unavailable.values()):
        raise ContractError("CARLA actor binding table unavailable reasons must be non-empty strings")
    if not isinstance(value.get("source"), Mapping):
        raise ContractError("CARLA actor binding table needs its source provenance")
    return ActorBindingTable(hashlib.sha256(body).hexdigest(), dict(bindings), dict(unavailable), dict(value["source"]))


@lru_cache(maxsize=2)
def load(path: str | None = None) -> ActorBindingTable:
    return parse(Path(path or TABLE_PATH).read_bytes())


def resolve(asset_id: str, catalog_binding: Mapping[str, Any], table: ActorBindingTable) -> dict[str, Any]:
    """Fold the table's binding into one indexed catalog entry (see module doc)."""
    indexed = dict(catalog_binding)
    bound = table.bindings.get(asset_id)
    declared = indexed.get("blueprintId")
    if isinstance(declared, str) and declared:
        # The catalog's own binding (and its fidelity, which may be stricter)
        # stands; a different BODY for the same entry is a conflict.
        if bound is not None and bound["blueprintId"] != declared:
            from .runtime.policy import CarlaRenderError

            raise CarlaRenderError(
                "carla_actor_binding_conflict",
                f"asset catalog entry {asset_id} binds CARLA {declared} ({indexed.get('fidelity')}) but the "
                f"actor binding table {table.sha256[:12]} binds {bound['blueprintId']} ({bound['fidelity']})",
            )
        indexed["bindingSource"] = "asset-catalog"
        return indexed
    if bound is not None:
        indexed["blueprintId"] = bound["blueprintId"]
        indexed["fidelity"] = bound["fidelity"]
        indexed.setdefault("actorClass", bound["actorClass"])
        indexed["bindingSource"] = "carla-actor-bindings"
        return indexed
    reason = table.unavailable.get(asset_id)
    indexed["bindingSource"] = "none"
    indexed["unavailableReason"] = reason or f"the CARLA actor binding table {table.sha256[:12]} has no binding"
    return indexed


def generate(object_catalog: Mapping[str, Any], object_catalog_sha256: str,
             substitutions: Mapping[str, Any] | None = None, substitutions_sha256: str | None = None) -> dict[str, Any]:
    """Build the table from SimCloud's carla-object-catalog.json (+ parity substitutions)."""
    if object_catalog.get("contractVersion") != "simcloud.carla-object-catalog/v1":
        raise ValueError("expected a simcloud.carla-object-catalog/v1 document")
    objects = {entry["id"]: entry for entry in object_catalog["objects"]}

    def actor_class_of(blueprint: str, carla_object_id: str | None) -> str:
        if blueprint.startswith("walker."):
            return "pedestrian"
        obj = objects.get(carla_object_id) if carla_object_id else None
        if obj and isinstance(obj.get("actorClass"), str):
            return obj["actorClass"]
        raise ValueError(f"no actorClass for CARLA blueprint {blueprint}")

    bindings: dict[str, dict[str, Any]] = {}
    for obj in object_catalog["objects"]:
        carla = obj["carla"] if isinstance(obj.get("carla"), Mapping) else None
        if carla is not None and carla.get("blueprintId"):
            bindings[obj["id"]] = {
                "blueprintId": carla["blueprintId"], "fidelity": "exact",
                "actorClass": obj.get("actorClass") or actor_class_of(carla["blueprintId"], obj["id"]),
                "dimensionalAgreement": "exact", "origin": "carla-object",
            }
    for eq in object_catalog["equivalents"]:
        bindings[eq["catalogId"]] = {
            "blueprintId": eq["blueprintId"], "fidelity": eq["fidelity"],
            "actorClass": actor_class_of(eq["blueprintId"], eq.get("carlaObjectId")),
            "dimensionalAgreement": eq.get("dimensionalAgreement"),
            **({"carlaDims": eq["carlaDims"]} if eq.get("carlaDims") else {}),
            "origin": "equivalent",
        }
    unavailable = {item["catalogId"]: item["reason"] for item in object_catalog["unavailable"]}
    parity: dict[str, Any] = {}
    parity_table = substitutions["substitutions"] if substitutions is not None else {}  # fallback-ok: the parity table is an optional generator input
    for catalog_id, sub in parity_table.items():
        if "carla" not in sub or not sub.get("reason"):
            raise ValueError(f"carla-substitutions.json entry {catalog_id} needs carla and reason")
        carla_bp = sub["carla"]
        if carla_bp is None:
            bindings.pop(catalog_id, None)  # fallback-ok: removing an absent binding is a no-op, not a default
            unavailable[catalog_id] = f"renderer parity: {sub['reason']}"
        elif catalog_id in bindings and bindings[catalog_id]["blueprintId"] != carla_bp:
            raise ValueError(
                f"carla-substitutions.json binds {catalog_id} to {carla_bp} but the object catalog binds "
                f"{bindings[catalog_id]['blueprintId']}"
            )
        parity[catalog_id] = sub["reason"]
    for catalog_id in list(unavailable):
        if catalog_id in bindings:
            raise ValueError(f"{catalog_id} is both bound and unavailable in the CARLA object catalog")
    return {
        "schema": SCHEMA,
        "source": {
            "objectCatalog": {"sha256": object_catalog_sha256, "carlaVersion": object_catalog.get("carlaVersion"),
                              "generatedFrom": object_catalog.get("generatedFrom")},
            "paritySubstitutions": {"sha256": substitutions_sha256, "entries": len(parity)} if substitutions else None,
        },
        "bindings": dict(sorted(bindings.items())),
        "unavailable": dict(sorted(unavailable.items())),
    }
