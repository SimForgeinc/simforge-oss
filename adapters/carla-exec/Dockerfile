# The adapter layered on a CARLA 0.10 image YOU provide. There is no default
# base: build against the CARLA server image you run, pinned by digest, e.g.
#
#   docker build -f Dockerfile \
#     --build-arg CARLA_BASE_IMAGE=<registry>/<carla-0.10-image>@sha256:<manifest> .
#
# The base must ship the CARLA 0.10 PythonAPI wheel matching its server build
# (the adapter declares no `carla` dependency; the client/server pair is part of
# execution provenance), python3 + pip, `xmllint` and `ffmpeg`, and a `carla` user.
#
# Without CARLA_BASE_IMAGE the build fails (an empty FROM is not a valid image).
#
# The image does not claim an identity it was not given. To record the base as a
# pinned runtime image in every render's evidence, pass it too:
#
#   --build-arg SIMFORGE_CARLA_RUNTIME_IMAGE=<repository>@sha256:<linux/amd64 manifest>
#   --build-arg SIMFORGE_CARLA_RUNTIME_IMAGE_INDEX_DIGEST=sha256:<OCI index>   (optional)
#
# Left empty, renders record the server as user-provided (README, "Bring your
# own CARLA 0.10"). `exact: true` additionally needs the running image to attest
# its manifest in SIMFORGE_CARLA_IMAGE_MANIFEST_SHA256.
ARG CARLA_BASE_IMAGE
FROM ${CARLA_BASE_IMAGE}
ARG SIMFORGE_CARLA_RUNTIME_IMAGE=
ARG SIMFORGE_CARLA_RUNTIME_IMAGE_INDEX_DIGEST=

USER root
WORKDIR /opt/simforge-oss-carla-exec
COPY . /opt/simforge-oss-carla-exec
RUN python3 -m pip install --no-cache-dir --no-deps /opt/simforge-oss-carla-exec

ENV SIMFORGE_CARLA_RUNTIME_IMAGE=${SIMFORGE_CARLA_RUNTIME_IMAGE} \
    SIMFORGE_CARLA_RUNTIME_IMAGE_INDEX_DIGEST=${SIMFORGE_CARLA_RUNTIME_IMAGE_INDEX_DIGEST}

USER carla
ENTRYPOINT ["simforge-oss-carla-exec"]
