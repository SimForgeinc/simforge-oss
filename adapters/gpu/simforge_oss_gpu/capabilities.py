"""Backend capability report: what the profile executes, refuses, and on which device."""

from __future__ import annotations

import importlib.metadata
import platform
from typing import Any

from .profile import CAPABILITIES, CAPACITIES, NUMERICS_NOTES, PROFILE_ID, Numerics, ReproducibilityClass


def _dist_version(name: str) -> str | None:
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return None


def capabilities(*, probe_device: bool = False) -> dict[str, Any]:
    """``probe_device`` initialises Warp and enumerates CUDA devices; the default
    is a dependency-only report that touches no GPU."""
    report: dict[str, Any] = {
        "profileId": PROFILE_ID,
        "backend": "warp-cuda",
        "numerics": Numerics.DEVICE_F64.value,
        "reproducibility": {
            "sameBatch": ReproducibilityClass.SAME_BUILD_REPLAY.value,
            "againstCpuReference": ReproducibilityClass.CROSS_BACKEND_MEASURED.value,
        },
        "numericsNotes": list(NUMERICS_NOTES),
        "capacities": dict(CAPACITIES),
        "admission": CAPABILITIES,
        "hostSyncOnHotPath": False,
        "outputOwnership": "bounded leased device slots; release with consumer stream event",
        "versions": {
            "warp-lang": _dist_version("warp-lang"),
            "numpy": _dist_version("numpy"),
            "torch": _dist_version("torch"),
            "python": platform.python_version(),
        },
    }
    try:
        import warp as wp
    except ImportError as exc:
        report.update({"available": False, "reason": f"import failed: {exc}"})
        return report
    if not probe_device:
        report.update({"available": None, "reason": "device not probed"})
        return report
    wp.init()
    cuda = [{"alias": d.alias, "name": d.name, "arch": d.arch, "totalMemory": d.total_memory} for d in wp.get_cuda_devices()]
    report.update({"available": bool(cuda), "cudaDevices": cuda, "reason": None if cuda else "no CUDA device"})
    return report
