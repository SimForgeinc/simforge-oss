"""Qwen adapter pins, catalog and lock must describe one model."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re
import sys

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "adapters" / "qwen-drive" / "src"))

from simforge_qwen_drive.families import (  # noqa: E402
    CODE_REVISION,
    FAMILY,
    MODEL_REPO,
    MODEL_REVISION,
    QWEN_DRIVE,
    checkpoint_digest,
)

LOCK = json.loads((REPO / "packages/model-store/models.lock.json").read_text())
CATALOG = (REPO / "packages/model-store/src/catalog.ts").read_text()
MANIFEST = json.loads((REPO / "adapters/qwen-drive/manifest.json").read_text())


def test_family_lock_catalog_and_manifest_pins_agree() -> None:
    entry = LOCK["models"][FAMILY]
    assert entry["weights"]["repo"] == MODEL_REPO
    assert entry["weights"]["revision"] == MODEL_REVISION
    assert entry["code"]["commit"] == CODE_REVISION
    assert entry["runtime"]["package"] == QWEN_DRIVE.package
    assert f"weightsRevision: '{MODEL_REVISION}'" in CATALOG
    assert f"codeRevision: '{CODE_REVISION}'" in CATALOG
    assert f"weightsRepo: '{MODEL_REPO}'" in CATALOG
    manifest_family = MANIFEST["families"][FAMILY]
    assert manifest_family["heads"] == {"planner-sft": "planner-sft", "planner-rl": "planner-rl"}


def test_every_qwen_model_file_has_sha256_and_size() -> None:
    files = LOCK["models"][FAMILY]["weights"]["files"]
    assert len(files) >= 6
    for file in files:
        assert file["digestSource"] == "hf-lfs"
        assert re.fullmatch(r"[0-9a-f]{64}", file["sha256"] or "")
        assert file["sizeBytes"] > 0
        assert file["blobId"] is None


def test_checkpoint_digest_is_ordered_safetensor_identity() -> None:
    files = LOCK["models"][FAMILY]["weights"]["files"]
    shards = [(file["path"], file["sha256"]) for file in files if file["path"].endswith(".safetensors")]
    assert checkpoint_digest(shards) == LOCK["models"][FAMILY]["weights"]["checkpointDigest"]


def test_weight_and_head_sizes_match_pins() -> None:
    entry = LOCK["models"][FAMILY]["weights"]
    files = entry["files"]
    assert sum(file["sizeBytes"] for file in files) == entry["totalBytes"]
    assert sum(file["sizeBytes"] for file in files if file["path"].endswith(".safetensors")) == entry["weightBytes"]
    assert entry["files"][-1]["path"] == "planner-rl/model.safetensors"
