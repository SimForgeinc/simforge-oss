# Native state-only SessionBatch throughput

Measured 2026-09-22. This is input to the day-7 gate in
[closed-loop-training](../closed-loop-training.md), not a claim that the full
training grid, contact/solvability gates, rendered throughput, or policy quality
have passed.

## Measured results

Median of three 5-second timed windows after 30 warm-up batch calls. Each
**decision** advances five native 50 Hz physics ticks (10 Hz policy). Counts
exclude NEXT_STEP autoreset-only rows; reset cost remains inside elapsed time.
The public `SimForgeVectorEnv`/native `SessionBatch` path is measured, including
Python action encoding, owned observation arrays and the default lightweight
info mapping. No renderer, Torch inference, learner or GPU physics is involved.

| Environments | Rust worker threads | Local CPU decisions/s | simforge1 CPU decisions/s |
|---:|---:|---:|---:|
| 1 | 1 | 11,252.48 | 3,932.71 |
| 8 | 8 | 38,150.85 | 20,990.84 |
| 32 | 8 | 41,205.11 | 25,186.22 |
| 64 | 8 | 41,893.87 | 26,562.66 |

- Local: Intel Core Ultra 9 285K, Linux x86-64. Native release extension,
  engine `0.7.0`, binding ABI `3`.
- simforge1: two AMD EPYC 7763 64-core processors, 128 logical CPUs reported,
  Linux x86-64; same native extension and scenario. Other users were running
  GPU training on GPUs 0–4. No affinity or exclusive host reservation; these
  are observed shared-host numbers, not a hardware ranking.
- State-only here means native state `(10,)` **plus object-list `(64,5)`**,
  no BEV/camera and `info_channel=False`. Scenario has one car, so object rows
  are empty/padded. Action is `[targetSpeedMps=6, targetAccelerationMps2=0]`.
- Scenario: frozen `drive-corridor.episodes.json`, Garching lane `160:0:-3`,
  20 s episodes, dynamic-v1. Each world is an independent native session;
  benchmark copies this one input, with explicit distinct reset seeds.

Both vectorized runs exceed the proposed **5,000 state decisions/s** floor
on this benign workload. simforge1's single world does not. This does **not**
measure the two-family/four-cell training workload; trainer metrics publish
its actual `native_env_steps_per_s` and per-update `env_steps_per_s` separately.
No rendered ≥10 decisions/s gate has been claimed by this benchmark.

The live 240-world, four-cell teacher run provides a separate workload
observation at update 1,030 / 15,710,346 decisions: cumulative time inside
`env.step` gave **17,612.66 decisions/s**; that update's rollout + PPO optimizer
loop gave **4,079.63 decisions/s**. The latter excludes dashboard generation
and periodic validation after the metric is emitted; overall elapsed time is
also published (`wall_seconds=2688.58` at that snapshot). These are not
substitutes for the controlled scaling benchmark above.

## Reproduction

From the checkout, with the built ABI-3 Python extension available and the
Garching map installed:

```sh
PYTHONPATH=adapters/gym CUDA_VISIBLE_DEVICES= \
  adapters/gym/.venv/bin/python -m simforge_oss_gym.train.benchmark \
  --spec "$HOME/simforge-assets/runs/drive/drive-corridor.episodes.json" \
  --out /tmp/throughput-local.json --seconds 5 --repeats 3 --threads 8
```

Actual remote command (the local wheel, Python source and map geometry were
rsynced first; `.training-deps` is an isolated dependency target, not a mutation
of the other user's Torch environment):

```sh
ssh simforge1 env \
  PYTHONPATH=/home/ubuntu/simforge-oss/adapters/gym:/home/ubuntu/simforge-oss/adapters/gym/.training-deps \
  SCEN_DEV_ASSETS=/home/ubuntu/simforge-oss/adapters/gym/.training-maps \
  CUDA_VISIBLE_DEVICES= \
  /home/ubuntu/vla-posttrain/.venv/bin/python -m simforge_oss_gym.train.benchmark \
  --spec /home/ubuntu/simforge-assets/runs/drive/training/ppo-visible-20260922/benchmark.episodes.json \
  --out /home/ubuntu/simforge-assets/runs/drive/training/ppo-visible-20260922/throughput-simforge1.json \
  --seconds 5 --repeats 3 --threads 8
```

Raw per-window decision counts, wall times, scenario SHA-256 and environment
metadata are in:

- `~/simforge-assets/runs/drive/training/ppo-visible-20260922/throughput-local.json`
- `~/simforge-assets/runs/drive/training/ppo-visible-20260922/throughput-simforge1.json`

This first measurement used the reusable benchmark module without a CI floor.
The subsequent [fixed-suite throughput gates](throughput-gates.md) reuse its
method unchanged, add a VRU workload and native camera-profile measurements,
and wire enforced floors into CI. The stale Python ABI-2 assertion was
corrected to the current native ABI-3 contract (world pose rows gained
longitudinal speed).
