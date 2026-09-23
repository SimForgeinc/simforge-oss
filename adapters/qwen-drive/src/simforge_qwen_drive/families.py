"""Pinned Qwen-Drive model and source descriptors.

The lock file remains the byte-integrity authority.  These small descriptors
keep setup scripts and adapter tests from silently drifting away from it.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib

FAMILY = "qwen-drive-1.0"
MODEL_REPO = "Qwen/Qwen-Drive-1.0-4B"
MODEL_REVISION = "28484089a7cc8c335cf5089fb0745cf7c49b6eaa"
CODE_REPO = "https://github.com/QwenLM/Qwen-Drive-1.0"
CODE_REVISION = "28091c1532e869bc7aee91fc0aef6b3e6fd0b2e0"
CODE_TREE_SHA = "095fd5f7fd3d193ed025222c57bf364c1bd63ab3"
PACKAGE = "qwen_drive"
WEIGHT_BYTES = 13_238_109_612
TOTAL_BYTES = 13_261_075_008
CAMERA_SENSOR_IDS = (
    "camera_front_wide_120fov",
    "camera_cross_left_120fov",
    "camera_cross_right_120fov",
)
CAMERA_IDS = (1, 0, 2)
FRAME_OFFSETS_S = (-1.5, -1.0, -0.5, 0.0)
PLANNER_HEADS = ("planner-sft", "planner-rl")


@dataclass(frozen=True)
class QwenDriveFamily:
    family: str = FAMILY
    model_repo: str = MODEL_REPO
    model_revision: str = MODEL_REVISION
    code_repo: str = CODE_REPO
    code_revision: str = CODE_REVISION
    package: str = PACKAGE
    weight_bytes: int = WEIGHT_BYTES
    total_bytes: int = TOTAL_BYTES
    camera_ids: tuple[int, ...] = CAMERA_IDS
    camera_sensors: tuple[str, ...] = CAMERA_SENSOR_IDS
    planner_heads: tuple[str, ...] = PLANNER_HEADS


QWEN_DRIVE = QwenDriveFamily()


def checkpoint_digest(files: list[tuple[str, str]]) -> str:
    """Derive model identity from ordered safetensor path/digest pairs."""
    hasher = hashlib.sha256()
    for path, digest in sorted(files):
        hasher.update(f"{path} {digest}\n".encode())
    return hasher.hexdigest()
