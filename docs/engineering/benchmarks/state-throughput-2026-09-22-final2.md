# Fixed-suite EpisodeBatch state throughput

Measured 2026-09-22T11:42:01.637134+00:00; git `9dfd2baafe2e2265b21459d122543a9e91d57a8f`; runner `gpu-rtx5080`.

Hardware: Intel(R) Core(TM) Ultra 9 285K; 24 logical CPUs (24 available); Linux-7.0.0-31-generic-x86_64-with-glibc2.39.

Method: [the original SessionBatch entry](env-throughput.md#measured-results); the same TrainViz timing and NEXT_STEP accounting now exercise N kernel Episodes, including trace hashing.

Map: `garching-phase-1-2`. Native extension SHA-256: `0b13075278adc5427b61cf69ae41f7d8890b57a86ee25d26825140a7da87b48d`.

## Why a final2 artifact

This is the combined W1/W3 release after fixing the canonical formatter's
decimal midpoint rule with ECMAScript Ryu. A real PPO setpoint had previously
produced a Rust-valid trace rejected by the JavaScript verifier; changing the
formatter and relinking requires a new binary identity and measurement.
Earlier reports and failed trace evidence are retained, not rewritten.

The paired N-API SHA-256 is
`cd01e652514cf2af8ca3413dd58314365ee430b3f8030ec48c77bcf5024e3bd5`.
The 30 s state-parity fixture has the same digest before/after the formatter
fix (`75ddcff71ddc7364ab02ddee7c4365dad367b37157f15b87b3b97ab88ff7a9f2`);
that fixture does not exercise the failing midpoint. Three native batch
contracts and 21 targeted Python tests pass, with one optional camera-parity
test skipped. The new 200-decision Bevy teacher trace verifies and has 402
checked PNG digests. See [verification receipt](state-throughput-2026-09-22-final2.verification.json).

The lower-count corridor regressions and unpinned window variation remain
visible below. These measurements do not attribute performance changes to
the number formatter; the absolute 64-world floor is the enforced gate.

| Workload | Envs | Rust threads | Median decisions/s | Window rates |
|---|---:|---:|---:|---|
| corridor | 1 | 1 | 11,040.46 | 11,051.63, 11,037.35, 11,040.46 |
| corridor | 8 | 8 | 29,789.72 | 30,019.38, 27,814.21, 29,789.72 |
| corridor | 32 | 8 | 36,829.15 | 36,260.45, 37,330.87, 36,829.15 |
| corridor | 64 | 8 | 42,886.75 | 42,886.75, 41,168.46, 47,543.66 |
| cpnco-dartout | 1 | 1 | 10,725.45 | 10,715.95, 10,725.45, 10,748.65 |
| cpnco-dartout | 8 | 8 | 34,357.53 | 34,574.32, 34,357.53, 32,031.85 |
| cpnco-dartout | 32 | 8 | 37,602.38 | 37,602.38, 38,408.48, 36,150.50 |
| cpnco-dartout | 64 | 8 | 41,619.11 | 43,585.82, 41,619.11, 37,626.56 |

## Compared with the final SessionBatch entry

Historical baseline is unchanged; its different binary and measurement time are retained in JSON.

| Workload | Envs | SessionBatch decisions/s | EpisodeBatch decisions/s | Change |
|---|---:|---:|---:|---:|
| corridor | 1 | 11,502.08 | 11,040.46 | -4.01% |
| corridor | 8 | 35,712.18 | 29,789.72 | -16.58% |
| corridor | 32 | 40,923.00 | 36,829.15 | -10.00% |
| corridor | 64 | 40,142.20 | 42,886.75 | +6.84% |
| cpnco-dartout | 1 | 10,981.97 | 10,725.45 | -2.34% |
| cpnco-dartout | 8 | 27,167.36 | 34,357.53 | +26.47% |
| cpnco-dartout | 32 | 31,119.70 | 37,602.38 | +20.83% |
| cpnco-dartout | 64 | 32,100.97 | 41,619.11 | +29.65% |

Gate: **PASS**; each workload at 64 envs must sustain ≥5,000 decisions/s.

Raw counts, timings and provenance: [state-throughput-2026-09-22-final2.json](state-throughput-2026-09-22-final2.json).
