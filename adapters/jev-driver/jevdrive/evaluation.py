"""Outcome-only truth scoring. Never an input to Jev or feasibility."""
import math
from . import policy as C
from .geometry import box_corners, polygons_overlap
from .scene import rotate


def interactions(world, drivers):
    events = []
    for a in drivers:
        ia = world.index[a.actor_id]
        ar = world.rows[ia]
        for b in drivers:
            if a is b:
                continue
            ib = world.index[b.actor_id]
            br = world.rows[ib]
            x, y = rotate(float(br[0]-ar[0]), float(br[1]-ar[1]), float(ar[2]))
            if x <= 0 or abs(y) > (world.dims[ia, 1] + world.dims[ib, 1]) / 2 + C.POSITION_MARGIN_M:
                continue
            gap = x - (world.dims[ia, 0] + world.dims[ib, 0]) / 2
            closing = float(ar[3] - br[3] * math.cos(float(br[2]-ar[2])))
            ttc = max(0.0, gap / closing) if closing > C.NUMERIC_EPS else None
            collision = polygons_overlap(box_corners(float(ar[0]), float(ar[1]), float(ar[2]), *world.dims[ia, :2]),
                                         box_corners(float(br[0]), float(br[1]), float(br[2]), *world.dims[ib, :2]))
            near = collision or gap < C.NEAR_MISS_CLEARANCE_M or (ttc is not None and ttc < C.NEAR_MISS_TTC_S)
            if not near:
                continue
            violations = []
            for profile in (a.persona.safety_profile, C.CONSERVATIVE):
                required = profile.stop_gap_m + profile.headway_s * float(ar[3])
                if gap < required and not any(v["envelope"] == profile.name for v in violations):
                    violations.append({"actor_id": a.actor_id, "envelope": profile.name,
                                       "rule": "following_headway", "required_gap_m": round(required, 3),
                                       "actual_gap_m": round(float(gap), 3),
                                       "is_actor_own_envelope": profile.name == a.persona.safety_profile.name})
            if collision:
                violations.append({"actor_id": a.actor_id, "envelope": a.persona.safety_profile.name,
                                   "rule": "physical_non_overlap", "is_actor_own_envelope": True})
            events.append({"tick": world.tick, "time_s": round(world.time_s, 2),
                           "kind": "collision" if collision else "near_miss", "rear_actor": a.actor_id,
                           "front_actor": b.actor_id, "gap_m": round(float(gap), 3),
                           "closing_mps": round(closing, 3), "ttc_s": None if ttc is None else round(ttc, 3),
                           "envelope_violations": violations,
                           "attribution": "observed following-envelope violation, not a causal/legal fault proof"})
    return events
