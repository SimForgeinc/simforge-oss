# Closed loop with Gymnasium

`simforge-oss-gym` provides Gymnasium environments over the SimForge engine:

```python
from simforge_oss_gym import SimForgeEnv, SimForgeVectorEnv

env = SimForgeEnv("episodes.json", seed="seed-a")    # action_mode="setpoint": Box(2,) [speed, accel]
obs, info = env.reset()
obs, reward, terminated, truncated, info = env.step([9.0, 0.0])

vec = SimForgeVectorEnv("episodes.json", num_envs=8, action_mode="control")  # Box(3,) [throttle, brake, steer]
```

Observations are a fixed `state_vector`, the `objects` table and an optional
bird's-eye view; `info` carries the engine events and reward terms. See the
package README for the full contract.

## Rendered sensors: `simforge env serve`

`simforge env serve <workspace> --socket <path>` runs the same episodes as a
server (`reset`, `step(action)`, `observe` over a Unix socket; a named pipe on
Windows) with the renderer's sensors at a fixed decision rate. The gym's
socket client for it is part of the 0.2 series; until it lands, the
in-process environments above are the supported interface.

`simforge-oss-policy-runner` drives a policy over a set of episodes and writes
per-episode results.
