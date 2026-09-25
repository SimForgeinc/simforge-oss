# Engine semantics version, golden traces and build identity

A simulation result is a cache entry of a pure function:

```
trace = simulate(resolvedInput, mapClosure, engineSemantics)
```

This page defines the identities in that function, and the CI rules that keep
them honest.

## Identities

| Identity | What it covers | Where it comes from |
|---|---|---|
| `engineSemVer` | Everything in the engine that can move a trace byte: controllers, integration, quantisation, metric definitions, ambient generation, input resolution | `ENGINE_SEM_VER` in `native/crates/simforge-core/src/lib.rs`. Bumped by hand. The Python wheel exports it as `ENGINE_SEM_VER` |
| build provenance | Which binary produced a trace: source revision, rustc, profile, target, and `buildDigest` over them | `simforge_bindings_common::engine_build_json()` (`ENGINE_BUILD` in Python). **Provenance only.** It is never part of a key, or every rebuild would miss every cache |
| `mapClosureDigest` | Everything a simulation reads from a map: the topology with speed limits applied, the static colliders after the road-boundary rule, and the signal catalog (`simforge.map-closure/v1`) | `MapBundle::closure_digest` (`simforge-compiler`); `simforge simulate` reports it for the map it loaded |
| `simContentHash` | The simulation-relevant content of a scenario document (`simforge.sim-content/v1`) | Recorded by the authoring host as `scenario.simContentSha256` in a scenario package (`scenario-package.md`) |
| `traceSha256` | The trace itself: `sha256(canonicalJson(quantize(trace)))`, never the gzip bytes | `SimTrace::digest()` (`simforge-core`) |
| canonical JSON | The one serialisation every digest above uses (`simforge.canonical-json/v1`) | `simforge_core::hash`, checked against `fixtures/canonical-json/vectors.json` (`native/crates/simforge-core/tests/canonical_json_vectors.rs`). Any other implementation must pass the same vectors |

`ENGINE_VERSION` (Rust, Python) is the former name of `engineSemVer` and
always carries the same value.

## When to bump `ENGINE_SEM_VER`

Bump it when any golden trace or golden input digest changes, whatever the
cause: physics, controllers, ambient generation, quantisation, trace schema,
or a newly rejected input. Use the major-less scheme we have used so far:

- minor bump: semantics changed;
- patch bump: a fix that moved bytes without changing intent. Still a bump,
  because caches must still miss.

Then, in the same change:

1. add a line to the history comment above the constant;
2. set `engineSemVer` in `fixtures/golden-traces/manifest.json` to the new
   version;
3. replace each moved case's `traceSha256` and `inputHash` in the manifest with
   the re-simulated values (`simforge simulate` reports both; the golden test
   below prints them when it fails).

There is no update script and no automatic diff against the merge base, so the
rule "a changed digest needs a bump" is enforced in review: a diff to
`manifest.json` that changes a digest without changing `engineSemVer` is
rejected.

Each merge to `main` that changes trace bytes takes its own bump. Two branches
that both bump to the same number conflict in `lib.rs` and in the manifest.
The second to merge takes the next number and regenerates.

## The golden-trace corpus

The corpus lives in `fixtures/golden-traces/`:

- `corpus.json` defines the cases.
- `manifest.json` records, per case, `mapClosureDigest`, `inputHash`,
  `traceSha256`, tick count and actor count, under one `engineSemVer`.
- `inputs/` holds the authored inputs and the resolved ambient and template
  inputs (ci tier only; private-map inputs are never written); `templates/`
  holds template fixtures.
- `maps/richmond-field-station/` holds the committed simulation closure of the
  one public map: topology, derived index, locations, xodr, signals, and the
  published static colliders with their manifests.

The cases come in two tiers:

- **`ci`** runs on the committed Richmond closure:
  - a U-turn by a car and by a van (both end in an eased stop at route end);
  - stop-and-go;
  - three walkers crossing in front of a car;
  - a car driven into a building (static map colliders, collision response);
  - heavy ambient traffic with two seeds, and city ambient traffic;
  - a v2 template (`ltap-opposing`) compiled at a pinned site, with the
    legacy name-derived seed, with a pinned `simulation.seed`, and with the
    CARLA catalog (catalog resolution, seeding, materialization).
- **`local`** is the 9-run stop-spin corpus: Richmond, Yale Street and
  El Camino Road × `ambient-1..3`, 60 s, heavy. Its digests are recorded in
  the manifest, but it needs installed private maps and no test in this
  repository runs it. Private maps never enter the repository; only their
  digests do.

## How the corpus is verified

`native/crates/simforge-cli/tests/simulate.rs` is the lock. For every `ci`
case it writes a workspace the way a package import lays one out (the
resolved input, and a manifest carrying the golden `traceSha256` under the
manifest's `engineSemVer`), runs `simforge simulate` on it against the
committed Richmond closure, and asserts:

- `deterministicMatch` is `true`. `simforge simulate` only expects a match when
  the package's `engineSemVer` equals the binary's `ENGINE_SEM_VER`, so a bump
  without updating the manifest fails here;
- the re-simulated `traceSha256`, `inputHash`, tick count and actor count equal
  the manifest's, so a digest change without regenerating the manifest fails
  here;
- the committed closure's digest equals the manifest's `mapClosureDigest`.

The same file checks that a different trace under the same engine is reported
as `determinism_violation` (exit 2), and that another engine or a seed
override expects a different trace.

Related locks in `native/crates/simforge-core/tests/`:
`canonical_json_vectors.rs` (the serialisation), `render_timeline_identity.rs`
(render-timeline digests over `fixtures/render-timeline/identity-corpus.json`,
replayed by the Python binding in `adapters/timeline/tests/test_identity.py`)
and `archive_corpus.rs` (stored traces from past releases keep their identity
and motion).

Commands:

```sh
cargo nextest run -p simforge-cli --test simulate     # the golden-trace corpus
cargo nextest run -p simforge-core                    # canonical JSON, timeline identity, archive corpus
scripts/gate-local.sh                                 # the merge gate (below)
```

## CI

There is no hosted CI job for determinism. The merge service lands a PR only
after `scripts/gate-local.sh` passes on the exact merge commit. Its `rust` step
runs `cargo nextest` over the whole workspace, which includes the golden-trace
test above and the `simforge-core` identity tests, whenever a Rust input
changed; its `goldens` step renders the lavapipe goldens
(`qualification/golden-harness/ci-local.sh verify`, see
`native-golden-ci.md`) when the renderer or the engine core changed. The
render goldens include `parity` scenes that grade the renderer's observed
actor transforms against the render-timeline sampler.

With the version rule and the golden corpus, two hosts that link the same
`simforge-core` produce the same trace bytes for the same
`simforge.sim-key/v1`.

## Toolchain

`rust-toolchain.toml` pins the compiler for every Rust build in the
repository. The core routes transcendental math through its own port
(`simforge-core/src/math`), so a compiler upgrade should not move a trace. Make
the upgrade in its own change, with the golden corpus and the identity tests
green. `rust-version` in the root `Cargo.toml` remains the minimum supported
version.

## Map closure: one constructor

Every host that simulates builds its map through the same path:
`MapBundle` in `simforge-compiler`, reached through
`simforge_bindings_common::MapAsset::load` (the CLI's `load_world`, the Python
wheel, and any other binding). It reads the installed map directory: topology,
derived index, locations, xodr, signals and the published static colliders.

The loader verifies the published static-collider artifact and fails closed
without it (`simforge simulate --allow-no-colliders` is the explicit opt-out).
It finds the colliders in the published `3d/variants/` layout. The bundle
applies the road-boundary thickness rule itself, so a host that hands it
unfiltered colliders still simulates the same map.

A bundle without static colliders is for non-simulating callers only:
control plans, matching and authoring previews.

## Derived artifact: the ambient turn-verdict table

Since 0.9.0 the ambient generator probes every tight junction transition with
the dynamic-v1 plant before it routes a vehicle through it
(`simforge-compiler/src/ambient_turns.rs`). Cold, that costs about 0.5 s on
Richmond and several seconds on larger maps. The verdicts are a pure function
of the simulation closure and `ENGINE_SEM_VER`, so they are a map derivative,
computed at ingest and published with the map:

- **Member:** `derived/ambient/turn-verdicts.json.gz` in the map's closure. It
  is gzipped canonical JSON, `simforge.ambient-turn-verdicts/v1`:
  `{schema, engineSemVer, closureDigest, classes, verdicts:
  [[transitionFingerprint, knownMask, feasibleMask], ...]}`, with one row per
  transition. Richmond: 546 transitions (4,368 verdicts), 20 KB gzipped. A
  full scenario package embeds it when the map's closure lists it
  (`CLI_WEB_MEMBERS_EXACT` in `simforge-package/src/closure.rs`).
- **Key:** `(engineSemVer, closureDigest)`. The engine refuses a table from
  another `engineSemVer`, and each row is keyed by a content fingerprint of its
  transition, so a verdict never applies to a transition it was not computed
  for. The ingest stage that builds the table keys on both, so a bump rebuilds
  it. A table changes timing, never the generated population: a host without
  it computes the same verdicts cold.
- **API:** `simforge_bindings_common::build_ambient_turn_verdicts_json`
  computes the table for a loaded map; `load_ambient_turn_verdicts` installs a
  shipped one. Map ingest (hosted) is the producer; hosts that link the engine
  are the consumers.
