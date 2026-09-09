"""CPU-only regressions for uploaded-video camera admission and provenance."""

from __future__ import annotations

import pathlib
import sys
import types

import numpy as np
import pytest

REPO = pathlib.Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "adapters" / "alpamayo" / "src"))

torch = pytest.importorskip("torch", reason="observation decoding needs torch")

from simforge_alpamayo.engine_a15 import Alpamayo15Engine  # noqa: E402
from simforge_alpamayo.engine_a2 import Alpamayo2SuperEngine  # noqa: E402
from simforge_alpamayo.obs import ObservationError, synthetic_observation  # noqa: E402


_TRAJECTORIES = [[[[1.0, 2.0, 0.0], [2.0, 3.0, 0.0]]]]
_REASONING = ["The supplied view is clear."]


class _CpuInferenceMixin:
    """Exercise real decode/result assembly while replacing only GPU inference."""

    def _prepare_inputs(self, decoded):
        self.prepared_camera_ids = decoded["camera_ids"]
        return decoded

    def _infer_trajectories(self, prepared, **_params):
        return _TRAJECTORIES, None, _REASONING


class _CpuA15(_CpuInferenceMixin, Alpamayo15Engine):
    pass


class _CpuA2(_CpuInferenceMixin, Alpamayo2SuperEngine):
    pass


def _loaded(engine_type):
    engine = engine_type(engine_type_family(engine_type), device="cpu")
    engine.model = object()
    return engine


def engine_type_family(engine_type):
    return "alpamayo-2-super" if engine_type is _CpuA2 else "alpamayo-1.5"


@pytest.mark.parametrize(
    ("engine_type", "camera_ids"),
    [
        (_CpuA15, [4]),
        (_CpuA15, [1, 6]),
        (_CpuA2, [4]),
        (_CpuA2, [1, 6]),
    ],
)
def test_exploratory_act_consumes_supplied_cameras_and_records_truth(
    engine_type, camera_ids, monkeypatch
):
    monkeypatch.setattr(torch.cuda, "is_available", lambda: False)
    engine = _loaded(engine_type)
    obs = synthetic_observation(camera_ids=camera_ids, width=32, height=24)
    obs["exploratory_video"] = True

    result = engine.act(obs, seed=17, num_traj_samples=1)

    assert engine.prepared_camera_ids == camera_ids
    assert result["cameras"] == camera_ids
    assert result["trajectories"] == _TRAJECTORIES
    assert result["reasoning"] == _REASONING
    assert result["rng_provenance"]["exploratory_video"] is True
    assert result["rng_provenance"]["supplied_camera_ids"] == camera_ids
    assert result["model"]["camera_profile"] is None
    assert (
        result["rng_provenance"]["input_selection"]
        == "exploratory-uploaded-cameras"
    )


def test_a2_strict_mode_still_refuses_the_same_two_camera_observation():
    engine = _loaded(_CpuA2)
    obs = synthetic_observation(camera_ids=[1, 6], width=32, height=24)

    with pytest.raises(ObservationError) as caught:
        engine.act(obs)

    assert caught.value.code == "camera_set_invalid"
    assert caught.value.required_cameras == [0, 1, 2, 3, 5, 6]


def test_exploratory_mode_retains_boolean_finite_and_timing_validation():
    engine = _loaded(_CpuA2)

    wrong_type = synthetic_observation(camera_ids=[1], width=32, height=24)
    wrong_type["exploratory_video"] = "true"
    with pytest.raises(ObservationError) as caught:
        engine.decode(wrong_type)
    assert caught.value.fields == ["obs.exploratory_video"]

    duplicate = synthetic_observation(camera_ids=[1, 6], width=32, height=24)
    duplicate["exploratory_video"] = True
    duplicate["cameras"][1]["camera_id"] = 1
    with pytest.raises(ObservationError) as caught:
        engine.decode(duplicate)
    assert caught.value.code == "input_error"

    bad_rotation = synthetic_observation(camera_ids=[1], width=32, height=24)
    bad_rotation["exploratory_video"] = True
    bad_rotation["ego_history_rot"] = np.broadcast_to(
        np.eye(3), (16, 3, 3)
    ).copy()
    bad_rotation["ego_history_rot"][0, 0, 0] = np.inf
    with pytest.raises(ObservationError) as caught:
        engine.decode(bad_rotation)
    assert caught.value.fields == ["obs.ego_history_rot"]

    bad_clock = synthetic_observation(camera_ids=[1], width=32, height=24)
    bad_clock["exploratory_video"] = True
    bad_clock["ego_history_t_s"] = [-(15 - index) * 0.1 for index in range(16)]
    bad_clock["ego_history_t_s"][4] = float("nan")
    with pytest.raises(ObservationError) as caught:
        engine.decode(bad_clock)
    assert caught.value.fields == ["obs.ego_history_t_s"]


def test_a2_exploratory_preparation_uses_native_helper_with_actual_camera_ids(
    monkeypatch,
):
    engine = Alpamayo2SuperEngine("alpamayo-2-super", device="cpu")
    config = object()
    tokenizer = object()
    engine.model = types.SimpleNamespace(config=config, tokenizer=tokenizer)
    obs = synthetic_observation(camera_ids=[1, 6], width=32, height=24)
    obs["exploratory_video"] = True
    decoded = engine.decode(obs)
    calls = {}

    helper = types.ModuleType("alpamayo2_super.helper")

    def prepare_model_inputs(data, supplied_config, supplied_tokenizer):
        calls["data"] = data
        calls["config"] = supplied_config
        calls["tokenizer"] = supplied_tokenizer
        return {"native_prepared": True}

    def to_device(prepared, device):
        calls["device"] = device
        return prepared

    helper.prepare_model_inputs = prepare_model_inputs
    helper.to_device = to_device
    package = types.ModuleType("alpamayo2_super")
    package.__path__ = []
    package.helper = helper
    common = types.ModuleType("alpamayo2_super.common")
    common.__path__ = []
    constants = types.ModuleType("alpamayo2_super.common.constants")
    constants.CAMERA_INDICES_TO_NAMES = {
        index: f"camera-{index}" for index in range(7)
    }
    monkeypatch.setitem(sys.modules, "alpamayo2_super", package)
    monkeypatch.setitem(sys.modules, "alpamayo2_super.helper", helper)
    monkeypatch.setitem(sys.modules, "alpamayo2_super.common", common)
    monkeypatch.setitem(sys.modules, "alpamayo2_super.common.constants", constants)

    prepared = engine._prepare_inputs(decoded)

    assert prepared == {
        "native_prepared": True,
        "_selection": "exploratory-uploaded-cameras",
    }
    assert calls["config"] is config
    assert calls["tokenizer"] is tokenizer
    assert calls["device"] == "cpu"
    assert calls["data"]["camera_indices"].tolist() == [1, 6]
    assert calls["data"]["camera_names"] == ["camera-1", "camera-6"]
    assert torch.equal(calls["data"]["image_frames"], decoded["frames"])
    assert "input_profile" not in calls["data"]
