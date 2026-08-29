#!/usr/bin/env python3
"""Calibrate ox-alpha against recorded sol semantic verdicts on identical 2D evidence."""

import argparse
import concurrent.futures
import datetime as dt
import hashlib
import json
import os
import statistics
import sys
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
JOBS = ROOT / "showcase-data" / "jobs"
DEFAULT_OUTPUT = ROOT / "showcase-data" / "campaigns" / "oracle-calibration.json"
MODEL = "openrouter/stealth/ox-alpha"
os.environ.setdefault("OPENAI_BASE_URL", "http://127.0.0.1:4141/v1")
os.environ.setdefault("OPENAI_API_KEY", "x")

EFFORT = "high"
AXES = ("mechanismFidelity", "actorFidelity", "eventSequence", "plausible")

# These imports are intentional calibration controls. Do not copy their logic here: the
# measurement must use the production prompt, verdict rule, and deterministic selector.
sys.path.insert(0, str(HERE))
from stages import (  # noqa: E402
    FOOTAGE,
    SEMANTIC2D_PROMPT,
    _authored_scene_evidence,
    _select_review_frames,
    raw_defects,
    review,
    semantic2d_verdict,
)

sys.path.insert(0, str(FOOTAGE))
import futil  # noqa: E402

_print_lock = threading.Lock()


def sha256_text(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def load(path):
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def atomic_write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(value, handle, indent=2, sort_keys=True)
        handle.write("\n")
    os.replace(temporary, path)


def recorded_frames(render_dir, verdict):
    """Resolve exactly the recorded frames, validating timestamps when available."""
    recorded = verdict.get("framesUsed")
    times = verdict.get("frameTimesUsed")
    incident_window = verdict.get("incidentWindow")
    if recorded:
        frames = [render_dir / relative for relative in recorded]
        method = "recorded framesUsed"
    elif times:
        manifest = load(render_dir / "manifest.json")
        by_time = {}
        for item in manifest.get("frames", []):
            if isinstance(item, dict) and isinstance(item.get("t"), (int, float)):
                by_time.setdefault(float(item["t"]), render_dir / "frames" / Path(item["png"]).name)
        frames = []
        for value in times:
            exact = [path for stamp, path in by_time.items() if abs(stamp - float(value)) < 1e-9]
            if len(exact) != 1:
                raise RuntimeError(f"cannot uniquely resolve recorded frame time {value}")
            frames.append(exact[0])
        method = "recorded frameTimesUsed"
    else:
        frames, times, incident_window = _select_review_frames(render_dir)
        method = "production _select_review_frames (legacy verdict had no recorded selection)"

    missing = [str(path) for path in frames if not path.is_file()]
    if missing:
        raise RuntimeError(f"recorded evidence is missing: {missing[0]}")

    if verdict.get("frameTimesUsed"):
        manifest = load(render_dir / "manifest.json")
        stamps = {
            Path(item["png"]).name: item["t"]
            for item in manifest.get("frames", [])
            if isinstance(item, dict) and isinstance(item.get("png"), str)
            and isinstance(item.get("t"), (int, float))
        }
        actual = [stamps.get(path.name) for path in frames]
        expected = verdict["frameTimesUsed"]
        if len(actual) != len(expected) or any(
            actual_value is None or abs(float(actual_value) - float(expected_value)) >= 1e-9
            for actual_value, expected_value in zip(actual, expected)
        ):
            raise RuntimeError("framesUsed does not match recorded frameTimesUsed")
        times = expected

    return frames, times, incident_window, method


def discover():
    candidates = []
    skipped = {}
    for verdict_path in sorted(JOBS.glob("*/**/62-semantic2d.json")):
        try:
            document = load(verdict_path)
        except Exception:
            skipped["unreadable verdict"] = skipped.get("unreadable verdict", 0) + 1
            continue
        attempt = verdict_path.parent
        brief_path = attempt / "00-brief.json"
        for verdict in document.get("cells") or []:
            reason = None
            if verdict.get("status") != "complete":
                reason = "incomplete verdict"
            elif verdict.get("model") != "gpt-5.6-sol":
                reason = "not a sol verdict"
            elif not isinstance(verdict.get("semanticMatch"), bool):
                reason = "missing binary sol verdict"
            elif not verdict.get("cellId"):
                reason = "missing cell id"
            elif not brief_path.is_file():
                reason = "missing persisted brief"
            if reason:
                skipped[reason] = skipped.get(reason, 0) + 1
                continue

            cell_id = verdict["cellId"]
            render_dir = attempt / "60-render2d" / cell_id / "redacted"
            cell_dir = attempt / "40-cells" / cell_id
            if not render_dir.is_dir():
                reason = "missing rendered evidence"
            elif not cell_dir.is_dir():
                reason = "missing cell evidence"
            else:
                try:
                    frames, times, window, method = recorded_frames(render_dir, verdict)
                except Exception as error:
                    reason = f"unusable frame selection: {error}"
            if reason:
                skipped[reason] = skipped.get(reason, 0) + 1
                continue
            candidates.append({
                "verdictPath": verdict_path,
                "briefPath": brief_path,
                "cellDir": cell_dir,
                "renderDir": render_dir,
                "sol": verdict,
                "frames": frames,
                "frameTimes": times,
                "incidentWindow": window,
                "frameSelectionMethod": method,
            })
    return candidates, skipped


def build_prompt(candidate):
    brief = load(candidate["briefPath"])
    evidence = _authored_scene_evidence(
        candidate["cellDir"] / "instance.json", candidate["cellDir"] / "trace.json.gz"
    )
    request_text = brief["brief"]
    return (
        f"{SEMANTIC2D_PROMPT}\n\nUSER REQUEST:\n{request_text}"
        f"\n\nGROUND-TRUTH EVIDENCE:\n{json.dumps(evidence, separators=(',', ':'))}"
    )


def normalize_emission(parsed):
    emission = {"tier": "2d-semantic"}
    for axis in ("mechanismFidelity", "actorFidelity", "eventSequence"):
        if axis in parsed:
            emission[axis] = str(parsed.get(axis) or "").strip().lower()
    if "plausible" in parsed:
        emission["plausible"] = bool(parsed["plausible"])
    if "confidence" in parsed:
        emission["confidence"] = review.clamp_number(parsed["confidence"], 0.0, 1.0)
    emission["defects"] = raw_defects(parsed.get("defects"))
    emission["explanation"] = str(parsed.get("explanation", ""))[:2000]
    return emission


def judge(candidate):
    prompt = build_prompt(candidate)
    content = [{"type": "input_text", "text": prompt}]
    content.extend(
        {"type": "input_image", "image_url": futil.png_data_url(str(frame))}
        for frame in candidate["frames"]
    )
    body = {
        "model": MODEL,
        "reasoning": {"effort": EFFORT},
        "input": [{"role": "user", "content": content}],
    }
    text = ""
    total_wall = 0.0
    for max_output_tokens in (8000, 32000):
        body["max_output_tokens"] = max_output_tokens
        response, raw, wall = futil.responses_call(body, retries=4, timeout=420)
        total_wall += wall
        text = futil.output_text(response)
        if text:
            break
    if not text:
        raise RuntimeError("ox-alpha returned empty output_text even with a 32000-token budget")
    emission = normalize_emission(futil.parse_json_block(text))
    verdict = semantic2d_verdict(emission)
    usage = response.get("usage") or {}
    sol = candidate["sol"]
    return {
        "jobAttempt": str(candidate["verdictPath"].parent.relative_to(ROOT)),
        "cellId": sol["cellId"],
        "verdictPath": str(candidate["verdictPath"].relative_to(ROOT)),
        "promptSha256": sha256_text(prompt),
        "frameSelectionMethod": candidate["frameSelectionMethod"],
        "framesUsed": [str(frame.relative_to(candidate["renderDir"])) for frame in candidate["frames"]],
        "frameTimesUsed": candidate["frameTimes"],
        "frameSha256": [sha256_file(frame) for frame in candidate["frames"]],
        "incidentWindow": candidate["incidentWindow"],
        "sol": {key: sol.get(key) for key in (
            "model", "effort", "semanticMatch", *AXES, "confidence", "defects", "explanation",
            "rawResponseSha256",
        )},
        "ox": {
            "model": MODEL,
            "effort": EFFORT,
            **emission,
            **verdict,
            "latencyS": round(total_wall, 3),
            "maxOutputTokens": max_output_tokens,
            "tokens": {
                "in": usage.get("input_tokens"),
                "out": usage.get("output_tokens"),
                "reasoning": (usage.get("output_tokens_details") or {}).get("reasoning_tokens"),
            },
            "rawResponseSha256": sha256_text(raw),
        },
    }


def ratio(count, total):
    return round(count / total, 6) if total else None


def confidence_distribution(rows, arm):
    values = [float(row[arm]["confidence"]) for row in rows if isinstance(row[arm].get("confidence"), (int, float))]
    bins = {"[0,.5)": 0, "[.5,.6)": 0, "[.6,.7)": 0, "[.7,.8)": 0, "[.8,.9)": 0, "[.9,1]": 0}
    for value in values:
        if value < 0.5:
            key = "[0,.5)"
        elif value < 0.6:
            key = "[.5,.6)"
        elif value < 0.7:
            key = "[.6,.7)"
        elif value < 0.8:
            key = "[.7,.8)"
        elif value < 0.9:
            key = "[.8,.9)"
        else:
            key = "[.9,1]"
        bins[key] += 1
    return {
        "count": len(values),
        "min": min(values) if values else None,
        "max": max(values) if values else None,
        "mean": round(statistics.fmean(values), 6) if values else None,
        "median": round(statistics.median(values), 6) if values else None,
        "bins": bins,
    }


def summarize(rows):
    total = len(rows)
    agree = sum(row["sol"]["semanticMatch"] == row["ox"]["semanticMatch"] for row in rows)
    confusion = {
        "solMatch_oxMatch": sum(row["sol"]["semanticMatch"] and row["ox"]["semanticMatch"] for row in rows),
        "solMatch_oxReject": sum(row["sol"]["semanticMatch"] and not row["ox"]["semanticMatch"] for row in rows),
        "solReject_oxMatch": sum(not row["sol"]["semanticMatch"] and row["ox"]["semanticMatch"] for row in rows),
        "solReject_oxReject": sum(not row["sol"]["semanticMatch"] and not row["ox"]["semanticMatch"] for row in rows),
    }
    axis_agreement = {}
    for axis in AXES:
        comparable = [row for row in rows if row["sol"].get(axis) is not None and row["ox"].get(axis) is not None]
        count = sum(row["sol"][axis] == row["ox"][axis] for row in comparable)
        axis_agreement[axis] = {"agreed": count, "compared": len(comparable), "rate": ratio(count, len(comparable))}

    directional = "more permissive" if confusion["solReject_oxMatch"] > confusion["solMatch_oxReject"] else (
        "stricter" if confusion["solMatch_oxReject"] > confusion["solReject_oxMatch"] else "directionally balanced"
    )
    disagreements = [row for row in rows if row["sol"]["semanticMatch"] != row["ox"]["semanticMatch"]]
    examples = []
    for direction in ((False, True), (True, False)):
        examples.extend([
            {
                "jobAttempt": row["jobAttempt"],
                "cellId": row["cellId"],
                "solSemanticMatch": row["sol"]["semanticMatch"],
                "oxSemanticMatch": row["ox"]["semanticMatch"],
                "solExplanationVerbatim": row["sol"].get("explanation"),
                "oxExplanationVerbatim": row["ox"].get("explanation"),
                "solConfidence": row["sol"].get("confidence"),
                "oxConfidence": row["ox"].get("confidence"),
                "promptSha256": row["promptSha256"],
                "framesUsed": row["framesUsed"],
            }
            for row in disagreements
            if (row["sol"]["semanticMatch"], row["ox"]["semanticMatch"]) == direction
        ][:5])

    # A replacement acceptance authority must not reverse validated accept/reject decisions.
    # Report the observed direction even when the recommendation is no.
    usable = not disagreements
    recommendation = (
        "YES: ox-alpha reproduced every recorded sol acceptance decision in this sample."
        if usable else
        f"NO: ox-alpha reversed {len(disagreements)} of {total} validated sol decisions "
        f"and was {directional} overall; it is not a drop-in acceptance oracle."
    )
    return {
        "compared": total,
        "binaryAgreement": {"agreed": agree, "rate": ratio(agree, total)},
        "confusionMatrix": confusion,
        "acceptanceRates": {
            "sol": ratio(sum(row["sol"]["semanticMatch"] for row in rows), total),
            "ox": ratio(sum(row["ox"]["semanticMatch"] for row in rows), total),
        },
        "direction": directional,
        "perAxisAgreement": axis_agreement,
        "confidenceDistribution": {
            "sol": confidence_distribution(rows, "sol"),
            "ox": confidence_distribution(rows, "ox"),
        },
        "disagreementCount": len(disagreements),
        "disagreementExamples": examples,
        "recommendation": {"usableAsAcceptanceOracle": usable, "text": recommendation},
    }


def print_summary(summary):
    matrix = summary["confusionMatrix"]
    print("\nBinary semanticMatch confusion matrix (rows=sol, columns=ox)")
    print("                 ox MATCH   ox REJECT")
    print(f"sol MATCH       {matrix['solMatch_oxMatch']:8d}   {matrix['solMatch_oxReject']:9d}")
    print(f"sol REJECT      {matrix['solReject_oxMatch']:8d}   {matrix['solReject_oxReject']:9d}")
    agreement = summary["binaryAgreement"]
    print(f"\nBinary agreement: {agreement['agreed']}/{summary['compared']} ({agreement['rate']:.1%})")
    print("\nPer-axis agreement")
    print("axis                    agreed/compared    rate")
    for axis, item in summary["perAxisAgreement"].items():
        print(f"{axis:24s} {item['agreed']:5d}/{item['compared']:<5d} {item['rate']:.1%}")
    print("\nConfidence distribution")
    for arm, item in summary["confidenceDistribution"].items():
        print(f"{arm:4s} n={item['count']} mean={item['mean']:.3f} median={item['median']:.3f} bins={item['bins']}")
    print(f"\nRecommendation: {summary['recommendation']['text']}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workers", type=int, default=48, help="parallel requests (1-48; default 48)")
    parser.add_argument("--limit", type=int, help="debug-only candidate limit")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--dry-run", action="store_true", help="discover and validate evidence without model calls")
    parser.add_argument("--fresh", action="store_true", help="ignore successful comparisons already in output")
    args = parser.parse_args()
    if not 1 <= args.workers <= 48:
        parser.error("--workers must be between 1 and 48")

    candidates, skipped = discover()
    discovered = len(candidates)
    if args.limit is not None:
        candidates = candidates[:args.limit]
    selected_count = len(candidates)
    rows = []
    if args.output.is_file() and not args.fresh:
        previous = load(args.output)
        calibration = previous.get("calibration") or {}
        compatible = (
            calibration.get("candidateModel") == MODEL
            and calibration.get("candidateEffort") == EFFORT
            and calibration.get("semanticPromptSha256") == sha256_text(SEMANTIC2D_PROMPT)
        )
        if compatible:
            previous_rows = {
                (row.get("verdictPath"), row.get("cellId")): row
                for row in previous.get("comparisons") or []
            }
            pending = []
            for candidate in candidates:
                key = (
                    str(candidate["verdictPath"].relative_to(ROOT)),
                    candidate["sol"]["cellId"],
                )
                row = previous_rows.get(key)
                if (
                    row
                    and row.get("promptSha256") == sha256_text(build_prompt(candidate))
                    and row.get("frameSha256") == [sha256_file(frame) for frame in candidate["frames"]]
                ):
                    rows.append(row)
                else:
                    pending.append(candidate)
            candidates = pending
    print(
        f"Found {discovered} sol-judged cells with surviving identical evidence; "
        f"selected {selected_count}, resuming {len(rows)}, pending {len(candidates)}"
    )
    if skipped:
        print("Skipped:", json.dumps(skipped, sort_keys=True))
    if args.dry_run:
        return 0
    if not candidates and not rows:
        raise SystemExit("no comparable cells found")

    # The generic futil preflight defaults to medium, which ox-alpha rejects. Pin high explicitly
    # while retaining the production preflight's three randomized attempts.
    sys.path.insert(0, str(ROOT / "tools" / "gates"))
    import assert_vision
    vision_attempts = []
    vision_ok = False
    vision_detail = None
    for attempt in range(1, 4):
        vision_ok, vision_detail = assert_vision.check(model=MODEL, effort=EFFORT)
        vision_attempts.append({"attempt": attempt, "ok": vision_ok, "detail": vision_detail})
        if vision_ok:
            break
        time.sleep(1)
    if not vision_ok:
        raise SystemExit(f"vision preflight failed after 3 attempts: {vision_detail}")
    print(f"Vision preflight PASS: {vision_detail}")

    started = time.monotonic()
    errors = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = {executor.submit(judge, candidate): candidate for candidate in candidates}
        for completed, future in enumerate(concurrent.futures.as_completed(futures), 1):
            candidate = futures[future]
            try:
                rows.append(future.result())
            except Exception as error:
                errors.append({
                    "verdictPath": str(candidate["verdictPath"].relative_to(ROOT)),
                    "cellId": candidate["sol"]["cellId"],
                    "error": f"{type(error).__name__}: {error}",
                })
            if completed == 1 or completed % 10 == 0 or completed == len(futures):
                with _print_lock:
                    elapsed = time.monotonic() - started
                    print(f"progress {completed}/{len(futures)} complete, {len(errors)} errors, {elapsed:.1f}s", flush=True)

    rows.sort(key=lambda row: (row["verdictPath"], row["cellId"]))
    summary = summarize(rows)
    result = {
        "schemaVersion": 1,
        "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "calibration": {
            "referenceModel": "gpt-5.6-sol",
            "candidateModel": MODEL,
            "candidateEffort": EFFORT,
            "maxOutputTokens": [8000, 32000],
            "outputBudgetPolicy": "Use 8000 tokens; retry empty output_text once with 32000.",
            "semanticPromptSha256": sha256_text(SEMANTIC2D_PROMPT),
            "promptIdentityGuarantee": (
                "Prompt text is assembled from the imported stages.SEMANTIC2D_PROMPT, the persisted "
                "00-brief.json brief, and stages._authored_scene_evidence using the production byte-level "
                "JSON serialization. Each complete prompt hash is recorded per comparison."
            ),
            "frameIdentityGuarantee": (
                "Recorded framesUsed paths are reused byte-for-byte and each PNG hash is recorded; newer "
                "frameTimesUsed are checked against manifest timestamps. Legacy selections without recorded "
                "paths are reconstructed only by imported stages._select_review_frames."
            ),
            "verdictGuarantee": "semanticMatch is computed by imported stages.semantic2d_verdict.",
            "visionPreflight": {"ok": vision_ok, "attempts": vision_attempts},
        },
        "discovery": {
            "comparableCellsWithSurvivingEvidence": discovered,
            "selected": selected_count,
            "successful": len(rows),
            "failed": len(errors),
            "skipped": skipped,
            "limited": args.limit is not None,
        },
        "summary": summary,
        "errors": errors,
        "comparisons": rows,
    }
    atomic_write(args.output, result)
    print_summary(summary)
    print(f"\nwrote {args.output.relative_to(ROOT) if args.output.is_relative_to(ROOT) else args.output}")
    if errors:
        print(f"WARNING: {len(errors)} comparable cells failed re-judgment", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
