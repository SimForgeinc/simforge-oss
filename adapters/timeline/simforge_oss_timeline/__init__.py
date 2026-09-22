"""SimForge render timeline: the shared sampler for Python renderers.

``pose(timeline, actor_id, t)`` is the same Rust function the editor (WASM)
and the Bevy renderer use, so the same timeline bytes and ``t`` give
bit-identical poses in every consumer. Contract:
``docs/engineering/render-timeline.md``.

Frame: OpenSCENARIO world / xodr-local (right-handed, z up, heading CCW from
+x); pitch > 0 is nose down, roll > 0 is right side down. ``t`` is
clip-relative seconds on ``[0, clip_end_s]``; the warm-up is never sampled.
"""

from ._native import (
    POSE_ARRAY_LEN,
    RENDER_TIMELINE_VERSION,
    SAMPLER_VERSION,
    TIMELINE_DT_S,
    Timeline,
    build_timeline,
    compare_observed,
    pose,
    timeline_key,
    trace_sha256,
)

__all__ = [
    "POSE_ARRAY_LEN",
    "RENDER_TIMELINE_VERSION",
    "SAMPLER_VERSION",
    "TIMELINE_DT_S",
    "Timeline",
    "build_timeline",
    "compare_observed",
    "pose",
    "timeline_key",
    "trace_sha256",
]
