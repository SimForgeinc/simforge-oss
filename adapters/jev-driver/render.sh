#!/usr/bin/env bash
set -euo pipefail
ADAPTER_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
export PYTHONPATH="${ADAPTER_ROOT}${PYTHONPATH:+:$PYTHONPATH}"
exec "${PYTHON:-python3}" -m jevdrive.render "$@"
