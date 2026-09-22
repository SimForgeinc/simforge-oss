"""Ground selection and fail-closed pose gates for CARLA renders.

Two render defects shipped silently before these gates existed:

* props (``static.prop.*``) do not simulate physics in CARLA, so a prop spawned
  with the vehicle spawn lift stayed exactly that far above the ground for the
  whole clip (a dumpster hung 0.775 m over the road);
* walkers driven through ``WalkerControl`` on CARLA 0.10 move at roughly 5% of
  the commanded speed, so authored pedestrians stood nearly still while their
  plan walked 20 m away.

Neither fault raised: the parity report recorded a failure but the render still
shipped. The helpers here are pure (no CARLA import) so the gate semantics are
unit tested without a server; the backend feeds them measurements.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from math import hypot
from typing import Iterable, Mapping

from .._compat_env import simforge_env

#: CARLA semantic labels that are walkable/drivable ground. Anything else a
#: vertical ray meets first (foliage, sign trigger volumes, awnings, parked
#: bodies, and the unlabelled volumes custom RoadRunner cooks carry ~1.6 m above
#: the road) is not ground -- but `world.ground_projection` returned it anyway.
GROUND_LABELS = frozenset({"Roads", "Sidewalks", "Ground", "Terrain", "RoadLines", "Bridge"})

#: Vertical search window around the reference elevation. The upward allowance
#: covers curbs and small authored-elevation error while staying below any
#: overpass deck; the downward depth covers authored z above the cooked surface.
GROUND_SEARCH_UP_M = 1.5
GROUND_SEARCH_DOWN_M = 4.0

#: Actor classes, by how CARLA moves them in a render.
VEHICLE = "vehicle"   # native physics, native controls
WALKER = "walker"     # kinematic replay, physics off
PROP = "prop"         # kinematic replay, physics off (props never simulate)


def motion_class(type_id: str) -> str:
    if type_id.startswith(("vehicle.", "bike.")):
        return VEHICLE
    if type_id.startswith("walker."):
        return WALKER
    return PROP


def select_ground_z(
    hits: Iterable[tuple[str, float]],
    reference_z: float,
    *,
    up: float = GROUND_SEARCH_UP_M,
    down: float = GROUND_SEARCH_DOWN_M,
) -> float | None:
    """Highest ground-labelled surface inside the window around `reference_z`.

    Highest, because a sidewalk slab sits on top of the road mesh and the top
    surface is the one an actor stands on.
    """
    best: float | None = None
    for label, z in hits:
        if label not in GROUND_LABELS:
            continue
        if not reference_z - down <= z <= reference_z + up:
            continue
        if best is None or z > best:
            best = z
    return best


@dataclass(frozen=True)
class GateTolerances:
    #: Planar displacement of an actor from its intended placement at t=0.
    placement_planar_m: float = 0.30
    #: |bottom - ground| at t=0: kinematic bodies are placed exactly.
    kinematic_ground_m: float = 0.05
    #: Vehicles rest on suspension; the bbox bottom is within cm of the road.
    vehicle_ground_m: float = 0.30
    #: A kinematic actor must read back where it was commanded, every tick.
    kinematic_readback_m: float = 0.05
    #: Sustained vehicle airborne/below-ground checks (bbox bottom - ground).
    vehicle_airborne_m: float = 0.50
    vehicle_airborne_s: float = 1.0
    vehicle_sunk_m: float = 0.75
    vehicle_sunk_s: float = 0.2
    #: Motion check windows: an actor whose plan moves at least
    #: `motion_min_planned_m` in a window must cover `motion_min_fraction` of it.
    motion_window_s: float = 1.0
    motion_min_planned_m: float = 0.5
    motion_min_fraction: float = 0.25
    motion_stalled_windows: int = 2


def gate_mode() -> str:
    """`enforce` (default) fails the render; `report` only records evidence."""
    mode = (simforge_env("CARLA_POSE_GATES", "enforce") or "enforce").strip().lower()
    if mode not in {"enforce", "report"}:
        raise RuntimeError("SIMFORGE_CARLA_POSE_GATES must be enforce or report")
    return mode


class PoseGateError(RuntimeError):
    """A render whose actors are not where the scenario says they are."""


@dataclass
class _MotionTrack:
    klass: str
    planned: float = 0.0
    actual: float = 0.0
    stalled: int = 0
    exempt: bool = False
    last_planned: tuple[float, float] | None = None
    last_actual: tuple[float, float] | None = None


@dataclass
class _GroundTrack:
    airborne_s: float = 0.0
    sunk_s: float = 0.0


@dataclass
class PoseGate:
    fixed_timestep_s: float
    tolerances: GateTolerances = field(default_factory=GateTolerances)
    mode: str = "enforce"
    violations: list[dict[str, object]] = field(default_factory=list)
    placement: dict[str, dict[str, object]] = field(default_factory=dict)
    motion: dict[str, _MotionTrack] = field(default_factory=dict)
    ground: dict[str, _GroundTrack] = field(default_factory=dict)
    max_kinematic_readback_m: float = 0.0
    max_ground_gap_m: dict[str, float] = field(default_factory=dict)
    windows_evaluated: int = 0
    _window_ticks: int = 0

    def _fail(self, violation: dict[str, object]) -> None:
        self.violations.append(violation)
        if self.mode == "enforce":
            raise PoseGateError(f"render pose gate failed: {violation}")

    # -- t=0 placement ----------------------------------------------------
    def check_placement(self, actor_id: str, klass: str, *, intended: tuple[float, float],
                        actual: tuple[float, float], bottom_z: float, ground_z: float | None,
                        ground_source: str) -> None:
        planar = hypot(actual[0] - intended[0], actual[1] - intended[1])
        gap = None if ground_z is None else bottom_z - ground_z
        record: dict[str, object] = {
            "class": klass,
            "planarDisplacementM": planar,
            "groundGapM": gap,
            "groundSource": ground_source,
        }
        self.placement[actor_id] = record
        if planar > self.tolerances.placement_planar_m:
            self._fail({"code": "placement-displaced", "actorId": actor_id, **record,
                        "toleranceM": self.tolerances.placement_planar_m})
        if gap is None:
            return
        limit = self.tolerances.vehicle_ground_m if klass == VEHICLE else self.tolerances.kinematic_ground_m
        if abs(gap) > limit:
            self._fail({"code": "placement-airborne" if gap > 0 else "placement-below-ground",
                        "actorId": actor_id, **record, "toleranceM": limit})

    # -- per tick -----------------------------------------------------------
    def register(self, actor_id: str, klass: str) -> None:
        self.motion.setdefault(actor_id, _MotionTrack(klass))

    def exempt_motion(self, actor_id: str) -> None:
        """Native-physics bodies after their own contact are CARLA's to move."""
        track = self.motion.get(actor_id)
        if track is not None:
            track.exempt = True

    def observe_kinematic_readback(self, actor_id: str, frame_index: int, commanded_z: float,
                                   actual_z: float, planar_error_m: float) -> None:
        error = max(abs(actual_z - commanded_z), planar_error_m)
        self.max_kinematic_readback_m = max(self.max_kinematic_readback_m, error)
        if error > self.tolerances.kinematic_readback_m:
            self._fail({"code": "kinematic-readback-diverged", "actorId": actor_id,
                        "frame": frame_index, "errorM": error,
                        "toleranceM": self.tolerances.kinematic_readback_m})

    def observe_vehicle_ground(self, actor_id: str, frame_index: int, gap_m: float,
                               interval_s: float, post_contact: bool) -> None:
        track = self.ground.setdefault(actor_id, _GroundTrack())
        prior = self.max_ground_gap_m.get(actor_id)
        if prior is None or abs(gap_m) > abs(prior):
            self.max_ground_gap_m[actor_id] = gap_m
        tol = self.tolerances
        airborne = gap_m > tol.vehicle_airborne_m and not post_contact
        track.airborne_s = track.airborne_s + interval_s if airborne else 0.0
        track.sunk_s = track.sunk_s + interval_s if gap_m < -tol.vehicle_sunk_m else 0.0
        if track.airborne_s >= tol.vehicle_airborne_s - 1e-9:
            self._fail({"code": "vehicle-airborne", "actorId": actor_id, "frame": frame_index,
                        "gapM": gap_m, "sustainedS": track.airborne_s})
        if track.sunk_s >= tol.vehicle_sunk_s - 1e-9:
            self._fail({"code": "vehicle-below-ground", "actorId": actor_id, "frame": frame_index,
                        "gapM": gap_m, "sustainedS": track.sunk_s})

    def observe_motion(self, frame_index: int, planned: Mapping[str, tuple[float, float]],
                       actual: Mapping[str, tuple[float, float]]) -> None:
        for actor_id, target in planned.items():
            track = self.motion.get(actor_id)
            observed = actual.get(actor_id)
            if track is None or observed is None:
                continue
            if track.last_planned is not None and track.last_actual is not None:
                track.planned += hypot(target[0] - track.last_planned[0], target[1] - track.last_planned[1])
                track.actual += hypot(observed[0] - track.last_actual[0], observed[1] - track.last_actual[1])
            track.last_planned, track.last_actual = target, observed
        self._window_ticks += 1
        if self._window_ticks * self.fixed_timestep_s + 1e-9 >= self.tolerances.motion_window_s:
            self._close_window(frame_index)

    def _close_window(self, frame_index: int) -> None:
        tol = self.tolerances
        self.windows_evaluated += 1
        self._window_ticks = 0
        for actor_id, track in self.motion.items():
            moving = track.planned >= tol.motion_min_planned_m
            stalled = moving and not track.exempt and track.actual < tol.motion_min_fraction * track.planned
            track.stalled = track.stalled + 1 if stalled else 0
            if track.stalled >= tol.motion_stalled_windows:
                self._fail({"code": "actor-not-moving", "actorId": actor_id, "class": track.klass,
                            "frame": frame_index, "plannedWindowM": track.planned,
                            "actualWindowM": track.actual, "stalledWindows": track.stalled})
            track.planned = track.actual = 0.0

    def report(self) -> dict[str, object]:
        return {
            "schema": "simforge.carla-pose-gates/v1",
            "mode": self.mode,
            "verdict": "fail" if self.violations else "pass",
            "tolerances": {key: getattr(self.tolerances, key) for key in self.tolerances.__dataclass_fields__},
            "placement": {actor_id: dict(item) for actor_id, item in sorted(self.placement.items())},
            "maxKinematicReadbackErrorM": self.max_kinematic_readback_m,
            "maxVehicleGroundGapM": dict(sorted(self.max_ground_gap_m.items())),
            "motionWindowsEvaluated": self.windows_evaluated,
            "violations": list(self.violations),
        }
