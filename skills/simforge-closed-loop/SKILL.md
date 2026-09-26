---
name: simforge-closed-loop
description: Run closed-loop SimForge episodes with `simforge env serve` and drive them from Python with the simforge-oss-gym Gymnasium client (SimForgeSocketEnv, or the in-process SimForgeEnv), optionally with rendered sensors; plug in a driving model or policy and evaluate it. Use for reinforcement learning, policy evaluation, or connecting an autonomous-driving stack to a SimForge scenario.
---

# Closed loop: env serve + the gym

`simforge env serve` runs a workspace's episode as a server on a Unix socket
(`simforge.env-serve/v1`): reset, step(action), observe, with the rig's sensors
rendered on each observation. The Python client is `simforge-oss-gym`.

## Serve

```sh
simforge env serve ws --socket /tmp/sf.sock --no-sensors                     # engine only, fastest
simforge env serve ws --socket /tmp/sf.sock --rig rig.json --passes rgb,depth # with rendered sensors
```

It prints one ready line (JSON, with the socket path) and serves until asked to
stop. Rendering on a CPU needs `--allow-software-adapter`. `--decision-hz`
overrides the episode's decision rate; `--episode` passes an `EpisodeConfig`.

## Drive it from Python

```sh
pip install simforge-oss-gym
```

```python
from simforge_oss_gym.socket_env import SimForgeSocketEnv, spawn_env_server

server, ready = spawn_env_server("ws/", "/tmp/sf.sock", "--no-sensors")  # or run env serve yourself
env = SimForgeSocketEnv("/tmp/sf.sock")      # action_mode="setpoint": Box(2,) [target_speed_mps, target_accel_mps2]
obs, info = env.reset(seed=7)
while True:
    action = my_policy(obs)                  # your model
    obs, reward, terminated, truncated, info = env.step(action)
    if terminated or truncated:
        break
```

- `action_mode="control"` takes `[throttle, brake, steer]`.
- Observations: `state_vector`, `objects` (rows `[range_m, bearing_rad,
  range_rate_mps, los, valid]`), optional `bev`; the same spaces as the
  in-process `SimForgeEnv`, so a policy runs unchanged on either.
- Sensor frames ride in `info["sensors"]`: `{source_id: {pass: ndarray}}`
  (`rgb`/`id`/`semantic` uint8 HxWx4, `depth` float32 HxW reverse-Z, lidar/radar
  raw bytes).
- `spawn_env_server` finds the binary via `binary=`, `$SIMFORGE_BIN`, or PATH.
- A failed request raises `EnvServeError` with the server's `code` and `reason`.

In-process (no server, no sensors): `from simforge_oss_gym import SimForgeEnv,
SimForgeVectorEnv` over an `episodes.json`; vector envs step many episodes.

## Evaluating a model

Keep seeds explicit (`env.reset(seed=...)`), log `info["reward_terms"]` and the
engine `events`, and run the same seed list for every model. The socket and
in-process paths produce the same episode byte for byte, so results compare.

## Reference

<!-- simforge:reference env serve -->
_Generated from `simforge --help` (CLI 0.2.0-rc.1) by scripts/skills/skills.py; do not edit._

#### `simforge env serve`

Serve reset/step/observe episodes with rendered sensors over a Unix socket

Usage: `simforge env serve <workspace> [flags]`

| Argument / flag | | What |
|---|---|---|
| `<workspace>` | required | The workspace directory (an imported scenario package) |
| `--socket PATH` | required | The Unix socket to listen on (refused if another server is live on it) |
| `--rig RIG.JSON` |  | The sensor rig (`simforge.render-rig/v1`, as `simforge render` takes it) |
| `--no-sensors` |  | Serve the episode without a renderer (observations are the engine's only) |
| `--preset PRESET` | one of `training`, `showcase`; default `training` | The render preset for observations |
| `--passes PASSES` | one of `rgb`, `id`, `depth`, `semantic`; default `rgb`; repeatable | Camera passes rendered per observation, comma-separated |
| `--textures TEXTURES` | one of `uastc-full`, `bc7-512`; default `uastc-full` | The staged texture tier |
| `--episode EPISODE.JSON` |  | Episode configuration (camelCase `EpisodeConfig`, as the gym's episode specs carry it) |
| `--decision-hz HZ` |  | Policy decisions per second (overrides the episode's `decisionHz`) |
| `--max-objects N` | default `64` | Rows of the `objects` observation |
| `--allow-software-adapter` |  | Render on a software (CPU) Vulkan adapter such as lavapipe, explicitly |
| `--map-dir DIR` |  | Use this map directory instead of the installed map found by content |
| `--cache-root DIR` |  | Map cache root to search. Default: SIMFORGE_MAPS_CACHE_ROOT, then $XDG_DATA_HOME/simforge/maps |
| `--assets-root DIR` |  | Actor-asset root. Default: SIMFORGE_ACTOR_ASSETS_ROOT, then $XDG_DATA_HOME/simforge/actor-assets |
| `--actor-closure SHA256` |  | The actor closure to bind, instead of the workspace's `catalog.actorClosureDigest` |
| `--vram-budget BYTES` |  | A texture budget in bytes; without it admission is skipped (reported) |
| `--log FILE` |  | Where the renderer's diagnostics go. Default: `<socket>.log` |
| `--allow-map-drift` |  | Render on the installed map release even where its members differ from the workspace's map closure (recorded; the default refuses) |
| `--shm-size-mb MIB` | default `512` | Size of the renderer's shared-memory frame ring, MiB |

Exit codes: `0` ok; `1` command error: the command could not run; `2` findings: the command ran and found something wrong with its input.
<!-- /simforge:reference -->
