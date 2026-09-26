# Installing simforge

Releases: https://github.com/SimForgeinc/simforge-sdk/releases. Stable releases
are marked "Latest"; release candidates (`vX.Y.Z-rc.N`) are pre-releases and
never reach the installers' `latest`, Homebrew, `:latest` or PyPI.

| Platform | Artifact |
|---|---|
| Linux x86_64 (glibc 2.28+: Ubuntu 20.04+, Debian 11+, RHEL 8+) and aarch64 (glibc 2.30+: Ubuntu 20.04+, Debian 11+) | `simforge-<triple>.tar.xz`, `simforge-installer.sh` |
| macOS (Apple silicon) | `simforge-aarch64-apple-darwin.tar.xz`, installer, Homebrew |
| Windows x86_64 | `simforge-x86_64-pc-windows-msvc.zip`, `simforge-installer.ps1` |
| Container | `ghcr.io/simforgeinc/simforge:<version>` ([container.md](container.md)) |

Windows: `powershell -ExecutionPolicy Bypass -c "irm https://github.com/SimForgeinc/simforge-sdk/releases/latest/download/simforge-installer.ps1 | iex"`.

From source (the renderer carries patched Bevy crates, so build from the
repository, not crates.io):
`cargo install --locked --git https://github.com/SimForgeinc/simforge-sdk simforge`.

Runtime needs: a Vulkan 1.3 driver (Linux/Windows) or Metal (macOS), or Mesa
lavapipe for CPU rendering; `ffmpeg` on PATH for video (run as a separate
program, never linked). The archive also contains `skills/` (these files),
`LICENSE`, `NOTICE` and `THIRD_PARTY_NOTICES.md`.

## Verify a download

Every asset is signed keyless with Sigstore by the release workflow and has a
GitHub build-provenance attestation; `sha256.sum` lists every digest.

```sh
TAG=v0.2.0; A=simforge-x86_64-unknown-linux-gnu.tar.xz
gh release download "$TAG" -R SimForgeinc/simforge-sdk -p "$A" -p "$A.sigstore.json"
cosign verify-blob --bundle "$A.sigstore.json" \
  --certificate-identity-regexp '^https://github\.com/SimForgeinc/simforge-sdk/\.github/workflows/release-(sign|container)\.yml@refs/tags/v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com "$A"
gh attestation verify "$A" --repo SimForgeinc/simforge-sdk
```

Image: `cosign verify ghcr.io/simforgeinc/simforge:<version> --certificate-identity-regexp '^https://github\.com/SimForgeinc/simforge-sdk/\.github/workflows/release-container\.yml@refs/tags/v' --certificate-oidc-issuer https://token.actions.githubusercontent.com`.
SBOMs (CycloneDX) for the binary, the Python wheels and the image are release
assets. macOS binaries are ad-hoc signed and Windows binaries unsigned: the
Sigstore signature and the sha256 are the integrity check.

## Python

`pip install simforge-oss-gym` (plus `simforge-oss-timeline`, `-gpu`,
`-physics`, `-render`, released together at the CLI's version). See the
simforge-closed-loop skill.
