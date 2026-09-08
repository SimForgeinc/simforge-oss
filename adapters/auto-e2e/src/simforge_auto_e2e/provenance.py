"""Extract CODE identity from an MLflow run record.

This exists because the mistake it prevents is one I actually made: I read a
40-hex string out of a run's metadata and reported it as the revision that
trained the model. It was the validation split manifest's revision. Any
40-hex scanner will make that error again, so identity is resolved from
known-meaning keys and dataset/split/audit provenance is explicitly excluded
rather than merely not-matched.

The two real run records this was built against record NO code revision:
`mlflow.source.type` is LOCAL, `mlflow.source.name` is a Flyte entrypoint,
and the only code identity present is a mutable Docker tag.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

_SHA40 = re.compile(r"^[0-9a-f]{40}$")
#: Exclusion has to cover sha256 digests too. Restricting the scan to 40-hex
#: would leave every checkpoint and audit digest unexamined, which is how a
#: 64-hex value could later be waved through as "the revision".
_HEX_ID = re.compile(r"^[0-9a-f]{40}$|^[0-9a-f]{64}$")

#: Keys whose meaning IS the code revision. MLflow sets the first when a run
#: is launched from a git checkout.
CODE_REVISION_KEYS = (
    "mlflow.source.git.commit",
    "mlflow.source.git.repoURL",
    "code_commit",
    "git_commit",
    "git_sha",
)

#: Keys that carry a revision or digest of something that is NOT the code.
#: Listed positively so a new data-provenance field cannot be silently
#: promoted to code identity by a substring match.
NON_CODE_REVISION_KEYS = (
    "validation_split.source_revision",
    "validation.source_revision",
    "source_revision",
    "data_fingerprint",
    "checkpoint_sha256",
    "best_checkpoint_sha256",
    "final_checkpoint_sha256",
    "best_trajectory_checkpoint_sha256",
    "navigation_quality_audit_sha256",
    "reconstruction_audit_sha256",
    "packed_contract_digest",
    "validation_group_uid_digest",
    "validation_sample_uid_digest",
    "packed_sample_uid_digest",
    "available_group_uid_digest",
)

#: Substrings that mark a key as data/split/audit provenance.
_NON_CODE_HINTS = ("dataset", "data/", "split", "sample", "group", "audit", "checkpoint")

#: A tag is mutable; only a digest pins an image. Role matters as much as
#: identity: an EVAL image is not the code that trained the weights, and v63
#: records only an eval image, so reporting it unlabelled as "the image"
#: would misattribute training provenance.
_IMAGE_KEYS = (
    ("ctx/train_docker_image", "training"),
    ("docker_image", "training"),
    ("ctx/eval_docker_image", "eval"),
)


def _is_non_code(key: str) -> bool:
    tail = key.split("/")[-1]
    if key in NON_CODE_REVISION_KEYS or tail in NON_CODE_REVISION_KEYS:
        return True
    return any(hint in key.lower() for hint in _NON_CODE_HINTS)


@dataclass
class CodeIdentity:
    """What a run says about the code that produced it."""

    revision: str | None = None
    revision_key: str | None = None
    image: str | None = None
    image_role: str | None = None
    image_is_digest_pinned: bool = False
    source_type: str | None = None
    #: Revision-shaped values deliberately NOT treated as code identity,
    #: recorded so the exclusion is visible rather than invisible.
    excluded: dict[str, str] | None = None

    @property
    def resolvable(self) -> bool:
        """True only when the code can actually be obtained.

        A mutable tag is not identity: `:latest` resolves to different code
        over time, so it cannot reproduce a past run.
        """
        return self.revision is not None or (
            self.image_is_digest_pinned and self.image_role == "training"
        )

    def as_dict(self) -> dict[str, Any]:
        return {
            "schema": "simforge.autoe2e-code-identity/v1",
            "resolvable": self.resolvable,
            "revision": self.revision,
            "revisionKey": self.revision_key,
            "image": self.image,
            "imageRole": self.image_role,
            "imageIsDigestPinned": self.image_is_digest_pinned,
            "sourceType": self.source_type,
            "excludedRevisionShapedValues": dict(self.excluded or {}),
        }


def code_identity(params: dict[str, str], tags: dict[str, str]) -> CodeIdentity:
    """Resolve code identity from a run's params and tags.

    Dataset, split, audit and checkpoint digests are excluded by meaning, not
    by luck: they are revision-shaped and would otherwise be mistaken for a
    code revision.
    """
    merged: dict[str, str] = {**params, **tags}
    identity = CodeIdentity(source_type=merged.get("mlflow.source.type"), excluded={})

    for key in CODE_REVISION_KEYS:
        value = merged.get(key)
        if value and _SHA40.match(value):
            identity.revision, identity.revision_key = value, key
            break

    for key, value in merged.items():
        if not isinstance(value, str) or not _HEX_ID.match(value):
            continue
        if key == identity.revision_key:
            continue
        if _is_non_code(key) or key in NON_CODE_REVISION_KEYS:
            identity.excluded[key] = value

    for key, role in _IMAGE_KEYS:
        image = merged.get(key)
        if image:
            identity.image = image
            identity.image_role = role
            identity.image_is_digest_pinned = "@sha256:" in image
            break

    return identity
