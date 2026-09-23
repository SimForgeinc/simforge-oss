"""Kernel batch parity, NEXT_STEP boundaries and complete continuation."""
from __future__ import annotations

import json

import numpy as np
import pytest

from simforge_oss_gym import Episode, EpisodeBatch, SimForgeVectorEnv, load_episode_spec
from simforge_oss_gym.episodes import episode_config, kernel_episode_spec


def test_eight_batched_episodes_match_sequential_digests(spec: str) -> None:
    episode = load_episode_spec(spec).episodes[0]
    seed = 2**54 + 137
    options = episode_config({}, max_decisions=9, observation_preset="visible+signals")
    specs = [kernel_episode_spec(episode, {**options, "seed": seed + i}) for i in range(8)]
    sequential = [Episode(text, episode.graph) for text in specs]
    with SimForgeVectorEnv(episodes=[episode] * 8, max_decisions=9, observation_preset="visible+signals", threads=4) as env:
        env.reset(seed=seed)
        for single in sequential:
            single.reset()
        actions = np.array([[5.0 + i / 5, -0.1] for i in range(8)])
        for _ in range(25):
            obs, rewards, term, trunc, infos = env.step(actions)
            for i, single in enumerate(sequential):
                reset = single.ended
                result = json.loads(single.reset() if reset else single.step(json.dumps({
                    "k": "s", "speedMps": actions[i, 0], "accelerationMps2": actions[i, 1],
                })))
                expected = result if reset else result["obs"]
                np.testing.assert_array_equal(obs["state_vector"][i], expected["stateVector"])
                assert bool(infos["autoreset"][i]) == reset
                assert rewards[i] == (0 if reset else result["reward"])
                assert bool(term[i]) == (False if reset else result["terminated"])
                assert bool(trunc[i]) == (False if reset else result["truncated"])
                assert env.trace_digests()[i] == single.trace_digest()
        print("Python EpisodeBatch N=8 digests:", json.dumps(env.trace_digests()))


def test_checkpoint_preserves_mixed_autoresets_and_original_arrays(spec: str) -> None:
    episode = load_episode_spec(spec).episodes[0]
    specs = [kernel_episode_spec(episode, {"seed": i, "maxDecisions": limit}) for i, limit in enumerate((2, 7))]
    batch = EpisodeBatch(specs, [episode.graph] * 2, threads=2)
    batch.reset_all(73)
    actions = np.tile([6.0, 0.0], (2, 1))
    batch.step_all(actions)
    terminal = batch.step_all(actions)
    assert terminal.truncated.tolist() == [True, False]
    checkpoint = batch.checkpoint()
    original = terminal.state_vector.copy()
    reference = []
    for _ in range(9):
        view = batch.step_all(actions)
        reference.append((view.state_vector, view.reward, view.autoreset, batch.trace_digests()))
    replay = EpisodeBatch(specs, [episode.graph] * 2, threads=1)
    restored = replay.restore(checkpoint)
    np.testing.assert_array_equal(restored.state_vector, original)
    for states, rewards, reset, digests in reference:
        view = replay.step_all(actions)
        np.testing.assert_array_equal(view.state_vector, states)
        np.testing.assert_array_equal(view.reward, rewards)
        np.testing.assert_array_equal(view.autoreset, reset)
        assert replay.trace_digests() == digests
    np.testing.assert_array_equal(terminal.state_vector, original)


@pytest.mark.parametrize("preset", ["state", "state+bev", "visible", "visible+signals"])
def test_batch_presets_are_episode_channels(spec: str, preset: str) -> None:
    episode = load_episode_spec(spec).episodes[0]
    options = episode_config({}, observation_preset=preset)
    single = Episode(kernel_episode_spec(episode, options), episode.graph)
    expected = json.loads(single.reset())
    with SimForgeVectorEnv(episodes=[episode], observation_preset=preset, threads=1) as env:
        obs, infos = env.reset()
        np.testing.assert_array_equal(obs["state_vector"][0], expected["stateVector"])
        assert env.trace_digests()[0] == single.trace_digest()
        assert ("signals" in infos) == ("signals" in expected)
        assert ("bev" in obs) == ("bev" in expected)
        if "bev" in obs:
            np.testing.assert_array_equal(obs["bev"][0].reshape(-1), expected["bev"]["data"])
        assert env.observation_space.contains(obs)
