# How a release is made

Releases are prepared by the release agent (`.claude/agents/release.md`) and
approved by a maintainer:

1. **Release PR.** Version bump (the CLI crate and the five Python dists), `CHANGELOG.md` from the
   commits since the last tag, the `minCli` table if a contract changed,
   refreshed `THIRD_PARTY_NOTICES.md`. `cargo deny`, the notices check and the
   version check must be green.
2. **Approval.** A maintainer approves the PR; it lands through the merge queue.
3. **Tag.** The agent creates a draft pre-release with the notes and pushes
   `vX.Y.Z`. `release.yml` (cargo-dist) builds Linux on SimForge's own runner
   and macOS/Windows on GitHub-hosted runners, attests every archive, builds
   the wheels, SBOMs and the container, signs every asset with Sigstore, and
   publishes the pre-release.
4. **Smoke.** `release-smoke.yml` installs everything and renders a fixture
   package with lavapipe; the GPU smoke repeats the render on NVIDIA hardware.
5. **Stable.** `promote.yml` flips the release to stable, tags the image
   `:latest`, publishes to PyPI and Homebrew and deploys these docs: by hand
   for 0.2 to 0.4, automatically after 48 hours green from 0.5.

The configuration lives in `dist-workspace.toml`, `.github/workflows/release*.yml`,
`promote.yml`, `deny.toml`, `about.toml` and `scripts/release/`.
