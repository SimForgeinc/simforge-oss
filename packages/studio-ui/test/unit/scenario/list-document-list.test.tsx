// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScenarioDocumentSummaryDto } from "../../../src/lib/scenario/contracts";
import { useScenarioDocumentList } from "../../../src/scenario/list/useScenarioDocumentList";
import { StudioHostTestProvider } from "../../helpers/studio-host";
import {
  resetScenarioListCache,
  scenarioListCache,
} from "../../../src/scenario/list/scenarioListCache";

function summary(id: string, updatedAt = "2026-08-01T00:00:00.000Z"): ScenarioDocumentSummaryDto {
  return {
    id,
    workspaceId: "ws_1",
    title: id,
    description: null,
    datasetId: "usds_1",
    datasetSortOrder: 0,
    mapVersionId: "usmv_1",
    mapLabel: "Richmond",
    latestRevisionId: null,
    revisionCount: 0,
    archetype: null,
    author: null,
    contentTags: [],
    tags: [],
    roleCount: 0,
    hasSensorProfile: false,
    propCount: 0,
    variantCount: 0,
    clipSeconds: null,
    negativeControl: false,
    derivationKind: null,
    derivedFromDocumentId: null,
    hasRender: false,
    createdByUserName: null,
    updatedByUserName: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

describe("useScenarioDocumentList", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    resetScenarioListCache();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("loads the first page and reports whether more remain", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ documents: [summary("a"), summary("b")], nextCursor: "cursor-1" }),
    );
    const { result } = renderHook(() => useScenarioDocumentList("usds_1"), { wrapper: StudioHostTestProvider });
    await act(async () => {
      await result.current.loadFirstPage();
    });
    expect(result.current.documents.map((item) => item.id)).toEqual(["a", "b"]);
    expect(result.current.hasMore).toBe(true);
    expect(result.current.loaded).toBe(true);
  });

  it("appends the next page and forwards the stored cursor", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ documents: [summary("a")], nextCursor: "cursor-1" }))
      .mockResolvedValueOnce(jsonResponse({ documents: [summary("b")], nextCursor: null }));
    const { result } = renderHook(() => useScenarioDocumentList("usds_1"), { wrapper: StudioHostTestProvider });
    await act(async () => {
      await result.current.loadFirstPage();
    });
    await act(async () => {
      await result.current.loadMore();
    });
    expect(result.current.documents.map((item) => item.id)).toEqual(["a", "b"]);
    expect(result.current.hasMore).toBe(false);
    const secondUrl = new URL(String(fetchMock.mock.calls[1]?.[0]), "http://localhost");
    expect(secondUrl.searchParams.get("cursor")).toBe("cursor-1");
  });

  it("does not request another page when there is no cursor", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ documents: [summary("a")], nextCursor: null }));
    const { result } = renderHook(() => useScenarioDocumentList("usds_1"), { wrapper: StudioHostTestProvider });
    await act(async () => {
      await result.current.loadFirstPage();
    });
    await act(async () => {
      await result.current.loadMore();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("re-merges locally created rows the projection has not caught up with", async () => {
    scenarioListCache.pendingDocumentsByDataset = { usds_1: [summary("pending")] };
    fetchMock.mockResolvedValueOnce(jsonResponse({ documents: [summary("a")], nextCursor: null }));
    const { result } = renderHook(() => useScenarioDocumentList("usds_1"), { wrapper: StudioHostTestProvider });
    await act(async () => {
      await result.current.loadFirstPage();
    });
    expect(result.current.documents.map((item) => item.id).sort()).toEqual(["a", "pending"]);
  });

  it("reports a page failure without discarding what is already loaded", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ documents: [summary("a")], nextCursor: "cursor-1" }))
      .mockResolvedValueOnce(jsonResponse({ error: "dataset_not_found" }, 404));
    const { result } = renderHook(() => useScenarioDocumentList("usds_1"), { wrapper: StudioHostTestProvider });
    await act(async () => {
      await result.current.loadFirstPage();
    });
    await act(async () => {
      await result.current.loadMore();
    });
    expect(result.current.documents.map((item) => item.id)).toEqual(["a"]);
    expect(result.current.error).toMatch(/no longer exists/);
  });

  describe("optimistic splicing", () => {
    it("updates a row in place without a refetch", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ documents: [summary("a"), summary("b")], nextCursor: null }),
      );
      const { result } = renderHook(() => useScenarioDocumentList("usds_1"), { wrapper: StudioHostTestProvider });
      await act(async () => {
        await result.current.loadFirstPage();
      });
      act(() => {
        result.current.spliceDocument({ ...summary("b"), title: "Renamed" });
      });
      expect(result.current.documents.map((item) => item.title)).toEqual(["a", "Renamed"]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("removes a row and forgets it as pending", async () => {
      scenarioListCache.pendingDocumentsByDataset = { usds_1: [summary("a")] };
      fetchMock.mockResolvedValueOnce(jsonResponse({ documents: [summary("a")], nextCursor: null }));
      const { result } = renderHook(() => useScenarioDocumentList("usds_1"), { wrapper: StudioHostTestProvider });
      await act(async () => {
        await result.current.loadFirstPage();
      });
      act(() => {
        result.current.removeDocument("a");
      });
      expect(result.current.documents).toEqual([]);
      // A pending row that survived the delete would come back on the next page fetch.
      expect(scenarioListCache.pendingDocumentsByDataset.usds_1).toEqual([]);
    });

    it("writes through to the module cache so a remount does not flash empty", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ documents: [summary("a")], nextCursor: null }));
      const first = renderHook(() => useScenarioDocumentList("usds_1"), { wrapper: StudioHostTestProvider });
      await act(async () => {
        await first.result.current.loadFirstPage();
      });
      cleanup();
      const second = renderHook(() => useScenarioDocumentList("usds_1"), { wrapper: StudioHostTestProvider });
      expect(second.result.current.documents.map((item) => item.id)).toEqual(["a"]);
      expect(second.result.current.loaded).toBe(true);
    });
  });

  describe("readiness", () => {
    it("merges render state into the loaded rows and keeps the summary", async () => {
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse({ documents: [summary("a"), summary("b")], nextCursor: null }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            summary: { total: 2, rendered: 1, cosmosed: 0, vlmed: 0 },
            scenarios: [
              { id: "a", has_render: true },
              { id: "b", has_render: false },
            ],
          }),
        );
      const { result } = renderHook(() => useScenarioDocumentList("usds_1"), { wrapper: StudioHostTestProvider });
      await act(async () => {
        await result.current.loadFirstPage();
      });
      await act(async () => {
        await result.current.loadReadiness();
      });
      expect(result.current.documents.map((item) => item.hasRender)).toEqual([true, false]);
      expect(result.current.readiness).toEqual({ total: 2, rendered: 1, cosmosed: 0, vlmed: 0 });
    });

    it("stays silent when readiness fails — it only decorates badges", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ documents: [summary("a")], nextCursor: null }))
        .mockResolvedValueOnce(jsonResponse({ error: "dataset_not_found" }, 404));
      const { result } = renderHook(() => useScenarioDocumentList("usds_1"), { wrapper: StudioHostTestProvider });
      await act(async () => {
        await result.current.loadFirstPage();
      });
      await act(async () => {
        await result.current.loadReadiness();
      });
      expect(result.current.error).toBeNull();
      expect(result.current.documents).toHaveLength(1);
    });

    it("aborts and suppresses a late readiness response", async () => {
      scenarioListCache.documentsByDataset = { usds_1: [summary("a")] };
      scenarioListCache.loadedDatasetIds.add("usds_1");
      let release: ((value: Response) => void) | undefined;
      fetchMock.mockImplementationOnce(
        (_input, init) =>
          new Promise<Response>((resolve) => {
            release = resolve;
            init?.signal?.addEventListener("abort", () => {
              // Fetch implementations reject here; the controlled promise stays
              // pending to prove the post-await stale guard as well.
            });
          }),
      );
      const { result } = renderHook(() => useScenarioDocumentList("usds_1"), { wrapper: StudioHostTestProvider });
      const controller = new AbortController();
      let loaded: boolean | undefined;
      act(() => {
        void result.current.loadReadiness(controller.signal).then((value) => {
          loaded = value;
        });
      });
      controller.abort();
      await act(async () => {
        release?.(
          jsonResponse({
            summary: { total: 1, rendered: 1, cosmosed: 0, vlmed: 0 },
            scenarios: [{ id: "a", has_render: true }],
          }),
        );
        await Promise.resolve();
      });

      expect(loaded).toBe(false);
      expect(result.current.documents[0]?.hasRender).toBe(false);
      expect(scenarioListCache.readinessByDataset.usds_1).toBeUndefined();
    });
  });

  it("does nothing at all without a dataset", async () => {
    const { result } = renderHook(() => useScenarioDocumentList(null), { wrapper: StudioHostTestProvider });
    await act(async () => {
      await result.current.loadFirstPage();
      await result.current.loadReadiness();
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.documents).toEqual([]);
  });

  it("abandons an in-flight page when the dataset changes", async () => {
    let releaseFirst: ((value: Response) => void) | null = null;
    fetchMock
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            releaseFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(jsonResponse({ documents: [summary("b")], nextCursor: null }));
    const { result, rerender } = renderHook(
      ({ datasetId }: { datasetId: string }) => useScenarioDocumentList(datasetId),
      { initialProps: { datasetId: "usds_1" }, wrapper: StudioHostTestProvider },
    );
    act(() => {
      void result.current.loadFirstPage();
    });
    rerender({ datasetId: "usds_2" });
    await act(async () => {
      await result.current.loadFirstPage();
    });
    // The slow first page resolves last; because its controller was aborted it must not overwrite the
    // second dataset's rows.
    await act(async () => {
      releaseFirst?.(jsonResponse({ documents: [summary("a")], nextCursor: null }));
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.documents.map((item) => item.id)).toEqual(["b"]));
  });
});
