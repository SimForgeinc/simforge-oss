#!/usr/bin/env bash
# Build the simforge-oss-gym wheel (abi3, one per platform) into $1.
#
#   scripts/release/build-wheel.sh <out-dir> [--target <triple>] [--sdist]
#
# Before building, the wheel's own THIRD_PARTY_NOTICES (the Rust crates linked
# into the `_native` extension) is regenerated with cargo-about, so the wheel
# never ships a stale notice. Linux wheels are manylinux_2_28 (built inside the
# release build image); aarch64 is cross-compiled with zig.
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
cd "$root"
# shellcheck source=layout.sh
source scripts/release/layout.sh

out="$(realpath -m "$1")"; shift
target=""; sdist=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --target) target="$2"; shift 2 ;;
    --sdist) sdist=1; shift ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done
mkdir -p "$out"

native_manifest="$(python3 - "$SIMFORGE_GYM_DIR" <<'PY'
import pathlib, sys, tomllib
d = pathlib.Path(sys.argv[1])
print((d / tomllib.loads((d / "pyproject.toml").read_text())["tool"]["maturin"]["manifest-path"]).resolve())
PY
)"
cargo about generate --manifest-path "$native_manifest" --locked -c about.toml about.hbs \
  -o "$SIMFORGE_GYM_DIR/$SIMFORGE_GYM_DIST_NAME/THIRD_PARTY_NOTICES"

cd "$SIMFORGE_GYM_DIR"
if [[ "$sdist" == 1 ]]; then
  maturin sdist --out "$out"
  exit 0
fi
args=(build --release --locked --out "$out")
case "$target" in
  "") ;;
  *-linux-gnu) args+=(--target "$target" --compatibility manylinux_2_28 --zig) ;;
  *) args+=(--target "$target") ;;
esac
if [[ "$(uname -s)" == Linux && -z "$target" ]]; then
  args+=(--compatibility manylinux_2_28)
fi
maturin "${args[@]}"
ls -la "$out"
