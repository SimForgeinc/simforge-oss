"""Locating each family's vendored upstream inference code.

The three upstream packages pin mutually incompatible dependency sets, so
each family gets its own virtual environment and its own checkout. Two
layouts are supported, in this order:

1. **Installed** — the upstream package is importable in the current
   environment. This is what the model store produces: ``uv sync --locked``
   against the pinned upstream ``uv.lock``, then the checkout installed into
   the family venv.
2. **Vendored** — ``adapters/alpamayo/vendor/<dir>/src`` exists and is added
   to ``sys.path``. This is what ``scripts/setup.sh`` produces for local
   development and what the closed-loop worker image uses.

Nothing here downloads anything. A missing upstream package is an actionable
error naming the family, the pinned commit and the command that fixes it —
never a stub that lets inference "succeed" without the real model code.
"""

from __future__ import annotations

import importlib
import importlib.util
import sys
from pathlib import Path

from simforge_alpamayo.families import Family, get_family

ADAPTER_ROOT = Path(__file__).resolve().parents[2]
VENDOR_ROOT = ADAPTER_ROOT / "vendor"


class UpstreamMissing(ModuleNotFoundError):
    """The family's upstream inference package is not available."""


def vendor_src(spec: Family) -> Path:
    return VENDOR_ROOT / spec.vendor_dir / "src"


def _importable(package: str) -> bool:
    if package in sys.modules:
        return True
    try:
        return importlib.util.find_spec(package) is not None
    except (ImportError, ValueError):
        return False


def ensure_path(spec: Family) -> bool:
    """Make the family's upstream package importable if we can.

    Returns ``True`` when the package is importable afterwards. Never raises,
    so import-time plumbing in modules that do not need torch (``bridge``,
    ``protocol``, ``client``) stays side-effect free.
    """
    if _importable(spec.package):
        return True
    src = vendor_src(spec)
    if src.is_dir():
        path = str(src)
        if path not in sys.path:
            sys.path.insert(0, path)
        importlib.invalidate_caches()
        return _importable(spec.package)
    return False


def require_upstream(spec: Family | str) -> None:
    """Fail with setup guidance when the upstream code is absent."""
    resolved = get_family(spec) if isinstance(spec, str) else spec
    if ensure_path(resolved):
        return
    raise UpstreamMissing(
        f"{resolved.family}: upstream package {resolved.package!r} is not "
        f"importable and {vendor_src(resolved)} does not exist.\n"
        f"Install it with:  simforge models install {resolved.family}\n"
        f"or vendor it for development with:  "
        f"adapters/alpamayo/scripts/setup.sh --family {resolved.family}\n"
        f"Pinned upstream: {resolved.code_repo}@{resolved.code_revision}"
    )


def upstream_status() -> dict[str, dict[str, object]]:
    """Per-family import status, for the preflight report."""
    from simforge_alpamayo.families import FAMILIES

    status: dict[str, dict[str, object]] = {}
    for family_id, spec in FAMILIES.items():
        src = vendor_src(spec)
        status[family_id] = {
            "package": spec.package,
            "importable": ensure_path(spec),
            "vendorDir": str(src),
            "vendorPresent": src.is_dir(),
            "codeRepo": spec.code_repo,
            "codeRevision": spec.code_revision,
        }
    return status
