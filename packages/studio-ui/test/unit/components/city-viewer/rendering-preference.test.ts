// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasCompletedLocalSetup, markLocalSetupCompleted, readRenderingPreference, renderingPreferenceQuality, RENDERING_PREFERENCE_CHANGE_EVENT, RENDERING_PREFERENCE_STORAGE_KEY, saveRenderingPreference } from "../../../../src/components/rendering-preference";
import { sceneViewerOptions } from "../../../../src/scenario/editor/authoring-quality";
import { loadViewportSettings, saveViewportSettings, viewportVegetationVisible } from "../../../../src/scenario/editor/regions/slots/viewport-settings";

beforeEach(() => { window.localStorage.clear(); vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null); });
afterEach(() => vi.restoreAllMocks());

describe("rendering preference storage", () => {
  it.each([
    ["NVIDIA GeForce RTX 4090", true, false, 16384, "medium"],
    ["Apple M3", false, true, 16384, "medium"],
    ["AMD Radeon Graphics", true, false, 16384, "low"],
    ["NVIDIA GeForce RTX 4090", false, false, 16384, "low"],
    ["NVIDIA GeForce RTX 4090", true, false, 256, "low"],
    ["SwiftShader", true, true, 16384, "low"],
  ] as const)("selects a safe stable default for %s (BC7 %s, ASTC %s, max %s)", (renderer, bc7, astc, max, expected) => {
    const loseContext = vi.fn();
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue({
      MAX_TEXTURE_SIZE: 1, RENDERER: 2, VENDOR: 3,
      getParameter: (key: number) => key === 1 ? max : key === 2 ? renderer : "GPU vendor",
      getExtension: (name: string) => name === "EXT_texture_compression_bptc" ? (bc7 ? {} : null) : name === "WEBGL_compressed_texture_astc" ? (astc ? {} : null) : name === "WEBGL_lose_context" ? { loseContext } : null,
    } as unknown as WebGL2RenderingContext);
    expect(readRenderingPreference()).toBe(expected);
    expect(loseContext).toHaveBeenCalledOnce();
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockClear().mockReturnValue(null);
    expect(readRenderingPreference()).toBe(expected);
    expect(HTMLCanvasElement.prototype.getContext).not.toHaveBeenCalled();
  });

  it("falls back to Low when capability probing or storage is unavailable", () => {
    expect(readRenderingPreference()).toBe("low");
    expect(readRenderingPreference({ getItem() { throw new Error("SecurityError"); } })).toBe("low");
  });

  it("never confuses an auto choice or a new selection with completed local setup", () => {
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

  it("replaces corrupt storage with a stable auto selection", () => {
    window.localStorage.setItem(RENDERING_PREFERENCE_STORAGE_KEY, "automatic");
    expect(readRenderingPreference()).toBe("low");
    expect(window.localStorage.getItem(RENDERING_PREFERENCE_STORAGE_KEY)).toBe("low");
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
