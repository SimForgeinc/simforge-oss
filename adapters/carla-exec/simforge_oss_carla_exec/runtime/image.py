"""Which CARLA runtime image this process renders on: configuration, not code.

The adapter runs against a CARLA 0.10 server the user provides. It does not
know, and never assumes, which container image (if any) that server came from.
A deployment that pins one declares it in the environment, read once per
process (:func:`runtime_image`):

``SIMFORGE_CARLA_RUNTIME_IMAGE``
    ``<repository>@sha256:<64 hex>``: the pinned image repository and its
    linux/amd64 platform manifest digest.
``SIMFORGE_CARLA_RUNTIME_IMAGE_INDEX_DIGEST`` (optional)
    ``sha256:<64 hex>``: the OCI index digest the platform manifest belongs to.
``SIMFORGE_CARLA_IMAGE_MANIFEST_SHA256`` (optional)
    ``<64 hex>``: the manifest the running image says it is (baked into that
    image). The runtime evidence is ``exact`` only when it equals the pin.
``SIMFORGE_MANAGED_EXECUTION=1``
    Hosted execution: the pin is mandatory, and a render on any other manifest
    fails.

Without a pin the evidence says so (``repository: null``, ``exact: false``,
``provenance: "user-provided"``); it never claims an image nobody configured.
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass
from functools import lru_cache
from typing import Any, Mapping

from .policy import CarlaRenderError

ENV_RUNTIME_IMAGE = "SIMFORGE_CARLA_RUNTIME_IMAGE"
ENV_RUNTIME_IMAGE_INDEX_DIGEST = "SIMFORGE_CARLA_RUNTIME_IMAGE_INDEX_DIGEST"
ENV_CONFIGURED_MANIFEST_SHA256 = "SIMFORGE_CARLA_IMAGE_MANIFEST_SHA256"
ENV_MANAGED_EXECUTION = "SIMFORGE_MANAGED_EXECUTION"

#: The value ``provenance`` takes when no image is pinned.
USER_PROVIDED = "user-provided"

_HEX64 = re.compile(r"^[0-9a-f]{64}$")
_REFERENCE = re.compile(r"^(?P<repository>[a-z0-9][a-z0-9._/:-]*[a-z0-9])@sha256:(?P<digest>[0-9a-f]{64})$")
_INDEX_DIGEST = re.compile(r"^sha256:(?P<digest>[0-9a-f]{64})$")


@dataclass(frozen=True)
class RuntimeImage:
    """The configured CARLA runtime image identity (all ``None`` when unpinned)."""

    repository: str | None
    index_sha256: str | None
    manifest_sha256: str | None
    managed: bool

    @property
    def pinned(self) -> bool:
        return self.repository is not None

    @property
    def index_digest(self) -> str | None:
        return None if self.index_sha256 is None else f"sha256:{self.index_sha256}"

    @property
    def manifest_digest(self) -> str | None:
        return None if self.manifest_sha256 is None else f"sha256:{self.manifest_sha256}"

    def probe_evidence(self) -> dict[str, Any]:
        """``runtimeImage`` in ``simforge.carla-probe/v2``."""
        evidence: dict[str, Any] = {
            "repository": self.repository,
            "indexDigest": self.index_digest,
            "linuxAmd64ManifestDigest": self.manifest_digest,
        }
        if not self.pinned:
            evidence["managed"] = self.managed
            evidence["provenance"] = USER_PROVIDED
        return evidence


def parse_runtime_image(environ: Mapping[str, str]) -> RuntimeImage:
    """Resolve the identity from an environment; fail loudly on a bad or missing pin."""
    managed = environ.get(ENV_MANAGED_EXECUTION) == "1"
    raw = (environ.get(ENV_RUNTIME_IMAGE) or "").strip()
    raw_index = (environ.get(ENV_RUNTIME_IMAGE_INDEX_DIGEST) or "").strip()
    configured = (environ.get(ENV_CONFIGURED_MANIFEST_SHA256) or "").strip()
    if not raw:
        if managed:
            raise CarlaRenderError(
                "carla_runtime_image_unconfigured",
                f"{ENV_MANAGED_EXECUTION}=1 requires {ENV_RUNTIME_IMAGE}=<repository>@sha256:<manifest>: "
                "managed execution never renders on an image it cannot name",
            )
        if raw_index or configured:
            # Half a pin is a deployment mistake, not a user-provided server.
            present = ENV_RUNTIME_IMAGE_INDEX_DIGEST if raw_index else ENV_CONFIGURED_MANIFEST_SHA256
            raise CarlaRenderError(
                "carla_runtime_image_unconfigured",
                f"{present} is set but {ENV_RUNTIME_IMAGE} is not: set the pinned "
                "<repository>@sha256:<manifest> as well, or unset both",
            )
        return RuntimeImage(None, None, None, managed)
    reference = _REFERENCE.fullmatch(raw)
    if reference is None:
        raise CarlaRenderError(
            "carla_runtime_image_malformed",
            f"{ENV_RUNTIME_IMAGE} must be <repository>@sha256:<64 lowercase hex>, got {raw!r}",
        )
    index_sha256 = None
    if raw_index:
        index = _INDEX_DIGEST.fullmatch(raw_index)
        if index is None:
            raise CarlaRenderError(
                "carla_runtime_image_malformed",
                f"{ENV_RUNTIME_IMAGE_INDEX_DIGEST} must be sha256:<64 lowercase hex>, got {raw_index!r}",
            )
        index_sha256 = index.group("digest")
    if configured and not _HEX64.fullmatch(configured):
        raise CarlaRenderError(
            "carla_runtime_image_malformed",
            f"{ENV_CONFIGURED_MANIFEST_SHA256} must be 64 lowercase hex, got {configured!r}",
        )
    return RuntimeImage(reference.group("repository"), index_sha256, reference.group("digest"), managed)


@lru_cache(maxsize=1)
def runtime_image() -> RuntimeImage:
    """The process's identity, resolved from ``os.environ`` on first use and kept."""
    return parse_runtime_image(os.environ)


def runtime_image_evidence(
    image: RuntimeImage, environ: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """``runtimeEvidence.runtimeImage`` for a render.

    With a pin, the record is the one managed workers have always written
    (same keys, same values). Without one, the pinned fields are ``null``,
    ``exact`` is false and ``provenance`` names the server as user-provided.
    """
    env = os.environ if environ is None else environ
    configured_manifest_sha256 = env.get(ENV_CONFIGURED_MANIFEST_SHA256)
    exact = image.pinned and configured_manifest_sha256 == image.manifest_sha256
    if image.managed and not exact:
        raise RuntimeError(
            "managed CARLA execution is not running the pinned runtime image manifest"
        )
    evidence: dict[str, Any] = {
        "repository": image.repository,
        "indexSha256": image.index_sha256,
        "linuxAmd64ManifestSha256": image.manifest_sha256,
        "configuredManifestSha256": configured_manifest_sha256,
        "configuredBlueprintId": env.get("SIMFORGE_CARLA_BLUEPRINT_ID"),
        "configuredClassPath": env.get("SIMFORGE_CARLA_BLUEPRINT_CLASS"),
        "managed": image.managed,
        "exact": exact,
    }
    if not image.pinned:
        evidence["provenance"] = USER_PROVIDED
    return evidence
