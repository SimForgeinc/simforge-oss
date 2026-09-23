"""Kinematic trace replay: the pure half of CARLA's default execution mode.

In ``trace-replay`` every replayed actor (vehicle, walker, prop) has physics
off from spawn and is posed each tick from the render-timeline sampler. This
module owns everything about that which does not need a CARLA server:

* the mapping from a sampled pose (OpenSCENARIO frame, ground-contact ``z``,
  attitude in OSC semantics) to the CARLA actor origin transform;
* the blocking parity gate that compares CARLA's observed transforms with the
  sampler (``REPLAY_PARITY_TOLERANCES``: 1 cm / 0.1 degrees);
* the cooked-mesh vs timeline height diagnostic and the per-map calibrated
  offset.

Frames. OpenSCENARIO is right-handed, z up, heading counter-clockwise from +x;
positive pitch is nose down and positive roll is right side down. CARLA (UE)
is left-handed: ``y`` and yaw are negated, positive pitch is nose up and
positive roll is right side down (both verified on CARLA 0.10 by
``pose-smoke``'s attitude probe).
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from math import isfinite, sqrt
from statistics import median
from typing import Any, Iterable, Mapping

from .._compat_env import simforge_env
from .compiler import LIFECYCLE_ABSENT, ActorFrame, PlanFrame
from .contract import REPLAY_PARITY_TOLERANCES

#: CARLA Rotation.pitch = PITCH_SIGN * OSC pitch; Rotation.roll = ROLL_SIGN * OSC roll.
CARLA_PITCH_SIGN = -1.0
CARLA_ROLL_SIGN = 1.0

#: A knocked-down pedestrian is laid on its right side along its heading (roll
#: 90 deg). Not face down: pitch 90 is CARLA's Euler singularity, where UE
#: reports the same orientation with yaw and roll exchanged. The walker origin
#: is its capsule centre, which then rests this far above the ground.
DOWNED_ROLL_DEG = 90.0
DOWNED_ORIGIN_HEIGHT_M = 0.2

#: Per-map vertical calibration (metres added to the timeline z) keyed by the
#: package XODR sha256. Measured by the replay ground diagnostic: the median
#: cooked-mesh minus timeline height over the drivable/walkable surfaces
#: actors occupy. Maps absent here render at the timeline z unmodified.
MAP_Z_CALIBRATION_M: Mapping[str, float] = {}

#: Bounded violation samples kept in evidence.
MAX_RECORDED_VIOLATIONS = 32


def map_z_calibration(xodr_sha256: str) -> tuple[float, str]:
    """(offset, source) for a map. ``SIMFORGE_CARLA_MAP_Z_OFFSETS_JSON``
    (``{"<xodrSha256>": metres}``) extends and overrides the built-ins."""
    offsets = dict(MAP_Z_CALIBRATION_M)
    raw = simforge_env("CARLA_MAP_Z_OFFSETS_JSON", "").strip()
    source = "built-in"
    if raw:
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise RuntimeError("SIMFORGE_CARLA_MAP_Z_OFFSETS_JSON must be valid JSON") from exc
        if not isinstance(parsed, Mapping) or any(
            not isinstance(key, str) or len(key) != 64
            or not isinstance(value, (int, float)) or isinstance(value, bool)
            or not isfinite(float(value)) or abs(float(value)) > 2.0
            for key, value in parsed.items()
        ):
            raise RuntimeError(
                "SIMFORGE_CARLA_MAP_Z_OFFSETS_JSON must map XODR sha256 values to offsets within 2 m"
            )
        if xodr_sha256 in parsed:
            source = "environment"
        offsets.update({key: float(value) for key, value in parsed.items()})
    if xodr_sha256 not in offsets:
        return 0.0, "none"
    return float(offsets[xodr_sha256]), source


@dataclass(frozen=True)
class RenderPose:
    """A CARLA actor origin pose expressed in the OpenSCENARIO frame."""

    x: float
    y: float
    z: float
    heading_deg: float
    pitch_deg: float
    roll_deg: float


def render_pose(state: ActorFrame, *, bottom_offset_m: float, z_offset_m: float, walker: bool) -> RenderPose:
    """The actor origin pose CARLA must show for one sampled state.

    ``state.z`` is the ground-contact elevation; ``bottom_offset_m`` is the
    signed offset from the actor origin to the bottom of its bounding box
    (``~0`` for vehicles and props, ``~-0.93`` m for a walker capsule).
    """
    if walker and state.downed:
        return RenderPose(
            state.x, state.y, state.z + z_offset_m + DOWNED_ORIGIN_HEIGHT_M,
            state.heading_deg, 0.0, DOWNED_ROLL_DEG,
        )
    return RenderPose(
        state.x, state.y, state.z + z_offset_m - bottom_offset_m,
        state.heading_deg,
        0.0 if walker else state.pitch_deg,
        0.0 if walker else state.roll_deg,
    )


def carla_transform(carla: Any, pose: RenderPose) -> Any:
    return carla.Transform(
        carla.Location(x=pose.x, y=-pose.y, z=pose.z),
        carla.Rotation(
            pitch=CARLA_PITCH_SIGN * pose.pitch_deg,
            yaw=-pose.heading_deg,
            roll=CARLA_ROLL_SIGN * pose.roll_deg,
        ),
    )


def observed_pose(transform: Any) -> RenderPose:
    location, rotation = transform.location, transform.rotation
    return RenderPose(
        float(location.x), -float(location.y), float(location.z),
        -float(rotation.yaw),
        CARLA_PITCH_SIGN * float(getattr(rotation, "pitch", 0.0)),
        CARLA_ROLL_SIGN * float(getattr(rotation, "roll", 0.0)),
    )


def _angle_error(left: float, right: float) -> float:
    return abs((left - right + 180.0) % 360.0 - 180.0)


def _rotation_matrix(pose: RenderPose) -> tuple[tuple[float, float, float], ...]:
    """OSC intrinsic heading (z) -> pitch (y) -> roll (x). Pitch is applied as
    a rotation about +y by -p (positive p is nose down), roll about +x by -r
    (positive r is right side down in a right-handed, y-left frame)."""
    from math import cos, radians, sin
    h, p, r = radians(pose.heading_deg), radians(-pose.pitch_deg), radians(-pose.roll_deg)
    ch, sh, cp, sp, cr, sr = cos(h), sin(h), cos(p), sin(p), cos(r), sin(r)
    return (
        (ch * cp, ch * sp * sr - sh * cr, ch * sp * cr + sh * sr),
        (sh * cp, sh * sp * sr + ch * cr, sh * sp * cr - ch * sr),
        (-sp, cp * sr, cp * cr),
    )


def orientation_error_deg(expected: RenderPose, observed: RenderPose) -> float:
    """Geodesic angle between the two body orientations (degrees).

    Unlike per-component Euler differences it is blind to representation:
    an orientation UE reports with yaw and roll exchanged at pitch 90 is the
    same orientation and measures zero.
    """
    from math import acos, degrees
    a, b = _rotation_matrix(expected), _rotation_matrix(observed)
    trace = sum(a[row][col] * b[row][col] for row in range(3) for col in range(3))
    return degrees(acos(max(-1.0, min(1.0, (trace - 1.0) / 2.0))))


def pose_error(expected: RenderPose, observed: RenderPose) -> tuple[float, float]:
    """(position metres, rotation degrees: geodesic angle between orientations)."""
    position = sqrt(
        (expected.x - observed.x) ** 2 + (expected.y - observed.y) ** 2 + (expected.z - observed.z) ** 2
    )
    return position, orientation_error_deg(expected, observed)


@dataclass
class _ClassStats:
    samples: int = 0
    max_position_m: float = 0.0
    max_rotation_deg: float = 0.0
    violations: int = 0


@dataclass
class ReplayParityGate:
    """Blocking per-tick parity of observed CARLA transforms vs the sampler.

    Every present replayed actor is compared on every tick. Lifecycle closure
    (present exactly when the sampler says so) and signal state are exact.
    Any violation fails the render; the gate only records while running so
    the evidence names every offender, and the executor turns a failed
    verdict into a failed job.
    """

    tolerances: Mapping[str, float] = field(default_factory=lambda: dict(REPLAY_PARITY_TOLERANCES))
    samples: int = 0
    ticks: int = 0
    by_class: dict[str, _ClassStats] = field(default_factory=dict)
    by_actor_max: dict[str, tuple[float, float]] = field(default_factory=dict)
    violations: list[dict[str, Any]] = field(default_factory=list)
    violation_count: int = 0
    lifecycle_mismatches: int = 0
    signal_mismatches: int = 0
    failed_actor_ids: set[str] = field(default_factory=set)
    excluded_actor_ids: set[str] = field(default_factory=set)

    def _violate(self, item: dict[str, Any]) -> None:
        self.violation_count += 1
        if len(self.violations) < MAX_RECORDED_VIOLATIONS:
            self.violations.append(item)

    def observe(
        self,
        frame: PlanFrame,
        expected: Mapping[str, tuple[str, RenderPose]],
        observed: Mapping[str, RenderPose | None],
        *,
        expected_signals: Mapping[str, str] | None = None,
        observed_signals: Mapping[str, str] | None = None,
    ) -> None:
        """``expected`` maps actor id to (class, pose) for bodies the sampler
        says are present; ``observed`` maps every live CARLA body to its pose
        (``None`` when the runtime could not read it back)."""
        self.ticks += 1
        present = set(expected)
        live = {actor_id for actor_id, pose in observed.items()}
        for actor_id in sorted(present ^ live):
            if actor_id in self.excluded_actor_ids:
                continue
            self.lifecycle_mismatches += 1
            self.failed_actor_ids.add(actor_id)
            self._violate({
                "code": "lifecycle", "actorId": actor_id, "frame": frame.index, "t": frame.t,
                "expectedPresent": actor_id in present,
            })
        if expected_signals is not None and observed_signals is not None and dict(expected_signals) != dict(observed_signals):
            self.signal_mismatches += 1
            self._violate({"code": "signal-state", "frame": frame.index, "t": frame.t})
        for actor_id in sorted(present & live):
            klass, want = expected[actor_id]
            got = observed[actor_id]
            stats = self.by_class.setdefault(klass, _ClassStats())
            if got is None:
                self.failed_actor_ids.add(actor_id)
                stats.violations += 1
                self._violate({"code": "readback-missing", "actorId": actor_id, "frame": frame.index, "t": frame.t})
                continue
            position, rotation = pose_error(want, got)
            stats.samples += 1
            self.samples += 1
            stats.max_position_m = max(stats.max_position_m, position)
            stats.max_rotation_deg = max(stats.max_rotation_deg, rotation)
            prior = self.by_actor_max.get(actor_id, (0.0, 0.0))
            self.by_actor_max[actor_id] = (max(prior[0], position), max(prior[1], rotation))
            if position > self.tolerances["positionM"] or rotation > self.tolerances["rotationDeg"]:
                stats.violations += 1
                self.failed_actor_ids.add(actor_id)
                self._violate({
                    "code": "pose", "actorId": actor_id, "class": klass,
                    "frame": frame.index, "t": frame.t,
                    "positionErrorM": position, "rotationErrorDeg": rotation,
                    "expected": vars(want), "observed": vars(got),
                })

    @property
    def passed(self) -> bool:
        return self.samples > 0 and self.violation_count == 0

    def report(self) -> dict[str, Any]:
        max_position = max((stats.max_position_m for stats in self.by_class.values()), default=0.0)
        max_rotation = max((stats.max_rotation_deg for stats in self.by_class.values()), default=0.0)
        return {
            "schema": "simforge.carla-replay-parity/v1",
            "reference": "render-timeline-sampler",
            "blocking": True,
            "verdict": "pass" if self.passed else "fail",
            "tolerances": dict(self.tolerances),
            "ticks": self.ticks,
            "samples": self.samples,
            "maxPositionErrorM": max_position,
            "maxRotationErrorDeg": max_rotation,
            "byClass": {
                klass: {
                    "samples": stats.samples,
                    "maxPositionErrorM": stats.max_position_m,
                    "maxRotationErrorDeg": stats.max_rotation_deg,
                    "violations": stats.violations,
                }
                for klass, stats in sorted(self.by_class.items())
            },
            "worstActors": [
                {"actorId": actor_id, "maxPositionErrorM": values[0], "maxRotationErrorDeg": values[1]}
                for actor_id, values in sorted(
                    self.by_actor_max.items(), key=lambda item: (-item[1][0], -item[1][1], item[0]),
                )[:8]
            ],
            "lifecycleMismatches": self.lifecycle_mismatches,
            "signalMismatches": self.signal_mismatches,
            "violationCount": self.violation_count,
            "failedActorIds": sorted(self.failed_actor_ids),
            "excludedActorIds": sorted(self.excluded_actor_ids),
            "violations": list(self.violations),
        }


@dataclass
class GroundDiagnostic:
    """Cooked-mesh surface minus timeline ground-contact z (metres).

    Positive: the cooked road is above the timeline height, so a body placed
    at the timeline z sinks into it. The timeline z stays authoritative; this
    only reports how far the cooked world disagrees and suggests the per-map
    calibration.
    """

    deltas: dict[str, list[float]] = field(default_factory=dict)
    unresolved: int = 0
    samples_by_actor: dict[str, int] = field(default_factory=dict)

    def observe(self, actor_id: str, klass: str, delta: float | None) -> None:
        if delta is None:
            self.unresolved += 1
            return
        self.deltas.setdefault(klass, []).append(float(delta))
        self.samples_by_actor[actor_id] = self.samples_by_actor.get(actor_id, 0) + 1

    @staticmethod
    def _summary(values: Iterable[float]) -> dict[str, float | int]:
        ordered = sorted(values)
        if not ordered:
            return {"samples": 0}
        magnitudes = sorted(abs(value) for value in ordered)
        return {
            "samples": len(ordered),
            "medianM": median(ordered),
            "minM": ordered[0],
            "maxM": ordered[-1],
            "p95AbsM": magnitudes[min(len(magnitudes) - 1, int(0.95 * len(magnitudes)))],
        }

    def report(self, *, applied_offset_m: float, offset_source: str) -> dict[str, Any]:
        everything = [value for values in self.deltas.values() for value in values]
        overall = self._summary(everything)
        residual = self._summary(value - applied_offset_m for value in everything)
        return {
            "schema": "simforge.carla-ground-diagnostic/v1",
            "authority": "timeline-z",
            "meaning": "cooked-mesh surface minus timeline ground-contact z",
            "overall": overall,
            "byClass": {klass: self._summary(values) for klass, values in sorted(self.deltas.items())},
            "unresolvedSamples": self.unresolved,
            "appliedCalibrationM": applied_offset_m,
            "calibrationSource": offset_source,
            "suggestedCalibrationM": overall.get("medianM"),
            "residualAfterCalibration": residual,
        }


def expected_replay_poses(
    frame: PlanFrame,
    classes: Mapping[str, str],
    bottom_offsets: Mapping[str, float],
    z_offset_m: float,
    *,
    skip: Iterable[str] = (),
) -> dict[str, tuple[str, RenderPose]]:
    """Sampler-derived expected origin pose for every present replayed actor."""
    skipped = set(skip)
    result: dict[str, tuple[str, RenderPose]] = {}
    for actor_id, state in frame.actors.items():
        if actor_id in skipped or state.lifecycle == LIFECYCLE_ABSENT or actor_id not in classes:
            continue
        klass = classes[actor_id]
        result[actor_id] = (klass, render_pose(
            state,
            bottom_offset_m=bottom_offsets.get(actor_id, 0.0),
            z_offset_m=z_offset_m,
            walker=klass == "walker",
        ))
    return result


@dataclass(frozen=True)
class DopplerBody:
    """A replayed body at one tick, in the CARLA (UE, metres) frame."""

    actor_id: str
    center: tuple[float, float, float]
    yaw_rad: float
    half_extent: tuple[float, float, float]
    velocity: tuple[float, float, float]


def _matrix_apply(matrix: list[list[float]], point: tuple[float, float, float]) -> tuple[float, float, float]:
    x, y, z = point
    return tuple(matrix[row][0] * x + matrix[row][1] * y + matrix[row][2] * z + matrix[row][3] for row in range(3))  # type: ignore[return-value]


def radar_point_world(matrix: list[list[float]], depth: float, azimuth: float, altitude: float) -> tuple[float, float, float]:
    """A CARLA radar detection (sensor frame polar) as a world point."""
    from math import cos, sin
    local = (depth * cos(altitude) * cos(azimuth), depth * cos(altitude) * sin(azimuth), depth * sin(altitude))
    return _matrix_apply(matrix, local)


def body_containing(point: tuple[float, float, float], bodies: Iterable[DopplerBody], margin_m: float = 0.3) -> DopplerBody | None:
    from math import cos, sin
    best: tuple[float, DopplerBody] | None = None
    for body in bodies:
        dx, dy, dz = (point[0] - body.center[0], point[1] - body.center[1], point[2] - body.center[2])
        along = dx * cos(body.yaw_rad) + dy * sin(body.yaw_rad)
        across = -dx * sin(body.yaw_rad) + dy * cos(body.yaw_rad)
        ex, ey, ez = body.half_extent
        if abs(along) <= ex + margin_m and abs(across) <= ey + margin_m and abs(dz) <= ez + margin_m:
            distance = dx * dx + dy * dy + dz * dz
            if best is None or distance < best[0]:
                best = (distance, body)
    return None if best is None else best[1]


def timeline_radial_velocity(
    sensor_origin: tuple[float, float, float],
    point: tuple[float, float, float],
    target_velocity: tuple[float, float, float],
    sensor_velocity: tuple[float, float, float],
) -> float:
    """CARLA's radar convention, (v_target - v_sensor) . unit(point - sensor);
    positive when the target recedes, with velocities from the timeline."""
    direction = tuple(point[index] - sensor_origin[index] for index in range(3))
    norm = sqrt(sum(value * value for value in direction)) or 1.0
    return sum(
        (target_velocity[index] - sensor_velocity[index]) * direction[index] / norm
        for index in range(3)
    )


def timeline_observation(
    actor_id: str,
    observed: RenderPose,
    *,
    walker: bool,
    downed: bool,
    bottom_offset_m: float,
    z_offset_m: float,
) -> dict[str, Any]:
    """One observed body as a ``simforge.render-parity/v1`` comparator record
    entry: xodr-local, ground-contact z, OSC attitude in radians.

    It inverts :func:`render_pose` (the renderer-side mapping: the declared
    per-map calibration, the body's origin-to-bottom offset, and a downed
    walker's lay-down), so the shared comparator grades what CARLA showed
    against ``pose(timeline, id, t)`` in the timeline's own terms.
    """
    from math import radians
    if walker and downed:
        contact_z = observed.z - z_offset_m - DOWNED_ORIGIN_HEIGHT_M
        roll = observed.roll_deg - DOWNED_ROLL_DEG
    else:
        contact_z = observed.z - z_offset_m + bottom_offset_m
        roll = observed.roll_deg
    return {
        "id": actor_id,
        "position": [observed.x, observed.y, contact_z],
        "headingRad": radians(observed.heading_deg),
        "pitchRad": radians(observed.pitch_deg),
        "rollRad": radians(roll),
    }
