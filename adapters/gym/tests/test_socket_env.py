"""The socket gym path against a live ``simforge env serve``.

Needs the CLI binary and a workspace; the Rust integration test
``python_socket_client_suite`` (oss/native/crates/simforge-cli/tests/env_serve.rs)
builds both and runs this file with:

- ``SIMFORGE_BIN``: the ``simforge`` binary;
- ``SIMFORGE_ENV_TEST_WORKSPACE``: a workspace (golden-trace ``rfs-uturn-car``);
- ``SIMFORGE_ENV_TEST_MAP_DIR``: the map it was simulated on.

Without them the module is skipped (reported, never silently passed).
"""

from __future__ import annotations

import importlib
import json
import os
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

from simforge_oss_gym.socket_env import EnvServeError, SimForgeSocketEnv, SocketEnvClient, spawn_env_server

BIN = os.environ.get("SIMFORGE_BIN")
WORKSPACE = os.environ.get("SIMFORGE_ENV_TEST_WORKSPACE")
MAP_DIR = os.environ.get("SIMFORGE_ENV_TEST_MAP_DIR")
if not (BIN and WORKSPACE and MAP_DIR):
    pytest.skip("set SIMFORGE_BIN, SIMFORGE_ENV_TEST_WORKSPACE and SIMFORGE_ENV_TEST_MAP_DIR", allow_module_level=True)


@pytest.fixture()
def server(tmp_path: Path):
    socket = tmp_path / "env.sock"
    proc, ready = spawn_env_server(WORKSPACE, socket, "--no-sensors", "--map-dir", MAP_DIR, binary=BIN)
    try:
        yield socket, ready
    finally:
        if proc.poll() is None:
            proc.terminate()
        proc.wait(timeout=30)
        assert proc.returncode == 0
        assert not socket.exists()


def test_ready_line_and_spaces(server):
    socket, ready = server
    assert ready["protocol"] == "simforge.env-serve/v1"
    assert ready["sensors"] is False
    with SimForgeSocketEnv(socket) as env:
        obs, info = env.reset(seed=7)
        assert env.observation_space.contains(obs)
        assert info["ego"] == env.ego
        assert info["sensors"] == {}
        assert {"events", "minima", "causal"} <= set(info)
        obs, reward, terminated, truncated, info = env.step([8.0, 0.5])
        assert env.observation_space.contains(obs)
        assert isinstance(reward, float) and isinstance(terminated, bool) and isinstance(truncated, bool)


def test_seeded_episodes_and_checkpoints_are_deterministic(server):
    socket, _ = server
    with SimForgeSocketEnv(socket, action_mode="control", info_channel=False) as env:
        def rollout(n: int) -> list[np.ndarray]:
            env.reset(seed=11)
            return [env.step([0.4, 0.0, 0.01 * k])[0]["state_vector"] for k in range(n)]

        a = rollout(8)
        b = rollout(8)
        assert all(np.array_equal(x, y) for x, y in zip(a, b))
        env.reset(seed=11)
        for k in range(4):
            env.step([0.4, 0.0, 0.01 * k])
        saved = env.checkpoint()
        after = [env.step([0.4, 0.0, 0.01 * k])[0]["state_vector"] for k in range(4, 8)]
        env.restore(saved)
        again = [env.step([0.4, 0.0, 0.01 * k])[0]["state_vector"] for k in range(4, 8)]
        assert all(np.array_equal(x, y) for x, y in zip(after, again))
        assert all(np.array_equal(x, y) for x, y in zip(after, a[4:]))
        assert "events" not in env.observe()[1]


def test_errors_are_structured_and_the_connection_survives(server):
    socket, _ = server
    client = SocketEnvClient(socket)
    with pytest.raises(EnvServeError) as error:
        client.step(None)
    assert error.value.code == "episode_not_reset"
    with pytest.raises(EnvServeError) as error:
        client.call("frobnicate")
    assert error.value.code == "unknown_op"
    assert client.hello()["protocol"] == "simforge.env-serve/v1"
    client.close_server()
    client.close()


def test_socket_runner_scripted_smoke(server, tmp_path: Path):
    socket, _ = server
    traces = []
    for name in ("a", "b"):
        out = tmp_path / f"{name}.jsonl"
        result = subprocess.run(
            [sys.executable, "-m", "simforge_oss_gym.tools.socket_runner", "--socket", str(socket), "--policy", "scripted", "--seed", "42", "--steps", "20", "--out", str(out)],
            capture_output=True,
            text=True,
            check=True,
        )
        summary = json.loads(result.stdout)
        assert summary["schema"] == "simforge.socket-policy-trace/v1"
        assert summary["steps"] > 0
        traces.append(summary["digest"])
    assert traces[0] == traces[1]


def _native_available() -> bool:
    try:
        importlib.import_module("simforge_oss_gym._native")
        return True
    except ImportError:
        return False


@pytest.mark.skipif(not _native_available(), reason="simforge_oss_gym._native is not built (maturin develop)")
def test_socket_equals_native(server):
    from simforge_oss_gym import native

    socket, _ = server
    resolution = json.loads(__import__("gzip").decompress(Path(WORKSPACE, "simulation/resolution.json.gz").read_bytes()))
    scenario = native.ScenarioInput.parse(json.dumps(resolution["resolvedInput"]))
    bundle = native.MapBundle.load(MAP_DIR)
    session = native.EnvSession(scenario, bundle.graph)
    row = np.full(native.ACTION_WIDTH, np.nan)
    with SimForgeSocketEnv(socket, action_mode="control") as env:
        obs, _ = env.reset(seed=5)
        view = session.reset(5)
        assert np.array_equal(obs["state_vector"], view.state_vector)
        for k in range(10):
            action = [0.3, 0.0, 0.02]
            obs, *_ = env.step(action)
            row[:] = env.encode_action(action)
            view = session.step(row)
            assert np.array_equal(obs["state_vector"], view.state_vector)
            assert np.array_equal(obs["objects"], view.objects)
