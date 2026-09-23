#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON="${PYTHON:-python3.12}"
VENV="$ROOT/.venv"
GYM_WHEEL="${SIMFORGE_GYM_WHEEL:-}"

if [ -z "$GYM_WHEEL" ]; then
  for candidate in "$ROOT/../../native/target/wheels/simforge_oss_gym-0.1.0rc61-"*.whl; do
    if [ -f "$candidate" ]; then
      GYM_WHEEL="$candidate"
      break
    fi
  done
fi
if [ -z "$GYM_WHEEL" ] || [ ! -f "$GYM_WHEEL" ]; then
  echo "simforge_oss_gym rc61 wheel is required; set SIMFORGE_GYM_WHEEL=/path/to/simforge_oss_gym-0.1.0rc61-*.whl" >&2
  exit 1
fi

"$PYTHON" -m venv --clear "$VENV"
"$VENV/bin/python" -m pip install --upgrade pip
"$VENV/bin/pip" install --no-deps "$GYM_WHEEL"
"$VENV/bin/pip" install numpy 'gymnasium>=1.1' typesafe-sdk==0.6.0
"$VENV/bin/pip" install --no-deps -e "$ROOT"

echo "jev adapter ready"
echo "  python: $VENV/bin/python"
echo "  service: $VENV/bin/python -m jevdrive serve --port 8766"
echo "  model: jev-1.13.0"
echo "  sdk: typesafe-sdk==0.6.0"
echo "  gym: $GYM_WHEEL"
