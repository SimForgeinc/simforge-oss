# Simulation results: worker-authoritative, content-addressed

A scenario is simulated **once**, by the host, under a content key. Every
consumer replays that result: the editor (after verifying its own preview),
renders (through the render timeline), exports (the xosc is derived from the
trace), evaluation and datasets. The client uploads nothing but the document.

```
trace = simulate(resolvedInput, mapClosure, engineSemantics)
```

## Identities

| Name | Definition |
|---|---|
| `resolvedInputDigest` | `executionSourceInputDigest(resolvedInput)`: sha256 of the canonical JSON of the input the engine resolves. Equals the trace header's `inputHash`. |
| `mapClosureDigest` | `H(simforge.map-closure/v1, browserClosureSha256, colliderDigest)`: the published browser closure the editor loads plus the verified static-collider artifact built into the graph. |
| `traceSha256` | The engine's native `traceDigest()` of the trace, never the gzip bytes. |
| `simKey` | `H(simforge.sim-key/v1, resolvedInputDigest, mapClosureDigest, engineSemVer, solverVer, traceSchema[, trafficStepKey])`. Build digests are provenance (`engine_build`), never key material, so a rebuild with unchanged semantics hits the cache. `trafficStepKey` is present only when an external traffic step (server-side SUMO) merged actors into the trace. |
| request key | `H(simforge.sim-request/v1, simContentSha256, mapVersionId, browserClosureSha256, catalogSha256, engineSemVer, engineBuild, pipeline, sumo)`, where `sumo` is `{sumoNetworkSha256, wasmSha256}` for SUMO documents and `null` otherwise: a memo of what a document resolves to, not an identity. A miss only costs one re-resolution that dedupes into the same `simKey`. |
| `timelineSha256` | WS-B: `sha256(canonicalJson(timeline))`; the timeline is derived from the trace and the map's height source. |

The editor's scenario worker and `simulateAuthoritative` (`@simforge-oss/compiler/node`)
run the same pipeline over the same map members: the editor's own
`loadMapGraph`, fed from the browser asset members (colliders included). Measured
on real documents, the editor's WASM trace and the host's N-API trace are
byte-identical.

## Studio refinements are engine semantics

What the engine executes for a document includes the Studio refinements. They
are native (`simforge_compiler::studio_refinements`, exposed as
`EngineRuntime.studioConcreteInput` and `EngineRuntime.executionRefinements`),
so the editor's WASM worker, the host, the compiler and the CLI run one
implementation:
- `studioConcreteInput(input, document)`: `studio.presentation.bodyColor`
  paint tags on role actors, then the baked parked cars of
  `studio.ambientTraffic.parkedCars.v1` as static cars.
- `executionRefinements(input)`: a yaw-rate cap on high-speed best-effort world
  routes, and cruise restoration when a bounded speed action releases.

A change to them is covered by `ENGINE_SEM_VER` like any engine change. The
move from TypeScript kept every digest. `studio-refinements.golden.test.ts`
cross-checks the native code against a frozen copy of the TypeScript (inputs
and traces), and `studio-refinements.richmond.test.ts` locks the Richmond
paint, parked-car and ambient digests recorded before the move.

## Storage

| Table | Role |
|---|---|
| `simforge.sim_results` `(workspace_id, sim_key)` | Immutable memo: identities, `engine_sem_ver`, provenance, object keys, traffic artifact and ambient provenance, timeline. A trigger refuses any change to a stored trace. |
| `simforge.sim_requests` `(workspace_id, request_key)` | The unit of work and the in-flight join: queued, then running under a fenced lease (inline in the API, or a CPU runner), then succeeded or failed. An expired lease can be claimed again. |
| `simforge.revision_simulations` `(workspace_id, revision_id, engine_sem_ver)` | Binds a revision to the result it renders. `origin = 'lazy'` marks a revision committed before (or under another engine than) its result; the UI reports it as re-simulated. |
| `simforge.sim_verification_events` | The editor's local-vs-authoritative comparisons. A mismatch is a determinism bug. |
| `render_jobs.sim_key / trace_sha256 / timeline_sha256` | What each render replays. |

Objects, under the workspace prefix of the artifact bucket:

- `sim/sha256/<traceSha256>.trace.json.gz`: the engine trace (deterministic gzip).
- `sim/resolution/sha256/<sha>.json.gz`: the resolution record (`simforge.sim-resolution/v1`), holding the exact input the trace ran, the materialization manifest, and the ambient provenance and actor ids. Exports and replayers consume it instead of resolving the document again.
- `timelines/sha256/<timelineSha256>.json`: the render timeline's canonical JSON, uncompressed, so sha256 of the object equals `timelineSha256` (the `render.timeline` render input).
- `materialized-traffic/sha256/<sha>.json`: traffic derived from the trace, bound to revisions for the execution package contract.

Results are workspace-scoped. The same content in two workspaces is simulated
once per workspace, which keeps tenancy isolation intact.

## Flows

**Editor.** It always runs its local WASM simulation, labelled "Local preview".
Once the draft is saved it calls `POST /documents/:id/simulation`, which returns
the memoized result, joins the execution in flight, or runs it inline. It then
compares its trace digest with the result's:
- Equal: shows "Verified".
- Different: fetches the authoritative trace (Cache Storage, filed under
  `traceSha256`), shows it, flags the mismatch and records it
  (`POST /simulations/:simKey/verification`). SUMO documents preview their
  authored actors only, so they are verified against `authoredTraceSha256`.
  While they wait, the editor draws the display-only browser SUMO preview. Once
  verified, it swaps in the authoritative trace (keeping the playhead) and
  replays the worker's SUMO vehicles from it. Those vehicles exist only in the
  trace, never in the scenario input: playback identifies them by their trace
  `origin` (`sumo`), keeps them out of the authored-actor identity checks,
  renders them from the trace's actor metadata and shows them read-only as
  traffic.

A document with no authored actors (a map, optionally with traffic) resolves
to the blank world both the editor and the host build from
`emptyScenarioBaseInput` (`@simforge-oss/compiler`), so it simulates and
verifies like any other.

**Revision commit.** `POST /documents/:id/revisions {expectedVersion}`. The host
resolves the draft's simulation (waiting up to 20 s on another executor, or
answering `409 simulation_pending`), binds the server-derived traffic evidence,
and links the result with `origin = 'commit'`.

**Render.** `POST /render-jobs` resolves the revision's simulation. For old
revisions that means simulating lazily, once. It stamps `sim_key`,
`trace_sha256` and `timeline_sha256`, and binds the timeline into the intent as
the `render.timeline` asset. Ten renders of one revision share one simulation.

**Compile.** The export claim carries the revision's simulation (the trace and
resolution record, presigned and digest-pinned). The compiler exports the xosc
from them with `replayTrace`. It never resolves, materializes traffic or
simulates. Exports queued before this pipeline carry `simulation: null` and
compile the legacy way.

**CPU runner.** `POST /internal/sim-jobs/claim` → simulate → `reserve` →
checksum-bound PUTs → `complete`. The host verifies every object and records the
result. A completion with a stale fence is refused. Scenario errors fail the
request; infrastructure errors requeue it. `SIMFORGE_SIMULATION_INLINE=0` routes
every request to runners.

**SUMO traffic.** A SUMO document's traffic is part of its simulation. Every
executor (the API inline, the local worker lane and the SC runner) builds the
step the same way, with `hostTrafficStep` (`@simforge-oss/compiler/node`):
the map version's `derived/sumo/` members, verified against
`map_versions.sumo_network_sha256`, and the pinned SUMO runtime, staged once
per process from the runtime bucket (`uniscenario/sumo-runtime/<version>/`)
or from the claim's presigned URLs. The authored actors run with ambient off,
SUMO runs one-way against that trace, and its vehicles are merged into the
stored trace (see `sumo-worker-traffic.md`). A runner claim for a SUMO
document carries the network members and the runtime; other claims do not. A
SUMO document on a map version without a SUMO network fails with
`sumo_network_unavailable`. The editor verifies its preview against
`authoredTraceSha256` and then replays the stored trace, so its in-browser
SUMO preview stands down.

**Evaluation.** `POST /simulations/:simKey/evaluation` grades the stored trace
with the native evaluator.

## Migration from saved simulations

The saved-simulation upload, the materialized-traffic evidence upload and the
render-submit re-simulation are removed. `simulation_previews` rows are no
longer written or read, and existing revisions keep their evidence and
execution packages. The first render of an old revision simulates it under the
current engine semantics and reports that it was re-simulated. Stored traces
are immutable: an engine change produces a new key, never a rewrite.
