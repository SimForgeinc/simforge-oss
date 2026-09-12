# simforge-oss-gpu — `roadway-dynamic-gpu-v1`

Warp/CUDA batched execution of the current roadway semantics for state-based
RL: N independent `EnvSession`-equivalent episodes of one admitted
`SimScenarioInput`, stepped by compiled device kernels with device-resident
reset, action application, dynamic-v1 force-based motion, sequential-impulse
contacts, trigger/condition program, observations, rewards, termination and
checkpoint state.

This is a **new execution profile identity**. Scientific inputs (dt, substep,
vehicle profiles, controller gains, reward weights, tolerances) are the
reference engine's; the numerical implementation is separately qualified.
Nothing here is a claim of measured CPU/GPU equivalence or speed-up — the
tooling to measure both is in this package and is run by the qualification
owner.

## What is admitted

`compile_scenario(document, graph, episode)` admits a document only when every
feature it uses is in the supported set of `simforge_oss_gpu.profile.CAPABILITIES`
and every capacity in `CAPACITIES` holds. Otherwise it raises
`ProfileAdmissionError` listing **all** issues (feature, path, reason); nothing
is approximated or dropped. In short:

| supported | rejected |
|---|---|
| `physics.mode = dynamic-v1` (substep, per-actor `vehicleProfiles`, child pedestrian tag), a legacy `kinematic-v1` pin migrating to it | any other `physics.mode` |
| all actor kinds, `static` actors as infinite-mass bodies, `presentAtStart` + `exist` | `ambient` tag, sensors |
| `lanePath` routes, `rules`, `drivingProfile`, `cruiseSpeedMps`, `motion:reverse` | `follow`, `polyline`, `timedPolyline` routes |
| verbs `speed` (all modes), `gap`, `exist`; triggers `at`, `after`, `when`; `window`, `until`, all `dynamics` | `changeLane`, `laneOffset`, `route`, `set`; `arrival` |
| conditions `distance`, `headway`, `speed`, `standstill`, `collision`, `reaches`, `and/or/not` | `ttc`, `signal`, `visible`, `detected` |
| uniform `frictionScale`, `trafficSpeedFactor`, `visibilityRangeM`; collidable props; occluders | signals/road controls, surface patches, attached props, occlusion pairs, perception |
| `EnvAction` setpoints, preview and `control` passthrough; state vector + object list; all reward weights; `goal.interactionId`; `maxDecisions` | BEV raster, host callbacks |

## API

```python
from simforge_oss_gpu import LaneGraph, RoadwayGpuBatch, ActionBatch

graph = LaneGraph.load("topology-index.json.gz")
batch = RoadwayGpuBatch(document, graph, num_worlds=4096, episode={"decisionHz": 10}, device="cuda:0")
lease = batch.reset()                     # OutputLease: owned device arrays at t = 0
obs = lease.torch()                       # zero-copy torch views, stable until lease.release()
actions = ActionBatch.hold_choreography(4096, batch.device)  # or ActionBatch.from_torch(values, valid)
nxt = batch.step(actions)                 # one decision for every non-ended world
lease.release(consumer_event)             # producer waits for your stream event device-side
```

* Outputs are **owned leases** from a bounded ring (`lease_slots`). Tensors are
  created from a lease-owned `__cuda_array_interface__` producer that Torch's
  storage deleter retains, so `detach()`, dtype views, slices and DLPack
  re-imports all keep the slot retained; handback happens when `release()` was
  called *and* the last such storage is freed. Exhausting the ring raises
  `LeaseExhaustedError`. The batch runs on its own producer stream; consumer
  streams are registered by `lease.torch(stream)` and ordered with events, and
  `ActionBatch.from_torch(..., stream)`/`mark_ready` order policy output into
  `step` — no host synchronisation.
* Ended worlds are skipped on device until they appear in a `reset(mask)`.
* `checkpoint()` / `restore()` carry the complete mutable device state plus
  profile/document/topology/episode identity.
* `capabilities()` reports profile id, numerics (`device-f64`), capacities and
  compiled counts for the runner and bindings.
* Steady state launches kernels and device-to-device copies only (optionally a
  captured CUDA graph). There is no per-world Python loop and no host scalar
  synchronisation; `lease.numpy()` exists for diagnostics and conformance.

## Numerics and determinism

All device arithmetic is binary64. Same-batch replay is bit-identical
(`ReproducibilityClass.SAME_BUILD_REPLAY`); agreement with the CPU reference is
`CROSS_BACKEND_MEASURED` under the frozen tolerances in
`simforge_oss_gpu.conformance.TOLERANCES`. Known identity differences are
listed in `profile.NUMERICS_NOTES` (code-point id ordering, libdevice
transcendentals, events reduced to per-decision flags).

## Runner job protocol (`simforge.gpu-batch-rollout/v1`)

```sh
python -m simforge_oss_gpu job --params params.json --out-dir DIR [--resume DIR/checkpoint/checkpoint-*.npz]
python -m simforge_oss_gpu capabilities --no-probe
```

`params.json`: `inputPath`, `topologyPath`, `numWorlds`, `decisions` (required);
`episode` (EpisodeConfig object), `actions` (`"hold"` or a JSON array of
EnvAction per decision, cycled), `device` (`cuda:0`), `seeds`,
`checkpointEveryDecisions` (0 = never), `leaseSlots`. Unknown keys are rejected.
stdout JSONL: `progress {decision, timeS, worldsEnded}`, `checkpoint {path}`,
`done {artifacts: [{relativePath, sha256, sizeBytes}]}` (exit 0) or after
SIGTERM a final checkpoint and `canceled` (exit 130); stderr
`{"event":"error", code, message}` with exit 1 (`bad-params`) or 2
(`admission`, `capacity`, `backend`). Artifacts: `rollout.json` (per-world
return/length/termination + capabilities) and `decisions.jsonl.gz` (per-decision
rewards, ended flags and SHA-256 digests of the observation/reward arrays).

## Qualification tooling (not run by this package's author)

* `node adapters/gpu/tools/reference-rollout.mjs` — dumps a reference
  `EnvSession` rollout JSONL for a document/episode/action sequence.
* `simforge-oss-gpu-conformance --input … --topology … --actions … --rollout …`
  — replays the same actions on device and reports exact discrete transitions
  and per-channel tolerance violations; `--worlds N` adds cross-world identity.
* `simforge-oss-gpu-qualify --input … --topology … --batch-sizes 1,16,256,4096`
  — cold/warm decisions-per-second by batch size, ≥ 5 repeats.
