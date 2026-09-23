# Fixed-suite state throughput

Measured 2026-09-22T10:46:53.721542+00:00; git `9dfd2baafe2e2265b21459d122543a9e91d57a8f`; runner `gpu-rtx5080`.

Hardware: Intel(R) Core(TM) Ultra 9 285K; 24 logical CPUs (24 available); Linux-7.0.0-31-generic-x86_64-with-glibc2.39.

Method: [the original SessionBatch entry](env-throughput.md#measured-results); the existing TrainViz benchmark is executed unchanged for each frozen workload.

Map: `garching-phase-1-2`. Native extension SHA-256: `bd62a064872fb06fcb59199f26d3ea60f01973614d2aabf90d517a3221a97b63`.

| Workload | Envs | Rust threads | Median decisions/s | Window rates |
|---|---:|---:|---:|---|
| corridor | 1 | 1 | 11,502.08 | 11,480.44, 11,507.75, 11,502.08 |
| corridor | 8 | 8 | 35,712.18 | 35,410.93, 37,001.89, 35,712.18 |
| corridor | 32 | 8 | 40,923.00 | 40,999.15, 40,923.00, 40,343.67 |
| corridor | 64 | 8 | 40,142.20 | 40,142.20, 40,989.25, 39,225.55 |
| cpnco-dartout | 1 | 1 | 10,981.97 | 10,981.97, 10,974.80, 10,987.70 |
| cpnco-dartout | 8 | 8 | 27,167.36 | 27,677.43, 27,167.36, 26,610.23 |
| cpnco-dartout | 32 | 8 | 31,119.70 | 30,621.19, 31,166.69, 31,119.70 |
| cpnco-dartout | 64 | 8 | 32,100.97 | 32,100.97, 31,880.95, 32,121.53 |

Gate: **PASS**; each workload at 64 envs must sustain ≥5,000 decisions/s.

Raw counts, timings and provenance: [state-throughput-2026-09-22-final.json](state-throughput-2026-09-22-final.json).

## Final release and historical comparison

This is the final isolated release after camera integration and the explicit
warm-up/hold-last correction. No installed trainer wheel was replaced.
Python used `PYTHONPATH=/tmp/simforge-episode-final/python`; the matching N-API
addon is `/tmp/simforge-episode-final/node/simforge-native-runtime.linux-x64-gnu.node`,
SHA-256 `4a9d1b71b8d640147fedc3e7124bcbe612c529d12076f9a57cd7a16ceb5aa1c0`.
Both were built together with the normal release profile.

| 64-world workload | Old-binary baseline | Final release | Change |
|---|---:|---:|---:|
| Corridor | 41,897.78 | 40,142.20 | −4.19% |
| CPNCO dart-out | 32,659.39 | 32,100.97 | −1.71% |

Both are within the requested 10% comparison boundary. Sibling compilation,
tests, rendering and video encoding were paused during these windows; desktop
processes remained running and no CPU affinity or OS-level reservation was used.

## Regression investigation and rejected optimization

The earlier 26.1k corridor result was not dismissed as noise. Alternating its
binary with a fresh release, with identical Python source, reproduced
26,697 versus 41,549 decisions/s. `perf` localized the difference to
`Polyline::sample`: 39.21% versus 14.26% of sampled CPU time, despite identical
instructions modulo relocation. E-core branch-miss rates were 2.6246% versus
0.1277%. This supports a code-layout/branch-prediction diagnosis; the precise
predictor aliasing mechanism is **[INFERENCE]**. It is not evidence that one
avoided signal-vector allocation accounts for the recovery.

A `partition_point` search experiment preserved exact geometry and observation
bytes, but an alternate 64-byte-aligned release measured only 30,281 / 26,187
corridor/VRU decisions/s. The experiment and its added test were fully reverted
before the final pair was built. The alignment flag affected all functions, so
that result does not isolate the cost of `partition_point` alone.
The final release retains the original search; layout sensitivity remains a
measured limitation and requires re-baselining each new binary.

See the [controlled profiling receipt](state-throughput-2026-09-22-final.profile.json)
for all alternating windows, symbols, counters and rejected-experiment results.
This benchmark executes native `SessionBatch` state+objects, not per-Episode
JSON/trace serialization or camera rendering.

## Final-pair behavior proof

- **32 kernel contracts passed**, including all 10 observation contracts and the
  explicit-warm-up hold-last regression.
- **15 Python/state-parity tests passed**. The 30-second, 300-decision PyO3,
  N-API and EnvSession trace digest is unchanged:
  `7373dcbc245c7c7fec19cf9a4da139f2901f6ef793a812fc7281f50ea1e02761`.
- The required privileged fixture remains
  `2243af51a91457ca8e2d57745773f3bfd757aafba562d32e2a6a769bbe9c0492`.
- **195,939 sampled geometry poses** over 2,701 lanes plus synthetic knots,
  and **41 retained batch views**, matched the pre-change bytes exactly.
- The real-camera parity test also passed on this exact pair: **101 identical
  scene documents** and **202 frames per binding verified against their own
  trace**. All 202 cross-run RGB frame hashes differed; both raw frame identities
  remain in their traces. No cross-run RGB bit-determinism is claimed.

Commands, hashes and evidence paths are in the
[final verification receipt](state-throughput-2026-09-22-final.verification.json).
Complete state/camera traces and JUnit reports are retained under
`/tmp/simforge-episode-final/`.

The CI floor remains **5,000 decisions/s**, unchanged. A **30,000** floor on a
quiescent runner is proposed in [throughput-gates](throughput-gates.md#enforced-floors),
not applied: the lowest final 64-world window was 31,880.95, only 6.27% above
that proposal, so repeated CI windows must establish the shared-host margin.
