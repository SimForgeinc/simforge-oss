"""Episode runner: seeded policy episodes with a digested JSONL trace.

This is the canonical closed-loop episode entrypoint (``python -m
simforge_oss_gym.tools.policy_runner``, console script
``simforge-oss-policy-runner``). The evaluation campaign runner
(``packages/evaluation/src/campaign.ts``) spawns exactly this module.

Each trace line carries the deterministic step record plus a ``digest``, a
SHA-256 chained over the canonical JSON of every deterministic record so far.
Wall-clock timing (``timing``) is *excluded* from the digest: two runs with the
same seed, policy and forced misses produce identical digests even though
inference latency varies.

Digest-covered per step: the policy action ``a`` (trajectory points included),
the acting policy label ``pol``, whether the model replanned, the policy's
``reasoning`` text, ``ex`` (the executor's telemetry: pose, signed cross-track
error, applied setpoints, preview point; ``None`` on non-trajectory steps or
speed-setpoint execution), the deadline verdict, reward, flags, the state
vector and reward terms, the perceived object ids, and the replay-context
envelope measurement when a bundle is enforced.

Timing modes — a run carries exactly one, and the trace/summary say which:

``offline-simtime`` (default)
    The engine pauses at every inference barrier: nothing advances until the
    decision returns. No deadline exists in this mode, ``dl.miss`` is 0 by
    construction, and slow hardware costs wall time, not scientific validity.
``realtime``
    A wall-clock-driven schedule: the measured inference latency is compared
    with an explicit ``--deadline-ms`` and a miss applies the configured
    fallback. Only a run executed in this mode may be labelled "real-time".

Deadline misses are also exercised deterministically in ``realtime``:
``force_miss_at`` steps report a fixed elapsed time of 4x the deadline instead
of the measured one, so the fallback path is part of the digested dynamics.

    simforge-oss-policy-runner --spec tests/fixtures/synthetic-episode-dynamic.json \
        --policy torch --seed 42 --policy-seed 7 --steps 30 --mode realtime \
        --deadline-ms 50 --fallback zero-control --force-miss-at 9 --out /tmp/trace.jsonl

    simforge-oss-policy-runner --spec scenario.episodes.json --policy endpoint \
        --endpoint-socket /tmp/simforge-alpamayo.sock --camera-profile alpamayo-4cam \
        --frame-source dir:/tmp/frames --replan-hz 0.5 --steps 300 \
        --mode offline-simtime --out /tmp/trace.jsonl
"""

from __future__ import annotations

import argparse
import hashlib
import json
import signal
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping, Sequence

import numpy as np

from ..env import SimForgeEnv
from ..frames import FrameSourceError, make_frame_source
from ..policy import Decision, PolicyRunner
from ..replay_envelope import (
    EnvelopeMonitor,
    ReplayContext,
    ReplayContextError,
    load_replay_context,
    require_model_episode_admission,
    require_profile_coverage,
)
from .endpoint_policy import DecisionContext, EndpointPolicy, EndpointPolicyError, profile_camera_map
from .policies import Policy, make_policy, make_recorded_path_policy

MODES = ("offline-simtime", "realtime")


class EpisodeCancelled(RuntimeError):
    """A stop signal arrived; the episode ends at the next barrier."""


class _Cancellation:
    """Cooperative stop flag installed for SIGTERM/SIGINT."""

    def __init__(self) -> None:
        self.requested = False
        self.signal: str | None = None
        self._previous: list[tuple[int, Any]] = []

    def install(self) -> "_Cancellation":
        for signum in (signal.SIGTERM, signal.SIGINT):
            try:
                self._previous.append((signum, signal.getsignal(signum)))
                signal.signal(signum, self._handle)
            except (ValueError, OSError):  # non-main thread / unsupported platform
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


def _canonical(record: Mapping[str, Any]) -> bytes:
    return json.dumps(record, sort_keys=True, separators=(",", ":")).encode()


def _percentiles(samples: list[float]) -> dict[str, float]:
    if not samples:
        return {"p50": 0.0, "p95": 0.0, "max": 0.0}
    data = np.asarray(samples)
    return {"p50": round(float(np.percentile(data, 50)), 4), "p95": round(float(np.percentile(data, 95)), 4), "max": round(float(data.max()), 4)}


def _step_record(observation: Mapping[str, np.ndarray], info: Mapping[str, Any]) -> dict[str, Any]:
    state = observation["state_vector"]
    terms = info["reward_terms"]
    return {
        "t": info["t_s"],
        "sv_sha256": hashlib.sha256(np.ascontiguousarray(state, dtype="<f8").tobytes()).hexdigest(),
        "sv": [float(v) for v in state],
        "terms": [terms["progress"], terms["proximity"], terms["comfort"]],
        "objs": list(info["object_ids"]),
    }


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
    #: ``offline-simtime`` | ``realtime``.
    mode: str = "offline-simtime"
    #: ``completed`` | ``terminated`` | ``truncated`` | ``envelope_exceeded`` | ``cancelled`` | ``failed``.
    status: str = "completed"
    term_reason: str | None = None
    cancelled: bool = False
    #: Decisions driven by the warm-up delegate rather than the evaluated policy.
    warmup_steps: int = 0
    model_decisions: int = 0
    infer_ms: dict[str, float] = field(default_factory=dict)
    step_ms: dict[str, float] = field(default_factory=dict)
    cross_track_m: dict[str, float] = field(default_factory=dict)
    envelope: dict[str, Any] | None = None
    model: dict[str, Any] | None = None
    replay_context: dict[str, Any] | None = None
    error: dict[str, Any] | None = None


def _write_trace(trace_path: str | Path | None, lines: Sequence[str]) -> None:
    """Write the trace atomically so a killed runner never leaves half a line."""
    if trace_path is None:
        return
    target = Path(trace_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    scratch = target.with_name(f"{target.name}.partial")
    scratch.write_text("\n".join(lines) + "\n")
    scratch.replace(target)


def run_episode(
    env: SimForgeEnv,
    policy: Policy,
    *,
    seed: int | str,
    mode: str = "offline-simtime",
    deadline_ms: float | None = None,
    fallback: str = "repeat-last",
    execution: str = "pure-pursuit",
    max_steps: int = 30,
    force_miss_at: tuple[int, ...] = (),
    trace_path: str | Path | None = None,
    warmup_policy: Policy | None = None,
    warmup_steps: int = 0,
    envelope: EnvelopeMonitor | None = None,
    enforce_envelope: bool = True,
    cancellation: _Cancellation | None = None,
) -> EpisodeSummary:
    """Run one episode; returns its summary and writes the digested trace.

    ``mode='offline-simtime'`` passes no elapsed time to the executor, so no
    deadline is enforced anywhere (the barrier is the loop itself).
    ``mode='realtime'`` requires ``deadline_ms`` and reports the measured
    latency per decision.
    """
    if mode not in MODES:
        raise ValueError(f"unknown mode {mode!r}; expected one of {MODES}")
    if mode == "realtime":
        if deadline_ms is None or deadline_ms <= 0:
            raise ValueError("realtime mode requires a positive --deadline-ms")
    else:
        if force_miss_at:
            raise ValueError("force_miss_at is meaningless in offline-simtime mode (no deadline exists)")
        deadline_ms = None

    runner = PolicyRunner(env, deadline_ms=deadline_ms, fallback=fallback, execution=execution)
    observation, info = runner.reset(seed)

    chain = hashlib.sha256()
    reset_record = {
        "reset": {
            **_step_record(observation, info),
            "seed": seed,
            "session": env.session_index,
            "mode": mode,
            "deadline_ms": deadline_ms,
            "fallback": fallback,
            "execution": runner.execution,
            "policy": policy.name,
            "warmup_policy": None if warmup_policy is None else warmup_policy.name,
            "warmup_steps": int(warmup_steps),
            "replay_context": None if envelope is None else envelope.context.scene_id,
        }
    }
    chain.update(_canonical(reset_record))

    lines = [json.dumps({**reset_record, "digest": chain.hexdigest()}, sort_keys=True)]
    infer_samples: list[float] = []
    step_samples: list[float] = []
    cross_track_samples: list[float] = []
    ego_trail: list[tuple[float, float, float, float, float]] = [env.ego_pose()]
    misses = 0
    terminated = truncated = False
    steps_done = 0
    model_decisions = 0
    status = "completed"
    term_reason: str | None = None
    failure: dict[str, Any] | None = None

    for step in range(max_steps):
        if cancellation is not None and cancellation.requested:
            status = "cancelled"
            term_reason = f"cancelled:{cancellation.signal or 'stop'}"
            break

        acting: Policy = warmup_policy if (warmup_policy is not None and step < warmup_steps) else policy
        is_warmup = acting is not policy
        context = DecisionContext(
            step=step,
            t_s=float(info["t_s"]),
            tick=int(round(float(info["t_s"]) * env.engine_hz)),
            state_vector=observation["state_vector"],
            ego_trail=tuple(ego_trail),
            info=info,
        )
        t0 = time.perf_counter()
        try:
            # The evaluated policy observes every decision, warm-up included:
            # a model's frame window has to be full of REAL frames by the time
            # it first acts, and frames only exist while the episode runs.
            if is_warmup and hasattr(policy, "observe"):
                policy.observe(context)
            if hasattr(acting, "act_context"):
                decision = acting.act_context(context)
            else:
                decision = acting.act(step, observation["state_vector"])
        except (EndpointPolicyError, FrameSourceError, ReplayContextError) as error:
            status = "failed"
            term_reason = getattr(error, "code", "policy_error")
            failure = {"code": term_reason, "message": str(error), "detail": getattr(error, "detail", {}), "step": step}
            break
        infer_ms = (time.perf_counter() - t0) * 1000.0

        if mode == "realtime":
            reported_ms: float | None = float(deadline_ms) * 4.0 if step in force_miss_at else infer_ms
        else:
            reported_ms = None  # the barrier is the loop; no deadline in this mode

        t1 = time.perf_counter()
        result: Decision = runner.act(decision.action, elapsed_ms=reported_ms)
        step_ms = (time.perf_counter() - t1) * 1000.0

        observation, info = result.observation, result.info
        misses += result.deadline_miss
        terminated, truncated = result.terminated, result.truncated
        steps_done = step + 1
        if not is_warmup:
            model_decisions += 1
        infer_samples.append(infer_ms)
        step_samples.append(step_ms)
        if result.executor is not None:
            cross_track_samples.append(abs(float(result.executor["crossTrackErrorM"])))
        pose = env.ego_pose()
        ego_trail.append(pose)

        envelope_measure: dict[str, Any] | None = None
        if envelope is not None:
            envelope_measure = envelope.measure(
                step=step, t_s=float(pose[0]), x=float(pose[1]), y=float(pose[2]), heading_rad=float(pose[3])
            )

        deterministic = {
            "step": step,
            "pol": ("warmup:" + acting.name) if is_warmup else acting.name,
            "replan": 0 if is_warmup else int(getattr(acting, "last_replanned", True)),
            "a": decision.action,
            "reasoning": decision.reasoning,
            "ex": result.executor,
            "miss": int(result.deadline_miss),
            "applied": result.applied,
            "rw": result.reward,
            "term": int(terminated),
            "trunc": int(truncated),
            **_step_record(observation, info),
        }
        if envelope_measure is not None:
            deterministic["env"] = envelope_measure
        chain.update(_canonical(deterministic))
        lines.append(
            json.dumps(
                {
                    **deterministic,
                    "digest": chain.hexdigest(),
                    "timing": {"infer_ms": round(infer_ms, 4), "step_ms": round(step_ms, 4)},
                },
                sort_keys=True,
            )
        )

        if envelope is not None and enforce_envelope and envelope.breach is not None:
            # Every render past the breach comes from unreliable geometry:
            # stop here, score up to this point, flag the truncation.
            truncated = True
            status = "envelope_exceeded"
            term_reason = "envelope_exceeded"
            break
        if terminated or truncated:
            status = "terminated" if terminated else "truncated"
            term_reason = "terminated" if terminated else "truncated"
            break

    summary = EpisodeSummary(
        policy=policy.name,
        policy_checkpoint=policy.checkpoint_digest,
        seed=seed,
        session=env.session_index,
        steps=steps_done,
        deadline_misses=misses,
        episode_digest=chain.hexdigest(),
        terminated=terminated,
        truncated=truncated,
        mode=mode,
        status=status,
        term_reason=term_reason,
        cancelled=status == "cancelled",
        warmup_steps=min(int(warmup_steps), steps_done) if warmup_policy is not None else 0,
        model_decisions=model_decisions,
        infer_ms=_percentiles(infer_samples),
        step_ms=_percentiles(step_samples),
        cross_track_m=_percentiles(cross_track_samples),
        envelope=None if envelope is None else envelope.summary(),
        model=policy.provenance() if hasattr(policy, "provenance") else None,
        replay_context=None if envelope is None else envelope.context.input_ref(),
        error=failure,
    )
    lines.append(json.dumps({"summary": summary.__dict__}, sort_keys=True))
    _write_trace(trace_path, lines)
    return summary


def _make_policy(name: str, seed: int) -> Policy:
    """Construct a reference policy, reporting a missing optional dependency
    as a typed refusal rather than an interpreter traceback (the torch policy
    imports torch lazily so the scripted path stays torch-free)."""
    try:
        return make_policy(name, seed)
    except ImportError as error:
        raise EndpointPolicyError(
            "policy_unavailable",
            f"policy {name!r} needs a dependency this interpreter does not have: {error}",
            {"policy": name},
        ) from error


def _build_policy(
    args: argparse.Namespace, env: SimForgeEnv, replay: ReplayContext | None = None
) -> tuple[Policy, Any]:
    """Return the evaluated policy and any resource that must be closed."""
    if args.policy == "recorded-path":
        if replay is None:
            raise ReplayContextError(
                "replay_context_missing",
                "--policy recorded-path is the stock replay of a bundle's recorded path; pass --replay-context",
            )
        return make_recorded_path_policy(replay.recorded_path, decision_hz=float(env.decision_hz)), None
    if args.policy != "endpoint":
        return _make_policy(args.policy, args.policy_seed), None
    if not args.endpoint_socket:
        raise EndpointPolicyError("endpoint_socket_required", "--policy endpoint requires --endpoint-socket")
    camera_map = profile_camera_map(args.camera_profile)
    source = make_frame_source(args.frame_source, env, sensor_ids=tuple(camera_map))
    if source is None:
        raise EndpointPolicyError(
            "frame_source_required",
            "--policy endpoint requires --frame-source (dir:<path> | bevy:<rig.json>); "
            "camera observations are never synthesized",
        )
    try:
        from simforge_alpamayo.client import AlpamayoClient
    except ImportError as error:
        source.close()
        raise EndpointPolicyError(
            "endpoint_client_unavailable",
            f"simforge_alpamayo is not importable in this interpreter: {error}",
        ) from error
    params: dict[str, Any] = {}
    if args.num_traj_samples is not None:
        params["num_traj_samples"] = args.num_traj_samples
    if args.model_params:
        params.update(json.loads(args.model_params))
    expect = {
        key: value
        for key, value in (("family", args.model_family), ("revision", args.model_revision), ("quant", args.model_quant))
        if value
    }
    replan_every = max(1, round(env.decision_hz / args.replan_hz)) if args.replan_hz else 1
    try:
        client = AlpamayoClient(args.endpoint_socket)
        policy = EndpointPolicy(
            client,
            frame_source=source,
            camera_profile=args.camera_profile,
            seed=int(args.policy_seed),
            replan_every=replan_every,
            params=params,
            nav_text=args.nav_text,
            allow_cold_start=args.allow_cold_start,
            expect_model=expect or None,
            plan_points=args.plan_points,
        )
    except Exception:
        source.close()
        raise
    return policy, source


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="simforge-oss-policy-runner")
    parser.add_argument("--spec", required=True, help="episode spec JSON")
    parser.add_argument("--session", type=int, default=0, help="episode index inside the spec")
    parser.add_argument(
        "--policy",
        choices=("scripted", "trajectory", "torch", "endpoint", "recorded-path"),
        default="scripted",
        help="`recorded-path` is the G5 stock replay: it drives a replay-context bundle's own recorded ego path",
    )
    parser.add_argument("--seed", default="42", help="episode seed (int or string)")
    parser.add_argument("--policy-seed", type=int, default=0, help="torch weight seed / endpoint sampling seed")
    parser.add_argument("--steps", type=int, default=30)
    parser.add_argument("--mode", choices=MODES, default="offline-simtime", help="closed-loop timing mode")
    parser.add_argument("--deadline-ms", type=float, default=None, help="required in realtime mode")
    parser.add_argument("--fallback", choices=("repeat-last", "zero-control", "scripted"), default="repeat-last")
    parser.add_argument("--execution", choices=("pure-pursuit", "speed-setpoint"), default="pure-pursuit")
    parser.add_argument("--force-miss-at", type=int, action="append", default=[], help="realtime only: step index whose elapsed time is forced over the deadline (repeatable)")
    parser.add_argument("--decision-hz", type=int, default=None)
    parser.add_argument("--maps-dir", default=None, help="installed map corpus root (default: SIMFORGE_MAPS_CACHE_ROOT layout)")
    parser.add_argument("--out", default=None, help="trace JSONL path")
    parser.add_argument("--summary-out", default=None, help="also write the summary JSON here")
    # closed-loop model endpoint
    parser.add_argument("--endpoint-socket", default=None, help="policy endpoint unix socket (msgpack wire)")
    parser.add_argument("--camera-profile", default="alpamayo-4cam", help="authored rig preset feeding the model")
    parser.add_argument("--frame-source", default=None, help="dir:<path> | bevy:<rig.json>")
    parser.add_argument("--replan-hz", type=float, default=None, help="model replan cadence (ZOH between replans)")
    parser.add_argument("--num-traj-samples", type=int, default=None)
    parser.add_argument("--nav-text", default=None)
    parser.add_argument("--model-params", default=None, help="extra endpoint params as JSON")
    parser.add_argument("--model-family", default=None, help="expected endpoint family (refuses a mismatch)")
    parser.add_argument("--model-revision", default=None, help="expected endpoint revision")
    parser.add_argument("--model-quant", default=None, help="expected endpoint quantization")
    parser.add_argument("--plan-points", type=int, default=None, help="truncate the model plan to N waypoints")
    parser.add_argument("--allow-cold-start", action="store_true", help="permit a replicated oldest frame (stamped in provenance)")
    # warm-up and replay context
    parser.add_argument("--warmup-policy", choices=("scripted", "trajectory", "torch"), default=None, help="policy driving the history warm-up phase")
    parser.add_argument("--warmup-steps", type=int, default=0, help="decisions driven by the warm-up policy before the evaluated policy acts")
    parser.add_argument("--replay-context", default=None, help="simforge.replay-context/v1 bundle dir; enforces the validity envelope")
    args = parser.parse_args(argv)

    seed: int | str = int(args.seed) if args.seed.lstrip("-").isdigit() else args.seed
    cancellation = _Cancellation().install()
    resource: Any = None
    endpoint_policy: EndpointPolicy | None = None
    try:
        replay: ReplayContext | None = None
        monitor: EnvelopeMonitor | None = None
        if args.replay_context:
            replay = load_replay_context(args.replay_context)
            if args.policy == "endpoint":
                require_model_episode_admission(replay)
                require_profile_coverage(replay, profile_camera_map(args.camera_profile).values())
            monitor = EnvelopeMonitor(replay)
        warmup_policy = _make_policy(args.warmup_policy, args.policy_seed) if args.warmup_policy else None
        warmup_steps = int(args.warmup_steps)
        if args.policy == "endpoint" and warmup_policy is None and warmup_steps == 0:
            # The model needs 16 real ego poses and 4 real camera ticks; the
            # warm-up phase produces them instead of padding the observation.
            warmup_policy = _make_policy("scripted", args.policy_seed)
            warmup_steps = 16
        with SimForgeEnv(args.spec, session=args.session, decision_hz=args.decision_hz, maps_dir=args.maps_dir) as env:
            policy, resource = _build_policy(args, env, replay)
            endpoint_policy = policy if isinstance(policy, EndpointPolicy) else None
            summary = run_episode(
                env,
                policy,
                seed=seed,
                mode=args.mode,
                deadline_ms=args.deadline_ms,
                fallback=args.fallback,
                execution=args.execution,
                max_steps=args.steps,
                force_miss_at=tuple(args.force_miss_at),
                trace_path=args.out,
                warmup_policy=warmup_policy,
                warmup_steps=warmup_steps,
                envelope=monitor,
                # The stock replay MEASURES deviation; it is the gate that
                # decides whether an envelope may be written at all. Enforcing
                # a not-yet-measured (zero-width) envelope against it would
                # make G5 unrunnable by construction.
                enforce_envelope=args.policy != "recorded-path",
                cancellation=cancellation,
            )
    except (EndpointPolicyError, FrameSourceError, ReplayContextError) as error:
        payload = {
            "status": "failed",
            "error": {"code": getattr(error, "code", "runner_error"), "message": str(error), "detail": getattr(error, "detail", {})},
        }
        json.dump(payload, sys.stdout, sort_keys=True)
        sys.stdout.write("\n")
        return 2
    finally:
        cancellation.restore()
        if endpoint_policy is not None:
            endpoint_policy.close()
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
