import { describe, expect, it, vi } from "vitest";
import { ScenarioNameConflict, ScenarioVersionConflict, StudioHostRequestError } from "./errors";
import { createHttpStudioHost } from "./http-client";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const document = {
  id: "doc-1",
  title: "Merge",
  draftVersion: 8,
  authoringQualityId: "minimal" as const,
};

const revision = {
  id: "revision-4", workspaceId: "workspace-1", documentId: "doc-1", revisionNumber: 4,
  sourceDraftVersion: 3, schemaVersion: "2", contentSha256: "a".repeat(64), mapVersionId: "map-v1",
  openScenarioProfile: "ASAM OpenSCENARIO XML 1.4" as const,
  export: { id: "export-4", format: "openscenario_xml_1_4" as const, status: "queued" as const, artifactId: null },
  createdAt: "now",
};

const evidence = {
  ambient: {
    mode: "disabled" as const,
    ambientConfig: {},
    configSha256: "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
    resultSha256: "b".repeat(64),
  },
  materializedTraffic: {
    artifactId: "artifact-1", sha256: "b".repeat(64), sizeBytes: 10,
    sourceInputDigest: "c".repeat(64), mapAssetId: "ma_1", mapVersionId: "map-v1",
  },
};

function host(fetchMock: ReturnType<typeof vi.fn>) {
  return createHttpStudioHost({ fetch: fetchMock as unknown as typeof fetch });
}

describe("shared catalog reads", () => {
  it("deduplicates concurrent reads without letting one caller abort the shared fetch", async () => {
    let resolve!: (value: Response) => void;
    const promise = new Promise<Response>((done) => { resolve = done; });
    const fetchMock = vi.fn().mockReturnValue(promise);
    const studio = host(fetchMock);
    const controller = new AbortController();

    const canceled = studio.projects.listDatasets(controller.signal);
    const active = studio.projects.listDatasets();
    controller.abort();
    resolve(jsonResponse({ datasets: [{ id: "usds_1" }] }));

    await expect(canceled).rejects.toMatchObject({ name: "AbortError" });
    await expect(active).resolves.toEqual([{ id: "usds_1" }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty("signal");
  });

  it("shares the map catalog and invalidates dataset reads after a mutation", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ datasets: [] }))
      .mockResolvedValueOnce(jsonResponse({ id: "usds_2", name: "New" }))
      .mockResolvedValueOnce(jsonResponse({ datasets: [{ id: "usds_2" }] }));
    const studio = host(fetchMock);
    await studio.projects.listDatasets();
    await studio.projects.createDataset({ name: "New" });
    await expect(studio.projects.listDatasets()).resolves.toEqual([{ id: "usds_2" }]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("request shape", () => {
  it("sends datasetId, page size and an opaque cursor, and never caches a list read", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ documents: [], nextCursor: null }));
    const studio = host(fetchMock);
    await studio.projects.listDocumentSummaries({ datasetId: "usds_1" });
    let url = new URL(String(fetchMock.mock.calls[0]?.[0]), "http://localhost");
    expect(url.pathname).toBe("/api/simforge/documents/summaries");
    expect(url.searchParams.get("limit")).toBe("50");
    expect(url.searchParams.has("cursor")).toBe(false);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ cache: "no-store" });

    await studio.projects.listDocumentSummaries({ datasetId: "usds_1", limit: 25, cursor: "MjAyNi0wOC0wMnxh" });
    url = new URL(String(fetchMock.mock.calls[1]?.[0]), "http://localhost");
    expect(url.searchParams.get("cursor")).toBe("MjAyNi0wOC0wMnxh");
    expect(url.searchParams.get("limit")).toBe("25");
  });

  it("defaults a rating write to the browser review path", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ aggregate: null }));
    await host(fetchMock).projects.setDocumentRating("uscn_1", { score: 4, revisionId: "usrv_1" });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({ reviewedVia: "browser", score: 4, revisionId: "usrv_1" });
  });

  it("forwards keepalive only when a flush asks for it and sends the optimistic draft version", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse({ ...document, draftVersion: 9 }));
    const studio = host(fetchMock);
    await studio.projects.saveDocument(document, {} as never);
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).keepalive).toBeUndefined();

    await studio.projects.saveDocument(document, {} as never, { keepalive: true });
    const flush = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(flush.keepalive).toBe(true);
    expect(flush.method).toBe("PATCH");
    expect((flush.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(JSON.parse(String(flush.body))).toMatchObject({ expectedVersion: 8, title: "Merge", authoringQualityId: "minimal" });
  });

  it("maps published descriptors onto editor map entries once per catalog read", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      maps: [{
        mapVersionId: "usmv_1", sourceMapId: "ma_richmond_source", label: "Richmond", locality: null,
        browserAssetRootUrl: "/api/simforge/maps/usmv_1/browser-assets",
        browserManifestUrl: "/api/simforge/maps/usmv_1/browser-assets/manifest.json",
        browserClosureSha256: "c".repeat(64),
        artifacts: { xodrSha256: "1".repeat(64), topologySha256: "2".repeat(64), derivedTopologySha256: "3".repeat(64), locationsSha256: "4".repeat(64), signalsSha256: "5".repeat(64), lanePolygonsSha256: "6".repeat(64) },
        sumoNetworkSha256: null, topologyArtifactUrl: "https://s3/topology", derivedTopologyUrl: null,
        locationsUrl: null, sumoNetworkUrl: null, thumbnailUrl: "https://s3/thumb", signalsArtifactUrl: "https://s3/signals",
        xodr: { artifactId: "xodr-1", sha256: "7".repeat(64) }, coordinateSystem: { id: "cs-1", sha256: "8".repeat(64) },
      }],
    }));
    const studio = host(fetchMock);
    const [maps, again] = await Promise.all([studio.artifacts.listMaps(), studio.artifacts.listMaps()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(again).toBe(maps);
    expect(maps[0]).toMatchObject({
      id: "usmv_1", versionId: "usmv_1", locality: "", manifestUrl: "/api/simforge/maps/usmv_1/browser-assets/manifest.json",
      topologyUrl: "https://s3/topology", signalsUrl: "https://s3/signals", thumbnailUrl: "https://s3/thumb",
      xodrArtifactId: "xodr-1", coordinateSystemId: "cs-1",
    });
  });
});

describe("error mapping", () => {
  it("raises a typed version conflict carrying the server's current document when supplied", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      error: "draft_version_conflict", refetch: true, currentDraftVersion: 7,
      current: { id: "uscn_1", title: "Server title", draftVersion: 7 },
    }, 409));
    const failure = await host(fetchMock).projects.updateDocument("uscn_1", { expectedVersion: 3, title: "x" }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ScenarioVersionConflict);
    expect((failure as ScenarioVersionConflict).currentDraftVersion).toBe(7);
    expect((failure as ScenarioVersionConflict).current?.title).toBe("Server title");
  });

  it("still reports a version conflict when the route omits the current document", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: "draft_version_conflict", currentDraftVersion: 9 }, 409));
    const failure = await host(fetchMock).projects.saveDocument(document, {} as never).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ScenarioVersionConflict);
    expect((failure as ScenarioVersionConflict).current).toBeNull();
    expect((failure as ScenarioVersionConflict).currentDraftVersion).toBe(9);
  });

  it("raises typed name conflicts for taken dataset names and tag labels", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: "dataset_name_taken", field: "name" }, 409))
      .mockResolvedValueOnce(jsonResponse({ error: "tag_label_taken", field: "label" }, 409));
    const studio = host(fetchMock);
    const dataset = await studio.projects.createDataset({ name: "Taken" }).catch((error: unknown) => error);
    expect(dataset).toBeInstanceOf(ScenarioNameConflict);
    expect((dataset as ScenarioNameConflict).field).toBe("name");
    expect((dataset as Error).message).toContain("already exists");
    const tag = await studio.projects.createTag({ label: "Crash" }).catch((error: unknown) => error);
    expect((tag as ScenarioNameConflict).field).toBe("label");
  });

  it("keeps the route's code, translates known codes, and falls back to the status", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: "dataset_action_denied" }, 403))
      .mockResolvedValueOnce(jsonResponse({ error: "parent_not_succeeded" }, 409))
      .mockResolvedValueOnce(jsonResponse(null, 500));
    const studio = host(fetchMock);
    await expect(studio.projects.updateDataset("usds_1", { name: "x" })).rejects.toThrow(/do not have permission/);
    const postprocess = await studio.jobs.createPostprocessJob({
      parentRenderJobId: "usrj_1", sourceArtifactId: "a", jobMode: "cosmos_augment", modelFamily: "m", modelConfig: {}, idempotencyKey: "k",
    }).catch((error: unknown) => error);
    expect(postprocess).toBeInstanceOf(StudioHostRequestError);
    expect((postprocess as StudioHostRequestError).code).toBe("parent_not_succeeded");
    expect((postprocess as StudioHostRequestError).status).toBe(409);
    await expect(studio.projects.updateDataset("usds_1", { name: "x" })).rejects.toThrow("Request failed (500)");
  });
});

describe("revisions and exports", () => {
  it("reuses the revision for the exact saved draft before creating", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ revisions: [revision] }));
    await expect(host(fetchMock).projects.ensureRevision({ documentId: "doc-1", expectedDraftVersion: 3 }))
      .resolves.toMatchObject({ revisionId: "revision-4", exportId: "export-4" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/simforge/documents/doc-1/revisions");
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).method).toBeUndefined();
  });

  it("refuses to create a revision without evidence", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ revisions: [] }));
    await expect(host(fetchMock).projects.ensureRevision({ documentId: "doc-1", expectedDraftVersion: 3 }))
      .rejects.toThrow(/explicit traffic evidence/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("resolves the saved draft and creates with a stable key, retrying a failed export under a new key", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ...document, draftVersion: 3 }))
      .mockResolvedValueOnce(jsonResponse({ revisions: [{ ...revision, export: { ...revision.export, status: "failed" } }] }))
      .mockResolvedValueOnce(jsonResponse({ revisionId: "revision-5" }, 201));
    await host(fetchMock).projects.ensureRevision({ documentId: "doc-1", evidence });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String((fetchMock.mock.calls[2]?.[1] as RequestInit).body))).toEqual({
      expectedVersion: 3,
      idempotencyKey: "ensure-revision:doc-1:3:retry:export-4",
      ...evidence,
    });
  });

  it("waits for the exact immutable package and surfaces terminal failures", async () => {
    const record = { id: "export-4", revisionId: "revision-4", format: "openscenario_xml_1_4", compilerVersion: "c", errorCode: null, errorDetail: null, createdAt: "now", startedAt: null, completedAt: null, artifactId: null };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ exports: [{ ...record, status: "running", executionPackageId: null }] }))
      .mockResolvedValueOnce(jsonResponse({ exports: [{ ...record, status: "succeeded", executionPackageId: "package-4" }] }))
      .mockResolvedValueOnce(jsonResponse({ exports: [{ ...record, status: "failed", executionPackageId: null, errorCode: "compile_failed" }] }));
    const studio = host(fetchMock);
    await expect(studio.jobs.waitForExport("revision-4", "export-4", { intervalMs: 0 })).resolves.toMatchObject({ executionPackageId: "package-4" });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/simforge/exports?revisionId=revision-4");
    await expect(studio.jobs.waitForExport("revision-4", "export-4", { intervalMs: 0 })).rejects.toThrow("compile_failed");
  });

  it("downloads artifacts through the authenticated resolver", async () => {
    const click = vi.fn();
    vi.stubGlobal("window", { document: { createElement: () => ({ href: "", download: "", click }) } });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      id: "artifact-4", revisionId: "revision-4", kind: "compiled-xosc", mediaType: "application/xml",
      sha256: "a".repeat(64), sizeBytes: 100, metadata: {}, downloadUrl: "https://signed.example/xosc", downloadExpiresAt: "later", createdAt: "now",
    }));
    await host(fetchMock).artifacts.downloadArtifact("artifact-4");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/simforge/artifacts/artifact-4?download=1");
    expect(click).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });
});
