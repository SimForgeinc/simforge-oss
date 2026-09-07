/**
 * The Alpamayo model catalog: static, browser-safe facts about the three model
 * families, shared by the desktop Model Store and the SimCloud web portal.
 *
 * OWNERSHIP — the data in this file is owned by the model-runtime workstream
 * (`AlpamayoRuntime`). It lives here, and not under `studio/app`, because the
 * web portal is a separate application that cannot import from the desktop app
 * yet must name the same families, quantizations, camera requirements and
 * license obligations. `studio/app/lib/models/store/catalog.ts` re-exports this
 * module so the desktop store, its HTTP routes and both UIs read one table.
 *
 * INVARIANTS this file must keep, because both portals depend on them:
 * - Zero imports. No Node, native, torch, zod or React in the transitive graph;
 *   this module is imported by a browser bundle that must stay map/3D-free.
 * - Revisions are pinned. A family without a pinned weights revision cannot be
 *   installed or dispatched, so `weightsRevision` is never a floating ref.
 * - `downloadable` and `localExecution` are independent. Having disk for a
 *   family never implies the machine can execute it; see
 *   {@link ModelExecutionEligibility}, which carries the two as separate flags.
 */

export type ModelFamilyId = "alpamayo-1" | "alpamayo-1.5" | "alpamayo-2-super";

/** Weight precision a family can be prepared and executed in. */
export type ModelQuant = "bf16" | "nf4" | "fp8";

export type ModelCapabilities = {
  /** Predicts future ego trajectories — the only capability open-loop scoring uses. */
  trajectory: boolean;
  /** Answers questions about the scene. Text analysis is never a trajectory score. */
  vqa: boolean;
  /** Accepts a navigation instruction alongside the camera inputs. */
  nav: boolean;
  metaActions: boolean;
  autolabel: boolean;
  grounding: boolean;
};

/**
 * One precision offer for a family.
 *
 * `qualification-pending` is not a softer `supported`: it means no measured
 * VRAM/accuracy envelope exists yet, so the UI must present it as unavailable
 * and say why, never as a choice the user can rely on.
 */
export type ModelQuantOffer = {
  quant: ModelQuant;
  status: "supported" | "qualification-pending" | "unsupported";
  /** Device memory the measured profile needs, or null when unmeasured. */
  minVramGiB: number | null;
  note: string;
};

export type ModelSidecar = {
  repo: string;
  revision: string;
  /** `'auto'` is Hugging Face's automatic-approval gate: it still needs a user token. */
  gated: false | "auto";
  license: string;
  purpose: string;
  requiresUserToken: boolean;
};

export type ModelLicense = {
  id: string;
  /** Blob sha of the LICENSE file the pinned revision carries. */
  blobSha: string;
  /**
   * The model card's commercial-use wording conflicts with the accompanying
   * license text. Commercial hosting therefore requires a recorded license
   * review; the UI states that obligation rather than resolving it.
   */
  commercialUseReviewRequired: boolean;
  cardConflictNote: string | null;
};

export type ModelCameraProfile = {
  /** Exactly these camera ids, in this order, or null when the family is flexible. */
  required: number[] | null;
  variable: boolean;
  default: number[];
  /** Camera set the VQA head expects, when it differs from the trajectory set. */
  vqa: number[] | null;
  max: number;
};

export type ModelCatalogEntry = {
  family: ModelFamilyId;
  displayName: string;
  vendor: string;
  weightsRepo: string;
  weightsRevision: string;
  codeRepo: string;
  codeRevision: string;
  pythonPackage: string;
  approxWeightsBytes: number;
  /** Weights plus the isolated runtime environment, which is what the disk check needs. */
  approxDiskBytes: number;
  license: ModelLicense;
  sidecars: ModelSidecar[];
  /** True when a gated sidecar makes the user's own Hugging Face token mandatory. */
  requiresUserHfToken: boolean;
  cameras: ModelCameraProfile;
  capabilities: ModelCapabilities;
  /**
   * Upstream task names the family's text head accepts, exactly as the wire
   * spells them (`meta_action`, `auto_labeling`). The boolean capability map
   * above is for presentation; these strings are what a request may carry.
   */
  textTasks: string[];
  quants: ModelQuantOffer[];
  platforms: string[];
  localExecution: "supported" | "qualification-pending" | "unsupported";
  vendorTestedGpus: string[];
  /** No qualified local profile exists: the family runs on managed remote capacity only. */
  remoteOnly: boolean;
};

/** Per-family, per-quant installation state on this machine. Never fabricated. */
export type ModelInstallState =
  | { state: "not_installed" }
  | {
      state: "downloading";
      bytesDone: number;
      bytesTotal: number;
      filesDone: number;
      filesTotal: number;
      ratePerSec?: number;
      etaSeconds?: number;
      currentFile?: string;
      resumable: true;
    }
  | { state: "verifying"; filesDone: number; filesTotal: number; currentFile?: string }
  | {
      state: "installed";
      installedAt: string;
      bytesOnDisk: number;
      revision: string;
      checkpointDigest: string;
      digestVerifiedAt: string;
      quant: ModelQuant;
    }
  | {
      state: "paused";
      bytesDone: number;
      bytesTotal: number;
      filesDone: number;
      filesTotal: number;
      resumable: true;
    }
  | {
      state: "error";
      code: string;
      message: string;
      retryable: boolean;
      resumable: boolean;
      step: ModelInstallStep;
    };

export type ModelInstallStep =
  | "preflight"
  | "license"
  | "sidecar-license"
  | "download-weights"
  | "download-sidecars"
  | "download-code"
  | "venv"
  | "verify"
  | "register";

/**
 * What this machine can actually do with a family/quant.
 *
 * The two eligibility flags are deliberately independent: a user with disk but
 * a small GPU downloads A2-Super and runs it in the cloud. `reasons` is written
 * by the runtime probe and rendered verbatim — the UI never composes its own
 * hardware verdict.
 */
export type ModelExecutionEligibility = {
  family: ModelFamilyId;
  quant: ModelQuant;
  downloadEligible: boolean;
  downloadBlockedReasons: string[];
  executionEligible: boolean;
  qualification: "qualified" | "qualification-pending" | "unsupported";
  tier: "local-16" | "local-24" | "local-80" | "remote-only" | null;
  reasons: string[];
  requires: {
    vramGiB: number | null;
    diskGiB: number | null;
    os: string | null;
    platform: string | null;
    minDriver: string | null;
    cuda: string | null;
  };
  observed: {
    platform: string | null;
    gpuName: string | null;
    vramGiB: number | null;
    driver: string | null;
    cudaAvailable: boolean;
    freeDiskGiB: number | null;
    nvcc: string | null;
  };
};

const OPEN_MDW_BLOB_SHA = "ec297ac5456384786644013ec196da33b916be97";

const QWEN3_VL_2B_PROCESSOR: ModelSidecar = {
  repo: "Qwen/Qwen3-VL-2B-Instruct",
  revision: "89644892e4d85e24eaac8bacfd4f463576704203",
  gated: false,
  license: "Apache-2.0",
  purpose: "Vision/text processor",
  requiresUserToken: false,
};

export const MODEL_FAMILIES: readonly ModelFamilyId[] = [
  "alpamayo-1",
  "alpamayo-1.5",
  "alpamayo-2-super",
] as const;

export const MODEL_CATALOG: Record<ModelFamilyId, ModelCatalogEntry> = {
  "alpamayo-1": {
    family: "alpamayo-1",
    displayName: "Alpamayo 1",
    vendor: "NVIDIA",
    weightsRepo: "nvidia/Alpamayo-R1-10B",
    weightsRevision: "dd4a24cacefc9a6477a6dfc7354de2443401409d",
    codeRepo: "NVlabs/alpamayo",
    codeRevision: "939f9a28378deb7863282ef4a8ac7ecbdac2c8b8",
    pythonPackage: "alpamayo_r1",
    approxWeightsBytes: 22_200_000_000,
    approxDiskBytes: 30_000_000_000,
    license: {
      id: "OpenMDW-1.1",
      blobSha: OPEN_MDW_BLOB_SHA,
      commercialUseReviewRequired: true,
      cardConflictNote:
        "The model card's non-commercial wording conflicts with the accompanying OpenMDW-1.1 text. Commercial hosting requires a recorded license review.",
    },
    sidecars: [
      {
        repo: "Qwen/Qwen3-VL-8B-Instruct",
        revision: "0c351dd01ed87e9c1b53cbc748cba10e6187ff3b",
        gated: false,
        license: "Apache-2.0",
        purpose: "Language/vision configuration",
        requiresUserToken: false,
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
        quant: "bf16",
        status: "supported",
        minVramGiB: 24,
        note: "Upstream BF16 guidance; measured on >=24 GiB devices.",
      },
      {
        quant: "nf4",
        status: "qualification-pending",
        minVramGiB: null,
        note: "No measured NF4 envelope exists for this family yet.",
      },
      {
        quant: "fp8",
        status: "qualification-pending",
        minVramGiB: null,
        note: "Recipe wired, unmeasured on this family.",
      },
    ],
    platforms: ["linux-x64"],
    localExecution: "supported",
    vendorTestedGpus: ["NVIDIA A100 80GB", "NVIDIA H100 80GB"],
    remoteOnly: false,
  },
  "alpamayo-1.5": {
    family: "alpamayo-1.5",
    displayName: "Alpamayo 1.5",
    vendor: "NVIDIA",
    weightsRepo: "nvidia/Alpamayo-1.5-10B",
    weightsRevision: "7aba8293c09993f2e125c6819df05d7fa3e873ea",
    codeRepo: "NVlabs/alpamayo1.5",
    codeRevision: "24179cfa8b2eeaf775e9e21698b23af0f899522d",
    pythonPackage: "alpamayo1_5",
    approxWeightsBytes: 22_200_000_000,
    approxDiskBytes: 38_000_000_000,
    license: {
      id: "OpenMDW-1.1",
      blobSha: OPEN_MDW_BLOB_SHA,
      commercialUseReviewRequired: true,
      cardConflictNote:
        "The model card's non-commercial wording conflicts with the accompanying OpenMDW-1.1 text. Commercial hosting requires a recorded license review.",
    },
    sidecars: [
      {
        repo: "nvidia/Cosmos-Reason2-8B",
        revision: "a9fae2cf89dc64db96b12860417f0eb403013bb9",
        gated: "auto",
        license: "NVIDIA Open Model License",
        purpose: "Reasoning sidecar (gated: requires your Hugging Face token)",
        requiresUserToken: true,
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
    textTasks: ["vqa"],
    quants: [
      { quant: "bf16", status: "supported", minVramGiB: 24, note: "Upstream BF16 reference profile." },
      { quant: "nf4", status: "supported", minVramGiB: 12, note: "Measured 4-bit profile." },
      { quant: "fp8", status: "supported", minVramGiB: 16, note: "Measured 8-bit profile." },
    ],
    platforms: ["linux-x64"],
    localExecution: "supported",
    vendorTestedGpus: ["NVIDIA A100 80GB", "NVIDIA H100 80GB"],
    remoteOnly: false,
  },
  "alpamayo-2-super": {
    family: "alpamayo-2-super",
    displayName: "Alpamayo 2 Super",
    vendor: "NVIDIA",
    weightsRepo: "nvidia/Alpamayo2-Super",
    weightsRevision: "00554695e729a6ff0b6281fd2c81b18d06e33dbe",
    codeRepo: "NVlabs/alpamayo2",
    codeRevision: "beb2977d9a7e9d66837d4a3ad5144ff59de37519",
    pythonPackage: "alpamayo2_super",
    approxWeightsBytes: 71_600_000_000,
    approxDiskBytes: 88_000_000_000,
    license: {
      id: "OpenMDW-1.1",
      blobSha: OPEN_MDW_BLOB_SHA,
      commercialUseReviewRequired: false,
      cardConflictNote: null,
    },
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
    textTasks: ["vqa", "meta_action", "auto_labeling", "grounding"],
    quants: [
      {
        quant: "bf16",
        status: "supported",
        minVramGiB: 80,
        note: "NVIDIA validated on H100 80GB only.",
      },
      {
        quant: "nf4",
        status: "unsupported",
        minVramGiB: null,
        note: "No upstream or measured quantized recipe exists for the 32B backbone.",
      },
    ],
    platforms: ["linux-x64"],
    localExecution: "qualification-pending",
    vendorTestedGpus: ["NVIDIA H100 80GB"],
    remoteOnly: true,
  },
};

export const MODEL_QUANTS_BY_FAMILY: Record<ModelFamilyId, readonly ModelQuant[]> = {
  "alpamayo-1": ["bf16", "nf4", "fp8"],
  "alpamayo-1.5": ["bf16", "nf4", "fp8"],
  "alpamayo-2-super": ["bf16", "nf4"],
};

export function catalogEntry(family: ModelFamilyId): ModelCatalogEntry {
  return MODEL_CATALOG[family];
}

/** The offer for one precision, or undefined when the family does not list it. */
export function quantOffer(family: ModelFamilyId, quant: ModelQuant): ModelQuantOffer | undefined {
  return MODEL_CATALOG[family].quants.find((offer) => offer.quant === quant);
}

/** The family's default precision: the first offer that is actually supported. */
export function defaultQuant(family: ModelFamilyId): ModelQuant {
  const supported = MODEL_CATALOG[family].quants.find((offer) => offer.status === "supported");
  return supported?.quant ?? MODEL_CATALOG[family].quants[0].quant;
}

export function isModelFamilyId(value: unknown): value is ModelFamilyId {
  return typeof value === "string" && (MODEL_FAMILIES as readonly string[]).includes(value);
}
