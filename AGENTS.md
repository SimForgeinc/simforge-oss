# AGENTS.md: working in simforge-sdk

This repository is the SimForge SDK: the deterministic engine, the renderer,
the `simforge` CLI and the Python gym and adapters. It is public (Apache-2.0)
and it is the source of truth for that code. The hosted SimForge app
(https://simforge.ai) consumes it at a pinned commit.

## Layout

| Path | What |
|---|---|
| `native/` | Cargo workspace: `simforge-core` (engine, traces, render timeline), `simforge-compiler`, `simforge-session`, `simforge-bindings-common`, `simforge-bindings-python` (the gym's `_native`). `crates/simforge-timeline-python` and `crates/simforge-cli` are their own workspaces |
| `renderer/` | Cargo workspace: `simforge-render` (Bevy; one renderer, presets `training` and `showcase`), sensors, viewport, C ABI (`ffi`), vendored Bevy patches (`vendor/`) |
| `adapters/` | Python: `gym` (`simforge-oss-gym`), `timeline`, `carla-exec` (bring your own CARLA 0.10), `alpamayo` (code only), `auto-e2e`, `ros2-bridge`, `gpu`, `physics` |
| `contracts/`, `fixtures/` | contract locks and the fixtures every consumer is tested against: golden traces, canonical JSON vectors, archive corpus, render-timeline identity corpus, renderer contract, OpenSCENARIO conformance |
| `examples/` | scenario templates (the authoring catalog) |
| `catalog/` | actor catalog manifests and attribution (model blobs are served by content digest) |
| `qualification/golden-harness/` | render goldens on Mesa lavapipe (CPU Vulkan), the adapter of record |
| `docs/` | engineering contracts (engine semver, render timeline, scenario package, ...) |

There is no TypeScript here. `qualification/golden-harness/*.mjs` and
`scripts/actor-assets/closures.mjs` (actor-model closures by digest) are plain
Node with no dependencies; the CLI replaces both (`simforge assets pull`, goldens).

## Rules

- **Determinism is the product.** Trace bytes must not depend on who built the
  engine. A change that moves a golden-trace digest needs the `ENGINE_SEM_VER`
  bump described in `docs/engineering/engine-semver.md`.
- **No silent fallbacks.** Fail with a named error, or record the substitution
  explicitly in the evidence (`docs/engineering/no-silent-fallbacks.md`).
- **One renderer, two presets.** Do not add a second render path.
- **Self-contained.** No path dependency may leave this checkout
  (`scripts/check-boundary.sh` proves it with `cargo metadata`). No private
  hosts, datasets or images: this tree is public.
- **Map-only computation belongs to map ingest,** not to render or simulation time.

## Checks

```sh
scripts/gate-local.sh      # the merge gate: boundary, rustfmt/clippy on touched files,
                           # cargo nextest, pytest of affected packages, lavapipe goldens
cd native && cargo nextest run
cd renderer && cargo nextest run
cd adapters/gym && uv run --with pytest python -m pytest -q
qualification/golden-harness/ci-local.sh verify   # needs mesa-vulkan-drivers + map corpora
```

## Landing

Open a PR against `main` and add the `ready` label once `scripts/gate-local.sh`
passes. The merge service scans the change for private markers, runs the gate
from `main` on the exact merge commit, inside a sandbox (`GATE_SANDBOX=required`:
no credentials, allowlisted network, lavapipe instead of a GPU), and
fast-forwards `main`; nobody pushes `main` by hand. PR comments from the merge
service are public: they carry step results, never host paths or logs with
private content.

After a landing, the hosted platform picks the new commit up through a pin-bump
PR of its own (`sdk: bump to <sha>`), gated against every private consumer of
the SDK. A change that breaks that bump is fixed here or adapted there; the SDK
itself never depends on private code (`scripts/check-boundary.sh`).
