"""The render-timeline sampler seam for CARLA trace replay.

CARLA is a renderer of the scenario: it never owns motion. Every pose it shows
comes from one sampler, ``pose(timeline, actor_id, t)``, shared with the editor
and the native renderer (``docs/engineering/render-timeline.md``). This module
is the single place the CARLA adapter obtains poses from:

* :class:`PlanTimeline` samples the execution plan compiled from the
  trajectory-replay ``.xosc`` (the current render contract). Its semantics are
  the render-timeline sampler's: exact at the 50 Hz ticks, linear position,
  pitch and roll between ticks, shortest-arc heading, discrete state
  (lifecycle, appearance, knockdown, signals) latched from the tick at or
  before ``t``, absent at and after the despawn tick with the pose held
  between the last present tick and the despawn tick.
* :class:`BoundTimeline` wraps the WS-B ``simforge_oss_timeline`` Python
  binding (``Timeline.pose``/``poses``/``signals_at``/``lights_at``) for
  packages that ship a baked render timeline.

Both produce :class:`~.compiler.PlanFrame` values, so the backend, the parity
gate and every artifact writer consume one type regardless of the source.
"""
from __future__ import annotations

import math
from dataclasses import replace
from typing import Any, Callable, Mapping, Protocol

from .compiler import LIFECYCLE_ABSENT, LIFECYCLE_ACTIVE, LIFECYCLE_SPAWN, ActorFrame, ExecutionPlan, PlanFrame
from .contract import ContractError
from .policy import CarlaRenderError

#: The render-timeline sampler contract implemented here.
SAMPLER_VERSION = "simforge.timeline-sampler/1"

#: WS-B timeline light channel -> OpenSCENARIO vehicleLightType appearance key.
TIMELINE_LIGHT_TYPES: Mapping[str, str] = {
    "lowBeam": "lowBeam",
    "brake": "brakeLights",
    "reverse": "reversingLights",
    "indicatorLeft": "indicatorLeft",
    "indicatorRight": "indicatorRight",
    "emergency": "specialPurposeLights",
}


#: Every key a render-timeline pose must carry.
_TIMELINE_POSE_KEYS = frozenset({
    "present", "x", "y", "z", "headingRad", "pitchRad", "rollRad", "speedMps", "downed",
})
#: Appearance keys the timeline owns (it states them every tick).
_TIMELINE_OWNED_LIGHT_KEYS = frozenset(f"light.{value}" for value in TIMELINE_LIGHT_TYPES.values())


class FrameSampler(Protocol):
    """What the executor needs from a render timeline."""

    #: Human-readable provenance of the poses, recorded in evidence.
    source: str
    fixed_timestep_s: float

    def tick_count(self) -> int: ...
    def frame_at_tick(self, index: int) -> PlanFrame: ...
    def frame_at(self, index: int, t: float) -> PlanFrame: ...
    def evidence(self) -> Mapping[str, Any]: ...


def _lerp(left: float, right: float, ratio: float) -> float:
    return left + (right - left) * ratio


def _lerp_heading_deg(left: float, right: float, ratio: float) -> float:
    delta = (right - left + 180.0) % 360.0 - 180.0
    return left + delta * ratio


def interpolate_actor(left: ActorFrame, right: ActorFrame, ratio: float) -> ActorFrame:
    """Sampler semantics between two ticks for one actor.

    Continuous channels interpolate; discrete state comes from the earlier
    tick. A body that is absent at the later tick holds its last present
    pose until the despawn tick (it is still ``left`` here).
    """
    if ratio <= 0.0 or right.lifecycle == LIFECYCLE_ABSENT or left.lifecycle == LIFECYCLE_ABSENT:
        return left
    return replace(
        left,
        x=_lerp(left.x, right.x, ratio),
        y=_lerp(left.y, right.y, ratio),
        z=_lerp(left.z, right.z, ratio),
        heading_deg=_lerp_heading_deg(left.heading_deg, right.heading_deg, ratio),
        speed_mps=_lerp(left.speed_mps, right.speed_mps, ratio),
        pitch_deg=_lerp(left.pitch_deg, right.pitch_deg, ratio),
        roll_deg=_lerp(left.roll_deg, right.roll_deg, ratio),
    )


class PlanTimeline:
    """Render-timeline sampler over an xosc-compiled execution plan."""

    def __init__(self, plan: ExecutionPlan):
        if not plan.frames or plan.frames[0].t != 0:
            raise ContractError("execution plan must begin at clip t=0")
        self.plan = plan
        self.fixed_timestep_s = plan.fixed_timestep_s
        self.source = "xosc-trajectory-replay"

    def tick_count(self) -> int:
        return len(self.plan.frames)

    def frame_at_tick(self, index: int) -> PlanFrame:
        return self.plan.frames[index]

    def frame_at(self, index: int, t: float) -> PlanFrame:
        """Sample at clip time ``t``, rendered on tick ``index``.

        ``index`` identifies the CARLA tick the sample is shown on; ``t`` may
        lie up to half a tick either side of it when a capture falls between
        ticks (24/30 fps against the 50 Hz clock).
        """
        frames = self.plan.frames
        tick_t = frames[index].t
        if abs(t - tick_t) <= 1e-9:
            return frames[index]
        dt = self.fixed_timestep_s
        if abs(t - tick_t) > dt / 2 + 1e-9:
            raise RuntimeError(f"sample time {t} is not on tick {index} (t={tick_t})")
        floor = min(max(int(math.floor(t / dt + 1e-9)), 0), len(frames) - 1)
        left = frames[floor]
        right = frames[min(floor + 1, len(frames) - 1)]
        ratio = 0.0 if right is left else (t - left.t) / (right.t - left.t)
        actors = {
            actor_id: interpolate_actor(state, right.actors[actor_id], ratio)
            for actor_id, state in left.actors.items()
        }
        return PlanFrame(index, t, actors, left.signals)

    def evidence(self) -> Mapping[str, Any]:
        return {
            "schema": "simforge.carla-timeline-evidence/v1",
            "source": self.source,
            "samplerVersion": SAMPLER_VERSION,
            "planSha256": self.plan.sha256,
            "timeOriginS": 0.0,
            "warmupS": self.plan.warmup_s,
            "clipEndS": self.plan.frames[-1].t,
            "sourceTimeOffsetS": self.plan.source_time_offset_s,
            "fixedTimestepS": self.fixed_timestep_s,
            "heightSource": "xosc-worldposition-z",
            "attitudeSource": "xosc-worldposition-p-r",
        }


class BoundTimeline:
    """Adapter for the WS-B ``simforge_oss_timeline`` binding.

    ``Timeline.pose``/``poses`` return radians in the OpenSCENARIO frame; the
    plan types carry degrees. Actor bindings (catalog, kind) come from the
    execution plan, whose identity ledger must equal the timeline's actors
    plus its static props exactly.
    """

    def __init__(self, timeline: Any, plan: ExecutionPlan, abort: Callable[[], None] | None = None):
        self.timeline = timeline
        self.plan = plan
        self.fixed_timestep_s = plan.fixed_timestep_s
        self.source = "render-timeline"
        self.abort = abort or (lambda: None)
        dt = float(timeline.dt)
        if abs(dt - plan.fixed_timestep_s) > 1e-12:
            raise ContractError(f"render timeline dt {dt} differs from the 0.02 s execution clock")
        self.times = [float(value) for value in timeline.times]
        if not self.times or self.times[0] != 0.0:
            raise ContractError("render timeline must start at clip t=0")
        self.actor_ids = list(timeline.actor_ids)
        self.props = {str(prop["id"]): prop for prop in timeline.props()}
        closure = set(self.actor_ids) | set(self.props)
        if closure != set(plan.actors):
            missing = sorted(set(plan.actors) - closure)
            extra = sorted(closure - set(plan.actors))
            raise ContractError(
                f"render timeline actors differ from the execution plan (missing {missing[:5]}, extra {extra[:5]})"
            )

    def tick_count(self) -> int:
        return len(self.times)

    def frame_at_tick(self, index: int) -> PlanFrame:
        return self.frame_at(index, self.times[index])

    def _plan_appearance(self, actor_id: str, t: float, timeline_lights: Mapping[str, str]) -> dict[str, str]:
        """xosc appearance the timeline does not carry, latched like the sampler.

        The render timeline carries only its light channels. Doors, cues and
        light types without a timeline channel come from the xosc plan, from
        the tick at or before ``t``. `warningLights` has no channel of its own
        because the timeline expresses hazards as both indicators; it is
        rendered through them, and a hazard the indicators do not show fails.
        """
        frames = self.plan.frames
        floor = min(max(int(math.floor(t / self.fixed_timestep_s + 1e-9)), 0), len(frames) - 1)
        state = frames[floor].actors.get(actor_id)
        if state is None:
            return {}
        merged: dict[str, str] = {}
        for key, value in state.appearance.items():
            if key in timeline_lights or key in _TIMELINE_OWNED_LIGHT_KEYS:
                continue
            if key == "light.warningLights":
                if value != "off" and not (
                    timeline_lights.get("light.indicatorLeft") == value
                    and timeline_lights.get("light.indicatorRight") == value
                ):
                    raise CarlaRenderError(
                        "carla_timeline_appearance_incomplete",
                        f"{actor_id} authors warningLights {value} at t={t:g} but the render timeline's "
                        "indicators do not show it",
                    )
                continue
            merged[key] = value
        return merged

    def frame_at(self, index: int, t: float) -> PlanFrame:
        self.abort()
        poses = self.timeline.poses(t)
        signals = dict(self.timeline.signals_at(t))
        actors: dict[str, ActorFrame] = {}
        for actor_id in self.actor_ids:
            pose = poses[actor_id]
            missing = sorted(_TIMELINE_POSE_KEYS - set(pose))
            if missing:
                # `downed` included: a timeline built before knockdowns
                # existed cannot say whether a pedestrian is lying down.
                raise CarlaRenderError(
                    "carla_timeline_incomplete",
                    f"render timeline pose for {actor_id} lacks {', '.join(missing)}",
                )
            present = bool(pose["present"])
            modes = dict(self.timeline.light_modes_at(actor_id, t)) if present else {}
            unknown = sorted(set(modes) - set(TIMELINE_LIGHT_TYPES))
            if unknown:
                raise CarlaRenderError(
                    "carla_timeline_incomplete",
                    f"render timeline light channel(s) {', '.join(unknown)} of {actor_id} have no CARLA light",
                )
            appearance = {
                f"light.{TIMELINE_LIGHT_TYPES[name]}": str(mode)
                for name, mode in modes.items()
            }
            if present:
                appearance.update(self._plan_appearance(actor_id, t, appearance))
            lifecycle = (
                LIFECYCLE_ABSENT if not present
                else LIFECYCLE_SPAWN if index == 0
                else LIFECYCLE_ACTIVE
            )
            actors[actor_id] = ActorFrame(
                lifecycle,
                float(pose["x"]), float(pose["y"]), float(pose["z"]),
                math.degrees(float(pose["headingRad"])),
                float(pose["speedMps"]),
                appearance,
                bool(pose["downed"]),
                math.degrees(float(pose["pitchRad"])),
                math.degrees(float(pose["rollRad"])),
            )
        for prop_id, prop in self.props.items():
            missing = sorted({"x", "y", "z", "headingRad"} - set(prop))
            if missing:
                raise CarlaRenderError(
                    "carla_timeline_incomplete",
                    f"render timeline prop {prop_id} lacks {', '.join(missing)}",
                )
            actors[prop_id] = ActorFrame(
                LIFECYCLE_SPAWN if index == 0 else LIFECYCLE_ACTIVE,
                float(prop["x"]), float(prop["y"]), float(prop["z"]),
                math.degrees(float(prop["headingRad"])), 0.0,
            )
        return PlanFrame(index, t, actors, signals)

    def evidence(self) -> Mapping[str, Any]:
        return {
            "schema": "simforge.carla-timeline-evidence/v1",
            "source": self.source,
            "samplerVersion": SAMPLER_VERSION,
            "timelineSha256": self.timeline.sha256,
            "timelineKey": self.timeline.key,
            "traceSha256": self.timeline.trace_sha256,
            "xodrSha256": self.timeline.xodr_sha256,
            "timeOriginS": 0.0,
            "warmupS": float(self.timeline.warmup_s),
            "clipEndS": float(self.timeline.clip_end_s),
            "fixedTimestepS": self.fixed_timestep_s,
            "heightSource": "render-timeline",
            "attitudeSource": "render-timeline",
        }


def load_bound_timeline(body: bytes, plan: ExecutionPlan, abort: Callable[[], None] | None = None) -> BoundTimeline:
    """Load a baked render timeline through the shared Python sampler."""
    try:
        import simforge_oss_timeline  # type: ignore
    except ImportError as exc:  # pragma: no cover - depends on the image
        raise ContractError(
            "this package ships a render timeline but the worker image lacks the "
            "simforge_oss_timeline sampler binding"
        ) from exc
    timeline = simforge_oss_timeline.Timeline.from_json(body)
    if simforge_oss_timeline.SAMPLER_VERSION != SAMPLER_VERSION:
        raise ContractError(
            f"worker sampler {simforge_oss_timeline.SAMPLER_VERSION} is not {SAMPLER_VERSION}"
        )
    return BoundTimeline(timeline, plan, abort)
