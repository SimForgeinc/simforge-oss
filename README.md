# SimForge SDK

Deterministic driving-scenario simulation and rendering: the engine, the
renderer, the `simforge` CLI and the Python gym. Apache-2.0.

**Status: 0.2.0 in progress.** This repository was `simforge-oss`; SimForge
Studio (web and desktop) has moved out of it. The hosted Studio is at
https://simforge.ai. The desktop previews are discontinued; see
[DEPRECATED.md](DEPRECATED.md).

- `native/`: the engine (`simforge-core`, `simforge-compiler`, `simforge-session`)
- `renderer/`: `simforge-render`, one renderer with the `training` and `showcase` presets
- `adapters/`: `simforge-oss-gym` and the adapters (CARLA with your own CARLA 0.10 install, Alpamayo, AutoE2E, ROS 2)

See [AGENTS.md](AGENTS.md) for the layout, rules and checks.
