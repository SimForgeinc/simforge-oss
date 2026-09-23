"""Observation validation, ego-history packing and control integration."""

from __future__ import annotations

import math
from typing import Any, Iterable, Sequence

from simforge_auto_e2e import contract
from simforge_auto_e2e.engine import AutoE2EError


def _missing(field: str, why: str) -> AutoE2EError:
    return AutoE2EError("missing_fields", f"{field} is required: {why}", fields=[field])


def _shape(value: Any) -> tuple[int, ...] | None:
    shape = getattr(value, "shape", None)
    if shape is not None:
        return tuple(int(v) for v in shape)
    return None


def validate_observation(
    obs: dict[str, Any],
    *,
    scored: bool,
    config: contract.ModelConfig | None = None,
) -> dict[str, Any]:
    """Validate one model observation and return an input provenance record.

    Best_Model was trained with the upstream ``pseudo`` projection.  That
    learned prior is therefore accepted for this known checkpoint and marked
    non-real in provenance; arbitrary legacy configs retain the strict refusal
    against scoring without a physical projection.
    """

    expect_views = config.num_views if config is not None else contract.DEFAULT_NUM_VIEWS
    views_source = "checkpoint config" if config is not None else "documented default"
    views = obs.get("camera_tiles")
    if views is None:
        raise _missing("camera_tiles", f"{expect_views} positional surround views are required")
    if len(views) != expect_views:
        raise AutoE2EError(
            "camera_set_invalid",
            f"AutoE2E takes exactly {expect_views} positional views ({views_source}); got {len(views)}",
            expected=expect_views,
            got=len(views),
            expectedFrom=views_source,
        )

    nav = obs.get("map_context")
    if nav is None:
        raise _missing("map_context", "the rendered semantic navigation raster is required")
    route = obs.get("route_mask")
    if route is None:
        raise _missing("route_mask", "the rendered route corridor raster is required")
    nav_shape = _shape(nav)
    if nav_shape is not None and nav_shape[-3:] != (contract.BEST_MODEL_MAP_CONTEXT_CHANNELS, contract.MAP_HEIGHT, contract.MAP_WIDTH):
        raise AutoE2EError(
            "input_error",
            f"map_context must end in {(contract.BEST_MODEL_MAP_CONTEXT_CHANNELS, contract.MAP_HEIGHT, contract.MAP_WIDTH)}, got {nav_shape}",
            fields=["map_context"],
        )
    route_shape = _shape(route)
    if route_shape is not None and route_shape[-3:] != (contract.BEST_MODEL_ROUTE_CHANNELS, contract.MAP_HEIGHT, contract.MAP_WIDTH):
        raise AutoE2EError(
            "input_error",
            f"route_mask must end in {(contract.BEST_MODEL_ROUTE_CHANNELS, contract.MAP_HEIGHT, contract.MAP_WIDTH)}, got {route_shape}",
            fields=["route_mask"],
        )

    ego = obs.get("egomotion_history")
    if ego is None:
        raise _missing("egomotion_history", f"{contract.EGOMOTION_DIM} values are required")
    if len(ego) != contract.EGOMOTION_DIM:
        raise AutoE2EError(
            "input_error",
            f"egomotion_history must be {contract.EGOMOTION_DIM} values ({contract.HISTORY_TIMESTEPS}x{contract.NUM_HISTORY_SIGNALS}, timestep-major); got {len(ego)}",
            fields=["egomotion_history"],
            expected=contract.EGOMOTION_DIM,
            got=len(ego),
        )
    if not all(math.isfinite(float(v)) for v in ego):
        raise AutoE2EError("input_error", "egomotion_history contains non-finite values", fields=["egomotion_history"])

    visual = obs.get("visual_history")
    if visual is None:
        raise _missing(
            "visual_history",
            f"{contract.VISUAL_HISTORY_DIM} values are required; zero-filling a missing history would be fabricated "
            "for checkpoints that use the branch (Best_Model itself supplies zeros because its branch is dead)",
        )
    if len(visual) != contract.VISUAL_HISTORY_DIM:
        raise AutoE2EError(
            "input_error",
            f"visual_history must be {contract.VISUAL_HISTORY_DIM} values; got {len(visual)}",
            fields=["visual_history"],
        )

    geometry = obs.get("geometry_type") or (config.geometry_type if config is not None else contract.GEOMETRY_TYPE_SHAPE_ONLY)
    has_projection = obs.get("projection") is not None
    is_known_best = bool(config and config.checkpoint_id == contract.BEST_MODEL_FILENAME)
    if geometry == contract.GEOMETRY_TYPE_SHAPE_ONLY or not has_projection:
        if scored and not is_known_best:
            raise AutoE2EError(
                "missing_fields",
                "a scored run requires a real camera projection operator; pseudo geometry is shape-only for unknown checkpoints",
                fields=["projection", "geometry_type"],
            )
        geometry = contract.GEOMETRY_TYPE_SHAPE_ONLY
    elif geometry not in contract.GEOMETRY_TYPES_SCORABLE:
        raise AutoE2EError(
            "input_error",
            f"unknown geometry_type {geometry!r}; expected {list(contract.GEOMETRY_TYPES_SCORABLE)} or 'pseudo'",
            fields=["geometry_type"],
        )

    return {
        "views": len(views),
        "viewCountFrom": views_source,
        "geometry_type": geometry,
        "geometry_is_real": geometry != contract.GEOMETRY_TYPE_SHAPE_ONLY,
        "navigation_raster": "supplied",
        "navigation_geometry": contract.BEST_MODEL_NAVIGATION_GEOMETRY,
        "egomotion_signals": list(contract.EGOMOTION_SIGNALS),
        "egomotion_layout": "timestep-major",
        "visual_history": "zeros (checkpoint branch is dead)",
        "scorable": geometry != contract.GEOMETRY_TYPE_SHAPE_ONLY,
    }


def split_control(flat: Sequence[float]) -> list[tuple[float, float]]:
    """Split the flat ``(128,)`` output into 64 ``(acceleration, curvature)`` pairs."""

    if len(flat) != contract.TRAJECTORY_DIM:
        raise AutoE2EError("input_error", f"expected {contract.TRAJECTORY_DIM} output values, got {len(flat)}")
    return [
        (float(flat[i * contract.NUM_TARGET_SIGNALS]), float(flat[i * contract.NUM_TARGET_SIGNALS + 1]))
        for i in range(contract.FUTURE_TIMESTEPS)
    ]


def integrate_control(
    control: Iterable[tuple[float, float]],
    initial_speed_mps: float,
    dt_s: float = 1.0 / contract.FUTURE_HZ,
) -> dict[str, Any]:
    """Integrate 64 ``(a, kappa)`` controls with the reference unicycle model."""

    if not math.isfinite(initial_speed_mps) or initial_speed_mps < 0:
        raise AutoE2EError(
            "input_error",
            f"initial_speed_mps must be a finite non-negative speed, got {initial_speed_mps!r}",
            fields=["initial_speed_mps"],
        )
    x = y = heading = 0.0
    speed = float(initial_speed_mps)
    path: list[list[float]] = []
    speeds: list[float] = []
    headings: list[float] = []
    clamped = 0
    controls = list(control)
    for accel, curvature in controls:
        if not math.isfinite(accel) or not math.isfinite(curvature):
            raise AutoE2EError("output_invalid", "model emitted non-finite control")
        speed += float(accel) * dt_s
        if speed < 0.0:
            speed = 0.0
            clamped += 1
        heading += speed * float(curvature) * dt_s
        x += speed * math.cos(heading) * dt_s
        y += speed * math.sin(heading) * dt_s
        path.append([x, y, 0.0])
        speeds.append(speed)
        headings.append(heading)
    return {
        "path_xyz": path,
        "speed_profile_mps": speeds,
        "heading_profile_rad": headings,
        "frame": "ego@t0",
        "convention": "FLU (x forward, y left, z up)",
        "dt_s": dt_s,
        "horizon_s": len(controls) * dt_s,
        "integrator": "unicycle, constant control per step, v=max(0,v+a*dt), heading rate=v*curvature",
        "initial_speed_mps": float(initial_speed_mps),
        "speed_clamped_steps": clamped,
        "derived": True,
        "note": "positions are derived by integrating physical acceleration and curvature controls",
    }


def ego_motion_history(poses: Sequence[Sequence[float]], *, hz: float = contract.HISTORY_HZ) -> tuple[list[float], dict[str, Any]]:
    """Pack real ``[x,y,yaw,speed,tS]`` poses into the model's raw 64x4 tensor.

    No stale edge padding is used once 64 poses are available.  During startup
    the oldest real row is repeated solely to satisfy the fixed-size model ABI;
    the returned provenance says exactly how many rows were padded.
    """

    rows = [list(map(float, row)) for row in poses]
    if not rows:
        raise AutoE2EError("missing_fields", "ego history is empty", fields=["egoHistory"])
    for row in rows:
        if len(row) < 4 or not all(math.isfinite(v) for v in row[:4]):
            raise AutoE2EError("input_error", "ego history contains an invalid pose", fields=["egoHistory"])
    rows = rows[-contract.HISTORY_TIMESTEPS :]
    padded = max(0, contract.HISTORY_TIMESTEPS - len(rows))
    if padded:
        rows = [rows[0]] * padded + rows
    xyz = [(r[0], r[1]) for r in rows]
    yaw = [r[2] for r in rows]
    times = [r[4] if len(r) > 4 and math.isfinite(r[4]) else i / hz for i, r in enumerate(rows)]
    # Unwrap without NumPy so the server remains importable in a minimal venv.
    unwrapped = [yaw[0]]
    for value in yaw[1:]:
        previous = unwrapped[-1]
        while value - previous > math.pi:
            value -= 2 * math.pi
        while value - previous < -math.pi:
            value += 2 * math.pi
        unwrapped.append(value)
    def dt_at(i: int) -> float:
        if i == 0:
            dt = times[1] - times[0] if len(times) > 1 else 1 / hz
        elif i == len(times) - 1:
            dt = times[-1] - times[-2]
        else:
            dt = (times[i + 1] - times[i - 1]) * 0.5
        return max(float(dt), 1e-3)
    speed: list[float] = []
    yaw_rate: list[float] = []
    for i in range(len(rows)):
        if i == 0:
            j = 1 if len(rows) > 1 else 0
            dt = max(times[j] - times[0], 1e-3)
            dx, dy = xyz[j][0] - xyz[0][0], xyz[j][1] - xyz[0][1]
        else:
            dt = max(times[i] - times[i - 1], 1e-3)
            dx, dy = xyz[i][0] - xyz[i - 1][0], xyz[i][1] - xyz[i - 1][1]
        speed.append(math.hypot(dx, dy) / dt)
        yaw_rate.append((unwrapped[min(i + 1, len(rows) - 1)] - unwrapped[max(i - 1, 0)]) / max(dt_at(i) * (2 if 0 < i < len(rows) - 1 else 1), 1e-3))
    accel: list[float] = []
    for i in range(len(rows)):
        if i == 0:
            accel.append((speed[1] - speed[0]) / max(times[1] - times[0], 1e-3) if len(rows) > 1 else 0.0)
        elif i == len(rows) - 1:
            accel.append((speed[-1] - speed[-2]) / max(times[-1] - times[-2], 1e-3))
        else:
            accel.append((speed[i + 1] - speed[i - 1]) / max(times[i + 1] - times[i - 1], 1e-3))
    packed: list[float] = []
    for v, a, r in zip(speed, accel, yaw_rate):
        packed.extend((v, a, r, r / max(abs(v), 0.5)))
    return packed, {
        "timesteps": len(rows),
        "paddedOldestRows": padded,
        "warm": padded == 0,
        "hz": hz,
        "signals": list(contract.EGOMOTION_SIGNALS),
        "latestSpeedMps": speed[-1],
        "latestAccelerationMps2": accel[-1],
    }
