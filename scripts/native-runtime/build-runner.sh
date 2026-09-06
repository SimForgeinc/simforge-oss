#!/usr/bin/env bash
# Builds every native component of the runtime bundle and writes the runtime
# manifest beside the runner binary. Produces under native/target/<...>/release:
#   simforge-runner, runtime-manifest.json
# and under renderer/target/<...>/release:
#   native-render-service, libsimforge_render.so   (both with --features gpu-interop
#   unless --no-gpu-interop; the host-copy path stays available either way)
# and wheels under dist/native-runtime/wheels/ for the Python providers:
#   simforge-oss-gym (maturin, ships simforge_oss_gym._native), simforge-oss-physics,
#   simforge-oss-gpu, simforge-oss-native-renderer, simforge-oss-splat.
#
# Sky plates: renderer/render-core/assets/sky/*.skytex (gitignored derivatives
# from renderer/tools/prepare_sky_assets.py) are packaged into <root>/share/sky
# and verified against SOURCES.json; without them the renderer cannot build a
# scene, so the bundle build fails unless --no-sky is passed explicitly
# (producing a runtime whose bevy-sensor-render tier is not installable).
#
# Usage: scripts/native-runtime/build-runner.sh [--target <triple>] [--offline] [--no-gpu-interop] [--skip-wheels] [--no-sky] [--sky <dir>]
#   --sky <dir>  directory holding the two .skytex plates (default
#                renderer/render-core/assets/sky). The canonical
#                renderer/render-core/assets/sky/SOURCES.json is always the
#                verification reference; a SOURCES.json in <dir> is ignored.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NATIVE_ROOT="$REPO_ROOT/native"
RENDERER_ROOT="$REPO_ROOT/renderer"
WHEELS_DIR="$REPO_ROOT/dist/native-runtime/wheels"
TARGET=""
OFFLINE=()
RENDER_FEATURES=(--features gpu-interop)
SKIP_WHEELS=0
SKY_DIR="$RENDERER_ROOT/render-core/assets/sky"

fail() { echo "{\"code\":\"runner.build_failed\",\"reason\":\"$1\"}" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target) [[ $# -ge 2 ]] || fail "--target requires a triple"; TARGET="$2"; shift 2 ;;
    --offline) OFFLINE=(--offline); shift ;;
    --no-gpu-interop) RENDER_FEATURES=(); shift ;;
    --skip-wheels) SKIP_WHEELS=1; shift ;;
    --no-sky) SKY_DIR=""; shift ;;
    --sky) [[ $# -ge 2 ]] || fail "--sky requires a directory"; SKY_DIR="$2"; shift 2 ;;
    *) fail "unknown argument $1" ;;
  esac
done

TARGET_FLAG=()
if [[ -n "$TARGET" ]]; then
  TARGET_FLAG=(--target "$TARGET")
  NATIVE_OUT="$NATIVE_ROOT/target/$TARGET/release"
  RENDER_OUT="$RENDERER_ROOT/target/$TARGET/release"
else
  TARGET="$(rustc -vV | sed -n 's/^host: //p')"
  NATIVE_OUT="$NATIVE_ROOT/target/release"
  RENDER_OUT="$RENDERER_ROOT/target/release"
fi

(cd "$NATIVE_ROOT" && cargo build --release --locked "${OFFLINE[@]}" "${TARGET_FLAG[@]}" -p simforge-runner)
(cd "$RENDERER_ROOT" && cargo build --release --locked "${OFFLINE[@]}" "${TARGET_FLAG[@]}" -p service -p render-ffi "${RENDER_FEATURES[@]}")

RUNNER="$NATIVE_OUT/simforge-runner"
[[ -x "$RUNNER" ]] || fail "$RUNNER missing after build"
[[ -x "$RENDER_OUT/native-render-service" ]] || fail "$RENDER_OUT/native-render-service missing after build"
[[ -f "$RENDER_OUT/libsimforge_render.so" ]] || fail "$RENDER_OUT/libsimforge_render.so missing after build"

if [[ "$SKIP_WHEELS" -eq 0 ]]; then
  mkdir -p "$WHEELS_DIR"
  rm -f "$WHEELS_DIR"/*.whl
  # simforge-oss-gym carries the PyO3 extension; maturin builds it against the
  # native workspace crate named in its pyproject.
  (cd "$REPO_ROOT/adapters/gym" && maturin build --release "${TARGET_FLAG[@]}" --out "$WHEELS_DIR")
  for pkg in adapters/physics adapters/gpu renderer/service/python renderer/splat/python; do
    (cd "$REPO_ROOT/$pkg" && python3 -m build --wheel --outdir "$WHEELS_DIR")
  done
fi

if [[ -n "$SKY_DIR" ]]; then
  for plate in starmap_2020_8k.skytex moon_lroc_4k.skytex; do
    [[ -f "$SKY_DIR/$plate" ]] || fail "$SKY_DIR/$plate missing; run renderer/tools/prepare_sky_assets.py (needs the NASA originals in renderer/assets-src) or pass --no-sky"
  done
fi

node "$REPO_ROOT/scripts/native-runtime/write-runtime-manifest.mjs" \
  --binary "$RUNNER" \
  --sky "$SKY_DIR" \
  --render-service "$RENDER_OUT/native-render-service" \
  --render-lib "$RENDER_OUT/libsimforge_render.so" \
  --wheels "$([[ "$SKIP_WHEELS" -eq 0 ]] && echo "$WHEELS_DIR" || echo "")" \
  --out "$NATIVE_OUT/runtime-manifest.json" \
  --target "$TARGET" >/dev/null

# The binary must accept its own manifest before it is called a build.
SIMFORGE_RUNTIME_MANIFEST="$NATIVE_OUT/runtime-manifest.json" "$RUNNER" runtime show
