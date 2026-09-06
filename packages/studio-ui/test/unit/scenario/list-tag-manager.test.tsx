// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ScenarioDocumentSummaryDto,
  ScenarioTagDto,
} from "../../../src/lib/scenario/contracts";
import { useScenarioTagManager } from "../../../src/scenario/list/useScenarioTagManager";
import { StudioHostTestProvider } from "../../helpers/studio-host";
import { resetScenarioListCache } from "../../../src/scenario/list/scenarioListCache";

function tag(overrides: Partial<ScenarioTagDto> = {}): ScenarioTagDto {
  return {
    id: "ustag_crash",
    workspaceId: "ws_1",
    slug: "crash",
    label: "Crash",
    color: "#ef4444",
    isSystemDefault: true,
    documentCount: 0,
    ...overrides,
  };
}

function summary(
  overrides: Partial<ScenarioDocumentSummaryDto> = {},
): ScenarioDocumentSummaryDto {
  return {
    id: "uscn_1",
    workspaceId: "ws_1",
    title: "Scenario",
    description: null,
    datasetId: "usds_1",
    datasetSortOrder: 0,
    mapVersionId: "usmv_1",
    mapLabel: "Richmond",
    latestRevisionId: "usrv_9",
    revisionCount: 1,
    archetype: null,
    author: null,
    contentTags: [],
    tags: [],
    roleCount: 1,
    hasSensorProfile: true,
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
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

/** Route the mock by URL so a hook that fires several requests on mount is testable. */
function routeFetch(handlers: Array<[RegExp, (init?: RequestInit) => Response]>) {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    for (const [pattern, respond] of handlers) {
      if (pattern.test(url)) return respond(init);
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

describe("useScenarioTagManager", () => {
  let spliced: ScenarioDocumentSummaryDto[];

  function setup(documents: ScenarioDocumentSummaryDto[]) {
    spliced = [];
    return renderHook(() =>
      useScenarioTagManager({
        datasetId: "usds_1",
        documents,
        spliceDocument: (next) => spliced.push(next),
      }),
      { wrapper: StudioHostTestProvider },
    );
  }

  beforeEach(() => {
    resetScenarioListCache();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  describe("catalog", () => {
    it("loads the workspace catalog once and caches it across mounts", async () => {
      const fetchMock = routeFetch([
        [/\/api\/simforge\/tags$/, () => jsonResponse({ tags: [tag()] })],
        [/ratings\/batch/, () => jsonResponse({ aggregates: [] })],
      ]);
      vi.stubGlobal("fetch", fetchMock);
      const first = setup([summary()]);
      await waitFor(() => expect(first.result.current.tags).toHaveLength(1));
      const catalogCalls = fetchMock.mock.calls.filter(([url]) =>
        /\/api\/simforge\/tags$/.test(String(url)),
      );
      expect(catalogCalls).toHaveLength(1);

      cleanup();
      const second = setup([summary()]);
      // Seeded from the module cache, not refetched — the catalog is workspace-scoped and slow-moving.
      expect(second.result.current.tags).toHaveLength(1);
      const catalogCallsAfter = fetchMock.mock.calls.filter(([url]) =>
        /\/api\/simforge\/tags$/.test(String(url)),
      );
      expect(catalogCallsAfter).toHaveLength(1);
    });

    it("rolls a rename back when the write fails", async () => {
      const fetchMock = routeFetch([
        [/\/api\/simforge\/tags$/, () => jsonResponse({ tags: [tag()] })],
        [/\/api\/simforge\/tags\//, () => jsonResponse({ error: "tag_label_taken" }, 409)],
        [/ratings\/batch/, () => jsonResponse({ aggregates: [] })],
      ]);
      vi.stubGlobal("fetch", fetchMock);
      const { result } = setup([summary()]);
      await waitFor(() => expect(result.current.tags).toHaveLength(1));
      await act(async () => {
        await result.current.renameTag("ustag_crash", "Nominal");
      });
      expect(result.current.tags[0]?.label).toBe("Crash");
      expect(result.current.tagError).toMatch(/already exists/);
    });

    it("drops a deleted tag from every loaded row", async () => {
      const assigned = summary({ tags: [{ id: "ustag_crash", label: "Crash", color: "#ef4444" }] });
      const fetchMock = routeFetch([
        [/\/api\/simforge\/tags$/, () => jsonResponse({ tags: [tag()] })],
        [/\/api\/simforge\/tags\//, () => jsonResponse({ ok: true })],
        [/ratings\/batch/, () => jsonResponse({ aggregates: [] })],
      ]);
      vi.stubGlobal("fetch", fetchMock);
      const { result } = setup([assigned]);
      await waitFor(() => expect(result.current.tags).toHaveLength(1));
      await act(async () => {
        await result.current.deleteTag("ustag_crash");
      });
      expect(result.current.tags).toHaveLength(0);
      // The server deletes the assignments with the tag, so the row has to follow or the list keeps
      // rendering a tag that no longer exists.
      expect(spliced.at(-1)?.tags).toEqual([]);
    });
  });

  describe("assignment", () => {
    it("sends the whole resulting set, not a single-tag delta", async () => {
      let putBody: unknown = null;
      const fetchMock = routeFetch([
        [/\/api\/simforge\/tags$/, () => jsonResponse({ tags: [tag(), tag({ id: "ustag_near", slug: "near-miss", label: "Near-miss" })] })],
        [
          /documents\/uscn_1\/tags/,
          (init) => {
            putBody = JSON.parse(String(init?.body));
            return jsonResponse({ tags: [tag(), tag({ id: "ustag_near", label: "Near-miss" })] });
          },
        ],
        [/ratings\/batch/, () => jsonResponse({ aggregates: [] })],
      ]);
      vi.stubGlobal("fetch", fetchMock);
      const existing = summary({ tags: [{ id: "ustag_crash", label: "Crash", color: "#ef4444" }] });
      const { result } = setup([existing]);
      await waitFor(() => expect(result.current.tags).toHaveLength(2));
      await act(async () => {
        await result.current.assignDocumentTag("uscn_1", "ustag_near");
      });
      expect(putBody).toEqual({ tagIds: ["ustag_crash", "ustag_near"] });
    });

    it("toggles a tag off when it is already assigned", async () => {
      let putBody: unknown = null;
      const fetchMock = routeFetch([
        [/\/api\/simforge\/tags$/, () => jsonResponse({ tags: [tag()] })],
        [
          /documents\/uscn_1\/tags/,
          (init) => {
            putBody = JSON.parse(String(init?.body));
            return jsonResponse({ tags: [] });
          },
        ],
        [/ratings\/batch/, () => jsonResponse({ aggregates: [] })],
      ]);
      vi.stubGlobal("fetch", fetchMock);
      const existing = summary({ tags: [{ id: "ustag_crash", label: "Crash", color: "#ef4444" }] });
      const { result } = setup([existing]);
      await waitFor(() => expect(result.current.tags).toHaveLength(1));
      await act(async () => {
        await result.current.toggleDocumentTag("uscn_1", "ustag_crash");
      });
      expect(putBody).toEqual({ tagIds: [] });
    });

    it("is a no-op when a drag re-assigns a tag the row already has", async () => {
      const fetchMock = routeFetch([
        [/\/api\/simforge\/tags$/, () => jsonResponse({ tags: [tag()] })],
        [/ratings\/batch/, () => jsonResponse({ aggregates: [] })],
      ]);
      vi.stubGlobal("fetch", fetchMock);
      const existing = summary({ tags: [{ id: "ustag_crash", label: "Crash", color: "#ef4444" }] });
      const { result } = setup([existing]);
      await waitFor(() => expect(result.current.tags).toHaveLength(1));
      await act(async () => {
        await result.current.assignDocumentTag("uscn_1", "ustag_crash");
      });
      expect(spliced).toEqual([]);
    });

    it("restores the row's previous tags when the write fails", async () => {
      const fetchMock = routeFetch([
        [/\/api\/simforge\/tags$/, () => jsonResponse({ tags: [tag()] })],
        [/documents\/uscn_1\/tags/, () => jsonResponse({ error: "dataset_action_denied" }, 403)],
        [/ratings\/batch/, () => jsonResponse({ aggregates: [] })],
      ]);
      vi.stubGlobal("fetch", fetchMock);
      const { result } = setup([summary()]);
      await waitFor(() => expect(result.current.tags).toHaveLength(1));
      await act(async () => {
        await result.current.assignDocumentTag("uscn_1", "ustag_crash");
      });
      expect(spliced.map((item) => item.tags.length)).toEqual([1, 0]);
      expect(result.current.tagError).toMatch(/permission/);
    });
  });

  describe("ratings", () => {
    it("fetches aggregates in one batch call for the page", async () => {
      let batchBody: unknown = null;
      const fetchMock = routeFetch([
        [/\/api\/simforge\/tags$/, () => jsonResponse({ tags: [] })],
        [
          /ratings\/batch/,
          (init) => {
            batchBody = JSON.parse(String(init?.body));
            return jsonResponse({
              aggregates: [
                {
                  documentId: "uscn_1",
                  ratingCount: 2,
                  averageScore: 4.5,
                  minimumScore: 4,
                  reviewState: "accepted",
                  viewerScore: 5,
                },
              ],
            });
          },
        ],
      ]);
      vi.stubGlobal("fetch", fetchMock);
      const { result } = setup([summary({ id: "uscn_1" }), summary({ id: "uscn_2" })]);
      await waitFor(() =>
        expect(result.current.ratingAggregates["uscn_1"]?.averageScore).toBe(4.5),
      );
      expect(batchBody).toEqual({ documentIds: ["uscn_1", "uscn_2"] });
    });

    it("pins the reviewed revision when the document has one", async () => {
      let putBody: unknown = null;
      const fetchMock = routeFetch([
        [/\/api\/simforge\/tags$/, () => jsonResponse({ tags: [] })],
        [/ratings\/batch/, () => jsonResponse({ aggregates: [] })],
        [
          /documents\/uscn_1\/rating/,
          (init) => {
            putBody = init?.body ? JSON.parse(String(init.body)) : { method: "DELETE" };
            return jsonResponse({
              aggregate: {
                documentId: "uscn_1",
                ratingCount: 1,
                averageScore: 4,
                minimumScore: 4,
                reviewState: "accepted",
                viewerScore: 4,
              },
            });
          },
        ],
      ]);
      vi.stubGlobal("fetch", fetchMock);
      const { result } = setup([summary({ latestRevisionId: "usrv_9" })]);
      await act(async () => {
        await result.current.setDocumentRating("uscn_1", 4);
      });
      // v1 structurally could not record this: `draft_json` was mutable under the rating.
      expect(putBody).toMatchObject({ score: 4, revisionId: "usrv_9", reviewedVia: "browser" });
      expect(result.current.ratingAggregates["uscn_1"]?.viewerScore).toBe(4);
    });

    it("clears the rating when the viewer re-clicks their own score", async () => {
      let method: string | undefined;
      const fetchMock = routeFetch([
        [/\/api\/simforge\/tags$/, () => jsonResponse({ tags: [] })],
        [
          /ratings\/batch/,
          () =>
            jsonResponse({
              aggregates: [
                {
                  documentId: "uscn_1",
                  ratingCount: 1,
                  averageScore: 3,
                  minimumScore: 3,
                  reviewState: "rejected",
                  viewerScore: 3,
                },
              ],
            }),
        ],
        [
          /documents\/uscn_1\/rating/,
          (init) => {
            method = init?.method;
            return jsonResponse({ ok: true, aggregate: null });
          },
        ],
      ]);
      vi.stubGlobal("fetch", fetchMock);
      const { result } = setup([summary()]);
      await waitFor(() => expect(result.current.ratingAggregates["uscn_1"]?.viewerScore).toBe(3));
      await act(async () => {
        await result.current.setDocumentRating("uscn_1", 3);
      });
      expect(method).toBe("DELETE");
      expect(result.current.ratingAggregates["uscn_1"]).toBeUndefined();
    });

    it("rejects an out-of-range score without a request", async () => {
      const fetchMock = routeFetch([
        [/\/api\/simforge\/tags$/, () => jsonResponse({ tags: [] })],
        [/ratings\/batch/, () => jsonResponse({ aggregates: [] })],
      ]);
      vi.stubGlobal("fetch", fetchMock);
      const { result } = setup([summary()]);
      await act(async () => {
        await result.current.setDocumentRating("uscn_1", 0);
        await result.current.setDocumentRating("uscn_1", 6);
      });
      expect(
        fetchMock.mock.calls.filter(([url]) => /rating$/.test(String(url))),
      ).toHaveLength(0);
    });
  });
});
