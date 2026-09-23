"""Static signal locations must reach the checkpoint's binary map channel."""
from pathlib import Path
import sys

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from simforge_auto_e2e.nav_raster import CH, rasterize, to_pixels, world_to_ego


def test_single_signal_location_is_rasterized_without_stale_pixels():
    # Pre-W0 failure: _draw_polyline iterated segments only, silently dropping
    # single-point signal markers while diagnostics counted them as filled.
    pose = {"x": 70.0, "y": 0.0, "yawRad": 0.0}
    point = [[90.0, 0.0]]
    graph = {"trafficSignals": [{"points": point}], "stopLines": [{"points": [[90, -1.75], [90, 1.75]]}]}
    raster, _, diagnostics = rasterize(graph, pose, [[70, 0], [110, 0]])
    row, col = np.rint(to_pixels(world_to_ego(point, pose))[0]).astype(int)
    assert diagnostics.signals_filled == 1
    assert raster[CH["traffic_signal"], row, col] == 1
    assert raster[CH["stop_line"], row, col] == 1
    cleared, _, _ = rasterize({}, pose, [[70, 0], [110, 0]])
    assert not cleared[CH["traffic_signal"]].any()
