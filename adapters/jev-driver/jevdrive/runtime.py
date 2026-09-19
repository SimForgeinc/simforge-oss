"""Shared N-driver lockstep runtime. N=1 uses precisely this loop."""
from concurrent.futures import ThreadPoolExecutor
from fractions import Fraction
from collections import Counter
import json
import math
from pathlib import Path
import statistics
import subprocess
import sys
import time
from . import policy as C
from .client import pooled_client
from .driver import JevDriver
from .evaluation import interactions
from .sensing import ActorSensor
from .world import NativeWorld

ROOT = Path(__file__).resolve().parents[1]

def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)

def run(spec, out, *, seconds=20.0, seed="jev-multidriver-1", actor_ids=None):
    out = Path(out)
    out.mkdir(parents=True, exist_ok=False)
    world = NativeWorld(spec, seconds, seed)
    ids = actor_ids or world.ids
    records, outcome_events, native_events = [], [], []
    counts = Counter()
    barriers = []
    with pooled_client() as client, ThreadPoolExecutor(max_workers=len(ids)) as pool:
        drivers = [JevDriver(aid, C.PERSONAS[next((tag.split(":", 1)[1] for tag in world.specs[aid]["tags"] if tag.startswith("persona:")), "cooperative")],
                             ActorSensor(world, aid), client) for aid in ids]
        manifest = {"world": "Simforge native dynamic-v1", "mode": "lockstep", "model": C.MODEL,
                    "map_id": world.input.map_id, "spec_path": str(Path(spec).resolve()),
                    "native_input_hash": world.input.content_hash, "seed": seed, "engine_hz": C.ENGINE_HZ,
                    "drivers": [{"actor_id": d.actor_id, **d.persona.document()} for d in drivers],
                    "sensor_profile": "per-actor 360-degree range/OBB-LOS exact visible boxes",
                    "include_occluded": False, "oracle_in_planner": False,
                    "commit": "all requests submitted concurrently; all answers collected before any latch commits",
                    "scenario_solution": "Real Garching road 160 corridor, no route controls or parked-row occluders. Conservative occlusion speed/reaction/horizon unchanged.",
                    "policy": "jev", "questions": C.QUESTION_SETS}
        (out / "manifest.json").write_text(json.dumps(manifest, indent=2))
        total_ticks = round(seconds * C.ENGINE_HZ)
        with (out / "ticks.jsonl").open("w") as ticks_file, (out / "decisions.jsonl").open("w") as decision_file:
            for tick in range(total_ticks):
                scenes = {d.actor_id: d.observe(world) for d in drivers}
                poses = {d.actor_id: world.pose(d.actor_id) for d in drivers}
                candidates = {d.actor_id: d.feasible(scenes[d.actor_id], poses[d.actor_id]) for d in drivers}
                due = [d for d in drivers if tick == math.ceil(d.decision_index * C.ENGINE_HZ / Fraction(str(d.persona.decision_hz)))]
                started = time.perf_counter()
                futures = [(d, pool.submit(d.decide, scenes[d.actor_id], candidates[d.actor_id][0])) for d in due]
                # Read barrier first; commit barrier second. Iteration order cannot
                # expose a peer answer through the already-frozen observations.
                decisions = [(d, future.result()) for d, future in futures]
                barrier_ms = round((time.perf_counter() - started) * 1000, 3)
                if due:
                    barriers.append({"tick": tick, "drivers": len(due), "wall_ms": barrier_ms,
                                     "sum_api_ms": round(sum(v.record["api_latency_ms"] or 0 for _, v in decisions), 3)})
                for d, decision in decisions:
                    aid = d.actor_id
                    decision.record["rejected"] = candidates[aid][1]
                    decision.record["barrier_wall_ms"] = barrier_ms
                    d.commit(decision, scenes[aid], candidates[aid][0], poses[aid])
                    records.append(decision.record)
                    decision_file.write(canonical(decision.record) + "\n")
                display = []
                for d in drivers:
                    aid = d.actor_id
                    feasible, rejected = candidates[aid]
                    override = d.supervise(scenes[aid], feasible, poses[aid])
                    counts["safety_overrides"] += bool(override)
                    counts["no_feasible_driver_ticks"] += not bool(feasible)
                    counts[aid + ":" + d.latch()["id"]] += 1
                    display.append({**d.display(tick, override), "feasible": list(feasible), "rejected": rejected})
                outcomes = interactions(world, drivers)
                outcome_events.extend(outcomes)
                counts["collision_ticks"] += any(e["kind"] == "collision" for e in outcomes)
                counts["near_miss_ticks"] += any(e["kind"] == "near_miss" for e in outcomes)
                native_tick_events = world.advance(drivers)
                native_events.extend(native_tick_events)
                ticks_file.write(canonical({"tick": tick, "time_s": round(tick*C.DT_S, 2), "drivers": display,
                                           "collision_events": outcomes, "native_events": native_tick_events}) + "\n")
                if due:
                    print(f"tick={tick:04d} " + " ".join(f"{d.actor_id}/{d.persona.name}:{d.latch()['id']}" for d in drivers) + f" barrier={barrier_ms:.1f}ms", flush=True)
                    decision_file.flush()
                    ticks_file.flush()
        doc = world.write_scene(out / "scenestate.json", drivers)
        (out / "barriers.json").write_text(json.dumps(barriers, indent=2))
        (out / "conflicts.json").write_text(json.dumps(outcome_events, indent=2))
        live = [r for r in records if r["api_latency_ms"] is not None]
        summary = {"ticks_run": total_ticks, "sim_time_s": seconds, "drivers_per_run": len(drivers),
                   "live_api_calls": len(live), "live_api_responses": sum(bool(r["raw_response"]) for r in live),
                   "accepted_jev_choices": sum(r["fallback_reason"] is None for r in live),
                   "median_api_latency_ms": statistics.median(r["api_latency_ms"] for r in live) if live else None,
                   "fallback_reasons": dict(Counter(r["fallback_reason"] for r in records if r["fallback_reason"])),
                   "counts": dict(counts), "collision_ticks": counts["collision_ticks"], "near_miss_ticks": counts["near_miss_ticks"],
                   "native_collision_events": [e for e in native_events if "collision" in str(e.get("kind", "")).lower()],
                   "scene_state_frames": len(doc["frames"]), "scene_state_path": str(out / "scenestate.json"),
                   "decision_log_path": str(out / "decisions.jsonl"),
                   "per_driver": {d.actor_id: {"persona": d.persona.name, "distance_m": round(d.distance_m, 3),
                                                "final_speed_mps": round(world.pose(d.actor_id)[4], 3)} for d in drivers},
                   "interpretation": "Observed interaction, not a calibrated safety certificate or causal fault proof."}
        qa = subprocess.run([sys.executable, str(ROOT / "qa_scenestate.py"), "--scene-state", str(out / "scenestate.json")], capture_output=True, text=True)
        (out / "qa.txt").write_text(qa.stdout + qa.stderr)
        summary["qa_passed"] = qa.returncode == 0
        (out / "summary.json").write_text(json.dumps(summary, indent=2))
        print("SUMMARY " + canonical(summary), flush=True)
        if qa.returncode:
            raise RuntimeError("scene-state QA failed; rendering forbidden")
        return summary
