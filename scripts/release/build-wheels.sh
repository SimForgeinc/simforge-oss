#!/usr/bin/env bash
# Build the release's Python distributions (layout.sh SIMFORGE_PY_DISTS) into $1.
#
#   scripts/release/build-wheels.sh <out-dir> [--target <triple>] [--all]
#
# Always: every `native` dist (maturin, abi3) for this platform, or for
# --target (Linux targets are manylinux_2_28; aarch64 cross-compiles with zig).
# --all (once per release, on Linux x86_64): also every `pure` dist's wheel and
# every dist's sdist.
#
# Before a native build, the dist's THIRD_PARTY_NOTICES (the Rust crates linked
# into its extension) is regenerated with cargo-about, so no wheel ships a stale
# notice.
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
cd "$root"
# shellcheck source=layout.sh
source scripts/release/layout.sh

out="$(realpath -m "$1")"; shift
target=""; all=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --target) target="$2"; shift 2 ;;
    --all) all=1; shift ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done
mkdir -p "$out"

maturin_field() {
  python3 - "$1" "$2" <<'PY'
import pathlib, sys, tomllib
d = pathlib.Path(sys.argv[1])
m = tomllib.loads((d / "pyproject.toml").read_text())["tool"]["maturin"]
if sys.argv[2] == "manifest":
    print((d / m["manifest-path"]).resolve())
else:
    print(m["module-name"].split(".")[0])
PY
}

for entry in $SIMFORGE_PY_DISTS; do
  dir="${entry%%:*}"; kind="${entry##*:}"
  case "$kind" in
    native)
      manifest="$(maturin_field "$dir" manifest)"
      package="$(maturin_field "$dir" package)"
      cargo about generate --manifest-path "$manifest" --locked -c about.toml about.hbs \
        -o "$dir/$package/THIRD_PARTY_NOTICES"
      args=(build --release --locked --out "$out")
      case "$target" in
        "") [[ "$(uname -s)" == Linux ]] && args+=(--compatibility manylinux_2_28) ;;
        *-linux-gnu) args+=(--target "$target" --compatibility manylinux_2_28 --zig) ;;
        *) args+=(--target "$target") ;;
      esac
      (cd "$dir" && maturin "${args[@]}")
      if [[ "$all" == 1 ]]; then (cd "$dir" && maturin sdist --out "$out"); fi
      ;;
    pure)
      if [[ "$all" == 1 ]]; then
        python3 -m build --version >/dev/null 2>&1 || { echo "build-wheels.sh: python -m build is required (pip install build)" >&2; exit 2; }
        python3 -m build --wheel --sdist --outdir "$out" "$dir"
      fi
      ;;
    *) echo "build-wheels.sh: unknown kind '$kind' for $dir" >&2; exit 2 ;;
  esac
done
ls -la "$out"
