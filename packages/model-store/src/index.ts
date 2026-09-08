import {
  MODEL_CATALOG,
  MODEL_FAMILIES,
  type ModelCatalogEntry,
  type ModelExecutionEligibility,
  type ModelFamilyId,
  type ModelInstallState,
  type ModelQuant,
} from "./catalog";
import { allInstallStates, stateGeneration, vaultStatus, type VaultStatus } from "./install";
import { lockEntry } from "./lock";
import { readRuntimeRecord, type RuntimeRecord } from "./prepare";
import { endpointCommand, installLayout } from "./paths";
import { observeHost, qualify, type ObservedHost } from "./preflight";

/**
 * The desktop model store, assembled for one request.
 *
 * `GET /api/models/store` returns this whole document; `GET
 * /api/models/store/state` returns only the install slice, which is what a
 * 1 s poller needs while a transfer is running. The catalog and the
 * eligibility verdicts change only when the machine changes, so re-sending
 * them every second would be waste.
 */
export const MODEL_STORE_VIEW_SCHEMA = "simforge.model-store-view/v1";

export type InstallStateEntry = {
  readonly family: ModelFamilyId;
  readonly quant: ModelQuant | null;
  readonly state: ModelInstallState;
};

/**
 * A per-family gate that no code may resolve by itself. Surfaced with the
 * catalog so the UI shows it next to the install action instead of burying it
 * in documentation.
 */
export type ModelReviewGate = {
  readonly family: ModelFamilyId;
  readonly kind: "license-conflict" | "gated-sidecar";
  readonly resolved: false;
  readonly note: string;
};

/**
 * Whether a family's isolated Python runtime has been provisioned.
 *
 * Separate from install state on purpose: weights and runtime are installed
 * by different steps and fail independently, so a family can be fully
 * installed with no runtime at all. A local-execution offer must check THIS,
 * not install state, or it will offer a run that cannot start.
 */
export type ModelRuntimeState = {
  readonly family: ModelFamilyId;
  readonly prepared: boolean;
  readonly runtime: RuntimeRecord | null;
};

export type ModelStoreView = {
  readonly schema: typeof MODEL_STORE_VIEW_SCHEMA;
  readonly generation: number;
  readonly catalog: readonly ModelCatalogEntry[];
  readonly installs: readonly InstallStateEntry[];
  readonly eligibility: readonly ModelExecutionEligibility[];
  readonly observed: ObservedHost;
  readonly runtimes: readonly ModelRuntimeState[];
  readonly vault: VaultStatus;
  readonly reviewGates: readonly ModelReviewGate[];
};

export async function modelStoreView(): Promise<ModelStoreView> {
  const host = await observeHost();
  const eligibility: ModelExecutionEligibility[] = [];
  const reviewGates: ModelReviewGate[] = [];

  for (const family of MODEL_FAMILIES) {
    const catalog = MODEL_CATALOG[family];
    for (const offer of catalog.quants) {
      eligibility.push(qualify(family, offer.quant, host));
    }
    if (catalog.license.commercialUseReviewRequired && catalog.license.cardConflictNote) {
      reviewGates.push({
        family,
        kind: "license-conflict",
        resolved: false,
        note: catalog.license.cardConflictNote,
      });
    }
    const gated = catalog.sidecars.find((sidecar) => sidecar.requiresUserToken);
    if (gated) {
      reviewGates.push({
        family,
        kind: "gated-sidecar",
        resolved: false,
        note:
          `${gated.repo} is gated (${gated.license}). Its configuration and ` +
          "tokenizer — no weights — must be fetched with a Hugging Face token " +
          "belonging to an account that has accepted those terms. The token is " +
          "held in this computer's credential vault and is never written to a " +
          "job payload, a log, or the install record.",
      });
    }
  }

  const runtimes: ModelRuntimeState[] = [];
  for (const family of MODEL_FAMILIES) {
    const runtime = await readRuntimeRecord(family);
    runtimes.push({ family, prepared: runtime !== null, runtime });
  }

  return {
    schema: MODEL_STORE_VIEW_SCHEMA,
    generation: stateGeneration(),
    runtimes,
    catalog: MODEL_FAMILIES.map((family) => MODEL_CATALOG[family]),
    installs: await allInstallStates(),
    eligibility,
    observed: host,
    vault: await vaultStatus(),
    reviewGates,
  };
}

export type ModelEndpointPlan = {
  readonly kind: "process";
  readonly command: readonly string[];
  readonly health: { readonly kind: "stdout"; readonly pattern: string };
  readonly invoke:
    | { readonly kind: "http-json"; readonly path: string }
    | { readonly kind: "unix-msgpack"; readonly socketPath: string };
  readonly checkpointDigest: string;
  readonly license: string;
  readonly source: string;
};

/**
 * Endpoint descriptor for a completed install, in the shape
 * `simforge.model_endpoints` stores.
 *
 * One process, two transports: the unix socket carries closed-loop frames
 * (shared-memory bundles never cross HTTP) and the HTTP facade lets the
 * existing `http-json` open-loop executor drive the same resident engine.
 */
export async function endpointPlanFor(
  family: ModelFamilyId,
  quant: ModelQuant,
  options: { socketPath: string; httpBind?: string },
): Promise<ModelEndpointPlan> {
  const entry = await lockEntry(family);
  const layout = installLayout(family, entry.weights.revision);
  return {
    kind: "process",
    command: endpointCommand(layout, quant, {
      socketPath: options.socketPath,
      httpBind: options.httpBind,
      checkpointDigest: entry.weights.checkpointDigest,
    }),
    health: { kind: "stdout", pattern: "^READY " },
    invoke: options.httpBind
      ? { kind: "http-json", path: "/invoke" }
      : { kind: "unix-msgpack", socketPath: options.socketPath },
    checkpointDigest: entry.weights.checkpointDigest,
    // The registry fixture previously recorded `nvidia-open-model` for these
    // weights, which is not their licence. The lock is the authority.
    license: entry.weights.license,
    source: entry.weights.repo,
  };
}

export * from "./catalog";
export {
  allInstallStates,
  cancelInstall,
  clearHfToken,
  installRecord,
  installState,
  InstallConflict,
  LicenseAcceptanceRequired,
  pauseInstall,
  reclaimCache,
  resumeInstall,
  startInstall,
  stateGeneration,
  storeHfToken,
  TokenRequired,
  uninstall,
  verifyInstall,
  vaultStatus,
  type InstallRecord,
  type VaultStatus,
} from "./install";
export { preflight, observeHost, qualify, PREFLIGHT_SCHEMA, type ObservedHost, type PreflightReport } from "./preflight";
export {
  loadModelLock,
  lockEntry,
  installFiles,
  MODEL_LOCK_SCHEMA,
  type ModelLock,
  type ModelLockEntry,
  type ModelLockFile,
  type InstallFileEntry,
} from "./lock";
export { installLayout, endpointCommand, assetsRoot, modelsRoot, hfCacheRoot, venvPython, type InstallLayout } from "./paths";
export { verifyFile, checkpointDigestFromLock, type FileVerdict } from "./integrity";
export {
  InstallRequestSchema,
  InstallControlSchema,
  VerifyRequestSchema,
  TokenRequestSchema,
  ReclaimRequestSchema,
  type InstallRequest,
  type InstallControlRequest,
  type VerifyRequest,
} from "./requests";
export {
  openModelVault,
  MODEL_VAULT_SERVICE,
  HF_TOKEN_ACCOUNT,
  HF_IDENTITY_ACCOUNT,
  type SecretVault,
} from "./vault";
export {
  downloadLockedFile,
  tokenIdentity,
  resolveUrl,
  DownloadError,
  HF_ENDPOINT,
  type DownloadOptions,
  type DownloadResult,
  type DownloadProgress,
} from "./download";
export {
  prepareRuntime,
  readRuntimeRecord,
  runtimeRecordPath,
  PrepareError,
  RUNTIME_SCHEMA,
  type PrepareOptions,
  type PrepareProgress,
  type PrepareStep,
  type RuntimeRecord,
} from "./prepare";
