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

/**
 * What the service reports when an install fails is a stable code, not prose:
 * `LocalMapInstallState.message` carries `MapAccessError.code` verbatim so
 * callers can branch on it. Every surface that shows the failure to a person
 * goes through here instead, so nobody reads `map_registration_incomplete`
 * off a panel. An unknown code still reaches the user rather than being
 * swallowed, because a support request needs it.
 */
const MAP_INSTALL_ERRORS: Record<string, string> = {
  map_requires_cloud_connection: "This map needs a SimCloud account. Sign in to download it to this computer.",
  cloud_unreachable: "SimCloud could not be reached, so this map could not be downloaded. Check your connection and try again.",
  map_version_not_found: "SimCloud no longer publishes this map version to this account.",
  map_plan_not_found: "SimCloud publishes no downloadable files for this part of the map, so it cannot be installed here.",
  map_plan_invalid: "SimCloud returned a download plan this version of Studio cannot read.",
  map_profile_not_installed: "This map was installed on this computer without that part, and there is no SimCloud release to complete it from.",
  map_member_integrity: "A downloaded file did not match its published checksum, so the map was not installed. Try again.",
  map_member_missing: "Part of this map is no longer in the map cache. Download it again.",
  map_registration_incomplete: "The download finished but the map did not register completely on this computer. Try again.",
  map_release_identity_missing: "SimCloud published this map without the release identity Studio needs to install it.",
  editor_asset_release_missing: "This installation has no active editor asset release, so maps cannot be registered yet.",
  invalid_map_profile: "Studio asked for a part of the map that does not exist.",
  AbortError: "The download was cancelled.",
};

/** The sentence to show for a service install failure; `label` names the map when there is no code. */
export function mapInstallErrorMessage(code: string | null | undefined, label?: string): string {
  if (!code) return label ? `${label} could not be installed.` : "The map could not be installed.";
  return MAP_INSTALL_ERRORS[code] ?? `The map could not be installed (${code}).`;
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
