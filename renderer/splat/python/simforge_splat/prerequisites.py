"""External-tier prerequisites of the splat backend, resolved explicitly.

Nothing here is a pip dependency of `simforge-oss-splat`: the 3DGRUT checkout (tracer plugin
compiled for the target GPU, `ncore`, hydra configs), Kaolin (NVIDIA build matching that
torch/CUDA, not the unrelated PyPI `kaolin`), the CUDA PyTorch build, and the ego-hood overlay
assets are pinned external prerequisites (PROVENANCE.json `externalDependencies`). Each is located
from explicit configuration or from what is actually installed; a missing one is a
`CapabilityError` naming what to configure - never a workstation-specific default path.
"""
from __future__ import annotations

import importlib.util
import os
import sys
from dataclasses import dataclass
from pathlib import Path

THREEDGRUT_ENV = "THREEDGRUT_ROOT"
HOOD_NONE = "none"


class CapabilityError(ValueError):
    """The request or configuration names a channel/format/transport/prerequisite this backend does not provide."""


def resolve_threedgrut_root(configured: str | os.PathLike | None = None) -> Path:
    """Directory that contains `threedgrut/`, `threedgut_tracer/` and `configs/apps/`.

    Order: explicit argument, `THREEDGRUT_ROOT`, an importable `threedgrut` package (its parent
    is the checkout root, e.g. an editable install). The result is verified before use.
    """
    candidates: list[tuple[str, Path]] = []
    if configured:
        candidates.append(("configured root", Path(configured)))
    env = os.environ.get(THREEDGRUT_ENV)
    if env:
        candidates.append((f"${THREEDGRUT_ENV}", Path(env)))
    if not candidates:
        spec = importlib.util.find_spec("threedgrut")
        if spec is not None and spec.submodule_search_locations:
            candidates.append(("installed threedgrut package", Path(next(iter(spec.submodule_search_locations))).parent))
    for origin, root in candidates:
        root = root.expanduser()
        missing = [name for name in ("threedgrut", "threedgut_tracer", "configs/apps") if not (root / name).exists()]
        if missing:
            raise CapabilityError(f"3DGRUT root from {origin} ({root}) lacks {missing}; point {THREEDGRUT_ENV} at a 3DGRUT checkout (nv-tlabs/3dgrut) with the tracer plugin built for this GPU")
        return root.resolve()
    raise CapabilityError(
        f"3DGRUT is required and was not found: set {THREEDGRUT_ENV}=<3dgrut checkout> or install the threedgrut package "
        "(nv-tlabs/3dgrut, Apache-2.0, tracer plugin compiled for the target GPU); it is an external tier prerequisite, not a pip dependency of simforge-oss-splat"
    )


def activate_threedgrut(configured: str | os.PathLike | None = None) -> Path:
    """Make the resolved checkout importable (idempotent) and return its root."""
    root = resolve_threedgrut_root(configured)
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))
    return root


def require_module(name: str, why: str, hint: str) -> None:
    if importlib.util.find_spec(name) is None:
        raise CapabilityError(f"{name} is required ({why}) and is not importable: {hint}")


def check_render_prerequisites() -> dict[str, str]:
    """Verify the CUDA tier once at backend start; returns what was found (for `hello.renderer`)."""
    import torch

    if not torch.cuda.is_available():
        raise CapabilityError("the splat backend renders on CUDA only; this PyTorch build has no CUDA device available")
    require_module("kaolin", "f-theta rasterization of catalog meshes/cuboids (kaolin.render.mesh.rasterize)",
                   "install NVIDIA Kaolin built for this torch/CUDA (kaolin.readthedocs.io); the unrelated PyPI 'kaolin' package is not it")
    root = activate_threedgrut()
    require_module("threedgut_tracer", "3DGUT rasterizer", f"build the tracer plugin inside {root} for this GPU")
    require_module("ncore", "NRE f-theta camera models", f"ncore ships with the 3DGRUT checkout at {root}")
    return {"threedgrutRoot": str(root), "torchVersion": torch.__version__, "cudaVersion": str(torch.version.cuda)}


@dataclass(frozen=True)
class HoodProfile:
    """Ego-hood overlay selection, stamped into every render's evidence.

    `directory` is None for the explicit `none` profile (no overlay, depth untouched). Otherwise
    the directory must exist and, at render time, hold `<cameraId>.png` for every camera rendered:
    a missing overlay is a configuration error, not a silent no-hood frame.
    """

    profile: str
    directory: Path | None

    @classmethod
    def parse(cls, value: str | os.PathLike | None) -> "HoodProfile":
        if value is None or str(value) == HOOD_NONE:
            return cls(HOOD_NONE, None)
        path = Path(value).expanduser()
        if not path.is_dir():
            raise CapabilityError(f"hood profile directory {path} does not exist; pass --hood-dir <dir of <cameraId>.png overlays> or --hood-dir none explicitly")
        return cls(path.name, path.resolve())

    def overlay(self, camera_id: str) -> Path | None:
        if self.directory is None:
            return None
        p = self.directory / f"{camera_id}.png"
        if not p.is_file():
            raise CapabilityError(f"hood profile {self.profile!r} ({self.directory}) has no overlay for camera {camera_id!r}; add {p.name} or select --hood-dir none")
        return p

    def wire(self) -> dict[str, str | None]:
        return {"profile": self.profile, "directory": None if self.directory is None else str(self.directory)}
