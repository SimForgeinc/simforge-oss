"""SimForgeVectorEnv: batch shapes, autoreset, cross-run determinism."""

from __future__ import annotations

import numpy as np
import pytest

from simforge_oss_gym import SimForgeVectorEnv

N_ENVS = 4


@pytest.fixture()
def vec(spec: str) -> SimForgeVectorEnv:
    vector = SimForgeVectorEnv(spec, num_envs=N_ENVS)
    yield vector
    vector.close()


def _rollout(vector: SimForgeVectorEnv) -> tuple[np.ndarray, np.ndarray]:
    obs, infos = vector.reset(seed=[f"seed-{i}" for i in range(N_ENVS)])
    assert list(infos["t_s"]) == [0.0] * N_ENVS
    rewards = np.zeros(0)
    states = obs["state_vector"]
    for k in range(6):
        actions = np.array([[9.0, 0.0] if (i + k) % 2 == 0 else [0.0, -1.0] for i in range(N_ENVS)])
        obs, rewards, terminated, truncated, infos = vector.step(actions)
        states = obs["state_vector"]
        assert [round(float(t), 6) for t in infos["t_s"]] == [round((k + 1) / 10, 6)] * N_ENVS
        if terminated.any() or truncated.any():
            break
    return rewards, states


def test_vector_shapes(vec: SimForgeVectorEnv) -> None:
    obs, _ = vec.reset(seed=["a", "b", "c", "d"])
    assert obs["state_vector"].shape == (N_ENVS, 10)
    assert obs["objects"].shape == (N_ENVS, 64, 5)
    obs, rewards, terminated, truncated, infos = vec.step(np.tile([9.0, 0.0], (N_ENVS, 1)))
    assert rewards.shape == (N_ENVS,)
    assert terminated.dtype == np.bool_ and truncated.dtype == np.bool_
    assert list(infos["ego"]) == ["ego"] * N_ENVS
    assert vec.observation_space.contains(obs)


def test_batched_steps_are_deterministic_across_runs(spec: str) -> None:
    with SimForgeVectorEnv(spec, num_envs=N_ENVS) as first:
        rewards_a, states_a = _rollout(first)
    with SimForgeVectorEnv(spec, num_envs=N_ENVS) as second:
        rewards_b, states_b = _rollout(second)
    np.testing.assert_array_equal(rewards_a, rewards_b)
    np.testing.assert_array_equal(states_a, states_b)


def test_next_step_autoreset(spec: str) -> None:
    """A world that truncates restarts on the following step with reward 0 and cleared flags."""
    with SimForgeVectorEnv(spec, num_envs=2, max_decisions=3) as vec:
        vec.reset(seed=0)
        hold = np.tile([9.0, 0.0], (2, 1))
        for _ in range(3):
            _, _, _, truncated, _ = vec.step(hold)
        assert truncated.all()
        obs, rewards, terminated, truncated, infos = vec.step(hold)
        assert not terminated.any() and not truncated.any()
        np.testing.assert_array_equal(rewards, np.zeros(2))
        assert list(infos["t_s"]) == [0.0, 0.0]
        assert vec.observation_space.contains(obs)


def test_rejects_wrong_action_count(vec: SimForgeVectorEnv) -> None:
    vec.reset()
    with pytest.raises(ValueError):
        vec.step(np.tile([9.0, 0.0], (N_ENVS - 1, 1)))
