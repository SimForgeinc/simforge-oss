# syntax=docker/dockerfile:1.7
# ghcr.io/simforgeinc/simforge: the `simforge` CLI with its linked renderer.
#
# Built by .github/workflows/release-container.yml from the RELEASED Linux
# tarball (the same bytes users download, checksum-verified), never from a
# separate compile. Build context layout (prepared by the workflow):
#   bin/<TARGETARCH>/simforge   the released binary
#   LICENSE NOTICE THIRD_PARTY_NOTICES.md
#   docker/simforge-entrypoint.sh
#
# Vulkan device: CPU (Mesa lavapipe) unless an NVIDIA driver is mounted
# (`docker run --gpus all`); the entrypoint states which one it picked on
# stderr and exports SIMFORGE_CONTAINER_DEVICE, and SIMFORGE_DEVICE=gpu makes a
# missing GPU a hard error. See docs/src/install/container.md.
ARG BASE=ubuntu:24.04@sha256:008173c23f95b170204355c12626cb5a965d779a7e1283b09e9cffbb1bf33ca3
FROM ${BASE}
ARG TARGETARCH
ARG SIMFORGE_VERSION
ARG SIMFORGE_REVISION

# ffmpeg is a separate system program (GPL build from the Ubuntu archive); the
# binary never links it. libasound2t64/libudev1/libwayland-client0 are here only
# while the release binary still links them (tracked: the CLI build should be
# headless); the workflow's `ldd` check fails the image if anything is missing.
RUN set -eux; \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates ffmpeg libvulkan1 mesa-vulkan-drivers vulkan-tools tini \
      libasound2t64 libudev1 libwayland-client0; \
    rm -rf /var/lib/apt/lists/*; \
    install -d /opt/simforge/icd; \
    printf '%s\n' '{"file_format_version":"1.0.1","ICD":{"library_path":"libGLX_nvidia.so.0","api_version":"1.4.0"}}' \
      > /opt/simforge/icd/nvidia_icd.json; \
    useradd --uid 10001 --create-home --home-dir /home/simforge simforge; \
    install -d -o simforge -g simforge /data /work

COPY --chmod=0755 bin/${TARGETARCH}/simforge /usr/local/bin/simforge
COPY --chmod=0755 docker/simforge-entrypoint.sh /usr/local/bin/simforge-entrypoint
COPY LICENSE NOTICE THIRD_PARTY_NOTICES.md /usr/share/doc/simforge/

# The NVIDIA container toolkit mounts the driver's Vulkan library only when
# the graphics capability is requested.
ENV NVIDIA_DRIVER_CAPABILITIES=compute,graphics,utility \
    SIMFORGE_DEVICE=auto \
    XDG_DATA_HOME=/data \
    XDG_CACHE_HOME=/data/cache

LABEL org.opencontainers.image.title="simforge" \
      org.opencontainers.image.description="SimForge CLI with the deterministic renderer (Vulkan: NVIDIA via --gpus all, or Mesa lavapipe on CPU)" \
      org.opencontainers.image.source="https://github.com/SimForgeinc/simforge-sdk" \
      org.opencontainers.image.url="https://docs.simforge.ai" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${SIMFORGE_VERSION}" \
      org.opencontainers.image.revision="${SIMFORGE_REVISION}"

USER simforge
WORKDIR /work
VOLUME ["/data"]
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/simforge-entrypoint"]
CMD ["--help"]
