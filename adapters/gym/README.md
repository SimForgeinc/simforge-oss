# simforge-oss-gym

The SimForge Python SDK. The Rust native runtime ships inside the wheel as the
PyO3 extension `simforge_oss_gym._native` (built by maturin from
`native/crates/simforge-bindings-python`); no Node, Studio or subprocess is
involved. Execution profiles with their own providers are explicit extras.

| profile | env classes | extra |
|---|---|---|
| `roadway-native` (default) | `SimForgeEnv`, `SimForgeVectorEnv`, `SimForgeWorld`, `PolicyRunner` | none |
| `roadway-dynamic-gpu-v1` | `gpu.SimForgeGpuVectorEnv` (torch tensors on device) | `gpu` |
| `articulated-mujoco-v1` | `articulated.ArticulatedEnv`, `articulated.ArticulatedVectorEnv` | `articulated`, `articulated-warp` |
| sensor tensors (NuRec) | `sensors.SensorRig` over a `SimForgeWorld` | `nurec` |
| Episode Bevy cameras | `native.Episode` camera channel; `bevy_sensors.BevySensorRig` zero-copy views | native renderer runtime |
| external-physics Bevy sensors | `ArticulatedEnv(sensors="bevy")` → `simforge_native.embedded_sensors.ExternalSensorRig` | `bevy` |

Selecting a profile whose provider is missing raises `ProfileUnavailableError`
naming the extra. Documents a profile cannot execute are rejected by that
profile's admission; nothing falls back to another backend.

Roadway camera frames are owned by the kernel Episode, not a Python scene
provider: `BevySensorRig(episode).frames(observation)` exposes the already
rendered passes as NumPy views. Release each `HostFrame` before the next
`episode.step()`/`reset()`; copy explicitly for a longer image history. Both
embedded `libsimforge_render` and a dedicated renderer-service socket are
supported (full channel/lease contract in `docs/world-session.md`).
The articulated profile remains a separate physics owner: its renderer-only
`ExternalSensorRig` consumes MuJoCo-recorded full-body transforms and preserves
the existing host/CUDA-lease paths. It does not implement a world/policy loop.

## Environments

```python
from simforge_oss_gym import SimForgeEnv, SimForgeVectorEnv, make_vector_env

env = SimForgeEnv("episodes.json", seed="seed-a")          # action_mode="setpoint" -> Box(2,) [speed, accel]
obs, info = env.reset()
obs, reward, terminated, truncated, info = env.step([9.0, 0.0])

vec = SimForgeVectorEnv("episodes.json", num_envs=8, action_mode="control")  # Box(3,) [throttle, brake, steer]
obs, infos = vec.reset(seed=0)
obs, rewards, terminated, truncated, infos = vec.step(actions)   # (8, 3); NEXT_STEP autoreset

gpu = make_vector_env("roadway-dynamic-gpu-v1", episodes_spec="episodes.json", num_envs=4096, device="cuda:0")
```

Observations: `state_vector` float64 `(10,)` (fixed engine layout), `objects`
float32 `(max_objects, 5)` rows `[range_m, bearing_rad, range_rate_mps, los,
valid]`, optional `bev` float32 `(H, W, 3)`. Every array is an owned copy.
`info` carries `t_s`, `ego`, `object_ids`, `reward_terms` and (single env by
default) the engine `events`, pair `minima` and the decision's `causal` frame.
`terminated` = contact, route-corridor exit, red crossing or clean goal;
`truncated` = clip end / decision horizon / engine completion; stepping a
finished episode raises.

`env.checkpoint()` / `env.restore(bytes)` carry the complete continuation
state (engine RNG, timers, controllers, contacts, episode accumulators) and
resume bit-identically.

`SimForgeVectorEnv` now owns one native **`EpisodeBatch`**, not `SessionBatch`.
Its N worlds are the same kernel `Episode` used by drive/campaign evaluation.
Each `step(actions)` makes one GIL-released, CPU-parallel `step_all` call,
including NEXT_STEP autoresets. An ended row ignores its action on the next
call, returns the reset observation, zero reward and cleared termination flags;
`infos["autoreset"]` marks that row so a learner excludes it from decisions.
`infos["collision"]`, `infos["goal"]` and `infos["term_reason"]` are native
facts, not classifications inferred from reward values.
ABI 4 exposes all eleven reward contributions in `infos["reward_terms"]`
`(N, 11)`, with column order in `infos["reward_term_names"]` /
`native.REWARD_TERM_NAMES`. They sum to the scalar reward, including terminal
terms; native reset-only rows are zero. Defaults and the distinction between
route-corridor exit and authoritative road-surface offroad are in the
[kernel reward table](../../docs/engineering/closed-loop-training.md#native-teacher-reward-2026-09-22).

`vec.reset(seed=42)` expands to unsigned identities `42+i` in Rust. Explicit
seed lists also accept the engine's string/negative-number normalization.
Autoreset reuses each world's current seed. `vec.checkpoint()` /
`vec.restore(bytes)` preserve the **whole batch**: RNG/physics state, policy
follower and held trajectory anchor, warm-up, pending resets and v2 trace/digest.
Restore validates all worlds before replacing any; it may use a different
worker count. `vec.trace_digests()` exposes per-world Episode identities.
Observations are owned copies, including across a later step/restore.

The low-level native constructor is
`EpisodeBatch([spec_json, ...], [graph, ...], threads=8)`, using the exact
`Episode` spec JSON. `step_all` takes `(N,2)` speed/acceleration setpoints or
`(N,3)` controls; `step_all_json` accepts compact Episode actions, including
trajectories. Camera channels and realtime mode are explicitly refused in a
batch; use individual Episodes for those. GPU-batched Episode dynamics is a
follow-on, not an implicit fallback to the restricted GPU backend.

`SimForgeEnv` / `PolicyRunner` intentionally remain the **single-env low-level
EnvSession surface** (including declarative latency on PolicyRunner). Their
clean cutover to measured-deadline Episode is a named follow-up, not part of
this W1 vector migration. Training uses `SimForgeVectorEnv`, even for N=1.

### Observation presets

Both `SimForgeEnv` and `SimForgeVectorEnv` accept `observation_preset=...`.
Omitting it preserves the spec's historical privileged configuration.
These additions ship with `simforge-oss-gym 0.1.0rc70`; use its matching
native extension, not new Python source over the live trainer's rc61 wheel.

| preset | native channels |
|---|---|
| `state` | privileged state vector + objects; no BEV or signals |
| `state+bev` | privileged state + objects + default `(200,160,3)` BEV |
| `visible` | LOS/range/FOV-gated objects and nearest range, plus native signal state; no BEV |
| `visible+signals` | visible channel with native per-approach signal observations |
| `cams:<profile>` | kernel Episode state + concrete Cameras rig; requires an explicit renderer backend |

`simforge_oss_gym.episodes.observation_channels(preset)` produces the matching
tagged `EpisodeSpec.observation.channels` values. For cameras, call
`observation_channels("cams:alpamayo-2cam", backend={"kind":"service","socket":...})`
and pass the result to `native.Episode`. Python and the TypeScript drive bench
share the packaged `camera_profiles.json` calibration registry.
`SimForgeEnv`/`SimForgeVectorEnv` are fast state environments and explicitly refuse
camera presets; they never silently drop cameras. The endpoint runner accepts
`bevy:<rig.json>` with an explicit backend and either a profile or concrete rig.

```python
env = SimForgeEnv("episodes.json", observation_preset="visible", info_channel=False)
obs, info = env.reset(seed=42)
# obs["objects"] contains only observed actors; obs["state_vector"][9] is
# their nearest range (1e6 if none). Hidden rows are invalid zero padding.
signals = info["signals"]  # per lane: current phase, timeToChangeS or None
```

Signals are explicit infrastructure state, not camera detections. Full schema,
channel/checkpoint privilege rules, collision partner metadata and the
before/after privileged digest receipt are in
[`docs/policy-step.md`](../../docs/policy-step.md#native-observation-channels-w0-2026-09-22).
Python `StepView.term_reason`/Gym `info["term_reason"]` identify `collision`,
`offroad` (authored corridor), `red_crossing`, `goal` or `horizon`; contact
`info["collision"]` gives the actual partner kind.
The optional diagnostic `info_channel` contains ground truth (causal/minima);
do not use it as visible-policy input.

## Episode specs

Form A lists pre-materialised instances (raw input or `scenario-instance`
envelope) with a topology path/inline document or a `mapId` resolved against
the installed map corpus (`SIMFORGE_MAPS_CACHE_ROOT`/`SCEN_DEV_ASSETS`, CLI
layout). Form B is `template` x `map` x `site` x `seeds`, materialised by the
native compiler. Spec-level `episode` (camelCase `EpisodeConfig`) applies to
every session; constructor keywords override it.

## Live worlds and policies

```python
from simforge_oss_gym import SimForgeWorld, PolicyRunner

world = SimForgeWorld("episodes.json", mode="live")
world.batch([{"kind": "spawn", "spawn": {"kind": "car", "pose": {"x": 12.0, "z": -3.0}}}])
truth = world.subscribe(capacity=64)
world.advance(50)
frames = truth.drain()                 # scene-state.v1 documents, one per committed tick
assert world.replay()["outcomesMatch"]

runner = PolicyRunner(env, deadline_ms=50.0, fallback="repeat-last", execution="pure-pursuit")
runner.reset("seed-a")
decision = runner.act_trajectory(points, elapsed_ms=measured_ms)   # (K, 5) ego-frame plan
```

`simforge-oss-policy-runner` (`python -m simforge_oss_gym.tools.policy_runner`)
dispatches one seeded kernel `Episode`. Kernel reset/step own warm-up, barriers,
deadline/fallback, envelope enforcement and result core. The runner writes
`trace.episode-v2.jsonl` plus a verified legacy conversion at `trace.jsonl` and a
summary linking both identities. The evaluation campaign and cloud eval worker
both spawn this same entrypoint.

```sh
# reference policy, offline simulation time (default): the engine pauses at
# every inference barrier, so no deadline exists and slow hardware costs wall
# time rather than validity
simforge-oss-policy-runner --spec tests/fixtures/synthetic-episode.json \
    --policy trajectory --seed 42 --steps 40 --out trace.jsonl

# latency-aware real time: explicit deadline, measured latency, fallback on a
# miss (--force-miss-at exercises the fallback deterministically)
simforge-oss-policy-runner --spec ... --policy scripted --mode realtime \
    --deadline-ms 50 --fallback zero-control --force-miss-at 9 --out trace.jsonl

# a real model in the loop over the policy-endpoint socket, with REAL camera
# frames from the kernel Cameras channel (bevy:<rig.json>); a warm-up phase
# supplies 16 real ego poses and 4 real frames per camera before the model acts
simforge-oss-policy-runner --spec scenario.episodes.json --policy endpoint \
    --endpoint-socket /tmp/simforge-alpamayo.sock --camera-profile alpamayo-4cam \
    --frame-source bevy:/path/to/rig.json --replan-hz 0.5 --warmup-policy scripted --warmup-steps 16 \
    --steps 300 --out trace.jsonl

# a reconstructed scene: the measured validity envelope is enforced every
# decision and the episode stops at a breach (term_reason envelope_exceeded)
simforge-oss-policy-runner --spec ... --replay-context /path/to/bundle --out trace.jsonl
```

Camera observations are never synthesized: without a frame source, or with an
incomplete camera window or ego history, the runner refuses with a typed error
instead of padding the observation.

Prerecorded `dir:` images are not a closed-loop source: they cannot reflect
policy-diverged state. Rig/backend and trace-version details, including the
corrected legacy object rows, are in [`docs/eval-campaigns.md`](../../docs/eval-campaigns.md).

The durable `python -m simforge_oss_gym job` workload delegates to this runner
too. Its v2 checkpoints preserve completed episodes and restart an interrupted
episode from its seed; they do not claim mid-Episode continuation. Interrupted
traces are retained as evidence and old native-session checkpoint files are
refused rather than silently interpreted as Episode checkpoints.

The PPO collector now dispatches `EpisodeBatch.step_all` through `VectorEnv`;
there is no `SessionBatch` stepping or host-side autoreset path in Python.
The learner samples actions and computes PPO/GAE only. The kernel owns warm-up,
world advancement, reward, termination, observation channels and v2 evidence.
See [the EpisodeBatch throughput entry](../../docs/engineering/benchmarks/state-throughput-2026-09-22-batch.md)
for the fixed-suite 1/8/32/64 scaling row alongside the retained SessionBatch baseline.

## Render-free PPO teacher

Install the `train` extra alongside the matching native extension.
The obsolete `scripts/rl/train_ppo.py` socket-server recipe is removed;
the public entrypoint is `simforge train --recipe ... --config ...`.
The seeded random MLP formerly named `torch` in the reference runner is
removed. A real teacher checkpoint is evaluated through the drive bench.

For a source checkout, use
`node --import tsx --conditions=development packages/cli/src/main.ts` in place
of `simforge` below. That is the actual launcher used for the recorded Bevy
evaluations; an installed CLI must include these source changes.

```sh
# Use a frozen, resolved trainer config whose train/val paths came from
# `simforge scenarios materialize`; see the W2/W3 contract for its schema.
simforge train --recipe ppo-teacher --config /path/to/teacher.yaml \
  --device cpu --max-decisions 200000 --out /path/to/new-run

# Direct Python module smoke also records real split/config provenance.
PY=adapters/gym/.venv/bin/python
RUN=/path/to/new-run
$PY -m simforge_oss_gym.train.ppo \
  --train /path/to/train.episodes.json --val /path/to/val.episodes.json \
  --out "$RUN" --device cpu --threads 8 --updates 2 --hidden 32

# Teacher serving stays CPU-only; coordinate a local Bevy renderer slot.
simforge drive run --policy "torch:$RUN/checkpoints/update-000002.pt" \
  --scenario /path/to/val.episodes.json --seed 100 --duration 6 \
  --out "$RUN/rollouts/manual"

# Native reward/route validation, NOT a campaign score/promotion:
$PY scripts/rl/evaluate_policy.py --checkpoint "$RUN/checkpoints/update-000002.pt" \
  --spec /path/to/val.episodes.json --out "$RUN/native-validation.json"
```

The historical run `~/simforge-assets/runs/drive/training/ppo-visible-20260922/`
used simforge1 A100 GPU 5 for its 5,393,797-parameter DeepSets learner and
240 CPU native sessions over eight workers. It completed its 30M-decision
budget before this EpisodeBatch cutover; its evidence is not relabelled.
`metrics.jsonl` records every PPO update; `dashboard.png` is regenerated every
update. The `train.collect` process mirrors remote artifacts and serves the
tiny live page at `http://127.0.0.1:8767/`. It consumes `gpu-permit.json`
grants before rendering checkpoint requests; no grant means queued, not fake
or silently skipped evaluation. `rollouts/update-*/` contains real bench
video/score/result/verification evidence. `train.timelapse --run "$RUN"`
assembles measured curve prefixes beside those chronological Bevy clips.

The frozen compiler grid is queue-tail plus `cpnco-dartout`, each on Di Rosa
and San Ramon 25 P2. Training uses site rank 0 and seeds 0–59 (240 episodes);
validation uses site rank 1 and seeds 100–119 (80 episodes). The **existing
frozen run** snapshots templates with explicit `metricSubject: ego`;
sources, overrides, sites, seeds, hashes, compiler receipts and initial-feasibility
warnings are retained. New materializations no longer inject that workaround:
native resolution honors `role:ego` and every road-vehicle kind. Frozen
templates/specs and the live rc61 wheel are not rewritten. No matcher
requirement is relaxed. The compiler's
default `drawIndex=-1` fixes authored parameter values, so seeds repeat four
spatial cells rather than claiming 240 distinct layouts. Geography is shared,
and full occlusion/contact/solvability admission is not qualified.

PPO observes ego speed/acceleration/lateral motion plus LOS-gated object
sets. World position, world heading, native route-s and privileged nearest
range do not enter the network. The actor outputs bounded speed/acceleration
**setpoints**; steering is the native authored-route follower, not learned
controls. BEV is disabled. The historical frozen overnight run used
`0.05 Δroute_m + 5 route_end_goal − 20 collision − 0.005 |accel| Δt`,
with proximity disabled and no time/jerk/corridor/red-crossing/queue terms.
Current native defaults implement the complete
[reward table](../../docs/engineering/closed-loop-training.md#native-teacher-reward-2026-09-22);
PPO freezes those binary-provided defaults plus any explicit episode overrides
in `run-config.json`, logs `reward_<term>_mean` in every metrics row, and plots
progress, stuck and jerk curves. No reward is computed in Python.
The frozen historical run also predates the native visible channel; its Python
encoder still masks rows. The new kernel reward and observation gates do not retroactively
change that run or claim its qualification. In particular,
low native collision rate is not a safety claim or successful queue-goal
qualification. Geometric completion uses native route length minus initial
route position, not speed × clip.

Checkpoints include weights, optimizer and hash/observation/action sidecars.
`--resume <checkpoint>` may continue only the last logged update of the same
frozen split; it restores learner counters/optimizer but explicitly resets
native episodes. This is **not** bit-identical environment continuation.
The run stops before another full rollout would exceed its decision budget, or
at its configured timer. Checkpoints are now immutable model-store entries;
the unified trainer/store/student interfaces are documented in
[`closed-loop-training.md` W3](../../docs/engineering/closed-loop-training.md#w3--trainer-and-policy-servers).
That implementation does not qualify the old prototype for promotion, claim
three-seed generalization or establish student/DAgger improvement.

## Native module

`simforge_oss_gym.native` re-exports the extension: `ScenarioInput`,
`LaneGraph`, `MapBundle`, `EnvSession`, `Episode`, `EpisodeBatch`,
`SessionBatch`, `WorldSession`, `PolicySession`, `compile_template`,
`compile_situation`, `find_sites`, `run_simulation`, `replay_world_log`.
Legacy EnvSession actions are flat `float64[ACTION_WIDTH]` rows (`NaN` = unset);
Episode uses compact action JSON and EpisodeBatch has the dense fast path above.
Stepping releases the GIL. SessionBatch remains a low-level native API, not the
Python training implementation.

## Development

```sh
cd adapters/gym
maturin develop            # builds the extension in place (Rust toolchain required)
pytest tests
maturin build --release    # wheel with the extension
```
