# syntax=docker/dockerfile:1.7
#
# A CARLA render worker image = an approved worker image (built by
# carla.Dockerfile, pinned by digest) + ONE layer of extra cooked worlds + the
# carla-exec adapter (and its generated world manifest) from this tree.
#
# The world pack is a tar of CarlaUnreal/Content paths, extracted read-only from
# a cook image built by the SAME engine binary (the build refuses otherwise):
# the worlds' packages plus their transitive /Game dependencies that the base
# lacks. It never replaces a content file the base already ships.
#
# It DOES replace CarlaUnreal/AssetRegistry.bin with the cook image's registry
# (CARLA_ASSET_REGISTRY_URL/SHA256). A cooked UE build resolves packages
# through that registry: without it the added worlds are listed but
# load_world silently opens the default world (Town10HD_Opt) instead. The
# cook's registry was checked to expose the identical blueprint library as the
# base's (171 blueprints incl. vehicle.kia.carnival and all walkers) and to load
# the base worlds; the runtime's digest binding would refuse any world that
# silently fell back, but the build should not ship one that does.
#
# Both inputs are fetched by URL on the builder and checked against their
# sha256; neither is part of the local build context.
#
#   depot build -f services/render-worker/docker/carla-worlds.Dockerfile \
#     --build-context carla-exec=adapters/carla-exec \
#     --build-arg CARLA_WORKER_IMAGE=<registry>/<repo>@sha256:<approved worker> \
#     --build-arg CARLA_WORLD_PACK_URL=<https url> --build-arg CARLA_WORLD_PACK_SHA256=<sha256> \
#     --build-arg CARLA_ASSET_REGISTRY_URL=<https url> --build-arg CARLA_ASSET_REGISTRY_SHA256=<sha256> \
#     --build-arg CARLA_WORLDS="Saratoga_School_Area San_Ramon_Phase_1_P1 San_Ramon_Phase_1_P2" \
#     --build-arg CARLA_ENGINE_BINARY_SHA256=<sha256 of CarlaUnreal-Linux-Shipping in the cook image> \
#     --build-arg SOURCE_REVISION=<40-hex> --build-arg IMAGE_VERSION=<version> \
#     services/render-worker/docker
ARG CARLA_WORKER_IMAGE

FROM busybox:1.36.1 AS world-pack
ARG CARLA_WORLD_PACK_URL
ARG CARLA_WORLD_PACK_SHA256
ARG CARLA_ASSET_REGISTRY_URL
ARG CARLA_ASSET_REGISTRY_SHA256
ADD --checksum=sha256:${CARLA_WORLD_PACK_SHA256} ${CARLA_WORLD_PACK_URL} /pack.tar
ADD --checksum=sha256:${CARLA_ASSET_REGISTRY_SHA256} ${CARLA_ASSET_REGISTRY_URL} /AssetRegistry.bin
RUN mkdir /out && tar -xf /pack.tar -C /out && rm /pack.tar \
 && test -d /out/CarlaUnreal/Content && test ! -e /out/CarlaUnreal/AssetRegistry.bin \
 && mv /AssetRegistry.bin /out/CarlaUnreal/AssetRegistry.bin

FROM python:3.12.10-slim-bookworm AS python-build
WORKDIR /src
COPY --from=carla-exec / ./carla-exec
RUN rm -rf ./carla-exec/.venv ./carla-exec/.pytest_cache \
 && python -m pip wheel --no-cache-dir --wheel-dir /wheels ./carla-exec

FROM ${CARLA_WORKER_IMAGE} AS runtime
ARG SOURCE_REVISION
ARG IMAGE_VERSION
ARG CARLA_WORLDS
ARG CARLA_WORLD_PACK_SHA256
ARG CARLA_ENGINE_BINARY_SHA256
ARG CARLA_WORLD_PACK_ORIGIN
ARG CARLA_ASSET_REGISTRY_SHA256
USER root
# The pack's worlds were cooked by one engine build; loose cooked packages are
# only valid for that build. Refuse to stack them on any other binary.
RUN test -n "$SOURCE_REVISION" && test -n "$IMAGE_VERSION" && test -n "$CARLA_WORLDS" \
 && echo "$CARLA_ENGINE_BINARY_SHA256  /home/carla/CarlaUnreal/Binaries/Linux/CarlaUnreal-Linux-Shipping" | sha256sum -c -
COPY --from=world-pack --chown=carla:carla /out/ /home/carla/
COPY --from=python-build /wheels /tmp/wheels
RUN python3 -m pip install --no-cache-dir --no-deps --force-reinstall /tmp/wheels/*.whl && rm -rf /tmp/wheels \
 && for world in $CARLA_WORLDS; do \
      test -s "/home/carla/CarlaUnreal/Content/Carla/Maps/$world.umap" \
      && test -s "/home/carla/CarlaUnreal/Content/Carla/Maps/OpenDrive/$world.xodr" || exit 1; \
    done \
 && python3 -c "import hashlib, sys; from simforge_oss_carla_exec import world_manifest as m; \
worlds = {b.world: b for b in m.bindings().values()}; \
bad = [w for w in sys.argv[1:] if w not in worlds or hashlib.sha256(open(f'/home/carla/CarlaUnreal/Content/Carla/Maps/OpenDrive/{w}.xodr','rb').read()).hexdigest() != worlds[w].runtime_xodr_sha256]; \
sys.exit(f'worlds not bound by the manifest or cooked XODR mismatch: {bad}' if bad else 0)" $CARLA_WORLDS
ENV SIMFORGE_SOURCE_REVISION=$SOURCE_REVISION
LABEL org.opencontainers.image.version="$IMAGE_VERSION" \
      org.opencontainers.image.revision="$SOURCE_REVISION" \
      io.simforge.carla.worlds.added="$CARLA_WORLDS" \
      io.simforge.carla.world-pack.sha256="$CARLA_WORLD_PACK_SHA256" \
      io.simforge.carla.world-pack.origin="$CARLA_WORLD_PACK_ORIGIN" \
      io.simforge.carla.asset-registry.sha256="$CARLA_ASSET_REGISTRY_SHA256" \
      io.simforge.carla.engine-binary.sha256="$CARLA_ENGINE_BINARY_SHA256"
USER carla
