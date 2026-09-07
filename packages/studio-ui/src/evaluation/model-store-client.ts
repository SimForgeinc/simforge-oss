"use client";

/**
 * Client for the desktop model store (`/api/models/store`).
 *
 * Desktop-only by construction: these routes manage weights, isolated runtime
 * environments and the OS credential vault on the machine the app runs on. The
 * web portal must never call them — it has no local store — which is why this
 * module is exported on its own subpath and is not part of the portal's import
 * graph.
 */

import type {
  ModelCatalogEntry,
  ModelExecutionEligibility,
  ModelFamilyId,
  ModelInstallState,
  ModelQuant,
} from "./model-catalog";
import type { ModelRuntimeSnapshot } from "./presentation";
import { runtimeKey } from "./presentation";

export type ModelStoreView = {
  schema: string;
  catalog: Record<ModelFamilyId, ModelCatalogEntry>;
  installs: ({ family: ModelFamilyId; quant: ModelQuant } & ModelInstallState)[];
  eligibility: ModelExecutionEligibility[];
  preflight: Record<string, unknown>;
  vault: {
    persistence: "os-vault" | "session";
    hfTokenPresent: boolean;
    hfTokenIdentity: string | null;
  };
};

export type ModelStoreStatePoll = {
  installs: ({ family: ModelFamilyId; quant: ModelQuant } & ModelInstallState)[];
  /** Increments on any change, so an unchanged poll can skip a re-render. */
  generation: number;
};

export class ModelStoreError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly detail: unknown;

  constructor(status: number, code: string | null, message: string, detail: unknown) {
    super(message);
    this.name = "ModelStoreError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

async function storeRequest<T>(
  path: string,
  init: { method: "GET" | "POST" | "DELETE"; body?: unknown; signal?: AbortSignal },
): Promise<T> {
  const response = await fetch(`/api/models/store${path}`, {
    method: init.method,
    headers: init.body === undefined ? { accept: "application/json" } : {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    cache: "no-store",
    signal: init.signal,
  });
  const text = await response.text();
  const payload: unknown = text.length > 0 ? JSON.parse(text) : null;
  if (!response.ok) {
    const record = (payload ?? {}) as { error?: unknown; detail?: unknown; message?: unknown };
    throw new ModelStoreError(
      response.status,
      typeof record.error === "string" ? record.error : null,
      typeof record.message === "string" ? record.message : `Model store request failed (${response.status}).`,
      record.detail ?? payload,
    );
  }
  return payload as T;
}

export type InstallRequest = {
  family: ModelFamilyId;
  quant: ModelQuant;
  hfToken?: string;
  acceptLicense: true;
  acceptSidecarLicense?: true;
};

export type VerifyResult = {
  ok: boolean;
  verified: { path: string; sha256Ok: boolean; sizeOk: boolean }[];
  failed: { path: string; sha256Ok: boolean; sizeOk: boolean }[];
};

export type RemoveResult = {
  removed: boolean;
  freedBytes: number;
  retainedRegistryVersions: string[];
};

export type CacheReclaimResult = {
  reclaimableBytes: number;
  entries: { path: string; bytes: number; referencedBy: string[] }[];
  freedBytes?: number;
};

export const modelStore = {
  view: (signal?: AbortSignal) => storeRequest<ModelStoreView>("", { method: "GET", signal }),
  state: (signal?: AbortSignal) =>
    storeRequest<ModelStoreStatePoll>("/state", { method: "GET", signal }),
  install: (body: InstallRequest) =>
    storeRequest<{ family: ModelFamilyId; quant: ModelQuant; state: ModelInstallState }>("/install", {
      method: "POST",
      body,
    }),
  pause: (family: ModelFamilyId, quant: ModelQuant) =>
    storeRequest<{ state: ModelInstallState }>("/install/pause", {
      method: "POST",
      body: { family, quant },
    }),
  resume: (family: ModelFamilyId, quant: ModelQuant) =>
    storeRequest<{ state: ModelInstallState }>("/install/resume", {
      method: "POST",
      body: { family, quant },
    }),
  cancel: (family: ModelFamilyId, quant: ModelQuant, discardPartials: boolean) =>
    storeRequest<{ state: ModelInstallState }>("/install/cancel", {
      method: "POST",
      body: { family, quant, discardPartials },
    }),
  verify: (family: ModelFamilyId, quant: ModelQuant, deep: boolean) =>
    storeRequest<VerifyResult>("/verify", { method: "POST", body: { family, quant, deep } }),
  remove: (family: ModelFamilyId, quant: ModelQuant, purgeSharedCache: boolean) =>
    storeRequest<RemoveResult>(
      `/${encodeURIComponent(family)}?quant=${encodeURIComponent(quant)}&purgeSharedCache=${purgeSharedCache}`,
      { method: "DELETE" },
    ),
  reclaimCache: (dryRun: boolean) =>
    storeRequest<CacheReclaimResult>("/cache/reclaim", { method: "POST", body: { dryRun } }),
};

/**
 * Fold the store's view into the snapshot the shared pickers consume.
 *
 * Exists because two different screens (the model manager and the run
 * launcher) need the same keyed lookup, and duplicating the keying is how the
 * two drift apart.
 */
export function toRuntimeSnapshot(view: ModelStoreView): ModelRuntimeSnapshot {
  const installs: Record<string, ModelInstallState | undefined> = {};
  for (const entry of view.installs) {
    const { family, quant, ...state } = entry;
    installs[runtimeKey(family, quant)] = state as ModelInstallState;
  }
  const eligibility: Record<string, ModelExecutionEligibility | undefined> = {};
  for (const entry of view.eligibility) {
    eligibility[runtimeKey(entry.family, entry.quant)] = entry;
  }
  return {
    installs,
    eligibility,
    vault: { hfTokenPresent: view.vault.hfTokenPresent, hfTokenIdentity: view.vault.hfTokenIdentity },
  };
}
