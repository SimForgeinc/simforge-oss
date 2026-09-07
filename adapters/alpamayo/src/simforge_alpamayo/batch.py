"""In-process open-loop manifest runner.

A cloud worker already pays for a warm GPU; making it talk HTTP to itself
adds a base64 round-trip per camera per item for nothing. This module runs a
manifest of open-loop items directly against a loaded engine, using the same
:func:`simforge_alpamayo.invoke.handle_item` the HTTP facade and the socket
server use, so the three paths cannot disagree about validation, refusals or
provenance.

Manifest (``simforge.openloop-manifest/v1``)::

    {"schema": "simforge.openloop-manifest/v1",
     "model":  {"family", "revision", "quant", "cameraProfile"},
     "params": {"seed", "numTrajSamples", "topP", "temperature",
                "diffusionSteps", "navText"},
     "limits": {"maxItems"},
     "items":  [{"itemId", "kind", "obs" | "obsPath",
                 "reference": {"kind": "dataset"|"authored"|"none",
                               "futureXyz": [[x,y,z], ...] | null}}]}

Output is ``simforge.openloop-result/v1``: per-item status, trajectories,
reasoning, metrics when a reference exists, and an aggregate. Items that fail
validation are recorded as ``refused`` with the exact missing fields; they do
not fail the run and they are not scored.

This module deliberately does NOT write ``result.json``. That document is the
evaluation worker's completion marker (``simforge.eval-result-manifest/v1``)
and writing it from two places would make "the job finished" ambiguous.
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import os
import sys
import time
from pathlib import Path
from typing import Any, Callable

from simforge_alpamayo.families import FAMILY_IDS, get_family
from simforge_alpamayo.invoke import cuda_oom, handle_item

logger = logging.getLogger("simforge_alpamayo.batch")

MANIFEST_SCHEMA = "simforge.openloop-manifest/v1"
RESULT_SCHEMA = "simforge.openloop-result/v1"

#: Horizons reported for every scored item, in seconds.
METRIC_HORIZONS_S = (1.0, 3.0, 6.4)
DT_S = 0.1


def load_engine(
    family: str,
    quant: str = "bf16",
    revision: str | None = None,
    device: str = "cuda",
    sidecar_dir: str | None = None,
    weights_dir: str | None = None,
    checkpoint_digest: str | None = None,
) -> Any:
    """Load one family's engine after asserting checkpoint identity.

    Identity is verified before the weights are read, so a revision mismatch
    costs a metadata read rather than minutes of loading followed by results
    attributed to the wrong checkpoint.
    """
    from simforge_alpamayo.engine import load_engine as _load
    from simforge_alpamayo.preflight import verify_revision

    identity = verify_revision(
        family,
        revision=revision,
        expect_digest=checkpoint_digest,
        weights_dir=weights_dir,
    )
    return _load(
        family,
        quant=quant,
        device=device,
        weights_dir=weights_dir,
        sidecar_dir=sidecar_dir,
        checkpoint_digest=identity.get("digest_resolved") or checkpoint_digest,
    )


def _ade_fde(
    trajectories: list[list[list[float]]], future_xyz: list[list[float]]
) -> dict[str, Any] | None:
    """minADE/minFDE over samples at each horizon, in the ego frame at t0.

    Returns ``None`` when the reference is too short to score a horizon;
    a truncated reference yields fewer horizons, never an extrapolation.
    """
    if not trajectories or not future_xyz:
        return None
    reference = [
        (float(point[0]), float(point[1])) for point in future_xyz if len(point) >= 2
    ]
    if not reference:
        return None

    min_ade: dict[str, float] = {}
    min_fde: dict[str, float] = {}
    for horizon in METRIC_HORIZONS_S:
        steps = int(round(horizon / DT_S))
        if len(reference) < steps:
            continue
        best_ade = math.inf
        best_fde = math.inf
        for sample in trajectories:
            if len(sample) < steps:
                continue
            total = 0.0
            for index in range(steps):
                dx = float(sample[index][0]) - reference[index][0]
                dy = float(sample[index][1]) - reference[index][1]
                total += math.hypot(dx, dy)
            ade = total / steps
            dx = float(sample[steps - 1][0]) - reference[steps - 1][0]
            dy = float(sample[steps - 1][1]) - reference[steps - 1][1]
            fde = math.hypot(dx, dy)
            best_ade = min(best_ade, ade)
            best_fde = min(best_fde, fde)
        if best_ade is not math.inf:
            key = f"{horizon:g}"
            min_ade[key] = round(best_ade, 6)
            min_fde[key] = round(best_fde, 6)
    if not min_ade:
        return None
    return {
        "minADE_k": min_ade,
        "minFDE_k": min_fde,
        "samples": len(trajectories),
        "coordinateFrame": "ego@t0 FLU",
    }


def _resolve_obs(item: dict[str, Any], root: Path | None) -> dict[str, Any]:
    obs = item.get("obs")
    if obs is not None:
        return obs
    path = item.get("obsPath") or item.get("obs_path")
    if not path:
        raise KeyError("item requires obs or obsPath")
    resolved = Path(path)
    if not resolved.is_absolute() and root is not None:
        resolved = root / resolved
    return json.loads(resolved.read_text())


def _aggregate(items: list[dict[str, Any]]) -> dict[str, Any]:
    scored = [item for item in items if item.get("metrics")]
    aggregate: dict[str, Any] = {
        "scoredItems": len(scored),
        "refusedItems": sum(1 for item in items if item["status"] == "refused"),
        "failedItems": sum(1 for item in items if item["status"] == "error"),
        "okItems": sum(1 for item in items if item["status"] == "ok"),
        "minADE": {},
        "minFDE": {},
    }
    for horizon in METRIC_HORIZONS_S:
        key = f"{horizon:g}"
        ades = [
            item["metrics"]["minADE_k"][key]
            for item in scored
            if key in item["metrics"]["minADE_k"]
        ]
        fdes = [
            item["metrics"]["minFDE_k"][key]
            for item in scored
            if key in item["metrics"]["minFDE_k"]
        ]
        if ades:
            aggregate["minADE"][key] = round(sum(ades) / len(ades), 6)
        if fdes:
            aggregate["minFDE"][key] = round(sum(fdes) / len(fdes), 6)
    latencies = sorted(
        item["latencyMs"] for item in items if item.get("latencyMs") is not None
    )
    if latencies:
        aggregate["latencyMs"] = {
            "p50": latencies[len(latencies) // 2],
            "p95": latencies[min(len(latencies) - 1, int(len(latencies) * 0.95))],
            "max": latencies[-1],
        }
    return aggregate


def run_manifest(
    manifest: dict[str, Any],
    *,
    engine: Any,
    out_dir: str | os.PathLike[str],
    progress: Callable[[dict[str, Any]], None] | None = None,
    manifest_root: str | os.PathLike[str] | None = None,
) -> dict[str, Any]:
    """Run every item in a manifest; write and return the open-loop result."""
    schema = manifest.get("schema")
    if schema not in (None, MANIFEST_SCHEMA):
        raise ValueError(f"unsupported manifest schema: {schema!r}")

    model = manifest.get("model") or {}
    requested_family = model.get("family")
    if requested_family and requested_family != engine.family:
        raise ValueError(
            f"manifest requests {requested_family} but the loaded engine is "
            f"{engine.family}; one process serves one family"
        )
    requested_quant = model.get("quant")
    if requested_quant and requested_quant != engine.quant:
        raise ValueError(
            f"manifest requests quant {requested_quant} but the engine loaded "
            f"{engine.quant}"
        )

    params = dict(manifest.get("params") or {})
    seed = int(params.pop("seed", 42))
    limits = manifest.get("limits") or {}
    max_items = limits.get("maxItems")
    items_in = list(manifest.get("items") or [])
    if max_items is not None and len(items_in) > int(max_items):
        raise ValueError(
            f"manifest carries {len(items_in)} items, above the job limit "
            f"{max_items}; the backend splits work rather than raising it here"
        )

    out_path = Path(out_dir)
    out_path.mkdir(parents=True, exist_ok=True)
    root = Path(manifest_root) if manifest_root else None

    started = time.time()
    results: list[dict[str, Any]] = []
    aborted: str | None = None

    for index, item in enumerate(items_in):
        item_id = item.get("itemId") or item.get("item_id") or f"item-{index}"
        record: dict[str, Any] = {
            "index": index,
            "itemId": item_id,
            "kind": item.get("kind"),
        }
        t_item = time.monotonic()
        try:
            obs = _resolve_obs(item, root)
        except (KeyError, OSError, json.JSONDecodeError) as exc:
            record.update(
                status="refused",
                refusal={
                    "code": "missing_fields",
                    "message": str(exc),
                    "missingFields": ["obs"],
                },
            )
            results.append(record)
            if progress:
                progress({"index": index, "of": len(items_in), "status": "refused"})
            continue

        # Per-item seed derivation keeps items independent while the run stays
        # reproducible from the single manifest seed.
        item_seed = int(item.get("seed", seed + index))
        try:
            response = handle_item(
                engine,
                {
                    "task": item.get("task") or "act",
                    "obs": obs,
                    "seed": item_seed,
                    "params": {**params, **(item.get("params") or {})},
                    "itemId": item_id,
                    "index": index,
                },
            )
        except BaseException as exc:  # noqa: BLE001 - OOM must stop the run
            if cuda_oom(exc):
                aborted = f"cuda_out_of_memory at item {index}: {exc}"
                record.update(
                    status="error",
                    error={"code": "cuda_oom", "message": str(exc)},
                )
                results.append(record)
                break
            raise

        record["latencyMs"] = round((time.monotonic() - t_item) * 1e3, 3)
        if response.get("ok"):
            result = response["result"]
            record.update(
                status="ok",
                trajectories=result.get("trajectories"),
                trajectoryRot=result.get("trajectory_rot"),
                reasoning=result.get("reasoning"),
                text=result.get("text"),
                fields=result.get("fields"),
                vram=result.get("vram"),
                rngProvenance=result.get("rng_provenance"),
                cameras=result.get("cameras"),
                timings=result.get("timings"),
            )
            reference = item.get("reference") or {}
            future = reference.get("futureXyz") or reference.get("future_xyz")
            ref_kind = reference.get("kind") or ("none" if not future else "dataset")
            record["reference"] = {"kind": ref_kind}
            metrics = (
                _ade_fde(result.get("trajectories") or [], future) if future else None
            )
            # No reference means prediction, not a score. The absence is
            # recorded rather than filled with a default.
            record["metrics"] = metrics
            if future and metrics is None:
                record["reference"]["note"] = (
                    "reference too short for any reported horizon; not scored"
                )
        else:
            error = response.get("error") or {}
            code = error.get("code")
            refused = code in (
                "camera_set_invalid",
                "missing_fields",
                "unsupported_op",
                "input_error",
            )
            record.update(
                status="refused" if refused else "error",
                **(
                    {
                        "refusal": {
                            "code": code,
                            "message": error.get("message"),
                            "missingFields": error.get("fields") or [],
                            "requiredCameras": error.get("required_cameras"),
                        }
                    }
                    if refused
                    else {"error": error}
                ),
            )
        results.append(record)
        if progress:
            progress(
                {
                    "index": index,
                    "of": len(items_in),
                    "status": record["status"],
                    "itemId": item_id,
                }
            )

    document = {
        "schema": RESULT_SCHEMA,
        "model": engine.model_identity(),
        "modelStatus": {
            "quant": engine.quant,
            "quantStatus": engine.quant_status,
            "loadSeconds": engine.load_seconds,
        },
        "params": {"seed": seed, **params},
        "items": results,
        "aggregate": _aggregate(results),
        "timing": {
            "startedAt": started,
            "finishedAt": time.time(),
            "wallSeconds": round(time.time() - started, 3),
        },
        "aborted": aborted,
    }
    (out_path / "openloop.json").write_text(json.dumps(document, indent=2))
    return document


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--family", choices=list(FAMILY_IDS))
    parser.add_argument("--quant", default="bf16", choices=["bf16", "nf4", "fp8"])
    parser.add_argument("--revision", default=None)
    parser.add_argument("--weights-dir", default=None)
    parser.add_argument("--sidecar-dir", default=None)
    parser.add_argument("--checkpoint-digest", default=None)
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--progress", action="store_true",
                        help="emit one JSON progress line per item on stderr")
    parser.add_argument("--log-level", default="INFO")
    args = parser.parse_args()

    logging.basicConfig(level=args.log_level, stream=sys.stderr)
    manifest_path = Path(args.manifest)
    manifest = json.loads(manifest_path.read_text())
    family = args.family or (manifest.get("model") or {}).get("family")
    if not family:
        parser.error("--family is required when the manifest omits model.family")
    get_family(family)

    engine = load_engine(
        family,
        quant=(manifest.get("model") or {}).get("quant") or args.quant,
        revision=args.revision,
        device=args.device,
        sidecar_dir=args.sidecar_dir,
        weights_dir=args.weights_dir,
        checkpoint_digest=args.checkpoint_digest,
    )

    def _progress(event: dict[str, Any]) -> None:
        print(json.dumps({"progress": event}), file=sys.stderr, flush=True)

    document = run_manifest(
        manifest,
        engine=engine,
        out_dir=args.out,
        progress=_progress if args.progress else None,
        manifest_root=manifest_path.parent,
    )
    print(json.dumps({"ok": document["aborted"] is None, "aggregate": document["aggregate"]}))
    raise SystemExit(0 if document["aborted"] is None else 2)


if __name__ == "__main__":
    main()
