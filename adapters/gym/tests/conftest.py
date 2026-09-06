"""Shared fixtures: the synthetic episode spec. Requires the built extension."""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

SPEC_PATH = Path(__file__).parent / "fixtures" / "synthetic-episode.json"
DYNAMIC_SPEC_PATH = Path(__file__).parent / "fixtures" / "synthetic-episode-dynamic.json"
TRAJECTORY_SPEC_PATH = Path(__file__).parent / "fixtures" / "synthetic-episode-trajectory.json"

if importlib.util.find_spec("simforge_oss_gym._native") is None:  # pragma: no cover - environment guard
    pytest.skip("simforge_oss_gym._native is not built (run `maturin develop` in adapters/gym)", allow_module_level=True)


@pytest.fixture(scope="session")
def spec() -> str:
    assert SPEC_PATH.exists(), f"missing episode spec fixture {SPEC_PATH}"
    return str(SPEC_PATH)


@pytest.fixture(scope="session")
def dynamic_spec() -> str:
    return str(DYNAMIC_SPEC_PATH)


@pytest.fixture(scope="session")
def trajectory_spec() -> str:
    return str(TRAJECTORY_SPEC_PATH)
