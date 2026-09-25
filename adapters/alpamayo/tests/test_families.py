"""The family descriptors are the one pin source in this repository; the
human-readable manifest and the rig presets must agree with them.

Run (repo root):
    python3 -m pytest adapters/alpamayo/tests/test_families.py
Deps: pytest only (no torch, no network).
"""

import json
import pathlib
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

MANIFEST_PATH = REPO / "adapters" / "alpamayo" / "manifest.json"
























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


def test_every_quant_row_declares_who_measured_it():
    """A UI must badge a receipt differently from a citation without parsing
    prose. So the class is data, and it has to agree with the note it sits
    beside - a row claiming measured-here whose note carries no measurement
    would be the same lie in a new field."""
    from simforge_alpamayo.families import FAMILIES

    classes = {"measured-here", "vendor-published", "unmeasured"}
    for family in FAMILIES.values():
        for offer in family.quants:
            assert offer.evidence in classes, (family.family, offer.quant)
            # measured-here means WE have figures in the note.
            assert (offer.evidence == "measured-here") == ("MEASURED" in offer.note), (
                family.family,
                offer.quant,
            )
            # An unmeasured row must never carry a VRAM floor as if it were known.
            if offer.evidence == "unmeasured":
                assert offer.min_vram_gib is None, (family.family, offer.quant)
            # A supported row must rest on somebody's evidence.
            if offer.status == "supported":
                assert offer.evidence in {"measured-here", "vendor-published"}


def test_the_bf16_rows_are_citations_and_the_nf4_rows_are_receipts():
    """The specific confusion this fixes: on this host nf4 was measured and
    bf16 never ran, yet both read 'supported'."""
    from simforge_alpamayo.families import get_family

    for family in ("alpamayo-1", "alpamayo-1.5"):
        offers = {offer.quant: offer for offer in get_family(family).quants}
        assert offers["bf16"].evidence == "vendor-published"
        assert offers["nf4"].evidence == "measured-here"
        assert offers["fp8"].evidence == "unmeasured"

    # A2's bf16 IS ours - measured on the H100.
    a2 = {offer.quant: offer for offer in get_family("alpamayo-2-super").quants}
    assert a2["bf16"].evidence == "measured-here"
    assert a2["nf4"].evidence == "unmeasured"
