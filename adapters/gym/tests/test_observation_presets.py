"""Consumer contracts for native observation privilege and signal boundaries."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from simforge_oss_gym import SimForgeEnv, SimForgeVectorEnv
from simforge_oss_gym.episodes import LoadedEpisode, observation_channels
from simforge_oss_gym.native import LaneGraph, ScenarioInput
from simforge_oss_gym.profiles import ProfileUnavailableError


def occluded_episode(trajectory_spec: str) -> LoadedEpisode:
    entry = json.loads(Path(trajectory_spec).read_text())["instances"][0]
    scenario = entry["input"]
    scenario.pop("metricSubject")
    scenario["warmupSeconds"] = 0
    scenario["actors"][0].update(kind="car", tags=["role:ego"])
    scenario["actors"][1]["kind"] = "van"
    scenario["occluders"] = [{"id": "wall", "obb": {
        "center": {"x": 30.0, "z": 1.75}, "lengthM": 1, "widthM": 10, "headingRad": 0,
    }}]
    scenario["signalPrograms"] = [{
        "id": "junction", "loop": True,
        "phases": [{"phase": "red", "durationS": 1}, {"phase": "green", "durationS": 1}],
        "stopLines": [{"rsl": "1:0:-1", "s": 90}],
    }]
    topology = json.dumps(entry["topology"]).encode()
    return LoadedEpisode(ScenarioInput.parse(json.dumps(scenario)), LaneGraph.from_topology(topology), None, None, topology)


def test_native_visibility_survives_single_and_batch_adapters(trajectory_spec: str) -> None:
    episode = occluded_episode(trajectory_spec)
    assert episode.input.ego_id == "ego"
    with SimForgeEnv(episode=episode, observation_preset="state") as privileged, \
         SimForgeEnv(episode=episode, observation_preset="visible") as visible, \
         SimForgeVectorEnv(episodes=[episode, episode], observation_preset="visible", threads=1) as batch:
        truth, truth_info = privileged.reset(seed=42)
        obs, info = visible.reset(seed=42)
        batched, infos = batch.reset(seed=[42, 42])
        assert truth_info["object_ids"] == ["other"]
        assert truth["objects"][0, 3] == 0
        assert truth["state_vector"][9] < 60
        assert info["object_ids"] == []
        assert not obs["objects"][:, 4].any()
        assert obs["state_vector"][9] == 1e6
        assert "signals" not in truth_info
        assert info["signals"][0]["phase"] == "red"
        assert info["signals"][0]["timeToChangeS"] == 1
        for world in range(2):
            np.testing.assert_array_equal(batched["state_vector"][world], obs["state_vector"])
            np.testing.assert_array_equal(batched["objects"][world], obs["objects"])
            assert infos["signals"][world] == info["signals"]
        with pytest.raises(Exception, match="observation channels"):
            visible.restore(privileged.checkpoint())


def test_signal_phase_and_countdown_remain_native_after_restore(trajectory_spec: str) -> None:
    with SimForgeEnv(episode=occluded_episode(trajectory_spec), observation_preset="visible", info_channel=False) as env:
        env.reset(seed=42)
        for _ in range(5):
            _, _, _, _, info = env.step(None)
        assert info["signals"][0]["timeToChangeS"] == 0.5
        checkpoint = env.checkpoint()
        for _ in range(5):
            _, _, _, _, info = env.step(None)
        assert info["signals"][0]["phase"] == "green"
        assert info["signals"][0]["timeToChangeS"] == 1
        expected = info["signals"]
        env.restore(checkpoint)
        for _ in range(5):
            _, _, _, _, info = env.step(None)
        assert info["signals"] == expected


def test_bev_preset_and_camera_capability_refusal(trajectory_spec: str) -> None:
    with SimForgeEnv(trajectory_spec, observation_preset="state+bev") as env:
        obs, _ = env.reset(seed=42)
        assert env.observation_space.contains(obs)
        assert obs["bev"].shape == (200, 160, 3)
        assert np.any(obs["bev"][:, :, 2] == 1)
    with pytest.raises(ProfileUnavailableError):
        SimForgeEnv(trajectory_spec, observation_preset="cams:alpamayo-2cam")
    with pytest.raises(ProfileUnavailableError):
        SimForgeVectorEnv(trajectory_spec, observation_preset="cams:alpamayo-2cam")
    with pytest.raises(ValueError):
        observation_channels("cams:alpamayo-2cam")
    with pytest.raises(ValueError):
        observation_channels("cams:unknown-profile", backend={"kind": "service", "socket": "/unused"})
    with pytest.raises(ValueError):
        observation_channels("not-a-preset")
