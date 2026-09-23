"""Semantic rasters must preserve ego axes, classes and obstacle visibility."""
from pathlib import Path
import sys

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from simforge_qwen_drive.perception import encode_grid


def test_rle_preserves_class_indices_across_row_boundaries():
    # Top-left means forward-left in the documented, already-oriented input.
    labels = np.array([[1, 0, 0], [0, 0, 2]], dtype=np.uint8)
    grid = encode_grid(labels, (0, -3, 4, 3), ("empty", "left", "right"), ((0, 0, 0), (1, 2, 3), (4, 5, 6)))
    decoded = np.repeat(grid["data"][::2], grid["data"][1::2]).reshape(grid["height"], grid["width"])
    np.testing.assert_array_equal(decoded, labels)
    assert grid["resolutionM"] == [2.0, 2.0]


def test_downsample_never_interpolates_semantic_classes():
    labels = np.full((400, 200), 9, dtype=np.uint8)
    labels[:200] = 1
    grid = encode_grid(labels, (-30, -15, 30, 15), tuple(str(i) for i in range(10)), ((0, 0, 0),) * 10)
    decoded = np.repeat(grid["data"][::2], grid["data"][1::2]).reshape(grid["height"], grid["width"])
    assert decoded.shape == (128, 64)
    np.testing.assert_array_equal(decoded[:64], np.ones((64, 64), dtype=np.uint8))
    np.testing.assert_array_equal(decoded[64:], np.full((64, 64), 9, dtype=np.uint8))


def test_projection_preserves_ego_axes_and_visible_obstacles():
    from simforge_qwen_drive.perception import compact_bev

    # Upstream map axes are Y,X; occupancy axes are X,Y,Z.
    road_map = np.zeros((3, 4), dtype=np.uint8)
    road_map[2, 3] = 4
    road_map[0, 2] = 2
    occupancy = np.full((4, 3, 3), 9, dtype=np.uint8)
    occupancy[3, 2] = [7, 0, 8]  # vehicle, not overhanging background, wins
    occupancy[2, 0, 0] = 4
    result = compact_bev({
        "map": road_map, "occ": occupancy,
        "boxes": [], "scores": [], "labels": [],
    })
    for name, forward_left, forward_right in (("map", 4, 2), ("occupancy", 0, 4)):
        grid = result[name]
        decoded = np.repeat(grid["data"][::2], grid["data"][1::2]).reshape(grid["height"], grid["width"])
        assert decoded.shape == (4, 3)
        assert decoded[0, 0] == forward_left
        assert decoded[1, 2] == forward_right
