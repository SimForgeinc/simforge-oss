# Closed-loop throughput gates

## Published entries

1. [Original native SessionBatch measurement](env-throughput.md) — the first
   entry and the source of the state benchmark method; retained unchanged apart
   from the link to these subsequent gates.
2. [Final camera-integrated fixed-suite state measurement](state-throughput-2026-09-22-final.md),
   with [raw JSON](state-throughput-2026-09-22-final.json).
3. [Final kernel-owned camera-profile measurement](rendered-throughput-2026-09-22-final.md),
   with [raw JSON](rendered-throughput-2026-09-22-final.json).
4. [Kernel EpisodeBatch training measurement](state-throughput-2026-09-22-batch.md),
   with [raw JSON](state-throughput-2026-09-22-batch.json) and
   [verification receipt](state-throughput-2026-09-22-batch.verification.json).
5. [Combined final2 state measurement](state-throughput-2026-09-22-final2.md),
   with [raw JSON](state-throughput-2026-09-22-final2.json) and
   [verification receipt](state-throughput-2026-09-22-final2.verification.json).
6. [Current native-teacher-reward state measurement](state-throughput-2026-09-22-reward.md),
   with [raw JSON](state-throughput-2026-09-22-reward.json).

The initial pre-migration [state](state-throughput-2026-09-22.md) and
[renderer](rendered-throughput-2026-09-22.md) reports and the earlier
[post-Episode state](state-throughput-2026-09-22-episode.md) and
[caller-rendered camera](rendered-throughput-2026-09-22-episode.md) measurements
remain available; none was overwritten by the final measurements.

These implement the published-throughput part of
[W0](../closed-loop-training.md#w0--kernel-episode-architecture-batch-made-load-bearing).
They are throughput measurements, not episode parity, privilege-boundary,
contact correctness, solvability, or model-quality qualification.

## Fixed workload and provenance

`scripts/bench/closed-loop/suite.json` pins two compiled inputs on **one map,
Garching phase 1/2**, their file hashes, the installed topology hash, profiles,
window counts and floors. No map geometry or private registry is added here.
The map must already be installed from an authorized source. A different
scenario or topology is an error, not a comparable benchmark run.

- **Benign corridor:** the original one-car `drive-corridor` input, lane
  `160:0:-3`, starting at 100 m, 20 s, dynamic-v1.
- **VRU:** `examples/cpnco-dartout.template.json`, native-matched site
  `a0a911eec6f6af6f`, compiler seed 42, 16 s, dynamic-v1, ego car and pedestrian.
  Native initial-feasibility findings were empty. This is not a claim that the
  full VRU admission or contact contract has been qualified.

The state runner executes **the existing TrainViz benchmark module**, not a
second implementation of its timing or NEXT_STEP accounting. See the first
entry for that method. Each workload runs separately at 1/8/32/64 environments,
with at most eight Rust workers. Raw output additionally names the autoreset-only
row count in each window; those rows remain excluded from decisions, not from
elapsed time. “State-only” retains the existing state-plus-objects meaning,
with no BEV, cameras, inference or learner.

Both reports contain hardware, git SHA, fixture/topology identity, binary
SHA-256 and individual windows. The final state and camera source base is
`9dfd2baafe2e2265b21459d122543a9e91d57a8f`, with the phase-B integration in the
working tree. Its isolated release includes cameras, the explicit-warm-up
hold-last fix and disabled-signal allocation cleanup. Engine 0.7.0 / ABI 3
alone cannot distinguish implementations: the final PyO3 SHA-256 is
`bd62a064872fb06fcb59199f26d3ea60f01973614d2aabf90d517a3221a97b63`;
the matching N-API SHA-256 is
`4a9d1b71b8d640147fedc3e7124bcbe612c529d12076f9a57cd7a16ceb5aa1c0`.
Historical reports retain their own source and binary identities; the
earlier post-Episode state report predates the disabled-signal cleanup.
The running trainer's wheel was not rebuilt or replaced. CI builds the checked-out
bindings into its own temporary environment rather than silently reusing an
installed trainer wheel.

## Measured workstation reference

Measured 2026-09-22 on `path-pc`, the workstation class named by the existing
`gpu-rtx5080` runner label: **Intel Core Ultra 9 285K, 24 logical CPUs**, Linux
7.0.0-31-generic x86-64; **NVIDIA GeForce RTX 5080, 16,303 MiB**, driver 595.84.
Python 3.12.14; Node 22.23.2 locally. No exclusive CPU reservation or affinity
pin was used. Existing desktop processes remained running; no local model was
loaded for the renderer measurement.
Sibling compilation, tests, rendering and video encoding were paused during
the final state windows; this was not an OS-level exclusive CPU reservation.

| Workload | 1 env | 8 envs | 32 envs | 64 envs | Unit |
|---|---:|---:|---:|---:|---|
| Benign corridor | 11,502.08 | 35,712.18 | 40,923.00 | 40,142.20 | decisions/s |
| CPNCO dart-out | 10,981.97 | 27,167.36 | 31,119.70 | 32,100.97 | decisions/s |

At 64 worlds, these are **4.19% / 1.71% below** the old-binary corridor/VRU
baselines of 41,897.78 / 32,659.39 decisions/s: both are inside the requested
10% investigation boundary. No experimental search change was retained.

### W1: N actual kernel Episodes

The current `VectorEnv` and this CI state command use `EpisodeBatch`, not
SessionBatch. The archived entries above retain their original meaning.
The same fixtures, seeds, eight-worker cap, 30 warm-up calls and three ≥5 s
windows now include Episode's v2 trace construction/hash on every decision.
NEXT_STEP reset happens in that single kernel call; reset-only rows remain
excluded from the decision numerator and included in elapsed time.

#### Current native-teacher-reward artifact

ABI 4 adds the [complete native reward](../closed-loop-training.md#native-teacher-reward-2026-09-22)
and eleven-column telemetry, including signed original-route progress, queue
waiting/stuck, comfort and terminal contact/corridor/signal facts. The unchanged
suite measured **38,436.54 corridor / 41,994.03 VRU decisions/s at 64 worlds**:
7.69× / 8.40× the unchanged 5,000 floor. Every 1/8/32/64 window is retained in
the linked report. Versus final2, those medians are **−10.38% / +0.90%**;
this is not a controlled attribution of the difference to reward code.
No learner, GPU or renderer ran in these measurement windows; sibling heavy
work was paused, without CPU affinity/exclusive reservation. Python SHA-256:
`59c31306ded202951320360d96e1c5b2b3130e63227bcab1663d2e77bf526e00`.

#### Previous combined final2 artifact

The final2 paired release includes W3's applied-control evidence and the
ECMAScript Ryu midpoint-formatting fix. A real PPO output exposed a mismatch
between Rust `LowerExp` and JavaScript number serialization; fixing it required
relinking and this fresh measurement, not reuse of an old binary's numbers.

| Workload | 1 env | 8 envs | 32 envs | 64 envs |
|---|---:|---:|---:|---:|
| Benign corridor | 11,040.46 | 29,789.72 | 36,829.15 | 42,886.75 |
| CPNCO dart-out | 10,725.45 | 34,357.53 | 37,602.38 | 41,619.11 |

Both 64-world rows pass 5,000 decisions/s; the old gate and fixtures are
unchanged. Python SHA-256 is
`0b13075278adc5427b61cf69ae41f7d8890b57a86ee25d26825140a7da87b48d`;
paired Node SHA-256 is
`cd01e652514cf2af8ca3413dd58314365ee430b3f8030ec48c77bcf5024e3bd5`.
Use `/tmp/simforge-episode-final2/python` and `/tmp/simforge-episode-final2/node`
for these local proofs. The report retains every unpinned window and the
8/32-world corridor regressions; it does not assign their cause to Ryu.

#### Initial W1 artifact, retained

| EpisodeBatch workload | 1 env | 8 envs | 32 envs | 64 envs | Unit |
|---|---:|---:|---:|---:|---|
| Benign corridor | 10,760.75 | 29,957.19 | 35,103.03 | 48,830.06 | decisions/s |
| CPNCO dart-out | 10,196.88 | 30,025.06 | 35,978.78 | 39,741.00 | decisions/s |

At 64 worlds the medians are **21.64% / 23.80% above** the retained final
SessionBatch medians: both clear the 5,000 floor and the ≤10% regression
target without skipping evidence or selecting a different workload.
This is not uniform scaling improvement: corridor at 8/32 worlds is
16.11%/14.22% slower than that historical binary. Individual unpinned windows
also vary: corridor64 spans 34,763–49,704 and VRU64 37,820–45,825 decisions/s.
No OS affinity or exclusive-core reservation was imposed; the raw windows are
retained rather than silently discarded. Sibling heavy work was paused.
The new Python typed matrix eliminates per-world action packing and optional
diagnostic JSON work; the kernel now additionally records each Episode's
trace, so this is not a source-identical binary comparison.
An eight-world scoped `perf` sample (6,297 samples, zero lost) still puts
geometry first: `Route::project_point_with_step` is 33.24%/10.77% of sampled
E-core/P-core cycles and `Polyline::sample` is 16.93%/19.56%. This localizes
the hot paths; it does **not** isolate why those historical 8/32-world windows
were faster. The profile includes startup and runs after siblings resumed.
No claim that disabled cameras or trace JSON caused that entire difference,
and no unproved geometry rewrite, is made. The
[profile receipt](state-throughput-2026-09-22-batch.profile.json) records the
exact binary, script, command and limitations. The requested 64-world target
passes; lower-count comparison remains sensitive to this unpinned heterogeneous
CPU and the different binary layouts.

The isolated W1 extension is
`/tmp/simforge-episode-batch/python/simforge_oss_gym/_native.abi3.so`,
SHA-256 `51827afd63243dc4557ee186092f8311b406b0d1e9871238173b70b0166f3155`.
36 session-crate contracts and 20 targeted Gym tests passed. N=8 batch and
eight sequential Episodes printed identical per-world digests; checkpoint
proofs include mixed pending resets, changed worker counts and held plans.
The historical TrainViz frozen grid completed a new CPU smoke: two updates,
1,020 actual decisions from 1,024 rollout rows, two real registered checkpoints
and `metrics.jsonl`. This proves collection/learning, not model quality or
new scenario admission. See the linked verification receipt for exact paths.

### Retained camera measurement

| Camera profile | Cameras × registry-native resolution | Median ticks/s |
|---|---|---:|
| `alpamayo-2cam` | 2 × 512×384 | 13.01 |
| `qwen-drive-3cam` | 3 × 512×384 | 8.78 |
| `auto-e2e-6view` | 6 × 512×384 | 5.30 |

A rendered **tick is the complete named camera bundle**, not one camera image.
The renderer benchmark imports only the drive bench's shared world preparation
helper and its profile registry, then starts the same protocol-5 Bevy service.
After the readiness handshake, the helper's client is closed and the dedicated
socket is handed to the **native Episode camera channel**. The kernel owns
warm-up, stepping, scene-state assembly, render RPCs and frame publication.
Each of three ≥5 s windows follows 20 real kernel warm-up decisions plus the
initial reset frame. Policy actions are native route-following setpoints
`{k:"s",speedMps:6,accelerationMps2:0}`, with no model.

Episode step/reset, its deterministic trace, camera rendering/GPU readback,
zero-copy `FrameRef.buffer()` access and RGBA row-padding removal are timed.
All borrowed frame leases are released before the next advance. Final frames
in each window are verified against the kernel's padded-byte CRC32 and SHA-256;
these extra checks happen outside timing. Startup, asset preparation, warm-up
and PNG/HUD/video encoding are excluded. There is no inference socket,
fabricated image, resolution override, or additional HUD-only camera.
Qwen/AutoE2E drive videos add the main tele camera; this exact-rig benchmark
does not, so its number is not full drive-video throughput. JSON records the
24 selected BC7 mesh digests, native binding/renderer hashes and verified frame
hashes for every window.

The final camera report declares `simforge.rendered-throughput/v2` and
`loop_owner: "native Episode"`. Earlier v1 reports measured the old
caller-assembled scene path; they are retained as historical evidence, not
silently relabelled as kernel-owned camera measurements.

## State regression investigation

The earlier post-Episode slowdown was real, but was not evidence that Episode
JSON or disabled camera/signal channels cost that throughput: this workload
executes `SessionBatch`, not the per-Episode JSON/trace or camera path.
Alternating the earlier `a5b3e2c8…` artifact and a fresh `d8f0e752…` release
against **identical Python source** reproduced **26,697 versus 41,549**
corridor decisions/s and **28,079 versus 32,228** VRU decisions/s at 64 worlds.

`perf` localized the difference to the unchanged `Polyline::sample` search:
39.21% versus 14.26% of sampled CPU time. Its disassembly was identical modulo
relocations, but its address changed from `0xb96e60` to `0xb973c0`. The
E-core branch-miss rate changed from **2.6246% to 0.1277%**. These observations
indicate code-layout/branch-prediction sensitivity; the precise predictor
aliasing mechanism is **[INFERENCE]**, not established by these counters.
Do not attribute the recovery to one avoided disabled-signal `Vec` allocation.

A branchless `partition_point` experiment preserved all 195,939 sampled
geometry poses and 41 retained batch views byte-for-byte. It nevertheless
managed only **30,281 / 26,187** decisions/s on the corridor/VRU workloads in a
64-byte-aligned release. That failed the required recovery check, so both the
search change and its new test were **fully reverted before the final build**.
The alignment flag affected all functions, so this experiment does not isolate
the cost of `partition_point` alone. The final artifact uses the original search.

Raw alternating windows, function identities, counter rates and the rejected
experiment are retained in the
[profiling receipt](state-throughput-2026-09-22-final.profile.json).
Build-layout sensitivity remains a measured limitation: a fresh binary hash
and a fresh measurement are required after relinking, even when state bytes
are unchanged. This is why the throughput gate must remain load-bearing.

## Enforced floors

| Gate | Required result | Reason |
|---|---|---|
| State, **each** workload at 64 envs | ≥5,000 decisions/s | The W0/W1 state floor, evaluated on the measured workstation class with eight workers. Requiring both workloads prevents the benign case from hiding a VRU regression. |
| `alpamayo-2cam` | ≥5 complete ticks/s | A conservative model-free native-render regression floor: about 38% of the measured 13.01 ticks/s, leaving shared-host variance headroom while catching a large regression. |

The three-/six-camera profiles are published observations, not additional
pass/fail thresholds. The ≥5 two-camera gate is **not** the plan's separate
≥10 rendered student-decisions/s day-7 gate, nor an assertion about model
inference speed. Floors are absolute guardrails rather than fine-grained
percentage-regression tests; changing the workload, method, resolutions or
hardware class requires an explicit new baseline, not lowering a floor to pass.
Both scripts write JSON and Markdown before returning non-zero on a floor miss.

**Proposed, not enforced:** raise the state floor to **30,000 decisions/s per
workload** on a quiescent workstation-class runner, after confirming repeated
CI windows. The lowest final 64-world window was 31,880.95 decisions/s
(6.27% above that proposal); 30,000 would have caught the measured earlier
26,697 / 28,079 artifact regression. That margin is not yet a shared-host
variance guarantee. `suite.json` and CI still enforce **5,000**, unchanged;
this document does not silently raise the gate.

## Run locally

Use the pinned Garching map topology and its native-render BC7 assets in the
normal map cache (or set `SIMFORGE_MAPS_CACHE_ROOT`; `SCEN_DEV_ASSETS` locates
an explicit topology corpus). Build/install the native Python and N-API
bindings in a **separate environment** when testing a new revision; do not
replace a live trainer's loaded wheel.

```sh
python3 -m venv /tmp/simforge-throughput-venv
/tmp/simforge-throughput-venv/bin/python -m pip install ./adapters/gym
CUDA_VISIBLE_DEVICES= \
  /tmp/simforge-throughput-venv/bin/python scripts/bench/closed-loop/state.py \
  --out docs/engineering/benchmarks/state-throughput-local.json \
  --runner-class gpu-rtx5080

# Source builds need the pinned sky plates; use the installed plates as below,
# or first run scripts/native-runtime/prepare-sky.mjs.
NODE_OPTIONS=--conditions=development \
SIMFORGE_SKY_ASSETS="$HOME/.local/share/simforge/native-runtime/share/sky" \
  pnpm exec tsx --tsconfig tsconfig.base.json scripts/bench/closed-loop/rendered.mts \
  --out docs/engineering/benchmarks/rendered-throughput-local.json \
  --runner-class gpu-rtx5080
```

For the final state run, Python resolved the isolated package with
`PYTHONPATH=/tmp/simforge-episode-final/python`; final camera timing and parity used
`SIMFORGE_NATIVE_RUNTIME_ADDON=/tmp/simforge-episode-final/node/simforge-native-runtime.linux-x64-gnu.node`.
When selecting another release artifact, set those variables explicitly and
check the reported binary hashes rather than substituting a newer build into an
old report.

The renderer binary defaults to
`renderer/target/release/native-render-service`; `--binary` or
`SIMFORGE_NATIVE_RENDER_BINARY` selects an explicit build. Run without
co-tenant rendering/model work; never kill another user's process to obtain a
number. Each script writes a `.md` sibling to its selected `.json` output.

## CI wiring and verification

[`.github/workflows/throughput.yml`](../../../.github/workflows/throughput.yml)
runs on the already-declared `[self-hosted, Linux, X64, gpu-rtx5080]` class,
not an unmeasured hosted CPU class. It runs on relevant trusted `main` pushes,
nightly at 23:15 UTC and `workflow_dispatch`. It uses the existing
`E2E_GPU_RUNNER_READY` repository variable for automated runs, preventing an
unregistered runner from queuing forever; manual dispatch remains the explicit
provisioning probe. Untrusted PR code never runs on this persistent host.

The job builds only the native Python/N-API bindings and renderer service,
uses a temporary Python venv rather than the trainer environment, enforces both
floors, publishes tables to the Actions summary, and uploads raw JSON/Markdown
artifacts for 90 days even on a gate failure. It shares `native-golden`'s GPU
concurrency group. The pre-provisioned authorized map cache and a working
NVIDIA/Vulkan stack are runner prerequisites; no private map is downloaded
from the public registry. An unset `SIMFORGE_MAPS_CACHE_ROOT` repository
variable uses the runner user's normal map cache.

Local evidence: both full benchmark commands passed; the renderer script's
scoped TypeScript check and the CLI's targeted `tsc --noEmit` passed;
`actionlint` 1.7.12 accepted the workflow with `gpu-rtx5080` declared as the
existing custom runner label. A real 2 s scripted `drive run` after the helper
extraction completed 20 decisions, and `drive verify` validated all 168 frame
digests, trace chain and manifest. Floor-boundary smoke checks covered exact
5,000, below-floor, non-finite and missing-64-env cases. See
[verification receipt](throughput-verification-2026-09-22.json).
The additional [post-Episode receipt](throughput-verification-2026-09-22-episode.json)
records the isolated binding paths and their complete benchmark rerun.
The [final state verification receipt](state-throughput-2026-09-22-final.verification.json)
records 32 passing kernel contracts, 15 passing Python/state-parity tests and
the real-camera parity test on that exact final pair. The privileged fixture
still hashes to `2243af51a91457ca8e2d57745773f3bfd757aafba562d32e2a6a769bbe9c0492`;
the 30-second PyO3/N-API/EnvSession trace still hashes to
`7373dcbc245c7c7fec19cf9a4da139f2901f6ef793a812fc7281f50ea1e02761`.
Camera scene documents matched, but all 202 cross-run RGB frame hashes
differed; both raw identities remain in their traces, not normalized away.
The [final camera verification receipt](rendered-throughput-2026-09-22-final.verification.json)
records all three complete profile measurements on the same N-API hash,
zero-copy frame leases and successful payload verification. GPU processes were
closed at completion; no installed wheel was replaced.

The GitHub job itself has **not** been dispatched in this checkout. Runner
registration, repository readiness-variable configuration and the first hosted
artifact are external deployment evidence, not implied by a local pass.
