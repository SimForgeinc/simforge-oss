# Determinism claim: what is byte-exact, what is not

This page scopes SimForge's byte-exactness claim. Every "yes" below is backed
by a test or golden that the merge gate (`scripts/gate-local.sh`) runs.

## The claim, in four tiers

| Tier | Scope | Byte-exact? | Evidence |
| --- | --- | --- | --- |
| 1. Symbolic engine + traces | `simforge-core` ticks, trace JSON, `simforge evidence verify` (a trace is the run of an instance by input hash) | **Yes.** Fixed 20 ms step, integer/canonical serialization, transcendental math through the core's own port; re-simulation reproduces byte-identical traces on any hardware | The golden-trace corpus (`fixtures/golden-traces/`, verified by `native/crates/simforge-cli/tests/simulate.rs`); see `engine-semver.md` |
| 2. Render timeline | Poses sampled from a trace by the shared sampler (`simforge.render-timeline.v1`) | **Yes.** The Rust core and the Python binding reproduce the committed digests bit for bit | `native/crates/simforge-core/tests/render_timeline_identity.rs`, `adapters/timeline/tests/test_identity.py`, over `fixtures/render-timeline/identity-corpus.json` |
| 3. Renderer passes (`simforge-render`) | RGB, instance-ID, semantic and depth passes from the native Bevy renderer | **Yes on the adapter of record** (Mesa lavapipe, keyed by the adapter fingerprint): every golden is rendered twice at record time with identical pass hashes. On NVIDIA GPUs the ID pass is run-to-run stable but RGB differs by at most 1 LSB in a handful of pixels (driver-level). Cross-adapter: **not claimed** | `qualification/golden-harness/` and `native-golden-ci.md` |
| 4. Browser viewers | Any WebGL/WebGPU view of a scenario (for example the hosted app's editor) | **No.** Not part of the SDK and not byte-stable; never an identity | none |

## Consequences

1. **RGB frame hashes are never replay or evidence identity.** Trace and
   instance hashes (tier 1) and render-timeline digests (tier 2) are the
   binding identity; render manifests record RGB hashes as diagnostics.
2. **Render goldens are keyed, not universal.** A golden is valid only for the
   exact tuple recorded in it: adapter fingerprint (lavapipe build and CPU
   model) × renderer binary × render config × scene inputs. A new Mesa, LLVM or
   CPU model means recording on that host first.
3. **Any training or perception gate that consumes RGB from a real GPU** must
   treat renderer output as approximately reproducible: identical inputs give
   frames that are identical except for rare 1 LSB differences, not identical
   bytes.
4. **Cross-hardware RGB reproducibility is explicitly not claimed.** See the
   `verdict.scope` field in every golden manifest.

## Reproducing

```sh
# Tier 1: re-simulate every ci golden case and compare digests
cargo nextest run -p simforge-cli --test simulate

# Tier 2: render-timeline identity (Rust); the Python side runs under pytest
cargo nextest run -p simforge-core --test render_timeline_identity
(cd adapters/timeline && uv run --with pytest python -m pytest -q)

# Tier 3: build the renderer, then verify every recorded golden on lavapipe
# (needs the Richmond and Yale corpora; see native-golden-ci.md)
qualification/golden-harness/ci-local.sh verify
```

`qualification/golden-harness/ci-local.sh record` re-records the goldens; the
harness refuses to write a golden unless two runs agree byte for byte.
