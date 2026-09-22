"""Binding identity corpus, Python side: the PyO3 sampler must reproduce the
digests the Rust crate committed (native/crates/simforge-core/tests/
render_timeline_identity.rs) and the WASM binding reproduces too."""

from __future__ import annotations

import hashlib
import json
import math
import struct
from pathlib import Path

import pytest

import simforge_oss_timeline as st

REPO = Path(__file__).resolve().parents[3]
CORPUS = json.loads((REPO / "fixtures/render-timeline/identity-corpus.json").read_text())
CANONICAL_NAN = struct.pack("<Q", 0x7FF8000000000000)


def probe_times(t: list[float]) -> list[float]:
    out: list[float] = []
    for i, ti in enumerate(t):
        out.append(ti)
        if i + 1 < len(t):
            out.append((ti + t[i + 1]) / 2.0)
            out.append(ti + 0.3 * (t[i + 1] - ti))
    return out


def build(case: dict) -> st.Timeline:
    trace = (REPO / case["trace"]).read_bytes()
    h = case["height"]
    kwargs = {"flat_z": h["z"]} if h["kind"] == "flat" else {"plane": (h["z0"], h["gx"], h["gy"])}
    return st.Timeline.from_json(st.build_timeline(trace, catalog_digest=case["catalogDigest"], **kwargs))


def test_corpus_is_for_this_sampler() -> None:
    assert CORPUS["samplerVersion"] == st.SAMPLER_VERSION


@pytest.mark.parametrize("case", CORPUS["cases"], ids=lambda c: c["id"])
def test_python_reproduces_the_rust_digests(case: dict) -> None:
    tl = build(case)
    assert tl.key == case["timelineKey"]
    assert tl.sha256 == case["timelineSha256"]
    digest = hashlib.sha256()
    actors = tl.actor_ids
    for t in probe_times(tl.times):
        for actor in actors:
            for v in tl.pose_array(actor, t):
                digest.update(CANONICAL_NAN if math.isnan(v) else struct.pack("<d", v))
    assert digest.hexdigest() == case["poseDigest"]
