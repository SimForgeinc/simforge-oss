#!/usr/bin/env bash
# Build the docs.simforge.ai site into $1:
#   /            the latest stable release's docs (or main's, before the first stable)
#   /dev/        main
#   /vX.Y.Z/     every stable release tag whose tree has docs/book.toml
#   /versions.json  the list the version picker reads (docs/theme/versions.js)
#
# Needs mdbook on PATH, and the tags fetched (actions/checkout fetch-depth: 0).
set -euo pipefail
out="$(realpath -m "${1:?usage: build-site.sh <out-dir>}")"
root="$(git rev-parse --show-toplevel)"
cd "$root"
rm -rf "$out"; mkdir -p "$out"

mdbook build docs -d "$out/dev"

stable_tags="$(git tag -l 'v[0-9]*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V -r || true)"
built=()
scratch="$(mktemp -d)"; trap 'rm -rf "$scratch"; git worktree prune' EXIT
for tag in $stable_tags; do
  git cat-file -e "$tag:docs/book.toml" 2>/dev/null || continue
  git worktree add --detach -q "$scratch/$tag" "$tag"
  mdbook build "$scratch/$tag/docs" -d "$out/$tag"
  git worktree remove --force "$scratch/$tag"
  built+=("$tag")
done

if [[ ${#built[@]} -gt 0 ]]; then latest="${built[0]}"; src="$out/$latest"; else latest="main"; src="$out/dev"; fi
# The root is a copy (not a redirect) so /install/ links stay stable.
cp -R "$src/." "$out/"
python3 - "$out/versions.json" "$latest" "${built[@]}" <<'PY'
import json, sys
json.dump({"latest": sys.argv[2], "versions": sys.argv[3:]}, open(sys.argv[1], "w"), indent=1)
PY
echo "site: latest=$latest versions=${built[*]:-none}"
