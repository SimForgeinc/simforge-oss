import { afterEach, describe, expect, it, vi } from "vitest";
import { createDirectMapAssetUrlResolver } from "./direct-map-asset-urls";

const asset = (path: string) => `/api/simforge/maps/map/browser-assets/${path}`;
Object.defineProperty(globalThis, "window", { value: { location: { origin: "https://example.test" } } });
const response = (assets: Array<{ relativePath: string; url: string }>) => ({ ok: true, json: async () => ({ assets }) });

afterEach(() => vi.restoreAllMocks());

describe("direct map asset URL resolver", () => {
  it("coalesces same-tick calls into one POST", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(response([
      { relativePath: "textures/a.bin", url: "https://cdn/a" },
      { relativePath: "textures/b.bin", url: "https://cdn/b" },
    ]) as Response);
    const resolve = createDirectMapAssetUrlResolver("map-version");
    const [a, b] = await Promise.all([
      resolve([asset("textures/a.bin")], new AbortController().signal),
      resolve([asset("textures/b.bin")], new AbortController().signal),
    ]);
    expect(fetch).toHaveBeenCalledOnce();
    expect(a.get(asset("textures/a.bin"))).toBe("https://cdn/a");
    expect(b.get(asset("textures/b.bin"))).toBe("https://cdn/b");
  });

  it("uses its cache and normalizes percent encoding", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(response([{ relativePath: "folder/a b.bin", url: "https://cdn/a" }]) as Response);
    const resolve = createDirectMapAssetUrlResolver("map-version");
    await resolve([asset("folder/a%20b.bin")], new AbortController().signal);
    const second = await resolve([asset("folder/a b.bin")], new AbortController().signal);
    expect(fetch).toHaveBeenCalledOnce();
    expect(second.get(asset("folder/a b.bin"))).toBe("https://cdn/a");
  });

  it("caches omitted keys as their original URLs", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(response([]) as Response);
    const resolve = createDirectMapAssetUrlResolver("map-version");
    const url = asset("missing.bin");
    const first = await resolve([url], new AbortController().signal);
    const second = await resolve([url], new AbortController().signal);
    expect(first.get(url)).toBe(url);
    expect(second.get(url)).toBe(url);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("falls back to originals when the POST fails", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    const resolve = createDirectMapAssetUrlResolver("map-version");
    const url = asset("offline.bin");
    const result = await resolve([url], new AbortController().signal);
    expect(result.get(url)).toBe(url);
  });

  it("aborts only that caller while the shared batch continues", async () => {
    let complete!: (value: Response) => void;
    const fetch = vi.spyOn(globalThis, "fetch").mockReturnValue(new Promise((resolve) => { complete = resolve; }));
    const resolve = createDirectMapAssetUrlResolver("map-version");
    const aborted = new AbortController();
    const first = resolve([asset("a.bin")], aborted.signal);
    const second = resolve([asset("b.bin")], new AbortController().signal);
    aborted.abort("cancelled");
    await expect(first).rejects.toBe("cancelled");
    complete(response([{ relativePath: "b.bin", url: "https://cdn/b" }]) as Response);
    expect((await second).get(asset("b.bin"))).toBe("https://cdn/b");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("passes through non-browser-assets URLs", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const resolve = createDirectMapAssetUrlResolver("map-version");
    const url = "https://example.test/other/file.bin";
    expect(await resolve([url], new AbortController().signal)).toEqual(new Map());
    expect(fetch).not.toHaveBeenCalled();
  });
});
