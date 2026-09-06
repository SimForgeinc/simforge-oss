"""SimForgeEnv: declared spaces match consumed actions; termination, checkpoint semantics."""

from __future__ import annotations

import numpy as np
import pytest
from gymnasium import spaces

from simforge_oss_gym import SimForgeEnv


@pytest.fixture()
def env(spec: str) -> SimForgeEnv:
    with SimForgeEnv(spec, seed="seed-a") as environment:
        yield environment


def test_spaces_describe_consumed_actions(env: SimForgeEnv) -> None:
    assert isinstance(env.observation_space, spaces.Dict)
    assert env.observation_space["state_vector"].shape == (10,)
    assert env.observation_space["objects"].shape == (64, 5)
    assert env.action_space.shape == (2,)  # setpoint mode: [target_speed_mps, target_acceleration_mps2]
    assert env.ego == "ego"
    obs, _ = env.reset()
    assert env.observation_space.contains(obs)
    for _ in range(5):
        action = env.action_space.sample()
        obs, reward, terminated, truncated, _ = env.step(action)
        assert env.observation_space.contains(obs)
        assert np.isfinite(reward)


def test_control_mode_bounds_are_enforced(spec: str) -> None:
    with SimForgeEnv(spec, action_mode="control") as env:
        assert env.action_space.shape == (3,)
        env.reset(seed=1)
        env.step(np.array([0.3, 0.0, -0.1]))
        with pytest.raises(ValueError):
            env.step(np.array([1.5, 0.0, 0.0]))


def test_reset_returns_t0_observation(env: SimForgeEnv) -> None:
    obs, info = env.reset(options={"seed": "seed-a"})
    assert info["t_s"] == 0.0
    assert obs["state_vector"].dtype == np.float64 and obs["state_vector"].shape == (10,)
    assert obs["objects"].dtype == np.float32
    assert obs["objects"][:, 4].sum() >= 1  # at least one perceived object marked valid
    assert "events" in info and "causal" in info


def test_step_info_contract(env: SimForgeEnv) -> None:
    env.reset(options={"seed": "seed-a"})
    obs, reward, terminated, truncated, info = env.step(np.array([9.0, 0.0]))
    assert isinstance(reward, float)
    assert info["t_s"] == pytest.approx(0.1)
    assert set(info["reward_terms"]) == {"progress", "proximity", "comfort"}
    assert obs["state_vector"][0] > 0


def test_episode_runs_to_truncation_and_refuses_further_steps(env: SimForgeEnv) -> None:
    """Clip is 4 s at 10 Hz: the episode must truncate exactly at t = 4.0 s."""
    env.reset(options={"seed": "seed-b"})
    last_t, truncated = -1.0, False
    for _ in range(60):
        _, _, terminated, truncated, info = env.step(None)
        last_t = info["t_s"]
        if terminated or truncated:
            break
    assert truncated and last_t == pytest.approx(4.0)
    with pytest.raises(Exception):
        env.step(None)


def test_retained_observations_are_immutable(env: SimForgeEnv) -> None:
    first, _ = env.reset(seed=3)
    snapshot = first["state_vector"].copy()
    env.step(np.array([9.0, 0.0]))
    np.testing.assert_array_equal(first["state_vector"], snapshot)


def test_checkpoint_restore_continues_bit_identically(env: SimForgeEnv) -> None:
    env.reset(seed=11)
    for _ in range(5):
        env.step(np.array([8.0, 0.0]))
    checkpoint = env.checkpoint()
    reference = [env.step(np.array([6.0, -0.5]))[0]["state_vector"] for _ in range(5)]
    env.restore(checkpoint)
    replay = [env.step(np.array([6.0, -0.5]))[0]["state_vector"] for _ in range(5)]
    for a, b in zip(reference, replay):
        np.testing.assert_array_equal(a, b)
