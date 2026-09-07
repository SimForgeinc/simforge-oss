"""Shared fixtures: the synthetic episode spec. Requires the built extension."""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

SPEC_PATH = Path(__file__).parent / "fixtures" / "synthetic-episode.json"
DYNAMIC_SPEC_PATH = Path(__file__).parent / "fixtures" / "synthetic-episode-dynamic.json"
TRAJECTORY_SPEC_PATH = Path(__file__).parent / "fixtures" / "synthetic-episode-trajectory.json"

# `find_spec` imports the parent package, so a missing runtime dependency
# (gymnasium) and a missing extension must BOTH degrade to "nothing to
# collect" rather than a collection error: an interpreter without the SDK
# installed is an environment fact, not a test failure. `pytest.skip` is not
# valid at conftest level, so the tests are ignored instead.
collect_ignore_glob: list[str] = []
try:
    _unavailable = importlib.util.find_spec("simforge_oss_gym._native") is None
    _reason = "simforge_oss_gym._native is not built (run `maturin develop` in adapters/gym)"
except ImportError as error:  # pragma: no cover - environment guard
    _unavailable = True
    _reason = f"simforge_oss_gym is not importable ({error})"
if _unavailable:  # pragma: no cover - environment guard
    print(f"skipping adapters/gym tests: {_reason}")
    collect_ignore_glob.append("test_*.py")


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
