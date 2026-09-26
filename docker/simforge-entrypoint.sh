#!/bin/sh
# Pick the Vulkan driver explicitly, say which one, then exec simforge.
#
#   SIMFORGE_DEVICE=auto (default)  NVIDIA if the driver is mounted, else lavapipe (CPU)
#   SIMFORGE_DEVICE=gpu             NVIDIA or exit 2 (never a quiet CPU render)
#   SIMFORGE_DEVICE=cpu             lavapipe even when a GPU is mounted (golden fingerprint)
#
# The choice is exported as SIMFORGE_CONTAINER_DEVICE and printed on stderr;
# `simforge doctor` and every render's results record the adapter it used.
set -eu

lavapipe_icd() {
  # lvp_icd.json on Ubuntu 24.04+; lvp_icd.<arch>.json on older Debian/Ubuntu.
  for f in /usr/share/vulkan/icd.d/lvp_icd.json /usr/share/vulkan/icd.d/lvp_icd.*.json; do
    [ -e "$f" ] && { echo "$f"; return 0; }
  done
  return 1
}
nvidia_present() { ldconfig -p 2>/dev/null | grep -q 'libGLX_nvidia\.so\.0'; }

device="${SIMFORGE_DEVICE:-auto}"
case "$device" in
  gpu)
    if ! nvidia_present; then
      echo "simforge-container: SIMFORGE_DEVICE=gpu but no NVIDIA driver is mounted (run with --runtime nvidia -e NVIDIA_VISIBLE_DEVICES=all; needs the NVIDIA container toolkit)" >&2
      exit 2
    fi
    export VK_DRIVER_FILES=/opt/simforge/icd/nvidia_icd.json SIMFORGE_CONTAINER_DEVICE=nvidia ;;
  cpu)
    VK_DRIVER_FILES="$(lavapipe_icd)" || { echo "simforge-container: lavapipe ICD missing from the image" >&2; exit 2; }
    # Choosing the CPU is the explicit opt-in the renderer asks for.
    export VK_DRIVER_FILES SIMFORGE_CONTAINER_DEVICE=lavapipe SIMFORGE_NATIVE_ALLOW_SOFTWARE_ADAPTER=1 ;;
  auto)
    if nvidia_present; then
      export VK_DRIVER_FILES=/opt/simforge/icd/nvidia_icd.json SIMFORGE_CONTAINER_DEVICE=nvidia
    else
      VK_DRIVER_FILES="$(lavapipe_icd)" || { echo "simforge-container: lavapipe ICD missing from the image" >&2; exit 2; }
      export VK_DRIVER_FILES SIMFORGE_CONTAINER_DEVICE=lavapipe
      echo "simforge-container: no GPU mounted; rendering on the CPU (Mesa lavapipe). For NVIDIA use --runtime nvidia -e NVIDIA_VISIBLE_DEVICES=all; SIMFORGE_DEVICE=cpu silences this." >&2
    fi ;;
  *)
    echo "simforge-container: SIMFORGE_DEVICE must be auto, gpu or cpu (got '$device')" >&2
    exit 2 ;;
esac
# Older loaders read VK_ICD_FILENAMES only.
export VK_ICD_FILENAMES="$VK_DRIVER_FILES"
exec /usr/local/bin/simforge "$@"
