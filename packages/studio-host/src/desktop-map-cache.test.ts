// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { desktopMapCacheBridge, isDesktopShell, type SimforgeDesktopBridge } from "./desktop-map-cache";

const mapCache = {
  status: async () => ({}) as never,
  has: async () => ({}) as never,
  ensure: async () => ({}) as never,
  cancel: async () => {},
  receipt: async () => null,
  writeReceipt: async () => {},
  clear: async () => {},
  chooseDirectory: async () => ({}) as never,
};

/**
 * These tests install deliberately malformed bridges — a wrong version, a missing map cache — which
 * the declared `Window.simforgeDesktop` type rightly forbids. One named cast at the seam, rather
 * than an inline assertion at each access.
 */
const bridgeSlot = window as unknown as { simforgeDesktop?: unknown };

function install(bridge: unknown) {
  bridgeSlot.simforgeDesktop = bridge;
}

afterEach(() => {
  delete bridgeSlot.simforgeDesktop;
});

describe("desktop shell and map-cache probes", () => {
  it("reports no shell and no cache in an ordinary browser", () => {
    expect(isDesktopShell()).toBe(false);
    expect(desktopMapCacheBridge()).toBeNull();
  });

  it("reports the shell and the cache when the desktop preload has run", () => {
    install({ version: 1, shell: "desktop", mapCache } satisfies SimforgeDesktopBridge);
    expect(isDesktopShell()).toBe(true);
    expect(desktopMapCacheBridge()).toBe(mapCache);
  });

  /**
   * The reason the two probes are separate.
   *
   * A window can be the desktop shell while its map-cache capability is the wrong version or
   * missing entirely — that is what happened for the whole life of the product, when the preload
   * returned early and left every Electron window indistinguishable from a browser tab. Anything
   * that only needs to know which shell is hosting the page (the sign-in pop-up guard in
   * `studio/app/lib/host/cloud.tsx`) must keep getting a true answer here, and must not inherit the
   * capability probe's throw.
   */
  it("answers the shell question even when the map-cache capability is unusable", () => {
    install({ version: 2, shell: "desktop", mapCache });
    expect(isDesktopShell()).toBe(true);
    expect(() => desktopMapCacheBridge()).toThrow(/not supported by this application build/);

    install({ shell: "desktop" });
    expect(isDesktopShell()).toBe(true);
    expect(() => desktopMapCacheBridge()).toThrow();
  });

  it("does not claim the desktop shell for a cache-only bridge", () => {
    install({ version: 1, mapCache });
    expect(isDesktopShell()).toBe(false);
    expect(desktopMapCacheBridge()).toBe(mapCache);
  });
});
