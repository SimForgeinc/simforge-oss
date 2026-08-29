"""Trace-derived naturalism / aliveness / flow metrics. Stream B (instrument), tg-rethink.

Every kinematic quantity is read from the RAW trace (tg_gate.load_trace columnar ticks),
never from summary fields. The instance JSON contributes only AUTHORED-INTENT structure
(static flags, authored initial speeds, occluder OBBs) for absurdity checks that are
undefined without intent; those metrics are null when no instance is given.

Adopted naturalistic bounds (reported against distributions; composites use only
physical-implausibility bounds):
  - comfortable decel <= 3.4 m/s^2 (AASHTO Green Book stopping-sight-distance decel);
  - comfort jerk <= 2 m/s^3 (ISO 2631-1 comfort guidance, common AV riding-comfort bound);
  - physical braking limit ~0.8-0.9 g -> |a| > 8.0 m/s^2 flagged implausible for wheeled
    actors (dry-asphalt friction ceiling);
  - pedestrian sustained speed > 3.0 m/s implausible for a walking VRU (brisk walk
    ~1.4-1.7 m/s; 3 m/s is already a run).

Versioning: METRICS_VERSION bumps on ANY change to a metric definition or weight.
v1 composites are pre-registered in PREREG.md before the first measured run.
"""
import math
import os
import sys
from collections import defaultdict

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'gates'))
import tg_gate  # noqa: E402  (OBB helpers: _corners, obb_clearance; load_trace)

METRICS_VERSION = 'metrics-v1'

# -- differentiation window: 0.1 s central differences (5 ticks at dt=0.02).
#    50 Hz single-tick differentiation of quantised speeds is numerically explosive;
#    0.1 s is short enough to keep genuine hard braking visible.
DIFF_TICKS = 5

# bounds (see module docstring for citations)
COMFORT_DECEL = 3.4          # m/s^2, AASHTO
COMFORT_JERK = 2.0           # m/s^3, ISO 2631 comfort
IMPLAUSIBLE_ACCEL = 8.0      # m/s^2, ~0.85 g friction ceiling
VRU_RUN_SPEED = 3.0          # m/s sustained, walking pedestrian implausible above
TELEPORT_MIN_M = 1.0         # positional step floor
TELEPORT_FACTOR = 5.0        # step > max(floor, factor * speed * dt) -> teleport
HEADING_JUMP_RAD = math.radians(30.0)
STOP_SPEED = 0.5             # m/s, "stopped"
MOVE_SPEED = 1.0             # m/s, "moving"
DECEL_EVENT_A = -1.5         # m/s^2 sustained
DECEL_EVENT_S = 0.5          # s sustained
AHEAD_CONE_RAD = math.radians(60.0)
AHEAD_RANGE_M = 30.0
INTERACT_RANGE_M = 15.0
QUEUE_RANGE_M = 20.0
PET_CELL_M = 2.0
PET_SAMPLE_TICKS = 5         # 10 Hz
VRU_KINDS = ('pedestrian', 'cyclist', 'bicycle')


def _wrap(a):
    return (a + math.pi) % (2.0 * math.pi) - math.pi


def _percentile(sorted_vals, q):
    if not sorted_vals:
        return None
    k = (len(sorted_vals) - 1) * q
    lo = int(math.floor(k))
    hi = min(lo + 1, len(sorted_vals) - 1)
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (k - lo)


def _lane_key(rsl):
    if not rsl:
        return None, None
    road, _, lane = rsl.rpartition(':')
    return (road, lane) if road else (rsl, None)


def _kinematics(actor, ts, dt):
    """Per-actor accel/jerk samples (0.1 s central diff), teleport & heading-jump ticks."""
    n = len(ts)
    spd, pres = actor['speedMps'], actor['present']
    xs, ys, hd = actor['x'], actor['y'], actor['headingRad']
    k = DIFF_TICKS
    acc = {}
    for i in range(k, n - k):
        if pres[i - k] and pres[i + k]:
            acc[i] = (spd[i + k] - spd[i - k]) / (2.0 * k * dt)
    jrk = {}
    for i in acc:
        if i - k in acc and i + k in acc:
            jrk[i] = (acc[i + k] - acc[i - k]) / (2.0 * k * dt)
    teleports = 0
    hjumps = 0
    for i in range(1, n):
        if not (pres[i - 1] and pres[i]):
            continue
        step = math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1])
        if step > max(TELEPORT_MIN_M, TELEPORT_FACTOR * max(spd[i], spd[i - 1], 1.0) * dt):
            teleports += 1
        if abs(_wrap(hd[i] - hd[i - 1])) > HEADING_JUMP_RAD and max(spd[i], spd[i - 1]) > STOP_SPEED:
            hjumps += 1
    return acc, jrk, teleports, hjumps


def _decel_event_onsets(acc, dt):
    """Onset indices of sustained decel runs (< DECEL_EVENT_A for >= DECEL_EVENT_S)."""
    onsets, run_start, prev = [], None, None
    for i in sorted(acc):
        contiguous = prev is not None and (i - prev) <= DIFF_TICKS
        if acc[i] < DECEL_EVENT_A:
            if run_start is None or not contiguous:
                run_start = i
        else:
            if run_start is not None and (i - run_start) * dt >= DECEL_EVENT_S:
                onsets.append(run_start)
            run_start = None
        prev = i
    if run_start is not None and (prev - run_start) * dt >= DECEL_EVENT_S:
        onsets.append(run_start)
    return onsets


def _actor_ahead(actors, aid, i, meta):
    """Is any other actor within AHEAD_RANGE_M inside the +-AHEAD_CONE heading cone at tick i?"""
    a = actors[aid]
    ax, ay, ah = a['x'][i], a['y'][i], a['headingRad'][i]
    for bid, b in actors.items():
        if bid == aid or not b['present'][i]:
            continue
        dx, dy = b['x'][i] - ax, b['y'][i] - ay
        d = math.hypot(dx, dy)
        if 0.1 < d < AHEAD_RANGE_M and abs(_wrap(math.atan2(dy, dx) - ah)) < AHEAD_CONE_RAD:
            return True
    return False


def _obb_cells(x, y, hd, l, w):
    """Grid cells covered by the OBB's bounding box (footprint approximation for PET)."""
    corners = tg_gate._corners(x, y, hd, l, w)
    xs = [c[0] for c in corners]
    ys = [c[1] for c in corners]
    out = set()
    cx = int(min(xs) // PET_CELL_M)
    while cx <= int(max(xs) // PET_CELL_M):
        cy = int(min(ys) // PET_CELL_M)
        while cy <= int(max(ys) // PET_CELL_M):
            out.add((cx, cy))
            cy += 1
        cx += 1
    return out


def compute_metrics(trace, instance=None):
    """Full deterministic battery for one trace. Returns a flat dict of scalars."""
    hdr, ticks = trace['header'], trace['ticks']
    ts = ticks['t']
    n = len(ts)
    dt = hdr.get('dt', 0.02)
    actors = ticks['actors']
    meta = hdr.get('actorMetadata', {})
    ego = actors.get('ego')
    ambient_ids = set(hdr.get('ambientActorIds') or [])

    # authored intent (instance-only)
    authored = {}
    occluders = []
    if instance is not None:
        inp = instance.get('input', {})
        for a in inp.get('actors', []):
            authored[a['id']] = {
                'static': bool(a.get('static')),
                'speed0': abs(((a.get('initial') or {}).get('speedMps') or 0.0)) < 1e-6,
            }
        for occ in inp.get('occluders') or []:
            obb = occ.get('obb') or {}
            c = obb.get('center') or {}
            if 'x' in c:
                occluders.append(tg_gate._corners(
                    c['x'], -c.get('z', 0.0), obb.get('headingRad', 0.0),
                    obb.get('lengthM', 1.0), obb.get('widthM', 1.0)))

    # ---------------- per-actor kinematics
    kin = {}
    accel_samples = 0
    accel_viol = 0
    hard_decel = 0
    jerk_all = []
    teleport_ticks = 0
    heading_jump_ticks = 0
    vru_overspeed = 0
    nonstatic_stopped = 0
    authored_stop_viol = 0
    mean_speeds = []
    for aid, a in actors.items():
        acc, jrk, tel, hj = _kinematics(a, ts, dt)
        kin[aid] = acc
        teleport_ticks += tel
        heading_jump_ticks += hj
        av = list(acc.values())
        accel_samples += len(av)
        accel_viol += sum(1 for v in av if abs(v) > IMPLAUSIBLE_ACCEL)
        hard_decel += sum(1 for v in av if v < -COMFORT_DECEL)
        jerk_all.extend(abs(v) for v in jrk.values())
        spd = [v for v, p in zip(a['speedMps'], a['present']) if p]
        if not spd:
            continue
        kind = meta.get(aid, {}).get('kind')
        is_static = bool(meta.get(aid, {}).get('static'))
        if kind in VRU_KINDS and kind == 'pedestrian':
            over = sum(1 for v in spd if v > VRU_RUN_SPEED)
            if over * dt > 1.0:  # sustained > 1 s
                vru_overspeed += 1
        # Stopped-actor sanity targets AUTHORED NON-EGO actors: the ambient generator
        # legitimately spawns queued (speed 0) traffic (not the TG-A1 class), and a
        # never-moving ego is already scored by frozen_ego.
        if aid not in ambient_ids and aid != 'ego':
            if not is_static and max(spd) < STOP_SPEED * 0.6:
                nonstatic_stopped += 1
            au = authored.get(aid)
            if au and au['speed0'] and not au['static'] and max(spd) > 2.0:
                authored_stop_viol += 1
        moving = [v for v in spd if v > MOVE_SPEED]
        if moving:
            mean_speeds.append(sum(moving) / len(moving))

    jerk_all.sort()

    # ---------------- ego sanity
    frozen_ego = 0
    ego_dist = None
    if ego is not None:
        d, px, py = 0.0, None, None
        for x, y, pr in zip(ego['x'], ego['y'], ego['present']):
            if not pr:
                px = py = None
                continue
            if px is not None:
                d += math.hypot(x - px, y - py)
            px, py = x, y
        ego_dist = d
        frozen_ego = 1 if d < 5.0 else 0

    # ---------------- prop / occluder overlap (authored absurdity, instance-only)
    prop_overlap = 0
    if occluders:
        for aid, a in actors.items():
            dims = meta.get(aid, {}).get('dims', {})
            al, aw = dims.get('l', 0.6), dims.get('w', 0.6)
            hit = False
            for i in range(0, n, PET_SAMPLE_TICKS):
                if not a['present'][i]:
                    continue
                box = tg_gate._corners(a['x'][i], a['y'][i], a['headingRad'][i], al, aw)
                for occ in occluders:
                    if tg_gate.obb_clearance(box, occ) <= 0.0:
                        hit = True
                        break
                if hit:
                    break
            if hit:
                prop_overlap += 1

    # ---------------- aliveness
    present_counts = []
    moving_counts = []
    for i in range(0, n, PET_SAMPLE_TICKS):
        pc = mc = 0
        for a in actors.values():
            if a['present'][i]:
                pc += 1
                if a['speedMps'][i] > STOP_SPEED:
                    mc += 1
        present_counts.append(pc)
        moving_counts.append(mc)
    actor_count_mean = sum(present_counts) / max(len(present_counts), 1)
    moving_count_mean = sum(moving_counts) / max(len(moving_counts), 1)

    reactive_decels = 0
    for aid in actors:
        if aid == 'ego':
            continue
        for onset in _decel_event_onsets(kin[aid], dt):
            if _actor_ahead(actors, aid, onset, meta):
                reactive_decels += 1

    lane_changes = 0
    for aid, a in actors.items():
        lr, pres = a['laneRsl'], a['present']
        for i in range(1, n):
            if not (pres[i - 1] and pres[i]) or not lr[i - 1] or not lr[i]:
                continue
            r0, l0 = _lane_key(lr[i - 1])
            r1, l1 = _lane_key(lr[i])
            if r0 == r1 and l0 != l1 and a['speedMps'][i] > MOVE_SPEED:
                lane_changes += 1

    signal_changes = 0
    for sid, s in (ticks.get('signals') or {}).items():
        phases = s.get('phase') if isinstance(s, dict) else s
        if isinstance(phases, list):
            signal_changes += sum(1 for i in range(1, len(phases)) if phases[i] != phases[i - 1])

    ids = list(actors)
    interacted = set()
    for i_a in range(len(ids)):
        for i_b in range(i_a + 1, len(ids)):
            A, B = actors[ids[i_a]], actors[ids[i_b]]
            for i in range(0, n, PET_SAMPLE_TICKS):
                if A['present'][i] and B['present'][i] \
                        and max(A['speedMps'][i], B['speedMps'][i]) > MOVE_SPEED \
                        and math.hypot(A['x'][i] - B['x'][i], A['y'][i] - B['y'][i]) < INTERACT_RANGE_M:
                    interacted.add(ids[i_a])
                    interacted.add(ids[i_b])
                    break
    interact_frac = len(interacted) / max(len(ids), 1)

    queue_max = 0
    for i in range(0, n, PET_SAMPLE_TICKS * 5):  # 2 Hz is plenty for queues
        stopped = [(a['x'][i], a['y'][i]) for aid, a in actors.items()
                   if aid != 'ego' and a['present'][i] and a['speedMps'][i] < STOP_SPEED
                   and not meta.get(aid, {}).get('static')]
        best = 0
        for x0, y0 in stopped:
            c = sum(1 for x1, y1 in stopped if math.hypot(x1 - x0, y1 - y0) < QUEUE_RANGE_M)
            best = max(best, c)
        queue_max = max(queue_max, best)

    # ---------------- flow realism
    speed_std = 0.0
    if len(mean_speeds) > 1:
        mu = sum(mean_speeds) / len(mean_speeds)
        speed_std = math.sqrt(sum((v - mu) ** 2 for v in mean_speeds) / (len(mean_speeds) - 1))

    headways = []
    for i in range(0, n, 50):  # 1 Hz
        by_lane = defaultdict(list)
        for aid, a in actors.items():
            if a['present'][i] and a['speedMps'][i] > MOVE_SPEED and a['laneRsl'][i]:
                by_lane[a['laneRsl'][i]].append((a['s'][i], a['speedMps'][i]))
        for lane in by_lane.values():
            lane.sort()
            for (s0, v0), (s1, _v1) in zip(lane, lane[1:]):
                if v0 > MOVE_SPEED:
                    headways.append((s1 - s0) / v0)
    headways.sort()

    # PET over OBB-footprint cell occupancy + true pairwise OBB clearance minima
    occ_first_last = defaultdict(dict)  # cell -> {aid: (t_first, t_last)}
    for aid, a in actors.items():
        dims = meta.get(aid, {}).get('dims', {})
        al, aw = dims.get('l', 0.6), dims.get('w', 0.6)
        for i in range(0, n, PET_SAMPLE_TICKS):
            if not a['present'][i]:
                continue
            for cell in _obb_cells(a['x'][i], a['y'][i], a['headingRad'][i], al, aw):
                slot = occ_first_last[cell].get(aid)
                occ_first_last[cell][aid] = (slot[0], ts[i]) if slot else (ts[i], ts[i])
    pets = {}
    for cell, vis in occ_first_last.items():
        aids = list(vis)
        for i_a in range(len(aids)):
            for i_b in range(i_a + 1, len(aids)):
                fa, la = vis[aids[i_a]]
                fb, lb = vis[aids[i_b]]
                if fa <= lb and fb <= la:
                    gap = 0.0  # co-occupancy
                else:
                    gap = fb - la if fb > la else fa - lb
                key = (aids[i_a], aids[i_b]) if aids[i_a] < aids[i_b] else (aids[i_b], aids[i_a])
                if key not in pets or gap < pets[key]:
                    pets[key] = gap
    pet_vals = sorted(v for v in pets.values())
    pet_conflicts = sum(1 for v in pet_vals if 0.0 < v <= 1.5)

    accel_viol_frac = accel_viol / max(accel_samples, 1)
    hard_decel_frac = hard_decel / max(accel_samples, 1)

    naturalism_penalty = (
        1.0 * teleport_ticks
        + 1.0 * heading_jump_ticks
        + 50.0 * accel_viol_frac
        + 3.0 * frozen_ego
        + 2.0 * nonstatic_stopped
        + 3.0 * (authored_stop_viol if instance is not None else 0)
        + 3.0 * (prop_overlap if instance is not None else 0)
        + 2.0 * vru_overspeed
    )
    aliveness_score = (
        1.0 * moving_count_mean
        + 0.5 * reactive_decels
        + 1.0 * lane_changes
        + 1.0 * signal_changes
        + 2.0 * interact_frac
        + 1.0 * queue_max
    )

    return {
        'version': METRICS_VERSION,
        # naturalism
        'teleport_ticks': teleport_ticks,
        'heading_jump_ticks': heading_jump_ticks,
        'accel_viol_frac': round(accel_viol_frac, 5),
        'hard_decel_frac': round(hard_decel_frac, 5),
        'jerk_p95': round(_percentile(jerk_all, 0.95), 3) if jerk_all else None,
        'frozen_ego': frozen_ego,
        'ego_distance_m': round(ego_dist, 2) if ego_dist is not None else None,
        'nonstatic_stopped_count': nonstatic_stopped,
        'authored_stop_violations': authored_stop_viol if instance is not None else None,
        'prop_overlap_count': prop_overlap if instance is not None else None,
        'vru_overspeed_count': vru_overspeed,
        'naturalism_penalty': round(naturalism_penalty, 4),
        # aliveness
        'actor_count_mean': round(actor_count_mean, 3),
        'moving_actor_count_mean': round(moving_count_mean, 3),
        'nonego_reactive_decels': reactive_decels,
        'lane_change_count': lane_changes,
        'signal_phase_changes': signal_changes,
        'interacting_fraction': round(interact_frac, 3),
        'queue_max_cluster': queue_max,
        'aliveness_score': round(aliveness_score, 4),
        # flow realism
        'speed_mean_std': round(speed_std, 3),
        'headway_median_s': round(_percentile(headways, 0.5), 3) if headways else None,
        'headway_p10_s': round(_percentile(headways, 0.10), 3) if headways else None,
        'pet_min_s': round(pet_vals[0], 3) if pet_vals else None,
        'pet_p10_s': round(_percentile(pet_vals, 0.10), 3) if pet_vals else None,
        'pet_pairs_lt_1p5s': pet_conflicts,
        'pet_pairs_total': len(pet_vals),
    }
