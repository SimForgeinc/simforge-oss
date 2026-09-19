#!/usr/bin/env bash
set -euo pipefail
export PYTHONPATH="/home/path/tmp/jevdrive${PYTHONPATH:+:$PYTHONPATH}"
exec /home/path/tmp/jevdrive/.venv/bin/python -m jevdrive.render "$@"
