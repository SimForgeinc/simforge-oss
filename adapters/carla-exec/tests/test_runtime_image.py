"""The CARLA runtime image identity is configuration (runtime/image.py).

A user-provided CARLA server is recorded as such; a pinned deployment reports
its configured pin with the same record managed workers always wrote; managed
execution without a pin fails with a machine code before CARLA is contacted.
"""
from __future__ import annotations

import json

import pytest

from simforge_oss_carla_exec import local
from simforge_oss_carla_exec.runtime import image as image_module
from simforge_oss_carla_exec.runtime.image import (
    RuntimeImage,
    parse_runtime_image,
    runtime_image_evidence,
)
from simforge_oss_carla_exec.runtime.policy import CarlaRenderError

INDEX = "a" * 64
MANIFEST = "b" * 64
PINNED = {
    "SIMFORGE_CARLA_RUNTIME_IMAGE": f"registry.example/team/carla@sha256:{MANIFEST}",
    "SIMFORGE_CARLA_RUNTIME_IMAGE_INDEX_DIGEST": f"sha256:{INDEX}",
    "SIMFORGE_CARLA_IMAGE_MANIFEST_SHA256": MANIFEST,
    "SIMFORGE_CARLA_BLUEPRINT_ID": "vehicle.kia.carnival",
    "SIMFORGE_CARLA_BLUEPRINT_CLASS": "/Game/Carla/Blueprints/Vehicles/X.X_C",
}


def code_of(excinfo) -> str:
    assert isinstance(excinfo.value, CarlaRenderError), excinfo.value
    return excinfo.value.code


def test_unpinned_server_is_recorded_as_user_provided_and_never_exact():
    image = parse_runtime_image({})
    assert image == RuntimeImage(None, None, None, False)
    assert runtime_image_evidence(image, {}) == {
        "repository": None,
        "indexSha256": None,
        "linuxAmd64ManifestSha256": None,
        "configuredManifestSha256": None,
        "configuredBlueprintId": None,
        "configuredClassPath": None,
        "managed": False,
        "exact": False,
        "provenance": "user-provided",
    }


def test_pinned_image_evidence_is_the_managed_worker_record_unchanged():
    image = parse_runtime_image(PINNED)
    # Exactly the keys (and values) managed workers wrote before the pin moved
    # out of the code: no provenance key, so stored evidence stays comparable.
    assert runtime_image_evidence(image, PINNED) == {
        "repository": "registry.example/team/carla",
        "indexSha256": INDEX,
        "linuxAmd64ManifestSha256": MANIFEST,
        "configuredManifestSha256": MANIFEST,
        "configuredBlueprintId": "vehicle.kia.carnival",
        "configuredClassPath": "/Game/Carla/Blueprints/Vehicles/X.X_C",
        "managed": False,
        "exact": True,
    }
    managed = parse_runtime_image({**PINNED, "SIMFORGE_MANAGED_EXECUTION": "1"})
    assert runtime_image_evidence(managed, PINNED)["managed"] is True


def test_index_digest_is_optional():
    env = {"SIMFORGE_CARLA_RUNTIME_IMAGE": PINNED["SIMFORGE_CARLA_RUNTIME_IMAGE"]}
    image = parse_runtime_image(env)
    assert (image.index_sha256, image.manifest_digest) == (None, f"sha256:{MANIFEST}")
    # Nothing attests the running manifest: pinned but not exact.
    assert runtime_image_evidence(image, env)["exact"] is False


def test_managed_execution_without_a_pin_fails_loudly():
    with pytest.raises(CarlaRenderError) as excinfo:
        parse_runtime_image({"SIMFORGE_MANAGED_EXECUTION": "1"})
    assert code_of(excinfo) == "carla_runtime_image_unconfigured"
    assert "SIMFORGE_CARLA_RUNTIME_IMAGE" in str(excinfo.value)


def test_managed_execution_on_another_manifest_fails():
    env = {**PINNED, "SIMFORGE_MANAGED_EXECUTION": "1", "SIMFORGE_CARLA_IMAGE_MANIFEST_SHA256": "c" * 64}
    with pytest.raises(RuntimeError, match="pinned runtime image manifest"):
        runtime_image_evidence(parse_runtime_image(env), env)


@pytest.mark.parametrize("env", [
    {"SIMFORGE_CARLA_IMAGE_MANIFEST_SHA256": MANIFEST},
    {"SIMFORGE_CARLA_RUNTIME_IMAGE_INDEX_DIGEST": f"sha256:{INDEX}"},
])
def test_half_a_pin_is_refused_not_treated_as_user_provided(env):
    with pytest.raises(CarlaRenderError) as excinfo:
        parse_runtime_image(env)
    assert code_of(excinfo) == "carla_runtime_image_unconfigured"


@pytest.mark.parametrize("env", [
    {"SIMFORGE_CARLA_RUNTIME_IMAGE": "registry.example/carla:0.10.0"},
    {"SIMFORGE_CARLA_RUNTIME_IMAGE": f"registry.example/carla@sha256:{MANIFEST[:-1]}"},
    {"SIMFORGE_CARLA_RUNTIME_IMAGE": f"Registry.Example/carla@sha256:{MANIFEST}"},
    {"SIMFORGE_CARLA_RUNTIME_IMAGE": PINNED["SIMFORGE_CARLA_RUNTIME_IMAGE"],
     "SIMFORGE_CARLA_RUNTIME_IMAGE_INDEX_DIGEST": INDEX},
    {"SIMFORGE_CARLA_RUNTIME_IMAGE": PINNED["SIMFORGE_CARLA_RUNTIME_IMAGE"],
     "SIMFORGE_CARLA_IMAGE_MANIFEST_SHA256": "sha256:" + MANIFEST},
])
def test_malformed_pins_are_refused(env):
    with pytest.raises(CarlaRenderError) as excinfo:
        parse_runtime_image(env)
    assert code_of(excinfo) == "carla_runtime_image_malformed"


def test_identity_is_read_once_per_process(monkeypatch: pytest.MonkeyPatch):
    image_module.runtime_image.cache_clear()
    try:
        monkeypatch.setenv("SIMFORGE_CARLA_RUNTIME_IMAGE", PINNED["SIMFORGE_CARLA_RUNTIME_IMAGE"])
        first = image_module.runtime_image()
        monkeypatch.delenv("SIMFORGE_CARLA_RUNTIME_IMAGE")
        assert image_module.runtime_image() is first
    finally:
        image_module.runtime_image.cache_clear()


def test_cli_refuses_managed_execution_without_a_pin_before_contacting_carla(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
):
    image_module.runtime_image.cache_clear()
    try:
        monkeypatch.setenv("SIMFORGE_MANAGED_EXECUTION", "1")
        monkeypatch.delenv("SIMFORGE_CARLA_RUNTIME_IMAGE", raising=False)
        monkeypatch.setattr(local, "CarlaBackend", lambda *_: pytest.fail("CARLA contacted"))
        monkeypatch.setattr("sys.argv", ["simforge-oss-carla-exec", "probe"])
        with pytest.raises(SystemExit) as exited:
            local.main()
        assert exited.value.code == 3
        record = json.loads(capsys.readouterr().out)
        assert record["code"] == "carla_runtime_image_unconfigured"
        assert record["retryable"] is False
    finally:
        image_module.runtime_image.cache_clear()
