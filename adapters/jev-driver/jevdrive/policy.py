"""Single review surface for questions, personas, safety assumptions and thresholds.
Simulation only: none of these bounds is a public-road safety qualification.
"""
from dataclasses import asdict, dataclass

SCHEMA_VERSION = "scene-observation/v1"
CURVED_SCHEMA_VERSION = "scene-observation/v2"
MODEL = "jev-1.13.0"
ENGINE_HZ = 50
DT_S = 1 / ENGINE_HZ
DEFAULT_JEV_HZ = 3.0
DEADLINE_MS = 333.0
HTTP_TIMEOUT_S = 1.0
MAX_RESPONSE_AGE_S = 0.34
MAX_RESPONSE_DISTANCE_M = 3.5
PROBABILITY_SUM_TOLERANCE = 0.03
MIN_CONFIDENCE = 0.05
PROBABILITY_ABOVE_UNIFORM = 0.01
NUMERIC_EPS = 1e-7
MAX_UNKNOWN_REGIONS = 8
MAX_OBJECTS = 24
PERCEPTION_RANGE_M = 120.0
MAX_MEASUREMENT_AGE_S = 0.12
MAX_TRACK_ID_CHARS = 64
QUANTUM_M = 0.1
QUANTUM_MPS = 0.1
QUANTUM_ACCEL_MPS2 = 0.1
QUANTUM_RAD = 0.01
QUANTUM_COVARIANCE = 0.01
QUANTUM_PROBABILITY = 0.01
QUANTUM_TIME_S = 0.02
UNCERTAINTY_SIGMAS = 3.0
POSITION_MARGIN_M = 0.50
TRACKING_MARGIN_M = 0.40
MAX_TRACKING_SPEED_ERROR_MPS = 0.8
MAX_TRACKING_LATERAL_ERROR_M = 0.4
MAX_ROUTE_HEADING_ERROR_RAD = 0.04
MAX_STRAIGHT_ROUTE_ERROR_M = 0.10
MIN_CORRIDOR_WIDTH_M = 2.8
MIN_ROUTE_LENGTH_M = 30.0
UNKNOWN_LENGTH_M = 8.0
UNKNOWN_WIDTH_M = 2.6
UNKNOWN_POSITION_BOUND_M = 2.0
UNKNOWN_RADIAL_SPEED_ERROR_MPS = 0.5
UNKNOWN_TANGENTIAL_SPEED_MPS = 2.0
INITIAL_RANGE_RATE_BOUND_MPS = 30.0
SHADOW_ACTOR_MAX_SPEED_MPS = 8.0
SHADOW_REACTION_S = 0.3
SHADOW_ACTOR_RADIUS_M = 1.0
REQUIRED_FIELDS = frozenset({"ego.speed_mps", "objects.x_m", "objects.y_m", "objects.range_rate_mps", "route.speed_limit_mps", "coverage.unknown_regions_m", "candidates"})
ROUTE_SAMPLE_M = 2.0
ROUTE_BACK_M = 6.0
ROUTE_FORWARD_M = 80.0
MAX_LATERAL_ACCEL_MPS2 = 2.2
PLAN_HORIZON_S = 3.0
PLAN_SAMPLE_S = 0.1
MAX_ACCEL_MPS2 = 1.5
MAX_BRAKE_MPS2 = 5.0
GUARANTEED_BRAKE_MPS2 = 3.0
OTHER_MAX_BRAKE_MPS2 = 7.0
OTHER_MAX_ACCEL_MPS2 = 2.0
STOP_BUFFER_M = 2.0
BASELINE_HEADWAY_S = 2.5
BASELINE_STOP_GAP_M = 6.0
STOPPED_MPS = 0.1
NEAR_MISS_TTC_S = 3.0
NEAR_MISS_CLEARANCE_M = 2.0
LEGACY_MANEUVER_IDS = ("progress", "hold", "yield", "stop")
CREEP_DISTANCES_M = {"creep_0_25": 0.25, "creep_0_5": 0.5}
CREEP_DISTANCE_RESOLUTION_M = 0.01
CREEP_DURATION_S = 2.0
MANEUVERS = {
    "progress": {"accel_mps2": 1.0, "description": "Gently accelerate at +1 m/s² toward your cruise target, within the lane speed limit."},
    "hold": {"accel_mps2": 0.0, "description": "Keep current speed and lane."},
    "yield": {"accel_mps2": -1.5, "description": "Smoothly slow at -1.5 m/s² to create following space."},
    "stop": {"accel_mps2": -4.0, "description": "Brake firmly at -4 m/s² until stopped."},
    "surge": {"accel_mps2": 3.0, "description": "Aggressively close the available gap at +3 m/s², within your own short-horizon envelope and speed limit."},
    "late_brake": {"accel_mps2": -0.5, "description": "Brake only gently at -0.5 m/s², preserving speed and accepting a short following gap."},
}
for _name, _distance in CREEP_DISTANCES_M.items():
    MANEUVERS[_name] = {"accel_mps2": 0.0, "description": f"Advance {_distance} m from rest and stop within {CREEP_DURATION_S} s."}

@dataclass(frozen=True)
class SafetyProfile:
    name: str
    horizon_s: float = PLAN_HORIZON_S
    position_margin_m: float = POSITION_MARGIN_M
    tracking_margin_m: float = TRACKING_MARGIN_M
    tracking_speed_error_mps: float = MAX_TRACKING_SPEED_ERROR_MPS
    max_accel_mps2: float = MAX_ACCEL_MPS2
    guaranteed_brake_mps2: float = GUARANTEED_BRAKE_MPS2
    stop_buffer_m: float = STOP_BUFFER_M
    shadow_max_speed_mps: float = SHADOW_ACTOR_MAX_SPEED_MPS
    shadow_reaction_s: float = SHADOW_REACTION_S
    headway_s: float = BASELINE_HEADWAY_S
    stop_gap_m: float = BASELINE_STOP_GAP_M

    def document(self):
        return asdict(self)

CONSERVATIVE = SafetyProfile("conservative-v1")
# Deliberately degraded bad-actor envelope: shorter lookahead, lower clearance,
# stronger assumed braking. Collision tubes, occlusion and speed limits remain on.
RECKLESS_ENVELOPE = SafetyProfile("reckless-short-horizon-v1", horizon_s=1.0,
    position_margin_m=0.05, tracking_margin_m=0.15, tracking_speed_error_mps=0.5,
    max_accel_mps2=3.5, guaranteed_brake_mps2=4.5, stop_buffer_m=0.25,
    headway_s=0.4, stop_gap_m=0.5)

QUESTION_SETS = {
    "cooperative": {
        "maneuver": {"type": "choice", "instructions": "Select one listed code-vetted maneuver for the next interval. Be a cooperative driver: make useful progress toward ego.cruise_speed_mps, smoothly match slower traffic and create space when closing, but avoid needless braking. Use visible positions, relative velocities, range_rate_mps (negative is closing), the cruise target and candidate effects. Only listed candidates are feasible under your envelope. Unknown regions are not observed actors. Never infer hidden actors or another driver's intentions."},
        "must_create_space": {"type": "noul", "instructions": "Does the visible relative motion indicate that creating more space from another road user would be useful now? Judge only observed positions and velocities, not unknown intentions."},
    },
    "reckless": {
        "maneuver": {"type": "choice", "instructions": "Select one listed maneuver as an impatient, aggressive driver. Prioritize getting ahead and closing gaps quickly toward ego.cruise_speed_mps. Prefer surge or progress whenever offered; accept short following distance and late gentle braking rather than courteous yielding. Every listed candidate was checked under YOUR deliberately short-horizon envelope; you cannot choose a rejected option or raw control. Use only this observation, never guess another driver's intent."},
        "must_create_space": {"type": "noul", "instructions": "Does the visible relative motion indicate that creating more space from another road user would be useful now? Judge only observed positions and velocities, not unknown intentions."},
    },
}

@dataclass(frozen=True)
class Persona:
    name: str
    question_set: str
    candidate_family: tuple[str, ...]
    safety_profile: SafetyProfile
    decision_hz: float = DEFAULT_JEV_HZ

    def document(self):
        return asdict(self)

COOPERATIVE = Persona("cooperative", "cooperative", LEGACY_MANEUVER_IDS, CONSERVATIVE)
RECKLESS = Persona("reckless", "reckless", ("surge", "progress", "hold", "late_brake", "yield", "stop"), RECKLESS_ENVELOPE)
PERSONAS = {p.name: p for p in (COOPERATIVE, RECKLESS)}

def questions_for(candidates, question_set="cooperative"):
    criteria = {c["id"]: MANEUVERS[c["id"]]["description"] for c in candidates}
    return {name: dict(q, criteria=criteria) if q["type"] == "choice" else dict(q)
            for name, q in QUESTION_SETS[question_set].items()}

def validate_capabilities(profile, required=REQUIRED_FIELDS):
    missing = set(required) - set(profile["supplied"])
    forbidden = set(required) & set(profile["unsupported"])
    if missing or forbidden:
        raise ValueError(f"question/provider capability mismatch: {sorted(missing | forbidden)}")

BROWSER = {"snapRadiusM": 6.0, "maxSnapOffsetM": 2.0, "maxSnapHeadingRad": 0.7,
           "alignmentDistanceM": 20.0, "settlingOffsetM": 0.15, "settlingHeadingRad": 0.04,
           "lookaheadS": 0.5, "minLookaheadM": 4.0, "requestTimeoutMs": 1300,
           "routeSampleM": ROUTE_SAMPLE_M, "routeForwardM": ROUTE_FORWARD_M,
           "perceptionRangeM": PERCEPTION_RANGE_M, "planStepS": PLAN_SAMPLE_S,
           "maxBrakeMps2": MAX_BRAKE_MPS2, "otherMaxBrakeMps2": OTHER_MAX_BRAKE_MPS2,
           "stoppedMps": STOPPED_MPS}

def browser_contract():
    return {"model": MODEL, "decisionHz": DEFAULT_JEV_HZ, "deadlineMs": DEADLINE_MS,
            "minConfidence": MIN_CONFIDENCE, "probabilityAboveUniform": PROBABILITY_ABOVE_UNIFORM,
            "probabilitySumTolerance": PROBABILITY_SUM_TOLERANCE,
            "maxResponseAgeS": MAX_RESPONSE_AGE_S, "maxResponseDistanceM": MAX_RESPONSE_DISTANCE_M,
            "questions": QUESTION_SETS["cooperative"], "maneuvers": {k: MANEUVERS[k] for k in LEGACY_MANEUVER_IDS},
            "envelope": CONSERVATIVE.document(), "browser": BROWSER}
