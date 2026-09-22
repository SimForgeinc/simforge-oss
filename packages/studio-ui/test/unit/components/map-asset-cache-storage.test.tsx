// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MapAssetCacheStatus } from "../../../src/lib/maps/frontend/map-asset-cache";

const status = vi.hoisted(() => ({ current: null as MapAssetCacheStatus | null }));

vi.mock("../../../src/lib/maps/frontend/map-asset-cache", () => ({
  mapAssetCacheStatus: vi.fn(async () => status.current),
  onMapAssetCacheChange: vi.fn(() => () => undefined),
  clearMapAssetCache: vi.fn(async () => undefined),
  chooseMapAssetCacheDirectory: vi.fn(),
}));

const { MapAssetCacheStorage, formatCacheBytes } = await import("../../../src/components/MapAssetCacheStorage");

afterEach(cleanup);

describe("MapAssetCacheStorage", () => {
  it("says why a plain-HTTP page cannot cache instead of printing dashes", async () => {
    status.current = {
      backend: "browser",
      persistent: false,
      usedBytes: null,
      availableBytes: null,
      mapBytes: 0,
      budgetBytes: 4 * 1024 ** 3,
      entryCount: 0,
      unavailable: "this page isn't served over HTTPS, so the browser turns off the storage map caching needs.",
    };
    render(<MapAssetCacheStorage compact />);

    expect((await screen.findByTestId("map-asset-cache-unavailable")).textContent).toMatch(/Browser caching unavailable: this page isn't served over HTTPS/);
    expect(screen.queryByText(/Site usage/)).toBeNull();
    expect(screen.queryByText(/quota available/)).toBeNull();
    expect(screen.queryByText("—")).toBeNull();
    expect(screen.queryByRole("button", { name: /Clear cache/ })).toBeNull();
  });

  it("reports map bytes against the budget and offers Clear where caching works", async () => {
    status.current = {
      backend: "browser",
      persistent: false,
      usedBytes: 110 * 1024 ** 2,
      availableBytes: 3.9 * 1024 ** 3,
      mapBytes: 101 * 1024 ** 2,
      budgetBytes: 4 * 1024 ** 3,
      entryCount: 833,
      unavailable: null,
    };
    render(<MapAssetCacheStorage compact />);

    expect((await screen.findByTestId("map-asset-cache-map-bytes")).textContent).toBe("101 MB of 4.0 GB");
    expect(screen.getByRole("button", { name: /Clear cache/ })).toBeTruthy();
  });

  it("formats an empty cache as zero", () => {
    expect(formatCacheBytes(0)).toBe("0 KB");
    expect(formatCacheBytes(512)).toBe("1 KB");
  });
});
