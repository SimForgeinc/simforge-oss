// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_RENDERING_PREFERENCE, hasCompletedLocalSetup, isOtherTabRenderingPreferenceChange, markLocalSetupCompleted, readRenderingPreference, renderingPreferenceQuality, RENDERING_PREFERENCE_CHANGE_EVENT, RENDERING_PREFERENCE_CHOICES, RENDERING_PREFERENCE_STORAGE_KEY, renderingPreferenceChoiceLabel, renderingPreferenceLabel, saveRenderingPreference } from "../../../../src/components/rendering-preference";
import { sceneViewerOptions } from "../../../../src/scenario/editor/authoring-quality";
import { loadViewportSettings, saveViewportSettings, viewportVegetationVisible } from "../../../../src/scenario/editor/regions/slots/viewport-settings";

beforeEach(() => { window.localStorage.clear(); vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null); });
afterEach(() => vi.restoreAllMocks());

describe("rendering preference storage", () => {
  it("defaults to Low · no foliage when nothing is stored, without probing the GPU", () => {
    expect(DEFAULT_RENDERING_PREFERENCE).toBe("low-no-foliage");
    expect(readRenderingPreference()).toBe("low-no-foliage");
    expect(HTMLCanvasElement.prototype.getContext).not.toHaveBeenCalled();
  });

  it("never persists the default: a stored value is always an explicit choice", () => {
    expect(readRenderingPreference()).toBe("low-no-foliage");
    expect(window.localStorage.getItem(RENDERING_PREFERENCE_STORAGE_KEY)).toBeNull();
    expect(readRenderingPreference()).toBe("low-no-foliage");
  });

  it.each(["low", "medium", "low-no-foliage"] as const)("respects a saved %s choice", (saved) => {
    window.localStorage.setItem(RENDERING_PREFERENCE_STORAGE_KEY, saved);
    expect(readRenderingPreference()).toBe(saved);
    expect(window.localStorage.getItem(RENDERING_PREFERENCE_STORAGE_KEY)).toBe(saved);
  });

  it("keeps an explicitly saved Medium across reads", () => {
    saveRenderingPreference("medium");
    expect(readRenderingPreference()).toBe("medium");
    expect(readRenderingPreference()).toBe("medium");
    expect(window.localStorage.getItem(RENDERING_PREFERENCE_STORAGE_KEY)).toBe("medium");
  });

  it("falls back to the default when storage is unavailable", () => {
    expect(readRenderingPreference(null)).toBe(DEFAULT_RENDERING_PREFERENCE);
    expect(readRenderingPreference({ getItem() { throw new Error("SecurityError"); } })).toBe(DEFAULT_RENDERING_PREFERENCE);
  });

  it("labels only the default choice with (default)", () => {
    expect(RENDERING_PREFERENCE_CHOICES.map((choice) => renderingPreferenceChoiceLabel(choice.id))).toEqual([
      "Low · no foliage (default)", "Low", "Medium",
    ]);
    expect(renderingPreferenceLabel("low-no-foliage")).toBe("Low · no foliage");
  });

  it("never confuses the default or a new selection with completed local setup", () => {
    readRenderingPreference();
    readRenderingPreference();
    saveRenderingPreference("medium");
    readRenderingPreference();
    expect(hasCompletedLocalSetup()).toBe(false);
    markLocalSetupCompleted();
    saveRenderingPreference("low-no-foliage");
    expect(hasCompletedLocalSetup()).toBe(true);
  });

  it("migrates pre-change stored preferences to completed local setup on first read", () => {
    window.localStorage.setItem(RENDERING_PREFERENCE_STORAGE_KEY, "medium");
    expect(hasCompletedLocalSetup()).toBe(false);
    expect(readRenderingPreference()).toBe("medium");
    expect(hasCompletedLocalSetup()).toBe(true);
  });

  it("preserves an explicit no-foliage profile and maps it only at the texture-tier boundary", () => {
    saveRenderingPreference("low-no-foliage");
    expect(readRenderingPreference()).toBe("low-no-foliage");
    expect(renderingPreferenceQuality(readRenderingPreference())).toBe("low");
    expect(HTMLCanvasElement.prototype.getContext).not.toHaveBeenCalled();
  });

  it("reads corrupt storage as the default", () => {
    window.localStorage.setItem(RENDERING_PREFERENCE_STORAGE_KEY, "automatic");
    expect(readRenderingPreference()).toBe(DEFAULT_RENDERING_PREFERENCE);
  });

  it.each([["roads-only", "low"], ["ultra-low-3d", "low"], ["minimal", "low"], ["high", "medium"]] as const)("migrates %s to %s", (removed, current) => {
    window.localStorage.setItem(RENDERING_PREFERENCE_STORAGE_KEY, removed);
    expect(readRenderingPreference()).toBe(current);
    expect(window.localStorage.getItem(RENDERING_PREFERENCE_STORAGE_KEY)).toBe(current);
  });

  it("announces same-tab no-foliage changes for mounted viewers", () => {
    const listener = vi.fn();
    window.addEventListener(RENDERING_PREFERENCE_CHANGE_EVENT, listener);
    saveRenderingPreference("low-no-foliage");
    expect((listener.mock.calls[0]?.[0] as CustomEvent).detail).toBe("low-no-foliage");
    window.removeEventListener(RENDERING_PREFERENCE_CHANGE_EVENT, listener);
  });

  it("re-announces a save from another tab so open viewers follow it without a reload", () => {
    readRenderingPreference();
    const listener = vi.fn();
    window.addEventListener(RENDERING_PREFERENCE_CHANGE_EVENT, listener);
    const fromOtherTab = (key: string | null, newValue: string | null) =>
      window.dispatchEvent(new StorageEvent("storage", { key, newValue, storageArea: window.localStorage }));
    fromOtherTab("simforge.local-setup.v1", "completed");
    fromOtherTab(RENDERING_PREFERENCE_STORAGE_KEY, "ultra");
    fromOtherTab(RENDERING_PREFERENCE_STORAGE_KEY, null);
    fromOtherTab(null, null);
    expect(listener).not.toHaveBeenCalled();
    fromOtherTab(RENDERING_PREFERENCE_STORAGE_KEY, "low-no-foliage");
    expect(listener).toHaveBeenCalledOnce();
    const remote = listener.mock.calls[0]![0] as CustomEvent;
    expect(remote.detail).toBe("low-no-foliage");
    expect(isOtherTabRenderingPreferenceChange(remote)).toBe(true);
    saveRenderingPreference("medium");
    expect(listener).toHaveBeenCalledTimes(2);
    expect(isOtherTabRenderingPreferenceChange(listener.mock.calls[1]![0] as Event)).toBe(false);
    window.removeEventListener(RENDERING_PREFERENCE_CHANGE_EVENT, listener);
  });

  it("overrides foliage without erasing the saved layer toggle and never creates a new texture tier", () => {
    const settings = loadViewportSettings();
    saveViewportSettings(settings);
    saveRenderingPreference("low-no-foliage");
    expect(sceneViewerOptions("low-no-foliage")).toMatchObject({ vegetation: false, mapTextureTier: "low" });
    // Legacy editor quality state contains texture tiers, not full preferences.
    expect(sceneViewerOptions("low").vegetation).toBe(false);
    expect(viewportVegetationVisible(loadViewportSettings())).toBe(false);
    expect(loadViewportSettings().layers.vegetation).toBe(true);
    saveRenderingPreference("medium");
    expect(sceneViewerOptions("medium")).toMatchObject({ vegetation: true, mapTextureTier: "medium" });
    saveViewportSettings({ ...settings, layers: { ...settings.layers, vegetation: false } });
    expect(sceneViewerOptions("medium").vegetation).toBe(false);
  });
});
