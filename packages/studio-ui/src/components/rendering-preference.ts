import { useEffect, useState } from "react";

export const RENDERING_PREFERENCE_STORAGE_KEY = "simforge.rendering-preference.v1";
const LOCAL_SETUP_STORAGE_KEY = "simforge.local-setup.v1";

/** Local onboarding completion is independent of the default rendering profile. */
export function hasCompletedLocalSetup(): boolean {
  try { return typeof window !== "undefined" && window.localStorage.getItem(LOCAL_SETUP_STORAGE_KEY) === "completed"; }
  catch { return false; }
}

export function markLocalSetupCompleted(): void {
  try { if (typeof window !== "undefined") window.localStorage.setItem(LOCAL_SETUP_STORAGE_KEY, "completed"); }
  catch { /* The host's completedAt remains the authoritative fallback. */ }
}
export const OPEN_RENDERING_PREFERENCE_EVENT = "simforge:open-rendering-preference";
export const RENDERING_PREFERENCE_CHANGE_EVENT = "simforge:rendering-preference-change";
export type RenderingPreference = "low-no-foliage" | "low" | "medium";
/**
 * The one default every surface uses until the user saves a choice: no stored
 * value, unreadable storage, server render and the pre-hydration frame. It is
 * never written to storage on its own, so a stored value is always the user's
 * explicit choice (or a migrated legacy one).
 */
export const DEFAULT_RENDERING_PREFERENCE: RenderingPreference = "low-no-foliage";
export const RENDERING_PREFERENCE_CHOICES: readonly { id: RenderingPreference; label: string; description: string }[] = [
  { id: "low-no-foliage", label: "Low · no foliage", description: "Low-resolution textures with vegetation turned off." },
  { id: "low", label: "Low", description: "Low-resolution textures with vegetation enabled." },
  { id: "medium", label: "Medium", description: "Sharper textures with vegetation enabled." },
];

export function renderingPreferenceLabel(preference: RenderingPreference): string {
  return RENDERING_PREFERENCE_CHOICES.find((choice) => choice.id === preference)!.label;
}

/** The label used wherever the choices are listed: the default carries "(default)". */
export function renderingPreferenceChoiceLabel(preference: RenderingPreference): string {
  const label = renderingPreferenceLabel(preference);
  return preference === DEFAULT_RENDERING_PREFERENCE ? `${label} (default)` : label;
}

/** Browser profile and downloadable texture tier are different contracts. */
export function renderingPreferenceQuality(preference: RenderingPreference): "low" | "medium" {
  return preference === "medium" ? "medium" : "low";
}

// Browser-storage migration only; old levels never escape as texture tier ids.
const REMOVED_RENDERING_PREFERENCES: Record<string, RenderingPreference> = {
  "roads-only": "low", "ultra-low-3d": "low", minimal: "low", high: "medium",
};

function isRenderingPreference(value: unknown): value is RenderingPreference {
  return value === "low-no-foliage" || value === "low" || value === "medium";
}

let followingOtherTabs = false;
const otherTabChanges = new WeakSet<Event>();

/**
 * True when a change event re-announces a save made in another tab. A surface
 * that also records the preference somewhere shared (the open scenario
 * document) applies it without writing again: the saving tab already did.
 */
export function isOtherTabRenderingPreferenceChange(event: Event): boolean {
  return otherTabChanges.has(event);
}

/**
 * A save in another tab reaches this one only as a `storage` event, which none
 * of the viewers listen for, so an open scene there kept its old profile until
 * a reload. Re-announce it as the same-tab change event every viewer and
 * `useRenderingPreference` already follow. Installed once, on the first
 * browser read, which every viewer makes before it mounts.
 */
function followOtherTabs(): void {
  if (followingOtherTabs || typeof window === "undefined") return;
  followingOtherTabs = true;
  window.addEventListener("storage", (event) => {
    if (event.key !== RENDERING_PREFERENCE_STORAGE_KEY || !isRenderingPreference(event.newValue)) return;
    try { if (event.storageArea !== window.localStorage) return; } catch { return; }
    const change = new CustomEvent<RenderingPreference>(RENDERING_PREFERENCE_CHANGE_EVENT, { detail: event.newValue });
    otherTabChanges.add(change);
    window.dispatchEvent(change);
  });
}

export function readRenderingPreference(storage?: (Pick<Storage, "getItem"> & Partial<Pick<Storage, "setItem">>) | null): RenderingPreference {
  let browserStorage = storage;
  if (storage === undefined) followOtherTabs();
  try {
    if (browserStorage === undefined) browserStorage = typeof window === "undefined" ? null : window.localStorage;
    const stored = browserStorage?.getItem(RENDERING_PREFERENCE_STORAGE_KEY);
    const valid = isRenderingPreference(stored);
    const legacy = Boolean(stored && Object.hasOwn(REMOVED_RENDERING_PREFERENCES, stored));
    // No stored choice means a fresh installation: onboarding is pending. A
    // stored (or legacy) choice predates the setup marker, so setup was done.
    try {
      if (browserStorage?.getItem(LOCAL_SETUP_STORAGE_KEY) == null) {
        browserStorage?.setItem?.(LOCAL_SETUP_STORAGE_KEY, valid || legacy ? "completed" : "pending");
      }
    } catch { /* Read-only storage does not prevent rendering. */ }
    if (valid) return stored;
    if (!legacy) return DEFAULT_RENDERING_PREFERENCE;
    const migrated = REMOVED_RENDERING_PREFERENCES[stored!]!;
    try { browserStorage?.setItem?.(RENDERING_PREFERENCE_STORAGE_KEY, migrated); } catch { /* The migrated profile still works with read-only storage. */ }
    return migrated;
  } catch {
    return DEFAULT_RENDERING_PREFERENCE;
  }
}

export function saveRenderingPreference(preference: RenderingPreference, storage?: (Pick<Storage, "setItem"> & Partial<Pick<Storage, "getItem">>) | null): void {
  try {
    const browserStorage = storage === undefined ? typeof window === "undefined" ? null : window.localStorage : storage;
    if (browserStorage?.getItem?.(LOCAL_SETUP_STORAGE_KEY) == null) browserStorage?.setItem(LOCAL_SETUP_STORAGE_KEY, "pending");
    browserStorage?.setItem(RENDERING_PREFERENCE_STORAGE_KEY, preference);
  } catch { /* Storage failure must not prevent a session-local change. */ }
  if (storage === undefined && typeof window !== "undefined") window.dispatchEvent(new CustomEvent<RenderingPreference>(RENDERING_PREFERENCE_CHANGE_EVENT, { detail: preference }));
}

export function requestRenderingPreferenceSelection(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(OPEN_RENDERING_PREFERENCE_EVENT));
}

/** Null only during server/hydration render (fall back to `DEFAULT_RENDERING_PREFERENCE`); the first browser read returns the saved choice or `DEFAULT_RENDERING_PREFERENCE`. */
export function useRenderingPreference(): RenderingPreference | null {
  const [preference, setPreference] = useState<RenderingPreference | null>(null);
  useEffect(() => {
    setPreference(readRenderingPreference());
    const onChange = (event: Event) => setPreference((event as CustomEvent<RenderingPreference>).detail);
    window.addEventListener(RENDERING_PREFERENCE_CHANGE_EVENT, onChange);
    return () => window.removeEventListener(RENDERING_PREFERENCE_CHANGE_EVENT, onChange);
  }, []);
  return preference;
}
