#!/usr/bin/env bash
set -euo pipefail
set +x
set -a
source "$HOME/.config/typesafe/env"
set +a
export PYTHONPATH="/home/path/tmp/jevdrive${PYTHONPATH:+:$PYTHONPATH}"
exec /home/path/tmp/jevdrive/.venv/bin/python -m jevdrive "$@"
