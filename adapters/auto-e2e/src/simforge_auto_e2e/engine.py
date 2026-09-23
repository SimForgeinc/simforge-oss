"""Inference engine for Autoware Foundation ``Best_Model.pt``.

The checkpoint is a plain export from the working reference implementation,
not one of the public MLflow ``il_checkpoint_v2`` records.  Its constructor
metadata is read from the file, a name-and-shape probe is run, and only then is
``load_state_dict(strict=True)`` allowed.  This ordering is intentional: it
makes a mismatched upstream checkout fail before it can produce controls.
"""

from __future__ import annotations

import hashlib
import logging
import os
import time
from pathlib import Path
from typing import Any, Mapping

from simforge_auto_e2e import contract
from simforge_auto_e2e.checkpoint_probe import best_model_config, probe_state_dicts
from simforge_auto_e2e.contract import ModelConfig

logger = logging.getLogger("simforge_auto_e2e.engine")


class AutoE2EError(ValueError):
    """Typed, caller-facing adapter error."""

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
    """No strict-loadable trained checkpoint was supplied."""

    def __init__(self, message: str, **detail: Any):
        super().__init__("checkpoint_unavailable", message, **detail)


def _require_upstream() -> None:
    try:
        import model_components.auto_e2e  # noqa: F401
    except ModuleNotFoundError:
        raise AutoE2EError(
            "upstream_missing",
            "the upstream auto_e2e package is not importable; run "
            f"adapters/auto-e2e/scripts/setup.sh (pinned {contract.UPSTREAM_COMMIT})",
            repo=contract.UPSTREAM_REPO,
            commit=contract.UPSTREAM_COMMIT,
        ) from None


def _config_from_values(raw: Mapping[str, Any]) -> ModelConfig:
    values = dict(raw)
    for key in ("backbone", "planner_mode"):
        if not values.get(key):
            raise AutoE2EError(
                "checkpoint_invalid",
                f"checkpoint config does not record {key!r}; it determines parameter shapes",
                field=key,
            )
    if values["backbone"] not in contract.BACKBONES:
        raise AutoE2EError(
            "checkpoint_invalid",
            f"unknown backbone {values['backbone']!r}; expected one of {list(contract.BACKBONES)}",
        )
    if values["planner_mode"] not in contract.PLANNER_MODES:
        raise AutoE2EError(
            "checkpoint_invalid",
            f"unknown planner_mode {values['planner_mode']!r}; expected one of {list(contract.PLANNER_MODES)}",
        )
    known = set(ModelConfig.__dataclass_fields__)
    filtered = {key: value for key, value in values.items() if key in known}
    if filtered.get("view_fusion_kwargs") is not None:
        filtered["view_fusion_kwargs"] = dict(filtered["view_fusion_kwargs"])
    return ModelConfig(**filtered)


def config_from_checkpoint(raw: Mapping[str, Any]) -> ModelConfig:
    """Build a shape-authoritative config from either checkpoint format."""

    if "model" in raw or raw.get("checkpoint_format") == "autoware-best-model-v1":
        return _config_from_values(best_model_config(raw) if "model" in raw else raw)
    return _config_from_values(raw)


def load_checkpoint(path: str | os.PathLike[str]) -> tuple[dict[str, Any], ModelConfig]:
    """Load a Best_Model or legacy MLflow checkpoint descriptor.

    The return state dict is intentionally unmodified.  A strict probe and
    strict PyTorch load are performed by :meth:`AutoE2EEngine.load`.
    """

    import torch

    resolved = Path(path).expanduser()
    if not resolved.is_file():
        raise CheckpointUnavailable(f"no checkpoint at {resolved}", path=str(resolved))
    try:
        payload = torch.load(resolved, map_location="cpu", weights_only=False)
    except Exception as exc:  # noqa: BLE001
        raise AutoE2EError("checkpoint_invalid", f"could not read {resolved}: {exc}", path=str(resolved)) from exc
    if not isinstance(payload, Mapping):
        raise AutoE2EError("checkpoint_invalid", f"{resolved}: expected a mapping, got {type(payload).__name__}")

    if "model" in payload:
        required = ("model", "backbone", "num_views", "view_fusion_kwargs")
        missing = [key for key in required if key not in payload]
        if missing:
            raise AutoE2EError("checkpoint_invalid", f"{resolved}: Best_Model missing {missing}", missing=missing)
        state = payload["model"]
        if not isinstance(state, Mapping):
            raise AutoE2EError("checkpoint_invalid", f"{resolved}: `model` must be a mapping")
        config = config_from_checkpoint(payload)
    else:
        if payload.get("schema_version") != contract.CHECKPOINT_SCHEMA_VERSION:
            raise AutoE2EError(
                "checkpoint_invalid",
                f"{resolved}: unsupported schema {payload.get('schema_version')!r}; expected Best_Model.pt or "
                f"{contract.CHECKPOINT_SCHEMA_VERSION!r}",
                schemaVersion=payload.get("schema_version"),
            )
        missing = sorted(contract.CHECKPOINT_REQUIRED_FIELDS - set(payload))
        if missing:
            raise AutoE2EError("checkpoint_invalid", f"{resolved}: missing required fields {missing}", missing=missing)
        state = payload["model_state_dict"]
        config = config_from_checkpoint(payload["config"])
    return dict(state), config


def _build_model(config: ModelConfig):
    _require_upstream()
    from model_components.auto_e2e import AutoE2E

    kwargs = config.as_kwargs()
    # The plain Best_Model export was built with this explicit image feature
    # size and 8x8 BEV.  Keep the values in the descriptor, not in a caller's
    # command line, so the strict probe and actual model share one constructor.
    return AutoE2E(**kwargs)


def _tensor_shape(value: Any) -> tuple[int, ...]:
    return tuple(int(v) for v in getattr(value, "shape", ()))


class AutoE2EEngine:
    """Long-lived strict-loaded AutoE2E model."""

    def __init__(self, checkpoint_path: str | os.PathLike[str] | None = None, device: str = "cuda"):
        self.family = contract.FAMILY
        self.device = device
        self.checkpoint_path = str(checkpoint_path) if checkpoint_path is not None else None
        self.config: ModelConfig | None = None
        self.model = None
        self.checkpoint_digest: str | None = None
        self.load_seconds: float | None = None
        self.probe: dict[str, Any] | None = None
        self.checkpoint_epoch: int | None = None
        self._torch = None

    def load(self) -> None:
        import torch

        if self.checkpoint_path is None:
            raise CheckpointUnavailable(
                "AutoE2E requires the provisioned Best_Model.pt checkpoint; no path was supplied",
                expectedSha256=contract.BEST_MODEL_SHA256,
                expectedFilename=contract.BEST_MODEL_FILENAME,
                registry="MLflow",
                registryUri="http://mlflow.mlflow.svc.cluster.local:5000",
                registryReachablePublicly=False,
            )
        started = time.monotonic()
        state, config = load_checkpoint(self.checkpoint_path)
        digest = hashlib.sha256(Path(self.checkpoint_path).read_bytes()).hexdigest()
        if config.checkpoint_format == "autoware-best-model-v1" and digest != contract.BEST_MODEL_SHA256:
            raise AutoE2EError(
                "checkpoint_digest_mismatch",
                f"{self.checkpoint_path}: digest {digest} does not match the pinned Best_Model.pt",
                expected=contract.BEST_MODEL_SHA256,
                got=digest,
            )

        model = _build_model(config)
        report = probe_state_dicts(state, model.state_dict())
        self.probe = report.as_dict()
        if not report.loadable:
            raise AutoE2EError(
                "checkpoint_probe_failed",
                "strict checkpoint probe failed; refusing to run a partial or renamed model",
                probe=self.probe,
            )
        try:
            model.load_state_dict(state, strict=True)
        except Exception as exc:  # noqa: BLE001
            raise AutoE2EError(
                "checkpoint_load_failed",
                f"strict=True checkpoint load failed after a clean probe: {exc}",
                probe=self.probe,
            ) from exc
        model.eval()
        if self.device.startswith("cuda"):
            if not torch.cuda.is_available():
                raise AutoE2EError("no_cuda_device", "CUDA requested but no CUDA device is visible")
            model = model.to(self.device)
        elif self.device != "cpu":
            model = model.to(self.device)
        self.model = model
        self.config = config
        self.checkpoint_digest = digest
        self.checkpoint_epoch = contract.BEST_MODEL_EPOCH
        self.load_seconds = time.monotonic() - started
        self._torch = torch
        logger.info(
            "loaded %s epoch=%s (%s/%s) in %.2fs; probe=%s",
            contract.BEST_MODEL_FILENAME,
            self.checkpoint_epoch,
            config.backbone,
            config.planner_mode,
            self.load_seconds,
            report.verdict,
        )

    def info(self) -> dict[str, Any]:
        torch_version = None
        gpu = None
        if self._torch is not None:
            torch_version = self._torch.__version__
            if self._torch.cuda.is_available():
                gpu = self._torch.cuda.get_device_name(0)
        return {
            "service": "simforge-auto-e2e",
            "schema": "simforge.policy-endpoint/v2",
            "family": contract.FAMILY,
            "display_name": contract.DISPLAY_NAME,
            "quant": "fp32",
            "precision": "fp32",
            "code_repo": contract.UPSTREAM_REPO,
            "code_revision": contract.UPSTREAM_COMMIT,
            "code_pinned_by": contract.UPSTREAM_PINNED_BY,
            "checkpoint": contract.BEST_MODEL_FILENAME,
            "checkpoint_digest": self.checkpoint_digest,
            "checkpoint_epoch": self.checkpoint_epoch or contract.BEST_MODEL_EPOCH,
            "checkpoint_schema": self.config.checkpoint_format if self.config else None,
            "config": None if self.config is None else self.config.as_kwargs(),
            "loaded": self.model is not None,
            "status": "ok" if self.model is not None else "no-checkpoint",
            "load_seconds": self.load_seconds,
            "probe": self.probe,
            "torch": torch_version,
            "gpu": gpu,
            "capabilities": self.capabilities(),
            "supports": ["act"],
            "output_kind": contract.OUTPUT_KIND,
            "horizon_s": contract.HORIZON_SECONDS,
            "dt_s": 1.0 / contract.FUTURE_HZ,
        }

    def capabilities(self) -> dict[str, Any]:
        cfg = self.config
        views = cfg.num_views if cfg else contract.BEST_MODEL_NUM_VIEWS
        map_ch = cfg.map_context_channels if cfg else contract.BEST_MODEL_MAP_CONTEXT_CHANNELS
        return {
            "shapesFrom": "checkpoint" if cfg else "Best_Model descriptor",
            "cameras": {"count": views, "identified": False, "positional": True, "size": [256, 256]},
            "navigationRaster": {
                "required": True,
                "mapContextChannels": map_ch,
                "routeChannels": contract.BEST_MODEL_ROUTE_CHANNELS,
                "size": [256, 256],
                "geometry": contract.BEST_MODEL_NAVIGATION_GEOMETRY,
            },
            "egomotion": {
                "dim": contract.EGOMOTION_DIM,
                "timesteps": contract.HISTORY_TIMESTEPS,
                "signals": list(contract.EGOMOTION_SIGNALS),
                "units": dict(contract.EGOMOTION_UNITS),
                "layout": "timestep-major",
            },
            "visualHistory": {"dim": contract.VISUAL_HISTORY_DIM, "dead": True, "filled": "zeros"},
            "output": {
                "kind": contract.OUTPUT_KIND,
                "dim": contract.TRAJECTORY_DIM,
                "timesteps": contract.FUTURE_TIMESTEPS,
                "signals": list(contract.TRAJECTORY_SIGNALS),
                "integrator": "unicycle",
            },
            "geometryTypes": {"trained": [contract.BEST_MODEL_GEOMETRY], "scorable": False},
            "trajectory": True,
            "vqa": False,
            "nav": True,
            "textTasks": [],
        }

    def _vram(self) -> dict[str, float]:
        torch = self._torch
        if torch is None or not torch.cuda.is_available():
            return {}
        return {
            "allocated_gib": float(torch.cuda.memory_allocated() / 2**30),
            "max_allocated_gib": float(torch.cuda.max_memory_allocated() / 2**30),
            "reserved_gib": float(torch.cuda.memory_reserved() / 2**30),
        }

    def act(
        self,
        obs: dict[str, Any],
        seed: int = 0,
        scored: bool = True,
        initial_speed_mps: float | None = None,
    ) -> dict[str, Any]:
        """Run one strict model forward and integrate its 64 control pairs.

        ``result["path"]`` is the unicycle integration of ``result["controls"]``
        from ``initial_speed_mps`` (the newest history speed when omitted).
        """

        import torch

        from simforge_auto_e2e.obs import integrate_control, split_control, validate_observation

        if self.model is None or self.config is None:
            raise CheckpointUnavailable("engine is not loaded; call load() with Best_Model.pt first")
        provenance = validate_observation(obs, scored=scored, config=self.config)
        ego, mask_prov = contract.apply_history_masking(
            list(obs["egomotion_history"]),
            mask_latest_acceleration=self.config.mask_latest_history_acceleration,
        )
        provenance = {**provenance, "historyMasking": mask_prov}

        def tensor(value: Any, dtype: Any | None = None):
            result = torch.as_tensor(value, device=self.device)
            return result.to(dtype=dtype) if dtype is not None else result

        cameras = tensor(obs["camera_tiles"], torch.float32)
        if cameras.ndim == 4:
            cameras = cameras.unsqueeze(0)
        map_context = tensor(obs["map_context"], torch.float32)
        if map_context.ndim == 3:
            map_context = map_context.unsqueeze(0)
        route_mask = tensor(obs["route_mask"], torch.float32)
        if route_mask.ndim == 3:
            route_mask = route_mask.unsqueeze(0)
        ego_tensor = tensor(ego, torch.float32).reshape(1, contract.EGOMOTION_DIM)
        visual = torch.zeros((1, contract.VISUAL_HISTORY_DIM), dtype=torch.float32, device=self.device)
        map_valid = torch.as_tensor([bool(obs.get("map_valid", True))], dtype=torch.bool, device=self.device)
        route_valid = torch.as_tensor([bool(obs.get("route_valid", True))], dtype=torch.bool, device=self.device)

        torch.manual_seed(int(seed))
        if torch.cuda.is_available():
            torch.cuda.manual_seed_all(int(seed))
            torch.cuda.synchronize()
        started = time.perf_counter()
        with torch.inference_mode():
            flat = self.model(
                camera_tiles=cameras,
                map_context=map_context,
                visual_history=visual,
                egomotion_history=ego_tensor,
                route_mask=route_mask,
                map_valid=map_valid,
                route_valid=route_valid,
                projection=None,
                geometry_type=contract.BEST_MODEL_GEOMETRY,
                mode="infer",
            )
        if torch.cuda.is_available():
            torch.cuda.synchronize()
        elapsed = (time.perf_counter() - started) * 1e3
        if isinstance(flat, tuple):
            flat = flat[0]
        values = [float(v) for v in flat.reshape(-1).detach().cpu().tolist()]
        control = split_control(values)
        v0 = float(initial_speed_mps if initial_speed_mps is not None else ego[-4])
        result: dict[str, Any] = {
            "controls": [[a, c] for a, c in control],
            "signals": list(contract.TRAJECTORY_SIGNALS),
            "output_kind": contract.OUTPUT_KIND,
            "horizon_s": contract.HORIZON_SECONDS,
            "dt_s": 1.0 / contract.FUTURE_HZ,
            "seed": int(seed),
            "timings": {"inference_ms": elapsed},
            "vram": self._vram(),
            "input": provenance,
            "scorable": provenance["scorable"],
            "model": {
                "family": contract.FAMILY,
                "checkpoint": contract.BEST_MODEL_FILENAME,
                "checkpoint_digest": self.checkpoint_digest,
                "code_revision": contract.UPSTREAM_COMMIT,
                "config": self.config.as_kwargs(),
            },
        }
        result["path"] = integrate_control(control, v0)
        return result
