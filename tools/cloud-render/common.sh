#!/bin/bash
# Shared configuration and helpers for the rented RTX 3090 CARLA render worker.
#
# Sourced by provision-3090.sh, verify-instance.sh and teardown-3090.sh. Holds
# nothing but configuration, evidence-carrying constants and pure helpers; every
# side effect lives in the three entry-point scripts.
#
# Environment: DEV only. The control plane the worker registers against and the
# storage it uploads to are dev; nothing here may point at staging or prod.

set -euo pipefail

# --- binaries --------------------------------------------------------------

VAST_BIN="${VAST_BIN:-/home/ubuntu/.local/bin/vastai}"
AWS_BIN="${AWS_BIN:-aws}"

# vast.ai search/create/destroy syntax was read off vastai 1.5.4
# (cli/commands/instances.py:201-268, cli/commands/offers.py:29-163). Any other
# major version may have moved the flags, so pin the expectation.
VAST_EXPECTED_VERSION="${VAST_EXPECTED_VERSION:-1.5.4}"

# --- AWS (dev) -------------------------------------------------------------

export AWS_CONFIG_FILE="${AWS_CONFIG_FILE:-/home/ubuntu/.aws/config}"
export AWS_SHARED_CREDENTIALS_FILE="${AWS_SHARED_CREDENTIALS_FILE:-/home/ubuntu/.aws/credentials}"
AWS_PROFILE_NAME="${AWS_PROFILE_NAME:-simforge}"
# Artifact storage lives in us-west-2; the container registry is us-east-1.
AWS_ARTIFACT_REGION="${AWS_ARTIFACT_REGION:-us-west-2}"
ECR_REGION="${ECR_REGION:-us-east-1}"
ECR_REGISTRY="${ECR_REGISTRY:-435362779479.dkr.ecr.us-east-1.amazonaws.com}"
# DEV bucket. `aws s3api list-buckets` (profile simforge) lists
# simforge-uniscenario-dev / -staging / -prod; dev is the only writable target.
DEV_ARTIFACT_BUCKET="${DEV_ARTIFACT_BUCKET:-simforge-uniscenario-dev}"

# --- instance image (dev) --------------------------------------------------
#
# The instance image *is* the container vast runs; there is no docker-in-docker
# pull step on the host. So the render-worker image has to be a registry ref.
#
# Evidence for this default (all read live from ECR on 2026-09-17):
#   repo   simcloud-carla-worker-dev  (us-east-1, account 435362779479)
#   tag    rtx3080-pronto-642b9c5557a7, pushed 2026-08-23T22:44:05Z
#   index  sha256:6d5b857805c1d29444734e38a9a6f2aa22d9c95601e200a0b48ef63d5ad22967
#   amd64  sha256:d5b4bf12f84c709d1f897bbe9bbad0367eaf6da5b1d222dc3b855fddf769ed96
#   size   28,832,667,435 bytes of compressed layers
#   env    UNISCENARIOS_CARLA_IMAGE_MANIFEST_SHA256=baed0d03...a648de64 — the same
#          CARLA 0.10.0 base manifest pinned by
#          services/render-worker/docker/carla.Dockerfile:24, i.e. the engine we
#          measured at 0.431 s/tick on ws2
#   label  ai.simforge.hardware-profile=rtx3080-10gb-v1  <- baked for a 3080; the
#          runtime profile must be overridden at create time (see HARDWARE_PROFILE)
#   env    NVIDIA_DRIVER_CAPABILITIES=compute,graphics,utility <- overridden to
#          `all` at create time for the Vulkan path
#
# The locally built `simforge-carla-runtime:0.1.0-rc.54` (21,547,493,721 bytes on
# ws2, RepoDigests `simforge-carla-runtime@sha256:440bb09f...`) is NOT in any
# registry, so it cannot be used as a vast instance image without a push first.
CARLA_IMAGE="${CARLA_IMAGE:-435362779479.dkr.ecr.us-east-1.amazonaws.com/simcloud-carla-worker-dev:rtx3080-pronto-642b9c5557a7}"
# Fallback transfer size if ECR cannot be reached; overridden live when it can.
CARLA_IMAGE_BYTES_FALLBACK="${CARLA_IMAGE_BYTES_FALLBACK:-28832667435}"
# The CARLA 0.10.0 base manifest digest the image must carry (Dockerfile:24,46).
CARLA_BASE_MANIFEST_SHA256="${CARLA_BASE_MANIFEST_SHA256:-baed0d038437c55efe0abe52a762d352aeb21acdeeff5b11a15f6bd8a648de64}"

# Images that are known NOT to be able to drain a job, whatever env is passed.
# CloudGate: the 2026-08-23 dev tags bake the pre-change worker, whose transport
# posts to /v2/workers/register and /v2/jobs/claim — paths the Studio app has
# never served (404/401, never a lease) — and they carry no baked
# SIMFORGE_SOURCE_REVISION. The plan still prints a concrete command against the
# default so the market and cost model can be inspected, but renting is refused
# until a tag built from this branch is supplied via --image / CARLA_IMAGE.
IMAGE_BLOCK_PATTERN="${IMAGE_BLOCK_PATTERN:-:rtx3080-pronto-}"
IMAGE_BLOCK_REASON="${IMAGE_BLOCK_REASON:-pre-change worker: posts /v2/jobs/claim, which Studio never served, and bakes no SIMFORGE_SOURCE_REVISION}"

image_can_drain() {
  case "${1:-}" in
    *"$IMAGE_BLOCK_PATTERN"*) return 1 ;;
    *) return 0 ;;
  esac
}

# --- fleet identity --------------------------------------------------------

# Contract string for the rented card. The fleet gate in
# studio/app/lib/scenario/render-worker-control-store.ts:115 must admit this
# prefix (CloudGate's change); provisioning must never lie about the hardware.
HARDWARE_PROFILE="${HARDWARE_PROFILE:-rtx3090-24gb-v1}"
# Label stamped on the instance. Teardown refuses any instance whose label does
# not match, so this is a safety device as much as a name.
VAST_LABEL="${VAST_LABEL:-simforge-render-${HARDWARE_PROFILE}-dev}"
# Public key attached to the instance when the account cannot hold one (team
# accounts cannot: vast rejects account-level keys outside personal context).
SSH_PUBKEY_PATH="${SSH_PUBKEY_PATH:-$HOME/.ssh/id_rsa.pub}"

# --- offer selection -------------------------------------------------------

# CARLA 0.10.0 needs driver >= 550; vast accepts the filter server-side but the
# comparison needs all three components (vastai/api/query.py:13-32).
MIN_DRIVER="${MIN_DRIVER:-550.0.0}"
DISK_GB="${DISK_GB:-200}"
# Real free VRAM the card must show. One 3090 offer on the market advertises
# gpu_ram=20480, so the advertised figure is not load-bearing; this floor is
# checked against nvidia-smi on the instance, not against the offer.
MIN_FREE_VRAM_MIB="${MIN_FREE_VRAM_MIB:-20000}"
VAST_QUERY="${VAST_QUERY:-gpu_name=RTX_3090 num_gpus=1 rentable=true rented=false disk_space>=${DISK_GB} driver_version>=${MIN_DRIVER}}"

# --- dev registration contract (from CloudGate, verified by its register+lease
#     test) ----------------------------------------------------------------
# The register route rejects a board that cannot back the profile it claims:
# gpuMemoryMiB must be >= 24576 nominal minus the driver reserve, so the 3090
# offer that advertises 20480 MiB cannot register as a 3090. Checked against
# nvidia-smi total, not against the offer.
MIN_TOTAL_VRAM_MIB="${MIN_TOTAL_VRAM_MIB:-23961}"
# The CARLA base image the control plane approves, all three values exact.
CARLA_BASE_IMAGE="${CARLA_BASE_IMAGE:-ghcr.io/simforgeinc/carla-rfs-munich-belmont:0.10.0-kia}"
# Index digest (carla.Dockerfile:56) and platform manifest digest (:57, :24).
CARLA_BASE_INDEX_DIGEST="${CARLA_BASE_INDEX_DIGEST:-sha256:f17c639e5f86fd7458fe1d02d3be1d481deeaa714f3cac30e465187d04ec90e5}"
CARLA_BASE_PLATFORM_DIGEST="${CARLA_BASE_PLATFORM_DIGEST:-sha256:baed0d038437c55efe0abe52a762d352aeb21acdeeff5b11a15f6bd8a648de64}"
# The engine refuses to start without this, and it is the engine version the
# control plane approves (40-hex commit, set from the SOURCE_REVISION build arg
# at carla.Dockerfile:25,28). No default: inventing a commit would be a lie
# about what the image was built from.
SOURCE_REVISION="${SIMFORGE_SOURCE_REVISION:-}"
# Worker-node id issued by Studio; the transport sends it as
# x-simforge-worker-node-id and the register route rejects a mismatch.
WORKER_NODE_ID="${SIMFORGE_WORKER_NODE_ID:-}"
# Bearer token env name the worker control transport reads (tokenEnv).
WORKER_TOKEN="${SIMFORGE_RENDER_WORKER_TOKEN:-}"

# --- measured cost model ---------------------------------------------------
# artifacts/production-scenarios/carla-on-3080-handoff.md:159 (two-camera 1080p,
# scenario uscn_e6e24608e08c48faa846f525) and :225 (startup share of a run).
CARLA_SEC_PER_TICK="${CARLA_SEC_PER_TICK:-0.431}"
CARLA_STARTUP_SEC="${CARLA_STARTUP_SEC:-41}"
RENDER_TICKS="${RENDER_TICKS:-1001}"

# --- engine bring-up (from carla-on-3080-handoff.md:42-59) -----------------
CARLA_RPC_PORT="${CARLA_RPC_PORT:-2000}"
ENGINE_LAUNCH_ATTEMPTS="${ENGINE_LAUNCH_ATTEMPTS:-8}"
READY_POLLS="${READY_POLLS:-30}"
READY_POLL_SECONDS="${READY_POLL_SECONDS:-10}"
# Never lower this: -quality-level=Low drops the assets the spawn-height probe
# raycasts against, so it breaks spawning instead of saving VRAM (handoff §3).
CARLA_QUALITY="${CARLA_QUALITY:-Epic}"

# --- state -----------------------------------------------------------------
# The created instance id is recorded here so verification and teardown need no
# manual copying, and so teardown can refuse ids this tooling did not create.
STATE_DIR="${STATE_DIR:-${HOME}/.simforge/vast-3090}"
state_file()      { printf '%s/instance.json' "$STATE_DIR"; }
created_ledger()  { printf '%s/created-ids.txt' "$STATE_DIR"; }
onstart_file()    { printf '%s/onstart.sh' "$STATE_DIR"; }
report_file()     { printf '%s/verify-report.json' "$STATE_DIR"; }

# --- output helpers --------------------------------------------------------

log()  { printf '%s\n' "$*" >&2; }
info() { printf '[%s] %s\n' "$(date -u +%H:%M:%SZ)" "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }
rule() { printf '%s\n' "------------------------------------------------------------------"; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

vast() { "$VAST_BIN" "$@"; }

aws_sf() {
  "$AWS_BIN" --profile "$AWS_PROFILE_NAME" "$@"
}

# --- pure helpers ----------------------------------------------------------

# is_commit_sha <value> — the 40-hex commit the control plane approves as the
# CARLA engine version (control-plane-store.ts:232).
is_commit_sha() { printf '%s' "${1:-}" | grep -Eqx '[0-9a-f]{40}'; }

# is_digest <value> — sha256:<64 hex>, the imageDigest label shape.
is_digest() { printf '%s' "${1:-}" | grep -Eqx 'sha256:[0-9a-f]{64}'; }

# driver_ge <found> <minimum> — numeric three-component comparison. vast's own
# filter is server-side; this re-checks what the instance actually reports.
driver_ge() {
  awk -v a="$1" -v b="$2" 'BEGIN{
    na=split(a,A,"."); nb=split(b,B,".");
    for(i=1;i<=3;i++){x=(i<=na?A[i]+0:0); y=(i<=nb?B[i]+0:0);
      if(x>y){print "yes"; exit} if(x<y){print "no"; exit}}
    print "yes"}' | grep -qx yes
}

assert_vast_ready() {
  require_cmd jq
  [ -x "$VAST_BIN" ] || die "vastai CLI not executable at $VAST_BIN"
  local have
  have="$(vast --version 2>/dev/null | tr -d '[:space:]')"
  [ "$have" = "$VAST_EXPECTED_VERSION" ] || \
    log "warning: vastai $have, flags were read from $VAST_EXPECTED_VERSION — re-check create arguments"
  vast show user --raw >/dev/null 2>&1 || die "vastai is not authenticated (vastai set api-key ...)"
}

vast_credit() { vast show user --raw | jq -r '.credit // 0'; }

# instance_json <id> — empty output when the instance does not exist. `show
# instance` on a stranger id returns {"instances": null} with exit 0, so the
# absence has to be detected here rather than from the exit code.
instance_json() {
  vast show instance "$1" --raw 2>/dev/null | jq -c 'if type=="object" and (.instances // .id) == null then empty else . end' 2>/dev/null || true
}

recorded_instance_id() {
  [ -f "$(state_file)" ] || return 1
  jq -er '.instance_id' "$(state_file)" 2>/dev/null
}

was_created_by_us() {
  [ -f "$(created_ledger)" ] && grep -qx "$1" "$(created_ledger)"
}

# --- dev guards ------------------------------------------------------------

# Refuse anything that smells like staging or production. The user's constraint
# is that this whole lane targets dev.
assert_dev_target() {
  local url="${1:-}"
  case "$url" in
    *staging*|*stage.*|*prod*|*production*)
      die "refusing non-dev control plane: $url" ;;
  esac
  # Judge the repository, not the tag: a dev-repo image may legitimately record
  # where its CARLA cook came from (`...-dev:carla-cook-from-prod-a457`), while
  # a prod or staging *repository* is refused no matter how it is tagged.
  case "${CARLA_IMAGE%%:*}" in
    *-prod|*-staging|*prod*|*staging*)
      die "refusing non-dev instance image repository: ${CARLA_IMAGE%%:*}" ;;
  esac
  case "$DEV_ARTIFACT_BUCKET" in
    *prod*|*staging*) die "refusing non-dev artifact bucket: $DEV_ARTIFACT_BUCKET" ;;
  esac
}
