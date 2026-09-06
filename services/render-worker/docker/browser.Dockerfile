# syntax=docker/dockerfile:1.7
FROM node:22.14.0-bookworm-slim AS node-toolchain
FROM rust:1.95.0-bookworm AS build
COPY --from=node-toolchain /usr/local /usr/local
WORKDIR /src
RUN rustup target add wasm32-unknown-unknown \
 && corepack enable && corepack prepare pnpm@11.18.0 --activate
COPY --from=source /package.json /pnpm-lock.yaml /pnpm-workspace.yaml /tsconfig.base.json ./
COPY --from=source /packages ./packages
COPY --from=source /native/Cargo.toml /native/Cargo.lock ./native/
COPY --from=source /native/crates ./native/crates
COPY --from=source /services/render-worker ./services/render-worker
RUN pnpm install --frozen-lockfile --ignore-scripts \
 && pnpm --filter @simforge-oss/native-runtime rebuild wasm-pack \
 && pnpm --filter @simforge-oss/render-worker... build \
 && pnpm deploy --legacy --filter @simforge-oss/render-worker --prod /out/worker \
 && node services/render-worker/finalize-deploy.mjs /out/worker services/render-worker

FROM node:22.14.0-bookworm-slim AS runtime
ARG SOURCE_REVISION
ARG IMAGE_VERSION
RUN test -n "$SOURCE_REVISION" && test -n "$IMAGE_VERSION" \
 && apt-get update \
 && apt-get install -y --no-install-recommends chromium tini ca-certificates ffmpeg libegl1 libgles2 \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 10001 renderer \
 && useradd --system --uid 10001 --gid renderer --home-dir /nonexistent --shell /usr/sbin/nologin renderer \
 && mkdir -p /opt/simforge /scratch /cache /run/simforge \
 && chown -R renderer:renderer /scratch /cache /run/simforge
COPY --from=build --chown=renderer:renderer /out/worker /opt/simforge/worker
# Real-GPU rendering by default: ANGLE over EGL with the NVIDIA glvnd vendor.
# Hosts may override, but launch-config drift can no longer silently fall
# renders back to SwiftShader CPU rendering.
ENV NODE_ENV=production \
    PORT=8080 \
    SIMFORGE_SCRATCH_DIR=/scratch \
    SIMFORGE_CACHE_DIR=/cache \
    SIMFORGE_GPU_LOCK=/run/simforge/gpu.lock \
    CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium \
    SIMFORGE_CHROMIUM_EXTRA_ARGS="--use-gl=angle --use-angle=gl-egl" \
    __EGL_VENDOR_LIBRARY_FILENAMES=/usr/share/glvnd/egl_vendor.d/10_nvidia.json \
    NVIDIA_VISIBLE_DEVICES=all \
    NVIDIA_DRIVER_CAPABILITIES=compute,graphics,utility
LABEL org.opencontainers.image.title="SimForge browser render worker" \
      org.opencontainers.image.version="$IMAGE_VERSION" \
      org.opencontainers.image.revision="$SOURCE_REVISION" \
      org.opencontainers.image.source="https://github.com/SimForgeinc/simforge-oss" \
      io.simforge.engine="browser" \
      io.simforge.contract="simforge.render-worker-control/v2"
USER 10001:10001
WORKDIR /scratch
VOLUME ["/scratch", "/cache", "/run/simforge"]
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT||8080}/health`).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/opt/simforge/worker/dist/main.js"]
CMD ["--config", "/config/worker.json"]
