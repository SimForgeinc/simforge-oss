"""Autoware AutoE2E input/output contract, taken from upstream SOURCE.

Every constant here was read from the upstream implementation at the pinned
commit, not from prose. That distinction matters because the documentation and
the code DISAGREE on the egomotion signal set, and the code is what the
weights were trained against:

  Model/README.md says   "speed, acceleration, yaw angle and yaw angle rate"
  Model/data_parsing/kit_scenes/egomotion.py says
      _NUM_HISTORY_SIGNALS = 4  # speed, acceleration, yaw_rate, curvature
      egomotion_history (256,) = 64 timesteps x 4 signals
                                 [speed, acceleration, yaw_rate, curvature]

So the fourth signal is CURVATURE, not yaw angle, and there is no yaw-angle
channel at all. Packing a yaw angle into slot 3 because the README says so
would feed the model a wrongly-scaled channel and produce plausible garbage.
This module encodes the source order and refuses to guess.

Upstream references (autowarefoundation/auto_e2e @ 21f98c5209dd4058ea92f5734c29da1f34d1c558):
  Model/data_parsing/kit_scenes/egomotion.py   history/target packing
  Model/model_components/auto_e2e.py           constructor and forward
  Model/inference/run_forward_pass.py          the call shape
  Model/README.md                              prose (superseded where it conflicts)
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

#: Pinned upstream code. There is NO release or tag in this repository, so a
#: commit is the only immutable pin available and it is recorded as such.
UPSTREAM_REPO = "https://github.com/autowarefoundation/auto_e2e"
UPSTREAM_COMMIT = "21f98c5209dd4058ea92f5734c29da1f34d1c558"
UPSTREAM_LICENSE = "Apache-2.0"
UPSTREAM_PINNED_BY = "commit (no release or tag published upstream)"

FAMILY = "autoware-auto-e2e"
DISPLAY_NAME = "Autoware AutoE2E"

# -- cameras ---------------------------------------------------------------

#: Surround view. Unlike Alpamayo, camera identity is POSITIONAL here: the
#: model takes a (B, V, 3, H, W) stack plus a projection operator, and there
#: is no per-camera id channel, so the caller's view order IS the contract.
NUM_VIEWS = 7
CAMERA_HEIGHT = 256
CAMERA_WIDTH = 256

# -- navigation raster (REQUIRED) -----------------------------------------

#: The nav map is a rendered raster, not an HD map viewer and not optional.
#: A scored run may not substitute a blank or synthetic map.
MAP_CONTEXT_CHANNELS = 3
ROUTE_CHANNELS = 2
MAP_HEIGHT = 256
MAP_WIDTH = 256

# -- egomotion history ----------------------------------------------------

HISTORY_TIMESTEPS = 64
HISTORY_HZ = 10.0
HISTORY_SECONDS = HISTORY_TIMESTEPS / HISTORY_HZ  # 6.4 s

#: Source order, from egomotion.py. Flattened TIMESTEP-MAJOR: the upstream
#: loader does `history.flatten()` on a (64, 4) array, so the wire layout is
#: t0s0, t0s1, t0s2, t0s3, t1s0, ... NOT signal-major.
EGOMOTION_SIGNALS: tuple[str, ...] = ("speed", "acceleration", "yaw_rate", "curvature")
NUM_HISTORY_SIGNALS = len(EGOMOTION_SIGNALS)
EGOMOTION_DIM = HISTORY_TIMESTEPS * NUM_HISTORY_SIGNALS  # 256

#: Units, as derived by upstream from 6-DOF poses by finite differencing.
#: KIT Scenes stores no velocity/acceleration/curvature columns; upstream
#: derives all four from the pose sequence, so these are SI and unnormalised
#: at the dataset boundary.
EGOMOTION_UNITS: dict[str, str] = {
    "speed": "m/s",
    "acceleration": "m/s^2",
    "yaw_rate": "rad/s",
    "curvature": "1/m",
}

# -- visual history -------------------------------------------------------

#: 64 frames x 14-dim compressed scene memory. Produced by the World Action
#: Model branch; a caller without one has no honest value to supply, which is
#: why the engine refuses rather than zero-filling.
VISUAL_HISTORY_FRAMES = 64
VISUAL_HISTORY_PER_FRAME = 14
VISUAL_HISTORY_DIM = VISUAL_HISTORY_FRAMES * VISUAL_HISTORY_PER_FRAME  # 896

# -- output ---------------------------------------------------------------

FUTURE_TIMESTEPS = 64
FUTURE_HZ = 10.0
HORIZON_SECONDS = FUTURE_TIMESTEPS / FUTURE_HZ  # 6.4 s

#: Output signal order, from egomotion.py `_TARGET_IDX = [1, 3]` selecting
#: [acceleration, curvature] out of the four history signals.
TRAJECTORY_SIGNALS: tuple[str, ...] = ("acceleration", "curvature")
NUM_TARGET_SIGNALS = len(TRAJECTORY_SIGNALS)
TRAJECTORY_DIM = FUTURE_TIMESTEPS * NUM_TARGET_SIGNALS  # 128

#: This is the load-bearing product difference from Alpamayo. AutoE2E does NOT
#: predict positions: it predicts a CONTROL sequence (longitudinal
#: acceleration and path curvature) which must be integrated through a vehicle
#: model to obtain a path. Two consequences we must not paper over:
#:   * comparing it to an xyz-waypoint model requires integrating one or
#:     differentiating the other, and the integration needs the ego's initial
#:     speed and heading;
#:   * ADE/FDE computed after integration inherits the integrator's error, so
#:     an ADE figure for AutoE2E is not the same measurement as an ADE figure
#:     for Alpamayo even at identical horizons.
OUTPUT_KIND = "control-sequence"

GeometryType = Literal["pinhole", "rectified_pinhole", "ftheta", "pseudo"]

#: Upstream's own words for the no-projection fallback: "a learned spatial
#: prior, not real geometry (shape-testing and ablation only)". A scored run
#: must therefore supply a real projection operator; `pseudo` is refused.
GEOMETRY_TYPES_SCORABLE: tuple[str, ...] = ("pinhole", "rectified_pinhole", "ftheta")
GEOMETRY_TYPE_SHAPE_ONLY = "pseudo"

PLANNER_MODES: tuple[str, ...] = ("bezier", "flow_matching")
BACKBONES: tuple[str, ...] = ("swin_v2_tiny", "conv_next_v2_tiny", "res_net_50")


@dataclass(frozen=True)
class ModelConfig:
    """The training-time configuration a checkpoint must carry.

    These are constructor arguments to upstream `AutoE2E`, and a checkpoint's
    `state_dict` only loads into a model built with the SAME values. They are
    therefore part of the checkpoint prerequisite, not something a caller may
    choose: guessing `planner_mode` or `backbone` yields a shape mismatch at
    best and a silently wrong model at worst.
    """

    backbone: str
    planner_mode: str
    embed_dim: int = 256
    num_views: int = NUM_VIEWS
    num_timesteps: int = FUTURE_TIMESTEPS
    num_signals: int = NUM_TARGET_SIGNALS
    egomotion_dim: int = EGOMOTION_DIM
    visual_history_dim: int = VISUAL_HISTORY_DIM
    map_type: str = "rasterized"
    map_context_channels: int = MAP_CONTEXT_CHANNELS
    route_channels: int = ROUTE_CHANNELS
    enable_route_conditioning: bool = True
    map_fusion_mode: str = "residual"
    temporal_memory_mode: str = "no_memory"
    enable_world_model: bool = False
    enable_reasoning: bool = False
    reasoning_mode: str = "none"
    #: Whether the backbone was initialised from ImageNet weights. Recorded
    #: because it changes what `is_pretrained=True` downloads at build time;
    #: it is NOT the trained policy.
    is_pretrained: bool = True

    def as_kwargs(self) -> dict[str, object]:
        """Constructor kwargs for upstream `AutoE2E`."""
        return {
            "backbone": self.backbone,
            "num_views": self.num_views,
            "embed_dim": self.embed_dim,
            "is_pretrained": self.is_pretrained,
            "num_timesteps": self.num_timesteps,
            "num_signals": self.num_signals,
            "egomotion_dim": self.egomotion_dim,
            "visual_history_dim": self.visual_history_dim,
            "map_type": self.map_type,
            "map_context_channels": self.map_context_channels,
            "route_channels": self.route_channels,
            "enable_route_conditioning": self.enable_route_conditioning,
            "map_fusion_mode": self.map_fusion_mode,
            "temporal_memory_mode": self.temporal_memory_mode,
            "planner_mode": self.planner_mode,
            "enable_world_model": self.enable_world_model,
            "enable_reasoning": self.enable_reasoning,
            "reasoning_mode": self.reasoning_mode,
        }


#: Upstream checkpoint contract, from Platform/pipelines/training_checkpoint.py.
#: This is what an authorized checkpoint actually looks like, so the loader
#: validates against it rather than accepting any .pt file.
CHECKPOINT_SCHEMA_VERSION = "il_checkpoint_v2"
CHECKPOINT_REQUIRED_FIELDS: frozenset[str] = frozenset(
    {
        "schema_version",
        "model_state_dict",
        "optimizer_state_dict",
        "scheduler_state_dict",
        "scaler_state_dict",
        "rng_state",
        "epoch",
        "config",
        "training_state",
        "data_fingerprint",
    }
)

#: Where upstream keeps them: an MLflow tracking server addressed at an
#: in-cluster DNS name (Platform/HowToUseMLflow.md). That address is not
#: routable from outside the Autoware cluster, which is an ACCESS LIMITATION
#: rather than evidence that no checkpoint exists.
CHECKPOINT_REGISTRY = "MLflow"
CHECKPOINT_REGISTRY_URI = "http://mlflow.mlflow.svc.cluster.local:5000"
CHECKPOINT_REGISTRY_REACHABLE_PUBLICLY = False
