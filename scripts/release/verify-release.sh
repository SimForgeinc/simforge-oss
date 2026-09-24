#!/usr/bin/env bash
# Verify a published SimForge SDK release: every asset's checksum, Sigstore
# keyless signature and GitHub build-provenance attestation, plus the
# container image's signature and provenance.
#
#   scripts/release/verify-release.sh <tag> [--dir DIR] [--no-image]
#
# Needs: gh >= 2.49 (gh attestation), cosign >= 2.4, sha256sum/shasum.
# Exits non-zero on the first asset that fails; prints one JSON summary line.
# The same commands are documented for users in docs/src/install/verify.md.
set -euo pipefail

repo="${SIMFORGE_RELEASE_REPO:-SimForgeinc/simforge-sdk}"
image="${SIMFORGE_IMAGE:-ghcr.io/simforgeinc/simforge}"
issuer="https://token.actions.githubusercontent.com"
repo_re="${repo//./\\.}"
# Fulcio puts the *reusable* workflow that signed into the certificate: assets
# are signed by release-sign.yml (the container's own assets by
# release-container.yml), the image by release-container.yml, all only ever
# from a v* tag.
blob_identity="^https://github\\.com/${repo_re}/\\.github/workflows/release-(sign|container)\\.yml@refs/tags/v[0-9]"
image_identity="^https://github\\.com/${repo_re}/\\.github/workflows/release-container\\.yml@refs/tags/v[0-9]"

tag="${1:?usage: verify-release.sh <tag> [--dir DIR] [--no-image]}"; shift
dir=""; check_image=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) dir="$2"; shift 2 ;;
    --no-image) check_image=0; shift ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done

gh attestation --help >/dev/null 2>&1 || { echo "gh attestation is unavailable: install gh >= 2.49" >&2; exit 2; }
command -v cosign >/dev/null || { echo "cosign is required" >&2; exit 2; }
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

if [[ -z "$dir" ]]; then dir="$(mktemp -d)"; trap 'rm -rf "$dir"' EXIT; fi
if [[ -z "$(ls -A "$dir" 2>/dev/null)" ]]; then
  gh release download "$tag" --repo "$repo" --dir "$dir"
fi
cd "$dir"

checked=0; attested=0
# 1. Checksums: dist writes <asset>.sha256 beside each archive and sha256.sum.
for sumfile in *.sha256; do
  [[ -e "$sumfile" ]] || continue
  asset="${sumfile%.sha256}"
  expected="$(cut -d' ' -f1 < "$sumfile")"
  [[ "$(sha256 "$asset")" == "$expected" ]] || { echo "checksum mismatch: $asset" >&2; exit 1; }
done

# 2. Signatures: every asset except the bundles themselves has <asset>.sigstore.json.
for asset in *; do
  # Reports are evidence written after the release (smoke, GPU smoke), not deliverables.
  case "$asset" in *.sigstore.json|smoke-report.json|gpu-smoke-report.json) continue ;; esac
  bundle="$asset.sigstore.json"
  [[ -f "$bundle" ]] || { echo "unsigned asset: $asset" >&2; exit 1; }
  cosign verify-blob --bundle "$bundle" \
    --certificate-identity-regexp "$blob_identity" \
    --certificate-oidc-issuer "$issuer" "$asset" >/dev/null 2>&1 \
    || { echo "signature does not verify: $asset" >&2; exit 1; }
  checked=$((checked + 1))
done

# 3. Build provenance (SLSA, GitHub attestations): binaries, wheels, installers.
for asset in *.tar.xz *.tar.gz *.zip *.whl *.sh *.ps1 *.rb *.cdx.json; do
  [[ -e "$asset" ]] || continue
  gh attestation verify "$asset" --repo "$repo" >/dev/null \
    || { echo "no valid provenance attestation: $asset" >&2; exit 1; }
  attested=$((attested + 1))
done

# 4. Container image, by the digest the release recorded.
image_ref=""
if [[ "$check_image" == 1 ]]; then
  [[ -f container-image.json ]] || { echo "release has no container-image.json" >&2; exit 1; }
  digest="$(python3 -c 'import json;print(json.load(open("container-image.json"))["digest"])')"
  image_ref="${image}@${digest}"
  cosign verify "$image_ref" --certificate-identity-regexp "$image_identity" \
    --certificate-oidc-issuer "$issuer" >/dev/null 2>&1 \
    || { echo "image signature does not verify: $image_ref" >&2; exit 1; }
  gh attestation verify "oci://${image_ref}" --repo "$repo" >/dev/null \
    || { echo "image has no valid provenance attestation: $image_ref" >&2; exit 1; }
fi

printf '{"tag":"%s","signed":%d,"attested":%d,"image":"%s"}\n' "$tag" "$checked" "$attested" "$image_ref"
