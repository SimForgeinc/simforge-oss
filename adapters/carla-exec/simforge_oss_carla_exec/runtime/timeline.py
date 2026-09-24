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
from dataclasses import dataclass, replace
from typing import Any, Callable, Mapping, Protocol

from .compiler import LIFECYCLE_ABSENT, LIFECYCLE_ACTIVE, LIFECYCLE_SPAWN, ActorFrame, ExecutionPlan, PlanFrame
from .contract import EXECUTION_MODE_TRACE_REPLAY, ContractError
from .policy import CarlaRenderError

#: The render-timeline sampler contract implemented here. /2 (ENGINE_SEM_VER
#: 0.11.0) keeps /1's sampling rules and changes only how the timeline is
#: derived (heights from ground contact, road attitude on the actor
#: transform, body attitude and wheel spin on separate channels CARLA does
#: not read), so the poses CARLA applies mean the same thing. /3 changes only
#: the actor `color` binding (the `studio:body-color:` tag); poses, lights and
#: signals are derived and sampled exactly as under /2.
SAMPLER_VERSION = "simforge.timeline-sampler/3"

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


#: How far a requested clip bound may sit from the authored clip end and still
#: name it (the product's clip seconds are decimal; the plan's are ticks).
CLIP_END_TOLERANCE_S = 1e-6


@dataclass(frozen=True)
class RenderWindow:
    """The part of the scenario clip one render shows, on the 50 Hz ticks.

    Output frame ``k`` shows clip time ``start_s + k / fps`` (the native
    engine's ``frameTimestampSeconds``), so a sub-clip's frames are exactly
    the corresponding frames of the full-clip render. The run ticks
    ``0..end_tick``; the ticks before ``start_tick`` are a pre-roll, replayed
    but neither captured nor graded, so the window renders with the same
    world history (camera exposure, temporal filtering, streamed geometry) as
    the full render. Poses alone do not need it (replay has no state beyond
    the pose each tick gives), but pixels do.
    """

    start_s: float
    end_s: float
    start_tick: int
    end_tick: int
    #: The whole authored clip: the render is the one that predates sub-clips.
    full: bool

    @property
    def tick_count(self) -> int:
        return self.end_tick - self.start_tick + 1

    def ticks(self) -> range:
        return range(self.start_tick, self.end_tick + 1)

    def frames(self, plan: ExecutionPlan) -> tuple[PlanFrame, ...]:
        return plan.frames[self.start_tick:self.end_tick + 1]

    def restrict(self, plan: ExecutionPlan) -> ExecutionPlan:
        """The plan's frames inside the window; identity (digest) unchanged."""
        return plan if self.full else replace(plan, frames=self.frames(plan))

    def duration_s(self, plan: ExecutionPlan) -> float:
        return plan.frames[self.end_tick].t - plan.frames[self.start_tick].t

    def evidence(self, plan: ExecutionPlan) -> Mapping[str, Any]:
        return {
            "schema": "simforge.carla-render-window/v1",
            "startS": self.start_s,
            "endS": self.end_s,
            "startTick": self.start_tick,
            "endTick": self.end_tick,
            "authoredClipEndS": plan.frames[-1].t,
            "fullClip": self.full,
            # Ticks replayed, uncaptured and ungraded, before the window.
            "preRollTicks": self.start_tick,
        }


def resolve_render_window(
    plan: ExecutionPlan,
    clip: tuple[float, float] | None,
    execution_mode: str,
) -> RenderWindow:
    """Place a requested clip on the plan's ticks, refusing what CARLA cannot show.

    Every refusal is deterministic and names its reason; a request CARLA
    cannot render exactly is never widened to the full clip.
    """
    if not plan.frames or plan.frames[0].t != 0:
        raise ContractError("execution plan must begin at clip t=0")
    dt = plan.fixed_timestep_s
    last_tick = len(plan.frames) - 1
    authored_end = plan.frames[-1].t
    if clip is None:
        return RenderWindow(0.0, authored_end, 0, last_tick, True)
    start_s, end_s = float(clip[0]), float(clip[1])
    if not (math.isfinite(start_s) and math.isfinite(end_s)) or start_s < 0 or end_s <= start_s:
        raise ContractError("renderSpec.clip must have endSeconds > startSeconds >= 0")
    if end_s > authored_end + CLIP_END_TOLERANCE_S:
        raise CarlaRenderError(
            "carla_clip_outside_scenario",
            f"renderSpec.clip ends at {end_s:g} s but the scenario's authored clip ends at {authored_end:g} s",
        )
    # The first capture (at start_s) is rendered on the tick the capture
    # schedule rounds it to; the run lasts to the first tick at or after end_s.
    start_tick = round(start_s / dt)
    end_tick = min(math.ceil(end_s / dt - 1e-9), last_tick)
    if start_tick >= end_tick:
        raise CarlaRenderError(
            "carla_clip_too_short",
            f"renderSpec.clip {start_s:g}-{end_s:g} s spans less than one {dt:g} s CARLA tick",
        )
    full = start_tick == 0 and end_tick == last_tick and abs(end_s - authored_end) <= CLIP_END_TOLERANCE_S
    if not full and execution_mode != EXECUTION_MODE_TRACE_REPLAY:
        # Physics validation integrates CARLA physics from the authored start
        # (a body teleported to a later pose is not that run) and grades every
        # authored contact, including those after a shorter window ends.
        raise CarlaRenderError(
            "carla_clip_physics_validation_partial",
            f"CARLA physics validation runs the whole authored clip (0-{authored_end:g} s); "
            f"it cannot render {start_s:g}-{end_s:g} s. Only trace replay renders part of a clip",
        )
    return RenderWindow(start_s, end_s, start_tick, end_tick, full)


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
        signals = _opendrive_signal_ids(self.timeline.signals_at(t))
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
            # The timeline's own sampler: a worker renders the next
            # version's timelines one release before it derives them.
            "samplerVersion": self.timeline.sampler_version,
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


#: The render timeline names a signal head ``signal:<OpenDRIVE signal id>``
#: (simforge-core); CARLA and the xosc plan use the bare OpenDRIVE id.
TIMELINE_SIGNAL_PREFIX = "signal:"


def _opendrive_signal_ids(signals: Mapping[str, str]) -> dict[str, str]:
    out: dict[str, str] = {}
    for key, value in dict(signals).items():
        if not isinstance(key, str) or not key.startswith(TIMELINE_SIGNAL_PREFIX) or not key[len(TIMELINE_SIGNAL_PREFIX):]:
            raise ContractError(f"render timeline signal key {key!r} is not signal:<OpenDRIVE id>")
        out[key[len(TIMELINE_SIGNAL_PREFIX):]] = value
    return out


def load_bound_timeline(body: bytes, plan: ExecutionPlan, abort: Callable[[], None] | None = None) -> BoundTimeline:
    """Load a baked render timeline through the shared Python sampler."""
    try:
        import simforge_oss_timeline  # type: ignore
    except ImportError as exc:  # pragma: no cover - depends on the image
        raise ContractError(
            "this package ships a render timeline but the worker image lacks the "
            "simforge_oss_timeline sampler binding"
        ) from exc
    if simforge_oss_timeline.SAMPLER_VERSION != SAMPLER_VERSION:
        raise CarlaRenderError(
            "carla_timeline_sampler_mismatch",
            f"worker sampler {simforge_oss_timeline.SAMPLER_VERSION} is not {SAMPLER_VERSION}",
        )
    try:
        timeline = simforge_oss_timeline.Timeline.from_json(body)
    except ValueError as exc:
        # The same bytes are refused on every attempt and by every worker
        # running this binding: a deterministic refusal, never a crash.
        raise CarlaRenderError(
            "carla_render_timeline_unreadable",
            f"this worker's {SAMPLER_VERSION} binding cannot read the render timeline: {exc}",
        ) from exc
    return BoundTimeline(timeline, plan, abort)
