"""Model-endpoint policy: a real driving model in the closed loop.

The policy speaks the existing ``simforge.policy-endpoint/v2`` unix-socket
MessagePack wire (``simforge_alpamayo.client.AlpamayoClient``) — the same
engine process the open-loop HTTP facade fronts, so there is exactly one
inference engine and no second implementation. Frames never cross HTTP.

What this policy does per decision:

1. Captures one real camera tick from the episode's :mod:`frame source
   <simforge_oss_gym.frames>` and appends it to the rolling 4-frame window.
2. Builds the 16-step ego history from the engine's own recorded poses
   (never extrapolated, never zero-filled).
3. On a replan step, calls ``act`` and converts the returned 64 waypoints
   (10 Hz, ego frame at t0, FLU) into the policy_step trajectory action
   ``(K, 5)``; between replans it resends the byte-identical held plan so the
   executor's zero-order hold keeps the original anchor.
4. Records the endpoint's reasoning text, timings, VRAM and RNG provenance.

Everything the model needs must be real. A rig whose camera set violates the
family's declared ``capabilities.cameras`` is refused *before* the episode
starts; a missing frame source, an incomplete camera window or an incomplete
ego history is a typed failure, not a padded observation.
"""

from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass, field
from typing import Any, Mapping, Sequence

import numpy as np

from ..frames import (
    NUM_FRAMES_PER_CAMERA,
    NUM_HISTORY_STEPS,
    FrameSource,
    FrameSourceError,
    ObservationAssembler,
    ego_history_from_trail,
)
from .policies import PolicyDecision, trajectory

#: Alpamayo output cadence: 64 waypoints at 10 Hz = 6.4 s.
MODEL_DT_S = 0.1
MODEL_HORIZON_S = 6.4

#: Camera-index convention (upstream ``CAMERA_DISPLAY_NAMES``), mirrored from
#: ``packages/scenario/src/schema/v2/sensor-rigs.ts`` and the Alpamayo bridge.
CAMERA_INDEX: dict[str, int] = {
    "cross-left": 0,
    "front-wide": 1,
    "cross-right": 2,
    "rear-left": 3,
    "rear-tele": 4,
    "rear-right": 5,
    "front-tele": 6,
}

#: Authored rig presets -> sensor ids, camera-index ascending.
RIG_PROFILES: dict[str, tuple[str, ...]] = {
    "alpamayo-2cam": ("front-wide", "front-tele"),
    "alpamayo-4cam": ("cross-left", "front-wide", "cross-right", "front-tele"),
    "alpamayo-6cam": ("cross-left", "front-wide", "cross-right", "rear-left", "rear-right", "front-tele"),
    "alpamayo-6cam-vqa": ("cross-left", "front-wide", "cross-right", "rear-left", "rear-tele", "rear-right"),
}


class EndpointPolicyError(RuntimeError):
    """Typed endpoint-policy failure carrying a stable ledger code."""

    def __init__(self, code: str, message: str, detail: Mapping[str, Any] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.detail = dict(detail or {})


@dataclass(frozen=True)
class DecisionContext:
    """Everything a context-aware policy may read for one decision."""

    step: int
    t_s: float
    tick: int
    state_vector: np.ndarray | None
    #: ``(t_s, x, y, yaw_rad, speed_mps)`` world poses, oldest first, t0 last.
    ego_trail: Sequence[tuple[float, float, float, float, float]]
    info: Mapping[str, Any] = field(default_factory=dict)


def profile_camera_map(profile: str) -> dict[str, int]:
    sensors = RIG_PROFILES.get(profile)
    if sensors is None:
        raise EndpointPolicyError(
            "camera_profile_unknown",
            f"unknown rig profile {profile!r}; known: {sorted(RIG_PROFILES)}",
            {"known": sorted(RIG_PROFILES)},
        )
    return {sensor_id: CAMERA_INDEX[sensor_id] for sensor_id in sensors}


def waypoints_to_plan(
    waypoints: Sequence[Sequence[float]],
    *,
    dt_s: float = MODEL_DT_S,
    max_points: int | None = None,
) -> list[tuple[float, float, float, float, float]]:
    """Alpamayo waypoints -> policy_step trajectory rows.

    ``waypoints`` are ``[x, y, z]`` in the ego frame at t0 (FLU), 10 Hz,
    strictly future, first sample at ``dt_s``. Rows returned are
    ``(x, y, heading_rad, speed_mps, t_s)``: heading from the segment
    direction, speed from the segment length over ``dt_s`` — the same
    derivation the bridge documents. z is dropped (planar executor).
    """
    points = np.asarray(waypoints, dtype=np.float64)
    if points.ndim != 2 or points.shape[0] < 2 or points.shape[1] < 2:
        raise EndpointPolicyError(
            "model_output_invalid",
            f"expected at least two (x, y[, z]) waypoints, got shape {points.shape}",
        )
    if max_points is not None:
        points = points[:max_points]
    rows: list[tuple[float, float, float, float, float]] = []
    previous = np.zeros(2, dtype=np.float64)  # ego origin at t0
    for index in range(points.shape[0]):
        current = points[index, :2]
        delta = current - previous
        distance = float(math.hypot(delta[0], delta[1]))
        heading = float(math.atan2(delta[1], delta[0])) if distance > 1e-9 else (rows[-1][2] if rows else 0.0)
        rows.append((float(current[0]), float(current[1]), heading, distance / dt_s, (index + 1) * dt_s))
        previous = current
    return rows


class EndpointPolicy:
    """Drive the episode from a live model endpoint."""

    name = "endpoint"

    def __init__(
        self,
        client: Any,
        *,
        frame_source: FrameSource,
        camera_profile: str = "alpamayo-4cam",
        seed: int = 0,
        replan_every: int = 20,
        params: Mapping[str, Any] | None = None,
        nav_text: str | None = None,
        allow_cold_start: bool = False,
        expect_model: Mapping[str, str] | None = None,
        plan_points: int | None = None,
    ) -> None:
        self.client = client
        self.frame_source = frame_source
        self.camera_profile = camera_profile
        self.seed = int(seed)
        self.replan_every = max(1, int(replan_every))
        self.params = dict(params or {})
        self.nav_text = nav_text
        self.plan_points = plan_points
        self.hello = self._hello()
        self.capabilities = dict(self.hello.get("capabilities") or {})
        camera_map = profile_camera_map(camera_profile)
        self._validate_cameras(camera_map)
        self._validate_identity(expect_model)
        missing = [s for s in camera_map if s not in frame_source.sensor_ids]
        if missing:
            raise EndpointPolicyError(
                "frame_source_rig_mismatch",
                f"frame source has no cameras {missing} required by profile {camera_profile!r}",
                {"required": sorted(camera_map), "available": list(frame_source.sensor_ids)},
            )
        self.assembler = ObservationAssembler(camera_map, num_frames=NUM_FRAMES_PER_CAMERA, allow_cold_start=allow_cold_start)
        self.checkpoint_digest = str(
            self.hello.get("checkpoint_digest")
            or hashlib.sha256(
                f"{self.hello.get('family')}:{self.hello.get('revision')}:{self.hello.get('quant')}".encode()
            ).hexdigest()
        )
        self.model = {
            "family": self.hello.get("family"),
            "revision": self.hello.get("revision"),
            "quant": self.hello.get("quant"),
            "checkpointDigest": self.checkpoint_digest,
            "attn": self.hello.get("attn"),
            "torch": self.hello.get("torch"),
            "cuda": self.hello.get("cuda"),
            "gpu": self.hello.get("gpu"),
            "cameraProfile": camera_profile,
            "cameraIds": self.assembler.camera_ids(),
            "horizonS": self.hello.get("horizon_s", MODEL_HORIZON_S),
            "dtS": self.hello.get("dt_s", MODEL_DT_S),
            "numHistorySteps": self.hello.get("num_history_steps", NUM_HISTORY_STEPS),
            "framesPerCamera": self.hello.get("num_frames_per_camera", NUM_FRAMES_PER_CAMERA),
            "seed": self.seed,
            "replanEvery": self.replan_every,
            "params": dict(self.params),
            "navText": nav_text,
            "allowColdStart": bool(allow_cold_start),
        }
        self.rng_provenance: dict[str, Any] | None = None
        self.invocations = 0
        self.inference_ms: list[float] = []
        self.vram: dict[str, Any] | None = None
        self.cold_start_used = False
        self._held: dict[str, Any] | None = None
        self._last_reasoning: str | None = None
        #: Whether the most recent decision invoked the model (ZOH resend = False).
        self.last_replanned = False
        self._observed_step = -1

    # ----------------------------------------------------------- handshake

    def _hello(self) -> dict[str, Any]:
        try:
            response = self.client.hello()
        except Exception as error:  # transport failure is not a model verdict
            raise EndpointPolicyError("endpoint_unreachable", f"policy endpoint hello failed: {error}") from error
        if isinstance(response, Mapping) and "r" in response and "capabilities" not in response:
            response = dict(response["r"])
        if not isinstance(response, Mapping):
            raise EndpointPolicyError("endpoint_protocol_error", f"hello returned {type(response).__name__}")
        if response.get("ok") is False:
            raise EndpointPolicyError("endpoint_protocol_error", f"hello refused: {response.get('error')}")
        return dict(response)

    def _validate_cameras(self, camera_map: Mapping[str, int]) -> None:
        cameras = dict(self.capabilities.get("cameras") or {})
        requested = sorted(int(v) for v in camera_map.values())
        required = [int(v) for v in (cameras.get("required") or [])]
        variable = bool(cameras.get("variable", False))
        maximum = cameras.get("max")
        if required and not variable and requested != sorted(required):
            raise EndpointPolicyError(
                "camera_set_invalid",
                f"{self.hello.get('family')} requires cameras {sorted(required)}; profile "
                f"{self.camera_profile!r} supplies {requested}",
                {"required": sorted(required), "got": requested, "profile": self.camera_profile},
            )
        if variable and required:
            unmet = [c for c in required if c not in requested]
            if unmet:
                raise EndpointPolicyError(
                    "camera_set_invalid",
                    f"profile {self.camera_profile!r} is missing required cameras {unmet}",
                    {"required": sorted(required), "got": requested},
                )
        if maximum is not None and len(requested) > int(maximum):
            raise EndpointPolicyError(
                "camera_set_invalid",
                f"profile {self.camera_profile!r} supplies {len(requested)} cameras, endpoint accepts {maximum}",
                {"max": int(maximum), "got": requested},
            )
        if "act" not in (self.hello.get("supports") or ["act"]):
            raise EndpointPolicyError(
                "capability_error",
                f"endpoint {self.hello.get('family')} does not support the `act` op",
                {"supports": list(self.hello.get("supports") or [])},
            )

    def _validate_identity(self, expect: Mapping[str, str] | None) -> None:
        if not expect:
            return
        mismatched = {
            key: {"expected": value, "actual": self.hello.get(key)}
            for key, value in expect.items()
            if value and str(self.hello.get(key)) != str(value)
        }
        if mismatched:
            raise EndpointPolicyError(
                "model_revision_mismatch",
                f"endpoint identity does not match the requested model: {json.dumps(mismatched, sort_keys=True)}",
                mismatched,
            )

    # -------------------------------------------------------------- acting

    def act(self, step: int, state_vector: np.ndarray | None) -> PolicyDecision:
        raise EndpointPolicyError(
            "context_required",
            "the endpoint policy needs the decision context (frames + ego poses); the runner must call act_context",
        )

    def observe(self, ctx: DecisionContext) -> None:
        """Ingest this decision's camera tick without acting.

        The runner calls this on EVERY decision, including the warm-up phase
        driven by a reference policy: the model needs a full window of real
        frames at the instant it first acts, and frames only exist while the
        episode is running. Without it the first model decision would see a
        one-frame window and be refused (which is what it should do, but the
        warm-up exists precisely so that never happens).
        """
        if self._observed_step == ctx.step:
            return
        self.assembler.push(self.frame_source.capture(step=ctx.step, tick=ctx.tick, t_s=ctx.t_s))
        self._observed_step = ctx.step

    def act_context(self, ctx: DecisionContext) -> PolicyDecision:
        self.observe(ctx)
        if self._held is not None and ctx.step % self.replan_every != 0:
            self.last_replanned = False
            return PolicyDecision(self._held, None)
        self.last_replanned = True

        xyz, rot, times = ego_history_from_trail(ctx.ego_trail, steps=NUM_HISTORY_STEPS)
        obs = self.assembler.observation(xyz, rot, times, nav_text=self.nav_text)
        if obs.get("cold_start"):
            self.cold_start_used = True
        result = self._invoke(obs)
        trajectories = result.get("trajectories")
        if not trajectories:
            raise EndpointPolicyError("model_output_invalid", "endpoint returned no trajectories")
        rows = waypoints_to_plan(trajectories[0], dt_s=float(result.get("dt_s", MODEL_DT_S)), max_points=self.plan_points)
        reasoning_list = result.get("reasoning") or []
        reasoning = reasoning_list[0] if reasoning_list else None
        self._last_reasoning = reasoning
        self._held = trajectory(rows)
        return PolicyDecision(self._held, reasoning)

    def _invoke(self, obs: Mapping[str, Any]) -> dict[str, Any]:
        try:
            response = self.client.act(obs, seed=self.seed, **self.params)
        except FrameSourceError:
            raise
        except Exception as error:
            code = getattr(error, "code", None)
            if code:
                raise EndpointPolicyError(str(code), f"endpoint refused the observation: {error}", getattr(error, "detail", None)) from error
            raise EndpointPolicyError("endpoint_unreachable", f"endpoint act failed: {error}") from error
        result: Mapping[str, Any]
        if isinstance(response, Mapping) and "trajectories" in response:
            result = response  # client already unwrapped
        elif isinstance(response, Mapping):
            if response.get("ok") is False or "error" in response:
                error = dict(response.get("error") or {})
                raise EndpointPolicyError(
                    str(error.get("code") or "endpoint_protocol_error"),
                    str(error.get("message") or "endpoint refused the observation"),
                    error.get("detail"),
                )
            result = dict(response.get("result") or {})
        else:
            raise EndpointPolicyError("endpoint_protocol_error", f"act returned {type(response).__name__}")
        if not result:
            raise EndpointPolicyError("endpoint_protocol_error", "act returned an empty result")
        self.invocations += 1
        timings = dict(result.get("timings") or {})
        total = timings.get("total_ms") or timings.get("inference_ms")
        if total is not None:
            self.inference_ms.append(float(total))
        if result.get("vram"):
            self.vram = dict(result["vram"])
        if result.get("rng_provenance"):
            self.rng_provenance = dict(result["rng_provenance"])
        return dict(result)

    def provenance(self) -> dict[str, Any]:
        """Model identity + RNG provenance for the episode's provenance.json."""
        model = dict(self.model)
        model["rngProvenance"] = self.rng_provenance
        model["invocations"] = self.invocations
        model["vram"] = self.vram
        model["coldStartUsed"] = self.cold_start_used
        if self.inference_ms:
            samples = np.asarray(self.inference_ms)
            model["inferenceMs"] = {
                "p50": round(float(np.percentile(samples, 50)), 3),
                "p95": round(float(np.percentile(samples, 95)), 3),
                "max": round(float(samples.max()), 3),
            }
        # Seed identity is not a cross-GPU reproducibility claim.
        model["determinismScope"] = "same-host-same-device"
        return model

    def close(self) -> None:
        try:
            self.client.close()
        except Exception:  # a dead endpoint must not mask the episode result
            pass
