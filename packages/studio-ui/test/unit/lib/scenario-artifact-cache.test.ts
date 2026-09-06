import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearArtifactCache,
  fetchContentAddressedArtifact,
  lastArtifactCacheOutcome,
} from "../../../src/lib/scenario/artifact-cache";

/**
 * A Cache Storage double with the behaviours this module actually depends on:
 * match/put/delete per named cache, and nothing else. Real enough that the
 * test exercises the same code path a browser would.
 */
class FakeCache {
  entries = new Map<string, ArrayBuffer>();
  async match(request: Request): Promise<Response | undefined> {
    const stored = this.entries.get(request.url);
    return stored ? new Response(stored.slice(0)) : undefined;
  }
  async put(request: Request, response: Response): Promise<void> {
    this.entries.set(request.url, await response.arrayBuffer());
  }
  async delete(request: Request): Promise<boolean> {
    return this.entries.delete(request.url);
  }
}

const caches_ = new Map<string, FakeCache>();
const fakeCaches = {
  open: async (name: string) => {
    const existing = caches_.get(name) ?? new FakeCache();
    caches_.set(name, existing);
    return existing as unknown as Cache;
  },
  delete: async (name: string) => caches_.delete(name),
};

async function sha256Of(bytes: Uint8Array): Promise<string> {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const PAYLOAD = new TextEncoder().encode("materialized-traffic-bytes-for-the-scenario");
let SHA = "";
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  caches_.clear();
  SHA = await sha256Of(PAYLOAD);
  vi.stubGlobal("caches", fakeCaches);
  // Plenty of headroom so the budget guard never suppresses a write here.
  vi.stubGlobal("navigator", {
    ...globalThis.navigator,
    storage: { estimate: async () => ({ quota: 8_000_000_000, usage: 1_000 }) },
  });
  fetchSpy = vi.fn(async () => new Response(PAYLOAD.slice(0)));
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const descriptor = () => ({ sha256: SHA, sizeBytes: PAYLOAD.byteLength });

describe("scenario artifact cache", () => {
  it("downloads once, then serves the second open from cache", async () => {
    const first = await fetchContentAddressedArtifact("https://cdn.test/a.bin", descriptor());
    expect(new TextDecoder().decode(first)).toBe(new TextDecoder().decode(PAYLOAD));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(lastArtifactCacheOutcome(SHA)).toBe("miss");

    const second = await fetchContentAddressedArtifact("https://cdn.test/a.bin", descriptor());
    expect(new TextDecoder().decode(second)).toBe(new TextDecoder().decode(PAYLOAD));
    // The whole point: no second network round trip for identical bytes.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(lastArtifactCacheOutcome(SHA)).toBe("hit");
  });

  it("serves a hit even when the URL changes, because the digest is the key", async () => {
    await fetchContentAddressedArtifact("https://cdn.test/signed-url-1", descriptor());
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Download URLs are signed and rotate; the content has not changed.
    await fetchContentAddressedArtifact("https://cdn.test/signed-url-2?sig=xyz", descriptor());
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("re-downloads and repairs when a cached entry no longer matches its digest", async () => {
    await fetchContentAddressedArtifact("https://cdn.test/a.bin", descriptor());
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Simulate browser truncation / corruption of the stored body.
    const cache = caches_.get("simforge-scenario-artifacts-v1")!;
    const key = [...cache.entries.keys()][0]!;
    cache.entries.set(key, new TextEncoder().encode("corrupted").buffer as ArrayBuffer);

    const repaired = await fetchContentAddressedArtifact("https://cdn.test/a.bin", descriptor());
    expect(new TextDecoder().decode(repaired)).toBe(new TextDecoder().decode(PAYLOAD));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("refuses bytes whose digest does not match the descriptor", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new TextEncoder().encode("wrong bytes"))));
    await expect(
      fetchContentAddressedArtifact("https://cdn.test/a.bin", descriptor(), { label: "Saved simulation" }),
    ).rejects.toThrow(/Saved simulation/);
    expect(caches_.get("simforge-scenario-artifacts-v1")?.entries.size ?? 0).toBe(0);
  });

  it("refuses a truncated download before it can be cached", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(PAYLOAD.slice(0, 4))));
    await expect(
      fetchContentAddressedArtifact("https://cdn.test/a.bin", descriptor()),
    ).rejects.toThrow(/incomplete/);
    expect(caches_.get("simforge-scenario-artifacts-v1")?.entries.size ?? 0).toBe(0);
  });

  it("still returns bytes when Cache Storage is unavailable", async () => {
    vi.stubGlobal("caches", undefined);
    const bytes = await fetchContentAddressedArtifact("https://cdn.test/a.bin", descriptor());
    expect(bytes.byteLength).toBe(PAYLOAD.byteLength);
    expect(lastArtifactCacheOutcome(SHA)).toBe("uncacheable");
  });

  it("leaves quota for map assets when storage is nearly full", async () => {
    vi.stubGlobal("navigator", {
      ...globalThis.navigator,
      storage: { estimate: async () => ({ quota: 1_000_000_000, usage: 999_000_000 }) },
    });
    await fetchContentAddressedArtifact("https://cdn.test/a.bin", descriptor());
    expect(caches_.get("simforge-scenario-artifacts-v1")?.entries.size ?? 0).toBe(0);

    // And with no entry written, the next open re-downloads rather than failing.
    await fetchContentAddressedArtifact("https://cdn.test/a.bin", descriptor());
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("clearArtifactCache empties the cache", async () => {
    await fetchContentAddressedArtifact("https://cdn.test/a.bin", descriptor());
    expect(caches_.get("simforge-scenario-artifacts-v1")?.entries.size).toBe(1);
    await clearArtifactCache();
    expect(caches_.has("simforge-scenario-artifacts-v1")).toBe(false);
  });
});
