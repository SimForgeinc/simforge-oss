/**
 * Alpamayo model catalog: the one table every surface reads.
 *
 * Consumed by the desktop model store, the desktop Models screen, the shared
 * evaluation launcher and the SimCloud browser portal. It therefore has
 * **zero imports** — not even type-only ones — so its transitive graph is
 * empty and the map-free browser bundle boundary is provable rather than
 * asserted.
 *
 * Every value was read from the Hugging Face and GitHub APIs at pin time and
 * is mirrored by `adapters/alpamayo/src/simforge_alpamayo/families.py`
 * (Python) and `packages/model-store/models.lock.json` (per-file digests).
 * The lock's zod schema cross-checks this file, so drift is a validation
 * failure rather than a silent product lie.
 *
 * Nothing here is a capability guess. A quantization mode with no measured
 * envelope is `qualification-pending`, not `supported`; a family NVIDIA only
 * validated on an H100 reports `localExecution: 'qualification-pending'`
 * rather than a VRAM number nobody measured.
 *
 * Camera ids are the upstream `CAMERA_NAMES_TO_INDICES` integers, identical
 * across all three upstream packages:
 *   0 cross-left-120  1 front-wide-120  2 cross-right-120  3 rear-left-70
 *   4 rear-tele-30    5 rear-right-70   6 front-tele-30
 */

export type ModelFamilyId = 'alpamayo-1' | 'alpamayo-1.5' | 'alpamayo-2-super';

/** Quantization modes the engines implement. No int8/gptq/awq path exists. */
export type ModelQuant = 'bf16' | 'nf4' | 'fp8';

/**
 * `supported` means a measured or vendor-published envelope exists.
 * `qualification-pending` means the recipe is wired but unmeasured, so the
 * product must not offer it as working. `unsupported` means no recipe exists.
 */
export type ModelQuantStatus = 'supported' | 'qualification-pending' | 'unsupported';

export type ModelExecutionStatus = 'supported' | 'qualification-pending' | 'unsupported';

export type ModelCapabilities = {
  readonly trajectory: boolean;
  readonly vqa: boolean;
  readonly nav: boolean;
  readonly metaActions: boolean;
  readonly autolabel: boolean;
  readonly grounding: boolean;
};

export type ModelQuantOffer = {
  readonly quant: ModelQuant;
  readonly status: ModelQuantStatus;
  /** Vendor-published or measured requirement; `null` when none may be stated. */
  readonly minVramGiB: number | null;
  readonly note: string;
};

export type ModelSidecar = {
  readonly repo: string;
  readonly revision: string;
  readonly purpose: string;
  /** Hugging Face `gated` value. `'auto'` needs a click-through plus a token. */
  readonly gated: false | 'auto';
  readonly license: string;
  readonly requiresUserToken: boolean;
  /** Files consumed. Never `*.safetensors`: weights come from the checkpoint. */
  readonly files: readonly string[];
};

export type ModelLicense = {
  readonly id: string;
  /** git blob sha of the LICENSE file, identical on all three weight repos. */
  readonly blobSha: string;
  /**
   * True when the model card's prose claims non-commercial use while the
   * LICENSE blob is OpenMDW-1.1. This is an unresolved review gate, not a
   * decision: the UI shows both texts and no code asserts which controls.
   */
  readonly commercialUseReviewRequired: boolean;
  readonly cardConflictNote: string | null;
};

export type ModelCameraContract = {
  /** Exact required set for trajectory inference, or `null` when variable. */
  readonly required: readonly number[] | null;
  readonly variable: boolean;
  readonly default: readonly number[];
  /** Exact set for text/VQA tasks when it differs from `required`. */
  readonly vqa: readonly number[] | null;
  readonly max: number;
};

export type ModelCatalogEntry = {
  readonly family: ModelFamilyId;
  readonly displayName: string;
  readonly vendor: string;
  readonly weightsRepo: string;
  readonly weightsRevision: string;
  readonly codeRepo: string;
  readonly codeRevision: string;
  readonly codeLicense: string;
  readonly pythonPackage: string;
  /** Weight-shard bytes at the pinned revision (HF blob metadata). */
  readonly approxWeightsBytes: number;
  /** Weights plus the isolated Python runtime (torch + CUDA wheels). */
  readonly approxDiskBytes: number;
  readonly license: ModelLicense;
  readonly sidecars: readonly ModelSidecar[];
  /** True only when a sidecar is gated: the user must supply an HF token. */
  readonly requiresUserHfToken: boolean;
  readonly cameras: ModelCameraContract;
  readonly capabilities: ModelCapabilities;
  /** Exact upstream task strings accepted by the text op. */
  readonly textTasks: readonly string[];
  readonly quants: readonly ModelQuantOffer[];
  readonly platforms: readonly string[];
  readonly localExecution: ModelExecutionStatus;
  readonly vendorTestedGpus: readonly string[];
  /** True when cloud execution is the only currently supported path. */
  readonly remoteOnly: boolean;
  readonly paper: string | null;
};

/** Live install state for one family+quant, as the Models screen renders it. */
export type ModelInstallState =
  | { readonly state: 'not_installed' }
  | {
      readonly state: 'downloading';
      readonly bytesDone: number;
      readonly bytesTotal: number;
      readonly filesDone: number;
      readonly filesTotal: number;
      readonly ratePerSec?: number;
      readonly etaSeconds?: number;
      readonly currentFile?: string;
      readonly resumable: true;
      readonly step: ModelInstallStep;
    }
  | {
      readonly state: 'verifying';
      readonly filesDone: number;
      readonly filesTotal: number;
      readonly currentFile?: string;
    }
  | {
      readonly state: 'installed';
      readonly installedAt: string;
      readonly bytesOnDisk: number;
      readonly revision: string;
      readonly checkpointDigest: string;
      readonly digestVerifiedAt: string | null;
      readonly quant: ModelQuant;
    }
  | {
      readonly state: 'paused';
      readonly bytesDone: number;
      readonly bytesTotal: number;
      readonly filesDone: number;
      readonly filesTotal: number;
      readonly resumable: true;
      readonly step: ModelInstallStep;
    }
  | {
      readonly state: 'error';
      readonly code: string;
      readonly message: string;
      readonly retryable: boolean;
      readonly resumable: boolean;
      readonly step: ModelInstallStep;
    };

export type ModelInstallStep =
  | 'preflight'
  | 'license'
  | 'sidecar-license'
  | 'download-weights'
  | 'download-sidecars'
  | 'download-code'
  | 'venv'
  | 'verify'
  | 'register';

/**
 * Download eligibility and execution eligibility are independent, and never
 * collapsed into one boolean: a user with the disk may download Alpamayo 2
 * Super on a machine that cannot execute it, and the honest presentation is
 * "downloaded here, executed in the cloud".
 */
export type ModelExecutionEligibility = {
  readonly family: ModelFamilyId;
  readonly quant: ModelQuant;
  readonly downloadEligible: boolean;
  readonly downloadBlockedReasons: readonly string[];
  readonly executionEligible: boolean;
  readonly qualification: 'qualified' | 'qualification-pending' | 'unsupported';
  readonly tier: 'local-16' | 'local-24' | 'local-80' | 'remote-only' | null;
  readonly reasons: readonly string[];
  readonly requires: {
    readonly vramGiB: number | null;
    readonly diskGiB: number;
    readonly os: string;
    readonly platform: string;
    readonly cuda: string;
    readonly vendorTestedGpus: readonly string[];
  };
  readonly observed: {
    readonly platform: string | null;
    readonly gpuName: string | null;
    readonly vramGiB: number | null;
    readonly freeVramGiB: number | null;
    readonly driver: string | null;
    readonly cudaAvailable: boolean;
    readonly freeDiskGiB: number | null;
    readonly nvcc: string | null;
  };
};

/** Weights license: the same LICENSE blob on all three repositories. */
export const WEIGHTS_LICENSE_ID = 'OpenMDW-1.1';
export const WEIGHTS_LICENSE_BLOB_SHA = 'ec297ac5456384786644013ec196da33b916be97';
export const UPSTREAM_CODE_LICENSE = 'Apache-2.0';

const CARD_CONFLICT_NOTE =
  'The model card states "ready for non-commercial use; commercial licensing ' +
  'available upon request" while the accompanying LICENSE blob is OpenMDW-1.1. ' +
  'Which controls has not been decided; commercial hosting requires a recorded ' +
  'license review. Both texts are shown verbatim and neither is paraphrased.';

/** Runtime (torch + CUDA wheels + upstream deps) for one isolated family env. */
const RUNTIME_BYTES = 10 * 1024 ** 3;

const QWEN3_VL_2B_FILES = [
  'preprocessor_config.json',
  'video_preprocessor_config.json',
  'tokenizer_config.json',
  'tokenizer.json',
  'vocab.json',
  'merges.txt',
  'chat_template.json',
  'config.json',
] as const;

const VLM_CONFIG_FILES = [
  'config.json',
  'generation_config.json',
  'tokenizer_config.json',
  'tokenizer.json',
  'vocab.json',
  'merges.txt',
  'chat_template.json',
  'preprocessor_config.json',
  'video_preprocessor_config.json',
] as const;

const QWEN3_VL_2B_PROCESSOR: ModelSidecar = {
  repo: 'Qwen/Qwen3-VL-2B-Instruct',
  revision: '89644892e4d85e24eaac8bacfd4f463576704203',
  purpose: 'image processor (upstream helper.BASE_PROCESSOR_NAME)',
  gated: false,
  license: 'Apache-2.0',
  requiresUserToken: false,
  files: QWEN3_VL_2B_FILES,
};

const ALPAMAYO_1_WEIGHTS_BYTES = 22_157_195_208;
const ALPAMAYO_1_5_WEIGHTS_BYTES = 22_157_194_524;
const ALPAMAYO_2_WEIGHTS_BYTES = 71_641_163_918;

const ALPAMAYO_1: ModelCatalogEntry = {
  family: 'alpamayo-1',
  displayName: 'Alpamayo 1 Nano (10B)',
  vendor: 'NVIDIA',
  weightsRepo: 'nvidia/Alpamayo-R1-10B',
  weightsRevision: 'dd4a24cacefc9a6477a6dfc7354de2443401409d',
  codeRepo: 'https://github.com/NVlabs/alpamayo',
  codeRevision: '939f9a28378deb7863282ef4a8ac7ecbdac2c8b8',
  codeLicense: UPSTREAM_CODE_LICENSE,
  pythonPackage: 'alpamayo_r1',
  approxWeightsBytes: ALPAMAYO_1_WEIGHTS_BYTES,
  approxDiskBytes: ALPAMAYO_1_WEIGHTS_BYTES + RUNTIME_BYTES,
  license: {
    id: WEIGHTS_LICENSE_ID,
    blobSha: WEIGHTS_LICENSE_BLOB_SHA,
    commercialUseReviewRequired: true,
    cardConflictNote: CARD_CONFLICT_NOTE,
  },
  sidecars: [
    {
      repo: 'Qwen/Qwen3-VL-8B-Instruct',
      revision: '0c351dd01ed87e9c1b53cbc748cba10e6187ff3b',
      purpose:
        'backbone config/tokenizer (upstream ReasoningVLAConfig default vlm_name_or_path)',
      gated: false,
      license: 'Apache-2.0',
      requiresUserToken: false,
      files: VLM_CONFIG_FILES,
    },
    QWEN3_VL_2B_PROCESSOR,
  ],
  requiresUserHfToken: false,
  cameras: { required: [0, 1, 2, 6], variable: false, default: [0, 1, 2, 6], vqa: null, max: 7 },
  capabilities: {
    trajectory: true,
    vqa: false,
    nav: false,
    metaActions: false,
    autolabel: false,
    grounding: false,
  },
  textTasks: [],
  quants: [
    {
      quant: 'bf16',
      status: 'supported',
      minVramGiB: 24,
      note: 'NVIDIA-published minimum (RTX 3090/4090/A5000 tested).',
    },
    {
      quant: 'nf4',
      status: 'qualification-pending',
      minVramGiB: null,
      note:
        'bitsandbytes NF4 recipe is wired, but no measured Alpamayo 1 envelope ' +
        'exists. The 1.5 measurement does not transfer: this backbone is the ' +
        'Qwen3-VL-8B config, not Cosmos-Reason2. No VRAM number is published ' +
        'until a run records one.',
    },
    {
      quant: 'fp8',
      status: 'qualification-pending',
      minVramGiB: null,
      note: 'torchao weight-only FP8 recipe is wired; unmeasured on Alpamayo 1.',
    },
  ],
  platforms: ['linux-x64'],
  localExecution: 'supported',
  vendorTestedGpus: ['RTX 3090', 'RTX 4090', 'A5000'],
  remoteOnly: false,
  paper: 'https://arxiv.org/abs/2511.00088',
};

const ALPAMAYO_1_5: ModelCatalogEntry = {
  family: 'alpamayo-1.5',
  displayName: 'Alpamayo 1.5 Nano (10B)',
  vendor: 'NVIDIA',
  weightsRepo: 'nvidia/Alpamayo-1.5-10B',
  weightsRevision: '7aba8293c09993f2e125c6819df05d7fa3e873ea',
  codeRepo: 'https://github.com/NVlabs/alpamayo1.5',
  codeRevision: '24179cfa8b2eeaf775e9e21698b23af0f899522d',
  codeLicense: UPSTREAM_CODE_LICENSE,
  pythonPackage: 'alpamayo1_5',
  approxWeightsBytes: ALPAMAYO_1_5_WEIGHTS_BYTES,
  approxDiskBytes: ALPAMAYO_1_5_WEIGHTS_BYTES + RUNTIME_BYTES,
  license: {
    id: WEIGHTS_LICENSE_ID,
    blobSha: WEIGHTS_LICENSE_BLOB_SHA,
    commercialUseReviewRequired: true,
    cardConflictNote: CARD_CONFLICT_NOTE,
  },
  sidecars: [
    {
      repo: 'nvidia/Cosmos-Reason2-8B',
      revision: 'a9fae2cf89dc64db96b12860417f0eb403013bb9',
      purpose: 'backbone config/tokenizer (checkpoint config.json vlm_name_or_path)',
      gated: 'auto',
      license: 'NVIDIA Open Model License',
      requiresUserToken: true,
      files: VLM_CONFIG_FILES,
    },
    QWEN3_VL_2B_PROCESSOR,
  ],
  requiresUserHfToken: true,
  cameras: { required: null, variable: true, default: [0, 1, 2, 6], vqa: null, max: 7 },
  capabilities: {
    trajectory: true,
    vqa: true,
    nav: true,
    metaActions: false,
    autolabel: false,
    grounding: false,
  },
  textTasks: ['vqa'],
  quants: [
    {
      quant: 'bf16',
      status: 'supported',
      minVramGiB: 24,
      note:
        'NVIDIA-published minimum; approximately 40 GiB at 16 samples and ' +
        '60 GiB with CFG-nav.',
    },
    {
      quant: 'nf4',
      status: 'supported',
      minVramGiB: 12,
      note:
        'bitsandbytes NF4 + double quantization, bf16 compute. The 12 GiB ' +
        'figure comes from a PRIOR runtime (RTX 5080 16 GiB, driver 595.84, ' +
        'torch 2.8.0+cu128): 8.71 GiB peak at 2 cameras, 10.10 GiB at 7, one ' +
        'sample. It is camera-count and sample-count dependent and has not been ' +
        're-measured on the pinned release runtime, so a 16 GiB host is ' +
        'qualified for the measured profiles, not for every profile. ' +
        'Quantization changes behaviour, not only numerics: an NF4 score is ' +
        'never comparable to a BF16 baseline without the quant label.',
    },
    {
      quant: 'fp8',
      status: 'qualification-pending',
      minVramGiB: null,
      note:
        'torchao Float8WeightOnly (e4m3). NOT qualified: the only measured ' +
        'evidence on a 16 GiB device is an out-of-memory failure at 4 cameras, ' +
        'so no 16 GiB envelope may be claimed. A release-runtime measurement ' +
        'per camera count and sample count is required before this mode is offered.',
    },
  ],
  platforms: ['linux-x64'],
  localExecution: 'supported',
  vendorTestedGpus: ['H100 80GB HBM3'],
  remoteOnly: false,
  paper: 'https://arxiv.org/abs/2511.00088',
};

const ALPAMAYO_2_SUPER: ModelCatalogEntry = {
  family: 'alpamayo-2-super',
  displayName: 'Alpamayo 2 Super (35B)',
  vendor: 'NVIDIA',
  weightsRepo: 'nvidia/Alpamayo2-Super',
  weightsRevision: '00554695e729a6ff0b6281fd2c81b18d06e33dbe',
  codeRepo: 'https://github.com/NVlabs/alpamayo2',
  codeRevision: 'beb2977d9a7e9d66837d4a3ad5144ff59de37519',
  codeLicense: UPSTREAM_CODE_LICENSE,
  pythonPackage: 'alpamayo2_super',
  approxWeightsBytes: ALPAMAYO_2_WEIGHTS_BYTES,
  approxDiskBytes: ALPAMAYO_2_WEIGHTS_BYTES + RUNTIME_BYTES,
  license: {
    id: WEIGHTS_LICENSE_ID,
    blobSha: WEIGHTS_LICENSE_BLOB_SHA,
    // This card omits the non-commercial sentence the other two carry.
    commercialUseReviewRequired: false,
    cardConflictNote: null,
  },
  // Self-contained: tokenizer, processor and chat template ship in the repo.
  sidecars: [],
  requiresUserHfToken: false,
  cameras: {
    required: [0, 1, 2, 3, 5, 6],
    variable: false,
    default: [0, 1, 2, 3, 5, 6],
    vqa: [0, 1, 2, 3, 4, 5],
    max: 7,
  },
  capabilities: {
    trajectory: true,
    vqa: true,
    nav: true,
    metaActions: true,
    autolabel: true,
    grounding: true,
  },
  textTasks: ['vqa', 'meta_action', 'auto_labeling', 'grounding'],
  quants: [
    {
      quant: 'bf16',
      status: 'supported',
      minVramGiB: 80,
      note:
        'NVIDIA measured a 72,115 MiB device peak (7 cameras, 1 sample, SDPA, ' +
        '10 diffusion steps) on an H100 80GB. No smaller device is validated.',
    },
    {
      quant: 'nf4',
      status: 'unsupported',
      minVramGiB: null,
      note:
        'No upstream or measured quantized recipe exists for the 32B Cosmos 3 ' +
        'Super backbone. Offering one would be a guess.',
    },
  ],
  platforms: ['linux-x64'],
  // Downloads anywhere with the disk; executes only where qualified.
  localExecution: 'qualification-pending',
  vendorTestedGpus: ['H100 80GB HBM3'],
  remoteOnly: true,
  paper: null,
};

export const MODEL_FAMILIES: readonly ModelFamilyId[] = [
  'alpamayo-1',
  'alpamayo-1.5',
  'alpamayo-2-super',
];

export const MODEL_CATALOG: Readonly<Record<ModelFamilyId, ModelCatalogEntry>> = {
  'alpamayo-1': ALPAMAYO_1,
  'alpamayo-1.5': ALPAMAYO_1_5,
  'alpamayo-2-super': ALPAMAYO_2_SUPER,
};

export const MODEL_QUANTS_BY_FAMILY: Readonly<Record<ModelFamilyId, readonly ModelQuant[]>> = {
  'alpamayo-1': ['bf16', 'nf4', 'fp8'],
  'alpamayo-1.5': ['bf16', 'nf4', 'fp8'],
  'alpamayo-2-super': ['bf16', 'nf4'],
};

/** Rig presets, mirroring `packages/scenario` sensor-rig ids. */
export const MODEL_RIG_PRESETS: Readonly<Record<string, readonly number[]>> = {
  'alpamayo-2cam': [1, 6],
  'alpamayo-4cam': [0, 1, 2, 6],
  'alpamayo-6cam': [0, 1, 2, 3, 5, 6],
  'alpamayo-6cam-vqa': [0, 1, 2, 3, 4, 5],
};

export function isModelFamilyId(value: string): value is ModelFamilyId {
  return (MODEL_FAMILIES as readonly string[]).includes(value);
}

/** Catalog entry for a family id, or `undefined` for an unknown id. */
export function catalogEntry(family: string): ModelCatalogEntry | undefined {
  return isModelFamilyId(family) ? MODEL_CATALOG[family] : undefined;
}

/** The offer for one family+quant, or `undefined` when not offered at all. */
export function quantOffer(family: string, quant: string): ModelQuantOffer | undefined {
  return catalogEntry(family)?.quants.find((offer) => offer.quant === quant);
}

/** Rig-preset id for a camera set, or `null` — never a nearest match. */
export function rigPresetForCameras(cameraIds: readonly number[]): string | null {
  const wanted = [...cameraIds].sort((a, b) => a - b).join(',');
  for (const [preset, ids] of Object.entries(MODEL_RIG_PRESETS)) {
    if ([...ids].sort((a, b) => a - b).join(',') === wanted) return preset;
  }
  return null;
}
