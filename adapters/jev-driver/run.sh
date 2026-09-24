#!/usr/bin/env bash
set -euo pipefail
set +x
set -a
source "$HOME/.config/typesafe/env"
set +a
JEVDRIVE_HOME="${JEVDRIVE_HOME:-$HOME/tmp/jevdrive}"
export PYTHONPATH="$JEVDRIVE_HOME${PYTHONPATH:+:$PYTHONPATH}"
exec "$JEVDRIVE_HOME/.venv/bin/python" -m jevdrive "$@"
