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
from simforge_auto_e2e.checkpoint_probe import (  # noqa: E402
    KNOWN_PLANNER_MISMATCHES,
    NO_KWARG_RECONCILIATION,
    OBSERVED_MAP_CHANNEL_WIDTHS,
    probe_state_dicts,
)
from simforge_auto_e2e.provenance import code_identity  # noqa: E402
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


def test_provenance_parser_excludes_the_validation_split_sha():
    """The mistake this prevents is one I made: a 40-hex string read out of a
    run and reported as the training revision, when it identified the
    validation split manifest. Uses the real v63 keys."""
    params = {
        "data/dataset": "KIT-MRT/KITScenes-Multimodal",
        "ctx/train_docker_image": contract.TRAINING_IMAGE,
        "train/reconstruction_audit_sha256": "f7ae9f48febedcdd72c22c749ce57160fd98d3a8be276253b341ba8b0a66504b",
        "data/navigation_quality_audit_sha256": "f3246a87ab64887c7622c54b06db4b0502d430b73164d8d51a0469eacc5943ee",
        "validation.source_revision": contract.V63_VALIDATION_SPLIT_SOURCE_REVISION,
    }
    tags = {
        "mlflow.source.type": "LOCAL",
        "mlflow.source.name": "/opt/conda/bin/pyflyte-execute",
        "checkpoint_sha256": "1a9b6765a0d65b9d0c024aa73aa3ae3ce2d9b17468dadee78c97afbc967ce2f5",
    }
    ident = code_identity(params, tags)

    # The split revision is revision-SHAPED and must not become code identity.
    assert ident.revision is None
    assert not ident.resolvable
    assert (
        ident.excluded["validation.source_revision"]
        == contract.V63_VALIDATION_SPLIT_SOURCE_REVISION
    )
    # Checkpoint and audit digests are excluded for the same reason.
    assert "checkpoint_sha256" in ident.excluded
    assert "train/reconstruction_audit_sha256" in ident.excluded


def test_a_real_git_commit_is_accepted_as_code_identity():
    """The parser is not simply always-None: a genuine commit resolves."""
    sha = "21f98c5209dd4058ea92f5734c29da1f34d1c558"
    ident = code_identity({}, {"mlflow.source.git.commit": sha})
    assert ident.revision == sha
    assert ident.revision_key == "mlflow.source.git.commit"
    assert ident.resolvable
    assert sha not in ident.excluded.values()


def test_an_eval_image_is_not_training_provenance():
    """v63 records only an eval image. Even digest-pinned, that is not the
    code that trained the weights, so it must not resolve identity."""
    ident = code_identity(
        {"ctx/eval_docker_image": "repo/auto-e2e/eval@sha256:" + "b" * 64}, {}
    )
    assert ident.image_role == "eval"
    assert ident.image_is_digest_pinned
    assert not ident.resolvable


def test_a_mutable_image_tag_is_not_resolvable_identity():
    """`:latest` resolves to different code over time, so it cannot
    reproduce a past run; a digest can."""
    tag = code_identity({"ctx/train_docker_image": "repo/auto-e2e/training:latest"}, {})
    assert tag.image_is_digest_pinned is False and not tag.resolvable

    digest = code_identity(
        {"ctx/train_docker_image": "repo/auto-e2e/training@sha256:" + "a" * 64}, {}
    )
    assert digest.image_role == "training"
    assert digest.image_is_digest_pinned and digest.resolvable


def test_a_concrete_export_request_is_recorded():
    """A named prerequisite beats a general claim of impossibility."""
    asks = contract.AUTOE2E_EXPORT_NEEDED
    assert len(asks) == 3
    assert any("training-code revision" in a for a in asks)
    assert any("digest" in a for a in asks)


# -- real-checkpoint compatibility probe -----------------------------------


class _T:
    """Minimal stand-in for a tensor, so the probe is testable without torch."""

    def __init__(self, *shape):
        self.shape = shape


def test_probe_reports_shape_disagreement_under_matching_names():
    """The failure this exists to catch: every NAME agrees, so any check
    that compares key sets - or reads only missing/unexpected keys back from
    load_state_dict - sees a clean match. torch itself raises on the size
    mismatch; a name-only comparison in our own code would not."""
    ck = {"a.w": _T(256, 896), "a.b": _T(256)}
    model = {"a.w": _T(896, 896), "a.b": _T(896)}
    r = probe_state_dicts(ck, model)
    assert not r.loadable
    assert r.verdict == "incompatible-same-names"
    assert not r.missing and not r.unexpected
    assert r.shape_mismatches["a.w"] == ((256, 896), (896, 896))


def test_probe_resolves_the_measured_module_rename():
    """MapEncoder -> NavigationEncoder is a rename, not 219 differences."""
    ck = {"Reactive_E2E.MapEncoder.x.weight": _T(96, 3)}
    model = {"Reactive_E2E.NavigationEncoder.x.weight": _T(96, 3)}
    r = probe_state_dicts(ck, model)
    assert r.renamed == {
        "Reactive_E2E.MapEncoder.x.weight": "Reactive_E2E.NavigationEncoder.x.weight"
    }
    assert not r.missing and not r.unexpected and not r.shape_mismatches
    assert r.remappable and r.verdict == "compatible-after-rename"


def test_probe_separates_absent_weights_from_a_rename():
    """A module only the published code has cannot be remapped: there is
    nothing to load, so it must not be reported as rescuable."""
    ck = {"Reactive_E2E.MapEncoder.x.weight": _T(4)}
    model = {
        "Reactive_E2E.NavigationEncoder.x.weight": _T(4),
        "Reactive_E2E.FusedFeaturePooling.reduce_channels.weight": _T(8),
    }
    r = probe_state_dicts(ck, model)
    assert r.missing == [
        "Reactive_E2E.FusedFeaturePooling.reduce_channels.weight"
    ]
    assert not r.remappable and r.verdict == "incompatible"


def test_a_clean_checkpoint_is_declared_loadable():
    r = probe_state_dicts({"a": _T(2, 2)}, {"a": _T(2, 2)})
    assert r.loadable and r.verdict == "compatible"
    assert r.as_dict()["note"] is None


def test_measured_mismatches_and_raster_widths_are_recorded():
    """The three raster widths are the reason no default is safe."""
    assert len(KNOWN_PLANNER_MISMATCHES) == 8
    assert OBSERVED_MAP_CHANNEL_WIDTHS == {
        "v35-checkpoint-weights": 3,
        "published-head-code": 5,
        "v63-config": 14,
    }
    assert "negative" in NO_KWARG_RECONCILIATION
