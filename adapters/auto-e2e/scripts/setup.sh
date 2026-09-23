#!/usr/bin/env bash
# Provision the isolated AutoE2E runtime and verify the local Best_Model.pt.
#
#   scripts/setup.sh [--checkpoint PATH] [--python PYTHON] [--skip-install]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR="$ROOT/vendor/auto_e2e"
VENV="$ROOT/.venv"
PYTHON="${SIMFORGE_AUTO_E2E_PYTHON:-python3}"
CHECKPOINT="${SIMFORGE_AUTO_E2E_CHECKPOINT:-${SIMFORGE_ASSETS_ROOT:-$HOME/simforge-assets}/models/auto-e2e/Best_Model.pt}"
SKIP_INSTALL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --checkpoint) CHECKPOINT="${2:?--checkpoint needs a path}"; shift 2 ;;
    --python) PYTHON="${2:?--python needs an executable}"; shift 2 ;;
    --skip-install) SKIP_INSTALL=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

UPSTREAM_REPO="https://github.com/autowarefoundation/auto_e2e.git"
UPSTREAM_COMMIT="31b83bf051564816739805c8295da4fb1e5ee287"
EXPECTED_SHA256="6b84fd94af47aa20c8e9005663be6eb2c5c13a61b453b02d731f298ed0572c0c"

mkdir -p "$(dirname "$CHECKPOINT")"
if [ ! -f "$CHECKPOINT" ]; then
  echo "checkpoint missing: $CHECKPOINT" >&2
  echo "copy Best_Model.pt from the authorized model host or set --checkpoint" >&2
  exit 1
fi
ACTUAL_SHA256="$(sha256sum "$CHECKPOINT" | cut -d' ' -f1)"
if [ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]; then
  echo "checkpoint sha256 mismatch: expected $EXPECTED_SHA256, got $ACTUAL_SHA256" >&2
  exit 1
fi

if [ ! -d "$VENDOR/.git" ]; then
  git clone "$UPSTREAM_REPO" "$VENDOR"
fi
git -C "$VENDOR" fetch --quiet origin "$UPSTREAM_COMMIT"
git -C "$VENDOR" checkout --quiet "$UPSTREAM_COMMIT"

if [ "$SKIP_INSTALL" -eq 0 ]; then
  if command -v uv >/dev/null 2>&1; then
    uv venv --python "$PYTHON" --allow-existing "$VENV"
    # Keep the family isolated, but do not reinstall an existing CUDA torch
    # wheel when the environment already provides one.
    VIRTUAL_ENV="$VENV" uv pip install --upgrade pip msgpack numpy pillow
    if ! VIRTUAL_ENV="$VENV" uv pip show timm >/dev/null 2>&1; then
      VIRTUAL_ENV="$VENV" uv pip install "timm==1.0.27"
    fi
  else
    if [ ! -x "$VENV/bin/python" ]; then "$PYTHON" -m venv "$VENV"; fi
    "$VENV/bin/python" -m pip install --upgrade pip
    "$VENV/bin/python" -m pip install msgpack numpy pillow "timm==1.0.27"
  fi
fi

cat <<EOF
AutoE2E setup complete
  upstream : $UPSTREAM_REPO@$UPSTREAM_COMMIT
  vendor   : $VENDOR
  python   : $VENV/bin/python
  checkpoint: $CHECKPOINT
  sha256   : $ACTUAL_SHA256
  serve    : scripts/run_server.sh --checkpoint "$CHECKPOINT" --socket /tmp/simforge-auto-e2e.sock
EOF
