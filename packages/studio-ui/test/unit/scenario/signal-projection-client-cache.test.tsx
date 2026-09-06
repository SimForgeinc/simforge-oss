// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  resetSignalProjectionCacheForTests,
  useSignalProjection,
} from "../../../src/scenario/editor/signals/use-signal-projection";

describe("signal projection browser cache", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    resetSignalProjectionCacheForTests();
    vi.unstubAllGlobals();
  });

  it("shares immutable map projection reads across consumers", async () => {
    const first = renderHook(() => useSignalProjection("usmap_1"));
    const second = renderHook(() => useSignalProjection("usmap_1"));

    await waitFor(() => expect(first.result.current.unavailable).toBe(true));
    await waitFor(() => expect(second.result.current.unavailable).toBe(true));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
