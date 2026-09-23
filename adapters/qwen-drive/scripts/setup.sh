#!/usr/bin/env bash
# Prepare the isolated Qwen-Drive adapter environment.
#
#   scripts/setup.sh [--weights] [--model-root DIR] [--python 3.12]
#
# The upstream package is vendored at a fixed commit and is never installed into
# the workspace Python environment. FlashAttention is intentionally omitted:
# the adapter serves the upstream SDPA planner path. Optional --bev perception
# JIT-compiles two CUDA kernels and additionally requires a compatible nvcc.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Pins live in ONE place: simforge_qwen_drive.families (stdlib-only, so the system python reads it).
read_pin() { PYTHONPATH="$ROOT/src" python3 -c "from simforge_qwen_drive import families; print(families.$1)"; }
UPSTREAM_URL="$(read_pin CODE_REPO).git"
UPSTREAM_REV="$(read_pin CODE_REVISION)"
MODEL_REV="$(read_pin MODEL_REVISION)"
MODEL_SOURCE="simforge1:/mnt/nas/a100-data/models/Qwen-Drive-1.0-4B/"
PYTHON="3.12"
FETCH_WEIGHTS=0
MODEL_ROOT="${SIMFORGE_QWEN_MODEL:-${SIMFORGE_ASSETS_ROOT:-$HOME/simforge-assets}/models/qwen-drive/$MODEL_REV}"

while [ $# -gt 0 ]; do
  case "$1" in
    --weights) FETCH_WEIGHTS=1; shift ;;
    --model-root) MODEL_ROOT="${2:?--model-root requires a directory}"; shift 2 ;;
    --python) PYTHON="${2:?--python requires a version}"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

VENDOR="$ROOT/vendor/Qwen-Drive-1.0-$UPSTREAM_REV"
if [ ! -d "$VENDOR/.git" ]; then
  git clone "$UPSTREAM_URL" "$VENDOR"
fi
git -C "$VENDOR" fetch --quiet origin "$UPSTREAM_REV"
git -C "$VENDOR" checkout --quiet "$UPSTREAM_REV"

if ! command -v uv >/dev/null 2>&1; then
  echo "uv is required (https://docs.astral.sh/uv/)" >&2
  exit 1
fi
uv venv --python "$PYTHON" --allow-existing "$ROOT/.venv"
PY="$ROOT/.venv/bin/python"

# Adapter dependencies and the upstream runtime. No flash-attn build is needed
# because the server's default is --attn-implementation sdpa. Ninja builds the
# optional --bev kernels; CUDA_HOME/nvcc come from the host toolkit.
uv pip install --python "$PY" \
  "msgpack>=1.0" "numpy>=1.24" "pillow>=10.0" \
  "torch>=2.8.0" "torchvision>=0.23.0" \
  "transformers>=5.14.0,<5.15.0" "accelerate>=1.0.0" "safetensors>=0.4.5" \
  "causal-conv1d>=1.6.2" "flash-linear-attention>=0.5.1" "bitsandbytes>=0.46.1" "ninja>=1.11"
uv pip install --python "$PY" --no-deps -e "$VENDOR"
uv pip install --python "$PY" --no-deps -e "$ROOT/../policy-endpoint" -e "$ROOT"

if [ "$FETCH_WEIGHTS" -eq 1 ]; then
  mkdir -p "$MODEL_ROOT"
  rsync -a --info=progress2 "$MODEL_SOURCE" "$MODEL_ROOT/"
fi

cat <<EOF
setup complete
  adapter : $ROOT
  python  : $PY
  upstream: $UPSTREAM_REV
  model   : $MODEL_ROOT
  serve   : scripts/run_server.sh --planner sft --mode direct --socket /tmp/simforge-qwen-drive.sock
EOF
