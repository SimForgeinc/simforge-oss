"""The three pin sources must agree, or the product describes one checkpoint
while the installer materializes another.

Pins exist in three places by necessity — Python (engines), TypeScript
(browser-safe catalog) and JSON (per-file digests) — because they are read by
three runtimes that cannot import each other. This module is what makes that
duplication safe: a drift is a test failure here rather than a user-visible
lie about which weights produced a result.

Run (repo root):
    python3 -m pytest adapters/alpamayo/tests/test_families.py
Deps: pytest only (no torch, no network).
"""

import json
import pathlib
import re
import sys

import pytest

REPO = pathlib.Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "adapters" / "alpamayo" / "src"))

from simforge_alpamayo.families import (  # noqa: E402
    FAMILIES,
    WEIGHTS_LICENSE,
    WEIGHTS_LICENSE_BLOB_SHA,
    checkpoint_digest,
)

LOCK_PATH = REPO / "packages" / "model-store" / "models.lock.json"
CATALOG_PATH = REPO / "packages" / "model-store" / "src" / "catalog.ts"
MANIFEST_PATH = REPO / "adapters" / "alpamayo" / "manifest.json"


@pytest.fixture(scope="module")
def lock() -> dict:
    return json.loads(LOCK_PATH.read_text())


@pytest.fixture(scope="module")
def catalog_source() -> str:
    return CATALOG_PATH.read_text()


def test_lock_covers_every_family_at_the_pinned_revision(lock):
    assert lock["schema"] == "simforge.model-lock/v1"
    assert set(lock["models"]) == set(FAMILIES)
    for family_id, spec in FAMILIES.items():
        entry = lock["models"][family_id]
        assert entry["weights"]["repo"] == spec.weights_repo
        assert entry["weights"]["revision"] == spec.weights_revision
        assert entry["code"]["commit"] == spec.code_revision
        assert entry["code"]["git"] == spec.code_repo
        assert entry["runtime"]["package"] == spec.package


def test_lock_sidecars_match_the_family_descriptors(lock):
    for family_id, spec in FAMILIES.items():
        entry = lock["models"][family_id]
        assert [(s["repo"], s["revision"]) for s in entry["sidecars"]] == [
            (s.repo, s.revision) for s in spec.sidecars
        ], family_id
        for locked, declared in zip(entry["sidecars"], spec.sidecars):
            assert locked["gated"] == declared.gated, (family_id, locked["repo"])
            # A sidecar must never smuggle in weights: every weight byte comes
            # from the Alpamayo checkpoint itself.
            assert not any(
                file["path"].endswith(".safetensors") for file in locked["files"]
            ), locked["repo"]


def test_only_alpamayo_1_5_requires_a_user_token(lock):
    gated = {
        family_id
        for family_id, entry in lock["models"].items()
        if any(sidecar["gated"] is not False for sidecar in entry["sidecars"])
    }
    assert gated == {"alpamayo-1.5"}
    assert FAMILIES["alpamayo-1.5"].requires_user_token
    assert not FAMILIES["alpamayo-1"].requires_user_token
    assert not FAMILIES["alpamayo-2-super"].requires_user_token


def test_checkpoint_digest_is_reproducible_from_the_lock(lock):
    """The digest a result cites must be derivable from published metadata.

    If this drifts, provenance stops identifying the checkpoint, which is the
    whole reason the digest exists.
    """
    for family_id, entry in lock["models"].items():
        shards = sorted(
            (file["path"], file["sha256"])
            for file in entry["weights"]["files"]
            if file["path"].endswith(".safetensors")
        )
        assert shards, family_id
        assert checkpoint_digest(shards) == entry["weights"]["checkpointDigest"]


def test_every_locked_file_carries_a_verifiable_digest(lock):
    for family_id, entry in lock["models"].items():
        groups = [entry["weights"]["files"]] + [s["files"] for s in entry["sidecars"]]
        for files in groups:
            for file in files:
                if file["digestSource"] == "hf-lfs":
                    assert re.fullmatch(r"[0-9a-f]{64}", file["sha256"] or ""), file
                else:
                    # Non-LFS files are pinned by the upstream git blob id,
                    # which binds the byte length as well as the content.
                    assert file["digestSource"] == "git-blob-sha1", file
                    assert re.fullmatch(r"[0-9a-f]{40}", file["blobId"] or ""), file
                    assert file["sizeBytes"] is not None, file


def test_weight_shard_sizes_match_the_declared_family_total(lock):
    for family_id, spec in FAMILIES.items():
        entry = lock["models"][family_id]
        assert entry["weights"]["weightBytes"] <= spec.weights_bytes
        # `weights_bytes` is the repository total the disk preflight budgets
        # against, so it must never understate the shards.
        assert spec.weights_bytes >= entry["weights"]["weightBytes"]


def test_weights_license_is_openmdw_on_every_family(lock):
    for family_id, entry in lock["models"].items():
        assert entry["weights"]["license"] == WEIGHTS_LICENSE
        assert entry["weights"]["licenseBlobSha"] == WEIGHTS_LICENSE_BLOB_SHA, family_id


def test_typescript_catalog_agrees_with_the_python_descriptors(catalog_source):
    """The browser-safe catalog is what users read; it must not diverge."""
    for spec in FAMILIES.values():
        assert f"weightsRevision: '{spec.weights_revision}'" in catalog_source
        assert f"codeRevision: '{spec.code_revision}'" in catalog_source
        assert f"weightsRepo: '{spec.weights_repo}'" in catalog_source
        assert f"pythonPackage: '{spec.package}'" in catalog_source
        for sidecar in spec.sidecars:
            assert f"revision: '{sidecar.revision}'" in catalog_source


def test_catalog_module_has_no_imports(catalog_source):
    """Zero imports is what keeps the map-free browser bundle provable."""
    imports = [
        line
        for line in catalog_source.splitlines()
        if re.match(r"\s*import\b", line) or re.match(r"\s*export .* from ", line)
    ]
    assert imports == [], imports


def test_manifest_summary_matches_the_descriptors():
    manifest = json.loads(MANIFEST_PATH.read_text())
    assert set(manifest["families"]) == set(FAMILIES)
    for family_id, spec in FAMILIES.items():
        entry = manifest["families"][family_id]
        assert entry["weights"]["revision"] == spec.weights_revision
        assert entry["inference_code"]["revision"] == spec.code_revision
        assert entry["package"] == spec.package


def test_camera_contracts_are_the_upstream_task_profiles():
    """A wrong required set silently produces garbage trajectories."""
    assert FAMILIES["alpamayo-1"].cameras.required == (0, 1, 2, 6)
    assert not FAMILIES["alpamayo-1"].cameras.variable
    assert FAMILIES["alpamayo-1.5"].cameras.required is None
    assert FAMILIES["alpamayo-1.5"].cameras.variable
    assert FAMILIES["alpamayo-2-super"].cameras.required == (0, 1, 2, 3, 5, 6)
    assert FAMILIES["alpamayo-2-super"].cameras.vqa == (0, 1, 2, 3, 4, 5)
    # The two A2 profiles differ by exactly one camera each way; conflating
    # them would send the wrong ring to the model.
    driving = set(FAMILIES["alpamayo-2-super"].cameras.required)
    vqa = set(FAMILIES["alpamayo-2-super"].cameras.vqa)
    assert driving - vqa == {6}
    assert vqa - driving == {4}


def test_text_capability_matches_declared_text_tasks():
    for spec in FAMILIES.values():
        assert bool(spec.text_tasks) == spec.capabilities.vqa, spec.family
        assert spec.supports_op("text") == bool(spec.text_tasks)
    assert FAMILIES["alpamayo-1"].text_tasks == ()
    assert "meta_action" in FAMILIES["alpamayo-2-super"].text_tasks


def test_unmeasured_quants_publish_no_vram_number():
    """A pending quant with a VRAM figure would read as a measurement."""
    for spec in FAMILIES.values():
        for offer in spec.quants:
            if offer.status != "supported":
                assert offer.min_vram_gib is None, (spec.family, offer.quant)
                assert offer.note, (spec.family, offer.quant)
            else:
                assert offer.min_vram_gib is not None, (spec.family, offer.quant)


def test_a2_super_offers_no_quantized_recipe_and_is_not_locally_qualified():
    spec = FAMILIES["alpamayo-2-super"]
    assert spec.quant("nf4").status == "unsupported"
    assert spec.quant("bf16").min_vram_gib == 80.0
    assert spec.local_execution == "qualification-pending"
    assert spec.vendor_tested_gpus == ("H100 80GB HBM3",)


def test_rig_presets_mirror_the_camera_contracts():
    from simforge_alpamayo.bridge import RIG_CAMERA_IDS, profile_for_camera_ids

    assert RIG_CAMERA_IDS["alpamayo-4cam"] == FAMILIES["alpamayo-1"].cameras.required
    assert RIG_CAMERA_IDS["alpamayo-6cam"] == FAMILIES["alpamayo-2-super"].cameras.required
    assert RIG_CAMERA_IDS["alpamayo-6cam-vqa"] == FAMILIES["alpamayo-2-super"].cameras.vqa
    # An unnamed camera set is reported as unnamed, never relabelled.
    assert profile_for_camera_ids((0, 1)) is None
