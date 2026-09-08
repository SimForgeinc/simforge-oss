"""Compatibility probe for a real AutoE2E checkpoint.

Why this exists. The registered checkpoints are real and, for the older
versions, publicly retrievable. But the published repository is a single
squashed commit, and the code that trained the checkpoints is NOT it. The
failure that follows is the dangerous kind: every parameter NAME matches, so
a permissive load reports success while several planner tensors are silently
left at their initial values, and the model then returns plausible garbage.

This probe makes that verdict explicit instead. It compares a checkpoint's
state_dict against a constructed model and reports, per tensor, whether the
name is absent, present-but-differently-shaped, or loadable. A checkpoint is
declared usable only when nothing is missing, nothing is unexpected and every
shape agrees.

MEASURED against registered model `auto-e2e-driving-policy` v35
(sha256 2890f90f9b4bcbb0eed0d2daa14d21fe062990aed2bac3e051777b0934b42060,
1004 tensors, 160.98 M parameters), built from the checkpoint's OWN recorded
config, and with the rename below applied: 219 renamed, 2 missing, 4
unexpected, 8 shape mismatches. Verdict: incompatible.

The divergence has four distinct causes, which the probe separates because
they need different answers:

1. A RENAME. 219 tensors are `Reactive_E2E.MapEncoder.*` in the checkpoint
   and `Reactive_E2E.NavigationEncoder.*` in the published code, shapes
   agreeing throughout. Remappable without inventing a value.
2. A NEW module. `Reactive_E2E.FusedFeaturePooling.reduce_channels` exists
   only in the published code and has no checkpoint weights. Not
   remappable: there is nothing to load.
3. A DELETED pair. The checkpoint's `TrajectoryPlanner.ego_state_proj` and
   `.bev_proj` have no published counterpart.
4. REWIRED shapes. Eight tensors share a name and disagree on shape.
   CORRECTION to an earlier note of mine: `load_state_dict(strict=False)`
   does NOT silently ignore these - it raises RuntimeError on a size
   mismatch just as strict=True does. The real hazard is narrower and worth
   stating precisely: code that inspects only the returned
   missing_keys/unexpected_keys, or that compares key sets itself, sees
   perfect agreement. This probe therefore compares shapes as well as
   names. Seven are the planner. The eighth is the
   navigation raster's input width: the checkpoint's map backbone takes a
   3-channel raster, the published code expects 5, and v63's config records
   14. Three different widths for the same input, which is exactly why this
   adapter refuses to synthesise a raster.

No network access, no torch import at module level: the probe is importable
and testable without either.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

#: The exact planner tensors that disagree between the published HEAD and the
#: registered checkpoints, with both shapes. Recorded from a real load, not
#: predicted.
KNOWN_PLANNER_MISMATCHES = {
    # Not the planner: the navigation raster's channel width. Kept in this
    # table because it is measured from the same load.
    "Reactive_E2E.MapEncoder._backbone.patch_embed.proj.weight": ((96, 3, 4, 4), (96, 5, 4, 4)),
    "Reactive_E2E.TrajectoryPlanner.visual_history_proj.weight": ((256, 896), (896, 896)),
    "Reactive_E2E.TrajectoryPlanner.visual_history_proj.bias": ((256,), (896,)),
    "Reactive_E2E.TrajectoryPlanner.context_mlp.0.weight": ((256, 256), (2451, 4902)),
    "Reactive_E2E.TrajectoryPlanner.context_mlp.0.bias": ((256,), (2451,)),
    "Reactive_E2E.TrajectoryPlanner.context_mlp.2.weight": ((256, 256), (2451, 2451)),
    "Reactive_E2E.TrajectoryPlanner.context_mlp.2.bias": ((256,), (2451,)),
    "Reactive_E2E.TrajectoryPlanner.control_head.weight": ((10, 256), (10, 2451)),
}

#: Why no constructor argument fixes it, so nobody re-derives this by hand.
#: The published planner builds `Linear(visual_history_dim, visual_history_dim)`
#: with no way to target embed_dim, and its `context_mlp` input is
#: `feature_dim + egomotion_dim + visual_history_dim`, so reaching the
#: checkpoint's 256 would require `feature_dim = 256 - 256 - 896`, i.e. a
#: negative width. The checkpoint projected each stream down to embed_dim
#: before concatenating; the published code concatenates raw features and
#: halves. That is an architecture change, not a hyperparameter.
#: Observed navigation-raster channel widths, all three from primary sources.
#: No default is safe; the loaded checkpoint decides.
OBSERVED_MAP_CHANNEL_WIDTHS = {
    "v35-checkpoint-weights": 3,
    "published-head-code": 5,
    "v63-config": 14,
}

NO_KWARG_RECONCILIATION = (
    "The published BezierPlanner hardcodes visual_history_proj as "
    "Linear(visual_history_dim, visual_history_dim) and derives context_mlp "
    "from feature_dim + egomotion_dim + visual_history_dim. Reproducing the "
    "checkpoint's 256-wide planner context would require a negative "
    "feature_dim, so no legitimate constructor argument reconciles them. The "
    "prerequisite is the training revision, not a different config."
)


#: The rename observed between the checkpoint and the published code. A
#: probe that ignored it would report 219 unrelated-looking differences and
#: bury the three that actually matter.
KNOWN_RENAMES = (("Reactive_E2E.MapEncoder.", "Reactive_E2E.NavigationEncoder."),)


@dataclass
class ProbeReport:
    """Structured verdict for one checkpoint against one constructed model."""

    tensors_in_checkpoint: int
    tensors_in_model: int
    missing: list[str] = field(default_factory=list)
    unexpected: list[str] = field(default_factory=list)
    shape_mismatches: dict[str, tuple[tuple[int, ...], tuple[int, ...]]] = field(
        default_factory=dict
    )
    #: checkpoint name -> model name, same shape, differing only by a known
    #: module rename. Remappable without inventing a single value.
    renamed: dict[str, str] = field(default_factory=dict)

    @property
    def loadable(self) -> bool:
        """True only when a STRICT load of the checkpoint AS-IS would succeed.

        Renames count against this. A renamed tensor is one `strict=True`
        would reject, so reporting `loadable` while 219 names need remapping
        would be the same class of lie the probe exists to prevent.
        """
        return not (
            self.missing or self.unexpected or self.shape_mismatches or self.renamed
        )

    @property
    def remappable(self) -> bool:
        """True when renames are the ONLY obstacle.

        Distinguishes a checkpoint that a name map would rescue from one that
        needs weights nobody has.
        """
        return bool(self.renamed) and not (
            self.missing or self.unexpected or self.shape_mismatches
        )

    @property
    def verdict(self) -> str:
        if self.loadable:
            return "compatible"
        if self.remappable:
            return "compatible-after-rename"
        if self.shape_mismatches and not self.missing and not self.unexpected:
            # The dangerous case: a permissive load looks like it worked.
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


def probe_state_dicts(
    checkpoint: dict[str, Any], model: dict[str, Any]
) -> ProbeReport:
    """Compare two state_dicts by name AND shape.

    Takes plain mappings of name -> object with a `.shape`, so this is
    testable without torch. Shape comparison is the point: name-only
    agreement is exactly what makes the published-HEAD load look successful.
    """
    report = ProbeReport(len(checkpoint), len(model))

    def resolve(name: str) -> str | None:
        """Map a checkpoint name onto a model name, renames included."""
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
        ck_shape = tuple(getattr(tensor, "shape", ()))
        m_shape = tuple(getattr(model[target], "shape", ()))
        if ck_shape != m_shape:
            report.shape_mismatches[name] = (ck_shape, m_shape)
    report.missing.extend(name for name in model if name not in matched)
    return report


def probe_checkpoint_file(path: str, build_model) -> ProbeReport:
    """Probe a real .pt against a model built from the checkpoint's OWN config.

    `build_model` receives the checkpoint's recorded config dict and must
    return a torch module. The checkpoint's config is used rather than any
    caller-supplied guess: v35 records `reasoning_mode: pooled_latent`, and a
    guess of `horizon` raises before a single tensor is compared.
    """
    import torch

    blob = torch.load(path, map_location="cpu", weights_only=True)
    state = blob.get("model_state_dict", blob)
    config = dict(blob.get("config") or {})
    model = build_model(config)
    return probe_state_dicts(state, model.state_dict())
