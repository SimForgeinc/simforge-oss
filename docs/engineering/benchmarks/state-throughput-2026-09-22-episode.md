# Fixed-suite state throughput

Measured 2026-09-22T09:51:50.083025+00:00; git `76f5f76002d83f7bbded9e29ec1899872b876d95`; runner `gpu-rtx5080`.

Hardware: Intel(R) Core(TM) Ultra 9 285K; 24 logical CPUs (24 available); Linux-7.0.0-31-generic-x86_64-with-glibc2.39.

Method: [the original SessionBatch entry](env-throughput.md#measured-results); the existing TrainViz benchmark is executed unchanged for each frozen workload.

Map: `garching-phase-1-2`. Native extension SHA-256: `a5b3e2c8309d4e0e87f25501c55feea31ac0aab7cf2478d321d4689d00deaacc`.

| Workload | Envs | Rust threads | Median decisions/s | Window rates |
|---|---:|---:|---:|---|
| corridor | 1 | 1 | 11,501.84 | 11,494.54, 11,501.84, 11,510.40 |
| corridor | 8 | 8 | 21,298.16 | 20,319.81, 21,298.16, 21,363.95 |
| corridor | 32 | 8 | 24,811.61 | 25,071.23, 24,802.44, 24,811.61 |
| corridor | 64 | 8 | 26,075.58 | 25,855.31, 26,288.60, 26,075.58 |
| cpnco-dartout | 1 | 1 | 11,207.67 | 11,370.18, 11,207.67, 11,058.14 |
| cpnco-dartout | 8 | 8 | 22,536.57 | 23,214.46, 22,233.88, 22,536.57 |
| cpnco-dartout | 32 | 8 | 25,679.51 | 25,222.17, 25,679.51, 26,172.49 |
| cpnco-dartout | 64 | 8 | 27,959.85 | 27,959.85, 27,761.02, 28,055.81 |

Gate: **PASS**; each workload at 64 envs must sustain ≥5,000 decisions/s.

Raw counts, timings and provenance: [state-throughput-2026-09-22-episode.json](state-throughput-2026-09-22-episode.json).
