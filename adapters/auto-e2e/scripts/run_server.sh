#!/usr/bin/env bash
# Start the strict-loaded Best_Model MessagePack endpoint.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="${SIMFORGE_AUTO_E2E_PYTHON:-$ROOT/.venv/bin/python}"
if [ ! -x "$PY" ]; then PY="${SIMFORGE_AUTO_E2E_PYTHON:-python3}"; fi
CHECKPOINT="${SIMFORGE_AUTO_E2E_CHECKPOINT:-${SIMFORGE_ASSETS_ROOT:-$HOME/simforge-assets}/models/auto-e2e/Best_Model.pt}"
VENDOR_MODEL="$ROOT/vendor/auto_e2e/Model"
export PYTHONPATH="$ROOT/src:$ROOT/../policy-endpoint${VENDOR_MODEL:+:$VENDOR_MODEL}${PYTHONPATH:+:$PYTHONPATH}"
exec "$PY" -m simforge_auto_e2e.server --checkpoint "$CHECKPOINT" "$@"
