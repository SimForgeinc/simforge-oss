# syntax=docker/dockerfile:1.7
# ghcr.io/simforgeinc/simforge-release-build: the Linux build environment for
# release binaries and wheels (dist-workspace.toml, release-wheels.yml).
#
# - manylinux_2_28 (AlmaLinux 8, glibc 2.28): the released binary runs on any
#   glibc >= 2.28 distribution (Ubuntu 20.04+, Debian 11+, RHEL 8+).
# - Rust from rust-toolchain.toml (1.98.0), with the aarch64 target; aarch64 is
#   cross-compiled with cargo-zigbuild (dist picks it when host != target).
# - cargo-auditable, cargo-cyclonedx, cargo-about, cargo-deny, maturin: the
#   versions the release uses, pinned here rather than downloaded per job.
#
# Rebuilt by release-build-image.yml when this file or rust-toolchain.toml
# changes; the tag is the date, referenced from dist-workspace.toml.
ARG BASE=quay.io/pypa/manylinux_2_28_x86_64@sha256:ae21cd1c8220f773f9b5934f3b845d677494d4cd4b8981c1e416f654e8afa74e
FROM ${BASE}

ARG RUST_TOOLCHAIN=1.98.0
ARG ZIG_VERSION=0.15.2
ARG CARGO_ZIGBUILD_VERSION=0.23.4
ARG CARGO_AUDITABLE_VERSION=0.7.6
ARG CARGO_CYCLONEDX_VERSION=0.5.9
ARG CARGO_ABOUT_VERSION=0.9.2
ARG CARGO_DENY_VERSION=0.20.2
ARG MATURIN_VERSION=1.15.0

# Build-time system libraries the renderer links today (Bevy's audio, input
# and window crates). The aarch64 cross build cannot link these (no arm64
# sysroot here): the CLI must be built headless for aarch64 to succeed.
RUN set -eux; \
    dnf install -y --setopt=install_weak_deps=False \
      alsa-lib-devel systemd-devel wayland-devel libxkbcommon-devel \
      pkgconf-pkg-config clang jq git xz; \
    dnf clean all

# CPython 3.12 first on PATH: the release scripts need tomllib (3.11+).
ENV RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo PATH=/opt/cargo/bin:/opt/python/cp312-cp312/bin:$PATH
RUN set -eux; \
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path \
      --profile minimal --default-toolchain "${RUST_TOOLCHAIN}" \
      --target x86_64-unknown-linux-gnu --target aarch64-unknown-linux-gnu; \
    rustup component add --toolchain "${RUST_TOOLCHAIN}" rustfmt clippy; \
    chmod -R a+rwX /opt/rustup /opt/cargo

RUN set -eux; \
    /opt/python/cp312-cp312/bin/pip install --no-cache-dir "ziglang==${ZIG_VERSION}" "maturin==${MATURIN_VERSION}" "build==1.6.1"; \
    ln -s /opt/python/cp312-cp312/bin/python-zig /usr/local/bin/python-zig 2>/dev/null || true; \
    ln -s /opt/python/cp312-cp312/bin/maturin /usr/local/bin/maturin; \
    printf '#!/bin/sh\nexec /opt/python/cp312-cp312/bin/python -m ziglang "$@"\n' > /usr/local/bin/zig; \
    chmod +x /usr/local/bin/zig; zig version

# The build host is shared: cap cargo's parallelism for the tool installs.
ARG CARGO_BUILD_JOBS=4
RUN set -eux; \
    export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS}"; \
    cargo install --locked "cargo-zigbuild@${CARGO_ZIGBUILD_VERSION}"; \
    cargo install --locked "cargo-auditable@${CARGO_AUDITABLE_VERSION}"; \
    cargo install --locked "cargo-cyclonedx@${CARGO_CYCLONEDX_VERSION}"; \
    cargo install --locked --features cli "cargo-about@${CARGO_ABOUT_VERSION}"; \
    cargo install --locked "cargo-deny@${CARGO_DENY_VERSION}"; \
    rm -rf /opt/cargo/registry /opt/cargo/git; \
    chmod -R a+rwX /opt/cargo; \
    # cargo install only warns when a binary needs a feature: fail here instead.
    cargo-zigbuild --version; cargo-cyclonedx cyclonedx --help >/dev/null; \
    cargo-about --version; cargo-deny --version; test -x /opt/cargo/bin/cargo-auditable

LABEL org.opencontainers.image.source="https://github.com/SimForgeinc/simforge-sdk" \
      org.opencontainers.image.description="SimForge release build environment (manylinux_2_28, Rust, zig, dist helpers)" \
      org.opencontainers.image.licenses="Apache-2.0"
