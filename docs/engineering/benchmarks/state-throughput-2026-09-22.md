# Fixed-suite state throughput

Measured 2026-09-22T09:30:19.845482+00:00; git `76f5f76002d83f7bbded9e29ec1899872b876d95`; runner `gpu-rtx5080`.

Hardware: Intel(R) Core(TM) Ultra 9 285K; 24 logical CPUs (24 available); Linux-7.0.0-31-generic-x86_64-with-glibc2.39.

Method: [the original SessionBatch entry](env-throughput.md#measured-results); the existing TrainViz benchmark is executed unchanged for each frozen workload.

Map: `garching-phase-1-2`. Native extension SHA-256: `676b0ef48ea62e2cc4dae5685c5167255e60fd43447eee5db51a3d5b553f4b4e`.

| Workload | Envs | Rust threads | Median decisions/s | Window rates |
|---|---:|---:|---:|---|
| corridor | 1 | 1 | 11,250.13 | 11,320.47, 11,250.13, 11,243.17 |
| corridor | 8 | 8 | 36,920.43 | 37,918.81, 36,920.43, 29,244.71 |
| corridor | 32 | 8 | 41,344.67 | 41,344.67, 40,726.90, 41,684.98 |
| corridor | 64 | 8 | 41,897.78 | 40,932.61, 42,824.75, 41,897.78 |
| cpnco-dartout | 1 | 1 | 11,170.56 | 11,168.70, 11,170.56, 11,198.70 |
| cpnco-dartout | 8 | 8 | 28,374.68 | 27,745.06, 28,374.68, 28,426.94 |
| cpnco-dartout | 32 | 8 | 31,167.48 | 31,302.78, 31,167.48, 31,037.12 |
| cpnco-dartout | 64 | 8 | 32,659.39 | 32,659.39, 33,399.79, 32,637.37 |

Gate: **PASS**; each workload at 64 envs must sustain ≥5,000 decisions/s.

Raw counts, timings and provenance: [state-throughput-2026-09-22.json](state-throughput-2026-09-22.json).
