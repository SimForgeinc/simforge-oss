"""One item in, one response out — shared by every transport.

The unix-socket MessagePack server, the HTTP facade and the in-process batch
runner all funnel through :func:`handle_item`. That is deliberate: the three
transports exist for different reasons (large frames, an existing http-json
executor, and a cloud worker that wants no HTTP hop), but they must not be
able to disagree about validation, refusal codes or provenance. If they
could, one path would eventually accept an input the others refuse.

Response shape (``simforge.policy-endpoint/v2``):

    success  {"ok": true,  "result": {...}}
    refusal  {"ok": false, "error": {"code", "message", "fields",
                                     "required_cameras", "detail"}}

A refusal is a 200 with ``ok: false``. Transport-level faults (a malformed
body, an engine that failed to load, an unhandled exception) are the only
things that become HTTP 4xx/5xx, so a single bad item never fails a batch.
"""

from __future__ import annotations

import logging
import traceback
from typing import Any

from simforge_alpamayo.obs import ObservationError

logger = logging.getLogger("simforge_alpamayo.invoke")

#: Params accepted on an item, mapped to engine keyword arguments. Anything
#: else in ``params`` is ignored rather than silently reinterpreted.
_ACT_PARAMS = {
    "num_traj_samples": ("num_traj_samples", int),
    "numTrajSamples": ("num_traj_samples", int),
    "top_p": ("top_p", float),
    "topP": ("top_p", float),
    "temperature": ("temperature", float),
    "diffusion_steps": ("num_diffusion_steps", int),
    "diffusionSteps": ("num_diffusion_steps", int),
    "num_diffusion_steps": ("num_diffusion_steps", int),
    "max_generation_length": ("max_generation_length", int),
}


def refusal(error: ObservationError) -> dict[str, Any]:
    return {"ok": False, "error": error.as_wire()}


def error_response(
    code: str, message: str, **detail: Any
) -> dict[str, Any]:
    payload: dict[str, Any] = {"code": code, "message": message}
    payload["required_cameras"] = None
    if detail:
        payload["detail"] = detail
    return {"ok": False, "error": payload}


def _act_kwargs(params: dict[str, Any]) -> dict[str, Any]:
    kwargs: dict[str, Any] = {}
    for key, value in (params or {}).items():
        mapped = _ACT_PARAMS.get(key)
        if mapped is None or value is None:
            continue
        name, cast = mapped
        try:
            kwargs[name] = cast(value)
        except (TypeError, ValueError):
            raise ObservationError(
                "input_error",
                f"params.{key} must be {cast.__name__}, got {value!r}",
                fields=[f"params.{key}"],
            ) from None
    return kwargs


def handle_item(engine, item: dict[str, Any]) -> dict[str, Any]:
    """Run one ``act`` or ``text`` item against a loaded engine.

    ``item`` keys: ``task`` (default ``"act"``), ``obs``, ``seed``,
    ``params``, plus optional passthrough identity (``runId``, ``attemptId``,
    ``index``, ``itemId``) which is echoed so a caller can correlate results
    without maintaining its own ordering assumption.
    """
    identity = {
        key: item[key]
        for key in ("runId", "attemptId", "index", "itemId", "item_id")
        if key in item
    }
    try:
        if engine is None or engine.model is None:
            raise ObservationError(
                "engine_not_loaded", "engine is not loaded yet"
            )
        task = item.get("task") or "act"
        obs = item.get("obs")
        if not isinstance(obs, dict):
            raise ObservationError(
                "missing_fields", "item.obs is required", fields=["obs"]
            )
        params = item.get("params") or {}
        seed = int(item.get("seed", params.get("seed", 0)))

        if task == "act":
            nav_text = params.get("nav_text") or params.get("navText")
            if nav_text:
                if not engine.spec.capabilities.nav:
                    raise ObservationError(
                        "unsupported_op",
                        f"{engine.family} has no navigation conditioning; "
                        "remove params.nav_text rather than having it ignored",
                        fields=["params.nav_text"],
                    )
                obs = {**obs, "nav_text": nav_text}
            result = engine.act(obs, seed=seed, **_act_kwargs(params))
        elif task == "text":
            text_task = (
                params.get("text_task")
                or params.get("textTask")
                or item.get("text_task")
                or "vqa"
            )
            result = engine.text(
                obs,
                prompt=params.get("prompt") or item.get("prompt"),
                task=text_task,
                seed=seed,
                **{
                    key: params[key]
                    for key in (
                        "top_p",
                        "temperature",
                        "num_samples",
                        "max_generation_length",
                        "future_xyz",
                        "future_rot",
                    )
                    if key in params
                },
            )
        else:
            raise ObservationError(
                "unsupported_op",
                f"unknown task {task!r}; supported: {engine.supports()}",
            )
        return {"ok": True, **identity, "result": result}
    except ObservationError as exc:
        logger.info("item refused [%s]: %s", exc.code, exc.message)
        return {**refusal(exc), **identity}
    except Exception as exc:  # noqa: BLE001 - one item must not kill a batch
        logger.error("item failed: %s", exc)
        traceback.print_exc()
        return {
            **error_response("input_error", str(exc), type=type(exc).__name__),
            **identity,
        }


def cuda_oom(exc: BaseException) -> bool:
    """Whether an exception is a CUDA out-of-memory condition.

    Used by the batch runner to stop rather than grind through every
    remaining item after the device is exhausted; an OOM is a capacity fact
    about the run, not a property of one input.
    """
    name = type(exc).__name__
    if name == "OutOfMemoryError":
        return True
    return "CUDA out of memory" in str(exc)
