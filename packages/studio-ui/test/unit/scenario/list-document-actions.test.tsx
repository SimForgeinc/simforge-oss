// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TemplateDocument } from "@simforge-oss/scenario";
import type { ScenarioDocumentSummaryDto } from "../../../src/lib/scenario/contracts";
import { useScenarioDocumentActions } from "../../../src/scenario/list/useScenarioDocumentActions";
import { StudioHostTestProvider } from "../../helpers/studio-host";
import { resetScenarioListCache } from "../../../src/scenario/list/scenarioListCache";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

function summary(
  overrides: Partial<ScenarioDocumentSummaryDto> = {},
): ScenarioDocumentSummaryDto {
  return {
    id: "uscn_1",
    workspaceId: "ws_1",
    title: "Original title",
    description: null,
    datasetId: "usds_1",
    datasetSortOrder: 0,
    mapVersionId: "usmap_1",
    mapLabel: "Richmond",
    latestRevisionId: null,
    revisionCount: 0,
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

const FULL_DOCUMENT = {
  id: "uscn_1",
  workspaceId: "ws_1",
  title: "Original title",
  draftVersion: 4,
  schemaVersion: "2",
  content: { meta: { name: "Original title" }, roles: [], props: [], variants: [] },
  mapVersionId: "usmap_1",
  datasetId: "usds_1",
  authoringQualityId: "minimal",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  latestRevisionId: null,
};

describe("useScenarioDocumentActions", () => {
  const fetchMock = vi.fn<typeof fetch>();
  let spliced: ScenarioDocumentSummaryDto[];
  let removed: string[];
  let errors: string[];
  let opened: Array<{
    datasetId: string;
    documentId: string;
    document?: ScenarioDocumentSummaryDto;
  }>;

  function setup(maps = [{ mapVersionId: "usmap_1", sourceMapId: "ma_richmond_source", label: "Richmond" }]) {
    spliced = [];
    removed = [];
    errors = [];
    opened = [];
    return renderHook(() =>
      useScenarioDocumentActions({
        datasetId: "usds_1",
        maps,
        reportError: (error, fallback) => {
          errors.push(error instanceof Error ? error.message : fallback);
        },
        spliceDocument: (next) => spliced.push(next),
        removeDocument: (id) => removed.push(id),
        onOpenDocument: (nextDatasetId, documentId, document) =>
          opened.push({ datasetId: nextDatasetId, documentId, document }),
      }),
      { wrapper: StudioHostTestProvider },
    );
  }

  beforeEach(() => {
    resetScenarioListCache();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("confirm", vi.fn(() => true));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  describe("commitRename", () => {
    it("splices the new title before the request and sends expectedVersion", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(FULL_DOCUMENT))
        .mockResolvedValueOnce(
          jsonResponse({ ...FULL_DOCUMENT, title: "New title", updatedAt: "2026-08-04T00:00:00.000Z" }),
        );
      const { result } = setup();
      await act(async () => {
        await result.current.commitRename(summary(), "New title");
      });
      // First splice is optimistic, second is the server's answer — no refetch of the page.
      expect(spliced.map((item) => item.title)).toEqual(["New title", "New title"]);
      const patchBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
      expect(patchBody).toMatchObject({ expectedVersion: 4, title: "New title" });
      expect(errors).toEqual([]);
    });

    it("restores the previous title when the write fails", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(FULL_DOCUMENT))
        .mockResolvedValueOnce(jsonResponse({ error: "document_not_found" }, 404));
      const { result } = setup();
      await act(async () => {
        await result.current.commitRename(summary(), "New title");
      });
      expect(spliced.map((item) => item.title)).toEqual(["New title", "Original title"]);
      expect(errors).toHaveLength(1);
    });

    it("rebases onto the server's document on a 409 rather than keeping the rejected title", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(FULL_DOCUMENT)).mockResolvedValueOnce(
        jsonResponse(
          {
            error: "draft_version_conflict",
            refetch: true,
            currentDraftVersion: 9,
            current: {
              ...FULL_DOCUMENT,
              draftVersion: 9,
              title: "Renamed in another tab",
              updatedAt: "2026-08-05T00:00:00.000Z",
            },
          },
          409,
        ),
      );
      const { result } = setup();
      await act(async () => {
        await result.current.commitRename(summary(), "New title");
      });
      expect(spliced.map((item) => item.title)).toEqual(["New title", "Renamed in another tab"]);
      expect(spliced.at(-1)?.updatedAt).toBe("2026-08-05T00:00:00.000Z");
      expect(errors[0]).toMatch(/another tab/);
    });

    it("does nothing for an unchanged or blank title", async () => {
      const { result } = setup();
      await act(async () => {
        await result.current.commitRename(summary(), "  Original title  ");
        await result.current.commitRename(summary(), "   ");
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(spliced).toEqual([]);
    });
  });

  describe("duplicateDocument", () => {
    it("splices the copy with its lineage and does not refetch", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ ...FULL_DOCUMENT, id: "uscn_copy", title: "Original title Copy" }, 201),
      );
      const { result } = setup();
      await act(async () => {
        await result.current.duplicateDocument(summary());
      });
      expect(spliced).toHaveLength(1);
      expect(spliced[0]).toMatchObject({
        id: "uscn_copy",
        derivationKind: "copy",
        derivedFromDocumentId: "uscn_1",
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("leaves the list untouched when the duplicate fails", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ error: "dataset_action_denied" }, 403));
      const { result } = setup();
      await act(async () => {
        await result.current.duplicateDocument(summary());
      });
      expect(spliced).toEqual([]);
      expect(errors).toHaveLength(1);
    });
  });

  describe("deleteDocument", () => {
    it("removes the row after a confirmed delete", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
      const { result } = setup();
      await act(async () => {
        await result.current.deleteDocument(summary());
      });
      expect(removed).toEqual(["uscn_1"]);
    });

    it("does not touch the list when the confirm is declined", async () => {
      vi.stubGlobal("confirm", vi.fn(() => false));
      const { result } = setup();
      await act(async () => {
        await result.current.deleteDocument(summary());
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(removed).toEqual([]);
    });

    it("keeps the row when the delete fails", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ error: "document_not_found" }, 404));
      const { result } = setup();
      await act(async () => {
        await result.current.deleteDocument(summary());
      });
      expect(removed).toEqual([]);
      expect(errors).toHaveLength(1);
    });
  });

  describe("saveDetails", () => {
    it("writes the description through the content update and splices the result", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(FULL_DOCUMENT))
        .mockResolvedValueOnce(jsonResponse({ ...FULL_DOCUMENT, title: "Renamed" }));
      const { result } = setup();
      act(() => {
        result.current.startEditDetails(summary());
      });
      act(() => {
        result.current.setDetailsDraft((current) =>
          current ? { ...current, name: "Renamed", description: "  Why it matters  " } : current,
        );
      });
      await act(async () => {
        await result.current.saveDetails();
      });
      const patchBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
      // `description` is a STORED GENERATED projection of the content, so it has to be written
      // through the document, with `expectedVersion`.
      expect(patchBody).toMatchObject({
        expectedVersion: 4,
        title: "Renamed",
        description: "Why it matters",
      });
      expect(spliced.at(-1)).toMatchObject({ title: "Renamed", description: "Why it matters" });
      await waitFor(() => expect(result.current.detailsDraft).toBeNull());
    });

    it("keeps the dialog open and reports the failure in place", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(FULL_DOCUMENT))
        .mockResolvedValueOnce(jsonResponse({ error: "dataset_action_denied" }, 403));
      const { result } = setup();
      act(() => {
        result.current.startEditDetails(summary());
      });
      await act(async () => {
        await result.current.saveDetails();
      });
      expect(result.current.detailsDraft).not.toBeNull();
      expect(result.current.detailsError).toMatch(/permission/);
    });
  });

  describe("createDocumentOnMap", () => {
    it("opens the new document with the selected map and dataset binding", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ ...FULL_DOCUMENT, id: "uscn_new", title: "Richmond scenario" }, 201),
      );
      const { result } = setup();
      await act(async () => {
        await result.current.createDocumentOnMap({
          mapVersionId: "usmap_1",
          sourceMapId: "ma_richmond_source",
          label: "Richmond",
        });
      });
      const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
      expect(body.mapVersionId).toBe("usmap_1");
      expect(body.datasetId).toBe("usds_1");
      expect(body.authoringQualityId).toBe("minimal");
      expect(body.content.scenarioVersion).toBe(2);
      expect(body.content.sourceMap).toEqual({ mapId: "ma_richmond_source", mapName: "Richmond" });
      expect(body.content.anchor.pin).toEqual({ mapId: "ma_richmond_source" });
      expect(spliced[0]?.id).toBe("uscn_new");
      expect(opened[0]).toMatchObject({
        datasetId: "usds_1",
        documentId: "uscn_new",
        document: { id: "uscn_new" },
      });
    });
  });

  describe("import Scenario JSON", () => {
    it("rebinds a pre-fix version-id document to the selected map's canonical source id", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ ...FULL_DOCUMENT, id: "uscn_imported", title: "Imported" }, 201),
      );
      const stale = TemplateDocument.create({
        name: "Imported",
        sourceMap: { mapId: "usmap_1", mapName: "Richmond" },
        anchor: { features: [], pin: { mapId: "usmap_1" } },
      });
      const file = new File([JSON.stringify({
        simforgeScenarioExport: 1,
        title: "Imported",
        mapVersionId: "usmap_1",
        exportedAt: "2026-08-05T00:00:00.000Z",
        content: stale.data,
      })], "import.json", { type: "application/json" });
      const { result } = setup();

      act(() => result.current.handleImportFile({
        currentTarget: { files: [file], value: "import.json" },
      } as never));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

      const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
      expect(body.mapVersionId).toBe("usmap_1");
      expect(body.content.sourceMap.mapId).toBe("ma_richmond_source");
      expect(body.content.anchor.pin.mapId).toBe("ma_richmond_source");
    });

    it("rejects canonical source identity as ambiguous across derivative versions", async () => {
      const bare = TemplateDocument.create({
        name: "Ambiguous derivative",
        sourceMap: { mapId: "ma_richmond_source", mapName: "Richmond" },
        anchor: { features: [], pin: { mapId: "ma_richmond_source" } },
      });
      const file = new File([JSON.stringify(bare.data)], "ambiguous.json", { type: "application/json" });
      const { result } = setup([
        { mapVersionId: "usmap_derivative_a", sourceMapId: "ma_richmond_source", label: "Richmond A" },
        { mapVersionId: "usmap_derivative_b", sourceMapId: "ma_richmond_source", label: "Richmond B" },
      ]);

      act(() => result.current.handleImportFile({
        currentTarget: { files: [file], value: "ambiguous.json" },
      } as never));
      await waitFor(() => expect(errors).toHaveLength(1));

      expect(fetchMock).not.toHaveBeenCalled();
      expect(errors[0]).toMatch(/exact published map version|ambiguous/);
    });

    it("does not silently retarget a valid different canonical identity", async () => {
      const foreign = TemplateDocument.create({
        name: "Foreign",
        sourceMap: { mapId: "ma_other_source", mapName: "Other" },
        anchor: { features: [], pin: { mapId: "ma_other_source" } },
      });
      const file = new File([JSON.stringify({
        simforgeScenarioExport: 1,
        title: "Foreign",
        mapVersionId: "usmap_1",
        exportedAt: "2026-08-05T00:00:00.000Z",
        content: foreign.data,
      })], "foreign.json", { type: "application/json" });
      const { result } = setup();

      act(() => result.current.handleImportFile({
        currentTarget: { files: [file], value: "foreign.json" },
      } as never));
      await waitFor(() => expect(errors).toHaveLength(1));

      expect(fetchMock).not.toHaveBeenCalled();
      expect(errors[0]).toMatch(/different canonical source map/);
    });
  });
});
