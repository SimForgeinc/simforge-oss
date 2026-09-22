import { useEffect, useState } from "react";
import { probeTextureCapabilities } from "@simforge-oss/viewer";

export const RENDERING_PREFERENCE_STORAGE_KEY = "simforge.rendering-preference.v1";
const LOCAL_SETUP_STORAGE_KEY = "simforge.local-setup.v1";

/** Local onboarding completion is independent of an automatically selected GPU profile. */
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
export const RENDERING_PREFERENCE_CHOICES: readonly { id: RenderingPreference; label: string; description: string }[] = [
  { id: "low-no-foliage", label: "Low · no foliage", description: "Low-resolution textures with vegetation turned off." },
  { id: "low", label: "Low", description: "Low-resolution textures with vegetation enabled." },
  { id: "medium", label: "Medium", description: "Sharper textures with vegetation enabled." },
];

/** Browser profile and downloadable texture tier are different contracts. */
export function renderingPreferenceQuality(preference: RenderingPreference): "low" | "medium" {
  return preference === "medium" ? "medium" : "low";
}

function automaticRenderingPreference(): RenderingPreference {
  if (typeof document === "undefined") return "low";
  let gl: WebGLRenderingContext | WebGL2RenderingContext | null = null;
  try {
    const canvas = document.createElement("canvas");
    gl = canvas.getContext("webgl2", { powerPreference: "high-performance" }) ?? canvas.getContext("webgl", { powerPreference: "high-performance" });
    if (!gl) return "low";
    const capabilities = probeTextureCapabilities(gl);
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = String(gl.getParameter(debug?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER) ?? "");
    const vendor = String(gl.getParameter(debug?.UNMASKED_VENDOR_WEBGL ?? gl.VENDOR) ?? "");
    const label = `${vendor} ${renderer}`;
    // Preserve the existing adapter-family heuristic: integrated/mobile/software parts
    // must be ruled out before matching AMD/Radeon discrete adapters.
    const constrained = /swiftshader|llvmpipe|softpipe|software|basic render|mesa offscreen|iris|uhd|hd graphics|intel|radeon\(tm\) graphics|radeon graphics|vega \d|mali|adreno|powervr/i.test(label);
    const capable = !constrained && /apple|nvidia|geforce|quadro|rtx|amd|radeon/i.test(label);
    return capable && capabilities.maxTextureSize >= 512 && (capabilities.bc7 || capabilities.astc) ? "medium" : "low";
  } catch {
    return "low";
  } finally {
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
  }
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
    const valid = stored === "low-no-foliage" || stored === "low" || stored === "medium";
    const legacy = Boolean(stored && Object.hasOwn(REMOVED_RENDERING_PREFERENCES, stored));
    // Pending is written alongside every new auto choice. Otherwise its second
    // read would mistake that new preference for a pre-onboarding installation.
    try {
      if (browserStorage?.getItem(LOCAL_SETUP_STORAGE_KEY) == null) {
        browserStorage?.setItem?.(LOCAL_SETUP_STORAGE_KEY, valid || legacy ? "completed" : "pending");
      }
    } catch { /* Read-only storage does not prevent rendering. */ }
    if (valid) return stored;
    const preference = legacy ? REMOVED_RENDERING_PREFERENCES[stored!]! : automaticRenderingPreference();
    try { browserStorage?.setItem?.(RENDERING_PREFERENCE_STORAGE_KEY, preference); } catch { /* The selected profile still works with read-only storage. */ }
    return preference;
  } catch {
    return automaticRenderingPreference();
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

/** Null only during server/hydration render; first browser read selects and persists a GPU default. */
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
