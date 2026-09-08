# SimForge Studio desktop distribution

How an installer set becomes a download, what each release claims, and what
must be true before it may claim more. The npm/PyPI stack has its own
contract in [release-publication.md](release-publication.md); the two are
deliberately separate publications of the same tree.

## Three identities, never conflated

| Identity | Where it lives | What it describes |
|---|---|---|
| Embedded version | `studio/package.json` `version`; every artifact name; stage manifest `studioVersion`; `app.getVersion()` | the bytes |
| Distribution label | `simforgeDistribution.label` in the packaged `package.json`; `RELEASE.json` `distributionLabel` | the publication |
| Tag | `studio-<label>` | the immutable commit the publication was built from |

A label that names a version (`0.1.1`) must equal the embedded version;
`assertLabelMatchesBuild` refuses anything else, so `studio-0.1.1` can only
ever carry 0.1.1 binaries. A label that names a generation (`preview.1`) may
differ, and both identities are recorded — the first preview publishes
0.1.0 binaries under `preview.1` rather than pretending they were rebuilt.

**The tag namespace is load-bearing.** `.github/workflows/publish.yml`
triggers on `v*` and publishes the whole npm/PyPI stack. Desktop tags are
`studio-*`; `releaseTag` refuses a label that looks like a stack version, so
publishing an installer set cannot fire a stack publication of an unrelated
tree.

## Channels

| Channel | GitHub state | Who can download | Requires |
|---|---|---|---|
| Draft | `draft: true` | maintainers only | assets uploaded and verified against the digests CI recorded |
| Preview | `prerelease: true` | anyone | every published platform cleared by the third-party audit; disclosures in the notes |
| Stable | `prerelease: false`, latest | anyone, default button | every gate in `scripts/release/stable-gates.mjs` |

A draft is not a download: anonymous users cannot fetch its assets, so
`buildDownloadsManifest` refuses to advertise one as a channel pointer. That
is why an audit that cannot be closed produces a maintainers-only draft
rather than a public release with a disclaimer.

## Publishing

`scripts/release/publish-desktop-release.mjs` is the whole procedure. It
prepares by default and touches GitHub only with `--confirm`.

```sh
# From the run that built them (the repeatable path; artifacts expire)
node scripts/release/publish-desktop-release.mjs \
  --label 0.1.1 --channel preview \
  --from-run <run id> --sums-from-installers --signing-from-artifacts \
  --source-revision <sha> --cloud-origin https://staging.simforge.ai \
  --ci-run <run id> --interactive linux-x64

# From a local mirror, cross-checked against a previously recorded release
node scripts/release/publish-desktop-release.mjs \
  --label preview.1 --installers <dir> \
  --expect-release <dir>/RELEASE.json \
  --source-revision <sha> --cloud-origin https://staging.simforge.ai

# Create the draft, then (only when the audit clears) make it public
… --publish draft --confirm
… --publish release --confirm
```

What it guarantees, in code rather than in this document:

- The bytes are CI's. Digests are checked against the checksum file the
  packaging leg wrote next to them, and again from GitHub's reported asset
  digests after upload. A release stays a draft if either disagrees.
- File names are normalized exactly once: spaces become hyphens, because
  GitHub would otherwise replace them with dots and break both `SHA256SUMS`
  matching and predictable URLs. The version token is never rewritten.
  `electron-builder.yml` produces space-free names at source now, so this
  applies only to artifacts built before that change.
- Signing is read from the labels CI gave the artifacts
  (`--signing-from-artifacts`), which CI derives from the secrets actually
  present. There is no flag that asserts a build is signed.
- The embedded version is read from the artifact names, not passed in.
- A partial platform set cannot become a public release *silently*. Full
  coverage is the default and a gap is refused. An interim publication has to
  name its set with `--platforms linux-x64`, which is cross-checked against
  the bytes in both directions, records `platformSet: "partial"` with the
  absent platforms, and discloses them in the notes. A platform with no bytes
  takes the `not-published` signing state, which is refused for any platform
  whose installers are present, and its row reports no signing, packaging or
  redistribution outcome rather than a blocked obligation it never had.
- Republishing a label from a newer source removes every asset that is not in
  the new set before uploading. `--clobber` alone replaces only same-named
  files, which would leave two revisions' bytes under one manifest.

`.github/workflows/desktop.yml` can create the draft itself
(`publish: draft` with a `distribution_label`), but it can never make a
release public.

## Third-party payload

`scripts/release/bundled-components.json` records, per component and per
platform, the license that actually applies and the obligations that follow;
`scripts/release/audit-bundled-licenses.mjs` turns it into a receipt and the
`THIRD_PARTY_NOTICES.md` a download must carry.

```sh
node scripts/release/audit-bundled-licenses.mjs --out artifacts/release/audit
```

Each per-target determination names the digests of the binaries it was made
from and must match what `studio/desktop/build-encoders.mjs` built from the
sources `studio/desktop/encoders.lock.json` pins. Repinning an encoder
invalidates the determination, so a new upstream build cannot inherit the
previous one's clearance. `undetermined` blocks exactly like `unsatisfied`:
nobody-checked is not permission.

The bundled ffmpeg/ffprobe are **built from pinned source on every platform**,
which is what makes them redistributable. All four legs compile the same two
Git commits with the same closure, so the licence outcome is identical
everywhere and the corresponding source is a single tree per platform:

| Component | Source | Commit |
|---|---|---|
| FFmpeg | https://github.com/FFmpeg/FFmpeg.git | `3a0867c2bfda4a4d4309ca1a8cbdc6175e67f587` (7.1.5) |
| libx264 | https://github.com/mirror/x264.git | `31e19f92f00c7003fa115047ce50978bc98c3a0d` |

The closure is `studio/desktop/encoders.lock.json`: GPL and version3 enabled,
libx264 and zlib the only external libraries, autodetect and network
disabled. zlib is not optional — FFmpeg gates its EXR decoder on it
(`exr_decoder_deps="zlib"`), and the renderer's sky plates are EXR, so a
build without it cannot prepare the sky at all. The outcome is
GPL-3.0-or-later, and each packaging leg publishes a
`corresponding-source/*.tar.gz` beside its installers; the audit refuses a
platform whose archive or build receipt is missing.

**Why this replaced downloaded binaries.** The four packages previously
carried three different upstream builds, and the macOS arm64 one had
`--enable-nonfree` in its compiled-in configure line while its metadata
claimed the same version and licence as the others. That build may not be
redistributed at all. The lesson is in the method, not the flag: read the
configure line out of the binary, because the metadata was wrong. The
per-platform verification of a shipped set is therefore:

```sh
strings -a <package>/tools/ffmpeg | grep -m1 -o -- "--prefix=.\{0,700\}" \
  | tr ' ' '\n' | grep -E "^--(enable|disable)"
```

That works on Linux and macOS packages. A Windows NSIS installer's payload is
LZMA-compressed, so there is no plaintext configure line to read and Windows
rests on its build receipt and the CI encoder step succeeding from source —
a scan of the compressed installer proves nothing either way.

## Updates

Help › Check for Updates… (`studio/desktop/update-check.mjs`) runs only on
user action, downloads nothing, and asks a question it can answer: "is the
newest release of my channel the one I am?" — ordering comes from publication
order, not from parsing labels. A build with no baked label says so instead
of claiming to be current. GitHub's unauthenticated releases API is the
primary source and the product site's committed `releases.json` is the
fallback.

Automatic download (`electron-updater`) is deliberately absent: it requires a
signed Windows build and a notarized macOS build, so it is gated on the same
credentials as the stable channel.

## Stable gates

```sh
node scripts/release/stable-gates.mjs --measurements <measurements.json>
```

Every gate is a measurement supplied as data; a missing measurement fails.
The gates are: label equals the embedded version, source reachable from
`main`, Windows Authenticode, macOS Developer ID **and** notarization,
downloaded-installer qualification on all four platforms, installers pointing
at `https://simforge.ai` with production actually serving `/desktop/connect`
(200) and `/api/desktop/session` (401), license obligations cleared, the
`v<stackVersion>` tag published, the Cloud vendor lock at the same revision
the installers were built from, and the update check present in the built
source.

## Qualifying a downloaded installer

```sh
export TMPDIR=/mnt/storage/<somewhere with room>   # a 1.1 GB artifact fills /tmp
node scripts/release/qualify-installed-desktop.mjs \
  --artifact <file.AppImage|.deb> --expect-sha256 <digest> [--json] [--keep]
```

It unpacks the artifact under a throwaway `HOME` and touches only paths inside
the installed tree, so a developer's existing cache, map bundles or session
cannot make a broken installer look healthy. Eight gates, each failing closed
with its reason: the digest matches what the release claims; the artifact
opens; every executable and library the stage manifest names is present,
executable and for this platform; the original capabilities are there (actor
closure, `.skytex` sky plates, local host, CPU worker, render harness); the
packaged encoders run, can decode EXR, and are not `--enable-nonfree`; the
packaged addon loads from the installed tree and its compiled exports answer;
the app starts under Xvfb until its bundled local host responds; and the baked
Cloud origin is reachable.

Two deliberate distinctions. The addon gate asks the **binary**, because a
regenerated `.d.ts` can declare operations the compiled `.node` does not
contain — that typechecks and then throws at runtime. And an absent
`/download/releases.json` is reported as a pending publication rather than a
defect: before the first release there is nothing to serve, and the update
check is required to say so gracefully. Only a served document that is not a
downloads manifest fails.

The launch gate accepts the local host answering `401`: the host demands the
trusted-local session cookie the shell sets, so an unauthenticated probe
getting `401` proves the host is up **and** enforcing its own auth. It also
proves nothing about the UI behind it — installed-app acceptance is a separate
exercise, not something this harness can stand in for.

`electron-builder` packaging is **not reproducible**: the same source builds
bytes with different digests locally and in CI. Acceptance evidence therefore
belongs to a digest, not to a revision, and a local rebuild cannot stand in
for the CI artifact that will be published.

## Data on disk

`resolveDataRoot` in `studio/desktop/main.mjs` keeps the database,
artifacts, map cache and native job state outside the install directory
(`%LOCALAPPDATA%`, `~/Library/Application Support`, `$XDG_DATA_HOME`), so
installs, updates and uninstalls never touch user data. Release notes say so,
because NSIS is configured with `deleteAppDataOnUninstall: false` and users
should know their data survives.

Two locations, not one. The data root above is what the release notes
promise installs and uninstalls never touch. The model store is separate and
explicitly user-managed: `${SIMFORGE_ASSETS_ROOT:-~/simforge-assets}` holds
`hf-cache/` and `models/<family>/<revision>/{weights,sidecars,code,.venv,licenses,install.json}`,
tens of gigabytes of downloaded model weights that are deliberately outside
the data root so an app uninstall neither deletes them nor silently strands
them. Only `simforge models uninstall`, or Remove on the Models screen,
deletes anything there. Release notes and the download page state both
locations, because a user who uninstalls the app is entitled to know that
72 GB of weights is still on their disk and how to remove it.

## State as of 2026-09-08

A snapshot, so the next person does not re-derive it. Everything here was
read from an artifact, an API or a live endpoint rather than asserted.

**Installer set.** Run `34187617763` at source `05a6d31a`, all four platforms
succeeded: `linux-x64` (AppImage + deb), `windows-x64` (NSIS), `macos-arm64`
and `macos-x64` (dmg + zip). Every digest verified with `sha256sum -c`
against the checksum file its own packaging leg wrote. All four
licence-**cleared** against their own corresponding-source archives. The
encoder configure line was read out of the shipped binary on Linux and both
macOS targets — our exact closure, zero `--enable-nonfree`; Windows rests on
its receipt for the reason given above.

**Qualification.** Linux only, and completely: all eight gates pass on the
downloaded CI bytes. There is no Windows or macOS host here, so those
platforms have payload, encoder, addon and digest evidence but **no
installed-launch proof**. A release must say so per platform rather than
implying parity.

**Publication.** Draft `studio-preview.1` (release id `384451104`) exists and
is deliberately **private**. It holds an older `7937edc9` set that predates
the bounded-drain fix, so it must be replaced wholesale — not topped up —
before it can be published. GitHub's reported asset digests matched the
uploaded bytes exactly, so the publication path itself is proven.

**Cloud.** `https://staging.simforge.ai` serves the candidate;
`/download/releases.json` answers 200 `application/json` with schema
`simforge.downloads/v1`, `channels` still null because nothing is published,
and the packaged update check against it returns `unavailable` / "no preview
release is published", which is correct. Compute routes are **not** on
staging: `/api/simforge/compute/{jobs,estimate,capabilities}` return 404,
because that candidate deliberately excludes the compute surface. Deployment
and identity details are recorded in `docs/operations.md`.

**Blocked on credentials, not on code.** Windows Authenticode and Apple
Developer ID + notarization are absent — zero repository and zero
organization secrets are available. Stable therefore fails closed, and
nothing is ever labelled signed on the strength of an assertion.
