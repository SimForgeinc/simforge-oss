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
#:
#: THIS IS A DEFAULT, NOT THE CONTRACT. The checkpoint's own config is the
#: authority and real trained checkpoints disagree with the documentation:
#: registered model `auto-e2e-driving-policy` v63 was trained with
#: `model.num_views = 6` on KIT Scenes, while Model/README.md says 7. Always
#: read `ModelConfig.num_views` from the loaded checkpoint; never assume 7.
DEFAULT_NUM_VIEWS = 7
NUM_VIEWS = DEFAULT_NUM_VIEWS
CAMERA_HEIGHT = 256
CAMERA_WIDTH = 256

# -- navigation raster (REQUIRED) -----------------------------------------

#: The nav map is a rendered raster, not an HD map viewer and not optional.
#: A scored run may not substitute a blank or synthetic map.
#:
#: ALSO A DEFAULT. v63's config records `model.map_context_channels = 14`,
#: not the 3 the README implies, so the raster's channel count is a property
#: of the checkpoint's navigation geometry (v63:
#: `kitscenes-v3-bev-1m-v1`) rather than a constant. Read it from the config.
DEFAULT_MAP_CONTEXT_CHANNELS = 3
MAP_CONTEXT_CHANNELS = DEFAULT_MAP_CONTEXT_CHANNELS
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
    num_views: int = DEFAULT_NUM_VIEWS
    num_timesteps: int = FUTURE_TIMESTEPS
    num_signals: int = NUM_TARGET_SIGNALS
    egomotion_dim: int = EGOMOTION_DIM
    visual_history_dim: int = VISUAL_HISTORY_DIM
    map_type: str = "rasterized"
    map_context_channels: int = DEFAULT_MAP_CONTEXT_CHANNELS
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
    #: Per-signal output scales the model was trained with. The trajectory
    #: loss applies dataset-specific scales, so a consumer that ignores them
    #: mis-reads the head's output magnitude. v63:
    #: acceleration 0.778, curvature 0.035.
    acceleration_signal_scale: float | None = None
    curvature_signal_scale: float | None = None
    #: History-masking policy the checkpoint was trained with. v63: True.
    mask_latest_history_acceleration: bool = False

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


# -- known registered checkpoints -----------------------------------------

#: Public MLflow for the Autoware AutoE2E platform. NOT only in-cluster: the
#: in-cluster URI in Platform/HowToUseMLflow.md is the developer address, and
#: this CloudFront distribution serves the same registry publicly.
PUBLIC_MLFLOW = "https://d33520viyb0smg.cloudfront.net"
PUBLIC_CONSOLE = "https://d2itskdqq39tx1.cloudfront.net"
REGISTERED_MODEL = "auto-e2e-driving-policy"


@dataclass(frozen=True)
class RegisteredCheckpoint:
    """A checkpoint that provably exists in the public registry.

    Recorded so the product can name the exact artifact it needs rather than
    reporting a vague unavailability. `bytes_retrievable` is False when the
    metadata and config are public but the weight object itself is not
    served — which is the current state and is an ACCESS limitation, not
    absence.
    """

    version: str
    run_id: str
    s3_uri: str
    sha256: str
    epoch: int
    role: str
    num_views: int
    backbone: str
    fusion_mode: str
    validation_ade_m: float
    validation_fde_m: float
    eval_gate_pass: bool
    bytes_retrievable: bool
    config_retrievable: bool


#: Version 63, the current final checkpoint. Metadata and config.yaml are
#: publicly retrievable; the .pt is not (see below).
#: CORRECTION. I previously called this the training-code revision. It is
#: not. It appears only at `training.validation_split.source_revision` and
#: `validation.source_revision`, so it is the provenance of the VALIDATION
#: SPLIT MANIFEST, not of the model code. It being absent from the public
#: repo says nothing about the training code.
V63_VALIDATION_SPLIT_SOURCE_REVISION = "6fde0034446669e2ed7235e4c7fe323cd23d599d"

#: What the runs actually record about their code, checked exhaustively on
#: both the v35 and v63 runs: NOTHING resolvable. `mlflow.source.type` is
#: LOCAL and `mlflow.source.name` is /opt/conda/bin/pyflyte-execute; there is
#: no mlflow.source.git.commit, and a regex for any 40-hex string across both
#: complete run records returns zero matches. The only code identity recorded
#: anywhere is a MUTABLE Docker tag.
TRAINING_CODE_REVISION_RECORDED = False
TRAINING_IMAGE = "381491877296.dkr.ecr.us-west-2.amazonaws.com/auto-e2e/training:latest"
EVAL_IMAGE = "381491877296.dkr.ecr.us-west-2.amazonaws.com/auto-e2e/eval:latest"
#: Private registry: anonymous /v2/ and manifest requests both return 401.
TRAINING_IMAGE_PULLABLE = False
V63_NAVIGATION_GEOMETRY_ID = "kitscenes-v3-bev-1m-v1"
V63_BEV_PC_RANGE = (-85.5, -128.0, -5.0, 170.5, 128.0, 3.0)
V63_DATASET = "KIT-MRT/KITScenes-Multimodal"
V63_DATASET_VERSION = "v3.3"

#: Per-signal output scales this checkpoint was trained with
#: (acceleration, curvature). A consumer that ignores them mis-reads the
#: head's magnitude.
V63_SIGNAL_SCALES = (0.778, 0.035)

#: The newest acceleration sample in the egomotion history was MASKED during
#: training. Feeding a real value into that slot at inference is off
#: distribution, and nothing in the network can report that it happened, so
#: the adapter applies the same mask and records it.
V63_MASK_LATEST_HISTORY_ACCELERATION = True

V63 = RegisteredCheckpoint(
    version="63",
    run_id="8e238504ab354e7f8c7828acb8f51b1f",
    s3_uri=(
        "s3://auto-e2e-platform-checkpoints-381491877296/imitation-learning/"
        "8e238504ab354e7f8c7828acb8f51b1f/epoch-0020.pt"
    ),
    sha256="804c035a768e79ba0f626f946560601e7e26bdc4a37a17331eadc383507bbb5f",
    epoch=20,
    role="final",
    num_views=6,
    backbone="swin_v2_tiny",
    fusion_mode="bev",
    validation_ade_m=3.9544286981114913,
    validation_fde_m=11.04423553182655,
    # eval/gate_pass = 0.0 in the run's own metrics. THIS IS THE POINT: the
    # checkpoint exists and is READY in the registry, and it FAILS its own
    # evaluation gate. Availability is not quality. Offering it as a
    # qualified model would be the same error as publishing an unmeasured
    # VRAM envelope.
    eval_gate_pass=False,
    bytes_retrievable=False,
    config_retrievable=True,
)

#: Why the weights cannot be fetched today, recorded precisely.
#: Every public delivery path attempted, so the gate is a fact rather than an
#: impression. All four were tried; none yields the weight bytes.
CHECKPOINT_DELIVERY_PATHS_TRIED = (
    "GET /api/2.0/mlflow/model-versions/get-download-uri -> 200, but returns "
    "an s3:// URI rather than a presigned HTTP URL",
    "GET /get-artifact and /api/2.0/mlflow-artifacts/artifacts/... for the "
    ".pt -> 500 INTERNAL_ERROR; the server's own S3 read of the checkpoints "
    "bucket fails (the same endpoints serve config.yaml and "
    "training/metadata.json at 200, so the proxy itself works)",
    "S3 HEAD on the exact object -> 403 anonymously and 403 with the "
    "available authorized AWS profile",
    "DataModelConsole registry view -> declares itself 'Phase 1 - read-only' "
    "and offers no artifact download, only outbound links to the MLflow and "
    "Flyte UIs",
)

CHECKPOINT_ACCESS_NOTE = (
    "Registry metadata and the run's config.yaml are publicly retrievable "
    "from the MLflow distribution, but the checkpoint object is not: the "
    "artifact proxy returns INTERNAL_ERROR for the .pt because its own S3 "
    "read fails, and direct S3 HEAD on the object returns 403 both "
    "anonymously and with the available authorized AWS profile. The "
    "checkpoint therefore EXISTS and is identified by sha256 "
    "804c035a768e79ba0f626f946560601e7e26bdc4a37a17331eadc383507bbb5f; what "
    "is missing is authorized read access or a maintainer-provided export. "
    "This is an access prerequisite, not a missing artifact, and it must not "
    "be worked around by bypassing authentication."
)

#: A second, independent prerequisite that survives even if the weights
#: arrive: the checkpoint was produced by code that is not published.
TRAINING_CODE_ACCESS_NOTE = (
    "The published HEAD is not the code that trained the registered "
    "checkpoints - established by LOADING v35 and observing a renamed "
    "encoder, a module with no weights, a deleted pair and eight shape "
    "disagreements under identical names, NOT by inferring it from a "
    "revision string. The runs record no code revision at all: source type "
    "LOCAL, no git commit tag, no 40-hex identifier anywhere in either run "
    "record. Code identity exists only as the mutable tag "
    "auto-e2e/training:latest in a private ECR registry that returns 401 "
    "anonymously, and the public repository is a single squashed commit, so "
    "there is no historical revision to check out either."
)

#: The precise export that would unblock this, stated so it can be requested
#: rather than restated as a general impossibility. Any ONE of these closes
#: it; nothing else is needed.
AUTOE2E_EXPORT_NEEDED = (
    "1. The training-code revision that produced a registered checkpoint - "
    "either pushed to the public repository or supplied as a source archive "
    "- identified by the immutable digest of "
    "auto-e2e/training:latest rather than the tag.",
    "2. OR an authorized read of the ECR image by digest, from which the "
    "installed training package can be read directly.",
    "3. OR an authorized export of a v36+ checkpoint (checkpoints bucket, "
    "currently 403/500) TOGETHER with confirmation that it was trained by "
    "the published HEAD - v63's own config differs from HEAD in navigation "
    "raster width, so this needs confirming rather than assuming.",
)


def apply_history_masking(
    egomotion: list[float], *, mask_latest_acceleration: bool
) -> tuple[list[float], dict[str, Any]]:
    """Apply the checkpoint's own history-masking policy.

    v63 was trained with `mask_latest_history_acceleration = True`: the most
    recent acceleration sample is masked. Supplying a real value there is off
    distribution and undetectable downstream, so the mask is applied here and
    recorded in provenance rather than assumed by the caller.
    """
    if len(egomotion) != EGOMOTION_DIM:
        raise ValueError(
            f"egomotion history must be {EGOMOTION_DIM} values, got {len(egomotion)}"
        )
    if not mask_latest_acceleration:
        return list(egomotion), {"maskedLatestAcceleration": False}

    out = list(egomotion)
    # Timestep-major (64, 4); the newest timestep is last, acceleration is
    # signal index 1.
    idx = (HISTORY_TIMESTEPS - 1) * len(EGOMOTION_SIGNALS) + EGOMOTION_SIGNALS.index(
        "acceleration"
    )
    replaced = out[idx]
    out[idx] = 0.0
    return out, {
        "maskedLatestAcceleration": True,
        "maskedIndex": idx,
        "maskedValue": replaced,
        "reason": (
            "checkpoint trained with mask_latest_history_acceleration=True; "
            "an unmasked newest acceleration is off-distribution"
        ),
    }


# -- what we actually EXECUTED of the public path ------------------------

#: Upstream's documented consumer path is TRIAL.md: EC2 g5, clone, make
#: setup, make test. Its documented expected output is SHAPES, and
#: Model/inference/run_forward_pass.py feeds torch.randn/torch.rand for
#: camera tiles, map context, route mask, visual history, egomotion and the
#: projection matrix. It loads no checkpoint; there is no weight-download
#: step in the guide.
PUBLIC_DEMO_ENTRYPOINT = "Model/inference/run_forward_pass.py"
PUBLIC_DEMO_LOADS_WEIGHTS = False

#: EXECUTED, not read. Ran the entrypoint on CPU in an isolated env.
#: Deviations from the documented environment are stated because they are
#: the limits of this evidence: torch 2.14.0+cpu rather than the pinned
#: 2.12 installed via `make setup`, and a local CPU rather than an EC2 g5.
PUBLIC_DEMO_EXECUTION = {
    "ran": True,
    "device": "cpu",
    "configs_attempted": 2,
    "configs_completed": 1,
    # First config (bezier planner) printed a real forward-pass result.
    "completed": {
        "planner_mode": "bezier",
        "trajectory_shape": (2, 128),
        "printed": "COMPLETE",
    },
    # Second config crashed. This is a rank bug, not a torch-version
    # artifact: _project_bev calls bev_features.flatten(2) on a tensor that
    # arrives rank-2, so the [B, C, H, W] contract it documents is not what
    # it receives.
    "failed": {
        "planner_mode": "flow_matching",
        "error": "IndexError: Dimension out of range (expected to be in "
                 "range of [-2, 1], but got 2)",
        "site": "trajectory_planning/flow_matching_planner.py:290 _project_bev",
        "upstream_own_warning": (
            "reactive_e2e.py already warns flow_matching is NOT correctly "
            "trainable via the current train_il loop and says to use bezier"
        ),
    },
    # The guide's documented output also lists a [14] visual feature and
    # four [8,1440,7,7] future-feature tensors. Our run printed only the
    # trajectory, so the documented output was NOT reproduced in full.
    "documented_output_fully_reproduced": False,
}

#: The claim this evidence does and does not support. Kept explicit because
#: I previously asserted the stronger version from reading the docs alone.
PUBLIC_USABILITY_STATEMENT = (
    "ESTABLISHED: the public architecture runs. Upstream's documented "
    "demo entrypoint executed here and produced a (2, 128) trajectory from "
    "random inputs under its default bezier planner, and older trained "
    "checkpoints (registry versions 1-35) are retrievable through the "
    "documented MLflow route. NOT ESTABLISHED: a public path to TRAINED "
    "inference. The demo loads no weights, the retrievable checkpoints do "
    "not load into the published code, and the guide's full documented "
    "output was not reproduced - one of its two planner configurations "
    "crashes at HEAD. No claim is made that an arbitrary user can complete "
    "the documented flow on the documented environment, which we have not "
    "run."
)
