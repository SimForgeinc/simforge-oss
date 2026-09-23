"""The render failure and substitution policy for CARLA renders.

Missing, failed or unsupported data never silently degrades a render
(``docs/engineering/no-silent-fallbacks.md``). Every such case either fails
the job with a ``carla_*`` machine code, or, where a substitution is genuine
product behaviour, is requested in the render intent
(``allowSubstitutions``), recorded in the manifest (``substitutions``, only
when the lease lists ``render-evidence.substitutions``) and surfaced as a job
warning.

Everything here is pure (no CARLA import) so the policy is unit tested
without a server.
"""
from __future__ import annotations

import re
import struct
from collections import deque
from dataclasses import dataclass, field
from math import isfinite
from typing import Any, Iterable, Mapping

from .contract import ContractError

#: `CONTROL_FEATURE_RENDER_SUBSTITUTIONS` in `@simforge-oss/render`.
CONTROL_FEATURE_RENDER_SUBSTITUTIONS = "render-evidence.substitutions"

#: `RENDER_SUBSTITUTION_KINDS` in `@simforge-oss/scenario` that CARLA honours.
#: `carla-actor-body`: an actor whose catalog body this image cannot render
#: exactly is rendered with the nearest same-class blueprint.
SUBSTITUTION_CARLA_ACTOR_BODY = "carla-actor-body"
SUBSTITUTION_KINDS = frozenset({SUBSTITUTION_CARLA_ACTOR_BODY})

#: The intent field that grants a substitution, recorded as `allowedBy`.
SUBSTITUTION_GRANT_FIELD = "allowSubstitutions"

_CODE = re.compile(r"^carla_[a-z0-9_]+$")


class CarlaRenderError(ContractError, RuntimeError):
    """A render refused because an input it needs is missing, invalid or unsupported.

    The message carries the machine code as a ``[carla_<code>] `` prefix, the
    same framing the native service uses, so the TypeScript engine recovers
    the code (``renderInputErrorFromServiceMessage``) and reports it
    non-retryable. It is both a ``ContractError`` and a ``RuntimeError`` so
    existing handlers of either keep catching it.
    """

    retryable = False

    def __init__(self, code: str, message: str):
        if not _CODE.fullmatch(code):
            raise ValueError(f"invalid CARLA render error code {code!r}")
        self.code = code
        self.detail = message
        super().__init__(f"[{code}] {message}")


@dataclass(frozen=True)
class RenderPolicy:
    """What the render intent and the lease allow beyond an exact render."""

    allow_substitutions: frozenset[str] = frozenset()
    control_features: frozenset[str] = frozenset()

    def __post_init__(self) -> None:
        unknown = sorted(self.allow_substitutions - SUBSTITUTION_KINDS)
        if unknown:
            raise CarlaRenderError(
                "carla_substitution_kind_unsupported",
                "render intent allows substitution kinds CARLA does not implement: " + ", ".join(unknown),
            )
        if self.allow_substitutions and CONTROL_FEATURE_RENDER_SUBSTITUTIONS not in self.control_features:
            # A substitution this worker could not report would be silent.
            raise CarlaRenderError(
                "carla_substitutions_unreportable",
                "render intent allows substitutions (" + ", ".join(sorted(self.allow_substitutions))
                + f") but the lease does not list the {CONTROL_FEATURE_RENDER_SUBSTITUTIONS} control"
                " feature, so the substitutions could not be recorded",
            )

    def allows(self, kind: str) -> bool:
        return kind in self.allow_substitutions

    @property
    def reports_substitutions(self) -> bool:
        return CONTROL_FEATURE_RENDER_SUBSTITUTIONS in self.control_features


def parse_allow_substitutions(value: Any) -> frozenset[str]:
    """`RenderIntentV1.allowSubstitutions`: absent, or a non-empty unique list."""
    if value is None:
        return frozenset()
    if (
        not isinstance(value, list) or not value
        or any(not isinstance(item, str) or not item for item in value)
        or len(set(value)) != len(value)
    ):
        raise ContractError("render intent allowSubstitutions must be a non-empty array of unique kinds")
    return frozenset(value)


def parse_control_features(value: str | None) -> frozenset[str]:
    """`--control-features`: the lease's comma-separated control feature list."""
    if not value:
        return frozenset()
    features = [item.strip() for item in value.split(",")]
    if any(not item or len(item) > 128 for item in features):
        raise ContractError("--control-features must be a comma-separated list of non-empty feature names")
    return frozenset(features)


def substitution_record(kind: str, subject: str, requested: str, rendered: str, **details: Any) -> dict[str, Any]:
    """One substitution as the manifest records it (`RenderSubstitution`)."""
    return {
        "kind": kind,
        "subject": subject,
        "requested": requested,
        "rendered": rendered,
        "allowedBy": SUBSTITUTION_GRANT_FIELD,
        **({"details": dict(details)} if details else {}),
    }


# -- walker animation --------------------------------------------------------

#: A walker whose timeline speed exceeds this is walking, so its gait must play.
WALKER_ANIMATION_MIN_SPEED_MPS = 0.3
#: Moving walkers are sampled this often (ticks) until their gait is proven.
WALKER_ANIMATION_SAMPLE_EVERY_TICKS = 5
#: A leg bone must rotate at least this far between two moving samples.
WALKER_ANIMATION_MIN_BONE_DELTA_DEG = 2.0
#: This many consecutive moving sample pairs without leg motion fail the job
#: during the replay (so a frozen walker does not cost the whole render).
WALKER_ANIMATION_MAX_STILL_PAIRS = 10
#: A walker with at least this many moving pairs must have proven its gait by
#: the end of the clip; fewer means it barely walked and is reported as not
#: evaluated, with its pair count.
WALKER_ANIMATION_MIN_PAIRS = 2
#: Bones whose relative rotation carries the gait.
_LEG_BONE = re.compile(r"(thigh|calf|leg|shin|knee|foot)", re.IGNORECASE)


def _angle_delta(left: float, right: float) -> float:
    return abs((left - right + 180.0) % 360.0 - 180.0)


def bone_pose_signature(bones: Any) -> dict[str, tuple[float, float, float]]:
    """Leg-bone relative rotations (degrees) from `carla.Walker.get_bones()`.

    Relative (parent-space) transforms exclude root motion, so a body that is
    only teleported (sliding, frozen or T-posed) keeps the same signature
    however far it travels.
    """
    transforms = getattr(bones, "bone_transforms", None)
    if transforms is None:
        raise CarlaRenderError(
            "carla_walker_animation_unverifiable",
            "CARLA walker bone readback returned no bone_transforms",
        )
    all_bones: dict[str, tuple[float, float, float]] = {}
    for item in transforms:
        # carla.BoneTransformDataOut: bone_name, world, component, relative.
        name = getattr(item, "bone_name", None)
        relative = getattr(item, "relative", None)
        rotation = getattr(relative, "rotation", None)
        if not isinstance(name, str) or not name or rotation is None:
            raise CarlaRenderError(
                "carla_walker_animation_unverifiable",
                "CARLA walker bone readback has a bone without a name or relative rotation",
            )
        all_bones[name] = (float(rotation.pitch), float(rotation.yaw), float(rotation.roll))
    legs = {name: value for name, value in all_bones.items() if _LEG_BONE.search(name)}
    if not legs:
        raise CarlaRenderError(
            "carla_walker_animation_unverifiable",
            "CARLA walker skeleton exposes no leg bones to verify its gait against "
            f"(bones: {sorted(all_bones)[:8]})",
        )
    return legs


def max_bone_delta_deg(
    left: Mapping[str, tuple[float, float, float]],
    right: Mapping[str, tuple[float, float, float]],
) -> float:
    shared = set(left) & set(right)
    if not shared:
        return 0.0
    return max(
        _angle_delta(a, b)
        for name in shared
        for a, b in zip(left[name], right[name])
    )


@dataclass
class _WalkerAnimationState:
    previous: tuple[int, Mapping[str, tuple[float, float, float]]] | None = None
    pairs: int = 0
    still_pairs: int = 0
    max_delta_deg: float = 0.0
    proven_at_tick: int | None = None


@dataclass
class WalkerAnimationMonitor:
    """Requires every walking walker's leg pose to change while it moves.

    A walker replayed with physics off is teleported every tick; its gait
    plays only if CARLA's animation blueprint keeps running. When it does
    not, the walker slides frozen or stands in its bind (T) pose, and nothing
    else in the replay notices: parity grades only the root transform. This
    samples ``get_bones()`` on walkers the timeline says are walking, a few
    ticks apart, and stops sampling a walker once its legs have moved.
    """

    sample_every_ticks: int = WALKER_ANIMATION_SAMPLE_EVERY_TICKS
    min_speed_mps: float = WALKER_ANIMATION_MIN_SPEED_MPS
    min_delta_deg: float = WALKER_ANIMATION_MIN_BONE_DELTA_DEG
    max_still_pairs: int = WALKER_ANIMATION_MAX_STILL_PAIRS
    min_pairs: int = WALKER_ANIMATION_MIN_PAIRS
    walkers: dict[str, _WalkerAnimationState] = field(default_factory=dict)
    samples: int = 0

    def wants_sample(self, actor_id: str, tick: int, speed_mps: float, downed: bool) -> bool:
        state = self.walkers.setdefault(actor_id, _WalkerAnimationState())
        if state.proven_at_tick is not None:
            return False
        moving = abs(speed_mps) > self.min_speed_mps and not downed
        if not moving:
            # A pair must span continuous walking.
            state.previous = None
            return False
        return tick % self.sample_every_ticks == 0

    def observe(self, actor_id: str, tick: int, signature: Mapping[str, tuple[float, float, float]]) -> None:
        state = self.walkers.setdefault(actor_id, _WalkerAnimationState())
        self.samples += 1
        previous = state.previous
        state.previous = (tick, dict(signature))
        if previous is None or tick - previous[0] != self.sample_every_ticks:
            return
        delta = max_bone_delta_deg(previous[1], signature)
        state.pairs += 1
        state.max_delta_deg = max(state.max_delta_deg, delta)
        if delta >= self.min_delta_deg:
            state.proven_at_tick = tick
            state.still_pairs = 0
            return
        state.still_pairs += 1
        if state.still_pairs >= self.max_still_pairs:
            raise CarlaRenderError(
                "carla_walker_animation_inactive",
                f"walker {actor_id} walked for {state.still_pairs * self.sample_every_ticks} ticks "
                f"above {self.min_speed_mps} m/s while its leg bones moved at most "
                f"{state.max_delta_deg:.3f} deg (gait animation is frozen or in its bind pose)",
            )

    def finish(self) -> dict[str, Any]:
        failed = sorted(
            actor_id for actor_id, state in self.walkers.items()
            if state.proven_at_tick is None and state.pairs >= self.min_pairs
        )
        if failed:
            details = ", ".join(
                f"{actor_id} ({self.walkers[actor_id].pairs} moving pairs, max leg delta "
                f"{self.walkers[actor_id].max_delta_deg:.3f} deg)"
                for actor_id in failed
            )
            raise CarlaRenderError(
                "carla_walker_animation_inactive",
                "walking walkers never moved their legs: " + details,
            )
        return self.report()

    def report(self) -> dict[str, Any]:
        return {
            "schema": "simforge.carla-walker-animation/v1",
            "method": "get_bones leg relative-rotation delta while walking",
            "thresholds": {
                "minSpeedMps": self.min_speed_mps,
                "minLegBoneDeltaDeg": self.min_delta_deg,
                "sampleEveryTicks": self.sample_every_ticks,
                "maxStillPairs": self.max_still_pairs,
                "minPairsToEvaluate": self.min_pairs,
            },
            "samples": self.samples,
            "walkers": {
                actor_id: {
                    "verdict": (
                        "animated" if state.proven_at_tick is not None
                        else "not-evaluated" if state.pairs < self.min_pairs
                        else "inactive"
                    ),
                    "movingPairs": state.pairs,
                    "maxLegBoneDeltaDeg": state.max_delta_deg,
                    "provenAtTick": state.proven_at_tick,
                }
                for actor_id, state in sorted(self.walkers.items())
                if state.pairs or state.proven_at_tick is not None
            },
        }


# -- lidar sweeps ------------------------------------------------------------

#: `sensor.lidar.ray_cast` noise/drop-off attributes, set explicitly so no
#: CARLA default (e.g. dropoff_general_rate 0.45: random point loss) applies
#: unrecorded. The render spec carries no noise model, so none is applied.
LIDAR_DETERMINISTIC_ATTRIBUTES: Mapping[str, str] = {
    "dropoff_general_rate": "0.0",
    "dropoff_intensity_limit": "1.0",
    "dropoff_zero_intensity": "0.0",
    "noise_stddev": "0.0",
    # CARLA's documented intensity attenuation; deterministic, and the only
    # thing that gives the intensity channel meaning. Set explicitly and
    # recorded rather than left to the image.
    "atmosphere_attenuation_rate": "0.004",
}

#: Bytes per point in `raw_data`: x, y, z, intensity (float32) for ray-cast
#: lidar; x, y, z, cos_inc_angle (float32), object_idx, object_tag (uint32)
#: for semantic lidar.
LIDAR_POINT_LAYOUT: Mapping[str, tuple[int, tuple[str, ...], str]] = {
    "lidar": (16, ("x", "y", "z", "I"), "<4f"),
    "semantic-lidar": (24, ("x", "y", "z", "CosAngle", "ObjIdx", "ObjTag"), "<4f2I"),
}


def lidar_ticks_per_revolution(rotation_frequency_hz: float, fixed_timestep_s: float) -> int:
    """World ticks one revolution spans; CARLA sweeps `rotation * dt` of a turn per tick."""
    if not isfinite(rotation_frequency_hz) or rotation_frequency_hz <= 0:
        raise CarlaRenderError("carla_lidar_schedule_unsupported", "lidar rotationFrequencyHz must be positive")
    ticks = 1.0 / (rotation_frequency_hz * fixed_timestep_s)
    whole = round(ticks)
    if whole < 1 or abs(ticks - whole) > 1e-9:
        raise CarlaRenderError(
            "carla_lidar_schedule_unsupported",
            f"a {rotation_frequency_hz:g} Hz lidar revolution spans {ticks:g} world ticks of "
            f"{fixed_timestep_s:g} s; CARLA can only assemble whole revolutions from whole ticks "
            f"(rotationFrequencyHz must divide {1.0 / fixed_timestep_s:g})",
        )
    return whole


@dataclass
class LidarSweep:
    """The most recent full revolution of one lidar, assembled from tick slices.

    CARLA's ray-cast lidar returns only the sector swept during one world tick
    (``rotation_frequency * horizontal_fov * dt``). A capture needs a whole
    revolution, so every tick's slice is kept and the capture writes the
    ``ticks_per_revolution`` slices ending at its own tick. Points stay in the
    sensor frame of the tick that fired them, like a real spinning lidar's
    raw output (no ego-motion compensation).
    """

    modality: str
    ticks_per_revolution: int
    slices: deque = field(default_factory=deque)

    def __post_init__(self) -> None:
        if self.modality not in LIDAR_POINT_LAYOUT:
            raise ValueError(f"unsupported lidar modality {self.modality}")
        self.slices = deque(maxlen=self.ticks_per_revolution)

    def add(self, carla_frame: int, raw: bytes) -> None:
        stride = LIDAR_POINT_LAYOUT[self.modality][0]
        if len(raw) % stride:
            raise CarlaRenderError(
                "carla_lidar_data_invalid",
                f"lidar tick {carla_frame} returned {len(raw)} bytes, not a whole number of {stride}-byte points",
            )
        if self.slices and carla_frame != self.slices[-1][0] + 1:
            # A gap would assemble a revolution with a missing sector.
            self.slices.clear()
        self.slices.append((carla_frame, bytes(raw)))

    def revolution(self, carla_frame: int) -> list[tuple[int, bytes]]:
        frames = [frame for frame, _raw in self.slices]
        expected = list(range(carla_frame - self.ticks_per_revolution + 1, carla_frame + 1))
        if frames != expected:
            raise CarlaRenderError(
                "carla_lidar_schedule_unsupported",
                f"lidar capture at CARLA frame {carla_frame} needs the {self.ticks_per_revolution} "
                f"contiguous tick slices {expected[0]}..{expected[-1]} of one revolution; has {frames}",
            )
        return list(self.slices)


def write_lidar_ply(target: Any, modality: str, slices: Iterable[tuple[int, bytes]]) -> int:
    """Write one revolution as ASCII PLY (the layout `save_to_disk` writes). Returns the point count."""
    stride, properties, layout = LIDAR_POINT_LAYOUT[modality]
    rows: list[str] = []
    for _frame, raw in slices:
        for offset in range(0, len(raw), stride):
            values = struct.unpack_from(layout, raw, offset)
            rows.append(" ".join(
                f"{value:.6f}" if isinstance(value, float) else str(value) for value in values
            ))
    types = ("float32",) * 4 + (() if modality == "lidar" else ("uint32",) * 2)
    header = [
        "ply", "format ascii 1.0", f"element vertex {len(rows)}",
        *(f"property {kind} {name}" for kind, name in zip(types, properties)),
        "end_header",
    ]
    with open(target, "w", encoding="ascii", newline="\n") as output:
        output.write("\n".join(header) + "\n")
        if rows:
            output.write("\n".join(rows) + "\n")
    return len(rows)
