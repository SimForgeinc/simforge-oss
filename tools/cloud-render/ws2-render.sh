#!/bin/bash
# Render one scenario offline on ws2 through the adapter, sampling GPU memory.
#
# The control plane is not involved: this is the same `run-local` front door the
# worker's adapter exposes, which keeps a single-GPU run independent of lease,
# registration and image-skew problems. GPU memory is sampled throughout because
# the failure mode on a 10 GiB card is `Out of memory on Vulkan`, and the peak is
# the only number that tells you how close a rig is to the edge.
set -uo pipefail

REV="${1:?revision directory under /tmp/pkg}"
RIG="${2:-nvidia-sdg-av}"
WIDTH="${3:-1056}"
HEIGHT="${4:-664}"
SECONDS_END="${5:-20}"
WORKER="${WORKER_CONTAINER:-sf-worker-cook}"
OUT="/tmp/out-${REV}"

VRAM_LOG="/tmp/vram-${REV}.log"
rm -f "$VRAM_LOG"
(
  while true; do
    nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits >> "$VRAM_LOG"
    sleep 5
  done
) &
SAMPLER=$!
trap 'kill "$SAMPLER" 2>/dev/null' EXIT

docker exec -e HOME=/tmp -e PYTHONPATH=/tmp/carla-exec \
  -e SIMFORGE_MAX_SENSOR_PIXELS=12000000000 "$WORKER" \
  /opt/simforge/venv/bin/python -m simforge_oss_carla_exec.local \
  --host 127.0.0.1 --port 2000 run-local \
  --scenario "/tmp/pkg/${REV}/scenario.xosc" \
  --xodr "/tmp/pkg/${REV}/map.xodr" \
  --catalog "/tmp/pkg/${REV}/catalog.json" \
  --output "$OUT" --rig "$RIG" \
  --camera-width "$WIDTH" --camera-height "$HEIGHT" --fps 30 \
  --end-seconds "$SECONDS_END" 2>&1 | tail -12
STATUS=${PIPESTATUS[0]}

kill "$SAMPLER" 2>/dev/null
echo "exit=${STATUS} peakVramMiB=$(sort -n "$VRAM_LOG" 2>/dev/null | tail -1) samples=$(wc -l < "$VRAM_LOG" 2>/dev/null)"
docker exec "$WORKER" bash -lc "ls ${OUT}/*.mp4 2>/dev/null | wc -l; du -sh ${OUT} 2>/dev/null"
exit "$STATUS"
