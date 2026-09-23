"""Strict compatibility probes for AutoE2E checkpoints.

The public MLflow v35/v63 exports and the locally provisioned Autoware
``Best_Model.pt`` are different checkpoint formats.  This module deliberately
compares *names and shapes* before inference.  A permissive key-set check can
miss an architecture mismatch and leave a model producing plausible garbage;
the engine therefore treats a clean probe as a load gate and still performs a
``strict=True`` PyTorch load afterwards.

No torch import occurs at module import time.  The pure mapping probe remains
usable in the adapter's lightweight test environment.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping

# Historical public-checkpoint evidence is retained because it documents why
# this adapter does not use the public MLflow model.  It is not the descriptor
# for Best_Model.pt.
KNOWN_PLANNER_MISMATCHES = {
    "Reactive_E2E.MapEncoder._backbone.patch_embed.proj.weight": ((96, 3, 4, 4), (96, 5, 4, 4)),
    "Reactive_E2E.TrajectoryPlanner.visual_history_proj.weight": ((256, 896), (896, 896)),
    "Reactive_E2E.TrajectoryPlanner.visual_history_proj.bias": ((256,), (896,)),
    "Reactive_E2E.TrajectoryPlanner.context_mlp.0.weight": ((256, 256), (2451, 4902)),
    "Reactive_E2E.TrajectoryPlanner.context_mlp.0.bias": ((256,), (2451,)),
    "Reactive_E2E.TrajectoryPlanner.context_mlp.2.weight": ((256, 256), (2451, 2451)),
    "Reactive_E2E.TrajectoryPlanner.context_mlp.2.bias": ((256,), (2451,)),
    "Reactive_E2E.TrajectoryPlanner.control_head.weight": ((10, 256), (10, 2451)),
}

OBSERVED_NAV_ENCODER_INPUTS = {
    "v35-checkpoint-weights": (3, 3, 0),
    "published-head-default": (5, 3, 2),
    "v63-config": (16, 14, 2),
}

NAV_RASTER_FINDING = (
    "The map raster width is a property of the checkpoint's navigation "
    "geometry rather than a constant: 3 channels for v35, 14 for v63. Route "
    "conditioning is separately optional and postdates v35, which accounts "
    "for the published default's 5 = 3 + 2. A caller must take both widths "
    "from the loaded checkpoint's config and cannot synthesise a raster of a "
    "guessed width - but my earlier framing of 'three contradictory widths' "
    "overstated it."
)

NO_KWARG_RECONCILIATION = (
    "The published BezierPlanner hardcodes visual_history_proj as "
    "Linear(visual_history_dim, visual_history_dim) and derives context_mlp "
    "from feature_dim + egomotion_dim + visual_history_dim. Reproducing the "
    "checkpoint's 256-wide planner context would require a negative "
    "feature_dim, so no legitimate constructor argument reconciles them. The "
    "prerequisite is the training revision, not a different config."
)

KNOWN_RENAMES = (("Reactive_E2E.MapEncoder.", "Reactive_E2E.NavigationEncoder."),)


@dataclass
class ProbeReport:
    """Structured verdict for one checkpoint against one constructed model."""

    tensors_in_checkpoint: int
    tensors_in_model: int
    missing: list[str] = field(default_factory=list)
    unexpected: list[str] = field(default_factory=list)
    shape_mismatches: dict[str, tuple[tuple[int, ...], tuple[int, ...]]] = field(default_factory=dict)
    renamed: dict[str, str] = field(default_factory=dict)

    @property
    def loadable(self) -> bool:
        # A rename is not loadable AS-IS: strict=True would reject it.
        return not (self.missing or self.unexpected or self.shape_mismatches or self.renamed)

    @property
    def remappable(self) -> bool:
        return bool(self.renamed) and not (self.missing or self.unexpected or self.shape_mismatches)

    @property
    def verdict(self) -> str:
        if self.loadable:
            return "compatible"
        if self.remappable:
            return "compatible-after-rename"
        if self.shape_mismatches and not self.missing and not self.unexpected:
            return "incompatible-same-names"
        return "incompatible"

    def as_dict(self) -> dict[str, Any]:
        return {
            "schema": "simforge.autoe2e-checkpoint-probe/v1",
            "verdict": self.verdict,
            "loadable": self.loadable,
            "tensorsInCheckpoint": self.tensors_in_checkpoint,
            "tensorsInModel": self.tensors_in_model,
            "remappable": self.remappable,
            "renamed": dict(sorted(self.renamed.items())),
            "missing": sorted(self.missing),
            "unexpected": sorted(self.unexpected),
            "shapeMismatches": {
                k: {"checkpoint": list(c), "model": list(m)}
                for k, (c, m) in sorted(self.shape_mismatches.items())
            },
            "note": None if self.loadable else NO_KWARG_RECONCILIATION,
        }


def _shape(value: Any) -> tuple[int, ...]:
    raw = getattr(value, "shape", ())
    return tuple(int(v) for v in raw)


def probe_state_dicts(checkpoint: Mapping[str, Any], model: Mapping[str, Any]) -> ProbeReport:
    """Compare two state dicts by name and tensor shape."""

    report = ProbeReport(len(checkpoint), len(model))

    def resolve(name: str) -> str | None:
        if name in model:
            return name
        for old, new in KNOWN_RENAMES:
            if name.startswith(old):
                candidate = new + name[len(old):]
                if candidate in model:
                    return candidate
        return None

    matched: set[str] = set()
    for name, tensor in checkpoint.items():
        target = resolve(name)
        if target is None:
            report.unexpected.append(name)
            continue
        matched.add(target)
        if target != name:
            report.renamed[name] = target
        ck_shape, model_shape = _shape(tensor), _shape(model[target])
        if ck_shape != model_shape:
            report.shape_mismatches[name] = (ck_shape, model_shape)
    report.missing.extend(name for name in model if name not in matched)
    return report


def best_model_config(payload: Mapping[str, Any]) -> dict[str, Any]:
    """Validate and return the measured ``Best_Model.pt`` descriptor.

    The export is intentionally a small plain mapping (no MLflow schema): its
    ``model`` state dict is paired with the constructor metadata below.  Every
    value affecting parameter shapes is explicit; no caller-supplied guess is
    accepted by the engine.
    """

    required = ("model", "backbone", "num_views", "view_fusion_kwargs")
    missing = [key for key in required if key not in payload]
    if missing:
        raise ValueError(f"Best_Model checkpoint missing descriptor fields: {missing}")
    if not isinstance(payload["model"], Mapping):
        raise ValueError("Best_Model checkpoint field `model` must be a state_dict mapping")
    if int(payload["num_views"]) != 6:
        raise ValueError(f"Best_Model descriptor num_views must be 6, got {payload['num_views']!r}")
    if payload["backbone"] != "swin_v2_tiny":
        raise ValueError(f"unsupported Best_Model backbone {payload['backbone']!r}")
    return {
        "checkpoint_format": "autoware-best-model-v1",
        "checkpoint_id": "Best_Model.pt",
        "backbone": str(payload["backbone"]),
        "num_views": int(payload["num_views"]),
        "embed_dim": 256,
        "image_feature_size": 8,
        "view_fusion_kwargs": dict(payload["view_fusion_kwargs"]),
        "num_timesteps": 64,
        "num_signals": 2,
        "egomotion_dim": 256,
        "visual_history_dim": 896,
        "map_type": "rasterized",
        "map_context_channels": 14,
        "route_channels": 2,
        "enable_route_conditioning": True,
        "map_fusion_mode": "residual",
        "temporal_memory_mode": "no_memory",
        "planner_mode": "bezier",
        "enable_world_model": False,
        "enable_reasoning": False,
        "reasoning_mode": "none",
        "is_pretrained": False,
        "geometry_type": "pseudo",
        "navigation_geometry": "kitscenes-v3-bev-1m-v1",
        "epoch": int(payload.get("epoch", 28)),
        "trajectory_training_policy": dict(payload.get("trajectory_training_policy") or {}),
    }
