import { execFile } from "node:child_process";
import { mkdir, statfs } from "node:fs/promises";
import { arch, platform, release } from "node:os";
import { promisify } from "node:util";
import {
  MODEL_CATALOG,
  MODEL_FAMILIES,
  type ModelExecutionEligibility,
  type ModelFamilyId,
  type ModelQuant,
} from "./catalog";
import { assetsRoot } from "./paths";

/**
 * `simforge.model-preflight/v1` — what this machine is, and what it can
 * actually do with each family.
 *
 * Implemented in TypeScript rather than by shelling into a family's Python
 * environment, because preflight must answer "can I run this?" *before* an
 * install exists. `simforge_alpamayo.preflight --runtime` answers the same
 * question from inside a prepared runtime (and adds torch's own view of the
 * device); the two agree on the rules and differ only in what they can see.
 *
 * The central discipline: **download eligibility and execution eligibility
 * are separate answers.** A machine with 100 GB free and a 16 GB GPU can
 * install Alpamayo 2 Super and cannot execute it, and both facts are reported
 * rather than collapsed into a single "unsupported" that would hide the
 * download the user is entitled to.
 */
export const PREFLIGHT_SCHEMA = "simforge.model-preflight/v1";

/** Free VRAM a resident Bevy sensor pass needs when it shares the device. */
export const RENDERER_HEADROOM_GIB = 3;

/** Isolated per-family Python runtime: torch plus CUDA wheels. */
const RUNTIME_GIB = 10;

const run = promisify(execFile);

export type ObservedHost = {
  readonly platform: string;
  readonly os: string;
  readonly osRelease: string;
  readonly arch: string;
  readonly assetsRoot: string;
  readonly freeDiskGiB: number | null;
  readonly gpuName: string | null;
  readonly vramGiB: number | null;
  readonly freeVramGiB: number | null;
  readonly driver: string | null;
  readonly computeCapability: string | null;
  readonly cudaAvailable: boolean;
  readonly nvcc: string | null;
};

async function nvidiaSmi(): Promise<Partial<ObservedHost>> {
  try {
    const { stdout } = await run(
      "nvidia-smi",
      [
        "--query-gpu=name,memory.total,memory.free,driver_version,compute_cap",
        "--format=csv,noheader,nounits",
      ],
      { timeout: 15_000 },
    );
    const first = stdout.trim().split("\n")[0];
    if (!first) return { cudaAvailable: false };
    const [name, total, free, driver, computeCap] = first.split(",").map((part) => part.trim());
    return {
      gpuName: name || null,
      vramGiB: total ? Math.round((Number(total) / 1024) * 100) / 100 : null,
      freeVramGiB: free ? Math.round((Number(free) / 1024) * 100) / 100 : null,
      driver: driver || null,
      computeCapability: computeCap || null,
      // An NVIDIA driver that answers is a device we can see. Whether torch
      // can use it is verified from inside a prepared runtime, and the
      // reasons[] text says which check produced the verdict.
      cudaAvailable: Boolean(name),
    };
  } catch {
    return { cudaAvailable: false };
  }
}

export async function observeHost(): Promise<ObservedHost> {
  const root = assetsRoot();
  let freeDiskGiB: number | null = null;
  try {
    // The assets root may not exist before the first install; create it so
    // the free-space figure describes the filesystem the weights will land on
    // rather than whatever ancestor happens to exist.
    await mkdir(root, { recursive: true });
    const stats = await statfs(root);
    freeDiskGiB = Math.round(((stats.bsize * stats.bavail) / 1024 ** 3) * 100) / 100;
  } catch {
    freeDiskGiB = null;
  }

  let nvcc: string | null = null;
  try {
    const { stdout } = await run("nvcc", ["--version"], { timeout: 10_000 });
    nvcc = stdout.trim().split("\n").at(-1) ?? "present";
  } catch {
    nvcc = null;
  }

  const normalizedArch = arch() === "x64" ? "x64" : arch();
  return {
    platform: `${platform()}-${normalizedArch}`,
    os: platform(),
    osRelease: release(),
    arch: normalizedArch,
    assetsRoot: root,
    freeDiskGiB,
    gpuName: null,
    vramGiB: null,
    freeVramGiB: null,
    driver: null,
    computeCapability: null,
    cudaAvailable: false,
    nvcc,
    ...(await nvidiaSmi()),
  };
}

export function qualify(
  family: ModelFamilyId,
  quant: ModelQuant,
  host: ObservedHost,
  options: { reserveRenderer?: boolean } = {},
): ModelExecutionEligibility {
  const catalog = MODEL_CATALOG[family];
  const offer = catalog.quants.find((candidate) => candidate.quant === quant);
  if (!offer) throw new Error(`${family} does not offer quant ${quant}`);

  const diskGiB = Math.round((catalog.approxDiskBytes / 1024 ** 3) * 10) / 10;
  const downloadBlockedReasons: string[] = [];
  if (host.freeDiskGiB !== null && host.freeDiskGiB < diskGiB) {
    downloadBlockedReasons.push(
      `needs about ${diskGiB} GiB free (weights ` +
        `${Math.round((catalog.approxWeightsBytes / 1024 ** 3) * 10) / 10} GiB plus a ` +
        `~${RUNTIME_GIB} GiB isolated runtime); this volume has ${host.freeDiskGiB} GiB free`,
    );
  }

  const reasons: string[] = [];
  const platformOk = catalog.platforms.includes(host.platform);
  if (!platformOk) {
    reasons.push(
      `local execution is ${catalog.platforms.join("/")} only — every Alpamayo ` +
        `family is Linux-only upstream; this machine is ${host.platform}. ` +
        "Cloud execution has no such restriction.",
    );
  }
  if (offer.status === "unsupported") {
    reasons.push(`${quant} is not supported for ${catalog.displayName}: ${offer.note}`);
  } else if (offer.status === "qualification-pending") {
    reasons.push(`${quant} has no measured envelope for ${catalog.displayName} yet: ${offer.note}`);
  }
  if (!host.cudaAvailable) {
    reasons.push("no NVIDIA GPU was detected on this machine");
  }
  const headroom = options.reserveRenderer ? RENDERER_HEADROOM_GIB : 0;
  if (offer.minVramGiB !== null && host.vramGiB !== null) {
    const needed = offer.minVramGiB + headroom;
    if (host.vramGiB < needed) {
      reasons.push(
        `requires at least ${needed} GiB of device memory` +
          (headroom ? ` (${offer.minVramGiB} GiB for the model plus ${headroom} GiB reserved for a resident renderer)` : "") +
          `; ${host.gpuName ?? "this device"} has ${host.vramGiB} GiB`,
      );
    }
  }
  if (catalog.localExecution === "qualification-pending" && reasons.length === 0) {
    reasons.push(
      `${catalog.displayName} local execution is not yet qualified: NVIDIA ` +
        `validated it only on ${catalog.vendorTestedGpus.join(", ")}. A device that ` +
        "meets the memory requirement becomes qualified by a recorded run, not by assumption.",
    );
  }

  let qualification: ModelExecutionEligibility["qualification"];
  if (offer.status === "unsupported" || catalog.localExecution === "unsupported" || !platformOk || !host.cudaAvailable) {
    qualification = "unsupported";
  } else if (reasons.length > 0) {
    qualification = "qualification-pending";
  } else {
    qualification = "qualified";
  }

  // Tier thresholds are the NOMINAL device class, not the reported figure: a
  // "16 GB" card reports ~15.46 GiB usable and an "80 GB" H100 ~79.2 GiB, so
  // comparing against the round number would leave every real device
  // untiered. Whether a model actually fits is decided by minVramGiB above,
  // not by this label.
  let tier: ModelExecutionEligibility["tier"] = null;
  if (qualification === "qualified" && host.vramGiB !== null) {
    tier = host.vramGiB >= 78 ? "local-80" : host.vramGiB >= 23 ? "local-24" : "local-16";
  } else if (offer.status !== "unsupported") {
    // Not runnable here, but runnable: the honest tier is the cloud.
    tier = "remote-only";
  }

  return {
    family,
    quant,
    downloadEligible: downloadBlockedReasons.length === 0,
    downloadBlockedReasons,
    executionEligible: qualification === "qualified",
    qualification,
    tier,
    reasons,
    requires: {
      vramGiB: offer.minVramGiB,
      diskGiB,
      os: "Linux",
      platform: catalog.platforms[0] ?? "linux-x64",
      cuda: ">=12.8, for the pinned torch cu128 wheels",
      vendorTestedGpus: catalog.vendorTestedGpus,
    },
    observed: {
      platform: host.platform,
      gpuName: host.gpuName,
      vramGiB: host.vramGiB,
      freeVramGiB: host.freeVramGiB,
      driver: host.driver,
      cudaAvailable: host.cudaAvailable,
      freeDiskGiB: host.freeDiskGiB,
      nvcc: host.nvcc,
    },
  };
}

export type PreflightReport = {
  readonly schema: typeof PREFLIGHT_SCHEMA;
  readonly observed: ObservedHost;
  readonly eligibility: readonly ModelExecutionEligibility[];
  readonly localExecution: "available" | "remote-only";
  readonly rendererHeadroomGiB: number | null;
};

export async function preflight(
  options: { families?: readonly ModelFamilyId[]; reserveRenderer?: boolean } = {},
): Promise<PreflightReport> {
  const host = await observeHost();
  const families = options.families ?? MODEL_FAMILIES;
  const eligibility: ModelExecutionEligibility[] = [];
  for (const family of families) {
    for (const offer of MODEL_CATALOG[family].quants) {
      eligibility.push(qualify(family, offer.quant, host, options));
    }
  }
  return {
    schema: PREFLIGHT_SCHEMA,
    observed: host,
    eligibility,
    // A host with no eligible local profile is not broken: it is a
    // remote-execution host, and downloads may still be offered on it.
    localExecution: eligibility.some((entry) => entry.executionEligible) ? "available" : "remote-only",
    rendererHeadroomGiB: options.reserveRenderer ? RENDERER_HEADROOM_GIB : null,
  };
}
