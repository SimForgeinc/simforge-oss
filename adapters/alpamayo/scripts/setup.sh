#!/usr/bin/env bash
# Development setup for one Alpamayo family: vendor the pinned upstream
# inference code, build an isolated venv from the upstream lockfile, and
# optionally pre-fetch the pinned Hugging Face snapshots.
#
#   scripts/setup.sh --family alpamayo-1.5 [--weights] [--no-quant-extras]
#
# The three upstream repositories pin mutually incompatible dependency sets,
# so each family gets its OWN vendor checkout and its OWN venv. Nothing is
# ever shared between them except the Hugging Face blob cache.
#
# This is the developer path. The product path is `simforge models install`,
# which does the same work from the committed lock with digest verification,
# resumable downloads and a licence/token flow. Use that for anything a user
# would run.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FAMILY=""
FETCH_WEIGHTS=0
QUANT_EXTRAS=1

while [ $# -gt 0 ]; do
  case "$1" in
    --family) FAMILY="${2:-}"; shift 2 ;;
    --weights) FETCH_WEIGHTS=1; shift ;;
    --no-quant-extras) QUANT_EXTRAS=0; shift ;;
    -h|--help)
      sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [ -z "$FAMILY" ]; then
  echo "--family is required (alpamayo-1 | alpamayo-1.5 | alpamayo-2-super)" >&2
  exit 1
fi

# Pins live in ONE place: simforge_alpamayo.families. Reading them here rather
# than restating them is what keeps this script from drifting out of agreement
# with the engines and the committed lock.
read_pin() {
  PYTHONPATH="$ROOT/src" python3 -c "
import sys
from simforge_alpamayo.families import get_family
spec = get_family('$FAMILY')
print(getattr(spec, '$1'))
"
}

CODE_REPO="$(read_pin code_repo)"
CODE_REV="$(read_pin code_revision)"
VENDOR_DIR="$(read_pin vendor_dir)"
MODEL_REPO="$(read_pin weights_repo)"
MODEL_REV="$(read_pin weights_revision)"
PACKAGE="$(read_pin package)"

export HF_HOME="${HF_HOME:-${SIMFORGE_ASSETS_ROOT:-$HOME/simforge-assets}/hf-cache}"
mkdir -p "$HF_HOME"

VENDOR="$ROOT/vendor/$VENDOR_DIR"
echo "family        : $FAMILY ($PACKAGE)"
echo "upstream code : $CODE_REPO@$CODE_REV"
echo "weights       : $MODEL_REPO@$MODEL_REV"
echo "vendor dir    : $VENDOR"
echo "HF_HOME       : $HF_HOME"

# 1. Vendor the upstream inference code at the pinned commit (Apache-2.0).
if [ ! -d "$VENDOR/.git" ]; then
  git clone "$CODE_REPO" "$VENDOR"
fi
git -C "$VENDOR" fetch --quiet origin
git -C "$VENDOR" checkout --quiet "$CODE_REV"

# 2. Isolated environment from the upstream lockfile, minus flash-attn: SDPA
#    is the fallback upstream supports and building flash-attn needs nvcc.
cd "$VENDOR"
uv venv --python 3.12 --allow-existing .venv
VIRTUAL_ENV="$PWD/.venv" uv sync --active --locked --no-install-package flash-attn

# 3. Quantization/serving extras. Alpamayo 2 Super has no quantized recipe, so
#    it gets msgpack only rather than quantizers it cannot use.
if [ "$FAMILY" = "alpamayo-2-super" ]; then
  VIRTUAL_ENV="$PWD/.venv" uv pip install msgpack
elif [ "$QUANT_EXTRAS" = "1" ]; then
  VIRTUAL_ENV="$PWD/.venv" uv pip install bitsandbytes==0.49.2 torchao==0.12.0 accelerate>=1.0 msgpack
else
  VIRTUAL_ENV="$PWD/.venv" uv pip install msgpack
fi

# 4. Our adapter, without dependencies: it adds only numpy/msgpack, which the
#    upstream lock already provides.
VIRTUAL_ENV="$PWD/.venv" uv pip install --no-deps -e "$ROOT"

PY="$VENDOR/.venv/bin/python"

# 5. Sidecar config/tokenizer text. Weights are opt-in (--weights): 22-72 GB
#    should never be an accident of running a setup script.
export SF_FAMILY="$FAMILY"
export SF_FETCH_WEIGHTS="$FETCH_WEIGHTS"
PYTHONPATH="$ROOT/src" "$PY" - <<'EOF'
import os
from huggingface_hub import snapshot_download
from simforge_alpamayo.engine import SIDECAR_PATTERNS
from simforge_alpamayo.families import get_family

spec = get_family(os.environ["SF_FAMILY"])
for sidecar in spec.sidecars:
    gated = "" if sidecar.gated is False else "  (GATED: run `hf auth login` first)"
    print(f"sidecar {sidecar.repo}@{sidecar.revision}{gated}")
    snapshot_download(sidecar.repo, revision=sidecar.revision,
                      allow_patterns=SIDECAR_PATTERNS)
if os.environ.get("SF_FETCH_WEIGHTS") == "1":
    print(f"weights {spec.weights_repo}@{spec.weights_revision} "
          f"({spec.weights_bytes / 2**30:.1f} GiB)")
    snapshot_download(spec.weights_repo, revision=spec.weights_revision)
else:
    print(f"weights NOT fetched ({spec.weights_bytes / 2**30:.1f} GiB); "
          f"pass --weights, or use `simforge models install {spec.family} "
          f"--accept-license` for the verified, resumable path")
EOF

echo
echo "setup complete for $FAMILY"
echo "  python : $PY"
echo "  serve  : $PY -m simforge_alpamayo.server --family $FAMILY --quant bf16 \\"
echo "             --socket /tmp/simforge-$FAMILY.sock --http 127.0.0.1:9310"
echo "  check  : PYTHONPATH=$ROOT/src $PY -m simforge_alpamayo.preflight --runtime"
