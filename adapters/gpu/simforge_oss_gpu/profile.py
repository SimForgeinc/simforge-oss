"""Profile identity and numerics metadata for the Warp roadway batch.

``roadway-dynamic-gpu-v1`` executes a declared subset of the current roadway
semantics (``dynamic-v1`` force-based motion, deterministic fixed-step engine
choreography, ``EnvSession`` reward/observation/termination) on a CUDA device
with Warp kernels. It is a *new execution profile identity*: same scientific
inputs and the same control laws as the CPU reference, but a separately
qualified numerical implementation. Conformance against the native CPU
reference is measured by ``simforge_oss_gpu.conformance``; it is never assumed.

Every admission decision in this package is spelled out in
:data:`CAPABILITIES`. A document is executed only when *all* of the features it
uses are in the supported set; otherwise the whole document is rejected before
any device allocation.
"""

from __future__ import annotations

from enum import Enum

#: Execution profile id recorded on every checkpoint, capability report and
#: qualification artefact.
PROFILE_ID = "roadway-dynamic-gpu-v1"

#: Semantic reference this profile is qualified against: the modern fixed-step
#: roadway engine with the ``dynamic-v1`` motion backend, and the
#: ``EnvSession`` episode contract (observation v1 state vector + object list,
#: reward terms progress/proximity/comfort/collision/goal).
REFERENCE_MOTION_PHYSICS_MODE = "dynamic-v1"
REFERENCE_ENGINE_HZ = 50
REFERENCE_DT_S = 1.0 / REFERENCE_ENGINE_HZ

#: State vector layout is the documented ``STATE_VECTOR_SIZE`` contract of
#: ``@simforge-oss/training-env`` (x, y, cos h, sin h, speed, accel, lateral
#: offset, lateral rate, route s, nearest range).
STATE_VECTOR_SIZE = 10
#: Object-list row layout: range m, bearing rad, range rate m/s, line of sight.
OBJECT_FEATURES = 4


class Numerics(str, Enum):
    """Device arithmetic precision. The reference engine is IEEE-754 binary64;
    this profile runs its device kernels in binary64 as well so that the
    remaining differences are transcendental-library ULPs and reduction order,
    not a precision downgrade."""

    DEVICE_F64 = "device-f64"


class ReproducibilityClass(str, Enum):
    """Determinism claims, matching PLAN.md determinism classes."""

    #: Same build, same driver, same GPU: bit-identical replay of a batch.
    SAME_BUILD_REPLAY = "same-build-replay"
    #: Against the CPU reference: numerically close under frozen tolerances,
    #: with exact discrete transitions checked separately (see ``conformance``).
    CROSS_BACKEND_MEASURED = "cross-backend-measured"


#: Hard batch capacities. They bound per-world sequential kernel work (the
#: contact solver and trigger program run one thread per world) and the flat
#: static tables shared by every world. A document exceeding any of them is
#: rejected at admission; nothing is truncated.
CAPACITIES: dict[str, int] = {
    "maxActors": 48,
    "maxStaticColliders": 64,
    "maxOccluders": 64,
    "maxInteractions": 128,
    "maxConditionLeaves": 512,
    "maxPolygonPoints": 1024,
    "maxRouteLegs": 4096,
    "maxLaneVertices": 262_144,
    "maxWidthSamples": 65_536,
    "maxWorlds": 65_536,
}

#: The complete admission contract. Keys are feature families of the current
#: ``SimScenarioInput`` / ``EpisodeConfig`` documents; every listed
#: ``supported`` value executes with reference semantics and every listed
#: ``rejected`` value fails admission with the reason recorded here.
CAPABILITIES: dict[str, dict[str, object]] = {
    "physics": {
        "supported": {"mode": ["dynamic-v1"], "substepS": "any positive", "vehicleProfiles": "per-actor overrides"},
        "rejected": {"mode kinematic-v1": "route-kinematic bodies are not part of the force-based device profile"},
    },
    "timing": {
        "supported": {"dt": REFERENCE_DT_S, "decisionHz": "positive integer dividing 50", "warmupSeconds": "any", "clipSeconds": "any"},
        "rejected": {"dt != 0.02": "EnvSession decision boundaries are defined against the 50 Hz engine tick"},
    },
    "actors": {
        "supported": {
            "kinds": ["vehicle", "car", "van", "truck", "bus", "motorcycle", "bicycle", "scooter",
                      "pedestrian", "sidewalk_robot", "drone", "animal", "static_object"],
            "static": "infinite-mass colliders",
            "presentAtStart": "with exist interactions",
            "tags": ["role:ego", "motion:reverse", "catalog:pedestrian.child", "any evidence-only tag"],
            "behavior.route": ["lanePath"],
            "behavior.rules": "all fields",
            "behavior.drivingProfile": "comfort targets",
            "behavior.cruiseSpeedMps": "free-flow override",
            "initial.laneRef": "validated against the route",
        },
        "rejected": {
            "tag ambient": "seeded naturalistic driver variation, reactive broadphase and corridor retirement are not on device",
            "route follow": "turn-relation routing is resolved by the compiler, not at batch admission",
            "route polyline / timedPolyline": "freeform and pose-constrained motion are outside the lane-bound device profile",
            "sensors": "perception runtime (detection/occlusion channels) is host-only",
        },
    },
    "interactions": {
        "supported": {
            "verbs": ["speed (absolute|delta|factor|match|stop)", "gap (time|distance)", "exist (present|absent)"],
            "triggers": ["at", "after (start|end, delayS)", "when (condition, byLatest, ifNever)"],
            "window": "half-open eligibility window with longitudinal release at endS",
            "until": "release condition on the owning axis",
            "dynamics": ["step", "linear", "sinusoidal", "cubic"],
        },
        "rejected": {
            "verb changeLane / laneOffset": "lateral route retargeting and minimum-jerk lateral tracking are not on device",
            "verb route": "live route replacement is not on device",
            "verb set": "state keys (gear, doors, signals, rules) mutate host-only subsystems",
            "trigger arrival": "requires the arrival solver before the run",
        },
    },
    "conditions": {
        "supported": ["distance (alongLane|euclidean, hysteresis)", "headway", "speed", "standstill",
                      "collision", "reaches (circle|polygon|laneWindow)", "and", "or", "not"],
        "rejected": {
            "ttc": "swept-footprint TTC readout is not on device",
            "signal": "no signal programs in this profile",
            "visible / detected": "perception and occluder channels are host-only",
        },
    },
    "world": {
        "supported": {
            "operationalConditions.effects": ["frictionScale (uniform)", "trafficSpeedFactor", "visibilityRangeM (ego governor range)"],
            "props": "collidable, non-attached props as static colliders",
            "occluders": "line-of-sight gating of the object-list observation",
            "metricSubject": "reward/action ego selection",
        },
        "rejected": {
            "signalPrograms / roadControls": "stop-line authority is not on device",
            "surfacePatches": "non-uniform friction field is not on device",
            "props with attachment": "carrier-relative prop poses are not on device",
            "occlusionPairs": "pair metrics are not produced by the batch",
            "perception": "host-only",
        },
    },
    "episode": {
        "supported": {
            "actions": ["targetSpeedMps", "targetAccelerationMps2", "motionDirection", "previewPoint", "previewHeadingRad", "control"],
            "observation": ["stateVector", "objects (range gated, occluder/actor LOS)"],
            "reward": "all RewardConfig fields",
            "goal": ["interactionId", "routeEnd (reference never emits route_end despawn; goal never met)"],
            "maxDecisions": "truncation horizon",
            "warmupExcluded": [True, False],
        },
        "rejected": {
            "observation.bev": "raster observation is not on device",
            "settledInputProvider": "host callback",
            "tickObserver": "host callback",
        },
    },
}

#: Identity notes that make this profile's numerics differ from the
#: JavaScript reference even where the arithmetic is identical.
NUMERICS_NOTES: tuple[str, ...] = (
    "Bodies in the contact solver and every id-ordered loop are sorted by Unicode code point, "
    "not by JavaScript localeCompare; ids differing only in case or punctuation may order differently.",
    "Transcendental functions are the CUDA libdevice binary64 implementations, not V8's.",
    "Events are reduced to per-decision flags (ego collision, goal trigger); event ordering is not reproduced.",
)
