#!/bin/bash
# Rent ONE RTX 3090 on vast.ai that can run a CARLA render worker against the
# DEV control plane.
#
# A bare invocation is read-only: it runs the live offer search, picks the
# cheapest qualifying offer, prints the cost model and the exact create command,
# and exits without spending anything. Renting requires --confirm.
#
# Usage:
#   provision-3090.sh                 # plan only; never spends
#   provision-3090.sh --confirm       # rent the cheapest qualifying offer
#   provision-3090.sh --offer-id N    # plan/rent a specific offer
#
# Options:
#   --confirm            actually create the instance
#   --offer-id N         use this offer instead of the cheapest
#   --disk GB            local disk to rent (default 200)
#   --image REF          instance image (must be a registry ref, dev only)
#   --ticks N            ticks used for the per-render cost estimate (default 1001)
#   --state-dir DIR      where the instance id is recorded
#
# Environment:
#   SIMFORGE_API_BASE_URL  dev control-plane base URL the worker registers with.
#                          Required for --confirm. No default: there is no
#                          hardcoded dev host in this checkout, and inventing one
#                          would be a lie.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "$HERE/common.sh"

CONFIRM=0
OFFER_ID=""
while [ $# -gt 0 ]; do
  case "$1" in
    --confirm)   CONFIRM=1; shift ;;
    --offer-id)  OFFER_ID="${2:?--offer-id needs a value}"; shift 2 ;;
    --disk)      DISK_GB="${2:?--disk needs a value}"; shift 2 ;;
    --image)     CARLA_IMAGE="${2:?--image needs a value}"; shift 2 ;;
    --ticks)     RENDER_TICKS="${2:?--ticks needs a value}"; shift 2 ;;
    --state-dir) STATE_DIR="${2:?--state-dir needs a value}"; shift 2 ;;
    -h|--help)   sed -n '2,30p' "$0"; exit 0 ;;
    *)           die "unknown argument: $1 (see --help)" ;;
  esac
done

API_BASE_URL="${SIMFORGE_API_BASE_URL:-}"
assert_vast_ready
assert_dev_target "$API_BASE_URL"
mkdir -p "$STATE_DIR"

# --- 0. already rented? ----------------------------------------------------
# Idempotence: a recorded, still-live instance is the answer, not a second rental.
if existing_id="$(recorded_instance_id)"; then
  existing="$(instance_json "$existing_id")"
  if [ -n "$existing" ]; then
    printf 'instance %s already provisioned (status=%s, label=%s, $%s/hr)\n' \
      "$existing_id" \
      "$(jq -r '.actual_status // .cur_state // "unknown"' <<<"$existing")" \
      "$(jq -r '.label // "-"' <<<"$existing")" \
      "$(jq -r '.dph_total // 0' <<<"$existing")"
    printf 'nothing to do. verify with: %s/verify-instance.sh\n' "$HERE"
    exit 0
  fi
  log "recorded instance $existing_id no longer exists; continuing"
fi

# --- 1. credentials --------------------------------------------------------
aws_access_key="$(aws_sf configure get aws_access_key_id 2>/dev/null || true)"
aws_secret_key="$(aws_sf configure get aws_secret_access_key 2>/dev/null || true)"
[ -n "$aws_access_key" ] && [ -n "$aws_secret_key" ] || \
  die "no static AWS keys for profile $AWS_PROFILE_NAME; the instance needs them as create-time env"

ssh_keys="$(vast show ssh-keys --raw 2>/dev/null | jq 'length' 2>/dev/null || echo 0)"
if [ "${ssh_keys:-0}" -eq 0 ]; then
  log "warning: the vast account has no ssh key registered, so verify-instance.sh"
  log "         will not be able to log in. Register one first:"
  log "           $VAST_BIN create ssh-key \"\$(cat ~/.ssh/id_rsa.pub)\""
fi

credit="$(vast_credit)"

# --- 2. live offer search (read-only) --------------------------------------
info "searching offers: $VAST_QUERY"
offers_json="$(vast search offers "$VAST_QUERY" -o dph_total --storage "$DISK_GB" --raw)"
count="$(jq 'length' <<<"$offers_json")"
[ "${count:-0}" -gt 0 ] || die "no offers matched. Relax the query or re-run later."

if [ -n "$OFFER_ID" ]; then
  offer="$(jq -c --argjson id "$OFFER_ID" 'map(select(.id==$id))[0] // empty' <<<"$offers_json")"
  [ -n "$offer" ] || die "offer $OFFER_ID is not in the qualifying set"
else
  offer="$(jq -c 'sort_by(.dph_total)[0]' <<<"$offers_json")"
fi

o() { jq -r "$1" <<<"$offer"; }
offer_id="$(o .id)"; driver="$(o .driver_version)"; gpu_ram="$(o .gpu_ram)"
disk_avail="$(o .disk_space)"; dph="$(o .dph_total)"; storage_cost="$(o .storage_cost)"
inet_down="$(o '.inet_down // 0')"; inet_down_cost="$(o '.inet_down_cost // 0')"
inet_up_cost="$(o '.inet_up_cost // 0')"; geo="$(o '.geolocation // "-"')"
reliability="$(o '.reliability2 // 0')"; machine="$(o .machine_id)"
cuda="$(o '.cuda_max_good // 0')"; verif="$(o '.verification // "-"')"

# Re-check server-side filters locally. A textual filter that silently stops
# working would otherwise hand us a driver CARLA cannot use.
driver_ge "$driver" "$MIN_DRIVER" || die "offer $offer_id reports driver $driver < $MIN_DRIVER"
awk -v d="$disk_avail" -v need="$DISK_GB" 'BEGIN{exit !(d+0 >= need+0)}' || \
  die "offer $offer_id has ${disk_avail}GB disk < ${DISK_GB}GB"

# --- 3. image transfer size (live, for the pull cost) ----------------------
image_repo="${CARLA_IMAGE#*/}"; image_repo="${image_repo%%:*}"
image_tag="${CARLA_IMAGE##*:}"
image_bytes=""
if [ "${CARLA_IMAGE%%/*}" = "$ECR_REGISTRY" ]; then
  image_bytes="$(aws_sf --region "$ECR_REGION" ecr describe-images \
      --repository-name "$image_repo" --image-ids "imageTag=$image_tag" \
      --query 'imageDetails[0].imageSizeInBytes' --output text 2>/dev/null || true)"
  image_digest="$(aws_sf --region "$ECR_REGION" ecr describe-images \
      --repository-name "$image_repo" --image-ids "imageTag=$image_tag" \
      --query 'imageDetails[0].imageDigest' --output text 2>/dev/null || true)"
fi
case "$image_bytes" in
  ''|None|null) log "warning: could not resolve $CARLA_IMAGE in ECR; using fallback size"
                image_bytes="$CARLA_IMAGE_BYTES_FALLBACK"; image_digest="unresolved" ;;
esac

# --- 4. cost model ---------------------------------------------------------
read -r image_gb pull_cost pull_sec render_sec render_cost total_first <<EOF
$(awk -v b="$image_bytes" -v idc="$inet_down_cost" -v down="$inet_down" \
      -v dph="$dph" -v tick="$CARLA_SEC_PER_TICK" -v start="$CARLA_STARTUP_SEC" \
      -v n="$RENDER_TICKS" 'BEGIN{
  gb=b/1e9; pull=gb*idc;
  psec=(down>0)? (b*8)/(down*1e6) : 0;
  rsec=n*tick+start;
  rcost=dph*rsec/3600;
  printf "%.2f %.4f %.0f %.1f %.4f %.4f", gb, pull, psec, rsec, rcost, pull+dph*psec/3600+rcost;
}')
EOF

# --- 5. onstart script -----------------------------------------------------
# Renders /config/worker.json, which is what the worker actually reads
# (carla.Dockerfile CMD ["--config", "/config/worker.json"]); renderWorkerIdentity
# takes the registration labels from config.labels, not from the environment, so
# the create-time env has to be projected into that file here.
#
# It deliberately does NOT start the worker. gpuMemoryMiB must be the card's
# real total from nvidia-smi — registration rejects anything under the floor for
# rtx3090-24gb-v1 — so this script refuses to write a config it cannot back, rather
# than registering a claim the hardware does not support.
cat > "$(onstart_file)" <<ONSTART
#!/bin/bash
# simforge render-worker onstart (dev). Idempotent; safe to re-run.
set -u
MIN_TOTAL_VRAM_MIB=$MIN_TOTAL_VRAM_MIB
HARDWARE_PROFILE=$HARDWARE_PROFILE
WORKER_CONFIG=/config/worker.json
ONSTART
cat >> "$(onstart_file)" <<'ONSTART'
mkdir -p /opt/simforge-provision /config
exec >>/opt/simforge-provision/onstart.log 2>&1
echo "=== onstart $(date -u +%FT%TZ)"

# vast strips the container env from later ssh sessions; persist it.
env | grep -E '^(SIMFORGE|NVIDIA|AWS|CARLA|UNISCENARIOS)_' | sed 's/^/export /' \
  > /opt/simforge-provision/env.sh

nvidia-smi --query-gpu=name,driver_version,memory.total,memory.free \
  --format=csv,noheader > /opt/simforge-provision/gpu.txt 2>&1 || echo "nvidia-smi failed"
printf 'caps=%s\n' "${NVIDIA_DRIVER_CAPABILITIES:-unset}" >> /opt/simforge-provision/gpu.txt
cat /opt/simforge-provision/gpu.txt

# The two facts the offer cannot be trusted for, read from the card itself.
gpu_model="$(nvidia-smi --query-gpu=name --format=csv,noheader | head -1 | xargs)"
gpu_total="$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits | head -1 | xargs)"

fail() { echo "onstart: $*" >&2; echo "$*" > /opt/simforge-provision/blocked; exit 1; }

case "$gpu_model" in *3090*) ;; *) fail "card is '$gpu_model', not a 3090; refusing to write a $HARDWARE_PROFILE config" ;; esac
[ "${gpu_total:-0}" -ge "$MIN_TOTAL_VRAM_MIB" ] || \
  fail "real total VRAM ${gpu_total:-0} MiB < $MIN_TOTAL_VRAM_MIB MiB; registration would reject $HARDWARE_PROFILE"
printf '%s' "${SIMFORGE_SOURCE_REVISION:-}" | grep -Eqx '[0-9a-f]{40}' || \
  fail "SIMFORGE_SOURCE_REVISION='${SIMFORGE_SOURCE_REVISION:-}' is not a 40-hex commit"
[ -n "${SIMFORGE_WORKER_NODE_ID:-}" ] || fail "SIMFORGE_WORKER_NODE_ID is unset"
[ -n "${SIMFORGE_RENDER_WORKER_TOKEN:-}" ] || fail "SIMFORGE_RENDER_WORKER_TOKEN is unset"
[ -n "${SIMFORGE_API_BASE_URL:-}" ] || fail "SIMFORGE_API_BASE_URL is unset"

# RenderWorkerConfigSchema is a strictObject and its label values are strings,
# so gpuMemoryMiB is written as a string (services/render-worker/src/config.ts:21-51).
SIMFORGE_GPU_MODEL_REAL="$gpu_model" SIMFORGE_GPU_MEMORY_MIB_REAL="$gpu_total" \
SIMFORGE_HARDWARE_PROFILE_REQ="$HARDWARE_PROFILE" \
python3 - "$WORKER_CONFIG" <<'PY'
import json, os, re, sys


def env(key, default=None):
    value = os.environ.get(key, default)
    if value is None or value == "":
        raise SystemExit(f"onstart: {key} is unset")
    return value


raw_instance = os.environ.get("CONTAINER_ID") or os.environ.get("VAST_CONTAINERLABEL") \
    or f"vast-{os.uname().nodename}"
instance_id = re.sub(r"[^A-Za-z0-9._:-]", "-", raw_instance)[:128]
if not re.match(r"^[A-Za-z0-9]", instance_id):
    instance_id = f"v{instance_id}"[:128]

config = {
    "workerId": env("SIMFORGE_WORKER_NODE_ID"),
    "instanceId": instance_id,
    "engine": {"id": "carla", "options": {}},
    "control": {
        "kind": "http",
        "baseUrl": env("SIMFORGE_API_BASE_URL"),
        "tokenEnv": "SIMFORGE_RENDER_WORKER_TOKEN",
        "requestTimeoutMs": 30000,
    },
    "labels": {
        "hardwareProfile": env("SIMFORGE_HARDWARE_PROFILE_REQ"),
        "gpuModel": env("SIMFORGE_GPU_MODEL_REAL"),
        "gpuMemoryMiB": env("SIMFORGE_GPU_MEMORY_MIB_REAL"),
        "imageDigest": env("SIMFORGE_IMAGE_DIGEST"),
        "baseImage": env("SIMFORGE_BASE_IMAGE"),
        "baseImageDigest": env("SIMFORGE_BASE_IMAGE_DIGEST"),
        "baseImagePlatformDigest": env("SIMFORGE_BASE_IMAGE_PLATFORM_DIGEST"),
    },
    "scratchDir": os.environ.get("SIMFORGE_SCRATCH_DIR", "/scratch"),
    "cacheDir": os.environ.get("SIMFORGE_CACHE_DIR", "/cache"),
    "gpuLockPath": os.environ.get("SIMFORGE_GPU_LOCK", "/run/simforge/gpu.lock"),
}
with open(sys.argv[1], "w", encoding="utf-8") as handle:
    json.dump(config, handle, indent=2, sort_keys=True)
    handle.write("\n")
print(f"onstart: wrote {sys.argv[1]} for {config['labels']['gpuModel']} "
      f"{config['labels']['gpuMemoryMiB']} MiB as {config['labels']['hardwareProfile']}")
PY

cat "$WORKER_CONFIG"
touch /opt/simforge-provision/ready
echo "=== onstart done"
ONSTART
chmod +x "$(onstart_file)"

# --- 6. create command -----------------------------------------------------
# NVIDIA_DRIVER_CAPABILITIES=all: the image bakes compute,graphics,utility, and
# CARLA's Vulkan path needs the full graphics library injection.
create_env="-e NVIDIA_VISIBLE_DEVICES=all -e NVIDIA_DRIVER_CAPABILITIES=all"
create_env="$create_env -e SIMFORGE_ENV=dev"
create_env="$create_env -e SIMFORGE_HARDWARE_PROFILE=$HARDWARE_PROFILE"
create_env="$create_env -e SIMFORGE_WORKER_POOL=render"
create_env="$create_env -e SIMFORGE_API_BASE_URL=${API_BASE_URL:-SIMFORGE_API_BASE_URL-IS-UNSET}"
create_env="$create_env -e SIMFORGE_ARTIFACT_BUCKET=$DEV_ARTIFACT_BUCKET"
# --- dev registration contract (CloudGate). Labels are mandatory and exact;
# the register route rejects a mismatched worker-node id, and the engine now
# refuses to start without a 40-hex SIMFORGE_SOURCE_REVISION.
create_env="$create_env -e SIMFORGE_WORKER_NODE_ID=${WORKER_NODE_ID:-SIMFORGE_WORKER_NODE_ID-IS-UNSET}"
create_env="$create_env -e SIMFORGE_RENDER_WORKER_TOKEN=${WORKER_TOKEN:-SIMFORGE_RENDER_WORKER_TOKEN-IS-UNSET}"
create_env="$create_env -e SIMFORGE_SOURCE_REVISION=${SOURCE_REVISION:-SIMFORGE_SOURCE_REVISION-IS-UNSET}"
create_env="$create_env -e SIMFORGE_GPU_MODEL=NVIDIA_GeForce_RTX_3090"
create_env="$create_env -e SIMFORGE_GPU_MEMORY_MIB_MIN=$MIN_TOTAL_VRAM_MIB"
create_env="$create_env -e SIMFORGE_IMAGE_DIGEST=${image_digest:-unresolved}"
create_env="$create_env -e SIMFORGE_BASE_IMAGE=$CARLA_BASE_IMAGE"
create_env="$create_env -e SIMFORGE_BASE_IMAGE_DIGEST=$CARLA_BASE_INDEX_DIGEST"
create_env="$create_env -e SIMFORGE_BASE_IMAGE_PLATFORM_DIGEST=$CARLA_BASE_PLATFORM_DIGEST"
create_env="$create_env -e AWS_DEFAULT_REGION=$AWS_ARTIFACT_REGION"
create_env="$create_env -e AWS_ACCESS_KEY_ID=$aws_access_key"
create_env="$create_env -e AWS_SECRET_ACCESS_KEY=$aws_secret_key"
create_env="$create_env -p ${CARLA_RPC_PORT}:${CARLA_RPC_PORT}"

redacted_env="${create_env/$aws_secret_key/<AWS_SECRET_ACCESS_KEY redacted>}"
redacted_env="${redacted_env/$aws_access_key/<AWS_ACCESS_KEY_ID redacted>}"
if [ -n "$WORKER_TOKEN" ]; then
  redacted_env="${redacted_env/$WORKER_TOKEN/<SIMFORGE_RENDER_WORKER_TOKEN redacted>}"
fi

login_arg="-u AWS -p <ECR_TOKEN redacted> $ECR_REGISTRY"

print_create_command() {
  local env_str="$1" login_str="$2"
  printf '%s create instance %s \\\n' "$VAST_BIN" "$offer_id"
  printf "  --image '%s' \\\\\n" "$CARLA_IMAGE"
  printf "  --login '%s' \\\\\n" "$login_str"
  printf '  --disk %s \\\n' "$DISK_GB"
  printf "  --env '%s' \\\\\n" "$env_str"
  printf '  --ssh --direct \\\n'
  printf "  --label '%s' \\\\\n" "$VAST_LABEL"
  printf '  --onstart %s \\\n' "$(onstart_file)"
  printf '  --cancel-unavail --raw\n'
}

# --- 7. the plan -----------------------------------------------------------
rule
printf 'chosen offer (cheapest of %s qualifying, ordered by dph_total)\n' "$count"
rule
printf '  offer id          %s (machine %s)\n' "$offer_id" "$machine"
printf '  gpu               RTX 3090 x1, advertised gpu_ram %s MiB\n' "$gpu_ram"
printf '  driver            %s (>= %s required by CARLA 0.10.0), cuda_max_good %s\n' "$driver" "$MIN_DRIVER" "$cuda"
printf '  disk available    %.1f GB (renting %s GB)\n' "$disk_avail" "$DISK_GB"
printf '  hourly            $%.4f/hr total at %s GiB storage (storage $%.3f/GB/mo)\n' "$dph" "$DISK_GB" "$storage_cost"
printf '  network           %.0f Mb/s down at $%.5f/GB; up $%.5f/GB\n' "$inet_down" "$inet_down_cost" "$inet_up_cost"
printf '  location          %s, %s, reliability %.4f\n' "$geo" "$verif" "$reliability"
rule
printf 'image (dev)\n'
printf '  ref               %s\n' "$CARLA_IMAGE"
printf '  digest            %s\n' "${image_digest:-unresolved}"
printf '  transfer size     %s bytes (%s GB compressed)\n' "$image_bytes" "$image_gb"
rule
printf 'cost model\n'
printf '  image pull        %s GB x $%.5f/GB = $%s, ~%s s at %.0f Mb/s\n' \
  "$image_gb" "$inet_down_cost" "$pull_cost" "$pull_sec" "$inet_down"
printf '  one render        %s ticks x %s s/tick + %s s startup = %s s -> $%s\n' \
  "$RENDER_TICKS" "$CARLA_SEC_PER_TICK" "$CARLA_STARTUP_SEC" "$render_sec" "$render_cost"
printf '                    (measured two-camera 1080p, carla-on-3080-handoff.md:159,225)\n'
printf '  first render all-in (pull + pull time + render) = $%s\n' "$total_first"
printf '  account credit    $%.2f\n' "$credit"
rule
printf 'create command (secrets redacted in this listing; the real run substitutes them)\n'
rule
print_create_command "$redacted_env" "$login_arg"
rule
# --- dev registration readiness (CloudGate's contract) ---------------------
# Report it in plan mode, enforce it before renting: an instance that cannot
# register is $0.18/hr of nothing.
printf 'dev registration contract\n'
reg_ready=1
reg_row() {
  if [ -n "$2" ]; then printf '  %-26s %s\n' "$1" "$3"
  else printf '  %-26s MISSING — %s\n' "$1" "$3"; reg_ready=0; fi
}
reg_row "SIMFORGE_API_BASE_URL"  "$API_BASE_URL"   "${API_BASE_URL:-set it to the dev Studio origin}"
reg_row "SIMFORGE_WORKER_NODE_ID" "$WORKER_NODE_ID" "${WORKER_NODE_ID:-Studio worker-node id; sent as x-simforge-worker-node-id and matched server-side}"
reg_row "SIMFORGE_RENDER_WORKER_TOKEN" "$WORKER_TOKEN" "$([ -n "$WORKER_TOKEN" ] && echo '<redacted, present>' || echo 'bearer token read via tokenEnv')"
if is_commit_sha "$SOURCE_REVISION"; then
  printf '  %-26s %s\n' "SIMFORGE_SOURCE_REVISION" "$SOURCE_REVISION"
else
  printf '  %-26s %s\n' "SIMFORGE_SOURCE_REVISION" \
    "${SOURCE_REVISION:+INVALID ($SOURCE_REVISION) — }${SOURCE_REVISION:-MISSING — }40-hex commit the image was built from; the engine refuses to start without it"
  reg_ready=0
fi
if is_digest "${image_digest:-}"; then
  printf '  %-26s %s\n' "imageDigest" "$image_digest"
else
  printf '  %-26s %s\n' "imageDigest" "unresolved — the register labels need sha256:<64hex>"; reg_ready=0
fi
printf '  %-26s %s\n' "gpuMemoryMiB floor" "$MIN_TOTAL_VRAM_MIB (24576 nominal minus driver reserve; verified on the instance, not from the offer)"
printf '  %-26s %s\n' "baseImage" "$CARLA_BASE_IMAGE"
printf '  %-26s %s\n' "baseImageDigest" "$CARLA_BASE_INDEX_DIGEST"
printf '  %-26s %s\n' "baseImagePlatformDigest" "$CARLA_BASE_PLATFORM_DIGEST"
printf '  %-26s %s\n' "dev migration" "studio/migrations/20260917130000_simforge_rtx3090_render_worker_profile.sql must be applied on dev or the profile insert fails the hardware_profile check constraint"
if image_can_drain "$CARLA_IMAGE"; then
  printf '  %-26s %s\n' "image can drain a job" "assumed yes (not a known pre-change tag)"
else
  printf '  %-26s %s\n' "image CANNOT drain" "$IMAGE_BLOCK_REASON"
  printf '  %-26s %s\n' "" "pass --image with a tag built from this branch (SOURCE_REVISION baked in)"
  reg_ready=0
fi
printf '  %-26s %s\n' "worker config" "onstart renders /config/worker.json (workerId, control.kind=http, tokenEnv, labels.*), reading gpuMemoryMiB from nvidia-smi and refusing to write a config the card cannot back"
rule

# Well-formedness proof that costs nothing: vast's own argparse definition
# accepts (or rejects) this argv, and the command function is never reached.
VAST_VENV_PY="${VAST_VENV_PY:-/home/ubuntu/.local/share/pipx/venvs/vastai/bin/python}"
if [ -x "$VAST_VENV_PY" ]; then
  printf 'create command validated against vastai %s argparse (no API call):\n' "$VAST_EXPECTED_VERSION"
  if "$VAST_VENV_PY" "$HERE/validate-create-args.py" \
      create instance "$offer_id" \
      --image "$CARLA_IMAGE" --login "$login_arg" --disk "$DISK_GB" \
      --env "$redacted_env" --ssh --direct --label "$VAST_LABEL" \
      --onstart "$(onstart_file)" --cancel-unavail --raw; then
    printf '  OK — argv parses as create__instance\n'
  else
    die "the create command is malformed (vast argparse rejected it)"
  fi
  rule
fi

if [ "$CONFIRM" -ne 1 ]; then
  printf 'PLAN ONLY — nothing was created and no credit was spent.\n'
  if [ "$reg_ready" -eq 1 ]; then
    printf 'The dev registration contract is fully satisfied; --confirm will rent.\n'
  else
    printf 'Re-run with --confirm once the MISSING registration values above are set.\n'
  fi
  exit 0
fi

# --- 8. rent -------------------------------------------------------------
[ -n "$API_BASE_URL" ] || die "SIMFORGE_API_BASE_URL must be set to the dev control plane for --confirm"
[ "$reg_ready" -eq 1 ] || die "the dev registration contract is incomplete (see the MISSING rows above); the worker would fail to register"
[ "${ssh_keys:-0}" -gt 0 ] || die "register an ssh key with vast before renting (see warning above)"

info "requesting ECR login token ($ECR_REGION)"
ecr_token="$(aws_sf --region "$ECR_REGION" ecr get-login-password)" || die "ECR login failed"
[ -n "$ecr_token" ] || die "empty ECR token"

info "creating instance from offer $offer_id"
created="$(vast create instance "$offer_id" \
  --image "$CARLA_IMAGE" \
  --login "-u AWS -p $ecr_token $ECR_REGISTRY" \
  --disk "$DISK_GB" \
  --env "$create_env" \
  --ssh --direct \
  --label "$VAST_LABEL" \
  --onstart "$(onstart_file)" \
  --cancel-unavail --raw)"
printf '%s\n' "$created"

new_id="$(jq -r '.new_contract // .id // empty' <<<"$created" 2>/dev/null || true)"
[ -n "$new_id" ] || die "create returned no instance id: $created"

# Record before anything else can fail, so teardown always has the id.
printf '%s\n' "$new_id" >> "$(created_ledger)"
jq -n --argjson offer "$offer" \
      --arg id "$new_id" --arg label "$VAST_LABEL" --arg image "$CARLA_IMAGE" \
      --arg digest "${image_digest:-unresolved}" --arg profile "$HARDWARE_PROFILE" \
      --arg api "$API_BASE_URL" --arg bucket "$DEV_ARTIFACT_BUCKET" \
      --arg created "$(date -u +%FT%TZ)" --argjson disk "$DISK_GB" \
      --arg node "$WORKER_NODE_ID" --arg rev "$SOURCE_REVISION" \
      --arg base "$CARLA_BASE_IMAGE" --arg basedig "$CARLA_BASE_INDEX_DIGEST" \
      --arg baseplat "$CARLA_BASE_PLATFORM_DIGEST" --argjson vramfloor "$MIN_TOTAL_VRAM_MIB" \
      '{instance_id:($id|tonumber), label:$label, image:$image, image_digest:$digest,
        hardware_profile:$profile, environment:"dev", api_base_url:$api,
        artifact_bucket:$bucket, disk_gb:$disk, created_at:$created,
        registration:{worker_node_id:$node, source_revision:$rev,
                      gpu_memory_mib_floor:$vramfloor, base_image:$base,
                      base_image_digest:$basedig, base_image_platform_digest:$baseplat},
        offer:{id:$offer.id, machine_id:$offer.machine_id, dph_total:$offer.dph_total,
               driver_version:$offer.driver_version, gpu_ram:$offer.gpu_ram,
               inet_down:$offer.inet_down, inet_down_cost:$offer.inet_down_cost,
               geolocation:$offer.geolocation}}' > "$(state_file)"
info "recorded instance $new_id in $(state_file)"

# --- 9. wait for it to come up --------------------------------------------
deadline=$(( $(date +%s) + 1800 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  snap="$(instance_json "$new_id")"
  status="$(jq -r '.actual_status // .cur_state // "pending"' <<<"${snap:-{\}}")"
  printf 'status=%s\n' "$status" >&2
  [ "$status" = "running" ] && break
  case "$status" in
    exited|offline) log "instance is $status; check: $VAST_BIN logs $new_id" ;;
  esac
  sleep 20
done

snap="$(instance_json "$new_id")"
printf '%s\n' "$snap" | jq '{id, actual_status, label, dph_total, ssh_host, ssh_port, machine_id, gpu_name}' 2>/dev/null || true
printf 'next: %s/verify-instance.sh\n' "$HERE"
printf 'when done: %s/teardown-3090.sh\n' "$HERE"
