#!/bin/bash
# Run the CARLA engine from a full-cook image on ws2's RTX 3080.
#
# The engine and the worker live in separate containers: the cook image carries
# the maps and vehicle content but no Node, and the worker image carries the
# worker and the Python adapter but only a partial cook. They meet over the
# host's loopback on the CARLA RPC port, so neither image has to be rebuilt.
set -euo pipefail

IMAGE="${COOK_IMAGE:-ghcr.io/simforgeinc/carla-rr-maps:0.10.0-prod-graphics}"
NAME="${ENGINE_NAME:-sf-engine-cook}"
PORT="${CARLA_PORT:-2000}"

# Measured on a 10 GiB RTX 3080 with the Richmond cook: the map alone resides at
# 7.6 GiB at Epic and 2.1 GiB at High with the streaming pool capped. Epic then
# dies with `Out of memory on Vulkan` the moment a scenario's actors and sensors
# are added, so a small card defaults to High. Cards with headroom should pass
# CARLA_QUALITY=Epic explicitly.
QUALITY="${CARLA_QUALITY:-High}"
STREAMING_POOL_MIB="${CARLA_STREAMING_POOL_MIB:-1024}"

docker rm -f "$NAME" >/dev/null 2>&1 || true

# A bare cook declares no driver capabilities and ships no NVIDIA Vulkan ICD, so
# UE5's render thread never starts and the game thread aborts after 60 s. Declare
# the capability and write the ICD before the engine launches.
# The cook image runs as `carla`, which cannot write the ICD or re-drop
# privileges, so the container starts as root and the engine itself is dropped
# back to `carla` (UE5 refuses to run as root).
docker run -d --name "$NAME" \
  --gpus all \
  --network host \
  --user 0 \
  --shm-size=8g \
  -e NVIDIA_DRIVER_CAPABILITIES=all \
  -e NVIDIA_VISIBLE_DEVICES=all \
  --entrypoint /bin/bash \
  "$IMAGE" -lc '
    mkdir -p /usr/share/vulkan/icd.d
    cat > /usr/share/vulkan/icd.d/nvidia_icd.json <<JSON
{"file_format_version":"1.0.0","ICD":{"library_path":"libGLX_nvidia.so.0","api_version":"1.3"}}
JSON
    chown -R carla /home/carla 2>/dev/null || true
    exec setpriv --reuid=carla --regid=carla --clear-groups \
      env HOME=/home/carla XDG_RUNTIME_DIR=/tmp \
      /home/carla/CarlaUnreal.sh -RenderOffScreen -nosound \
        -quality-level='"$QUALITY"' -carla-rpc-port='"$PORT"' \
        -ini:Engine:[SystemSettings]:r.Streaming.PoolSize='"$STREAMING_POOL_MIB"' \
        -ini:Engine:[SystemSettings]:r.Streaming.LimitPoolSizeToVRAM=1
  ' >/dev/null

echo "engine container started: $NAME"

# Readiness is the RPC accepting connections, not the process existing.
for attempt in $(seq 1 90); do
  if timeout 3 bash -c "cat < /dev/null > /dev/tcp/127.0.0.1/$PORT" 2>/dev/null; then
    echo "engine-ready attempt=$attempt"
    exit 0
  fi
  if ! docker ps --format '{{.Names}}' | grep -qx "$NAME"; then
    echo "engine container exited; last output:" >&2
    docker logs --tail 40 "$NAME" >&2
    exit 1
  fi
  sleep 10
done

echo "engine did not answer RPC on port $PORT" >&2
docker logs --tail 40 "$NAME" >&2
exit 1
