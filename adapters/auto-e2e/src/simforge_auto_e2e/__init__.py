"""simforge_auto_e2e: Autoware AutoE2E inference adapter.

Isolated from the Alpamayo adapter on purpose — different input contract,
different output kind, different upstream package — and inert without an
authorized trained checkpoint.
"""

from simforge_auto_e2e.contract import (  # noqa: F401
    CHECKPOINT_SCHEMA_VERSION,
    DISPLAY_NAME,
    FAMILY,
    UPSTREAM_COMMIT,
    UPSTREAM_LICENSE,
    UPSTREAM_REPO,
    ModelConfig,
)

__all__ = [
    "FAMILY",
    "DISPLAY_NAME",
    "UPSTREAM_REPO",
    "UPSTREAM_COMMIT",
    "UPSTREAM_LICENSE",
    "CHECKPOINT_SCHEMA_VERSION",
    "ModelConfig",
]
