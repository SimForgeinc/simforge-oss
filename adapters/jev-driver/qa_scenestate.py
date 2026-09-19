"""QA a scene-state document before it is rendered.

The renderer only checks that `rotation` and `yawRad` agree with each other, so a
document with a globally wrong frame convention passes validation and renders
every actor mirrored. These checks compare orientation against the motion the
document itself describes, which catches exactly that class of error.

Checks, all fatal unless noted:
  1. yaw vs displacement   — where an actor moves, does it face the way it moves?
  2. yaw vs velocity       — does the velocity vector agree with yawRad?
  3. quaternion vs yawRad  — the renderer's own consistency rule, replicated
  4. continuity            — no teleports or impossible yaw jumps between ticks
  5. speed sanity          — reported speed matches finite-difference speed
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

ap = argparse.ArgumentParser()
ap.add_argument("--scene-state", required=True)
ap.add_argument("--move-threshold-m", type=float, default=0.05,
                help="ignore orientation checks below this per-tick displacement")
ap.add_argument("--yaw-tolerance-deg", type=float, default=12.0)
args = ap.parse_args()

doc = json.loads(Path(args.scene_state).read_text())
frames = doc["frames"]
dt = doc["dt"]
tol = math.radians(args.yaw_tolerance_deg)
failures: list[str] = []
checked = {"displacement": 0, "velocity": 0, "quaternion": 0}


def wrap(a: float) -> float:
    return (a + math.pi) % (2 * math.pi) - math.pi


def quat_yaw(q: list[float]) -> float:
    x, y, z, w = q
    return math.atan2(2.0 * (w * y + x * z), 1.0 - 2.0 * (y * y + x * x))


prev = {e["id"]: e for e in frames[0]["actors"]}
for frame in frames[1:]:
    for e in frame["actors"]:
        aid, tick = e["id"], frame["tick"]
        yaw = e["yawRad"]

        # 3. quaternion vs yawRad — what the renderer itself enforces
        if abs(wrap(quat_yaw(e["rotation"]) - yaw)) > 1.0e-3:
            failures.append(f"tick {tick} {aid}: quaternion disagrees with yawRad")
        checked["quaternion"] += 1

        # 2. velocity direction vs yaw. Forward in scene-yup is (cos yaw, 0, -sin yaw).
        vx, _, vz = e["velocity"]
        speed = math.hypot(vx, vz)
        if speed > args.move_threshold_m / dt:
            want = math.atan2(-vz, vx)
            if abs(wrap(want - yaw)) > tol:
                failures.append(
                    f"tick {tick} {aid}: velocity points {math.degrees(want):.1f} deg "
                    f"but yaw is {math.degrees(yaw):.1f} deg")
            checked["velocity"] += 1

        if aid in prev:
            p0, p1 = prev[aid]["position"], e["position"]
            dx, dz = p1[0] - p0[0], p1[2] - p0[2]
            step = math.hypot(dx, dz)

            # 4. continuity: no teleports, no impossible yaw rate
            if step > 3.0:
                failures.append(f"tick {tick} {aid}: teleported {step:.2f} m in one tick")
            if abs(wrap(yaw - prev[aid]["yawRad"])) > math.radians(30):
                failures.append(f"tick {tick} {aid}: yaw jumped > 30 deg in one tick")

            # 1. THE important one: does it face the way it actually travels?
            if step > args.move_threshold_m:
                want = math.atan2(-dz, dx)
                if abs(wrap(want - yaw)) > tol:
                    failures.append(
                        f"tick {tick} {aid}: travels {math.degrees(want):.1f} deg "
                        f"but faces {math.degrees(yaw):.1f} deg "
                        f"(off by {math.degrees(abs(wrap(want - yaw))):.1f})")
                checked["displacement"] += 1

                # 5. speed sanity
                if speed > 0.1 and abs(step / dt - speed) > max(0.5, 0.25 * speed):
                    failures.append(
                        f"tick {tick} {aid}: moved {step / dt:.2f} m/s but reports {speed:.2f} m/s")
        prev[aid] = e

print(f"frames={len(frames)} actors={len(doc['actors'])} map={doc['mapId']}")
print(f"checks run: {checked}")
if failures:
    print(f"FAIL {len(failures)} problem(s); first 8:")
    for line in failures[:8]:
        print("  " + line)
    raise SystemExit(1)
print("PASS scene-state is coherent: orientation matches motion, no teleports")
