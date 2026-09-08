# Closed-Loop Evaluation Campaigns (P4)

Scenario × seed × policy episode grids run **sequentially** through the native
gym episode runner (`adapters/gym`, `python -m
simforge_oss_gym.tools.policy_runner`), scored with SimForge-native metrics,
persisted as immutable artifact directories with an append-only ledger, and
deterministically rerunnable.

Model-independent: reference policies (`scripted`, `trajectory`, `torch`) and a
real model endpoint (`endpoint`) plug into the same runner, the same
`docs/policy-step.md` action wire and the same artifacts. The `endpoint` policy
talks `simforge.policy-endpoint/v2` MessagePack to a live engine socket with
real rendered camera frames; frames never cross HTTP.

- Scoring: `packages/evaluation/src/scoring.ts`
- Campaigns: `packages/evaluation/src/campaign.ts`, CLI
  `simforge-eval-campaign` (`campaign-cli.ts`)
- Process boundary shared with the cloud worker:
  `packages/evaluation/src/episode-runner.ts`
- Example config: `packages/evaluation/fixtures/mini-w3.campaign.json`

## CLI

```sh
simforge-eval-campaign run    --config campaign.json   # run / resume
simforge-eval-campaign rerun  --config campaign.json --episode <id>
simforge-eval-campaign report --config campaign.json   # report.json + report.md
```

During development: `pnpm --filter @simforge-oss/evaluation exec tsx src/campaign-cli.ts …`.

## Campaign config

```jsonc
{
  "campaignId": "mini-w3",
  "runsRoot": "~/simforge-assets/runs",
  "decisionHz": 10,
  "suite": [{
    "scenarioId": "synthetic-leadcar",       // [a-z0-9-]
    "spec": "synthetic-leadcar.episodes.json", // env-server form-A episode spec, relative to this file
    "session": 0,                             // instance index inside the spec
    "steps": 120,                             // decision budget
    "expectedRouteM": null,                   // null → ego cruiseSpeed × clipSeconds
    "speedLimitMps": null,                    // null → authored lane speedLimitKph (topology), engine default 13.4
    "replayContext": null,                    // simforge.replay-context/v1 bundle dir → envelope enforcement
    "frameSource": null                       // "dir:<path>" | "bevy:<rig.json>", required by `endpoint`
  }],
  "seeds": [101, 202, 303],
  "policies": [{
    "policyId": "scripted", "runnerPolicy": "scripted",  // or "trajectory" | "torch" | "endpoint"
    "policySeed": 0,
    "mode": "offline-simtime",                // or "realtime" with an explicit deadlineMs
    "deadlineMs": null,                       // required in realtime, forbidden offline
    "fallback": "zero-control", "forceMissAt": []
  }, {
    "policyId": "alpamayo-1-5-nf4", "runnerPolicy": "endpoint",
    "endpointSocket": "/tmp/simforge-alpamayo.sock",
    "cameraProfile": "alpamayo-4cam",
    "replanHz": 0.5,                          // ZOH between replans
    "numTrajSamples": 1,
    "model": { "family": "alpamayo-1.5", "revision": "7aba8293…", "quant": "nf4" },
    "warmupPolicy": "scripted", "warmupSteps": 16,
    "mode": "offline-simtime"
  }]
}
```

### Timing modes

A policy declares exactly one, and the trace, `score.json` and `result.json`
all carry it. The UI must never label an offline run "real-time".

| mode | contract |
|---|---|
| `offline-simtime` (default) | The engine pauses at every inference barrier: nothing advances until the decision returns. No deadline exists, `dl.miss` is 0 by construction, and slow hardware costs wall time — not scientific validity. The only mode for remote jobs and reconstructed scenes. |
| `realtime` | Wall-clock schedule with an explicit `deadlineMs`; the measured latency decides, a miss applies `fallback`, and `score.json` reports the miss rate. `forceMissAt` exercises the fallback deterministically. |

Configuring a deadline offline, or `forceMissAt` without a deadline, is a
config error — the schema rejects it rather than silently ignoring the field.

### Model endpoints and replay-context scenes

An `endpoint` policy needs a real camera source: `frameSource` is mandatory and
is either frames a renderer already produced (`dir:<path>`, one directory per
sensor id, `<step>.raw|png|jpg`) or the resident renderer (`bevy:<rig.json>`).
There is no synthetic camera source; a missing one refuses the episode.

Before the evaluated policy acts, `warmupSteps` decisions are driven by
`warmupPolicy` so the model receives 16 **real** ego poses and 4 real frames
per camera. Warm-up steps are labelled `warmup:<policy>` in the trace and
excluded from `model_decisions`; the observation is never padded to fake a
history (`--allow-cold-start` exists and stamps `coldStartUsed` in provenance).

With `replayContext` set, the runner enforces the bundle's measured validity
envelope every decision. Leaving it stops the episode at the breach with
`term_reason: envelope_exceeded`; the episode is scored up to that point and
reported `status: partial`, `truncation: envelope_exceeded` — an invalid
episode, never a successful result and never a model failure. A bundle whose
`validity.qualified` is false (or whose G5 stock-replay gate failed) is refused
before any episode runs.

## Artifact layout

Under `<runsRoot>/<campaignId>/`:

| file | content |
|---|---|
| `campaign.json` | frozen resolved spec; fixture sha256s pin immutability — resuming with changed inputs is refused |
| `ledger.jsonl` | append-only, one line per completed episode; readers take the last line per `episodeId` |
| `report.json` / `report.md` | aggregation (per-scenario table, aggregate driving score, infraction histogram) |
| `<episodeId>/` | `episodeId = <scenarioId>__<policyId>__seed<seed>` |

Per episode: `trace.jsonl` (rich runner trace: decoded `sv`, `objs`, reward
`terms`, the acting policy `pol`, whether the model replanned, the envelope
measurement `env`, chained digests), `events.json` (per-event records with tick
+ position), `score.json`, `provenance.json` (model `{family, revision,
checkpointDigest, quant, cameraProfile, rngProvenance}`, input `{kind, ref,
digest}`, controller, adapter version + git sha, seed, schedule, episode
digest, fixture digest), `runner-summary.json`, `runner-stderr.log` when the
runner wrote to stderr, a `COMPLETE` marker, and **`result.json`** —
`simforge.eval-result-manifest/v1`, written LAST and atomically.

`result.json` is the one document both hosts and the cloud control plane read:
`status` (`succeeded` | `partial` | `failed` | `cancelled`), `scored`,
`promotable`, `mode`, `truncation`, `metrics`, digest-listed `artifacts[]`,
provenance and timing. `scored` is independent of `status`: a truncated episode
is scored up to the breach yet is `partial` and not promotable.

## Kill / resume

Resume is idempotent by construction: episodes with a `COMPLETE` marker are
skipped untouched. An episode directory without one is moved aside as
`<episodeId>.evidence-<timestamp>/` and rerun — a failed or cancelled attempt's
trace is retained as evidence rather than deleted, and is never presented as a
result. Killing the runner at any instant loses at most the in-flight episode.
The ledger is append-only across resumes and records every episode's
`status`/`runnerStatus`/`scored`/`truncation`.

## Determinism

`rerun` re-executes a completed episode into `<campaign>/.rerun/<episodeId>`
and compares the chained `episode_digest` plus a sha256 over the trace with
wall-clock `timing` stripped. Deterministic policies (scripted, trajectory, and
torch-mlp on one machine) must match byte-for-byte; a mismatch exits non-zero.

A seed is **not** a cross-device reproducibility claim: model provenance
records `determinismScope: "same-host-same-device"`, because GPU kernels are
not guaranteed bit-identical across devices, drivers or quantization backends.
A model episode whose rerun digest differs on the same host is recorded, not
hidden.

## Scoring

`drivingScore = routeCompletion × Π penaltyFactor^eventCount`, in [0, 1].

| infraction | default factor | trigger (exact boundaries unit-tested) |
|---|---|---|
| collision-vehicle / -pedestrian / -static | 0.60 / 0.50 / 0.65 | terminal collision (shared rule with eval-server `col`); partner = nearest perceived object, typed by authored actor kind |
| off-road | 0.75 | **v2**: the vehicle FOOTPRINT leaves the authoritative drivable-area polygons. **v1**: \|lateral offset\| > 3.0 m (strict), hysteresis clears at 2.5 m |
| lane-departure | 0.75 | **v2 only**: \|lateral offset\| > 3.0 m (strict), hysteresis clears at 2.5 m — v1's off-road rule, under the name of what it measures |
| wrong-way | 0.70 | ≥ 1.0 m cumulative reverse route-arc while speed > 0.5 m/s |
| red-light | 0.70 | stop-line crossing while red (`sig` trace annotations; inert without signals) |
| stuck | 0.80 | speed < 0.3 m/s for ≥ 8 s continuously |
| speeding | 0.90 | speed > limit × 1.1 sustained ≥ 1 s |

Route completion = clamp(Δ route-arc / expectedRouteM, 0, 1); an explicit
goal termination forces 1. Reported without score impact: TTC minima over
closing perceived objects (`ttc-critical` warnings below 1.5 s), comfort
accel/jerk bound violations (3.5 m/s², 8 m/s³), and deadline misses.
All thresholds and factors are per-scenario overridable (`suite[].scoring`).

### Metric versions, and why off-road split in two

The manifest stamps `provenance.metricVersion`. Results keep the version that
scored them and are never re-scored under another: a v1 number is a v1 claim.

- `simforge.eval-metrics/v1` — off-road is lane-relative lateral offset.
- `simforge.eval-metrics/v2` — off-road is footprint containment in the
  authoritative drivable-area polygons; the old rule survives as
  `lane-departure`.

v1's rule measured distance from a lane CENTRELINE, which is not the same
question as "did the vehicle leave the road". On a reconstructed clip the
recorded ground-truth drive — 0.16 m of tracking error against its own path —
was reported as a 5.45 m lane error and therefore off-road, while never leaving
the drivable surface. A metric that flags the ground truth is measuring the
wrong thing, so v2 asks the containment question directly and keeps the
centreline question as its own, separately named infraction. Both can fire; they
are different claims.

v2 evaluates the four corners of the actor's box at its pose (dims from the
spec, yaw from the trace), not its centre, and reports the worst corner's
outside-distance so a marginal exit is legible rather than binary.

**Absent geometry is `unavailable`, never a pass.** With no drivable-area block,
empty polygons, or a decision outside the polygons' time support, v2 reports
off-road as unavailable and the factor does not apply — the episode is not
scored as clean. A drivable-area frame that disagrees with the ego frame is a
refusal (`drivable_area_frame_mismatch`), not a silent transform.

SimForge driving scores are **our** metric definition, not an NVIDIA benchmark
score: a number may only be called an AlpaSim (or any upstream) score if that
exact benchmark implementation and dataset produced it.

## One episode without a campaign

The cloud worker and the desktop `policy_episode` job run a single episode
through the same runner and scorer, via the shared cores in
`packages/evaluation/src/{episode-run,openloop-run}.ts`:

```sh
# closed-loop episode (job.json = simforge.compute-job/v1)
simforge-eval-worker episode  --job job.json --out out/
# open-loop batch over simforge.eval-observations/v1 bundles
simforge-eval-worker openloop --job job.json --out out/
```

`out/result.json` is the completion marker and is written even for a failure or
a cancellation (`status: failed|cancelled` with a typed `error.code` and
`retryable`). SIGTERM stops at the next barrier, flushes the partial trace and
exits 130; a hard kill leaves no `result.json` at all, which is the control
plane's failed-attempt path. Nothing in the worker reaches the network: the
control plane resolves artifacts to local paths first, and every declared
input digest is verified before use.
