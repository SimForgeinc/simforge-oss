#!/bin/bash
# Destroy the rented RTX 3090, confirm it is gone, and report what it cost.
#
# Safe to run twice: a second run finds no instance, says so, still reports the
# cost, and exits 0. It will only ever destroy an id recorded by
# provision-3090.sh whose label matches ours — never a stranger's instance, and
# never another agent's.
#
# Usage:
#   teardown-3090.sh                  # destroy the recorded instance
#   teardown-3090.sh --instance-id N  # explicit; must still be in our ledger
#   teardown-3090.sh --dry-run        # print what would be destroyed, spend nothing

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "$HERE/common.sh"

INSTANCE_ID=""
DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --instance-id) INSTANCE_ID="${2:?--instance-id needs a value}"; shift 2 ;;
    --dry-run)     DRY_RUN=1; shift ;;
    --state-dir)   STATE_DIR="${2:?--state-dir needs a value}"; shift 2 ;;
    -h|--help)     sed -n '2,13p' "$0"; exit 0 ;;
    *)             die "unknown argument: $1" ;;
  esac
done

assert_vast_ready

if [ -z "$INSTANCE_ID" ]; then
  if ! INSTANCE_ID="$(recorded_instance_id)"; then
    printf 'no instance recorded in %s — nothing to tear down.\n' "$(state_file)"
    exit 0
  fi
fi

was_created_by_us "$INSTANCE_ID" || \
  die "instance $INSTANCE_ID is not in $(created_ledger); refusing to destroy an instance this tooling did not create"

# --- cost, from the two sources that exist --------------------------------
# 1. vast's own invoice lines, keyed by instance_id. Authoritative, but they are
#    posted on a delay, so a just-destroyed instance may not appear yet.
# 2. uptime x dph_total, computed from the instance record. Available instantly.
report_cost() {
  local id="$1" snap="$2"
  local invoiced
  invoiced="$(vast show invoices --raw 2>/dev/null \
    | jq -r --argjson id "$id" '[.[]? | select((.instance_id? // -1) == $id) | (.amount|tonumber?) // 0] | add // 0' 2>/dev/null)"
  printf 'cost\n'
  printf '  invoiced by vast  $%s (charges for instance %s; vast posts these on a delay)\n' "${invoiced:-0}" "$id"
  if [ -n "$snap" ]; then
    local dph start now
    dph="$(jq -r '.dph_total // 0' <<<"$snap")"
    start="$(jq -r '.start_date // 0' <<<"$snap")"
    now="$(date +%s)"
    if [ "${start%.*}" -gt 0 ] 2>/dev/null; then
      awk -v s="${start%.*}" -v n="$now" -v d="$dph" 'BEGIN{
        h=(n-s)/3600; printf "  uptime x rate     %.3f h x $%.4f/hr = $%.4f\n", h, d, h*d}'
    else
      printf '  uptime x rate     start_date unavailable on the instance record\n'
    fi
  else
    local h d
    h="$(jq -r '.uptime_hours // empty' "$(state_file)" 2>/dev/null || true)"
    d="$(jq -r '.offer.dph_total // empty' "$(state_file)" 2>/dev/null || true)"
    if [ -n "$h" ] && [ -n "$d" ]; then
      awk -v h="$h" -v d="$d" 'BEGIN{printf "  uptime x rate     %.3f h x $%.4f/hr = $%.4f (recorded at teardown)\n", h, d, h*d}'
    else
      printf '  uptime x rate     instance record gone; rely on the invoice line above\n'
    fi
  fi
  printf '  credit now        $%.4f\n' "$(vast_credit)"
}

snap="$(instance_json "$INSTANCE_ID")"

if [ -z "$snap" ]; then
  rule
  printf 'instance %s does not exist — already destroyed. Nothing to do.\n' "$INSTANCE_ID"
  rule
  report_cost "$INSTANCE_ID" ""
  # Keep the ledger (it is the record of what we created) but drop the live
  # pointer so provisioning and verification do not chase a dead id.
  [ -f "$(state_file)" ] && mv "$(state_file)" "$(state_file).destroyed" || true
  exit 0
fi

label="$(jq -r '.label // ""' <<<"$snap")"
[ "$label" = "$VAST_LABEL" ] || \
  die "instance $INSTANCE_ID carries label '$label', not '$VAST_LABEL'; refusing to destroy it"

status="$(jq -r '.actual_status // .cur_state // "unknown"' <<<"$snap")"
dph="$(jq -r '.dph_total // 0' <<<"$snap")"
start="$(jq -r '.start_date // 0' <<<"$snap")"
rule
printf 'about to destroy instance %s (status=%s, label=%s, $%s/hr)\n' "$INSTANCE_ID" "$status" "$label" "$dph"
printf 'command: %s destroy instance %s -y --raw\n' "$VAST_BIN" "$INSTANCE_ID"
rule

if [ "$DRY_RUN" -eq 1 ]; then
  report_cost "$INSTANCE_ID" "$snap"
  printf 'DRY RUN — the instance is still running and still billing.\n'
  exit 0
fi

# Freeze the uptime figure before the record disappears.
if [ "${start%.*}" -gt 0 ] 2>/dev/null && [ -f "$(state_file)" ]; then
  hours="$(awk -v s="${start%.*}" -v n="$(date +%s)" 'BEGIN{printf "%.6f", (n-s)/3600}')"
  tmp="$(mktemp)"
  jq --argjson h "$hours" '. + {uptime_hours:$h}' "$(state_file)" > "$tmp" && mv "$tmp" "$(state_file)"
fi

info "destroying instance $INSTANCE_ID"
vast destroy instance "$INSTANCE_ID" -y --raw || die "destroy call failed for $INSTANCE_ID"

# Confirm, rather than trust the call.
gone=0
for attempt in $(seq 1 15); do
  if [ -z "$(instance_json "$INSTANCE_ID")" ]; then gone=1; break; fi
  info "instance still listed (attempt $attempt/15); waiting"
  sleep 8
done

rule
if [ "$gone" -eq 1 ]; then
  printf 'instance %s destroyed and confirmed gone.\n' "$INSTANCE_ID"
else
  printf 'WARNING: instance %s is still listed after destroy. It may still bill.\n' "$INSTANCE_ID"
  printf 'Check manually: %s show instance %s\n' "$VAST_BIN" "$INSTANCE_ID"
fi
rule
report_cost "$INSTANCE_ID" ""
[ -f "$(state_file)" ] && mv "$(state_file)" "$(state_file).destroyed" || true
printf 'state archived to %s.destroyed; ledger %s keeps the created-id history.\n' "$(state_file)" "$(created_ledger)"
[ "$gone" -eq 1 ] || exit 1
