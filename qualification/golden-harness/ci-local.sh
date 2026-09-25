#!/usr/bin/env bash
# The lavapipe golden suite (WSB6); scripts/gate-local.sh runs it.
# Goldens render on Mesa lavapipe (the adapter of record; needs
# mesa-vulkan-drivers + vulkan-tools), so any x86-64 Linux host with the
# recorded CPU model reproduces them. Steps:
#   1. build the native renderer (`simforge-render`, release)
#   2. plan: every scene's job builds and its corpus resolves (no render)
#   3. verify goldens (hash drift + >10% frame-time budget gate)
# Corpus roots come from each scene's corpusRootEnv (SIMFORGE_CORPUS_RICHMOND,
# SIMFORGE_CORPUS_YALE, SCEN_SENSOR_CORPUS_WSB1) or SCEN_SENSOR_CORPUS.
# Usage: qualification/golden-harness/ci-local.sh [record]   # 'record' re-records goldens first
set -euo pipefail
cd "$(dirname "$0")/../.."   # repo root

echo "=== step 1/3: build native renderer ==="
cargo build --release -p simforge-render --manifest-path renderer/Cargo.toml
cargo build --release -p simforge-core --example render-parity --manifest-path native/Cargo.toml

echo "=== step 1b: sky plates (pinned NASA sources, verified) ==="
uv run --quiet --no-project --with numpy==2.3.3 --with pillow==11.3.0 python renderer/tools/prepare_sky.py

echo "=== step 2/3: plan (scene definitions, jobs, corpus availability) ==="
node qualification/golden-harness/golden.mjs plan all

echo "=== step 3/3: golden suite ==="
if [ "${1:-verify}" = "record" ]; then
  for scene in qualification/golden-harness/scenes/*.json; do
    node qualification/golden-harness/golden.mjs record "$(basename "$scene" .json)"
  done
fi
# Every recorded scene is verified; a scene still marked `recording: unrecorded`
# is listed by name (it gates once its owner records it on lavapipe), never passed.
unrecorded=()
for scene in qualification/golden-harness/scenes/*.json; do
  id="$(basename "$scene" .json)"
  if test "$(jq -r '.recording // "recorded"' "$scene")" = unrecorded; then unrecorded+=("$id"); continue; fi
  node qualification/golden-harness/golden.mjs verify "$id"
done
if test ${#unrecorded[@]} -gt 0; then echo "UNRECORDED (not gated until recorded): ${unrecorded[*]}"; fi

echo "=== native-golden local run: PASS (${#unrecorded[@]} unrecorded) ==="
