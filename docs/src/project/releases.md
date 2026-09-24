# Releases and compatibility

## Versions

The CLI and the five Python packages share one version, semver `0.y.z`,
starting at 0.2.0. Release candidates are `vX.Y.Z-rc.N` (`X.Y.ZrcN` on PyPI).
The Rust crates are not published to crates.io; the CLI ships as binaries.

Contract identities travel inside the artifacts, not in the version number:
the package schema (`simforge.scenario-package/v1`), the trace format and its
upgrader chain, `engineSemVer`, the timeline sampler version and the renderer
protocol. A package records the oldest CLI that reads it (`producer.minCli`);
the CLI reads every package whose trace its upgraders cover and whose `minCli`
is not newer than itself, and refuses the rest with `package_reader_too_old`.

## Channels

| Channel | Gets |
|---|---|
| GitHub releases | every release, candidates included, as soon as it is built and signed (marked *pre-release*) |
| `ghcr.io/simforgeinc/simforge:<version>` | every release |
| `:X.Y`, `:latest`, Homebrew, PyPI, `releases/latest` | stable releases, once promoted |

## From pre-release to stable

A new version is first published as a GitHub *pre-release*. It becomes the
stable (`latest`) release when:

1. the release smoke passed (every artifact installed and run, signatures and
   provenance verified, a lavapipe render of a fixture package matched its
   recorded hashes);
2. the GPU smoke passed (the same render and a closed-loop run on NVIDIA
   hardware);
3. no P1 issue is open against it;
4. for 0.2 to 0.4, a maintainer promoted it by hand; from 0.5 on, 48 hours
   have passed since it was published with all of the above still green.

A broken stable release is yanked (the GitHub release is marked pre-release
again, `latest` moves back, the PyPI version is yanked) and a fix release
follows.
