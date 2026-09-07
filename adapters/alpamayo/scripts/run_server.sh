#!/usr/bin/env bash
# Start an Alpamayo policy endpoint for one family from a development
# (scripts/setup.sh) checkout.
#
#   scripts/run_server.sh --family alpamayo-1.5 [--quant nf4] \
#       [--socket PATH] [--http 127.0.0.1:9310] [--warmup-cams N]
#
# The family selects both the venv and the vendored upstream package, because
# the three families pin incompatible dependency sets and can never share a
# process. Every other flag is forwarded to simforge_alpamayo.server.
#
# For an installed (product) model, prefer the endpoint command the model
# store records, which additionally pins --weights-dir, --sidecar-dir and
# --checkpoint-digest so the process refuses to serve the wrong checkpoint.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

FAMILY=""
ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --family) FAMILY="${2:-}"; ARGS+=("$1" "$2"); shift 2 ;;
    *) ARGS+=("$1"); shift ;;
  esac
done
if [ -z "$FAMILY" ]; then
  echo "--family is required (alpamayo-1 | alpamayo-1.5 | alpamayo-2-super)" >&2
  exit 1
fi

VENDOR_DIR="$(PYTHONPATH="$ROOT/src" python3 -c "
from simforge_alpamayo.families import get_family
print(get_family('$FAMILY').vendor_dir)
")"
VENDOR="$ROOT/vendor/$VENDOR_DIR"
if [ ! -x "$VENDOR/.venv/bin/python" ]; then
  echo "no environment for $FAMILY at $VENDOR/.venv" >&2
  echo "run: scripts/setup.sh --family $FAMILY" >&2
  exit 1
fi

export HF_HOME="${HF_HOME:-${SIMFORGE_ASSETS_ROOT:-$HOME/simforge-assets}/hf-cache}"
export PYTHONPATH="$ROOT/src:$VENDOR/src${PYTHONPATH:+:$PYTHONPATH}"
exec "$VENDOR/.venv/bin/python" -m simforge_alpamayo.server "${ARGS[@]}"
