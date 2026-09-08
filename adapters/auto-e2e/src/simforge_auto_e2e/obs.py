"""AutoE2E observation validation and control-sequence integration.

Nothing here fabricates an input. The navigation raster is required, the
visual history is required, the projection operator is required for any
scorable run, and a missing or wrongly-shaped field is a typed refusal. That
is the same rule the Alpamayo adapter applies to cameras and ego history, and
it matters more here: AutoE2E's nav raster carries the route, so a blank map
does not degrade the prediction, it silently changes the task.
"""

from __future__ import annotations

import math
from typing import Any

from simforge_auto_e2e import contract
from simforge_auto_e2e.engine import AutoE2EError


def _missing(field: str, why: str) -> AutoE2EError:
    return AutoE2EError("missing_fields", f"{field} is required: {why}", fields=[field])


def validate_observation(obs: dict[str, Any], *, scored: bool) -> dict[str, Any]:
    """Validate a wire observation against the upstream contract.

    Returns a provenance record describing what was supplied. ``scored``
    tightens the geometry rule: a scored run may not use the pseudo-geometry
    fallback, which upstream itself labels a learned spatial prior rather than
    real geometry.
    """
    views = obs.get("camera_tiles")
    if views is None:
        raise _missing("camera_tiles", f"{contract.NUM_VIEWS} surround views are the model's primary input")
    if len(views) != contract.NUM_VIEWS:
        raise AutoE2EError(
            "camera_set_invalid",
            f"AutoE2E takes exactly {contract.NUM_VIEWS} views in a fixed "
            f"order; got {len(views)}. Views are POSITIONAL for this model — "
            "there is no camera-id channel, so a short or reordered stack "
            "cannot be detected by the network and would silently mis-assign "
            "every view.",
            expected=contract.NUM_VIEWS,
            got=len(views),
        )

    nav = obs.get("map_context")
    if nav is None:
        raise _missing(
            "map_context",
            "the rendered navigation raster is a REQUIRED input, not an "
            "optional overlay. It carries the route, so omitting it or "
            "supplying a blank raster changes the task rather than degrading "
            "the prediction, and a scored run may not do that",
        )
    route = obs.get("route_mask")
    if route is None:
        raise _missing("route_mask", "route conditioning is enabled for this contract")

    ego = obs.get("egomotion_history")
    if ego is None:
        raise _missing("egomotion_history", f"{contract.EGOMOTION_DIM} values are required")
    if len(ego) != contract.EGOMOTION_DIM:
        raise AutoE2EError(
            "input_error",
            f"egomotion_history must be {contract.EGOMOTION_DIM} values "
            f"({contract.HISTORY_TIMESTEPS} timesteps x "
            f"{contract.NUM_HISTORY_SIGNALS} signals "
            f"{list(contract.EGOMOTION_SIGNALS)}, timestep-major); got {len(ego)}",
            fields=["egomotion_history"],
            expected=contract.EGOMOTION_DIM,
            got=len(ego),
        )
    if not all(math.isfinite(float(v)) for v in ego):
        raise AutoE2EError(
            "input_error", "egomotion_history contains non-finite values",
            fields=["egomotion_history"],
        )

    visual = obs.get("visual_history")
    if visual is None:
        raise _missing(
            "visual_history",
            f"{contract.VISUAL_HISTORY_DIM} values "
            f"({contract.VISUAL_HISTORY_FRAMES} frames x "
            f"{contract.VISUAL_HISTORY_PER_FRAME}-dim compressed scene memory) "
            "produced by the World Action Model branch. A caller without one "
            "has no honest value to supply, and zero-filling it would feed "
            "the planner a fabricated memory",
        )
    if len(visual) != contract.VISUAL_HISTORY_DIM:
        raise AutoE2EError(
            "input_error",
            f"visual_history must be {contract.VISUAL_HISTORY_DIM} values; got {len(visual)}",
            fields=["visual_history"],
        )

    geometry = obs.get("geometry_type") or contract.GEOMETRY_TYPE_SHAPE_ONLY
    has_projection = obs.get("projection") is not None
    if geometry == contract.GEOMETRY_TYPE_SHAPE_ONLY or not has_projection:
        if scored:
            raise AutoE2EError(
                "missing_fields",
                "a scored run requires a real camera projection operator. "
                f"geometry_type={contract.GEOMETRY_TYPE_SHAPE_ONLY!r} is, in "
                "upstream's own words, 'a learned spatial prior, not real "
                "geometry (shape-testing and ablation only)'. Supply a "
                f"projection and one of {list(contract.GEOMETRY_TYPES_SCORABLE)}.",
                fields=["projection", "geometry_type"],
            )
        geometry = contract.GEOMETRY_TYPE_SHAPE_ONLY
    elif geometry not in contract.GEOMETRY_TYPES_SCORABLE:
        raise AutoE2EError(
            "input_error",
            f"unknown geometry_type {geometry!r}; upstream offers "
            f"{list(contract.GEOMETRY_TYPES_SCORABLE)} plus "
            f"{contract.GEOMETRY_TYPE_SHAPE_ONLY!r}",
            fields=["geometry_type"],
        )

    return {
        "views": contract.NUM_VIEWS,
        "geometry_type": geometry,
        "geometry_is_real": geometry != contract.GEOMETRY_TYPE_SHAPE_ONLY,
        "navigation_raster": "supplied",
        "egomotion_signals": list(contract.EGOMOTION_SIGNALS),
        "egomotion_layout": "timestep-major",
        "scorable": geometry != contract.GEOMETRY_TYPE_SHAPE_ONLY,
    }


def split_control(flat: list[float]) -> list[tuple[float, float]]:
    """Split the flat (128,) output into 64 (acceleration, curvature) pairs."""
    if len(flat) != contract.TRAJECTORY_DIM:
        raise AutoE2EError(
            "input_error",
            f"expected {contract.TRAJECTORY_DIM} output values, got {len(flat)}",
        )
    n = contract.NUM_TARGET_SIGNALS
    return [(float(flat[i * n]), float(flat[i * n + 1])) for i in range(contract.FUTURE_TIMESTEPS)]


def integrate_control(
    control: list[tuple[float, float]],
    initial_speed_mps: float,
    dt_s: float = 1.0 / contract.FUTURE_HZ,
) -> dict[str, Any]:
    """Integrate an (acceleration, curvature) sequence into an ego-frame path.

    AutoE2E predicts CONTROLS, not positions, so a path only exists once the
    controls are integrated through a vehicle model — and that needs the ego's
    initial speed, which the model output does not contain.

    The kinematic model here is deliberately the simplest defensible one: a
    unicycle advanced at constant control over each 100 ms step, with heading
    rate = speed x curvature. Two honesty consequences, both recorded in the
    returned record rather than left implicit:

      * The resulting xy path inherits this integrator's error. An ADE/FDE
        computed from it is NOT the same measurement as an ADE/FDE from a
        model that predicts positions directly, and the two must not be
        compared as if they were.
      * Speed is clamped at zero on the way down: a negative speed from
        integrating a large deceleration would silently turn into reverse
        motion, which the model is not predicting.
    """
    if not math.isfinite(initial_speed_mps) or initial_speed_mps < 0:
        raise AutoE2EError(
            "input_error",
            f"initial_speed_mps must be a finite non-negative speed, got {initial_speed_mps!r}",
            fields=["initial_speed_mps"],
        )

    x = y = heading = 0.0
    speed = float(initial_speed_mps)
    path: list[list[float]] = []
    clamped = 0
    for accel, curvature in control:
        speed += accel * dt_s
        if speed < 0.0:
            speed = 0.0
            clamped += 1
        heading += speed * curvature * dt_s
        x += speed * math.cos(heading) * dt_s
        y += speed * math.sin(heading) * dt_s
        path.append([x, y, 0.0])

    return {
        "path_xyz": path,
        "frame": "ego@t0",
        "convention": "FLU (x forward, y left, z up)",
        "dt_s": dt_s,
        "horizon_s": contract.HORIZON_SECONDS,
        "integrator": "unicycle, constant control per step, heading rate = speed * curvature",
        "initial_speed_mps": float(initial_speed_mps),
        "speed_clamped_steps": clamped,
        "derived": True,
        "note": (
            "positions are DERIVED by integrating predicted controls; the model "
            "does not predict positions. Metrics computed from this path "
            "include integrator error and are not directly comparable with "
            "metrics from a waypoint-predicting model."
        ),
    }
