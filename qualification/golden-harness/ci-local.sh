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
# Render (and key) against exactly these plates. Without it the renderer picks the
# pinned sky closure instead whenever some earlier step happened to materialize it
# in the asset cache (sky_pass.rs select_dir), which the scene keys cannot see.
export SIMFORGE_SKY_ASSETS="${SIMFORGE_SKY_ASSETS:-$PWD/renderer/render-core/assets/sky}"

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
# Logs are printed in scene order. Frame times under contention are informational
# only (the frame-time check is not gated).
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
# Scheduling. Scenes are independent (each writes artifacts/golden-harness/verify/<id>)
# and render concurrently, longest first (the durations of the last run on this
# host, $durations; an unknown scene counts as the longest), so the slowest scene
# never starts last. Memory decides how many run at once: a lavapipe render of a
# map scene holds up to ~14 GB anonymous memory (yale-frame0: 14.3 GB peak), and
# the gate runs this step alongside the Rust and Python steps in one memory-capped
# sandbox. A scene starts only when the memory not yet used (the cgroup's limit
# minus its anonymous memory, and the host's MemAvailable) covers GOLDEN_MEM_GB
# (default 15) for it plus whatever the running scenes may still grow into; the
# first scene always starts. At most GOLDEN_JOBS (default 3) at a time.
durations="${XDG_CACHE_HOME:-$HOME/.cache}/simforge/golden-harness/durations.json"
mkdir -p "$(dirname "$durations")"; test -s "$durations" || echo '{}' >"$durations"
mapfile -t ids < <(for id in "${ids[@]}"; do printf '%s %s\n' "$(jq -r --arg id "$id" '.[$id] // 1e9' "$durations")" "$id"; done | sort -k1,1gr -k2,2 | awk '{print $2}')
mem_gb="${GOLDEN_MEM_GB:-15}"; jobs_n="${GOLDEN_JOBS:-3}"; cores="$(nproc)"
threads="${LP_NUM_THREADS:-$(( cores / 2 > 1 ? cores / 2 : 1 ))}"
kb_free() { # memory not yet used: min(cgroup limit - cgroup anon, host MemAvailable), KiB
  local host cg_max cg_anon
  host=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)
  cg_max="$(cat /sys/fs/cgroup/memory.max 2>/dev/null || echo max)"
  if [[ "$cg_max" =~ ^[0-9]+$ ]]; then
    cg_anon=$(awk '$1 == "anon" {print int($2 / 1024)}' /sys/fs/cgroup/memory.stat 2>/dev/null || echo 0)
    local cg=$(( cg_max / 1024 - cg_anon )); test "$cg" -lt "$host" && host="$cg"
  fi
  echo "$host"
}
kb_anon_of_group() { # anonymous memory of every process in process group $1, KiB
  local total=0 p anon
  for p in $(pgrep -g "$1"); do
    anon="$(awk '/^RssAnon:/ {print $2}' "/proc/$p/status" 2>/dev/null)"; total=$(( total + ${anon:-0} ))
  done
  echo "$total"
}
logs="$(mktemp -d)"; declare -A pgid started_at
min_free_gb=""
for id in "${ids[@]}"; do
  while :; do
    running=0; growing=0
    for r in "${!pgid[@]}"; do
      if test -e "$logs/$r.rc"; then unset "pgid[$r]"; continue; fi
      running=$(( running + 1 ))
      left=$(( mem_gb * 1048576 - $(kb_anon_of_group "${pgid[$r]}") )); test "$left" -gt 0 && growing=$(( growing + left ))
    done
    free_kb=$(kb_free); free_gb=$(( free_kb / 1048576 ))
    { test -z "$min_free_gb" || test "$free_gb" -lt "$min_free_gb"; } && min_free_gb="$free_gb"
    if test "$running" -eq 0; then break; fi
    if test "$running" -lt "$jobs_n" && test $(( free_kb - growing )) -ge $(( mem_gb * 1048576 )); then break; fi
    sleep 5
  done
  started_at[$id]=$(date +%s)
  setsid bash -c 'LP_NUM_THREADS="$1" node qualification/golden-harness/golden.mjs verify "$2" >"$3/$2.log" 2>&1; echo $? >"$3/$2.rc.tmp"; mv "$3/$2.rc.tmp" "$3/$2.rc"' _ "$threads" "$id" "$logs" &
  pgid[$id]=$!
  echo "[golden-harness] start $id ($(( running + 1 )) running, ${free_gb} GB free)"
done
wait
for id in "${ids[@]}"; do
  secs=$(( $(stat -c %Y "$logs/$id.rc" 2>/dev/null || date +%s) - started_at[$id] ))
  test "$(cat "$logs/$id.rc" 2>/dev/null || echo 1)" = 0 && jq --arg id "$id" --argjson s "$secs" '.[$id] = $s' "$durations" >"$durations.tmp" && mv "$durations.tmp" "$durations"
  echo "[golden-harness] $id: ${secs} s"
done
echo "(${#ids[@]} scenes rendered, ${#skipped[@]} skipped as unchanged, up to $jobs_n at a time by memory (${mem_gb} GB each, least free ${min_free_gb:-?} GB), LP_NUM_THREADS=$threads)"
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
