"""Verify kernel v2 traces and convert them to legacy campaign scorer records.

Conversion gives the legacy records their own Python-runner cumulative SHA-256
chain, preserving the source digest in the summary. It never labels that new
chain as the original episode identity. No world is replayed or re-scored here.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

from simforge_oss_gym.native import canonical_json

SCHEMA = "simforge.episode-trace/v2"


def deterministic_record(record: dict[str, Any]) -> dict[str, Any]:
    row = {key: value for key, value in record.items() if key not in ("digest", "timing")}
    if "dl" in row:
        row["dl"] = {**row["dl"], "el": None}
    return row


def verify_trace(text: str) -> tuple[list[dict[str, Any]], str]:
    records = [json.loads(line) for line in text.splitlines() if line.strip()]
    if not records or records[0].get("reset", {}).get("schema") != SCHEMA:
        raise ValueError(f"expected {SCHEMA} reset record")
    chain = ""
    for index, row in enumerate(records):
        if "summary" in row:
            if index != len(records) - 1 or row.get("episode_digest") != chain:
                raise ValueError("invalid completion record")
            if row["summary"].get("episodeDigest") != chain:
                raise ValueError("summary digest disagrees with trace")
            continue
        payload = canonical_json(json.dumps(deterministic_record(row)))
        chain = hashlib.sha256((chain + payload).encode()).hexdigest()
        if row.get("digest") != chain:
            raise ValueError(f"trace digest mismatch at record {index}")
    if "summary" not in records[-1]:
        raise ValueError("trace is not sealed: call Episode.finish() first")
    return records, chain


def convert_trace(
    text: str, *, policy: str = "policy",
    annotations: dict[int, dict[str, Any]] | None = None,
) -> str:
    records, source_digest = verify_trace(text)
    reset = records[0]["reset"]
    observation = reset["observation"]
    output: list[str] = []
    chain = hashlib.sha256()

    def emit(row: dict[str, Any], timing: dict[str, Any] | None = None) -> None:
        chain.update(json.dumps(row, sort_keys=True, separators=(",", ":")).encode())
        record = {**row, "digest": chain.hexdigest()}
        if timing is not None:
            record["timing"] = timing
        output.append(json.dumps(record, sort_keys=True))

    # Policy start is after the scripted prologue. Scoring its route progress as
    # model progress would change the measured episode, so omit warm-up rows and
    # rebase the legacy reset to the last real warm-up observation.
    warmup = [row for row in records if row.get("phase") == "warmup"]
    start = warmup[-1] if warmup else None
    initial_objects = []
    if start is not None:
        initial_objects = start["objs"]
    elif observation.get("objects"):
        # Reset observation uses engine actor handles; the v2 step rows carry
        # canonical IDs. Do not invent IDs for a legacy reset's unscored objects.
        initial_objects = []
    emit({"reset": {
        "seed": reset["seed"], "mode": reset["mode"],
        "deadline_ms": reset["deadline_ms"], "fallback": reset["fallback"],
        "policy": policy, "t": start["t"] if start else reset["t"],
        "sv": start["sv"] if start else observation.get("stateVector"),
        "objs": [[o["id"], o["rangeM"], o["bearingRad"], o["rangeRateMps"], int(o["lineOfSight"])] for o in initial_objects],
    }})
    for row in records:
        if row.get("phase") != "policy":
            continue
        legacy = {key: row[key] for key in ("t", "a", "pol", "rw", "term", "trunc", "sv", "terms", "ex", "miss", "applied")}
        legacy["reward_terms"] = row["reward_terms"]
        legacy["step"] = row["step"] - len(warmup)
        legacy["objs"] = [[o["id"], o["rangeM"], o["bearingRad"], o["rangeRateMps"], int(o["lineOfSight"])] for o in row["objs"]]
        legacy["pol"] = policy
        telemetry = (annotations or {}).get(row["step"], {})
        for key in ("reasoning", "replan"):
            if key in telemetry:
                legacy[key] = telemetry[key]
        legacy["term_reason"] = row.get("term_reason")
        if "events" in row:
            legacy["events"] = row["events"]
        if row.get("collision") is not None:
            legacy["collision"] = row["collision"]
        if row.get("env") is not None:
            legacy["env"] = row["env"]
        emit(legacy, telemetry.get("timing", row.get("timing")))
    core = records[-1]["summary"]
    output.append(json.dumps({"summary": {
        "mode": core["mode"], "status": core["status"],
        "steps": core["decisions"], "term_reason": core["termReason"],
        "terminated": core["termReason"] in ("collision", "offroad", "red_crossing", "goal"),
        "truncated": core["truncation"] is not None,
        "deadline_misses": core["deadlineMisses"],
        "episode_digest": chain.hexdigest(), "source_episode_digest": source_digest,
        "source_schema": SCHEMA,
    }}, sort_keys=True))
    return "\n".join(output) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("trace", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    args.out.write_text(convert_trace(args.trace.read_text()))


if __name__ == "__main__":
    main()
