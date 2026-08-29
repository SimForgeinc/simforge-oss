#!/usr/bin/env python3
"""Benchmark compiler authors on identical edge-case briefs and the frozen TG gate."""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import threading
import time
from typing import Any

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[2]
STAGES = HERE / "stages.py"
CORPUS = ROOT / "apps" / "showcase" / "campaigns" / "edge-cases.json"
DEFAULT_OUTPUT = ROOT / "showcase-data" / "campaigns" / "author-benchmark.json"

DEFAULT_CASE_IDS = (
    "black-ice",
    "snow-covered-markings",
    "flash-flooding",
    "worker-hand-signals",
    "wave-through",
    "flashing-yellow-arrow",
    "four-way-stop-behavior",
    "crosswinds",
    "midblock-will-they",
    "aggressive-tailgating",
    "unpredictable-cyclist",
    "adversarial-cutin",
)

ARMS = (
    {"id": "luna", "model": "gpt-5.6-luna", "effort": "medium", "workers": 4,
     "compilerConcurrency": 2},
    {"id": "ox-alpha", "model": "openrouter/stealth/ox-alpha", "effort": "high",
     "workers": 12, "compilerConcurrency": 3},
)

LEVER_FIELDS = (
    "weather", "surfaceKind", "markingQuality", "wind", "directorGesture",
    "challengerGesture", "paddle", "stopArm", "emergencyLights",
    "challengerIndicator", "signalPhase",
)
DECISION_WIND_FIELDS = ("windDirectionDeg", "windSpeedMps", "windGustPeakMps")

# author_llm writes deterministic intermediate template names keyed only by brief id.
# Keep matching briefs from the two concurrently-running arms out of that critical section.
_BRIEF_LOCKS: dict[str, threading.Lock] = {}
_BRIEF_LOCKS_GUARD = threading.Lock()


def _brief_lock(brief_id: str) -> threading.Lock:
    with _BRIEF_LOCKS_GUARD:
        return _BRIEF_LOCKS.setdefault(brief_id, threading.Lock())


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _load_author_prompt() -> tuple[str, str]:
    """Load the real compiler prompt constants rather than maintaining a fork."""
    path = ROOT / "tools" / "gates" / "author_llm.py"
    sys.path.insert(0, str(path.parent))
    spec = importlib.util.spec_from_file_location("benchmark_author_llm", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot import {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.AUTHOR_PROMPT, module.TOOLDOC


def _category(case_id: str) -> str:
    if case_id in {"black-ice", "snow-covered-markings", "flash-flooding", "crosswinds"}:
        return "weather-surface"
    if case_id in {"worker-hand-signals", "wave-through", "flashing-yellow-arrow",
                   "four-way-stop-behavior"}:
        return "gesture-signal"
    if case_id in {"midblock-will-they", "unpredictable-cyclist"}:
        return "vru"
    return "vehicle"


def _template_has_lever(template: dict[str, Any], field: str) -> bool:
    env = template.get("environment") or {}
    interactions = (template.get("choreography") or {}).get("interactions") or []
    interaction_ids = {item.get("id") for item in interactions if isinstance(item, dict)}
    if field == "weather":
        return "weather" in env
    if field == "surfaceKind":
        return bool(env.get("surfacePatches"))
    if field == "markingQuality":
        return bool(env.get("markingTreatments"))
    if field == "wind":
        return bool(env.get("wind"))
    ids = {
        "directorGesture": {"director-gesture"},
        "challengerGesture": {"challenger-gesture"},
        "paddle": {"flagger-paddle"},
        "stopArm": {"school-bus-stop-arm"},
        "emergencyLights": {"challenger-emergency-lights"},
        "challengerIndicator": {"challenger-indicator"},
    }
    if field in ids:
        return bool(interaction_ids & ids[field])
    if field == "signalPhase":
        features = (template.get("anchor") or {}).get("features") or []
        return any(item.get("id") == "jx" and item.get("control") == {
            "value": ["signalized"], "essentiality": "required"
        } for item in features if isinstance(item, dict))
    return False


def _lever_values(transcript: dict[str, Any], template: dict[str, Any]) -> dict[str, Any]:
    rounds = (transcript.get("result") or {}).get("rounds") or []
    decisions = [item.get("decision") for item in rounds
                 if item.get("kind") in {"author", "repair", "revise"}
                 and isinstance(item.get("decision"), dict)]
    if not decisions:
        return {}
    # The protocol's most recent valid revision becomes the final template. Checking for
    # the compiled effect prevents an invalid, discarded revision from counting as usage.
    decision = decisions[-1]
    result: dict[str, Any] = {}
    for field in LEVER_FIELDS:
        if field == "wind":
            value = {key: decision[key] for key in DECISION_WIND_FIELDS if key in decision}
            if value and _template_has_lever(template, field):
                result[field] = value
        elif field in decision and _template_has_lever(template, field):
            result[field] = decision[field]
    return result


def _usage(transcript: dict[str, Any]) -> dict[str, int]:
    usage = transcript.get("usage") or {}
    input_tokens = usage.get("input_tokens") or usage.get("prompt_tokens") or 0
    output_tokens = usage.get("output_tokens") or usage.get("completion_tokens") or 0
    reasoning_tokens = usage.get("reasoning_tokens") or 0
    return {
        "calls": int(usage.get("calls") or 0),
        "inputTokens": int(input_tokens),
        "outputTokens": int(output_tokens),
        "reasoningTokens": int(reasoning_tokens),
        "totalTokens": int(input_tokens + output_tokens),
    }


def _run_one(arm: dict[str, Any], brief: dict[str, Any], run_root: pathlib.Path,
             probe_draws: int, draws: int, max_sites: int, timeout_s: int) -> dict[str, Any]:
    arm_out = run_root / arm["id"] / brief["id"]
    arm_out.mkdir(parents=True, exist_ok=True)
    brief_path = arm_out / "brief.json"
    brief_path.write_text(json.dumps(brief, indent=2) + "\n", encoding="utf-8")
    command = [
        sys.executable, str(STAGES), "author", "--brief", str(brief_path), "--out", str(arm_out),
        "--model", arm["model"], "--effort", arm["effort"],
        "--probe-draws", str(probe_draws), "--draws", str(draws),
        "--max-sites", str(max_sites), "--concurrency", str(arm["compilerConcurrency"]),
    ]
    started = time.monotonic()
    exact_error = None
    stdout = ""
    stderr = ""
    return_code = None
    try:
        # See _BRIEF_LOCKS: arms still overlap, while identical brief ids cannot corrupt
        # author_llm's shared /tmp intermediate template.
        with _brief_lock(brief["id"]):
            completed = subprocess.run(
                command, cwd=ROOT, text=True, capture_output=True, timeout=timeout_s,
                env={**os.environ, "OPENAI_API_KEY": os.environ.get("OPENAI_API_KEY", "x"),
                     "OPENAI_BASE_URL": os.environ.get(
                         "OPENAI_BASE_URL", "http://127.0.0.1:4141/v1")},
                check=False,
            )
        return_code = completed.returncode
        stdout, stderr = completed.stdout, completed.stderr
        if return_code:
            exact_error = (stderr.strip() or stdout.strip() or f"exit code {return_code}")
    except subprocess.TimeoutExpired as exc:
        stdout = exc.stdout or ""
        stderr = exc.stderr or ""
        exact_error = f"timeout after {timeout_s}s"
    wall_s = round(time.monotonic() - started, 3)

    transcript_path = arm_out / "transcript.json"
    transcript = json.loads(transcript_path.read_text(encoding="utf-8")) if transcript_path.exists() else {}
    result = transcript.get("result") or {}
    template_path = arm_out / "template.json"
    reusable = template_path.is_file()
    template = json.loads(template_path.read_text(encoding="utf-8")) if reusable else {}
    if exact_error is None and result.get("error"):
        exact_error = f"{result['error']}: {result.get('detail', '')}".rstrip()
    row = {
        "model": arm["model"],
        "effort": arm["effort"],
        "initialPromptSha256": brief["initialPromptSha256"],
        "compilerProducedReusableTemplate": reusable,
        "admitted": bool(result.get("admitted")),
        "admittedCells": int(result.get("passingCells") or 0),
        "cells": int(result.get("cells") or 0),
        "portability": {
            "maps": int(result.get("maps") or 0),
            "distinctSites": int(result.get("sites") or 0),
        },
        "leverUsage": _lever_values(transcript, template) if reusable else {},
        "usage": _usage(transcript),
        "wallS": wall_s,
        "authorWallS": transcript.get("wallS"),
        "hardFailure": exact_error,
        "family": result.get("family"),
        "firstFailure": result.get("firstFailure") or {},
        "returnCode": return_code,
    }
    return row


def _aggregate(rows: list[dict[str, Any]]) -> dict[str, Any]:
    lever_counts = {field: 0 for field in LEVER_FIELDS}
    for row in rows:
        for field in row["leverUsage"]:
            lever_counts[field] += 1
    total = len(rows)
    admitted = sum(row["admitted"] for row in rows)
    reusable = sum(row["compilerProducedReusableTemplate"] for row in rows)
    return {
        "briefs": total,
        "reusableTemplates": reusable,
        "templateRate": round(reusable / total, 4) if total else 0,
        "admittedBriefs": admitted,
        "admissionRate": round(admitted / total, 4) if total else 0,
        "admittedCells": sum(row["admittedCells"] for row in rows),
        "maps": sum(row["portability"]["maps"] for row in rows),
        "distinctSites": sum(row["portability"]["distinctSites"] for row in rows),
        "hardFailures": sum(row["hardFailure"] is not None for row in rows),
        "inputTokens": sum(row["usage"]["inputTokens"] for row in rows),
        "outputTokens": sum(row["usage"]["outputTokens"] for row in rows),
        "reasoningTokens": sum(row["usage"]["reasoningTokens"] for row in rows),
        "totalTokens": sum(row["usage"]["totalTokens"] for row in rows),
        "sumWallS": round(sum(row["wallS"] for row in rows), 3),
        "meanWallS": round(sum(row["wallS"] for row in rows) / total, 3) if total else 0,
        "leverUsageCounts": lever_counts,
    }


def _verdict(aggregates: dict[str, dict[str, Any]], per_brief: list[dict[str, Any]]) -> dict[str, str]:
    luna, ox = aggregates["luna"], aggregates["ox-alpha"]
    delta = ox["admittedBriefs"] - luna["admittedBriefs"]
    if abs(delta) >= 2:
        label = "better" if delta > 0 else "worse"
        rationale = (f"ox-alpha admitted {ox['admittedBriefs']}/{ox['briefs']} briefs versus "
                     f"luna {luna['admittedBriefs']}/{luna['briefs']} (delta {delta:+d}); "
                     f"admitted cells were {ox['admittedCells']} versus {luna['admittedCells']}.")
    elif delta == 0 and all(
            row["arms"]["luna"]["admitted"] == row["arms"]["ox-alpha"]["admitted"]
            for row in per_brief):
        label = "equal"
        rationale = (f"Both admitted {ox['admittedBriefs']}/{ox['briefs']} briefs with identical "
                     f"per-brief admission outcomes; admitted cells were {ox['admittedCells']} "
                     f"for ox-alpha and {luna['admittedCells']} for luna.")
    else:
        label = "inconclusive"
        rationale = (f"The admission difference is only {delta:+d} brief in a {ox['briefs']}-brief "
                     f"sample (ox-alpha {ox['admittedBriefs']}, luna {luna['admittedBriefs']}); "
                     "the sample does not support a stable better/equal/worse claim.")
    return {"classification": label, "rationale": rationale}


def _print_table(per_brief: list[dict[str, Any]], aggregates: dict[str, dict[str, Any]], verdict: dict[str, str]) -> None:
    print(f"{'brief':28} {'arm':9} tpl adm cells maps sites tokens wall(s) levers")
    print("-" * 112)
    for item in per_brief:
        for arm_id in ("luna", "ox-alpha"):
            row = item["arms"][arm_id]
            levers = ",".join(row["leverUsage"]) or "-"
            print(f"{item['id'][:28]:28} {arm_id:9} {str(row['compilerProducedReusableTemplate'])[0]:>3} "
                  f"{str(row['admitted'])[0]:>3} {row['admittedCells']:5d} "
                  f"{row['portability']['maps']:4d} {row['portability']['distinctSites']:5d} "
                  f"{row['usage']['totalTokens']:6d} {row['wallS']:7.1f} {levers}")
    print("\naggregate")
    for arm_id in ("luna", "ox-alpha"):
        row = aggregates[arm_id]
        print(f"  {arm_id:9}: templates {row['reusableTemplates']}/{row['briefs']}, "
              f"admitted {row['admittedBriefs']}/{row['briefs']}, cells {row['admittedCells']}, "
              f"tokens {row['totalTokens']}, mean wall {row['meanWallS']}s")
    print(f"\nverdict: {verdict['classification']} — {verdict['rationale']}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=pathlib.Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--case-ids", default=",".join(DEFAULT_CASE_IDS),
                        help="comma-separated edge-case ids")
    parser.add_argument("--probe-draws", type=int, default=1)
    parser.add_argument("--draws", type=int, default=1)
    parser.add_argument("--max-sites", type=int, default=3)
    parser.add_argument("--timeout-s", type=int, default=2400)
    parser.add_argument("--run-root", type=pathlib.Path)
    args = parser.parse_args()

    corpus = json.loads(CORPUS.read_text(encoding="utf-8"))
    by_id = {case["id"]: case for case in corpus["cases"]}
    case_ids = [item.strip() for item in args.case_ids.split(",") if item.strip()]
    missing = [case_id for case_id in case_ids if case_id not in by_id]
    if missing:
        parser.error(f"unknown case ids: {', '.join(missing)}")
    if len(case_ids) < 12:
        parser.error("benchmark requires at least 12 briefs")

    author_prompt, tooldoc = _load_author_prompt()
    briefs = []
    for case_id in case_ids:
        case = by_id[case_id]
        brief = {"id": case_id, "brief": case["title"], "category": _category(case_id)}
        prompt = author_prompt % (tooldoc, brief["category"], brief["brief"])
        brief["initialPromptSha256"] = _sha256(prompt)
        briefs.append(brief)

    run_root = args.run_root or pathlib.Path(tempfile.mkdtemp(prefix="author-benchmark-"))
    run_root.mkdir(parents=True, exist_ok=True)
    arm_results: dict[str, dict[str, dict[str, Any]]] = {arm["id"]: {} for arm in ARMS}

    def run_arm(arm: dict[str, Any]) -> None:
        with concurrent.futures.ThreadPoolExecutor(max_workers=arm["workers"]) as pool:
            futures = {
                pool.submit(_run_one, arm, brief, run_root, args.probe_draws, args.draws,
                            args.max_sites, args.timeout_s): brief["id"]
                for brief in briefs
            }
            for future in concurrent.futures.as_completed(futures):
                case_id = futures[future]
                try:
                    arm_results[arm["id"]][case_id] = future.result()
                except Exception as exc:  # preserve every brief in the report
                    arm_results[arm["id"]][case_id] = {
                        "model": arm["model"], "effort": arm["effort"],
                        "initialPromptSha256": next(b["initialPromptSha256"] for b in briefs
                                                     if b["id"] == case_id),
                        "compilerProducedReusableTemplate": False, "admitted": False,
                        "admittedCells": 0, "cells": 0,
                        "portability": {"maps": 0, "distinctSites": 0}, "leverUsage": {},
                        "usage": {"calls": 0, "inputTokens": 0, "outputTokens": 0,
                                  "reasoningTokens": 0, "totalTokens": 0},
                        "wallS": 0, "authorWallS": None,
                        "hardFailure": f"{type(exc).__name__}: {exc}", "family": None,
                        "firstFailure": {}, "returnCode": None,
                    }

    overall_started = time.monotonic()
    # Separate executors make both arms overlap while retaining their distinct concurrency caps.
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as arms_pool:
        list(arms_pool.map(run_arm, ARMS))
    overall_wall_s = round(time.monotonic() - overall_started, 3)

    per_brief = [{
        "id": brief["id"], "title": brief["brief"], "category": brief["category"],
        "initialPromptSha256": brief["initialPromptSha256"],
        "arms": {arm["id"]: arm_results[arm["id"]][brief["id"]] for arm in ARMS},
    } for brief in briefs]
    aggregates = {
        arm["id"]: _aggregate([item["arms"][arm["id"]] for item in per_brief])
        for arm in ARMS
    }
    verdict = _verdict(aggregates, per_brief)
    report = {
        "schemaVersion": 1,
        "corpus": str(CORPUS.relative_to(ROOT)),
        "caseCount": len(briefs),
        "methodology": {
            "implementation": "tools/research/showcase/stages.py author",
            "compiler": "tools/gates/author_llm.py:author_brief",
            "gate": "frozen training-grade physical gate invoked by author_brief",
            "heldConstant": [
                "brief id and exact corpus title", "initial author prompt", "compiler and matcher",
                "simulation engine", "probe/final draw counts", "site limit", "frozen gate",
            ],
            "necessarilyDifferent": {
                "effort": "luna uses production medium; ox-alpha uses high because it rejects medium",
                "concurrency": ("luna outer concurrency 4 and compiler concurrency 2; ox-alpha outer "
                                "concurrency 12 and compiler concurrency 3 (36, below the measured "
                                "48-request ceiling). Wall-clock differences are therefore harness "
                                "artifacts, not model properties."),
                "sameBriefIsolation": ("The arms run concurrently, but the same brief id is locked "
                                       "across arms because the protected compiler uses a shared "
                                       "deterministic /tmp intermediate name. Different briefs remain "
                                       "fully parallel; lock wait is included in per-brief wall time."),
            },
            "probeDraws": args.probe_draws, "finalDraws": args.draws,
            "maxSites": args.max_sites, "overallWallS": overall_wall_s,
            "promptHash": "SHA-256 of the exact initial AUTHOR_PROMPT interpolation",
        },
        "arms": [{key: arm[key] for key in ("id", "model", "effort", "workers",
                                              "compilerConcurrency")} for arm in ARMS],
        "briefs": per_brief,
        "aggregates": aggregates,
        "verdict": verdict,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temp = args.output.with_name(f".{args.output.name}.{os.getpid()}.tmp")
    temp.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    os.replace(temp, args.output)
    _print_table(per_brief, aggregates, verdict)
    print(f"\nwrote {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
