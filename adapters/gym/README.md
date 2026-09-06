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
| resident Bevy sensors | `bevy_sensors.BevySensorRig`; `ArticulatedEnv(sensors="bevy")` | `bevy` |

Selecting a profile whose provider is missing raises `ProfileUnavailableError`
naming the extra. Documents a profile cannot execute are rejected by that
profile's admission; nothing falls back to another backend.

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
`terminated` = collision or goal; `truncated` = clip end / decision horizon /
engine completion; stepping a finished episode raises.

`env.checkpoint()` / `env.restore(bytes)` carry the complete continuation
state (engine RNG, timers, controllers, contacts, episode accumulators) and
resume bit-identically.

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

`simforge-oss-policy-runner --spec ... --policy trajectory --seed 42 --out
trace.jsonl` runs seeded reference policies with deadline accounting and writes
a digest-chained JSONL trace.

## Native module

`simforge_oss_gym.native` re-exports the extension: `ScenarioInput`,
`LaneGraph`, `MapBundle`, `EnvSession`, `SessionBatch`, `WorldSession`,
`PolicySession`, `compile_template`, `compile_situation`, `find_sites`,
`run_simulation`, `replay_world_log`. Actions cross as flat
`float64[ACTION_WIDTH]` rows (`ACTION_FIELDS` names the slots; `NaN` = unset);
metadata crosses as JSON once per call; stepping releases the GIL.

## Development

```sh
cd adapters/gym
maturin develop            # builds the extension in place (Rust toolchain required)
pytest tests
maturin build --release    # wheel with the extension
```
