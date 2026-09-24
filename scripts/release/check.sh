#!/usr/bin/env bash
# Supply-chain and release-config checks for the SDK gate (the merger's local
# gate runs this on every SDK PR; release-preflight.yml runs it on every tag).
#
#   scripts/release/check.sh            all checks
#   scripts/release/check.sh deny       cargo deny over every shipped workspace
#   scripts/release/check.sh notices    THIRD_PARTY_NOTICES.md + asset attributions current
#   scripts/release/check.sh dist       release.yml matches dist-workspace.toml
#   scripts/release/check.sh docs       the mdBook site builds
#
# Needs cargo-deny, cargo-about, dist (0.33.0) and mdbook on PATH (the release
# build image has the first two; the gate environment provides the rest). A
# missing tool is an error, not a skipped check.
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
cd "$root"
# shellcheck source=layout.sh
source scripts/release/layout.sh

need() { command -v "$1" >/dev/null || { echo "check.sh: $1 is not on PATH" >&2; exit 2; }; }
run_deny() {
  need cargo-deny
  local failed=""
  for ws in $SIMFORGE_CARGO_WORKSPACES; do
    echo "== cargo deny: $ws" >&2
    cargo deny --manifest-path "$ws/Cargo.toml" --workspace --locked --config deny.toml check || failed="$failed $ws"
  done
  [[ -z "$failed" ]] || { echo "check.sh: cargo deny failed in:$failed" >&2; return 1; }
}
run_notices() { need cargo-about; scripts/release/notices.sh --check; }
run_dist() {
  need dist
  dist generate --check
  dist plan --output-format=json >/dev/null
}
run_docs() {
  need mdbook
  out="$(mktemp -d)"; trap 'rm -rf "$out"' RETURN
  mdbook build docs -d "$out" 2>&1 | grep -v '^ INFO' >&2 || true
  [[ -f "$out/index.html" ]] || { echo "check.sh: the docs did not build" >&2; return 1; }
}

case "${1:-all}" in
  deny) run_deny ;;
  notices) run_notices ;;
  dist) run_dist ;;
  docs) run_docs ;;
  all) run_deny; run_notices; run_dist; run_docs ;;
  *) echo "usage: check.sh [deny|notices|dist|docs|all]" >&2; exit 2 ;;
esac
echo "check.sh ${1:-all}: ok"
