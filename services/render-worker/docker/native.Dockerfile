# syntax=docker/dockerfile:1.7
FROM node:22.14.0-bookworm-slim AS node-toolchain
FROM rust:1.95.0-bookworm AS node-build
COPY --from=node-toolchain /usr/local /usr/local
WORKDIR /src
RUN rustup target add wasm32-unknown-unknown \
 && corepack enable pnpm && corepack prepare pnpm@11.18.0 --activate
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

FROM rust:1.95.0-bookworm AS rust-build
WORKDIR /src
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends clang libasound2-dev libudev-dev libwayland-dev libx11-dev libxkbcommon-dev pkg-config \
 && rm -rf /var/lib/apt/lists/*
COPY --from=source /renderer ./renderer
RUN cargo build --locked --manifest-path renderer/Cargo.toml --release -p service --bin native-render-service

# Star/Moon plates are NASA-derived build products (renderer/tools/prepare_sky_assets.py),
# not checkout files: they come from the `sky` build context and are admitted only
# when they hash to what the canonical SOURCES.json declares. The service refuses
# to build a scene without them, so a missing or stale plate fails the image build.
FROM node:22.14.0-bookworm-slim AS sky-assets
WORKDIR /sky
COPY --from=sky /starmap_2020_8k.skytex /moon_lroc_4k.skytex ./
COPY --from=source /renderer/render-core/assets/sky/SOURCES.json ./
RUN node -e 'const s=require("/sky/SOURCES.json");if(s.schema!=="simforge.sky-assets/v1")throw new Error(`unsupported sky schema ${s.schema}`);for(const e of s.sources)process.stdout.write(`${e.product_sha256}  ${e.product}\n`)' > /tmp/SHA256SUMS \
 && sha256sum --strict --check /tmp/SHA256SUMS \
 && rm /tmp/SHA256SUMS

FROM node:22.14.0-bookworm-slim AS runtime
ARG SOURCE_REVISION
ARG IMAGE_VERSION
RUN test -n "$SOURCE_REVISION" && test -n "$IMAGE_VERSION" \
 && apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates ffmpeg libasound2 libegl1 libgl1 libudev1 libvulkan1 libx11-6 libxkbcommon0 tini vulkan-tools \
 && install -d /usr/share/vulkan/icd.d \
 && printf '%s\n' '{"file_format_version":"1.0.1","ICD":{"library_path":"libGLX_nvidia.so.0","api_version":"1.4.0"}}' > /usr/share/vulkan/icd.d/nvidia_icd.json \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /opt/simforge /scratch /cache /run/simforge \
 && chown -R node:node /scratch /cache /run/simforge
COPY --from=node-build --chown=node:node /out/worker /opt/simforge/worker
COPY --from=rust-build /src/renderer/target/release/native-render-service /usr/local/bin/native-render-service
COPY --from=sky-assets /sky /opt/simforge/sky
ENV NODE_ENV=production \
    PORT=8080 \
    SIMFORGE_NATIVE_RENDER_BINARY=/usr/local/bin/native-render-service \
    SIMFORGE_SKY_ASSETS=/opt/simforge/sky \
    SIMFORGE_SCRATCH_DIR=/scratch \
    SIMFORGE_CACHE_DIR=/cache \
    SIMFORGE_GPU_LOCK=/run/simforge/gpu.lock \
    NVIDIA_VISIBLE_DEVICES=all \
    NVIDIA_DRIVER_CAPABILITIES=compute,graphics,utility
LABEL org.opencontainers.image.title="SimForge native render worker" \
      org.opencontainers.image.version="$IMAGE_VERSION" \
      org.opencontainers.image.revision="$SOURCE_REVISION" \
      org.opencontainers.image.source="https://github.com/SimForgeinc/simforge-oss" \
      io.simforge.engine="native" \
      io.simforge.native.engine-id="bevy-retained" \
      io.simforge.contract="simforge.render-worker-control/v2"
USER node
WORKDIR /scratch
VOLUME ["/scratch", "/cache", "/run/simforge"]
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=3 CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT||8080}/health`).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/opt/simforge/worker/dist/main.js"]
CMD ["--config", "/config/worker.json"]
