"""libsimforge_render resolution: beside the package, then $SIMFORGE_RENDER_LIB, else a named error."""
import os

import pytest

from simforge_render import embedded
from simforge_render.embedded import EmbeddedRendererError, find_library, library_candidates, library_name


def test_order_is_explicit_then_beside_the_package_then_env(monkeypatch, tmp_path):
    monkeypatch.setenv("SIMFORGE_RENDER_LIB", str(tmp_path / "env.so"))
    got = library_candidates(str(tmp_path / "explicit.so"))
    assert got == [str(tmp_path / "explicit.so"), os.path.join(embedded._PACKAGE_DIR, library_name()), str(tmp_path / "env.so")]


def test_beside_the_package_wins_over_env(monkeypatch, tmp_path):
    beside = tmp_path / library_name()
    beside.write_bytes(b"")
    env = tmp_path / "env.so"
    env.write_bytes(b"")
    monkeypatch.setattr(embedded, "_PACKAGE_DIR", str(tmp_path))
    monkeypatch.setenv("SIMFORGE_RENDER_LIB", str(env))
    assert find_library() == str(beside)


def test_env_is_used_when_nothing_is_beside_the_package(monkeypatch, tmp_path):
    env = tmp_path / "env.so"
    env.write_bytes(b"")
    monkeypatch.setattr(embedded, "_PACKAGE_DIR", str(tmp_path / "pkg"))
    monkeypatch.setenv("SIMFORGE_RENDER_LIB", str(env))
    assert find_library() == str(env)


def test_a_missing_env_path_is_an_error_not_a_fallback(monkeypatch, tmp_path):
    monkeypatch.setattr(embedded, "_PACKAGE_DIR", str(tmp_path / "pkg"))
    monkeypatch.setenv("SIMFORGE_RENDER_LIB", str(tmp_path / "missing.so"))
    with pytest.raises(EmbeddedRendererError, match="missing.so"):
        find_library()


def test_nothing_found_fails_loudly(monkeypatch, tmp_path):
    monkeypatch.setattr(embedded, "_PACKAGE_DIR", str(tmp_path / "pkg"))
    monkeypatch.delenv("SIMFORGE_RENDER_LIB", raising=False)
    assert find_library() is None
    with pytest.raises(EmbeddedRendererError, match="SIMFORGE_RENDER_LIB is not set"):
        embedded._load(None)
