import { beforeEach, describe, expect, it } from "vitest";
import {
  isMapDownloadsFirstRunPending,
  mapDownloadsFirstRunKey,
  markMapDownloadsFirstRunSeen,
  resetMapDownloadsFirstRunForTests,
} from "../../../src/map-downloads/first-run";

function memoryStorage() {
  const backing = new Map<string, string>();
  return {
    backing,
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => void backing.set(key, value),
  };
}

describe("first sign-in map downloads", () => {
  beforeEach(() => resetMapDownloadsFirstRunForTests());

  it("is pending for a user never shown the panel, and not after it was shown", () => {
    const storage = memoryStorage();
    expect(isMapDownloadsFirstRunPending("user-1", storage)).toBe(true);
    markMapDownloadsFirstRunSeen("user-1", storage);
    expect(isMapDownloadsFirstRunPending("user-1", storage)).toBe(false);
    expect(storage.backing.has(mapDownloadsFirstRunKey("user-1"))).toBe(true);
  });

  it("is tracked per user", () => {
    const storage = memoryStorage();
    markMapDownloadsFirstRunSeen("user-1", storage);
    expect(isMapDownloadsFirstRunPending("user-2", storage)).toBe(true);
  });

  it("survives a reload: a fresh page reading the same storage is not pending", () => {
    const storage = memoryStorage();
    markMapDownloadsFirstRunSeen("user-1", storage);
    resetMapDownloadsFirstRunForTests();
    expect(isMapDownloadsFirstRunPending("user-1", storage)).toBe(false);
  });

  it("never loops when storage refuses the write", () => {
    const readOnly = {
      getItem: () => null,
      setItem: () => { throw new DOMException("denied", "SecurityError"); },
    };
    expect(isMapDownloadsFirstRunPending("user-1", readOnly)).toBe(true);
    markMapDownloadsFirstRunSeen("user-1", readOnly);
    expect(isMapDownloadsFirstRunPending("user-1", readOnly)).toBe(false);
  });

  it("has no first run without a user or storage", () => {
    expect(isMapDownloadsFirstRunPending(null, memoryStorage())).toBe(false);
    expect(isMapDownloadsFirstRunPending("user-1", null)).toBe(false);
    const unreadable = { getItem: () => { throw new Error("blocked"); } };
    expect(isMapDownloadsFirstRunPending("user-1", unreadable)).toBe(false);
  });
});
