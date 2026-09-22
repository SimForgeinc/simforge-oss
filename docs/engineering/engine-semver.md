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
| `engineSemVer` | Everything in the engine that can move a trace byte: controllers, integration, quantisation, metric definitions, ambient generation, input resolution | `ENGINE_SEM_VER` in `native/crates/simforge-core/src/lib.rs`. Bumped by hand. `engine().version().engineSemVer` (TS), `engineSemVer()` (N-API/WASM), `ENGINE_SEM_VER` (Python) |
| build provenance | Which binary produced a trace: source revision, rustc, profile, target, and `buildDigest` over them | `engine().build()` / `engineBuild()` / `ENGINE_BUILD`. **Provenance only.** It is never part of a key, or every rebuild would miss every cache |
| `mapClosureDigest` | Everything a simulation reads from a map: the topology with speed limits applied, the static colliders after the road-boundary rule, and the signal catalog (`simforge.map-closure/v1`) | Native `MapBundle.closureDigest`. `mapClosureDigest(bundle)` in `@simforge-oss/playback`, `bundle.closureDigest` in `@simforge-oss/compiler` |
| `simContentHash` | The simulation-relevant content of a scenario document (`simforge.sim-content/v1`) | `simContentHash(template)` in `@simforge-oss/scenario` |
| `traceSha256` | The trace itself: `sha256(canonicalJson(quantize(trace)))`, never the gzip bytes | `TraceHandle.digest()` / native `Trace.digest()` |
| canonical JSON | The one serialisation every digest above uses (`simforge.canonical-json/v1`) | `@simforge-oss/scenario/canonical-json` (TS) and `simforge_core::hash` (Rust). Both run `fixtures/canonical-json/vectors.json` |

`engineVersion` (TS, bindings) and `ENGINE_VERSION` (Rust, Python) are the
former names of `engineSemVer` and always carry the same value.

## When to bump `ENGINE_SEM_VER`

Bump it when any golden trace or golden input digest changes, whatever the
cause: physics, controllers, ambient generation, quantisation, trace schema,
or a newly rejected input. Use the major-less scheme we have used so far:

- minor bump: semantics changed;
- patch bump: a fix that moved bytes without changing intent. Still a bump,
  because caches must still miss.

Then run `pnpm golden-traces:update`, add a line to the history comment above
the constant, and commit `fixtures/golden-traces/` with the change. `update`
refuses to rewrite a changed digest under an unchanged version.

Each merge to `main` that changes trace bytes takes its own bump. Two branches
that both bump to the same number conflict in `lib.rs` and in the manifest.
The second to merge takes the next number and regenerates.

## The golden-trace corpus

The corpus lives in `fixtures/golden-traces/`:

- `corpus.json` defines the cases.
- `manifest.json` records, per case, `mapClosureDigest`, `inputHash`,
  `traceSha256`, tick count and actor count, under one `engineSemVer`.
- `inputs/` holds the authored inputs and the resolved ambient and template (ci tier only; private-map inputs are never written)
  inputs; `templates/` holds template fixtures.
- `maps/richmond-field-station/` holds the committed simulation closure of the
  one public map: topology, derived index, locations, xodr, signals, and the
  published static colliders with their manifests.

The cases come in two tiers:

- **`ci`** runs on the committed Richmond closure:
  - a U-turn by a car and by a truck (both end in an eased stop at route end);
  - stop-and-go;
  - three walkers crossing in front of a car;
  - a car driven into a building (static map colliders, collision response);
  - heavy ambient traffic with two seeds, and city ambient traffic;
  - a v2 template (`ltap-opposing`) compiled natively at a pinned site, once
    with the legacy name-derived seed and once with a pinned
    `simulation.seed` (catalog resolution, seeding, materialization).
- **`local`** is the 9-run stop-spin corpus: Richmond, Yale Street and
  El Camino Road × `ambient-1..3`, 60 s, heavy. It runs on installed maps
  (`SIMFORGE_GOLDEN_MAPS_ROOT`, else the map cache's `dev-assets` or
  `map-bundles`) and is skipped where they are absent. Private maps never
  enter the repository; only their digests do.

The authored `ci` inputs are generated once by
`packages/cli/scripts/golden-traces-cases.ts` and committed.

Commands:

```sh
pnpm --filter @simforge-oss/native-runtime build   # N-API addon + WASM
pnpm golden-traces:verify                          # all tiers available here
pnpm golden-traces:update                          # after a bump
pnpm determinism:semver -- --base origin/main      # the CI diff rule
SIMFORGE_GOLDEN_TIERS=all pnpm --filter @simforge-oss/native-runtime exec vitest run src/__tests__/trace-identity.test.ts
```

## CI

The `determinism` job in `.github/workflows/ci.yml` does the following:

1. It installs the pinned toolchain (`rust-toolchain.toml`) and builds the
   N-API addon and the WASM module.
2. **Semver rule** (`scripts/determinism/check-engine-semver.mjs`). It diffs
   the manifest against the merge base. A changed `traceSha256` or `inputHash`
   under an unchanged `ENGINE_SEM_VER` fails the job. So do a bump without a
   regenerated manifest, and a version that went down. A case whose map closure
   changed is a fixture change, not an engine change.
3. **Golden corpus** (`packages/cli/src/__tests__/golden-traces.test.ts`). The
   addon must reproduce every `ci` digest.
4. **Native-vs-WASM identity**
   (`packages/native-runtime/src/__tests__/trace-identity.test.ts`, next to
   `build-agreement.test.ts`). Both builds must assemble the same map closure
   from the same files. That closure must equal the one the editor's loader
   recorded. Both builds must generate the same ambient traffic and produce
   byte-identical canonical traces, equal to the manifest's `traceSha256`.
5. **Renderer parity hook** (`scripts/determinism/renderer-parity.mjs`). The
   cross-renderer pose-parity job (sampler vs Bevy observed frames vs CARLA
   observed transforms) plugs in here once WS-B's comparator lands. Until then
   the step reports that it is skipped.

With the semver rule, the golden corpus and the identity test, a browser trace
and a worker trace under the same `simforge.sim-key/v1` are the same bytes by
construction. The editor's "Verified" comparison monitors that in production.

## Toolchain

`rust-toolchain.toml` pins the compiler for every Rust build in the
repository. The core routes transcendental math through its own port
(`simforge-core/src/math`), so a compiler upgrade should not move a trace. Make
the upgrade in its own change, with the golden corpus and the identity test
green. `rust-version` in `native/Cargo.toml` remains the minimum supported
version.

## Map closure: one constructor

Every host that simulates builds its map through the same path:

- `buildSimulationMapClosure` in `@simforge-oss/playback`. The editor reaches
  it through `loadMapGraph`, which fetches the files.
- `createSimulationMapBundle` + `readInstalledMapClosureFiles` in
  `@simforge-oss/compiler`, for workers, the CLI and the corpus. They read the
  same files from disk or S3.

Both verify the published static-collider artifact with
`verifyStaticColliderArtifact` and fail closed without it. The native bundle
applies the road-boundary thickness rule itself, so a host that hands it
unfiltered colliders still simulates the same map. The installed-directory
loader (`MapBundle.load`, used by `loadMap`) finds the colliders in the
published `3d/variants/` layout. It previously looked only at `variants/`, so
CLI and server runs were silently collision-free.

`createMapBundle` without `staticColliders` is for non-simulating callers only:
control plans, matching and authoring previews.

## Derived artifact: the ambient turn-verdict table

Since 0.9.0 the ambient generator probes every tight junction transition with
the dynamic-v1 plant before it routes a vehicle through it. Cold, that costs
0.5 s on Richmond and 3–4 s on San Ramon, in both the WASM and N-API builds.
The verdicts are a pure function of the simulation closure and
`ENGINE_SEM_VER`, so they are a published map derivative:

- **Member:** `derived/ambient/turn-verdicts.json.gz` in the map's browser
  closure. It is gzipped canonical JSON, `simforge.ambient-turn-verdicts/v1`:
  `{schema, engineSemVer, closureDigest, classes, verdicts:
  [[transitionFingerprint, knownMask, feasibleMask], ...]}`, with one row per
  transition. Richmond: 546 transitions (4,368 verdicts), 20 KB gzipped. San Ramon phase 1:
  4,825 transitions (38,600 verdicts).
- **Key:** `(engineSemVer, closureDigest)`. A host loads the table only when
  both match its own engine and the closure it built
  (`loadShippedAmbientTurnVerdicts`). The engine itself also refuses another
  semver. A table changes timing, never the generated population.
- **Producers:**
  - The map build's web-runtime stage (`runMapPipeline({ ambientTurnVerdicts })`,
    passed by `simforge maps build|ingest`; `SIMFORGE_MAP_AMBIENT_VERDICTS=skip`
    opts out). The engine semver is part of the stage key, so a bump rebuilds
    the table.
  - `pnpm maps:ambient-verdicts -- --map <id>|--all [--check]` for installed
    maps.
  - SimCloud's `reconcile-ambient-turn-verdicts` for published map versions.
    It rebinds the version to a new closure with the table and records
    `descriptor.ambientTurnVerdicts`. Draft pins are unaffected, because they
    cover the simulation members only (`docs/engineering/document-pinning.md`).
- **Consumers:**
  - The editor's scenario worker: the descriptor's `ambientTurnVerdicts`
    becomes a closure URL, `loadMapGraph` fetches it through the map cache, and
    the worker falls back to its Cache Storage table (`ambient-turn-cache.ts`).
  - Workers and the CLI: `createSimulationMapBundle` loads the shipped member,
    then the disk cache (`restoreAmbientTurnVerdictsFromDisk`).
