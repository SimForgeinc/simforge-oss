
Runs inside a CARLA worker container. For each (world, label, xodr) it loads the
world, walks every driving lane centre every STEP metres, computes the XODR surface
z (reference elevation + superelevation roll across t), and ray-casts the cooked
mesh vertically. Among road/ground-labelled hits the one nearest the XODR z is the
surface; a sample with road hits more than 3 m apart is a bridge/overpass stack and
is reported separately (excluded from the gate). Residual = xodr_z - mesh_z.
Usage: python3 ground_residuals.py out.json World=label:path [World=label:path ...]
"""
import json, math, sys, time
sys.path.insert(0, "/wt")
import carla
from simforge_oss_carla_exec.world_manifest_tools import xodr_identity as X

STEP = 4.0
GROUND_LABELS = {"Roads", "RoadLines", "Sidewalks", "Ground", "Terrain", "Other", "Static", "Bridge", "GuardRail"}
client = carla.Client("127.0.0.1", 2000)
client.set_timeout(600)
out = {}
jobs = {}
for arg in sys.argv[2:]:
    world, rest = arg.split("=", 1)
    label, path = rest.split(":", 1)
    jobs.setdefault(world, []).append((label, path))


def lane_centres(road):
    secs = X._sections(road)
    for i, (s0, lanes) in enumerate(secs):
        s1 = secs[i + 1][0] if i + 1 < len(secs) else road.length
        driving = [lid for lid, ltype, _lvl, _w in lanes if ltype == "driving"]
        n = max(1, int((s1 - s0) / STEP))
        for k in range(n):
            s = s0 + (k + 0.5) * (s1 - s0) / n
            _, widths = X._lane_widths(secs, s)
            for lid in driving:
                sign = -1 if int(lid) < 0 else 1
                t = X._eval_poly(road.lane_offset, s)
                for j in sorted((int(x) for x in widths if x.lstrip("-").isdigit() and int(x) * sign > 0), key=abs):
                    w = widths[str(j)][1]
                    if j == int(lid):
                        yield s, t + sign * w / 2
                        break
                    t += sign * w


for world, items in jobs.items():
    t0 = time.time()
    client.load_world(world)
    time.sleep(3)
    w = client.get_world()
    assert w.get_map().name.endswith(world), w.get_map().name
    labels_seen = {}
    method_unlabelled = [0]
    for label, path in items:
        net = X.parse(open(path, "rb").read())
        residuals, stacked, misses, outliers, overpass = [], 0, 0, [], {}
        for road in net.roads.values():
            for s, t in lane_centres(road):
                x, y, h = X._eval_ref(road, s)
                px, py = x - math.sin(h) * t, y + math.cos(h) * t
                sup = X._eval_poly(road.lateral, s)
                z = X._eval_poly(road.elevation, s) + t * math.sin(sup)
                hits = w.cast_ray(carla.Location(px, -py, z + 30.0), carla.Location(px, -py, z - 30.0))
                ground = []
                for hit in hits:
                    name = str(hit.label)
                    labels_seen[name] = labels_seen.get(name, 0) + 1
                    if name in GROUND_LABELS:
                        ground.append(hit.location.z)
                if not ground and hits and all(str(hit.label) == "NONE" for hit in hits):
                    # A cook without semantic tags (Saratoga): the road surface is the
                    # lowest surface under the lane centre (canopies and props sit above).
                    ground = [min(hit.location.z for hit in hits)]
                    method_unlabelled[0] += 1
                if not ground:
                    misses += 1
                    continue
                if max(ground) - min(ground) > 3.0:
                    stacked += 1
                    continue
                mesh = min(ground, key=lambda g: abs(g - z))
                if mesh - z > 3.0:
                    # Only a deck far above the lane: a grade-separated structure over it
                    # (the lower surface is occluded for this ray). Excluded, recorded.
                    overpass[road.id] = overpass.get(road.id, 0) + 1
                    continue
                residuals.append(z - mesh)
                if abs(z - mesh) > 0.5 and len(outliers) < 40:
                    outliers.append({"road": road.id, "junction": road.junction, "s": round(s, 1), "t": round(t, 2),
                                     "xodrZ": round(z, 3), "meshZ": round(mesh, 3),
                                     "hits": [[str(h.label), round(h.location.z, 2)] for h in hits][:6]})
        a = sorted(abs(r) for r in residuals)
        pct = lambda q: a[min(len(a) - 1, int(q * (len(a) - 1)))] if a else None
        out[f"{world}:{label}"] = {
            "samples": len(a), "bridgeOrOverpassStacks": stacked, "noGroundHit": misses,
            "p50M": pct(0.5), "p95M": pct(0.95), "maxM": a[-1] if a else None,
            "meanSignedM": (sum(residuals) / len(residuals)) if residuals else None,
            "stepM": STEP, "seconds": round(time.time() - t0, 1),
            "unlabelledLowestHitSamples": method_unlabelled[0], "outliers": outliers,
            "overpassOccludedSamplesByRoad": overpass,
        }
        print(json.dumps({f"{world}:{label}": out[f"{world}:{label}"]}), flush=True)
    out[f"{world}:hitLabels"] = labels_seen
json.dump(out, open(sys.argv[1], "w"), indent=1)
