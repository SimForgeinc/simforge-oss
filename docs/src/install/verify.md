# Verify a download

Every release asset is signed keyless with [Sigstore](https://www.sigstore.dev)
from the release workflow (the certificate names the workflow and the tag; the
signature is in the public Rekor log), has a SLSA build-provenance attestation
from GitHub, and is listed with its SHA-256 in `sha256.sum`.

## An archive

```sh
TAG=v0.2.0
ASSET=simforge-x86_64-unknown-linux-gnu.tar.xz
gh release download "$TAG" -R SimForgeinc/simforge-sdk -p "$ASSET" -p "$ASSET.sigstore.json"

cosign verify-blob --bundle "$ASSET.sigstore.json" \
  --certificate-identity-regexp '^https://github\.com/SimForgeinc/simforge-sdk/\.github/workflows/release-(sign|container)\.yml@refs/tags/v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  "$ASSET"

gh attestation verify "$ASSET" --repo SimForgeinc/simforge-sdk
```

## The container image

```sh
IMAGE=ghcr.io/simforgeinc/simforge:0.2.0
cosign verify "$IMAGE" \
  --certificate-identity-regexp '^https://github\.com/SimForgeinc/simforge-sdk/\.github/workflows/release-container\.yml@refs/tags/v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
gh attestation verify "oci://$IMAGE" --repo SimForgeinc/simforge-sdk
cosign verify-attestation --type cyclonedx "$IMAGE" \
  --certificate-identity-regexp '^https://github\.com/SimForgeinc/simforge-sdk/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

## SBOMs

`simforge-<version>.cdx.json` (the CLI's Rust dependency graph),
`simforge-oss-gym-<version>.cdx.json` (the wheel's native extension) and
`simforge-image-<version>.cdx.json` (the container, from syft) are CycloneDX
1.5 documents attached to each release. The binary also embeds its dependency
list (`cargo auditable`), so `cargo audit bin $(which simforge)` works offline.

## macOS and Windows

The macOS binary is ad-hoc signed (no Apple Developer ID yet) and Windows
binaries are not Authenticode-signed; the Sigstore signature and the SHA-256
above are the integrity check. macOS may need
`xattr -d com.apple.quarantine simforge` after a manual download (the
installer does not).
