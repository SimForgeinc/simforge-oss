#!/usr/bin/env bash
# Installs a packaged native runtime archive into the worker root that the
# runner, local Studio host, CLI and Python providers discover:
#   ROOT=${SIMFORGE_NATIVE_RUNTIME_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/simforge/native-runtime}
#   ROOT/bin/{simforge-runner,native-render-service,runtime-manifest.json}
#   ROOT/lib/libsimforge_render.so
#   ROOT/wheels/*.whl
#   ROOT/share/sky/       renderer sky plates + SOURCES.json (SIMFORGE_SKY_ASSETS overrides)
#   ROOT/venv             symlink -> venvs/<generation>, the active provider interpreter
#   ROOT/venvs/<gen>/     provider venvs, each built in place from the bundled wheels
#
# Usage: scripts/native-runtime/install-runtime.sh <archive.tar.gz> [--python <interpreter>] [--extras <a,b>]
#   --extras selects optional provider extras (default: none). Examples:
#     articulated-warp  (simforge-oss-physics[warp])   gpu-torch (simforge-oss-gpu[torch])
#     renderer-torch    (simforge-oss-native-renderer[torch])
# Verifies SHA256SUMS, installs bin/lib/wheels/share atomically (staged then
# renamed, previous kept as *.previous), builds a fresh venv generation from the
# bundled wheels (--find-links wheels/; transitive dependencies such as
# numpy/mujoco/warp come from a bundled or configured index via PIP_FIND_LINKS /
# PIP_INDEX_URL), import-checks every provider module, atomically repoints
# ROOT/venv at the new generation and finally asks the installed runner to
# verify its manifest and list its engines.
#
# A venv is never moved after pip has populated it: wheel console scripts hard
# code the interpreter path in their shebang, so relocating the directory
# breaks every provider entrypoint. Each generation is created at its final
# path ROOT/venvs/<timestamp>-<pid>; ROOT/venv is a symlink swapped with
# rename(2), so ROOT/venv/bin/python stays the public discovery path and a
# failed build never replaces the working environment. Completed generations
# are immutable and never removed by this script (a job may still be running
# against any of them); only the generation this invocation was building is
# removed, and only when the build did not reach activation. A ROOT/venv that
# is a real directory (not a symlink) is rejected before anything is modified.
# Never touches ROOT/jobs, ROOT/cas or ROOT/worker.
set -euo pipefail

ARCHIVE="${1:-}"
[[ -f "$ARCHIVE" ]] || { echo '{"code":"runner.usage","reason":"usage: install-runtime.sh <archive.tar.gz> [--python <interpreter>] [--extras <a,b>]"}' >&2; exit 1; }
shift
PYTHON="python3"
EXTRAS=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --python) PYTHON="$2"; shift 2 ;;
    --extras) EXTRAS="$2"; shift 2 ;;
    *) echo "{\"code\":\"runner.usage\",\"reason\":\"unknown argument $1\"}" >&2; exit 1 ;;
  esac
done

ROOT="${SIMFORGE_NATIVE_RUNTIME_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/simforge/native-runtime}"
if [[ -e "$ROOT/venv" && ! -L "$ROOT/venv" ]]; then
  echo "{\"code\":\"runner.install_failed\",\"reason\":\"$ROOT/venv exists and is not a symlink; this installer manages ROOT/venv as a symlink into ROOT/venvs/. Install into a fresh root or move the directory aside.\"}" >&2
  exit 1
fi

GEN_DIR=""    # generation created by this invocation; removed by the trap unless activated
ACTIVATED=0
cleanup() {
  rm -rf "$STAGE"
  [[ -z "$GEN_DIR" || "$ACTIVATED" -eq 1 ]] || rm -rf "$GEN_DIR"
}
STAGE="$(mktemp -d)"
trap cleanup EXIT
tar -C "$STAGE" -xzf "$ARCHIVE"
(cd "$STAGE" && sha256sum -c --quiet SHA256SUMS)

mkdir -p "$ROOT"

if compgen -G "$STAGE/wheels/*.whl" >/dev/null; then
  GEN="$(date -u +%Y%m%dT%H%M%SZ)-$$"
  GENERATION_PATH="$ROOT/venvs/$GEN"
  mkdir -p "$ROOT/venvs"
  mkdir "$GENERATION_PATH"   # fails if the name is taken
  GEN_DIR="$GENERATION_PATH" # only a successful mkdir transfers ownership to the trap
  # Built at its final path: pip writes absolute interpreter paths into
  # console-script shebangs, so the directory must never be renamed afterwards.
  "$PYTHON" -m venv "$GEN_DIR"
  VENV_PY="$GEN_DIR/bin/python"
  "$VENV_PY" -m pip install --quiet --upgrade pip
  SPECS=()
  for wheel in "$STAGE"/wheels/*.whl; do
    name="$(basename "$wheel" | cut -d- -f1 | tr '_' '-')"
    extra=""
    case "$name" in
      simforge-oss-physics) [[ ",$EXTRAS," == *",articulated-warp,"* ]] && extra="[warp]" ;;
      simforge-oss-gpu) [[ ",$EXTRAS," == *",gpu-torch,"* ]] && extra="[torch]" ;;
      simforge-oss-native-renderer) [[ ",$EXTRAS," == *",renderer-torch,"* ]] && extra="[torch]" ;;
    esac
    SPECS+=("${name}${extra}@file://${wheel}")
  done
  "$VENV_PY" -m pip install --quiet --find-links "$STAGE/wheels" "${SPECS[@]}"

  # Every provider module the manifest lists must import from the new
  # generation before it is allowed to replace the active one. Each import
  # runs in its own interpreter process (a failing module cannot mask or
  # poison the others); no Node is involved in install or runtime execution.
  "$VENV_PY" - "$STAGE/bin/runtime-manifest.json" <<'PY'
import json, subprocess, sys
with open(sys.argv[1], encoding="utf-8") as f:
    manifest = json.load(f)
for component in manifest["components"]:
    if component.get("kind") != "wheel":
        continue
    module = component["module"]
    result = subprocess.run([sys.executable, "-c", f"import importlib; importlib.import_module({module!r})"])
    if result.returncode != 0:
        print(json.dumps({"code": "runner.install_failed", "reason": f"provider module {module} failed to import (exit {result.returncode})"}), file=sys.stderr)
        sys.exit(1)
PY
fi

# Publish components only after the new environment has passed its checks.
for part in bin lib wheels share; do
  [[ -d "$STAGE/$part" ]] || continue
  NEW="$ROOT/$part.$$"
  rm -rf "$NEW"
  mv "$STAGE/$part" "$NEW"
  if [[ -d "$ROOT/$part" ]]; then rm -rf "$ROOT/$part.previous"; mv "$ROOT/$part" "$ROOT/$part.previous"; fi
  mv "$NEW" "$ROOT/$part"
done
chmod 0755 "$ROOT/bin/simforge-runner" "$ROOT/bin/native-render-service"

if [[ -n "$GEN_DIR" ]]; then
  # Activate: ROOT/venv becomes a symlink to the new generation via rename(2).
  LINK_TMP="$ROOT/venv.link.$$"
  rm -f "$LINK_TMP"
  ln -s "venvs/$GEN" "$LINK_TMP"
  mv -T "$LINK_TMP" "$ROOT/venv"
  ACTIVATED=1
fi

SIMFORGE_NATIVE_RUNTIME_ROOT="$ROOT" "$ROOT/bin/simforge-runner" --root "$ROOT" runtime show
