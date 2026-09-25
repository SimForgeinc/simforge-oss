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
# Skips: a scene whose input key (golden.mjs key: the built binaries, the job and
# every file it reads, the golden record, lavapipe, the harness) a trusted gate
# already PASSed is not rendered again. GOLDEN_PASS_LEDGER names "<key> <sha>"
# lines the gate verified (scripts/gate-local.sh); GOLDENS_FULL=1 renders
# everything (the nightly run). PASSed scenes' keys go to GOLDEN_KEYS_OUT.
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
keys="$(mktemp)"
node qualification/golden-harness/golden.mjs key all | grep '^{' >"$keys"
ledger="${GOLDEN_PASS_LEDGER:-}"
test "${GOLDENS_FULL:-0}" != 1 && test "${1:-verify}" = verify && test -n "$ledger" && test -s "$ledger" || ledger=""
unrecorded=(); ids=(); skipped=()
for scene in qualification/golden-harness/scenes/*.json; do
  id="$(basename "$scene" .json)"
  if test "$(jq -r '.recording // "recorded"' "$scene")" = unrecorded; then unrecorded+=("$id"); continue; fi
  key="$(jq -r --arg id "$id" 'select(.sceneId == $id) | .key // empty' "$keys")"
  if test -n "$ledger" && test -n "$key" && since="$(awk -v k="$key" '$1 == k { print $2; exit }' "$ledger")" && test -n "$since"; then
    echo "[golden-harness] SKIP $id: inputs unchanged since ${since:0:12} (key ${key:0:16})"; skipped+=("$id"); continue
  fi
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
echo "(${#ids[@]} scenes rendered, ${#skipped[@]} skipped as unchanged, $jobs_n at a time, LP_NUM_THREADS=$threads, ${avail_gb} GB available at start)"
rc=0
for id in "${ids[@]}"; do
  status="$(cat "$logs/$id.rc" 2>/dev/null || echo 1)"
  cat "$logs/$id.log"
  if test "$status" -ne 0; then echo "[golden-harness] scene $id failed (exit $status)"; test "$rc" -ne 0 || rc=$status; fi
done
rm -rf "$logs"
test "$rc" -eq 0 || exit "$rc"
# Every rendered scene passed: hand their keys to the gate (it records them only for a trusted PASS).
if test -n "${GOLDEN_KEYS_OUT:-}"; then
  for id in "${ids[@]}"; do jq -c --arg id "$id" 'select(.sceneId == $id and .key != null) | {sceneId, key}' "$keys"; done >>"$GOLDEN_KEYS_OUT"
fi
rm -f "$keys"
if test ${#unrecorded[@]} -gt 0; then echo "UNRECORDED (not gated until recorded): ${unrecorded[*]}"; fi

echo "=== native-golden local run: PASS (${#skipped[@]} skipped as unchanged, ${#unrecorded[@]} unrecorded) ==="
