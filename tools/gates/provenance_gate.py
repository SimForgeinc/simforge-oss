#!/usr/bin/env python3
"""Deterministic post-simulation attribution gate for training labels."""
from __future__ import annotations

import gzip
import json
import math
import re
from pathlib import Path

SCHEMA = "simforge.provenance-verdict/v1"
WINDOW_RADIUS_S = 0.5


def _finite(value):
    return isinstance(value, (int, float)) and math.isfinite(value)


def extract_critical_event(trace):
    """Return the strongest recorded conflict and its participating actors."""
    metrics = trace.get("metrics") or {}
    collisions = [row for row in metrics.get("collisions", []) if _finite(row.get("t"))]
    if collisions:
        row = min(collisions, key=lambda item: item["t"])
        pair = row.get("pair") or [row.get("actorA"), row.get("actorB")]
        return {"kind": "collision", "t": row["t"], "value": 0.0,
                "actors": [str(actor) for actor in pair if actor]}

    candidates = []
    for key, kind, field in (("minTTC", "min-ttc", "value"),
                             ("minPathTTC", "min-path-ttc", "value")):
        row = metrics.get(key)
        if isinstance(row, dict) and _finite(row.get("t")) and _finite(row.get(field)):
            candidates.append((float(row[field]), 0, {"kind": kind, "t": row["t"],
                "value": row[field], "actors": [str(actor) for actor in row.get("pair", [])]}))
    for row in metrics.get("minDistance", []):
        if _finite(row.get("t")) and _finite(row.get("minDistanceM")):
            candidates.append((float(row["minDistanceM"]), 1, {"kind": "min-distance",
                "t": row["t"], "value": row["minDistanceM"],
                "actors": [str(actor) for actor in row.get("pair", [])]}))
    if not candidates:
        return None
    # Prefer TTC evidence when available; within a metric, choose its minimum.
    candidates.sort(key=lambda item: (item[1], item[0], item[2]["t"]))
    return candidates[0][2]


def designated_hazard_actors(brief, instance):
    """Resolve explicit hazard ids, falling back to exact actor-role mentions in the brief."""
    explicit = brief.get("hazardActorIds") or (brief.get("provenance") or {}).get("hazardActorIds")
    if explicit:
        return sorted({str(actor) for actor in explicit})
    text = f"{brief.get('id', '')} {brief.get('brief', '')}".lower()
    scenario = instance.get("input", {})
    actors = scenario.get("actors", [])
    interacting = {str(row.get("actorId")) for row in scenario.get("interactions", [])
                   if row.get("actorId")}
    for criterion in scenario.get("nearMissCriteria", []):
        interacting.update(str(value) for key, value in criterion.items()
                           if key.endswith("Id") and value and value != "ego")
    kind_aliases = {
        "car": {"car", "vehicle", "sedan", "suv"},
        "bicycle": {"bicycle", "cyclist", "bike"},
        "motorcycle": {"motorcycle", "motorbike", "rider"},
        "pedestrian": {"pedestrian", "person", "child"},
    }
    matched = []
    for actor in actors:
        actor_id = str(actor.get("id", ""))
        if actor_id == "ego" or actor_id.startswith("ambient:"):
            continue
        aliases = {actor_id.lower().replace("_", " ")}
        aliases.update(kind_aliases.get(str(actor.get("kind", "")).lower(),
                                        {str(actor.get("kind", "")).lower()}))
        aliases.update(str(tag).split(":", 1)[-1].lower().replace("_", " ")
                       for tag in actor.get("tags", []) if str(tag).startswith(("role:", "class:")))
        if any(alias and re.search(r"\b" + re.escape(alias) + r"s?\b", text) for alias in aliases):
            matched.append(actor_id)
    active = [actor_id for actor_id in matched if actor_id in interacting]
    return sorted(set(active or matched))


def required_preconditions(brief):
    """Extract only conditions that have deterministic trace evidence."""
    explicit = (brief.get("provenance") or {}).get("preconditions")
    if explicit is not None:
        return sorted({str(value) for value in explicit})
    text = f"{brief.get('id', '')} {brief.get('brief', '')}".lower()
    required = []
    if re.search(r"\b(occlud|hidden|blocked view|emerges? (?:from|between|behind))", text):
        required.append("occlusion")
    if re.search(r"\b(ice|icy|snow|water|wet|flood|gravel|sand|oil|low.grip|slipper)", text):
        required.append("reduced-friction")
    if re.search(r"\b(fog|smoke|poor visibility|limited visibility)", text):
        required.append("limited-visibility")
    return required


def verify_preconditions(trace, instance, brief, event, radius_s=WINDOW_RADIUS_S):
    """Verify each named cause from recorded state at the critical window."""
    header = trace.get("header") or {}
    metrics = trace.get("metrics") or {}
    conditions = header.get("operationalConditions") or {}
    effects = conditions.get("effects") or {}
    hazard_ids = set(designated_hazard_actors(brief, instance))
    checks = []
    for name in required_preconditions(brief):
        if name == "reduced-friction":
            scale = effects.get("frictionScale")
            active = _finite(scale) and scale < 1.0
            evidence = {"frictionScale": scale, "weather": conditions.get("weather")}
        elif name == "limited-visibility":
            distance = effects.get("visibilityRangeM")
            visibility = str(conditions.get("visibility", "")).lower()
            active = (_finite(distance) and distance < 1000) or visibility not in ("", "unrestricted", "clear")
            evidence = {"visibilityRangeM": distance, "visibility": conditions.get("visibility")}
        elif name == "occlusion":
            rows = metrics.get("declaredOcclusion") or []
            near = []
            for row in rows:
                times = [row.get(key) for key in ("t", "startT", "endT") if _finite(row.get(key))]
                pair = set(str(actor) for actor in (row.get("pair") or
                           [row.get("observerId"), row.get("targetId")]) if actor)
                if times and min(abs(float(t) - float(event["t"])) for t in times) <= radius_s and (not hazard_ids or pair & hazard_ids):
                    near.append(row)
            active = bool(near)
            evidence = {"window": [event["t"] - radius_s, event["t"] + radius_s],
                        "matchingSamples": len(near)}
        else:
            active, evidence = False, {"unsupportedPrecondition": name}
        checks.append({"name": name, "held": bool(active), "evidence": evidence})
    return checks


def check_provenance(trace, instance, brief):
    reasons = []
    profile = ((trace.get("header") or {}).get("ego") or {}).get("controllerProfile")
    if profile is None:
        reasons.append({"code": "controller-profile-missing", "detail": "trace.header.ego.controllerProfile is required"})
    elif profile != "sensor-limited":
        reasons.append({"code": "controller-profile-untrusted", "detail": f"controller profile {profile!r} is not admissible"})

    event = extract_critical_event(trace)
    hazards = designated_hazard_actors(brief, instance)
    instance_actor_ids = {str(actor.get("id")) for actor in
                          instance.get("input", {}).get("actors", [])}
    absent_from_instance = sorted(set(hazards) - instance_actor_ids)
    if absent_from_instance:
        reasons.append({"code": "designated-hazard-missing",
                        "detail": "designated hazard actor is absent from the executable instance",
                        "missingHazardActorIds": absent_from_instance})
    if event is None:
        reasons.append({"code": "critical-event-missing", "detail": "trace has no collision, TTC, path-TTC, or distance event"})
    elif not hazards:
        reasons.append({"code": "hazard-actors-undesignated", "detail": "brief does not identify a hazard actor"})
    else:
        participants = set(event["actors"])
        missing = sorted(set(hazards) - participants)
        if missing:
            reasons.append({"code": "critical-event-wrong-actors", "detail": "critical event is attributable to actors outside the designated hazard", "expectedHazardActorIds": hazards, "criticalActorIds": event["actors"]})

    checks = verify_preconditions(trace, instance, brief, event) if event else []
    for check in checks:
        if not check["held"]:
            reasons.append({"code": "causal-precondition-absent", "detail": f"{check['name']} was not recorded in the critical window", "precondition": check["name"], "evidence": check["evidence"]})
    return {"schema": SCHEMA, "pass": not reasons, "controllerProfile": profile,
            "criticalEvent": event, "designatedHazardActorIds": hazards,
            "preconditions": checks, "reasons": reasons}


def load_trace(path):
    opener = gzip.open if str(path).endswith(".gz") else open
    with opener(path, "rt", encoding="utf-8") as handle:
        return json.load(handle)


def gate_files(trace_path, instance_path, brief):
    return check_provenance(load_trace(trace_path), json.loads(Path(instance_path).read_text()), brief)
