#!/usr/bin/env bash
# Start the isolated Qwen-Drive socket service.
#
#   scripts/run_server.sh --planner sft|rl|PATH --mode direct|reasoning \
#       --socket /tmp/simforge-qwen-drive.sock [--model DIR] [--quant nf4] [--bev]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ ! -x "$ROOT/.venv/bin/python" ]; then
  echo "missing $ROOT/.venv/bin/python; run scripts/setup.sh" >&2
  exit 1
fi
# Pins live in ONE place: simforge_qwen_drive.families (mirrored by the model-store lock).
read_pin() { PYTHONPATH="$ROOT/src" "$ROOT/.venv/bin/python" -c "from simforge_qwen_drive import families; print(families.$1)"; }
MODEL="${SIMFORGE_QWEN_MODEL:-${SIMFORGE_ASSETS_ROOT:-$HOME/simforge-assets}/models/qwen-drive/$(read_pin MODEL_REVISION)}"
VENDOR="$ROOT/vendor/Qwen-Drive-1.0-$(read_pin CODE_REVISION)"
export PYTHONPATH="$ROOT/src:$ROOT/../policy-endpoint:$VENDOR/src${PYTHONPATH:+:$PYTHONPATH}"
ARGS=()
HAS_MODEL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --model) MODEL="${2:?--model requires a directory}"; HAS_MODEL=1; ARGS+=("$1" "$2"); shift 2 ;;
    *) ARGS+=("$1"); shift ;;
  esac
done
if [ "$HAS_MODEL" -eq 0 ]; then ARGS+=(--model "$MODEL"); fi
exec "$ROOT/.venv/bin/python" -m simforge_qwen_drive.server "${ARGS[@]}"
