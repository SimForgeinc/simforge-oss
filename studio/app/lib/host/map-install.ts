import type { LocalMapInstallState } from "@/app/lib/cloud/maps";
import { studioHost } from "@/app/lib/host";

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

/** Observe a service-owned install; cancelling the observer never cancels other consumers. */
export async function followMapInstall(
  mapVersionId: string,
  profile: LocalMapInstallProfile,
  first: Promise<LocalMapInstallState>,
  signal: AbortSignal,
  onProgress: (state: LocalMapInstallState) => void,
): Promise<LocalMapInstallState> {
  let current = await first;
  signal.throwIfAborted();
  onProgress(current);
  while (current.state === "materializing") {
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        reject(signal.reason ?? new DOMException("Map observation cancelled", "AbortError"));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, 1_500);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    current = await readMapInstall(mapVersionId, profile, signal);
    signal.throwIfAborted();
    onProgress(current);
  }
  if (current.state === "ready") await studioHost.artifacts.listMaps(signal, { fresh: true });
  return current;
}
