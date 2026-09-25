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
cargo build --release -p simforge-render
cargo build --release -p simforge-core --example render-parity

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
# Scenes are independent (each writes artifacts/golden-harness/verify/<id>), so
# they render up to GOLDEN_JOBS at a time (default 2, memory-bounded below), each with an even share of the
# cores for lavapipe (LP_NUM_THREADS), logs printed in scene order. Frame times
# under contention are informational only (the frame-time check is not gated).
unrecorded=(); ids=()
for scene in qualification/golden-harness/scenes/*.json; do
  id="$(basename "$scene" .json)"
  if test "$(jq -r '.recording // "recorded"' "$scene")" = unrecorded; then unrecorded+=("$id"); continue; fi
  ids+=("$id")
done
# Memory-bounded: a lavapipe golden render peaks at 5-8 GB, and the gate host is
# shared (dev workers, browsers, agents). At most GOLDEN_JOBS (default 2), and
# never more than MemAvailable / GOLDEN_MEM_GB (default 8) at start.
avail_gb=$(( $(awk '/^MemAvailable:/ {print $2}' /proc/meminfo) / 1048576 ))
by_mem=$(( avail_gb / ${GOLDEN_MEM_GB:-8} )); test "$by_mem" -ge 1 || by_mem=1
jobs_n="${GOLDEN_JOBS:-2}"; test "$jobs_n" -le "$by_mem" || jobs_n="$by_mem"; cores="$(nproc)"
threads="${LP_NUM_THREADS:-$(( cores / jobs_n > 1 ? cores / jobs_n : 1 ))}"
logs="$(mktemp -d)"
for id in "${ids[@]}"; do
  while test "$(jobs -rp | wc -l)" -ge "$jobs_n"; do wait -n || true; done
  ( set +e; LP_NUM_THREADS="$threads" node qualification/golden-harness/golden.mjs verify "$id" >"$logs/$id.log" 2>&1; echo $? >"$logs/$id.rc" ) &
done
wait
echo "(${#ids[@]} scenes, $jobs_n at a time, LP_NUM_THREADS=$threads, ${avail_gb} GB available at start)"
rc=0
for id in "${ids[@]}"; do
  status="$(cat "$logs/$id.rc" 2>/dev/null || echo 1)"
  cat "$logs/$id.log"
  if test "$status" -ne 0; then echo "[golden-harness] scene $id failed (exit $status)"; test "$rc" -ne 0 || rc=$status; fi
done
rm -rf "$logs"
test "$rc" -eq 0 || exit "$rc"
if test ${#unrecorded[@]} -gt 0; then echo "UNRECORDED (not gated until recorded): ${unrecorded[*]}"; fi

echo "=== native-golden local run: PASS (${#unrecorded[@]} unrecorded) ==="
