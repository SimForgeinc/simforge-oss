#!/bin/bash
# Prove a rented RTX 3090 can actually run CARLA, before any render job is leased.
#
# Every check here exists because something measured on our 10 GiB 3080s failed
# in a way that did not say what was wrong
# (artifacts/production-scenarios/carla-on-3080-handoff.md). In order:
#
#   1  instance is running and is one we created (recorded id + label)
#   2  the image is the one we asked for, carrying the pinned CARLA base manifest
#   3  driver >= 550 as reported by nvidia-smi, not by the offer
#   4  real free VRAM from nvidia-smi — one 3090 offer advertises 20480 MiB, so
#      the advertised number is not evidence
#   5  nothing else is already using the card
#   6  the Vulkan path is present (NVIDIA ICD + GLX/Vulkan libraries)
#   7  engine boots headless at -quality-level=Epic and answers RPC, probed in a
#      loop with retried launches (handoff §1.1, §1.2) — never a fixed sleep
#   8  20 synchronous ticks with no sensors, with VRAM sampled at 2 Hz, to record
#      the engine-only peak the way §2 does
#
# Usage:
#   verify-instance.sh                 # uses the recorded instance id
#   verify-instance.sh --instance-id N # explicit, must still be one we created
#   verify-instance.sh --skip-engine   # checks 1-6 only (no GPU work)
#
# Read-only with respect to billing: it never creates or destroys an instance.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "$HERE/common.sh"

INSTANCE_ID=""
SKIP_ENGINE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --instance-id) INSTANCE_ID="${2:?--instance-id needs a value}"; shift 2 ;;
    --skip-engine) SKIP_ENGINE=1; shift ;;
    --state-dir)   STATE_DIR="${2:?--state-dir needs a value}"; shift 2 ;;
    -h|--help)     sed -n '2,27p' "$0"; exit 0 ;;
    *)             die "unknown argument: $1" ;;
  esac
done

assert_vast_ready
mkdir -p "$STATE_DIR"

FAILURES=0
PASSES=0
check_pass() { PASSES=$((PASSES+1)); printf '  PASS  %s\n' "$*"; }
check_fail() { FAILURES=$((FAILURES+1)); printf '  FAIL  %s\n' "$*"; }
check_note() { printf '  note  %s\n' "$*"; }

# --- 1. instance identity --------------------------------------------------
if [ -z "$INSTANCE_ID" ]; then
  INSTANCE_ID="$(recorded_instance_id)" || die "no recorded instance; run provision-3090.sh --confirm first"
fi
was_created_by_us "$INSTANCE_ID" || \
  die "instance $INSTANCE_ID is not in $(created_ledger); refusing to touch an instance this tooling did not create"

snap="$(instance_json "$INSTANCE_ID")"
[ -n "$snap" ] || die "instance $INSTANCE_ID does not exist (already destroyed?)"

status="$(jq -r '.actual_status // .cur_state // "unknown"' <<<"$snap")"
label="$(jq -r '.label // ""' <<<"$snap")"
image="$(jq -r '.image_uuid // .image // ""' <<<"$snap")"
dph="$(jq -r '.dph_total // 0' <<<"$snap")"
ssh_host="$(jq -r '.ssh_host // ""' <<<"$snap")"
ssh_port="$(jq -r '.ssh_port // ""' <<<"$snap")"

rule
printf 'instance %s  status=%s  label=%s  $%s/hr\n' "$INSTANCE_ID" "$status" "$label" "$dph"
printf 'image    %s\n' "$image"
rule
printf '1. instance identity\n'
[ "$status" = "running" ] && check_pass "status running" || check_fail "status is $status, not running"
[ "$label" = "$VAST_LABEL" ] && check_pass "label matches $VAST_LABEL" || check_fail "label '$label' != '$VAST_LABEL'"

# --- ssh transport ---------------------------------------------------------
# Prefer the direct host/port off the instance record; fall back to ssh-url.
if [ -z "$ssh_host" ] || [ "$ssh_host" = "null" ]; then
  url="$(vast ssh-url "$INSTANCE_ID" 2>/dev/null || true)"
  ssh_host="${url#ssh://root@}"; ssh_port="${ssh_host##*:}"; ssh_host="${ssh_host%%:*}"
fi
[ -n "$ssh_host" ] || die "no ssh endpoint for instance $INSTANCE_ID"

SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=25
          -o ServerAliveInterval=15 -p "${ssh_port:-22}")
rsh() { ssh "${SSH_OPTS[@]}" "root@$ssh_host" "$@"; }

# The link to a rented box drops; retry the handshake instead of failing the run.
ssh_ready=0
for attempt in $(seq 1 12); do
  if rsh true >/dev/null 2>&1; then ssh_ready=1; break; fi
  info "ssh not ready (attempt $attempt/12), retrying in 15s"
  sleep 15
done
[ "$ssh_ready" -eq 1 ] || die "cannot ssh to root@$ssh_host:${ssh_port:-22}; is an ssh key attached? ($VAST_BIN attach ssh $INSTANCE_ID \"\$(cat ~/.ssh/id_rsa.pub)\")"
check_pass "ssh to root@$ssh_host:${ssh_port:-22}"

# --- 2. image identity -----------------------------------------------------
printf '2. image identity\n'
want_image="$(jq -r '.image // ""' "$(state_file)" 2>/dev/null || echo "")"
if [ -n "$want_image" ] && [ "$image" = "$want_image" ]; then
  check_pass "image is the requested $image"
elif [ -n "$want_image" ]; then
  check_fail "image $image != requested $want_image"
fi
remote_manifest="$(rsh 'printenv UNISCENARIOS_CARLA_IMAGE_MANIFEST_SHA256 || printenv SIMFORGE_CARLA_IMAGE_MANIFEST_SHA256 || true' 2>/dev/null | tr -d '[:space:]')"
if [ "$remote_manifest" = "$CARLA_BASE_MANIFEST_SHA256" ]; then
  check_pass "CARLA base manifest ${remote_manifest:0:12}… matches the pinned 0.10.0 base"
elif [ -n "$remote_manifest" ]; then
  check_fail "CARLA base manifest $remote_manifest != $CARLA_BASE_MANIFEST_SHA256"
else
  check_note "image does not export the CARLA base manifest digest; identity unverified"
fi

# --- 3/4/5. driver, real VRAM, exclusivity ---------------------------------
printf '3. driver and VRAM (nvidia-smi, not the offer)\n'
gpu_line="$(rsh 'nvidia-smi --query-gpu=name,driver_version,memory.total,memory.used,memory.free --format=csv,noheader,nounits' 2>/dev/null | head -1)"
[ -n "$gpu_line" ] || die "nvidia-smi produced nothing on the instance"
IFS=',' read -r g_name g_driver g_total g_used g_free <<<"$gpu_line"
g_name="$(echo "$g_name" | xargs)"; g_driver="$(echo "$g_driver" | xargs)"
g_total="$(echo "$g_total" | xargs)"; g_used="$(echo "$g_used" | xargs)"; g_free="$(echo "$g_free" | xargs)"
printf '  gpu %s, driver %s, total %s MiB, used %s MiB, free %s MiB\n' \
  "$g_name" "$g_driver" "$g_total" "$g_used" "$g_free"

if driver_ge "$g_driver" "$MIN_DRIVER"; then
  check_pass "driver $g_driver >= $MIN_DRIVER (CARLA 0.10.0 requirement)"
else
  check_fail "driver $g_driver < $MIN_DRIVER — CARLA 0.10.0 will not run"
fi
case "$g_name" in *3090*) check_pass "card is an RTX 3090" ;;
                  *) check_fail "card reports '$g_name', not a 3090" ;; esac
if [ "${g_free:-0}" -ge "$MIN_FREE_VRAM_MIB" ]; then
  check_pass "free VRAM $g_free MiB >= $MIN_FREE_VRAM_MIB MiB floor"
else
  check_fail "free VRAM $g_free MiB < $MIN_FREE_VRAM_MIB MiB (advertised gpu_ram is not evidence; one 3090 offer advertises 20480)"
fi
# The register route's own gate: gpuMemoryMiB must be >= 24576 nominal minus the
# driver reserve, so a board advertising 20480 MiB cannot register as a 3090.
if [ "${g_total:-0}" -ge "$MIN_TOTAL_VRAM_MIB" ]; then
  check_pass "total VRAM $g_total MiB >= $MIN_TOTAL_VRAM_MIB MiB (register gate for $HARDWARE_PROFILE)"
else
  check_fail "total VRAM $g_total MiB < $MIN_TOTAL_VRAM_MIB MiB — the register route will reject this board as $HARDWARE_PROFILE"
fi

printf '3b. dev registration contract on the instance\n'
rev="$(rsh 'printenv SIMFORGE_SOURCE_REVISION || true' 2>/dev/null | tr -d '[:space:]')"
if is_commit_sha "$rev"; then
  check_pass "SIMFORGE_SOURCE_REVISION=$rev (40-hex; the engine version the control plane approves)"
else
  check_fail "SIMFORGE_SOURCE_REVISION=${rev:-unset} is not a 40-hex commit — the engine refuses to start without it"
fi
# builtin-engines.ts:179 resolves the engine version as
# options.engineVersion ?? SIMFORGE_CARLA_SOURCE_REVISION ?? SIMFORGE_SOURCE_REVISION,
# and the config writes no engineVersion option. So a stale or malformed
# SIMFORGE_CARLA_SOURCE_REVISION baked into the image silently outranks the
# value passed at create time.
carla_rev="$(rsh 'printenv SIMFORGE_CARLA_SOURCE_REVISION || true' 2>/dev/null | tr -d '[:space:]')"
if [ -z "$carla_rev" ]; then
  check_pass "SIMFORGE_CARLA_SOURCE_REVISION unset, so SIMFORGE_SOURCE_REVISION is the engine version"
elif ! is_commit_sha "$carla_rev"; then
  check_fail "SIMFORGE_CARLA_SOURCE_REVISION=$carla_rev outranks SIMFORGE_SOURCE_REVISION and is not 40-hex — the engine will refuse to start"
elif [ "$carla_rev" != "$rev" ]; then
  check_note "SIMFORGE_CARLA_SOURCE_REVISION=$carla_rev takes precedence over SIMFORGE_SOURCE_REVISION=$rev; the control plane will approve the former"
else
  check_pass "SIMFORGE_CARLA_SOURCE_REVISION agrees with SIMFORGE_SOURCE_REVISION"
fi
for pair in "SIMFORGE_BASE_IMAGE=$CARLA_BASE_IMAGE" \
            "SIMFORGE_BASE_IMAGE_DIGEST=$CARLA_BASE_INDEX_DIGEST" \
            "SIMFORGE_BASE_IMAGE_PLATFORM_DIGEST=$CARLA_BASE_PLATFORM_DIGEST"; do
  key="${pair%%=*}"; want="${pair#*=}"
  got="$(rsh "printenv $key || true" 2>/dev/null | tr -d '[:space:]')"
  if [ "$got" = "$want" ]; then check_pass "$key matches the approved value"
  else check_fail "$key=${got:-unset} != $want"; fi
done
node_id="$(rsh 'printenv SIMFORGE_WORKER_NODE_ID || true' 2>/dev/null | tr -d '[:space:]')"
if [ -n "$node_id" ]; then check_pass "SIMFORGE_WORKER_NODE_ID=$node_id (sent as x-simforge-worker-node-id)"
else check_fail "SIMFORGE_WORKER_NODE_ID unset — the register route rejects a mismatch"; fi
if rsh 'printenv SIMFORGE_RENDER_WORKER_TOKEN >/dev/null 2>&1' 2>/dev/null; then
  check_pass "SIMFORGE_RENDER_WORKER_TOKEN present (value not read)"
else
  check_fail "SIMFORGE_RENDER_WORKER_TOKEN unset — the control transport has no bearer token"
fi
profile="$(rsh 'printenv SIMFORGE_HARDWARE_PROFILE || true' 2>/dev/null | tr -d '[:space:]')"
if [ "$profile" = "$HARDWARE_PROFILE" ]; then check_pass "SIMFORGE_HARDWARE_PROFILE=$profile"
else check_fail "SIMFORGE_HARDWARE_PROFILE=${profile:-unset} != $HARDWARE_PROFILE"; fi

printf '3c. worker config rendered by onstart (/config/worker.json)\n'
# This file, not the environment, is what renderWorkerIdentity reads
# (carla.Dockerfile CMD ["--config", "/config/worker.json"]).
blocked="$(rsh 'cat /opt/simforge-provision/blocked 2>/dev/null || true' 2>/dev/null)"
if [ -n "$blocked" ]; then
  check_fail "onstart refused to write a config: $blocked"
fi
worker_config="$(rsh 'cat /config/worker.json 2>/dev/null || true' 2>/dev/null)"
if [ -z "$worker_config" ]; then
  check_fail "/config/worker.json is missing — the worker has nothing to register with (see: rsh cat /opt/simforge-provision/onstart.log)"
elif ! jq -e . >/dev/null 2>&1 <<<"$worker_config"; then
  check_fail "/config/worker.json is not valid JSON"
else
  check_pass "/config/worker.json parses"
  wc_get() { jq -r "$1 // empty" <<<"$worker_config"; }
  [ "$(wc_get .workerId)" = "$node_id" ] && \
    check_pass "config workerId matches the worker-node id" || \
    check_fail "config workerId '$(wc_get .workerId)' != SIMFORGE_WORKER_NODE_ID '$node_id'"
  [ "$(wc_get .control.kind)" = "http" ] && \
    check_pass "control.kind=http" || check_fail "control.kind='$(wc_get .control.kind)', expected http"
  [ "$(wc_get .control.tokenEnv)" = "SIMFORGE_RENDER_WORKER_TOKEN" ] && \
    check_pass "control.tokenEnv=SIMFORGE_RENDER_WORKER_TOKEN" || \
    check_fail "control.tokenEnv='$(wc_get .control.tokenEnv)'"
  [ "$(wc_get .control.baseUrl)" != "" ] && \
    check_pass "control.baseUrl=$(wc_get .control.baseUrl)" || check_fail "control.baseUrl is empty"
  cfg_mem="$(wc_get .labels.gpuMemoryMiB)"
  if [ "${cfg_mem:-0}" -ge "$MIN_TOTAL_VRAM_MIB" ] 2>/dev/null; then
    check_pass "labels.gpuMemoryMiB=$cfg_mem (>= $MIN_TOTAL_VRAM_MIB, read from nvidia-smi by onstart)"
  else
    check_fail "labels.gpuMemoryMiB='${cfg_mem:-unset}' < $MIN_TOTAL_VRAM_MIB — registration would reject it"
  fi
  if [ "$cfg_mem" = "$g_total" ]; then
    check_pass "labels.gpuMemoryMiB equals the card's real total"
  else
    check_fail "labels.gpuMemoryMiB=$cfg_mem but nvidia-smi total is $g_total — the config does not describe this card"
  fi
  for pair in "hardwareProfile=$HARDWARE_PROFILE" "baseImage=$CARLA_BASE_IMAGE" \
              "baseImageDigest=$CARLA_BASE_INDEX_DIGEST" \
              "baseImagePlatformDigest=$CARLA_BASE_PLATFORM_DIGEST"; do
    key="${pair%%=*}"; want="${pair#*=}"; got="$(wc_get ".labels.$key")"
    [ "$got" = "$want" ] && check_pass "labels.$key matches" || check_fail "labels.$key='$got' != '$want'"
  done
  is_digest "$(wc_get .labels.imageDigest)" && \
    check_pass "labels.imageDigest=$(wc_get .labels.imageDigest)" || \
    check_fail "labels.imageDigest='$(wc_get .labels.imageDigest)' is not sha256:<64hex>"
  case "$(wc_get .labels.gpuModel)" in
    *3090*) check_pass "labels.gpuModel=$(wc_get .labels.gpuModel)" ;;
    *) check_fail "labels.gpuModel='$(wc_get .labels.gpuModel)' is not a 3090" ;;
  esac
fi

printf '4. card exclusivity\n'
apps="$(rsh 'nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader' 2>/dev/null | sed '/^\s*$/d')"
if [ -z "$apps" ]; then check_pass "no other compute apps on the card"
else check_fail "card already busy: $apps"; fi

# --- 6. Vulkan path --------------------------------------------------------
printf '5. Vulkan path (NVIDIA_DRIVER_CAPABILITIES=all)\n'
caps="$(rsh 'printenv NVIDIA_DRIVER_CAPABILITIES || true' 2>/dev/null | tr -d '[:space:]')"
case "$caps" in
  all) check_pass "NVIDIA_DRIVER_CAPABILITIES=all" ;;
  *graphics*) check_note "NVIDIA_DRIVER_CAPABILITIES=$caps (graphics present, 'all' preferred)" ;;
  *) check_fail "NVIDIA_DRIVER_CAPABILITIES=${caps:-unset} — the Vulkan libraries will be missing" ;;
esac
icd="$(rsh 'ls /usr/share/vulkan/icd.d/ 2>/dev/null | tr "\n" " "' 2>/dev/null)"
case "$icd" in *nvidia*) check_pass "NVIDIA Vulkan ICD present: $icd" ;;
               *) check_fail "no NVIDIA Vulkan ICD in /usr/share/vulkan/icd.d (found: ${icd:-none})" ;; esac
libs="$(rsh 'ldconfig -p 2>/dev/null | grep -c -E "libnvidia-glcore|libGLX_nvidia|libnvidia-glvkspirv"' 2>/dev/null | tr -d '[:space:]')"
if [ "${libs:-0}" -ge 1 ]; then check_pass "$libs NVIDIA graphics/Vulkan libraries linked"
else check_fail "no NVIDIA graphics libraries found — capabilities were not injected"; fi
vk="$(rsh 'command -v vulkaninfo >/dev/null 2>&1 && vulkaninfo --summary 2>/dev/null | grep -m1 -E "deviceName|GPU id" || echo "vulkaninfo absent"' 2>/dev/null)"
check_note "vulkaninfo: ${vk:-unavailable}"

if [ "$SKIP_ENGINE" -eq 1 ]; then
  rule
  printf 'checks: %s passed, %s failed (engine boot skipped)\n' "$PASSES" "$FAILURES"
  [ "$FAILURES" -eq 0 ] || exit 1
  exit 0
fi

# --- 7/8. engine boot, RPC readiness, engine-only tick cost ----------------
printf '6. engine boot + RPC readiness (retried launches, polled readiness)\n'

# Resolve the engine launcher and a python that can import carla. Paths differ
# between the locally built runtime image and the ECR worker image, so probe
# rather than assume.
engine_sh="$(rsh 'for p in /home/carla/CarlaUnreal.sh /opt/carla/CarlaUnreal.sh /home/carla/CarlaUE4.sh; do [ -x "$p" ] && { echo "$p"; break; }; done' 2>/dev/null | tr -d '\r')"
py_bin="$(rsh 'for p in /opt/simforge/venv/bin/python /opt/simforge/bin/python-carla /usr/bin/python3; do "$p" -c "import carla" >/dev/null 2>&1 && { echo "$p"; break; }; done' 2>/dev/null | tr -d '\r')"
[ -n "$engine_sh" ] || { check_fail "no CARLA launcher found on the instance"; }
[ -n "$py_bin" ]    || { check_fail "no python on the instance can import carla"; }
if [ -z "$engine_sh" ] || [ -z "$py_bin" ]; then
  rule; printf 'checks: %s passed, %s failed\n' "$PASSES" "$FAILURES"; exit 1
fi
check_pass "launcher $engine_sh, python $py_bin"

ready=0
peak_vram=0
for attempt in $(seq 1 "$ENGINE_LAUNCH_ATTEMPTS"); do
  info "engine launch attempt $attempt/$ENGINE_LAUNCH_ATTEMPTS"
  # Long-lived and detached: the ssh link drops, the engine must not.
  rsh "pkill -f CarlaUnreal >/dev/null 2>&1; sleep 2; \
       setsid nohup $engine_sh -RenderOffScreen -nosound -quality-level=$CARLA_QUALITY \
         -carla-rpc-port=$CARLA_RPC_PORT >/tmp/carla-engine.log 2>&1 </dev/null & \
       echo launched" >/dev/null 2>&1
  # 2 Hz VRAM sampler for the peak; §2 failures all happen at peak.
  rsh "setsid nohup bash -c 'for i in \$(seq 1 1200); do nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits >> /tmp/vram.log; sleep 0.5; done' >/dev/null 2>&1 </dev/null & echo sampling" >/dev/null 2>&1

  for poll in $(seq 1 "$READY_POLLS"); do
    if rsh "$py_bin -c 'import carla;c=carla.Client(\"127.0.0.1\",$CARLA_RPC_PORT);c.set_timeout(10.0);print(c.get_world().get_map().name)'" >/tmp/.rpc-out 2>/dev/null; then
      ready=1; break
    fi
    sleep "$READY_POLL_SECONDS"
  done
  [ "$ready" -eq 1 ] && break
  check_note "attempt $attempt never reached RPC readiness; engine log tail:"
  rsh 'tail -5 /tmp/carla-engine.log 2>/dev/null' 2>/dev/null | sed 's/^/        /'
done

if [ "$ready" -eq 1 ]; then
  check_pass "RPC answered: map $(tr -d '\r\n' </tmp/.rpc-out)"
  # 20 synchronous ticks, no sensors — the engine-only cost, same shape as §2.
  tick_out="$(rsh "$py_bin - <<'PY'
import time, carla
c = carla.Client('127.0.0.1', $CARLA_RPC_PORT); c.set_timeout(60.0)
w = c.get_world(); s = w.get_settings()
s.synchronous_mode = True; s.fixed_delta_seconds = 0.02
w.apply_settings(s)
t0 = time.time()
for _ in range(20):
    w.tick()
print('ticks=20 seconds=%.3f per_tick=%.4f' % (time.time()-t0, (time.time()-t0)/20))
PY" 2>/dev/null)"
  if [ -n "$tick_out" ]; then check_pass "synchronous ticks: $tick_out"
  else check_fail "engine answered RPC but 20 synchronous ticks failed (check VRAM peak: handoff §3)"; fi
  peak_vram="$(rsh 'sort -n /tmp/vram.log 2>/dev/null | tail -1' 2>/dev/null | tr -d '[:space:]')"
  check_note "engine-only peak VRAM ${peak_vram:-unknown} MiB (ws2 3080 band was 6234-7238 MiB)"
else
  check_fail "engine never reached RPC readiness in $ENGINE_LAUNCH_ATTEMPTS attempts"
fi

# Scope cleanup to our own processes only.
rsh "pkill -f 'seq 1 1200' >/dev/null 2>&1; pkill -f CarlaUnreal >/dev/null 2>&1; true" >/dev/null 2>&1 || true

# --- report ----------------------------------------------------------------
jq -n --arg id "$INSTANCE_ID" --arg status "$status" --arg image "$image" \
      --arg driver "$g_driver" --arg gpu "$g_name" --arg free "$g_free" \
      --arg total "$g_total" --arg caps "$caps" --arg peak "${peak_vram:-}" \
      --arg ticks "${tick_out:-}" --argjson ready "$ready" \
      --argjson passes "$PASSES" --argjson failures "$FAILURES" \
      --arg rev "${rev:-}" --arg node "${node_id:-}" --arg profile "${profile:-}" \
      --argjson floor "$MIN_TOTAL_VRAM_MIB" \
      --arg at "$(date -u +%FT%TZ)" \
      '{instance_id:($id|tonumber), verified_at:$at, environment:"dev", status:$status,
        image:$image, gpu:$gpu, driver_version:$driver, vram_total_mib:($total|tonumber?),
        vram_free_mib:($free|tonumber?), driver_capabilities:$caps,
        registration:{hardware_profile:$profile, worker_node_id:$node,
                      source_revision:$rev, gpu_memory_mib_floor:$floor},
        engine_rpc_ready:($ready==1), engine_only_peak_vram_mib:$peak,
        engine_tick_sample:$ticks, checks_passed:$passes, checks_failed:$failures}' \
  > "$(report_file)"

rule
printf 'checks: %s passed, %s failed — report written to %s\n' "$PASSES" "$FAILURES" "$(report_file)"
[ "$FAILURES" -eq 0 ] || exit 1
printf 'instance %s is ready to lease a CARLA render job.\n' "$INSTANCE_ID"
