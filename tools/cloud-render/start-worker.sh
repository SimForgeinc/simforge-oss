#!/bin/bash
# Boot CARLA, observe RPC readiness, render the worker config, run the worker.
#
# If an engine is already answering on CARLA_HOST:CARLA_PORT this adopts it
# instead of launching its own. That is what lets the engine run from a
# full-cook image while the worker runs from the worker image, which is the
# only way to get both the cooked content and the worker onto one box without
# rebuilding either.
#
# Quality defaults to Epic deliberately: -quality-level=Low was measured to
# prevent the engine reaching RPC readiness on these cooked maps, which cost
# several debugging cycles. Do not lower it without re-testing readiness.
set -uo pipefail
log() { printf '{"component":"start-worker","event":"%s","detail":"%s"}\n' "$1" "${2:-}"; }
PY=/opt/simforge/venv/bin/python
NODE=/opt/node/bin/node

log start "revision=${SIMFORGE_SOURCE_REVISION:-unset} profile=${SIMFORGE_HARDWARE_PROFILE:-unset}"
nvidia-smi --query-gpu=name,memory.total,memory.free,driver_version --format=csv,noheader || log warn "no nvidia-smi"

# Named for what it now measures; the old free-memory name still works.
FLOOR="${SIMFORGE_MIN_TOTAL_VRAM_MIB:-${SIMFORGE_MIN_FREE_VRAM_MIB:-20000}}"
# Total, not free: an engine that is already up has legitimately spent VRAM,
# and a free-memory floor would refuse the box it just warmed.
TOTAL=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -1)
log vram "total=${TOTAL:-unknown} floor=${FLOOR}"
if [ -n "${TOTAL:-}" ] && [ "$TOTAL" -lt "$FLOOR" ]; then log fatal "total VRAM ${TOTAL} below floor ${FLOOR}"; exit 1; fi

engine_ready() {
  "$PY" - <<'EOF' >/dev/null 2>&1
import os, carla
c = carla.Client(os.environ.get("CARLA_HOST","127.0.0.1"), int(os.environ.get("CARLA_PORT","2000")))
c.set_timeout(15.0); c.get_world().get_map().name
EOF
}
launch() {
  setsid nohup /home/carla/CarlaUnreal.sh -RenderOffScreen -nosound \
    "-quality-level=${CARLA_QUALITY:-Epic}" "-carla-rpc-port=${CARLA_PORT}" \
    > /tmp/carla-engine.log 2>&1 < /dev/null &
}

ready=no
if engine_ready; then
  ready=yes
  log engine-adopted "host=${CARLA_HOST:-127.0.0.1} port=${CARLA_PORT}"
fi
for attempt in $(seq 1 "${ENGINE_LAUNCH_ATTEMPTS:-6}"); do
  [ "$ready" = yes ] && break
  log engine-launch "attempt=${attempt} quality=${CARLA_QUALITY:-Epic}"
  launch
  for poll in $(seq 1 "${ENGINE_READY_POLLS:-30}"); do
    sleep 10
    if engine_ready; then ready=yes; log engine-ready "attempt=${attempt} poll=${poll}"; break; fi
  done
  [ "$ready" = yes ] && break
  log engine-retry "attempt=${attempt} tail=$(tail -3 /tmp/carla-engine.log | tr '\n' ' ')"
  pkill -f CarlaUnreal || true; sleep 5
done
[ "$ready" = yes ] || { log fatal "engine never reached RPC readiness"; tail -30 /tmp/carla-engine.log; exit 1; }

# The worker takes a config file, not env vars: RenderWorkerConfigSchema is a
# strictObject, so only its declared keys may appear.
CONFIG=/config/worker.json
"$PY" - > "$CONFIG" <<'EOF'
import json, os, subprocess
def gpu_mem():
    try:
        out = subprocess.run(["nvidia-smi","--query-gpu=memory.total","--format=csv,noheader,nounits"],
                             capture_output=True, text=True, timeout=10).stdout.strip().splitlines()
        return out[0].strip() if out else "unknown"
    except Exception:
        return "unknown"
print(json.dumps({
    "workerId": os.environ["SIMFORGE_WORKER_NODE_ID"],
    "instanceId": os.environ.get("SIMFORGE_INSTANCE_ID") or os.environ["SIMFORGE_WORKER_NODE_ID"] + "-inst",
    "engine": {"id": "carla", "options": {}},
    "control": {
        "kind": "http",
        "baseUrl": os.environ["SIMFORGE_API_BASE_URL"],
        "tokenEnv": "SIMFORGE_RENDER_WORKER_TOKEN",
        "requestTimeoutMs": 60000,
    },
    "labels": {
        "hardwareProfile": os.environ["SIMFORGE_HARDWARE_PROFILE"],
        "gpuModel": os.environ.get("SIMFORGE_GPU_MODEL", "unknown"),
        "gpuMemoryMiB": gpu_mem(),
        "imageDigest": os.environ.get("SIMFORGE_WORKER_IMAGE_DIGEST", "unknown"),
        "workerVersion": os.environ["SIMFORGE_WORKER_REVISION"],
        "carlaVersion": os.environ["SIMFORGE_CARLA_VERSION"],
        "engineVersion": os.environ["SIMFORGE_ENGINE_VERSION"],
    },
    "scratchDir": "/var/simforge/scratch",
    "cacheDir": "/var/simforge/cache",
    "gpuLockPath": "/var/simforge/run/gpu.lock",
    "pollIntervalMs": 5000,
}, indent=2))
EOF
log config-written "$(tr -d '\n' < "$CONFIG" | head -c 200)"

log worker-start "base=${SIMFORGE_API_BASE_URL:-unset} node=${SIMFORGE_WORKER_NODE_ID:-unset}"
exec "$NODE" /opt/simforge/render-worker-ts/dist/main.js --config "$CONFIG"
