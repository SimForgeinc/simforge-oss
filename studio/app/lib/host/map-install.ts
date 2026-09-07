import type { LocalMapInstallState } from "@/app/lib/cloud/maps";

export type LocalMapInstallProfile = LocalMapInstallState["profile"];

async function installRequest(
  mapVersionId: string,
  profile: LocalMapInstallProfile,
  init: RequestInit,
): Promise<LocalMapInstallState> {
  const path = `/api/simforge/maps/${encodeURIComponent(mapVersionId)}/install`;
  const response = await fetch(init.method === "POST" ? path : `${path}?profile=${profile}`, {
    ...init,
    cache: "no-store",
  });
  const body = (await response.json().catch(() => null)) as
    | (LocalMapInstallState & { error?: string })
    | { error?: string; message?: string }
    | null;
  if (!response.ok || !body || !("state" in body)) {
    throw new Error(body?.message ?? body?.error ?? `Map installation request failed (${response.status}).`);
  }
  return body;
}

/** Starts or joins the local materialization for one profile; returns the current status immediately. */
export function startMapInstall(mapVersionId: string, profile: LocalMapInstallProfile, signal?: AbortSignal) {
  return installRequest(mapVersionId, profile, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ profile }),
    signal,
  });
}

export function readMapInstall(mapVersionId: string, profile: LocalMapInstallProfile, signal?: AbortSignal) {
  return installRequest(mapVersionId, profile, { signal });
}
