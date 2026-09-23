# Fixed-suite EpisodeBatch state throughput

Measured 2026-09-22T11:24:41.368890+00:00; git `9dfd2baafe2e2265b21459d122543a9e91d57a8f`; runner `gpu-rtx5080`.

Hardware: Intel(R) Core(TM) Ultra 9 285K; 24 logical CPUs (24 available); Linux-7.0.0-31-generic-x86_64-with-glibc2.39.

Method: [the original SessionBatch entry](env-throughput.md#measured-results); the same TrainViz timing and NEXT_STEP accounting now exercise N kernel Episodes, including trace hashing.

Map: `garching-phase-1-2`. Native extension SHA-256: `51827afd63243dc4557ee186092f8311b406b0d1e9871238173b70b0166f3155`.

| Workload | Envs | Rust threads | Median decisions/s | Window rates |
|---|---:|---:|---:|---|
| corridor | 1 | 1 | 10,760.75 | 10,536.09, 10,790.90, 10,760.75 |
| corridor | 8 | 8 | 29,957.19 | 29,957.19, 29,073.46, 30,119.61 |
| corridor | 32 | 8 | 35,103.03 | 34,832.75, 35,103.03, 35,141.57 |
| corridor | 64 | 8 | 48,830.06 | 34,763.13, 49,704.00, 48,830.06 |
| cpnco-dartout | 1 | 1 | 10,196.88 | 10,206.68, 10,196.88, 10,157.48 |
| cpnco-dartout | 8 | 8 | 30,025.06 | 30,025.06, 30,255.98, 28,427.95 |
| cpnco-dartout | 32 | 8 | 35,978.78 | 36,010.49, 33,565.07, 35,978.78 |
| cpnco-dartout | 64 | 8 | 39,741.00 | 37,819.79, 39,741.00, 45,825.27 |

## Compared with the final SessionBatch entry

Historical baseline is unchanged; its different binary and measurement time are retained in JSON.

| Workload | Envs | SessionBatch decisions/s | EpisodeBatch decisions/s | Change |
|---|---:|---:|---:|---:|
| corridor | 1 | 11,502.08 | 10,760.75 | -6.45% |
| corridor | 8 | 35,712.18 | 29,957.19 | -16.11% |
| corridor | 32 | 40,923.00 | 35,103.03 | -14.22% |
| corridor | 64 | 40,142.20 | 48,830.06 | +21.64% |
| cpnco-dartout | 1 | 10,981.97 | 10,196.88 | -7.15% |
| cpnco-dartout | 8 | 27,167.36 | 30,025.06 | +10.52% |
| cpnco-dartout | 32 | 31,119.70 | 35,978.78 | +15.61% |
| cpnco-dartout | 64 | 32,100.97 | 39,741.00 | +23.80% |

Gate: **PASS**; each workload at 64 envs must sustain ≥5,000 decisions/s.

Raw counts, timings and provenance: [state-throughput-2026-09-22-batch.json](state-throughput-2026-09-22-batch.json).

## Interpretation and verification

64-world medians exceed the retained SessionBatch baseline by 21.64%/23.80%;
both meet the no-more-than-10%-regression target as well as the absolute floor.
Corridor at 8/32 worlds is instead 16.11%/14.22% below that historical binary.
Raw unpinned windows vary materially (all are retained above), so these
observations do not establish uniform scaling improvement or a causal
comparison under identical core placement.

The [scoped profile](state-throughput-2026-09-22-batch.profile.json) has 6,297
samples and zero lost: E-core/P-core self-cycle shares are 33.24%/10.77% for
route projection and 16.93%/19.56% for polyline sampling. It includes startup
and is not another timing window. It localizes hot paths but does not isolate
the historical lower-count regression; no trace bypass or speculative geometry
optimization was retained. See [gate interpretation](throughput-gates.md#w1-n-actual-kernel-episodes).

[Verification](state-throughput-2026-09-22-batch.verification.json): 36 scoped
Rust contracts and 20 targeted Gym tests passed; N=8 batch/sequential Episode
digests match. TrainViz's original frozen grid completed two CPU PPO updates
and 1,020 real decisions (four NEXT_STEP reset-only rows excluded), wrote
`metrics.jsonl`, and registered two SHA-256-pinned checkpoints. The smoke is
not a quality or scenario-admission result. No installed wheel was replaced;
no GPU or renderer was used; the actual GitHub CI job was not dispatched.
