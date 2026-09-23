"""Policy construction and campaign artifacts over the native kernel Episode.

Episode owns warm-up, world advancement, barriers, deadline/fallback decisions,
trajectory tracking, replay admission/enforcement and the v2 trace/result core.
This adapter only invokes a policy at each delivered observation and converts
sealed evidence for the unchanged campaign scorer. Camera frames are borrowed
from Episode, never rendered by a second Python world/renderer loop.
"""
from __future__ import annotations

import argparse
import json
import signal
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

import numpy as np

from ..episodes import LoadedEpisode, load_episode_spec
from ..frames import EpisodeFrameSource, FrameSourceError, make_frame_source
from ..native import ENGINE_HZ, Episode, NativeError
from ..replay_envelope import ReplayContext, ReplayContextError, load_replay_context, require_profile_coverage
from .endpoint_policy import DecisionContext, EndpointPolicy, EndpointPolicyError, profile_camera_map
from .episode_trace import SCHEMA, convert_trace
from .policies import Policy, make_policy, make_recorded_path_policy

MODES = ("offline-simtime", "realtime")


class _Cancellation:
    """Cooperative stop flag; cancellation never advances or resumes the world."""

    def __init__(self) -> None:
        self.requested = False
        self.signal: str | None = None
        self._previous: list[tuple[int, Any]] = []

    def install(self) -> "_Cancellation":
        for signum in (signal.SIGTERM, signal.SIGINT):
            try:
                self._previous.append((signum, signal.getsignal(signum)))
                signal.signal(signum, self._handle)
            except (ValueError, OSError):
                pass
        return self

    def restore(self) -> None:
        for signum, handler in self._previous:
            try:
                signal.signal(signum, handler)
            except (ValueError, OSError):
                pass
        self._previous.clear()

    def _handle(self, signum: int, _frame: Any) -> None:
        self.requested = True
        self.signal = signal.Signals(signum).name


def _percentiles(samples: list[float]) -> dict[str, float]:
    if not samples:
        return {"p50": 0.0, "p95": 0.0, "max": 0.0}
    data = np.asarray(samples)
    return {"p50": round(float(np.percentile(data, 50)), 4), "p95": round(float(np.percentile(data, 95)), 4), "max": round(float(data.max()), 4)}


def _wire_action(action: Mapping[str, Any]) -> dict[str, Any]:
    if action.get("kind") == "control":
        return {"k": "c", "c": [action["throttle"], action["brake"], action["steer"]]}
    if action.get("kind") == "trajectory":
        return {"k": "t", "p": action["points"]}
    raise ValueError(f"unknown policy action kind {action.get('kind')!r}")


@dataclass
class EpisodeSummary:
    policy: str
    policy_checkpoint: str
    seed: int | str
    session: int
    steps: int
    deadline_misses: int
    episode_digest: str
    terminated: bool
    truncated: bool
    mode: str = "offline-simtime"
    status: str = "completed"
    term_reason: str | None = None
    cancelled: bool = False
    warmup_steps: int = 0
    model_decisions: int = 0
    infer_ms: dict[str, float] = field(default_factory=dict)
    step_ms: dict[str, float] = field(default_factory=dict)
    cross_track_m: dict[str, float] = field(default_factory=dict)
    envelope: dict[str, Any] | None = None
    model: dict[str, Any] | None = None
    replay_context: dict[str, Any] | None = None
    error: dict[str, Any] | None = None
    source_schema: str = SCHEMA
    source_episode_digest: str = ""
    result_status: str = "succeeded"
    truncation: str | None = None


def _write_trace(trace_path: str | Path | None, text: str) -> None:
    if trace_path is None:
        return
    target = Path(trace_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    scratch = target.with_name(f"{target.name}.partial")
    scratch.write_text(text)
    scratch.replace(target)


def _envelope_summary(replay: ReplayContext | None, records: Sequence[Mapping[str, Any]]) -> dict[str, Any] | None:
    """Aggregate kernel verdicts; no host projection or enforcement exists."""
    if replay is None:
        return None
    rows = [row.get("reset", row) for row in records]
    rows = [row for row in rows if row.get("env") is not None]
    for row in rows:
        value = row["env"]
        if not value["inside"]:
            return {"breached": True, "breachedLimits": value["breached"], "atStep": row.get("step", 0),
                    "atTS": round(row["t"], 6), "limits": replay.limits.as_dict(),
                    **{key: round(value[key], 6) for key in ("lateralM", "longitudinalS", "headingRad")}}
    return {"breached": False, "limits": replay.limits.as_dict(),
            **{name: round(max((abs(row["env"][key]) for row in rows), default=0.0), 6)
               for name, key in (("maxLateralM", "lateralM"), ("maxLongitudinalS", "longitudinalS"), ("maxHeadingRad", "headingRad"))}}


def run_episode(
    episode: LoadedEpisode,
    policy: Policy,
    *,
    seed: int | str,
    session: int = 0,
    episode_config: Mapping[str, Any] | None = None,
    decision_hz: int | None = None,
    mode: str = "offline-simtime",
    deadline_ms: float | None = None,
    fallback: str = "repeat-last",
    execution: str = "pure-pursuit",
    max_steps: int = 30,
    force_miss_at: tuple[int, ...] = (),
    trace_path: str | Path | None = None,
    warmup_policy: Policy | None = None,
    warmup_steps: int = 0,
    replay: ReplayContext | None = None,
    enforce_envelope: bool = True,
    cancellation: _Cancellation | None = None,
    on_decision: Callable[[int], None] | None = None,
) -> EpisodeSummary:
    """Dispatch policies; every simulation/termination verdict comes from Episode.

    The campaign's historical ``max_steps`` includes its explicit warm-up;
    translate it once to the kernel's policy-only decision budget. Forced misses
    now consume actual wall time, rather than supplying an invented latency.
    """
    if mode not in MODES:
        raise ValueError(f"unknown mode {mode!r}; expected one of {MODES}")
    if mode == "realtime" and (deadline_ms is None or not np.isfinite(deadline_ms) or deadline_ms <= 0):
        raise ValueError("realtime mode requires a positive --deadline-ms")
    if mode == "offline-simtime":
        if force_miss_at:
            raise ValueError("force_miss_at is meaningless in offline-simtime mode (no deadline exists)")
        if deadline_ms is not None:
            raise ValueError("offline-simtime mode does not accept --deadline-ms")
    if warmup_steps < 0 or max_steps <= warmup_steps:
        raise ValueError("--steps must exceed nonnegative --warmup-steps")
    if warmup_steps and warmup_policy is None:
        raise ValueError("--warmup-steps requires --warmup-policy")
    config = dict(episode_config or {})
    hz = int(decision_hz or config.get("decisionHz", 10))
    scenario = json.loads(episode.input.to_json())
    if config.get("clipSeconds") is not None:
        scenario["clipSeconds"] = config["clipSeconds"]
    budget = min(max_steps, int(config.get("maxDecisions") or max_steps)) - warmup_steps
    channels = [{"kind": "state"}, {"kind": "objects"}]
    source = policy.frame_source if isinstance(policy, EndpointPolicy) else None
    if source is not None:
        if not isinstance(source, EpisodeFrameSource):
            raise FrameSourceError("frame_source_unavailable", "closed-loop endpoints require the kernel Cameras channel")
        channels.append(source.channel)
    timing_mode: dict[str, Any] = {"kind": mode}
    if mode == "realtime":
        timing_mode.update(deadlineMs=deadline_ms, fallback="hold-last" if fallback == "repeat-last" else fallback)
    spec: dict[str, Any] = {
        "scenario": scenario, "seed": seed, "decisionHz": hz, "mode": timing_mode,
        "warmupDecisions": warmup_steps, "maxDecisions": budget,
        "observation": {"channels": channels}, "execution": execution,
    }
    for key in ("reward", "goal"):
        if key in config:
            spec[key] = config[key]
    if warmup_policy is not None:
        spec["warmupPolicy"] = warmup_policy.name
        spec["warmupActions"] = [_wire_action(warmup_policy.act(index, None).action) for index in range(warmup_steps)]
    if replay is not None:
        spec["replayContext"] = replay.episode_context(measure_only=not enforce_envelope)
    kernel = Episode(json.dumps(spec), episode.graph)
    if source is not None:
        source.bind(kernel)
    annotations: dict[int, dict[str, Any]] = {}
    infer_samples: list[float] = []
    step_samples: list[float] = []
    cross_track: list[float] = []
    ego_trail: list[tuple[float, float, float, float, float]] = []
    failure: dict[str, Any] | None = None
    cancelled = False

    def context(observation: Mapping[str, Any], step: int, snapshot: Mapping[str, Any] | None = None) -> DecisionContext:
        t_s = float(observation["tS"])
        if hasattr(policy, "act_context"):
            truth = snapshot if snapshot is not None else json.loads(kernel.snapshot())
            actor = next(row["state"] for row in truth["actors"] if row["id"] == truth["egoId"])
            pose = (t_s, actor["x"], actor["y"], actor["headingRad"], actor["speedMps"])
            if not ego_trail or ego_trail[-1][0] != t_s:
                ego_trail.append(pose)
        return DecisionContext(step=step, t_s=t_s, tick=round(t_s * ENGINE_HZ),
                               state_vector=np.asarray(observation["stateVector"], dtype=np.float64),
                               ego_trail=tuple(ego_trail), info={"t_s": t_s})

    def warmup_frame(payload: str, frames: Sequence[Any]) -> None:
        event = json.loads(payload)
        observation = event["observation"]
        ctx = context(observation, round(float(observation["tS"]) * hz), event["snapshot"])
        if source is not None:
            source.observe(observation, frames)
            policy.observe(ctx)

    try:
        observation = json.loads(kernel.reset(warmup_frame))
        for step in range(warmup_steps, max_steps):
            if kernel.ended:
                break
            if cancellation is not None and cancellation.requested:
                cancelled = True
                break
            if source is not None:
                source.observe(observation)
            ctx = context(observation, step)
            began = time.perf_counter()
            try:
                decision = policy.act_context(ctx) if hasattr(policy, "act_context") else policy.act(step, ctx.state_vector)
            except (EndpointPolicyError, FrameSourceError, ReplayContextError) as error:
                failure = {"code": error.code, "message": str(error), "detail": error.detail, "step": step}
                break
            infer_ms = (time.perf_counter() - began) * 1000.0
            if step in force_miss_at:
                time.sleep(float(deadline_ms) * 4.0 / 1000.0)
            began = time.perf_counter()
            result = json.loads(kernel.step(json.dumps(_wire_action(decision.action))))
            step_ms = (time.perf_counter() - began) * 1000.0
            observation = result["obs"]
            infer_samples.append(infer_ms)
            step_samples.append(step_ms)
            if result["ex"] is not None:
                cross_track.append(abs(float(result["ex"]["crossTrackErrorM"])))
            annotations[step] = {"replan": int(getattr(policy, "last_replanned", True)),
                                 "reasoning": decision.reasoning,
                                 "timing": {"infer_ms": round(infer_ms, 4), "step_ms": round(step_ms, 4)}}
            if on_decision is not None:
                on_decision(step + 1)
        core = json.loads(kernel.finish())
        native_trace = kernel.trace_json()
    finally:
        if source is not None:
            source.close()
        kernel.close()
    converted = convert_trace(native_trace, policy=policy.name, annotations=annotations)
    records = [json.loads(line) for line in native_trace.splitlines()]
    legacy_summary = json.loads(converted.splitlines()[-1])["summary"]
    term_reason = core["termReason"]
    status = ("cancelled" if cancelled else "failed" if failure else
              "envelope_exceeded" if term_reason == "envelope_exceeded" else
              "terminated" if term_reason in ("collision", "goal") else
              "truncated" if core["truncation"] is not None else "completed")
    summary = EpisodeSummary(
        policy=policy.name, policy_checkpoint=policy.checkpoint_digest, seed=seed, session=session,
        steps=core["decisions"] + core["warmupDecisions"], deadline_misses=core["deadlineMisses"],
        episode_digest=legacy_summary["episode_digest"], terminated=legacy_summary["terminated"],
        truncated=legacy_summary["truncated"], mode=core["mode"], status=status,
        term_reason=(f"cancelled:{cancellation.signal or 'stop'}" if cancelled and cancellation else
                     failure["code"] if failure else term_reason), cancelled=cancelled,
        warmup_steps=core["warmupDecisions"], model_decisions=core["decisions"],
        infer_ms=_percentiles(infer_samples), step_ms=_percentiles(step_samples), cross_track_m=_percentiles(cross_track),
        envelope=_envelope_summary(replay, records), model=policy.provenance() if hasattr(policy, "provenance") else None,
        replay_context=None if replay is None else replay.input_ref(), error=failure,
        source_episode_digest=core["episodeDigest"],
        result_status=core["status"], truncation=core["truncation"],
    )
    converted = "\n".join(converted.splitlines()[:-1]) + "\n" + json.dumps({"summary": summary.__dict__}, sort_keys=True) + "\n"
    if trace_path is not None:
        _write_trace(Path(trace_path).with_suffix(".episode-v2.jsonl"), native_trace)
    _write_trace(trace_path, converted)
    return summary


def _build_policy(args: argparse.Namespace, decision_hz: int, replay: ReplayContext | None = None) -> tuple[Policy, Any]:
    if args.policy == "recorded-path":
        if replay is None:
            raise ReplayContextError("replay_context_missing", "--policy recorded-path requires --replay-context")
        return make_recorded_path_policy(replay.recorded_path, decision_hz=float(decision_hz)), None
    if args.policy != "endpoint":
        return make_policy(args.policy), None
    if not args.endpoint_socket:
        raise EndpointPolicyError("endpoint_socket_required", "--policy endpoint requires --endpoint-socket")
    camera_map = profile_camera_map(args.camera_profile)
    source = make_frame_source(args.frame_source, profile=args.camera_profile, sensor_ids=tuple(camera_map))
    if source is None:
        raise EndpointPolicyError("frame_source_required", "--policy endpoint requires --frame-source bevy:<rig.json>; camera observations are never synthesized")
    try:
        from simforge_alpamayo.client import AlpamayoClient
    except ImportError as error:
        raise EndpointPolicyError("endpoint_client_unavailable", f"simforge_alpamayo is not importable: {error}") from error
    params: dict[str, Any] = {}
    if args.num_traj_samples is not None:
        params["num_traj_samples"] = args.num_traj_samples
    if args.model_params:
        params.update(json.loads(args.model_params))
    expect = {key: value for key, value in (("family", args.model_family), ("revision", args.model_revision), ("quant", args.model_quant)) if value}
    replan_every = max(1, round(decision_hz / args.replan_hz)) if args.replan_hz else 1
    client = AlpamayoClient(args.endpoint_socket)
    try:
        policy = EndpointPolicy(client, frame_source=source, camera_profile=args.camera_profile,
                                seed=int(args.policy_seed), replan_every=replan_every, params=params,
                                nav_text=args.nav_text, allow_cold_start=args.allow_cold_start,
                                expect_model=expect or None, plan_points=args.plan_points)
    except Exception:
        client.close()
        source.close()
        raise
    return policy, source


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="simforge-oss-policy-runner")
    parser.add_argument("--spec", required=True, help="episode spec JSON")
    parser.add_argument("--session", type=int, default=0)
    parser.add_argument("--policy", choices=("scripted", "trajectory", "endpoint", "recorded-path"), default="scripted")
    parser.add_argument("--seed", default="42", help="episode seed (int or string)")
    parser.add_argument("--policy-seed", type=int, default=0)
    parser.add_argument("--steps", type=int, default=30)
    parser.add_argument("--mode", choices=MODES, default="offline-simtime")
    parser.add_argument("--deadline-ms", type=float, default=None)
    parser.add_argument("--fallback", choices=("repeat-last", "zero-control", "scripted"), default="repeat-last")
    parser.add_argument("--execution", choices=("pure-pursuit", "speed-setpoint"), default="pure-pursuit")
    parser.add_argument("--force-miss-at", type=int, action="append", default=[], help="realtime only: delay this decision beyond its deadline")
    parser.add_argument("--decision-hz", type=int, default=None)
    parser.add_argument("--maps-dir", default=None)
    parser.add_argument("--out", default=None)
    parser.add_argument("--summary-out", default=None)
    parser.add_argument("--endpoint-socket", default=None)
    parser.add_argument("--camera-profile", default="alpamayo-4cam")
    parser.add_argument("--frame-source", default=None, help="bevy:<rig.json>, rendered by the kernel Cameras channel")
    parser.add_argument("--replan-hz", type=float, default=None)
    parser.add_argument("--num-traj-samples", type=int, default=None)
    parser.add_argument("--nav-text", default=None)
    parser.add_argument("--model-params", default=None)
    parser.add_argument("--model-family", default=None)
    parser.add_argument("--model-revision", default=None)
    parser.add_argument("--model-quant", default=None)
    parser.add_argument("--plan-points", type=int, default=None)
    parser.add_argument("--allow-cold-start", action="store_true")
    parser.add_argument("--warmup-policy", choices=("scripted", "trajectory"), default=None)
    parser.add_argument("--warmup-steps", type=int, default=0)
    parser.add_argument("--replay-context", default=None)
    args = parser.parse_args(argv)
    seed: int | str = int(args.seed) if args.seed.lstrip("-").isdigit() else args.seed
    cancellation = _Cancellation().install()
    resource: Any = None
    policy: Policy | None = None
    try:
        replay = load_replay_context(args.replay_context) if args.replay_context else None
        if replay is not None and args.policy == "endpoint":
            require_profile_coverage(replay, profile_camera_map(args.camera_profile).values())
        loaded = load_episode_spec(args.spec, maps_dir=args.maps_dir)
        hz = int(args.decision_hz or loaded.episode_config.get("decisionHz", 10))
        policy, resource = _build_policy(args, hz, replay)
        warmup_policy = make_policy(args.warmup_policy) if args.warmup_policy else None
        warmup_steps = int(args.warmup_steps)
        if args.policy == "endpoint" and warmup_policy is None and warmup_steps == 0:
            warmup_policy, warmup_steps = make_policy("scripted"), 16
        summary = run_episode(
            loaded.episodes[args.session], policy, seed=seed, session=args.session,
            episode_config=loaded.episode_config, decision_hz=hz, mode=args.mode,
            deadline_ms=args.deadline_ms, fallback=args.fallback, execution=args.execution,
            max_steps=args.steps, force_miss_at=tuple(args.force_miss_at), trace_path=args.out,
            warmup_policy=warmup_policy, warmup_steps=warmup_steps, replay=replay,
            enforce_envelope=args.policy != "recorded-path", cancellation=cancellation,
        )
    except (EndpointPolicyError, FrameSourceError, ReplayContextError, NativeError, ValueError) as error:
        payload = {"status": "failed", "error": {"code": getattr(error, "code", "runner_error"), "message": str(error), "detail": getattr(error, "detail", {})}}
        json.dump(payload, sys.stdout, sort_keys=True)
        sys.stdout.write("\n")
        return 2
    finally:
        cancellation.restore()
        if isinstance(policy, EndpointPolicy):
            policy.close()
        if resource is not None:
            resource.close()
    document = summary.__dict__
    if args.summary_out:
        Path(args.summary_out).write_text(f"{json.dumps(document, sort_keys=True, indent=1)}\n")
    json.dump(document, sys.stdout, sort_keys=True)
    sys.stdout.write("\n")
    if summary.status == "cancelled":
        return 130
    return 0 if summary.status in ("completed", "terminated", "truncated", "envelope_exceeded") else 2


if __name__ == "__main__":
    raise SystemExit(main())
