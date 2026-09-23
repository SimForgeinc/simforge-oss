#!/bin/bash
# Make a bare full-cook box able to render: python-with-carla, the adapter, the
# Vulkan ICD, and a running engine.
#
# The cook image carries CARLA and the maps but nothing else: no venv, no
# adapter, and — because a bare cook declares no driver capabilities — no
# NVIDIA Vulkan ICD, without which UE5's render thread never starts and the
# game thread aborts after 60 s. Everything here is discovered from the image
# rather than assumed, so the same script survives a re-cook.
set -uo pipefail

PORT="${CARLA_PORT:-2000}"
QUALITY="${CARLA_QUALITY:-Epic}"
VENV="${SIMFORGE_VENV:-/opt/simforge/venv}"
ADAPTER_SRC="${ADAPTER_SRC:-/tmp/carla-exec}"

log() { printf '{"component":"bringup","event":"%s","detail":"%s"}\n' "$1" "${2:-}"; }

# --- the engine's own python and its carla wheel ---------------------------
PY_BASE="$(command -v python3.10 || command -v python3)"
[ -x "$PY_BASE" ] || { log fatal "no python3 in image"; exit 1; }
WHEEL="$(find / -name 'carla-*cp310*.whl' -o -name 'carla-*.egg' 2>/dev/null | head -1)"
CARLA_PKG="$(find / -name 'carla' -maxdepth 8 -type d -path '*site-packages*' 2>/dev/null | head -1)"
log python "base=$PY_BASE wheel=${WHEEL:-none} pkg=${CARLA_PKG:-none}"

if [ ! -x "$VENV/bin/python" ]; then
  mkdir -p "$(dirname "$VENV")"
  "$PY_BASE" -m venv --without-pip --system-site-packages "$VENV" 2>/dev/null \
    || "$PY_BASE" -m venv --system-site-packages "$VENV"
  log venv "created at $VENV"
fi

# The wheel is a zip; extracting it avoids needing pip or a network.
if ! "$VENV/bin/python" -c "import carla" >/dev/null 2>&1; then
  SITE="$("$VENV/bin/python" -c 'import site; print(site.getsitepackages()[0])')"
  if [ -n "${WHEEL:-}" ]; then
    "$VENV/bin/python" -c "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" "$WHEEL" "$SITE"
  elif [ -n "${CARLA_PKG:-}" ]; then
    cp -r "$CARLA_PKG" "$SITE/"
  fi
  "$VENV/bin/python" -c "import carla; print('carla', carla.__file__)" || { log fatal "no carla module"; exit 1; }
fi

# --- the adapter, from source: it has no dependencies ----------------------
if [ -d "$ADAPTER_SRC" ]; then
  SITE="$("$VENV/bin/python" -c 'import site; print(site.getsitepackages()[0])')"
  rm -rf "$SITE/simforge_oss_carla_exec"
  cp -r "$ADAPTER_SRC/simforge_oss_carla_exec" "$SITE/"
  "$VENV/bin/python" -c "import simforge_oss_carla_exec; print('adapter ok')" || { log fatal "adapter import failed"; exit 1; }
fi

# --- tools the adapter shells out to ---------------------------------------
for tool in xmllint ffmpeg; do
  command -v "$tool" >/dev/null 2>&1 && continue
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq >/dev/null 2>&1
  apt-get install -y -qq libxml2-utils ffmpeg >/dev/null 2>&1
  break
done
log tools "xmllint=$(command -v xmllint || echo MISSING) ffmpeg=$(command -v ffmpeg || echo MISSING)"

# --- Vulkan ICD -------------------------------------------------------------
mkdir -p /usr/share/vulkan/icd.d
cat > /usr/share/vulkan/icd.d/nvidia_icd.json <<'JSON'
{"file_format_version":"1.0.0","ICD":{"library_path":"libGLX_nvidia.so.0","api_version":"1.3"}}
JSON

# --- engine -----------------------------------------------------------------
LAUNCHER="$(find / -maxdepth 4 -name 'CarlaUnreal.sh' 2>/dev/null | head -1)"
[ -n "$LAUNCHER" ] || { log fatal "no CarlaUnreal.sh in image"; exit 1; }
ENGINE_USER="$(stat -c %U "$(dirname "$LAUNCHER")")"
chown -R "$ENGINE_USER" "$(dirname "$LAUNCHER")" 2>/dev/null || true

if ! timeout 3 bash -c "cat < /dev/null > /dev/tcp/127.0.0.1/$PORT" 2>/dev/null; then
  rm -f /tmp/carla-engine.log
  setsid nohup setpriv --reuid="$ENGINE_USER" --regid="$ENGINE_USER" --clear-groups \
    env HOME="$(getent passwd "$ENGINE_USER" | cut -d: -f6)" XDG_RUNTIME_DIR=/tmp \
    "$LAUNCHER" -RenderOffScreen -nosound "-quality-level=$QUALITY" "-carla-rpc-port=$PORT" \
    > /tmp/carla-engine.log 2>&1 < /dev/null &
  log engine-launch "user=$ENGINE_USER quality=$QUALITY port=$PORT"
fi

for attempt in $(seq 1 90); do
  if timeout 3 bash -c "cat < /dev/null > /dev/tcp/127.0.0.1/$PORT" 2>/dev/null; then
    log engine-ready "attempt=$attempt"
    exit 0
  fi
  sleep 10
done
log fatal "engine never reached RPC readiness"
tail -20 /tmp/carla-engine.log
exit 1
