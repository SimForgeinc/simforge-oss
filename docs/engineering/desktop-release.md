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
- A partial platform set cannot become a public release.

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

The bundled ffmpeg/ffprobe are **not one component**. The four packages carry
three different upstream builds:

| Platform | Builder | ffmpeg | Applicable license |
|---|---|---|---|
| linux-x64 | johnvansickle.com static | 7.0.2 | GPL-3.0-only |
| windows-x64 | gyan.dev essentials | 6.1.1 | GPL-3.0-only |
| macos-x64 | evermeet.cx (`tessus`) | 8.0 | GPL-3.0-or-later |
| macos-arm64 | unidentified arm64 build | undetermined | **nonfree — unredistributable** |

The macOS arm64 binary's compiled-in configure line contains
`--enable-nonfree`. That build may not be redistributed at all, so the macOS
arm64 installer cannot be published publicly with these bytes; it needs a
repinned encoder and a rebuilt leg. The GPL platforms need complete
corresponding source or a written offer, which no upstream builder publishes
as part of the pinned release.

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

## Data on disk

`resolveDataRoot` in `studio/desktop/main.mjs` keeps the database,
artifacts, map cache and native job state outside the install directory
(`%LOCALAPPDATA%`, `~/Library/Application Support`, `$XDG_DATA_HOME`), so
installs, updates and uninstalls never touch user data. Release notes say so,
because NSIS is configured with `deleteAppDataOnUninstall: false` and users
should know their data survives.
