# Python packages

```sh
pip install simforge-oss-gym
```

Five packages are released together, at the CLI's version, and pin each
other exactly (`==`):

| Package | What | Wheels |
|---|---|---|
| `simforge-oss-gym` | Gymnasium environments over the engine (`SimForgeEnv`, vector envs, the policy runner) | abi3, one per platform |
| `simforge-oss-timeline` | render-timeline tools over the engine | abi3, one per platform |
| `simforge-oss-gpu` | the `roadway-dynamic-gpu-v1` profile (Warp/CUDA batch); `pip install "simforge-oss-gym[gpu]"` | pure Python |
| `simforge-oss-physics` | the articulated MuJoCo profiles; `pip install "simforge-oss-gym[articulated]"` | pure Python |
| `simforge-oss-render` | rendered sensors in-process; `pip install "simforge-oss-gym[bevy]"` | pure Python |

The native wheels are abi3: one wheel per platform covers CPython 3.10 and
newer (manylinux_2_28 x86_64/aarch64, macOS arm64, Windows x86_64), and each
ships its own `THIRD_PARTY_NOTICES` for the Rust crates it links.

`simforge-oss-render` loads the renderer library (`libsimforge_render`) at
runtime from `$SIMFORGE_RENDER_LIB` or an installed native runtime; it says so
and stops if it cannot find one.

Wheels for a release candidate are attached to its GitHub release; PyPI gets
stable versions only.
