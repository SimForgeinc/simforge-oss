# simforge-oss-timeline

Python binding of the SimForge render timeline. It exposes the shared sampler
`pose(timeline, actor_id, t)`, the same Rust function the editor (WASM) and
the Bevy renderer call. Given the same timeline bytes and the same `t`, every
consumer gets bit-identical poses.

```python
from simforge_oss_timeline import Timeline, pose

tl = Timeline.load("scenario.timeline.json.gz")
p = pose(tl, "focus-vehicle", 3.04)   # or tl.pose(...)
# p == {"present": True, "x": ..., "y": ..., "z": ..., "headingRad": ...,
#       "pitchRad": ..., "rollRad": ..., "speedMps": ..., "velocity": [...], ...}
tl.poses(3.04)          # every actor at t
tl.signals_at(3.04)     # {signalId: indication}
tl.lights_at("focus-vehicle", 3.04)
```

The pose frame is the OpenSCENARIO world frame (xodr-local): right-handed,
z up, heading measured counter-clockwise from +x. Pitch > 0 means nose down
and roll > 0 means right side down. `t` is clip-relative seconds on
`[0, clip_end_s]`. The warm-up is never sampled.

The full contract is in `docs/engineering/render-timeline.md`.

Build: `maturin develop --release` (from this directory).
