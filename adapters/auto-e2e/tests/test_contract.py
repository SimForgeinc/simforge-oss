"""AutoE2E contract and refusal tests.

These pin the two things that would otherwise silently produce nonsense: the
input schema taken from upstream SOURCE rather than prose, and the refusal to
run without an authorized checkpoint or real camera geometry.

Run (repo root): python3 -m pytest adapters/auto-e2e/tests/
Deps: pytest only (no torch, no upstream package, no network).
"""

import pathlib
import sys

import pytest

REPO = pathlib.Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "adapters" / "auto-e2e" / "src"))

from simforge_auto_e2e import contract  # noqa: E402
from simforge_auto_e2e.engine import (  # noqa: E402
    AutoE2EEngine,
    AutoE2EError,
    CheckpointUnavailable,
    config_from_checkpoint,
)
from simforge_auto_e2e.obs import (  # noqa: E402
    integrate_control,
    split_control,
    validate_observation,
)


def observation(**overrides):
    obs = {
        "camera_tiles": [None] * contract.DEFAULT_NUM_VIEWS,
        "map_context": object(),
        "route_mask": object(),
        "egomotion_history": [0.0] * contract.EGOMOTION_DIM,
        "visual_history": [0.0] * contract.VISUAL_HISTORY_DIM,
        "projection": object(),
        "geometry_type": "pinhole",
    }
    obs.update(overrides)
    return obs


def test_dimensions_match_upstream_source():
    assert contract.EGOMOTION_DIM == 256
    assert contract.VISUAL_HISTORY_DIM == 896
    assert contract.TRAJECTORY_DIM == 128
    assert contract.DEFAULT_NUM_VIEWS == 7
    assert contract.HORIZON_SECONDS == pytest.approx(6.4)


def test_fourth_egomotion_signal_is_curvature_not_yaw_angle():
    """Upstream's README and its code disagree; the code wins.

    README says "speed, acceleration, yaw angle and yaw angle rate"; the
    loader says [speed, acceleration, yaw_rate, curvature]. Packing a yaw
    angle into slot 3 would feed a wrongly-scaled channel.
    """
    assert contract.EGOMOTION_SIGNALS == ("speed", "acceleration", "yaw_rate", "curvature")
    assert "yaw_angle" not in contract.EGOMOTION_SIGNALS
    assert contract.EGOMOTION_UNITS["curvature"] == "1/m"


def test_output_is_a_control_sequence_not_waypoints():
    assert contract.OUTPUT_KIND == "control-sequence"
    assert contract.TRAJECTORY_SIGNALS == ("acceleration", "curvature")


def test_engine_refuses_without_a_checkpoint():
    engine = AutoE2EEngine()
    with pytest.raises(CheckpointUnavailable) as caught:
        engine.load()
    assert caught.value.code == "checkpoint_unavailable"
    # The refusal must name the registry rather than implying absence.
    assert caught.value.detail["registryReachablePublicly"] is False
    assert engine.info()["status"] == "no-checkpoint"
    assert engine.info()["loaded"] is False


def test_engine_refuses_to_act_without_a_checkpoint():
    with pytest.raises(CheckpointUnavailable):
        AutoE2EEngine().act(observation())


def test_checkpoint_config_cannot_be_guessed():
    for missing in ("backbone", "planner_mode"):
        raw = {"backbone": "res_net_50", "planner_mode": "bezier"}
        del raw[missing]
        with pytest.raises(AutoE2EError) as caught:
            config_from_checkpoint(raw)
        assert caught.value.code == "checkpoint_invalid"
    with pytest.raises(AutoE2EError):
        config_from_checkpoint({"backbone": "not_a_backbone", "planner_mode": "bezier"})
    ok = config_from_checkpoint({"backbone": "swin_v2_tiny", "planner_mode": "flow_matching"})
    assert ok.as_kwargs()["planner_mode"] == "flow_matching"


def test_navigation_raster_is_required():
    with pytest.raises(AutoE2EError) as caught:
        validate_observation(observation(map_context=None), scored=True)
    assert caught.value.code == "missing_fields"
    assert "map_context" in caught.value.detail["fields"]
    with pytest.raises(AutoE2EError):
        validate_observation(observation(route_mask=None), scored=True)


def test_view_count_is_exact_and_positional():
    with pytest.raises(AutoE2EError) as caught:
        validate_observation(observation(camera_tiles=[None] * 6), scored=True)
    assert caught.value.code == "camera_set_invalid"


def test_pseudo_geometry_is_refused_for_a_scored_run_but_allowed_shape_only():
    shape_only = validate_observation(
        observation(projection=None, geometry_type="pseudo"), scored=False
    )
    assert shape_only["geometry_is_real"] is False
    assert shape_only["scorable"] is False
    with pytest.raises(AutoE2EError) as caught:
        validate_observation(observation(projection=None, geometry_type="pseudo"), scored=True)
    assert caught.value.code == "missing_fields"


def test_wrong_length_histories_are_refused():
    for field, dim in (
        ("egomotion_history", contract.EGOMOTION_DIM),
        ("visual_history", contract.VISUAL_HISTORY_DIM),
    ):
        with pytest.raises(AutoE2EError):
            validate_observation(observation(**{field: [0.0] * (dim - 1)}), scored=True)


def test_visual_history_absence_is_refused_rather_than_zero_filled():
    with pytest.raises(AutoE2EError) as caught:
        validate_observation(observation(visual_history=None), scored=True)
    assert "fabricated" in caught.value.message


def test_control_split_and_integration_conventions():
    pairs = split_control([0.0] * contract.TRAJECTORY_DIM)
    assert len(pairs) == contract.FUTURE_TIMESTEPS

    # Constant speed, zero curvature: straight line at exactly speed * horizon.
    straight = integrate_control([(0.0, 0.0)] * 64, initial_speed_mps=10.0)
    assert straight["path_xyz"][-1][0] == pytest.approx(64.0, rel=1e-6)
    assert straight["path_xyz"][-1][1] == pytest.approx(0.0, abs=1e-9)
    assert straight["derived"] is True

    # Positive curvature turns toward +y (left) in the FLU convention.
    left = integrate_control([(0.0, 0.05)] * 64, initial_speed_mps=10.0)
    assert left["path_xyz"][-1][1] > 1.0

    # A large deceleration must clamp at rest, never reverse.
    braking = integrate_control([(-5.0, 0.0)] * 64, initial_speed_mps=5.0)
    assert braking["speed_clamped_steps"] > 0
    xs = [point[0] for point in braking["path_xyz"]]
    assert xs == sorted(xs), "integrated path must never move backwards"


def test_integration_requires_a_real_initial_speed():
    for bad in (-1.0, float("nan")):
        with pytest.raises(AutoE2EError):
            integrate_control([(0.0, 0.0)] * 64, initial_speed_mps=bad)


def test_upstream_pin_is_recorded_as_a_commit():
    assert len(contract.UPSTREAM_COMMIT) == 40
    assert "no release or tag" in contract.UPSTREAM_PINNED_BY


# -- the checkpoint config is the authority over the documentation ---------


def _cfg(num_views: int) -> contract.ModelConfig:
    return contract.ModelConfig(
        backbone="swin_v2_tiny", planner_mode="bezier", num_views=num_views
    )


def test_view_count_comes_from_the_checkpoint_not_the_readme():
    """v63 has 6 views; the README says 7. Views are positional, so
    validating against the documented number would accept a stack whose every
    camera is mis-assigned, and reject the checkpoint's real input."""
    six = observation()
    six["camera_tiles"] = [None] * 6

    # Against the documented default this six-view input is refused...
    with pytest.raises(AutoE2EError) as no_cfg:
        validate_observation(six, scored=True)
    assert no_cfg.value.code == "camera_set_invalid"
    assert no_cfg.value.detail["expectedFrom"] == "documented default"

    # ...and against the real checkpoint's config it is correct.
    prov = validate_observation(six, scored=True, config=_cfg(6))
    assert prov["views"] == 6

    # The documented seven-view stack is then the one that must be refused.
    with pytest.raises(AutoE2EError) as wrong:
        validate_observation(observation(), scored=True, config=_cfg(6))
    assert wrong.value.detail["expected"] == 6
    assert wrong.value.detail["expectedFrom"] == "checkpoint config"


def test_registered_checkpoint_exists_and_is_not_qualified():
    """The v63 record must state both halves of the truth: the artifact is
    real and identified, and it fails its own evaluation gate."""
    v63 = contract.V63
    assert v63.run_id and len(v63.sha256) == 64
    assert v63.num_views == 6           # not the documented 7
    assert v63.config_retrievable       # config.yaml is public
    assert not v63.bytes_retrievable    # the .pt is not served
    assert not v63.eval_gate_pass       # ...and it fails its gate
    assert v63.validation_ade_m > 3.0
    assert "access prerequisite, not a missing artifact" in contract.CHECKPOINT_ACCESS_NOTE


def test_history_masking_matches_the_checkpoints_training_policy():
    """v63 masked the newest acceleration during training. Passing a real
    value there is off-distribution and undetectable downstream, so the mask
    is applied from the checkpoint's policy and recorded, not assumed."""
    ego = [1.0] * contract.EGOMOTION_DIM
    kept, off = contract.apply_history_masking(ego, mask_latest_acceleration=False)
    assert kept == ego and off["maskedLatestAcceleration"] is False

    masked, prov = contract.apply_history_masking(ego, mask_latest_acceleration=True)
    idx = prov["maskedIndex"]
    # newest timestep (63), acceleration is signal index 1 of 4
    assert idx == 63 * 4 + 1
    assert masked[idx] == 0.0 and prov["maskedValue"] == 1.0
    assert sum(1 for a, b in zip(ego, masked) if a != b) == 1

    with pytest.raises(ValueError):
        contract.apply_history_masking([0.0] * 10, mask_latest_acceleration=True)


def test_training_code_revision_is_an_independent_prerequisite():
    """Even with weights, the code that trained them is not published."""
    assert not contract.V63_TRAINING_CODE_PUBLISHED
    assert len(contract.V63_TRAINING_CODE_REVISION) == 40
    assert "NOT the code that trained" in contract.TRAINING_CODE_ACCESS_NOTE
    assert len(contract.CHECKPOINT_DELIVERY_PATHS_TRIED) == 4
