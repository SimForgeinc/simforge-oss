"""Document admission and compilation to flat device tables.

Input is the current camelCase ``SimScenarioInput`` document (as JSON-decoded
Python) plus the ``EpisodeConfig`` of the training session. Output is a
:class:`CompiledScenario`: every static fact the kernels need, in id-sorted
structure-of-arrays form shared by all worlds. Anything the profile cannot
execute exactly is reported as an :class:`AdmissionIssue`; the document is
rejected as a whole when any issue exists.

Constants in this module are copied from the reference engine sources
(``sim/dynamic-v1.ts``, ``sim/controllers.ts``, ``schema/input.ts``,
``training-env/src/types.ts``). They are scientific inputs and must not be
"tuned" here.
"""

from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from .errors import AdmissionIssue, ProfileAdmissionError
from .lane_graph import LaneGraph, Route, RouteBuildError, build_lane_path_route, normalize_angle
from .profile import CAPACITIES, PROFILE_ID, REFERENCE_DT_S, REFERENCE_ENGINE_HZ

# --------------------------------------------------------------------- kinds

ACTOR_KINDS = (
    "vehicle", "car", "truck", "bus", "van", "motorcycle", "bicycle", "pedestrian",
    "scooter", "sidewalk_robot", "drone", "animal", "static_object",
)
KIND_INDEX = {k: i for i, k in enumerate(ACTOR_KINDS)}
PEDESTRIAN_LIKE = {"pedestrian", "sidewalk_robot", "drone", "animal"}
KNOCKDOWN_VULNERABLE = {"pedestrian", "animal", "sidewalk_robot"}

DEFAULT_ACTOR_DIMS: dict[str, tuple[float, float, float]] = {
    "vehicle": (4.8, 1.9, 1.5), "car": (4.8, 1.9, 1.5), "truck": (9.5, 2.5, 3.5), "bus": (12, 2.55, 3.2),
    "van": (5.5, 2, 2.2), "motorcycle": (2.2, 0.8, 1.5), "bicycle": (1.8, 0.6, 1.7), "pedestrian": (0.6, 0.6, 1.75),
    "scooter": (1.2, 0.6, 1.7), "sidewalk_robot": (0.85, 0.6, 0.85), "drone": (1, 1, 0.45), "animal": (1.2, 0.5, 1),
    "static_object": (1, 1, 1),
}

# Motion limits by kind (controllers.ts MOTION_LIMITS_BY_KIND):
# accelMax, brakeComfort, brakeHard, lateralRateMax, lateralAccelMax, lateralJerkMax
MOTION_LIMITS: dict[str, tuple[float, ...]] = {
    "vehicle": (3.0, 3.5, 8.0, 2.5, 3.0, 8.0), "car": (3.0, 3.5, 8.0, 2.5, 3.0, 8.0),
    "truck": (1.4, 2.5, 6, 1.25, 1.5, 2.5), "bus": (1.2, 2.2, 5.5, 1.1, 1.3, 2.2), "van": (2.4, 3.2, 7, 2, 2.4, 5),
    "motorcycle": (4, 4, 9, 3, 4, 8), "bicycle": (1.1, 1.5, 3.5, 1.2, 2, 4), "pedestrian": (1.5, 1.5, 3.0, 1.0, 2.0, 4.0),
    "scooter": (1.5, 2, 4, 1.5, 2.5, 5), "sidewalk_robot": (1.2, 1.8, 3.5, 1.2, 2, 4), "drone": (3, 3, 6, 3, 4, 8),
    "animal": (2, 2, 4, 1.5, 3, 6), "static_object": (0, 0, 0, 0, 0, 0),
}

# dynamic-v1 physics profile field order used by the device tables.
PHYSICS_FIELDS = (
    "massKg", "yawInertiaKgM2", "wheelbaseM", "cgToFrontM", "cgHeightM", "wheelRadiusM",
    "corneringStiffnessFrontNPerRad", "corneringStiffnessRearNPerRad", "dragCoefficientNPerMps2",
    "rollingResistanceCoefficient", "maxDriveForceN", "maxBrakeForceN", "maxSteerRad", "steerRateRadPerS",
    "steerTimeConstantS", "tireMu", "maxLongitudinalAccelMps2", "maxLongitudinalDecelMps2", "maxJerkMps3",
    "maxLateralAccelerationMps2", "maxYawRateRadps",
)
PHYSICS_INDEX = {name: i for i, name in enumerate(PHYSICS_FIELDS)}
#: 1 = single-track bicycle model, 2 = pedestrian-agent point model.
DYNAMICS_SINGLE_TRACK = 1
DYNAMICS_PEDESTRIAN_AGENT = 2

_CAR = dict(
    massKg=1_500, yawInertiaKgM2=2_500, wheelbaseM=2.7, cgToFrontM=1.2, cgHeightM=0.55, wheelRadiusM=0.31,
    corneringStiffnessFrontNPerRad=82_000, corneringStiffnessRearNPerRad=88_000, dragCoefficientNPerMps2=0.42,
    rollingResistanceCoefficient=0.012, maxDriveForceN=5_500, maxBrakeForceN=13_500, maxSteerRad=0.58,
    steerRateRadPerS=4.5, steerTimeConstantS=0.12, tireMu=1, maxLongitudinalAccelMps2=3.7,
    maxLongitudinalDecelMps2=9, maxJerkMps3=8, maxLateralAccelerationMps2=7, maxYawRateRadps=1.8,
)
ACTOR_PHYSICS_PROFILES: dict[str, dict[str, float]] = {
    "vehicle": dict(_CAR),
    "car": dict(_CAR),
    "van": {**_CAR, **dict(
        massKg=2_600, yawInertiaKgM2=5_200, wheelbaseM=3.35, cgToFrontM=1.55, cgHeightM=0.78, wheelRadiusM=0.36,
        corneringStiffnessFrontNPerRad=105_000, corneringStiffnessRearNPerRad=118_000, dragCoefficientNPerMps2=0.72,
        rollingResistanceCoefficient=0.014, maxDriveForceN=7_500, maxBrakeForceN=22_000, maxSteerRad=0.54,
        steerRateRadPerS=2.5, steerTimeConstantS=0.2, tireMu=0.92, maxLongitudinalAccelMps2=2.5,
        maxLongitudinalDecelMps2=7.2, maxJerkMps3=5, maxLateralAccelerationMps2=5, maxYawRateRadps=1.25)},
    "truck": {**_CAR, **dict(
        massKg=12_000, yawInertiaKgM2=48_000, wheelbaseM=5.2, cgToFrontM=2.25, cgHeightM=1.25, wheelRadiusM=0.5,
        corneringStiffnessFrontNPerRad=230_000, corneringStiffnessRearNPerRad=310_000, dragCoefficientNPerMps2=2.1,
        rollingResistanceCoefficient=0.009, maxDriveForceN=42_000, maxBrakeForceN=92_000, maxSteerRad=0.44,
        steerRateRadPerS=0.75, steerTimeConstantS=0.38, tireMu=0.78, maxLongitudinalAccelMps2=1.5,
        maxLongitudinalDecelMps2=5.5, maxJerkMps3=2.5, maxLateralAccelerationMps2=3.1, maxYawRateRadps=0.65)},
    "bus": {**_CAR, **dict(
        massKg=13_500, yawInertiaKgM2=66_000, wheelbaseM=6.0, cgToFrontM=2.7, cgHeightM=1.15, wheelRadiusM=0.51,
        corneringStiffnessFrontNPerRad=250_000, corneringStiffnessRearNPerRad=330_000, dragCoefficientNPerMps2=1.85,
        rollingResistanceCoefficient=0.01, maxDriveForceN=39_000, maxBrakeForceN=105_000, maxSteerRad=0.46,
        steerRateRadPerS=0.68, steerTimeConstantS=0.42, tireMu=0.8, maxLongitudinalAccelMps2=1.35,
        maxLongitudinalDecelMps2=5.2, maxJerkMps3=2.2, maxLateralAccelerationMps2=2.8, maxYawRateRadps=0.58)},
    "motorcycle": {**_CAR, **dict(
        massKg=240, yawInertiaKgM2=145, wheelbaseM=1.45, cgToFrontM=0.68, cgHeightM=0.58, wheelRadiusM=0.3,
        corneringStiffnessFrontNPerRad=14_000, corneringStiffnessRearNPerRad=17_000, dragCoefficientNPerMps2=0.28,
        rollingResistanceCoefficient=0.015, maxDriveForceN=1_750, maxBrakeForceN=2_200, maxSteerRad=0.62,
        steerRateRadPerS=3.2, steerTimeConstantS=0.16, tireMu=0.95, maxLongitudinalAccelMps2=4.8,
        maxLongitudinalDecelMps2=8.2, maxJerkMps3=7, maxLateralAccelerationMps2=6.5, maxYawRateRadps=2.4)},
    "bicycle": {**_CAR, **dict(
        massKg=95, yawInertiaKgM2=28, wheelbaseM=1.08, cgToFrontM=0.48, cgHeightM=0.75, wheelRadiusM=0.34,
        corneringStiffnessFrontNPerRad=1_100, corneringStiffnessRearNPerRad=1_350, dragCoefficientNPerMps2=0.3,
        rollingResistanceCoefficient=0.006, maxDriveForceN=420, maxBrakeForceN=750, maxSteerRad=0.7,
        steerRateRadPerS=2.2, steerTimeConstantS=0.24, tireMu=0.82, maxLongitudinalAccelMps2=1.8,
        maxLongitudinalDecelMps2=5, maxJerkMps3=3.5, maxLateralAccelerationMps2=3.5, maxYawRateRadps=2.1)},
    "scooter": {**_CAR, **dict(
        massKg=115, yawInertiaKgM2=34, wheelbaseM=1.15, cgToFrontM=0.52, cgHeightM=0.67, wheelRadiusM=0.25,
        corneringStiffnessFrontNPerRad=1_800, corneringStiffnessRearNPerRad=2_100, dragCoefficientNPerMps2=0.32,
        rollingResistanceCoefficient=0.012, maxDriveForceN=620, maxBrakeForceN=950, maxSteerRad=0.68,
        steerRateRadPerS=2.5, steerTimeConstantS=0.2, tireMu=0.86, maxLongitudinalAccelMps2=2.4,
        maxLongitudinalDecelMps2=5.8, maxJerkMps3=4, maxLateralAccelerationMps2=3.8, maxYawRateRadps=2.2)},
    "sidewalk_robot": {**_CAR, **dict(
        massKg=70, yawInertiaKgM2=18, wheelbaseM=0.55, cgToFrontM=0.28, cgHeightM=0.4, wheelRadiusM=0.11,
        corneringStiffnessFrontNPerRad=1, corneringStiffnessRearNPerRad=1, dragCoefficientNPerMps2=0.09,
        rollingResistanceCoefficient=0.012, maxDriveForceN=420, maxBrakeForceN=650, maxSteerRad=0.01,
        steerRateRadPerS=0.01, steerTimeConstantS=0.2, tireMu=0.85, maxLongitudinalAccelMps2=1.8,
        maxLongitudinalDecelMps2=3.5, maxJerkMps3=4, maxLateralAccelerationMps2=2, maxYawRateRadps=3)},
    "drone": {**_CAR, **dict(
        massKg=12, yawInertiaKgM2=4, wheelbaseM=0.5, cgToFrontM=0.25, cgHeightM=0.25, wheelRadiusM=0.08,
        corneringStiffnessFrontNPerRad=1, corneringStiffnessRearNPerRad=1, dragCoefficientNPerMps2=0.16,
        rollingResistanceCoefficient=0, maxDriveForceN=500, maxBrakeForceN=600, maxSteerRad=0.01,
        steerRateRadPerS=0.01, steerTimeConstantS=0.1, tireMu=1, maxLongitudinalAccelMps2=3,
        maxLongitudinalDecelMps2=5, maxJerkMps3=8, maxLateralAccelerationMps2=4, maxYawRateRadps=4)},
    "pedestrian": {**_CAR, **dict(
        massKg=78, yawInertiaKgM2=9, wheelbaseM=0.5, cgToFrontM=0.25, cgHeightM=0.9, wheelRadiusM=0.16,
        corneringStiffnessFrontNPerRad=1, corneringStiffnessRearNPerRad=1, dragCoefficientNPerMps2=0.08,
        rollingResistanceCoefficient=0, maxDriveForceN=350, maxBrakeForceN=500, maxSteerRad=0.01,
        steerRateRadPerS=0.01, steerTimeConstantS=0.25, tireMu=0.9, maxLongitudinalAccelMps2=1.6,
        maxLongitudinalDecelMps2=3.2, maxJerkMps3=4, maxLateralAccelerationMps2=1.8, maxYawRateRadps=3)},
    "animal": {**_CAR, **dict(
        massKg=45, yawInertiaKgM2=5, wheelbaseM=0.5, cgToFrontM=0.25, cgHeightM=0.5, wheelRadiusM=0.14,
        corneringStiffnessFrontNPerRad=1, corneringStiffnessRearNPerRad=1, dragCoefficientNPerMps2=0.08,
        rollingResistanceCoefficient=0, maxDriveForceN=310, maxBrakeForceN=390, maxSteerRad=0.01,
        steerRateRadPerS=0.01, steerTimeConstantS=0.2, tireMu=0.9, maxLongitudinalAccelMps2=2.5,
        maxLongitudinalDecelMps2=3.8, maxJerkMps3=5, maxLateralAccelerationMps2=2.5, maxYawRateRadps=3.5)},
}
CHILD_PEDESTRIAN_PHYSICS_PROFILE = dict(massKg=32, yawInertiaKgM2=3.2, cgHeightM=0.58, maxDriveForceN=145, maxBrakeForceN=205)
DYNAMIC_V1_DEFAULT_SUBSTEP_S = 0.005
#: The removed choreography mode. Documents that pinned it migrate to
#: ``dynamic-v1`` on admission, matching the engine's own parse migration.
LEGACY_KINEMATIC_PHYSICS_MODE = "kinematic-v1"

DEFAULT_REWARD = dict(collisionPenalty=-10.0, goalBonus=10.0, progressWeight=0.05, proximityWeight=0.02,
                      proximityRangeM=15.0, comfortAccelWeight=0.005)
DEFAULT_OBJECT_LIST_RANGE_M = 60.0

# enum encodings shared with kernels.py
VERB_SPEED, VERB_GAP, VERB_EXIST = 1, 2, 3
TRIGGER_AT, TRIGGER_AFTER, TRIGGER_WHEN = 0, 1, 2
SPEED_ABSOLUTE, SPEED_DELTA, SPEED_FACTOR, SPEED_MATCH, SPEED_STOP = 0, 1, 2, 3, 4
SHAPE_STEP, SHAPE_LINEAR, SHAPE_SINUSOIDAL, SHAPE_CUBIC = 0, 1, 2, 3
CONSTRAINT_RATE, CONSTRAINT_TIME, CONSTRAINT_DISTANCE = 0, 1, 2
GAP_TIME, GAP_DISTANCE = 0, 1
COND_LEAF, COND_AND, COND_OR, COND_NOT = 0, 1, 2, 3
LEAF_DISTANCE, LEAF_HEADWAY, LEAF_REACHES, LEAF_SPEED, LEAF_STANDSTILL, LEAF_COLLISION = 0, 1, 2, 3, 4, 5
CMP_LT, CMP_LTE, CMP_GT, CMP_GTE = 0, 1, 2, 3
DIST_ALONG_LANE, DIST_EUCLIDEAN = 0, 1
REGION_CIRCLE, REGION_POLYGON, REGION_LANE_WINDOW = 0, 1, 2

_CMP = {"lt": CMP_LT, "lte": CMP_LTE, "gt": CMP_GT, "gte": CMP_GTE}
_SHAPE = {"step": SHAPE_STEP, "linear": SHAPE_LINEAR, "sinusoidal": SHAPE_SINUSOIDAL, "cubic": SHAPE_CUBIC}
_CONSTRAINT = {"rate": CONSTRAINT_RATE, "time": CONSTRAINT_TIME, "distance": CONSTRAINT_DISTANCE}


# ------------------------------------------------------------- episode config


@dataclass(frozen=True)
class EpisodeConfig:
    """``EpisodeConfig`` of ``@simforge-oss/training-env`` with defaults applied."""

    decision_hz: int = 10
    clip_seconds: float | None = None
    warmup_excluded: bool = True
    max_decisions: int | None = None
    goal_interaction_id: str | None = None
    goal_route_end: bool = False
    reward: dict[str, float] = field(default_factory=lambda: dict(DEFAULT_REWARD))
    state_vector: bool = True
    object_list_range_m: float = DEFAULT_OBJECT_LIST_RANGE_M

    @classmethod
    def from_document(cls, cfg: dict[str, Any] | None) -> "EpisodeConfig":
        cfg = dict(cfg or {})
        goal = cfg.get("goal") or {}
        observation = cfg.get("observation") or {}
        reward = {**DEFAULT_REWARD, **(cfg.get("reward") or {})}
        if observation.get("bev") is not None:
            raise ProfileAdmissionError([AdmissionIssue(
                "unsupported_observation", "episode.observation.bev", "BEV raster observation is not on device")])
        return cls(
            decision_hz=int(cfg.get("decisionHz", 10)),
            clip_seconds=cfg.get("clipSeconds"),
            warmup_excluded=bool(cfg.get("warmupExcluded", True)),
            max_decisions=cfg.get("maxDecisions"),
            goal_interaction_id=goal.get("interactionId"),
            goal_route_end=bool(goal.get("routeEnd", False)),
            reward={k: float(v) for k, v in reward.items()},
            state_vector=bool(observation.get("stateVector", True)),
            object_list_range_m=float(observation.get("objectListRangeM", DEFAULT_OBJECT_LIST_RANGE_M)),
        )


# ---------------------------------------------------------- compiled output


@dataclass
class CompiledScenario:
    """Static, id-sorted tables shared by every world of a batch."""

    profile_id: str
    document_digest: str
    map_name: str
    topology_digest: str
    actor_ids: list[str]
    interaction_ids: list[str]
    ego_index: int
    perception_ego_index: int
    episode: EpisodeConfig
    dt: float
    substep_s: float
    warmup_ticks: int
    clip_ticks: int
    decision_ticks: int
    clip_seconds: float
    seed: int | str
    friction_scale: float
    visibility_range_m: float
    traffic_speed_factor: float
    tables: dict[str, np.ndarray]
    counts: dict[str, int]
    input_document: dict[str, Any]

    @property
    def num_actors(self) -> int:
        return len(self.actor_ids)


class _Compiler:
    def __init__(self, document: dict[str, Any], graph: LaneGraph, episode: EpisodeConfig) -> None:
        self.doc = document
        self.graph = graph
        self.episode = episode
        self.issues: list[AdmissionIssue] = []

    def issue(self, code: str, path: str, message: str) -> None:
        self.issues.append(AdmissionIssue(code, path, message))

    # ------------------------------------------------------------ document

    def compile(self) -> CompiledScenario:
        doc = self.doc
        if doc.get("schemaVersion", 1) != 1:
            self.issue("unsupported_schema", "schemaVersion", "only schemaVersion 1 is accepted")
        dt = float(doc.get("dt", REFERENCE_DT_S))
        if abs(dt - REFERENCE_DT_S) > 1e-12:
            self.issue("unsupported_dt", "dt", f"decision boundaries require dt = {REFERENCE_DT_S}, got {dt}")
        hz = self.episode.decision_hz
        if hz <= 0 or REFERENCE_ENGINE_HZ % hz != 0:
            self.issue("invalid_decision_hz", "episode.decisionHz", f"must be a positive integer dividing {REFERENCE_ENGINE_HZ}")
        clip_seconds = float(self.episode.clip_seconds if self.episode.clip_seconds is not None else doc.get("clipSeconds", 20))
        warmup_seconds = float(doc.get("warmupSeconds", 5))
        physics = doc.get("physics") or {"mode": "dynamic-v1"}
        # ``dynamic-v1`` is the only motion backend. A document that pinned the
        # removed ``kinematic-v1`` choreography model migrates to it here, the
        # same way the engine migrates it on load, so a document the studio
        # opens is never a document this device profile refuses.
        mode = physics.get("mode", "dynamic-v1")
        if mode not in ("dynamic-v1", LEGACY_KINEMATIC_PHYSICS_MODE):
            self.issue("unsupported_physics", "physics.mode", f"{mode} is not the force-based device profile")
        substep = float(physics.get("substepS") or DYNAMIC_V1_DEFAULT_SUBSTEP_S)
        if not substep > 0:
            self.issue("invalid_substep", "physics.substepS", "must be positive")

        effects = ((doc.get("operationalConditions") or {}).get("effects")) or {}
        friction_scale = float(effects.get("frictionScale", 1.0))
        visibility_range = float(effects.get("visibilityRangeM", 10_000.0))
        traffic_speed_factor = float(effects.get("trafficSpeedFactor", 1.0))

        for key, reason in (
            ("signalPrograms", "stop-line authority is not on device"),
            ("roadControls", "stop-line authority is not on device"),
            ("surfacePatches", "non-uniform friction field is not on device"),
            ("occlusionPairs", "pair metrics are not produced by the batch"),
        ):
            if doc.get(key):
                self.issue("unsupported_feature", key, reason)
        if doc.get("perception") is not None:
            self.issue("unsupported_feature", "perception", "perception runtime is host-only")

        actors = sorted(doc.get("actors") or [], key=lambda a: a["id"])
        if not actors:
            self.issue("no_actors", "actors", "document has no actors")
        if len(actors) > CAPACITIES["maxActors"]:
            self.issue("capacity_exceeded", "actors", f"{len(actors)} actors exceed maxActors={CAPACITIES['maxActors']}")
        ids = [a["id"] for a in actors]
        if len(set(ids)) != len(ids):
            self.issue("duplicate_actor_id", "actors", "actor ids must be unique")
        self.actor_index = {aid: i for i, aid in enumerate(ids)}

        interactions = sorted(doc.get("interactions") or [], key=lambda it: it["id"])
        if len(interactions) > CAPACITIES["maxInteractions"]:
            self.issue("capacity_exceeded", "interactions", f"{len(interactions)} exceed maxInteractions")
        self.interaction_index = {it["id"]: i for i, it in enumerate(interactions)}

        tables: dict[str, np.ndarray] = {}
        counts: dict[str, int] = {}
        self._compile_lanes(tables, counts)
        self._compile_actors(actors, physics, traffic_speed_factor, tables, counts)
        self._compile_props(tables, counts)
        self._compile_occluders(tables, counts)
        self._compile_interactions(interactions, tables, counts)

        ego = self._resolve_ego(actors)
        perception_ego = self._resolve_perception_ego(actors)

        if self.episode.goal_interaction_id is not None and self.episode.goal_interaction_id not in self.interaction_index:
            # Reference: goal never met when the interaction does not exist. Admit but record -1.
            pass

        if self.issues:
            raise ProfileAdmissionError(self.issues)

        canonical = json.dumps(doc, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        warmup_ticks = int(round(warmup_seconds / dt))
        clip_ticks = int(round(clip_seconds / dt))
        return CompiledScenario(
            profile_id=PROFILE_ID,
            document_digest=digest,
            map_name=self.graph.map_name,
            topology_digest=self.graph.topology_digest,
            actor_ids=ids,
            interaction_ids=[it["id"] for it in interactions],
            ego_index=ego,
            perception_ego_index=perception_ego,
            episode=self.episode,
            dt=dt,
            substep_s=substep,
            warmup_ticks=warmup_ticks,
            clip_ticks=clip_ticks,
            decision_ticks=REFERENCE_ENGINE_HZ // hz,
            clip_seconds=clip_seconds,
            seed=doc.get("seed", 0),
            friction_scale=friction_scale,
            visibility_range_m=visibility_range,
            traffic_speed_factor=traffic_speed_factor,
            tables=tables,
            counts=counts,
            input_document=doc,
        )

    # --------------------------------------------------------------- lanes

    def _compile_lanes(self, tables: dict[str, np.ndarray], counts: dict[str, int]) -> None:
        lanes = self.graph.lanes
        pt_start, pt_count, ws_start, ws_count = [], [], [], []
        xs, ys, cums, heads = [], [], [], []
        ws_s, ws_w = [], []
        length, speed, width = [], [], []
        for g in lanes:
            pt_start.append(len(xs))
            pt_count.append(len(g.points))
            xs.extend(g.points[:, 0].tolist())
            ys.extend(g.points[:, 1].tolist())
            cums.extend(g.cum.tolist())
            heads.extend(g.headings.tolist())
            ws_start.append(len(ws_s))
            ws_count.append(len(g.width_samples))
            ws_s.extend(g.width_samples[:, 0].tolist())
            ws_w.extend(g.width_samples[:, 1].tolist())
            length.append(g.length_m)
            speed.append(g.speed_limit_mps)
            width.append(g.width_m)
        if len(xs) > CAPACITIES["maxLaneVertices"]:
            self.issue("capacity_exceeded", "topology", f"{len(xs)} lane vertices exceed maxLaneVertices")
        if len(ws_s) > CAPACITIES["maxWidthSamples"]:
            self.issue("capacity_exceeded", "topology", f"{len(ws_s)} width samples exceed maxWidthSamples")
        f64 = np.float64
        i32 = np.int32
        tables.update(
            lane_pt_start=np.asarray(pt_start, i32), lane_pt_count=np.asarray(pt_count, i32),
            lane_ws_start=np.asarray(ws_start, i32), lane_ws_count=np.asarray(ws_count, i32),
            lane_pt_x=np.asarray(xs, f64), lane_pt_y=np.asarray(ys, f64), lane_pt_cum=np.asarray(cums, f64),
            lane_pt_heading=np.asarray(heads, f64), lane_ws_s=np.asarray(ws_s, f64), lane_ws_w=np.asarray(ws_w, f64),
            lane_length=np.asarray(length, f64), lane_speed_limit=np.asarray(speed, f64), lane_width=np.asarray(width, f64),
        )
        counts["lanes"] = len(lanes)
        counts["lane_vertices"] = len(xs)
        counts["width_samples"] = len(ws_s)

    # -------------------------------------------------------------- actors

    def _compile_actors(self, actors: list[dict[str, Any]], physics: dict[str, Any], traffic_speed_factor: float,
                        tables: dict[str, np.ndarray], counts: dict[str, int]) -> None:
        n = len(actors)
        f64, i32 = np.float64, np.int32
        kind = np.zeros(n, i32)
        dims = np.zeros((n, 3), f64)
        is_static = np.zeros(n, i32)
        is_dynamic = np.zeros(n, i32)
        rules = np.zeros((n, 7), f64)  # obeySignals, yield, yieldToVehicles, yieldToPedestrians, collisionAvoidance, aggression, speedFactor
        comfort = np.zeros((n, 2), f64)  # comfortableLateralAccelerationMps2, comfortableDecelerationMps2
        limits = np.zeros((n, 6), f64)
        phys = np.zeros((n, len(PHYSICS_FIELDS)), f64)
        dyn_model = np.zeros(n, i32)
        init = np.zeros((n, 6), f64)  # x, y, heading, speed, routeS, lateral
        present_at_start = np.zeros(n, i32)
        cruise_override_valid = np.zeros(n, i32)
        cruise_override = np.zeros(n, f64)
        motion_direction = np.ones(n, i32)
        route_leg_start = np.zeros(n, i32)
        route_leg_count = np.zeros(n, i32)
        route_length = np.zeros(n, f64)
        leg_lane, leg_reversed, leg_s_start, leg_length = [], [], [], []
        vehicle_profiles = physics.get("vehicleProfiles") or {}
        self.routes: list[Route | None] = []

        for i, a in enumerate(actors):
            path = f"actors.{a['id']}"
            k = a.get("kind")
            if k not in KIND_INDEX:
                self.issue("unsupported_kind", f"{path}.kind", f"unknown actor kind {k!r}")
                k = "static_object"
            kind[i] = KIND_INDEX[k]
            d = a.get("dims") or {}
            default_dims = DEFAULT_ACTOR_DIMS[k]
            dims[i] = (float(d.get("l", default_dims[0])), float(d.get("w", default_dims[1])), float(d.get("h", default_dims[2])))
            tags = list(a.get("tags") or [])
            if "ambient" in tags:
                self.issue("unsupported_feature", f"{path}.tags", "ambient traffic (seeded driver variation, reactive scan) is not on device")
            if a.get("sensors"):
                self.issue("unsupported_feature", f"{path}.sensors", "perception sensors are host-only")
            static = k == "static_object" or bool(a.get("static", False))
            is_static[i] = int(static)
            is_dynamic[i] = int(not static)
            behavior = a.get("behavior") or {}
            r = behavior.get("rules") or {}
            rules[i] = (
                float(r.get("obeySignals", True)), float(r.get("yield", True)), float(r.get("yieldToVehicles", True)),
                float(r.get("yieldToPedestrians", True)), float(r.get("collisionAvoidance", True)),
                float(r.get("aggression", 0.5)), float(r.get("speedFactor", 1.0)),
            )
            dp = behavior.get("drivingProfile") or {}
            comfort[i] = (float(dp.get("comfortableLateralAccelerationMps2", 2.2)), float(dp.get("comfortableDecelerationMps2", 2.5)))
            limits[i] = MOTION_LIMITS[k]
            present_at_start[i] = int(a.get("presentAtStart", True))
            cs = behavior.get("cruiseSpeedMps")
            if cs is not None:
                cruise_override_valid[i] = 1
                cruise_override[i] = float(cs) * traffic_speed_factor
            motion_direction[i] = -1 if "motion:reverse" in tags else 1

            if k != "static_object":
                profile = dict(ACTOR_PHYSICS_PROFILES[k])
                override = dict(vehicle_profiles.get(a["id"]) or {})
                if "catalog:pedestrian.child" in tags:
                    override = {**CHILD_PEDESTRIAN_PHYSICS_PROFILE, **override}
                profile.update({kk: float(vv) for kk, vv in override.items() if kk in PHYSICS_INDEX})
                if profile["cgToFrontM"] >= profile["wheelbaseM"]:
                    self.issue("invalid_physics_profile", f"physics.vehicleProfiles.{a['id']}", "cgToFrontM must be less than wheelbaseM")
                phys[i] = [profile[name] for name in PHYSICS_FIELDS]
                dyn_model[i] = DYNAMICS_PEDESTRIAN_AGENT if k in PEDESTRIAN_LIKE else DYNAMICS_SINGLE_TRACK

            route_spec = behavior.get("route") or {}
            route: Route | None = None
            if route_spec.get("kind") != "lanePath":
                self.issue("unsupported_route", f"{path}.behavior.route", f"route kind {route_spec.get('kind')!r} is not lanePath")
            else:
                try:
                    route = build_lane_path_route(self.graph, list(route_spec.get("lanes") or []))
                except RouteBuildError as exc:
                    self.issue(exc.code, f"{path}.behavior.route", exc.reason)
            self.routes.append(route)
            route_leg_start[i] = len(leg_lane)
            if route is not None:
                route_leg_count[i] = len(route.legs)
                route_length[i] = route.length_m
                for leg in route.legs:
                    leg_lane.append(leg.lane.index)
                    leg_reversed.append(int(leg.reversed))
                    leg_s_start.append(leg.s_start)
                    leg_length.append(leg.length_m)
                pose = a.get("initial", {}).get("pose") or {}
                px = float(pose.get("x", 0.0))
                py = -float(pose.get("z", 0.0))
                s, _ = route.project_point(px, py)
                lateral = route.lateral_offset_at(s, px, py)
                heading = normalize_angle(float(pose.get("headingRad", 0.0)))
                if motion_direction[i] == -1:
                    heading = normalize_angle(route.pose_at(s).heading_rad + math.pi)
                speed = 0.0 if static else float(a.get("initial", {}).get("speedMps", 0.0))
                init[i] = (px, py, heading, speed, s, lateral)
        if len(leg_lane) > CAPACITIES["maxRouteLegs"]:
            self.issue("capacity_exceeded", "actors", f"{len(leg_lane)} route legs exceed maxRouteLegs")
        tables.update(
            actor_kind=kind, actor_dims=dims, actor_static=is_static, actor_dynamic=is_dynamic, actor_rules=rules,
            actor_comfort=comfort, actor_limits=limits, actor_physics=phys, actor_dynamics_model=dyn_model,
            actor_init=init, actor_present_at_start=present_at_start, actor_cruise_override_valid=cruise_override_valid,
            actor_cruise_override=cruise_override, actor_motion_direction=motion_direction,
            actor_route_leg_start=route_leg_start, actor_route_leg_count=route_leg_count, actor_route_length=route_length,
            leg_lane=np.asarray(leg_lane, i32), leg_reversed=np.asarray(leg_reversed, i32),
            leg_s_start=np.asarray(leg_s_start, f64), leg_length=np.asarray(leg_length, f64),
            actor_pedestrian_like=np.asarray([int(ACTOR_KINDS[k] in PEDESTRIAN_LIKE) for k in kind], i32),
            actor_knockdown_vulnerable=np.asarray([int(ACTOR_KINDS[k] in KNOCKDOWN_VULNERABLE) for k in kind], i32),
            actor_road_actor=np.asarray([int(ACTOR_KINDS[k] not in PEDESTRIAN_LIKE and ACTOR_KINDS[k] != "static_object") for k in kind], i32),
        )
        counts["actors"] = n
        counts["route_legs"] = len(leg_lane)

    # --------------------------------------------------------------- props

    def _compile_props(self, tables: dict[str, np.ndarray], counts: dict[str, int]) -> None:
        props = self.doc.get("props") or []
        colliders: list[tuple[str, float, float, float, float, float]] = []
        for p in props:
            if p.get("attachment") is not None:
                self.issue("unsupported_feature", f"props.{p.get('id')}", "attached props are not on device")
                continue
            if not p.get("collidable", False):
                continue
            pose = p.get("pose") or {}
            dims = p.get("dims") or {}
            scale = float(p.get("scale", 1.0))
            colliders.append((
                f"prop:{p['id']}", float(pose.get("x", 0.0)), -float(pose.get("z", 0.0)),
                float(dims.get("l", 1.0)) * scale, float(dims.get("w", 1.0)) * scale, float(pose.get("headingRad", 0.0)),
            ))
        if len(colliders) > CAPACITIES["maxStaticColliders"]:
            self.issue("capacity_exceeded", "props", f"{len(colliders)} static colliders exceed maxStaticColliders")
        colliders.sort(key=lambda c: c[0])
        self.collider_ids = [c[0] for c in colliders]
        arr = np.asarray([c[1:] for c in colliders], np.float64).reshape(-1, 5)
        tables["collider_obb"] = arr  # x, y, l, w, heading
        counts["colliders"] = len(colliders)
        # Canonical body order for the contact solver: actors and colliders
        # sorted together by id (code-point order, see NUMERICS_NOTES).
        bodies = [(aid, i) for i, aid in enumerate(self.actor_index)] + [(cid, len(self.actor_index) + j) for j, cid in enumerate(self.collider_ids)]
        bodies.sort(key=lambda b: b[0])
        tables["solver_body_order"] = np.asarray([b[1] for b in bodies], np.int32)

    # ----------------------------------------------------------- occluders

    def _compile_occluders(self, tables: dict[str, np.ndarray], counts: dict[str, int]) -> None:
        occluders = sorted(self.doc.get("occluders") or [], key=lambda o: o["id"])
        if len(occluders) > CAPACITIES["maxOccluders"]:
            self.issue("capacity_exceeded", "occluders", f"{len(occluders)} exceed maxOccluders")
        rows = []
        for o in occluders:
            obb = o.get("obb") or {}
            c = obb.get("center") or {}
            rows.append((float(c.get("x", 0.0)), -float(c.get("z", 0.0)), float(obb.get("lengthM", 1.0)),
                         float(obb.get("widthM", 1.0)), float(obb.get("headingRad", 0.0))))
        tables["occluder_obb"] = np.asarray(rows, np.float64).reshape(-1, 5)
        counts["occluders"] = len(rows)

    # -------------------------------------------------------- interactions

    def _compile_interactions(self, interactions: list[dict[str, Any]], tables: dict[str, np.ndarray],
                              counts: dict[str, int]) -> None:
        n = len(interactions)
        f64, i32 = np.float64, np.int32
        it_actor = np.full(n, -1, i32)
        it_verb = np.zeros(n, i32)
        it_trigger = np.zeros(n, i32)
        it_f = np.zeros((n, 12), f64)
        # f columns: 0 at_t, 1 after_delay, 2 by_latest, 3 window_start, 4 window_end,
        #            5 speed_value, 6 match_offset, 7 dyn_value, 8 gap_value, 9 unused, 10 unused, 11 unused
        it_i = np.zeros((n, 12), i32)
        # i columns: 0 after_ref, 1 after_event(0 start,1 end), 2 when_cond, 3 if_never(0 skip,1 fire), 4 window_valid,
        #            5 until_cond, 6 speed_mode, 7 match_actor, 8 dyn_shape, 9 dyn_constraint, 10 gap_actor, 11 gap_mode|exist_present
        self.cond_roots: list[tuple[int, int, int]] = []
        self.leaves: list[list[float]] = []
        self.polygon_pts: list[tuple[float, float]] = []

        for j, it in enumerate(interactions):
            path = f"interactions.{it['id']}"
            aid = it.get("actorId")
            if aid not in self.actor_index:
                self.issue("unknown_actor", f"{path}.actorId", f"actor {aid!r} not in document")
            else:
                it_actor[j] = self.actor_index[aid]
            verb = it.get("verb")
            if verb == "speed":
                it_verb[j] = VERB_SPEED
                target = it.get("target") or {}
                mode = target.get("mode")
                table = {"absolute": SPEED_ABSOLUTE, "delta": SPEED_DELTA, "factor": SPEED_FACTOR, "match": SPEED_MATCH, "stop": SPEED_STOP}
                if mode not in table:
                    self.issue("unsupported_verb_target", f"{path}.target.mode", f"speed mode {mode!r}")
                else:
                    it_i[j, 6] = table[mode]
                    it_f[j, 5] = float(target.get("value", 0.0))
                    if mode == "match":
                        other = target.get("actorId")
                        it_i[j, 7] = self.actor_index.get(other, -1)
                        it_f[j, 6] = float(target.get("offsetMps", 0.0))
                self._dynamics(it, path, j, it_i, it_f)
            elif verb == "gap":
                it_verb[j] = VERB_GAP
                other = (it.get("target") or {}).get("actorId")
                if other not in self.actor_index:
                    self.issue("unknown_actor", f"{path}.target.actorId", f"actor {other!r} not in document")
                it_i[j, 10] = self.actor_index.get(other, -1)
                it_f[j, 8] = float(it.get("value", 0.0))
                it_i[j, 11] = GAP_TIME if it.get("mode") == "time" else GAP_DISTANCE
                self._dynamics(it, path, j, it_i, it_f)
            elif verb == "exist":
                it_verb[j] = VERB_EXIST
                it_i[j, 11] = int((it.get("target") or {}).get("state") == "present")
            else:
                self.issue("unsupported_verb", f"{path}.verb", f"verb {verb!r} is not on device (supported: speed, gap, exist)")

            trig = it.get("trigger") or {}
            tk = trig.get("kind")
            if tk == "at":
                it_trigger[j] = TRIGGER_AT
                it_f[j, 0] = float(trig.get("t", 0.0))
            elif tk == "after":
                it_trigger[j] = TRIGGER_AFTER
                it_i[j, 0] = self.interaction_index.get(trig.get("interactionId"), -1)
                it_i[j, 1] = 1 if trig.get("event") == "end" else 0
                it_f[j, 1] = float(trig.get("delayS", 0.0))
            elif tk == "when":
                it_trigger[j] = TRIGGER_WHEN
                it_i[j, 2] = self._condition(trig.get("condition"), f"{path}.trigger.condition")
                it_f[j, 2] = float(trig.get("byLatest", 0.0))
                it_i[j, 3] = 1 if trig.get("ifNever") == "fire" else 0
            else:
                self.issue("unsupported_trigger", f"{path}.trigger.kind", f"trigger {tk!r} is not on device (supported: at, after, when)")
            window = it.get("window")
            if window:
                it_i[j, 4] = 1
                it_f[j, 3] = float(window.get("startS", 0.0))
                it_f[j, 4] = float(window.get("endS", 0.0))
            it_i[j, 5] = self._condition(it["until"], f"{path}.until") if it.get("until") is not None else -1

        leaves = np.asarray(self.leaves, np.float64).reshape(-1, 16)
        if len(leaves) > CAPACITIES["maxConditionLeaves"]:
            self.issue("capacity_exceeded", "interactions", f"{len(leaves)} condition leaves exceed maxConditionLeaves")
        if len(self.polygon_pts) > CAPACITIES["maxPolygonPoints"]:
            self.issue("capacity_exceeded", "interactions", f"{len(self.polygon_pts)} polygon points exceed maxPolygonPoints")
        tables.update(
            it_actor=it_actor, it_verb=it_verb, it_trigger=it_trigger, it_f=it_f, it_i=it_i,
            cond_root=np.asarray(self.cond_roots, np.int32).reshape(-1, 3),
            cond_leaf=leaves,
            polygon_pts=np.asarray(self.polygon_pts, np.float64).reshape(-1, 2),
        )
        counts["interactions"] = n
        counts["conditions"] = len(self.cond_roots)
        counts["condition_leaves"] = len(leaves)
        counts["polygon_points"] = len(self.polygon_pts)

    def _dynamics(self, it: dict[str, Any], path: str, j: int, it_i: np.ndarray, it_f: np.ndarray) -> None:
        dyn = it.get("dynamics") or {}
        shape = dyn.get("shape")
        constraint = dyn.get("constraint")
        if shape not in _SHAPE or constraint not in _CONSTRAINT:
            self.issue("invalid_dynamics", f"{path}.dynamics", f"shape {shape!r} / constraint {constraint!r}")
            return
        it_i[j, 8] = _SHAPE[shape]
        it_i[j, 9] = _CONSTRAINT[constraint]
        it_f[j, 7] = float(dyn.get("value", 0.0))

    def _condition(self, cond: dict[str, Any] | None, path: str) -> int:
        """Compile a (shallow) condition tree; returns its root index."""
        if not cond:
            self.issue("invalid_condition", path, "missing condition")
            return -1
        kind = cond.get("kind")
        if kind in ("and", "or"):
            children = cond.get("of") or []
            start = len(self.leaves)
            for c, child in enumerate(children):
                self._leaf(child, f"{path}.of[{c}]")
            self.cond_roots.append((COND_AND if kind == "and" else COND_OR, start, len(self.leaves) - start))
        elif kind == "not":
            start = len(self.leaves)
            self._leaf(cond.get("of"), f"{path}.of")
            self.cond_roots.append((COND_NOT, start, len(self.leaves) - start))
        else:
            start = len(self.leaves)
            self._leaf(cond, path)
            self.cond_roots.append((COND_LEAF, start, len(self.leaves) - start))
        return len(self.cond_roots) - 1

    def _leaf(self, cond: dict[str, Any] | None, path: str) -> None:
        # leaf columns: 0 kind, 1 a, 2 b, 3 mode/region kind, 4 cmp, 5 value, 6 hysteresis,
        #               7 cx/poly start/lane, 8 cy/poly count/sMin, 9 radius/sMax, 10 duration, 11-15 unused
        row = [0.0] * 16
        if not cond:
            self.issue("invalid_condition", path, "missing condition")
            return
        kind = cond.get("kind")
        row[1] = float(self.actor_index.get(cond.get("a"), -1)) if "a" in cond else -1.0
        row[2] = float(self.actor_index.get(cond.get("b"), -1)) if "b" in cond else -1.0
        if kind == "distance":
            row[0] = LEAF_DISTANCE
            row[3] = DIST_EUCLIDEAN if cond.get("mode") == "euclidean" else DIST_ALONG_LANE
            row[4] = float(_CMP.get(cond.get("cmp"), CMP_LT))
            row[5] = float(cond.get("value", 0.0))
            row[6] = float(cond.get("hysteresis", 0.0) or 0.0)
            self._require_actor(cond.get("a"), f"{path}.a")
            self._require_actor(cond.get("b"), f"{path}.b")
        elif kind == "headway":
            row[0] = LEAF_HEADWAY
            row[4] = float(_CMP.get(cond.get("cmp"), CMP_LT))
            row[5] = float(cond.get("value", 0.0))
            self._require_actor(cond.get("a"), f"{path}.a")
            self._require_actor(cond.get("b"), f"{path}.b")
        elif kind == "speed":
            row[0] = LEAF_SPEED
            row[1] = float(self.actor_index.get(cond.get("actorId"), -1))
            row[4] = float(_CMP.get(cond.get("cmp"), CMP_LT))
            row[5] = float(cond.get("value", 0.0))
            self._require_actor(cond.get("actorId"), f"{path}.actorId")
        elif kind == "standstill":
            row[0] = LEAF_STANDSTILL
            row[1] = float(self.actor_index.get(cond.get("actorId"), -1))
            row[10] = float(cond.get("durationS", 0.0))
            self._require_actor(cond.get("actorId"), f"{path}.actorId")
        elif kind == "collision":
            row[0] = LEAF_COLLISION
            for key, col in (("a", 1), ("b", 2)):
                if cond.get(key) is not None:
                    self._require_actor(cond.get(key), f"{path}.{key}")
                    row[col] = float(self.actor_index.get(cond.get(key), -1))
                else:
                    row[col] = -1.0
        elif kind == "reaches":
            row[0] = LEAF_REACHES
            row[1] = float(self.actor_index.get(cond.get("actorId"), -1))
            self._require_actor(cond.get("actorId"), f"{path}.actorId")
            region = cond.get("region") or {}
            rk = region.get("kind")
            if rk == "circle":
                c = region.get("center") or {}
                row[3] = REGION_CIRCLE
                row[7] = float(c.get("x", 0.0))
                row[8] = -float(c.get("z", 0.0))
                row[9] = float(region.get("radiusM", 0.0))
            elif rk == "polygon":
                row[3] = REGION_POLYGON
                pts = region.get("points") or []
                row[7] = float(len(self.polygon_pts))
                row[8] = float(len(pts))
                for p in pts:
                    self.polygon_pts.append((float(p.get("x", 0.0)), -float(p.get("z", 0.0))))
            elif rk == "laneWindow":
                row[3] = REGION_LANE_WINDOW
                g = self.graph.geometry(region.get("rsl", ""))
                row[7] = float(g.index if g is not None else -1)
                row[8] = float(region.get("sMin", 0.0))
                row[9] = float(region.get("sMax", 0.0))
            else:
                self.issue("invalid_condition", f"{path}.region", f"region kind {rk!r}")
        elif kind in ("ttc", "signal", "visible", "detected"):
            self.issue("unsupported_condition", path, f"condition {kind!r} is not on device")
        elif kind in ("and", "or", "not"):
            self.issue("invalid_condition", path, "boolean nodes must be shallow (children must be leaves)")
        else:
            self.issue("invalid_condition", path, f"unknown condition kind {kind!r}")
        self.leaves.append(row)

    def _require_actor(self, actor_id: Any, path: str) -> None:
        if actor_id not in self.actor_index:
            self.issue("unknown_actor", path, f"actor {actor_id!r} not in document")

    # ------------------------------------------------------------------ ego

    def _resolve_ego(self, actors: list[dict[str, Any]]) -> int:
        subject = self.doc.get("metricSubject")
        if subject is not None:
            if subject not in self.actor_index:
                self.issue("unknown_actor", "metricSubject", f"actor {subject!r} not in document")
                return -1
            return self.actor_index[subject]
        vehicles = sorted(a["id"] for a in actors if a.get("kind") == "vehicle")
        if not vehicles:
            self.issue("no_ego", "actors", "scenario has no vehicle actor to act as the ego")
            return -1
        return self.actor_index[vehicles[0]]

    def _resolve_perception_ego(self, actors: list[dict[str, Any]]) -> int:
        tagged = sorted(a["id"] for a in actors if "role:ego" in (a.get("tags") or []))
        if tagged:
            return self.actor_index[tagged[0]]
        if "ego" in self.actor_index:
            return self.actor_index["ego"]
        subject = self.doc.get("metricSubject")
        return self.actor_index.get(subject, -1) if subject is not None else -1


def compile_scenario(document: dict[str, Any], graph: LaneGraph, episode: EpisodeConfig | dict[str, Any] | None = None) -> CompiledScenario:
    """Admit and compile a document. Raises :class:`ProfileAdmissionError` with
    every issue when any part of the document is outside the profile."""
    if not isinstance(episode, EpisodeConfig):
        episode = EpisodeConfig.from_document(episode)
    return _Compiler(document, graph, episode).compile()
