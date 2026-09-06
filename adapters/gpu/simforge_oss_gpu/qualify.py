"""Throughput qualification for ``roadway-dynamic-gpu-v1``.

Measures policy decisions per second (one decision = ``decisionTicks`` engine
ticks for every world) as a function of batch size, with cold (first call,
module load / graph capture) and warm timings reported separately and at least
five independent repeats per point. The crossover against the CPU reference is
computed by Main from the CPU numbers of the native batch; this module only
produces the GPU side and never claims a speed-up.

Timing is wall clock around ``step`` calls plus one ``wp.synchronize_device``
at the end of each repeat (the steady-state path itself has no host sync; the
synchronisation is the measurement fence, not part of the workload).
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

import numpy as np

from .batch import ActionBatch, RoadwayGpuBatch
from .lane_graph import LaneGraph
from .profile import PROFILE_ID
from .scenario import EpisodeConfig


@dataclass
class ThroughputPoint:
    num_worlds: int
    decisions_per_repeat: int
    cold_reset_s: float
    cold_first_step_s: float
    warm_step_s: list[float] = field(default_factory=list)
    worlds_ended_fraction: list[float] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        warm = np.asarray(self.warm_step_s)
        decisions = self.decisions_per_repeat * self.num_worlds
        return {
            "numWorlds": self.num_worlds,
            "decisionsPerRepeat": self.decisions_per_repeat,
            "coldResetS": self.cold_reset_s,
            "coldFirstStepS": self.cold_first_step_s,
            "warmRepeatS": self.warm_step_s,
            "warmWorldDecisionsPerSecond": {
                "median": float(np.median(decisions / warm)) if warm.size else None,
                "p05": float(np.percentile(decisions / warm, 5)) if warm.size else None,
                "p95": float(np.percentile(decisions / warm, 95)) if warm.size else None,
                "repeats": int(warm.size),
            },
            "worldsEndedFraction": self.worlds_ended_fraction,
        }


def measure(
    document: Mapping[str, Any],
    graph: LaneGraph,
    episode: EpisodeConfig | Mapping[str, Any] | None,
    *,
    batch_sizes: Sequence[int],
    decisions: int,
    repeats: int = 5,
    device: str = "cuda:0",
    use_cuda_graph: bool = True,
    actions: Sequence[Mapping[str, Any] | None] | None = None,
) -> dict[str, Any]:
    """Return a JSON-serialisable report. ``actions`` (per decision, applied to
    every world) defaults to holding the authored choreography. Worlds that end
    inside a repeat stay ended (their fraction is reported) so the number is the
    device cost of the batch, not an auto-reset policy's."""
    import warp as wp

    if repeats < 5:
        raise ValueError("qualification needs at least five independent repeats")
    points: list[dict[str, Any]] = []
    for n in batch_sizes:
        batch = RoadwayGpuBatch(document, graph, num_worlds=n, episode=episode, device=device,
                                use_cuda_graph=use_cuda_graph, lease_slots=2)
        act = ActionBatch.hold_choreography(n, batch.device)
        t0 = time.perf_counter()
        lease = batch.reset()
        wp.synchronize_device(batch.device)
        cold_reset = time.perf_counter() - t0
        lease.release()
        t0 = time.perf_counter()
        lease = batch.step(act)
        wp.synchronize_device(batch.device)
        cold_first = time.perf_counter() - t0
        lease.release()
        point = ThroughputPoint(n, decisions, cold_reset, cold_first)
        for _ in range(repeats):
            lease = batch.reset()
            lease.release()
            wp.synchronize_device(batch.device)
            t0 = time.perf_counter()
            for k in range(decisions):
                if actions is not None:
                    _write_actions(act, ActionBatch.from_dicts([actions[k % len(actions)]] * n, batch.device))
                lease = batch.step(act)
                lease.release()
            wp.synchronize_device(batch.device)
            point.warm_step_s.append(time.perf_counter() - t0)
            point.worlds_ended_fraction.append(float(batch.step(act).numpy()["ended"].mean()))
        points.append(point.to_dict())
    return {
        "profileId": PROFILE_ID,
        "device": device,
        "cudaGraph": use_cuda_graph,
        "capabilities": batch.capabilities(),
        "points": points,
        "note": "GPU side only; CPU reference throughput and crossover are computed by the qualification owner.",
    }


def _write_actions(dest: ActionBatch, src: ActionBatch) -> None:
    import warp as wp

    wp.copy(dest.values, src.values)
    wp.copy(dest.valid, src.valid)


def main(argv: Iterable[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description="GPU batch throughput by batch size.")
    parser.add_argument("--input", required=True)
    parser.add_argument("--topology", required=True)
    parser.add_argument("--episode")
    parser.add_argument("--actions", help="JSON array of EnvAction per decision (cycled)")
    parser.add_argument("--batch-sizes", default="1,16,256,4096")
    parser.add_argument("--decisions", type=int, default=100)
    parser.add_argument("--repeats", type=int, default=5)
    parser.add_argument("--device", default="cuda:0")
    parser.add_argument("--no-graph", action="store_true")
    parser.add_argument("--out")
    args = parser.parse_args(list(argv) if argv is not None else None)
    document = json.loads(Path(args.input).read_text(encoding="utf-8"))
    episode = json.loads(Path(args.episode).read_text(encoding="utf-8")) if args.episode else None
    actions = json.loads(Path(args.actions).read_text(encoding="utf-8")) if args.actions else None
    report = measure(document, LaneGraph.load(args.topology), episode,
                     batch_sizes=[int(x) for x in args.batch_sizes.split(",")], decisions=args.decisions,
                     repeats=args.repeats, device=args.device, use_cuda_graph=not args.no_graph, actions=actions)
    text = json.dumps(report, indent=2)
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")
    print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
