"""The endpoint's refusal contract.

These tests defend the one behaviour that separates an evaluation from a
fabrication: an observation that does not satisfy a family's real input
contract is REFUSED with the exact missing field or required camera set, and
is never padded, cropped, resampled or silently accepted.

They also pin that a refusal is per-item (`ok: false` in a 200-shaped
response) rather than a transport failure, because a single bad clip in a
64-item open-loop manifest must not fail the other 63.

Run (repo root):
    python3 -m pytest adapters/alpamayo/tests/test_wire.py
Deps: pytest, numpy (torch/PIL not required — the decode tests self-skip).
"""

import base64
import pathlib
import sys

import numpy as np
import pytest

REPO = pathlib.Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "adapters" / "alpamayo" / "src"))

from simforge_alpamayo.families import FAMILIES, get_family  # noqa: E402
from simforge_alpamayo.invoke import handle_item  # noqa: E402
from simforge_alpamayo.obs import (  # noqa: E402
    NUM_FRAMES_PER_CAMERA,
    NUM_HISTORY_STEPS,
    ObservationError,
    synthetic_observation,
    validate_camera_set,
    validate_history_times,
)

torch = pytest.importorskip("torch", reason="frame decoding needs torch")
from simforge_alpamayo.obs import decode_observation  # noqa: E402


def contract(family: str, task: str = "act"):
    spec = get_family(family)
    required, variable = spec.camera_contract(task)
    return dict(
        required_cameras=required,
        variable_cameras=variable,
        family=family,
        task=task,
        max_cameras=spec.cameras.max_cameras,
    )


def refusal(family: str, obs: dict, task: str = "act") -> ObservationError:
    with pytest.raises(ObservationError) as caught:
        decode_observation(obs, **contract(family, task))
    return caught.value


# -- camera contracts -------------------------------------------------------


def test_a1_accepts_only_its_four_camera_set():
    good = synthetic_observation(camera_ids=[0, 1, 2, 6])
    decoded = decode_observation(good, **contract("alpamayo-1"))
    assert decoded["camera_ids"] == [0, 1, 2, 6]

    error = refusal("alpamayo-1", synthetic_observation(camera_ids=[1, 6]))
    assert error.code == "camera_set_invalid"
    assert error.required_cameras == [0, 1, 2, 6]
    # The message must name what is required, not just that something is wrong.
    assert "[0, 1, 2, 6]" in error.message


def test_a1_rejects_a_superset_rather_than_cropping_to_its_profile():
    error = refusal("alpamayo-1", synthetic_observation(camera_ids=[0, 1, 2, 3, 5, 6]))
    assert error.code == "camera_set_invalid"


def test_a1_5_accepts_a_variable_camera_count():
    for ids in ([1, 6], [0, 1, 2, 6], [0, 1, 2, 3, 4, 5, 6]):
        decoded = decode_observation(
            synthetic_observation(camera_ids=ids), **contract("alpamayo-1.5")
        )
        assert decoded["camera_ids"] == sorted(ids)


def test_a2_driving_and_vqa_profiles_are_not_interchangeable():
    driving = synthetic_observation(camera_ids=[0, 1, 2, 3, 5, 6])
    vqa = synthetic_observation(camera_ids=[0, 1, 2, 3, 4, 5])
    assert decode_observation(driving, **contract("alpamayo-2-super"))["camera_ids"] == [0, 1, 2, 3, 5, 6]
    assert decode_observation(vqa, **contract("alpamayo-2-super", "text"))["camera_ids"] == [0, 1, 2, 3, 4, 5]
    # Crossed over, each is refused: they differ by exactly one camera and
    # substituting one for the other would feed the model the wrong ring.
    assert refusal("alpamayo-2-super", vqa).code == "camera_set_invalid"
    assert refusal("alpamayo-2-super", driving, "text").code == "camera_set_invalid"


def test_camera_ids_are_validated_before_any_frame_is_decoded():
    duplicate = synthetic_observation(camera_ids=[1, 6])
    duplicate["cameras"][1]["camera_id"] = 1
    assert refusal("alpamayo-1.5", duplicate).code == "input_error"

    out_of_range = synthetic_observation(camera_ids=[1, 6])
    out_of_range["cameras"][1]["camera_id"] = 9
    assert refusal("alpamayo-1.5", out_of_range).code == "input_error"


def test_empty_camera_list_is_a_missing_field_not_a_crash():
    error = refusal("alpamayo-1.5", {"cameras": [], "ego_history_xyz": []})
    assert error.code == "missing_fields"
    assert "obs.cameras" in error.fields


def test_validate_camera_set_is_reusable_without_frames():
    """The gym endpoint policy checks the rig before an episode starts."""
    spec = FAMILIES["alpamayo-2-super"]
    with pytest.raises(ObservationError):
        validate_camera_set([0, 1, 2, 6], spec.cameras.required, False, family=spec.family)
    validate_camera_set(
        list(spec.cameras.required), spec.cameras.required, False, family=spec.family
    )


# -- ego history ------------------------------------------------------------


def test_missing_ego_history_is_refused_and_never_synthesized():
    obs = synthetic_observation(camera_ids=[1, 6])
    del obs["ego_history_xyz"]
    error = refusal("alpamayo-1.5", obs)
    assert error.code == "missing_fields"
    assert error.fields == ["obs.ego_history_xyz"]
    assert "never synthesized" in error.message


def test_wrong_length_ego_history_is_refused():
    obs = synthetic_observation(camera_ids=[1, 6])
    obs["ego_history_xyz"] = obs["ego_history_xyz"][:8]
    error = refusal("alpamayo-1.5", obs)
    assert error.code == "input_error"
    assert "(16, 3)" in error.message


def test_non_finite_ego_history_is_refused():
    obs = synthetic_observation(camera_ids=[1, 6])
    obs["ego_history_xyz"][3][0] = float("nan")
    assert refusal("alpamayo-1.5", obs).code == "input_error"


def test_absent_rotations_default_to_identity_and_are_recorded():
    obs = synthetic_observation(camera_ids=[1, 6])
    decoded = decode_observation(obs, **contract("alpamayo-1.5"))
    rot = decoded["ego_history_rot"][0, 0].numpy()
    assert rot.shape == (NUM_HISTORY_STEPS, 3, 3)
    assert np.allclose(rot, np.eye(3))


def test_absent_time_base_makes_a_run_inference_only():
    """An unknown history cadence must not silently pass as scored."""
    absent = validate_history_times(None)
    assert absent["ego_history_t_s"] == "absent"
    assert absent["scorable"] is False
    assert "cannot be scored" in absent["time_base_warning"]
    # A documented source rate is an acceptable substitute, and is recorded
    # as declared rather than measured.
    declared = validate_history_times(None, 10.0)
    assert declared["scorable"] is True
    assert declared["ego_history_t_s"] == "declared-10hz"
    assert declared["time_base"] == "declared"
    assert declared["time_base_warning"] is None
    # A declared rate that is not the trained window is reported, not applied.
    off_rate = validate_history_times(None, 5.0)
    assert off_rate["scorable"] is True
    assert "not resampled" in off_rate["time_base_warning"]
    with pytest.raises(ObservationError):
        validate_history_times(None, 0.0)


def test_time_base_is_validated_and_never_resampled():
    ten_hz = [-(NUM_HISTORY_STEPS - 1 - i) * 0.1 for i in range(NUM_HISTORY_STEPS)]
    supplied = validate_history_times(ten_hz)
    assert supplied["time_base_warning"] is None
    assert supplied["scorable"] is True and supplied["time_base"] == "measured"
    five_hz = [-(NUM_HISTORY_STEPS - 1 - i) * 0.2 for i in range(NUM_HISTORY_STEPS)]
    warned = validate_history_times(five_hz)
    # A wrong clock is reported, not corrected: the model consumes a fixed
    # 100 ms window and we do not pretend otherwise.
    assert warned["time_base_warning"] and "not resampled" in warned["time_base_warning"]
    with pytest.raises(ObservationError):
        validate_history_times([0.0] * NUM_HISTORY_STEPS)
    with pytest.raises(ObservationError):
        validate_history_times([t + 1.0 for t in ten_hz])


# -- frame transports -------------------------------------------------------


def test_frame_window_must_be_exactly_four_frames():
    obs = synthetic_observation(camera_ids=[1, 6])
    obs["cameras"][0]["frames"] = obs["cameras"][0]["frames"][:2]
    error = refusal("alpamayo-1.5", obs)
    assert error.code == "input_error"
    assert str(NUM_FRAMES_PER_CAMERA) in error.message


def test_base64_frames_decode_to_the_same_tensor_as_raw_bytes():
    """HTTP callers send base64; the socket sends binary. Same pixels."""
    raw = synthetic_observation(camera_ids=[1, 6], seed=7)
    encoded = {
        "ego_history_xyz": raw["ego_history_xyz"],
        "cameras": [
            {
                **camera,
                "frames": [base64.b64encode(frame).decode() for frame in camera["frames"]],
                "encoding": "raw-b64",
            }
            for camera in raw["cameras"]
        ],
    }
    assert torch.equal(
        decode_observation(raw, **contract("alpamayo-1.5"))["frames"],
        decode_observation(encoded, **contract("alpamayo-1.5"))["frames"],
    )


def test_frames_paths_transport_reads_from_disk(tmp_path):
    raw = synthetic_observation(camera_ids=[1, 6], seed=11)
    cameras = []
    for camera in raw["cameras"]:
        paths = []
        for index, frame in enumerate(camera["frames"]):
            path = tmp_path / f"cam{camera['camera_id']}_{index}.bin"
            path.write_bytes(frame)
            paths.append(str(path))
        cameras.append({**{k: v for k, v in camera.items() if k != "frames"}, "frames_paths": paths})
    from_paths = decode_observation(
        {"cameras": cameras, "ego_history_xyz": raw["ego_history_xyz"]},
        **contract("alpamayo-1.5"),
    )
    assert torch.equal(from_paths["frames"], decode_observation(raw, **contract("alpamayo-1.5"))["frames"])


def test_both_frame_transports_at_once_is_refused():
    raw = synthetic_observation(camera_ids=[1, 6])
    raw["cameras"][0]["frames_paths"] = ["/tmp/a", "/tmp/b", "/tmp/c", "/tmp/d"]
    error = refusal("alpamayo-1.5", raw)
    assert error.code == "input_error"
    assert "exactly one of" in error.message


def test_relative_frame_paths_are_refused():
    raw = synthetic_observation(camera_ids=[1, 6])
    camera = raw["cameras"][0]
    del camera["frames"]
    camera["frames_paths"] = ["a.bin", "b.bin", "c.bin", "d.bin"]
    assert refusal("alpamayo-1.5", raw).code == "input_error"


def test_raw_frames_require_dimensions_and_the_byte_count_must_match():
    obs = synthetic_observation(camera_ids=[1, 6])
    del obs["cameras"][0]["width"]
    error = refusal("alpamayo-1.5", obs)
    assert error.code == "missing_fields"
    assert "obs.cameras[].width" in error.fields

    wrong = synthetic_observation(camera_ids=[1, 6])
    wrong["cameras"][0]["width"] = 511
    assert refusal("alpamayo-1.5", wrong).code == "input_error"


def test_mismatched_frame_sizes_across_cameras_are_refused():
    small = synthetic_observation(camera_ids=[1], width=64, height=48)
    large = synthetic_observation(camera_ids=[6], width=128, height=96)
    mixed = {
        "cameras": small["cameras"] + large["cameras"],
        "ego_history_xyz": small["ego_history_xyz"],
    }
    error = refusal("alpamayo-1.5", mixed)
    assert error.code == "input_error"
    assert "must share one size" in error.message


# -- handle_item: refusals are per item, not per batch ----------------------


class _StubEngine:
    """Minimal engine surface: exercises handle_item's routing and refusals.

    Deliberately not a fake inference: `act` returns a marker, so a test can
    only assert routing and refusal behaviour, never model quality.
    """

    def __init__(self, family: str):
        self.spec = get_family(family)
        self.family = self.spec.family
        self.model = object()
        self.calls: list[dict] = []

    def supports(self):
        ops = ["act"]
        if self.spec.text_tasks:
            ops.append("text")
        return ops

    def decode(self, obs, task="act"):
        return decode_observation(obs, **contract(self.family, task))

    def act(self, obs, seed=0, **params):
        self.decode(obs, "act")
        self.calls.append({"op": "act", "seed": seed, **params})
        return {"marker": "act", "seed": seed, "params": params}

    def text(self, obs, prompt=None, task="vqa", seed=0, **params):
        if not self.spec.text_tasks:
            raise ObservationError("unsupported_op", f"{self.family} has no text capability")
        self.decode(obs, "text")
        self.calls.append({"op": "text", "task": task, "prompt": prompt})
        return {"marker": "text", "task": task}


def test_handle_item_routes_act_and_echoes_caller_identity():
    engine = _StubEngine("alpamayo-1.5")
    response = handle_item(
        engine,
        {
            "task": "act",
            "obs": synthetic_observation(camera_ids=[1, 6]),
            "seed": 42,
            "params": {"num_traj_samples": 3, "top_p": 0.9},
            "index": 7,
            "itemId": "clip-7",
        },
    )
    assert response["ok"] is True
    assert response["index"] == 7 and response["itemId"] == "clip-7"
    assert engine.calls[0]["seed"] == 42
    assert engine.calls[0]["num_traj_samples"] == 3


def test_handle_item_returns_a_typed_refusal_instead_of_raising():
    engine = _StubEngine("alpamayo-1")
    response = handle_item(
        engine,
        {"task": "act", "obs": synthetic_observation(camera_ids=[1, 6]), "index": 3},
    )
    assert response["ok"] is False
    assert response["error"]["code"] == "camera_set_invalid"
    assert response["error"]["required_cameras"] == [0, 1, 2, 6]
    # Identity is echoed on a refusal too, so a batch can record it per item.
    assert response["index"] == 3


def test_nav_text_on_a_family_without_navigation_is_refused_not_ignored():
    engine = _StubEngine("alpamayo-1")
    response = handle_item(
        engine,
        {
            "task": "act",
            "obs": synthetic_observation(camera_ids=[0, 1, 2, 6]),
            "params": {"nav_text": "turn left in 40 m"},
        },
    )
    assert response["ok"] is False
    assert response["error"]["code"] == "unsupported_op"
    assert "params.nav_text" in response["error"]["fields"]
    assert engine.calls == []


def test_nav_text_reaches_a_navigation_capable_family():
    engine = _StubEngine("alpamayo-1.5")
    response = handle_item(
        engine,
        {
            "task": "act",
            "obs": synthetic_observation(camera_ids=[0, 1, 2, 6]),
            "params": {"nav_text": "turn left in 40 m"},
        },
    )
    assert response["ok"] is True


def test_text_task_on_a_trajectory_only_family_is_unsupported():
    engine = _StubEngine("alpamayo-1")
    response = handle_item(
        engine,
        {
            "task": "text",
            "obs": synthetic_observation(camera_ids=[0, 1, 2, 6]),
            "params": {"prompt": "what is ahead?", "text_task": "vqa"},
        },
    )
    assert response["ok"] is False
    assert response["error"]["code"] == "unsupported_op"


def test_unknown_task_and_missing_obs_are_typed_refusals():
    engine = _StubEngine("alpamayo-1.5")
    assert handle_item(engine, {"task": "dance", "obs": {}})["error"]["code"] == "unsupported_op"
    missing = handle_item(engine, {"task": "act"})
    assert missing["error"]["code"] == "missing_fields"
    assert missing["error"]["fields"] == ["obs"]


def test_unloaded_engine_refuses_before_touching_the_observation():
    engine = _StubEngine("alpamayo-1.5")
    engine.model = None
    response = handle_item(engine, {"task": "act", "obs": {}})
    assert response["error"]["code"] == "engine_not_loaded"


def test_bad_param_type_is_a_typed_refusal():
    engine = _StubEngine("alpamayo-1.5")
    response = handle_item(
        engine,
        {
            "task": "act",
            "obs": synthetic_observation(camera_ids=[1, 6]),
            "params": {"num_traj_samples": "many"},
        },
    )
    assert response["ok"] is False
    assert response["error"]["code"] == "input_error"
    assert "params.num_traj_samples" in response["error"]["fields"]
