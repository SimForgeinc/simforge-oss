# PR #23 native GPU e2e evidence (camera/phase-1-completion @ d5a744ac7)

RTX 5080, Richmond Field Station map, ws-b richmond-06 scenario, frame 12 of each 320x180 stream.

- `roll-comparison.png`: baseline | PR #23 as-is (+10 deg authored roll, rendered CLOCKWISE) | diagnostic run with `rollDeg` not negated (CCW)
- `baseline-front-rgb-f12.png`, `pr23-rolled-front-rgb-f12.png`, `diagnostic-passthrough-rolled-f12.png`: the raw frames
- `landmark-chase-f12-annotated.png`: the chase-camera frame with the predicted landmark pixel (160, 90) boxed
- `engine.e2e.log`: vitest output of `engine.e2e` on the PR head
