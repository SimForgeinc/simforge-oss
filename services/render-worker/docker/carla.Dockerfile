# syntax=docker/dockerfile:1.7
FROM node:22.14.0-bookworm-slim AS node-toolchain
FROM rust:1.95.0-bookworm AS node-build
COPY --from=node-toolchain /usr/local /usr/local
WORKDIR /src
RUN rustup target add wasm32-unknown-unknown \
 && corepack enable pnpm && corepack prepare pnpm@11.18.0 --activate
COPY --from=source /package.json /pnpm-lock.yaml /pnpm-workspace.yaml /tsconfig.base.json ./
COPY --from=source /packages ./packages
COPY --from=source /patches ./patches
COPY --from=source /studio/app/generated/carla-object-catalog.json ./studio/app/generated/carla-object-catalog.json
COPY --from=source /native/Cargo.toml /native/Cargo.lock ./native/
COPY --from=source /native/crates ./native/crates
COPY --from=source /services/render-worker ./services/render-worker
RUN pnpm install --frozen-lockfile --ignore-scripts \
 && pnpm --filter @simforge-oss/native-runtime rebuild wasm-pack \
 && pnpm --filter @simforge-oss/render-worker... build
# The CLI/desktop patch (@electron/osx-sign) is outside the worker closure, so
# the worker-only deploy must not fail on it.
RUN pnpm deploy --config.allow-unused-patches=true --legacy --filter @simforge-oss/render-worker --prod /out/worker \
 && node services/render-worker/finalize-deploy.mjs /out/worker services/render-worker

# The shared render-timeline sampler (PyO3, abi3 >= 3.10, manylinux2014). The
# trace-replay path refuses a package that ships a render timeline without it,
# so an image without this wheel cannot render any platform CARLA job.
FROM ghcr.io/pyo3/maturin:v1.9.6 AS timeline-build
COPY --from=source /native /src/native
COPY --from=source /adapters/timeline /src/adapters/timeline
WORKDIR /src/adapters/timeline
RUN maturin build --release --locked --manylinux 2014 -o /wheels

FROM python:3.12.10-slim-bookworm AS python-build
WORKDIR /src
COPY --from=source /adapters/carla-exec ./adapters/carla-exec
RUN python -m pip wheel --no-cache-dir --wheel-dir /wheels ./adapters/carla-exec

FROM ghcr.io/simforgeinc/carla-rfs-munich-belmont:0.10.0-kia@sha256:baed0d038437c55efe0abe52a762d352aeb21acdeeff5b11a15f6bd8a648de64 AS runtime
ARG SOURCE_REVISION
ARG IMAGE_VERSION
USER root
RUN test -n "$SOURCE_REVISION" && test -n "$IMAGE_VERSION" \
 && apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3 python3-pip tini ca-certificates libxml2-utils ffmpeg \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /opt/simforge /scratch /cache /run/simforge \
 && chown -R carla:carla /scratch /cache /run/simforge
# The worker needs the Node binary alone; the build stage's /usr/local also
# holds the Rust toolchain and must not ship.
COPY --from=node-toolchain /usr/local/bin/node /usr/local/bin/node
COPY --from=node-build --chown=carla:carla /out/worker /opt/simforge/worker
COPY --from=python-build /wheels /tmp/wheels
COPY --from=timeline-build /wheels /tmp/wheels
RUN python3 -m pip install --no-cache-dir /home/carla/PythonAPI/carla/dist/carla-*.whl /tmp/wheels/*.whl && rm -rf /tmp/wheels \
 && python3 -c "import simforge_oss_timeline"
# SIMFORGE_SOURCE_REVISION is the engine version a CARLA worker registers with;
# the control plane only approves a CARLA node whose version is this commit.
# SIMFORGE_CARLA_VERSION/SIMFORGE_ENGINE_VERSION are the pinned base image's
# runtime (0.10.0 on UE5.5): the render attests them, and never invents them.
# No setting here may change render output (no generated-XODR worlds, no
# approximate map binding, no z offsets, no signal remaps): the adapter
# refuses those (carla_forbidden_worker_config).
ENV NODE_ENV=production \
    PORT=8080 \
    SIMFORGE_SOURCE_REVISION=$SOURCE_REVISION \
    SIMFORGE_CARLA_BINARY=/usr/local/bin/simforge-oss-carla-exec \
    SIMFORGE_SCRATCH_DIR=/scratch \
    SIMFORGE_CARLA_BLUEPRINT_ID=vehicle.kia.carnival \
    SIMFORGE_CARLA_BLUEPRINT_CLASS=/Game/Carla/Blueprints/Vehicles/KiaCarnival2025/BP_KiaCarnival2025.BP_KiaCarnival2025_C \
    SIMFORGE_CARLA_IMAGE_MANIFEST_SHA256=baed0d038437c55efe0abe52a762d352aeb21acdeeff5b11a15f6bd8a648de64 \
    SIMFORGE_CARLA_VERSION=0.10.0 \
    SIMFORGE_ENGINE_VERSION=UE5.5 \
    SIMFORGE_CACHE_DIR=/cache \
    SIMFORGE_GPU_LOCK=/run/simforge/gpu.lock \
    NVIDIA_VISIBLE_DEVICES=all \
    NVIDIA_DRIVER_CAPABILITIES=compute,graphics,utility
LABEL org.opencontainers.image.title="SimForge CARLA render worker" \
      org.opencontainers.image.version="$IMAGE_VERSION" \
      org.opencontainers.image.revision="$SOURCE_REVISION" \
      org.opencontainers.image.source="https://github.com/SimForgeinc/simforge-oss" \
      io.simforge.engine="carla" \
      io.simforge.carla.base.index-digest="sha256:f17c639e5f86fd7458fe1d02d3be1d481deeaa714f3cac30e465187d04ec90e5" \
      io.simforge.carla.base.manifest-digest="sha256:baed0d038437c55efe0abe52a762d352aeb21acdeeff5b11a15f6bd8a648de64" \
      io.simforge.sensor-host.catalog-asset-id="vehicle.kia.carnival" \
      io.simforge.sensor-host.carla-blueprint-id="vehicle.kia.carnival" \
      io.simforge.sensor-host.carla-class-path="/Game/Carla/Blueprints/Vehicles/KiaCarnival2025/BP_KiaCarnival2025.BP_KiaCarnival2025_C" \
      io.simforge.contract="simforge.render-worker-control/v2"
USER carla
WORKDIR /scratch
VOLUME ["/scratch", "/cache", "/run/simforge"]
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=3 CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT||8080}/health`).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/opt/simforge/worker/dist/main.js"]
CMD ["--config", "/config/worker.json"]
