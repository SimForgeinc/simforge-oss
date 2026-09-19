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

  it.each(["low", "medium"] as const)(
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

  it.each([["roads-only", "low"], ["ultra-low-3d", "low"], ["minimal", "low"], ["high", "medium"]] as const)(
    "rewrites stored %s to %s at the read boundary",
    (removed, current) => {
      window.localStorage.setItem(RENDERING_PREFERENCE_STORAGE_KEY, removed);
      expect(readRenderingPreference()).toBe(current);
      expect(window.localStorage.getItem(RENDERING_PREFERENCE_STORAGE_KEY)).toBe(current);
    },
  );

  it("announces same-tab changes so the persistent world can update live", () => {
    const listener = vi.fn();
    window.addEventListener(RENDERING_PREFERENCE_CHANGE_EVENT, listener);
    saveRenderingPreference("low");
    expect(listener).toHaveBeenCalledOnce();
    expect((listener.mock.calls[0]?.[0] as CustomEvent).detail).toBe("low");
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
    expect(() => saveRenderingPreference("low", unavailable)).not.toThrow();
  });
});
