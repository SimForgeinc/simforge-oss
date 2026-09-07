"""simforge_alpamayo: local Alpamayo 1 / 1.5 / 2 Super inference services.

One package, three engine backends selected by ``--family``. Each family runs
in its own virtual environment with its own vendored upstream code, because
the three upstream repos pin incompatible dependency sets.

Surfaces:

* ``simforge_alpamayo.server``   — unix-socket MessagePack policy endpoint
  (closed loop; large raw frames never cross HTTP) with an optional HTTP
  facade on the same engine process.
* ``simforge_alpamayo.batch``    — in-process open-loop manifest runner, for
  a cloud worker that wants no HTTP hop.
* ``simforge_alpamayo.client``   — blocking client for the socket endpoint.
* ``simforge_alpamayo.bridge``   — render-bundle -> observation conversion.
* ``simforge_alpamayo.preflight``— revision/digest and runtime qualification.

Family descriptors, pinned revisions and camera contracts live in
``simforge_alpamayo.families``; nothing else hard-codes a revision.
"""

from simforge_alpamayo.families import (  # noqa: F401
    CODE_LICENSE,
    FAMILIES,
    FAMILY_IDS,
    WEIGHTS_LICENSE,
    WEIGHTS_LICENSE_BLOB_SHA,
    Family,
    UnknownFamily,
    UnknownQuant,
    checkpoint_digest,
    get_family,
)

__all__ = [
    "FAMILIES",
    "FAMILY_IDS",
    "Family",
    "UnknownFamily",
    "UnknownQuant",
    "WEIGHTS_LICENSE",
    "WEIGHTS_LICENSE_BLOB_SHA",
    "CODE_LICENSE",
    "checkpoint_digest",
    "get_family",
    "PINS",
    "pins_for",
]


def pins_for(family: str) -> dict[str, str]:
    """Flat pin record for one family, for logs and provenance."""
    spec = get_family(family)
    pins = {
        "family": spec.family,
        "model_repo": spec.weights_repo,
        "model_revision": spec.weights_revision,
        "code_repo": spec.code_repo,
        "inference_code_commit": spec.code_revision,
        "package": spec.package,
    }
    for sidecar in spec.sidecars:
        key = sidecar.repo.split("/")[-1].lower().replace("-", "_")
        pins[f"{key}_repo"] = sidecar.repo
        pins[f"{key}_revision"] = sidecar.revision
    return pins


#: Backwards-compatible alias for the 1.5 pins, which were the only pins this
#: package had before the other two families existed. Prefer ``pins_for``.
PINS = pins_for("alpamayo-1.5")
