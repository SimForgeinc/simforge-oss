# Native migration qualification (BASE)

Reference inventory, source-intake manifest and the executable harness that
compares the current TypeScript engine against a native candidate on real
checked-in scenarios. Nothing here fabricates a result: a scenario a candidate
did not produce is `not-run`, a scenario the current stack cannot compile is a
recorded failure, and historical figures stay evidence of their own revision.

## Layout

| Path | Contents |
|---|---|
| `manifest/intake-manifest.json` | Exact source revisions (experimental `1e2a63b` worktree, release `2a69e50`, merge base `7ee40d1`), per-file SHA-256 at copy time and after edits, files removed after copy with reasons, excluded generated/large trees, external assets by identity, and the semantic decisions taken where experimental and release diverged. |
| `manifest/source-inventory.json` | Component → capability → consumer → migration destination matrix for the reference stack. |
| `scenarios.json` | Pinned scenario set: 13 checked-in `scenario-instance` files (12 curated edge cases with recorded 0.4.0 traces plus the only checked-in `when`/ttc-triggered instance); 14 compiled entries (9 portable templates on pinned matcher sites with `expectedInputHash` witnesses, 2 retained compile-identity failures, 3 ambient-traffic populations through the compiler `ambient`/settle path); 2 frozen SituationProgram fixtures (Blender-exported generated geometry with a compareSituation presence pair; recorded-to-policy authority handover with a declared open-loop policy); 5 threshold-near derivations. Every input is an existing simulated fixture or derived from one through current compiler/engine APIs — none is a real-world measurement. |
| `fixtures/` | Frozen situation fixtures: `generated-geometry/` (program.json revision 1 from the Blender workbench adoption, geometry-binding.json, retained descriptor/GLB/effect artifacts by sha256, declared sensor and proxy-removal transactions) and `recorded-policy-handover/` (program.json whose customTimedRoute is an engine-recorded reference track, policy schedule). |
| `tolerances.json` | Frozen tolerance classes (`replay`: byte identity; `conformance`: cross-language numeric bounds). Frozen before any native output exists. |
| `protocols.json` | The separately owned protocols (NuRec original-20, training-24, twin evidence fork, render qualification, physics goldens, situation benchmark) with their retained evidence paths. `status` only checks reachability and hashes; it never runs them. |
| `harness.mjs`, `lib/signature.mjs` | The executable harness. |
| `reference/experimental-1e2a63b-20260905/` | A stored reference run recorded against the experimental checkout's built `dist` (stack identity inside `run.json`). |
| `runs/` | Local output (git-ignored). |

## Running

```sh
# What is reachable on this machine; executes nothing.
node qualification/native-migration/harness.mjs status [--packages-root DIR]

# Record the TypeScript reference (one fresh process per scenario; first
# iteration is cold, the rest warm; default 5 iterations).
node qualification/native-migration/harness.mjs record --out qualification/native-migration/runs/<name> [--repeats 5] [--only id,id] [--packages-root DIR]

# Compare a candidate directory laid out like a reference run
# (<id>/signature.json + <id>/numeric.json.gz per scenario).
node qualification/native-migration/harness.mjs compare --reference DIR --candidate DIR [--class conformance|replay] [--out report.json]
```

`--packages-root` (or `SIMFORGE_PACKAGES_ROOT`) selects which built
`packages/{engine,compiler}/dist` executes; it defaults to this repository, so
the workspace must be built first. Maps resolve through the compiler's
`DEV_ASSETS` (`SCEN_DEV_ASSETS` or the map-registry cache). Exit codes:
`record` 0 all completed / 2 some failed / 3 packages not built; `compare` 0 all
pass / 2 any fail / 4 nothing failed but some not-run.

Threshold-near variants are derived at record time (`thr-*`): the base run is
sampled once with `AdvanceOptions.conditions` over a grid of thresholds around
the authored value; adjacent grid values whose first-true tick differs bracket a
crossing and become `<id>-t<threshold>` variant scenarios with their own
`instance.json`. Each variant records the predicted first-true time and the
actual `trigger_fired` time. Situation fixtures (`sit-*`) run through
`rehearseSituation`/`compareSituation`; a comparison writes the base leg in the
scenario directory and the intervention leg under `intervention/`.

Each reference scenario directory holds `signature.json` (discrete transitions,
compared exactly), `numeric.json.gz` (per-tick channels, compared against the
tolerance class on co-present ticks), `trace.json.gz` (the engine trace),
`engine-result.json` (issues, arrival solutions), `result.json` (phase timings
cold vs warm: moduleLoad, instanceLoad, compile, mapLoad, simulate, digest,
serialize; completed/failed iteration counts; replay stability across the
iterations) and, for compiled entries, `instance.json` — the exact compiled
input a native candidate must consume.

## A native candidate

A Rust runner qualifies by writing the same layout: for every scenario id in
`scenarios.json`, a `signature.json` in the `simforge.native-migration.signature/v1`
shape produced by `lib/signature.mjs` (`discreteSignature`) and a
`numeric.json.gz` (`numericSignature`). Compiled, ambient, situation and threshold entries must run the
`instance.json` recorded by the reference run (and `runtime.json` when present),
never re-match sites, regenerate traffic or re-derive thresholds. For
`sit-recorded-policy-handover` the candidate must implement the fixture's
`policy` schedule on its action channel; for `sit-generated-geometry-proxy` it
consumes the compiled base and `intervention/instance.json` inputs (the
generated proxy is already a static actor with `catalog:gallery.generated.<sha>`).
`compare --class conformance` is the cross-language gate; `--class replay` is
only meaningful for the same build on the same hardware.

## Observations from the stored reference run (2026-09-05)

Executed read-only against `/home/path/simforge-oss` `dist` (engine 0.6.0,
trace format 4, sensor-limited ego; stack identity in `run.json`). 63 scenario
rows: 61 completed and replay-stable across 5 iterations, 2 retained
compile-identity failures; 5 threshold derivations (34 variants, every
predicted first-true time equal to the actual `trigger_fired` time).
Self-compare in the `replay` class: 62 pass, 2 `reference-failed`, exit 0.

- `pin-ec-08-zipper-merge-lane-closure`: the current matcher accepts no site on
  `yale-street` for the checked-in template (pinned site `24a30f9561137117`
  rejected). `pin-ec-04-child-emerging-behind-bus`: pinned site matches,
  materialisation fails with `signal_unbindable` (`feature:jx:focus-vehicle`
  is not controlled at junction 345 in the installed signal catalog). Both stay
  recorded; the nine `cmp-*` entries carry `expectedInputHash` pins that all
  matched, so current compile identity is witnessed by valid sites.
- Ambient traffic: 40/64/40 generated actors placed for the city/heavy/moderate
  entries; warm `simulate` medians 15.8 s, 25.3 s and 16.5 s per 20 s clip
  (the 20 s settle prologue is inside the compile phase, not simulate).
- `sit-generated-geometry-proxy`: compareSituation reports changedRoles and
  changedTracks `[barrier]` with no invariant failures; the observer's sensor
  status never exceeds 1 (occluded) in the base leg and reaches 3 with the proxy
  removed. All 158 program source artifacts and the 5 retained geometry
  artifacts verified by sha256 on this workstation.
- `sit-recorded-policy-handover`: one authority transition at 6 s
  (recorded→policy, `situation-authority-recorded-ego-1`) with the handover
  state recorded; `ego-stopped` first true at 19.24 s; no collision; 700 hook
  calls for the policy interval.
- All twelve curated recorded traces (engine 0.4.0) differ from the current
  engine in `inputHash` and `traceDigest` with 3–8 discrete mismatches each
  (header `ego` stamp, lane hand-off timing, metric pair identity). That is
  retained engine evolution between 0.4.0 and 0.6.0, not a port result; the
  native port is compared against the fresh reference, never those files.

Warm `simulate` medians for the authored scenarios ranged 84–574 ms per 20 s
clip (1001 ticks); cold map load 240–407 ms; cold compile 104–1222 ms. Timings
are single-workstation observations for the phases named, not a performance
claim.

## Native candidate adapter contract

A candidate run directory must contain, for every id listed in the reference
`run.json` `scenarios` (including `<thr-id>-t<threshold>` variants and, for a
comparison fixture, `<id>/intervention/`):

- `signature.json` — `simforge.native-migration.signature/v1` as produced by
  `discreteSignature` (header identities, `tickCount`, per-actor presence
  intervals, lane and motion-direction transitions, signal phase transitions,
  the ordered event list, collision/trigger metrics and metric pair ids);
- `numeric.json.gz` — `numericSignature` (`t`, per-actor `present` plus
  `x`, `y`, `headingRad`, `speedMps`, `lateralOffsetM`, `s`, and the metric
  values).

Inputs the candidate consumes come from the reference directory only:
`instance.json` (checked-in path for `instance` rows; recorded file for
compiled/ambient/threshold/situation rows) and `runtime.json`
(`ambientReactivity` for `amb-lane-shift-heavy-reactive`). The handover fixture
additionally requires implementing `fixtures/recorded-policy-handover/fixture.json`
`policy` on the candidate's action channel exactly as described there.
