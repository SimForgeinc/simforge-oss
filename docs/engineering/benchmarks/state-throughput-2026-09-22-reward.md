# Fixed-suite EpisodeBatch state throughput

Measured 2026-09-22T14:42:57.872534+00:00; git `9dfd2baafe2e2265b21459d122543a9e91d57a8f`; runner `gpu-rtx5080`.

Hardware: Intel(R) Core(TM) Ultra 9 285K; 24 logical CPUs (24 available); Linux-7.0.0-31-generic-x86_64-with-glibc2.39.

Method: [the original SessionBatch entry](env-throughput.md#measured-results); the same TrainViz timing and NEXT_STEP accounting now exercise N kernel Episodes, including trace hashing.

Map: `garching-phase-1-2`. Native extension SHA-256: `59c31306ded202951320360d96e1c5b2b3130e63227bcab1663d2e77bf526e00`.

## Native reward release

This isolated ABI **4** artifact executes the [native teacher reward](../closed-loop-training.md#native-teacher-reward-2026-09-22),
not a Python replacement: signed original-route progress, queue-aware stuck,
time/comfort costs and contact/corridor/signal termination. Typed CPU reward
matrices contain all eleven contributions. The paired N-API SHA-256 is
`c6cf397691647301545adcfb0eb882b83ea5287bbe1d7d88b6136e700ad14015`.
No installed wheel/addon was replaced. The learner was started **after**
these windows; sibling CPU-heavy work and GPU work were held for the measurement.
No CPU affinity or exclusive OS reservation was imposed.

The 64-world medians are 7.69× / 8.40× the CI floor. Compared with the preceding
final2 EpisodeBatch medians (42,886.75 / 41,619.11), corridor is **10.38% lower**
and VRU **0.90% higher**. The corridor regression is retained, not hidden by
the older SessionBatch comparison below or by lowering the floor. The workload
and method are unchanged, but the binary and reward work changed; these
unpinned windows do not isolate a cause. Raw counts include reset-only rows
in elapsed time, never in the decision numerator.

| Workload | Envs | Rust threads | Median decisions/s | Window rates |
|---|---:|---:|---:|---|
| corridor | 1 | 1 | 10,357.08 | 10,360.98, 10,352.70, 10,357.08 |
| corridor | 8 | 8 | 29,149.70 | 28,282.89, 29,543.66, 29,149.70 |
| corridor | 32 | 8 | 35,973.89 | 35,973.89, 36,669.97, 35,474.88 |
| corridor | 64 | 8 | 38,436.54 | 36,776.25, 38,436.54, 42,723.71 |
| cpnco-dartout | 1 | 1 | 11,044.11 | 11,044.11, 11,086.13, 11,020.08 |
| cpnco-dartout | 8 | 8 | 33,535.39 | 34,999.25, 33,535.39, 31,527.15 |
| cpnco-dartout | 32 | 8 | 37,816.41 | 38,031.85, 37,131.95, 37,816.41 |
| cpnco-dartout | 64 | 8 | 41,994.03 | 41,994.03, 41,348.77, 43,232.83 |

## Compared with the final SessionBatch entry

Historical baseline is unchanged; its different binary and measurement time are retained in JSON.

| Workload | Envs | SessionBatch decisions/s | EpisodeBatch decisions/s | Change |
|---|---:|---:|---:|---:|
| corridor | 1 | 11,502.08 | 10,357.08 | -9.95% |
| corridor | 8 | 35,712.18 | 29,149.70 | -18.38% |
| corridor | 32 | 40,923.00 | 35,973.89 | -12.09% |
| corridor | 64 | 40,142.20 | 38,436.54 | -4.25% |
| cpnco-dartout | 1 | 10,981.97 | 11,044.11 | +0.57% |
| cpnco-dartout | 8 | 27,167.36 | 33,535.39 | +23.44% |
| cpnco-dartout | 32 | 31,119.70 | 37,816.41 | +21.52% |
| cpnco-dartout | 64 | 32,100.97 | 41,994.03 | +30.82% |

Gate: **PASS**; each workload at 64 envs must sustain ≥5,000 decisions/s.

Raw counts, timings and provenance: [state-throughput-2026-09-22-reward.json](state-throughput-2026-09-22-reward.json).

The byte-identical measured runtime is retained at
`~/simforge-assets/runs/drive/training/reward-poc-v1-20260922/runtime/`:
`python/` is the isolated package prefix, `node/` contains the paired addon,
and `venv/bin/python` is the separately created interpreter. The original
`/tmp/simforge-reward` scratch was removed after a retained-runtime model/
Episode smoke; the artifact hashes above did not change.

From the repository, reproduce with the installed pinned maps:

```sh
R="$HOME/simforge-assets/runs/drive/training/reward-poc-v1-20260922/runtime"
PYTHONPATH="$R/python" CUDA_VISIBLE_DEVICES= \
  "$R/venv/bin/python" scripts/bench/closed-loop/state.py \
  --out /tmp/simforge-reward-recheck.json --runner-class gpu-rtx5080
```

Training/video/test receipts are in the sibling `evidence.json`; the
[contract's measured proof](../closed-loop-training.md#measured-reward-proof)
reports the successful motion demonstration and the unresolved queue contacts.
