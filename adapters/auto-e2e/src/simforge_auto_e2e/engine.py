"""Autoware AutoE2E inference engine.

Deliberately NOT built on the Alpamayo engine. The two contracts differ in
ways that would make a shared base lie about one of them: AutoE2E takes seven
positional views rather than a camera-id set, a REQUIRED navigation raster,
a 256-dim egomotion vector rather than 16 poses, an 896-dim visual memory, a
projection OPERATOR rather than a camera matrix, and it emits a control
sequence rather than xyz waypoints.

This engine refuses to run without an authorized checkpoint. Upstream's
`Model/inference/run_forward_pass.py` instantiates the network with random
initialisation and feeds `torch.randn`, which proves tensor shapes and
nothing else; a trajectory from such a model is noise shaped like a
trajectory. Producing one and reporting it as inference is the specific
failure this module exists to prevent.
"""

from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path
from typing import Any

from simforge_auto_e2e import contract
from simforge_auto_e2e.contract import ModelConfig

logger = logging.getLogger("simforge_auto_e2e.engine")


class AutoE2EError(ValueError):
    """Typed, caller-facing refusal."""

    def __init__(self, code: str, message: str, **detail: Any):
        super().__init__(message)
        self.code = code
        self.message = message
        self.detail = detail

    def as_wire(self) -> dict[str, Any]:
        payload: dict[str, Any] = {"code": self.code, "message": self.message}
        if self.detail:
            payload["detail"] = self.detail
        return payload


class CheckpointUnavailable(AutoE2EError):
    """No authorized trained checkpoint is available.

    This is the current state of the world for AutoE2E, and it is reported as
    a missing prerequisite rather than worked around.
    """

    def __init__(self, message: str, **detail: Any):
        super().__init__("checkpoint_unavailable", message, **detail)


def _require_upstream() -> None:
    try:
        import model_components.auto_e2e  # noqa: F401
    except ModuleNotFoundError:
        raise AutoE2EError(
            "upstream_missing",
            "the upstream auto_e2e package is not importable. Vendor it with "
            f"scripts/setup.sh, which checks out {contract.UPSTREAM_REPO} at "
            f"{contract.UPSTREAM_COMMIT}.",
            repo=contract.UPSTREAM_REPO,
            commit=contract.UPSTREAM_COMMIT,
        ) from None


def load_checkpoint(path: str | os.PathLike[str]) -> tuple[dict[str, Any], ModelConfig]:
    """Load and validate an upstream `il_checkpoint_v2` checkpoint.

    Validates against the real upstream contract
    (Platform/pipelines/training_checkpoint.py) rather than accepting any
    `.pt` file, because a state_dict that loads into a differently-configured
    model is the failure mode that produces confident nonsense.

    Returns ``(state_dict, config)``.
    """
    import torch

    resolved = Path(path).expanduser()
    if not resolved.is_file():
        raise CheckpointUnavailable(
            f"no checkpoint at {resolved}", path=str(resolved)
        )

    payload = torch.load(resolved, map_location="cpu", weights_only=False)
    if not isinstance(payload, dict):
        raise AutoE2EError(
            "checkpoint_invalid",
            f"{resolved}: expected a checkpoint mapping, got "
            f"{type(payload).__name__}",
        )

    version = payload.get("schema_version")
    if version != contract.CHECKPOINT_SCHEMA_VERSION:
        raise AutoE2EError(
            "checkpoint_invalid",
            f"{resolved}: schema_version is {version!r}, expected "
            f"{contract.CHECKPOINT_SCHEMA_VERSION!r}. This adapter loads the "
            "upstream imitation-learning checkpoint contract; a bare "
            "state_dict does not carry the training config and cannot be "
            "loaded safely.",
            schemaVersion=version,
        )

    missing = sorted(contract.CHECKPOINT_REQUIRED_FIELDS - set(payload))
    if missing:
        raise AutoE2EError(
            "checkpoint_invalid",
            f"{resolved}: checkpoint is missing required fields {missing}",
            missing=missing,
        )

    raw_config = payload.get("config")
    if not isinstance(raw_config, dict):
        raise AutoE2EError(
            "checkpoint_invalid",
            f"{resolved}: `config` must be a mapping; without it the model "
            "cannot be constructed to match the weights",
        )
    config = config_from_checkpoint(raw_config)
    return payload["model_state_dict"], config


def config_from_checkpoint(raw: dict[str, Any]) -> ModelConfig:
    """Build a :class:`ModelConfig` from a checkpoint's recorded config.

    `backbone` and `planner_mode` have no defaults on purpose: they change the
    parameter shapes, so a checkpoint that does not record them cannot be
    loaded without guessing, and guessing here is indistinguishable from
    corruption.
    """
    for key in ("backbone", "planner_mode"):
        if not raw.get(key):
            raise AutoE2EError(
                "checkpoint_invalid",
                f"checkpoint config does not record {key!r}. It determines "
                "parameter shapes, so it cannot be defaulted.",
                field=key,
            )
    if raw["backbone"] not in contract.BACKBONES:
        raise AutoE2EError(
            "checkpoint_invalid",
            f"unknown backbone {raw['backbone']!r}; upstream offers "
            f"{list(contract.BACKBONES)}",
        )
    if raw["planner_mode"] not in contract.PLANNER_MODES:
        raise AutoE2EError(
            "checkpoint_invalid",
            f"unknown planner_mode {raw['planner_mode']!r}; upstream offers "
            f"{list(contract.PLANNER_MODES)}",
        )
    known = {field for field in ModelConfig.__dataclass_fields__}
    return ModelConfig(**{k: v for k, v in raw.items() if k in known})


class AutoE2EEngine:
    """Long-lived AutoE2E inference engine.

    ``checkpoint_path`` is REQUIRED. There is no random-init mode: an engine
    that cannot name the weights it is serving has nothing to serve.
    """

    def __init__(
        self,
        checkpoint_path: str | os.PathLike[str] | None = None,
        device: str = "cuda",
    ):
        self.family = contract.FAMILY
        self.device = device
        self.checkpoint_path = checkpoint_path
        self.config: ModelConfig | None = None
        self.model = None
        self.checkpoint_digest: str | None = None
        self.load_seconds: float | None = None

    # -- loading -----------------------------------------------------------

    def load(self) -> None:
        import hashlib

        # The refusal needs no torch: a host without the model stack still gets
        # the named checkpoint_unavailable error, not an ImportError.
        if self.checkpoint_path is None:
            raise CheckpointUnavailable(
                "AutoE2E requires a trained checkpoint and none was supplied. "
                "No checkpoint is published in the upstream repository (no "
                "release, no tag), none is on the AutowareFoundation Hugging "
                "Face org, and upstream keeps them in an MLflow registry at "
                f"{contract.CHECKPOINT_REGISTRY_URI}, which is an in-cluster "
                "address that is not reachable from outside Autoware's "
                "cluster. Supply an authorized checkpoint path to run this "
                "model. Upstream's run_forward_pass.py builds the network "
                "randomly initialised and feeds noise; it verifies tensor "
                "shapes and must never be reported as inference.",
                registry=contract.CHECKPOINT_REGISTRY,
                registryUri=contract.CHECKPOINT_REGISTRY_URI,
                registryReachablePublicly=contract.CHECKPOINT_REGISTRY_REACHABLE_PUBLICLY,
                upstreamRepo=contract.UPSTREAM_REPO,
                upstreamCommit=contract.UPSTREAM_COMMIT,
            )

        import torch

        _require_upstream()
        from model_components.auto_e2e import AutoE2E

        started = time.monotonic()
        state_dict, config = load_checkpoint(self.checkpoint_path)
        digest = hashlib.sha256(Path(self.checkpoint_path).read_bytes()).hexdigest()

        model = AutoE2E(**config.as_kwargs())
        # strict=True on purpose: a partial load is how a subtly wrong model
        # starts producing confident output.
        model.load_state_dict(state_dict, strict=True)
        model.eval()
        if self.device == "cuda":
            model = model.to("cuda")
            if not torch.cuda.is_available():
                raise AutoE2EError(
                    "no_cuda_device", "device 'cuda' requested but no CUDA device is visible"
                )

        self.model = model
        self.config = config
        self.checkpoint_digest = digest
        self.load_seconds = time.monotonic() - started
        logger.info(
            "loaded AutoE2E (%s / %s) in %.1fs",
            config.backbone,
            config.planner_mode,
            self.load_seconds,
        )

    # -- identity ----------------------------------------------------------

    def info(self) -> dict[str, Any]:
        try:
            import torch
        except ModuleNotFoundError:  # a host without the model stack: say so
            torch = None

        return {
            "service": "simforge-auto-e2e",
            "schema": "simforge.policy-endpoint/v2",
            "family": contract.FAMILY,
            "display_name": contract.DISPLAY_NAME,
            "code_repo": contract.UPSTREAM_REPO,
            "code_revision": contract.UPSTREAM_COMMIT,
            "code_pinned_by": contract.UPSTREAM_PINNED_BY,
            "checkpoint_digest": self.checkpoint_digest,
            "checkpoint_schema": contract.CHECKPOINT_SCHEMA_VERSION,
            "config": None if self.config is None else self.config.as_kwargs(),
            "loaded": self.model is not None,
            "status": "ok" if self.model is not None else "no-checkpoint",
            "load_seconds": self.load_seconds,
            "torch": None if torch is None else torch.__version__,
            "gpu": torch.cuda.get_device_name(0) if torch is not None and torch.cuda.is_available() else None,
            "capabilities": self.capabilities(),
            "supports": ["act"],
            "output_kind": contract.OUTPUT_KIND,
            "horizon_s": contract.HORIZON_SECONDS,
            "dt_s": 1.0 / contract.FUTURE_HZ,
        }

    def capabilities(self) -> dict[str, Any]:
        # The loaded checkpoint's own config is the authority; the documented
        # defaults are only a fallback for an unloaded engine, and they are
        # known to disagree with real checkpoints (v63: 6 views, 14 map
        # channels vs the README's 7 and 3). Advertising the wrong view count
        # on a positional-camera model would mis-assign every view.
        cfg = self.config
        views = cfg.num_views if cfg else contract.DEFAULT_NUM_VIEWS
        map_ch = cfg.map_context_channels if cfg else contract.DEFAULT_MAP_CONTEXT_CHANNELS
        return {
            "shapesFrom": "checkpoint" if cfg else "documented-default",
            "cameras": {
                # Positional, not identified: view ORDER is the contract and
                # there is no camera-id channel to validate against.
                "count": views,
                "identified": False,
                "positional": True,
                "size": [contract.CAMERA_WIDTH, contract.CAMERA_HEIGHT],
            },
            "navigationRaster": {
                "required": True,
                "mapContextChannels": map_ch,
                "routeChannels": contract.ROUTE_CHANNELS,
                "size": [contract.MAP_WIDTH, contract.MAP_HEIGHT],
            },
            "egomotion": {
                "dim": contract.EGOMOTION_DIM,
                "timesteps": contract.HISTORY_TIMESTEPS,
                "signals": list(contract.EGOMOTION_SIGNALS),
                "units": dict(contract.EGOMOTION_UNITS),
                "layout": "timestep-major",
            },
            "visualHistory": {
                "dim": contract.VISUAL_HISTORY_DIM,
                "frames": contract.VISUAL_HISTORY_FRAMES,
                "perFrame": contract.VISUAL_HISTORY_PER_FRAME,
            },
            "output": {
                "kind": contract.OUTPUT_KIND,
                "dim": contract.TRAJECTORY_DIM,
                "timesteps": contract.FUTURE_TIMESTEPS,
                "signals": list(contract.TRAJECTORY_SIGNALS),
            },
            "geometryTypes": {
                "scorable": list(contract.GEOMETRY_TYPES_SCORABLE),
                "shapeOnly": contract.GEOMETRY_TYPE_SHAPE_ONLY,
            },
            "trajectory": False,
            "vqa": False,
            "nav": True,
            "textTasks": [],
        }

    # -- inference ---------------------------------------------------------

    def act(
        self,
        obs: dict[str, Any],
        seed: int = 0,
        scored: bool = True,
        initial_speed_mps: float | None = None,
    ) -> dict[str, Any]:
        """One forward pass: observation -> control sequence (+ derived path).

        `scored` defaults to True, so the strict geometry rule applies unless
        a caller explicitly asks for a shape-only run. That default is
        deliberate: the permissive path should be the one you have to ask for.
        """
        if self.model is None:
            raise CheckpointUnavailable(
                "engine is not loaded; AutoE2E requires an authorized trained "
                "checkpoint before it can produce a trajectory"
            )
        import torch

        from simforge_auto_e2e.obs import integrate_control, split_control, validate_observation
        provenance = validate_observation(obs, scored=scored, config=self.config)

        # Apply the checkpoint's own history-masking policy before inference.
        # v63 was trained with the newest acceleration masked; an unmasked
        # value is off-distribution and nothing downstream can detect it.
        ego, mask_prov = contract.apply_history_masking(
            list(obs["egomotion_history"]),
            mask_latest_acceleration=bool(
                self.config and self.config.mask_latest_history_acceleration
            ),
        )
        obs = {**obs, "egomotion_history": ego}
        provenance = {**provenance, "historyMasking": mask_prov}

        torch.manual_seed(seed)
        if torch.cuda.is_available():
            torch.cuda.manual_seed_all(seed)

        started = time.monotonic()
        with torch.no_grad():
            flat = self.model(
                camera_tiles=obs["camera_tiles"],
                map_context=obs["map_context"],
                visual_history=obs["visual_history"],
                egomotion_history=obs["egomotion_history"],
                route_mask=obs["route_mask"],
                map_valid=obs.get("map_valid"),
                route_valid=obs.get("route_valid"),
                projection=obs.get("projection"),
                geometry_type=provenance["geometry_type"],
                mode="infer",
            )
        elapsed = (time.monotonic() - started) * 1e3

        values = [float(v) for v in flat.reshape(-1).tolist()]
        control = split_control(values)
        result: dict[str, Any] = {
            "control": [{"acceleration_mps2": a, "curvature_inv_m": c} for a, c in control],
            "signals": list(contract.TRAJECTORY_SIGNALS),
            "output_kind": contract.OUTPUT_KIND,
            "horizon_s": contract.HORIZON_SECONDS,
            "dt_s": 1.0 / contract.FUTURE_HZ,
            "seed": seed,
            "timings": {"inference_ms": elapsed},
            "input": provenance,
            "scorable": provenance["scorable"],
            "model": {
                "family": contract.FAMILY,
                "checkpoint_digest": self.checkpoint_digest,
                "code_revision": contract.UPSTREAM_COMMIT,
                "config": None if self.config is None else self.config.as_kwargs(),
            },
        }
        # A path is only produced when the caller supplies the initial speed
        # the integration needs. Assuming a speed would fabricate the shape of
        # the trajectory, so its absence yields no path rather than a guess.
        if initial_speed_mps is None:
            result["path"] = None
            result["path_unavailable_reason"] = (
                "initial_speed_mps was not supplied. AutoE2E predicts controls, "
                "so an xy path requires the ego's speed at t0; assuming one "
                "would fabricate the trajectory's shape."
            )
        else:
            result["path"] = integrate_control(control, initial_speed_mps)
        return result
