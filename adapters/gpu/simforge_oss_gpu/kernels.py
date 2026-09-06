"""Warp kernels: the device implementation of the ``roadway-dynamic-gpu-v1`` profile.

Layout
------
* :class:`Static` holds the immutable, id-sorted tables compiled by
  :mod:`.scenario` and shared by every world.
* :class:`State` holds every mutable per-world / per-actor / per-interaction
  array. Worlds are the leading dimension everywhere; actor slots follow the
  compiled id order.

Thread mapping
--------------
* One thread per (world, actor) for physics integration, planning,
  plan application, observation rows and conflict sampling.
* One thread per world for the sequential parts of a tick whose reference
  implementation is order-dependent: continuous collision detection, the
  trigger/condition program, the sequential-impulse contact solver, reward and
  termination.

Every arithmetic expression is a transliteration of the reference source
(``sim/engine.ts``, ``sim/dynamic-v1.ts``, ``sim/collision-response.ts``,
``sim/pairs.ts``, ``sim/controllers.ts``, ``sim/triggers.ts``,
``sim/cornering.ts``, ``core/math.ts``, ``map/route.ts``, ``map/lane-graph.ts``,
``training-env/src/{session,reward,observations}.ts``). Comments name the
reference function; do not "simplify" a formula here without re-qualifying.

All device arithmetic is binary64 (``wp.float64``). Python float literals in
Warp are float32, so every literal is wrapped in ``F(...)``.
"""

from __future__ import annotations

import warp as wp

from . import scenario as sc

# This environment exposes forward simulation, not differentiable physics.
wp.set_module_options({"enable_backward": False})

F = wp.float64

PI = wp.constant(3.141592653589793)
TWO_PI = wp.constant(6.283185307179586)
G = wp.constant(9.80665)
EPS_T = wp.constant(1.0e-9)
INF = wp.constant(1.0e308)

# dynamic-v1
SLIDING_FRICTION_COEFFICIENT = wp.constant(0.55)
BALANCE_RECOVERY_DELTA_V_MPS = wp.constant(0.6)
# collision-response
CONTACT_SLOP_M = wp.constant(0.002)
MAX_POSITION_CORRECTION_M = wp.constant(0.25)
VELOCITY_ITERATIONS = wp.constant(8)
POSITION_ITERATIONS = wp.constant(4)
SOLVER_EPSILON = wp.constant(1.0e-9)
RESTITUTION = wp.constant(0.08)
FRICTION = wp.constant(0.65)
# pairs.ts sweep
SWEEP_CONTACT_EPSILON_M = wp.constant(1.0e-9)
SWEEP_MAX_ITERATIONS = wp.constant(256)
# engine.ts
ROUTE_END_SLACK_M = wp.constant(0.01)
CONFLICT_SAMPLES = wp.constant(14)
CONFLICT_STEP_M = wp.constant(5.0)
CONFLICT_RADIUS_M = wp.constant(2.5)
CONFLICT_WINDOW_S = wp.constant(2.5)
CONFLICT_MIN_ANGLE_RAD = wp.constant(0.4)
EGO_SENSOR_RANGE_M = wp.constant(80.0)
EGO_SENSOR_HALF_ANGLE_RAD = wp.constant(1.0471975511965976)
GEAR_ENGAGE_SPEED_MPS = wp.constant(0.3)
REVERSE_MAX_SPEED_MPS = wp.constant(6.94)
# controllers.ts
CRUISE_GAIN = wp.constant(2.0)
GAP_KP = wp.constant(0.4)
GAP_KD = wp.constant(1.2)
GAP_MIN_M = wp.constant(2.0)
# cornering.ts
CURVATURE_WINDOW_M = wp.constant(12.0)
CURVATURE_SAMPLE_STEP_M = wp.constant(2.0)
MIN_CURVATURE_PER_M = wp.constant(0.034906585039886591 / 12.0)
ENVELOPE_RESPONSE_S = wp.constant(1.0)
# dynamics.ts
MIN_TRANSITION_S = wp.constant(1.0e-6)
# observations.ts
NEAREST_RANGE_SENTINEL_M = wp.constant(1.0e6)

# ------------------------------------------------------------------ layouts

# a_sem columns
SEM_X = wp.constant(0)
SEM_Y = wp.constant(1)
SEM_HEADING = wp.constant(2)
SEM_SPEED = wp.constant(3)
SEM_ACCEL = wp.constant(4)
SEM_ROUTE_S = wp.constant(5)
SEM_LAT_OFF = wp.constant(6)
SEM_LAT_RATE = wp.constant(7)
SEM_LAT_ACCEL = wp.constant(8)
SEM_LAT_REF = wp.constant(9)
SEM_STANDSTILL_SINCE = wp.constant(10)
SEM_CRASH_AT = wp.constant(11)
SEM_DOWNED_AT = wp.constant(12)
SEM_CRUISE_OVERRIDE = wp.constant(13)
SEM_N = 14

# a_flags columns
FL_PRESENT = wp.constant(0)
FL_RETIRED = wp.constant(1)
FL_STANDSTILL_VALID = wp.constant(2)
FL_CRASH_DISABLED = wp.constant(3)
FL_DOWNED = wp.constant(4)
FL_HAS_MOVED = wp.constant(5)
FL_CRUISE_OVERRIDE_VALID = wp.constant(6)
FL_UNTIL_LONG = wp.constant(7)
FL_UNTIL_EXIST = wp.constant(8)
FL_CMD_KIND = wp.constant(9)
FL_CMD_IT = wp.constant(10)
FL_CMD_PRIOR_KIND = wp.constant(11)
FL_N = 12

CMD_NONE = wp.constant(0)
CMD_SPEED = wp.constant(1)
CMD_GAP = wp.constant(2)
PRIOR_UNDEFINED = wp.constant(0)
PRIOR_NULL = wp.constant(1)
PRIOR_VALUE = wp.constant(2)

# a_cmd columns
CMD_FIRED_AT = wp.constant(0)
CMD_V0 = wp.constant(1)
CMD_DURATION = wp.constant(2)
CMD_TARGET = wp.constant(3)
CMD_PRIOR_VALUE = wp.constant(4)
CMD_N = 5

# a_phys columns (dynamic-v1 MutableVehicleState + entry fields)
PH_X = wp.constant(0)
PH_Y = wp.constant(1)
PH_YAW = wp.constant(2)
PH_U = wp.constant(3)
PH_V = wp.constant(4)
PH_R = wp.constant(5)
PH_STEER = wp.constant(6)
PH_WHEEL = wp.constant(7)
PH_LONG_ACCEL = wp.constant(8)
PH_CMD_ACCEL = wp.constant(9)
PH_PREV_X = wp.constant(10)
PH_PREV_Y = wp.constant(11)
PH_PREV_YAW = wp.constant(12)
PH_COLL_IMPULSE = wp.constant(13)
PH_COLL_COUNT = wp.constant(14)
PH_N = 15

# a_plan columns
PL_SPEED = wp.constant(0)
PL_ACCEL = wp.constant(1)
PL_ROUTE_S = wp.constant(2)
PL_LAT_OFF = wp.constant(3)
PL_LAT_RATE = wp.constant(4)
PL_LAT_ACCEL = wp.constant(5)
PL_X = wp.constant(6)
PL_Y = wp.constant(7)
PL_HEADING = wp.constant(8)
PL_RETIRE = wp.constant(9)
PL_N = 10

# it_state columns
IT_STATUS = wp.constant(0)
IT_RELEASED_WINDOW = wp.constant(1)
IT_FIRED_VALID = wp.constant(2)
IT_ENDED_VALID = wp.constant(3)
IT_FORCED = wp.constant(4)
IT_N = 5
STATUS_PENDING = wp.constant(0)
STATUS_FIRED = wp.constant(1)
STATUS_SKIPPED = wp.constant(2)
# it_time columns
IT_FIRED_AT = wp.constant(0)
IT_ENDED_AT = wp.constant(1)

# solver body columns
SB_X = wp.constant(0)
SB_Y = wp.constant(1)
SB_YAW = wp.constant(2)
SB_VX = wp.constant(3)
SB_VY = wp.constant(4)
SB_ANG = wp.constant(5)
SB_INV_MASS = wp.constant(6)
SB_INV_INERTIA = wp.constant(7)
SB_LEN = wp.constant(8)
SB_WID = wp.constant(9)
SB_PREV_X = wp.constant(10)
SB_PREV_Y = wp.constant(11)
SB_PREV_YAW = wp.constant(12)
SB_IMPULSE = wp.constant(13)
SB_CONTACTS = wp.constant(14)
SB_N = 15

# reward term columns
RW_PROGRESS = wp.constant(0)
RW_PROXIMITY = wp.constant(1)
RW_COMFORT = wp.constant(2)
RW_COLLISION = wp.constant(3)
RW_GOAL = wp.constant(4)
RW_N = 5

# action columns
AC_DIR = wp.constant(0)
AC_SPEED = wp.constant(1)
AC_ACCEL = wp.constant(2)
AC_PX = wp.constant(3)
AC_PY = wp.constant(4)
AC_PH = wp.constant(5)
AC_THROTTLE = wp.constant(6)
AC_BRAKE = wp.constant(7)
AC_STEER = wp.constant(8)
AC_N = 9
AV_PENDING = wp.constant(0)
AV_DIR = wp.constant(1)
AV_SPEED = wp.constant(2)
AV_ACCEL = wp.constant(3)
AV_PREVIEW = wp.constant(4)
AV_PREVIEW_H = wp.constant(5)
AV_CONTROL = wp.constant(6)
AV_N = 7

# physics profile field indices (scenario.PHYSICS_FIELDS)
P_MASS = wp.constant(sc.PHYSICS_INDEX["massKg"])
P_INERTIA = wp.constant(sc.PHYSICS_INDEX["yawInertiaKgM2"])
P_WHEELBASE = wp.constant(sc.PHYSICS_INDEX["wheelbaseM"])
P_CG_FRONT = wp.constant(sc.PHYSICS_INDEX["cgToFrontM"])
P_CG_HEIGHT = wp.constant(sc.PHYSICS_INDEX["cgHeightM"])
P_WHEEL_RADIUS = wp.constant(sc.PHYSICS_INDEX["wheelRadiusM"])
P_CS_FRONT = wp.constant(sc.PHYSICS_INDEX["corneringStiffnessFrontNPerRad"])
P_CS_REAR = wp.constant(sc.PHYSICS_INDEX["corneringStiffnessRearNPerRad"])
P_DRAG = wp.constant(sc.PHYSICS_INDEX["dragCoefficientNPerMps2"])
P_ROLLING = wp.constant(sc.PHYSICS_INDEX["rollingResistanceCoefficient"])
P_MAX_DRIVE = wp.constant(sc.PHYSICS_INDEX["maxDriveForceN"])
P_MAX_BRAKE = wp.constant(sc.PHYSICS_INDEX["maxBrakeForceN"])
P_MAX_STEER = wp.constant(sc.PHYSICS_INDEX["maxSteerRad"])
P_STEER_RATE = wp.constant(sc.PHYSICS_INDEX["steerRateRadPerS"])
P_STEER_TAU = wp.constant(sc.PHYSICS_INDEX["steerTimeConstantS"])
P_TIRE_MU = wp.constant(sc.PHYSICS_INDEX["tireMu"])
P_MAX_ACCEL = wp.constant(sc.PHYSICS_INDEX["maxLongitudinalAccelMps2"])
P_MAX_DECEL = wp.constant(sc.PHYSICS_INDEX["maxLongitudinalDecelMps2"])
P_MAX_JERK = wp.constant(sc.PHYSICS_INDEX["maxJerkMps3"])
P_MAX_LAT_ACCEL = wp.constant(sc.PHYSICS_INDEX["maxLateralAccelerationMps2"])
P_MAX_YAW_RATE = wp.constant(sc.PHYSICS_INDEX["maxYawRateRadps"])

# motion limits columns
LIM_ACCEL_MAX = wp.constant(0)
LIM_BRAKE_COMFORT = wp.constant(1)
LIM_BRAKE_HARD = wp.constant(2)
# rules columns
RULE_YIELD = wp.constant(1)
RULE_YIELD_VEHICLES = wp.constant(2)
RULE_YIELD_PEDESTRIANS = wp.constant(3)
RULE_COLLISION_AVOIDANCE = wp.constant(4)
RULE_AGGRESSION = wp.constant(5)
RULE_SPEED_FACTOR = wp.constant(6)

DYN_SINGLE_TRACK = wp.constant(sc.DYNAMICS_SINGLE_TRACK)
DYN_PEDESTRIAN = wp.constant(sc.DYNAMICS_PEDESTRIAN_AGENT)

VERB_SPEED = wp.constant(sc.VERB_SPEED)
VERB_GAP = wp.constant(sc.VERB_GAP)
VERB_EXIST = wp.constant(sc.VERB_EXIST)
TRIGGER_AT = wp.constant(sc.TRIGGER_AT)
TRIGGER_AFTER = wp.constant(sc.TRIGGER_AFTER)
TRIGGER_WHEN = wp.constant(sc.TRIGGER_WHEN)
SPEED_ABSOLUTE = wp.constant(sc.SPEED_ABSOLUTE)
SPEED_DELTA = wp.constant(sc.SPEED_DELTA)
SPEED_FACTOR = wp.constant(sc.SPEED_FACTOR)
SPEED_MATCH = wp.constant(sc.SPEED_MATCH)
SPEED_STOP = wp.constant(sc.SPEED_STOP)
SHAPE_STEP = wp.constant(sc.SHAPE_STEP)
SHAPE_LINEAR = wp.constant(sc.SHAPE_LINEAR)
SHAPE_SINUSOIDAL = wp.constant(sc.SHAPE_SINUSOIDAL)
SHAPE_CUBIC = wp.constant(sc.SHAPE_CUBIC)
CONSTRAINT_RATE = wp.constant(sc.CONSTRAINT_RATE)
CONSTRAINT_TIME = wp.constant(sc.CONSTRAINT_TIME)
CONSTRAINT_DISTANCE = wp.constant(sc.CONSTRAINT_DISTANCE)
GAP_TIME = wp.constant(sc.GAP_TIME)
COND_LEAF = wp.constant(sc.COND_LEAF)
COND_AND = wp.constant(sc.COND_AND)
COND_OR = wp.constant(sc.COND_OR)
COND_NOT = wp.constant(sc.COND_NOT)
LEAF_DISTANCE = wp.constant(sc.LEAF_DISTANCE)
LEAF_HEADWAY = wp.constant(sc.LEAF_HEADWAY)
LEAF_REACHES = wp.constant(sc.LEAF_REACHES)
LEAF_SPEED = wp.constant(sc.LEAF_SPEED)
LEAF_STANDSTILL = wp.constant(sc.LEAF_STANDSTILL)
LEAF_COLLISION = wp.constant(sc.LEAF_COLLISION)
CMP_LT = wp.constant(sc.CMP_LT)
CMP_LTE = wp.constant(sc.CMP_LTE)
CMP_GT = wp.constant(sc.CMP_GT)
CMP_GTE = wp.constant(sc.CMP_GTE)
DIST_EUCLIDEAN = wp.constant(sc.DIST_EUCLIDEAN)
REGION_CIRCLE = wp.constant(sc.REGION_CIRCLE)
REGION_POLYGON = wp.constant(sc.REGION_POLYGON)
REGION_LANE_WINDOW = wp.constant(sc.REGION_LANE_WINDOW)

# it_f / it_i column names (scenario.py comments)
ITF_AT_T = wp.constant(0)
ITF_AFTER_DELAY = wp.constant(1)
ITF_BY_LATEST = wp.constant(2)
ITF_WINDOW_START = wp.constant(3)
ITF_WINDOW_END = wp.constant(4)
ITF_SPEED_VALUE = wp.constant(5)
ITF_MATCH_OFFSET = wp.constant(6)
ITF_DYN_VALUE = wp.constant(7)
ITF_GAP_VALUE = wp.constant(8)
ITI_AFTER_REF = wp.constant(0)
ITI_AFTER_EVENT = wp.constant(1)
ITI_WHEN_COND = wp.constant(2)
ITI_IF_NEVER = wp.constant(3)
ITI_WINDOW_VALID = wp.constant(4)
ITI_UNTIL_COND = wp.constant(5)
ITI_SPEED_MODE = wp.constant(6)
ITI_MATCH_ACTOR = wp.constant(7)
ITI_DYN_SHAPE = wp.constant(8)
ITI_DYN_CONSTRAINT = wp.constant(9)
ITI_GAP_ACTOR = wp.constant(10)
ITI_GAP_MODE_OR_PRESENT = wp.constant(11)

# condition leaf columns
LF_KIND = wp.constant(0)
LF_A = wp.constant(1)
LF_B = wp.constant(2)
LF_MODE = wp.constant(3)
LF_CMP = wp.constant(4)
LF_VALUE = wp.constant(5)
LF_HYST = wp.constant(6)
LF_P0 = wp.constant(7)
LF_P1 = wp.constant(8)
LF_P2 = wp.constant(9)
LF_DURATION = wp.constant(10)


@wp.struct
class Static:
    n_actors: int
    n_colliders: int
    n_occluders: int
    n_interactions: int
    ego: int
    perception_ego: int
    goal_interaction: int
    goal_route_end: int
    dt: wp.float64
    substep_h: wp.float64
    substep_count: int
    warmup_ticks: int
    total_ticks: int
    friction_scale: wp.float64
    visibility_range_m: wp.float64
    traffic_speed_factor: wp.float64
    object_list_range_m: wp.float64
    clip_seconds: wp.float64
    dt_decision_s: wp.float64
    max_decisions: int
    rw_collision_penalty: wp.float64
    rw_goal_bonus: wp.float64
    rw_progress_weight: wp.float64
    rw_proximity_weight: wp.float64
    rw_proximity_range_m: wp.float64
    rw_comfort_weight: wp.float64
    # lanes
    lane_pt_start: wp.array(dtype=wp.int32)
    lane_pt_count: wp.array(dtype=wp.int32)
    lane_ws_start: wp.array(dtype=wp.int32)
    lane_ws_count: wp.array(dtype=wp.int32)
    lane_pt_x: wp.array(dtype=wp.float64)
    lane_pt_y: wp.array(dtype=wp.float64)
    lane_pt_cum: wp.array(dtype=wp.float64)
    lane_pt_heading: wp.array(dtype=wp.float64)
    lane_ws_s: wp.array(dtype=wp.float64)
    lane_ws_w: wp.array(dtype=wp.float64)
    lane_length: wp.array(dtype=wp.float64)
    lane_speed_limit: wp.array(dtype=wp.float64)
    lane_width: wp.array(dtype=wp.float64)
    # actors
    actor_kind: wp.array(dtype=wp.int32)
    actor_dims: wp.array2d(dtype=wp.float64)
    actor_static: wp.array(dtype=wp.int32)
    actor_dynamic: wp.array(dtype=wp.int32)
    actor_rules: wp.array2d(dtype=wp.float64)
    actor_comfort: wp.array2d(dtype=wp.float64)
    actor_limits: wp.array2d(dtype=wp.float64)
    actor_physics: wp.array2d(dtype=wp.float64)
    actor_dynamics_model: wp.array(dtype=wp.int32)
    actor_init: wp.array2d(dtype=wp.float64)
    actor_present_at_start: wp.array(dtype=wp.int32)
    actor_cruise_override_valid: wp.array(dtype=wp.int32)
    actor_cruise_override: wp.array(dtype=wp.float64)
    actor_motion_direction: wp.array(dtype=wp.int32)
    actor_route_leg_start: wp.array(dtype=wp.int32)
    actor_route_leg_count: wp.array(dtype=wp.int32)
    actor_route_length: wp.array(dtype=wp.float64)
    actor_pedestrian_like: wp.array(dtype=wp.int32)
    actor_knockdown_vulnerable: wp.array(dtype=wp.int32)
    actor_road_actor: wp.array(dtype=wp.int32)
    leg_lane: wp.array(dtype=wp.int32)
    leg_reversed: wp.array(dtype=wp.int32)
    leg_s_start: wp.array(dtype=wp.float64)
    leg_length: wp.array(dtype=wp.float64)
    # colliders / occluders
    collider_obb: wp.array2d(dtype=wp.float64)
    occluder_obb: wp.array2d(dtype=wp.float64)
    solver_body_order: wp.array(dtype=wp.int32)
    # interactions
    it_actor: wp.array(dtype=wp.int32)
    it_verb: wp.array(dtype=wp.int32)
    it_trigger: wp.array(dtype=wp.int32)
    it_f: wp.array2d(dtype=wp.float64)
    it_i: wp.array2d(dtype=wp.int32)
    cond_root: wp.array2d(dtype=wp.int32)
    cond_leaf: wp.array2d(dtype=wp.float64)
    polygon_pts: wp.array2d(dtype=wp.float64)


@wp.struct
class State:
    active: wp.array(dtype=wp.int32)
    tick: wp.array(dtype=wp.int32)
    t: wp.array(dtype=wp.float64)
    finished: wp.array(dtype=wp.int32)
    prev_coll_t_valid: wp.array(dtype=wp.int32)
    prev_coll_t: wp.array(dtype=wp.float64)
    active_pair: wp.array3d(dtype=wp.int8)
    detected: wp.array3d(dtype=wp.int8)
    ego_collision: wp.array(dtype=wp.int32)
    goal_fired: wp.array(dtype=wp.int32)
    decision_count: wp.array(dtype=wp.int32)
    prev_ego_s_valid: wp.array(dtype=wp.int32)
    prev_ego_s: wp.array(dtype=wp.float64)
    ended: wp.array(dtype=wp.int32)
    terminated: wp.array(dtype=wp.int32)
    truncated: wp.array(dtype=wp.int32)
    reward: wp.array(dtype=wp.float64)
    reward_terms: wp.array2d(dtype=wp.float64)
    action_f: wp.array2d(dtype=wp.float64)
    action_valid: wp.array2d(dtype=wp.int32)
    state_vector: wp.array2d(dtype=wp.float64)
    t_out: wp.array(dtype=wp.float64)
    # actors
    sem: wp.array3d(dtype=wp.float64)
    flags: wp.array3d(dtype=wp.int32)
    cmd: wp.array3d(dtype=wp.float64)
    phys: wp.array3d(dtype=wp.float64)
    snap: wp.array3d(dtype=wp.float64)
    snap_live: wp.array2d(dtype=wp.int32)
    plan: wp.array3d(dtype=wp.float64)
    conf: wp.array4d(dtype=wp.float64)
    conf_n: wp.array2d(dtype=wp.int32)
    obj: wp.array3d(dtype=wp.float64)
    obj_valid: wp.array2d(dtype=wp.int32)
    prev_range: wp.array2d(dtype=wp.float64)
    prev_range_valid: wp.array2d(dtype=wp.int32)
    # interactions
    it_state: wp.array3d(dtype=wp.int32)
    it_time: wp.array3d(dtype=wp.float64)
    # solver scratch
    sbody: wp.array3d(dtype=wp.float64)
    sbody_slot: wp.array2d(dtype=wp.int32)
    sbody_n: wp.array(dtype=wp.int32)
    speed_before: wp.array2d(dtype=wp.float64)


# ============================================================== core/math.ts


@wp.func
def clampf(v: F, lo: F, hi: F) -> F:
    # core/math.ts clamp: `v < lo ? lo : v > hi ? hi : v`
    if v < lo:
        return lo
    if v > hi:
        return hi
    return v


@wp.func
def norm_angle(a: F) -> F:
    # core/math.ts normalizeAngle
    v = wp.mod(a, F(TWO_PI))
    if v <= -F(PI):
        v = v + F(TWO_PI)
    if v > F(PI):
        v = v - F(TWO_PI)
    return v


@wp.func
def angle_delta(from_rad: F, to_rad: F) -> F:
    return norm_angle(to_rad - from_rad)


@wp.func
def lerpf(a: F, b: F, t: F) -> F:
    return a + (b - a) * t


@wp.func
def lerp_angle(a: F, b: F, t: F) -> F:
    return norm_angle(a + angle_delta(a, b) * t)


@wp.func
def hypot(x: F, y: F) -> F:
    return wp.sqrt(x * x + y * y)


@wp.func
def signf(x: F) -> F:
    # Math.sign
    if x > F(0.0):
        return F(1.0)
    if x < F(0.0):
        return -F(1.0)
    return F(0.0)


@wp.func
def obb_corner(cx: F, cy: F, l: F, w: F, h: F, k: int):
    # core/math.ts obbCorners, counter-clockwise from front-left
    c = wp.cos(h)
    s = wp.sin(h)
    hl = l / F(2.0)
    hw = w / F(2.0)
    fx = c * hl
    fy = s * hl
    lx = -s * hw
    ly = c * hw
    if k == 0:
        return cx + fx + lx, cy + fy + ly
    if k == 1:
        return cx - fx + lx, cy - fy + ly
    if k == 2:
        return cx - fx - lx, cy - fy - ly
    return cx + fx - lx, cy + fy - ly


@wp.func
def project_extent(cx: F, cy: F, l: F, w: F, h: F, ax: F, ay: F):
    lo = F(INF)
    hi = -F(INF)
    for k in range(4):
        px, py = obb_corner(cx, cy, l, w, h, k)
        v = px * ax + py * ay
        if v < lo:
            lo = v
        if v > hi:
            hi = v
    return lo, hi


@wp.func
def obb_overlap(ax_: F, ay_: F, al: F, aw: F, ah: F, bx_: F, by_: F, bl: F, bw: F, bh: F) -> int:
    # core/math.ts obbOverlap: SAT over four axes with corner projections; touching counts.
    for axis in range(4):
        ax = F(0.0)
        ay = F(0.0)
        if axis == 0:
            ax = wp.cos(ah)
            ay = wp.sin(ah)
        elif axis == 1:
            ax = -wp.sin(ah)
            ay = wp.cos(ah)
        elif axis == 2:
            ax = wp.cos(bh)
            ay = wp.sin(bh)
        else:
            ax = -wp.sin(bh)
            ay = wp.cos(bh)
        alo, ahi = project_extent(ax_, ay_, al, aw, ah, ax, ay)
        blo, bhi = project_extent(bx_, by_, bl, bw, bh, ax, ay)
        if ahi < blo or bhi < alo:
            return 0
    return 1


@wp.func
def obb_separation_sat(ax_: F, ay_: F, al: F, aw: F, ah: F, bx_: F, by_: F, bl: F, bw: F, bh: F) -> F:
    # pairs.ts obbSeparation: maximum separating-axis gap
    separation = -F(INF)
    for axis in range(4):
        ax = F(0.0)
        ay = F(0.0)
        if axis == 0:
            ax = wp.cos(ah)
            ay = wp.sin(ah)
        elif axis == 1:
            ax = -wp.sin(ah)
            ay = wp.cos(ah)
        elif axis == 2:
            ax = wp.cos(bh)
            ay = wp.sin(bh)
        else:
            ax = -wp.sin(bh)
            ay = wp.cos(bh)
        alo, ahi = project_extent(ax_, ay_, al, aw, ah, ax, ay)
        blo, bhi = project_extent(bx_, by_, bl, bw, bh, ax, ay)
        separation = wp.max(separation, wp.max(blo - ahi, alo - bhi))
    return separation


@wp.func
def projection_radius(l: F, w: F, h: F, ax: F, ay: F) -> F:
    # pairs.ts projectionRadius
    c = wp.cos(h)
    s = wp.sin(h)
    return wp.abs(c * ax + s * ay) * (l / F(2.0)) + wp.abs(-s * ax + c * ay) * (w / F(2.0))


@wp.func
def segment_intersects(px: F, py: F, p2x: F, p2y: F, qx: F, qy: F, q2x: F, q2y: F) -> int:
    # core/math.ts segmentIntersection !== null
    rx = p2x - px
    ry = p2y - py
    sx = q2x - qx
    sy = q2y - qy
    denom = rx * sy - ry * sx
    if wp.abs(denom) < F(1.0e-12):
        return 0
    qpx = qx - px
    qpy = qy - py
    t = (qpx * sy - qpy * sx) / denom
    u = (qpx * ry - qpy * rx) / denom
    if t < F(0.0) or t > F(1.0) or u < F(0.0) or u > F(1.0):
        return 0
    return 1


@wp.func
def segment_hits_obb(ax: F, ay: F, bx: F, by: F, cx: F, cy: F, l: F, w: F, h: F) -> int:
    for i in range(4):
        px, py = obb_corner(cx, cy, l, w, h, i)
        j = i + 1
        if j == 4:
            j = 0
        qx, qy = obb_corner(cx, cy, l, w, h, j)
        if segment_intersects(ax, ay, bx, by, px, py, qx, qy) == 1:
            return 1
    return 0


# ---------------------------------------------------------- swept OBB (pairs.ts)


@wp.func
def fixed_orientation_sweep(a0x: F, a0y: F, a1x: F, a1y: F, al: F, aw: F, ah: F,
                            b0x: F, b0y: F, b1x: F, b1y: F, bl: F, bw: F, bh: F):
    # pairs.ts fixedOrientationSweep → (hit, toi)
    enter = F(0.0)
    leave = F(1.0)
    rel0x = b0x - a0x
    rel0y = b0y - a0y
    rdx = (b1x - b0x) - (a1x - a0x)
    rdy = (b1y - b0y) - (a1y - a0y)
    for axis in range(4):
        ax = F(0.0)
        ay = F(0.0)
        if axis == 0:
            ax = wp.cos(ah)
            ay = wp.sin(ah)
        elif axis == 1:
            ax = -wp.sin(ah)
            ay = wp.cos(ah)
        elif axis == 2:
            ax = wp.cos(bh)
            ay = wp.sin(bh)
        else:
            ax = -wp.sin(bh)
            ay = wp.cos(bh)
        radius = projection_radius(al, aw, ah, ax, ay) + projection_radius(bl, bw, bh, ax, ay)
        p = rel0x * ax + rel0y * ay
        v = rdx * ax + rdy * ay
        if wp.abs(v) < F(1.0e-15):
            if wp.abs(p) > radius:
                return 0, F(0.0)
            continue
        t0 = (-radius - p) / v
        t1 = (radius - p) / v
        enter = wp.max(enter, wp.min(t0, t1))
        leave = wp.min(leave, wp.max(t0, t1))
        if enter > leave:
            return 0, F(0.0)
    if enter <= F(1.0) and leave >= F(0.0):
        return 1, wp.max(F(0.0), enter)
    return 0, F(0.0)


@wp.func
def swept_obb_toi(a0x: F, a0y: F, a0h: F, a1x: F, a1y: F, a1h: F, al: F, aw: F,
                  b0x: F, b0y: F, b0h: F, b1x: F, b1y: F, b1h: F, bl: F, bw: F):
    # pairs.ts sweptObbTimeOfImpact with constant dimensions → (hit, toi)
    if obb_overlap(a0x, a0y, al, aw, a0h, b0x, b0y, bl, bw, b0h) == 1:
        return 1, F(0.0)
    da = angle_delta(a0h, a1h)
    db = angle_delta(b0h, b1h)
    if wp.abs(da) < F(1.0e-12) and wp.abs(db) < F(1.0e-12):
        return fixed_orientation_sweep(a0x, a0y, a1x, a1y, al, aw, a0h, b0x, b0y, b1x, b1y, bl, bw, b0h)
    relative_travel = hypot((b1x - b0x) - (a1x - a0x), (b1y - b0y) - (a1y - a0y))
    speed_bound = relative_travel + wp.abs(da) * hypot(al, aw) / F(2.0) + wp.abs(db) * hypot(bl, bw) / F(2.0)
    if speed_bound <= F(0.0):
        return 0, F(0.0)
    t = F(0.0)
    it = int(0)
    while it < SWEEP_MAX_ITERATIONS and t <= F(1.0):
        ax = lerpf(a0x, a1x, t)
        ay = lerpf(a0y, a1y, t)
        ah = lerp_angle(a0h, a1h, t)
        bx = lerpf(b0x, b1x, t)
        by = lerpf(b0y, b1y, t)
        bh = lerp_angle(b0h, b1h, t)
        separation = obb_separation_sat(ax, ay, al, aw, ah, bx, by, bl, bw, bh)
        if separation <= F(SWEEP_CONTACT_EPSILON_M) or obb_overlap(ax, ay, al, aw, ah, bx, by, bl, bw, bh) == 1:
            return 1, t
        step = separation / speed_bound
        if step <= F(1.0e-14):
            return 1, t
        t = t + step
        it += 1
    if t <= F(1.0):
        ax = lerpf(a0x, a1x, t)
        ay = lerpf(a0y, a1y, t)
        ah = lerp_angle(a0h, a1h, t)
        bx = lerpf(b0x, b1x, t)
        by = lerpf(b0y, b1y, t)
        bh = lerp_angle(b0h, b1h, t)
        if obb_overlap(ax, ay, al, aw, ah, bx, by, bl, bw, bh) == 1:
            return 1, t
    return 0, F(0.0)


# ============================================================ map geometry


@wp.func
def lane_sample_storage(st: Static, lane: int, s: F):
    # lane-graph.ts sampleStorage → (x, y, heading)
    start = st.lane_pt_start[lane]
    n = st.lane_pt_count[lane]
    length = st.lane_length[lane]
    q = clampf(s, F(0.0), length)
    lo = int(0)
    hi = n - 1
    while hi - lo > 1:
        mid = (lo + hi) >> 1
        if st.lane_pt_cum[start + mid] <= q:
            lo = mid
        else:
            hi = mid
    ax = st.lane_pt_x[start + lo]
    ay = st.lane_pt_y[start + lo]
    bx = st.lane_pt_x[start + hi]
    by = st.lane_pt_y[start + hi]
    span = st.lane_pt_cum[start + hi] - st.lane_pt_cum[start + lo]
    t = F(0.0)
    if span > F(1.0e-9):
        t = (q - st.lane_pt_cum[start + lo]) / span
    return ax + (bx - ax) * t, ay + (by - ay) * t, st.lane_pt_heading[start + lo]


@wp.func
def lane_width_at(st: Static, lane: int, s: F) -> F:
    # lane-graph.ts widthAt
    n = st.lane_ws_count[lane]
    if n == 0:
        return st.lane_width[lane]
    start = st.lane_ws_start[lane]
    if n == 1:
        return st.lane_ws_w[start]
    q = clampf(s, F(0.0), st.lane_length[lane])
    if q <= st.lane_ws_s[start]:
        return st.lane_ws_w[start]
    for i in range(1, n):
        a_s = st.lane_ws_s[start + i - 1]
        a_w = st.lane_ws_w[start + i - 1]
        b_s = st.lane_ws_s[start + i]
        b_w = st.lane_ws_w[start + i]
        if q <= b_s:
            span = b_s - a_s
            t = F(0.0)
            if span > F(1.0e-9):
                t = (q - a_s) / span
            return a_w + (b_w - a_w) * t
    return st.lane_ws_w[start + n - 1]


@wp.func
def route_leg_index_at(st: Static, a: int, s: F) -> int:
    # route.ts legIndexAt (returns leg index relative to the actor's first leg)
    q = clampf(s, F(0.0), st.actor_route_length[a])
    start = st.actor_route_leg_start[a]
    lo = int(0)
    hi = st.actor_route_leg_count[a] - 1
    while lo < hi:
        mid = (lo + hi + 1) >> 1
        if st.leg_s_start[start + mid] <= q:
            lo = mid
        else:
            hi = mid - 1
    return lo


@wp.func
def route_pose(st: Static, a: int, s: F):
    # route.ts poseAt → (x, y, headingRad, laneIndex, laneS, storageS)
    q = clampf(s, F(0.0), st.actor_route_length[a])
    leg = st.actor_route_leg_start[a] + route_leg_index_at(st, a, q)
    lane_s = clampf(q - st.leg_s_start[leg], F(0.0), st.leg_length[leg])
    storage_s = lane_s
    if st.leg_reversed[leg] == 1:
        storage_s = st.leg_length[leg] - lane_s
    lane = st.leg_lane[leg]
    x, y, h = lane_sample_storage(st, lane, storage_s)
    if st.leg_reversed[leg] == 1:
        h = h + F(PI)
    return x, y, norm_angle(h), lane, lane_s, storage_s


@wp.func
def route_heading(st: Static, a: int, s: F) -> F:
    x, y, h, lane, lane_s, storage_s = route_pose(st, a, s)
    return h


@wp.func
def route_width_at(st: Static, a: int, s: F) -> F:
    leg = st.actor_route_leg_start[a] + route_leg_index_at(st, a, s)
    lane_s = clampf(s - st.leg_s_start[leg], F(0.0), st.leg_length[leg])
    storage_s = lane_s
    if st.leg_reversed[leg] == 1:
        storage_s = st.leg_length[leg] - lane_s
    return lane_width_at(st, st.leg_lane[leg], storage_s)


@wp.func
def route_point_with_offset(st: Static, a: int, s: F, lateral: F):
    # route.ts pointWithOffset
    x, y, h, lane, lane_s, storage_s = route_pose(st, a, s)
    if lateral == F(0.0):
        return x, y
    nx = -wp.sin(h)
    ny = wp.cos(h)
    return x + nx * lateral, y + ny * lateral


@wp.func
def route_s_of_lane_storage(st: Static, a: int, lane: int, storage_s: F):
    # route.ts sOfLaneStorage → (found, s); first visit wins
    start = st.actor_route_leg_start[a]
    n = st.actor_route_leg_count[a]
    for i in range(n):
        leg = start + i
        if st.leg_lane[leg] == lane:
            travel = storage_s
            if st.leg_reversed[leg] == 1:
                travel = st.leg_length[leg] - storage_s
            return 1, st.leg_s_start[leg] + clampf(travel, F(0.0), st.leg_length[leg])
    return 0, F(0.0)


@wp.func
def route_project_point(st: Static, a: int, px: F, py: F) -> F:
    # route.ts projectPoint (stepM = 2): coarse scan then 24 ternary refinements
    length = st.actor_route_length[a]
    step = F(2.0)
    best_s = F(0.0)
    best_d = F(INF)
    n = wp.max(2, wp.int32(wp.ceil(length / step)) + 1)
    for i in range(n):
        s = (length * F(i)) / F(n - 1)
        x, y, h, lane, lane_s, storage_s = route_pose(st, a, s)
        d = hypot(x - px, y - py)
        if d < best_d:
            best_d = d
            best_s = s
    lo = wp.max(F(0.0), best_s - step)
    hi = wp.min(length, best_s + step)
    for it in range(24):
        m1 = lo + (hi - lo) / F(3.0)
        m2 = hi - (hi - lo) / F(3.0)
        x1, y1, h1, l1, ls1, ss1 = route_pose(st, a, m1)
        x2, y2, h2, l2, ls2, ss2 = route_pose(st, a, m2)
        d1 = hypot(x1 - px, y1 - py)
        d2 = hypot(x2 - px, y2 - py)
        if d1 < d2:
            hi = m2
        else:
            lo = m1
    return (lo + hi) / F(2.0)


@wp.func
def route_lateral_offset_at(st: Static, a: int, s: F, px: F, py: F) -> F:
    # route.ts lateralOffsetAt
    x, y, h, lane, lane_s, storage_s = route_pose(st, a, s)
    dx = px - x
    dy = py - y
    return -wp.sin(h) * dx + wp.cos(h) * dy


# ============================================================ dynamic-v1


@wp.func
def control_for(st: Static, a: int, x: F, y: F, yaw: F, u: F, direction: F,
                target_speed: F, target_accel: F, preview_x: F, preview_y: F, preview_heading: F):
    # dynamic-v1.ts controlFor → (throttle, brake, steer)
    p = st.actor_physics
    travel_speed = direction * u
    speed_error = target_speed - travel_speed
    desired_accel = clampf(target_accel + F(1.25) * speed_error, -p[a, P_MAX_DECEL], p[a, P_MAX_ACCEL])
    resistance = p[a, P_DRAG] * travel_speed * travel_speed + p[a, P_ROLLING] * p[a, P_MASS] * F(G)
    requested_force = p[a, P_MASS] * desired_accel + resistance
    throttle = clampf(requested_force / p[a, P_MAX_DRIVE], F(0.0), F(1.0))
    brake = clampf(-requested_force / p[a, P_MAX_BRAKE], F(0.0), F(1.0))
    dx = preview_x - x
    dy = preview_y - y
    preview_distance = wp.max(hypot(dx, dy), F(1.0))
    bearing = wp.atan2(dy, dx)
    tracking_yaw = yaw
    if direction < F(0.0):
        tracking_yaw = yaw + F(PI)
    tracking_yaw = norm_angle(tracking_yaw)
    alpha = angle_delta(tracking_yaw, bearing)
    pure_pursuit = wp.atan2(F(2.0) * p[a, P_WHEELBASE] * wp.sin(alpha), preview_distance)
    heading_correction = F(0.35) * angle_delta(tracking_yaw, preview_heading)
    steer_rad = clampf(direction * (pure_pursuit + heading_correction), -p[a, P_MAX_STEER], p[a, P_MAX_STEER])
    return throttle, brake, steer_rad / p[a, P_MAX_STEER]


@wp.func
def friction_ellipse_lateral(desired_fy: F, fx: F, normal_n: F, mu: F):
    # dynamic-v1.ts frictionEllipseLateral → (force, utilization)
    capacity = wp.max(mu * normal_n, F(1.0))
    remaining = wp.sqrt(wp.max(F(0.0), capacity * capacity - fx * fx))
    force = clampf(desired_fy, -remaining, remaining)
    return force, hypot(fx, force) / capacity


@wp.func
def bounded_accel(st: Static, s: State, w: int, a: int, requested: F, h: F) -> F:
    # dynamic-v1.ts boundedIntent / boundedControl jerk limit on commandedAccelerationMps2
    p = st.actor_physics
    bounded = clampf(requested, -p[a, P_MAX_DECEL], p[a, P_MAX_ACCEL])
    commanded = s.phys[w, a, PH_CMD_ACCEL]
    delta = clampf(bounded - commanded, -p[a, P_MAX_JERK] * h, p[a, P_MAX_JERK] * h)
    commanded = commanded + delta
    s.phys[w, a, PH_CMD_ACCEL] = commanded
    return commanded


@wp.func
def integrate_single_track(st: Static, s: State, w: int, a: int, h: F, friction_scale: F,
                           motion_direction: F, target_speed: F, target_accel: F,
                           preview_x: F, preview_y: F, preview_heading: F,
                           has_control: int, c_throttle: F, c_brake: F, c_steer: F):
    # dynamic-v1.ts DynamicV1Backend.integrate (single-track branch)
    p = st.actor_physics
    ph = s.phys
    x = ph[w, a, PH_X]
    y = ph[w, a, PH_Y]
    yaw = ph[w, a, PH_YAW]
    u = ph[w, a, PH_U]
    v = ph[w, a, PH_V]
    r = ph[w, a, PH_R]
    steer = ph[w, a, PH_STEER]
    wheel = ph[w, a, PH_WHEEL]
    mass = p[a, P_MASS]

    throttle = F(0.0)
    brake = F(0.0)
    steer_cmd = F(0.0)
    if has_control == 1:
        # boundedControl
        th = clampf(c_throttle, F(0.0), F(1.0))
        br = clampf(c_brake, F(0.0), F(1.0))
        steer_cmd = clampf(c_steer, -F(1.0), F(1.0))
        requested_ax = (th * p[a, P_MAX_DRIVE] - br * p[a, P_MAX_BRAKE]) / mass
        commanded = bounded_accel(st, s, w, a, requested_ax, h)
        force_n = commanded * mass
        if force_n >= F(0.0):
            throttle = clampf(force_n / p[a, P_MAX_DRIVE], F(0.0), F(1.0))
            brake = F(0.0)
        else:
            throttle = F(0.0)
            brake = clampf(-force_n / p[a, P_MAX_BRAKE], F(0.0), F(1.0))
    else:
        bounded_target_accel = bounded_accel(st, s, w, a, target_accel, h)
        throttle, brake, steer_cmd = control_for(st, a, x, y, yaw, u, motion_direction, target_speed,
                                                 bounded_target_accel, preview_x, preview_y, preview_heading)

    steer_target = steer_cmd * p[a, P_MAX_STEER]
    steer_derivative = clampf((steer_target - steer) / p[a, P_STEER_TAU], -p[a, P_STEER_RATE], p[a, P_STEER_RATE])
    steer = clampf(steer + steer_derivative * h, -p[a, P_MAX_STEER], p[a, P_MAX_STEER])

    drive_n = motion_direction * throttle * p[a, P_MAX_DRIVE]
    brake_n = brake * p[a, P_MAX_BRAKE]
    direction = motion_direction
    if wp.abs(u) > F(0.05):
        direction = signf(u)
    drag_n = p[a, P_DRAG] * u * wp.abs(u)
    rolling_n = p[a, P_ROLLING] * mass * F(G) * wp.tanh(u / F(0.1))
    requested_fx = drive_n - direction * brake_n - drag_n - rolling_n
    requested_ax = requested_fx / mass

    lf = p[a, P_CG_FRONT]
    lr = p[a, P_WHEELBASE] - lf
    front_normal = clampf((mass * F(G) * lr - mass * requested_ax * p[a, P_CG_HEIGHT]) / p[a, P_WHEELBASE],
                          F(0.1) * mass * F(G), F(0.9) * mass * F(G))
    rear_normal = mass * F(G) - front_normal
    mu = wp.max(F(0.05), p[a, P_TIRE_MU] * friction_scale)

    front_fx_request = F(0.0)
    if brake > F(0.0):
        front_fx_request = -direction * brake_n * F(0.6)
    rear_fx_request = requested_fx - front_fx_request
    front_fx = clampf(front_fx_request, -mu * front_normal, mu * front_normal)
    rear_fx = clampf(rear_fx_request, -mu * rear_normal, mu * rear_normal)

    speed_for_slip = wp.max(wp.abs(u), F(0.75))
    front_slip = wp.atan2(v + lf * r, speed_for_slip) - direction * steer
    rear_slip = wp.atan2(v - lr * r, speed_for_slip)
    front_force, front_util = friction_ellipse_lateral(-p[a, P_CS_FRONT] * front_slip, front_fx, front_normal, mu)
    rear_force, rear_util = friction_ellipse_lateral(-p[a, P_CS_REAR] * rear_slip, rear_fx, rear_normal, mu)

    raw_lateral_n = rear_force + front_force * wp.cos(steer)
    lateral_scale = F(1.0)
    if wp.abs(raw_lateral_n) > mass * p[a, P_MAX_LAT_ACCEL]:
        lateral_scale = mass * p[a, P_MAX_LAT_ACCEL] / wp.abs(raw_lateral_n)
    front_fy = front_force * lateral_scale
    rear_fy = rear_force * lateral_scale

    cos_steer = wp.cos(steer)
    sin_steer = wp.sin(steer)
    total_fx = rear_fx + front_fx * cos_steer - front_fy * sin_steer
    u_dot = total_fx / mass + v * r
    v_dot = (rear_fy + front_fy * cos_steer + front_fx * sin_steer) / mass - u * r
    yaw_dot = (lf * (front_fy * cos_steer + front_fx * sin_steer) - lr * rear_fy) / p[a, P_INERTIA]

    old_u = u
    old_v = v
    old_r = r
    old_yaw = yaw
    u = u + u_dot * h
    if motion_direction * u < F(0.0):
        u = F(0.0)
    v = v + v_dot * h
    r = clampf(r + yaw_dot * h, -p[a, P_MAX_YAW_RATE], p[a, P_MAX_YAW_RATE])
    yaw = norm_angle(old_yaw + F(0.5) * (old_r + r) * h)
    old_world_x = old_u * wp.cos(old_yaw) - old_v * wp.sin(old_yaw)
    old_world_y = old_u * wp.sin(old_yaw) + old_v * wp.cos(old_yaw)
    new_world_x = u * wp.cos(yaw) - v * wp.sin(yaw)
    new_world_y = u * wp.sin(yaw) + v * wp.cos(yaw)
    x = x + F(0.5) * (old_world_x + new_world_x) * h
    y = y + F(0.5) * (old_world_y + new_world_y) * h

    rolling_omega = u / p[a, P_WHEEL_RADIUS]
    wheel_tau = F(0.08)
    if brake > F(0.0):
        wheel_tau = F(0.035)
    wheel = wheel + (rolling_omega - wheel) * (h / wheel_tau)
    if u == F(0.0) and brake > F(0.0):
        wheel = F(0.0)

    ph[w, a, PH_X] = x
    ph[w, a, PH_Y] = y
    ph[w, a, PH_YAW] = yaw
    ph[w, a, PH_U] = u
    ph[w, a, PH_V] = v
    ph[w, a, PH_R] = r
    ph[w, a, PH_STEER] = steer
    ph[w, a, PH_WHEEL] = wheel
    ph[w, a, PH_LONG_ACCEL] = u_dot


@wp.func
def integrate_downed(st: Static, s: State, w: int, a: int, h: F, friction_scale: F):
    # dynamic-v1.ts integrateDowned
    ph = s.phys
    u = ph[w, a, PH_U]
    v = ph[w, a, PH_V]
    yaw = ph[w, a, PH_YAW]
    start_speed = hypot(u, v)
    decel = F(SLIDING_FRICTION_COEFFICIENT) * F(G) * wp.max(F(0.05), friction_scale)
    end_speed = wp.max(F(0.0), start_speed - decel * h)
    scale = F(0.0)
    average_scale = F(0.0)
    if start_speed > F(1.0e-9):
        scale = end_speed / start_speed
        average_scale = F(0.5) * (F(1.0) + scale)
    vx_body = u * average_scale
    vy_body = v * average_scale
    c = wp.cos(yaw)
    sn = wp.sin(yaw)
    ph[w, a, PH_X] = ph[w, a, PH_X] + (vx_body * c - vy_body * sn) * h
    ph[w, a, PH_Y] = ph[w, a, PH_Y] + (vx_body * sn + vy_body * c) * h
    ph[w, a, PH_U] = u * scale
    ph[w, a, PH_V] = v * scale
    ph[w, a, PH_LONG_ACCEL] = (end_speed - start_speed) / h
    ph[w, a, PH_R] = F(0.0)
    ph[w, a, PH_STEER] = F(0.0)
    ph[w, a, PH_WHEEL] = F(0.0)


@wp.func
def integrate_pedestrian(st: Static, s: State, w: int, a: int, h: F, friction_scale: F,
                         motion_direction: F, target_speed: F, target_accel: F, preview_x: F, preview_y: F):
    # dynamic-v1.ts integratePedestrian
    p = st.actor_physics
    ph = s.phys
    x = ph[w, a, PH_X]
    y = ph[w, a, PH_Y]
    yaw = ph[w, a, PH_YAW]
    u = ph[w, a, PH_U]
    bounded_target_accel = bounded_accel(st, s, w, a, target_accel, h)
    speed_error = target_speed - motion_direction * u
    accel = clampf(bounded_target_accel + F(1.5) * speed_error,
                   -p[a, P_MAX_DECEL] * friction_scale, p[a, P_MAX_ACCEL] * friction_scale)
    desired_heading = wp.atan2(preview_y - y, preview_x - x)
    yaw_rate = clampf(angle_delta(yaw, desired_heading) / F(0.22), -p[a, P_MAX_YAW_RATE], p[a, P_MAX_YAW_RATE])
    old_speed = u
    u = wp.max(F(0.0), old_speed + accel * h)
    yaw = norm_angle(yaw + yaw_rate * h)
    average_speed = F(0.5) * (old_speed + u)
    ph[w, a, PH_X] = x + wp.cos(yaw) * average_speed * h
    ph[w, a, PH_Y] = y + wp.sin(yaw) * average_speed * h
    ph[w, a, PH_YAW] = yaw
    ph[w, a, PH_U] = u
    ph[w, a, PH_V] = F(0.0)
    ph[w, a, PH_R] = yaw_rate
    ph[w, a, PH_STEER] = F(0.0)
    ph[w, a, PH_WHEEL] = F(0.0)
    ph[w, a, PH_LONG_ACCEL] = accel


@wp.func
def backend_step(st: Static, s: State, w: int, a: int, friction_scale: F,
                 motion_direction: F, target_speed: F, target_accel: F,
                 preview_x: F, preview_y: F, preview_heading: F, downed: int,
                 has_control: int, c_throttle: F, c_brake: F, c_steer: F):
    # dynamic-v1.ts DynamicV1Backend.step: substep loop, previous pose latch
    ph = s.phys
    ph[w, a, PH_PREV_X] = ph[w, a, PH_X]
    ph[w, a, PH_PREV_Y] = ph[w, a, PH_Y]
    ph[w, a, PH_PREV_YAW] = ph[w, a, PH_YAW]
    h = F(st.substep_h)
    model = st.actor_dynamics_model[a]
    for i in range(st.substep_count):
        if model == DYN_PEDESTRIAN:
            if downed == 1:
                integrate_downed(st, s, w, a, h, friction_scale)
            else:
                integrate_pedestrian(st, s, w, a, h, friction_scale, motion_direction, target_speed, target_accel,
                                     preview_x, preview_y)
        else:
            integrate_single_track(st, s, w, a, h, friction_scale, motion_direction, target_speed, target_accel,
                                   preview_x, preview_y, preview_heading, has_control, c_throttle, c_brake, c_steer)
    ph[w, a, PH_COLL_IMPULSE] = F(0.0)
    ph[w, a, PH_COLL_COUNT] = F(0.0)


# ============================================================ dynamics.ts


@wp.func
def shape_value(shape: int, p: F) -> F:
    q = clampf(p, F(0.0), F(1.0))
    if shape == SHAPE_STEP:
        if q > F(0.0):
            return F(1.0)
        return F(0.0)
    if shape == SHAPE_LINEAR:
        return q
    if shape == SHAPE_SINUSOIDAL:
        return (F(1.0) - wp.cos(F(PI) * q)) / F(2.0)
    return q * q * (F(3.0) - F(2.0) * q)


@wp.func
def shape_peak_factor(shape: int) -> F:
    if shape == SHAPE_SINUSOIDAL:
        return F(PI) / F(2.0)
    if shape == SHAPE_CUBIC:
        return F(1.5)
    return F(1.0)


@wp.func
def transition_duration(shape: int, constraint: int, value: F, delta: F, reference_speed: F) -> F:
    mag = wp.abs(delta)
    if shape == SHAPE_STEP:
        return F(MIN_TRANSITION_S)
    if constraint == CONSTRAINT_RATE:
        if mag < F(1.0e-9):
            return F(MIN_TRANSITION_S)
        return (mag / value) * shape_peak_factor(shape)
    if constraint == CONSTRAINT_TIME:
        return wp.max(value, F(MIN_TRANSITION_S))
    return wp.max(value / wp.max(reference_speed, F(0.1)), F(MIN_TRANSITION_S))


@wp.func
def transition_value(shape: int, from_v: F, to_v: F, elapsed: F, duration: F) -> F:
    p = F(1.0)
    if duration > F(MIN_TRANSITION_S):
        p = clampf(elapsed / duration, F(0.0), F(1.0))
    return from_v + (to_v - from_v) * shape_value(shape, p)


# ============================================================ engine helpers


@wp.func
def actor_live(s: State, w: int, a: int) -> int:
    if s.flags[w, a, FL_PRESENT] == 1 and s.flags[w, a, FL_RETIRED] == 0:
        return 1
    return 0


@wp.func
def speed_limit_at(st: Static, s: State, w: int, a: int) -> F:
    # engine.ts speedLimitAt (lanePath routes always carry an rsl)
    x, y, h, lane, lane_s, storage_s = route_pose(st, a, s.sem[w, a, SEM_ROUTE_S])
    return st.lane_speed_limit[lane] * F(st.traffic_speed_factor)


@wp.func
def cruise_speed(st: Static, s: State, w: int, a: int, lane_speed_limit: F) -> F:
    # controllers.ts cruiseSpeed with the non-naturalistic driver (desiredSpeedFactor = 1)
    if s.flags[w, a, FL_CRUISE_OVERRIDE_VALID] == 1:
        return s.sem[w, a, SEM_CRUISE_OVERRIDE]
    return lane_speed_limit * st.actor_rules[a, RULE_SPEED_FACTOR] * F(1.0)


@wp.func
def converge(st: Static, a: int, speed: F, v_target: F) -> F:
    return clampf((v_target - speed) * F(CRUISE_GAIN), -st.actor_limits[a, LIM_BRAKE_COMFORT], st.actor_limits[a, LIM_ACCEL_MAX])


@wp.func
def gap_accel(st: Static, a: int, speed: F, gap_m: F, leader_speed: F, gap_desired: F) -> F:
    error = gap_m - wp.max(gap_desired, F(GAP_MIN_M))
    raw = F(GAP_KP) * error + F(GAP_KD) * (leader_speed - speed)
    return clampf(raw, -st.actor_limits[a, LIM_BRAKE_HARD], st.actor_limits[a, LIM_ACCEL_MAX])


@wp.func
def gap_scale_for(aggression: F) -> F:
    return F(1.3) - F(0.6) * aggression


@wp.func
def desired_gap_m(st: Static, a: int, speed: F, value: F, mode: int, scaled: int) -> F:
    base = value
    if mode == GAP_TIME:
        base = value * speed
    if scaled == 1:
        return base * gap_scale_for(st.actor_rules[a, RULE_AGGRESSION])
    return base


@wp.func
def along_route_gap(st: Static, s: State, w: int, observer: int, other: int):
    # pairs.ts alongRouteGapM → (found, gap)
    ox, oy, oh, olane, olane_s, ostorage = route_pose(st, other, s.sem[w, other, SEM_ROUTE_S])
    found, s_on = route_s_of_lane_storage(st, observer, olane, ostorage)
    if found == 0:
        return 0, F(0.0)
    d = s_on - s.sem[w, observer, SEM_ROUTE_S]
    halves = st.actor_dims[observer, 0] / F(2.0) + st.actor_dims[other, 0] / F(2.0)
    sd = d
    if sd == F(0.0):
        sd = F(1.0)
    return 1, d - signf(sd) * halves


@wp.func
def find_leader(st: Static, s: State, w: int, a: int):
    # controllers.ts findLeader over every other actor → (found, gapM, speedMps, id)
    found = int(0)
    best_gap = F(0.0)
    best_speed = F(0.0)
    best_id = int(-1)
    ax = s.sem[w, a, SEM_X]
    ay = s.sem[w, a, SEM_Y]
    a_route_s = s.sem[w, a, SEM_ROUTE_S]
    observer_heading = route_heading(st, a, a_route_s)
    observer_angle = s.sem[w, a, SEM_HEADING] - observer_heading
    observer_cos = wp.abs(wp.cos(observer_angle))
    observer_sin = wp.abs(wp.sin(observer_angle))
    al = st.actor_dims[a, 0]
    aw = st.actor_dims[a, 1]
    observer_front = (al * observer_cos + aw * observer_sin) / F(2.0)
    observer_side = (aw * observer_cos + al * observer_sin) / F(2.0)
    for b in range(st.n_actors):
        if b == a or actor_live(s, w, b) == 0:
            continue
        bx = s.sem[w, b, SEM_X]
        by = s.sem[w, b, SEM_Y]
        # leaderRouteS: along-route join first, else projection of the body
        bxr, byr, bhr, blane, blane_s, bstorage = route_pose(st, b, s.sem[w, b, SEM_ROUTE_S])
        joined, s_on = route_s_of_lane_storage(st, a, blane, bstorage)
        sl = F(0.0)
        if joined == 1:
            sl = a_route_s + (s_on - a_route_s)
        else:
            sl = route_project_point(st, a, bx, by)
        px0, py0, ph, plane, plane_s, pstorage = route_pose(st, a, sl)
        c = wp.cos(ph)
        sn = wp.sin(ph)
        px = bx - px0
        py = by - py0
        ahead = sl - a_route_s + px * c + py * sn
        if ahead <= F(0.0):
            continue
        lateral = -px * sn + py * c - s.sem[w, a, SEM_LAT_OFF]
        angle = s.sem[w, b, SEM_HEADING] - ph
        body_cos = wp.cos(angle)
        body_sin = wp.sin(angle)
        bl = st.actor_dims[b, 0]
        bw = st.actor_dims[b, 1]
        side = (bw * wp.abs(body_cos) + bl * wp.abs(body_sin)) / F(2.0)
        if wp.abs(lateral) > observer_side + side:
            continue
        front = (bl * wp.abs(body_cos) + bw * wp.abs(body_sin)) / F(2.0)
        gap = ahead - observer_front - front
        if found == 0 or gap < best_gap:
            found = 1
            best_gap = gap
            best_speed = s.sem[w, b, SEM_SPEED] * F(st.actor_motion_direction[b]) * body_cos
            best_id = b
    return found, best_gap, best_speed, best_id


@wp.func
def find_conflict(st: Static, s: State, w: int, a: int):
    # engine.ts findConflict (no ambient traffic) → (found, distM, deltaT, otherKindPedestrianLike, otherId)
    found = int(0)
    best_dist = F(0.0)
    best_delta = F(0.0)
    best_ped = int(0)
    best_id = int(-1)
    my_n = s.conf_n[w, a]
    if my_n == 0 or s.sem[w, a, SEM_SPEED] < F(0.2):
        return 0, F(0.0), F(0.0), 0, -1
    a_speed = s.sem[w, a, SEM_SPEED]
    a_heading = s.sem[w, a, SEM_HEADING]
    for b in range(st.n_actors):
        if b == a or actor_live(s, w, b) == 0:
            continue
        if wp.abs(norm_angle(s.sem[w, b, SEM_HEADING] - a_heading)) < F(CONFLICT_MIN_ANGLE_RAD):
            continue
        their_n = s.conf_n[w, b]
        b_speed = s.sem[w, b, SEM_SPEED]
        stop_outer = int(0)
        i = int(1)
        while i < my_n and stop_outer == 0:
            px = s.conf[w, a, i, 0]
            py = s.conf[w, a, i, 1]
            for j in range(their_n):
                qx = s.conf[w, b, j, 0]
                qy = s.conf[w, b, j, 1]
                if wp.abs(px - qx) > F(CONFLICT_RADIUS_M) or wp.abs(py - qy) > F(CONFLICT_RADIUS_M):
                    continue
                if hypot(px - qx, py - qy) > F(CONFLICT_RADIUS_M):
                    continue
                my_dist = F(i) * F(CONFLICT_STEP_M)
                their_dist = F(j) * F(CONFLICT_STEP_M)
                my_t = my_dist / wp.max(a_speed, F(0.2))
                their_t = their_dist / wp.max(b_speed, F(0.2))
                if their_t >= my_t:
                    continue
                delta = my_t - their_t
                if delta > F(CONFLICT_WINDOW_S):
                    continue
                if found == 0 or my_dist < best_dist:
                    found = 1
                    best_dist = my_dist
                    best_delta = delta
                    best_ped = st.actor_pedestrian_like[b]
                    best_id = b
                break
            if found == 1:
                stop_outer = 1
            i += 1
    return found, best_dist, best_delta, best_ped, best_id


@wp.func
def controller_los(st: Static, s: State, w: int, observer: int, target: int, max_range: F) -> int:
    # engine.ts controllerOccluders + visibility.ts hasLineOfSight: static occluders,
    # every other live actor body, and every collidable prop block the segment.
    ax = s.sem[w, observer, SEM_X]
    ay = s.sem[w, observer, SEM_Y]
    bx = s.sem[w, target, SEM_X]
    by = s.sem[w, target, SEM_Y]
    if hypot(bx - ax, by - ay) > max_range:
        return 0
    for o in range(st.n_occluders):
        if segment_hits_obb(ax, ay, bx, by, st.occluder_obb[o, 0], st.occluder_obb[o, 1], st.occluder_obb[o, 2],
                            st.occluder_obb[o, 3], st.occluder_obb[o, 4]) == 1:
            return 0
    for c in range(st.n_actors):
        if c == observer or c == target or actor_live(s, w, c) == 0:
            continue
        if segment_hits_obb(ax, ay, bx, by, s.sem[w, c, SEM_X], s.sem[w, c, SEM_Y], st.actor_dims[c, 0],
                            st.actor_dims[c, 1], s.sem[w, c, SEM_HEADING]) == 1:
            return 0
    for k in range(st.n_colliders):
        if segment_hits_obb(ax, ay, bx, by, st.collider_obb[k, 0], st.collider_obb[k, 1], st.collider_obb[k, 2],
                            st.collider_obb[k, 3], st.collider_obb[k, 4]) == 1:
            return 0
    return 1


@wp.func
def ego_can_perceive(st: Static, s: State, w: int, observer: int, target: int) -> int:
    # engine.ts egoCanPerceive
    if observer != st.perception_ego:
        return 1
    if actor_live(s, w, target) == 0:
        return 0
    dx = s.sem[w, target, SEM_X] - s.sem[w, observer, SEM_X]
    dy = s.sem[w, target, SEM_Y] - s.sem[w, observer, SEM_Y]
    range_m = hypot(dx, dy)
    max_range = wp.min(F(EGO_SENSOR_RANGE_M), F(st.visibility_range_m))
    if range_m > max_range:
        return 0
    bearing = wp.atan2(dy, dx)
    if wp.abs(norm_angle(bearing - s.sem[w, observer, SEM_HEADING])) > F(EGO_SENSOR_HALF_ANGLE_RAD):
        return 0
    return controller_los(st, s, w, observer, target, max_range)


@wp.func
def cornering_cap(st: Static, a: int, route_s: F, current_speed: F, desired_speed: F) -> F:
    # cornering.ts corneringPlan → accelerationCapMps2 (physical limits from the dynamic profile)
    desired = wp.max(F(0.0), desired_speed)
    length = st.actor_route_length[a]
    if desired == F(0.0) or length <= F(0.0):
        return (desired - current_speed) / F(ENVELOPE_RESPONSE_S)
    lateral_budget = wp.max(F(0.5), wp.min(st.actor_comfort[a, 0], st.actor_physics[a, P_MAX_LAT_ACCEL] * F(0.8)))
    braking_budget = wp.max(F(0.5), wp.min(st.actor_comfort[a, 1], st.actor_physics[a, P_MAX_DECEL] * F(0.8)))
    braking_distance = current_speed * current_speed / (F(2.0) * braking_budget)
    horizon = clampf(braking_distance + F(18.0), F(25.0), F(80.0))
    end_s = wp.min(length, route_s + horizon)
    cap = desired
    center_s = wp.min(end_s, route_s + F(CURVATURE_SAMPLE_STEP_M))
    guard = int(0)
    while center_s <= end_s + F(1.0e-9) and guard < 4096:
        before_s = wp.max(F(0.0), center_s - F(CURVATURE_WINDOW_M) / F(2.0))
        after_s = wp.min(length, center_s + F(CURVATURE_WINDOW_M) / F(2.0))
        span = after_s - before_s
        if span > F(1.0e-6):
            before_h = route_heading(st, a, before_s)
            after_h = route_heading(st, a, after_s)
            curvature = wp.abs(angle_delta(before_h, after_h)) / span
            if curvature >= F(MIN_CURVATURE_PER_M):
                turn_speed = wp.sqrt(lateral_budget / curvature)
                distance_to_curve = wp.max(F(0.0), before_s - route_s)
                approach_speed = wp.sqrt(turn_speed * turn_speed + F(2.0) * braking_budget * distance_to_curve)
                cap = wp.min(cap, approach_speed)
        if center_s >= end_s:
            break
        center_s = wp.min(end_s, center_s + F(CURVATURE_SAMPLE_STEP_M))
        guard += 1
    speed_limit = clampf(cap, F(0.0), desired)
    if speed_limit < desired:
        return (speed_limit - current_speed) / F(ENVELOPE_RESPONSE_S)
    return F(INF)


# ============================================================ conditions


@wp.func
def compare(cmp: int, value: F, threshold: F) -> int:
    if cmp == CMP_LT:
        if value < threshold:
            return 1
        return 0
    if cmp == CMP_LTE:
        if value <= threshold:
            return 1
        return 0
    if cmp == CMP_GT:
        if value > threshold:
            return 1
        return 0
    if value >= threshold:
        return 1
    return 0


@wp.func
def point_in_polygon(st: Static, px: F, py: F, start: int, n: int) -> int:
    # core/math.ts pointInPolygon
    inside = int(0)
    j = n - 1
    for i in range(n):
        ax = st.polygon_pts[start + i, 0]
        ay = st.polygon_pts[start + i, 1]
        bx = st.polygon_pts[start + j, 0]
        by = st.polygon_pts[start + j, 1]
        if (ay > py) != (by > py):
            x_at = ((bx - ax) * (py - ay)) / (by - ay) + ax
            if px < x_at:
                inside = 1 - inside
        j = i
    return inside


@wp.func
def leaf_actor(st: Static, s: State, w: int, idx: F) -> int:
    # triggers.ts actor(): present and not retired, else "missing" (-1)
    a = wp.int32(idx)
    if a < 0 or a >= st.n_actors:
        return -1
    if actor_live(s, w, a) == 0:
        return -1
    return a


@wp.func
def evaluate_leaf(st: Static, s: State, w: int, leaf: int, t: F) -> int:
    kind = wp.int32(st.cond_leaf[leaf, LF_KIND])
    if kind == LEAF_DISTANCE:
        a = leaf_actor(st, s, w, st.cond_leaf[leaf, LF_A])
        b = leaf_actor(st, s, w, st.cond_leaf[leaf, LF_B])
        if a < 0 or b < 0:
            return 0
        cmp = wp.int32(st.cond_leaf[leaf, LF_CMP])
        value = st.cond_leaf[leaf, LF_VALUE]
        hyst = st.cond_leaf[leaf, LF_HYST]
        threshold = value + hyst
        if cmp == CMP_LT or cmp == CMP_LTE:
            threshold = wp.max(F(0.0), value - hyst)
        if wp.int32(st.cond_leaf[leaf, LF_MODE]) == DIST_EUCLIDEAN:
            # pairs.ts readPair gapM with circumscribed radii
            center = hypot(s.sem[w, b, SEM_X] - s.sem[w, a, SEM_X], s.sem[w, b, SEM_Y] - s.sem[w, a, SEM_Y])
            clearance = hypot(st.actor_dims[a, 0], st.actor_dims[a, 1]) / F(2.0) + hypot(st.actor_dims[b, 0], st.actor_dims[b, 1]) / F(2.0)
            gap = wp.max(F(0.0), center - clearance)
            if center < F(1.0e-9):
                gap = F(0.0)
            return compare(cmp, gap, threshold)
        found, gap = along_route_gap(st, s, w, a, b)
        if found == 0:
            return 0
        return compare(cmp, wp.abs(gap), threshold)
    if kind == LEAF_HEADWAY:
        a = leaf_actor(st, s, w, st.cond_leaf[leaf, LF_A])
        b = leaf_actor(st, s, w, st.cond_leaf[leaf, LF_B])
        if a < 0 or b < 0:
            return 0
        found, gap = along_route_gap(st, s, w, a, b)
        if found == 0:
            return 0
        cmp = wp.int32(st.cond_leaf[leaf, LF_CMP])
        speed = s.sem[w, a, SEM_SPEED]
        if speed < F(1.0e-3):
            if gap <= F(0.0):
                return compare(cmp, F(0.0), st.cond_leaf[leaf, LF_VALUE])
            if cmp == CMP_GT or cmp == CMP_GTE:
                return 1
            return 0
        return compare(cmp, gap / speed, st.cond_leaf[leaf, LF_VALUE])
    if kind == LEAF_SPEED:
        a = leaf_actor(st, s, w, st.cond_leaf[leaf, LF_A])
        if a < 0:
            return 0
        return compare(wp.int32(st.cond_leaf[leaf, LF_CMP]), s.sem[w, a, SEM_SPEED], st.cond_leaf[leaf, LF_VALUE])
    if kind == LEAF_STANDSTILL:
        a = leaf_actor(st, s, w, st.cond_leaf[leaf, LF_A])
        if a < 0 or s.flags[w, a, FL_STANDSTILL_VALID] == 0:
            return 0
        if t - s.sem[w, a, SEM_STANDSTILL_SINCE] >= st.cond_leaf[leaf, LF_DURATION]:
            return 1
        return 0
    if kind == LEAF_COLLISION:
        ia = wp.int32(st.cond_leaf[leaf, LF_A])
        ib = wp.int32(st.cond_leaf[leaf, LF_B])
        nb = st.n_actors + st.n_colliders
        if ia >= 0 and ib >= 0:
            if s.detected[w, ia, ib] == wp.int8(1) or s.detected[w, ib, ia] == wp.int8(1):
                return 1
            return 0
        only = ia
        if only < 0:
            only = ib
        if only < 0:
            for i in range(st.n_actors):
                for j in range(nb):
                    if s.detected[w, i, j] == wp.int8(1):
                        return 1
            return 0
        for j in range(nb):
            if s.detected[w, only, j] == wp.int8(1):
                return 1
        for i in range(st.n_actors):
            if s.detected[w, i, only] == wp.int8(1):
                return 1
        return 0
    if kind == LEAF_REACHES:
        a = leaf_actor(st, s, w, st.cond_leaf[leaf, LF_A])
        if a < 0:
            return 0
        region = wp.int32(st.cond_leaf[leaf, LF_MODE])
        px = s.sem[w, a, SEM_X]
        py = s.sem[w, a, SEM_Y]
        if region == REGION_CIRCLE:
            if hypot(px - st.cond_leaf[leaf, LF_P0], py - st.cond_leaf[leaf, LF_P1]) <= st.cond_leaf[leaf, LF_P2]:
                return 1
            return 0
        if region == REGION_POLYGON:
            return point_in_polygon(st, px, py, wp.int32(st.cond_leaf[leaf, LF_P0]), wp.int32(st.cond_leaf[leaf, LF_P1]))
        x, y, h, lane, lane_s, storage_s = route_pose(st, a, s.sem[w, a, SEM_ROUTE_S])
        if lane != wp.int32(st.cond_leaf[leaf, LF_P0]):
            return 0
        if lane_s >= st.cond_leaf[leaf, LF_P1] and lane_s <= st.cond_leaf[leaf, LF_P2]:
            return 1
        return 0
    return 0


@wp.func
def evaluate_condition(st: Static, s: State, w: int, root: int, t: F) -> int:
    if root < 0:
        return 0
    kind = st.cond_root[root, 0]
    start = st.cond_root[root, 1]
    n = st.cond_root[root, 2]
    if kind == COND_AND:
        for i in range(n):
            if evaluate_leaf(st, s, w, start + i, t) == 0:
                return 0
        return 1
    if kind == COND_OR:
        for i in range(n):
            if evaluate_leaf(st, s, w, start + i, t) == 1:
                return 1
        return 0
    if kind == COND_NOT:
        return 1 - evaluate_leaf(st, s, w, start, t)
    return evaluate_leaf(st, s, w, start, t)


# ============================================================ interactions


@wp.func
def release_longitudinal(st: Static, s: State, w: int, a: int, t: F, it: int, reason_until: int):
    # engine.ts releaseAxis('longitudinal')
    if reason_until == 1 and s.flags[w, a, FL_CMD_IT] == it and s.flags[w, a, FL_CMD_KIND] != CMD_NONE:
        prior_kind = s.flags[w, a, FL_CMD_PRIOR_KIND]
        if prior_kind != PRIOR_UNDEFINED:
            if prior_kind == PRIOR_NULL:
                s.flags[w, a, FL_CRUISE_OVERRIDE_VALID] = 0
            else:
                s.flags[w, a, FL_CRUISE_OVERRIDE_VALID] = 1
                s.sem[w, a, SEM_CRUISE_OVERRIDE] = s.cmd[w, a, CMD_PRIOR_VALUE]
    s.flags[w, a, FL_CMD_KIND] = CMD_NONE
    s.flags[w, a, FL_CMD_IT] = -1
    if s.flags[w, a, FL_UNTIL_LONG] == it:
        s.flags[w, a, FL_UNTIL_LONG] = -1
    if s.it_state[w, it, IT_ENDED_VALID] == 0:
        s.it_state[w, it, IT_ENDED_VALID] = 1
        s.it_time[w, it, IT_ENDED_AT] = t


@wp.func
def release_existence(st: Static, s: State, w: int, a: int, t: F, it: int):
    if s.flags[w, a, FL_UNTIL_EXIST] == it:
        s.flags[w, a, FL_UNTIL_EXIST] = -1
    if s.it_state[w, it, IT_ENDED_VALID] == 0:
        s.it_state[w, it, IT_ENDED_VALID] = 1
        s.it_time[w, it, IT_ENDED_AT] = t


@wp.func
def evaluate_window_ends(st: Static, s: State, w: int, t: F):
    # engine.ts evaluateWindowEnds (speed/gap are longitudinal; exist is existence)
    for it in range(st.n_interactions):
        if s.it_state[w, it, IT_STATUS] != STATUS_FIRED or st.it_i[it, ITI_WINDOW_VALID] == 0:
            continue
        if t < st.it_f[it, ITF_WINDOW_END] - F(EPS_T) or s.it_state[w, it, IT_RELEASED_WINDOW] == 1:
            continue
        s.it_state[w, it, IT_RELEASED_WINDOW] = 1
        if s.it_state[w, it, IT_ENDED_VALID] == 0:
            s.it_state[w, it, IT_ENDED_VALID] = 1
            s.it_time[w, it, IT_ENDED_AT] = t
        a = st.it_actor[it]
        if a < 0:
            continue
        if st.it_verb[it] != VERB_EXIST:
            if s.flags[w, a, FL_CMD_KIND] != CMD_NONE and s.flags[w, a, FL_CMD_IT] == it:
                release_longitudinal(st, s, w, a, t, it, 0)


@wp.func
def resolve_speed_target(st: Static, s: State, w: int, a: int, it: int) -> F:
    mode = st.it_i[it, ITI_SPEED_MODE]
    speed = s.sem[w, a, SEM_SPEED]
    value = st.it_f[it, ITF_SPEED_VALUE]
    if mode == SPEED_ABSOLUTE:
        return value
    if mode == SPEED_DELTA:
        return wp.max(F(0.0), speed + value)
    if mode == SPEED_FACTOR:
        return wp.max(F(0.0), speed * value)
    if mode == SPEED_STOP:
        return F(0.0)
    other = st.it_i[it, ITI_MATCH_ACTOR]
    base = F(0.0)
    if other >= 0:
        base = s.sem[w, other, SEM_SPEED]
    else:
        base = cruise_speed(st, s, w, a, speed_limit_at(st, s, w, a))
    return wp.max(F(0.0), base + st.it_f[it, ITF_MATCH_OFFSET])


@wp.func
def apply_interaction(st: Static, s: State, w: int, a: int, it: int, t: F):
    # engine.ts applyInteraction for speed / gap / exist
    verb = st.it_verb[it]
    speed = s.sem[w, a, SEM_SPEED]
    if verb == VERB_SPEED:
        target = resolve_speed_target(st, s, w, a, it)
        duration = transition_duration(st.it_i[it, ITI_DYN_SHAPE], st.it_i[it, ITI_DYN_CONSTRAINT], st.it_f[it, ITF_DYN_VALUE],
                                       target - speed, wp.max(speed, F(0.1)))
        # priorCruiseOverrideMps = a.cruiseOverrideMps (null or value)
        if s.flags[w, a, FL_CRUISE_OVERRIDE_VALID] == 1:
            s.flags[w, a, FL_CMD_PRIOR_KIND] = PRIOR_VALUE
            s.cmd[w, a, CMD_PRIOR_VALUE] = s.sem[w, a, SEM_CRUISE_OVERRIDE]
        else:
            s.flags[w, a, FL_CMD_PRIOR_KIND] = PRIOR_NULL
        s.flags[w, a, FL_CMD_KIND] = CMD_SPEED
        s.flags[w, a, FL_CMD_IT] = it
        s.cmd[w, a, CMD_FIRED_AT] = t
        s.cmd[w, a, CMD_V0] = speed
        s.cmd[w, a, CMD_DURATION] = duration
        s.cmd[w, a, CMD_TARGET] = target
        s.flags[w, a, FL_CRUISE_OVERRIDE_VALID] = 1
        s.sem[w, a, SEM_CRUISE_OVERRIDE] = target
    elif verb == VERB_GAP:
        leader = st.it_i[it, ITI_GAP_ACTOR]
        gap_now = F(0.0)
        if leader >= 0:
            found, gap = along_route_gap(st, s, w, a, leader)
            if found == 1:
                gap_now = gap
        gap_target = desired_gap_m(st, a, speed, st.it_f[it, ITF_GAP_VALUE], st.it_i[it, ITI_GAP_MODE_OR_PRESENT], 1)
        duration = transition_duration(st.it_i[it, ITI_DYN_SHAPE], st.it_i[it, ITI_DYN_CONSTRAINT], st.it_f[it, ITF_DYN_VALUE],
                                       gap_target - gap_now, wp.max(speed, F(0.1)))
        s.flags[w, a, FL_CMD_PRIOR_KIND] = PRIOR_UNDEFINED
        s.flags[w, a, FL_CMD_KIND] = CMD_GAP
        s.flags[w, a, FL_CMD_IT] = it
        s.cmd[w, a, CMD_FIRED_AT] = t
        s.cmd[w, a, CMD_V0] = gap_now
        s.cmd[w, a, CMD_DURATION] = duration
        s.cmd[w, a, CMD_TARGET] = gap_target
    else:
        present = st.it_i[it, ITI_GAP_MODE_OR_PRESENT]
        if present != s.flags[w, a, FL_PRESENT]:
            s.flags[w, a, FL_PRESENT] = present
            if present == 1:
                s.flags[w, a, FL_RETIRED] = 0
    until = st.it_i[it, ITI_UNTIL_COND]
    if verb == VERB_EXIST:
        if until >= 0:
            s.flags[w, a, FL_UNTIL_EXIST] = it
        else:
            s.flags[w, a, FL_UNTIL_EXIST] = -1
    else:
        if until >= 0:
            s.flags[w, a, FL_UNTIL_LONG] = it
        else:
            s.flags[w, a, FL_UNTIL_LONG] = -1


@wp.func
def evaluate_triggers(st: Static, s: State, w: int, t: F):
    # engine.ts evaluateTriggers + triggers.ts shouldFire
    for it in range(st.n_interactions):
        if s.it_state[w, it, IT_STATUS] != STATUS_PENDING:
            continue
        if st.it_i[it, ITI_WINDOW_VALID] == 1:
            if t < st.it_f[it, ITF_WINDOW_START] - F(EPS_T):
                continue
            if t >= st.it_f[it, ITF_WINDOW_END] - F(EPS_T):
                s.it_state[w, it, IT_STATUS] = STATUS_SKIPPED
                continue
        fire = int(0)
        forced = int(0)
        skip = int(0)
        kind = st.it_trigger[it]
        if kind == TRIGGER_AT:
            if t >= st.it_f[it, ITF_AT_T] - F(EPS_T):
                fire = 1
        elif kind == TRIGGER_AFTER:
            ref = st.it_i[it, ITI_AFTER_REF]
            if ref >= 0:
                if s.it_state[w, ref, IT_STATUS] == STATUS_SKIPPED:
                    skip = 1
                else:
                    have = int(0)
                    reference_time = F(0.0)
                    if st.it_i[it, ITI_AFTER_EVENT] == 1:
                        have = s.it_state[w, ref, IT_ENDED_VALID]
                        reference_time = s.it_time[w, ref, IT_ENDED_AT]
                    else:
                        have = s.it_state[w, ref, IT_FIRED_VALID]
                        reference_time = s.it_time[w, ref, IT_FIRED_AT]
                    if have == 1 and t >= reference_time + st.it_f[it, ITF_AFTER_DELAY] - F(EPS_T):
                        fire = 1
        else:
            if evaluate_condition(st, s, w, st.it_i[it, ITI_WHEN_COND], t) == 1:
                fire = 1
            elif t >= st.it_f[it, ITF_BY_LATEST]:
                if st.it_i[it, ITI_IF_NEVER] == 1:
                    fire = 1
                    forced = 1
                else:
                    skip = 1
        if skip == 1:
            s.it_state[w, it, IT_STATUS] = STATUS_SKIPPED
            continue
        if fire == 0:
            continue
        a = st.it_actor[it]
        if a >= 0 and s.flags[w, a, FL_CRASH_DISABLED] == 1:
            s.it_state[w, it, IT_STATUS] = STATUS_SKIPPED
            continue
        s.it_state[w, it, IT_STATUS] = STATUS_FIRED
        s.it_state[w, it, IT_FIRED_VALID] = 1
        s.it_time[w, it, IT_FIRED_AT] = t
        s.it_state[w, it, IT_FORCED] = forced
        if it == st.goal_interaction:
            s.goal_fired[w] = 1
        if a >= 0:
            apply_interaction(st, s, w, a, it, t)
            if st.it_verb[it] == VERB_EXIST:
                s.it_state[w, it, IT_ENDED_VALID] = 1
                s.it_time[w, it, IT_ENDED_AT] = t


@wp.func
def evaluate_until(st: Static, s: State, w: int, t: F):
    # engine.ts evaluateUntil; axes visited in sorted order: 'existence' < 'longitudinal'
    for a in range(st.n_actors):
        it_e = s.flags[w, a, FL_UNTIL_EXIST]
        if it_e >= 0:
            if evaluate_condition(st, s, w, st.it_i[it_e, ITI_UNTIL_COND], t) == 1:
                s.flags[w, a, FL_UNTIL_EXIST] = -1
                release_existence(st, s, w, a, t, it_e)
        it_l = s.flags[w, a, FL_UNTIL_LONG]
        if it_l >= 0:
            if evaluate_condition(st, s, w, st.it_i[it_l, ITI_UNTIL_COND], t) == 1:
                s.flags[w, a, FL_UNTIL_LONG] = -1
                release_longitudinal(st, s, w, a, t, it_l, 1)


# ============================================================ kernels


@wp.kernel
def k_reset_world(st: Static, s: State, mask: wp.array(dtype=wp.int32)):
    # Simulation constructor + DynamicV1Backend.register for one world
    w = wp.tid()
    if mask[w] == 0:
        return
    s.tick[w] = 0
    s.t[w] = -F(st.warmup_ticks) * F(st.dt)
    s.finished[w] = 0
    s.prev_coll_t_valid[w] = 0
    s.prev_coll_t[w] = F(0.0)
    s.ego_collision[w] = 0
    s.goal_fired[w] = 0
    s.decision_count[w] = 0
    s.prev_ego_s_valid[w] = 0
    s.prev_ego_s[w] = F(0.0)
    s.ended[w] = 0
    s.terminated[w] = 0
    s.truncated[w] = 0
    s.reward[w] = F(0.0)
    for k in range(RW_N):
        s.reward_terms[w, k] = F(0.0)
    for k in range(AV_N):
        s.action_valid[w, k] = 0
    nb = st.n_actors + st.n_colliders
    for a in range(st.n_actors):
        for b in range(nb):
            s.active_pair[w, a, b] = wp.int8(0)
            s.detected[w, a, b] = wp.int8(0)
        for k in range(SEM_N):
            s.sem[w, a, k] = F(0.0)
        for k in range(FL_N):
            s.flags[w, a, k] = 0
        for k in range(CMD_N):
            s.cmd[w, a, k] = F(0.0)
        for k in range(PH_N):
            s.phys[w, a, k] = F(0.0)
        x = st.actor_init[a, 0]
        y = st.actor_init[a, 1]
        heading = st.actor_init[a, 2]
        speed = st.actor_init[a, 3]
        s.sem[w, a, SEM_X] = x
        s.sem[w, a, SEM_Y] = y
        s.sem[w, a, SEM_HEADING] = heading
        s.sem[w, a, SEM_SPEED] = speed
        s.sem[w, a, SEM_ROUTE_S] = st.actor_init[a, 4]
        s.sem[w, a, SEM_LAT_OFF] = st.actor_init[a, 5]
        s.sem[w, a, SEM_LAT_REF] = st.actor_init[a, 5]
        s.flags[w, a, FL_PRESENT] = st.actor_present_at_start[a]
        s.flags[w, a, FL_CRUISE_OVERRIDE_VALID] = st.actor_cruise_override_valid[a]
        s.sem[w, a, SEM_CRUISE_OVERRIDE] = st.actor_cruise_override[a]
        s.flags[w, a, FL_UNTIL_LONG] = -1
        s.flags[w, a, FL_UNTIL_EXIST] = -1
        s.flags[w, a, FL_CMD_IT] = -1
        s.snap[w, a, 0] = x
        s.snap[w, a, 1] = y
        s.snap[w, a, 2] = heading
        s.snap_live[w, a] = 0
        s.conf_n[w, a] = 0
        s.obj_valid[w, a] = 0
        s.prev_range_valid[w, a] = 0
        s.prev_range[w, a] = F(0.0)
        if st.actor_dynamic[a] == 1:
            u = F(st.actor_motion_direction[a]) * wp.abs(speed)
            s.phys[w, a, PH_X] = x
            s.phys[w, a, PH_Y] = y
            s.phys[w, a, PH_YAW] = heading
            s.phys[w, a, PH_U] = u
            s.phys[w, a, PH_WHEEL] = u / st.actor_physics[a, P_WHEEL_RADIUS]
            s.phys[w, a, PH_PREV_X] = x
            s.phys[w, a, PH_PREV_Y] = y
            s.phys[w, a, PH_PREV_YAW] = heading
    for it in range(st.n_interactions):
        for k in range(IT_N):
            s.it_state[w, it, k] = 0
        s.it_time[w, it, 0] = F(0.0)
        s.it_time[w, it, 1] = F(0.0)


@wp.kernel
def k_set_active_from_mask(s: State, mask: wp.array(dtype=wp.int32)):
    w = wp.tid()
    s.active[w] = mask[w]


@wp.kernel
def k_set_active_not_ended(s: State):
    w = wp.tid()
    s.active[w] = 1 - s.ended[w]


@wp.kernel
def k_decision_begin(s: State, action_f: wp.array2d(dtype=wp.float64), action_valid: wp.array2d(dtype=wp.int32)):
    # EnvSession.step: pendingAction = action; drainEvents baseline
    w = wp.tid()
    if s.active[w] == 0:
        return
    for k in range(AC_N):
        s.action_f[w, k] = action_f[w, k]
    for k in range(AV_N):
        s.action_valid[w, k] = action_valid[w, k]


@wp.kernel
def k_tick_begin(st: Static, s: State):
    w = wp.tid()
    if s.active[w] == 0 or s.finished[w] == 1:
        return
    i = s.tick[w]
    s.t[w] = F(i - st.warmup_ticks) * F(st.dt)


@wp.func
def body_pose(st: Static, s: State, w: int, slot: int):
    # (x, y, heading, length, width) for an actor slot (< n_actors) or collider slot
    if slot < st.n_actors:
        return s.sem[w, slot, SEM_X], s.sem[w, slot, SEM_Y], s.sem[w, slot, SEM_HEADING], st.actor_dims[slot, 0], st.actor_dims[slot, 1]
    c = slot - st.n_actors
    return st.collider_obb[c, 0], st.collider_obb[c, 1], st.collider_obb[c, 4], st.collider_obb[c, 2], st.collider_obb[c, 3]


@wp.func
def crash_disable(st: Static, s: State, w: int, a: int, t_contact: F):
    if st.actor_static[a] == 1 or s.flags[w, a, FL_CRASH_DISABLED] == 1:
        return
    s.flags[w, a, FL_CRASH_DISABLED] = 1
    s.sem[w, a, SEM_CRASH_AT] = t_contact
    s.flags[w, a, FL_CMD_KIND] = CMD_NONE
    s.flags[w, a, FL_CMD_IT] = -1
    s.sem[w, a, SEM_LAT_ACCEL] = F(0.0)
    s.flags[w, a, FL_UNTIL_LONG] = -1
    s.flags[w, a, FL_UNTIL_EXIST] = -1


@wp.kernel
def k_detect_collisions(st: Static, s: State):
    # engine.ts detectCollisions (body shapes only; no doors in this profile)
    w = wp.tid()
    if s.active[w] == 0 or s.finished[w] == 1:
        return
    t = s.t[w]
    na = st.n_actors
    nb = na + st.n_colliders
    have_prev = s.prev_coll_t_valid[w]
    prev_t = s.prev_coll_t[w]
    for a in range(na):
        for b in range(nb):
            s.detected[w, a, b] = wp.int8(0)
    for a in range(na):
        a_live = actor_live(s, w, a)
        ax = s.sem[w, a, SEM_X]
        ay = s.sem[w, a, SEM_Y]
        ah = s.sem[w, a, SEM_HEADING]
        al = st.actor_dims[a, 0]
        aw = st.actor_dims[a, 1]
        for b in range(a + 1, nb):
            b_live = int(1)
            if b < na:
                b_live = actor_live(s, w, b)
            if a_live == 0 or b_live == 0:
                s.active_pair[w, a, b] = wp.int8(0)
                continue
            bx, by, bh, bl, bw = body_pose(st, s, w, b)
            current_overlap = obb_overlap(ax, ay, al, aw, ah, bx, by, bl, bw, bh)
            has_contact = int(0)
            contact_t = F(0.0)
            if current_overlap == 1:
                has_contact = 1
                contact_t = t
            if have_prev == 1 and s.snap_live[w, a] == 1 and (b >= na or s.snap_live[w, b] == 1):
                pax = s.snap[w, a, 0]
                pay = s.snap[w, a, 1]
                pah = s.snap[w, a, 2]
                pbx = bx
                pby = by
                pbh = bh
                if b < na:
                    pbx = s.snap[w, b, 0]
                    pby = s.snap[w, b, 1]
                    pbh = s.snap[w, b, 2]
                hit, toi = swept_obb_toi(pax, pay, pah, ax, ay, ah, al, aw, pbx, pby, pbh, bx, by, bh, bl, bw)
                if hit == 1:
                    swept_t = prev_t + (t - prev_t) * toi
                    if has_contact == 0 or swept_t < contact_t:
                        has_contact = 1
                        contact_t = swept_t
            if current_overlap == 1 or (has_contact == 1 and (t < F(0.0) or contact_t >= F(0.0))):
                s.detected[w, a, b] = wp.int8(1)
            if has_contact == 1 and contact_t >= F(0.0) and s.active_pair[w, a, b] == wp.int8(0):
                # collision event at contact_t: crash-disable both actors; ego flag for the reward
                crash_disable(st, s, w, a, contact_t)
                if b < na:
                    crash_disable(st, s, w, b, contact_t)
                if a == st.ego or b == st.ego:
                    s.ego_collision[w] = 1
            # activeCollisions := overlappingNow
            s.active_pair[w, a, b] = wp.int8(current_overlap)
    for a in range(na):
        s.snap[w, a, 0] = s.sem[w, a, SEM_X]
        s.snap[w, a, 1] = s.sem[w, a, SEM_Y]
        s.snap[w, a, 2] = s.sem[w, a, SEM_HEADING]
        s.snap_live[w, a] = actor_live(s, w, a)
    s.prev_coll_t_valid[w] = 1
    s.prev_coll_t[w] = t


@wp.kernel
def k_triggers(st: Static, s: State):
    w = wp.tid()
    if s.active[w] == 0 or s.finished[w] == 1:
        return
    t = s.t[w]
    if t < F(0.0):
        return
    evaluate_window_ends(st, s, w, t)
    evaluate_triggers(st, s, w, t)
    evaluate_until(st, s, w, t)
    evaluate_window_ends(st, s, w, t)


@wp.kernel
def k_conflict_samples(st: Static, s: State):
    # engine.ts buildConflictSamples
    w, a = wp.tid()
    if s.active[w] == 0 or s.finished[w] == 1 or s.tick[w] >= st.total_ticks:
        return
    s.conf_n[w, a] = 0
    if actor_live(s, w, a) == 0:
        return
    n = int(0)
    route_s = s.sem[w, a, SEM_ROUTE_S]
    length = st.actor_route_length[a]
    for i in range(CONFLICT_SAMPLES):
        sm = route_s + F(i) * F(CONFLICT_STEP_M)
        if sm > length:
            break
        px, py = route_point_with_offset(st, a, sm, s.sem[w, a, SEM_LAT_OFF])
        s.conf[w, a, i, 0] = px
        s.conf[w, a, i, 1] = py
        n += 1
    s.conf_n[w, a] = n


@wp.func
def hooked_intent(st: Static, s: State, w: int, a: int, t: F, motion_direction: F, target_speed: F, target_accel: F,
                  preview_x: F, preview_y: F, preview_heading: F):
    # engine.ts hookedIntent + EnvSession.hook (zero-order hold on the ego, t >= 0)
    has_control = int(0)
    c_throttle = F(0.0)
    c_brake = F(0.0)
    c_steer = F(0.0)
    if a != st.ego or t < F(0.0) or s.action_valid[w, AV_PENDING] == 0:
        return motion_direction, target_speed, target_accel, preview_x, preview_y, preview_heading, has_control, c_throttle, c_brake, c_steer
    if s.action_valid[w, AV_DIR] == 1:
        motion_direction = s.action_f[w, AC_DIR]
    if s.action_valid[w, AV_SPEED] == 1:
        target_speed = s.action_f[w, AC_SPEED]
    if s.action_valid[w, AV_ACCEL] == 1:
        target_accel = s.action_f[w, AC_ACCEL]
    if s.action_valid[w, AV_PREVIEW] == 1:
        preview_x = s.action_f[w, AC_PX]
        preview_y = s.action_f[w, AC_PY]
    if s.action_valid[w, AV_PREVIEW_H] == 1:
        preview_heading = s.action_f[w, AC_PH]
    if s.action_valid[w, AV_CONTROL] == 1:
        has_control = 1
        c_throttle = s.action_f[w, AC_THROTTLE]
        c_brake = s.action_f[w, AC_BRAKE]
        c_steer = s.action_f[w, AC_STEER]
    return motion_direction, target_speed, target_accel, preview_x, preview_y, preview_heading, has_control, c_throttle, c_brake, c_steer


@wp.kernel
def k_plan(st: Static, s: State):
    # engine.ts planActor for one (world, actor); writes s.plan, steps the motion backend
    w, a = wp.tid()
    if s.active[w] == 0 or s.finished[w] == 1 or s.tick[w] >= st.total_ticks:
        return
    t = s.t[w]
    dt = F(st.dt)
    sem = s.sem
    speed0 = sem[w, a, SEM_SPEED]
    route_s0 = sem[w, a, SEM_ROUTE_S]
    lat0 = sem[w, a, SEM_LAT_OFF]
    lat_rate0 = sem[w, a, SEM_LAT_RATE]
    pl = s.plan
    pl[w, a, PL_SPEED] = speed0
    pl[w, a, PL_ACCEL] = F(0.0)
    pl[w, a, PL_ROUTE_S] = route_s0
    pl[w, a, PL_LAT_OFF] = lat0
    pl[w, a, PL_LAT_RATE] = lat_rate0
    pl[w, a, PL_LAT_ACCEL] = sem[w, a, SEM_LAT_ACCEL]
    pl[w, a, PL_X] = sem[w, a, SEM_X]
    pl[w, a, PL_Y] = sem[w, a, SEM_Y]
    pl[w, a, PL_HEADING] = sem[w, a, SEM_HEADING]
    pl[w, a, PL_RETIRE] = F(0.0)
    if actor_live(s, w, a) == 0:
        return
    if st.actor_static[a] == 1:
        pl[w, a, PL_SPEED] = F(0.0)
        pl[w, a, PL_LAT_RATE] = F(0.0)
        pl[w, a, PL_LAT_ACCEL] = F(0.0)
        return
    friction_scale = F(st.friction_scale)
    dir_i = st.actor_motion_direction[a]
    dir_f = F(dir_i)
    brake_hard = st.actor_limits[a, LIM_BRAKE_HARD]
    downed = s.flags[w, a, FL_DOWNED]
    x0 = sem[w, a, SEM_X]
    y0 = sem[w, a, SEM_Y]
    h0 = sem[w, a, SEM_HEADING]

    if s.flags[w, a, FL_CRASH_DISABLED] == 1:
        emergency_decel = wp.min(brake_hard * friction_scale, wp.max(F(0.0), speed0 / dt))
        md, ts, ta, px, py, phd, has_control, c_th, c_br, c_st = hooked_intent(
            st, s, w, a, t, dir_f, F(0.0), -emergency_decel, x0 + wp.cos(h0), y0 + wp.sin(h0), h0)
        backend_step(st, s, w, a, friction_scale, md, ts, ta, px, py, phd, downed, has_control, c_th, c_br, c_st)
        u = s.phys[w, a, PH_U]
        v = s.phys[w, a, PH_V]
        if downed == 1:
            pl[w, a, PL_SPEED] = hypot(u, v)
        else:
            pl[w, a, PL_SPEED] = wp.abs(u)
        pl[w, a, PL_ACCEL] = s.phys[w, a, PH_LONG_ACCEL] * dir_f
        nx = s.phys[w, a, PH_X]
        ny = s.phys[w, a, PH_Y]
        pl[w, a, PL_X] = nx
        pl[w, a, PL_Y] = ny
        pl[w, a, PL_HEADING] = s.phys[w, a, PH_YAW]
        proj = route_project_point(st, a, nx, ny)
        pl[w, a, PL_ROUTE_S] = proj
        pl[w, a, PL_LAT_OFF] = route_lateral_offset_at(st, a, proj, nx, ny)
        pl[w, a, PL_LAT_RATE] = v
        pl[w, a, PL_LAT_ACCEL] = (v - lat_rate0) / dt
    else:
        lane_speed_limit = speed_limit_at(st, s, w, a)
        cmd_kind = s.flags[w, a, FL_CMD_KIND]
        cmd_it = s.flags[w, a, FL_CMD_IT]
        # re-resolve dynamic longitudinal targets
        if cmd_kind == CMD_SPEED:
            if st.it_i[cmd_it, ITI_SPEED_MODE] == SPEED_MATCH:
                target = resolve_speed_target(st, s, w, a, cmd_it)
                s.cmd[w, a, CMD_TARGET] = target
                s.flags[w, a, FL_CRUISE_OVERRIDE_VALID] = 1
                sem[w, a, SEM_CRUISE_OVERRIDE] = target
        if cmd_kind == CMD_GAP:
            s.cmd[w, a, CMD_TARGET] = desired_gap_m(st, a, speed0, st.it_f[cmd_it, ITF_GAP_VALUE],
                                                    st.it_i[cmd_it, ITI_GAP_MODE_OR_PRESENT], 1)
        desired_speed = F(0.0)
        if cmd_kind == CMD_SPEED:
            desired_speed = s.cmd[w, a, CMD_TARGET]
        else:
            desired_speed = cruise_speed(st, s, w, a, lane_speed_limit)
        corner_cap = F(INF)
        if st.actor_road_actor[a] == 1:
            corner_cap = cornering_cap(st, a, route_s0, wp.abs(speed0), desired_speed)

        commanded_found = int(0)
        commanded_gap = F(0.0)
        commanded_speed = F(0.0)
        if cmd_kind == CMD_GAP:
            leader = st.it_i[cmd_it, ITI_GAP_ACTOR]
            if leader >= 0 and actor_live(s, w, leader) == 1:
                found, gap = along_route_gap(st, s, w, a, leader)
                if found == 1:
                    commanded_found = 1
                    commanded_gap = wp.max(gap, F(0.05))
                    commanded_speed = sem[w, leader, SEM_SPEED]
        near_found, near_gap, near_speed, near_id = find_leader(st, s, w, a)

        # controllers.ts longitudinalAccel
        ctl_found = near_found
        ctl_gap = near_gap
        ctl_speed = near_speed
        if commanded_found == 1:
            ctl_found = 1
            ctl_gap = commanded_gap
            ctl_speed = commanded_speed
        accel = F(0.0)
        if cmd_kind == CMD_NONE:
            accel = converge(st, a, speed0, cruise_speed(st, s, w, a, lane_speed_limit))
        elif cmd_kind == CMD_SPEED:
            v_next = transition_value(st.it_i[cmd_it, ITI_DYN_SHAPE], s.cmd[w, a, CMD_V0], s.cmd[w, a, CMD_TARGET],
                                      t + dt - s.cmd[w, a, CMD_FIRED_AT], s.cmd[w, a, CMD_DURATION])
            accel = clampf((v_next - speed0) / dt, -brake_hard, st.actor_limits[a, LIM_ACCEL_MAX])
        else:
            if ctl_found == 0:
                accel = converge(st, a, speed0, cruise_speed(st, s, w, a, lane_speed_limit))
            else:
                gap_commanded = transition_value(st.it_i[cmd_it, ITI_DYN_SHAPE], s.cmd[w, a, CMD_V0], s.cmd[w, a, CMD_TARGET],
                                                 t + dt - s.cmd[w, a, CMD_FIRED_AT], s.cmd[w, a, CMD_DURATION])
                accel = gap_accel(st, a, speed0, ctl_gap, ctl_speed, gap_commanded)
                v_cap = cruise_speed(st, s, w, a, lane_speed_limit)
                if speed0 + accel * dt > v_cap:
                    accel = clampf((v_cap - speed0) / dt, -brake_hard, st.actor_limits[a, LIM_ACCEL_MAX])

        # engine.ts governor inputs (no stop lines in this profile)
        conf_found, conf_dist, conf_delta, conf_ped, conf_id = find_conflict(st, s, w, a)
        gov_leader = int(0)
        if near_found == 1 and ego_can_perceive(st, s, w, a, near_id) == 1:
            gov_leader = 1
        gov_conflict = int(0)
        if conf_found == 1 and ego_can_perceive(st, s, w, a, conf_id) == 1:
            gov_conflict = 1
        # controllers.ts governorCap
        cap = F(INF)
        rules = st.actor_rules
        if rules[a, RULE_COLLISION_AVOIDANCE] > F(0.5) and gov_leader == 1:
            leader_accel = gap_accel(st, a, speed0, near_gap, near_speed,
                                     wp.max(speed0 * (F(1.5) - rules[a, RULE_AGGRESSION]), F(GAP_MIN_M)))
            if leader_accel < cap:
                cap = leader_accel
        if gov_conflict == 1:
            yields = rules[a, RULE_YIELD_VEHICLES]
            if conf_ped == 1:
                yields = rules[a, RULE_YIELD_PEDESTRIANS]
            if rules[a, RULE_COLLISION_AVOIDANCE] > F(0.5) and rules[a, RULE_YIELD] > F(0.5) and yields > F(0.5):
                c_accel = -(speed0 * speed0) / (F(2.0) * wp.max(conf_dist - F(2.0), F(0.5)))
                capped = wp.max(c_accel, -st.actor_limits[a, LIM_BRAKE_COMFORT])
                if capped < cap:
                    cap = capped
        if cap < accel:
            accel = cap
        if corner_cap < accel:
            accel = corner_cap
        accel = wp.max(accel, -brake_hard * friction_scale)

        speed = speed0 + accel * dt
        if speed < F(0.0):
            speed = F(0.0)
            accel = -speed0 / dt
        geared = speed
        if dir_i == -1:
            geared = wp.min(speed, F(REVERSE_MAX_SPEED_MPS))
        if geared < speed:
            accel = wp.max((geared - speed0) / dt, -brake_hard * friction_scale)
            speed = wp.max(speed0 + accel * dt, F(0.0))
        pl[w, a, PL_ACCEL] = accel
        pl[w, a, PL_SPEED] = speed
        pl[w, a, PL_ROUTE_S] = route_s0 + speed * dt
        # lateralStep without an owner: hold the rest offset
        lat_ref = sem[w, a, SEM_LAT_REF]

        # dynamic backend intent
        wheelbase = st.actor_physics[a, P_WHEELBASE]
        short_lookahead = wp.max(wheelbase * F(0.85), wp.abs(speed0) * F(0.25))
        heading_at_s = route_heading(st, a, route_s0)
        length = st.actor_route_length[a]
        curvature_horizon = wp.max(F(10.0), wp.abs(speed0))
        max_heading_change = F(0.0)
        sample = F(2.5)
        guard = int(0)
        while sample <= curvature_horizon + F(1.0e-9) and guard < 4096:
            sh = route_heading(st, a, wp.min(length, route_s0 + sample))
            max_heading_change = wp.max(max_heading_change, wp.abs(angle_delta(heading_at_s, sh)))
            sample = sample + F(2.5)
            guard += 1
        steering_lookahead = short_lookahead
        if max_heading_change < F(3.0) * F(PI) / F(180.0):
            steering_lookahead = wp.max(wp.max(F(4.0), wp.abs(speed0) * F(0.5)), short_lookahead)
        preview_s = wp.min(length, route_s0 + steering_lookahead)
        preview_heading_route = route_heading(st, a, preview_s)
        px, py = route_point_with_offset(st, a, preview_s, lat_ref)
        # headingWithSlip(previewPose.heading, lateralReferenceRate = 0, max(speed, 0.5)) = heading + atan2(0, ·)
        preview_heading = preview_heading_route + wp.atan2(F(0.0), wp.max(speed, F(0.5)))
        md, ts, ta, hpx, hpy, hph, has_control, c_th, c_br, c_st = hooked_intent(
            st, s, w, a, t, dir_f, speed, accel, px, py, preview_heading)
        backend_step(st, s, w, a, friction_scale, md, ts, ta, hpx, hpy, hph, 0, has_control, c_th, c_br, c_st)
        nx = s.phys[w, a, PH_X]
        ny = s.phys[w, a, PH_Y]
        proj = route_project_point(st, a, nx, ny)
        projected_offset = route_lateral_offset_at(st, a, proj, nx, ny)
        pl[w, a, PL_SPEED] = wp.abs(s.phys[w, a, PH_U])
        pl[w, a, PL_ACCEL] = s.phys[w, a, PH_LONG_ACCEL] * dir_f
        pl[w, a, PL_ROUTE_S] = proj
        pl[w, a, PL_LAT_OFF] = projected_offset
        lat_rate = (projected_offset - lat0) / dt
        pl[w, a, PL_LAT_RATE] = lat_rate
        pl[w, a, PL_LAT_ACCEL] = (lat_rate - lat_rate0) / dt
        pl[w, a, PL_X] = nx
        pl[w, a, PL_Y] = ny
        pl[w, a, PL_HEADING] = s.phys[w, a, PH_YAW]

    # route end: hold the terminal pose and retire
    length = st.actor_route_length[a]
    if pl[w, a, PL_ROUTE_S] >= length - F(ROUTE_END_SLACK_M):
        pl[w, a, PL_ROUTE_S] = length
        pl[w, a, PL_ACCEL] = -speed0 / dt
        pl[w, a, PL_SPEED] = F(0.0)
        pl[w, a, PL_LAT_RATE] = F(0.0)
        pl[w, a, PL_LAT_ACCEL] = F(0.0)
        pl[w, a, PL_RETIRE] = F(1.0)
        terminal_heading = route_heading(st, a, length)
        ex, ey = route_point_with_offset(st, a, length, pl[w, a, PL_LAT_OFF])
        pl[w, a, PL_X] = ex
        pl[w, a, PL_Y] = ey
        extra = F(0.0)
        if dir_i == -1:
            extra = F(PI)
        pl[w, a, PL_HEADING] = norm_angle(terminal_heading + wp.atan2(F(0.0), F(0.5)) + extra)


@wp.kernel
def k_apply(st: Static, s: State):
    # engine.ts applyAll (per actor part)
    w, a = wp.tid()
    if s.active[w] == 0 or s.finished[w] == 1 or s.tick[w] >= st.total_ticks:
        return
    if actor_live(s, w, a) == 0:
        return
    t = s.t[w]
    pl = s.plan
    sem = s.sem
    speed = pl[w, a, PL_SPEED]
    sem[w, a, SEM_SPEED] = speed
    sem[w, a, SEM_ACCEL] = pl[w, a, PL_ACCEL]
    sem[w, a, SEM_ROUTE_S] = pl[w, a, PL_ROUTE_S]
    sem[w, a, SEM_LAT_OFF] = pl[w, a, PL_LAT_OFF]
    sem[w, a, SEM_LAT_RATE] = pl[w, a, PL_LAT_RATE]
    sem[w, a, SEM_LAT_ACCEL] = pl[w, a, PL_LAT_ACCEL]
    sem[w, a, SEM_X] = pl[w, a, PL_X]
    sem[w, a, SEM_Y] = pl[w, a, PL_Y]
    sem[w, a, SEM_HEADING] = pl[w, a, PL_HEADING]
    if speed < F(0.05):
        if s.flags[w, a, FL_STANDSTILL_VALID] == 0:
            s.flags[w, a, FL_STANDSTILL_VALID] = 1
            sem[w, a, SEM_STANDSTILL_SINCE] = t
    else:
        s.flags[w, a, FL_STANDSTILL_VALID] = 0
    if speed > F(GEAR_ENGAGE_SPEED_MPS):
        s.flags[w, a, FL_HAS_MOVED] = 1
    if pl[w, a, PL_RETIRE] > F(0.5):
        s.flags[w, a, FL_RETIRED] = 1


# ------------------------------------------------------------ contact solver


@wp.func
def sat_manifold(ax: F, ay: F, al: F, aw: F, ah: F, bx: F, by: F, bl: F, bw: F, bh: F, tolerance: F):
    # collision-response.ts manifold → (found, nx, ny, px, py, penetration); normal from A toward B
    dx = bx - ax
    dy = by - ay
    minimum = F(INF)
    nx = F(1.0)
    ny = F(0.0)
    for axis in range(4):
        ux = F(0.0)
        uy = F(0.0)
        if axis == 0:
            ux = wp.cos(ah)
            uy = wp.sin(ah)
        elif axis == 1:
            ux = -wp.sin(ah)
            uy = wp.cos(ah)
        elif axis == 2:
            ux = wp.cos(bh)
            uy = wp.sin(bh)
        else:
            ux = -wp.sin(bh)
            uy = wp.cos(bh)
        signed = dx * ux + dy * uy
        overlap = projection_radius(al, aw, ah, ux, uy) + projection_radius(bl, bw, bh, ux, uy) - wp.abs(signed)
        if overlap < -tolerance:
            return 0, F(0.0), F(0.0), F(0.0), F(0.0), F(0.0)
        if overlap < minimum:
            minimum = overlap
            sg = F(1.0)
            if signed < F(0.0):
                sg = -F(1.0)
            nx = ux * sg
            ny = uy * sg
    ra = projection_radius(al, aw, ah, nx, ny)
    rb = projection_radius(bl, bw, bh, nx, ny)
    pax = ax + nx * ra
    pay = ay + ny * ra
    pbx = bx - nx * rb
    pby = by - ny * rb
    return 1, nx, ny, (pax + pbx) / F(2.0), (pay + pby) / F(2.0), wp.max(F(0.0), minimum)


@wp.func
def body_velocity_at(s: State, w: int, i: int, px: F, py: F):
    rx = px - s.sbody[w, i, SB_X]
    ry = py - s.sbody[w, i, SB_Y]
    ang = s.sbody[w, i, SB_ANG]
    return s.sbody[w, i, SB_VX] - ang * ry, s.sbody[w, i, SB_VY] + ang * rx


@wp.func
def body_apply_impulse(s: State, w: int, i: int, ix: F, iy: F, px: F, py: F, sign: F):
    inv_mass = s.sbody[w, i, SB_INV_MASS]
    s.sbody[w, i, SB_VX] = s.sbody[w, i, SB_VX] + sign * ix * inv_mass
    s.sbody[w, i, SB_VY] = s.sbody[w, i, SB_VY] + sign * iy * inv_mass
    armx = px - s.sbody[w, i, SB_X]
    army = py - s.sbody[w, i, SB_Y]
    s.sbody[w, i, SB_ANG] = s.sbody[w, i, SB_ANG] + sign * (armx * iy - army * ix) * s.sbody[w, i, SB_INV_INERTIA]


@wp.func
def body_effective_mass(s: State, w: int, i: int, j: int, px: F, py: F, ax: F, ay: F) -> F:
    rax = px - s.sbody[w, i, SB_X]
    ray = py - s.sbody[w, i, SB_Y]
    rbx = px - s.sbody[w, j, SB_X]
    rby = py - s.sbody[w, j, SB_Y]
    ca = rax * ay - ray * ax
    cb = rbx * ay - rby * ax
    return s.sbody[w, i, SB_INV_MASS] + s.sbody[w, j, SB_INV_MASS] + ca * ca * s.sbody[w, i, SB_INV_INERTIA] + cb * cb * s.sbody[w, j, SB_INV_INERTIA]


@wp.func
def pair_manifold(s: State, w: int, i: int, j: int, tolerance: F):
    return sat_manifold(s.sbody[w, i, SB_X], s.sbody[w, i, SB_Y], s.sbody[w, i, SB_LEN], s.sbody[w, i, SB_WID], s.sbody[w, i, SB_YAW],
                        s.sbody[w, j, SB_X], s.sbody[w, j, SB_Y], s.sbody[w, j, SB_LEN], s.sbody[w, j, SB_WID], s.sbody[w, j, SB_YAW],
                        tolerance)


@wp.kernel
def k_contacts(st: Static, s: State):
    # engine.ts resolveDynamicContacts + dynamic-v1 resolveCollisions + collision-response solvePlanarCollisions
    w = wp.tid()
    if s.active[w] == 0 or s.finished[w] == 1 or s.tick[w] >= st.total_ticks:
        return
    dt = F(st.dt)
    na = st.n_actors
    # bodies in canonical id order: dynamic live actors (finite mass), fixed live actors and colliders (infinite mass)
    n = int(0)
    has_dynamic = int(0)
    for k in range(na + st.n_colliders):
        slot = st.solver_body_order[k]
        if slot < na:
            if actor_live(s, w, slot) == 0:
                continue
            if st.actor_dynamic[slot] == 1:
                has_dynamic = 1
                yaw = s.phys[w, slot, PH_YAW]
                c = wp.cos(yaw)
                sn = wp.sin(yaw)
                u = s.phys[w, slot, PH_U]
                v = s.phys[w, slot, PH_V]
                s.sbody[w, n, SB_X] = s.phys[w, slot, PH_X]
                s.sbody[w, n, SB_Y] = s.phys[w, slot, PH_Y]
                s.sbody[w, n, SB_YAW] = yaw
                s.sbody[w, n, SB_VX] = u * c - v * sn
                s.sbody[w, n, SB_VY] = u * sn + v * c
                s.sbody[w, n, SB_ANG] = s.phys[w, slot, PH_R]
                s.sbody[w, n, SB_INV_MASS] = F(1.0) / st.actor_physics[slot, P_MASS]
                s.sbody[w, n, SB_INV_INERTIA] = F(1.0) / st.actor_physics[slot, P_INERTIA]
                s.sbody[w, n, SB_PREV_X] = s.phys[w, slot, PH_PREV_X]
                s.sbody[w, n, SB_PREV_Y] = s.phys[w, slot, PH_PREV_Y]
                s.sbody[w, n, SB_PREV_YAW] = s.phys[w, slot, PH_PREV_YAW]
                if st.actor_knockdown_vulnerable[slot] == 1:
                    s.speed_before[w, slot] = hypot(u, v)
            else:
                d = F(st.actor_motion_direction[slot])
                h = s.sem[w, slot, SEM_HEADING]
                sp = s.sem[w, slot, SEM_SPEED]
                s.sbody[w, n, SB_X] = s.sem[w, slot, SEM_X]
                s.sbody[w, n, SB_Y] = s.sem[w, slot, SEM_Y]
                s.sbody[w, n, SB_YAW] = h
                s.sbody[w, n, SB_VX] = wp.cos(h) * sp * d
                s.sbody[w, n, SB_VY] = wp.sin(h) * sp * d
                s.sbody[w, n, SB_ANG] = F(0.0)
                s.sbody[w, n, SB_INV_MASS] = F(0.0)
                s.sbody[w, n, SB_INV_INERTIA] = F(0.0)
                s.sbody[w, n, SB_PREV_X] = s.sbody[w, n, SB_X]
                s.sbody[w, n, SB_PREV_Y] = s.sbody[w, n, SB_Y]
                s.sbody[w, n, SB_PREV_YAW] = h
            s.sbody[w, n, SB_LEN] = st.actor_dims[slot, 0]
            s.sbody[w, n, SB_WID] = st.actor_dims[slot, 1]
        else:
            c_ = slot - na
            s.sbody[w, n, SB_X] = st.collider_obb[c_, 0]
            s.sbody[w, n, SB_Y] = st.collider_obb[c_, 1]
            s.sbody[w, n, SB_YAW] = st.collider_obb[c_, 4]
            s.sbody[w, n, SB_VX] = F(0.0)
            s.sbody[w, n, SB_VY] = F(0.0)
            s.sbody[w, n, SB_ANG] = F(0.0)
            s.sbody[w, n, SB_INV_MASS] = F(0.0)
            s.sbody[w, n, SB_INV_INERTIA] = F(0.0)
            s.sbody[w, n, SB_LEN] = st.collider_obb[c_, 2]
            s.sbody[w, n, SB_WID] = st.collider_obb[c_, 3]
            s.sbody[w, n, SB_PREV_X] = s.sbody[w, n, SB_X]
            s.sbody[w, n, SB_PREV_Y] = s.sbody[w, n, SB_Y]
            s.sbody[w, n, SB_PREV_YAW] = s.sbody[w, n, SB_YAW]
        s.sbody[w, n, SB_IMPULSE] = F(0.0)
        s.sbody[w, n, SB_CONTACTS] = F(0.0)
        s.sbody_slot[w, n] = slot
        n += 1
    s.sbody_n[w] = n
    if has_dynamic == 0:
        return

    # rewindSweptContacts
    for i in range(n):
        for j in range(i + 1, n):
            if s.sbody[w, i, SB_INV_MASS] <= F(0.0) and s.sbody[w, j, SB_INV_MASS] <= F(0.0):
                continue
            found, mnx, mny, mpx, mpy, pen = pair_manifold(s, w, i, j, F(0.0))
            if found == 1:
                continue
            hit, toi = swept_obb_toi(
                s.sbody[w, i, SB_PREV_X], s.sbody[w, i, SB_PREV_Y], s.sbody[w, i, SB_PREV_YAW],
                s.sbody[w, i, SB_X], s.sbody[w, i, SB_Y], s.sbody[w, i, SB_YAW], s.sbody[w, i, SB_LEN], s.sbody[w, i, SB_WID],
                s.sbody[w, j, SB_PREV_X], s.sbody[w, j, SB_PREV_Y], s.sbody[w, j, SB_PREV_YAW],
                s.sbody[w, j, SB_X], s.sbody[w, j, SB_Y], s.sbody[w, j, SB_YAW], s.sbody[w, j, SB_LEN], s.sbody[w, j, SB_WID])
            if hit == 0 or toi >= F(1.0):
                continue
            remaining = wp.max(F(0.0), F(1.0) - toi) * dt
            carry = wp.min(remaining, F(0.001))
            if s.sbody[w, i, SB_INV_MASS] > F(0.0):
                s.sbody[w, i, SB_X] = lerpf(s.sbody[w, i, SB_PREV_X], s.sbody[w, i, SB_X], toi) + s.sbody[w, i, SB_VX] * carry
                s.sbody[w, i, SB_Y] = lerpf(s.sbody[w, i, SB_PREV_Y], s.sbody[w, i, SB_Y], toi) + s.sbody[w, i, SB_VY] * carry
                s.sbody[w, i, SB_YAW] = lerp_angle(s.sbody[w, i, SB_PREV_YAW], s.sbody[w, i, SB_YAW], toi)
            if s.sbody[w, j, SB_INV_MASS] > F(0.0):
                s.sbody[w, j, SB_X] = lerpf(s.sbody[w, j, SB_PREV_X], s.sbody[w, j, SB_X], toi) + s.sbody[w, j, SB_VX] * carry
                s.sbody[w, j, SB_Y] = lerpf(s.sbody[w, j, SB_PREV_Y], s.sbody[w, j, SB_Y], toi) + s.sbody[w, j, SB_VY] * carry
                s.sbody[w, j, SB_YAW] = lerp_angle(s.sbody[w, j, SB_PREV_YAW], s.sbody[w, j, SB_YAW], toi)

    # velocity iterations
    for iteration in range(VELOCITY_ITERATIONS):
        for i in range(n):
            for j in range(i + 1, n):
                if s.sbody[w, i, SB_INV_MASS] <= F(0.0) and s.sbody[w, j, SB_INV_MASS] <= F(0.0):
                    continue
                found, cnx, cny, cpx, cpy, pen = pair_manifold(s, w, i, j, F(CONTACT_SLOP_M))
                if found == 0:
                    continue
                vax, vay = body_velocity_at(s, w, i, cpx, cpy)
                vbx, vby = body_velocity_at(s, w, j, cpx, cpy)
                closing = (vbx - vax) * cnx + (vby - vay) * cny
                normal_mass = body_effective_mass(s, w, i, j, cpx, cpy, cnx, cny)
                if normal_mass <= F(SOLVER_EPSILON):
                    continue
                bounce = F(0.0)
                if closing < -F(1.0):
                    bounce = F(RESTITUTION)
                bias = F(0.0)
                if pen > F(CONTACT_SLOP_M):
                    bias = wp.min(F(2.0), F(0.15) * (pen - F(CONTACT_SLOP_M)) / wp.max(dt, F(SOLVER_EPSILON)))
                normal_impulse = wp.max(F(0.0), (-(F(1.0) + bounce) * closing + bias) / normal_mass)
                if normal_impulse <= F(SOLVER_EPSILON):
                    continue
                body_apply_impulse(s, w, i, cnx * normal_impulse, cny * normal_impulse, cpx, cpy, -F(1.0))
                body_apply_impulse(s, w, j, cnx * normal_impulse, cny * normal_impulse, cpx, cpy, F(1.0))
                tx = -cny
                ty = cnx
                va2x, va2y = body_velocity_at(s, w, i, cpx, cpy)
                vb2x, vb2y = body_velocity_at(s, w, j, cpx, cpy)
                tangent_speed = (vb2x - va2x) * tx + (vb2y - va2y) * ty
                tangent_mass = body_effective_mass(s, w, i, j, cpx, cpy, tx, ty)
                raw_tangent = F(0.0)
                if tangent_mass > F(SOLVER_EPSILON):
                    raw_tangent = -tangent_speed / tangent_mass
                tangent_impulse = wp.max(-F(FRICTION) * normal_impulse, wp.min(F(FRICTION) * normal_impulse, raw_tangent))
                body_apply_impulse(s, w, i, tx * tangent_impulse, ty * tangent_impulse, cpx, cpy, -F(1.0))
                body_apply_impulse(s, w, j, tx * tangent_impulse, ty * tangent_impulse, cpx, cpy, F(1.0))
                # per-pair totals are folded into per-body sums (telemetry/knockdown only need sums)
                s.sbody[w, i, SB_IMPULSE] = s.sbody[w, i, SB_IMPULSE] + normal_impulse
                s.sbody[w, j, SB_IMPULSE] = s.sbody[w, j, SB_IMPULSE] + normal_impulse

    # position iterations
    for iteration in range(POSITION_ITERATIONS):
        for i in range(n):
            for j in range(i + 1, n):
                inv_i = s.sbody[w, i, SB_INV_MASS]
                inv_j = s.sbody[w, j, SB_INV_MASS]
                if inv_i <= F(0.0) and inv_j <= F(0.0):
                    continue
                found, cnx, cny, cpx, cpy, pen = pair_manifold(s, w, i, j, F(CONTACT_SLOP_M))
                if found == 0 or pen <= F(CONTACT_SLOP_M):
                    continue
                inv_mass = inv_i + inv_j
                if inv_mass <= F(SOLVER_EPSILON):
                    continue
                correction = wp.min(F(MAX_POSITION_CORRECTION_M), F(0.8) * (pen - F(CONTACT_SLOP_M)))
                s.sbody[w, i, SB_X] = s.sbody[w, i, SB_X] - cnx * correction * inv_i / inv_mass
                s.sbody[w, i, SB_Y] = s.sbody[w, i, SB_Y] - cny * correction * inv_i / inv_mass
                s.sbody[w, j, SB_X] = s.sbody[w, j, SB_X] + cnx * correction * inv_j / inv_mass
                s.sbody[w, j, SB_Y] = s.sbody[w, j, SB_Y] + cny * correction * inv_j / inv_mass

    # write back dynamic bodies (dynamic-v1 resolveCollisions tail) and knockdowns
    t = s.t[w]
    for i in range(n):
        if s.sbody[w, i, SB_INV_MASS] <= F(0.0):
            continue
        a = s.sbody_slot[w, i]
        yaw = norm_angle(s.sbody[w, i, SB_YAW])
        c = wp.cos(yaw)
        sn = wp.sin(yaw)
        vx = s.sbody[w, i, SB_VX]
        vy = s.sbody[w, i, SB_VY]
        u = vx * c + vy * sn
        v = -vx * sn + vy * c
        s.phys[w, a, PH_X] = s.sbody[w, i, SB_X]
        s.phys[w, a, PH_Y] = s.sbody[w, i, SB_Y]
        s.phys[w, a, PH_YAW] = yaw
        s.phys[w, a, PH_U] = u
        s.phys[w, a, PH_V] = v
        s.phys[w, a, PH_R] = s.sbody[w, i, SB_ANG]
        s.phys[w, a, PH_COLL_IMPULSE] = s.sbody[w, i, SB_IMPULSE]
        # applyKnockdowns: velocity the contact added
        if s.sbody[w, i, SB_IMPULSE] > F(0.0) and st.actor_knockdown_vulnerable[a] == 1 and s.flags[w, a, FL_DOWNED] == 0:
            after = hypot(u, v)
            if after - s.speed_before[w, a] >= F(BALANCE_RECOVERY_DELTA_V_MPS):
                s.flags[w, a, FL_DOWNED] = 1
                s.sem[w, a, SEM_DOWNED_AT] = t
                if s.flags[w, a, FL_CRASH_DISABLED] == 0:
                    s.flags[w, a, FL_CRASH_DISABLED] = 1
                    s.sem[w, a, SEM_CRASH_AT] = t
                    s.flags[w, a, FL_CMD_KIND] = CMD_NONE
                    s.flags[w, a, FL_CMD_IT] = -1
                    s.sem[w, a, SEM_LAT_ACCEL] = F(0.0)
                    s.flags[w, a, FL_UNTIL_LONG] = -1
                    s.flags[w, a, FL_UNTIL_EXIST] = -1
        # engine.ts resolveDynamicContacts write-back
        s.sem[w, a, SEM_X] = s.phys[w, a, PH_X]
        s.sem[w, a, SEM_Y] = s.phys[w, a, PH_Y]
        s.sem[w, a, SEM_HEADING] = yaw
        if s.flags[w, a, FL_DOWNED] == 1:
            s.sem[w, a, SEM_SPEED] = hypot(u, v)
        else:
            s.sem[w, a, SEM_SPEED] = wp.abs(u)
        s.sem[w, a, SEM_LAT_RATE] = v
        proj = route_project_point(st, a, s.phys[w, a, PH_X], s.phys[w, a, PH_Y])
        s.sem[w, a, SEM_ROUTE_S] = proj
        s.sem[w, a, SEM_LAT_OFF] = route_lateral_offset_at(st, a, proj, s.phys[w, a, PH_X], s.phys[w, a, PH_Y])


@wp.kernel
def k_tick_end(st: Static, s: State):
    w = wp.tid()
    if s.active[w] == 0 or s.finished[w] == 1:
        return
    i = s.tick[w]
    if i >= st.total_ticks:
        s.finished[w] = 1
    s.tick[w] = i + 1


# ------------------------------------------------------------ observation / reward


@wp.kernel
def k_observe_objects(st: Static, s: State, dt_decision: wp.float64):
    # observations.ts ObjectListBuilder.build (rows in actor-slot order; consumers sort by range,id)
    w, a = wp.tid()
    if s.active[w] == 0:
        return
    ego = st.ego
    s.obj_valid[w, a] = 0
    if a == ego:
        return
    ex = s.sem[w, ego, SEM_X]
    ey = s.sem[w, ego, SEM_Y]
    ax = s.sem[w, a, SEM_X]
    ay = s.sem[w, a, SEM_Y]
    dx = ax - ex
    dy = ay - ey
    range_m = hypot(dx, dy)
    if range_m > F(st.object_list_range_m):
        return
    los = int(1)
    for o in range(st.n_occluders):
        if segment_hits_obb(ex, ey, ax, ay, st.occluder_obb[o, 0], st.occluder_obb[o, 1], st.occluder_obb[o, 2],
                            st.occluder_obb[o, 3], st.occluder_obb[o, 4]) == 1:
            los = 0
    if los == 1:
        for c in range(st.n_actors):
            if c == ego or c == a:
                continue
            if segment_hits_obb(ex, ey, ax, ay, s.sem[w, c, SEM_X], s.sem[w, c, SEM_Y], st.actor_dims[c, 0],
                                st.actor_dims[c, 1], s.sem[w, c, SEM_HEADING]) == 1:
                los = 0
                break
    bearing = wp.atan2(dy, dx) - s.sem[w, ego, SEM_HEADING]
    guard = int(0)
    while bearing >= F(PI) and guard < 64:
        bearing = bearing - F(TWO_PI)
        guard += 1
    while bearing < -F(PI) and guard < 128:
        bearing = bearing + F(TWO_PI)
        guard += 1
    range_rate = F(0.0)
    if s.prev_range_valid[w, a] == 1 and F(dt_decision) > F(0.0):
        range_rate = (range_m - s.prev_range[w, a]) / F(dt_decision)
    s.prev_range[w, a] = range_m
    s.prev_range_valid[w, a] = 1
    s.obj[w, a, 0] = range_m
    s.obj[w, a, 1] = bearing
    s.obj[w, a, 2] = range_rate
    s.obj[w, a, 3] = F(los)
    s.obj_valid[w, a] = 1


@wp.kernel
def k_observe_world(st: Static, s: State, is_reset: int):
    # observations.ts StateVectorBuilder + reward.ts assembleReward + EnvSession.step termination
    w = wp.tid()
    if s.active[w] == 0:
        return
    ego = st.ego
    ex = s.sem[w, ego, SEM_X]
    ey = s.sem[w, ego, SEM_Y]
    nearest = F(NEAREST_RANGE_SENTINEL_M)
    proximity = F(0.0)
    for a in range(st.n_actors):
        if a == ego:
            continue
        d = hypot(s.sem[w, a, SEM_X] - ex, s.sem[w, a, SEM_Y] - ey)
        nearest = wp.min(nearest, d)
        if d < F(st.rw_proximity_range_m):
            proximity = proximity + wp.exp(-d / F(5.0))
    s.state_vector[w, 0] = ex
    s.state_vector[w, 1] = ey
    s.state_vector[w, 2] = wp.cos(s.sem[w, ego, SEM_HEADING])
    s.state_vector[w, 3] = wp.sin(s.sem[w, ego, SEM_HEADING])
    s.state_vector[w, 4] = s.sem[w, ego, SEM_SPEED]
    s.state_vector[w, 5] = s.sem[w, ego, SEM_ACCEL]
    s.state_vector[w, 6] = s.sem[w, ego, SEM_LAT_OFF]
    s.state_vector[w, 7] = s.sem[w, ego, SEM_LAT_RATE]
    s.state_vector[w, 8] = s.sem[w, ego, SEM_ROUTE_S]
    s.state_vector[w, 9] = nearest
    s.t_out[w] = s.t[w]
    if is_reset == 1:
        s.reward[w] = F(0.0)
        for k in range(RW_N):
            s.reward_terms[w, k] = F(0.0)
        s.terminated[w] = 0
        s.truncated[w] = 0
        return
    s.decision_count[w] = s.decision_count[w] + 1
    collision = s.ego_collision[w]
    goal = int(0)
    if st.goal_interaction >= 0 or st.goal_route_end == 1:
        goal = 1
        if st.goal_interaction >= 0 and s.goal_fired[w] == 0:
            goal = 0
        if st.goal_route_end == 1:
            # the reference never emits a route_end despawn; routeEnd goals are never met
            goal = 0
    progress = F(0.0)
    if s.prev_ego_s_valid[w] == 1:
        progress = F(st.rw_progress_weight) * (s.sem[w, ego, SEM_ROUTE_S] - s.prev_ego_s[w])
    proximity = proximity * F(st.rw_proximity_weight)
    comfort = F(st.rw_comfort_weight) * wp.abs(s.sem[w, ego, SEM_ACCEL]) * F(st.dt_decision_s)
    collision_term = F(0.0)
    if collision == 1:
        collision_term = F(st.rw_collision_penalty)
    goal_term = F(0.0)
    if goal == 1:
        goal_term = F(st.rw_goal_bonus)
    s.reward_terms[w, RW_PROGRESS] = progress
    s.reward_terms[w, RW_PROXIMITY] = -proximity
    s.reward_terms[w, RW_COMFORT] = -comfort
    s.reward_terms[w, RW_COLLISION] = collision_term
    s.reward_terms[w, RW_GOAL] = goal_term
    s.reward[w] = collision_term + goal_term + progress - proximity - comfort
    s.prev_ego_s[w] = s.sem[w, ego, SEM_ROUTE_S]
    s.prev_ego_s_valid[w] = 1
    # events drained: the next decision starts with an empty event window
    s.ego_collision[w] = 0
    s.goal_fired[w] = 0
    terminated = int(0)
    if collision == 1 or goal == 1:
        terminated = 1
    clip_over = int(0)
    if s.t[w] >= F(st.clip_seconds) - F(EPS_T):
        clip_over = 1
    horizon_over = int(0)
    if st.max_decisions > 0 and s.decision_count[w] >= st.max_decisions:
        horizon_over = 1
    truncated = int(0)
    if terminated == 0 and (clip_over == 1 or horizon_over == 1 or s.finished[w] == 1):
        truncated = 1
    s.terminated[w] = terminated
    s.truncated[w] = truncated
    if terminated == 1 or truncated == 1:
        s.ended[w] = 1
