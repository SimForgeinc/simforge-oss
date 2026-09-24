# Install the CLI

Every release is on the
[GitHub releases page](https://github.com/SimForgeinc/simforge-sdk/releases):
signed archives for Linux (x86_64, aarch64; glibc 2.28 or newer), macOS
(Apple silicon) and Windows (x86_64), installers, a container image, the
Python wheel, SBOMs and build provenance.

## Installer (Linux, macOS)

```sh
curl --proto '=https' --tlsv1.2 -LsSf \
  https://github.com/SimForgeinc/simforge-sdk/releases/latest/download/simforge-installer.sh | sh
simforge doctor
```

## Installer (Windows, PowerShell)

```powershell
powershell -ExecutionPolicy Bypass -c "irm https://github.com/SimForgeinc/simforge-sdk/releases/latest/download/simforge-installer.ps1 | iex"
simforge doctor
```

## Homebrew

```sh
brew install simforgeinc/tap/simforge
```

## From source

The renderer carries patched Bevy crates (`[patch.crates-io]` in the
workspace), so build from the repository, not from crates.io:

```sh
cargo install --locked --git https://github.com/SimForgeinc/simforge-sdk simforge
```

## Runtime requirements

- A Vulkan 1.3 driver (Linux, Windows) or Metal (macOS). No GPU? Mesa's
  lavapipe (`mesa-vulkan-drivers` on Debian/Ubuntu) renders on the CPU, slowly
  and byte-identically across runs.
- `ffmpeg` on `PATH` if you want videos. The CLI runs it as a separate
  program; it is never linked or bundled.

`simforge doctor` checks all of this and says what is missing. It never
silently degrades: a missing GPU is reported, not replaced.

Pre-releases (`vX.Y.Z-rc.N`) are on the releases page only; installers, the
`latest` image tag, Homebrew and PyPI follow stable releases.
