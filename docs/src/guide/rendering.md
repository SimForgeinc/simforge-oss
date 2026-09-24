# Rendering: presets and rigs

There is one renderer with two presets:

| Preset | For |
|---|---|
| `training` | datasets and closed loop: the passes models consume, at a fixed cost per frame |
| `showcase` | video: the same scene with the expensive lighting and post-processing on |

Both replay the package's render timeline: poses come from the trace, never
from a second simulation, so a render of the same package is the same scene
on any machine. Pixels are exactly reproducible per adapter (see
[Reproducibility](reproducibility.md)).

A rig (`--rig rig.json`) lists the sensors: cameras (with a
[camera profile](../reference/camera-profiles.md)), lidar and radar.
