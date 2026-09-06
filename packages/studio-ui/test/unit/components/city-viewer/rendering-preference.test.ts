// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  readRenderingPreference,
  RENDERING_PREFERENCE_CHANGE_EVENT,
  RENDERING_PREFERENCE_STORAGE_KEY,
  saveRenderingPreference,
} from "../../../../src/components/rendering-preference";

describe("rendering preference storage", () => {
  beforeEach(() => window.localStorage.clear());

  it("returns null until this browser has made a choice", () => {
    expect(readRenderingPreference()).toBeNull();
  });

  it.each(["roads-only", "ultra-low-3d", "minimal", "high"] as const)(
    "persists the %s model-quality preference",
    (preference) => {
      saveRenderingPreference(preference);
      expect(window.localStorage.getItem(RENDERING_PREFERENCE_STORAGE_KEY)).toBe(
        preference,
      );
      expect(readRenderingPreference()).toBe(preference);
    },
  );

  it("ignores malformed or outdated values", () => {
    window.localStorage.setItem(RENDERING_PREFERENCE_STORAGE_KEY, "automatic");
    expect(readRenderingPreference()).toBeNull();
  });

  it("announces same-tab changes so the persistent world can update live", () => {
    const listener = vi.fn();
    window.addEventListener(RENDERING_PREFERENCE_CHANGE_EVENT, listener);
    saveRenderingPreference("minimal");
    expect(listener).toHaveBeenCalledOnce();
    expect((listener.mock.calls[0]?.[0] as CustomEvent).detail).toBe("minimal");
    window.removeEventListener(RENDERING_PREFERENCE_CHANGE_EVENT, listener);
  });

  it("does not fail when browser storage is unavailable", () => {
    const unavailable = {
      getItem() {
        throw new Error("SecurityError");
      },
      setItem() {
        throw new Error("SecurityError");
      },
    };

    expect(readRenderingPreference(unavailable)).toBeNull();
    expect(() => saveRenderingPreference("minimal", unavailable)).not.toThrow();
  });
});
