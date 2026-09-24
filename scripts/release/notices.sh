#!/usr/bin/env bash
# Generate THIRD_PARTY_NOTICES.md for the shipped `simforge` binary:
#   1. cargo-about over the CLI package's dependency graph (about.toml/about.hbs);
#   2. the asset attributions (scripts/release/check-attribution.py), which
#      also fails the run when any distributed model lacks a valid licence.
#
#   scripts/release/notices.sh           rewrite THIRD_PARTY_NOTICES.md
#   scripts/release/notices.sh --check   exit 1 if the committed file is stale
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
cd "$root"
# shellcheck source=layout.sh
source scripts/release/layout.sh

mode="${1:-write}"
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT

cargo about generate --manifest-path "$SIMFORGE_CLI_MANIFEST" --locked \
  -c about.toml about.hbs -o "$out/crates.md"

attribution_args=()
for catalog in $SIMFORGE_ASSET_CATALOGS; do attribution_args+=(--catalog-dir "$catalog"); done
if [[ -f "$SIMFORGE_ACTOR_CLOSURE_PIN_FILE" ]]; then
  attribution_args+=(--closure "$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["digest"])' "$SIMFORGE_ACTOR_CLOSURE_PIN_FILE")")
fi
python3 scripts/release/check-attribution.py "${attribution_args[@]}" --markdown "$out/assets.md" >&2

cat "$out/crates.md" "$out/assets.md" > "$out/THIRD_PARTY_NOTICES.md"

if [[ "$mode" == "--check" ]]; then
  if ! diff -q "$out/THIRD_PARTY_NOTICES.md" THIRD_PARTY_NOTICES.md >/dev/null; then
    echo "THIRD_PARTY_NOTICES.md is stale: run scripts/release/notices.sh and commit it" >&2
    diff -u THIRD_PARTY_NOTICES.md "$out/THIRD_PARTY_NOTICES.md" | head -40 >&2 || true
    exit 1
  fi
  echo "THIRD_PARTY_NOTICES.md is current"
else
  cp "$out/THIRD_PARTY_NOTICES.md" THIRD_PARTY_NOTICES.md
  echo "wrote THIRD_PARTY_NOTICES.md"
fi
