# SUMO traffic on workers

SUMO ambient traffic is simulated once, on a worker. It is baked into the
authoritative trace. Every consumer replays it from there: editor playback,
Evaluation, the render timeline, Bevy and CARLA. No consumer runs traffic
itself. The editor's in-browser SUMO is a display-only preview.

```
resolve(document) ──► simulate(authored actors, ambient off) ──► authored trace
                                                                     │
          map version: derived/sumo/map.net.xml + sidecar ──┐        │
          pinned runtime: SUMO 1.27.1 WASM (e93c0014…) ─────┼──► SUMO step ──► materialized traffic
          resolved input: signalPrograms, roadControls ─────┘        │
                                                                     ▼
                                              merge ──► authoritative trace (SUMO actors, origin "sumo")
```

Code: `packages/engine/src/ambient/sumo-traffic.ts` holds the step,
`sumo-signals.ts` the traffic lights, `sumo-demand.ts` the demand,
`sumo-trace-merge.ts` the merge, `sumo-traffic-step.ts` the simulate-job
adapter, `sumo-audit.ts` the red-light audit and `sumo-node.ts` the Node
runtime loader. `simforge traffic sumo <scenario>` runs the whole pipeline on
one host.

## Runtime: the pinned WebAssembly build, not libsumo

Workers run the same SUMO 1.27.1 WebAssembly module the editor uses
(`sumo.wasm`, sha256 `e93c0014…3e93`). `loadSumoRuntime` refuses any other
digest.

WebAssembly arithmetic is specified bit for bit: IEEE-754 binary64, no fused
multiply-add contraction, no x87 excess precision, and a libm compiled into
the module. One module digest therefore produces the same trajectories on
every CPU and operating system. The eclipse-sumo wheels, by contrast, are
per-platform native builds, and they inherit the host compiler's FMA and SIMD
choices and the system libm.

Each run instantiates a fresh module, so no libsumo static state (id counters,
parser caches) crosses jobs. A 20 s clip with a 60 s pre-roll takes about
2–7 s of CPU time.

## Fixed step and coupling order

The step is **0.02 s**, the trace grid (dt is enforced at 0.02 everywhere).
SUMO keeps time in integer milliseconds, so every step is exact and no
resampling is needed.

Coupling is **one-way**:
- The authored actors are simulated first, by the engine, with native ambient
  traffic off. That authored trace is fixed input.
- SUMO sees the authored actors as occupancy proxies: hidden vehicles moved
  each step with `moveToXY`. Pedestrians and cyclists that touch a driving
  lane are included, with a short look-ahead sweep.
- Nothing SUMO does ever changes an authored track, the signal book or the
  engine metrics.

Order:

1. **Pre-roll, 60 s.** The authored proxies are held at their t = 0 pose with
   speed 0 while the demand departs and spreads over the network. SUMO time 0
   is scene time −60 s.
2. **Frame 0** is the state after the pre-roll.
3. **Frame k (k ≥ 1)** is produced in this order:
   1. Upsert every authored proxy at its trace pose at t_k, in id order, and
      remove the proxies whose actor left the road or the world.
   2. Advance SUMO one step. Ambient vehicles plan against the proxies'
      previous positions, so they react with one step (20 ms) of latency. The
      proxies land at t_k.
   3. Read every SUMO-driven vehicle, map it to the scene frame, quantize it
      and record it.

Demand is the editor's actor-centred demand: 70/20/10 local/approach/background
routes around the authored actors. Two differences in the worker:
- **Corridor exclusion.** Routes that drive along a lane an authored actor
  drives are dropped, as the native generator does. Under one-way coupling an
  authored car never yields, so ambient traffic in its lane would be run into.
- **Isolated proxy route.** Proxies use a route on an edge no candidate uses.
  When SUMO cannot insert a proxy because its spot overlaps another body, the
  bridge leaves it pending forever. Such a proxy is recorded in
  `unplacedProxies` and is never re-upserted, and at worst it appears where no
  ambient vehicle drives.

## Identity

```
key = sha256(canonicalJson({
  schema: "simforge.sumo-traffic-key/v1", couplingVersion,
  sourceInputDigest,            // resolved input
  authoredTraceSha256,          // the trace SUMO reacted to (covers engineSemVer)
  sumoNetworkSha256,            // derived/sumo/map.net.xml bytes
  sumoBuild: { version: "1.27.1-7717f237", wasmSha256 },
  profile,                      // resolved ambient profile (seed, density, mix, …)
  stepSeconds, durationSeconds, preRollSeconds
}))
```

The architecture report keyed traffic by
`H(resolvedInputDigest, sumoNetSha, sumoBuild, profile)`. This key adds
`authoredTraceSha256`: SUMO reacts to the authored trace, and that trace
depends on the engine semantics as well as the input.

The simulate job folds the key into `simKey` as `trafficStepKey`.

`SUMO_TRAFFIC_COUPLING_VERSION` must be bumped whenever the coupling, demand,
signal rewrite or quantization changes the output bytes.

## Output

The artifact is `uniscenarios.materialized-traffic.v1` with provider
`{ id: "sumo", version: "1.27.1-7717f237", seed }`, on the trace grid, with
`signals: []`. The merge turns it into ordinary trace actors:

- **id:** `sumo-<fnv1a32 of the SUMO vehicle id>`, stable across identical
  runs and URL-safe, so a SUMO vehicle can carry a render sensor. A teleported
  vehicle continues as `<id>-t<n>` (see below).
- **metadata:** `kind: "car"`, dims 4.55 × 1.82 × 1.48 m (the same body SUMO
  car-following uses), `static: false`, and tags
  `["ambient", "catalog:vehicle.sedan", "sumo"]`. The render timeline derives
  `origin: "sumo"` from the tags, and the merge also sets
  `actorMetadata[id].origin = "sumo"`.
- **membership:** each SUMO actor is listed in `ambientActorIds`, so it is
  excluded from criticality metrics, and `header.materializedTrafficDigest`
  names the artifact bytes.
- **tracks:** xodr-local `(x, y = −z)`, heading, speed, `present`, and `s`
  equal to the distance driven.
- **playback:** these actors are trace-only. `parsePlaybackPair` accepts them
  by origin, renders them from the metadata above (a `catalog:*` tag or the
  kind decides the model, so a trace that carries a vehicle class renders it)
  and leaves the authored identity checks strict. Every SUMO vehicle is a
  sedan today because the demand has one vehicle type; classes need a demand
  and coupling-version change here, not a playback change.

### Float32 and the scene frame

The bridge packs positions as float32 network coordinates. netconvert
normalizes the network offset (`--offset.disable-normalization false`), so
coordinates start at the origin. The largest current network is about 630 m,
which gives a float32 spacing of 6.1e-5 m. Runs are refused when the extent
would exceed 2.5e-4 m.

The scene transform (the map's `worldFromNetwork`) runs in float64. Positions
are then quantized to 0.1 mm, headings to 1 µrad and speeds to 1e-4. Heading
wrap uses arithmetic only, with no transcendental calls. The quantization grid
is coarser than any float32 spacing that remains.

### Teleports and lane seams

A vehicle whose position jumps beyond its speed·dt·1.5 + 8 m (a SUMO teleport)
is split: its track ends, and the rest becomes a new actor, so no rendered
vehicle jumps.

Smaller jumps come from seams between registered SUMO lane shapes, up to about
4 m on Yale. They are counted in `laneSeamJumps` and `maxLaneSeamJumpM` and
are a derivative-quality finding, not a traffic error.

## Traffic lights: the SimForge signal book is the only authority

netconvert writes its own tlLogic. On every signalized map checked, it
disagrees with the OpenDRIVE controllers the SimForge book runs:

| Map / junction | netconvert tlLogic | SimForge book (map controllers) |
|---|---|---|
| Richmond 175 | 2 phases, 42 s G + 3 s y per pair of opposing approaches (90 s cycle) | 4 controllers (441→442→443→444) in OpenDRIVE sequence, 12 s green + 3 s yellow each, 60 s cycle, offset 23 s |
| Yale 1094, 118, 273 | netconvert default two/three-phase programs | 3–4 controllers per junction in OpenDRIVE sequence (12 s or 27 s green + 3 s yellow) |
| Yale 361 | a traffic light | **no signal program**: OpenDRIVE stop control on two approaches (`road-control:1313`, `1872`); the other approaches are major |

Running SUMO on netconvert's programs made its vehicles cross against the heads
every renderer draws. In a 120 s Yale audit, 32 of 52 governed stop-line
crossings happened on a rendered red.

The worker therefore rewrites every tlLogic before SUMO starts
(`synthesizeSumoSignalPrograms`):

- **Binding.** Each controlled SUMO link is bound by the engine's own braking
  rule: a program's stop line on the link's approach lane (`origId`), with a
  movement filter that names the link's junction lane.
  - If no program claims the link but netconvert tied it to a head
    (`linkSignalID`) whose program controls the same approach road, that
    program is used (`head` binding). This is a control-plan gap, reported per
    link.
  - SimForge stop controls become `s`. Anything else yields (`o`).
- **State per step.** Every step reads the trace's *recorded* phase, so
  authored `set` overrides are included. The pre-roll uses the SignalBook
  formula, reproduced operation for operation.
  - green → `g`: minor green, so SUMO still applies the junction's foe matrix
    to permissive movements.
  - yellow → `y`. red → `r`. flashing yellow → `o`. flashing red → `s`.
  - dark → the program's `darkFallback` (default all-way stop, `s`).
  - A link governed by several programs shows the most restrictive state.
- **Program shape.** The result is one static program per traffic light, with
  whole-millisecond durations and the last state held for a day.
- **Checks.**
  - `signalAgreement` compares SUMO's live link states with the book at every
    clip step. It is 0 mismatches in every run so far.
  - `auditSumoSignalCompliance` finds every SUMO stop-line crossing in the
    merged trace, identifies the movement taken, and reads the recorded book
    on the governing heads.

The SUMO signal states are never written into the trace: the recorded book
already is the signal channel.

Control-plan findings, reported by `signals.linksBySource`:
- Richmond 175: SimForge binds no right turn except from road 6, and does not
  bind road 6's left turn (link 8). In the book those movements are
  unsignalled for authored actors too.
- Yale 1094: the through lanes 110_4 and 110_5 carry head 1263 but no stop
  line. They are bound by head.
- Yale 273: links 3, 7 and 11 are bound by head.
- Yale 361: SUMO has a traffic light where SimForge has stop control.

## Editor preview

The editor still runs SUMO in the browser, labelled "SUMO preview", so authors
see traffic while editing:

- It obeys the same synthesized programs, built from the preview trace's book.
  It therefore keeps working with authored map signal plans, which used to
  force native traffic.
- It steps at the editor frame rate. That is acceptable only because no
  authoritative data comes from it.
- It stands down as soon as the loaded trace carries worker SUMO traffic
  (`traceCarriesSumoTraffic`).

## Not in the worker (yet)

- **Collision handoff.** The browser releases a struck SUMO car to the native
  contact solver (`TrafficHandoffWorld`), which also releases the authored
  striker. That is two-way coupling, so the worker omits it. SUMO resolves a
  proxy overlap itself: it brakes, and in the worst case teleports, which is
  then split as above.
- **Vehicle variety.** Every SUMO vehicle is a `vehicle.sedan`, as in the
  preview.

## Verification

- **Unit** (`packages/engine/src/ambient/sumo-*.test.ts`): the coupling order
  against a fake bridge, quantization, teleport splitting, key sensitivity,
  signal binding and synthesis, and the merge.
- **Integration** (`packages/cli/src/__tests__/sumo-worker.test.ts`, runs when
  the runtime and the Richmond/Yale derivatives are installed):
  - byte identity across fresh modules;
  - pinned artifact digests;
  - zero signal-agreement mismatches;
  - zero red-light crossings on governed movements;
  - the netconvert programs, by contrast, do cross on red.
- **Cross-machine.** `simforge traffic sumo --out DIR` writes
  `sumo-step-input.json`, which can be replayed anywhere with only the runtime.
  The same digests were reproduced on Linux x64 (Node 22 and 24) and macOS
  arm64 (Apple M4 on Node 20, Apple M5 Pro on Node 26).
