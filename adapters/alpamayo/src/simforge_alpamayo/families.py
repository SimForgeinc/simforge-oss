"""Family descriptors for the three Alpamayo model generations.

One record per family: the pinned upstream weights revision, the pinned
upstream inference-code commit, the sidecar repos the checkpoint needs at
load time, the camera contract the engine enforces, and the quantization
modes that are actually supported (as opposed to merely conceivable).

Every value here was read from the Hugging Face and GitHub APIs at pin time
and is mirrored byte-for-byte by ``studio/app/lib/models/store/catalog.ts``
(TypeScript, browser-safe) and by ``studio/app/lib/models/models.lock.json``
(digests). ``tests/test_families.py`` asserts the three stay in agreement, so
a drift is a test failure rather than a silent product lie.

Camera ids are the upstream ``CAMERA_NAMES_TO_INDICES`` integers, identical
in all three upstream packages:

    0 cross-left-120  1 front-wide-120  2 cross-right-120  3 rear-left-70
    4 rear-tele-30    5 rear-right-70   6 front-tele-30
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

FamilyId = Literal["alpamayo-1", "alpamayo-1.5", "alpamayo-2-super"]

#: Quantization modes the engines implement. There is deliberately no int8,
#: gptq or awq path: none is implemented, so none is advertised.
Quant = Literal["bf16", "nf4", "fp8"]

#: A quant is only ``supported`` when a measured envelope exists for it.
#: ``qualification-pending`` means the recipe is wired but no measurement has
#: been recorded yet, and the product must not offer it as if it worked.
QuantStatus = Literal["supported", "qualification-pending", "unsupported"]


@dataclass(frozen=True)
class Sidecar:
    """A non-weight repo the checkpoint needs at load time."""

    repo: str
    revision: str
    purpose: str
    #: HF ``gated`` value: ``False`` or the string ``"auto"``.
    gated: bool | str
    license: str
    #: Files actually consumed. Weights are never fetched from a sidecar.
    files: tuple[str, ...]

    @property
    def requires_user_token(self) -> bool:
        return self.gated is not False


@dataclass(frozen=True)
class QuantOffer:
    quant: str
    status: QuantStatus
    #: NVIDIA-published requirement, or a measured value. ``None`` when no
    #: number may honestly be stated yet.
    min_vram_gib: float | None
    note: str


@dataclass(frozen=True)
class Cameras:
    """The camera contract the engine enforces on every observation."""

    #: Exact required set for trajectory inference, or ``None`` when variable.
    required: tuple[int, ...] | None
    variable: bool
    #: What the product sends when the user does not choose.
    default: tuple[int, ...]
    #: Exact set for text/VQA tasks when it differs from ``required``.
    vqa: tuple[int, ...] | None = None
    max_cameras: int = 7


@dataclass(frozen=True)
class Capabilities:
    trajectory: bool = True
    vqa: bool = False
    nav: bool = False
    meta_actions: bool = False
    autolabel: bool = False
    grounding: bool = False

    def as_dict(self) -> dict[str, bool]:
        return {
            "trajectory": self.trajectory,
            "vqa": self.vqa,
            "nav": self.nav,
            "meta_actions": self.meta_actions,
            "autolabel": self.autolabel,
            "grounding": self.grounding,
        }


@dataclass(frozen=True)
class Family:
    family: FamilyId
    display_name: str
    weights_repo: str
    weights_revision: str
    code_repo: str
    code_revision: str
    #: Upstream python package name; also the vendor subdirectory name.
    package: str
    #: Directory under ``adapters/alpamayo/vendor`` that ``setup.sh`` creates.
    vendor_dir: str
    engine_module: str
    engine_class: str
    sidecars: tuple[Sidecar, ...]
    cameras: Cameras
    capabilities: Capabilities
    quants: tuple[QuantOffer, ...]
    #: Bytes of the weight shards at the pinned revision (HF ``usedStorage``
    #: for the safetensors set), used for disk preflight.
    weights_bytes: int
    #: Vendor-tested devices, verbatim from the model card.
    vendor_tested_gpus: tuple[str, ...]
    local_execution: Literal["supported", "qualification-pending", "unsupported"]
    #: Model card asserts non-commercial while LICENSE is OpenMDW-1.1.
    card_commercial_conflict: bool
    #: Upstream task name accepted by the family's text path, if any.
    text_tasks: tuple[str, ...] = field(default_factory=tuple)

    @property
    def requires_user_token(self) -> bool:
        return any(sidecar.requires_user_token for sidecar in self.sidecars)

    def quant(self, quant: str) -> QuantOffer:
        for offer in self.quants:
            if offer.quant == quant:
                return offer
        raise UnknownQuant(
            f"{self.family} has no quant {quant!r}; offered: "
            f"{[offer.quant for offer in self.quants]}"
        )

    def supports_op(self, op: str) -> bool:
        if op == "act":
            return self.capabilities.trajectory
        if op == "text":
            return bool(self.text_tasks)
        return False

    def camera_contract(self, task: str = "act") -> tuple[tuple[int, ...] | None, bool]:
        """``(required set | None, variable)`` for one task."""
        if task == "text" and self.cameras.vqa is not None:
            return self.cameras.vqa, False
        return self.cameras.required, self.cameras.variable


class UnknownFamily(KeyError):
    """Raised for a family id that is not one of the three."""


class UnknownQuant(KeyError):
    """Raised for a quant the family does not offer."""


_QWEN3_VL_2B_PROCESSOR = Sidecar(
    repo="Qwen/Qwen3-VL-2B-Instruct",
    revision="89644892e4d85e24eaac8bacfd4f463576704203",
    purpose="image processor (upstream helper.BASE_PROCESSOR_NAME)",
    gated=False,
    license="Apache-2.0",
    files=(
        "preprocessor_config.json",
        "video_preprocessor_config.json",
        "tokenizer_config.json",
        "tokenizer.json",
        "vocab.json",
        "merges.txt",
        "chat_template.json",
        "config.json",
    ),
)

#: Files a config/tokenizer-only sidecar contributes. No ``*.safetensors``:
#: every weight comes from the Alpamayo checkpoint itself.
_VLM_CONFIG_FILES = (
    "config.json",
    "generation_config.json",
    "tokenizer_config.json",
    "tokenizer.json",
    "vocab.json",
    "merges.txt",
    "chat_template.json",
    "preprocessor_config.json",
    "video_preprocessor_config.json",
)

ALPAMAYO_1 = Family(
    family="alpamayo-1",
    display_name="Alpamayo 1 Nano (10B)",
    weights_repo="nvidia/Alpamayo-R1-10B",
    weights_revision="dd4a24cacefc9a6477a6dfc7354de2443401409d",
    code_repo="https://github.com/NVlabs/alpamayo",
    code_revision="939f9a28378deb7863282ef4a8ac7ecbdac2c8b8",
    package="alpamayo_r1",
    vendor_dir="alpamayo",
    engine_module="simforge_alpamayo.engine_a1",
    engine_class="AlpamayoR1Engine",
    sidecars=(
        Sidecar(
            repo="Qwen/Qwen3-VL-8B-Instruct",
            revision="0c351dd01ed87e9c1b53cbc748cba10e6187ff3b",
            purpose="backbone config/tokenizer (ReasoningVLAConfig default vlm_name_or_path)",
            gated=False,
            license="Apache-2.0",
            files=_VLM_CONFIG_FILES,
        ),
        _QWEN3_VL_2B_PROCESSOR,
    ),
    # Upstream load_physical_aiavdataset selects exactly [0, 1, 2, 6]; the
    # checkpoint has no camera-count conditioning, so a different set is a
    # rejected input rather than a degraded one.
    cameras=Cameras(required=(0, 1, 2, 6), variable=False, default=(0, 1, 2, 6)),
    capabilities=Capabilities(trajectory=True),
    quants=(
        QuantOffer(
            quant="bf16",
            status="supported",
            min_vram_gib=24.0,
            note="NVIDIA-published minimum (RTX 3090/4090/A5000 tested).",
        ),
        QuantOffer(
            quant="nf4",
            status="qualification-pending",
            min_vram_gib=None,
            note=(
                "bitsandbytes NF4 recipe is wired, but no measured A1 envelope "
                "exists. The 1.5 measurement does not transfer: A1's backbone "
                "is the Qwen3-VL-8B config, not Cosmos-Reason2. No VRAM number "
                "is published until a run records one."
            ),
        ),
        QuantOffer(
            quant="fp8",
            status="qualification-pending",
            min_vram_gib=None,
            note="torchao weight-only FP8 recipe is wired; unmeasured on A1.",
        ),
    ),
    weights_bytes=22_157_195_208,
    vendor_tested_gpus=("RTX 3090", "RTX 4090", "A5000"),
    local_execution="supported",
    card_commercial_conflict=True,
)

ALPAMAYO_1_5 = Family(
    family="alpamayo-1.5",
    display_name="Alpamayo 1.5 Nano (10B)",
    weights_repo="nvidia/Alpamayo-1.5-10B",
    weights_revision="7aba8293c09993f2e125c6819df05d7fa3e873ea",
    code_repo="https://github.com/NVlabs/alpamayo1.5",
    code_revision="24179cfa8b2eeaf775e9e21698b23af0f899522d",
    package="alpamayo1_5",
    vendor_dir="alpamayo1.5",
    engine_module="simforge_alpamayo.engine_a15",
    engine_class="Alpamayo15Engine",
    sidecars=(
        Sidecar(
            repo="nvidia/Cosmos-Reason2-8B",
            revision="a9fae2cf89dc64db96b12860417f0eb403013bb9",
            purpose="backbone config/tokenizer (config.json vlm_name_or_path)",
            gated="auto",
            license="NVIDIA Open Model License",
            files=_VLM_CONFIG_FILES,
        ),
        _QWEN3_VL_2B_PROCESSOR,
    ),
    cameras=Cameras(required=None, variable=True, default=(0, 1, 2, 6)),
    capabilities=Capabilities(trajectory=True, vqa=True, nav=True),
    quants=(
        QuantOffer(
            quant="bf16",
            status="supported",
            min_vram_gib=24.0,
            note="NVIDIA-published minimum; ~40 GiB at 16 samples, ~60 GiB with CFG.",
        ),
        QuantOffer(
            quant="nf4",
            status="supported",
            min_vram_gib=12.0,
            note=(
                "bitsandbytes NF4 + double quant, bf16 compute. The 12 GiB "
                "figure comes from a PRIOR runtime (RTX 5080 16 GiB, driver "
                "595.84, torch 2.8.0+cu128): 8.71 GiB peak at 2 cameras, "
                "10.10 GiB at 7, 1 sample. It is camera-count and "
                "sample-count dependent and has NOT been re-measured on the "
                "pinned release runtime; a 16 GiB host is qualified for the "
                "profiles that were measured, not for every profile. "
                "Quantization changes behaviour, not only numerics: never "
                "compare an NF4 score against a BF16 baseline without the label."
            ),
        ),
        QuantOffer(
            quant="fp8",
            status="qualification-pending",
            min_vram_gib=None,
            note=(
                "torchao Float8WeightOnly (e4m3). NOT qualified: the only "
                "measured evidence on a 16 GiB device is an OUT-OF-MEMORY "
                "failure at 4 cameras, so no 16 GiB envelope may be claimed. "
                "A release-runtime measurement per camera count and sample "
                "count is required before this mode is offered."
            ),
        ),
    ),
    weights_bytes=22_157_194_524,
    vendor_tested_gpus=("H100 80GB HBM3",),
    local_execution="supported",
    card_commercial_conflict=True,
    text_tasks=("vqa",),
)

ALPAMAYO_2_SUPER = Family(
    family="alpamayo-2-super",
    display_name="Alpamayo 2 Super (35B)",
    weights_repo="nvidia/Alpamayo2-Super",
    weights_revision="00554695e729a6ff0b6281fd2c81b18d06e33dbe",
    code_repo="https://github.com/NVlabs/alpamayo2",
    code_revision="beb2977d9a7e9d66837d4a3ad5144ff59de37519",
    package="alpamayo2_super",
    vendor_dir="alpamayo2",
    engine_module="simforge_alpamayo.engine_a2",
    engine_class="Alpamayo2SuperEngine",
    # Self-contained: tokenizer, processor and chat template ship in the repo.
    sidecars=(),
    cameras=Cameras(
        required=(0, 1, 2, 3, 5, 6),
        variable=False,
        default=(0, 1, 2, 3, 5, 6),
        vqa=(0, 1, 2, 3, 4, 5),
    ),
    capabilities=Capabilities(
        trajectory=True,
        vqa=True,
        nav=True,
        meta_actions=True,
        autolabel=True,
        grounding=True,
    ),
    quants=(
        QuantOffer(
            quant="bf16",
            status="supported",
            min_vram_gib=80.0,
            note=(
                "NVIDIA measured 72,115 MiB device peak (7-cam, 1 sample, SDPA, "
                "10 diffusion steps) on an H100 80GB. No smaller device is "
                "validated."
            ),
        ),
        QuantOffer(
            quant="nf4",
            status="unsupported",
            min_vram_gib=None,
            note=(
                "No upstream or measured quantized recipe exists for the 32B "
                "Cosmos 3 Super backbone. Offering it would be a guess."
            ),
        ),
    ),
    weights_bytes=71_641_163_918,
    vendor_tested_gpus=("H100 80GB HBM3",),
    # A2 downloads anywhere with the disk; it executes only where qualified.
    local_execution="qualification-pending",
    card_commercial_conflict=False,
    text_tasks=("vqa", "meta_action", "auto_labeling", "grounding"),
)

FAMILIES: dict[str, Family] = {
    ALPAMAYO_1.family: ALPAMAYO_1,
    ALPAMAYO_1_5.family: ALPAMAYO_1_5,
    ALPAMAYO_2_SUPER.family: ALPAMAYO_2_SUPER,
}

FAMILY_IDS: tuple[str, ...] = tuple(FAMILIES)

#: Weights license, identical blob on all three repos.
WEIGHTS_LICENSE = "OpenMDW-1.1"
WEIGHTS_LICENSE_BLOB_SHA = "ec297ac5456384786644013ec196da33b916be97"

#: Upstream inference code license (all three GitHub repos).
CODE_LICENSE = "Apache-2.0"

#: The gated dataset every upstream parity script streams from. Needed only
#: for parity runs, never for product inference.
PARITY_DATASET = "nvidia/PhysicalAI-Autonomous-Vehicles"
PARITY_DATASET_GATED = "auto"


def get_family(family: str) -> Family:
    try:
        return FAMILIES[family]
    except KeyError:
        raise UnknownFamily(
            f"unknown family {family!r}; known: {list(FAMILIES)}"
        ) from None


def checkpoint_digest(shard_digests: list[tuple[str, str]]) -> str:
    """Stable model identity from the lock's ordered shard digests.

    ``shard_digests`` is ``[(filename, sha256), ...]`` in index order. The
    digest is sha256 over ``"<name> <sha256>\\n"`` lines, so it is derived
    entirely from published upstream metadata and never requires re-hashing
    22-72 GB to state which checkpoint produced a result.
    """
    import hashlib

    hasher = hashlib.sha256()
    for name, digest in shard_digests:
        hasher.update(f"{name} {digest}\n".encode())
    return hasher.hexdigest()
