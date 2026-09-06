import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_VIEWPORT_SETTINGS,
  isDefaultViewportSettings,
  LOOK_SENSITIVITY_RANGE,
  loadViewportSettings,
  normalizeViewportSettings,
  SENSITIVITY_RANGE,
  saveViewportSettings,
} from "../../src/scenario/editor/regions/slots/viewport-settings";

/**
 * Persisted viewport settings.
 *
 * These are read from `localStorage`, which means they outlive the code that wrote them: a renamed key, a
 * truncated record, or a value someone typed into devtools all arrive here. The normalizer is the only
 * thing between that and the renderer, and a `NaN` reaching `setCameraControlPreferences` leaves the camera
 * unusable with nothing on screen to explain why — so every field is validated rather than spread.
 */

function memoryStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
}

beforeEach(() => {
  vi.stubGlobal("window", { localStorage: memoryStorage() });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("normalizeViewportSettings", () => {
  it("returns the defaults for absent, null and non-object input", () => {
    for (const input of [undefined, null, 42, "nonsense", []]) {
      expect(normalizeViewportSettings(input)).toEqual(DEFAULT_VIEWPORT_SETTINGS);
    }
  });

  it("keeps a valid stored record intact", () => {
    const stored = {
      cameraMode: "fly",
      controls: { ...DEFAULT_VIEWPORT_SETTINGS.controls, reverseVerticalLook: true, wheelZoomSensitivity: 150 },
      layers: { city: false, vegetation: true, road: true },
    };
    const result = normalizeViewportSettings(stored);
    expect(result.cameraMode).toBe("fly");
    expect(result.controls.reverseVerticalLook).toBe(true);
    expect(result.controls.wheelZoomSensitivity).toBe(150);
    expect(result.layers.city).toBe(false);
  });

  it("clamps a sensitivity to what the renderer actually honours", () => {
    // Above the clamp the slider would move and the camera would not — a control that reads as broken.
    const high = normalizeViewportSettings({ controls: { middlePanSensitivity: 5000 } });
    expect(high.controls.middlePanSensitivity).toBe(SENSITIVITY_RANGE.max);
    const low = normalizeViewportSettings({ controls: { middlePanSensitivity: -20 } });
    expect(low.controls.middlePanSensitivity).toBe(SENSITIVITY_RANGE.min);
  });

  it("clamps look sensitivity on its own wider scale", () => {
    // Look and pan use different clamps in the renderer (750 vs 300); collapsing them would cut the top
    // of the look range for no reason.
    const result = normalizeViewportSettings({ controls: { horizontalLookSensitivity: 9000 } });
    expect(result.controls.horizontalLookSensitivity).toBe(LOOK_SENSITIVITY_RANGE.max);
    expect(LOOK_SENSITIVITY_RANGE.max).toBeGreaterThan(SENSITIVITY_RANGE.max);
  });

  it("replaces NaN and non-numeric sensitivities with the default rather than passing them through", () => {
    // The failure this prevents: `NaN` multiplied into a camera delta makes the position NaN, and the
    // scene goes blank with no error.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, "fast", null, {}]) {
      const result = normalizeViewportSettings({ controls: { verticalLookSensitivity: bad } });
      expect(result.controls.verticalLookSensitivity).toBe(
        DEFAULT_VIEWPORT_SETTINGS.controls.verticalLookSensitivity,
      );
    }
  });

  it("treats a non-boolean invert flag as the default, not as truthy", () => {
    const result = normalizeViewportSettings({ controls: { reverseHorizontalPan: "yes" } });
    expect(result.controls.reverseHorizontalPan).toBe(false);
  });

  it("falls back to orbit for an unknown camera mode", () => {
    expect(normalizeViewportSettings({ cameraMode: "cinematic" }).cameraMode).toBe("orbit");
  });

  it("fills in layers a partial record omits", () => {
    const result = normalizeViewportSettings({ layers: { city: false } });
    expect(result.layers).toEqual({ city: false, vegetation: true, road: true });
  });
});

describe("loadViewportSettings", () => {
  it("returns the defaults when nothing is stored", () => {
    expect(loadViewportSettings()).toEqual(DEFAULT_VIEWPORT_SETTINGS);
  });

  it("round-trips through save", () => {
    const next = {
      ...DEFAULT_VIEWPORT_SETTINGS,
      cameraMode: "fly" as const,
      controls: { ...DEFAULT_VIEWPORT_SETTINGS.controls, rightPanSensitivity: 200 },
    };
    saveViewportSettings(next);
    expect(loadViewportSettings().controls.rightPanSensitivity).toBe(200);
    expect(loadViewportSettings().cameraMode).toBe("fly");
  });


  it("returns the defaults rather than throwing on malformed stored JSON", () => {
    window.localStorage.setItem("uniscenario.viewport-settings.v2", "{not json");
    expect(loadViewportSettings()).toEqual(DEFAULT_VIEWPORT_SETTINGS);
  });

  it("survives storage that throws, as in private mode", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {
          throw new Error("blocked");
        },
      } as unknown as Storage,
    });
    expect(loadViewportSettings()).toEqual(DEFAULT_VIEWPORT_SETTINGS);
    // A failed write must not propagate: losing a preference cannot be allowed to break the editor.
    expect(() => saveViewportSettings(DEFAULT_VIEWPORT_SETTINGS)).not.toThrow();
  });
});

describe("isDefaultViewportSettings", () => {
  it("is true for the defaults and false once anything moves", () => {
    expect(isDefaultViewportSettings({ ...DEFAULT_VIEWPORT_SETTINGS })).toBe(true);
    expect(
      isDefaultViewportSettings({
        ...DEFAULT_VIEWPORT_SETTINGS,
        layers: { ...DEFAULT_VIEWPORT_SETTINGS.layers, vegetation: false },
      }),
    ).toBe(false);
  });
});
