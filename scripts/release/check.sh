#!/usr/bin/env bash
# Supply-chain and release-config checks for the SDK gate (the merger's local
# gate runs this on every SDK PR; release-preflight.yml runs it on every tag).
#
#   scripts/release/check.sh            all checks
#   scripts/release/check.sh deny       cargo deny over every shipped workspace
#   scripts/release/check.sh notices    THIRD_PARTY_NOTICES.md + asset attributions current
#   scripts/release/check.sh dist       release.yml matches dist-workspace.toml
#   scripts/release/check.sh skills     skills/ matches the CLI (generated references
#                                       current; no unknown command or flag)
#
# Needs cargo-deny, cargo-about and dist (0.33.0) on PATH (the release build
# image has the first two; the gate environment provides dist). The skills
# check runs the CLI: $SIMFORGE_BIN, or `cargo run` of the CLI package. A
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
run_skills() {
  local surface; surface="$(mktemp)"
  python3 scripts/skills/surface.py -o "$surface"
  python3 scripts/skills/skills.py check --surface "$surface"
  rm -f "$surface"
}

case "${1:-all}" in
  deny) run_deny ;;
  notices) run_notices ;;
  dist) run_dist ;;
  skills) run_skills ;;
  all) run_deny; run_notices; run_dist; run_skills ;;
  *) echo "usage: check.sh [deny|notices|dist|skills|all]" >&2; exit 2 ;;
esac
echo "check.sh ${1:-all}: ok"
