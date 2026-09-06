"""CPU-reference conformance for ``roadway-dynamic-gpu-v1``.

The reference is a per-decision JSONL rollout produced by
``adapters/gpu/tools/reference-rollout.mjs`` (the current ``EnvSession`` over
the fixed-step engine) — or by any future native CPU session that writes the
same record layout. The comparison is *not* a claim from source: it runs the
device batch with the identical document, episode config and action sequence
and reports, per decision:

* exact discrete transitions: ``terminated``, ``truncated``, the decision index
  at which the episode ended, and the presence of terminal ``collision`` /
  ``goal`` reward terms;
* numeric channels under frozen absolute+relative tolerances: state vector,
  reward terms, object-list rows (matched by actor id) and ego pose.

Tolerances are frozen here before any GPU result is seen (PLAN.md determinism
classes). A run that needs looser tolerances is a finding to report, not a
knob to turn.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

import numpy as np

from .batch import ActionBatch, RoadwayGpuBatch
from .lane_graph import LaneGraph
from .profile import PROFILE_ID
from .scenario import EpisodeConfig

#: Frozen tolerances: |gpu - ref| <= atol + rtol * |ref|.
TOLERANCES: dict[str, tuple[float, float]] = {
    "stateVector.pose": (1.0e-6, 1.0e-9),  # x, y, cos, sin, s
    "stateVector.rates": (1.0e-5, 1.0e-8),  # speed, accel, lateral offset/rate
    "stateVector.nearest": (1.0e-6, 1.0e-9),
    "rewardTerms": (1.0e-8, 1.0e-9),
    "objects.range": (1.0e-6, 1.0e-9),
    "objects.bearing": (1.0e-8, 1.0e-9),
    "objects.rangeRate": (1.0e-5, 1.0e-8),
    "egoPose": (1.0e-6, 1.0e-9),
}
_STATE_VECTOR_CHANNEL = ["stateVector.pose", "stateVector.pose", "stateVector.pose", "stateVector.pose",
                         "stateVector.rates", "stateVector.rates", "stateVector.rates", "stateVector.rates",
                         "stateVector.pose", "stateVector.nearest"]
_TERM_INDEX = {"progress": 0, "proximity": 1, "comfort": 2, "collision": 3, "goal": 4}


@dataclass
class ChannelReport:
    channel: str
    count: int = 0
    max_abs_error: float = 0.0
    max_rel_error: float = 0.0
    worst_decision: int = -1
    violations: int = 0

    def observe(self, decision: int, ref: float, gpu: float, atol: float, rtol: float) -> None:
        err = abs(gpu - ref)
        self.count += 1
        rel = err / abs(ref) if abs(ref) > 0 else (0.0 if err == 0 else math.inf)
        if err > self.max_abs_error:
            self.max_abs_error = err
            self.worst_decision = decision
        self.max_rel_error = max(self.max_rel_error, rel)
        if err > atol + rtol * abs(ref):
            self.violations += 1


@dataclass
class ConformanceReport:
    profile_id: str
    world: int
    decisions_compared: int
    reference_end_decision: int | None
    gpu_end_decision: int | None
    discrete_mismatches: list[dict[str, Any]] = field(default_factory=list)
    channels: dict[str, ChannelReport] = field(default_factory=dict)

    @property
    def passed(self) -> bool:
        return not self.discrete_mismatches and all(c.violations == 0 for c in self.channels.values())

    def to_dict(self) -> dict[str, Any]:
        return {
            "profileId": self.profile_id,
            "world": self.world,
            "decisionsCompared": self.decisions_compared,
            "referenceEndDecision": self.reference_end_decision,
            "gpuEndDecision": self.gpu_end_decision,
            "passed": self.passed,
            "discreteMismatches": self.discrete_mismatches,
            "channels": {
                k: {"count": c.count, "maxAbsError": c.max_abs_error, "maxRelError": c.max_rel_error,
                    "worstDecision": c.worst_decision, "violations": c.violations}
                for k, c in self.channels.items()
            },
            "tolerances": {k: {"atol": v[0], "rtol": v[1]} for k, v in TOLERANCES.items()},
        }


def load_rollout(path: str | Path) -> list[dict[str, Any]]:
    with Path(path).open("r", encoding="utf-8") as fh:
        return [json.loads(line) for line in fh if line.strip()]


def _channel(report: ConformanceReport, name: str) -> ChannelReport:
    if name not in report.channels:
        report.channels[name] = ChannelReport(name)
    return report.channels[name]


def _compare_decision(report: ConformanceReport, k: int, ref: Mapping[str, Any], gpu: Mapping[str, Any],
                      actor_ids: Sequence[str], ego_index: int, world: int) -> None:
    # discrete
    for key in ("terminated", "truncated"):
        if bool(ref[key]) != bool(gpu[key][world]):
            report.discrete_mismatches.append({"decision": k, "field": key, "reference": bool(ref[key]), "gpu": bool(gpu[key][world])})
    ref_terms = ref["rewardTerms"]
    terms = gpu["reward_terms"][world]
    for name in ("collision", "goal"):
        ref_has = name in ref_terms
        gpu_has = terms[_TERM_INDEX[name]] != 0.0
        if ref_has != gpu_has:
            report.discrete_mismatches.append({"decision": k, "field": f"rewardTerms.{name}", "reference": ref_has, "gpu": gpu_has})
    # numeric
    if ref.get("stateVector") is not None:
        sv = gpu["state_vector"][world]
        for i, value in enumerate(ref["stateVector"]):
            ch = _STATE_VECTOR_CHANNEL[i]
            _channel(report, f"{ch}[{i}]").observe(k, float(value), float(sv[i]), *TOLERANCES[ch])
    for name, idx in _TERM_INDEX.items():
        ref_v = float(ref_terms.get(name, 0.0))
        _channel(report, f"rewardTerms.{name}").observe(k, ref_v, float(terms[idx]), *TOLERANCES["rewardTerms"])
    _channel(report, "reward").observe(k, float(ref["reward"]), float(gpu["reward"][world]), *TOLERANCES["rewardTerms"])
    # object list: match by id; reference rows [id, range, bearing, rangeRate, los]
    valid = gpu["objects_valid"][world]
    rows = gpu["objects"][world]
    gpu_rows = {actor_ids[a]: rows[a] for a in range(len(actor_ids)) if valid[a] == 1}
    ref_ids = {row[0] for row in ref["objects"]}
    for row in ref["objects"]:
        aid = row[0]
        if aid not in gpu_rows:
            report.discrete_mismatches.append({"decision": k, "field": "objects.gate", "actor": aid, "reference": True, "gpu": False})
            continue
        g = gpu_rows[aid]
        _channel(report, "objects.range").observe(k, float(row[1]), float(g[0]), *TOLERANCES["objects.range"])
        _channel(report, "objects.bearing").observe(k, float(row[2]), float(g[1]), *TOLERANCES["objects.bearing"])
        _channel(report, "objects.rangeRate").observe(k, float(row[3]), float(g[2]), *TOLERANCES["objects.rangeRate"])
        if int(row[4]) != int(round(float(g[3]))):
            report.discrete_mismatches.append({"decision": k, "field": "objects.lineOfSight", "actor": aid, "reference": int(row[4]), "gpu": int(round(float(g[3])))})
    for aid in gpu_rows:
        if aid not in ref_ids:
            report.discrete_mismatches.append({"decision": k, "field": "objects.gate", "actor": aid, "reference": False, "gpu": True})
    pose = ref.get("egoPose")
    if pose:
        ego = gpu["actor_state"][world, ego_index]
        for key, col in (("x", 0), ("y", 1), ("yawRad", 2), ("speedMps", 3)):
            _channel(report, f"egoPose.{key}").observe(k, float(pose[key]), float(ego[col]), *TOLERANCES["egoPose"])
    _channel(report, "tS").observe(k, float(ref["tS"]), float(gpu["t_s"][world]), 1.0e-9, 0.0)


def compare_rollout(
    document: Mapping[str, Any],
    graph: LaneGraph,
    episode: EpisodeConfig | Mapping[str, Any] | None,
    actions: Sequence[Mapping[str, Any] | None],
    rollout: Sequence[Mapping[str, Any]],
    *,
    seed: int = 0,
    device: str = "cuda:0",
    num_worlds: int = 1,
    world: int = 0,
) -> ConformanceReport:
    """Run the device batch on the reference's document/actions and compare
    decision by decision. ``num_worlds > 1`` replicates the same episode across
    worlds so cross-world identity can be asserted by the caller too."""
    batch = RoadwayGpuBatch(document, graph, num_worlds=num_worlds, episode=episode, device=device,
                            seeds=[seed] * num_worlds, use_cuda_graph=False, lease_slots=2)
    actor_ids = batch.actor_ids
    ego_index = batch.scenario.ego_index
    report = ConformanceReport(PROFILE_ID, world, 0, None, None)
    lease = batch.reset()
    gpu = lease.numpy()
    lease.release()
    _compare_decision(report, 0, rollout[0], gpu, actor_ids, ego_index, world)
    report.decisions_compared = 1
    for k, ref in enumerate(rollout[1:], start=1):
        action = actions[k - 1] if k - 1 < len(actions) else {}
        lease = batch.step(ActionBatch.from_dicts([action] * num_worlds, batch.device))
        gpu = lease.numpy()
        lease.release()
        _compare_decision(report, k, ref, gpu, actor_ids, ego_index, world)
        report.decisions_compared = k + 1
        if ref["terminated"] or ref["truncated"]:
            report.reference_end_decision = k
        if gpu["ended"][world] == 1 and report.gpu_end_decision is None:
            report.gpu_end_decision = k
        if (ref["terminated"] or ref["truncated"]) or gpu["ended"][world] == 1:
            break
    if report.reference_end_decision != report.gpu_end_decision:
        report.discrete_mismatches.append({"decision": report.decisions_compared - 1, "field": "episodeEnd",
                                           "reference": report.reference_end_decision, "gpu": report.gpu_end_decision})
    return report


def cross_world_identity(document: Mapping[str, Any], graph: LaneGraph, episode: Any, actions: Sequence[Mapping[str, Any] | None],
                         *, num_worlds: int, device: str = "cuda:0") -> dict[str, Any]:
    """Same-build replay class: every world of one batch, fed identical actions,
    must produce bit-identical outputs; and two consecutive resets of the same
    world must replay bit-identically."""
    batch = RoadwayGpuBatch(document, graph, num_worlds=num_worlds, episode=episode, device=device, use_cuda_graph=True, lease_slots=2)
    traces: list[np.ndarray] = []
    for _ in range(2):
        lease = batch.reset()
        rows = [lease.numpy()["state_vector"].copy()]
        lease.release()
        act = ActionBatch.hold_choreography(num_worlds, batch.device)
        for a in actions:
            act_k = ActionBatch.from_dicts([a] * num_worlds, batch.device)
            wp_copy(act, act_k)
            lease = batch.step(act)
            out = lease.numpy()
            rows.append(out["state_vector"].copy())
            lease.release()
            if bool(out["ended"].all()):
                break
        traces.append(np.stack(rows))
    trace = traces[0]
    identical_worlds = bool(np.all(trace == trace[:, :1, :]))
    identical_replay = traces[0].shape == traces[1].shape and bool(np.array_equal(traces[0], traces[1]))
    return {"identicalAcrossWorlds": identical_worlds, "identicalReplay": identical_replay, "decisions": int(trace.shape[0])}


def wp_copy(dest: ActionBatch, src: ActionBatch) -> None:
    import warp as wp

    wp.copy(dest.values, src.values)
    wp.copy(dest.valid, src.valid)


def main(argv: Iterable[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description="Compare the GPU batch against a reference rollout JSONL.")
    parser.add_argument("--input", required=True, help="SimScenarioInput JSON")
    parser.add_argument("--topology", required=True, help="topology-index.json(.gz)")
    parser.add_argument("--episode", help="EpisodeConfig JSON")
    parser.add_argument("--actions", required=True, help="JSON array of EnvAction per decision")
    parser.add_argument("--rollout", required=True, help="reference rollout JSONL (tools/reference-rollout.mjs)")
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--device", default="cuda:0")
    parser.add_argument("--worlds", type=int, default=1)
    parser.add_argument("--out", help="write the report JSON here")
    args = parser.parse_args(list(argv) if argv is not None else None)
    document = json.loads(Path(args.input).read_text(encoding="utf-8"))
    episode = json.loads(Path(args.episode).read_text(encoding="utf-8")) if args.episode else None
    actions = json.loads(Path(args.actions).read_text(encoding="utf-8"))
    report = compare_rollout(document, LaneGraph.load(args.topology), episode, actions, load_rollout(args.rollout),
                             seed=args.seed, device=args.device, num_worlds=args.worlds)
    payload = report.to_dict()
    if args.worlds > 1:
        payload["crossWorld"] = cross_world_identity(document, LaneGraph.load(args.topology), episode, actions,
                                                     num_worlds=args.worlds, device=args.device)
    text = json.dumps(payload, indent=2)
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")
    print(text)
    return 0 if report.passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
