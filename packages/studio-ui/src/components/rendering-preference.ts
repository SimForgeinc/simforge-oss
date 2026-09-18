import { useEffect, useState } from "react";
import {
  SCENARIO_AUTHORING_QUALITY_IDS,
  type ScenarioAuthoringQuality,
} from "../lib/scenario/contracts";

export const RENDERING_PREFERENCE_STORAGE_KEY =
  "simforge.rendering-preference.v1";

export const OPEN_RENDERING_PREFERENCE_EVENT =
  "simforge:open-rendering-preference";
export const RENDERING_PREFERENCE_CHANGE_EVENT =
  "simforge:rendering-preference-change";

export type RenderingPreference = ScenarioAuthoringQuality;

function isRenderingPreference(value: unknown): value is RenderingPreference {
  return SCENARIO_AUTHORING_QUALITY_IDS.some((quality) => quality === value);
}

/**
 * Data migration for browser storage, not a compatibility alias.
 *
 * "roads-only" and "ultra-low-3d" were removed: they required per-map
 * derivatives no release ships, so they could only fail to load. A browser
 * that saved one before the removal is rewritten to the nearest surviving
 * level here, at the single read boundary, so nothing downstream ever sees a
 * level that no longer exists.
 */
const REMOVED_RENDERING_PREFERENCES: Record<string, RenderingPreference> = {
  "roads-only": "minimal",
  "ultra-low-3d": "minimal",
};

export function usesLightweightRendering(preference: RenderingPreference): boolean {
  return preference !== "high";
}

export function readRenderingPreference(
  storage?: Pick<Storage, "getItem"> | null,
): RenderingPreference | null {
  try {
    const browserStorage =
      storage === undefined
        ? typeof window === "undefined"
          ? null
          : window.localStorage
        : storage;
    if (!browserStorage) return null;
    const stored = browserStorage.getItem(RENDERING_PREFERENCE_STORAGE_KEY);
    if (stored !== null && stored in REMOVED_RENDERING_PREFERENCES) return REMOVED_RENDERING_PREFERENCES[stored]!;
    return isRenderingPreference(stored) ? stored : null;
  } catch {
    return null;
  }
}

export function saveRenderingPreference(
  preference: RenderingPreference,
  storage?: Pick<Storage, "setItem"> | null,
): void {
  try {
    const browserStorage =
      storage === undefined
        ? typeof window === "undefined"
          ? null
          : window.localStorage
        : storage;
    browserStorage?.setItem(RENDERING_PREFERENCE_STORAGE_KEY, preference);
  } catch {
    // The current session can still use the selection when browser storage is
    // disabled. A future visit will ask again because it cannot be persisted.
  }
  if (storage === undefined && typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent<RenderingPreference>(RENDERING_PREFERENCE_CHANGE_EVENT, {
        detail: preference,
      }),
    );
  }
}

/** Ask the dashboard-level gate to reopen the same chooser used on first run. */
export function requestRenderingPreferenceSelection(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(OPEN_RENDERING_PREFERENCE_EVENT));
}

/**
 * The saved preference, kept current as any surface changes it. `null` until
 * the user has chosen one; callers that render fall back to `"high"`.
 */
export function useRenderingPreference(): RenderingPreference | null {
  const [preference, setPreference] = useState<RenderingPreference | null>(readRenderingPreference);
  useEffect(() => {
    const onChange = (event: Event) => setPreference((event as CustomEvent<RenderingPreference>).detail);
    window.addEventListener(RENDERING_PREFERENCE_CHANGE_EVENT, onChange);
    return () => window.removeEventListener(RENDERING_PREFERENCE_CHANGE_EVENT, onChange);
  }, []);
  return preference;
}


