# SimForge SDK

Deterministic driving-scenario simulation and rendering, as a library, a CLI
and a Python gym. The same engine and renderer power the hosted SimForge app at
[simforge.ai](https://simforge.ai). Apache-2.0.

- **Engine** (`native/`): `simforge-core`, `simforge-compiler`, `simforge-session`. It is
  fixed-step (20 ms) and bit-reproducible. It writes canonical traces whose digests are pinned
  by a golden corpus.
- **Renderer** (`renderer/`): `simforge-render` is one Bevy renderer with two presets. `training`
  is fast and sensor-accurate, and `showcase` is the high-fidelity look. It renders cameras,
  ID/depth/segmentation, lidar and radar. It runs headless on Vulkan (Linux), Metal (macOS)
  and DX12/Vulkan (Windows).
- **CLI** (`native/crates/simforge-cli`, binary `simforge`): the scenario-package workflow,
  `package`, `maps list`/`maps pull`, `assets pull`, `timeline build`, `render`, `simulate`,
  `env serve` and `doctor`, the authoring commands, and `login`/`logout`/`auth status` for
  your SimForge account. Every command prints JSON on stdout and exits
  0 (ok), 1 (could not run) or 2 (input rejected).
- **Python** (`adapters/`): `simforge-oss-gym` (Gymnasium environments over the Rust runtime,
  a policy runner, vector envs), `simforge-oss-timeline` (the shared pose sampler) and adapters:
  CARLA with your own CARLA 0.10 install, Alpamayo (code only, weights from Hugging Face under
  their terms), AutoE2E, ROS 2, GPU batch (Warp) and articulated physics (MuJoCo).

> Status: 0.2.0 in progress. Binaries, the container image and the wheel are published
> from the v0.2 release onward; until then, build from source.

## Install

From source (Rust 1.98, pinned by `rust-toolchain.toml`; Vulkan headers on Linux):

```sh
git clone https://github.com/SimForgeinc/simforge-sdk
cd simforge-sdk
cargo build --release -p simforge   # -> target/release/simforge
```

Python (uv or pip; the extension is built by maturin):

```sh
uv pip install ./adapters/gym          # simforge-oss-gym
uv pip install ./adapters/timeline     # simforge-oss-timeline
```

## Quickstart: render a scenario package

A scenario package (`simforge.scenario-package/v1`, see `docs/engineering/scenario-package.md`)
is what SimForge exports: the scenario document, its canonical trace, the render timeline,
and the map and actor closures by digest. In the hosted app, open a scenario and choose
**Export for CLI**. Then:

```sh
simforge doctor                                          # Vulkan adapter, ffmpeg, caches, registries
simforge package verify scenario.zip                     # every member checked against the manifest
simforge package inspect scenario.zip                    # producer, map release, actor closure
simforge package import scenario.zip --into ws/          # unpack into a workspace
simforge maps pull richmond-field-station@<version>      # the map release the package names, by digest
simforge assets pull                                     # actor models + ATTRIBUTION.json (pinned closure)
simforge render ws/ --preset training --rig rig.json --out out/
```

`out/` holds the frames, the ID/depth passes, lidar/radar if the rig asks for them, and
`results.json`, including the renderer's parity against the timeline sampler. Replay
never re-simulates: the pixels follow the package's trace exactly.
`simforge simulate ws/` re-simulates from the resolved inputs instead. The result is
labelled as re-simulated and gets a new trace digest. `richmond-field-station` is the
public map; for your organization's maps, sign in first (below).

## Sign in: your account's maps

```sh
simforge login                  # opens simforge.ai: sign in, check the device, Approve
simforge login --device         # SSH or no browser: prints a URL and a code to approve anywhere
simforge auth status            # account, organization, scopes, expiry, host, where the tokens are
simforge maps list              # the maps your organization can use ("registry.authenticated": true)
simforge maps pull <name>@<version>
simforge logout                 # revokes the session on the host and deletes the tokens
```

`login` is OAuth 2.0 for a native app: a browser sign-in with PKCE and a loopback
redirect (or the device code grant), a short-lived access token and a rotating refresh
token, scoped to `maps:read` for the organization you approve. The tokens live in the OS
keychain, or in a 0600 file under `~/.config/simforge` when there is no keychain (`auth
status` says which). They are never printed. `--host` (or `SIMFORGE_HOST`) picks another
SimForge deployment; `SIMFORGE_TOKEN` supplies an access token for CI. While logged in,
`maps list`, `maps pull` and `package import` read your account's registry; revoke a
machine's access any time on the account page under **CLI sessions**.

The Python gym runs the same engine in-process:

```python
from simforge_oss_gym import SimForgeEnv

env = SimForgeEnv("episodes.json", seed="seed-a")   # action_mode="setpoint": Box(2,) [speed, accel]
obs, info = env.reset()
obs, reward, terminated, truncated, info = env.step([9.0, 0.0])
```

A closed-loop episode server with rendered sensors (`simforge env serve`) and its
Gymnasium socket client are landing next.

## Repository

**This repository is a mirror; development happens upstream; PRs are imported
manually.** The SDK is developed in SimForge's platform repository (at `sdk/`) and
exported here automatically; see [CONTRIBUTING.md](CONTRIBUTING.md).

See [AGENTS.md](AGENTS.md) for the layout, rules and checks (`scripts/gate-local.sh` runs
them all: rustfmt/clippy on touched files, cargo nextest, the Python suites and the
lavapipe render goldens). Contracts and fixtures live in `contracts/` and `fixtures/`.
Engine semantics are versioned by `ENGINE_SEM_VER` (`docs/engineering/engine-semver.md`).

## Formerly simforge-oss

This repository was `SimForgeinc/simforge-oss` (old links redirect). SimForge Studio and
the TypeScript packages have moved out: Studio is hosted at [simforge.ai](https://simforge.ai),
and the desktop previews are discontinued (see [DEPRECATED.md](DEPRECATED.md)). Their
history stays in this repository.
