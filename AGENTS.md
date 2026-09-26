# AGENTS.md: working in simforge-sdk

This repository is the SimForge SDK: the deterministic engine, the renderer,
the `simforge` CLI and the Python gym and adapters. It is public (Apache-2.0).
It is a read-only mirror of `sdk/` in SimForge's platform repository, where the
SDK is developed and where the hosted SimForge app (https://simforge.ai) builds
from it directly (see "Where development happens").

## Layout

| Path | What |
|---|---|
| `Cargo.toml` | the one Cargo workspace (native/crates/*, renderer/*); vendored Bevy under `[patch.crates-io]`; one `Cargo.lock` |
| `native/` | crates: `simforge-core` (engine, traces, render timeline), `simforge-compiler`, `simforge-session`, `simforge-bindings-common`, `simforge-bindings-python` (the gym's `_native`), `simforge-timeline-python`, the `simforge` CLI (`crates/simforge-cli`), `simforge-package`, `simforge-assets`, `simforge-authoring` |
| `renderer/` | crates: `simforge-render` (Bevy; one renderer, presets `training` and `showcase`), sensors, viewport, C ABI (`ffi`), vendored Bevy patches (`vendor/`) |
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
- **No licensed-dataset content.** Third-party recorded-drive datasets and
  their reconstructions are licensed and not redistributable. Nothing from
  them, or derived from them, enters this repository, its fixtures, its
  releases or its commit messages. Every export is leak-scanned before it is pushed.
- **No secrets, ever.** Never print a token or credential, and never commit one,
  not even in a log, a test fixture or a PR comment. Never shell-source an
  env file; pass values by named key.

## Checks

```sh
scripts/check-boundary.sh  # self-contained Rust + Python, no TypeScript
cargo nextest run --workspace --exclude simforge-bindings-python --exclude simforge-timeline-python   # one workspace
cd adapters/gym && uv run --with pytest python -m pytest -q
qualification/golden-harness/ci-local.sh verify   # lavapipe render goldens; needs mesa-vulkan-drivers + map corpora
scripts/gate-local.sh      # all of the above at once (the nightly goldens run uses it)
```

## Where development happens

This repository is a read-only mirror. The SDK is developed upstream, in the
private SimForge platform repository (at `sdk/`), where every change is gated
together with the hosted app that consumes it. Each change to `sdk/` on the
upstream main is exported here within minutes as one commit
(`Export simcloud-platform <sha>`); nobody pushes `main` here by hand.

Pull requests are welcome: a maintainer imports them upstream by hand (with
credit) and closes the PR here once the export carries the change. Releases are
cut by tagging an export commit here (`release.yml`).

## Decisions that shape this repository

- **One source for the engine, the renderer, the scenario package, the CLI and the
  Python gym and adapters**: this tree. Upstream it lives at `sdk/` of the platform
  repository, which the hosted app builds from directly; this repository mirrors it.
- **Every CLI command is public, authoring included**: `template`, `sites`,
  `instantiate`, `batch`, `catalog`, `locations`, `variation`, `export`,
  `validate`, `evaluate`, `evidence verify` and `simulate`, plus the runtime
  commands `package`, `maps list`, `maps pull`, `assets pull`, `timeline build`,
  `render`, `env serve` and `doctor`, and the account commands `login`,
  `logout`, `auth status` and `whoami`. The CLI is Rust only; it knows a
  SimForge host by name and discovers its endpoints (RFC 8414), so nothing
  private is compiled in.
- **The ingest contract is the scenario package** (`simforge.scenario-package/v1`,
  `docs/engineering/scenario-package.md`), with a `producer {app, appVersion,
  minCli}` field. The hosted app's "Export for CLI" writes it through the same
  crate. Its `map/closure.json` is the map release's canonical closure.
- **CARLA is public: bring your own CARLA 0.10.** No private images and no
  Unreal Engine content here. The Alpamayo adapter is code only (weights come
  from Hugging Face under their terms).
- **Large assets are not in git.** Actor models and sky plates are
  content-addressed closures on the CDN, fetched and verified by digest
  (`simforge assets pull`). Git keeps the manifests and the attribution.
- **Goldens are recorded on CPU Mesa lavapipe,** the adapter of record. GPU
  renders are fingerprinted evidence, not gates.
- **The docs for users are the agent skills (`skills/`, `simforge skills
  install`), the README and `--help`.** There is no separate docs website.
- **Releases** are cargo-dist binaries (Linux, and macOS and Windows on
  GitHub-hosted runners, the only cloud CI), a `ghcr.io/simforgeinc/simforge`
  container, the `simforge-oss-*` PyPI wheels and a Homebrew tap
  (`simforgeinc/tap/simforge`). They are signed keyless with Sigstore and
  carry SLSA provenance and an SBOM. The maintainers approve v0.2 to v0.4 as
  stable; after that, a release goes stable automatically after 48 h green.

## Status and roadmap

Done: the rename from `simforge-oss` and the removal of Studio and all
TypeScript; one Cargo workspace; the Rust port of every authoring command,
with parity against the former implementation; the scenario-package crate
with `package verify|inspect|import`; model and sky closures served by
digest; sandboxed merge gates.

In flight:
- `package import` resolves the canonical and web closures, with a default rig
  and the sky-closure fetch (#51).
- The v0.2.0 release pipeline (#24): cargo-dist, signing, SBOM, container,
  wheels and skills.
- Canonical-JSON numbers printed exactly as ECMAScript does (#39, draft). It
  moves map closure digests, so it lands together with new versions of every
  map.
- The `simforge env serve` Gymnasium socket client.

