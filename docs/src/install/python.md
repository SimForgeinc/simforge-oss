# Python: simforge-oss-gym

```sh
pip install simforge-oss-gym
```

One abi3 wheel per platform covers CPython 3.10 and newer (manylinux_2_28
x86_64/aarch64, macOS arm64, Windows x86_64). The wheel's native extension is
built from the same engine crates as the CLI and ships its own
`THIRD_PARTY_NOTICES`.

The gym talks to `simforge env serve` (see
[Closed loop with Gymnasium](../guide/closed-loop.md)), so install the CLI too.
Wheels for a release candidate are attached to its GitHub release; PyPI gets
stable versions only.
